/**
 * DataWidget.js — File processor (JSON / CSV / ZIP).
 *
 *   processFiles(files)           → single-file preview (fires onResult)
 *   batchConvertToJson(files)     → convert many to JSON, download a ZIP
 *                                   → { batch:true, success, failures }
 *   mergeJsons(files)             → superimpose objects from N takes into one
 *                                   JSON; download the merged file
 *                                   → { batch:true, kind:'merge', success,
 *                                       sources, failures }
 *                                   (Reserved API. No UI entry in v1.0 —
 *                                   superseded by native multi-take in the
 *                                   player. Kept for a future "Export aligned
 *                                   takes" action that will reuse this
 *                                   machinery to bake each take's offset +
 *                                   spatial-offset into a single JSON.)
 *   trimJsonsByROI(files)         → trim each JSON to its metadata.regionOfInterest
 *                                   and download the result in a ZIP
 *                                   → { batch:true, kind:'trim', success, failures }
 *
 * ZIPs are flattened into their CSV/JSON entries in every path. No DOM
 * here — UI lives in KinesaApp. JSZip is loaded as a global.
 */

import { clamp, stamp, download } from 'qry-kit';

export class DataWidget {
    #onResult;
    #currentData  = null;
    #downloadData = null;

    constructor({ onResult }) {
        this.#onResult = onResult;
    }

    // ── Public API ────────────────────────────────────────────────────────

    /**
     * Single-file preview path. Multiple inputs or a multi-entry ZIP are
     * still accepted; only the first item is previewed. Batch workflows live
     * on their own public methods (batchConvertToJson, future merge…).
     *
     * @param {FileList|File[]} files
     */
    async processFiles(files) {
        const items = await this.#flattenInputs(Array.from(files));
        if (!items.length) return;
        // Multi-take aware: every flattened item becomes its own take.
        // ZIPs that contain N JSON/CSV entries register N takes; multi-
        // file drops register one take per dropped file. Items are
        // processed sequentially so handleDataResult sees them in order
        // (first one becomes master, the rest slaves). Per-item try/catch
        // so one bad file doesn't abort the whole drop.
        for (const item of items) {
            try {
                await this.#previewItem(item);
            } catch (err) {
                console.warn(`Failed to load take "${item.name}":`, err);
            }
        }
    }

    /**
     * Batch-convert every CSV/JSON (directly passed or inside ZIPs) into
     * JSON files bundled in a single ZIP. Triggers the download itself.
     *
     * @param {FileList|File[]} files
     * @param {{ onProgress?: (info:{current:number, total:number, name:string, phase?:string}) => void }} [opts]
     * @returns {Promise<{ batch:true, success:number, failures:Array<{name,error}> }>}
     */
    async batchConvertToJson(files, { onProgress } = {}) {
        const items = await this.#flattenInputs(Array.from(files));
        if (!items.length) throw new Error('No CSV / JSON files to convert');
        return this.#batchConvert(items, { onProgress });
    }

