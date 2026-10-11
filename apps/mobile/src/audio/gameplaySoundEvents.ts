import type { GameEvent, RoomSnapshot } from "@hide-and-seek/protocol";

export type GameplaySoundKind = "tagged" | "bear_trap";

export interface GameplaySoundCue {
  eventId: string;
  kind: GameplaySoundKind;
}

type SoundSnapshot = Pick<RoomSnapshot, "events" | "selfId" | "serverNow">;

const MAX_EVENT_AGE_MS = 10_000;
const MAX_REMEMBERED_EVENTS = 200;
const consumedEventIds = new Set<string>();

function soundKindForPlayer(event: GameEvent, selfId: string): GameplaySoundKind | undefined {
  if (event.type === "player_tagged" && (event.actorId === selfId || event.targetId === selfId)) {
    return "tagged";
  }
  if (event.type === "trap_triggered" && event.targetId === selfId) return "bear_trap";
  return undefined;
}

function remember(seen: Set<string>, eventId: string): void {
  seen.add(eventId);
  while (seen.size > MAX_REMEMBERED_EVENTS) {
    const oldest = seen.values().next().value as string | undefined;
    if (!oldest) break;
    seen.delete(oldest);
  }
}

export function consumeGameplaySoundCues(
  snapshot: SoundSnapshot,
  seen: Set<string> = consumedEventIds,
  maximumAgeMs = MAX_EVENT_AGE_MS,
): GameplaySoundCue[] {
  const cues: GameplaySoundCue[] = [];
  for (const event of snapshot.events) {
    const kind = soundKindForPlayer(event, snapshot.selfId);
    if (!kind || seen.has(event.id)) continue;
    remember(seen, event.id);
    if (snapshot.serverNow - event.at > maximumAgeMs) continue;
    cues.push({ eventId: event.id, kind });
  }
  return cues;
}
