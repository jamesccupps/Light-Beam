#!/usr/bin/env node
// Beam for Windows 1.6: the per-install device key. Exits 1 if a check fails.
//
//   node test/perf/windows-devicekey.mjs [--exe <Beam.exe>] [--keep]
//
// Isolated like the other windows-* checks: a scratch server (this checkout's server.js) on 127.0.0.1:8804, reached
// through a small recording proxy on 8854 (it notes each request's path, how it's signed in and whether it carries
// X-Beam-Device-Key, and can answer the stream with 403 device-key), and a copy of Beam.exe with --config in a temp
// folder (quiet, off-screen). Checks: the key is made once and kept DPAPI-protected (never in clear on disk); it goes
// with every request the app signs (API calls, the event stream), never with discovery probes, never in a URL or in
// beam.log, never from the web page (cookie requests); it survives restarts; an unreadable key is replaced (logged);
// and 403 device-key is handled like a revoked sign-in ("This PC's Beam identity doesn't match").
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = 8804, PROXY = 8854;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const exeArg = args.indexOf('--exe');
const EXE = exeArg >= 0 ? args[exeArg + 1] : [path.join(ROOT, 'windows', 'bin', 'Beam.exe'), path.join(ROOT, 'dist', 'Beam.exe')].find(f => fs.existsSync(f));
const KEEP = args.includes('--keep');
const TMP = path.join(os.tmpdir(), `beam-devkey-win-${Date.now()}`);
const failures = [];
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
  return ok;
}
const dir = p => path.join(TMP, p);
for (const d of ['data', 'dist', 'cfg', 'app']) fs.mkdirSync(dir(d), { recursive: true });
const cfgPath = dir('cfg/config.json'), logPath = dir('cfg/beam.log'), keyPath = dir('cfg/device.key'), appExe = dir('app/Beam.exe');
const base = `http://127.0.0.1:${PROXY}`;
const pcId = 'devkeypc' + crypto.randomBytes(8).toString('hex');
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

// The recording proxy.
const seen = [];
const streams = new Set();
let reject = false;
let failLogin = false; // the proxy answers POST /api/login with 500 (a renewal that fails)
function startProxy() {
  proxy = http.createServer((req, res) => {
    const h = req.headers;
    const auth = h.authorization ? 'bearer' : /(^|;\s*)beam_key=/.test(h.cookie || '') ? 'cookie' : 'none';
    seen.push({ path: req.url, auth, key: h['x-beam-device-key'] || null, at: Date.now() });
    const events = req.url.startsWith('/api/events');
    if (failLogin && req.method === 'POST' && /^\/api\/login(\?|$)/.test(req.url)) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'test: the server failed' }));
      return;
    }
    if (reject && events && auth === 'bearer') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'This install\'s device key isn\'t the one this device has', reason: 'device-key' }));
      return;
    }
    const up = http.request({ host: '127.0.0.1', port: PORT, method: req.method, path: req.url, headers: { ...h, host: `127.0.0.1:${PORT}` } }, r => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { try { res.writeHead(502); res.end(); } catch {} });
    req.pipe(up);
    if (events) { streams.add(res); res.on('close', () => { streams.delete(res); up.destroy(); }); }
  });
  return new Promise(r => proxy.listen(PROXY, '127.0.0.1', r));
}

