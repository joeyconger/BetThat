import { test } from "node:test";
import assert from "node:assert/strict";
import { computeOpponentAdjustedRatings, identifyLowConnectivityTeams, type TeamPerformance } from "./opponentAdjust.js";

const A = 1;
const B = 2;

function close(actual: number, expected: number, epsilon = 1e-6): boolean {
  return Math.abs(actual - expected) < epsilon;
}

test("computeOpponentAdjustedRatings: no games returns empty maps, trivially converged", () => {
  const result = computeOpponentAdjustedRatings([]);
  assert.equal(result.off.size, 0);
  assert.equal(result.def.size, 0);
  assert.equal(result.converged, true);
});

test("computeOpponentAdjustedRatings: every team producing the identical raw value converges to all-zero ratings", () => {
  // A round robin of 3 teams, all games at raw value 0.5 -- a perfectly
  // average league where every team is exactly average on both sides.
  const performances: TeamPerformance[] = [
    { teamId: 1, opponentId: 2, rawOffenseValue: 0.5 },
    { teamId: 2, opponentId: 1, rawOffenseValue: 0.5 },
    { teamId: 2, opponentId: 3, rawOffenseValue: 0.5 },
    { teamId: 3, opponentId: 2, rawOffenseValue: 0.5 },
    { teamId: 1, opponentId: 3, rawOffenseValue: 0.5 },
    { teamId: 3, opponentId: 1, rawOffenseValue: 0.5 },
  ];
  const result = computeOpponentAdjustedRatings(performances);
  assert.equal(result.converged, true);
  for (const teamId of [1, 2, 3]) {
    assert.ok(close(result.off.get(teamId)!, 0), `off[${teamId}] should be ~0`);
    assert.ok(close(result.def.get(teamId)!, 0), `def[${teamId}] should be ~0`);
  }
});

test("computeOpponentAdjustedRatings: undamped Jacobi updates on a single 2-team game would oscillate forever -- damping converges to the symmetric split", () => {
  // A single game: A's offense produced 0.6, B's offense produced 0.4.
  // With only one data point per side this is underdetermined (only
  // off_A + def_B = 0.1 is pinned down, not the individual values) --
  // the damped iteration's stable fixed point is the symmetric split,
  // hand-verified: u_n = off_A + def_B is driven to exactly 0.1 after
  // the first pass when dampingFactor=0.5, and v_n = off_A - def_B stays
  // at its initial value of 0 forever, so off_A = def_B = 0.05.
  const performances: TeamPerformance[] = [
    { teamId: A, opponentId: B, rawOffenseValue: 0.6 },
    { teamId: B, opponentId: A, rawOffenseValue: 0.4 },
  ];
  const result = computeOpponentAdjustedRatings(performances);
  assert.equal(result.converged, true);
  assert.ok(result.iterations < 10, `should converge quickly (got ${result.iterations} iterations)`);
  assert.ok(close(result.off.get(A)!, 0.05), `off[A] ~0.05 (got ${result.off.get(A)})`);
  assert.ok(close(result.def.get(B)!, 0.05), `def[B] ~0.05 (got ${result.def.get(B)})`);
  assert.ok(close(result.off.get(B)!, -0.05), `off[B] ~-0.05 (got ${result.off.get(B)})`);
  assert.ok(close(result.def.get(A)!, -0.05), `def[A] ~-0.05 (got ${result.def.get(A)})`);
});

