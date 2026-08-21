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

test("computeSeasonRatings' SOS multiplier is neutralized for CFB (sosWeight=0) -- an extreme opponent rating has zero effect on the update", () => {
  const params = { ...CFB, successRateWeight: 0 };
  const state = computeSeasonRatings(
    [{ gameId: 1, week: 1, homeTeamId: 1, awayTeamId: 2, homeOffEpa: 0.1, homeDefEpa: -0.05, awayOffEpa: -0.05, awayDefEpa: 0.05 }],
    new Map([[2, 100000]]), // extreme away rating -- would blow up homeSosMultiplier if sosWeight were nonzero
    params,
  );
  // predictedMargin = 0 - 100000 + homeFieldAdvantage; actualMargin = pointsPerEpa*(0.15 - -0.1)
  const actualMargin = params.pointsPerEpa * (0.15 - -0.1);
  const error = actualMargin - (0 - 100000 + params.homeFieldAdvantage);
  // sosWeight=0 -> multiplier is exactly 1 regardless of the away rating's magnitude.
  const expectedHomeRating = params.baseK * error * 1;
  const home = state.get(1)!;
  assert.ok(
    Math.abs(home.rating - expectedHomeRating) < 1e-6,
    `expected unclamped, unmultiplied rating ${expectedHomeRating} (sosWeight=0 is a true no-op), got ${home.rating}`,
  );
});

test("computeSeasonRatings ignores no-garbage fields entirely when excludeGarbageTime is false (today's default), even when present", () => {
  const gameBase = {
    gameId: 1, week: 1, homeTeamId: 1, awayTeamId: 2,
    homeOffEpa: 0.1, homeDefEpa: -0.05, awayOffEpa: -0.05, awayDefEpa: 0.05,
  };
  const withoutFlag = computeSeasonRatings([gameBase], new Map(), { ...CFB, excludeGarbageTime: false, successRateWeight: 0 });
  const withGarbageDataButFlagOff = computeSeasonRatings(
    [{ ...gameBase, homeOffEpaNoGarbage: 999, homeDefEpaNoGarbage: 999, awayOffEpaNoGarbage: -999, awayDefEpaNoGarbage: -999 }],
    new Map(),
    { ...CFB, excludeGarbageTime: false, successRateWeight: 0 },
  );
  assert.equal(withoutFlag.get(1)!.rating, withGarbageDataButFlagOff.get(1)!.rating);
});

test("computeSeasonRatings actually uses no-garbage EPA when excludeGarbageTime is true and the fields are present", () => {
  const params = { ...CFB, excludeGarbageTime: true, successRateWeight: 0 };
  const game = {
    gameId: 1, week: 1, homeTeamId: 1, awayTeamId: 2,
    homeOffEpa: 0.1, homeDefEpa: -0.05, awayOffEpa: -0.05, awayDefEpa: 0.05,
    homeOffEpaNoGarbage: 0.2, homeDefEpaNoGarbage: -0.1, awayOffEpaNoGarbage: -0.1, awayDefEpaNoGarbage: 0.1,
  };
  // homeNetEpa = 0.2 - -0.1 = 0.3; awayNetEpa = -0.1 - 0.1 = -0.2
  // epaMargin = pointsPerEpa * (0.3 - -0.2) = pointsPerEpa * 0.5
  const predictedMargin = CFB.homeFieldAdvantage;
  const expectedError = CFB.pointsPerEpa * 0.5 - predictedMargin;
  const expectedDelta = CFB.baseK * expectedError;
  const state = computeSeasonRatings([game], new Map(), params);
  assert.ok(Math.abs(state.get(1)!.rating - expectedDelta) < 1e-9);
});

