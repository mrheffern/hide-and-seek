const MAX_STRING_LENGTH = 2_000;
const MAX_ARRAY_LENGTH = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 6;

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, MAX_STRING_LENGTH);
  if (typeof value === "undefined") return undefined;
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") return String(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message.slice(0, MAX_STRING_LENGTH),
      stack: value.stack?.slice(0, 8_000),
    };
  }
  if (depth >= MAX_DEPTH) return "[maximum depth]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitizeValue(item, depth + 1, seen));
    seen.delete(value);
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    if (/token|authorization|api.?key|secret|password/i.test(key)) {
      result[key] = "[redacted]";
      continue;
    }
    const sanitized = sanitizeValue(item, depth + 1, seen);
    if (sanitized !== undefined) result[key.slice(0, 100)] = sanitized;
  }
  seen.delete(value);
  return result;
}

export function sanitizePayload(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  try {
    const result = sanitizeValue(payload, 0, new WeakSet()) as Record<string, unknown>;
    const serialized = JSON.stringify(result);
    if (serialized.length <= 12_000) return result;
    return {
      truncated: true,
      preview: serialized.slice(0, 10_000),
      roomCode: result.roomCode,
      playerId: result.playerId,
      playerName: result.playerName,
    };
  } catch {
    return { serializationError: true };
  }
}

export function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return sanitizePayload({ name: error.name, message: error.message, stack: error.stack }) ?? {};
  }
  return sanitizePayload({ error }) ?? {};
}
