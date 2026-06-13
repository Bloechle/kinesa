/**
 * SceneRenderer.js - Orchestrates 3D visualisation of motion capture data.
 *
 * Multi-take aware: holds per-take metadata, exposes `createObjectsForTake`
 * / `updateObjectsForTake`, and routes the Selection's 3-part keys to the
 * appropriate Nodes/Bones meshes (which themselves carry takeId in
 * userData and key everything by `${takeId}:${object}:${node}`).
 *
 * Picking lives in app/Picker.js.
 */

import * as THREE from 'three';
import { Nodes }         from './Nodes.js';
import { Bones }         from './Bones.js';
import { Trails }        from './Trails.js';
import { threeHelpers }  from '../lib/three-helpers.js';
import { OBJECT_TYPES, OBJECT_NAMES, isHeadOrHip } from '../lib/object-types.js';

export class SceneRenderer {
    constructor(sceneManager, selection, config) {
        this.sceneManager = sceneManager;
        this.selection    = selection;
        this.metadataByTake  = new Map();   // takeId → metadata
        this.spatialOffsets  = new Map();   // takeId → { x, y, z }
        this.ghostMode       = false;       // overlay takes at recorded positions
        this._lastVis        = new Map();   // takeId → boolean (idempotency cache)

        this.nodes  = new Nodes(sceneManager.scene, config);
        this.bones  = new Bones(sceneManager.scene, this.nodes, config);
        this.trails = new Trails(sceneManager.scene);

        this.unlabeledMarkersVisible = false;

        // Per-frame state for the highlight callback. Set by
        // #processObject before invoking nodes.applyFrame so the
        // callback (declared once) can read the current time without
        // re-allocating a closure per frame.
        this._frameTime = 0;
        this._onHighlightedMesh = (mesh, key, color) => {
            this.trails.addPositionToHistory(key, mesh.position, this._frameTime, color);
        };

        this._onSelectionChange = () => this.#syncHighlights();
        this.selection.on('change', this._onSelectionChange);
        this.#addAxes();
    }

    // ── Public API ──────────────────────────────────────────

    setMetadataFor(takeId, meta) {
        if (!takeId) return;
        if (meta) this.metadataByTake.set(takeId, meta);
        else      this.metadataByTake.delete(takeId);
    }

    /** Set the world-space spatial offset for a take. Subsequent calls to
     *  `createObjectsForTake` / `updateObjectsForTake` translate every
     *  joint/marker position by `(x,y,z)` before placing the mesh. */
    setSpatialOffsetFor(takeId, offset) {
        if (!takeId) return;
        if (offset) this.spatialOffsets.set(takeId, offset);
        else        this.spatialOffsets.delete(takeId);
    }

    getObjectType(takeId, name) {
        return this.metadataByTake.get(takeId)?.objects?.[name]?.type || 'undefined';
    }

    setConfig(cfg) {
        this.nodes.setConfig(cfg);
        this.bones.setConfig(cfg);
    }

    setUnlabeledMarkersVisibility(visible) {
        this.unlabeledMarkersVisible = visible;
        this.nodes.setUnlabeledMarkersVisibility(visible);
    }

    toggleHistoryTrail() { return this.trails.toggleHistoryVisibility(); }

    /** Re-create a single take's meshes from its current frame. */
    rebuild(takeId, frame) {
        if (!takeId || !frame) return;
        this.createObjectsForTake(takeId, frame);
        this.#syncHighlights();
    }

    createObjectsForTake(takeId, frame) {
        // Wipe THIS take's existing meshes only (other takes untouched).
        this.nodes.removeAllNodesByTake(takeId);
        this.bones.removeAllConnectionsByTake(takeId);

        for (const obj in frame.objects) this.#processObject(takeId, obj, frame, true);
        this.nodes.setUnlabeledMarkersVisibility(this.unlabeledMarkersVisible);
        this.nodes.refitHover();
        this.bones.refitHover();
    }

