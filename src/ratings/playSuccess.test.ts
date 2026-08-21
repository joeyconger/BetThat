import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSuccessfulPlay,
  isStandardDown,
  isPassingDown,
  isScrimmagePlay,
  computeTeamSplitStats,
  type ScrimmagePlayRow,
} from "./playSuccess.js";

// --- isSuccessfulPlay: exact thresholds ---

test("isSuccessfulPlay: 1st down needs >=50% of distance", () => {
  assert.equal(isSuccessfulPlay(1, 10, 5), true); // exactly 50%
  assert.equal(isSuccessfulPlay(1, 10, 4), false); // just under
  assert.equal(isSuccessfulPlay(1, 10, 6), true);
});

test("isSuccessfulPlay: 2nd down needs >=70% of distance", () => {
  assert.equal(isSuccessfulPlay(2, 10, 7), true); // exactly 70%
  assert.equal(isSuccessfulPlay(2, 10, 6), false);
  assert.equal(isSuccessfulPlay(2, 10, 8), true);
});

test("isSuccessfulPlay: 3rd/4th down needs 100% of distance (a first down)", () => {
  assert.equal(isSuccessfulPlay(3, 5, 5), true);
  assert.equal(isSuccessfulPlay(3, 5, 4), false);
  assert.equal(isSuccessfulPlay(4, 2, 2), true);
  assert.equal(isSuccessfulPlay(4, 2, 1), false);
});

test("isSuccessfulPlay: a sack (negative yardsGained) always fails", () => {
  assert.equal(isSuccessfulPlay(1, 10, -7), false);
  assert.equal(isSuccessfulPlay(3, 3, -5), false);
});

test("isSuccessfulPlay: returns null (not false) when down/distance/yardsGained is missing", () => {
  assert.equal(isSuccessfulPlay(null, 10, 5), null);
  assert.equal(isSuccessfulPlay(1, null, 5), null);
  assert.equal(isSuccessfulPlay(1, 10, null), null);
});

test("isSuccessfulPlay: returns null for a down outside 1-4 (e.g. CFBD's occasional 0)", () => {
  assert.equal(isSuccessfulPlay(0, 10, 20), null);
});

// --- isStandardDown / isPassingDown ---

test("isStandardDown: 1st down is always standard, regardless of distance", () => {
  assert.equal(isStandardDown(1, 25), true);
});

test("isStandardDown: 2nd-and-<=7 is standard, 2nd-and-8+ is not", () => {
  assert.equal(isStandardDown(2, 7), true);
  assert.equal(isStandardDown(2, 8), false);
});

test("isStandardDown: 3rd/4th-and-<=4 is standard, 3rd/4th-and-5+ is not", () => {
  assert.equal(isStandardDown(3, 4), true);
  assert.equal(isStandardDown(3, 5), false);
  assert.equal(isStandardDown(4, 4), true);
  assert.equal(isStandardDown(4, 5), false);
});

test("isPassingDown: 2nd-and-8+ is passing, 2nd-and-<=7 is not", () => {
  assert.equal(isPassingDown(2, 8), true);
  assert.equal(isPassingDown(2, 7), false);
});

test("isPassingDown: 3rd/4th-and-5+ is passing, 3rd/4th-and-<=4 is not", () => {
  assert.equal(isPassingDown(3, 5), true);
  assert.equal(isPassingDown(3, 4), false);
  assert.equal(isPassingDown(4, 5), true);
});

test("isStandardDown and isPassingDown are mutually exclusive for every down/distance combo tested", () => {
  for (const down of [1, 2, 3, 4]) {
    for (const distance of [1, 4, 5, 7, 8, 15]) {
      assert.ok(!(isStandardDown(down, distance) && isPassingDown(down, distance)), `down=${down} distance=${distance}`);
    }
  }
});

// --- isScrimmagePlay ---

test("isScrimmagePlay: rush/pass/sack variants count, special teams/penalties/timeouts don't", () => {
  assert.equal(isScrimmagePlay("Rush"), true);
  assert.equal(isScrimmagePlay("Pass Reception"), true);
  assert.equal(isScrimmagePlay("Sack"), true);
  assert.equal(isScrimmagePlay("Punt"), false);
  assert.equal(isScrimmagePlay("Kickoff"), false);
  assert.equal(isScrimmagePlay("Penalty"), false);
  assert.equal(isScrimmagePlay("Timeout"), false);
  assert.equal(isScrimmagePlay("Field Goal Good"), false);
});

// --- computeTeamSplitStats ---

function play(overrides: Partial<ScrimmagePlayRow>): ScrimmagePlayRow {
  return {
    offenseTeamId: 1,
    defenseTeamId: 2,
    down: 1,
    distance: 10,
    yardsGained: 5,
    playType: "Rush",
    ...overrides,
  };
}

