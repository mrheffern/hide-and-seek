import { describe, expect, it } from "vitest";
import type { VisiblePlayer } from "@hide-and-seek/protocol";
import { batteryStatusText, connectionStatusText, currentGpsAgeMs, gpsStatusText, lobbyGpsStatusText } from "./playerHealth";

const player: VisiblePlayer = {
  id: "p1",
  name: "Alex",
  role: "hider",
  status: "active",
  connected: true,
  isHost: false,
  gpsReady: true,
  gpsStatus: "live",
  gpsAgeMs: 500,
  gpsAccuracyMeters: 3.4,
  deviceStatus: {
    batteryPercent: 18,
    isCharging: true,
    lowPowerMode: false,
    networkType: "wifi",
    isInternetReachable: true,
    receivedAtMs: 10_000,
  },
};

describe("player health presentation", () => {
  it("ages GPS status between server snapshots", () => {
    expect(currentGpsAgeMs(player, 10_000, 12_000)).toBe(2_500);
    expect(gpsStatusText(player, 10_000, 12_000)).toBe("GPS live · ±3m");
    expect(gpsStatusText({ ...player, gpsStatus: "stale" }, 10_000, 12_000)).toBe(
      "GPS stale · 3s ago",
    );
  });

  it("distinguishes lobby verification from a momentarily precise fix", () => {
    expect(lobbyGpsStatusText({ ...player, gpsReady: false }, 10_000, 12_000)).toBe("GPS stabilizing · ±3m");
    expect(lobbyGpsStatusText(player, 10_000, 120_000)).toBe("GPS verified · ±3m");
  });

  it("shows connection type and fresh battery health", () => {
    expect(connectionStatusText(player, 12_000)).toBe("Online · Wi-Fi");
    expect(batteryStatusText(player, 12_000)).toBe("18% battery · charging");
  });

  it("does not present old battery data as current", () => {
    expect(batteryStatusText(player, 70_001)).toBeUndefined();
    expect(connectionStatusText({ ...player, connected: false }, 70_001)).toBe("Reconnecting");
  });
});