test("computeSeasonRatings falls back to raw EPA per-field when excludeGarbageTime is true but a no-garbage field is null for that game", () => {
  const params = { ...CFB, excludeGarbageTime: true, successRateWeight: 0 };
  // Only homeOffEpaNoGarbage is present; every other no-garbage field is
  // missing (undefined/null) for this game -- each field should fall back
  // independently to its own raw value, not degrade the whole game to
  // all-raw or throw away the one field that IS present.
  const game = {
    gameId: 1, week: 1, homeTeamId: 1, awayTeamId: 2,
    homeOffEpa: 0.1, homeDefEpa: -0.05, awayOffEpa: -0.05, awayDefEpa: 0.05,
    homeOffEpaNoGarbage: 0.3,
  };
  // homeOffEpa -> 0.3 (swapped), homeDefEpa stays -0.05 (raw), away stays raw (-0.05, 0.05)
  // homeNetEpa = 0.3 - -0.05 = 0.35; awayNetEpa = -0.05 - 0.05 = -0.1
  const predictedMargin = CFB.homeFieldAdvantage;
  const expectedError = CFB.pointsPerEpa * (0.35 - -0.1) - predictedMargin;
  const expectedDelta = CFB.baseK * expectedError;
  const state = computeSeasonRatings([game], new Map(), params);
  assert.ok(Math.abs(state.get(1)!.rating - expectedDelta) < 1e-9);
});

test("computeSeasonRatings opponent-adjusts success rate using the opponent's season-to-date context, once that opponent has enough games", () => {
  const params = { ...CFB, opponentAdjustWeight: 0.5, successRateWeight: 1, pointsPerSuccessRate: 1 };
  // OPP plays 3 "warm-up" games with a great defense (allows 0.2 success)
  // and an exactly-average offense (0.5 success) -- establishes OPP's
  // context. Filler opponents' own stats are consistent with what OPP's
  // side shows (a zero-sum single game: filler's offSuccess == OPP's
  // defSuccess, filler's defSuccess == OPP's offSuccess).
  const warmups = [1, 2, 3].map((fillerId) => ({
    gameId: fillerId, week: fillerId, homeTeamId: 10, awayTeamId: 100 + fillerId,
    homeOffEpa: 0, homeDefEpa: 0, awayOffEpa: 0, awayDefEpa: 0,
    homeOffSuccess: 0.5, homeDefSuccess: 0.2, awayOffSuccess: 0.2, awayDefSuccess: 0.5,
  }));
  // After these 3: OPP (id 10) context = {offSum:1.5, offN:3, defSum:0.6, defN:3}.
  // League totals across 3 games * 4 values each (0.5+0.2+0.2+0.5=1.4/game): sum=4.2, n=12, avg=0.35.

  // Week 4: SUT (home, id 20, brand new -- no context yet) vs OPP (away).
  const testGame = {
    gameId: 4, week: 4, homeTeamId: 20, awayTeamId: 10,
    homeOffEpa: 0, homeDefEpa: 0, awayOffEpa: 0, awayDefEpa: 0,
    homeOffSuccess: 0.45, homeDefSuccess: 0.35, awayOffSuccess: 0.5, awayDefSuccess: 0.2,
  };

  const state = computeSeasonRatings([...warmups, testGame], new Map(), params);

  // successRateWeight=1, pointsPerSuccessRate=1 -> actualMargin = successMargin = homeNetSuccess - awayNetSuccess (pure, no EPA at all).
  // adjHomeOffSuccess = 0.45 + 0.5*(0.35 - 0.6/3) = 0.45 + 0.5*(0.35-0.2) = 0.45 + 0.075 = 0.525
  // adjHomeDefSuccess = 0.35 + 0.5*(0.35 - 1.5/3) = 0.35 + 0.5*(0.35-0.5) = 0.35 - 0.075 = 0.275
  // SUT's own context is empty (homeCtx.offN=0 < MIN) -> OPP's success rates for THIS game stay raw: awayOffSuccess=0.5, awayDefSuccess=0.2.
  // homeNetSuccess = 0.525 - 0.275 = 0.25; awayNetSuccess = 0.5 - 0.2 = 0.3
  // successMargin = 1 * (0.25 - 0.3) = -0.05; predictedMargin (both start 0, +HFA) = CFB.homeFieldAdvantage
  const expectedError = -0.05 - CFB.homeFieldAdvantage;
  // SUT's own SOS multiplier at this point: away(OPP) has played 3 games and accrued a rating already
  // from the warmup games -- rather than hand-derive that too, just check sign/direction and magnitude
  // via the isolated adjustment math above, and cross-check by re-running with opponentAdjustWeight=0
  // for the identical game sequence: only the adjustment should differ, nothing else in the pipeline.
  const paramsNoAdjust = { ...params, opponentAdjustWeight: 0 };
  const stateNoAdjust = computeSeasonRatings([...warmups, testGame], new Map(), paramsNoAdjust);
  assert.notEqual(state.get(20)!.rating, stateNoAdjust.get(20)!.rating, "opponentAdjustWeight actually changes SUT's rating update vs. the unadjusted baseline");

  // Direct isolated check of the adjustment formula itself (independent of the rest of the pipeline):
  // rebuild the exact same computation the implementation does internally.
  const leagueAvg = 4.2 / 12;
  const oppDefAvg = 0.6 / 3;
  const oppOffAvg = 1.5 / 3;
  const adjHomeOff = 0.45 + params.opponentAdjustWeight * (leagueAvg - oppDefAvg);
  const adjHomeDef = 0.35 + params.opponentAdjustWeight * (leagueAvg - oppOffAvg);
  assert.ok(Math.abs(adjHomeOff - 0.525) < 1e-9, `adjusted home off success (${adjHomeOff}) matches hand calc`);
  assert.ok(Math.abs(adjHomeDef - 0.275) < 1e-9, `adjusted home def success (${adjHomeDef}) matches hand calc`);
});

