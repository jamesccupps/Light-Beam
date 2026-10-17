#!/usr/bin/env node
// Beam for Windows 1.19 (server 1.27): the look. Settings → Appearance sets it for all devices (the server) or for one
// device (its own wins); the chat page draws it and tells the app (bridge `look`), whose own windows, title bars and
// tray icon follow; the app keeps it for its next start. Exits 1 if a check fails.
//
//   node test/perf/windows-look.mjs [--exe <Beam.exe>] [--keep]
//
// Isolated like the other windows-* checks: a scratch server (this checkout's server.js) on 127.0.0.1:8802 and a copy of
// Beam.exe with --config in a temp folder (quiet, off-screen). The look is set through the server's API as another
// device would, and a couple of messages go straight through --test-bridge; nothing is clicked or typed.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = 8802;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const exeArg = args.indexOf('--exe');
const EXE = exeArg >= 0 ? args[exeArg + 1] : [path.join(ROOT, 'windows', 'bin', 'Beam.exe'), path.join(ROOT, 'dist', 'Beam.exe')].find(f => fs.existsSync(f));
const KEEP = args.includes('--keep');
const TMP = path.join(os.tmpdir(), `beam-look-win-${Date.now()}`);
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); return ok; };
const dir = p => path.join(TMP, p);
for (const d of ['data', 'dist', 'app', 'cfg']) fs.mkdirSync(dir(d), { recursive: true });
const base = `http://127.0.0.1:${PORT}`;
const appExe = dir('app/Beam.exe');
const env = { ...process.env, BEAM_LOCAL_URLS: base, BEAM_TEST_PEERS: base };
delete env.BEAM_THEME; // (it would win over the page's look)
let server, app, exited = false;
const logPath = dir('cfg/beam.log');
const cfgPath = dir('cfg/config.json');
const lines = () => { try { return fs.readFileSync(logPath, 'utf8').split(/\r?\n/); } catch { return []; } };
const count = re => lines().filter(x => re.test(x)).length;
async function waitLog(re, ms = 15000) {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(100)) { const l = lines().find(x => re.test(x)); if (l) return l; }
  return null;
}
async function waitCount(re, n, ms = 20000) {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(100)) if (count(re) >= n) return true;
  return false;
}
const forward = a => spawnSync(appExe, ['--config', cfgPath, ...a], { env, windowsHide: true, timeout: 20000 });
const cfg = () => { try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { return {}; } };
// (the app writes its config a moment later, off its UI thread)
async function kept(theme, accent) {
  for (let i = 0; i < 50; i++) { const c = cfg(); if (c.lookTheme === theme && c.lookAccent === accent) return true; await sleep(100); }
  return false;
}
const startApp = () => {
  exited = false;
  app = spawn(appExe, ['--config', cfgPath, '--background'], { env, windowsHide: true, stdio: 'ignore' });
  app.on('exit', () => { exited = true; });
};
async function stopApp() {
  if (!app || exited) return;
  forward(['--quit']);
  for (let i = 0; i < 80 && !exited; i++) await sleep(100);
  if (!exited) { try { app.kill(); } catch {} }
}

try {
  if (!EXE) throw new Error('No Beam.exe: build with windows\\build.cmd or pass --exe');
  fs.copyFileSync(EXE, appExe);
  console.log(`Beam: ${EXE}\ntemp: ${TMP}`);
  const out = fs.openSync(dir('server.out.log'), 'a');
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, BEAM_TAILSCALE: 'off', BEAM_HOST: '127.0.0.1', BEAM_PORT: String(PORT), BEAM_DATA: dir('data'), BEAM_DIST: dir('dist') } });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/api/hello`)).ok) break; } catch {} await sleep(200); }
  const key = fs.readFileSync(dir('data/key'), 'utf8').trim();
  const pcId = `lookpc${crypto.randomBytes(6).toString('hex')}`;
  const made = await (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Beam-Platform': 'windows' },
    body: JSON.stringify({ secret: key, client: 'app', platform: 'windows', deviceId: pcId }) })).json();
  if (!made.key) throw new Error('no device token for the PC');
  fs.writeFileSync(cfgPath, JSON.stringify({ server: base, key: made.key, deviceId: pcId, deviceName: 'Look PC', quiet: true, testOffscreen: true,
    autoUpdate: false, autostartInitialized: true, sendToMenu: false, outbox: false, autoCopy: false, autoSave: false }, null, 2));
  startApp();
  const asKey = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const send = async (h, method, p, body) => (await fetch(base + p, { method, headers: h, body: JSON.stringify(body) })).status;
  await sleep(3000);

  // The look for all devices, set on the server (as from another device): the app follows it through its own stream,
  // with no window open.
  const darkTeal = /Look: dark, accent #0e7c86$/;
  check(await send(asKey, 'PATCH', '/api/settings', { appearance: { theme: 'dark', accent: '#0E7C86' } }) === 200, 'the server takes the look for all devices');
  check(!!(await waitLog(darkTeal, 30000)), 'the app follows (its own stream, no window open): dark, teal');
  check(await kept('dark', '#0e7c86'), `kept in config.json (${cfg().lookTheme}, ${cfg().lookAccent})`);
  // The same look again: nothing new
  await send(asKey, 'PATCH', '/api/settings', { appearance: { theme: 'dark', accent: '#0e7c86' } });
  await sleep(3000);
  check(count(darkTeal) === 1, 'the same look again changes nothing');
  // (A PC's own look, which wins, is the server's and the page's tests: the app re-protects its sign-in at its first
  // start, so this test can't speak as the PC.)
  // Straight through the bridge: not a colour, not a theme → like Windows, Beam's accent, nothing kept
  forward(['--test-bridge', JSON.stringify({ type: 'look', id: 'look-junk', theme: 'sepia', accent: 'red' })]);
  check(!!(await waitLog(/Look: like Windows, Beam's accent$/)), 'an unknown theme or colour: like Windows, Beam\'s accent');
  check(await kept(undefined, undefined), 'and nothing kept');
  forward(['--test-bridge', JSON.stringify({ type: 'look', id: 'look-light', theme: 'light', accent: null })]);
  check(!!(await waitLog(/Look: light, Beam's accent$/)), 'light, Beam\'s accent');
  check(await kept('light', undefined), 'kept');
  // A restart starts in it (and the page soon brings the server's look again)
  await stopApp();
  check(exited, 'quit');
  startApp();
  check(await waitCount(darkTeal, 2, 30000), 'started again; its stream’s hello brings the server’s look back: dark, teal');
} catch (err) {
  check(false, `the run: ${err && err.stack || err}`);
} finally {
  await stopApp();
  if (server) { try { server.kill(); } catch {} }
  await sleep(500);
  if (!KEEP && !failures.length) fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  else console.log(`kept ${TMP}`);
  console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nAll look checks passed.');
  process.exit(failures.length ? 1 : 0);
}
