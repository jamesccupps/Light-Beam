#!/usr/bin/env node
// Beam for Windows 1.6: remote control of this PC, end to end, with a fake viewer. Exits 1 if a check fails.
//
//   node test/perf/windows-rc.mjs [--exe <Beam.exe>] [--keep]
//
// Isolated like the other windows-* checks:
// - a scratch server (this checkout's server.js, 1.6) on 127.0.0.1:8808, with a fake Tailscale LocalAPI (a named pipe)
//   whose own addresses are this PC's real Tailscale addresses, so WebRTC can really connect here (both ends on this PC);
// - a copy of Beam.exe run with --config in a temp folder (quiet, off-screen windows, no hotkeys, the test clipboard,
//   and its input through the RECORDING backend: a --config instance never uses SendInput), whose `tailscale` CLI is a
//   fake one (this script writes it) so whois answers can be changed;
// - a fake viewer: this script as an Android device for the server API, and headless Edge (its own profile, DevTools
//   on 127.0.0.1:8809) for the WebRTC end. Edge counts decoded frames; nothing stores a frame or a screenshot.
// Nothing is clicked or typed: the switch, the banner's Stop, the kill switch and the lock go through --test-rc.
// Captures are real (this PC's screen) but short, and stay on this PC.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = 8808, CDP_PORT = 8809;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const exeArg = args.indexOf('--exe');
const EXE = exeArg >= 0 ? args[exeArg + 1] : [path.join(ROOT, 'windows', 'bin', 'Beam.exe'), path.join(ROOT, 'dist', 'Beam.exe')].find(f => fs.existsSync(f));
const KEEP = args.includes('--keep');
const DEBUG = args.includes('--debug'); // candidate summaries on the console (never in beam.log)
const TMP = path.join(os.tmpdir(), `beam-rc-win-${Date.now()}`);
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(f => fs.existsSync(f));
const failures = [];
const markers = []; // texts that must never reach beam.log
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
  return ok;
}

const dir = p => path.join(TMP, p);
for (const d of ['data', 'dist', 'cfg', 'app', 'ts', 'edge']) fs.mkdirSync(dir(d), { recursive: true });
const cfgPath = dir('cfg/config.json');
const logPath = dir('cfg/beam.log');
const inputPath = dir('cfg/rc-input.jsonl');
const appExe = dir('app/Beam.exe');
const base = `http://127.0.0.1:${PORT}`;
const pcId = 'rctestpc' + crypto.randomBytes(8).toString('hex');
const viewerId = 'rctestphone' + crypto.randomBytes(8).toString('hex');
const otherId = 'rctestother' + crypto.randomBytes(8).toString('hex');
let server, serverOut, app, appExit, key, edge, cdp, tsPipe;

// This PC's Tailscale addresses: the fake tailnet says the server's machine has them, so the attested addresses (both
// devices talk to the server from this machine) are real local addresses and ICE connects.
const isTs = a => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a) || /^fd7a:115c:a1e0:/i.test(a);
const selfIps = [...new Set(Object.values(os.networkInterfaces()).flat().map(a => a.address).filter(isTs))];
const ip4 = selfIps.find(a => !a.includes(':')), ip6 = selfIps.find(a => a.includes(':'));

// ---------------------------------------------------------------- beam.log
const logLines = () => { try { return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l, i, a) => i < a.length - 1 || l !== ''); } catch { return []; } };
const count = (re, from = 0) => logLines().slice(from).filter(l => re.test(l)).length;
async function waitLog(re, from = 0, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const lines = logLines();
    for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return lines[i];
    await sleep(100);
  }
  return null;
}
// The banner (1.7.4) through --test-rc banner:…: where it is on the test instance's made-up screen (far off the real
// ones), its size, the screen's size and the spot it saved.
async function bannerInfo(cmd = 'banner') {
  const n = logLines().length;
  rc(cmd);
  const l = await waitLog(/\(test\) banner (pill|full) at /, n, 4000);
  const m = l && /banner (pill|full) at (-?\d+),(-?\d+) size (\d+)x(\d+) of (\d+)x(\d+), spot (.*)$/.exec(l);
  return m ? { state: m[1], x: +m[2], y: +m[3], w: +m[4], h: +m[5], W: +m[6], H: +m[7], spot: m[8], right: +m[2] + +m[4] } : null;
}

// ---------------------------------------------------------------- the server API as a device
// An app's own requests carry its Windows account / install (X-Beam-Profile); the server ties a viewer's session to its
// sign-in (here the master key plus that profile), so its stream must carry the same.
const profiles = { [viewerId]: crypto.randomBytes(8).toString('hex'), [otherId]: crypto.randomBytes(8).toString('hex') };
const headersFor = (id, name, platform = 'android') => ({ Authorization: `Bearer ${key}`, 'X-Beam-Device-Id': id, 'X-Beam-Device': name, 'X-Beam-Platform': platform, 'X-Beam-App-Version': '1.6.0', 'X-Beam-Profile': profiles[id] });
const VIEWER = () => headersFor(viewerId, 'Test Phone');
const OTHER = () => headersFor(otherId, 'Other Laptop', 'mac');
async function call(h, method, p, body) {
  const res = await fetch(base + p, { method, headers: { ...h, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const pcRecord = async () => (await call(VIEWER(), 'GET', '/api/devices')).data.devices.find(d => d.id === pcId);
async function waitFor(fn, ms = 10000, step = 200) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
}

// A device's event stream (server-sent events), read with fetch.
async function openEvents(h) {
  const ctrl = new AbortController();
  const res = await fetch(base + '/api/events', { headers: { ...h, Accept: 'text/event-stream' }, signal: ctrl.signal });
  const events = [];
  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = 'message', data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        let d; try { d = JSON.parse(data); } catch { d = data; }
        events.push({ event, data: d });
        if (stream.on) stream.on({ event, data: d });
      }
    }
  })().catch(() => {});
  const stream = {
    events,
    close: () => ctrl.abort(),
    async wait(event, pred = () => true, ms = 10000, from = 0) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        for (let i = from; i < events.length; i++) if (events[i].event === event && pred(events[i].data)) return events[i].data;
        await sleep(50);
      }
      return null;
    },
  };
  return stream;
}

// ---------------------------------------------------------------- the fake tailnet
// The scratch server's LocalAPI: this machine (both devices' requests come from it) has this PC's Tailscale addresses.
function fakeLocalApi() {
  const where = `\\\\.\\pipe\\beam-rc-test-ts-${process.pid}`;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://local-tailscaled.sock');
    const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/localapi/v0/status') return reply(200, { Self: { ID: 'nSELF', HostName: 'rc-test-machine', DNSName: 'rc-test-machine.tail0000.ts.net.', TailscaleIPs: selfIps, UserID: 4242 }, Peer: {}, User: { 4242: { LoginName: 'owner@example.com' } } });
    if (u.pathname === '/localapi/v0/whois') return reply(404, {});
    if (u.pathname === '/localapi/v0/serve-config') return reply(200, {});
    reply(404, {});
  });
  return new Promise(r => srv.listen(where, () => r({ socket: where, close: () => new Promise(c => srv.close(c)) })));
}

// The app's `tailscale` CLI (status, whois), answering from ts/state.json, which the checks change.
const tsState = { owner: 4242, nodes: {}, path: { CurAddr: '', Relay: 'nyc' } }; // (path, 1.11: how Tailscale reaches the viewer)
for (const ip of selfIps) tsState.nodes[ip] = { id: 'nTESTNODE1', name: 'rc-test-machine', owner: 4242 };
const writeTs = () => fs.writeFileSync(dir('ts/state.json'), JSON.stringify(tsState));
fs.writeFileSync(dir('ts/fake-tailscale.mjs'), `
import fs from 'node:fs';
const st = JSON.parse(fs.readFileSync(new URL('./state.json', import.meta.url), 'utf8'));
const [cmd, ...rest] = process.argv.slice(2);
const ips = Object.keys(st.nodes);
if (cmd === 'status') { console.log(JSON.stringify({ Self: { UserID: st.owner, TailscaleIPs: ips }, User: { [st.owner]: { LoginName: 'owner@example.com' } },
  Peer: st.path ? { nVIEWER: { TailscaleIPs: ips, CurAddr: st.path.CurAddr || '', Relay: st.path.Relay || '', PeerRelay: st.path.PeerRelay || '' } } : {} })); process.exit(0); }
if (cmd === 'whois') {
  const ip = rest[rest.length - 1];
  const n = st.nodes[ip];
  if (!n) { console.error('peer not found'); process.exit(1); }
  const addrs = ips.filter(a => st.nodes[a].id === n.id).map(a => a + (a.includes(':') ? '/128' : '/32'));
  console.log(JSON.stringify({ Node: { StableID: n.id, ComputedName: n.name, Name: n.name + '.tail0000.ts.net.', User: n.owner, Addresses: addrs }, UserProfile: { ID: n.owner, LoginName: n.owner === st.owner ? 'owner@example.com' : 'someone@else.com' } }));
  process.exit(0);
}
process.exit(2);
`);

