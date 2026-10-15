import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  type DeviceStatusReport,
  type GameCommand,
  type GameRules,
  type PositionFix,
} from "@hide-and-seek/protocol";
import {
  acceptLocation,
  addPlayer,
  advanceRoomClock,
  applyCommand,
  createRoomState,
  LOBBY_GPS_VERIFICATION_MS,
  playerIdForToken,
  snapshotForPlayer,
  type RuleContext,
} from "./rules";
import { distanceMeters, pointInPolygon, validateBoundary } from "./geometry";

const base = { latitude: 34, longitude: -118 };
const point = (northMeters: number, eastMeters = 0) => ({
  latitude: base.latitude + northMeters / 111_111,
  longitude: base.longitude + eastMeters / (111_111 * Math.cos((base.latitude * Math.PI) / 180)),
});
const boundary = [point(-50, -50), point(-50, 50), point(50, 50), point(50, -50)];

type FixOverrides = Partial<PositionFix>;

function setup(rules: Partial<GameRules> = {}) {
  let now = 1_000_000;
  let nextId = 0;
  const sequences = new Map<string, number>();
  const positions = new Map<string, ReturnType<typeof point>>([
    ["host", point(0)],
    ["seeker", point(20)],
  ]);
  const context = (): RuleContext => ({ now, id: () => `id-${++nextId}` });
  const state = createRoomState({
    roomCode: "ABC123",
    hostId: "host",
    hostToken: "host-token",
    hostName: "Host",
    now,
    rules: { hidingDurationMs: 1, trapArmMs: 0, ...rules },
  });
  addPlayer(state, { playerId: "seeker", token: "seeker-token", name: "Seek" }, context());

  const command = (actorId: string, value: GameCommand) =>
    applyCommand(
      state,
      actorId,
      { protocolVersion: PROTOCOL_VERSION, commandId: `cmd-${++nextId}`, command: value },
      context(),
    );

  const location = (
    actorId: string,
    where: ReturnType<typeof point>,
    overrides: FixOverrides = {},
    deviceStatus?: DeviceStatusReport,
  ) => {
    const previousSequence = sequences.get(actorId) ?? 0;
    const sequence = overrides.sequence ?? previousSequence + 1;
    sequences.set(actorId, Math.max(previousSequence, sequence));
    positions.set(actorId, where);
    return acceptLocation(
      state,
      actorId,
      {
        ...where,
        accuracyMeters: 2,
        sampledAtMs: now,
        sampleAgeMs: 0,
        sequence,
        sessionId: `${actorId}-session`,
        ...overrides,
      },
      context(),
      deviceStatus,
    );
  };

  const game = {
    state,
    command,
    location,
    add(playerId: string, name = playerId) {
      positions.set(playerId, point(10 + positions.size * 3));
      return addPlayer(
        state,
        { playerId, token: `${playerId}-token`, name },
        context(),
      );
    },
    tick(ms: number) {
      now += ms;
    },
    advance(ms = 0) {
      now += ms;
      advanceRoomClock(state, context());
    },
    now: () => now,
    refresh(playerId: string) {
      return location(playerId, positions.get(playerId) ?? point(0));
    },
    refreshAll() {
      for (const player of Object.values(state.players)) {
        if (player.status === "active") location(player.id, positions.get(player.id) ?? point(0));
      }
    },
    verifyLobbyGps() {
      for (let elapsed = 0; elapsed <= LOBBY_GPS_VERIFICATION_MS; elapsed += 1_000) {
        if (elapsed > 0) now += 1_000;
        for (const player of Object.values(state.players)) {
          if (player.status === "active") location(player.id, positions.get(player.id) ?? point(0));
        }
      }
    },
  };
  return game;
}

function configureAndStart(
  game: ReturnType<typeof setup>,
  options: { additionalHiders?: string[]; advanceToActive?: boolean } = {},
) {
  for (const playerId of options.additionalHiders ?? []) {
    expect(game.add(playerId).ok).toBe(true);
  }
  expect(game.command("host", { type: "set_boundary", boundary }).ok).toBe(true);
  expect(game.command("host", { type: "set_seeker", playerId: "seeker" }).ok).toBe(true);
  game.verifyLobbyGps();
  expect(game.command("host", { type: "start_match" }).ok).toBe(true);
  if (options.advanceToActive !== false) {
    game.tick(game.state.rules.hidingDurationMs + 1);
    game.refreshAll();
    expect(game.state.phase).toBe("active");
  }
}

