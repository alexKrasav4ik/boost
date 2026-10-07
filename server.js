'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Game } = require('./lib/game');
const ws = require('./lib/ws');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const games = new Map();
const sockets = new Map(); // conn -> { game, player }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { reject(e); } });
  });
}

function newGameId() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  let id;
  do { id = Array.from({ length: 6 }, () => abc[crypto.randomInt(abc.length)]).join(''); } while (games.has(id));
  return id;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/ping') return json(res, 200, { ok: true });
    if (p === '/api/games' && req.method === 'POST') {
      const body = await readBody(req);
      const id = newGameId();
      const g = new Game(id, body.settings || {});
      const host = g.addPlayer(body.name, body.buyIn ?? g.settings.buyIn);
      games.set(id, g);
      console.log(`game ${id} created by ${host.name}`);
      return json(res, 200, { id, token: host.token });
    }
    const m = p.match(/^\/api\/games\/([a-z0-9]+)$/);
    if (m) {
      const g = games.get(m[1]);
      if (!g) return json(res, 404, { error: 'Игра не найдена' });
      return json(res, 200, { id: g.id, settings: g.settings, players: [...g.players.values()].filter((q) => q.status !== 'left').map((q) => q.name) });
    }
    if (p === '/' || p === '/index.html') return sendFile(res, path.join(PUB, 'index.html'));
    if (/^\/g\/[a-z0-9]+\/?$/.test(p)) return sendFile(res, path.join(PUB, 'game.html'));
    const f = path.normalize(path.join(PUB, p));
    if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
    return sendFile(res, f);
  } catch (e) {
    return json(res, 400, { error: e.message || 'Ошибка' });
  }
});

// ---------- realtime
const dirty = new Set();
function markDirty(g) { dirty.add(g); }

function flush() {
  const now = Date.now();
  for (const g of dirty) {
    for (const [c, s] of sockets) {
      if (s.game === g && s.player) c.send(JSON.stringify(g.stateFor(s.player, now)));
    }
  }
  dirty.clear();
}

ws.attach(server, '/ws', (c) => {
  sockets.set(c, { game: null, player: null });
  const send = (o) => c.send(JSON.stringify(o));
  c.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const s = sockets.get(c);
    if (!s) return;
    try {
      if (msg.t === 'hello') {
        const g = games.get(msg.gameId);
        if (!g) return send({ t: 'nogame' });
        s.game = g;
        const pl = msg.token ? g.byToken(msg.token) : null;
        if (!pl) return send({ t: 'need_join', settings: g.settings });
        if (pl.kicked) return send({ t: 'kicked' });
        if (s.player !== pl) {
          s.player = pl;
          g.setConnected(pl, +1);
        }
        markDirty(g);
      } else if (msg.t === 'join') {
        const g = s.game;
        if (!g) return send({ t: 'nogame' });
        if (s.player) return;
        const pl = g.addPlayer(msg.name, msg.buyIn);
        g.chatSys(`${pl.name} присоединился (закуп ${pl.buyIn})`);
        s.player = pl;
        g.setConnected(pl, +1);
        send({ t: 'joined', token: pl.token });
        markDirty(g);
      } else if (msg.t === 'ping') {
        send({ t: 'pong', now: Date.now() });
      } else {
        if (!s.player || !s.game) return;
        if (s.player.kicked) return send({ t: 'kicked' });
        s.game.command(s.player, msg);
        markDirty(s.game);
      }
    } catch (e) {
      send({ t: 'error', msg: e.message || 'Ошибка' });
    }
    flush();
  });
  c.on('close', () => {
    const s = sockets.get(c);
    sockets.delete(c);
    if (s && s.game && s.player) {
      s.game.setConnected(s.player, -1);
      markDirty(s.game);
      flush();
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const g of games.values()) {
    try {
      if (g.tick(now)) markDirty(g);
    } catch (e) {
      console.error('tick error', g.id, e);
    }
    // forget games idle for 2 days
    if (now - g.lastActivity > 48 * 3600e3 && ![...g.players.values()].some((q) => q.connected)) games.delete(g.id);
  }
  flush();
}, 200);

server.listen(PORT, () => console.log(`Boost Poker: http://localhost:${PORT}`));
