import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFieldPositionPerformances, computeFgEfficiency, type RawPlayForSpecialTeams } from "./specialTeams.js";

const HOME = 1;
const AWAY = 2;

function play(overrides: Partial<RawPlayForSpecialTeams>): RawPlayForSpecialTeams {
  return {
    gameId: 100,
    homeTeamId: HOME,
    awayTeamId: AWAY,
    offenseTeamId: null,
    playType: "Rush",
    driveId: "d1",
    driveNumber: 1,
    playNumber: 1,
    yardsToGoal: null,
    ...overrides,
  };
}

test("buildFieldPositionPerformances: kickoff-first drive credits the RECEIVING team's first scrimmage play, kicking team as opponent", () => {
  const plays: RawPlayForSpecialTeams[] = [
    play({ driveId: "d1", driveNumber: 1, playNumber: 1, playType: "Kickoff", offenseTeamId: HOME, yardsToGoal: 65 }),
    play({ driveId: "d1", driveNumber: 1, playNumber: 2, playType: "Pass Reception", offenseTeamId: AWAY, yardsToGoal: 75 }),
    play({ driveId: "d1", driveNumber: 1, playNumber: 3, playType: "Rush", offenseTeamId: AWAY, yardsToGoal: 70 }),
  ];
  const perfs = buildFieldPositionPerformances(plays);
  assert.equal(perfs.length, 1);
  assert.equal(perfs[0]!.teamId, AWAY, "receiving team is credited, not the kicking team");
  assert.equal(perfs[0]!.opponentId, HOME, "kicking team is the opponent (their coverage/DEF)");
  assert.equal(perfs[0]!.rawOffenseValue, 100 - 75, "score = 100 - first SCRIMMAGE play's yardsToGoal, not the kickoff row's own 65");
});

test("buildFieldPositionPerformances: punt-preceded drive credits the receiving team's OWN first play (no kick row in the new drive)", () => {
  const plays: RawPlayForSpecialTeams[] = [
    play({ driveId: "d1", driveNumber: 1, playNumber: 1, playType: "Rush", offenseTeamId: HOME, yardsToGoal: 70 }),
    play({ driveId: "d1", driveNumber: 1, playNumber: 2, playType: "Punt", offenseTeamId: HOME, yardsToGoal: 55 }),
    play({ driveId: "d2", driveNumber: 2, playNumber: 1, playType: "Rush", offenseTeamId: AWAY, yardsToGoal: 42 }),
  ];
  const perfs = buildFieldPositionPerformances(plays);
  assert.equal(perfs.length, 1);
  assert.equal(perfs[0]!.teamId, AWAY);
  assert.equal(perfs[0]!.opponentId, HOME);
  assert.equal(perfs[0]!.rawOffenseValue, 100 - 42);
});

test("buildFieldPositionPerformances: a turnover-preceded drive is excluded entirely (no Kickoff, prev drive didn't end in Punt)", () => {
  const plays: RawPlayForSpecialTeams[] = [
    play({ driveId: "d1", driveNumber: 1, playNumber: 1, playType: "Rush", offenseTeamId: HOME, yardsToGoal: 60 }),
    play({ driveId: "d1", driveNumber: 1, playNumber: 2, playType: "Interception", offenseTeamId: HOME, yardsToGoal: 50 }),
    play({ driveId: "d2", driveNumber: 2, playNumber: 1, playType: "Rush", offenseTeamId: AWAY, yardsToGoal: 50 }),
  ];
  const perfs = buildFieldPositionPerformances(plays);
  assert.equal(perfs.length, 0);
});

test("buildFieldPositionPerformances: the first overtime possession (no preceding kickoff/punt at all) is excluded, matching CFB's no-kickoff OT rule", () => {
  const plays: RawPlayForSpecialTeams[] = [
    play({ driveId: "d1", driveNumber: 1, playNumber: 1, playType: "Rush", offenseTeamId: HOME, yardsToGoal: 25 }),
  ];
  const perfs = buildFieldPositionPerformances(plays);
  assert.equal(perfs.length, 0);
});

test("buildFieldPositionPerformances: a penalty before the first real snap is skipped in favor of the first SCRIMMAGE play", () => {
  const plays: RawPlayForSpecialTeams[] = [
    play({ driveId: "d1", driveNumber: 1, playNumber: 1, playType: "Kickoff", offenseTeamId: HOME, yardsToGoal: 65 }),
    play({ driveId: "d1", driveNumber: 1, playNumber: 2, playType: "Penalty", offenseTeamId: AWAY, yardsToGoal: 70 }),
    play({ driveId: "d1", driveNumber: 1, playNumber: 3, playType: "Rush", offenseTeamId: AWAY, yardsToGoal: 65 }),
  ];
  const perfs = buildFieldPositionPerformances(plays);
  assert.equal(perfs.length, 1);
  assert.equal(perfs[0]!.rawOffenseValue, 100 - 65, "should use the Rush row (yardsToGoal=65), not the Penalty row (70)");
});

