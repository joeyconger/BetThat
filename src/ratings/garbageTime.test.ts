import { test } from "node:test";
import assert from "node:assert/strict";
import { computeGarbageTimeWeight, secondsRemainingInRegulation, DEFAULT_GARBAGE_TIME_CONFIG } from "./garbageTime.js";

test("secondsRemainingInRegulation: Q2 with 10:30 left on the clock = 40:30 remaining in regulation", () => {
  // Q2 remaining (10:30) + Q3 (15:00) + Q4 (15:00) = 40:30 = 2430s
  assert.equal(secondsRemainingInRegulation(2, 10, 30), 2430);
});

test("secondsRemainingInRegulation: Q4 with 0:00 left = 0 seconds remaining", () => {
  assert.equal(secondsRemainingInRegulation(4, 0, 0), 0);
});

test("secondsRemainingInRegulation: Q1 with a full 15:00 on the clock = 60:00 remaining (full game)", () => {
  assert.equal(secondsRemainingInRegulation(1, 15, 0), 3600);
});

test("computeGarbageTimeWeight: a 0-0 kickoff is always highly competitive (weight 1.0)", () => {
  assert.equal(computeGarbageTimeWeight(0, 0, 1, 15, 0), DEFAULT_GARBAGE_TIME_CONFIG.weights.highlyCompetitive);
});

test("computeGarbageTimeWeight: same margin means MORE with less time left (threshold decreases as clock runs out)", () => {
  // A 20-point margin: not decided with a full game left, but mildly
  // decided by early Q4, matching "time to come back" intuition.
  const early = computeGarbageTimeWeight(20, 0, 1, 15, 0); // full 60:00 remaining, threshold=38
  const late = computeGarbageTimeWeight(20, 0, 4, 5, 0); // 5:00 remaining, threshold=18.75
  assert.equal(early, DEFAULT_GARBAGE_TIME_CONFIG.weights.highlyCompetitive);
  assert.equal(late, DEFAULT_GARBAGE_TIME_CONFIG.weights.mildlyDecided);
});

test("computeGarbageTimeWeight: at 0:00 remaining (Q4), the four tiers land exactly at the configured base margins", () => {
  const w = DEFAULT_GARBAGE_TIME_CONFIG.weights;
  assert.equal(computeGarbageTimeWeight(10, 0, 4, 0, 0), w.highlyCompetitive); // margin 10 < 17
  assert.equal(computeGarbageTimeWeight(17, 0, 4, 0, 0), w.mildlyDecided); // margin 17 >= 17
  assert.equal(computeGarbageTimeWeight(24, 0, 4, 0, 0), w.clearlyDecided); // margin 24 >= 24
  assert.equal(computeGarbageTimeWeight(33, 0, 4, 0, 0), w.extremeGarbageTime); // margin 33 >= 33
});

test("computeGarbageTimeWeight: margin is symmetric (defense way ahead is just as decided as offense way ahead)", () => {
  const behind = computeGarbageTimeWeight(0, 33, 4, 0, 0);
  const ahead = computeGarbageTimeWeight(33, 0, 4, 0, 0);
  assert.equal(behind, ahead);
  assert.equal(behind, DEFAULT_GARBAGE_TIME_CONFIG.weights.extremeGarbageTime);
});

test("computeGarbageTimeWeight: overtime is always highly competitive regardless of margin", () => {
  assert.equal(computeGarbageTimeWeight(50, 0, 5, 2, 0), DEFAULT_GARBAGE_TIME_CONFIG.weights.highlyCompetitive);
  assert.equal(computeGarbageTimeWeight(0, 100, 6, 0, 0), DEFAULT_GARBAGE_TIME_CONFIG.weights.highlyCompetitive);
});

test("computeGarbageTimeWeight: missing score/period/clock data falls back to highly competitive (1.0), not excluded", () => {
  assert.equal(computeGarbageTimeWeight(null, 10, 4, 0, 0), DEFAULT_GARBAGE_TIME_CONFIG.weights.highlyCompetitive);
  assert.equal(computeGarbageTimeWeight(10, null, 4, 0, 0), DEFAULT_GARBAGE_TIME_CONFIG.weights.highlyCompetitive);
  assert.equal(computeGarbageTimeWeight(10, 0, null, 0, 0), DEFAULT_GARBAGE_TIME_CONFIG.weights.highlyCompetitive);
  assert.equal(computeGarbageTimeWeight(10, 0, 4, null, 0), DEFAULT_GARBAGE_TIME_CONFIG.weights.highlyCompetitive);
  assert.equal(computeGarbageTimeWeight(10, 0, 4, 0, null), DEFAULT_GARBAGE_TIME_CONFIG.weights.highlyCompetitive);
});

test("computeGarbageTimeWeight: a custom config's thresholds/weights are honored instead of the defaults", () => {
  const customConfig = {
    mildlyDecided: { baseMargin: 5, marginPerMinuteRemaining: 0 },
    clearlyDecided: { baseMargin: 10, marginPerMinuteRemaining: 0 },
    extremeGarbageTime: { baseMargin: 15, marginPerMinuteRemaining: 0 },
    weights: { highlyCompetitive: 1, mildlyDecided: 0.5, clearlyDecided: 0.25, extremeGarbageTime: 0 },
  };
  assert.equal(computeGarbageTimeWeight(15, 0, 4, 0, 0, customConfig), 0);
  assert.equal(computeGarbageTimeWeight(4, 0, 4, 0, 0, customConfig), 1);
});
