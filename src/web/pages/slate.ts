import { renderPage, statTiles, escapeHtml, tabs } from "../layout.js";
import type { TeamRatingRow, PredictionRow } from "../../db/repo.js";
import type { HypotheticalMatchupResult } from "../../ratings/service.js";

type ScoreProjection = { homeScore: number; awayScore: number };

/** SP+-style "Team 31, Team 24" projected score, higher score first (not home/away order). Null when no projection exists (NFL, or a team missing a rating) -- callers show formatSpread alone in that case. */
function formatProjection(homeTeam: string, awayTeam: string, projection: ScoreProjection | null | undefined): string | null {
  if (!projection) return null;
  const [leader, leaderScore, trailer, trailerScore] =
    projection.homeScore >= projection.awayScore
      ? [homeTeam, projection.homeScore, awayTeam, projection.awayScore]
      : [awayTeam, projection.awayScore, homeTeam, projection.homeScore];
  return `${escapeHtml(leader)} ${Math.round(leaderScore)}, ${escapeHtml(trailer)} ${Math.round(trailerScore)}`;
}

/** "Team X by Y.Y" favored-team-plus-line format -- shown alongside (not instead of) the projected score, per explicit request. */
function formatSpread(homeTeam: string, awayTeam: string, modelSpreadHome: number): string {
  const favoredHome = modelSpreadHome < 0;
  const line = Math.abs(modelSpreadHome).toFixed(1);
  return `${escapeHtml(favoredHome ? homeTeam : awayTeam)} by ${line}`;
}

const TAB_INDEX: Record<string, number> = { weekly: 0, ratings: 1, sim: 2 };

function sportSeasonWeekFields(sport: string, season: string, week: string, availableSeasons: number[], availableWeeks: number[]): string {
  const seasonOptions = availableSeasons.map((s) => `<option value="${s}" ${String(s) === season ? "selected" : ""}>${s}</option>`).join("");
  const weekOptions = availableWeeks.map((w) => `<option value="${w}" ${String(w) === week ? "selected" : ""}>Week ${w}</option>`).join("");
  return `
    <select name="sport">
      <option value="nfl" ${sport === "nfl" ? "selected" : ""}>NFL</option>
      <option value="cfb" ${sport === "cfb" ? "selected" : ""}>CFB</option>
    </select>
    <select name="season" required>
      <option value="" disabled ${season === "" ? "selected" : ""}>Season</option>
      ${seasonOptions}
    </select>
    <select name="week" required>
      <option value="" disabled ${week === "" ? "selected" : ""}>Week</option>
      ${weekOptions}
    </select>
  `;
}

function weeklySlateTab(
  sport: string,
  season: string,
  week: string,
  predictions: PredictionRow[] | null,
  availableSeasons: number[],
  availableWeeks: number[],
  projectedScores: Map<number, ScoreProjection | null>,
): string {
  const headline =
    predictions && predictions.length > 0
      ? statTiles([{ label: "Games", value: String(predictions.length) }])
      : "";

  const table =
    predictions === null
      ? ""
      : predictions.length === 0
        ? `<p class="muted">No predictions generated for ${escapeHtml(sport)} ${escapeHtml(season)} week ${escapeHtml(week)} yet.</p>`
        : `<table>
            <thead><tr><th>Matchup</th><th>Spread</th><th>Projected score</th><th class="num">Confidence (±pts)</th></tr></thead>
            <tbody>${predictions
              .map((p) => {
                const projection = projectedScores.get(p.gameId);
                const scoreText = formatProjection(p.homeTeam, p.awayTeam, projection);
                return `<tr>
                  <td>${escapeHtml(p.awayTeam)} @ ${escapeHtml(p.homeTeam)}</td>
                  <td>${formatSpread(p.homeTeam, p.awayTeam, p.modelSpreadHome)}</td>
                  <td>${scoreText ?? '<span class="muted">—</span>'}</td>
                  <td class="num muted">${p.confidence === null ? "—" : p.confidence.toFixed(1)}</td>
                </tr>`;
              })
              .join("")}</tbody>
          </table>`;

  return `
    <p class="subtitle">The model's own projected score for each game — a rating differential, home-field advantage, and a few secondary signals, split around a real-data scoring baseline. No market comparison shown here.</p>
    <form method="get" action="/slate">
      <input type="hidden" name="tab" value="weekly">
      ${sportSeasonWeekFields(sport, season, week, availableSeasons, availableWeeks)}
      <button type="submit">Show slate</button>
    </form>
    ${headline}
    ${table}
  `;
}

function powerBar(rating: number, maxAbs: number): string {
  const pct = maxAbs === 0 ? 0 : Math.min(100, (Math.abs(rating) / maxAbs) * 50);
  const fill =
    rating === 0
      ? ""
      : rating > 0
        ? `<div class="power-bar-fill pos" style="width:${pct.toFixed(1)}%"></div>`
        : `<div class="power-bar-fill neg" style="width:${pct.toFixed(1)}%"></div>`;
  return `<div class="power-bar-cell">
    <div class="power-bar-track">
      <div class="power-bar-center"></div>
      ${fill}
    </div>
  </div>`;
}

