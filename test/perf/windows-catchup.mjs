#!/usr/bin/env node
// Beam for Windows 1.11.1: catch-ups ask only what changed (Beam 1.4 `items-since`). Exits 1 if a check fails.
//
//   node test/perf/windows-catchup.mjs [--exe <Beam.exe>] [--keep]
//
// Isolated like the other windows-* checks: a scratch server (this checkout's server.js) on 127.0.0.1:8803 with 300
// texts (200 random characters each: they don't compress away, as repeated words would), and a copy of Beam.exe with
// --config in a temp folder (quiet, off-screen) that reaches it through a TCP proxy on 8853 (this script), whose
// connections are dropped and refused for a moment (a network blip). While the app is away: 2 new texts for it, 3
// deleted, 1 pinned. Checks: the first catch-up takes the whole list; after the blip the
// catch-up asks with `since`, gets only the changes (its bytes, from the server's metrics, against the whole list's)
// and applies them (beam.log: what changed and how many items are left; the new texts received and acknowledged); after
// a server restart the cursor is unknown and the whole list comes back, the same as the one the delta made; a `refresh`
// event makes the next catch-up take the whole list. Nothing is clicked or typed.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = 8803, PROXY = 8853;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const exeArg = args.indexOf('--exe');
const EXE = exeArg >= 0 ? args[exeArg + 1] : [path.join(ROOT, 'windows', 'bin', 'Beam.exe'), path.join(ROOT, 'dist', 'Beam.exe')].find(f => fs.existsSync(f));
const KEEP = args.includes('--keep');
const TMP = path.join(os.tmpdir(), `beam-catchup-win-${Date.now()}`);
const failures = [];
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
  return ok;
}
const dir = p => path.join(TMP, p);
for (const d of ['data', 'dist', 'cfg', 'app']) fs.mkdirSync(dir(d), { recursive: true });
const cfgPath = dir('cfg/config.json'), logPath = dir('cfg/beam.log'), appExe = dir('app/Beam.exe');
const base = `http://127.0.0.1:${PORT}`;
const proxyBase = `http://127.0.0.1:${PROXY}`;
const pcId = 'catchuppc' + crypto.randomBytes(8).toString('hex');
const phoneId = 'catchupphone' + crypto.randomBytes(6).toString('hex');
let server, proxy, app, appExit, key;

const logLines = () => { try { return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l, i, a) => i < a.length - 1 || l !== ''); } catch { return []; } };
async function waitLog(re, from = 0, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const lines = logLines();
    for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return lines[i];
    await sleep(100);
  }
  return null;
}

