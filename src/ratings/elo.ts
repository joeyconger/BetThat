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
  /**
   * Sample standard deviation of this team's season-to-date raw per-game
   * errors (actual margin minus predicted margin, BEFORE errorCapPoints
   * clamping -- see the dispersion tracking in computeSeasonRatings for
   * why raw, not capped). 0 below MIN_DISPERSION_GAMES (not enough of a
   * sample to trust) or when the team hasn't played yet. Exposed on the
   * state (not just used internally for varianceShrinkK) so callers like
   * the matchup-sim UI can eventually show it as a per-team error band.
   */
  dispersion: number;
  /**
   * Dispersion in EXCESS of what a linear fit of dispersion-on-rating
   * predicts for a team at this rating level, clamped to >= 0 -- see the
   * post-loop regression in computeSeasonRatings. Raw dispersion alone
   * conflates two different things: how erratic a team's results really
   * are, and the fact that good teams naturally generate wider point-
   * differential swings than mediocre ones (blowouts and grind-it-out wins
   * both being normal for a genuinely strong team). This is what
   * varianceShrinkK actually shrinks on -- a team sitting exactly on the
   * league's dispersion-vs-rating line gets 0 here regardless of its raw
   * dispersion. 0 whenever dispersion is (not enough games, or the
   * league-wide fit isn't trusted yet -- see MIN_DISPERSION_FIT_TEAMS).
   */
  excessDispersion: number;
  /**
   * Offense/defense decomposition, points-vs-average-team scale --
   * present for CFB (ratings/solveRatings.ts's engine, `rating` is exactly
   * offRating - defRating there), undefined for NFL (still on the
   * incremental Elo path, elo.ts's computeSeasonRatings below, which has
   * no offense/defense split at all). In-memory only for now, not
   * persisted to team_ratings' schema (single `rating` column,
   * migration 0001) -- same "compute on demand, don't persist" precedent
   * already set by dispersion/excessDispersion above; the solve converges
   * in roughly a second for a full CFB season, so recompute cost is low.
   * Revisit persisting this if that stops being true or a live page's
   * load time needs it.
   */
  offRating?: number;
  defRating?: number;
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
    state.set(teamId, { rating, gamesPlayed: 0, dispersion: 0, excessDispersion: 0 });
  }
  const residualsByTeam = new Map<number, number[]>();
  function pushResidual(teamId: number, value: number): void {
    const existing = residualsByTeam.get(teamId);
    if (existing) {
      existing.push(value);
    } else {
      residualsByTeam.set(teamId, [value]);
    }
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
    const home = state.get(game.homeTeamId) ?? { rating: 0, gamesPlayed: 0, dispersion: 0, excessDispersion: 0 };
    const away = state.get(game.awayTeamId) ?? { rating: 0, gamesPlayed: 0, dispersion: 0, excessDispersion: 0 };

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

    // Diminishing returns on how large a single game's "surprise" (actual
    // vs. predicted performance) can move the rating -- winsorizing-style
    // hard cap on the error term itself, applied AFTER every additive
    // component above has already contributed, not a cap on any one
    // input. Motivated by a real case: a single outlier blowout (backup-
    // heavy garbage time inflating the EPA/success-rate performance
    // signal well past what even an opponent-adjusted prediction already
    // expected) accounted for more of a team's full-season rating
    // movement than every other game combined -- see
    // cfb-team-rating-delta-diagnostic in adminJobs.ts, the per-game
    // diagnostic that found this. errorCapPoints=0 (default) is a no-op;
    // a nonzero cap clamps
    // symmetrically, so a huge upset surprise is dampened exactly the
    // same way a huge blowout surprise is -- this is NOT opponent-
    // adjustment (predictedMargin already handles that, see this
    // function's doc) and NOT garbage-time exclusion (excludeGarbageTime
    // targets which PLAYS count toward EPA; this targets how much a
    // single game's already-computed performance signal, however it was
    // built, can move the rating once it's very large).
    const rawError = actualMargin - predictedMargin;
    const error =
      params.errorCapPoints > 0 ? Math.max(-params.errorCapPoints, Math.min(params.errorCapPoints, rawError)) : rawError;

    // Tracked for varianceShrinkK below (see its doc past the main loop) --
    // deliberately the RAW error, not the capped one: capping first would
    // flatten exactly the extremity a dispersion measure needs to see. Each
    // side's residual is from THEIR OWN perspective (home's is rawError,
    // away's is its negation), since a single shared game outcome is a
    // positive surprise for one side and an equal-and-opposite one for the
    // other.
    pushResidual(game.homeTeamId, rawError);
    pushResidual(game.awayTeamId, -rawError);

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
      dispersion: 0,
      excessDispersion: 0,
    });
    state.set(game.awayTeamId, {
      rating: away.rating - params.baseK * error * awaySosMultiplier,
      gamesPlayed: away.gamesPlayed + 1,
      dispersion: 0,
      excessDispersion: 0,
    });
  }

  // Consistency-based shrinkage toward league mean (0) -- a team whose
  // season-to-date residuals (see pushResidual above) are tightly clustered
  // keeps its rating; a team whose residuals swing wildly BEYOND WHAT'S
  // NORMAL FOR ITS RATING TIER gets pulled toward average.
  //
  // Raw dispersion alone is NOT that signal -- it conflates two different
  // things. Good teams legitimately generate wider point-differential
  // swings than mediocre ones (a blowout of a bad team and a grind-it-out
  // win over a good one are both normal for a genuinely strong team), so
  // raw dispersion correlates with rating on its own. Shrinking directly
  // on it (an earlier version of this code did exactly that) ends up as a
  // near-uniform rescale that penalizes high-rated teams hardest simply
  // for being high-rated, not for being unreliable -- caught via a real
  // production case where it inverted the top of the CFB 2025 week 14
  // table, demoting the two teams the actual CFP committee had at 1-2 in
  // favor of a lower-rated, lower-dispersion team with a worse record.
  //
  // The fix: fit dispersion ~ a + b*rating across the whole league at
  // this snapshot (simple OLS, see fitLinear), and shrink only on the
  // POSITIVE residual -- dispersion in excess of what a team's own rating
  // tier predicts. A team sitting on the league's dispersion-vs-rating
  // line (Ohio State having big dispersion at a big rating, say) gets
  // excessDispersion=0 and is untouched; a team whose dispersion is
  // abnormally high FOR ITS TIER (Old Dominion having ODU-sized swings at
  // a middling rating) is the one that actually gets pulled in. Same
  // n/(n+k)-family shape as every other shrinkage in this codebase
  // (market shrinkage in predictSpread, opponentAdj shrinkage above,
  // priorShrinkK), just keyed off the regression residual instead of raw
  // dispersion or sample size.
  //
  // This is a different failure mode from errorCapPoints: the cap limits
  // how much any ONE game can move a rating; this limits how much a
  // team's FULL rating can be trusted when its own game-to-game results
  // don't agree with each other, RELATIVE TO teams of similar quality.
  // varianceShrinkK=0 (default) is a no-op -- see cfb-variance-comparison
  // in adminJobs.ts for the diagnostic this was built to answer, and the
  // README's rating-sensibility section for the ODU/Penn State/Clemson
  // history that motivated it. NOTE: units here are excess (residual)
  // dispersion, not raw dispersion -- typically much smaller, since most
  // of a team's raw dispersion is usually explained by its rating tier.
  // Any calibration done against raw-dispersion-driven shrink is void and
  // needs a fresh sweep.
  const dispersionByTeam = new Map<number, number>();
  const fitPairs: { rating: number; dispersion: number }[] = [];
  for (const [teamId, teamState] of state) {
    const residuals = residualsByTeam.get(teamId) ?? [];
    if (residuals.length < MIN_DISPERSION_GAMES) continue;
    const dispersion = sampleStdev(residuals);
    dispersionByTeam.set(teamId, dispersion);
    fitPairs.push({ rating: teamState.rating, dispersion });
  }
  const fit =
    fitPairs.length >= MIN_DISPERSION_FIT_TEAMS
      ? fitLinear(fitPairs.map((p) => p.rating), fitPairs.map((p) => p.dispersion))
      : null;

  for (const [teamId, teamState] of state) {
    const dispersion = dispersionByTeam.get(teamId) ?? 0;
    const excessDispersion = fit && dispersionByTeam.has(teamId) ? Math.max(0, dispersion - (fit.intercept + fit.slope * teamState.rating)) : 0;
    const shrinkWeight =
      params.varianceShrinkK > 0 && excessDispersion > 0
        ? params.varianceShrinkK / (params.varianceShrinkK + excessDispersion)
        : 1;
    state.set(teamId, { ...teamState, rating: teamState.rating * shrinkWeight, dispersion, excessDispersion });
  }

  return state;
}

