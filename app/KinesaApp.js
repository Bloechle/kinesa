/**
 * KinesaApp.js — main application coordinator.
 *
 * Wires every module together (Selection, Takes, Playback, Picker,
 * SceneManager / SceneRenderer, ChartWidget, TakeStrip, TimelineSlider,
 * BatchController, InfoWidget, DataWidget). Owns the master animate
 * loop, the keyboard map, drag-and-drop ingestion, and the bridge
 * events between the timeline slider and the takes registry.
 *
 * Design principle: this class IS the event hub. Subsystems emit
 * 'change' / 'frame' / 'scrub' / 'poi-drag' / 'secondary-poi-drag' /
 * etc., and KinesaApp routes them. Subsystems never reach across to
 * each other; they only know about their dependencies passed in via
 * the constructor.
 *
 * `$` is global from qry.js. Glue utilities from qry-kit (importmap).
 */

import { sleep, throttle, makeStore, toast, confirm, makeSidebar, makeKeyboard, bindAll, makeAutoHideHeader, icons }
    from 'qry-kit';

import { esc } from '../lib/html.js';

import { Selection }     from './Selection.js';
import { Playback }      from './Playback.js';
import { Picker }        from './Picker.js';
import { Takes }         from './Takes.js';
import { BatchController } from './BatchController.js';
import { SessionStore }  from './SessionStore.js';
import { loadTake }      from './TakeLoader.js';
import { SceneConfigDialog } from './SceneConfigDialog.js';
import { PlayerHUD }     from './PlayerHUD.js';
import { SceneOrchestrator } from './SceneOrchestrator.js';
import { TimelineBridge } from './TimelineBridge.js';
import { Analysis }      from './Analysis.js';
import { SceneCommands } from './SceneCommands.js';
import { SceneManager }  from '../scene/SceneManager.js';
import { SceneRenderer } from '../scene/SceneRenderer.js';
import { DataWidget }    from '../ui/DataWidget.js';
import { ChartWidget }   from '../ui/ChartWidget.js';
import { InfoWidget }    from '../ui/InfoWidget.js';
import { TakeStrip }     from '../ui/TakeStrip.js';
import { TimelineSlider } from '../ui/TimelineSlider.js';
import { NODE_DEFAULTS } from '../scene/Nodes.js';

import { OBJECT_NAMES } from '../lib/object-types.js';
// ── Default scene config ──────────────────────────────────────────────────

const SCENE_DEFAULTS = {
    jointSize:   NODE_DEFAULTS.jointSize,
    jointColor:  NODE_DEFAULTS.jointColor,
    markerSize:  NODE_DEFAULTS.markerSize,
    markerColor: NODE_DEFAULTS.markerColor,
    boneWidth:   0.016,
};

const store = makeStore('kinesa_');
// One-time migration from the pre-v1.1 'mocap_' prefix (non-fatal:
// private mode / disabled storage must never block boot).
try {
    if (localStorage.getItem('mocap_sceneConfig') !== null && localStorage.getItem('kinesa_sceneConfig') === null) {
        localStorage.setItem('kinesa_sceneConfig', localStorage.getItem('mocap_sceneConfig'));
        localStorage.removeItem('mocap_sceneConfig');
    }
} catch { /* storage unavailable — defaults apply */ }

// ── App ───────────────────────────────────────────────────────────────────

export class KinesaApp {
    #nav;
    #keyboard;
    #autoHide;
    #selection;
    #takes;
    #playback;
    #sceneManager;
    #sceneRenderer;
    #picker;
    #dataWidget;
    #chartWidget;
    #infoWidget;
    #takeStrip;
    #timelineSlider;
    #batch;
    #configDialog;
    #hud;
    #orchestrator;
    #timelineBridge;
    #analysis;
    #commands;
    #sceneConfig;
    #dragCounter = 0;
    #listeners   = {};

