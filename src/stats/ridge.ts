/**
 * Ridge regression from scratch -- no ML/stats library in this project's
 * dependencies (see package.json), and the design matrices here are small
 * (a handful of component features, thousands of games), so a from-
 * scratch normal-equations solve is simpler and more auditable than
 * pulling in a dependency for this one use.
 *
 * Built for the joint component refit (see backtest/jointRefit.ts):
 * replacing 8 hand-tuned, one-at-a-time-calibrated pointsPerX weights
 * with a single jointly-fit set, so correlated components (explosiveness,
 * down/distance splits, opponent-adjustment -- all measuring overlapping
 * variance in team strength) get their weights allocated by a real
 * regression instead of each competing for credit independently against
 * weights the others were already calibrated around.
 */

export type Matrix = number[][];

export function transpose(m: Matrix): Matrix {
  if (m.length === 0) return [];
  const rows = m.length;
  const cols = m[0]!.length;
  const result: Matrix = Array.from({ length: cols }, () => new Array(rows).fill(0));
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      result[j]![i] = m[i]![j]!;
    }
  }
  return result;
}

export function multiply(a: Matrix, b: Matrix): Matrix {
  const aRows = a.length;
  const aCols = a[0]?.length ?? 0;
  const bCols = b[0]?.length ?? 0;
  const result: Matrix = Array.from({ length: aRows }, () => new Array(bCols).fill(0));
  for (let i = 0; i < aRows; i++) {
    for (let k = 0; k < aCols; k++) {
      const aik = a[i]![k]!;
      if (aik === 0) continue;
      for (let j = 0; j < bCols; j++) {
        result[i]![j] = result[i]![j]! + aik * b[k]![j]!;
      }
    }
  }
  return result;
}

export function multiplyVector(m: Matrix, v: number[]): number[] {
  return m.map((row) => row.reduce((sum, val, j) => sum + val * v[j]!, 0));
}

/**
 * Solves the linear system Ax = b via Gauss-Jordan elimination with
 * partial pivoting. A must be square. Throws if A is singular (shouldn't
 * happen here -- the ridge penalty added before calling this always
 * makes X^T X + lambda*I positive definite for lambda > 0).
 */
export function solveLinearSystem(a: Matrix, b: number[]): number[] {
  const n = a.length;
  const augmented: number[][] = a.map((row, i) => [...row, b[i]!]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxAbs = Math.abs(augmented[col]![col]!);
    for (let r = col + 1; r < n; r++) {
      const abs = Math.abs(augmented[r]![col]!);
      if (abs > maxAbs) {
        maxAbs = abs;
        pivotRow = r;
      }
    }
    if (maxAbs < 1e-12) throw new Error(`solveLinearSystem: matrix is singular (or near-singular) at column ${col}`);
    if (pivotRow !== col) {
      const tmp = augmented[col]!;
      augmented[col] = augmented[pivotRow]!;
      augmented[pivotRow] = tmp;
    }

    const pivotVal = augmented[col]![col]!;
    for (let j = col; j <= n; j++) augmented[col]![j] = augmented[col]![j]! / pivotVal;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = augmented[r]![col]!;
      if (factor === 0) continue;
      for (let j = col; j <= n; j++) {
        augmented[r]![j] = augmented[r]![j]! - factor * augmented[col]![j]!;
      }
    }
  }

  return augmented.map((row) => row[n]!);
}

export interface RidgeFitResult {
  /** One coefficient per feature column, in the ORIGINAL (unstandardized) feature units -- directly usable as a pointsPerX-style weight. */
  coefficients: number[];
  intercept: number;
}

/**
 * Ridge regression: minimizes ||y - Xb - intercept||^2 + lambda*||b||^2.
 * Features are standardized (mean 0, unit variance) before fitting --
 * required for the penalty to treat every feature fairly regardless of
 * its raw scale (a component on a 0-1 scale and one on a points scale
 * would otherwise get very unequal effective regularization) -- then
 * coefficients are converted back to original units so the caller can
 * use them directly (e.g. as new pointsPerX values). The intercept is
 * computed from the centered fit (X and y both mean-subtracted before
 * the penalized solve, avoiding penalizing the intercept itself).
 */
