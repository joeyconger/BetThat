# Transfer Portal Incoming-Talent Seed Adjustment — saved prompt

Saved 2026-08-23, not yet started. Paste into a fresh Claude Code session
opened in this repo when ready to pick this up. Depends on the returning-
production work already being in (see `returning-production-seed-
adjustment.md` in this same directory) — this is a parallel, INCOMING-only
third seed component, not a modification of that one.

## Why this exists

The returning-production seed adjustment's Step 4 eyeball test (2025 week-0
seed table, `cfb-returning-production-week1-table`) surfaced a real,
concrete case of the failure mode it predicted: Miami's percentPPA was one
of the lowest in FBS (0.125), which would have badly under-rated a team
that actually went 13-3 and reached the CFP National Championship game.
Miami rebuilt almost entirely through the transfer portal (Cristobal's
program is known for exactly that), and returning production is
structurally blind to who arrives, only who's leaving. Colorado, by
contrast, also had a low percentPPA (0.075) AND a real decline (3-9 in
2025) despite heavy portal activity (35-43 incoming transfers) — so
portal VOLUME alone doesn't explain the gap. The stated hypothesis: what
mattered for Miami wasn't that they brought in a lot of transfers, it's
that Carson Beck came from Georgia specifically — a proven starter at a
top program — not wherever Colorado was drawing from. The metric needs to
weight incoming transfer value by the STRENGTH OF THE ORIGIN PROGRAM, not
just count bodies or use a flat per-player talent score.

## What CFBD's /player/portal actually offers (confirmed via their
## official Python client docs — same "confirmed via their client library
## docs" standard as every other endpoint in this repo — but NOT hand-
## verified against a real response yet; do that first, same discipline
## as every prior endpoint added here)

Fields: `season`, `firstName`, `lastName`, `position`, `origin` (team
name string), `destination` (team name string), `transferDate`
(datetime), `rating` (float), `stars` (int), `eligibility`.

Important, worth stating explicitly: **there is no production/performance
stat on this endpoint at all** — no PPA, no usage, nothing measured. It's
purely a talent/pedigree signal (`rating`/`stars`), structurally different
from returning production's measured-output signal. Don't design this as
if it's a second returning-production metric; it isn't one.

## Proposed design

**Incoming-only, deliberately.** Returning production already captures
"who left" implicitly (a departed player simply doesn't appear in next
year's percentPPA). Adding portal OUTGOING on top would double-count that
signal. This is a pure incoming-talent addition, a third independent
component alongside `seasonCarryover` and `returningProductionPoints`.

Per incoming transfer: `transferRating × originTeamStrength`, where
`originTeamStrength` is the origin team's own prior-season final rating
(reuse `getPriorSeasonFinalRating` — zero new ingestion needed for this
side) or CFBD SP+ (`getPriorSeasonSpRating`) for the origin team. This is
the Carson-Beck-from-Georgia mechanism: a high-rated transfer from a
strong program contributes far more than a similarly-rated transfer from
a weak one.

Aggregate per team, center against the league average (same pattern as
`returningProductionPoints`), apply as a new `portalIncomingPoints`
RatingParams field defaulting to 0, added ONCE at week-0 seed time via
`computeInitialRating` (now four inputs: priorEloRating, priorSpRating,
returningProductionDeviation, portalIncomingDeviation) — same one-time-
seed discipline validated twice already (seasonCarryover, returning
production): NO blending after initialization, seed only, let
`computeSeasonRatings`' normal update loop take over completely.

## Three real open questions — resolve these before writing code, not by
## guessing a default

1. **Sum vs. average per team.** Sum rewards volume + quality (Colorado's
   35+ transfers vs. a team bringing in 5) — but Colorado's actual 2025
   record (3-9) despite heavy portal volume argues against rewarding
   volume alone. Average rewards quality regardless of volume, closer to
   the Carson Beck framing (one elite, well-sourced transfer matters more
   than a large quantity of mediocre ones). Leaning average, but this
   changes the metric's behavior substantially — ask before defaulting.
2. **Is `rating` recruiting-pedigree or performance-evaluated?**
   Undocumented in the field list. If it's just a carried-forward HS
   recruiting number, it under-credits a portal riser who outplayed their
   recruiting grade; if CFBD re-evaluates transfers based on college
   performance, `rating` is already a strong signal even before the
   origin-strength weighting. Verify by pulling Carson Beck's real 2025
   portal row (Georgia -> Miami) and checking whether his rating reflects
   a proven-starter evaluation or a stale HS number — same "pull a name
   you can Google" hand-verification discipline as every other endpoint
   in this repo.
3. **Transfer-date cutoff.** Portal windows span roughly Dec-Jan and
   Apr-May. Need an explicit rule for which cycle counts toward which
   season's week-0 roster — a spring transfer for the upcoming fall
   clearly counts; confirm whether a very-late spring transfer still
   reliably makes it into that fall's actual roster, or needs a cutoff
   date before "counts as this season's incoming class."

## Suggested order of work (mirrors the returning-production prompt's
## structure)

1. **Verify** the endpoint for real (client function + hand-verification
   admin job, same pattern as `cfb-verify-returning-production`) —
   resolve question 2 above as part of this pass, plus team-name
   resolution rate for both `origin` and `destination` against our own
   `teams` table (two resolution checks, not one).
2. **Wire into the seed** — extend `computeInitialRating`'s signature,
   add `portalIncomingPoints` to `RatingParams`, new external_ratings-
   style storage or a dedicated table (a raw per-transfer table is
   probably more honest here than reusing `external_ratings`'s single-
   `rating`-column shape, since this needs origin/destination/rating/
   stars per player, not one number per team — decide during
   implementation whether to store raw transfers and aggregate at read
   time, or pre-aggregate to a per-team-per-season value at ingest time
   the way `returning_production` did).
3. **Calibrate** — same sweep structure as `cfb-returning-production-
   sweep`: paired significance tests against the current default,
   pooled AND 2024-2025-only (2023 will have the same "not seed-
   invariant" property returning production did, if the same current-
   season-direct read pattern applies — confirm this explicitly rather
   than assuming either way), bucketed by combined games played with the
   same finer near-zero cuts, folding thin late buckets together.
   Standard caveat holds: don't adopt a nonzero weight absent
   significance.
4. **Eyeball test** — a week-0 2025 seed table like
   `cfb-returning-production-week1-table`, but checking the OPPOSITE
   direction from that test: does Miami's seed move up meaningfully once
   Carson Beck's Georgia-sourced transfer is weighted in, and does
   Colorado's stay comparatively flat despite its transfer volume? That
   comparison is the direct test of whether the origin-weighting design
   actually captures the distinction it's meant to.
