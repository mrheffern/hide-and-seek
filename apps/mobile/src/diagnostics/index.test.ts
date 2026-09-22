import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientDiagnosticEvent } from "@hide-and-seek/protocol";
const mocks = vi.hoisted(() => ({
  queued: [] as ClientDiagnosticEvent[],
  storeDiagnosticEvent: vi.fn(), bindUnscopedDiagnosticEvents: vi.fn(),
  pendingDiagnosticEvents: vi.fn(), deleteDiagnosticEvents: vi.fn(),
  pendingDiagnosticCount: vi.fn(() => 0),
}));
vi.mock("expo-application", () => ({}));
vi.mock("expo-device", () => ({}));
vi.mock("../session", () => ({ randomId: (prefix: string) => `${prefix}-12345678`, readSession: vi.fn(async () => null) }));
vi.mock("./store", () => mocks);
vi.mock("./sentry", () => ({
  addDiagnosticBreadcrumb: vi.fn(), captureDiagnosticError: vi.fn(), sentryEnabled: false, setSentryIdentity: vi.fn(),
}));
const fetchMock = vi.fn<typeof fetch>();
const session = { apiUrl: "https://game.example", roomCode: "ABC234", playerId: "player-1", token: "secret", locationSessionId: "location-session" };
const event = (): ClientDiagnosticEvent => ({ id: "event-12345678", appSessionId: "runtime-12345678", clientAtMs: 1000, category: "test", name: "sample", level: "debug" });

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  mocks.queued = [event()];
  mocks.pendingDiagnosticEvents.mockImplementation(() => mocks.queued);
  mocks.deleteDiagnosticEvents.mockImplementation(() => { mocks.queued = []; });
  fetchMock.mockResolvedValue(Response.json({ ok: true, accepted: 1 }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("diagnostic upload reliability", () => {
  it("only deletes events after a complete acknowledgement", async () => {
    const diagnostics = await import(".");
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false, accepted: 0 }));
    expect(await diagnostics.flushDiagnostics(session, true)).toBe(0);
    expect(mocks.deleteDiagnosticEvents).not.toHaveBeenCalled();
    expect(await diagnostics.flushDiagnostics(session, true)).toBe(1);
    expect(mocks.pendingDiagnosticEvents).toHaveBeenCalledWith(session, 100);
    expect(mocks.deleteDiagnosticEvents).toHaveBeenCalledWith(["event-12345678"]);
  });

  it("bounds overlong correlation IDs from already-buffered events", async () => {
    mocks.queued = [{ ...event(), correlationId: "x".repeat(110) }];
    const diagnostics = await import(".");
    await diagnostics.flushDiagnostics(session, true);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.events[0].correlationId).toHaveLength(100);
  });

  it("releases stalled uploads and preserves the queue for retry", async () => {
    vi.useFakeTimers();
    const diagnostics = await import(".");
    fetchMock.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = diagnostics.flushDiagnostics(session, true);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await pending).toBe(0);
    expect(mocks.deleteDiagnosticEvents).not.toHaveBeenCalled();
    expect(await diagnostics.flushDiagnostics(session, true)).toBe(1);
  });

  it("does not throttle a different party because the previous one just uploaded", async () => {
    const diagnostics = await import(".");
    await diagnostics.flushDiagnostics(session);
    mocks.queued = [event()];
    await diagnostics.flushDiagnostics({ ...session, roomCode: "OTHER2", playerId: "player-2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clears previous match identity when changing party and preserves captured request context", async () => {
    const diagnostics = await import(".");
    diagnostics.setDiagnosticContext({ ...session, matchId: "old-match", playerName: "Old player" });
    const original = diagnostics.getDiagnosticContext();
    diagnostics.setDiagnosticContext({ apiUrl: session.apiUrl, roomCode: "OTHER2", playerId: "player-2" });
    const next = diagnostics.recordDiagnostic({ category: "test", name: "new_event" });
    expect(next.matchId).toBeUndefined();
    expect(next.payload?.playerName).toBeUndefined();
    const old = diagnostics.recordDiagnostic({ category: "test", name: "late_response", context: original });
    expect(old.matchId).toBe("old-match");
    expect(mocks.storeDiagnosticEvent).toHaveBeenLastCalledWith(old, {
      apiUrl: session.apiUrl, roomCode: session.roomCode, playerId: session.playerId,
    });
  });
});
