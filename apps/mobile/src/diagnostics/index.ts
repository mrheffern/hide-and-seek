import * as Application from "expo-application";
import * as Device from "expo-device";
import { PROTOCOL_VERSION, type ClientDiagnosticEvent, type DiagnosticLevel } from "@hide-and-seek/protocol";
import type { StoredSession } from "../session";
import { randomId, readSession } from "../session";
import { fetchWithDeadline } from "../network/request";
import { addDiagnosticBreadcrumb, captureDiagnosticError, sentryEnabled, setSentryIdentity } from "./sentry";
import { bindUnscopedDiagnosticEvents, deleteDiagnosticEvents, pendingDiagnosticCount, pendingDiagnosticEvents, storeDiagnosticEvent, type DiagnosticScope } from "./store";
import { errorPayload, sanitizePayload } from "./sanitize";

export const APP_SESSION_ID = randomId("app-session");

export interface DiagnosticContext {
  apiUrl?: string;
  roomCode?: string;
  playerId?: string;
  playerName?: string;
  matchId?: string;
}

interface RecordOptions {
  context?: DiagnosticContext;
  level?: DiagnosticLevel;
  category: string;
  name: string;
  correlationId?: string;
  payload?: Record<string, unknown>;
}

let context: DiagnosticContext = {};
const flushes = new Map<string, Promise<number>>();
const lastFlushTimes = new Map<string, number>();

function scopeOf(value: DiagnosticContext): DiagnosticScope | undefined {
  return value.apiUrl && value.roomCode && value.playerId
    ? { apiUrl: value.apiUrl, roomCode: value.roomCode, playerId: value.playerId }
    : undefined;
}

export function setDiagnosticContext(next: DiagnosticContext): void {
  const identityChanged = (next.roomCode !== undefined && next.roomCode !== context.roomCode)
    || (next.playerId !== undefined && next.playerId !== context.playerId)
    || (next.apiUrl !== undefined && next.apiUrl !== context.apiUrl);
  if (identityChanged) context = {};
  context = { ...context, ...next };
  const scope = scopeOf(context);
  if (scope) bindUnscopedDiagnosticEvents(scope, APP_SESSION_ID);
  setSentryIdentity(context.playerId, context.playerName, context.roomCode, context.matchId);
}

export function clearDiagnosticContext(): void {
  context = {};
  setSentryIdentity();
}

export function getDiagnosticContext(): DiagnosticContext {
  return { ...context };
}

export function recordDiagnostic(options: RecordOptions): ClientDiagnosticEvent {
  const eventContext = options.context ?? context;
  const payload = sanitizePayload({
    ...options.payload,
    roomCode: eventContext.roomCode,
    playerId: eventContext.playerId,
    playerName: eventContext.playerName,
  });
  const event: ClientDiagnosticEvent = {
    id: randomId("event"),
    appSessionId: APP_SESSION_ID,
    clientAtMs: Date.now(),
    level: options.level ?? "info",
    category: options.category,
    name: options.name,
    matchId: eventContext.matchId,
    correlationId: options.correlationId,
    payload,
  };
  event.correlationId = event.correlationId?.slice(0, 100);
  storeDiagnosticEvent(event, scopeOf(eventContext));
  addDiagnosticBreadcrumb(event.category, event.name, event.level, payload);
  return event;
}

export function recordDiagnosticError(category: string, name: string, error: unknown, payload?: Record<string, unknown>, fatal = false, eventContext?: DiagnosticContext): void {
  const errorDetails = { ...errorPayload(error), ...payload };
  recordDiagnostic({ level: fatal ? "fatal" : "error", category, name, payload: errorDetails, context: eventContext });
  captureDiagnosticError(error, sanitizePayload(errorDetails));
}

