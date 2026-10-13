import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@hide-and-seek/protocol";

const randomId = vi.hoisted(() => vi.fn(() => "command-123456"));
vi.mock("./session", () => ({ randomId }));
vi.mock("./diagnostics", () => ({
  getDiagnosticContext: vi.fn(() => ({ roomCode: "ABC123", playerId: "player-1" })),
  recordDiagnostic: vi.fn(),
  recordDiagnosticError: vi.fn(),
}));

import {
  ApiRequestError,
  fetchSnapshot,
  sendCommand,
  socketUrl,
  uploadLocation,
} from "./api";
import type { StoredSession } from "./session";
import { REQUEST_TIMEOUT_MS } from "./network/request";

const session: StoredSession = {
  apiUrl: "https://game.example",
  roomCode: "ABC123",
  playerId: "player-1",
  token: "secret-token",
  locationSessionId: "location-session",
};

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  randomId.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mobile API transport", () => {
  it("authenticates snapshot requests", async () => {
    fetchMock.mockResolvedValue(Response.json({ type: "snapshot" }));
    await fetchSnapshot(session);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://game.example/rooms/ABC123/snapshot",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer secret-token" },
      }),
    );
  });

  it("adds protocol and idempotency metadata to commands", async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true, code: "ok", message: "Tagged." }));
    await sendCommand(session, { type: "tag" });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      commandId: "command-123456",
      command: { type: "tag" },
    });
  });

  it("wraps location fixes in the current protocol envelope", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ ok: true, code: "ok", message: "Accepted.", snapshot: {} }),
    );
    const fix = {
      latitude: 34,
      longitude: -118,
      accuracyMeters: 2,
      sampledAtMs: 1_000,
      sampleAgeMs: 0,
      sequence: 4,
      sessionId: "location-session",
    };
    await uploadLocation(session, fix);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ protocolVersion: PROTOCOL_VERSION, fix });
  });

  it("includes optional battery and network health with location uploads", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ ok: true, code: "ok", message: "Accepted.", snapshot: {} }),
    );
    const fix = {
      latitude: 34,
      longitude: -118,
      accuracyMeters: 2,
      sampledAtMs: 1_000,
      sampleAgeMs: 0,
      sequence: 5,
      sessionId: "location-session",
    };
    const deviceStatus = {
      batteryPercent: 76,
      isCharging: false,
      networkType: "wifi" as const,
      isInternetReachable: true,
    };
    await uploadLocation(session, fix, deviceStatus);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ protocolVersion: PROTOCOL_VERSION, fix, deviceStatus });
  });

  it("surfaces structured server errors to the UI", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { code: "outside_boundary", error: "Return inside the boundary." },
        { status: 409 },
      ),
    );
    const promise = sendCommand(session, { type: "tag" });
    await expect(promise).rejects.toMatchObject({
      name: "Error",
      message: "Return inside the boundary.",
      code: "outside_boundary",
      status: 409,
    } satisfies Partial<ApiRequestError>);
  });

  it("surfaces command rule failures that use the result message field", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { ok: false, code: "seeker_required", message: "Select exactly one seeker." },
        { status: 409 },
      ),
    );
    await expect(sendCommand(session, { type: "start_match" })).rejects.toMatchObject({
      message: "Select exactly one seeker.",
      code: "seeker_required",
      status: 409,
    } satisfies Partial<ApiRequestError>);
  });

  it("reports unreadable success and error responses consistently", async () => {
    fetchMock.mockResolvedValue(new Response("not-json", { status: 200 }));
    await expect(fetchSnapshot(session)).rejects.toMatchObject({
      code: "invalid_response",
      status: 200,
    });

    fetchMock.mockResolvedValue(new Response("gateway text", { status: 502 }));
    await expect(fetchSnapshot(session)).rejects.toMatchObject({
      message: "Game server request failed (502).",
      code: "invalid_response",
      status: 502,
    });
  });

  it("builds secure and local WebSocket URLs with the protocol version", () => {
    expect(socketUrl(session)).toBe(`wss://game.example/rooms/ABC123/connect?v=${PROTOCOL_VERSION}`);
    expect(socketUrl({ ...session, apiUrl: "http://10.0.2.2:8787" })).toBe(
      `ws://10.0.2.2:8787/rooms/ABC123/connect?v=${PROTOCOL_VERSION}`,
    );
  });

  it("aborts a stalled request so gameplay controls can recover", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    const pending = expect(sendCommand(session, { type: "tag" })).rejects.toMatchObject({ code: "request_timeout", status: 0 });
    const signal = fetchMock.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("also times out when headers arrive but the response body stalls", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ text: () => new Promise(() => undefined) } as unknown as Response);
    const pending = expect(fetchSnapshot(session)).rejects.toMatchObject({ code: "request_timeout" });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await pending;
  });

  it.each(["null", "[]", '"proxy error"'])("rejects non-object JSON %s as an invalid response", async (value) => {
    fetchMock.mockResolvedValue(new Response(value, { status: 503 }));
    await expect(fetchSnapshot(session)).rejects.toMatchObject({ code: "invalid_response", status: 503 });
  });
});
