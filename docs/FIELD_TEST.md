# Locked-phone location field test

This is the release gate for the automatic tag and trap mechanics. Run it on the intended campus before tuning powers or polishing the UI.

## Setup

1. Install Node 24, install dependencies with `npm install`, and copy `apps/mobile/.env.example` to `apps/mobile/.env`.
2. Put the computer and test phones on the same network. Set `EXPO_PUBLIC_GAME_API_URL` to `http://<computer-lan-ip>:8787`; permit inbound TCP 8787 in the local firewall for the test.
3. Configure a Google Maps Android SDK key in `GOOGLE_MAPS_API_KEY`, restricted to `com.hideandseek.outofsight` and the development signing certificate.
4. Run `npm run dev:server`, then create native development builds. Background location must not be judged in Expo Go.
5. Use at least one iPhone, one Pixel, and one Samsung-class Android device when available.

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
