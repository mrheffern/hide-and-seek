import { z } from "zod";
import { PROTOCOL_VERSION } from "@hide-and-seek/protocol";

const coordinate = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

const command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_boundary"), boundary: z.array(coordinate).min(3).max(64) }),
  z.object({ type: z.literal("set_seeker"), playerId: z.string().min(1).max(80) }),
  z.object({ type: z.literal("start_match") }),
  z.object({ type: z.literal("pause_match") }),
  z.object({ type: z.literal("resume_match") }),
  z.object({ type: z.literal("use_radar") }),
  z.object({ type: z.literal("place_trap") }),
  z.object({ type: z.literal("tag") }),
  z.object({ type: z.literal("return_to_lobby") }),
  z.object({ type: z.literal("leave_party") }),
]);

export const commandEnvelopeSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  commandId: z.string().min(8).max(100),
  command,
});

export const locationEnvelopeSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  fix: coordinate.extend({
    accuracyMeters: z.number().min(0).max(10_000),
    speedMetersPerSecond: z.number().min(0).max(100).optional(),
    sampledAtMs: z.number().int().nonnegative(),
    sampleAgeMs: z.number().int().min(0).max(10 * 60_000),
    sequence: z.number().int().nonnegative(),
    sessionId: z.string().min(8).max(100),
  }),
  deviceStatus: z.object({
    batteryPercent: z.number().min(0).max(100).optional(),
    isCharging: z.boolean().optional(),
    lowPowerMode: z.boolean().optional(),
    networkType: z.enum(["wifi", "cellular", "ethernet", "other", "none", "unknown"]),
    isInternetReachable: z.boolean().optional(),
  }).optional(),
});

export const playerNameSchema = z.object({ name: z.string().trim().min(1).max(24) });

const diagnosticEvent = z.object({
  id: z.string().min(8).max(100),
  appSessionId: z.string().min(8).max(100),
  clientAtMs: z.number().int().nonnegative(),
  level: z.enum(["debug", "info", "warn", "error", "fatal"]),
  category: z.string().min(1).max(50),
  name: z.string().min(1).max(80),
  matchId: z.string().min(1).max(100).optional(),
  correlationId: z.string().min(1).max(100).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const diagnosticBatchSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  events: z.array(diagnosticEvent).min(1).max(100),
});
