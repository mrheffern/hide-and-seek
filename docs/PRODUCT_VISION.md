# Product and sport vision

This document is the durable product context for Out of Sight. Use it when choosing features, rules, priorities, partnerships, and technical tradeoffs. The implementation and test documents explain how the current beta works; this document explains what the project is trying to become.

Update it when the founder's direction changes or real-world evidence invalidates an assumption. Keep established direction separate from hypotheses that still need testing.

## North star

Out of Sight is intended to become a real-world sport and, ultimately, a cultural phenomenon. It is not primarily a phone game. The phones make a physical game possible by acting as its referee, field system, safety and readiness monitor, scorekeeper, evidence recorder, and league infrastructure.

The desired experience happens between people moving through a real place. The best version of the app supports that experience without pulling players' attention back to their screens unnecessarily.

The long-term ambition includes:

- Casual play that is easy to organize and enjoyable without joining a league.
- Organized teams, campus leagues, standings, seasons, and championships.
- Rivalries and traditions that give players and spectators an identity larger than one match.
- A repeatable model that can grow from a pair of campuses into a broader intercollegiate sport.
- A sustainable business built around the sport and its community.

## Initial launch thesis

Begin with two colleges that are geographically close and already have a recognizable rivalry. Seed enough activity at each school to support both casual games and an organized campus league. Let casual play introduce the sport and recruit future competitive players.

Each campus league should culminate in a champion or representative team. The first major tent-pole event is an inter-school championship between the two rivals. That event should create a reason to watch, represent a school, make content, recruit new players, and begin a history people want to join.

If this works, expansion should follow a repeatable cluster model: establish local density at two or more nearby schools, build campus competition, and end with a rivalry event. The first pilot is therefore not only a product test. It is also a test of the launch and community-building playbook.

## The app's role

The app is infrastructure for the sport. It should:

- Define a shared field and enforce a common ruleset.
- Determine GPS-based outcomes consistently and conservatively.
- Preserve role privacy and prevent the app from revealing hidden information.
- Keep play moving while phones are locked and carried naturally.
- Give players unmistakable feedback for important outcomes.
- Help organizers create matches, manage competition, and resolve disputes.
- Produce trustworthy records for standings, highlights, analysis, and officiating.
- Reduce organizational labor as participation grows.

The app should not become the center of attention during play, reward staring at a screen, or replace the physical and social skills that make the sport compelling.

## Core participants

### Casual player

Wants to join friends quickly, understand the game without studying a rulebook, feel safe, and finish a satisfying match. Casual play is both valuable on its own and the widest entry point into organized competition.

### Competitive player

Wants meaningful skill expression, dependable rules, fair outcomes, useful feedback, and recognition that persists across matches. Competitive players need confidence that GPS uncertainty, cheating, or device differences will not arbitrarily decide important games.

### Team captain

Recruits players, schedules games, communicates strategy, and represents a team. Captains need clear rosters, availability, results, and low-friction coordination.

### Campus organizer or commissioner

Creates the local community, establishes safe fields, runs seasons and events, handles exceptions, and settles disputes. Organizers need leverage: one capable person should be able to operate many matches without manually supervising every action.

### Spectator and content follower

May not be playing in the current match but follows teams, rivalries, personalities, results, and highlights. Spectators need a story they can understand without seeing private live information that would compromise competition.

### League operator

Maintains the sport's standards, championship structure, integrity, safety expectations, brand, and expansion playbook across campuses.

### Campus or commercial partner

May provide fields, promotion, funding, sponsorship, event support, or institutional legitimacy. Partners need clear safety practices, dependable operations, and evidence that participation creates value.

## Participation ladder

The product and community should help people move through this ladder without requiring every player to become competitive:

1. Hear about or watch an interesting match.
2. Join a low-friction casual game.
3. Play again and invite friends.
4. Identify with a group or team.
5. Enter organized campus competition.
6. Follow standings and rival teams.
7. Compete in or watch a championship.
8. Become a captain, organizer, creator, official, or ambassador.

Healthy casual play supplies the league with participants. The league gives casual play aspiration, stories, identity, and visibility. Neither side should be designed in isolation.

## The moat

The game mechanics and GPS software alone are copyable. The intended moat is the living sport around them:

