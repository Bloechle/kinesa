/**
 * SceneOrchestrator.js — Animate loop + per-take scene lifecycle.
 *
 * Owns the requestAnimationFrame loop and the rules that translate
 * "current take registry state" into "what each take's meshes should
 * look like right now":
 *   - Build meshes for newly-added takes
 *   - Tear down meshes for removed takes (signals out via `onTakeRemoved`)
 *   - Apply per-take visibility (hidden + out-of-range = invisible)
 *   - Apply per-frame position (mesh position = frameData[localIdx])
 *   - Forward spatial offsets to the SceneRenderer
 *   - Tick the trails fade once per animate frame
 *
 * Does NOT own:
 *   - The timeline slider state (KinesaApp bridges that)
 *   - Selection cleanup (KinesaApp routes via `onTakeRemoved` callback)
 *   - Graph cache cleanup (same — `onTakeRemoved` callback)
 *   - The first-take playback bind (KinesaApp does it once on master
 *     registration, before passing reconciliation off to us)
 *
 * Public API:
 *   - start()                — begin the rAF loop
 *   - stop()                 — cancel it
 *   - reconcile()            — idempotent state pass; call on Takes 'change'
 *   - renderTakeFrame(take)  — paint one take at the current playhead
 *   - rebuildAll()           — re-create every take's meshes (after a
 *                              global config change like joint sizes)
 *
 * `onTakeRemoved(takeId)` is fired (sync) for each take that disappears
 * during reconcile so callers can cascade cleanup (Selection, charts).
 */

import { clamp } from 'qry-kit';

export class SceneOrchestrator {
    #sceneManager;
    #sceneRenderer;
    #playback;
    #takes;
    #onTakeRemoved;

    #scenedTakeIds = new Set();
    #rafHandle    = 0;
    #running      = false;
    #ghost        = false;
    #ghostSig     = '';

    constructor({ sceneManager, sceneRenderer, playback, takes, onTakeRemoved }) {
        this.#sceneManager  = sceneManager;
        this.#sceneRenderer = sceneRenderer;
        this.#playback      = playback;
        this.#takes         = takes;
        this.#onTakeRemoved = onTakeRemoved || (() => {});
    }

    // ── Animate loop ──────────────────────────────────────────────

