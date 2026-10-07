'use strict';
// A "Boost" pool: players are seated at fresh 2–6 max tables from a queue.
// Folding releases you from the table immediately and puts you back in the queue.
const crypto = require('crypto');
const { Hand } = require('./hand');

const rid = (n = 8) => crypto.randomBytes(n).toString('hex');
const POS = {
  2: ['BTN/SB', 'BB'],
  3: ['BTN', 'SB', 'BB'],
  4: ['BTN', 'SB', 'BB', 'CO'],
  5: ['BTN', 'SB', 'BB', 'HJ', 'CO'],
  6: ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'],
};

const DEFAULTS = {
  sb: 1,
  bb: 2,
  buyIn: 200,
  maxBuyIn: 400,
  actionTime: 25, // seconds
  minTable: 4, // min players to start a table while others are still playing
  waitSec: 5, // wait this long for a fuller table
};

function cleanSettings(input, base) {
  const s = { ...base };
  const int = (v, lo, hi) => {
    const x = Math.floor(Number(v));
    return Number.isFinite(x) && x >= lo && x <= hi ? x : undefined;
  };
  const set = (k, lo, hi) => {
    if (input[k] === undefined) return;
    const v = int(input[k], lo, hi);
    if (v === undefined) throw new Error(`Некорректное значение: ${k}`);
    s[k] = v;
  };
  set('sb', 1, 1e9);
  set('bb', 1, 1e9);
  set('buyIn', 1, 1e12);
  set('maxBuyIn', 1, 1e12);
  set('actionTime', 5, 300);
  set('minTable', 2, 6);
  set('waitSec', 0, 60);
  if (s.sb > s.bb) throw new Error('Малый блайнд больше большого');
  if (s.buyIn > s.maxBuyIn) s.maxBuyIn = s.buyIn;
  return s;
}

class Game {
  constructor(id, settings) {
    this.id = id;
    this.settings = cleanSettings(settings || {}, DEFAULTS);
    this.players = new Map();
    this.tables = new Map();
    this.queue = [];
    this.chat = [];
    this.hostId = null;
    this.paused = false;
    this.handNo = 0;
    this.rev = 0;
    this.noticeSeq = 0;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
  }

  touch() {
    this.rev++;
    this.lastActivity = Date.now();
  }

  notice(p, text) {
    p.notice = { id: ++this.noticeSeq, text };
  }

  // ---------- players
  addPlayer(name, buyIn) {
    name = String(name || '').trim().slice(0, 16);
    if (!name) throw new Error('Введите имя');
    for (const q of this.players.values())
      if (q.status !== 'left' && q.name.toLowerCase() === name.toLowerCase()) throw new Error('Такое имя уже занято');
    const amt = Math.floor(Number(buyIn));
    if (!Number.isFinite(amt) || amt < 1 || amt > this.settings.maxBuyIn)
      throw new Error(`Закуп от 1 до ${this.settings.maxBuyIn}`);
    const p = {
      id: rid(6),
      token: rid(16),
      name,
      stack: amt,
      buyIn: amt,
      status: 'sitout',
      wantSitOut: false,
      tableId: null,
      connected: 0,
      queuedAt: 0,
      handsSinceBB: 0,
      handsPlayed: 0,
      history: [],
      notice: null,
      kicked: false,
      leaving: false,
    };
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;
    this.touch();
    return p;
  }

  byToken(token) {
    for (const p of this.players.values()) if (p.token === token) return p;
    return null;
  }

  seatOf(p) {
    if (!p.tableId) return null;
    const t = this.tables.get(p.tableId);
    if (!t) return null;
    const i = t.pids.indexOf(p.id);
    if (i < 0 || t.released[i]) return null;
    return { t, i };
  }

  chipsOf(p) {
    const so = this.seatOf(p);
    return p.stack + (so ? so.t.hand.seats[so.i].stack - so.t.credited[so.i] : 0);
  }

