/**
 * LegDetector.js — Detects a leg chain (3 markers) from Unlabeled markers.
 *
 * Input : frame's Unlabeled object { id: { pos:[x,y,z] }, ... }
 * Output: [id1, id2, id3] ordered top→bottom by Y, or null.
 *
 * Heuristic: the triplet whose max pairwise distance ≤ maxSpan,
 * maximising vertical span (hip–ankle) and minimising horizontal spread.
 */

import { NODE_NAMES } from '../lib/object-types.js';

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export class LegDetector {
    constructor(cfg = {}) {
        this.cfg = { maxSpan: cfg.maxSpan ?? 1.0 };
    }

    detect(unlabeled) {
        if (!unlabeled) return null;

        const pts = Object.entries(unlabeled)
            .filter(([id, n]) => id !== NODE_NAMES.CENTER && n?.pos?.length >= 3);
        if (pts.length < 3) return null;

        let best = null;
        for (let i = 0; i < pts.length; i++)
        for (let j = i + 1; j < pts.length; j++)
        for (let k = j + 1; k < pts.length; k++) {
            const trio = [pts[i], pts[j], pts[k]];
            const ps   = trio.map(([, n]) => n.pos);
            const maxD = Math.max(dist(ps[0], ps[1]), dist(ps[1], ps[2]), dist(ps[0], ps[2]));
            if (maxD > this.cfg.maxSpan) continue;

            const ys    = ps.map(p => p[1]);
            const span  = Math.max(...ys) - Math.min(...ys);
            const score = span * 2 - maxD;
            if (!best || score > best.score) {
                const sorted = trio.slice().sort((a, b) => b[1].pos[1] - a[1].pos[1]);
                best = { ids: sorted.map(([id]) => id), score };
            }
        }
        return best?.ids || null;
    }
}
