/**
 * Special-teams component for the solve-based rating engine, scoped
 * deliberately narrow per the build spec: kicking-game field position and
 * FG efficiency only. Punt/kickoff return efficiency and anything needing
 * finishing-drives coverage stay out -- not silently dropped, just not
 * verified cleanly enough to build on (same discipline as migration 0011's
 * original special-teams scoping).
 *
 * Both pieces are derived straight from the `plays` table (migration
 * 0012) -- NOT from CFBD's /drives endpoint the old (now-inert)
 * syncSpecialTeamsStats.ts used. That old path averaged starting field
 * position across EVERY drive a team had, which mostly re-measures
 * offense/defense (a dominant defense forces more punts, giving its own
 * offense a short field for reasons that have nothing to do with special
 * teams) -- exactly the double-counting risk the build spec called out.
 *
 * DRIVE CLASSIFICATION (verified against real production data, not
 * assumed -- see the Step 0 report in the conversation this was built
 * from): a drive is "kicking-game-originated" iff either
 *   (a) its own first play (by playNumber) has playType === "Kickoff", or
 *   (b) the immediately preceding drive in the same game (driveNumber - 1)
 *       ended with a "Punt" play.
 * Verified from a real 2024 game's play-by-play: a kickoff-return drive
 * bundles the kick itself (offense = kicking team, one row, yardsGained=0)
 * and the receiving team's subsequent snaps into the SAME driveId --
 * unlike a punt, where the Punt play is the LAST play of the PUNTING
 * team's own drive, and the receiving team's drive starts fresh at the
 * next driveNumber already reflecting the post-return spot. Every other
 * drive start (turnover, downs, half start, each CFB overtime possession
 * -- which by rule starts at the opponent's 25 with no kickoff at all) has
 * neither shape, so this rule naturally and correctly excludes them
 * without any explicit turnover-play-type list.
 *
 * KNOWN LIMITATION, documented rather than silently handled: onside kicks
 * also start with a "Kickoff" play, so they're included in the field-
 * position sample undifferentiated from a normal kickoff. Their field-
 * position distribution is very different (much better for the "receiving"
 * side, who is often the kicking team recovering its own kick) and this
 * pollutes the metric somewhat. Not fixed here -- no reliable field
 * distinguishes an onside kick from a normal one in this data, and onside
 * kicks are rare enough (mostly desperation end-of-game situations, which
 * garbage-time weighting elsewhere in this codebase would suppress if it
 * were applied here -- see the no-weighting note below) that this is a
 * documented, accepted source of noise rather than a blocker.
 *
 * Field position gets the SAME iterative opponent-adjustment treatment as
 * OFF/DEF EPA (reuses computeOpponentAdjustedRatings directly) since it
 * depends heavily on the opponent's own kicking game. FG efficiency does
 * NOT go through the solve -- it's close to a pure team property on a tiny
 * sample (~17-18 attempts/team/season, confirmed against real production
 * data), so it's computed directly and heavily shrunk toward the league
 * mean instead, distance-adjusted since a bucketed empirical make-rate
 * curve is well-supported by the ~7,000 attempts/season(x3) pooled sample.
 *
 * Neither piece is garbage-time weighted (unlike the EPA/success-rate
 * solve components) -- deliberately, to keep this pass's scope tight.
 * Field-position events are per-drive, not per-play, so applying the
 * existing per-play weighting function isn't a direct fit, and FG attempts
 * are already rare enough that down-weighting them further seemed likely
 * to hurt more than help. Worth revisiting if late-game/garbage-time FG
 * attempts or kickoffs turn out to skew the results.
 */

import { computeOpponentAdjustedRatings, type TeamPerformance } from "./opponentAdjust.js";
import { isScrimmagePlay } from "./playSuccess.js";

export interface RawPlayForSpecialTeams {
  gameId: number;
  homeTeamId: number;
  awayTeamId: number;
  offenseTeamId: number | null;
  playType: string;
  driveId: string | null;
  driveNumber: number | null;
  playNumber: number | null;
  yardsToGoal: number | null;
}

