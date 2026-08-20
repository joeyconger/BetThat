import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSeasonRatings, carryoverRating, computeInitialRating, zScore, predictSpread } from "./elo.js";
import { getRatingParams } from "./config.js";

const NFL = getRatingParams("nfl");
const CFB = getRatingParams("cfb");

test("carryoverRating regresses toward league average (0)", () => {
  assert.equal(carryoverRating(10, NFL), 10 * NFL.seasonCarryover);
});

test("zScore of the population mean's own values", () => {
  // population [1,2,3,4,5]: mean 3, variance 2, sd sqrt(2)
  assert.ok(Math.abs(zScore(5, [1, 2, 3, 4, 5]) - Math.sqrt(2)) < 1e-9);
});

test("zScore returns 0 for a population with no spread", () => {
  assert.equal(zScore(5, [3, 3, 3]), 0);
});

test("computeInitialRating falls back to 0 with no prior data at all", () => {
  assert.equal(computeInitialRating(undefined, undefined, NFL), 0);
});

test("computeInitialRating uses pure carryover when there's no SP+ prior", () => {
  assert.equal(computeInitialRating(10, undefined, NFL), carryoverRating(10, NFL));
});

test("computeInitialRating blends carryover and SP+ prior by spPriorWeight", () => {
  const params = { ...CFB, spPriorWeight: 0.4, seasonCarryover: 0.6 };
  // carryover = 10*0.6 = 6; blend = 0.6*6 + 0.4*20 = 3.6 + 8 = 11.6
  assert.ok(Math.abs(computeInitialRating(10, 20, params) - 11.6) < 1e-9);
});

test("computeInitialRating blends against league-average (0), not raw SP+, when carryover is missing", () => {
  // This is the bug this project actually shipped once: spPriorWeight=0
  // silently ignored whenever priorEloRating was missing, because the old
  // code returned priorSpRating unconditionally in that branch instead of
  // blending it against 0 like the weight says it should.
  const params = { ...CFB, spPriorWeight: 0.4 };
  assert.ok(Math.abs(computeInitialRating(undefined, 20, params) - 0.4 * 20) < 1e-9);
});

test("predictSpread falls back to pure Elo with no market line", () => {
  const result = predictSpread(
    { homeRating: 3, awayRating: 1, homeGamesPlayed: 4, awayGamesPlayed: 4, marketSpreadHome: null },
    NFL,
  );
  assert.equal(result.eloSpreadHome, -3.5);
  assert.equal(result.modelSpreadHome, -3.5);
  assert.equal(result.modelWeight, 1);
});

test("predictSpread blends toward the market by shrinkage and widens confidence with spread size", () => {
  // combinedGames=8, modelWeight = 8/(8+8) = 0.5 -> 0.5*(-3.5) + 0.5*(-2) = -2.75
  // baseConfidence = 8/sqrt(9) = 8/3; spreadUncertainty = 2/40 = 0.05 -> confidence = 8/3 * 1.05 = 2.8
  const result = predictSpread(
    { homeRating: 3, awayRating: 1, homeGamesPlayed: 4, awayGamesPlayed: 4, marketSpreadHome: -2 },
    NFL,
  );
  assert.equal(result.modelWeight, 0.5);
  assert.equal(result.modelSpreadHome, -2.75);
  assert.ok(Math.abs(result.confidence - 2.8) < 1e-9);
});

test("predictSpread's eloSignal term actually moves the prediction (CFB only -- NFL's eloSignalPoints is 0)", () => {
  const result = predictSpread(
    { homeRating: 0, awayRating: 0, homeGamesPlayed: 0, awayGamesPlayed: 0, marketSpreadHome: null, homeEloZ: 1, awayEloZ: -1 },
    CFB,
  );
  // eloSignal = eloSignalPoints * (1 - (-1)); predictedMargin = 0 - 0 + homeFieldAdvantage + eloSignal
  const expectedMargin = CFB.homeFieldAdvantage + CFB.eloSignalPoints * 2;
  assert.ok(Math.abs(result.eloSpreadHome - -expectedMargin) < 1e-9);
});

test("predictSpread's spSignal term actually moves the prediction when spSignalPoints > 0", () => {
  // CFB_PARAMS.spSignalPoints defaults to 0 (untested, see config.ts) -- use
  // an explicit override so this test doesn't silently pass as a no-op if
  // that default ever changes, and so it actually proves the wiring works.
  const params = { ...CFB, spSignalPoints: 2 };
  const result = predictSpread(
    { homeRating: 0, awayRating: 0, homeGamesPlayed: 0, awayGamesPlayed: 0, marketSpreadHome: null, homeSpZ: 1, awaySpZ: -1 },
    params,
  );
  const expectedMargin = CFB.homeFieldAdvantage + 2 * 2;
  assert.ok(Math.abs(result.eloSpreadHome - -expectedMargin) < 1e-9);
});

test("predictSpread ignores spZ inputs entirely when spSignalPoints is 0 (today's default)", () => {
  const withSpZ = predictSpread(
    { homeRating: 3, awayRating: 1, homeGamesPlayed: 4, awayGamesPlayed: 4, marketSpreadHome: null, homeSpZ: 5, awaySpZ: -5 },
    CFB,
  );
  const withoutSpZ = predictSpread(
    { homeRating: 3, awayRating: 1, homeGamesPlayed: 4, awayGamesPlayed: 4, marketSpreadHome: null },
    CFB,
  );
  assert.equal(withSpZ.eloSpreadHome, withoutSpZ.eloSpreadHome);
});

