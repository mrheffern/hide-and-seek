import {
  PROTOCOL_VERSION,
  type AcceptedDeviceStatus,
  type AcceptedPositionFix,
  type CommandEnvelope,
  type Coordinate,
  type DeviceStatusReport,
  type GameCommand,
  type GameEvent,
  type GameRules,
  type GpsStatus,
  type PlayerRecord,
  type PositionFix,
  type RoomSnapshot,
  type RoomState,
  type TrapRecord,
} from "@hide-and-seek/protocol";
import { distanceMeters, distanceToPolygonBoundaryMeters, pointInPolygon, validateBoundary } from "./geometry";

export const DEFAULT_RULES: GameRules = {
  tagRadiusMeters: 6.096,
  autoTagEnabled: true,
  autoTagDwellMs: 1_000,
  hiddenModeActivationMs: 4_000,
  hiddenModeExitDistanceMeters: 3,
  hiddenModeMovementSpeedMetersPerSecond: 0.8,
  hiddenModeMovementSustainMs: 1_000,
  trapRadiusMeters: 6.096,
  trapDwellMs: 15_000,
  trapArmMs: 5_000,
  trapLifetimeMs: 5 * 60_000,
  radarDurationMs: 3_000,
  radarCooldownMs: 5 * 60_000,
  hidingDurationMs: 10_000,
  roundDurationMs: 30 * 60_000,
  tagAttemptCooldownMs: 2_000,
  maxFixAgeMs: 3_000,
  maxObservationGapMs: 4_000,
  maxCompetitiveAccuracyMeters: 10,
  boundaryGraceMs: 15_000,
  disconnectPauseMs: 10_000,
  trapsPerHider: 1,
};

export const BOUNDARY_WARNING_DISTANCE_METERS = 10;
export const LOBBY_GPS_VERIFICATION_MS = 5_000;

/** Adds newly introduced defaults when a Durable Object wakes an older persisted room. */
export function upgradeRoomState(state: RoomState): RoomState {
  state.protocolVersion = PROTOCOL_VERSION;
  state.rules = { ...DEFAULT_RULES, ...state.rules };
  return state;
}

export interface RuleContext {
  now: number;
  id: () => string;
}

export interface RuleResult {
  ok: boolean;
  code: string;
  message: string;
}

const ok = (message: string): RuleResult => ({ ok: true, code: "ok", message });
const fail = (code: string, message: string): RuleResult => ({ ok: false, code, message });

function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, 24);
}

function addEvent(
  state: RoomState,
  context: RuleContext,
  event: Omit<GameEvent, "id" | "at">,
): void {
  state.events.push({ ...event, id: context.id(), at: context.now });
  state.events = state.events.slice(-40);
  state.version += 1;
}

function clearAutomaticTagState(player: PlayerRecord): void {
  player.autoTagProximityStartedAt = undefined;
  player.autoTagLastObservedAt = undefined;
}

function clearHiddenMode(player: PlayerRecord): void {
  player.hiddenMode = undefined;
  clearAutomaticTagState(player);
}

function clearAllHiddenModes(state: RoomState): void {
  for (const player of Object.values(state.players)) clearHiddenMode(player);
}

function clearPlayerLocation(player: PlayerRecord): void {
  player.latestFix = undefined;
  player.lobbyGpsVerificationStartedAt = undefined;
  player.lobbyGpsVerifiedAt = undefined;
  player.connected = false;
  player.outsideBoundary = false;
  player.boundaryOutsideMs = 0;
  player.boundaryLastObservedAt = undefined;
  clearHiddenMode(player);
}

function finishMatch(
  state: RoomState,
  winner: "seeker" | "hider",
  context: RuleContext,
  message: string,
  actorId?: string,
): void {
  state.phase = "finished";
  state.winner = winner;
  state.phaseStartedAt = context.now;
  state.hidingEndsAt = undefined;
  state.activeEndsAt = undefined;
  state.pausedAt = undefined;
  state.pausedFromPhase = undefined;
  state.radarEndsAt = undefined;
  state.nextRadarAt = undefined;
  state.immobilized = undefined;
  state.traps = [];
  for (const player of Object.values(state.players)) clearPlayerLocation(player);
  addEvent(state, context, { type: "match_finished", actorId, message });
}

function resetEmptyRoom(state: RoomState, context: RuleContext): void {
  state.version += 1;
  state.phase = "lobby";
  state.winner = null;
  state.createdAt = context.now;
  state.phaseStartedAt = context.now;
  state.matchId = undefined;
  state.hidingEndsAt = undefined;
  state.activeEndsAt = undefined;
  state.pausedAt = undefined;
  state.pausedFromPhase = undefined;
  state.hostId = "";
  state.players = {};
  state.tokens = {};
  state.processedCommandIds = [];
  state.boundary = [];
  state.traps = [];
  state.radarEndsAt = undefined;
  state.nextRadarAt = undefined;
  state.immobilized = undefined;
  state.events = [];
}

export function createRoomState(args: {
  roomCode: string;
  hostId: string;
  hostToken: string;
  hostName: string;
  now: number;
  rules?: Partial<GameRules>;
}): RoomState {
  const host: PlayerRecord = {
    id: args.hostId,
    name: cleanName(args.hostName) || "Host",
    role: "hider",
    status: "active",
    connected: false,
    isHost: true,
    trapChargesRemaining: args.rules?.trapsPerHider ?? DEFAULT_RULES.trapsPerHider,
    outsideBoundary: false,
    boundaryOutsideMs: 0,
  };
  return {
    protocolVersion: PROTOCOL_VERSION,
    roomCode: args.roomCode,
    version: 1,
    phase: "lobby",
    winner: null,
    createdAt: args.now,
    phaseStartedAt: args.now,
    hostId: host.id,
    players: { [host.id]: host },
    tokens: { [args.hostToken]: host.id },
    processedCommandIds: [],
    boundary: [],
    traps: [],
    rules: { ...DEFAULT_RULES, ...args.rules },
    events: [],
  };
}

