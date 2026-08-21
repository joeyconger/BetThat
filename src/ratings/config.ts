import type { Sport } from "../db/repo.js";

/**
 * Every constant here is a reasonable starting default, not a validated
 * value — there's no real historical CLV result yet to fit them against.
 * Phase 3's backtest harness is exactly where these get tuned: run the
 * backtest across a range of values for each and keep whatever actually
 * beats the closing line. Treat this file as "config to sweep," not
 * "settled physics."
 */
export interface RatingParams {
  /** Home-field advantage, in points added to the home side's expected margin. */
  homeFieldAdvantage: number;
  /** Converts a net-EPA/play differential into a point-margin equivalent. */
  pointsPerEpa: number;
  /** Elo-style learning rate: fraction of the prediction error absorbed into the rating each game. */
  baseK: number;
  /** How much a team's rating swings based on opponent strength — this is the SOS knob, stronger for CFB. */
  sosWeight: number;
  /** Rating-scale reference point the SOS multiplier is expressed against. */
  ratingScaleRef: number;
  /** Floor on the SOS multiplier so a blowout over a very weak opponent can't flip the sign of a rating update. */
  minSosMultiplier: number;
  /**
   * Ceiling on the SOS multiplier. Without this, a team's rating update is
   * amplified without bound by however strong its opponent's rating already
   * is — and that amplified rating then amplifies the next team's update
   * when they play it, chaining across the schedule graph as the season
   * progresses. Observed in practice: uncapped, this produced team ratings
   * in the millions (and eventually 1e26) by CFB week 9 of the 2024
   * backtest. Symmetric with minSosMultiplier's distance from 1.
   */
  maxSosMultiplier: number;
  /** How much of a team's final rating carries into next season (the rest regresses to league-average 0). */
  seasonCarryover: number;
  /** Points of predicted-margin uncertainty at zero games played; shrinks as sqrt(games played) grows. */
  baseErrorPoints: number;
  /** "Games worth of trust" the market line gets before the model's own signal outweighs it (see predict.ts). */
  marketShrinkageK: number;
  /** Weight (0-1) given to the prior season's CFBD SP+ rating vs. this model's own carryover, when seeding a new season's initial rating. CFB-only — SP+ doesn't exist for NFL. */
  spPriorWeight: number;
  /** Points of predicted-margin adjustment per unit z-score gap in CFBD's weekly Elo (see ratings/elo.ts's predictSpread). CFB-only — 0 for NFL, which CFBD doesn't cover. */
  eloSignalPoints: number;
  /**
   * Points of predicted-margin adjustment per unit z-score gap in the prior
   * season's CFBD SP+ (see ratings/elo.ts's predictSpread) — same mechanism
   * as eloSignalPoints, deliberately NOT the same mechanism as
   * spPriorWeight above. spPriorWeight blends SP+ into the one-time initial
   * carryover rating, where a real sweep found it consistently HURT cover
   * rate once weighted above ~0.3 (see spPriorWeight's history in
   * CFB_PARAMS below); eloSignalPoints' additive-every-week treatment of a
   * *different* external rating had "a genuine, fairly clean positive
   * effect" in the same sweep. This applies that same additive treatment
   * to SP+ instead, as a distinct hypothesis to test — not a replacement
   * for spPriorWeight, a second lever alongside it. CFB-only. Defaults to
   * 0 (no-op) — untested, needs a real sweep against production data
   * before trusting any nonzero value.
   */
  spSignalPoints: number;
  /**
   * Points added to the predicted margin per day of rest-advantage
   * differential (home team's days since their prior game minus away
   * team's) — same additive-signal shape as eloSignalPoints/spSignalPoints,
   * applied in ratings/elo.ts's predictSpread, not the rating update
   * itself (this is situational to a specific matchup, not a change in
   * either team's underlying strength). A real, well-documented effect in
   * both NFL and CFB (extra rest, especially a bye week, is a genuine
   * predictive edge) that nothing in this model used before. Both sports —
   * unlike eloSignalPoints/spSignalPoints, this doesn't depend on CFBD-only
   * data (game_date already exists for every game). Defaults to 0 (no-op)
   * — untested, needs a real sweep.
   */
  pointsPerRestDay: number;
  /**
   * Weight (0-1) given to success-rate differential vs. EPA differential
   * when computing a game's "how it went" performance signal in
   * computeSeasonRatings — 0 uses pure EPA (today's behavior), 1 uses pure
   * success rate. EPA/points-per-play is itself already closer to "the
   * result" than a box score (see computeSeasonRatings' doc), but it's
   * still dominated by a handful of explosive or garbage-time plays the
   * same way raw scoring margin is. Success rate (did this play move the
   * chains, regardless of how many yards it was worth) is the more
   * execution-focused, lower-variance signal — this is the same reasoning
   * SP+ itself uses to weight "efficiency" (success rate) and
   * "explosiveness" (a PPP/EPA-like measure) as separate components rather
   * than collapsing them into one number. Defaults to 0 (no-op, identical
   * to today's EPA-only behavior) — untested, needs a real sweep.
   */
  successRateWeight: number;
  /**
   * Scales a success-rate differential (typically -0.2 to 0.2 in practice)
   * into a point-margin equivalent, the same role pointsPerEpa plays for
   * EPA. Unlike pointsPerEpa (calibrated via a real sweep), this is a
   * first-guess placeholder — success rate differentials run roughly 3-5x
   * smaller in magnitude than the EPA differentials pointsPerEpa was tuned
   * against, so this starts at a proportionally larger multiplier, but it
   * has not itself been swept. Only takes effect when successRateWeight > 0.
   */
  pointsPerSuccessRate: number;
  /** Widens `confidence` as |marketSpreadHome| grows — a big market spread is a signal the prediction is less trustworthy (see ratings/elo.ts's predictSpread), for a confidence-based filter to screen out, NOT a lever on modelWeight (a modelWeight-only version was tried and proven to be a no-op, see predictSpread's doc). Smaller = widens confidence faster at a given spread size. */
  bigSpreadShrinkRef: number;
  /**
   * When true, computeSeasonRatings prefers each game's garbage-time-
   * excluded EPA/success rate (a second CFBD ingestion pass with
   * excludeGarbageTime=true — see ingest/cfbd/syncStats.ts) over the
   * regular all-plays value, per-field, falling back to the all-plays
   * value for any game that doesn't have the no-garbage columns ingested
   * yet. Distinct from successRateWeight: that's a SIGNAL blend (how much
   * to trust success rate vs. EPA), this is a DATA CLEANING toggle (which
   * plays count at all) — a backup mopping up 45-0 in the 4th quarter
   * inflates or deflates both EPA and success rate the same way, so this
   * is a binary switch, not something to partially blend. Defaults to
   * false (today's behavior, includes all plays) — untested, needs a
   * sweep once the no-garbage columns are actually ingested for a season.
   */
  excludeGarbageTime: boolean;
  /**
   * Opponent-adjusts each side's success rate against the opponent's
   * season-to-date tendency on the other side of the ball, before it feeds
   * the successRateWeight blend — succeeding against a defense that
   * normally suppresses success rate should count for more than the same
   * raw number against a defense that allows it to everyone (and
   * symmetrically for what a defense allows, against how good the
   * opponent's offense generally is). 0 = today's behavior (raw success
   * rate, no opponent adjustment) — a team's own rating already gets an
   * analogous adjustment via sosWeight, but that only scales the UPDATE
   * size, not the raw input number itself; this is the input-level
   * counterpart, for success rate specifically (not EPA — see
   * ratings/elo.ts's computeSeasonRatings doc). Only takes effect once a
   * team has at least MIN_SUCCESS_CONTEXT_GAMES of its own season-to-date
   * sample; before that, falls back to unadjusted raw success rate for
   * games against that team. Untested — needs a real sweep.
   */
  opponentAdjustWeight: number;
  /**
   * Weight (0-1) given to a "turnover-luck-stripped" EPA vs. raw EPA when
   * computing a game's performance signal in computeSeasonRatings — 0 uses
   * raw EPA (today's behavior, includes turnover plays' PPA), 1 uses EPA
   * with all turnover plays (interceptions, forced/lost fumbles — see
   * ingest/cfbd/syncTurnoverStats.ts for the exact CFBD play_type set)
   * removed from the average entirely. Turnovers are the most
   * variance-heavy, least repeatable events in football — a tipped pass
   * that happens to land in a defender's hands isn't a real skill signal
   * the way a sustained third-down conversion is — so this is an attempt
   * at the same "care about how the game went, not the result" goal as
   * successRateWeight, applied to a different source of noise. The
   * stripped value is NOT a flat subtraction of turnover PPA from the raw
   * average (that would ignore the play-count reweighting a true trimmed
   * average requires and over-correct) — see computeSeasonRatings for the
   * actual reweighted-average formula. Only takes effect for games with
   * turnover-stats ingested (falls back to raw EPA otherwise, same
   * degrade-don't-guess pattern as excludeGarbageTime). Defaults to 0
   * (no-op) — untested, needs ingestion + a real sweep.
   */
  turnoverLuckWeight: number;
  /**
   * Points of predicted-margin adjustment per unit z-score gap in REAL
   * week-by-week SP+ (see ratings/elo.ts's predictSpread) — same additive-
   * signal mechanism as eloSignalPoints/spSignalPoints, but sourced from
   * ingest/manual/syncManualSpWeekly.ts's manually-provided archive
   * instead of a live CFBD pull. Distinct from spSignalPoints (which
   * uses CFBD's own /ratings/sp — confirmed via their real API docs to
   * have NO week parameter at all, one frozen value per team per season)
   * — spSignalPoints tested that frozen value and it came back flat/
   * negative, plausibly because it's stale by the time it's applied
   * in-season. This is the same idea retried with genuinely fresh,
   * real in-season data, to see whether staleness (not SP+ itself) was
   * the actual problem. CFB-only, and currently only meaningful for
   * 2025 — the one season a real weekly archive exists for; any other
   * season/week has no manual_sp_weekly data, so this signal is a
   * silent no-op there regardless of the weight. Defaults to 0 (no-op)
   * — untested pending ingestion, and only single-season (2025-only)
   * validation is possible until archives for other seasons exist, so
   * even a positive in-sample 2025 result can't get the normal walk-
   * forward treatment — see README/adminJobs.ts for how that's handled.
   */
  weeklySpSignalPoints: number;
}

