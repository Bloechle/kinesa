import { cascadeChain } from '../lib/skeleton.js';
import { orderCascade } from '../data/peaks.js';
let pass = 0, fail = 0;
const t = (name, cond) => { cond ? pass++ : (fail++, console.log('  ✗', name)); };

// chain routing
t('right hand → right arm chain', JSON.stringify(cascadeChain('RHand')) ===
  JSON.stringify(['Hip','Ab','Chest','RShoulder','RUArm','RFArm','RHand']));
t('left forearm → left arm chain', cascadeChain('LFArm')[3] === 'LShoulder');
t('right foot → right leg chain', JSON.stringify(cascadeChain('RFoot')) ===
  JSON.stringify(['Hip','RThigh','RShin','RFoot','RToe']));
t('left toe → left leg chain', cascadeChain('LToe')[1] === 'LThigh');
t('unknown/implement → right arm default', cascadeChain('Stick')[6] === 'RHand');
t('empty → right arm default', cascadeChain()[0] === 'Hip');

// order check
t('clean cascade ✓', orderCascade([
  { label:'Hip', time:0.42 }, { label:'Chest', time:0.46 }, { label:'RHand', time:0.58 },
]).ordered === true);
const inv = orderCascade([
  { label:'Hip', time:0.50 }, { label:'Chest', time:0.46 }, { label:'RHand', time:0.58 },
]);
t('inversion detected', inv.ordered === false && inv.inversions[0] === 'Chest peaks before Hip');
t('ties are ordered', orderCascade([
  { label:'A', time:0.5 }, { label:'B', time:0.5 },
]).ordered === true);
t('single entry trivially ordered', orderCascade([{ label:'A', time:1 }]).ordered === true);

console.log(`\ncascade: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
