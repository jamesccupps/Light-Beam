#!/usr/bin/env node
// Beam for Windows: regression checks for the 1.4.0 review findings (save while arriving, revoke, receipts, stream
// checks, foreign 401s, leftover partial files, a paused sender) and the re-review's R1/R2 (a sender pausing right
// after full reads; Retry on a failed early download), 1.6.2's Copy image and 1.7.1's notification clicks. Exits 1 if
// any check fails.
//
//   node test/perf/windows-regress.mjs [all|reconnect|restart|revoke|ack|doublepoke|nonbeam401|cancel-after-restart|cancel-live|lane
//        |pause-full|retry-early|lost-finish|copy-image|notify-open] [--exe <Beam.exe>]
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
    this.proxy = net.createServer(c => {
      const s = net.connect(PORT, '127.0.0.1');
      this.sockets.add(c); this.sockets.add(s);
      pipe(c, s);
      if (this.dropFinish) {
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

const scenarios = { reconnect, restart, revoke, ack, doublepoke, nonbeam401, 'cancel-after-restart': cancelAfterRestart, 'cancel-live': cancelLive, lane,
  'pause-full': pauseFull, 'retry-early': retryEarly, 'lost-finish': lostFinish, 'copy-image': copyImage, 'notify-open': notifyOpen };
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
