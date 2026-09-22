import { describe, expect, it } from "vitest";
import { apiError, bearerToken, corsHeaders, json } from "./http";

describe("HTTP helpers", () => {
  it("extracts only a Bearer authorization token", () => {
    expect(bearerToken(new Request("https://game.test"))).toBeNull();
    expect(
      bearerToken(
        new Request("https://game.test", { headers: { Authorization: "Basic credentials" } }),
      ),
    ).toBeNull();
    expect(
      bearerToken(
        new Request("https://game.test", { headers: { Authorization: "Bearer player-token" } }),
      ),
    ).toBe("player-token");
  });

  it("returns no-store JSON responses with CORS headers", async () => {
    const response = json({ ok: true }, 201);
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      corsHeaders["Access-Control-Allow-Origin"],
    );
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("uses a stable error response shape and requested status", async () => {
    const response = apiError("unauthorized", "Party credentials are invalid.", 401);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "unauthorized",
      error: "Party credentials are invalid.",
    });
  });
});
