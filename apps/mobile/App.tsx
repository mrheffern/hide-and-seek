import { StatusBar as ExpoStatusBar } from "expo-status-bar";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar as NativeStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  Vibration,
} from "react-native";
import MapView, { Circle, Marker, Polygon, Polyline, type MapPressEvent } from "react-native-maps";
import type { Coordinate, GameCommand, RoomSnapshot, VisibleTrap } from "@hide-and-seek/protocol";
import { useParty } from "./src/hooks/useParty";
import { lobbyStartReadiness } from "./src/game/lobbyReadiness";
import { appendBoundaryPoint, coordinateFromMapPress } from "./src/map/boundaryDraft";
import {
  batteryStatusText,
  connectionStatusText,
  gpsStatusText,
  isGpsResumeBlocker,
  lobbyGpsStatusText,
  pausedGpsStatusPlayers,
} from "./src/game/playerHealth";
import type { ConnectionState } from "./src/reconnect";
import { recordDiagnostic } from "./src/diagnostics";

const colors = {
  ink: "#132019",
  muted: "#66736b",
  paper: "#f4f7f1",
  card: "#ffffff",
  green: "#176b45",
  greenDark: "#0b472d",
  orange: "#ee7d32",
  red: "#be3b32",
  blue: "#2774ae",
  trap: "#6b2d84",
  line: "#d8e0d8",
};

const androidStatusBarInset = Platform.OS === "android" ? NativeStatusBar.currentHeight ?? 0 : 0;

function ActionButton({
  label,
  onPress,
  disabled,
  tone = "green",
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "green" | "orange" | "plain" | "red";
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        tone === "orange" && styles.buttonOrange,
        tone === "plain" && styles.buttonPlain,
        tone === "red" && styles.buttonRed,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
      ]}
    >
      <Text style={[styles.buttonText, tone === "plain" && styles.buttonTextPlain]}>{label}</Text>
    </Pressable>
  );
}

function TrapActionButton({
  armDurationMs,
  busy,
  chargesRemaining,
  command,
  now,
  trap,
}: {
  armDurationMs: number;
  busy: boolean;
  chargesRemaining: number;
  command: (command: GameCommand) => void;
  now: number;
  trap?: VisibleTrap;
}) {
  const serverOffsetMs = useRef(now - Date.now());
  const [displayNow, setDisplayNow] = useState(now);
  useEffect(() => {
    serverOffsetMs.current = now - Date.now();
    setDisplayNow(now);
  }, [now]);
  useEffect(() => {
    if (!trap || trap.armedAt <= Date.now() + serverOffsetMs.current) return;
    const timer = setInterval(() => {
      const next = Date.now() + serverOffsetMs.current;
      setDisplayNow(next);
      if (next >= trap.armedAt) clearInterval(timer);
    }, 100);
    return () => clearInterval(timer);
  }, [trap?.armedAt, trap?.id]);

  const arming = Boolean(trap && displayNow < trap.armedAt);
  const progress = trap
    ? Math.max(0, Math.min(1, (displayNow - (trap.armedAt - armDurationMs)) / Math.max(1, armDurationMs)))
    : 0;
  const remainingSeconds = trap ? Math.max(0, Math.ceil((trap.armedAt - displayNow) / 100) / 10) : 0;
  const canPlace = !busy && !trap && chargesRemaining > 0;
  const label = busy && !trap
    ? "Placing bear trap…"
    : arming
      ? `Arming bear trap · ${remainingSeconds.toFixed(1)}s`
      : trap
        ? `Bear trap armed · ${Math.round(trap.radiusMeters * 3.28084)} ft`
        : chargesRemaining > 0
          ? "Lay bear trap"
          : "Bear trap used";

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: !canPlace }}
      accessibilityValue={arming ? { min: 0, max: 100, now: Math.round(progress * 100) } : undefined}
      disabled={!canPlace}
      onPress={() => command({ type: "place_trap" })}
      style={({ pressed }) => [
        styles.trapActionButton,
        !canPlace && !trap && styles.buttonDisabled,
        pressed && canPlace && styles.buttonPressed,
      ]}
    >
      <View
        pointerEvents="none"
        style={[styles.trapButtonProgress, { width: `${Math.round(progress * 100)}%` }]}
      />
      <Text style={styles.trapButtonText}>{label}</Text>
    </Pressable>
  );
}

function TrapMapOverlay({ trap, now }: { trap: VisibleTrap; now: number }) {
  const arming = !trap.triggered && now < trap.armedAt;
  const color = trap.triggered ? colors.red : colors.trap;
  const label = trap.triggered
    ? "TRAPPED"
    : arming
      ? `ARMING ${Math.max(1, Math.ceil((trap.armedAt - now) / 1_000))}s`
      : "BEAR TRAP";
  return (
    <Fragment key={trap.id}>
      <Circle
        center={trap}
        fillColor={trap.triggered ? "rgba(190,59,50,0.20)" : "rgba(107,45,132,0.18)"}
        radius={trap.radiusMeters}
        strokeColor={color}
        strokeWidth={5}
      />
      <Circle
        center={trap}
        fillColor="rgba(0,0,0,0)"
        radius={Math.max(1, trap.radiusMeters * 0.7)}
        strokeColor={trap.triggered ? "rgba(190,59,50,0.75)" : "rgba(107,45,132,0.75)"}
        strokeWidth={2}
      />
      <Marker
        anchor={{ x: 0.5, y: 0.5 }}
        coordinate={trap}
        key={`${trap.id}-${label}`}
        tracksViewChanges={arming}
        zIndex={5}
      >
        <View style={[styles.trapMapBadge, trap.triggered && styles.trapMapBadgeTriggered]}>
          <Text style={styles.trapMapGlyph}>{trap.triggered ? "!" : "×"}</Text>
          <Text style={styles.trapMapLabel}>{label}</Text>
        </View>
      </Marker>
    </Fragment>
  );
}

