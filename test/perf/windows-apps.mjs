#!/usr/bin/env node
// Beam for Windows 1.16 (server 1.21): apps on every PC. The server asks the PC's app to install one of the user's
// apps; the app asks once at the PC (Install / Always allow / Not now: answered here with --test-apps), downloads the
// file from the server (checked against its SHA-256), installs it for the user and says how it went. Exits 1 if a
// check fails.
//
//   node test/perf/windows-apps.mjs [--exe <Beam.exe>] [--keep]
//
// Isolated like the other windows-* checks: a scratch server (this checkout's server.js) on 127.0.0.1:8805 and a copy
// of Beam.exe with --config in a temp folder (quiet, off-screen). A test instance installs into its own folder
// (Programs, Start Menu under the config folder) and never writes the registry; winget is a stand-in (a .cmd that
// writes down what it was asked). The apps are copies of Windows' own where.exe and whoami.exe: copied, never run.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = 8805;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const exeArg = args.indexOf('--exe');
const EXE = exeArg >= 0 ? args[exeArg + 1] : [path.join(ROOT, 'windows', 'bin', 'Beam.exe'), path.join(ROOT, 'dist', 'Beam.exe')].find(f => fs.existsSync(f));
const KEEP = args.includes('--keep');
const TMP = path.join(os.tmpdir(), `beam-apps-win-${Date.now()}`);
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); return ok; };
const dir = p => path.join(TMP, p);
for (const d of ['data', 'dist', 'app', 'payload']) fs.mkdirSync(dir(d), { recursive: true });
const base = `http://127.0.0.1:${PORT}`;
const appExe = dir('app/Beam.exe');
const env = { ...process.env, BEAM_LOCAL_URLS: base, BEAM_TEST_PEERS: base };
const SYS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
let server, key;

