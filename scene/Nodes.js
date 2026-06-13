/**
 * Nodes.js - Creates and manages 3D node meshes for ALL loaded takes.
 *
 * Multi-take aware: every key is `${takeId}:${objectName}:${nodeName}`
 * and every mesh's userData carries the `takeId` so the Picker can route
 * clicks to the right Selection entry.
 *
 * Visual states:
 *   rest       → opacity 0.4 (dimmed; bones dominate)
 *   hovered    → opacity 1, scale 1.25, soft white halo
 *   selected   → fresh material, scale 1.1, persistent halo in selection colour
 *   sel+hover  → scale 1.35, hover halo tinted in selection colour
 *
 * Each visible joint mesh ships with an invisible hit-target sphere
 * (HIT_RADIUS = 6 cm) for forgiving click/hover. Hit-targets are children
 * of the visible mesh; counter-scaled in setHover/highlight so their
 * world radius stays constant.
 */

import * as THREE from 'three';
import { OBJECT_TYPES, OBJECT_NAMES, NODE_NAMES, JOINT_NAMES, nodeKey } from '../lib/object-types.js';

const toRad = deg => deg * Math.PI / 180;

const DIM_OPACITY  = 0.4;
const HIT_RADIUS   = 0.06;
const HALO_RADIUS  = 0.06;
const HOVER_RADIUS = 0.075;
const HOVER_SCALE     = 1.25;
const SEL_SCALE       = 1.1;
const SEL_HOVER_SCALE = 1.35;

export const NODE_DEFAULTS = {
    jointSize:   0.026,
    jointColor:  '#5599cc',
    markerSize:  0.026,
    markerColor: '#cc0000',
};

function buildConfigs(cfg) {
    const jc = new THREE.Color(cfg.jointColor);
    const mc = new THREE.Color(cfg.markerColor);
    const s  = cfg.jointSize;
    // Head/hip cubes are scaled relative to the base joint size to
    // give the body's anatomical anchors a slightly heftier presence.
    const headHipSize = s * 1.8;
    return {
        centerNode: { test: (obj, nd)       => obj === OBJECT_NAMES.UNLABELED && nd === NODE_NAMES.CENTER, geo: () => new THREE.SphereGeometry(0.05, 16, 16),   color: 0xFF5500, emissive: 0xFFFFFF, emissiveIntensity: 0.1, dim: false },
        ball:       { test: (obj)            => obj === 'Ball',                         geo: () => new THREE.SphereGeometry(0.06, 24, 24),   color: 0xFF6600, emissive: 0xFF6600, emissiveIntensity: 0.3, dim: false },
        head:       { test: (_, nd, type)    => type === OBJECT_TYPES.SKELETON && JOINT_NAMES.HEAD.test(nd),            geo: () => new THREE.BoxGeometry(headHipSize, headHipSize, headHipSize), color: jc, emissive: 0xFFFFFF, emissiveIntensity: 0.15 },
        hip:        { test: (_, nd, type)    => type === OBJECT_TYPES.SKELETON && JOINT_NAMES.HIP.test(nd),           geo: () => new THREE.BoxGeometry(headHipSize, headHipSize, headHipSize), color: jc, emissive: 0xFFFFFF, emissiveIntensity: 0.15 },
        skeleton:   { test: (_, __, type)    => type === OBJECT_TYPES.SKELETON,                    geo: () => new THREE.SphereGeometry(s, 16, 16),      color: jc, emissive: 0xFFFFFF, emissiveIntensity: 0.1 },
        chain:      { test: (_, __, type)    => type === OBJECT_TYPES.CHAIN,                       geo: () => new THREE.SphereGeometry(s * 1.3, 16, 16), color: 0xEA580C, emissive: 0xFFFFFF, emissiveIntensity: 0.15 },
        rigidbody:  { test: (_, __, type)    => type === OBJECT_TYPES.RIGIDBODY,                   geo: () => new THREE.BoxGeometry(0.05, 0.05, 0.05),   color: 0xFFFF00, emissive: 0xFFFFFF, emissiveIntensity: 0.1 },
        unlabeled:  { test: (obj, _, type)   => type === OBJECT_TYPES.MARKER && obj === OBJECT_NAMES.UNLABELED, geo: () => new THREE.OctahedronGeometry(cfg.markerSize, 0), color: 0xFFFF00, emissive: 0xFFFFFF, emissiveIntensity: 0.1 },
        marker:     { test: (_, __, type)    => type === OBJECT_TYPES.MARKER,                      geo: () => new THREE.SphereGeometry(cfg.markerSize, 12, 12), color: mc, emissive: 0xFFFFFF, emissiveIntensity: 0.1 },
        default:    { test: ()               => true,                                   geo: () => new THREE.SphereGeometry(s, 16, 16),      color: jc, emissive: 0xFFFFFF, emissiveIntensity: 0.1 },
    };
}

