/**
 * ChartWidget.js — Motion analysis graph UI (v1.0)
 *
 * Pure view layer over `GraphsModel`. Owns the DOM tree under
 * `#chart-widget` and the per-graph ChartRenderer instances; everything
 * data-related (graphs/series state, extracted caches, peak finding,
 * shifted-cache for live drags) lives in GraphsModel.
 *
 * Public API kept compatible with KinesaApp's expectations:
 *   - onTakeAdded(take, isFirst)
 *   - onTakeRemoved(takeId)
 *   - refreshNodes()
 *   - exportData()
 *   - getRegionOfInterest()
 *   - setRegionOfInterest(range)
 *   - findPeakOnActiveMetric()
 *   - plotCascade(takeId, objectName, nodeNames)
 *   - findPeakPerTake()
 *   - shiftTakeLive(takeId, offset)
 *   - destroy()
 *
 * Emits:
 *   - 'peak-anchor' from the stats card when a `@frame` link is clicked
 *
 * `$` is global from qry.js.
 */

import { ChartRenderer } from './ChartRenderer.js';
import { SelectedStrip } from './SelectedStrip.js';
import { computeStats }  from '../data/Stats.js';
import {
    METRICS, DEFAULT_METRIC, metricById,
} from './metrics-catalog.js';
import { GraphsModel }            from './GraphsModel.js';
import { buildCsv, exportPng }  from './ChartExport.js';
import { renderStatsCard }        from './ChartStatsCard.js';
import { icon }                   from './icons.js';

import { NODE_NAMES, OBJECT_NAMES, nodeKey } from '../lib/object-types.js';
import { stamp, download, toast } from 'qry-kit';
export class ChartWidget extends EventTarget {
    #root;
    #playback;
    #selection;
    #takes;

    #model;
    #renderers   = {};
    #strip;
    #dom         = {};
    #roi         = null;
    #resizeTimer;
    #handlers    = {};

