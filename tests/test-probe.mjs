// Signature classification on synthetic takes (frames shaped like the pipeline output)
import { computeProbe } from '../data/Probe.js';
const mkFrames = speeds => speeds.map((sp, i) => ({
    frame: i, time: i / 60,
    objects: { Skeleton: { RHand: { speed: [0, 0, 0, sp] } } },
}));
const meta = { frameRate: 60 };
const gauss = (n, c, a, w=6) => Array.from({length:n}, (_,i) => 0.2 + a*Math.exp(-((i-c)**2)/(2*w*w)));
let pass = 0, fail = 0;
const t = (name, cond) => { cond ? pass++ : (fail++, console.log('  ✗', name)); };

// burst: tennis-like single spike over quiet baseline
let probe = computeProbe(mkFrames(gauss(300, 150, 6.0)), meta);
t('burst detected', probe.signature?.kind === 'burst');
t('dominant is RHand', probe.dominant.node === 'RHand');

// cyclic: 6 strides — realistic gait speed: distinct bursts per stride,
// dropping back near the floor between foot contacts (a raised-|sin|
// signal would have a high median and read as continuous motion).
const burst1 = (i, c) => 2.5 * Math.exp(-((i - c) ** 2) / (2 * 7 ** 2));
const strides = Array.from({length: 600}, (_,i) =>
    0.2 + Math.max(...[50, 150, 250, 350, 450, 550].map(c => burst1(i, c))));
probe = computeProbe(mkFrames(strides), meta);
t('cyclic detected', probe.signature?.kind === 'cyclic');
t('≥3 peaks counted', probe.signature?.peakCount >= 3);

// static: handstand-like low variance
const still = Array.from({length: 400}, () => 0.35 + 0.1 * Math.random());
probe = computeProbe(mkFrames(still), meta);
t('static detected', probe.signature?.kind === 'static');
t('low ratio', probe.signature?.ratio < 2);

console.log(`\nProbe signature: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
