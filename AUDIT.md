# Kinesa — internal audit log (v1.0.0 public release)

First public release ships on the qry stack v1.1.0
(`gh/Bloechle/qry-js@1.1.0`). The `v1.0`–`v1.2` prefixes on the passes
below are internal development milestones, not public version numbers —
everything converges in the single `v1.0.0` release.

---

# Audit pass 23 — v1.0.0 release prep

Stack migration + repository hygiene. No behaviour change.

```
QRY STACK PIN                   1.0.0 → 1.1.0  (repo renamed qry → qry-js;
                                     index.html importmap + qry.js / qry-ui.css
                                     links + test-ghost CDN fetch all moved to
                                     gh/Bloechle/qry-js@1.1.0. All 14 kit
                                     symbols Kinesa imports verified exported by
                                     1.1.0; makeKeyboard controller shape
                                     unchanged — clean minor bump, additive
                                     shadow fixes only.)
DEAD FILES                      0   (mocap.css + mocap_analysis_guide.md —
                                     reported removed in pass 17 but still on
                                     disk — now actually deleted; MocapDemo.zip
                                     removed, KinesaDemo.zip is the sole demo
                                     and matches the fetch in KinesaApp)
TEST LAYOUT                     tests/  (4 test-*.mjs moved out of root;
                                     in-tree imports ./ → ../)
UNTRACKED IDE CRUFT             0   (Kinesa.iml → .gitignore)
UNIT TESTS                      40/40 (unchanged, re-run from tests/)
```

---

# Kinesa v1.2 — audit pass 22 (adversarial review of pass 21)

Final pre-prod pass: the v1.2 feature code reviewed as hostile input.
Two real bugs found in code written one pass earlier — both now fixed
and regression-locked.

```
GHOST MATERIAL CHURN     FIXED — reconcile() runs on every takes change
                         (nudge, visibility, lock); #applyGhost was
                         disposing + recreating ALL ghost materials each
                         time while live meshes kept referencing the
                         disposed ones (rebuild only happened on toggle).
                         Now signature-gated: setGhost fires only when
                         the tint set actually changes (take add/remove,
                         master promotion), and every real change is
                         followed by rebuildAll. Locked by test-ghost.mjs
                         (12 behavioural assertions on a mocked renderer:
                         repeated reconciles are silent; add/swap retint
                         exactly once + rebuild; off → setGhost(null)).
TOAST INJECTION (again)  FIXED — the cascade feedback interpolated node
                         names (file-derived) into the HTML-rendering
                         toast; AND the same adversarial scan caught two
                         pre-existing v1.0 sites in snapToPeak feedback
                         (${p.nodeName}, ${ref.nodeName}) that pass 20
                         had missed because it scanned toast() call
                         sites, not the onFeedback indirection. All
                         esc()-routed; the scan now follows onFeedback.
DRY                      ChartWidget's two card icon buttons shared a
                         9-property style block → #cardBtn helper; dead
                         `rm` variable removed; `container` declared
                         before the closures that capture it.
KISS                     Bones.destroyGhost folded into setGhost(null) —
                         one teardown path.
MODULE LOAD TEST         46/46
UNIT TESTS               peaks 12 · probe 6 · cascade 10 · ghost 12 —
                         40/40
INJECTION SCAN           0 unescaped dynamic vars across toast AND
                         onFeedback sinks
CONSOLE / TODO / DEAD    0 / 0 / 0
```

