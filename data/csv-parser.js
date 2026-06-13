/**
 * csv-parser.js - Motive CSV → application JSON
 * Max file size: 250 MB. Handles skeletons, rigid bodies, unlabeled markers.
 */

import { OBJECT_TYPES, OBJECT_NAMES, NODE_NAMES } from '../lib/object-types.js';

const stringKit = {
    parseCSVLine(line) {
        const result = [];
        let current = '', inQuotes = false;
        for (const ch of line) {
            if (ch === '"')          inQuotes = !inQuotes;
            else if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
            else                     current += ch;
        }
        result.push(current.trim());
        return result;
    },
    toCamelCase(str) {
        return str.replace(/[^a-zA-Z0-9]+(.)/g, (_, ch) => ch.toUpperCase())
            .replace(/^[A-Z]/, ch => ch.toLowerCase());
    },
};

export const csvParser = {
    MAX_FILE_SIZE: 250 * 1024 * 1024,
    OBJECT_TYPES: ['Bone', 'Bone Marker', 'Rigid Body', 'Rigid Body Marker', 'Marker'],

    parseMocapCsv(csvText) {
        if (!csvText) throw new Error('CSV text is required');

        try {
            const lines = csvText.split(/\r?\n/).filter(l => l.trim());
            if (lines.length < 7) throw new Error('CSV does not contain enough lines');

            // Find "Frame" row dynamically — handles v1.24 (5 header rows) and v1.25+ (6 rows with Parent)
            const frameRowIdx = lines.findIndex(
                (l, i) => i > 0 && stringKit.parseCSVLine(l)[0].trim() === 'Frame'
            );
            if (frameRowIdx === -1) throw new Error('Could not find data header row');

            const metadata    = this._parseMetadata(lines[0]);
            const headerTable = lines.slice(1, frameRowIdx + 1).map(l => stringKit.parseCSVLine(l)); // last row = Frame/axis row
            const dataRows    = lines.slice(frameRowIdx + 1)
                .map(l => stringKit.parseCSVLine(l.trim())).filter(r => r.length > 0);
            const dataJson    = this._convertDataToJson(headerTable, dataRows);

            return this._buildFinalOutput(metadata, dataJson, headerTable);
        } catch (e) {
            throw new Error(`Failed to parse CSV: ${e.message}`, { cause: e });
        }
    },

    _parseMetadata(line) {
        const values   = stringKit.parseCSVLine(line);
        const metadata = {};
        const skip     = new Set(['Capture Frame Rate', 'Total Frames in Take', 'Total Exported Frames', 'Capture Start Frame']);

        for (let i = 0; i < values.length; i += 2) {
            const key   = values[i].trim();
            const value = values[i + 1]?.trim() || '';
            if (skip.has(key)) continue;

            const normalizedKey = key === 'Export Frame Rate' ? 'frameRate' : stringKit.toCamelCase(key);
            metadata[normalizedKey] = (value !== '' && !isNaN(value)) ? parseFloat(value) : value;
        }
        return metadata;
    },

    _convertDataToJson(headerTable, dataRows) {
        // headerTable structure (includes Frame/axis row as last element):
        //   v1.24: [Type, Name, ID, SubType, Frame]         → 5 rows
        //   v1.25: [Type, Name, ID, Parent, SubType, Frame] → 6 rows
        const typeRow       = headerTable[0];
        const nameRow       = headerTable[1];
        const dataHeaderRow = headerTable[headerTable.length - 1]; // Frame row: X, Y, Z, W...
        const subTypeRow    = headerTable[headerTable.length - 2]; // Rotation / Position


        const unlabeledMarkerIds = new Set();
        const rigidBodies        = new Map();

        const frames = dataRows.map(row => {
            const frameNum = parseInt(row[0]);
            const time     = parseFloat(row[1]);
            if (isNaN(frameNum) || isNaN(time)) throw new Error('Invalid frame/time data');

            const frameObj = { frame: frameNum, time, objects: { Unlabeled: {} } };

            for (let i = 2; i < row.length; i++) {
                const objType  = typeRow[i]?.trim() || '';
                const fullName = nameRow[i]?.trim() || '';
                if (!fullName || !this.OBJECT_TYPES.includes(objType)) continue;

                if      (objType === 'Marker' || objType === 'Bone Marker')
                    this._processMarker(frameObj, fullName, subTypeRow[i], dataHeaderRow[i], row[i], unlabeledMarkerIds);
                else if (objType === 'Bone')
                    this._processBone(frameObj, fullName, subTypeRow[i], dataHeaderRow[i], row[i]);
                else if (objType === 'Rigid Body')
                    this._processRigidBody(frameObj, fullName, subTypeRow[i], dataHeaderRow[i], row[i], rigidBodies);
            }

            this._addCenterNodeToFrame(frameObj);
            return frameObj;
        });

        frames.forEach(f => { if (!Object.keys(f.objects[OBJECT_NAMES.UNLABELED]).length) delete f.objects[OBJECT_NAMES.UNLABELED]; });

        return {
            frames,
            rotationType: 'quaternion',
            unlabeledMarkerIds: Array.from(unlabeledMarkerIds).sort((a, b) => parseInt(a) - parseInt(b)),
            rigidBodies: Array.from(rigidBodies.values()),
        };
    },

    _processMarker(frameObj, fullName, subType, axis, value, unlabeledMarkerIds) {
        if (!fullName.includes(OBJECT_NAMES.UNLABELED)) return;

        const idMatch = fullName.match(/Unlabeled\s+(\d+)/);
        if (!idMatch?.[1]) return;

        const markerId  = idMatch[1];
        unlabeledMarkerIds.add(markerId);

        const subTypeStr = subType?.trim().toLowerCase() || '';
        const axisStr    = axis?.trim().toLowerCase() || '';
        if (!subTypeStr || !axisStr || subTypeStr !== 'position') return;

        const v = parseFloat(parseFloat(value).toFixed(3));
        if (isNaN(v)) return;

        if (!frameObj.objects[OBJECT_NAMES.UNLABELED][markerId]) frameObj.objects[OBJECT_NAMES.UNLABELED][markerId] = { pos: [0, 0, 0] };
        frameObj.objects[OBJECT_NAMES.UNLABELED][markerId].pos[axisStr === 'x' ? 0 : axisStr === 'y' ? 1 : 2] = v;
    },

    _processBone(frameObj, fullName, subType, axis, value) {
        if (!fullName.includes(':')) return;
        const parts = fullName.split(':').map(p => p.trim());
        const objectName = parts[0];
        // v1.25: root bone has nodeName === objectName (Parent=Root) → remap to 'Hip'
        const nodeName   = (parts[1] === parts[0]) ? 'Hip' : parts[1];

        const subTypeStr = subType?.trim().toLowerCase() || '';
        const axisStr    = axis?.trim().toLowerCase() || '';
        if (!subTypeStr || !axisStr) return;

        const v = parseFloat(parseFloat(value).toFixed(3));
        if (isNaN(v)) return;

        if (!frameObj.objects[objectName]) frameObj.objects[objectName] = {};
        if (!frameObj.objects[objectName][nodeName]) frameObj.objects[objectName][nodeName] = { pos: [0, 0, 0], quat: [0, 0, 0, 1] };

        const nd = frameObj.objects[objectName][nodeName];
        if (subTypeStr === 'rotation') {
            const qi = { x: 0, y: 1, z: 2, w: 3 }[axisStr];
            if (qi !== undefined) nd.quat[qi] = v;
        } else if (subTypeStr === 'position') {
            nd.pos[axisStr === 'x' ? 0 : axisStr === 'y' ? 1 : 2] = v;
        }
    },

    _processRigidBody(frameObj, fullName, subType, axis, value, rigidBodies) {
        if (!fullName?.trim()) return;

        const objectName = fullName.trim();
        const nodeName   = 'Origin';
        const subTypeStr = subType?.trim().toLowerCase() || '';
        const axisStr    = axis?.trim().toLowerCase() || '';
        if (!subTypeStr || !axisStr) return;

        const v = parseFloat(parseFloat(value).toFixed(3));
        if (isNaN(v)) return;

        if (!rigidBodies.has(objectName)) rigidBodies.set(objectName, { name: objectName, type: OBJECT_TYPES.RIGIDBODY });
        if (!frameObj.objects[objectName]) frameObj.objects[objectName] = {};
        if (!frameObj.objects[objectName][nodeName]) frameObj.objects[objectName][nodeName] = { pos: [0, 0, 0], quat: [0, 0, 0, 1] };

        const nd = frameObj.objects[objectName][nodeName];
        if (subTypeStr === 'rotation') {
            const qi = { x: 0, y: 1, z: 2, w: 3 }[axisStr];
            if (qi !== undefined) nd.quat[qi] = v;
        } else if (subTypeStr === 'position') {
            nd.pos[axisStr === 'x' ? 0 : axisStr === 'y' ? 1 : 2] = v;
        }
    },

    _addCenterNodeToFrame(frame) {
        const unlabeled = frame.objects?.[OBJECT_NAMES.UNLABELED];
        if (!unlabeled) return;

        const markerIds = Object.keys(unlabeled).filter(id => id !== NODE_NAMES.CENTER);
        if (!markerIds.length) return;

        let sum = [0, 0, 0], count = 0;
        for (const id of markerIds) {
            const p = unlabeled[id]?.pos;
            if (p?.length >= 3) { sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; count++; }
        }
        if (count > 0) unlabeled[NODE_NAMES.CENTER] = { pos: sum.map(v => v / count) };
    },

    _extractObjectTypeMap(headerTable) {
        const [typeRow, nameRow] = headerTable;
        const map = new Map();

        for (let i = 2; i < typeRow.length; i++) {
            const type     = typeRow[i]?.trim() || '';
            const fullName = nameRow[i]?.trim() || '';
            const objName  = fullName.includes(':') ? fullName.split(':')[0].trim() : fullName.trim();

            if (type === 'Marker' && fullName.includes(OBJECT_NAMES.UNLABELED)) { map.set(OBJECT_NAMES.UNLABELED, OBJECT_TYPES.MARKER); continue; }
            if (!objName || !type) continue;

            const internal = (type === 'Bone' || type === 'Bone Marker') ? OBJECT_TYPES.SKELETON
                            : (type === 'Rigid Body' || type === 'Rigid Body Marker') ? OBJECT_TYPES.RIGIDBODY
                            : null;
            if (internal) map.set(objName, internal);
        }
        return map;
    },

    _extractObjectsInfo(frames, headerTable, unlabeledMarkerIds = [], rigidBodies = []) {
        const objectsInfo  = {};
        const objectTypeMap = this._extractObjectTypeMap(headerTable);

        if (!frames?.length) return objectsInfo;

        if (unlabeledMarkerIds.length) objectsInfo[OBJECT_NAMES.UNLABELED] = { type: OBJECT_TYPES.MARKER, nodes: unlabeledMarkerIds };

        rigidBodies.forEach(rb => { objectsInfo[rb.name] = { type: OBJECT_TYPES.RIGIDBODY, nodes: ['Origin'] }; });

        const first = frames[0];
        for (const objName in first.objects) {
            if (objName === OBJECT_NAMES.UNLABELED) continue;
            if (rigidBodies.some(rb => rb.name === objName)) continue;
            if (objectTypeMap.get(objName) === OBJECT_TYPES.SKELETON) {
                objectsInfo[objName] = { type: OBJECT_TYPES.SKELETON, nodes: Object.keys(first.objects[objName]) };
            }
        }
        return objectsInfo;
    },

    _buildFinalOutput(metadata, dataJson, headerTable) {
        metadata.totalFrames = dataJson.frames.length;
        if (dataJson.frames.length > 0) metadata.firstFrame = dataJson.frames[0].frame;
        metadata.rotationType = 'quaternion';
        metadata.coordinates  = { pos: ['x', 'y', 'z'], quat: ['x', 'y', 'z', 'w'] };
        metadata.objects = this._extractObjectsInfo(
            dataJson.frames, headerTable,
            dataJson.unlabeledMarkerIds, dataJson.rigidBodies
        );
        return { metadata, frames: dataJson.frames };
    },
};