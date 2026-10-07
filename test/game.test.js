'use strict';
// Simulates a 9-player Boost pool with random bots and a fake clock.
const assert = require('assert');
let clock = 1_000_000;
Date.now = () => clock;
const { Game } = require('../lib/game');

function invariant(g) {
  let sum = 0;
  for (const p of g.players.values()) sum += p.stack;
  for (const t of g.tables.values()) {
    if (t.finished) continue;
    t.hand.seats.forEach((s, i) => (sum += s.stack - t.credited[i]));
    sum += t.hand.potTotal;
  }
  const buy = [...g.players.values()].reduce((a, p) => a + p.buyIn, 0);
  assert.strictEqual(sum, buy, `chips leak: ${sum} vs ${buy}`);
}

const g = new Game('test', { sb: 1, bb: 2, buyIn: 200, maxBuyIn: 400, actionTime: 20 });
const ps = [];
for (let i = 0; i < 9; i++) {
  const p = g.addPlayer('bot' + i, 200);
  g.setConnected(p, +1);
  ps.push(p);
}
let maxTables = 0, folds = 0, actions = 0, rebuys = 0, timeouts = 0;
const handsSeen = new Set();
for (let step = 0; step < 60000; step++) {
  clock += 100;
  g.tick(clock);
  maxTables = Math.max(maxTables, g.tables.size);
  for (const p of ps) {
    if (p.status === 'sitout' && p.stack <= 0) { g.command(p, { t: 'rebuy', amount: 200 }); rebuys++; }
    if (p.status === 'sitout' && p.wantSitOut && Math.random() < 0.05) g.command(p, { t: 'sitout', value: false });
    const so = g.seatOf(p);
    if (!so) continue;
    const { t, i } = so;
    handsSeen.add(t.no);
    const h = t.hand;
    if (h.done) { if (Math.random() < 0.3) g.command(p, { t: 'next' }); continue; }
    const view = g.stateFor(p);
    assert(view.table, 'seated player sees table');
    // other players' hole cards never leak
    view.table.seats.forEach((s, j) => {
      if (j !== i && !h.seats[j].shown && s.cards) assert.deepStrictEqual(s.cards, ['??', '??']);
    });
    if (view.table.canFastFold && Math.random() < 0.02) { g.command(p, { t: 'act', kind: 'fold' }); folds++; continue; }
    if (h.toAct !== i) continue;
    if (Math.random() < 0.3) continue; // think
    if (Math.random() < 0.003) { clock += 21000; timeouts++; continue; } // AFK -> timeout
    const la = h.legal(i);
    const r = Math.random();
    actions++;
    if (r < 0.35 && !la.canCheck) { g.command(p, { t: 'act', kind: 'fold' }); folds++; }
    else if (r < 0.8 || !la.canRaise) g.command(p, { t: 'act', kind: la.canCheck ? 'check' : 'call' });
    else g.command(p, { t: 'act', kind: 'raise', amount: Math.random() < 0.15 ? la.maxRaiseTo : la.minRaiseTo + Math.floor(Math.random() * 3 * h.bb) });
    // folded player must already be off the table (Boost)
    if (p.tableId === t.id) assert(!h.seats[i].folded);
  }
  invariant(g);
  // nobody is at two places at once
  for (const p of ps) {
    const inQ = g.queue.filter((id) => id === p.id).length;
    assert(inQ <= 1);
    if (inQ) assert.strictEqual(p.status, 'queue');
    if (p.status === 'table') assert(g.tables.get(p.tableId));
  }
  if (step === 30000) {
    // host kicks one, one leaves
    g.command(ps[0], { t: 'kick', id: ps[8].id });
    g.command(ps[7], { t: 'leave' });
  }
}
invariant(g);
console.log({ hands: handsSeen.size, maxTables, folds, actions, rebuys, timeouts });
assert(handsSeen.size > 500, 'enough hands played');
assert(maxTables >= 2, 'pool forms parallel tables');
assert.strictEqual(ps[8].status, 'left');
assert.strictEqual(ps[7].status, 'left');
const ledger = g.stateFor(ps[0]).players;
const net = ledger.reduce((a, p) => a + p.net, 0);
console.log('ledger net sum (≈0 except chips in live pots):', net);
console.log('game sim ok');