Lesson recorded: **feature passes need the same adversarial re-audit
as migration passes** (lesson #1 generalised). The toast-injection
class specifically must be re-scanned whenever a new string reaches a
feedback sink, and the scan must follow indirections (`onFeedback`),
not just direct `toast()` calls.

---

# Kinesa v1.2 — audit pass 21 (feature build: ghost · PNG · cascade)

Three features, each implemented inside an existing seam and verified
by the same toolchain as the audits.

```
GHOST OVERLAY      SceneRenderer gains a ghostMode flag (offsets bypassed
                   in #processObject); Bones resolves per-take tinted
                   materials AT MESH CREATION (#materialFor at the three
                   #syncGroup call sites) — materials are built at toggle
                   time only, so the rAF loop stays allocation-free.
                   SceneOrchestrator owns the state (toggleGhost +
                   reconcile re-applies tints BEFORE building, so takes
                   dropped while ghost is on are born tinted). Hit/hover
                   meshes keep their materials — picking unaffected.
                   Ghost materials disposed on retint and in destroy().
PNG EXPORT         ChartExport.exportPng clones the SVG, inlines computed
                   color (currentColor axes) + font-family, rasterises at
                   2× on white via canvas, downloads through kit
                   download(). Per-card button beside the close button.
CASCADE            Analysis.cascade() routes the chain from the master's
                   retained probe (take.probe.dominant), swaps Selection
                   with a cool→hot gradient, ChartWidget.plotCascade
                   builds one fresh speed graph, GraphsModel.peakOf
                   (firstSignificantPeak) yields per-node times, and
                   orderCascade reports proximal→distal order or the
                   first inversion. Selection swap precedes plotting so
                   pruneSeries clears stale graphs naturally.
MODULE LOAD TEST   46/46
UNIT TESTS         peaks 12 · probe 6 · cascade 10 — 28/28
CONVERGENCE        unused exports 0 · unresolved imports 0 · dangling
                   id refs 0 · help dialog matches bound keys (G, C added)
```

---

# Kinesa v1.1 — audit pass 20 (production readiness + features)

Production-hardening audit, then two features the TODO had fully
specified (with the Python pipeline as reference).

```
UNESCAPED FILE-DERIVED HTML      0   (InfoWidget interpolated take name,
                                      object/node names, capture metadata
                                      and merge-lineage filenames straight
                                      into .html() — the one real XSS
                                      surface left; a crafted shared JSON
                                      take could execute. All routed
                                      through lib/html.js esc(). TakeStrip,
                                      SelectedStrip, ChartStatsCard,
                                      ChartWidget verified .text()-clean.)
BOOT-FATAL STORAGE PATHS         0   (the mocap_→kinesa_ migration ran
                                      unguarded at module load; private
                                      mode could block boot. Wrapped.
                                      SessionStore was already guarded.)
UNHANDLED ASYNC REJECTIONS       0   (drop/change handlers funnel into
                                      BatchController.#run's try/catch;
                                      processFiles is .catch()-ed; demo
                                      loader try/caught — all verified)
HELP DIALOG vs BOUND SHORTCUTS   exact match
STALE TODO ITEMS                 0   (multi-take overlay, X-factor, joint
                                      angle, up-angle had shipped; the
                                      ±400 ms snap window it referenced no
                                      longer exists. Reconciled.)
MODULE LOAD TEST                 46/46
UNIT TESTS                       peaks 12/12 · probe signature 6/6
```

## Features landed (both fully speced in TODO.md)

- **First-significant-peak alignment** — `data/peaks.js::
  firstSignificantPeak(series, getter, { fraction = 0.80 })`, the JS
  port of the Python `find_event_first_peak`. `GraphsModel.#peakIn`
  delegates to it, so BOTH the POI anchor and snap-to-peak now align
  on the first local maximum ≥ 80% of the global max — stable across
  takes for double-contact gestures (slap shot, golf drive), bit-
  identical to the old behaviour for single-peak signals. NaN-
  tolerant (local maxima judged against adjacent finite samples).
- **Probe signature** — `burst / cyclic / static` from peak-to-median
  ratio + significant-peak count on the dominant bone's speed curve
  (`countSignificantPeaks`, ≥150 ms separation). Surfaced in the load
  toast and as a Signature row in the InfoWidget Probe section.
  Thresholds (ratio < 2 → static, ≥3 peaks → cyclic, else burst) are
  documented heuristics, tuned on the reference gesture families.

## Test infrastructure note

`test-peaks.mjs` / `test-probe.mjs` run in plain node (the primitives
are DOM-free by design). Worth keeping in the repo alongside the
jsdom load test. Notable test-design lesson: the first synthetic
"cyclic" signal (raised |sin|) misclassified as static because its
median was high — real gait speed drops near the floor between foot
contacts. Synthetic fixtures must be physically representative.

---

# Kinesa v1.1 — audit pass 19 (structure & terminology)

Naming and boundary convergence. The rule set is now explicit
(README → Naming conventions); this pass made the code match it.

```
BRAND-STALE 'mocap' REFERENCES   0   (store prefix → kinesa_ with one-time
                                      migration; MocapDemo.zip → KinesaDemo.zip;
                                      stale mocap.css comment fixed. Domain uses
                                      of "mocap" — motion capture — kept.)
CHART/GRAPH DRIFT                0   (rule: Chart* = subsystem, graph = one
                                      panel. #graphWidget → #chartWidget,
                                      id graph-widget → chart-widget,
                                      TimelineBridge/Analysis `graphs` param →
                                      `charts`. GraphsModel & renderGraph keep
                                      their names — they ARE about panels.)
FIELD ≠ CLASS-ROLE MISMATCHES    0   (#rangeSlider → #timelineSlider,
                                      #timeline → #timelineBridge, #scene →
                                      #orchestrator — no more ambiguity next
                                      to #sceneManager / #sceneRenderer)
CAMELCASE HTML IDs               0   (8 normalised to kebab-case; events were
                                      already kebab)
MISLEADING MODULE NAMES          0   (data/Parser.js → data/Normalizer.js +
                                      parseData() → normalize() — it validates
                                      and normalises, it never parsed)
DIRECTORY-BOUNDARY VIOLATIONS    0   (lib/csv-parser.js → data/ beside the
                                      rest of format ingestion; lib/ is now
                                      strictly vocabulary + generic helpers)
ORPHAN IDs / DANGLING ID REFS    0
MODULE LOAD TEST                 45/45

✅ Convergence holds across 19 audit dimensions.
```

## Deliberate non-changes

- **master/slave** (194/33 uses) — kept: domain-accurate (master
  timeline, aligned slaves), woven through UX labels, help text and
  alignment semantics (lock, knobs, snap-to-peak). A rename to
  reference/aligned would be cosmetic churn with real regression
  surface. Documented as a convention instead.
- **TimelineSlider's `secondary-poi-*` events** — the slider speaks
  its own vocabulary (primary/secondary POI), the bridge translates
  to take semantics; renaming events would couple layers.
- **Domain word "mocap"** in comments and UI ("Drop MoCap files
  here") — that's motion capture, not the old brand.

---

# Kinesa v1.1 — audit pass 18 (deep KISS/DRY + stack idiom convergence)

Deep audit of the codebase itself (pass 17 audited the port). Baseline
was already clean — zero unused exports, zero console leftovers, zero
TODO markers in code, zero dead CSS rules, zero orphan markup ids. The
pass therefore focused on idiom consolidation and the latent bugs the
scans surfaced.

```
DUPLICATED BLOB-DOWNLOAD IDIOM   0   (was 4 across 3 files → kit download())
PREMATURE objectURL REVOKES      0   (was 3 — could abort large downloads;
                                      kit download() revokes after 1 s)
RAW dispatchEvent(new CustomEvent) 0 (was 22 → core trigger(type, detail))
RAW add/removeEventListener      0   (was 42 → core on()/off(), the idiom
                                      half the codebase already used)
PENDING-TIMER-AFTER-DESTROY      0   (ChartRenderer.destroy now clears
                                      _resizeTimer, matching ChartWidget)
MODULE NAME CLASHES              0   (ui/Metrics.js → ui/metrics-catalog.js;
                                      lowercase = non-class module convention,
                                      like icons.js / frame-utils.js)
DESTRUCTIVE ACTIONS UNCONFIRMED  0   (Clear memory now kit confirm()-gated)
UNUSED EXPORTS / CONSOLE / TODO  0
DEAD CSS RULES / ORPHAN IDs      0
MODULE LOAD TEST                 45/45

✅ Convergence holds across 18 audit dimensions.
```

## Deliberate non-changes (audited, kept)

- **Inlined `Math.sqrt(dx*dx+…)` in data/Metrics.js & data/Stats.js** —
  hot-path per-frame kinematics; the file documents the inlining.
  `Math.hypot` is slower; a `mag3` helper adds nothing but a call.
- **PlayerHUD time format** — kit `format.clock` pads minutes to two
  digits; the HUD's single-digit `m:ss.fff` is deliberate (commented)
  for short mocap takes.
- **ChartRenderer `_underscore` fields** — that file consistently uses
  public-ish underscore fields (`_seekCleanups`, `_windowResizeHandler`);
  converting one to `#` would worsen intra-file consistency.
- **Same-lifetime anonymous listeners without removes** (TimelineBridge
  → slider, ChartWidget → strip/model, KinesaApp → graphWidget) —
  owner and emitter share lifetime; pass-8 pattern, still valid.
- **Custom DnD instead of kit `makeDropZone`** — Kinesa's drop needs
  the Ctrl/Cmd modifier (append vs replace); the kit callback doesn't
  carry it.
- **Inline `display` toggles in BatchController** — panes are styled
  inline in index.html, so `show()/hide()` (which clear to stylesheet
  values) would break the flex layout.

## Audit-lesson #1 in action

The on()/off() migration was regex-driven; the immediate re-audit it
mandates caught 10 double-optional-chain artifacts (`??.on(`) and 3
trailing-comma artifacts (`},);`) before anything shipped. 45/45 after.

---

# Kinesa v1.1 — audit pass 17 (qry stack port)

Port to the published qry stack v1.0.0 (CDN), followed by a full
re-run of the static convergence checks. All 16 dimensions still
converge; one new dimension added (HTML-rendering toast sinks).

```
DEAD IMPORTS                    0
MISSING IMPORTS                 0   (fullKey = re-export alias of nodeKey — verified)
STALE REFS / ORPHAN HTML IDs    0
OLD-STACK REFERENCES            0   (code, CSS and docs all migrated)
UNESCAPED TOAST SINKS           0   (kit toast renders HTML → lib/html.js esc()
                                     at every user-derived call site)
THREE.js VERSION PINS           1   (was 2: importmap + OrbitControls URL)
DEAD FILES                      0   (mocap.css, mocap_analysis_guide.md removed)
RAW-DOM OUTLIERS                0   (BatchController migrated to $.opt + chainable)
MODULE LOAD TEST                45/45 against the real qry@1.0.0 core + kit (jsdom)

✅ Convergence holds across 17 audit dimensions on the new stack.
```

What landed in this pass, beyond the port itself:

- **Lifecycle completion** — `makeKeyboard` / `makeSidebar` /
  `makeAutoHideHeader` controllers are now stored and `destroy()`ed
  (the old qry-app versions had no detach path; the kit ones do).
- **`lib/html.js::esc()`** — single escape helper for HTML-rendering
  sinks; used by KinesaApp + BatchController toasts.
- **BatchController DRY/consistency** — 12 raw
  `document.getElementById` + guard idioms migrated to `$.opt()?.`
  with chainable `css`/`text`/`attr`/`on`.
- **Docs de-staled** — README rewritten as a product README (the old
  one was the v4.1 iteration note), kinesa.css header corrected,
  CHANGES architecture/stack sections updated.
- **Known deliberate exceptions** — cinema-mode colors in kinesa.css
  stay hard-coded (theme-independent by design, theme pinned light
  via `boot({ theme: false })`); localStorage prefix stays `mocap_`
  so existing session memories survive; the Motive CSV line tokenizer
  in `data/csv-parser.js` (then in lib/) stays (core `$.parseCSV` is whole-document,
  Motive needs per-row parsing of multi-row headers); inline `display`
  toggles in BatchController stay explicit (panes are styled inline).

Repo-side follow-ups (outside the source tree): add `Kinesa.iml`
to `.gitignore`.

---

# Kinesa v1.0 — final audit (KISS/DRY full convergence)

After 16 audit passes, the codebase reaches **full convergence
across 16 audit dimensions**. This pass added the last DRY win:
a single `nodeKey(takeId, objectName, nodeName)` helper consolidating
the 3 separate implementations of the same composite-key construction
that had drifted across the codebase.

## Final convergence check

```
DEAD IMPORTS                    0
MISSING IMPORTS                 0
STALE REFS                      0
WRITE-ONLY FIELDS               0
UNUSED FIELDS                   0
BARE-STRING MAGIC               0
LISTENER LEAKS                  0
THREE.js DISPOSAL HYGIENE       clean
ENCAPSULATION BREACHES          0
NEW CIRCULAR IMPORTS            0
ICON-ONLY BUTTONS WITHOUT LABELS 0
CLAMP IDIOMS                    0  (all 14 migrated to clamp helper)
TRIPLE LOOPS                    0  (all 5 migrated to forEachNode)
INLINE 3-PART KEYS              0  (all migrated to nodeKey helper)
ORPHAN HTML IDs                 0
BRACE BALANCE                   OK across all 37 modules
MODULE LOAD TEST                37/37 modules load cleanly

✅ Convergence achieved across 16 audit dimensions.
```

## DRY pass — what landed

### Round 1 (v1.0 first KISS/DRY pass)

- **`clamp(x, lo, hi)`** in `qry-app.js` — 14 sites migrated
- **`forEachNode(frames, callback)`** in `data/frame-utils.js` — 4 sites migrated

### Round 2 (this pass)

- **`nodeKey(takeId, objectName, nodeName)`** in `lib/object-types.js`
  — single source of truth for the canonical `${takeId}:${object
  Name}:${nodeName}` composite key. Three different implementations
  converged:
  - `Selection.key()` now delegates to `nodeKey`
  - `Nodes.keyOf()` (static) now delegates to `nodeKey`
  - `Metrics.fullKey` now re-exports `nodeKey`
  - 5 inline `${}:${}:${}` constructions across `ChartWidget` and
    `Picker` migrated.

  Critical safety win: if the separator ever needs to change (e.g. a
  take name with `:` in it), all consumers update at once.

- **`Smoother._getUniqueNodes`** migrated to use `forEachNode` (the
  one remaining triple-loop the previous pass had missed).

Verified runtime:
```
nodeKey  = "t1:Hip:Center"
sel.key  = "t1:Hip:Center"
fullKey  = "t1:Hip:Center"
✅ ALL THREE MATCH
```

## Helpers public API (final)

```
qry-kit (CDN, bare specifier via importmap)
  sleep · clamp · throttle · makeStore · toast · stamp · icons
  makeSidebar(sel, opts)                   { open, close, toggle, destroy }
  makeAutoHideHeader(opts)                 { destroy }
  makeKeyboard()                           { on(key, fn, opts) → off, destroy }
  bindAll(map)                             detach fn

lib/html.js
  esc(s)                                   string — HTML-escape for toast & co.

lib/object-types.js
  OBJECT_TYPES                             { SKELETON, RIGIDBODY, CHAIN, MARKER }
  OBJECT_NAMES                             { UNLABELED }
  NODE_NAMES                               { CENTER }
  JOINT_NAMES                              { HIP, HEAD, CHEST }  (regexes)
  isHeadOrHip(nodeName)                    boolean
  nodeKey(takeId, objectName, nodeName)    string  — the ONE composite key

data/frame-utils.js
  forEachNode(frames, callback)            void
                                           // callback(nodeData, ctx)
                                           // ctx = { frame, objectName, nodeName }
```

## Architecture summary (final)

```
45 modules total (the headline previously said 37 — miscount; the
per-directory figures below were always correct)

app/         14 single-concern controllers
ui/          12 widgets / view layers
scene/        5 THREE.js domain modules
data/         9 pure data-processing modules (incl. frame-utils)
lib/          5 utility modules (incl. html.js)
qry-kit       framework glue, now loaded from CDN
```

## Audit cycle history

| Pass | Focus                                          | Outcome                                              |
| ---  | ---                                            | ---                                                  |
| 1    | Project recovery                               | Codebase loads                                       |
| 2    | KinesaApp rebrand                              | Brand-consistent                                     |
| 3-5  | Architecture decomposition                     | KinesaApp 1097 → 603, 7 → 14 modules `app/`          |
| 6-7  | Performance (animate-loop allocations)         | ~10800 → 0 mesh-related allocs/sec                   |
| 8    | Defensive (listener leaks, innerHTML)          | All listeners have detach paths                      |
| 9    | Bare-string migration → object-types module    | 50+ bare strings centralised                         |
| 10   | Audit (caught 4 missing imports from #9!)      | Runtime crashes fixed                                |
| 11   | Convergence (dead imports/fields)              | All identifiers resolve                              |
| 12   | v1.0 first cut                                 | Zero static issues                                   |
| 13   | Defensive verification                         | Cross-module access cleaned, error chains preserved  |
| 14   | Runtime simulation                             | Multi-take math empirically verified                 |
| 15   | KISS/DRY consolidation (clamp + forEachNode)   | 18 sites migrated                                    |
| 16   | Full DRY convergence (nodeKey)                 | All 3-part keys + last triple loop consolidated      |
| 17   | qry stack v1.0.0 port + re-audit               | CDN stack, esc() sinks, lifecycle, dead files, 45/45 |
| 18   | Deep KISS/DRY + stack idiom convergence        | download()/trigger()/on()/off(), 4 latent bugs, 45/45 |
| 19   | Structure & terminology convergence            | chart/graph rule, field=role, kebab ids, lib/data    |
| 20   | Production readiness + speced features         | XSS sinks 0, boot-safe storage, peaks + signature    |
| 21   | Feature build: ghost · PNG · cascade           | 3 features in existing seams, 28/28 tests, 46/46     |
| 22   | Adversarial review of pass 21                  | ghost churn + 3 injection sites fixed, 40/40 tests   |
| 23   | v1.0.0 release prep (qry-js@1.1.0 + tests/ + relics) | stack 1.0.0→1.1.0, dead files gone, tests → tests/, 40/40 |

## Lessons recorded (workflow improvements baked into the codebase)

1. **Migration → Audit chain.** Any regex-driven substitution pass
   must be immediately followed by a static-analysis audit step.
   Don't ship until the audit reports zero.
2. **Identifier-resolution audit** is part of the canonical
   toolchain. ESM doesn't pre-validate identifier references at
   import time.
3. **Single-concern modules are non-negotiable.** Every `app/*.js`
   has a one-line summary at the top.
4. **Hot paths must be allocation-free.** Reconcile patterns over
   wipe-and-rebuild; mesh + geometry reuse over per-frame creation;
   in-place mutation over object spread; cached snapshots over
   per-call iteration.
5. **Single source of truth** for every piece of state.
6. **DRY via helpers, not abstraction.** When the same idiom
   appears 3+ times across files, extract as a small named helper
   (e.g. `clamp`, `forEachNode`, `nodeKey`). When it appears 1-2
   times, leave it inline — readability wins.
7. **Helpers re-exported from old locations** preserve API
   stability (`Selection.key`, `Nodes.keyOf`, `Metrics.fullKey` all
   still work — they just delegate to `nodeKey` now).

## Hot-path performance (unchanged from v1.0 cut)

For 2 takes with full skeleton, 60 unlabeled markers, 3 plotted-
series trail dots, at 60Hz:

```
Bone Mesh + Geometry allocations    0
Unlabeled mesh churn                0
Per-take visibility writes          0
Trail allocations                   0
liveShiftFor shifted points/sec     0
Object.entries per playback tick    0
data.find per playback tick         0
Closure rebuild per drag tick       0
```

The `requestAnimationFrame` loop and the playback marker refresh do
not allocate during steady-state playback.

## Total cleanup since v1.3 (the start of the audit chain)

| Metric                         | start  | v1.0   |
| ---                            | ---    | ---    |
| KinesaApp.js lines             | 1097   | 603    |
| Modules in `app/`              | 7      | 14     |
| Mesh allocs/sec @ 60Hz         | ~10800 | 0      |
| Per-tick `Object.entries`      | 2      | 0      |
| Closure rebuild per drag       | 3+     | 0      |
| Dead code                      | many   | 0      |
| Bare string magic              | 50+    | 0      |
| Missing imports (runtime bugs) | unknown| 0      |
| Multi-take ROI/CSV math        | broken | correct|
| Listener leaks                 | yes    | 0      |
| Reach-into-internals           | yes    | 0      |
| Repeated clamp idioms          | 14     | 0      |
| Triple-nested frame loops      | 5      | 0      |
| Duplicate key implementations  | 3      | 1      |

✅ **Ready to ship as v1.0.**
