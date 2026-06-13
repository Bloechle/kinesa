/**
 * Pipeline.js - 12-step motion data processing orchestrator
 */

import * as THREE from 'three';
import { Normalizer }   from './Normalizer.js';
import { Metrics }      from './Metrics.js';
import { Smoother }     from './Smoother.js';
import { BallDetector } from './BallDetector.js';
import { LegDetector }  from './LegDetector.js';
import { OBJECT_TYPES, OBJECT_NAMES, NODE_NAMES } from '../lib/object-types.js';
import { clamp }        from 'qry-kit';
import { forEachNode }  from './frame-utils.js';

export class Pipeline {
    constructor() {
        this.normalizer       = new Normalizer();
        this.metrics      = new Metrics();
        this.smoother     = new Smoother();
        this.ballDetector = new BallDetector();
        this.legDetector  = new LegDetector();

        this.frameData        = [];
        this.metadata         = null;
        this.sourceFrameRate  = 100;
        this.isQuaternionData = false;
        this.ballDetection    = false;
        this.legIds           = null;
    }

    processMotionData(data) {
        // Step 1: Parse & validate
        const parsed = this.normalizer.normalize(data);
        this.metadata         = parsed.metadata;
        this.frameData        = parsed.frames;
        this.sourceFrameRate  = parsed.sourceFrameRate;
        this.isQuaternionData = parsed.isQuaternionData;
        this.legIds           = null;
        this._standardizeOriginalFilename();

        // Step 2: Ball detection (optional)
        if (this.ballDetection) this._detectBalls();

        // Force quaternion mode
        this.isQuaternionData = true;
        if (this.metadata) this.metadata.rotationType = 'quaternion';

        // Step 3: Convert rotations
        this.ensureQuaternions(this.frameData);

        // Step 4-5: Velocities & accelerations
        this.metrics.calculateRawVelocities(this.frameData);
        this.metrics.calculateRawAccelerations(this.frameData);

        // Step 6: Smooth
        this.smoother.smoothAllData(this.frameData, this.sourceFrameRate);

        // Step 7-8: Angles
        this.metrics.calculateNodeAngles(this.frameData, this.metadata);
        this.metrics.calculateUpAngles(this.frameData);

        // Step 9: Edge cases
        this.metrics.handleEdgeCases(this.frameData);

        // Step 10: Adapt accel for graphs
        this.adaptAccelerationForGraphs(this.frameData);

        // Step 11: Add Euler for compatibility
        this.addEulerAngles(this.frameData);

        // Step 12: Cleanup
        this.metrics.cleanupIntermediateData(this.frameData);

        this.updateMetadataWithQuaternions();

        return { metadata: this.metadata, frames: this.frameData };
    }

    // ── Leg detection ───────────────────────────────────────

    /**
     * Detect a leg triplet from Unlabeled markers starting at frameIdx.
     * On success: locks 3 marker IDs, moves them from Unlabeled to `Leg`
     * (re-sorted Y per frame → Hip / Knee / Ankle), recomputes the
     * Unlabeled Center from the remaining free markers, and recomputes metrics.
     * @returns {boolean} true if a leg was locked.
     */
    detectLegAt(frameIdx) {
        if (!this.frameData?.length) return false;

        const start = clamp(frameIdx, 0, this.frameData.length - 1);
        let ids = null;
        for (let i = start; i < this.frameData.length; i++) {
            const u = this.frameData[i].objects?.Unlabeled;
            if (!u) continue;
            ids = this.legDetector.detect(u);
            if (ids) break;
        }
        if (!ids) return false;

        this.legIds = ids;
        this._populateLeg();
        this._recomputeMetrics();
        return true;
    }

    /** Remove the detected leg and restore its 3 markers back to Unlabeled. */
    clearLeg() {
        if (!this.legIds) return false;
        const [id1, id2, id3] = this.legIds;

        for (const frame of this.frameData) {
            const leg = frame.objects?.Leg;
            if (!leg) continue;

            frame.objects.Unlabeled ??= {};
            const u = frame.objects.Unlabeled;
            if (leg.Hip?.pos)   u[id1] = { pos: [...leg.Hip.pos]   };
            if (leg.Knee?.pos)  u[id2] = { pos: [...leg.Knee.pos]  };
            if (leg.Ankle?.pos) u[id3] = { pos: [...leg.Ankle.pos] };

            delete frame.objects.Leg;
            this._recomputeCenter(u);
        }

        if (this.metadata?.objects) {
            const unlabeledMeta = this.metadata.objects.Unlabeled;
            if (unlabeledMeta?.nodes) {
                for (const id of this.legIds) {
                    if (!unlabeledMeta.nodes.includes(id)) unlabeledMeta.nodes.push(id);
                }
            }
            delete this.metadata.objects.Leg;
        }

        this.legIds = null;
        this._recomputeMetrics();
        return true;
    }

    // ── Public metric helpers ───────────────────────────────

