import { test } from "node:test";
import assert from "node:assert/strict";
import { transpose, multiply, multiplyVector, solveLinearSystem, ridgeFit, predict, crossValidatedMse, selectLambda } from "./ridge.js";

test("transpose flips rows and columns", () => {
  assert.deepEqual(transpose([[1, 2, 3], [4, 5, 6]]), [[1, 4], [2, 5], [3, 6]]);
});

test("multiply computes standard matrix product", () => {
  // [[1,2],[3,4]] x [[5,6],[7,8]] = [[19,22],[43,50]]
  assert.deepEqual(multiply([[1, 2], [3, 4]], [[5, 6], [7, 8]]), [[19, 22], [43, 50]]);
});

test("multiplyVector computes matrix-vector product", () => {
  assert.deepEqual(multiplyVector([[1, 2], [3, 4]], [5, 6]), [17, 39]);
});

test("solveLinearSystem solves a hand-verifiable 2x2 system", () => {
  // 2x + y = 5; x + 3y = 10 -> x=1, y=3
  const x = solveLinearSystem([[2, 1], [1, 3]], [5, 10]);
  assert.ok(Math.abs(x[0]! - 1) < 1e-9);
  assert.ok(Math.abs(x[1]! - 3) < 1e-9);
});

test("solveLinearSystem throws on a singular matrix", () => {
  assert.throws(() => solveLinearSystem([[1, 2], [2, 4]], [1, 2]));
});

test("ridgeFit at lambda=0 recovers exact coefficients for a noiseless linear relationship", () => {
  // y = 2*x1 + 3*x2 + 1, no noise, unregularized -> should recover [2,3] and intercept 1 exactly.
  const X = [
    [1, 1],
    [2, 1],
    [1, 2],
    [3, 2],
    [2, 3],
    [4, 1],
  ];
  const y = X.map(([x1, x2]) => 2 * x1! + 3 * x2! + 1);
  const fit = ridgeFit(X, y, 0);
  assert.ok(Math.abs(fit.coefficients[0]! - 2) < 1e-6, `coef0 ~2 (got ${fit.coefficients[0]})`);
  assert.ok(Math.abs(fit.coefficients[1]! - 3) < 1e-6, `coef1 ~3 (got ${fit.coefficients[1]})`);
  assert.ok(Math.abs(fit.intercept - 1) < 1e-6, `intercept ~1 (got ${fit.intercept})`);
});

test("ridgeFit shrinks coefficients toward 0 as lambda increases", () => {
  const X = [
    [1, 1],
    [2, 1],
    [1, 2],
    [3, 2],
    [2, 3],
    [4, 1],
    [3, 4],
    [5, 2],
  ];
  const y = X.map(([x1, x2]) => 2 * x1! + 3 * x2! + 1);
  const fitLow = ridgeFit(X, y, 0.01);
  const fitHigh = ridgeFit(X, y, 1000);
  const magLow = Math.abs(fitLow.coefficients[0]!) + Math.abs(fitLow.coefficients[1]!);
  const magHigh = Math.abs(fitHigh.coefficients[0]!) + Math.abs(fitHigh.coefficients[1]!);
  assert.ok(magHigh < magLow, `high-lambda coefficient magnitude (${magHigh}) should be smaller than low-lambda (${magLow})`);
});

test("ridgeFit splits credit between two perfectly correlated (duplicate) features, rather than assigning it all to one", () => {
  // x2 is an exact copy of x1 -- true relationship is y = 4*x1 + noise-free,
  // but since x1 and x2 are indistinguishable, ridge should split credit
  // roughly evenly (unlike unregularized OLS, which is undetermined/unstable
  // here) rather than dumping the full weight on one arbitrarily.
  const x1 = [1, 2, 3, 4, 5, 6, 7, 8];
  const y = x1.map((v) => 4 * v);
  const X = x1.map((v) => [v, v]);
  const fit = ridgeFit(X, y, 1);
  assert.ok(Math.abs(fit.coefficients[0]! - fit.coefficients[1]!) < 1e-6, "duplicate features get equal (or near-equal) credit under ridge");
  const total = fit.coefficients[0]! + fit.coefficients[1]!;
  assert.ok(Math.abs(total - 4) < 0.5, `combined coefficient should still be near the true total effect of 4 (got ${total})`);
});

test("predict matches ridgeFit's own coefficients/intercept on the training rows it was fit on (low lambda)", () => {
  const X = [
    [1, 0],
    [0, 1],
    [1, 1],
    [2, 0],
    [0, 2],
  ];
  const y = [3, 5, 8, 6, 10];
  const fit = ridgeFit(X, y, 0.001);
  const preds = predict(X, fit);
  for (let i = 0; i < y.length; i++) {
    assert.ok(Math.abs(preds[i]! - y[i]!) < 0.5, `prediction ${preds[i]} close to actual ${y[i]} at low lambda`);
  }
});

test("crossValidatedMse is finite and non-negative for a reasonable dataset", () => {
  const X = Array.from({ length: 20 }, (_, i) => [i, i * 2]);
  const y = X.map(([x1, x2], i) => 2 * x1! + x2! + (i % 2 === 0 ? 1 : -1));
  const mse = crossValidatedMse(X, y, 1, 5);
  assert.ok(Number.isFinite(mse) && mse >= 0, `mse should be a finite non-negative number (got ${mse})`);
});

test("selectLambda picks a lower-MSE lambda over a clearly-too-high one for a real linear relationship", () => {
  const n = 40;
  const X = Array.from({ length: n }, (_, i) => [i % 7, (i * 3) % 11]);
  const y = X.map(([x1, x2], i) => 2 * x1! + 3 * x2! + 1 + (i % 2 === 0 ? 0.1 : -0.1));
  const results = selectLambda(X, y, [0.01, 1, 1_000_000], 5);
  assert.equal(results.length, 3);
  // Sorted ascending by MSE -- the best should not be the absurdly-high lambda (which shrinks everything to ~the mean).
  assert.notEqual(results[0]!.lambda, 1_000_000, "an absurdly high lambda should not win over reasonable ones for a real linear relationship");
});
