import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  servicesEnabled: vi.fn(),
  getForegroundPermission: vi.fn(),
  foregroundPermission: vi.fn(),
  backgroundPermission: vi.fn(),
  startUpdates: vi.fn(),
  stopUpdates: vi.fn(),
  updatesStarted: vi.fn(),
  currentPosition: vi.fn(),
  watchPosition: vi.fn(),
  removeWatcher: vi.fn(),
  uploadLocation: vi.fn(),
  deviceStatus: vi.fn(),
  resetDeviceStatus: vi.fn(),
  notificationChannel: vi.fn(),
  notificationPermission: vi.fn(),
  resetNotifications: vi.fn(),
}));

vi.mock("expo-location", () => ({
  hasServicesEnabledAsync: mocks.servicesEnabled,
  getForegroundPermissionsAsync: mocks.getForegroundPermission,
  requestForegroundPermissionsAsync: mocks.foregroundPermission,
  requestBackgroundPermissionsAsync: mocks.backgroundPermission,
  startLocationUpdatesAsync: mocks.startUpdates,
  stopLocationUpdatesAsync: mocks.stopUpdates,
  hasStartedLocationUpdatesAsync: mocks.updatesStarted,
  getCurrentPositionAsync: mocks.currentPosition,
  watchPositionAsync: mocks.watchPosition,
  Accuracy: { High: "high", BestForNavigation: "best-for-navigation" },
  ActivityType: { Fitness: "fitness" },
}));

vi.mock("expo-notifications", () => ({
  setNotificationChannelAsync: mocks.notificationChannel,
  requestPermissionsAsync: mocks.notificationPermission,
  AndroidImportance: { HIGH: "high" },
}));

vi.mock("./backgroundLocation", () => ({
  LOCATION_TASK_NAME: "hide-and-seek-active-match-location",
  resetLocationNotificationState: mocks.resetNotifications,
}));

vi.mock("../diagnostics", () => ({
  recordDiagnostic: vi.fn(),
  recordDiagnosticError: vi.fn(),
}));

vi.mock("../api", () => ({ uploadLocation: mocks.uploadLocation }));
vi.mock("../deviceStatus", () => ({
  readDeviceStatus: mocks.deviceStatus,
  resetDeviceStatusCache: mocks.resetDeviceStatus,
}));

import {
  refreshLobbyLocation,
  recoverMatchTracking,
  startMatchTracking,
  stopMatchBackgroundTracking,
  stopMatchTracking,
} from "./tracking";

const session = {
  apiUrl: "https://game.example",
  roomCode: "ABC123",
  playerId: "player-1",
  token: "token",
  locationSessionId: "location-session",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.servicesEnabled.mockResolvedValue(true);
  mocks.getForegroundPermission.mockResolvedValue({ status: "undetermined" });
  mocks.foregroundPermission.mockResolvedValue({ status: "granted" });
  mocks.backgroundPermission.mockResolvedValue({ status: "granted" });
  mocks.updatesStarted.mockResolvedValue(false);
  mocks.startUpdates.mockResolvedValue(undefined);
  mocks.stopUpdates.mockResolvedValue(undefined);
  mocks.notificationChannel.mockResolvedValue(undefined);
  mocks.notificationPermission.mockResolvedValue({ status: "granted" });
  mocks.currentPosition.mockResolvedValue({
    timestamp: 10_000,
    coords: { latitude: 34, longitude: -118, accuracy: 4 },
  });
  mocks.watchPosition.mockResolvedValue({ remove: mocks.removeWatcher });
  mocks.deviceStatus.mockResolvedValue({ networkType: "wifi" });
  mocks.uploadLocation.mockResolvedValue({
    snapshot: { version: 2, selfId: "player-1", players: [{ id: "player-1", gpsReady: true }] },
  });
});

