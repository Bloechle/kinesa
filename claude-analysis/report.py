"""
report.py — Self-contained HTML report builder for mocap analyses.

One-call API to assemble a clean, downloadable HTML report from a set of
figures and metric tables. Figures are embedded as base64 PNGs (single-file
delivery, no external assets), each with a download button. Metric tables
are rendered natively as HTML cards — no font truncation, no PNG.

Save your figures to a temporary location (e.g. `/tmp`) — only the resulting
HTML needs to go to `/mnt/user-data/outputs`.

Usage:
    from report import Report

    r = Report(
        title="Tennis backhand — Adrien vs Julie",
        subjects=[("Adrien", "a"), ("Julie", "b")],
        conditions="5 takes per player · Motive @ 360 Hz · "
                   "Racket rigid body (centre of string bed) used for impact",
    )
    r.lede = "At the racket face, <strong>Adrien strikes at 16.1 m/s</strong>..."

    r.add_section(
        heading="1 · Why the racket face, not the hand",
        fig_path="/tmp/A_racket_vs_hand.png",
        caption="Solid = racket; dashed = hand. Racket reaches max <b>after</b>...",
        method="Savitzky-Golay window 21, central-difference velocity.",
    )

    r.add_metrics(
        heading="5 · Summary metrics",
        columns=["Racket peak (m/s)", "Hand peak (m/s)",
                 "Racket/Hand", "X-factor before impact", "Reproducibility"],
        rows=[
            ("Adrien", "a", ["16.14 ± 0.98", "5.91 ± 0.40", "2.73×", "28.7° ± 2.4", "6.1%"]),
            ("Julie",  "b", ["9.63 ± 0.72",  "3.36 ± 0.28", "2.87×", "4.9° ± 3.4",  "7.5%"]),
        ],
        caption="Five takes per player, mean ± std...",
    )

    r.caveat = "n = 1 player on each side..."
    r.footer = "Pipeline: <code>mocap.py</code> + <code>report.py</code>."
    r.write("/mnt/user-data/outputs/tennis_backhand_report.html")
"""
from __future__ import annotations
import base64
from pathlib import Path
from dataclasses import dataclass, field


__all__ = ['Report', 'SUBJECT_KEY_STYLES', 'extract_observations']


# Colour keys for subject labels (header pill + metric-card accent).
# Each entry: (background tint, foreground colour, solid accent for dot).
SUBJECT_KEY_STYLES = {
    'a': ('#e6f0fc', '#0b62d6', '#0b62d6'),    # blue
    'b': ('#fde8e8', '#b91c1c', '#b91c1c'),    # red
    'c': ('#e7f5ec', '#15803d', '#15803d'),    # green
    'd': ('#fef3c7', '#a16207', '#a16207'),    # amber
}


# ---------------------------------------------------------------------------
# Section types — each implements `render() -> str`
# ---------------------------------------------------------------------------
@dataclass
class _FigureSection:
    heading: str
    fig_path: str
    caption: str
    method: str | None = None
    download_name: str | None = None

    def render(self) -> str:
        b64 = _b64_image(self.fig_path)
        method = (f'    <div class="meth">{self.method}</div>\n'
                  if self.method else '')
        dl = self.download_name or Path(self.fig_path).name
        return f"""<h2>{_esc(self.heading)}</h2>
<figure>
  <img src="data:image/png;base64,{b64}" alt="{_esc(self.heading)}">
  <div class="fig-toolbar">
    <button class="icon-btn" title="Copy image to clipboard" aria-label="Copy image" onclick="copyFig(this)">
      {_ICON_COPY}{_ICON_CHECK}
    </button>
    <button class="icon-btn" title="Download PNG" aria-label="Download PNG" onclick="downloadFig(this, '{dl}')">
      {_ICON_DOWNLOAD}
    </button>
  </div>
  <figcaption>
    {self.caption}
{method}  </figcaption>
</figure>
"""


