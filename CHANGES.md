# Kinesa v1.0.0 — first public release

Multi-take motion-capture analysis, in your browser. First public
release, built on the published **qry stack v1.1.0** (CDN-pinned to
`gh/Bloechle/qry-js@1.1.0`). The codebase went through 23 internal
audit passes — architecture, performance, correctness, security,
KISS/DRY — before publication; that history is preserved below.

## Features

- **Multi-take playback** — drop CSV / JSON / ZIP; first take is the
  master, the rest are slaves, auto-tiled in 3D. Default drop replaces
  the session, Ctrl/Cmd+drop appends.
- **Alignment** — manual knob drag, master-POI ensemble shift, and
  snap-to-peak on the first significant peak (NaN-tolerant, stable for
  double-contact gestures), with per-slave lock.
- **Probe signature** — each take is classified burst / cyclic / static
  from its dominant bone's speed curve.
- **Graphs** — click joints to plot any (node × metric) pair across 12
  metrics (position, velocity, acceleration, joint/up angle, angular
  velocity, X-factor); stats card with `@frame` jumps; CSV export in the
  master namespace; per-card PNG export for reports.
- **Ghost overlay (`G`)** — superimpose every take at its recorded
  position, bones tinted per take (master solid, slaves translucent).
- **Cascade (`C`)** — plots the dominant side's proximal→distal kinetic
  chain (cool→hot) with peak-order and inversion readout.
- **Persistence** — re-drop a known file and its alignment, ROI, POI,
  lock and spatial offset are restored (LRU localStorage, `kinesa_`
  prefix).
- **Skeleton tooling** — Detect Leg from 3 free markers; multi-take
  Trails synchronised on the master timeline.

## Stack

qry stack v1.1.0 (`qry.js` · `qry-ui.css` · `qry-kit.js`, pinned to
`gh/Bloechle/qry-js@1.1.0`) · Three.js 0.150.1 · D3 7.9 · Shoelace
2.20.1 · Lucide 1.17.0 · vanilla ES modules. No build step.

## Repository

- Unit tests live in `tests/` (`test-peaks`, `test-probe`,
  `test-cascade`, `test-ghost`); 40/40, plain node (ghost needs jsdom).
- `KinesaDemo.zip` is the startup demo. The old `mocap.css`,
  `mocap_analysis_guide.md` and `MocapDemo.zip` relics have been removed.

Pending features: [`TODO.md`](./TODO.md). Internal audit log: [`AUDIT.md`](./AUDIT.md).

---

## Pre-release development log

The `v1.0`–`v1.2` labels below were **internal milestones** during
development, kept for traceability. Everything ships together in the
`v1.0.0` public release above.

### Milestone — Ghost · PNG · Cascade (internal v1.2)

Three workshop-facing features on top of the v1.1 stack.

## Ghost overlay — `G` / scene button

Superimpose every loaded take at its recorded position: tiling and
manual nudge offsets are ignored, bones are tinted with each take's
chip colour — master solid, slaves translucent — so aligned takes can
be compared *visually* in 3D, not only on the charts. Joints overlay
too, so divergence between subjects reads directly on the skeleton.
Toggle back and the spatial layout returns untouched. Zero per-frame
allocation: ghost materials are created at toggle time and resolved
at mesh creation.

## PNG graph export — per-card button

Every graph card gets an image button next to its close button:
the chart SVG is rasterised at 2× on a white background and
downloaded as `kinesa_graph_<timestamp>.png` — drop it straight into
a workshop report or slide deck.

## Cascade — `C` / sidebar

One keystroke turns the kinetic-chain lesson into a picture: the
proximal→distal chain is routed from the loaded take's dominant bone
(right/left, arm or leg — the probe decides), selected with a
cool→hot colour ramp (Hip blue → Hand red), and plotted as speed
curves on one fresh graph. The toast reports the peak sequence —
`Hip 0.42s → Chest 0.46s → RHand 0.58s — proximal→distal ✓` — and
flags the first inversion when the transfer is broken (`Chest peaks
before Hip ⚠`). Peak times use the first-significant-peak alignment
from v1.1, so double-contact gestures stay stable.

## Hardening (pass 22)

- **Ghost material churn fixed** — tint application is now
  signature-gated, so routine reconciles (nudges, visibility, locks)
  no longer dispose materials referenced by live meshes; real tint
  changes (take add/remove, master promotion) retint exactly once and
  rebuild. Locked by `test-ghost.mjs` (12 behavioural assertions).