- Dense local communities with enough players for reliable matches.
- Trusted campus organizers and a repeatable launch playbook.
- Standardized rules, safety practices, field criteria, and competition formats.
- Competitive integrity backed by authoritative results and diagnostic evidence.
- Teams, rivalries, traditions, records, and championship history.
- A recognizable brand and shared culture.
- Relationships with schools, sponsors, venues, creators, and participants.
- Operational knowledge gained from running real seasons and events.

League software supports this moat, but software is not the moat by itself. The defensible asset is the network, history, trust, and identity accumulated through repeated real-world competition.

## Product principles

### Build the sport, not a feature collection

Prioritize work that makes matches more fun, fair, understandable, safe, repeatable, organizable, or watchable. A novel app feature is not automatically valuable to the sport.

### Protect competitive integrity

The server remains authoritative. Uncertain location evidence should produce a safe refusal or pause instead of a confident false outcome. Important rules must be observable, testable, and consistent across devices.

### Keep heads up

Prefer audio, vibration, simple glanceable states, and automatic enforcement over interactions that make moving players stare at a phone. Do not create incentives for unsafe movement or concealed screen use.

### Make the first game easy

Installation, permissions, party creation, field setup, and rule explanation should not require a developer or experienced official. A new group should be able to complete a match and choose to play again on its own.

### Create skill and strategic depth

Powers, maps, boundaries, timing, and team formats should create meaningful decisions and counterplay. Avoid pay-to-win mechanics and random outcomes that undermine athletic legitimacy.

Raw sprint speed must not decide the sport. Hiders may relocate at a controlled jog, but sustained sprinting is not a valid escape strategy; seekers remain free to run. If both roles commit to an open-field chase, the seeker should eventually win. A hider escapes strategically by using an existing lead to break sight around cover, then stopping and hiding again. This preserves movement and athletic expression while allowing anticipation, route choice, concealment, and timing to outweigh track speed.

### Design for organizers early

A sport does not scale if every match depends on the founder. Product and operating procedures should progressively transfer setup, education, safety, scheduling, and dispute handling to trained local organizers.

### Make competition legible

Players and spectators should understand what happened, why it mattered, who is ahead, and what comes next. Preserve hidden information during play, then turn completed competition into results, stories, and shareable moments.

### Standardize the core; allow local culture

Core competitive rules, integrity requirements, and safety expectations should be portable across campuses. Team identity, traditions, events, and presentation should leave room for local ownership.

### Learn from real play

Field evidence outranks assumptions. Instrument matches, collect consented feedback, compare diagnostics with physical observations, and change rules deliberately rather than masking failures in the interface.

## Roadmap implied by the vision

### 1. Prove the physical core loop

- Complete the multi-phone gameplay and locked-screen field gate.
- Establish acceptable real-world behavior for tags, traps, boundaries, reconnects, and audio.
- Implement and field-tune the hider jogging limit with conservative GPS evidence, heads-up warnings, and an escalating consequence for sustained sprinting.
- Tune distances, timing, and powers based on evidence and enjoyment.
- Confirm groups can install, learn, finish, and replay without developer help.

### 2. Prove repeat casual play

- Run repeated games with different group sizes, devices, fields, and weather conditions.
- Improve onboarding, readiness checks, rule teaching, and match recovery.
- Learn which moments create excitement, confusion, downtime, or unsafe behavior.
- Measure whether players voluntarily organize another game and invite others.

### 3. Build the minimum campus-league system

- Persistent accounts and trustworthy player identity.
- Teams, captains, rosters, schedules, results, standings, and season formats.
- Approved fields, configurable official rules, and organizer controls.
- Match evidence, dispute review, sanctions, and anti-cheat foundations.
- Safety policies, incident procedures, privacy controls, and data retention.

### 4. Run the two-college pilot

- Recruit and train an organizer at each school.
- Seed casual games before demanding league commitment.
- Form teams and complete a short, tightly supported campus season.
- Document participation, retention, operational effort, disputes, and player stories.
- Produce an inter-school championship that feels consequential and understandable.

### 5. Make the model repeatable

