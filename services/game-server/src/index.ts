import { apiError, corsHeaders, json } from "./http";
export { GameRoom } from "./room";

function roomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
}

function roomStub(env: Env, code: string) {
  return env.GAME_ROOMS.getByName(code);
}

function normalizedCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "hide-and-seek-game-server" });

    if (url.pathname === "/rooms" && request.method === "POST") {
      let body: Record<string, unknown>;
      try {
        const parsed = await request.json();
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid body");
        body = parsed as Record<string, unknown>;
      } catch {
        return apiError("invalid_json", "Request body must be a JSON object.");
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = roomCode();
        const response = await roomStub(env, code).fetch("https://room/internal/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, roomCode: code }),
        });
        if (response.status !== 409) return response;
      }
      return apiError("capacity", "Could not allocate a party code. Try again.", 503);
    }

    const match = url.pathname.match(/^\/rooms\/([^/]+)\/(join|snapshot|command|location|connect|diagnostics)$/);
    if (!match) return apiError("not_found", "Route was not found.", 404);
    const rawCode = match[1];
    const code = normalizedCode(rawCode);
    if (code.length !== 6 || rawCode.toUpperCase() !== code) {
      return apiError("invalid_room_code", "Party code must contain six valid characters.");
    }
    const action = match[2];
    const headers = new Headers(request.headers);

    if (action === "connect") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return apiError("upgrade_required", "WebSocket upgrade required.", 426);
      }
      const offeredProtocol = request.headers.get("Sec-WebSocket-Protocol") ?? "";
      const prefix = "game-token.";
      if (!offeredProtocol.startsWith(prefix)) return apiError("unauthorized", "Missing socket credentials.", 401);
      headers.set("X-Player-Token", offeredProtocol.slice(prefix.length));
      headers.set("X-WebSocket-Protocol", offeredProtocol);
      headers.set("X-Protocol-Version", url.searchParams.get("v") ?? "");
    }

    return roomStub(env, code).fetch(`https://room/internal/${action}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" ? undefined : request.body,
    });
  },
} satisfies ExportedHandler<Env>;