let oldToken = null; // a device token from before 1.6, kept in clear in config.json
function writeConfig() {
  const c = { server: base, key: oldToken || key, deviceId: pcId, deviceName: 'Key Test PC', quiet: true, testOffscreen: true, autoUpdate: false,
    autostartInitialized: true, sendToMenu: false, outbox: false, autoCopy: false, autoSave: false };
  fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2));
}
const appEnv = () => ({ ...process.env, BEAM_LOCAL_URLS: base, BEAM_TEST_PEERS: base });
function startApp() {
  app = spawn(appExe, ['--config', cfgPath, '--background'], { env: appEnv(), windowsHide: true, stdio: 'ignore' });
  appExit = undefined;
  app.on('exit', code => { appExit = code; });
}
const forward = a => spawnSync(appExe, ['--config', cfgPath, ...a], { env: appEnv(), windowsHide: true, timeout: 20000 });
async function quitApp() {
  if (!app || appExit !== undefined) return;
  forward(['--quit']);
  for (let i = 0; i < 80 && appExit === undefined; i++) await sleep(250);
  if (appExit === undefined) { try { app.kill(); } catch {} }
  await sleep(1000);
}
async function runApp(label) {
  const from = logLines().length;
  const since = Date.now();
  startApp();
  if (!(await waitLog(/Events: connected/, from, 30000))) throw new Error(`${label}: the app never connected`);
  await sleep(2500);
  return { from, since };
}
const signed = since => seen.filter(s => s.at >= since && s.auth === 'bearer');
// The app's sign-in, read back from config.json as the app does (DPAPI, this Windows account).
function unsealed(b64) {
  if (!/^[A-Za-z0-9+/=]+$/.test(b64 || '')) return null;
  const ps = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String('${b64}'); $e=[Text.Encoding]::UTF8.GetBytes('Beam config key 1'); ` +
    `[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$e,'CurrentUser'))`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}
// GET /api/me as this PC, with a given token and device key (straight to the server).
async function me(token, deviceKey) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/me`, { headers: { Authorization: `Bearer ${token}`, 'X-Beam-Device-Id': pcId, 'X-Beam-Platform': 'windows', 'X-Beam-Device-Key': deviceKey } });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
const keysOf = since => [...new Set(signed(since).map(s => s.key))];

