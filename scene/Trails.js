/**
 * Trails.js — Fading position trails for selected nodes.
 *
 * Performance contract:
 *   - Dot meshes are pooled and reused: when a trail point fades past
 *     `duration`, its mesh + materials are pushed into a freelist
 *     instead of being disposed. The next addPositionToHistory pulls
 *     from the pool, mutating position/color/opacity in place.
 *   - Lines (the connectors between successive dots) follow the same
 *     pool pattern.
 *   - `updateHistory` mutates entries in place (no `kept = []` / push /
 *     map.set churn).
 *
 * Trade-off: pooled materials need `.color` / `.opacity` set per
 * revival, which is cheap.
 */

import * as THREE from 'three';

const DEFAULT_CONFIG = {
    duration:          12,
    dotSize:           0.02,
    lineOpacity:       0.7,
    dotOpacity:        0.85,
    timeJumpThreshold: 0.1,
    centerHighlight:   true,
};

export class Trails {
    constructor(scene) {
        this.scene  = scene;
        this.config = { ...DEFAULT_CONFIG };

        this.historyGroup = new THREE.Group();
        this.historyGroup.visible = false;
        this.scene.add(this.historyGroup);

        // Map<nodeKey, Array<{ dot, line, time, isCenter }>>
        this.nodeHistory   = new Map();
        this.lastFrameTime = null;

        // Dot/line pools — re-used across history entries.
        this.dotPool       = [];
        this.linePool      = [];

        // Shared sphere geometry for dots (cheap; size encoded in scale).
        this._dotGeo       = new THREE.SphereGeometry(1, 8, 8);
    }

    toggleHistoryVisibility() {
        this.historyGroup.visible = !this.historyGroup.visible;
        return this.historyGroup.visible;
    }

    addPositionToHistory(nodeKey, position, time, color) {
        if (!this.historyGroup.visible) return;

        const isCenter  = nodeKey.includes(':Center');
        const highlight = isCenter && this.config.centerHighlight;
        const dotSize   = highlight ? this.config.dotSize   * 1.5 : this.config.dotSize;
        const dotAlpha  = highlight ? Math.min(1, this.config.dotOpacity  * 1.2) : this.config.dotOpacity;
        const lineAlpha = highlight ? Math.min(1, this.config.lineOpacity * 1.3) : this.config.lineOpacity;

        let history = this.nodeHistory.get(nodeKey);
        if (!history) { history = []; this.nodeHistory.set(nodeKey, history); }

        // ─ Dot ─ (acquired from pool — already parented to historyGroup)
        const dot = this.#acquireDot();
        dot.material.color.set(color);
        dot.material.opacity = dotAlpha;
        dot.scale.setScalar(dotSize);
        dot.position.copy(position);
        dot.visible = true;

        // ─ Line ─ (skipped when this is the very first dot of the chain)
        let line = null;
        if (history.length > 0) {
            const prev = history[history.length - 1].dot.position;
            line = this.#acquireLine();
            line.material.color.set(color);
            line.material.opacity   = lineAlpha;
            line.material.linewidth = highlight ? 2 : 1.5;
            const positions = line.geometry.attributes.position.array;
            positions[0] = prev.x;     positions[1] = prev.y;     positions[2] = prev.z;
            positions[3] = position.x; positions[4] = position.y; positions[5] = position.z;
            line.geometry.attributes.position.needsUpdate = true;
            line.geometry.computeBoundingSphere();
            line.visible = true;
        }

        history.push({ dot, line, time, isCenter });
    }

    /** Tick the trails fade once per animate frame. */
    updateHistory(currentTime) {
        if (!this.historyGroup.visible) return;

        if (this.lastFrameTime !== null
            && Math.abs(currentTime - this.lastFrameTime) > this.config.timeJumpThreshold) {
            this.clearAllHistory();
        }
        this.lastFrameTime = currentTime;

        const dur          = this.config.duration;
        const dotBase      = this.config.dotOpacity;
        const lineBase     = this.config.lineOpacity;
        const dotCenter    = Math.min(1, dotBase  * 1.2);
        const lineCenter   = Math.min(1, lineBase * 1.3);

        for (const history of this.nodeHistory.values()) {
            // In-place compaction: walk forward, drop expired entries
            // back into the pool, keep survivors.
            let w = 0;   // write index for survivors
            for (let r = 0; r < history.length; r++) {
                const entry = history[r];
                const age   = currentTime - entry.time;
                if (age < dur) {
                    const opacity = 1 - age / dur;
                    entry.dot.material.opacity = opacity * (entry.isCenter ? dotCenter : dotBase);
                    if (entry.line) entry.line.material.opacity = opacity * (entry.isCenter ? lineCenter : lineBase);
                    if (w !== r) history[w] = entry;
                    w++;
                } else {
                    this.#releaseDot(entry.dot);
                    if (entry.line) this.#releaseLine(entry.line);
                }
            }
            history.length = w;
        }
    }

    clearNodeHistory(nodeKey) {
        const history = this.nodeHistory.get(nodeKey);
        if (!history) return;
        for (const entry of history) {
            this.#releaseDot(entry.dot);
            if (entry.line) this.#releaseLine(entry.line);
        }
        this.nodeHistory.delete(nodeKey);
    }

    clearAllHistory() {
        for (const history of this.nodeHistory.values()) {
            for (const entry of history) {
                this.#releaseDot(entry.dot);
                if (entry.line) this.#releaseLine(entry.line);
            }
        }
        this.nodeHistory.clear();
    }

    destroy() {
        this.clearAllHistory();
        // Release the pools' THREE objects
        for (const d of this.dotPool)  { d.geometry?.dispose?.(); d.material?.dispose?.(); }
        for (const l of this.linePool) { l.geometry?.dispose?.(); l.material?.dispose?.(); }
        this.dotPool.length = this.linePool.length = 0;
        this._dotGeo?.dispose?.();
        this.scene.remove(this.historyGroup);
    }

    // ── Pool internals ───────────────────────────────────────────
    // Pooled dots and lines stay parented to historyGroup at all times.
    // "Acquire" = fetch from pool (set visible=true downstream),
    // "release" = push to pool with visible=false. No add/remove churn
    // on the THREE.Group children array.

    #acquireDot() {
        if (this.dotPool.length) return this.dotPool.pop();
        const dot = new THREE.Mesh(
            this._dotGeo,
            new THREE.MeshBasicMaterial({ transparent: true })
        );
        this.historyGroup.add(dot);   // stays parented for life
        return dot;
    }

    #releaseDot(dot) {
        dot.visible = false;
        this.dotPool.push(dot);
    }

    #acquireLine() {
        if (this.linePool.length) return this.linePool.pop();
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
        const line = new THREE.Line(
            geo,
            new THREE.LineBasicMaterial({ transparent: true })
        );
        this.historyGroup.add(line);   // stays parented for life
        return line;
    }

    #releaseLine(line) {
        line.visible = false;
        this.linePool.push(line);
    }
}
