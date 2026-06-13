/**
 * SceneConfigDialog.js — Scene Settings dialog controller.
 *
 * Owns the bindings for the `<sl-dialog id="config-dialog">` panel:
 * sliders for joint / bone / marker dimensions, color pickers, the
 * Grid toggle, and Reset / Done buttons. Pure UI controller; the
 * actual scene tweaks happen via the `onChange(config)` callback the
 * caller supplies.
 *
 *   const cfg = new SceneConfigDialog({
 *     defaults: SCENE_DEFAULTS,
 *     initial:  current,
 *     getGridVisible: () => sceneManager.isGridVisible(),
 *     setGridVisible: (v) => sceneManager.setGridVisible(v),
 *     onChange:       (config) => app.applySceneConfig(config),
 *     onReset:        ()       => toast('Scene settings reset', 'info'),
 *   });
 *   cfg.open();   // opens the dialog after syncing the Grid switch
 *
 * The dialog HTML structure is in `index.html` and is unchanged.
 *
 * `$` is global from qry.js.
 */

const SLIDERS = {
    jointSize:  { slider: '#cfg-joint-size',  val: '#cfg-joint-size-val'  },
    boneWidth:  { slider: '#cfg-bone-width',  val: '#cfg-bone-width-val'  },
    markerSize: { slider: '#cfg-marker-size', val: '#cfg-marker-size-val' },
};

const COLORS = {
    jointColor:  '#cfg-joint-color',
    markerColor: '#cfg-marker-color',
};

export class SceneConfigDialog {
    #defaults;
    #config;
    #getGridVisible;
    #setGridVisible;
    #onChange;
    #onReset;

    constructor({ defaults, initial, getGridVisible, setGridVisible, onChange, onReset }) {
        this.#defaults       = defaults;
        this.#config         = initial;
        this.#getGridVisible = getGridVisible || (() => false);
        this.#setGridVisible = setGridVisible || (() => {});
        this.#onChange       = onChange       || (() => {});
        this.#onReset        = onReset        || (() => {});
        this.#bind();
    }

    /** Sync the Grid switch with the live scene state, then show the
     *  dialog. Called from sidebar / button handlers. */
    open() {
        const sw = $('#cfg-grid');
        if (sw) sw.checked = this.#getGridVisible();
        $('#config-dialog').show();
    }

    // ── Internals ────────────────────────────────────────────────

    #bind() {
        // Initialize sliders + color pickers from the current config.
        for (const [key, { slider, val }] of Object.entries(SLIDERS)) {
            const el = $(slider);
            el.value = this.#config[key];
            $(val).text(this.#config[key].toFixed(3));
            el.on('sl-input', e => {
                this.#config[key] = Number(e.target.value);
                $(val).text(this.#config[key].toFixed(3));
                this.#onChange(this.#config);
            });
        }
        for (const [key, sel] of Object.entries(COLORS)) {
            const el = $(sel);
            el.value = this.#config[key];
            el.on('sl-input', e => {
                this.#config[key] = e.target.value;
                this.#onChange(this.#config);
            });
        }

        // Grid toggle is independent of the per-take rebuild path; just
        // poke the scene manager directly.
        $('#cfg-grid')?.on('sl-change', e => this.#setGridVisible(e.target.checked));

        // Reset → defaults, refresh every UI control, fire onChange.
        $('#btn-cfg-reset').on('click', () => {
            Object.assign(this.#config, this.#defaults);
            for (const [key, { slider, val }] of Object.entries(SLIDERS)) {
                $(slider).value = this.#defaults[key];
                $(val).text(this.#defaults[key].toFixed(3));
            }
            for (const [key, sel] of Object.entries(COLORS)) {
                $(sel).value = this.#defaults[key];
            }
            this.#onChange(this.#config);
            this.#onReset();
        });

        $('#btn-cfg-close').on('click', () => $('#config-dialog').hide());
    }
}
