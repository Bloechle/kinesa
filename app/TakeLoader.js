/**
 * TakeLoader.js — Single entry point for ingesting one mocap file into
 * the Takes registry.
 *
 * Wraps the full load pipeline:
 *   1. Process raw motion data via a fresh `Pipeline` (Motive CSV /
 *      TOPLabs JSON / pre-processed re-import all flow through here).
 *   2. Extract a stable user-facing take name from filename / metadata.
 *   3. Default the POI to the middle frame when source declares none.
 *   4. Look up the SessionStore for a remembered alignment by name.
 *   5. Apply remembered POI / ROI to metadata BEFORE registering, so
 *      `Takes.add`'s auto-alignment math sees them.
 *   6. Register the take.
 *   7. Apply remembered offset / spatialOffset / lock AFTER add (these
 *      override the auto-POI alignment that .add() ran).
 *   8. Compute a body-wide probe (peak speed orientation hint).
 *
 * Returns `{ take, isFirst, probe, original, remembered }` so the
 * caller can wire post-load side effects (info dialog, data widget,
 * ChartWidget.onTakeAdded, autoSelectHip, toast wording) without
 * reimplementing the loader internals.
 */

import { Pipeline }     from '../data/Pipeline.js';
import { computeProbe } from '../data/Probe.js';
import { SessionStore } from './SessionStore.js';

/**
 * @param {Takes}   takes   the live Takes registry to register into
 * @param {Object}  result  { motionData, metadata } from DataWidget
 * @returns {{
 *   take: TakeRecord,
 *   isFirst: boolean,
 *   probe: ReturnType<typeof computeProbe>,
 *   original: object|null,
 *   remembered: object|null,
 * }}
 */
export function loadTake(takes, result) {
    const pipeline        = new Pipeline();
    const processed       = pipeline.processMotionData(result);
    const sourceFrameRate = extractFrameRate(processed.frames, processed.metadata);

    applyDefaultPoi(processed);

    const takeName   = deriveTakeName(result, processed);
    const remembered = SessionStore.get(takeName);

    // Pre-register fixup so Takes.add's auto-alignment math sees the
    // remembered POI / ROI.
    if (remembered && processed.metadata) {
        if (Number.isFinite(remembered.poi)) processed.metadata.pointOfInterest  = remembered.poi;
        if (remembered.roi)                  processed.metadata.regionOfInterest = remembered.roi;
    }

    const isFirst = takes.size === 0;
    const take = takes.add({
        name:            takeName,
        frameData:       processed.frames,
        metadata:        processed.metadata,
        sourceFrameRate,
        processor:       pipeline,
    });

    // Post-register: remembered offset / spatial / lock override the
    // auto-POI alignment that .add() just ran.
    if (remembered) {
        if (Number.isFinite(remembered.offset)) takes.setOffset(take.id, remembered.offset);
        if (remembered.spatialOffset)           takes.setSpatialOffset(take.id, remembered.spatialOffset);
        if (remembered.locked)                  takes.setLocked(take.id, true);
    }

    return {
        take,
        isFirst,
        probe:    computeProbe(processed.frames, processed.metadata),
        original: pipeline.getOriginalData(),
        remembered,
    };
}

/** A take is a JS object that round-trips through JSON; the user thinks
 *  of it as "jump_03", not "jump_03.json". Strip trailing extension; fall
 *  back to a sensible default. */
function deriveTakeName(result, processed) {
    const raw = result.metadata?.originalFilename
             || processed.metadata?.takeName
             || 'unnamed';
    return raw.replace(/\.[^./\\]+$/, '');
}

/** Default POI = middle frame when source declares none. Guarantees every
 *  take always has a knob on the master slider (drag-to-align works from
 *  the moment the take registers; snap-to-peak overwrites with the
 *  criterion's peak per take). */
function applyDefaultPoi(processed) {
    if (!processed.metadata || Number.isFinite(processed.metadata.pointOfInterest)) return;
    const f = processed.frames;
    if (!f?.length) return;
    const first = f[0].frame ?? 0;
    const last  = f[f.length - 1].frame ?? (f.length - 1);
    processed.metadata.pointOfInterest = Math.round((first + last) / 2);
}

/** Frame rate from metadata if present, else inferred from time deltas
 *  on the first ~100 frames. Falls back to 30. */
function extractFrameRate(frames, meta) {
    if (meta?.frameRate && meta.frameRate > 0) return meta.frameRate;
    if (frames.length >= 2) {
        const times = frames.slice(0, Math.min(100, frames.length))
            .map(f => f.time).filter(t => t !== undefined);
        if (times.length >= 2) {
            const dt = (times[times.length - 1] - times[0]) / (times.length - 1);
            if (dt > 0) return Math.round(1.0 / dt);
        }
    }
    return 30;
}
