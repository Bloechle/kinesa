/**
 * BallDetector.js - Detects a Ball object from unlabeled markers
 *
 * Iteratively removes outliers until a consistent spherical cluster is found,
 * then creates a Ball object with a Center node.
 */

import { NODE_NAMES } from '../lib/object-types.js';

export class BallDetector {
    constructor(config = {}) {
        this.config = {
            maxDistance:     config.maxDistance     ?? 0.2,
            minMarkers:      config.minMarkers      ?? 4,
            maxIterations:   config.maxIterations   ?? 10,
            requiredDensity: config.requiredDensity ?? 0.6,
        };
    }

    detectBall(unlabeledMarkers) {
        if (!unlabeledMarkers || typeof unlabeledMarkers !== 'object') return null;

        const positions = [];
        for (const id in unlabeledMarkers) {
            if (id !== NODE_NAMES.CENTER && unlabeledMarkers[id].pos) positions.push(unlabeledMarkers[id].pos);
        }

        if (positions.length < this.config.minMarkers) return null;

        let current = [...positions];
        let center = this.calculateCenter(current);
        let removed = true;
        let iter = 0;

        while (removed && iter < this.config.maxIterations) {
            let maxDist = 0, furthestIdx = -1;
            for (let i = 0; i < current.length; i++) {
                const d = this.calculateDistance(current[i], center);
                if (d > maxDist) { maxDist = d; furthestIdx = i; }
            }

            if (maxDist > this.config.maxDistance && furthestIdx !== -1) {
                current.splice(furthestIdx, 1);
                center = this.calculateCenter(current);
            } else {
                removed = false;
            }
            iter++;
        }

        if (current.length < this.config.minMarkers) return null;
        if (current.length / positions.length < this.config.requiredDensity) return null;

        return { [NODE_NAMES.CENTER]: { pos: center } };
    }

    calculateDistance(pos1, pos2) {
        return Math.sqrt(
            (pos1[0] - pos2[0]) ** 2 +
            (pos1[1] - pos2[1]) ** 2 +
            (pos1[2] - pos2[2]) ** 2
        );
    }

    calculateCenter(positions) {
        if (!positions.length) return [0, 0, 0];
        const sum = [0, 0, 0];
        for (const p of positions) { sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; }
        return sum.map(v => v / positions.length);
    }
}