// ---------------------------------------------------------------- the app
function writeConfig() {
  const c = { server: base, key, deviceId: pcId, deviceName: 'RC Test PC', quiet: true, testOffscreen: true, autoUpdate: false,
    autostartInitialized: true, sendToMenu: false, outbox: false, autoCopy: false, autoSave: false,
    testTailscaleExe: process.execPath, testTailscaleArgs: `"${dir('ts/fake-tailscale.mjs')}"`, testRcLeaseSec: 3 };
  fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2));
}
const appEnv = () => ({ ...process.env, BEAM_LOCAL_URLS: base, BEAM_TEST_PEERS: base });
function startApp() {
  app = spawn(appExe, ['--config', cfgPath, '--background'], { env: appEnv(), windowsHide: true, stdio: 'ignore' });
  appExit = undefined;
  app.on('exit', code => { appExit = code; });
}
const forward = a => spawnSync(appExe, ['--config', cfgPath, ...a], { env: appEnv(), windowsHide: true, timeout: 20000 });
const rc = cmd => forward(['--test-rc', cmd]);
async function quitApp() {
  if (!app || appExit !== undefined) return;
  forward(['--quit']);
  for (let i = 0; i < 80 && appExit === undefined; i++) await sleep(250);
  if (appExit === undefined) { try { app.kill(); } catch {} }
  await sleep(1500);
}
const readConfig = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
// A second test instance: the Windows app as the viewer, with its own config folder (so its own device key).
const laptopId = 'rctestlaptop' + crypto.randomBytes(8).toString('hex');
const cfg2 = dir('cfg2/config.json'), log2 = dir('cfg2/beam.log');
let laptop = null, laptopExit;
const logLines2 = () => { try { return fs.readFileSync(log2, 'utf8').split(/\r?\n/).filter((l, i, a) => i < a.length - 1 || l !== ''); } catch { return []; } };
async function waitLog2(re, from = 0, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const lines = logLines2();
    for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return lines[i];
    await sleep(100);
  }
  return null;
}
const forward2 = a => spawnSync(appExe, ['--config', cfg2, ...a], { env: appEnv(), windowsHide: true, timeout: 20000 });
function startLaptop() {
  fs.mkdirSync(path.dirname(cfg2), { recursive: true });
  fs.writeFileSync(cfg2, JSON.stringify({ server: base, key, deviceId: laptopId, deviceName: 'RC Test Laptop', quiet: true, testOffscreen: true,
    autoUpdate: false, autostartInitialized: true, sendToMenu: false, outbox: false, autoCopy: false, autoSave: false }, null, 2));
  laptop = spawn(appExe, ['--config', cfg2, '--background'], { env: appEnv(), windowsHide: true, stdio: 'ignore' });
  laptopExit = undefined;
  laptop.on('exit', code => { laptopExit = code; });
}
async function quitLaptop() {
  if (!laptop || laptopExit !== undefined) return;
  forward2(['--quit']);
  for (let i = 0; i < 80 && laptopExit === undefined; i++) await sleep(250);
  if (laptopExit === undefined) { try { laptop.kill(); } catch {} }
}
// The app keeps its sign-in DPAPI-protected (this Windows account): read it back the same way, for the disk checks.
function unprotect(b64) {
  if (!/^[A-Za-z0-9+/=]+$/.test(b64 || '')) return null;
  const ps = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String('${b64}'); $e=[Text.Encoding]::UTF8.GetBytes('Beam config key 1'); ` +
    `[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$e,'CurrentUser'))`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}
const inputLines = () => { try { return fs.readFileSync(inputPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

// ---------------------------------------------------------------- the scratch server
async function startServer() {
  serverOut = fs.openSync(dir('server.out.log'), 'a');
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', serverOut, serverOut],
    env: { ...process.env, BEAM_TAILSCALE: '', BEAM_TAILSCALE_SOCKET: tsPipe.socket, BEAM_HOST: '127.0.0.1', BEAM_PORT: String(PORT), BEAM_DATA: dir('data'), BEAM_DIST: dir('dist') } });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/hello')).ok) return; } catch {} await sleep(200); }
  throw new Error('the scratch server didn\'t start');
}
async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  const gone = new Promise(r => s.once('exit', r));
  s.kill();
  await Promise.race([gone, sleep(5000)]);
}

// ---------------------------------------------------------------- the viewer's WebRTC end: headless Edge
async function startEdge() {
  edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${dir('edge')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--disable-component-update', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch {}
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('headless Edge has no page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map(), listeners = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); }
    else for (const l of listeners) l(m);
  };
  cdp = {
    send: (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); }),
    on: l => listeners.push(l),
    close: () => ws.close(),
  };
  cdp.on(m => {
    if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'toNode') return;
    try { onViewerBinding(JSON.parse(m.params.payload)); } catch (e) { console.log('  (viewer) ' + e.message); }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Runtime.addBinding', { name: 'toNode' });
  await evalIn(VIEWER_SCRIPT);
}
async function evalIn(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
}

// The fake viewer page: research §8.7's channels, the strict candidate rewrite to the PC's attested addresses, a new
// RTCPeerConnection when an offer has a new o= session id. Counts frames from getStats; touches no pixels but the
// delay probe's square in the top left corner (1.12.6: its colour).
const VIEWER_SCRIPT = `window.V = (() => {
  const isTs = a => /^100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\./.test(a) || /^fd7a:115c:a1e0:/i.test(a);
  let pc = null, ch = null, peer = null, pending = [], sessionO = null, pongs = true, video = null;
  const out = m => toNode(JSON.stringify(m));
  function rewrite(c) {
    if (!c || !c.candidate) return [];
    const p = c.candidate.split(' ');
    if (p.length < 8 || p[2].toLowerCase() !== 'udp') return [];
    const ips = [peer.ip4, peer.ip6].filter(Boolean);
    const base = { sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex };
    if (isTs(p[4])) return ips.includes(p[4]) ? [Object.assign({ candidate: c.candidate }, base)] : [];
    if (p[7] !== 'host') return [];
    return ips.map(ip => { const q = p.slice(); q[4] = ip; return Object.assign({ candidate: q.join(' ') }, base); });
  }
  function fresh() {
    if (pc) pc.close();
    pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    ch = {
      ctl: pc.createDataChannel('ctl', { negotiated: true, id: 0, ordered: true }),
      in: pc.createDataChannel('in', { negotiated: true, id: 1, ordered: true }),
      mv: pc.createDataChannel('mv', { negotiated: true, id: 2, ordered: false, maxRetransmits: 0 }),
    };
    ch.ctl.onmessage = e => { const m = JSON.parse(e.data); if (m.t === 'ping' && pongs) ch.ctl.send(JSON.stringify({ t: 'pong', n: m.n, at: m.at })); out({ k: 'ctl', m }); };
    ch.ctl.onopen = () => out({ k: 'open' });
    pc.onicecandidate = e => out({ k: 'cand', c: e.candidate ? e.candidate.toJSON() : { candidate: '', sdpMid: null, sdpMLineIndex: null } });
    pc.ontrack = e => { video = document.createElement('video'); video.muted = true; video.srcObject = e.streams[0] || new MediaStream([e.track]); video.play().catch(() => {}); };
    pc.onconnectionstatechange = () => out({ k: 'state', s: pc.connectionState });
    pending = [];
  }
  return {
    peer(p) { peer = p; },
    async offer(sdp) {
      const o = (/^o=\\S+ (\\d+)/m.exec(sdp) || [])[1];
      if (!pc || o !== sessionO) { fresh(); sessionO = o; }
      await pc.setRemoteDescription({ type: 'offer', sdp });
      for (const c of pending.splice(0)) pc.addIceCandidate(c).catch(() => {});
      const a = await pc.createAnswer();
      await pc.setLocalDescription(a);
      return a.sdp;
    },
    cands(list) { for (const c of list) for (const r of rewrite(c)) { if (pc && pc.remoteDescription) pc.addIceCandidate(r).catch(() => {}); else pending.push(r); } },
    send(name, m) { if (!ch || ch[name].readyState !== 'open') return false; ch[name].send(JSON.stringify(m)); return true; },
    async frames() { if (!pc) return 0; const s = await pc.getStats(); let n = 0; s.forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'video') n = r.framesDecoded || 0; }); return n; },
    async heldRaw() { if (!pc) return null; const s = await pc.getStats(); let r = null; s.forEach(x => { if (x.type === 'inbound-rtp' && x.kind === 'video') r = x; }); return r ? { d: r.jitterBufferDelay || 0, n: r.jitterBufferEmittedCount || 0 } : null; },
    pongs(on) { pongs = on; },
    // (1.12.6) The colour in the middle of the delay probe's square (size: its side in the screen's pixels, monW: the
    // screen's width), in the frame shown now: magenta, green, or what it is.
    color(size, monW) {
      if (!video || !video.videoWidth) return 'no picture';
      const k = video.videoWidth / monW, half = Math.max(1, size * k / 4), c = size * k / 2;
      const cv = document.createElement('canvas');
      cv.width = cv.height = 2;
      const g = cv.getContext('2d');
      g.drawImage(video, c - half, c - half, half * 2, half * 2, 0, 0, 2, 2);
      const d = g.getImageData(0, 0, 2, 2).data;
      let R = 0, G = 0, B = 0;
      for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; }
      R /= 4; G /= 4; B /= 4;
      return R > 150 && B > 150 && G < 110 ? 'magenta' : G > 150 && R < 110 && B < 110 ? 'green' : 'other ' + Math.round(R) + ',' + Math.round(G) + ',' + Math.round(B);
    },
    state() { return pc ? pc.connectionState : 'none'; },
    close() { if (video) video.srcObject = null; if (pc) pc.close(); pc = null; sessionO = null; },
  };
})(); 'ready'`;

// ---------------------------------------------------------------- a viewer session, relayed between the server and Edge
const viewerCtl = [];
let live = null; // { id, host }
let candQueue = [], candTimer = null, viewerEvents = null, keepCandidates = false;
function onViewerBinding(msg) {
  if (msg.k === 'ctl') viewerCtl.push({ at: Date.now(), m: msg.m });
  else if (msg.k === 'cand' && live && !keepCandidates) {
    candQueue.push(msg.c);
    if (!candTimer) candTimer = setTimeout(async () => {
      candTimer = null;
      const batch = candQueue.splice(0, 20);
      if (live && batch.length) {
        const r = await call(VIEWER(), 'POST', `/api/rc/sessions/${live.id}/signal`, { kind: 'candidates', candidates: batch });
        if (DEBUG) console.log(`  (viewer) sent ${batch.length} candidate(s): ${r.status} ${batch.map(c => c.candidate.split(' ').slice(2, 8).join(' ')).join(' | ')}`);
      }
    }, 50);
  }
}
async function onViewerEvent(e) {
  if (!live || !e.data || e.data.id !== live.id) return;
  if (e.event === 'rc-signal' && e.data.kind === 'offer') {
    try {
      const sdp = await evalIn(`V.offer(${JSON.stringify(e.data.sdp)})`);
      await call(VIEWER(), 'POST', `/api/rc/sessions/${live.id}/signal`, { kind: 'answer', sdp });
    } catch (err) { console.log('  (viewer) offer failed: ' + err.message); }
  } else if (e.event === 'rc-signal' && e.data.kind === 'candidates') {
    if (DEBUG) console.log(`  (viewer) got ${e.data.candidates.length} candidate(s): ${e.data.candidates.map(c => c.candidate.split(' ').slice(2, 8).join(' ')).join(' | ')}`);
    await evalIn(`V.cands(${JSON.stringify(e.data.candidates)})`);
  }
}
async function startSession(h = VIEWER()) {
  const r = await call(h, 'POST', '/api/rc/sessions', { device: pcId });
  if (r.status === 201) {
    live = { id: r.data.id, host: r.data.host };
    if (cdp) await evalIn(`V.peer(${JSON.stringify({ ip4: r.data.host.ip4, ip6: r.data.host.ip6 })})`);
  }
  return r;
}
const ctlSince = (t, at) => viewerCtl.filter(x => x.at >= at && x.m.t === t).map(x => x.m);
async function waitCtl(t, at, ms = 10000, pred = () => true) {
  return waitFor(() => ctlSince(t, at).find(pred), ms, 50);
}
async function endViewer() { if (cdp) await evalIn('V.close()'); live = null; }

// ---------------------------------------------------------------- the run
try {
  if (!EXE) throw new Error('No Beam.exe: build with windows\\build.cmd or pass --exe');
  if (!EDGE) throw new Error('No Microsoft Edge for the headless viewer');
  if (!ip4 && !ip6) throw new Error('This PC has no Tailscale address: the WebRTC part needs one (both ends run here)');
  fs.copyFileSync(EXE, appExe);
  console.log(`Beam: ${EXE}\ntemp: ${TMP}\nTailscale addresses here: ${selfIps.join(', ')}`);
  writeTs();
  tsPipe = await fakeLocalApi();
  await startServer();
  key = fs.readFileSync(dir('data/key'), 'utf8').trim();
  const info = (await call(VIEWER(), 'GET', '/api/info')).data;
  if (!(info.features || []).includes('remote-control')) throw new Error('the scratch server has no remote-control feature (needs server 1.6)');
  await call(OTHER(), 'GET', '/api/devices'); // registers the other device
  writeConfig();
  startApp();
  if (!(await waitLog(/Perf: connected/, 0, 30000))) throw new Error('the app never connected');
  await waitLog(/First sync/, 0, 30000);
  forward(['--test-mode', 'foreground']); // device lists at once
  await sleep(1500);
  viewerEvents = await openEvents(VIEWER());
  viewerEvents.on = e => { onViewerEvent(e).catch(err => console.log('  (viewer) ' + err.message)); };
  const otherEvents = await openEvents(OTHER());
  await sleep(1500);

  // 1. Off by default; the page can't turn it on.
  let pc = await pcRecord();
  check(pc && pc.can && pc.can.remoteControl === false && (!pc.status || pc.status.remoteControl !== true), 'off by default: the server has can.remoteControl false');
  let r = await call(VIEWER(), 'POST', '/api/rc/sessions', { device: pcId });
  check(r.status === 409 && r.data.reason === 'not-allowed', `a request to a PC that hasn't allowed it: 409 not-allowed (${r.status} ${r.data.reason})`);
  let from = logLines().length;
  forward(['--test-bridge', JSON.stringify({ type: 'setSettings', id: 'test-on', settings: { allowRemoteControl: true } })]);
  const refusedOn = await waitLog(/Bridge test reply: .*"id":"test-on"/, from, 15000);
  check(!!refusedOn && /"ok":false/.test(refusedOn) && /"code":"native-only"/.test(refusedOn), 'the page asking to turn it on gets native-only');
  check(readConfig().allowRemoteControl === false, '...and it stays off');
  forward(['--test-bridge', JSON.stringify({ type: 'setSettings', id: 'test-list', settings: { remoteControlDevices: [{ id: otherId }] } })]);
  const refusedList = await waitLog(/Bridge test reply: .*"id":"test-list"/, from, 10000);
  check(!!refusedList && /"code":"native-only"/.test(refusedList), 'the page can\'t change the device list either');

  // 2. On at this PC (the confirmation's path), for the phone only; pinned to its Tailscale machine.
  from = logLines().length;
  rc(`allow:${viewerId}`);
  check(!!(await waitLog(/Remote control: allowed on this PC \(test\), for Test Phone$/, from, 8000)), 'turned on, for the ticked device only');
  check(!!(await waitLog(/Test Phone is pinned to the Tailscale machine rc-test-machine/, from, 15000)), 'the device is pinned to its Tailscale machine (this PC\'s own whois)');
  pc = await waitFor(async () => { const d = await pcRecord(); return d && d.can && d.can.remoteControl ? d : null; }, 10000);
  check(!!pc && pc.status.remoteControl === true && pc.status.locked === false, 'the status report says so at once: can.remoteControl true');
  const cfg1 = readConfig();
  check(cfg1.allowRemoteControl === true && cfg1.remoteControlDevices.length === 1 && cfg1.remoteControlDevices[0].id === viewerId && cfg1.remoteControlDevices[0].node === 'nTESTNODE1', 'config.json: on, the phone pinned to its node');
  forward(['--test-bridge', JSON.stringify({ type: 'getSettings', id: 'test-get' })]);
  const got = await waitLog(/Bridge test reply: .*"id":"test-get"/, from, 10000);
  check(!!got && /"allowRemoteControl":true/.test(got) && got.includes(viewerId), 'the page sees the switch and the list (read-only)');

  // 3. Who: a device that isn't ticked, the wrong Tailscale owner, another machine.
  from = logLines().length;
  r = await startSession(OTHER());
  check(r.status === 201, 'the server lets another device ask');
  const notListed = await otherEvents.wait('rc-end', d => live && d.id === live.id, 10000);
  check(!!notListed && (notListed.reason === 'not-listed' || notListed.reason === 'declined'), `a device that isn't on the PC's list is refused (rc-end ${notListed && notListed.reason})`);
  check(!!(await waitLog(/refused Other Laptop: it isn't on this PC's list/, from, 3000)), '...by the PC, before any banner');
  live = null;
  tsState.nodes[ip4 || ip6].owner = 999; writeTs();
  from = logLines().length;
  r = await startSession();
  let ended = await viewerEvents.wait('rc-end', d => live && d.id === live.id, 10000);
  check(r.status === 201 && !!ended && ended.reason === 'declined' && !!(await waitLog(/refused Test Phone: the peer belongs to another Tailscale user/, from, 3000)), 'whois names another Tailscale owner: refused');
  tsState.nodes[ip4 || ip6].owner = 4242;
  for (const ip of selfIps) tsState.nodes[ip].id = 'nANOTHERNODE';
  writeTs();
  live = null;
  from = logLines().length;
  r = await startSession();
  ended = await viewerEvents.wait('rc-end', d => live && d.id === live.id, 10000);
  check(r.status === 201 && !!ended && ended.reason === 'declined' && !!(await waitLog(/refused Test Phone: it asked from another Tailscale machine/, from, 3000)), 'the device asks from another Tailscale machine than the one it was ticked on: refused');
  for (const ip of selfIps) tsState.nodes[ip].id = 'nTESTNODE1';
  writeTs();
  live = null;
  check(count(/banner up/, 0) === 0, 'no banner for any of those');

  // 4. Locked: reported at once; the server refuses; unlocked again.
  from = logLines().length;
  rc('lock:on');
  pc = await waitFor(async () => { const d = await pcRecord(); return d && d.status && d.status.locked === true ? d : null; }, 10000);
  check(!!pc && pc.can.remoteControl === false, 'locked: reported at once, can.remoteControl false');
  r = await call(VIEWER(), 'POST', '/api/rc/sessions', { device: pcId });
  check(r.status === 409 && r.data.reason === 'locked', `a request to the locked PC: 409 locked (${r.status} ${r.data.reason})`);
  rc('lock:off');
  pc = await waitFor(async () => { const d = await pcRecord(); return d && d.can && d.can.remoteControl ? d : null; }, 10000);
  check(!!pc, 'unlocked: can.remoteControl true again');

  // 5. No capture without a session: the capture host's gate refuses it.
  from = logLines().length;
  rc('probe');
  const probe = await waitLog(/\(test\) a capture without a session: /, from, 40000);
  check(!!probe && /refused \(NotAllowedError\)/.test(probe), `a capture attempt with no session is refused (${probe ? probe.replace(/.*session: /, '') : 'no answer'})`);
  check(!!(await waitLog(/a screen capture was refused \(no live session with its banner up\)/, from, 1000)), '...by ScreenCaptureStarting');
  check(!!(await waitLog(/\(test\) probe host closed/, from, 15000)), '...and that host closed');

  // 6. A viewer that never sends its candidates connects peer-reflexive only: its address can't be read, so the PC
  // hangs up (it fails closed) before any video or input.
  await startEdge();
  check(true, 'headless Edge is up as the viewer');
  from = logLines().length;
  keepCandidates = true;
  r = await startSession();
  const unresolved = await waitLog(/the connection's peer failed the check: the connection's peer address is unknown/, from, 30000);
  check(!!unresolved, 'a viewer that withholds its candidates (peer-reflexive, its address unreadable) is hung up on');
  check(count(/is controlling this PC \(peer/, from) === 0 && inputLines().length === 0, '...without ever going live');
  await waitLog(/capture stopped|capture host closed$/, from, 12000);
  keepCandidates = false;
  await endViewer();

  // A viewer window of this PC's own, open before the session (it'll try controlling another device from here).
  forward(['--test-open-remote', otherId]);
  await sleep(5000);

  // 7. A whole session: banner, lease, capture, the peer check, video, input, clipboard, quality, Stop.
  from = logLines().length;
  fs.rmSync(inputPath, { force: true });
  let t0 = Date.now();
  r = await startSession();
  check(r.status === 201 && (r.data.host.ip4 === ip4 || r.data.host.ip6 === ip6), 'the viewer asks: 201 with the PC\'s attested addresses');
  const banner = await waitLog(/banner up: /, from, 10000);
  check(!!banner && banner.includes(`Test Phone (rc-test-machine · ${ip4 || ip6}) is controlling this PC`), `the banner leads with what's verified: ${banner ? banner.replace(/.*banner up: /, '') : 'none'}`);
  check(!!(await waitLog(/the banner is at the top centre/, from, 1000)), 'the banner starts at the top centre (nowhere saved yet; 1.7.4)');
  const bannerAt = Date.now();
  check(!!(await waitLog(/kill switch hotkey isn't registered by a test instance/, from, 1000)), 'a test instance registers no hotkey (the kill switch goes through --test-rc kill)');
  const list = await waitFor(async () => { const l = (await call(VIEWER(), 'GET', '/api/rc/sessions')).data.sessions; return l.find(x => x.id === live.id && x.state === 'live'); }, 8000);
  check(!!list, 'the PC leased it as soon as the banner was up: the server says live');
  check(!!(await waitLog(/a screen capture was allowed/, from, 15000)), 'the capture was allowed (session on, banner up)');
  const capturing = await waitLog(/Remote control: capturing \d+×\d+/, from, 15000);
  check(!!capturing, `capturing (${capturing ? capturing.replace(/.*capturing /, '') : 'no'})`);
  check(count(/Remote control: input through recording$/) >= 1 && count(/input through SendInput/) === 0, 'a --config instance injects through the recording backend, never SendInput');
  const verifiedLine = await waitLog(/Test Phone is controlling this PC \(peer .* is rc-test-machine, checked\)/, from, 20000);
  check(!!verifiedLine, 'connected, and the peer passed the check (its address is the attested one, its node the pinned one)');
  const hello = await waitCtl('hello', t0, 10000);
  check(!!hello && hello.role === 'host' && Array.isArray(hello.monitors) && hello.monitors.length > 0, `the viewer got the host's hello (${hello ? hello.monitors.length + ' screen(s)' : 'none'})`);
  check(!!hello && JSON.stringify(hello.caps) === '["fit","fit-scale","settings","video","clipimg","cursor","probe"]' && hello.fitted === false,
    `...saying what 1.8 adds (and 1.11.4's fit-scale, 1.12.4's clipimg, 1.12.6's cursor and probe) (${hello ? JSON.stringify(hello.caps) : '-'})`);
  {
    // 1.6.1: where the cursor is, when it's on the shared screen (this machine's real cursor: wherever it happens to be).
    const hm = hello && (hello.monitors.find(m => m.id === hello.monitor) || hello.monitors[0]);
    const c = hello && hello.cursor;
    check(!c || (hm && Number.isInteger(c.x) && Number.isInteger(c.y) && c.x >= 0 && c.y >= 0 && c.x < hm.w && c.y < hm.h),
      `the hello's cursor is on the shared screen or left out (${c ? c.x + ',' + c.y : 'not on it'})`);
  }
  console.log(`  connected in ${Date.now() - t0} ms`);
  const frames = await waitFor(async () => { const n = await evalIn('V.frames()'); return n > 10 ? n : null; }, 10000, 250);
  check(!!frames, `video flows (${frames || 0} frames decoded by the viewer; none stored)`);
  {
    // 1.15: the start, step by step, once: in beam.log, and to the viewer (`started`, ms since the request got here).
    const line = await waitLog(/the first picture went out [\d.]+ s after the request \(/, from, 5000);
    check(!!line && /\(banner [\d.]+ · page [\d.]+ · .*picture [\d.]+/.test(line), `beam.log: the start, step by step (${line ? line.replace(/.*went out /, '') : 'none'})`);
    const st = await waitCtl('started', t0, 5000);
    const steps = st && st.at ? Object.keys(st.at) : [];
    // (warm: the page the session before this one parked, 2 minutes)
    check(!!st && ['banner', 'page', 'offer', 'answer', 'connected', 'checked', 'capture', 'picture'].every(k => steps.includes(k) && st.at[k] >= 0 && st.at[k] <= st.at.picture) && st.warm === true,
      `...and the viewer is told (${st ? JSON.stringify(st) : 'nothing'})`);
  }
  const stats = await waitCtl('stats', t0, 6000, m => !!m.codec);
  check(!!stats, `the host sends stats with its encoder (${stats ? stats.codec + ' / ' + stats.encoder + ', ' + stats.w + '×' + stats.h : 'none'})`);
  const state = await waitCtl('state', t0, 4000);
  check(!!state && state.locked === false, 'the host sends its state (locked / secure / elevated)');
  // 1.11: how Tailscale reaches the viewer, from this PC's own `tailscale status` (the fake: through the relay in New
  // York, then direct on the same network).
  const viaRelay = await waitCtl('path', t0, 8000);
  check(!!viaRelay && viaRelay.via === 'relay' && viaRelay.relay === 'nyc' && viaRelay.lan === false, `the viewer is told the path (${viaRelay ? JSON.stringify(viaRelay) : 'nothing'})`);
  check(!!(await waitLog(/Tailscale reaches Test Phone through Tailscale's relay \(nyc\)/, from, 1000)), '...and beam.log says so');
  const heldFrom = await evalIn('V.heldRaw()'); // (frames from here on: the first ones include a big keyframe, paced out)
  tsState.path = { CurAddr: '192.168.1.20:41641', Relay: 'nyc' };
  writeTs();
  const direct = await waitCtl('path', Date.now(), 15000, m => m.via === 'direct');
  check(!!direct && direct.lan === true && !('relay' in direct), `...and again when it goes direct (${direct ? JSON.stringify(direct) : 'nothing within 15 s'})`);
  // 1.11: the PC's picture asks every viewer to show its frames at once: its capture page runs with WebRTC's sender
  // field trial, and this viewer (no flags, like a phone's WebView) holds its frames back for nothing.
  const hostArgs = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${TMP.replace(/'/g, "''")}') -and $_.CommandLine.Contains('RemoteHost') -and -not $_.CommandLine.Contains('--type=') } | Select-Object -First 1).CommandLine`], { encoding: 'utf8', windowsHide: true }).stdout || '';
  check(hostArgs.includes('--force-fieldtrials=WebRTC-ForceSendPlayoutDelay/min_ms:0,max_ms:0/'), 'the capture page\'s browser runs with the sender\'s playout delay 0 (WebRTC-ForceSendPlayoutDelay)');
  const heldTo = await evalIn('V.heldRaw()');
  const heldN = heldTo && heldFrom ? heldTo.n - heldFrom.n : 0;
  const heldMs = heldN > 0 ? Math.round((heldTo.d - heldFrom.d) / heldN * 10000) / 10 : null;
  // (a frame's packets arriving take a few ms; without the PC's playout delay a receiver adds its own buffer on top)
  check(heldN < 5 || heldMs < 5, `...and the viewer holds them back for nothing (${heldN >= 5 ? `${heldMs} ms each over ${heldN} frames` : `only ${heldN} frames to measure: a still screen`})`);

  // Input, recorded (never real): the exact INPUT records for this PC's real screen layout.
  const mon = hello.monitors.find(m => m.id === hello.monitor) || hello.monitors[0];
  const vx = Math.min(...hello.monitors.map(m => m.x)), vy = Math.min(...hello.monitors.map(m => m.y));
  const vw = Math.max(...hello.monitors.map(m => m.x + m.w)) - vx, vh = Math.max(...hello.monitors.map(m => m.y + m.h)) - vy;
  const abs = (p, size) => Math.min(65535, Math.floor((p * 65536 + size - 1) / size));
  const X = Math.floor(mon.w / 2), Y = Math.floor(mon.h / 3);
  const send = (c, m) => evalIn(`V.send(${JSON.stringify(c)}, ${JSON.stringify(m)})`);
  await send('mv', { t: 'mv', n: 1, x: X, y: Y, m: mon.id });
  await sleep(300); // mv is unordered and unreliable: let it arrive before the click (which would make it stale)
  await send('in', { t: 'btn', n: 1, b: 0, d: true, x: X, y: Y, m: mon.id });
  await send('in', { t: 'btn', n: 1, b: 0, d: false, x: X, y: Y, m: mon.id });
  await send('in', { t: 'key', c: 'KeyA', d: true });
  await send('in', { t: 'key', c: 'KeyA', d: false });
  await send('in', { t: 'key', c: 'ArrowLeft', d: true });
  await send('in', { t: 'key', c: 'ArrowLeft', d: false });
  await send('in', { t: 'text', s: 'é' });
  await send('in', { t: 'wheel', dx: 0, dy: 120, x: X, y: Y, m: mon.id });
  await send('in', { t: 'key', c: 'MetaLeft', d: true });
  await send('in', { t: 'key', c: 'KeyL', d: true });
  await send('in', { t: 'key', c: 'KeyL', d: false });
  await send('in', { t: 'key', c: 'ShiftLeft', d: true });
  await send('in', { t: 'release' });
  const want = [
    { type: 'mouse', dx: abs(mon.x + X - vx, vw), dy: abs(mon.y + Y - vy, vh), data: 0, flags: 0xC001 },
    { type: 'mouse', dx: abs(mon.x + X - vx, vw), dy: abs(mon.y + Y - vy, vh), data: 0, flags: 0xC003 },
    { type: 'mouse', dx: abs(mon.x + X - vx, vw), dy: abs(mon.y + Y - vy, vh), data: 0, flags: 0xC005 },
    { type: 'key', vk: 0, scan: 0x1E, flags: 8 }, { type: 'key', vk: 0, scan: 0x1E, flags: 10 },
    { type: 'key', vk: 0, scan: 0x4B, flags: 9 }, { type: 'key', vk: 0, scan: 0x4B, flags: 11 },
    { type: 'key', vk: 0, scan: 0xE9, flags: 4 }, { type: 'key', vk: 0, scan: 0xE9, flags: 6 },
    { type: 'mouse', dx: abs(mon.x + X - vx, vw), dy: abs(mon.y + Y - vy, vh), data: -120, flags: 0xC801 },
    { type: 'key', vk: 0x5B, scan: 0x5B, flags: 1 },
    { type: 'key', vk: 0, scan: 0x2A, flags: 8 },
    { type: 'key', vk: 0, scan: 0x2A, flags: 10 }, { type: 'key', vk: 0x5B, scan: 0x5B, flags: 3 },
  ];
  const recorded = await waitFor(() => { const l = inputLines(); return l.length >= want.length ? l : null; }, 5000, 100) || inputLines();
  const strip = l => { const { b, ...rest } = l; return JSON.stringify(rest); };
  const sameInput = recorded.length === want.length && recorded.every((l, i) => strip(l) === JSON.stringify(want[i]));
  check(sameInput, `the input arrived as exactly these INPUT records (${recorded.length}/${want.length}): move, click, A, ←, é, wheel, Win (never Win+L), release-all`);
  if (!sameInput) for (let i = 0; i < Math.max(recorded.length, want.length); i++) console.log(`    ${strip(recorded[i] || {})}  vs  ${JSON.stringify(want[i] || {})}`);
  check(recorded.length >= 2 && recorded[recorded.length - 1].b === recorded[recorded.length - 2].b, 'release-all goes as one SendInput');
  check(!!(await waitLog(/Win\+L isn't passed on/, from, 1000)), 'Win+L is dropped (and logged without the key)');
  // 1.12.6: the viewer draws this PC's pointer (a test instance never touches the real pointers: it says what it would
  // do), and measures the delay with probes the way input comes: the PC's square in the top left corner of the screen it
  // shares, seen in the picture (this machine's real screen shows the square for a few seconds).
  let tp = Date.now();
  const inputBefore = inputLines().length;
  await send('ctl', { t: 'hello', v: 1, role: 'viewer', app: 'web', caps: ['clip', 'text', 'clipimg', 'cursor'] });
  await send('ctl', { t: 'pointer', here: true });
  check(!!(await waitLog(/the viewer draws this PC's pointer itself \(the viewer's setting\)/, from, 5000)) && !!(await waitLog(/\(test\) this PC's pointer would be hidden now/, from, 3000)),
    'a viewer with a mouse draws the pointer: this PC hides its own (a test instance only says so)');
  const shape = await waitCtl('cursor', tp, 3000);
  check(!!shape && (shape.css === null || /^[a-z-]+$/.test(shape.css)) && typeof shape.hidden === 'boolean', `...and says which pointer shows (${shape ? JSON.stringify(shape) : 'nothing'})`);
  rc('pointerreveal');
  check(!!(await waitLog(/\(test\) this PC's pointer would show again/, from, 3000)), 'this PC\'s own mouse moving: its pointer shows again...');
  await sleep(4500);
  check(count(/\(test\) this PC's pointer would be hidden now/, from) >= 2, '...for a few seconds, then it\'s hidden again');
  tp = Date.now();
  await send('in', { t: 'probe', n: 0, on: true });
  const p0 = await waitCtl('probe', tp, 5000, m => m.n === 0);
  check(!!p0 && p0.color === 'magenta' && p0.size === 32 && p0.x === 0 && p0.y === 0, `the delay probe: the PC shows its square (${p0 ? JSON.stringify(p0) : 'no answer'})`);
  let seen = await waitFor(async () => { const c = await evalIn(`V.color(32, ${mon.w})`); return c === 'magenta' ? c : null; }, 5000, 40);
  check(!!seen, `...and the picture shows it, magenta, in the top left corner (${seen || await evalIn(`V.color(32, ${mon.w})`)})`);
  tp = Date.now();
  await send('in', { t: 'probe', n: 1 });
  const p1 = await waitCtl('probe', tp, 5000, m => m.n === 1);
  check(!!p1 && p1.color === 'green' && p1.ms > 0 && p1.ms < 1000, `a probe turns it green: the PC's time from the probe to its screen (${p1 ? p1.ms + ' ms' : 'no answer'})`);
  // 1.15: the PC's page saw the green in its own capture (a clone of it): less the PC's time above, Edge's capture.
  const cap1 = await waitCtl('probe-cap', tp, 3000, m => m.n === 1);
  check(!!cap1 && cap1.ms > 0 && cap1.ms < 1000, `...its own capture showed it ${cap1 ? cap1.ms + ' ms' : 'never'} after the probe got there (Edge's capture about ${cap1 && p1 ? Math.round(cap1.ms - p1.ms) + ' ms' : '-'})`);
  seen = await waitFor(async () => ((await evalIn(`V.color(32, ${mon.w})`)) === 'green' ? Date.now() : null), 5000, 20);
  check(!!seen, `...in the picture ${seen ? seen - tp : '-'} ms after the probe was sent (polled, so roughly)`);
  await send('in', { t: 'probe', off: true });
  check(!!(await waitLog(/the delay measurement's square is gone/, from, 3000)), '...and gone when the viewer is done');
  check(inputLines().length === inputBefore, 'probes are never input (nothing recorded)');
  const st2 = await waitCtl('stats', Date.now(), 5000);
  check(!!st2 && 'encMs' in st2 && 'sendMs' in st2, `the stats say a frame's encoding and sending (${st2 ? st2.encMs + ' / ' + st2.sendMs + ' ms' : 'none'})`);
  // A viewer that stops answering pings: what it holds is let go after 5 s.
  await evalIn('V.pongs(false)');
  await sleep(2500);
  const before = inputLines().length;
  await send('in', { t: 'key', c: 'KeyB', d: true });
  const letGo = await waitLog(/let go of 1 held key\(s\) and button\(s\) \(no answer from the viewer for 5 s\)/, from, 12000);
  check(!!letGo, 'no pong for 5 s: the held key is let go');
  const after = inputLines().slice(before);
  check(after.length === 2 && strip(after[0]) === JSON.stringify({ type: 'key', vk: 0, scan: 0x30, flags: 8 }) && strip(after[1]) === JSON.stringify({ type: 'key', vk: 0, scan: 0x30, flags: 10 }), '...B down, then B up');
  await evalIn('V.pongs(true)');
  // Clipboard: off until the viewer turns it on; text both ways; secret-marked text stays here.
  const pcText = 'pc-clip-' + crypto.randomBytes(6).toString('hex'), viewerText = 'viewer-clip-' + crypto.randomBytes(6).toString('hex');
  markers.push(pcText, viewerText);
  fs.writeFileSync(dir('cfg/clipboard-in.txt'), 'early-' + pcText);
  let t1 = Date.now();
  await sleep(1500);
  check(ctlSince('clip', t1).length === 0, 'clipboard sync is off until the viewer turns it on');
  t1 = Date.now();
  await send('ctl', { t: 'clip', on: true });
  const first = await waitCtl('clip', t1, 4000);
  check(!!first && first.text === 'early-' + pcText, 'on: the PC\'s clipboard text goes to the viewer');
  t1 = Date.now();
  fs.writeFileSync(dir('cfg/clipboard-in.txt'), pcText);
  const next = await waitCtl('clip', t1, 4000);
  check(!!next && next.text === pcText, '...and each change after');
  await send('ctl', { t: 'clip', n: 1, text: viewerText });
  const onPc = await waitFor(() => { try { const t = fs.readFileSync(dir('cfg/clipboard.txt'), 'utf8'); return t === viewerText ? t : null; } catch { return null; } }, 4000, 100);
  check(!!onPc, 'the viewer\'s text goes onto the PC\'s clipboard');
  fs.writeFileSync(dir('cfg/clipboard-in.secret'), '');
  t1 = Date.now();
  fs.writeFileSync(dir('cfg/clipboard-in.txt'), 'secret-' + pcText);
  await sleep(2500);
  check(ctlSince('clip', t1).length === 0, 'secret-marked clipboard text isn\'t sent');
  fs.rmSync(dir('cfg/clipboard-in.secret'), { force: true });
  await send('ctl', { t: 'clip', on: false });
  // Quality, Lock.
  t1 = Date.now();
  await send('ctl', { t: 'quality', mode: 'motion' });
  const q = await waitCtl('quality', t1, 4000);
  check(!!q && q.mode === 'motion' && q.maxFps === 60 && q.maxKbps === 16000, 'Smooth motion: 60 fps / 16 Mbps');
  // 1.8: the picture's settings apply at once (here Data saver); the fit changes this test instance's made-up screen
  // (FakeDisplay: never a real one), noted in config.json first, and answers with the new sizes; Fit off puts it back;
  // a hidden viewer gets no frames.
  t1 = Date.now();
  await send('ctl', { t: 'settings', mode: 'saver', size: 'auto', vw: 0, vh: 0, fps: 0, kbps: 0, codec: 'auto', net: '' });
  const qs = await waitCtl('quality', t1, 4000);
  check(!!qs && qs.profile === 'saver' && qs.maxFps === 15 && qs.maxKbps === 1500, `Data saver: 15 fps / 1.5 Mbps (${qs ? qs.profile + ' ' + qs.maxFps + '/' + qs.maxKbps : 'no answer'})`);
  check(!!(await waitLog(/the viewer's picture settings: saver, size auto, auto fps, auto kbps, codec auto$/, from, 2000)), '...in beam.log');
  const st18 = await waitCtl('stats', Date.now(), 5000, m => m.profile === 'saver');
  check(!!st18 && st18.srcW > 0 && st18.down >= 1 && st18.maxFps === 15, `the stats say so, with the screen's size and how much smaller it goes (${st18 ? st18.srcW + '×' + st18.srcH + ', 1/' + st18.down + ', ' + st18.w + '×' + st18.h : 'none'})`);
  t1 = Date.now();
  await send('ctl', { t: 'fit', on: true, w: 1920, h: 1200, dpr: 1.25, scale: true });
  const disp = await waitCtl('display', t1, 6000);
  check(!!disp && disp.fitted === true && Array.isArray(disp.monitors), `Fit: the PC answers with its screens (${disp ? 'fitted ' + disp.fitted : 'no answer'})`);
  check(!!(await waitLog(/the shared screen fitted to the viewer: 1920×1200 at 125%; it was 2560×1440 at 150%$/, from, 3000)), '...its made-up screen went to 1920×1200 at 125% (from 2560×1440 at 150%)');
  check(String(readConfig().rcDisplayRestore || '').endsWith('|2560|1440|60|150'), `...the original noted in config.json (${readConfig().rcDisplayRestore})`);
  // 1.11.4: after a change it makes, the PC captures again (Windows' sharing bar drawn for the new scaling); a capture
  // that ends just after a display change starts again once (it ended the session as Stop sharing); a second one ends.
  check(!!(await waitLog(/capturing again \(this screen changed\)$/, from, 3000)) && !!(await waitLog(/capturing \d+×\d+ again$/, from, 8000)), '...and it captures its screen again (1.11.4)');
  const te = logLines().length;
  rc('trackended');
  check(!!(await waitLog(/capturing again \(the capture ended as the display changed\)$/, te, 3000)) && !!(await waitLog(/capturing \d+×\d+ again$/, te, 8000)), 'a capture that ends just after a display change starts again (1.11.4)');
  check(count(/stopped controlling this PC/, te) === 0, '...and the session goes on');
  t1 = Date.now();
  await send('ctl', { t: 'fit', on: false });
  const back = await waitCtl('display', t1, 6000);
  check(!!back && back.fitted === false && !!(await waitLog(/the shared screen back to 2560×1440 at 150% \(the viewer turned Fit off\)$/, from, 3000)), 'Fit off: back to 2560×1440 at 150%');
  check(!readConfig().rcDisplayRestore, '...and nothing left to put back');
  await send('ctl', { t: 'video', on: false });
  await sleep(4500);
  const hidden = ctlSince('stats', Date.now() - 2500);
  check(hidden.length > 0 && hidden.every(m => m.video === false && m.kbps < 50), `the viewer hidden: no frames (${hidden.map(m => m.kbps + ' kbps').join(', ') || 'no stats'})`);
  await send('ctl', { t: 'video', on: true });
  check(!!(await waitCtl('stats', Date.now(), 5000, m => m.video === true)), '...seen again: frames again');
  await send('ctl', { t: 'settings', mode: 'text', size: 'auto', vw: 0, vh: 0, fps: 0, kbps: 0, codec: 'auto', net: '' });
  const fitFrom = logLines().length;
  await send('ctl', { t: 'fit', on: true, w: 1280, h: 720, dpr: 1 }); // (left fitted: the session's end puts it back)
  check(!!(await waitLog(/the shared screen fitted to the viewer: 1280×720 at 125% \(its own 150% doesn't go at this size\); it was 2560×1440 at 150%$/, fitFrom, 6000)), 'fitted again without "Bigger text" (1.11.4): 1280×720, its own scaling as near as that size allows (125%), for the end of the session to put back');
  await send('ctl', { t: 'lock' });
  check(!!(await waitLog(/Test Phone locks this PC/, from, 4000)) && !!(await waitLog(/a test instance doesn't really lock/, from, 1000)), 'the viewer\'s Lock action (a test instance doesn\'t lock)');
  // While it's being controlled, nothing on this PC widens access to Beam (the viewer could click it): turning it on,
  // the device list, adding or approving devices, controlling another PC, and the pages' pairing links. Off stays.
  const gateFrom = logLines().length;
  const listBefore = JSON.stringify(readConfig().remoteControlDevices);
  rc(`allow:${otherId}`);
  check(!!(await waitLog(/refused turning remote control on while Test Phone controls this PC/, gateFrom, 5000)), 'during a session: turning it on (with other devices) is refused');
  rc(`devices:${viewerId},${otherId}`);
  check(!!(await waitLog(/refused changing who may control it while Test Phone controls this PC/, gateFrom, 5000)), '...changing the device list is refused');
  rc('showallow');
  check(count(/refused changing who may control it while/, gateFrom) >= 2, '...the tray\'s and Settings\' device list doesn\'t open');
  check(JSON.stringify(readConfig().remoteControlDevices) === listBefore, '...and the list is unchanged');
  forward(['--add-device']);
  check(!!(await waitLog(/refused adding a device while/, gateFrom, 5000)), '...adding a device is refused');
  forward(['--approve']);
  check(!!(await waitLog(/refused approving a sign-in while/, gateFrom, 5000)), '...approving a sign-in is refused');
  forward(['--test-open-remote', otherId]);
  check(!!(await waitLog(/refused controlling another PC from this one while/, gateFrom, 5000)), '...controlling another PC from this one is refused');
  rc('viewreload'); // that window's page starts again and asks to control another PC: its host answers 403
  check(!!(await waitLog(/refused controlling another PC from this one from the page while another device controls this PC/, gateFrom, 30000)), '...and a page here can\'t start controlling another PC either (403 from the host)');
  rc('closeviews');
  check(live && (await call(VIEWER(), 'GET', '/api/rc/sessions')).data.sessions.some(x => x.id === live.id), '...and the session goes on');

  // 1.7.1: a file dragged out of the chat while this PC is being controlled is copied instead. A drag's modal loop on the
  // app's thread held up the session's own input there: the mouse button never came back up, the session froze and the
  // viewer couldn't reconnect.
  {
    const sent = await fetch(`${base}/api/file?to=${pcId}`, { method: 'PUT', headers: { ...VIEWER(), 'X-Filename': 'drag-me.txt', 'Content-Type': 'application/octet-stream' }, body: 'dragged while controlled' });
    const itemId = (await sent.json()).id;
    await sleep(1500); // (the app hears of it: this instance doesn't save files by itself)
    forward(['--test-bridge', JSON.stringify({ type: 'saveFile', id: 'test-save', itemId })]);
    check(!!(await waitLog(new RegExp(`Saved down:${itemId} to .*drag-me\\.txt`), from, 15000)), 'a file for this PC arrived and was saved');
    const before = logLines().length;
    fs.rmSync(dir('cfg/clipboard-files.txt'), { force: true });
    forward(['--test-bridge', JSON.stringify({ type: 'dragOut', id: 'test-drag', itemId })]);
    const reply = await waitLog(/Bridge test reply: .*"id":"test-drag"/, before, 15000);
    check(!!reply && /"ok":true/.test(reply) && /"copied":true/.test(reply), `dragging it out of the chat copies it instead (${reply ? reply.slice(reply.indexOf('{')) : 'no reply'})`);
    let files = '';
    try { files = fs.readFileSync(dir('cfg/clipboard-files.txt'), 'utf8').trim(); } catch {}
    check(/drag-me\.txt$/.test(files), `...onto the clipboard as a file, as Explorer's Copy does (${files || 'nothing'})`);
    check(!!(await waitLog(/Drag out of \w+ while this PC is being controlled: copied instead/, before, 3000)), '...and beam.log says why');
  }

  // The banner (1.7.4; the user: it covered the browser's tabs): a pill after 5 s, whole again under the mouse with
  // Stop where it was, dragged anywhere but never off its screen, remembered, and put back by anything else that moves
  // it off. All on the test instance's made-up screen, far off the real ones.
  {
    await sleep(Math.max(0, bannerAt + 6000 - Date.now()));
    let b = await bannerInfo();
    check(!!b && b.state === 'pill', `after 5 s it's a pill (${b ? b.state + ' ' + b.w + 'x' + b.h : 'no answer'})`);
    const right = b && b.right, pillW = b ? b.w : 0;
    b = await bannerInfo('banner:hover:on');
    check(!!b && b.state === 'full' && b.right === right && b.w > pillW + 100, `under the mouse it grows back (${pillW} → ${b ? b.w : '?'} wide), its right end (Stop) where it was`);
    rc('banner:hover:off');
    await sleep(2200);
    b = await bannerInfo();
    check(!!b && b.state === 'pill' && b.right === right, '...and it shrinks again 1.5 s after the mouse leaves');
    const grabX = Math.round(16 * (b ? b.h : 40) / 40); // (Ui.S(16): where the test drag holds it)
    b = await bannerInfo('banner:drag:300,500');
    check(!!b && Math.abs(b.x - (300 - grabX)) <= 1 && Math.abs(b.y - (500 - Math.floor(b.h / 2))) <= 1, `dragged: it goes where it's let go (${b ? b.x + ',' + b.y : 'no answer'})`);
    check(!!b && /^test\|0\.\d+\|0\.\d+$/.test(b.spot) && readConfig().rcBannerSpot === b.spot, `...and the spot is saved for next time (${b ? b.spot : '-'})`);
    b = await bannerInfo('banner:drag:-500,-500');
    check(!!b && b.x === 0 && b.y === 0, `dragged past the top left: it stops at the screen's edge (${b ? b.x + ',' + b.y : 'no answer'})`);
    b = await bannerInfo('banner:drag:5000,5000');
    check(!!b && b.x === b.W - b.w && b.y === b.H - b.h, `...and past the bottom right (${b ? b.x + ',' + b.y : 'no answer'})`);
    const n = logLines().length;
    rc('banner:jump:3000,3000');
    check(!!(await waitLog(/the banner was moved off the screen; it's back at the top/, n, 3000)), 'moved off its screen by something else: back within a second');
    b = await bannerInfo();
    check(!!b && b.y < b.h && Math.abs(b.x - Math.floor((b.W - b.w) / 2)) <= 1, `...at the top centre (${b ? b.x + ',' + b.y : 'no answer'})`);
    check(!!b && b.spot === readConfig().rcBannerSpot && b.spot !== 'none', '...which isn\'t saved: the spot is still where it was put');
  }

  // Stop on the banner.
  t1 = Date.now();
  const sid = live.id;
  rc('stop');
  const stopped = await viewerEvents.wait('rc-end', d => d.id === sid, 8000);
  check(!!stopped && stopped.reason === 'stopped', 'the banner\'s Stop ends it: the viewer hears rc-end stopped');
  check(!!(await waitCtl('bye', t1, 3000)), '...and a bye on ctl first');
  check(!!(await waitLog(/Test Phone stopped controlling this PC after \d+ s \(the banner's Stop\)/, from, 5000)), 'beam.log: who, how long, how it ended');
  check(!!(await waitLog(/this PC's pointer is back to normal \(the session ended\)/, from, 3000)), 'its pointer is back to normal (1.12.6)');
  check(!!(await waitLog(/the shared screen back to 2560×1440 at 150% \(the session ended\)$/, from, 5000)) && !readConfig().rcDisplayRestore, 'the fitted screen is put back when the session ends (1.8)');
  check(!!(await waitLog(/capture stopped \(its host is kept 2 minutes for a reconnect\)/, from, 5000)), 'the capture stopped at once (its host is kept 2 minutes for a reconnect)');
  await endViewer();
  console.log(`  that session ran ${Math.round((Date.now() - t0) / 1000)} s`);

  // 8. The banner ignores clicks for 500 ms; the kill switch ends it.
  from = logLines().length;
  rc('guard');
  t0 = Date.now();
  r = await startSession();
  const ignored = await waitLog(/Stop ignored, the banner appeared \d+ ms ago/, from, 10000);
  check(!!ignored, `a click on Stop as the banner appears is ignored (${ignored ? ignored.replace(/.*appeared /, '') : 'none'})`);
  {
    // 1.7.4: the next session's banner starts where the last one was put (the bottom right), whole; a double-click
    // puts it back at the top and forgets the spot.
    check(!!(await waitLog(/the banner is where it was put last time/, from, 3000)), 'the next banner starts where the last one was put');
    let b = await bannerInfo();
    check(!!b && b.state === 'full' && Math.abs(b.x - (b.W - b.w)) <= 1 && b.y === b.H - b.h, `...whole, its Stop on the saved spot (${b ? b.state + ' at ' + b.x + ',' + b.y : 'no answer'})`);
    b = await bannerInfo('banner:top');
    check(!!b && b.y < b.h && b.spot === 'none' && !('rcBannerSpot' in readConfig()), `a double-click: back at the top, spot forgotten (${b ? b.x + ',' + b.y : 'no answer'})`);
  }
  check(!!(await waitLog(/capture host reused/, from, 10000)), 'a session soon after the last one reuses its warm capture host');
  check(!!(await waitLog(/a screen capture was allowed/, from, 15000)), '...and the session goes on');
  const sid2 = live.id;
  rc('kill');
  const killed = await viewerEvents.wait('rc-end', d => d.id === sid2, 8000);
  check(!!killed && killed.reason === 'stopped' && !!(await waitLog(/Remote control: kill switch \(test\)/, from, 2000)), 'the kill switch ends it at once');
  check(!!(await waitLog(/capture stopped|capture host closed$/, from, 12000)), '...and the capture stops');
  await endViewer();

  // 8b. (1.11.4) Windows' Stop sharing with no display change lately ends it, as before (one just after a change starts
  // the capture again instead: checked in 7).
  from = logLines().length;
  r = await startSession();
  check(!!(await waitLog(/Test Phone is controlling this PC \(peer/, from, 15000)), 'another session, live');
  const sid3 = live.id;
  rc('trackended:stale');
  const shared = await viewerEvents.wait('rc-end', d => d.id === sid3, 8000);
  check(!!shared && !!(await waitLog(/stopped controlling this PC after \d+ s \(Stop sharing on Windows' sharing bar\)/, from, 3000)), 'Windows\' Stop sharing with no display change lately: it ends, as before (1.11.4)');
  await endViewer();

  // 9. The lease: a server restart forgets sessions; the PC's next lease (every 3 s here) gets 404 and it ends.
  from = logLines().length;
  r = await startSession();
  await waitLog(/Remote control: capturing/, from, 15000);
  await sleep(1500); // the offer and candidates are out: only leases meet the restarted server
  await stopServer();
  await startServer();
  const leaseEnd = await waitLog(/the server ended it \(lease answered 404\)/, from, 25000);
  check(!!leaseEnd, 'after a server restart the next lease gets 404: the PC ends the session');
  check(!!(await waitLog(/capture stopped|capture host closed$/, from, 12000)), '...and stops capturing');
  live = null;
  viewerEvents.close();
  viewerEvents = await openEvents(VIEWER());
  viewerEvents.on = e => { onViewerEvent(e).catch(() => {}); };
  await waitLog(/Events: /, from, 15000);
  forward(['--test-mode', 'foreground']); // the new stream starts in background mode
  await sleep(2500);

  // 10. Revocation: turned off from another device (rc-disable) during a session.
  from = logLines().length;
  pc = await waitFor(async () => { const d = await pcRecord(); return d && d.can && d.can.remoteControl ? d : null; }, 15000);
  r = await startSession();
  check(r.status === 201, 'a new session after the restart');
  await waitLog(/a screen capture was allowed/, from, 15000);
  r = await call(VIEWER(), 'POST', '/api/rc/disable', { device: pcId });
  check(r.status === 202, 'another device turns it off: 202');
  check(!!(await waitLog(/Remote control: turned off on this PC \(from Test Phone\)/, from, 8000)), 'the PC turns its switch off');
  check(!!(await waitLog(/stopped controlling this PC|request ended before it was live/, from, 5000)), '...and the session ends');
  pc = await waitFor(async () => { const d = await pcRecord(); return d && d.status && d.status.remoteControl === false ? d : null; }, 10000);
  check(!!pc && pc.can.remoteControl === false, 'it reports remoteControl false (which settles the pending disable)');
  const cfg2 = readConfig();
  check(cfg2.allowRemoteControl === false && cfg2.remoteControlDevices.length === 0, 'config.json: off, the list cleared');
  live = null;

  // 11. Revocation: the viewer device is removed mid-session.
  from = logLines().length;
  rc(`allow:${viewerId}`);
  pc = await waitFor(async () => { const d = await pcRecord(); return d && d.can && d.can.remoteControl ? d : null; }, 10000);
  check(!!pc, 'turned on again from this PC: allowed again (no disable pending)');
  await waitLog(/is pinned to the Tailscale machine/, from, 10000);
  r = await startSession();
  await waitLog(/a screen capture was allowed/, from, 15000);
  r = await call(OTHER(), 'DELETE', `/api/devices/${viewerId}`);
  check(r.status === 200 || r.status === 204, `the viewer device is removed (${r.status})`);
  check(!!(await waitLog(/stopped controlling this PC .*\((revoked|its device was removed)|request ended before it was live \((revoked|its device was removed)/, from, 8000)), 'the session ends with the device');
  check(!!(await waitLog(/capture stopped|capture host closed$/, from, 12000)), '...and the capture stops');
  live = null;

  // 12. The viewer window: a profile of its own; the sign-in is a cookie, never a URL.
  from = logLines().length;
  forward(['--test-open-remote', otherId]);
  check(!!(await waitLog(/Remote control: opened the viewer for Other Laptop/, from, 8000)), 'the viewer window opens for a device');
  check(!!(await waitLog(/Remote view: its own profile \(RemoteView\), WebRTC playout delay 0/, 0, 8000)), '...with its own profile and the playout-delay field trial (made once per run)');
  await sleep(5000);
  // The keyboard hook is the page's to ask for: a reload (or a crashed page) drops it until the new page asks again.
  rc('viewmsg:' + JSON.stringify({ type: 'keyboardHook', on: true, id: 'test-hook' }));
  check(!!(await waitLog(/Remote view: keyboard hook wanted by the page/, from, 5000)), 'the viewer page asks for the keyboard hook');
  rc('viewreload');
  check(!!(await waitLog(/Remote view: keyboard hook off \(its page loads again\)/, from, 8000)), '...and a reload drops it');
  await sleep(2000);
  rc('closeviews');
  await sleep(1500);

  // 12b. The Windows app as the viewer: a second instance ("RC Test Laptop") opens its viewer window on this PC, with the
  // web app's remote.js. The page signs in with the app's token as a cookie, and its host adds the device key to every
  // /api/ request on the way out. The server takes nothing less from a windows token for remote control (starting the
  // session, the signals on its stream, ending it), so the session working end to end shows it.
  from = logLines().length;
  startLaptop();
  check(!!(await waitLog2(/Perf: connected/, 0, 30000)), 'a second app instance (the viewer, RC Test Laptop) connects');
  forward2(['--test-mode', 'foreground']);
  await sleep(2000);
  forward(['--test-poke']); // the device list with the laptop, now
  await sleep(1500);
  rc(`allow:${laptopId}`);
  check(!!(await waitLog(/allowed on this PC \(test\), for RC Test Laptop$/, from, 8000)), 'this PC allows RC Test Laptop');
  await waitLog(/RC Test Laptop is pinned to the Tailscale machine/, from, 10000);
  pc = await waitFor(async () => { const d = await pcRecord(); return d && d.can && d.can.remoteControl ? d : null; }, 10000);
  const from2 = logLines2().length;
  forward2(['--test-open-remote', pcId]);
  check(!!(await waitLog2(/Remote control: opened the viewer for RC Test PC/, from2, 8000)), 'its viewer window opens on this PC (Control)');
  check(!!(await waitLog(/RC Test Laptop asks to control this PC/, from, 30000)), '...its page starts the session (POST /api/rc/sessions, the cookie plus the device key)');
  const viaWindow = await waitLog(/RC Test Laptop is controlling this PC \(peer .* is rc-test-machine, checked\)/, from, 30000);
  check(!!viaWindow, '...the offer reaches its page (its stream showed the key), it answers, and the PC checks the peer: live');
  await sleep(3000);
  forward2(['--test-rc', 'closeviews']);
  // Its own end request carries the key too: a windows token without it can't end a session. (The viewer page may
  // hang up by itself first, "failed": remote.js's peer check doesn't yet wait for a peer-reflexive address to
  // resolve, as the PC does; reported to the web agent.)
  const byWindow = await waitLog(/RC Test Laptop stopped controlling this PC after \d+ s \((stopped|failed), by RC Test Laptop\)/, from, 15000);
  check(!!byWindow, `the viewer window ends the session itself (${byWindow ? byWindow.replace(/.*after \d+ s \(/, '(') : 'no end from it'})`);
  if (byWindow && /failed/.test(byWindow)) console.log('  note: the viewer page hung up on its own peer check (remote.js, an unresolved peer-reflexive address)');
  await quitLaptop();
  check(laptopExit !== undefined, 'the second instance quit');

  // 13. Afterwards: nothing captured runs, the log is content-free, and the token never sits in a URL on disk.
  const cfgEnd = readConfig();
  const appKey = cfgEnd.keyProtected ? unprotect(cfgEnd.keyProtected) : cfgEnd.key; // the token both web views carry
  check(!!appKey && !cfgEnd.key && !fs.readFileSync(cfgPath, 'utf8').includes(appKey), 'config.json keeps the sign-in DPAPI-protected, never in clear');
  await quitApp();
  check(appExit !== undefined, 'the app quit');
  const log = fs.readFileSync(logPath, 'utf8');
  const leaks = ['a=fingerprint', 'a=ice-ufrag', 'candidate:', ...markers].filter(m => log.includes(m));
  check(leaks.length === 0, `beam.log has no SDP, candidates or clipboard text${leaks.length ? ' (found: ' + leaks.join(', ') + ')' : ''}`);
  const ids = [sid, sid2].filter(x => log.includes(x));
  check(ids.length === 0, 'beam.log has no session ids');
  const found = [];
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      let buf; try { buf = fs.readFileSync(p); } catch { continue; }
      // The tokens themselves, and a URL carrying one (the web app's own code mentions "?key=" as text: not a URL).
      const tokens = [key, appKey].filter(Boolean);
      for (const m of tokens.concat(tokens.map(t => 'key=' + t.slice(0, 16)), tokens.map(t => 'key=' + encodeURIComponent(t).slice(0, 16))))
        if (buf.includes(Buffer.from(m, 'utf8')) || buf.includes(Buffer.from(m, 'utf16le'))) found.push(path.relative(TMP, p) + ' (' + (tokens.includes(m) ? 'a token' : 'a URL with a token') + ')');
    }
  };
  walk(dir('cfg/WebView2'));
  check(found.length === 0, `no WebView2 profile holds a token, or a URL with one, on disk (history, session, cache)${found.length ? ': ' + [...new Set(found)].slice(0, 5).join('; ') : ''}`);
  check(fs.existsSync(dir('cfg/WebView2/RemoteHost')) && fs.existsSync(dir('cfg/WebView2/RemoteView')), 'the capture host and the viewer have their own profiles');
} catch (e) {
  failures.push(e.message);
  console.log('FAIL ' + (e.stack || e.message));
} finally {
  try { if (cdp) cdp.close(); } catch {}
  if (edge) { try { edge.kill(); } catch {} }
  await quitLaptop();
  if (laptop && laptopExit === undefined) { try { laptop.kill(); } catch {} }
  await quitApp();
  if (app && appExit === undefined) { try { app.kill(); } catch {} }
  await stopServer();
  if (tsPipe) await tsPipe.close().catch(() => {});
  await sleep(1500);
  if (!KEEP && failures.length === 0) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { console.log('(temp folder kept: ' + e.message + ')'); } }
  else console.log('kept ' + TMP);
  console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nAll remote control checks passed.');
  process.exit(failures.length ? 1 : 0);
}
