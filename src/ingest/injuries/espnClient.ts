// ESPN's undocumented public API — same "hidden endpoint" tradeoff as the
// ESPN integration in this repo's other Railway app: free, no key, but
// unofficial and could change shape without notice. UNVERIFIED: this sandbox
// has no network access to confirm the exact response shape, so the fields
// below are the commonly-documented-by-reverse-engineering shape (as used by
// several open-source ESPN API wrappers), parsed defensively rather than
// assumed correct. Run a real sync and check `raw` in the injuries table
// against what actually came back before trusting this.
const LEAGUE_PATH: Record<"nfl" | "cfb", string> = {
  nfl: "football/nfl",
  cfb: "football/college-football",
};

interface EspnInjuryAthlete {
  displayName?: string;
  position?: { abbreviation?: string };
}

interface EspnInjuryEntry {
  status?: string;
  date?: string;
  athlete?: EspnInjuryAthlete;
}

interface EspnTeamInjuries {
  team?: { displayName?: string; abbreviation?: string };
  injuries?: EspnInjuryEntry[];
}

interface EspnInjuriesResponse {
  injuries?: EspnTeamInjuries[];
}

export type InjuryStatus = "out" | "doubtful" | "questionable" | "probable" | "ir";

export interface RawInjuryRecord {
  teamName: string;
  playerName: string;
  position: string | null;
  status: InjuryStatus;
  reportDate: string;
  raw: unknown;
}

const STATUS_MAP: Record<string, InjuryStatus> = {
  out: "out",
  doubtful: "doubtful",
  questionable: "questionable",
  probable: "probable",
  "injured reserve": "ir",
  ir: "ir",
};

function normalizeStatus(raw: string | undefined): InjuryStatus | null {
  if (!raw) return null;
  return STATUS_MAP[raw.trim().toLowerCase()] ?? null;
}

export async function getCurrentInjuries(sport: "nfl" | "cfb"): Promise<RawInjuryRecord[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${LEAGUE_PATH[sport]}/injuries`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ESPN injuries request failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as EspnInjuriesResponse;
  const records: RawInjuryRecord[] = [];

  for (const teamBlock of body.injuries ?? []) {
    const teamName = teamBlock.team?.displayName ?? teamBlock.team?.abbreviation;
    if (!teamName) continue;

    for (const entry of teamBlock.injuries ?? []) {
      const status = normalizeStatus(entry.status);
      const playerName = entry.athlete?.displayName;
      if (!status || !playerName) continue;

      records.push({
        teamName,
        playerName,
        position: entry.athlete?.position?.abbreviation ?? null,
        status,
        reportDate: entry.date ?? new Date().toISOString().slice(0, 10),
        raw: entry,
      });
    }
  }

  return records;
}
