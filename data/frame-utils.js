/**
 * frame-utils.js — Iteration helpers over the canonical motion-data
 * frame structure.
 *
 * Every processed frame has shape:
 *   {
 *     frame: number,        // absolute frame number
 *     time:  number,        // seconds
 *     objects: {
 *       <ObjectName>: {
 *         <NodeName>: { pos, quat, rot, speed, accel, ... }
 *       }
 *     }
 *   }
 *
 * The triple-nested `for (frame) for (obj) for (node)` walk appeared
 * 3+ times across data/Pipeline.js + data/Metrics.js. Centralised here:
 *
 *   forEachNode(frames, (nd, ctx) => { … })
 *
 * The callback receives the node data plus an optional context object
 * `{ frame, objectName, nodeName }` for callers that need it.
 */

/**
 * Walk every (frame, object, node) tuple in `frames` and call
 * `callback(nodeData, ctx)`. The callback may mutate `nodeData` in
 * place — the data structure is intentionally mutable since the
 * pipeline progressively annotates each node with derived fields
 * (speed, accel, angle, etc.).
 *
 * @param {Array} frames
 * @param {(nd: object, ctx: { frame: object, objectName: string, nodeName: string }) => void} callback
 */
export function forEachNode(frames, callback) {
    for (const frame of frames) {
        const objs = frame.objects;
        if (!objs) continue;
        for (const objectName in objs) {
            const nodes = objs[objectName];
            for (const nodeName in nodes) {
                const nd = nodes[nodeName];
                if (nd) callback(nd, { frame, objectName, nodeName });
            }
        }
    }
}
