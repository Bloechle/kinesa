/**
 * icons.js — Inline SVG icon library.
 *
 * Lucide-derived outlines, inlined to avoid `lucide.createIcons()`
 * timing fragility on dynamic re-renders. Each icon returns an SVG
 * string; pass to `.html(...)` at the call site.
 *
 * Sizing / stroke can be overridden per-call:
 *   icon.eye({ size: 16, sw: 1.5 })
 *
 * Adding an icon: paste Lucide's <svg> inner contents (the paths only)
 * into a new entry, mirroring the existing pattern.
 */

const wrap = (paths, { size = 14, sw = 2 } = {}) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" `
    + `viewBox="0 0 24 24" fill="none" stroke="currentColor" `
    + `stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">`
    + `${paths}</svg>`;

export const icon = {
    anchor:  (o) => wrap('<circle cx="12" cy="5" r="3"/><path d="M12 22V8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/>', o),
    eye:     (o) => wrap('<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>', o),
    eyeOff:  (o) => wrap(
        '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/>' +
        '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/>' +
        '<path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/>' +
        '<line x1="2" x2="22" y1="2" y2="22"/>', o),
    lock:    (o) => wrap('<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',  { size: 13, sw: 2.2, ...o }),
    unlock:  (o) => wrap('<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',    { size: 13, ...o }),
    plus:    (o) => wrap('<path d="M5 12h14"/><path d="M12 5v14"/>', o),
    rotate:  (o) => wrap('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>', o),
    close:   (o) => wrap('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', o),
    image:   (o) => wrap('<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>', o),
};
