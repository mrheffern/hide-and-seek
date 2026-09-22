import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type PositionFix } from "@hide-and-seek/protocol";
import {
  acceptLocation,
  addPlayer,
  applyCommand,
  createRoomState,
  snapshotForPlayer,
  type RuleContext,
} from "./rules";
import { validateBoundary } from "./geometry";

const base = { latitude: 34, longitude: -118 };
const point = (northMeters: number, eastMeters = 0) => ({
  latitude: base.latitude + northMeters / 111_111,
  longitude: base.longitude + eastMeters / (111_111 * Math.cos((base.latitude * Math.PI) / 180)),
});

function setup() {
  let now = 1_000_000;
  let nextId = 0;
  const context = (): RuleContext => ({ now, id: () => `id-${++nextId}` });
  const state = createRoomState({
    roomCode: "ABC123",
    hostId: "host",
    hostToken: "host-token",
    hostName: "Host",
    now,
    rules: { hidingDurationMs: 1, trapArmMs: 0 },
  });
  addPlayer(state, { playerId: "seeker", token: "seeker-token", name: "Seek" }, context());
  const fix = (where: ReturnType<typeof point>, sequence: number): PositionFix => ({
    ...where,
    accuracyMeters: 2,
    sampledAtMs: now,
    sampleAgeMs: 0,
    sequence,
    sessionId: "test-session",
  });
  const command = (actorId: string, value: Parameters<typeof applyCommand>[2]["command"]) =>
    applyCommand(
      state,
      actorId,
      { protocolVersion: PROTOCOL_VERSION, commandId: `cmd-${++nextId}`, command: value },
      context(),
    );
  const location = (actorId: string, where: ReturnType<typeof point>, sequence: number) =>
    acceptLocation(state, actorId, fix(where, sequence), context());
  return {
    state,
    command,
    location,
    tick(ms: number) {
      now += ms;
    },
    now: () => now,
  };
}

function startGame(game: ReturnType<typeof setup>) {
  game.command("host", {
    type: "set_boundary",
    boundary: [point(-50, -50), point(-50, 50), point(50, 50), point(50, -50)],
  });
  game.command("host", { type: "set_seeker", playerId: "seeker" });
  game.location("host", point(0), 1);
  game.location("seeker", point(20), 1);
  game.state.players.host.lobbyGpsVerifiedAt = game.now();
  game.state.players.seeker.lobbyGpsVerifiedAt = game.now();
  expect(game.command("host", { type: "start_match" }).ok).toBe(true);
  game.tick(2);
  game.location("host", point(0), 2);
}

describe("authoritative visibility", () => {
  it("does not send hider locations to the seeker outside radar", () => {
    const game = setup();
    startGame(game);
    const hidden = snapshotForPlayer(game.state, "seeker", game.now());
    expect(hidden.players.find((player) => player.id === "host")?.location).toBeUndefined();
    const hiderView = snapshotForPlayer(game.state, "host", game.now());
    expect(hiderView.players.find((player) => player.id === "seeker")?.location).toBeUndefined();
    expect(game.command("seeker", { type: "use_radar" }).ok).toBe(true);
    const revealed = snapshotForPlayer(game.state, "seeker", game.now());
    expect(revealed.players.find((player) => player.id === "host")?.location).toBeDefined();
    game.tick(game.state.rules.radarDurationMs + 1);
    expect(snapshotForPlayer(game.state, "seeker", game.now()).players[0].location).toBeUndefined();
  });

  it("does not reveal active hiders to an eliminated hider", () => {
    const game = setup();
    addPlayer(
      game.state,
      { playerId: "other-hider", token: "other-token", name: "Other" },
      { now: game.now(), id: () => "join-other" },
    );
    game.command("host", {
      type: "set_boundary",
      boundary: [point(-50, -50), point(-50, 50), point(50, 50), point(50, -50)],
    });
    game.command("host", { type: "set_seeker", playerId: "seeker" });
    game.location("host", point(0), 1);
    game.location("seeker", point(20), 1);
    game.location("other-hider", point(10), 1);
    for (const player of Object.values(game.state.players)) player.lobbyGpsVerifiedAt = game.now();
    expect(game.command("host", { type: "start_match" }).ok).toBe(true);
    game.tick(2);
    game.location("seeker", point(4), 2);
    expect(game.command("seeker", { type: "tag" }).ok).toBe(true);
    expect(game.state.players.host.latestFix).toBeUndefined();

    const eliminatedView = snapshotForPlayer(game.state, "host", game.now());
    expect(eliminatedView.players.find((player) => player.id === "other-hider")?.location).toBeUndefined();
    expect(game.location("host", point(5), 2).ok).toBe(true);
    expect(game.state.players.host.latestFix).toBeUndefined();
  });

  it("only sends radar timing to the seeker", () => {
    const game = setup();
    startGame(game);
    expect(game.command("seeker", { type: "use_radar" }).ok).toBe(true);
    expect(snapshotForPlayer(game.state, "seeker", game.now()).radarEndsAt).toBeDefined();
    expect(snapshotForPlayer(game.state, "host", game.now()).radarEndsAt).toBeUndefined();
    expect(snapshotForPlayer(game.state, "host", game.now()).nextRadarAt).toBeUndefined();
  });
});

