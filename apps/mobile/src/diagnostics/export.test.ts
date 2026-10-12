import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  createFile: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
  permission: vi.fn(),
  platform: { OS: "android" },
  share: vi.fn(),
  write: vi.fn(),
}));
vi.mock("react-native", () => ({ Platform: mocks.platform }));
vi.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///cache/",
  EncodingType: { UTF8: "utf8" },
  writeAsStringAsync: mocks.write,
  StorageAccessFramework: {
    createFileAsync: mocks.createFile,
    getUriForDirectoryInRoot: (name: string) => `content://root/${name}`,
    requestDirectoryPermissionsAsync: mocks.permission,
    writeAsStringAsync: mocks.write,
  },
}));
vi.mock("expo-sharing", () => ({ isAvailableAsync: async () => true, shareAsync: mocks.share }));
vi.mock(".", () => ({
  flushDiagnostics: async () => 0,
  getDiagnosticContext: () => ({}),
  recordDiagnostic: vi.fn(),
  recordDiagnosticError: vi.fn(),
}));
vi.mock("./store", () => ({ pendingDiagnosticCount: () => 4 }));
import { exportDiagnostics } from "./export";
const session = { apiUrl: "https://game.example", roomCode: "ABC234", playerId: "player-1", token: "secret", locationSessionId: "location-session" };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.platform.OS = "android";
  mocks.permission.mockResolvedValue({ granted: true, directoryUri: "content://downloads" });
  mocks.createFile.mockResolvedValue("content://downloads/export.json");
});

describe("diagnostic export", () => {
  it("uses one fixed server cutoff through all pages and reports unsynced local events", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ roomCode: session.roomCode, events: [{ sequence: 1 }], nextAfter: 1, untilSequence: 10 }));
    mocks.fetch.mockResolvedValueOnce(Response.json({ roomCode: session.roomCode, events: [{ sequence: 10 }], untilSequence: 10 }));
    expect(await exportDiagnostics(session)).toMatchObject({ count: 2, disposition: "saved", fileUri: "content://downloads/export.json" });
    expect(String(mocks.fetch.mock.calls[1][0])).toContain("untilSequence=10");
    expect(JSON.parse(mocks.write.mock.calls[0][1])).toMatchObject({ untilSequence: 10, eventCount: 2, localPendingEventCount: 4 });
    expect(mocks.permission).toHaveBeenCalledWith("content://root/Download");
    expect(mocks.createFile).toHaveBeenCalledWith("content://downloads", expect.stringMatching(/^out-of-sight-ABC234-party-/), "application/json");
    expect(mocks.write).toHaveBeenCalledTimes(2);
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it("rejects a looping page cursor instead of hanging and consuming memory", async () => {
    mocks.fetch.mockImplementation(async () => Response.json({ roomCode: session.roomCode, events: [{ sequence: 1 }], nextAfter: 1 }));
    await expect(exportDiagnostics(session)).rejects.toThrow("pagination did not advance");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it("falls back to the share sheet when Android folder selection is cancelled", async () => {
    mocks.permission.mockResolvedValueOnce({ granted: false });
    mocks.fetch.mockResolvedValueOnce(Response.json({ roomCode: session.roomCode, events: [], untilSequence: 0 }));
    expect(await exportDiagnostics(session)).toMatchObject({ count: 0, disposition: "shared", fileUri: expect.stringMatching(/^file:\/\/\/cache\//) });
    expect(mocks.createFile).not.toHaveBeenCalled();
    expect(mocks.share).toHaveBeenCalledOnce();
  });

  it("uses the Save to Files capable share sheet on iOS", async () => {
    mocks.platform.OS = "ios";
    mocks.fetch.mockResolvedValueOnce(Response.json({ roomCode: session.roomCode, events: [], untilSequence: 0 }));
    expect(await exportDiagnostics(session)).toMatchObject({ disposition: "shared" });
    expect(mocks.permission).not.toHaveBeenCalled();
    expect(mocks.share).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ dialogTitle: "Save or share Out of Sight diagnostics" }));
  });
});
