#!/usr/bin/env node
// Beam for Windows 1.11.2: the audit's fixes (2026-10-04). Exits 1 if a check fails.
//
//   node test/perf/windows-audit.mjs [--exe <Beam.exe>] [--keep]
//
// Isolated like the other windows-* checks: a scratch server (this checkout's server.js) on 127.0.0.1:8804 and a copy of
// Beam.exe with --config in a temp folder (quiet, off-screen; its clipboard is a file there). Checks:
// - X-2: a text edited after it arrived: Copy in the chat window (the bridge's copyText) and "Copy latest received
//   text" copy the new words, not the old ones;
// - X-3: two devices called "Laptop" and one called "All devices" get outbox folders of their own (the end of their id
//   added), "To Laptop" isn't made, and a file dropped in one goes to that device only;
// - B-12: another PC's settings backup doesn't bring a folder this PC doesn't have.
// Nothing is clicked or typed.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = 8804;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const exeArg = args.indexOf('--exe');
const EXE = exeArg >= 0 ? args[exeArg + 1] : [path.join(ROOT, 'windows', 'bin', 'Beam.exe'), path.join(ROOT, 'dist', 'Beam.exe')].find(f => fs.existsSync(f));
const KEEP = args.includes('--keep');
const TMP = path.join(os.tmpdir(), `beam-audit-win-${Date.now()}`);
const failures = [];
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
  return ok;
}
const dir = p => path.join(TMP, p);
for (const d of ['data', 'dist', 'cfg', 'app', 'outbox', 'saves']) fs.mkdirSync(dir(d), { recursive: true });
const cfgPath = dir('cfg/config.json'), logPath = dir('cfg/beam.log'), appExe = dir('app/Beam.exe'), clipFile = dir('cfg/clipboard.txt');
const base = `http://127.0.0.1:${PORT}`;
const pcId = 'auditpc' + crypto.randomBytes(8).toString('hex');
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
async function waitFor(fn, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await fn(); if (v) return v; await sleep(150); }
  return null;
}
const clip = () => { try { return fs.readFileSync(clipFile, 'utf8'); } catch { return null; } };

// Other devices: each from a machine of its own (an address of its own), as the server tells machines apart.
const device = (id, name, platform, ip, extra = {}) => (method, p, body) => fetch(base + p, { method, body: body ? JSON.stringify(body) : undefined,
  headers: { Authorization: `Bearer ${key}`, 'X-Beam-Device-Id': id, 'X-Beam-Device': encodeURIComponent(name), 'X-Beam-Platform': platform,
    'X-Forwarded-For': ip, ...extra, ...(body ? { 'Content-Type': 'application/json' } : {}) } })
  .then(async r => ({ status: r.status, data: await r.json().catch(() => null) }));
const phone = device('auditphone' + crypto.randomBytes(4).toString('hex'), 'Audit Phone', 'android', '100.64.81.1');