export function addPlayer(
  state: RoomState,
  args: { playerId: string; token: string; name: string },
  context: RuleContext,
): RuleResult {
  if (state.phase !== "lobby") return fail("match_started", "This match has already started.");
  if (Object.values(state.players).filter((player) => player.status !== "departed").length >= 7) {
    return fail("room_full", "This party already has seven players.");
  }
  const name = cleanName(args.name);
  if (!name) return fail("invalid_name", "Enter a player name.");
  const currentHost = state.players[state.hostId];
  const becomesHost = !currentHost || currentHost.status === "departed";
  state.players[args.playerId] = {
    id: args.playerId,
    name,
    role: "hider",
    status: "active",
    connected: false,
    isHost: becomesHost,
    trapChargesRemaining: state.rules.trapsPerHider,
    outsideBoundary: false,
    boundaryOutsideMs: 0,
  };
  if (becomesHost) state.hostId = args.playerId;
  state.tokens[args.token] = args.playerId;
  addEvent(state, context, {
    type: "player_joined",
    actorId: args.playerId,
    message: `${name} joined the party.`,
  });
  return ok("Joined party.");
}

export function playerIdForToken(state: RoomState, token: string): string | undefined {
  return state.tokens[token];
}

function requireHost(state: RoomState, actorId: string): RuleResult | null {
  return state.hostId === actorId ? null : fail("host_only", "Only the host can do that.");
}

function fixAgeMs(fix: AcceptedPositionFix, now: number): number {
  return fix.sampleAgeMs + Math.max(0, now - fix.receivedAtMs);
}

function usableFix(state: RoomState, player: PlayerRecord, now: number): AcceptedPositionFix | null {
  const fix = player.latestFix;
  if (!fix) return null;
  if (fixAgeMs(fix, now) > state.rules.maxFixAgeMs) return null;
  if (fix.accuracyMeters > state.rules.maxCompetitiveAccuracyMeters) return null;
  return fix;
}

function gpsStatusFor(state: RoomState, player: PlayerRecord, now: number): GpsStatus {
  const fix = player.latestFix;
  if (!fix) return "missing";
  if (fixAgeMs(fix, now) > state.rules.maxFixAgeMs) {
    return "stale";
  }
  if (fix.accuracyMeters > state.rules.maxCompetitiveAccuracyMeters) return "weak";
  return "live";
}

function updateLobbyGpsVerification(
  state: RoomState,
  player: PlayerRecord,
  previous: AcceptedPositionFix | undefined,
  fix: PositionFix,
  context: RuleContext,
): void {
  if (state.phase !== "lobby" || player.lobbyGpsVerifiedAt !== undefined) return;
  const precise = fix.accuracyMeters <= state.rules.maxCompetitiveAccuracyMeters
    && fix.sampleAgeMs <= state.rules.maxFixAgeMs;
  if (!precise) {
    player.lobbyGpsVerificationStartedAt = undefined;
    return;
  }
  const previousWasContinuous = previous !== undefined
    && previous.accuracyMeters <= state.rules.maxCompetitiveAccuracyMeters
    && previous.sampleAgeMs <= state.rules.maxFixAgeMs
    && context.now - previous.receivedAtMs <= state.rules.maxObservationGapMs;
  if (!previousWasContinuous || player.lobbyGpsVerificationStartedAt === undefined) {
    player.lobbyGpsVerificationStartedAt = context.now;
    return;
  }
  if (context.now - player.lobbyGpsVerificationStartedAt >= LOBBY_GPS_VERIFICATION_MS) {
    player.lobbyGpsVerifiedAt = context.now;
    player.lobbyGpsVerificationStartedAt = undefined;
  }
}

function acceptedDeviceStatus(
  report: DeviceStatusReport | undefined,
  now: number,
): AcceptedDeviceStatus | undefined {
  if (!report) return undefined;
  if (
    report.batteryPercent !== undefined &&
    (!Number.isFinite(report.batteryPercent) || report.batteryPercent < 0 || report.batteryPercent > 100)
  ) {
    return undefined;
  }
  const networkTypes = new Set(["wifi", "cellular", "ethernet", "other", "none", "unknown"]);
  if (!networkTypes.has(report.networkType)) return undefined;
  return { ...report, receivedAtMs: now };
}

