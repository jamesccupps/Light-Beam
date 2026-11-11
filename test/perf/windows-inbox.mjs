#!/usr/bin/env node
// Beam for Windows 1.26 (server 1.33): the alerts inbox's notifications. An app's alert of priority 3 and up is a
// notification (beam.log names the app, never the alert's words); a quiet one (1-2) and a muted app's aren't; a click
// opens the window on the Alerts list. Exits 1 if a check fails.
//
//   node test/perf/windows-inbox.mjs [--exe <Beam.exe>] [--keep]
//
// Isolated like the other windows-* checks: a scratch server (this checkout's server.js) on 127.0.0.1:8804 and a copy of
// Beam.exe with --config in a temp folder (quiet, off-screen); its window's page is read through WebView2's DevTools
// port (8807). Nothing is clicked or typed.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = 8804, DEVTOOLS = 8807;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const exeArg = args.indexOf('--exe');
const EXE = exeArg >= 0 ? args[exeArg + 1] : [path.join(ROOT, 'windows', 'bin', 'Beam.exe'), path.join(ROOT, 'dist', 'Beam.exe')].find(f => fs.existsSync(f));
const KEEP = args.includes('--keep');
const TMP = path.join(os.tmpdir(), `beam-inbox-win-${Date.now()}`);
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
const pcId = 'inboxtestpc' + crypto.randomBytes(8).toString('hex');
let server, app, appExit, key;

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
async function waitFor(fn, ms = 10000, step = 200) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
}
const OWNER = () => ({ Authorization: `Bearer ${key}`, 'X-Beam-Device-Id': 'inboxtestphone01', 'X-Beam-Device': 'Inbox Test Phone', 'X-Beam-Platform': 'android', 'X-Forwarded-For': '100.64.95.2' });
async function call(method, p, body) {
  const res = await fetch(base + p, { method, headers: { ...OWNER(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const post = (sendKey, body) => fetch(`${base}/notify/`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '100.64.95.9' }, body: JSON.stringify({ topic: sendKey, ...body }) }).then(r => r.status);

const appEnv = () => ({ ...process.env, BEAM_LOCAL_URLS: base, BEAM_TEST_PEERS: base, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEVTOOLS}` });
const forward = a => spawnSync(appExe, ['--config', cfgPath, ...a], { env: appEnv(), windowsHide: true, timeout: 20000 });
async function quitApp() {
  if (!app || appExit !== undefined) return;
  forward(['--quit']);
  for (let i = 0; i < 80 && appExit === undefined; i++) await sleep(250);
  if (appExit === undefined) { try { app.kill(); } catch {} }
  await sleep(1000);
}
async function windowPage() {
  const target = await waitFor(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${DEVTOOLS}/json/list`)).json()).find(x => x.type === 'page' && x.url.startsWith(base)); } catch { return null; }
  }, 30000, 300);
  if (!target) return null;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let n = 0;
  const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const evaluate = expression => new Promise(resolve => {
    const id = ++n;
    pending.set(id, m => resolve(m.result?.result?.value));
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  return { evaluate, close: () => ws.close() };
}

try {
  if (!EXE) throw new Error('No Beam.exe: build with windows\\build.cmd or pass --exe');
  fs.copyFileSync(EXE, appExe);
  console.log(`Beam: ${EXE}\ntemp: ${TMP}`);
  const out = fs.openSync(dir('server.out.log'), 'a');
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, BEAM_TAILSCALE: 'off', BEAM_HOST: '127.0.0.1', BEAM_PORT: String(PORT), BEAM_DATA: dir('data'), BEAM_DIST: dir('dist') } });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/api/hello`)).ok) break; } catch {} await sleep(200); }
  key = fs.readFileSync(dir('data/key'), 'utf8').trim();
  await call('GET', '/api/me');
  const made = await call('POST', '/api/inbox/senders', { name: 'Stock Watcher' });
  check(made.status === 201 && /^bn_/.test(made.data.key || ''), 'an app that sends alerts');
  const sendKey = made.data.key;
  fs.writeFileSync(cfgPath, JSON.stringify({ server: base, key, deviceId: pcId, deviceName: 'Inbox Test PC', quiet: true, testOffscreen: true, autoUpdate: false,
    autostartInitialized: true, sendToMenu: false, outbox: false, autoCopy: false, autoSave: false }, null, 2));
  app = spawn(appExe, ['--config', cfgPath, '--background'], { env: appEnv(), windowsHide: true, stdio: 'ignore' });
  app.on('exit', code => { appExit = code; });
  if (!(await waitLog(/Perf: connected/, 0, 30000))) throw new Error('the app never connected');
  await waitLog(/First sync/, 0, 30000);
  await waitLog(/Switched to a device token/, 0, 5000); // (its stream reconnects with it: an alert meanwhile isn't heard)
  await waitLog(/Events: connected/, logLines().findIndex(l => /Switched to a device token/.test(l)) + 1, 10000);
  const words = ['UniFi U7 Pro', 'Morning check-in', 'muted words', 'click me'];

  // 1. Priority 4: a notification, naming the app only.
  let from = logLines().length;
  check(await post(sendKey, { title: 'Back in stock', message: 'UniFi U7 Pro', priority: 4, tags: ['package'] }) === 200, 'an alert posted the ntfy way');
  check(!!(await waitLog(/Notification: alert from Stock Watcher$/, from, 10000)), 'a notification, its log line naming the app');
  // 2. A quiet one (priority 2) and a muted app's: listed, no notification.
  from = logLines().length;
  await post(sendKey, { message: 'Morning check-in: all quiet', priority: 2 });
  const muted = await call('PATCH', `/api/inbox/senders/${made.data.sender.id}`, { muted: true });
  await post(sendKey, { message: 'muted words', priority: 5 });
  await sleep(2500);
  check(muted.status === 200 && !logLines().slice(from).some(l => /Notification: alert from/.test(l)), 'none for a quiet one or a muted app');
  await call('PATCH', `/api/inbox/senders/${made.data.sender.id}`, { muted: false });
  // 3. A click opens the window on the Alerts list.
  from = logLines().length;
  await post(sendKey, { title: 'Price drop', message: 'click me', priority: 3 });
  check(!!(await waitLog(/Notification: alert from Stock Watcher$/, from, 10000)), 'priority 3: a notification');
  forward(['--test-click-balloon']);
  const win = await windowPage();
  check(!!win, 'the window opened (DevTools)');
  if (win) {
    const open = await waitFor(() => win.evaluate(`typeof inboxOpen === 'function' && inboxOpen() && document.querySelectorAll('#inboxPanel .inbox-alert').length === 4`), 20000, 300);
    check(!!open, `on the Alerts list, all four alerts there${open ? '' : ` (${await win.evaluate(`JSON.stringify({ open: typeof inboxOpen === 'function' && inboxOpen(), trusted: me.trusted, temporary: me.temporary, pending: alertsBox.pendingOpen, has: serverHas('inbox'), loaded: alertsBox.loaded, n: alertsBox.list.length, host: Boolean(HOST), err: alertsBox.error })`)})`}`);
    const titles = await win.evaluate(`[...document.querySelectorAll('#inboxPanel .inbox-title')].map(t => t.textContent)`);
    check(JSON.stringify(titles) === JSON.stringify(['Price drop', '📦 Back in stock']), `the titles (${JSON.stringify(titles)})`);
    win.close();
  }
  const log = fs.readFileSync(logPath, 'utf8');
  check(!words.some(w => log.includes(w)), 'beam.log never has an alert\'s words');
} catch (err) {
  console.log(`FAIL ${err.stack || err}`);
  failures.push(String(err));
} finally {
  await quitApp();
  if (server) { server.kill(); await sleep(500); }
  if (!KEEP) try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}
