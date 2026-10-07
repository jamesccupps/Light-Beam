#!/usr/bin/env node
// Beam for Windows 1.13 (server 1.18): the PC's history. The app reads Windows' records of restarts, power losses and
// sign-ins and sends them when it connects; the server explains them. Exits 1 if a check fails.
//
//   node test/perf/windows-history.mjs [--exe <Beam.exe>] [--keep]
//
// Isolated like the other windows-* checks: a scratch server (this checkout's server.js) on 127.0.0.1:8802 and copies
// of Beam.exe with --config in a temp folder (quiet, off-screen). Two PCs:
// - "Test PC A" gets made-up records from a file (config testHistoryEvents): a Windows Update restart, then a power
//   loss; the server must explain them, alert once, and a second report adds nothing;
// - "Test PC B" reads this PC's real System log (read-only, as any app may): what it sends must make sense to the
//   server (at least one start of Windows explained); then it's asked for a speed test (1.18), as another device's
//   Settings → Connections → Test speed does, and must answer with what it measured. Nothing is clicked or typed.
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
const TMP = path.join(os.tmpdir(), `beam-history-win-${Date.now()}`);
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); return ok; };
const dir = p => path.join(TMP, p);
for (const d of ['data', 'dist', 'app']) fs.mkdirSync(dir(d), { recursive: true });
const base = `http://127.0.0.1:${PORT}`;
const appExe = dir('app/Beam.exe');
const env = { ...process.env, BEAM_LOCAL_URLS: base, BEAM_TEST_PEERS: base };
let server, key;