describe("tagging", () => {
  it("tags a nearby hider and ends the game", () => {
    const game = setup();
    startGame(game);
    game.location("seeker", point(4), 2);
    const result = game.command("seeker", { type: "tag" });
    expect(result.ok).toBe(true);
    expect(game.state.players.host.status).toBe("eliminated");
    expect(game.state.winner).toBe("seeker");
  });

  it("does not tag using inaccurate GPS", () => {
    const game = setup();
    startGame(game);
    const badFix: PositionFix = {
      ...point(4),
      accuracyMeters: 40,
      sampledAtMs: game.now(),
      sampleAgeMs: 0,
      sequence: 2,
      sessionId: "test-session",
    };
    acceptLocation(game.state, "seeker", badFix, { now: game.now(), id: () => "bad" });
    expect(game.command("seeker", { type: "tag" }).code).toBe("location_uncertain");
  });
});

describe("traps", () => {
  it("requires continuous observed dwell before release", () => {
    const game = setup();
    startGame(game);
    expect(game.command("host", { type: "place_trap" }).ok).toBe(true);
    game.location("seeker", point(0), 2);
    expect(game.state.immobilized).toBeDefined();
    const triggered = game.state.events.at(-1);
    expect(triggered?.type).toBe("trap_triggered");
    expect(triggered?.actorId).toBe("host");
    expect(triggered?.targetId).toBe("seeker");
    for (let sequence = 3; sequence <= 10; sequence += 1) {
      game.tick(2_000);
      game.location("seeker", point(0), sequence);
      game.location("host", point(0), sequence);
    }
    expect(game.state.immobilized).toBeUndefined();
  });

  it("resets observed dwell when GPS accuracy becomes insufficient", () => {
    const game = setup();
    startGame(game);
    expect(game.command("host", { type: "place_trap" }).ok).toBe(true);
    game.location("seeker", point(0), 2);
    game.tick(2_000);
    game.location("seeker", point(0), 3);
    expect(game.state.immobilized?.dwellMs).toBe(2_000);

    game.tick(2_000);
    acceptLocation(
      game.state,
      "seeker",
      {
        ...point(0),
        accuracyMeters: 25,
        sampledAtMs: game.now(),
        sampleAgeMs: 0,
        sequence: 4,
        sessionId: "test-session",
      },
      { now: game.now(), id: () => "inaccurate-trap-fix" },
    );
    expect(game.state.immobilized?.dwellMs).toBe(0);
  });
});

describe("party lifecycle", () => {
  it("makes the first new player host after an empty lobby is reused", () => {
    const game = setup();
    expect(game.command("seeker", { type: "leave_party" }).ok).toBe(true);
    expect(game.command("host", { type: "leave_party" }).ok).toBe(true);
    expect(Object.keys(game.state.players)).toHaveLength(0);
    expect(game.state.events).toHaveLength(0);
    expect(game.state.boundary).toHaveLength(0);

    const result = addPlayer(
      game.state,
      { playerId: "replacement", token: "replacement-token", name: "Replacement" },
      { now: game.now(), id: () => "replacement-event" },
    );
    expect(result.ok).toBe(true);
    expect(game.state.hostId).toBe("replacement");
    expect(game.state.players.replacement.isHost).toBe(true);
  });

  it("awards the game to hiders when the seeker explicitly leaves", () => {
    const game = setup();
    startGame(game);
    expect(game.command("seeker", { type: "leave_party" }).ok).toBe(true);
    expect(game.state.phase).toBe("finished");
    expect(game.state.winner).toBe("hider");
    expect(Object.values(game.state.players).every((player) => player.latestFix === undefined)).toBe(true);
  });

  it("awards the game to the seeker when the final hider leaves while paused", () => {
    const game = setup();
    startGame(game);
    expect(game.command("host", { type: "pause_match" }).ok).toBe(true);
    expect(game.command("host", { type: "leave_party" }).ok).toBe(true);
    expect(game.state.phase).toBe("finished");
    expect(game.state.winner).toBe("seeker");
  });
});

describe("boundary validation", () => {
  it("rejects duplicate and zero-area points", () => {
    expect(validateBoundary([point(0), point(0), point(10)])).toBe("Boundary points must be unique.");
    expect(validateBoundary([point(0), point(10), point(20)])).toBe("Boundary must enclose an area.");
  });
});

describe("boundary enforcement", () => {
  it("eliminates only after sustained, clearly outside observations", () => {
    const game = setup();
    game.state.rules.boundaryGraceMs = 4_000;
    startGame(game);
    game.location("host", point(70), 3);
    game.tick(2_000);
    game.location("seeker", point(20), 2);
    game.location("host", point(70), 4);
    expect(game.state.players.host.status).toBe("active");
    game.tick(2_000);
    game.location("seeker", point(20), 3);
    game.location("host", point(70), 5);
    expect(game.state.players.host.status).toBe("eliminated");
    expect(game.state.winner).toBe("seeker");
  });
});

describe("connection safety", () => {
  it("pauses when an active player's location stream becomes stale", () => {
    const game = setup();
    startGame(game);
    game.tick(game.state.rules.disconnectPauseMs + 1);
    game.location("seeker", point(20), 2);
    expect(game.state.phase).toBe("paused");
    expect(game.state.events.at(-1)?.type).toBe("match_paused");
  });
});