async function startServer() {
  const out = fs.openSync(dir('server.out.log'), 'a');
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, BEAM_TAILSCALE: 'off', BEAM_HOST: '127.0.0.1', BEAM_PORT: String(PORT), BEAM_DATA: dir('data'), BEAM_DIST: dir('dist') } });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/api/hello`)).ok) break; } catch {} await sleep(200); }
}
async function stopServer() {
  const s = server;
  if (!s) return;
  s.kill();
  await new Promise(r => { s.once('exit', r); setTimeout(r, 3000); });
}

// The app's way to the server: its connections can be dropped and refused (a blip); the requests it makes are noted.
const sockets = new Set();
const asked = []; // request lines from the app
let refusing = false;
function startProxy() {
  proxy = net.createServer(c => {
    if (refusing) { c.destroy(); return; }
    const s = net.connect(PORT, '127.0.0.1');
    sockets.add(c); sockets.add(s);
    c.on('data', chunk => {
      for (const m of chunk.toString('latin1').matchAll(/^(GET|POST|PUT|PATCH|DELETE) (\S+) HTTP/gm)) asked.push(`${m[1]} ${m[2]}`);
    });
    c.pipe(s); s.pipe(c);
    const done = () => { c.destroy(); s.destroy(); sockets.delete(c); sockets.delete(s); };
    c.on('error', done); s.on('error', done); c.on('close', done); s.on('close', done);
  });
  return new Promise(r => proxy.listen(PROXY, '127.0.0.1', r));
}

const phone = (method, p, body) => fetch(base + p, { method, body: body ? JSON.stringify(body) : undefined,
  headers: { Authorization: `Bearer ${key}`, 'X-Beam-Device-Id': phoneId, 'X-Beam-Device': 'Catch-up Phone', 'X-Beam-Platform': 'android',
    'X-Forwarded-For': '100.64.0.7', ...(body ? { 'Content-Type': 'application/json' } : {}) } }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }));
// The server's own count of what GET /api/items cost (owner-only metrics, the master key).
const itemsMetrics = async () => {
  const m = await (await fetch(`${base}/api/metrics`, { headers: { Authorization: `Bearer ${key}` } })).json();
  return m.requests.listItems || { count: 0, bytes: 0 }; // (the route is named after its handler)
};
const forward = a => spawnSync(appExe, ['--config', cfgPath, ...a], { env: { ...process.env, BEAM_LOCAL_URLS: proxyBase, BEAM_TEST_PEERS: proxyBase }, windowsHide: true, timeout: 20000 });
async function quitApp() {
  if (!app || appExit !== undefined) return;
  forward(['--quit']);
  for (let i = 0; i < 80 && appExit === undefined; i++) await sleep(250);
  if (appExit === undefined) { try { app.kill(); } catch {} }
  await sleep(1000);
}

try {
  if (!EXE) throw new Error('No Beam.exe: build with windows\\build.cmd or pass --exe');
  fs.copyFileSync(EXE, appExe);
  console.log(`Beam: ${EXE}\ntemp: ${TMP}`);
  await startServer();
  key = fs.readFileSync(dir('data/key'), 'utf8').trim();
  const texts = [];
  for (let i = 0; i < 300; i++) {
    const r = await phone('POST', '/api/text', { text: `old text ${i}: ${crypto.randomBytes(150).toString("base64")}`, to: [] });
    if (r.status !== 201) throw new Error(`seeding: ${r.status}`);
    texts.push(r.data.id);
  }
  const made = await (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Beam-Platform': 'windows' },
    body: JSON.stringify({ secret: key, client: 'app', platform: 'windows', deviceId: pcId }) })).json();
  if (!made.key || made.you !== pcId) throw new Error('no device token for the test PC');
  await startProxy();
  fs.writeFileSync(cfgPath, JSON.stringify({ server: proxyBase, key: made.key, deviceId: pcId, deviceName: 'Catch-up Test PC', quiet: true, testOffscreen: true,
    autoUpdate: false, autostartInitialized: true, sendToMenu: false, outbox: false, autoCopy: false, autoSave: false }, null, 2));
  app = spawn(appExe, ['--config', cfgPath, '--background'], { env: { ...process.env, BEAM_LOCAL_URLS: proxyBase, BEAM_TEST_PEERS: proxyBase }, windowsHide: true, stdio: 'ignore' });
  app.on('exit', code => { appExit = code; });

  // 1. The first catch-up: the whole list.
  check(!!(await waitLog(/Events: connected/, 0, 30000)), 'the app connects (through the proxy)');
  const first = await waitLog(/Catch-up: the whole list \(300 items\)/, 0, 20000);
  check(!!first, `the first catch-up takes the whole list (${first ? first.replace(/^.*Catch-up: /, '') : 'not logged'})`);
  check(asked.some(a => a === 'GET /api/items'), '...asked without a cursor');
  await sleep(1500);
  const m1 = await itemsMetrics();
  const wholeBytes = m1.bytes / Math.max(1, m1.count);

  // 2. A blip: the app is away while 2 texts come for it, 3 are deleted and 1 is pinned.
  let from = logLines().length;
  refusing = true;
  for (const s of [...sockets]) s.destroy();
  check(!!(await waitLog(/Events: (dropped|connect failed)/, from, 10000)), 'the blip: the app loses the server');
  const fresh = [];
  for (const words of ['new while away one', 'new while away two']) fresh.push((await phone('POST', '/api/text', { text: words, to: [pcId] })).data.id);
  const gone = texts.slice(10, 13);
  for (const id of gone) check((await phone('DELETE', `/api/items/${id}`)).status < 300, `deleted ${id} meanwhile`);
  check((await phone('PATCH', `/api/items/${texts[20]}`, { pinned: true })).status === 200, 'pinned one meanwhile');
  await sleep(2000);
  from = logLines().length;
  const askedFrom = asked.length;
  refusing = false;
  check(!!(await waitLog(/Events: connected/, from, 45000)), 'the app is back');
  const delta = await waitLog(/Catch-up: \d+ changed/, from, 20000);
  check(!!delta && /Catch-up: 3 changed, 3 deleted since the last one \(299 items\)/.test(delta),
    `the catch-up after it brings only the changes: 2 new + 1 pinned, 3 deleted, 299 left (${delta ? delta.replace(/^.*Catch-up: /, '') : 'not logged'})`);
  const sinceAsk = asked.slice(askedFrom).find(a => a.startsWith('GET /api/items'));
  check(!!sinceAsk && /^GET \/api\/items\?since=/.test(sinceAsk), `...asked with its cursor (${sinceAsk || 'no request'})`);
  await sleep(1500);
  const m2 = await itemsMetrics();
  const deltaBytes = m2.bytes - m1.bytes;
  console.log(`     GET /api/items: the whole list ${(wholeBytes / 1024).toFixed(1)} KB, the catch-up after the blip ${(deltaBytes / 1024).toFixed(1)} KB (${m2.count - m1.count} request)`);
  check(m2.count - m1.count === 1 && deltaBytes < wholeBytes / 10, 'the catch-up after the blip costs under a tenth of the whole list');
  for (const id of fresh) check(!!(await waitLog(new RegExp(`Received text ${id}`), 0, 10000)), `the new text ${id} is received`);
  let delivered = 0;
  for (let i = 0; i < 50 && delivered < 2; i++) {
    delivered = 0;
    for (const id of fresh) if ((await phone('GET', `/api/items/${id}`)).data?.delivered?.[pcId]) delivered++;
    if (delivered < 2) await sleep(200);
  }
  check(delivered === 2, `...and acknowledged (${delivered}/2 delivered to the PC)`);

  // 3. A server restart: its cursors are gone, so the whole list again (the same count as the delta made).
  from = logLines().length;
  await stopServer();
  await startServer();
  check(!!(await waitLog(/Events: connected/, from, 60000)), 'the server restarted; the app is back');
  const after = await waitLog(/Catch-up: (the whole list|\d+ changed)/, from, 20000);
  check(!!after && /Catch-up: the whole list \(299 items\)/.test(after), `...and its catch-up takes the whole list again, 299 like the delta made (${after ? after.replace(/^.*Catch-up: /, '') : 'not logged'})`);

  // 4. A `refresh` event (devices were linked): the next catch-up takes the whole list.
  await sleep(1500);
  from = logLines().length;
  const askedBefore = asked.length;
  forward(['--test-event', 'refresh', '{}']);
  const refreshed = await waitLog(/Catch-up: the whole list/, from, 20000);
  check(!!refreshed && /\(299 items\)/.test(refreshed), `a refresh event: the whole list (${refreshed ? refreshed.replace(/^.*Catch-up: /, '') : 'not logged'})`);
  check(asked.slice(askedBefore).some(a => a === 'GET /api/items'), '...asked without a cursor');
} catch (e) {
  check(false, `error: ${e.stack || e}`);
} finally {
  await quitApp();
  await stopServer();
  try { proxy?.close(); } catch {}
  for (const s of [...sockets]) s.destroy();
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} } else console.log(`kept ${TMP}`);
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
