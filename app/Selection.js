/**
 * Selection.js - Centralized node selection with EventTarget pub/sub
 *
 * Single source of truth for selected nodes and color assignments. Keys
 * are 3-part — `${takeId}:${objectName}:${nodeName}` — so the same
 * skeleton-relative path picked from two different takes counts as two
 * distinct selections (they get different colours, different graph series,
 * different stats).
 */

import { nodeKey } from '../lib/object-types.js';

const COLORS = [
    { name: 'UNIFR Blue',   hex: '#005395' },
    { name: 'Crimson',      hex: '#DC143C' },
    { name: 'Forest Green', hex: '#228B22' },
    { name: 'Dark Orange',  hex: '#FF8C00' },
    { name: 'Purple',       hex: '#800080' },
    { name: 'Teal',         hex: '#008080' },
    { name: 'Goldenrod',    hex: '#DAA520' },
    { name: 'Indigo',       hex: '#4B0082' },
    { name: 'Tomato',       hex: '#FF6347' },
    { name: 'DodgerBlue',   hex: '#1E90FF' },
];

export class Selection extends EventTarget {
    #nodes = new Map();
    #colorIdx = 0;

    static COLORS = COLORS;

    /** Build the canonical 3-part composite key. Re-exported as an
     *  instance method for backward compat with callers that used
     *  `selection.key(t,o,n)`; new code should import `nodeKey` from
     *  `lib/object-types.js` directly. */
    key(takeId, objectName, nodeName) { return nodeKey(takeId, objectName, nodeName); }

    #nextColor() {
        const c = COLORS[this.#colorIdx % COLORS.length];
        this.#colorIdx++;
        return c;
    }

    add(takeId, objectName, nodeName, objectType, customColor = null) {
        const k = this.key(takeId, objectName, nodeName);
        if (this.#nodes.has(k)) return null;

        const color = customColor ? { name: 'Custom', hex: customColor } : this.#nextColor();
        const data = {
            takeId, objectName, nodeName,
            objectType: objectType || 'undefined',
            color: color.hex, colorName: color.name,
            key: k,
        };
        this.#nodes.set(k, data);
        this.#emit();
        return data;
    }

    remove(takeId, objectName, nodeName) {
        const k = this.key(takeId, objectName, nodeName);
        if (!this.#nodes.delete(k)) return false;
        this.#emit();
        return true;
    }

    toggle(takeId, objectName, nodeName, objectType, customColor = null) {
        const k = this.key(takeId, objectName, nodeName);
        if (this.#nodes.has(k)) { this.remove(takeId, objectName, nodeName); return false; }
        this.add(takeId, objectName, nodeName, objectType, customColor);
        return true;
    }

    has(takeId, objectName, nodeName) { return this.#nodes.has(this.key(takeId, objectName, nodeName)); }
    get(takeId, objectName, nodeName) { return this.#nodes.get(this.key(takeId, objectName, nodeName)) || null; }

    /** Bulk-remove every entry whose takeId matches. Used when a take is
     *  unloaded — its nodes can no longer be selected so we sweep them. */
    removeByTake(takeId) {
        let removed = 0;
        for (const k of [...this.#nodes.keys()]) {
            if (this.#nodes.get(k).takeId === takeId) {
                this.#nodes.delete(k);
                removed++;
            }
        }
        if (removed) this.#emit();
        return removed;
    }

    all()       { return Array.from(this.#nodes.values()); }
    get size()  { return this.#nodes.size; }

    clear() {
        if (this.#nodes.size === 0) return;
        this.#nodes.clear();
        this.#emit();
    }

    #emit() {
        this.trigger('change', this.all());
    }
}