const NFL_PARAMS: RatingParams = {
  homeFieldAdvantage: 1.5,
  pointsPerEpa: 35,
  baseK: 0.25,
  sosWeight: 0.15,
  ratingScaleRef: 10,
  minSosMultiplier: 0.2,
  maxSosMultiplier: 1.8,
  seasonCarryover: 0.6,
  baseErrorPoints: 8,
  marketShrinkageK: 8,
  spPriorWeight: 0, // no SP+ for NFL
  eloSignalPoints: 0, // no CFBD Elo for NFL
  spSignalPoints: 0, // no CFBD SP+ for NFL
  pointsPerRestDay: 0, // untested — needs a real sweep. Applies to both sports (game_date is universal), unlike the CFBD-only signals above.
  successRateWeight: 0, // untested — see RatingParams doc; 0 = today's pure-EPA behavior
  pointsPerSuccessRate: 90, // untested placeholder — see RatingParams doc
  bigSpreadShrinkRef: 40, // widens confidence at NFL's typical spread range (rarely exceeds ~20) — untested for NFL, conservative default until swept
  excludeGarbageTime: false, // untested — no-garbage columns not ingested for NFL yet (nflverse-based, not CFBD)
  opponentAdjustWeight: 0, // untested — no-op until swept
  turnoverLuckWeight: 0, // untested — turnover stats not ingested for NFL yet (would need an nflverse play-by-play source, not CFBD)
  weeklySpSignalPoints: 0, // no SP+ (weekly or otherwise) for NFL
};

