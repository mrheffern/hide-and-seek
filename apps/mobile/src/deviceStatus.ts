import * as Battery from "expo-battery";
import * as Network from "expo-network";
import type { DeviceStatusReport, NetworkType } from "@hide-and-seek/protocol";

const CACHE_MS = 15_000;

let cached: { at: number; value: DeviceStatusReport } | undefined;

function networkType(value: Network.NetworkStateType | undefined): NetworkType {
  switch (value) {
    case Network.NetworkStateType.WIFI:
      return "wifi";
    case Network.NetworkStateType.CELLULAR:
      return "cellular";
    case Network.NetworkStateType.ETHERNET:
      return "ethernet";
    case Network.NetworkStateType.NONE:
      return "none";
    case Network.NetworkStateType.UNKNOWN:
    case undefined:
      return "unknown";
    default:
      return "other";
  }
}

export async function readDeviceStatus(now = Date.now()): Promise<DeviceStatusReport> {
  if (cached && now - cached.at < CACHE_MS) return cached.value;

  const [powerResult, networkResult] = await Promise.allSettled([
    Battery.getPowerStateAsync(),
    Network.getNetworkStateAsync(),
  ]);
  const power = powerResult.status === "fulfilled" ? powerResult.value : undefined;
  const network = networkResult.status === "fulfilled" ? networkResult.value : undefined;
  const batteryPercent =
    power && power.batteryLevel >= 0
      ? Math.max(0, Math.min(100, Math.round(power.batteryLevel * 100)))
      : undefined;
  const value: DeviceStatusReport = {
    batteryPercent,
    isCharging: power
      ? power.batteryState === Battery.BatteryState.CHARGING ||
        power.batteryState === Battery.BatteryState.FULL
      : undefined,
    lowPowerMode: power?.lowPowerMode,
    networkType: networkType(network?.type),
    isInternetReachable: network?.isInternetReachable,
  };
  cached = { at: now, value };
  return value;
}

export function resetDeviceStatusCache(): void {
  cached = undefined;
}
