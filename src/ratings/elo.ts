import type { RatingParams } from "./config.js";

export interface GameForRating {
  gameId: number;
  week: number;
  homeTeamId: number;
  awayTeamId: number;
  homeOffEpa: number;
  homeDefEpa: number;
  awayOffEpa: number;
  awayDefEpa: number;
  /**
   * Success rate (0-1 scale) alongside EPA — only used when
   * params.successRateWeight > 0 (see RatingParams doc), and only when all
   * four are present for a given game; missing any one silently falls back
   * to pure-EPA for that game rather than guessing, same as EPA itself
   * being required for a game to be included at all (see
   * getSeasonGamesForRating).
   */
  homeOffSuccess?: number | null;
  homeDefSuccess?: number | null;
  awayOffSuccess?: number | null;
  awayDefSuccess?: number | null;
  /**
   * Garbage-time-excluded EPA/success rate, from a second CFBD ingestion
   * pass (excludeGarbageTime=true) — only used when
   * params.excludeGarbageTime is true (see RatingParams doc), and only for
   * whichever of these four is actually present; a game missing one falls
   * back to that game's regular all-plays value rather than being dropped,
   * same "degrade to the broader signal, don't discard the game"
   * philosophy as the success-rate fields above.
   */
  homeOffEpaNoGarbage?: number | null;
  homeDefEpaNoGarbage?: number | null;
  awayOffEpaNoGarbage?: number | null;
  awayDefEpaNoGarbage?: number | null;
  homeOffSuccessNoGarbage?: number | null;
  homeDefSuccessNoGarbage?: number | null;
  awayOffSuccessNoGarbage?: number | null;
  awayDefSuccessNoGarbage?: number | null;
  /**
   * Total offensive/defensive plays each side's EPA average was computed
   * over (from CFBD's /stats/game/advanced, the same source as
   * homeOffEpa/etc.) — the reweighting denominator for
   * params.turnoverLuckWeight (see RatingParams doc and
   * blendTurnoverStrip below). Only used when turnoverLuckWeight > 0.
   */
  homeOffPlays?: number | null;
  homeDefPlays?: number | null;
  awayOffPlays?: number | null;
  awayDefPlays?: number | null;
  /**
   * Turnover-play PPA sums + counts, from a separate CFBD /plays ingestion
   * pass (see ingest/cfbd/syncTurnoverStats.ts) — only used when
   * params.turnoverLuckWeight > 0, and only per-field where actually
   * present; missing any one falls back to that field's raw (un-stripped)
   * EPA, same degrade-don't-guess pattern as the garbage-time fields above.
   */
  homeOffTurnoverPpaSum?: number | null;
  homeOffTurnoverPlays?: number | null;
  homeDefTurnoverPpaSum?: number | null;
  homeDefTurnoverPlays?: number | null;
  awayOffTurnoverPpaSum?: number | null;
  awayOffTurnoverPlays?: number | null;
  awayDefTurnoverPpaSum?: number | null;
  awayDefTurnoverPlays?: number | null;
  /**
   * Explosiveness and down/distance splits, from the same CFBD advanced-
   * stats response as EPA/success rate — only used when the corresponding
   * params.pointsPer* is nonzero, and only when all four of a given
   * metric's fields are present for a game; missing any one falls back to
   * a no-op for that metric on that game, same degrade-don't-guess
   * pattern as every other optional signal here.
   */
  homeOffExplosiveness?: number | null;
  homeDefExplosiveness?: number | null;
  awayOffExplosiveness?: number | null;
  awayDefExplosiveness?: number | null;
  homeOffStandardDownsSuccessRate?: number | null;
  homeDefStandardDownsSuccessRate?: number | null;
  awayOffStandardDownsSuccessRate?: number | null;
  awayDefStandardDownsSuccessRate?: number | null;
  homeOffPassingDownsSuccessRate?: number | null;
  homeDefPassingDownsSuccessRate?: number | null;
  awayOffPassingDownsSuccessRate?: number | null;
  awayDefPassingDownsSuccessRate?: number | null;
  /**
   * Sack rate, from a separate CFBD /plays ingestion pass (see
   * ingest/cfbd/syncSackRateStats.ts) — INVERTED off/def sign convention
   * from every other pair here (off_sack_rate is bad for the team that
   * has it, def_sack_rate is good — see RatingParams.pointsPerSackRate's
   * doc). Only used when params.pointsPerSackRate is nonzero and all four
   * fields are present.
   */
  homeOffSackRate?: number | null;
  homeDefSackRate?: number | null;
  awayOffSackRate?: number | null;
  awayDefSackRate?: number | null;
  /**
   * "Finishing drives" (points per scoring opportunity), from a separate
   * CFBD /drives ingestion pass (see
   * ingest/cfbd/syncFinishingDrivesStats.ts). Standard off/def sign
   * convention (higher off = better, higher def = worse), unlike sack
   * rate. Only used when params.pointsPerFinishingDrives is nonzero and
   * all four fields are present — also legitimately absent for a game
   * where a team had zero scoring opportunities, not just where
   * ingestion hasn't run.
   */
  homeOffFinishingDrivesPpo?: number | null;
  homeDefFinishingDrivesPpo?: number | null;
  awayOffFinishingDrivesPpo?: number | null;
  awayDefFinishingDrivesPpo?: number | null;
  /**
   * Special teams: field position + FG make rate, from a combined /drives
   * + /plays ingestion pass (see ingest/cfbd/syncSpecialTeamsStats.ts).
   * Standard off/def sign convention for both. Only used when the
   * corresponding params.pointsPer* is nonzero and all four of that
   * metric's fields are present.
   */
  homeOffFieldPosition?: number | null;
  homeDefFieldPosition?: number | null;
  awayOffFieldPosition?: number | null;
  awayDefFieldPosition?: number | null;
  homeOffFgMakeRate?: number | null;
  homeDefFgMakeRate?: number | null;
  awayOffFgMakeRate?: number | null;
  awayDefFgMakeRate?: number | null;
  /**
   * Real iterative opponent-adjustment (ratings/opponentAdjust.ts), from
   * ingest/cfbd/syncOpponentAdjustedStats.ts. Standard off/def sign
   * convention. Unlike every other component here, these are already
   * opponent-adjusted AS OF this game's week -- that adjustment happens
   * upstream (a fresh solve per week over prior weeks only), not in this
   * additive term, which just diffs the two teams' pre-computed values
   * the same way every other pointsPerX term does.
   */
  homeOffAdj?: number | null;
  homeDefAdj?: number | null;
  awayOffAdj?: number | null;
  awayDefAdj?: number | null;
  /** How much prior-week data each side's off_adj/def_adj was computed from -- see RatingParams.opponentAdjShrinkageK's doc. */
  homeAdjGamesPlayed?: number | null;
  awayAdjGamesPlayed?: number | null;
}

