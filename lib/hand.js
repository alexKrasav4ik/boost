'use strict';
// No-Limit Hold'em hand state machine (synchronous, timing is driven by Game).
// Seats are given in position order: index 0 = BTN. Heads-up: 0 = BTN/SB, 1 = BB.
const { newDeck, evalBest } = require('./cards');

const STREETS = ['preflop', 'flop', 'turn', 'river'];
const STREET_RU = { flop: 'Флоп', turn: 'Тёрн', river: 'Ривер' };

class Hand {
  constructor({ players, sb, bb, deck }) {
    if (players.length < 2 || players.length > 6) throw new Error('2..6 players required');
    this.n = players.length;
    this.sb = sb;
    this.bb = bb;
    this.deck = deck || newDeck();
    this.seats = players.map((p) => ({
      id: p.id,
      name: p.name,
      stack: p.stack,
      startStack: p.stack,
      bet: 0,
      committed: 0,
      folded: false,
      allIn: false,
      hasActed: false,
      actedLevel: -1,
      cards: [],
      fastFolded: false,
      shown: false,
      lastAction: '',
      won: 0,
      handName: '',
    }));
    this.board = [];
    this.street = 'preflop';
    this.runout = false; // board still to be dealt w/o betting
    this.done = false;
    this.showdown = false;
    this.currentBet = 0;
    this.lastRaise = bb;
    this.raiseLevel = 0;
    this.toAct = -1;
    this.log = [];
    this.pots = null;
    this.version = 0; // bumps on every change — lets Game detect turn changes
  }

  get sbIdx() { return this.n === 2 ? 0 : 1; }
  get bbIdx() { return this.n === 2 ? 1 : 2; }

  _put(s, amt) {
    const a = Math.min(amt, s.stack);
    s.stack -= a;
    s.bet += a;
    s.committed += a;
    if (s.stack === 0) s.allIn = true;
    return a;
  }

  start() {
    for (let r = 0; r < 2; r++)
      for (let k = 0; k < this.n; k++) this.seats[(this.sbIdx + k) % this.n].cards.push(this.deck.pop());
    const sbS = this.seats[this.sbIdx];
    const bbS = this.seats[this.bbIdx];
    const a = this._put(sbS, this.sb);
    sbS.lastAction = `SB ${a}`;
    const b = this._put(bbS, this.bb);
    bbS.lastAction = `BB ${b}`;
    this.log.push(`${sbS.name}: малый блайнд ${a}`, `${bbS.name}: большой блайнд ${b}`);
    this.currentBet = this.bb;
    this.lastRaise = this.bb;
    const first = this.n === 2 ? 0 : 3 % this.n;
    this._proceed(first);
  }

  live() { return this.seats.filter((s) => !s.folded); }
  actors() { return this.seats.filter((s) => !s.folded && !s.allIn); }
  get potTotal() { return this.seats.reduce((t, s) => t + s.committed, 0); }

  legal(i) {
    const s = this.seats[i];
    if (this.done || this.runout || i !== this.toAct) return null;
    const callAmount = Math.min(Math.max(0, this.currentBet - s.bet), s.stack);
    const otherActors = this.seats.filter((o, j) => j !== i && !o.folded && !o.allIn).length;
    const maxRaiseTo = s.bet + s.stack;
    const canRaise =
      s.stack > callAmount && otherActors > 0 && (!s.hasActed || s.actedLevel < this.raiseLevel);
    const minRaiseTo = Math.min(this.currentBet + this.lastRaise, maxRaiseTo);
    return {
      canCheck: s.bet >= this.currentBet,
      callAmount,
      canRaise,
      minRaiseTo,
      maxRaiseTo,
      isBet: this.currentBet === 0,
    };
  }