export function advanceRoomClock(state: RoomState, context: RuleContext): void {
  // Resolve elapsed deadlines in order, even when no request arrived at the deadline.
  while (state.phase === "hiding" || state.phase === "active") {
    const phaseDeadline = state.phase === "hiding" ? state.hidingEndsAt : state.activeEndsAt;
    const disconnect = Object.values(state.players)
      .filter((player) => player.status === "active")
      .map((player) => ({
        player,
        at: player.latestFix
          ? player.latestFix.receivedAtMs - player.latestFix.sampleAgeMs + state.rules.disconnectPauseMs
          : state.phaseStartedAt,
      }))
      .sort((a, b) => a.at - b.at)[0];
    if (
      disconnect &&
      context.now > disconnect.at &&
      (phaseDeadline === undefined || disconnect.at < phaseDeadline)
    ) {
      const pausedAt = Math.max(state.phaseStartedAt, disconnect.at);
      state.pausedFromPhase = state.phase;
      state.phase = "paused";
      state.pausedAt = pausedAt;
      state.phaseStartedAt = pausedAt;
      clearAllHiddenModes(state);
      addEvent(state, { ...context, now: pausedAt }, {
        type: "match_paused",
        targetId: disconnect.player.id,
        message: "The match paused while a player reconnects.",
      });
      break;
    }
    if (phaseDeadline === undefined || context.now < phaseDeadline) break;
    if (state.phase === "active") {
      finishMatch(state, "hider", { ...context, now: phaseDeadline }, "Time expired. The hiders win.");
      break;
    }
    state.phase = "active";
    state.phaseStartedAt = phaseDeadline;
    state.activeEndsAt = phaseDeadline + state.rules.roundDurationMs;
    state.hidingEndsAt = undefined;
    state.version += 1;
  }
  const gameNow = state.phase === "paused" ? (state.pausedAt ?? context.now) : context.now;
  const oldLength = state.traps.length;
  state.traps = state.traps.filter(
    (trap) => trap.expiresAt > gameNow || state.immobilized?.trapId === trap.id,
  );
  if (state.traps.length !== oldLength) state.version += 1;
}

function setBoundary(
  state: RoomState,
  actorId: string,
  boundary: Coordinate[],
  context: RuleContext,
): RuleResult {
  const hostError = requireHost(state, actorId);
  if (hostError) return hostError;
  if (state.phase !== "lobby") return fail("wrong_phase", "The boundary is locked after the match starts.");
  const error = validateBoundary(boundary);
  if (error) return fail("invalid_boundary", error);
  state.boundary = boundary.map((point) => ({ ...point }));
  addEvent(state, context, { type: "boundary_updated", actorId, message: "Boundary updated." });
  return ok("Boundary saved.");
}

function setSeeker(
  state: RoomState,
  actorId: string,
  playerId: string,
  context: RuleContext,
): RuleResult {
  const hostError = requireHost(state, actorId);
  if (hostError) return hostError;
  if (state.phase !== "lobby") return fail("wrong_phase", "Roles are locked after the match starts.");
  const selected = state.players[playerId];
  if (!selected) return fail("unknown_player", "Player was not found.");
  for (const player of Object.values(state.players)) {
    player.role = player.id === playerId ? "seeker" : "hider";
    player.trapChargesRemaining = player.role === "hider" ? state.rules.trapsPerHider : 0;
    clearHiddenMode(player);
  }
  addEvent(state, context, {
    type: "seeker_selected",
    actorId,
    targetId: selected.id,
    message: `${selected.name} is the seeker.`,
  });
  return ok("Seeker selected.");
}

function startMatch(state: RoomState, actorId: string, context: RuleContext): RuleResult {
  const hostError = requireHost(state, actorId);
  if (hostError) return hostError;
  if (state.phase !== "lobby") return fail("wrong_phase", "The match has already started.");
  if (validateBoundary(state.boundary)) return fail("boundary_required", "Draw and save a valid boundary first.");
  const players = Object.values(state.players).filter((player) => player.status !== "departed");
  if (players.length < 2) return fail("players_required", "At least two players are required.");
  if (players.filter((player) => player.role === "seeker").length !== 1) {
    return fail("seeker_required", "Select exactly one seeker.");
  }
  for (const player of players) {
    const fix = usableFix(state, player, context.now);
    if (player.lobbyGpsVerifiedAt === undefined || !fix) {
      // Wake every unverified lobby client so it can keep a foreground GPS watch
      // running until the server observes a sustained precise signal.
      addEvent(state, context, {
        type: "gps_check_requested",
        actorId,
        message: "Refreshing every player's GPS before the match starts.",
      });
      return fail("players_not_ready", `${player.name} needs a recent precise location before starting.`);
    }
    if (!pointInPolygon(fix, state.boundary)) {
      return fail("players_outside_boundary", `${player.name} must enter the boundary before starting.`);
    }
  }
  state.phase = "hiding";
  state.matchId = context.id();
  state.phaseStartedAt = context.now;
  state.hidingEndsAt = context.now + state.rules.hidingDurationMs;
  state.winner = null;
  state.traps = [];
  state.radarEndsAt = undefined;
  state.nextRadarAt = context.now + state.rules.hidingDurationMs;
  state.immobilized = undefined;
  for (const player of players) {
    player.status = "active";
    player.trapChargesRemaining = player.role === "hider" ? state.rules.trapsPerHider : 0;
    player.outsideBoundary = false;
    player.boundaryOutsideMs = 0;
    player.boundaryLastObservedAt = undefined;
    clearHiddenMode(player);
  }
  addEvent(state, context, { type: "match_started", actorId, message: "The hiding countdown started." });
  return ok("Match started.");
}

function pauseMatch(state: RoomState, actorId: string, context: RuleContext): RuleResult {
  const hostError = requireHost(state, actorId);
  if (hostError) return hostError;
  if (state.phase !== "hiding" && state.phase !== "active") {
    return fail("wrong_phase", "Only a running match can be paused.");
  }
  state.pausedFromPhase = state.phase;
  state.phase = "paused";
  state.pausedAt = context.now;
  state.phaseStartedAt = context.now;
  clearAllHiddenModes(state);
  addEvent(state, context, { type: "match_paused", actorId, message: "The host paused the match." });
  return ok("Match paused.");
}