    constructor(playback, containerId, selection, takes) {
        super();
        this.#root      = document.getElementById(containerId);
        this.#playback  = playback;
        this.#selection = selection;
        this.#takes     = takes;
        this.#model     = new GraphsModel(takes, selection);
        if (!this.#root) return;
        this.#buildUI();
        this.#bindEvents();
    }

    // ═══ PUBLIC API ═════════════════════════════════════════════════════

    onTakeAdded(_take, isFirst) {
        if (isFirst) {
            const prev = this.#snapshotState();
            this.#model.reset();
            for (const id in this.#renderers) this.#renderers[id]?.destroy();
            this.#renderers = {};
            if (!this.#restoreState(prev)) this.#resetSelection();
        } else {
            this.#renderGraphs();
        }
        this.#updateMessages();
    }

    onTakeRemoved(takeId) {
        this.#model.clearCacheForTake(takeId);
        this.#model.purgeOrphanSeries();
        this.#renderGraphs();
        this.#updateMessages();
    }

    /** Topology of the master changed (e.g. Detect Leg). Drop master's
     *  cached series, prune selections that point at gone joints, and
     *  re-extract the survivors. */
    refreshNodes() {
        const master = this.#takes.master();
        if (!master) return;
        this.#model.clearCacheForTake(master.id);

        const validKeys = new Set();
        const meta = master.metadata;
        if (meta?.objects) {
            for (const obj in meta.objects) {
                for (const n of (meta.objects[obj]?.nodes || [])) {
                    validKeys.add(nodeKey(master.id, obj, n));
                }
            }
        }
        for (const n of this.#selection.all()) {
            if (n.takeId !== master.id) continue;
            if (!validKeys.has(n.key)) {
                this.#selection.remove(n.takeId, n.objectName, n.nodeName);
            } else {
                this.#model.extract(n.takeId, n.objectName, n.nodeName);
            }
        }
        this.#model.purgeOrphanSeries();
        this.#updateMessages();
        this.#renderGraphs();
    }

    exportData() {
        const seen  = new Set();
        const items = [];
        for (const g of this.#model.graphs) {
            for (const s of g.series) {
                const id = `${s.nodeKey}|${s.metricId}`;
                if (seen.has(id)) continue;
                seen.add(id);
                const m   = metricById(s.metricId);
                const sel = this.#findSelection(s.nodeKey);
                if (!m || !sel) continue;
                this.#model.extract(sel.takeId, sel.objectName, sel.nodeName);
                items.push({
                    ...sel,
                    cacheKey: s.nodeKey,
                    property: { name: m.name, component: m.component, label: m.label },
                });
            }
        }
        if (!items.length) return;

        const takesById = {};
        const offsets   = {};
        for (const t of (this.#takes?.all?.() || [])) {
            takesById[t.id] = { name: t.name };
        }
        // Each item's cacheKey is the 3-part `takeId:object:node` key;
        // the offset to apply when translating local frames to master
        // is the take's current offset.
        for (const n of items) {
            const t = this.#takes?.byId?.(n.takeId);
            if (t) offsets[n.cacheKey] = t.offset | 0;
        }

        const csv = buildCsv({
            items,
            graphData: this.#model.cache,
            roi:       this.#roi,
            offsets,
            takesById,
            multiTake: (this.#takes?.size || 0) > 1,
        });
        if (!csv) return;
        const ts = stamp();
        download(csv, `kinesa_${items.length}series_${ts}.csv`, 'text/csv;charset=utf-8;');
    }

    getRegionOfInterest() { return this.#roi ? { ...this.#roi } : null; }

    setRegionOfInterest(range) {
        this.#roi = range ? { ...range } : null;
        this.#renderGraphs();
    }

    findPeakOnActiveMetric() { return this.#model.findPeakAcrossSeries(); }

    /** Cascade view: one fresh graph plotting `speed-mag` for every node
     *  of a proximal→distal chain (selection swap happens upstream, in
     *  Analysis, before this call). Drops graphs the swap emptied.
     *  Returns the per-node alignment peaks [{ node, time, value }]. */
    plotCascade(takeId, objectName, nodeNames) {
        for (const g of [...this.#model.graphs]) {
            if (!g.series.length) this.#model.removeGraph(g.id);
        }
        const graph = this.#model.addGraph();
        const peaks = [];
        for (const n of nodeNames) {
            this.#model.toggleSeries(graph.id, nodeKey(takeId, objectName, n), 'speed-mag');
            const got = this.#model.peakOf(takeId, objectName, n, 'speed-mag');
            if (got) peaks.push({ node: n, time: got.time, value: got.value });
        }
        return peaks;
    }

    findPeakPerTake() {
        return this.#model.findPeakPerTake(this.#strip?.getFocusedKey?.());
    }

    /** Live-shift every plotted series of a take to a new offset, without
     *  rebuilding axes. Called during slave-knob drag for instant
     *  feedback. */
    shiftTakeLive(takeId, offset) {
        for (const { graphId, compositeKey } of this.#model.liveShiftFor(takeId, offset)) {
            this.#renderers[graphId]?.shiftSeries(compositeKey, offset);
        }
    }

    destroy() {
        clearTimeout(this.#resizeTimer);
        this.#playback?.off('frame',    this.#handlers.frame);
        this.#selection?.off('change',  this.#handlers.selection);
        this.#takes?.off('change',    this.#handlers.takes);
        window.off('resize', this.#handlers.resize);
        this.#strip?.destroy?.();
        for (const id in this.#renderers) this.#renderers[id]?.destroy();
        this.#renderers = {};
        this.#dom.statsCards?.empty();
        this.#dom.graphsWrap?.empty();
        this.#dom.msgWrap?.empty();
    }

    // ═══ UI CONSTRUCTION ════════════════════════════════════════════════

    #buildUI() {
        this.#root.empty();
        this.#buildNodeSection();

        const wrap = this.#mk(this.#root, 'div').css({
            display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%',
        });
        this.#dom.statsCards = this.#mk(wrap, 'div').css({
            display: 'flex', flexWrap: 'wrap', gap: '0.75rem',
        });
        this.#buildGraphsSection(wrap);

        this.#dom.msgWrap   = this.#mk(wrap, 'div');
        this.#dom.msgLoading = this.#mk(this.#dom.msgWrap, 'div')
            .text('Loading motion data…').cls('+kinesa-graph-msg');
        this.#updateMessages();
    }

    #mk(parent, tag, props = {}) { return $.create(tag, props).mount(parent); }

    /** Borderless icon button pinned to a graph card's top-right strip. */
    #cardBtn(card, iconSvg, title, right, onClick) {
        return this.#mk(card, 'button')
            .html(iconSvg)
            .attr('title', title)
            .css({
                position: 'absolute', top: '0.5rem', right,
                width: '24px', height: '24px',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'var(--sl-color-neutral-500)', borderRadius: '50%', padding: '0',
            })
            .on('click', onClick);
    }

    #buildNodeSection() {
        this.#dom.nodes = this.#mk(this.#root, 'div').css({ marginBottom: '1rem' });

        const hdr = this.#mk(this.#dom.nodes, 'div').css({
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: '0.5rem',
        });
        this.#mk(hdr, 'h4').text('Selected nodes')
            .css({ fontWeight: '500', color: 'var(--sl-color-neutral-700)' });

        const reset = this.#mk(hdr, 'button')
            .html(`${icon.rotate()} Reset`)
            .css({
                padding: '0.25rem 0.5rem',
                background: 'var(--sl-color-primary-100)',
                color: 'var(--sl-color-primary-700)',
                borderRadius: '0.375rem',
                display: 'flex', alignItems: 'center', gap: '0.25rem',
                fontSize: '0.875rem', border: 'none', cursor: 'pointer',
            })
            .on('click', () => this.#resetSelection());

        this.#strip = new SelectedStrip(this.#dom.nodes, this.#selection, this.#takes);
        this.#strip.on('focus-change', () => this.#renderStats());
    }

    #buildGraphsSection(parent) {
        const section = this.#mk(parent, 'div').css({
            display: 'flex', flexDirection: 'column', gap: '1rem',
        });
        this.#dom.graphsWrap = this.#mk(section, 'div').css({
            display: 'flex', flexDirection: 'column', gap: '1.25rem',
        });
        this.#dom.addGraphBtn = this.#mk(section, 'button')
            .html(`${icon.plus()} Add graph`)
            .css({
                alignSelf: 'flex-start',
                display: 'inline-flex', alignItems: 'center', gap: '0.375rem',
                padding: '0.4rem 0.75rem',
                background: 'var(--sl-color-neutral-0, #fff)',
                color: 'var(--sl-color-primary-700)',
                border: '1px dashed var(--sl-color-primary-300)',
                borderRadius: '0.5rem', fontSize: '0.875rem', fontWeight: '500',
                cursor: 'pointer',
            })
            .on('click', () => this.#model.addGraph());
    }

    #updateMessages() {
        const hasData = (this.#takes?.size || 0) > 0;
        this.#dom.msgLoading?.css('display', hasData ? 'none' : '');
    }

    // ═══ EVENT WIRING ═══════════════════════════════════════════════════

    #bindEvents() {
        this.#handlers.frame     = () => this.#updateFrameMarkers();
        this.#handlers.selection = () => this.#onSelectionChanged();
        // Takes change discrimination:
        //   'add' / 'remove' → full graph rebuild (a take's data /
        //                       availability changed, paths and chip
        //                       labels need to refresh).
        //   'offset'         → only the X-axis position of one take's
        //                       series shifts; ChartRenderer's
        //                       shiftSeries is the right cheap update.
        //   anything else    → no graph change.
        this.#handlers.takes     = (e) => {
            const kind = e?.detail?.kind;
            const id   = e?.detail?.id;
            if (kind === 'add' || kind === 'remove') {
                this.#renderGraphs();
            } else if (kind === 'offset') {
                // Arrow-nudge / snap-to-peak don't go through the
                // drag's shiftTakeLive path. Catch them here.
                this.#shiftAffectedTakes(id);
            }
            // Other kinds: chip labels go stale until next rebuild,
            // which is fine for offset readouts (the take's offset is
            // shown on its TakeStrip chip, not on the chart card).
        };
        this.#handlers.resize    = () => {
            clearTimeout(this.#resizeTimer);
            this.#resizeTimer = setTimeout(() => this.#renderGraphs(), 200);
        };

        this.#playback.on('frame',   this.#handlers.frame);
        this.#selection.on('change', this.#handlers.selection);
        this.#takes?.on('change', this.#handlers.takes);
        this.#model.on('change', () => this.#renderGraphs());
        window.on('resize', this.#handlers.resize);
    }

    /** Cheap-path Takes refresh on offset change: ask the model for the
     *  shifted slice for each affected take and feed it back to each
     *  ChartRenderer.shiftSeries. When `takeId` is null, we re-shift
     *  every take (snap-to-peak case). */
    #shiftAffectedTakes(takeId) {
        const ids = takeId
            ? [takeId]
            : (this.#takes?.all?.() || []).map(t => t.id);
        for (const id of ids) {
            const take = this.#takes?.byId?.(id);
            if (!take) continue;
            this.shiftTakeLive(id, take.offset | 0);
        }
    }

    #onSelectionChanged() {
        this.#model.extractAllSelected();
        this.#model.purgeOrphanSeries();
        this.#renderGraphs();
    }

    // ═══ RENDERING ══════════════════════════════════════════════════════

    #renderGraphs() {
        this.#dom.graphsWrap.empty();
        for (const id in this.#renderers) this.#renderers[id]?.destroy();
        this.#renderers = {};

        this.#renderStats();
        this.#updateMessages();

        if (!this.#model.hasGraphs) {
            this.#mk(this.#dom.graphsWrap, 'div')
                .text('No graphs yet — click + Add graph below to start composing.')
                .css({
                    fontSize: '0.875rem', color: 'var(--sl-color-neutral-500)',
                    fontStyle: 'italic', padding: '0.5rem 0',
                });
            return;
        }
        for (const g of this.#model.graphs) this.#renderGraphCard(g);
    }

    #renderGraphCard(graph) {
        const card = this.#mk(this.#dom.graphsWrap, 'div').cls('+kinesa-graph-card').css({
            position: 'relative',
        });
        const container = this.#mk(card, 'div').css({ height: '200px', position: 'relative' });

        this.#cardBtn(card, icon.close(), 'Remove graph', '0.5rem',
            () => this.#model.removeGraph(graph.id));
        this.#cardBtn(card, icon.image(), 'Export this graph as PNG', '2.2rem',
            async () => {
                const ok = await exportPng(container.querySelector('svg'),
                    `kinesa_graph_${stamp()}.png`).catch(() => false);
                if (!ok) toast('Nothing to export on this graph yet', 'warn');
            });
        const renderer = new ChartRenderer(container, {
            onSeek: i => {
                if (this.#playback.isPlaying) this.#playback.togglePlayPause();
                this.#playback.setFrame(i);
            },
        });

        const seriesArr = this.#model.buildSeriesArray(graph);
        const { data, offsets } = this.#model.buildLocalDataAndOffsets(seriesArr);
        const maxIdx    = Math.max(0, (this.#playback.frameData?.length || 1) - 1);
        const first     = this.#playback.frameData?.[0]?.frame ?? 0;
        const xRange    = this.#roi
            ? [Math.max(0, this.#roi.startFrame - first),
               Math.min(maxIdx, this.#roi.endFrame - first)]
            : null;

        renderer.renderGraph(seriesArr, data, maxIdx, null, xRange, offsets);
        renderer.updateFrameMarker(this.#playback.currentFrame, `Frame: ${this.#playback.currentFrame}`);
        this.#renderers[graph.id] = renderer;

        // Per-node metric chip rows
        const rowsWrap = this.#mk(card, 'div').css({
            display: 'flex', flexDirection: 'column', gap: '0.25rem',
            marginTop: '0.5rem',
        });
        const selected = this.#selection.all();
        if (!selected.length) {
            this.#mk(rowsWrap, 'div')
                .text('Select nodes in the 3D scene, then toggle metrics here.')
                .css({
                    fontSize: '0.8125rem',
                    color: 'var(--sl-color-neutral-400)',
                    fontStyle: 'italic',
                });
        } else {
            for (const n of selected) this.#renderNodeMetricRow(rowsWrap, graph, n);
        }
    }

    #renderNodeMetricRow(parent, graph, node) {
        const showTake = (this.#takes?.size || 0) > 1;
        const take     = this.#takes?.byId?.(node.takeId);
        const labelText = showTake && take?.name ? `${take.name}·${node.nodeName}` : node.nodeName;

        const row = this.#mk(parent, 'div').css({
            display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.25rem',
        });
        const tag = this.#mk(row, 'div').css({
            display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
            padding: '0.125rem 0.375rem 0.125rem 0.25rem',
            color: node.color,
            fontSize: '0.75rem', fontWeight: '600',
            minWidth: '5.5rem',
        });
        this.#mk(tag, 'span').css({
            width: '8px', height: '8px', borderRadius: '50%',
            background: node.color, flexShrink: '0',
        });
        this.#mk(tag, 'span').text(labelText);

        const meta = take?.metadata;
        for (const m of METRICS) {
            if (m.appliesTo && !m.appliesTo(node, meta)) continue;
            const on = graph.series.some(s => s.nodeKey === node.key && s.metricId === m.id);
            this.#mk(row, 'div')
                .text(m.label)
                .attr('title', m.desc)
                .css(metricChipStyle(on, node.color))
                .on('click', () => this.#model.toggleSeries(graph.id, node.key, m.id));
        }
    }

    #updateFrameMarkers() {
        const frame = this.#playback.currentFrame;
        const label = `Frame: ${frame}`;
        for (const r of Object.values(this.#renderers)) r.updateFrameMarker(frame, label);
    }

    // ═══ STATS CARD ═════════════════════════════════════════════════════

    #renderStats() {
        this.#dom.statsCards.empty();
        const focusedKey = this.#strip?.getFocusedKey?.();
        if (!focusedKey) return;
        const sel   = this.#findSelection(focusedKey);
        const cache = this.#model.cache[focusedKey];
        if (!sel || !cache) return;

        const take   = this.#takes?.byId?.(sel.takeId);
        const master = this.#takes?.master?.();

        // ROI is in MASTER absolute frame coordinates; the cache's
        // `frame` field is in the take's own absolute frame namespace.
        // Translate so Stats.inRange compares apples to apples.
        // master_frame = masterFirst + (s.frame - tFirst) + take.offset
        // → s.frame = master_frame - masterFirst - take.offset + tFirst
        const localRoi = this.#translateRoiToTake(this.#roi, take, master);

        renderStatsCard(this.#dom.statsCards, {
            node:        sel,
            stats:       computeStats(cache, localRoi),
            takeName:    take?.name,
            multiTake:   (this.#takes?.size || 0) > 1,
            onPeakClick: ({ label, value, frame, frameIndex, node }) => {
                if (this.#playback.isPlaying) this.#playback.togglePlayPause();
                // `frameIndex` is the take's local index; convert to
                // the master's playback index by adding take.offset
                // (master is what playback is bound to).
                const playbackIdx = (frameIndex | 0) + ((take?.offset | 0));
                this.#playback.setFrame(playbackIdx);
                // The peak-anchor consumer (KinesaApp) treats `frame`
                // as a master-namespace POI — translate from the
                // take's local absolute to the master's.
                const masterFrame = this.#takeFrameToMaster(frame, take, master);
                this.trigger('peak-anchor', {
                    frame: masterFrame, frameIndex: playbackIdx, label, value,
                    nodeName: node?.nodeName, nodeKey: node?.key,
                });
            },
        });
    }

    /** Translate a master-namespace ROI to the take's own absolute-frame
     *  namespace so Stats.inRange matches `s.frame` correctly. Returns
     *  null when ROI is null. */
    #translateRoiToTake(roi, take, master) {
        if (!roi || !take || !master) return roi;
        const masterFirst = master.frameData?.[0]?.frame ?? 0;
        const tFirst      = take.frameData?.[0]?.frame ?? 0;
        const delta       = masterFirst + (take.offset | 0) - tFirst;
        return { startFrame: roi.startFrame - delta, endFrame: roi.endFrame - delta };
    }

    /** Translate a take's absolute frame number to the master's absolute
     *  frame namespace (for click-to-anchor). */
    #takeFrameToMaster(frame, take, master) {
        if (!Number.isFinite(frame) || !take || !master) return frame;
        const masterFirst = master.frameData?.[0]?.frame ?? 0;
        const tFirst      = take.frameData?.[0]?.frame ?? 0;
        return masterFirst + (frame - tFirst) + (take.offset | 0);
    }

    // ═══ SELECTION DEFAULT / SNAPSHOT / RESTORE ═════════════════════════

    #resetSelection() {
        this.#model.reset();
        this.#selection.clear();
        const master = this.#takes.master();
        if (!master) return;

        const candidates = availableNodesIn(master)
            .filter(n => n.objectName !== OBJECT_NAMES.UNLABELED || n.nodeName === NODE_NAMES.CENTER);
        if (!candidates.length) return;

        const defaults = ['hip', 'hips', 'center', 'head'];
        const found = candidates.find(n => defaults.includes(n.nodeName.toLowerCase()))
                   ?? candidates[0];
        const key = nodeKey(master.id, found.objectName, found.nodeName);

        // A starter graph card with the default metric on the chosen joint.
        this.#model.addGraph();
        const g = this.#model.graphs[this.#model.graphs.length - 1];
        g.series.push({ nodeKey: key, metricId: DEFAULT_METRIC });

        this.#model.extract(master.id, found.objectName, found.nodeName);
        this.#selection.add(master.id, found.objectName, found.nodeName, found.objectType);
    }

    #snapshotState() {
        return {
            selected: this.#selection.all().map(n => ({
                takeId:     n.takeId,
                objectName: n.objectName,
                nodeName:   n.nodeName,
                objectType: n.objectType,
                color:      n.color,
            })),
            graphs:  this.#model.graphs.map(g => ({ series: g.series.map(s => ({ ...s })) })),
            focused: this.#strip?.getFocusedKey?.() ?? null,
        };
    }

    /** Cross-load restore: apply the previous session's selections / graphs
     *  to the newly-loaded master take. Stored takeIds are stale so we
     *  remap by (objectName, nodeName) lookup against the master's
     *  available nodes. */
    #restoreState(prev) {
        if (!prev?.selected?.length) return false;
        const master = this.#takes.master();
        if (!master) return false;

        const availMap = new Map(availableNodesIn(master)
            .map(n => [`${n.objectName}:${n.nodeName}`, n]));

        const oldToNew = new Map();
        let restored  = 0;
        for (const n of prev.selected) {
            const av = availMap.get(`${n.objectName}:${n.nodeName}`);
            if (!av) continue;
            this.#selection.add(master.id, av.objectName, av.nodeName, av.objectType, n.color);
            this.#model.extract(master.id, av.objectName, av.nodeName);
            oldToNew.set(nodeKey(n.takeId, n.objectName, n.nodeName),
                         nodeKey(master.id, av.objectName, av.nodeName));
            restored++;
        }
        if (!restored) return false;

        // Remap series and gate by the metric's `appliesTo` predicate
        // (e.g. X-factor only on Hip + Chest skeletons).
        const meta  = master.metadata;
        const valid = (s) => {
            const m = metricById(s.metricId);
            if (!m) return false;
            if (!m.appliesTo) return true;
            const sel = this.#findSelection(s.nodeKey);
            return !!sel && m.appliesTo(sel, meta);
        };

        for (const g of prev.graphs) {
            const series = g.series
                .map(s => ({ ...s, nodeKey: oldToNew.get(s.nodeKey) }))
                .filter(s => s.nodeKey && valid(s));
            if (!series.length) continue;
            this.#model.addGraph();
            const last = this.#model.graphs[this.#model.graphs.length - 1];
            last.series = series;
        }

        // If the prior session had no graphs (or none survived the
        // metric filter), seed one with the first restored selection.
        if (!this.#model.hasGraphs) {
            const first = this.#selection.all()[0];
            this.#model.addGraph();
            const g = this.#model.graphs[this.#model.graphs.length - 1];
            g.series.push({ nodeKey: first.key, metricId: DEFAULT_METRIC });
        }

        this.#renderGraphs();
        if (prev.focused) {
            const newFocus = oldToNew.get(prev.focused);
            if (newFocus) this.#strip?.setFocusedKey?.(newFocus);
        }
        return true;
    }

    #findSelection(nodeKey) {
        return this.#selection.all().find(n => n.key === nodeKey) || null;
    }
}