- Turn pilot lessons into an organizer kit, rulebook, safety guide, field guide, event format, and launch calendar.
- Reduce the founder time and cost required to activate another campus pair.
- Develop spectator, media, sponsorship, and championship systems only as real demand justifies them.
- Expand by geographic clusters where local density and rivalry can form.

## Business-model hypotheses

The project is intended to make money, but the revenue model is not yet decided. Candidate models to test include:

- Team or league registration fees.
- Ticketed or sponsored championship events.
- Brand sponsorships and campus partnerships.
- Team, school, and championship merchandise.
- Premium tools or services for organizers and leagues.
- Licensing or institutional programs where they strengthen distribution.

Early monetization must not choke the player density required to create the sport. Revenue should reinforce participation, identity, competition, or organizer leverage. Competitive outcomes must never depend on purchasing power.

## Measures of progress

Downloads alone do not prove that a sport exists. Track behavior at several levels.

### Match health

- Groups that successfully complete their first match.
- Time from install to playable lobby and match start.
- Match completion, crash, reconnect, and disputed-outcome rates.
- Players who choose an immediate rematch.

### Player pull

- Players who return for another session without direct prompting.
- Matches organized without the founder present.
- Invitations and new players generated by existing participants.
- Casual players who choose to join or form a team.

### Community health

- Active teams and reliable captains or organizers per campus.
- Repeat matches per campus and weeks with sustained activity.
- Season completion, forfeits, safety incidents, and unresolved disputes.
- Spectator interest, content creation, and identification with teams or schools.

### Replication

- Time, cost, and founder effort required to launch the second campus cluster.
- Organizer retention and the number of matches supported per organizer.
- Whether the championship format consistently creates recruitment and renewed play.

### Business viability

- Willingness to pay among players, organizers, partners, and sponsors.
- Revenue and contribution margin per campus, season, and event.
- Whether monetization improves or harms participation and retention.

Exact targets should be set before each pilot rather than invented after seeing the results.

## Decision filter

For a meaningful product proposal, answer:

1. Which participant does this serve?
2. Does it improve fun, fairness, safety, repeat play, organization, or spectatorship?
3. Does it keep attention in the physical world?
4. Does it strengthen or weaken competitive legitimacy?
5. Can a campus organizer operate it without the founder?
6. Does it help the two-college pilot or merely anticipate distant scale?
7. What evidence would tell us it worked?
8. What complexity, cost, privacy exposure, or failure mode does it introduce?

If a proposal does not advance the sport or a current learning objective, defer it even if it would make the app look more complete.

## Current non-goals

- Maximizing raw downloads before local communities can support repeat play.
- Adding a large catalog of powers before the basic rules are reliable and fun.
- Building national league infrastructure before one campus pair completes the model.
- Selling competitive advantages.
- Treating engagement time on the phone as the primary success measure.
- Hiding GPS or operational limitations instead of resolving or designing around them.

## Open questions

- What team size and match format produce the best combination of strategy, accessibility, and watchability?
- How long should a season be, and how should campus champions qualify for inter-school play?
- Which fields are safe, fair, accessible, and practical to approve?
- What level of officiating and diagnostic review is required for ordinary games versus championships?
- How should rankings, substitutions, forfeits, disputes, and discipline work?
- What anti-cheat protections are necessary before competition carries status or prizes?
- Which safety, insurance, campus-policy, accessibility, and liability requirements apply?
- What privacy and location-retention promises will players and institutions require?
- Which moments are compelling to spectators without compromising hidden information?
- Which organizer incentives and recognition produce durable local leadership?
- Which revenue model strengthens the community rather than extracting from it prematurely?
- What should the sport and league ultimately be called, and how should the Out of Sight app brand relate to them?

## Source of truth and revision practice

This document records strategic intent, not immutable answers. Test plans and diagnostics should challenge its hypotheses. Accepted product or technical behavior belongs in [IMPLEMENTATION_DECISIONS.md](./IMPLEMENTATION_DECISIONS.md); current runtime behavior belongs in code and tests; field readiness belongs in [GAMEPLAY_TEST_CHECKLIST.md](./GAMEPLAY_TEST_CHECKLIST.md).

When revising this document, preserve the founder's north star while labeling unproven tactics and business models honestly. Record major strategic changes in version control so future decisions retain their context.