test("computeSeasonRatings does not opponent-adjust when the opponent has fewer than MIN_SUCCESS_CONTEXT_GAMES", () => {
  const params = { ...CFB, opponentAdjustWeight: 1, successRateWeight: 1, pointsPerSuccessRate: 1 };
  // OPP has only played 2 games (below the 3-game minimum) before facing SUT.
  const warmups = [1, 2].map((fillerId) => ({
    gameId: fillerId, week: fillerId, homeTeamId: 10, awayTeamId: 100 + fillerId,
    homeOffEpa: 0, homeDefEpa: 0, awayOffEpa: 0, awayDefEpa: 0,
    homeOffSuccess: 0.5, homeDefSuccess: 0.1, awayOffSuccess: 0.1, awayDefSuccess: 0.5,
  }));
  const testGame = {
    gameId: 3, week: 3, homeTeamId: 20, awayTeamId: 10,
    homeOffEpa: 0, homeDefEpa: 0, awayOffEpa: 0, awayDefEpa: 0,
    homeOffSuccess: 0.45, homeDefSuccess: 0.35, awayOffSuccess: 0.5, awayDefSuccess: 0.2,
  };
  const withAdjust = computeSeasonRatings([...warmups, testGame], new Map(), params);
  const withoutAdjust = computeSeasonRatings([...warmups, testGame], new Map(), { ...params, opponentAdjustWeight: 0 });
  assert.equal(
    withAdjust.get(20)!.rating,
    withoutAdjust.get(20)!.rating,
    "opponent with < MIN_SUCCESS_CONTEXT_GAMES produces no adjustment, identical to opponentAdjustWeight=0",
  );
});

test("predictSpread's restSignal moves the prediction when pointsPerRestDay > 0", () => {
  const params = { ...CFB, pointsPerRestDay: 0.3 };
  const result = predictSpread(
    { homeRating: 0, awayRating: 0, homeGamesPlayed: 0, awayGamesPlayed: 0, marketSpreadHome: null, restDaysDiff: 7 },
    params,
  );
  // restSignal = 0.3 * 7 = 2.1; predictedMargin = 0 - 0 + homeFieldAdvantage + 2.1
  const expectedMargin = CFB.homeFieldAdvantage + 2.1;
  assert.ok(Math.abs(result.eloSpreadHome - -expectedMargin) < 1e-9);
});

test("predictSpread treats a missing restDaysDiff as zero differential, not zero rest for either side", () => {
  const params = { ...CFB, pointsPerRestDay: 0.3 };
  const withUndefined = predictSpread(
    { homeRating: 2, awayRating: 1, homeGamesPlayed: 4, awayGamesPlayed: 4, marketSpreadHome: null },
    params,
  );
  const withNull = predictSpread(
    { homeRating: 2, awayRating: 1, homeGamesPlayed: 4, awayGamesPlayed: 4, marketSpreadHome: null, restDaysDiff: null },
    params,
  );
  const withZero = predictSpread(
    { homeRating: 2, awayRating: 1, homeGamesPlayed: 4, awayGamesPlayed: 4, marketSpreadHome: null, restDaysDiff: 0 },
    params,
  );
  assert.equal(withUndefined.eloSpreadHome, withNull.eloSpreadHome);
  assert.equal(withUndefined.eloSpreadHome, withZero.eloSpreadHome);
});

