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
};

const CFB_PARAMS: RatingParams = {
  ...NFL_PARAMS,
  homeFieldAdvantage: 2.5,
  sosWeight: 0.4, // stronger SOS adjustment for CFB than NFL, per spec
  marketShrinkageK: 6, // shallower CFB schedules (12 games) mean less time to prove the model out
  spPriorWeight: 0.5, // uncalibrated default — equal blend of our own carryover and prior-season SP+
  eloSignalPoints: 1.5, // uncalibrated default — points per unit z-score gap in CFBD's weekly Elo
};

export function getRatingParams(sport: Sport): RatingParams {
  return sport === "cfb" ? CFB_PARAMS : NFL_PARAMS;
}