describe("match setup and authority", () => {
  it("restricts lobby configuration and match controls to the host", () => {
    const game = setup();
    expect(game.command("seeker", { type: "set_boundary", boundary }).code).toBe("host_only");
    expect(game.command("seeker", { type: "set_seeker", playerId: "seeker" }).code).toBe("host_only");
    expect(game.command("seeker", { type: "start_match" }).code).toBe("host_only");
    expect(game.command("seeker", { type: "pause_match" }).code).toBe("host_only");
  });

  it("requires a valid boundary, two players, one seeker, and current locations", () => {
    const game = setup();
    expect(game.command("host", { type: "start_match" }).code).toBe("boundary_required");

    expect(game.command("host", { type: "set_boundary", boundary }).ok).toBe(true);
    expect(game.command("host", { type: "start_match" }).code).toBe("seeker_required");

    expect(game.command("host", { type: "set_seeker", playerId: "seeker" }).ok).toBe(true);
    expect(game.command("host", { type: "start_match" }).code).toBe("players_not_ready");
    expect(game.state.events.at(-1)?.type).toBe("gps_check_requested");

    game.location("host", point(0));
    game.location("seeker", point(20), { accuracyMeters: 30 });
    expect(game.command("host", { type: "start_match" }).code).toBe("players_not_ready");
  });

  it("latches lobby GPS readiness only after a precise signal is sustained", () => {
    const game = setup();
    const status = () => snapshotForPlayer(game.state, "host", game.now()).players.find((player) => player.id === "host")!;

    game.location("host", point(0));
    expect(status()).toMatchObject({ gpsStatus: "live", gpsReady: false });
    game.tick(2_000);
    game.location("host", point(0));
    expect(status().gpsReady).toBe(false);

    game.tick(game.state.rules.maxObservationGapMs + 1);
    game.location("host", point(0));
    for (let elapsed = 1_000; elapsed <= LOBBY_GPS_VERIFICATION_MS; elapsed += 1_000) {
      game.tick(1_000);
      game.location("host", point(0));
    }
    expect(status()).toMatchObject({ gpsStatus: "live", gpsReady: true });

    game.tick(2 * 60_000);
    expect(status()).toMatchObject({ gpsStatus: "stale", gpsReady: true });
  });

  it("requires a current precise fix after lobby GPS readiness was latched", () => {
    const game = setup();
    expect(game.command("host", { type: "set_boundary", boundary }).ok).toBe(true);
    expect(game.command("host", { type: "set_seeker", playerId: "seeker" }).ok).toBe(true);
    game.verifyLobbyGps();

    game.tick(game.state.rules.maxFixAgeMs + 1);
    expect(game.command("host", { type: "start_match" })).toMatchObject({
      ok: false,
      code: "players_not_ready",
    });
    expect(game.state.phase).toBe("lobby");
    expect(game.state.events.at(-1)?.type).toBe("gps_check_requested");
  });

  it("requires at least two players", () => {
    let nextId = 0;
    const context = (): RuleContext => ({ now: 100, id: () => `single-${++nextId}` });
    const state = createRoomState({
      roomCode: "SINGLE",
      hostId: "host",
      hostToken: "host-token",
      hostName: "Host",
      now: 100,
    });
    expect(
      applyCommand(
        state,
        "host",
        {
          protocolVersion: PROTOCOL_VERSION,
          commandId: "boundary-command",
          command: { type: "set_boundary", boundary },
        },
        context(),
      ).ok,
    ).toBe(true);
    expect(
      applyCommand(
        state,
        "host",
        {
          protocolVersion: PROTOCOL_VERSION,
          commandId: "seeker-command",
          command: { type: "set_seeker", playerId: "host" },
        },
        context(),
      ).ok,
    ).toBe(true);
    expect(
      acceptLocation(
        state,
        "host",
        {
          ...point(0),
          accuracyMeters: 2,
          sampledAtMs: 100,
          sampleAgeMs: 0,
          sequence: 1,
          sessionId: "single-session",
        },
        context(),
      ).ok,
    ).toBe(true);
    expect(
      applyCommand(
        state,
        "host",
        {
          protocolVersion: PROTOCOL_VERSION,
          commandId: "start-command",
          command: { type: "start_match" },
        },
        context(),
      ).code,
    ).toBe("players_required");
  });

  it("does not start while any player is outside the boundary", () => {
    const game = setup();
    game.command("host", { type: "set_boundary", boundary });
    game.command("host", { type: "set_seeker", playerId: "seeker" });
    game.location("host", point(0));
    game.location("seeker", point(70));
    game.verifyLobbyGps();
    expect(game.command("host", { type: "start_match" }).code).toBe("players_outside_boundary");
  });

  it("locks joining after start and caps a lobby at seven active players", () => {
    const started = setup();
    configureAndStart(started);
    expect(started.add("late-player").code).toBe("match_started");

    const lobby = setup();
    for (const id of ["p3", "p4", "p5", "p6", "p7"]) expect(lobby.add(id).ok).toBe(true);
    expect(Object.keys(lobby.state.players)).toHaveLength(7);
    expect(lobby.add("p8").code).toBe("room_full");
  });
});

