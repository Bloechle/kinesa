/**
 * SceneManager.js - Three.js scene setup and camera management
 * $ is now global (from qry.js loaded as <script> in index.html).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { download, stamp } from 'qry-kit';

export class SceneManager {
    scene = null;
    camera = null;
    renderer = null;
    controls = null;
    clock = new THREE.Clock();

    #perspCam = null;
    #orthoCam = null;
    #orthoSize = 3;
    #grid = null;

    static VIEWS = {
        perspective: { pos: [0, 2.5, 5], target: [0, 1, 0], up: [0, 1, 0] },
        front:       { pos: [0, 1, 10],  target: [0, 1, 0], up: [0, 1, 0] },
        side:        { pos: [10, 1, 0],  target: [0, 1, 0], up: [0, 1, 0] },
        top:         { pos: [0, 10, 0],  target: [0, 1, 0], up: [0, 0, -1] },
    };

    init() {
        const el = $('#scene-container');
        const aspect = el.clientWidth / el.clientHeight;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x000000);

        this.#perspCam = new THREE.PerspectiveCamera(60, aspect, 0.1, 100);
        this.#orthoCam = new THREE.OrthographicCamera(
            -this.#orthoSize * aspect, this.#orthoSize * aspect,
            this.#orthoSize, -this.#orthoSize, 0.1, 100
        );
        this.#perspCam.position.set(0, 2.5, 5);
        this.#orthoCam.position.set(0, 2.5, 5);
        this.camera = this.#perspCam;

        this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        this.renderer.setSize(el.clientWidth, el.clientHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        el.appendChild(this.renderer.domElement);

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        const dir = new THREE.DirectionalLight(0xffffff, 0.5);
        dir.position.set(10, 10, 10);
        this.scene.add(dir);

        this.#grid = new THREE.GridHelper(10, 10, 0x444444, 0x444444);
        this.scene.add(this.#grid);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(0, 1, 0);
        this.controls.update();

        this._onWindowResize = () => this.onWindowResize();
        window.on('resize', this._onWindowResize, false);
    }

    setView(name) {
        const v = SceneManager.VIEWS[name];
        if (!v) return;

        const isPersp = name === 'perspective';
        this.camera = isPersp ? this.#perspCam : this.#orthoCam;
        this.camera.position.set(...v.pos);
        this.camera.up.set(...v.up);
        this.camera.lookAt(...v.target);

        this.controls.object = this.camera;
        this.controls.target.set(...v.target);
        this.controls.enableRotate = isPersp;
        this.controls.update();
    }

    setGridVisible(visible) { if (this.#grid) this.#grid.visible = visible; }
    isGridVisible()          { return this.#grid?.visible ?? false; }

    screenshot() {
        this.render();
        this.renderer.domElement.toBlob(blob => {
            if (!blob) return;
            download(blob, `kinesa-screenshot-${stamp()}.png`);
        });
    }

    centerOn(position) {
        if (!position) return;
        this.controls.target.copy(position);
        this.controls.update();
    }

    onWindowResize() {
        const el = document.getElementById('scene-container');
        if (!el) return;
        const w = el.clientWidth, h = el.clientHeight, a = w / h;

        this.#perspCam.aspect = a;
        this.#perspCam.updateProjectionMatrix();
        this.#orthoCam.left  = -this.#orthoSize * a;
        this.#orthoCam.right =  this.#orthoSize * a;
        this.#orthoCam.updateProjectionMatrix();

        this.renderer.setSize(w, h, false);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.render();
    }

    add(obj)    { this.scene.add(obj); }
    remove(obj) { this.scene.remove(obj); }

    render() {
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    /** Detach the window resize listener; release the WebGL renderer.
     *  KinesaApp doesn't currently call this — the SceneManager's
     *  lifetime matches the page — but it's needed for hot-reload /
     *  multi-instance scenarios. */
    destroy() {
        if (this._onWindowResize) {
            window.off('resize', this._onWindowResize, false);
        }
        this.controls?.dispose?.();
        this.renderer?.dispose?.();
    }
}
