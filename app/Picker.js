/**
 * Picker.js — Direct 3D selection on the scene.
 *
 *   Hover  → joint pops to full opacity, or bone overlay appears,
 *            with a floating tooltip ('Object.Joint' or 'Object.A → B').
 *   Click  → joint toggles in Selection;
 *            bone toggles BOTH endpoints (option A semantics):
 *              0 selected → adds the 2
 *              1 selected → adds the missing one (→ 2)
 *              2 selected → removes the 2.
 *
 * Click while OrbitControls is dragging the camera is ignored — drag
 * delta over a small threshold suppresses the click.
 */

import * as THREE from 'three';

import { OBJECT_NAMES, OBJECT_TYPES, nodeKey } from '../lib/object-types.js';
const DRAG_PX_THRESHOLD = 4;

export class Picker {
    #sceneManager;
    #sceneRenderer;
    #selection;
    #takes;
    #raycaster;
    #mouse;
    #canvas;
    #tooltip;
    #downX = 0;
    #downY = 0;
    #moved = false;
    #lastHover   = null;
    #lastHoverUD = null;
    #moveRaf     = 0;
    #pendingMove = null;

    constructor(sceneManager, sceneRenderer, selection, takes) {
        this.#sceneManager  = sceneManager;
        this.#sceneRenderer = sceneRenderer;
        this.#selection     = selection;
        this.#takes         = takes;
        this.#raycaster     = new THREE.Raycaster();
        this.#mouse         = new THREE.Vector2();

        this.#canvas  = sceneManager.renderer?.domElement;
        if (!this.#canvas) return;

        this.#tooltip = this.#createTooltip();
        this.#bind();
    }

    destroy() {
        if (!this.#canvas) return;
        if (this.#moveRaf) cancelAnimationFrame(this.#moveRaf);
        this.#canvas.off('pointermove', this.#onPointerMove);
        this.#canvas.off('pointerdown', this.#onPointerDown);
        this.#canvas.off('pointerup',   this.#onPointerUp);
        this.#canvas.off('pointerleave', this.#onPointerLeave);
        this.#tooltip?.remove();
    }

    // ── Setup ─────────────────────────────────────────────────────────

    #createTooltip() {
        const t = document.createElement('div');
        Object.assign(t.style, {
            position: 'fixed', pointerEvents: 'none', zIndex: '9999',
            padding: '0.25rem 0.5rem', borderRadius: '0.25rem',
            background: 'rgba(20, 20, 20, 0.92)', color: '#fff',
            font: '500 0.75rem ui-sans-serif, system-ui, sans-serif',
            letterSpacing: '0.01em',
            boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
            transform: 'translate(0.75rem, 0.75rem)',
            display: 'none', whiteSpace: 'nowrap',
        });
        document.body.appendChild(t);
        return t;
    }

    #bind() {
        this.#canvas.on('pointermove',  this.#onPointerMove);
        this.#canvas.on('pointerdown',  this.#onPointerDown);
        this.#canvas.on('pointerup',    this.#onPointerUp);
        this.#canvas.on('pointerleave', this.#onPointerLeave);
    }

    // ── Event handlers ────────────────────────────────────────────────

    #onPointerDown = (e) => {
        this.#downX = e.clientX;
        this.#downY = e.clientY;
        this.#moved = false;
    };

    /** Pointer-move handler: coalesces moves to one rAF tick so heavy
     *  raycasts don't run on every native event. The browser fires
     *  pointermove at the device polling rate (often 1000Hz on
     *  high-end mice); pinning to display refresh rate is plenty for
     *  hover feedback. */
    #onPointerMove = (e) => {
        if (e.buttons && (Math.abs(e.clientX - this.#downX) > DRAG_PX_THRESHOLD ||
                          Math.abs(e.clientY - this.#downY) > DRAG_PX_THRESHOLD)) {
            this.#moved = true;
            this.#clearHover();
            this.#pendingMove = null;
            return;
        }
        // Latch the latest event; a rAF callback consumes it.
        this.#pendingMove = e;
        if (this.#moveRaf) return;
        this.#moveRaf = requestAnimationFrame(() => {
            this.#moveRaf = 0;
            const ev = this.#pendingMove;
            this.#pendingMove = null;
            if (!ev) return;
            const hit = this.#pick(ev);
            this.#updateHover(hit, ev.clientX, ev.clientY);
        });
    };

    #onPointerUp = (e) => {
        if (this.#moved) return;
        const hit = this.#pick(e);
        if (!hit) return;
        this.#handleClick(hit);
    };

    #onPointerLeave = () => {
        this.#clearHover();
    };

    // ── Picking ───────────────────────────────────────────────────────

