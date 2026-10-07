'use strict';
// Tiny dependency-free WebSocket server (RFC 6455, text frames only).
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MSG = 64 * 1024;

class Conn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.open = true;
    this.lastSeen = Date.now();
    socket.setNoDelay(true);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
  }

  _closed() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }

  _onData(d) {
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MSG)) return this.destroy();
        len = Number(big);
        off = 10;
      }
      if (len > MAX_MSG) return this.destroy();
      if (!masked) return this.destroy(); // clients must mask
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      off += 4;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + len);

      if (op === 0x8) {
        this._send(0x8, Buffer.alloc(0));
        this.socket.end();
        return this._closed();
      }
      if (op === 0x9) { this._send(0xa, payload); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.frags.push(payload);
        const total = this.frags.reduce((a, b) => a + b.length, 0);
        if (total > MAX_MSG) return this.destroy();
        if (fin) {
          const msg = Buffer.concat(this.frags).toString('utf8');
          this.frags = [];
          this.emit('message', msg);
        }
      }
    }
  }

  _send(op, data) {
    if (!this.open || this.socket.destroyed) return;
    const len = data.length;
    let head;
    if (len < 126) {
      head = Buffer.from([0x80 | op, len]);
    } else if (len < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([head, data]));
  }

  send(str) { this._send(0x1, Buffer.from(str, 'utf8')); }
  ping() { this._send(0x9, Buffer.alloc(0)); }
  destroy() { this.socket.destroy(); this._closed(); }
}

function attach(server, path, onConn) {
  const conns = new Set();
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== path || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const c = new Conn(socket);
    conns.add(c);
    c.on('close', () => conns.delete(c));
    onConn(c, req);
  });
  // heartbeat: keeps proxies from closing idle sockets and drops dead clients
  setInterval(() => {
    const now = Date.now();
    for (const c of conns) {
      if (now - c.lastSeen > 70000) c.destroy();
      else c.ping();
    }
  }, 25000).unref();
  return conns;
}

module.exports = { attach };
