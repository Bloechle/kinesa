/**
 * GraphsModel.js — Data layer for the chart UI.
 *
 * Owns three things:
 *   1. The list of graph cards and their series:
 *        #graphs : [{ id, series: [{ nodeKey, metricId }] }]
 *   2. The per-(take × object × node) extracted series cache:
 *        #cache  : { [takeId:object:node]: { pos:[], speed:[], … } }
 *   3. A derived "shifted" cache that mirrors `#cache` with frame indices
 *      remapped to master-frame coordinates. Keyed by composite
 *      `nodeKey|metricId` so the renderer's `nodeDots[node.key]` doesn't
 *      collide between metrics of the same node.
 *
 * Pure model — no DOM. Emits 'change' on every mutation. The view
 * (ChartWidget) subscribes and re-renders.
 *
 * Wires into existing app state:
 *   - `takes`     : Takes registry (read-only — we look up offsets, names,
 *                    frame data via the registry's accessors)
 *   - `selection` : Selection registry (read-only — drives series
 *                    validity via `#findSelectionByKey`)
 *
 * The constructor takes both because the model needs to walk them on
 * many of its operations (peak finding, orphan purging, building
 * renderer-ready arrays).
 */

import { firstSignificantPeak } from '../data/peaks.js';
import {
    UNITS, metricById, fullKey, extractTakeNodeSeries,
} from './metrics-catalog.js';

export class GraphsModel extends EventTarget {
    #takes;
    #selection;

    #graphs       = [];
    #graphIdSeq   = 0;
    #cache        = {};

    constructor(takes, selection) {
        super();
        this.#takes     = takes;
        this.#selection = selection;
    }

    // ── Public reads ───────────────────────────────────────────────

