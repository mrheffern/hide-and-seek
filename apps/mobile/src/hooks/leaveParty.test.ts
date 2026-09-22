import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stopTracking: vi.fn(),
  clearSession: vi.fn(),
  flushDiagnostics: vi.fn(),
  recordDiagnosticError: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock("../location/tracking", () => ({ stopMatchTracking: mocks.stopTracking }));
vi.mock("../session", () => ({ clearSession: mocks.clearSession }));
vi.mock("../diagnostics", () => ({
  flushDiagnostics: mocks.flushDiagnostics,
  recordDiagnosticError: mocks.recordDiagnosticError,
}));
vi.mock("../api", () => ({ sendCommand: mocks.sendCommand }));

import { leavePartySession } from "./leaveParty";

const session = {
  apiUrl: "https://game.example",
  roomCode: "ABC123",
  playerId: "player-1",
  token: "token",
  locationSessionId: "location-session",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stopTracking.mockResolvedValue(undefined);
  mocks.clearSession.mockResolvedValue(undefined);
  mocks.flushDiagnostics.mockResolvedValue(0);
  mocks.sendCommand.mockResolvedValue({ ok: true });
});

describe("leaving a party", () => {
  it("waits for GPS cleanup before clearing the session or sending leave", async () => {
    let finishStopping!: () => void;
    mocks.stopTracking.mockImplementation(() => new Promise<void>((resolve) => { finishStopping = resolve; }));

    const leaving = leavePartySession(session);
    await vi.waitFor(() => expect(mocks.stopTracking).toHaveBeenCalledOnce());
    expect(mocks.clearSession).not.toHaveBeenCalled();
    expect(mocks.flushDiagnostics).not.toHaveBeenCalled();
    expect(mocks.sendCommand).not.toHaveBeenCalled();

    finishStopping();
    await leaving;

    expect(mocks.clearSession).toHaveBeenCalledOnce();
    expect(mocks.flushDiagnostics).toHaveBeenCalledWith(session, true);
    expect(mocks.sendCommand).toHaveBeenCalledWith(session, { type: "leave_party" });
    expect(mocks.stopTracking.mock.invocationCallOrder[0]).toBeLessThan(mocks.clearSession.mock.invocationCallOrder[0]);
    expect(mocks.clearSession.mock.invocationCallOrder[0]).toBeLessThan(mocks.sendCommand.mock.invocationCallOrder[0]);
  });
});