  // kind: fold | check | call | raise (amount = total "raise to" for this street)
  act(i, kind, amount) {
    const la = this.legal(i);
    if (!la) throw new Error('Сейчас не ваш ход');
    const s = this.seats[i];
    if (kind === 'call' && la.callAmount === 0) kind = 'check';
    if (kind === 'check' && !la.canCheck) throw new Error('Нельзя чекнуть');
    if (kind === 'raise' && !la.canRaise) {
      if (la.callAmount > 0) kind = 'call';
      else kind = 'check';
    }
    switch (kind) {
      case 'fold':
        s.folded = true;
        s.lastAction = 'Фолд';
        this.log.push(`${s.name}: фолд`);
        break;
      case 'check':
        s.lastAction = 'Чек';
        this.log.push(`${s.name}: чек`);
        break;
      case 'call': {
        const a = this._put(s, la.callAmount);
        s.lastAction = s.allIn ? `Олл-ин ${s.bet}` : `Колл ${a}`;
        this.log.push(`${s.name}: колл ${a}${s.allIn ? ' (олл-ин)' : ''}`);
        break;
      }
      case 'raise': {
        let to = Math.floor(Number(amount));
        if (!Number.isFinite(to)) throw new Error('Некорректная сумма');
        to = Math.max(to, la.minRaiseTo);
        to = Math.min(to, la.maxRaiseTo);
        const inc = to - this.currentBet;
        this._put(s, to - s.bet);
        if (inc >= this.lastRaise) {
          this.lastRaise = inc;
          this.raiseLevel++;
        }
        if (to > this.currentBet) this.currentBet = to;
        const word = la.isBet ? 'бет' : 'рейз до';
        s.lastAction = s.allIn ? `Олл-ин ${s.bet}` : la.isBet ? `Бет ${to}` : `Рейз ${to}`;
        this.log.push(`${s.name}: ${word} ${to}${s.allIn ? ' (олл-ин)' : ''}`);
        break;
      }
      default:
        throw new Error('Неизвестное действие');
    }
    s.hasActed = true;
    s.actedLevel = this.raiseLevel;
    this._proceed(i + 1);
  }

  // Fold in advance (Boost/Zoom). Seat stays visually live until its turn.
  fastFold(i) {
    const s = this.seats[i];
    if (this.done || this.runout || s.folded || s.allIn || s.fastFolded) return false;
    if (i === this.toAct) {
      this.act(i, 'fold');
      return true;
    }
    s.fastFolded = true;
    this.version++;
    return true;
  }

  _roundComplete() {
    const actors = this.actors();
    if (actors.length === 0) return true;
    if (actors.length === 1 && !actors[0].fastFolded) {
      const a = actors[0];
      const maxOther = Math.max(0, ...this.live().filter((s) => s !== a).map((s) => s.bet));
      if (a.bet >= maxOther && (a.hasActed || a.bet >= this.currentBet || maxOther < this.currentBet)) return true;
    }
    return actors.every((s) => s.hasActed && s.bet === this.currentBet);
  }

  _proceed(startIdx) {
    this.version++;
    if (this.live().length === 1) return this._finishUncontested();
    if (this._roundComplete()) return this._endStreet();
    for (let k = 0; k < this.n; k++) {
      const i = (startIdx + k) % this.n;
      const s = this.seats[i];
      if (!s.folded && !s.allIn && (!s.hasActed || s.bet < this.currentBet)) {
        this.toAct = i;
        if (s.fastFolded) return this.act(i, 'fold');
        return;
      }
    }
    this._endStreet();
  }

  _collect() {
    for (const s of this.seats) s.bet = 0;
  }

  _dealStreet() {
    const idx = STREETS.indexOf(this.street);
    this.street = STREETS[idx + 1];
    this.deck.pop(); // burn
    const k = this.street === 'flop' ? 3 : 1;
    for (let j = 0; j < k; j++) this.board.push(this.deck.pop());
    this.log.push(`${STREET_RU[this.street]}: ${this.board.join(' ')}`);
  }

