import {
  getSeasonGamesForRating,
  getPriorSeasonFinalRating,
  upsertTeamRating,
  getGamesForWeek,
  getLatestMarketLine,
  insertModelPrediction,
} from "../db/repo.js";
import type { Sport } from "../db/repo.js";
import { getRatingParams } from "./config.js";
import { computeSeasonRatings, carryoverRating, predictSpread, type TeamRatingState } from "./elo.js";

const METHOD = "elo" as const;

/** Computes each team's rating as of the end of `throughWeek` and persists it. Returns the rating state for reuse. */
export async function computeAndStoreRatings(
  sport: Sport,
  season: number,
  throughWeek: number,
): Promise<Map<number, TeamRatingState>> {
  const params = getRatingParams(sport);
  const games = await getSeasonGamesForRating(sport, season, throughWeek);

  const teamIds = new Set<number>();
  for (const game of games) {
    teamIds.add(game.homeTeamId);
    teamIds.add(game.awayTeamId);
  }

  const initialRatings = new Map<number, number>();
  for (const teamId of teamIds) {
    const priorRating = await getPriorSeasonFinalRating(teamId, sport, season - 1, METHOD);
    if (priorRating !== undefined) {
      initialRatings.set(teamId, carryoverRating(priorRating, params));
    }
  }

  const state = computeSeasonRatings(games, initialRatings, params);

  for (const [teamId, teamState] of state) {
    await upsertTeamRating({
      teamId,
      sport,
      season,
      throughWeek,
      rating: teamState.rating,
      ratingError: params.baseErrorPoints / Math.sqrt(teamState.gamesPlayed + 1),
      method: METHOD,
    });
  }

  return state;
}

/**
 * Generates model_predictions for every game in `week`, using ratings as of
 * the END of the prior week — never that week's own results, or the
 * prediction would be leaking the outcome it's supposed to be predicting.
 */
export async function generatePredictionsForWeek(
  sport: Sport,
  season: number,
  week: number,
): Promise<{ predicted: number }> {
  const params = getRatingParams(sport);
  const ratingState = await computeAndStoreRatings(sport, season, week - 1);
  const games = await getGamesForWeek(sport, season, week);

  let predicted = 0;

  for (const game of games) {
    const home = ratingState.get(game.homeTeamId) ?? { rating: 0, gamesPlayed: 0 };
    const away = ratingState.get(game.awayTeamId) ?? { rating: 0, gamesPlayed: 0 };
    const marketSpreadHome = (await getLatestMarketLine(game.id)) ?? null;

    const prediction = predictSpread(
      {
        homeRating: home.rating,
        awayRating: away.rating,
        homeGamesPlayed: home.gamesPlayed,
        awayGamesPlayed: away.gamesPlayed,
        marketSpreadHome,
      },
      params,
    );

    await insertModelPrediction({
      gameId: game.id,
      method: METHOD,
      modelSpreadHome: prediction.modelSpreadHome,
      modelTotal: null,
      confidence: prediction.confidence,
      marketSpreadHome,
    });
    predicted += 1;
  }

  return { predicted };
}
