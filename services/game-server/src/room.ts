import { DurableObject } from "cloudflare:workers";
import {
  acceptLocation,
  addPlayer,
  advanceRoomClock,
  applyCommand,
  createRoomState,
  playerIdForToken,
  snapshotForPlayer,
  type RuleContext,
  upgradeRoomState,
} from "@hide-and-seek/game-core";
import type {
  ClientDiagnosticEvent,
  CommandEnvelope,
  DiagnosticBatchEnvelope,
  DiagnosticsPage,
  LocationEnvelope,
  RoomState,
  StoredDiagnosticEvent,
} from "@hide-and-seek/protocol";
import { PROTOCOL_VERSION } from "@hide-and-seek/protocol";
import { apiError, bearerToken, json } from "./http";
import {
  commandEnvelopeSchema,
  diagnosticBatchSchema,
  locationEnvelopeSchema,
  playerNameSchema,
} from "./schemas";

interface SocketAttachment {
  playerId: string;
}

interface DiagnosticRow extends Record<string, SqlStorageValue> {
  sequence: number;
  server_at_ms: number;
  client_at_ms: number;
  source: "client" | "server";
  room_code: string;
  match_id: string | null;
  player_id: string | null;
  player_name: string | null;
  app_session_id: string;
  event_id: string;
  level: "debug" | "info" | "warn" | "error" | "fatal";
  category: string;
  name: string;
  correlation_id: string | null;
  payload_json: string;
}

export class GameRoom extends DurableObject<Env> {
  private room?: RoomState;
  private lastCheckpointAt = 0;
  private readonly sql: SqlStorage;
  private diagnosticCount = 0;

