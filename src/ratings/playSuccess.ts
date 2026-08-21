/**
 * Our own success-rate / situational-split computation from raw stored
 * plays (migration 0012, src/db/migrations/0012_raw_plays.sql) -- replaces
 * reliance on CFBD's pre-aggregated /stats/game/advanced success-rate and
 * standardDowns/passingDowns fields with the user's exact definitions:
 *
 *   - 1st down: success if yardsGained >= 50% of distance
 *   - 2nd down: success if yardsGained >= 70% of distance
 *   - 3rd/4th down: success if yardsGained >= 100% of distance (i.e. a
 *     first down or touchdown)
 *   - Standard downs: 1st down (any distance), 2nd-and-<=7, 3rd/4th-and-<=4
 *   - Passing downs: 2nd-and-8+, 3rd/4th-and-5+
 *
 * Pure functions, no DB/network dependency -- see playSuccess.test.ts.
 */

export interface ScrimmagePlayRow {
  offenseTeamId: number | null;
  defenseTeamId: number | null;
  down: number | null;
  distance: number | null;
  yardsGained: number | null;
  playType: string;
}

/**
 * CFBD's play_type taxonomy for snaps that are actual offensive scrimmage
 * plays (rush/pass attempts, including their touchdown/turnover/sack
 * variants) -- as opposed to special teams plays, penalties, timeouts, and
 * period/game markers, none of which have a meaningful down-and-distance
 * success/failure outcome. Compiled from CFBD's known public play-type
 * taxonomy; NOT yet verified against a real ingested play_type column --
 * this sandbox has no network route to the live CFBD API (see
 * ingest/cfbd/syncRawPlays.ts). Audit this list against production data
 * once cfb-rawplays-ingest has actually run, e.g. via
 * `SELECT DISTINCT play_type FROM plays ORDER BY 1`, and extend it with
 * anything real data shows was missed.
 */
export const SCRIMMAGE_PLAY_TYPES = new Set([
  "Rush",
  "Rushing Touchdown",
  "Pass Reception",
  "Pass Completion",
  "Passing Touchdown",
  "Pass Incompletion",
  "Pass Interception",
  "Pass Interception Return",
  "Interception Return Touchdown",
  "Sack",
  "Fumble Recovery (Own)",
  "Fumble Recovery (Opponent)",
  "Fumble Return Touchdown",
  "Safety",
]);

export function isScrimmagePlay(playType: string): boolean {
  return SCRIMMAGE_PLAY_TYPES.has(playType);
}

export function isStandardDown(down: number | null, distance: number | null): boolean {
  if (down === null || distance === null) return false;
  if (down === 1) return true;
  if (down === 2) return distance <= 7;
  if (down === 3 || down === 4) return distance <= 4;
  return false;
}

export function isPassingDown(down: number | null, distance: number | null): boolean {
  if (down === null || distance === null) return false;
  if (down === 2) return distance >= 8;
  if (down === 3 || down === 4) return distance >= 5;
  return false;
}

/**
 * Returns null when the play can't be judged (missing down/distance/
 * yardsGained, or distance <= 0 -- e.g. a goal-line-adjacent CFBD quirk).
 * Callers must treat null as "exclude from the denominator", not failure.
 */
export function isSuccessfulPlay(
  down: number | null,
  distance: number | null,
  yardsGained: number | null,
): boolean | null {
  if (down === null || distance === null || yardsGained === null || distance <= 0) return null;
  if (down === 1) return yardsGained >= 0.5 * distance;
  if (down === 2) return yardsGained >= 0.7 * distance;
  if (down === 3 || down === 4) return yardsGained >= distance;
  return null;
}

export interface TeamSplitStats {
  successRate: number | null;
  standardDownsSuccessRate: number | null;
  passingDownsSuccessRate: number | null;
  playCount: number;
}

const EMPTY_SPLIT_STATS: TeamSplitStats = {
  successRate: null,
  standardDownsSuccessRate: null,
  passingDownsSuccessRate: null,
  playCount: 0,
};

/**
 * Aggregates success rate + standard/passing-downs splits for one team's
 * one side (offense or defense) across a set of plays -- typically all
 * plays from a single game, but works over any play set (e.g. a full
 * season-to-date for opponent-adjustment purposes).
 */
export function computeTeamSplitStats(
  plays: ScrimmagePlayRow[],
  teamId: number,
  side: "offense" | "defense",
): TeamSplitStats {
  let successCount = 0;
  let totalCount = 0;
  let standardSuccessCount = 0;
  let standardTotalCount = 0;
  let passingSuccessCount = 0;
  let passingTotalCount = 0;

  for (const play of plays) {
    const playTeamId = side === "offense" ? play.offenseTeamId : play.defenseTeamId;
    if (playTeamId !== teamId) continue;
    if (!isScrimmagePlay(play.playType)) continue;

    const success = isSuccessfulPlay(play.down, play.distance, play.yardsGained);
    if (success === null) continue;

    totalCount += 1;
    if (success) successCount += 1;

    if (isStandardDown(play.down, play.distance)) {
      standardTotalCount += 1;
      if (success) standardSuccessCount += 1;
    } else if (isPassingDown(play.down, play.distance)) {
      passingTotalCount += 1;
      if (success) passingSuccessCount += 1;
    }
  }

  if (totalCount === 0) return EMPTY_SPLIT_STATS;

  return {
    successRate: successCount / totalCount,
    standardDownsSuccessRate: standardTotalCount > 0 ? standardSuccessCount / standardTotalCount : null,
    passingDownsSuccessRate: passingTotalCount > 0 ? passingSuccessCount / passingTotalCount : null,
    playCount: totalCount,
  };
}
