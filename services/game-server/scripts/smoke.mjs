import assert from "node:assert/strict";

const baseUrl = process.env.GAME_SERVER_URL ?? "http://127.0.0.1:8787";
const protocolVersion = 2;

async function jsonRequest(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json();
  assert.equal(response.ok, true, `${response.status}: ${body.error ?? "request failed"}`);
  return body;
}

async function errorRequest(path, init, expectedStatus, expectedCode) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(body));
  assert.equal(body.code, expectedCode);
  return body;
}

await errorRequest("/rooms", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{",
}, 400, "invalid_json");

const host = await jsonRequest("/rooms", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Smoke Host" }),
});
const guest = await jsonRequest(`/rooms/${host.roomCode}/join`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Smoke Guest" }),
});

await errorRequest(`/rooms/${host.roomCode}/snapshot`, { method: "GET" }, 401, "unauthorized");
await errorRequest(`/rooms/${host.roomCode}/snapshot`, {
  method: "GET",
  headers: { Authorization: "Bearer invalid-token" },
}, 401, "unauthorized");

const socketBase = baseUrl.replace(/^http/, "ws");
const socket = new WebSocket(
  `${socketBase}/rooms/${guest.roomCode}/connect?v=${protocolVersion}`,
  [`game-token.${guest.token}`],
);
const firstSnapshot = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket snapshot")), 5_000);
  socket.addEventListener("message", (event) => {
    clearTimeout(timeout);
    resolve(JSON.parse(String(event.data)));
  }, { once: true });
  socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
});

assert.equal(firstSnapshot.type, "snapshot");
assert.equal(firstSnapshot.selfId, guest.playerId);
assert.equal(firstSnapshot.players.length, 2);

const authorized = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});
const now = Date.now();
await errorRequest(`/rooms/${host.roomCode}/location`, {
  method: "POST",
  headers: authorized(host.token),
  body: JSON.stringify({
    protocolVersion,
    fix: { latitude: 91, longitude: -118, accuracyMeters: 2, sampledAtMs: now, sampleAgeMs: 0, sequence: 1, sessionId: "invalid-location" },
  }),
}, 400, "invalid_location");
await jsonRequest(`/rooms/${host.roomCode}/location`, {
  method: "POST",
  headers: authorized(host.token),
  body: JSON.stringify({
    protocolVersion,
    fix: { latitude: 34, longitude: -118, accuracyMeters: 2, sampledAtMs: now, sampleAgeMs: 0, sequence: 1, sessionId: "smoke-host-session" },
    deviceStatus: { batteryPercent: 72, isCharging: false, networkType: "wifi", isInternetReachable: true },
  }),
});
await jsonRequest(`/rooms/${guest.roomCode}/location`, {
  method: "POST",
  headers: authorized(guest.token),
  body: JSON.stringify({
    protocolVersion,
    fix: { latitude: 34.0001, longitude: -118, accuracyMeters: 2, sampledAtMs: now, sampleAgeMs: 0, sequence: 1, sessionId: "smoke-guest-session" },
  }),
});

async function command(session, commandId, value) {
  return jsonRequest(`/rooms/${session.roomCode}/command`, {
    method: "POST",
    headers: authorized(session.token),
    body: JSON.stringify({ protocolVersion, commandId, command: value }),
  });
}

await command(host, "smoke-boundary", {
  type: "set_boundary",
  boundary: [
    { latitude: 33.999, longitude: -118.001 },
    { latitude: 33.999, longitude: -117.999 },
    { latitude: 34.001, longitude: -117.999 },
    { latitude: 34.001, longitude: -118.001 },
  ],
});
await command(host, "smoke-seeker", { type: "set_seeker", playerId: guest.playerId });
const duplicate = await command(host, "smoke-seeker", { type: "set_seeker", playerId: guest.playerId });
assert.equal(duplicate.code, "duplicate");
const start = await command(host, "smoke-start", { type: "start_match" });
assert.equal(start.ok, true);
const pause = await command(host, "smoke-pause", { type: "pause_match" });
assert.equal(pause.ok, true);
const pausedSnapshot = await jsonRequest(`/rooms/${host.roomCode}/snapshot`, {
  method: "GET",
  headers: authorized(host.token),
});
assert.equal(pausedSnapshot.phase, "paused");
const resume = await command(host, "smoke-resume", { type: "resume_match" });
assert.equal(resume.ok, true);

await errorRequest(`/rooms/${guest.roomCode}/command`, {
  method: "POST",
  headers: authorized(guest.token),
  body: JSON.stringify({ protocolVersion, commandId: "smoke-early-radar", command: { type: "use_radar" } }),
}, 409, "wrong_phase");

