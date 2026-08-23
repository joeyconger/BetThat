import type { GameForRating } from "../db/repo.js";
import type { RatingParams } from "../ratings/config.js";
import { blendTurnoverStrip } from "../ratings/elo.js";
import type { ComponentParamKey } from "./sweep.js";

/**
 * Pure math for the joint component refit -- deliberately split from
 * jointRefit.ts's DB/backtest orchestration (same discipline as
 * playSuccess.ts/garbageTime.ts/opponentAdjust.ts elsewhere in this
 * project): a type-only import of GameForRating here means this file has
 * zero runtime dependency on db/repo.ts, so it (and its tests) never need
 * DATABASE_URL set, unlike jointRefit.ts's fitJointComponentWeights/
 * runJointRefitHoldout which actually query the database.
 *
 * See jointRefit.ts's header doc for the full design rationale (why a
 * joint ridge fit, why the residual-against-baseMargin framing, why this
 * doesn't break the no-lookahead architecture).
 */
export const JOINT_REFIT_COMPONENTS: { key: ComponentParamKey; invert: boolean; label: string }[] = [
  { key: "pointsPerExplosiveness", invert: false, label: "explosiveness" },
  { key: "pointsPerStandardDownsSplit", invert: false, label: "standardDownsSplit" },
  { key: "pointsPerPassingDownsSplit", invert: false, label: "passingDownsSplit" },
  { key: "pointsPerSackRate", invert: true, label: "sackRate" }, // INVERTED: def-off, being sacked is bad for offense, forcing sacks is good for defense -- see elo.ts's identical comment
  { key: "pointsPerFinishingDrives", invert: false, label: "finishingDrives" },
  { key: "pointsPerFieldPosition", invert: false, label: "fieldPosition" },
  { key: "pointsPerFgMakeRate", invert: false, label: "fgMakeRate" },
  { key: "pointsPerOpponentAdj", invert: false, label: "opponentAdj" },
];

interface ComponentFields {
  homeOff: number | null;
  homeDef: number | null;
  awayOff: number | null;
  awayDef: number | null;
}

function getComponentFields(game: GameForRating, key: ComponentParamKey): ComponentFields {
  switch (key) {
    case "pointsPerExplosiveness":
      return { homeOff: game.homeOffExplosiveness, homeDef: game.homeDefExplosiveness, awayOff: game.awayOffExplosiveness, awayDef: game.awayDefExplosiveness };
    case "pointsPerStandardDownsSplit":
      return {
        homeOff: game.homeOffStandardDownsSuccessRate,
        homeDef: game.homeDefStandardDownsSuccessRate,
        awayOff: game.awayOffStandardDownsSuccessRate,
        awayDef: game.awayDefStandardDownsSuccessRate,
      };
    case "pointsPerPassingDownsSplit":
      return {
        homeOff: game.homeOffPassingDownsSuccessRate,
        homeDef: game.homeDefPassingDownsSuccessRate,
        awayOff: game.awayOffPassingDownsSuccessRate,
        awayDef: game.awayDefPassingDownsSuccessRate,
      };
    case "pointsPerSackRate":
      return { homeOff: game.homeOffSackRate, homeDef: game.homeDefSackRate, awayOff: game.awayOffSackRate, awayDef: game.awayDefSackRate };
    case "pointsPerFinishingDrives":
      return {
        homeOff: game.homeOffFinishingDrivesPpo,
        homeDef: game.homeDefFinishingDrivesPpo,
        awayOff: game.awayOffFinishingDrivesPpo,
        awayDef: game.awayDefFinishingDrivesPpo,
      };
    case "pointsPerFieldPosition":
      return { homeOff: game.homeOffFieldPosition, homeDef: game.homeDefFieldPosition, awayOff: game.awayOffFieldPosition, awayDef: game.awayDefFieldPosition };
    case "pointsPerFgMakeRate":
      return { homeOff: game.homeOffFgMakeRate, homeDef: game.homeDefFgMakeRate, awayOff: game.awayOffFgMakeRate, awayDef: game.awayDefFgMakeRate };
    case "pointsPerOpponentAdj":
      return { homeOff: game.homeOffAdj, homeDef: game.homeDefAdj, awayOff: game.awayOffAdj, awayDef: game.awayDefAdj };
    case "errorCapPoints":
      // Not one of JOINT_REFIT_COMPONENTS below (a cap on the aggregate
      // error, not a per-side off/def differential component) -- this
      // function is only ever actually called with keys drawn from that
      // fixed array, so this case is unreachable at runtime. Returning
      // all-null (the existing "no data for this component" signal,
      // same as any other missing field) rather than throwing keeps that
      // guarantee from being load-bearing.
      return { homeOff: null, homeDef: null, awayOff: null, awayDef: null };
  }
}

