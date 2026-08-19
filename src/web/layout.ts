export function escapeHtml(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLES = `
  :root {
    color-scheme: light dark;
    --bg: #f7f7f8;
    --surface: #ffffff;
    --text: #1a1a1e;
    --muted: #6b6f76;
    --border: #e3e3e6;
    --accent: #3b5bfd;
    --good: #17803d;
    --bad: #c0342c;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #121316;
      --surface: #1b1c20;
      --text: #eceef1;
      --muted: #9a9ea6;
      --border: #2c2d32;
      --accent: #7c93ff;
      --good: #4ade80;
      --bad: #f87171;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.5rem 4rem;
    background: var(--bg); color: var(--text);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  main { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
  h2 { font-size: 1.1rem; margin: 2rem 0 0.75rem; }
  .subtitle { color: var(--muted); margin: 0 0 1.5rem; font-size: 0.9rem; }
  .banner {
    background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--accent);
    border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 1.5rem; font-size: 0.85rem; color: var(--muted);
  }
  nav { margin-bottom: 1.5rem; font-size: 0.85rem; }
  nav a { color: var(--accent); text-decoration: none; margin-right: 1rem; }
  nav a:hover { text-decoration: underline; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); font-size: 0.88rem; }
  th { color: var(--muted); font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.02em; }
  tr:last-child td { border-bottom: none; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .good { color: var(--good); }
  .bad { color: var(--bad); }
  .muted { color: var(--muted); }
  a.run-link { color: var(--accent); text-decoration: none; }
  a.run-link:hover { text-decoration: underline; }
`;

export function renderPage(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Bet That</title>
<style>${STYLES}</style>
</head>
<body>
<main>${bodyHtml}</main>
</body>
</html>`;
}

export function nav(): string {
  return `<nav><a href="/">Backtest runs</a><a href="/ratings">Ratings</a></nav>`;
}