function resumeMatch(state: RoomState, actorId: string, context: RuleContext): RuleResult {
  const hostError = requireHost(state, actorId);
  if (hostError) return hostError;
  if (state.phase !== "paused" || state.pausedAt === undefined || !state.pausedFromPhase) {
    return fail("wrong_phase", "The match is not paused.");
  }
  if (!Object.values(state.players).some((player) => player.role === "seeker" && player.status === "active")) {
    return fail("seeker_required", "The seeker must reconnect or the match must be restarted.");
  }
  for (const player of Object.values(state.players)) {
    if (player.status === "active" && !usableFix(state, player, context.now)) {
      return fail("players_not_ready", `${player.name} needs a recent precise location before resuming.`);
    }
  }
  const shift = context.now - state.pausedAt;
  if (state.hidingEndsAt) state.hidingEndsAt += shift;
  if (state.activeEndsAt) state.activeEndsAt += shift;
  if (state.radarEndsAt) state.radarEndsAt += shift;
  if (state.nextRadarAt) state.nextRadarAt += shift;
  for (const trap of state.traps) {
    trap.armedAt += shift;
    trap.expiresAt += shift;
  }
  for (const player of Object.values(state.players)) {
    player.boundaryLastObservedAt = undefined;
    if (player.lastTagAttemptAt !== undefined) player.lastTagAttemptAt += shift;
    clearHiddenMode(player);
  }
  state.phase = state.pausedFromPhase;
  state.pausedFromPhase = undefined;
  state.pausedAt = undefined;
  state.phaseStartedAt = context.now;
  state.immobilized &&= {
    ...state.immobilized,
    dwellMs: 0,
    lastObservationAt: context.now,
    lastQualifiedInsideAt: undefined,
  };
  addEvent(state, context, { type: "match_resumed", actorId, message: "The host resumed the match." });
  return ok("Match resumed.");
}

function useRadar(state: RoomState, actorId: string, context: RuleContext): RuleResult {
  const player = state.players[actorId];
  if (state.phase !== "active") return fail("wrong_phase", "Radar is available during active play.");
  if (player?.role !== "seeker") return fail("seeker_only", "Only the seeker can use radar.");
  if (state.immobilized) return fail("immobilized", "Radar is disabled while trapped.");
  if (player.outsideBoundary) return fail("outside_boundary", "Return inside the boundary before using radar.");
  if (state.nextRadarAt && context.now < state.nextRadarAt) {
    return fail("cooldown", "Radar is still cooling down.");
  }
  state.radarEndsAt = context.now + state.rules.radarDurationMs;
  state.nextRadarAt = context.now + state.rules.radarCooldownMs;
  addEvent(state, context, { type: "radar_used", actorId, message: "The seeker used radar." });
  return ok("Radar active.");
}

function placeTrap(state: RoomState, actorId: string, context: RuleContext): RuleResult {
  const player = state.players[actorId];
  if (state.phase !== "active") return fail("wrong_phase", "Traps are available during active play.");
  if (!player || player.role !== "hider" || player.status !== "active") {
    return fail("hider_only", "Only an active hider can place a trap.");
  }
  if (player.trapChargesRemaining <= 0) return fail("no_charges", "No trap charges remain.");
  const fix = usableFix(state, player, context.now);
  if (!fix) return fail("location_uncertain", "Move into clearer sky and wait for a precise location.");
  if (!pointInPolygon(fix, state.boundary)) return fail("outside_boundary", "Return inside the boundary first.");
  const trap: TrapRecord = {
    id: context.id(),
    ownerId: actorId,
    latitude: fix.latitude,
    longitude: fix.longitude,
    radiusMeters: state.rules.trapRadiusMeters,
    placedAt: context.now,
    armedAt: context.now + state.rules.trapArmMs,
    expiresAt: context.now + state.rules.trapLifetimeMs,
    placementAccuracyMeters: fix.accuracyMeters,
  };
  state.traps.push(trap);
  player.trapChargesRemaining -= 1;
  addEvent(state, context, { type: "trap_placed", actorId, message: `${player.name} placed a trap.` });
  return ok("Trap placed.");
}

function startHiddenModeObservation(
  player: PlayerRecord,
  fix: AcceptedPositionFix,
  context: RuleContext,
): void {
  player.hiddenMode = {
    anchor: { latitude: fix.latitude, longitude: fix.longitude },
    anchorAccuracyMeters: fix.accuracyMeters,
    stationarySinceAt: context.now,
    lastObservationAt: context.now,
  };
}

