import { describe, expect, it } from "vitest";
import type { GameEvent } from "@hide-and-seek/protocol";
import { consumeGameplaySoundCues } from "./gameplaySoundEvents";

const event = (
  id: string,
  type: GameEvent["type"],
  overrides: Partial<GameEvent> = {},
): GameEvent => ({ id, type, at: 10_000, message: type, ...overrides });

const snapshot = (selfId: string, events: GameEvent[], serverNow = 10_000) => ({
  selfId,
  events,
  serverNow,
});

describe("authoritative gameplay sound cues", () => {
  it("plays Tagged for both the seeker and the tagged player", () => {
    const tagged = event("tag-1", "player_tagged", { actorId: "seeker", targetId: "hider" });
    expect(consumeGameplaySoundCues(snapshot("seeker", [tagged]), new Set())).toEqual([
      { eventId: "tag-1", kind: "tagged" },
    ]);
    expect(consumeGameplaySoundCues(snapshot("hider", [tagged]), new Set())).toEqual([
      { eventId: "tag-1", kind: "tagged" },
    ]);
    expect(consumeGameplaySoundCues(snapshot("teammate", [tagged]), new Set())).toEqual([]);
  });

  it("plays the bear-trap callout only for the trapped seeker", () => {
    const trapped = event("trap-1", "trap_triggered", { actorId: "hider", targetId: "seeker" });
    expect(consumeGameplaySoundCues(snapshot("seeker", [trapped]), new Set())).toEqual([
      { eventId: "trap-1", kind: "bear_trap" },
    ]);
    expect(consumeGameplaySoundCues(snapshot("hider", [trapped]), new Set())).toEqual([]);
  });

  it("does not play for placement, repeat snapshots, or stale events", () => {
    const seen = new Set<string>();
    const placement = event("placed-1", "trap_placed", { actorId: "hider" });
    const tagged = event("tag-1", "player_tagged", { actorId: "seeker", targetId: "hider" });
    expect(consumeGameplaySoundCues(snapshot("seeker", [placement, tagged]), seen)).toEqual([
      { eventId: "tag-1", kind: "tagged" },
    ]);
    expect(consumeGameplaySoundCues(snapshot("seeker", [placement, tagged]), seen)).toEqual([]);
    expect(consumeGameplaySoundCues(
      snapshot("seeker", [event("tag-old", "player_tagged", { actorId: "seeker", targetId: "hider" })], 20_001),
      seen,
    )).toEqual([]);
  });
});
