# Gameplay readiness checklist

Use this checklist to decide whether the current Android beta is ready for the next development or distribution milestone. It complements the longer [locked-phone location field test](./FIELD_TEST.md): this file covers game behavior and release decisions, while the field-test document explains the route and GPS analysis in more depth.

Do not test near traffic, restricted property, cliffs, water, or other hazards. Choose a field large enough that players can cross boundaries and measured distances without watching their phones while moving.

## Release decision

Do not move on while any must-pass item is failing or untested:

- [ ] Two complete two-player matches pass with the players swapping seeker and hider roles.
- [ ] One complete match with at least three players passes, including two active hiders.
- [ ] No player sees a role-protected location, trap, or event.
- [ ] No false tag, trap trigger, or boundary elimination occurs in the recorded scenarios.
- [ ] Open-sky automatic tags and traps work repeatably at the intended 6.096-meter / 20-foot radius.
- [ ] Four seconds of observed stillness reliably blocks only automatic tags, and credible movement reliably restores them without GPS-jitter flicker.
- [ ] Near buildings and trees, weak GPS causes a safe refusal or pause rather than a false game outcome.
- [ ] Every test phone keeps uploading usable locations for 30–60 minutes while locked and carried normally.
- [ ] A network loss and app reopen recover the same party, authoritative match state, and fresh GPS uploads without rejoining.
- [ ] Spoken tag and trap cues reach exactly the involved phones in foreground and locked-screen tests without duplicate or stale playback.
- [ ] Every completed match produces a diagnostics export with all players represented and no unexplained event gaps.
- [ ] Every blocker found during testing is fixed and the failed scenario is rerun on the affected devices.

The automated analyzer can produce only a **provisional** GPS pass. A human must compare its events with the independently recorded physical test before checking off the release decision.

## Test record

Create one copy of this block for each match:

```text
Date/time:
Build and Android version code:
Party code:
Match ID:
Testers and roles:
Phone models and Android versions:
Battery optimization settings:
Weather and test locations:
Network conditions:
Scenario IDs completed:
Failures, timestamps, and reproduction notes:
Diagnostics filename:
Analyzer result:
Final result: PASS / FAIL / BLOCKED
```

Mark every scenario **Pass**, **Fail**, or **Blocked**, and record a wall-clock timestamp for each important action. If a result is surprising, leave the phones and party intact, write down what physically happened, and export diagnostics before trying again.

## Current beta preset

These expectations come from the authoritative server rules, not from phone-side guesses:

| Rule | Expected value |
| --- | ---: |
| Tag radius | 6.096 m / 20 ft |
| Automatic-tag proximity dwell | 1 continuous observed second |
| Hidden Mode entry | 4 continuous observed stationary seconds |
| Hidden Mode movement threshold | 3 m beyond GPS-accuracy allowance or at least 0.8 m/s, sustained for 1 second |
| Bear-trap radius | 6.096 m / 20 ft |
| Trap arming delay | 5 seconds |
| Trap escape dwell | 15 continuous observed seconds inside the circle |
| Trap lifetime | 5 minutes of unpaused game time |
| Trap allowance | 1 per hider per round |
| Radar visibility | 3 seconds |
| Radar cooldown | 5 minutes |
| Hiding countdown | 10 seconds |
| Round duration | 30 minutes |
| Boundary warning distance | 10 meters inside the edge |
| Boundary grace | 15 continuous observed seconds clearly outside |
| Tag-attempt cooldown | 2 seconds |
| Automatic disconnect pause | 10 seconds without a current player location |
| Competitive GPS | at most 3 seconds old and at most 10 meters reported accuracy |
| Maximum continuous-observation gap | 4 seconds |
| Lobby GPS verification | 5 continuous seconds of competitive-quality observations |

## Test equipment and course

- [ ] Use the same app build on every phone and record its version.
- [ ] Use at least two Android models; include a Pixel and a Samsung-class phone when available.
- [ ] Charge the phones, disable vendor-specific battery restrictions for the baseline run, and record any later run with restrictions enabled.
- [ ] Mark measured points at the trap/tag center, 3 m, 6 m, 6.1 m, 8 m, and 10 m. Phone positions—not the testers' bodies—define the measurement.
- [ ] Draw a safe field with an edge that can be crossed intentionally. Mark points about 10 m inside, just inside, just outside, and clearly outside.
- [ ] Identify four GPS environments: open sky, beside a building, under trees, and a Wi-Fi/cellular transition.
- [ ] Assign an observer to record physical truth, timestamps, and phone states without relying on the in-app map.

