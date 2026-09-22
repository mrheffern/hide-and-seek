import type { RoomSnapshot } from "@hide-and-seek/protocol";

export interface LobbyStartReadiness {
  canStart: boolean;
  message: string;
}

export function lobbyStartReadiness(
  snapshot: Pick<RoomSnapshot, "boundary" | "players">,
): LobbyStartReadiness {
  const players = snapshot.players.filter((player) => player.status !== "departed");
  const blockers: string[] = [];

  if (snapshot.boundary.length < 3) blockers.push("Draw and save a boundary.");
  if (players.length < 2) blockers.push("At least two players must join.");
  if (players.filter((player) => player.role === "seeker").length !== 1) {
    blockers.push("Choose exactly one seeker.");
  }

  const missingGps = players.filter((player) => !player.gpsReady).map((player) => player.name);
  if (missingGps.length) blockers.push(`Waiting for GPS: ${missingGps.join(", ")}.`);

  return blockers.length
    ? { canStart: false, message: blockers.join(" ") }
    : { canStart: true, message: "Lobby ready. Start the hiding countdown when everyone is inside the boundary." };
}
