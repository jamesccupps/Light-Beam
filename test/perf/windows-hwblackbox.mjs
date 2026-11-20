#!/usr/bin/env node
// Beam for Windows 1.27 (server 1.35): HW Blackbox on a PC's page. Where HW Blackbox (the user's hardware monitor)
// runs, the PC's app reads its dashboard on 127.0.0.1 and sends a summary with its status: its version, the Diagnose
// findings that aren't fine (most serious first), the last power-off with the power supply's last readings. A program
// on that port that isn't HW Blackbox gives nothing; (1.27.1) a dashboard that isn't up yet at the connect is looked for
// every minute, and its report goes out as soon as it answers. Exits 1 if a check fails.
//
//   node test/perf/windows-hwblackbox.mjs [--exe <Beam.exe>] [--keep]
//
// Isolated like the other windows-* checks: a scratch server (this checkout's server.js) on 127.0.0.1:8806, a stand-in
// dashboard on 8807 (never the real HW Blackbox: a test instance reads only `testHwbUrl`), and copies of Beam.exe with
// --config in a temp folder (quiet, off-screen).
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = 8806, DASH = 8807, LATE = 8808;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const exeArg = args.indexOf('--exe');
const EXE = exeArg >= 0 ? args[exeArg + 1] : [path.join(ROOT, 'windows', 'bin', 'Beam.exe'), path.join(ROOT, 'dist', 'Beam.exe')].find(f => fs.existsSync(f));
const KEEP = args.includes('--keep');
const TMP = path.join(os.tmpdir(), `beam-hwb-win-${Date.now()}`);
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); return ok; };
const dir = p => path.join(TMP, p);
for (const d of ['data', 'dist', 'app']) fs.mkdirSync(dir(d), { recursive: true });
const base = `http://127.0.0.1:${PORT}`;
const appExe = dir('app/Beam.exe');
const env = { ...process.env, BEAM_LOCAL_URLS: base, BEAM_TEST_PEERS: base };
let server, key, dash;

// The stand-in dashboard: HW Blackbox 1.1.3's answers (or another program's, `who`)
let who = 'hw-blackbox-dashboard';
const asked = [];
const diagnose = {
  at: Date.now() / 1000 - 30,
  counts: { bad: 1, warn: 1, info: 1, ok: 3 },
  checks: [
    { id: 'uptime', title: 'Uptime', level: 'ok', summary: 'Up for 3 days' },
    { id: 'busy:node.exe', title: 'node.exe kept the CPU busy', level: 'info', summary: 'A core flat out for 20 h 35 min' },
    { id: 'power', title: 'Power-offs', level: 'warn', summary: '1 in the last 30 days', advice: ['…'] },
    { id: 'drives', title: 'Drives', level: 'ok', summary: '3 drives, all healthy' },
    { id: 'problems', title: 'Problems right now', level: 'bad', summary: `Port 25565 is held by 2 programs\u0007 ${'x'.repeat(400)}` },
    { id: 'disk', title: 'Space on C:', level: 'ok', summary: '61 GB free of 465 GB' },
  ],
};
const overview = {
  version: '1.1.3',
  power_offs: [
    { report: 'incident_20261007_021512.txt', boot: '2026-10-07T02:15:12', went_down: '2026-10-07T02:14:58.697', last_rails: { v12_v: 12.168 } },
    { report: 'incident_20261110_190000.txt', boot: '2026-11-10T19:00:00-05:00', went_down: '2026-11-10T18:59:50.500-05:00', why: 'It lost power, or froze',
      last_rails: { v12_v: 12.168, v5_v: 5.07, v33_v: 3.346, vcore_v: 1.452 } },
  ],
};

