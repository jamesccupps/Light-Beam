#!/usr/bin/env node
// Beam for Windows 1.18 (server 1.26): shared folders. Another device looks in a PC's shared folders and copies files
// from one, through the server; the PC decides what it shows and sends. Exits 1 if a check fails.
//
//   node test/perf/windows-files.mjs [--exe <Beam.exe>] [--keep]
//
// Isolated like the other windows-* checks: a scratch server (this checkout's server.js) on 127.0.0.1:8807 and a copy of
// Beam.exe with --config in a temp folder (quiet, off-screen). Its config shares folders made here (inside its own
// config folder, where a test instance may share: a real one can't share anything in AppData, %TEMP% included):
// "Downloads" with the asking device (files, a subfolder, and what must never be seen: names starting with ".", hidden
// and system files, a junction to a folder outside), "Other" with another device only, "Outgoing" (the app's own outgoing
// folder, whose files Beam deletes after sending: a copy must not), and one outside its folder in %TEMP%, which it must
// refuse. Nothing is clicked or typed; no real folder of this PC is shared.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = 8807;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const exeArg = args.indexOf('--exe');
const EXE = exeArg >= 0 ? args[exeArg + 1] : [path.join(ROOT, 'windows', 'bin', 'Beam.exe'), path.join(ROOT, 'dist', 'Beam.exe')].find(f => fs.existsSync(f));
const KEEP = args.includes('--keep');
const TMP = path.join(os.tmpdir(), `beam-files-win-${Date.now()}`);
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); return ok; };
const dir = p => path.join(TMP, p);
for (const d of ['data', 'dist', 'app', 'cfg']) fs.mkdirSync(dir(d), { recursive: true });
const base = `http://127.0.0.1:${PORT}`;
const appExe = dir('app/Beam.exe');
const env = { ...process.env, BEAM_LOCAL_URLS: base, BEAM_TEST_PEERS: base };
let server, app, key, exited = false;