@dataclass
class _MetricsSection:
    heading: str
    columns: list                       # column headers (excludes player col)
    rows: list                          # [(name, key, [values...]), ...]
    caption: str | None = None
    player_label: str = "Player"
    download_name: str | None = None
    column_directions: list | None = None   # per-column 'higher'/'lower'/'neutral'/None

    def render(self) -> str:
        # Pre-compute per-column min/max for heatmap, when directions given
        col_stats = self._heatmap_stats()

        # Header row (column names)
        header_cells = (
            f'<th class="col-label">{_esc(self.player_label)}</th>'
            + ''.join(f'<th>{_esc(c)}</th>' for c in self.columns)
        )

        # Data rows — one per subject
        body_rows = []
        for name, key, values in self.rows:
            style = SUBJECT_KEY_STYLES.get(key, SUBJECT_KEY_STYLES['a'])
            _, _, dot_color = style
            label_cell = (
                f'<td class="col-label">'
                f'<span class="metric-dot" style="background:{dot_color}"></span>'
                f'<strong>{_esc(name)}</strong></td>'
            )
            value_cells_html = []
            for i, v in enumerate(values):
                style_attr = ''
                if col_stats[i] is not None:
                    parsed = _parse_lead_number(v)
                    color = _heatmap_color(parsed, col_stats[i]['min'],
                                           col_stats[i]['max'],
                                           col_stats[i]['direction'])
                    if color:
                        style_attr = f' style="{color}"'
                value_cells_html.append(
                    f'<td data-label="{_esc(self.columns[i])}"{style_attr}>'
                    f'{_esc(v)}</td>')
            body_rows.append(f'<tr>{label_cell}{"".join(value_cells_html)}</tr>')

        dl = self.download_name or _slugify_csv(self.heading)
        toolbar = (
            '  <div class="metrics-toolbar">\n'
            '    <button class="icon-btn" title="Copy table to clipboard" '
            'aria-label="Copy table" onclick="copyTable(this)">'
            f'{_ICON_COPY}{_ICON_CHECK}</button>\n'
            '    <button class="icon-btn" title="Download CSV" '
            f'aria-label="Download CSV" onclick="downloadTable(this, \'{dl}\')">'
            f'{_ICON_DOWNLOAD}</button>\n'
            '  </div>'
        )

        table_html = (
            '<div class="metrics-wrap">\n'
            '  <div class="metrics-scroll">\n'
            '    <table class="metrics-table">\n'
            f'      <thead><tr>{header_cells}</tr></thead>\n'
            '      <tbody>\n'
            + '\n'.join('        ' + r for r in body_rows)
            + '\n      </tbody>\n'
            '    </table>\n'
            '  </div>\n'
            f'{toolbar}\n'
            + (f'  <div class="metrics-caption">{self.caption}</div>\n'
               if self.caption else '')
            + '</div>'
        )

        return f"""<h2>{_esc(self.heading)}</h2>
<section class="metrics-block">
{table_html}
</section>
"""

    def _heatmap_stats(self):
        """For each column, compute min/max if a direction is given."""
        result = []
        for i in range(len(self.columns)):
            direction = None
            if self.column_directions and i < len(self.column_directions):
                direction = self.column_directions[i]
            if direction not in ('higher', 'lower'):
                result.append(None); continue
            vals = [_parse_lead_number(row[2][i]) for row in self.rows
                    if i < len(row[2])]
            vals = [v for v in vals if v is not None]
            if len(vals) < 2:
                result.append(None); continue
            result.append({'min': min(vals), 'max': max(vals),
                           'direction': direction})
        return result


