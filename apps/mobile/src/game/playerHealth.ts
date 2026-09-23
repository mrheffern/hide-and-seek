import type { VisiblePlayer } from "@hide-and-seek/protocol";

function ageText(ageMs: number): string {
  const seconds = Math.max(0, Math.round(ageMs / 1_000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
}

export function currentGpsAgeMs(
  player: VisiblePlayer,
  snapshotServerNow: number,
  now: number,
): number | undefined {
  if (player.gpsAgeMs === undefined) return undefined;
  return player.gpsAgeMs + Math.max(0, now - snapshotServerNow);
}

export function gpsStatusText(
  player: VisiblePlayer,
  snapshotServerNow: number,
  now: number,
): string {
  const accuracy = player.gpsAccuracyMeters === undefined
    ? ""
    : ` · ±${Math.round(player.gpsAccuracyMeters)}m`;
  const age = currentGpsAgeMs(player, snapshotServerNow, now);
  switch (player.gpsStatus) {
    case "live":
      return `GPS live${accuracy}`;
    case "weak":
      return `GPS weak${accuracy}`;
    case "stale":
      return `GPS stale${age === undefined ? "" : ` · ${ageText(age)}`}`;
    case "missing":
      return "GPS unavailable";
  }
}

export function lobbyGpsStatusText(
  player: VisiblePlayer,
  snapshotServerNow: number,
  now: number,
): string {
  const accuracy = player.gpsAccuracyMeters === undefined
    ? ""
    : ` · ±${Math.round(player.gpsAccuracyMeters)}m`;
  if (player.gpsReady) return `GPS verified${accuracy}`;
  if (player.gpsStatus === "live") return `GPS stabilizing${accuracy}`;
  return gpsStatusText(player, snapshotServerNow, now);
}

export function connectionStatusText(player: VisiblePlayer, now: number): string {
  const report = player.deviceStatus;
  const reportIsFresh = report && now - report.receivedAtMs <= 60_000;
  const network = reportIsFresh
    ? report.networkType === "wifi"
      ? "Wi-Fi"
      : report.networkType === "cellular"
        ? "Cellular"
        : report.networkType === "ethernet"
          ? "Ethernet"
          : report.networkType === "none"
            ? "Offline"
            : "Network unknown"
    : undefined;
  const connection = player.connected ? "Online" : "Reconnecting";
  return network ? `${connection} · ${network}` : connection;
}

export function batteryStatusText(player: VisiblePlayer, now: number): string | undefined {
  const report = player.deviceStatus;
  if (!report || now - report.receivedAtMs > 60_000 || report.batteryPercent === undefined) {
    return undefined;
  }
  return `${report.batteryPercent}% battery${report.isCharging ? " · charging" : ""}${report.lowPowerMode ? " · low power" : ""}`;
}

export function isGpsResumeBlocker(player: VisiblePlayer): boolean {
  return player.status === "active" && player.gpsStatus !== "live";
}

/** Show the viewer once, followed by every other player whose GPS prevents resume. */
export function pausedGpsStatusPlayers(players: VisiblePlayer[], selfId: string): VisiblePlayer[] {
  const self = players.find((player) => player.id === selfId);
  const blockers = players.filter((player) => player.id !== selfId && isGpsResumeBlocker(player));
  return self ? [self, ...blockers] : blockers;
}
