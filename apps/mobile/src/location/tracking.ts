import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import type { RoomSnapshot } from "@hide-and-seek/protocol";
import { LOCATION_TASK_NAME, resetLocationNotificationState } from "./backgroundLocation";
import { recordDiagnostic, recordDiagnosticError } from "../diagnostics";
import { uploadLocation } from "../api";
import { readDeviceStatus } from "../deviceStatus";
import type { StoredSession } from "../session";

export interface TrackingReadiness {
  ready: boolean;
  message: string;
}

export interface LobbyLocationReadiness extends TrackingReadiness {
  snapshot?: RoomSnapshot;
}

let trackingQueue: Promise<unknown> = Promise.resolve();
let trackingRevision = 0;
let pendingStart: { revision: number; promise: Promise<TrackingReadiness> } | undefined;
let lobbySequence = 0;
const lobbyRuntimeId = `lobby-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
let lobbyTrackingRevision = 0;
let activeLobbyRefresh: {
  key: string;
  revision: number;
  promise: Promise<LobbyLocationReadiness>;
  cancel: () => void;
} | undefined;

function serializeTracking<T>(operation: () => Promise<T>): Promise<T> {
  const result = trackingQueue.then(operation, operation);
  trackingQueue = result.catch(() => undefined);
  return result;
}

export function startMatchTracking(): Promise<TrackingReadiness> {
  if (pendingStart?.revision === trackingRevision) return pendingStart.promise;
  const revision = ++trackingRevision;
  const promise = serializeTracking(() => startTracking(revision));
  pendingStart = { revision, promise };
  void promise.finally(() => {
    if (pendingStart?.revision === revision) pendingStart = undefined;
  });
  return promise;
}

async function startTracking(revision: number): Promise<TrackingReadiness> {
  const cancelled = () => revision !== trackingRevision;
  const superseded = { ready: false, message: "Location tracking request was superseded." };
  if (cancelled()) return superseded;
  recordDiagnostic({ category: "location", name: "tracking_start_requested" });
  try {
    const servicesEnabled = await Location.hasServicesEnabledAsync();
    if (cancelled()) return superseded;
    if (!servicesEnabled) {
      recordDiagnostic({ level: "warn", category: "location", name: "tracking_not_ready", payload: { reason: "services_disabled" } });
      return { ready: false, message: "Turn on device location services." };
    }
    const existingForeground = await Location.getForegroundPermissionsAsync();
    if (cancelled()) return superseded;
    const foreground = existingForeground.status === "granted"
      ? existingForeground
      : await Location.requestForegroundPermissionsAsync();
    if (cancelled()) return superseded;
    if (foreground.status !== "granted") {
      recordDiagnostic({ level: "warn", category: "permission", name: "foreground_location_denied", payload: { status: foreground.status } });
      return { ready: false, message: "Precise foreground location permission is required." };
    }
    const background = await Location.requestBackgroundPermissionsAsync();
    if (cancelled()) return superseded;
    if (background.status !== "granted") {
      recordDiagnostic({ level: "warn", category: "permission", name: "background_location_denied", payload: { status: background.status } });
      return { ready: false, message: "Background location is required for locked-phone play." };
    }
    await Notifications.setNotificationChannelAsync("game-events", {
      name: "Game events",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 150, 250],
    });
    if (cancelled()) return superseded;
    await Notifications.requestPermissionsAsync();
    if (cancelled()) return superseded;
    // Android can visibly tear down and recreate its foreground location service when
    // startLocationUpdatesAsync is called again. Keep the existing service if it is live.
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) {
      if (cancelled()) return superseded;
      recordDiagnostic({ category: "location", name: "tracking_already_started" });
      return { ready: true, message: "Live location ready." };
    }
    if (cancelled()) return superseded;
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy: Location.Accuracy.High,
      timeInterval: 1_500,
      // Stationary players still need heartbeat fixes so the server knows GPS is live.
      distanceInterval: 0,
      deferredUpdatesDistance: 0,
      deferredUpdatesInterval: 0,
      pausesUpdatesAutomatically: false,
      activityType: Location.ActivityType.Fitness,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: "Out of Sight match running",
        notificationBody: "Location is shared with your party according to your role.",
        killServiceOnDestroy: false,
      },
    });
    if (cancelled()) return superseded;
    recordDiagnostic({ category: "location", name: "tracking_started", payload: { foregroundPermission: foreground.status, backgroundPermission: background.status } });
    return { ready: true, message: "Live location ready." };
  } catch (error) {
    recordDiagnosticError("location", "tracking_start_failed", error);
    return { ready: false, message: error instanceof Error ? error.message : "Could not start live location. Reopen the app to retry." };
  }
}

/** Keep a foreground-only watch alive until the server verifies a sustained precise signal. */
export function refreshLobbyLocation(session: StoredSession): Promise<LobbyLocationReadiness> {
  const key = `${session.apiUrl}|${session.roomCode}|${session.playerId}|${session.locationSessionId}`;
  if (activeLobbyRefresh?.key === key) return activeLobbyRefresh.promise;
  activeLobbyRefresh?.cancel();
  const revision = ++lobbyTrackingRevision;
  let subscription: Location.LocationSubscription | undefined;
  let settled = false;
  let resolveResult!: (result: LobbyLocationReadiness) => void;
  const isCurrent = () => !settled && activeLobbyRefresh?.revision === revision;
  const finish = (result: LobbyLocationReadiness) => {
    if (settled) return;
    settled = true;
    subscription?.remove();
    if (activeLobbyRefresh?.revision === revision) activeLobbyRefresh = undefined;
    resolveResult(result);
  };
  const promise = new Promise<LobbyLocationReadiness>((resolve) => {
    resolveResult = resolve;
  });
  activeLobbyRefresh = {
    key,
    revision,
    promise,
    cancel: () => finish({ ready: false, message: "Lobby GPS verification stopped." }),
  };
  void (async () => {
    recordDiagnostic({ category: "location", name: "lobby_location_requested" });
    try {
      if (!await Location.hasServicesEnabledAsync()) {
        finish({ ready: false, message: "Turn on device location services." });
        return;
      }
      const existingForeground = await Location.getForegroundPermissionsAsync();
      if (!isCurrent()) return;
      const foreground = existingForeground.status === "granted"
        ? existingForeground
        : await Location.requestForegroundPermissionsAsync();
      if (foreground.status !== "granted") {
        finish({ ready: false, message: "Precise foreground location permission is required." });
        return;
      }
      if (!isCurrent()) return;
      let uploads = Promise.resolve();
      subscription = await Location.watchPositionAsync({
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 1_000,
        distanceInterval: 0,
      }, (location) => {
        uploads = uploads.then(async () => {
          if (!isCurrent()) return;
          const now = Date.now();
          lobbySequence += 1;
          const result = await uploadLocation(session, {
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
            accuracyMeters: Math.max(0, location.coords.accuracy ?? 9_999),
            sampledAtMs: location.timestamp,
            sampleAgeMs: Math.max(0, now - location.timestamp),
            sequence: lobbySequence,
            sessionId: `${session.locationSessionId}-${lobbyRuntimeId}`.slice(0, 100),
          }, await readDeviceStatus(now));
          recordDiagnostic({
            level: "debug",
            category: "location",
            name: "lobby_location_accepted",
            payload: {
              version: result.snapshot.version,
              accuracyMeters: location.coords.accuracy,
              gpsReady: result.snapshot.players.find((player) => player.id === result.snapshot.selfId)?.gpsReady,
            },
          });
          const self = result.snapshot.players.find((player) => player.id === result.snapshot.selfId);
          if (self?.gpsReady) {
            finish({ ready: true, message: "GPS verified for this lobby.", snapshot: result.snapshot });
          }
        }).catch((error) => {
          if (isCurrent()) recordDiagnosticError("location", "lobby_location_failed", error);
        });
      });
      if (!isCurrent()) subscription.remove();
    } catch (error) {
      recordDiagnosticError("location", "lobby_location_failed", error);
      finish({ ready: false, message: error instanceof Error ? error.message : "Could not verify GPS for the lobby." });
    }
  })();
  return promise;
}

/** Stop the active-match background service without interrupting lobby GPS verification. */
export function stopMatchBackgroundTracking(): Promise<void> {
  ++trackingRevision;
  return serializeTracking(async () => {
    recordDiagnostic({ category: "location", name: "tracking_stop_requested" });
    try {
      if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      }
      recordDiagnostic({ category: "location", name: "tracking_stopped" });
    } catch (error) {
      recordDiagnosticError("location", "tracking_stop_failed", error);
    } finally {
      resetLocationNotificationState();
    }
  });
}

/** Stop every location source when leaving a party or when location is no longer needed. */
export function stopMatchTracking(): Promise<void> {
  activeLobbyRefresh?.cancel();
  return stopMatchBackgroundTracking();
}
