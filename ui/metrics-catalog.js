/**
 * Metrics.js — Chart metrics catalog + per-node series extraction.
 *
 * METRICS is the set of plottable quantities a node can produce. Each
 * entry is { id, label, desc, name, component }:
 *   - id        unique key used in the graph series model
 *   - label     compact tag rendered on chart chips ("Py", "‖V‖", "θ↑"…)
 *   - desc      tooltip / human description
 *   - name      property name in the per-node cache (`pos`, `speed`, …)
 *   - component when the cache stores a 4-vector (xyz + magnitude),
 *               which index this metric reads. `null` for scalar caches
 *               that store `{ value }` per frame.
 *   - appliesTo (optional) predicate gating the metric's chip on
 *               (node, takeMetadata) — e.g. X-factor only on Hip + Chest
 *               skeletons.
 *
 * UNITS maps cache-property names to display units, used both for chart
 * Y-axis labelling and for CSV column headers.
 *
 * extractTakeNodeSeries(take, objectName, nodeName) reads a take's raw
 * frames and returns { pos, speed, speedH, accel, angle, upAngle,
 * angSpeed, xfactor } — each an array of point objects with `frame`,
 * `frameIndex`, `time`, plus either { 0, 1, 2[, 3] } (vector) or
 * { value } (scalar). The function is pure (no side effects on the
 * take); ChartWidget caches the result by composite take/node key.
 */

import { OBJECT_TYPES, JOINT_NAMES } from '../lib/object-types.js';

export const METRICS = [
    { id: 'pos-y',     label: 'Py',  desc: 'Position Y',     name: 'pos',      component: 1    },
    { id: 'pos-x',     label: 'Px',  desc: 'Position X',     name: 'pos',      component: 0    },
    { id: 'pos-z',     label: 'Pz',  desc: 'Position Z',     name: 'pos',      component: 2    },
    { id: 'speed-mag', label: '‖V‖', desc: 'Speed',          name: 'speed',    component: 3    },
    { id: 'speed-h',   label: 'V↔',  desc: 'Speed (horiz.)', name: 'speedH',   component: null },
    { id: 'speed-x',   label: 'Vx',  desc: 'Velocity X',     name: 'speed',    component: 0    },
    { id: 'speed-y',   label: 'Vy',  desc: 'Velocity Y',     name: 'speed',    component: 1    },
    { id: 'speed-z',   label: 'Vz',  desc: 'Velocity Z',     name: 'speed',    component: 2    },
    { id: 'accel-mag', label: '‖A‖', desc: 'Acceleration',   name: 'accel',    component: 3    },
    { id: 'angSpeed',  label: 'ω',   desc: 'Angular speed',  name: 'angSpeed', component: null },
    { id: 'angle',     label: 'θ',   desc: 'Node angle',     name: 'angle',    component: null },
    { id: 'upAngle',   label: 'θ↑',  desc: 'Up angle',       name: 'upAngle',  component: null },
    {
        id: 'xfactor', label: 'Xf', desc: 'X-factor (trunk yaw − pelvis yaw)',
        name: 'xfactor', component: null,
        appliesTo: (node, metadata) => {
            if (!node || node.objectType !== OBJECT_TYPES.SKELETON) return false;
            if (!JOINT_NAMES.HIP.test(node.nodeName)) return false;
            const skel = metadata?.objects?.[node.objectName];
            return !!skel?.nodes?.some(n => JOINT_NAMES.CHEST.test(n));
        },
    },
];

export const UNITS = {
    pos:      'm',     speed:   'm/s',  speedH:  'm/s',
    accel:    'm/s²',  angle:   'deg',  upAngle: 'deg',
    angSpeed: '°/s',   xfactor: 'deg',
};

export const DEFAULT_METRIC = 'pos-y';

export const metricById = id => METRICS.find(m => m.id === id);

/** Yaw (rad) via YXZ-Euler. q = [x,y,z,w]. */
function yawFromQuat(q) {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    return Math.atan2(2 * (x * z + y * w), 1 - 2 * (x * x + y * y));
}

/** Re-export the shared 3-part composite key helper for callers that
 *  imported `fullKey` from this module. New code should import
 *  `nodeKey` from `lib/object-types.js` directly. */
export { nodeKey as fullKey } from '../lib/object-types.js';

/**
 * Build the per-property series cache for a (take × object × node) tuple.
 * Reads `take.frameData` raw and returns one { pos, speed, … } object.
 *
 * Caller is responsible for caching — this function recomputes from
 * scratch each call. ChartWidget caches by `fullKey()` and invalidates
 * by take.
 */
