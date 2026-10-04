#!/usr/bin/env node
// Beam for Windows 1.10: Beam Family in a window of its own (FamilyWindow). Exits 1 if a check fails.
//
//   node test/perf/windows-family.mjs [--exe <Beam.exe>] [--keep]
//
// Isolated like the other windows-* checks: a scratch server (this checkout's server.js) on 127.0.0.1:8801 whose
// BEAM_FAMILY_URL is a fake Beam Family on 127.0.0.1:8851 (this script), and a copy of Beam.exe with --config in a temp
// folder (quiet, off-screen). The fake Family notes every request (path, cookies, sign-in headers), gives its page a
// session cookie, and serves a page that reports what it sees (beamHost, a bridge, its visibility). Checks: the chat
// page's openFamily (the bridge) opens the window on Family's address in a profile of its own (WebView2\Family): neither
// Beam's cookie nor its key reaches Family (the same host as Beam, another port: cookies don't keep to a port), the page
// is told it's in Beam's window and gets no bridge; a second openFamily shows the same page (no reload); minimized, the
// page is hidden (Family then pushes to the other devices), restored, visible; closed, then `Beam.exe --family` opens it
// again with Family's own sign-in kept; a Beam without Family says so; a revoked sign-in closes it and removes its
// profile. Nothing is clicked or typed.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = 8801, FAMILY = 8851;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const exeArg = args.indexOf('--exe');
const EXE = exeArg >= 0 ? args[exeArg + 1] : [path.join(ROOT, 'windows', 'bin', 'Beam.exe'), path.join(ROOT, 'dist', 'Beam.exe')].find(f => fs.existsSync(f));
const KEEP = args.includes('--keep');
const TMP = path.join(os.tmpdir(), `beam-family-win-${Date.now()}`);
const failures = [];
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
  return ok;
}
const dir = p => path.join(TMP, p);
for (const d of ['data', 'dist', 'cfg', 'app']) fs.mkdirSync(dir(d), { recursive: true });
const cfgPath = dir('cfg/config.json'), logPath = dir('cfg/beam.log'), appExe = dir('app/Beam.exe');
const profile = dir('cfg/WebView2/Family');
const base = `http://127.0.0.1:${PORT}`;
const familyUrl = `http://127.0.0.1:${FAMILY}`;
const pcId = 'familypc' + crypto.randomBytes(8).toString('hex');
let server, family, app, appExit, key;

const logLines = () => { try { return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l, i, a) => i < a.length - 1 || l !== ''); } catch { return []; } };
const count = (re, from = 0) => logLines().slice(from).filter(l => re.test(l)).length;
async function waitLog(re, from = 0, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const lines = logLines();
    for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return lines[i];
    await sleep(100);
  }
  return null;
}
async function waitFor(fn, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = fn(); if (v) return v; await sleep(100); }
  return null;
}

// The fake Beam Family: its page, a session cookie, and the page's reports.
const seen = [];     // every request: { path, cookie, auth, beam, at }
const reports = [];  // what the page saw: { what, host, bridge, visible, at }
function startFamily() {
  family = http.createServer((req, res) => {
    const h = req.headers;
    const url = new URL(req.url, familyUrl);
    seen.push({ path: url.pathname, cookie: h.cookie || '', auth: h.authorization || '', beam: Object.keys(h).filter(k => k.startsWith('x-beam-')), at: Date.now() });
    if (url.pathname === '/report') {
      const q = Object.fromEntries(url.searchParams);
      reports.push({ ...q, host: JSON.parse(q.host || 'null'), at: Date.now() });
      res.writeHead(204); res.end();
      return;
    }
    if (url.pathname === '/') {
      // (Family's own sign-in lasts for days: Max-Age, like its real session cookie)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': 'family_session=fam123; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Fake Family</title><body>Fake Family<script>
const report = (what, more = {}) => fetch('/report?' + new URLSearchParams({ what, host: JSON.stringify(window.beamHost || null), visible: document.visibilityState, ...more }));
report('load');
document.addEventListener('visibilitychange', () => report('visibility'));
// What a page would say to Beam's bridge: nobody answers in this window.
let answered = false;
try { window.chrome.webview.addEventListener('message', () => { answered = true; }); window.chrome.webview.postMessage({ type: 'hello', id: 1, bridge: 1 }); } catch (e) {}
setTimeout(() => report('bridge', { answered: String(answered) }), 2000);
</script>`);
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise(r => family.listen(FAMILY, '127.0.0.1', r));
}

async function startServer(withFamily) {
  const out = fs.openSync(dir('server.out.log'), 'a');
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, BEAM_TAILSCALE: 'off', BEAM_HOST: '127.0.0.1', BEAM_PORT: String(PORT), BEAM_DATA: dir('data'), BEAM_DIST: dir('dist'),
      BEAM_FAMILY_URL: withFamily ? familyUrl : '' } });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/api/hello`)).ok) break; } catch {} await sleep(200); }
}
async function stopServer() {
  const s = server;
  if (!s) return;
  s.kill();
  await new Promise(r => { s.once('exit', r); setTimeout(r, 3000); });
}

