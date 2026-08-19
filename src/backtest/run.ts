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
import { computeClv, computeCovered } from "./clv.js";

const METHOD = "elo" as const;

export interface BacktestParams {
  name: string;
  sport: Sport;
  seasonStart: number;
  seasonEnd: number;
}

export interface BacktestSummary {
  backtestRunId: number;
  scored: number;
  skippedNoOdds: number;
}

/**
 * Replays the rating model week by week across [seasonStart, seasonEnd],
 * predicting each week from an opening-line anchor only (never leaking the
 * closing line or that week's own results — see generateBacktestPredictionsForWeek),
 * then scores every completed game against its real opening/closing lines
 * and actual result. Games missing opening or closing odds data are
 * skipped, not guessed at — right now that's every game, since the SBR
 * historical odds importer isn't finished yet (see README "Odds data").
 * This harness is ready to produce real numbers the moment that data exists.
 */
export async function runBacktest(input: BacktestParams): Promise<BacktestSummary> {
  const backtestRunId = await insertBacktestRun({
    name: input.name,
    method: METHOD,
    seasonStart: input.seasonStart,
    seasonEnd: input.seasonEnd,
    params: { sport: input.sport },
  });

  let scored = 0;
  let skippedNoOdds = 0;

  for (let season = input.seasonStart; season <= input.seasonEnd; season++) {
    const weeks = await getDistinctWeeks(input.sport, season);
    for (const week of weeks) {
      await generateBacktestPredictionsForWeek(input.sport, season, week);
      const games = await getFinalGamesForWeek(input.sport, season, week);

      for (const game of games) {
        const modelSpreadHome = await getLatestPrediction(game.id, METHOD);
        const openingSpreadHome = await getOpeningLine(game.id);
        const closingSpreadHome = await getClosingLine(game.id);

        if (modelSpreadHome === undefined || openingSpreadHome === undefined || closingSpreadHome === undefined) {
          skippedNoOdds += 1;
          continue;
        }

        const actualMarginHome = game.homeScore - game.awayScore;
        const { pickSide, clv } = computeClv({ modelSpreadHome, openingSpreadHome, closingSpreadHome });
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
          beatClose: clv > 0,
        });
        scored += 1;
      }
    }
  }

  return { backtestRunId, scored, skippedNoOdds };
}
