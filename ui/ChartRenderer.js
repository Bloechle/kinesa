/**
 * ChartRenderer.js - D3 SVG rendering engine with click-to-seek
 */

import { clamp } from 'qry-kit';

const d3 = window.d3;

// Pixels reserved at the top of every plot for the overlay labels
// (time cursor, values panel). Keeps data lines, the zero line, grid
// lines, and the frame marker clear of the label zone.
const TOP_RESERVE = 22;

export class ChartRenderer {
    constructor(container, { onSeek } = {}) {
        this.root        = container;
        this.width       = 0;
        this.height      = 0;
        this.margin      = { top: 20, right: 20, bottom: 40, left: 40 };
        this.svg         = null;
        this.scales      = { x: null, y: null };
        this.frameMarker = null;
        this.frameLabel  = null;
        this.valuesLabel = null;
        this.nodeDots    = {};
        this.resizeObserver  = null;
        this._resizeTimer    = null;
        this._clipId         = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        this._onSeek         = onSeek || null;
        this._maxFrameIndex  = 0;
        this._seekCleanups   = null;

        this._windowResizeHandler = () => {
            clearTimeout(this._resizeTimer);
            this._resizeTimer = setTimeout(() => this.#handleResize(), 250);
        };
        window.on('resize', this._windowResizeHandler);
    }

    initialize() {
        d3.select(this.root).html('');
        this.#updateDimensions();

        this.svg = d3.select(this.root)
            .append('svg')
            .attr('width',  this.width  + this.margin.left + this.margin.right)
            .attr('height', this.height + this.margin.top  + this.margin.bottom)
            .append('g')
            .attr('transform', `translate(${this.margin.left},${this.margin.top})`);

        if (this.resizeObserver) this.resizeObserver.disconnect();
        this.resizeObserver = new ResizeObserver(() => {
            clearTimeout(this._resizeTimer);
            this._resizeTimer = setTimeout(() => this.#handleResize(), 100);
        });
        this.resizeObserver.observe(this.root);
    }

    renderGraph(nodes, graphData, maxFrameIndex, metricUnits, xRange = null, offsets = null) {
        if (!this.svg) this.initialize();
        this._maxFrameIndex = maxFrameIndex;

        // Effective X domain: explicit xRange (analysis window) or full take
        const [xLo, xHi] = (Array.isArray(xRange) && xRange.length === 2 && xRange[0] < xRange[1])
            ? xRange
            : [0, maxFrameIndex];
        this._xDomain = [xLo, xHi];

        // Unit for the metric being plotted on this chart (all nodes in `nodes`
        // share the same metric since ChartWidget groups one renderer per metric)
        const metricName = nodes?.[0]?.property?.name;
        this._unit = (metricUnits && metricName) ? (metricUnits[metricName] || '') : '';

        this._seekCleanups?.();
        this._seekCleanups = null;

        this.svg.selectAll('*').remove();
        this.svg.append('defs').append('clipPath')
            .attr('id', this._clipId)
            .append('rect').attr('width', this.width).attr('height', this.height);
        this.nodeDots = {};

        if (!nodes?.length) { this.#renderEmpty(); return; }

        this.scales.x = d3.scaleLinear().domain([xLo, xHi]).range([0, this.width]);
        this.#setupYScale(nodes, graphData, offsets);
        this.#addAxes(nodes, graphData, offsets);
        this.#addZeroLine();
        this.#addSeekOverlay();
        this.#drawNodeLines(nodes, graphData, offsets);
        this.#addFrameMarker(xLo);
    }

    updateFrameMarker(frameIndex, frameText) {
        if (!this.frameMarker || !this.scales.x) return;
        const [xLo, xHi] = this._xDomain || this.scales.x.domain();
        const inRange = frameIndex >= xLo && frameIndex <= xHi;

        // Iterate `this.nodeDots` directly (a plain object). `for...in`
        // walks own enumerable keys without allocating an entries array
        // — saves two `Object.entries(...)` allocations per playback
        // tick, called at 60Hz during playback.
        if (!inRange) {
            this.frameMarker.attr('visibility', 'hidden');
            this.frameLabel.attr('visibility', 'hidden');
            this.valuesLabel?.attr('visibility', 'hidden');
            for (const k in this.nodeDots) this.nodeDots[k].dot.attr('visibility', 'hidden');
            return;
        }

        const x = this.scales.x(frameIndex);

        // `frameIndex` is in master coordinates; per-series data is in
        // local frames. Subtract each series' offset to get its local
        // index for the byIndex Map lookup (O(1), built at draw time).
        let time = null;
        for (const k in this.nodeDots) {
            const info = this.nodeDots[k];
            const pt   = info.byIndex.get(frameIndex - (info.offset | 0));
            if (pt?.time != null) { time = pt.time; break; }
        }

        // Cursor label: show time (frames live in the CSV export, not
        // on the chart). Falls back to the frame number only if time
        // is unavailable.
        this.frameMarker.attr('x1', x).attr('x2', x).attr('visibility', 'visible');
        this.frameLabel
            .attr('x', x)
            .text(time != null ? `Time: ${time.toFixed(3)}s` : (frameText || `Frame: ${frameIndex}`))
            .attr('visibility', 'visible');

        // Per-node dots + label pieces — values only, time is on the cursor label.
        const unitSuffix = this._unit ? ` ${this._unit}` : '';
        const pieces = [];

        for (const k in this.nodeDots) {
            const info = this.nodeDots[k];
            const pt   = info.byIndex.get(frameIndex - (info.offset | 0));
            const val  = pt ? info.accessor(pt) : undefined;
            if (pt && val != null && !isNaN(val)) {
                pieces.push({
                    color: info.color || 'currentColor',
                    text:  `${info.nodeName}: ${val.toFixed(2)}${unitSuffix}`,
                });
                info.dot.attr('cx', x).attr('cy', this.scales.y(val)).attr('visibility', 'visible');
            } else {
                info.dot.attr('visibility', 'hidden');
            }
        }

        // Top-right panel: one <tspan> per node, coloured like its line.
        if (this.valuesLabel) {
            this.valuesLabel.selectAll('*').remove();
            const sep = 'var(--sl-color-neutral-400)';
            pieces.forEach((p, i) => {
                if (i > 0) this.valuesLabel.append('tspan').attr('fill', sep).text(' · ');
                this.valuesLabel.append('tspan')
                    .attr('fill', p.color)
                    .style('font-weight', '600')
                    .text(p.text);
            });
            this.valuesLabel.attr('visibility', pieces.length ? 'visible' : 'hidden');
        }
    }

    destroy() {
        clearTimeout(this._resizeTimer);
        this._seekCleanups?.();
        this._seekCleanups = null;
        window.off('resize', this._windowResizeHandler);
        this.resizeObserver?.disconnect();
        d3.select(this.root).html('');
        this.svg         = null;
        this.scales      = { x: null, y: null };
        this.frameMarker = null;
        this.frameLabel  = null;
        this.valuesLabel = null;
        this.nodeDots    = {};
    }

    // ── Internals ───────────────────────────────────────────

    #updateDimensions() {
        this.width  = Math.max(100, this.root.clientWidth  - this.margin.left - this.margin.right);
        this.height = Math.max(100, this.root.clientHeight - this.margin.top  - this.margin.bottom);
    }

    #handleResize() {
        if (!this.svg) return;
        const ow = this.width, oh = this.height;
        this.#updateDimensions();
        if (ow === this.width && oh === this.height) return;

        d3.select(this.root).select('svg')
            .attr('width',  this.width  + this.margin.left + this.margin.right)
            .attr('height', this.height + this.margin.top  + this.margin.bottom);

        this._seekCleanups?.();
        this._seekCleanups = null;
        this.svg.selectAll('*').remove();
        this.svg.append('defs').append('clipPath')
            .attr('id', this._clipId)
            .append('rect').attr('width', this.width).attr('height', this.height);
        this.nodeDots = {};
    }

    #setupYScale(nodes, graphData, offsets = null) {
        const [xLo, xHi] = this._xDomain || [0, this._maxFrameIndex];
        let vals = [];
        nodes.forEach(n => {
            const d    = graphData[n.key]?.[n.property?.name || 'pos'];
            const comp = n.property?.component;
            if (!d?.length) return;
            const offset = offsets?.[n.key] | 0;
            for (let i = 0; i < d.length; i++) {
                const pt = d[i];
                if (!pt) continue;
                const fi = pt.frameIndex;
                if (fi == null) continue;
                const m = fi + offset;
                if (m < xLo || m > xHi) continue;
                const v = comp == null ? pt.value : pt[comp];
                if (v != null) vals.push(v);
            }
        });

        if (!vals.length) { this.scales.y = d3.scaleLinear().domain([-1, 1]).range([this.height, 0]); return; }

        let mn = d3.min(vals) || 0, mx = d3.max(vals) || 0;
        const pad = Math.max(0.1, Math.abs(mx - mn) * 0.1);
        let lo = mn >= 0 ? 0 : mn - pad;
        let hi = mx <= 0 ? 0 : mx + pad;
        if (Math.abs(hi - lo) < 0.0001) { lo -= 1; hi += 1; }
        // Reserve TOP_RESERVE px at the top of the plot for the overlay panel —
        // data lines will never be drawn higher than y = TOP_RESERVE, so the
        // label zone stays clear of every curve.
        this.scales.y = d3.scaleLinear().domain([lo, hi]).range([this.height, TOP_RESERVE]);
    }