    constructor() { this.#init(); }

    // ═══ INIT ════════════════════════════════════════════════════════════

    async #init() {
        await customElements.whenDefined('sl-button');

        this.#nav      = makeSidebar('#sidebar', { collapseBtn: '#btn-collapse' });
        this.#keyboard = makeKeyboard();
        this.#sceneConfig = { ...SCENE_DEFAULTS, ...(store.get('sceneConfig') || {}) };

        // ── Core state ──────────────────────────────────────────────
        this.#selection = new Selection();
        this.#takes     = new Takes();
        this.#playback  = new Playback(this.#selection);

        // ── 3D scene ────────────────────────────────────────────────
        this.#sceneManager  = new SceneManager();
        this.#sceneManager.init();
        this.#sceneRenderer = new SceneRenderer(this.#sceneManager, this.#selection, this.#sceneConfig);
        this.#picker        = new Picker(this.#sceneManager, this.#sceneRenderer, this.#selection, this.#takes);
        this.#orchestrator         = new SceneOrchestrator({
            sceneManager:  this.#sceneManager,
            sceneRenderer: this.#sceneRenderer,
            playback:      this.#playback,
            takes:         this.#takes,
            // Cascade: when the orchestrator drops a take from the scene,
            // also drop its selection entries and chart caches.
            onTakeRemoved: (id) => {
                this.#selection.removeByTake(id);
                this.#chartWidget?.onTakeRemoved?.(id);
            },
        });

        // Listen FIRST so #syncTakes runs before UI components see the
        // 'change' event (selection cleanup precedes chip re-render).
        // Store refs in `#listeners` so destroy() can detach them.
        this.#listeners.takesChange = () => { this.#syncTakes(); this.#persistSessionTakes(); };
        this.#takes.on('change', this.#listeners.takesChange);

        // ── Widgets ─────────────────────────────────────────────────
        this.#dataWidget  = new DataWidget({ onResult: r => this.#handleDataResult(r) });
        this.#batch       = new BatchController(this.#dataWidget);
        this.#infoWidget  = new InfoWidget({ containerId: 'info-widget' });
        this.#chartWidget = new ChartWidget(this.#playback, 'chart-widget', this.#selection, this.#takes);
        this.#mountTakeStrip();
        this.#timelineSlider = new TimelineSlider('timeline-slider', { height: 36 });
        this.#hud         = new PlayerHUD(this.#playback, this.#takes);
        this.#timelineBridge    = new TimelineBridge({
            slider:      this.#timelineSlider,
            takes:       this.#takes,
            playback:    this.#playback,
            charts:      this.#chartWidget,
            // After the user releases the master flag, persist the new
            // POI into metadata and broadcast 'change' so chip readouts
            // catch up. We can't do that inside the bridge because it
            // would create a feedback loop with #syncTakes.
            onPoiCommit: (newPoi) => {
                const master = this.#takes.master();
                if (!master?.metadata) return;
                if (Number.isFinite(newPoi)) master.metadata.pointOfInterest = newPoi;
                else                          delete master.metadata.pointOfInterest;
                this.#takes.touch();
            },
        });
        this.#analysis    = new Analysis({
            takes:      this.#takes,
            playback:   this.#playback,
            charts:     this.#chartWidget,
            slider:     this.#timelineSlider,
            selection:  this.#selection,
            onFeedback: toast,
        });
        this.#commands    = new SceneCommands({
            sceneManager:     this.#sceneManager,
            orchestrator:     this.#orchestrator,
            sceneRenderer:    this.#sceneRenderer,
            playback:         this.#playback,
            takes:            this.#takes,
            selection:        this.#selection,
            onTopologyChange: () => this.#refreshAfterTopologyChange(),
            onFeedback:       toast,
        });

        // ── Event wiring ────────────────────────────────────────────
        this.#bindGraphEvents();
        this.#bindUI();
        this.#bindKeyboard();
        this.#bindDnD();
        this.#configDialog = new SceneConfigDialog({
            defaults:       SCENE_DEFAULTS,
            initial:        this.#sceneConfig,
            getGridVisible: () => this.#sceneManager.isGridVisible(),
            setGridVisible: (v) => this.#sceneManager.setGridVisible(v),
            onChange:       () => this.#applySceneConfig(),
            onReset:        () => toast('Scene settings reset', 'info'),
        });
        this.#initSectionNav();
        this.#autoHide = makeAutoHideHeader();

        this.#orchestrator.start();

        await this.#loadDemo();
        toast('Kinesa ready!', 'success');
    }

    /** Mount the TakeStrip (slaves chips) above the timeline slider in
     *  the player card's controls row. Wraps in a host div so chip
     *  re-renders don't fight ChartWidget's empty() pattern. */
    #mountTakeStrip() {
        const ctrlHost   = document.querySelector('.kinesa-controls');
        const sliderHost = document.getElementById('timeline-slider');
        if (!ctrlHost || !sliderHost) return;
        const wrap = document.createElement('div');
        ctrlHost.insertBefore(wrap, sliderHost);
        this.#takeStrip = new TakeStrip(wrap, this.#takes);
    }

    /** Bridge events from the timeline slider to playback / takes /
     *  charts. Master POI flag drag, slave knob drag, range handles,
    /** Bridge events from the chart widget back into KinesaApp state. */
    #bindGraphEvents() {
        this.#chartWidget.on('peak-anchor', e => {
            const { frame, label, value, nodeName } = e.detail;
            this.#analysis.setMasterPoi(frame);
            const who = nodeName ? `${nodeName} · ` : '';
            toast(`${esc(label)}: ${esc(who)}${esc(value)} @ frame ${frame}`, 'success');
        });
    }

    // ═══ TAKE LIFECYCLE ══════════════════════════════════════════════════

    /** Wired to Takes 'change'. Reconciles every subsystem with the
     *  registry state. Idempotent. */
    #syncTakes() {
        // First-time bind only — master is permanent so we never re-bind
        // playback after the initial load.
        const master = this.#takes.master();
        if (!this.#playback.activeTakeId && master) {
            this.#playback.setActiveTake(master);
            this.#timelineBridge.applyMasterUI(master);
        }
        // Scene + selection + chart cascade (orchestrator fires the
        // onTakeRemoved callback wired in #init for the cascade).
        this.#orchestrator.reconcile();
        this.#timelineBridge.secondaryPoiCommit();
    }

    /** Persist current alignment state per take name to localStorage so
     *  re-drops of recognized files restore offsets / locks / POI / ROI.
     *  Throttled implicitly by the "change" event firing rate (which is
     *  drag-end / load / explicit commit, not per-frame). */
    #persistSessionTakes() {
        const masterId = this.#takes.masterId();
        for (const t of this.#takes.all()) {
            const entry = {
                offset:        t.offset | 0,
                spatialOffset: t.spatialOffset || { x: 0, y: 0, z: 0 },
                locked:        !!t.locked,
                poi:           t.metadata?.pointOfInterest ?? null,
            };
            // Only the master defines an analysis ROI — other takes
            // ride on the master's window.
            if (t.id === masterId && t.metadata?.regionOfInterest) {
                entry.roi = t.metadata.regionOfInterest;
            }
            SessionStore.set(t.name, entry);
        }
    }

    // ═══ UI BINDINGS ═════════════════════════════════════════════════════

    #bindUI() {
        bindAll({
            '#btn-play':         () => this.#playback.togglePlayPause(),
            '#btn-step-back':    () => this.#stepFrame(-1),
            '#btn-step-fwd':     () => this.#stepFrame(1),
            '#btn-info':         () => $('#info-dialog').show(),
            '#btn-close-info':   () => $('#info-dialog').hide(),
            '#btn-snap-peak':    () => this.#analysis.snapToPeak(),
            '#btn-export':       () => this.#chartWidget?.exportData(),
            '#btn-fullscreen':   () => this.#commands.toggleFullscreen(),
            '#btn-fs-close':     () => this.#commands.exitFullscreen(),
            '#btn-free-markers': () => this.#commands.toggleFreeMarkers(),
            '#btn-ghost':        () => this.#commands.toggleGhost(),
            '#btn-history':      () => this.#commands.toggleHistory(),
            '#btn-screenshot':   () => this.#sceneManager.screenshot(),
            '#btn-center':       () => this.#commands.centerOnSelection(),
            '#btn-upload':       () => $('#file-input').trigger('click'),
            '#btn-download':     () => this.#downloadData(),
            '#btn-scene-config': () => this.#configDialog?.open(),
            '#btn-detect-leg':   () => this.#commands.toggleLegDetection(),
            '#btn-help':         () => $('#help-dialog').show(),
            '#btn-close-help':   () => $('#help-dialog').hide(),
            '#btn-batch-convert':() => this.#batch.open('convert-json'),
            '#btn-batch-trim':   () => this.#batch.open('trim-json'),
            '#btn-batch-close':  () => $('#batch-dialog').hide(),
            '#btn-cascade':      () => this.#analysis.cascade(),
            '#btn-clear-session':() => this.#clearSessionMemory(),
        });

        $('#file-input').on('change', e => {
            if (e.target.files.length) {
                // Sidebar file picker = replace existing takes (consistent
                // with default DnD behaviour). No modifier-key path here:
                // the picker UI doesn't carry the keyboard state of the
                // gesture that triggered it.
                this.#ingestFiles(Array.from(e.target.files));
            }
            e.target.value = '';
        });

        $('#speed-group').on('click', e => {
            const btn = e.target.closest('.qry-btn-group-item');
            if (!btn) return;
            this.#playback.setPlaySpeed(Number(btn.dataset.speed) / 100);
            $.all('#speed-group .qry-btn-group-item').forEach(b => b.cls('-active'));
            btn.cls('+active');
        });

        $.all('.kinesa-scene-btn[data-view]').forEach(btn => {
            btn.on('click', () => {
                this.#sceneManager.setView(btn.getAttribute('data-view'));
                $.all('.kinesa-scene-btn[data-view]').forEach(b => b.cls('-active'));
                btn.cls('+active');
            });
        });

        // Sidebar toggle icon follows state (close when expanded, open when collapsed)
        const syncNavIcon = () => {
            const i = document.querySelector('#btn-collapse i');
            if (!i) return;
            const isMobile = window.innerWidth <= 768;
            const expanded = isMobile
                ? $('#sidebar').cls('?open')
                : !$('#sidebar').cls('?collapsed');
            i.setAttribute('data-lucide', expanded ? 'panel-left-close' : 'panel-left-open');
            icons();
        };
        $('#btn-collapse').on('click', syncNavIcon);
        $('#qry-overlay')?.on('click', syncNavIcon); // mobile: overlay tap closes sidebar
        this.#listeners.windowResize = syncNavIcon;
        window.on('resize', syncNavIcon);
    }

    #bindKeyboard() {
        this.#keyboard.on(' ',          () => this.#playback.togglePlayPause(),  { prevent: true  });
        this.#keyboard.on('ArrowLeft',  (e) => this.#arrowNudge(-1, e?.shiftKey), { prevent: true  });
        this.#keyboard.on('ArrowRight', (e) => this.#arrowNudge(+1, e?.shiftKey), { prevent: true  });
        this.#keyboard.on('f',          () => this.#commands.toggleFullscreen());
        this.#keyboard.on('g',          () => this.#commands.toggleGhost());
        this.#keyboard.on('p',          () => this.#analysis.togglePoi());
        this.#keyboard.on('s',          () => this.#analysis.snapToPeak());
        this.#keyboard.on('c',          () => this.#analysis.cascade());
        this.#keyboard.on('l',          () => this.#toggleHoveredLock());
        this.#keyboard.on('Delete',     () => this.#removeHoveredSlave(),         { prevent: true });
        this.#keyboard.on('Backspace',  () => this.#removeHoveredSlave(),         { prevent: true });
        this.#keyboard.on('?',          () => $('#help-dialog').show());
        this.#keyboard.on('e',          () => this.#chartWidget?.exportData(),   { ctrl: true     });
        this.#keyboard.on('b',          () => $('#btn-collapse')?.click(),        { ctrl: true     });
        this.#keyboard.on('Escape',     () => {
            $('#info-dialog').hide();
            this.#commands.exitFullscreen();
        },                                                                     { prevent: false });
    }

    /** Toggle the alignment lock on whichever slave chip is hovered.
     *  No-op when nothing's hovered or master is hovered (master can't
     *  be locked — it's the reference). */
    #toggleHoveredLock() {
        const id = this.#takeStrip?.getHoveredId?.();
        const t  = id && this.#takes.byId(id);
        if (!t || this.#takes.isMaster(id)) return;
        this.#takes.setLocked(id, !t.locked);
    }

    /** Remove the hovered slave (Delete/Backspace). Master is never
     *  removable, so the action quietly no-ops over master. */
    #removeHoveredSlave() {
        const id = this.#takeStrip?.getHoveredId?.();
        if (!id || this.#takes.isMaster(id)) return;
        this.#takes.remove(id);
    }

    // ═══ SCENE CONFIG ════════════════════════════════════════════════════

    #applySceneConfig() {
        this.#sceneRenderer.setConfig(this.#sceneConfig);
        this.#orchestrator.rebuildAll();
        store.set('sceneConfig', this.#sceneConfig);
    }

    // ═══ DRAG & DROP ═════════════════════════════════════════════════════

    #bindDnD() {
        const area = document.querySelector('.qry-content');
        if (!area) return;

        area.on('dragenter', e => {
            e.preventDefault();
            if (++this.#dragCounter === 1) $('#dnd-overlay').cls('+visible');
        });
        area.on('dragleave', e => {
            e.preventDefault();
            if (--this.#dragCounter <= 0) { this.#dragCounter = 0; $('#dnd-overlay').cls('-visible'); }
        });
        area.on('dragover', e => e.preventDefault());
        area.on('drop', e => {
            e.preventDefault();
            this.#dragCounter = 0;
            $('#dnd-overlay').cls('-visible');
            const files = Array.from(e.dataTransfer.files)
                .filter(f => /\.(json|csv|zip)$/i.test(f.name));
            if (!files.length) return;
            // Default = replace existing takes (clean session reload).
            // Hold Ctrl/Cmd while dropping to APPEND to current takes.
            const append = e.ctrlKey || e.metaKey;
            this.#ingestFiles(files, { append });
        });
    }

    /** Central ingestion path: optionally clears existing takes before
     *  feeding files to DataWidget. Default behaviour is REPLACE — drop a
     *  new set of takes and they take over the session. Pass `append:
     *  true` to add to whatever's already loaded (Ctrl/Cmd-drop). */
    #ingestFiles(files, { append = false } = {}) {
        if (!append && this.#takes?.size) {
            // Tear everything down. Order matters: clearing Takes
            // dispatches 'change' which Selection / SceneRenderer /
            // ChartWidget all observe via #syncTakes.
            this.#takes.clear();
        }
        this.#dataWidget.processFiles(files).catch(err => toast(esc(err.message), 'error'));
    }

    // ═══ DATA HANDLING ═══════════════════════════════════════════════════

    /** Single-file load: delegates the heavy lifting (Pipeline, name,
     *  default POI, session restore, registry add) to `loadTake`, then
     *  wires the post-load side effects (info dialog, data widget, chart
     *  widget, autoSelectHip, toast). */
    #handleDataResult(result) {
        if (!result) return;

        const { take, isFirst, probe, original } = loadTake(this.#takes, result);

        if (isFirst) {
            this.#infoWidget.display(result, { probe });
            if (original) this.#dataWidget.setData(result, true, original);
            $('#btn-detect-leg').cls('-active');
        }

        this.#chartWidget.onTakeAdded?.(take, isFirst);
        if (isFirst) this.#autoSelectHip();

        // Toast: filename + probe headline (when available).
        if (probe?.dominant) {
            const d = probe.dominant;
            const where = `${d.object !== OBJECT_NAMES.UNLABELED ? d.object + '.' : ''}${d.node}`;
            const sig = probe.signature ? ` · ${probe.signature.kind}` : '';
            toast(`Loaded: ${esc(take.name)} · dominant ${esc(where)} (${d.peak.toFixed(2)} m/s @ ${d.time.toFixed(2)}s)${sig}`,
                'success', 5000);
        } else {
            toast(`Loaded: ${esc(take.name)}`, 'success');
        }
    }

    /** Arrow-key router: shift the hovered slave's offset when a take
     *  chip is under the cursor; otherwise fall through to step the
     *  master playhead frame-by-frame. Shift modifier scales by ×10.
     *
     *  Locked slaves are nudged regardless — the lock guards against
     *  snap-to-peak realignment, not direct user input. */
    #arrowNudge(dir, shift = false) {
        const step      = (shift ? 10 : 1) * Math.sign(dir);
        const hoveredId = this.#takeStrip?.getHoveredId?.();
        const hovered   = hoveredId ? this.#takes.byId(hoveredId) : null;

        if (hovered && !this.#takes.isMaster(hovered.id)) {
            this.#takes.setOffset(hovered.id, (hovered.offset | 0) + step);
            return;
        }
        this.#stepFrame(step);
    }

    /** Wipe the SessionStore (forget remembered alignments / locks /
     *  POI / ROI per take name). Toasts the count we just cleared. */
    async #clearSessionMemory() {
        const n = SessionStore.size();
        if (!n) { toast('Session memory was empty', 'info'); return; }
        if (!(await confirm(`Forget ${n} remembered take${n > 1 ? 's' : ''} (alignments, locks, POI, ROI)?`,
                            { label: 'Clear memory' }))) return;
        SessionStore.clear();
        toast(`Forgot ${n} remembered take${n > 1 ? 's' : ''}`, 'info');
    }

    #downloadData() {
        // Persist both analysis markers into metadata at download time —
        // they round-trip (load re-applies them, merge/trim use them).
        const range = this.#chartWidget?.getRegionOfInterest?.();
        const poi   = this.#takes.master()?.metadata?.pointOfInterest;
        const extra = {};
        if (range)                  extra.regionOfInterest = range;
        if (Number.isFinite(poi))   extra.pointOfInterest  = poi;
        const payload = Object.keys(extra).length ? extra : null;
        if (!this.#dataWidget.download(payload)) toast('No data to download', 'warn');
    }

    /** Rebuild scene + chart after adding/removing an object (e.g. Leg).
     *  Topology changes affect only the master take in v1 (Detect Leg
     *  acts on the active recording's data, not on slaves). The
     *  master's metadata is mutated in-place by Pipeline; we just
     *  rebuild downstream views. */
    #refreshAfterTopologyChange() {
        const master = this.#takes.master();
        if (!master) return;
        this.#sceneRenderer.setMetadataFor(master.id, master.metadata);
        const frame = master.frameData[this.#playback.currentFrame];
        if (frame) this.#sceneRenderer.rebuild(master.id, frame);
        this.#chartWidget.refreshNodes();
    }

    // ═══ DEMO LOADER ═════════════════════════════════════════════════════

    async #loadDemo() {
        try {
            const res = await fetch('KinesaDemo.zip');
            if (!res.ok) return;

            const zip     = await JSZip.loadAsync(await res.arrayBuffer());
            const entries = [];
            zip.forEach((path, entry) => { if (!entry.dir && /\.json$/i.test(path)) entries.push(entry); });

            const file = entries[0];
            if (!file) return;

            const data = JSON.parse(await file.async('text'));
            data.metadata ??= {};
            data.metadata.originalFilename = file.name;

            this.#handleDataResult(data);
            this.#sceneManager.onWindowResize();
            await sleep(500);
            this.#sceneManager.onWindowResize();
            await sleep(1000);
            if (!this.#playback.isPlaying) this.#playback.togglePlayPause();
        } catch (e) {
            console.warn(`Demo load failed: ${e.message}`);
        }
    }

    // ═══ SCENE CONTROLS ══════════════════════════════════════════════════

    #stepFrame(delta) {
        if (this.#playback.isPlaying) this.#playback.togglePlayPause();
        this.#playback.setFrame(this.#playback.currentFrame + delta);
    }

    /** Select Hip on first take if ChartWidget hasn't populated Selection
     *  via state restore — gives the user something plotted out of the box. */
    #autoSelectHip() {
        if (this.#selection.size > 0) return;
        const master = this.#takes.master();
        if (!master?.frameData?.length) return;
        const frame    = master.frameData[0];
        const hipNames = ['Hip', 'Hips', 'hip', 'hips', 'Root', 'root'];

        for (const objName in frame.objects) {
            for (const hip of hipNames) {
                if (frame.objects[objName][hip]) {
                    const type = master.metadata?.objects?.[objName]?.type || 'undefined';
                    this.#selection.add(master.id, objName, hip, type);
                    return;
                }
            }
        }
    }

    // ═══ SECTION NAV (scroll spy) ════════════════════════════════════════

    #initSectionNav() {
        const ids   = ['section-player', 'section-analysis'];
        const links = $.all('[href^="#section-"]');
        const area  = document.querySelector('.qry-content');
        if (!area || !links.length) return;

        const update = throttle(() => {
            let active = ids[0];
            for (const id of ids) {
                const el = document.getElementById(id);
                if (el && el.getBoundingClientRect().top < 150) active = id;
            }
            links.forEach(l => l.cls(l.getAttribute('href') === `#${active}` ? '+active' : '-active'));
        }, 100);

        area.on('scroll', update);
        links.forEach(l => l.on('click', e => {
            const href = l.getAttribute('href');
            if (href?.startsWith('#')) {
                e.preventDefault();
                document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth' });
                this.#nav.close();
            }
        }));
    }

    // ═══ CLEANUP ═════════════════════════════════════════════════════════

    destroy() {
        this.#orchestrator?.stop?.();
        this.#keyboard?.destroy?.();
        this.#nav?.destroy?.();
        this.#autoHide?.destroy?.();
        // Detach listeners we registered manually (auto-rooted ones in
        // sub-modules clean up via their own destroy()s).
        if (this.#listeners.takesChange) {
            this.#takes?.off('change', this.#listeners.takesChange);
        }
        if (this.#listeners.windowResize) {
            window.off('resize', this.#listeners.windowResize);
        }
        this.#playback?.destroy?.();
        this.#dataWidget?.destroy?.();
        this.#chartWidget?.destroy?.();
        this.#infoWidget?.destroy?.();
        this.#timelineSlider?.destroy?.();
        this.#picker?.destroy?.();
        this.#takeStrip?.destroy?.();
        this.#hud?.destroy?.();
        this.#sceneRenderer?.destroy?.();
        this.#sceneManager?.destroy?.();
        this.#takes?.clear?.();
        this.#sceneManager = null;
        this.#selection    = null;
        this.#takes        = null;
    }
}

