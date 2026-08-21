/**
 * Weighted garbage-time function -- replaces CFBD's binary excludeGarbageTime
 * flag with a continuous weight derived from score differential + time
 * remaining, per the user's tier table:
 *
 *   highly competitive  -> weight 1.00
 *   mildly decided      -> weight 0.75
 *   clearly decided      -> weight 0.40
 *   extreme garbage time -> weight 0.10
 *
 * Tiers are assigned by comparing the score margin against a per-tier
 * threshold that itself scales with time remaining: the same margin means
 * less as game time remaining increases (more time to come back), and
 * more as the game nears its end. Thresholds are linear in minutes
 * remaining (baseMargin at 0:00 remaining, + marginPerMinuteRemaining for
 * each additional minute left) and fully configurable -- see
 * DEFAULT_GARBAGE_TIME_CONFIG for the starting values.
 *
 * A future refinement (deferred, see ingest/cfbd/client.ts's
 * getWinProbabilityData doc comment) would use CFBD's actual win
 * probability model instead of a score/time heuristic; this is the
 * score/time-based version the user asked to build now.
 */

export interface GarbageTimeTier {
  baseMargin: number;
  marginPerMinuteRemaining: number;
}

export interface GarbageTimeConfig {
  mildlyDecided: GarbageTimeTier;
  clearlyDecided: GarbageTimeTier;
  extremeGarbageTime: GarbageTimeTier;
  weights: {
    highlyCompetitive: number;
    mildlyDecided: number;
    clearlyDecided: number;
    extremeGarbageTime: number;
  };
}

const SECONDS_PER_QUARTER = 15 * 60;
const REGULATION_QUARTERS = 4;

export const DEFAULT_GARBAGE_TIME_CONFIG: GarbageTimeConfig = {
  mildlyDecided: { baseMargin: 17, marginPerMinuteRemaining: 0.35 },
  clearlyDecided: { baseMargin: 24, marginPerMinuteRemaining: 0.45 },
  extremeGarbageTime: { baseMargin: 33, marginPerMinuteRemaining: 0.55 },
  weights: {
    highlyCompetitive: 1.0,
    mildlyDecided: 0.75,
    clearlyDecided: 0.4,
    extremeGarbageTime: 0.1,
  },
};

function thresholdAt(tier: GarbageTimeTier, secondsRemaining: number): number {
  return tier.baseMargin + tier.marginPerMinuteRemaining * (secondsRemaining / 60);
}

/**
 * Seconds remaining in regulation (period 1-4), counting down to 0 at the
 * final whistle of Q4. Not meaningful for OT (period >= 5) -- callers
 * should special-case OT before calling this.
 */
export function secondsRemainingInRegulation(period: number, clockMinutes: number, clockSeconds: number): number {
  const secondsRemainingInPeriod = clockMinutes * 60 + clockSeconds;
  const fullPeriodsRemainingAfterThis = Math.max(0, REGULATION_QUARTERS - period);
  return secondsRemainingInPeriod + fullPeriodsRemainingAfterThis * SECONDS_PER_QUARTER;
}

/**
 * Missing score/period/clock data returns the "highly competitive" (1.0)
 * weight, not null/excluded -- an unweighted (fully-counted) play is a
 * safer default than silently dropping it, since missing clock data
 * shouldn't systematically bias which plays get excluded.
 */
export function computeGarbageTimeWeight(
  offenseScore: number | null,
  defenseScore: number | null,
  period: number | null,
  clockMinutes: number | null,
  clockSeconds: number | null,
  config: GarbageTimeConfig = DEFAULT_GARBAGE_TIME_CONFIG,
): number {
  if (offenseScore === null || defenseScore === null || period === null) {
    return config.weights.highlyCompetitive;
  }

  if (period > REGULATION_QUARTERS) {
    // Overtime: by definition the score was tied at the end of
    // regulation, so every OT play is treated as fully competitive.
    // (A runaway multi-OT game could theoretically still get lopsided
    // under 2-point-conversion OT rules -- deliberately not modeled here.)
    return config.weights.highlyCompetitive;
  }

  if (clockMinutes === null || clockSeconds === null) {
    return config.weights.highlyCompetitive;
  }

  const margin = Math.abs(offenseScore - defenseScore);
  const secondsRemaining = secondsRemainingInRegulation(period, clockMinutes, clockSeconds);

  if (margin >= thresholdAt(config.extremeGarbageTime, secondsRemaining)) return config.weights.extremeGarbageTime;
  if (margin >= thresholdAt(config.clearlyDecided, secondsRemaining)) return config.weights.clearlyDecided;
  if (margin >= thresholdAt(config.mildlyDecided, secondsRemaining)) return config.weights.mildlyDecided;
  return config.weights.highlyCompetitive;
}
