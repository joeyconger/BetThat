import {
  getDistinctWeeks,
  getFinalGamesForWeek,
  getOpeningLine,
  getClosingLine,
  getLatestPrediction,
  insertBacktestRun,
  insertBacktestResult,
} from "../db/repo.js";
import type { Sport } from "../db/repo.js";
import { generateBacktestPredictionsForWeek } from "../ratings/service.js";
import type { RatingParams } from "../ratings/config.js";
import { computeClv, computeCovered, pickSideFromDeviation } from "./clv.js";

const METHOD = "elo" as const;

export interface BacktestParams {
  name: string;
  sport: Sport;
  seasonStart: number;
  seasonEnd: number;
  /** Overrides ratings/config.ts's defaults for this run — see backtest/sweep.ts. */
  paramsOverride?: RatingParams;
}

export interface BacktestSummary {
  backtestRunId: number;
  scored: number;
  skippedNoOdds: number;
}

/**
 * Replays the rating model week by week across [seasonStart, seasonEnd],
 * predicting each week from an opening-line anchor when one exists (never
 * leaking the closing line or that week's own results — see
 * generateBacktestPredictionsForWeek), then scores every completed game
 * against its real line(s) and actual result.
 *
 * An opening line is the exception, not the rule, in the data this project
 * has free access to (nflverse's historical odds are closing-only, back to
 * 1999; only SBR's older 2019-21 seasons have both — see README "Odds
 * data"). So this treats the closing line as the required minimum and the
 * opening line as optional:
 *   - Both exist: real CLV is computed (computeClv), and the pick side
 *     comes from the model's deviation from the OPENING line.
 *   - Only closing exists: clv is left null (there's no bet price to
 *     compare against), and the pick side instead comes from the model's
 *     deviation from the CLOSING line — `covered` (did that pick actually
 *     beat the closing number, using the real final score) becomes the
 *     primary signal-quality metric for these games, which needs no
 *     opening line at all.
 * A game with no closing line either is skipped outright — there's nothing
 * to score it against.
 */
export async function runBacktest(input: BacktestParams): Promise<BacktestSummary> {
  const backtestRunId = await insertBacktestRun({
    name: input.name,
    method: METHOD,
    seasonStart: input.seasonStart,
    seasonEnd: input.seasonEnd,
    params: { sport: input.sport, ratingParams: input.paramsOverride },
  });

  let scored = 0;
  let skippedNoOdds = 0;

  for (let season = input.seasonStart; season <= input.seasonEnd; season++) {
    const weeks = await getDistinctWeeks(input.sport, season);
    for (const week of weeks) {
      await generateBacktestPredictionsForWeek(input.sport, season, week, input.paramsOverride);
      const games = await getFinalGamesForWeek(input.sport, season, week);

      for (const game of games) {
        const prediction = await getLatestPrediction(game.id, METHOD);
        const openingSpreadHome = (await getOpeningLine(game.id)) ?? null;
        const closingSpreadHome = await getClosingLine(game.id);

        if (prediction === undefined || closingSpreadHome === undefined) {
          skippedNoOdds += 1;
          continue;
        }
        const { modelSpreadHome, confidence } = prediction;

        const actualMarginHome = game.homeScore - game.awayScore;

        const { pickSide, clv } =
          openingSpreadHome !== null
            ? computeClv({ modelSpreadHome, openingSpreadHome, closingSpreadHome })
            : { ...pickSideFromDeviation(modelSpreadHome, closingSpreadHome), clv: null };

        const covered = computeCovered(pickSide, actualMarginHome, closingSpreadHome);

        await insertBacktestResult({
          backtestRunId,
          gameId: game.id,
          modelSpreadHome,
          openingSpreadHome,
          closingSpreadHome,
          actualMarginHome,
          clv,
          covered,
          beatClose: clv === null ? null : clv > 0,
          confidence,
        });
        scored += 1;
      }
    }
  }

  return { backtestRunId, scored, skippedNoOdds };
}