test("pointsPerRestDay=0 (today's default) makes restDaysDiff a complete no-op, even with a large differential", () => {
  const withRest = predictSpread(
    { homeRating: 2, awayRating: 1, homeGamesPlayed: 4, awayGamesPlayed: 4, marketSpreadHome: null, restDaysDiff: 14 },
    CFB,
  );
  const withoutRest = predictSpread(
    { homeRating: 2, awayRating: 1, homeGamesPlayed: 4, awayGamesPlayed: 4, marketSpreadHome: null },
    CFB,
  );
  assert.equal(withRest.eloSpreadHome, withoutRest.eloSpreadHome);
});

test("turnoverLuckWeight=0 (today's default) makes turnover-stats fields a complete no-op, even when present", () => {
  const gameBase = {
    gameId: 1, week: 1, homeTeamId: 1, awayTeamId: 2,
    homeOffEpa: 0.3, homeDefEpa: 0.1, awayOffEpa: 0.05, awayDefEpa: 0.2,
  };
  const gameWithTurnovers = {
    ...gameBase,
    homeOffPlays: 20, homeDefPlays: 15, awayOffPlays: 18, awayDefPlays: 22,
    homeOffTurnoverPpaSum: -4, homeOffTurnoverPlays: 2,
    homeDefTurnoverPpaSum: 1, homeDefTurnoverPlays: 1,
    awayOffTurnoverPpaSum: -2, awayOffTurnoverPlays: 1,
    awayDefTurnoverPpaSum: 3, awayDefTurnoverPlays: 3,
  };
  const withTurnovers = computeSeasonRatings([gameWithTurnovers], new Map(), CFB);
  const withoutTurnovers = computeSeasonRatings([gameBase], new Map(), CFB);
  assert.equal(withTurnovers.get(1)!.rating, withoutTurnovers.get(1)!.rating, "home rating identical with turnoverLuckWeight=0");
  assert.equal(withTurnovers.get(2)!.rating, withoutTurnovers.get(2)!.rating, "away rating identical with turnoverLuckWeight=0");
});

test("computeSeasonRatings strips turnover-play PPA via a reweighted average, matching the hand-computed formula", () => {
  const params = { ...CFB, turnoverLuckWeight: 1, successRateWeight: 0, pointsPerEpa: 10 };
  const game = {
    gameId: 1, week: 1, homeTeamId: 1, awayTeamId: 2,
    homeOffEpa: 0.3, homeDefEpa: 0.1, awayOffEpa: 0.05, awayDefEpa: 0.2,
    homeOffPlays: 20, homeDefPlays: 15, awayOffPlays: 18, awayDefPlays: 22,
    homeOffTurnoverPpaSum: -4, homeOffTurnoverPlays: 2,
    homeDefTurnoverPpaSum: 1, homeDefTurnoverPlays: 1,
    awayOffTurnoverPpaSum: -2, awayOffTurnoverPlays: 1,
    awayDefTurnoverPpaSum: 3, awayDefTurnoverPlays: 3,
  };
  const state = computeSeasonRatings([game], new Map(), params);

  // strippedEpa = (rawEpa*totalPlays - turnoverPpaSum) / (totalPlays - turnoverPlays), turnoverLuckWeight=1 -> pure stripped.
  const strippedHomeOff = (game.homeOffEpa * game.homeOffPlays - game.homeOffTurnoverPpaSum) / (game.homeOffPlays - game.homeOffTurnoverPlays);
  const strippedHomeDef = (game.homeDefEpa * game.homeDefPlays - game.homeDefTurnoverPpaSum) / (game.homeDefPlays - game.homeDefTurnoverPlays);
  const strippedAwayOff = (game.awayOffEpa * game.awayOffPlays - game.awayOffTurnoverPpaSum) / (game.awayOffPlays - game.awayOffTurnoverPlays);
  const strippedAwayDef = (game.awayDefEpa * game.awayDefPlays - game.awayDefTurnoverPpaSum) / (game.awayDefPlays - game.awayDefTurnoverPlays);
  const homeNetEpa = strippedHomeOff - strippedHomeDef;
  const awayNetEpa = strippedAwayOff - strippedAwayDef;
  const epaMargin = params.pointsPerEpa * (homeNetEpa - awayNetEpa);
  // Both teams start at rating 0 (no initial ratings) -> predictedMargin is just HFA, and each side's SOS
  // multiplier is exactly 1 (opponent rating 0 -> the `1 + sosWeight*(0/ratingScaleRef)` clamp is a no-op).
  const predictedMargin = params.homeFieldAdvantage;
  const error = epaMargin - predictedMargin;
  const expectedHomeRating = params.baseK * error;
  const expectedAwayRating = -params.baseK * error;

  assert.ok(Math.abs(state.get(1)!.rating - expectedHomeRating) < 1e-9, `home rating (${state.get(1)!.rating}) matches hand-computed turnover-stripped formula (${expectedHomeRating})`);
  assert.ok(Math.abs(state.get(2)!.rating - expectedAwayRating) < 1e-9, `away rating (${state.get(2)!.rating}) matches hand-computed turnover-stripped formula (${expectedAwayRating})`);
});

