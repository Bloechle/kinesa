/**
 * PlayerHUD.js — Player card readouts (frame, time, title, play icon).
 *
 * Pure display layer over Playback + Takes. Listens to:
 *   - playback 'load' / 'frame' → refresh frame + time displays
 *   - playback 'playstate'      → swap the play/pause icon
 *   - takes 'change'            → refresh card title
 *
 * Doesn't touch the timeline slider (that's KinesaApp's bridge —
 * different concern: scrubbing math).
 *
 * Targets these IDs in `index.html`:
 *   #frame-display  "Frame N / total"
 *   #time-display   "m:ss.fff"
 *   #player-title   "Kinesa — <master>  +N slaves"
 *   #play-icon      sl-icon name "play-fill" / "pause-fill"
 *
 * Owns no internal state — every read goes through Playback / Takes.
 *
 * `$` is global from qry.js.
 */

export class PlayerHUD {
    #playback;
    #takes;
    #handlers = {};

    constructor(playback, takes) {
        this.#playback = playback;
        this.#takes    = takes;
        this.#bind();
        this.#refreshAll();
    }

    /** Force a full redraw (e.g. on construction or after a reload). */
    #refreshAll() {
        this.#refreshFrame();
        this.#refreshTime();
        this.#refreshTitle();
    }

    destroy() {
        this.#playback?.off('load',      this.#handlers.load);
        this.#playback?.off('frame',     this.#handlers.frame);
        this.#playback?.off('playstate', this.#handlers.playstate);
        this.#takes?.off('change', this.#handlers.takes);
    }

    // ── Internals ───────────────────────────────────────────────

    #bind() {
        this.#handlers.load      = () => { this.#refreshFrame(); this.#refreshTime(); };
        this.#handlers.frame     = () => { this.#refreshFrame(); this.#refreshTime(); };
        this.#handlers.playstate = (e) => $('#play-icon')
            .attr('name', e.detail.playing ? 'pause-fill' : 'play-fill');
        this.#handlers.takes     = () => this.#refreshTitle();

        this.#playback.on('load',      this.#handlers.load);
        this.#playback.on('frame',     this.#handlers.frame);
        this.#playback.on('playstate', this.#handlers.playstate);
        this.#takes?.on('change', this.#handlers.takes);
    }

    #refreshFrame() {
        const frame = this.#playback.currentFrame;
        const total = this.#playback.frameData?.length || 0;
        $('#frame-display').text(`Frame ${total ? frame + 1 : 0} / ${total}`);
    }

    #refreshTime() {
        const t = this.#playback.frameData?.[this.#playback.currentFrame]?.time;
        if (t == null) return;
        // Standard media-player format: m:ss.fff (single-digit minutes since
        // mocap takes are short).
        const m  = Math.floor(t / 60);
        const s  = Math.floor(t % 60);
        const ms = Math.floor((t % 1) * 1000);
        $('#time-display').text(
            `${m}:${String(s).padStart(2,'0')}.${String(ms).padStart(3,'0')}`
        );
    }

    #refreshTitle() {
        const master = this.#takes?.master?.();
        if (!master) {
            $('#player-title').text('Kinesa');
            return;
        }
        const slaves = (this.#takes.size || 1) - 1;
        const tail   = slaves > 0 ? `  +${slaves} slave${slaves > 1 ? 's' : ''}` : '';
        $('#player-title').text(`Kinesa — ${master.name}${tail}`);
    }
}