  setConnected(p, delta) {
    p.connected = Math.max(0, p.connected + delta);
    if (p.connected === 0 && p.status === 'queue') {
      this.dequeue(p);
      p.status = 'sitout';
    } else if (p.connected > 0 && p.status === 'sitout' && !p.wantSitOut) {
      this.enqueue(p);
    }
    this.touch();
  }

  enqueue(p) {
    if (p.status === 'table' || p.status === 'left') return;
    if (p.wantSitOut || p.stack <= 0 || p.connected === 0) {
      this.dequeue(p);
      p.status = 'sitout';
      return;
    }
    if (p.status !== 'queue') {
      p.status = 'queue';
      p.queuedAt = Date.now();
      this.queue.push(p.id);
    }
  }

  dequeue(p) {
    const k = this.queue.indexOf(p.id);
    if (k >= 0) this.queue.splice(k, 1);
  }

  // ---------- tables
  tryFormTables(now) {
    if (this.paused) return;
    this.queue = this.queue.filter((id) => this.players.get(id)?.status === 'queue');
    for (;;) {
      const q = this.queue;
      if (q.length < 2) return;
      const inHands = [...this.players.values()].filter((p) => p.status === 'table').length;
      const oldestWait = now - this.players.get(q[0]).queuedAt;
      const { minTable, waitSec } = this.settings;
      let take = 0;
      if (q.length >= 6) take = 6;
      else if (inHands === 0) take = q.length; // nobody else is coming back soon
      else if (q.length >= minTable && oldestWait >= waitSec * 1000) take = q.length;
      else if (oldestWait >= Math.max(12, waitSec * 4) * 1000) take = q.length;
      if (!take) return;
      this.formTable(q.splice(0, take), now);
    }
  }

  formTable(pids, now) {
    const ps = pids.map((id) => this.players.get(id));
    // shuffle, then the player who has waited longest for the big blind gets it
    for (let i = ps.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [ps[i], ps[j]] = [ps[j], ps[i]];
    }
    ps.sort((a, b) => b.handsSinceBB - a.handsSinceBB);
    const [bbP, sbP, ...rest] = ps;
    const order = ps.length === 2 ? [sbP, bbP] : [rest[0], sbP, bbP, ...rest.slice(1)];
    const hand = new Hand({
      players: order.map((p) => ({ id: p.id, name: p.name, stack: p.stack })),
      sb: this.settings.sb,
      bb: this.settings.bb,
    });
    const t = {
      id: rid(5),
      no: ++this.handNo,
      hand,
      pids: order.map((p) => p.id),
      released: order.map(() => false),
      credited: order.map(() => 0),
      turnKey: '',
      turnStart: now,
      nextRunoutAt: 0,
      endAt: 0,
      finished: false,
    };
    for (const p of order) {
      p.stack = 0;
      p.status = 'table';
      p.tableId = t.id;
      p.handsSinceBB = p === bbP ? 0 : p.handsSinceBB + 1;
      p.handsPlayed++;
    }
    this.tables.set(t.id, t);
    hand.start();
    this.sync(t, now);
  }

  // called after every change to a hand
  sync(t, now) {
    const h = t.hand;
    if (h.toAct >= 0) {
      const key = `${h.street}:${h.toAct}:${h.currentBet}:${h.version}`;
      const prevActor = t.turnKey.split(':')[1];
      if (prevActor !== String(h.toAct) || !t.turnKey.startsWith(h.street + ':')) t.turnStart = now;
      t.turnKey = key;
    } else t.turnKey = '';
    if (h.runout && !t.nextRunoutAt) t.nextRunoutAt = now + 1200;
    if (h.done && !t.finished) this.finishHand(t, now);
    this.touch();
  }

  credit(t, i) {
    const p = this.players.get(t.pids[i]);
    const s = t.hand.seats[i];
    const c = s.stack - t.credited[i];
    t.credited[i] = s.stack;
    if (p) p.stack += c;
    return c;
  }