describe("role visibility", () => {
  it("lets active hiders see teammates while keeping the seeker hidden", () => {
    const game = setup();
    configureAndStart(game, { additionalHiders: ["hider-two"] });
    const hiderView = snapshotForPlayer(game.state, "host", game.now());
    expect(hiderView.players.find((player) => player.id === "host")?.location).toBeDefined();
    expect(hiderView.players.find((player) => player.id === "hider-two")?.location).toBeDefined();
    expect(hiderView.players.find((player) => player.id === "seeker")?.location).toBeUndefined();
    expect(hiderView.players.every((player) => player.gpsReady)).toBe(true);

    const seekerView = snapshotForPlayer(game.state, "seeker", game.now());
    expect(seekerView.players.find((player) => player.id === "seeker")?.location).toBeDefined();
    expect(seekerView.players.find((player) => player.id === "hider-two")?.location).toBeUndefined();
    expect(seekerView.players.every((player) => player.gpsReady)).toBe(true);
  });

  it("shares GPS and device health without exposing hidden coordinates", () => {
    const game = setup();
    configureAndStart(game);
    game.location("host", point(0), { accuracyMeters: 25 }, {
      batteryPercent: 18,
      isCharging: false,
      lowPowerMode: true,
      networkType: "cellular",
      isInternetReachable: true,
    });

    const seekerView = snapshotForPlayer(game.state, "seeker", game.now());
    const hiddenHider = seekerView.players.find((player) => player.id === "host");
    expect(hiddenHider).toMatchObject({
      gpsReady: false,
      gpsStatus: "weak",
      gpsAccuracyMeters: 25,
      deviceStatus: {
        batteryPercent: 18,
        lowPowerMode: true,
        networkType: "cellular",
      },
    });
    expect(hiddenHider?.location).toBeUndefined();

    game.tick(game.state.rules.maxFixAgeMs + 1);
    expect(snapshotForPlayer(game.state, "seeker", game.now()).players.find(
      (player) => player.id === "host",
    )?.gpsStatus).toBe("stale");
  });

  it("shows live traps to hiders and only a triggered trap to the trapped seeker", () => {
    const game = setup();
    configureAndStart(game);
    expect(game.command("host", { type: "place_trap" }).ok).toBe(true);
    expect(snapshotForPlayer(game.state, "host", game.now()).traps).toEqual([
      expect.objectContaining({ ownedBySelf: true, radiusMeters: 6.096 }),
    ]);
    expect(snapshotForPlayer(game.state, "seeker", game.now()).traps).toHaveLength(0);

    game.location("seeker", point(0));
    expect(snapshotForPlayer(game.state, "host", game.now()).traps).toHaveLength(0);
    expect(snapshotForPlayer(game.state, "seeker", game.now()).traps[0]).toMatchObject({
      triggered: true,
      ownedBySelf: false,
    });
  });

  it("shows trap placement only to hiders", () => {
    const game = setup();
    configureAndStart(game);
    expect(game.command("host", { type: "place_trap" }).ok).toBe(true);

    expect(snapshotForPlayer(game.state, "host", game.now()).events.some(
      (event) => event.type === "trap_placed",
    )).toBe(true);
    expect(snapshotForPlayer(game.state, "seeker", game.now()).events.some(
      (event) => event.type === "trap_placed",
    )).toBe(false);
    expect(game.state.events.some((event) => event.type === "trap_placed")).toBe(true);
  });

  it("does not reveal remaining hiders' trap locations to an eliminated hider", () => {
    const game = setup();
    configureAndStart(game, { additionalHiders: ["hider-two"] });
    expect(game.command("hider-two", { type: "place_trap" }).ok).toBe(true);
    game.location("seeker", point(4));
    expect(game.command("seeker", { type: "tag" }).ok).toBe(true);
    expect(game.state.players.host.status).toBe("eliminated");
    expect(snapshotForPlayer(game.state, "host", game.now()).traps).toHaveLength(0);
    expect(snapshotForPlayer(game.state, "hider-two", game.now()).traps).toHaveLength(1);
  });
});

describe("tag behavior", () => {
  it("returns no target outside range and enforces the attempt cooldown", () => {
    const game = setup({ autoTagEnabled: false });
    configureAndStart(game);
    expect(game.command("seeker", { type: "tag" }).code).toBe("no_target");

    game.location("seeker", point(4));
    expect(game.command("seeker", { type: "tag" }).code).toBe("cooldown");
    game.tick(game.state.rules.tagAttemptCooldownMs);
    game.refresh("host");
    game.refresh("seeker");
    expect(game.command("seeker", { type: "tag" }).ok).toBe(true);
  });

  it("tags the nearest hider and keeps the round running while another remains", () => {
    const game = setup();
    configureAndStart(game, { additionalHiders: ["hider-two"] });
    game.location("seeker", point(0));
    game.location("host", point(5));
    game.location("hider-two", point(2));
    expect(game.command("seeker", { type: "tag" }).ok).toBe(true);
    expect(game.state.players["hider-two"].status).toBe("eliminated");
    expect(game.state.players.host.status).toBe("active");
    expect(game.state.phase).toBe("active");
  });

  it("refuses a close tag when the target GPS uncertainty overlaps the tag radius", () => {
    const game = setup();
    configureAndStart(game);
    game.location("seeker", point(4));
    game.location("host", point(0), { accuracyMeters: 40 });
    expect(game.command("seeker", { type: "tag" }).code).toBe("location_uncertain");
    expect(game.state.players.host.status).toBe("active");
  });

  it("allows only the seeker to tag", () => {
    const game = setup();
    configureAndStart(game);
    expect(game.command("host", { type: "tag" }).code).toBe("seeker_only");
  });
});