    #addAxes(nodes, graphData, offsets = null) {
        // Find a series with time info so we can convert frame-index
        // ticks → seconds. Prefer a node with offset 0 (master) so the
        // local frameIndex matches the master x-axis ticks directly;
        // fall back to any node if no zero-offset node has data.
        let pickKey = null;
        for (const n of nodes || []) {
            if (!graphData?.[n.key]?.pos?.length) continue;
            const off = offsets?.[n.key] | 0;
            if (off === 0) { pickKey = n.key; break; }
        }
        if (!pickKey) pickKey = nodes?.find(n => graphData?.[n.key]?.pos?.length)?.key;
        const series  = pickKey ? graphData[pickKey].pos : null;
        const pickOff = offsets?.[pickKey] | 0;
        const timeAt  = idx => series?.find(d => d.frameIndex === idx - pickOff)?.time ?? null;

        const [d0, d1] = this.scales.x.domain();
        const t0       = timeAt(d0);
        const t1       = timeAt(d1);
        const hasTime  = t0 != null && t1 != null && t1 > t0;

        // Pick tick count based on available width
        const sz    = d1 - d0;
        const count = sz > 1000
            ? Math.min(8,  Math.max(4, Math.floor(this.width / 150)))
            : sz > 100
            ? Math.min(10, Math.max(6, Math.floor(this.width / 100)))
            : Math.min(12, Math.max(5, Math.floor(this.width / 80)));

