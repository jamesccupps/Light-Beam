#!/usr/bin/env node
// Beam for Windows: regression checks for the 1.4.0 review findings (save while arriving, revoke, receipts, stream
// checks, foreign 401s, leftover partial files, a paused sender) and the re-review's R1/R2 (a sender pausing right
// after full reads; Retry on a failed early download), 1.6.2's Copy image and 1.7.1's notification clicks. Exits 1 if
// any check fails.
//
//   node test/perf/windows-regress.mjs [all|reconnect|restart|revoke|ack|doublepoke|nonbeam401|cancel-after-restart|cancel-live|lane
//        |pause-full|blip-mid-chunk|retry-early|lost-finish|copy-image|copy-files|notify-open|outbox-restart|names|checksums|collect|beamcmd] [--exe <Beam.exe>]
//
// Isolated like the other windows-* checks: a scratch server (this checkout's server.js) on 127.0.0.1:8805, the app
// reaching it through a small TCP proxy on 8855 (so its connections can be dropped), a fake peer, and a copy of Beam.exe
// run with --config in a temp folder (quiet, off-screen, no Run key, hotkeys or real clipboard). Nothing is clicked or
// typed.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = 8805, PROXY = 8855;
const MB = 1 << 20;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const args = process.argv.slice(2);
const exeArg = args.indexOf('--exe');
const EXE = exeArg >= 0 ? args[exeArg + 1] : [path.join(ROOT, 'windows', 'bin', 'Beam.exe'), path.join(ROOT, 'dist', 'Beam.exe')].find(f => fs.existsSync(f));
const wanted = args.filter((a, i) => !a.startsWith('--') && (exeArg < 0 || i !== exeArg + 1));
const TMP = path.join(os.tmpdir(), `beam-regress-win-${Date.now()}`);
const failures = [];

class Run {
  constructor(name) {
    this.name = name;
    this.dir = path.join(TMP, name);
    for (const d of ['data', 'dist', 'cfg', 'app', 'down', 'files']) fs.mkdirSync(path.join(this.dir, d), { recursive: true });
    this.base = `http://127.0.0.1:${PORT}`;
    this.appUrl = `http://127.0.0.1:${PROXY}`;
    this.cfgPath = path.join(this.dir, 'cfg', 'config.json');
    this.logPath = path.join(this.dir, 'cfg', 'beam.log');
    this.appExe = path.join(this.dir, 'app', 'Beam.exe');
    fs.copyFileSync(EXE, this.appExe);
    this.appId = 'regresspc' + crypto.randomBytes(8).toString('hex');
    this.peerId = 'regresspeer' + crypto.randomBytes(8).toString('hex');
    this.sockets = new Set();
  }

  check(ok, what) {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${this.name}: ${what}`);
    if (!ok) failures.push(`${this.name}: ${what}`);
  }

  async startServer() {
    const out = fs.openSync(path.join(this.dir, 'server.out.log'), 'a');
    this.server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out],
      env: { ...process.env, BEAM_TAILSCALE: 'off', BEAM_HOST: '127.0.0.1', BEAM_PORT: String(PORT),
        BEAM_DATA: path.join(this.dir, 'data'), BEAM_DIST: path.join(this.dir, 'dist') },
    });
    for (let i = 0; i < 150; i++) {
      try { const r = await fetch(this.base + '/api/hello'); if (r.ok) break; } catch {}
      await sleep(200);
    }
    this.key = fs.readFileSync(path.join(this.dir, 'data', 'key'), 'utf8').trim();
  }

  killServer() { try { this.server.kill(); } catch {} }

  // A TCP proxy for the app only: its connections can be dropped (a network blip); optional one-way latency.
  startProxy(latency = 0) {
    const pipe = (src, dst) => {
      if (!latency) { src.pipe(dst); return; }
      let chain = Promise.resolve();
      src.on('data', chunk => {
        const due = Date.now() + latency;
        chain = chain.then(async () => { const w = due - Date.now(); if (w > 0) await sleep(w); if (!dst.destroyed) dst.write(chunk); });
      });
      src.on('end', () => { chain = chain.then(() => { if (!dst.destroyed) dst.end(); }); });
    };
    // (1.23) `upRate` (bytes a second): what the app sends is paced, so a test can stop it half way through an upload
    const paced = (src, dst) => {
      src.on('data', chunk => {
        if (!dst.destroyed) dst.write(chunk);
        if (this.upRate) { src.pause(); setTimeout(() => src.resume(), (1000 * chunk.length) / this.upRate); }
      });
      src.on('end', () => { if (!dst.destroyed) dst.end(); });
    };
    // (1.31) While this[flag] is set: one byte of the first body after a header that has `marker` is flipped (then the
    // flag goes and this[done] is set). `flipUp`: a PUT to /api/uploads; `flipDown`: a file's answer (Repr-Digest).
    const flipOnce = (src, dst, marker, flag, done) => {
      let state = 0;
      src.on('data', chunk => {
        if (this[flag]) {
          let at = -1;
          if (state === 0) {
            const m = chunk.indexOf(marker);
            if (m >= 0) { state = 1; const e = chunk.indexOf('\r\n\r\n', m); if (e >= 0) { state = 2; at = e + 4; } }
          } else if (state === 1) {
            const e = chunk.indexOf('\r\n\r\n');
            if (e >= 0) { state = 2; at = e + 4; }
          } else at = 0;
          if (state === 2 && at >= 0 && at < chunk.length) {
            chunk = Buffer.from(chunk);
            chunk[at] ^= 0xff;
            this[flag] = false;
            this[done] = true;
            state = 0;
          }
        }
        if (!dst.destroyed) dst.write(chunk);
      });
      src.on('end', () => { if (!dst.destroyed) dst.end(); });
    };
    this.proxy = net.createServer(c => {
      const s = net.connect(PORT, '127.0.0.1');
      this.sockets.add(c); this.sockets.add(s);
      if (this.flipUp !== undefined) flipOnce(c, s, 'PUT /api/uploads/', 'flipUp', 'flippedUp');
      else if (this.upRate !== undefined && !latency) paced(c, s); else pipe(c, s);
      if (this.flipDown !== undefined) flipOnce(s, c, 'Repr-Digest:', 'flipDown', 'flippedDown');
      else if (this.dropFinish) {
        // The server's answer that finishes an upload never arrives: the connection drops instead (once).
        s.on('data', chunk => {
          if (this.dropFinish && chunk.includes('"done":true')) { this.dropFinish = false; this.dropped = true; c.destroy(); s.destroy(); return; }
          if (!c.destroyed) c.write(chunk);
        });
        s.on('end', () => { if (!c.destroyed) c.end(); });
      } else pipe(s, c);
      const done = () => { c.destroy(); s.destroy(); this.sockets.delete(c); this.sockets.delete(s); };
      c.on('error', done); s.on('error', done); c.on('close', done); s.on('close', done);
    });
    return new Promise(r => this.proxy.listen(PROXY, '127.0.0.1', r));
  }

  dropConnections() { for (const s of [...this.sockets]) s.destroy(); }

  peerHeaders(extra = {}) {
    return { Authorization: `Bearer ${this.key}`, 'X-Beam-Device-Id': this.peerId, 'X-Beam-Device': 'Regress Phone',
      'X-Beam-Platform': 'android', 'X-Forwarded-For': '100.64.0.2', ...extra };
  }

  async api(method, p, body) {
    const res = await fetch(this.base + p, { method, headers: this.peerHeaders(body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }

  async upload(id, data, from, to, piece = 4 * MB) {
    let off = from;
    while (off < to) {
      const n = Math.min(piece, to - off);
      const res = await fetch(`${this.base}/api/uploads/${id}?offset=${off}`, { method: 'PUT', headers: this.peerHeaders({ 'Content-Type': 'application/octet-stream' }), body: data.subarray(off, off + n) });
      const d = await res.json().catch(() => ({}));
      if (res.status === 201) return;
      if (res.status !== 200) throw new Error(`PUT at ${off}: ${res.status} ${JSON.stringify(d)}`);
      off = d.offset;
    }
  }

  // One PUT sent at a steady pace (bytes a second): the upload's `offset` moves only when it ends.
  slowPut(id, data, from, to, perSecond) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${this.base}/api/uploads/${id}?offset=${from}`, { method: 'PUT', agent: false,
        headers: this.peerHeaders({ 'Content-Type': 'application/octet-stream', 'Content-Length': to - from }) },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      let off = from;
      const next = () => {
        if (off >= to) return req.end();
        const n = Math.min(256 * 1024, to - off);
        req.write(data.subarray(off, off + n));
        off += n;
        setTimeout(next, (1000 * n) / perSecond);
      };
      next();
    });
  }

  async startBig(size, first) {
    const data = crypto.randomBytes(size);
    const c = await this.api('POST', '/api/uploads', { name: 'big.bin', size, mime: 'application/octet-stream', to: [this.appId] });
    if (c.status !== 201) throw new Error('create: ' + JSON.stringify(c));
    if (first) await this.upload(c.data.id, data, 0, first);
    return { id: c.data.id, data };
  }

  async finishRest(id, data) {
    const st = await this.api('GET', '/api/uploads/' + id);
    await this.upload(id, data, st.data.offset, data.length);
  }

  writeConfig(extra = {}) {
    const c = { server: this.appUrl, key: this.key, deviceId: this.appId, deviceName: 'Regress PC', quiet: true, testOffscreen: true,
      autoUpdate: false, autostartInitialized: true, sendToMenu: false, autoSave: true, saveFolder: path.join(this.dir, 'down'), ...extra };
    fs.writeFileSync(this.cfgPath, JSON.stringify(c, null, 2));
  }

  readConfig() { return JSON.parse(fs.readFileSync(this.cfgPath, 'utf8')); }
  appEnv() { return { ...process.env, BEAM_LOCAL_URLS: this.appUrl, BEAM_TEST_PEERS: this.appUrl }; }

  startApp() {
    this.app = spawn(this.appExe, ['--config', this.cfgPath, '--background'], { env: this.appEnv(), windowsHide: true, stdio: 'ignore' });
    this.appExit = undefined;
    this.app.on('exit', code => { this.appExit = code; });
  }

  forward(a) { return spawnSync(this.appExe, ['--config', this.cfgPath, ...a], { env: this.appEnv(), windowsHide: true, timeout: 20000 }); }
  forwardAsync(a) { return new Promise(res => { const p = spawn(this.appExe, ['--config', this.cfgPath, ...a], { env: this.appEnv(), windowsHide: true, stdio: 'ignore' }); p.on('exit', res); }); }

  async quitApp() {
    if (!this.app || this.appExit !== undefined) return;
    this.forward(['--quit']);
    for (let i = 0; i < 60 && this.appExit === undefined; i++) await sleep(250);
    if (this.appExit === undefined) { try { this.app.kill(); } catch {} }
    await sleep(500);
  }

  // The log's lines, without the empty string after the last newline (so `logLines().length` is where new lines start).
  logLines() { try { return fs.readFileSync(this.logPath, 'utf8').split(/\r?\n/).filter((l, i, a) => i < a.length - 1 || l !== ''); } catch { return []; } }
  count(re, from = 0) { return this.logLines().slice(from).filter(l => re.test(l)).length; }

  async waitLog(re, from = 0, ms = 30000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const lines = this.logLines();
      for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return lines[i];
      await sleep(200);
    }
    return null;
  }

  async waitFor(fn, ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await fn()) return true; await sleep(250); }
    return false;
  }

  downFiles() { try { return fs.readdirSync(path.join(this.dir, 'down')); } catch { return []; } }
  partSize() { const p = this.downFiles().find(n => n.endsWith('.beampart')); return p ? fs.statSync(path.join(this.dir, 'down', p)).size : -1; }
  handled() { try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'cfg', 'handled.json'), 'utf8')); } catch { return null; } }
  async item(id) { return ((await this.api('GET', '/api/items')).data.items || []).find(i => i.id === id); }
  async delivered(id) { const it = await this.item(id); return !!(it && it.delivered && it.delivered[this.appId]); }

  saved(data, name = 'big.bin') {
    const f = path.join(this.dir, 'down', name);
    return fs.existsSync(f) && sha(fs.readFileSync(f)) === sha(data);
  }

  async setup(cfgExtra = {}, latency = 0) {
    await this.startServer();
    await this.startProxy(latency);
    await this.api('GET', '/api/devices'); // registers the fake peer
    this.writeConfig(cfgExtra);
    this.startApp();
    if (!(await this.waitLog(/Perf: connected/, 0, 30000))) throw new Error('the app never connected');
    if (!(await this.waitLog(/First sync/, 0, 30000))) throw new Error('no first sync');
    await sleep(1000);
  }

  async reconnect() {
    const from = this.logLines().length;
    this.dropConnections();
    return !!(await this.waitLog(/Events: connected/, from, 20000));
  }

  async cleanup() {
    try { await this.quitApp(); } catch {}
    try { this.proxy && this.proxy.close(); this.dropConnections(); } catch {}
    this.killServer();
    const dirWin = this.dir.replace(/\//g, '\\').replace(/'/g, "''");
    spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe' or Name='Beam.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dirWin}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { windowsHide: true });
    await sleep(500);
  }
}

