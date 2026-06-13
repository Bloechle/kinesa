/**
 * object-types.js — Shared string constants used across modules.
 *
 * These were previously sprinkled as bare strings ("Unlabeled",
 * "skeleton", "marker", "Center", etc.) — 50+ occurrences across
 * 12+ files. A single typo would have produced a silent bug; now any
 * mismatch shows up at import time.
 *
 * Naming scheme:
 *   OBJECT_TYPES.* — values for `metadata.objects[name].type`.
 *                    Set by the data Pipeline; consumed by SceneRenderer,
 *                    Nodes, Bones, ChartWidget, Probe, etc.
 *   OBJECT_NAMES.* — special object names (the "Unlabeled" pseudo-object
 *                    that holds free markers).
 *   NODE_NAMES.*   — special node names (e.g. "Center" — auto-computed
 *                    centroid of all unlabeled markers).
 *
 * Importers should reference the constants (`OBJECT_NAMES.UNLABELED`)
 * rather than the bare strings — same compile-time wins as TypeScript
 * enums without the compiler.
 */

export const OBJECT_TYPES = Object.freeze({
    SKELETON:  'skeleton',
    RIGIDBODY: 'rigidbody',
    CHAIN:     'chain',
    MARKER:    'marker',
});

export const OBJECT_NAMES = Object.freeze({
    UNLABELED: 'Unlabeled',
});

export const NODE_NAMES = Object.freeze({
    CENTER: 'Center',
});

/**
 * Skeleton joint-name matchers.
 *
 * Some skeleton joints get special treatment (different mesh shape,
 * extra orientation axes, X-factor-eligible, etc.). The exact node
 * names depend on the source rig — Motive uses "Hip" / "Head" /
 * "Chest" but other systems use "Hips" / "head" / "spine_top". These
 * matchers are case-insensitive regexes scoped to whole node names.
 *
 * Used by:
 *   - Nodes.js: head/hip get cubic geometry instead of spheres
 *   - SceneRenderer.js: hip/head get orientation-axes children
 *   - Metrics.js: X-factor needs hip + chest in the same skeleton
 *
 * Defined here so a regex tweak (e.g. supporting `Hip_root` etc.)
 * propagates to every consumer at once.
 */
export const JOINT_NAMES = Object.freeze({
    HIP:   /^hips?$/i,        // "Hip", "Hips"
    HEAD:  /^head$/i,
    CHEST: /^chest$/i,        // for X-factor (trunk yaw vs pelvis yaw)
});

/** True if nodeName is the hip OR head joint (used by SceneRenderer
 *  to attach orientation axes). */
export const isHeadOrHip = (nodeName) =>
    JOINT_NAMES.HEAD.test(nodeName) || JOINT_NAMES.HIP.test(nodeName);

/**
 * Build the canonical 3-part composite key used everywhere in the
 * codebase to address a specific joint of a specific object on a
 * specific take. Format: `${takeId}:${objectName}:${nodeName}`.
 *
 * Used by:
 *   - Selection (registry of selected joints)
 *   - Nodes (mesh registry, hover state, highlight set)
 *   - GraphsModel / Metrics (per-(take × node) cache key)
 *   - Trails (history bucket key)
 *
 * Defined here so the format is the single source of truth — if the
 * separator ever needs to change (e.g. a take name with `:` in it),
 * all consumers update at once.
 */
export const nodeKey = (takeId, objectName, nodeName) =>
    `${takeId}:${objectName}:${nodeName}`;
