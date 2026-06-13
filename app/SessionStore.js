/**
 * SessionStore.js — Persistent per-take alignment memory.
 *
 * Files dropped into Kinesa go through a heavy parse pipeline; we don't
 * want to re-do alignment work every time the user re-loads the same
 * data. SessionStore writes a small index keyed by take name to
 * localStorage so re-drops of recognized files restore offsets and
 * lock state automatically.
 *
 * What's persisted (per take name):
 *   - frame offset (master timeline shift)
 *   - spatial offset { x, y, z }
 *   - alignment lock
 *   - POI (frame number)
 *   - ROI (master only — slaves don't define their own ROI)
 *
 * What's NOT persisted:
 *   - raw frame data (too heavy, also reloaded fresh from the file)
 *   - selection / chip state (re-derived from defaults on first load)
 *   - per-take visibility (always true on re-drop)
 *
 * Storage shape:
 *   localStorage[STORAGE_KEY] = JSON({ takes: { "<name>": entry, ... } })
 *
 * Bounded to MAX_ENTRIES (oldest evicted) so the store stays small even
 * after months of use.
 */

const STORAGE_KEY  = 'kinesa_sessionTakes';
const MAX_ENTRIES  = 50;
const SCHEMA_VER   = 1;

export const SessionStore = {
    /** Look up the persisted entry for a take name, or null. */
    get(name) {
        if (!name) return null;
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            const data = JSON.parse(raw);
            if (data?.v !== SCHEMA_VER) return null;
            return data.takes?.[name] || null;
        } catch { return null; }
    },

    /** Persist (or overwrite) the entry for a take name. */
    set(name, entry) {
        if (!name || !entry) return;
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            let data;
            try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
            if (!data || data.v !== SCHEMA_VER) data = { v: SCHEMA_VER, takes: {}, order: [] };

            data.takes[name] = { ...entry, _ts: Date.now() };

            // LRU bookkeeping: keep `order` as the access list,
            // newest at the end. Dedup on push.
            data.order = (data.order || []).filter(n => n !== name);
            data.order.push(name);

            // Evict oldest if we overflow. Both maps trim together.
            while (data.order.length > MAX_ENTRIES) {
                const evict = data.order.shift();
                delete data.takes[evict];
            }
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch { /* quota / disabled — non-fatal */ }
    },

    /** Wipe the entire store. Useful for "Reset session memory" UX. */
    clear() {
        try { localStorage.removeItem(STORAGE_KEY); } catch {}
    },

    /** Return how many take names we currently remember. */
    size() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return 0;
            const data = JSON.parse(raw);
            return data?.takes ? Object.keys(data.takes).length : 0;
        } catch { return 0; }
    },
};