- **Three toast-injection sites closed** — the cascade peak readout,
  plus two pre-existing v1.0 sites in the snap-to-peak feedback that
  interpolated file-derived node names into the HTML-rendering toast.
- DRY/KISS: shared `#cardBtn` helper for the graph-card icon buttons;
  single ghost teardown path.

Unit tests: 40/40 (`test-peaks.mjs`, `test-probe.mjs`,
`test-cascade.mjs`, `test-ghost.mjs`), module load 46/46.

### Milestone — qry stack port (internal v1.1)

Kinesa now runs on the published **qry stack v1.0.0** (CDN-pinned)
instead of its local pre-release copies.

- **Removed** `qry.js`, `qry-app.js`, `qry-app.css` (local pre-release
  stack) → replaced by `gh/Bloechle/qry@1.0.0` `qry.js` + `qry-ui.css`
  + `qry-kit.js` from jsDelivr. Core API and every `.qry-*` class used
  by Kinesa verified compatible; visual deltas limited to Shoelace
  toasts replacing the old custom ones.
- **Importmap as single version pin** — `qry-kit` and `three/addons/`
  are bare specifiers; bumping a version touches one line in
  `index.html`. `OrbitControls` no longer hard-codes a second
  Three.js URL.
- **API adaptations** — `timestampForFilename()` → kit `stamp()`;
  `makeKeyboard()` now returns `{ on, destroy }`; `makeSidebar` gets
  `{ collapseBtn: '#btn-collapse' }` (kit default is `#qry-collapse`);
  `lucide.createIcons()` calls → kit `icons()`; boot via kit
  `boot({ theme: false, ready })` — theme pinned light (cinema mode).
- **Lifecycle** — keyboard registry, sidebar and auto-hide header are
  now stored and detached in `KinesaApp.destroy()`.
- **Security** — kit `toast()` renders its message as HTML; new
  `lib/html.js::esc()` escapes user-derived strings (take/node names,
  error messages) at every toast site.
- **Dead files removed** — `mocap.css` (renamed predecessor of
  `kinesa.css`), `mocap_analysis_guide.md` (stale ancestor of
  `claude-analysis/MOCAP_ANALYSIS_GUIDE.md`).
- **Pinned third-party versions** — Shoelace 2.20.0→2.20.1 (+ dark
  theme stylesheet for future use), Lucide `@latest`→1.17.0.
- Verified: 45/45 modules load cleanly against the real qry@1.0.0
  core + kit (jsdom module load test, audit pass 17).

## Deep audit (pass 18)

- **kit `download()` everywhere** — replaced 4 hand-rolled
  Blob/objectURL implementations (ChartExport, DataWidget ×2,
  SceneManager); fixes 3 sites that revoked the object URL
  synchronously after `click()`, which can abort large downloads.
- **core `trigger()`** — all 22 `dispatchEvent(new CustomEvent(…))`
  sites collapsed to one-liners.
- **core `on()/off()`** — 42 raw `add/removeEventListener` calls
  migrated; the codebase now speaks a single event idiom.
- **`ui/Metrics.js` → `ui/metrics-catalog.js`** — resolves the name
  clash with `data/Metrics.js` (two files, same name, different
  concerns); lowercase filename = non-class-module convention.
- **`ChartRenderer.destroy()`** now clears its pending resize timer
  (a queued resize could fire `#handleResize` on a destroyed chart).
- **Clear memory is confirm()-gated** — wiping all remembered take
  alignments was a single silent click; now a Shoelace confirm.
- Screenshot filenames use kit `stamp()` instead of `Date.now()`.

## Structure & terminology (pass 19)

- **chart/graph rule** — Chart* names the subsystem, graph names one
  plotted panel. `#graphWidget` → `#chartWidget`, container id →
  `chart-widget`, the `graphs` constructor param of TimelineBridge
  and Analysis → `charts`. GraphsModel / renderGraph unchanged (they
  are about panels).
- **Fields name their role** — `#rangeSlider` → `#timelineSlider`,
  `#timeline` → `#timelineBridge`, `#scene` → `#orchestrator`.
- **All HTML ids kebab-case** — 8 camelCase ids normalised
  (player-title, scene-container, timeline-slider, frame-display,
  time-display, speed-group, chart-widget, info-widget).
- **`data/Parser.js` → `data/Normalizer.js`** (+ `parseData()` →
  `normalize()`) — it validates and normalises; it never parsed.
- **`lib/csv-parser.js` → `data/csv-parser.js`** — lib/ is now
  strictly cross-cutting vocabulary (object-types, skeleton) and
  generic helpers (html, three-helpers).
