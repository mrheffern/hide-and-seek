import { describe, expect, it } from "vitest";
import { reconnectDelayMs } from "./reconnect";

describe("party reconnect backoff", () => {
  it("retries quickly, backs off, and caps at fifteen seconds", () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(reconnectDelayMs)).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      15_000,
      15_000,
      15_000,
    ]);
  });
});
