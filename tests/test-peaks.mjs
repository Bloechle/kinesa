import { firstSignificantPeak, countSignificantPeaks } from '../data/peaks.js';
const gauss = (n, c, a, w=4) => Array.from({length:n}, (_,i) => a*Math.exp(-((i-c)**2)/(2*w*w)));
const add = (...sigs) => sigs[0].map((_,i) => Math.max(...sigs.map(s => s[i])));
const wrap = vals => vals.map((v,i) => ({ frame: 100+i, frameIndex: i, val: v }));
const get = p => p.val;
let pass = 0, fail = 0;
const t = (name, cond) => { cond ? pass++ : (fail++, console.log('  ✗', name)); };

// 1. Single peak → degenerates to global max
let s = wrap(gauss(100, 50, 2.0));
let r = firstSignificantPeak(s, get);
t('single peak = global max', r.index === 50 && Math.abs(r.value - 2.0) < 1e-9);

// 2. Slap-shot case: first peak 95%, second 100% → picks the FIRST
s = wrap(add(gauss(120, 40, 1.9), gauss(120, 60, 2.0)));
r = firstSignificantPeak(s, get);
t('double contact → first significant', r.index === 40);
t('point carries take frame', r.point.frame === 140);

// 3. Early sub-significant bump (70%) → still the global max
s = wrap(add(gauss(120, 30, 1.4), gauss(120, 70, 2.0)));
r = firstSignificantPeak(s, get);
t('70% bump ignored at fraction 0.8', r.index === 70);
t('…but caught at fraction 0.6', firstSignificantPeak(s, get, { fraction: 0.6 }).index === 30);

// 4. NaN gap beside the peak — still found
s = wrap(add(gauss(100, 50, 2.0))); s[49].val = NaN; s[51].val = NaN;
r = firstSignificantPeak(s, get);
t('NaN-tolerant local max', r.index === 50);

// 5. Negative-signed signal (|value| semantics, e.g. X-factor)
s = wrap(gauss(100, 50, 2.0).map(v => -v));
t('abs semantics', firstSignificantPeak(s, get).index === 50);

// 6. countSignificantPeaks: 5-cycle sinusoid → 5
const sine = Array.from({length: 300}, (_,i) => Math.abs(Math.sin(i * 5 * Math.PI / 300)));
t('cyclic: 5 strides counted', countSignificantPeaks(sine, { minGapSamples: 10 }) === 5);

// 7. burst: one gaussian → 1
t('burst: single peak', countSignificantPeaks(gauss(200, 100, 3.0), { minGapSamples: 10 }) === 1);

// 8. min-gap merges twin peaks 5 samples apart
const twins = add(gauss(100, 48, 2.0, 1.5), gauss(100, 53, 1.9, 1.5));
t('twin peaks merged by minGap', countSignificantPeaks(twins, { minGapSamples: 10 }) === 1);
t('…and split when gap allows', countSignificantPeaks(twins, { minGapSamples: 2 }) === 2);

// 9. empty / all-NaN
t('empty → null / 0', firstSignificantPeak([], get) === null && countSignificantPeaks([NaN, NaN]) === 0);

console.log(`\npeaks.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