test("computeTeamSplitStats: hand-computed offense success rate over a small play set", () => {
  const plays: ScrimmagePlayRow[] = [
    play({ down: 1, distance: 10, yardsGained: 5 }), // success (>=50%)
    play({ down: 1, distance: 10, yardsGained: 2 }), // fail
    play({ down: 2, distance: 5, yardsGained: 4 }), // success (>=70% of 5 = 3.5)
    play({ down: 3, distance: 3, yardsGained: 3 }), // success (100%)
  ];
  const stats = computeTeamSplitStats(plays, 1, "offense");
  assert.equal(stats.playCount, 4);
  assert.equal(stats.successRate, 3 / 4);
});

test("computeTeamSplitStats: defense side aggregates the same plays from the opposing team's id", () => {
  const plays: ScrimmagePlayRow[] = [
    play({ offenseTeamId: 1, defenseTeamId: 2, down: 1, distance: 10, yardsGained: 5 }),
    play({ offenseTeamId: 1, defenseTeamId: 2, down: 1, distance: 10, yardsGained: 1 }),
  ];
  const offenseStats = computeTeamSplitStats(plays, 1, "offense");
  const defenseStats = computeTeamSplitStats(plays, 2, "defense");
  assert.deepEqual(offenseStats, defenseStats);
});

test("computeTeamSplitStats: standard-downs and passing-downs splits are computed from disjoint subsets", () => {
  const plays: ScrimmagePlayRow[] = [
    play({ down: 1, distance: 10, yardsGained: 5 }), // standard, success
    play({ down: 2, distance: 3, yardsGained: 1 }), // standard, fail (needs 70% of 3 = 2.1)
    play({ down: 2, distance: 9, yardsGained: 9 }), // passing, success
    play({ down: 3, distance: 8, yardsGained: 2 }), // passing, fail
  ];
  const stats = computeTeamSplitStats(plays, 1, "offense");
  assert.equal(stats.playCount, 4);
  assert.equal(stats.standardDownsSuccessRate, 1 / 2);
  assert.equal(stats.passingDownsSuccessRate, 1 / 2);
});

test("computeTeamSplitStats: non-scrimmage plays (punts, kickoffs, penalties) are excluded entirely", () => {
  const plays: ScrimmagePlayRow[] = [
    play({ down: 1, distance: 10, yardsGained: 5 }),
    play({ playType: "Punt", down: 4, distance: 10, yardsGained: 40 }),
    play({ playType: "Kickoff", down: null, distance: null, yardsGained: 65 }),
    play({ playType: "Penalty", down: 1, distance: 10, yardsGained: 0 }),
  ];
  const stats = computeTeamSplitStats(plays, 1, "offense");
  assert.equal(stats.playCount, 1);
});

test("computeTeamSplitStats: plays belonging to a different team are excluded", () => {
  const plays: ScrimmagePlayRow[] = [
    play({ offenseTeamId: 1, down: 1, distance: 10, yardsGained: 5 }),
    play({ offenseTeamId: 99, down: 1, distance: 10, yardsGained: 5 }),
  ];
  const stats = computeTeamSplitStats(plays, 1, "offense");
  assert.equal(stats.playCount, 1);
});

test("computeTeamSplitStats: returns nulls (not zeros or NaN) for an empty or fully-excluded play set", () => {
  const stats = computeTeamSplitStats([], 1, "offense");
  assert.equal(stats.playCount, 0);
  assert.equal(stats.successRate, null);
  assert.equal(stats.standardDownsSuccessRate, null);
  assert.equal(stats.passingDownsSuccessRate, null);
});

test("computeTeamSplitStats: a down/distance combo with no matching subset (e.g. all standard, no passing) leaves that split null", () => {
  const plays: ScrimmagePlayRow[] = [
    play({ down: 1, distance: 10, yardsGained: 5 }),
    play({ down: 2, distance: 3, yardsGained: 3 }),
  ];
  const stats = computeTeamSplitStats(plays, 1, "offense");
  assert.equal(stats.standardDownsSuccessRate, 1);
  assert.equal(stats.passingDownsSuccessRate, null);
});

test("computeTeamSplitStats: a play the success function can't judge (null down) still counts toward scrimmage filtering but not the success denominator", () => {
  const plays: ScrimmagePlayRow[] = [
    play({ down: 1, distance: 10, yardsGained: 5 }),
    play({ playType: "Rush", down: null, distance: null, yardsGained: 3 }),
  ];
  const stats = computeTeamSplitStats(plays, 1, "offense");
  assert.equal(stats.playCount, 1);
  assert.equal(stats.successRate, 1);
});
