/**
 * ChartExport.js — Pure helpers for chart CSV export.
 *
 * Generates a single CSV from a list of plotted (take × node × metric)
 * items, optionally clipped to a master-namespace ROI window. Multi-
 * take aware: the union of frame indices is computed in the **master
 * timeline** so a slave with offset N contributes its sample at
 * `localIdx + N`. Column headers carry a `<takeName>·` prefix when
 * more than one take is loaded.
 *
 * Schema:
 *   Frame, Time, <header_1>, <header_2>, ...
 *   <masterFrame>, <s>, <val>, <val>, ...
 *
 * - `Frame` is the master-timeline index (0-based, computed as
 *   `localIdx + offset` per item).
 * - `Time` is taken from the first non-null `time` across the row's
 *   items.
 * - Vector metrics (xyz / xyz+mag) use 4 decimals, scalars 2.
 *
 * `items` shape (one per plotted series):
 *   {
 *     cacheKey:    string                       — index into graphData
 *     takeId:      string                       — for header take prefix
 *     objectName:  string
 *     nodeName:    string
 *     property:    { name, component, label }   — cache slice + label
 *   }
 *
 * `graphData` is the per-(take × node) LOCAL-frame cache.
 *
 * `roi` is `{ startFrame, endFrame } | null` in MASTER coords.
 *
 * `offsets` maps `cacheKey → frame offset` so this fn can translate
 * each item's local frame index to the master timeline.
 *
 * `takesById` is `id → { name }` for header prefixes.
 *
 * `multiTake` indicates whether to include the take name prefix in
 * headers. Caller decides.
 */

import { UNITS } from './metrics-catalog.js';
import { download } from 'qry-kit';

import { OBJECT_NAMES } from '../lib/object-types.js';
export function buildCsv({ items, graphData, roi = null, offsets = {}, takesById = {}, multiTake = false }) {
    if (!items?.length) return '';

    const headers = ['Frame', 'Time'];
    for (const n of items) {
        const { name: prop, label } = n.property;
        const unit    = UNITS[prop] || '';
        const takeTag = multiTake ? `${takesById[n.takeId]?.name || ''}·` : '';
        const objTag  = n.objectName !== OBJECT_NAMES.UNLABELED ? `${n.objectName}.` : '';
        headers.push(`${takeTag}${objTag}${n.nodeName} ${label}${unit ? ` (${unit})` : ''}`);
    }

    // Build per-item frame-index Maps + collect the union of MASTER
    // frame indices. Each item's `localIdx + offset` yields its
    // master-namespace frame; ROI is also in master coords.
    const itemMaps = [];
    const frameSet = new Set();
    for (const n of items) {
        const arr    = graphData[n.cacheKey]?.[n.property.name];
        const offset = offsets[n.cacheKey] | 0;
        const map    = new Map();
        if (arr) {
            for (const f of arr) {
                if (f?.frameIndex == null) continue;
                const masterIdx = f.frameIndex + offset;
                if (roi && (masterIdx < (roi.startFrame ?? -Infinity) ||
                            masterIdx > (roi.endFrame   ??  Infinity))) continue;
                map.set(masterIdx, f);
                frameSet.add(masterIdx);
            }
        }
        itemMaps.push(map);
    }
    const sorted = [...frameSet].sort((a, b) => a - b);
    if (!sorted.length) return '';

    const rows = sorted.map(fi => {
        const row = [fi];
        // First non-null time wins for this row.
        let time = '';
        for (let i = 0; i < items.length; i++) {
            const fd = itemMaps[i].get(fi);
            if (fd?.time != null) { time = fd.time.toFixed(3); break; }
        }
        row.push(time);
        for (let i = 0; i < items.length; i++) {
            const fd = itemMaps[i].get(fi);
            if (!fd) { row.push(''); continue; }
            const { component: comp } = items[i].property;
            row.push(comp == null ? (fd.value?.toFixed(2) ?? '') : (fd[comp]?.toFixed(4) ?? ''));
        }
        return row;
    });

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
}

/**
 * Render a chart's SVG to a PNG and download it.
 *
 * The chart strokes/fills are explicit attributes (take colours, axis
 * greys), but axes also use `currentColor` and inherit the page font —
 * both are inlined from computed style onto the clone so the standalone
 * SVG rasterises identically. Drawn at 2× for crisp report embeds.
 *
 * @param {SVGSVGElement} svgEl
 * @param {string} filename
 * @returns {Promise<boolean>}  false when there is nothing to export
 */
export async function exportPng(svgEl, filename, { scale = 2 } = {}) {
    if (!svgEl) return false;
    const rect = svgEl.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height));

    const clone = svgEl.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', w); clone.setAttribute('height', h);
    const cs = getComputedStyle(svgEl);
    clone.style.color      = cs.color;        // resolves currentColor axes
    clone.style.fontFamily = cs.fontFamily;
    clone.style.background = 'transparent';

    const url = URL.createObjectURL(new Blob(
        [new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
    try {
        const img = await new Promise((res, rej) => {
            const i = new Image();
            i.onload = () => res(i);
            i.onerror = () => rej(new Error('SVG rasterisation failed'));
            i.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = w * scale; canvas.height = h * scale;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';               // report-friendly background
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, w, h);
        const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
        if (!blob) return false;
        download(blob, filename, 'image/png');
        return true;
    } finally {
        URL.revokeObjectURL(url);
    }
}
