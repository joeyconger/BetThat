import { getSpRatings, getEloRatings } from "./client.js";
import { findTeamIdByName, upsertExternalRating } from "../../db/repo.js";

/** See client.ts's getSpRatings doc — season-final only, used as next season's rating prior. */
export async function syncCfbdSpRatings(year: number): Promise<{ synced: number; skipped: number }> {
  const ratings = await getSpRatings(year);
  let synced = 0;
  let skipped = 0;
  for (const row of ratings) {
    const teamId = await findTeamIdByName("cfb", row.team);
    if (!teamId || row.rating === null) {
      skipped += 1;
      continue;
    }
    await upsertExternalRating({ teamId, season: year, week: null, source: "cfbd_sp", rating: row.rating });
    synced += 1;
  }
  return { synced, skipped };
}

/**
 * CFBD's Elo has no documented max week, and it's unconfirmed whether early
 * (preseason-ish) weeks return data at all — see client.ts's getEloRatings
 * doc. Loops a generous range and treats an empty response as "not
 * available that week" rather than failing the whole sync.
 */
export async function syncCfbdEloRatings(
  year: number,
  weeks: number[] = Array.from({ length: 21 }, (_, i) => i), // 0..20: covers preseason (0) through postseason
): Promise<{ synced: number; skipped: number }> {
  let synced = 0;
  let skipped = 0;
  for (const week of weeks) {
    const ratings = await getEloRatings(year, week);
    for (const row of ratings) {
      const teamId = await findTeamIdByName("cfb", row.team);
      if (!teamId || row.elo === null) {
        skipped += 1;
        continue;
      }
      await upsertExternalRating({ teamId, season: year, week, source: "cfbd_elo", rating: row.elo });
      synced += 1;
    }
  }
  return { synced, skipped };
}
