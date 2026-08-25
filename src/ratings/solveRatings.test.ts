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

const ROUND_ROBIN_3: TeamPerformance[] = [
  { teamId: 1, opponentId: 2, rawOffenseValue: 0.5 },
  { teamId: 2, opponentId: 1, rawOffenseValue: 0.5 },
  { teamId: 2, opponentId: 3, rawOffenseValue: 0.5 },
  { teamId: 3, opponentId: 2, rawOffenseValue: 0.5 },
  { teamId: 1, opponentId: 3, rawOffenseValue: 0.5 },
  { teamId: 3, opponentId: 1, rawOffenseValue: 0.5 },
];

test("computeSolveRatings: returningProduction=1.0 for a team matches the flat-weight (no returningProduction) result exactly", () => {
  const priorSolve = new Map([[1, { off: 10, def: -10 }]]);
  const params: SolveRatingParams = { pointsPerEpaSolve: 1, priorWeight: 2 };
  const flat = computeSolveRatings(ROUND_ROBIN_3, priorSolve, params);
  const withFullReturning = computeSolveRatings(ROUND_ROBIN_3, priorSolve, params, [], new Map([[1, 1.0]]));
  assert.ok(close(flat.get(1)!.rating, withFullReturning.get(1)!.rating));
});

test("computeSolveRatings: a lower returningProduction fraction pulls LESS toward the prior than a higher one", () => {
  const priorSolve = new Map([[1, { off: 10, def: -10 }]]);
  const params: SolveRatingParams = { pointsPerEpaSolve: 1, priorWeight: 2 };
  const lowReturning = computeSolveRatings(ROUND_ROBIN_3, priorSolve, params, [], new Map([[1, 0.2]]));
  const highReturning = computeSolveRatings(ROUND_ROBIN_3, priorSolve, params, [], new Map([[1, 1.0]]));
  const noPrior = computeSolveRatings(ROUND_ROBIN_3, undefined, { ...params, priorWeight: 0 });
  // Prior is positive (off=10,def=-10 -> a positive pull), so less trust
  // in it should land closer to the no-prior baseline (0), not further.
  assert.ok(lowReturning.get(1)!.rating < highReturning.get(1)!.rating, "lower returning production should pull less toward a positive prior");
  assert.ok(lowReturning.get(1)!.rating > noPrior.get(1)!.rating, "still pulled SOME toward the prior, just less");
});

test("computeSolveRatings: a team with returningProduction=0 is discounted to the 0.35 floor, NOT fully erased", () => {
  // A real production case (Oklahoma-UTEP, 2026) caught the earlier
  // fully-erased version doing real damage: UTEP's percentPPA read as
  // ~0, which zeroed their entire prior and rated a genuinely bad team as
  // perfectly average -- see solveRatings.ts's doc for the full story.
  // 0 must still retain SOME signal (the 0.35 floor), not match the
  // true no-prior baseline.
  const priorSolve = new Map([[1, { off: 10, def: -10 }]]);
  const params: SolveRatingParams = { pointsPerEpaSolve: 1, priorWeight: 2 };
  const zeroReturning = computeSolveRatings(ROUND_ROBIN_3, priorSolve, params, [], new Map([[1, 0]]));
  const noPrior = computeSolveRatings(ROUND_ROBIN_3, undefined, { ...params, priorWeight: 0 });
  const floored = computeSolveRatings(ROUND_ROBIN_3, priorSolve, params, [], new Map([[1, 0.35]]));
  assert.ok(zeroReturning.get(1)!.rating > noPrior.get(1)!.rating, "0 returning production must still pull toward a positive prior, not land at the no-prior baseline");
  assert.ok(close(zeroReturning.get(1)!.rating, floored.get(1)!.rating), "0 and 0.35 should behave identically -- both clamp to the same floor");
});

