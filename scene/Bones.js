/**
 * Bones.js — Skeleton bones, rigid body connections, kinematic chains.
 *
 * Multi-take aware: connection groups are keyed
 * `${type}:${takeId}:${objectName}` and each tube mesh's `userData`
 * carries `takeId`. The hover overlay tracks one bone at a time
 * across any take.
 *
 * Performance contract (v1.8):
 *   - Each (group × bone-pair) keeps two THREE.Mesh objects alive
 *     (`vis` + `hit`) AND their BufferGeometry instances. Per frame
 *     we mutate the position attribute *in place* — no Mesh, no
 *     BufferGeometry, no typed-array allocation.
 *   - The geometry is built from a shared **vertex template**: a unit
 *     tube along the X axis with `radialSegments=N`, baked once. To
 *     paint a bone, we copy the template positions into the live
 *     attribute, transformed (translate + rotate + scale) so the
 *     unit tube spans `A → B` with the right radius.
 *   - Skeleton connection lists cached per `(objectName, metadata.nodes)`.
 *   - Rigid-body C(n,2) lists cached per name set.
 *   - Reconciliation only runs when the conn-list IDENTITY changes
 *     (we keep cached lists, so a stable structure means a stable
 *     reference — single pointer compare, no string sig).
 */

import * as THREE from 'three';
import { SKELETON_CONNECTIONS } from '../lib/skeleton.js';
import { OBJECT_TYPES } from '../lib/object-types.js';

const BONE_DEFAULTS     = { boneWidth: 0.016 };
const HIT_RADIUS_MULT   = 3.5;
const HOVER_RADIUS_MULT = 2.4;

// Scratch math objects — re-used across all bones every frame to
// keep the hot path allocation-free. `_tmpDir / _tmpUp / _tmpRight`
// are basis vectors for the unit-tube → world transform.
const _tmpDir   = new THREE.Vector3();
const _tmpUp    = new THREE.Vector3();
const _tmpRight = new THREE.Vector3();
const _refUp    = new THREE.Vector3(0, 1, 0);
const _refX     = new THREE.Vector3(1, 0, 0);

export class Bones {
    constructor(scene, nodeRenderer, config) {
        this.scene        = scene;
        this.nodeRenderer = nodeRenderer;
        this.config       = { ...BONE_DEFAULTS, ...config };
        this.hovered      = null;

        // Per-group state. Each entry:
        //   { group, bones: Map<connKey, BoneEntry>, conns: Array }
        // BoneEntry: { vis, hit, a, b, visAttr, hitAttr, segments }.
        this.groups       = new Map();

        // Cache of skeleton/rigid-pair lists. Identity-stable across
        // frames so #syncGroup can do `state.conns === conns` to check
        // for structural change.
        this.skelCache    = new Map();

        // Cache of vertex templates by `radialSegments`. A "template"
        // is a Float32Array of length 2*(N+1)*3 — two rings of N+1
        // points around the X axis at +X=1 (downstream length is
        // applied as a scale).
        this.tubeTemplates = new Map();

        // Materials shared across all bones (immutable across frames).
        this.skeletonMaterial = new THREE.MeshStandardMaterial({
            color: 0xFFFFFF, transparent: true, opacity: 1,
            roughness: 0.2, metalness: 0.1, emissive: 0xEEEEEE, emissiveIntensity: 0.5,
        });
        this.rigidBodyMaterial = new THREE.MeshStandardMaterial({
            color: 0x3B71CA, transparent: true, opacity: 0.7,
            roughness: 0.3, metalness: 0.6,
        });
        this.chainMaterial = new THREE.MeshStandardMaterial({
            color: 0xEA580C, transparent: true, opacity: 0.9,
            roughness: 0.25, metalness: 0.1, emissive: 0xEA580C, emissiveIntensity: 0.3,
        });
        this.hitMaterial = new THREE.MeshBasicMaterial({
            transparent: true, opacity: 0,
            depthWrite: false, colorWrite: false,
            side: THREE.DoubleSide,
        });
        this.hoverMaterial = new THREE.MeshBasicMaterial({
            color: 0xFFFFFF, transparent: true, opacity: 0.55,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });

        // Ghost overlay: per-take tinted materials, created at toggle time
        // (never per frame). null = ghost off.
        this.ghostTints     = null;            // Map<takeId, { color, dim }>
        this.ghostMaterials = new Map();       // takeId → MeshStandardMaterial

        this.hoverOverlay = new THREE.Mesh(undefined, this.hoverMaterial);
        this.hoverOverlay.visible = false;
        this.hoverOverlay.userData.isOverlay = true;
        this.scene.add(this.hoverOverlay);
    }

