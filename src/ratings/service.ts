import {
  getSeasonGamesForRating,
  getPriorSeasonFinalRating,
  getCfbdEloDistributionForWeek,
  getCfbdSpDistributionForSeason,
  getManualSpWeeklyDistributionForWeek,
  getPlaysForSeasonThroughWeek,
  getPriorSeasonEpaSolve,
  upsertTeamRating,
  getGamesForWeek,
  getLatestMarketLine,
  getOpeningLine,
  insertModelPrediction,
} from "../db/repo.js";
import type { Sport } from "../db/repo.js";
import { getRatingParams, type RatingParams } from "./config.js";
import { computeSeasonRatings, computeInitialRating, predictSpread, zScore, type TeamRatingState } from "./elo.js";
import { buildTeamPerformancesEpa, type GamePlaysGroup } from "./gamePerformance.js";
import { computeSolveRatings, DEFAULT_SOLVE_RATING_PARAMS } from "./solveRatings.js";

const METHOD = "elo" as const;

/** Below this many rated teams, a week's CFBD Elo z-score isn't a meaningful population to compare against — skip the signal rather than compute a noisy one. */
const MIN_ELO_SAMPLE = 20;
/** Same reasoning as MIN_ELO_SAMPLE, for the prior season's SP+ distribution. */
const MIN_SP_SAMPLE = 20;
/** Same reasoning as MIN_ELO_SAMPLE, for the real weekly SP+ distribution — currently only ever satisfied for 2025. */
const MIN_WEEKLY_SP_SAMPLE = 20;

/**
 * Computes each team's rating as of the end of `throughWeek` -- pure read,
 * no persistence. Factored out of computeAndStoreRatings so read-only
 * callers (the matchup-sim UI page) don't upsert team_ratings on every
 * page view; computeAndStoreRatings below is the persisting wrapper admin
 * jobs and predictAndStoreWeek actually use.
 *
 * CFB uses the iterative opponent-adjustment solve (solveRatings.ts) as
 * the primary rating engine -- see docs/prompts/iterative-solve-replaces-elo.md
 * for the real-data justification (Step 1's 8-checkpoint correlation
 * comparison against SP+). NFL has no raw-play/PPA ingestion, so it stays
 * on the incremental Elo path (elo.ts's computeSeasonRatings) unchanged.
 *
 * `paramsOverride` for CFB no longer has the effect it used to for the
 * Elo-specific fields it doesn't share with the new engine (baseK,
 * sosWeight, errorCapPoints, varianceShrinkK, the pointsPerX additive
 * components, etc. -- see config.ts's RatingParams doc for the full dead
 * list) -- those sweeps/paired-tests still run without erroring, they
 * just no longer change anything for CFB. This is the expected, planned
 * consequence of the rebuild, not a bug.
 */
export async function computeRatings(
  sport: Sport,
  season: number,
  throughWeek: number,
  paramsOverride?: RatingParams,
): Promise<Map<number, TeamRatingState>> {
  if (sport === "cfb") {
    return computeCfbSolveRatings(season, throughWeek);
  }
  return computeNflEloRatings(season, throughWeek, paramsOverride);
}

/** The new primary CFB engine -- see computeRatings' doc. */
async function computeCfbSolveRatings(season: number, throughWeek: number): Promise<Map<number, TeamRatingState>> {
  const plays = await getPlaysForSeasonThroughWeek("cfb", season, throughWeek);
  const gamesById = new Map<number, GamePlaysGroup>();
  for (const p of plays) {
    let g = gamesById.get(p.gameId);
    if (!g) {
      g = { gameId: p.gameId, homeTeamId: p.homeTeamId, awayTeamId: p.awayTeamId, plays: [] };
      gamesById.set(p.gameId, g);
    }
    g.plays.push({
      offenseTeamId: p.offenseTeamId,
      defenseTeamId: p.defenseTeamId,
      down: p.down,
      distance: p.distance,
      yardsGained: p.yardsGained,
      playType: p.playType,
      offenseScore: p.offenseScore,
      defenseScore: p.defenseScore,
      period: p.period,
      clockMinutes: p.clockMinutes,
      clockSeconds: p.clockSeconds,
      ppa: p.ppa,
    });
  }
  const performances = buildTeamPerformancesEpa([...gamesById.values()]);
  const priorSolve = await getPriorSeasonEpaSolve("cfb", season - 1);
  const solveRatings = computeSolveRatings(performances, priorSolve, DEFAULT_SOLVE_RATING_PARAMS);

  const state = new Map<number, TeamRatingState>();
  for (const [teamId, r] of solveRatings) {
    state.set(teamId, {
      rating: r.rating,
      gamesPlayed: r.gamesPlayed,
      dispersion: 0, // Step 3 (deferred) will re-point this at solve residuals.
      excessDispersion: 0,
      offRating: r.offPoints,
      defRating: r.defPoints,
    });
  }
  return state;
}

