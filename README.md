# Hide and Seek

Cross-platform GPS hide-and-seek beta. Start with [docs/PRODUCT_VISION.md](./docs/PRODUCT_VISION.md) for the intended sport, audience, college-launch strategy, and decision principles. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the system design and cost model, and [docs/IMPLEMENTATION_DECISIONS.md](./docs/IMPLEMENTATION_DECISIONS.md) for the living record of implementation choices and their rationale.

## Workspace

- `apps/mobile` — Expo/React Native app
- `packages/game-core` — deterministic game rules and geometry
- `packages/protocol` — network message schemas and shared types
- `services/game-server` — Cloudflare Worker and Durable Object game rooms

## Android beta release

The current physical-device build is the [`v0.1.2` GitHub prerelease](https://github.com/mrheffern/hide-and-seek/releases/tag/v0.1.2). Download [`out-of-sight-v0.1.2.apk`](https://github.com/mrheffern/hide-and-seek/releases/download/v0.1.2/out-of-sight-v0.1.2.apk) directly on an Android phone, allow that browser or file manager to install unknown apps when Android asks, and open **Out of Sight**. Version `0.1.2` has Android version code `3`, so it can update the earlier `v0.1.1` test build because both builds use the same signing certificate.

This APK defaults to the production HTTPS Cloudflare Worker at `https://hide-and-seek-game-server.hide-and-seek-game-server.workers.dev`. Its Google Maps key is embedded at native build time and is restricted to the Maps SDK for Android, the `com.hideandseek.outofsight` package, and the release's signing certificate. The key value is intentionally absent from the repository.

`v0.1.2` adds authoritative spoken **Tagged** cues for both tag participants and **Caught in bear trap** for the trapped seeker; trap placement remains silent. It is an internal prerelease rather than a Play Store production-signed build. Automated tests, APK integrity, alignment, and signature checks pass, but a complete match on multiple physical phones—including locked-screen audio—remains the release gate. Use the [gameplay readiness checklist](./docs/GAMEPLAY_TEST_CHECKLIST.md) and [locked-phone field test](./docs/FIELD_TEST.md) before treating the beta as generally ready to play.

## Local development

Prerequisites: Node.js 22.13 or newer and an Android development environment. Locked-screen location requires a native development build; Expo Go is not a valid background-location test environment.

```sh
npm install
npm test
npm run typecheck
npm run dev:server
npm run dev:mobile
```

Copy each `.env.example` to the corresponding local environment file before running a device build. `apps/mobile/.env.example` points an Android emulator at `http://10.0.2.2:8787`; that address is emulator-only and must never be baked into a physical-device release. For a local physical-phone build, use a reachable development endpoint configured for Android networking, or an HTTPS tunnel. If `EXPO_PUBLIC_GAME_API_URL` is unset, the app uses the production HTTPS Worker. Configure `GOOGLE_MAPS_API_KEY` before producing an Android native build and restrict it to the Maps SDK for Android, the application package, and the exact signing certificate.

The first device milestone is deliberately narrow: confirm 30–60 minutes of accurate location uploads while Android and iPhone screens are locked. The 20-foot game mechanics remain experimental until that field test passes.

After exporting a match's diagnostics, generate a coordinate-free summary with:

```sh
npm run analyze:field-test -- path/to/out-of-sight-export.json
```

Add `--json` for machine-readable summarized output. The automated result is only provisional: compare tag and trap outcomes, notifications, and map behavior with the testers' physical notes before accepting the field gate.

See [docs/GAMEPLAY_TEST_CHECKLIST.md](./docs/GAMEPLAY_TEST_CHECKLIST.md) for the complete gameplay release gate and [docs/FIELD_TEST.md](./docs/FIELD_TEST.md) for the longer device route. `apps/mobile/eas.json` contains internal development and preview build profiles; an Expo account/project link is intentionally left unconfigured until the owner signs in.