Run the measured-distance mechanics in open sky first. Repeat them near a building only to verify safe degradation; multipath GPS may make a 20-foot competitive radius physically unreliable there.

## A. Install, permissions, maps, and service

- [ ] **A1 — Install/update:** Install `v0.1.5` on every phone. Updating an earlier beta in place preserves the app and launches successfully. Confirm no older protocol-1 beta remains in the test group.
- [ ] **A2 — Production endpoint:** Create a party over cellular with no development computer present. No error mentions `10.0.2.2` or cleartext HTTP.
- [ ] **A3 — Map:** Satellite tiles load, the map centers near the phone after a fix, and pan/zoom remain responsive.
- [ ] **A4 — Permissions:** Grant precise foreground location, background location, and notifications. Denying each permission produces a useful recovery message rather than a crash.
- [ ] **A5 — Relaunch:** Close and reopen the app in the lobby. The saved party returns with the correct player identity.

## B. Party, host, and lobby

- [ ] **B1 — Create/join:** Phone A creates a party and phone B joins using the six-character code. Both show the same roster and code.
- [ ] **B2 — Input errors:** Blank names, invalid codes, and malformed input show clear errors without changing party state.
- [ ] **B3 — Host authority:** A non-host cannot draw/save the field, choose the seeker, start, pause, resume, or return a finished match to the lobby.
- [ ] **B4 — Host transfer:** In a disposable lobby, the host leaves. One remaining active player becomes host and can configure the party.
- [ ] **B5 — Capacity, optional:** Seven players can join; an eighth is rejected as room full.
- [ ] **B6 — Lobby GPS:** In open sky, each player progresses from stabilizing to GPS verified only after about five continuous seconds of precise observations.
- [ ] **B7 — Weak lobby GPS:** Beside a building or with approximate location, weak GPS does not become verified until precise observations stabilize.
- [ ] **B8 — Start blockers:** Start is blocked until there are at least two players, one seeker, a valid saved boundary, verified GPS for everyone, and every player is inside the field.
- [ ] **B9 — Join lock:** A new phone cannot join after the match starts.

## C. Field drawing and boundary setup

- [ ] **C1 — Valid boundary:** The host can draw, undo, save, and redraw a polygon with at least three valid points; every phone receives the saved shape.
- [ ] **C2 — Invalid boundary:** Duplicate, collinear, zero-area, or self-crossing boundaries are rejected with a useful message.
- [ ] **C3 — Authority and phase:** Non-hosts cannot change the boundary, and the boundary is locked once the match starts.
- [ ] **C4 — Outside at start:** A player clearly outside the saved polygon prevents the match from starting.

## D. GPS quality in real environments

Perform the same walk in each environment and record the app's GPS label, reported accuracy, observed map drift, receipt gaps, and physical route:

- [ ] **D1 — Open sky:** Walk and stand still with the app foregrounded. GPS reaches Live and follows the marked route without large unexplained jumps.
- [ ] **D2 — Open sky, locked:** Lock the phone and carry it normally for at least five minutes. The Android foreground-service notification remains visible and server fixes continue.
- [ ] **D3 — Building edge:** Walk parallel to and around a building. Accuracy circles and Live/Weak/Stale labels reflect degradation; no false tag, trap, or boundary outcome occurs.
- [ ] **D4 — Tree cover:** Repeat under trees. Degraded observations are refused or marked weak rather than converted into a false outcome.
- [ ] **D5 — Stationary:** Remain still for five minutes with the phone locked. Health stays current without requiring artificial movement.
- [ ] **D6 — Network handoff:** Walk through a Wi-Fi-to-cellular handoff. Record any fix gap and confirm the party state remains authoritative.
- [ ] **D7 — Pocket orientation:** Carry each phone in its normal pocket or bag and compare it with a brief screen-up baseline.

For the final locked-phone route, every phone needs at least 20 estimated moving intervals and at least 95% timely intervals in the analyzer. “Timely” means the server receipt interval and sample age are each no more than three seconds and the server accepted the fix.

## E. Match phases and role privacy

- [ ] **E1 — Countdown:** Starting the match begins the 10-second hiding phase on every phone with synchronized timers.
- [ ] **E2 — Active transition:** The match changes to active play at the same server deadline on every phone without requiring a button press.
- [ ] **E3 — Hider visibility:** Active hiders see themselves and other active hiders but never the seeker's coordinates.
- [ ] **E4 — Seeker visibility:** The seeker sees no active hider coordinates except during the three-second radar window.
- [ ] **E5 — Health without coordinates:** Players may see permitted GPS, connection, battery, and network health without hidden coordinates leaking.
- [ ] **E6 — Eliminated privacy:** An eliminated hider no longer sees active hider locations or live trap positions.
- [ ] **E7 — Timer source:** Countdown, round, radar, trap, and pause timers agree across phones even if their system clocks differ.

