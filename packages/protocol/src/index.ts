export const PROTOCOL_VERSION = 2 as const;

export type PlayerRole = "seeker" | "hider";
export type PlayerStatus = "active" | "eliminated" | "departed";
export type MatchPhase = "lobby" | "hiding" | "active" | "paused" | "finished";
export type MatchWinner = PlayerRole | null;
export type DiagnosticLevel = "debug" | "info" | "warn" | "error" | "fatal";
export type DiagnosticSource = "client" | "server";

export interface Coordinate {
  latitude: number;
  longitude: number;
}

export interface PositionFix extends Coordinate {
  accuracyMeters: number;
  /** Native speed estimate when the platform provides a trustworthy non-negative value. */
  speedMetersPerSecond?: number;
  sampledAtMs: number;
  sampleAgeMs: number;
  sequence: number;
  sessionId: string;
}

export interface AcceptedPositionFix extends PositionFix {
  receivedAtMs: number;
}

export type NetworkType = "wifi" | "cellular" | "ethernet" | "other" | "none" | "unknown";
export type GpsStatus = "live" | "weak" | "stale" | "missing";

export interface DeviceStatusReport {
  batteryPercent?: number;
  isCharging?: boolean;
  lowPowerMode?: boolean;
  networkType: NetworkType;
  isInternetReachable?: boolean;
}

export interface AcceptedDeviceStatus extends DeviceStatusReport {
  receivedAtMs: number;
}

export interface GameRules {
  tagRadiusMeters: number;
  autoTagEnabled: boolean;
  autoTagDwellMs: number;
  hiddenModeActivationMs: number;
  hiddenModeExitDistanceMeters: number;
  hiddenModeMovementSpeedMetersPerSecond: number;
  hiddenModeMovementSustainMs: number;
  trapRadiusMeters: number;
  trapDwellMs: number;
  trapArmMs: number;
  trapLifetimeMs: number;
  radarDurationMs: number;
  radarCooldownMs: number;
  hidingDurationMs: number;
  roundDurationMs: number;
  tagAttemptCooldownMs: number;
  maxFixAgeMs: number;
  maxObservationGapMs: number;
  maxCompetitiveAccuracyMeters: number;
  boundaryGraceMs: number;
  disconnectPauseMs: number;
  trapsPerHider: number;
}

export interface HiddenModeRecord {
  anchor: Coordinate;
  anchorAccuracyMeters: number;
  stationarySinceAt: number;
  lastObservationAt: number;
  movingSinceAt?: number;
  hiddenAt?: number;
}

export interface PlayerRecord {
  id: string;
  name: string;
  role: PlayerRole;
  status: PlayerStatus;
  connected: boolean;
  isHost: boolean;
  latestFix?: AcceptedPositionFix;
  trapChargesRemaining: number;
  lastTagAttemptAt?: number;
  hiddenMode?: HiddenModeRecord;
  autoTagProximityStartedAt?: number;
  autoTagLastObservedAt?: number;
  outsideBoundary: boolean;
  boundaryOutsideMs: number;
  boundaryLastObservedAt?: number;
  deviceStatus?: AcceptedDeviceStatus;
  lobbyGpsVerificationStartedAt?: number;
  lobbyGpsVerifiedAt?: number;
}

export interface TrapRecord extends Coordinate {
  id: string;
  ownerId: string;
  radiusMeters: number;
  placedAt: number;
  armedAt: number;
  expiresAt: number;
  consumedAt?: number;
  placementAccuracyMeters: number;
}

export interface ImmobilizedState {
  trapId: string;
  startedAt: number;
  dwellMs: number;
  lastObservationAt: number;
  lastQualifiedInsideAt?: number;
}

export interface GameEvent {
  id: string;
  at: number;
  type:
    | "player_joined"
    | "player_left"
    | "seeker_selected"
    | "boundary_updated"
    | "gps_check_requested"
    | "match_started"
    | "match_paused"
    | "match_resumed"
    | "player_tagged"
    | "boundary_eliminated"
    | "radar_used"
    | "trap_placed"
    | "trap_triggered"
    | "trap_released"
    | "match_finished"
    | "returned_to_lobby";
  actorId?: string;
  targetId?: string;
  /** Included on player_tagged events so diagnostics can separate proximity and manual outcomes. */
  tagMethod?: "automatic" | "manual";
  message: string;
}

