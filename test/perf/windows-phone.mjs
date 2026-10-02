#!/usr/bin/env node
// Beam for Windows 1.5: phone notifications on this PC, with a fake phone. Exits 1 if a check fails.
//
//   node test/perf/windows-phone.mjs [--exe <Beam.exe>] [--keep] [--capture <png>]
//
// Isolated like the other windows-* checks: a scratch server (this checkout's server.js, 1.5 with the
// `phone-notifications` feature) on 127.0.0.1:8807, a fake phone (this script, as an Android device) and a copy of
// Beam.exe run with --config in a temp folder (quiet: no balloons on screen, off-screen windows, no Run key, hotkeys or
// real clipboard). Nothing is clicked or typed: the tray switch and a balloon click go through test switches
// (--test-phone, --test-click-balloon); balloons are checked through beam.log, which names the app and the id only.
// Checks: the switch (this PC and from another device), balloons and their per-app coalescing, silent ones, re-sends,
// updates, removals, the click → `openPhoneNotification`, and that no notification content reaches the disk.
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
// --capture <png>: a picture of the window 1.5 s after the click opened it (does the page show the Phone panel?).
const capArg = args.indexOf('--capture');
const CAPTURE = capArg >= 0 ? path.resolve(args[capArg + 1]) : null;
const TMP = path.join(os.tmpdir(), `beam-phone-win-${Date.now()}`);
const failures = [];
const markers = []; // every title, text and line the fake phone sends: none may end up on disk
const mark = s => { markers.push(s); return s; };
const secret = what => mark(`${what}-${crypto.randomBytes(6).toString('hex')}`);

function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
}

const dir = p => path.join(TMP, p);
for (const d of ['data', 'dist', 'cfg', 'app', 'down']) fs.mkdirSync(dir(d), { recursive: true });
const cfgPath = dir('cfg/config.json');
const logPath = dir('cfg/beam.log');
const appExe = dir('app/Beam.exe');
const base = `http://127.0.0.1:${PORT}`;
const pcId = 'phonetestpc' + crypto.randomBytes(8).toString('hex');
const phoneId = 'phonetestphone' + crypto.randomBytes(8).toString('hex');
let server, app, appExit, key;

// The log's lines, without the empty string after the last newline (so `logLines().length` is where new lines start).
const logLines = () => { try { return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l, i, a) => i < a.length - 1 || l !== ''); } catch { return []; } };
const count = (re, from = 0) => logLines().slice(from).filter(l => re.test(l)).length;
async function waitLog(re, from = 0, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const lines = logLines();
    for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return lines[i];
    await sleep(150);
  }
  return null;
}