@dataclass
class _ObservationsSection:
    heading: str
    items: list                       # list of HTML-allowed strings

    def render(self) -> str:
        bullets = '\n'.join(f'    <li>{item}</li>' for item in self.items)
        return f"""<h2>{_esc(self.heading)}</h2>
<section class="observations">
  <ul>
{bullets}
  </ul>
</section>
"""


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
@dataclass
class Report:
    """Assemble a single-file HTML mocap report.

    Attributes you set directly:
      title       — page title and h1 heading
      subjects    — list of (name, key) tuples; key is one of 'a','b','c','d'
      conditions  — short string after the subject keys (capture conditions)
      lede        — intro paragraph (HTML allowed); set after init
      synthesis   — closing paragraph drawing together the cross-section
                    findings (HTML allowed); appears after the last section,
                    before the caveat
      caveat      — limits-of-the-analysis paragraph (HTML allowed)
      footer      — technical metadata at the bottom (HTML allowed)

    Add content with `add_section()` (figure) or `add_metrics()` (card table),
    then call `write(path)`.
    """
    title: str
    subjects: list = field(default_factory=list)
    conditions: str = ""
    lede: str = ""
    synthesis: str = ""
    caveat: str = ""
    footer: str = ""
    sections: list = field(default_factory=list)

    # ---- public API --------------------------------------------------------
    def add_section(self, heading: str, fig_path: str, caption: str,
                    method: str | None = None,
                    download_name: str | None = None):
        """Append a figure section.

        heading       — e.g. "1 · Why the racket face, not the hand"
        fig_path      — path to the PNG file to embed
        caption       — main caption text (HTML allowed; use <b> to emphasize)
        method        — optional method note rendered as a grey sub-box
        download_name — filename for the download button (defaults to basename
                        of fig_path)
        """
        self.sections.append(
            _FigureSection(heading, fig_path, caption, method, download_name))

    def add_metrics(self, heading: str, columns: list, rows: list,
                    caption: str | None = None,
                    player_label: str = "Player",
                    download_name: str | None = None,
                    column_directions: list | None = None):
        """Append a metrics card table (rendered as native HTML).

        heading           — section heading
        columns           — list of column-header strings; does NOT include
                            the player/row-label column (added automatically
                            as the leftmost column).
        rows              — list of (name, key, values) tuples, where:
                              name   = row label (e.g. "Adrien")
                              key    = color key 'a'/'b'/'c'/'d' matching subjects
                              values = list of value strings, one per column
        caption           — optional caption text below the table
        player_label      — header text for the leftmost column (default "Player")
        download_name     — CSV filename for the download button (default:
                            derived from the heading, e.g. "5 · Summary
                            metrics" → "summary_metrics.csv")
        column_directions — optional list, same length as `columns`, with one
                            of 'higher', 'lower', 'neutral', or None per
                            column. When 'higher' or 'lower' is given, that
                            column gets a soft heatmap tint (green = best
                            direction, red = worst direction). 'neutral' /
                            None leaves the cell uncoloured. Useful when
                            readers don't have the domain intuition for which
                            direction is good on each metric.
        """
        self.sections.append(
            _MetricsSection(heading, columns, rows, caption, player_label,
                            download_name, column_directions))

    def add_observations(self, items: list, heading: str = "Key observations"):
        """Append a clean bulleted card of factual observations.

        items   — list of strings (HTML allowed). Typically generated by
                  `extract_observations(rows, columns, column_directions)`,
                  but you can also pass hand-written observations.
        heading — section heading (default "Key observations").

        Convention: each item should be a single declarative statement —
        a fact about the data, not a prescription. "Loic has the longest
        hold" is fine; "Loic should keep training holds" is not.
        """
        if items:
            self.sections.append(_ObservationsSection(heading, list(items)))

    def write(self, output_path: str):
        """Build the HTML and write to disk."""
        html = self._build()
        Path(output_path).write_text(html, encoding='utf-8')
        return output_path

    def html(self) -> str:
        """Return the assembled HTML as a string (no file I/O)."""
        return self._build()

    # ---- private -----------------------------------------------------------
    def _build(self) -> str:
        return (
            self._head()
            + self._header_block()
            + (self._lede_block() if self.lede else "")
            + "".join(s.render() for s in self.sections)
            + (self._synthesis_block() if self.synthesis else "")
            + (self._caveat_block() if self.caveat else "")
            + self._footer_block()
            + self._foot()
        )

    def _head(self) -> str:
        return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{_esc(self.title)}</title>
