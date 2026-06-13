/**
 * Takes.js — Multi-take registry.
 *
 * A "take" is a loaded mocap recording: its processed frame data, its
 * metadata, frame and spatial offsets for alignment, and a few UI-side
 * bits (display name, tint colour, visibility).
 *
 * Master / slave model:
 *   - The first take added becomes the **master** — it's the alignment
 *     reference. Its offset is permanently 0; it can't be removed.
 *   - Subsequent takes are **slaves**. They get an auto-aligned `offset`
 *     (frame shift on the master timeline) so their POI lands on the
 *     master's POI; failing that, offset stays at 0. Slaves also get an
 *     auto-tiled `spatialOffset.x` (+1.5 m per slave) so loaded
 *     skeletons don't visually overlap in the 3D scene.
 *
 * Emits 'change' on every state mutation. The detail is the live array
 * of takes. Subscribers (SceneRenderer routing, ChartWidget, TakeStrip,
 * SelectedStrip) all re-derive from `all()` on each event.
 */

const TAKE_TINTS = [
    '#005395',  // UNIFR Blue
    '#DC143C',  // Crimson
    '#228B22',  // Forest Green
    '#FF8C00',  // Dark Orange
    '#800080',  // Purple
    '#008080',  // Teal
];

/** Auto-tile X offset per slave (in metres). The Nth slave loads at
 *  N × this value on the X axis so the loaded skeletons don't overlap
 *  visually. Manual `nudgeX` from the chip controls overrides. */
const SLAVE_AUTOTILE_M = 1.5;

/** Absolute frame number of a take's first frame, or 0 if missing. */
export const takeFirstFrame = (take) => take?.frameData?.[0]?.frame ?? 0;

/** Absolute frame number of a take's last frame, or (length-1) if missing. */
export const takeLastFrame = (take) => {
    const f = take?.frameData;
    if (!f?.length) return 0;
    return f[f.length - 1].frame ?? (f.length - 1);
};

export class Takes extends EventTarget {
    #takes    = new Map();
    #masterId = null;   // first-loaded take's id — non-deletable
                        // reference, also drives the master playhead.
    #seq      = 0;

