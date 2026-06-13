# claude-analysis — Offline analysis pipeline

The Python side of the project. Parallel to the webapp at the project
root: the webapp visualises one take live; this pipeline analyses
batches of takes from a chat with Claude and produces a shareable
HTML report.

```
Motive CSV → JSON (via the project's exporter)
           → Python analysis (mocap.py)
           → Self-contained HTML report (report.py)
```

JSON exports get dropped into a Claude chat with this folder loaded as
project knowledge. Claude routes the gesture through the taxonomy in
the guide and writes a single `<topic>_report.html`.

## Files

- **`MOCAP_ANALYSIS_GUIDE.md`** — read first. §6 taxonomy routes any
  gesture (striking, cyclic locomotion, explosive launch, whole-body
  rotation, static balance, multi-segment kicking) to its analysis
  pattern. Also covers the standard pipeline, pitfalls, and the
  report-anatomy convention.
- **`mocap.py`** — universal primitives: JSON loader, Savitzky-Golay
  smoothing, kinematics (velocity, angular velocity, joint angles),
  event detection & alignment, 3D skeleton rendering, trajectory
  normalisation, signal detrending.
- **`report.py`** — one-call HTML report builder. Figures embedded as
  base64, metric tables as native HTML with heatmap tinting and
  copy/download buttons.

## Reference reports

Five known-good outputs, one per gesture family:

- `tennis_backhand_report.html` — striking, two subjects compared
- `slapshot_report.html` — striking with implement (lower-body lead)
- `cartwheel_report.html` — whole-body rotation with inversion
- `pirouette_report.html` — vertical-axis spin
- `handstand_report.html` — static balance with detrending

`tennis_backhand_report.html` is the canonical template — copy its
script structure when starting a new sport.
