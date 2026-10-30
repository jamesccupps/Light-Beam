#!/usr/bin/env node
// Beam for Windows 1.21.3: a text that comes while this PC is locked (the PCs' logs of October: Windows refused every
// one of them the clipboard) is copied once the PC is unlocked, the newest of them. Exits 1 if a check fails.
//
//   node test/perf/windows-locked.mjs [--exe <Beam.exe>] [--keep]
//
// Isolated like the other windows-* checks: a scratch server (this checkout's server.js) on 127.0.0.1:8812 and a copy of
// Beam.exe with --config in a temp folder (quiet, off-screen; its clipboard is a file there). The lock is the test one
// (--test-rc lock:on|off, as Windows' WTS_SESSION_LOCK/UNLOCK). Nothing is clicked or typed.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = 8812;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const exeArg = args.indexOf('--exe');
const EXE = exeArg >= 0 ? args[exeArg + 1] : [path.join(ROOT, 'windows', 'bin', 'Beam.exe'), path.join(ROOT, 'dist', 'Beam.exe')].find(f => fs.existsSync(f));
const KEEP = args.includes('--keep');
const TMP = path.join(os.tmpdir(), `beam-locked-win-${Date.now()}`);
const failures = [];
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
  return ok;
}
const dir = p => path.join(TMP, p);
for (const d of ['data', 'dist', 'cfg', 'app', 'saves']) fs.mkdirSync(dir(d), { recursive: true });
const cfgPath = dir('cfg/config.json'), logPath = dir('cfg/beam.log'), appExe = dir('app/Beam.exe'), clipFile = dir('cfg/clipboard.txt');
const base = `http://127.0.0.1:${PORT}`;
const pcId = 'lockedpc' + crypto.randomBytes(8).toString('hex');
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
const clip = () => { try { return fs.readFileSync(clipFile, 'utf8'); } catch { return null; } };

const phone = (method, p, body) => fetch(base + p, { method, body: body ? JSON.stringify(body) : undefined,
  headers: { Authorization: `Bearer ${key}`, 'X-Beam-Device-Id': 'lockedphone0001', 'X-Beam-Device': 'Locked Test Phone', 'X-Beam-Platform': 'android',
    'X-Forwarded-For': '100.64.82.1', ...(body ? { 'Content-Type': 'application/json' } : {}) } })
  .then(async r => ({ status: r.status, data: await r.json().catch(() => null) }));

const forward = a => spawnSync(appExe, ['--config', cfgPath, ...a], { env: { ...process.env, BEAM_LOCAL_URLS: base, BEAM_TEST_PEERS: base }, windowsHide: true, timeout: 20000 });
async function quitApp() {
  if (!app || appExit !== undefined) return;
  forward(['--quit']);
  for (let i = 0; i < 80 && appExit === undefined; i++) await sleep(250);
  if (appExit === undefined) { try { app.kill(); } catch {} }
  await sleep(1000);
}
async function sendText(text) {
  const from = logLines().length;
  const sent = await phone('POST', '/api/text', { text, to: [pcId] });
  return { id: sent.data?.id, line: sent.data?.id ? await waitLog(new RegExp(`Received text ${sent.data.id}`), from, 15000) : null };
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
  await phone('GET', '/api/me');
  const made = await (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Beam-Platform': 'windows' },
    body: JSON.stringify({ secret: key, client: 'app', platform: 'windows', deviceId: pcId }) })).json();
  if (!made.key || made.you !== pcId) throw new Error('no device token for the test PC');
  fs.writeFileSync(cfgPath, JSON.stringify({ server: base, key: made.key, deviceId: pcId, deviceName: 'Locked Test PC', quiet: true, testOffscreen: true,
    autoUpdate: false, autostartInitialized: true, sendToMenu: false, saveFolder: dir('saves'), autoCopy: true, clipboardHistory: false,
    autoSave: false, restoreChecked: true }, null, 2));
  app = spawn(appExe, ['--config', cfgPath, '--background'], { env: { ...process.env, BEAM_LOCAL_URLS: base, BEAM_TEST_PEERS: base }, windowsHide: true, stdio: 'ignore' });
  app.on('exit', code => { appExit = code; });
  check(!!(await waitLog(/Events: connected/, 0, 30000)), 'the app connects');
  await waitLog(/Catch-up: the whole list/, 0, 15000);
  await waitLog(/Sign-in renewed/, 0, 10000); // (its first start swaps its sign-in, and the stream reconnects)
  await sleep(1500);

  // Unlocked: copied at once, as before
  let t = await sendText('while unlocked');
  check(/\(copied\)$/.test(t.line || '') && clip() === 'while unlocked', `a text while unlocked is copied at once (${t.line ? t.line.replace(/^.*Received/, 'Received') : 'not received'}; clipboard ${JSON.stringify(clip())})`);

  // Locked: kept, the newest wins
  let from = logLines().length;
  forward(['--test-rc', 'lock:on']);
  check(!!(await waitLog(/\(test\) session locked/, from, 10000)), 'the PC is locked (test)');
  const first = await sendText('first while locked');
  const second = await sendText('second while locked');
  check(/\(copied once this PC is unlocked\)$/.test(first.line || '') && /\(copied once this PC is unlocked\)$/.test(second.line || ''),
    `texts while locked wait for the unlock (${[first.line, second.line].map(l => l ? l.replace(/^.*\(/, '(') : 'not received').join(', ')})`);
  check(clip() === 'while unlocked', `...nothing is put on the clipboard meanwhile (${JSON.stringify(clip())})`);
  from = logLines().length;
  forward(['--test-rc', 'lock:off']);
  const copied = await waitLog(/Copied text \S+ \(it came while this PC was locked\)/, from, 10000);
  check(!!copied && copied.includes(second.id), `unlocked: the newest one is copied (${copied ? copied.replace(/^.*Copied/, 'Copied') : 'not logged'})`);
  check(clip() === 'second while locked', `...and is on the clipboard (${JSON.stringify(clip())})`);

  // Only once: a later lock and unlock with nothing new copies nothing
  fs.writeFileSync(clipFile, 'the user copied this');
  from = logLines().length;
  forward(['--test-rc', 'lock:on']);
  await waitLog(/\(test\) session locked/, from, 10000);
  forward(['--test-rc', 'lock:off']);
  await waitLog(/\(test\) session unlocked/, from, 10000);
  await sleep(1500);
  check(clip() === 'the user copied this' && !logLines().slice(from).some(l => /Copied text/.test(l)), `a later unlock with nothing new leaves the clipboard alone (${JSON.stringify(clip())})`);

  check(!logLines().some(l => /Clipboard: |Task: /.test(l)), 'no clipboard or task errors in the log');
} catch (err) {
  check(false, `error: ${err.stack || err.message}`);
} finally {
  await quitApp();
  if (server) { try { server.kill(); } catch {} }
  await sleep(500);
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} } else console.log(`kept: ${TMP}`);
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall ok');
process.exit(failures.length ? 1 : 0);