function processHiddenModeObservation(
  state: RoomState,
  player: PlayerRecord,
  fix: AcceptedPositionFix,
  context: RuleContext,
): void {
  if (
    player.role !== "hider" ||
    player.status !== "active" ||
    (state.phase !== "hiding" && state.phase !== "active")
  ) {
    clearHiddenMode(player);
    return;
  }
  const precise = fix.accuracyMeters <= state.rules.maxCompetitiveAccuracyMeters &&
    fixAgeMs(fix, context.now) <= state.rules.maxFixAgeMs;
  if (!precise) {
    clearHiddenMode(player);
    return;
  }

  const observation = player.hiddenMode;
  if (
    !observation ||
    context.now - observation.lastObservationAt > state.rules.maxObservationGapMs
  ) {
    clearAutomaticTagState(player);
    startHiddenModeObservation(player, fix, context);
    return;
  }

  const distanceFromAnchor = distanceMeters(observation.anchor, fix);
  const accuracyAllowance = Math.min(
    state.rules.maxCompetitiveAccuracyMeters,
    Math.max(observation.anchorAccuracyMeters, fix.accuracyMeters),
  );
  const credibleDisplacement = Math.max(0, distanceFromAnchor - accuracyAllowance);
  const displacementShowsMovement = credibleDisplacement >= state.rules.hiddenModeExitDistanceMeters;
  const speedShowsMovement =
    fix.speedMetersPerSecond !== undefined &&
    fix.speedMetersPerSecond >= state.rules.hiddenModeMovementSpeedMetersPerSecond;
  if (displacementShowsMovement || speedShowsMovement) {
    if (!observation.hiddenAt) {
      startHiddenModeObservation(player, fix, context);
      return;
    }
    observation.movingSinceAt ??= context.now;
    observation.lastObservationAt = context.now;
    if (context.now - observation.movingSinceAt >= state.rules.hiddenModeMovementSustainMs) {
      clearAutomaticTagState(player);
      startHiddenModeObservation(player, fix, context);
    }
    return;
  }

  observation.movingSinceAt = undefined;
  observation.lastObservationAt = context.now;
  if (
    observation.hiddenAt === undefined &&
    context.now - observation.stationarySinceAt >= state.rules.hiddenModeActivationMs
  ) {
    observation.hiddenAt = context.now;
    clearAutomaticTagState(player);
  }
}

function awardTag(
  state: RoomState,
  seeker: PlayerRecord,
  hider: PlayerRecord,
  context: RuleContext,
  automatic: boolean,
): void {
  hider.status = "eliminated";
  clearPlayerLocation(hider);
  addEvent(state, context, {
    type: "player_tagged",
    actorId: seeker.id,
    targetId: hider.id,
    tagMethod: automatic ? "automatic" : "manual",
    message: automatic ? `${hider.name} was automatically tagged.` : `${hider.name} was tagged.`,
  });
  const activeHider = Object.values(state.players).some(
    (player) => player.role === "hider" && player.status === "active",
  );
  if (!activeHider) {
    finishMatch(state, "seeker", context, "All hiders were tagged. The seeker wins.", seeker.id);
  }
}

function tag(state: RoomState, actorId: string, context: RuleContext): RuleResult {
  const seeker = state.players[actorId];
  if (state.phase !== "active") return fail("wrong_phase", "Tagging is available during active play.");
  if (!seeker || seeker.role !== "seeker") return fail("seeker_only", "Only the seeker can tag.");
  if (state.immobilized) return fail("immobilized", "Tagging is disabled while trapped.");
  if (seeker.outsideBoundary) return fail("outside_boundary", "Return inside the boundary before tagging.");
  if (seeker.lastTagAttemptAt !== undefined && context.now - seeker.lastTagAttemptAt < state.rules.tagAttemptCooldownMs) {
    return fail("cooldown", "Wait before trying to tag again.");
  }
  const seekerFix = usableFix(state, seeker, context.now);
  if (!seekerFix) return fail("location_uncertain", "Your current location is not precise enough.");
  seeker.lastTagAttemptAt = context.now;
  state.version += 1;
  const hiders = Object.values(state.players).filter(
    (player) => player.role === "hider" && player.status === "active",
  );
  let nearest: { player: PlayerRecord; distance: number } | undefined;
  let possiblyNearby = false;
  for (const hider of hiders) {
    const rawFix = hider.latestFix;
    if (!rawFix || fixAgeMs(rawFix, context.now) > state.rules.maxFixAgeMs) continue;
    const distance = distanceMeters(seekerFix, rawFix);
    if (distance - seekerFix.accuracyMeters - rawFix.accuracyMeters <= state.rules.tagRadiusMeters) {
      possiblyNearby = true;
    }
    const fix = usableFix(state, hider, context.now);
    if (fix && distance <= state.rules.tagRadiusMeters && (!nearest || distance < nearest.distance)) {
      nearest = { player: hider, distance };
    }
  }
  if (!nearest) {
    return possiblyNearby
      ? fail("location_uncertain", "Someone may be close, but GPS is not precise enough to award the tag.")
      : fail("no_target", "No hider is in tag range.");
  }
  awardTag(state, seeker, nearest.player, context, false);
  return ok(`${nearest.player.name} tagged.`);
}

function processAutomaticTagObservation(state: RoomState, context: RuleContext): void {
  const hiders = Object.values(state.players).filter(
    (player) => player.role === "hider" && player.status === "active",
  );
  const clearCandidates = () => {
    for (const hider of hiders) clearAutomaticTagState(hider);
  };
  if (!state.rules.autoTagEnabled || state.phase !== "active" || state.immobilized) {
    clearCandidates();
    return;
  }
  const seeker = Object.values(state.players).find(
    (player) => player.role === "seeker" && player.status === "active",
  );
  if (!seeker || seeker.outsideBoundary) {
    clearCandidates();
    return;
  }
  const seekerFix = usableFix(state, seeker, context.now);
  if (!seekerFix) {
    clearCandidates();
    return;
  }

  let nearestQualified: { player: PlayerRecord; distance: number } | undefined;
  for (const hider of hiders) {
    const hiderFix = usableFix(state, hider, context.now);
    const hidden = hider.hiddenMode?.hiddenAt !== undefined;
    if (!hiderFix || hidden) {
      clearAutomaticTagState(hider);
      continue;
    }
    const distance = distanceMeters(seekerFix, hiderFix);
    if (distance > state.rules.tagRadiusMeters) {
      clearAutomaticTagState(hider);
      continue;
    }
    if (
      hider.autoTagProximityStartedAt === undefined ||
      hider.autoTagLastObservedAt === undefined ||
      context.now - hider.autoTagLastObservedAt > state.rules.maxObservationGapMs
    ) {
      hider.autoTagProximityStartedAt = context.now;
    }
    hider.autoTagLastObservedAt = context.now;
    if (
      context.now - hider.autoTagProximityStartedAt >= state.rules.autoTagDwellMs &&
      (!nearestQualified || distance < nearestQualified.distance)
    ) {
      nearestQualified = { player: hider, distance };
    }
  }
  if (nearestQualified) {
    awardTag(state, seeker, nearestQualified.player, context, true);
  }
}

