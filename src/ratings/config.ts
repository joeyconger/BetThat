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
  successRateWeight: 0, // untested — see RatingParams doc; 0 = today's pure-EPA behavior
  pointsPerSuccessRate: 90, // untested placeholder — see RatingParams doc
  bigSpreadShrinkRef: 40, // widens confidence at NFL's typical spread range (rarely exceeds ~20) — untested for NFL, conservative default until swept
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
};

export function getRatingParams(sport: Sport): RatingParams {
  return sport === "cfb" ? CFB_PARAMS : NFL_PARAMS;
}
