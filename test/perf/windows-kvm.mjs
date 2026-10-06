#!/usr/bin/env node
// Beam for Windows 1.12: keyboard and mouse across PCs, end to end, with two test instances of the app on this PC:
// "KVM Test Laptop" (its keyboard and mouse: no hooks in a test instance, --test-kvm stands in for them) and "KVM Test
// SHOP" (the PC beside it, its input through the RECORDING backend). Exits 1 if a check fails.
//
//   node test/perf/windows-kvm.mjs [--exe <Beam.exe>] [--keep]
//
// Isolated like windows-rc: a scratch server (this checkout's server.js) on 127.0.0.1:8806 with a fake Tailscale
// LocalAPI whose own addresses are this PC's real Tailscale addresses (the two pages really connect over WebRTC here),
// the PC's fake `tailscale` CLI, and --config instances (quiet, off-screen windows, no hotkeys, the test clipboard).
// Nothing real is moved, clicked or typed. A kvm session captures nothing, so no "sharing your screen" bar appears.
// 1.12.1 (the user's first day: Office Desktop froze once its chat window opened mid-session): the PC's chat window opens
// during the session with no window of another process inside Beam's (web views hosted window to visual, so no input
// queue shared with WebView2's processes), and the banner's pill keeps Hide.
// 1.12.2 (the stuck release was the real cause): the PC's UI thread held 4 s, the laptop's press and release still go in.
// 1.12.4: pictures through the clipboard both ways (several 48 KB parts on `clip`), none taken as a PC connects, and the
// PC's page kept warm after a session (the next one starts on it).
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = 8806;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const exeArg = args.indexOf('--exe');
const EXE = exeArg >= 0 ? args[exeArg + 1] : [path.join(ROOT, 'windows', 'bin', 'Beam.exe'), path.join(ROOT, 'dist', 'Beam.exe')].find(f => fs.existsSync(f));
const KEEP = args.includes('--keep');
const TMP = path.join(os.tmpdir(), `beam-kvm-win-${Date.now()}`);
const failures = [];
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
  return ok;
}

const dir = p => path.join(TMP, p);
for (const d of ['data', 'dist', 'pc', 'laptop', 'app', 'ts']) fs.mkdirSync(dir(d), { recursive: true });
const appExe = dir('app/Beam.exe');
const base = `http://127.0.0.1:${PORT}`;
const pcId = 'kvmtestshop' + crypto.randomBytes(8).toString('hex');
const laptopId = 'kvmtestlaptop' + crypto.randomBytes(8).toString('hex');
const isTs = a => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a) || /^fd7a:115c:a1e0:/i.test(a);
const selfIps = [...new Set(Object.values(os.networkInterfaces()).flat().map(a => a.address).filter(isTs))];
let server, key, tsPipe;