- **Storage unified on `kinesa_`** — scene config migrates from the
  old `mocap_` prefix once, transparently.
- **`MocapDemo.zip` → `KinesaDemo.zip`** — ⚠ rename the file in the
  repo to match (startup demo loads silently or not at all until
  then).

## Production hardening + features (pass 20)

- **XSS surface closed** — InfoWidget escaped every file-derived
  string it rendered (take name, object/node names, capture metadata,
  merge lineage). A crafted shared JSON take can no longer inject
  markup. All other widgets verified `.text()`-clean.
- **Boot-safe storage** — the one-time `mocap_` → `kinesa_` migration
  can no longer block boot in private/disabled-storage contexts.
- **NEW · First-significant-peak alignment** — POI anchor and
  snap-to-peak align on the first local maximum ≥ 80% of the global
  max (`data/peaks.js`, port of the Python `find_event_first_peak`).
  Double-contact gestures stop flickering between takes; single-peak
  behaviour is unchanged. NaN-tolerant.
- **NEW · Probe signature** — each loaded take is classified
  `burst / cyclic / static` from its dominant bone's speed curve;
  shown in the load toast and the InfoWidget Probe section.
- Unit tests: `test-peaks.mjs` (12) and `test-probe.mjs` (6), plain
  node, no DOM needed.

### Milestone — first stable cut (internal v1.0)

Multi-take motion-capture analysis, in your browser.

This is the first stable release. The codebase has been through 16
structured audit passes covering architecture, performance,
correctness, encapsulation, defensive coding, dead-code elimination,
identifier resolution, accessibility, and KISS/DRY consolidation.
Every audit dimension converges to zero known issues.

## What it does

Drop one or more mocap recordings (Motive CSV, TOPLabs JSON, or a
ZIP containing several) onto the player. The first take becomes
the **master** (its timeline is the reference); each subsequent
take is a **slave** with its own knob on the master timeline,
auto-tiled in 3D space so the loaded skeletons don't overlap.

Drag a slave's knob to align takes by hand. Click a graph metric,
hit `S`, and Kinesa snaps every unlocked slave to its own peak —
so all peaks land on the master's peak frame. Lock individual
slaves to keep manual alignment when running snap-to-peak again.

Click joints in the 3D scene to plot them; mix any (selected
node × metric) pair on a graph card. Click the `@frame` link in
the stats card to jump the playhead to a peak. Re-drop a known
file later → its alignment, ROI, POI, lock state, and spatial
offset are remembered.

## Highlights

### Multi-take playback
- Drop multiple files at once or one ZIP — first becomes master,
  rest become slaves.
- Default drop replaces the session; **Ctrl/Cmd+drop** appends.
- Auto-tile in world X (1.5 m per slave) so skeletons don't overlap.
- Each take has its own visibility, lock, spatial offset, ×nudge
  buttons on its chip.

### Alignment
- **Master POI flag drag** shifts every slave by the same Δ
  (preserves relative alignment across the ensemble).
- **Slave knob drag** aligns one take against the master.
- **Snap-to-peak** finds the per-take peak of the focused chart
  metric and aligns every unlocked take so all peaks land on the
  master's peak frame.
- **Per-slave lock** (🔒 chip icon) — locked slaves are skipped by
  snap-to-peak, so manual alignment survives.
- **Hover knob** → floating label with `<takeName> · Δ +50f 🔒`.
- **Arrow keys** on hovered chip → nudge that slave by 1 frame
  (×10 with Shift). `L` toggles lock; `Delete` removes.

### Graphs
- Click joints/bones in the 3D scene to add to the selection.
- Each graph card mixes any (selected node × metric) pairs.
- 12 metrics: position (X/Y/Z), velocity (X/Y/Z, magnitude,
  horizontal magnitude), acceleration magnitude, joint angle,
  up-angle, angular velocity, and X-factor (trunk vs. pelvis yaw,
  when applicable).
- Auto dual Y axis when mixed units are plotted.
- Stats card with peak speed, mean speed, peak accel, distance,
  net displacement, Δheight, ROM, peak angular velocity, X-factor
  range. Click `@frame` to snap the playhead to that peak —
  multi-take aware (translates frame coordinates correctly).

### CSV export
- `Ctrl+E` exports the current chart's series as CSV.
- Multi-take aware: column headers prefix the take name, frames
  are unioned in the **master** timeline namespace so cross-take
  rows align correctly.

