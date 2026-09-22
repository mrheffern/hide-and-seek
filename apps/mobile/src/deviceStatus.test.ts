import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  power: vi.fn(),
  network: vi.fn(),
}));

vi.mock("expo-battery", () => ({
  getPowerStateAsync: mocks.power,
  BatteryState: { UNKNOWN: 0, UNPLUGGED: 1, CHARGING: 2, FULL: 3, NOT_CHARGING: 4 },
}));

vi.mock("expo-network", () => ({
  getNetworkStateAsync: mocks.network,
  NetworkStateType: {
    NONE: "NONE",
    UNKNOWN: "UNKNOWN",
    CELLULAR: "CELLULAR",
    WIFI: "WIFI",
    BLUETOOTH: "BLUETOOTH",
    ETHERNET: "ETHERNET",
    WIMAX: "WIMAX",
    VPN: "VPN",
    OTHER: "OTHER",
  },
}));

import { readDeviceStatus, resetDeviceStatusCache } from "./deviceStatus";

beforeEach(() => {
  vi.clearAllMocks();
  resetDeviceStatusCache();
  mocks.power.mockResolvedValue({ batteryLevel: 0.194, batteryState: 2, lowPowerMode: true });
  mocks.network.mockResolvedValue({ type: "WIFI", isConnected: true, isInternetReachable: true });
});

describe("device status collection", () => {
  it("normalizes battery and network information", async () => {
    await expect(readDeviceStatus(10_000)).resolves.toEqual({
      batteryPercent: 19,
      isCharging: true,
      lowPowerMode: true,
      networkType: "wifi",
      isInternetReachable: true,
    });
  });

  it("caches native reads for fifteen seconds", async () => {
    await readDeviceStatus(10_000);
    await readDeviceStatus(20_000);
    expect(mocks.power).toHaveBeenCalledOnce();
    expect(mocks.network).toHaveBeenCalledOnce();
    await readDeviceStatus(25_001);
    expect(mocks.power).toHaveBeenCalledTimes(2);
  });

  it("falls back safely when native health reads fail", async () => {
    mocks.power.mockRejectedValue(new Error("unavailable"));
    mocks.network.mockRejectedValue(new Error("unavailable"));
    await expect(readDeviceStatus(10_000)).resolves.toEqual({
      batteryPercent: undefined,
      isCharging: undefined,
      lowPowerMode: undefined,
      networkType: "unknown",
      isInternetReachable: undefined,
    });
  });
});
