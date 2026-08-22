import { test } from "node:test";
import assert from "node:assert/strict";
import { pairedTTest } from "./significance.js";

test("pairedTTest throws on mismatched lengths", () => {
  assert.throws(() => pairedTTest([1, 2], [1, 2, 3]));
});

test("pairedTTest throws on fewer than 2 pairs", () => {
  assert.throws(() => pairedTTest([1], [2]));
});

test("pairedTTest finds no significant difference when b equals a plus symmetric noise", () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const b = a.map((v, i) => v + (i % 2 === 0 ? 0.5 : -0.5)); // symmetric noise, mean diff = 0
  const result = pairedTTest(a, b);
  assert.equal(result.n, 10);
  assert.ok(Math.abs(result.meanDiff) < 1e-9, `mean diff should be ~0 (got ${result.meanDiff})`);
  assert.ok(result.pValueTwoSided > 0.5, `p-value should be large/non-significant for zero mean diff (got ${result.pValueTwoSided})`);
});

test("pairedTTest finds a significant difference when b is consistently higher than a", () => {
  const a = Array.from({ length: 50 }, (_, i) => (i % 7) - 3);
  const b = a.map((v, i) => v + 5 + ((i % 3) - 1) * 0.1); // consistent +5 shift, tiny noise
  const result = pairedTTest(a, b);
  assert.ok(result.meanDiff > 4.5 && result.meanDiff < 5.5, `mean diff should be close to 5 (got ${result.meanDiff})`);
  assert.ok(result.pValueTwoSided < 0.001, `p-value should be tiny for a large, consistent shift (got ${result.pValueTwoSided})`);
  assert.ok(result.tStatistic > 0, "t-statistic should be positive when b consistently exceeds a");
});

test("pairedTTest sign of t-statistic matches direction of meanDiff", () => {
  const a = [10, 10, 10, 10, 10];
  const b = [1, 1, 1, 1, 1];
  const result = pairedTTest(a, b);
  assert.ok(result.meanDiff < 0);
  assert.ok(result.tStatistic < 0);
});