/** Minimum season-to-date games before a team's residual dispersion is trusted as a signal -- same "don't guess off a tiny sample" threshold as MIN_SUCCESS_CONTEXT_GAMES above. Below it, a team is excluded from the league-wide dispersion-vs-rating fit and its own excessDispersion stays 0 (varianceShrinkK has no effect on it). */
const MIN_DISPERSION_GAMES = 3;

/** Minimum number of teams with a trustworthy dispersion before the league-wide dispersion-vs-rating regression is fit at all -- fitting a line through a handful of points is noise, not a signal; below this, excessDispersion is 0 for everyone (varianceShrinkK is a no-op that week). Real CFB/NFL populations clear this easily by mid-season; only early weeks (not enough teams with 3+ games yet) hit the fallback. */
const MIN_DISPERSION_FIT_TEAMS = 10;

/** Sample standard deviation (n-1 denominator) of a team's season-to-date raw per-game errors. Mean-centered on the team's OWN average residual, not 0 -- a team that's consistently under- or over-rated by the same amount every week is "consistent" (low dispersion) even though its average error isn't zero; that's deliberate, since the point of this measure is game-to-game volatility, not average bias (which the rating update itself already corrects for over time). */
function sampleStdev(values: number[]): number {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Ordinary least squares fit of y ~ intercept + slope*x. Returns slope=0 (flat at the mean) if x has no spread at all, rather than dividing by zero. */
function fitLinear(xs: number[], ys: number[]): { intercept: number; slope: number } {
  const n = xs.length;
  const meanX = xs.reduce((sum, x) => sum + x, 0) / n;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / n;
  let covariance = 0;
  let varianceX = 0;
  for (let i = 0; i < n; i++) {
    covariance += (xs[i]! - meanX) * (ys[i]! - meanY);
    varianceX += (xs[i]! - meanX) ** 2;
  }
  const slope = varianceX > 0 ? covariance / varianceX : 0;
  const intercept = meanY - slope * meanX;
  return { intercept, slope };
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
  returningProductionDeviation: number | undefined,
  params: RatingParams,
): number {
  let base: number;
  if (priorSpRating === undefined) {
    base = priorEloRating !== undefined ? carryoverRating(priorEloRating, params) : 0;
  } else {
    // Missing carryover (e.g. the first season in a backtest range, where no
    // prior-season rating was ever computed) blends against league-average
    // (0), not straight to priorSpRating — otherwise spPriorWeight=0 would
    // still inject full-strength SP+ whenever carryover happens to be
    // missing, silently ignoring the weight the caller asked for.
    const carryover = priorEloRating !== undefined ? carryoverRating(priorEloRating, params) : 0;
    base = (1 - params.spPriorWeight) * carryover + params.spPriorWeight * priorSpRating;
  }
  // returningProductionDeviation is ALREADY centered by the caller (this
  // team's percentPPA minus the FBS league-average for that season, see
  // service.ts) -- a team exactly at league-average returning production
  // gets no adjustment, only a deviation from it does. Applied additively
  // on top of the carryover/SP+ blend above, same "points per unit
  // deviation" shape as eloSignalPoints/spSignalPoints in predictSpread,
  // just applied once at seed time instead of every week. Missing data
  // (a team with no returning-production row that season) is NOT
  // defaulted to 0 deviation -- that would silently assume "exactly
  // average," a real substitution, not a neutral no-op, once the weight
  // is nonzero. It seeds exactly as it would with this feature absent.
  if (returningProductionDeviation === undefined) return base;
  return base + params.returningProductionPoints * returningProductionDeviation;
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
  /** The model's own line -- negative = home favored. Identical to modelSpreadHome; kept as a separate field for API/call-site stability (many call sites and reports already read eloSpreadHome specifically) now that there is no blend for the two to differ by. */
  eloSpreadHome: number;
  /** The reported line. As of the market-anchor removal, this is always exactly eloSpreadHome -- see this function's doc. */
  modelSpreadHome: number;
  /** Points of estimated uncertainty in modelSpreadHome. */
  confidence: number;
}

/**
 * Converts ratings into a spread -- ratings differential + home field +
 * the eloSignal/spSignal/weeklySpSignal/restSignal secondary terms, full
 * stop. No market line enters this function or any other model-number
 * path (removed -- see the git history for the prior market-anchored
 * version, which blended toward marketSpreadHome by games-played
 * shrinkage and widened confidence with market spread size). The market
 * line is still fetched and stored by ratings/service.ts for DISPLAY and
 * for CLV scoring, just never as a term here. Works identically whether
 * a market line exists for this matchup or not -- an arbitrary
 * hypothetical matchup (no scheduled game, no market) is not a
 * degraded/edge case, it's the normal path.
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
  const confidence = params.baseErrorPoints / Math.sqrt(combinedGames + 1);

  return { eloSpreadHome, modelSpreadHome: eloSpreadHome, confidence };
}
