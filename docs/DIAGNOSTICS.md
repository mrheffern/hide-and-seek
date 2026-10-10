# Beta diagnostics and crash reporting

The beta records a reconstructable timeline for each party. The client writes events to a persistent SQLite queue before attempting upload, so app restarts and temporary network loss do not discard the trace. The room server appends client events and its own authoritative decisions to the party's Durable Object SQLite database.

## What is recorded

- App launch, build, operating system, device model, foreground/background changes, session restore, and local crashes
- Party creation, join, leave, player identity, room, match, app session, location session, request, and command correlation IDs
- Every non-GPS HTTP request outcome, every GPS transport/rejection failure, and WebSocket connect, message, error, close, retry, and fallback refresh
- Every UI command, boundary drawing action, command payload, rejection, and authoritative state transition
- Every authoritative GPS submission and result on the server; sampled native motion detail and battery/network health every 30 seconds; every rejection, boundary assessment, tag/trap effect, and related game event
- Server clock transitions, snapshots, socket presence, duplicate commands, schema rejections, export requests, and rule results
- JavaScript/React crashes locally and in Sentry when a DSN is configured; native crashes and symbolicated production stacks require Sentry configuration and source-map upload

Authorization headers, player tokens, API keys, passwords, and fields with equivalent names are redacted. Diagnostic exports contain precise movement history and player names and should be handled as sensitive beta-test data.

## Export a test

The host can tap **Export match diagnostics** in the lobby or after a match. On the game-over screen, export before returning to the lobby because returning clears the current match ID. The app first uploads its offline queue, downloads the server timeline in sequence order, creates a formatted JSON file, and opens the phone's share sheet.

The JSON file contains `clientAtMs` (phone clock), `serverAtMs` (receipt time), `sequence` (authoritative ordering), `source`, identity and correlation fields, plus the event payload. Use `sequence` to establish server order and compare the two timestamps to spot clock skew or network delay.

Only the host token can read diagnostics. Players can upload their own client events but cannot read the combined party trace.

### Use during gameplay testing

Treat one finished-match export as the evidence bundle for each checklist run:

1. Before exporting, bring every phone online and foreground the app until it shows **Live**. Wait at least 30 seconds so each phone's periodic uploader can send queued client events.
2. On the game-over screen, the host taps **Export match diagnostics** before returning to the lobby. The app first flushes the host's local queue, captures a fixed server sequence boundary, downloads the combined match timeline in pages, writes a formatted JSON file, and opens the system share sheet.
3. Save the raw JSON privately. Its `localPendingEventCount` reports pending events on the exporting host only; confirm all expected players and time ranges appear in the analysis rather than assuming other phones uploaded everything.
4. Run `npm run analyze:field-test -- path/to/export.json` for a coordinate-free text report. Add `--json` for structured summary and decision evidence; that output also omits raw coordinates.
5. Compare the report with the observer's notes from [GAMEPLAY_TEST_CHECKLIST.md](./GAMEPLAY_TEST_CHECKLIST.md). The export records what devices and the server observed, but cannot establish physical ground truth, notification visibility, or whether a real-world tag should have occurred.

The analyzer reports per-player receipt intervals, sample age and accuracy distributions, locked-screen movement evidence, long gaps, network switches, battery change, reconnect duration, tag attempts, trap placement/trigger/release, boundary eliminations, and the nearest available GPS evidence for authoritative decisions. A **provisional-pass** means the data target passed; it does not replace the manual gameplay checks.

## Crash service setup

The app works without Sentry and still preserves JavaScript error events in its local/server diagnostic stream. To collect native process crashes and reports when the app cannot upload its own queue:

1. Create a React Native project in Sentry.
2. Put its DSN in `EXPO_PUBLIC_SENTRY_DSN` for the build.
3. Configure Sentry's organization and project for the build environment and store `SENTRY_AUTH_TOKEN` as a build secret so release source maps and native symbols upload.
4. Produce a new native build and verify one handled test error and one test crash before field testing.

For a local build before that project exists, set `SENTRY_DISABLE_AUTO_UPLOAD=true`; otherwise the Sentry Gradle task correctly refuses to upload source maps without an organization and project.

Do not commit the DSN configuration file if it contains additional secrets, and never use an `EXPO_PUBLIC_` variable for the auth token.

## Storage and limits

- Each phone retains the newest 20,000 events that have not yet been accepted by the server.
- Each party retains the newest 100,000 server/client events in its Durable Object.
- Uploads use batches of at most 100 events; exports page at 1,000 events.
- Individual server payloads are limited to 16 KB and oversized payloads retain a marked preview.
- Diagnostics upload failures never block gameplay; they remain queued and retry after reconnect, foreground resume, normal GPS traffic, or export.

The current beta uses count-based retention. Before inviting testers outside the development group, add a time-based deletion policy and disclose collection of names, precise locations, device state, and crash data in the beta consent text.

## Reading a failed interaction

Start with a client `interaction.command_button_pressed`, follow its command ID through `network.request_started`, then find the server `command.command_processed`. Compare its `before`, `result`, `after`, and `gameEvents`, and finally locate the client's `network.request_succeeded` and next `state.snapshot_received`. A missing segment identifies whether the failure occurred before transport, at authorization/validation, inside the game rules, during response delivery, or while applying live state.

For GPS issues, start with each server `location.location_processed` event. At 30-second intervals, correlate it with `location.native_location_received` and `location.location_accepted` using `sessionId:sequence` to inspect the extra OS motion fields. Failures are always retained even between samples.

## Android endpoint and map troubleshooting

An error containing the following text identifies an obsolete physical-device build or an endpoint override that was accidentally baked into it:

```text
fetch failed: java.net.UnknownServiceException:
CLEARTEXT communication to 10.0.2.2 not permitted by network security policy
```

`10.0.2.2` is an Android emulator alias. It does not refer to the development computer from a physical phone, and production Android builds reject cleartext HTTP by default. Install `v0.1.1` or newer and confirm the app version is `0.1.1` with version code `2`. That release defaults to the production HTTPS Worker. If the error remains in a newly built APK, remove the `EXPO_PUBLIC_GAME_API_URL` override or replace it with the intended reachable HTTPS endpoint, then rebuild the native app.

If network requests work but the map remains blank, verify that the Google Cloud project has billing enabled, the Maps SDK for Android is enabled, and the key is restricted to `com.hideandseek.outofsight` plus the SHA-1 fingerprint of the certificate that actually signed the installed APK. A different signing certificate requires another allowed Android application restriction and a new native build if the key changes. Never add the key value to diagnostics or tracked documentation.
