/**
 * TimelineBridge.js — Wires the timeline slider into the rest of the
 * app.
 *
 * The slider emits raw events (`scrub` / `seek` / `range-change` /
 * `poi-drag` / `poi-change` / `secondary-poi-drag` / `secondary-poi-
 * change`); this bridge translates them into mutations on `takes`,
 * `playback`, and live tweaks on `charts` (chart shifts during knob
 * drag).
 *
 * Conversely, when `takes` change or the `playback` frame ticks, the
 * bridge updates the slider's bounds, range, POI flag, secondary
 * knobs, and playhead position.
 *
 * This is the single home for "translate frame numbers between
 * coordinate spaces" math. Everywhere else in the codebase deals with
 * a take's local frames OR the master timeline; the bridge handles
 * the conversion.
 *
 * Public surface:
 *   - applyMasterUI(take)              call after the master is bound
 *   - secondaryPoiCommit()             republish slave knobs after
 *                                      offsets / POIs changed
 *
 * Construction:
 *   new TimelineBridge({ slider, takes, playback, charts, onPoiCommit })
 *
 * `onPoiCommit(frame)` is fired after the user drags+releases the
 * master flag — KinesaApp uses it to broadcast 'change' on takes
 * (chip readouts catch up).
 */

import { takeFirstFrame, takeLastFrame } from './Takes.js';
import { clamp }                        from 'qry-kit';

export class TimelineBridge {
    #slider;
    #takes;
    #playback;
    #charts;
    #onPoiCommit;

    constructor({ slider, takes, playback, charts, onPoiCommit }) {
        this.#slider      = slider;
        this.#takes       = takes;
        this.#playback    = playback;
        this.#charts      = charts;
        this.#onPoiCommit = onPoiCommit || (() => {});
        this.#bind();
    }

    /** Apply slider bounds + ROI + POI from a take's metadata. Called
     *  after the master is first bound or after a topology change that
     *  rewrote master.metadata. */
    applyMasterUI(take) {
        if (!take?.frameData?.length) return;
        const first = takeFirstFrame(take);
        const last  = takeLastFrame(take);
        this.#slider.setBounds(first, last);
        this.#slider.setRange(take.metadata?.regionOfInterest || null);
        const r = this.#slider.getRange();
        this.#charts?.setRegionOfInterest?.(r);
        this.#playback.setPlaybackRange(r);
        const poi = take.metadata?.pointOfInterest;
        const valid = Number.isFinite(poi) && poi >= first && poi <= last ? poi : null;
        this.#slider.setPoi(valid);
    }

    /** Re-publish slave knob descriptors. Call after offsets / POIs /
     *  locks change but the slider doesn't auto-rebuild. */
    secondaryPoiCommit() {
        this.#slider?.setSecondaryPois(this.#takes.secondaryPoiKnobs());
    }

    // ── Internals ──────────────────────────────────────────────

    #bind() {
        // Slider playhead tracks playback frame.
        this.#playback.on('frame', () => {
            const fd = this.#playback.frameData[this.#playback.currentFrame];
            if (fd) this.#slider.setCurrentFrame(fd.frame);
        });

        // Analysis window: range-change → graph ROI + playback confinement.
        this.#slider.on('range-change', (e) => {
            this.#charts?.setRegionOfInterest?.(e.detail);
            this.#playback.setPlaybackRange(e.detail);
        });

        // Scrub bracket: any deliberate timeline interaction pauses
        // playback at start; release stays paused (explicit space-bar
        // or play button to resume).
        this.#slider.on('scrub', (e) => {
            if (e.detail.active && this.#playback.isPlaying) {
                this.#playback.togglePlayPause();
            }
        });

        // Seek (track click / playhead drag / arrow scrub): convert
        // absolute frame → playback index.
        this.#slider.on('seek', (e) => {
            const frames = this.#playback.frameData;
            if (!frames?.length) return;
            const first = frames[0].frame ?? 0;
            this.#playback.setFrame(e.detail.frame - first);
        });

        // ── Master POI flag ─────────────────────────────────────
        // Live drag: mutate metadata directly + shift every slave by
        // Δ so relative alignment is preserved. No Takes 'change' here
        // — it would clobber the in-flight d3 drag with a slider
        // rebuild.
        this.#slider.on('poi-drag', (e) => this.#handleMasterPoiDrag(e.detail));
        // Commit: KinesaApp persists into master metadata + broadcasts
        // 'change' so chip readouts and secondary knob positions catch
        // up.
        this.#slider.on('poi-change', (e) => this.#onPoiCommit(e.detail));

        // ── Slave knob ──────────────────────────────────────────
        this.#slider.on('secondary-poi-drag',   (e) => this.#handleSlaveKnobDrag(e.detail));
        this.#slider.on('secondary-poi-change', (e) => this.#handleSlaveKnobCommit(e.detail));
    }

    #handleMasterPoiDrag(newPoi) {
        const master = this.#takes.master();
        if (!master?.metadata) return;
        const oldPoi = master.metadata.pointOfInterest;
        if (!Number.isFinite(oldPoi) || !Number.isFinite(newPoi)) return;
        const delta = newPoi - oldPoi;
        if (!delta) return;
        master.metadata.pointOfInterest = newPoi;

        // Master playhead tracks the flag — user is "showing where the
        // POI is", visible state should follow.
        this.seekToMasterFrame(newPoi);

        for (const t of this.#takes.all()) {
            if (t.id === master.id) continue;
            t.offset += delta;
            this.#charts?.shiftTakeLive?.(t.id, t.offset);
        }
        this.secondaryPoiCommit();
    }

    #handleSlaveKnobDrag({ id, frame }) {
        const offset = this.offsetForKnobAtMasterFrame(id, frame);
        if (offset == null) return;
        const take = this.#takes.byId(id);
        take.offset = offset;
        this.seekToMasterFrame(frame);
        this.#charts?.shiftTakeLive?.(take.id, take.offset);
    }

    #handleSlaveKnobCommit({ id, frame }) {
        const offset = this.offsetForKnobAtMasterFrame(id, frame);
        if (offset == null) return;
        this.#takes.setOffset(id, offset);
    }

    /** Seek the master playhead to a given absolute master-timeline
     *  frame. Clamps into [first, last] and converts to a 0-based
     *  playback index. Public so KinesaApp's setMasterPoi / @frame
     *  click can drive the playhead too. */
    seekToMasterFrame(absFrame) {
        const master = this.#takes.master();
        if (!master?.frameData?.length || !Number.isFinite(absFrame)) return;
        const first = takeFirstFrame(master);
        const last  = takeLastFrame(master);
        const clamped = clamp(absFrame, first, last);
        this.#playback.setFrame(clamped - first);
    }

    /** Compute the slave offset that places its POI at a given master-
     *  timeline frame. Returns null when slave/master lack POI. */
    offsetForKnobAtMasterFrame(takeId, masterFrame) {
        const take   = this.#takes.byId(takeId);
        const master = this.#takes.master();
        if (!take || !master) return null;
        const tPoi = take.metadata?.pointOfInterest;
        if (!Number.isFinite(tPoi)) return null;
        return (masterFrame - takeFirstFrame(master))
             - (tPoi        - takeFirstFrame(take));
    }
}
