/**
 * Normalizer.js - Validates, normalises and preserves original motion data
 */

export class Normalizer {
    constructor() {
        this.originalData     = null;
        this.metadata         = null;
        this.isQuaternionData = false;
    }

    normalize(data) {
        if (!this._validateData(data)) throw new Error('Invalid motion data structure');

        try {
            this.originalData = JSON.parse(JSON.stringify(data));
            this.metadata = data.metadata || {};
            this._standardizeOriginalFilename(data);
            this.isQuaternionData = this._detectQuaternionData(data);
            this._updateMetadata(data.frames);

            return {
                metadata:         this.metadata,
                frames:           data.frames,
                sourceFrameRate:  this.getSourceFrameRate(),
                isQuaternionData: this.isQuaternionData,
            };
        } catch (e) {
            throw new Error(`Failed to parse motion data: ${e.message}`, { cause: e });
        }
    }

    getOriginalData()    { return this.originalData || null; }
    getSourceFrameRate() { return this.metadata?.frameRate || 30; }

    // ── Private ─────────────────────────────────────────────

    _standardizeOriginalFilename(data) {
        if (!data.metadata) return;

        if (data.metadata.originalName && !data.metadata.originalFilename) {
            data.metadata.originalFilename = data.metadata.originalName;
            delete data.metadata.originalName;
        }

        if (data.metadata.originalFilename && data.metadata.takeNotes !== undefined) {
            const ordered = {};
            for (const k in data.metadata) {
                if (k === 'originalFilename') continue;
                ordered[k] = data.metadata[k];
                if (k === 'takeNotes') ordered.originalFilename = data.metadata.originalFilename;
            }
            if (!ordered.originalFilename) ordered.originalFilename = data.metadata.originalFilename;
            data.metadata = ordered;
            this.metadata = ordered;
        }
    }

    _detectQuaternionData(data) {
        if (data.metadata?.rotationType) {
            const t = data.metadata.rotationType.toLowerCase();
            if (t.includes('quat'))  return true;
            if (t.includes('euler')) return false;
        }

        if (data.frames?.length) {
            const frame = data.frames[0];
            for (const obj in frame.objects) {
                for (const node in frame.objects[obj]) {
                    const n = frame.objects[obj][node];
                    if (n.quat?.length === 4) return true;
                    if (n.rot?.length === 3)  return false;
                }
            }
        }
        return false;
    }

    _validateData(data) {
        if (!data?.frames || !Array.isArray(data.frames) || !data.frames.length) return false;

        const first = data.frames[0];
        if (!first.objects || typeof first.objects !== 'object') return false;

        for (const obj in first.objects) {
            for (const node in first.objects[obj]) {
                const n = first.objects[obj][node];
                if (n?.pos && Array.isArray(n.pos) && n.pos.length >= 3) return true;
            }
        }
        return false;
    }

    _updateMetadata(frames) {
        if (!this.metadata) this.metadata = {};

        const actual = frames.length;
        if (!this.metadata.totalFrames || this.metadata.totalFrames !== actual) {
            this.metadata.totalFrames = actual;
        }

        if (this.isQuaternionData) this.metadata.rotationType = 'quaternion';
        else if (!this.metadata.rotationType) this.metadata.rotationType = 'euler';

        if (!this.metadata.coordinates) this.metadata.coordinates = {};
        if (!this.metadata.coordinates.pos)  this.metadata.coordinates.pos  = ['x', 'y', 'z'];
        if (this.isQuaternionData && !this.metadata.coordinates.quat)
            this.metadata.coordinates.quat = ['x', 'y', 'z', 'w'];
        if (!this.isQuaternionData && !this.metadata.coordinates.rot)
            this.metadata.coordinates.rot = ['x', 'y', 'z'];
    }
}