export interface TeamRatingState {
  rating: number;
  gamesPlayed: number;
}

/**
 * Incremental, EPA-driven Elo-like rating system. Unlike a classic Elo
 * (updated from win/loss or final score margin), the "ground truth" each
 * game feeds in is that game's net EPA/play differential — offense minus
 * defense for each side, converted to a point-margin equivalent — since
 * the spec calls for updating from EPA/success-rate form, not the scoreboard.
 *
 * SOS shows up here directly: each team's rating movement is scaled by how
 * strong their opponent's rating already is (sosWeight, higher for CFB),
 * so beating a good team moves the rating more than beating a bad one —
 * the standard way Elo-family systems encode strength of schedule.
 *
 * This is a single incremental pass through the season in week order, not
 * a fully converged iterative solve (early-week opponent ratings are still
 * close to their preseason prior) — a reasonable v1 scope, and one Phase 3
 * can compare against a multi-pass version if the single pass underperforms.
 */
/** Running per-team success-rate context (achieved on offense, allowed on defense) — the opponentAdjustWeight input. Season-to-date only, updated after each game so a team's own upcoming game is never included in its opponents' context. */
interface SuccessRateContext {
  offSum: number;
  offN: number;
  defSum: number;
  defN: number;
}

/** A team's own success-rate sample needs at least this many games before its season-to-date average is trusted as an opponent-quality signal — below it, opponentAdjustWeight has no effect for games against that team (falls back to raw, unadjusted success rate), same as the whole codebase's "degrade to the broader signal rather than guess off a tiny sample" rule. */
const MIN_SUCCESS_CONTEXT_GAMES = 3;

/**
 * Strips turnover-play PPA out of a raw EPA/play average via a true
 * reweighted mean, then blends the result back with the raw value by
 * `weight` — see RatingParams.turnoverLuckWeight's doc for why this is NOT
 * a flat subtraction of turnoverPpaSum from rawEpa (that would ignore the
 * play-count reweighting a correct trimmed average requires). Falls back
 * to the raw value untouched if any input is missing (that specific
 * field's turnover stats not yet ingested) or the reweighting denominator
 * (plays remaining after removing turnover plays) would be non-positive.
 */
