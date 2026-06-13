/**
 * Analysis.js — Analysis markers (POI) + snap-to-peak controller.
 *
 * Owns the verbs of the "where is the interesting moment" domain:
 *   - setMasterPoi(frame|null)  : place / clear the master POI
 *   - togglePoi()               : keyboard-friendly toggle at playhead
 *   - snapToPeak()              : per-take peak alignment via the
 *                                  focused chart metric
 *
 * Reads from / writes to:
 *   - takes.master().metadata.pointOfInterest  (single source of truth)
 *   - playback (current frame, pause, seek)
 *   - charts (findPeakPerTake)
 *   - slider (sync the orange flag)
 *
 * `onFeedback(message, kind)` gets called for user toasts so the
 * controller stays decoupled from the toast implementation.
 */

import { cascadeChain } from '../lib/skeleton.js';
import { orderCascade } from '../data/peaks.js';
import { esc }          from '../lib/html.js';

/** Proximal→distal gradient (cool proximal, hot distal). Indexed
 *  proportionally so shorter chains keep the full ramp. */
const CASCADE_COLORS = ['#2563eb', '#0ea5e9', '#10b981', '#eab308', '#f97316', '#ef4444', '#be123c'];

export class Analysis {
    #takes;
    #playback;
    #charts;
    #selection;
    #slider;
    #onFeedback;

    constructor({ takes, playback, charts, slider, selection, onFeedback }) {
        this.#selection = selection;
        this.#takes      = takes;
        this.#playback   = playback;
        this.#charts     = charts;
        this.#slider     = slider;
        this.#onFeedback = onFeedback || (() => {});
    }

    /** The master's POI (frame number) or null if none. */
    get poi() {
        const v = this.#takes.master()?.metadata?.pointOfInterest;
        return Number.isFinite(v) ? v : null;
    }

    /** Move the master's POI to an absolute frame (or null to clear).
     *  Persists into master metadata, syncs the slider flag — but does
     *  NOT touch ROI or seek the playhead. The one entry point for any
     *  code that wants to "place the POI". */
    setMasterPoi(frame) {
        if (!this.#playback.frameData?.length) return;
        const valid = Number.isFinite(frame) ? frame : null;
        this.#slider?.setPoi(valid);
        const master = this.#takes.master();
        if (!master?.metadata) return;
        if (valid == null) delete master.metadata.pointOfInterest;
        else               master.metadata.pointOfInterest = valid;
    }

    /** Toggle the POI at the current playhead. Same frame → clear; new
     *  frame → set. Keyboard hook for `P`. */
    togglePoi() {
        const fd = this.#playback.frameData?.[this.#playback.currentFrame];
        const currentAbs = fd?.frame;
        if (!Number.isFinite(currentAbs)) return;
        if (this.poi === currentAbs) {
            this.setMasterPoi(null);
            this.#onFeedback('POI cleared', 'info');
        } else {
            this.setMasterPoi(currentAbs);
            this.#onFeedback(`POI set at frame ${currentAbs}`, 'success');
        }
    }

    /** Snap-to-peak: find the per-take peaks of the focused chart
     *  metric, set each take's POI to its own peak frame, and re-align
     *  every unlocked slave so all peaks land on the master's peak.
     *  The playhead seeks to the master's peak; ROI is left untouched. */
    /** Cascade view: select the proximal→distal chain routed from the
     *  master's dominant bone (probe), colour it cool→hot, plot every
     *  node's speed on one fresh graph, and report the peak order — the
     *  kinetic-chain energy transfer reads as a left-to-right peak
     *  progression. */
    cascade() {
        const master = this.#takes.master();
        if (!master?.frameData?.length) {
            this.#onFeedback('Cascade: load a take first', 'warn');
            return;
        }
        const dominant = master.probe?.dominant?.node || 'RHand';
        const wanted   = cascadeChain(dominant);

        // Pick the skeleton object carrying the most chain nodes.
        const frame = master.frameData[0];
        let objName = null, chain = [];
        for (const o in frame.objects) {
            const present = wanted.filter(n => frame.objects[o][n]);
            if (present.length > chain.length) { chain = present; objName = o; }
        }
        if (chain.length < 3) {
            this.#onFeedback('Cascade: no skeleton chain found in the master take', 'warn');
            return;
        }

        // Swap the selection for the chain, proximal cool → distal hot.
        const type = master.metadata?.objects?.[objName]?.type || 'undefined';
        const last = Math.max(1, chain.length - 1);
        this.#selection.clear();
        chain.forEach((n, i) => this.#selection.add(master.id, objName, n, type,
            CASCADE_COLORS[Math.round(i * (CASCADE_COLORS.length - 1) / last)]));

        const peaks = this.#charts?.plotCascade?.(master.id, objName, chain) || [];
        if (!peaks.length) return;

        const side = /^L/.test(dominant) ? 'left' : 'right';
        const seq  = peaks.map(p => `${esc(p.node)} ${p.time.toFixed(2)}s`).join(' → ');
        const { ordered, inversions } = orderCascade(
            peaks.map(p => ({ label: esc(p.node), time: p.time })));   // esc: labels flow into the HTML toast
        this.#onFeedback(
            ordered ? `Cascade (${side}): ${seq} — proximal→distal ✓`
                    : `Cascade (${side}): ${seq} — ${inversions[0]} ⚠`,
            ordered ? 'success' : 'warn', 8000);
    }

    snapToPeak() {
        if (!this.#playback.frameData?.length) return;
        const peaks = this.#charts?.findPeakPerTake?.() || [];
        if (!peaks.length) {
            this.#onFeedback('Snap: select at least one node and one metric first', 'warn');
            return;
        }

        if (this.#playback.isPlaying) this.#playback.togglePlayPause();

        const masterId = this.#takes.masterId();
        let masterPeak = null;
        for (const p of peaks) {
            const take = this.#takes.byId(p.takeId);
            if (!take?.metadata) continue;
            take.metadata.pointOfInterest = p.frame;
            if (p.takeId === masterId) masterPeak = p;
        }
        this.#takes.realignAllSlavesByPoi();

        if (masterPeak) {
            this.setMasterPoi(masterPeak.frame);
            this.#playback.setFrame(masterPeak.frameIndex);
        }

        if (peaks.length === 1) {
            const p = peaks[0];
            this.#onFeedback(
                `Peak ${p.metricLabel}: ${esc(p.nodeName)} · ${p.value.toFixed(2)} ${p.unit} @ frame ${p.frame}`,
                'success');
        } else {
            const ref = peaks[0];
            this.#onFeedback(
                `Peak aligned: ${peaks.length} takes on ${esc(ref.nodeName)} · ${ref.metricLabel}`,
                'success');
        }
    }
}
