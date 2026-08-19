export interface ClvInput {
  /** The model's own line, anchored to the opening line (see ratings/service.ts's generateBacktestPredictionsForWeek). */
  modelSpreadHome: number;
  openingSpreadHome: number;
  closingSpreadHome: number;
}

export interface ClvResult {
  /** Which side the model's deviation from the opening line favored. */
  pickSide: "home" | "away";
  /** abs(opening - model) — the deviation-from-market quantity the threshold sweep filters on. */
  edgePoints: number;
  /**
   * CLV in points, signed positive = good: betting the model's side at the
   * opening line and having the closing line move further in that side's
   * favor. This is the actual measure of "did the model's deviation from
   * market have signal," independent of whether the bet would have won.
   */
  clv: number;
}

export function computeClv(input: ClvInput): ClvResult {
  const deviation = input.openingSpreadHome - input.modelSpreadHome;
  const pickSide: "home" | "away" = deviation >= 0 ? "home" : "away";
  const edgePoints = Math.abs(deviation);
  const lineMovement = input.openingSpreadHome - input.closingSpreadHome;
  const clv = pickSide === "home" ? lineMovement : -lineMovement;
  return { pickSide, edgePoints, clv };
}

/**
 * Whether the picked side would have covered the CLOSING line given the
 * actual result — a separate question from CLV (which only asks whether
 * the line number moved the model's way, not whether the bet won). Returns
 * null on an exact push.
 */
export function computeCovered(
  pickSide: "home" | "away",
  actualMarginHome: number,
  closingSpreadHome: number,
): boolean | null {
  const homeCoverMargin = actualMarginHome + closingSpreadHome;
  if (homeCoverMargin === 0) return null;
  const homeCovered = homeCoverMargin > 0;
  return pickSide === "home" ? homeCovered : !homeCovered;
}