await errorRequest(`/rooms/${host.roomCode}/location`, {
  method: "POST",
  headers: authorized(host.token),
  body: JSON.stringify({
    protocolVersion,
    fix: { latitude: 34, longitude: -118, accuracyMeters: 2, sampledAtMs: now, sampleAgeMs: 0, sequence: 1, sessionId: "smoke-host-session" },
  }),
}, 409, "replayed_location");

const seekerSnapshot = await jsonRequest(`/rooms/${guest.roomCode}/snapshot`, {
  method: "GET",
  headers: authorized(guest.token),
});
assert.equal(seekerSnapshot.phase, "hiding");
assert.equal(
  seekerSnapshot.players.find((player) => player.id === host.playerId).location,
  undefined,
  "The seeker received a hidden hider location",
);

const hiderSnapshot = await jsonRequest(`/rooms/${host.roomCode}/snapshot`, {
  method: "GET",
  headers: authorized(host.token),
});
assert.equal(hiderSnapshot.players.find((player) => player.id === host.playerId).gpsStatus, "live");
assert.equal(
  hiderSnapshot.players.find((player) => player.id === host.playerId).deviceStatus.batteryPercent,
  72,
);

await jsonRequest(`/rooms/${host.roomCode}/diagnostics`, {
  method: "POST",
  headers: authorized(host.token),
  body: JSON.stringify({
    protocolVersion,
    events: [{
      id: "smoke-diagnostic-event",
      appSessionId: "smoke-app-session",
      clientAtMs: Date.now(),
      level: "info",
      category: "smoke",
      name: "client_event_uploaded",
      matchId: hiderSnapshot.matchId,
      correlationId: "smoke-start",
      payload: { expected: true, nested: { token: "test-secret-must-not-appear" } },
    }],
  }),
});
await errorRequest(`/rooms/${guest.roomCode}/diagnostics`, {
  method: "GET",
  headers: authorized(guest.token),
}, 403, "host_only");
await errorRequest(`/rooms/${host.roomCode}/diagnostics`, {
  method: "GET",
  headers: authorized(host.token),
}, 409, "match_in_progress");
await command(guest, "smoke-leave-party", { type: "leave_party" });
await errorRequest(`/rooms/${guest.roomCode}/snapshot`, {
  method: "GET",
  headers: authorized(guest.token),
}, 401, "unauthorized");
socket.close();
const diagnostics = await jsonRequest(`/rooms/${host.roomCode}/diagnostics?limit=1000`, {
  method: "GET",
  headers: authorized(host.token),
});
assert.equal(diagnostics.events.some((event) => event.source === "client" && event.id === "smoke-diagnostic-event"), true);
assert.equal(diagnostics.events.some((event) => event.source === "server" && event.name === "command_processed"), true);
assert.equal(diagnostics.events.some((event) => event.source === "server" && event.name === "location_processed"), true);
assert.equal(diagnostics.events.every((event) => !JSON.stringify(event).includes(host.token)), true);
assert.equal(diagnostics.events.every((event) => !JSON.stringify(event).includes("test-secret-must-not-appear")), true);
let after = 0;
let untilSequence;
const paginatedEvents = [];
for (let pageNumber = 0; ; pageNumber += 1) {
  assert.ok(pageNumber < 100, "Diagnostic export did not terminate");
  const page = await jsonRequest(`/rooms/${host.roomCode}/diagnostics?limit=5&after=${after}${untilSequence === undefined ? "" : `&untilSequence=${untilSequence}`}`, {
    method: "GET", headers: authorized(host.token),
  });
  untilSequence ??= page.untilSequence;
  assert.equal(page.untilSequence, untilSequence);
  paginatedEvents.push(...page.events);
  if (!page.nextAfter) break;
  assert.ok(page.nextAfter > after, "Diagnostic export cursor did not advance");
  after = page.nextAfter;
}
assert.ok(paginatedEvents.some((event) => event.id === "smoke-diagnostic-event"));
assert.equal(
  hiderSnapshot.players.find((player) => player.id === guest.playerId).location,
  undefined,
  "A hider received the hidden seeker location",
);

console.log(JSON.stringify({
  ok: true,
  roomCodeLength: host.roomCode.length,
  websocketSnapshot: true,
  hiddenLocationsProtected: true,
  authenticationProtected: true,
  duplicateCommandProtected: true,
  replayedLocationProtected: true,
  revokedTokenProtected: true,
  matchStarted: true,
  hostPauseResumed: true,
  playerHealthReported: true,
  diagnosticsCaptured: true,
  players: firstSnapshot.players.length,
}));