function phoneHeaders(extra = {}) {
  return { Authorization: `Bearer ${key}`, 'X-Beam-Device-Id': phoneId, 'X-Beam-Device': 'Test Phone', 'X-Beam-Platform': 'android',
    'X-Forwarded-For': '100.64.0.2', ...extra };
}
async function phone(method, p, body) {
  const res = await fetch(base + p, { method, headers: phoneHeaders(body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const devices = async () => (await phone('GET', '/api/devices')).data.devices || [];
const pcSetting = async () => { const d = (await devices()).find(x => x.id === pcId); return d && d.settings ? d.settings.phoneNotifications : undefined; };

// A notification as the phone sends it (PUT /api/phone/notifications/{key}).
let keySeq = 0;
function note(appName, extra = {}) {
  const pkg = 'com.fake.' + appName.toLowerCase().replace(/\W+/g, '');
  return { app: pkg, appName, icon: null, title: secret('title'), text: secret('text'), lines: [], conversation: null,
    when: Date.now(), silent: false, actions: [{ id: 'a0', title: 'Reply', reply: true }], ...extra };
}
async function post(n, k = `k${++keySeq}`) {
  const r = await phone('PUT', `/api/phone/notifications/${k}`, n);
  if (r.status !== 204) throw new Error(`PUT notification ${k}: ${r.status} ${JSON.stringify(r.data)}`);
  return `${phoneId}/${k}`;
}

function writeConfig() {
  const c = { server: base, key, deviceId: pcId, deviceName: 'Phone Test PC', quiet: true, testOffscreen: true, autoUpdate: false,
    autostartInitialized: true, sendToMenu: false, outbox: false, autoCopy: false, autoSave: true, saveFolder: dir('down') };
  fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2));
}
const appEnv = () => ({ ...process.env, BEAM_LOCAL_URLS: base, BEAM_TEST_PEERS: base });
function startApp() {
  const extra = CAPTURE ? ['--test-capture', CAPTURE] : [];
  app = spawn(appExe, ['--config', cfgPath, '--background', ...extra], { env: appEnv(), windowsHide: true, stdio: 'ignore' });
  appExit = undefined;
  app.on('exit', code => { appExit = code; });
}
const forward = a => spawnSync(appExe, ['--config', cfgPath, ...a], { env: appEnv(), windowsHide: true, timeout: 20000 });
async function quitApp() {
  if (!app || appExit !== undefined) return;
  forward(['--quit']);
  for (let i = 0; i < 60 && appExit === undefined; i++) await sleep(250);
  if (appExit === undefined) { try { app.kill(); } catch {} }
  await sleep(1000);
}

// Every file under `root` (the app's folder, the server's data), as bytes: none may hold a marker (UTF-8 or UTF-16).
function contentOnDisk(root) {
  const found = [];
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      let buf; try { buf = fs.readFileSync(p); } catch { continue; }
      for (const m of markers) {
        if (buf.includes(Buffer.from(m, 'utf8')) || buf.includes(Buffer.from(m, 'utf16le'))) found.push(`${path.relative(TMP, p)}: ${m.split('-')[0]}`);
      }
    }
  };
  walk(root);
  return found;
}

