import { playByPlayUrl, streamCsvGz } from "./client.js";
import { findGameId, findTeamId, getGameTeamIds, upsertTeamGameStats } from "../../db/repo.js";

interface Accum {
  epaSum: number;
  epaCount: number;
  passEpaSum: number;
  passCount: number;
  rushEpaSum: number;
  rushCount: number;
  successSum: number;
  passSuccessSum: number;
  rushSuccessSum: number;
}

function newAccum(): Accum {
  return {
    epaSum: 0,
    epaCount: 0,
    passEpaSum: 0,
    passCount: 0,
    rushEpaSum: 0,
    rushCount: 0,
    successSum: 0,
    passSuccessSum: 0,
    rushSuccessSum: 0,
  };
}

function addPlay(acc: Accum, epa: number, success: number, isPass: boolean, isRush: boolean) {
  acc.epaSum += epa;
  acc.epaCount += 1;
  acc.successSum += success;
  if (isPass) {
    acc.passEpaSum += epa;
    acc.passCount += 1;
    acc.passSuccessSum += success;
  } else if (isRush) {
    acc.rushEpaSum += epa;
    acc.rushCount += 1;
    acc.rushSuccessSum += success;
  }
}

function mean(sum: number, count: number): number | null {
  return count > 0 ? sum / count : null;
}

/**
 * Aggregates raw nflfastR play-by-play into per-team-per-game EPA/success
 * rate splits. Offense rows are grouped by `posteam`; defense rows (EPA/
 * success rate *allowed*) are grouped by `defteam` over the same plays.
 */
export async function syncNflPbpStats(season: number): Promise<{ synced: number; skipped: number }> {
  const offense = new Map<string, Accum>(); // key: `${game_id}|${team}`
  const defense = new Map<string, Accum>();
  const gameTeams = new Map<string, Set<string>>(); // game_id -> teams seen

  for await (const row of streamCsvGz(playByPlayUrl(season))) {
    if (row.play !== undefined && row.play !== "1") continue;
    const epa = Number(row.epa);
    if (row.epa === "" || row.epa === undefined || Number.isNaN(epa)) continue;
    if (!row.posteam || !row.defteam || !row.game_id) continue;

    const success = row.success === "1" ? 1 : 0;
    const isPass = row.pass === "1";
    const isRush = row.rush === "1";

    const offKey = `${row.game_id}|${row.posteam}`;
    const offAcc = offense.get(offKey) ?? newAccum();
    addPlay(offAcc, epa, success, isPass, isRush);
    offense.set(offKey, offAcc);

    const defKey = `${row.game_id}|${row.defteam}`;
    const defAcc = defense.get(defKey) ?? newAccum();
    addPlay(defAcc, epa, success, isPass, isRush);
    defense.set(defKey, defAcc);

    const teams = gameTeams.get(row.game_id) ?? new Set<string>();
    teams.add(row.posteam);
    teams.add(row.defteam);
    gameTeams.set(row.game_id, teams);
  }

  let synced = 0;
  let skipped = 0;

  for (const [gameSourceId, teams] of gameTeams) {
    const gameId = await findGameId("nfl", gameSourceId);
    if (!gameId) {
      skipped += teams.size;
      continue;
    }
    const gameTeamIds = await getGameTeamIds(gameId);
    if (!gameTeamIds) {
      skipped += teams.size;
      continue;
    }

    for (const team of teams) {
      const teamId = await findTeamId("nfl", team);
      if (!teamId) {
        skipped += 1;
        continue;
      }
      const off = offense.get(`${gameSourceId}|${team}`) ?? newAccum();
      const def = defense.get(`${gameSourceId}|${team}`) ?? newAccum();

      await upsertTeamGameStats({
        gameId,
        teamId,
        isHome: gameTeamIds.homeTeamId === teamId,
        offEpaPlay: mean(off.epaSum, off.epaCount),
        offEpaPass: mean(off.passEpaSum, off.passCount),
        offEpaRush: mean(off.rushEpaSum, off.rushCount),
        defEpaPlay: mean(def.epaSum, def.epaCount),
        defEpaPass: mean(def.passEpaSum, def.passCount),
        defEpaRush: mean(def.rushEpaSum, def.rushCount),
        offSuccessRate: mean(off.successSum, off.epaCount),
        offSuccessRatePass: mean(off.passSuccessSum, off.passCount),
        offSuccessRateRush: mean(off.rushSuccessSum, off.rushCount),
        defSuccessRate: mean(def.successSum, def.epaCount),
        defSuccessRatePass: mean(def.passSuccessSum, def.passCount),
        defSuccessRateRush: mean(def.rushSuccessSum, def.rushCount),
        playsOffense: off.epaCount,
        playsDefense: def.epaCount,
        source: "nflverse",
      });
      synced += 1;
    }
  }

  return { synced, skipped };
}