<style>{_CSS}</style>
</head>
<body>
<main>
"""

    def _header_block(self) -> str:
        keys_html = "".join(self._subject_key(name, key)
                            for (name, key) in self.subjects)
        sep = "&nbsp;·&nbsp;" if self.subjects and self.conditions else ""
        return f"""<header>
  <h1>{_esc(self.title)}</h1>
  <div class="sub">{keys_html}{sep}{self.conditions}</div>
</header>
"""

    def _subject_key(self, name: str, key: str) -> str:
        style = SUBJECT_KEY_STYLES.get(key, SUBJECT_KEY_STYLES['a'])
        bg, fg, _ = style
        return (f'<span class="key" style="background:{bg};color:{fg}">'
                f'{_esc(name)}</span>')

    def _lede_block(self) -> str:
        return f'<div class="lede">\n{self.lede}\n</div>\n'

    def _synthesis_block(self) -> str:
        return (f'<div class="synthesis">\n'
                f'  <b>Synthesis.</b> {self.synthesis}\n'
                f'</div>\n')

    def _caveat_block(self) -> str:
        return f"""<div class="caveat">
  <b>Limits of this analysis.</b> {self.caveat}
</div>
"""

    def _footer_block(self) -> str:
        if not self.footer:
            return ""
        return f'<footer>{self.footer}</footer>\n'

    def _foot(self) -> str:
        return f"""</main>
<script>{_JS}</script>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _b64_image(path: str) -> str:
    return base64.b64encode(Path(path).read_bytes()).decode('ascii')


def _esc(s: str) -> str:
    """Minimal HTML escaping for plain text fields (titles, headings, names)."""
    return (s.replace('&', '&amp;').replace('<', '&lt;')
             .replace('>', '&gt;').replace('"', '&quot;'))


def _slugify_csv(heading: str) -> str:
    """Derive a CSV filename from a section heading.
    Strips leading numbering (e.g. '5 · '), lowercases, replaces non-alnum with
    underscore. Example: '5 · Summary metrics' → 'summary_metrics.csv'.
    """
    import re
    s = re.sub(r'^\s*\d+\s*[·.\-:]\s*', '', heading)   # strip leading "5 · "
    s = re.sub(r'[^\w\s-]', '', s.lower())
    s = re.sub(r'[\s_-]+', '_', s).strip('_')
    return f"{s or 'metrics'}.csv"


def _parse_lead_number(s):
    """Extract the leading number from a string like '16.14 ± 0.98', '2.73×',
    '6.1%', or '−12.3'. Returns None if no number is found."""
    import re
    if s is None:
        return None
    txt = str(s).replace('−', '-')                # minus-sign vs hyphen-minus
    m = re.search(r'[+-]?\d+\.?\d*', txt)
    return float(m.group()) if m else None


def _heatmap_color(value, vmin, vmax, direction):
    """Return inline CSS background-color for a heatmap cell.

    direction = 'higher' → high values are green (best), low are red (worst).
    direction = 'lower'  → low values are green, high are red.
    Subtle, low-saturation tints — visible at a glance, not garish.
    Returns None when no coloring should apply.
    """
    if value is None or vmin == vmax:
        return None
    t = (value - vmin) / (vmax - vmin)            # 0..1, where 1 = max
    if direction == 'lower':
        t = 1 - t                                  # invert: low becomes 'best'
    if t >= 0.5:
        intensity = (t - 0.5) * 2                  # 0..1
        return f"background-color: rgba(34, 197, 94, {intensity * 0.20:.3f})"
    else:
        intensity = (0.5 - t) * 2
        return f"background-color: rgba(239, 68, 68, {intensity * 0.18:.3f})"