    /**
     * Merge two or more JSON takes into a single take by superimposing their
     * objects at each frame. Takes should share a common frame layout; the
     * merge iterates by index up to the shortest source. Collisions between
     * object names are resolved by auto-suffix (Skeleton → Skeleton_2 …).
     *
     * @param {FileList|File[]} files JSONs or ZIPs containing JSONs; CSVs ignored
     * @param {{ onProgress?: (info:{current:number, total:number, name:string, phase?:string}) => void }} [opts]
     * @returns {Promise<{ batch:true, kind:'merge', success:number, sources:number, failures:Array<{name,error}> }>}
     */
    async mergeJsons(files, { onProgress } = {}) {
        const items = (await this.#flattenInputs(Array.from(files)))
            .filter(i => i.ext === 'json');
        if (items.length < 2) throw new Error('Merge needs at least two JSON files');
        return this.#mergeSources(items, { onProgress });
    }

    /**
     * Trim each input JSON to its `metadata.regionOfInterest` (start/end absolute
     * frame numbers). Files without a regionOfInterest are skipped (failure).
     * Output layout mirrors batchConvertToJson: flat root for loose files,
     * preserved hierarchy for ZIP entries. The ROI field is removed from the
     * trimmed metadata since the output IS the ROI.
     *
     * @param {FileList|File[]} files
     * @param {{ onProgress?: (info:{current:number, total:number, name:string, phase?:string}) => void }} [opts]
     * @returns {Promise<{ batch:true, kind:'trim', success:number, failures:Array<{name,error}> }>}
     */
    async trimJsonsByROI(files, { onProgress } = {}) {
        const items = (await this.#flattenInputs(Array.from(files)))
            .filter(i => i.ext === 'json');
        if (!items.length) throw new Error('No JSON files to trim');
        return this.#trimJsons(items, { onProgress });
    }

    setData(data, forDownload = false, originalData = null) {
        if (forDownload) this.#downloadData = originalData || data;
        else             this.#currentData  = data;
    }

    /**
     * @param {object} [extraMetadata] Merged (shallow) into data.metadata
     *                 for this download only — does NOT mutate in-memory data.
     */
    download(extraMetadata = null) {
        const data = this.#downloadData || this.#currentData;
        if (!data) return false;
        const out = extraMetadata
            ? { ...data, metadata: { ...(data.metadata || {}), ...extraMetadata } }
            : data;
        const src  = data.metadata?.originalFilename || 'motion_data';
        const name = src.replace(/\.[^/.]+$/, '') + '.json';
        download(JSON.stringify(out, null, 2), name, 'application/json');
        return true;
    }

    reset()   { this.#currentData = null; this.#downloadData = null; }
    destroy() { this.#currentData = null; this.#downloadData = null; }

    // ── Internals ─────────────────────────────────────────────────────────

    /** Expand ZIP inputs into individual items; pass through bare JSON/CSV.
     *  Items carry a `fromZip` flag so the batch can later preserve the
     *  source ZIP's directory layout in the output. */
    async #flattenInputs(files) {
        const items = [];
        for (const file of files) {
            const ext = file.name.split('.').pop().toLowerCase();
            if (ext === 'zip') {
                const zip = await JSZip.loadAsync(await file.arrayBuffer());
                zip.forEach((path, entry) => {
                    if (entry.dir) return;
                    const e = path.split('.').pop().toLowerCase();
                    if (e === 'csv' || e === 'json') {
                        items.push({
                            name: path, ext: e, fromZip: true,
                            reader: () => entry.async('text'),
                        });
                    }
                });
            } else if (ext === 'csv' || ext === 'json') {
                items.push({
                    name: file.name, ext, fromZip: false,
                    reader: () => file.text(),
                });
            }
        }
        return items;
    }

    /** Parse one item to a motion-data object. Pure parsing, no state. */
    async #parseItem(item) {
        const text = await item.reader();
        if (item.ext === 'json') return JSON.parse(text);
        const { csvParser } = await import('../data/csv-parser.js');
        return csvParser.parseMocapCsv(text);
    }

    /** Single-item preview path: updates internal state, fires onResult. */
    async #previewItem(item) {
        const data = await this.#parseItem(item);
        if (!data) return;
        if (!data.metadata) data.metadata = {};
        data.metadata.originalFilename = item.name;
        this.#currentData = data;
        this.#onResult?.(data);
    }

    /** Batch path: parse all items, zip the JSON outputs, trigger download. */
    async #batchConvert(items, { onProgress } = {}) {
        const outZip   = new JSZip();
        const failures = [];
        let   success  = 0;
        const total    = items.length;

        for (let i = 0; i < total; i++) {
            const item = items[i];

            // Announce progress, then yield so the browser can repaint
            // before the synchronous CSV parse blocks the main thread.
            onProgress?.({ current: i + 1, total, name: item.name, phase: 'parsing' });
            await new Promise(r => setTimeout(r, 0));

            try {
                const data = await this.#parseItem(item);
                if (!data) throw new Error('parser returned no data');
                if (!data.metadata) data.metadata = {};
                data.metadata.originalFilename = item.name;

                const out = this.#outputPathFor(item, outZip);
                outZip.file(out, JSON.stringify(data, null, 2));
                success++;
            } catch (e) {
                failures.push({ name: item.name, error: e.message || String(e) });
            }
        }

        if (!success) {
            throw new Error(`Batch failed — ${failures.length} error(s), 0 converted`);
        }

        // Packaging can take a noticeable time for large batches — signal it.
        onProgress?.({ current: total, total, name: '', phase: 'packaging' });
        await new Promise(r => setTimeout(r, 0));

        const blob = await outZip.generateAsync({ type: 'blob' });
        const ts   = stamp();
        download(blob, `kinesa_batch_${success}_${ts}.zip`);

        return { batch: true, success, failures };
    }