function leaveParty(state: RoomState, actorId: string, context: RuleContext): RuleResult {
  const player = state.players[actorId];
  if (!player) return fail("unknown_player", "Player was not found.");
  const wasLobby = state.phase === "lobby";
  player.status = "departed";
  clearPlayerLocation(player);
  for (const [token, playerId] of Object.entries(state.tokens)) {
    if (playerId === actorId) delete state.tokens[token];
  }
  const remaining = Object.values(state.players).filter((candidate) => candidate.status !== "departed");
  if (state.hostId === actorId && remaining.length) {
    player.isHost = false;
    const nextHost = remaining.find((candidate) => candidate.status === "active") ?? remaining[0];
    nextHost.isHost = true;
    state.hostId = nextHost.id;
  }
  addEvent(state, context, { type: "player_left", actorId, message: `${player.name} left the party.` });
  const matchInProgress = state.phase === "hiding" || state.phase === "active" || state.phase === "paused";
  if (matchInProgress && player.role === "seeker") {
    finishMatch(state, "hider", context, "The seeker left the party. The hiders win.");
  } else if (
    matchInProgress &&
    !remaining.some((candidate) => candidate.role === "hider" && candidate.status === "active")
  ) {
    finishMatch(state, "seeker", context, "No hiders remain. The seeker wins.");
  }
  if (wasLobby) {
    delete state.players[actorId];
  }
  if (!remaining.length) resetEmptyRoom(state, context);
  return ok("Left party.");
}

function returnToLobby(state: RoomState, actorId: string, context: RuleContext): RuleResult {
  const hostError = requireHost(state, actorId);
  if (hostError) return hostError;
  if (state.phase !== "finished") return fail("wrong_phase", "The match must be over before returning to the lobby.");

  state.phase = "lobby";
  state.matchId = undefined;
  state.winner = null;
  state.phaseStartedAt = context.now;
  state.hidingEndsAt = undefined;
  state.activeEndsAt = undefined;
  state.pausedAt = undefined;
  state.pausedFromPhase = undefined;
  state.radarEndsAt = undefined;
  state.nextRadarAt = undefined;
  state.immobilized = undefined;
  state.traps = [];
  for (const [playerId, player] of Object.entries(state.players)) {
    if (player.status === "departed") {
      delete state.players[playerId];
      continue;
    }
    player.status = "active";
    player.trapChargesRemaining = player.role === "hider" ? state.rules.trapsPerHider : 0;
    player.lastTagAttemptAt = undefined;
    clearPlayerLocation(player);
  }
  state.events = [];
  addEvent(state, context, {
    type: "returned_to_lobby",
    actorId,
    message: "The party returned to the lobby.",
  });
  return ok("Returned to lobby.");
}

export function applyCommand(
  state: RoomState,
  actorId: string,
  envelope: CommandEnvelope,
  context: RuleContext,
): RuleResult {
  advanceRoomClock(state, context);
  if (envelope.protocolVersion !== PROTOCOL_VERSION) {
    return fail("protocol_mismatch", "Update the app before continuing.");
  }
  if (!state.players[actorId] || state.players[actorId].status === "departed") {
    return fail("unknown_player", "Player was not found.");
  }
  const command: GameCommand = envelope.command;
  switch (command.type) {
    case "set_boundary":
      return setBoundary(state, actorId, command.boundary, context);
    case "set_seeker":
      return setSeeker(state, actorId, command.playerId, context);
    case "start_match":
      return startMatch(state, actorId, context);
    case "pause_match":
      return pauseMatch(state, actorId, context);
    case "resume_match":
      return resumeMatch(state, actorId, context);
    case "use_radar":
      return useRadar(state, actorId, context);
    case "place_trap":
      return placeTrap(state, actorId, context);
    case "tag":
      return tag(state, actorId, context);
    case "return_to_lobby":
      return returnToLobby(state, actorId, context);
    case "leave_party":
      return leaveParty(state, actorId, context);
  }
}