export function blendTurnoverStrip(
  rawEpa: number,
  totalPlays: number | null | undefined,
  turnoverPpaSum: number | null | undefined,
  turnoverPlays: number | null | undefined,
  weight: number,
): number {
  if (
    totalPlays === null ||
    totalPlays === undefined ||
    turnoverPpaSum === null ||
    turnoverPpaSum === undefined ||
    turnoverPlays === null ||
    turnoverPlays === undefined ||
    totalPlays - turnoverPlays <= 0
  ) {
    return rawEpa;
  }
  const strippedEpa = (rawEpa * totalPlays - turnoverPpaSum) / (totalPlays - turnoverPlays);
  return (1 - weight) * rawEpa + weight * strippedEpa;
}

export function computeSeasonRatings(
  games: GameForRating[],
  initialRatings: Map<number, number>,
  params: RatingParams,
): Map<number, TeamRatingState> {
  const state = new Map<number, TeamRatingState>();
  for (const [teamId, rating] of initialRatings) {
    state.set(teamId, { rating, gamesPlayed: 0 });
  }

  const successCtx = new Map<number, SuccessRateContext>();
  let leagueSuccessSum = 0;
  let leagueSuccessN = 0;
  function getSuccessCtx(teamId: number): SuccessRateContext {
    return successCtx.get(teamId) ?? { offSum: 0, offN: 0, defSum: 0, defN: 0 };
  }
  /** Opponent-adjusts a raw success rate against the opponent's season-to-date tendency on the OTHER side of the ball — a defense's raw allowed-rate for offense adjustment, an offense's raw generated-rate for defense adjustment. Both directions use the identical "add (league avg - opponent's avg)" shape; see RatingParams.opponentAdjustWeight's doc for why the sign is the same for both. Returns the raw value unadjusted if the opponent doesn't have enough of a sample yet. */
  function opponentAdjust(raw: number, opponentCtxSum: number, opponentCtxN: number): number {
    if (params.opponentAdjustWeight === 0 || opponentCtxN < MIN_SUCCESS_CONTEXT_GAMES || leagueSuccessN === 0) {
      return raw;
    }
    const leagueAvg = leagueSuccessSum / leagueSuccessN;
    const opponentAvg = opponentCtxSum / opponentCtxN;
    return raw + params.opponentAdjustWeight * (leagueAvg - opponentAvg);
  }

  const sorted = [...games].sort((a, b) => a.week - b.week || a.gameId - b.gameId);

  for (const game of sorted) {
    const home = state.get(game.homeTeamId) ?? { rating: 0, gamesPlayed: 0 };
    const away = state.get(game.awayTeamId) ?? { rating: 0, gamesPlayed: 0 };

    // Prefer garbage-time-excluded EPA/success rate when params.excludeGarbageTime
    // is set and that game actually has it ingested -- falls back to the
    // regular all-plays value per-field otherwise, same degrade-don't-drop
    // philosophy as the success-rate fallback below. A game with NEITHER
    // (excludeGarbageTime off, or no-garbage data not yet ingested) is
    // bit-for-bit the pre-existing behavior.
    const useNoGarbage = params.excludeGarbageTime;
    const homeOffEpa = (useNoGarbage ? game.homeOffEpaNoGarbage : null) ?? game.homeOffEpa;
    const homeDefEpa = (useNoGarbage ? game.homeDefEpaNoGarbage : null) ?? game.homeDefEpa;
    const awayOffEpa = (useNoGarbage ? game.awayOffEpaNoGarbage : null) ?? game.awayOffEpa;
    const awayDefEpa = (useNoGarbage ? game.awayDefEpaNoGarbage : null) ?? game.awayDefEpa;
    const homeOffSuccess = (useNoGarbage ? game.homeOffSuccessNoGarbage : undefined) ?? game.homeOffSuccess;
    const homeDefSuccess = (useNoGarbage ? game.homeDefSuccessNoGarbage : undefined) ?? game.homeDefSuccess;
    const awayOffSuccess = (useNoGarbage ? game.awayOffSuccessNoGarbage : undefined) ?? game.awayOffSuccess;
    const awayDefSuccess = (useNoGarbage ? game.awayDefSuccessNoGarbage : undefined) ?? game.awayDefSuccess;

    // Explosiveness / down-distance splits / sack rate -- no garbage-time
    // variant exists for any of these (unlike EPA/success rate above), so
    // these are read directly off the game object, no useNoGarbage branch.
    const homeOffExplosiveness = game.homeOffExplosiveness;
    const homeDefExplosiveness = game.homeDefExplosiveness;
    const awayOffExplosiveness = game.awayOffExplosiveness;
    const awayDefExplosiveness = game.awayDefExplosiveness;
    const haveAllFourExplosiveness =
      homeOffExplosiveness != null && homeDefExplosiveness != null && awayOffExplosiveness != null && awayDefExplosiveness != null;

    const homeOffStandardDownsSuccessRate = game.homeOffStandardDownsSuccessRate;
    const homeDefStandardDownsSuccessRate = game.homeDefStandardDownsSuccessRate;
    const awayOffStandardDownsSuccessRate = game.awayOffStandardDownsSuccessRate;
    const awayDefStandardDownsSuccessRate = game.awayDefStandardDownsSuccessRate;
    const haveAllFourStandardDowns =
      homeOffStandardDownsSuccessRate != null &&
      homeDefStandardDownsSuccessRate != null &&
      awayOffStandardDownsSuccessRate != null &&
      awayDefStandardDownsSuccessRate != null;

    const homeOffPassingDownsSuccessRate = game.homeOffPassingDownsSuccessRate;
    const homeDefPassingDownsSuccessRate = game.homeDefPassingDownsSuccessRate;
    const awayOffPassingDownsSuccessRate = game.awayOffPassingDownsSuccessRate;
    const awayDefPassingDownsSuccessRate = game.awayDefPassingDownsSuccessRate;
    const haveAllFourPassingDowns =
      homeOffPassingDownsSuccessRate != null &&
      homeDefPassingDownsSuccessRate != null &&
      awayOffPassingDownsSuccessRate != null &&
      awayDefPassingDownsSuccessRate != null;

    const homeOffSackRate = game.homeOffSackRate;
    const homeDefSackRate = game.homeDefSackRate;
    const awayOffSackRate = game.awayOffSackRate;
    const awayDefSackRate = game.awayDefSackRate;
    const haveAllFourSackRate = homeOffSackRate != null && homeDefSackRate != null && awayOffSackRate != null && awayDefSackRate != null;

    const homeOffFinishingDrivesPpo = game.homeOffFinishingDrivesPpo;
    const homeDefFinishingDrivesPpo = game.homeDefFinishingDrivesPpo;
    const awayOffFinishingDrivesPpo = game.awayOffFinishingDrivesPpo;
    const awayDefFinishingDrivesPpo = game.awayDefFinishingDrivesPpo;
    const haveAllFourFinishingDrives =
      homeOffFinishingDrivesPpo != null &&
      homeDefFinishingDrivesPpo != null &&
      awayOffFinishingDrivesPpo != null &&
      awayDefFinishingDrivesPpo != null;

    const homeOffFieldPosition = game.homeOffFieldPosition;
    const homeDefFieldPosition = game.homeDefFieldPosition;
    const awayOffFieldPosition = game.awayOffFieldPosition;
    const awayDefFieldPosition = game.awayDefFieldPosition;
    const haveAllFourFieldPosition =
      homeOffFieldPosition != null && homeDefFieldPosition != null && awayOffFieldPosition != null && awayDefFieldPosition != null;

    const homeOffFgMakeRate = game.homeOffFgMakeRate;
    const homeDefFgMakeRate = game.homeDefFgMakeRate;
    const awayOffFgMakeRate = game.awayOffFgMakeRate;
    const awayDefFgMakeRate = game.awayDefFgMakeRate;
    const haveAllFourFgMakeRate =
      homeOffFgMakeRate != null && homeDefFgMakeRate != null && awayOffFgMakeRate != null && awayDefFgMakeRate != null;

    const homeOffAdj = game.homeOffAdj;
    const homeDefAdj = game.homeDefAdj;
    const awayOffAdj = game.awayOffAdj;
    const awayDefAdj = game.awayDefAdj;
    const homeAdjGamesPlayed = game.homeAdjGamesPlayed;
    const awayAdjGamesPlayed = game.awayAdjGamesPlayed;
    // gamesPlayed is required alongside the off/def values themselves (not
    // just the 4 raw values) -- see RatingParams.opponentAdjShrinkageK's
    // doc: without knowing how much prior-week data produced a given
    // off_adj/def_adj, there's no sound way to shrink it, so a game
    // missing either count degrades the same way as missing the raw
    // values entirely, rather than silently using them unshrunk.
    const haveAllFourAdj =
      homeOffAdj != null &&
      homeDefAdj != null &&
      awayOffAdj != null &&
      awayDefAdj != null &&
      homeAdjGamesPlayed != null &&
      awayAdjGamesPlayed != null;

    // Turnover-luck-stripped EPA -- see RatingParams.turnoverLuckWeight's
    // doc. Applied AFTER the garbage-time resolution above, on top of
    // whichever EPA source (raw or no-garbage) was just selected, always
    // against the ALL-PLAYS play count (there's no separate no-garbage
    // play count column, so combining both toggles is approximate — see
    // blendTurnoverStrip's doc). turnoverLuckWeight === 0 (today's
    // default) makes this a no-op, so existing behavior is untouched
    // bit-for-bit.
    const strippedHomeOffEpa =
      params.turnoverLuckWeight > 0
        ? blendTurnoverStrip(homeOffEpa, game.homeOffPlays, game.homeOffTurnoverPpaSum, game.homeOffTurnoverPlays, params.turnoverLuckWeight)
        : homeOffEpa;
    const strippedHomeDefEpa =
      params.turnoverLuckWeight > 0
        ? blendTurnoverStrip(homeDefEpa, game.homeDefPlays, game.homeDefTurnoverPpaSum, game.homeDefTurnoverPlays, params.turnoverLuckWeight)
        : homeDefEpa;
    const strippedAwayOffEpa =
      params.turnoverLuckWeight > 0
        ? blendTurnoverStrip(awayOffEpa, game.awayOffPlays, game.awayOffTurnoverPpaSum, game.awayOffTurnoverPlays, params.turnoverLuckWeight)
        : awayOffEpa;
    const strippedAwayDefEpa =
      params.turnoverLuckWeight > 0
        ? blendTurnoverStrip(awayDefEpa, game.awayDefPlays, game.awayDefTurnoverPpaSum, game.awayDefTurnoverPlays, params.turnoverLuckWeight)
        : awayDefEpa;

    const predictedMargin = home.rating - away.rating + params.homeFieldAdvantage;
    const homeNetEpa = strippedHomeOffEpa - strippedHomeDefEpa;
    const awayNetEpa = strippedAwayOffEpa - strippedAwayDefEpa;
    const epaMargin = params.pointsPerEpa * (homeNetEpa - awayNetEpa);

    const homeCtx = getSuccessCtx(game.homeTeamId);
    const awayCtx = getSuccessCtx(game.awayTeamId);
    const haveAllFourSuccess =
      homeOffSuccess !== undefined &&
      homeOffSuccess !== null &&
      homeDefSuccess !== undefined &&
      homeDefSuccess !== null &&
      awayOffSuccess !== undefined &&
      awayOffSuccess !== null &&
      awayDefSuccess !== undefined &&
      awayDefSuccess !== null;

    // Opponent-adjusts success rate against the opponent's season-to-date
    // tendency on the other side of the ball, BEFORE it feeds the
    // successRateWeight blend below — see RatingParams.opponentAdjustWeight's
    // doc. opponentAdjustWeight === 0 (today's default) makes opponentAdjust
    // a no-op passthrough, so this is bit-for-bit the pre-existing behavior
    // until swept on.
    const adjHomeOffSuccess = haveAllFourSuccess ? opponentAdjust(homeOffSuccess!, awayCtx.defSum, awayCtx.defN) : homeOffSuccess;
    const adjAwayOffSuccess = haveAllFourSuccess ? opponentAdjust(awayOffSuccess!, homeCtx.defSum, homeCtx.defN) : awayOffSuccess;
    const adjHomeDefSuccess = haveAllFourSuccess ? opponentAdjust(homeDefSuccess!, awayCtx.offSum, awayCtx.offN) : homeDefSuccess;
    const adjAwayDefSuccess = haveAllFourSuccess ? opponentAdjust(awayDefSuccess!, homeCtx.offSum, homeCtx.offN) : awayDefSuccess;

    // Blends in success rate as a second "how the game went" signal,
    // alongside EPA — see RatingParams.successRateWeight's doc for why.
    // successRateWeight === 0 (today's default) skips this block entirely,
    // so existing behavior is untouched bit-for-bit.
    let actualMargin = epaMargin;
    if (params.successRateWeight > 0 && haveAllFourSuccess) {
      const homeNetSuccess = adjHomeOffSuccess! - adjHomeDefSuccess!;
      const awayNetSuccess = adjAwayOffSuccess! - adjAwayDefSuccess!;
      const successMargin = params.pointsPerSuccessRate * (homeNetSuccess - awayNetSuccess);
      actualMargin = (1 - params.successRateWeight) * epaMargin + params.successRateWeight * successMargin;
    }

    // Explosiveness, down/distance splits, and sack rate -- each an
    // independent ADDITIVE term on top of the epaMargin/successRateWeight
    // blend above, not a replacement for it (distinct from successRateWeight,
    // which interpolates between two competing interpretations of the SAME
    // signal). Each is a no-op unless its own points-per-* param is nonzero
    // AND all four of that metric's fields are present for this game --
    // same degrade-don't-guess pattern as every other optional signal.
    if (params.pointsPerExplosiveness !== 0 && haveAllFourExplosiveness) {
      const homeNetExpl = homeOffExplosiveness! - homeDefExplosiveness!;
      const awayNetExpl = awayOffExplosiveness! - awayDefExplosiveness!;
      actualMargin += params.pointsPerExplosiveness * (homeNetExpl - awayNetExpl);
    }
    if (params.pointsPerStandardDownsSplit !== 0 && haveAllFourStandardDowns) {
      const homeNetStd = homeOffStandardDownsSuccessRate! - homeDefStandardDownsSuccessRate!;
      const awayNetStd = awayOffStandardDownsSuccessRate! - awayDefStandardDownsSuccessRate!;
      actualMargin += params.pointsPerStandardDownsSplit * (homeNetStd - awayNetStd);
    }
    if (params.pointsPerPassingDownsSplit !== 0 && haveAllFourPassingDowns) {
      const homeNetPass = homeOffPassingDownsSuccessRate! - homeDefPassingDownsSuccessRate!;
      const awayNetPass = awayOffPassingDownsSuccessRate! - awayDefPassingDownsSuccessRate!;
      actualMargin += params.pointsPerPassingDownsSplit * (homeNetPass - awayNetPass);
    }
    if (params.pointsPerSackRate !== 0 && haveAllFourSackRate) {
      // INVERTED off/def convention -- def_sack_rate (forcing sacks) is
      // good, off_sack_rate (getting sacked) is bad, so the "net advantage"
      // is def MINUS off, not off MINUS def like every other metric here.
      const homeNetSack = homeDefSackRate! - homeOffSackRate!;
      const awayNetSack = awayDefSackRate! - awayOffSackRate!;
      actualMargin += params.pointsPerSackRate * (homeNetSack - awayNetSack);
    }
    if (params.pointsPerFinishingDrives !== 0 && haveAllFourFinishingDrives) {
      const homeNetFinishing = homeOffFinishingDrivesPpo! - homeDefFinishingDrivesPpo!;
      const awayNetFinishing = awayOffFinishingDrivesPpo! - awayDefFinishingDrivesPpo!;
      actualMargin += params.pointsPerFinishingDrives * (homeNetFinishing - awayNetFinishing);
    }
    if (params.pointsPerFieldPosition !== 0 && haveAllFourFieldPosition) {
      const homeNetFieldPosition = homeOffFieldPosition! - homeDefFieldPosition!;
      const awayNetFieldPosition = awayOffFieldPosition! - awayDefFieldPosition!;
      actualMargin += params.pointsPerFieldPosition * (homeNetFieldPosition - awayNetFieldPosition);
    }
    if (params.pointsPerFgMakeRate !== 0 && haveAllFourFgMakeRate) {
      const homeNetFg = homeOffFgMakeRate! - homeDefFgMakeRate!;
      const awayNetFg = awayOffFgMakeRate! - awayDefFgMakeRate!;
      actualMargin += params.pointsPerFgMakeRate * (homeNetFg - awayNetFg);
    }
    if (params.pointsPerOpponentAdj !== 0 && haveAllFourAdj) {
      // Games-played shrinkage: an off_adj/def_adj computed from a
      // thin sample (a team's week-2 value, from just 1 prior game) is
      // far noisier than one from a deep sample (week 12, 11 prior
      // games), but without this, both entered the update at full
      // strength -- see RatingParams.opponentAdjShrinkageK's doc. Shrinks
      // each side's own off_adj/def_adj toward 0 (league average) by
      // gamesPlayed/(gamesPlayed+k) BEFORE computing the net differential.
      const homeShrink = homeAdjGamesPlayed! / (homeAdjGamesPlayed! + params.opponentAdjShrinkageK);
      const awayShrink = awayAdjGamesPlayed! / (awayAdjGamesPlayed! + params.opponentAdjShrinkageK);
      const homeNetAdj = homeOffAdj! * homeShrink - homeDefAdj! * homeShrink;
      const awayNetAdj = awayOffAdj! * awayShrink - awayDefAdj! * awayShrink;
      actualMargin += params.pointsPerOpponentAdj * (homeNetAdj - awayNetAdj);
    }

    const error = actualMargin - predictedMargin;

    // Update each team's success-rate context with this game's RAW (not
    // opponent-adjusted) achieved/allowed rates, so a team's own context is
    // always measured on the same unadjusted basis regardless of who they
    // played -- adjusting it recursively against ITS OWN opponents would
    // make the whole system's reference frame drift game to game.
    if (haveAllFourSuccess) {
      successCtx.set(game.homeTeamId, {
        offSum: homeCtx.offSum + homeOffSuccess!,
        offN: homeCtx.offN + 1,
        defSum: homeCtx.defSum + homeDefSuccess!,
        defN: homeCtx.defN + 1,
      });
      successCtx.set(game.awayTeamId, {
        offSum: awayCtx.offSum + awayOffSuccess!,
        offN: awayCtx.offN + 1,
        defSum: awayCtx.defSum + awayDefSuccess!,
        defN: awayCtx.defN + 1,
      });
      leagueSuccessSum += homeOffSuccess! + homeDefSuccess! + awayOffSuccess! + awayDefSuccess!;
      leagueSuccessN += 4;
    }

    const homeSosMultiplier = Math.min(
      params.maxSosMultiplier,
      Math.max(params.minSosMultiplier, 1 + params.sosWeight * (away.rating / params.ratingScaleRef)),
    );
    const awaySosMultiplier = Math.min(
      params.maxSosMultiplier,
      Math.max(params.minSosMultiplier, 1 + params.sosWeight * (home.rating / params.ratingScaleRef)),
    );

    state.set(game.homeTeamId, {
      rating: home.rating + params.baseK * error * homeSosMultiplier,
      gamesPlayed: home.gamesPlayed + 1,
    });
    state.set(game.awayTeamId, {
      rating: away.rating - params.baseK * error * awaySosMultiplier,
      gamesPlayed: away.gamesPlayed + 1,
    });
  }

  return state;
}