const forward = a => spawnSync(appExe, ['--config', cfgPath, ...a], { env: { ...process.env, BEAM_LOCAL_URLS: base, BEAM_TEST_PEERS: base }, windowsHide: true, timeout: 20000 });
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
  const out = fs.openSync(dir('server.out.log'), 'a');
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, BEAM_TAILSCALE: 'off', BEAM_HOST: '127.0.0.1', BEAM_PORT: String(PORT), BEAM_DATA: dir('data'), BEAM_DIST: dir('dist') } });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/api/hello`)).ok) break; } catch {} await sleep(200); }
  key = fs.readFileSync(dir('data/key'), 'utf8').trim();
  await phone('GET', '/api/me');
  // X-3's devices: two "Laptop"s and an "All devices", on machines of their own
  const laptops = ['auditlap1' + crypto.randomBytes(4).toString('hex'), 'auditlap2' + crypto.randomBytes(4).toString('hex')];
  await device(laptops[0], 'Laptop', 'windows', '100.64.81.2', { 'X-Beam-Profile': '1111111111111111' })('GET', '/api/me');
  await device(laptops[1], 'Laptop', 'windows', '100.64.81.3', { 'X-Beam-Profile': '2222222222222222' })('GET', '/api/me');
  const allNamed = 'auditall' + crypto.randomBytes(4).toString('hex');
  await device(allNamed, 'All devices', 'android', '100.64.81.4')('GET', '/api/me');
  // B-12's other PC: a settings backup with a folder this PC doesn't have
  const otherPc = device('auditother' + crypto.randomBytes(4).toString('hex'), 'Other PC', 'windows', '100.64.81.5', { 'X-Beam-Profile': '3333333333333333', 'X-Beam-App-Version': '1.11.2' });
  const put = await otherPc('PUT', '/api/devices/me/backup', { install: 'inst-other-0001', app: 'windows', version: '1.11.2', settings: { saveFolder: 'Q:\\No such drive\\Beam', autoCopy: false } });
  check(put.status === 204, `another PC's settings backup is on the server (${put.status})`);

  const made = await (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Beam-Platform': 'windows' },
    body: JSON.stringify({ secret: key, client: 'app', platform: 'windows', deviceId: pcId }) })).json();
  if (!made.key || made.you !== pcId) throw new Error('no device token for the test PC');
  fs.writeFileSync(cfgPath, JSON.stringify({ server: base, key: made.key, deviceId: pcId, deviceName: 'Audit Test PC', quiet: true, testOffscreen: true,
    autoUpdate: false, autostartInitialized: true, sendToMenu: false, outbox: true, outboxFolder: dir('outbox'), saveFolder: dir('saves'),
    autoCopy: false, autoSave: false, restoreChecked: true }, null, 2));
  app = spawn(appExe, ['--config', cfgPath, '--background'], { env: { ...process.env, BEAM_LOCAL_URLS: base, BEAM_TEST_PEERS: base }, windowsHide: true, stdio: 'ignore' });
  app.on('exit', code => { appExit = code; });
  check(!!(await waitLog(/Events: connected/, 0, 30000)), 'the app connects');
  await waitLog(/Catch-up: the whole list/, 0, 15000);
  await waitLog(/Sign-in renewed/, 0, 10000); // (its first start swaps its sign-in, and the stream reconnects)
  await sleep(1500);

  // X-2: a text arrives, then its sender fixes a word
  const sent = await phone('POST', '/api/text', { text: 'the old words', to: [pcId] });
  check(!!(await waitLog(new RegExp(`Received text ${sent.data.id}`), 0, 15000)), 'the text arrives');
  const edit = await phone('PATCH', `/api/items/${sent.data.id}`, { text: 'the new words' });
  check(edit.status === 200, `the sender edits it (${edit.status})`);
  // (a background stream holds an `update` until its heartbeat: a poke brings what it held)
  let from = logLines().length;
  forward(['--test-poke']);
  check(!!(await waitLog(/Events: the stream is fine after/, from, 10000)), 'the stream is poked (what it held comes now)');
  await sleep(500);
  from = logLines().length;
  forward(['--test-bridge', JSON.stringify({ type: 'copyText', id: 'audit-copy-1', itemId: sent.data.id })]);
  await waitLog(/Bridge test reply: .*audit-copy-1/, from, 10000);
  check(clip() === 'the new words', `Copy in the chat window copies the new words (clipboard: ${JSON.stringify(clip())})`);
  fs.rmSync(clipFile, { force: true });
  forward(['--copy-latest']);
  await waitFor(() => clip(), 8000);
  check(clip() === 'the new words', `"Copy latest received text" too (clipboard: ${JSON.stringify(clip())})`);

  // X-3: a folder per device, never one shared by two
  const folders = await waitFor(() => {
    const names = fs.readdirSync(dir('outbox')).filter(n => n.startsWith('To '));
    return names.length >= 4 ? names : null;
  }, 15000) || fs.readdirSync(dir('outbox'));
  const tail = id => id.slice(-6);
  const want = [`To Laptop (${tail(laptops[0])})`, `To Laptop (${tail(laptops[1])})`, `To All devices (${tail(allNamed)})`, 'To All devices'];
  check(want.every(n => folders.includes(n)) && !folders.includes('To Laptop'), `outbox folders: ${JSON.stringify(folders.sort())}`);
  fs.writeFileSync(path.join(dir('outbox'), want[0], 'for-laptop-one.txt'), 'from the outbox');
  const item = await waitFor(async () => (await phone('GET', '/api/items')).data?.items?.find(i => i.name === 'for-laptop-one.txt'), 20000);
  check(!!item && item.to.length === 1 && item.to[0] === laptops[0], `the file went to that Laptop only (${item ? JSON.stringify(item.to) : 'not sent'})`);

  // B-12: another PC's backup: its folder isn't here, so this PC keeps its own
  from = logLines().length;
  forward(['--test-backups', 'choices']);
  await sleep(2500);
  forward(['--test-backups', 'state']);
  const state = await waitLog(/Settings: \(test\) /, from, 8000);
  console.log(`     ${state ? state.replace(/^.*Settings: \(test\) /, '') : 'no state'}`);
  forward(['--test-backups', 'answer:restore']);
  const kept = await waitLog(/Settings backup: kept this PC's saveFolder \(Q:\\No such drive\\Beam isn't here\)/, from, 10000);
  check(!!kept, "restoring another PC's settings keeps this PC's save folder");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  check(cfg.saveFolder === dir('saves'), `...in its settings (${cfg.saveFolder})`);
} catch (e) {
  check(false, `error: ${e.stack || e}`);
} finally {
  await quitApp();
  try { server?.kill(); } catch {}
  await sleep(500);
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} } else console.log(`kept ${TMP}`);
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