    updateObjectsForTake(takeId, frame, masterTime) {
        // Unlabeled markers used to be removed + re-created per frame.
        // Now they're reconciled in place by `#processObject` (added when
        // they first appear, position-updated when present, hidden when
        // absent), saving thousands of mesh allocations per second.
        const t = Number.isFinite(masterTime) ? masterTime : (frame.time ?? performance.now() / 1000);

        for (const obj in frame.objects) this.#processObject(takeId, obj, frame, false, t);

        if (frame.objects.Unlabeled) this.nodes.setUnlabeledMarkersVisibility(this.unlabeledMarkersVisible);
        this.nodes.refitHover();
        this.bones.refitHover();
    }

    /** Tick the trails fade once per animate frame. Pass the master-time
     *  index (master-frame / fps); KinesaApp calls this BEFORE iterating
     *  the takes so all add-position calls see a consistent time. */
    tickTrails(masterTime) {
        this.trails.updateHistory(masterTime);
    }

    /** Drop a take entirely (selection cleanup is the caller's
     *  responsibility — Selection.removeByTake). */
    removeTake(takeId) {
        this.nodes.removeAllNodesByTake(takeId);
        this.bones.removeAllConnectionsByTake(takeId);
        this.metadataByTake.delete(takeId);
        this.spatialOffsets.delete(takeId);
        this._lastVis.delete(takeId);
    }

    /** Hide / show every mesh that belongs to a take (joints + bones).
     *  Cheap-skip when the visibility state hasn't changed since the
     *  previous call (the animate loop hits this every frame and the
     *  desired state is constant most of the time). */
    /** Ghost overlay on/off. `tints` = Map<takeId, { color, dim }> or null. */
    setGhost(tints) {
        this.ghostMode = !!tints;
        this.bones.setGhost(tints);
    }

    setTakeVisibility(takeId, visible) {
        if (this._lastVis.get(takeId) === visible) return;
        this._lastVis.set(takeId, visible);
        this.nodes.setTakeVisibility(takeId, visible);
        this.bones.setTakeVisibility(takeId, visible);
        if (visible) this.nodes.setUnlabeledMarkersVisibility(this.unlabeledMarkersVisible);
    }

    /** Picker raycasts joints first, bones second. Returned arrays span
     *  every loaded take. */
    getJointHitTargets() { return this.nodes.getHitTargets(); }
    getBoneHitTargets()  { return this.bones.getHitTargets(); }

    /** Convenience: every visible joint mesh (used by camera-centering). */
    getAllNodes() { return this.nodes.getAllNodes(); }

    destroy() {
        if (this._onSelectionChange) {
            this.selection?.off('change', this._onSelectionChange);
        }
        this.nodes.destroy();
        this.bones.destroy();
        this.trails.destroy();
        this.metadataByTake.clear();
        this.spatialOffsets.clear();
        this._lastVis.clear();
    }

    // ── Internals ───────────────────────────────────────────

    #processObject(takeId, objectName, frame, isCreating, currentTime) {
        const objectType = this.getObjectType(takeId, objectName);
        // Ghost overlay: ignore tiling/nudge offsets so takes superimpose.
        const so   = this.ghostMode ? null : this.spatialOffsets.get(takeId);
        const sox  = so?.x || 0, soy = so?.y || 0, soz = so?.z || 0;
        const objs = frame.objects[objectName];

        if (objectName === OBJECT_NAMES.UNLABELED) {
            this.#processUnlabeled(takeId, objs, isCreating, sox, soy, soz, currentTime);
            return;
        }