/** Regresses a prior season's final rating toward league-average (0) for the new season's starting point. */
export function carryoverRating(priorRating: number, params: RatingParams): number {
  return priorRating * params.seasonCarryover;
}

/**
 * Blends this model's own carried-over rating with the prior season's final
 * CFBD SP+ rating (see ingest/cfbd/client.ts's getSpRatings doc) to seed a
 * new season's starting point — an externally-computed, informed number
 * instead of just regressing our own model's prior guess toward 0. Falls
 * back to whichever single source is available if only one is, and to 0
 * (this project's existing default for a team with no history at all) if
 * neither is.
 */
export function computeInitialRating(
  priorEloRating: number | undefined,
  priorSpRating: number | undefined,
  params: RatingParams,
): number {
  if (priorSpRating === undefined) {
    return priorEloRating !== undefined ? carryoverRating(priorEloRating, params) : 0;
  }
  // Missing carryover (e.g. the first season in a backtest range, where no
  // prior-season rating was ever computed) blends against league-average
  // (0), not straight to priorSpRating — otherwise spPriorWeight=0 would
  // still inject full-strength SP+ whenever carryover happens to be
  // missing, silently ignoring the weight the caller asked for.
  const carryover = priorEloRating !== undefined ? carryoverRating(priorEloRating, params) : 0;
  return (1 - params.spPriorWeight) * carryover + params.spPriorWeight * priorSpRating;
}

