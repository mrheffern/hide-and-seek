import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const DEFAULT_THRESHOLDS = Object.freeze({
  timelyFixMs: 3_000,
  longGapMs: 4_000,
  movingSpeedMetersPerSecond: 0.5,
  minimumMovingIntervals: 20,
  requiredTimelyPercent: 95,
});

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function percentage(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 10_000) / 100 : null;
}

function quantile(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const value = lower === upper
    ? sorted[lower]
    : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  return Math.round(value * 100) / 100;
}

function distribution(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  return {
    count: usable.length,
    p50: quantile(usable, 0.5),
    p95: quantile(usable, 0.95),
    max: usable.length ? usable.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : null,
  };
}

function distanceMeters(a, b) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitude1 = radians(a.latitude);
  const latitude2 = radians(b.latitude);
  const latitudeDelta = latitude2 - latitude1;
  const longitudeDelta = radians(b.longitude - a.longitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function playerKey(event) {
  return typeof event.playerId === "string" && event.playerId ? event.playerId : "unknown-player";
}

function playerName(event) {
  return typeof event.playerName === "string" && event.playerName ? event.playerName : undefined;
}

function eventClientTime(event) {
  return finiteNumber(event.clientAtMs) ?? finiteNumber(event.serverAtMs) ?? 0;
}

function eventServerTime(event) {
  return finiteNumber(event.serverAtMs) ?? finiteNumber(event.clientAtMs) ?? 0;
}

function payloadOf(event) {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload
    : {};
}

function deviceStatusOf(payload) {
  const value = payload.deviceStatus;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeInput(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("Diagnostics export must be a JSON object.");
  }
  if (document.formatVersion !== undefined && document.formatVersion !== 1) {
    throw new Error(`Unsupported diagnostics formatVersion: ${String(document.formatVersion)}.`);
  }
  if (!Array.isArray(document.events)) {
    throw new Error("Diagnostics export is missing its events array.");
  }
  const events = document.events.filter((event) => event && typeof event === "object" && !Array.isArray(event));
  if (events.length !== document.events.length) {
    throw new Error("Diagnostics export contains a malformed event.");
  }
  return { document, events };
}

function assignAppStates(fixes, stateEvents) {
  const sortedStates = [...stateEvents].sort((a, b) => a.at - b.at);
  let stateIndex = 0;
  let currentState = "unknown";
  for (const fix of fixes) {
    while (stateIndex < sortedStates.length && sortedStates[stateIndex].at <= fix.sampledAtMs) {
      currentState = sortedStates[stateIndex].state;
      stateIndex += 1;
    }
    fix.appState = currentState;
  }
}

function batterySummary(fixes) {
  const samples = fixes.filter((fix) => finiteNumber(fix.deviceStatus.batteryPercent) !== undefined);
  if (!samples.length) {
    return { samples: 0, firstPercent: null, lastPercent: null, changePoints: null, drainPerHour: null, chargingObserved: false };
  }
  const first = samples[0];
  const last = samples.at(-1);
  const firstPercent = finiteNumber(first.deviceStatus.batteryPercent);
  const lastPercent = finiteNumber(last.deviceStatus.batteryPercent);
  const changePoints = Math.round((lastPercent - firstPercent) * 100) / 100;
  const durationMs = last.serverAtMs - first.serverAtMs;
  const chargingObserved = samples.some((sample) => sample.deviceStatus.isCharging === true);
  const drainPerHour = !chargingObserved && durationMs >= 5 * 60_000
    ? Math.round(((firstPercent - lastPercent) / (durationMs / 3_600_000)) * 100) / 100
    : null;
  return { samples: samples.length, firstPercent, lastPercent, changePoints, drainPerHour, chargingObserved };
}

function reconnectSummary(events) {
  const byPlayer = new Map();
  for (const event of events) {
    if (event.source !== "client" || event.category !== "realtime") continue;
    const key = playerKey(event);
    const state = byPlayer.get(key) ?? { outageStartedAt: undefined, durations: [], unresolved: 0 };
    const at = eventClientTime(event);
    if (event.name === "websocket_closed" && state.outageStartedAt === undefined) state.outageStartedAt = at;
    if (event.name === "websocket_opened" && state.outageStartedAt !== undefined) {
      if (at >= state.outageStartedAt) state.durations.push(at - state.outageStartedAt);
      state.outageStartedAt = undefined;
    }
    byPlayer.set(key, state);
  }
  const durations = [];
  let unresolved = 0;
  for (const state of byPlayer.values()) {
    durations.push(...state.durations);
    if (state.outageStartedAt !== undefined) unresolved += 1;
  }
  return { completed: durations.length, unresolved, durationMs: distribution(durations) };
}

function gameplaySummary(events) {
  const gameEvents = new Map();
  let tagAttempts = 0;
  let acceptedTagAttempts = 0;
  const tagRejections = {};
  for (const event of events) {
    const payload = payloadOf(event);
    if (event.source === "server" && event.name === "command_processed" && payload.command?.type === "tag") {
      tagAttempts += 1;
      if (payload.result?.ok === true) acceptedTagAttempts += 1;
      else {
        const code = typeof payload.result?.code === "string" ? payload.result.code : "unknown";
        tagRejections[code] = (tagRejections[code] ?? 0) + 1;
      }
    }
    if (Array.isArray(payload.gameEvents)) {
      for (const gameEvent of payload.gameEvents) {
        if (!gameEvent || typeof gameEvent !== "object") continue;
        const id = typeof gameEvent.id === "string"
          ? gameEvent.id
          : `${String(gameEvent.type)}:${String(gameEvent.at)}:${String(gameEvent.targetId)}`;
        gameEvents.set(id, gameEvent);
      }
    }
  }
  const count = (type) => [...gameEvents.values()].filter((event) => event.type === type).length;
  const tags = [...gameEvents.values()].filter((event) => event.type === "player_tagged");
  return {
    tagAttempts,
    acceptedTagAttempts,
    tagRejections,
    playersTagged: tags.length,
    automaticTags: tags.filter((event) => event.tagMethod === "automatic").length,
    manualTags: tags.filter((event) => event.tagMethod === "manual").length,
    legacyTags: tags.filter((event) => event.tagMethod !== "automatic" && event.tagMethod !== "manual").length,
    trapsPlaced: count("trap_placed"),
    trapsTriggered: count("trap_triggered"),
    trapsReleased: count("trap_released"),
    boundaryEliminations: count("boundary_eliminated"),
    speedWarnings: count("speed_warning"),
    speedProbations: count("speed_probation"),
    speedProbationsEnded: count("speed_probation_ended"),
    speedDisqualifications: count("speed_disqualified"),
  };
}

function nearestPriorFix(players, id, atMs) {
  if (!id) return undefined;
  const player = players.get(id);
  if (!player?.fixes.length) return { playerId: id, playerName: player?.name, available: false };
  let candidate;
  for (const fix of player.fixes) {
    if (fix.serverAtMs > atMs) break;
    candidate = fix;
  }
  if (!candidate) return { playerId: id, playerName: player.name, available: false };
  return {
    playerId: id,
    playerName: player.name,
    available: true,
    receivedBeforeDecisionMs: Math.max(0, atMs - candidate.serverAtMs),
    sampleAgeMs: candidate.sampleAgeMs,
    accuracyMeters: candidate.accuracyMeters,
    accepted: candidate.accepted,
    appState: candidate.appState,
    networkType: typeof candidate.deviceStatus.networkType === "string"
      ? candidate.deviceStatus.networkType
      : "unknown",
  };
}

function decisionEvidence(events, players) {
  const decisions = [];
  const seenGameEvents = new Set();
  for (const event of events) {
    if (event.source !== "server") continue;
    const payload = payloadOf(event);
    const atMs = eventServerTime(event);
    if (event.name === "command_processed" && payload.command?.type === "tag") {
      decisions.push({
        type: "tag_attempt",
        atMs,
        accepted: payload.result?.ok === true,
        resultCode: typeof payload.result?.code === "string" ? payload.result.code : undefined,
        participants: [nearestPriorFix(players, event.playerId, atMs)].filter(Boolean),
      });
    }
    if (!Array.isArray(payload.gameEvents)) continue;
    for (const gameEvent of payload.gameEvents) {
      if (!gameEvent || typeof gameEvent !== "object"
        || ![
          "player_tagged",
          "trap_triggered",
          "trap_released",
          "boundary_eliminated",
          "speed_warning",
          "speed_probation",
          "speed_probation_ended",
          "speed_disqualified",
        ].includes(gameEvent.type)) continue;
      const id = typeof gameEvent.id === "string"
        ? gameEvent.id
        : `${String(gameEvent.type)}:${String(gameEvent.at)}:${String(gameEvent.targetId)}`;
      if (seenGameEvents.has(id)) continue;
      seenGameEvents.add(id);
      const participantIds = [...new Set([gameEvent.actorId, gameEvent.targetId, event.playerId]
        .filter((value) => typeof value === "string"))];
      decisions.push({
        type: gameEvent.type,
        tagMethod: gameEvent.type === "player_tagged" && typeof gameEvent.tagMethod === "string"
          ? gameEvent.tagMethod
          : undefined,
        gameEventId: typeof gameEvent.id === "string" ? gameEvent.id : undefined,
        atMs: finiteNumber(gameEvent.at) ?? atMs,
        speedEvidence: gameEvent.speedEvidence && typeof gameEvent.speedEvidence === "object"
          ? {
              evaluatedMetersPerSecond: finiteNumber(gameEvent.speedEvidence.evaluatedMetersPerSecond),
              nativeMetersPerSecond: finiteNumber(gameEvent.speedEvidence.nativeMetersPerSecond),
              displacementMetersPerSecond: finiteNumber(gameEvent.speedEvidence.displacementMetersPerSecond),
            }
          : undefined,
        participants: participantIds.map((idValue) => nearestPriorFix(players, idValue, atMs)),
      });
    }
  }
  decisions.sort((a, b) => a.atMs - b.atMs);
  return {
    count: decisions.length,
    truncated: decisions.length > 200,
    decisions: decisions.slice(0, 200),
  };
}

function publicGap(gap) {
  return {
    playerId: gap.playerId,
    playerName: gap.playerName,
    endedAtMs: gap.endedAtMs,
    receiptIntervalMs: gap.receiptIntervalMs,
    sampleIntervalMs: gap.sampleIntervalMs,
    estimatedSpeedMetersPerSecond: gap.estimatedSpeedMetersPerSecond,
    appState: gap.appState,
    networkType: gap.networkType,
  };
}

export function analyzeDiagnostics(document, customThresholds = {}) {
  const { document: source, events } = normalizeInput(document);
  const thresholds = { ...DEFAULT_THRESHOLDS, ...customThresholds };
  const players = new Map();
  const stateEvents = new Map();
  let malformedLocationEvents = 0;
  let rejectedLocations = 0;
  let clientLocationFailures = 0;

  const ensurePlayerId = (id, name) => {
    const existing = players.get(id) ?? {
      id,
      name,
      device: undefined,
      fixes: [],
    };
    existing.name ??= name;
    players.set(id, existing);
    return existing;
  };
  const ensurePlayer = (event) => ensurePlayerId(playerKey(event), playerName(event));

  for (const event of events) {
    const player = ensurePlayer(event);
    const payload = payloadOf(event);
    if (event.source === "client" && event.name === "snapshot_received" && Array.isArray(payload.players)) {
      for (const visiblePlayer of payload.players) {
        if (!visiblePlayer || typeof visiblePlayer !== "object" || typeof visiblePlayer.id !== "string") continue;
        ensurePlayerId(
          visiblePlayer.id,
          typeof visiblePlayer.name === "string" ? visiblePlayer.name : undefined,
        );
      }
    }
    if (event.source === "client" && event.name === "app_launched") {
      player.device = {
        manufacturer: typeof payload.manufacturer === "string" ? payload.manufacturer : undefined,
        model: typeof payload.modelName === "string" ? payload.modelName : undefined,
        os: [payload.osName, payload.osVersion].filter((value) => typeof value === "string").join(" ") || undefined,
        appVersion: typeof payload.appVersion === "string" ? payload.appVersion : undefined,
        buildVersion: typeof payload.buildVersion === "string" ? payload.buildVersion : undefined,
      };
    }
    if (event.source === "client" && event.name === "app_state_changed" && typeof payload.nextState === "string") {
      const states = stateEvents.get(player.id) ?? [];
      states.push({ at: eventClientTime(event), state: payload.nextState });
      stateEvents.set(player.id, states);
    }
    if (event.source === "client" && event.category === "location"
      && ["location_processing_failed", "native_background_task_failed"].includes(event.name)) {
      clientLocationFailures += 1;
    }
    if (event.source !== "server" || event.name !== "location_processed") continue;
    const fix = payload.fix;
    if (!fix || typeof fix !== "object") {
      malformedLocationEvents += 1;
      continue;
    }
    const latitude = finiteNumber(fix.latitude);
    const longitude = finiteNumber(fix.longitude);
    const sampledAtMs = finiteNumber(fix.sampledAtMs);
    const serverAtMs = finiteNumber(event.serverAtMs);
    if (latitude === undefined || longitude === undefined || sampledAtMs === undefined || serverAtMs === undefined) {
      malformedLocationEvents += 1;
      continue;
    }
    if (payload.result?.ok === false) rejectedLocations += 1;
    player.fixes.push({
      latitude,
      longitude,
      sampledAtMs,
      serverAtMs,
      sampleAgeMs: finiteNumber(fix.sampleAgeMs),
      accuracyMeters: finiteNumber(fix.accuracyMeters),
      sessionId: typeof fix.sessionId === "string" ? fix.sessionId : undefined,
      deviceStatus: deviceStatusOf(payload),
      accepted: payload.result?.ok !== false,
      appState: "unknown",
    });
  }

  const allIntervals = [];
  const allGaps = [];
  const playerReports = [];
  for (const player of players.values()) {
    if (!player.fixes.length && player.id === "unknown-player") continue;
    player.fixes.sort((a, b) => a.serverAtMs - b.serverAtMs);
    assignAppStates(player.fixes, stateEvents.get(player.id) ?? []);
    const intervals = [];
    const networkTypes = {};
    let networkSwitches = 0;
    let previousNetwork;
    for (const fix of player.fixes) {
      const network = typeof fix.deviceStatus.networkType === "string" ? fix.deviceStatus.networkType : "unknown";
      networkTypes[network] = (networkTypes[network] ?? 0) + 1;
      if (previousNetwork && network !== previousNetwork) networkSwitches += 1;
      previousNetwork = network;
    }
    for (let index = 1; index < player.fixes.length; index += 1) {
      const previous = player.fixes[index - 1];
      const current = player.fixes[index];
      const receiptIntervalMs = current.serverAtMs - previous.serverAtMs;
      const sampleIntervalMs = current.sampledAtMs - previous.sampledAtMs;
      if (receiptIntervalMs < 0 || sampleIntervalMs <= 0) continue;
      const speed = distanceMeters(previous, current) / (sampleIntervalMs / 1_000);
      const fresh = current.sampleAgeMs !== undefined && current.sampleAgeMs <= thresholds.timelyFixMs;
      const interval = {
        playerId: player.id,
        playerName: player.name,
        endedAtMs: current.serverAtMs,
        receiptIntervalMs,
        sampleIntervalMs,
        estimatedSpeedMetersPerSecond: Math.round(speed * 100) / 100,
        moving: speed >= thresholds.movingSpeedMetersPerSecond,
        timely: receiptIntervalMs <= thresholds.timelyFixMs && fresh && current.accepted,
        sampleAgeMs: current.sampleAgeMs,
        accepted: current.accepted,
        appState: current.appState,
        networkType: typeof current.deviceStatus.networkType === "string" ? current.deviceStatus.networkType : "unknown",
      };
      intervals.push(interval);
      allIntervals.push(interval);
      if (receiptIntervalMs > thresholds.longGapMs) {
        allGaps.push(interval);
      }
    }
    const moving = intervals.filter((interval) => interval.moving);
    const backgroundMoving = moving.filter((interval) => interval.appState === "background");
    const useBackgroundForGate = backgroundMoving.length >= thresholds.minimumMovingIntervals;
    const gateIntervals = useBackgroundForGate ? backgroundMoving : moving;
    const timelyGateIntervals = gateIntervals.filter((interval) => interval.timely);
    const timelyGatePercent = percentage(timelyGateIntervals.length, gateIntervals.length);
    const gateStatus = gateIntervals.length < thresholds.minimumMovingIntervals
      ? "insufficient-data"
      : timelyGatePercent >= thresholds.requiredTimelyPercent
        ? "provisional-pass"
        : "fail";
    const appStateFixes = {};
    for (const fix of player.fixes) appStateFixes[fix.appState] = (appStateFixes[fix.appState] ?? 0) + 1;
    playerReports.push({
      id: player.id,
      name: player.name,
      device: player.device,
      fixes: player.fixes.length,
      acceptedFixes: player.fixes.filter((fix) => fix.accepted).length,
      receiptIntervalMs: distribution(intervals.map((interval) => interval.receiptIntervalMs)),
      sampleAgeMs: distribution(player.fixes.map((fix) => fix.sampleAgeMs).filter((value) => value !== undefined)),
      accuracyMeters: distribution(player.fixes.map((fix) => fix.accuracyMeters).filter((value) => value !== undefined)),
      movingIntervals: moving.length,
      timelyMovingIntervals: moving.filter((interval) => interval.timely).length,
      timelyMovingPercent: percentage(moving.filter((interval) => interval.timely).length, moving.length),
      backgroundMovingIntervals: backgroundMoving.length,
      timelyBackgroundMovingPercent: percentage(backgroundMoving.filter((interval) => interval.timely).length, backgroundMoving.length),
      longGaps: intervals.filter((interval) => interval.receiptIntervalMs > thresholds.longGapMs).length,
      appStateFixes,
      networkTypes,
      networkSwitches,
      battery: batterySummary(player.fixes),
      automatedGate: {
        status: gateStatus,
        basis: useBackgroundForGate ? "background-estimated-moving-intervals" : "all-estimated-moving-intervals",
        intervals: gateIntervals.length,
        timelyIntervals: timelyGateIntervals.length,
        timelyPercent: timelyGatePercent,
      },
    });
  }
  playerReports.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));

  const movingIntervals = allIntervals.filter((interval) => interval.moving);
  const backgroundMovingIntervals = movingIntervals.filter((interval) => interval.appState === "background");
  const playerGates = playerReports.map((player) => ({
    id: player.id,
    name: player.name,
    ...player.automatedGate,
  }));
  const gateIntervals = playerGates.reduce((sum, gate) => sum + gate.intervals, 0);
  const timelyGateIntervals = playerGates.reduce((sum, gate) => sum + gate.timelyIntervals, 0);
  const timelyPercent = percentage(timelyGateIntervals, gateIntervals);
  const gateBases = new Set(playerGates.map((gate) => gate.basis));
  const gateBasis = gateBases.size === 1
    ? [...gateBases][0]
    : "per-player-mixed-estimated-moving-intervals";
  const failedPlayers = playerGates.filter((gate) => gate.status === "fail");
  const insufficientPlayers = playerGates.filter((gate) => gate.status === "insufficient-data");
  const gameplay = gameplaySummary(events);
  gameplay.decisionEvidence = decisionEvidence(events, players);
  let status = "insufficient-data";
  let reason = playerGates.length
    ? `Insufficient movement evidence for: ${insufficientPlayers.map((player) => player.name ?? player.id).join(", ")}.`
    : "No players were found in the export.";
  if (failedPlayers.length) {
    status = "fail";
    reason = `The timely-fix target was missed by: ${failedPlayers.map((player) => player.name ?? player.id).join(", ")}.`;
  } else if (!insufficientPlayers.length && playerGates.length) {
    status = "provisional-pass";
    reason = `Every player met the ${thresholds.requiredTimelyPercent}% target using at least ${thresholds.minimumMovingIntervals} estimated moving intervals.`;
  }

  return {
    formatVersion: 1,
    roomCode: typeof source.roomCode === "string" ? source.roomCode : undefined,
    matchId: typeof source.matchId === "string" ? source.matchId : undefined,
    eventCount: events.length,
    thresholds,
    automatedGate: {
      status,
      basis: gateBasis,
      intervals: gateIntervals,
      timelyIntervals: timelyGateIntervals,
      timelyPercent,
      reason,
      players: playerGates,
      manualChecksRequired: [
        "Compare tagged and trapped outcomes with the independently recorded physical route.",
        "Confirm locked-screen notifications, foreground vibration, and OS location indicators on each phone.",
        "Confirm accuracy circles and GPS health labels matched what testers observed.",
      ],
    },
    summary: {
      players: playerReports.length,
      locationFixes: playerReports.reduce((sum, player) => sum + player.fixes, 0),
      rejectedLocations,
      clientLocationFailures,
      malformedLocationEvents,
      movingIntervals: movingIntervals.length,
      timelyMovingIntervals: movingIntervals.filter((interval) => interval.timely).length,
      timelyMovingPercent: percentage(movingIntervals.filter((interval) => interval.timely).length, movingIntervals.length),
      backgroundMovingIntervals: backgroundMovingIntervals.length,
      timelyBackgroundMovingPercent: percentage(backgroundMovingIntervals.filter((interval) => interval.timely).length, backgroundMovingIntervals.length),
      receiptIntervalMs: distribution(allIntervals.map((interval) => interval.receiptIntervalMs)),
      sampleAgeMs: distribution(playerReports.flatMap((player) => {
        const values = players.get(player.id)?.fixes.map((fix) => fix.sampleAgeMs).filter((value) => value !== undefined);
        return values ?? [];
      })),
      accuracyMeters: distribution(playerReports.flatMap((player) => {
        const values = players.get(player.id)?.fixes.map((fix) => fix.accuracyMeters).filter((value) => value !== undefined);
        return values ?? [];
      })),
      longGaps: allGaps.length,
    },
    reconnects: reconnectSummary(events),
    gameplay,
    players: playerReports,
    longestGaps: [...allGaps]
      .sort((a, b) => b.receiptIntervalMs - a.receiptIntervalMs)
      .slice(0, 20)
      .map(publicGap),
  };
}