async function startServer() {
  const out = fs.openSync(dir('server.out.log'), 'a');
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, BEAM_TAILSCALE: 'off', BEAM_HOST: '127.0.0.1', BEAM_PORT: String(PORT), BEAM_DATA: dir('data'), BEAM_DIST: dir('dist') } });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/api/hello`)).ok) break; } catch {} await sleep(200); }
}

const owner = p => fetch(base + p, { headers: { Authorization: `Bearer ${key}` } }).then(r => r.json());

// A PC: its config (signed in with its own token) and a running app; logs in cfg-<name>/beam.log.
async function startPc(name, extra) {
  const id = `histpc${name.toLowerCase()}${crypto.randomBytes(6).toString('hex')}`;
  const made = await (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Beam-Platform': 'windows' },
    body: JSON.stringify({ secret: key, client: 'app', platform: 'windows', deviceId: id }) })).json();
  if (!made.key || made.you !== id) throw new Error(`no device token for ${name}`);
  const cfgDir = dir(`cfg-${name}`);
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ server: base, key: made.key, deviceId: id, deviceName: `Test PC ${name}`, quiet: true, testOffscreen: true,
    autoUpdate: false, autostartInitialized: true, sendToMenu: false, outbox: false, autoCopy: false, autoSave: false, ...extra }, null, 2));
  const app = spawn(appExe, ['--config', cfgPath, '--background'], { env, windowsHide: true, stdio: 'ignore' });
  let exited = false;
  app.on('exit', () => { exited = true; });
  const logPath = path.join(cfgDir, 'beam.log');
  const lines = () => { try { return fs.readFileSync(logPath, 'utf8').split(/\r?\n/); } catch { return []; } };
  return {
    id, lines,
    async waitLog(re, ms = 30000) {
      for (const until = Date.now() + ms; Date.now() < until; await sleep(100)) { const l = lines().find(x => re.test(x)); if (l) return l; }
      return null;
    },
    forward: a => spawnSync(appExe, ['--config', cfgPath, ...a], { env, windowsHide: true, timeout: 20000 }),
    async quit() {
      spawnSync(appExe, ['--config', cfgPath, '--quit'], { env, windowsHide: true, timeout: 20000 });
      for (let i = 0; i < 80 && !exited; i++) await sleep(250);
      if (!exited) { try { app.kill(); } catch {} }
    },
  };
}

// Made-up records, as the app reads them: a Windows Update restart a day ago, a power loss an hour ago.
const rec = (provider, id, at, data) => ({ log: 'System', id, provider, time: new Date(at).toISOString(), rec: Math.floor(at / 1000) % 1e7 + id, data });
const now = Date.now();
const upd = now - 24 * 3600e3;
const lost = now - 3600e3;
const FAKE = [
  rec('User32', 1074, upd, ['C:\\Windows\\servicing\\TrustedInstaller.exe (TEST-PC)', 'TEST-PC', 'Operating System: Upgrade (Planned)', '0x80020003', 'restart', '', 'NT AUTHORITY\\SYSTEM']),
  rec('Microsoft-Windows-Kernel-General', 13, upd + 60e3, [new Date(upd + 60e3).toISOString()]),
  rec('Microsoft-Windows-Kernel-General', 12, upd + 90e3, ['10', '0', '0', '0', '0', '0', new Date(upd + 90e3).toISOString()]),
  rec('Microsoft-Windows-Kernel-General', 12, lost, ['10', '0', '0', '0', '0', '0', new Date(lost).toISOString()]),
  rec('Microsoft-Windows-Kernel-Power', 41, lost + 3000, ['0', '0', '0', '0', '0', '0', '0']),
  rec('Microsoft-Windows-Winlogon', 7001, lost + 120e3, ['1', 'S-1-5-21-1-1-1-1001']),
];

try {
  if (!EXE) throw new Error('No Beam.exe: build with windows\\build.cmd or pass --exe');
  fs.copyFileSync(EXE, appExe);
  console.log(`Beam: ${EXE}\ntemp: ${TMP}`);
  await startServer();
  key = fs.readFileSync(dir('data/key'), 'utf8').trim();

  // A: made-up records from a file
  const fakeFile = dir('fake-records.json');
  fs.writeFileSync(fakeFile, JSON.stringify(FAKE));
  const a = await startPc('A', { testHistoryEvents: fakeFile });
  check(!!(await a.waitLog(/Events: connected/)), 'A connects');
  const sent = await a.waitLog(/History: sent \d+ new record/);
  check(!!sent && /sent 6 new record\(s\).*\(6 read, from the test file\)/.test(sent), `A sends its 6 records when it connects (${sent ? sent.replace(/^.*History: /, '') : 'not logged'})`);
  let h = await owner(`/api/devices/${a.id}/history`);
  check(JSON.stringify(h.entries?.map(e => e.kind)) === '["power-loss","restart"]', `the server explains them: a power loss, then a Windows Update restart (${JSON.stringify(h.entries?.map(e => [e.kind, e.text]))})`);
  check(h.entries?.[1]?.text === 'Restarted for a Windows update' && h.entries?.[0]?.signedIn === lost + 120e3, '...who asked, and when someone signed in after');
  const alerts = (await owner('/api/alerts')).alerts.filter(x => x.kind === 'powerLoss' && x.device === a.id);
  check(alerts.length === 1 && /^Test PC A went down without warning \(it lost power or froze\) and started again at /.test(alerts[0].text), `one alert (${alerts[0]?.text || 'none'})`);
  a.forward(['--test-history', 'send']);
  const again = await a.waitLog(/History: nothing new/, 15000);
  check(!!again, 'sent again: nothing new');
  check((await owner('/api/alerts')).alerts.filter(x => x.kind === 'powerLoss' && x.device === a.id).length === 1, '...and no second alert');
  await a.quit();

  // B: this PC's real records (read-only)
  const b = await startPc('B', {});
  check(!!(await b.waitLog(/Events: connected/)), 'B connects');
  const real = await b.waitLog(/History: (sent \d+ new record|nothing new|not sent)/);
  check(!!real && /History: sent \d+ new record\(s\)/.test(real), `B reads this PC's own records and sends them (${real ? real.replace(/^.*History: /, '') : 'not logged'})`);
  h = await owner(`/api/devices/${b.id}/history`);
  const starts = (h.entries || []).filter(e => e.up);
  check(starts.length >= 1 && !!h.up?.since, `...and the server explains them: ${starts.length} start(s) of Windows in 30 days, up since ${h.up ? new Date(h.up.since).toLocaleString() : '?'} (${h.up?.text || ''})`);
  console.log(`     newest: ${starts.slice(0, 3).map(e => `${new Date(e.at).toLocaleString()} ${e.text}`).join(' | ')}`);
  b.forward(['--test-history', 'read']);
  const read = await b.waitLog(/History: \(test\) Windows' logs give/, 15000);
  check(!!read && /Microsoft-Windows-Kernel-General 12 x\d+/.test(read), `the read path names what it found (${read ? read.replace(/^.*give /, '') : 'not logged'})`);

  // A speed test when asked (Settings → Connections → Test speed on another device): the app tests and answers.
  // (its first connection drops for a moment while its sign-in is renewed: wait until it's back)
  for (let i = 0; i < 100 && !(await owner('/api/devices')).devices.find(d => d.id === b.id)?.online; i++) await sleep(150);
  const t0 = Date.now();
  const asked = await fetch(`${base}/api/connections/${b.id}/speed`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: '{}' });
  const answer = await asked.json().catch(() => null);
  check(asked.status === 200 && answer?.speed?.down > 0 && answer?.speed?.up > 0,
    `B runs a speed test when asked: ${answer?.speed ? `${answer.speed.down} Mbit/s down, ${answer.speed.up} up` : JSON.stringify(answer)} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  check(!!(await b.waitLog(/Speed test \(another device asked\): [\d.]+ Mbit\/s down, [\d.]+ Mbit\/s up/, 5000)), '...and logs it');
  await b.quit();
} catch (err) {
  failures.push(err.message);
  console.log(`FAIL ${err.message}`);
} finally {
  if (server) { server.kill(); await new Promise(r => { server.once('exit', r); setTimeout(r, 3000); }); }
  if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true });
  else console.log(`kept: ${TMP}`);
}
console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
process.exit(failures.length ? 1 : 0);
