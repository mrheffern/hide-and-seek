# Locked-phone location field test

This is the location-quality portion of the release gate for the automatic tag and trap mechanics. Run it on the intended campus before tuning powers or polishing the UI, alongside the full [gameplay readiness checklist](./GAMEPLAY_TEST_CHECKLIST.md).

## Setup

### v0.1.1 production-path test

1. Use at least two physical Android phones. Include a Pixel and a Samsung-class device when available.
2. Install [`out-of-sight-v0.1.1.apk`](https://github.com/mrheffern/hide-and-seek/releases/download/v0.1.1/out-of-sight-v0.1.1.apk) on each phone. Confirm the installed version is `0.1.1`; updating `v0.1.0` in place is expected to work.
3. Open the app and grant precise location, background location, and notification permissions when requested. Do not use Expo Go for background-location testing.
4. Confirm satellite map tiles load and the app does not report a request to `10.0.2.2`. The production APK must use the deployed HTTPS Worker without a development computer on the network.
5. Record each phone's model, Android version, battery restrictions, network, and starting battery level in the test notes.

### Local-build alternative

1. Install Node.js 22.13 or newer, install dependencies with `npm install`, and copy `apps/mobile/.env.example` to `apps/mobile/.env`.
2. Run `npm run dev:server`. For an emulator, the example `http://10.0.2.2:8787` endpoint is appropriate. For a physical phone, replace it with a reachable endpoint configured for Android networking or an HTTPS tunnel; `10.0.2.2` never identifies the development computer from a physical phone.
3. Configure `GOOGLE_MAPS_API_KEY`, restricted to the Maps SDK for Android, `com.hideandseek.outofsight`, and the exact development signing certificate.
4. Create native development builds. Background location must not be judged in Expo Go.
5. Add an iPhone build to the device set when iOS support is ready for validation.

## Two-phone match checklist

Run this smoke checklist once before beginning the longer locked-phone route. Complete the more detailed scenarios in [GAMEPLAY_TEST_CHECKLIST.md](./GAMEPLAY_TEST_CHECKLIST.md) before making the release decision:

- On phone A, enter a player name and create a party. On phone B, enter a different name and join with the six-character code.
- Confirm both phones show the same party and player list, with connection and GPS-readiness states that update on both devices.
- Wait outdoors until both phones reach the required sustained GPS readiness. A single fix is intentionally insufficient.
- As host, draw and save a valid field, choose the seeker, and review the match settings. Confirm phone B receives every setup change.
- Start the match and verify the hide countdown and active phase agree on both phones.
- Lock each phone for at least five minutes while walking. Confirm Android keeps the location foreground-service notification visible and the server continues receiving timely fixes.
- Unlock and verify current state, locations permitted for each role, timers, and connection health recover without rejoining.
- Briefly disable networking on one phone, restore it, and confirm the connection changes from Reconnecting to Live without losing the party.
- Exercise one observable tag or trap interaction, then finish the round and confirm both phones reach the game-over state.
- Export match diagnostics before returning to the lobby and attach the JSON to the test notes.

## Route

Run a 45-minute outdoor route containing open sky, building edges, tree cover, stationary hiding, walking, running, a Wi-Fi/cellular handoff, and a brief network loss. Keep screens locked and phones in normal pockets for most of the run.

During the network-loss segment, leave and reopen the app without tapping Leave. Confirm that it retains the party, refreshes to the current phase, and changes its connection badge from Reconnecting to Live. Manually pause and resume once as the host.

Repeat approaches to marked physical points at 3, 6, 10, and 20 meters. Cross the requested 6.096-meter trap radius at walking and running speed. Record the physical route independently so GPS outcomes can be compared to observable encounters.

## Capture

Before beginning, agree on the beta player names that will identify each tester in the timeline. At the end of every match, the host must tap **Export match diagnostics** on the game-over screen before returning to the lobby and save the JSON file with the test notes.

- Server receipt interval and GPS sample age
- Reported horizontal accuracy
- Missed or falsely detected tag/trap outcomes
- Time to reconnect and recover current state
- GPS Live/Weak/Stale labels on every phone during each coverage condition
- Accuracy-circle size compared with the reported horizontal accuracy
- Battery and Wi-Fi/cellular indicators in the lobby
- Foreground vibration and locked-screen notification near and outside the boundary
- Host pause visibility and timer behavior on every phone
- Battery level before and after
- Android foreground-service and iOS location indicators
- Whether trap/tag local notifications arrive while locked

Diagnostic exports contain named, precise movement trails and device health. Share them only with the beta team and remove copies after the agreed analysis period.

## Analyze

Run the analyzer against the saved match export:

```sh
npm run analyze:field-test -- path/to/out-of-sight-export.json
```

The report summarizes per-player receipt intervals, sample age, accuracy, background movement, long gaps, reconnects, battery change, network transitions, and tag/trap outcomes without repeating precise coordinates. Add `--json` for machine-readable summarized output. It still contains player names, timestamps, and device-health summaries, so handle it as beta-test data.

Movement is estimated from consecutive GPS coordinates at 0.5 meters per second or faster. Each phone is evaluated independently. The automated gate prefers a phone's background movement when at least 20 such intervals were captured; otherwise it uses all of that phone's estimated movement and says so. An interval is timely only when the server receipt interval and reported sample age are both at most three seconds and the server accepted the fix. A provisional pass requires every phone to provide at least 20 selected intervals and at least 95% of each phone's intervals to be timely. GPS drift can affect the movement estimate, so retain the physical route notes as the ground truth.

The analyzer cannot decide whether a physical tag or trap was falsely detected or missed, nor whether a notification was visible on a locked phone. Review its manual-check list against the testers' notes before declaring the field gate passed.

## Initial gate

The beta can keep automatic tiny-radius mechanics only if moving-player fixes normally arrive within three seconds and observed false/missed outcomes are acceptable to the group. If the gate fails, test wider radii or replace the Expo location adapter with the planned native implementation before expanding the game.
