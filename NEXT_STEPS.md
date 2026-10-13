# Next steps

This is the active, ordered plan for moving Out of Sight from the current Android beta toward the first two-college league pilot. It translates the long-term [product and sport vision](./docs/PRODUCT_VISION.md) into the work that matters now.

Keep this document short and current. Detailed procedures belong in the linked test and operating documents. When a milestone passes, record the evidence, update the current milestone, and move the completed section into a brief dated history at the end.

## Current milestone

**Prove the physical core loop on real phones.**

The current build is the [`v0.1.4` Android prerelease](https://github.com/mrheffern/hide-and-seek/releases/tag/v0.1.4). It has the production Worker and Maps configuration, automatic tags with private Hidden Mode, authoritative GPS-based rules, durable diagnostics export, and spoken tag and trap cues. Automated tests and APK verification pass. Real-world multi-phone gameplay remains the gate.

Do not begin league-system development until this milestone passes or the field evidence clearly establishes what must change.

## Now — run the field and gameplay gate

Complete these steps in order.

### Pending field-test change set

Do not treat the current build as having passed the gate. Preserve the exports and screenshots for these findings, then fix and rerun their exact scenarios together:

- [x] Recover from a saved party that cannot reconnect instead of leaving the phone indefinitely on **Connecting to party**.
- [x] Remove radar player markers and their accuracy circles together when the three-second reveal ends; verify no stale native map overlay remains.
- [x] Keep the bear-trap marker's arming label and the button progress synchronized through the five-second arm transition on Android.
- [x] Change the server-authoritative hiding countdown from 60 seconds to **10 seconds**, and update its automated tests, player-facing copy, checklist, and recorded beta preset at the same time.
- [x] Make **Export match diagnostics** save a durable JSON file on the phone instead of leaving the only copy in temporary cache. On Android, provide a system-backed save flow suitable for Downloads; on iOS, provide the equivalent Save to Files flow. Keep sharing available, show the resulting filename/location or a clear cancellation message, and test that the file remains available after the app closes.
- [x] Add server-authoritative auto-tagging for moving hiders and a private Hidden Mode after four seconds of credible stillness. Preserve manual TAG for physical discovery, handle GPS jitter conservatively, and add exact field scenarios before publishing the next prerelease.

### 1. Prepare the test run

- [ ] Recruit at least two testers and obtain at least two Android models; include a Pixel and Samsung-class phone when available.
- [ ] Plan one three-player run in addition to the two-player role-swap runs.
- [ ] Choose a safe field with open sky, a building edge, tree cover, marked distances, and a boundary that can be crossed deliberately.
- [ ] Install `v0.1.4` on every phone and record the phone model, Android version, battery restrictions, network, and starting battery.
- [ ] Assign one person to record physical observations and timestamps instead of relying on what the app reports.
- [ ] Prepare a private location for the exported diagnostics because they contain player names and precise movement history.

Use the setup and safety instructions in [FIELD_TEST.md](./docs/FIELD_TEST.md).

### 2. Run the short two-phone smoke match

- [ ] Create and join a party over the production Worker with no development computer involved.
- [ ] Confirm permissions, satellite maps, roster updates, GPS readiness, boundary setup, seeker selection, and match start.
- [ ] Lock both phones for at least five minutes while moving and confirm location tracking continues.
- [ ] Interrupt and restore one phone's network, then confirm it recovers the same party and current match.
- [ ] Place a bear trap and verify placement is silent.
- [ ] Trigger the trap and verify only the trapped seeker hears **Caught in bear trap**.
- [ ] Complete a tag and verify the seeker and tagged hider each hear **Tagged** once.
- [ ] Finish the match and export its diagnostics before returning to the lobby.

If this smoke match reveals a crash, privacy leak, false elimination, or other safety or competitive-integrity problem, stop and triage it before running the longer route.

### 3. Run the full gameplay checklist

Complete every scenario in [GAMEPLAY_TEST_CHECKLIST.md](./docs/GAMEPLAY_TEST_CHECKLIST.md), including:

- [ ] Two complete two-player matches with roles swapped.
- [ ] One complete match with at least three players and two active hiders.
- [ ] Open-sky tag and trap tests at marked distances around the 6.096-meter / 20-foot threshold.
- [ ] GPS degradation tests beside a building and under trees.
- [ ] Bear-trap arming, trigger, continuous escape, exit and re-entry reset, observation-gap reset, single-use, and expiry behavior.
- [ ] Boundary warning, brief exit, re-entry reset, sustained exit, uncertainty, and observation-gap behavior.
- [ ] Radar, role privacy, pause/resume, reconnect, app reopen, match completion, rematch, and leave behavior.
- [ ] Spoken audio in the foreground and while locked, including silent/vibrate mode and Bluetooth or headphone routing.

Record each scenario as **Pass**, **Fail**, or **Blocked** with its timestamp and physical observation.

### 4. Run the locked-phone route

- [ ] Complete the 30–60 minute route in [FIELD_TEST.md](./docs/FIELD_TEST.md).
- [ ] Include open sky, building edges, tree cover, stationary periods, walking, running, a Wi-Fi/cellular handoff, and a brief network loss.
- [ ] Keep screens locked and phones carried normally for most of the route.
- [ ] Confirm the Android foreground service remains active and every phone continues sending current locations.
- [ ] Record real-world distances and outcomes independently of the app.

### 5. Export and analyze the evidence

- [ ] Bring every phone online and foreground it until it reports **Live**; wait at least 30 seconds for queued diagnostics to upload.
- [ ] Export the finished match from the host before returning to the lobby.
- [ ] Run `npm run analyze:field-test -- path/to/export.json`.
- [ ] Run the analyzer again with `--json` for structured decision evidence.
- [ ] Confirm every tester appears and the tag, trap, boundary, reconnect, and audio events match the observer's notes.
- [ ] Upload the export here for deeper review when needed, treating it as sensitive test data.

The analyzer may issue a provisional GPS pass, but only the diagnostics plus the physical observations can establish whether the actual game behavior was correct.

## Gate for moving forward

The physical-core milestone passes only when all of the following are true:

- [ ] Two role-swapped two-player matches and one three-player match complete successfully.
- [ ] No role-protected location, trap, or event leaks to an unauthorized player.
- [ ] No unexplained false tag, trap trigger, or boundary elimination remains.
- [ ] Weak GPS fails safely rather than producing a confident false outcome.
- [ ] Every phone supplies usable locked-screen locations for the full route, with no unexplained event gaps.
- [ ] Network loss and app reopen recover the authoritative party and match state.
- [ ] Spoken cues reach exactly the intended phones without duplicate or stale playback.
- [ ] Diagnostics and observer notes explain every important outcome.
- [ ] Every release-blocking defect is fixed and its failed scenario passes on a rerun.

If the gate fails because a 20-foot automatic mechanic is not dependable, test a wider radius or a different rule interaction before investing in league features. Do not conceal GPS uncertainty with more permissive client behavior.

## Immediately next — fix, retest, and stabilize

For every failure:

1. Preserve the original export, physical notes, screenshots, and build number.
2. Classify it as safety, privacy, competitive integrity, reliability, usability, or cosmetic.
3. Fix issues in that priority order.
4. Add an automated regression test where software can reproduce the failure.
5. Publish an incremented prerelease build.
6. Rerun the exact failed scenario on the affected devices.
7. Rerun the full release gate when the change could affect GPS, networking, timing, permissions, background execution, privacy, or game outcomes.

The output of this stage is a field-validated core build, a complete evidence package, and an explicit decision about whether the current tag/trap distances remain viable.

## After the gate — prove repeat casual play

The next product milestone is not league software. It is proving that ordinary groups can start, understand, finish, and voluntarily repeat the physical game without the founder operating every match.

- [ ] Run several sessions with new players and different group sizes.
- [ ] Observe installation, permissions, setup, rule teaching, and first-match confusion without coaching prematurely.
- [ ] Measure time to first match, completion rate, immediate rematches, later return play, and invitations.
- [ ] Interview players about fun, strategy, downtime, fairness, safety, and memorable moments.
- [ ] Improve onboarding, rules presentation, readiness checks, and recovery based on repeated evidence.
- [ ] Add a media-volume/test-sound readiness flow if missed audio is a recurring field problem.
- [ ] Tune powers only when they increase meaningful strategy and counterplay.

This milestone passes when several groups can complete matches independently and enough players choose to play again that a campus community is plausible.

## Then — design the minimum league system

Define the sport before building extensive league screens:

- [ ] Choose the competitive team size and match format.
- [ ] Draft the official rulebook, field criteria, safety standard, and equipment/device policy.
- [ ] Decide the short-season structure and how a campus champion qualifies for inter-school play.
- [ ] Define substitutions, forfeits, rankings, disputes, discipline, and organizer authority.
- [ ] Establish privacy, location-retention, consent, anti-cheat, and incident procedures.
- [ ] Interview prospective players, captains, campus organizers, and school stakeholders.

Build only the minimum infrastructure the pilot requires:

- [ ] Persistent player identity and accounts.
- [ ] Teams, captains, and rosters.
- [ ] Approved fields and official rule presets.
- [ ] Scheduling, results, standings, and season administration.
- [ ] Match evidence and organizer dispute review.
- [ ] Basic spectator-safe results and shareable match stories.

## Pilot — seed two rival colleges

- [ ] Select two nearby colleges with a meaningful rivalry and practical test fields.
- [ ] Recruit and train at least one reliable organizer at each school.
- [ ] Seed casual games before requiring league commitment.
- [ ] Recruit teams and run a short, closely supported season on each campus.
- [ ] Track participation, retention, organizer labor, disputes, safety, costs, and willingness to pay.
- [ ] Hold an inter-school championship with a clear story, result, and content plan.
- [ ] Conduct a post-season review and decide whether the model is ready to repeat.

## Later — make the sport repeatable

After the first campus pair completes the model:

- Produce an organizer kit, rulebook, safety guide, field guide, event format, and launch calendar.
- Reduce the founder time and cost required to activate another campus cluster.
- Validate sponsorship, registration, merchandise, event, partnership, and organizer-tool revenue hypotheses.
- Add spectator and media systems in response to observed demand.
- Expand through geographic clusters where player density and rivalry can form.
- Build and field-validate iOS before requiring mixed-platform participation.

## Deliberately deferred

Until the earlier gates justify them, do not prioritize:

- A large catalog of new powers or game modes.
- National rankings or national league infrastructure.
- Complex spectator broadcasting.
- Broad paid acquisition before local repeat-play density exists.
- Monetization that limits early participation or affects competitive outcomes.
- Features whose primary purpose is maximizing time spent looking at the phone.

## Maintenance

After each test session, update the detailed checklist and evidence first. Change this document only when the active priority, milestone status, or ordering changes. Strategic changes should also be reflected in [PRODUCT_VISION.md](./docs/PRODUCT_VISION.md), while durable technical and product choices belong in [IMPLEMENTATION_DECISIONS.md](./docs/IMPLEMENTATION_DECISIONS.md).

## Completed milestones

- **2026-10-13:** Implemented Android prerelease `v0.1.4` with automatic moving-player tags, private four-second Hidden Mode, conservative movement detection, and diagnostics that distinguish automatic from manual tags. Physical gameplay validation remains open.
- **2026-10-12:** Built and verified Android prerelease `v0.1.3` with reconnect recovery, radar/trap rendering corrections, a 10-second hiding countdown, and durable diagnostic file saving. Exact-scenario physical retesting remains open.
- **2026-10-11:** Published Android prerelease `v0.1.2` with production Worker and Maps configuration, diagnostics export, and authoritative spoken tag/trap cues. Automated tests and APK integrity checks passed; physical gameplay validation remains open.
