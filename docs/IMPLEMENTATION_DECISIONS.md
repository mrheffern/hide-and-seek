# Implementation decisions

This is the living record of implementation choices for Out of Sight. It explains why the current code behaves as it does and records the tradeoffs that should survive individual coding sessions.

Use this file for decisions that affect product behavior, architecture, privacy, security, operating cost, cross-platform support, deployment, or field-test expectations. Routine refactors and isolated bug fixes belong in commit history or a bug audit unless they establish a rule future work must preserve.

## How to maintain this log

- Give each decision the next `DEC-NNN` identifier.
- Use one of these statuses: **Proposed**, **Accepted**, or **Superseded**.
- Do not erase an accepted decision when direction changes. Add a new entry and mark the old one as superseded by the new identifier.
- Record the behavior and rationale, not secret values, personal credentials, or temporary device addresses.
- Link the code and tests that enforce the decision.
- Treat code and tests as the runtime source of truth. Update this log whenever an intentional change makes an entry inaccurate.

## Decision index

| ID | Decision | Status | Date |
| --- | --- | --- | --- |
| [DEC-001](#dec-001--shared-cross-platform-typescript-workspace) | Shared cross-platform TypeScript workspace | Accepted | 2026-09-19 |
| [DEC-002](#dec-002--authoritative-room-server) | Authoritative room server | Accepted | 2026-09-19 |
| [DEC-003](#dec-003--role-filtered-location-visibility) | Role-filtered location visibility | Accepted | 2026-09-19 |
| [DEC-004](#dec-004--google-satellite-maps-for-the-beta) | Google satellite maps for the beta | Accepted | 2026-09-19 |
| [DEC-005](#dec-005--locked-phone-location-tracking) | Locked-phone location tracking | Superseded in part by DEC-017 | 2026-09-20 |
| [DEC-006](#dec-006--strict-competitive-gps-validity) | Strict competitive GPS validity | Accepted, pending field validation | 2026-09-19 |
| [DEC-007](#dec-007--privacy-safe-shared-gps-readiness) | Privacy-safe shared GPS readiness | Accepted | 2026-09-20 |
| [DEC-008](#dec-008--host-controlled-lobby-and-match-setup) | Host-controlled lobby and match setup | Accepted | 2026-09-19 |
| [DEC-009](#dec-009--beta-gameplay-rule-preset) | Beta gameplay rule preset | Accepted, experimental | 2026-09-19 |
| [DEC-010](#dec-010--websocket-snapshots-with-http-commands) | WebSocket snapshots with HTTP commands | Accepted | 2026-09-19 |
| [DEC-011](#dec-011--finished-game-screen-and-host-controlled-rematch) | Finished-game screen and host-controlled rematch | Accepted | 2026-09-20 |
| [DEC-012](#dec-012--system-insets-and-minimum-header-touch-targets) | System insets and minimum header touch targets | Accepted | 2026-09-20 |
| [DEC-013](#dec-013--local-secrets-and-restricted-map-keys) | Local secrets and restricted map keys | Accepted | 2026-09-19 |
| [DEC-014](#dec-014--behavioral-tests-for-authoritative-rules) | Behavioral tests for authoritative rules | Accepted | 2026-09-19 |
| [DEC-015](#dec-015--live-player-health-and-reconnect-behavior) | Live player health and reconnect behavior | Accepted | 2026-09-20 |
| [DEC-016](#dec-016--reconstructable-beta-diagnostics) | Reconstructable beta diagnostics | Accepted | 2026-09-20 |
| [DEC-017](#dec-017--cost-bounded-location-lifecycle) | Cost-bounded location lifecycle | Accepted | 2026-09-20 |
| [DEC-018](#dec-018--production-android-release-configuration) | Production Android release configuration | Accepted | 2026-10-10 |
| [DEC-019](#dec-019--authoritative-spoken-gameplay-cues) | Authoritative spoken gameplay cues | Accepted | 2026-10-11 |

## DEC-001 — Shared cross-platform TypeScript workspace

**Status:** Accepted  
**Date:** 2026-09-19

### Context

The beta must run on Android first without creating an Android-only architecture that blocks an iPhone version.

### Decision

Use a TypeScript monorepo with:

- Expo and React Native in `apps/mobile` for the shared Android/iOS client.
- Deterministic platform-independent rules and geometry in `packages/game-core`.
- Shared network types in `packages/protocol`.
- A Cloudflare Worker and Durable Object implementation in `services/game-server`.

Native platform configuration is allowed for maps, permissions, foreground services, notifications, and store distribution. Game rules must remain outside native UI code.

### Consequences

Most product work is shared across platforms. Locked-phone behavior still requires native builds and real-device testing on both operating systems; Expo Go is not a valid test environment.

### Implementation

- `apps/mobile/package.json`
- `packages/game-core/src/rules.ts`
- `packages/protocol/src/index.ts`
- `services/game-server/src/room.ts`

## DEC-002 — Authoritative room server

**Status:** Accepted  
**Date:** 2026-09-19

### Context

Clients cannot be trusted to decide tags, traps, boundary violations, cooldowns, or which hidden locations another role may see.

### Decision

Use one Cloudflare Durable Object as the authority for each party code. The server owns room state, validates commands and location samples, advances timers, decides outcomes, persists critical transitions, and creates a viewer-specific snapshot for every player.

### Consequences

Clients remain presentation and input devices. A network connection is required for competitive actions. Per-room serialization avoids distributed locking and keeps the beta inexpensive at small scale.

### Implementation

- `services/game-server/src/room.ts`
- `packages/game-core/src/rules.ts`
- `services/game-server/wrangler.jsonc`

## DEC-003 — Role-filtered location visibility

**Status:** Accepted  
**Date:** 2026-09-19

### Context

Hidden locations must never be sent to a client that is not allowed to display them. Hiding a marker in the UI is insufficient because the coordinates would still be recoverable from client traffic or state.

### Decision

Filter every snapshot on the server:

- Every player may see their own location.
- Active hiders may see active hiders.
- Hiders do not see the seeker.
- The seeker does not see hiders except during the server-controlled radar window.
- Eliminated players do not continue receiving active hider locations.

### Consequences

The server must calculate one snapshot per viewer. Client code must not infer readiness from the presence of coordinates because legitimate privacy filtering removes them.

### Implementation

- `packages/game-core/src/rules.ts` (`snapshotForPlayer`)
- `packages/game-core/src/rules.behavior.test.ts` (role visibility tests)

## DEC-004 — Google satellite maps for the beta

**Status:** Accepted  
**Date:** 2026-09-19

### Context

Campus players need recognizable buildings, fields, paths, and tree cover. Street-map styling does not provide enough physical context for hiding and boundary drawing.

### Decision

Use `react-native-maps` backed by the native Google Maps SDK and render the game map with `mapType="satellite"`.

### Consequences

Android builds require a Google Maps SDK key and billing-enabled Google Cloud project. The key must be restricted as described in DEC-013. Map cost and provider assumptions must be reviewed before public scale or an iOS launch.

### Implementation

- `apps/mobile/App.tsx` (`GameMap`)
- `apps/mobile/app.config.ts`

## DEC-005 — Locked-phone location tracking

**Status:** Superseded in part by DEC-017  
**Date:** 2026-09-20

### Context

Players keep phones in pockets and may lock their screens. APK replacement can preserve Expo's task registration while Android kills the associated foreground service. Requiring movement also caused stationary players to send one fix and then appear offline.

### Decision

For a running match:

- Require precise foreground and background location permission.
- Use a visible Android foreground location service.
- Request high-accuracy updates every 1.5 seconds.
- Set the distance threshold to zero so stationary players produce heartbeat fixes.
- Reuse an already-running Expo location task when the app opens in the foreground so Android does not repeatedly tear down and recreate its foreground service.
- Upload only the newest native sample; do not queue old positions.
- Stop tracking in the lobby, after elimination or departure, and after match completion. DEC-017 defines lobby readiness checks.
- Log native task and upload failures without logging coordinates or credentials.

### Consequences

This favors game responsiveness over battery life. Android displays a persistent location notification. OS scheduling, radio handoffs, and indoor GPS can still interrupt the stream, so the field test remains a release gate.

### Implementation

- `apps/mobile/src/location/tracking.ts`
- `apps/mobile/src/location/backgroundLocation.ts`
- `apps/mobile/src/hooks/useParty.ts`
- `apps/mobile/src/location/tracking.test.ts`
- `docs/FIELD_TEST.md`

## DEC-006 — Strict competitive GPS validity

**Status:** Accepted, pending field validation  
**Date:** 2026-09-19

### Context

The requested 20-foot tag range and 20-foot-diameter traps are small relative to ordinary phone GPS uncertainty. Old or inaccurate fixes can create false tags and false trap triggers.

### Decision

The default competitive preset accepts a location for automatic mechanics only when it is no more than three seconds old and has a reported accuracy radius of at most ten meters. Continuous observations may have gaps of at most four seconds. When uncertainty overlaps a possible tag without proving it, deny the tag with a location-uncertain result.

### Consequences

Controls may temporarily become unavailable under poor sky view even when location permission is working. Do not silently use stale coordinates to make the UI appear healthier. If campus field tests fail, change the game radii, the tested mode, or the native tracking adapter explicitly and record a superseding decision.

### Implementation

- `packages/game-core/src/rules.ts` (`DEFAULT_RULES` and `usableFix`)
- `packages/game-core/src/rules.behavior.test.ts`
- `docs/FIELD_TEST.md`

## DEC-007 — Privacy-safe shared GPS readiness

**Status:** Accepted  
**Date:** 2026-09-20

### Context

The lobby must tell every phone whether each participant is ready. Opposite-role coordinates are intentionally absent from snapshots, so using `player.location` as a readiness signal made each role incorrectly report the other as waiting.

### Decision

Include a server-computed `gpsReady` boolean for every visible player. Calculate it from the same usable-fix rule used by authoritative game setup while continuing to omit unauthorized coordinates.

### Consequences

All players can see readiness without learning hidden positions. Coordinate visibility and readiness must remain separate protocol concepts.

### Implementation

- `packages/protocol/src/index.ts` (`VisiblePlayer.gpsReady`)
- `packages/game-core/src/rules.ts` (`snapshotForPlayer`)
- `apps/mobile/src/game/lobbyReadiness.ts`

## DEC-008 — Host-controlled lobby and match setup

**Status:** Accepted  
**Date:** 2026-09-19

### Context

A party needs one person to define shared setup without conflicting edits from several phones.

### Decision

The host owns boundary drawing, seeker selection, match start, pause, resume, and return-to-lobby actions. The lobby shows a six-character join code. A match can start only with a valid saved boundary, at least two players, exactly one seeker, recent precise locations for all remaining players, and all players inside the boundary.

### Consequences

The host is a control role, not a visibility role. Host status never grants access to hidden coordinates. If the host leaves, authority transfers to a remaining player.

### Implementation

- `packages/game-core/src/rules.ts`
- `apps/mobile/src/game/lobbyReadiness.ts`
- `apps/mobile/App.tsx` (`PartyPanel`)

## DEC-009 — Beta gameplay rule preset

**Status:** Accepted, experimental  
**Date:** 2026-09-19

### Context

The beta needs one concrete, server-enforced ruleset so device testing and gameplay feedback refer to the same distances, timers, and power limits.

### Decision

Use these server-owned beta defaults:

| Rule | Default |
| --- | ---: |
| Tag radius | 6.096 m / 20 ft |
| Trap radius | 6.096 m / 20 ft |
| Trap dwell | 15 seconds of observed dwell |
| Trap arm delay | 5 seconds |
| Trap lifetime | 5 minutes |
| Traps per hider | 1 |
| Radar visibility | 3 seconds |
| Radar cooldown | 5 minutes |
| Hiding countdown | 60 seconds |
| Round duration | 30 minutes |
| Boundary grace | 15 seconds |
| Tag-attempt cooldown | 2 seconds |
| Disconnect pause threshold | 10 seconds |

### Consequences

These values are a field-test preset rather than a promise of reliable physical accuracy. Change them in the authoritative rules package and update the associated behavior tests and this entry together.

### Implementation

- `packages/game-core/src/rules.ts` (`DEFAULT_RULES`)

## DEC-010 — WebSocket snapshots with HTTP commands

**Status:** Accepted  
**Date:** 2026-09-19

### Context

Players need low-latency shared state, while commands and location uploads benefit from explicit request validation and clear success or failure responses.

### Decision

Use authenticated WebSockets for server-pushed, viewer-filtered room snapshots. Use authenticated HTTP requests for party creation, joining, commands, snapshots, and location uploads. Keep command IDs for idempotency and return server error messages to the UI.

### Consequences

The app must reconnect WebSockets and can retry with newer location samples. Commands remain server-authoritative even if the initiating client has not yet received the resulting broadcast.

### Implementation

- `apps/mobile/src/hooks/useParty.ts`
- `apps/mobile/src/api.ts`
- `services/game-server/src/room.ts`

## DEC-011 — Finished-game screen and host-controlled rematch

**Status:** Accepted  
**Date:** 2026-09-20

### Context

A finished match previously remained on the normal game map without a clear outcome or next step.

### Decision

Show a dedicated Game Over screen with the winning side and the server's final result. The host can return the shared party to the lobby; other players wait on the result screen until that transition. Returning to the lobby keeps the party, host, roles, and saved boundary, clears round-only state and old locations, restores players to active status, and takes a one-time readiness fix. Players may also leave the party from the result screen.

### Consequences

Only one synchronized transition changes the room phase. The existing boundary can be reused or redrawn, and the host can select a different seeker before starting another round.

### Implementation

- `apps/mobile/App.tsx` (`GameOver`)
- `packages/game-core/src/rules.ts` (`returnToLobby`)
- `services/game-server/src/schemas.ts`
- `apps/mobile/src/hooks/useParty.ts`
- `packages/game-core/src/rules.behavior.test.ts`

## DEC-012 — System insets and minimum header touch targets

**Status:** Accepted  
**Date:** 2026-09-20

### Context

Android edge-to-edge layouts placed the game header under the status bar on a Pixel, making Leave difficult or impossible to tap.

### Decision

Apply the Android status-bar inset to every root screen and give the header Leave action a minimum 64 by 48 density-independent-pixel touch target plus hit slop.

### Consequences

New full-screen views must reuse the inset pattern. Device verification should include cutouts, different status-bar heights, and gesture navigation.

### Implementation

- `apps/mobile/App.tsx` (`androidStatusBarInset`, root styles, and `leaveButton`)

## DEC-013 — Local secrets and restricted map keys

**Status:** Accepted  
**Date:** 2026-09-19

### Context

Native map keys are embedded in application builds, but unrestricted keys can be abused. Repository documentation must not become a credential store.

### Decision

Keep environment-specific values in uncommitted local environment files. Never record key values in this log. Restrict the Google Maps Android key to the Maps SDK, application package `com.hideandseek.outofsight`, and the correct signing-certificate fingerprint. Use a separate production key and restrictions before store distribution.

For the `v0.1.1` internal Android prerelease, the embedded key is restricted to the Maps SDK for Android, `com.hideandseek.outofsight`, and the certificate that signs the published APK. The key value is supplied only to the native build environment and is not tracked in the repository.

### Consequences

Each signing configuration requires matching key restrictions. Key rotation must be followed by a native rebuild.

### Implementation

- `apps/mobile/.env.example`
- `apps/mobile/app.config.ts`
- `apps/mobile/app.json`

## DEC-014 — Behavioral tests for authoritative rules

**Status:** Accepted  
**Date:** 2026-09-19

### Context

Most serious failures in this game are state-machine, privacy, timing, or authorization failures rather than isolated rendering errors.

### Decision

Prioritize behavioral tests around the authoritative rules, privacy-filtered snapshots, lobby readiness, background-tracking configuration, HTTP validation, and room persistence. Every change to a game transition or visibility rule must include a regression test that would fail under the old behavior.

### Consequences

Tests should verify outcomes and invariants rather than mirror implementation details. Native locked-phone behavior still requires the field test because unit tests cannot reproduce OS scheduling, radio handoffs, or GPS uncertainty.

### Implementation

- `packages/game-core/src/rules.behavior.test.ts`
- `apps/mobile/src/game/lobbyReadiness.test.ts`
- `apps/mobile/src/location/tracking.test.ts`
- `services/game-server/src/http.test.ts`
- `services/game-server/src/schemas.test.ts`
- `docs/FIELD_TEST.md`

## DEC-015 — Live player health and reconnect behavior

**Status:** Accepted  
**Date:** 2026-09-20

### Context

Outdoor matches cross Wi-Fi and cellular coverage, run with locked phones, and depend on GPS samples whose age and accuracy change continuously. A temporary request failure must not erase a valid saved party, and players need enough health information to distinguish a weak fix, a stale fix, and a disconnected phone.

### Decision

- Retain authenticated party sessions across temporary startup and network failures. Clear a saved session only when the server confirms that its credentials or room are no longer valid.
- Reconnect the snapshot WebSocket with bounded exponential backoff, refresh state when the app returns to the foreground, and poll snapshots while the socket is unavailable.
- Calculate `live`, `weak`, `stale`, and `missing` GPS states on the authoritative server. Share age and accuracy without exposing coordinates that the viewer is not allowed to see.
- Attach cached battery, power-mode, and network-type health to location heartbeats. Treat these values as status information only; they never influence game outcomes.
- Show accuracy radii only for locations already visible to the viewer.
- Warn a player within ten meters of the boundary and when clearly outside it. Use foreground vibration and background notifications, while keeping boundary elimination based on the existing server-observed grace period.
- Keep pause, resume, tags, traps, cooldowns, boundary decisions, and position acceptance on the room server.

### Consequences

The lobby can explain player readiness without weakening role privacy. Battery and network data may be missing or stale when the operating system stops background work, so the UI labels freshness rather than treating telemetry as proof. The native mobile app must be rebuilt because battery and network Expo modules were added.

### Implementation

- `apps/mobile/src/hooks/useParty.ts`
- `apps/mobile/src/deviceStatus.ts`
- `apps/mobile/src/game/playerHealth.ts`
- `apps/mobile/src/location/backgroundLocation.ts`
- `apps/mobile/App.tsx`
- `packages/game-core/src/rules.ts`
- `packages/protocol/src/index.ts`

## DEC-016 — Reconstructable beta diagnostics

**Status:** Accepted  
**Date:** 2026-09-20

### Context

Field failures can involve the phone operating system, GPS quality, radios, background scheduling, transport, rule validation, or live-state delivery. Crash-only reports and console output cannot explain a successful match or reconstruct the chain that caused an incorrect result.

### Decision

Record an append-only, correlated timeline on both sides of the connection. Each phone first stores client events in SQLite and uploads them opportunistically. Each room stores those events beside authoritative server events in its Durable Object SQLite database. Include precise timestamps, player identity, every authoritative GPS submission, sampled native sensor detail, device health, UI intent, request failures and representative outcomes, state summaries, and rule results. Give only the host access to paginated JSON export. Redact credentials by field name. Use Sentry as the optional native/last-chance crash channel when its DSN and build secrets are configured.

Keep gameplay independent from diagnostics: a storage, upload, export, or Sentry failure may be reported, but cannot reject a game action. Preserve match IDs through the game-over screen so one match can be exported without adjacent lobby traffic.

### Consequences

Field tests become reproducible at request and GPS-sample level, including healthy matches used as a baseline. Diagnostic files contain player names and precise movement trails, so beta consent, restricted access, and a time-based deletion policy are required before distribution beyond the development group. The initial count-based caps are 20,000 queued events per phone and 100,000 events per party.

### Implementation

- `apps/mobile/src/diagnostics/`
- `apps/mobile/src/api.ts`
- `apps/mobile/src/location/backgroundLocation.ts`
- `apps/mobile/src/hooks/useParty.ts`
- `services/game-server/src/room.ts`
- `docs/DIAGNOSTICS.md`

## DEC-017 — Cost-bounded location lifecycle

**Status:** Accepted  
**Date:** 2026-09-20

### Context

Two phones left in a lobby exhausted Cloudflare's 100,000-request free daily allowance. At the original 1.5-second heartbeat, each idle phone generated 57,600 location requests per day, so two phones generated 115,200 requests before diagnostics. Repeated foreground callbacks also restarted Android's location service and made the system location indicator flicker.

### Decision

- Keep continuous 1.5-second background tracking only during hiding, active play, and pause.
- In the lobby, stop the background service and take one foreground fix when joining, returning to the app, returning from a game, or responding to a host start check.
- When a start attempt finds stale GPS, publish a room event that asks every lobby phone for a fresh one-time fix; the host can start once the readiness indicators update.
- Do not restart an Expo location task that Android reports as already running.
- Retain every authoritative match location on the server, but sample routine native client detail every 30 seconds. Always retain upload failures, rejected locations, boundary events, trap events, and other state-changing behavior.
- Do not write a duplicate generic request diagnostic for routes that already write a richer location, diagnostics, or snapshot event.

### Consequences

An idle lobby produces only occasional readiness traffic. A seven-player 45-minute match produces about 12,600 location requests instead of consuming the daily allowance while nobody is playing. Players may need to tap Start a second time after the first attempt refreshes everyone's stale lobby fix. The Android location indicator should remain stable during a match and turn off in the lobby.

### Implementation

- `apps/mobile/src/hooks/partyState.ts`
- `apps/mobile/src/hooks/useParty.ts`
- `apps/mobile/src/location/tracking.ts`
- `apps/mobile/src/location/backgroundLocation.ts`
- `apps/mobile/src/diagnostics/index.ts`
- `packages/game-core/src/rules.ts`
- `services/game-server/src/room.ts`

## DEC-018 — Production Android release configuration

**Status:** Accepted

**Date:** 2026-10-10

### Context

The first Android APK inherited the local emulator endpoint `http://10.0.2.2:8787`. A physical phone cannot use that emulator-only host alias, and the release build rejected its cleartext HTTP traffic. A distributable APK also needs repeatable versioning, a restricted native Maps key, and a verifiable release artifact.

### Decision

- Make the deployed Cloudflare Worker's HTTPS URL the mobile app's default endpoint in committed configuration.
- Permit `EXPO_PUBLIC_GAME_API_URL` to override the default for intentional local builds, but never use an emulator or LAN address as a release default.
- Supply `GOOGLE_MAPS_API_KEY` only at native build time. Restrict it to the Maps SDK for Android, the application package, and every certificate authorized to sign that build; never commit the key value.
- Advance both the application version and Android version code for every published APK.
- Publish internal APKs as GitHub prereleases and verify the public asset's checksum, ZIP integrity, alignment, and Android signature.

### Consequences

Physical-device builds work without a development computer or cleartext network exception. Local development must opt into its endpoint explicitly. The Worker URL is public application configuration, not a credential. The Maps key remains extractable from an APK by design, so its API, package, and signing-certificate restrictions are the security boundary. Changing the signer or key requires updating the Google Cloud restrictions and producing another native build.

### Implementation

- `apps/mobile/app.json`
- `apps/mobile/app.config.ts`
- `apps/mobile/src/config.ts`
- `apps/mobile/.env.example`
- `package.json`
- `apps/mobile/package.json`

## DEC-019 — Authoritative spoken gameplay cues

**Status:** Accepted

**Date:** 2026-10-11

### Context

Outdoor players may have their screens locked or their attention away from the display when a tag or trap changes the game. A notification beep alone is ambiguous. The iOS silent switch and Android silent/vibrate mode do not mute normal media playback, but neither platform lets this game guarantee loudness or force the user's system volume.

### Decision

- Play bundled spoken media only after receiving an authoritative server event, never from a client-side distance guess.
- Play **Tagged** on the successful tagger's and tagged player's phones. Do not play it for uninvolved players.
- Play **Caught in bear trap** only on the trapped seeker's phone. Keep trap placement silent.
- Configure playback for silent mode and background operation, route through the normal media output rather than the earpiece, and duck other audio while the cue plays.
- Do not request microphone permission and do not read or change system volume.
- Deduplicate event IDs across foreground and background snapshot handlers. Ignore events more than ten seconds old so a restore does not replay historic cues.
- Keep tagged/trapped local notifications visible but disable their default notification sound so it does not overlap the spoken clip.
- Record playback start or failure with the authoritative event ID. Audio failure must never change the gameplay result.

### Consequences

The clips behave like video or music audio and can play when the phone's alert switch is silent, but media volume, Bluetooth/headphone routing, operating-system suspension, and device policy can still prevent a player from hearing them. A new native build is required, and foreground plus locked-screen playback must pass on physical Android and iOS devices before audio can be considered reliable. Audio readiness and volume warnings are not yet implemented.

### Implementation

- `apps/mobile/assets/audio/`
- `apps/mobile/src/audio/gameplayAudio.ts`
- `apps/mobile/src/audio/gameplaySoundEvents.ts`
- `apps/mobile/src/audio/gameplaySoundEvents.test.ts`
- `apps/mobile/src/hooks/useParty.ts`
- `apps/mobile/src/location/backgroundLocation.ts`
- `apps/mobile/app.json`

## New decision template

Copy this section to the end of the log and replace the placeholders.

```md
## DEC-NNN — Short decision title

**Status:** Proposed | Accepted | Superseded by DEC-NNN  
**Date:** YYYY-MM-DD

### Context

What problem, constraint, or evidence requires a durable choice?

### Decision

What behavior or approach are we choosing?

### Consequences

What becomes easier, harder, more expensive, or constrained?

### Implementation

- `path/to/code-or-test`
```