// ── Module-level helpers ────────────────────────────────────────────

/** Build the union of "nodes addressable in this take": frame-0 objects
 *  ∪ metadata-declared objects. Results are sorted by (object, node).
 *  Used to seed the default selection AND to remap an old session's
 *  selections onto a re-dropped master. */
function availableNodesIn(take) {
    if (!take?.frameData?.length) return [];
    const first = take.frameData[0];
    const meta  = take.metadata;
    const nodes = [];
    const seen  = new Set();
    const add = (obj, node, type) => {
        const k = `${obj}:${node}`;
        if (seen.has(k)) return;
        seen.add(k);
        nodes.push({ objectName: obj, nodeName: node, objectType: type });
    };
    for (const obj in first.objects) {
        const type = take.metadata?.objects?.[obj]?.type || 'undefined';
        for (const node in first.objects[obj]) add(obj, node, type);
    }
    if (meta?.objects) {
        for (const obj in meta.objects) {
            const { type, nodes: metaNodes } = meta.objects[obj];
            if (!metaNodes) continue;
            for (const node of metaNodes) add(obj, node, type);
        }
    }
    nodes.sort((a, b) => a.objectName !== b.objectName
        ? a.objectName.localeCompare(b.objectName)
        : a.nodeName.localeCompare(b.nodeName));
    return nodes;
}

function metricChipStyle(on, nodeColor) {
    return {
        cursor: 'pointer',
        borderRadius: '9999px',
        minWidth: '2rem',
        padding: '0.125rem 0.5rem',
        fontSize: '0.75rem',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        textAlign: 'center',
        lineHeight: '1.4',
        border: '1px solid',
        transition: 'all 0.15s',
        backgroundColor: on ? `${nodeColor}1A` : 'var(--sl-color-neutral-50)',
        borderColor:     on ? nodeColor        : 'var(--sl-color-neutral-300)',
        color:           on ? nodeColor        : 'var(--sl-color-neutral-600)',
        fontWeight:      on ? '700'            : '500',
    };
}