export class Nodes {
    constructor(scene, config) {
        this.scene             = scene;
        this.nodes             = {};       // 3-part key → visible mesh
        this.hitTargets        = {};       // 3-part key → invisible sibling sphere
        this.originalMaterials = new Map();
        this.highlightedNodes  = new Map(); // 3-part key → color
        this.selectionHalos    = new Map(); // 3-part key → halo child mesh
        this.unlabeledNodes    = new Set(); // 3-part keys
        this.unlabeledByTake   = new Map(); // takeId → Set<name>
        this.unlabeledScratch  = new Map(); // takeId → Set<name> (per-frame scratch, reused)
        this.hoveredKey        = null;
        this.config            = { ...NODE_DEFAULTS, ...config };
        this.nodeConfigs       = buildConfigs(this.config);

        this.hitMaterial = new THREE.MeshBasicMaterial({
            transparent: true, opacity: 0,
            depthWrite: false, colorWrite: false,
            side: THREE.DoubleSide,
        });

        this.hoverHalo = new THREE.Mesh(
            new THREE.SphereGeometry(HOVER_RADIUS, 24, 24),
            new THREE.MeshBasicMaterial({
                color: 0xFFFFFF, transparent: true, opacity: 0.5,
                blending: THREE.AdditiveBlending,
                depthWrite: false, side: THREE.BackSide,
            })
        );
        this.hoverHalo.visible = false;
        this.hoverHalo.userData.isOverlay = true;
        this.scene.add(this.hoverHalo);
    }

    setConfig(cfg) {
        Object.assign(this.config, cfg);
        this.nodeConfigs = buildConfigs(this.config);
    }

    /** Compose a 3-part key from its parts. */
    /** Build the canonical 3-part composite key. Re-exported as a static
     *  for callers using `Nodes.keyOf(...)`; new code can import
     *  `nodeKey` from `lib/object-types.js` directly. */
    static keyOf(takeId, objectName, nodeName) { return nodeKey(takeId, objectName, nodeName); }

