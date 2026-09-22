export type ConnectionState = "disconnected" | "connecting" | "live" | "retrying";

export function reconnectDelayMs(attempt: number): number {
  return Math.min(15_000, 1_000 * 2 ** Math.max(0, Math.min(attempt, 4)));
}