    ensureQuaternions(frames) {
        if (!frames?.length || this.isQuaternionData) return;

        const euler      = new THREE.Euler();
        const quaternion = new THREE.Quaternion();

        frames.forEach(frame => {
            for (const obj in frame.objects) {
                for (const node in frame.objects[obj]) {
                    const nd = frame.objects[obj][node];
                    if (!nd.rot) continue;
                    euler.set(...nd.rot.map(THREE.MathUtils.degToRad), 'XYZ');
                    quaternion.setFromEuler(euler);
                    nd.quat = [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
                }
            }
        });
    }

    addEulerAngles(frames) {
        if (!frames?.length) return;

        const euler      = new THREE.Euler();
        const quaternion = new THREE.Quaternion();

        frames.forEach(frame => {
            for (const obj in frame.objects) {
                for (const node in frame.objects[obj]) {
                    const nd = frame.objects[obj][node];
                    if (!nd.quat) continue;
                    quaternion.set(...nd.quat);
                    euler.setFromQuaternion(quaternion, 'XYZ');
                    nd.rot = [euler.x, euler.y, euler.z].map(THREE.MathUtils.radToDeg);
                }
            }
        });
    }

    adaptAccelerationForGraphs(frames) {
        forEachNode(frames, nd => {
            if (nd.accel !== undefined && typeof nd.accel === 'number' && !nd.accelForGraph) {
                nd.accelForGraph = [0, 0, 0, nd.accel];
            }
        });
        return frames;
    }

    updateMetadataWithQuaternions() {
        if (!this.metadata) return;
        this.metadata.rotationType = 'quaternion';
        if (!this.metadata.coordinates) this.metadata.coordinates = {};
        this.metadata.coordinates.quat = ['x', 'y', 'z', 'w'];
        if (!this.metadata.coordinates.pos) this.metadata.coordinates.pos = ['x', 'y', 'z'];
        if (!this.metadata.coordinates.rot) this.metadata.coordinates.rot = ['x', 'y', 'z'];
    }

    getOriginalData() { return this.normalizer.getOriginalData(); }

    // ── Private ─────────────────────────────────────────────

    _detectBalls() {
        if (!this.frameData.some(f => f.objects?.[OBJECT_NAMES.UNLABELED])) return;

        let count = 0;
        for (const frame of this.frameData) {
            const unlabeled = frame.objects?.[OBJECT_NAMES.UNLABELED];
            if (!unlabeled) continue;
            const ball = this.ballDetector.detectBall(unlabeled);
            if (ball) { frame.objects['Ball'] = ball; count++; }
        }

        if (count > 0) {
            if (!this.metadata.objects) this.metadata.objects = {};
            this.metadata.objects['Ball'] = { type: OBJECT_TYPES.MARKER, nodes: [NODE_NAMES.CENTER] };
        }
    }

    _populateLeg() {
        this.metadata.objects ??= {};
        this.metadata.objects.Leg = {
            type: OBJECT_TYPES.CHAIN,
            nodes: ['Hip', 'Knee', 'Ankle'],
            connections: [['Hip', 'Knee'], ['Knee', 'Ankle']],
        };

        // Leg IDs are no longer "free" — drop them from Unlabeled's metadata node list
        const unlabeledMeta = this.metadata.objects.Unlabeled;
        if (unlabeledMeta?.nodes) {
            unlabeledMeta.nodes = unlabeledMeta.nodes.filter(id => !this.legIds.includes(id));
        }

        // ID→joint mapping is locked at detection time (LegDetector sorts by Y once).
        // legIds[0] = Hip, legIds[1] = Knee, legIds[2] = Ankle — preserved throughout.
        const [hipId, kneeId, ankleId] = this.legIds;

        for (const frame of this.frameData) {
            const u = frame.objects?.Unlabeled;
            if (!u) { if (frame.objects) delete frame.objects.Leg; continue; }

            const hip   = u[hipId];
            const knee  = u[kneeId];
            const ankle = u[ankleId];
            if (!hip?.pos || !knee?.pos || !ankle?.pos) {
                delete frame.objects.Leg;
                continue;
            }

            frame.objects.Leg = {
                Hip:   { pos: [...hip.pos]   },
                Knee:  { pos: [...knee.pos]  },
                Ankle: { pos: [...ankle.pos] },
            };

            // Move: remove from Unlabeled and recompute Center over what's left
            for (const id of this.legIds) delete u[id];
            this._recomputeCenter(u);
            if (Object.keys(u).length === 0) delete frame.objects.Unlabeled;
        }
    }

    /** Recompute the `Center` node of Unlabeled as the centroid of its remaining markers. */
    _recomputeCenter(unlabeled) {
        delete unlabeled.Center;
        const ids = Object.keys(unlabeled);
        if (!ids.length) return;

        let sum = [0, 0, 0], count = 0;
        for (const id of ids) {
            const p = unlabeled[id]?.pos;
            if (p?.length >= 3) { sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; count++; }
        }
        if (count > 0) unlabeled.Center = { pos: sum.map(v => v / count) };
    }

    /** Re-run metric passes so new/changed nodes get speed / accel / angles. */
    _recomputeMetrics() {
        this.metrics.calculateRawVelocities(this.frameData);
        this.metrics.calculateRawAccelerations(this.frameData);
        this.smoother.smoothAllData(this.frameData, this.sourceFrameRate);
        this.metrics.calculateNodeAngles(this.frameData, this.metadata);
        this.metrics.handleEdgeCases(this.frameData);
        this.adaptAccelerationForGraphs(this.frameData);
        this.metrics.cleanupIntermediateData(this.frameData);
    }

    _standardizeOriginalFilename() {
        if (!this.metadata) return;

        if (this.metadata.originalName) {
            this.metadata.originalFilename ??= this.metadata.originalName;
            delete this.metadata.originalName;
        }

        if (this.metadata.originalFilename && this.metadata.takeNotes !== undefined) {
            const ordered = {};
            for (const k in this.metadata) {
                if (k === 'originalFilename') continue;
                ordered[k] = this.metadata[k];
                if (k === 'takeNotes') ordered.originalFilename = this.metadata.originalFilename;
            }
            if (!ordered.originalFilename) ordered.originalFilename = this.metadata.originalFilename;
            this.metadata = ordered;
        }
    }
}