Any hidden-coordinate or hidden-trap leak is an immediate release blocker. Capture screenshots from both roles and preserve the export.

## F. Automatic tag and Hidden Mode behavior

Repeat the distance cases at least five times in open sky with both phones reporting competitive GPS:

- [ ] **F1 — Outside radius:** Keep a moving, non-hidden hider 8–10 m from the seeker. No automatic tag occurs.
- [ ] **F2 — Moving inside radius:** Move a non-hidden hider within 3 m of the seeker for more than one continuously observed second. The hider is automatically tagged without either player touching the phone.
- [ ] **F3 — Brief crossing:** Cross the radius for less than one second. A single proximity sample does not award an automatic tag.
- [ ] **F4 — Threshold:** Repeat moving approaches on both sides of 6.096 m / 20 ft and record physical positions, reported positions, and every result.
- [ ] **F5 — Uncertain GPS:** If either nearby phone reports worse than 10 m accuracy or a stale fix, the server refuses to award an automatic or manual tag instead of guessing.
- [ ] **F6 — Hidden entry:** During the hiding countdown, hold the hider still with competitive GPS. The hider shows the countdown and becomes **HIDDEN** after about four continuously observed seconds.
- [ ] **F7 — Hidden privacy:** The hider sees their own Hidden Mode state. The seeker receives no badge, countdown, transition event, or hidden-state field.
- [ ] **F8 — Hidden immunity:** Approach a hidden hider and remain within 3 m for several seconds. No automatic tag occurs.
- [ ] **F9 — Manual discovery:** While the hider remains hidden and physically visible to the seeker, tap **TAG** within range. The manual tag succeeds.
- [ ] **F10 — GPS jitter:** Leave a hidden phone physically still for at least five minutes in open sky, then near a building. Accuracy-sized drift does not repeatedly reveal and re-hide the player.
- [ ] **F11 — Movement exit:** From Hidden Mode, walk or run away. Sustained movement or at least 3 m of accuracy-adjusted displacement removes the **HIDDEN** state; re-entering proximity then permits auto-tag after a fresh one-second dwell.
- [ ] **F12 — Observation reset:** Weak GPS, a location gap longer than four seconds, pause/resume, and reconnect each clear Hidden Mode and require a new four-second stationary observation.
- [ ] **F13 — Manual cooldown and authority:** A failed manual TAG attempt enforces the two-second cooldown. Hiders never receive an enabled tag action, and a non-seeker cannot tag.
- [ ] **F14 — Multiple targets:** With two non-hidden hiders in range, only the nearest qualifying hider is automatically eliminated per observation; the other remains active.
- [ ] **F15 — Elimination feedback:** An automatic or manual tag produces **Tagged** exactly once for the seeker and tagged hider, stops the eliminated phone's location sharing, and disables hider actions.
- [ ] **F16 — Win:** Tagging the final active hider ends the match with a seeker win on every phone.

## G. Radar behavior

- [ ] **G1 — Seeker only:** Only the active seeker can use Radar.
- [ ] **G2 — Reveal window:** Radar reveals active hiders to the seeker for about three seconds, then removes them again.
- [ ] **G3 — Privacy:** Hiders do not receive the seeker's radar timing or any extra hidden coordinates.
- [ ] **G4 — Cooldown:** A second use is rejected until the five-minute cooldown ends; it becomes available afterward.
- [ ] **G5 — Disabled states:** Radar is unavailable during hiding, pause, a trap hold, and while the seeker is outside the boundary.

## H. Bear-trap behavior

Use a marked trap center and have the observer call each crossing and timestamp:

