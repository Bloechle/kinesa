/**
 * SceneCommands.js — Scene-side imperative commands triggered by UI
 * buttons + keyboard.
 *
 *   - toggleFullscreen()      enlarge / restore the player card
 *   - exitFullscreen()        idempotent escape from fullscreen
 *   - toggleGhost()           superimpose takes (ghost comparison)
 *   - toggleFreeMarkers()     show/hide unlabeled markers
 *   - toggleHistory()         show/hide trails
 *   - centerOnSelection()     aim the camera at the average position
 *                             of the selected joints (multi-take aware)
 *   - toggleLegDetection()    detect leg from 3 free markers, or clear
 *
 *  Most commands swap the matching button icon (Lucide) and active
 *  class. Leg detection cascades to a topology refresh callback so
 *  the chart widget can rebuild.
 *
 *  `$` is global from qry.js.
 */

import { icons } from 'qry-kit';

export class SceneCommands {
    #sceneManager;
    #sceneRenderer;
    #orchestrator;
    #playback;
    #takes;
    #selection;
    #onTopologyChange;
    #onFeedback;

    constructor({
        sceneManager, sceneRenderer, orchestrator, playback, takes, selection,
        onTopologyChange, onFeedback,
    }) {
        this.#sceneManager     = sceneManager;
        this.#orchestrator     = orchestrator;
        this.#sceneRenderer    = sceneRenderer;
        this.#playback         = playback;
        this.#takes            = takes;
        this.#selection        = selection;
        this.#onTopologyChange = onTopologyChange || (() => {});
        this.#onFeedback       = onFeedback       || (() => {});
    }

    toggleFullscreen() {
        $('#section-player').cls('~fullscreen');
        const isFs = $('#section-player').cls('?fullscreen');
        this.#swapIcon('#btn-fullscreen', isFs ? 'minimize' : 'maximize');
        this.#sceneManager.onWindowResize();
    }

    exitFullscreen() {
        if (!$('#section-player').cls('?fullscreen')) return;
        $('#section-player').cls('-fullscreen');
        this.#swapIcon('#btn-fullscreen', 'maximize');
        this.#sceneManager.onWindowResize();
    }

    /** Ghost overlay: superimpose takes (master solid, slaves translucent). */
    toggleGhost() {
        const on = this.#orchestrator.toggleGhost();
        $('#btn-ghost').cls(on ? '+active' : '-active');
    }

    toggleFreeMarkers() {
        const visible = !this.#sceneRenderer.unlabeledMarkersVisible;
        this.#sceneRenderer.setUnlabeledMarkersVisibility(visible);
        this.#swapIcon('#btn-free-markers', visible ? 'eye' : 'eye-off');
        $('#btn-free-markers').cls(visible ? '+active' : '-active');
    }

    toggleHistory() {
        const visible = this.#sceneRenderer?.toggleHistoryTrail?.();
        $('#btn-history').cls(visible ? '+active' : '-active');
    }

    centerOnSelection() {
        const selected = this.#selection.all();
        if (!selected.length) return;

        // Average each selected node's WORLD-space position. Slaves
        // have a spatialOffset applied by the SceneRenderer when
        // meshes are placed; reading raw nd.pos misses that, so we
        // add it back here — otherwise centering on a slave joint
        // aims at coordinates that don't match what's visible.
        let cx = 0, cy = 0, cz = 0, n = 0;
        for (const sel of selected) {
            const take = this.#takes.byId(sel.takeId);
            if (!take) continue;
            const localIdx = this.#playback.currentFrame - (take.offset | 0);
            if (localIdx < 0 || localIdx >= take.frameData.length) continue;
            const nd = take.frameData[localIdx]?.objects?.[sel.objectName]?.[sel.nodeName];
            if (!nd?.pos) continue;
            const so = take.spatialOffset || { x: 0, y: 0, z: 0 };
            cx += nd.pos[0] + so.x;
            cy += nd.pos[1] + so.y;
            cz += nd.pos[2] + so.z;
            n++;
        }
        if (n) this.#sceneManager.centerOn({ x: cx / n, y: cy / n, z: cz / n });
    }

    /** Detect (or clear) a kinematic leg from 3 unlabeled markers near
     *  the playhead. Routes back through `onTopologyChange` so the
     *  chart widget can rebuild caches. */
    toggleLegDetection() {
        const master   = this.#takes.master();
        const pipeline = master?.processor;
        if (!pipeline || !master.frameData?.length) {
            this.#onFeedback('No motion data loaded', 'warn');
            return;
        }

        if (pipeline.legIds) {
            pipeline.clearLeg();
            this.#onTopologyChange();
            $('#btn-detect-leg').cls('-active');
            this.#onFeedback('Leg cleared', 'info');
            return;
        }

        const ok = pipeline.detectLegAt(this.#playback.currentFrame);
        if (!ok) {
            this.#onFeedback('No leg detected — need 3 free markers within 1 m', 'warn');
            return;
        }
        this.#onTopologyChange();
        $('#btn-detect-leg').cls('+active');
        this.#onFeedback('Leg detected', 'success');
    }

    // ── Internals ────────────────────────────────────────────────

    #swapIcon(buttonSel, name) {
        const i = document.querySelector(`${buttonSel} i`);
        if (!i) return;
        i.setAttribute('data-lucide', name);
        icons();
    }
}
