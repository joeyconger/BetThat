// nflverse uses team abbreviations as the stable identifier across every
// file (schedules, pbp, rosters), including for teams that have since moved
// (e.g. 'OAK'/'LV', 'SD'/'LAC', 'STL'/'LA'/'LAR'). Those historical codes are
// intentionally treated as distinct teams here rather than unified with
// their current franchise — fine for backtests scoped to recent seasons,
// but worth knowing if the backtest window is ever extended across a move.
export const NFL_TEAM_NAMES: Record<string, string> = {
  ARI: "Arizona Cardinals",
  ATL: "Atlanta Falcons",
  BAL: "Baltimore Ravens",
  BUF: "Buffalo Bills",
  CAR: "Carolina Panthers",
  CHI: "Chicago Bears",
  CIN: "Cincinnati Bengals",
  CLE: "Cleveland Browns",
  DAL: "Dallas Cowboys",
  DEN: "Denver Broncos",
  DET: "Detroit Lions",
  GB: "Green Bay Packers",
  HOU: "Houston Texans",
  IND: "Indianapolis Colts",
  JAX: "Jacksonville Jaguars",
  KC: "Kansas City Chiefs",
  LA: "Los Angeles Rams",
  LAC: "Los Angeles Chargers",
  LAR: "Los Angeles Rams",
  LV: "Las Vegas Raiders",
  MIA: "Miami Dolphins",
  MIN: "Minnesota Vikings",
  NE: "New England Patriots",
  NO: "New Orleans Saints",
  NYG: "New York Giants",
  NYJ: "New York Jets",
  OAK: "Oakland Raiders",
  PHI: "Philadelphia Eagles",
  PIT: "Pittsburgh Steelers",
  SD: "San Diego Chargers",
  SEA: "Seattle Seahawks",
  SF: "San Francisco 49ers",
  STL: "St. Louis Rams",
  TB: "Tampa Bay Buccaneers",
  TEN: "Tennessee Titans",
  WAS: "Washington Commanders",
};

export function nflTeamName(abbr: string): string {
  return NFL_TEAM_NAMES[abbr] ?? abbr;
}
