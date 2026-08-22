import { test } from "node:test";
import assert from "node:assert/strict";
import { placeboClvMean, runPlaceboTest } from "./placebo.js";
import type { BacktestClvRow } from "../db/repo.js";

function mulberry32ForTest(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("placeboClvMean is deterministic for a given rng sequence", () => {
  const rows: BacktestClvRow[] = [
    { modelSpreadHome: -3, openingSpreadHome: -2, closingSpreadHome: -4 },
    { modelSpreadHome: 5, openingSpreadHome: 3, closingSpreadHome: 1 },
    { modelSpreadHome: 0, openingSpreadHome: 1, closingSpreadHome: 2 },
  ];
  const mean1 = placeboClvMean(rows, mulberry32ForTest(1));
  const mean2 = placeboClvMean(rows, mulberry32ForTest(1));
  assert.equal(mean1, mean2, "same seed should reproduce the same shuffle and same mean");
});

test("runPlaceboTest's null distribution mean is close to 0 for symmetric, unbiased synthetic data", () => {
  // Construct rows where line movement (opening - closing) is symmetric
  // around 0 and unrelated to modelSpreadHome -- a textbook "no real bias"
  // setup. The shuffle-null mean should land near 0 given enough trials.
  const rows: BacktestClvRow[] = [];
  for (let i = 0; i < 100; i++) {
    const movement = (i % 2 === 0 ? 1 : -1) * ((i % 5) + 1); // symmetric, deterministic movement pattern
    const opening = (i % 7) - 3;
    rows.push({
      modelSpreadHome: opening + ((i % 3) - 1), // some spread of model values, uncorrelated with movement
      openingSpreadHome: opening,
      closingSpreadHome: opening - movement,
    });
  }
  const result = runPlaceboTest(rows, null, 500, 7);
  assert.ok(Math.abs(result.placeboMean) < 1, `placebo mean should be small/near 0 for symmetric synthetic data (got ${result.placeboMean})`);
  assert.equal(result.trials, 500);
  assert.equal(result.gamesPerTrial, 100);
});

test("runPlaceboTest computes a finite z-score when a real avgClv is provided", () => {
  const rows: BacktestClvRow[] = Array.from({ length: 30 }, (_, i) => ({
    modelSpreadHome: (i % 5) - 2,
    openingSpreadHome: (i % 3) - 1,
    closingSpreadHome: (i % 4) - 2,
  }));
  const result = runPlaceboTest(rows, 5, 300, 3);
  assert.ok(result.realClvZScore !== null && Number.isFinite(result.realClvZScore));
});

test("runPlaceboTest returns null z-score when no real avgClv is given", () => {
  const rows: BacktestClvRow[] = [{ modelSpreadHome: 1, openingSpreadHome: 0, closingSpreadHome: -1 }];
  const result = runPlaceboTest(rows, null, 50, 1);
  assert.equal(result.realClvZScore, null);
});
