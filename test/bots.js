'use strict';
// Random bots over real WebSockets. Usage: node test/bots.js <baseUrl> <gameId|new> <count> [seconds]
const base = process.argv[2] || 'http://localhost:3000';
let gameId = process.argv[3] || 'new';
const count = +process.argv[4] || 6;
const seconds = +process.argv[5] || 30;
const wsUrl = base.replace(/^http/, 'ws') + '/ws';
const stats = { states: 0, actions: 0, errors: [], hands: new Set() };

async function main() {
  if (gameId === 'new') {
    const r = await fetch(base + '/api/games', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Хост', buyIn: 200, settings: { sb: 1, bb: 2, buyIn: 200, maxBuyIn: 400, actionTime: 15 } }) });
    const j = await r.json();
    gameId = j.id;
    console.log('GAME', gameId, 'HOSTTOKEN', j.token);
  }
  const names = ['Миша', 'Саша', 'Дима', 'Лёша', 'Катя', 'Оля', 'Ваня', 'Петя', 'Аня', 'Женя', 'Коля'];
  for (let i = 0; i < count; i++) bot(names[i % names.length] + (i >= names.length ? i : ''));
  setTimeout(() => {
    console.log(JSON.stringify({ states: stats.states, actions: stats.actions, hands: stats.hands.size, errors: stats.errors.slice(0, 10) }));
    process.exit(0);
  }, seconds * 1000);
}

function bot(name) {
  const ws = new WebSocket(wsUrl);
  let pending = null;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', gameId }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'need_join') ws.send(JSON.stringify({ t: 'join', name, buyIn: 200 }));
    else if (m.t === 'error') stats.errors.push(name + ': ' + m.msg);
    else if (m.t === 'state') {
      stats.states++;
      const T = m.table;
      if (m.me.status === 'sitout' && m.me.chips <= 0) ws.send(JSON.stringify({ t: 'rebuy', amount: 200 }));
      else if (m.me.status === 'sitout') ws.send(JSON.stringify({ t: 'sitout', value: false }));
      if (!T) return;
      stats.hands.add(T.no);
      if (T.done) { if (Math.random() < 0.5) ws.send(JSON.stringify({ t: 'next' })); return; }
      if (T.canFastFold && Math.random() < 0.1) { ws.send(JSON.stringify({ t: 'act', kind: 'fold' })); return; }
      if (!T.legal || pending === T.id + T.toAct + ':' + T.currentBet + ':' + T.street) return;
      pending = T.id + T.toAct + ':' + T.currentBet + ':' + T.street;
      const L = T.legal;
      setTimeout(() => {
        const r = Math.random();
        stats.actions++;
        let msg;
        if (r < 0.3 && !L.canCheck) msg = { t: 'act', kind: 'fold' };
        else if (r < 0.85 || !L.canRaise) msg = { t: 'act', kind: L.canCheck ? 'check' : 'call' };
        else msg = { t: 'act', kind: 'raise', amount: L.minRaiseTo + Math.floor(Math.random() * T.bb * 4) };
        ws.send(JSON.stringify(msg));
      }, 400 + Math.random() * 1200);
    }
  };
  ws.onclose = () => stats.errors.push(name + ' disconnected');
}
main();
