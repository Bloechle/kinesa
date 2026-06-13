# TODO

Pending features and known limitations, from largest to smallest.

The webapp is a **generic exploration tool** for mocap takes, used in
workshops by students. Single-take analysis and multi-take overlay
comparison both shipped in v1.0; this list is what remains. The goal
is **not** to reproduce the Python pipeline, which lives separately
for offline reports.

## Shipped since this list was written (kept for traceability)

- ✅ **Multi-take overlay aligned on event** — v1.0 (master/slave
  takes, snap-to-peak, per-slave lock, CSV in master namespace).
- ✅ **X-factor, joint angle, up-angle** — in the metrics catalog.
- ✅ **Probe signature (burst / cyclic / static)** — v1.1
  (`data/peaks.js` + `data/Probe.js`); surfaced in the load toast and
  the InfoWidget Probe section.
- ✅ **First-significant-peak alignment** — v1.1: peak finding (POI
  anchor and snap-to-peak) now uses the first local maximum ≥ 80% of
  the global max (`data/peaks.js::firstSignificantPeak`), the port of
  the Python `find_event_first_peak`. Stable for double-contact
  gestures, identical to the global max otherwise.

## Shipped in v1.2

- ✅ **Ghost overlay (G)** — superimpose every take at its recorded
  position (tiling/nudge ignored), bones tinted per take, master solid
  / slaves translucent. Visual comparison of aligned takes; the
  "ghosted skeletons" phase-4 item from the original multi-take plan.
- ✅ **PNG graph export** — per-card button rasterises the chart SVG at
  2× on white for report embeds (`ChartExport.exportPng`).
- ✅ **Cascade (C)** — selects the proximal→distal chain routed from
  the probe's dominant bone (arm or leg, left or right), colours it
  cool→hot, plots every node's speed on one fresh graph, and toasts
  the peak order with inversion detection — the kinetic-chain energy
  transfer reads as a left-to-right peak progression.

## Pending

- **Signature-routed defaults.** The probe signature now exists; use
  it to route small downstream choices without asking the user — e.g.
  smoothing strength for `cyclic` takes, detrending hint for `static`
  ones. (The old "snap window per gesture" item referred to a
  ROI-window behaviour that no longer exists; snapToPeak aligns takes
  and leaves the ROI untouched.)

- **NaN-gap badge.** Surface a small badge on a take chip when any
  key bone has more than a few consecutive NaN frames — these break
  smoothing and metric calculations silently. Two thresholds matter:
  % NaN coverage and longest consecutive NaN run (the latter is what
  really breaks downstream metrics). `data/peaks.js` is already
  NaN-tolerant; the badge is pure surfacing work.

- **Angular-speed smoothing.** Currently a 3-tap moving average in
  `ChartWidget`. If quaternion tracking is noisy on real workshop
  data, promote to the Gaussian smoother used for linear velocities
  (`Smoother.js`).

- **Reduced-rig handling.** Some captures use a reduced bone set
  (e.g. Hip-Ab-Chest-Neck-Head, no Spine2/3/4). `Bones.js` should
  bridge missing intermediate bones the way the Python
  `mc.edges_for_bones()` helper does, so the stick figure renders
  connected rather than fragmented.

- **Chip search/filter.** Pills are right up to ~30 nodes per
  category; 3+ skeletons push past that. Add a text filter above any
  category whose chip count exceeds ~30 (substring match on
  `nodeName`). Trivial; don't add it before the threshold is hit.
