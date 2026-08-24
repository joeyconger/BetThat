import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeWeightedSuccessRate,
  computeWeightedEpa,
  buildTeamPerformances,
  buildTeamPerformancesEpa,
  type RawPlayForPerformance,
  type GamePlaysGroup,
} from "./gamePerformance.js";

function play(overrides: Partial<RawPlayForPerformance>): RawPlayForPerformance {
  return {
    offenseTeamId: 1,
    defenseTeamId: 2,
    down: 1,
    distance: 10,
    yardsGained: 5,
    playType: "Rush",
    offenseScore: 0,
    defenseScore: 0,
    period: 1,
    clockMinutes: 15,
    clockSeconds: 0,
    ppa: 0,
    ...overrides,
  };
}

test("computeWeightedSuccessRate: a garbage-time failed play counts for much less than a competitive successful play", () => {
  const plays: RawPlayForPerformance[] = [
    // Competitive (0-0, Q1 15:00): full weight 1.0, success (6 >= 50% of 10).
    play({ down: 1, distance: 10, yardsGained: 6, offenseScore: 0, defenseScore: 0, period: 1, clockMinutes: 15, clockSeconds: 0 }),
    // Extreme garbage time (50pt margin, Q4 0:00): weight 0.10, fail (2 < 50% of 10).
    play({ down: 1, distance: 10, yardsGained: 2, offenseScore: 50, defenseScore: 0, period: 4, clockMinutes: 0, clockSeconds: 0 }),
  ];
  const result = computeWeightedSuccessRate(plays, 1);
  // (1*1.0 + 0*0.10) / (1.0 + 0.10) = 1/1.1
  assert.ok(Math.abs(result.weightedSuccessRate! - 1 / 1.1) < 1e-9, `got ${result.weightedSuccessRate}`);
  assert.ok(Math.abs(result.weightedPlayCount - 1.1) < 1e-9, `got ${result.weightedPlayCount}`);
  // Sanity: the naive unweighted average (0.5) would hide the garbage-time discount.
  assert.notEqual(result.weightedSuccessRate, 0.5);
});

test("computeWeightedSuccessRate: non-scrimmage plays and plays for the other team are excluded", () => {
  const plays: RawPlayForPerformance[] = [
    play({ offenseTeamId: 1, down: 1, distance: 10, yardsGained: 6 }),
    play({ offenseTeamId: 1, playType: "Punt", down: 4, distance: 10, yardsGained: 40 }),
    play({ offenseTeamId: 2, down: 1, distance: 10, yardsGained: 6 }),
  ];
  const result = computeWeightedSuccessRate(plays, 1);
  assert.equal(result.weightedPlayCount, 1);
});

test("computeWeightedSuccessRate: returns null with zero judgeable plays", () => {
  const result = computeWeightedSuccessRate([], 1);
  assert.equal(result.weightedSuccessRate, null);
  assert.equal(result.weightedPlayCount, 0);
});

test("buildTeamPerformances: produces one TeamPerformance per side per game, with correct raw values", () => {
  const games: GamePlaysGroup[] = [
    {
      gameId: 1,
      homeTeamId: 100,
      awayTeamId: 200,
      plays: [
        play({ offenseTeamId: 100, defenseTeamId: 200, down: 1, distance: 10, yardsGained: 6 }), // success
        play({ offenseTeamId: 200, defenseTeamId: 100, down: 1, distance: 10, yardsGained: 1 }), // fail
      ],
    },
  ];
  const performances = buildTeamPerformances(games);
  assert.equal(performances.length, 2);
  const homePerf = performances.find((p) => p.teamId === 100)!;
  const awayPerf = performances.find((p) => p.teamId === 200)!;
  assert.equal(homePerf.opponentId, 200);
  assert.equal(homePerf.rawOffenseValue, 1);
  assert.equal(awayPerf.opponentId, 100);
  assert.equal(awayPerf.rawOffenseValue, 0);
});

test("buildTeamPerformances: a side with no judgeable plays is omitted, not zero-filled", () => {
  const games: GamePlaysGroup[] = [
    {
      gameId: 1,
      homeTeamId: 100,
      awayTeamId: 200,
      plays: [play({ offenseTeamId: 100, defenseTeamId: 200, down: 1, distance: 10, yardsGained: 6 })],
    },
  ];
  const performances = buildTeamPerformances(games);
  assert.equal(performances.length, 1);
  assert.equal(performances[0]!.teamId, 100);
});

