export function escapeHtml(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Token values match the dataviz skill's validated reference palette
// exactly (references/palette.md) — chart chrome/ink, status colors, and
// categorical slot 1 (blue, used as the site accent). Re-run
// scripts/validate_palette.js if any of these ever change.
const STYLES = `
  :root {
    color-scheme: light dark;
    --page: #f9f9f7;
    --surface: #fcfcfb;
    --surface-raised: #ffffff;
    --text: #0b0b0b;
    --text-secondary: #52514e;
    --muted: #898781;
    --border: rgba(11,11,11,0.10);
    --gridline: #e1e0d9;
    --accent: #2a78d6;
    --accent-wash: rgba(42,120,214,0.08);
    --good: #006300;
    --bad: #d03b3b;
    --warning: #fab219;
    /* Diverging pair (blue <-> red) for magnitude-with-sign encodings like
       power ratings — distinct from --good/--bad, which are reserved for
       outcome status (cover rate, CLV), not generic positive/negative. */
    --diverge-pos: #2a78d6;
    --diverge-neg: #e34948;
    /* Status colors for chart marks (non-text graphics, >=3:1 contrast) —
       mode-invariant by design, unlike --good/--bad above which are tuned
       separately for text contrast at 4.5:1. */
    --chart-good: #0ca30c;
    --chart-bad: #d03b3b;
    --chart-axis: #898781;
    --chart-baseline: #c3c2b7;
    --shadow: 0 1px 2px rgba(11,11,11,0.04), 0 1px 1px rgba(11,11,11,0.03);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --page: #0d0d0d;
      --surface: #1a1a19;
      --surface-raised: #201f1d;
      --text: #ffffff;
      --text-secondary: #c3c2b7;
      --muted: #898781;
      --border: rgba(255,255,255,0.10);
      --gridline: #2c2c2a;
      --accent: #3987e5;
      --accent-wash: rgba(57,135,229,0.12);
      --good: #0ca30c;
      --bad: #f87171;
      --diverge-pos: #3987e5;
      --diverge-neg: #e66767;
      --chart-baseline: #383835;
      --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 1px 1px rgba(0,0,0,0.2);
    }
  }
  :root[data-theme="dark"] {
    --page: #0d0d0d;
    --surface: #1a1a19;
    --surface-raised: #201f1d;
    --text: #ffffff;
    --text-secondary: #c3c2b7;
    --muted: #898781;
    --border: rgba(255,255,255,0.10);
    --gridline: #2c2c2a;
    --accent: #3987e5;
    --accent-wash: rgba(57,135,229,0.12);
    --good: #0ca30c;
    --bad: #f87171;
    --diverge-pos: #3987e5;
    --diverge-neg: #e66767;
    --chart-baseline: #383835;
    --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 1px 1px rgba(0,0,0,0.2);
  }

  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; padding: 0 0 4rem;
    background: var(--page); color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 1080px; margin: 0 auto; padding: 0 1.5rem; }

  /* Top bar */
  .topbar {
    background: var(--surface); border-bottom: 1px solid var(--border);
    margin-bottom: 2rem;
  }
  .topbar-inner {
    max-width: 1080px; margin: 0 auto; padding: 0 1.5rem;
    display: flex; align-items: center; gap: 1.75rem; height: 56px;
  }
  .wordmark {
    font-size: 1rem; font-weight: 800; letter-spacing: -0.01em; color: var(--text);
    display: flex; align-items: center; gap: 0.4rem; white-space: nowrap;
  }
  .wordmark .dot { color: var(--accent); }
  nav { display: flex; gap: 0.25rem; font-size: 0.86rem; overflow-x: auto; }
  nav a {
    color: var(--text-secondary); text-decoration: none; font-weight: 600;
    padding: 0.4rem 0.7rem; border-radius: 6px; white-space: nowrap;
  }
  nav a:hover { color: var(--text); background: var(--accent-wash); }
  nav a.active { color: var(--accent); background: var(--accent-wash); }
  .topbar-tag {
    margin-left: auto; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.03em;
    text-transform: uppercase; color: var(--muted); white-space: nowrap;
  }

  h1 { font-size: 1.5rem; font-weight: 800; letter-spacing: -0.01em; margin: 0 0 0.3rem; }
  h2 { font-size: 1.05rem; font-weight: 700; margin: 2.25rem 0 0.85rem; letter-spacing: -0.005em; }
  h2:first-of-type { margin-top: 0; }
  .subtitle { color: var(--text-secondary); margin: 0 0 1.5rem; font-size: 0.9rem; max-width: 68ch; }

  .banner {
    background: var(--accent-wash); border: 1px solid var(--border); border-left: 3px solid var(--accent);
    border-radius: 8px; padding: 0.8rem 1rem; margin-bottom: 1.75rem; font-size: 0.85rem; color: var(--text-secondary);
  }
  .banner strong { color: var(--text); }

  /* Stat tile row — the KPI-forward headline treatment */
  .stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1px;
    background: var(--border); border: 1px solid var(--border); border-radius: 10px; overflow: hidden;
    margin-bottom: 1.75rem; box-shadow: var(--shadow);
  }
  .stat-tile { background: var(--surface-raised); padding: 1rem 1.1rem; }
  .stat-tile .stat-label { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 0 0 0.3rem; }
  .stat-tile .stat-value { font-size: 1.7rem; font-weight: 800; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; line-height: 1.1; }
  .stat-tile .stat-value.good { color: var(--good); }
  .stat-tile .stat-value.bad { color: var(--bad); }
  .stat-tile .stat-sub { font-size: 0.78rem; color: var(--muted); margin-top: 0.2rem; }

  /* Cards */
  .card {
    background: var(--surface-raised); border: 1px solid var(--border); border-radius: 10px;
    padding: 1.1rem 1.1rem 0.6rem; margin-bottom: 1.75rem; box-shadow: var(--shadow);
  }
  .chart-card { background: var(--surface-raised); border: 1px solid var(--border); border-radius: 10px;
    padding: 1rem 1rem 0.5rem; margin-bottom: 1.75rem; box-shadow: var(--shadow);
  }

  /* Tables */
  table { width: 100%; border-collapse: collapse; background: var(--surface-raised); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; box-shadow: var(--shadow); }
  th, td { text-align: left; padding: 0.6rem 0.85rem; border-bottom: 1px solid var(--gridline); font-size: 0.87rem; }
  th { color: var(--muted); font-weight: 700; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.03em; background: var(--surface); }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover td { background: var(--accent-wash); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .good { color: var(--good); }
  .bad { color: var(--bad); }
  .muted { color: var(--muted); }
  a.run-link { color: var(--accent); text-decoration: none; font-weight: 600; }
  a.run-link:hover { text-decoration: underline; }

  /* Badges/pills — status never carries meaning by color alone; label text is the badge content itself */
  .badge {
    display: inline-flex; align-items: center; gap: 0.3rem;
    padding: 0.18rem 0.55rem; border-radius: 999px; font-size: 0.76rem; font-weight: 700;
    font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  .badge-good { background: color-mix(in srgb, var(--chart-good) 14%, transparent); color: var(--good); }
  .badge-bad { background: color-mix(in srgb, var(--chart-bad) 14%, transparent); color: var(--bad); }
  .badge-neutral { background: var(--accent-wash); color: var(--text-secondary); }
  .sport-chip {
    display: inline-block; padding: 0.1rem 0.5rem; border-radius: 5px; font-size: 0.72rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.02em; background: var(--accent-wash); color: var(--accent);
  }

  code { background: var(--accent-wash); padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.85em; }

  form { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; flex-wrap: wrap; align-items: center; }
  select, input[type="number"] {
    background: var(--surface-raised); color: var(--text); border: 1px solid var(--border);
    border-radius: 7px; padding: 0.45rem 0.6rem; font-size: 0.86rem; font-family: inherit;
  }
  button {
    background: var(--accent); color: #fff; border: none; border-radius: 7px;
    padding: 0.5rem 0.9rem; font-size: 0.86rem; font-weight: 700; font-family: inherit; cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }

  /* Chart marks */
  .chart-bar-good { fill: var(--chart-good); }
  .chart-bar-bad { fill: var(--chart-bad); }
  .chart-axis-label { fill: var(--chart-axis); font-size: 10px; }
  .chart-value-label { fill: var(--text); font-size: 10px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .chart-baseline-line { stroke: var(--chart-baseline); stroke-width: 1; stroke-dasharray: 3 3; }
  .chart-na-label { fill: var(--muted); font-size: 10px; }

  /* Inline power-rating bar — diverging encoding (blue = above average,
     red = below), centered on a zero baseline. Bar length is relative to
     the max |rating| in the list it's rendered within (set via inline
     style, computed per page). */
  .power-bar-cell { min-width: 180px; }
  .power-bar-track {
    position: relative; height: 14px; border-radius: 4px;
    background: var(--gridline); overflow: hidden;
  }
  .power-bar-fill {
    position: absolute; top: 0; bottom: 0; border-radius: 3px;
  }
  .power-bar-fill.pos { left: 50%; background: var(--diverge-pos); }
  .power-bar-fill.neg { right: 50%; background: var(--diverge-neg); }
  .power-bar-center {
    position: absolute; top: -2px; bottom: -2px; left: 50%; width: 1px;
    background: var(--chart-baseline);
  }

  /* CSS-only tabs (radio-input hack, no JS) — tab-input radios live before
     tab-labels/tab-panels in the DOM so :checked ~ general-sibling
     selectors can target both. Each tabset instance is scoped by a unique
     id prefix so multiple tabsets can coexist on one page. */
  .tabset { margin-bottom: 1.75rem; }
  .tabset input.tab-input { position: absolute; opacity: 0; pointer-events: none; }
  .tab-labels { display: flex; gap: 0.2rem; border-bottom: 1px solid var(--border); overflow-x: auto; margin-bottom: 1.25rem; }
  .tab-labels label {
    padding: 0.6rem 0.9rem; font-size: 0.85rem; font-weight: 700; color: var(--text-secondary);
    cursor: pointer; white-space: nowrap; border-bottom: 2px solid transparent; margin-bottom: -1px;
    user-select: none;
  }
  .tab-labels label:hover { color: var(--text); }
  .tab-panels .tab-panel { display: none; }
  .tab-panels .tab-panel.tab-panel-first { display: block; }

  @media (max-width: 640px) {
    main { padding: 0 1rem; }
    .topbar-inner { padding: 0 1rem; height: auto; flex-wrap: wrap; padding-top: 0.6rem; padding-bottom: 0.6rem; gap: 0.6rem 1rem; }
    .topbar-tag { margin-left: 0; }
    .stat-row { grid-template-columns: repeat(2, 1fr); }
  }
`;

export function renderPage(title: string, bodyHtml: string, activePath = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Bet That</title>
<style>${STYLES}</style>
</head>
<body>
${topbar(activePath)}
<main>${bodyHtml}</main>
</body>
</html>`;
}

function topbar(activePath: string): string {
  const link = (href: string, label: string) =>
    `<a href="${href}"${activePath === href ? ' class="active"' : ""}>${label}</a>`;
  return `
    <div class="topbar">
      <div class="topbar-inner">
        <span class="wordmark">BET<span class="dot">•</span>THAT</span>
        <nav>
          ${link("/", "Slate")}
          ${link("/backtests", "Backtests")}
        </nav>
        <span class="topbar-tag">Diagnostics · not live picks</span>
      </div>
    </div>
  `;
}

/** Kept for pages that still call nav() directly — the topbar above already includes navigation, so this is now a no-op wrapper for backward compatibility during the transition. */
export function nav(): string {
  return "";
}

export interface StatTile {
  label: string;
  value: string;
  tone?: "good" | "bad" | "neutral";
  sub?: string;
}

/** The KPI-row treatment — headline numbers get a hero stat-tile instead of being buried in the first row of a table. */
export function statTiles(tiles: StatTile[]): string {
  return `
    <div class="stat-row">
      ${tiles
        .map(
          (t) => `
        <div class="stat-tile">
          <p class="stat-label">${escapeHtml(t.label)}</p>
          <p class="stat-value${t.tone && t.tone !== "neutral" ? ` ${t.tone}` : ""}">${t.value}</p>
          ${t.sub ? `<p class="stat-sub">${t.sub}</p>` : ""}
        </div>`,
        )
        .join("")}
    </div>
  `;
}

/** A rounded status badge — cover-rate/CLV style pill, text-labeled so status is never color-alone. */
export function badge(text: string, tone: "good" | "bad" | "neutral" = "neutral"): string {
  return `<span class="badge badge-${tone}">${text}</span>`;
}

export function sportChip(sport: string): string {
  return `<span class="sport-chip">${escapeHtml(sport)}</span>`;
}

export interface TabSpec {
  label: string;
  html: string;
}

/**
 * CSS-only tabs (no JS) via the radio-input hack — see the .tabset/.tab-*
 * rules in STYLES. idPrefix must be unique per tabset on a page. `active`
 * (default 0) lets a page reload (e.g. a tab's own form submitting via
 * GET) re-select the tab the user was actually on, instead of always
 * resetting to the first one.
 */
export function tabs(idPrefix: string, specs: TabSpec[], active = 0): string {
  const inputs = specs
    .map((_, i) => `<input type="radio" name="${idPrefix}" id="${idPrefix}-${i}" class="tab-input"${i === active ? " checked" : ""}>`)
    .join("");
  const labels = specs.map((s, i) => `<label for="${idPrefix}-${i}">${escapeHtml(s.label)}</label>`).join("");
  const panels = specs
    .map((s, i) => `<div class="tab-panel${i === active ? " tab-panel-first" : ""}">${s.html}</div>`)
    .join("");
  const dynamicCss = specs
    .map(
      (_, i) => `
    #${idPrefix}-${i}:checked ~ .tab-labels label[for="${idPrefix}-${i}"] { color: var(--accent); border-bottom-color: var(--accent); }
    #${idPrefix}-${i}:checked ~ .tab-panels .tab-panel:nth-of-type(${i + 1}) { display: block; }`,
    )
    .join("");

  return `
    <div class="tabset">
      ${inputs}
      <style>${dynamicCss}</style>
      <div class="tab-labels">${labels}</div>
      <div class="tab-panels">${panels}</div>
    </div>
  `;
}
