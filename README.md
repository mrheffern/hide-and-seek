# Hide and Seek

Cross-platform GPS hide-and-seek beta. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the system design and cost model, and [docs/IMPLEMENTATION_DECISIONS.md](./docs/IMPLEMENTATION_DECISIONS.md) for the living record of implementation choices and their rationale.

## Workspace

- `apps/mobile` — Expo/React Native app
- `packages/game-core` — deterministic game rules and geometry
- `packages/protocol` — network message schemas and shared types
- `services/game-server` — Cloudflare Worker and Durable Object game rooms

## Local development

Prerequisites: Node.js 22.13 or newer and an Android development environment. Locked-screen location requires a native development build; Expo Go is not a valid background-location test environment.

```sh
npm install
npm test
npm run typecheck
npm run dev:server
npm run dev:mobile
```

Copy each `.env.example` to the corresponding local environment file before running a device build. For a physical phone, set `EXPO_PUBLIC_GAME_API_URL` to the computer's LAN address instead of the Android-emulator default. Configure `GOOGLE_MAPS_API_KEY` before producing an Android native build and restrict it to the application package and signing certificate.

The first device milestone is deliberately narrow: confirm 30–60 minutes of accurate location uploads while Android and iPhone screens are locked. The 20-foot game mechanics remain experimental until that field test passes.

After exporting a match's diagnostics, generate a coordinate-free summary with:

```sh
npm run analyze:field-test -- path/to/out-of-sight-export.json
```

Add `--json` for machine-readable summarized output. The automated result is only provisional: compare tag and trap outcomes, notifications, and map behavior with the testers' physical notes before accepting the field gate.

See [docs/FIELD_TEST.md](./docs/FIELD_TEST.md) for the device-test procedure. `apps/mobile/eas.json` contains internal development and preview build profiles; an Expo account/project link is intentionally left unconfigured until the owner signs in.