/**
 * Builds the field-position TeamPerformance[] input for
 * computeOpponentAdjustedRatings, per this file's header doc. teamId is
 * the RECEIVING team (credited as "offense" the same way EPA's offense is
 * -- a team that consistently gets good field position, whether via its
 * own return skill or the opponent's weak coverage), opponentId is the
 * KICKING team (its "defense" -- a team whose coverage consistently pins
 * opponents deep gets a LOW def rating here, same sign convention as
 * every other off/def pair in this codebase).
 */
export function buildFieldPositionPerformances(plays: RawPlayForSpecialTeams[]): TeamPerformance[] {
  const byGame = new Map<number, RawPlayForSpecialTeams[]>();
  for (const play of plays) {
    let arr = byGame.get(play.gameId);
    if (!arr) {
      arr = [];
      byGame.set(play.gameId, arr);
    }
    arr.push(play);
  }

  const performances: TeamPerformance[] = [];

  for (const gamePlays of byGame.values()) {
    // Never empty by construction -- byGame only ever holds arrays that
    // were pushed to in the same iteration they were created.
    const first = gamePlays[0];
    if (!first) continue;
    const { homeTeamId, awayTeamId } = first;

    const byDrive = new Map<string, RawPlayForSpecialTeams[]>();
    for (const play of gamePlays) {
      if (play.driveId === null) continue;
      let arr = byDrive.get(play.driveId);
      if (!arr) {
        arr = [];
        byDrive.set(play.driveId, arr);
      }
      arr.push(play);
    }

    const drives = [...byDrive.values()]
      .map((drivePlays) => [...drivePlays].sort((a, b) => (a.playNumber ?? 0) - (b.playNumber ?? 0)))
      .filter((drivePlays): drivePlays is RawPlayForSpecialTeams[] & { 0: RawPlayForSpecialTeams } => drivePlays[0]?.driveNumber != null)
      .sort((a, b) => (a[0].driveNumber ?? 0) - (b[0].driveNumber ?? 0));

    for (let i = 0; i < drives.length; i++) {
      const drive = drives[i];
      if (!drive) continue;
      const firstPlay = drive[0];
      const isKickoffFirst = firstPlay.playType === "Kickoff";
      const prevDrive = i > 0 ? drives[i - 1] : undefined;
      const prevLastPlay = prevDrive ? prevDrive[prevDrive.length - 1] : undefined;
      const isPuntPreceded = prevLastPlay?.playType === "Punt";

      if (!isKickoffFirst && !isPuntPreceded) continue;

      // Skip the kickoff play itself (index 0) when the drive starts with
      // one -- the receiving team's real starting spot is the first
      // scrimmage play after it. A punt-preceded drive already starts
      // fresh with the receiving team's own snaps, so start from index 0.
      const searchFrom = isKickoffFirst ? 1 : 0;
      const startPlay = drive.slice(searchFrom).find((p) => isScrimmagePlay(p.playType));
      if (!startPlay || startPlay.yardsToGoal === null || startPlay.offenseTeamId === null) continue;

      const receivingTeamId = startPlay.offenseTeamId;
      const kickingTeamId = receivingTeamId === homeTeamId ? awayTeamId : homeTeamId;
      const fieldPositionScore = 100 - startPlay.yardsToGoal;

      performances.push({ teamId: receivingTeamId, opponentId: kickingTeamId, rawOffenseValue: fieldPositionScore });
    }
  }

  return performances;
}

/** Real-data-confirmed FG play types (see this project's syncSpecialTeamsStats.ts precedent). */
const FG_PLAY_TYPES = new Set(["Field Goal Good", "Field Goal Missed", "Blocked Field Goal"]);