describe("automatic tags and Hidden Mode", () => {
  it("automatically tags a moving hider after continuous precise proximity", () => {
    const game = setup({ autoTagDwellMs: 1_000 });
    configureAndStart(game);

    game.location("seeker", point(4));
    expect(game.state.players.host.status).toBe("active");
    game.tick(1_000);
    game.location("seeker", point(4));

    expect(game.state.players.host.status).toBe("eliminated");
    expect(game.state.events.some(
      (event) => event.type === "player_tagged" && event.message.includes("automatically"),
    )).toBe(true);
  });

  it("enters Hidden Mode after four observed stationary seconds during the hiding countdown", () => {
    const game = setup({ hidingDurationMs: 10_000, hiddenModeActivationMs: 4_000 });
    configureAndStart(game, { advanceToActive: false });

    game.location("host", point(0), { speedMetersPerSecond: 0 });
    for (let second = 1; second <= 4; second += 1) {
      game.tick(1_000);
      game.location("host", point(0), { speedMetersPerSecond: 0 });
      game.location("seeker", point(20), { speedMetersPerSecond: 0 });
    }

    const hiderView = snapshotForPlayer(game.state, "host", game.now());
    expect(hiderView.players.find((player) => player.id === "host")?.hiddenMode).toMatchObject({
      hidden: true,
      hiddenAt: game.now(),
    });
    const seekerView = snapshotForPlayer(game.state, "seeker", game.now());
    expect(seekerView.players.find((player) => player.id === "host")?.hiddenMode).toBeUndefined();
  });

  it("blocks auto-tag while hidden but still permits a manual tag", () => {
    const game = setup({ hiddenModeActivationMs: 4_000, autoTagDwellMs: 1_000 });
    configureAndStart(game);
    for (let second = 1; second <= 4; second += 1) {
      game.tick(1_000);
      game.location("host", point(0), { speedMetersPerSecond: 0 });
      game.location("seeker", point(20), { speedMetersPerSecond: 0 });
    }
    expect(game.state.players.host.hiddenMode?.hiddenAt).toBeDefined();

    game.location("seeker", point(4));
    game.tick(1_000);
    game.location("seeker", point(4));
    expect(game.state.players.host.status).toBe("active");

    expect(game.command("seeker", { type: "tag" }).ok).toBe(true);
    expect(game.state.players.host.status).toBe("eliminated");
  });

  it("ignores accuracy-sized GPS jitter and exits Hidden Mode after reliable sustained movement", () => {
    const game = setup({ hiddenModeActivationMs: 4_000, hiddenModeExitDistanceMeters: 3 });
    configureAndStart(game);
    for (let second = 1; second <= 4; second += 1) {
      game.tick(1_000);
      game.location("host", point(0), { speedMetersPerSecond: 0 });
      game.location("seeker", point(20));
    }
    expect(game.state.players.host.hiddenMode?.hiddenAt).toBeDefined();

    game.tick(500);
    game.location("host", point(4), { accuracyMeters: 6, speedMetersPerSecond: 0 });
    expect(game.state.players.host.hiddenMode?.hiddenAt).toBeDefined();

    game.tick(500);
    game.location("host", point(12), { accuracyMeters: 2, speedMetersPerSecond: 0 });
    expect(game.state.players.host.hiddenMode?.hiddenAt).toBeDefined();
    game.tick(1_000);
    game.location("host", point(13), { accuracyMeters: 2, speedMetersPerSecond: 0 });
    expect(game.state.players.host.hiddenMode?.hiddenAt).toBeUndefined();
  });

  it("requires sustained reported movement before clearing Hidden Mode", () => {
    const game = setup({ hiddenModeActivationMs: 4_000, hiddenModeMovementSustainMs: 1_000 });
    configureAndStart(game);
    for (let second = 1; second <= 4; second += 1) {
      game.tick(1_000);
      game.location("host", point(0), { speedMetersPerSecond: 0 });
      game.location("seeker", point(20));
    }

    game.location("host", point(0), { speedMetersPerSecond: 1.2 });
    expect(game.state.players.host.hiddenMode?.hiddenAt).toBeDefined();
    game.tick(1_000);
    game.location("host", point(0), { speedMetersPerSecond: 1.2 });
    expect(game.state.players.host.hiddenMode?.hiddenAt).toBeUndefined();
  });

  it("clears Hidden Mode after an observation gap or match pause", () => {
    const enterHidden = (game: ReturnType<typeof setup>) => {
      for (let second = 1; second <= 4; second += 1) {
        game.tick(1_000);
        game.location("host", point(0), { speedMetersPerSecond: 0 });
        game.location("seeker", point(20));
      }
      expect(game.state.players.host.hiddenMode?.hiddenAt).toBeDefined();
    };

    const interrupted = setup({ hiddenModeActivationMs: 4_000 });
    configureAndStart(interrupted);
    enterHidden(interrupted);
    interrupted.tick(interrupted.state.rules.maxObservationGapMs + 1);
    interrupted.location("host", point(0), { speedMetersPerSecond: 0 });
    expect(interrupted.state.players.host.hiddenMode?.hiddenAt).toBeUndefined();

    const paused = setup({ hiddenModeActivationMs: 4_000 });
    configureAndStart(paused);
    enterHidden(paused);
    expect(paused.command("host", { type: "pause_match" }).ok).toBe(true);
    expect(paused.state.players.host.hiddenMode).toBeUndefined();
  });
});