test("buildFieldPositionPerformances: two games with colliding driveId/driveNumber values don't interfere with each other", () => {
  const plays: RawPlayForSpecialTeams[] = [
    play({ gameId: 100, driveId: "d1", driveNumber: 1, playNumber: 1, playType: "Kickoff", offenseTeamId: HOME, yardsToGoal: 65 }),
    play({ gameId: 100, driveId: "d1", driveNumber: 1, playNumber: 2, playType: "Rush", offenseTeamId: AWAY, yardsToGoal: 75 }),
    play({ gameId: 200, homeTeamId: 3, awayTeamId: 4, driveId: "d1", driveNumber: 1, playNumber: 1, playType: "Kickoff", offenseTeamId: 3, yardsToGoal: 65 }),
    play({ gameId: 200, homeTeamId: 3, awayTeamId: 4, driveId: "d1", driveNumber: 1, playNumber: 2, playType: "Rush", offenseTeamId: 4, yardsToGoal: 60 }),
  ];
  const perfs = buildFieldPositionPerformances(plays);
  assert.equal(perfs.length, 2);
  const game100 = perfs.find((p) => p.teamId === AWAY)!;
  const game200 = perfs.find((p) => p.teamId === 4)!;
  assert.equal(game100.rawOffenseValue, 100 - 75);
  assert.equal(game200.rawOffenseValue, 100 - 60);
});

const FG = "Field Goal Good";
const FG_MISS = "Field Goal Missed";

function fgPlay(offenseTeamId: number, made: boolean, yardsToGoal: number): RawPlayForSpecialTeams {
  return play({ playType: made ? FG : FG_MISS, offenseTeamId, yardsToGoal, driveId: `fg-${Math.random()}` });
}

test("computeFgEfficiency: a team making every kick in a bucket with a below-100% league rate gets a positive excess rate", () => {
  // League bucket: 10 attempts at the same short distance (bucket >= 20
  // threshold not met at 10, so this test deliberately stays under 20 to
  // exercise the overall-rate fallback instead -- see the next test for
  // the per-bucket path.
  const plays: RawPlayForSpecialTeams[] = [];
  // Team A: 3/3. Team B: 2/4 (so overall rate is 5/7, not 100%).
  plays.push(fgPlay(1, true, 20), fgPlay(1, true, 20), fgPlay(1, true, 20));
  plays.push(fgPlay(2, true, 20), fgPlay(2, true, 20), fgPlay(2, false, 20), fgPlay(2, false, 20));

  const results = computeFgEfficiency(plays, 10);
  const overallRate = 5 / 7;
  const teamA = results.get(1)!;
  const teamB = results.get(2)!;
  assert.equal(teamA.attempts, 3);
  const expectedExcessA = 3 * (1 - overallRate);
  assert.ok(Math.abs(teamA.shrunkExcessMakeRate - expectedExcessA / (3 + 10)) < 1e-9);
  assert.ok(teamA.shrunkExcessMakeRate > 0, "team A made more than the league rate -> positive excess");
  assert.ok(teamB.shrunkExcessMakeRate < teamA.shrunkExcessMakeRate, "team B's worse rate should score lower than team A's");
});

test("computeFgEfficiency: shrinkage is exactly excessSum / (attempts + fgShrinkK)", () => {
  const plays: RawPlayForSpecialTeams[] = [];
  for (let i = 0; i < 25; i++) plays.push(fgPlay(1, true, 20));
  for (let i = 0; i < 25; i++) plays.push(fgPlay(2, false, 20));
  const results = computeFgEfficiency(plays, 20);
  const teamA = results.get(1)!;
  // Bucket has 50 attempts (>=20 threshold), so its own empirical rate is
  // used: makes=25/50=0.5. Team A: excessSum = 25*(1-0.5) = 12.5.
  assert.ok(Math.abs(teamA.shrunkExcessMakeRate - 12.5 / (25 + 20)) < 1e-9);
});

test("computeFgEfficiency: a team with zero FG attempts simply doesn't appear in the result map", () => {
  const plays: RawPlayForSpecialTeams[] = [fgPlay(1, true, 20), fgPlay(1, false, 20)];
  const results = computeFgEfficiency(plays, 10);
  assert.equal(results.has(2), false);
});