/** homeNetX - awayNetX for one component, respecting its sign convention. Returns null if any of the 4 underlying fields is missing. */
export function computeComponentFeature(game: GameForRating, key: ComponentParamKey, invert: boolean): number | null {
  const f = getComponentFields(game, key);
  if (f.homeOff == null || f.homeDef == null || f.awayOff == null || f.awayDef == null) return null;
  const homeNet = invert ? f.homeDef - f.homeOff : f.homeOff - f.homeDef;
  const awayNet = invert ? f.awayDef - f.awayOff : f.awayOff - f.awayDef;
  return homeNet - awayNet;
}

/**
 * The opponentAdj feature, WITH games-played shrinkage applied -- mirrors
 * elo.ts's pointsPerOpponentAdj block exactly (each side's own off_adj/
 * def_adj shrunk toward 0 by its own adj_games_played before the net
 * differential is computed), so the joint refit trains on the identical
 * quantity elo.ts will actually consume once the fitted weight is
 * plugged in. Returns null if any of the 4 raw values OR either side's
 * adj_games_played is missing -- same stricter guard elo.ts's
 * haveAllFourAdj now uses.
 */
export function computeShrunkOpponentAdjFeature(game: GameForRating, shrinkageK: number): number | null {
  if (
    game.homeOffAdj == null ||
    game.homeDefAdj == null ||
    game.awayOffAdj == null ||
    game.awayDefAdj == null ||
    game.homeAdjGamesPlayed == null ||
    game.awayAdjGamesPlayed == null
  ) {
    return null;
  }
  const homeShrink = game.homeAdjGamesPlayed / (game.homeAdjGamesPlayed + shrinkageK);
  const awayShrink = game.awayAdjGamesPlayed / (game.awayAdjGamesPlayed + shrinkageK);
  const homeNet = game.homeOffAdj * homeShrink - game.homeDefAdj * homeShrink;
  const awayNet = game.awayOffAdj * awayShrink - game.awayDefAdj * awayShrink;
  return homeNet - awayNet;
}

/**
 * Replicates elo.ts's actualMargin computation UP TO (not including) the
 * 8 component additive terms -- i.e. epaMargin, turnover-luck-stripped if
 * applicable, blended with successMargin per successRateWeight. Assumes
 * opponentAdjustWeight === 0 (true for CFB today): that param makes the
 * success-rate opponent-adjust step inside elo.ts a no-op passthrough,
 * which is what lets this be a pure per-game function with no season-
 * accumulated state -- if opponentAdjustWeight is ever swept nonzero,
 * this function needs the same season-accumulated successCtx state
 * elo.ts carries, and this shortcut breaks.
 */