// Finding 1 (critical): a catch-up (here a dropped connection) while a big file is being saved as it arrives.
async function reconnect(r) {
  await r.setup();
  const { id, data } = await r.startBig(48 * MB, 16 * MB);
  r.check(!!(await r.waitLog(new RegExp(`Saving ${id} while`), 0, 15000)), 'saving starts while the file arrives');
  // The server's live reader may hold back the last few hundred KB until more arrives: most of it is enough.
  await r.waitFor(() => r.partSize() >= 15 * MB, 30000);
  const had = r.partSize();
  r.check(await r.reconnect(), 'the stream reconnects after a dropped connection');
  await sleep(3000);
  r.check(had > 0 && r.partSize() >= had, 'the partial file survives the catch-up');
  r.check(!(r.handled()?.ids || []).includes(id), 'the file isn\'t marked handled before it\'s saved');
  await r.finishRest(id, data);
  r.check(await r.waitFor(() => r.saved(data), 30000), 'the file is saved complete when the sender finishes');
  r.check(await r.waitFor(() => r.delivered(id), 15000), 'and reported delivered');
}

// Finding 1 (critical): the same across a server restart.
async function restart(r) {
  await r.setup();
  const { id, data } = await r.startBig(48 * MB, 16 * MB);
  r.check(!!(await r.waitLog(new RegExp(`Saving ${id} while`), 0, 15000)), 'saving starts while the file arrives');
  await r.waitFor(() => r.partSize() >= 15 * MB, 30000);
  const from = r.logLines().length;
  r.killServer();
  await sleep(1500);
  await r.startServer();
  r.check(!!(await r.waitLog(/Events: connected/, from, 45000)), 'the stream reconnects after the server restart');
  await sleep(3000);
  r.check(!(r.handled()?.ids || []).includes(id), 'the file isn\'t marked handled before it\'s saved');
  await r.finishRest(id, data);
  r.check(await r.waitFor(() => r.saved(data), 30000), 'the file is saved complete when the sender finishes');
  r.check(await r.waitFor(() => r.delivered(id), 15000), 'and reported delivered');
}

// Finding 2 (high): a revoke while a file is being saved must not replay the history after signing in again.
async function revoke(r) {
  await r.setup({ sendToMenu: true });
  r.check(await r.reconnect(), 'reconnected (the stream now runs on the device token)');
  await sleep(2000);
  await r.api('POST', '/api/text', { text: 'old text one', to: [] });
  await r.api('POST', '/api/text', { text: 'old text two', to: [] });
  const small = crypto.randomBytes(MB);
  const cs = await r.api('POST', '/api/uploads', { name: 'old-small.bin', size: small.length, mime: 'application/octet-stream', to: [] });
  await r.upload(cs.data.id, small, 0, small.length);
  await r.waitLog(/Saved down:/, 0, 20000);
  await sleep(2000);
  const { id } = await r.startBig(48 * MB, 8 * MB);
  r.check(!!(await r.waitLog(new RegExp(`Saving ${id} while`), 0, 15000)), 'a file is being saved while it arrives');
  await r.waitFor(() => r.partSize() >= 4 * MB, 20000);
  const from = r.logLines().length;
  await r.api('DELETE', '/api/devices/' + r.appId);
  r.check(!!(await r.waitLog(/Sign-in revoked/, from, 30000)), 'the revocation is noticed');
  await sleep(4000);
  const h = r.handled();
  r.check(h && h.initialized === false, 'the local state is reset (not re-initialized by a late callback)');
  r.check(!r.readConfig().key && !r.readConfig().keyProtected, 'the token is gone');
  await r.quitApp();
  // Sign in again: the key back, the app started again (the in-app "Sign in again" keeps the state the same way).
  r.writeConfig({ sendToMenu: true });
  const from2 = r.logLines().length;
  r.startApp();
  await r.waitLog(/Perf: connected/, from2, 30000);
  await sleep(8000);
  r.check(r.count(/First sync/, from2) === 1, 'signing in again starts with a first sync');
  r.check(r.count(/Received text/, from2) === 0, 'no old text is received again');
  r.check(r.count(/Saved down:/, from2) === 0, 'no old file is saved again');
}

// Finding 3: the receipt of a file saved while it arrived reaches the sender without waiting for a catch-up.
async function ack(r) {
  await r.setup();
  const { id, data } = await r.startBig(64 * MB, 0);
  r.check(!!(await r.waitLog(new RegExp(`Saving ${id} while`), 0, 15000)), 'saving starts while the file arrives');
  await r.upload(id, data, 0, data.length, 8 * MB);
  r.check(await r.waitFor(() => r.saved(data), 30000), 'the file is saved');
  r.check(await r.waitFor(() => r.delivered(id), 10000), 'delivered within 10 s, no reconnect needed');
}

// Finding 4: two stream checks close together (e.g. waking up + a network change) mustn't reconnect.
async function doublepoke(r) {
  await r.setup({}, 250);
  const before = r.count(/Events: connected/);
  const from = r.logLines().length;
  const p1 = r.forwardAsync(['--test-poke']);
  await sleep(150);
  await Promise.all([p1, r.forwardAsync(['--test-poke'])]);
  await sleep(12000);
  r.check(r.count(/no answer on the stream/, from) === 0, 'both checks get their answer');
  r.check(r.count(/Events: connected/) === before, 'no reconnect');
}

