import { describe, expect, it } from "vitest";
import { errorPayload, sanitizePayload } from "./sanitize";

describe("diagnostic payload sanitization", () => {
  it("redacts credentials while retaining useful game details", () => {
    const result = sanitizePayload({
      playerId: "player-1",
      latitude: 34.1,
      authorization: "Bearer secret",
      apiKey: "secret-key",
      nested: { token: "player-token", command: { type: "tag" } },
    });
    expect(result).toEqual({
      playerId: "player-1",
      latitude: 34.1,
      authorization: "[redacted]",
      apiKey: "[redacted]",
      nested: { token: "[redacted]", command: { type: "tag" } },
    });
  });

  it("handles errors, circular values, and excessive strings safely", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = sanitizePayload({ circular, long: "x".repeat(3_000) });
    expect(result?.circular).toEqual({ self: "[circular]" });
    expect(String(result?.long)).toHaveLength(2_000);
    expect(errorPayload(new Error("boom"))).toMatchObject({ name: "Error", message: "boom" });
  });

  it("does not label repeated non-cyclic references as circular", () => {
    const shared = { status: "active" };
    expect(sanitizePayload({ before: shared, after: shared })).toEqual({ before: shared, after: shared });
  });

  it("bounds total payloads and contains exceptions from unsafe properties", () => {
    const payload = { roomCode: "ABC234", playerId: "player-1", values: Array(100).fill("x".repeat(2000)) };
    expect(JSON.stringify(sanitizePayload(payload)).length).toBeLessThan(12_000);
    expect(sanitizePayload(payload)).toMatchObject({ truncated: true, roomCode: "ABC234", playerId: "player-1" });
    expect(sanitizePayload({ get bad() { throw new Error("getter failed"); } })).toEqual({ serializationError: true });
  });
});
