import type { RoomSnapshot } from "@hide-and-seek/protocol";
import type { StoredSession } from "../session";

export function shouldTrackPlayer(snapshot: Pick<RoomSnapshot, "phase" | "selfId" | "players"> | null): boolean {
  return Boolean(snapshot && (snapshot.phase === "hiding" || snapshot.phase === "active" || snapshot.phase === "paused")
    && snapshot.players.find((player) => player.id === snapshot.selfId)?.status === "active");
}

/** Diagnostics remain available to the host in every authoritative party phase. */
export function canExportDiagnostics(
  snapshot: Pick<RoomSnapshot, "phase" | "hostId" | "selfId"> | null,
): boolean {
  return Boolean(snapshot && snapshot.hostId === snapshot.selfId);
}

export function acceptsSnapshot(
  current: Pick<RoomSnapshot, "roomCode" | "selfId" | "version" | "serverNow"> | null,
  next: Pick<RoomSnapshot, "roomCode" | "selfId" | "version" | "serverNow">,
  session: Pick<StoredSession, "roomCode" | "playerId">,
): boolean {
  if (next.roomCode !== session.roomCode || next.selfId !== session.playerId) return false;
  // Versions belong to one room. A newly joined room can start below the previous room's version.
  if (!current || current.roomCode !== next.roomCode || current.selfId !== next.selfId) return true;
  return next.version > current.version
    || (next.version === current.version && next.serverNow >= current.serverNow);
}