export function computeBaseMargin(game: GameForRating, params: RatingParams): number {
  if (params.opponentAdjustWeight !== 0) {
    throw new Error(
      "computeBaseMargin assumes opponentAdjustWeight === 0 (its no-op-when-zero shortcut for elo.ts's success-rate opponent-adjust step would be wrong otherwise) -- revisit this function before using it with a nonzero opponentAdjustWeight.",
    );
  }

  const useNoGarbage = params.excludeGarbageTime;
  const homeOffEpa = (useNoGarbage ? game.homeOffEpaNoGarbage : null) ?? game.homeOffEpa;
  const homeDefEpa = (useNoGarbage ? game.homeDefEpaNoGarbage : null) ?? game.homeDefEpa;
  const awayOffEpa = (useNoGarbage ? game.awayOffEpaNoGarbage : null) ?? game.awayOffEpa;
  const awayDefEpa = (useNoGarbage ? game.awayDefEpaNoGarbage : null) ?? game.awayDefEpa;

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

  const homeNetEpa = strippedHomeOffEpa - strippedHomeDefEpa;
  const awayNetEpa = strippedAwayOffEpa - strippedAwayDefEpa;
  const epaMargin = params.pointsPerEpa * (homeNetEpa - awayNetEpa);

  const homeOffSuccess = (useNoGarbage ? game.homeOffSuccessNoGarbage : undefined) ?? game.homeOffSuccess;
  const homeDefSuccess = (useNoGarbage ? game.homeDefSuccessNoGarbage : undefined) ?? game.homeDefSuccess;
  const awayOffSuccess = (useNoGarbage ? game.awayOffSuccessNoGarbage : undefined) ?? game.awayOffSuccess;
  const awayDefSuccess = (useNoGarbage ? game.awayDefSuccessNoGarbage : undefined) ?? game.awayDefSuccess;
  const haveAllFourSuccess = homeOffSuccess != null && homeDefSuccess != null && awayOffSuccess != null && awayDefSuccess != null;

  if (params.successRateWeight > 0 && haveAllFourSuccess) {
    const homeNetSuccess = homeOffSuccess! - homeDefSuccess!;
    const awayNetSuccess = awayOffSuccess! - awayDefSuccess!;
    const successMargin = params.pointsPerSuccessRate * (homeNetSuccess - awayNetSuccess);
    return (1 - params.successRateWeight) * epaMargin + params.successRateWeight * successMargin;
  }
  return epaMargin;
}

/**
 * PREDICTIVE reframing of the joint refit (vs. the CONTEMPORANEOUS
 * feature construction above): computeComponentFeature/computeBaseMargin
 * read a game's OWN stats to explain that SAME game's margin -- a
 * decomposition of what already happened, not a forecast. Fit that way,
 * the calibration answers "how much did this game's explosiveness
 * contribute to this game's margin," when the deployed Elo update needs
 * "how much should this game's explosiveness change my belief about the
 * NEXT game." Those diverge exactly where it matters: a stat can be a
 * fine accounting term and a poor leading indicator.
 *
 * buildAsOfWeekGames re-derives each game's stat fields as each team's
 * OWN rolling average through the PRIOR games of that season only (reset
 * each season, same convention ratings/opponentAdjust.ts already uses
 * for off_adj/def_adj -- which is why this function leaves opponentAdj
 * untouched: it's already an as-of-week quantity). Feed the result
 * through the SAME computeComponentFeature/computeBaseMargin used above
 * unchanged -- only the game's stat fields differ, not how they're
 * combined -- so a caller gets a genuinely predictive design matrix with
 * zero duplicated combination logic.
 *
 * A team's first game of a season has no prior data at all -- not
 * imputable the way IMPUTED_COMPONENTS handles null components, since
 * EPA itself (computeBaseMargin's foundation) is non-nullable by type.
 * Those games are dropped from the output entirely (both as a possible
 * home AND away team), though their OWN real stats still feed forward
 * into their opponent's and their own future as-of-week averages.
 */
const AS_OF_WEEK_STAT_KEYS = [
  "offEpa",
  "defEpa",
  "offSuccess",
  "defSuccess",
  "offExplosiveness",
  "defExplosiveness",
  "offStandardDowns",
  "defStandardDowns",
  "offPassingDowns",
  "defPassingDowns",
  "offSackRate",
  "defSackRate",
  "offFinishingDrives",
  "defFinishingDrives",
  "offFieldPosition",
  "defFieldPosition",
  "offFgMakeRate",
  "defFgMakeRate",
] as const;
type AsOfWeekStatKey = (typeof AS_OF_WEEK_STAT_KEYS)[number];

