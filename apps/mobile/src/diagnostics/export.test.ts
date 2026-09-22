import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ write: vi.fn(), share: vi.fn(), fetch: vi.fn<typeof fetch>() }));
vi.mock("expo-file-system/legacy", () => ({ cacheDirectory: "file:///cache/", writeAsStringAsync: mocks.write }));
vi.mock("expo-sharing", () => ({ isAvailableAsync: async () => true, shareAsync: mocks.share }));
vi.mock(".", () => ({ flushDiagnostics: async () => 0, recordDiagnostic: vi.fn(), getDiagnosticContext: () => ({}) }));
vi.mock("./store", () => ({ pendingDiagnosticCount: () => 4 }));
import { exportDiagnostics } from "./export";
const session = { apiUrl: "https://game.example", roomCode: "ABC234", playerId: "player-1", token: "secret", locationSessionId: "location-session" };
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", mocks.fetch); });

describe("diagnostic export", () => {
  it("uses one fixed server cutoff through all pages and reports unsynced local events", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ roomCode: session.roomCode, events: [{ sequence: 1 }], nextAfter: 1, untilSequence: 10 }));
    mocks.fetch.mockResolvedValueOnce(Response.json({ roomCode: session.roomCode, events: [{ sequence: 10 }], untilSequence: 10 }));
    expect((await exportDiagnostics(session)).count).toBe(2);
    expect(String(mocks.fetch.mock.calls[1][0])).toContain("untilSequence=10");
    expect(JSON.parse(mocks.write.mock.calls[0][1])).toMatchObject({ untilSequence: 10, eventCount: 2, localPendingEventCount: 4 });
    expect(mocks.share).toHaveBeenCalledOnce();
  });

  it("rejects a looping page cursor instead of hanging and consuming memory", async () => {
    mocks.fetch.mockImplementation(async () => Response.json({ roomCode: session.roomCode, events: [{ sequence: 1 }], nextAfter: 1 }));
    await expect(exportDiagnostics(session)).rejects.toThrow("pagination did not advance");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.share).not.toHaveBeenCalled();
  });
});