        if (isCreating) {
            // Create on first frame: walks all joints once, attaching
            // axis helpers to special joints. Not on the hot path.
            for (const nodeName in objs) {
                const nd = objs[nodeName];
                if (!nd.pos) continue;
                const adjPos = (sox || soy || soz)
                    ? [nd.pos[0] + sox, nd.pos[1] + soy, nd.pos[2] + soz]
                    : nd.pos;
                const node = this.nodes.createNode(takeId, objectName, nodeName, objectType,
                    adjPos, nd.quat || nd.rot, !!nd.quat);
                if (objectType === OBJECT_TYPES.RIGIDBODY) node.add(threeHelpers.createAxes({ length: 0.15, name: 'RigidBodyAxes' }));
                if (objectType === OBJECT_TYPES.SKELETON && isHeadOrHip(nodeName))
                    node.add(threeHelpers.createAxes({ length: 0.12, name: 'OrientAxes' }));
            }
        } else {
            // Hot path: Nodes owns the per-frame update + highlight
            // dispatch via a hoisted callback. No reaching into .nodes /
            // .highlightedNodes from here, no per-frame closure alloc.
            this._frameTime = currentTime;
            this.nodes.applyFrame(takeId, objectName, objs, sox, soy, soz, this._onHighlightedMesh);
        }

        const meta = this.metadataByTake.get(takeId);
        if (objectType === OBJECT_TYPES.SKELETON)       this.bones.updateSkeletonConnections(takeId, frame, objectName, meta);
        else if (objectType === OBJECT_TYPES.RIGIDBODY) this.bones.updateRigidBodyConnections(takeId, frame, objectName);
        else if (objectType === OBJECT_TYPES.CHAIN)     this.bones.updateChainConnections(takeId, frame, objectName, meta);
    }

    /** Reconcile-style update for the Unlabeled marker set: create
     *  newcomers, position-update existing, hide ones that vanished. No
     *  mesh churn per frame. */
    #processUnlabeled(takeId, objs, isCreating, sox, soy, soz, currentTime) {
        if (isCreating) {
            for (const name in objs) {
                const nd = objs[name];
                if (!nd.pos) continue;
                const adjPos = (sox || soy || soz)
                    ? [nd.pos[0] + sox, nd.pos[1] + soy, nd.pos[2] + soz]
                    : nd.pos;
                this.nodes.createNode(takeId, OBJECT_NAMES.UNLABELED, name, OBJECT_TYPES.MARKER, adjPos);
            }
            this.nodes.setUnlabeledMarkersVisibility(this.unlabeledMarkersVisible);
            return;
        }

        // Update path: Nodes owns the reconcile loop + highlight
        // dispatch via the same hoisted callback as #processObject.
        this._frameTime = currentTime;
        this.nodes.applyUnlabeledFrame(takeId, objs, sox, soy, soz, this._onHighlightedMesh);
    }

    #syncHighlights() {
        // Build one Map<key, selectionEntry> walked twice: removal pass
        // (drop highlights no longer in the target set) and add pass
        // (apply newly-selected). Replaces the prior O(N²) lookup that
        // did `selected.find()` per target.
        const targetMap = new Map();
        for (const n of this.selection.all()) {
            targetMap.set(Nodes.keyOf(n.takeId, n.objectName, n.nodeName), n);
        }

        // Remove highlights no longer in the target set.
        for (const key of this.nodes.highlightedKeys()) {
            if (targetMap.has(key)) continue;
            if (this.nodes.unhighlightByKey(key)) this.trails.clearNodeHistory(key);
        }

        // Add / update highlights to match the target set.
        for (const [key, sel] of targetMap) {
            if (this.nodes.highlightColor?.(key) === sel.color) continue;
            this.nodes.highlightNode(sel.takeId, sel.objectName, sel.nodeName, sel.color);
            // Seed an initial trail dot at the joint's current position
            // so the user sees feedback immediately on selection.
            const mesh = this.nodes.getNode(sel.takeId, sel.objectName, sel.nodeName);
            if (mesh) this.trails.addPositionToHistory(key, mesh.position, performance.now() / 1000, sel.color);
        }
    }

    #addAxes() {
        this.sceneManager.add(threeHelpers.createSceneAxes({
            position: [-5, 0.01, -5], length: 1, withLabels: true, addOriginMarker: true, name: 'SceneAxes',
        }));
    }
}
