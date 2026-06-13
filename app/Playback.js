/**
 * Playback.js - Motion capture playback state machine
 *
 * Drives the master timeline: which frame is "now", play/pause, scrubbing,
 * speed, optional sub-range confinement. Exposes the active take's frame
 * data and metadata for downstream consumers (scene, charts).
 *
 * Multi-take aware: processing lives outside (in KinesaApp via the
 * Pipeline class). Playback no longer parses raw JSON — it just holds a
 * reference to whichever Take is currently active and drives its
 * timeline.
 */

import { clamp } from 'qry-kit';

export class Playback extends EventTarget {
    #activeTake = null;

    frameData = [];
    metadata = null;
    sourceFrameRate = 30;
    frameInterval = 0;

    currentFrame = 0;
    isPlaying = false;
    playSpeed = 1.0;

    #accTime = 0;
    #rangeIdx = null;   // { startIdx, endIdx } | null — confines advance() loop

    /** `selection` is accepted for API symmetry but currently unused —
     *  Playback doesn't read selection state. Kept in the constructor
     *  signature so future features (e.g. mute-when-not-selected) can
     *  use it without a breaking API change. */
    constructor(_selection) {
        super();
    }

    /** Currently active take's id (null if none). */
    get activeTakeId() { return this.#activeTake?.id || null; }

    /**
     * Switch which take's timeline drives playback. Pass null to clear.
     * Resets the playhead to frame 0, pauses playback, drops any sub-range
     * confinement. Emits 'load' / 'playstate' / 'frame' so downstream UIs
     * refresh from scratch.
     */
    setActiveTake(take) {
        this.#activeTake = take || null;
        if (!take) {
            this.frameData       = [];
            this.metadata        = null;
            this.sourceFrameRate = 30;
            this.frameInterval   = 0;
        } else {
            this.frameData       = take.frameData;
            this.metadata        = take.metadata;
            this.sourceFrameRate = take.sourceFrameRate;
            this.frameInterval   = 1.0 / take.sourceFrameRate;
        }
        this.currentFrame = 0;
        this.isPlaying    = false;
        this.#accTime     = 0;
        this.#rangeIdx    = null;

        this.#emit('load',      { frames: this.frameData.length, fps: this.sourceFrameRate });
        this.#emit('playstate', { playing: false });
        this.#emit('frame',     { frame: 0, total: this.frameData.length });
    }

    /**
     * Confine playback to a sub-range of the take. When set, advance()
     * wraps at endIdx → startIdx instead of the full-take bounds, and
     * pressing play outside the range seeks to startIdx first.
     * Pass null to clear (full-take playback).
     *
     * @param {{startFrame:number, endFrame:number}|null} absRange
     *        Absolute frame numbers (as in frame.frame), not indices.
     */
    setPlaybackRange(absRange) {
        if (!absRange || !this.frameData.length) { this.#rangeIdx = null; return; }
        const s = this.#absToIndex(absRange.startFrame);
        const e = this.#absToIndex(absRange.endFrame);
        this.#rangeIdx = (s != null && e != null && s < e) ? { startIdx: s, endIdx: e } : null;
    }

    #absToIndex(absFrame) {
        if (!this.frameData.length) return null;
        const first = this.frameData[0].frame ?? 0;
        const idx   = absFrame - first;
        if (idx < 0 || idx >= this.frameData.length) return null;
        return idx;
    }

    togglePlayPause() {
        this.isPlaying = !this.isPlaying;
        if (this.isPlaying) {
            this.#accTime = 0;
            // If starting play outside the confined range, snap to its start
            if (this.#rangeIdx) {
                const { startIdx, endIdx } = this.#rangeIdx;
                if (this.currentFrame < startIdx || this.currentFrame > endIdx) {
                    this.setFrame(startIdx);
                }
            }
        }
        this.#emit('playstate', { playing: this.isPlaying });
    }

    advance(delta) {
        if (!this.isPlaying || !this.frameData.length) return false;

        this.#accTime += delta * this.playSpeed;
        if (this.#accTime < this.frameInterval) return false;

        const skip = Math.floor(this.#accTime / this.frameInterval);
        this.#accTime -= this.frameInterval * skip;

        let next;
        if (this.#rangeIdx) {
            const { startIdx, endIdx } = this.#rangeIdx;
            const span = endIdx - startIdx + 1;
            const base = (this.currentFrame < startIdx || this.currentFrame > endIdx)
                ? startIdx
                : this.currentFrame;
            next = startIdx + ((base - startIdx + skip) % span);
        } else {
            next = (this.currentFrame + skip) % this.frameData.length;
        }

        if (next === this.currentFrame) return false;

        this.currentFrame = next;
        this.#emit('frame', { frame: this.currentFrame, total: this.frameData.length });
        return true;
    }

    setFrame(idx) {
        if (!this.frameData.length) return;
        const old = this.currentFrame;
        this.currentFrame = clamp(idx, 0, this.frameData.length - 1);
        if (old !== this.currentFrame) {
            this.#emit('frame', { frame: this.currentFrame, total: this.frameData.length });
        }
    }

    setPlaySpeed(speed) {
        this.playSpeed = clamp(speed, 0.1, 2.0);
    }

    getObjectType(objectName) {
        return this.metadata?.objects?.[objectName]?.type || 'undefined';
    }

    #emit(name, detail) {
        this.trigger(name, detail);
    }

    destroy() {
        this.isPlaying = false;
        this.frameData = [];
        this.#activeTake = null;
    }
}
