/**
 * Smoother.js - Gaussian smoothing for velocity and acceleration signals
 *
 * Reflective edge padding. Separate sigma: speed=4.0, accel=5.0.
 * Window size capped at min(101, ceil(fps/3)).
 */

import { forEachNode } from './frame-utils.js';

export class Smoother {
    constructor() {
        this.processingConfig = {
            timeWindows: { speed: 800, accel: 1000 },
            sigma:       { speed: 4.0, accel: 5.0 },
        };
    }

    configureSmoothingWindows(frameRate) {
        const { timeWindows } = this.processingConfig;
        const toOdd = n => n % 2 === 0 ? n + 1 : n;

        return {
            speedWindowSize: toOdd(Math.max(11, Math.ceil((frameRate * timeWindows.speed) / 1000))),
            accelWindowSize: toOdd(Math.max(13, Math.ceil((frameRate * timeWindows.accel) / 1000))),
        };
    }

    smoothAllData(frames, frameRate) {
        const cfg = this.configureSmoothingWindows(frameRate);

        this._smoothVectorValues(frames, 'rawSpeed', 'speed', cfg.speedWindowSize, this.processingConfig.sigma.speed);
        this._smoothAccelerationValues(frames, 'rawAccel', 'accel', cfg.accelWindowSize, this.processingConfig.sigma.accel);

        return frames;
    }

    // ── Private ─────────────────────────────────────────────

    _smoothVectorValues(frames, src, dst, windowSize, sigma) {
        for (const { objName, nodeName } of this._getUniqueNodes(frames)) {
            for (let axis = 0; axis < 4; axis++) {
                const entries = [];
                for (let i = 0; i < frames.length; i++) {
                    const raw = frames[i]?.objects?.[objName]?.[nodeName]?.[src];
                    if (Array.isArray(raw) && raw.length > axis) entries.push({ i, v: raw[axis] });
                }

                if (entries.length < 5) continue;
                const smoothed = this._applyGaussianSmooth(entries.map(e => e.v), windowSize, sigma);

                for (let k = 0; k < entries.length; k++) {
                    const nd = frames[entries[k].i].objects[objName][nodeName];
                    if (!nd[dst]) nd[dst] = [0, 0, 0, 0];
                    nd[dst][axis] = smoothed[k];
                }
            }
        }
    }

    _smoothAccelerationValues(frames, src, dst, windowSize, sigma) {
        for (const { objName, nodeName } of this._getUniqueNodes(frames)) {
            const entries = [];
            for (let i = 0; i < frames.length; i++) {
                const v = frames[i]?.objects?.[objName]?.[nodeName]?.[src];
                if (v !== undefined) entries.push({ i, v });
            }

            if (entries.length < 5) continue;
            const smoothed = this._applyGaussianSmooth(entries.map(e => e.v), windowSize, sigma);

            for (let k = 0; k < entries.length; k++) {
                frames[entries[k].i].objects[objName][nodeName][dst] = smoothed[k];
            }
        }
    }

    _applyGaussianSmooth(data, windowSize, sigma) {
        if (!data || data.length < 3) return data;

        const win = Math.min(data.length - 1, windowSize % 2 === 0 ? windowSize + 1 : windowSize);
        const half = Math.floor(win / 2);

        // Build normalised kernel
        const kernel = [];
        let kSum = 0;
        for (let i = -half; i <= half; i++) {
            const w = Math.exp(-(i * i) / (2 * sigma * sigma));
            kernel.push(w);
            kSum += w;
        }
        for (let i = 0; i < kernel.length; i++) kernel[i] /= kSum;

        // Apply
        return data.map((_, i) => {
            let sum = 0, wSum = 0;
            for (let j = -half; j <= half; j++) {
                const idx = i + j;
                if (idx >= 0 && idx < data.length) {
                    sum  += data[idx] * kernel[j + half];
                    wSum += kernel[j + half];
                }
            }
            return wSum > 0 ? sum / wSum : data[i];
        });
    }

    _getUniqueNodes(frames) {
        const seen = new Set();
        const result = [];
        forEachNode(frames, (_, { objectName, nodeName }) => {
            const key = `${objectName}:${nodeName}`;
            if (!seen.has(key)) { seen.add(key); result.push({ objName: objectName, nodeName }); }
        });
        return result;
    }
}