    /** Enable/disable ghost overlay. `tints` = Map<takeId, { color, dim }>
     *  or null to restore the shared materials. Materials are swapped at
     *  the next (re)build — callers follow with a rebuild. */
    setGhost(tints) {
        this.ghostTints = tints || null;
        for (const m of this.ghostMaterials.values()) m.dispose();
        this.ghostMaterials.clear();
        if (!tints) return;
        for (const [takeId, t] of tints) {
            this.ghostMaterials.set(takeId, new THREE.MeshStandardMaterial({
                color: t.color, transparent: true,
                opacity: t.dim ? 0.4 : 0.9,
                depthWrite: !t.dim,            // dimmed slaves layer translucently
                roughness: 0.25, metalness: 0.1,
                emissive: t.color, emissiveIntensity: t.dim ? 0.25 : 0.4,
            }));
        }
    }

    /** Material for a take's bones: ghost tint when enabled, else the
     *  shared default. Resolved at mesh (re)creation only. */
    #materialFor(takeId, fallback) {
        return (this.ghostTints && this.ghostMaterials.get(takeId)) || fallback;
    }

    setConfig(cfg) {
        Object.assign(this.config, cfg);
        // Width changed? Templates need to scale per call anyway; no
        // template invalidation needed since templates are radius-1.
    }

    // ── Per-frame update entry points ─────────────────────────────

    updateSkeletonConnections(takeId, frame, objectName, metadata) {
        const conns = this.#skeletonConns(objectName, metadata);
        if (!conns?.length) return;
        this.#syncGroup(`skeleton:${takeId}:${objectName}`, takeId, objectName,
            conns, this.config.boneWidth, this.#materialFor(takeId, this.skeletonMaterial), 8);
    }

    updateRigidBodyConnections(takeId, frame, objectName) {
        const objs  = frame.objects[objectName];
        const names = Object.keys(objs);
        if (names.length <= 1) return;
        const conns = this.#rigidPairs(`rigidbody:${takeId}:${objectName}`, names);
        this.#syncGroup(`rigidbody:${takeId}:${objectName}`, takeId, objectName,
            conns, this.config.boneWidth * 0.6, this.#materialFor(takeId, this.rigidBodyMaterial), 6);
    }

    updateChainConnections(takeId, frame, objectName, metadata) {
        const conns = metadata?.objects?.[objectName]?.connections;
        if (!conns?.length) return;
        this.#syncGroup(`chain:${takeId}:${objectName}`, takeId, objectName,
            conns, this.config.boneWidth * 0.8, this.#materialFor(takeId, this.chainMaterial), 8);
    }

    // ── Hover ─────────────────────────────────────────────────────

    setHover(takeId, objectName, jointA, jointB) {
        this.hovered = (takeId && objectName && jointA && jointB)
            ? { takeId, objectName, jointA, jointB } : null;
        this.refitHover();
    }

    clearHover() {
        this.hovered = null;
        this.hoverOverlay.visible = false;
    }

    refitHover() {
        if (!this.hovered) { this.hoverOverlay.visible = false; return; }
        const { takeId, objectName, jointA, jointB } = this.hovered;
        const nA = this.nodeRenderer.getNode(takeId, objectName, jointA);
        const nB = this.nodeRenderer.getNode(takeId, objectName, jointB);
        if (!nA || !nB) { this.hoverOverlay.visible = false; return; }
        // Hover overlay rebuilds its geometry on each fit (rare event).
        this.hoverOverlay.geometry?.dispose();
        this.hoverOverlay.geometry = new THREE.TubeGeometry(
            new THREE.LineCurve3(nA.position, nB.position),
            1, this.config.boneWidth * HOVER_RADIUS_MULT, 8, false
        );
        this.hoverOverlay.visible = true;
    }

    // ── Picking / lifecycle ───────────────────────────────────────

    /** Hit-target Meshes only (the fat invisible tubes). Cached and
     *  invalidated when the bone-pair set changes. */
    getHitTargets() {
        if (!this._hitTargetsCache) {
            const out = [];
            for (const { bones } of this.groups.values()) {
                for (const e of bones.values()) out.push(e.hit);
            }
            this._hitTargetsCache = out;
        }
        return this._hitTargetsCache;
    }

    setTakeVisibility(takeId, visible) {
        const tag = `:${takeId}:`;
        for (const [key, state] of this.groups) {
            if (key.includes(tag)) state.group.visible = visible;
        }
        if (!visible && this.hovered?.takeId === takeId) this.clearHover();
    }

    removeAllConnections() {
        for (const key of [...this.groups.keys()]) this.#disposeGroup(key);
    }

    removeAllConnectionsByTake(takeId) {
        const tag = `:${takeId}:`;
        for (const key of [...this.groups.keys()]) {
            if (key.includes(tag)) this.#disposeGroup(key);
        }
        if (this.hovered?.takeId === takeId) this.clearHover();
    }

    destroy() {
        this.setGhost(null);
        this.removeAllConnections();
        this.skelCache.clear();
        for (const tpl of this.tubeTemplates.values()) tpl.geometry.dispose();
        this.tubeTemplates.clear();
        this.scene.remove(this.hoverOverlay);
        this.hoverOverlay.geometry?.dispose();
        this.skeletonMaterial?.dispose();
        this.rigidBodyMaterial?.dispose();
        this.chainMaterial?.dispose();
        this.hitMaterial?.dispose();
        this.hoverMaterial?.dispose();
    }

    // ── Internals ─────────────────────────────────────────────────

    /** Reuse or create the group for `key`, sync each bone in `conns`
     *  to its current (A,B) endpoints. Connection-list identity is the
     *  signature: cached lists return the same array reference until
     *  invalidation, so `state.conns === conns` is a single pointer
     *  compare (no string allocation). */
    #syncGroup(key, takeId, objectName, conns, radius, material, segments) {
        let state = this.groups.get(key);
        if (!state) {
            state = { group: new THREE.Group(), bones: new Map(), conns: null };
            this.scene.add(state.group);
            this.groups.set(key, state);
        }
        if (state.conns !== conns) {
            this.#reconcileBones(state, conns, takeId, objectName, material, segments);
            state.conns = conns;
        }

        // Per-frame: refresh geometry on each bone whose endpoints exist.
        // Mutates the position attribute in place — no Mesh, no
        // BufferGeometry, no typed-array allocation.
        const tplVis = this.#tubeTemplate(segments);
        const tplHit = this.#tubeTemplate(6);
        for (const entry of state.bones.values()) {
            const nA = this.nodeRenderer.getNode(takeId, objectName, entry.a);
            const nB = this.nodeRenderer.getNode(takeId, objectName, entry.b);
            const ok = nA && nB;
            entry.vis.visible = entry.hit.visible = !!ok;
            if (!ok) continue;
            this.#paintTube(entry.vis, tplVis, nA.position, nB.position, radius);
            this.#paintTube(entry.hit, tplHit, nA.position, nB.position, radius * HIT_RADIUS_MULT);
        }
    }

    /** Bring `state.bones` in line with `conns`. Adds new pairs,
     *  removes stale ones. Called only on conn-list identity change. */
    #reconcileBones(state, conns, takeId, objectName, material, segments) {
        this._hitTargetsCache = null;
        const want = new Set();
        for (const [a, b] of conns) want.add(a + '|' + b);

        // Remove stale entries.
        for (const [connKey, entry] of state.bones) {
            if (want.has(connKey)) continue;
            state.group.remove(entry.vis);
            state.group.remove(entry.hit);
            entry.vis.geometry.dispose();
            entry.hit.geometry.dispose();
            state.bones.delete(connKey);
        }

        // Add new entries. Each gets its own BufferGeometry (the
        // template can't be shared across meshes — every bone needs an
        // independent position attribute) seeded from the template.
        for (const [a, b] of conns) {
            const connKey = a + '|' + b;
            if (state.bones.has(connKey)) continue;
            const ud  = { type: 'bone', takeId, objectName, jointA: a, jointB: b };

            const visGeo = this.#freshTubeGeometryFrom(this.#tubeTemplate(segments));
            const vis = new THREE.Mesh(visGeo, material);
            vis.userData = ud;

            const hitGeo = this.#freshTubeGeometryFrom(this.#tubeTemplate(6));
            const hit = new THREE.Mesh(hitGeo, this.hitMaterial);
            hit.userData = { ...ud, isHitTarget: true };

            state.group.add(vis);
            state.group.add(hit);
            state.bones.set(connKey, { vis, hit, a, b, segments });
        }
    }

    /** Get (or build) the unit tube template for `radialSegments`.
     *  Returns `{ template, indices, normalsTpl }` — the position
     *  attribute is a flat Float32Array. */
    #tubeTemplate(radialSegments) {
        let tpl = this.tubeTemplates.get(radialSegments);
        if (tpl) return tpl;
        // Build a baseline TubeGeometry from a unit X-axis curve at
        // radius 1, length 1. We'll copy its position template into
        // every bone's geometry, then transform per-frame.
        const baseline = new THREE.TubeGeometry(
            new THREE.LineCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)),
            1, 1, radialSegments, false
        );
        tpl = {
            geometry:   baseline,
            positions:  baseline.attributes.position.array.slice(),  // Float32Array copy
            normals:    baseline.attributes.normal?.array?.slice(),
            uvs:        baseline.attributes.uv?.array?.slice(),
            indices:    baseline.index?.array?.slice(),
        };
        this.tubeTemplates.set(radialSegments, tpl);
        return tpl;
    }

    /** Build a fresh BufferGeometry seeded from the template (used at
     *  bone-creation time only, not per-frame). */
    #freshTubeGeometryFrom(tpl) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tpl.positions), 3));
        if (tpl.normals) geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(tpl.normals), 3));
        if (tpl.uvs)     geo.setAttribute('uv',     new THREE.BufferAttribute(new Float32Array(tpl.uvs), 2));
        if (tpl.indices) geo.setIndex(new THREE.BufferAttribute(new Uint16Array(tpl.indices), 1));
        return geo;
    }

    /** Paint `mesh`'s geometry to span the segment from `a` to `b`
     *  with the given `radius`. Mutates the position attribute in
     *  place; no allocations.
     *
     *  Math: the template is a unit tube along +X. We need a frame
     *  (origin = a, direction = b−a, radius = r). For each template
     *  vertex (x, y, z):
     *    - x ∈ [0, 1] is the along-tube parameter → world point is
     *      a + dir·x.
     *    - (y, z) is the radial offset (a unit ring perpendicular to
     *      X at radius 1) → scaled by `r` and rotated into the
     *      tube's frame using `right` and `up` basis vectors.
     */
    #paintTube(mesh, tpl, a, b, radius) {
        _tmpDir.subVectors(b, a);
        const len = _tmpDir.length();
        if (len < 1e-6) { mesh.visible = false; return; }
        _tmpDir.multiplyScalar(1 / len);   // normalised direction

        // Build an orthonormal basis around the dir. Pick the world
        // axis least parallel to `dir` to avoid degeneracies.
        const ref = Math.abs(_tmpDir.y) < 0.99 ? _refUp : _refX;
        _tmpRight.crossVectors(_tmpDir, ref).normalize();
        _tmpUp.crossVectors(_tmpRight, _tmpDir).normalize();

        const src = tpl.positions;
        const dst = mesh.geometry.attributes.position.array;
        for (let i = 0, j = 0; i < src.length; i += 3, j += 3) {
            const tx = src[i];     // 0..1 along tube
            const ty = src[i + 1]; // unit-ring Y
            const tz = src[i + 2]; // unit-ring Z
            const sx = tx * len;   // scale along
            // Center along tube + radial offset on (right, up) basis.
            dst[j]     = a.x + _tmpDir.x * sx + (_tmpRight.x * ty + _tmpUp.x * tz) * radius;
            dst[j + 1] = a.y + _tmpDir.y * sx + (_tmpRight.y * ty + _tmpUp.y * tz) * radius;
            dst[j + 2] = a.z + _tmpDir.z * sx + (_tmpRight.z * ty + _tmpUp.z * tz) * radius;
        }
        mesh.geometry.attributes.position.needsUpdate = true;
        mesh.geometry.computeBoundingSphere();
    }

    /** Cached skeleton connections by (objectName + nodes-list). The
     *  same array reference is returned across frames for the same
     *  metadata, enabling the identity check in `#syncGroup`. */
    #skeletonConns(objectName, metadata) {
        const objMeta = metadata?.objects?.[objectName];
        if (objMeta?.type !== OBJECT_TYPES.SKELETON) return null;
        const nodes = objMeta.nodes || [];
        const cacheKey = objectName + '@' + nodes.join(',');
        let conns = this.skelCache.get(cacheKey);
        if (!conns) {
            const set = new Set(nodes);
            conns = SKELETON_CONNECTIONS.filter(([a, b]) => set.has(a) && set.has(b));
            this.skelCache.set(cacheKey, conns);
        }
        return conns;
    }

    /** Cached rigid-body all-pairs connections. Stable identity per
     *  joint-name set (cache key). */
    #rigidPairs(groupKey, names) {
        const cacheKey = groupKey + '@' + names.join(',');
        let conns = this.skelCache.get(cacheKey);
        if (!conns) {
            conns = [];
            for (let i = 0; i < names.length; i++)
                for (let j = i + 1; j < names.length; j++)
                    conns.push([names[i], names[j]]);
            this.skelCache.set(cacheKey, conns);
        }
        return conns;
    }

    #disposeGroup(key) {
        const state = this.groups.get(key);
        if (!state) return;
        this._hitTargetsCache = null;
        for (const entry of state.bones.values()) {
            entry.vis.geometry.dispose();
            entry.hit.geometry.dispose();
        }
        this.scene.remove(state.group);
        this.groups.delete(key);
    }
}
