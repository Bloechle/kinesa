/**
 * Metrics.js - Derived metrics: velocity, acceleration, joint angles, up angles
 */

import * as THREE from 'three';
import { SKELETON_CONNECTIONS } from '../lib/skeleton.js';

import { OBJECT_TYPES } from '../lib/object-types.js';
import { forEachNode } from './frame-utils.js';
// ── Inlined math helpers ────────────────────────────────────────────────────

/** Float-equality threshold for guard checks against div-by-zero
 *  (time delta, vector magnitude). Below this value the operation
 *  is considered numerically meaningless. */
const EPSILON = 0.0001;

function calcVelocity(posA, posB, dt) {
    if (Math.abs(dt) < EPSILON) return { x: 0, y: 0, z: 0, magnitude: 0 };
    const vx = (posB[0] - posA[0]) / dt;
    const vy = (posB[1] - posA[1]) / dt;
    const vz = (posB[2] - posA[2]) / dt;
    return { x: vx, y: vy, z: vz, magnitude: Math.sqrt(vx * vx + vy * vy + vz * vz) };
}

function angleBetweenVectors(a, b) {
    const magA = Math.sqrt(a[0] ** 2 + a[1] ** 2 + a[2] ** 2);
    const magB = Math.sqrt(b[0] ** 2 + b[1] ** 2 + b[2] ** 2);
    if (magA < EPSILON || magB < EPSILON) return 0;
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return Math.acos(Math.min(1, Math.max(-1, dot / (magA * magB)))) * (180 / Math.PI);
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export class Metrics {
    constructor() {
        this.config = { preserveRawData: false };
    }

    calculateRawVelocities(frames) {
        for (let i = 1; i < frames.length; i++) {
            const curr = frames[i], prev = frames[i - 1];
            if (!curr || !prev || curr.time === undefined || prev.time === undefined) continue;

            const dt = curr.time - prev.time;
            if (Math.abs(dt) < EPSILON) continue;

            for (const obj in curr.objects) {
                if (!prev.objects?.[obj]) continue;
                for (const node in curr.objects[obj]) {
                    const cn = this._getNodeData(curr, obj, node);
                    const pn = this._getNodeData(prev, obj, node);
                    if (!cn?.pos || !pn?.pos || cn.pos.length < 3 || pn.pos.length < 3) continue;

                    const v = calcVelocity(pn.pos, cn.pos, dt);
                    cn.rawSpeed = [v.x, v.y, v.z, v.magnitude];
                    cn.speed = [0, 0, 0, 0];
                }
            }
        }
        return frames;
    }

    calculateRawAccelerations(frames) {
        for (let i = 2; i < frames.length; i++) {
            const curr = frames[i], prev = frames[i - 1];
            if (!curr || !prev || curr.time === undefined || prev.time === undefined) continue;

            const dt = curr.time - prev.time;
            if (Math.abs(dt) < EPSILON) continue;

            for (const obj in curr.objects) {
                if (!prev.objects?.[obj]) continue;
                for (const node in curr.objects[obj]) {
                    const cn = this._getNodeData(curr, obj, node);
                    const pn = this._getNodeData(prev, obj, node);
                    if (!Array.isArray(cn?.rawSpeed) || cn.rawSpeed.length < 4) continue;
                    if (!Array.isArray(pn?.rawSpeed) || pn.rawSpeed.length < 4) continue;

                    cn.rawAccel = (cn.rawSpeed[3] - pn.rawSpeed[3]) / dt;
                    cn.accel = 0;
                }
            }
        }
        return frames;
    }

    calculateNodeAngles(frames, metadata) {
        // Cache the connection source per object — same metadata across
        // all frames, no point recomputing per-frame.
        const connsByObject = {};
        if (metadata?.objects) {
            for (const obj in metadata.objects) {
                const meta = metadata.objects[obj];
                if (meta.type === OBJECT_TYPES.SKELETON)                  connsByObject[obj] = SKELETON_CONNECTIONS;
                else if (meta.type === OBJECT_TYPES.CHAIN && meta.connections) connsByObject[obj] = meta.connections;
            }
        }

        forEachNode(frames, (nd, { frame, objectName, nodeName }) => {
            const connsSrc = connsByObject[objectName];
            if (!connsSrc || !nd.pos) return;

            const conns = connsSrc.filter(c => c[0] === nodeName || c[1] === nodeName);
            // A node-angle is only well-defined for joints with EXACTLY
            // two connections (elbow / knee / shoulder / wrist / spine
            // segments). End-effectors (1 conn — Head, Hand, Foot, Toe)
            // and branching joints (3+ conns — Hip, Chest) get no angle
            // — extractNodeData skips undefined values, so the chart and
            // stats card simply omit the row rather than display 0 / a
            // misleading 2-of-N picked angle.
            if (conns.length !== 2) return;

            const [nodeA, nodeC] = conns.map(c => c[0] === nodeName ? c[1] : c[0]);
            const posB = nd.pos;
            const posA = frame.objects[objectName][nodeA]?.pos;
            const posC = frame.objects[objectName][nodeC]?.pos;
            if (!posA || !posC) return;

            const vBA = [posA[0] - posB[0], posA[1] - posB[1], posA[2] - posB[2]];
            const vBC = [posC[0] - posB[0], posC[1] - posB[1], posC[2] - posB[2]];
            nd.angle = parseFloat(angleBetweenVectors(vBA, vBC).toFixed(1));
        });
        return frames;
    }

    calculateUpAngles(frames) {
        const localForward = new THREE.Vector3(0, 1, 0); // bone's anatomical up in local space
        const worldUp = new THREE.Vector3(0, 1, 0);
        const quaternion = new THREE.Quaternion();

        forEachNode(frames, nd => {
            if (!nd?.quat) return;
            quaternion.set(nd.quat[0], nd.quat[1], nd.quat[2], nd.quat[3]);
            const worldFwd = localForward.clone().applyQuaternion(quaternion).normalize();
            // Full 0–180° range: 0°=up, 90°=horizontal, 180°=down
            const horiz = Math.sqrt(worldFwd.x * worldFwd.x + worldFwd.z * worldFwd.z);
            nd.upAngle = parseFloat(THREE.MathUtils.radToDeg(Math.atan2(horiz, worldFwd.y)).toFixed(1));
        });
        return frames;
    }

    handleEdgeCases(frames) {
        if (!frames.length) return frames;
        this._handleFirstFrame(frames);
        if (frames.length > 1) this._handleSecondFrame(frames);
        return frames;
    }

    cleanupIntermediateData(frames) {
        if (this.config.preserveRawData) return frames;
        forEachNode(frames, nd => {
            if (nd.rawSpeed !== undefined) delete nd.rawSpeed;
            if (nd.rawAccel !== undefined) delete nd.rawAccel;
        });
        return frames;
    }

    _handleFirstFrame(frames) {
        const first = frames[0];
        for (const obj in first.objects) {
            for (const node in first.objects[obj]) {
                const nd = first.objects[obj][node];
                if (!nd.pos) continue;

                const second = frames[1]?.objects?.[obj]?.[node]?.speed;
                nd.speed = Array.isArray(second) ? second.map(v => v * 0.5) : [0, 0, 0, 0];
                if (!Array.isArray(nd.rawSpeed)) nd.rawSpeed = [...nd.speed];
                nd.accel = 0;
                if (nd.rawAccel === undefined) nd.rawAccel = 0;
            }
        }
    }

    _handleSecondFrame(frames) {
        const second = frames[1];
        for (const obj in second.objects) {
            for (const node in second.objects[obj]) {
                const nd = second.objects[obj][node];
                if (!nd.speed) continue;

                const samples = [];
                for (let i = 2; i < Math.min(5, frames.length); i++) {
                    const a = frames[i]?.objects?.[obj]?.[node]?.accel;
                    if (a !== undefined) samples.push(a);
                }

                nd.accel = samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
                if (nd.rawAccel === undefined) nd.rawAccel = nd.accel;
            }
        }
    }

    _getNodeData(frame, obj, node) {
        return frame?.objects?.[obj]?.[node] ?? null;
    }
}