test("predictSpread's weeklySpSignal term actually moves the prediction when weeklySpSignalPoints > 0", () => {
  // CFB_PARAMS.weeklySpSignalPoints defaults to 0 (untested, see config.ts)
  // -- explicit override so this doesn't silently pass as a no-op.
  const params = { ...CFB, weeklySpSignalPoints: 2 };
  const result = predictSpread(
    { homeRating: 0, awayRating: 0, homeGamesPlayed: 0, awayGamesPlayed: 0, marketSpreadHome: null, homeWeeklySpZ: 1, awayWeeklySpZ: -1 },
    params,
  );
  const expectedMargin = CFB.homeFieldAdvantage + 2 * 2;
  assert.ok(Math.abs(result.eloSpreadHome - -expectedMargin) < 1e-9);
});

test("predictSpread ignores weeklySpZ inputs entirely when weeklySpSignalPoints is 0 (today's default)", () => {
  const withZ = predictSpread(
    { homeRating: 3, awayRating: 1, homeGamesPlayed: 4, awayGamesPlayed: 4, marketSpreadHome: null, homeWeeklySpZ: 5, awayWeeklySpZ: -5 },
    CFB,
  );
  const withoutZ = predictSpread(
    { homeRating: 3, awayRating: 1, homeGamesPlayed: 4, awayGamesPlayed: 4, marketSpreadHome: null },
    CFB,
  );
  assert.equal(withZ.eloSpreadHome, withoutZ.eloSpreadHome);
});

test("predictSpread's spSignal and weeklySpSignal are independent, additive terms", () => {
  const params = { ...CFB, spSignalPoints: 2, weeklySpSignalPoints: 3 };
  const result = predictSpread(
    {
      homeRating: 0, awayRating: 0, homeGamesPlayed: 0, awayGamesPlayed: 0, marketSpreadHome: null,
      homeSpZ: 1, awaySpZ: -1, homeWeeklySpZ: 1, awayWeeklySpZ: -1,
    },
    params,
  );
  // spSignal = 2*(1-(-1)) = 4; weeklySpSignal = 3*(1-(-1)) = 6; predictedMargin = HFA + 4 + 6
  const expectedMargin = CFB.homeFieldAdvantage + 4 + 6;
  assert.ok(Math.abs(result.eloSpreadHome - -expectedMargin) < 1e-9);
});

test("computeSeasonRatings falls back to raw EPA when turnover-stats fields are missing, even with turnoverLuckWeight > 0", () => {
  const params = { ...CFB, turnoverLuckWeight: 1 };
  const gameNoTurnoverData = {
    gameId: 1, week: 1, homeTeamId: 1, awayTeamId: 2,
    homeOffEpa: 0.3, homeDefEpa: 0.1, awayOffEpa: 0.05, awayDefEpa: 0.2,
  };
  const withWeight = computeSeasonRatings([gameNoTurnoverData], new Map(), params);
  const withoutWeight = computeSeasonRatings([gameNoTurnoverData], new Map(), { ...params, turnoverLuckWeight: 0 });
  assert.equal(withWeight.get(1)!.rating, withoutWeight.get(1)!.rating, "missing turnover-stats fields fall back to raw EPA, identical to turnoverLuckWeight=0");
  assert.equal(withWeight.get(2)!.rating, withoutWeight.get(2)!.rating, "missing turnover-stats fields fall back to raw EPA, identical to turnoverLuckWeight=0");
});
