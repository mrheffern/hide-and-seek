export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Sec-WebSocket-Protocol",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return Response.json(data, {
    status,
    headers: { ...corsHeaders, "Cache-Control": "no-store", ...extraHeaders },
  });
}

export function apiError(code: string, error: string, status = 400): Response {
  return json({ code, error }, status);
}

export function bearerToken(request: Request): string | null {
  const value = request.headers.get("Authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
}