function Welcome({
  busy,
  status,
  onCreate,
  onJoin,
}: {
  busy: boolean;
  status: string;
  onCreate: (name: string) => void;
  onJoin: (code: string, name: string) => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const canCreate = !busy && Boolean(name.trim());
  const canJoin = canCreate && code.length === 6;
  const submitJoin = () => {
    if (!canJoin) return;
    Keyboard.dismiss();
    onJoin(code, name);
  };
  return (
    <SafeAreaView style={styles.welcome}>
      <ExpoStatusBar style="dark" />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.welcomeKeyboard}
      >
        <ScrollView
          contentContainerStyle={styles.welcomeContent}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.brandMark}>
            <View style={styles.brandDot} />
          </View>
          <Text style={styles.eyebrow}>REAL-WORLD GPS GAME</Text>
          <Text style={styles.title}>Out of Sight</Text>
          <Text style={styles.subtitle}>
            Draw the field, choose a seeker, then take hide-and-seek outside.
          </Text>
          <View style={styles.welcomeCard}>
            <Text style={styles.label}>Your name</Text>
            <TextInput
              autoCapitalize="words"
              maxLength={24}
              onChangeText={setName}
              placeholder="Alex"
              placeholderTextColor="#95a099"
              style={styles.input}
              value={name}
            />
            <ActionButton
              disabled={!canCreate}
              label="Create a party"
              onPress={() => {
                Keyboard.dismiss();
                onCreate(name);
              }}
            />
            <View style={styles.orRow}>
              <View style={styles.orLine} />
              <Text style={styles.orText}>or join one</Text>
              <View style={styles.orLine} />
            </View>
            <Text style={styles.label}>Six-character party code</Text>
            <TextInput
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={6}
              onChangeText={(value) => setCode(value.replace(/[^a-zA-Z2-9]/g, "").toUpperCase())}
              onSubmitEditing={submitJoin}
              placeholder="ABC234"
              placeholderTextColor="#95a099"
              returnKeyType="done"
              style={[styles.input, styles.codeInput]}
              value={code}
            />
            <ActionButton
              disabled={!canJoin}
              label={busy ? "Joining…" : "Join party"}
              onPress={submitJoin}
              tone="plain"
            />
          </View>
          {busy ? <ActivityIndicator color={colors.green} /> : null}
          {status ? <Text style={styles.statusText}>{status}</Text> : null}
          <Text style={styles.privacyNote}>
            Location is collected while verifying lobby readiness and during a match.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function formatRemaining(target: number | undefined, now: number): string {
  if (!target) return "";
  const seconds = Math.max(0, Math.ceil((target - now) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function phaseLabel(snapshot: RoomSnapshot, now: number): string {
  if (snapshot.phase === "hiding") return `Hide · ${formatRemaining(snapshot.hidingEndsAt, now)}`;
  if (snapshot.phase === "active") return `In play · ${formatRemaining(snapshot.activeEndsAt, now)}`;
  if (snapshot.phase === "finished") return `${snapshot.winner === "seeker" ? "Seeker" : "Hiders"} win`;
  return snapshot.phase[0].toUpperCase() + snapshot.phase.slice(1);
}

function markerColor(role: "seeker" | "hider", isSelf: boolean): string {
  if (isSelf) return colors.orange;
  return role === "seeker" ? colors.red : colors.blue;
}

function connectionLabel(state: ConnectionState): string {
  if (state === "live") return "Live";
  if (state === "retrying") return "Reconnecting";
  if (state === "connecting") return "Connecting";
  return "Offline";
}

function GameMap({
  snapshot,
  drawing,
  draft,
  now,
  onMapPress,
}: {
  snapshot: RoomSnapshot;
  drawing: boolean;
  draft: Coordinate[];
  now: number;
  onMapPress: (event: MapPressEvent) => void;
}) {
  const mapRef = useRef<MapView | null>(null);
  const centeredOnPlayer = useRef(false);
  const self = snapshot.players.find((player) => player.id === snapshot.selfId);
  const viewer = self;
  const center = self?.location ?? snapshot.players.find((player) => player.location)?.location;
  const boundary = drawing ? draft : snapshot.boundary;
  const radarRevealActive = Boolean(
    viewer?.role === "seeker" && snapshot.radarEndsAt && snapshot.radarEndsAt > now,
  );
  const visiblePlayers = snapshot.players.filter((player) => {
    if (!player.location) return false;
    return !(viewer?.role === "seeker"
      && player.role === "hider"
      && player.id !== snapshot.selfId
      && !radarRevealActive);
  });
  const previousRadarReveal = useRef(radarRevealActive);
  const [nativeOverlayEpoch, setNativeOverlayEpoch] = useState(0);
  useEffect(() => {
    if (!center || centeredOnPlayer.current) return;
    centeredOnPlayer.current = true;
    mapRef.current?.animateToRegion(
      {
        latitude: center.latitude,
        longitude: center.longitude,
        latitudeDelta: 0.008,
        longitudeDelta: 0.008,
      },
      400,
    );
  }, [center]);
  useEffect(() => {
    if (previousRadarReveal.current && !radarRevealActive) {
      // Android can retain removed native Circle overlays. Remount the native map once
      // when radar closes so hidden-player markers and accuracy circles are both purged.
      setNativeOverlayEpoch((value) => value + 1);
    }
    previousRadarReveal.current = radarRevealActive;
  }, [radarRevealActive]);
  return (
    <MapView
      initialRegion={{
        latitude: center?.latitude ?? 34.0522,
        longitude: center?.longitude ?? -118.2437,
        latitudeDelta: 0.008,
        longitudeDelta: 0.008,
      }}
      key={`game-map-${nativeOverlayEpoch}`}
      mapType="satellite"
      onPress={onMapPress}
      pitchEnabled={false}
      ref={mapRef}
      rotateEnabled={false}
      showsCompass={false}
      showsUserLocation={false}
      style={styles.map}
    >
      {boundary.length >= 3 ? (
        <Polygon
          coordinates={boundary}
          fillColor="rgba(23,107,69,0.12)"
          strokeColor={colors.green}
          strokeWidth={3}
        />
      ) : boundary.length >= 2 ? (
        <Polyline coordinates={boundary} strokeColor={colors.green} strokeWidth={3} />
      ) : null}
      {drawing
        ? draft.map((point, index) => (
            <Marker coordinate={point} key={`draft-${index}`} pinColor={colors.green} title={`Point ${index + 1}`} />
          ))
        : null}
      {visiblePlayers.map((player) => {
        const color = markerColor(player.role, player.id === snapshot.selfId);
        return (
          <Circle
            center={player.location!}
            fillColor={player.id === snapshot.selfId ? "rgba(238,125,50,0.14)" : "rgba(39,116,174,0.12)"}
            key={`accuracy-${player.id}`}
            radius={Math.max(1, player.location!.accuracyMeters)}
            strokeColor={color}
            strokeWidth={1}
          />
        );
      })}
      {visiblePlayers.map((player) => (
          <Marker
            coordinate={player.location!}
            description={gpsStatusText(player, snapshot.serverNow, now)}
            key={player.id}
            pinColor={markerColor(player.role, player.id === snapshot.selfId)}
            title={player.id === snapshot.selfId ? `${player.name} · You` : player.name}
          />
      ))}
      {snapshot.traps.map((trap) => <TrapMapOverlay key={trap.id} now={now} trap={trap} />)}
    </MapView>
  );
}

function PartyPanel({
  snapshot,
  busy,
  command,
  now,
}: {
  snapshot: RoomSnapshot;
  busy: boolean;
  command: (command: GameCommand) => void;
  now: number;
}) {
  const self = snapshot.players.find((player) => player.id === snapshot.selfId)!;
  const ownTrap = snapshot.traps.find((trap) => trap.ownedBySelf);
  const isHost = snapshot.hostId === snapshot.selfId;
  if (snapshot.phase === "lobby") {
    const startReadiness = lobbyStartReadiness(snapshot);
    return (
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Players · {snapshot.players.length}/7</Text>
        {snapshot.players.map((player) => (
          <View key={player.id} style={styles.playerRow}>
            <View style={[styles.roleDot, { backgroundColor: markerColor(player.role, player.id === snapshot.selfId) }]} />
            <View style={styles.playerCopy}>
              <Text style={styles.playerName}>{player.name}{player.id === snapshot.selfId ? " · You" : ""}</Text>
              <Text style={styles.playerMeta}>{player.role}{player.isHost ? " · Host" : ""} · {lobbyGpsStatusText(player, snapshot.serverNow, now)}</Text>
              <Text style={styles.playerHealth}>
                {connectionStatusText(player, now)}
                {batteryStatusText(player, now) ? ` · ${batteryStatusText(player, now)}` : ""}
              </Text>
            </View>
            {isHost && player.role !== "seeker" ? (
              <Pressable disabled={busy} onPress={() => command({ type: "set_seeker", playerId: player.id })}>
                <Text style={styles.link}>Make seeker</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
        {isHost ? (
          <>
            <ActionButton
              disabled={busy || !startReadiness.canStart}
              label="Start hiding countdown"
              onPress={() => command({ type: "start_match" })}
            />
            <Text style={[styles.helper, startReadiness.canStart && styles.readyText]}>
              {startReadiness.message}
            </Text>
          </>
        ) : (
          <Text style={styles.helper}>The host will draw the boundary and start the match.</Text>
        )}
      </View>
    );
  }
  const gpsBlockers = snapshot.players.filter(isGpsResumeBlocker);
  const pausedPlayers = pausedGpsStatusPlayers(snapshot.players, snapshot.selfId);
  const hiddenMode = self.role === "hider" ? self.hiddenMode : undefined;
  const hiddenCountdown = hiddenMode?.activatesAt === undefined
    ? undefined
    : Math.max(0, Math.ceil((hiddenMode.activatesAt - now) / 1_000));
  return (
    <View style={styles.panel}>
      {snapshot.phase === "paused" ? (
        <View style={styles.pausedBanner}>
          <Text style={styles.pausedTitle}>MATCH PAUSED</Text>
          <Text style={styles.pausedText}>
            {gpsBlockers.length
              ? `Waiting for ${gpsBlockers.length} ${gpsBlockers.length === 1 ? "player's" : "players'"} GPS to return.`
              : isHost
                ? "Everyone has live GPS. You can resume the match."
                : "Everyone has live GPS. Waiting for the host to resume."}
          </Text>
          <Text style={styles.pausedSectionLabel}>GPS STATUS</Text>
          <View style={styles.pausedRoster}>
            {pausedPlayers.map((player) => {
              const blocking = isGpsResumeBlocker(player);
              const battery = batteryStatusText(player, now);
              return (
                <View key={player.id} style={styles.pausedPlayerRow}>
                  <View style={styles.pausedPlayerHeader}>
                    <Text style={styles.pausedPlayerName}>
                      {player.name}{player.id === snapshot.selfId ? " · You" : ""}
                    </Text>
                    <Text style={[styles.pausedPlayerBadge, !blocking && styles.pausedPlayerBadgeReady]}>
                      {blocking ? "NEEDS GPS" : "READY"}
                    </Text>
                  </View>
                  <Text style={styles.pausedPlayerGps}>{gpsStatusText(player, snapshot.serverNow, now)}</Text>
                  <Text style={styles.pausedPlayerHealth}>
                    {connectionStatusText(player, now)}{battery ? ` · ${battery}` : ""}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
      ) : null}
      <View style={styles.liveRow}>
        <View>
          <Text style={styles.panelTitle}>{self.role === "seeker" ? "You are seeking" : "Stay hidden"}</Text>
          <Text style={styles.helper}>{snapshot.players.filter((player) => player.role === "hider" && player.status === "active").length} hiders remain</Text>
        </View>
        {snapshot.immobilized ? (
          <View style={styles.trappedBadge}><Text style={styles.trappedText}>TRAPPED</Text></View>
        ) : hiddenMode?.hidden ? (
          <View style={styles.hiddenBadge}><Text style={styles.hiddenBadgeText}>HIDDEN</Text></View>
        ) : null}
      </View>
      {(snapshot.phase === "hiding" || snapshot.phase === "active") && self.status === "active" ? (
        self.role === "hider" ? (
          <Text style={[styles.hiddenModeNotice, hiddenMode?.hidden && styles.hiddenModeNoticeActive]}>
            {hiddenMode?.hidden
              ? `Hidden · auto-tag blocked until sustained movement or ${snapshot.rules.hiddenModeExitDistanceMeters}m of reliable movement`
              : hiddenCountdown !== undefined
                ? `Hold still · Hidden Mode in ${hiddenCountdown}s`
                : "Auto-tag active · hold still to enter Hidden Mode"}
          </Text>
        ) : snapshot.phase === "active" ? (
          <Text style={styles.hiddenModeNotice}>
            Auto-tag is active. Use TAG when you physically find a stationary hidden player.
          </Text>
        ) : null
      ) : null}
      {snapshot.phase === "active" && self.status === "active" ? (
        <View style={styles.actionRow}>
          {self.role === "seeker" ? (
            <>
              <ActionButton disabled={busy || Boolean(snapshot.immobilized)} label="TAG" onPress={() => command({ type: "tag" })} tone="orange" />
              <ActionButton disabled={busy || Boolean(snapshot.immobilized)} label="Radar" onPress={() => command({ type: "use_radar" })} tone="plain" />
            </>
          ) : (
            <TrapActionButton
              armDurationMs={snapshot.rules.trapArmMs}
              busy={busy}
              chargesRemaining={self.trapChargesRemaining ?? 0}
              command={command}
              now={now}
              trap={ownTrap}
            />
          )}
        </View>
      ) : null}
      {snapshot.outsideBoundary ? (
        <Text style={styles.boundaryWarning}>
          Outside boundary · return within {Math.ceil((snapshot.boundaryGraceRemainingMs ?? 0) / 1_000)} seconds
        </Text>
      ) : snapshot.nearBoundary ? (
        <Text style={styles.boundaryNearby}>
          Boundary nearby · about {Math.max(0, Math.round(snapshot.boundaryDistanceMeters ?? 0))}m to the edge
        </Text>
      ) : null}
      {snapshot.immobilized ? (
        <Text style={styles.helper}>
          Stay inside the trap: {Math.ceil((snapshot.rules.trapDwellMs - snapshot.immobilized.dwellMs) / 1_000)} seconds observed dwell remaining.
        </Text>
      ) : null}
      {snapshot.events.slice(-3).reverse().map((event) => (
        <Text key={event.id} style={styles.eventText}>{event.message}</Text>
      ))}
    </View>
  );
}

function Game({
  snapshot,
  status,
  connectionState,
  busy,
  command,
  leave,
  exportDiagnostics,
  exportingDiagnostics,
}: {
  snapshot: RoomSnapshot;
  status: string;
  connectionState: ConnectionState;
  busy: boolean;
  command: (command: GameCommand) => void;
  leave: () => void;
  exportDiagnostics: () => void;
  exportingDiagnostics: boolean;
}) {
  const serverOffsetMs = useRef(snapshot.serverNow - Date.now());
  const [now, setNow] = useState(snapshot.serverNow);
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<Coordinate[]>([]);
  const [boundaryFeedback, setBoundaryFeedback] = useState("");
  const previousBoundaryAlert = useRef<"near" | "outside" | undefined>(undefined);
  const isHost = snapshot.hostId === snapshot.selfId;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + serverOffsetMs.current), 1_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    serverOffsetMs.current = snapshot.serverNow - Date.now();
    setNow(snapshot.serverNow);
  }, [snapshot.serverNow]);
  useEffect(() => {
    const next = snapshot.outsideBoundary ? "outside" : snapshot.nearBoundary ? "near" : undefined;
    if (next && next !== previousBoundaryAlert.current) {
      Vibration.vibrate(next === "outside" ? [0, 300, 150, 300] : 250);
    }
    previousBoundaryAlert.current = next;
  }, [snapshot.nearBoundary, snapshot.outsideBoundary]);
  const onMapPress = (event: MapPressEvent) => {
    if (drawing && isHost && snapshot.phase === "lobby") {
      const coordinate = coordinateFromMapPress(event);
      if (!coordinate) {
        console.warn("[boundary] Ignored a map press without a valid coordinate.", {
          nativeEventPresent: Boolean(event?.nativeEvent),
        });
        setBoundaryFeedback("That corner could not be placed. Tap the map again.");
        return;
      }
      setBoundaryFeedback("");
      recordDiagnostic({ category: "interaction", name: "boundary_corner_placed", payload: { coordinate, pointIndex: draft.length } });
      setDraft((current) => appendBoundaryPoint(current, coordinate));
    }
  };
  const radarText = useMemo(() => {
    if (!snapshot.radarEndsAt || snapshot.radarEndsAt <= now) return null;
    return `RADAR · ${Math.ceil((snapshot.radarEndsAt - now) / 1_000)}s`;
  }, [snapshot.radarEndsAt, now]);
  const visibleStatus = status === "Radar active." && !radarText ? "" : status;
  return (
    <SafeAreaView style={styles.game}>
      <ExpoStatusBar style="dark" />
      <View style={styles.gameHeader}>
        <View>
          <Text style={styles.roomCode}>PARTY {snapshot.roomCode}</Text>
          <Text style={styles.phase}>{phaseLabel(snapshot, now)}</Text>
        </View>
        <View style={styles.headerActions}>
          <View style={[styles.connectionBadge, connectionState === "live" && styles.connectionBadgeLive]}>
            <Text style={[styles.connectionBadgeText, connectionState === "live" && styles.connectionBadgeTextLive]}>
              {connectionLabel(connectionState)}
            </Text>
          </View>
          {radarText ? <Text style={styles.radarBadge}>{radarText}</Text> : null}
          <Pressable accessibilityRole="button" hitSlop={12} onPress={leave} style={styles.leaveButton}>
            <Text style={styles.leaveText}>Leave</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.mapFrame}>
        <GameMap snapshot={snapshot} drawing={drawing} draft={draft} now={now} onMapPress={onMapPress} />
        {snapshot.phase === "lobby" ? (
          <View
            accessibilityLabel={`Join code ${snapshot.roomCode}`}
            pointerEvents="none"
            style={styles.joinCodeCard}
          >
            <Text style={styles.joinCodeLabel}>JOIN CODE</Text>
            <Text style={styles.joinCodeValue}>{snapshot.roomCode}</Text>
            <Text style={styles.joinCodeHelper}>Share this code with the other players</Text>
          </View>
        ) : null}
        {isHost && snapshot.phase === "lobby" ? (
          <View style={styles.mapTools}>
            {!drawing ? (
              <ActionButton label={snapshot.boundary.length ? "Redraw boundary" : "Draw boundary"} onPress={() => { recordDiagnostic({ category: "interaction", name: "boundary_drawing_started", payload: { existingPoints: snapshot.boundary.length } }); setDraft([]); setBoundaryFeedback(""); setDrawing(true); }} tone="plain" />
            ) : (
              <>
                <Text style={styles.toolHint}>Tap map corners · {draft.length} points</Text>
                {boundaryFeedback ? <Text style={styles.toolError}>{boundaryFeedback}</Text> : null}
                <View style={styles.toolRow}>
                  <ActionButton disabled={!draft.length} label="Undo" onPress={() => { recordDiagnostic({ category: "interaction", name: "boundary_corner_removed", payload: { pointCount: draft.length } }); setBoundaryFeedback(""); setDraft((value) => value.slice(0, -1)); }} tone="plain" />
                  <ActionButton
                    disabled={draft.length < 3 || busy}
                    label="Save"
                    onPress={() => {
                      recordDiagnostic({ category: "interaction", name: "boundary_save_pressed", payload: { boundary: draft } });
                      command({ type: "set_boundary", boundary: draft });
                      setDrawing(false);
                    }}
                  />
                </View>
              </>
            )}
          </View>
        ) : null}
      </View>
      <ScrollView contentContainerStyle={styles.panelScroll}>
        <PartyPanel snapshot={snapshot} busy={busy} command={command} now={now} />
        {isHost && (snapshot.phase === "hiding" || snapshot.phase === "active") ? (
          <ActionButton label="Pause match" onPress={() => command({ type: "pause_match" })} tone="plain" />
        ) : null}
        {isHost && snapshot.phase === "paused" ? (
          <ActionButton label="Resume match" onPress={() => command({ type: "resume_match" })} />
        ) : null}
        {isHost ? (
          <ActionButton
            disabled={exportingDiagnostics}
            label={exportingDiagnostics ? "Preparing diagnostics…" : snapshot.matchId ? "Export match diagnostics" : "Export party diagnostics"}
            onPress={exportDiagnostics}
            tone="plain"
          />
        ) : null}
        {visibleStatus ? <Text style={styles.connectionText}>{visibleStatus}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function GameOver({
  snapshot,
  status,
  busy,
  command,
  leave,
  exportDiagnostics,
  exportingDiagnostics,
}: {
  snapshot: RoomSnapshot;
  status: string;
  busy: boolean;
  command: (command: GameCommand) => void;
  leave: () => void;
  exportDiagnostics: () => void;
  exportingDiagnostics: boolean;
}) {
  const isHost = snapshot.hostId === snapshot.selfId;
  const winner = snapshot.winner === "seeker" ? "Seeker wins" : "Hiders win";
  const result = [...snapshot.events].reverse().find((event) => event.type === "match_finished")?.message;
  return (
    <SafeAreaView style={styles.gameOver}>
      <ExpoStatusBar style="dark" />
      <View style={styles.gameOverCard}>
        <View style={styles.gameOverMark}><View style={styles.gameOverDot} /></View>
        <Text style={styles.gameOverEyebrow}>GAME OVER</Text>
        <Text style={styles.gameOverTitle}>{winner}</Text>
        {result ? <Text style={styles.gameOverResult}>{result}</Text> : null}
        {isHost ? (
          <>
            <ActionButton
              disabled={exportingDiagnostics}
              label={exportingDiagnostics ? "Preparing diagnostics…" : "Export match diagnostics"}
              onPress={exportDiagnostics}
              tone="plain"
            />
            <ActionButton
              disabled={busy}
              label="Return to lobby"
              onPress={() => command({ type: "return_to_lobby" })}
            />
          </>
        ) : (
          <Text style={styles.gameOverWaiting}>Waiting for the host to return the party to the lobby.</Text>
        )}
        <ActionButton disabled={busy} label="Leave party" onPress={leave} tone="plain" />
        {status ? <Text style={styles.connectionText}>{status}</Text> : null}
      </View>
    </SafeAreaView>
  );
}

export default function App() {
  const party = useParty();
  if (!party.session) {
    return <Welcome busy={party.busy} status={party.status} onCreate={party.create} onJoin={party.join} />;
  }
  if (!party.snapshot) {
    return (
      <SafeAreaView style={styles.loading}>
        <ExpoStatusBar style="dark" />
        {party.busy ? <ActivityIndicator color={colors.green} /> : null}
        <Text style={styles.recoveryTitle}>Connecting to party</Text>
        <Text style={styles.statusText}>{party.status || "Waiting for the party server…"}</Text>
        <View style={styles.recoveryActions}>
          <ActionButton
            disabled={party.busy}
            label="Try again"
            onPress={() => void party.retryConnection()}
          />
          <ActionButton
            disabled={party.busy}
            label="Forget saved party"
            onPress={() => void party.forgetParty()}
            tone="plain"
          />
        </View>
      </SafeAreaView>
    );
  }
  if (party.snapshot.phase === "finished") {
    return (
      <GameOver
        busy={party.busy}
        command={(command) => void party.command(command)}
        exportDiagnostics={() => void party.exportDiagnostics()}
        exportingDiagnostics={party.exportingDiagnostics}
        leave={() => void party.leave()}
        snapshot={party.snapshot}
        status={party.status}
      />
    );
  }
  return (
    <Game
      busy={party.busy}
      command={(command) => void party.command(command)}
      connectionState={party.connectionState}
      exportDiagnostics={() => void party.exportDiagnostics()}
      exportingDiagnostics={party.exportingDiagnostics}
      leave={() => void party.leave()}
      snapshot={party.snapshot}
      status={party.status}
    />
  );
}

const styles = StyleSheet.create({
  welcome: { flex: 1, backgroundColor: colors.paper, paddingTop: androidStatusBarInset },
  welcomeKeyboard: { flex: 1 },
  welcomeContent: { flexGrow: 1, paddingHorizontal: 24, paddingVertical: 32, justifyContent: "center" },
  brandMark: { width: 58, height: 58, borderRadius: 18, backgroundColor: colors.green, justifyContent: "center", alignItems: "center", marginBottom: 18 },
  brandDot: { width: 18, height: 18, borderRadius: 9, backgroundColor: colors.orange, borderWidth: 4, borderColor: "#fff" },
  eyebrow: { color: colors.green, fontWeight: "800", letterSpacing: 1.8, fontSize: 12 },
  title: { color: colors.ink, fontWeight: "900", fontSize: 42, letterSpacing: -1.5, marginTop: 6 },
  subtitle: { color: colors.muted, fontSize: 17, lineHeight: 24, marginTop: 8, marginBottom: 24, maxWidth: 420 },
  welcomeCard: { backgroundColor: colors.card, borderRadius: 22, padding: 20, borderWidth: 1, borderColor: colors.line, gap: 10 },
  label: { color: colors.ink, fontWeight: "700", fontSize: 13 },
  input: { minHeight: 50, borderWidth: 1, borderColor: colors.line, borderRadius: 13, paddingHorizontal: 14, fontSize: 17, color: colors.ink, backgroundColor: "#fbfcfa" },
  codeInput: { letterSpacing: 5, fontWeight: "800", textAlign: "center" },
  button: { minHeight: 48, borderRadius: 13, backgroundColor: colors.green, justifyContent: "center", alignItems: "center", paddingHorizontal: 16, flexGrow: 1 },
  buttonOrange: { backgroundColor: colors.orange },
  buttonRed: { backgroundColor: colors.red },
  buttonPlain: { backgroundColor: "#edf2ed", borderWidth: 1, borderColor: colors.line },
  buttonDisabled: { opacity: 0.42 },
  buttonPressed: { transform: [{ scale: 0.985 }], opacity: 0.9 },
  buttonText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  buttonTextPlain: { color: colors.greenDark },
  trapActionButton: { minHeight: 48, borderRadius: 13, borderWidth: 2, borderColor: colors.orange, backgroundColor: "#fff3e9", justifyContent: "center", alignItems: "center", flexGrow: 1, overflow: "hidden" },
  trapButtonProgress: { position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: "rgba(238,125,50,0.42)" },
  trapButtonText: { color: colors.ink, fontWeight: "900", fontSize: 15, paddingHorizontal: 16, textAlign: "center" },
  orRow: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 4 },
  orLine: { height: 1, flex: 1, backgroundColor: colors.line },
  orText: { color: colors.muted, fontSize: 12 },
  statusText: { color: colors.muted, textAlign: "center", marginTop: 14 },
  privacyNote: { color: colors.muted, textAlign: "center", fontSize: 12, marginTop: 18 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.paper, paddingTop: androidStatusBarInset },
  recoveryTitle: { color: colors.ink, fontWeight: "900", fontSize: 24, marginTop: 16 },
  recoveryActions: { width: "100%", maxWidth: 320, paddingHorizontal: 20, marginTop: 22, gap: 10 },
  game: { flex: 1, backgroundColor: colors.paper, paddingTop: androidStatusBarInset },
  gameHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 18, paddingVertical: 12, backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.line },
  roomCode: { color: colors.green, fontSize: 11, fontWeight: "800", letterSpacing: 1.5 },
  phase: { color: colors.ink, fontSize: 22, fontWeight: "900", marginTop: 2 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 12 },
  connectionBadge: { backgroundColor: "#f3e7d9", borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5 },
  connectionBadgeLive: { backgroundColor: "#e3f2e8" },
  connectionBadgeText: { color: colors.orange, fontSize: 10, fontWeight: "900", textTransform: "uppercase" },
  connectionBadgeTextLive: { color: colors.green },
  radarBadge: { backgroundColor: colors.red, color: "#fff", paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8, overflow: "hidden", fontSize: 11, fontWeight: "900" },
  leaveText: { color: colors.red, fontWeight: "700" },
  leaveButton: { minWidth: 64, minHeight: 48, alignItems: "center", justifyContent: "center" },
  mapFrame: { height: "49%", minHeight: 310, position: "relative" },
  map: { flex: 1 },
  trapMapBadge: { minWidth: 72, minHeight: 38, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, borderWidth: 3, borderColor: "#fff", backgroundColor: colors.trap, alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 3, shadowOffset: { width: 0, height: 2 }, elevation: 6 },
  trapMapBadgeTriggered: { backgroundColor: colors.red },
  trapMapGlyph: { color: "#fff", fontSize: 18, fontWeight: "900", lineHeight: 18 },
  trapMapLabel: { color: "#fff", fontSize: 8, fontWeight: "900", letterSpacing: 0.7 },
  joinCodeCard: { position: "absolute", top: 12, left: 60, right: 60, zIndex: 2, elevation: 4, alignItems: "center", backgroundColor: "rgba(255,255,255,0.96)", borderRadius: 16, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 18, paddingVertical: 9 },
  joinCodeLabel: { color: colors.green, fontSize: 10, fontWeight: "900", letterSpacing: 1.8 },
  joinCodeValue: { color: colors.ink, fontSize: 25, fontWeight: "900", letterSpacing: 5, marginTop: 1 },
  joinCodeHelper: { color: colors.muted, fontSize: 10, marginTop: 1 },
  mapTools: { position: "absolute", left: 12, right: 12, bottom: 12, backgroundColor: "rgba(255,255,255,0.96)", padding: 10, borderRadius: 16, borderWidth: 1, borderColor: colors.line },
  toolHint: { color: colors.ink, fontWeight: "700", textAlign: "center", marginBottom: 8 },
  toolError: { color: colors.red, fontWeight: "700", textAlign: "center", marginBottom: 8 },
  toolRow: { flexDirection: "row", gap: 8 },
  panelScroll: { padding: 12, paddingBottom: 36, gap: 10 },
  panel: { backgroundColor: colors.card, borderRadius: 18, padding: 16, borderWidth: 1, borderColor: colors.line, gap: 10 },
  panelTitle: { fontSize: 18, fontWeight: "900", color: colors.ink },
  playerRow: { flexDirection: "row", alignItems: "center", minHeight: 48, gap: 10, borderTopWidth: 1, borderTopColor: colors.line },
  roleDot: { width: 10, height: 10, borderRadius: 5 },
  playerCopy: { flex: 1 },
  playerName: { color: colors.ink, fontWeight: "700" },
  playerMeta: { color: colors.muted, fontSize: 12, marginTop: 2, textTransform: "capitalize" },
  playerHealth: { color: colors.muted, fontSize: 11, marginTop: 2 },
  link: { color: colors.green, fontWeight: "800", fontSize: 12 },
  helper: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  readyText: { color: colors.green, fontWeight: "700" },
  liveRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  pausedBanner: { backgroundColor: "#fff5e8", borderRadius: 12, borderWidth: 1, borderColor: "#f0d2aa", padding: 12 },
  pausedTitle: { color: colors.orange, fontSize: 12, fontWeight: "900", letterSpacing: 1.2 },
  pausedText: { color: colors.ink, fontSize: 13, marginTop: 3 },
  pausedSectionLabel: { color: colors.muted, fontSize: 10, fontWeight: "900", letterSpacing: 1.1, marginTop: 12 },
  pausedRoster: { gap: 8, marginTop: 7 },
  pausedPlayerRow: { backgroundColor: colors.card, borderRadius: 10, borderWidth: 1, borderColor: colors.line, padding: 10 },
  pausedPlayerHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  pausedPlayerName: { color: colors.ink, fontSize: 13, fontWeight: "800", flex: 1 },
  pausedPlayerBadge: { backgroundColor: "#fff0ee", color: colors.red, borderRadius: 6, overflow: "hidden", paddingHorizontal: 7, paddingVertical: 4, fontSize: 9, fontWeight: "900", letterSpacing: 0.6 },
  pausedPlayerBadgeReady: { backgroundColor: "#e3f2e8", color: colors.green },
  pausedPlayerGps: { color: colors.ink, fontSize: 12, fontWeight: "700", marginTop: 5 },
  pausedPlayerHealth: { color: colors.muted, fontSize: 11, marginTop: 2 },
  trappedBadge: { backgroundColor: colors.red, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 6 },
  trappedText: { color: "#fff", fontSize: 12, fontWeight: "900", letterSpacing: 1 },
  hiddenBadge: { backgroundColor: colors.green, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 6 },
  hiddenBadgeText: { color: "#fff", fontSize: 12, fontWeight: "900", letterSpacing: 1 },
  hiddenModeNotice: { color: colors.ink, backgroundColor: "#fff5e8", borderRadius: 10, padding: 10, fontSize: 12, fontWeight: "700", textAlign: "center" },
  hiddenModeNoticeActive: { color: colors.greenDark, backgroundColor: "#e3f2e8" },
  actionRow: { flexDirection: "row", gap: 10 },
  eventText: { color: colors.ink, fontSize: 13, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8 },
  boundaryWarning: { color: colors.red, backgroundColor: "#fff0ee", borderRadius: 10, padding: 10, fontWeight: "800", textAlign: "center" },
  boundaryNearby: { color: colors.ink, backgroundColor: "#fff5e8", borderRadius: 10, padding: 10, fontWeight: "800", textAlign: "center" },
  connectionText: { color: colors.muted, textAlign: "center", fontSize: 12, marginVertical: 4 },
  gameOver: { flex: 1, backgroundColor: colors.paper, paddingTop: androidStatusBarInset + 24, paddingHorizontal: 24, paddingBottom: 24, justifyContent: "center" },
  gameOverCard: { backgroundColor: colors.card, borderRadius: 26, borderWidth: 1, borderColor: colors.line, padding: 28, alignItems: "stretch", gap: 16 },
  gameOverMark: { width: 72, height: 72, alignSelf: "center", borderRadius: 24, backgroundColor: colors.green, justifyContent: "center", alignItems: "center" },
  gameOverDot: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.orange, borderWidth: 5, borderColor: "#fff" },
  gameOverEyebrow: { color: colors.green, fontWeight: "900", letterSpacing: 2, fontSize: 12, textAlign: "center", marginTop: 4 },
  gameOverTitle: { color: colors.ink, fontWeight: "900", fontSize: 38, letterSpacing: -1, textAlign: "center" },
  gameOverResult: { color: colors.muted, fontSize: 16, lineHeight: 23, textAlign: "center", marginBottom: 4 },
  gameOverWaiting: { color: colors.muted, fontSize: 14, lineHeight: 20, textAlign: "center", paddingVertical: 8 },
});