function duration(value) {
  if (value === null || value === undefined) return "n/a";
  return value >= 1_000 ? `${Math.round(value / 10) / 100}s` : `${Math.round(value)}ms`;
}

function metric(value, suffix = "") {
  return value === null || value === undefined ? "n/a" : `${value}${suffix}`;
}

export function renderTextReport(report) {
  const lines = [
    "Out of Sight field-test diagnostics",
    `${report.roomCode ? `Room ${report.roomCode}` : "Unknown room"}${report.matchId ? ` · Match ${report.matchId}` : ""} · ${report.eventCount} events`,
    "",
    `Automated gate: ${report.automatedGate.status.toUpperCase()}`,
    report.automatedGate.reason,
    `Basis: ${report.automatedGate.basis}`,
    "The overall field gate still requires the manual checks listed below.",
    "",
    "Location summary",
    `  Players: ${report.summary.players}`,
    `  Fixes: ${report.summary.locationFixes} (${report.summary.rejectedLocations} rejected, ${report.summary.clientLocationFailures} client failures)`,
    `  Estimated moving intervals timely: ${metric(report.summary.timelyMovingPercent, "%")}`,
    `  Background moving intervals timely: ${metric(report.summary.timelyBackgroundMovingPercent, "%")}`,
    `  Receipt interval p50/p95/max: ${duration(report.summary.receiptIntervalMs.p50)} / ${duration(report.summary.receiptIntervalMs.p95)} / ${duration(report.summary.receiptIntervalMs.max)}`,
    `  Sample age p50/p95/max: ${duration(report.summary.sampleAgeMs.p50)} / ${duration(report.summary.sampleAgeMs.p95)} / ${duration(report.summary.sampleAgeMs.max)}`,
    `  Accuracy p50/p95/max: ${metric(report.summary.accuracyMeters.p50, "m")} / ${metric(report.summary.accuracyMeters.p95, "m")} / ${metric(report.summary.accuracyMeters.max, "m")}`,
    `  Gaps over ${duration(report.thresholds.longGapMs)}: ${report.summary.longGaps}`,
    "",
    "Players",
  ];
  for (const player of report.players) {
    const label = player.name ? `${player.name} (${player.id})` : player.id;
    const device = player.device?.model || player.device?.os
      ? ` · ${[player.device.model, player.device.os].filter(Boolean).join(" / ")}`
      : "";
    lines.push(`  ${label}${device}`);
    lines.push(`    gate ${player.automatedGate.status} (${metric(player.automatedGate.timelyPercent, "%")}, ${player.automatedGate.basis})`);
    lines.push(`    ${player.fixes} fixes · ${metric(player.timelyMovingPercent, "%")} moving timely · ${player.longGaps} long gaps`);
    lines.push(`    accuracy p95 ${metric(player.accuracyMeters.p95, "m")} · sample age p95 ${duration(player.sampleAgeMs.p95)}`);
    lines.push(`    battery ${metric(player.battery.firstPercent, "%")} → ${metric(player.battery.lastPercent, "%")} · drain/hour ${metric(player.battery.drainPerHour, " points")}`);
  }
  lines.push("", "Reconnects and outcomes");
  lines.push(`  Reconnects: ${report.reconnects.completed} completed, ${report.reconnects.unresolved} unresolved; p95 ${duration(report.reconnects.durationMs.p95)}`);
  lines.push(`  Tags: ${report.gameplay.playersTagged} players tagged (${report.gameplay.automaticTags} automatic, ${report.gameplay.manualTags} manual, ${report.gameplay.legacyTags} legacy/unknown); ${report.gameplay.acceptedTagAttempts}/${report.gameplay.tagAttempts} manual attempts accepted`);
  lines.push(`  Traps: ${report.gameplay.trapsPlaced} placed, ${report.gameplay.trapsTriggered} triggered, ${report.gameplay.trapsReleased} released`);
  lines.push(`  Speed rule: ${report.gameplay.speedWarnings} warnings, ${report.gameplay.speedProbations} probations, ${report.gameplay.speedProbationsEnded} completed probations, ${report.gameplay.speedDisqualifications} disqualifications`);
  lines.push(`  Decision evidence records: ${report.gameplay.decisionEvidence.count} (use --json for accuracy and sample-age context)`);
  if (report.longestGaps.length) {
    lines.push("", "Longest gaps");
    for (const gap of report.longestGaps.slice(0, 10)) {
      lines.push(`  ${gap.playerName ?? gap.playerId}: ${duration(gap.receiptIntervalMs)} · ${gap.appState} · ${gap.networkType}`);
    }
  }
  lines.push("", "Manual checks still required");
  for (const check of report.automatedGate.manualChecksRequired) lines.push(`  - ${check}`);
  return lines.join("\n");
}

function usage() {
  return [
    "Usage: npm run analyze:field-test -- <diagnostics-export.json> [--json]",
    "",
    "The default text report omits precise coordinates. --json emits the same summarized data as JSON.",
    "A failed automated gate exits with status 2; malformed input exits with status 1.",
  ].join("\n");
}

async function main(args) {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return 0;
  }
  const json = args.includes("--json");
  const paths = args.filter((arg) => !arg.startsWith("-"));
  if (paths.length !== 1) throw new Error("Provide exactly one diagnostics export path.");
  const document = JSON.parse(await readFile(paths[0], "utf8"));
  const report = analyzeDiagnostics(document);
  console.log(json ? JSON.stringify(report, null, 2) : renderTextReport(report));
  return report.automatedGate.status === "fail" ? 2 : 0;
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`[field-test] ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exitCode = 1;
  });
}