  recordHistory(t, i) {
    const p = this.players.get(t.pids[i]);
    if (!p) return;
    const h = t.hand;
    const s = h.seats[i];
    const e = {
      no: t.no,
      pos: POS[h.n][i],
      cards: s.cards,
      board: h.board.slice(),
      net: s.stack - s.startStack,
      result: s.handName || (s.won ? 'забрал банк' : s.folded || s.fastFolded ? 'фолд' : ''),
    };
    const k = p.history.findIndex((x) => x.no === t.no);
    if (k >= 0) p.history[k] = e;
    else p.history.unshift(e);
    if (p.history.length > 40) p.history.length = 40;
  }

  releaseSeat(t, i) {
    if (t.released[i]) return;
    t.released[i] = true;
    this.credit(t, i);
    this.recordHistory(t, i);
    const p = this.players.get(t.pids[i]);
    if (!p || p.tableId !== t.id) return;
    p.tableId = null;
    p.status = 'idle';
    if (p.kicked || p.leaving) {
      p.status = 'left';
      p.leaving = false;
    } else {
      if (p.stack <= 0) this.notice(p, 'Фишки закончились — нажмите «Докупить»');
      this.enqueue(p);
    }
    this.maybeDropTable(t);
  }

  finishHand(t, now) {
    t.finished = true;
    const h = t.hand;
    for (let i = 0; i < h.n; i++) {
      this.credit(t, i); // also pays fast-folders who won uncontested (e.g. BB)
      this.recordHistory(t, i);
    }
    t.endAt = now + (h.showdown ? 5000 : 1800);
  }

  maybeDropTable(t) {
    if (t.finished && t.released.every(Boolean)) this.tables.delete(t.id);
  }

  // ---------- player commands
  command(p, msg) {
    const now = Date.now();
    switch (msg.t) {
      case 'act': return this.cmdAct(p, msg, now);
      case 'next': {
        const so = this.seatOf(p);
        if (so && so.t.hand.done) this.releaseSeat(so.t, so.i);
        break;
      }
      case 'sitout': {
        p.wantSitOut = !!msg.value;
        if (p.wantSitOut) {
          if (p.status === 'queue') {
            this.dequeue(p);
            p.status = 'sitout';
          }
        } else if (p.status === 'sitout') this.enqueue(p);
        break;
      }
      case 'rebuy': {
        const amt = Math.floor(Number(msg.amount));
        const chips = this.chipsOf(p);
        const max = this.settings.maxBuyIn - chips;
        if (!Number.isFinite(amt) || amt < 1) throw new Error('Некорректная сумма');
        if (amt > max) throw new Error(max > 0 ? `Можно докупить максимум ${max}` : `Стек уже не меньше максимума (${this.settings.maxBuyIn})`);
        p.stack += amt;
        p.buyIn += amt;
        this.chatSys(`${p.name} докупил ${amt}`);
        if (p.status === 'sitout' && !p.wantSitOut) this.enqueue(p);
        break;
      }
      case 'leave': return this.removePlayer(p, false);
      case 'rejoin': {
        if (p.status !== 'left' || p.kicked) break;
        p.status = 'sitout';
        p.wantSitOut = false;
        this.enqueue(p);
        break;
      }
      case 'chat': {
        const text = String(msg.text || '').trim().slice(0, 200);
        if (!text) break;
        this.chat.push({ name: p.name, text, ts: now });
        if (this.chat.length > 80) this.chat.shift();
        break;
      }
      // ---- host
      case 'settings':
        this.mustHost(p);
        this.settings = cleanSettings(msg.settings || {}, this.settings);
        this.chatSys(`Настройки обновлены: блайнды ${this.settings.sb}/${this.settings.bb}`);
        break;
      case 'pause':
        this.mustHost(p);
        this.paused = !!msg.value;
        this.chatSys(this.paused ? 'Игра на паузе (текущие раздачи доигрываются)' : 'Игра продолжается');
        break;
      case 'adjust': {
        this.mustHost(p);
        const q = this.players.get(msg.id);
        const amt = Math.floor(Number(msg.amount));
        if (!q || !Number.isFinite(amt) || amt === 0) throw new Error('Некорректно');
        if (q.stack + amt < 0) throw new Error('Нельзя снять больше, чем фишек вне раздачи');
        q.stack += amt;
        q.buyIn += amt;
        this.chatSys(`Хост ${amt > 0 ? 'добавил' : 'снял'} ${Math.abs(amt)} ${amt > 0 ? 'игроку' : 'у игрока'} ${q.name}`);
        if (q.status === 'sitout' && !q.wantSitOut) this.enqueue(q);
        break;
      }
      case 'kick': {
        this.mustHost(p);
        const q = this.players.get(msg.id);
        if (!q || q === p) throw new Error('Некорректно');
        this.removePlayer(q, true);
        break;
      }
      case 'makeHost': {
        this.mustHost(p);
        const q = this.players.get(msg.id);
        if (!q || q.status === 'left') throw new Error('Некорректно');
        this.hostId = q.id;
        this.chatSys(`${q.name} теперь хост`);
        break;
      }
      default:
        throw new Error('Неизвестная команда');
    }
    this.touch();
  }