    /** Add a freshly-processed take. Returns the registered Take object.
     *  The first take registered becomes the **master** — it's the
     *  reference whose timeline drives the master playhead, can't be
     *  removed, and stays "active" for the lifetime of the registry.
     *  Subsequent takes get their offset auto-set so their POI lands on
     *  the master take's POI (when both have a POI in their metadata).
     *  Already-registered takes keep their offsets — manual alignment
     *  work is never silently overwritten.
     *  Slaves are also auto-tiled in world X (+1.5 m per slave) so the
     *  loaded skeletons don't overlap visually. */
    add({ name, frameData, metadata, sourceFrameRate, processor = null }) {
        const id    = `t${++this.#seq}`;
        const tint  = TAKE_TINTS[(this.#takes.size) % TAKE_TINTS.length];
        const isMaster = !this.#masterId;
        const sizeBefore = this.#takes.size;
        const take  = {
            id, name, color: tint,
            visible: true, offset: 0, locked: false,
            spatialOffset: { x: isMaster ? 0 : sizeBefore * SLAVE_AUTOTILE_M, y: 0, z: 0 },
            frameData, metadata, sourceFrameRate, processor,
        };
        this.#takes.set(id, take);
        if (isMaster) {
            this.#masterId = id;
        } else {
            this.#alignTakeToMasterByPoi(take);
        }
        this.#emit('add', id);
        return take;
    }

    /** Remove a take. The master take cannot be removed — calls with the
     *  master's id are silently ignored. */
    remove(id) {
        if (id === this.#masterId || !this.#takes.has(id)) return;
        this.#takes.delete(id);
        this.#emit('remove', id);
    }

    setVisible(id, visible) {
        const t = this.#takes.get(id);
        if (!t || t.visible === !!visible) return;
        t.visible = !!visible;
        this.#emit('visibility', id);
    }

    /** Toggle alignment lock on a take. Locked takes are skipped by
     *  `realignAllSlavesByPoi` (and thus by snap-to-peak) so the user's
     *  manually-tuned offset survives. Master is implicitly locked
     *  (offset always 0). */
    setLocked(id, locked) {
        const t = this.#takes.get(id);
        if (!t || t.locked === !!locked) return;
        t.locked = !!locked;
        this.#emit('lock', id);
    }

    /** Set a take's offset directly (e.g. after the user drags its knob
     *  on the timeline slider). No auto-realign happens — this IS the
     *  manual override. */
    setOffset(id, offset) {
        const t = this.#takes.get(id);
        if (!t || t.offset === offset) return;
        t.offset = offset | 0;
        this.#emit('offset', id);
    }

    /** Set a take's world-space spatial offset (in metres). Pass any
     *  subset of `{ x, y, z }`; missing components keep their current
     *  value. Used to keep loaded skeletons from overlapping visually
     *  (auto-tile in X by default; manual nudge via `nudgeX`). */
    setSpatialOffset(id, { x, y, z } = {}) {
        const t = this.#takes.get(id);
        if (!t) return;
        const next = {
            x: x ?? t.spatialOffset.x,
            y: y ?? t.spatialOffset.y,
            z: z ?? t.spatialOffset.z,
        };
        if (next.x === t.spatialOffset.x
         && next.y === t.spatialOffset.y
         && next.z === t.spatialOffset.z) return;
        t.spatialOffset = next;
        this.#emit('spatial', id);
    }

    /** Convenience: nudge a take's spatial offset along X by `dx` metres. */
    nudgeX(id, dx) {
        const t = this.#takes.get(id);
        if (!t || !dx) return;
        t.spatialOffset = { ...t.spatialOffset, x: t.spatialOffset.x + dx };
        this.#emit('spatial', id);
    }

    /** Force a 'change' event without mutating any state. Used after
     *  callers have mutated take fields directly (e.g. during a live
     *  drag) and need to notify subscribers — chip readouts, secondary
     *  knob positions on the slider — to refresh.
     *
     *  Pass a `kind` if you know what changed, so subscribers can take
     *  the cheap path (default 'touch' is the conservative full-refresh). */
    touch(kind = 'touch') { this.#emit(kind); }

    /** Re-derive every UNLOCKED slave's offset from its current POI vs.
     *  master's POI. Used by snap-to-peak after per-take POIs were
     *  updated to per-take peak frames — slaves shift to land on master's
     *  peak. Locked slaves are left alone (manual override survives). */
    realignAllSlavesByPoi() {
        let changed = false;
        for (const t of this.#takes.values()) {
            if (t.id === this.#masterId) continue;
            if (t.locked) continue;
            const old = t.offset;
            this.#alignTakeToMasterByPoi(t);
            if (t.offset !== old) changed = true;
        }
        if (changed) this.#emit('offset', null);
    }

    /** Compute the slider knob descriptors for every slave that has a
     *  POI in its metadata. Each knob's `frame` is the master-timeline
     *  frame where the slave's POI currently lands (after offset).
     *  Used by KinesaApp to feed `TimelineSlider.setSecondaryPois`. */
    secondaryPoiKnobs() {
        const master = this.master();
        if (!master) return [];
        const masterFirst = takeFirstFrame(master);
        const knobs = [];
        for (const t of this.#takes.values()) {
            if (t.id === master.id) continue;
            const tPoi = t.metadata?.pointOfInterest;
            if (tPoi == null) continue;
            knobs.push({
                id:     t.id,
                frame:  masterFirst + (tPoi - takeFirstFrame(t)) + (t.offset | 0),
                color:  t.color,
                name:   t.name,
                offset: t.offset | 0,
                locked: !!t.locked,
            });
        }
        return knobs;
    }

    masterId()   { return this.#masterId; }
    master()     { return this.#takes.get(this.#masterId) || null; }
    isMaster(id) { return id != null && id === this.#masterId; }
    byId(id)     { return this.#takes.get(id) || null; }

    /** Snapshot array of takes — live across frames between mutations.
     *  Rebuilt lazily after an emit so the animate loop iterates a
     *  cached array (no per-frame allocation). Callers must NOT mutate
     *  the returned array; treat as immutable. */
    all() {
        if (!this.#allCache) this.#allCache = [...this.#takes.values()];
        return this.#allCache;
    }
    visible()    { return this.all().filter(t => t.visible); }
    get size()   { return this.#takes.size; }

    clear() {
        if (!this.#takes.size) return;
        this.#takes.clear();
        this.#masterId = null;
        this.#emit();
    }

    /** Align one take's offset against the master take by their POIs.
     *  No-op (offset = 0) if either has no POI in its metadata. */
    #alignTakeToMasterByPoi(take) {
        const master = this.master();
        if (!master) return;
        const masterPoi = master.metadata?.pointOfInterest;
        const tPoi      = take.metadata?.pointOfInterest;
        if (masterPoi == null || tPoi == null) { take.offset = 0; return; }
        take.offset = (masterPoi - takeFirstFrame(master))
                    - (tPoi      - takeFirstFrame(take));
    }

    #allCache = null;

    /** Emit the 'change' event with a discriminator so subscribers can
     *  pick the cheap path. `kind` is one of:
     *    'add' / 'remove'             structural changes (require full
     *                                  scene + chart rebuild)
     *    'offset'                     a take's frame offset moved
     *                                  (charts: shiftTakeLive already
     *                                  handled it during drag; chip
     *                                  readouts only need a refresh)
     *    'visibility' / 'lock' /
     *    'spatial' / 'name' / 'touch' chip refresh / scene visibility;
     *                                  charts unaffected.
     *  `id` is the affected take id (or null if global). */
    #emit(kind = 'touch', id = null) {
        this.#allCache = null;
        this.trigger('change', { kind, id, takes: this.all() });
    }
}