    /** Current list of graph cards (caller-immutable; clone if you mutate). */
    get graphs()    { return this.#graphs; }
    /** Raw cache slice — mostly for the CSV exporter. */
    get cache()     { return this.#cache; }
    get hasGraphs() { return this.#graphs.length > 0; }

    // ── Mutations ──────────────────────────────────────────────────

    addGraph() {
        const g = { id: this.#nextId(), series: [] };
        this.#graphs.push(g);
        this.#emit();
        return g;
    }

    removeGraph(graphId) {
        const i = this.#graphs.findIndex(g => g.id === graphId);
        if (i < 0) return;
        this.#graphs.splice(i, 1);
        this.#emit();
    }

    /** Toggle a (node, metric) on the given graph card. */
    toggleSeries(graphId, nodeKey, metricId) {
        const g = this.#graphs.find(x => x.id === graphId);
        if (!g) return;
        const idx = g.series.findIndex(s => s.nodeKey === nodeKey && s.metricId === metricId);
        if (idx >= 0) g.series.splice(idx, 1);
        else          g.series.push({ nodeKey, metricId });
        this.#emit();
    }

    /** Drop every series whose node is no longer in Selection. Call after
     *  Selection mutates. Silent (no emit) — caller batches the re-render. */
    purgeOrphanSeries() {
        const valid = new Set(this.#selection.all().map(n => n.key));
        for (const g of this.#graphs) {
            g.series = g.series.filter(s => valid.has(s.nodeKey));
        }
    }

    /** Wipe everything (used by ChartWidget on a fresh-master scenario). */
    reset() {
        this.#graphs = [];
        this.#cache  = {};
        this.#emit();
    }

    /** Drop cache + shifted entries for one take (it's been removed or
     *  mutated topology-wise). */
    clearCacheForTake(takeId) {
        const prefix = `${takeId}:`;
        for (const k of Object.keys(this.#cache))        if (k.startsWith(prefix)) delete this.#cache[k];
    }

    /** Compute and cache the per-property series for one (take × node).
     *  No-op if the cache already has the entry. */
    extract(takeId, objectName, nodeName) {
        const take = this.#takes?.byId?.(takeId);
        if (!take) return;
        const ck = fullKey(takeId, objectName, nodeName);
        if (this.#cache[ck]?.pos?.length > 0) return;
        const c = extractTakeNodeSeries(take, objectName, nodeName);
        if (c) this.#cache[ck] = c;
    }

    /** Convenience: extract for every selected node in one call. */
    extractAllSelected() {
        for (const n of this.#selection.all()) {
            this.extract(n.takeId, n.objectName, n.nodeName);
        }
    }

    // ── Renderer-facing builders ───────────────────────────────────

    /** Build the array passed to ChartRenderer.renderGraph. Each entry
     *  carries `key` (composite, used to index nodeDots), `nodeKey` (raw
     *  3-part), `name`, `color`, `property`, `unit`. */
    buildSeriesArray(graph) {
        const showPrefix = (this.#takes?.size || 0) > 1;
        const out = [];
        for (const s of graph.series) {
            const m   = metricById(s.metricId);
            const sel = this.#findSelection(s.nodeKey);
            if (!m || !sel) continue;
            const take = this.#takes?.byId?.(sel.takeId);
            const px   = (showPrefix && take?.name) ? `${take.name}·` : '';
            const key  = `${s.nodeKey}|${s.metricId}`;
            out.push({
                id:       key,
                key,
                nodeKey:  s.nodeKey,
                name:     `${px}${sel.nodeName} ${m.label}`,
                color:    sel.color,
                property: { name: m.name, component: m.component, label: m.label, desc: m.desc },
                unit:     UNITS[m.name] || '',
            });
        }
        return out;
    }

    /** Build the graphData object + per-series offset map for the
     *  ChartRenderer. The graphData is keyed by composite
     *  `nodeKey|metricId` and contains the LOCAL-frame point arrays
     *  (the same arrays the cache holds — no copy, no allocation).
     *  The renderer applies the per-series offset on its X accessor.
     *  Returns `{ data, offsets }`. */
    buildLocalDataAndOffsets(seriesArr) {
        const data    = {};
        const offsets = {};
        for (const s of seriesArr) {
            const sel = this.#findSelection(s.nodeKey);
            if (!sel) continue;
            const take = this.#takes?.byId?.(sel.takeId);
            if (!take) continue;
            const src = this.#cache[s.nodeKey];
            if (!src) continue;
            data[s.key]    = src;
            offsets[s.key] = take.offset | 0;
        }
        return { data, offsets };
    }

    /** Live shift one take's plotted series. Yields one `{ graphId,
     *  compositeKey, offset }` per touched series — the caller
     *  (ChartWidget) hands each to its ChartRenderer.shiftSeries().
     *  No data array is materialized: the renderer applies the offset
     *  on the line generator's X accessor. Zero per-call allocation
     *  beyond the small yielded descriptor object. */
    *liveShiftFor(takeId, offset) {
        const prefix = `${takeId}:`;
        for (const g of this.#graphs) {
            for (const s of g.series) {
                if (!s.nodeKey.startsWith(prefix)) continue;
                const m = metricById(s.metricId);
                if (!m) continue;
                const src = this.#cache[s.nodeKey]?.[m.name];
                if (!src) continue;
                yield { graphId: g.id, compositeKey: `${s.nodeKey}|${s.metricId}`, offset };
            }
        }
    }

    // ── Peak finding ───────────────────────────────────────────────

    /** Find the alignment peak of a cached series: the FIRST local
     *  maximum reaching 80% of the global |max| (data/peaks.js). Stable
     *  across takes for double-contact gestures; identical to the global
     *  max for single-peak signals. Returns { frame, frameIndex, value }
     *  or null. Pure helper used by both findPeak* methods. */
    static #peakIn(series, getter) {
        const got = firstSignificantPeak(series, getter);
        return got && { frame: got.point.frame, frameIndex: got.point.frameIndex, value: got.value };
    }

    /** Alignment peak of one (take, object, node, metric) — extracts on
     *  demand. Returns { frame, frameIndex, time, value } or null. */
    peakOf(takeId, objectName, nodeName, metricId) {
        const m = metricById(metricId);
        if (!m) return null;
        this.extract(takeId, objectName, nodeName);
        const series = this.#cache[fullKey(takeId, objectName, nodeName)]?.[m.name];
        if (!series?.length) return null;
        const got = firstSignificantPeak(series,
            m.component == null ? pt => pt.value : pt => pt[m.component]);
        return got && {
            frame: got.point.frame, frameIndex: got.point.frameIndex,
            time: got.point.time, value: got.value,
        };
    }

    /** Find the absolute peak across all plotted series (any take, any
     *  metric). Used by `findPeakOnActiveMetric` callers. Ensures the
     *  cache is populated first. */
    findPeakAcrossSeries() {
        const seriesList = this.#allUniqueSeries();
        if (!seriesList.length) return null;
        for (const s of seriesList) {
            const sel = this.#findSelection(s.nodeKey);
            if (sel) this.extract(sel.takeId, sel.objectName, sel.nodeName);
        }

        let best = null;
        for (const s of seriesList) {
            const m = metricById(s.metricId);
            if (!m) continue;
            const series = this.#cache[s.nodeKey]?.[m.name];
            if (!series?.length) continue;
            const got = GraphsModel.#peakIn(series, m.component == null ? p => p.value : p => p[m.component]);
            if (got && (!best || got.value > best.value)) {
                best = { ...got, nodeKey: s.nodeKey, metricLabel: m.desc, unit: UNITS[m.name] || '' };
            }
        }
        return best;
    }

    /** Compute the per-take peak using the focused chip's first metric
     *  (or, fallback, the first plotted series). For each take that owns
     *  the same (object, name) as the criterion, extract its data and
     *  find its absolute peak. Returns one entry per matching take. */
    findPeakPerTake(focusedKey) {
        const crit = this.#pickCriterion(focusedKey);
        if (!crit) return [];
        const { metric: m, objectName, nodeName } = crit;
        const out = [];
        const get = m.component == null ? p => p.value : p => p[m.component];

        for (const take of this.#takes.all()) {
            if (!take.frameData?.[0]?.objects?.[objectName]?.[nodeName]) continue;
            this.extract(take.id, objectName, nodeName);
            const series = this.#cache[fullKey(take.id, objectName, nodeName)]?.[m.name];
            if (!series?.length) continue;
            const got = GraphsModel.#peakIn(series, get);
            if (got) out.push({
                ...got,
                takeId:      take.id,
                metricLabel: m.desc,
                unit:        UNITS[m.name] || '',
                nodeName,
            });
        }
        return out;
    }

    // ── Internals ──────────────────────────────────────────────────

    #nextId() { return `g${++this.#graphIdSeq}`; }
    #emit()   { this.trigger('change', this.#graphs); }

    #findSelection(nodeKey) {
        return this.#selection.all().find(n => n.key === nodeKey) || null;
    }

    #allUniqueSeries() {
        const seen = new Set();
        const out  = [];
        for (const g of this.#graphs) {
            for (const s of g.series) {
                const k = `${s.nodeKey}|${s.metricId}`;
                if (seen.has(k)) continue;
                seen.add(k);
                out.push(s);
            }
        }
        return out;
    }

    /** Pick the "criterion" metric for snap-to-peak: focused chip's first
     *  plotted metric, falling back to the first plotted series across
     *  graphs. Returns { metric, objectName, nodeName } or null. */
    #pickCriterion(focusedKey) {
        let crit = null;
        if (focusedKey) {
            for (const g of this.#graphs) {
                const s = g.series.find(s => s.nodeKey === focusedKey);
                if (s) { crit = s; break; }
            }
        }
        if (!crit) {
            for (const g of this.#graphs) {
                if (g.series.length) { crit = g.series[0]; break; }
            }
        }
        if (!crit) return null;
        const m = metricById(crit.metricId);
        if (!m) return null;
        const [, objectName, nodeName] = crit.nodeKey.split(':');
        return { metric: m, objectName, nodeName };
    }
}
