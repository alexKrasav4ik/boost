'use strict';
const crypto = require('crypto');

const RANKS = '23456789TJQKA';
const SUITS = 'shdc';

function newDeck() {
  const d = [];
  for (const r of RANKS) for (const s of SUITS) d.push(r + s);
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

const rv = (c) => RANKS.indexOf(c[0]) + 2;
const RN = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

const CAT_NAMES = ['Старшая карта', 'Пара', 'Две пары', 'Сет', 'Стрит', 'Флеш', 'Фулл-хаус', 'Каре', 'Стрит-флеш'];

function eval5(cs) {
  const ranks = cs.map(rv).sort((a, b) => b - a);
  const flush = cs.every((c) => c[1] === cs[0][1]);
  const uniq = new Set(ranks);
  let straightHigh = 0;
  if (uniq.size === 5) {
    if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
    else if (ranks[0] === 14 && ranks[1] === 5) straightHigh = 5;
  }
  const cnt = {};
  for (const r of ranks) cnt[r] = (cnt[r] || 0) + 1;
  const groups = Object.entries(cnt)
    .map(([r, c]) => [+r, c])
    .sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  let cat, kick;
  if (straightHigh && flush) { cat = 8; kick = [straightHigh]; }
  else if (groups[0][1] === 4) { cat = 7; kick = [groups[0][0], groups[1][0]]; }
  else if (groups[0][1] === 3 && groups[1][1] === 2) { cat = 6; kick = [groups[0][0], groups[1][0]]; }
  else if (flush) { cat = 5; kick = ranks; }
  else if (straightHigh) { cat = 4; kick = [straightHigh]; }
  else if (groups[0][1] === 3) { cat = 3; kick = groups.map((g) => g[0]); }
  else if (groups[0][1] === 2 && groups[1][1] === 2) { cat = 2; kick = groups.map((g) => g[0]); }
  else if (groups[0][1] === 2) { cat = 1; kick = groups.map((g) => g[0]); }
  else { cat = 0; kick = ranks; }
  let score = cat;
  for (let i = 0; i < 5; i++) score = score * 15 + (kick[i] || 0);
  return { score, cat, kick };
}

function describe(cat, kick) {
  const n = CAT_NAMES[cat];
  switch (cat) {
    case 0: return `${n} ${RN[kick[0]]}`;
    case 1: return `Пара ${RN[kick[0]]}`;
    case 2: return `Две пары ${RN[kick[0]]} и ${RN[kick[1]]}`;
    case 3: return `Сет ${RN[kick[0]]}`;
    case 4: return `Стрит до ${RN[kick[0]]}`;
    case 5: return `Флеш, старшая ${RN[kick[0]]}`;
    case 6: return `Фулл-хаус ${RN[kick[0]]} на ${RN[kick[1]]}`;
    case 7: return `Каре ${RN[kick[0]]}`;
    case 8: return kick[0] === 14 ? 'Роял-флеш' : `Стрит-флеш до ${RN[kick[0]]}`;
  }
  return n;
}

// Best 5-card hand out of 5..7 cards
function evalBest(cards) {
  let best = null;
  const n = cards.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const r = eval5(five);
            if (!best || r.score > best.score) best = { ...r, five };
          }
  best.name = describe(best.cat, best.kick);
  return best;
}

module.exports = { newDeck, evalBest, eval5, RANKS, SUITS };
