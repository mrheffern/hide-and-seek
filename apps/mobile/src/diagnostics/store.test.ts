/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientDiagnosticEvent } from "@hide-and-seek/protocol";

const native = vi.hoisted(() => ({ openDatabaseSync: vi.fn() }));
vi.mock("expo-sqlite", () => native);
let database: DatabaseSync;

beforeEach(() => {
  vi.resetModules();
  database = new DatabaseSync(":memory:");
  native.openDatabaseSync.mockReturnValue({
    execSync: (sql: string) => database.exec(sql),
    runSync: (sql: string, ...args: (string | number | null)[]) => database.prepare(sql).run(...args),
    getAllSync: (sql: string, ...args: (string | number | null)[]) => database.prepare(sql).all(...args),
    getFirstSync: (sql: string, ...args: (string | number | null)[]) => database.prepare(sql).get(...args),
    closeSync: vi.fn(),
  });
});
afterEach(() => database.close());

const scope = { apiUrl: "https://game.example", roomCode: "ABC234", playerId: "player-1" };
const event = (id: string, appSessionId = "runtime-1", payload?: Record<string, unknown>): ClientDiagnosticEvent => ({
  id, appSessionId, clientAtMs: 1000, category: "test", name: "action", level: "info", payload,
});

describe("persistent diagnostic queue", () => {
  it("never uploads another party, player, or server's events with the current credentials", async () => {
    const store = await import("./store");
    store.storeDiagnosticEvent(event("ours"), scope);
    store.storeDiagnosticEvent(event("other-room"), { ...scope, roomCode: "OTHER2" });
    store.storeDiagnosticEvent(event("other-player"), { ...scope, playerId: "player-2" });
    store.storeDiagnosticEvent(event("other-server"), { ...scope, apiUrl: "https://other.example" });
    expect(store.pendingDiagnosticEvents(scope).map((value) => value.id)).toEqual(["ours"]);
    store.deleteDiagnosticEvents(["ours"]);
    expect(store.pendingDiagnosticCount()).toBe(3);
  });

  it("binds pre-join events only once and only from the current app runtime", async () => {
    const store = await import("./store");
    store.storeDiagnosticEvent(event("current"));
    store.storeDiagnosticEvent(event("old-runtime", "runtime-0"));
    store.bindUnscopedDiagnosticEvents(scope, "runtime-1");
    store.bindUnscopedDiagnosticEvents({ ...scope, playerId: "player-2" }, "runtime-1");
    expect(store.pendingDiagnosticEvents(scope).map((value) => value.id)).toEqual(["current"]);
    expect(store.pendingDiagnosticEvents({ ...scope, playerId: "player-2" })).toEqual([]);
    expect(store.pendingDiagnosticCount()).toBe(2);
  });

  it("migrates the old queue without moving another player's events into this session", async () => {
    database.exec(`CREATE TABLE diagnostic_events (
      local_sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE,
      payload_json TEXT, created_at_ms INTEGER
    )`);
    const insert = database.prepare("INSERT INTO diagnostic_events(event_id, payload_json, created_at_ms) VALUES (?, ?, 1000)");
    insert.run("ours", JSON.stringify(event("ours", "old-runtime", { roomCode: scope.roomCode, playerId: scope.playerId })));
    insert.run("theirs", JSON.stringify(event("theirs", "old-runtime", { roomCode: "OTHER2", playerId: "player-2" })));
    const store = await import("./store");
    expect(store.pendingDiagnosticEvents(scope).map((value) => value.id)).toEqual(["ours"]);
    expect(store.pendingDiagnosticCount()).toBe(2);
  });

  it("keeps buffered events after reopening the database", async () => {
    const store = await import("./store");
    store.storeDiagnosticEvent(event("survives-restart"), scope);
    vi.resetModules();
    expect((await import("./store")).pendingDiagnosticEvents(scope)[0].id).toBe("survives-restart");
  });

  it("retains queued rows despite gaps from previous successful uploads", async () => {
    const store = await import("./store");
    store.storeDiagnosticEvent(event("old-offline"), scope);
    database.exec("UPDATE sqlite_sequence SET seq = 30000 WHERE name = 'diagnostic_events'");
    store.storeDiagnosticEvent(event("new-offline"), scope);
    expect(store.pendingDiagnosticCount(scope)).toBe(2);
  });
});
