/**
 * Real iterative opponent-adjustment solve -- the actual fix for what two
 * naive attempts at pointsPerX-style opponentAdjustWeight failed to do:
 * make offensive success matter more against good defenses and vice versa.
 *
 * Standard iterative method (the same family SP+/DVOA-style advanced
 * stats use): every team starts at OFF=DEF=0 (league average). Each pass,
 * every team's OFF is re-estimated as its raw offensive output across its
 * games, net of the CURRENT estimate of how much each opponent's defense
 * lets teams get away with; DEF is re-estimated symmetrically from what
 * the team allowed, net of the opponent offenses' current ratings. This
 * repeats until the ratings stop moving.
 *
 * Sign convention (matches every other component in this project: "off
 * minus def, higher=better"): OFF_i is team i's opponent-adjusted raw
 * metric, higher = better offense. DEF_i is opponent-adjusted raw metric
 * ALLOWED, higher = worse defense (so a good defense has a NEGATIVE DEF_i).
 * Both are deviations from the league-average raw value (0 = exactly
 * average).
 *
 * Convergence note: naive simultaneous (Jacobi) updates on this kind of
 * mutually-referential system can oscillate forever even on a trivial
 * 2-team, 1-game case (verified by hand -- see opponentAdjust.test.ts) --
 * each side's target is a moving function of the other, so an undamped
 * update just swaps between two states. dampingFactor (default 0.5)
 * blends each iteration's raw target with the previous estimate, which is
 * enough to force convergence.
 *
 * As-of-week discipline: this function is pure and knows nothing about
 * weeks -- it converges over exactly the TeamPerformance rows it's given.
 * Callers MUST pass only performances from games completed before the
 * snapshot week being rated (same no-lookahead invariant as the rest of
 * this project's rating pipeline), and must re-run the whole solve fresh
 * per week rather than reusing a single full-season convergence, or
 * later-season results will leak into early-week ratings.
 */

export interface TeamPerformance {
  teamId: number;
  opponentId: number;
  /** This team's raw offensive metric value (e.g. success rate) in this game. */
  rawOffenseValue: number;
}

export interface OpponentAdjustedRatings {
  off: Map<number, number>;
  def: Map<number, number>;
  iterations: number;
  converged: boolean;
}

export interface OpponentAdjustmentOptions {
  maxIterations?: number;
  tolerance?: number;
  dampingFactor?: number;
}

const DEFAULT_MAX_ITERATIONS = 200;
const DEFAULT_TOLERANCE = 1e-6;
const DEFAULT_DAMPING_FACTOR = 0.5;

export function computeOpponentAdjustedRatings(
  performances: TeamPerformance[],
  options: OpponentAdjustmentOptions = {},
): OpponentAdjustedRatings {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const dampingFactor = options.dampingFactor ?? DEFAULT_DAMPING_FACTOR;

  const teamIds = new Set<number>();
  for (const p of performances) {
    teamIds.add(p.teamId);
    teamIds.add(p.opponentId);
  }

  if (teamIds.size === 0) {
    return { off: new Map(), def: new Map(), iterations: 0, converged: true };
  }

  const leagueAvg = performances.reduce((sum, p) => sum + p.rawOffenseValue, 0) / performances.length;

  // offPerformances[i] = games where team i was on offense (drives OFF_i).
  // defPerformances[i] = games where team i was on defense, i.e. the
  // opponent's offensive rows against team i (drives DEF_i).
  const offPerformances = new Map<number, TeamPerformance[]>();
  const defPerformances = new Map<number, TeamPerformance[]>();
  for (const teamId of teamIds) {
    offPerformances.set(teamId, []);
    defPerformances.set(teamId, []);
  }
  for (const p of performances) {
    offPerformances.get(p.teamId)!.push(p);
    defPerformances.get(p.opponentId)!.push(p);
  }

  let off = new Map<number, number>();
  let def = new Map<number, number>();
  for (const teamId of teamIds) {
    off.set(teamId, 0);
    def.set(teamId, 0);
  }

  let iterations = 0;
  let converged = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    const nextOff = new Map<number, number>();
    const nextDef = new Map<number, number>();
    let maxDelta = 0;

    for (const teamId of teamIds) {
      const offGames = offPerformances.get(teamId)!;
      const targetOff =
        offGames.length > 0
          ? offGames.reduce((sum, p) => sum + (p.rawOffenseValue - def.get(p.opponentId)!), 0) / offGames.length -
            leagueAvg
          : off.get(teamId)!;
      const newOff = off.get(teamId)! + dampingFactor * (targetOff - off.get(teamId)!);
      nextOff.set(teamId, newOff);
      maxDelta = Math.max(maxDelta, Math.abs(newOff - off.get(teamId)!));

      const defGames = defPerformances.get(teamId)!;
      const targetDef =
        defGames.length > 0
          ? defGames.reduce((sum, p) => sum + (p.rawOffenseValue - off.get(p.teamId)!), 0) / defGames.length -
            leagueAvg
          : def.get(teamId)!;
      const newDef = def.get(teamId)! + dampingFactor * (targetDef - def.get(teamId)!);
      nextDef.set(teamId, newDef);
      maxDelta = Math.max(maxDelta, Math.abs(newDef - def.get(teamId)!));
    }

    off = nextOff;
    def = nextDef;
    iterations = iter + 1;

    if (maxDelta < tolerance) {
      converged = true;
      break;
    }
  }

  return { off, def, iterations, converged };
}