function readTeamStat(game: GameForRating, key: AsOfWeekStatKey, side: "home" | "away"): number | null {
  const isHome = side === "home";
  switch (key) {
    case "offEpa":
      return isHome ? game.homeOffEpa : game.awayOffEpa;
    case "defEpa":
      return isHome ? game.homeDefEpa : game.awayDefEpa;
    case "offSuccess":
      return isHome ? game.homeOffSuccess : game.awayOffSuccess;
    case "defSuccess":
      return isHome ? game.homeDefSuccess : game.awayDefSuccess;
    case "offExplosiveness":
      return isHome ? game.homeOffExplosiveness : game.awayOffExplosiveness;
    case "defExplosiveness":
      return isHome ? game.homeDefExplosiveness : game.awayDefExplosiveness;
    case "offStandardDowns":
      return isHome ? game.homeOffStandardDownsSuccessRate : game.awayOffStandardDownsSuccessRate;
    case "defStandardDowns":
      return isHome ? game.homeDefStandardDownsSuccessRate : game.awayDefStandardDownsSuccessRate;
    case "offPassingDowns":
      return isHome ? game.homeOffPassingDownsSuccessRate : game.awayOffPassingDownsSuccessRate;
    case "defPassingDowns":
      return isHome ? game.homeDefPassingDownsSuccessRate : game.awayDefPassingDownsSuccessRate;
    case "offSackRate":
      return isHome ? game.homeOffSackRate : game.awayOffSackRate;
    case "defSackRate":
      return isHome ? game.homeDefSackRate : game.awayDefSackRate;
    case "offFinishingDrives":
      return isHome ? game.homeOffFinishingDrivesPpo : game.awayOffFinishingDrivesPpo;
    case "defFinishingDrives":
      return isHome ? game.homeDefFinishingDrivesPpo : game.awayDefFinishingDrivesPpo;
    case "offFieldPosition":
      return isHome ? game.homeOffFieldPosition : game.awayOffFieldPosition;
    case "defFieldPosition":
      return isHome ? game.homeDefFieldPosition : game.awayDefFieldPosition;
    case "offFgMakeRate":
      return isHome ? game.homeOffFgMakeRate : game.awayOffFgMakeRate;
    case "defFgMakeRate":
      return isHome ? game.homeDefFgMakeRate : game.awayDefFgMakeRate;
  }
}

interface TeamAccumulator {
  gamesPlayed: number;
  sums: Record<AsOfWeekStatKey, number>;
  counts: Record<AsOfWeekStatKey, number>;
}

function emptyAccumulator(): TeamAccumulator {
  const sums = {} as Record<AsOfWeekStatKey, number>;
  const counts = {} as Record<AsOfWeekStatKey, number>;
  for (const key of AS_OF_WEEK_STAT_KEYS) {
    sums[key] = 0;
    counts[key] = 0;
  }
  return { gamesPlayed: 0, sums, counts };
}

function asOfWeekValue(acc: TeamAccumulator, key: AsOfWeekStatKey): number | null {
  const count = acc.counts[key];
  return count > 0 ? acc.sums[key] / count : null;
}

