/**
 * Stats.js — Standard biomechanics reductions over cached graph series.
 * Pure functions, no state. Operates on the per-node cache shape produced
 * by ChartWidget#extractNodeData:
 *   pos      : [{ frame, frameIndex, time, 0, 1, 2 }, ...]
 *   speed    : [{ frame, frameIndex, time, 0, 1, 2, 3 }, ...]   // 3 = magnitude
 *   accel    : [{ frame, frameIndex, time, 0, 1, 2, 3 }, ...]   // 3 = magnitude
 *   angle    : [{ frame, frameIndex, time, value }, ...]        // joint angle (2-conn joints only)
 *   angSpeed : [{ frame, frameIndex, time, value }, ...]        // segment rotation speed, deg/s
 *
 * An optional `range = { startFrame, endFrame }` restricts every reduction
 * to samples whose absolute `frame` falls within [startFrame, endFrame].
 * Pass null / undefined for the full-take default.
 */

const inRange = (s, r) => !r || (s.frame >= r.startFrame && s.frame <= r.endFrame);

function peak(series, pick, range) {
    if (!series?.length) return null;
    let best = null;
    for (const s of series) {
        if (!inRange(s, range)) continue;
        const v = pick(s);
        if (v == null || !isFinite(v)) continue;
        const a = Math.abs(v);
        if (!best || a > best.value) best = { value: a, frame: s.frame, frameIndex: s.frameIndex, time: s.time };
    }
    return best;
}

function mean(series, pick, range) {
    if (!series?.length) return null;
    let sum = 0, n = 0;
    for (const s of series) {
        if (!inRange(s, range)) continue;
        const v = pick(s);
        if (v == null || !isFinite(v)) continue;
        sum += v; n++;
    }
    return n ? sum / n : null;
}

function pathLength(pos, range) {
    if (!pos || pos.length < 2) return 0;
    let d = 0, prev = null;
    for (const b of pos) {
        if (!inRange(b, range)) { prev = null; continue; }
        if (prev) {
            const dx = b[0] - prev[0], dy = b[1] - prev[1], dz = b[2] - prev[2];
            d += Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        prev = b;
    }
    return d;
}

/** Straight-line distance between the first and last in-range samples. */
function netDisplacement(pos, range) {
    if (!pos?.length) return null;
    let first = null, last = null;
    for (const p of pos) {
        if (!inRange(p, range)) continue;
        if (!first) first = p;
        last = p;
    }
    if (!first || !last || first === last) return null;
    const dx = last[0] - first[0], dy = last[1] - first[1], dz = last[2] - first[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Min, max and span of a single position component (axis: 0=x, 1=y, 2=z),
 *  along with the frame indices where the extrema occur. */
function axisRange(pos, range, axis) {
    if (!pos?.length) return null;
    let mn = Infinity, mx = -Infinity;
    let mnInfo = null, mxInfo = null;
    for (const p of pos) {
        if (!inRange(p, range)) continue;
        const v = p[axis];
        if (v == null || !isFinite(v)) continue;
        if (v < mn) { mn = v; mnInfo = { frame: p.frame, frameIndex: p.frameIndex, time: p.time }; }
        if (v > mx) { mx = v; mxInfo = { frame: p.frame, frameIndex: p.frameIndex, time: p.time }; }
    }
    if (mn === Infinity) return null;
    return { min: mn, max: mx, range: mx - mn, atMin: mnInfo, atMax: mxInfo };
}

function rangeOfMotion(angle, range) {
    if (!angle?.length) return null;
    let mn = Infinity, mx = -Infinity;
    for (const s of angle) {
        if (!inRange(s, range)) continue;
        if (s.value < mn) mn = s.value;
        if (s.value > mx) mx = s.value;
    }
    return mn === Infinity ? null : { min: mn, max: mx, rom: mx - mn };
}

/**
 * Compute all applicable standard stats for one node's cached graphData.
 *
 * Note: peakAngVel reads the per-frame `angSpeed` series (segment rotation
 * speed from quaternion change) rather than differentiating the joint
 * `angle` series. This is more general — it's defined for every bone with
 * a quaternion (including Hip / Chest / end-effectors that have no
 * meaningful joint-angle), and it measures something semantically
 * cleaner: how fast the segment itself rotates in space.
 *
 * @param {object}   cache   per-node graphData entry
 * @param {object=}  range   { startFrame, endFrame } in absolute frame numbers
 */
export function computeStats(cache, range = null) {
    return {
        peakSpeed:     peak(cache?.speed,    s => s[3],    range),
        meanSpeed:     mean(cache?.speed,    s => s[3],    range),
        peakAccel:     peak(cache?.accel,    s => s[3],    range),
        distance:      pathLength(cache?.pos, range),
        displacement:  netDisplacement(cache?.pos, range),
        verticalRange: axisRange(cache?.pos, range, 1),     // y-axis (world up)
        rom:           rangeOfMotion(cache?.angle, range),
        peakAngVel:    peak(cache?.angSpeed, s => s.value, range),
        // Derived: trunk-pelvis yaw range — only defined for Hips with a Chest.
        // Reuses rangeOfMotion since `xfactor` shares the {value} sample shape.
        xfactorRange:  rangeOfMotion(cache?.xfactor, range),
    };
}
