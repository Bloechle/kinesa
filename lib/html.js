/**
 * html.js — HTML escaping for HTML-rendering sinks.
 *
 * qry-kit's `toast()` renders its message as HTML; anything user-derived
 * (file/take names, node names, error messages echoing filenames) must
 * pass through `esc()` first.
 */

const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape a value for safe inclusion in an HTML string. */
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => MAP[c]);
