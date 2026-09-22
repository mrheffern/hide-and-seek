import type { ConfigContext, ExpoConfig } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name ?? "Out of Sight",
  slug: config.slug ?? "out-of-sight",
  android: {
    ...config.android,
    config: process.env.GOOGLE_MAPS_API_KEY
      ? { googleMaps: { apiKey: process.env.GOOGLE_MAPS_API_KEY } }
      : config.android?.config,
  },
  extra: {
    ...config.extra,
    gameApiUrl: process.env.EXPO_PUBLIC_GAME_API_URL ?? config.extra?.gameApiUrl,
  },
});