// ---------------------------------------------------------------- the two instances
const inst = {
  pc: { id: pcId, name: 'KVM Test SHOP', dir: dir('pc'), proc: null, exit: undefined },
  laptop: { id: laptopId, name: 'KVM Test Laptop', dir: dir('laptop'), proc: null, exit: undefined },
};
const cfgOf = i => path.join(i.dir, 'config.json');
const lines = i => { try { return fs.readFileSync(path.join(i.dir, 'beam.log'), 'utf8').split(/\r?\n/).filter(Boolean); } catch { return []; } };
async function waitLog(i, re, from = 0, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const l = lines(i);
    for (let k = from; k < l.length; k++) if (re.test(l[k])) return l[k];
    await sleep(100);
  }
  return null;
}
const count = (i, re, from = 0) => lines(i).slice(from).filter(l => re.test(l)).length;
const appEnv = () => ({ ...process.env, BEAM_LOCAL_URLS: base, BEAM_TEST_PEERS: base });
function writeConfig(i, extra = {}) {
  fs.writeFileSync(cfgOf(i), JSON.stringify({ server: base, key, deviceId: i.id, deviceName: i.name, quiet: true, testOffscreen: true, autoUpdate: false,
    autostartInitialized: true, sendToMenu: false, outbox: false, autoCopy: false, autoSave: false, ...extra }, null, 2));
}
function start(i) {
  i.proc = spawn(appExe, ['--config', cfgOf(i), '--background'], { env: appEnv(), windowsHide: true, stdio: 'ignore' });
  i.exit = undefined;
  i.proc.on('exit', code => { i.exit = code; });
}
const forward = (i, a) => spawnSync(appExe, ['--config', cfgOf(i), ...a], { env: appEnv(), windowsHide: true, timeout: 20000 });
const kvm = cmd => forward(inst.laptop, ['--test-kvm', cmd]);
const rc = cmd => forward(inst.pc, ['--test-rc', cmd]);
async function quit(i) {
  if (!i.proc || i.exit !== undefined) return;
  forward(i, ['--quit']);
  for (let k = 0; k < 80 && i.exit === undefined; k++) await sleep(250);
  if (i.exit === undefined) { try { i.proc.kill(); } catch {} }
}
const readConfig = i => JSON.parse(fs.readFileSync(cfgOf(i), 'utf8'));
const inputLines = () => { try { return fs.readFileSync(path.join(inst.pc.dir, 'rc-input.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
async function waitInput(pred, from, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const found = inputLines().slice(from).find(pred);
    if (found) return found;
    await sleep(100);
  }
  return null;
}
// The windows of other processes inside a process's own windows (a web view hosted windowed puts WebView2's there,
// which attaches its input queue to the app's UI thread), as "class (pid)"; null when PowerShell couldn't tell.
// Read-only: it enumerates windows and asks which process owns each.
fs.writeFileSync(dir('child-windows.ps1'), `param([int]$ProcessId)
Add-Type @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class KvmTestWins {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static List<string> Foreign(uint pid) {
    var found = new List<string>();
    EnumWindows((top, l) => {
      uint p; GetWindowThreadProcessId(top, out p);
      if (p == pid) EnumChildWindows(top, (c, l2) => {
        uint cp; GetWindowThreadProcessId(c, out cp);
        if (cp != pid) { var s = new StringBuilder(256); GetClassName(c, s, 256); found.Add(s + " (" + cp + ")"); }
        return true;
      }, IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
"windows: " + ([KvmTestWins]::Foreign([uint32]$ProcessId) -join ', ')
`);
function foreignChildren(pid) {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', dir('child-windows.ps1'), '-ProcessId', String(pid)], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const m = /^windows: (.*)$/m.exec(r.stdout || '');
  return m ? m[1].split(', ').filter(Boolean) : null;
}

// (1.12.4) A PNG of w×h noise (it doesn't compress: several 48 KB parts), and a PNG's size.
function noisePng(w, h, seed) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8 bits, RGB
  ihdr[9] = 2;
  const row = w * 3 + 1, raw = Buffer.alloc(row * h);
  let x = seed >>> 0;
  for (let y = 0; y < h; y++) for (let i = 1; i < row; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; raw[y * row + i] = x >>> 24; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const pngSize = file => { try { const b = fs.readFileSync(file); return [b.readUInt32BE(16), b.readUInt32BE(20)]; } catch { return null; } };

// Where the laptop's pointer is (--test-kvm where): { here, x, y } or { on, screen, w, h, scale, x, y }.
async function where() {
  const n = lines(inst.laptop).length;
  kvm('where');
  const l = await waitLog(inst.laptop, /Keyboard and mouse: \(test\) (here|on) /, n, 5000);
  if (!l) return null;
  let m = /\(test\) here at (-?\d+),(-?\d+)/.exec(l);
  if (m) return { here: true, x: +m[1], y: +m[2], line: l };
  m = /\(test\) on (.+?) screen (\d+) \((\d+)x(\d+) at (\d+)%\) at (-?\d+),(-?\d+)/.exec(l);
  return m ? { on: m[1], screen: +m[2], w: +m[3], h: +m[4], scale: +m[5] / 100, x: +m[6], y: +m[7], line: l } : { line: l };
}
async function pcState() {
  const n = lines(inst.pc).length;
  rc('kvmstate');
  return waitLog(inst.pc, /\(test\) kvm /, n, 5000);
}
const MOVE = 0x0001 | 0x8000 | 0x4000, LEFTDOWN = 0x0002, LEFTUP = 0x0004, WHEEL = 0x0800, SCAN = 0x0008, KEYUP = 0x0002;

// ---------------------------------------------------------------- the fake tailnet (as windows-rc)
function fakeLocalApi() {
  const where2 = `\\\\.\\pipe\\beam-kvm-test-ts-${process.pid}`;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://local-tailscaled.sock');
    const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/localapi/v0/status') return reply(200, { Self: { ID: 'nSELF', HostName: 'kvm-test-machine', DNSName: 'kvm-test-machine.tail0000.ts.net.', TailscaleIPs: selfIps, UserID: 4242 }, Peer: {}, User: { 4242: { LoginName: 'owner@example.com' } } });
    if (u.pathname === '/localapi/v0/whois') return reply(404, {});
    if (u.pathname === '/localapi/v0/serve-config') return reply(200, {});
    reply(404, {});
  });
  return new Promise(r => srv.listen(where2, () => r({ socket: where2, close: () => new Promise(c => srv.close(c)) })));
}
const tsState = { owner: 4242, nodes: {} };
for (const ip of selfIps) tsState.nodes[ip] = { id: 'nTESTNODE1', name: 'kvm-test-machine', owner: 4242 };
fs.writeFileSync(dir('ts/state.json'), JSON.stringify(tsState));
fs.writeFileSync(dir('ts/fake-tailscale.mjs'), `
import fs from 'node:fs';
const st = JSON.parse(fs.readFileSync(new URL('./state.json', import.meta.url), 'utf8'));
const [cmd, ...rest] = process.argv.slice(2);
const ips = Object.keys(st.nodes);
if (cmd === 'status') { console.log(JSON.stringify({ Self: { UserID: st.owner, TailscaleIPs: ips }, User: { [st.owner]: { LoginName: 'owner@example.com' } }, Peer: {} })); process.exit(0); }
if (cmd === 'whois') {
  const ip = rest[rest.length - 1];
  const n = st.nodes[ip];
  if (!n) { console.error('peer not found'); process.exit(1); }
  const addrs = ips.filter(a => st.nodes[a].id === n.id).map(a => a + (a.includes(':') ? '/128' : '/32'));
  console.log(JSON.stringify({ Node: { StableID: n.id, ComputedName: n.name, Name: n.name + '.tail0000.ts.net.', User: n.owner, Addresses: addrs }, UserProfile: { ID: n.owner, LoginName: 'owner@example.com' } }));
  process.exit(0);
}
process.exit(2);
`);

async function startServer() {
  const out = fs.openSync(dir('server.out.log'), 'a');
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, BEAM_TAILSCALE: '', BEAM_TAILSCALE_SOCKET: tsPipe.socket, BEAM_HOST: '127.0.0.1', BEAM_PORT: String(PORT), BEAM_DATA: dir('data'), BEAM_DIST: dir('dist') } });
  for (let k = 0; k < 150; k++) { try { if ((await fetch(base + '/api/hello')).ok) return; } catch {} await sleep(200); }
  throw new Error('the scratch server didn\'t start');
}
// (as a third device, a phone watching: /api/rc routes need a device)
const api = async (p, init = {}) => { const r = await fetch(base + p, { ...init, headers: { Authorization: `Bearer ${key}`, 'X-Beam-Device-Id': 'kvmtestwatcher0001', 'X-Beam-Device': 'KVM Test Phone', 'X-Beam-Platform': 'android', ...(init.headers || {}) } }); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

// ---------------------------------------------------------------- the run
try {
  if (!EXE) throw new Error('No Beam.exe: build with windows\\build.cmd or pass --exe');
  if (!selfIps.length) throw new Error('This PC has no Tailscale address: the WebRTC part needs one (both ends run here)');
  fs.copyFileSync(EXE, appExe);
  console.log(`Beam: ${EXE}\ntemp: ${TMP}`);
  tsPipe = await fakeLocalApi();
  await startServer();
  key = fs.readFileSync(dir('data/key'), 'utf8').trim();
  check(((await api('/api/info')).features || []).includes('kvm'), 'the scratch server takes kvm sessions (1.16)');
  writeConfig(inst.pc, { testTailscaleExe: process.execPath, testTailscaleArgs: `"${dir('ts/fake-tailscale.mjs')}"`, testRcLeaseSec: 3 });
  writeConfig(inst.laptop);
  start(inst.pc);
  start(inst.laptop);
  for (const i of [inst.pc, inst.laptop]) if (!(await waitLog(i, /Perf: connected/, 0, 30000))) throw new Error(i.name + ' never connected');
  for (const i of [inst.pc, inst.laptop]) forward(i, ['--test-mode', 'foreground']);
  await sleep(1500);

  // 1. The PC beside allows the laptop (at the PC itself); the laptop turns it on with that PC to its left.
  let n = lines(inst.pc).length;
  rc(`allow:${laptopId}`);
  check(!!(await waitLog(inst.pc, /Remote control: allowed on this PC \(test\), for KVM Test Laptop$/, n, 8000)), 'SHOP allows the laptop (at SHOP)');
  await sleep(1500);
  // (1.12.3) SHOP has text on its clipboard before the laptop turns this on: it must stay off the laptop's clipboard
  // until the pointer has been there (it was taken as SHOP connected: an overflowed "the pointer just left it").
  fs.writeFileSync(path.join(inst.pc.dir, 'clipboard-in.txt'), 'shop clip from before');
  let nl = lines(inst.laptop).length;
  n = lines(inst.pc).length;
  kvm(`on:${pcId}`);
  check(!!(await waitLog(inst.laptop, /Keyboard and mouse: on \(test\): KVM Test SHOP to the left of this PC/, nl, 10000)), 'the laptop turns it on, SHOP to its left');
  check(!!(await waitLog(inst.pc, /KVM Test Laptop asks to share its keyboard and mouse with this PC/, n, 15000)), 'SHOP hears a kvm request');
  check(!!(await waitLog(inst.pc, /banner up: KVM Test Laptop \(kvm-test-machine · .*\) shares its keyboard and mouse$/, n, 10000)), 'SHOP shows its banner (no banner, no session)');
  check(!!(await waitLog(inst.pc, /its page \(no capture: keyboard and mouse only\) is up/, n, 20000)), 'SHOP starts its page without any capture');
  check(!!(await waitLog(inst.pc, /KVM Test Laptop's keyboard and mouse can reach this PC \(peer .* is kvm-test-machine, checked\)/, n, 30000)), 'SHOP checked the peer: the laptop can reach it');
  const ready = await waitLog(inst.laptop, /Keyboard and mouse: KVM Test SHOP is ready \(/, nl, 30000);
  check(!!ready, `the laptop checked its peer and has Shop's screens: ${ready ? ready.replace(/.*is ready /, '') : 'not ready'}`);
  check(count(inst.pc, /a screen capture was allowed/, n) === 0 && count(inst.pc, /Remote control: capturing/, n) === 0, 'nothing was captured');
  await sleep(1500); // (Shop's clipboard goes to the laptop as the sync starts)
  let lapClipNow = null;
  try { lapClipNow = fs.readFileSync(path.join(inst.laptop.dir, 'clipboard.txt'), 'utf8'); } catch {}
  check(lapClipNow !== 'shop clip from before' && count(inst.laptop, /clipboard text is on this PC's clipboard/, nl) === 0, `Shop's clipboard text stays off the laptop's as it connects (${lapClipNow === null ? 'nothing there' : JSON.stringify(lapClipNow)})`);
  const sessions = (await api('/api/rc/sessions')).sessions || [];
  check(sessions.length === 1 && sessions[0].kind === 'kvm' && sessions[0].state === 'live' && sessions[0].host === pcId && sessions[0].viewer === laptopId, 'the server lists one live kvm session');
  let st = await pcState();
  check(!!st && /kvm live, not here, banner shown, update may go/.test(st), `SHOP: live, the pointer not there, an update may go (${st})`);

  // (1.12.1) Shop's chat window opened during the session (the user's Office Desktop froze for 5 minutes then): its web
  // views hold no window of another process (hosted window to visual), so no input queue is shared with WebView2's.
  forward(inst.pc, []);
  check(!!(await waitLog(inst.pc, /Perf: open \w+: (page loaded|bridge ready)/, 0, 20000)), 'SHOP\'s chat window opens during the session');
  check(count(inst.pc, /WebView2: hosting mode COREWEBVIEW2_HOSTING_MODE_WINDOW_TO_VISUAL/) >= 1, 'SHOP hosts its web views window to visual');
  for (const [who, i] of [['SHOP', inst.pc], ['the laptop', inst.laptop]]) {
    const foreign = foreignChildren(i.proc.pid);
    check(foreign !== null && foreign.length === 0, `${who}'s windows hold no window of another process (${foreign === null ? 'not readable' : foreign.join(', ') || 'none'})`);
  }

  // 2. Over the edge: onto Shop's main screen at its right edge, at the same height.
  fs.rmSync(path.join(inst.pc.dir, 'rc-input.jsonl'), { force: true });
  nl = lines(inst.laptop).length;
  kvm('edge:0.5');
  check(!!(await waitLog(inst.laptop, /Keyboard and mouse: \(test\) on KVM Test SHOP/, nl, 5000)), 'the pointer at the laptop\'s left edge goes over to SHOP');
  let w = await where();
  check(!!w && w.on === 'KVM Test SHOP' && w.x === w.w - 1 && w.y === Math.round(0.5 * (w.h - 1)), `...onto its right edge at half height (${w && w.line})`);
  check(!!(await waitInput(r => r.type === 'mouse' && r.flags === MOVE, 0, 5000)), 'SHOP moved its pointer there (recorded, not real)');
  st = await pcState();
  check(!!st && /here, banner shown, update waits/.test(st), `SHOP knows the pointer is there: its update would wait (${st})`);
  const scale = w.scale;
  let i0 = inputLines().length;
  kvm('move:-100,0');
  let w2 = await where();
  check(!!w2 && w2.x === w.x - Math.trunc(100 * scale + 1e-9) && w2.y === w.y, `a move of 100 px on the laptop moves it ${Math.trunc(100 * scale + 1e-9)} px on SHOP at ${Math.round(scale * 100)}% (${w2 && w2.line})`);
  check(!!(await waitInput(r => r.type === 'mouse' && r.flags === MOVE, i0, 4000)), '...as a move there');

  // (1.12.2) Shop's UI thread held for 4 s, as Windows' modal loop holds it while one of Beam's own title bar buttons is
  // pressed with the laptop's mouse (the user's Camera and Shop Desktop stayed stuck until clicked there: the release
  // came through that thread): the laptop's press, move and release still go in there meanwhile, from the page's thread.
  i0 = inputLines().length;
  n = lines(inst.pc).length;
  rc('uiblock:4000');
  check(!!(await waitLog(inst.pc, /\(test\) the UI thread is held for 4000 ms/, n, 5000)), 'SHOP\'s UI thread is held (4 s)');
  kvm('btn:0:down');
  kvm('move:-20,0');
  kvm('btn:0:up');
  const heldUp = await waitInput(r => r.type === 'mouse' && (r.flags & LEFTUP), i0, 3500);
  const stillHeld = count(inst.pc, /\(test\) the UI thread is free again/, n) === 0;
  const heldDown = inputLines().slice(i0).find(r => r.type === 'mouse' && (r.flags & LEFTDOWN));
  check(!!heldDown && !!heldUp && stillHeld, `...and the laptop's press and release went in there meanwhile (${heldUp ? (stillHeld ? 'while held' : 'only after') : 'not at all'})`);
  check(!!(await waitLog(inst.pc, /\(test\) the UI thread is free again/, n, 8000)), '...then the UI thread is free again');
  st = await pcState();
  check(!!st && /kvm live, here/.test(st), `Shop's session goes on (${st})`);

  // 3. A click, the wheel and a key go along; this PC gets none of them (the hooks would keep them).
  i0 = inputLines().length;
  kvm('btn:0:down');
  kvm('btn:0:up');
  const down = await waitInput(r => r.type === 'mouse' && (r.flags & LEFTDOWN), i0, 4000);
  const up = await waitInput(r => r.type === 'mouse' && (r.flags & LEFTUP), i0, 4000);
  check(!!down && !!up && (down.flags & MOVE) === MOVE, 'a left click, at the pointer\'s place there');
  i0 = inputLines().length;
  kvm('wheel:120');
  const wheel = await waitInput(r => r.type === 'mouse' && (r.flags & WHEEL), i0, 4000);
  check(!!wheel && wheel.data === 120, `the wheel one notch away from you: WHEEL +120 there (${wheel && wheel.data})`);
  i0 = inputLines().length;
  kvm('key:65,30,0:down');
  kvm('key:65,30,0:up');
  const kd = await waitInput(r => r.type === 'key' && r.scan === 30 && r.flags === SCAN, i0, 4000);
  const ku = await waitInput(r => r.type === 'key' && r.scan === 30 && r.flags === (SCAN | KEYUP), i0, 4000);
  check(!!kd && !!ku, 'the A key goes down and up there (its scancode)');

  // 4. The clipboard: the laptop's text goes along when the pointer does; text copied there comes back.
  fs.writeFileSync(path.join(inst.laptop.dir, 'clipboard-in.txt'), 'kvm clip from the laptop');
  nl = lines(inst.laptop).length;
  kvm('move:5000,0'); // (back)
  check(!!(await waitLog(inst.laptop, /Keyboard and mouse: \(test\) back on this PC/, nl, 5000)), 'moved right past SHOP\'s right edge: back on the laptop');
  w = await where();
  check(!!w && w.here && w.x === 1, `...at its left edge (${w && w.line})`);
  st = await pcState();
  check(!!st && /not here/.test(st), 'SHOP knows the pointer left');
  kvm('edge:0.3');
  const pcClip = path.join(inst.pc.dir, 'clipboard.txt');
  let got = null;
  for (let k = 0; k < 40 && got !== 'kvm clip from the laptop'; k++) { await sleep(100); try { got = fs.readFileSync(pcClip, 'utf8'); } catch {} }
  check(got === 'kvm clip from the laptop', `the laptop's clipboard text went to SHOP with the pointer (${got})`);
  fs.writeFileSync(path.join(inst.pc.dir, 'clipboard-in.txt'), 'kvm clip from shop');
  const lapClip = path.join(inst.laptop.dir, 'clipboard.txt');
  got = null;
  for (let k = 0; k < 60 && got !== 'kvm clip from shop'; k++) { await sleep(100); try { got = fs.readFileSync(lapClip, 'utf8'); } catch {} }
  check(got === 'kvm clip from shop', `text copied on SHOP is on the laptop's clipboard (${got})`);

  // 4b. (1.12.4) Pictures (the user: a screenshot pasted "just pasted the text that was already copied"): the laptop's
  // goes to SHOP as the pointer does when it has no text, in parts on `clip`; Shop's comes back while the pointer is there.
  nl = lines(inst.laptop).length;
  kvm('move:5000,0');
  await waitLog(inst.laptop, /Keyboard and mouse: \(test\) back on this PC/, nl, 5000);
  fs.rmSync(path.join(inst.laptop.dir, 'clipboard-in.txt'), { force: true });
  const lapPng = noisePng(300, 200, 7);
  fs.writeFileSync(path.join(inst.laptop.dir, 'clipboard-in.png'), lapPng);
  for (const x of ['clipboard.png', 'clipboard-image.txt']) fs.rmSync(path.join(inst.pc.dir, x), { force: true });
  nl = lines(inst.laptop).length;
  n = lines(inst.pc).length;
  kvm('edge:0.5');
  const imgWent = await waitLog(inst.laptop, /this PC's clipboard picture went to KVM Test SHOP \(\d+ KB\)/, nl, 8000);
  check(!!imgWent && lapPng.length > 2 * 48 * 1024, `the laptop's picture goes to SHOP with the pointer (${Math.round(lapPng.length / 1024)} KB, ${Math.ceil(lapPng.length / 49152)} parts)`);
  const pcHas = await waitLog(inst.pc, /the viewer's clipboard picture is on this PC's clipboard \(300×200\)/, n, 8000);
  let pcImg = null;
  try { pcImg = fs.readFileSync(path.join(inst.pc.dir, 'clipboard-image.txt'), 'utf8'); } catch {}
  check(!!pcHas && /^png remote/.test(pcImg || '') && JSON.stringify(pngSize(path.join(inst.pc.dir, 'clipboard.png'))) === '[300,200]', `...and is on Shop's clipboard, marked as remote (${pcImg})`);
  fs.rmSync(path.join(inst.pc.dir, 'clipboard-in.txt'), { force: true });
  await sleep(1500); // (Shop's test clipboard is looked at every second)
  for (const x of ['clipboard.png', 'clipboard-image.txt']) fs.rmSync(path.join(inst.laptop.dir, x), { force: true });
  nl = lines(inst.laptop).length;
  fs.writeFileSync(path.join(inst.pc.dir, 'clipboard-in.png'), noisePng(240, 160, 11));
  const lapHas = await waitLog(inst.laptop, new RegExp(`${inst.pc.name}'s clipboard picture is on this PC's clipboard \\(240×160\\)`), nl, 10000); // (the name: see 5.)
  check(!!lapHas && JSON.stringify(pngSize(path.join(inst.laptop.dir, 'clipboard.png'))) === '[240,160]', 'a picture copied on SHOP is on the laptop\'s clipboard while the pointer is there');

  // 5. Back from Shop's tray ("Back to KVM Test Laptop"), and its banner folded into the tray (remembered there).
  nl = lines(inst.laptop).length;
  rc('kvmback');
  // (the name, not "Shop's": Light Beam's copy turns "Shop's" into "Shop's" but the name's "SHOP" into "SHOP")
  check(!!(await waitLog(inst.laptop, new RegExp(`Keyboard and mouse: back on this PC \\(Back, from ${inst.pc.name}'s tray\\)`), nl, 5000)), 'SHOP\'s tray: Back brings the pointer home');
  // (1.12.1) Shrunk to its pill after 5 s, it still has Hide (the user found none: Hide was on the whole banner only).
  n = lines(inst.pc).length;
  rc('banner');
  const pill = await waitLog(inst.pc, /\(test\) banner (pill|full|folded) at /, n, 5000);
  check(!!pill && / banner pill at /.test(pill) && /, hide yes$/.test(pill), `Shop's banner as a pill keeps Hide (${pill ? pill.replace(/^.*\(test\) /, '') : 'no answer'})`);
  n = lines(inst.pc).length;
  rc('banner:hide');
  check(!!(await waitLog(inst.pc, /the keyboard-and-mouse banner is folded into the tray \(the banner's Hide\)/, n, 5000)), 'SHOP\'s banner: Hide folds it into the tray');
  st = await pcState();
  check(!!st && /banner folded/.test(st) && readConfig(inst.pc).rcKvmBannerHidden === true, 'the session goes on, and SHOP remembers the choice');

  // 6. A key held there as the pointer leaves goes up there.
  kvm('edge:0.5');
  await waitLog(inst.laptop, /\(test\) on KVM Test SHOP/, lines(inst.laptop).length - 1, 3000);
  i0 = inputLines().length;
  kvm('key:160,42,0:down'); // (left Shift)
  await waitInput(r => r.type === 'key' && r.scan === 42 && r.flags === SCAN, i0, 4000);
  kvm('move:5000,0');
  const shiftUp = await waitInput(r => r.type === 'key' && r.scan === 42 && r.flags === (SCAN | KEYUP), i0, 4000);
  check(!!shiftUp, 'a key held down there goes up there when the pointer comes back');

  // 7. SHOP goes away while the pointer is on it: the pointer comes back by itself at once.
  kvm('edge:0.5');
  await sleep(500);
  nl = lines(inst.laptop).length;
  const killedAt = Date.now();
  spawnSync('taskkill', ['/PID', String(inst.pc.proc.pid), '/T', '/F'], { windowsHide: true });
  // (1.12.4: it comes back with another picture on its clipboard, which mustn't land on the laptop's as it connects)
  fs.writeFileSync(path.join(inst.pc.dir, 'clipboard-in.png'), noisePng(200, 100, 23));
  const back = await waitLog(inst.laptop, /Keyboard and mouse: back on this PC \(/, nl, 8000);
  const took = Date.now() - killedAt;
  check(!!back && took < 5000, `SHOP gone: the laptop's pointer came back by itself in ${(took / 1000).toFixed(1)} s (${back ? back.replace(/.*back on this PC /, '') : 'it didn\'t'})`);
  w = await where();
  check(!!w && w.here, 'the laptop has its keyboard and mouse');
  // ...and when SHOP is back, the link is up again by itself.
  start(inst.pc);
  check(!!(await waitLog(inst.pc, /Perf: connected/, lines(inst.pc).length - 1, 30000)), 'SHOP starts again');
  const again = await waitLog(inst.laptop, /Keyboard and mouse: KVM Test SHOP is ready \(/, nl, 90000);
  check(!!again, 'the laptop\'s link to SHOP came back by itself');
  check(!!(await waitLog(inst.pc, /folded into the tray \(as chosen at this PC\)/, 0, 5000)), '...and SHOP keeps its banner folded, as chosen there');
  await sleep(2500);
  check(JSON.stringify(pngSize(path.join(inst.laptop.dir, 'clipboard.png'))) === '[240,160]' && count(inst.laptop, /clipboard picture is on this PC's clipboard \(200×100\)/) === 0, 'SHOP\'s picture stays off the laptop\'s clipboard as it connects again');

  // 8. Stopped at SHOP: the laptop doesn't ask again by itself.
  nl = lines(inst.laptop).length;
  const nStop = lines(inst.pc).length;
  rc('stop');
  check(!!(await waitLog(inst.laptop, /Keyboard and mouse: KVM Test SHOP ended it \(stopped at that PC\)/, nl, 8000)), 'Stop at SHOP ends it; the laptop says it won\'t ask again until turned off and on');
  n = lines(inst.pc).length;
  await sleep(8000);
  check(count(inst.pc, /asks to share its keyboard and mouse/, n) === 0, 'it didn\'t ask again');

  // 8b. (1.12.4) SHOP kept its page warm (a PC the KVM uses: no 2 minutes), and the next session starts on it.
  check(!!(await waitLog(inst.pc, /capture host kept warm for the next session/, nStop, 5000)), 'SHOP keeps its page warm after the session');
  nl = lines(inst.laptop).length;
  kvm('off');
  await waitLog(inst.laptop, /Keyboard and mouse: off \(test\)/, nl, 5000);
  n = lines(inst.pc).length;
  nl = lines(inst.laptop).length;
  kvm(`on:${pcId}`);
  check(!!(await waitLog(inst.pc, /its page \(no capture: keyboard and mouse only\) is reused/, n, 30000)), '...and the next session starts on it (reused)');
  check(!!(await waitLog(inst.laptop, /Keyboard and mouse: KVM Test SHOP is ready \(/, nl, 30000)), '...and is ready');

  // 9. Off; nothing real anywhere.
  nl = lines(inst.laptop).length;
  kvm('off');
  check(!!(await waitLog(inst.laptop, /Keyboard and mouse: off \(test\)/, nl, 5000)), 'turned off on the laptop');
  check(count(inst.laptop, /mouse hook|keyboard hook/) === 0, 'a test instance never sets a hook');
  check(count(inst.pc, /input through recording/) >= 1 && count(inst.pc, /input through SendInput/) === 0, 'SHOP\'s input went through the recording backend only');
  const all = lines(inst.laptop).concat(lines(inst.pc)).join('\n');
  check(!/kvm clip from/.test(all), 'beam.log never has clipboard text');
} catch (e) {
  console.log('FAIL ' + (e.stack || e.message));
  failures.push(e.message);
} finally {
  for (const i of [inst.laptop, inst.pc]) await quit(i);
  if (server) { server.kill(); await sleep(500); }
  if (tsPipe) await tsPipe.close();
  if (!KEEP && !failures.length) { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {} }
  else console.log('kept ' + TMP);
  console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nAll checks passed.');
  process.exit(failures.length ? 1 : 0);
}