    start() {
        if (this.#running) return;
        this.#running = true;
        this.#tick();
    }

    stop() {
        this.#running = false;
        if (this.#rafHandle) cancelAnimationFrame(this.#rafHandle);
        this.#rafHandle = 0;
    }

    #tick = () => {
        if (!this.#running) return;
        this.#rafHandle = requestAnimationFrame(this.#tick);

        const delta = this.#sceneManager.clock.getDelta();
        this.#playback.advance(delta);

        // Single trails tick per animate frame — all takes' addPosition
        // calls below see the same master-time snapshot so multi-take
        // playback doesn't trigger spurious time-jump clears.
        const fps        = this.#playback.sourceFrameRate || 30;
        const masterTime = this.#playback.currentFrame / fps;
        this.#sceneRenderer.tickTrails(masterTime);

        for (const take of this.#takes.all()) this.renderTakeFrame(take, masterTime);
        this.#sceneManager.render();
    };

    // ── State reconciliation ──────────────────────────────────────

    /** Bring scene state in line with the registry. Call on Takes
     *  'change'. Idempotent. */
    reconcile() {
        // Refresh ghost tints BEFORE building, so a take dropped while
        // ghost is on gets its tinted materials at creation. When the
        // tint set actually changed (take added/removed, master swap),
        // existing meshes hold stale materials — rebuild below.
        const ghostChanged = this.#applyGhost();
        this.#buildNewTakes();
        this.#removeGoneTakes();
        if (ghostChanged) this.rebuildAll();
        // Re-apply spatial offsets + per-frame visibility for every take
        // (catches X-shift nudges and toggle-visible without waiting for
        // the next rAF tick).
        for (const take of this.#takes.all()) {
            this.#sceneRenderer.setSpatialOffsetFor(take.id, take.spatialOffset);
            this.renderTakeFrame(take);
        }
    }

    /** Apply visibility + per-frame position for one take. Visibility =
     *  take.visible && in-range. Used by both the rAF loop (every frame)
     *  and `reconcile` (catch up just-toggled-on / freshly-added takes
     *  before the next paint). */
    renderTakeFrame(take, masterTime) {
        const localIdx = this.#playback.currentFrame - (take.offset | 0);
        const inRange  = localIdx >= 0 && localIdx < take.frameData.length;
        const show     = take.visible && inRange;
        this.#sceneRenderer.setTakeVisibility(take.id, show);
        if (!show) return;

        const t = Number.isFinite(masterTime)
            ? masterTime
            : this.#playback.currentFrame / (this.#playback.sourceFrameRate || 30);
        this.#sceneRenderer.updateObjectsForTake(take.id, take.frameData[localIdx], t);
    }

    /** Ghost overlay: superimpose every take at its recorded position
     *  (tiling/nudge offsets ignored), bones tinted per take — master
     *  solid, slaves translucent. Visual comparison of aligned takes.
     *  Returns the new state. */
    toggleGhost() {
        this.#ghost = !this.#ghost;
        this.#applyGhost();
        this.rebuildAll();
        return this.#ghost;
    }

    get ghostEnabled() { return this.#ghost; }

    /** Push the current tint set to the renderer — but ONLY when it
     *  differs from what's already applied. setGhost replaces (and
     *  disposes) the per-take materials, which live meshes reference
     *  until the next rebuild; skipping no-op applies keeps routine
     *  reconciles (nudges, visibility, locks) free of material churn.
     *  Returns true when the renderer state changed (caller rebuilds). */
    #applyGhost() {
        if (!this.#ghost) {
            if (!this.#ghostSig) return false;
            this.#ghostSig = '';
            this.#sceneRenderer.setGhost(null);
            return true;
        }
        const masterId = this.#takes.masterId?.();
        const tints = new Map();
        for (const t of this.#takes.all()) {
            tints.set(t.id, { color: t.color, dim: t.id !== masterId });
        }
        const sig = [...tints].map(([id, t]) => `${id}:${t.color}:${t.dim ? 1 : 0}`).join('|');
        if (sig === this.#ghostSig) return false;
        this.#ghostSig = sig;
        this.#sceneRenderer.setGhost(tints);
        return true;
    }

    /** Re-create every take's meshes at the current master frame. Used
     *  after a global scene config change (joint size / colour, etc.). */
    rebuildAll() {
        for (const take of this.#takes.all()) {
            const localIdx = this.#playback.currentFrame - (take.offset | 0);
            const i = clamp(localIdx, 0, take.frameData.length - 1);
            const frame = take.frameData[i];
            if (frame) this.#sceneRenderer.rebuild(take.id, frame);
        }
    }

    // ── Internals ─────────────────────────────────────────────────

    /** Newly-appeared takes: build their meshes once at the current
     *  master frame (with POI-derived offset applied) so they appear in
     *  the right spot rather than flashing through frame 0. */
    #buildNewTakes() {
        const masterIdx = this.#playback.currentFrame;
        for (const take of this.#takes.all()) {
            if (this.#scenedTakeIds.has(take.id)) continue;
            this.#sceneRenderer.setMetadataFor(take.id, take.metadata);
            this.#sceneRenderer.setSpatialOffsetFor(take.id, take.spatialOffset);
            const localIdx  = masterIdx - (take.offset | 0);
            const initFrame = (localIdx >= 0 && localIdx < take.frameData.length)
                ? take.frameData[localIdx]
                : take.frameData[0];
            if (initFrame) {
                this.#sceneRenderer.createObjectsForTake(take.id, initFrame);
                this.#scenedTakeIds.add(take.id);
            }
        }
    }

    /** Takes that disappeared from the registry: tear down meshes and
     *  fire the onTakeRemoved callback so the caller can cascade
     *  selection / chart cleanup. */
    #removeGoneTakes() {
        for (const id of [...this.#scenedTakeIds]) {
            if (this.#takes.byId(id)) continue;
            this.#sceneRenderer.removeTake(id);
            this.#scenedTakeIds.delete(id);
            this.#onTakeRemoved(id);
        }
    }
}