- [ ] **H1 — Placement rules:** Only an active hider with a current precise in-boundary location can place a trap.
- [ ] **H2 — Allowance:** Each hider receives one trap for the round; a second placement is rejected.
- [ ] **H3 — Visibility:** Active hiders see unconsumed traps. The seeker cannot see their positions or placement events before triggering one.
- [ ] **H4 — Arming:** Entering during the first five seconds does not trigger the trap. Exit, wait until it arms, and re-enter to confirm it can trigger.
- [ ] **H5 — Trigger radius:** A current precise seeker fix inside 6.096 m triggers the trap; a clearly outside fix does not.
- [ ] **H6 — Weak/stale GPS:** A delayed or worse-than-10-meter fix does not trigger a trap.
- [ ] **H7 — Trigger feedback:** The seeker receives trapped UI/notification feedback and can see the triggered circle; the event appears on the other phones without revealing it early.
- [ ] **H8 — Disabled powers:** TAG and Radar are disabled while the seeker is trapped.
- [ ] **H9 — Continuous escape:** Stay inside the trap for 15 continuously observed seconds. The progress reaches completion and releases the seeker.
- [ ] **H10 — Exit and re-enter:** Trigger a fresh trap, remain inside for about 8 seconds, step clearly outside, and return. Progress resets to zero; after re-entry the seeker must complete a new full 15-second continuous dwell before release.
- [ ] **H11 — Observation gap:** During a fresh hold, interrupt current precise observations for more than four seconds. Progress resets instead of granting time that was not observed.
- [ ] **H12 — Single use:** After release, leave and re-enter the same circle. The consumed trap does not trigger again.
- [ ] **H13 — Expiry:** Leave a fresh trap unused for more than five minutes of unpaused game time. It disappears and cannot trigger.
- [ ] **H14 — Pause:** Pause while a trap is arming or active. Its arming and expiry clocks shift by the paused duration, and trapped dwell does not accumulate while paused.
- [ ] **H15 — Multiple hiders:** In a three-player match, each hider can place one trap and both are independently represented in the diagnostics.

Two proposed balance rules in `ARCHITECTURE.md` are not currently enforced by the game rules: preventing overlapping active traps and granting brief immunity after trap release. Before broader play, decide whether each is required. If required, implement it and add explicit field scenarios before checking the overall release gate.

## I. Boundary behavior

- [ ] **I1 — Near warning:** At about 10 m inside the boundary, the player's warning and estimated distance appear without marking the player outside.
- [ ] **I2 — Brief exit:** A hider steps clearly outside for less than 15 observed seconds and returns. The warning clears and the grace timer resets without elimination.
- [ ] **I3 — Exit and re-enter:** The hider goes outside, returns inside, then leaves again. The second exit starts a new grace period rather than continuing the first.
- [ ] **I4 — Sustained exit:** A hider remains clearly outside for 15 continuously observed seconds and is eliminated.
- [ ] **I5 — GPS uncertainty:** When the accuracy circle overlaps the edge, outside time does not accumulate and the player is not falsely eliminated.
- [ ] **I6 — Observation gap:** A gap longer than four seconds does not count unobserved time toward elimination.
- [ ] **I7 — Outside seeker:** The seeker remains in the match but cannot Tag or use Radar until returning inside.
- [ ] **I8 — Background warning:** With the phone locked, crossing the boundary produces the expected notification and returning clears the condition.

## J. Pause, reconnect, and locked-phone recovery

- [ ] **J1 — Manual pause:** Only the host can pause. All phones show the paused phase, and match/radar/trap timers stop advancing.
- [ ] **J2 — Resume readiness:** Resume is blocked until every active player has a fresh, precise location; once ready, only the host can resume.
- [ ] **J3 — Short network loss:** Disable one phone's network briefly, restore it, and confirm the badge moves from Reconnecting to Live with the same party and state. Its GPS must move from Stale to Live using new fixes without leaving or rejoining.
- [ ] **J4 — Automatic pause:** Keep an active player's location unavailable for more than 10 seconds. The server pauses before applying later round outcomes.
- [ ] **J5 — Reopen:** During a controlled outage, close and reopen the app without tapping Leave. It restores the session and catches up to the authoritative phase.
- [ ] **J6 — Locked screen:** Lock every phone for at least five minutes during active play. Location uploads and relevant trap/boundary notifications continue.
- [ ] **J7 — Process recovery:** After Android removes the app from memory naturally, reopening restores the saved party. Record separately if the tester force-stopped the app, because Android intentionally disables background work after a force stop.
- [ ] **J8 — No duplicate state:** Reconnects never roll the UI back to an older phase, revive an eliminated player, duplicate a trap, or repeat a consumed action.
- [ ] **J9 — Host evidence access:** During lobby, hiding, active play, and pause, only the host sees **Export party/match diagnostics** and can save an export without ending or resetting the match. Confirm it remains available on the finished screen too.

## K. Match completion, rematch, and leave behavior

