import { test } from "node:test";
import assert from "node:assert/strict";
import { computeComponentFeature, computeBaseMargin, JOINT_REFIT_COMPONENTS, buildAsOfWeekGames } from "./jointRefitMath.js";
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

// --- buildAsOfWeekGames ---

const PREDICTIVE_PARAMS = { ...CFB, excludeGarbageTime: false, turnoverLuckWeight: 0 };

test("buildAsOfWeekGames: throws when excludeGarbageTime is true (unsafe -- see doc)", () => {
  assert.throws(() => buildAsOfWeekGames([], { ...CFB, excludeGarbageTime: true }), /excludeGarbageTime/);
});

test("buildAsOfWeekGames: throws when turnoverLuckWeight > 0 (unsafe -- see doc)", () => {
  assert.throws(() => buildAsOfWeekGames([], { ...CFB, turnoverLuckWeight: 0.5 }), /turnoverLuckWeight/);
});

test("buildAsOfWeekGames: excludes a game where either team has zero prior games this season", () => {
  // Team 1 and 2's very first meeting -- neither has any prior data.
  const games = [{ season: 2024, game: baseGame({ gameId: 1, week: 1, homeTeamId: 1, awayTeamId: 2 }) }];
  const result = buildAsOfWeekGames(games, PREDICTIVE_PARAMS);
  assert.equal(result.length, 0, "a game between two teams with no prior games this season should be dropped entirely");
});

test("buildAsOfWeekGames: includes a game once BOTH teams have at least one prior game, using the prior game's own EPA as the as-of-week value", () => {
  const week1 = baseGame({ gameId: 1, week: 1, homeTeamId: 1, awayTeamId: 2, homeOffEpa: 0.3, homeDefEpa: 0.1, awayOffEpa: 0.05, awayDefEpa: 0.2 });
  // Week 3: the SAME two teams meet again -- each now has exactly 1 prior game (week 1), so this qualifies.
  const week3 = baseGame({ gameId: 2, week: 3, homeTeamId: 1, awayTeamId: 2, homeOffEpa: 0.99, homeDefEpa: 0.99, awayOffEpa: 0.99, awayDefEpa: 0.99 });

  const result = buildAsOfWeekGames([{ season: 2024, game: week1 }, { season: 2024, game: week3 }], PREDICTIVE_PARAMS);

  const week3Result = result.find((r) => r.game.gameId === 2);
  assert.ok(week3Result, "week 3's game (both teams with 1 prior game) should be included");
  // Team 1's only prior game was week1 as home: homeOffEpa=0.3, homeDefEpa=0.1
  assert.ok(Math.abs(week3Result!.game.homeOffEpa - 0.3) < 1e-9, `expected team 1's as-of-week offEpa to be its week-1 home value (0.3), got ${week3Result!.game.homeOffEpa}`);
  assert.ok(Math.abs(week3Result!.game.homeDefEpa - 0.1) < 1e-9, `got ${week3Result!.game.homeDefEpa}`);
  // Team 2's only prior game was week1 as away: awayOffEpa=0.05, awayDefEpa=0.2
  assert.ok(Math.abs(week3Result!.game.awayOffEpa - 0.05) < 1e-9, `expected team 2's as-of-week offEpa to be its week-1 away value (0.05), got ${week3Result!.game.awayOffEpa}`);
  assert.ok(Math.abs(week3Result!.game.awayDefEpa - 0.2) < 1e-9, `got ${week3Result!.game.awayDefEpa}`);
  // The real week-3 EPA values (0.99) must NOT leak into the as-of-week features.
  assert.notEqual(week3Result!.game.homeOffEpa, 0.99);
});