test("computeWeightedEpa: a weighted mean, not a weighted proportion -- garbage-time plays count for less", () => {
  const plays: RawPlayForPerformance[] = [
    // Competitive (0-0, Q1 15:00): full weight 1.0, ppa=0.8.
    play({ ppa: 0.8, offenseScore: 0, defenseScore: 0, period: 1, clockMinutes: 15, clockSeconds: 0 }),
    // Extreme garbage time (50pt margin, Q4 0:00): weight 0.10, ppa=-2.0 (a real
    // play, just discounted -- not excluded the way a null ppa would be).
    play({ ppa: -2.0, offenseScore: 50, defenseScore: 0, period: 4, clockMinutes: 0, clockSeconds: 0 }),
  ];
  const result = computeWeightedEpa(plays, 1);
  // (0.8*1.0 + -2.0*0.10) / (1.0+0.10) = 0.6/1.1
  assert.ok(Math.abs(result.weightedEpa! - 0.6 / 1.1) < 1e-9, `got ${result.weightedEpa}`);
  assert.ok(Math.abs(result.weightedPlayCount - 1.1) < 1e-9, `got ${result.weightedPlayCount}`);
  // Sanity: the naive unweighted average (-0.6) would hide the garbage-time discount.
  assert.notEqual(result.weightedEpa, -0.6);
});

test("computeWeightedEpa: a play with null ppa is excluded from both sums, unlike a real (even negative) ppa value", () => {
  const plays: RawPlayForPerformance[] = [
    play({ ppa: 0.5 }),
    play({ ppa: null }),
  ];
  const result = computeWeightedEpa(plays, 1);
  assert.equal(result.weightedEpa, 0.5);
  assert.equal(result.weightedPlayCount, 1);
});

test("computeWeightedEpa: non-scrimmage plays and plays for the other team are excluded, same as success rate", () => {
  const plays: RawPlayForPerformance[] = [
    play({ offenseTeamId: 1, ppa: 0.5 }),
    play({ offenseTeamId: 1, playType: "Punt", ppa: 10 }),
    play({ offenseTeamId: 2, ppa: 0.5 }),
  ];
  const result = computeWeightedEpa(plays, 1);
  assert.equal(result.weightedPlayCount, 1);
});

test("computeWeightedEpa: returns null with zero judgeable plays", () => {
  const result = computeWeightedEpa([], 1);
  assert.equal(result.weightedEpa, null);
  assert.equal(result.weightedPlayCount, 0);
});

test("buildTeamPerformancesEpa: produces one TeamPerformance per side per game, with correct raw values", () => {
  const games: GamePlaysGroup[] = [
    {
      gameId: 1,
      homeTeamId: 100,
      awayTeamId: 200,
      plays: [
        play({ offenseTeamId: 100, defenseTeamId: 200, ppa: 0.4 }),
        play({ offenseTeamId: 200, defenseTeamId: 100, ppa: -0.3 }),
      ],
    },
  ];
  const performances = buildTeamPerformancesEpa(games);
  assert.equal(performances.length, 2);
  const homePerf = performances.find((p) => p.teamId === 100)!;
  const awayPerf = performances.find((p) => p.teamId === 200)!;
  assert.equal(homePerf.opponentId, 200);
  assert.equal(homePerf.rawOffenseValue, 0.4);
  assert.equal(awayPerf.opponentId, 100);
  assert.equal(awayPerf.rawOffenseValue, -0.3);
});

test("buildTeamPerformancesEpa: a side with no judgeable plays is omitted, not zero-filled", () => {
  const games: GamePlaysGroup[] = [
    {
      gameId: 1,
      homeTeamId: 100,
      awayTeamId: 200,
      plays: [play({ offenseTeamId: 100, defenseTeamId: 200, ppa: 0.4 })],
    },
  ];
  const performances = buildTeamPerformancesEpa(games);
  assert.equal(performances.length, 1);
  assert.equal(performances[0]!.teamId, 100);
});

test("buildTeamPerformances: aggregates across multiple games correctly", () => {
  const games: GamePlaysGroup[] = [
    {
      gameId: 1,
      homeTeamId: 100,
      awayTeamId: 200,
      plays: [play({ offenseTeamId: 100, defenseTeamId: 200, down: 1, distance: 10, yardsGained: 6 })],
    },
    {
      gameId: 2,
      homeTeamId: 100,
      awayTeamId: 300,
      plays: [play({ offenseTeamId: 100, defenseTeamId: 300, down: 1, distance: 10, yardsGained: 2 })],
    },
  ];
  const performances = buildTeamPerformances(games);
  assert.equal(performances.length, 2);
  assert.ok(performances.some((p) => p.teamId === 100 && p.opponentId === 200));
  assert.ok(performances.some((p) => p.teamId === 100 && p.opponentId === 300));
});