- [ ] **K1 — Seeker win:** All hiders tagged, eliminated, or departed produces a seeker win consistently on every phone.
- [ ] **K2 — Hider win:** Let one full timed test run expire, or verify the seeker leaving a running match awards the hiders the win.
- [ ] **K3 — Game over:** The winner, reason, and latest events agree on every phone, and active location sharing stops for finished/eliminated players.
- [ ] **K4 — Export:** Before returning to the lobby, the host exports the finished match diagnostics, saves the JSON to Downloads on Android or Files on iOS, closes the app, and confirms the file remains available.
- [ ] **K5 — Rematch:** Only the host can return to the lobby. The boundary remains, traps and winner clear, players become active, and GPS must be verified again.
- [ ] **K6 — Leave cleanup:** Leaving turns off active location tracking and removes or transfers host authority as appropriate.

## L. Diagnostics evidence workflow

At the end of each match:

1. Bring every phone online and open the app long enough to show **Live**. Wait at least 30 seconds so each client's periodic diagnostics upload has an opportunity to run.
2. The host may tap **Export match diagnostics** during any match phase when a failure occurs, or on the finished screen before **Return to lobby**. The app flushes the host's local queue and downloads the server's match timeline. On Android, choose a private test folder such as Downloads in the system folder picker; on iOS, choose **Save to Files** in the native sheet.
3. Confirm the JSON remains in that folder after closing the app. Do not post it publicly: it contains player names and precise movement history.
4. Run the coordinate-free summary:

   ```sh
   npm run analyze:field-test -- path/to/out-of-sight-export.json
   ```

5. For detailed decision evidence without raw coordinates, run:

   ```sh
   npm run analyze:field-test -- path/to/out-of-sight-export.json --json
   ```

6. Confirm every expected player appears, the analyzer has enough moving intervals, and the counts for tags, traps placed/triggered/released, boundary eliminations, and reconnects match the observer's notes.
7. Compare each decision's timestamp, sample age, reported accuracy, and accepted/rejected result with the measured physical event. The analyzer cannot know the real-world distance or whether a notification was visible.
8. Attach the analyzer report, physical notes, screenshots/video, and issue links to the test record. Retain the raw export only as long as the beta team needs it.

The JSON can be provided directly to a developer—or uploaded in this workspace—for deeper review. See [DIAGNOSTICS.md](./DIAGNOSTICS.md) for its contents, privacy limits, and event-tracing method.

## M. Spoken gameplay audio

These checks cover the bundled media cues retained in `v0.1.3`. The app does not yet monitor media volume or output routing, so confirm those settings manually before each run.

- [ ] **M1 — Silent placement:** Placing a bear trap makes no sound on any phone.
- [ ] **M2 — Tag participants:** A successful tag plays **Tagged** once on the seeker's phone and once on the tagged hider's phone.
- [ ] **M3 — Tag privacy:** An uninvolved hider does not hear the tag cue.
- [ ] **M4 — Trap target:** Triggering an armed trap plays **Caught in bear trap** once on the trapped seeker's phone and not on the trap owner's or other players' phones.
- [ ] **M5 — Foreground and locked:** Repeat one tag and one trap with the affected phone foregrounded, then in a separate round with it locked. The spoken cue is audible in both states.
- [ ] **M6 — Silent modes:** On Android, repeat with silent/vibrate mode enabled. On iOS when an iOS build is available, repeat with the silent switch enabled. The media cue still plays when media volume is audible.
- [ ] **M7 — Output route:** Test low media volume and a connected Bluetooth/headphone route. Confirm the cue follows the active media route; record this as an environmental limitation, not a game override.
- [ ] **M8 — No replay:** Reconnect or reopen immediately after an event and confirm repeated snapshots do not replay the cue. Reopening later must not play an old event.
- [ ] **M9 — Evidence:** The diagnostics export contains `audio/gameplay_sound_started`, or `audio/gameplay_sound_failed` if playback failed, correlated to the authoritative event ID on each intended phone.

## Failure handling

- Stop the run immediately for a crash, privacy leak, false elimination, or unsafe distraction.
- Preserve the party until the host exports diagnostics.
- Record the exact scenario ID, physical positions, wall-clock time, foreground/background state, network, GPS label/accuracy, and what each phone displayed.
- Reproduce once only when it is safe. Do not repeatedly overwrite the original evidence.
- Classify the issue as release-blocking, important, or cosmetic; assign an owner; and rerun the same scenario after the fix.
- A failed automatic mechanic is not excused solely because GPS was poor. The safe expected result under uncertainty is refusal, pause, or no outcome—not a confident false outcome.