test("buildAsOfWeekGames: averages across MULTIPLE prior games, not just the most recent one", () => {
  const g1 = baseGame({ gameId: 1, week: 1, homeTeamId: 1, awayTeamId: 9, homeOffEpa: 0.2, homeDefEpa: 0.1, awayOffEpa: 0.1, awayDefEpa: 0.1 });
  const g2 = baseGame({ gameId: 2, week: 2, homeTeamId: 1, awayTeamId: 8, homeOffEpa: 0.4, homeDefEpa: 0.1, awayOffEpa: 0.1, awayDefEpa: 0.1 });
  // Team 1's average offEpa through week 2 = (0.2+0.4)/2 = 0.3
  const g3vs = baseGame({ gameId: 3, week: 3, homeTeamId: 1, awayTeamId: 2, homeOffEpa: 0.99, homeDefEpa: 0.99, awayOffEpa: 0.99, awayDefEpa: 0.99 });
  // team 2 needs its own prior game too, to not be gated out
  const g2prior = baseGame({ gameId: 4, week: 1, homeTeamId: 2, awayTeamId: 7, homeOffEpa: 0.05, homeDefEpa: 0.05, awayOffEpa: 0.05, awayDefEpa: 0.05 });

  const result = buildAsOfWeekGames(
    [
      { season: 2024, game: g1 },
      { season: 2024, game: g2prior },
      { season: 2024, game: g2 },
      { season: 2024, game: g3vs },
    ],
    PREDICTIVE_PARAMS,
  );

  const week3Result = result.find((r) => r.game.gameId === 3);
  assert.ok(week3Result, "team 1's 3rd game (2 prior games) should be included");
  assert.ok(Math.abs(week3Result!.game.homeOffEpa - 0.3) < 1e-9, `expected the average of team 1's 2 prior offEpa values (0.3), got ${week3Result!.game.homeOffEpa}`);
});

test("buildAsOfWeekGames: nullable component (explosiveness) is null when a team has no prior data for it, even once the EPA gate is satisfied", () => {
  const week1 = baseGame({ gameId: 1, week: 1, homeTeamId: 1, awayTeamId: 2, homeOffExplosiveness: null }); // explosiveness not yet ingested for this game
  const week2 = baseGame({ gameId: 2, week: 2, homeTeamId: 1, awayTeamId: 2, homeOffExplosiveness: 1.5 });
  const result = buildAsOfWeekGames([{ season: 2024, game: week1 }, { season: 2024, game: week2 }], PREDICTIVE_PARAMS);
  const week2Result = result.find((r) => r.game.gameId === 2);
  assert.ok(week2Result);
  assert.equal(week2Result!.game.homeOffExplosiveness, null, "team 1 has never had a non-null explosiveness value, so its as-of-week average should stay null, not 0 or throw");
});

test("buildAsOfWeekGames: resets accumulation at a season boundary", () => {
  // Team 1/2 play in season 2023 (building up history), then meet again in season 2024's week 1 -- which
  // should be gated OUT since the accumulator resets per season and neither has a 2024 game yet.
  const s2023 = baseGame({ gameId: 1, week: 1, homeTeamId: 1, awayTeamId: 2, homeOffEpa: 5, awayOffEpa: 5 });
  const s2024week1 = baseGame({ gameId: 2, week: 1, homeTeamId: 1, awayTeamId: 2 });
  const result = buildAsOfWeekGames([{ season: 2023, game: s2023 }, { season: 2024, game: s2024week1 }], PREDICTIVE_PARAMS);
  assert.equal(result.length, 0, "2024 week 1 should be gated out -- prior season's games must not carry over");
});

test("buildAsOfWeekGames: opponentAdj fields pass through unchanged (already an as-of-week quantity)", () => {
  const week1 = baseGame({ gameId: 1, week: 1, homeTeamId: 1, awayTeamId: 2 });
  const week2 = baseGame({ gameId: 2, week: 2, homeTeamId: 1, awayTeamId: 2, homeOffAdj: 0.07, homeDefAdj: -0.02, homeAdjGamesPlayed: 4 });
  const result = buildAsOfWeekGames([{ season: 2024, game: week1 }, { season: 2024, game: week2 }], PREDICTIVE_PARAMS);
  const week2Result = result.find((r) => r.game.gameId === 2);
  assert.ok(week2Result);
  assert.equal(week2Result!.game.homeOffAdj, 0.07);
  assert.equal(week2Result!.game.homeDefAdj, -0.02);
  assert.equal(week2Result!.game.homeAdjGamesPlayed, 4);
});