        // Prefer nice TIME values; fall back to frame indices if no time info
        let tv, labels;
        if (hasTime) {
            const niceTimes = d3.ticks(t0, t1, count);
            const slope     = (d1 - d0) / (t1 - t0);
            tv     = niceTimes.map(t => d0 + (t - t0) * slope);
            const fmt = d3.format('.3~f');
            labels = niceTimes.map(t => `${fmt(t)} s`);
        } else {
            const step = sz / (count - 1);
            tv     = Array.from({ length: count }, (_, i) => Math.round(d0 + i * step));
            labels = tv.map(String);
        }

        this.#addGrid(tv);

        this.svg.append('g')
            .attr('transform', `translate(0,${this.height})`).attr('stroke-width', 1)
            .call(d3.axisBottom(this.scales.x)
                .tickValues(tv)
                .tickFormat((d, i) => labels[i]));

        this.svg.append('text').attr('text-anchor', 'middle')
            .attr('x', this.width / 2).attr('y', this.height + this.margin.top + 20)
            .style('font-size', '12px').text(hasTime ? 'Time' : 'Frame');

        this.svg.append('g').attr('stroke-width', 1).call(d3.axisLeft(this.scales.y).ticks(5));
    }

    #addGrid(xTickValues = null) {
        if (this.scales.y) {
            this.svg.append('g').attr('class', 'grid').attr('opacity', 0.75)
                .selectAll('line').data(this.scales.y.ticks(5)).enter().append('line')
                .attr('x1', 0).attr('x2', this.width)
                .attr('y1', d => this.scales.y(d)).attr('y2', d => this.scales.y(d))
                .attr('stroke', '#ccc').attr('stroke-width', 0.5).attr('stroke-dasharray', '2,2');
        }
        if (this.scales.x && xTickValues?.length) {
            this.svg.append('g').attr('class', 'grid-v').attr('opacity', 0.5)
                .selectAll('line').data(xTickValues).enter().append('line')
                .attr('x1', d => this.scales.x(d)).attr('x2', d => this.scales.x(d))
                .attr('y1', TOP_RESERVE).attr('y2', this.height)
                .attr('stroke', '#ccc').attr('stroke-width', 0.5).attr('stroke-dasharray', '2,2');
        }
    }

    #addZeroLine() {
        if (!this.scales.y) return;
        const [lo, hi] = this.scales.y.domain();
        if (lo < 0 && hi > 0) {
            const y0 = this.scales.y(0);
            if (y0 >= 0 && y0 <= this.height) {
                this.svg.append('line').attr('class', 'chart-zero-line')
                    .attr('x1', 0).attr('y1', y0).attr('x2', this.width).attr('y2', y0)
                    .attr('stroke', '#444').attr('stroke-width', 1.5).attr('opacity', 0.8);
            }
        }
    }

    #addSeekOverlay() {
        if (!this._onSeek || !this.scales.x) return;

        const overlay = this.svg.append('rect')
            .attr('width', this.width).attr('height', this.height)
            .attr('fill', 'transparent').style('cursor', 'crosshair');

        let dragging = false;

        const seekToX = mx => {
            const svgRect = this.root.querySelector('svg')?.getBoundingClientRect();
            if (!svgRect) return;
            const x = mx - svgRect.left - this.margin.left;
            const frameIdx = Math.round(this.scales.x.invert(clamp(x, 0, this.width)));
            this._onSeek(clamp(frameIdx, 0, this._maxFrameIndex));
        };

        overlay.on('mousedown', e => { dragging = true; seekToX(e.clientX); });

        const onMove = e => { if (dragging) seekToX(e.clientX); };
        const onUp   = () => { dragging = false; };
        window.on('mousemove', onMove);
        window.on('mouseup',   onUp);
        this._seekCleanups = () => {
            window.off('mousemove', onMove);
            window.off('mouseup',   onUp);
        };
    }

    #drawNodeLines(nodes, graphData, offsets = null) {
        const sx = this.scales.x;
        const sy = this.scales.y;

        nodes.forEach(node => {
            const prop = node.property?.name || 'pos';
            const comp = node.property?.component;
            const fullData = graphData[node.key]?.[prop];
            if (!fullData?.length || !sy) return;

            const accessor = comp == null ? d => d.value : d => d[comp];

            // O(1) frame-index lookup table for the playhead marker.
            // Built once per render; updateFrameMarker (called every
            // playback tick at 60Hz) used to do `data.find(d => d.frameIndex === fi)`
            // — N×O(N) per playback frame. Now O(N) once + O(1) per
            // marker update.
            const byIndex = new Map();
            for (let i = 0; i < fullData.length; i++) {
                const d = fullData[i];
                if (d?.frameIndex != null) byIndex.set(d.frameIndex, d);
            }

            // The entry object holds mutable offset state; the line
            // generator's arrow closes over `entry` so shiftSeries only
            // needs to update `entry.offset` — no need to rebuild the
            // generator on each drag tick.
            const entry = {
                accessor,
                data: fullData, fullData, byIndex,
                offset: offsets?.[node.key] | 0,
                color:  node.color,
                nodeName: node.key.slice(node.key.lastIndexOf(':') + 1),
            };
            entry.line = d3.line()
                .defined(d => {
                    const v = accessor(d);
                    return v != null && !isNaN(v) && d.frameIndex != null && !isNaN(d.frameIndex);
                })
                .x(d => sx(d.frameIndex + entry.offset))
                .y(d => sy(accessor(d)))
                .curve(d3.curveMonotoneX);

            const g = this.svg.append('g').attr('clip-path', `url(#${this._clipId})`);
            entry.path = g.append('path').datum(fullData)
                .attr('fill', 'none').attr('stroke', node.color)
                .attr('stroke-opacity', 0.8).attr('stroke-width', 2)
                .attr('stroke-linecap', 'round').attr('d', entry.line);
            entry.dot = g.append('circle').attr('r', 5)
                .attr('fill', node.color).attr('stroke', '#fff').attr('stroke-width', 1.5)
                .attr('opacity', 0.9).attr('visibility', 'hidden').style('pointer-events', 'none');

            this.nodeDots[node.key] = entry;
        });
    }

    /** Live-shift a series along the X axis. Mutates `entry.offset`;
     *  the line generator (built once at draw time) closes over the
     *  entry, so its X accessor reads the new value automatically.
     *  Zero allocations per drag tick.
     *
     *  @param {string} nodeKey  The series key (`node.key`)
     *  @param {number} offset   Frame offset to apply on the X axis
     */
    shiftSeries(nodeKey, offset = 0) {
        const entry = this.nodeDots[nodeKey];
        if (!entry || !entry.fullData?.length) return;
        entry.offset = offset;
        entry.path.attr('d', entry.line);
    }

    #addFrameMarker(idx) {
        this.frameMarker = this.svg.append('line').attr('class', 'chart-frame-marker')
            .attr('x1', this.scales.x(idx)).attr('x2', this.scales.x(idx))
            .attr('y1', TOP_RESERVE).attr('y2', this.height)
            .attr('stroke', 'currentColor').attr('stroke-width', 1).attr('stroke-opacity', 0.5)
            .style('pointer-events', 'none');

        this.frameLabel = this.svg.append('text').attr('class', 'chart-frame-label')
            .attr('x', this.scales.x(idx)).attr('y', 14)
            .attr('text-anchor', 'middle')
            .style('font-size', '10px').style('font-weight', 'bold')
            .style('fill', 'currentColor').style('opacity', 0.8)
            .style('stroke', 'white').style('stroke-width', '3px')
            .style('paint-order', 'stroke')
            .style('pointer-events', 'none');

        // Values panel — fixed above the plot (top-right, in the top margin).
        // Children are <tspan>s rebuilt each updateFrameMarker call so each
        // node's value can wear its line color. White halo keeps colours
        // readable if any axis tick labels end up underneath.
        this.valuesLabel = this.svg.append('text').attr('class', 'chart-values-label')
            .attr('x', this.width - 4).attr('y', -5)
            .attr('text-anchor', 'end')
            .style('font-size', '10px').style('font-weight', '500')
            .style('stroke', 'white').style('stroke-width', '3px')
            .style('paint-order', 'stroke')
            .style('pointer-events', 'none')
            .attr('visibility', 'hidden');
    }

    #renderEmpty() {
        this.scales.x = d3.scaleLinear().domain([0, 100]).range([0, this.width]);
        this.scales.y = d3.scaleLinear().domain([-1, 1]).range([this.height, 0]);

        this.svg.append('g').attr('transform', `translate(0,${this.height})`).attr('opacity', 0.5)
            .call(d3.axisBottom(this.scales.x).ticks(5));
        this.svg.append('g').attr('opacity', 0.5).call(d3.axisLeft(this.scales.y).ticks(5));
        this.svg.append('text').attr('text-anchor', 'middle')
            .attr('x', this.width / 2).attr('y', this.height / 2)
            .style('font-size', '14px').style('fill', '#aaa').text('No node data to display');
        this.#addFrameMarker(0);
    }
}