    createNode(takeId, objectName, nodeName, objectType, pos, rotation, isQuat) {
        const key = Nodes.keyOf(takeId, objectName, nodeName);
        const cfg = Object.values(this.nodeConfigs).find(c => c.test(objectName, nodeName, objectType));
        const dim = cfg.dim !== false;

        const mat  = new THREE.MeshStandardMaterial({
            color: cfg.color, roughness: cfg.roughness ?? 0.2, metalness: cfg.metalness ?? 0.1,
            transparent: dim, opacity: dim ? DIM_OPACITY : 1,
            ...(cfg.emissive ? { emissive: cfg.emissive, emissiveIntensity: cfg.emissiveIntensity } : {}),
        });
        const mesh = new THREE.Mesh(cfg.geo(), mat);
        this.#applyTransform(mesh, pos, rotation, isQuat);
        mesh.userData = { type: 'node', takeId, objectName, nodeName, objectType, dim };

        const hit = new THREE.Mesh(this.#hitGeometry(), this.hitMaterial);
        hit.userData = { type: 'node', takeId, objectName, nodeName, objectType, isHitTarget: true };
        mesh.add(hit);

        this.scene.add(mesh);
        this.nodes[key]      = mesh;
        this.hitTargets[key] = hit;
        this._hitTargetsCache = null;
        if (objectName === OBJECT_NAMES.UNLABELED) this.unlabeledNodes.add(key);
        return mesh;
    }

    /** Bulk per-frame update: walks one object's joints, position-mutating
     *  every mesh in place. For each highlighted mesh, invokes
     *  `onHighlight(mesh, key, color)` so the caller can attach trail
     *  dots / etc. without exposing the highlight Map.
     *
     *  This is the hot path — encapsulates the prefix-key trick and the
     *  inline transform write so callers don't reach into `.nodes` /
     *  `.highlightedNodes` directly. */
    applyFrame(takeId, objectName, objs, sox, soy, soz, onHighlight) {
        const nodesById  = this.nodes;
        const highlights = this.highlightedNodes;
        const keyPrefix  = takeId + ':' + objectName + ':';
        for (const nodeName in objs) {
            const nd = objs[nodeName];
            if (!nd?.pos) continue;
            const key  = keyPrefix + nodeName;
            const mesh = nodesById[key];
            if (!mesh) continue;
            const x = nd.pos[0] + sox, y = nd.pos[1] + soy, z = nd.pos[2] + soz;
            mesh.position.set(x, y, z);
            if (nd.quat) mesh.quaternion.set(nd.quat[0], nd.quat[1], nd.quat[2], nd.quat[3]);
            else if (nd.rot) mesh.rotation.set(
                nd.rot[0] * Math.PI / 180,
                nd.rot[1] * Math.PI / 180,
                nd.rot[2] * Math.PI / 180);
            if (onHighlight && highlights.has(key)) {
                onHighlight(mesh, key, highlights.get(key));
            }
        }
    }

    // ── Unlabeled reconcile API ───────────────────────────────────
    // The Unlabeled marker set is volatile (markers appear, disappear,
    // and re-appear during occlusion). Instead of wiping + rebuilding
    // every frame, we reconcile: keep meshes alive across frames, hide
    // ones whose name didn't appear this frame.

    /** Bulk per-frame update for a take's Unlabeled markers. Reconciles
     *  in place: existing markers get position-updated, new ones get
     *  created, vanished ones get hidden. For each highlighted marker
     *  invokes `onHighlight(mesh, key, color)`. */
    applyUnlabeledFrame(takeId, objs, sox, soy, soz, onHighlight) {
        const nodesById  = this.nodes;
        const highlights = this.highlightedNodes;
        const keyPrefix  = takeId + ':Unlabeled:';
        const present    = this.beginUnlabeledFrame(takeId);
        for (const name in objs) {
            const nd = objs[name];
            if (!nd?.pos) continue;
            present.add(name);
            this.upsertUnlabeled(takeId, name, nd, sox, soy, soz);
            if (!onHighlight) continue;
            const key  = keyPrefix + name;
            const mesh = nodesById[key];
            if (mesh && highlights.has(key)) onHighlight(mesh, key, highlights.get(key));
        }
        this.endUnlabeledFrame(takeId, present);
    }

    /** Begin a per-frame Unlabeled pass. Returns a working Set the
     *  caller fills with the names actually present this frame. The
     *  set is reused across frames (cleared each call) — no per-frame
     *  Set allocation. */
    beginUnlabeledFrame(takeId) {
        let s = this.unlabeledScratch.get(takeId);
        if (!s) { s = new Set(); this.unlabeledScratch.set(takeId, s); }
        else s.clear();
        return s;
    }

    /** Create-or-update an Unlabeled marker, mutating its mesh in place
     *  if it already exists. */
    upsertUnlabeled(takeId, name, nd, sox, soy, soz) {
        const key  = takeId + ':Unlabeled:' + name;
        let mesh   = this.nodes[key];
        if (!mesh) {
            const adjPos = (sox || soy || soz)
                ? [nd.pos[0] + sox, nd.pos[1] + soy, nd.pos[2] + soz]
                : nd.pos;
            mesh = this.createNode(takeId, OBJECT_NAMES.UNLABELED, name, OBJECT_TYPES.MARKER, adjPos);
            mesh.visible = this.unlabeledMarkersVisible;
        } else {
            mesh.visible = this.unlabeledMarkersVisible;
            mesh.position.set(nd.pos[0] + sox, nd.pos[1] + soy, nd.pos[2] + soz);
        }
        let nameSet = this.unlabeledByTake.get(takeId);
        if (!nameSet) { nameSet = new Set(); this.unlabeledByTake.set(takeId, nameSet); }
        nameSet.add(name);
    }

    /** Close a per-frame Unlabeled pass. Markers that exist for this
     *  take but weren't in `present` are hidden (kept alive — they
     *  often reappear within milliseconds during occlusion). */
    endUnlabeledFrame(takeId, present) {
        const nameSet = this.unlabeledByTake.get(takeId);
        if (!nameSet) return;
        const prefix = takeId + ':Unlabeled:';
        for (const name of nameSet) {
            if (present.has(name)) continue;
            const mesh = this.nodes[prefix + name];
            if (mesh) mesh.visible = false;
        }
    }

    getNode(takeId, objectName, nodeName)  { return this.nodes[Nodes.keyOf(takeId, objectName, nodeName)] || null; }
    getAllNodes()                           { return Object.values(this.nodes); }

    getHitTargets() {
        // Cached and invalidated on add/remove — Picker calls this on
        // every pointermove (~60Hz) and the result is stable between
        // mesh-lifecycle events.
        if (!this._hitTargetsCache) this._hitTargetsCache = Object.values(this.hitTargets);
        return this._hitTargetsCache;
    }

    /** Invalidate the hit-targets cache. Called from anywhere that
     *  adds or removes a node mesh. */
    _invalidateHitTargets() { this._hitTargetsCache = null; }

    setUnlabeledMarkersVisibility(visible) {
        this.unlabeledNodes.forEach(k => { if (this.nodes[k]) this.nodes[k].visible = visible; });
    }

    /** Toggle visibility of every node mesh that belongs to a given take.
     *  When set to true, also re-applies the global unlabeled-markers
     *  toggle so that hidden unlabeled markers stay hidden if the user
     *  had switched them off. */
    setTakeVisibility(takeId, visible) {
        const prefix = `${takeId}:`;
        for (const key in this.nodes) {
            if (key.startsWith(prefix)) this.nodes[key].visible = visible;
        }
    }

    /** Hover a single joint by its full 3-part key (or null to clear). */
    setHover(key) {
        if (this.hoveredKey === key) return;
        if (this.hoveredKey) this.#applyHoverState(this.hoveredKey, false);
        this.hoveredKey = key;
        if (key) this.#applyHoverState(key, true);
        this.refitHover();
    }

    refitHover() {
        if (!this.hoveredKey) { this.hoverHalo.visible = false; return; }
        const mesh = this.nodes[this.hoveredKey];
        if (!mesh) { this.hoverHalo.visible = false; return; }
        this.hoverHalo.position.copy(mesh.position);
        const selColor = this.highlightedNodes.get(this.hoveredKey);
        this.hoverHalo.material.color.set(selColor || 0xFFFFFF);
        this.hoverHalo.visible = true;
    }

    #applyHoverState(key, on) {
        const mesh = this.nodes[key];
        if (!mesh) return;
        const isSelected = this.highlightedNodes.has(key);
        if (on) mesh.scale.setScalar(isSelected ? SEL_HOVER_SCALE : HOVER_SCALE);
        else    mesh.scale.setScalar(isSelected ? SEL_SCALE      : 1);
        if (mesh.userData?.dim && !isSelected) {
            mesh.material.opacity = on ? 1 : DIM_OPACITY;
        }
        this.#syncChildScales(key, mesh);
    }

