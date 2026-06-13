# Kinesa

Multi-take motion-capture analysis, in your browser.

Drop one or more mocap recordings (Motive CSV, TOPLabs JSON, or a ZIP
containing several) onto the player. The first take becomes the
**master**; each subsequent take is a **slave** with its own knob on
the master timeline, auto-tiled in 3D space. Align takes by hand or
snap every unlocked slave to its per-take peak; click joints in the
3D scene to plot any (node × metric) pair; brush a single ROI that
drives stats, graphs, CSV export and playback at once. Re-drop a
known file later → alignment, ROI, POI, lock state and spatial
offset are remembered.

Ghost overlay (`G`) superimposes takes in 3D for visual comparison;
Cascade (`C`) plots the dominant side's kinetic chain proximal→distal
with peak-order readout; every graph exports to PNG for reports.

Full feature tour and release notes: [`CHANGES.md`](./CHANGES.md).
Pending features: [`TODO.md`](./TODO.md). Audit log: [`AUDIT.md`](./AUDIT.md).

## Stack

Built on the [qry stack](https://github.com/Bloechle/qry-js) v1.1.0 —
everything loads from CDN, pinned in `index.html`:

| Layer | Source |
|---|---|
| `qry.js` (DOM core, global `$`) | `gh/Bloechle/qry-js@1.1.0` |
| `qry-ui.css` (shell + tokens) | `gh/Bloechle/qry-js@1.1.0` |
| `qry-kit.js` (glue: toast, sidebar, keyboard, files…) | `gh/Bloechle/qry-js@1.1.0`, mapped to the bare `qry-kit` specifier via the importmap |
| Shoelace 2.20.1 (widgets) · Lucide 1.17.0 (icons) | jsDelivr |
| Three.js 0.150.1 (3D) · D3 7.9 (charts) · JSZip 3.10 | unpkg / cdnjs |

Version pins live in **one place** — the `<script type="importmap">`
and `<link>`/`<script>` tags at the top of `index.html`.

## Run

Open `index.html` from a static server (ES modules require http://,
not file://):

```
python3 -m http.server
```

No build step, no bundler, no local dependencies.

Unit tests for the pure data primitives run in plain node:
`node tests/test-peaks.mjs && node tests/test-probe.mjs &&
node tests/test-cascade.mjs && node tests/test-ghost.mjs   # needs: npm i jsdom (browser-env mock)`.

## Structure

```
index.html      shell, dialogs, importmap, app init
kinesa.css      app-specific styles on top of qry-ui.css
app/            14 single-concern controllers (KinesaApp orchestrates)
ui/             12 widgets / view layers (charts, slider, strips…)
data/           11 data-format & processing modules (parsers,
                pipeline, smoothing, stats, metrics, detectors)
scene/          5 THREE.js domain modules (nodes, bones, trails…)
lib/            4 cross-cutting modules (domain vocabulary:
                object-types, skeleton; generic helpers: html,
                three-helpers)
tests/          4 node unit tests (peaks, probe, cascade, ghost)
claude-analysis/  offline Python pipeline + reference HTML reports
```

## Source data

- **Motive (OptiTrack) CSV** — direct import.
- **TOPLabs JSON** — direct import.

Developed at TOPLabs / CoPe Lab, University of Fribourg.
MIT © Jean-Luc Bloechle & Claude.ai

## Naming conventions

- **chart vs graph** — *Chart\** names the charting subsystem
  (ChartWidget, ChartRenderer…); *graph* is one plotted panel inside
  it (GraphsModel, renderGraph). Fields hold class roles
  (`#chartWidget`, `#timelineSlider`, `#timelineBridge`).
- **master / slave takes** — domain terms for the reference timeline
  and the takes aligned against it; used consistently across code,
  UI and docs.
- **HTML ids & events** — kebab-case (`#chart-widget`,
  `range-change`). File names: PascalCase for class modules,
  lowercase for non-class modules (metrics-catalog, frame-utils).
- **Storage** — every localStorage key is `kinesa_`-prefixed.

The demo take fetched at startup is `KinesaDemo.zip` (repo-side
file, not part of the source bundle).
