import {
  getSeasonGamesForRating,
  getPriorSeasonFinalRating,
  getPriorSeasonSpRating,
  getReturningProductionDistribution,
  getCfbdEloDistributionForWeek,
  getCfbdSpDistributionForSeason,
  getManualSpWeeklyDistributionForWeek,
  upsertTeamRating,
  getGamesForWeek,
  getLatestMarketLine,
  getOpeningLine,
  insertModelPrediction,
} from "../db/repo.js";
import type { Sport } from "../db/repo.js";
import { getRatingParams, type RatingParams } from "./config.js";
import { computeSeasonRatings, computeInitialRating, predictSpread, zScore, type TeamRatingState } from "./elo.js";

const METHOD = "elo" as const;

/** Below this many rated teams, a week's CFBD Elo z-score isn't a meaningful population to compare against — skip the signal rather than compute a noisy one. */
const MIN_ELO_SAMPLE = 20;
/** Same reasoning as MIN_ELO_SAMPLE, for the prior season's SP+ distribution. */
const MIN_SP_SAMPLE = 20;
/** Same reasoning as MIN_ELO_SAMPLE, for the real weekly SP+ distribution — currently only ever satisfied for 2025. */
const MIN_WEEKLY_SP_SAMPLE = 20;

/**
 * Computes each team's rating as of the end of `throughWeek` and persists
 * it. Returns the rating state for reuse. `paramsOverride` lets a
 * calibration sweep (src/backtest/sweep.ts) try different constants
 * without touching config.ts's defaults — omit it for normal use.
 */
