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
 *
 * Low-connectivity identifiability caveat: a team with very few games
 * relative to the rest of the graph (an FCS opponent playing one FBS
 * team, an early-season snapshot before most teams have played) doesn't
 * have enough independent equations pinning down its OFF/DEF split from
 * its opponents' -- the 2-team/1-game case in the tests is the extreme
 * version of this (offense and defense are literally indistinguishable
 * with only one matchup to go on). Global maxDelta convergence can still
 * report "converged" while a handful of poorly-connected teams are still
 * moving more than everyone else, just below the global tolerance --
 * teamDiagnostics.lastDelta and .gamesPlayed exist specifically so
 * callers can check convergence quality per-team, not just globally, and
 * identifyLowConnectivityTeams() flags likely-unstable teams by games
 * count. When running this on a real season, check these for the teams
 * it flags rather than trusting the global converged flag alone.
 */

export interface TeamPerformance {
  teamId: number;
  opponentId: number;
  /** This team's raw offensive metric value (e.g. success rate) in this game. */
  rawOffenseValue: number;
}

export interface TeamDiagnostic {
  /** Total games this team appears in (as offense + as defense). */
  gamesPlayed: number;
  /** How much this team's off+def ratings moved on the FINAL iteration -- near-0 means genuinely settled, not just under the global max. */
  lastDelta: number;
}

export interface OpponentAdjustedRatings {
  off: Map<number, number>;
  def: Map<number, number>;
  iterations: number;
  converged: boolean;
  teamDiagnostics: Map<number, TeamDiagnostic>;
}

export interface OpponentAdjustmentOptions {
  maxIterations?: number;
  tolerance?: number;
  dampingFactor?: number;
  /**
   * Starting point for the iteration instead of the default OFF=DEF=0 for
   * every team -- a team missing from either map still starts at 0.
   *
   * IMPORTANT, verified by a test that initially caught this as a false
   * assumption: the starting point is NOT irrelevant just because a team
   * (or the whole graph) is well-connected. Every equation here only ever
   * involves a team's own OFF/DEF paired against an OPPONENT's DEF/OFF --
   * never a team's OFF and DEF together, and never either alone. That
   * means shifting EVERY team's OFF up by the same constant c and EVERY
   * team's DEF down by that same c leaves every equation satisfied
   * identically, for ANY graph, however well-connected -- a genuine
   * structural "gauge freedom" this whole rating family has (the same
   * kind Bradley-Terry/SRS-style systems have: only OFF-minus-DEF
   * differences are pinned by game outcomes, never an absolute level for
   * OFF or DEF alone). The default off=def=0 start just happens to anchor
   * c=0; nothing in the data forces that choice over any other.
   *
   * The practical consequence: seeding with an ARBITRARY, inconsistent
   * prior can silently shift the whole population's OFF/DEF split by an
   * uncontrolled constant. Seeding with a prior that was ITSELF produced
   * by this same function under the same default anchor (e.g. the team's
   * own prior-season solve output, shrunk toward 0 the way
   * RatingParams.seasonCarryover shrinks Elo's carryover) is safe --
   * it's already anchored the same way unseeded teams are, so it doesn't
   * introduce a fresh, arbitrary offset. Note the OFF-DEF composite's
   * RELATIVE structure across teams (who ranks above whom, correlation
   * with an external rating) is unaffected by a uniform c-shift either
   * way, since every team's composite moves by the identical 2c -- only
   * absolute-value interpretation needs the anchor to be consistent.
   *
   * Separately, an underdetermined team (too few games, a low-
   * connectivity early-season snapshot -- see this file's header doc)
   * has additional degrees of freedom beyond just this one global c, so
   * its own starting point matters even more directly.
   */
  initialOff?: Map<number, number>;
  initialDef?: Map<number, number>;
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
    return { off: new Map(), def: new Map(), iterations: 0, converged: true, teamDiagnostics: new Map() };
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
    off.set(teamId, options.initialOff?.get(teamId) ?? 0);
    def.set(teamId, options.initialDef?.get(teamId) ?? 0);
  }

  let iterations = 0;
  let converged = false;
  let lastTeamDelta = new Map<number, number>();

  for (let iter = 0; iter < maxIterations; iter++) {
    const nextOff = new Map<number, number>();
    const nextDef = new Map<number, number>();
    const teamDelta = new Map<number, number>();
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
      const offDelta = Math.abs(newOff - off.get(teamId)!);
      maxDelta = Math.max(maxDelta, offDelta);

      const defGames = defPerformances.get(teamId)!;
      const targetDef =
        defGames.length > 0
          ? defGames.reduce((sum, p) => sum + (p.rawOffenseValue - off.get(p.teamId)!), 0) / defGames.length -
            leagueAvg
          : def.get(teamId)!;
      const newDef = def.get(teamId)! + dampingFactor * (targetDef - def.get(teamId)!);
      nextDef.set(teamId, newDef);
      const defDelta = Math.abs(newDef - def.get(teamId)!);
      maxDelta = Math.max(maxDelta, defDelta);

      teamDelta.set(teamId, Math.max(offDelta, defDelta));
    }

    off = nextOff;
    def = nextDef;
    lastTeamDelta = teamDelta;
    iterations = iter + 1;

    if (maxDelta < tolerance) {
      converged = true;
      break;
    }
  }

  const teamDiagnostics = new Map<number, TeamDiagnostic>();
  for (const teamId of teamIds) {
    teamDiagnostics.set(teamId, {
      gamesPlayed: offPerformances.get(teamId)!.length + defPerformances.get(teamId)!.length,
      lastDelta: lastTeamDelta.get(teamId) ?? 0,
    });
  }

  return { off, def, iterations, converged, teamDiagnostics };
}

/**
 * Flags teams likely to have an unstable/underdetermined solve: those
 * with fewer than minGames total appearances (offense + defense). A team
 * can pass this check and still be genuinely unstable (a small,
 * disconnected pocket of well-connected-to-each-other-but-not-the-rest
 * teams isn't caught by a raw games count), so treat this as a first
 * pass, not a guarantee -- pair it with checking .lastDelta directly for
 * teams near the threshold.
 */
export function identifyLowConnectivityTeams(
  teamDiagnostics: Map<number, TeamDiagnostic>,
  minGames = 3,
): number[] {
  const flagged: number[] = [];
  for (const [teamId, diag] of teamDiagnostics) {
    if (diag.gamesPlayed < minGames) flagged.push(teamId);
  }
  return flagged;
}