describe("radar behavior", () => {
  it("allows only the active seeker and applies exact visibility and cooldown windows", () => {
    const game = setup({ radarDurationMs: 3_000, radarCooldownMs: 5_000 });
    configureAndStart(game);
    expect(game.command("host", { type: "use_radar" }).code).toBe("seeker_only");
    expect(game.command("seeker", { type: "use_radar" }).ok).toBe(true);
    expect(snapshotForPlayer(game.state, "seeker", game.now()).players[0].location).toBeDefined();
    expect(game.command("seeker", { type: "use_radar" }).code).toBe("cooldown");

    game.tick(3_000);
    expect(snapshotForPlayer(game.state, "seeker", game.now()).players[0].location).toBeUndefined();
    game.tick(2_000);
    game.refreshAll();
    expect(game.command("seeker", { type: "use_radar" }).ok).toBe(true);
  });
});

describe("trap behavior", () => {
  it("uses a twenty-foot trigger radius", () => {
    const inside = setup();
    configureAndStart(inside);
    inside.command("host", { type: "place_trap" });
    inside.location("seeker", point(6));
    expect(inside.state.immobilized).toBeDefined();

    const outside = setup();
    configureAndStart(outside);
    outside.command("host", { type: "place_trap" });
    outside.location("seeker", point(6.3));
    expect(outside.state.immobilized).toBeUndefined();
  });

  it("does not trigger a trap from a delayed GPS sample", () => {
    const game = setup();
    configureAndStart(game);
    expect(game.command("host", { type: "place_trap" }).ok).toBe(true);
    expect(game.location("seeker", point(0), { sampleAgeMs: 5_000 }).ok).toBe(true);
    expect(game.state.immobilized).toBeUndefined();
    game.location("seeker", point(0));
    expect(game.state.immobilized).toBeDefined();
  });

  it("resets trap dwell when delayed observations arrive", () => {
    const game = setup();
    configureAndStart(game);
    game.command("host", { type: "place_trap" });
    game.location("seeker", point(0));
    game.tick(2_000);
    game.location("seeker", point(0));
    expect(game.state.immobilized?.dwellMs).toBe(2_000);
    game.tick(2_000);
    game.location("seeker", point(0), { sampleAgeMs: 5_000 });
    expect(game.state.immobilized?.dwellMs).toBe(0);
  });

  it("allows one trap per hider and rejects seeker placement", () => {
    const game = setup();
    configureAndStart(game);
    expect(game.command("seeker", { type: "place_trap" }).code).toBe("hider_only");
    expect(game.command("host", { type: "place_trap" }).ok).toBe(true);
    expect(game.command("host", { type: "place_trap" }).code).toBe("no_charges");
  });

  it("does not trigger before arming and removes expired traps", () => {
    const arming = setup({ trapArmMs: 5_000 });
    configureAndStart(arming);
    expect(arming.command("host", { type: "place_trap" }).ok).toBe(true);
    arming.location("seeker", point(0));
    expect(arming.state.immobilized).toBeUndefined();
    arming.tick(5_000);
    arming.location("seeker", point(0));
    expect(arming.state.immobilized).toBeDefined();

    const expiring = setup({ trapLifetimeMs: 3_000 });
    configureAndStart(expiring);
    expect(expiring.command("host", { type: "place_trap" }).ok).toBe(true);
    expiring.advance(3_001);
    expect(expiring.state.traps).toHaveLength(0);
    expiring.location("seeker", point(0));
    expect(expiring.state.immobilized).toBeUndefined();
  });

  it("resets dwell after leaving the circle or a location observation gap", () => {
    const game = setup();
    configureAndStart(game);
    game.command("host", { type: "place_trap" });
    game.location("seeker", point(0));
    game.tick(2_000);
    game.location("seeker", point(0));
    expect(game.state.immobilized?.dwellMs).toBe(2_000);

    game.tick(1_000);
    game.location("seeker", point(10));
    expect(game.state.immobilized?.dwellMs).toBe(0);
    game.tick(game.state.rules.maxObservationGapMs + 1);
    game.location("seeker", point(0));
    expect(game.state.immobilized?.dwellMs).toBe(0);
  });

  it("does not let a consumed trap trigger twice after release", () => {
    const game = setup({ trapDwellMs: 2_000 });
    configureAndStart(game);
    game.command("host", { type: "place_trap" });
    game.location("seeker", point(0));
    game.tick(1_000);
    game.location("seeker", point(0));
    game.tick(1_000);
    game.location("seeker", point(0));
    expect(game.state.immobilized).toBeUndefined();
    game.location("seeker", point(0));
    expect(game.state.immobilized).toBeUndefined();
    expect(game.state.events.filter((event) => event.type === "trap_triggered")).toHaveLength(1);
  });

  it("requires a precise in-boundary hider location for placement", () => {
    const inaccurate = setup();
    configureAndStart(inaccurate);
    inaccurate.location("host", point(0), { accuracyMeters: 30 });
    expect(inaccurate.command("host", { type: "place_trap" }).code).toBe("location_uncertain");

    const outside = setup();
    configureAndStart(outside);
    outside.location("host", point(70));
    expect(outside.command("host", { type: "place_trap" }).code).toBe("outside_boundary");
  });

  it("disables seeker powers while immobilized", () => {
    const game = setup();
    configureAndStart(game);
    game.command("host", { type: "place_trap" });
    game.location("seeker", point(0));
    expect(game.command("seeker", { type: "tag" }).code).toBe("immobilized");
    expect(game.command("seeker", { type: "use_radar" }).code).toBe("immobilized");
  });
});