const appEnv = () => ({ ...process.env, BEAM_LOCAL_URLS: base, BEAM_TEST_PEERS: base });
const forward = a => spawnSync(appExe, ['--config', cfgPath, ...a], { env: appEnv(), windowsHide: true, timeout: 20000 });
const bridge = (id, type = 'openFamily') => forward(['--test-bridge', JSON.stringify({ type, id })]);
const reply = (id, from) => waitLog(new RegExp(`Bridge test reply: .*"id":"${id}"`), from, 10000);
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
  await startFamily();
  await startServer(true);
  key = fs.readFileSync(dir('data/key'), 'utf8').trim();
  const made = await (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Beam-Platform': 'windows' },
    body: JSON.stringify({ secret: key, client: 'app', platform: 'windows', deviceId: pcId }) })).json();
  if (!made.key || made.you !== pcId) throw new Error('no device token for the test PC');
  fs.writeFileSync(cfgPath, JSON.stringify({ server: base, key: made.key, deviceId: pcId, deviceName: 'Family Test PC', quiet: true, testOffscreen: true,
    autoUpdate: false, autostartInitialized: true, sendToMenu: false, outbox: false, autoCopy: false, autoSave: false }, null, 2));
  app = spawn(appExe, ['--config', cfgPath, '--background'], { env: appEnv(), windowsHide: true, stdio: 'ignore' });
  app.on('exit', code => { appExit = code; });
  if (!(await waitLog(/Events: connected/, 0, 30000))) throw new Error('the app never connected');
  await sleep(2500); // (its /api/info: where Family is)

  // 1. The chat page's ♥ (bridge openFamily): the window opens on Family's address, in a profile of its own.
  let from = logLines().length;
  let since = Date.now();
  bridge('test-family-1');
  bridge('test-family-1b'); // (a double click: asked again while its web view is still starting)
  const r1 = await reply('test-family-1', from);
  check(!!r1 && /"ok":true/.test(r1), `openFamily answers ok (${r1 ? r1.replace(/.*Bridge test reply: /, '') : 'no reply'})`);
  check(!!(await waitLog(/Beam Family: opened its window/, from, 5000)), '...and opens the window (logged)');
  const load = await waitFor(() => reports.find(r => r.what === 'load' && r.at >= since), 30000);
  check(!!load, 'Family\'s page loads in it');
  await sleep(2500);
  check(count(/Beam Family: opened its window/, from) === 1 && reports.filter(r => r.what === 'load' && r.at >= since).length === 1,
    `asked twice at once: one window, one page (${reports.filter(r => r.what === 'load' && r.at >= since).length} loaded)`);
  const page = seen.find(s => s.path === '/' && s.at >= since);
  check(!!page && !/beam_key/i.test(page.cookie) && !page.auth && page.beam.length === 0,
    `no Beam sign-in reaches Family: no beam_key cookie (same host, another port), no Authorization, no X-Beam-* (${page ? `cookie "${page.cookie}"` : 'no request'})`);
  check(!!load && load.host && load.host.app === 'windows' && load.host.window === 'family' && !('deviceId' in load.host) && !('server' in load.host),
    `the page is told it's in Beam's Family window, and nothing about Beam (${load ? JSON.stringify(load.host) : '-'})`);
  const quiet = await waitFor(() => reports.find(r => r.what === 'bridge' && r.at >= since), 10000);
  check(!!quiet && quiet.answered === 'false' && count(/Page (info|error):|ignored a message/, from) === 0, `...and has no bridge: a hello from it gets no answer, and the app logs nothing of it (${quiet ? `answered ${quiet.answered}` : 'no report'})`);
  check(!!load && load.visible === 'visible', '...and is visible');
  check(fs.existsSync(profile), 'its profile is WebView2\\Family, apart from the chat window\'s');

  // 2. Asked again: the same window, the same page (no reload).
  from = logLines().length;
  since = Date.now();
  bridge('test-family-2');
  const r2 = await reply('test-family-2', from);
  await sleep(2000);
  check(!!r2 && /"ok":true/.test(r2) && count(/Beam Family: opened its window/, from) === 0 && !seen.some(s => s.path === '/' && s.at >= since),
    'a second openFamily shows the same window without loading the page again');

  // 3. Minimized, the page is hidden (Family pushes to the other devices meanwhile); restored, visible again.
  since = Date.now();
  forward(['--test-family', 'minimize']);
  check(!!(await waitFor(() => reports.find(r => r.what === 'visibility' && r.at >= since && r.visible === 'hidden'), 8000)), 'minimized: the page is hidden');
  since = Date.now();
  forward(['--test-family', 'restore']);
  check(!!(await waitFor(() => reports.find(r => r.what === 'visibility' && r.at >= since && r.visible === 'visible'), 8000)), 'restored: visible again');

  // 4. Closed, then `Beam.exe --family`: open again, Family's own sign-in (its cookie) kept in its profile.
  from = logLines().length;
  forward(['--test-family', 'close']);
  check(!!(await waitLog(/Beam Family: its window closed/, from, 5000)), 'the window closes');
  from = logLines().length;
  since = Date.now();
  forward(['--family']);
  check(!!(await waitLog(/Beam Family: opened its window/, from, 8000)), '`Beam.exe --family` opens it again');
  const again = await waitFor(() => seen.find(s => s.path === '/' && s.at >= since), 30000);
  check(!!again && /family_session=fam123/.test(again.cookie) && !/beam_key/i.test(again.cookie), `...with Family's own cookie kept, still no Beam one (${again ? `"${again.cookie}"` : 'no request'})`);

  // 5. A Beam without Beam Family: the page is told so.
  from = logLines().length;
  await stopServer();
  await startServer(false);
  check(!!(await waitLog(/Events: connected/, from, 45000)), 'Beam\'s server restarted without BEAM_FAMILY_URL');
  await sleep(2500);
  from = logLines().length;
  bridge('test-family-3');
  const r3 = await reply('test-family-3', from);
  check(!!r3 && /"ok":false/.test(r3) && /"code":"unavailable"/.test(r3) && /set up on this Beam server/.test(r3), `...then openFamily says so (${r3 ? r3.replace(/.*Bridge test reply: /, '') : 'no reply'})`);

  // 6. The sign-in revoked: the window closes and its profile goes.
  from = logLines().length;
  await fetch(`${base}/api/devices/${pcId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${key}`, 'X-Beam-Device-Id': 'familypeer' + crypto.randomBytes(6).toString('hex'), 'X-Beam-Platform': 'android' } });
  check(!!(await waitLog(/Sign-in revoked/, from, 30000)), 'the sign-in is revoked');
  check(!!(await waitLog(/Beam Family: its window closed/, from, 5000)), '...the Family window closes');
  const gone = await waitLog(/Beam Family: (removed its window's data|its window's data couldn't be removed yet)/, from, 60000);
  check(!!gone && /removed its window's data/.test(gone) && !fs.existsSync(profile), `...and its profile is removed (${gone ? gone.replace(/.*Beam Family: /, '') : 'nothing logged'})`);
} catch (e) {
  failures.push(e.message);
  console.log('FAIL ' + (e.stack || e.message));
} finally {
  await quitApp();
  if (app && appExit === undefined) { try { app.kill(); } catch {} }
  await stopServer();
  if (family) { family.closeAllConnections?.(); family.close(); }
  const dirWin = TMP.replace(/'/g, "''");
  spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe' or Name='Beam.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dirWin}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { windowsHide: true });
  await sleep(1500);
  if (!KEEP && failures.length === 0) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { console.log('(temp folder kept: ' + e.message + ')'); } }
  else console.log('kept ' + TMP);
  console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nAll Beam Family window checks passed.');
  process.exit(failures.length ? 1 : 0);
}
