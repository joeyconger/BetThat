/**
 * Paired significance test for "does config B's per-game metric differ
 * from config A's, on the SAME games" -- e.g. two backtest runs' CLV on
 * the identical holdout games under different weight configurations. A
 * paired test (not an unpaired two-sample test) is correct here because
 * each game contributes one (a, b) pair rather than two independent
 * samples -- differencing removes cross-game variance (some games are
 * just noisier than others for both configs alike) that would otherwise
 * swamp the signal.
 */
export interface PairedTTestResult {
  n: number;
  meanDiff: number;
  sdDiff: number;
  tStatistic: number;
  /** Two-sided p-value via the normal approximation to the t-distribution -- accurate for n this large (CFB holdout samples run in the hundreds), not intended for small-n exact inference. */
  pValueTwoSided: number;
}

/** Standard normal CDF via Abramowitz & Stegun 7.1.26 (accurate to ~1e-7), used to turn a z/t statistic into a p-value without a dependency. */
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const t = 1 / (1 + p * x);
  const erf = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

/**
 * Paired t-test on two equal-length, index-aligned arrays (b[i] and a[i]
 * must be the SAME underlying unit -- e.g. the same game -- for every i).
 * Positive meanDiff means b tends to exceed a.
 */
export function pairedTTest(a: number[], b: number[]): PairedTTestResult {
  if (a.length !== b.length) throw new Error(`pairedTTest: arrays must be the same length (got ${a.length} and ${b.length})`);
  const n = a.length;
  if (n < 2) throw new Error(`pairedTTest: need at least 2 pairs, got ${n}`);

  const diffs = a.map((v, i) => b[i]! - v);
  const meanDiff = diffs.reduce((s, d) => s + d, 0) / n;
  const variance = diffs.reduce((s, d) => s + (d - meanDiff) ** 2, 0) / (n - 1);
  const sdDiff = Math.sqrt(variance);
  const standardError = sdDiff / Math.sqrt(n);
  const tStatistic = standardError === 0 ? (meanDiff === 0 ? 0 : Infinity * Math.sign(meanDiff)) : meanDiff / standardError;
  const pValueTwoSided = standardError === 0 ? (meanDiff === 0 ? 1 : 0) : 2 * (1 - normalCdf(Math.abs(tStatistic)));

  return { n, meanDiff, sdDiff, tStatistic, pValueTwoSided };
}