describe("boundary enforcement", () => {
  it("does not eliminate a hider from delayed outside GPS samples", () => {
    const game = setup({ boundaryGraceMs: 2_000 });
    configureAndStart(game);
    for (let observation = 0; observation < 3; observation += 1) {
      game.tick(1_000);
      game.location("host", point(70), { sampleAgeMs: 5_000 });
      game.refresh("seeker");
    }
    expect(game.state.players.host.status).toBe("active");
    expect(game.state.players.host.outsideBoundary).toBe(false);
    expect(game.state.players.host.boundaryOutsideMs).toBe(0);
  });

  it("does not count time spent paused toward boundary elimination", () => {
    const game = setup({ boundaryGraceMs: 2_000 });
    configureAndStart(game);
    game.location("host", point(70));
    game.tick(1_000);
    expect(game.command("host", { type: "pause_match" }).ok).toBe(true);
    game.tick(2_000);
    game.refreshAll();
    expect(game.command("host", { type: "resume_match" }).ok).toBe(true);
    game.location("host", point(70));
    expect(game.state.players.host.status).toBe("active");
    expect(game.state.players.host.boundaryOutsideMs).toBe(0);
  });

  it("warns the player when approaching the boundary", () => {
    const game = setup();
    configureAndStart(game);
    game.location("host", point(45));
    const nearEdge = snapshotForPlayer(game.state, "host", game.now());
    expect(nearEdge.nearBoundary).toBe(true);
    expect(nearEdge.outsideBoundary).toBe(false);
    expect(nearEdge.boundaryDistanceMeters).toBeCloseTo(5, 0);

    game.location("host", point(0));
    expect(snapshotForPlayer(game.state, "host", game.now()).nearBoundary).toBe(false);
  });

  it("does not accrue outside time when GPS uncertainty overlaps the boundary", () => {
    const game = setup({ boundaryGraceMs: 4_000 });
    configureAndStart(game);
    for (let observation = 0; observation < 3; observation += 1) {
      game.tick(2_000);
      game.location("host", point(55), { accuracyMeters: 10 });
      game.refresh("seeker");
    }
    expect(game.state.players.host.outsideBoundary).toBe(false);
    expect(game.state.players.host.boundaryOutsideMs).toBe(0);
    expect(game.state.players.host.status).toBe("active");
  });

  it("resets the grace period after a hider returns inside", () => {
    const game = setup({ boundaryGraceMs: 4_000 });
    configureAndStart(game);
    game.location("host", point(70));
    game.tick(2_000);
    game.refresh("seeker");
    game.location("host", point(70));
    expect(game.state.players.host.boundaryOutsideMs).toBe(2_000);

    game.location("host", point(0));
    expect(game.state.players.host.boundaryOutsideMs).toBe(0);
    expect(game.state.players.host.outsideBoundary).toBe(false);

    game.location("host", point(70));
    game.tick(2_000);
    game.refresh("seeker");
    game.location("host", point(70));
    expect(game.state.players.host.status).toBe("active");
  });

  it("keeps an outside seeker in the game but disables seeker powers", () => {
    const game = setup({ boundaryGraceMs: 2_000 });
    configureAndStart(game);
    game.location("seeker", point(70));
    expect(game.command("seeker", { type: "tag" }).code).toBe("outside_boundary");
    expect(game.command("seeker", { type: "use_radar" }).code).toBe("outside_boundary");
    game.tick(2_001);
    game.refresh("host");
    game.location("seeker", point(70));
    expect(game.state.players.seeker.status).toBe("active");
    expect(game.state.phase).toBe("active");
  });
});

