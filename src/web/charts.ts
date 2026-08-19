import { escapeHtml } from "./layout.js";

export interface CoverRateBar {
  label: string;
  coverRate: number | null;
  games: number;
}

/**
 * Single-series bar chart, cover rate (0-1) against a 50% baseline —
 * built as inline SVG per this project's "no heavy framework" rule (no
 * charting library dependency). One series, so no legend is needed per
 * the dataviz skill's rules; a native <title> element gives each bar a
 * real hover tooltip without any JS.
 */
export function renderCoverRateChart(bars: CoverRateBar[], baseline = 0.5): string {
  const width = 640;
  const height = 200;
  const paddingLeft = 8;
  const paddingRight = 8;
  const paddingTop = 20;
  const paddingBottom = 28;
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;
  const gap = 10;
  const maxBarWidth = 90;
  const barWidth = Math.min(maxBarWidth, (plotWidth - gap * (bars.length - 1)) / bars.length);
  const groupWidth = bars.length * barWidth + (bars.length - 1) * gap;
  const groupLeft = paddingLeft + (plotWidth - groupWidth) / 2;
  const baselineY = paddingTop + plotHeight * (1 - baseline);

  const bars_svg = bars
    .map((bar, i) => {
      const x = groupLeft + i * (barWidth + gap);
      const axisLabel = `<text x="${x + barWidth / 2}" y="${height - 8}" text-anchor="middle" class="chart-axis-label">${escapeHtml(bar.label)}</text>`;

      if (bar.coverRate === null || bar.games === 0) {
        return `${axisLabel}<text x="${x + barWidth / 2}" y="${paddingTop + plotHeight / 2}" text-anchor="middle" class="chart-na-label">n/a</text>`;
      }

      const barHeight = Math.max(plotHeight * bar.coverRate, 1);
      const y = paddingTop + plotHeight - barHeight;
      const fillClass = bar.coverRate >= baseline ? "chart-bar-good" : "chart-bar-bad";
      const pct = (bar.coverRate * 100).toFixed(1);

      return `
        <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="3" class="${fillClass}">
          <title>${escapeHtml(bar.label)}: ${pct}% cover rate (${bar.games} games)</title>
        </rect>
        <text x="${x + barWidth / 2}" y="${y - 5}" text-anchor="middle" class="chart-value-label">${pct}%</text>
        ${axisLabel}
      `;
    })
    .join("");

  return `
    <div class="chart-card">
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="cover rate by bucket, dashed line marks the 50% no-edge baseline" style="width:100%; height:auto; display:block;">
        <line x1="${paddingLeft}" y1="${baselineY}" x2="${width - paddingRight}" y2="${baselineY}" class="chart-baseline-line" />
        <text x="${width - paddingRight}" y="${baselineY - 4}" text-anchor="end" class="chart-axis-label">50%</text>
        ${bars_svg}
      </svg>
    </div>
  `;
}