def extract_observations(rows, columns, column_directions):
    """Generate factual observation strings from a metrics table.

    For each scoreable column (direction = 'higher' or 'lower'), produces one
    bullet identifying the extremes and their values. Strictly descriptive —
    no prescriptions like 'should improve', no value judgements beyond which
    end of the range is which. Intended for readers who don't yet have the
    domain intuition for which direction is good on each metric.

    Returns a list of HTML-formatted strings ready for `Report.add_observations`.
    """
    out = []
    for i, (col_name, direction) in enumerate(zip(columns, column_directions or [])):
        if direction not in ('higher', 'lower'):
            continue
        scored = []
        for name, _key, values in rows:
            if i >= len(values): continue
            v = _parse_lead_number(values[i])
            if v is not None:
                scored.append((name, v, values[i]))
        if len(scored) < 2:
            continue
        if direction == 'higher':
            best  = max(scored, key=lambda x: x[1])
            worst = min(scored, key=lambda x: x[1])
            sup, inf = "highest", "lowest"
        else:
            best  = min(scored, key=lambda x: x[1])
            worst = max(scored, key=lambda x: x[1])
            sup, inf = "lowest",  "highest"
        out.append(
            f"<b>{_esc(col_name)}:</b> "
            f"{_esc(best[0])} {sup} ({_esc(best[2])}) — "
            f"{_esc(worst[0])} {inf} ({_esc(worst[2])})"
        )
    return out


