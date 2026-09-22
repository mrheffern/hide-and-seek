/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoomState } from "@hide-and-seek/game-core";
import type { RoomState } from "@hide-and-seek/protocol";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(public ctx: unknown, public env: unknown) {}
  },
}));

import { GameRoom } from "./room";

const databases: DatabaseSync[] = [];
afterEach(() => {
  databases.forEach((database) => database.close());
  databases.length = 0;
  vi.restoreAllMocks();
});

async function roomFixture(state?: RoomState) {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const sql = {
    exec(query: string, ...bindings: (string | number | null)[]) {
      if (!bindings.length && query.includes("CREATE TABLE")) {
        database.exec(query);
        return { rowsWritten: 0 };
      }
      const statement = database.prepare(query);
      const before = database.prepare("SELECT total_changes() AS count").get()!.count as number;
      const rows = statement.all(...bindings);
      const after = database.prepare("SELECT total_changes() AS count").get()!.count as number;
      return { rowsWritten: after - before, toArray: () => rows, one: () => rows[0] };
    },
  };
  let load: Promise<void> | undefined;
  const sockets: WebSocket[] = [];
  const put = vi.fn(async () => undefined);
  const context = {
    storage: { sql, get: async () => state, put },
    blockConcurrencyWhile: (callback: () => Promise<void>) => { load = callback(); },
    getWebSockets: () => sockets,
    waitUntil: () => undefined,
  };
  const room = new GameRoom(context as unknown as DurableObjectState, {} as Env);
  await load;
  const request = (path: string, token = "host-token", body?: unknown) => room.fetch(new Request(`https://room/internal/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { room, request, database, sql, sockets, put, context };
}

function stateFixture() {
  const state = createRoomState({ roomCode: "ABC234", hostId: "host-id", hostToken: "host-token", hostName: "Host", now: Date.now() });
  state.players["guest-id"] = { ...state.players["host-id"], id: "guest-id", name: "Guest", isHost: false };
  state.tokens["guest-token"] = "guest-id";
  return state;
}

const clientEvent = (overrides: Record<string, unknown> = {}) => ({
  id: "client-event-123", appSessionId: "app-session-123", clientAtMs: 1234,
  category: "test", name: "client_event", level: "info", ...overrides,
});
const batch = (...events: ReturnType<typeof clientEvent>[]) => ({ protocolVersion: 1, events });

describe("server diagnostic integrity", () => {
  it("deduplicates per authenticated player and does not attribute old lobby events to a current match", async () => {
    const state = stateFixture();
    state.matchId = "new-match";
    const { request, database } = await roomFixture(state);
    for (const token of ["host-token", "host-token", "guest-token"]) {
      expect((await request("diagnostics", token, batch(clientEvent()))).status).toBe(200);
    }
    const rows = database.prepare("SELECT player_id, match_id FROM diagnostics WHERE source = 'client' ORDER BY sequence").all();
    expect(rows).toEqual([{ player_id: "host-id", match_id: null }, { player_id: "guest-id", match_id: null }]);
  });

  it("rejects cross-party or cross-player events before saving any of the batch", async () => {
    const { request, database } = await roomFixture(stateFixture());
    for (const payload of [{ roomCode: "OTHER1" }, { playerId: "guest-id" }]) {
      const response = await request("diagnostics", "host-token", batch(clientEvent(), clientEvent({ id: "other-event", payload })));
      expect(response.status).toBe(409);
      expect((await response.json() as { code: string }).code).toBe("diagnostics_identity_mismatch");
    }
    expect(database.prepare("SELECT COUNT(*) AS count FROM diagnostics WHERE source = 'client'").get()!.count).toBe(0);
  });

  it("redacts nested credentials received from old clients", async () => {
    const { request, database } = await roomFixture(stateFixture());
    await request("diagnostics", "host-token", batch(clientEvent({ payload: {
      token: "do-not-store", nested: { Authorization: "Bearer secret", apiKey: "map-secret", latitude: 34 },
    } })));
    const payload = String(database.prepare("SELECT payload_json FROM diagnostics WHERE source = 'client'").get()!.payload_json);
    expect(payload).not.toContain("do-not-store");
    expect(payload).not.toContain("Bearer secret");
    expect(payload).not.toContain("map-secret");
    expect(JSON.parse(payload).nested.latitude).toBe(34);
  });

  it("does not acknowledge uploads when durable storage fails", async () => {
    const { request, sql } = await roomFixture(stateFixture());
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const original = sql.exec.bind(sql);
    vi.spyOn(sql, "exec").mockImplementation((query, ...bindings) => {
      if (query.includes("INSERT") && bindings[2] === "client") throw new Error("Disk unavailable");
      return original(query, ...bindings);
    });
    const response = await request("diagnostics", "host-token", batch(clientEvent()));
    expect(response.status).toBe(503);
    expect((await response.json() as { code: string }).code).toBe("diagnostics_unavailable");
  });

  it("does not evict valid events because deduplicated uploads left sequence gaps", async () => {
    const { request, database } = await roomFixture(stateFixture());
    await request("diagnostics", "host-token", batch(clientEvent()));
    database.exec("UPDATE sqlite_sequence SET seq = 1000000 WHERE name = 'diagnostics'");
    await request("diagnostics", "host-token", batch(clientEvent({ id: "second-client-event" })));
    expect(database.prepare("SELECT COUNT(*) AS count FROM diagnostics WHERE source = 'client'").get()!.count).toBe(2);
  });

  it("bounds server-only diagnostics after a room resumes", async () => {
    const { database, context } = await roomFixture(stateFixture());
    database.exec(`WITH RECURSIVE counter(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM counter WHERE value < 100000)
      INSERT INTO diagnostics (server_at_ms, client_at_ms, source, room_code, app_session_id, event_id, level, category, name, payload_json)
      SELECT 1, 1, 'server', 'ABC234', 'server', CAST(value AS TEXT), 'info', 'test', 'old', '{}' FROM counter`);
    const resumed = new GameRoom(context as unknown as DurableObjectState, {} as Env);
    await Promise.resolve();
    await resumed.fetch(new Request("https://room/internal/snapshot", { headers: { Authorization: "Bearer host-token" } }));
    expect(Number(database.prepare("SELECT COUNT(*) AS count FROM diagnostics").get()!.count)).toBeLessThanOrEqual(100_000);
    expect(database.prepare("SELECT COUNT(*) AS count FROM diagnostics WHERE event_id = '100000'").get()!.count).toBe(1);
  });

  it("keeps a fixed export boundary even while requests add new diagnostics", async () => {
    const { request } = await roomFixture(stateFixture());
    await request("diagnostics", "host-token", batch(
      clientEvent(),
      clientEvent({ id: "client-event-456" }),
      clientEvent({ id: "client-event-789" }),
    ));
    let cursor = 0;
    let untilSequence: number | undefined;
    const sequences: number[] = [];
    let completed = false;
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const response = await request(`diagnostics?limit=1&after=${cursor}${untilSequence === undefined ? "" : `&untilSequence=${untilSequence}`}`);
      expect(response.status).toBe(200);
      const page = await response.json() as { untilSequence: number; events: { sequence: number }[]; nextAfter?: number };
      untilSequence ??= page.untilSequence;
      expect(page.untilSequence).toBe(untilSequence);
      sequences.push(...page.events.map((event) => event.sequence));
      if (!page.nextAfter) { completed = true; break; }
      cursor = page.nextAfter;
    }
    expect(completed).toBe(true);
    expect(sequences).toEqual([1, 2, 3]);
  });

  it.each(["hiding", "active", "paused"] as const)("protects hidden positions from host export during %s", async (phase) => {
    const state = stateFixture();
    state.phase = phase;
    const { request } = await roomFixture(state);
    expect((await request("diagnostics")).status).toBe(409);
    expect((await request("diagnostics", "guest-token")).status).toBe(403);
  });
});

describe("room state and audit consistency", () => {
  it("does not count another closing socket as a live player connection", async () => {
    const state = stateFixture();
    state.players["host-id"].connected = true;
    const { room, sockets } = await roomFixture(state);
    const closed = { readyState: WebSocket.CLOSED, deserializeAttachment: () => ({ playerId: "host-id" }) } as unknown as WebSocket;
    const closing = { readyState: WebSocket.CLOSING, deserializeAttachment: () => ({ playerId: "host-id" }) } as unknown as WebSocket;
    sockets.push(closed, closing);
    await room.webSocketClose(closed);
    expect(state.players["host-id"].connected).toBe(false);
    const version = state.version;
    await room.webSocketClose(closing);
    expect(state.version).toBe(version);
  });

  it("preserves connection state while another socket is still open", async () => {
    const state = stateFixture();
    state.players["host-id"].connected = true;
    const { room, sockets } = await roomFixture(state);
    const closed = { readyState: WebSocket.CLOSED, deserializeAttachment: () => ({ playerId: "host-id" }) } as unknown as WebSocket;
    const open = { readyState: WebSocket.OPEN, deserializeAttachment: () => ({ playerId: "host-id" }) } as unknown as WebSocket;
    sockets.push(closed, open);
    await room.webSocketClose(closed);
    expect(state.players["host-id"].connected).toBe(true);
  });

  it("captures a new game event after the rolling event buffer fills", async () => {
    const state = stateFixture();
    state.events = Array.from({ length: 40 }, (_, index) => ({ id: `old-${index}`, at: 1, type: "player_joined" as const, message: "Old event" }));
    const { request, database } = await roomFixture(state);
    expect((await request("command", "host-token", { protocolVersion: 1, commandId: "seeker-command", command: { type: "set_seeker", playerId: "guest-id" } })).status).toBe(200);
    const event = JSON.parse(String(database.prepare("SELECT payload_json FROM diagnostics WHERE name = 'command_processed'").get()!.payload_json));
    expect(event.gameEvents).toHaveLength(1);
    expect(event.gameEvents[0].type).toBe("seeker_selected");
  });

  it("retains match and actor attribution when returning to the lobby or leaving", async () => {
    const state = stateFixture();
    state.phase = "finished";
    state.matchId = "finished-match";
    const { request, database } = await roomFixture(state);
    await request("command", "host-token", { protocolVersion: 1, commandId: "lobby-command", command: { type: "return_to_lobby" } });
    await request("command", "guest-token", { protocolVersion: 1, commandId: "leave-command", command: { type: "leave_party" } });
    const events = database.prepare("SELECT match_id, player_name FROM diagnostics WHERE name = 'command_processed' ORDER BY sequence").all();
    expect(events).toEqual([{ match_id: "finished-match", player_name: "Host" }, { match_id: null, player_name: "Guest" }]);
  });

  it("persists an accepted one-shot lobby fix before the room can hibernate", async () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const state = stateFixture();
    const { request, put } = await roomFixture(state);
    const response = await request("location", "host-token", { protocolVersion: 1, fix: {
      latitude: 34,
      longitude: -118,
      accuracyMeters: 30,
      sampledAtMs: now,
      sampleAgeMs: 0,
      sequence: 1,
      sessionId: "lobby-gps-session",
    } });
    expect(response.status).toBe(200);
    expect(state.players["host-id"].latestFix?.accuracyMeters).toBe(30);
    expect(put).toHaveBeenCalledWith("room", state);
  });

  it("persists clock transitions even when the triggering GPS sample is rejected", async () => {
    const state = stateFixture();
    state.phase = "hiding";
    state.matchId = "test-match";
    state.hidingEndsAt = Date.now() - 100;
    state.activeEndsAt = Date.now() + 60_000;
    for (const player of Object.values(state.players)) player.latestFix = {
      latitude: 34, longitude: -118, accuracyMeters: 2, sampledAtMs: Date.now(), receivedAtMs: Date.now(),
      sampleAgeMs: 0, sequence: 1, sessionId: "old-session",
    };
    const { request, put } = await roomFixture(state);
    const response = await request("location", "host-token", { protocolVersion: 1, fix: {
      latitude: 34, longitude: -118, accuracyMeters: 2, sampledAtMs: Date.now(), sampleAgeMs: 60_001, sequence: 1, sessionId: "gps-session",
    } });
    expect(response.status).toBe(409);
    expect(state.phase).toBe("active");
    expect(put).toHaveBeenCalled();
  });
});
