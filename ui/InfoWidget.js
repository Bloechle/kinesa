/**
 * InfoWidget.js — Take metadata display.
 * Sober layout, refined typography, subtle dividers between sections.
 * Conditional blocks for analysis markers (ROI / POI) and merge lineage.
 * $ is global from qry.js.
 */

import { OBJECT_TYPES, OBJECT_NAMES } from '../lib/object-types.js';
import { esc } from '../lib/html.js';

export class InfoWidget {
    #container;

    constructor({ containerId = 'info-widget' } = {}) {
        this.#container = $(`#${containerId}`);
    }

    display(data, { probe = null } = {}) {
        if (!this.#container || !data?.metadata) return this;

        const meta     = data.metadata;
        const fps      = Number(meta.frameRate)  || 1;
        const total    = Number(meta.totalFrames) || 0;
        const duration = (total / fps).toFixed(1);
        const takeName = esc(meta.takeName || 'Unnamed Take');

        // Style atoms — kept inline so the widget owns its appearance with
        // self-contained styling — Shoelace neutral palette throughout.
        const MUTED   = 'color: var(--sl-color-neutral-500)';
        const VALUE   = 'color: var(--sl-color-neutral-800)';
        const STRONG  = 'color: var(--sl-color-neutral-900); font-weight: 500';
        const SECTION = `font-size: 0.7rem; font-weight: 600; text-transform: uppercase;
                         letter-spacing: 0.07em; color: var(--sl-color-neutral-900);
                         margin: 0 0 0.6rem; padding-bottom: 0.5rem;
                         border-bottom: 1px solid var(--sl-color-neutral-200)`;
        const DL      = `display: grid; grid-template-columns: max-content 1fr;
                         column-gap: 1.5rem; row-gap: 0.5rem; margin: 0`;
        const DT      = `${MUTED}; font-size: 0.8rem`;
        const DD      = `margin: 0; ${VALUE}; font-size: 0.875rem`;
        const BLOCK   = 'margin-bottom: 1.5rem';

        const spec = (label, value) => !value ? '' : `
            <dt style="${DT}">${label}</dt>
            <dd style="${DD}">${value}</dd>`;

        // ── Take header (name + headline numbers) ────────────────────────
        const header = `
            <header style="margin-bottom: 1.75rem">
                <h3 style="font-size: 1.25rem; font-weight: 600; margin: 0 0 0.2rem;
                           letter-spacing: -0.01em; color: var(--sl-color-neutral-900)">
                    ${takeName}
                </h3>
                <div style="${MUTED}; font-size: 0.85rem">
                    ${total.toLocaleString()} frames · ${duration}s @ ${fps}&thinsp;Hz
                </div>
            </header>`;

        // ── Capture specs ────────────────────────────────────────────────
        const specs = [
            spec('Length Units',     esc(meta.lengthUnits || 'Meters')),
            spec('Coordinate Space', meta.coordinateSpace && esc(meta.coordinateSpace)),
            spec('Rotation Type',    esc(meta.rotationType || 'Euler')),
            spec('Capture Date',     meta.captureDate && esc(meta.captureDate)),
            spec('Software',         meta.software && esc(meta.software)),
        ].join('');
        const specsBlock = specs ? `
            <section style="${BLOCK}">
                <h4 style="${SECTION}">Capture</h4>
                <dl style="${DL}">${specs}</dl>
            </section>` : '';

        // ── Analysis markers (ROI / POI) — conditional ───────────────────
        const roi = meta.regionOfInterest;
        const poi = meta.pointOfInterest;
        const hasROI = roi && Number.isFinite(roi.startFrame) && Number.isFinite(roi.endFrame);
        const hasPOI = Number.isFinite(poi);
        const firstFrame = data.frames?.[0]?.frame ?? 0;

        const analysisRows = [];
        if (hasROI) {
            const span = roi.endFrame - roi.startFrame + 1;
            const dur  = (span / fps).toFixed(2);
            analysisRows.push(spec(
                'Region of Interest',
                `<span style="${VALUE}">${roi.startFrame}&thinsp;→&thinsp;${roi.endFrame}</span>
                 <span style="${MUTED}; font-size: 0.8rem"> · ${span} frames · ${dur}s</span>`,
            ));
        }
        if (hasPOI) {
            const t = ((poi - firstFrame) / fps).toFixed(3);
            analysisRows.push(spec(
                'Point of Interest',
                `<span style="${VALUE}">frame ${poi}</span>
                 <span style="${MUTED}; font-size: 0.8rem"> · ${t}s</span>`,
            ));
        }
        const analysisBlock = analysisRows.length ? `
            <section style="${BLOCK}">
                <h4 style="${SECTION}">Analysis</h4>
                <dl style="${DL}">${analysisRows.join('')}</dl>
            </section>` : '';

        // ── Probe (auto-computed at load) ────────────────────────────────
        // One-line orientation: which bone moves the most, when, how fast.
        // Mirrors the Python pipeline's "what is this take about?" probe
        // from MOCAP_ANALYSIS_GUIDE.md §6bis. Top-3 helps spot the
        // dominant chain (e.g. RHand → RFArm → RUArm = right-arm strike).
        let probeBlock = '';
        if (probe?.dominant) {
            const fmtName = (e) => esc(`${e.object !== OBJECT_NAMES.UNLABELED ? e.object + '.' : ''}${e.node}`);
            const d = probe.dominant;
            const headRow = spec(
                'Dominant',
                `<span style="${STRONG}">${fmtName(d)}</span>
                 <span style="${MUTED}; font-size: 0.8rem">
                    · ${d.peak.toFixed(2)} m/s @ frame ${d.frame} (${d.time.toFixed(2)}s)
                 </span>`,
            );
            const others = probe.topThree.slice(1).map((e, i) => spec(
                `#${i + 2}`,
                `<span style="${VALUE}">${fmtName(e)}</span>
                 <span style="${MUTED}; font-size: 0.8rem"> · ${e.peak.toFixed(2)} m/s</span>`,
            )).join('');
            const sig = probe.signature;
            const sigRow = !sig ? '' : spec(
                'Signature',
                `<span style="${STRONG}">${sig.kind}</span>
                 <span style="${MUTED}; font-size: 0.8rem">
                    · peak/median ${sig.ratio.toFixed(1)} · ${sig.peakCount} significant peak${sig.peakCount > 1 ? 's' : ''}
                 </span>`,
            );
            probeBlock = `
                <section style="${BLOCK}">
                    <h4 style="${SECTION}">Probe — body-wide peak speeds</h4>
                    <dl style="${DL}">${headRow}${others}${sigRow}</dl>
                </section>`;
        }

        // ── Objects ──────────────────────────────────────────────────────
        const objects = meta.objects ? Object.entries(meta.objects) : [];
        const objList = objects.map(([name, info]) => {
            const nodes = (info.type === OBJECT_TYPES.SKELETON && Array.isArray(info.nodes))
                ? info.nodes.length : null;
            const extra = nodes ? ` · ${nodes} joints` : '';
            return `
                <li style="padding: 0.4rem 0; display: flex; justify-content: space-between;
                           align-items: baseline; border-bottom: 1px solid var(--sl-color-neutral-100)">
                    <span style="${STRONG}; font-size: 0.875rem">${esc(name)}</span>
                    <span style="${MUTED}; font-size: 0.8rem">${esc(info.type)}${extra}</span>
                </li>`;
        }).join('');
        const objectsBlock = objects.length ? `
            <section style="${BLOCK}">
                <h4 style="${SECTION}">Objects · ${objects.length}</h4>
                <ul style="list-style: none; padding: 0; margin: 0">${objList}</ul>
            </section>` : '';

        // ── Merge lineage — conditional ─────────────────────────────────
        const mergedFrom = Array.isArray(meta.mergedFrom) ? meta.mergedFrom : [];
        const lineageBlock = mergedFrom.length ? `
            <section style="${BLOCK}">
                <h4 style="${SECTION}">Merged from · ${mergedFrom.length}</h4>
                <ul style="list-style: none; padding: 0; margin: 0">
                    ${mergedFrom.map(p => `
                        <li style="padding: 0.3rem 0; ${VALUE}; font-family: var(--sl-font-mono, monospace);
                                   font-size: 0.78rem; word-break: break-all">
                            ${esc(p.split('/').pop())}
                        </li>`).join('')}
                </ul>
            </section>` : '';

        // ── Compose ──────────────────────────────────────────────────────
        this.#container.html(`
            <div style="padding: 0.25rem 0; line-height: 1.5">
                ${header}
                ${specsBlock}
                ${analysisBlock}
                ${objectsBlock}
                ${lineageBlock}
            </div>
        `);
        return this;
    }

    destroy() { this.#container?.empty(); }
}
