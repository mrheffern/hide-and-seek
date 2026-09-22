import {
  PROTOCOL_VERSION,
  type DeviceStatusReport,
  type GameCommand,
  type LocationEnvelope,
  type PositionFix,
  type RoomSnapshot,
  type SessionResponse,
} from "@hide-and-seek/protocol";
import { GAME_API_URL } from "./config";
import { getDiagnosticContext, recordDiagnostic, recordDiagnosticError } from "./diagnostics";
import { randomId, type StoredSession } from "./session";
import { fetchWithDeadline, RequestTimeoutError } from "./network/request";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(
  url: string,
  init: RequestInit,
  operation: string,
  correlationId = randomId("request"),
  payload?: Record<string, unknown>,
  diagnostics: "full" | "errors_only" = "full",
): Promise<T> {
  const startedAt = Date.now();
  const diagnosticContext = getDiagnosticContext();
  if (diagnostics === "full") {
    recordDiagnostic({
      context: diagnosticContext,
      category: "network",
      name: "request_started",
      correlationId,
      payload: { operation, method: init.method, path: new URL(url).pathname, ...payload },
    });
  }
  let response: Response;
  let text: string;
  try {
    ({ response, text } = await fetchWithDeadline(url, init));
  } catch (error) {
    recordDiagnosticError("network", "request_transport_failed", error, {
      operation,
      correlationId,
      durationMs: Date.now() - startedAt,
    }, false, diagnosticContext);
    if (error instanceof RequestTimeoutError) {
      throw new ApiRequestError(error.message, "request_timeout", 0);
    }
    throw error;
  }
  let body: T & { error?: string; message?: string; code?: string };
  try {
    body = JSON.parse(text) as T & { error?: string; message?: string; code?: string };
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid response object");
  } catch {
    recordDiagnostic({
      context: diagnosticContext,
      level: "error",
      category: "network",
      name: "response_unreadable",
      correlationId,
      payload: { operation, status: response.status, durationMs: Date.now() - startedAt, responseBytes: text.length },
    });
    throw new ApiRequestError(
      response.ok ? "The game server returned an unreadable response." : `Game server request failed (${response.status}).`,
      "invalid_response",
      response.status,
    );
  }
  if (!response.ok) {
    recordDiagnostic({
      context: diagnosticContext,
      level: "warn",
      category: "network",
      name: "request_rejected",
      correlationId,
      payload: {
        operation,
        status: response.status,
        code: body.code,
        message: body.error ?? body.message,
        durationMs: Date.now() - startedAt,
      },
    });
    throw new ApiRequestError(
      body.error ?? body.message ?? "Request failed.",
      body.code ?? "request_failed",
      response.status,
    );
  }
  if (diagnostics === "full") {
    recordDiagnostic({
      context: diagnosticContext,
      category: "network",
      name: "request_succeeded",
      correlationId,
      payload: { operation, status: response.status, durationMs: Date.now() - startedAt, responseBytes: text.length },
    });
  }
  return body;
}

export function createParty(name: string): Promise<SessionResponse> {
  return request(`${GAME_API_URL}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }, "create_party", undefined, { playerName: name });
}

export function joinParty(roomCode: string, name: string): Promise<SessionResponse> {
  return request(`${GAME_API_URL}/rooms/${roomCode}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }, "join_party", undefined, { roomCode, playerName: name });
}

export function fetchSnapshot(session: StoredSession): Promise<RoomSnapshot> {
  return request(`${session.apiUrl}/rooms/${session.roomCode}/snapshot`, {
    method: "GET",
    headers: { Authorization: `Bearer ${session.token}` },
  }, "fetch_snapshot");
}

export function sendCommand(session: StoredSession, command: GameCommand) {
  const commandId = randomId("command");
  return request<{ ok: boolean; code: string; message: string }>(
    `${session.apiUrl}/rooms/${session.roomCode}/command`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, commandId, command }),
    },
    "send_command",
    commandId,
    { command },
  );
}

export function uploadLocation(
  session: StoredSession,
  fix: PositionFix,
  deviceStatus?: DeviceStatusReport,
) {
  const body: LocationEnvelope = { protocolVersion: PROTOCOL_VERSION, fix, deviceStatus };
  return request<{ ok: boolean; code: string; message: string; snapshot: RoomSnapshot }>(
    `${session.apiUrl}/rooms/${session.roomCode}/location`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    "upload_location",
    `${fix.sessionId}:${fix.sequence}`,
    { fix, deviceStatus },
    "errors_only",
  );
}

export function socketUrl(session: StoredSession): string {
  return `${session.apiUrl.replace(/^http/, "ws")}/rooms/${session.roomCode}/connect?v=${PROTOCOL_VERSION}`;
}
