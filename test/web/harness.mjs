// Test harness: scratch Beam servers, fake devices, a fault-injecting proxy and a fake WebView2 host.
// Everything listens on 127.0.0.1:8821-8829 only and lives in a temp folder that is removed afterwards.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sleep } from './cdp.mjs';

export const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-web-test-'));

export class Scratch {
  constructor(serverJs, port, env = {}) {
    this.serverJs = serverJs;
    this.port = port;
    this.base = `http://127.0.0.1:${port}`;
    this.data = path.join(TMP, `data-${port}-${Date.now()}`);
    this.dist = path.join(TMP, `dist-${port}`);
    this.env = env;
    this.log = '';
  }
  async start() {
    const busy = await fetch(`${this.base}/api/hello`).then(() => true, () => false);
    if (busy) throw new Error(`port ${this.port} is already in use; stop whatever runs there first`);
    fs.mkdirSync(this.data, { recursive: true });
    fs.mkdirSync(this.dist, { recursive: true });
    this.child = spawn(process.execPath, [this.serverJs], {
      cwd: path.dirname(this.serverJs),
      env: { ...process.env, BEAM_HOST: '127.0.0.1', BEAM_PORT: String(this.port), BEAM_DATA: this.data, BEAM_DIST: this.dist, BEAM_PUBLIC_URL: '', BEAM_MOVED_TO: '', ...this.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', d => { this.log += d; });
    this.child.stderr.on('data', d => { this.log += d; });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${this.base}/api/hello`)).ok) break; } catch {}
      await sleep(100);
    }
    this.key = fs.readFileSync(path.join(this.data, 'key'), 'utf8').trim();
    this.hello = await (await fetch(`${this.base}/api/hello`)).json();
    return this;
  }
  async stop() {
    if (!this.child) return;
    this.child.kill();
    await new Promise(r => { this.child.once('exit', r); setTimeout(r, 3000); });
    this.child = null;
  }
  // A fake Beam app/device on its own "machine" (X-Forwarded-For, like tailscale serve adds).
  device(id, name, platform, ip, version) {
    const headers = { Authorization: `Bearer ${this.key}`, 'X-Beam-Device-Id': id, 'X-Beam-Device': encodeURIComponent(name), 'X-Beam-Platform': platform, 'X-Forwarded-For': ip,
      ...(version && { 'X-Beam-App-Version': version }) };
    const base = this.base;
    const j = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
    const dev = {
      id, name, headers,
      me: () => fetch(`${base}/api/me`, { headers }).then(j),
      text: (text, to = []) => fetch(`${base}/api/text`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, to }) }).then(j),
      file: (name2, bytes, to = []) => fetch(`${base}/api/file?name=${encodeURIComponent(name2)}&to=${to.join(',')}`, { method: 'PUT', headers, body: bytes }).then(j),
      forget: other => fetch(`${base}/api/devices/${other}`, { method: 'DELETE', headers }),
      ack: itemId => fetch(`${base}/api/items/${itemId}/ack`, { method: 'POST', headers }).then(j),
      putStatus: status => fetch(`${base}/api/devices/me/status`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(status) }),
      // This device's event stream, collected: { events: [{ event, data }], close() }.
      stream() {
        const ac = new AbortController();
        const events = [];
        fetch(`${base}/api/events?device=${id}&platform=${platform}&name=${encodeURIComponent(name)}`, { headers, signal: ac.signal }).then(async r => {
          const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += value;
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const ev = /^event: (.*)$/m.exec(block)?.[1];
              const data = /^data: (.*)$/m.exec(block)?.[1];
              if (ev) { try { events.push({ event: ev, data: JSON.parse(data || '{}') }); } catch { events.push({ event: ev, data }); } }
            }
          }
        }).catch(() => {});
        return { events, close: () => ac.abort() };
      },
      post: (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(j),
      items: () => fetch(`${base}/api/items`, { headers }).then(j).then(x => x.items),
      get: p => fetch(`${base}${p}`, { headers }).then(j),
      del: p => fetch(`${base}${p}`, { method: 'DELETE', headers }),
      online() {
        const ac = new AbortController();
        fetch(`${base}/api/events?device=${id}&platform=${platform}&name=${encodeURIComponent(name)}`, { headers, signal: ac.signal })
          .then(r => r.body.pipeTo(new WritableStream())).catch(() => {});
        return () => ac.abort();
      },
    };
    return dev;
  }
}

// A TCP proxy in front of a scratch server that can break connections in realistic ways.
export class FaultProxy {
  constructor(port, upstream) {
    this.port = port;
    this.upstream = upstream;
    this.base = `http://127.0.0.1:${port}`;
    this.mode = 'pass';
    this.rules = []; // (info) => action ; info = { dir, text, conn }
    this.stats = { puts: 0, putBytes: 0, r409: 0, conns: 0 };
    this.frozen = [];
    this.socks = new Set();
  }
  async start() {
    this.server = net.createServer(client => this.onConn(client));
    await new Promise(r => this.server.listen(this.port, '127.0.0.1', r));
    return this;
  }
  onConn(client) {
    this.stats.conns++;
    const conn = { client, lastReq: '', frozen: false, afterPut: -1 };
    this.socks.add(client);
    (this.conns ||= new Set()).add(conn);
    client.on('close', () => { this.socks.delete(client); this.conns.delete(conn); });
    if (this.mode === 'refuse') { client.destroy(); return; }
    if (this.mode === '502') { client.once('data', () => client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: 11\r\nConnection: close\r\n\r\nBad Gateway')); client.on('error', () => {}); return; }
    if (this.mode === 'hang') { client.on('error', () => {}); return; }
    const server = net.connect(this.upstream, '127.0.0.1');
    conn.server = server;
    this.socks.add(server);
    server.on('close', () => this.socks.delete(server));
    client.on('data', d => {
      if (conn.frozen) return;
      const s = d.toString('latin1');
      for (const m of s.matchAll(/(GET|PUT|POST|DELETE|PATCH) (\/[^ ]*) HTTP/g)) {
        conn.lastReq = `${m[1]} ${m[2]}`;
        if (m[1] === 'PUT' && m[2].startsWith('/api/uploads/')) { this.stats.puts++; conn.afterPut = 0; }
      }
      if (conn.afterPut >= 0) { conn.afterPut += d.length; this.stats.putBytes += d.length; }
      for (const rule of this.rules) {
        const act = rule({ dir: 'up', text: s, conn, bytes: d.length });
        if (act === 'freeze') { conn.frozen = true; this.frozen.push(server); client.destroy(); return; }
        if (act === 'stall') { conn.frozen = true; this.frozen.push(server, client); return; }
        if (act === 'reset') { client.destroy(); server.destroy(); return; }
        if (typeof act === 'string' && act.startsWith('HTTP/')) { conn.frozen = true; client.end(act); server.destroy(); return; }
      }
      server.write(d);
      // Optional bandwidth limit for uploads (so a test can pause one half-way).
      if (this.bps) { client.pause(); setTimeout(() => client.resume(), (d.length / this.bps) * 1000); }
    });
    server.on('data', d => {
      if (conn.frozen) return;
      const s = d.toString('latin1');
      this.stats.r409 += (s.match(/HTTP\/1\.1 409/g) || []).length;
      for (const rule of this.rules) {
        const act = rule({ dir: 'down', text: s, conn, bytes: d.length });
        if (act === 'drop') { client.destroy(); server.destroy(); return; }
      }
      client.write(d);
    });
    client.on('error', () => {});
    server.on('error', () => {});
    client.on('close', () => { if (!conn.frozen) server.destroy(); });
    server.on('close', () => { if (!conn.frozen) client.destroy(); });
  }
  resetAll() { for (const s of this.socks) s.destroy(); }
  releaseFrozen() { for (const s of this.frozen) s.destroy(); this.frozen = []; }
  async stop() {
    this.releaseFrozen();
    this.resetAll();
    await new Promise(r => this.server.close(r));
  }
}

// A reverse proxy that serves Beam under a path prefix (like nginx `location /beam/ { proxy_pass http://beam/; }`):
// strips the prefix, rewrites Location headers, streams everything (SSE included).
export class PrefixProxy {
  constructor(port, upstream, prefix = '/beam') {
    this.port = port;
    this.upstream = upstream;
    this.prefix = prefix.replace(/\/$/, '');
    this.base = `http://127.0.0.1:${port}${this.prefix}`;
  }
  async start() {
    const http = await import('node:http');
    this.server = http.createServer((req, res) => {
      if (req.url === this.prefix) { res.writeHead(301, { Location: `${this.prefix}/` }); res.end(); return; }
      if (!req.url.startsWith(`${this.prefix}/`)) { res.writeHead(404); res.end('not under the prefix'); return; }
      const up = http.request({ host: '127.0.0.1', port: this.upstream, method: req.method, path: req.url.slice(this.prefix.length), headers: req.headers }, r => {
        const headers = { ...r.headers };
        if (headers.location && headers.location.startsWith('/')) headers.location = this.prefix + headers.location;
        res.writeHead(r.statusCode, headers);
        r.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(up);
      res.on('close', () => up.destroy());
    });
    await new Promise(r => this.server.listen(this.port, '127.0.0.1', r));
    return this;
  }
  async stop() { this.server.closeAllConnections?.(); await new Promise(r => this.server.close(r)); }
}

// A fake WebView2 host: window.beamHost + window.chrome.webview, recording everything the page sends.
// The test drives it with window.__host.emit(event) and reads window.__host.log.
export function fakeHostScript({ deviceId, deviceName = 'Test PC', server, serverId = '', features = ['transfers', 'localFiles', 'settings', 'clipboard', 'pickFiles', 'pickFolder', 'dragOut', 'openPanel'], state = {}, settings = {}, afterHello = [], hostExtra = {} }) {
  const hello = {
    app: 'windows', version: '1.2.0', deviceId, deviceName,
    settings: {
      deviceName, autoCopy: true, clipboardHistory: false, autoSave: true, maxSaveMB: 200, saveFolder: 'C:\\Users\\test\\Downloads\\Beam',
      openLinks: true, sendToMenu: true, outbox: false, outboxFolder: 'C:\\Users\\test\\Beam', autostart: true, autoUpdate: true,
      hotkeys: [{ id: 'picker', keys: 'Ctrl+Alt+B', action: 'Send clipboard to…', registered: true }],
      server: { url: server, version: '1.2.0', api: 3, serverId, storage: { used: 123456789, free: 987654321, total: 2e12 }, connected: true },
      ...settings,
      app: { version: '1.2.0', installed: true, path: 'C:\\Users\\test\\AppData\\Local\\Programs\\Beam\\Beam.exe' },
    },
    update: { state: 'none', current: '1.2.0' }, conn: { state: 'online', text: 'Connected' }, transfers: [], localFiles: {},
    ...state,
  };
  return `(() => {
    const listeners = [];
    const host = window.__host = { log: [], files: [], replies: {}, hello: ${JSON.stringify(hello)} };
    const deliver = m => setTimeout(() => listeners.forEach(fn => fn({ data: m })), 0);
    host.emit = m => deliver(m);
    host.reply = (type, fn) => { host.replies[type] = fn; };
    const handle = (m, files) => {
      host.log.push(m);
      if (files) host.files.push({ type: m.type, names: [...files].map(f => f.name) });
      if (m.id === undefined) return;
      let r = { ok: true, result: {} };
      if (m.type === 'hello') r.result = host.hello;
      else if (m.type === 'getSettings') r.result = { settings: host.hello.settings };
      else if (m.type === 'setSettings') { Object.assign(host.hello.settings, m.settings); r.result = { settings: host.hello.settings }; }
      else if (m.type === 'sendFiles') r.result = { count: files ? files.length : 0 };
      else if (m.type === 'pickFiles' || m.type === 'pickFolder') r.result = { count: 2 };
      else if (m.type === 'sendClipboard') r.result = { kind: 'image', description: 'a screenshot' };
      if (host.replies[m.type]) r = host.replies[m.type](m) || r;
      deliver({ type: 'reply', id: m.id, ...r });
      if (m.type === 'hello') ${JSON.stringify(afterHello)}.forEach(e => deliver(e)); // events queued before the handshake
    };
    window.chrome = window.chrome || {};
    window.chrome.webview = {
      postMessage: m => handle(JSON.parse(JSON.stringify(m))),
      postMessageWithAdditionalObjects: (m, files) => handle(JSON.parse(JSON.stringify(m)), files),
      addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
      removeEventListener: () => {},
    };
    window.beamHost = { bridge: 1, app: 'windows', version: '1.2.0', deviceId: ${JSON.stringify(deviceId)}, deviceName: ${JSON.stringify(deviceName)},
      platform: 'windows', server: ${JSON.stringify(server)}, features: ${JSON.stringify(features)}, debug: false, ...${JSON.stringify(hostExtra)} };
  })();`;
}

// Tiny test framework.
export const results = [];
export function assert(cond, message) { if (!cond) throw new Error(`assertion failed: ${message}`); }
export function eq(a, b, message) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${message}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// Minimal ZIP reader for checking the folder zips the page makes (stored entries, CRC-32 verified).
export function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no end of central directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central header');
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtra = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lNameLen + lExtra, local + 30 + lNameLen + lExtra + size);
    entries.push({ name, size, crc, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
