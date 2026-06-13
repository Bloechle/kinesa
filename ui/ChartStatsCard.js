/**
 * ChartStatsCard.js — Stats panel for the focused chip.
 *
 * Pure UI: receives a `(node, stats)` pair and renders the tile grid
 * into a host element. Tiles for keyboard-light readouts (mean, distance,
 * etc.) and click-to-snap for peak frames (peak speed / accel / ang vel
 * / X-factor sweep). Click handler emits via the supplied callbacks.
 *
 *   render(host, { node, stats, takeName, multiTake, onPeakClick })
 *
 *   - host        the DOM element to render into (cleared first)
 *   - node        the focused selection entry { takeId, color, nodeName, … }
 *   - stats       the output of computeStats(cache, roi)
 *   - takeName    the name of the owning take (for multi-take title prefix)
 *   - multiTake   whether to show the take prefix in the card title
 *   - onPeakClick fn({ label, value, frame, frameIndex, node }) — fired
 *                 when the user clicks a peak's "@frame" link. Caller is
 *                 expected to pause + seek + emit a peak-anchor event.
 *
 * The set of stats to surface is a fixed sequence (no plugin system in v1)
 * — extending = appending to STAT_ROWS.
 */

import { OBJECT_NAMES } from '../lib/object-types.js';

const fmt2 = v => v.toFixed(2);
const fmt0 = v => v.toFixed(0);
const fmt1 = v => v.toFixed(1);

// Each entry: { key, label, value(stats), meta(stats) }. value() returns the
// big readout string, meta() returns either { note: '…' } (static text under
// the value) or the source { frame, frameIndex, value } so it renders as a
// click-to-snap "@frame" link. Returning null skips the row.
const STAT_ROWS = [
    { key: 'peakSpeed',     label: 'Peak speed',
        value: s => s.peakSpeed   && `${fmt2(s.peakSpeed.value)} m/s`,
        meta:  s => s.peakSpeed },
    { key: 'meanSpeed',     label: 'Mean speed',
        value: s => s.meanSpeed != null ? `${fmt2(s.meanSpeed)} m/s` : null,
        meta:  ()  => null },
    { key: 'peakAccel',     label: 'Peak accel',
        value: s => s.peakAccel   && `${fmt2(s.peakAccel.value)} m/s²`,
        meta:  s => s.peakAccel },
    { key: 'distance',      label: 'Distance',
        value: s => s.distance > 0 ? `${fmt2(s.distance)} m` : null,
        meta:  ()  => null },
    { key: 'displacement',  label: 'Net displ.',
        value: s => s.displacement > 0 ? `${fmt2(s.displacement)} m` : null,
        meta:  ()  => null },
    { key: 'verticalRange', label: 'Δheight',
        value: s => s.verticalRange && `${fmt2(s.verticalRange.range)} m`,
        meta:  s => s.verticalRange && {
            note: `${fmt2(s.verticalRange.min)}–${fmt2(s.verticalRange.max)} m`,
        }},
    { key: 'rom',           label: 'ROM',
        value: s => s.rom && `${fmt1(s.rom.rom)}°`,
        meta:  s => s.rom && { note: `${fmt0(s.rom.min)}–${fmt0(s.rom.max)}°` }},
    { key: 'peakAngVel',    label: 'Peak ang vel',
        value: s => s.peakAngVel && `${fmt0(s.peakAngVel.value)} °/s`,
        meta:  s => s.peakAngVel },
    { key: 'xfactorRange',  label: 'X-factor',
        value: s => s.xfactorRange && `${fmt1(s.xfactorRange.rom)}°`,
        meta:  s => s.xfactorRange && {
            note: `${fmt0(s.xfactorRange.min)}–${fmt0(s.xfactorRange.max)}°`,
        }},
];

export function renderStatsCard(host, { node, stats, takeName, multiTake, onPeakClick }) {
    host.empty();
    if (!node || !stats) return;

    const color      = node.color || 'var(--sl-color-neutral-500)';
    const takePrefix = multiTake && takeName ? `${takeName} · ` : '';
    const objectTag  = node.objectName !== OBJECT_NAMES.UNLABELED ? `${node.objectName}.` : '';
    const title      = `${takePrefix}${objectTag}${node.nodeName}`;

    const card = $.create('div').css({
        flex: '1 1 100%',
        border: '1px solid var(--sl-color-neutral-200)',
        borderRadius: '0.5rem',
        padding: '0.875rem 1.125rem',
        background: 'var(--sl-color-neutral-50, #fafafa)',
    }).mount(host);

    $.create('div').text(title).css({
        fontSize: '0.8rem', fontWeight: '600', color,
        marginBottom: '0.625rem', letterSpacing: '0.02em',
    }).mount(card);

    // Compute rows once.
    const rows = [];
    for (const r of STAT_ROWS) {
        const v = r.value(stats);
        if (!v) continue;
        rows.push({ label: r.label, value: v, meta: r.meta(stats) });
    }

    if (!rows.length) {
        $.create('div').text('No data').css({
            fontSize: '0.75rem', color: 'var(--sl-color-neutral-500)',
        }).mount(card);
        return;
    }

    const grid = $.create('div').css({
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: '0.625rem 1.25rem',
        alignItems: 'start',
    }).mount(card);

    for (const row of rows) buildTile(grid, row, node, onPeakClick);
}

function buildTile(parent, { label, value, meta }, node, onPeakClick) {
    const tile = $.create('div').css({
        display: 'flex', flexDirection: 'column',
        gap: '0.125rem', minWidth: 0,
    }).mount(parent);

    $.create('div').text(label).css({
        fontSize: '0.7rem', fontWeight: '500',
        color: 'var(--sl-color-neutral-600)',
        letterSpacing: '0.02em',
    }).mount(tile);
    $.create('div').text(value).css({
        fontSize: '1rem', fontWeight: '600',
        color: 'var(--sl-color-neutral-900)',
        lineHeight: '1.3',
    }).mount(tile);

    const metaCell = $.create('div').css({
        fontSize: '0.7rem', color: 'var(--sl-color-neutral-500)',
        minHeight: '1em',
    }).mount(tile);

    if (meta?.note) {
        metaCell.text(meta.note);
    } else if (meta?.frame != null && onPeakClick) {
        metaCell.text(`@${meta.frame}`)
            .css({ cursor: 'pointer', textDecoration: 'underline dotted' })
            .attr('title', 'Snap analysis to this peak')
            .on('click', () => onPeakClick({
                label, value,
                frame:      meta.frame,
                frameIndex: meta.frameIndex,
                node,
            }));
    }
}
