/**
 * three-helpers.js - Three.js axis/label helpers
 */

import * as THREE from 'three';

export const threeHelpers = {

    createAxes(options = {}) {
        const cfg = {
            position:        options.position        || null,
            length:          options.length          || 0.15,
            headLength:      options.headLength       ?? 0.2,
            headWidth:       options.headWidth        ?? 0.05,
            withLabels:      options.withLabels       || false,
            addOriginMarker: options.addOriginMarker  || false,
            markerSize:      options.markerSize       || 0.02,
            name:            options.name             || 'AxesGroup',
            colors:          options.colors           || { x: 0xFF0000, y: 0x00FF00, z: 0x0000FF },
        };

        const group   = new THREE.Group();
        group.name    = cfg.name;
        const headLen = cfg.length * cfg.headLength;
        const headW   = cfg.length * cfg.headWidth;

        const axes = [
            { dir: new THREE.Vector3(1, 0, 0), color: cfg.colors.x, name: 'X-Axis' },
            { dir: new THREE.Vector3(0, 1, 0), color: cfg.colors.y, name: 'Y-Axis' },
            { dir: new THREE.Vector3(0, 0, 1), color: cfg.colors.z, name: 'Z-Axis' },
        ];

        for (const a of axes) {
            const arrow = new THREE.ArrowHelper(a.dir, new THREE.Vector3(), cfg.length, a.color, headLen, headW);
            arrow.name = a.name;
            group.add(arrow);
        }

        if (cfg.withLabels)      this._addLabels(group, cfg);
        if (cfg.addOriginMarker) {
            const marker = new THREE.Mesh(
                new THREE.SphereGeometry(cfg.markerSize, 16, 16),
                new THREE.MeshBasicMaterial({ color: 0xFFFFFF })
            );
            marker.name = 'OriginMarker';
            group.add(marker);
        }

        if (cfg.position) {
            if (Array.isArray(cfg.position)) group.position.set(...cfg.position);
            else group.position.copy(cfg.position);
        }

        return group;
    },

    createSceneAxes(options = {}) {
        return this.createAxes({
            position: [-5, 0.01, -5],
            addOriginMarker: true,
            withLabels: true,
            length: 1,
            ...options,
        });
    },

    _addLabels(group, cfg) {
        const offset = cfg.length * 1.1;
        const size   = cfg.length * 0.2;

        for (const [text, pos, color] of [
            ['X', [offset, 0, 0],      cfg.colors.x],
            ['Y', [0, offset, 0],      cfg.colors.y],
            ['Z', [0, 0, offset],      cfg.colors.z],
        ]) {
            const canvas    = document.createElement('canvas');
            canvas.width    = canvas.height = 64;
            const ctx       = canvas.getContext('2d');
            ctx.font        = 'bold 48px Arial';
            ctx.textAlign   = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle   = `#${color.toString(16).padStart(6, '0')}`;
            ctx.fillText(text, 32, 32);

            const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas) }));
            sprite.position.set(...pos);
            sprite.scale.set(size, size, size);
            sprite.name = `${text}-Label`;
            group.add(sprite);
        }
    },
};