/** Standard z-score: how many standard deviations `value` is from the mean of `population`. 0 if the population has no spread. */
export function zScore(value: number, population: number[]): number {
  const n = population.length;
  const mean = population.reduce((sum, v) => sum + v, 0) / n;
  const variance = population.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  return sd === 0 ? 0 : (value - mean) / sd;
}

export interface PredictionInput {
  homeRating: number;
  awayRating: number;
  homeGamesPlayed: number;
  awayGamesPlayed: number;
  marketSpreadHome: number | null;
  /**
   * z-scores of each team's CFBD Elo rating against that week's full FBS
   * distribution (see ratings/service.ts) — scale-invariant on purpose,
   * since CFBD's own Elo scale isn't documented and guessing a conversion
   * factor to points would be an unverified assumption baked into the
   * model. Undefined when no CFBD Elo data exists for that team/week (e.g.
   * NFL, which CFBD doesn't cover, or an early-season week with too few
   * teams rated yet).
   */
  homeEloZ?: number;
  awayEloZ?: number;
  /**
   * z-scores of each team's prior-season CFBD SP+ (overall) against that
   * prior season's full FBS distribution — see ratings/service.ts and
   * RatingParams.spSignalPoints' doc for why this is a distinct lever from
   * spPriorWeight, not the same one reused. Prior season only (SP+ has no
   * in-season week granularity — see ingest/cfbd/client.ts's getSpRatings
   * doc), so this is constant across a whole season for a given team,
   * unlike homeEloZ/awayEloZ which update weekly. Undefined when no SP+
   * data exists for that team (e.g. NFL, or a team's first FBS season).
   */
  homeSpZ?: number;
  awaySpZ?: number;
  /**
   * z-scores of each team's REAL week-by-week SP+ (not CFBD's frozen
   * season-final value — see RatingParams.weeklySpSignalPoints' doc)
   * against that week's full FBS distribution — see ratings/service.ts.
   * Undefined when no manual archive data exists for that team/week
   * (currently: any season other than 2025, or week 0/16+).
   */
  homeWeeklySpZ?: number;
  awayWeeklySpZ?: number;
  /**
   * (home team's days since their prior game) - (away team's days since
   * theirs), from db/repo.ts's getGamesForWeek — a real, well-documented
   * rest-advantage effect (extra rest, especially a bye week, is a genuine
   * predictive edge) that nothing in this model used before. Undefined/
   * null (both treated the same, see params.pointsPerRestDay's doc) when
   * either team has no prior game this season yet — falls back to no
   * adjustment rather than guessing which side is "more rested" off
   * incomplete data.
   */
  restDaysDiff?: number | null;
}

