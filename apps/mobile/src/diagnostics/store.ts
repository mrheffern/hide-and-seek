import * as SQLite from "expo-sqlite";
import type { ClientDiagnosticEvent } from "@hide-and-seek/protocol";

export interface DiagnosticScope {
  apiUrl: string;
  roomCode: string;
  playerId: string;
}

interface EventRow { event_id: string; payload_json: string; }
let database: SQLite.SQLiteDatabase | undefined;
let storeFailureReported = false;

function db(): SQLite.SQLiteDatabase {
  if (database) return database;
  const candidate = SQLite.openDatabaseSync("out-of-sight-diagnostics.db");
  try {
    candidate.execSync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS diagnostic_events (
        local_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        api_url TEXT,
        room_code TEXT,
        player_id TEXT
      );
    `);
    // Preserve already-buffered events from the first diagnostics release.
    const columns = candidate.getAllSync<{ name: string }>("PRAGMA table_info(diagnostic_events)");
    if (!columns.some((column) => column.name === "api_url")) {
      candidate.execSync(`
        BEGIN;
        ALTER TABLE diagnostic_events ADD COLUMN api_url TEXT;
        ALTER TABLE diagnostic_events ADD COLUMN room_code TEXT;
        ALTER TABLE diagnostic_events ADD COLUMN player_id TEXT;
        UPDATE diagnostic_events SET
          room_code = json_extract(payload_json, '$.payload.roomCode'),
          player_id = json_extract(payload_json, '$.payload.playerId')
          WHERE json_valid(payload_json);
        COMMIT;
      `);
    }
    candidate.execSync(`CREATE INDEX IF NOT EXISTS diagnostic_events_scope
      ON diagnostic_events(room_code, player_id, api_url, local_sequence);`);
    database = candidate;
    return candidate;
  } catch (error) {
    candidate.closeSync();
    throw error;
  }
}

export function storeDiagnosticEvent(event: ClientDiagnosticEvent, scope?: DiagnosticScope): void {
  try {
    const current = db();
    current.runSync(
      `INSERT OR IGNORE INTO diagnostic_events
        (event_id, payload_json, created_at_ms, api_url, room_code, player_id) VALUES (?, ?, ?, ?, ?, ?)`,
      event.id, JSON.stringify(event), event.clientAtMs,
      scope?.apiUrl ?? null, scope?.roomCode ?? null, scope?.playerId ?? null,
    );
    // Count rows rather than sequence gaps: retries may consume sequence numbers.
    current.execSync(`DELETE FROM diagnostic_events WHERE local_sequence IN (
      SELECT local_sequence FROM diagnostic_events ORDER BY local_sequence DESC LIMIT -1 OFFSET 20000
    );`);
  } catch (error) {
    if (!storeFailureReported) {
      storeFailureReported = true;
      console.error("[diagnostics] Local event storage failed", error);
    }
  }
}

/** Attach pre-join events only to the first successful session of this app runtime. */
export function bindUnscopedDiagnosticEvents(scope: DiagnosticScope, appSessionId: string): void {
  try {
    db().runSync(`UPDATE diagnostic_events SET api_url = ?, room_code = ?, player_id = ?
      WHERE room_code IS NULL AND player_id IS NULL AND json_valid(payload_json)
        AND json_extract(payload_json, '$.appSessionId') = ?`,
    scope.apiUrl, scope.roomCode, scope.playerId, appSessionId);
  } catch (error) {
    console.warn("[diagnostics] Could not bind pre-join events", error);
  }
}

export function pendingDiagnosticEvents(scope: DiagnosticScope, limit = 100): ClientDiagnosticEvent[] {
  try {
    return db().getAllSync<EventRow>(
      `SELECT event_id, payload_json FROM diagnostic_events
        WHERE room_code = ? AND player_id = ? AND (api_url = ? OR api_url IS NULL)
        ORDER BY local_sequence ASC LIMIT ?`,
      scope.roomCode, scope.playerId, scope.apiUrl, Math.max(1, Math.min(100, limit)),
    ).flatMap((row) => {
      try {
        return [JSON.parse(row.payload_json) as ClientDiagnosticEvent];
      } catch {
        // A corrupt row must not indefinitely block every later batch.
        deleteDiagnosticEvents([row.event_id]);
        return [];
      }
    });
  } catch (error) {
    console.error("[diagnostics] Could not read local events", error);
    return [];
  }
}

export function deleteDiagnosticEvents(ids: string[]): void {
  if (!ids.length) return;
  try {
    db().runSync(`DELETE FROM diagnostic_events WHERE event_id IN (${ids.map(() => "?").join(",")})`, ...ids);
  } catch (error) {
    console.error("[diagnostics] Could not remove uploaded events", error);
  }
}

export function pendingDiagnosticCount(scope?: DiagnosticScope): number {
  try {
    return (scope
      ? db().getFirstSync<{ count: number }>(`SELECT COUNT(*) AS count FROM diagnostic_events
          WHERE room_code = ? AND player_id = ? AND (api_url = ? OR api_url IS NULL)`,
        scope.roomCode, scope.playerId, scope.apiUrl)
      : db().getFirstSync<{ count: number }>("SELECT COUNT(*) AS count FROM diagnostic_events"))?.count ?? 0;
  } catch {
    return 0;
  }
}
