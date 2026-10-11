import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { uploadLocation } from "../api";
import { flushDiagnostics, getDiagnosticContext, recordDiagnostic, recordDiagnosticError, setDiagnosticContext } from "../diagnostics";
import { readDeviceStatus, resetDeviceStatusCache } from "../deviceStatus";
import { readSession } from "../session";
import { consumeGameplaySoundCues } from "../audio/gameplaySoundEvents";
import { playGameplaySound } from "../audio/gameplayAudio";

export const LOCATION_TASK_NAME = "hide-and-seek-active-match-location";

interface LocationTaskData {
  locations: Location.LocationObject[];
}

let sequence = 0;
const runtimeSessionId = `runtime-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
let lastNotifiedTrapId: string | undefined;
let eliminationNotified = false;
let boundaryAlert: "near" | "outside" | undefined;
let lastDetailedLocationDiagnosticAt = 0;

export function resetLocationNotificationState(): void {
  lastNotifiedTrapId = undefined;
  eliminationNotified = false;
  boundaryAlert = undefined;
  lastDetailedLocationDiagnosticAt = 0;
  resetDeviceStatusCache();
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

if (!TaskManager.isTaskDefined(LOCATION_TASK_NAME)) {
  TaskManager.defineTask<LocationTaskData>(LOCATION_TASK_NAME, async ({ data, error }) => {
    if (error) {
      console.warn("[location] Native background task failed", error);
      recordDiagnosticError("location", "native_background_task_failed", error, undefined, false);
      return;
    }
    if (!data?.locations?.length) return;
    let diagnosticContext = getDiagnosticContext();
    try {
      const session = await readSession();
      if (!session) return;
      const location = data.locations[data.locations.length - 1];
      sequence += 1;
      setDiagnosticContext({ apiUrl: session.apiUrl, roomCode: session.roomCode, playerId: session.playerId });
      diagnosticContext = getDiagnosticContext();
      const now = Date.now();
      const deviceStatus = await readDeviceStatus(now);
      const recordDetailedSample = now - lastDetailedLocationDiagnosticAt >= 30_000;
      if (recordDetailedSample) lastDetailedLocationDiagnosticAt = now;
      const fix = {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        accuracyMeters: Math.max(0, location.coords.accuracy ?? 9_999),
        sampledAtMs: location.timestamp,
        sampleAgeMs: Math.max(0, now - location.timestamp),
        sequence,
        sessionId: `${session.locationSessionId}-${runtimeSessionId}`.slice(0, 100),
      };
      if (recordDetailedSample) recordDiagnostic({
        context: diagnosticContext,
        level: "debug",
        category: "location",
        name: "native_location_received",
        correlationId: `${fix.sessionId}:${fix.sequence}`,
        payload: {
          fix,
          altitude: location.coords.altitude,
          altitudeAccuracy: location.coords.altitudeAccuracy,
          heading: location.coords.heading,
          speed: location.coords.speed,
          mocked: location.mocked,
          deviceStatus,
          batchSize: data.locations.length,
        },
      });
      const result = await uploadLocation(
        session,
        fix,
        deviceStatus,
      );
      const currentSession = await readSession();
      if (!currentSession || currentSession.roomCode !== session.roomCode || currentSession.playerId !== session.playerId
        || currentSession.token !== session.token || currentSession.locationSessionId !== session.locationSessionId) return;
      setDiagnosticContext({ matchId: result.snapshot.matchId });
      diagnosticContext = { ...diagnosticContext, matchId: result.snapshot.matchId };
      if (recordDetailedSample || !result.ok || result.snapshot.outsideBoundary || result.snapshot.immobilized) recordDiagnostic({
        context: diagnosticContext,
        level: "debug",
        category: "location",
        name: "location_accepted",
        correlationId: `${fix.sessionId}:${fix.sequence}`,
        payload: {
          result: { ok: result.ok, code: result.code, message: result.message },
          snapshot: {
            version: result.snapshot.version,
            phase: result.snapshot.phase,
            outsideBoundary: result.snapshot.outsideBoundary,
            nearBoundary: result.snapshot.nearBoundary,
            boundaryDistanceMeters: result.snapshot.boundaryDistanceMeters,
            boundaryGraceRemainingMs: result.snapshot.boundaryGraceRemainingMs,
            immobilized: result.snapshot.immobilized,
          },
        },
      });
      const self = result.snapshot.players.find((player) => player.id === result.snapshot.selfId);
      for (const cue of consumeGameplaySoundCues(result.snapshot)) {
        await playGameplaySound(cue.kind, cue.eventId);
      }
      // Stopping location must not depend on notifications being permitted or successfully scheduled.
      if (self?.status === "eliminated" || self?.status === "departed" || result.snapshot.phase === "finished") {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      }
      const trapped = result.snapshot.immobilized;
      if (trapped && trapped.trapId !== lastNotifiedTrapId) {
        lastNotifiedTrapId = trapped.trapId;
        await Notifications.scheduleNotificationAsync({
          content: {
            title: "You hit a bear trap",
            body: "Stop and remain inside the circle for 15 observed seconds.",
            sound: false,
          },
          trigger: null,
        });
      }
      if (self?.status === "eliminated" && !eliminationNotified) {
        eliminationNotified = true;
        await Notifications.scheduleNotificationAsync({
          content: { title: "You were tagged", body: "Your location sharing has stopped.", sound: false },
          trigger: null,
        });
      }
      const nextBoundaryAlert = result.snapshot.outsideBoundary
        ? "outside"
        : result.snapshot.nearBoundary
          ? "near"
          : undefined;
      if (nextBoundaryAlert && nextBoundaryAlert !== boundaryAlert) {
        boundaryAlert = nextBoundaryAlert;
        await Notifications.scheduleNotificationAsync({
          content: nextBoundaryAlert === "outside"
            ? {
                title: "Return to the play area",
                body: `You crossed the boundary. Return within ${Math.ceil((result.snapshot.boundaryGraceRemainingMs ?? 0) / 1_000)} seconds.`,
                sound: true,
              }
            : {
                title: "Boundary nearby",
                body: "You are approaching the edge of the play area.",
                sound: true,
              },
          trigger: null,
        });
      } else if (!nextBoundaryAlert) {
        boundaryAlert = undefined;
      }
      await flushDiagnostics(session);
    } catch (error) {
      console.warn("[location] Location upload failed", error);
      recordDiagnosticError("location", "location_processing_failed", error, { sequence }, false, diagnosticContext);
      // The next native update retries with a newer sample. Old positions are never queued.
    }
  });
}