export function extractTakeNodeSeries(take, objectName, nodeName) {
    const frames = take?.frameData;
    if (!frames?.length) return null;

    const cache = {
        pos: [], speed: [], speedH: [],
        accel: [], angle: [], upAngle: [],
        angSpeed: [], xfactor: [],
    };
    const startFrame = take.metadata?.firstFrame || frames[0].frame || 0;
    const fps        = take.sourceFrameRate;

    // Angular speed from successive quaternion deltas, smoothed by a
    // 3-tap moving average. Skipped (null) when either side has no quat
    // or dt collapses near zero.
    const angRaw = new Array(frames.length).fill(null);
    for (let i = 1; i < frames.length; i++) {
        const cQuat = frames[i]    ?.objects?.[objectName]?.[nodeName]?.quat;
        const pQuat = frames[i - 1]?.objects?.[objectName]?.[nodeName]?.quat;
        const dt = (frames[i]?.time ?? i / fps) - (frames[i - 1]?.time ?? (i - 1) / fps);
        if (!cQuat || !pQuat || Math.abs(dt) < 1e-4) continue;
        const dot = pQuat[0]*cQuat[0] + pQuat[1]*cQuat[1] + pQuat[2]*cQuat[2] + pQuat[3]*cQuat[3];
        const ang = 2 * Math.acos(Math.min(1, Math.abs(dot)));
        angRaw[i] = (ang / dt) * 180 / Math.PI;
    }
    // Smooth angRaw with a 3-tap moving average. Branchless inline sum
    // avoids the 1000s of [a,b,c].filter() array allocations the prior
    // implementation did on long takes.
    const angSm = new Array(angRaw.length).fill(null);
    for (let i = 0; i < angRaw.length; i++) {
        const a = angRaw[i - 1], b = angRaw[i], c = angRaw[i + 1];
        let sum = 0, n = 0;
        if (a != null) { sum += a; n++; }
        if (b != null) { sum += b; n++; }
        if (c != null) { sum += c; n++; }
        if (n) angSm[i] = sum / n;
    }

    // X-factor (trunk yaw − pelvis yaw) only when this node IS the hip
    // of a skeleton that also carries a Chest. Unwrapped to avoid 360°
    // jumps mid-curve.
    const isHip = take.metadata?.objects?.[objectName]?.type === OBJECT_TYPES.SKELETON
               && JOINT_NAMES.HIP.test(nodeName);
    let chestKey = null;
    if (isHip) {
        const objs = frames[0]?.objects?.[objectName] || {};
        chestKey = Object.keys(objs).find(k => JOINT_NAMES.CHEST.test(k)) || null;
    }
    let xfPrev = null;

    frames.forEach((frame, fi) => {
        const nd = frame.objects?.[objectName]?.[nodeName];
        if (!nd) return;
        const af   = frame.frame || (startFrame + fi);
        const time = frame.time ?? (af - startFrame) / fps;
        const stamp = { frame: af, frameIndex: fi, time };

        if (nd.pos) {
            cache.pos.push({ ...stamp, 0: nd.pos[0], 1: nd.pos[1], 2: nd.pos[2] });
        }
        if (nd.speed) {
            cache.speed .push({ ...stamp, 0: nd.speed[0], 1: nd.speed[1], 2: nd.speed[2], 3: nd.speed[3] });
            cache.speedH.push({ ...stamp, value: Math.hypot(nd.speed[0], nd.speed[2]) });
        }
        if (nd.accelForGraph) {
            cache.accel.push({ ...stamp, 0: nd.accelForGraph[0], 1: nd.accelForGraph[1], 2: nd.accelForGraph[2], 3: nd.accelForGraph[3] });
        } else if (nd.accel !== undefined) {
            cache.accel.push({ ...stamp, 0: 0, 1: 0, 2: 0, 3: nd.accel });
        }
        if (nd.angle   !== undefined) cache.angle  .push({ ...stamp, value: nd.angle });
        if (nd.upAngle !== undefined) cache.upAngle.push({ ...stamp, value: nd.upAngle });
        if (angSm[fi] != null)        cache.angSpeed.push({ ...stamp, value: angSm[fi] });

        if (chestKey && nd.quat) {
            const cQuat = frame.objects?.[objectName]?.[chestKey]?.quat;
            if (cQuat) {
                let raw = (yawFromQuat(cQuat) - yawFromQuat(nd.quat)) * 180 / Math.PI;
                if (xfPrev != null) {
                    let d = raw - xfPrev;
                    while (d >  180) { raw -= 360; d -= 360; }
                    while (d < -180) { raw += 360; d += 360; }
                }
                xfPrev = raw;
                cache.xfactor.push({ ...stamp, value: raw });
            }
        }
    });

    return cache;
}