// Finding 7: a 401 from something that isn't this Beam (another app took over the address) must not wipe anything.
async function nonbeam401(r) {
  const fake = http.createServer((req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"message":"401: Unauthorized"}'); });
  await new Promise(ok => fake.listen(PROXY, '127.0.0.1', ok));
  try {
    const serverId = '0123456789abcdef0123456789abcdef';
    r.key = 'bt_regressfaketoken000000000000000000000000';
    r.writeConfig({ serverId });
    fs.writeFileSync(path.join(r.dir, 'cfg', 'handled.json'), JSON.stringify({ initialized: true, baselineTs: 1, serverId, ids: ['aaaaaaaaaaaaaaaa'] }));
    fs.writeFileSync(path.join(r.dir, 'cfg', 'state.json'), JSON.stringify({ lastRead: {}, files: { aaaaaaaaaaaaaaaa: path.join(r.dir, 'down', 'x.bin') }, sendTo: {}, uploads: [], downloads: [] }));
    r.startApp();
    r.check(!!(await r.waitLog(/didn't say it is this Beam|Sign-in revoked/, 0, 30000)), 'the 401 is noticed');
    await sleep(2000);
    const st = JSON.parse(fs.readFileSync(path.join(r.dir, 'cfg', 'state.json'), 'utf8'));
    r.check(!!(r.readConfig().keyProtected || r.readConfig().key), 'the token is kept');
    r.check(Object.keys(st.files || {}).length === 1, 'the saved-file map is kept');
    r.check((r.handled()?.ids || []).includes('aaaaaaaaaaaaaaaa'), 'the handled items are kept');
  } finally {
    await r.quitApp();
    fake.close();
  }
}

// Finding 6: the sender cancels while Beam is off: the partial file mustn't be left behind.
async function cancelAfterRestart(r) {
  await r.setup();
  const { id } = await r.startBig(48 * MB, 16 * MB);
  r.check(!!(await r.waitLog(new RegExp(`Saving ${id} while`), 0, 15000)), 'saving starts while the file arrives');
  await r.waitFor(() => r.partSize() >= 15 * MB, 30000);
  await r.quitApp();
  await fetch(`${r.base}/api/uploads/${id}`, { method: 'DELETE', headers: r.peerHeaders() });
  const from = r.logLines().length;
  r.startApp();
  await r.waitLog(/Perf: connected/, from, 30000);
  r.check(await r.waitFor(() => !r.downFiles().some(n => n.endsWith('.beampart')), 20000), 'the partial file is removed after the restart');
}

// Findings 6 and 9: the sender cancels while the file is being saved (Beam running): the partial file goes, nothing
// is marked handled or reported.
async function cancelLive(r) {
  await r.setup();
  const { id } = await r.startBig(48 * MB, 16 * MB);
  r.check(!!(await r.waitLog(new RegExp(`Saving ${id} while`), 0, 15000)), 'saving starts while the file arrives');
  await r.waitFor(() => r.partSize() >= 15 * MB, 30000);
  await fetch(`${r.base}/api/uploads/${id}`, { method: 'DELETE', headers: r.peerHeaders() });
  r.check(await r.waitFor(() => !r.downFiles().some(n => n.endsWith('.beampart')), 30000), 'the partial file is removed');
  r.check(r.count(/Couldn't save/) === 0, 'no "Couldn\'t save" notification');
  r.check(!(r.handled()?.ids || []).includes(id), 'nothing marked handled');
}

// Finding 5: a sender that pauses mid-file mustn't hold up other files, nor end in "Couldn't save".
async function lane(r) {
  await r.setup();
  const a = await r.startBig(48 * MB, 8 * MB);
  r.check(!!(await r.waitLog(new RegExp(`Saving ${a.id} while`), 0, 15000)), 'saving A starts while it arrives');
  await r.waitFor(() => r.partSize() >= 7 * MB, 20000);
  const b = crypto.randomBytes(20 * MB);
  const cb = await r.api('POST', '/api/uploads', { name: 'b.bin', size: b.length, mime: 'application/octet-stream', to: [r.appId] });
  await r.upload(cb.data.id, b, 0, b.length, 8 * MB);
  r.check(await r.waitFor(() => r.saved(b, 'b.bin'), 45000), 'a finished file B is saved while A waits for its sender');
  await sleep(70000); // past the server's 60 s cut-off for A
  r.check(r.count(/Couldn't save|download failed/) === 0, 'A waits for its sender without failing');
  await r.finishRest(a.id, a.data);
  r.check(await r.waitFor(() => r.saved(a.data), 60000), 'A is saved once its sender goes on');
}

// Re-review R1: the sender pauses right after the receiver's reads came back full (it holds 8 MB - 128 KB, the upload
// stands at 8 MB + 64 KB: three full 64 KB reads, then one that waits). Every byte that came must reach the partial
// file, and the download must wait for the sender (not retry until "Couldn't save"); then it finishes.
async function pauseFull(r) {
  await r.setup();
  const { id, data } = await r.startBig(40 * MB, 0);
  r.check(!!(await r.waitLog(new RegExp(`Saving ${id} while`), 0, 15000)), 'saving starts while the file arrives');
  await r.quitApp();
  const part = path.join(r.dir, 'down', `big.bin.${id}.beampart`);
  fs.writeFileSync(part, data.subarray(0, 8 * MB - 128 * 1024));
  await r.upload(id, data, 0, 8 * MB);
  const from = r.logLines().length;
  r.startApp();
  await r.waitLog(/Perf: connected/, from, 30000);
  await sleep(3000);
  const paused = 8 * MB + 64 * 1024;
  await r.upload(id, data, 8 * MB, paused);
  await r.api('POST', '/api/text', { text: 'wake up', to: [r.appId] }); // an urgent event brings the held upload event
  const size = () => (fs.existsSync(part) ? fs.statSync(part).size : -1);
  r.check(await r.waitFor(() => size() === paused, 20000), `every byte that came is written (partial ${size()} of ${paused})`);
  r.check(!!(await r.waitLog(new RegExp(`down:${id}: waiting for the sender`), from, 100000)), 'it waits for the sender (parked)');
  const lines = () => r.logLines().slice(from).filter(l => l.includes(id));
  r.check(!lines().some(l => /Connection problem| failed: /.test(l)), 'no retries counted as failures');
  r.check(lines().filter(l => /resuming at byte (\d+)/.test(l) && !l.includes(`resuming at byte ${paused}`)).length <= 1, 'no repeated resumes from the same lower offset');
  await r.finishRest(id, data);
  r.check(await r.waitFor(() => r.saved(data), 30000), 'the file is saved complete when the sender goes on');
  r.check(await r.waitFor(() => r.delivered(id), 15000), 'and reported delivered');
  r.check(r.count(/Couldn't save/, from) === 0, `no "Couldn't save"`);
}

// 1.15.1 ("the rest" #2): a blip in the middle of the sender's chunk while the file is saved as it arrives. The app
// goes on at once: the upload's `received` is past what it has (its `offset` stays at the chunk's start, so the app
// used to wait 15 s for a sender that was still sending).
async function blipMidChunk(r) {
  await r.setup();
  const { id, data } = await r.startBig(64 * MB, 0);
  const sending = r.slowPut(id, data, 0, 48 * MB, 4 * MB); // one chunk of 12 s
  r.check(!!(await r.waitLog(new RegExp(`Saving ${id} while`), 0, 15000)), 'saving starts while the file arrives');
  await r.waitFor(() => r.partSize() >= 8 * MB, 30000);
  const from = r.logLines().length;
  const had = r.partSize();
  r.dropConnections(); // the app's only: the sender goes straight to the server
  r.check(await r.waitFor(() => r.partSize() >= had + 4 * MB, 6000), `it goes on within seconds (had ${had}, now ${r.partSize()})`);
  // (Windows 1.27.1) caught up just as the connection dropped, it may wait once, and is woken when its stream is back
  r.check(r.count(new RegExp(`down:${id}: waiting for the sender`), from) <= 1, 'without waiting out a pause for the sender');
  r.check((await sending) === 200, 'the chunk arrived whole');
  await r.finishRest(id, data);
  r.check(await r.waitFor(() => r.saved(data), 30000), 'the file is saved complete when the sender finishes');
  r.check(await r.waitFor(() => r.delivered(id), 15000), 'and reported delivered');
}

// Re-review R2: Retry on a failed early download, then a catch-up before the sender finishes. The retry must keep
// trailing its sender: a catch-up must not take it for a deleted item (cancel, mark handled, acknowledge unsaved).
// The first try fails for a local reason (its partial file's path is taken by a folder), as "Couldn't save" would.
async function retryEarly(r) {
  await r.setup();
  await r.quitApp();
  const { id, data } = await r.startBig(48 * MB, 0);
  const blocker = path.join(r.dir, 'down', `big.bin.${id}.beampart`);
  fs.mkdirSync(blocker);
  const from = r.logLines().length;
  r.startApp();
  await r.waitLog(/Perf: connected/, from, 30000);
  await sleep(2000);
  await r.upload(id, data, 0, 8 * MB);
  await r.api('POST', '/api/text', { text: 'wake up', to: [r.appId] }); // an urgent event brings the held upload event
  r.check(!!(await r.waitLog(new RegExp(`down:${id} failed: Can't write`), from, 20000)), `the early download fails ("Couldn't save")`);
  fs.rmdirSync(blocker);
  r.forward(['--test-transfer', `retry:down:${id}`]);
  r.check(await r.waitFor(() => r.partSize() >= 4 * MB, 20000), 'Retry starts saving it again');
  r.check(await r.reconnect(), 'a catch-up (the stream reconnects) while the sender is still sending');
  await sleep(4000);
  r.check(r.partSize() > 0, 'the retried download survives the catch-up (partial kept)');
  await r.finishRest(id, data);
  r.check(await r.waitFor(() => r.saved(data), 45000), 'the file is saved complete when the sender finishes');
  r.check(await r.waitFor(() => r.delivered(id), 15000), 'and reported delivered');
}

// The lead's 1.5 perf run timed out waiting for "Upload … finished as item": an upload whose finishing answer is lost
// (a dropped connection) is found finished by its retry; it must say so in the log like any other.
async function lostFinish(r) {
  r.dropFinish = true;
  await r.setup();
  const file = path.join(r.dir, 'files', 'lost.bin');
  fs.writeFileSync(file, crypto.randomBytes(32 * MB));
  const from = r.logLines().length;
  r.forward(['--send', '--to', r.peerId, file]);
  const done = await r.waitLog(/Upload up:\S+ finished as item \S+/, from, 30000);
  r.check(r.dropped === true, 'the server\'s answer that finished the upload was dropped');
  r.check(!!done, 'the upload still ends as finished and logs "finished as item"');
  const items = ((await r.api('GET', '/api/items')).data.items || []).filter(i => i.name === 'lost.bin');
  r.check(items.length === 1 && !!done && done.includes(items[0].id), 'one item on the server, the one logged');
}

// (1.27.2, the 2026-11-21 audit) Notes from Windows: Explorer's Send to > Beam > Notes runs `--send --to <this PC's id>`,
// and `--to notes` is this PC too. The file goes up as a note (a message to this PC itself), and the app doesn't save
// its own note as a download.
async function notes(r) {
  await r.setup();
  const sendOne = async (name, to) => {
    const file = path.join(r.dir, 'files', name);
    fs.writeFileSync(file, `keep ${name} for later`);
    const from = r.logLines().length;
    r.forward(['--send', '--to', to, file]);
    const done = await r.waitLog(/Upload up:\S+ finished as item \S+/, from, 30000);
    const items = ((await r.api('GET', '/api/items')).data.items || []).filter(i => i.name === name);
    r.check(!!done && items.length === 1 && items[0].note === true && items[0].from === r.appId && JSON.stringify(items[0].to) === JSON.stringify([r.appId]),
      `--to ${to === r.appId ? '<its own id>' : to}: one note, from this PC to itself (${JSON.stringify(items.map(i => ({ from: i.from, to: i.to, note: i.note })))})`);
  };
  await sendOne('for-later.txt', 'notes');
  await sendOne('for-later-2.txt', r.appId);
  await sleep(3000);
  r.check(!fs.readdirSync(path.join(r.dir, 'down')).some(f => f.startsWith('for-later')), 'its own notes are not saved as downloads');
}

// (1.31, Beam 1.40; the 2026-11-21 audit's F1) SHA-256s. Sending: the last PUT carries the file's own; a byte damaged
// on the way (the proxy flips one) → the server refuses it (422) → sent once more → one item with the file's SHA-256.
// Saving: damaged on the way once → the part goes, once more, saved "SHA-256 checked"; the server's own copy damaged
// (its disk) → twice, then failed, nothing left; a big file saved while it arrives → checked against its item.
async function checksums(r) {
  r.flipUp = false;
  r.flipDown = false;
  await r.setup();
  const file = path.join(r.dir, 'files', 'sum.bin');
  const data = crypto.randomBytes(3 * MB);
  fs.writeFileSync(file, data);
  r.flipUp = true;
  let from = r.logLines().length;
  r.forward(['--send', '--to', r.peerId, file]);
  const done = await r.waitLog(/Upload up:\S+ finished as item \S+/, from, 30000);
  r.check(r.flippedUp === true, 'a byte of the PUT was damaged on the way');
  r.check(r.count(/arrived damaged at the server \(its SHA-256 isn't this file's\), sending it again/, from) === 1, 'the server refused it, and the app sent it again');
  const sent = ((await r.api('GET', '/api/items')).data.items || []).filter(i => i.name === 'sum.bin');
  const full = sent.length === 1 ? (await r.api('GET', `/api/items/${sent[0].id}`)).data : null;
  r.check(!!done && full?.sha256 === sha(data), `one item, with the file's SHA-256 (${sent.length})`);

  const small = crypto.randomBytes(2 * MB);
  r.flipDown = true;
  from = r.logLines().length;
  const c1 = await r.api('POST', '/api/uploads', { name: 'down1.bin', size: small.length, mime: 'application/octet-stream', to: [r.appId] });
  await r.upload(c1.data.id, small, 0, small.length);
  r.check(await r.waitFor(() => r.saved(small, 'down1.bin'), 30000), 'saved whole after one try damaged on the way');
  r.check(r.flippedDown === true && r.count(/arrived damaged \(its SHA-256 isn't the server's\), starting over/, from) === 1, 'the damaged try was caught and started over');
  r.check(!!(await r.waitLog(new RegExp(`Saved down:${c1.data.id} .*SHA-256 checked`), from, 5000)), 'its Saved line says "SHA-256 checked"');

  const bad = crypto.randomBytes(MB);
  const c2 = await r.api('POST', '/api/uploads', { name: 'down2.bin', size: bad.length, mime: 'application/octet-stream', to: [r.peerId] });
  await r.upload(c2.data.id, bad, 0, bad.length);
  const stored = path.join(r.dir, 'data', 'files', c2.data.id);
  const b = fs.readFileSync(stored);
  b[1000] ^= 0xff;
  fs.writeFileSync(stored, b);
  from = r.logLines().length;
  const fw = await r.api('POST', `/api/items/${c2.data.id}/forward`, { to: [r.appId] });
  r.check(fw.status === 201, 'forwarded to the app (the same, damaged, file)');
  r.check(!!(await r.waitLog(new RegExp(`Download down:${fw.data.id} failed: It arrived damaged twice`), from, 30000)), 'the server\'s damaged copy: twice, then failed');
  r.check(!r.downFiles().some(f => f.startsWith('down2')), 'nothing of it saved, no part file left');

  from = r.logLines().length;
  const { id, data: big } = await r.startBig(40 * MB, 16 * MB);
  r.check(!!(await r.waitLog(new RegExp(`Saving ${id} while`), from, 15000)), 'a big file: saving starts while it arrives');
  await r.finishRest(id, big);
  r.check(await r.waitFor(() => r.saved(big), 30000), 'saved complete');
  r.check(!!(await r.waitLog(new RegExp(`Saved down:${id} .*SHA-256 checked`), from, 5000)), 'checked against its item\'s SHA-256 once it was one');
}

// (1.32, Beam 1.41) Collecting, read only: the app with collecting on and log folders in its config (one that may be,
// three that may not: a whole drive, its own folder, AppData itself), asked through the server as an approved device
// asks: event logs (System; one it may not read; one that isn't there), the log folder's files newest first (nothing
// hidden, dot-named or a junction), a file's end (UTF-8, UTF-16, the last 1 MB of a big one), nothing outside it,
// processes (its own Beam.exe, with its path), services, system; the Log folders window; beam.log never holds what went.
async function collect(r) {
  const logs = path.join(r.dir, 'files', 'applogs');
  fs.mkdirSync(path.join(logs, 'today'), { recursive: true });
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1} kumquat-${i + 1}`).join('\n') + '\n';
  fs.writeFileSync(path.join(logs, 'app.log'), lines);
  fs.writeFileSync(path.join(logs, '.secret.log'), 'hidden kumquat\n');
  fs.writeFileSync(path.join(logs, 'today', 'wide.log'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('wide one\r\nwide two\r\n', 'utf16le')]));
  fs.writeFileSync(path.join(logs, 'big.log'), Array.from({ length: 60000 }, (_, i) => `big ${String(i).padStart(6, '0')} ${'x'.repeat(40)}`).join('\n') + '\n');
  const old = path.join(logs, 'old.log');
  fs.writeFileSync(old, 'old line\n');
  fs.utimesSync(old, new Date(Date.now() - 86400e3), new Date(Date.now() - 86400e3));
  spawnSync('cmd', ['/c', 'mklink', '/J', path.join(logs, 'win'), process.env.SystemRoot || 'C:\\Windows'], { windowsHide: true });
  r.check(fs.existsSync(path.join(logs, 'win', 'win.ini')), 'a junction to Windows in the log folder (made for this test)');
  await r.setup({ collectAllowed: true, collectFolders: [{ name: 'App logs', path: logs }, { name: 'Whole drive', path: 'C:\\' },
    { name: 'Own', path: path.join(r.dir, 'cfg') }, { name: 'Roaming', path: process.env.APPDATA }] });
  const ask = body => r.api('POST', `/api/devices/${r.appId}/collect`, body);
  r.check(await r.waitFor(async () => ((await r.api('GET', '/api/devices')).data.devices || []).find(d => d.id === r.appId && d.online)?.can?.collect === true, 20000), 'can.collect: on there, and online');

  let x = await ask({ what: 'events', log: 'System', since: 7 * 1440, level: 'all', max: 5 });
  const ev = x.data?.events || [];
  r.check(x.status === 200 && ev.length === 5 && x.data.more === true && ev.every(e => e.at > 0 && e.source && typeof e.id === 'number' && typeof e.message === 'string' && e.message.length > 0),
    `events: System's last 5, more there (${x.status} ${JSON.stringify(ev[0] || x.data).slice(0, 160)})`);
  r.check(ev.every((e, i) => i === 0 || e.at <= ev[i - 1].at), 'newest first');
  const elevated = spawnSync('net', ['session'], { windowsHide: true }).status === 0;
  x = await ask({ what: 'events', log: 'Security' });
  r.check(elevated ? x.status === 200 : x.status === 409 && x.data.reason === 'denied', `the Security log: ${elevated ? 'read (this run is elevated)' : 'needs administrator rights'} (${x.status} ${x.data?.error})`);
  x = await ask({ what: 'events', log: 'No Such Log' });
  r.check(x.status === 409 && x.data.reason === 'not-found', `a log that isn't there (${x.status} ${x.data?.error})`);
  x = await ask({ what: 'events', log: 'Application', source: 'Beam regress nobody', since: 60 });
  r.check(x.status === 200 && Array.isArray(x.data.events) && x.data.events.length === 0, 'a source with no events: none');

  x = await ask({ what: 'folders' });
  r.check(JSON.stringify((x.data?.folders || []).map(f => f.name)) === '["App logs"]', `folders: only the one that may be one (${JSON.stringify(x.data)})`);
  r.check(r.count(/Log folders: Whole drive .*isn't a log folder: a whole drive/) === 1 && r.count(/Log folders: Own .*isn't a log folder: Beam's own folder/) === 1
    && r.count(/Log folders: Roaming .*isn't a log folder: that's one of Windows'/) === 1, 'the other three left out at the start, and said why');
  x = await ask({ what: 'files', folder: 'app logs' });
  const names = (x.data?.entries || []).map(e => e.name);
  r.check(x.status === 200 && names.includes('app.log') && names.includes('today') && names.includes('big.log') && names.at(-1) === 'old.log'
    && !names.includes('.secret.log') && !names.includes('win'), `files: newest first, nothing hidden, dot-named or a junction (${names.join(', ')})`);
  x = await ask({ what: 'files', folder: 'App logs', path: 'today' });
  r.check(JSON.stringify((x.data?.entries || []).map(e => e.name)) === '["wide.log"]' && x.data.path === 'today', 'a folder inside it');
  x = await ask({ what: 'file', folder: 'App logs', path: 'app.log', tail: 3 });
  r.check(x.data?.text === 'line 28 kumquat-28\nline 29 kumquat-29\nline 30 kumquat-30\n' && x.data.lines === 3 && x.data.cut === true && x.data.size === lines.length,
    `a file's last 3 lines (${JSON.stringify(x.data).slice(0, 200)})`);
  x = await ask({ what: 'file', folder: 'App logs', path: 'today\\wide.log' });
  r.check(x.data?.text === 'wide one\r\nwide two\r\n' && x.data.cut === false && x.data.path === 'today/wide.log', `UTF-16, all of it (${JSON.stringify(x.data?.text)})`);
  x = await ask({ what: 'file', folder: 'App logs', path: 'big.log', tail: 20000 });
  const bigText = x.data?.text || '';
  r.check(x.status === 200 && Buffer.byteLength(bigText) <= 1024 * 1024 && bigText.endsWith(`big 059999 ${'x'.repeat(40)}\n`) && /^big \d{6} x{40}\n/.test(bigText) && x.data.cut === true,
    `a 3 MB file: whole lines from its last 1 MB (${Buffer.byteLength(bigText)} bytes, ${x.data?.lines} lines)`);
  for (const bad of ['../app.log', '.secret.log', 'win/win.ini', 'today', 'C:\\Windows\\win.ini', 'nope.log', '/../../Windows/win.ini']) {
    x = await ask({ what: 'file', folder: 'App logs', path: bad });
    r.check(x.status === 409 && x.data.reason === 'not-found', `nothing outside it: ${bad} (${x.status} ${x.data?.error})`);
  }
  x = await ask({ what: 'files', folder: 'App logs', path: 'win' });
  r.check(x.status === 409 && x.data.reason === 'not-found', 'not through the junction');
  x = await ask({ what: 'file', folder: 'Nope', path: 'a.log' });
  r.check(x.status === 409 && x.data.reason === 'not-found' && /no log folder named Nope/.test(x.data.error), 'a folder that isn\'t one');

  x = await ask({ what: 'processes', name: 'Beam' });
  const mine = (x.data?.processes || []).find(q => q.path && q.path.toLowerCase() === r.appExe.toLowerCase());
  r.check(!!mine && mine.memory > 0 && mine.started > 0 && mine.pid > 0, `processes: its own Beam.exe with its path (${JSON.stringify(mine || x.data).slice(0, 200)})`);
  x = await ask({ what: 'services', name: 'eventlog' });
  r.check((x.data?.services || []).some(v => v.name === 'EventLog' && v.status === 'running' && v.start === 'automatic'), `services: EventLog running (${JSON.stringify(x.data).slice(0, 200)})`);
  x = await ask({ what: 'system' });
  const sys = x.data || {};
  const appVersion = /const string Text = "([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, 'windows', 'src', 'Version.cs'), 'utf8'))?.[1];
  r.check(String(sys.computer).toLowerCase() === os.hostname().toLowerCase().slice(0, 15) && sys.beam === appVersion && sys.memory?.total > 0 && sys.bootedAt > 0
    && (sys.disks || []).some(d => d.name === 'C:' && d.total > 0) && /^Windows/.test(sys.os?.name) && /^\d+\.\d+$/.test(sys.os?.build), `system (${JSON.stringify(sys).slice(0, 240)})`);

  const logText = r.logLines().join('\n');
  r.check(!logText.includes('kumquat') && !logText.includes('wide one') && !logText.includes(ev[0]?.message?.slice(0, 40) || '\u0000'), 'beam.log never holds what went back');
  r.check(r.count(/Collecting: file for Regress Phone/) >= 3 && r.count(/Collecting: events for Regress Phone/) >= 2, 'beam.log says who asked for what kind');

  let from = r.logLines().length;
  r.forward(['--test-log-folders', 'open']);
  r.check(!!(await r.waitLog(/Log folders \(test\): open, 1 folder\(s\): App logs = /, from, 15000)), 'the Log folders window opens with its one folder');
  r.forward(['--test-log-folders', 'add:C:\\']);
  r.check(!!(await r.waitLog(/Log folders \(test\): add a whole drive can't be one/, from, 10000)), 'a whole drive: no');
  r.forward(['--test-log-folders', `add:${path.join(r.dir, 'files')}`]);
  r.check(!!(await r.waitLog(/Log folders \(test\): add ok, 2 folder\(s\): App logs = .*; files = /, from, 10000)), 'a folder inside the temp folder (AppData): yes');
  const png = path.join(r.dir, 'log-folders.png');
  r.forward(['--test-log-folders', `shot:${png}`]);
  r.check(!!(await r.waitLog(/Log folders \(test\): shot/, from, 10000)) && fs.existsSync(png) && fs.statSync(png).size > 2000, 'the window drawn: ' + png);
  if (process.env.BEAM_REGRESS_SHOTS && fs.existsSync(png)) fs.copyFileSync(png, path.join(process.env.BEAM_REGRESS_SHOTS, 'log-folders.png'));
  r.forward(['--test-log-folders', 'save']);
  r.check(!!(await r.waitLog(/Log folders \(the test\): App logs \(.*\); files \(/, from, 10000)), 'saved');
  x = await ask({ what: 'folders' });
  r.check(JSON.stringify((x.data?.folders || []).map(f => f.name)) === '["App logs","files"]', 'both there now');
  from = r.logLines().length;
  x = await ask({ what: 'file', folder: 'files', path: 'applogs/app.log', tail: 1 });
  r.check(x.data?.text === 'line 30 kumquat-30\n', 'read through the new one');
}

// (1.33, Beam 1.41.1) The beam command set up from the app (the user: "make this all easy to do in the app itself on
// each device"): Set up (this Beam's build, checked; signed in as its own approved device; Claude Code's note after what
// was there), the command collecting from this very PC, the app still a Windows PC, the note out and in, Remove (all of
// it gone, the device too), and a build that isn't signed with this Beam's key refused. All inside the test's folder.
async function beamcmd(r) {
  const built = spawnSync(process.execPath, [path.join(ROOT, 'linux', 'build.mjs'), '--out', path.join(r.dir, 'dist')], { windowsHide: true, encoding: 'utf8' });
  r.check(built.status === 0 && fs.existsSync(path.join(r.dir, 'dist', 'beam-linux.js')), 'Beam for Linux (the beam command) built into the test server\'s dist ' + (built.stderr || '').slice(0, 200));
  const home = path.join(r.dir, 'cfg', 'home');
  const notes = path.join(home, '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(notes), { recursive: true });
  fs.writeFileSync(notes, '# Mine\n\nKeep this.\n');
  await r.setup({ collectAllowed: true });
  const step = async (cmd, ms = 60000) => {
    const from = r.logLines().length;
    r.forward(['--test-beam-command', cmd]);
    return (await r.waitLog(new RegExp(`beam command \\(test\\): ${cmd} `), from, ms)) || '';
  };
  let line = await step('setup');
  r.check(/ setup ok, /.test(line), 'Set up: ' + line.slice(0, 300));
  const cli = path.join(r.dir, 'cfg', 'cli');
  let cfgJson = {};
  try { cfgJson = JSON.parse(fs.readFileSync(path.join(home, '.beam.json'), 'utf8')); } catch {}
  r.check(fs.existsSync(path.join(cli, 'beam.js')) && fs.existsSync(path.join(cli, 'beam.cmd')), 'beam.js and beam.cmd in its folder');
  r.check(cfgJson.url === r.appUrl && /^b[pt]_/.test(cfgJson.key || '') && cfgJson.device === 'Regress PC (beam command)' && /^[0-9a-f]{24}$/.test(cfgJson.deviceId || ''),
    `signed in as its own device (${JSON.stringify({ ...cfgJson, key: (cfgJson.key || '').slice(0, 3) })})`);
  let text = fs.readFileSync(notes, 'utf8');
  r.check(text.startsWith('# Mine\n\nKeep this.\n\n<!-- Beam: the beam command') && text.includes('beam collect "<PC>" events') && text.trim().endsWith('<!-- /Beam -->'), 'Claude Code\'s note after what was there');
  // (not spawnSync: this process is the app's proxy, and the command's requests go through it)
  const run = args => new Promise(resolve => {
    const p = spawn('cmd', ['/c', path.join(cli, 'beam.cmd'), ...args], { windowsHide: true });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => p.kill(), 60000);
    p.on('exit', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  const x = await run(['collect', r.appId, 'system', '--json']);
  let got = null;
  try { got = JSON.parse(x.stdout); } catch {}
  const appVersion = /const string Text = "([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, 'windows', 'src', 'Version.cs'), 'utf8'))?.[1];
  r.check(x.status === 0 && got?.beam === appVersion && got?.pc?.id === r.appId, `the command collects from this very PC: ${x.status} ${(x.stdout || x.stderr || '').slice(0, 200)}`);
  const devs = (await r.api('GET', '/api/devices')).data.devices || [];
  const own = devs.find(d => d.id === cfgJson.deviceId);
  r.check(own?.platform === 'cli' && own?.trusted === true && own?.name === 'Regress PC (beam command)', `its own device, approved (${JSON.stringify(own && { name: own.name, platform: own.platform, trusted: own.trusted })})`);
  r.check(devs.find(d => d.id === r.appId)?.platform === 'windows', 'the app stays a Windows PC');
  line = await step('note:off');
  r.check(fs.readFileSync(notes, 'utf8') === '# Mine\n\nKeep this.\n', 'the note out, the rest as it was');
  line = await step('note:on');
  r.check(fs.readFileSync(notes, 'utf8').includes('<!-- /Beam -->') && /"note":true/.test(line), 'the note back');
  line = await step('remove');
  r.check(/ remove ok, /.test(line) && !fs.existsSync(cli) && !fs.existsSync(path.join(home, '.beam.json')), 'Remove: its folder and its sign-in gone');
  r.check(fs.readFileSync(notes, 'utf8') === '# Mine\n\nKeep this.\n', 'Remove: the note gone, the rest as it was');
  r.check(await r.waitFor(async () => !((await r.api('GET', '/api/devices')).data.devices || []).some(d => d.id === cfgJson.deviceId), 10000), 'Remove: its device gone from Beam');
  const meta = path.join(r.dir, 'dist', 'beam-linux.js.json');
  const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
  fs.writeFileSync(meta, JSON.stringify({ ...m, sig: Buffer.alloc(64, 7).toString('base64') }));
  line = await step('setup');
  r.check(/isn't signed with this Beam's key/.test(line) && !fs.existsSync(path.join(cli, 'beam.js')), 'a build not signed with this Beam\'s key: refused, nothing installed (' + line.slice(0, 200) + ')');
}

// (1.28, Beam 1.36) The Weather row's page: the bridge's openWeather opens LocalCast's page (here a made-up one) in a
// window of its own (its own profile, no bridge); asked again, the same window; an address that isn't a web page's is
// refused.
async function weather(r) {
  await r.setup();
  let hits = 0;
  const lc = http.createServer((req, res) => { hits++; res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>LocalCast</title><p>43°</p>'); });
  await new Promise(res => lc.listen(0, '127.0.0.1', res));
  try {
    const url = `http://127.0.0.1:${lc.address().port}/`;
    const ask = async (msg, id) => {
      const from = r.logLines().length;
      r.forward(['--test-bridge', JSON.stringify({ type: 'openWeather', id, ...msg })]);
      const line = await r.waitLog(new RegExp(`Bridge test reply: .*"id":"${id}"`), from, 20000);
      return line ? JSON.parse(line.slice(line.indexOf('{'))) : null;
    };
    let from = r.logLines().length;
    let rep = await ask({ url }, 'test-w1');
    r.check(rep && rep.ok !== false && !rep.code, `openWeather answers (${JSON.stringify(rep)})`);
    r.check(!!(await r.waitLog(/Weather: LocalCast's page shown/, from, 30000)), 'its window shows LocalCast’s page');
    r.check(hits > 0, 'the page was asked for');
    from = r.logLines().length;
    rep = await ask({ url }, 'test-w2');
    r.check(rep && !rep.code, 'asked again: fine');
    await sleep(1500);
    r.check(!r.logLines().slice(from).some(l => /Weather: opened its window/.test(l)), 'the same window, not another one');
    rep = await ask({ url: 'file:///C:/Windows/win.ini' }, 'test-w3');
    r.check(rep && rep.code === 'bad-request', `a file's address is refused (${JSON.stringify(rep)})`);
  } finally {
    lc.close();
  }
}

// 1.6.2: Copy image in the chat goes through the app (an http page has no image clipboard). Here the clipboard is the
// isolated one (cfg/clipboard.png, and clipboard-image.txt: "png" when PNG bytes went along for transparency). A photo
// is turned as its EXIF says; a type Windows can't read is "unsupported" (the page then sends PNG, which the app
// takes); a text item is "not-found".
async function copyImage(r) {
  await r.setup({ clipboardHistory: false });
  // Pictures made here with Windows' own encoder: a 4×2 JPEG (given EXIF orientation 6: turn 90° right), a 3×1 PNG
  // with a half-transparent pixel.
  const ps = spawnSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Drawing
    $b = New-Object System.Drawing.Bitmap 4, 2
    for ($x = 0; $x -lt 4; $x++) { for ($y = 0; $y -lt 2; $y++) { $b.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, 200, 30, 30)) } }
    $m = New-Object System.IO.MemoryStream; $b.Save($m, [System.Drawing.Imaging.ImageFormat]::Jpeg)
    $p = New-Object System.Drawing.Bitmap 3, 1, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $p.SetPixel(0, 0, [System.Drawing.Color]::FromArgb(128, 0, 0, 255))
    $n = New-Object System.IO.MemoryStream; $p.Save($n, [System.Drawing.Imaging.ImageFormat]::Png)
    [Convert]::ToBase64String($m.ToArray()) + ' ' + [Convert]::ToBase64String($n.ToArray())`], { windowsHide: true, encoding: 'utf8' });
  const [jpegB64, pngB64] = ps.stdout.trim().split(' ');
  const plain = Buffer.from(jpegB64, 'base64');
  // APP1 Exif right after SOI: a little-endian TIFF header and one IFD entry, Orientation (0x0112) = 6.
  const exif = Buffer.from([0xff, 0xe1, 0x00, 0x22, ...Buffer.from('Exif\0\0'), 0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const jpeg = Buffer.concat([plain.subarray(0, 2), exif, plain.subarray(2)]);
  const png = Buffer.from(pngB64, 'base64');
  const send = async (name, data, mime) => {
    const c = await r.api('POST', '/api/uploads', { name, size: data.length, mime, to: [r.appId] });
    await r.upload(c.data.id, data, 0, data.length);
    r.check(await r.waitFor(() => r.saved(data, name), 20000), `${name} arrived at the app`);
    return c.data.id;
  };
  const clip = path.join(r.dir, 'cfg', 'clipboard.png');
  const kind = path.join(r.dir, 'cfg', 'clipboard-image.txt');
  const size = () => { try { const b = fs.readFileSync(clip); return b.subarray(1, 4).toString() === 'PNG' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; } catch { return null; } };
  let seq = 0;
  const bridge = async msg => {
    const id = `test-img-${++seq}`;
    for (const f of [clip, kind]) fs.rmSync(f, { force: true });
    const from = r.logLines().length;
    r.forward(['--test-bridge', JSON.stringify({ type: 'copyImage', id, ...msg })]);
    const line = await r.waitLog(new RegExp(`Bridge test reply: .*"id":"${id}"`), from, 20000);
    return line ? JSON.parse(line.slice(line.indexOf('{'))) : null;
  };
  const photo = await send('photo.jpg', jpeg, 'image/jpeg');
  let rep = await bridge({ itemId: photo });
  r.check(rep && rep.ok === true, `a JPEG is copied (${rep && (rep.code || 'ok')})`);
  r.check(JSON.stringify(size()) === '[2,4]', `turned as its EXIF says: 2×4 (${JSON.stringify(size())})`);
  r.check(fs.existsSync(kind) && fs.readFileSync(kind, 'utf8') === 'bitmap no-history', 'a photo goes as a bitmap only, kept out of clipboard history (that setting is off here)');
  const icon = await send('dot.png', png, 'image/png');
  rep = await bridge({ itemId: icon });
  r.check(rep && rep.ok === true && JSON.stringify(size()) === '[3,1]', 'a PNG is copied');
  r.check(fs.existsSync(kind) && fs.readFileSync(kind, 'utf8').startsWith('png'), 'transparency: PNG bytes go along');
  const webp = await send('photo.webp', Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 not really'), 'image/webp');
  rep = await bridge({ itemId: webp });
  r.check(rep && rep.ok === false && rep.code === 'unsupported' && !fs.existsSync(clip), `a type Windows can't read: "unsupported" (${rep && rep.code})`);
  rep = await bridge({ png: pngB64 });
  r.check(rep && rep.ok === true && JSON.stringify(size()) === '[3,1]', 'PNG from the page is copied');
  rep = await bridge({ png: 'bm90IGFuIGltYWdl' });
  r.check(rep && rep.ok === false && rep.code === 'unsupported', `bytes that aren't an image: "unsupported" (${rep && rep.code})`);
  const note = await r.api('POST', '/api/text', { text: 'not a picture', to: [r.appId] });
  await sleep(1500);
  rep = await bridge({ itemId: note.data.id });
  r.check(rep && rep.ok === false && rep.code === 'not-found', `a text item: "not-found" (${rep && rep.code})`);
}

// 1.12 (Windows 1.9.0): files picked together in the chat go onto the clipboard together (copyFiles) or in one drag
// (dragOut with itemIds). The clipboard is the isolated one (cfg/clipboard-files.txt), and a test instance never starts
// a real drag (cfg/drag-files.txt instead). A file that isn't on this PC yet is named in "missing" with the clipboard's
// sequence number; something copied meanwhile makes the next ask with that number "clipboard-changed".
async function copyFiles(r) {
  await r.setup({ maxSaveMB: 1 }); // (bigger files aren't saved by themselves)
  const send = async (name, data) => {
    const c = await r.api('POST', '/api/uploads', { name, size: data.length, mime: 'image/png', to: [r.appId] });
    await r.upload(c.data.id, data, 0, data.length);
    return c.data.id;
  };
  const one = Buffer.from('\x89PNG first picture'), two = Buffer.from('\x89PNG second picture'), big = crypto.randomBytes(2 * MB);
  const a = await send('one.png', one);
  const b = await send('two.png', two);
  r.check(await r.waitFor(() => r.saved(one, 'one.png') && r.saved(two, 'two.png'), 20000), 'two pictures came and were saved');
  const c = await send('big.png', big);
  await sleep(2000);
  r.check(!r.saved(big, 'big.png'), 'a bigger one wasn\'t saved by itself');
  let seq = 0;
  const bridge = async msg => {
    const id = `test-files-${++seq}`;
    const from = r.logLines().length;
    r.forward(['--test-bridge', JSON.stringify({ id, ...msg })]);
    const line = await r.waitLog(new RegExp(`Bridge test reply: .*"id":"${id}"`), from, 20000);
    return line ? JSON.parse(line.slice(line.indexOf('{'))) : null;
  };
  const lines = f => { try { return fs.readFileSync(path.join(r.dir, 'cfg', f), 'utf8').split(/\r?\n/).filter(Boolean).map(p => path.basename(p)); } catch { return []; } };
  const what = rep => JSON.stringify(rep && (rep.ok ? rep.result : rep.code));
  let rep = await bridge({ type: 'copyFiles', itemIds: [a, b] });
  r.check(rep && rep.ok && rep.result.copied === 2, `two saved files are copied (${what(rep)})`);
  r.check(lines('clipboard-files.txt').join() === 'one.png,two.png', `...onto the clipboard as files, in order (${lines('clipboard-files.txt')})`);
  fs.rmSync(path.join(r.dir, 'cfg', 'clipboard-files.txt'), { force: true });
  rep = await bridge({ type: 'copyFiles', itemIds: [a, c] });
  const clipSeq = rep && rep.ok ? rep.result.clipSeq : undefined;
  r.check(rep && rep.ok && JSON.stringify(rep.result.missing) === JSON.stringify([c]) && Number.isFinite(clipSeq) && !lines('clipboard-files.txt').length,
    `one not on this PC: nothing copied, it's named as missing, with the clipboard's number (${what(rep)})`);
  rep = await bridge({ type: 'dragOut', itemIds: [a, c] });
  r.check(rep && rep.ok === false && rep.code === 'not-saved' && !lines('drag-files.txt').length, `a drag with one not saved: "not-saved", no drag (${what(rep)})`);
  rep = await bridge({ type: 'saveFile', itemId: c });
  r.check(await r.waitFor(() => r.saved(big, 'big.png'), 30000), 'saved when asked');
  rep = await bridge({ type: 'copyFiles', itemIds: [a, c], clipSeq });
  r.check(rep && rep.ok && rep.result.copied === 2 && lines('clipboard-files.txt').join() === 'one.png,big.png', `asked again with that number: both copied (${what(rep)})`);
  // Something else copied in between: the files don't replace it.
  rep = await bridge({ type: 'copyFiles', itemIds: [b], clipSeq });
  r.check(rep && rep.ok && rep.result.copied === 1, `the number still matches: copied (${what(rep)})`);
  await sleep(50);
  fs.writeFileSync(path.join(r.dir, 'cfg', 'clipboard-in.png'), Buffer.from('copied meanwhile')); // (the test clipboard's number is this file's time)
  fs.rmSync(path.join(r.dir, 'cfg', 'clipboard-files.txt'), { force: true });
  rep = await bridge({ type: 'copyFiles', itemIds: [a, b], clipSeq });
  r.check(rep && rep.ok === false && rep.code === 'clipboard-changed' && !lines('clipboard-files.txt').length, `something else was copied meanwhile: "clipboard-changed", nothing copied (${what(rep)})`);
  // One drag for several (a test instance writes them down instead of dragging).
  let from = r.logLines().length;
  rep = await bridge({ type: 'dragOut', itemIds: [b, a, c] });
  r.check(rep && rep.ok && lines('drag-files.txt').join() === 'two.png,one.png,big.png', `a drag of three: one drag, all three (${what(rep)}; ${lines('drag-files.txt')})`);
  r.check(!!(await r.waitLog(/Drag out of 3 files \(a test instance/, from, 5000)), '...logged as one drag');
  rep = await bridge({ type: 'dragOut', itemId: a });
  r.check(rep && rep.ok && lines('drag-files.txt').join() === 'one.png', `one file, as before (${what(rep)})`);
  // Not files: "not-found"; none or too many: "bad-request".
  const note = await r.api('POST', '/api/text', { text: 'not a file', to: [r.appId] });
  await sleep(1500);
  rep = await bridge({ type: 'copyFiles', itemIds: [a, note.data.id] });
  r.check(rep && rep.ok === false && rep.code === 'not-found', `a text among them: "not-found" (${what(rep)})`);
  rep = await bridge({ type: 'copyFiles', itemIds: [] });
  r.check(rep && rep.ok === false && rep.code === 'bad-request', `nothing to copy: "bad-request" (${what(rep)})`);
  rep = await bridge({ type: 'copyFiles', itemIds: Array.from({ length: 1001 }, (_, i) => `x${i}`) });
  r.check(rep && rep.ok === false && rep.code === 'bad-request', `1,001 at once: "bad-request" (${what(rep)})`);
}

// 1.7.1: a click on the notification for files that came opens their conversation at the newest of them (with several at
// once it just brought Beam up, wherever it was), and a picture's own notification opens it in Beam rather than in
// Explorer. (Other files still show in their folder: not clicked here, it would open Explorer.)
async function notifyOpen(r) {
  await r.setup();
  const send = async (name, data, mime) => {
    const c = await r.api('POST', '/api/uploads', { name, size: data.length, mime, to: [r.appId] });
    await r.upload(c.data.id, data, 0, data.length);
    return c.data.id;
  };
  const one = Buffer.from('\x89PNG first picture'), two = Buffer.from('\x89PNG second picture');
  let from = r.logLines().length;
  const a = await send('one.png', one, 'image/png');
  const b = await send('two.png', two, 'image/png');
  r.check(await r.waitFor(() => r.saved(one, 'one.png') && r.saved(two, 'two.png'), 20000), 'two pictures came and were saved');
  const merged = await r.waitLog(/Notification: file item \w+ saved, file item \w+ saved/, from, 10000);
  r.check(!!merged && merged.includes(a) && merged.includes(b), `one balloon for both (${merged ? merged.replace(/.*Notification: /, '') : 'none'})`);
  from = r.logLines().length;
  r.forward(['--test-click-balloon']);
  let nav = await r.waitLog(/Web window: navigate to /, from, 60000);
  r.check(!!nav && nav.endsWith(`navigate to ${r.peerId} at ${b}`), `its click opens their conversation at the newer one (${nav ? nav.replace(/.*navigate to /, '') : 'nothing'})`);
  // (the window now shows that conversation, so nothing new there would be notified: hide it)
  r.forward(['--hide']);
  await sleep(1500);
  from = r.logLines().length;
  const three = Buffer.from('\x89PNG third picture');
  const c = await send('three.png', three, 'image/png');
  r.check(!!(await r.waitLog(new RegExp(`Notification: file item ${c} saved$`), from, 20000)), 'a third picture, on its own balloon');
  from = r.logLines().length;
  r.forward(['--test-click-balloon']);
  nav = await r.waitLog(/Web window: navigate to /, from, 30000);
  r.check(!!nav && nav.endsWith(`navigate to ${r.peerId} at ${c}`), `a picture's own balloon opens it in Beam (${nav ? nav.replace(/.*navigate to /, '') : 'nothing'})`);
}

// 1.8.1: the app keeps its settings on the server (after looking for an earlier install's: none), sends a change 10 s
// later; a reinstall (a new install with its own config, id and key, on this PC and Windows account) is offered the old
// install's settings once, and gets them back.
// (1.23, the review's M26) An outbox entry whose upload a crash stopped half way: after the restart it's resumed (not sent
// again by the new outbox) and moved to Sent when it's done. Before 1.23 it went twice and stayed until the second one.
async function outboxRestart(r) {
  const outbox = path.join(r.dir, 'outbox');
  r.upRate = 4 * MB; // 40 MB at 4 MB a second: about 10 s
  await r.setup({ outbox: true, outboxFolder: outbox });
  const all = path.join(outbox, 'To All devices');
  r.check(await r.waitFor(() => fs.existsSync(all), 15000), 'the outbox folders are made');
  const data = crypto.randomBytes(40 * MB);
  const entry = path.join(all, 'outbox-big.bin');
  let from = r.logLines().length;
  fs.writeFileSync(entry, data);
  r.check(!!(await r.waitLog(/Outbox: sending an entry/, from, 20000)), 'the outbox starts sending it');
  await r.waitLog(/upload|Upload/, from, 10000);
  await sleep(4000); // part of it on the server
  r.app.kill(); // a crash (nothing saved on the way out)
  await r.waitFor(() => r.appExit !== undefined, 10000);
  const items0 = ((await r.api('GET', '/api/items')).data.items || []).filter(i => i.name === 'outbox-big.bin');
  r.check(items0.length === 0, 'not finished before the crash (the test sent it slowly enough)');
  r.check(fs.existsSync(entry), 'the entry is still in the outbox');
  r.upRate = 0;
  from = r.logLines().length;
  r.startApp();
  r.check(!!(await r.waitLog(/Resuming upload/, from, 30000)), 'the upload resumes after the restart');
  r.check(await r.waitFor(() => fs.existsSync(path.join(all, 'Sent', 'outbox-big.bin')), 45000), 'the entry is moved to Sent when it\'s done');
  await sleep(6000); // the outbox's checks of a steady entry take 2 to 3 s: time for a second send, if there were one
  const items = ((await r.api('GET', '/api/items')).data.items || []).filter(i => i.name === 'outbox-big.bin');
  r.check(items.length === 1, `sent once (${items.length} items)`);
  r.check(r.count(/Outbox: sending an entry/, from) === 0, 'the new outbox didn\'t send it again');
  if (items.length) {
    const res = await fetch(`${r.base}/api/file/${items[0].id}`, { headers: r.peerHeaders() });
    const got = Buffer.from(await res.arrayBuffer());
    r.check(res.status === 200 && sha(got) === sha(data), 'the file on the server is complete');
  }
}

// (1.23, the review) Names Windows treats as devices get a "_" first ("CON .txt" too: Windows drops the stem's trailing
// space); a long name is cut before its extension, not through it.
async function names(r) {
  await r.setup();
  const long = 'L'.repeat(200) + '.pdf';
  const want = { 'CON .txt': '_CON .txt', 'conin$.log': '_conin$.log', 'COM0.txt': '_COM0.txt', 'LPT\u00b9.txt': '_LPT\u00b9.txt' };
  const ids = [];
  for (const name of [...Object.keys(want), long]) {
    const data = Buffer.from('hello ' + name);
    const c = await r.api('POST', '/api/uploads', { name, size: data.length, mime: 'application/octet-stream', to: [r.appId] });
    if (c.status !== 201) { r.check(false, `upload ${name}: ${JSON.stringify(c)}`); continue; }
    await r.upload(c.data.id, data, 0, data.length);
    ids.push(c.data.id);
  }
  const got = () => r.downFiles().filter(n => !n.endsWith('.beampart'));
  await r.waitFor(() => got().length >= ids.length, 30000);
  const files = got();
  for (const [name, saved] of Object.entries(want)) r.check(files.includes(saved), `"${name}" is saved as "${saved}" (${JSON.stringify(files.filter(f => !f.startsWith('L')))})`);
  const l = files.find(f => f.startsWith('LLLL'));
  r.check(!!l && l.endsWith('.pdf') && l.length <= 180, `a ${long.length}-character name keeps its extension (${l ? l.length + ' characters, …' + l.slice(-8) : 'not saved'})`);
}

async function backups(r) {
  await r.setup({ autoCopy: false, hotkeys: { picker: 'Ctrl+Alt+P' } });
  const get = async () => { const x = await r.api('GET', `/api/devices/${r.appId}/backups`); return x.status === 200 ? x.data.backups || [] : []; };
  let list = [];
  r.check(await r.waitFor(async () => (list = await get()).length > 0, 30000), 'the app keeps its settings on the server');
  const first = r.readConfig();
  const b = list[0] || {};
  r.check(b.app === 'windows' && b.install === first.installId && b.settings && b.settings.autoCopy === false && b.settings.hotkeys && b.settings.hotkeys.picker === 'Ctrl+Alt+P',
    `...this install's, as they are (${JSON.stringify(b.settings || {}).slice(0, 120)}…)`);
  r.check(!/"(key|keyProtected|server|deviceId)"/.test(JSON.stringify(b.settings || {})), '...without the sign-in, the server or the device id');
  r.check(first.restoreChecked === true && !!(await r.waitLog(/Settings: this PC's are kept on the server too/, 0, 5000)), '...after looking for an earlier install\'s (there was none)');
  r.forward(['--test-bridge', JSON.stringify({ type: 'setSettings', id: 'test-set', settings: { openLinks: false } })]);
  r.check(await r.waitFor(async () => ((await get())[0] || {}).settings?.openLinks === false, 25000), 'a change goes up (10 s later)');
  // (audit 2026-10-11 S-4) Where received files go is picked at this PC only (Windows' folder picker), never by the page.
  const asked = r.logLines().length;
  r.forward(['--test-bridge', JSON.stringify({ type: 'setSettings', id: 'test-folder', settings: { saveFolder: path.join(r.dir, 'startup') } })]);
  const line = await r.waitLog(/Bridge test reply: .*"id":"test-folder"/, asked, 10000);
  const rep = line ? JSON.parse(line.slice(line.indexOf('{'))) : null;
  r.check(rep && rep.ok === false && rep.code === 'native-only' && r.readConfig().saveFolder !== path.join(r.dir, 'startup'), `the page can't choose the save folder (${rep ? rep.code || 'ok' : 'no reply'})`);
  await r.quitApp();
  // The reinstall: a fresh config in the same place (a test instance's "Windows account" goes by its config path), so a
  // new device id, install id and device key, and the default settings.
  const oldInstall = first.installId;
  r.appId = 'regresspc' + crypto.randomBytes(8).toString('hex');
  for (const f of ['device.key', 'state.json', 'handled.json']) fs.rmSync(path.join(r.dir, 'cfg', f), { force: true });
  const reinstalled = r.logLines().length;
  r.writeConfig({});
  r.startApp();
  const offered = await r.waitLog(/Settings: an earlier install of Beam on this PC kept its settings on the server .*; offering them/, reinstalled, 45000);
  r.check(!!offered, 'the reinstall is offered the earlier install\'s settings');
  let from = r.logLines().length;
  r.forward(['--test-backups', 'state']);
  const state = await r.waitLog(/Settings: \(test\) /, from, 10000);
  r.check(!!state && state.includes(`[x] this PC ${oldInstall}`) && /checked False/.test(state), `...one offer, that install's (${state ? state.replace(/.*\(test\) /, '') : 'none'})`);
  from = r.logLines().length;
  r.forward(['--test-backups', 'answer:restore']);
  r.check(!!(await r.waitLog(/Settings: put back this PC's settings from an earlier install's backup of /, from, 10000)), 'Restore: put back');
  const now = r.readConfig();
  r.check(now.autoCopy === false && now.openLinks === false && now.hotkeys && now.hotkeys.picker === 'Ctrl+Alt+P' && now.restoreChecked === true && now.installId !== oldInstall,
    `...the earlier install's settings, in this install's config (autoCopy ${now.autoCopy}, openLinks ${now.openLinks}, picker ${now.hotkeys && now.hotkeys.picker})`);
  r.check(await r.waitFor(async () => { const l = await get(); return l.length === 2 && l[0].install === now.installId && l[1].install === oldInstall; }, 25000), '...and this install\'s own backup goes up next to the earlier one');
  from = r.logLines().length;
  r.forward(['--test-backups', 'state']);
  r.check(/no restore offer open; checked True/.test((await r.waitLog(/Settings: \(test\) /, from, 10000)) || ''), 'offered once');
}

// (1.30, Beam 1.38, the 2026-11-21 audit's RD2) The status says how Remote Desktop's picture is set up on this PC, as
// its registry has it (read with reg.exe here, read only): the three policies when set, the frame-rate limit when set,
// nothing while Remote Desktop is off.
function regValue(key, name) {
  const out = spawnSync('reg', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true });
  const m = out.status === 0 && (out.stdout || '').match(new RegExp(`${name}\\s+REG_(DWORD|SZ)\\s+(\\S+)`));
  return m ? (m[1] === 'DWORD' ? parseInt(m[2], 16) : m[2]) : null;
}

async function rdp(r) {
  await r.setup();
  r.check(!!(await r.waitLog(/Status sent/, 0, 30000)), 'the status went out');
  const ts = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\Terminal Services';
  const edition = regValue('HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', 'EditionID') || '';
  const policy = regValue(ts, 'fDenyTSConnections');
  const on = !/^Core/i.test(edition) && (policy != null ? policy === 0 : regValue('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server', 'fDenyTSConnections') === 0);
  let want;
  if (on) {
    want = {};
    for (const [k, name] of [['gpu', 'bEnumerateHWBeforeSW'], ['avc444', 'AVC444ModePreferred'], ['hwEncode', 'AVCHardwareEncodePreferred']]) {
      const v = regValue(ts, name);
      if (typeof v === 'number') want[k] = v !== 0;
    }
    const interval = regValue('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations', 'DWMFRAMEINTERVAL');
    if (typeof interval === 'number' && interval >= 1) want.fps = Math.min(60, interval * 4);
  }
  let got;
  for (let i = 0; i < 20; i++) {
    const me = ((await r.api('GET', '/api/devices')).data.devices || []).find(d => d.id === r.appId);
    got = me?.status?.rdpGraphics;
    if (JSON.stringify(got) === JSON.stringify(want)) break;
    await sleep(500);
  }
  r.check(JSON.stringify(got) === JSON.stringify(want), `rdpGraphics as the registry has it (Remote Desktop ${on ? 'on' : 'off'} here): ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const scenarios = { reconnect, restart, revoke, ack, doublepoke, nonbeam401, 'cancel-after-restart': cancelAfterRestart, 'cancel-live': cancelLive, lane,
  'pause-full': pauseFull, 'blip-mid-chunk': blipMidChunk, 'retry-early': retryEarly, 'lost-finish': lostFinish, 'copy-image': copyImage, 'copy-files': copyFiles, 'notify-open': notifyOpen, backups,
  'outbox-restart': outboxRestart, names, notes, weather, rdp, checksums, collect, beamcmd };
const run = wanted.length === 0 || wanted.includes('all') ? Object.keys(scenarios) : wanted;
if (!EXE) { console.error('No Beam.exe: build with windows\\build.cmd or pass --exe'); process.exit(2); }
console.log(`Beam: ${EXE}\ntemp: ${TMP}`);
for (const name of run) {
  if (!scenarios[name]) { console.error('unknown scenario ' + name); process.exit(2); }
  const r = new Run(name);
  const t0 = Date.now();
  try { await scenarios[name](r); }
  catch (e) { r.check(false, 'error: ' + (e.message || e)); }
  finally { await r.cleanup(); }
  console.log(`     ${name}: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
if (!failures.length || !process.env.BEAM_REGRESS_KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} } else console.log('kept ' + TMP);
console.log(failures.length ? `${failures.length} check(s) failed` : 'all regression checks passed');
process.exit(failures.length ? 1 : 0);