/** The old incremental Elo engine -- still the NFL path (no raw-play/PPA ingestion for NFL, see solveRatings.ts's module doc), unchanged from before this rebuild. */
async function computeNflEloRatings(season: number, throughWeek: number, paramsOverride?: RatingParams): Promise<Map<number, TeamRatingState>> {
  const params = paramsOverride ?? getRatingParams("nfl");
  const games = await getSeasonGamesForRating("nfl", season, throughWeek);

  const teamIds = new Set<number>();
  for (const game of games) {
    teamIds.add(game.homeTeamId);
    teamIds.add(game.awayTeamId);
  }

  const initialRatings = new Map<number, number>();
  for (const teamId of teamIds) {
    const priorRating = await getPriorSeasonFinalRating(teamId, "nfl", season - 1, METHOD);
    if (priorRating !== undefined) {
      initialRatings.set(teamId, computeInitialRating(priorRating, undefined, undefined, params));
    }
  }

  return computeSeasonRatings(games, initialRatings, params);
}

/**
 * Same as computeRatings, plus persists the result to team_ratings. What
 * every admin job / predictAndStoreWeek actually calls; computeRatings
 * above is for read-only callers that shouldn't write on every call (the
 * matchup-sim UI page).
 */
export async function computeAndStoreRatings(
  sport: Sport,
  season: number,
  throughWeek: number,
  paramsOverride?: RatingParams,
): Promise<Map<number, TeamRatingState>> {
  const params = paramsOverride ?? getRatingParams(sport);
  const state = await computeRatings(sport, season, throughWeek, paramsOverride);

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

export interface HypotheticalMatchupResult {
  home: { teamId: number; rating: number; gamesPlayed: number };
  away: { teamId: number; rating: number; gamesPlayed: number };
  modelSpreadHome: number;
  confidence: number;
}

/**
 * Predicts an arbitrary matchup between two teams -- not necessarily a
 * real scheduled game -- as of the end of `throughWeek` in `season`. Per
 * predictSpread's doc (see elo.ts), an arbitrary hypothetical matchup with
 * no market line isn't a degraded case, it's the normal path; this just
 * needs the two teams' ratings, nothing else required. Deliberately
 * simpler than predictAndStoreWeek's real-game path: omits the CFBD Elo/
 * SP+/weekly-SP+ z-score signals and rest-days-diff, since those are
 * tied to a specific real calendar matchup (a week's external-rating
 * distribution, two teams' actual rest gap) that doesn't cleanly exist
 * for a hypothetical pairing -- predictSpread already treats each as a
 * clean no-op when omitted, the same fallback shape used throughout this
 * model for missing optional signals, not a special case invented here.
 */
export async function predictHypotheticalMatchup(
  sport: Sport,
  homeTeamId: number,
  awayTeamId: number,
  season: number,
  throughWeek: number,
  paramsOverride?: RatingParams,
): Promise<HypotheticalMatchupResult> {
  const params = paramsOverride ?? getRatingParams(sport);
  const state = await computeRatings(sport, season, throughWeek, paramsOverride);
  const home = state.get(homeTeamId) ?? { rating: 0, gamesPlayed: 0, dispersion: 0, excessDispersion: 0 };
  const away = state.get(awayTeamId) ?? { rating: 0, gamesPlayed: 0, dispersion: 0, excessDispersion: 0 };

  const prediction = predictSpread(
    { homeRating: home.rating, awayRating: away.rating, homeGamesPlayed: home.gamesPlayed, awayGamesPlayed: away.gamesPlayed },
    params,
  );

  return {
    home: { teamId: homeTeamId, rating: home.rating, gamesPlayed: home.gamesPlayed },
    away: { teamId: awayTeamId, rating: away.rating, gamesPlayed: away.gamesPlayed },
    modelSpreadHome: prediction.modelSpreadHome,
    confidence: prediction.confidence,
  };
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
    const home = ratingState.get(game.homeTeamId) ?? { rating: 0, gamesPlayed: 0, dispersion: 0, excessDispersion: 0 };
    const away = ratingState.get(game.awayTeamId) ?? { rating: 0, gamesPlayed: 0, dispersion: 0, excessDispersion: 0 };
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
