export const GAME_API_URL = (
  process.env.EXPO_PUBLIC_GAME_API_URL ?? "http://10.0.2.2:8787"
).replace(/\/$/, "");