    #pick(e) {
        const rect = this.#canvas.getBoundingClientRect();
        this.#mouse.x = ((e.clientX - rect.left) / this.#canvas.clientWidth)  * 2 - 1;
        this.#mouse.y = -((e.clientY - rect.top)  / this.#canvas.clientHeight) * 2 + 1;
        this.#raycaster.setFromCamera(this.#mouse, this.#sceneManager.camera);

        // Two-pass: joints win over bones. The joint hit-targets are sized
        // to comfortably overlap bone hit-targets near endpoints, so any
        // click in that overlap region resolves to the joint.
        const jointHits = this.#raycaster.intersectObjects(this.#sceneRenderer.getJointHitTargets(), false);
        if (jointHits.length) return jointHits[0].object.userData;

        const boneHits = this.#raycaster.intersectObjects(this.#sceneRenderer.getBoneHitTargets(), false);
        return boneHits.length ? boneHits[0].object.userData : null;
    }

    // ── Hover ─────────────────────────────────────────────────────────

    #updateHover(ud, mouseX, mouseY) {
        // Identify the hovered entity by a stable, take-aware key
        const key = ud
            ? (ud.type === 'bone'
                ? `bone:${ud.takeId}:${ud.objectName}:${ud.jointA}:${ud.jointB}`
                : `node:${ud.takeId}:${ud.objectName}:${ud.nodeName}`)
            : null;

        if (key !== this.#lastHover) {
            this.#applyHover(this.#lastHover, false, this.#lastHoverUD);
            this.#applyHover(key, true, ud);
            this.#lastHover   = key;
            this.#lastHoverUD = ud;
        }

        if (key) this.#showTooltip(ud, mouseX, mouseY);
        else     this.#hideTooltip();
    }

    #clearHover() {
        if (this.#lastHover) this.#applyHover(this.#lastHover, false, this.#lastHoverUD);
        this.#lastHover   = null;
        this.#lastHoverUD = null;
        this.#hideTooltip();
    }

    #applyHover(key, on, ud) {
        if (!key || !ud) return;
        if (ud.type === 'bone') {
            if (on) this.#sceneRenderer.bones.setHover(ud.takeId, ud.objectName, ud.jointA, ud.jointB);
            else    this.#sceneRenderer.bones.clearHover();
        } else {
            this.#sceneRenderer.nodes.setHover(on ? nodeKey(ud.takeId, ud.objectName, ud.nodeName) : null);
        }
    }

    // ── Tooltip ───────────────────────────────────────────────────────

    #showTooltip(ud, x, y) {
        const take = this.#takes?.byId?.(ud.takeId);
        const prefix = (this.#takes?.size > 1 && take) ? `${take.name} · ` : '';
        const body = ud.type === 'bone'
            ? `${ud.objectName} · ${ud.jointA} → ${ud.jointB}`
            : (ud.objectName === OBJECT_NAMES.UNLABELED ? ud.nodeName : `${ud.objectName} · ${ud.nodeName}`);
        this.#tooltip.textContent = prefix + body;
        this.#tooltip.style.left = `${x}px`;
        this.#tooltip.style.top  = `${y}px`;
        this.#tooltip.style.display = '';
    }

    #hideTooltip() {
        this.#tooltip.style.display = 'none';
    }

    // ── Click → Selection ─────────────────────────────────────────────

    #handleClick(ud) {
        if (ud.type === 'bone') {
            this.#toggleBone(ud);
        } else if (ud.nodeName) {
            this.#toggleJoint(ud);
        }
    }

    /** Joint click — plain toggle. */
    #toggleJoint(ud) {
        this.#selection.toggle(ud.takeId, ud.objectName, ud.nodeName, ud.objectType);
    }

    /** Bone click — toggles BOTH endpoints as a unit (option A).
     *    0 selected → add both
     *    1 selected → add the missing one (→ 2)
     *    2 selected → remove both */
    #toggleBone(ud) {
        const { takeId, objectName, jointA, jointB, objectType } = ud;
        const objType = objectType
            || this.#sceneRenderer.getObjectType(takeId, objectName)
            || OBJECT_TYPES.SKELETON;

        const aSel = this.#selection.has(takeId, objectName, jointA);
        const bSel = this.#selection.has(takeId, objectName, jointB);
        const both = aSel && bSel;

        if (both) {
            this.#selection.remove(takeId, objectName, jointA);
            this.#selection.remove(takeId, objectName, jointB);
        } else {
            if (!aSel) this.#selection.add(takeId, objectName, jointA, objType);
            if (!bSel) this.#selection.add(takeId, objectName, jointB, objType);
        }
    }
}