test("computeOpponentAdjustedRatings: the same raw offensive output against tougher defenses rates higher than against weaker defenses", () => {
  // X faces two strong defenses (S1, S2); Y faces two weak defenses
  // (W1, W2) -- both X and Y put up the identical raw 0.5 every game.
  // S1/S2 and W1/W2 are calibrated as strong/weak via a common reference
  // team R, which gets held to 0.3 by S1/S2 but produces 0.7 against
  // W1/W2 -- unambiguous defensive-strength signal independent of X/Y.
  const X = 10, Y = 11, S1 = 12, S2 = 13, W1 = 14, W2 = 15, R = 16;
  const performances: TeamPerformance[] = [
    { teamId: X, opponentId: S1, rawOffenseValue: 0.5 },
    { teamId: S1, opponentId: X, rawOffenseValue: 0.5 },
    { teamId: X, opponentId: S2, rawOffenseValue: 0.5 },
    { teamId: S2, opponentId: X, rawOffenseValue: 0.5 },

    { teamId: Y, opponentId: W1, rawOffenseValue: 0.5 },
    { teamId: W1, opponentId: Y, rawOffenseValue: 0.5 },
    { teamId: Y, opponentId: W2, rawOffenseValue: 0.5 },
    { teamId: W2, opponentId: Y, rawOffenseValue: 0.5 },

    { teamId: R, opponentId: S1, rawOffenseValue: 0.3 },
    { teamId: S1, opponentId: R, rawOffenseValue: 0.3 },
    { teamId: R, opponentId: S2, rawOffenseValue: 0.3 },
    { teamId: S2, opponentId: R, rawOffenseValue: 0.3 },

    { teamId: R, opponentId: W1, rawOffenseValue: 0.7 },
    { teamId: W1, opponentId: R, rawOffenseValue: 0.7 },
    { teamId: R, opponentId: W2, rawOffenseValue: 0.7 },
    { teamId: W2, opponentId: R, rawOffenseValue: 0.7 },
  ];
  const result = computeOpponentAdjustedRatings(performances);
  assert.equal(result.converged, true);
  const offX = result.off.get(X)!;
  const offY = result.off.get(Y)!;
  assert.ok(offX > offY, `off[X] (${offX}) should exceed off[Y] (${offY}) -- same raw output, tougher opponents`);
  // Sanity: the strong defenses should end up with a lower (better, more
  // negative) DEF rating than the weak defenses.
  const defS1 = result.def.get(S1)!;
  const defW1 = result.def.get(W1)!;
  assert.ok(defS1 < defW1, `def[S1] (${defS1}) should be better (lower) than def[W1] (${defW1})`);
});

test("computeOpponentAdjustedRatings: a team with no games in the performance set is not included in the output", () => {
  const performances: TeamPerformance[] = [{ teamId: A, opponentId: B, rawOffenseValue: 0.5 }];
  const result = computeOpponentAdjustedRatings(performances);
  assert.equal(result.off.has(999), false);
});

test("computeOpponentAdjustedRatings: a stricter tolerance requires more iterations to converge", () => {
  const performances: TeamPerformance[] = [
    { teamId: A, opponentId: B, rawOffenseValue: 0.6 },
    { teamId: B, opponentId: A, rawOffenseValue: 0.4 },
  ];
  const loose = computeOpponentAdjustedRatings(performances, { tolerance: 1e-2 });
  const strict = computeOpponentAdjustedRatings(performances, { tolerance: 1e-12 });
  assert.ok(strict.iterations >= loose.iterations);
});

test("computeOpponentAdjustedRatings: hitting maxIterations without convergence is reported honestly (converged: false)", () => {
  const performances: TeamPerformance[] = [
    { teamId: A, opponentId: B, rawOffenseValue: 0.6 },
    { teamId: B, opponentId: A, rawOffenseValue: 0.4 },
  ];
  const result = computeOpponentAdjustedRatings(performances, { maxIterations: 1, tolerance: 1e-12 });
  assert.equal(result.converged, false);
  assert.equal(result.iterations, 1);
});

test("computeOpponentAdjustedRatings: teamDiagnostics.gamesPlayed counts offense + defense appearances", () => {
  // A plays 1 game (vs B): 1 offense appearance + 1 defense appearance (B's row against A) = 2.
  const performances: TeamPerformance[] = [
    { teamId: A, opponentId: B, rawOffenseValue: 0.6 },
    { teamId: B, opponentId: A, rawOffenseValue: 0.4 },
  ];
  const result = computeOpponentAdjustedRatings(performances);
  assert.equal(result.teamDiagnostics.get(A)!.gamesPlayed, 2);
  assert.equal(result.teamDiagnostics.get(B)!.gamesPlayed, 2);
});

