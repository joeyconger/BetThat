import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSolveRatings, DEFAULT_SOLVE_RATING_PARAMS, type SolveRatingParams } from "./solveRatings.js";
import type { TeamPerformance } from "./opponentAdjust.js";

const A = 1;
const B = 2;

function close(actual: number, expected: number, epsilon = 1e-6): boolean {
  return Math.abs(actual - expected) < epsilon;
}

test("computeSolveRatings: converts the raw OFF-DEF composite to a points scale via pointsPerEpaSolve", () => {
  // Round-robin of 3, all raw=0.5 -> off=def=0 for everyone (same fixture
  // as opponentAdjust.test.ts's all-zero case) -- rating should be exactly
  // 0 regardless of pointsPerEpaSolve's value, since 0*anything=0.
  const performances: TeamPerformance[] = [
    { teamId: 1, opponentId: 2, rawOffenseValue: 0.5 },
    { teamId: 2, opponentId: 1, rawOffenseValue: 0.5 },
    { teamId: 2, opponentId: 3, rawOffenseValue: 0.5 },
    { teamId: 3, opponentId: 2, rawOffenseValue: 0.5 },
    { teamId: 1, opponentId: 3, rawOffenseValue: 0.5 },
    { teamId: 3, opponentId: 1, rawOffenseValue: 0.5 },
  ];
  const params: SolveRatingParams = { pointsPerEpaSolve: 100, priorWeight: 0 };
  const ratings = computeSolveRatings(performances, undefined, params);
  for (const teamId of [1, 2, 3]) {
    const r = ratings.get(teamId)!;
    assert.ok(close(r.offPoints, 0), `offPoints[${teamId}] ~0`);
    assert.ok(close(r.defPoints, 0), `defPoints[${teamId}] ~0`);
    assert.ok(close(r.rating, 0), `rating[${teamId}] ~0`);
  }
});

test("computeSolveRatings: rating is exactly offPoints - defPoints, scaled by pointsPerEpaSolve", () => {
  // Underdetermined 2-team case from opponentAdjust.test.ts: no prior ->
  // off_A=def_B=0.05, off_B=def_A=-0.05 exactly (hand-derived there).
  const performances: TeamPerformance[] = [
    { teamId: A, opponentId: B, rawOffenseValue: 0.6 },
    { teamId: B, opponentId: A, rawOffenseValue: 0.4 },
  ];
  const params: SolveRatingParams = { pointsPerEpaSolve: 100, priorWeight: 0 };
  const ratings = computeSolveRatings(performances, undefined, params);
  const a = ratings.get(A)!;
  // off_A=0.05, def_A=-0.05 -> offPoints=5, defPoints=-5, rating=10.
  assert.ok(close(a.offPoints, 5), `offPoints[A] ~5 (got ${a.offPoints})`);
  assert.ok(close(a.defPoints, -5), `defPoints[A] ~-5 (got ${a.defPoints})`);
  assert.ok(close(a.rating, 10), `rating[A] ~10 (got ${a.rating})`);
  assert.ok(close(a.rating, a.offPoints - a.defPoints), "rating must equal offPoints - defPoints exactly");
});

test("computeSolveRatings: gamesPlayed is the real game count, not opponentAdjust's doubled offense+defense appearance count", () => {
  // A plays 2 games (vs B and vs C) -- 2 real games, even though
  // opponentAdjust.ts's teamDiagnostics.gamesPlayed would report 4 (2 off
  // + 2 def appearances).
  const performances: TeamPerformance[] = [
    { teamId: A, opponentId: B, rawOffenseValue: 0.5 },
    { teamId: B, opponentId: A, rawOffenseValue: 0.5 },
    { teamId: A, opponentId: 3, rawOffenseValue: 0.5 },
    { teamId: 3, opponentId: A, rawOffenseValue: 0.5 },
  ];
  const ratings = computeSolveRatings(performances, undefined, { pointsPerEpaSolve: 100, priorWeight: 0 });
  assert.equal(ratings.get(A)!.gamesPlayed, 2);
});

test("computeSolveRatings: priorWeight=0 ignores priorSolve entirely, even when one is provided", () => {
  const performances: TeamPerformance[] = [
    { teamId: 1, opponentId: 2, rawOffenseValue: 0.5 },
    { teamId: 2, opponentId: 1, rawOffenseValue: 0.5 },
    { teamId: 2, opponentId: 3, rawOffenseValue: 0.5 },
    { teamId: 3, opponentId: 2, rawOffenseValue: 0.5 },
    { teamId: 1, opponentId: 3, rawOffenseValue: 0.5 },
    { teamId: 3, opponentId: 1, rawOffenseValue: 0.5 },
  ];
  const priorSolve = new Map([[1, { off: 10, def: -10 }]]);
  const withZeroWeight = computeSolveRatings(performances, priorSolve, { pointsPerEpaSolve: 100, priorWeight: 0 });
  const withNoPrior = computeSolveRatings(performances, undefined, { pointsPerEpaSolve: 100, priorWeight: 0 });
  assert.equal(withZeroWeight.get(1)!.rating, withNoPrior.get(1)!.rating);
});

test("computeSolveRatings: a nonzero priorWeight actually pulls the rating toward the prior", () => {
  // NOTE: does NOT assert teams 2/3 (no prior entry of their own) stay
  // unaffected -- an earlier version of this test did, and was wrong. In
  // a graph this small (3 teams), a large prior on just one team
  // propagates through the whole coupled system (empirically verified: it
  // pulls teams 2 and 3 to nearly the SAME rating as team 1 here, not a
  // small nudge) -- the same "don't assume a well-connected team resists
  // a perturbation" lesson opponentAdjust.ts's own tests already learned
  // the hard way. What's robustly true regardless of graph size is that
  // team 1's OWN rating moves toward its prior.
  const performances: TeamPerformance[] = [
    { teamId: 1, opponentId: 2, rawOffenseValue: 0.5 },
    { teamId: 2, opponentId: 1, rawOffenseValue: 0.5 },
    { teamId: 2, opponentId: 3, rawOffenseValue: 0.5 },
    { teamId: 3, opponentId: 2, rawOffenseValue: 0.5 },
    { teamId: 1, opponentId: 3, rawOffenseValue: 0.5 },
    { teamId: 3, opponentId: 1, rawOffenseValue: 0.5 },
  ];
  const priorSolve = new Map([[1, { off: 10, def: -10 }]]);
  const noPrior = computeSolveRatings(performances, undefined, { pointsPerEpaSolve: 1, priorWeight: 0 });
  const withPrior = computeSolveRatings(performances, priorSolve, { pointsPerEpaSolve: 1, priorWeight: 2 });
  assert.ok(close(noPrior.get(1)!.rating, 0), "no-prior baseline should be exactly 0");
  assert.ok(withPrior.get(1)!.rating > 0, "a positive prior should pull the rating above the no-prior baseline");
});

test("DEFAULT_SOLVE_RATING_PARAMS matches the calibrated values documented in solveRatings.ts", () => {
  assert.equal(DEFAULT_SOLVE_RATING_PARAMS.priorWeight, 2);
  assert.equal(DEFAULT_SOLVE_RATING_PARAMS.pointsPerEpaSolve, 60);
});
