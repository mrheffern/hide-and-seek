import { describe, expect, it } from "vitest";
import type { RoomSnapshot } from "@hide-and-seek/protocol";
import { lobbyStartReadiness } from "./lobbyReadiness";

type LobbyInput = Pick<RoomSnapshot, "boundary" | "players">;

const location = {
  latitude: 47,
  longitude: -117,
  accuracyMeters: 3,
  sampledAtMs: 1_000,
  sampleAgeMs: 0,
  sequence: 1,
  sessionId: "test-location-session",
  receivedAtMs: 1_000,
};

const readyLobby: LobbyInput = {
  boundary: [
    { latitude: 47, longitude: -117 },
    { latitude: 47.001, longitude: -117 },
    { latitude: 47, longitude: -117.001 },
  ],
  players: [
    {
      id: "host",
      name: "Max",
      role: "hider",
      status: "active",
      isHost: true,
      connected: true,
      gpsReady: true,
      gpsStatus: "live",
      gpsAgeMs: 0,
      gpsAccuracyMeters: 3,
      location,
    },
    {
      id: "guest",
      name: "Rebecca",
      role: "seeker",
      status: "active",
      isHost: false,
      connected: true,
      gpsReady: true,
      gpsStatus: "live",
      gpsAgeMs: 0,
      gpsAccuracyMeters: 3,
      location,
    },
  ],
};

describe("lobby start readiness", () => {
  it("allows a configured two-player lobby to start", () => {
    expect(lobbyStartReadiness(readyLobby)).toEqual({
      canStart: true,
      message: "Lobby ready. Start the hiding countdown when everyone is inside the boundary.",
    });
  });

  it("explains every fixable blocker before enabling Start", () => {
    const result = lobbyStartReadiness({
      boundary: [],
      players: [{ ...readyLobby.players[0], gpsReady: false, gpsStatus: "missing", location: undefined }],
    });

    expect(result.canStart).toBe(false);
    expect(result.message).toContain("Draw and save a boundary.");
    expect(result.message).toContain("At least two players must join.");
    expect(result.message).toContain("Choose exactly one seeker.");
    expect(result.message).toContain("Waiting for GPS: Max.");
  });

  it("requires exactly one seeker", () => {
    const allHiders = readyLobby.players.map((player) => ({ ...player, role: "hider" as const }));
    expect(lobbyStartReadiness({ ...readyLobby, players: allHiders })).toMatchObject({
      canStart: false,
      message: "Choose exactly one seeker.",
    });
  });

  it("uses privacy-safe readiness when another role's coordinates are hidden", () => {
    const players = readyLobby.players.map(({ location: _location, ...player }) => player);
    expect(lobbyStartReadiness({ ...readyLobby, players })).toMatchObject({ canStart: true });
  });
});
