#!/usr/bin/env node
// Beam for Windows 1.22: the input helper for administrator windows (plan Beam-dev\plan\rc-admin.md). Exits 1 if a
// check fails.
//
//   node test/perf/windows-adminhelper.mjs [--exe <Beam.exe>] [--keep]
//
// Isolated like the other windows-* checks: a scratch server (this checkout's server.js) on 127.0.0.1:8815 and a copy of
// Beam.exe with --config in a temp folder (quiet, off-screen). Its setup writes a scratch "Program Files", certificate
// store and UAC policy as files (testAdminHelperRoot: never Program Files, a real store or HKLM), and its helper is
// BeamInput-test.exe (built without uiAccess: Windows starts a uiAccess exe only from Program Files, signed and trusted)
// recording to rc-input.jsonl: never real input. Real UIAccess and a UAC prompt can only be tried on a PC after its
// setup. Checks:
// - the build: Beam.exe, BeamInput.exe and BeamInput-test.exe signed by the same certificate (obj\helper-signer.cer),
//   uiAccess only in BeamInput.exe, the helper inside Beam.exe;
// - Settings' setup through the bridge: the helper in "Program Files", its certificate in the "store", UAC prompts on
//   the normal desktop and back (the value before kept and put back, also when there was none), Remove undoes it all;
// - a session's input through the helper (begin, keys, text, end), the helper gone after the session and with Beam;
// - the helper refuses a parent that isn't Beam signed like it, and a pipe that isn't its parent's;
// - no helper there: input goes the usual way.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = 8815;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const exeArg = args.indexOf('--exe');
const EXE = exeArg >= 0 ? args[exeArg + 1] : path.join(ROOT, 'windows', 'bin', 'Beam.exe');
const BIN = path.dirname(EXE);
const KEEP = args.includes('--keep');
const TMP = path.join(os.tmpdir(), `beam-adminhelper-win-${Date.now()}`);
const failures = [];
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
  return ok;
}
const dir = p => path.join(TMP, p);
for (const d of ['data', 'dist', 'cfg', 'app', 'helper', 'root']) fs.mkdirSync(dir(d), { recursive: true });
const cfgPath = dir('cfg/config.json'), logPath = dir('cfg/beam.log'), appExe = dir('app/Beam.exe'), inputPath = dir('cfg/rc-input.jsonl');
const testHelper = dir('helper/BeamInput-test.exe');
const base = `http://127.0.0.1:${PORT}`;
const pcId = 'adminpc' + crypto.randomBytes(8).toString('hex');
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
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const inputLines = () => { try { return fs.readFileSync(inputPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const ps = cmd => spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', windowsHide: true, timeout: 60000 }).stdout.trim();
const helpers = () => ps(`@(Get-CimInstance Win32_Process -Filter "Name='BeamInput-test.exe'" | Where-Object { $_.ExecutablePath -eq '${testHelper.replace(/'/g, "''")}' }).Count`);

const forward = a => spawnSync(appExe, ['--config', cfgPath, ...a], { env: { ...process.env, BEAM_LOCAL_URLS: base, BEAM_TEST_PEERS: base }, windowsHide: true, timeout: 20000 });
async function bridge(msg, ms = 30000) {
  const from = logLines().length;
  forward(['--test-bridge', JSON.stringify(msg)]);
  const line = await waitLog(new RegExp(`Bridge test reply: .*"id":"${msg.id}"`), from, ms);
  return line ? JSON.parse(line.replace(/^.*Bridge test reply: /, '')) : null;
}
async function quitApp() {
  if (!app || appExit !== undefined) return;
  forward(['--quit']);
  for (let i = 0; i < 80 && appExit === undefined; i++) await sleep(250);
  if (appExit === undefined) { try { app.kill(); } catch {} }
  await sleep(1000);
}
function startApp() {
  appExit = undefined;
  app = spawn(appExe, ['--config', cfgPath, '--background'], { env: { ...process.env, BEAM_LOCAL_URLS: base, BEAM_TEST_PEERS: base }, windowsHide: true, stdio: 'ignore' });
  app.on('exit', code => { appExit = code; });
}

try {
  // The build
  const sig = f => ps(`$s = Get-AuthenticodeSignature -LiteralPath '${f.replace(/'/g, "''")}'; if ($s.SignerCertificate) { $s.SignerCertificate.Thumbprint } else { 'none' }`);
  const cerFile = path.join(path.dirname(BIN), 'obj', 'helper-signer.cer');
  const signer = fs.existsSync(cerFile) ? ps(`(New-Object System.Security.Cryptography.X509Certificates.X509Certificate2('${cerFile.replace(/'/g, "''")}')).Thumbprint`) : 'no obj\\helper-signer.cer';
  const helperExe = path.join(BIN, 'BeamInput.exe'), helperTestExe = path.join(BIN, 'BeamInput-test.exe');
  const prints = [EXE, helperExe, helperTestExe].map(sig);
  check(/^[0-9A-F]{40}$/.test(signer) && prints.every(t => t === signer), `Beam.exe, BeamInput.exe and BeamInput-test.exe signed by the build's certificate (${signer}; ${prints.join(', ')})`);
  const bytes = f => fs.readFileSync(f);
  check(bytes(helperExe).includes('uiAccess="true"') && bytes(helperTestExe).includes('uiAccess="false"'), 'uiAccess only in BeamInput.exe (the test copy without)');
  check(bytes(EXE).includes(Buffer.from('Beam.helper.BeamInput.exe')) && bytes(EXE).includes(Buffer.from('Beam.helper.signer.cer')), 'the helper and its certificate are inside Beam.exe');

  fs.copyFileSync(EXE, appExe);
  fs.copyFileSync(helperTestExe, testHelper);
  console.log(`Beam: ${EXE}\ntemp: ${TMP}`);
  const out = fs.openSync(dir('server.out.log'), 'a');
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, BEAM_TAILSCALE: 'off', BEAM_HOST: '127.0.0.1', BEAM_PORT: String(PORT), BEAM_DATA: dir('data'), BEAM_DIST: dir('dist') } });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/api/hello`)).ok) break; } catch {} await sleep(200); }
  key = fs.readFileSync(dir('data/key'), 'utf8').trim();
  const made = await (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Beam-Platform': 'windows' },
    body: JSON.stringify({ secret: key, client: 'app', platform: 'windows', deviceId: pcId }) })).json();
  if (!made.key || made.you !== pcId) throw new Error('no device token for the test PC');
  fs.writeFileSync(dir('root/policy.json'), JSON.stringify({ PromptOnSecureDesktop: 1 }));
  fs.writeFileSync(cfgPath, JSON.stringify({ server: base, key: made.key, deviceId: pcId, deviceName: 'Admin Helper Test PC', quiet: true, testOffscreen: true,
    autoUpdate: false, autostartInitialized: true, sendToMenu: false, autoCopy: false, autoSave: false, restoreChecked: true,
    testAdminHelper: testHelper, testAdminHelperRoot: dir('root') }, null, 2));
  startApp();
  check(!!(await waitLog(/Events: connected/, 0, 30000)), 'the app connects');
  await waitLog(/Catch-up: the whole list/, 0, 15000);
  await sleep(1000);

  // Settings: not set up yet
  let r = await bridge({ type: 'getSettings', id: 'test-ah-0' });
  let st = r?.result?.settings?.adminHelper;
  check(st && st.available === true && st.installed === false && st.trusted === false && st.ready === false && st.prompts === false,
    `Settings before: available, not set up (${JSON.stringify(st)})`);

  // Set up, prompts on
  const installed = dir('root/Program Files/Beam/BeamInput.exe');
  r = await bridge({ type: 'adminHelper', id: 'test-ah-1', action: 'setup', prompts: true });
  st = r?.result?.settings?.adminHelper;
  check(r?.ok === true && st?.installed && st.current && st.trusted && st.ready && st.prompts, `set up with prompts: ${JSON.stringify(r?.ok ? st : r)}`);
  check(fs.existsSync(installed) && bytes(installed).equals(bytes(helperExe)), '...the helper (the uiAccess one) in "Program Files"');
  check(readJson(dir('root/store.json'))?.root?.includes(signer), '...its certificate in the "Trusted Root" store');
  check(readJson(dir('root/policy.json'))?.PromptOnSecureDesktop === 0 && readJson(dir('root/own.json'))?.PromptOnSecureDesktopBefore === 1,
    `...UAC prompts on the normal desktop, the value before kept (${JSON.stringify(readJson(dir('root/policy.json')))} ${JSON.stringify(readJson(dir('root/own.json')))})`);
  check(readJson(dir('root/own.json'))?.Version === '1.22.0' || /^\d+\.\d+\.\d+$/.test(readJson(dir('root/own.json'))?.Version || ''), '...and its version noted');

  // Prompts off again: the value before comes back
  r = await bridge({ type: 'adminHelper', id: 'test-ah-2', action: 'setup', prompts: false });
  st = r?.result?.settings?.adminHelper;
  check(r?.ok === true && st?.ready && st.prompts === false && readJson(dir('root/policy.json'))?.PromptOnSecureDesktop === 1 && !('PromptOnSecureDesktopBefore' in (readJson(dir('root/own.json')) || {})),
    `prompts off: the policy back to 1 (${JSON.stringify(readJson(dir('root/policy.json')))})`);

  // Remove: all of it undone
  await bridge({ type: 'adminHelper', id: 'test-ah-3', action: 'setup', prompts: true });
  r = await bridge({ type: 'adminHelper', id: 'test-ah-4', action: 'remove' });
  st = r?.result?.settings?.adminHelper;
  check(r?.ok === true && st && !st.installed && !st.trusted && !st.prompts, `Remove: ${JSON.stringify(r?.ok ? st : r)}`);
  check(!fs.existsSync(installed) && !(readJson(dir('root/store.json'))?.root || []).includes(signer) && readJson(dir('root/policy.json'))?.PromptOnSecureDesktop === 1 && !fs.existsSync(dir('root/own.json')),
    '...the helper, its certificate and the prompts setting as they were');

  // With no policy value before: it's taken away again, not left at 1
  fs.writeFileSync(dir('root/policy.json'), '{}');
  await bridge({ type: 'adminHelper', id: 'test-ah-5', action: 'setup', prompts: true });
  check(readJson(dir('root/policy.json'))?.PromptOnSecureDesktop === 0, 'no value before: prompts on sets it');
  await bridge({ type: 'adminHelper', id: 'test-ah-6', action: 'remove' });
  check(!('PromptOnSecureDesktop' in (readJson(dir('root/policy.json')) || {})), `...and Remove takes it away again (${JSON.stringify(readJson(dir('root/policy.json')))})`);

  // A session's input through the helper (recording, never real input)
  fs.rmSync(inputPath, { force: true });
  let from = logLines().length;
  forward(['--test-rc', 'helper:begin']);
  const through = await waitLog(/Remote control: input through the input helper \(without UIAccess\)/, from, 15000);
  check(!!through, `a session starts the helper; its input goes through it (${through ? through.replace(/^.*Remote control: /, '') : 'not logged'})`);
  check(helpers() === '1', `...one helper running (${helpers()})`);
  for (const m of [{ t: 'key', c: 'KeyA', d: true }, { t: 'key', c: 'KeyA', d: false }, { t: 'text', s: 'hi' }]) forward(['--test-rc', `helper:in:${JSON.stringify(m)}`]);
  await waitLog(/\(test\) input through/, from, 5000);
  await sleep(500);
  const rec = inputLines();
  check(rec.length === 6 && rec.every(x => x.via === 'helper' && x.type === 'key'), `keys and text arrive through the helper (${rec.length} records: ${JSON.stringify(rec.map(x => [x.vk, x.scan, x.flags, x.via]))})`);
  check(rec[0]?.scan === 0x1E && rec[1]?.scan === 0x1E && (rec[1].flags & 2) === 2 && rec[2]?.scan === 'h'.charCodeAt(0), '...A down, A up, then the text as Unicode');
  from = logLines().length;
  forward(['--test-rc', 'helper:end']);
  check(!!(await waitLog(/the input helper is closed \(the session ended\)/, from, 5000)), 'the session ends: the helper is told');
  let gone = false;
  for (let i = 0; i < 30 && !gone; i++) { gone = helpers() === '0'; if (!gone) await sleep(300); }
  check(gone, '...and quits');
  fs.rmSync(inputPath, { force: true });
  forward(['--test-rc', `helper:in:${JSON.stringify({ t: 'text', s: 'x' })}`]);
  await sleep(800);
  check(inputLines().length === 0, 'after the session: no input at all');

  // The helper refuses strangers
  const token = crypto.randomBytes(32).toString('hex');
  const run = (a, ms = 20000) => spawnSync(testHelper, a, { windowsHide: true, timeout: ms });
  const notBeam = run(['--pipe', 'beam-input-stranger1', '--parent', String(process.pid), '--token', token]);
  check(notBeam.status === 4, `a parent that isn't Beam signed like it (node): refused (${notBeam.status})`);
  const pipeName = 'beam-input-stranger2';
  let helloBytes = 0;
  const fake = net.createServer(sock => { sock.on('data', d => { helloBytes += d.length; }); }).listen(`\\\\.\\pipe\\${pipeName}`);
  await sleep(300);
  const wrongPipe = await new Promise(resolve => {
    const child = spawn(testHelper, ['--pipe', pipeName, '--parent', String(app.pid), '--token', token], { windowsHide: true, stdio: 'ignore' });
    const t = setTimeout(() => { try { child.kill(); } catch {} resolve('timeout'); }, 20000);
    child.on('exit', code => { clearTimeout(t); resolve(code); });
  });
  fake.close();
  check(wrongPipe === 6 && helloBytes === 0, `a pipe whose server isn't its parent: refused before saying anything (${wrongPipe}, ${helloBytes} bytes)`);
  const badArgs = run(['--pipe', 'x']);
  check(badArgs.status === 2, `bad arguments: refused (${badArgs.status})`);

  // The helper ends with Beam
  from = logLines().length;
  forward(['--test-rc', 'helper:begin']);
  await waitLog(/input through the input helper/, from, 15000);
  check(helpers() === '1', 'a helper running again');
  await quitApp();
  gone = false;
  for (let i = 0; i < 30 && !gone; i++) { gone = helpers() === '0'; if (!gone) await sleep(300); }
  check(gone, 'Beam quits: the helper quits too');

  // No helper there: the usual way
  const cfg = readJson(cfgPath);
  cfg.testAdminHelper = dir('helper/missing.exe');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  fs.rmSync(inputPath, { force: true });
  from = logLines().length;
  startApp();
  await waitLog(/Events: connected/, from, 30000);
  forward(['--test-rc', 'helper:begin']);
  check(!!(await waitLog(/the input helper didn't start/, from, 10000)), 'a helper that isn\'t there: "didn\'t start"');
  forward(['--test-rc', `helper:in:${JSON.stringify({ t: 'text', s: 'ok' })}`]);
  await waitLog(/\(test\) input through recording/, from, 5000);
  await sleep(300);
  const usual = inputLines();
  check(usual.length === 4 && usual.every(x => !x.via), `...input goes the usual way (${usual.length} records)`);
  forward(['--test-rc', 'helper:end']);
  check(!logLines().some(l => /Task: |Admin helper \(/.test(l)), 'no task or setup errors in the log');
} catch (err) {
  check(false, `error: ${err.stack || err.message}`);
} finally {
  await quitApp();
  if (server) { try { server.kill(); } catch {} }
  ps(`Get-CimInstance Win32_Process -Filter "Name='BeamInput-test.exe'" | Where-Object { $_.ExecutablePath -eq '${testHelper.replace(/'/g, "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
  await sleep(500);
  if (!KEEP && failures.length === 0) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} } else console.log(`kept: ${TMP}`);
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall ok');
process.exit(failures.length ? 1 : 0);