function buildShadowGame(game: GameForRating, home: TeamAccumulator, away: TeamAccumulator): GameForRating {
  const shadow: GameForRating = { ...game };
  for (const key of AS_OF_WEEK_STAT_KEYS) {
    const homeVal = asOfWeekValue(home, key);
    const awayVal = asOfWeekValue(away, key);
    switch (key) {
      case "offEpa":
        shadow.homeOffEpa = homeVal!; // non-null guaranteed by this function's gamesPlayed gate before calling
        shadow.awayOffEpa = awayVal!;
        break;
      case "defEpa":
        shadow.homeDefEpa = homeVal!;
        shadow.awayDefEpa = awayVal!;
        break;
      case "offSuccess":
        shadow.homeOffSuccess = homeVal;
        shadow.awayOffSuccess = awayVal;
        break;
      case "defSuccess":
        shadow.homeDefSuccess = homeVal;
        shadow.awayDefSuccess = awayVal;
        break;
      case "offExplosiveness":
        shadow.homeOffExplosiveness = homeVal;
        shadow.awayOffExplosiveness = awayVal;
        break;
      case "defExplosiveness":
        shadow.homeDefExplosiveness = homeVal;
        shadow.awayDefExplosiveness = awayVal;
        break;
      case "offStandardDowns":
        shadow.homeOffStandardDownsSuccessRate = homeVal;
        shadow.awayOffStandardDownsSuccessRate = awayVal;
        break;
      case "defStandardDowns":
        shadow.homeDefStandardDownsSuccessRate = homeVal;
        shadow.awayDefStandardDownsSuccessRate = awayVal;
        break;
      case "offPassingDowns":
        shadow.homeOffPassingDownsSuccessRate = homeVal;
        shadow.awayOffPassingDownsSuccessRate = awayVal;
        break;
      case "defPassingDowns":
        shadow.homeDefPassingDownsSuccessRate = homeVal;
        shadow.awayDefPassingDownsSuccessRate = awayVal;
        break;
      case "offSackRate":
        shadow.homeOffSackRate = homeVal;
        shadow.awayOffSackRate = awayVal;
        break;
      case "defSackRate":
        shadow.homeDefSackRate = homeVal;
        shadow.awayDefSackRate = awayVal;
        break;
      case "offFinishingDrives":
        shadow.homeOffFinishingDrivesPpo = homeVal;
        shadow.awayOffFinishingDrivesPpo = awayVal;
        break;
      case "defFinishingDrives":
        shadow.homeDefFinishingDrivesPpo = homeVal;
        shadow.awayDefFinishingDrivesPpo = awayVal;
        break;
      case "offFieldPosition":
        shadow.homeOffFieldPosition = homeVal;
        shadow.awayOffFieldPosition = awayVal;
        break;
      case "defFieldPosition":
        shadow.homeDefFieldPosition = homeVal;
        shadow.awayDefFieldPosition = awayVal;
        break;
      case "offFgMakeRate":
        shadow.homeOffFgMakeRate = homeVal;
        shadow.awayOffFgMakeRate = awayVal;
        break;
      case "defFgMakeRate":
        shadow.homeDefFgMakeRate = homeVal;
        shadow.awayDefFgMakeRate = awayVal;
        break;
    }
  }
  // NoGarbage/turnover fields are NOT re-derived as-of-week -- see this
  // function's doc/guard: only safe to call with excludeGarbageTime=false
  // and turnoverLuckWeight=0, in which case computeBaseMargin never reads
  // them, so their (still same-game) values here are inert.
  return shadow;
}

export interface AsOfWeekGame {
  season: number;
  game: GameForRating;
}

/** See this file's "PREDICTIVE reframing" doc above for the full design rationale. */
export function buildAsOfWeekGames(gamesBySeason: AsOfWeekGame[], params: RatingParams): AsOfWeekGame[] {
  if (params.excludeGarbageTime || params.turnoverLuckWeight > 0) {
    throw new Error(
      "buildAsOfWeekGames only re-derives EPA/success/the 7 non-opponentAdj components as-of-week -- it does NOT re-derive the NoGarbage or turnover-strip fields, so it's unsafe to call with excludeGarbageTime=true or turnoverLuckWeight>0 (computeBaseMargin would read same-game values through those paths). CFB's current params have both off; revisit this function before enabling either.",
    );
  }

  const bySeason = new Map<number, { season: number; game: GameForRating }[]>();
  for (const entry of gamesBySeason) {
    if (!bySeason.has(entry.season)) bySeason.set(entry.season, []);
    bySeason.get(entry.season)!.push(entry);
  }

  const result: AsOfWeekGame[] = [];
  for (const [season, games] of bySeason) {
    const sorted = [...games].sort((a, b) => a.game.week - b.game.week || a.game.gameId - b.game.gameId);
    const accumulators = new Map<number, TeamAccumulator>();
    const getAcc = (teamId: number): TeamAccumulator => {
      if (!accumulators.has(teamId)) accumulators.set(teamId, emptyAccumulator());
      return accumulators.get(teamId)!;
    };

    for (const { game } of sorted) {
      const home = getAcc(game.homeTeamId);
      const away = getAcc(game.awayTeamId);

      if (home.gamesPlayed > 0 && away.gamesPlayed > 0) {
        result.push({ season, game: buildShadowGame(game, home, away) });
      }

      for (const key of AS_OF_WEEK_STAT_KEYS) {
        const homeVal = readTeamStat(game, key, "home");
        if (homeVal != null) {
          home.sums[key] += homeVal;
          home.counts[key] += 1;
        }
        const awayVal = readTeamStat(game, key, "away");
        if (awayVal != null) {
          away.sums[key] += awayVal;
          away.counts[key] += 1;
        }
      }
      home.gamesPlayed += 1;
      away.gamesPlayed += 1;
    }
  }

  return result;
}