export interface Prediction {
  /** This model's own line, before any market blend — negative = home favored. */
  eloSpreadHome: number;
  /** The reported line: a confidence-weighted blend of the model's own line and the current market line. */
  modelSpreadHome: number;
  /** Points of estimated uncertainty in modelSpreadHome. */
  confidence: number;
  /** How much weight modelSpreadHome put on the model's own number vs. the market (0 = pure market, 1 = pure model). */
  modelWeight: number;
}

/**
 * Converts ratings into a market-anchored spread. This is the mechanism
 * behind "anchor to market rather than build an independent power
 * ranking": early in a season (few games played), modelWeight is small and
 * the output stays close to the market line; as more games accumulate,
 * the model's own signal gets more say. With no market line available at
 * all, the model falls back to its own number outright (and the caller
 * should treat that prediction as lower-confidence / unanchored).
 */
export function predictSpread(input: PredictionInput, params: RatingParams): Prediction {
  const eloSignal = params.eloSignalPoints * ((input.homeEloZ ?? 0) - (input.awayEloZ ?? 0));
  const spSignal = params.spSignalPoints * ((input.homeSpZ ?? 0) - (input.awaySpZ ?? 0));
  const weeklySpSignal = params.weeklySpSignalPoints * ((input.homeWeeklySpZ ?? 0) - (input.awayWeeklySpZ ?? 0));
  // ?? 0 on the WHOLE differential (not each side separately, unlike
  // homeEloZ/awaySpZ above) -- restDaysDiff is already a single combined
  // number, and defaulting a missing differential to 0 means "no rest
  // advantage either way," not "assume 0 days rest," which is the correct
  // neutral fallback rather than reading as maximally fatigued.
  const restSignal = params.pointsPerRestDay * (input.restDaysDiff ?? 0);
  const predictedMargin =
    input.homeRating - input.awayRating + params.homeFieldAdvantage + eloSignal + spSignal + weeklySpSignal + restSignal;
  const eloSpreadHome = -predictedMargin;

  const combinedGames = input.homeGamesPlayed + input.awayGamesPlayed;
  const baseConfidence = params.baseErrorPoints / Math.sqrt(combinedGames + 1);

  if (input.marketSpreadHome === null) {
    return { eloSpreadHome, modelSpreadHome: eloSpreadHome, confidence: baseConfidence, modelWeight: 1 };
  }

  // First attempt at fixing this (shrinking modelWeight toward market as
  // |marketSpreadHome| grows) was a no-op that never should have shipped
  // without checking it against how covered/clv actually get computed:
  // both (clv.ts) depend ONLY on pickSide, a binary home/away choice from
  // the SIGN of (market - modelSpreadHome) — never its magnitude.
  // modelSpreadHome is a weighted average of eloSpreadHome and market, and
  // a weighted average can never cross past either endpoint — so shrinking
  // modelWeight can only ever move modelSpreadHome closer to market, never
  // to the other side of it, meaning pickSide (and therefore cover rate
  // and CLV) is PROVABLY unaffected by any modelWeight-only fix, no matter
  // how strong the damping. Confirmed empirically: a real sweep of
  // bigSpreadShrinkRef from 5 to 1000 produced bit-for-bit identical cover
  // rate and avgClv every time.
  //
  // Real fix: since the model's rating scale is demonstrably compressed
  // relative to true blowout magnitudes (real CFB mismatches routinely hit
  // 30-50+ points; this incremental, regression-heavy rating system can't
  // accumulate that much separation within a season), a big disagreement
  // with an already-extreme market spread is a signal the prediction is
  // LESS trustworthy, not a reason to change which side gets picked.
  // bigSpreadShrinkRef widens `confidence` (not modelWeight) as
  // |marketSpreadHome| grows, so a confidence-based filter (getConfidenceReport,
  // or a future live threshold) naturally screens these out — same
  // "recognize and exclude the untrustworthy segment" pattern that
  // excluding rivalry week already validated, rather than trying to
  // out-guess the market's own number.
  const modelWeight = combinedGames / (combinedGames + params.marketShrinkageK);
  const modelSpreadHome = modelWeight * eloSpreadHome + (1 - modelWeight) * input.marketSpreadHome;
  const spreadUncertainty = Math.abs(input.marketSpreadHome) / params.bigSpreadShrinkRef;
  const confidence = baseConfidence * (1 + spreadUncertainty);
  return { eloSpreadHome, modelSpreadHome, confidence, modelWeight };
}