/**
 * Distance buckets for the league-wide expected-make-rate curve. 5-yard
 * bins from ~7,000 pooled attempts/season(x3) give a few hundred to a
 * couple thousand attempts per bucket -- enough to be a real empirical
 * curve rather than a guess, without so many bins the tails go sparse.
 * Distance is derived from yardsToGoal (distance ≈ yardsToGoal + 17, the
 * standard end-zone + snap-distance offset) since CFBD's raw plays don't
 * carry a dedicated FG-distance field.
 */
const FG_DISTANCE_BUCKET_WIDTH = 5;

function fgDistance(yardsToGoal: number): number {
  return yardsToGoal + 17;
}

function fgBucket(distance: number): number {
  return Math.floor(distance / FG_DISTANCE_BUCKET_WIDTH);
}

export interface FgEfficiencyResult {
  attempts: number;
  /**
   * Sum of (actual make - expected make probability) across the team's
   * attempts, shrunk toward 0 via n/(n+fgShrinkK) and expressed as a
   * PER-ATTEMPT rate (not a total) so it doesn't grow with volume -- same
   * "quality, not total" convention as every other rating component here.
   */
  shrunkExcessMakeRate: number;
}

/**
 * FG efficiency, NOT opponent-adjusted (see this file's header doc for
 * why) -- computed directly from the same play set passed to the solve,
 * so it respects whatever as-of-week cut the caller already applied
 * (no separate lookahead risk).
 */
export function computeFgEfficiency(
  plays: RawPlayForSpecialTeams[],
  fgShrinkK: number,
): Map<number, FgEfficiencyResult> {
  const fgPlays = plays.filter((p) => FG_PLAY_TYPES.has(p.playType) && p.offenseTeamId !== null && p.yardsToGoal !== null);

  // League-wide make rate per distance bucket, from this same play set.
  const bucketMakes = new Map<number, number>();
  const bucketAttempts = new Map<number, number>();
  for (const play of fgPlays) {
    const bucket = fgBucket(fgDistance(play.yardsToGoal!));
    bucketAttempts.set(bucket, (bucketAttempts.get(bucket) ?? 0) + 1);
    if (play.playType === "Field Goal Good") {
      bucketMakes.set(bucket, (bucketMakes.get(bucket) ?? 0) + 1);
    }
  }
  const overallMakeRate =
    fgPlays.length === 0 ? 0 : fgPlays.filter((p) => p.playType === "Field Goal Good").length / fgPlays.length;
  function expectedMakeRate(bucket: number): number {
    const attempts = bucketAttempts.get(bucket) ?? 0;
    // A bucket with too few attempts to trust on its own falls back to the
    // overall rate rather than an unstable per-bucket estimate.
    if (attempts < 20) return overallMakeRate;
    return (bucketMakes.get(bucket) ?? 0) / attempts;
  }

  const excessSumByTeam = new Map<number, number>();
  const attemptsByTeam = new Map<number, number>();
  for (const play of fgPlays) {
    const teamId = play.offenseTeamId!;
    const bucket = fgBucket(fgDistance(play.yardsToGoal!));
    const expected = expectedMakeRate(bucket);
    const actual = play.playType === "Field Goal Good" ? 1 : 0;
    excessSumByTeam.set(teamId, (excessSumByTeam.get(teamId) ?? 0) + (actual - expected));
    attemptsByTeam.set(teamId, (attemptsByTeam.get(teamId) ?? 0) + 1);
  }

  const results = new Map<number, FgEfficiencyResult>();
  for (const [teamId, attempts] of attemptsByTeam) {
    const excessSum = excessSumByTeam.get(teamId) ?? 0;
    results.set(teamId, { attempts, shrunkExcessMakeRate: excessSum / (attempts + fgShrinkK) });
  }
  return results;
}

/** Field-position off/def solve, reusing the OFF/DEF EPA machinery on a different raw metric. */
export function computeFieldPositionSolve(plays: RawPlayForSpecialTeams[]): ReturnType<typeof computeOpponentAdjustedRatings> {
  return computeOpponentAdjustedRatings(buildFieldPositionPerformances(plays));
}
