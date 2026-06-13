// Behavioral test for the ghost overlay state machine — verifies the
// signature gating: setGhost fires only when the tint set changes, so
// routine reconciles never churn materials referenced by live meshes.
// Minimal browser env: SceneOrchestrator imports qry-kit, which needs
// window.$ (qry.js) at import time.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window','document','Element','EventTarget','HTMLElement','Node','CustomEvent',
                 'getComputedStyle','localStorage','customElements'])
    if (dom.window[k] !== undefined && globalThis[k] === undefined) globalThis[k] = dom.window[k];
const qrySrc = await (await fetch('https://cdn.jsdelivr.net/gh/Bloechle/qry-js@1.1.0/qry.js')).text();
new Function(qrySrc)();
globalThis.$ = dom.window.$;

const { SceneOrchestrator } = await import('../app/SceneOrchestrator.js');

const mkTake = (id, color, master = false) => ({
    id, color, isMaster: master, visible: true, offset: 0,
    metadata: {}, spatialOffset: { x: 0, y: 0, z: 0 },
    frameData: [{ frame: 0, objects: {} }],
});
const calls = [];
const renderer = new Proxy({}, { get: (_, m) =>
    (...a) => { if (m === 'setGhost' || m === 'rebuild') calls.push([m, a[0]]); } });
const playback = { currentFrame: 0, sourceFrameRate: 30, frameData: [{}] };
let list = [mkTake('t1', '#3b82f6', true)];
const takes = {
    all: () => list,
    masterId: () => list.find(t => t.isMaster)?.id,
    byId: id => list.find(t => t.id === id) || null,
};

const orch = new SceneOrchestrator({ sceneManager: {}, sceneRenderer: renderer, playback, takes });
const drain = () => { const c = calls.splice(0); return c; };
let pass = 0, fail = 0;
const t = (name, cond) => { cond ? pass++ : (fail++, console.log('  ✗', name)); };

orch.reconcile();                       // ghost off — builds t1
t('ghost off: no setGhost on reconcile', !drain().some(c => c[0] === 'setGhost'));

orch.toggleGhost();                     // ON
let c = drain();
t('toggle on: setGhost(tints) once', c.filter(x => x[0] === 'setGhost').length === 1
    && c.find(x => x[0] === 'setGhost')[1] instanceof Map);
t('toggle on: rebuild follows', c.some(x => x[0] === 'rebuild'));

orch.reconcile();                       // nothing changed
t('NO-CHURN: same takes → zero setGhost', !drain().some(x => x[0] === 'setGhost'));
orch.reconcile(); orch.reconcile();
t('NO-CHURN: repeated reconciles silent', !drain().some(x => x[0] === 'setGhost'));

list = [...list, mkTake('t2', '#ef4444')];     // slave dropped while ghost on
orch.reconcile();
c = drain();
const sg = c.filter(x => x[0] === 'setGhost');
t('new take: setGhost once with both tints', sg.length === 1 && sg[0][1].size === 2);
t('new take: slave is dimmed, master is not',
    sg[0][1].get('t2').dim === true && sg[0][1].get('t1').dim === false);
t('new take: rebuild after tint change', c.some(x => x[0] === 'rebuild'));

list = [{ ...list[1], isMaster: true }];        // master removed → t2 promoted
orch.reconcile();
c = drain();
t('master swap: retint (t2 now solid)',
    c.find(x => x[0] === 'setGhost')?.[1].get('t2').dim === false);

orch.reconcile();
t('NO-CHURN after swap', !drain().some(x => x[0] === 'setGhost'));

orch.toggleGhost();                     // OFF
c = drain();
t('toggle off: setGhost(null)', c.some(x => x[0] === 'setGhost' && x[1] === null));
orch.reconcile();
t('ghost off again: reconcile silent', !drain().some(x => x[0] === 'setGhost'));

console.log(`\nghost state machine: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
