/**
 * TakeStrip.js — Compact strip of loaded takes (master + slaves).
 *
 * Master / slave model:
 *   - The first-loaded take is the **master** (anchor icon, non-deletable).
 *     Its POI is the alignment reference for all slaves.
 *   - Subsequent takes are **slaves**: deletable, lockable, draggable on
 *     the timeline slider via their knob.
 *
 * Per-chip controls (right-to-left in the chip):
 *   ‹ ›    nudge spatial X by ±0.5 m (Shift+click ±1 m)        — slaves
 *   🔒/🔓  lock alignment (snap-to-peak skips locked slaves)    — slaves
 *   👁     toggle visibility in the 3D scene                    — all
 *   ×     remove from registry                                 — slaves
 *
 * Mouse over a chip exposes its id via `getHoveredId()` so KinesaApp can
 * route ←/→ keystrokes into a frame-offset nudge for that slave.
 */

import { icon } from './icons.js';

// Shared CSS snippets — defined once, spread into elements.
const STYLE = {
    iconBtn: {
        width: '22px', height: '22px',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', background: 'transparent',
        cursor: 'pointer',
        borderRadius: '50%', padding: '0', marginLeft: '0.125rem',
    },
    smallBtn: {
        width: '18px', height: '20px',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', background: 'transparent',
        cursor: 'pointer',
        fontSize: '0.85rem', lineHeight: '1', padding: '0',
    },
    readout: {
        fontSize: '0.7rem', fontWeight: '600',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    },
};

export class TakeStrip extends EventTarget {
    #takes;
    #root;
    #onChange;
    #hoveredId = null;

    constructor(parent, takes) {
        super();
        this.#takes = takes;
        this.#root = $.create('div').css({
            display: 'flex', flexWrap: 'wrap', gap: '0.5rem',
            alignItems: 'center', minHeight: '2rem',
            padding: '0.25rem 0',
            marginBottom: '0.375rem',
        }).mount(parent);

        this.#onChange = () => this.#render();
        this.#takes.on('change', this.#onChange);
        this.#render();
    }

    /** Take id of the chip currently under the mouse (null if none).
     *  Used by KinesaApp's keyboard layer (←/→ nudges hovered slave). */
    getHoveredId() { return this.#hoveredId; }

    destroy() {
        this.#takes.off('change', this.#onChange);
        this.#root.remove();
    }

    // ── Rendering ─────────────────────────────────────────────────

    #render() {
        this.#root.empty();
        const list = this.#takes.all();
        if (!list.length) {
            this.#root.add($.create('div')
                .text('Drop a JSON / CSV / ZIP file to load a take')
                .css({
                    fontSize: '0.8125rem', color: 'var(--sl-color-neutral-400)',
                    fontStyle: 'italic', padding: '0.125rem 0',
                }));
            return;
        }
        this.#root.add($.create('div').text('Takes:').css({
            fontSize: '0.75rem', fontWeight: '600',
            color: 'var(--sl-color-neutral-600)',
            letterSpacing: '0.02em', marginRight: '0.25rem',
        }));
        for (const t of list) this.#root.add(this.#chip(t));
    }

    #chip(take) {
        const isMaster = this.#takes.isMaster(take.id);
        const dim      = !take.visible;

        const chip = $.create('div').css({
            display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
            padding: '0.125rem 0.125rem 0.125rem 0.375rem',
            border: `${isMaster ? 2 : 1}px solid ${take.color}`,
            borderRadius: '9999px',
            background: isMaster ? `${take.color}15` : '#fff',
            color: take.color,
            fontSize: '0.8125rem', lineHeight: '1.4',
            fontWeight: isMaster ? '700' : '500',
            opacity: dim ? 0.55 : 1,
            transition: 'all 0.15s',
        }).attr('title', isMaster
            ? 'Master take — its POI is the alignment reference (non-deletable)'
            : 'Slave — drag its knob on the timeline, or hover and press ←/→ to nudge (Shift = ×10)')
            .on('mouseenter', () => { this.#hoveredId = take.id; })
            .on('mouseleave', () => { if (this.#hoveredId === take.id) this.#hoveredId = null; });

        // Leading marker: anchor icon for master, color dot for slaves.
        chip.add(isMaster
            ? $.create('span').html(icon.anchor()).css({
                display: 'inline-flex', alignItems: 'center', flexShrink: '0' })
            : $.create('span').css({
                width: '8px', height: '8px', borderRadius: '50%',
                background: take.color, flexShrink: '0',
            }));

        // Take name (truncated).
        chip.add($.create('span').text(take.name).css({
            maxWidth: '12rem',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }));

        // Slave-only readouts and controls.
        if (!isMaster) {
            if (take.offset) {
                const sign = take.offset > 0 ? '+' : '';
                chip.add($.create('span').text(`${sign}${take.offset}f`).css({
                    ...STYLE.readout,
                    color: take.color, opacity: 0.85, marginLeft: '0.125rem',
                }));
            }
            const xVal = take.spatialOffset?.x ?? 0;
            if (xVal) {
                const sign = xVal > 0 ? '+' : '';
                chip.add($.create('span').text(`x:${sign}${xVal.toFixed(1)}m`).css({
                    ...STYLE.readout,
                    color: take.color, opacity: 0.65, marginLeft: '0.25rem',
                }));
            }
            chip.add(this.#nudgeBtn(take, '‹', -0.5));
            chip.add(this.#nudgeBtn(take, '›', +0.5));
            chip.add(this.#lockBtn(take));
        }

        // Visibility toggle for everyone.
        chip.add(this.#iconBtn({
            takeColor: take.color,
            html:      take.visible ? icon.eye() : icon.eyeOff(),
            title:     take.visible ? 'Hide in scene' : 'Show in scene',
            onClick:   () => this.#takes.setVisible(take.id, !take.visible),
        }));

        // Slave-only remove.
        if (!isMaster) {
            chip.add(this.#iconBtn({
                takeColor: take.color,
                html:      '&times;',
                title:     'Remove this take',
                size:      20,
                onClick:   () => this.#takes.remove(take.id),
                cssExtra:  { fontSize: '1rem', lineHeight: '1' },
            }));
        }

        return chip;
    }

    // ── Sub-builders ──────────────────────────────────────────────

    #iconBtn({ takeColor, html, title, onClick, size = 22, cssExtra = {}, opacity = 1 }) {
        return $.create('button')
            .html(html)
            .attr('title', title)
            .css({
                ...STYLE.iconBtn,
                width: `${size}px`, height: `${size}px`,
                color: takeColor,
                opacity,
                ...cssExtra,
            })
            .on('click', e => { e.stopPropagation(); onClick(); });
    }

    #nudgeBtn(take, label, baseDelta) {
        const titleSign = baseDelta < 0 ? '−' : '+';
        return $.create('button')
            .text(label)
            .attr('title', `Nudge X by ${titleSign}${Math.abs(baseDelta)} m (Shift+click ±1 m)`)
            .css({ ...STYLE.smallBtn, color: take.color })
            .on('click', e => {
                e.stopPropagation();
                this.#takes.nudgeX(take.id, e.shiftKey ? Math.sign(baseDelta) : baseDelta);
            });
    }

    #lockBtn(take) {
        return this.#iconBtn({
            takeColor: take.color,
            html:      take.locked ? icon.lock() : icon.unlock(),
            title:     take.locked
                ? 'Alignment locked — snap-to-peak will skip this take'
                : 'Click to lock alignment (snap-to-peak will skip this take)',
            opacity:   take.locked ? 1 : 0.45,
            onClick:   () => this.#takes.setLocked(take.id, !take.locked),
        });
    }
}
