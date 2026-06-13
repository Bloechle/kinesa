/**
 * Probe.js — Quick gesture probe at load time.
 *
 * Scans body-wide peak speeds and surfaces a 1-line answer to the
 * question "what is this take about?" — pedagogical orientation for
 * workshop participants and a hint for which node to select first.
 *
 * Pure function over the processed frame data; no state, no DOM.
 */

import { OBJECT_NAMES } from '../lib/object-types.js';
import { countSignificantPeaks } from './peaks.js';

const SKIP_OBJECTS = new Set([OBJECT_NAMES.UNLABELED]);   // markers are noisy, skip wholesale

/**
 * Compute a quick probe of dominant motion across the take.
 *
 * @param {Array}  frames    processed frames (must have smoothed `speed[3]`)
 * @param {object} metadata  parsed metadata (used for fps + duration)
 * @returns {object|null}    { dominant, topThree, duration, fps } or null
 */
export function computeProbe(frames, metadata) {
    if (!frames?.length) return null;

    const fps      = Number(metadata?.frameRate) || 30;
    const duration = frames.length / fps;

    // Per-(object, node) peak speed magnitude — track the frame where it occurs
    const peaks = {};
    frames.forEach((frame, fi) => {
        const objs = frame?.objects;
        if (!objs) return;
        for (const obj in objs) {
            if (SKIP_OBJECTS.has(obj)) continue;
            const nodes = objs[obj];
            for (const node in nodes) {
                const sp = nodes[node]?.speed?.[3];
                if (sp == null || !isFinite(sp)) continue;

                const key = `${obj}:${node}`;
                const e   = peaks[key];
                if (!e || sp > e.peak) {
                    peaks[key] = {
                        object: obj, node, peak: sp,
                        frame: frame.frame ?? fi,
                        frameIndex: fi,
                        time: frame.time ?? (fi / fps),
                    };
                }
            }
        }
    });

    const ranked = Object.values(peaks).sort((a, b) => b.peak - a.peak);
    if (!ranked.length) return null;

    return {
        dominant: ranked[0],
        topThree: ranked.slice(0, 3),
        signature: computeSignature(frames, ranked[0], fps),
        duration,
        fps,
    };
}

/**
 * One-word gesture signature from the dominant node's speed curve —
 * heuristic thresholds, tuned on the reference gestures:
 *
 *   static  peak/median < 2     speed never rises far above baseline
 *                               (handstand, held balance)
 *   cyclic  ≥3 significant peaks repeated strides / strokes
 *                               (running, skating, rowing)
 *   burst   otherwise           one or two sharp events
 *                               (strike, throw, jump)
 *
 * Downstream this can route small choices (alignment window shape,
 * smoothing strength) without asking the user for the gesture type.
 *
 * @returns {{ kind, ratio, peakCount }|null}
 */
function computeSignature(frames, dominant, fps) {
    const speeds = frames.map(
        f => f?.objects?.[dominant.object]?.[dominant.node]?.speed?.[3]);
    const finite = speeds.filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
    if (finite.length < 10) return null;

    const median    = finite[Math.floor(finite.length / 2)];
    const ratio     = dominant.peak / Math.max(median, 1e-6);
    const peakCount = countSignificantPeaks(speeds, {
        threshold: 0.5,
        minGapSamples: Math.max(1, Math.round(fps * 0.15)),   // ≥150 ms apart
    });

    const kind = ratio < 2 ? 'static' : peakCount >= 3 ? 'cyclic' : 'burst';
    return { kind, ratio, peakCount };
}
