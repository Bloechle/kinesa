/**
 * SelectedStrip.js — Compact strip of selected nodes with single focus.
 *
 * Multi-take aware: each chip shows `<takeName>·<nodeName>` when more
 * than one take is loaded, just `<nodeName>` otherwise.
 *
 * Click chip body  → toggle focus (single-focus across the whole session)
 * Click [×]        → remove from Selection (cascade-clears focus if needed)
 *
 * Emits 'focus-change' with `{ nodeKey: <fullKey>|null }` on user clicks
 * and on cascade-clear when the focused node leaves Selection.
 */

import { OBJECT_NAMES } from '../lib/object-types.js';

export class SelectedStrip extends EventTarget {
    #selection;
    #takes;
    #root;
    #onChange;
    #onTakesChange;
    #focused = null;

    constructor(parent, selection, takes) {
        super();
        this.#selection = selection;
        this.#takes     = takes;
        this.#root = $.create('div').css({
            display: 'flex', flexWrap: 'wrap', gap: '0.375rem',
            alignItems: 'center', minHeight: '2.25rem',
            padding: '0.5rem 0.625rem',
            background: 'var(--sl-color-neutral-50, #fafafa)',
            border: '1px dashed var(--sl-color-neutral-200)',
            borderRadius: '0.5rem',
        }).mount(parent);

        this.#onChange       = () => { this.#syncFocus(); this.#render(); };
        this.#onTakesChange  = () => this.#render();
        this.#selection.on('change', this.#onChange);
        this.#takes?.on('change', this.#onTakesChange);
        this.#render();
    }

    getFocusedKey() { return this.#focused; }

    setFocusedKey(key) {
        if (key) {
            const sel = this.#selection.all().find(it => it.key === key);
            if (!sel) key = null;
        }
        this.#setFocused(key);
        this.#render();
    }

    destroy() {
        this.#selection.off('change', this.#onChange);
        this.#takes?.off('change', this.#onTakesChange);
        this.#root.remove();
    }

    // ── Internals ─────────────────────────────────────────────────

    #syncFocus() {
        if (!this.#focused) return;
        const present = this.#selection.all().some(it => it.key === this.#focused);
        if (!present) this.#setFocused(null);
    }

    #setFocused(key) {
        if (this.#focused === key) return;
        this.#focused = key;
        this.trigger('focus-change', { nodeKey: key });
    }

    #toggleFocus(key) {
        this.#setFocused(this.#focused === key ? null : key);
        this.#render();
    }

    #render() {
        this.#root.empty();
        const items = this.#selection.all();
        if (!items.length) { this.#root.add(this.#emptyHint()); return; }
        for (const it of items) this.#root.add(this.#chip(it));
    }

    #emptyHint() {
        return $.create('div').text('Click a joint or bone in the 3D scene to select it')
            .css({
                fontSize: '0.8125rem', color: 'var(--sl-color-neutral-400)',
                fontStyle: 'italic', padding: '0.125rem 0',
            });
    }

    #chip(it) {
        const showTake = (this.#takes?.size || 0) > 1;
        const take     = this.#takes?.byId?.(it.takeId);
        const focused  = this.#focused === it.key;

        const objectPart = (it.objectName === OBJECT_NAMES.UNLABELED || it.objectName === it.nodeName)
            ? it.nodeName
            : `${it.objectName} · ${it.nodeName}`;
        const label = showTake && take?.name ? `${take.name} · ${objectPart}` : objectPart;

        const baseCss = {
            display: 'inline-flex', alignItems: 'center', gap: '0.375rem',
            padding: '0.125rem 0.125rem 0.125rem 0.5rem',
            border: `1px solid ${it.color}`,
            borderRadius: '9999px',
            fontSize: '0.8125rem', lineHeight: '1.4',
            cursor: 'pointer',
            transition: 'all 0.15s',
        };
        const focusedCss = focused
            ? { background: it.color, color: '#fff', fontWeight: '600',
                boxShadow: `0 0 0 2px ${it.color}33` }
            : { background: '#fff',   color: it.color, fontWeight: '500',
                boxShadow: 'none' };

        const chip = $.create('div').css({ ...baseCss, ...focusedCss })
            .attr('title', focused ? 'Click to hide stats' : 'Click to show stats')
            .on('click', () => this.#toggleFocus(it.key));

        const dot = $.create('span').css({
            width: '8px', height: '8px', borderRadius: '50%',
            background: focused ? '#fff' : it.color,
            border: focused ? `1px solid ${it.color}` : 'none',
            flexShrink: '0', boxSizing: 'border-box',
        });
        const txt = $.create('span').text(label);
        const close = $.create('button').html('&times;')
            .attr('title', 'Remove from selection')
            .css({
                width: '20px', height: '20px',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                border: 'none', background: 'transparent',
                color: focused ? '#fff' : it.color, cursor: 'pointer',
                fontSize: '1rem', lineHeight: '1',
                borderRadius: '50%', padding: '0', marginLeft: '0.125rem',
            })
            .on('click', e => {
                e.stopPropagation();
                this.#selection.remove(it.takeId, it.objectName, it.nodeName);
            });

        return chip.add(dot).add(txt).add(close);
    }
}
