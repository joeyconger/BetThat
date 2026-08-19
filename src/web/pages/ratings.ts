import { renderPage, nav, escapeHtml } from "../layout.js";
import type { TeamRatingRow, PredictionRow } from "../../db/repo.js";

function form(action: string, label: string, sport: string, season: string, week: string): string {
  return `
    <form method="get" action="${action}" style="display:flex; gap:0.5rem; margin-bottom:1.5rem; flex-wrap:wrap;">
      <select name="sport">
        <option value="nfl" ${sport === "nfl" ? "selected" : ""}>NFL</option>
        <option value="cfb" ${sport === "cfb" ? "selected" : ""}>CFB</option>
      </select>
      <input type="number" name="season" placeholder="Season, e.g. 2025" value="${escapeHtml(season)}" required>
      <input type="number" name="week" placeholder="Through week" value="${escapeHtml(week)}" required>
      <button type="submit">${escapeHtml(label)}</button>
    </form>
  `;
}

export function renderRatingsPage(
  sport: string,
  season: string,
  week: string,
  ratings: TeamRatingRow[] | null,
): string {
  const table =
    ratings === null
      ? ""
      : ratings.length === 0
        ? `<p class="muted">No ratings computed for ${escapeHtml(sport)} ${escapeHtml(season)} through week ${escapeHtml(week)} yet — run <code>npm run ratings:compute</code> for it first.</p>`
        : `<table>
            <thead><tr><th>#</th><th>Team</th><th class="num">Rating</th><th class="num">± error</th></tr></thead>
            <tbody>${ratings
              .map(
                (r, i) => `<tr>
                  <td class="muted">${i + 1}</td>
                  <td>${escapeHtml(r.teamName)}</td>
                  <td class="num">${r.rating.toFixed(2)}</td>
                  <td class="num muted">${r.ratingError === null ? "—" : r.ratingError.toFixed(2)}</td>
                </tr>`,
              )
              .join("")}</tbody>
          </table>
          <p class="subtitle" style="margin-top:1rem;">
            <a class="run-link" href="/predictions?sport=${escapeHtml(sport)}&season=${escapeHtml(season)}&week=${Number(week) + 1}">
              See week ${Number(week) + 1} predictions using these ratings →
            </a>
          </p>`;

  const body = `
    <h1>Team ratings</h1>
    <p class="subtitle">EPA-driven Elo ratings, in points (positive = above league average).</p>
    ${nav()}
    ${form("/ratings", "Show ratings", sport, season, week)}
    ${table}
  `;
  return renderPage("Ratings", body);
}

export function renderPredictionsPage(
  sport: string,
  season: string,
  week: string,
  predictions: PredictionRow[] | null,
): string {
  const table =
    predictions === null
      ? ""
      : predictions.length === 0
        ? `<p class="muted">No predictions generated for ${escapeHtml(sport)} ${escapeHtml(season)} week ${escapeHtml(week)} yet — run <code>npm run ratings:predict</code> for it first.</p>`
        : `<table>
            <thead><tr><th>Matchup</th><th class="num">Model line (home)</th><th class="num">Market line (home)</th><th class="num">Confidence (±pts)</th></tr></thead>
            <tbody>${predictions
              .map(
                (p) => `<tr>
                  <td>${escapeHtml(p.awayTeam)} @ ${escapeHtml(p.homeTeam)}</td>
                  <td class="num">${p.modelSpreadHome.toFixed(1)}</td>
                  <td class="num">${p.marketSpreadHome === null ? "—" : p.marketSpreadHome.toFixed(1)}</td>
                  <td class="num muted">${p.confidence === null ? "—" : p.confidence.toFixed(1)}</td>
                </tr>`,
              )
              .join("")}</tbody>
          </table>`;

  const body = `
    <h1>Model predictions</h1>
    <p class="subtitle">Raw model output vs. market — diagnostic only, not a picks feature.</p>
    ${nav()}
    <div class="banner">
      See the backtest report for whether this model's picks beat the closing line —
      these numbers are not validated for betting either way.
    </div>
    ${form("/predictions", "Show predictions", sport, season, week)}
    ${table}
  `;
  return renderPage("Predictions", body);
}