# ---------------------------------------------------------------------------
# CSS / JS — single source of truth for report styling
# ---------------------------------------------------------------------------
_CSS = """
  :root {
    --fg: #1a1a1a; --muted: #6b7280; --bg: #fafafa; --card: #fff;
    --accent: #0b62d6; --rule: #e3e6ec;
    --accent-soft: #c5d8f1; --accent-tint: #f4f8fd;
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.04);
    --shadow-md: 0 2px 8px rgba(0, 0, 0, 0.06);
    --radius: 12px;
  }
  * { box-sizing: border-box; }
  body {
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: var(--fg); background: var(--bg); margin: 0; padding: 2rem 1rem;
  }
  main { max-width: 980px; margin: 0 auto; }
  header { border-bottom: 1px solid var(--rule); padding-bottom: 1rem; margin-bottom: 1.5rem; }
  h1 { margin: 0 0 .3rem 0; font-size: 1.7rem; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: .92rem; }
  h2 { margin: 3rem 0 .6rem 0; font-size: 1.2rem;
       padding-bottom: .45rem; border-bottom: 1px solid var(--rule); }

  .lede {
    background: var(--accent-tint); border: 1px solid var(--accent-soft);
    border-radius: var(--radius); padding: 1rem 1.2rem;
    margin: 1rem 0 1.5rem; box-shadow: var(--shadow-sm);
  }
  .lede strong { color: var(--accent); }

  /* ---- Figure cards ---- */
  figure {
    background: var(--card); border: 1px solid var(--rule);
    border-radius: var(--radius); padding: 1rem;
    margin: .8rem 0 1.5rem; overflow: hidden;
    box-shadow: var(--shadow-sm); transition: box-shadow .2s;
  }
  figure:hover { box-shadow: var(--shadow-md); }
  figure img { width: 100%; height: auto; display: block; border-radius: 6px; }
  .fig-toolbar {
    display: flex; justify-content: flex-end; align-items: center;
    margin-top: .6rem; padding-top: .6rem;
    border-top: 1px dashed var(--rule);
  }
  .download-btn,
  .icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    cursor: pointer; font-family: inherit;
    color: var(--accent); background: #f0f5fc;
    border: 1px solid #c5d8f1; border-radius: 6px;
    transition: background .15s, transform .1s, color .15s, border-color .15s;
  }
  .icon-btn {
    width: 30px; height: 30px; padding: 0; margin-left: .35rem;
  }
  .icon-btn:first-child { margin-left: 0; }
  .icon-btn:hover { background: #e0ecfa; }
  .icon-btn:active { transform: translateY(1px); }
  .icon-btn svg { display: block; width: 15px; height: 15px; }
  .icon-btn .icon-success { display: none; }
  .icon-btn.copied {
    background: #dcfce7; border-color: #86efac; color: #15803d;
  }
  .icon-btn.copied .icon-default { display: none; }
  .icon-btn.copied .icon-success { display: block; }
  /* legacy class kept as alias to icon-btn for backward compatibility */
  .download-btn {
    padding: .35rem .75rem; font-size: .82rem; font-weight: 500;
  }
  .download-btn:hover { background: #e0ecfa; }
  .download-btn:active { transform: translateY(1px); }
  figcaption { margin-top: .8rem; font-size: .92rem; color: var(--muted); }
  figcaption b { color: var(--fg); }

  /* ---- Subject key pills (header) ---- */
  .key {
    display: inline-block; padding: 2px 9px; border-radius: 4px;
    font-size: .82rem; font-weight: 600; margin-right: .3rem;
  }

  /* ---- Method note inside figcaption ---- */
  .meth {
    font-size: .87rem; color: var(--muted);
    background: #f1f3f5; padding: .6rem .8rem; border-radius: 6px;
    margin-top: .6rem;
  }

  /* ---- Metrics table (semantic HTML <table>) ---- */
  .metrics-block { margin: .8rem 0 1.5rem; }
  .metrics-wrap {
    border: 1px solid var(--rule); border-radius: var(--radius);
    background: var(--card); box-shadow: var(--shadow-sm);
    overflow: hidden;     /* clips inner corners to the rounded outline */
  }
  .metrics-scroll {
    overflow-x: auto;     /* only scrolls if the table truly cannot fit */
  }
  .metrics-table {
    width: 100%; border-collapse: collapse; font-size: .95rem;
  }
  .metrics-table thead { background: #f7f9fc; }
  .metrics-table th {
    text-align: right; padding: .65rem 1rem;
    font-size: .76rem; text-transform: uppercase;
    letter-spacing: .05em; color: var(--muted);
    font-weight: 500; vertical-align: bottom;
    border-bottom: 1px solid var(--rule);
    /* allow header text to wrap so the table avoids horizontal scroll */
  }
  .metrics-table th.col-label { text-align: left; }
  .metrics-table td {
    padding: .85rem 1rem;
    font-variant-numeric: tabular-nums;
    text-align: right; white-space: nowrap;
    border-bottom: 1px solid var(--rule);
    transition: background .12s;
  }
  .metrics-table td.col-label {
    text-align: left; font-variant-numeric: normal;
    display: flex; align-items: center; gap: .55rem;
  }
  .metrics-table td.col-label strong { font-weight: 600; }
  .metrics-table tbody tr:last-child td { border-bottom: none; }
  .metrics-table tbody tr:hover td { background: #fafbfc; }
  .metric-dot {
    width: 9px; height: 9px; border-radius: 50%;
    flex-shrink: 0; display: inline-block;
    box-shadow: 0 0 0 2px rgba(255, 255, 255, .9);
  }
  .metrics-toolbar {
    display: flex; justify-content: flex-end; align-items: center;
    padding: .5rem .75rem;
    border-top: 1px dashed var(--rule);
    background: var(--card);
  }
  .metrics-caption {
    padding: .85rem 1.1rem;
    border-top: 1px solid var(--rule);
    font-size: .92rem; color: var(--muted);
    background: var(--card);
  }
  .metrics-caption b { color: var(--fg); }

  /* ---- Observations (auto-generated factual bullets from a metrics table) ---- */
  .observations {
    background: var(--card); border: 1px solid var(--rule);
    border-radius: var(--radius); padding: 1rem 1.4rem;
    margin: .8rem 0 1.5rem; box-shadow: var(--shadow-sm);
  }
  .observations ul {
    margin: 0; padding-left: 1.2rem;
  }
  .observations li {
    margin: .35rem 0; line-height: 1.5;
    font-size: .94rem;
  }
  .observations b { color: var(--accent); margin-right: .15em; }

  /* ---- Caveat box ---- */
  .caveat {
    background: #fff7e6; border-left: 3px solid #d97706;
    padding: .85rem 1.1rem; border-radius: 8px;
    margin: 1.5rem 0; font-size: .9rem;
  }
  .caveat b { color: #92400e; }

  /* ---- Synthesis (closing summary) — mirrors the lede styling for
         a visual symmetry between the report's opening and closing blocks ---- */
  .synthesis {
    background: var(--accent-tint); border: 1px solid var(--accent-soft);
    border-radius: var(--radius);
    padding: 1rem 1.2rem; margin: 2rem 0 1.5rem;
    box-shadow: var(--shadow-sm);
  }
  .synthesis b { color: var(--accent); margin-right: .15em; }

  /* ---- Footer ---- */
  footer {
    margin-top: 2.5rem; padding-top: 1rem;
    border-top: 1px solid var(--rule);
    color: var(--muted); font-size: .85rem;
  }
  footer code {
    background: #f1f3f5; padding: 1px 6px; border-radius: 3px;
    font-size: .9em;
  }

  /* ---- Responsive: metrics table scrolls horizontally on narrow screens ---- */
  @media (max-width: 720px) {
    .metrics-table th, .metrics-table td { padding: .65rem .8rem; }
  }
"""

