'use strict';
const assert = require('assert');
const { evalBest } = require('../lib/cards');
const { Hand } = require('../lib/hand');

// --- evaluator
const s = (str) => evalBest(str.split(' '));
assert(s('As Ks Qs Js Ts 2d 3c').name === 'Роял-флеш');
assert(s('Ah 2d 3c 4s 5h Kd Kc').name === 'Стрит до 5');
assert(s('Ah Ad Ac Kd Kc 2s 3s').cat === 6);
assert(s('Ah Ad Kc Kd Qc Qs 2s').name === 'Две пары A и K');
assert(s('2h 3h 4h 5h 7h Ad Ac').cat === 5);
assert(s('Ah Ad 9c 8d 7c 2s 3s').score > s('Kh Kd Ac Qd Jc 2s 3s').score);
assert(s('Ah Kd 9c 8d 7c 2s 3s').score > s('Ah Qd 9c 8d 7c 2s 3s').score);
assert(s('9h 8d 7c 6d 5c 4s 3s').name === 'Стрит до 9');
assert.strictEqual(s('Ah Ad Kc Kd Qc 2s 3s').score, s('Ah Ad Kh Ks Qs 4s 5d').score);
assert(s('Ah Ad 2c 2d Kc Ks 4s').score > s('Ah Ad 2c 2h Kc Kd 3s').score);
console.log('evaluator ok');

// --- side pots: A 100, B 300, C 500 all-in, fixed deck so C has best, B second
{
  // deck pops from end. Deal order: from SB (idx1) around: round1 idx1,2,0 ; round2 idx1,2,0
  const players = [
    { id: 'A', name: 'A', stack: 100 }, // BTN
    { id: 'B', name: 'B', stack: 300 }, // SB
    { id: 'C', name: 'C', stack: 500 }, // BB
  ];
  // cards popped: B1, C1, A1, B2, C2, A2, burn, f1 f2 f3, burn, t, burn, r
  const seq = ['Kh', 'Ah', '2c', 'Kd', 'Ad', '3d', 'xx', '9s', '8s', '4h', 'xx', 'Jc', 'xx', '7d'];
  const deck = seq.slice().reverse();
  const h = new Hand({ players, sb: 5, bb: 10, deck });
  h.start();
  assert.strictEqual(h.toAct, 0);
  h.act(0, 'raise', 100); // A all-in
  h.act(1, 'raise', 300); // B all-in
  h.act(2, 'call');       // C calls 300
  while (h.runout) h.runoutStep();
  assert(h.done);
  const [A, B, C] = h.seats;
  assert.strictEqual(A.stack + B.stack + C.stack, 900);
  assert.strictEqual(C.stack, 900);
  assert.strictEqual(A.stack, 0);
  console.log('side pots ok', h.pots.map((p) => p.amount));
}

// --- random fuzz: chip conservation, termination
let hands = 0;
for (let iter = 0; iter < 20000; iter++) {
  const n = 2 + Math.floor(Math.random() * 5);
  const players = Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'p' + i, stack: 1 + Math.floor(Math.random() * 400) }));
  const total = players.reduce((t, p) => t + p.stack, 0);
  const h = new Hand({ players, sb: 1, bb: 2 });
  h.start();
  let guard = 0;
  while (!h.done) {
    if (++guard > 500) throw new Error('loop');
    // random fast folds
    if (Math.random() < 0.05) {
      const j = Math.floor(Math.random() * n);
      h.fastFold(j);
      continue;
    }
    if (h.runout) { h.runoutStep(); continue; }
    const i = h.toAct;
    assert(i >= 0, 'no actor but not done');
    const la = h.legal(i);
    const r = Math.random();
    if (r < 0.15) h.act(i, 'fold');
    else if (r < 0.6) h.act(i, la.canCheck ? 'check' : 'call');
    else if (la.canRaise) {
      const to = la.minRaiseTo + Math.floor(Math.random() * (la.maxRaiseTo - la.minRaiseTo + 1));
      h.act(i, 'raise', Math.random() < 0.2 ? la.maxRaiseTo : to);
    } else h.act(i, la.canCheck ? 'check' : 'call');
  }
  const after = h.seats.reduce((t, s) => t + s.stack, 0);
  assert.strictEqual(after, total, 'chips not conserved');
  assert(h.seats.every((s) => s.stack >= 0));
  // a fast-folded seat must never reach showdown
  if (h.showdown) assert(h.seats.every((s) => !(s.fastFolded && !s.folded)));
  hands++;
}
console.log('fuzz ok', hands, 'hands');

// --- incomplete all-in raise does not reopen betting
{
  const h = new Hand({ players: [{ id: 'A', name: 'A', stack: 1000 }, { id: 'B', name: 'B', stack: 35 }, { id: 'C', name: 'C', stack: 1000 }], sb: 5, bb: 10 });
  h.start();
  h.act(0, 'raise', 30);
  h.act(1, 'raise', 35); // all-in, +5 < min raise 20
  assert.strictEqual(h.toAct, 2);
  assert(h.legal(2).canRaise, 'BB has not acted -> may raise');
  h.act(2, 'call');
  assert.strictEqual(h.toAct, 0);
  assert(!h.legal(0).canRaise, 'BTN may only call');
  assert.strictEqual(h.legal(0).callAmount, 5);
  // heads-up order: BTN/SB acts first preflop, BB first postflop
  const hu = new Hand({ players: [{ id: 'A', name: 'A', stack: 100 }, { id: 'B', name: 'B', stack: 100 }], sb: 1, bb: 2 });
  hu.start();
  assert.strictEqual(hu.toAct, 0);
  hu.act(0, 'call');
  assert.strictEqual(hu.toAct, 1);
  hu.act(1, 'check');
  assert.strictEqual(hu.street, 'flop');
  assert.strictEqual(hu.toAct, 1);
  console.log('raise rules ok');
}
