import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  servicesEnabled: vi.fn(),
  foregroundPermission: vi.fn(),
  backgroundPermission: vi.fn(),
  startUpdates: vi.fn(),
  stopUpdates: vi.fn(),
  updatesStarted: vi.fn(),
  currentPosition: vi.fn(),
  uploadLocation: vi.fn(),
  deviceStatus: vi.fn(),
  notificationChannel: vi.fn(),
  notificationPermission: vi.fn(),
  resetNotifications: vi.fn(),
}));

vi.mock("expo-location", () => ({
  hasServicesEnabledAsync: mocks.servicesEnabled,
  requestForegroundPermissionsAsync: mocks.foregroundPermission,
  requestBackgroundPermissionsAsync: mocks.backgroundPermission,
  startLocationUpdatesAsync: mocks.startUpdates,
  stopLocationUpdatesAsync: mocks.stopUpdates,
  hasStartedLocationUpdatesAsync: mocks.updatesStarted,
  getCurrentPositionAsync: mocks.currentPosition,
  Accuracy: { High: "high" },
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
vi.mock("../deviceStatus", () => ({ readDeviceStatus: mocks.deviceStatus }));

import { refreshLobbyLocation, startMatchTracking, stopMatchTracking } from "./tracking";

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
  mocks.deviceStatus.mockResolvedValue({ networkType: "wifi" });
  mocks.uploadLocation.mockResolvedValue({ snapshot: { version: 2 } });
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

  it("checks lobby GPS once without requesting background permission or starting a service", async () => {
    const first = refreshLobbyLocation(session);
    const second = refreshLobbyLocation(session);
    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({ ready: true, snapshot: { version: 2 } });
    expect(mocks.currentPosition).toHaveBeenCalledOnce();
    expect(mocks.uploadLocation).toHaveBeenCalledOnce();
    expect(mocks.backgroundPermission).not.toHaveBeenCalled();
    expect(mocks.startUpdates).not.toHaveBeenCalled();
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