export function ridgeFit(X: Matrix, y: number[], lambda: number): RidgeFitResult {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  if (n === 0 || p === 0) return { coefficients: new Array(p).fill(0), intercept: 0 };

  const featureMeans = new Array(p).fill(0);
  const featureStds = new Array(p).fill(1);
  for (let j = 0; j < p; j++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += X[i]![j]!;
    featureMeans[j] = sum / n;
  }
  for (let j = 0; j < p; j++) {
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const d = X[i]![j]! - featureMeans[j];
      sumSq += d * d;
    }
    const std = Math.sqrt(sumSq / n);
    featureStds[j] = std > 1e-12 ? std : 1;
  }

  const yMean = y.reduce((s, v) => s + v, 0) / n;

  const Xs: Matrix = X.map((row) => row.map((val, j) => (val - featureMeans[j]) / featureStds[j]));
  const ys = y.map((v) => v - yMean);

  const Xt = transpose(Xs);
  const XtX = multiply(Xt, Xs);
  for (let j = 0; j < p; j++) XtX[j]![j] = XtX[j]![j]! + lambda;
  const Xty = multiplyVector(Xt, ys);

  const betaStandardized = solveLinearSystem(XtX, Xty);

  // Convert standardized coefficients back to original feature units:
  // beta_original_j = beta_standardized_j / std_j.
  const coefficients = betaStandardized.map((b, j) => b / featureStds[j]);
  const intercept = yMean - coefficients.reduce((s, b, j) => s + b * featureMeans[j], 0);

  return { coefficients, intercept };
}

export function predict(X: Matrix, fit: RidgeFitResult): number[] {
  return X.map((row) => fit.intercept + row.reduce((s, val, j) => s + val * fit.coefficients[j]!, 0));
}

/**
 * Mean squared error of a candidate lambda via k-fold cross-validation on
 * the training data -- the standard, simple way to pick a regularization
 * strength without touching the real (season) holdout at all. Folds are
 * contiguous slices of the input order; callers should pass already-
 * shuffled or otherwise order-independent rows if fold composition
 * shouldn't correlate with row order (this project passes chronological
 * game order, which is fine for CV fold assignment -- CV here picks a
 * regularization CONSTANT, not a time-ordered prediction, so there's no
 * lookahead concern the way there is for the season-level walk-forward).
 */
export function crossValidatedMse(X: Matrix, y: number[], lambda: number, folds = 5): number {
  const n = X.length;
  const foldSize = Math.ceil(n / folds);
  let totalSqError = 0;
  let totalCount = 0;

  for (let f = 0; f < folds; f++) {
    const start = f * foldSize;
    const end = Math.min(start + foldSize, n);
    if (start >= end) continue;

    const trainX: Matrix = [];
    const trainY: number[] = [];
    const testX: Matrix = [];
    const testY: number[] = [];
    for (let i = 0; i < n; i++) {
      if (i >= start && i < end) {
        testX.push(X[i]!);
        testY.push(y[i]!);
      } else {
        trainX.push(X[i]!);
        trainY.push(y[i]!);
      }
    }
    if (trainX.length === 0 || testX.length === 0) continue;

    const fit = ridgeFit(trainX, trainY, lambda);
    const preds = predict(testX, fit);
    for (let i = 0; i < preds.length; i++) {
      const err = preds[i]! - testY[i]!;
      totalSqError += err * err;
      totalCount += 1;
    }
  }

  return totalCount > 0 ? totalSqError / totalCount : Infinity;
}

/** Picks the lambda from lambdaGrid with the lowest k-fold CV MSE. */
export function selectLambda(X: Matrix, y: number[], lambdaGrid: number[], folds = 5): { lambda: number; mse: number }[] {
  return lambdaGrid
    .map((lambda) => ({ lambda, mse: crossValidatedMse(X, y, lambda, folds) }))
    .sort((a, b) => a.mse - b.mse);
}