describe("timers and pause behavior", () => {
  it("starts the active round at the hiding deadline when clock processing is late", () => {
    const game = setup({ hidingDurationMs: 1_000, roundDurationMs: 5_000 });
    configureAndStart(game, { advanceToActive: false });
    const hidingEndsAt = game.state.hidingEndsAt!;
    game.advance(2_000);
    expect(game.state.phase).toBe("active");
    expect(game.state.phaseStartedAt).toBe(hidingEndsAt);
    expect(game.state.activeEndsAt).toBe(hidingEndsAt + 5_000);
  });

  it("pauses at the disconnect deadline before a later round timeout", () => {
    const game = setup({ hidingDurationMs: 1_000, roundDurationMs: 30_000 });
    configureAndStart(game, { advanceToActive: false });
    const startedAt = game.now();
    game.advance(60_000);
    expect(game.state.phase).toBe("paused");
    expect(game.state.pausedFromPhase).toBe("active");
    expect(game.state.pausedAt).toBe(startedAt + game.state.rules.disconnectPauseMs);
    expect(game.state.winner).toBeNull();
    game.refreshAll();
    expect(game.command("host", { type: "resume_match" }).ok).toBe(true);
    expect(game.state.activeEndsAt! - game.now()).toBe(21_000);
  });

  it("preserves an unexpired trap through a pause longer than its lifetime", () => {
    const game = setup({ trapArmMs: 1_000, trapLifetimeMs: 3_000 });
    configureAndStart(game);
    game.command("host", { type: "place_trap" });
    game.tick(500);
    expect(game.command("host", { type: "pause_match" }).ok).toBe(true);
    const trap = { ...game.state.traps[0] };
    game.advance(10_000);
    expect(game.state.traps).toHaveLength(1);
    game.refreshAll();
    expect(game.command("host", { type: "resume_match" }).ok).toBe(true);
    expect(game.state.traps[0].armedAt).toBe(trap.armedAt + 10_000);
    expect(game.state.traps[0].expiresAt).toBe(trap.expiresAt + 10_000);
  });

  it("moves from hiding to active and awards hiders the round on timeout", () => {
    const game = setup({ hidingDurationMs: 1_000, roundDurationMs: 2_000 });
    configureAndStart(game, { advanceToActive: false });
    expect(game.state.phase).toBe("hiding");
    game.tick(1_000);
    game.refreshAll();
    expect(game.state.phase).toBe("active");
    expect(game.state.activeEndsAt).toBe(game.now() + 2_000);

    game.advance(2_000);
    expect(game.state.phase).toBe("finished");
    expect(game.state.winner).toBe("hider");
    expect(game.state.traps).toHaveLength(0);
    expect(Object.values(game.state.players).every((player) => player.latestFix === undefined)).toBe(true);
  });

  it("lets the host return a finished party to the lobby for a rematch", () => {
    const game = setup({ hidingDurationMs: 1_000, roundDurationMs: 2_000 });
    configureAndStart(game, { advanceToActive: false });
    const savedBoundary = [...game.state.boundary];
    const matchId = game.state.matchId;
    expect(matchId).toBeTruthy();

    expect(game.command("host", { type: "return_to_lobby" }).code).toBe("wrong_phase");
    game.advance(1_000);
    game.refreshAll();
    game.advance(2_000);
    expect(game.state.phase).toBe("finished");
    expect(game.state.matchId).toBe(matchId);
    expect(game.command("seeker", { type: "return_to_lobby" }).code).toBe("host_only");

    expect(game.command("host", { type: "return_to_lobby" }).ok).toBe(true);
    expect(game.state.phase).toBe("lobby");
    expect(game.state.matchId).toBeUndefined();
    expect(game.state.winner).toBeNull();
    expect(game.state.boundary).toEqual(savedBoundary);
    expect(game.state.traps).toHaveLength(0);
    expect(Object.values(game.state.players).every((player) => player.status === "active")).toBe(true);
    expect(Object.values(game.state.players).every((player) => player.latestFix === undefined)).toBe(true);
    expect(game.state.events.at(-1)?.type).toBe("returned_to_lobby");
  });

  it("requires fresh player locations before resuming", () => {
    const game = setup();
    configureAndStart(game);
    expect(game.command("host", { type: "pause_match" }).ok).toBe(true);
    game.tick(game.state.rules.maxFixAgeMs + 1);
    expect(game.command("host", { type: "resume_match" }).code).toBe("players_not_ready");
    game.refreshAll();
    expect(game.command("host", { type: "resume_match" }).ok).toBe(true);
  });

  it("shifts match, radar, and trap deadlines by the paused duration", () => {
    const game = setup({ trapArmMs: 5_000 });
    configureAndStart(game);
    game.command("host", { type: "place_trap" });
    game.command("seeker", { type: "use_radar" });
    const activeEndsAt = game.state.activeEndsAt!;
    const radarEndsAt = game.state.radarEndsAt!;
    const nextRadarAt = game.state.nextRadarAt!;
    const armedAt = game.state.traps[0].armedAt;
    const expiresAt = game.state.traps[0].expiresAt;

    expect(game.command("host", { type: "pause_match" }).ok).toBe(true);
    game.tick(10_000);
    game.refreshAll();
    expect(game.command("host", { type: "resume_match" }).ok).toBe(true);
    expect(game.state.activeEndsAt).toBe(activeEndsAt + 10_000);
    expect(game.state.radarEndsAt).toBe(radarEndsAt + 10_000);
    expect(game.state.nextRadarAt).toBe(nextRadarAt + 10_000);
    expect(game.state.traps[0].armedAt).toBe(armedAt + 10_000);
    expect(game.state.traps[0].expiresAt).toBe(expiresAt + 10_000);
  });
});

