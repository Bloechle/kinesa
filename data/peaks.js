/**
 * peaks.js — Peak analysis over time series.
 *
 * Two pure primitives shared by alignment (GraphsModel) and the load
 * probe (Probe):
 *
 *   firstSignificantPeak(series, getter, { fraction })
 *     The JS port of the Python pipeline's `find_event_first_peak`
 *     (MOCAP_ANALYSIS_GUIDE.md): instead of the global maximum, return
 *     the FIRST local maximum whose |value| reaches `fraction` of the
 *     global max. Some striking gestures (slap shot, golf drive) carry
 *     two near-equal peaks ~50-80 ms apart; aligning on the global max
 *     picks whichever is marginally higher per take, which flickers
 *     between takes. The first significant peak is stable — and for
 *     single-peak gestures it degenerates to the global max, so it is
 *     a safe default.
 *
 *   countSignificantPeaks(values, { threshold, minGapSamples })
 *     Number of distinct local maxima reaching `threshold` of the
 *     global max, at least `minGapSamples` apart. Feeds the probe
 *     signature (burst / cyclic / static).
 *
 * Both are NaN-tolerant: non-finite samples are skipped, and "local
 * maximum" is judged against the adjacent FINITE samples (so a peak
 * beside a tracking gap still counts).
 */

/** Collect { idx, v: |value| } for every finite sample. */
const finitePoints = (n, valueAt) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
        const v = valueAt(i);
        if (v != null && isFinite(v)) pts.push({ idx: i, v: Math.abs(v) });
    }
    return pts;
};

/** Local maximum within the compact finite sequence (ties count). */
const isLocalMax = (pts, k) =>
    (k === 0              || pts[k].v >= pts[k - 1].v) &&
    (k === pts.length - 1 || pts[k].v >= pts[k + 1].v);

/**
 * First local maximum reaching `fraction` of the global |max|.
 *
 * @param {Array}    series  array of point objects (e.g. cached metric points)
 * @param {Function} getter  point → numeric value (may return null/NaN)
 * @param {object}   [opts]
 * @param {number}   [opts.fraction=0.80]  significance threshold vs global max
 * @returns {{ point, index, value }|null}  the winning series point, its
 *          index in `series`, and its |value| — or null if nothing finite
 */
export function firstSignificantPeak(series, getter, { fraction = 0.80 } = {}) {
    const pts = finitePoints(series.length, i => getter(series[i]));
    if (!pts.length) return null;

    let gmaxK = 0;
    for (let k = 1; k < pts.length; k++) if (pts[k].v > pts[gmaxK].v) gmaxK = k;
    const thr = fraction * pts[gmaxK].v;

    for (let k = 0; k < pts.length; k++) {
        if (pts[k].v >= thr && isLocalMax(pts, k)) {
            return { point: series[pts[k].idx], index: pts[k].idx, value: pts[k].v };
        }
    }
    // Unreachable in practice (the global max is itself a qualifying local
    // max), kept as a guard against degenerate getters.
    return { point: series[pts[gmaxK].idx], index: pts[gmaxK].idx, value: pts[gmaxK].v };
}

/**
 * Count distinct significant local maxima.
 *
 * @param {Array<number>} values  numeric samples (non-finite skipped)
 * @param {object}  [opts]
 * @param {number}  [opts.threshold=0.5]      significance vs global |max|
 * @param {number}  [opts.minGapSamples=1]    min distance between counted peaks
 * @returns {number}
 */
export function countSignificantPeaks(values, { threshold = 0.5, minGapSamples = 1 } = {}) {
    const pts = finitePoints(values.length, i => values[i]);
    if (!pts.length) return 0;

    let gmax = 0;
    for (const p of pts) if (p.v > gmax) gmax = p.v;
    if (gmax <= 0) return 0;
    const thr = threshold * gmax;

    let count = 0, lastIdx = -Infinity;
    for (let k = 0; k < pts.length; k++) {
        if (pts[k].v >= thr && isLocalMax(pts, k) && pts[k].idx - lastIdx >= minGapSamples) {
            count++;
            lastIdx = pts[k].idx;
        }
    }
    return count;
}

/**
 * Check a proximal→distal peak sequence for kinetic-chain order.
 *
 * @param {Array<{label: string, time: number}>} entries  proximal-first
 * @returns {{ ordered: boolean, inversions: string[] }}  inversions are
 *          human-readable, e.g. "Chest peaks before Hip"
 */
export function orderCascade(entries) {
    const inversions = [];
    for (let i = 1; i < entries.length; i++) {
        if (entries[i].time < entries[i - 1].time) {
            inversions.push(`${entries[i].label} peaks before ${entries[i - 1].label}`);
        }
    }
    return { ordered: inversions.length === 0, inversions };
}