test("computeOpponentAdjustedRatings: teamDiagnostics.lastDelta is near-zero for a converged solve", () => {
  const performances: TeamPerformance[] = [
    { teamId: A, opponentId: B, rawOffenseValue: 0.6 },
    { teamId: B, opponentId: A, rawOffenseValue: 0.4 },
  ];
  const result = computeOpponentAdjustedRatings(performances);
  assert.equal(result.converged, true);
  assert.ok(result.teamDiagnostics.get(A)!.lastDelta < 1e-6);
  assert.ok(result.teamDiagnostics.get(B)!.lastDelta < 1e-6);
});

test("computeOpponentAdjustedRatings: a low-connectivity pendant team still gets a stable teamDiagnostics entry", () => {
  // A well-connected core (X, Y, Z round robin) plus a pendant team P that
  // only ever played X once -- the degenerate identifiability case the
  // 2-team test already covers, but now embedded in a larger graph where
  // the global solve still reports converged overall.
  const X = 10, Y = 11, Z = 12, P = 13;
  const performances: TeamPerformance[] = [
    { teamId: X, opponentId: Y, rawOffenseValue: 0.5 },
    { teamId: Y, opponentId: X, rawOffenseValue: 0.5 },
    { teamId: Y, opponentId: Z, rawOffenseValue: 0.5 },
    { teamId: Z, opponentId: Y, rawOffenseValue: 0.5 },
    { teamId: X, opponentId: Z, rawOffenseValue: 0.5 },
    { teamId: Z, opponentId: X, rawOffenseValue: 0.5 },
    { teamId: X, opponentId: P, rawOffenseValue: 0.6 },
    { teamId: P, opponentId: X, rawOffenseValue: 0.4 },
  ];
  const result = computeOpponentAdjustedRatings(performances);
  assert.equal(result.converged, true);
  assert.equal(result.teamDiagnostics.get(P)!.gamesPlayed, 2);
  assert.ok(result.teamDiagnostics.has(P));
});

test("identifyLowConnectivityTeams: flags teams below the games threshold, not well-connected ones", () => {
  const performances: TeamPerformance[] = [
    { teamId: 1, opponentId: 2, rawOffenseValue: 0.5 },
    { teamId: 2, opponentId: 1, rawOffenseValue: 0.5 },
    { teamId: 2, opponentId: 3, rawOffenseValue: 0.5 },
    { teamId: 3, opponentId: 2, rawOffenseValue: 0.5 },
    { teamId: 2, opponentId: 4, rawOffenseValue: 0.5 },
    { teamId: 4, opponentId: 2, rawOffenseValue: 0.5 },
  ];
  const result = computeOpponentAdjustedRatings(performances);
  // Team 2 played 3 games (gamesPlayed=6); teams 1, 3, 4 each played 1 (gamesPlayed=2).
  const flagged = identifyLowConnectivityTeams(result.teamDiagnostics, 3);
  assert.deepEqual(new Set(flagged), new Set([1, 3, 4]));
});

test("identifyLowConnectivityTeams: raising minGames flags more teams, lowering it flags fewer", () => {
  const performances: TeamPerformance[] = [
    { teamId: 1, opponentId: 2, rawOffenseValue: 0.5 },
    { teamId: 2, opponentId: 1, rawOffenseValue: 0.5 },
  ];
  const result = computeOpponentAdjustedRatings(performances);
  assert.deepEqual(identifyLowConnectivityTeams(result.teamDiagnostics, 1), []);
  assert.deepEqual(new Set(identifyLowConnectivityTeams(result.teamDiagnostics, 10)), new Set([1, 2]));
});
