'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n) => Number(n).toLocaleString('ru-RU');
  const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n));
  const netCls = (n) => (n > 0 ? 'pos-net' : n < 0 ? 'neg-net' : 'muted');
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  const gameId = location.pathname.split('/')[2];
  let token = store.get('bp:' + gameId);
  const hashTok = new URLSearchParams(location.hash.slice(1)).get('t');
  if (hashTok) {
    token = hashTok;
    store.set('bp:' + gameId, token);
    history.replaceState(null, '', location.pathname); // never leak the token in a shared link
  }

  let S = null; // last state
  let offset = 0; // serverNow - clientNow
  let sock = null;
  let retry = 0;
  let tab = 'chat';
  let lastNotice = 0;
  let lastChatLen = 0;
  let actionKey = '';
  let raiseTo = 0;
  let wasMyTurn = false;
  let muted = store.get('bp:muted') === '1';
  const sNow = () => Date.now() + offset;

  // ---------- connection
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    sock = new WebSocket(`${proto}://${location.host}/ws`);
    sock.onopen = () => {
      retry = 0;
      $('banner').classList.add('hidden');
      send({ t: 'hello', gameId, token });
    };
    sock.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'state') { offset = m.now - Date.now(); S = m; render(); }
      else if (m.t === 'need_join') showJoin(m.settings);
      else if (m.t === 'joined') { token = m.token; store.set('bp:' + gameId, token); closeModal(); }
      else if (m.t === 'nogame') fatal('Игра не найдена', 'Возможно, сервер перезапускался и игра удалилась. Создайте новую.');
      else if (m.t === 'kicked') fatal('Вы удалены из игры', 'Хост убрал вас из этой игры.');
      else if (m.t === 'error') toast(m.msg);
    };
    sock.onclose = () => {
      if (fatalShown) return;
      $('banner').classList.remove('hidden');
      setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
    };
  }
  const send = (o) => { if (sock && sock.readyState === 1) sock.send(JSON.stringify(o)); };
  // keep free hosting awake while someone has the page open
  setInterval(() => fetch('/ping').catch(() => {}), 4 * 60 * 1000);

  let fatalShown = false;
  function fatal(title, text) {
    fatalShown = true;
    $('app').classList.add('hidden');
    modal(`<h3>${esc(title)}</h3><div class="muted">${esc(text)}</div><div class="btns"><button class="primary" onclick="location.href='/'">На главную</button></div>`, false);
  }

  // ---------- modal / toast
  function modal(html, closable = true) {
    $('modalRoot').innerHTML = `<div class="modal-bg"><div class="modal">${html}</div></div>`;
    const bg = $('modalRoot').firstChild;
    if (closable) bg.addEventListener('mousedown', (e) => { if (e.target === bg) closeModal(); });
    return bg.firstChild;
  }
  function closeModal() { $('modalRoot').innerHTML = ''; }
  let toastT = 0;
  function toast(text, ms = 3000) {
    const t = $('toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.add('hidden'), ms);
  }

  function showJoin(st) {
    const m = modal(`
      <h3>Присоединиться к игре</h3>
      <div class="muted">Блайнды ${fmt(st.sb)}/${fmt(st.bb)} · закуп до ${fmt(st.maxBuyIn)}</div>
      <form class="form" id="joinForm" style="padding:0;border:0;background:none">
        <label>Ваше имя<input type="text" id="jName" maxlength="16" required autocomplete="nickname"></label>
        <label>Закуп<input type="number" id="jBuy" min="1" max="${st.maxBuyIn}" value="${st.buyIn}" required></label>
        <button class="primary">Сесть за стол</button>
      </form>`, false);
    $('jName').value = store.get('bp:name') || '';
    $('jName').focus();
    m.querySelector('#joinForm').addEventListener('submit', (e) => {
      e.preventDefault();
      store.set('bp:name', $('jName').value);
      send({ t: 'join', name: $('jName').value, buyIn: +$('jBuy').value });
    });
  }

  // ---------- cards
  const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
  function cardHtml(c, cls = '') {
    if (!c || c === '??') return `<div class="card back ${cls}"></div>`;
    const r = c[0] === 'T' ? '10' : c[0];
    return `<div class="card s-${c[1]} ${cls}"><b>${r}</b><i>${SUIT[c[1]]}</i></div>`;
  }

  // ---------- render
  function render() {
    if (!S || fatalShown) return;
    if (S.me.kicked) return fatal('Вы удалены из игры', 'Хост убрал вас из этой игры.');
    $('app').classList.remove('hidden');
    const { me, game, pool } = S;
    const st = game.settings;
    $('blinds').innerHTML = `Блайнды <b>${fmt(st.sb)}/${fmt(st.bb)}</b>${game.paused ? ' · <b>пауза</b>' : ''}`;
    $('poolChip').innerHTML = `Столов <b>${pool.tables}</b> · в очереди <b>${pool.queue}</b> · играют <b>${pool.playing}</b>`;
    $('myChips').textContent = fmt(me.chips);
    const net = me.chips - me.buyIn;
    $('myNet').innerHTML = `<span class="${netCls(net)}">${signed(net)}</span> <span class="muted hide-xs">· закуп ${fmt(me.buyIn)}</span>`;
    $('btnSettings').classList.toggle('hidden', !me.isHost);
    document.title = S.table && S.table.legal ? '● Ваш ход — Boost Poker' : 'Boost Poker';

    if (me.notice && me.notice.id !== lastNotice) {
      toast(me.notice.text, 5000);
      lastNotice = me.notice.id;
    }

    if (S.table) renderTable(S.table);
    else renderWaiting();
    renderActions();
    renderSide();

    const myTurn = !!(S.table && S.table.legal);
    if (myTurn && !wasMyTurn) beep();
    wasMyTurn = myTurn;
  }

  const seatXY = (v, n, r) => {
    const a = Math.PI / 2 + (v * 2 * Math.PI) / n;
    return [50 + r[0] * Math.cos(a), 50 + r[1] * Math.sin(a)];
  };

  function renderTable(T) {
    $('waiting').classList.add('hidden');
    $('tableWrap').classList.remove('hidden');
    $('handNo').textContent = `Раздача #${T.no}`;
    const portrait = $('tableWrap').clientHeight > $('tableWrap').clientWidth;
    const R = portrait ? [40, 41] : [44, 40];
    const RB = portrait ? [25, 24] : [31, 25];
    const me = T.mySeat < 0 ? 0 : T.mySeat;
    const winSet = new Set();
    if (T.done) T.seats.forEach((s) => (s.best5 || []).forEach((c) => s.won && winSet.add(c)));

    let html = '';
    T.seats.forEach((s, i) => {
      const v = (i - me + T.n) % T.n;
      const [x, y] = seatXY(v, T.n, R);
      const cls = ['seat', s.me && 'me', s.turn && 'turn', s.folded && 'folded', T.done && s.won > 0 && 'winner', !s.connected && 'off'].filter(Boolean).join(' ');
      let cards = '';
      if (s.cards) cards = s.cards.map((c) => cardHtml(c, T.done && winSet.size && s.won && winSet.has(c) ? 'hl' : '')).join('');
      let tag = '';
      if (T.done && s.won > 0) tag = `<div class="tag win">+${fmt(s.won)}${s.handName ? ' · ' + esc(s.handName) : ''}</div>`;
      else if (T.done && s.handName) tag = `<div class="tag">${esc(s.handName)}</div>`;
      else if (s.allIn) tag = `<div class="tag">Олл-ин</div>`;
      else if (s.lastAction) tag = `<div class="tag">${esc(s.lastAction)}</div>`;
      const timer = s.turn ? `<div class="timer"><i data-timer></i></div>` : '';
      html += `<div class="${cls}" style="left:${x}%;top:${y}%">
        <div class="hole">${cards}</div>
        <div class="plate"><span class="ps">${s.pos}</span><div class="nm">${esc(s.name)}</div><div class="st">${s.allIn && !T.done ? 'ALL-IN' : fmt(s.stack)}</div>${timer}</div>
        ${tag}</div>`;
      if (s.bet > 0) {
        const [bx, by] = seatXY(v, T.n, RB);
        html += `<div class="bet" style="left:${bx}%;top:${by}%">${fmt(s.bet)}</div>`;
      }
      if (i === 0) {
        const [dx, dy] = seatXY(v + T.n / 18, T.n, [R[0] * 0.8, R[1] * 0.74]);
        html += `<div class="dealer" style="left:${dx}%;top:${dy}%">D</div>`;
      }
    });
    $('seats').innerHTML = html;

    // board (animate only newly dealt cards)
    const boardEl = $('board');
    const had = boardEl.dataset.key === String(T.id) ? +boardEl.dataset.count : 0;
    boardEl.innerHTML = T.board.map((c, k) => cardHtml(c, (k >= had ? 'deal ' : '') + (T.done && winSet.size ? (winSet.has(c) ? 'hl' : 'dim') : ''))).join('');
    boardEl.dataset.key = T.id;
    boardEl.dataset.count = T.board.length;

    if (T.done && T.pots) {
      $('pot').innerHTML = T.pots.length > 1
        ? `<div class="pot">${T.pots.map((p, k) => `${k ? 'Сайд' : 'Банк'} ${fmt(p.amount)}`).join(' · ')}</div>`
        : `<div class="pot">Банк ${fmt(T.pots[0].amount)}</div>`;
    } else {
      $('pot').innerHTML = T.potTotal > 0 ? `<div class="pot">Банк ${fmt(T.potTotal)}</div>` : '';
    }
    let banner = '';
    if (T.done) {
      const mine = T.seats[T.mySeat];
      if (mine) banner = `<div class="result-banner">Вы: <b class="${netCls(mine.net)}">${signed(mine.net)}</b></div>`;
    } else if (T.runout) banner = `<div class="result-banner">Олл-ин — докладываем борд</div>`;
    $('resultBanner').innerHTML = banner;
  }

  function renderWaiting() {
    $('tableWrap').classList.add('hidden');
    const w = $('waiting');
    w.classList.remove('hidden');
    const { me, pool, game } = S;
    let html = '';
    if (me.status === 'left') {
      html = `<h2>Вы вышли из игры</h2><div class="muted">Ваш результат сохранён в «Итогах».</div><button class="primary" id="wRejoin">Вернуться в игру</button>`;
    } else if (me.stack <= 0 && me.chips <= 0) {
      html = `<h2>Фишки закончились</h2><div class="muted">Докупитесь, чтобы продолжить.</div><button class="primary" id="wRebuy">Докупить</button>`;
    } else if (me.status === 'sitout') {
      html = `<div class="pulse">II</div><h2>Вы пропускаете раздачи</h2><div class="muted">Фишки: ${fmt(me.chips)}</div><button class="primary" id="wBack">Вернуться в игру</button>`;
    } else {
      const waitedS = Math.max(0, Math.floor((sNow() - me.queuedAt) / 1000));
      html = `<div class="pulse">${pool.queue}</div>
        <h2>${game.paused ? 'Игра на паузе' : 'Ищем стол…'}</h2>
        <div class="muted">${game.paused ? 'Хост скоро продолжит игру' : 'Стол соберётся, как только освободятся игроки'}</div>
        <div class="pool-stats"><span class="chip">В очереди <b>${pool.queue}</b></span><span class="chip">Играют <b>${pool.playing}</b></span><span class="chip">Столов <b>${pool.tables}</b></span><span class="chip">Ждёте <b data-wait>${waitedS}</b> с</span></div>
        <button class="ghost" id="wSit">Пропускать раздачи</button>`;
    }
    const lh = me.history[0];
    if (lh) {
      html += `<div class="last-hand"><span class="muted">Прошлая #${lh.no}</span><div class="mini">${lh.cards.map((c) => cardHtml(c)).join('')}</div>
        <div class="mini">${lh.board.map((c) => cardHtml(c)).join('')}</div><b class="${netCls(lh.net)}">${signed(lh.net)}</b></div>`;
    }
    w.innerHTML = html;
    const on = (id, f) => { const el = $(id); if (el) el.onclick = f; };
    on('wRejoin', () => send({ t: 'rejoin' }));
    on('wRebuy', openRebuy);
    on('wBack', () => send({ t: 'sitout', value: false }));
    on('wSit', () => send({ t: 'sitout', value: true }));
  }

  // ---------- actions
  function presets(T, L) {
    const bb = T.bb;
    const out = [];
    const clamp = (x) => Math.max(L.minRaiseTo, Math.min(L.maxRaiseTo, Math.round(x)));
    const potAfterCall = T.potTotal + L.callAmount;
    if (T.street === 'preflop' && T.currentBet <= bb) {
      out.push(['2x', clamp(bb * 2)], ['2.5x', clamp(bb * 2.5)], ['3x', clamp(bb * 3)]);
    } else if (T.street === 'preflop') {
      out.push(['3x', clamp(T.currentBet * 3)]);
    } else {
      out.push(['⅓', clamp(T.currentBet + potAfterCall / 3)], ['½', clamp(T.currentBet + potAfterCall / 2)], ['⅔', clamp(T.currentBet + (potAfterCall * 2) / 3)]);
    }
    out.push(['Пот', clamp(T.currentBet + potAfterCall)], ['Олл-ин', L.maxRaiseTo]);
    return out;
  }

  function renderActions() {
    const el = $('actions');
    const T = S.table;
    const me = S.me;
    let mode, key;
    if (!T) { mode = 'none'; key = 'none'; }
    else if (T.done) { mode = 'done'; key = 'done' + T.id; }
    else if (T.legal) { mode = 'turn'; key = ['turn', T.id, T.street, T.currentBet, JSON.stringify(T.legal)].join('|'); }
    else if (T.canFastFold) { mode = 'ff'; key = 'ff' + T.id; }
    else { mode = 'wait'; key = 'wait' + T.id; }
    if (key === actionKey) return;
    actionKey = key;

    if (mode === 'none') {
      el.innerHTML = me.status === 'queue' ? `<span class="hint">Сброс карт = мгновенный переход за новый стол. Горячие клавиши: F — фолд, C — чек/колл, R — рейз.</span>` : '';
      return;
    }
    if (mode === 'done') {
      el.innerHTML = `<button class="big primary" id="aNext">Дальше <span data-left></span></button><span class="hint">Следующий стол — сразу после нажатия</span>`;
      $('aNext').onclick = () => send({ t: 'next' });
      return;
    }
    if (mode === 'ff') {
      el.innerHTML = `<button class="big btn-ff" id="aFF">Быстрый фолд<kbd>F</kbd></button><span class="hint">Сбросить сейчас и сразу перейти за новый стол.<br>Остальные увидят ваш фолд, когда дойдёт очередь.</span>`;
      $('aFF').onclick = () => send({ t: 'act', kind: 'fold' });
      return;
    }
    if (mode === 'wait') {
      el.innerHTML = `<span class="hint">${T.runout ? 'Ждём борд…' : 'Ждём соперников…'}</span>`;
      return;
    }
    const L = T.legal;
    raiseTo = L.minRaiseTo;
    let html = `<button class="big btn-fold" id="aFold">Фолд<kbd>F</kbd></button>`;
    html += L.canCheck
      ? `<button class="big btn-call" id="aCall">Чек<kbd>C</kbd></button>`
      : `<button class="big btn-call" id="aCall">Колл ${fmt(L.callAmount)}<kbd>C</kbd></button>`;
    if (L.canRaise) {
      const word = L.isBet ? 'Бет' : 'Рейз до';
      html += `<button class="big btn-raise" id="aRaise">${word} <span id="raiseLbl">${fmt(raiseTo)}</span><kbd>R</kbd></button>`;
      if (L.maxRaiseTo > L.minRaiseTo) {
        html += `<div class="sizing">${presets(T, L).map(([lbl, v]) => `<button data-v="${v}">${lbl}</button>`).join('')}
          <input type="range" id="raiseRange" min="${L.minRaiseTo}" max="${L.maxRaiseTo}" step="1" value="${raiseTo}">
          <input type="number" id="raiseNum" min="${L.minRaiseTo}" max="${L.maxRaiseTo}" value="${raiseTo}"></div>`;
      }
    }
    el.innerHTML = html;
    $('aFold').onclick = () => {
      if (L.canCheck && !confirm('Можно чекнуть бесплатно. Всё равно сбросить?')) return;
      send({ t: 'act', kind: 'fold' });
    };
    $('aCall').onclick = () => send({ t: 'act', kind: L.canCheck ? 'check' : 'call' });
    if (L.canRaise) {
      const setR = (v, from) => {
        v = Math.max(L.minRaiseTo, Math.min(L.maxRaiseTo, Math.round(+v || 0)));
        raiseTo = v;
        $('raiseLbl').textContent = v === L.maxRaiseTo ? `${fmt(v)} (олл-ин)` : fmt(v);
        if ($('raiseRange') && from !== 'range') $('raiseRange').value = v;
        if ($('raiseNum') && from !== 'num') $('raiseNum').value = v;
      };
      $('aRaise').onclick = () => send({ t: 'act', kind: 'raise', amount: raiseTo });
      el.querySelectorAll('.sizing button').forEach((b) => (b.onclick = () => setR(b.dataset.v)));
      if ($('raiseRange')) {
        $('raiseRange').oninput = (e) => setR(e.target.value, 'range');
        $('raiseNum').oninput = (e) => { raiseTo = Math.max(L.minRaiseTo, Math.min(L.maxRaiseTo, +e.target.value || 0)); $('raiseLbl').textContent = fmt(raiseTo); };
        $('raiseNum').onchange = (e) => setR(e.target.value, 'num');
        $('raiseNum').onkeydown = (e) => { if (e.key === 'Enter') { setR(e.target.value); $('aRaise').click(); } };
      }
    }
  }

  document.addEventListener('keydown', (e) => {
    if (!S || !S.table || e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return;
    const T = S.table;
    const k = e.key.toLowerCase();
    if (k === 'f' || k === 'а') {
      if (T.legal) $('aFold')?.click();
      else if (T.canFastFold) send({ t: 'act', kind: 'fold' });
    } else if ((k === 'c' || k === 'с' || k === 'k' || k === 'л') && T.legal) $('aCall')?.click();
    else if ((k === 'r' || k === 'к') && T.legal) $('aRaise')?.click();
    else if ((k === ' ' || k === 'enter') && T.done) { e.preventDefault(); send({ t: 'next' }); }
  });

  // ---------- timers (smooth)
  function frame() {
    if (S && S.table) {
      const T = S.table;
      const bar = document.querySelector('[data-timer]');
      if (bar && T.deadline) {
        const left = Math.max(0, T.deadline - sNow());
        const frac = T.turnLimit ? left / T.turnLimit : 0;
        bar.style.width = (frac * 100).toFixed(1) + '%';
        bar.classList.toggle('low', left < 6000);
      }
      const nl = document.querySelector('[data-left]');
      if (nl && T.endAt) nl.textContent = `(${Math.max(0, Math.ceil((T.endAt - sNow()) / 1000))})`;
    } else if (S) {
      const w = document.querySelector('[data-wait]');
      if (w && S.me.queuedAt) w.textContent = Math.max(0, Math.floor((sNow() - S.me.queuedAt) / 1000));
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---------- sound
  let actx = null;
  function beep() {
    if (muted) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.15, actx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.25);
      o.connect(g).connect(actx.destination);
      o.start();
      o.stop(actx.currentTime + 0.3);
    } catch {}
  }

  // ---------- side panel
  document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => {
    tab = b.dataset.tab;
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    renderSide(true);
  }));
  function renderSide(force) {
    const pane = $('pane');
    const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
    $('chatForm').classList.toggle('hidden', tab !== 'chat');
    let html = '';
    if (tab === 'chat') {
      html = S.chat.map((m) => (m.sys ? `<div class="msg sys">${esc(m.text)}</div>` : `<div class="msg"><b>${esc(m.name)}:</b> ${esc(m.text)}</div>`)).join('') || '<div class="muted">Пока тихо.</div>';
      if (S.chat.length !== lastChatLen && !force && lastChatLen && !$('side').classList.contains('open') && window.innerWidth <= 900) {
        const last = S.chat[S.chat.length - 1];
        if (last && !last.sys) $('btnSide').textContent = 'Чат •';
      }
      lastChatLen = S.chat.length;
    } else if (tab === 'log') {
      html = S.table ? S.table.log.map((l) => `<div class="msg">${esc(l)}</div>`).join('') : '<div class="muted">Вы сейчас не за столом.</div>';
    } else {
      html = S.me.history.map((h) => `<div class="hist"><div class="mini">${h.cards.map((c) => cardHtml(c)).join('')}</div>
        <div class="meta"><div>#${h.no} · ${esc(h.pos)} · ${esc(h.result || '')}</div><div class="muted">${h.board.length ? h.board.map((c) => (c[0] === 'T' ? '10' : c[0]) + SUIT[c[1]]).join(' ') : 'до флопа'}</div></div>
        <b class="${netCls(h.net)}">${signed(h.net)}</b></div>`).join('') || '<div class="muted">Раздач ещё не было.</div>';
    }
    if (pane.dataset.html !== html) {
      pane.innerHTML = html;
      pane.dataset.html = html;
      if (tab !== 'hist' && (atBottom || force)) pane.scrollTop = pane.scrollHeight;
    }
  }
  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('chatInput').value.trim();
    if (v) send({ t: 'chat', text: v });
    $('chatInput').value = '';
  });
  $('btnSide').onclick = () => {
    $('side').classList.toggle('open');
    $('btnSide').textContent = 'Чат';
  };
  $('stage').addEventListener('click', () => $('side').classList.remove('open'));

  // ---------- top buttons
  $('btnInvite').onclick = async () => {
    const url = location.origin + '/g/' + gameId;
    try { await navigator.clipboard.writeText(url); toast('Ссылка скопирована: ' + url); }
    catch { modal(`<h3>Ссылка для друзей</h3><input type="text" value="${esc(url)}" onclick="this.select()" readonly><div class="btns"><button onclick="document.getElementById('modalRoot').innerHTML=''">Закрыть</button></div>`); }
  };
  $('btnRebuy').onclick = openRebuy;
  function openRebuy() {
    const st = S.game.settings;
    const max = st.maxBuyIn - S.me.chips;
    if (max <= 0) return toast(`Ваш стек уже не меньше максимума (${fmt(st.maxBuyIn)})`);
    const m = modal(`<h3>Докупить фишки</h3>
      <div class="muted">Сейчас у вас ${fmt(S.me.chips)}. Максимальный стек — ${fmt(st.maxBuyIn)}. Если вы в раздаче, фишки добавятся к следующей.</div>
      <input type="number" id="rbAmt" min="1" max="${max}" value="${Math.min(max, st.buyIn)}">
      <div class="btns"><button id="rbMax">До максимума (${fmt(max)})</button><button class="primary" id="rbGo">Докупить</button></div>`);
    $('rbAmt').focus();
    $('rbMax').onclick = () => ($('rbAmt').value = max);
    $('rbGo').onclick = () => { send({ t: 'rebuy', amount: +$('rbAmt').value }); closeModal(); };
    m.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('rbGo').click(); });
  }

  $('btnLedger').onclick = () => openLedger();
  const STATUS = { table: ['за столом', 'g'], queue: ['ждёт стол', 'g'], idle: ['ждёт стол', 'g'], sitout: ['пропускает', 'y'], left: ['вышел', 'r'] };
  function openLedger() {
    const isHost = S.me.isHost;
    const rows = [...S.players].sort((a, b) => b.net - a.net);
    const totalNet = rows.reduce((a, p) => a + p.net, 0);
    const m = modal(`<h3>Итоги игры</h3>
      <table class="ledger"><thead><tr><th>Игрок</th><th>Закуп</th><th>Фишки</th><th>Итог</th>${isHost ? '<th></th>' : ''}</tr></thead><tbody>
      ${rows.map((p) => {
        const [sl, sc] = STATUS[p.status] || ['', ''];
        return `<tr><td>${esc(p.name)}${p.isHost ? '<span class="badge">хост</span>' : ''}<span class="badge ${p.connected || p.status === 'left' ? sc : 'r'}">${p.connected || p.status === 'left' ? sl : 'офлайн'}</span></td>
          <td>${fmt(p.buyIn)}</td><td>${fmt(p.chips)}</td><td class="${netCls(p.net)}"><b>${signed(p.net)}</b></td>
          ${isHost ? `<td class="act"><button data-adj="${p.id}" title="Добавить/снять фишки">±</button>${p.id !== S.me.id ? ` <button data-host="${p.id}" title="Сделать хостом">♛</button> <button class="danger" data-kick="${p.id}" title="Удалить">✕</button>` : ''}</td>` : ''}</tr>`;
      }).join('')}
      </tbody></table>
      ${totalNet !== 0 ? `<div class="muted" style="font-size:12px">Сумма не равна нулю на ${fmt(Math.abs(totalNet))} — эти фишки сейчас в банках раздач.</div>` : ''}
      <div class="btns"><button id="lgSound">${muted ? 'Включить звук' : 'Выключить звук'}</button><button id="lgCopy">Скопировать итоги</button><button id="lgLeave" class="danger">Выйти из игры</button><button class="primary" id="lgClose">Закрыть</button></div>`);
    $('lgClose').onclick = closeModal;
    $('lgSound').onclick = () => {
      muted = !muted;
      store.set('bp:muted', muted ? '1' : '0');
      $('lgSound').textContent = muted ? 'Включить звук' : 'Выключить звук';
      if (!muted) beep();
    };
    $('lgCopy').onclick = async () => {
      const txt = rows.map((p) => `${p.name}: ${signed(p.net)} (закуп ${p.buyIn}, фишки ${p.chips})`).join('\n');
      try { await navigator.clipboard.writeText(txt); toast('Итоги скопированы'); } catch { toast('Не удалось скопировать'); }
    };
    $('lgLeave').onclick = () => {
      if (confirm('Выйти из игры? Ваш результат останется в итогах, вернуться можно по ссылке.')) { send({ t: 'leave' }); closeModal(); }
    };
    m.querySelectorAll('[data-adj]').forEach((b) => (b.onclick = () => {
      const v = prompt('Сколько фишек добавить игроку (отрицательное число — снять)? Учитывается в закупе.');
      if (v && +v) send({ t: 'adjust', id: b.dataset.adj, amount: +v });
      setTimeout(openLedger, 300);
    }));
    m.querySelectorAll('[data-kick]').forEach((b) => (b.onclick = () => {
      if (confirm('Удалить игрока? Его результат останется в итогах.')) { send({ t: 'kick', id: b.dataset.kick }); setTimeout(openLedger, 300); }
    }));
    m.querySelectorAll('[data-host]').forEach((b) => (b.onclick = () => {
      if (confirm('Передать права хоста?')) { send({ t: 'makeHost', id: b.dataset.host }); closeModal(); }
    }));
  }

  $('btnSettings').onclick = () => {
    const st = S.game.settings;
    const f = (k, label, extra = '') => `<label>${label}<input type="number" id="st_${k}" value="${st[k]}" ${extra}></label>`;
    modal(`<h3>Настройки хоста</h3>
      <div class="form" style="padding:0;border:0;background:none">
        <div class="row2">${f('sb', 'Малый блайнд', 'min=1')}${f('bb', 'Большой блайнд', 'min=1')}</div>
        <div class="row2">${f('buyIn', 'Стартовый закуп', 'min=1')}${f('maxBuyIn', 'Макс. стек при докупке', 'min=1')}</div>
        <div class="row2">${f('actionTime', 'Время на ход, сек', 'min=5 max=300')}${f('minTable', 'Мин. игроков за столом', 'min=2 max=6')}</div>
        ${f('waitSec', 'Сколько секунд ждать полный стол, прежде чем сажать неполный', 'min=0 max=60')}
        <div class="muted" style="font-size:13px">Новые блайнды действуют со следующей раздачи. Если игроков мало, можно уменьшить «Мин. игроков за столом».</div>
      </div>
      <div class="btns"><button id="stPause">${S.game.paused ? 'Продолжить игру' : 'Пауза'}</button><button id="stCancel">Отмена</button><button class="primary" id="stSave">Сохранить</button></div>`);
    $('stCancel').onclick = closeModal;
    $('stPause').onclick = () => { send({ t: 'pause', value: !S.game.paused }); closeModal(); };
    $('stSave').onclick = () => {
      const keys = ['sb', 'bb', 'buyIn', 'maxBuyIn', 'actionTime', 'minTable', 'waitSec'];
      const settings = Object.fromEntries(keys.map((k) => [k, +$('st_' + k).value]));
      send({ t: 'settings', settings });
      closeModal();
    };
  };

  window.addEventListener('resize', () => S && S.table && renderTable(S.table));
  connect();
})();