const CFB_PARAMS: RatingParams = {
  ...NFL_PARAMS,
  homeFieldAdvantage: 2.5,
  sosWeight: 0.4, // stronger SOS adjustment for CFB than NFL, per spec
  marketShrinkageK: 6, // shallower CFB schedules (12 games) mean less time to prove the model out
  // pointsPerEpa/spPriorWeight/eloSignalPoints below: calibrated from the
  // cfb-external-sweep run (see README "External ratings" / backtest run
  // 101-125) — spPriorWeight and eloSignalPoints were NOT independent
  // guesses like the rest of this file, they're the actual best-cover-rate
  // combo found (49.9%, still below the 52.4% breakeven line, but the
  // highest of every combo tested). Re-sweep if pointsPerEpa/baseK change,
  // since this pair was only tested holding those two fixed.
  pointsPerEpa: 20,
  spPriorWeight: 0, // swept 0-1: consistently HURT cover rate once weighted above ~0.3 — SP+'s uncertain preseason-vs-final timing (see README) looks like it's actively wrong, not just unhelpful
  eloSignalPoints: 1.5, // swept 0-3: genuine, fairly clean positive effect on cover rate, peaking around 1.5-2
  // spSignalPoints: swept 0-3 (cfb-spsignal-sweep, run 210-215) — unlike
  // eloSignalPoints, this one did NOT replicate the "additive treatment of
  // an external rating helps" pattern: 0 was the best value on both cover
  // rate (49.9%) and avgClv (0.62), and both metrics degraded monotonically
  // as the signal got stronger (48.9%/0.55 at spSignalPoints=3). Left at 0.
  // Best guess why eloSignalPoints helped and this doesn't: CFBD's weekly
  // Elo updates within-season (fresh info every week); SP+ here is frozen
  // at last year's final value for the whole season, so it's likely just
  // adding stale noise on top of what the model's own rating + market
  // blend already has, not new information.
  spSignalPoints: 0,
  // successRateWeight/pointsPerSuccessRate: swept 0-1 x 60-120
  // (cfb-successrate-sweep, run 216-228), then walk-forward validated
  // (cfb-successrate-walkforward, run 229-242: train on 2023-2024 only,
  // score the winning combo on the untouched 2025 season). In-sample sweep
  // found successRateWeight=0.75-1.0 with pointsPerSuccessRate=90-120
  // beating the EPA-only baseline (49.9% -> 50.5% cover), and the walk-
  // forward holdout, while showing the usual in-sample-to-holdout
  // shrinkage (train cover 51.5% -> holdout cover-vs-close 48.7%), still
  // beat the existing baseline's OWN 2025 holdout on the two metrics that
  // matter most: avg CLV (0.87 vs. 0.76) and cover-vs-opening-line (50.7%
  // vs. 50.0%, still short of the ~52.4% breakeven line). A real, modest
  // improvement, not a validated edge — n=762 on the holdout, SE~1.8pp, so
  // none of these shifts are individually conclusive on their own, but the
  // direction held across both the full sweep and an independent holdout.
  successRateWeight: 0.75,
  pointsPerSuccessRate: 120,
  // Uncalibrated starting point — widens confidence for predictions
  // fighting an extreme market spread, since backtest data showed those
  // losing more often than not (real CFB mismatches routinely hit 30-50+
  // points, more extreme than this rating system's compressed scale can
  // match — see README "Big-spread deviation"). A modelWeight-based
  // version of this same idea was tried first and proven mathematically
  // incapable of changing cover rate/CLV (see predictSpread's doc) — this
  // confidence-based version needs its own real sweep against
  // getConfidenceReport before trusting this specific value.
  bigSpreadShrinkRef: 25,
  // Inherited false from NFL_PARAMS — deliberately not flipped on yet.
  // CFBD's excludeGarbageTime param is confirmed to exist on the exact
  // endpoint already in use (/stats/game/advanced), but the no-garbage
  // columns need a real ingestion pass (cfb-garbage-time-ingest) and a
  // sweep + walk-forward validation before this is worth trusting, same
  // process successRateWeight just went through.
  excludeGarbageTime: false,
  // Swept 0-2 (cfb-oppadjust-sweep): a clean, monotonic NEGATIVE trend on
  // cover rate as weight increases past ~0.25. Likely double-counting with
  // sosWeight, which already adjusts each team's RATING UPDATE by opponent
  // strength — this adjusts the raw success-rate INPUT by the same
  // opponent's tendency, and stacking both seems to over-correct. Left at 0.
  opponentAdjustWeight: 0,
  // Swept -0.2 to 0.5 (cfb-restday-sweep): genuinely flat, no signal in
  // either direction (confirmed via the negative-value sanity check too).
  // Most likely explanation: the market already prices rest/bye
  // differential in efficiently, so there's nothing incremental left to
  // extract from an additive signal on top of the closing line. Left at 0.
  pointsPerRestDay: 0,
  // Swept 0-1 (cfb-turnoverluck-sweep, run 262-268, after cfb-turnover-
  // ingest): essentially flat — cover rate wobbles 50.5%-50.7% with no
  // clean monotonic trend and avgClv is unchanged (0.69-0.70) across the
  // whole grid, nothing like successRateWeight's real 0.6pp move with a
  // clear direction. Skipped the walk-forward holdout since the in-sample
  // sweep already shows no signal worth confirming — same call made for
  // opponentAdjustWeight and pointsPerRestDay above. Best guess why:
  // turnover luck is likely already substantially captured by the
  // success-rate blend this model runs on — a defense that forces
  // turnovers usually also suppresses success rate on the same drives, so
  // stripping turnovers out separately has little independent information
  // left to add. Left at 0.
  turnoverLuckWeight: 0,
  // Swept 0-3 (cfb-weeklyspsignal-sweep, run 273-278, 2025 only — the one
  // season a real weekly archive exists for): noisy, not a clean trend —
  // cover vs open bounces 50.4%-50.8% through most of the grid, then the
  // top-of-range value (weight=3) came out best at 52.1%, still short of
  // the ~52.4% breakeven and short of "significantly higher than 52%."
  // Same "best value sits at the edge of the tested range" pattern the
  // confidence-filter idea showed right before its walk-forward holdout
  // showed it was noise (see adminJobs.ts's cfb-confidence-walkforward) —
  // except this one has no possible holdout to confirm or refute it
  // against, since 2025 is the only season with real data. Verdict:
  // staleness (the diagnosed reason spSignalPoints failed) wasn't
  // actually the problem — real, fresh week-by-week SP+ still doesn't
  // add anything this model doesn't already have. Left at 0.
  weeklySpSignalPoints: 0,
};

export function getRatingParams(sport: Sport): RatingParams {
  return sport === "cfb" ? CFB_PARAMS : NFL_PARAMS;
}
