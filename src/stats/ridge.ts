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
 * Variance inflation factor per column: VIF_j = 1/(1 - R^2_j), where R^2_j
 * comes from an UNPENALIZED (lambda=0) OLS fit of column j on every OTHER
 * column. High VIF means column j is well-predicted by some combination
 * of the rest -- i.e. it (and whichever columns predict it) are
 * collinear, so ridge will split credit between them in a way that isn't
 * individually interpretable no matter how much data you have. Pairwise
 * correlation misses this: a set of 3+ columns can be collectively
 * near-degenerate (each one predictable from a COMBINATION of the others)
 * with no single pair correlated enough to look alarming -- VIF (unlike
 * pairwise correlation) catches that because it regresses each column on
 * ALL the others at once, not one at a time.
 *
 * Conventional rule of thumb: VIF > 5 worth a look, VIF > 10 means that
 * column's own coefficient is close to uninterpretable in isolation.
 * Uses lambda=0 deliberately (not the caller's regularization strength)
 * because VIF is a property of the DESIGN MATRIX itself, independent of
 * whatever penalty will later be applied to the actual fit.
 */
export function computeVif(X: Matrix): number[] {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  if (n === 0 || p === 0) return [];

  // A constant (zero-variance) column -- e.g. a missingness indicator
  // that never fires in this sample -- can't meaningfully be "collinear"
  // with anything (VIF=1, matches the target-is-constant case below), but
  // more importantly it must be EXCLUDED from every OTHER column's
  // predictor set: after standardization a constant column becomes all
  // zeros, which makes the unpenalized OLS matrix singular for every
  // column that includes it as a predictor -- silently forcing VIF=Infinity
  // across the WHOLE output, an artifact of this function, not a finding
  // about the real data's collinearity.
  const hasVariance = Array.from({ length: p }, (_, j) => {
    const mean = X.reduce((s, row) => s + row[j]!, 0) / n;
    const variance = X.reduce((s, row) => s + (row[j]! - mean) ** 2, 0) / n;
    return variance > 1e-12;
  });

  return Array.from({ length: p }, (_, j) => {
    if (!hasVariance[j]) return 1; // constant column -- nothing to explain, VIF undefined -> floor
    const target = X.map((row) => row[j]!);
    const otherIdx = Array.from({ length: p }, (_, k) => k).filter((k) => k !== j && hasVariance[k]);
    if (otherIdx.length === 0) return 1; // no other informative column to be collinear with
    const others = X.map((row) => otherIdx.map((k) => row[k]!));

    let fit: RidgeFitResult;
    try {
      fit = ridgeFit(others, target, 0);
    } catch {
      // The OTHER columns are themselves singular/near-perfectly collinear
      // -- an even more extreme case than a high-but-finite VIF. Infinity
      // is the semantically correct answer here, not a fallback: it means
      // this column's own coefficient genuinely cannot be identified from
      // this design matrix.
      return Infinity;
    }
    const preds = predict(others, fit);
    const targetMean = target.reduce((s, v) => s + v, 0) / n;
    const ssRes = preds.reduce((s, p, i) => s + (p - target[i]!) ** 2, 0);
    const ssTot = target.reduce((s, v) => s + (v - targetMean) ** 2, 0);
    if (ssTot < 1e-12) return 1; // column j is constant -- R^2 undefined, not collinear with anything
    const rSquared = 1 - ssRes / ssTot;
    const clampedRSquared = Math.min(rSquared, 1 - 1e-9); // guard against R^2 -> 1 (perfect collinearity) blowing up to Infinity from float noise
    return 1 / (1 - clampedRSquared);
  });
}

/**
 * Assigns each row to a fold index. Without `groups`, folds are contiguous
 * slices of input order (the original behavior -- fine for row-independent
 * data). With `groups`, whole groups are assigned to folds round-robin (by
 * order of first appearance), so every row sharing a group id lands in the
 * SAME fold -- required whenever rows within a group are not independently
 * estimated. jointRefit.ts passes `${season}-${week}` groups because
 * off_adj/def_adj for every game in a given week come from ONE shared
 * iterative opponent-adjustment solve (see ratings/opponentAdjust.ts): two
 * games from the same week are not independent draws, so a random/
 * contiguous split that puts one in train and the other in test lets the
 * test game's evaluation benefit from information (the shared week-level
 * solve) the "held out" split was supposed to withhold.
 */
export function assignFolds(n: number, folds: number, groups?: (string | number)[]): number[] {
  if (!groups) {
    const foldSize = Math.ceil(n / folds);
    return Array.from({ length: n }, (_, i) => Math.floor(i / foldSize));
  }
  const groupToFold = new Map<string | number, number>();
  let nextFold = 0;
  for (const g of groups) {
    if (!groupToFold.has(g)) {
      groupToFold.set(g, nextFold % folds);
      nextFold += 1;
    }
  }
  return groups.map((g) => groupToFold.get(g)!);
}

/**
 * Mean squared error of a candidate lambda via k-fold cross-validation on
 * the training data -- the standard, simple way to pick a regularization
 * strength without touching the real (season) holdout at all. See
 * assignFolds' doc for the optional `groups` param: pass it whenever rows
 * can be non-independent in ways that would let a fold split leak
 * information (e.g. rows computed from a shared per-week solve). Without
 * `groups`, folds are contiguous slices of input order (this project's
 * caller passes chronological order by default, which is fine for CV fold
 * assignment when rows genuinely are independent -- CV here picks a
 * regularization CONSTANT, not a time-ordered prediction, so there's no
 * lookahead concern the way there is for the season-level walk-forward).
 */
export function crossValidatedMse(X: Matrix, y: number[], lambda: number, folds = 5, groups?: (string | number)[]): number {
  const n = X.length;
  const foldOf = assignFolds(n, folds, groups);
  let totalSqError = 0;
  let totalCount = 0;

  for (let f = 0; f < folds; f++) {
    const trainX: Matrix = [];
    const trainY: number[] = [];
    const testX: Matrix = [];
    const testY: number[] = [];
    for (let i = 0; i < n; i++) {
      if (foldOf[i] === f) {
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

/** Picks the lambda from lambdaGrid with the lowest k-fold CV MSE. See crossValidatedMse's doc for `groups`. */
export function selectLambda(X: Matrix, y: number[], lambdaGrid: number[], folds = 5, groups?: (string | number)[]): { lambda: number; mse: number }[] {
  return lambdaGrid
    .map((lambda) => ({ lambda, mse: crossValidatedMse(X, y, lambda, folds, groups) }))
    .sort((a, b) => a.mse - b.mse);
}
