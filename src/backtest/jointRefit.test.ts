import { test } from "node:test";
import assert from "node:assert/strict";
import { computeComponentFeature, computeBaseMargin, JOINT_REFIT_COMPONENTS } from "./jointRefitMath.js";
import { getRatingParams } from "../ratings/config.js";
import type { GameForRating } from "../db/repo.js";

const CFB = getRatingParams("cfb");

function baseGame(overrides: Partial<GameForRating> = {}): GameForRating {
  return {
    gameId: 1,
    week: 3,
    homeTeamId: 1,
    awayTeamId: 2,
    homeScore: 24,
    awayScore: 17,
    homeOffEpa: 0.1,
    homeDefEpa: 0.05,
    awayOffEpa: 0.05,
    awayDefEpa: 0.1,
    homeOffSuccess: null,
    homeDefSuccess: null,
    awayOffSuccess: null,
    awayDefSuccess: null,
    homeOffEpaNoGarbage: null,
    homeDefEpaNoGarbage: null,
    awayOffEpaNoGarbage: null,
    awayDefEpaNoGarbage: null,
    homeOffSuccessNoGarbage: null,
    homeDefSuccessNoGarbage: null,
    awayOffSuccessNoGarbage: null,
    awayDefSuccessNoGarbage: null,
    homeOffPlays: null,
    homeDefPlays: null,
    awayOffPlays: null,
    awayDefPlays: null,
    homeOffTurnoverPpaSum: null,
    homeOffTurnoverPlays: null,
    homeDefTurnoverPpaSum: null,
    homeDefTurnoverPlays: null,
    awayOffTurnoverPpaSum: null,
    awayOffTurnoverPlays: null,
    awayDefTurnoverPpaSum: null,
    awayDefTurnoverPlays: null,
    homeOffExplosiveness: null,
    homeDefExplosiveness: null,
    awayOffExplosiveness: null,
    awayDefExplosiveness: null,
    homeOffStandardDownsSuccessRate: null,
    homeDefStandardDownsSuccessRate: null,
    awayOffStandardDownsSuccessRate: null,
    awayDefStandardDownsSuccessRate: null,
    homeOffPassingDownsSuccessRate: null,
    homeDefPassingDownsSuccessRate: null,
    awayOffPassingDownsSuccessRate: null,
    awayDefPassingDownsSuccessRate: null,
    homeOffSackRate: null,
    homeDefSackRate: null,
    awayOffSackRate: null,
    awayDefSackRate: null,
    homeOffFinishingDrivesPpo: null,
    homeDefFinishingDrivesPpo: null,
    awayOffFinishingDrivesPpo: null,
    awayDefFinishingDrivesPpo: null,
    homeOffFieldPosition: null,
    homeDefFieldPosition: null,
    awayOffFieldPosition: null,
    awayDefFieldPosition: null,
    homeOffFgMakeRate: null,
    homeDefFgMakeRate: null,
    awayOffFgMakeRate: null,
    awayDefFgMakeRate: null,
    homeOffAdj: null,
    homeDefAdj: null,
    awayOffAdj: null,
    awayDefAdj: null,
    homeAdjGamesPlayed: null,
    awayAdjGamesPlayed: null,
    ...overrides,
  };
}

// --- computeComponentFeature ---

test("computeComponentFeature: standard convention (explosiveness) computes homeNet - awayNet", () => {
  const game = baseGame({ homeOffExplosiveness: 1.4, homeDefExplosiveness: 1.1, awayOffExplosiveness: 1.2, awayDefExplosiveness: 1.3 });
  // homeNet = 1.4-1.1=0.3; awayNet = 1.2-1.3=-0.1; feature = 0.3-(-0.1) = 0.4
  const feature = computeComponentFeature(game, "pointsPerExplosiveness", false);
  assert.ok(Math.abs(feature! - 0.4) < 1e-9, `got ${feature}`);
});

