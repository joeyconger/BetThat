/**
 * Glue between the three standalone pieces built for the SP+-style
 * rebuild: playSuccess.ts's success-rate definitions, garbageTime.ts's
 * weighting, and opponentAdjust.ts's iterative solve. Turns a game's raw
 * plays into the garbage-time-weighted TeamPerformance rows
 * computeOpponentAdjustedRatings expects.
 *
 * Still pure/no DB dependency -- callers own fetching the actual play
 * rows (e.g. from the `plays` table, migration 0012) and, critically,
 * own the as-of-week filtering: only pass games completed before the
 * snapshot week being rated (see opponentAdjust.ts's header comment).
 */

import { isScrimmagePlay, isSuccessfulPlay } from "./playSuccess.js";
import { computeGarbageTimeWeight, DEFAULT_GARBAGE_TIME_CONFIG, type GarbageTimeConfig } from "./garbageTime.js";
import type { TeamPerformance } from "./opponentAdjust.js";

export interface RawPlayForPerformance {
  offenseTeamId: number | null;
  defenseTeamId: number | null;
  down: number | null;
  distance: number | null;
  yardsGained: number | null;
  playType: string;
  offenseScore: number | null;
  defenseScore: number | null;
  period: number | null;
  clockMinutes: number | null;
  clockSeconds: number | null;
  /** CFBD's own EPA-equivalent per play (plays.ppa) -- the SAME underlying metric this project has always called EPA elsewhere (team_game_stats.off_epa_play/def_epa_play, syncStats.ts maps CFBD's per-game ppa straight onto those columns). Null when CFBD didn't provide a value for that play. */
  ppa: number | null;
}

export interface WeightedSuccessRateResult {
  weightedSuccessRate: number | null;
  weightedPlayCount: number;
}

export interface WeightedEpaResult {
  weightedEpa: number | null;
  weightedPlayCount: number;
}

/**
 * Garbage-time-weighted success rate for one team's offense across a set
 * of plays (typically one game). Each successful/unsuccessful play
 * contributes its computeGarbageTimeWeight instead of a flat 1, so a
 * blowout-time snap counts for less without being binarily excluded.
 */
export function computeWeightedSuccessRate(
  plays: RawPlayForPerformance[],
  teamId: number,
  garbageTimeConfig: GarbageTimeConfig = DEFAULT_GARBAGE_TIME_CONFIG,
): WeightedSuccessRateResult {
  let successWeightSum = 0;
  let totalWeightSum = 0;

  for (const play of plays) {
    if (play.offenseTeamId !== teamId) continue;
    if (!isScrimmagePlay(play.playType)) continue;
    const success = isSuccessfulPlay(play.down, play.distance, play.yardsGained);
    if (success === null) continue;

    const weight = computeGarbageTimeWeight(
      play.offenseScore,
      play.defenseScore,
      play.period,
      play.clockMinutes,
      play.clockSeconds,
      garbageTimeConfig,
    );
    totalWeightSum += weight;
    if (success) successWeightSum += weight;
  }

  if (totalWeightSum === 0) return { weightedSuccessRate: null, weightedPlayCount: 0 };
  return { weightedSuccessRate: successWeightSum / totalWeightSum, weightedPlayCount: totalWeightSum };
}

/**
 * Garbage-time-weighted EPA (CFBD's ppa) for one team's offense across a
 * set of plays -- same shape as computeWeightedSuccessRate, a weighted
 * MEAN instead of a weighted proportion since ppa is continuous, not
 * binary. Same isScrimmagePlay filter as success rate, matching the
 * convention this project's existing (CFBD-pre-aggregated) EPA columns
 * already use, so this is directly comparable to team_game_stats.off_epa_play.
 */
export function computeWeightedEpa(
  plays: RawPlayForPerformance[],
  teamId: number,
  garbageTimeConfig: GarbageTimeConfig = DEFAULT_GARBAGE_TIME_CONFIG,
): WeightedEpaResult {
  let epaWeightSum = 0;
  let totalWeightSum = 0;

  for (const play of plays) {
    if (play.offenseTeamId !== teamId) continue;
    if (!isScrimmagePlay(play.playType)) continue;
    if (play.ppa === null) continue;

    const weight = computeGarbageTimeWeight(
      play.offenseScore,
      play.defenseScore,
      play.period,
      play.clockMinutes,
      play.clockSeconds,
      garbageTimeConfig,
    );
    totalWeightSum += weight;
    epaWeightSum += play.ppa * weight;
  }

  if (totalWeightSum === 0) return { weightedEpa: null, weightedPlayCount: 0 };
  return { weightedEpa: epaWeightSum / totalWeightSum, weightedPlayCount: totalWeightSum };
}

export interface GamePlaysGroup {
  gameId: number;
  homeTeamId: number;
  awayTeamId: number;
  plays: RawPlayForPerformance[];
}

/**
 * Builds the TeamPerformance[] input for computeOpponentAdjustedRatings
 * from a set of games' raw plays. A side with no judgeable plays (e.g. a
 * game with no ingested plays yet) is simply omitted, not zero-filled --
 * computeOpponentAdjustedRatings already handles teams with fewer games
 * than others.
 */
export function buildTeamPerformances(
  games: GamePlaysGroup[],
  garbageTimeConfig: GarbageTimeConfig = DEFAULT_GARBAGE_TIME_CONFIG,
): TeamPerformance[] {
  const performances: TeamPerformance[] = [];

  for (const game of games) {
    const home = computeWeightedSuccessRate(game.plays, game.homeTeamId, garbageTimeConfig);
    const away = computeWeightedSuccessRate(game.plays, game.awayTeamId, garbageTimeConfig);

    if (home.weightedSuccessRate !== null) {
      performances.push({
        teamId: game.homeTeamId,
        opponentId: game.awayTeamId,
        rawOffenseValue: home.weightedSuccessRate,
      });
    }
    if (away.weightedSuccessRate !== null) {
      performances.push({
        teamId: game.awayTeamId,
        opponentId: game.homeTeamId,
        rawOffenseValue: away.weightedSuccessRate,
      });
    }
  }

  return performances;
}

/**
 * Same as buildTeamPerformances, but on garbage-time-weighted EPA
 * (computeWeightedEpa) instead of success rate -- the metric
 * generalization Step 2 of the iterative-solve plan needs (see
 * cfb-solve-epa-hypothesis-test in adminJobs.ts, the diagnostic this was
 * built for).
 */
export function buildTeamPerformancesEpa(
  games: GamePlaysGroup[],
  garbageTimeConfig: GarbageTimeConfig = DEFAULT_GARBAGE_TIME_CONFIG,
): TeamPerformance[] {
  const performances: TeamPerformance[] = [];

  for (const game of games) {
    const home = computeWeightedEpa(game.plays, game.homeTeamId, garbageTimeConfig);
    const away = computeWeightedEpa(game.plays, game.awayTeamId, garbageTimeConfig);

    if (home.weightedEpa !== null) {
      performances.push({
        teamId: game.homeTeamId,
        opponentId: game.awayTeamId,
        rawOffenseValue: home.weightedEpa,
      });
    }
    if (away.weightedEpa !== null) {
      performances.push({
        teamId: game.awayTeamId,
        opponentId: game.homeTeamId,
        rawOffenseValue: away.weightedEpa,
      });
    }
  }

  return performances;
}
