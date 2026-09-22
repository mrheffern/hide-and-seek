import * as Sentry from "@sentry/react-native";
import type { DiagnosticLevel } from "@hide-and-seek/protocol";

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN?.trim();

try { Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  enableNative: true,
  tracesSampleRate: dsn ? 1 : 0,
  maxBreadcrumbs: 100,
  sendDefaultPii: false,
}); } catch {
  // A crash-reporting integration must never prevent the app from starting.
}

export const sentryEnabled = Boolean(dsn);

export function addDiagnosticBreadcrumb(category: string, message: string, level: DiagnosticLevel, data?: Record<string, unknown>): void {
  try { Sentry.addBreadcrumb({ category, message, level: level === "warn" ? "warning" : level, data }); } catch { /* Reporting is best effort. */ }
}

export function captureDiagnosticError(error: unknown, context?: Record<string, unknown>): void {
  try { Sentry.withScope((scope) => {
    if (context) scope.setContext("diagnostic", context);
    Sentry.captureException(error);
  }); } catch { /* Reporting is best effort. */ }
}

export function setSentryIdentity(playerId?: string, playerName?: string, roomCode?: string, matchId?: string): void {
  try {
    Sentry.setUser(playerId ? { id: playerId, username: playerName } : null);
    Sentry.setTag("room_code", roomCode ?? "none");
    Sentry.setTag("match_id", matchId ?? "none");
  } catch { /* Reporting is best effort. */ }
}

export const wrapWithSentry = Sentry.wrap;