test("computeSolveRatings: a team MISSING from returningProduction falls back to the flat priorWeight, not zero", () => {
  const priorSolve = new Map([[1, { off: 10, def: -10 }]]);
  const params: SolveRatingParams = { pointsPerEpaSolve: 1, priorWeight: 2 };
  // returningProduction has data for OTHER teams, but not team 1.
  const missingForTeam1 = computeSolveRatings(ROUND_ROBIN_3, priorSolve, params, [], new Map([[2, 0.5]]));
  const flat = computeSolveRatings(ROUND_ROBIN_3, priorSolve, params);
  assert.ok(close(missingForTeam1.get(1)!.rating, flat.get(1)!.rating), "missing returning-production data should not be treated as zero continuity");
});

test("computeSolveRatings: returningProduction fraction is clamped at 1.5, not unbounded", () => {
  const priorSolve = new Map([[1, { off: 10, def: -10 }]]);
  const params: SolveRatingParams = { pointsPerEpaSolve: 1, priorWeight: 2 };
  const wayOverOne = computeSolveRatings(ROUND_ROBIN_3, priorSolve, params, [], new Map([[1, 5.0]]));
  const clampedAtCap = computeSolveRatings(ROUND_ROBIN_3, priorSolve, params, [], new Map([[1, 1.5]]));
  assert.ok(close(wayOverOne.get(1)!.rating, clampedAtCap.get(1)!.rating));
});

test("computeSolveRatings: a negative returningProduction (CFBD's real percentPPA has been observed as low as -0.567) clamps to the same 0.35 floor as 0, not below it", () => {
  const priorSolve = new Map([[1, { off: 10, def: -10 }]]);
  const params: SolveRatingParams = { pointsPerEpaSolve: 1, priorWeight: 2 };
  const negative = computeSolveRatings(ROUND_ROBIN_3, priorSolve, params, [], new Map([[1, -0.567]]));
  const zero = computeSolveRatings(ROUND_ROBIN_3, priorSolve, params, [], new Map([[1, 0]]));
  assert.ok(close(negative.get(1)!.rating, zero.get(1)!.rating), "a negative fraction must clamp to the same floor as 0, not flip the prior's sign or go lower");
});

test("computeSolveRatings: a team with returningProduction=0 AND zero real games of its own still appears in the output (not dropped), at the floored (not fully erased) prior", () => {
  // This is the real preseason scenario the mechanism exists for: before
  // any 2026 games are played, a team with gutted roster continuity has
  // NO real performances of its own AND a shrunk prior. An earlier
  // (weight-scaling, not value-shrinking) version of this mechanism
  // dropped such a team from the output map entirely instead of rating it
  // at its floored prior -- this guards against that regression. Team 4
  // has no entry in ROUND_ROBIN_3 at all (0 real games), only a prior.
  const priorSolve = new Map([
    [1, { off: 10, def: -10 }],
    [4, { off: 8, def: -8 }],
  ]);
  const params: SolveRatingParams = { pointsPerEpaSolve: 1, priorWeight: 2 };
  const withZeroContinuity = computeSolveRatings(ROUND_ROBIN_3, priorSolve, params, [], new Map([[4, 0]]));
  assert.ok(withZeroContinuity.has(4), "a returningProduction=0 team with zero real games must still be in the output map");
  // With zero real games, target = prior exactly (see computeSolveRatings'
  // doc) -- team 4's shrunk prior is off=8*0.35=2.8, def=-8*0.35=-2.8, so
  // rating = 2.8 - (-2.8) = 5.6, NOT 0 -- the 0.35 floor means a team is
  // discounted, never reset all the way to league average.
  assert.ok(close(withZeroContinuity.get(4)!.rating, 5.6), "should retain 35% of its real prior, not be reset to league average");
});

test("DEFAULT_SOLVE_RATING_PARAMS matches the calibrated values documented in solveRatings.ts", () => {
  assert.equal(DEFAULT_SOLVE_RATING_PARAMS.priorWeight, 2);
  assert.equal(DEFAULT_SOLVE_RATING_PARAMS.pointsPerEpaSolve, 69);
  assert.equal(DEFAULT_SOLVE_RATING_PARAMS.pointsPerFieldPositionYard, 0.5);
  assert.equal(DEFAULT_SOLVE_RATING_PARAMS.pointsPerFgAboveExpected, 0, "documented null result, not an unfinished placeholder");
});