try {
  if (!EXE) throw new Error('No Beam.exe: build with windows\\build.cmd or pass --exe');
  fs.copyFileSync(EXE, appExe);
  console.log(`Beam: ${EXE}\ntemp: ${TMP}`);
  const out = fs.openSync(dir('server.out.log'), 'a');
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, BEAM_TAILSCALE: 'off', BEAM_HOST: '127.0.0.1', BEAM_PORT: String(PORT), BEAM_DATA: dir('data'), BEAM_DIST: dir('dist') } });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/hello`)).ok) break; } catch {} await sleep(200); }
  key = fs.readFileSync(dir('data/key'), 'utf8').trim();
  await startProxy();
  // A 1.5 install: this PC's own device token (made for the Windows app), in clear in config.json.
  const made = await (await fetch(`http://127.0.0.1:${PORT}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Beam-Platform': 'windows' },
    body: JSON.stringify({ secret: key, client: 'app', platform: 'windows', deviceId: pcId }) })).json();
  oldToken = made.key;
  if (!oldToken || made.you !== pcId) throw new Error('no device token for the test PC');
  writeConfig();
  failLogin = true; // the first start's renewal fails

  // 1. Made on the first run, kept DPAPI-protected; sent with every signed request, the stream included.
  let run = await runApp('first run');
  check(!!(await waitLog(/Made this install's device key/, run.from, 1000)), 'the first run makes the key (logged, without the key)');
  check(fs.existsSync(keyPath), 'device.key is in the config folder');
  const keys1 = keysOf(run.since);
  const k1 = keys1[0];
  check(keys1.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(k1 || ''), `every request the app signs carries one key: 32 bytes, base64url (${signed(run.since).length} requests)`);
  check(signed(run.since).some(s => s.path.startsWith('/api/events')), '...the event stream included');
  const blob = fs.readFileSync(keyPath);
  const raw = Buffer.from(k1.replace(/-/g, '+').replace(/_/g, '/') + '=', 'base64');
  check(raw.length === 32 && !blob.includes(raw) && !blob.includes(Buffer.from(k1)), 'on disk it is DPAPI-protected: neither the key nor its bytes in clear');
  check(seen.filter(s => s.path.startsWith('/api/hello')).every(s => !s.key), 'discovery probes (/api/hello) never carry it');
  let cfgNow = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  check(!cfgNow.key && /^[A-Za-z0-9+/=]{40,}$/.test(cfgNow.keyProtected || '') && !fs.readFileSync(cfgPath, 'utf8').includes(key),
    'the plain sign-in in config.json is replaced by its DPAPI-protected form on the first 1.6 start');
  check(!!(await waitLog(/The saved sign-in is now protected for this Windows account \(DPAPI\)/, run.from, 500)), '...logged without the secret');
  // The first renewal fails (the proxy answers 500): this PC keeps its sign-in and goes on working.
  check(!!(await waitLog(/Sign-in renewal: not now \(.*\); this PC keeps its sign-in and tries again at the next start/, run.from, 15000)), 'a renewal that fails keeps the sign-in (logged; tried again at the next start)');
  check(unsealed(cfgNow.keyProtected) === oldToken && cfgNow.rotateToken === true, '...the sealed token is still the old one, renewal still due');
  check((await me(oldToken, k1)).status === 200, '...and it still works');

  // 2. The chat window's page signs in with the cookie. The host adds the key to its remote control requests only
  // (on the way out: the page never sees it), and the page's other requests go without it.
  const pageSince = Date.now();
  forward(['--test-rc', 'panel:settings']); // the window opens on Settings, which lists who controls which PC (GET /api/rc/sessions)
  await sleep(8000);
  const page = seen.filter(s => s.at >= pageSince && s.auth === 'cookie');
  const pageRc = page.filter(s => s.path.startsWith('/api/rc/'));
  check(page.length > 0 && page.filter(s => !s.path.startsWith('/api/rc/')).every(s => !s.key), `the chat window's page signs in with the cookie; its requests go without the key (${page.length} page requests)`);
  check(pageRc.length > 0 && pageRc.every(s => s.key === k1), `...except remote control ones, which the host gives the key (${pageRc.length} of them)`);

  // 3. A restart keeps it. This time the renewal goes through: a new token for the same device, bound to the key,
  // and the old one (in every copy of the old config) is revoked.
  failLogin = false;
  await quitApp();
  run = await runApp('restart');
  const keys2 = keysOf(run.since);
  check(keys2.length === 1 && keys2[0] === k1, 'after a restart, the same key');
  check(!(await waitLog(/device key couldn't|Made this install's device key/, run.from, 500)), '...and nothing about it in the log');
  check(!(await waitLog(/saved sign-in/, run.from, 200)), '...and the protected sign-in reads back');
  const renewed = await waitLog(/Sign-in renewed: this PC has a new sign-in bound to its device key, and the old one is revoked/, run.from, 20000);
  check(!!renewed, 'the next start renews the sign-in (one log line, no token)');
  cfgNow = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const newToken = unsealed(cfgNow.keyProtected);
  check(!!newToken && newToken !== oldToken && !cfgNow.rotateToken && !cfgNow.revokeKeyProtected, '...config.json holds the new one, sealed; nothing left to do');
  check((await me(oldToken, k1)).status === 401, '...the old token is revoked (401): old config copies and backups hold nothing usable');
  const meNew = await me(newToken, k1);
  check(meNew.status === 200 && meNew.data.you === pcId, '...the new one works, for the same device');
  const rcNew = await fetch(`http://127.0.0.1:${PORT}/api/rc/sessions`, { headers: { Authorization: `Bearer ${newToken}`, 'X-Beam-Device-Id': pcId, 'X-Beam-Device-Key': k1 } });
  check(rcNew.status === 200, `...and it is a key-bound windows token (remote control takes it: ${rcNew.status})`);
  check(!(await waitLog(/Events: connect failed/, run.from, 100)), '...and the app never lost its connection to it');
  await quitApp();
  run = await runApp('after the renewal');
  check(!(await waitLog(/Sign-in renew/, run.from, 3000)), 'once renewed, never again');

  // The viewer window ("Control"): the host adds the key to every /api/ request of its page, on the way out.
  forward(['--test-mode', 'foreground']); // device lists at once
  const peerId = 'devkeypeer' + crypto.randomBytes(8).toString('hex');
  await fetch(`http://127.0.0.1:${PORT}/api/devices`, { headers: { Authorization: `Bearer ${key}`, 'X-Beam-Device-Id': peerId, 'X-Beam-Device': 'Key Test Phone', 'X-Beam-Platform': 'android', 'X-Beam-Profile': 'devkeytest' } });
  await sleep(1500);
  const viewSince = Date.now();
  forward(['--test-open-remote', peerId]);
  check(!!(await waitLog(/Remote control: opened the viewer for Key Test Phone/, run.from, 8000)), 'the viewer window opens');
  await sleep(8000);
  forward(['--test-rc', 'closeviews']);
  await sleep(1000);
  const view = seen.filter(s => s.at >= viewSince && s.auth === 'cookie' && s.path.startsWith('/api/'));
  check(view.length > 0 && view.every(s => s.key === k1), `every /api/ request of the viewer window's page carries the device key (${view.length} requests)`);
  check(view.some(s => s.path.startsWith('/api/rc/')), '...its remote control requests included');

  // 4. An unreadable key (another Windows account, a copied config folder) is replaced, and that's logged.
  await quitApp();
  fs.writeFileSync(keyPath, crypto.randomBytes(178));
  const from = logLines().length;
  const since = Date.now();
  startApp();
  const lost = await waitLog(/device key couldn't be read \(\w+\): made a new one/, from, 15000);
  check(!!lost, `an unreadable key is replaced (${lost ? lost.replace(/.*couldn't be read \(/, '').replace(/\): made.*/, '') : 'not logged'})`);
  const outcome = await waitLog(/Events: connected|Sign-in refused: this install's device key/, from, 30000);
  const keys3 = keysOf(since);
  const k3 = keys3[0];
  check(keys3.length === 1 && k3 !== k1, '...and the new one is sent');

  // 5. 403 device-key: handled like a revoked sign-in. A 1.6 server bound the first key it saw (trust on first use), so
  // it refuses the new one itself; with a server that doesn't bind keys, the proxy answers the stream for it.
  const bound = !!outcome && /Sign-in refused/.test(outcome);
  if (bound) {
    const srv = fs.readFileSync(dir('server.out.log'), 'utf8');
    check(/Key Test PC's Beam app proves itself with its device key from now on/.test(srv), 'the server bound the first key it saw (trust on first use)');
  } else {
    reject = true;
    for (const r of streams) r.destroy(); // the stream drops; its reconnect gets the 403
  }
  check(!!(await waitLog(/Sign-in refused: this install's device key isn't the one the server has for this PC/, from, 20000)),
    `403 device-key${bound ? ' from the server itself' : ' (from the proxy)'}: the app knows its identity was refused`);
  check(!!(await waitLog(/Notification: sign-in needed \(device key\)/, from, 5000)), '...says "This PC\'s Beam identity doesn\'t match. Sign in again"');
  const cfg = await (async () => { for (let i = 0; i < 40; i++) { const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); if (!c.key && !c.keyProtected) return c; await sleep(250); } return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); })();
  check(!cfg.key && !cfg.keyProtected && cfg.server === base, '...and forgets the sign-in as with a revoke (the token goes; the server address stays)');
  reject = false;
  await quitApp();

  // A protected sign-in that can't be read here (a config copied from another account or PC): sign in again.
  const c2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  c2.keyProtected = crypto.randomBytes(200).toString('base64');
  delete c2.key;
  fs.writeFileSync(cfgPath, JSON.stringify(c2, null, 2));
  const from5 = logLines().length;
  startApp();
  check(!!(await waitLog(/The saved sign-in can't be read by this Windows account .*: sign in again/, from5, 15000)), 'a protected sign-in this account can\'t read: the app asks to sign in again');
  await sleep(3000);
  check(!(await waitLog(/Events: connected/, from5, 100)), '...and doesn\'t connect with it');
  await quitApp();

  // 6. Never in a URL, never in beam.log.
  const all = [k1, k3, oldToken, newToken].filter(Boolean);
  check(!seen.some(s => all.some(k => s.path.includes(k))), 'the key never appears in a URL');
  const log = fs.readFileSync(logPath, 'utf8');
  check(!all.some(k => log.includes(k)), 'nor in beam.log');
} catch (e) {
  failures.push(e.message);
  console.log('FAIL ' + (e.stack || e.message));
} finally {
  await quitApp();
  if (app && appExit === undefined) { try { app.kill(); } catch {} }
  if (server) { try { server.kill(); } catch {} }
  if (proxy) { for (const r of streams) { try { r.destroy(); } catch {} } proxy.close(); }
  await sleep(1500);
  if (!KEEP && failures.length === 0) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { console.log('(temp folder kept: ' + e.message + ')'); } }
  else console.log('kept ' + TMP);
  console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nAll device key checks passed.');
  process.exit(failures.length ? 1 : 0);
}
