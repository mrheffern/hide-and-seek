import * as SecureStore from "expo-secure-store";

const SESSION_KEY = "hide-and-seek-session-v1";

export interface StoredSession {
  apiUrl: string;
  roomCode: string;
  playerId: string;
  token: string;
  locationSessionId: string;
}

export async function readSession(): Promise<StoredSession | null> {
  const value = await SecureStore.getItemAsync(SESSION_KEY);
  if (!value) return null;
  try {
    return JSON.parse(value) as StoredSession;
  } catch {
    await SecureStore.deleteItemAsync(SESSION_KEY);
    return null;
  }
}

export async function saveSession(session: StoredSession): Promise<void> {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY);
}

export function randomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