export async function computeAndStoreRatings(
  sport: Sport,
  season: number,
  throughWeek: number,
  paramsOverride?: RatingParams,
): Promise<Map<number, TeamRatingState>> {
  const params = paramsOverride ?? getRatingParams(sport);
  const games = await getSeasonGamesForRating(sport, season, throughWeek);

  const teamIds = new Set<number>();
  for (const game of games) {
    teamIds.add(game.homeTeamId);
    teamIds.add(game.awayTeamId);
  }

  // Fetched once (not per-team) since the league average needs every
  // team's value regardless -- see getReturningProductionDistribution's
  // doc and RatingParams.returningProductionPoints'. CFB-only; NFL's map
  // is always empty since there's no ingestion source for it, same
  // "empty distribution -> no-op for everyone" pattern as spDistribution/
  // eloDistribution in predictAndStoreWeek below.
  const returningProductionDistribution =
    sport === "cfb" ? await getReturningProductionDistribution(sport, season) : new Map<number, number>();
  const returningProductionValues = [...returningProductionDistribution.values()];
  const returningProductionLeagueAverage =
    returningProductionValues.length > 0
      ? returningProductionValues.reduce((sum, v) => sum + v, 0) / returningProductionValues.length
      : undefined;

  const initialRatings = new Map<number, number>();
  for (const teamId of teamIds) {
    const priorRating = await getPriorSeasonFinalRating(teamId, sport, season - 1, METHOD);
    const priorSp = sport === "cfb" ? await getPriorSeasonSpRating(teamId, season - 1) : undefined;
    const teamReturningProduction = returningProductionDistribution.get(teamId);
    const returningProductionDeviation =
      teamReturningProduction !== undefined && returningProductionLeagueAverage !== undefined
        ? teamReturningProduction - returningProductionLeagueAverage
        : undefined;
    if (priorRating !== undefined || priorSp !== undefined || returningProductionDeviation !== undefined) {
      initialRatings.set(teamId, computeInitialRating(priorRating, priorSp, returningProductionDeviation, params));
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

async function predictAndStoreWeek(
  sport: Sport,
  season: number,
  week: number,
  getMarketLine: (gameId: number) => Promise<number | undefined>,
  paramsOverride?: RatingParams,
): Promise<{ predicted: number }> {
  const params = paramsOverride ?? getRatingParams(sport);
  const ratingState = await computeAndStoreRatings(sport, season, week - 1, paramsOverride);
  const games = await getGamesForWeek(sport, season, week);

  // As-of-end-of-prior-week, same invariant as the ratings themselves — never
  // this week's own CFBD Elo update. CFB only; NFL's map is always empty
  // since CFBD doesn't cover it, so homeEloZ/awayEloZ stay undefined there.
  const eloDistribution =
    sport === "cfb" ? await getCfbdEloDistributionForWeek(sport, season, week - 1) : new Map<number, number>();
  const eloValues = [...eloDistribution.values()];
  const hasEloSample = eloValues.length >= MIN_ELO_SAMPLE;

  // SP+ has no week granularity, so this is the PRIOR season's full
  // distribution, not "as of last week" — see getCfbdSpDistributionForSeason's
  // doc. Constant across every week of `season` for a given team.
  const spDistribution =
    sport === "cfb" ? await getCfbdSpDistributionForSeason(sport, season - 1) : new Map<number, number>();
  const spValues = [...spDistribution.values()];
  const hasSpSample = spValues.length >= MIN_SP_SAMPLE;

  // Same as-of-end-of-prior-week invariant as CFBD Elo above. CFB only;
  // currently only ever non-empty for season=2025 (the one season a real
  // manual archive exists for — see ingest/manual/syncManualSpWeekly.ts).
  const weeklySpDistribution =
    sport === "cfb" ? await getManualSpWeeklyDistributionForWeek(sport, season, week - 1) : new Map<number, number>();
  const weeklySpValues = [...weeklySpDistribution.values()];
  const hasWeeklySpSample = weeklySpValues.length >= MIN_WEEKLY_SP_SAMPLE;

  let predicted = 0;

  for (const game of games) {
    const home = ratingState.get(game.homeTeamId) ?? { rating: 0, gamesPlayed: 0 };
    const away = ratingState.get(game.awayTeamId) ?? { rating: 0, gamesPlayed: 0 };
    const marketSpreadHome = (await getMarketLine(game.id)) ?? null;

    const homeElo = eloDistribution.get(game.homeTeamId);
    const awayElo = eloDistribution.get(game.awayTeamId);
    const homeEloZ = hasEloSample && homeElo !== undefined ? zScore(homeElo, eloValues) : undefined;
    const awayEloZ = hasEloSample && awayElo !== undefined ? zScore(awayElo, eloValues) : undefined;

    const homeSp = spDistribution.get(game.homeTeamId);
    const awaySp = spDistribution.get(game.awayTeamId);
    const homeSpZ = hasSpSample && homeSp !== undefined ? zScore(homeSp, spValues) : undefined;
    const awaySpZ = hasSpSample && awaySp !== undefined ? zScore(awaySp, spValues) : undefined;

    const homeWeeklySp = weeklySpDistribution.get(game.homeTeamId);
    const awayWeeklySp = weeklySpDistribution.get(game.awayTeamId);
    const homeWeeklySpZ = hasWeeklySpSample && homeWeeklySp !== undefined ? zScore(homeWeeklySp, weeklySpValues) : undefined;
    const awayWeeklySpZ = hasWeeklySpSample && awayWeeklySp !== undefined ? zScore(awayWeeklySp, weeklySpValues) : undefined;

    // marketSpreadHome is fetched above and stored below (for display and
    // for CLV scoring, per the anchor-removal decision -- see
    // ratings/elo.ts's predictSpread doc) but deliberately NOT passed into
    // predictSpread: the model's prediction no longer takes the market
    // line as an input at all.
    const prediction = predictSpread(
      {
        homeRating: home.rating,
        awayRating: away.rating,
        homeGamesPlayed: home.gamesPlayed,
        awayGamesPlayed: away.gamesPlayed,
        homeEloZ,
        awayEloZ,
        homeSpZ,
        awaySpZ,
        homeWeeklySpZ,
        awayWeeklySpZ,
        restDaysDiff: game.restDaysDiff,
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

/**
 * Generates model_predictions for every game in `week`, using ratings as of
 * the END of the prior week — never that week's own results, or the
 * prediction would be leaking the outcome it's supposed to be predicting.
 * Anchors to the most recently polled market line — correct for live use
 * (Phase 4), where "latest" can never be later than right now.
 */
export function generatePredictionsForWeek(sport: Sport, season: number, week: number): Promise<{ predicted: number }> {
  return predictAndStoreWeek(sport, season, week, getLatestMarketLine);
}

/**
 * Same as generatePredictionsForWeek, but anchors to the opening line
 * specifically — see getOpeningLine's doc comment for why this must be a
 * separate path from the live version rather than reusing "latest line."
 * This is what Phase 3's backtest harness calls.
 */
export function generateBacktestPredictionsForWeek(
  sport: Sport,
  season: number,
  week: number,
  paramsOverride?: RatingParams,
): Promise<{ predicted: number }> {
  return predictAndStoreWeek(sport, season, week, getOpeningLine, paramsOverride);
}