export async function initializeDiagnostics(): Promise<void> {
  try {
    const stored = await readSession();
    // Never overwrite a session selected while secure storage was being read.
    if (stored && !context.playerId) setDiagnosticContext(stored);
  } catch {
    // Startup reporting must not prevent the game from starting.
  }
  recordDiagnostic({
    category: "lifecycle",
    name: "app_launched",
    payload: {
      appSessionId: APP_SESSION_ID,
      applicationId: Application.applicationId,
      appVersion: Application.nativeApplicationVersion,
      buildVersion: Application.nativeBuildVersion,
      protocolVersion: PROTOCOL_VERSION,
      brand: Device.brand,
      manufacturer: Device.manufacturer,
      modelName: Device.modelName,
      deviceName: Device.deviceName,
      osName: Device.osName,
      osVersion: Device.osVersion,
      isPhysicalDevice: Device.isDevice,
      sentryEnabled,
      bufferedEventCount: pendingDiagnosticCount(),
    },
  });
}

export function installGlobalErrorHandler(): void {
  type GlobalHandler = (error: Error, isFatal?: boolean) => void;
  type ErrorUtilsApi = { getGlobalHandler?: () => GlobalHandler; setGlobalHandler?: (handler: GlobalHandler) => void };
  const errorUtils = (globalThis as typeof globalThis & { ErrorUtils?: ErrorUtilsApi }).ErrorUtils;
  if (!errorUtils?.setGlobalHandler) return;
  const previous = errorUtils.getGlobalHandler?.();
  errorUtils.setGlobalHandler((error, isFatal) => {
    try {
      recordDiagnosticError("crash", isFatal ? "fatal_javascript_error" : "javascript_error", error, { isFatal }, Boolean(isFatal));
    } finally {
      previous?.(error, isFatal);
    }
  });
}

export async function flushDiagnostics(session: StoredSession, force = false): Promise<number> {
  const key = JSON.stringify([session.apiUrl, session.roomCode, session.playerId]);
  const pending = flushes.get(key);
  if (pending) {
    if (!force) return pending;
    const uploaded = await pending;
    return uploaded + await flushDiagnostics(session, true);
  }
  const now = Date.now();
  if (!force && now - (lastFlushTimes.get(key) ?? 0) < 30_000) return 0;
  lastFlushTimes.set(key, now);
  let uploaded = 0;
  const deadline = now + (force ? 30_000 : 5_000);
  const promise = (async () => {
    const maximumBatches = force ? 200 : 1;
    for (let batch = 0; batch < maximumBatches; batch += 1) {
      if (Date.now() >= deadline) break;
      const candidates = pendingDiagnosticEvents(session, 100);
      const events: ClientDiagnosticEvent[] = [];
      let batchSize = 0;
      for (const candidate of candidates) {
        // Also normalize buffered events written by an older app build.
        const event = {
          ...candidate,
          correlationId: candidate.correlationId?.slice(0, 100),
          payload: sanitizePayload(candidate.payload),
        };
        const eventSize = JSON.stringify(event).length;
        if (batchSize + eventSize > 500_000) break;
        events.push(event);
        batchSize += eventSize;
      }
      if (!events.length) break;
      const { response, text } = await fetchWithDeadline(`${session.apiUrl}/rooms/${session.roomCode}/diagnostics`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, events }),
      }, Math.max(1, Math.min(5_000, deadline - Date.now())));
      if (!response.ok) throw new Error(`Diagnostics upload failed (${response.status}).`);
      const acknowledgement = JSON.parse(text) as { ok?: boolean; accepted?: number };
      if (acknowledgement.ok !== true || acknowledgement.accepted !== events.length) {
        throw new Error("Diagnostics upload was not fully acknowledged.");
      }
      deleteDiagnosticEvents(events.map((event) => event.id));
      uploaded += events.length;
    }
    return uploaded;
  })().catch((error) => {
    console.warn("[diagnostics] Upload deferred", error);
    return uploaded;
  }).finally(() => {
    flushes.delete(key);
  });
  flushes.set(key, promise);
  return promise;
}