    /** Merge path: parse N JSONs, superimpose their objects per frame, download one JSON. */
    async #mergeSources(items, { onProgress } = {}) {
        const sources  = [];
        const failures = [];
        const total    = items.length;

        for (let i = 0; i < total; i++) {
            const item = items[i];
            onProgress?.({ current: i + 1, total, name: item.name, phase: 'parsing' });
            await new Promise(r => setTimeout(r, 0));
            try {
                const data = await this.#parseItem(item);
                if (!data?.frames?.length) throw new Error('no frames in file');
                sources.push({ item, data });
            } catch (e) {
                failures.push({ name: item.name, error: e.message || String(e) });
            }
        }

        if (sources.length < 2) {
            throw new Error(`Merge failed — need ≥ 2 valid JSONs, got ${sources.length}`);
        }

        onProgress?.({ current: total, total, name: '', phase: 'merging' });
        await new Promise(r => setTimeout(r, 0));

        const merged = this.#superimpose(sources);

        const base = sources[0].item.name.split('/').pop().replace(/\.[^/.]+$/, '');
        const blob = new Blob([JSON.stringify(merged, null, 2)], { type: 'application/json' });
        download(blob, `${base}_merged.json`);

        return { batch: true, kind: 'merge', success: 1, sources: sources.length, failures };
    }

    /** Superimpose objects from N parsed sources into a single motion-data object.
     *  If any source has `metadata.pointOfInterest` set, the sources are shifted
     *  so their POIs land on the same output frame K (= max POI index across
     *  sources). Output frames span the union of the shifted ranges; frames
     *  outside a source's shifted range simply don't receive its objects.
     *  Without any POI, falls back to index-aligned merge (former behaviour). */
    #superimpose(sources) {
        // Per-source POI expressed as a frame INDEX (0-based inside that source)
        const poiIdx = sources.map(s => {
            const poi = s.data.metadata?.pointOfInterest;
            if (!Number.isFinite(poi)) return 0;
            const first = s.data.frames[0]?.frame ?? 0;
            return clamp(poi - first, 0, s.data.frames.length - 1);
        });
        const anyPoi = sources.some(s => Number.isFinite(s.data.metadata?.pointOfInterest));

        // Align: source s's frame j → output frame offsets[s] + j, so that all
        // POIs coincide at output frame K.
        const K       = Math.max(...poiIdx);
        const offsets = poiIdx.map(p => K - p);
        const totalOutputFrames = Math.max(...sources.map((s, i) => offsets[i] + s.data.frames.length));

        // Union of object namespaces, auto-renaming collisions.
        const metadata = { ...sources[0].data.metadata };
        metadata.objects = {};
        const nameMaps = sources.map(() => ({}));
        sources.forEach((src, si) => {
            const srcObjects = src.data.metadata?.objects || {};
            for (const [origName, info] of Object.entries(srcObjects)) {
                let finalName = origName;
                if (metadata.objects[finalName]) {
                    let n = 2;
                    while (metadata.objects[`${origName}_${n}`]) n++;
                    finalName = `${origName}_${n}`;
                }
                metadata.objects[finalName] = info;
                nameMaps[si][origName] = finalName;
            }
        });

        // Frame rate & time step come from source[0].
        const fps = Number(sources[0].data.metadata?.frameRate) || 60;
        const dt  = 1 / fps;

        // Build frames
        const frames = [];
        for (let i = 0; i < totalOutputFrames; i++) {
            const objects = {};
            sources.forEach((src, si) => {
                const srcIdx = i - offsets[si];
                if (srcIdx < 0 || srcIdx >= src.data.frames.length) return;
                const srcObjs = src.data.frames[srcIdx]?.objects || {};
                for (const [origName, obj] of Object.entries(srcObjs)) {
                    objects[nameMaps[si][origName] || origName] = obj;
                }
            });
            // POI-aligned mode uses a synthetic (frame=i, time=i·dt) since
            // source[0] no longer aligns with output index. Without POI, keep
            // source[0]'s original frame/time (backward compat).
            if (anyPoi) {
                frames.push({ frame: i, time: i * dt, objects });
            } else {
                const base = sources[0].data.frames[i];
                frames.push({
                    frame: base?.frame ?? i,
                    time:  base?.time  ?? (i * dt),
                    objects,
                });
            }
        }

        // Metadata bookkeeping
        const takeNames = sources.map(s => s.data.metadata?.takeName).filter(Boolean);
        metadata.takeName    = takeNames.length ? takeNames.join(' + ') : 'Merged take';
        metadata.totalFrames = frames.length;
        metadata.mergedFrom  = sources.map(s => s.item.name);

        // Record the aligned POI so the merged take carries it forward
        if (anyPoi) {
            metadata.pointOfInterest = K;
            // The old ROI / firstFrame don't map cleanly to the re-synthesized
            // timeline — drop them.
            delete metadata.regionOfInterest;
            delete metadata.firstFrame;
        }

        return { metadata, frames };
    }

    /** Trim path: keep only frames within each JSON's metadata.regionOfInterest. */
    async #trimJsons(items, { onProgress } = {}) {
        const outZip   = new JSZip();
        const failures = [];
        let   success  = 0;
        const total    = items.length;

        for (let i = 0; i < total; i++) {
            const item = items[i];
            onProgress?.({ current: i + 1, total, name: item.name, phase: 'trimming' });
            await new Promise(r => setTimeout(r, 0));

            try {
                const data = await this.#parseItem(item);
                if (!data?.frames?.length) throw new Error('no frames in file');

                const r = data.metadata?.regionOfInterest;
                if (!r || !Number.isFinite(r.startFrame) || !Number.isFinite(r.endFrame) || r.startFrame >= r.endFrame) {
                    throw new Error('no valid regionOfInterest in metadata');
                }

                const trimmed = data.frames.filter(f => f.frame >= r.startFrame && f.frame <= r.endFrame);
                if (!trimmed.length) throw new Error('regionOfInterest matches no frames');

                // Drop the ROI field from the output — the trimmed file IS the ROI now.
                const { regionOfInterest, ...metaKept } = data.metadata;
                const outData = {
                    ...data,
                    metadata: {
                        ...metaKept,
                        originalFilename: item.name,
                        totalFrames:      trimmed.length,
                    },
                    frames: trimmed,
                };

                const out = this.#outputPathFor(item, outZip);
                outZip.file(out, JSON.stringify(outData, null, 2));
                success++;
            } catch (e) {
                failures.push({ name: item.name, error: e.message || String(e) });
            }
        }

        if (!success) {
            throw new Error(`Trim failed — ${failures.length} error(s), 0 trimmed`);
        }

        onProgress?.({ current: total, total, name: '', phase: 'packaging' });
        await new Promise(r => setTimeout(r, 0));

        const blob = await outZip.generateAsync({ type: 'blob' });
        const ts   = stamp();
        download(blob, `kinesa_trim_${success}_${ts}.zip`);

        return { batch: true, kind: 'trim', success, failures };
    }

    /** Pick a unique output path inside `outZip`:
     *   - loose input → flat at root (basename.json)
     *   - ZIP entry   → original path with extension swapped to .json
     * Collisions get a numeric suffix before the extension. */
    #outputPathFor(item, outZip) {
        const path = item.fromZip
            ? item.name.replace(/\.[^/.]+$/, '.json')
            : `${item.name.split('/').pop().replace(/\.[^/.]+$/, '')}.json`;
        if (!outZip.files[path]) return path;
        const dot  = path.lastIndexOf('.');
        const stem = path.slice(0, dot);
        const tail = path.slice(dot);
        let n = 2;
        while (outZip.files[`${stem}_${n}${tail}`]) n++;
        return `${stem}_${n}${tail}`;
    }
}
