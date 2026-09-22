import { describe, expect, it } from "vitest";
import type { RoomSnapshot } from "@hide-and-seek/protocol";
import { acceptsSnapshot, shouldTrackPlayer } from "./partyState";

const session = { roomCode: "ABC123", playerId: "player-1" };
const snapshot = { roomCode: "ABC123", selfId: "player-1", version: 50, serverNow: 5_000 };

describe("party snapshot ordering", () => {
  it("rejects delayed updates from a previous party or player", () => {
    expect(acceptsSnapshot(null, { ...snapshot, roomCode: "OLD123", version: 1_000 }, session)).toBe(false);
    expect(acceptsSnapshot(null, { ...snapshot, selfId: "old-player", version: 1_000 }, session)).toBe(false);
  });

  it("allows a newly joined party to start at a lower version", () => {
    expect(acceptsSnapshot({ ...snapshot, roomCode: "OLD123", version: 1_000 }, snapshot, session)).toBe(true);
  });

  it("never lets an out-of-order HTTP response undo a newer socket update", () => {
    expect(acceptsSnapshot(snapshot, { ...snapshot, version: 49, serverNow: 6_000 }, session)).toBe(false);
    expect(acceptsSnapshot(snapshot, { ...snapshot, serverNow: 4_999 }, session)).toBe(false);
    expect(acceptsSnapshot(snapshot, { ...snapshot, serverNow: 5_001 }, session)).toBe(true);
    expect(acceptsSnapshot(snapshot, { ...snapshot, version: 51 }, session)).toBe(true);
  });
});

describe("foreground location eligibility", () => {
  const view: Pick<RoomSnapshot, "phase" | "selfId" | "players"> = {
    phase: "active",
    selfId: "player-1",
    players: [{ id: "player-1", name: "Max", role: "hider", status: "active", connected: true,
      isHost: true, gpsReady: false, gpsStatus: "missing" }],
  };

  it("keeps location off when returning to a finished game or eliminated player", () => {
    expect(shouldTrackPlayer({ ...view, phase: "finished" })).toBe(false);
    expect(shouldTrackPlayer({ ...view, players: [{ ...view.players[0], status: "eliminated" }] })).toBe(false);
    expect(shouldTrackPlayer({ ...view, players: [{ ...view.players[0], status: "departed" }] })).toBe(false);
    expect(shouldTrackPlayer({ ...view, players: [] })).toBe(false);
    expect(shouldTrackPlayer(null)).toBe(false);
  });

  it.each(["hiding", "active", "paused"] as const)("tracks active players in %s for locked-phone play", (phase) => {
    expect(shouldTrackPlayer({ ...view, phase })).toBe(true);
  });

  it("uses a one-shot readiness check instead of continuous tracking in the lobby", () => {
    expect(shouldTrackPlayer({ ...view, phase: "lobby" })).toBe(false);
  });
});