    highlightNode(takeId, objectName, nodeName, color) {
        const key  = Nodes.keyOf(takeId, objectName, nodeName);
        const mesh = this.nodes[key];
        if (!mesh) return false;
        if (!this.originalMaterials.has(mesh)) this.originalMaterials.set(mesh, mesh.material);

        const c = new THREE.Color(color);
        mesh.material = new THREE.MeshStandardMaterial({
            color: c, emissive: c, emissiveIntensity: 0.55,
            roughness: 0.5, metalness: 0,
        });

        const halo = this.#makeHalo(c);
        mesh.add(halo);
        this.selectionHalos.set(key, halo);

        const isHovered = this.hoveredKey === key;
        mesh.scale.setScalar(isHovered ? SEL_HOVER_SCALE : SEL_SCALE);
        this.#syncChildScales(key, mesh);

        this.highlightedNodes.set(key, color);
        mesh.userData.highlightColor = color;
        this.refitHover();
        return true;
    }

    unhighlightNode(takeId, objectName, nodeName) {
        return this.unhighlightByKey(Nodes.keyOf(takeId, objectName, nodeName));
    }

    /** Unhighlight by 3-part key directly. Cheaper than rebuilding the
     *  key when the caller already has it (e.g. SceneRenderer's sync
     *  loop walking `highlightedNodes.keys()`). */
    unhighlightByKey(key) {
        const mesh = this.nodes[key];
        if (!mesh) return false;
        if (this.originalMaterials.has(mesh)) {
            mesh.material = this.originalMaterials.get(mesh);
            this.originalMaterials.delete(mesh);
        }
        const halo = this.selectionHalos.get(key);
        if (halo) {
            mesh.remove(halo);
            halo.geometry?.dispose();
            halo.material?.dispose();
            this.selectionHalos.delete(key);
        }
        const isHovered = this.hoveredKey === key;
        mesh.scale.setScalar(isHovered ? HOVER_SCALE : 1);
        this.#syncChildScales(key, mesh);
        if (isHovered && mesh.userData?.dim) mesh.material.opacity = 1;
        this.highlightedNodes.delete(key);
        this.refitHover();
        return true;
    }