describe("location stream integrity", () => {
  it("includes sample age in GPS health and competitive-action freshness", () => {
    const game = setup();
    configureAndStart(game);
    game.location("host", point(0), { sampleAgeMs: 2_000 });
    game.tick(1_001);
    const snapshot = snapshotForPlayer(game.state, "host", game.now());
    expect(snapshot.players.find((player) => player.id === "host")).toMatchObject({
      gpsAgeMs: 3_001,
      gpsStatus: "stale",
      gpsReady: false,
    });
    expect(game.command("host", { type: "place_trap" }).code).toBe("location_uncertain");
  });

  it.each<readonly [FixOverrides, string]>([
    [{ latitude: 91 }, "latitude"],
    [{ longitude: 181 }, "longitude"],
    [{ accuracyMeters: -1 }, "accuracy"],
    [{ sampleAgeMs: -1 }, "sample age"],
    [{ sampledAtMs: -1 }, "sample timestamp"],
    [{ sequence: -1 }, "sequence"],
    [{ accuracyMeters: Number.POSITIVE_INFINITY }, "non-finite value"],
  ])("rejects an invalid $1 payload", (override) => {
    const game = setup();
    const result = game.location("host", point(0), override as FixOverrides);
    expect(result.code).toBe("invalid_location");
    expect(game.state.players.host.latestFix).toBeUndefined();
  });

  it("rejects samples older than one minute", () => {
    const game = setup();
    expect(game.location("host", point(0), { sampleAgeMs: 60_001 }).code).toBe("stale_location");
  });

  it("rejects replayed sequence numbers within a session and accepts a new session", () => {
    const game = setup();
    expect(game.location("host", point(0), { sequence: 5, sessionId: "first-session" }).ok).toBe(true);
    expect(game.location("host", point(1), { sequence: 5, sessionId: "first-session" }).code).toBe(
      "replayed_location",
    );
    expect(game.location("host", point(1), { sequence: 1, sessionId: "second-session" }).ok).toBe(true);
    expect(game.state.players.host.latestFix?.sessionId).toBe("second-session");
  });

  it("does not let a delayed fix from a new session replace a newer position", () => {
    const game = setup();
    expect(game.location("host", point(0), { sequence: 5, sessionId: "first-session" }).ok).toBe(true);
    game.tick(1_000);

    expect(game.location("host", point(10), {
      sampleAgeMs: 2_000,
      sequence: 1,
      sessionId: "second-session",
    }).code).toBe("out_of_order_location");
    expect(game.state.players.host.latestFix).toMatchObject({
      sessionId: "first-session",
      sequence: 5,
      ...point(0),
    });

    expect(game.location("host", point(1), {
      sequence: 2,
      sessionId: "second-session",
    }).ok).toBe(true);
    expect(game.state.players.host.latestFix).toMatchObject({
      sessionId: "second-session",
      sequence: 2,
      ...point(1),
    });
  });

  it("stops retaining location after the match finishes", () => {
    const game = setup();
    configureAndStart(game);
    game.location("seeker", point(4));
    expect(game.command("seeker", { type: "tag" }).ok).toBe(true);
    expect(game.state.phase).toBe("finished");
    expect(game.location("seeker", point(5)).ok).toBe(true);
    expect(game.state.players.seeker.latestFix).toBeUndefined();
  });
});

describe("party lifecycle and bounded state", () => {
  it("rejects further commands from a departed player's retained match record", () => {
    const game = setup();
    configureAndStart(game, { additionalHiders: ["hider-two"] });
    expect(game.command("hider-two", { type: "leave_party" }).ok).toBe(true);
    expect(game.state.players["hider-two"].status).toBe("departed");
    const eventCount = game.state.events.length;
    expect(game.command("hider-two", { type: "leave_party" }).code).toBe("unknown_player");
    expect(game.state.events).toHaveLength(eventCount);
  });

  it("transfers host authority and revokes a departing player's token", () => {
    const game = setup();
    expect(game.command("host", { type: "leave_party" }).ok).toBe(true);
    expect(game.state.hostId).toBe("seeker");
    expect(game.state.players.seeker.isHost).toBe(true);
    expect(playerIdForToken(game.state, "host-token")).toBeUndefined();
    expect(game.state.players.host).toBeUndefined();
  });

  it("caps retained events to the newest forty", () => {
    const game = setup();
    for (let update = 0; update < 45; update += 1) {
      expect(game.command("host", { type: "set_boundary", boundary }).ok).toBe(true);
    }
    expect(game.state.events).toHaveLength(40);
    expect(game.state.events.every((event) => event.type === "boundary_updated")).toBe(true);
  });
});

describe("geospatial primitives", () => {
  it("keeps antipodal distances finite despite floating-point roundoff", () => {
    for (let latitude = -89; latitude <= 89; latitude += 1) {
      expect(Number.isFinite(distanceMeters(
        { latitude, longitude: -118 },
        { latitude: -latitude, longitude: 62 },
      ))).toBe(true);
    }
  });

  it("includes all boundary edges and corners in the play area", () => {
    for (const coordinate of [...boundary, point(50), point(-50), point(0, 50), point(0, -50)]) {
      expect(pointInPolygon(coordinate, boundary)).toBe(true);
    }
    expect(pointInPolygon(point(50.1), boundary)).toBe(false);
  });

  it("measures campus-scale distance and point containment", () => {
    expect(distanceMeters(point(0), point(20))).toBeCloseTo(20, 0);
    expect(pointInPolygon(point(0), boundary)).toBe(true);
    expect(pointInPolygon(point(70), boundary)).toBe(false);
  });

  it("rejects a self-crossing boundary", () => {
    expect(
      validateBoundary([point(-50, -50), point(50, 50), point(30, -50), point(-50, 40)]),
    ).toBe("Boundary cannot cross itself.");
  });
});
