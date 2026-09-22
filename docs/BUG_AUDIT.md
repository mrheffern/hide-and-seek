# Bug audit — 2026-09-19

The audit covered the mobile client, background location task, shared protocol, authoritative game rules, HTTP routes, WebSocket snapshots, and Durable Object persistence.

## Fixed

- Eliminated hiders could continue receiving active hider locations through role-filtered snapshots.
- Radar activation and cooldown timestamps were exposed to hider clients.
- An explicitly departing seeker left the match permanently paused with no way to recover.
- A final hider departing while the match was paused left the room stuck.
- Reusing an emptied lobby could create a room with no host and could expose the old room's events or boundary.
- Precise positions remained stored after elimination, departure, or match completion; late native callbacks could write them back.
- Trap dwell time survived an inaccurate GPS observation even though dwell is required to be continuously observed.
- Trap-trigger events identified the trap owner as the target instead of the seeker.
- Time transitions and GPS-triggered eliminations, trap transitions, and pauses were not always forced to Durable Object storage.
- Restoring a finished or eliminated session could race with background tracking startup and leave tracking active.
- A map mounted before its first GPS fix could remain centered on the default Los Angeles coordinates.
- Countdown and radar displays used the phone clock directly instead of the server clock.
- Malformed JSON could produce an internal error, and invalid characters in room-code paths were silently removed.
- Non-JSON server responses produced an unhelpful client parsing error.
- Degenerate boundaries with duplicate or collinear points could be saved.
- A successful one-shot lobby GPS fix could be lost if the room hibernated before the five-second checkpoint, making a player fall from Weak or Live back to GPS unavailable.
- Lobby readiness relied on one immediate GPS fix, so indoor-quality fixes could become stale without giving the receiver enough outdoor time to stabilize. The lobby now watches until the server observes five continuous seconds at competitive accuracy, then latches readiness and turns the foreground watch off.

## Verification

- 13 game-rule regression tests pass.
- All four TypeScript workspaces pass type checking.
- The local Worker create/join/location/command/WebSocket smoke test passes.
- Malformed JSON and invalid room codes return HTTP 400 responses.
- The Cloudflare Worker dry-run bundle succeeds.
- The Expo Android production bundle succeeds.

## Remaining field risks

- The 20-foot tag and 10-foot trap radii still need physical accuracy testing around buildings and trees.
- Android manufacturer battery restrictions and iOS locked-screen behavior need the documented multi-device field test.
- Public beta operation still needs room expiration and request rate limiting before sharing the service broadly.
