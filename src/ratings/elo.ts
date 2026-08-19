import type { RatingParams } from "./config.js";

export interface GameForRating {
  gameId: number;
  week: number;
  homeTeamId: number;
  awayTeamId: number;
  homeOffEpa: number;
  homeDefEpa: number;
  awayOffEpa: number;
  awayDefEpa: number;
}

export interface TeamRatingState {
  rating: number;
  gamesPlayed: number;
}

/**
 * Incremental, EPA-driven Elo-like rating system. Unlike a classic Elo
 * (updated from win/loss or final score margin), the "ground truth" each
 * game feeds in is that game's net EPA/play differential — offense minus
 * defense for each side, converted to a point-margin equivalent — since
 * the spec calls for updating from EPA/success-rate form, not the scoreboard.
 *
 * SOS shows up here directly: each team's rating movement is scaled by how
 * strong their opponent's rating already is (sosWeight, higher for CFB),
 * so beating a good team moves the rating more than beating a bad one —
 * the standard way Elo-family systems encode strength of schedule.
 *
 * This is a single incremental pass through the season in week order, not
 * a fully converged iterative solve (early-week opponent ratings are still
 * close to their preseason prior) — a reasonable v1 scope, and one Phase 3
 * can compare against a multi-pass version if the single pass underperforms.
 */
export function computeSeasonRatings(
  games: GameForRating[],
  initialRatings: Map<number, number>,
  params: RatingParams,
): Map<number, TeamRatingState> {
  const state = new Map<number, TeamRatingState>();
  for (const [teamId, rating] of initialRatings) {
    state.set(teamId, { rating, gamesPlayed: 0 });
  }

  const sorted = [...games].sort((a, b) => a.week - b.week || a.gameId - b.gameId);

  for (const game of sorted) {
    const home = state.get(game.homeTeamId) ?? { rating: 0, gamesPlayed: 0 };
    const away = state.get(game.awayTeamId) ?? { rating: 0, gamesPlayed: 0 };

    const predictedMargin = home.rating - away.rating + params.homeFieldAdvantage;
    const homeNetEpa = game.homeOffEpa - game.homeDefEpa;
    const awayNetEpa = game.awayOffEpa - game.awayDefEpa;
    const actualMargin = params.pointsPerEpa * (homeNetEpa - awayNetEpa);
    const error = actualMargin - predictedMargin;

    const homeSosMultiplier = Math.min(
      params.maxSosMultiplier,
      Math.max(params.minSosMultiplier, 1 + params.sosWeight * (away.rating / params.ratingScaleRef)),
    );
    const awaySosMultiplier = Math.min(
      params.maxSosMultiplier,
      Math.max(params.minSosMultiplier, 1 + params.sosWeight * (home.rating / params.ratingScaleRef)),
    );

    state.set(game.homeTeamId, {
      rating: home.rating + params.baseK * error * homeSosMultiplier,
      gamesPlayed: home.gamesPlayed + 1,
    });
    state.set(game.awayTeamId, {
      rating: away.rating - params.baseK * error * awaySosMultiplier,
      gamesPlayed: away.gamesPlayed + 1,
    });
  }

  return state;
}

/** Regresses a prior season's final rating toward league-average (0) for the new season's starting point. */
export function carryoverRating(priorRating: number, params: RatingParams): number {
  return priorRating * params.seasonCarryover;
}

export interface PredictionInput {
  homeRating: number;
  awayRating: number;
  homeGamesPlayed: number;
  awayGamesPlayed: number;
  marketSpreadHome: number | null;
}

export interface Prediction {
  /** This model's own line, before any market blend — negative = home favored. */
  eloSpreadHome: number;
  /** The reported line: a confidence-weighted blend of the model's own line and the current market line. */
  modelSpreadHome: number;
  /** Points of estimated uncertainty in modelSpreadHome. */
  confidence: number;
  /** How much weight modelSpreadHome put on the model's own number vs. the market (0 = pure market, 1 = pure model). */
  modelWeight: number;
}

/**
 * Converts ratings into a market-anchored spread. This is the mechanism
 * behind "anchor to market rather than build an independent power
 * ranking": early in a season (few games played), modelWeight is small and
 * the output stays close to the market line; as more games accumulate,
 * the model's own signal gets more say. With no market line available at
 * all, the model falls back to its own number outright (and the caller
 * should treat that prediction as lower-confidence / unanchored).
 */
export function predictSpread(input: PredictionInput, params: RatingParams): Prediction {
  const predictedMargin = input.homeRating - input.awayRating + params.homeFieldAdvantage;
  const eloSpreadHome = -predictedMargin;

  const combinedGames = input.homeGamesPlayed + input.awayGamesPlayed;
  const confidence = params.baseErrorPoints / Math.sqrt(combinedGames + 1);

  if (input.marketSpreadHome === null) {
    return { eloSpreadHome, modelSpreadHome: eloSpreadHome, confidence, modelWeight: 1 };
  }

  const modelWeight = combinedGames / (combinedGames + params.marketShrinkageK);
  const modelSpreadHome = modelWeight * eloSpreadHome + (1 - modelWeight) * input.marketSpreadHome;
  return { eloSpreadHome, modelSpreadHome, confidence, modelWeight };
}