async function startServer() {
  const out = fs.openSync(dir('server.out.log'), 'a');
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, BEAM_TAILSCALE: 'off', BEAM_HOST: '127.0.0.1', BEAM_PORT: String(PORT), BEAM_DATA: dir('data'), BEAM_DIST: dir('dist') } });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/api/hello`)).ok) break; } catch {} await sleep(200); }
}

// A device of the master key's (trusted): the asker, another one.
let ipNext = 10; // (each device its own address: one address is one machine to the server)
const as = (id, name) => ({ Authorization: `Bearer ${key}`, 'X-Beam-Device-Id': id, 'X-Beam-Device': encodeURIComponent(name), 'X-Beam-Platform': 'android', 'X-Forwarded-For': `100.64.27.${ipNext++}` });
async function call(h, method, p, body) {
  const r = await fetch(base + p, { method, headers: { ...h, ...(body !== undefined && { 'Content-Type': 'application/json' }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
const logPath = dir('cfg/beam.log');
const lines = () => { try { return fs.readFileSync(logPath, 'utf8').split(/\r?\n/); } catch { return []; } };
async function waitLog(re, ms = 15000) {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(100)) { const l = lines().find(x => re.test(x)); if (l) return l; }
  return null;
}
async function waitFor(fn, ms = 15000, step = 200) {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(step)) { const v = await fn(); if (v) return v; }
  return null;
}

try {
  if (!EXE) throw new Error('No Beam.exe: build with windows\\build.cmd or pass --exe');
  fs.copyFileSync(EXE, appExe);
  console.log(`Beam: ${EXE}\ntemp: ${TMP}`);
  await startServer();
  key = fs.readFileSync(dir('data/key'), 'utf8').trim();
  const asker = as(`asker${crypto.randomBytes(5).toString('hex')}`, 'Asker Phone');
  const other = as(`other${crypto.randomBytes(5).toString('hex')}`, 'Other Phone');
  const stranger = as(`strgr${crypto.randomBytes(5).toString('hex')}`, 'Stranger Phone');
  for (const h of [asker, other, stranger]) await call(h, 'GET', '/api/me');
  const askerId = asker['X-Beam-Device-Id'], otherId = other['X-Beam-Device-Id'];

  // The folders, inside the test instance's own folder
  const cfgDir = dir('cfg');
  const dl = path.join(cfgDir, 'shares', 'Downloads');
  const put = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  const report = crypto.randomBytes(70000), notes = 'notes, made by the test\n';
  put(path.join(dl, 'report.pdf'), report);
  put(path.join(dl, 'notes.txt'), notes);
  put(path.join(dl, 'Photos', 'beach.jpg'), 'a beach');
  put(path.join(dl, '.secret', 'key.pem'), 'never seen');
  put(path.join(dl, '.env'), 'NEVER=seen');
  put(path.join(dl, 'hidden.txt'), 'hidden');
  put(path.join(dl, 'system.dat'), 'system');
  spawnSync('attrib', ['+h', path.join(dl, 'hidden.txt')], { windowsHide: true });
  spawnSync('attrib', ['+s', path.join(dl, 'system.dat')], { windowsHide: true });
  put(dir('elsewhere/outside.txt'), 'outside the shared folder');
  const junction = spawnSync('cmd.exe', ['/c', 'mklink', '/J', path.join(dl, 'Linked'), dir('elsewhere')], { windowsHide: true, encoding: 'utf8' });
  check(junction.status === 0 && fs.existsSync(path.join(dl, 'Linked', 'outside.txt')), 'a junction inside Downloads to a folder outside it (the test\'s own)');
  put(path.join(cfgDir, 'shares', 'Other', 'other.txt'), 'for the other phone');
  const outgoing = path.join(cfgDir, 'outgoing');
  put(path.join(outgoing, 'keep-me.txt'), 'in the outgoing folder');
  put(dir('outside-share/x.txt'), 'in %TEMP%, outside the instance\'s folder');

  // The PC: signed in with its own token, the folders in its config
  const pcId = `filespc${crypto.randomBytes(6).toString('hex')}`;
  const made = await (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Beam-Platform': 'windows' },
    body: JSON.stringify({ secret: key, client: 'app', platform: 'windows', deviceId: pcId }) })).json();
  if (!made.key) throw new Error('no device token for the PC');
  const cfgPath = path.join(cfgDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ server: base, key: made.key, deviceId: pcId, deviceName: 'Test PC', quiet: true, testOffscreen: true,
    autoUpdate: false, autostartInitialized: true, sendToMenu: false, outbox: false, autoCopy: false, autoSave: false,
    sharedFolders: [
      { id: 'a1a1a1a1', name: 'Downloads', path: dl, devices: [askerId] },
      { id: 'b2b2b2b2', name: 'Other', path: path.join(cfgDir, 'shares', 'Other'), devices: [otherId] },
      { id: 'c3c3c3c3', name: 'Outgoing', path: outgoing, devices: [askerId] },
      { id: 'd4d4d4d4', name: 'Temp', path: dir('outside-share'), devices: [askerId] },
    ] }, null, 2));
  app = spawn(appExe, ['--config', cfgPath, '--background'], { env, windowsHide: true, stdio: 'ignore' });
  app.on('exit', () => { exited = true; });
  const pcOnline = () => waitFor(async () => { const d = (await call(asker, 'GET', '/api/devices')).json?.devices?.find(x => x.id === pcId); return d && d.online && d.can?.files ? d : null; }, 30000);
  let online = await pcOnline();
  // (its first start swaps the sign-in made here for one bound to its device key: that stream closes and it connects again
  // within a second; the first run's requests landed in that gap)
  await sleep(3000);
  online = online && await pcOnline();
  check(!!online, 'the PC (Beam for Windows 1.18) is online and shares folders (can.files)');
  check(!!(await waitLog(/Shared folders: Temp \(.*outside-share\) isn't shared: Windows' and apps' own folders can't be shared$/, 1000)),
    'a folder outside its own folder, in %TEMP% (AppData), is refused when the config is read');

  // What each device may see
  const files = (h, body) => call(h, 'POST', `/api/devices/${pcId}/files`, body);
  let r = await files(asker, {});
  check(r.status === 200 && JSON.stringify(r.json?.shares) === JSON.stringify([{ id: 'a1a1a1a1', name: 'Downloads' }, { id: 'c3c3c3c3', name: 'Outgoing' }]),
    `the asker sees the folders shared with it, and only those (${JSON.stringify(r.json)})`);
  r = await files(stranger, {});
  check(r.status === 200 && Array.isArray(r.json?.shares) && r.json.shares.length === 0, `a device ticked nowhere sees none (${JSON.stringify(r.json)})`);
  r = await files(asker, { share: 'b2b2b2b2' });
  check(r.status === 403 && r.json?.reason === 'not-shared', `another device's folder, asked for by its id: refused (${r.status} ${r.json?.reason})`);
  r = await files(asker, { share: 'd4d4d4d4' });
  check(r.status === 403 && r.json?.reason === 'not-shared', `the refused folder: not there (${r.status} ${r.json?.reason})`);

  // What's in Downloads: never a name starting with ".", hidden or system files, or the junction
  r = await files(asker, { share: 'a1a1a1a1' });
  const names = (r.json?.entries || []).map(e => (e.dir ? `${e.n}/` : e.n));
  check(r.status === 200 && JSON.stringify(names) === JSON.stringify(['Photos/', 'notes.txt', 'report.pdf']), `Downloads: folders first, and nothing hidden, starting with ".", or a link (${JSON.stringify(names)})`);
  const rep = (r.json?.entries || []).find(e => e.n === 'report.pdf');
  check(!!rep && rep.s === report.length && Math.abs(rep.m - fs.statSync(path.join(dl, 'report.pdf')).mtimeMs) < 2000, `...with each file's size and time (${JSON.stringify(rep)})`);
  r = await files(asker, { share: 'a1a1a1a1', path: 'photos' });
  check(r.status === 200 && r.json?.path === 'Photos' && JSON.stringify((r.json?.entries || []).map(e => e.n)) === '["beach.jpg"]', `a subfolder (its name as on disk: ${r.json?.path})`);
  for (const p of ['..', '../..', 'Photos/..', 'Photos/../..', '.secret', 'Linked', 'Linked/', 'report.pdf', 'C:\\Windows', 'C:/Windows', '\\\\?\\C:\\', 'Photos:x', 'nope', 'CON', 'Photos.', 'Photos ']) {
    r = await files(asker, { share: 'a1a1a1a1', path: p });
    check(r.status === 404 && r.json?.reason === 'not-found', `"${p}": not a folder to look in (${r.status} ${r.json?.reason || r.json?.error})`);
  }
  check(!lines().some(l => /outside\.txt|key\.pem|NEVER=seen/.test(l)), 'beam.log names nothing of what isn\'t shown');

  // A copy: the files it can send go to the asker; the rest is said
  r = await call(asker, 'POST', `/api/devices/${pcId}/files/copy`, { share: 'a1a1a1a1', path: '', names: ['report.pdf', 'notes.txt', '.env', 'hidden.txt', 'system.dat', 'Photos', 'Linked', '../elsewhere/outside.txt', 'nope.txt'] });
  const skipped = Object.fromEntries((r.json?.skipped || []).map(s => [s.n, s.why]));
  check(r.status === 200 && r.json?.sending === 2, `two of them are sent (${JSON.stringify(r.json)})`);
  check(skipped.Photos === 'a folder: files only' && ['.env', 'hidden.txt', 'system.dat', 'Linked', '../elsewhere/outside.txt', 'nope.txt'].every(n => skipped[n] === 'not there'), `...and the rest left out, saying why (${JSON.stringify(skipped)})`);
  const arrived = await waitFor(async () => {
    const items = (await call(asker, 'GET', '/api/items')).json?.items || [];
    const got = items.filter(i => i.from === pcId && i.kind === 'file' && i.size > 0 && (i.name === 'report.pdf' || i.name === 'notes.txt'));
    return got.length === 2 && got.every(i => !i.uploading) ? got : null;
  }, 30000, 500);
  check(!!arrived && arrived.every(i => JSON.stringify(i.to) === JSON.stringify([askerId])), `both arrive as files from the PC, for the asker only (${arrived ? arrived.map(i => `${i.name} → ${i.to}`).join(', ') : 'not within 30 s'})`);
  if (arrived) {
    const bytes = async i => Buffer.from(await (await fetch(`${base}/api/file/${i.id}`, { headers: asker })).arrayBuffer());
    const a = arrived.find(i => i.name === 'report.pdf'), b = arrived.find(i => i.name === 'notes.txt');
    check((await bytes(a)).equals(report) && (await bytes(b)).toString() === notes, '...byte for byte');
  }
  check(fs.existsSync(path.join(dl, 'report.pdf')) && fs.existsSync(path.join(dl, 'notes.txt')), 'the originals stay where they were');
  check(!!(await waitLog(/Shared folders: Asker Phone copies report\.pdf, notes\.txt \(.+\) from Downloads$/, 3000)), 'beam.log says who copied what, from where');
  check(!!(await waitLog(/Notification: Asker Phone is copying 2 files/, 3000)), '...and the PC shows a notice');

  // From the app's own outgoing folder: sent, never deleted after (Beam deletes its own outgoing files once sent)
  r = await call(asker, 'POST', `/api/devices/${pcId}/files/copy`, { share: 'c3c3c3c3', path: '', names: ['keep-me.txt'] });
  check(r.status === 200 && r.json?.sending === 1, `a file from the outgoing folder is sent (${JSON.stringify(r.json)})`);
  const kept = await waitFor(async () => ((await call(asker, 'GET', '/api/items')).json?.items || []).find(i => i.from === pcId && i.name === 'keep-me.txt' && !i.uploading), 30000, 500);
  await sleep(1500);
  check(!!kept && fs.existsSync(path.join(outgoing, 'keep-me.txt')), `...and stays there after it's sent (${kept ? 'sent' : 'not sent'}, ${fs.existsSync(path.join(outgoing, 'keep-me.txt')) ? 'still there' : 'deleted'})`);

  // Copying a folder that isn't shared with it, or into a path that isn't there
  r = await call(other, 'POST', `/api/devices/${pcId}/files/copy`, { share: 'a1a1a1a1', path: '', names: ['report.pdf'] });
  check(r.status === 403 && r.json?.reason === 'not-shared', `another device can't copy from Downloads (${r.status} ${r.json?.reason})`);
  r = await call(asker, 'POST', `/api/devices/${pcId}/files/copy`, { share: 'a1a1a1a1', path: 'Linked', names: ['outside.txt'] });
  check(r.status === 404 && r.json?.reason === 'not-found', `nor through the junction (${r.status} ${r.json?.reason})`);
  r = await files(other, { share: 'b2b2b2b2' });
  check(r.status === 200 && JSON.stringify((r.json?.entries || []).map(e => e.n)) === '["other.txt"]', 'the other device sees its own folder');

  // This PC's page (the chat window, host mode): the folders read-only; it can't change them; its button opens the window
  const forward = a => spawnSync(appExe, ['--config', cfgPath, ...a], { env, windowsHide: true, timeout: 20000 });
  forward(['--test-bridge', JSON.stringify({ type: 'getSettings', id: 'test-shares-get' })]);
  const got = await waitLog(/Bridge test reply: .*"id":"test-shares-get"/);
  check(!!got && got.includes('"sharedFolders":[{"name":"Downloads"') && got.includes('"devices":["Asker Phone"]'), `the page sees the folders and who sees each, by name (${(got || '').match(/"sharedFolders":\[[^\]]*\]/)?.[0]})`);
  forward(['--test-bridge', JSON.stringify({ type: 'setSettings', id: 'test-shares-set', settings: { sharedFolders: [] } })]);
  await waitLog(/Bridge test reply: .*"id":"test-shares-set"/);
  check(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).sharedFolders?.length === 3, 'the page can\'t change them (setSettings leaves them as they are)');
  forward(['--test-bridge', JSON.stringify({ type: 'sharedFolders', id: 'test-shares-open' })]);
  check(!!(await waitLog(/Bridge test reply: .*"id":"test-shares-open"/)), 'the page\'s Shared folders… opens the window (bridge sharedFolders)');
  forward(['--test-shares', 'open']);
  const shown = await waitLog(/Shared folders \(test\): open, /);
  check(!!shown && /3 folder\(s\): Downloads with 1 device\(s\); Other with 1 device\(s\); Outgoing with 1 device\(s\)$/.test(shown), `...showing each folder and its devices (${shown ? shown.replace(/.*open, /, '') : 'nothing'})`);
  const png = dir('shared-folders-window.png');
  forward(['--test-shares', `shot:${png}`]);
  check(!!(await waitLog(/Shared folders \(test\): shot/)) && fs.existsSync(png) && fs.statSync(png).size > 2000, `...drawn (${png})`);
  forward(['--test-shares', 'save']);
  check(!!(await waitLog(/Shared folders \(the test\): Downloads \(.*\) with Asker Phone; Other \(.*\) with Other Phone; Outgoing \(.*\) with Asker Phone$/)), 'Save keeps them as they are, and says so');
} catch (err) {
  check(false, `the run: ${err && err.stack || err}`);
} finally {
  if (app && !exited) {
    spawnSync(appExe, ['--config', dir('cfg/config.json'), '--quit'], { env, windowsHide: true, timeout: 20000 });
    for (let i = 0; i < 80 && !exited; i++) await sleep(250);
    if (!exited) { try { app.kill(); } catch {} }
  }
  if (server) { try { server.kill(); } catch {} }
  await sleep(500);
  try { fs.rmSync(path.join(dir('cfg/shares/Downloads'), 'Linked')); } catch {} // (the junction alone, never what it points to)
  if (!KEEP && !failures.length) fs.rmSync(TMP, { recursive: true, force: true });
  else console.log(`kept ${TMP}`);
  console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nAll shared folder checks passed.');
  process.exit(failures.length ? 1 : 0);
}