function powerRatingsTab(
  sport: string,
  season: string,
  week: string,
  ratings: TeamRatingRow[] | null,
  availableSeasons: number[],
  availableWeeks: number[],
): string {
  const maxAbs = ratings ? Math.max(1e-9, ...ratings.map((r) => Math.abs(r.rating))) : 0;
  const headline =
    ratings && ratings.length > 0
      ? statTiles([
          { label: "Teams rated", value: String(ratings.length) },
          {
            label: "Top team",
            value: escapeHtml(ratings[0]!.teamName),
            sub: `${ratings[0]!.rating >= 0 ? "+" : ""}${ratings[0]!.rating.toFixed(2)} pts`,
          },
        ])
      : "";

  const table =
    ratings === null
      ? ""
      : ratings.length === 0
        ? `<p class="muted">No ratings computed for ${escapeHtml(sport)} ${escapeHtml(season)} through week ${escapeHtml(week)} yet.</p>`
        : `<table>
            <thead><tr><th>#</th><th>Team</th><th class="num">Rating</th><th>Power rating</th></tr></thead>
            <tbody>${ratings
              .map(
                (r, i) => `<tr>
                  <td class="muted">${i + 1}</td>
                  <td>${escapeHtml(r.teamName)}</td>
                  <td class="num">${r.rating >= 0 ? "+" : ""}${r.rating.toFixed(2)}</td>
                  <td>${powerBar(r.rating, maxAbs)}</td>
                </tr>`,
              )
              .join("")}</tbody>
          </table>`;

  return `
    <p class="subtitle">EPA-driven Elo ratings, in points (positive = above league average). Bars are relative to the widest spread in this list, not an absolute scale.</p>
    <form method="get" action="/slate">
      <input type="hidden" name="tab" value="ratings">
      ${sportSeasonWeekFields(sport, season, week, availableSeasons, availableWeeks)}
      <button type="submit">Show ratings</button>
    </form>
    ${headline}
    ${table}
  `;
}

export interface SimTeamOption {
  id: number;
  name: string;
}

function teamSelect(name: string, teams: SimTeamOption[], selected: string): string {
  const options = teams
    .map((t) => `<option value="${t.id}" ${String(t.id) === selected ? "selected" : ""}>${escapeHtml(t.name)}</option>`)
    .join("");
  return `<select name="${name}"><option value="">— select —</option>${options}</select>`;
}

function matchupSimTab(
  sport: string,
  season: string,
  week: string,
  teams: SimTeamOption[],
  home: string,
  away: string,
  result: HypotheticalMatchupResult | null,
  availableSeasons: number[],
  availableWeeks: number[],
): string {
  const resultBlock = !result
    ? home && away
      ? `<p class="muted">Not enough rating data for one or both teams as of this week yet.</p>`
      : ""
    : (() => {
        const homeTeam = teams.find((t) => t.id === result.home.teamId);
        const awayTeam = teams.find((t) => t.id === result.away.teamId);
        const homeName = homeTeam?.name ?? "Home";
        const awayName = awayTeam?.name ?? "Away";
        const scoreText = formatProjection(homeName, awayName, result.projection);
        return `
          ${statTiles([
            {
              label: "Spread",
              value: formatSpread(homeName, awayName, result.modelSpreadHome),
              sub: `±${result.confidence.toFixed(1)} pts`,
            },
            ...(scoreText ? [{ label: "Projected score", value: scoreText }] : []),
            { label: escapeHtml(homeName), value: `${result.home.rating >= 0 ? "+" : ""}${result.home.rating.toFixed(2)}`, sub: `${result.home.gamesPlayed} games played` },
            { label: escapeHtml(awayName), value: `${result.away.rating >= 0 ? "+" : ""}${result.away.rating.toFixed(2)}`, sub: `${result.away.gamesPlayed} games played` },
          ])}
        `;
      })();

  return `
    <p class="subtitle">Pick any two teams — not necessarily ones scheduled to play — and see the model's implied line, using each team's rating as of the end of the selected week. No market line exists for a hypothetical matchup, so none is shown.</p>
    <form method="get" action="/slate">
      <input type="hidden" name="tab" value="sim">
      ${sportSeasonWeekFields(sport, season, week, availableSeasons, availableWeeks)}
      ${teamSelect("home", teams, home)}
      <span class="muted">vs</span>
      ${teamSelect("away", teams, away)}
      <button type="submit">Simulate</button>
    </form>
    ${resultBlock}
  `;
}

export function renderSlatePage(params: {
  sport: string;
  season: string;
  week: string;
  activeTab: string;
  predictions: PredictionRow[] | null;
  ratings: TeamRatingRow[] | null;
  teams: SimTeamOption[];
  simHome: string;
  simAway: string;
  simResult: HypotheticalMatchupResult | null;
  availableSeasons: number[];
  availableWeeks: number[];
  projectedScores: Map<number, ScoreProjection | null>;
}): string {
  const { sport, season, week, activeTab, predictions, ratings, teams, simHome, simAway, simResult, availableSeasons, availableWeeks, projectedScores } =
    params;
  const body = `
    <h1>Slate</h1>
    ${tabs(
      "slate",
      [
        { label: "Weekly Slate", html: weeklySlateTab(sport, season, week, predictions, availableSeasons, availableWeeks, projectedScores) },
        { label: "Power Ratings", html: powerRatingsTab(sport, season, week, ratings, availableSeasons, availableWeeks) },
        { label: "Matchup Sim", html: matchupSimTab(sport, season, week, teams, simHome, simAway, simResult, availableSeasons, availableWeeks) },
      ],
      TAB_INDEX[activeTab] ?? 0,
    )}
  `;
  return renderPage("Slate", body, "/");
}