test("computeSeasonRatings updates both teams from a single game's EPA differential", () => {
  const state = computeSeasonRatings(
    [
      {
        gameId: 1,
        week: 1,
        homeTeamId: 1,
        awayTeamId: 2,
        homeOffEpa: 0.1,
        homeDefEpa: -0.05,
        awayOffEpa: -0.05,
        awayDefEpa: 0.05,
      },
    ],
    new Map(),
    NFL,
  );
  // predictedMargin = 0 - 0 + 1.5 = 1.5; actualMargin = 35*(0.15 - -0.1) = 8.75; error = 7.25
  // both ratings start at 0, so both SOS multipliers are exactly 1.
  const expectedDelta = NFL.baseK * 7.25;
  const home = state.get(1)!;
  const away = state.get(2)!;
  assert.ok(Math.abs(home.rating - expectedDelta) < 1e-9);
  assert.ok(Math.abs(away.rating - -expectedDelta) < 1e-9);
  assert.equal(home.gamesPlayed, 1);
  assert.equal(away.gamesPlayed, 1);
});

test("computeSeasonRatings ignores success rate entirely when successRateWeight is 0 (today's default)", () => {
  const gameBase = {
    gameId: 1,
    week: 1,
    homeTeamId: 1,
    awayTeamId: 2,
    homeOffEpa: 0.1,
    homeDefEpa: -0.05,
    awayOffEpa: -0.05,
    awayDefEpa: 0.05,
  };
  const withoutSuccess = computeSeasonRatings([gameBase], new Map(), NFL);
  const withSuccessButZeroWeight = computeSeasonRatings(
    [{ ...gameBase, homeOffSuccess: 0.9, homeDefSuccess: 0.1, awayOffSuccess: 0.1, awayDefSuccess: 0.9 }],
    new Map(),
    NFL,
  );
  assert.equal(withoutSuccess.get(1)!.rating, withSuccessButZeroWeight.get(1)!.rating);
});

test("computeSeasonRatings actually blends in success rate when successRateWeight > 0", () => {
  const params = { ...NFL, successRateWeight: 0.5, pointsPerSuccessRate: 90 };
  const game = {
    gameId: 1,
    week: 1,
    homeTeamId: 1,
    awayTeamId: 2,
    homeOffEpa: 0.1,
    homeDefEpa: -0.05,
    awayOffEpa: -0.05,
    awayDefEpa: 0.05,
    homeOffSuccess: 0.6,
    homeDefSuccess: 0.3,
    awayOffSuccess: 0.3,
    awayDefSuccess: 0.6,
  };
  const withWeight = computeSeasonRatings([game], new Map(), params);
  const withoutWeight = computeSeasonRatings([game], new Map(), { ...params, successRateWeight: 0 });
  assert.notEqual(withWeight.get(1)!.rating, withoutWeight.get(1)!.rating);

  // Hand-computed: epaMargin = 35*(0.15 - -0.1) = 8.75; successMargin = 90*(0.3 - -0.3) = 54
  // actualMargin = 0.5*8.75 + 0.5*54 = 31.375; predictedMargin = 0+1.5=1.5; error=29.875
  // both ratings start at 0 -> both SOS multipliers are 1.
  const expectedDelta = params.baseK * 29.875;
  assert.ok(Math.abs(withWeight.get(1)!.rating - expectedDelta) < 1e-9);
});

test("computeSeasonRatings falls back to pure EPA for a game missing success rate, even with successRateWeight > 0", () => {
  const params = { ...NFL, successRateWeight: 0.5 };
  const gameMissingSuccess = {
    gameId: 1,
    week: 1,
    homeTeamId: 1,
    awayTeamId: 2,
    homeOffEpa: 0.1,
    homeDefEpa: -0.05,
    awayOffEpa: -0.05,
    awayDefEpa: 0.05,
    homeOffSuccess: null,
  };
  const withMissingData = computeSeasonRatings([gameMissingSuccess], new Map(), params);
  const pureEpa = computeSeasonRatings([gameMissingSuccess], new Map(), { ...params, successRateWeight: 0 });
  assert.equal(withMissingData.get(1)!.rating, pureEpa.get(1)!.rating);
});

test("computeSeasonRatings clamps the SOS multiplier instead of letting an extreme opponent rating blow it up", () => {
  // This is the actual bug this project shipped once: an uncapped SOS
  // multiplier let ratings chain-amplify to 1e26 by week 9 of a real
  // backtest. away starts at a wildly unrealistic rating so home's SOS
  // multiplier (which scales off the OPPONENT's rating) would be ~1501
  // without the ceiling -- assert it lands at exactly maxSosMultiplier
  // instead.
  const state = computeSeasonRatings(
    [
      {
        gameId: 1,
        week: 1,
        homeTeamId: 1,
        awayTeamId: 2,
        homeOffEpa: 0.1,
        homeDefEpa: -0.05,
        awayOffEpa: -0.05,
        awayDefEpa: 0.05,
      },
    ],
    new Map([[2, 100000]]),
    NFL,
  );
  // predictedMargin = 0 - 100000 + 1.5 = -99998.5; actualMargin = 8.75; error = 100007.25
  const error = 8.75 - (0 - 100000 + NFL.homeFieldAdvantage);
  const expectedHomeRating = NFL.baseK * error * NFL.maxSosMultiplier;
  const home = state.get(1)!;
  assert.ok(
    Math.abs(home.rating - expectedHomeRating) < 1e-6,
    `expected clamped rating ${expectedHomeRating}, got ${home.rating}`,
  );
});