export interface RoomState {
  protocolVersion: typeof PROTOCOL_VERSION;
  roomCode: string;
  version: number;
  phase: MatchPhase;
  winner: MatchWinner;
  createdAt: number;
  phaseStartedAt: number;
  matchId?: string;
  hidingEndsAt?: number;
  activeEndsAt?: number;
  pausedAt?: number;
  pausedFromPhase?: "hiding" | "active";
  hostId: string;
  players: Record<string, PlayerRecord>;
  tokens: Record<string, string>;
  processedCommandIds: string[];
  boundary: Coordinate[];
  traps: TrapRecord[];
  rules: GameRules;
  radarEndsAt?: number;
  nextRadarAt?: number;
  immobilized?: ImmobilizedState;
  events: GameEvent[];
}

export interface VisiblePlayer {
  id: string;
  name: string;
  role: PlayerRole;
  status: PlayerStatus;
  connected: boolean;
  isHost: boolean;
  gpsReady: boolean;
  gpsStatus: GpsStatus;
  gpsAgeMs?: number;
  gpsAccuracyMeters?: number;
  deviceStatus?: AcceptedDeviceStatus;
  location?: AcceptedPositionFix;
  /** Only included for an active hider viewing their own snapshot. */
  hiddenMode?: {
    hidden: boolean;
    activatesAt?: number;
    hiddenAt?: number;
  };
  /** Only included for the player viewing their own snapshot. */
  trapChargesRemaining?: number;
}

export interface VisibleTrap extends Coordinate {
  id: string;
  radiusMeters: number;
  armedAt: number;
  expiresAt: number;
  triggered: boolean;
  /** Identifies the viewer's own trap without exposing its owner to the seeker. */
  ownedBySelf: boolean;
}

export interface RoomSnapshot {
  type: "snapshot";
  protocolVersion: typeof PROTOCOL_VERSION;
  roomCode: string;
  version: number;
  serverNow: number;
  phase: MatchPhase;
  matchId?: string;
  winner: MatchWinner;
  selfId: string;
  hostId: string;
  players: VisiblePlayer[];
  boundary: Coordinate[];
  traps: VisibleTrap[];
  rules: GameRules;
  radarEndsAt?: number;
  nextRadarAt?: number;
  hidingEndsAt?: number;
  activeEndsAt?: number;
  immobilized?: ImmobilizedState;
  outsideBoundary: boolean;
  nearBoundary: boolean;
  boundaryDistanceMeters?: number;
  boundaryGraceRemainingMs?: number;
  events: GameEvent[];
}

export type GameCommand =
  | { type: "set_boundary"; boundary: Coordinate[] }
  | { type: "set_seeker"; playerId: string }
  | { type: "start_match" }
  | { type: "pause_match" }
  | { type: "resume_match" }
  | { type: "use_radar" }
  | { type: "place_trap" }
  | { type: "tag" }
  | { type: "return_to_lobby" }
  | { type: "leave_party" };

export interface CommandEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  command: GameCommand;
}

export interface LocationEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION;
  fix: PositionFix;
  deviceStatus?: DeviceStatusReport;
}

export interface ClientDiagnosticEvent {
  id: string;
  appSessionId: string;
  clientAtMs: number;
  level: DiagnosticLevel;
  category: string;
  name: string;
  matchId?: string;
  correlationId?: string;
  payload?: Record<string, unknown>;
}

export interface DiagnosticBatchEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION;
  events: ClientDiagnosticEvent[];
}

export interface StoredDiagnosticEvent extends ClientDiagnosticEvent {
  sequence: number;
  serverAtMs: number;
  source: DiagnosticSource;
  roomCode: string;
  playerId?: string;
  playerName?: string;
}

export interface DiagnosticsPage {
  roomCode: string;
  matchId?: string;
  events: StoredDiagnosticEvent[];
  nextAfter?: number;
  /** Freeze all pages of one export at this server sequence. */
  untilSequence?: number;
}

export interface ApiError {
  error: string;
  code: string;
}

export interface SessionResponse {
  roomCode: string;
  playerId: string;
  token: string;
  snapshot: RoomSnapshot;
}