_JS = """
  function downloadFig(btn, filename) {
    const img = btn.closest('figure').querySelector('img');
    const a = document.createElement('a');
    a.href = img.src; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  }
  async function copyFig(btn) {
    const img = btn.closest('figure').querySelector('img');
    try {
      const blob = await (await fetch(img.src)).blob();
      await navigator.clipboard.write([new ClipboardItem({[blob.type]: blob})]);
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1400);
    } catch (e) {
      console.error('Copy failed:', e);
      btn.title = 'Copy not supported in this browser';
    }
  }
  function _tableRows(table) {
    return Array.from(table.querySelectorAll('tr')).map(tr =>
      Array.from(tr.querySelectorAll('th, td'))
        .map(c => c.textContent.replace(/\\s+/g, ' ').trim()));
  }
  async function copyTable(btn) {
    const table = btn.closest('.metrics-wrap').querySelector('table');
    const rows = _tableRows(table);
    const tsv = rows.map(r => r.join('\\t')).join('\\n');
    const html = table.outerHTML;
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([tsv], {type: 'text/plain'}),
        'text/html':  new Blob([html], {type: 'text/html'}),
      })]);
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1400);
    } catch (e) {
      console.error('Copy failed:', e);
      btn.title = 'Copy not supported in this browser';
    }
  }
  function downloadTable(btn, filename) {
    const table = btn.closest('.metrics-wrap').querySelector('table');
    const rows = _tableRows(table);
    const csv = rows.map(r => r.map(v => {
      // CSV-quote if value contains comma, quote, or newline
      return /[",\\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(',')).join('\\n');
    // BOM so Excel opens UTF-8 (degree, ±, etc.) correctly
    const blob = new Blob(['\\ufeff' + csv], {type: 'text/csv;charset=utf-8'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
  }
"""

# ---------------------------------------------------------------------------
# Inline SVG icons (Lucide-style: 24×24 viewBox, currentColor stroke)
# ---------------------------------------------------------------------------
_ICON_DOWNLOAD = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
                  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
                  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'
                  '<polyline points="7 10 12 15 17 10"/>'
                  '<line x1="12" y1="15" x2="12" y2="3"/></svg>')

_ICON_COPY = ('<svg class="icon-default" viewBox="0 0 24 24" fill="none" '
              'stroke="currentColor" stroke-width="2" stroke-linecap="round" '
              'stroke-linejoin="round">'
              '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>'
              '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'
              '</svg>')

_ICON_CHECK = ('<svg class="icon-success" viewBox="0 0 24 24" fill="none" '
               'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" '
               'stroke-linejoin="round">'
               '<polyline points="20 6 9 17 4 12"/></svg>')