  mustHost(p) {
    if (p.id !== this.hostId) throw new Error('Только для хоста');
  }

  chatSys(text) {
    this.chat.push({ name: '', text, ts: Date.now(), sys: true });
    if (this.chat.length > 80) this.chat.shift();
  }

  removePlayer(p, kicked) {
    if (kicked) p.kicked = true;
    this.dequeue(p);
    const so = this.seatOf(p);
    if (so) {
      const { t, i } = so;
      const h = t.hand;
      const s = h.seats[i];
      if (h.done || s.folded) this.releaseSeat(t, i);
      else if (s.allIn || h.runout) p.leaving = true; // released at the end of the hand
      else {
        p.leaving = true;
        if (h.toAct === i) h.act(i, 'fold');
        else h.fastFold(i);
        this.releaseSeat(t, i);
        this.sync(t, Date.now());
      }
    } else p.status = 'left';
    this.chatSys(kicked ? `${p.name} удалён из игры` : `${p.name} вышел из игры`);
    this.touch();
  }

  cmdAct(p, msg, now) {
    const so = this.seatOf(p);
    if (!so) throw new Error('Вы сейчас не за столом');
    const { t, i } = so;
    const h = t.hand;
    if (msg.kind === 'fold') {
      if (h.done) return this.releaseSeat(t, i);
      if (h.toAct === i) h.act(i, 'fold');
      else if (!h.fastFold(i)) throw new Error('Сейчас нельзя сбросить');
      this.releaseSeat(t, i); // Boost: straight to the next table
    } else {
      h.act(i, msg.kind, msg.amount);
    }
    this.sync(t, now);
  }

  // ---------- clock
  tick(now) {
    for (const t of [...this.tables.values()]) {
      const h = t.hand;
      if (!h.done && h.toAct >= 0) {
        const p = this.players.get(t.pids[h.toAct]);
        const limit = p && p.connected > 0 && p.status !== 'left' ? this.settings.actionTime * 1000 : 6000;
        if (now - t.turnStart >= limit) {
          const i = h.toAct;
          const la = h.legal(i);
          if (la.canCheck) h.act(i, 'check');
          else {
            h.act(i, 'fold');
            if (p) {
              p.wantSitOut = true;
              this.notice(p, 'Время на ход вышло — вы пропускаете раздачи. Нажмите «Вернуться в игру».');
            }
            this.releaseSeat(t, i);
          }
          this.sync(t, now);
        }
      }
      if (h.runout && t.nextRunoutAt && now >= t.nextRunoutAt) {
        h.runoutStep();
        t.nextRunoutAt = h.runout ? now + 1200 : 0;
        this.sync(t, now);
      }
      if (t.finished && now >= t.endAt) {
        for (let i = 0; i < h.n; i++) this.releaseSeat(t, i);
        this.tables.delete(t.id);
        this.touch();
      }
    }
    const before = this.rev;
    const qBefore = this.queue.length;
    this.tryFormTables(now);
    if (this.queue.length !== qBefore) this.touch();
    return this.rev !== before;
  }