async function startServer() {
  const out = fs.openSync(dir('server.out.log'), 'a');
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, BEAM_TAILSCALE: 'off', BEAM_HOST: '127.0.0.1', BEAM_PORT: String(PORT), BEAM_DATA: dir('data'), BEAM_DIST: dir('dist'), BEAM_TEST_TIMEOUTS: '1' } });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/api/hello`)).ok) break; } catch {} await sleep(200); }
}

// (an address of its own: everything from 127.0.0.1 would be "this machine", the test PC's, and linked to it)
const H = () => ({ Authorization: `Bearer ${key}`, 'X-Beam-Device-Id': 'appsowner01', 'X-Beam-Device': 'Owner', 'X-Beam-Platform': 'web', 'X-Forwarded-For': '100.64.30.9' });
const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { ...H(), ...(body !== undefined && { 'Content-Type': 'application/json' }) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const putFile = async (q, buf) => (await fetch(`${base}/api/apps/file?${new URLSearchParams(q)}`, { method: 'PUT', headers: { ...H(), 'Content-Type': 'application/octet-stream' }, body: buf })).json();
const appOn = async (id, pc) => (await call('GET', '/api/apps')).json.apps.find(a => a.id === id)?.on?.[pc];
async function waitState(id, pc, want, ms = 30000) {
  let s;
  for (const until = Date.now() + ms; Date.now() < until; await sleep(150)) {
    s = await appOn(id, pc);
    if (want === null ? s === undefined : s && s.state === want) return s ?? true;
  }
  return null;
}

// A .zip without compression, written here (so a test can name an entry "..\x").
function zip(entries) {
  const table = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = b => { let c = -1; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const parts = [], central = [];
  let off = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name), d = Buffer.from(data), c = crc(d);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(c, 14); local.writeUInt32LE(d.length, 18); local.writeUInt32LE(d.length, 22); local.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt32LE(c, 16); cen.writeUInt32LE(d.length, 20); cen.writeUInt32LE(d.length, 24); cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(off, 42);
    parts.push(local, n, d);
    central.push(cen, n);
    off += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

async function startPc(extra) {
  const id = `appspc${crypto.randomBytes(6).toString('hex')}`;
  const made = await (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Beam-Platform': 'windows' },
    body: JSON.stringify({ secret: key, client: 'app', platform: 'windows', deviceId: id }) })).json();
  if (!made.key || made.you !== id) throw new Error('no device token');
  const cfgDir = dir('cfg');
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ server: base, key: made.key, deviceId: id, deviceName: 'Test PC', quiet: true, testOffscreen: true,
    autoUpdate: false, autostartInitialized: true, sendToMenu: false, outbox: false, autoCopy: false, autoSave: false, ...extra }, null, 2));
  return { id, cfgDir, cfgPath, ...runApp(cfgDir, cfgPath) };
}

function runApp(cfgDir, cfgPath) {
  const app = spawn(appExe, ['--config', cfgPath, '--background'], { env, windowsHide: true, stdio: 'ignore' });
  let exited = false;
  app.on('exit', () => { exited = true; });
  const logPath = path.join(cfgDir, 'beam.log');
  const lines = () => { try { return fs.readFileSync(logPath, 'utf8').split(/\r?\n/); } catch { return []; } };
  return {
    lines,
    mark: () => lines().length,
    async waitLog(re, from = 0, ms = 30000) {
      for (const until = Date.now() + ms; Date.now() < until; await sleep(100)) { const l = lines().slice(from).find(x => re.test(x)); if (l) return l; }
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

const realPrograms = path.join(process.env.LOCALAPPDATA || '', 'Programs');
const realStart = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
const NAMES = ['Beam Test Tool', 'Beam Test Kit', 'Beam Test Evil'];
const realBefore = NAMES.map(n => [fs.existsSync(path.join(realPrograms, n)), fs.existsSync(path.join(realStart, `${n}.lnk`))]);

try {
  if (!EXE) throw new Error('No Beam.exe: build with windows\\build.cmd or pass --exe');
  fs.copyFileSync(EXE, appExe);
  console.log(`Beam: ${EXE}\ntemp: ${TMP}`);
  await startServer();
  key = fs.readFileSync(dir('data/key'), 'utf8').trim();
  check((await call('GET', '/api/me')).status === 200, 'the owner signs in');

  // The apps: a portable .exe, a .zip (its program in bin\), one whose .zip would write outside its folder; winget.
  const where = fs.readFileSync(path.join(SYS, 'where.exe'));
  const whoami = fs.readFileSync(path.join(SYS, 'whoami.exe'));
  const tool = (await putFile({ name: 'BeamTestTool.exe', label: 'Beam Test Tool', version: '1.0' }, where)).app;
  const kit = (await putFile({ name: 'beam-test-kit.zip', label: 'Beam Test Kit' }, zip([['bin/kit.exe', where], ['readme.txt', 'hello']]))).app;
  const evil = (await putFile({ name: 'beam-test-evil.zip', label: 'Beam Test Evil' }, zip([['../evil.txt', 'out'], ['ok.txt', 'in']]))).app;
  check(Boolean(tool?.id && kit?.id && evil?.id), 'three file apps on the server');
  check((await call('PATCH', `/api/apps/${kit.id}`, { run: 'bin/kit.exe' })).status === 200, 'the .zip\'s program: bin/kit.exe');
  const wg = (await call('POST', '/api/apps', { winget: 'Beam.TestPackage', name: 'Beam Test Package' })).json.app;
  check(wg?.kind === 'winget', 'a winget app');

  // The PC: apps not allowed yet; winget is a .cmd that writes down each call (and has no installer for one user).
  const wingetLog = dir('winget-calls.txt');
  const fakeWinget = dir('fake-winget.cmd');
  fs.writeFileSync(fakeWinget, [
    '@echo off',
    `echo %*>>"${wingetLog}"`,
    // (Windows' own findstr: a Git or MSYS `find` on the PATH would be the other find)
    'echo %* | "%SystemRoot%\\System32\\findstr.exe" /c:"--scope user" >nul && (echo No applicable installer found; see logs for more details. & exit /b -1978335216)',
    'echo Successfully installed',
    'exit /b 0',
  ].join('\r\n'));
  const pc = await startPc({ testWinget: fakeWinget });
  check(!!(await pc.waitLog(/Events: connected/)), 'the PC connects');
  const dl = await call('GET', '/api/devices');
  check(dl.json?.devices?.find(d => d.id === pc.id)?.can?.apps === true, `the server says it can install apps (Windows 1.16) (${dl.status} ${dl.json?.devices ? '' : dl.text.slice(0, 160)})`);

  // 1. Asked at the PC first; Install (this once).
  let from = pc.mark();
  let r = await call('POST', `/api/apps/${tool.id}/install`, { devices: 'all' });
  check(r.status === 200 && JSON.stringify(r.json.asked) === '["Test PC"]', `install on all PCs: the PC is asked (${r.text.slice(0, 120)})`);
  check(!!(await pc.waitLog(/Apps: asks whoever is here before installing Beam Test Tool/, from)), 'the PC asks whoever is there first (not allowed yet)');
  check(!!(await waitState(tool.id, pc.id, 'asked')), '...and says so: "asked"');
  // (1.16.1) The question opens by itself (near the clock, on top), and Beam's window knows it's waiting (its bar)
  check(!!(await pc.waitLog(/Apps: the question about Beam Test Tool is on the screen \(by itself\)/, from)), 'the question opens by itself');
  let at = pc.mark();
  pc.forward(['--test-bridge', JSON.stringify({ type: 'getSettings', id: 'test-asks' })]);
  const asks = await pc.waitLog(/Bridge test reply: .*"id":"test-asks"/, at);
  check(!!asks && asks.includes(`"appAsks":[{"id":"${tool.id}"`) && asks.includes('"name":"Beam Test Tool"'), `...and the window's bar has it (settings.appAsks) (${(asks || '').match(/"appAsks":[^\]]*\]/)?.[0]})`);
  pc.forward(['--test-apps', `answer:${tool.id}:install`]);
  let s = await waitState(tool.id, pc.id, 'installed');
  const toolExe = path.join(pc.cfgDir, 'Programs', 'Beam Test Tool', 'BeamTestTool.exe');
  check(!!s && /^\d/.test(s.version || ''), `Install: installed, at the program's own version (${s?.version})`);
  check(fs.existsSync(toolExe) && sha(fs.readFileSync(toolExe)) === sha(where), '...the file in its Programs folder (under the test\'s config folder), byte for byte');
  check(fs.existsSync(path.join(pc.cfgDir, 'Start Menu', 'Beam Test Tool.lnk')), '...with a Start menu shortcut');
  let cfg = JSON.parse(fs.readFileSync(pc.cfgPath, 'utf8'));
  check(cfg.appsAllowed !== true && cfg.installedApps?.some(a => a.id === tool.id && a.kind === 'exe'), 'still not allowed for the next one; the config knows what it installed');

  // 2. Not now, then Always allow.
  from = pc.mark();
  await call('POST', `/api/apps/${kit.id}/install`, { devices: [pc.id] });
  check(!!(await waitState(kit.id, pc.id, 'asked')), 'the .zip: asked again');
  // (1.16.1) Not now from Beam's window (its bar: the bridge's appAsk): answered, its question gone, the bar empty
  at = pc.mark();
  pc.forward(['--test-bridge', JSON.stringify({ type: 'appAsk', id: 'test-notnow', app: kit.id, choice: 'notnow' })]);
  check(!!(await waitState(kit.id, pc.id, 'declined')), 'Not now (from the window\'s bar): the server hears "declined"');
  const after = await pc.waitLog(/Bridge test reply: .*"id":"test-notnow"/, at);
  check(!!after && after.includes('"appAsks":[]'), '...and nothing is waiting any more');
  await call('POST', `/api/apps/${kit.id}/install`, { devices: [pc.id] });
  check(!!(await waitState(kit.id, pc.id, 'asked')), 'asked once more');
  pc.forward(['--test-apps', `answer:${kit.id}:always`]);
  s = await waitState(kit.id, pc.id, 'installed');
  const kitDir = path.join(pc.cfgDir, 'Programs', 'Beam Test Kit');
  check(!!s && fs.existsSync(path.join(kitDir, 'bin', 'kit.exe')) && fs.readFileSync(path.join(kitDir, 'readme.txt'), 'utf8') === 'hello', 'Always allow: the .zip unpacked into its folder');
  cfg = JSON.parse(fs.readFileSync(pc.cfgPath, 'utf8'));
  check(cfg.appsAllowed === true && cfg.installedApps?.find(a => a.id === kit.id)?.exe?.endsWith('bin\\kit.exe'), '...allowed from now on; its shortcut starts bin\\kit.exe');

  // 3. Allowed now: no question. winget for one user first, then as the package wants.
  from = pc.mark();
  await call('POST', `/api/apps/${wg.id}/install`, { devices: [pc.id] });
  s = await waitState(wg.id, pc.id, 'installed');
  const calls = fs.existsSync(wingetLog) ? fs.readFileSync(wingetLog, 'utf8').trim().split(/\r?\n/) : [];
  check(!!s && !(await pc.waitLog(/asks whoever is here before installing Beam Test Package/, from, 500)), 'winget: installed without a question');
  check(calls.length === 2 && /^install --id Beam\.TestPackage --exact --source winget --silent .*--scope user$/.test(calls[0]) && !/--scope/.test(calls[1]),
    `...for one user first, then (none for one user) as the package wants (${JSON.stringify(calls)})`);

  // 4. A .zip that would write outside its folder: refused, nothing written.
  await call('POST', `/api/apps/${evil.id}/install`, { devices: [pc.id] });
  s = await waitState(evil.id, pc.id, 'failed');
  check(!!s && /would go outside its folder/.test(s.error || ''), `a .zip escaping its folder is refused (${s?.error})`);
  check(!fs.existsSync(path.join(pc.cfgDir, 'Programs', 'evil.txt')), '...and nothing was written outside');

  // 5. A new version of the tool: the PC that has it gets it (in place of the old one).
  from = pc.mark();
  await putFile({ name: 'BeamTestTool.exe', app: tool.id, version: '2.0' }, whoami);
  for (const until = Date.now() + 30000; Date.now() < until; await sleep(150)) if (fs.existsSync(toolExe) && sha(fs.readFileSync(toolExe)) === sha(whoami)) break;
  check(sha(fs.readFileSync(toolExe)) === sha(whoami), 'a new version goes to the PC that has it, in place of the old');
  check(!!(await waitState(tool.id, pc.id, 'installed')), '...and it says it\'s installed');

  // 6. Uninstall from the server; and from Windows' Installed apps (Beam.exe --remove-app).
  from = pc.mark();
  r = await call('POST', `/api/apps/${tool.id}/uninstall`, { devices: [pc.id] });
  check(r.status === 200, 'uninstall asked');
  check(!!(await waitState(tool.id, pc.id, null)), '...done: the server forgets it there');
  check(!fs.existsSync(path.dirname(toolExe)) && !fs.existsSync(path.join(pc.cfgDir, 'Start Menu', 'Beam Test Tool.lnk')), '...its folder and shortcut are gone');
  await call('POST', `/api/apps/${wg.id}/uninstall`, { devices: [pc.id] });
  check(!!(await waitState(wg.id, pc.id, null)), 'winget\'s app: uninstalled');
  check(/^uninstall --id Beam\.TestPackage --exact --silent/.test(fs.readFileSync(wingetLog, 'utf8').trim().split(/\r?\n/).pop()), '...by winget');
  pc.forward(['--remove-app', kit.id]);
  check(!!(await waitState(kit.id, pc.id, null)), 'Windows\' Installed apps → Uninstall (--remove-app): removed, and the server told');
  check(!fs.existsSync(kitDir), '...its folder gone');
  cfg = JSON.parse(fs.readFileSync(pc.cfgPath, 'utf8'));
  check(!(cfg.installedApps || []).length, 'the config has nothing left');

  // 7. Nothing real touched: the real Programs folder, Start menu and Installed apps.
  const realAfter = NAMES.map(n => [fs.existsSync(path.join(realPrograms, n)), fs.existsSync(path.join(realStart, `${n}.lnk`))]);
  check(JSON.stringify(realAfter) === JSON.stringify(realBefore), 'the real Programs folder and Start menu: untouched');
  const reg = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'], { encoding: 'utf8', windowsHide: true }).stdout || '';
  check(![tool.id, kit.id, evil.id, wg.id].some(id => reg.includes(`BeamApp-${id}`)), 'nothing in the registry');
  await pc.quit();
} catch (err) {
  check(false, `the run: ${err.stack || err}`);
} finally {
  try { server?.kill(); } catch {}
  await sleep(500);
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll apps checks passed.');
process.exit(failures.length ? 1 : 0);