### Cinema-mode UI
- Edge-to-edge 3D scene on pure black.
- Auto-hide header on scroll-down.
- All slider interactions (POI flag, slave knobs, range handles,
  scrub) auto-pause playback.
- ROI band styled neutral slate so colored markers (orange POI
  flag, tinted slave knobs, red playhead) stay the visible actors.

### Persistence
- **Session memory** : drop a file once, dial in the alignment,
  close the tab. Re-drop the same file later → offset, spatial
  offset, lock, POI, and ROI all restored.
- LRU localStorage, capped at 50 entries; schema-versioned for
  future migrations.
- Sidebar **Session → Clear memory** wipes the cache.

### Skeleton tooling
- **Detect Leg** : place the playhead at a moment where 3
  unlabeled markers are visible; the system identifies them as
  hip / knee / ankle and creates a kinematic chain. Markers leave
  the Unlabeled set so they no longer affect the free-marker
  Center centroid.
- **Trails** : show motion history of selected joints across all
  takes, synchronized on the master timeline. Master's Center
  marker gets bigger, brighter trails.

## Architecture

13 single-concern modules in `app/`, each with a clear role and
no cross-coupling beyond explicit dependencies:

```
Analysis            POI / snap-to-peak
BatchController     sidebar batch dialog (convert / trim)
KinesaApp           orchestrator (the only non-leaf)
Picker              3D click/hover routing
Playback            timeline state machine
PlayerHUD           player-bar readouts (frame, time, title, icon)
SceneCommands       scene-side button commands (fullscreen, etc.)
SceneConfigDialog   Scene Settings panel (sliders, color pickers)
SceneOrchestrator   animate loop + per-take scene lifecycle
Selection           3-part-key selection registry
SessionStore        per-take alignment memory (LRU localStorage)
TakeLoader          pure file → take pipeline
Takes               multi-take registry
TimelineBridge      slider sync + coordinate math
```

Plus:
- `ui/` — 12 modules (chart, take strip, slider, info widget,
  data widget, stats card, exporters, etc.)
- `data/` — 9 modules (Pipeline, Probe, Parser, Smoother, Stats,
  Metrics, BallDetector, LegDetector, frame-utils)
- `lib/` — 5 modules (csv-parser, skeleton, three-helpers,
  object-types, html)
- `scene/` — 5 modules (SceneManager, SceneRenderer, Nodes,
  Bones, Trails)
- `qry-kit.js` (CDN) — framework glue (sleep, clamp, throttle,
  toast, sidebar, header, keyboard, bindAll, stamp, icons)

## Shared utility surface

Three small helper modules consolidate cross-cutting patterns:

- **`qry-kit::clamp(x, lo, hi)`** — branchless number constraint.
  Used in 14 places across timeline / playback / chart / scene code.
- **`data/frame-utils.js::forEachNode(frames, callback)`** — walks
  every (frame × object × node) tuple. Used in 5 places across the
  data pipeline.
- **`lib/object-types.js::nodeKey(takeId, objectName, nodeName)`**
  — single source of truth for the canonical 3-part composite key
  used everywhere to address a joint. Selection / Nodes / Metrics
  all delegate here.

## Performance

The animate loop runs allocation-free in steady state:

- Bones use a shared vertex template + in-place position attribute
  mutation. No `Mesh`, `BufferGeometry`, or typed-array
  allocation per frame.
- Unlabeled markers reconcile in place (mutate position; hide
  vanished names; revive on reappearance).
- Trails pool dot/line meshes; pooled meshes stay parented to the
  history group.
- Per-take iteration uses a cached `Takes.all()` snapshot.
- Picker rAF-coalesces pointermove so high-polling-rate mice
  don't trigger raycasts at 1000Hz.
- Hit-target arrays cached, invalidated only on mesh add/remove.
- ChartWidget shifts series on drag without copying data —
  the line generator's X accessor reads a mutable offset.

For a typical session (2 takes, full skeleton, 60 unlabeled
markers, 3 plotted-series trail dots) at 60Hz, the steady-state
allocation footprint is essentially zero.

## Stack

qry stack v1.0.0 (qry.js · qry-ui.css · qry-kit.js) · Three.js · D3 · Shoelace · Lucide · vanilla ES modules.

No build step. No bundler. Drop the files into a static server
and open `index.html`.

## Source data

- **Motive (OptiTrack) CSV** — direct import.
- **TOPLabs JSON** — direct import.

Developed at TOPLabs / CoPe Lab, University of Fribourg.