function processSeekerTrapObservation(
  state: RoomState,
  seeker: PlayerRecord,
  fix: AcceptedPositionFix,
  context: RuleContext,
): void {
  if (state.phase !== "active") return;
  if (state.immobilized) {
    const trap = state.traps.find((candidate) => candidate.id === state.immobilized?.trapId);
    if (!trap) {
      state.immobilized = undefined;
      state.version += 1;
      return;
    }
    const hold = state.immobilized;
    const gap = context.now - hold.lastObservationAt;
    if (gap > state.rules.maxObservationGapMs) {
      hold.dwellMs = 0;
      hold.lastQualifiedInsideAt = undefined;
    }
    hold.lastObservationAt = context.now;
    const accurate = fix.accuracyMeters <= state.rules.maxCompetitiveAccuracyMeters &&
      fixAgeMs(fix, context.now) <= state.rules.maxFixAgeMs;
    const inside = accurate && distanceMeters(fix, trap) <= trap.radiusMeters;
    if (!accurate) {
      hold.dwellMs = 0;
      hold.lastQualifiedInsideAt = undefined;
      return;
    }
    if (!inside) {
      hold.dwellMs = 0;
      hold.lastQualifiedInsideAt = undefined;
      return;
    }
    if (hold.lastQualifiedInsideAt !== undefined) {
      hold.dwellMs += Math.min(context.now - hold.lastQualifiedInsideAt, state.rules.maxObservationGapMs);
    }
    hold.lastQualifiedInsideAt = context.now;
    if (hold.dwellMs >= state.rules.trapDwellMs) {
      state.immobilized = undefined;
      addEvent(state, context, { type: "trap_released", message: "The seeker escaped the trap." });
    }
    return;
  }
  if (
    fix.accuracyMeters > state.rules.maxCompetitiveAccuracyMeters ||
    fixAgeMs(fix, context.now) > state.rules.maxFixAgeMs
  ) return;
  const trap = state.traps.find(
    (candidate) =>
      !candidate.consumedAt &&
      candidate.armedAt <= context.now &&
      candidate.expiresAt > context.now &&
      distanceMeters(fix, candidate) <= candidate.radiusMeters,
  );
  if (!trap) return;
  trap.consumedAt = context.now;
  state.immobilized = {
    trapId: trap.id,
    startedAt: context.now,
    dwellMs: 0,
    lastObservationAt: context.now,
    lastQualifiedInsideAt: context.now,
  };
  addEvent(state, context, {
    type: "trap_triggered",
    actorId: trap.ownerId,
    targetId: seeker.id,
    message: "The seeker triggered a trap.",
  });
}

function processBoundaryObservation(
  state: RoomState,
  player: PlayerRecord,
  fix: AcceptedPositionFix,
  context: RuleContext,
): void {
  if ((state.phase !== "hiding" && state.phase !== "active") || state.boundary.length < 3) return;
  if (
    fix.accuracyMeters > state.rules.maxCompetitiveAccuracyMeters ||
    fixAgeMs(fix, context.now) > state.rules.maxFixAgeMs
  ) {
    player.boundaryLastObservedAt = undefined;
    return;
  }
  if (pointInPolygon(fix, state.boundary)) {
    player.outsideBoundary = false;
    player.boundaryOutsideMs = 0;
    player.boundaryLastObservedAt = context.now;
    return;
  }
  const clearlyOutside = distanceToPolygonBoundaryMeters(fix, state.boundary) > fix.accuracyMeters;
  if (!clearlyOutside) {
    player.boundaryLastObservedAt = undefined;
    return;
  }
  if (
    player.outsideBoundary &&
    player.boundaryLastObservedAt !== undefined &&
    context.now - player.boundaryLastObservedAt <= state.rules.maxObservationGapMs
  ) {
    player.boundaryOutsideMs += context.now - player.boundaryLastObservedAt;
  } else if (!player.outsideBoundary) {
    player.boundaryOutsideMs = 0;
  }
  player.outsideBoundary = true;
  player.boundaryLastObservedAt = context.now;
  if (
    player.role === "hider" &&
    player.status === "active" &&
    player.boundaryOutsideMs >= state.rules.boundaryGraceMs
  ) {
    player.status = "eliminated";
    clearPlayerLocation(player);
    addEvent(state, context, {
      type: "boundary_eliminated",
      targetId: player.id,
      message: `${player.name} was eliminated for leaving the boundary.`,
    });
    const activeHider = Object.values(state.players).some(
      (candidate) => candidate.role === "hider" && candidate.status === "active",
    );
    if (!activeHider) {
      finishMatch(state, "seeker", context, "No hiders remain. The seeker wins.");
    }
  }
}

export function acceptLocation(
  state: RoomState,
  actorId: string,
  fix: PositionFix,
  context: RuleContext,
  deviceStatus?: DeviceStatusReport,
): RuleResult {
  advanceRoomClock(state, context);
  const player = state.players[actorId];
  if (!player) return fail("unknown_player", "Player was not found.");
  if (state.phase === "finished" || player.status !== "active") {
    clearPlayerLocation(player);
    return ok("Location sharing is inactive.");
  }
  if (
    !Number.isFinite(fix.latitude) ||
    !Number.isFinite(fix.longitude) ||
    !Number.isFinite(fix.accuracyMeters) ||
    (fix.speedMetersPerSecond !== undefined && !Number.isFinite(fix.speedMetersPerSecond)) ||
    !Number.isFinite(fix.sampledAtMs) ||
    !Number.isInteger(fix.sampledAtMs) ||
    !Number.isInteger(fix.sampleAgeMs) ||
    !Number.isInteger(fix.sequence) ||
    typeof fix.sessionId !== "string" ||
    fix.sessionId.length < 8 ||
    fix.sessionId.length > 100 ||
    Math.abs(fix.latitude) > 90 ||
    Math.abs(fix.longitude) > 180 ||
    fix.accuracyMeters < 0 ||
    (fix.speedMetersPerSecond !== undefined && fix.speedMetersPerSecond < 0) ||
    fix.sampleAgeMs < 0 ||
    fix.sampledAtMs < 0 ||
    fix.sequence < 0
  ) {
    return fail("invalid_location", "Location payload is invalid.");
  }
  if (fix.sampleAgeMs > 60_000) return fail("stale_location", "Location sample is too old.");
  const nextDeviceStatus = acceptedDeviceStatus(deviceStatus, context.now);
  if (deviceStatus && !nextDeviceStatus) {
    return fail("invalid_device_status", "Device status payload is invalid.");
  }
  const previous = player.latestFix;
  if (previous?.sessionId === fix.sessionId && fix.sequence <= previous.sequence) {
    return fail("replayed_location", "Location sample was already processed.");
  }
  const observedAt = context.now - fix.sampleAgeMs;
  const previousObservedAt = previous
    ? previous.receivedAtMs - previous.sampleAgeMs
    : undefined;
  if (
    previousObservedAt !== undefined &&
    previous?.sessionId !== fix.sessionId &&
    observedAt < previousObservedAt
  ) {
    return fail("out_of_order_location", "A newer location sample was already processed.");
  }
  updateLobbyGpsVerification(state, player, previous, fix, context);
  player.latestFix = { ...fix, receivedAtMs: context.now };
  if (nextDeviceStatus) player.deviceStatus = nextDeviceStatus;
  player.connected = true;
  state.version += 1;
  processBoundaryObservation(state, player, player.latestFix, context);
  processHiddenModeObservation(state, player, player.latestFix, context);
  if (player.role === "seeker" && player.status === "active") {
    processSeekerTrapObservation(state, player, player.latestFix, context);
  }
  processAutomaticTagObservation(state, context);
  return ok("Location accepted.");
}