    /** Snapshot of currently-highlighted keys. Cheap (just the keys). */
    highlightedKeys() { return [...this.highlightedNodes.keys()]; }

    /** The color a key is highlighted with, or undefined if not. */
    highlightColor(key) { return this.highlightedNodes.get(key); }

    /** Remove every mesh that belongs to the given take. Used when a take
     *  is unloaded from the registry. */
    removeAllNodesByTake(takeId) {
        this._hitTargetsCache = null;
        const prefix = `${takeId}:`;
        for (const key of Object.keys(this.nodes)) {
            if (!key.startsWith(prefix)) continue;
            const mesh = this.nodes[key];
            this.scene.remove(mesh);
            this.#disposeMeshTree(mesh);
            delete this.nodes[key];
            delete this.hitTargets[key];
            this.unlabeledNodes.delete(key);
            this.highlightedNodes.delete(key);
            this.selectionHalos.delete(key);
            this.originalMaterials.delete(mesh);
            if (this.hoveredKey === key) { this.hoveredKey = null; this.hoverHalo.visible = false; }
        }
        this.unlabeledByTake.delete(takeId);
        this.unlabeledScratch.delete(takeId);
    }

    removeAllNodes() {
        this._hitTargetsCache = null;
        for (const mesh of Object.values(this.nodes)) {
            this.scene.remove(mesh);
            this.#disposeMeshTree(mesh);
        }
        for (const mat of this.originalMaterials.values()) {
            if (Array.isArray(mat)) mat.forEach(m => m.dispose());
            else mat?.dispose();
        }
        this.nodes             = {};
        this.hitTargets        = {};
        this.originalMaterials.clear();
        this.highlightedNodes.clear();
        this.selectionHalos.clear();
        this.unlabeledNodes.clear();
        this.unlabeledByTake.clear();
        this.unlabeledScratch.clear();
        this.hoveredKey = null;
        this.hoverHalo.visible = false;
    }

    destroy() {
        this.removeAllNodes();
        this.scene.remove(this.hoverHalo);
        this.hoverHalo.geometry?.dispose();
        this.hoverHalo.material?.dispose();
        this.hitMaterial?.dispose();
    }

    // ── Internals ─────────────────────────────────────────────────────

    #syncChildScales(key, mesh) {
        const inv = 1 / mesh.scale.x;
        const hit  = this.hitTargets[key];
        const halo = this.selectionHalos.get(key);
        if (hit)  hit.scale.setScalar(inv);
        if (halo) halo.scale.setScalar(inv);
    }

    #hitGeometry() { return new THREE.SphereGeometry(HIT_RADIUS, 12, 12); }

    #makeHalo(color) {
        return new THREE.Mesh(
            new THREE.SphereGeometry(HALO_RADIUS, 24, 24),
            new THREE.MeshBasicMaterial({
                color, transparent: true, opacity: 0.45,
                blending: THREE.AdditiveBlending,
                depthWrite: false, side: THREE.BackSide,
            })
        );
    }

    #disposeMeshTree(mesh) {
        mesh.traverse(child => {
            child.geometry?.dispose?.();
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            for (const m of mats) {
                if (m && m !== this.hitMaterial) m.dispose?.();
            }
        });
    }

    #applyTransform(mesh, pos, rot, isQuat) {
        if (pos) mesh.position.set(pos[0], pos[1], pos[2]);
        if (rot) {
            if (isQuat) mesh.quaternion.set(rot[0], rot[1], rot[2], rot[3]);
            else        mesh.rotation.set(toRad(rot[0]), toRad(rot[1]), toRad(rot[2]));
        }
    }
}