  constructor(context: DurableObjectState, env: Env) {
    super(context, env);
    this.sql = context.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS diagnostics (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        server_at_ms INTEGER NOT NULL,
        client_at_ms INTEGER NOT NULL,
        source TEXT NOT NULL,
        room_code TEXT NOT NULL,
        match_id TEXT,
        player_id TEXT,
        player_name TEXT,
        app_session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        level TEXT NOT NULL,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        correlation_id TEXT,
        payload_json TEXT NOT NULL
      );
      DROP INDEX IF EXISTS diagnostics_source_event;
      CREATE UNIQUE INDEX IF NOT EXISTS diagnostics_player_event
        ON diagnostics(source, COALESCE(player_id, ''), event_id);
      CREATE INDEX IF NOT EXISTS diagnostics_match_sequence
        ON diagnostics(match_id, sequence);
    `);
    this.diagnosticCount = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM diagnostics").one().count;
    this.pruneDiagnostics();
    context.blockConcurrencyWhile(async () => {
      const storedRoom = await context.storage.get<RoomState>("room");
      this.room = storedRoom ? upgradeRoomState(storedRoom) : undefined;
      this.lastCheckpointAt = Date.now();
    });
  }

  private safePayload(payload: Record<string, unknown> | undefined): string {
    try {
      // Enforce redaction at the receiving boundary as well as on current clients.
      const serialized = JSON.stringify(payload ?? {}, (key, value: unknown) =>
        /token|authorization|api.?key|secret|password/i.test(key) ? "[redacted]" : value,
      );
      return serialized.length <= 16_000
        ? serialized
        : JSON.stringify({ truncated: true, preview: serialized.slice(0, 15_800) });
    } catch {
      return JSON.stringify({ serializationError: true });
    }
  }

  private recordDiagnostic(args: {
    source: "client" | "server";
    eventId?: string;
    clientAtMs?: number;
    appSessionId?: string;
    level?: StoredDiagnosticEvent["level"];
    category: string;
    name: string;
    playerId?: string;
    playerName?: string;
    matchId?: string;
    correlationId?: string;
    payload?: Record<string, unknown>;
  }): boolean {
    if (!this.room) return false;
    const player = args.playerId ? this.room.players[args.playerId] : undefined;
    try {
      this.sql.exec(
        `INSERT OR IGNORE INTO diagnostics (
          server_at_ms, client_at_ms, source, room_code, match_id, player_id, player_name,
          app_session_id, event_id, level, category, name, correlation_id, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        Date.now(),
        args.clientAtMs ?? Date.now(),
        args.source,
        this.room.roomCode,
        args.matchId ?? (args.source === "server" ? this.room.matchId : undefined) ?? null,
        args.playerId ?? null,
        args.playerName ?? player?.name ?? null,
        args.appSessionId ?? "server",
        args.eventId ?? crypto.randomUUID(),
        args.level ?? "info",
        args.category.slice(0, 50),
        args.name.slice(0, 80),
        args.correlationId?.slice(0, 100) ?? null,
        this.safePayload(args.payload),
      );
      this.diagnosticCount += this.sql.exec<{ count: number }>("SELECT changes() AS count").one().count;
      this.pruneDiagnostics();
      return true;
    } catch (error) {
      console.error("[diagnostics] Failed to persist event", {
        category: args.category,
        name: args.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private pruneDiagnostics(): void {
    if (this.diagnosticCount <= 100_000) return;
    // Sequence gaps from deduplicated uploads must not evict retained events.
    this.sql.exec(`
      DELETE FROM diagnostics WHERE sequence < (
        SELECT sequence FROM diagnostics ORDER BY sequence DESC LIMIT 1 OFFSET 98999
      )
    `);
    this.diagnosticCount = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM diagnostics").one().count;
  }

  private recordClientEvents(playerId: string, events: ClientDiagnosticEvent[]): boolean {
    const playerName = this.room?.players[playerId]?.name;
    let saved = true;
    for (const event of events) {
      saved = this.recordDiagnostic({
        source: "client",
        eventId: event.id,
        clientAtMs: event.clientAtMs,
        appSessionId: event.appSessionId,
        level: event.level,
        category: event.category,
        name: event.name,
        playerId,
        playerName,
        matchId: event.matchId,
        correlationId: event.correlationId,
        payload: event.payload,
      }) && saved;
    }
    return saved;
  }

  private diagnosticsPage(url: URL, playerId: string): Response {
    if (!this.room || this.room.hostId !== playerId) {
      return apiError("host_only", "Only the host can export diagnostics.", 403);
    }
    const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
    const limit = Math.max(1, Math.min(1_000, Number.parseInt(url.searchParams.get("limit") ?? "500", 10) || 500));
    const matchId = url.searchParams.get("matchId")?.slice(0, 100);
    const newestSequence = this.sql.exec<{ sequence: number }>("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM diagnostics").one().sequence;
    const requestedUntil = url.searchParams.get("untilSequence");
    const untilSequence = requestedUntil === null ? newestSequence : Number(requestedUntil);
    if (!Number.isSafeInteger(untilSequence) || untilSequence < 0) {
      return apiError("invalid_cursor", "Diagnostics cursor is invalid.");
    }
    const upperBound = Math.min(untilSequence, newestSequence);
    const rows = matchId
      ? this.sql.exec<DiagnosticRow>(
          `SELECT * FROM diagnostics
           WHERE sequence > ? AND sequence <= ? AND match_id = ?
           ORDER BY sequence ASC LIMIT ?`,
          after,
          upperBound,
          matchId,
          limit,
        ).toArray()
      : this.sql.exec<DiagnosticRow>(
          `SELECT * FROM diagnostics
           WHERE sequence > ? AND sequence <= ?
           ORDER BY sequence ASC LIMIT ?`,
          after,
          upperBound,
          limit,
        ).toArray();
    const events: StoredDiagnosticEvent[] = rows.map((row) => {
      let payload: Record<string, unknown> | undefined;
      try {
        payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      } catch {
        payload = { parseError: true };
      }
      return {
        sequence: row.sequence,
        serverAtMs: row.server_at_ms,
        clientAtMs: row.client_at_ms,
        source: row.source,
        roomCode: row.room_code,
        matchId: row.match_id ?? undefined,
        playerId: row.player_id ?? undefined,
        playerName: row.player_name ?? undefined,
        appSessionId: row.app_session_id,
        id: row.event_id,
        level: row.level,
        category: row.category,
        name: row.name,
        correlationId: row.correlation_id ?? undefined,
        payload,
      };
    });
    const page: DiagnosticsPage = {
      roomCode: this.room.roomCode,
      matchId,
      untilSequence: upperBound,
      events,
      nextAfter: rows.length === limit ? rows.at(-1)?.sequence : undefined,
    };
    this.recordDiagnostic({
      source: "server",
      category: "diagnostics",
      name: "export_page_requested",
      playerId,
      payload: { after, limit, matchId, returned: events.length },
    });
    return json(page);
  }

  private context(now = Date.now()): RuleContext {
    return { now, id: () => crypto.randomUUID() };
  }

  private stateSummary() {
    if (!this.room) return undefined;
    return {
      version: this.room.version,
      phase: this.room.phase,
      matchId: this.room.matchId,
      winner: this.room.winner,
      playerCount: Object.keys(this.room.players).length,
      activePlayerCount: Object.values(this.room.players).filter((player) => player.status === "active").length,
      activeHiderCount: Object.values(this.room.players).filter(
        (player) => player.role === "hider" && player.status === "active",
      ).length,
      hiddenHiderCount: Object.values(this.room.players).filter(
        (player) => player.role === "hider" && player.status === "active" && player.hiddenMode?.hiddenAt !== undefined,
      ).length,
      speedWarningCount: Object.values(this.room.players).filter(
        (player) => player.role === "hider" && player.status === "active" && player.speedLimit?.warningEndsAt !== undefined,
      ).length,
      speedProbationCount: Object.values(this.room.players).filter(
        (player) => player.role === "hider" && player.status === "active" && player.speedLimit?.probationEndsAt !== undefined,
      ).length,
      boundaryPoints: this.room.boundary.length,
      trapCount: this.room.traps.length,
      immobilized: this.room.immobilized ? { ...this.room.immobilized } : undefined,
    };
  }

  private async advanceClock(now = Date.now()): Promise<boolean> {
    if (!this.room) return false;
    const before = this.stateSummary();
    const eventIds = new Set(this.room.events.map((event) => event.id));
    const version = this.room.version;
    advanceRoomClock(this.room, this.context(now));
    if (this.room.version === version) return false;
    this.recordDiagnostic({
      source: "server",
      category: "rules",
      name: "clock_advanced_state",
      payload: { before, after: this.stateSummary(), gameEvents: this.room.events.filter((event) => !eventIds.has(event.id)) },
    });
    await this.persist(true);
    return true;
  }

  private async jsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
    try {
      return { ok: true, value: await request.json() };
    } catch {
      return { ok: false };
    }
  }

  private async persist(force = false): Promise<void> {
    if (!this.room) return;
    const now = Date.now();
    if (!force && now - this.lastCheckpointAt < 5_000) return;
    await this.ctx.storage.put("room", this.room);
    this.lastCheckpointAt = now;
  }

  private authenticate(request: Request): string | null {
    if (!this.room) return null;
    const token = bearerToken(request) ?? request.headers.get("X-Player-Token");
    return token ? playerIdForToken(this.room, token) ?? null : null;
  }

  private async broadcast(): Promise<void> {
    if (!this.room) return;
    const now = Date.now();
    await this.advanceClock(now);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment || socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(JSON.stringify(snapshotForPlayer(this.room, attachment.playerId, now)));
      } catch (error) {
        this.recordDiagnostic({
          source: "server",
          level: "error",
          category: "websocket",
          name: "snapshot_send_failed",
          playerId: attachment.playerId,
          payload: { error: error instanceof Error ? error.message : String(error) },
        });
        socket.close(1011, "Snapshot unavailable");
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/create" && request.method === "POST") {
      if (this.room) return apiError("room_exists", "Room code is already in use.", 409);
      const body = await this.jsonBody(request);
      if (!body.ok) return apiError("invalid_json", "Request body must be valid JSON.");
      const parsed = playerNameSchema.safeParse(body.value);
      if (!parsed.success) return apiError("invalid_name", "Enter a player name.");
      const hostId = crypto.randomUUID();
      const token = crypto.randomUUID();
      this.room = createRoomState({
        roomCode: String((body.value as Record<string, unknown>).roomCode),
        hostId,
        hostToken: token,
        hostName: parsed.data.name,
        now: Date.now(),
      });
      this.recordDiagnostic({
        source: "server",
        category: "party",
        name: "room_created",
        playerId: hostId,
        payload: { state: this.stateSummary() },
      });
      await this.persist(true);
      return json({
        roomCode: this.room.roomCode,
        playerId: hostId,
        token,
        snapshot: snapshotForPlayer(this.room, hostId, Date.now()),
      }, 201);
    }

    if (!this.room) return apiError("room_not_found", "Party was not found.", 404);

    if (url.pathname === "/internal/join" && request.method === "POST") {
      const body = await this.jsonBody(request);
      if (!body.ok) {
        this.recordDiagnostic({ source: "server", level: "warn", category: "request", name: "join_invalid_json" });
        return apiError("invalid_json", "Request body must be valid JSON.");
      }
      const parsed = playerNameSchema.safeParse(body.value);
      if (!parsed.success) {
        this.recordDiagnostic({ source: "server", level: "warn", category: "request", name: "join_invalid_name" });
        return apiError("invalid_name", "Enter a player name.");
      }
      const playerId = crypto.randomUUID();
      const token = crypto.randomUUID();
      const result = addPlayer(
        this.room,
        { playerId, token, name: parsed.data.name },
        this.context(),
      );
      if (!result.ok) {
        this.recordDiagnostic({
          source: "server",
          level: "warn",
          category: "party",
          name: "join_rejected",
          payload: { requestedName: parsed.data.name, result },
        });
        return apiError(result.code, result.message, 409);
      }
      this.recordDiagnostic({
        source: "server",
        category: "party",
        name: "player_joined",
        playerId,
        payload: { state: this.stateSummary() },
      });
      await this.persist(true);
      await this.broadcast();
      return json({
        roomCode: this.room.roomCode,
        playerId,
        token,
        snapshot: snapshotForPlayer(this.room, playerId, Date.now()),
      }, 201);
    }

    const playerId = this.authenticate(request);
    if (!playerId) {
      this.recordDiagnostic({
        source: "server", level: "warn", category: "authentication", name: "request_unauthorized",
        payload: { method: request.method, path: url.pathname },
      });
      return apiError("unauthorized", "Party credentials are invalid.", 401);
    }
    // Location, diagnostics, and snapshot routes already write a richer typed event.
    // Duplicating a generic event for those hot paths needlessly doubles SQLite writes.
    if (url.pathname !== "/internal/location"
      && url.pathname !== "/internal/diagnostics"
      && url.pathname !== "/internal/snapshot") {
      this.recordDiagnostic({
        source: "server", level: "debug", category: "request", name: "request_received", playerId,
        payload: { method: request.method, path: url.pathname },
      });
    }

    if (url.pathname === "/internal/diagnostics" && request.method === "POST") {
      const body = await this.jsonBody(request);
      if (!body.ok) return apiError("invalid_json", "Request body must be valid JSON.");
      const parsed = diagnosticBatchSchema.safeParse(body.value);
      if (!parsed.success) return apiError("invalid_diagnostics", "Diagnostics payload is invalid.");
      if (JSON.stringify(parsed.data).length > 1_000_000) {
        return apiError("diagnostics_too_large", "Diagnostics batch is too large.", 413);
      }
      const events = (parsed.data as DiagnosticBatchEnvelope).events;
      if (events.some((event) =>
        (event.payload?.roomCode !== undefined && event.payload.roomCode !== this.room!.roomCode) ||
        (event.payload?.playerId !== undefined && event.payload.playerId !== playerId)
      )) {
        return apiError("diagnostics_identity_mismatch", "Diagnostics belong to a different player or party.", 409);
      }
      if (!this.recordClientEvents(playerId, events)) {
        // A retry is safe because successfully written events are deduplicated.
        return apiError("diagnostics_unavailable", "Diagnostics could not be saved. Retry the upload.", 503);
      }
      return json({ ok: true, accepted: parsed.data.events.length });
    }

    if (url.pathname === "/internal/diagnostics" && request.method === "GET") {
      return this.diagnosticsPage(url, playerId);
    }

    if (url.pathname === "/internal/snapshot" && request.method === "GET") {
      const advanced = await this.advanceClock();
      this.recordDiagnostic({
        source: "server",
        category: "snapshot",
        name: "snapshot_requested",
        playerId,
        payload: { advancedClock: advanced, state: this.stateSummary() },
      });
      if (advanced) await this.broadcast();
      return json(snapshotForPlayer(this.room, playerId, Date.now()));
    }

    if (url.pathname === "/internal/command" && request.method === "POST") {
      const body = await this.jsonBody(request);
      if (!body.ok) return apiError("invalid_json", "Request body must be valid JSON.");
      const parsed = commandEnvelopeSchema.safeParse(body.value);
      if (!parsed.success) {
        this.recordDiagnostic({ source: "server", level: "warn", category: "command", name: "command_rejected_schema", playerId });
        return apiError("invalid_command", "Command payload is invalid.");
      }
      if (this.room.processedCommandIds.includes(parsed.data.commandId)) {
        this.recordDiagnostic({
          source: "server", category: "command", name: "command_duplicate", playerId,
          correlationId: parsed.data.commandId, payload: { command: parsed.data.command },
        });
        return json({ ok: true, code: "duplicate", message: "Command was already processed." });
      }
      const before = this.stateSummary();
      const actorName = this.room.players[playerId]?.name;
      const eventIds = new Set(this.room.events.map((event) => event.id));
      const versionBeforeCommand = this.room.version;
      const result = applyCommand(this.room, playerId, parsed.data as CommandEnvelope, this.context());
      this.recordDiagnostic({
        source: "server",
        level: result.ok ? "info" : "warn",
        category: "command",
        name: "command_processed",
        playerId,
        playerName: actorName,
        matchId: this.room.matchId ?? before?.matchId,
        correlationId: parsed.data.commandId,
        payload: {
          command: parsed.data.command,
          result,
          before,
          after: this.stateSummary(),
          gameEvents: this.room.events.filter((event) => !eventIds.has(event.id)),
        },
      });
      if (result.ok && parsed.data.command.type !== "leave_party") {
        this.room.processedCommandIds.push(parsed.data.commandId);
        this.room.processedCommandIds = this.room.processedCommandIds.slice(-200);
      }
      if (result.ok || this.room.version !== versionBeforeCommand) {
        await this.persist(true);
        await this.broadcast();
      }
      return json(result, result.ok ? 200 : 409);
    }

    if (url.pathname === "/internal/location" && request.method === "POST") {
      const body = await this.jsonBody(request);
      if (!body.ok) return apiError("invalid_json", "Request body must be valid JSON.");
      const parsed = locationEnvelopeSchema.safeParse(body.value);
      if (!parsed.success) {
        this.recordDiagnostic({ source: "server", level: "warn", category: "location", name: "location_rejected_schema", playerId });
        return apiError("invalid_location", "Location payload is invalid.");
      }
      const envelope = parsed.data as LocationEnvelope;
      const playerBefore = this.room.players[playerId];
      const speedLimitBefore = playerBefore.speedLimit
        ? { ...playerBefore.speedLimit, lastEvidence: playerBefore.speedLimit.lastEvidence ? { ...playerBefore.speedLimit.lastEvidence } : undefined }
        : undefined;
      const stateBefore = this.stateSummary();
      const eventIds = new Set(this.room.events.map((event) => event.id));
      const criticalBefore = {
        phase: this.room.phase,
        status: playerBefore.status,
        speedWarningEndsAt: playerBefore.speedLimit?.warningEndsAt,
        speedProbationEndsAt: playerBefore.speedLimit?.probationEndsAt,
        immobilizedTrapId: this.room.immobilized?.trapId,
        activeHiderCount: Object.values(this.room.players).filter(
          (player) => player.role === "hider" && player.status === "active",
        ).length,
      };
      const result = acceptLocation(
        this.room,
        playerId,
        envelope.fix,
        this.context(),
        envelope.deviceStatus,
      );
      this.recordDiagnostic({
        source: "server",
        level: result.ok ? "debug" : "warn",
        category: "location",
        name: "location_processed",
        playerId,
        correlationId: `${envelope.fix.sessionId}:${envelope.fix.sequence}`,
        payload: {
          fix: envelope.fix,
          deviceStatus: envelope.deviceStatus,
          result,
          speedLimitBefore,
          speedLimitAfter: this.room.players[playerId].speedLimit,
          before: stateBefore,
          after: this.stateSummary(),
          gameEvents: this.room.events.filter((event) => !eventIds.has(event.id)),
        },
      });
      if (result.ok || this.room.version !== stateBefore?.version) {
        const criticalChange =
          this.room.phase !== criticalBefore.phase ||
          this.room.players[playerId].status !== criticalBefore.status ||
          this.room.players[playerId].speedLimit?.warningEndsAt !== criticalBefore.speedWarningEndsAt ||
          this.room.players[playerId].speedLimit?.probationEndsAt !== criticalBefore.speedProbationEndsAt ||
          this.room.immobilized?.trapId !== criticalBefore.immobilizedTrapId ||
          Object.values(this.room.players).filter(
            (player) => player.role === "hider" && player.status === "active",
          ).length !== criticalBefore.activeHiderCount;
        // Lobby tracking is intentionally one-shot, so there may be no later
        // location request to checkpoint this readiness fix before hibernation.
        const lobbyReadinessFix = result.ok && stateBefore?.phase === "lobby";
        await this.persist(criticalChange || !result.ok || lobbyReadinessFix);
        await this.broadcast();
      }
      return json({ ...result, snapshot: snapshotForPlayer(this.room, playerId, Date.now()) }, result.ok ? 200 : 409);
    }

    if (url.pathname === "/internal/connect" && request.headers.get("Upgrade") === "websocket") {
      if (request.headers.get("X-Protocol-Version") !== String(PROTOCOL_VERSION)) {
        return apiError("protocol_mismatch", "Update the app before continuing.", 426);
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ playerId } satisfies SocketAttachment);
      if (!this.room.players[playerId].connected) {
        this.room.players[playerId].connected = true;
        this.room.version += 1;
      }
      this.recordDiagnostic({
        source: "server", category: "websocket", name: "connected", playerId,
        payload: { socketCount: this.ctx.getWebSockets().length },
      });
      await this.persist(true);
      const protocol = request.headers.get("X-WebSocket-Protocol");
      const response = new Response(null, {
        status: 101,
        webSocket: client,
        headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : undefined,
      });
      this.ctx.waitUntil(this.broadcast());
      return response;
    }

    return apiError("not_found", "Route was not found.", 404);
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!this.room || !attachment) return;
    const stillConnected = this.ctx.getWebSockets().some((candidate) => {
      const other = candidate.deserializeAttachment() as SocketAttachment | null;
      return candidate !== socket && candidate.readyState === WebSocket.OPEN && other?.playerId === attachment.playerId;
    });
    if (!stillConnected && this.room.players[attachment.playerId]?.connected) {
      this.room.players[attachment.playerId].connected = false;
      this.room.version += 1;
      this.recordDiagnostic({
        source: "server", category: "websocket", name: "disconnected", playerId: attachment.playerId,
        payload: { socketCount: this.ctx.getWebSockets().length },
      });
      await this.persist(true);
      await this.broadcast();
    }
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    socket.close(1011, "Connection failed");
    await this.webSocketClose(socket);
  }

  webSocketMessage(socket: WebSocket): void {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    this.recordDiagnostic({
      source: "server", level: "warn", category: "websocket", name: "unexpected_client_message",
      playerId: attachment?.playerId,
    });
    socket.send(JSON.stringify({ type: "error", code: "receive_only", error: "Use the authenticated HTTP command endpoint." }));
  }
}
