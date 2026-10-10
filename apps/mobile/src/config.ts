export const GAME_API_URL = (
  process.env.EXPO_PUBLIC_GAME_API_URL
    ?? "https://hide-and-seek-game-server.hide-and-seek-game-server.workers.dev"
).replace(/\/$/, "");