try {
  if (!EXE) throw new Error('No Beam.exe: build with windows\\build.cmd or pass --exe');
  fs.copyFileSync(EXE, appExe);
  console.log(`Beam: ${EXE}\ntemp: ${TMP}`);
  const out = fs.openSync(dir('server.out.log'), 'a');
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, BEAM_TAILSCALE: 'off', BEAM_HOST: '127.0.0.1', BEAM_PORT: String(PORT), BEAM_DATA: dir('data'), BEAM_DIST: dir('dist') } });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/hello')).ok) break; } catch {} await sleep(200); }
  key = fs.readFileSync(dir('data/key'), 'utf8').trim();
  const info = (await phone('GET', '/api/info')).data;
  if (!(info.features || []).includes('phone-notifications')) throw new Error('the scratch server has no phone-notifications feature (needs server 1.5)');
  await phone('GET', '/api/devices'); // registers the phone
  writeConfig();
  startApp();
  if (!(await waitLog(/Perf: connected/, 0, 30000))) throw new Error('the app never connected');
  await waitLog(/First sync/, 0, 30000);
  await sleep(1500);

  // 1. The switch: off by default; on from this PC (the tray's checkbox), off and on again from another device.
  check((await pcSetting()) === false, 'off by default (the server says phoneNotifications: false)');
  let from = logLines().length;
  const ignored = await post(note('Fake Chat'));
  await sleep(2500);
  check(count(/Notification: .*phone notification/, from) === 0, 'off: no balloon for a notification');
  from = logLines().length;
  forward(['--test-phone', 'on']);
  check(!!(await waitLog(/Phone notifications on for this PC \(test\)/, from, 5000)), 'the switch (as the tray checkbox) turns it on');
  let on = false;
  for (let i = 0; i < 40 && !on; i++) { on = (await pcSetting()) === true; if (!on) await sleep(250); }
  check(on, 'the server has it on for this PC');
  for (const [value, word] of [[false, 'off'], [true, 'on']]) {
    from = logLines().length;
    await phone('PUT', `/api/devices/${pcId}/settings`, { phoneNotifications: value });
    const re = new RegExp(`Phone notifications are ${word} for this PC`);
    const atOnce = !!(await waitLog(re, from, 8000));
    check(atOnce, `turned ${word} from another device: this PC follows at once (an urgent devices event)`);
    if (!atOnce) {
      // The server held the `devices` event (background stream): a stream check delivers it; the app must follow then.
      forward(['--test-poke']);
      check(!!(await waitLog(re, from, 8000)), `...and once the held devices event arrives`);
    }
  }
  await sleep(1000);

  // 2. Balloons: one per notification, at most one per app per 5 s; the others wait and come as "N new from <app>".
  from = logLines().length;
  const first = await post(note('Fake Chat', { lines: [mark('Mom: ' + secret('line')), mark('Dad: ' + secret('line'))], conversation: 'Family' }));
  const shownFirst = await waitLog(new RegExp(`Notification: phone notification from Fake Chat \\(${first.replace(/[/]/g, '\\/')}\\)`), from, 5000);
  check(!!shownFirst, 'a balloon for a new notification (beam.log names the app and the id only)');
  const t0 = Date.now();
  const burst = [];
  for (let i = 0; i < 3; i++) { burst.push(await post(note('Fake Chat'))); await sleep(200); }
  const other = await post(note('Fake Mail'));
  check(!!(await waitLog(new RegExp(`Notification: phone notification from Fake Mail \\(${other.replace(/[/]/g, '\\/')}\\)`), from, 3000)), 'another app gets its own balloon at once');
  const coalesced = await waitLog(/Notification: 3 phone notifications from Fake Chat \(latest /, from, 9000);
  check(!!coalesced && coalesced.includes(burst[2]), 'three more from the same app within 5 s: one balloon "3 new from Fake Chat" (the latest selected)');
  check(Date.now() - t0 >= 4000, 'that one waited for the 5 s window');
  check(count(/Notification: phone notification from Fake Chat/, from) === 1, 'no other balloon for that app meanwhile');
  await sleep(5500);

  // 3. Silent ones, re-sends and updates.
  from = logLines().length;
  await post(note('Fake Chat', { silent: true }));
  await sleep(2000);
  check(count(/Notification: .*phone notification/, from) === 0, 'a silent notification: no balloon');
  const same = note('Quiet App');
  const sameId = await post(same, 'resend');
  check(!!(await waitLog(/Notification: phone notification from Quiet App/, from, 4000)), 'a new one from a third app: a balloon');
  await sleep(5500);
  from = logLines().length;
  await post(same, 'resend');
  await sleep(2000);
  check(count(/Notification: .*phone notification/, from) === 0, 'the same notification sent again (e.g. after a server restart): no balloon');
  await post({ ...same, lines: [mark('Ann: ' + secret('line'))], when: Date.now() }, 'resend');
  check(!!(await waitLog(new RegExp(`Notification: phone notification from Quiet App \\(${sameId.replace(/[/]/g, '\\/')}\\)`), from, 4000)), 'an update with new content: a balloon');
  await sleep(5500);
  from = logLines().length;
  await post(note('Quiet App', { resent: true, posted: Date.now() - 60 * 60 * 1000 }), 'old');
  await sleep(2000);
  check(count(/Notification: .*phone notification/, from) === 0, 'one the phone sends again (resent: true, after a server restart), first seen here: no balloon');

  // 3b. Late messages still pop up: the app's own time (`when`) may be long ago; the phone's post time (`posted`) and
  // `resent` decide. Through the server when it passes them on, and as events straight into the app (test switch).
  const viaServer = async (k, extra) => {
    const id = await post(note('Late App', extra), k);
    await sleep(300);
    const asPc = { Authorization: `Bearer ${key}`, 'X-Beam-Device-Id': pcId, 'X-Beam-Device': 'Phone Test PC', 'X-Beam-Platform': 'windows' };
    const list = await fetch(`${base}/api/phone/notifications`, { headers: asPc }).then(x => x.json()).catch(() => ({}));
    const n = (list.notifications || []).find(x => x.id === id);
    return { id, passes: !!(n && n.posted) };
  };
  from = logLines().length;
  const late = await viaServer('late', { when: Date.now() - 30 * 60 * 1000, posted: Date.now() });
  if (late.passes) check(!!(await waitLog(new RegExp(`phone notification from Late App \\(${late.id.replace(/[/]/g, '\\/')}\\)`), from, 4000)), 'a message that reached the phone 30 min late (old `when`, new `posted`): a balloon');
  else console.log('     (the server doesn\'t pass `posted` on yet: checked with events below)');
  await sleep(5500);
  const inject = (k, appName, extra) => {
    const n = { id: `${phoneId}/${k}`, device: phoneId, deviceName: 'Test Phone', at: Date.now(), ...note(appName), ...extra };
    forward(['--test-event', 'notification', JSON.stringify(n)]);
    return n.id;
  };
  from = logLines().length;
  const lateId = inject('inj-late', 'Mail App', { when: Date.now() - 2 * 3600 * 1000, posted: Date.now() });
  check(!!(await waitLog(new RegExp(`phone notification from Mail App \\(${lateId.replace(/[/]/g, '\\/')}\\)`), from, 4000)), 'an e-mail from 2 h ago that just arrived (old `when`, new `posted`): a balloon');
  from = logLines().length;
  inject('inj-resent', 'Resent App', { when: Date.now(), posted: Date.now(), resent: true });
  inject('inj-old', 'Old Phone App', { when: Date.now() - 2 * 3600 * 1000 }); // a phone that sends neither: `when` decides
  await sleep(2000);
  check(count(/Notification: .*phone notification/, from) === 0, 'resent: true, or (from a phone without `posted`) an old `when` first seen now: no balloon');

  // 4. A notification removed while it waits for its app's window: no balloon for it.
  from = logLines().length;
  const shown = await post(note('Fake Chat'));
  await waitLog(new RegExp(`phone notification from Fake Chat \\(${shown.replace(/[/]/g, '\\/')}\\)`), from, 4000);
  await post(note('Fake Chat'), 'gone');
  await sleep(300);
  const del = await phone('DELETE', '/api/phone/notifications/gone');
  check(del.status === 204, 'the phone removes the waiting one');
  await sleep(6000);
  check(count(/Notification: .*phone notification/, from) === 1, 'removed while waiting: no second balloon');

  // 5. A click on the last balloon opens the chat window on the Phone panel: `openPhoneNotification { id }`.
  from = logLines().length;
  forward(['--test-click-balloon']);
  const opened = await waitLog(/Web window: openPhoneNotification /, from, 60000);
  const after = logLines().slice(from);
  const readyAt = after.findIndex(l => /Perf: open \w+: bridge ready/.test(l));
  const sentAt = after.findIndex(l => /Web window: openPhoneNotification /.test(l));
  check(!!opened && opened.includes(shown), 'a click on the balloon: the window opens and the page gets openPhoneNotification with its id');
  check(readyAt >= 0 && readyAt < sentAt, 'the window was closed: the message waited for the page\'s hello');
  await sleep(3000);
  if (CAPTURE) console.log(`     capture: ${fs.existsSync(CAPTURE) ? CAPTURE : 'none'}`);

  // 5b. Balloons of two apps due at the same moment become one ("New on your phone"); its click still opens the Phone
  // panel, on the latest of them.
  forward(['--hide']);
  await sleep(1500);
  from = logLines().length;
  const m1 = await post(note('Merge One'));
  const m2 = await post(note('Merge Two'));
  const merged = await waitLog(/Notification: .*Merge One.*Merge Two|Notification: .*Merge Two.*Merge One/, from, 4000);
  check(!!merged, 'two apps at once: one balloon for both');
  from = logLines().length;
  forward(['--test-click-balloon']);
  const opened2 = await waitLog(/Web window: openPhoneNotification /, from, 30000);
  check(!!opened2 && opened2.includes(m2), 'its click opens the Phone panel on the latest one');
  check(!!m1, '(the first of the two was sent too)');
  forward(['--hide']);
  await sleep(1000);
  // The newest wins, not the app that flushed last: Alpha's and Beta's waiting ones come due together (Alpha's bucket
  // first), and Alpha's is the newer.
  await post(note('Merge Alpha'));
  await post(note('Merge Beta'));
  await sleep(1000);
  await post(note('Merge Beta'));
  await sleep(1000);
  const newest = await post(note('Merge Alpha'));
  from = logLines().length;
  const pair = await waitLog(/Notification: .*Merge Alpha.*Merge Beta|Notification: .*Merge Beta.*Merge Alpha/, from, 8000);
  from = logLines().length;
  forward(['--test-click-balloon']);
  const opened3 = await waitLog(/Web window: openPhoneNotification /, from, 30000);
  check(!!pair && !!opened3 && opened3.includes(newest), 'two apps\' waiting ones due together: the click opens the newest notification');
  forward(['--hide']);
  await sleep(1000);

  // 6. Off again from this PC: nothing more arrives.
  from = logLines().length;
  forward(['--test-phone', 'off']);
  await waitLog(/Phone notifications off for this PC \(test\)/, from, 5000);
  let off = false;
  for (let i = 0; i < 40 && !off; i++) { off = (await pcSetting()) === false; if (!off) await sleep(250); }
  check(off, 'the switch turns it off on the server');
  await post(note('Fake Chat'));
  await sleep(2500);
  check(count(/Notification: .*phone notification/, from) === 0, 'off: no balloon');
  check(ignored.length > 0, '(the first notification was sent while off)');

  // 6b. Switching on with an older device list held back on this PC's stream (this PC still off in it; the server
  // delivers it with the next urgent event): it mustn't undo the switch nor drop the notifications that follow.
  await phone('PUT', `/api/devices/${phoneId}/settings`, { phoneNotifications: true }); // a `devices` event, held for the PC
  await sleep(500);
  from = logLines().length;
  forward(['--test-phone', 'on']);
  for (let i = 0; i < 200 && (await pcSetting()) !== true; i++) await sleep(20);
  const rush = [];
  for (let i = 0; i < 6; i++) rush.push(await post(note(i % 2 ? 'Rush One' : 'Rush Two')));
  await sleep(7000);
  check(count(/Phone notifications are off for this PC/, from) === 0, 'switched on here: an older device list held back doesn\'t switch it off');
  check(count(/Notification: .*phone notification/, from) >= 2, 'the notifications right after switching on: balloons (one per app at least)');
  check(rush.length === 6, '(six were sent)');

  // 6c. "Show message text in pop-ups" off (this PC's own setting): balloons name the app and the count only.
  await quitApp();
  const cfgNow = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfgNow, phonePopupText: false }, null, 2));
  from = logLines().length;
  startApp();
  await waitLog(/Perf: connected/, from, 30000);
  await sleep(2000);
  from = logLines().length;
  await post(note('Hidden Text'));
  check(!!(await waitLog(/Notification: phone notification from Hidden Text \(.*\), text hidden/, from, 4000)), 'text off: "<app> · new notification" without the message');
  for (let i = 0; i < 3; i++) await post(note('Hidden Text'));
  check(!!(await waitLog(/Notification: 3 phone notifications from Hidden Text \(latest .*\), text hidden/, from, 9000)), 'text off: "3 new from <app>" without the messages');
  check(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).phonePopupText === false, 'the option is kept on this PC (config.json)');
  forward(['--test-phone', 'off']);
  await sleep(1500);
  await quitApp();

  // 7. No notification content on disk: the app's folder (log, settings, state, the window's WebView2 profile) and the
  // scratch server's data.
  const appFiles = contentOnDisk(dir('cfg'));
  check(appFiles.length === 0, `no notification content in the app's files (${markers.length} test strings checked)` + (appFiles.length ? ': ' + appFiles.slice(0, 5).join(', ') : ''));
  const serverFiles = contentOnDisk(dir('data'));
  check(serverFiles.length === 0, 'no notification content in the scratch server\'s data' + (serverFiles.length ? ': ' + serverFiles.slice(0, 5).join(', ') : ''));
} catch (e) {
  check(false, 'error: ' + (e.message || e));
} finally {
  try { await quitApp(); } catch {}
  try { server && server.kill(); } catch {}
  const dirWin = TMP.replace(/'/g, "''");
  spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe' or Name='Beam.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dirWin}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { windowsHide: true });
  await sleep(500);
  if (KEEP) console.log('kept ' + TMP);
  else { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
}
console.log(failures.length ? `${failures.length} check(s) failed` : 'all phone notification checks passed');
process.exit(failures.length ? 1 : 0);
