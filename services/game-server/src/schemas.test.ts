import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@hide-and-seek/protocol";
import { commandEnvelopeSchema, diagnosticBatchSchema, locationEnvelopeSchema, playerNameSchema } from "./schemas";

const command = (overrides: Record<string, unknown> = {}) => ({
  protocolVersion: PROTOCOL_VERSION,
  commandId: "command-123",
  command: { type: "tag" },
  ...overrides,
});

const location = (fixOverrides: Record<string, unknown> = {}) => ({
  protocolVersion: PROTOCOL_VERSION,
  fix: {
    latitude: 34,
    longitude: -118,
    accuracyMeters: 2,
    sampledAtMs: 1_000,
    sampleAgeMs: 0,
    sequence: 1,
    sessionId: "session-123",
    ...fixOverrides,
  },
});

describe("command request validation", () => {
  it("accepts every supported command shape", () => {
    const commands = [
      { type: "set_boundary", boundary: [
        { latitude: 34, longitude: -118 },
        { latitude: 34.001, longitude: -118 },
        { latitude: 34, longitude: -117.999 },
      ] },
      { type: "set_seeker", playerId: "player-1" },
      { type: "start_match" },
      { type: "pause_match" },
      { type: "resume_match" },
      { type: "use_radar" },
      { type: "place_trap" },
      { type: "tag" },
      { type: "return_to_lobby" },
      { type: "leave_party" },
    ];
    for (const value of commands) {
      expect(commandEnvelopeSchema.safeParse(command({ command: value })).success).toBe(true);
    }
  });

  it("rejects incompatible protocol versions and invalid command IDs", () => {
    expect(commandEnvelopeSchema.safeParse(command({ protocolVersion: 1 })).success).toBe(false);
    expect(commandEnvelopeSchema.safeParse(command({ commandId: "short" })).success).toBe(false);
    expect(commandEnvelopeSchema.safeParse(command({ commandId: "x".repeat(101) })).success).toBe(false);
  });

  it("rejects unknown commands and malformed boundaries", () => {
    expect(
      commandEnvelopeSchema.safeParse(command({ command: { type: "teleport" } })).success,
    ).toBe(false);
    expect(
      commandEnvelopeSchema.safeParse(
        command({ command: { type: "set_boundary", boundary: [{ latitude: 34, longitude: -118 }] } }),
      ).success,
    ).toBe(false);
    expect(
      commandEnvelopeSchema.safeParse(
        command({
          command: {
            type: "set_boundary",
            boundary: [
              { latitude: 91, longitude: -118 },
              { latitude: 34, longitude: -118 },
              { latitude: 34, longitude: -117.9 },
            ],
          },
        }),
      ).success,
    ).toBe(false);
  });
});

describe("location request validation", () => {
  it("accepts a valid location envelope", () => {
    expect(locationEnvelopeSchema.safeParse(location()).success).toBe(true);
    expect(locationEnvelopeSchema.safeParse(location({ speedMetersPerSecond: 1.4 })).success).toBe(true);
  });

  it("accepts bounded battery and connection health", () => {
    expect(locationEnvelopeSchema.safeParse({
      ...location(),
      deviceStatus: {
        batteryPercent: 42,
        isCharging: false,
        lowPowerMode: true,
        networkType: "cellular",
        isInternetReachable: true,
      },
    }).success).toBe(true);
  });

  it("rejects invalid device health", () => {
    expect(locationEnvelopeSchema.safeParse({
      ...location(),
      deviceStatus: { batteryPercent: 101, networkType: "telepathy" },
    }).success).toBe(false);
  });

  it.each([
    ["latitude", { latitude: 91 }],
    ["longitude", { longitude: -181 }],
    ["negative accuracy", { accuracyMeters: -1 }],
    ["excessive accuracy", { accuracyMeters: 10_001 }],
    ["negative speed", { speedMetersPerSecond: -0.1 }],
    ["impossible speed", { speedMetersPerSecond: 101 }],
    ["negative sample age", { sampleAgeMs: -1 }],
    ["excessive sample age", { sampleAgeMs: 600_001 }],
    ["fractional sequence", { sequence: 1.5 }],
    ["short session ID", { sessionId: "short" }],
  ])("rejects %s", (_label, override) => {
    expect(locationEnvelopeSchema.safeParse(location(override)).success).toBe(false);
  });

  it("rejects incompatible protocol versions", () => {
    expect(locationEnvelopeSchema.safeParse({ ...location(), protocolVersion: 1 }).success).toBe(false);
  });
});

describe("player name validation", () => {
  it("trims a valid name", () => {
    const result = playerNameSchema.safeParse({ name: "  Alex  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("Alex");
  });

  it("rejects blank and overlong names", () => {
    expect(playerNameSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(playerNameSchema.safeParse({ name: "x".repeat(25) }).success).toBe(false);
  });
});

describe("diagnostic batch validation", () => {
  const event = {
    id: "event-123456",
    appSessionId: "app-session-123456",
    clientAtMs: 1_000,
    level: "info",
    category: "interaction",
    name: "button_pressed",
    matchId: "match-123",
    correlationId: "command-123",
    payload: { command: { type: "tag" }, latitude: 34, connected: true },
  };

  it("accepts structured client events", () => {
    expect(diagnosticBatchSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, events: [event] }).success).toBe(true);
  });

  it("rejects empty, oversized, malformed, and incompatible batches", () => {
    expect(diagnosticBatchSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, events: [] }).success).toBe(false);
    expect(diagnosticBatchSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, events: Array.from({ length: 101 }, () => event) }).success).toBe(false);
    expect(diagnosticBatchSchema.safeParse({ protocolVersion: 1, events: [event] }).success).toBe(false);
    expect(diagnosticBatchSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, events: [{ ...event, level: "panic" }] }).success).toBe(false);
    expect(diagnosticBatchSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, events: [{ ...event, id: "short" }] }).success).toBe(false);
  });
});