test("computeComponentFeature: inverted convention (sack rate) uses def-off, not off-def", () => {
  const game = baseGame({ homeOffSackRate: 0.15, homeDefSackRate: 0.12, awayOffSackRate: 0.02, awayDefSackRate: 0.03 });
  // homeNet (inverted) = 0.12-0.15=-0.03; awayNet (inverted) = 0.03-0.02=0.01; feature = -0.03-0.01=-0.04
  const feature = computeComponentFeature(game, "pointsPerSackRate", true);
  assert.ok(Math.abs(feature! - -0.04) < 1e-9, `got ${feature}`);
});

test("computeComponentFeature: returns null when any of the four underlying fields is missing", () => {
  const game = baseGame({ homeOffExplosiveness: 1.4, homeDefExplosiveness: null, awayOffExplosiveness: 1.2, awayDefExplosiveness: 1.3 });
  assert.equal(computeComponentFeature(game, "pointsPerExplosiveness", false), null);
});

test("JOINT_REFIT_COMPONENTS lists exactly 8 components with pointsPerSackRate correctly flagged inverted", () => {
  assert.equal(JOINT_REFIT_COMPONENTS.length, 8);
  const sackRate = JOINT_REFIT_COMPONENTS.find((c) => c.key === "pointsPerSackRate");
  assert.equal(sackRate?.invert, true);
  const others = JOINT_REFIT_COMPONENTS.filter((c) => c.key !== "pointsPerSackRate");
  assert.ok(others.every((c) => c.invert === false));
});

// --- computeBaseMargin ---

test("computeBaseMargin: reduces to pointsPerEpa * netEpa when successRateWeight is 0", () => {
  const params = { ...CFB, successRateWeight: 0, turnoverLuckWeight: 0, excludeGarbageTime: false };
  const game = baseGame({ homeOffEpa: 0.2, homeDefEpa: 0.1, awayOffEpa: 0.1, awayDefEpa: 0.2 });
  // homeNetEpa = 0.1; awayNetEpa = -0.1; epaMargin = pointsPerEpa * 0.2
  const expected = params.pointsPerEpa * 0.2;
  assert.ok(Math.abs(computeBaseMargin(game, params) - expected) < 1e-9, `got ${computeBaseMargin(game, params)}, expected ${expected}`);
});

test("computeBaseMargin: blends in successMargin per successRateWeight when success-rate fields are present", () => {
  const params = { ...CFB, successRateWeight: 0.75, turnoverLuckWeight: 0, excludeGarbageTime: false, pointsPerSuccessRate: 90 };
  const game = baseGame({
    homeOffEpa: 0.2, homeDefEpa: 0.1, awayOffEpa: 0.1, awayDefEpa: 0.2,
    homeOffSuccess: 0.5, homeDefSuccess: 0.4, awayOffSuccess: 0.45, awayDefSuccess: 0.35,
  });
  const epaMargin = params.pointsPerEpa * 0.2;
  // homeNetSuccess = 0.5-0.4=0.1; awayNetSuccess=0.45-0.35=0.1; successMargin = 90*(0.1-0.1) = 0
  const successMargin = 0;
  const expected = (1 - 0.75) * epaMargin + 0.75 * successMargin;
  assert.ok(Math.abs(computeBaseMargin(game, params) - expected) < 1e-9, `got ${computeBaseMargin(game, params)}, expected ${expected}`);
});

test("computeBaseMargin: falls back to pure epaMargin when successRateWeight > 0 but success-rate fields are missing", () => {
  const params = { ...CFB, successRateWeight: 0.75, turnoverLuckWeight: 0, excludeGarbageTime: false };
  const game = baseGame({ homeOffEpa: 0.2, homeDefEpa: 0.1, awayOffEpa: 0.1, awayDefEpa: 0.2 });
  const expected = params.pointsPerEpa * 0.2;
  assert.ok(Math.abs(computeBaseMargin(game, params) - expected) < 1e-9, `got ${computeBaseMargin(game, params)}, expected ${expected}`);
});

test("computeBaseMargin: throws if opponentAdjustWeight is nonzero (the function's documented assumption)", () => {
  const params = { ...CFB, opponentAdjustWeight: 0.5 };
  const game = baseGame();
  assert.throws(() => computeBaseMargin(game, params), /opponentAdjustWeight === 0/);
});
