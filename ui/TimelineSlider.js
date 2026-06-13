/**
 * TimelineSlider.js — Unified timeline control.
 *
 * Single SVG strip that combines three interactions on the same axis:
 *   - Playhead drag / track click → scrub (seek playback)
 *   - Left/right handles drag     → resize the analysis window
 *   - Double-click                → clear the window
 *
 * Visual layers (bottom → top):
 *   track   flat rounded pill, full width
 *   band    green fill between the two handles (only visible when a window is active)
 *   handles two small vertical caps at the window edges
 *   playhead filled circle at the current frame
 *
 * When both handles sit at the extremes (firstFrame / lastFrame),
 * the window is considered null (no analysis window set).
 *
 * Public API:
 *   setBounds(firstFrame, lastFrame)       — feed the take's frame range
 *   setCurrentFrame(absFrame)              — move the playhead
 *   setRange(range)                        — programmatic window set; does not emit
 *   setPoi(absFrame|null)                  — render (or hide) the point-of-interest mark
 *   getRange()                              — { startFrame, endFrame } | null
 *   destroy()
 *
 * Events:
 *   'seek'         detail = { frame }                — continuous, during scrub + on clicks
 *   'scrub'        detail = { active: bool }         — true on scrub start, false on end
 *   'range-change' detail = range|null               — once when a handle drag completes
 *   'poi-change'   detail = absFrame|null            — emitted on double-click
 *                                                       (sets POI at click frame, or
 *                                                        clears if dblclicking the existing POI)
 *
 * d3 is used as a global (same pattern as ChartRenderer).
 */

import { clamp } from 'qry-kit';

const d3 = window.d3;

const HANDLE_INSET = 8;   // px — keeps handles from overflowing the SVG edges
const TRACK_H      = 10;
const HANDLE_H     = 18;
const HANDLE_W     = 6;
const PLAYHEAD_R   = 7;

// Single-source palette. Keep the ROI muted (it's a viewport, not a
// status indicator) so the colored controls — orange POI flag, tinted
// slave knobs, red playhead — stay the visible actors.
const COLORS = {
    track:    'var(--sl-color-neutral-200)',
    band:     '#64748b',   // slate-500
    handle:   '#64748b',
    poi:      '#f59e0b',   // amber-500
    playhead: 'var(--sl-color-primary-600, #dc2626)',
    label:    'rgba(15, 23, 42, 0.92)',
};

export class TimelineSlider extends EventTarget {
    #root;
    #height;
    #firstFrame = 0;
    #lastFrame  = 0;
    #currentFrame = 0;
    #rangeStart; #rangeEnd;           // always numbers — equal to bounds when "no window"
    #poi = null;                       // absolute frame, or null
    #secondaryPois = [];               // [{ id, frame, color, name? }, ...] — knobs for non-active takes
    #dragRect = null;                  // cached SVG bounding box during drag
    #x;

    // cached d3 selections for cheap updates
    #svg; #band; #leftHandle; #rightHandle; #playhead; #poiMark;
    #secondaryGroup;
    #secondaryLabel;

    constructor(containerId, { height = 36 } = {}) {
        super();
        this.#root   = document.getElementById(containerId);
        this.#height = height;
        this.#root?.replaceChildren();
    }

    // ── Public API ───────────────────────────────────────────────────────

    setBounds(firstFrame, lastFrame) {
        if (!Number.isFinite(firstFrame) || !Number.isFinite(lastFrame) || firstFrame >= lastFrame) {
            this.#clear();
            return;
        }
        this.#firstFrame   = firstFrame;
        this.#lastFrame    = lastFrame;
        this.#rangeStart   = firstFrame;
        this.#rangeEnd     = lastFrame;
        this.#poi          = null;
        this.#currentFrame = clamp(this.#currentFrame, firstFrame, lastFrame);
        this.#render();
    }

    setCurrentFrame(absFrame) {
        if (!Number.isFinite(absFrame)) return;
        this.#currentFrame = clamp(absFrame, this.#firstFrame, this.#lastFrame);
        this.#updatePlayhead();
    }

    /** Set or clear the point-of-interest mark (null to hide). */
    setPoi(absFrame) {
        this.#poi = Number.isFinite(absFrame)
            && absFrame >= this.#firstFrame
            && absFrame <= this.#lastFrame
            ? absFrame : null;
        this.#updatePoi();
    }