  _endStreet() {
    this.toAct = -1;
    this._collect();
    if (this.street === 'river' || this.actors().length <= 1) {
      // no more betting: anyone who fast-folded is folded now
      for (const s of this.live()) {
        if (s.fastFolded) {
          s.folded = true;
          s.lastAction = 'Фолд';
          this.log.push(`${s.name}: фолд`);
        }
      }
      if (this.live().length === 1) return this._finishUncontested();
    }
    if (this.street === 'river') return this._showdown();
    if (this.actors().length <= 1) {
      // all-in: reveal and run the board out (Game calls runoutStep with delays)
      this.runout = true;
      for (const s of this.live()) s.shown = true;
      this.version++;
      return;
    }
    this._dealStreet();
    this.currentBet = 0;
    this.lastRaise = this.bb;
    this.raiseLevel++;
    for (const s of this.seats) {
      s.hasActed = false;
      if (!s.folded && !s.allIn) s.lastAction = '';
    }
    this._proceed(1);
  }

  runoutStep() {
    if (!this.runout || this.done) return;
    this.version++;
    if (this.street === 'river') return this._showdown();
    this._dealStreet();
    if (this.street === 'river') {
      this.runout = false;
      this._showdown();
    }
  }

  _finishUncontested() {
    this.toAct = -1;
    this._collect();
    const w = this.live()[0];
    const total = this.potTotal;
    w.stack += total;
    w.won = total;
    this.pots = [{ amount: total, winners: [this.seats.indexOf(w)] }];
    this.log.push(`${w.name} забирает банк ${total}`);
    this.done = true;
    this.runout = false;
    this.version++;
  }

  computePots() {
    const contrib = this.seats.map((s) => s.committed);
    const pots = [];
    for (;;) {
      const liveIdx = this.seats.map((s, i) => i).filter((i) => !this.seats[i].folded && contrib[i] > 0);
      const rest = contrib.reduce((a, b) => a + b, 0);
      if (rest === 0) break;
      if (liveIdx.length === 0) {
        if (pots.length) pots[pots.length - 1].amount += rest;
        break;
      }
      const level = Math.min(...liveIdx.map((i) => contrib[i]));
      let amount = 0;
      for (let i = 0; i < contrib.length; i++) {
        const t = Math.min(contrib[i], level);
        amount += t;
        contrib[i] -= t;
      }
      const prev = pots[pots.length - 1];
      if (prev && prev.eligible.join() === liveIdx.join()) prev.amount += amount;
      else pots.push({ amount, eligible: liveIdx });
    }
    return pots;
  }

  _showdown() {
    this.toAct = -1;
    this.runout = false;
    this._collect();
    this.showdown = true;
    const live = this.live();
    const evals = {};
    for (const s of live) {
      const i = this.seats.indexOf(s);
      evals[i] = evalBest([...s.cards, ...this.board]);
      s.shown = true;
      s.handName = evals[i].name;
      s.best5 = evals[i].five;
    }
    const pots = this.computePots();
    const order = (i) => (i - 1 + this.n) % this.n; // first left of button gets odd chips
    pots.forEach((p, pi) => {
      const best = Math.max(...p.eligible.map((i) => evals[i].score));
      const winners = p.eligible.filter((i) => evals[i].score === best).sort((a, b) => order(a) - order(b));
      const share = Math.floor(p.amount / winners.length);
      let odd = p.amount - share * winners.length;
      for (const i of winners) {
        const amt = share + (odd > 0 ? 1 : 0);
        if (odd > 0) odd--;
        this.seats[i].stack += amt;
        this.seats[i].won += amt;
      }
      p.winners = winners;
      const label = pots.length > 1 ? (pi === 0 ? 'основной банк' : `сайд-пот ${pi}`) : 'банк';
      this.log.push(
        `${winners.map((i) => this.seats[i].name).join(', ')} ${winners.length > 1 ? 'делят' : 'выигрывает'} ${label} ${p.amount} — ${evals[winners[0]].name}`
      );
    });
    this.pots = pots;
    this.done = true;
    this.version++;
  }
}

module.exports = { Hand };
