import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { analyzeDiagnostics, renderTextReport } from "./field-test-analyzer.mjs";

function event(overrides) {
  return {
    sequence: 1,
    serverAtMs: 100_000,
    clientAtMs: 100_000,
    source: "server",
    roomCode: "ABC234",
    appSessionId: "server",
    id: crypto.randomUUID(),
    level: "debug",
    category: "location",
    name: "location_processed",
    playerId: "player-1",
    playerName: "Alex",
    payload: {},
    ...overrides,
  };
}

function locationEvents({ intervals = 25, slowEvery = 0 } = {}) {
  const events = [event({
    source: "client",
    category: "lifecycle",
    name: "app_state_changed",
    clientAtMs: 99_000,
    payload: { nextState: "background" },
  })];
  let serverAtMs = 100_000;
  for (let index = 0; index <= intervals; index += 1) {
    if (index > 0) serverAtMs += slowEvery && index % slowEvery === 0 ? 5_000 : 1_000;
    events.push(event({
      sequence: index + 2,
      serverAtMs,
      clientAtMs: serverAtMs,
      payload: {
        fix: {
          latitude: index * 0.00001,
          longitude: 0,
          accuracyMeters: 5 + (index % 2),
          sampledAtMs: 100_000 + index * 1_000,
          sampleAgeMs: 100 + index,
          sequence: index,
          sessionId: "location-session",
        },
        deviceStatus: { batteryPercent: 90, isCharging: false, networkType: index < 10 ? "wifi" : "cellular" },
        result: { ok: true },
      },
    }));
  }
  return events;
}

test("provisionally passes enough timely locked-screen movement without leaking coordinates", () => {
  const report = analyzeDiagnostics({ formatVersion: 1, roomCode: "ABC234", matchId: "match-1", events: locationEvents() });
  assert.equal(report.automatedGate.status, "provisional-pass");
  assert.equal(report.automatedGate.basis, "background-estimated-moving-intervals");
  assert.equal(report.automatedGate.timelyPercent, 100);
  assert.equal(report.players[0].networkSwitches, 1);
  assert.doesNotMatch(JSON.stringify(report), /latitude|longitude/);
  assert.match(renderTextReport(report), /overall field gate still requires the manual checks/i);
});

test("fails when fewer than 95 percent of moving fixes arrive within three seconds", () => {
  const report = analyzeDiagnostics({ formatVersion: 1, events: locationEvents({ intervals: 25, slowEvery: 5 }) });
  assert.equal(report.automatedGate.status, "fail");
  assert.equal(report.automatedGate.timelyPercent, 80);
  assert.equal(report.summary.longGaps, 5);
});

test("reports reconnect duration, rejected fixes, and deduplicated game outcomes", () => {
  const gameEvent = { id: "tagged-1", at: 103_000, type: "player_tagged", targetId: "player-2", tagMethod: "manual" };
  const events = [
    ...locationEvents({ intervals: 2 }),
    event({ source: "client", category: "realtime", name: "websocket_closed", clientAtMs: 120_000 }),
    event({ source: "client", category: "realtime", name: "websocket_opened", clientAtMs: 122_500 }),
    event({ serverAtMs: 103_000, name: "command_processed", category: "command", payload: { command: { type: "tag" }, result: { ok: true }, gameEvents: [gameEvent] } }),
    event({ serverAtMs: 130_000, name: "location_processed", payload: {
      fix: { latitude: 1, longitude: 1, sampledAtMs: 130_000, sampleAgeMs: 4_000, accuracyMeters: 20 },
      result: { ok: false }, gameEvents: [gameEvent],
    } }),
  ];
  const report = analyzeDiagnostics({ events });
  assert.equal(report.reconnects.completed, 1);
  assert.equal(report.reconnects.durationMs.p95, 2_500);
  assert.equal(report.summary.rejectedLocations, 1);
  assert.equal(report.gameplay.tagAttempts, 1);
  assert.equal(report.gameplay.playersTagged, 1);
  assert.equal(report.gameplay.manualTags, 1);
  assert.equal(report.gameplay.automaticTags, 0);
  assert.equal(report.gameplay.decisionEvidence.count, 2);
  assert.equal(report.gameplay.decisionEvidence.decisions[0].participants[0].accuracyMeters, 5);
});

test("separates automatic tags from manual tag attempts", () => {
  const automaticTag = {
    id: "auto-tagged-1",
    at: 103_000,
    type: "player_tagged",
    actorId: "player-1",
    targetId: "player-2",
    tagMethod: "automatic",
  };
  const report = analyzeDiagnostics({
    events: [
      ...locationEvents({ intervals: 2 }),
      event({ serverAtMs: 103_000, name: "location_processed", payload: {
        result: { ok: true },
        gameEvents: [automaticTag],
      } }),
    ],
  });
  assert.equal(report.gameplay.playersTagged, 1);
  assert.equal(report.gameplay.automaticTags, 1);
  assert.equal(report.gameplay.manualTags, 0);
  assert.equal(report.gameplay.tagAttempts, 0);
  assert.equal(
    report.gameplay.decisionEvidence.decisions.find((decision) => decision.type === "player_tagged")?.tagMethod,
    "automatic",
  );
});

test("does not count stale or rejected moving fixes as timely", () => {
  const events = locationEvents();
  const locations = events.filter((value) => value.name === "location_processed");
  locations[5].payload.fix.sampleAgeMs = 5_000;
  locations[10].payload.result.ok = false;
  const report = analyzeDiagnostics({ events });
  assert.equal(report.automatedGate.status, "fail");
  assert.equal(report.automatedGate.timelyPercent, 92);
});

test("rejects malformed and future-format exports", () => {
  assert.throws(() => analyzeDiagnostics({}), /events array/);
  assert.throws(() => analyzeDiagnostics({ formatVersion: 2, events: [] }), /Unsupported/);
});

test("does not let one healthy phone hide another rostered phone with no fixes", () => {
  const events = locationEvents();
  events.push(event({
    source: "client",
    category: "state",
    name: "snapshot_received",
    payload: { players: [
      { id: "player-1", name: "Alex" },
      { id: "player-2", name: "Blair" },
    ] },
  }));
  const report = analyzeDiagnostics({ events });
  assert.equal(report.automatedGate.status, "insufficient-data");
  assert.equal(report.players.find((player) => player.id === "player-2").fixes, 0);
  assert.match(report.automatedGate.reason, /Blair/);
});

test("CLI reads an export and emits text or summarized JSON", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "out-of-sight-field-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const exportPath = join(directory, "diagnostics.json");
  await writeFile(exportPath, JSON.stringify({ formatVersion: 1, roomCode: "ABC234", events: locationEvents() }));
  const cliPath = fileURLToPath(new URL("./field-test-analyzer.mjs", import.meta.url));
  const textResult = spawnSync(process.execPath, [cliPath, exportPath], { encoding: "utf8" });
  assert.equal(textResult.status, 0, textResult.stderr);
  assert.match(textResult.stdout, /Automated gate: PROVISIONAL-PASS/);
  const jsonResult = spawnSync(process.execPath, [cliPath, exportPath, "--json"], { encoding: "utf8" });
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  assert.equal(JSON.parse(jsonResult.stdout).summary.locationFixes, 26);
});
