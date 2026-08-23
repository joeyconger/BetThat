# Returning Production Seed Adjustment — saved prompt

Saved 2026-08-23, not yet started. Paste into a fresh Claude Code session
opened in this repo when ready to pick this up. Context for why this is
scoped the way it is: see README's "Market anchor removed, preseason prior
tested and dropped" section — `seasonCarryover` (the one-time week-0 seed)
was swept and locked in at 0.6; this is the first of the Part-2 signals
(returning production, transfer portal, recruiting talent, preseason polls)
being tested individually, narrowest first, rather than building the full
Part 2 ingestion at once.

---

## Claude Code Prompt — Returning Production Seed Adjustment

Scope: add returning production as an adjustment to the week-0 seed. This
is a deliberately narrow build. Do NOT ingest portal, recruiting, or polls
in this task — that decision comes after we look at what this alone
produces.

### Context on what already exists

Week-0 seeding is already correct and verified: `computeInitialRating`
(elo.ts:524-539) is called exactly once per team in
`computeAndStoreRatings` (service.ts:40-64), producing an `initialRatings`
map that `computeSeasonRatings` reads once at the top and never again.
`seasonCarryover` (0.6 for CFB) regresses prior-season Elo toward league
average. `spPriorWeight` is 0 for CFB and inert.

Returning production plugs into that same one-time seed. There must be no
blending of returning-production info into the rating at any point after
week-0 initialization. A previous attempt implemented a prior as a
recurring per-week re-blend, which is a permanent stale-data drag rather
than a prior, and produced a misleading monotonic decline. Do not repeat
that structure.

### Step 1 — Ingest and verify

Pull returning production from CFBD (`/player/returning` or current
equivalent — confirm the actual endpoint rather than assuming).

Verification pass before anything is built on it. Same standard as the
`/plays` work, which caught three real data-contract bugs:

- Pull real rows for several known teams and hand-check the values against
  what you'd expect from public reporting on those teams' returning
  starters
- Confirm what the metric actually measures — total production, or
  offense/defense splits, and on what scale (percentage? usage-weighted?
  snaps or yards?)
- Check team-name resolution against our `teams` table, and report the
  match rate
- Confirm coverage per season: how many of the ~135 FBS teams have a value
  for 2024 and 2025? Report live numbers, not assumptions
- Check for the same class of gotchas already found in this repo:
  server-side filters that don't filter, fields declared non-null that
  come back JS-undefined, join keys with identical names on different
  endpoints that mean different things

Report what you find before proceeding.

### Step 2 — Wire into the seed

Extend `computeInitialRating` so returning production adjusts the
carryover value:

```
seed = carryover(priorSeasonRating) adjusted by returningProduction
```

Design notes:

- Returning production should move the seed relative to league-average
  returning production, not relative to zero. A team returning 60% when
  the FBS average is 60% should get no adjustment. Center it.
- Add a new weight param defaulting to 0, following the established
  pattern, so the adjustment is inert until calibrated.
- Guard on missing data — a team with no returning-production value seeds
  exactly as it does today, not with a substituted value.
- If offense/defense splits are available, expose both but start with the
  combined number; splits can be a follow-up.

### Step 3 — Calibrate

Sweep the new weight the same way `seasonCarryover` was swept, with:

- Paired significance tests against the current default on identical game
  sets
- Results restricted to 2024-2025, reported alongside the pooled numbers.
  2023 has zero prior-season ratings available (confirmed: 0/136 teams),
  so those ~750 games are seed-invariant across every row and can only
  dilute. Report per-bucket n alongside every result.
- Bucketed by combined games played, using the finer near-zero cuts from
  the `seasonCarryover` sweep. Fold the 22+ bucket into 18-21 — n=33 can't
  support interpretation.

Expect the effect to be small and confined to early buckets, since the
seed's influence washes out entirely by late season (demonstrated: the
22+ bucket was bit-identical across all six carryover runs). Do not chase
non-significant deltas — this project's convention throughout has been to
leave defaults alone absent significance.

Before reporting any conclusion, state what would make the result an
implementation artifact and what you checked to rule it out.

### Step 4 — The actual deliverable

Regardless of whether the weight calibrates to something significant,
produce a week-1 ratings table for 2025 with the returning-production
adjustment applied, showing for each team: prior-season final rating,
returning production value, adjusted seed, and the delta.

This is the point of the task. I want to eyeball whether the week-1
ratings look sensible, and specifically whether the teams that look wrong
are known portal-reload programs — returning production captures
transfers out but is structurally blind to transfers in. That eyeball
test decides whether portal ingestion is worth building next, and it's a
concrete diagnosis rather than an a priori argument.

Sort the table by delta so the biggest movers in both directions are easy
to scan.

### Separately — week-1 CLV anomaly

Still open from earlier and worth closing while you're in this data: the
0-1 games-played bucket runs avgClv ~0.10 while every other bucket sits
between 0.45 and 0.94, and this held across all six carryover runs. Check
whether week-1 opening lines are stale or mis-timestamped in ingestion —
those lines are posted months ahead, and if their timestamps are wrong,
CLV for that bucket is contaminated. Several conclusions in this project
lean on the earliest bucket.