  // ---------- views
  tableView(t, p, now) {
    const h = t.hand;
    const me = t.pids.indexOf(p.id);
    const seats = h.seats.map((s, i) => {
      const q = this.players.get(t.pids[i]);
      const isMe = i === me;
      const visibleFolded = s.folded; // fast-folds stay hidden from others until their turn
      return {
        name: s.name,
        stack: s.stack,
        bet: s.bet,
        folded: visibleFolded,
        allIn: s.allIn,
        lastAction: s.lastAction,
        pos: POS[h.n][i],
        me: isMe,
        turn: i === h.toAct,
        cards: isMe || s.shown ? s.cards : visibleFolded ? null : ['??', '??'],
        won: h.done ? s.won : 0,
        net: h.done ? s.stack - s.startStack : 0,
        handName: h.done && s.shown ? s.handName : '',
        best5: h.done && s.shown ? s.best5 || [] : [],
        connected: !!(q && q.connected),
      };
    });
    const limit = (() => {
      if (h.toAct < 0) return 0;
      const q = this.players.get(t.pids[h.toAct]);
      return q && q.connected > 0 && q.status !== 'left' ? this.settings.actionTime * 1000 : 6000;
    })();
    const betsSum = h.seats.reduce((a, s) => a + s.bet, 0);
    return {
      id: t.id,
      no: t.no,
      n: h.n,
      street: h.street,
      board: h.board,
      seats,
      mySeat: me,
      toAct: h.toAct,
      deadline: h.toAct >= 0 ? t.turnStart + limit : 0,
      turnLimit: limit,
      potTotal: h.potTotal,
      potCenter: h.potTotal - betsSum,
      currentBet: h.currentBet,
      bb: h.bb,
      legal: me >= 0 && me === h.toAct ? h.legal(me) : null,
      canFastFold: me >= 0 && !h.done && !h.runout && me !== h.toAct && !h.seats[me].folded && !h.seats[me].allIn && !h.seats[me].fastFolded,
      done: h.done,
      showdown: h.showdown,
      runout: h.runout,
      pots: h.done && h.pots ? h.pots.map((x) => ({ amount: x.amount, winners: x.winners })) : null,
      endAt: t.endAt,
      log: h.log.slice(-30),
    };
  }

  stateFor(p, now = Date.now()) {
    const all = [...this.players.values()];
    const so = this.seatOf(p);
    return {
      t: 'state',
      now,
      game: { id: this.id, settings: this.settings, paused: this.paused, hostId: this.hostId },
      me: {
        id: p.id,
        name: p.name,
        stack: p.stack,
        chips: this.chipsOf(p),
        buyIn: p.buyIn,
        status: p.status,
        wantSitOut: p.wantSitOut,
        isHost: p.id === this.hostId,
        kicked: p.kicked,
        history: p.history.slice(0, 25),
        notice: p.notice,
        queuePos: p.status === 'queue' ? this.queue.indexOf(p.id) + 1 : 0,
        queuedAt: p.queuedAt,
      },
      pool: {
        queue: this.queue.length,
        playing: all.filter((q) => q.status === 'table').length,
        sitout: all.filter((q) => q.status === 'sitout').length,
        tables: this.tables.size,
      },
      players: all.map((q) => {
        const chips = this.chipsOf(q);
        return {
          id: q.id,
          name: q.name,
          status: q.status,
          wantSitOut: q.wantSitOut,
          chips,
          buyIn: q.buyIn,
          net: chips - q.buyIn,
          connected: q.connected > 0,
          hands: q.handsPlayed,
          isHost: q.id === this.hostId,
        };
      }),
      table: so ? this.tableView(so.t, p, now) : null,
      chat: this.chat.slice(-50),
    };
  }
}

module.exports = { Game, DEFAULTS, cleanSettings };