    /** Set the secondary POI knobs (one per non-master take). Each knob
     *  renders as a tinted upward triangle below the track, draggable
     *  horizontally to re-position that take's POI on the master
     *  timeline. Pass an empty array (or null) to clear.
     *
     *  Each entry can include `offset` (the take's frame offset in
     *  master space) and `name` (display name) — both surface in the
     *  hover label. Non-essential.
     *
     *  @param {Array<{id:string, frame:number, color:string, offset?:number, name?:string, locked?:boolean}>} pois */
    setSecondaryPois(pois) {
        this.#secondaryPois = Array.isArray(pois) ? pois.slice() : [];
        this.#renderSecondaryPois();
    }

    /** Programmatic window set. Does NOT emit 'range-change'. */
    setRange(range) {
        if (range && Number.isFinite(range.startFrame) && Number.isFinite(range.endFrame)
            && range.startFrame >= this.#firstFrame && range.endFrame <= this.#lastFrame
            && range.startFrame <  range.endFrame) {
            this.#rangeStart = range.startFrame;
            this.#rangeEnd   = range.endFrame;
        } else {
            this.#rangeStart = this.#firstFrame;
            this.#rangeEnd   = this.#lastFrame;
        }
        this.#updateWindow();
    }

    getRange() {
        if (this.#rangeStart === this.#firstFrame && this.#rangeEnd === this.#lastFrame) return null;
        return { startFrame: this.#rangeStart, endFrame: this.#rangeEnd };
    }

    destroy() { this.#clear(); }

    // ── internals ────────────────────────────────────────────────────────

    #clear() { this.#root?.replaceChildren(); }

    #render() {
        this.#clear();

        const rect  = this.#root.getBoundingClientRect();
        const width = Math.max(120, rect.width || 400);
        const H     = this.#height;
        const midY  = H / 2;

        this.#svg = d3.select(this.#root).append('svg')
            .attr('width',  width)
            .attr('height', H)
            .style('display', 'block')
            .style('user-select', 'none');

        this.#x = d3.scaleLinear()
            .domain([this.#firstFrame, this.#lastFrame])
            .range([HANDLE_INSET, width - HANDLE_INSET])
            .clamp(true);

        // Track (scrub hit zone — click/drag anywhere on this scrubs)
        this.#svg.append('rect')
            .attr('class', 'kinesa-timeline-track')
            .attr('x', 0).attr('y', midY - TRACK_H / 2)
            .attr('width', width).attr('height', TRACK_H)
            .attr('rx', TRACK_H / 2)
            .attr('fill', COLORS.track)
            .style('cursor', 'pointer');

        // Analysis window band (also a scrub hit zone — clicking on it still seeks)
        // Neutral slate-blue: the ROI is just a viewport window, not a
        // status indicator — keeping it visually quiet lets the colored
        // POI flag and per-take knobs read as the active controls.
        this.#band = this.#svg.append('rect')
            .attr('class', 'kinesa-timeline-band')
            .attr('y', midY - TRACK_H / 2)
            .attr('height', TRACK_H)
            .attr('rx', TRACK_H / 2)
            .attr('fill', COLORS.handle)           // slate-500
            .attr('fill-opacity', 0.28)
            .style('cursor', 'pointer')
            .style('pointer-events', 'visiblePainted');

        // Left / right handles — drag to resize the window. Same neutral
        // slate so the band + handles read as a single muted widget.
        // Left / right handles — drag to resize the window. Same neutral
        // slate so the band + handles read as a single muted widget.
        const mkHandle = () => this.#svg.append('rect')
            .attr('class', 'kinesa-timeline-handle')
            .attr('y', midY - HANDLE_H / 2)
            .attr('width', HANDLE_W).attr('height', HANDLE_H)
            .attr('rx', 2)
            .attr('fill',   COLORS.handle)
            .attr('stroke', 'white')
            .attr('stroke-width', 1.5)
            .style('cursor', 'ew-resize');
        this.#leftHandle  = mkHandle();
        this.#rightHandle = mkHandle();

        // Point of interest — orange flag pointing right, between handles
        // and playhead. Drawn as a <g> so position updates are cheap.
        // Draggable: emits 'poi-drag' live and 'poi-change' on release so
        // KinesaApp can shift slaves by Δ to preserve their relative
        // alignment.
        this.#poiMark = this.#svg.append('g')
            .attr('class', 'kinesa-timeline-poi')
            .style('cursor', 'ew-resize')
            .style('display', 'none');
        this.#poiMark.append('line')
            .attr('y1', 2).attr('y2', H - 2)
            .attr('stroke', COLORS.poi)
            .attr('stroke-width', 2)
            .attr('stroke-opacity', 0.9)
            .style('pointer-events', 'none');
        this.#poiMark.append('path')        // bigger 14×12 triangle (drag target)
            .attr('class', 'kinesa-timeline-poi-flag')
            .attr('d', 'M 0 2 L 14 8 L 0 14 Z')
            .attr('fill', COLORS.poi)
            .attr('stroke', 'white')
            .attr('stroke-width', 1);

        // Secondary POI knobs (one per non-active take). Group lives under
        // the playhead in z-order so the playhead always wins clicks.
        this.#secondaryGroup = this.#svg.append('g')
            .attr('class', 'kinesa-timeline-secondary-pois');

        // Hover label — single SVG <g> reused for all knobs. Hidden until
        // mouse enters a knob. Z-order: top of the SVG so it floats above
        // the band/track/playhead.
        this.#secondaryLabel = this.#svg.append('g')
            .attr('class', 'kinesa-timeline-spoi-label')
            .style('pointer-events', 'none')
            .style('display', 'none');
        this.#secondaryLabel.append('rect')
            .attr('rx', 3)
            .attr('y', -22).attr('height', 18)
            .attr('fill', COLORS.label);
        this.#secondaryLabel.append('text')
            .attr('y', -9)
            .attr('text-anchor', 'middle')
            .attr('fill', 'white')
            .attr('font-size', '11px')
            .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace');

        // Playhead — topmost, drag to scrub
        this.#playhead = this.#svg.append('circle')
            .attr('class', 'kinesa-timeline-playhead')
            .attr('cy', midY)
            .attr('r', PLAYHEAD_R)
            .attr('fill',   COLORS.playhead)
            .attr('stroke', 'white')
            .attr('stroke-width', 2)
            .style('cursor', 'pointer');

        this.#bindInteractions();
        this.#updateWindow();
        this.#updatePlayhead();
        this.#updatePoi();
        this.#renderSecondaryPois();
    }

    #updatePlayhead() {
        if (!this.#playhead || !this.#x) return;
        this.#playhead.attr('cx', this.#x(this.#currentFrame));
    }

    #updatePoi() {
        if (!this.#poiMark || !this.#x) return;
        if (this.#poi == null) {
            this.#poiMark.style('display', 'none');
            return;
        }
        this.#poiMark
            .attr('transform', `translate(${this.#x(this.#poi)}, 0)`)
            .style('display', '');
    }

    #renderSecondaryPois() {
        if (!this.#secondaryGroup || !this.#x) return;
        const self = this;
        const H    = this.#height;
        const midY = H / 2;
        const apexY = midY + TRACK_H / 2;   // bottom edge of the track

        const sel = this.#secondaryGroup.selectAll('g.kinesa-timeline-spoi')
            .data(this.#secondaryPois, d => d.id);

        sel.exit().remove();

        const enter = sel.enter().append('g')
            .attr('class', 'kinesa-timeline-spoi')
            .style('cursor', 'ew-resize');

        // Top-half guide line: from the top of the slider down to the
        // track's bottom edge, where the triangle's apex meets it. Lets
        // the user read a slave's frame even when several knobs cluster
        // (the lines stay distinguishable above the triangle pile).
        enter.append('line')
            .attr('class', 'kinesa-timeline-spoi-line')
            .attr('y1', 2).attr('y2', apexY)
            .attr('stroke-width', 1.5)
            .attr('stroke-opacity', 0.6)
            .style('pointer-events', 'none');

        // Drag handle: 14×11 upward triangle below the track. Apex points
        // at the slider track (the slave's frame on the master timeline);
        // base is at the slider's bottom edge — easy to grab.
        enter.append('path')
            .attr('class', 'kinesa-timeline-spoi-flag')
            .attr('d', `M 0 ${apexY} L -7 ${H - 2} L 7 ${H - 2} Z`)
            .attr('stroke', 'white')
            .attr('stroke-width', 1);

        // Hover label: shows above the knob with `Δ {offset}f`. Native
        // <title> tooltip would also work but takes ~1s to appear; this
        // is instant and visually consistent with the slider.

        const merged = enter.merge(sel);
        merged.attr('transform', d => `translate(${self.#x(d.frame)}, 0)`);
        merged.select('line').attr('stroke', d => d.color);
        merged.select('path').attr('fill',   d => d.color);

        // Hover bridge: enter shows the label, leave hides it. Re-bound
        // on every render since merged includes new entries.
        merged
            .on('mouseenter', (_e, d) => self.#showSecondaryPoiLabel(d))
            .on('mouseleave', ()      => self.#hideSecondaryPoiLabel());

        const drag = d3.drag()
            .on('start', function () {
                self.#dragRect = self.#svg.node().getBoundingClientRect();
                self.#hideSecondaryPoiLabel();
                self.trigger('scrub', { active: true });
            })
            .on('drag', function (e, d) {
                const px = e.sourceEvent.clientX - self.#dragRect.left;
                const f  = Math.round(self.#x.invert(px));
                d.frame  = clamp(f, self.#firstFrame, self.#lastFrame);
                d3.select(this).attr('transform', `translate(${self.#x(d.frame)}, 0)`);
                self.trigger('secondary-poi-drag', { id: d.id, frame: d.frame });
            })
            .on('end', function (e, d) {
                self.trigger('secondary-poi-change', { id: d.id, frame: d.frame });
                self.trigger('scrub', { active: false });
            });

        merged.call(drag);
    }

    #updateWindow() {
        if (!this.#band || !this.#x) return;
        const xL = this.#x(this.#rangeStart);
        const xR = this.#x(this.#rangeEnd);
        const hasWindow = this.getRange() != null;

        this.#band
            .attr('x', xL)
            .attr('width', Math.max(0, xR - xL))
            .attr('fill-opacity', hasWindow ? 0.35 : 0);

        this.#leftHandle
            .attr('x', xL - HANDLE_W / 2)
            .style('display', hasWindow ? '' : 'none');
        this.#rightHandle
            .attr('x', xR - HANDLE_W / 2)
            .style('display', hasWindow ? '' : 'none');

        // When no window is set, we still need a way to *create* one.
        // Show two subtle grip marks at the extremes so the user can grab them.
        // Implemented as making the handles always visible but near-invisible
        // when range is null — use low opacity instead of display:none.
        if (!hasWindow) {
            this.#leftHandle .style('display', '').attr('fill-opacity', 0.45);
            this.#rightHandle.style('display', '').attr('fill-opacity', 0.45);
        } else {
            this.#leftHandle .attr('fill-opacity', 1);
            this.#rightHandle.attr('fill-opacity', 1);
        }
    }

    #bindInteractions() {
        const self = this;

        // ── Scrub on track / band / playhead click+drag ──────────────────
        let scrubRect = null;
        const scrubFromClientX = (clientX) => {
            const px = clientX - scrubRect.left;
            const f  = Math.round(self.#x.invert(px));
            self.#currentFrame = clamp(f, self.#firstFrame, self.#lastFrame);
            self.#updatePlayhead();
            self.trigger('seek', { frame: self.#currentFrame });
        };

        const scrubDrag = d3.drag()
            .on('start', (e) => {
                scrubRect = self.#svg.node().getBoundingClientRect();
                self.trigger('scrub', { active: true });
                scrubFromClientX(e.sourceEvent.clientX);
            })
            .on('drag', (e) => scrubFromClientX(e.sourceEvent.clientX))
            .on('end',  ()  => self.trigger('scrub', { active: false }));

        self.#svg.selectAll('.kinesa-timeline-track, .kinesa-timeline-band').call(scrubDrag);

        // Playhead drag: same as scrub (pointer tracks through the playhead)
        self.#playhead.call(scrubDrag);

        // ── Handle drag ──────────────────────────────────────────────────
        let handleRect = null;
        const handleDrag = (which) => d3.drag()
            .on('start', () => {
                handleRect = self.#svg.node().getBoundingClientRect();
            })
            .on('drag', (e) => {
                const px = e.sourceEvent.clientX - handleRect.left;
                const f  = Math.round(self.#x.invert(px));
                if (which === 'left') {
                    self.#rangeStart = clamp(f, self.#firstFrame, self.#rangeEnd - 1);
                } else {
                    self.#rangeEnd   = clamp(f, self.#rangeStart + 1, self.#lastFrame);
                }
                self.#updateWindow();
                // Live emission: stats + playback confinement track the drag
                self.trigger('range-change', self.getRange());
            })
            .on('end', () => {
                // Final commit (same payload as last 'drag' tick, guarantees settled state)
                self.trigger('range-change', self.getRange());
            });

        self.#leftHandle .call(handleDrag('left'));
        self.#rightHandle.call(handleDrag('right'));

        // ── Master POI drag ─────────────────────────────────────────────
        // Dragging the orange flag re-positions the master's point-of-
        // interest. Live 'poi-drag' lets KinesaApp shift slave knobs by
        // the same Δ in real-time so their relative alignment is
        // preserved; the final 'poi-change' commits.
        // 'scrub' events bracket the drag so playback pauses at start
        // and stays paused at end (handled in KinesaApp).
        let poiRect = null;
        const poiDrag = d3.drag()
            .on('start', () => {
                poiRect = self.#svg.node().getBoundingClientRect();
                self.trigger('scrub', { active: true});
            })
            .on('drag', (e) => {
                const px = e.sourceEvent.clientX - poiRect.left;
                const f  = Math.round(self.#x.invert(px));
                self.#poi = clamp(f, self.#firstFrame, self.#lastFrame);
                self.#updatePoi();
                self.trigger('poi-drag', self.#poi);
            })
            .on('end', () => {
                self.trigger('poi-change', self.#poi);
                self.trigger('scrub', { active: false});
            });
        self.#poiMark.call(poiDrag);

        // ── Double-click ─────────────────────────────────────────────────
        // Smart routing based on click location:
        //   - inside the active window  → reset the window
        //   - on the existing POI frame → clear POI (toggle off)
        //   - elsewhere                  → set POI at the clicked frame
        self.#svg.on('dblclick', (e) => {
            const rect = self.#svg.node().getBoundingClientRect();
            const px   = e.clientX - rect.left;
            const f    = Math.round(self.#x.invert(px));
            if (!Number.isFinite(f)) return;

            const inWindow = self.getRange() != null
                && f >= self.#rangeStart && f <= self.#rangeEnd;

            if (inWindow) {
                self.#rangeStart = self.#firstFrame;
                self.#rangeEnd   = self.#lastFrame;
                self.#updateWindow();
                self.trigger('range-change', null);
            } else if (self.#poi === f) {
                self.setPoi(null);
                self.trigger('poi-change', null);
            } else {
                self.setPoi(f);
                self.trigger('poi-change', f);
            }
        });
    }

    /** Show the hover label above the given knob datum. Format:
     *  `<name>  Δ {offset}f` (or just the master frame if offset is 0). */
    #showSecondaryPoiLabel(d) {
        if (!this.#secondaryLabel || !this.#x) return;
        const offset = Number.isFinite(d.offset) ? d.offset : 0;
        const sign   = offset > 0 ? '+' : '';
        const lock   = d.locked ? ' 🔒' : '';
        const text   = offset
            ? `${d.name || d.id} · Δ ${sign}${offset}f${lock}`
            : `${d.name || d.id} · master${lock}`;

        const label = this.#secondaryLabel;
        const txt   = label.select('text').text(text);
        // Size the rect to the text + padding; center on the knob's X.
        const bb    = txt.node().getBBox();
        const pad   = 6;
        label.select('rect')
            .attr('x', bb.x - pad)
            .attr('width', bb.width + pad * 2);
        label.attr('transform', `translate(${this.#x(d.frame)}, 0)`)
            .style('display', '');
    }

    #hideSecondaryPoiLabel() {
        if (this.#secondaryLabel) this.#secondaryLabel.style('display', 'none');
    }
}