export function snapshotForPlayer(state: RoomState, viewerId: string, now: number): RoomSnapshot {
  const viewer = state.players[viewerId];
  if (!viewer) throw new Error("Unknown snapshot viewer");
  const radarVisible = viewer.role === "seeker" && Boolean(state.radarEndsAt && now < state.radarEndsAt);
  const players = Object.values(state.players).map((player) => {
    const gpsStatus = gpsStatusFor(state, player, now);
    const canSeeLocation =
      player.id === viewerId ||
      (viewer.role === "hider" &&
        viewer.status === "active" &&
        player.role === "hider" &&
        player.status === "active") ||
      (radarVisible && player.role === "hider" && player.status === "active");
    return {
      id: player.id,
      name: player.name,
      role: player.role,
      status: player.status,
      connected: player.connected,
      isHost: player.isHost,
      gpsReady: state.phase === "lobby" ? player.lobbyGpsVerifiedAt !== undefined : gpsStatus === "live",
      gpsStatus,
      gpsAgeMs: player.latestFix ? fixAgeMs(player.latestFix, now) : undefined,
      gpsAccuracyMeters: player.latestFix?.accuracyMeters,
      deviceStatus: player.deviceStatus,
      location: canSeeLocation ? player.latestFix : undefined,
      hiddenMode: player.id === viewerId && player.role === "hider" && player.status === "active"
        ? {
            hidden: player.hiddenMode?.hiddenAt !== undefined,
            activatesAt: player.hiddenMode?.hiddenAt === undefined && player.hiddenMode
              ? player.hiddenMode.stationarySinceAt + state.rules.hiddenModeActivationMs
              : undefined,
            hiddenAt: player.hiddenMode?.hiddenAt,
          }
        : undefined,
      trapChargesRemaining: player.id === viewerId ? player.trapChargesRemaining : undefined,
    };
  });
  const traps = state.traps
    .filter((trap) => {
      if (viewer.role === "hider") return viewer.status === "active" && !trap.consumedAt;
      return state.immobilized?.trapId === trap.id;
    })
    .map((trap) => ({
      id: trap.id,
      latitude: trap.latitude,
      longitude: trap.longitude,
      radiusMeters: trap.radiusMeters,
      armedAt: trap.armedAt,
      expiresAt: trap.expiresAt,
      triggered: Boolean(trap.consumedAt),
      ownedBySelf: trap.ownerId === viewerId,
    }));
  const viewerFix = viewer.latestFix;
  const running = state.phase === "hiding" || state.phase === "active" || state.phase === "paused";
  const boundaryDistanceMeters =
    running && viewerFix && state.boundary.length >= 3
      ? distanceToPolygonBoundaryMeters(viewerFix, state.boundary)
      : undefined;
  const nearBoundary = Boolean(
    boundaryDistanceMeters !== undefined &&
      !viewer.outsideBoundary &&
      pointInPolygon(viewerFix!, state.boundary) &&
      boundaryDistanceMeters <= BOUNDARY_WARNING_DISTANCE_METERS,
  );
  return {
    type: "snapshot",
    protocolVersion: PROTOCOL_VERSION,
    roomCode: state.roomCode,
    version: state.version,
    serverNow: now,
    phase: state.phase,
    matchId: state.matchId,
    winner: state.winner,
    selfId: viewerId,
    hostId: state.hostId,
    players,
    boundary: state.boundary,
    traps,
    rules: state.rules,
    radarEndsAt: viewer.role === "seeker" ? state.radarEndsAt : undefined,
    nextRadarAt: viewer.role === "seeker" ? state.nextRadarAt : undefined,
    hidingEndsAt: state.hidingEndsAt,
    activeEndsAt: state.activeEndsAt,
    immobilized: viewer.role === "seeker" ? state.immobilized : undefined,
    outsideBoundary: viewer.outsideBoundary,
    nearBoundary,
    boundaryDistanceMeters,
    boundaryGraceRemainingMs: viewer.outsideBoundary
      ? Math.max(0, state.rules.boundaryGraceMs - viewer.boundaryOutsideMs)
      : undefined,
    events: state.events
      .filter((event) => viewer.role !== "seeker" || event.type !== "trap_placed")
      .slice(-12),
  };
}
