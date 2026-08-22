import { computeClv } from "./clv.js";
import type { BacktestClvRow } from "../db/repo.js";

/**
 * Placebo/shuffle check for the CLV metric itself (not any model): if
 * modelSpreadHome is randomly reassigned across games (severing any real
 * connection between the model and the game it's supposedly predicting,
 * while keeping each game's own real openingSpreadHome/closingSpreadHome
 * pair intact), computeClv's pickSide becomes a coin flip uncorrelated
 * with which way the line actually moved -- so the mean CLV over many
 * such shuffles should be indistinguishable from 0. If it isn't, CLV is
 * picking up some structural bias in the bet-selection or line-timestamp
 * logic itself (e.g. a systematic favorite/dog line-movement tendency
 * correlated with pick direction), not model skill -- and every avgClv
 * number reported anywhere in this codebase would need to be read net of
 * that bias, not at face value.
 *
 * mulberry32 is a small, deterministic PRNG (not cryptographic -- doesn't
 * need to be) so tests and repeated runs are reproducible from a seed.
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/** Mean CLV after randomly reassigning modelSpreadHome values across the given rows (one shuffle trial). */
export function placeboClvMean(rows: BacktestClvRow[], rng: () => number): number {
  const shuffledModelSpreads = shuffle(
    rows.map((r) => r.modelSpreadHome),
    rng,
  );
  const clvs = rows.map((row, i) =>
    computeClv({
      modelSpreadHome: shuffledModelSpreads[i]!,
      openingSpreadHome: row.openingSpreadHome,
      closingSpreadHome: row.closingSpreadHome,
    }).clv,
  );
  return clvs.reduce((s, v) => s + v, 0) / clvs.length;
}

export interface PlaceboTestResult {
  trials: number;
  gamesPerTrial: number;
  placeboMean: number;
  placeboSd: number;
  /** How many placebo-distribution standard deviations the REAL (unshuffled) avgClv sits above the placebo mean -- large means the real result is not explainable by the shuffle-null alone (though it says nothing about whether the metric itself is biased; see placeboMean for that). */
  realClvZScore: number | null;
}

/**
 * Runs `trials` independent shuffles and summarizes the resulting null
 * distribution of mean CLV, plus where the real (unshuffled) avgClv sits
 * relative to it. Deterministic given `seed` -- same seed, same result.
 */
export function runPlaceboTest(rows: BacktestClvRow[], realAvgClv: number | null, trials = 1000, seed = 42): PlaceboTestResult {
  const rng = mulberry32(seed);
  const trialMeans: number[] = [];
  for (let t = 0; t < trials; t++) {
    trialMeans.push(placeboClvMean(rows, rng));
  }
  const placeboMean = trialMeans.reduce((s, v) => s + v, 0) / trialMeans.length;
  const variance = trialMeans.reduce((s, v) => s + (v - placeboMean) ** 2, 0) / trialMeans.length;
  const placeboSd = Math.sqrt(variance);

  return {
    trials,
    gamesPerTrial: rows.length,
    placeboMean,
    placeboSd,
    realClvZScore: realAvgClv === null || placeboSd === 0 ? null : (realAvgClv - placeboMean) / placeboSd,
  };
}
