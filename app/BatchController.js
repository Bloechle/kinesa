/**
 * BatchController.js — Sidebar-triggered batch operations dialog.
 *
 * Owns the Batch dialog: drop-zone DnD, file picker, progress bar,
 * end-of-run toast, and the registry of supported operations
 * (`Convert to JSON`, `Trim by ROI`, …).
 *
 * Each entry in #ops is one operation:
 *   {
 *     title, desc, accept,
 *     run: (dataWidget, files, onProgress) => { batch, success, failures, kind? }
 *   }
 *
 * To add a new operation:
 *   1. Append an entry to the OPS map below
 *   2. Add a sidebar link calling `batchController.open('<id>')`
 * No other plumbing needed — the controller wires its own DnD/picker/
 * progress UI from #batch-dialog ids in index.html.
 *
 * Toast wording stays inside this module (`#report`) so KinesaApp doesn't
 * have to know about per-op messaging.
 *
 * Depends on the global `$` from qry.js for selector + class helpers,
 * and on `toast` from qry-kit.
 */

import { toast } from 'qry-kit';
import { esc }   from '../lib/html.js';

const OPS = {
    'convert-json': {
        title:  'Convert to JSON',
        desc:   'Drop CSV · JSON · ZIP files here — or click to pick',
        accept: '.csv,.json,.zip',
        run:    (dw, files, onProgress) => dw.batchConvertToJson(files, { onProgress }),
    },
    'trim-json': {
        title:  'Trim by ROI',
        desc:   'Drop JSON takes (or a ZIP of them) — each is trimmed to its saved region of interest',
        accept: '.json,.zip',
        run:    (dw, files, onProgress) => dw.trimJsonsByROI(files, { onProgress }),
    },
};

export class BatchController {
    #dataWidget;
    #activeId = null;

    constructor(dataWidget) {
        this.#dataWidget = dataWidget;
        this.#bindUI();
    }

    /** Open the batch dialog for the given operation id (must exist in OPS). */
    open(opId) {
        const op = OPS[opId];
        if (!op) return;
        this.#activeId = opId;
        $('#batch-dialog-title').text(op.title);
        $('#batch-dialog-desc').text(op.desc);
        $('#batch-file-input').attr('accept', op.accept);
        this.#resetPane();
        $('#batch-dialog').show();
    }

    // ── Internals ────────────────────────────────────────────────────

    #bindUI() {
        const dropZone = $.opt('#batch-drop-zone');
        const fileIn   = $.opt('#batch-file-input');

        dropZone?.on('click', () => fileIn?.click());

        const dragIn  = (e) => {
            e.preventDefault();
            dropZone.css({ background: 'var(--sl-color-primary-50)', borderColor: 'var(--sl-color-primary-400)' });
        };
        const dragOut = () => dropZone.css({ background: '', borderColor: '' });
        dropZone?.on('dragenter', dragIn);
        dropZone?.on('dragover',  (e) => e.preventDefault());
        dropZone?.on('dragleave', dragOut);
        dropZone?.on('drop', async (e) => {
            e.preventDefault();
            dragOut();
            await this.#run(Array.from(e.dataTransfer.files));
        });

        fileIn?.on('change', async (e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = '';
            await this.#run(files);
        });

        // Reset active op + pane when the dialog closes (X, Escape, Cancel)
        $('#batch-dialog')?.on('sl-after-hide', () => {
            this.#activeId = null;
            this.#resetPane();
        });
    }

    async #run(files) {
        if (!this.#activeId || !files.length) return;
        const op = OPS[this.#activeId];
        if (!op) return;

        this.#showProgress(0, 0);
        const cancelBtn = $('#btn-batch-close');
        if (cancelBtn) cancelBtn.disabled = true;

        try {
            const result = await op.run(this.#dataWidget, files, (info) => {
                let label = info.name;
                if      (info.phase === 'packaging') label = 'Packaging ZIP…';
                else if (info.phase === 'merging')   label = 'Merging takes…';
                this.#showProgress(info.current, info.total, label);
            });
            this.#report(result);
            $('#batch-dialog').hide();
        } catch (err) {
            toast(esc(err.message), 'error');
            this.#resetPane();
        } finally {
            if (cancelBtn) cancelBtn.disabled = false;
        }
    }

    #showProgress(current, total, name = '') {
        // Inline display values (the panes are styled inline in index.html),
        // so explicit 'flex'/'none' rather than show()/hide().
        $.opt('#batch-drop-zone')?.css('display', 'none');
        $.opt('#batch-progress')?.css('display', 'flex');

        const pct = total > 0 ? Math.round((current / total) * 100) : 0;
        $.opt('#batch-progress-fill')?.css('width', `${pct}%`);
        const detail = $.opt('#batch-progress-detail');
        if (detail) {
            const shortName = name ? (name.length > 40 ? '…' + name.slice(-39) : name) : '';
            const pos = total > 0 ? `${current} / ${total}` : '';
            detail.text([pos, shortName].filter(Boolean).join(' · '));
        }
    }

    #resetPane() {
        $.opt('#batch-drop-zone')?.css('display', 'flex');
        $.opt('#batch-progress')?.css('display', 'none');
        $.opt('#batch-progress-fill')?.css('width', '0%');
        $.opt('#batch-progress-detail')?.text('');
    }

    #report(result) {
        if (!result?.batch) return;
        const { success, failures } = result;
        const s = success > 1 ? 's' : '';
        let msg;
        if (result.kind === 'trim') {
            msg = failures.length
                ? `Trimmed ${success} file${s} · ${failures.length} skipped`
                : `Trimmed ${success} file${s} by ROI`;
        } else {
            msg = failures.length
                ? `Converted ${success} file${s} · ${failures.length} failed`
                : `Converted ${success} file${s} to JSON`;
        }
        toast(msg, failures.length ? 'warn' : 'success');
        if (failures.length) console.warn('Batch failures:', failures);
    }
}