async function startDash(port = DASH) {
  const server = http.createServer((req, res) => {
    asked.push(`${req.method} ${req.url} ${req.headers.host}`);
    const body = req.url === '/api/ping' ? { app: who, version: '1.1.3', pid: 1, user: 'robin' } : req.url === '/api/diagnose' ? diagnose : req.url === '/api/overview' ? overview : null;
    if (!body) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return server;
}

async function startServer() {
  const out = fs.openSync(dir('server.out.log'), 'a');
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, BEAM_TAILSCALE: 'off', BEAM_HOST: '127.0.0.1', BEAM_PORT: String(PORT), BEAM_DATA: dir('data'), BEAM_DIST: dir('dist'), BEAM_TEST_TIMEOUTS: '1' } });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/api/hello`)).ok) break; } catch {} await sleep(200); }
}

const H = () => ({ Authorization: `Bearer ${key}`, 'X-Beam-Device-Id': 'hwbowner001', 'X-Beam-Device': 'Owner', 'X-Beam-Platform': 'web', 'X-Forwarded-For': '100.64.31.9' });
const statusOf = async id => (await (await fetch(`${base}/api/devices`, { headers: H() })).json()).devices.find(d => d.id === id)?.status;

async function startPc(name, extra) {
  const id = `hwbpc${crypto.randomBytes(6).toString('hex')}`;
  const made = await (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Beam-Platform': 'windows' },
    body: JSON.stringify({ secret: key, client: 'app', platform: 'windows', deviceId: id }) })).json();
  if (!made.key || made.you !== id) throw new Error('no device token');
  const cfgDir = dir(name);
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ server: base, key: made.key, deviceId: id, deviceName: name, quiet: true, testOffscreen: true,
    autoUpdate: false, autostartInitialized: true, sendToMenu: false, outbox: false, autoCopy: false, autoSave: false, ...extra }, null, 2));
  const app = spawn(appExe, ['--config', cfgPath, '--background'], { env, windowsHide: true, stdio: 'ignore' });
  let exited = false;
  app.on('exit', () => { exited = true; });
  const lines = () => { try { return fs.readFileSync(path.join(cfgDir, 'beam.log'), 'utf8').split(/\r?\n/); } catch { return []; } };
  return {
    id, lines,
    async waitLog(re, ms = 30000) {
      for (const until = Date.now() + ms; Date.now() < until; await sleep(100)) { const l = lines().find(x => re.test(x)); if (l) return l; }
      return null;
    },
    async quit() {
      spawnSync(appExe, ['--config', cfgPath, '--quit'], { env, windowsHide: true, timeout: 20000 });
      for (let i = 0; i < 80 && !exited; i++) await sleep(250);
      if (!exited) { try { app.kill(); } catch {} }
    },
  };
}

try {
  if (!EXE) throw new Error('No Beam.exe: build with windows\\build.cmd or pass --exe');
  fs.copyFileSync(EXE, appExe);
  console.log(`Beam: ${EXE}\ntemp: ${TMP}`);
  dash = await startDash();
  await startServer();
  key = fs.readFileSync(dir('data/key'), 'utf8').trim();
  check((await (await fetch(`${base}/api/info`, { headers: H() })).json()).features?.includes('hw-blackbox'), 'the server knows hw-blackbox');

  // 1. HW Blackbox runs here: its summary with the status
  const pc = await startPc('Shop Desktop', { testHwbUrl: `http://127.0.0.1:${DASH}` });
  check(!!(await pc.waitLog(/Events: connected/)), 'the PC connects');
  let h;
  for (const until = Date.now() + 30000; Date.now() < until && !h; await sleep(250)) h = (await statusOf(pc.id))?.hwBlackbox;
  check(!!h, `its status has HW Blackbox's summary (${JSON.stringify(h)?.slice(0, 200)})`);
  check(h?.version === '1.1.3' && h?.port === DASH, `...its version and its dashboard's port (${h?.version}, ${h?.port})`);
  check(JSON.stringify(h?.counts) === JSON.stringify({ bad: 1, warn: 1, info: 1, ok: 3 }), `...Diagnose's counts (${JSON.stringify(h?.counts)})`);
  check(JSON.stringify((h?.checks || []).map(c => `${c.level}:${c.id}`)) === JSON.stringify(['bad:problems', 'warn:power', 'info:busy:node.exe']),
    `...only the findings that aren't fine, most serious first (${(h?.checks || []).map(c => c.id).join(', ')})`);
  const problem = h?.checks?.[0]?.summary || '';
  check(problem.startsWith('Port 25565 is held by 2 programs x') && [...problem].length === 300 && problem.endsWith('…') && !/\u0007/.test(problem),
    `...a summary in one line, cut to 300 with "…" (${[...problem].length})`);
  const off = h?.powerOff;
  check(off?.up === Date.parse('2026-11-10T19:00:00-05:00') && off?.down === Date.parse('2026-11-10T18:59:50.500-05:00') && off?.why === 'It lost power, or froze',
    `...the newest power-off: when it went down and came back, and why (${JSON.stringify(off)})`);
  check(JSON.stringify(off?.rails) === JSON.stringify({ v12: 12.168, v5: 5.07, v33: 3.346 }), `...with the power supply's last readings (${JSON.stringify(off?.rails)})`);
  check(Math.abs((h?.at || 0) - Math.round(diagnose.at * 1000)) < 2, 'when Diagnose looked');
  check(!!(await pc.waitLog(/HW Blackbox 1\.1\.3 runs here/)), 'the log says it runs here');
  check(asked.every(a => /^GET \/api\/(ping|diagnose|overview) 127\.0\.0\.1:8807$/.test(a)), `only reads, to 127.0.0.1 (${[...new Set(asked)].join('; ')})`);
  await pc.quit();

  // 2. A program on that port that isn't HW Blackbox: nothing
  who = 'something-else';
  const other = await startPc('Other PC', { testHwbUrl: `http://127.0.0.1:${DASH}` });
  check(!!(await other.waitLog(/Events: connected/)), 'another PC connects');
  check(!!(await other.waitLog(/Status sent/)), '...and sends its status');
  check((await statusOf(other.id))?.hwBlackbox === undefined, '...with nothing about HW Blackbox (that port isn\'t HW Blackbox\'s)');
  await other.quit();

  // 3. (1.27.1) HW Blackbox set up, its dashboard not up yet at the connect (it starts with the session, as Beam does):
  // looked for every minute, and the status goes out as soon as it answers (a power loss's alert waits for it)
  who = 'hw-blackbox-dashboard';
  const late = await startPc('Late PC', { testHwbUrl: `http://127.0.0.1:${LATE}` });
  check(!!(await late.waitLog(/Status sent \(connect\)/)), 'a PC whose HW Blackbox isn\'t up yet connects and sends its status');
  check((await statusOf(late.id))?.hwBlackbox === undefined, '...without HW Blackbox\'s findings');
  await sleep(10000);
  const lateDash = await startDash(LATE);
  const upAt = Date.now();
  let h2;
  for (const until = Date.now() + 90000; Date.now() < until && !h2; await sleep(500)) h2 = (await statusOf(late.id))?.hwBlackbox;
  check(h2?.version === '1.1.3' && Date.now() - upAt < 75000, `...they arrive once its dashboard answers, within about a minute (${Math.round((Date.now() - upAt) / 1000)} s)`);
  check(!!(await late.waitLog(/Status sent \(hw-blackbox\)/, 5000)), '...sent for that ("Status sent (hw-blackbox)")');
  await late.quit();
  lateDash.close();
} catch (err) {
  check(false, `the run: ${err.stack || err}`);
} finally {
  try { server?.kill(); } catch {}
  try { dash?.close(); } catch {}
  await sleep(500);
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll HW Blackbox checks passed.');
process.exit(failures.length ? 1 : 0);
