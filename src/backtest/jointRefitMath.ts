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
