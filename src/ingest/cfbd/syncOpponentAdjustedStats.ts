import { getPlaysForSeasonThroughWeek, getGamesForWeek, upsertOpponentAdjustedStats } from "../../db/repo.js";
import { buildTeamPerformances } from "../../ratings/gamePerformance.js";
import type { GamePlaysGroup } from "../../ratings/gamePerformance.js";
import { computeOpponentAdjustedRatings } from "../../ratings/opponentAdjust.js";

/**
 * Populates team_game_stats.off_adj/def_adj (migration 0013) for every
 * game of a season -- the real iterative opponent-adjustment
 * (ratings/opponentAdjust.ts), computed fresh per week over ONLY the
 * prior weeks' games, never this game or any later one (the as-of-week
 * no-lookahead invariant this project's whole rating pipeline requires).
 *
 * Unlike every other module in ingest/cfbd/, this makes NO CFBD API
 * calls -- it's a pure DB-derived computation over data
 * cfb-rawplays-ingest already stored, re-run whenever off_adj/def_adj
 * need recomputing (e.g. after more weeks of plays are ingested).
 *
 * Week 1 (and any week where a team has zero completed prior games --
 * a transfer, a team's first FBS season) gets no off_adj/def_adj at all:
 * there's nothing to compute an as-of-week snapshot from, so those
 * fields stay their default null rather than being written as a fake 0.
 */
export async function syncOpponentAdjustedStats(
  season: number,
  weeks: number[] = Array.from({ length: 15 }, (_, i) => i + 1),
): Promise<{ weeksProcessed: number; gamesUpdated: number; teamSidesUpdated: number }> {
  let weeksProcessed = 0;
  let gamesUpdated = 0;
  let teamSidesUpdated = 0;

  for (const week of weeks) {
    const priorPlays = await getPlaysForSeasonThroughWeek("cfb", season, week - 1);
    if (priorPlays.length === 0) {
      // No completed prior weeks yet (week 1, or plays not ingested that far back) -- nothing to solve.
      weeksProcessed += 1;
      continue;
    }

    const gamesById = new Map<number, GamePlaysGroup>();
    for (const p of priorPlays) {
      let g = gamesById.get(p.gameId);
      if (!g) {
        g = { gameId: p.gameId, homeTeamId: p.homeTeamId, awayTeamId: p.awayTeamId, plays: [] };
        gamesById.set(p.gameId, g);
      }
      g.plays.push({
        offenseTeamId: p.offenseTeamId,
        defenseTeamId: p.defenseTeamId,
        down: p.down,
        distance: p.distance,
        yardsGained: p.yardsGained,
        playType: p.playType,
        offenseScore: p.offenseScore,
        defenseScore: p.defenseScore,
        period: p.period,
        clockMinutes: p.clockMinutes,
        clockSeconds: p.clockSeconds,
      });
    }

    const performances = buildTeamPerformances([...gamesById.values()]);
    const { off, def, teamDiagnostics } = computeOpponentAdjustedRatings(performances);

    const weekGames = await getGamesForWeek("cfb", season, week);
    for (const game of weekGames) {
      const homeOffAdj = off.get(game.homeTeamId) ?? null;
      const homeDefAdj = def.get(game.homeTeamId) ?? null;
      const awayOffAdj = off.get(game.awayTeamId) ?? null;
      const awayDefAdj = def.get(game.awayTeamId) ?? null;
      const homeGamesPlayed = teamDiagnostics.get(game.homeTeamId)?.gamesPlayed ?? null;
      const awayGamesPlayed = teamDiagnostics.get(game.awayTeamId)?.gamesPlayed ?? null;

      if (homeOffAdj !== null && homeDefAdj !== null) {
        await upsertOpponentAdjustedStats({ gameId: game.id, teamId: game.homeTeamId, offAdj: homeOffAdj, defAdj: homeDefAdj, gamesPlayed: homeGamesPlayed });
        teamSidesUpdated += 1;
      }
      if (awayOffAdj !== null && awayDefAdj !== null) {
        await upsertOpponentAdjustedStats({ gameId: game.id, teamId: game.awayTeamId, offAdj: awayOffAdj, defAdj: awayDefAdj, gamesPlayed: awayGamesPlayed });
        teamSidesUpdated += 1;
      }
      if ((homeOffAdj !== null && homeDefAdj !== null) || (awayOffAdj !== null && awayDefAdj !== null)) {
        gamesUpdated += 1;
      }
    }

    weeksProcessed += 1;
  }

  return { weeksProcessed, gamesUpdated, teamSidesUpdated };
}