describe("locked-phone location tracking", () => {
  it("stops before permission prompts when location services are disabled", async () => {
    mocks.servicesEnabled.mockResolvedValue(false);
    await expect(startMatchTracking()).resolves.toEqual({
      ready: false,
      message: "Turn on device location services.",
    });
    expect(mocks.foregroundPermission).not.toHaveBeenCalled();
  });

  it("requires foreground location permission", async () => {
    mocks.foregroundPermission.mockResolvedValue({ status: "denied" });
    await expect(startMatchTracking()).resolves.toEqual({
      ready: false,
      message: "Precise foreground location permission is required.",
    });
    expect(mocks.backgroundPermission).not.toHaveBeenCalled();
  });

  it("does not reopen Android's permission activity when foreground location is already granted", async () => {
    mocks.getForegroundPermission.mockResolvedValue({ status: "granted" });
    await expect(startMatchTracking()).resolves.toMatchObject({ ready: true });
    expect(mocks.foregroundPermission).not.toHaveBeenCalled();
  });

  it("requires background permission for locked-phone play", async () => {
    mocks.backgroundPermission.mockResolvedValue({ status: "denied" });
    await expect(startMatchTracking()).resolves.toEqual({
      ready: false,
      message: "Background location is required for locked-phone play.",
    });
    expect(mocks.startUpdates).not.toHaveBeenCalled();
  });

  it("starts a persistent, precise foreground location service", async () => {
    await expect(startMatchTracking()).resolves.toEqual({
      ready: true,
      message: "Live location ready.",
    });
    expect(mocks.notificationChannel).toHaveBeenCalledWith(
      "game-events",
      expect.objectContaining({ name: "Game events" }),
    );
    expect(mocks.startUpdates).toHaveBeenCalledWith(
      "hide-and-seek-active-match-location",
      expect.objectContaining({
        accuracy: "high",
        timeInterval: 1_500,
        distanceInterval: 0,
        pausesUpdatesAutomatically: false,
        activityType: "fitness",
        foregroundService: expect.objectContaining({ killServiceOnDestroy: false }),
      }),
    );
  });

  it("does not restart an already-running Android location service", async () => {
    mocks.updatesStarted.mockResolvedValue(true);
    await expect(startMatchTracking()).resolves.toMatchObject({ ready: true });
    expect(mocks.startUpdates).not.toHaveBeenCalled();
  });

  it("restarts a nominally running service and uploads a fresh fix during recovery", async () => {
    mocks.updatesStarted.mockResolvedValue(true);
    mocks.currentPosition.mockResolvedValue({
      timestamp: 10_000,
      coords: { latitude: 34.1, longitude: -118.2, accuracy: 5, speed: 1.25 },
    });

    await expect(recoverMatchTracking(session)).resolves.toEqual({
      ready: true,
      message: "GPS connection restored.",
    });

    expect(mocks.stopUpdates).toHaveBeenCalledWith("hide-and-seek-active-match-location");
    expect(mocks.startUpdates).toHaveBeenCalledOnce();
    expect(mocks.currentPosition).toHaveBeenCalledWith({ accuracy: "high" });
    expect(mocks.resetDeviceStatus).toHaveBeenCalledOnce();
    expect(mocks.uploadLocation).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        latitude: 34.1,
        longitude: -118.2,
        accuracyMeters: 5,
        speedMetersPerSecond: 1.25,
        sessionId: expect.stringContaining("location-session-recovery-"),
      }),
      { networkType: "wifi" },
    );
  });

  it("leaves the restarted stream running when the immediate recovery probe fails", async () => {
    mocks.updatesStarted.mockResolvedValue(true);
    mocks.uploadLocation.mockRejectedValue(new Error("still offline"));

    await expect(recoverMatchTracking(session)).resolves.toEqual({
      ready: false,
      message: "GPS recovery is still retrying. Keep the app open briefly.",
    });

    expect(mocks.stopUpdates).toHaveBeenCalledOnce();
    expect(mocks.startUpdates).toHaveBeenCalledOnce();
  });

  it("keeps a foreground lobby watch running until the server verifies sustained GPS", async () => {
    let onLocation!: (location: { timestamp: number; coords: { latitude: number; longitude: number; accuracy: number } }) => void;
    mocks.watchPosition.mockImplementation(async (_options, callback) => {
      onLocation = callback;
      return { remove: mocks.removeWatcher };
    });
    mocks.uploadLocation
      .mockResolvedValueOnce({
        snapshot: { version: 2, selfId: "player-1", players: [{ id: "player-1", gpsReady: false }] },
      })
      .mockResolvedValueOnce({
        snapshot: { version: 3, selfId: "player-1", players: [{ id: "player-1", gpsReady: true }] },
      });
    const first = refreshLobbyLocation(session);
    const second = refreshLobbyLocation(session);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(mocks.watchPosition).toHaveBeenCalledOnce());
    expect(mocks.watchPosition).toHaveBeenCalledWith(expect.objectContaining({
      accuracy: "best-for-navigation",
      timeInterval: 1_000,
      distanceInterval: 0,
    }), expect.any(Function));
    onLocation({ timestamp: Date.now(), coords: { latitude: 34, longitude: -118, accuracy: 4 } });
    await vi.waitFor(() => expect(mocks.uploadLocation).toHaveBeenCalledOnce());
    expect(mocks.removeWatcher).not.toHaveBeenCalled();
    onLocation({ timestamp: Date.now(), coords: { latitude: 34, longitude: -118, accuracy: 4 } });
    await expect(first).resolves.toMatchObject({ ready: true, snapshot: { version: 3 } });
    expect(mocks.uploadLocation).toHaveBeenCalledTimes(2);
    expect(mocks.removeWatcher).toHaveBeenCalledOnce();
    expect(mocks.backgroundPermission).not.toHaveBeenCalled();
    expect(mocks.startUpdates).not.toHaveBeenCalled();
  });

  it("removes an unfinished lobby watch when location tracking stops", async () => {
    const pending = refreshLobbyLocation(session);
    await vi.waitFor(() => expect(mocks.watchPosition).toHaveBeenCalledOnce());
    await stopMatchTracking();
    await expect(pending).resolves.toEqual({ ready: false, message: "Lobby GPS verification stopped." });
    expect(mocks.removeWatcher).toHaveBeenCalledOnce();
  });

  it("keeps an unfinished lobby watch alive while only the match background service stops", async () => {
    let onLocation!: (location: { timestamp: number; coords: { latitude: number; longitude: number; accuracy: number } }) => void;
    mocks.watchPosition.mockImplementation(async (_options, callback) => {
      onLocation = callback;
      return { remove: mocks.removeWatcher };
    });
    const pending = refreshLobbyLocation(session);
    await vi.waitFor(() => expect(mocks.watchPosition).toHaveBeenCalledOnce());
    await stopMatchBackgroundTracking();
    expect(mocks.removeWatcher).not.toHaveBeenCalled();
    onLocation({ timestamp: Date.now(), coords: { latitude: 34, longitude: -118, accuracy: 4 } });
    await expect(pending).resolves.toMatchObject({ ready: true });
    expect(mocks.removeWatcher).toHaveBeenCalledOnce();
  });

  it("stops active updates and always resets notification state", async () => {
    mocks.updatesStarted.mockResolvedValue(true);
    await stopMatchTracking();
    expect(mocks.stopUpdates).toHaveBeenCalledWith("hide-and-seek-active-match-location");
    expect(mocks.resetNotifications).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    mocks.updatesStarted.mockResolvedValue(false);
    await stopMatchTracking();
    expect(mocks.stopUpdates).not.toHaveBeenCalled();
    expect(mocks.resetNotifications).toHaveBeenCalledOnce();
  });

  it("does not start sharing if the player leaves while a permission request is pending", async () => {
    let resolvePermission!: (permission: { status: string }) => void;
    mocks.foregroundPermission.mockImplementation(() => new Promise((resolve) => { resolvePermission = resolve; }));
    const start = startMatchTracking();
    await vi.waitFor(() => expect(mocks.foregroundPermission).toHaveBeenCalledOnce());
    const stop = stopMatchTracking();
    resolvePermission({ status: "granted" });
    await Promise.all([start, stop]);
    expect(mocks.startUpdates).not.toHaveBeenCalled();
    expect(mocks.backgroundPermission).not.toHaveBeenCalled();
  });

  it("finishes stopping after an in-flight native start rather than leaving GPS running", async () => {
    let resolveStart!: () => void;
    mocks.startUpdates.mockImplementation(() => new Promise<void>((resolve) => { resolveStart = resolve; }));
    mocks.updatesStarted.mockResolvedValueOnce(false).mockResolvedValue(true);
    const start = startMatchTracking();
    await vi.waitFor(() => expect(mocks.startUpdates).toHaveBeenCalledOnce());
    const stop = stopMatchTracking();
    expect(mocks.stopUpdates).not.toHaveBeenCalled();
    resolveStart();
    await Promise.all([start, stop]);
    expect(mocks.stopUpdates).toHaveBeenCalledOnce();
  });

  it("coalesces overlapping foreground callbacks into one permission and service start", async () => {
    const first = startMatchTracking();
    const second = startMatchTracking();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(mocks.foregroundPermission).toHaveBeenCalledOnce();
    expect(mocks.startUpdates).toHaveBeenCalledOnce();
  });

  it("returns a recoverable readiness error for native failures without an unhandled rejection", async () => {
    mocks.startUpdates.mockRejectedValue(new Error("Native service unavailable"));
    await expect(startMatchTracking()).resolves.toEqual({ ready: false, message: "Native service unavailable" });
    mocks.updatesStarted.mockRejectedValue(new Error("Native task unavailable"));
    await expect(stopMatchTracking()).resolves.toBeUndefined();
    expect(mocks.resetNotifications).toHaveBeenCalledOnce();
  });
});
