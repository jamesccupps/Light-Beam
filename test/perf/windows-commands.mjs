#!/usr/bin/env node
// Beam for Windows 1.25 (server 1.32): commands on this PC from a device that may control it. Real PowerShell and
// Command Prompt commands (harmless ones: output, an exit code, a ping of 127.0.0.1) run in a test instance; their
// output streams back; Stop ends the whole process tree; refusals; the switch only at the PC; nothing of a command in
// beam.log. Exits 1 if a check fails.
//
//   node test/perf/windows-commands.mjs [--exe <Beam.exe>] [--keep]
//
// Isolated like the other windows-* checks: a scratch server (this checkout's server.js) on 127.0.0.1:8803 with a fake
// Tailscale (its LocalAPI here, the app's `tailscale` CLI a script), and a copy of Beam.exe with --config in a temp
// folder (quiet, off-screen, no warm capture host). Nothing is clicked or typed; nothing is captured.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = 8803;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const exeArg = args.indexOf('--exe');
const EXE = exeArg >= 0 ? args[exeArg + 1] : [path.join(ROOT, 'windows', 'bin', 'Beam.exe'), path.join(ROOT, 'dist', 'Beam.exe')].find(f => fs.existsSync(f));
const KEEP = args.includes('--keep');
const TMP = path.join(os.tmpdir(), `beam-commands-win-${Date.now()}`);
const failures = [];
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
  return ok;
}
const dir = p => path.join(TMP, p);
for (const d of ['data', 'dist', 'cfg', 'app', 'ts']) fs.mkdirSync(dir(d), { recursive: true });
const cfgPath = dir('cfg/config.json'), logPath = dir('cfg/beam.log'), appExe = dir('app/Beam.exe');
const base = `http://127.0.0.1:${PORT}`;
const pcId = 'cmdtestpc' + crypto.randomBytes(8).toString('hex');
const viewerId = 'cmdtestphone' + crypto.randomBytes(8).toString('hex');
const otherId = 'cmdtestother' + crypto.randomBytes(8).toString('hex');
let server, app, appExit, key, tsPipe;
const isTs = a => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a) || /^fd7a:115c:a1e0:/i.test(a);
const selfIps = [...new Set(Object.values(os.networkInterfaces()).flat().map(a => a.address).filter(isTs))];

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
async function waitFor(fn, ms = 10000, step = 200) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
}

const profiles = { [viewerId]: crypto.randomBytes(8).toString('hex'), [otherId]: crypto.randomBytes(8).toString('hex') };
const headersFor = (id, name, platform = 'android') => ({ Authorization: `Bearer ${key}`, 'X-Beam-Device-Id': id, 'X-Beam-Device': name, 'X-Beam-Platform': platform, 'X-Beam-App-Version': '1.6.0', 'X-Beam-Profile': profiles[id] });
const VIEWER = () => headersFor(viewerId, 'Test Phone');
const OTHER = () => headersFor(otherId, 'Other Phone');
async function call(h, method, p, body) {
  const res = await fetch(base + p, { method, headers: { ...h, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const pcRecord = async () => (await call(VIEWER(), 'GET', '/api/devices')).data.devices.find(d => d.id === pcId);

// A command on the test PC, its stream read as it comes: { status, events, text(s), ended, end, first(re) }.
async function runCommand(h, shell, command) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/devices/${pcId}/commands`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ shell, command }), signal: ctrl.signal });
  const r = { status: res.status, events: [], ended: false, end: null, at: Date.now(), times: [] };
  if (res.status !== 200) { r.data = await res.json().catch(() => null); r.ended = true; return r; }
  r.close = () => ctrl.abort();
  r.text = (s = null) => r.events.filter(e => e.event === 'out').flatMap(e => e.data.out).filter(p => !s || p.s === s).map(p => p.t).join('');
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
        const lines = block.split('\n');
        const event = lines.find(l => l.startsWith('event: '))?.slice(7);
        const data = lines.find(l => l.startsWith('data: '))?.slice(6);
        if (!event) continue;
        const e = { event, data: JSON.parse(data), at: Date.now() - r.at };
        r.events.push(e);
        if (event === 'end') r.end = e.data;
      }
    }
  })().catch(() => {}).finally(() => { r.ended = true; });
  r.done = (ms = 30000) => waitFor(() => r.ended, ms, 100);
  r.id = (await waitFor(() => r.events.find(e => e.event === 'start'), 5000, 50))?.data.id;
  return r;
}

// ---------------------------------------------------------------- the fake tailnet (as windows-rc's)
function fakeLocalApi() {
  const where = `\\\\.\\pipe\\beam-cmd-test-ts-${process.pid}`;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://local-tailscaled.sock');
    const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/localapi/v0/status') return reply(200, { Self: { ID: 'nSELF', HostName: 'cmd-test-machine', DNSName: 'cmd-test-machine.tail0000.ts.net.', TailscaleIPs: selfIps, UserID: 4242 }, Peer: {}, User: { 4242: { LoginName: 'owner@example.com' } } });
    if (u.pathname === '/localapi/v0/whois') return reply(404, {});
    if (u.pathname === '/localapi/v0/serve-config') return reply(200, {});
    reply(404, {});
  });
  return new Promise(r => srv.listen(where, () => r({ socket: where, close: () => new Promise(c => srv.close(c)) })));
}
const tsState = { owner: 4242, nodes: {} };
for (const ip of selfIps) tsState.nodes[ip] = { id: 'nTESTNODE1', name: 'cmd-test-machine', owner: 4242 };
const writeTs = () => fs.writeFileSync(dir('ts/state.json'), JSON.stringify(tsState));
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
  console.log(JSON.stringify({ Node: { StableID: n.id, ComputedName: n.name, Name: n.name + '.tail0000.ts.net.', User: n.owner, Addresses: addrs }, UserProfile: { ID: n.owner, LoginName: n.owner === st.owner ? 'owner@example.com' : 'someone@else.com' } }));
  process.exit(0);
}
process.exit(2);
`);

// ---------------------------------------------------------------- the app
const appEnv = () => ({ ...process.env, BEAM_LOCAL_URLS: base, BEAM_TEST_PEERS: base, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEVTOOLS}` });
const forward = a => spawnSync(appExe, ['--config', cfgPath, ...a], { env: appEnv(), windowsHide: true, timeout: 20000 });
const rc = cmd => forward(['--test-rc', cmd]);
const readConfig = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
async function bridge(msg) {
  const from = logLines().length;
  forward(['--test-bridge', JSON.stringify(msg)]);
  return waitLog(new RegExp(`Bridge test reply: .*"id":"${msg.id}"`), from, 15000);
}
async function quitApp() {
  if (!app || appExit !== undefined) return;
  forward(['--quit']);
  for (let i = 0; i < 80 && appExit === undefined; i++) await sleep(250);
  if (appExit === undefined) { try { app.kill(); } catch {} }
  await sleep(1000);
}
// Processes whose command line holds `marker` (a ping a command started): Stop must leave none.
function processesWith(marker) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${marker}') }).Count`], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return Number(r.stdout.trim()) || 0;
}


// (the window check) A PC that takes commands, as the server sees one: its app's stream and posts, answering each
// command with "first", then "second" a moment later, then exit 0. Another Windows account's install (its own profile).
const targetId = 'cmdtesttarget' + crypto.randomBytes(8).toString('hex');
const TARGET = () => ({ Authorization: `Bearer ${key}`, 'X-Beam-Device-Id': targetId, 'X-Beam-Device': 'Target PC', 'X-Beam-Platform': 'windows', 'X-Beam-App-Version': '1.25.0', 'X-Beam-Profile': 'f0e1d2c3b4a59687' });
const targetRuns = [];
async function startTarget() {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events?device=${targetId}&platform=windows&version=1.25.0`, { headers: TARGET(), signal: ac.signal });
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
        const lines = buf.slice(0, i).split('\n');
        buf = buf.slice(i + 2);
        if (lines.find(l => l.startsWith('event: '))?.slice(7) !== 'command-run') continue;
        const d = JSON.parse(lines.find(l => l.startsWith('data: ')).slice(6));
        targetRuns.push(d);
        const post = (seq, body) => call(TARGET(), 'POST', '/api/devices/me/commands', { id: d.id, seq, ...body });
        (async () => {
          await post(1, { running: true, out: [{ s: 'o', t: 'first\n' }] });
          await sleep(1500);
          await post(2, { out: [{ s: 'o', t: 'second\n' }] });
          await post(3, { end: { code: 0, ms: 1600 } });
        })();
      }
    }
  })().catch(() => {});
  return ac;
}
// The test PC's window, through WebView2's DevTools port (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS on that instance).
const DEVTOOLS = 8807;
async function windowPage() {
  const target = await waitFor(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${DEVTOOLS}/json/list`)).json()).find(x => x.type === 'page' && x.url.startsWith(base)); } catch { return null; }
  }, 30000, 300);
  if (!target) return null;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let n = 0;
  const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const evaluate = expression => new Promise(resolve => {
    const id = ++n;
    pending.set(id, m => resolve(m.result?.result?.value));
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  return { evaluate, close: () => ws.close() };
}

try {
  if (!EXE) throw new Error('No Beam.exe: build with windows\\build.cmd or pass --exe');
  if (!selfIps.length) throw new Error('This PC has no Tailscale address (the fake tailnet uses them)');
  fs.copyFileSync(EXE, appExe);
  console.log(`Beam: ${EXE}\ntemp: ${TMP}`);
  writeTs();
  tsPipe = await fakeLocalApi();
  const out = fs.openSync(dir('server.out.log'), 'a');
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, BEAM_TAILSCALE: '', BEAM_TAILSCALE_SOCKET: tsPipe.socket, BEAM_HOST: '127.0.0.1', BEAM_PORT: String(PORT), BEAM_DATA: dir('data'), BEAM_DIST: dir('dist') } });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/api/hello`)).ok) break; } catch {} await sleep(200); }
  key = fs.readFileSync(dir('data/key'), 'utf8').trim();
  await call(VIEWER(), 'GET', '/api/me');
  await call(OTHER(), 'GET', '/api/me');
  // The test PC signs in as a Beam app does (a Windows sign-in, tied to its device key on first use), so its window's
  // requests need that key: the app's guard adds it to a command's requests, as to remote control's.
  const made = await (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Beam-Platform': 'windows' },
    body: JSON.stringify({ secret: key, client: 'app', platform: 'windows', deviceId: pcId }) })).json();
  if (!made.key || made.you !== pcId) throw new Error('no Windows sign-in for the test PC');
  fs.writeFileSync(cfgPath, JSON.stringify({ server: base, key: made.key, deviceId: pcId, deviceName: 'Commands Test PC', quiet: true, testOffscreen: true, autoUpdate: false,
    autostartInitialized: true, sendToMenu: false, outbox: false, autoCopy: false, autoSave: false, testNoWarmHost: true,
    testTailscaleExe: process.execPath, testTailscaleArgs: `"${dir('ts/fake-tailscale.mjs')}"` }, null, 2));
  app = spawn(appExe, ['--config', cfgPath, '--background'], { env: appEnv(), windowsHide: true, stdio: 'ignore' });
  app.on('exit', code => { appExit = code; });
  if (!(await waitLog(/Perf: connected/, 0, 30000))) throw new Error('the app never connected');
  await waitLog(/First sync/, 0, 30000);
  forward(['--test-mode', 'foreground']); // device lists at once
  // Remote control on for the phone only (pinned to its machine), as at the PC; no capture host kept warm.
  let from = logLines().length;
  rc(`allow:${viewerId}`);
  check(!!(await waitLog(/Test Phone is pinned to the Tailscale machine cmd-test-machine/, from, 15000)), 'remote control on for Test Phone, pinned to its machine');
  check(!(await waitLog(/keeping a capture host warm/, from, 1500)), '...with no capture host kept warm (a test instance)');
  let pc = await waitFor(async () => { const d = await pcRecord(); return d?.can?.remoteControl ? d : null; });
  check(!!pc && pc.can.commands === false, 'commands are off until turned on at the PC (can.commands false)');
  let r = await runCommand(VIEWER(), 'powershell', 'Get-Date');
  check(r.status === 409 && r.data?.reason === 'off', `a command now: 409 off (${r.status} ${r.data?.reason})`);
  // The page can't turn them on; the PC can (here the test's way round its confirmation).
  const refused = await bridge({ type: 'setSettings', id: 'test-cmd-on', settings: { commandsAllowed: true } });
  check(!!refused && /"code":"native-only"/.test(refused) && readConfig().commandsAllowed !== true, 'the page asking to turn them on: native-only, still off');
  from = logLines().length;
  rc('commands:on');
  check(!!(await waitLog(/Commands: the devices that may control this PC may run commands on it \(test\)/, from, 5000)), 'turned on at the PC');
  pc = await waitFor(async () => { const d = await pcRecord(); return d?.can?.commands ? d : null; });
  check(!!pc && pc.status.commands === true && readConfig().commandsAllowed === true, 'the server hears it at once (status commands, can.commands); config.json keeps it');
  const got = await bridge({ type: 'getSettings', id: 'test-cmd-get' });
  check(!!got && /"commandsAllowed":true/.test(got), 'the page sees the switch');

  // 1. PowerShell: UTF-8 both ways, errors apart, exit code, the output as it comes.
  const markers = ['caf\u00e9', 'oops-marker', 'line 2 of 3', 'secret-not-real-7731'];
  from = logLines().length;
  r = await runCommand(VIEWER(), 'powershell', `$token = 'secret-not-real-7731'\nWrite-Output 'caf\u00e9 \u2713 \u{1F600}'\nWrite-Error 'oops-marker'\n1..3 | ForEach-Object { "line $_ of 3" }\nStart-Sleep -Milliseconds 1500\nWrite-Output 'later'\nexit 7`);
  await r.done(30000);
  const outText = r.text('o'), errText = r.text('e');
  check(r.status === 200 && r.events[0]?.event === 'start' && r.events.some(e => e.event === 'running'), 'the stream: start, then running');
  check(outText.includes('caf\u00e9 \u2713 \u{1F600}') && outText.includes('line 3 of 3'), `PowerShell's output, UTF-8 (${JSON.stringify(outText.slice(0, 60))})`);
  check(/oops-marker/.test(errText) && !/oops-marker/.test(outText), 'its errors come apart (stderr)');
  check(r.end?.code === 7 && !r.end.stopped, `the exit code (${JSON.stringify(r.end)})`);
  const early = r.events.find(e => e.event === 'out' && e.data.out.some(p => p.s === 'o' && p.t.includes('line 3 of 3')));
  const late = r.events.find(e => e.event === 'out' && e.data.out.some(p => p.s === 'o' && p.t.includes('later'))); // (Write-Error's message repeats the whole command on stderr)
  check(!!early && !!late && late.at - early.at > 1000, `output streams while it runs (${early?.at} ms, then ${late?.at} ms; ${r.events.map(e => e.event + '@' + e.at).join(' ')})`);
  check(!!(await waitLog(/Commands: Test Phone asks to run a PowerShell command here \(\d+ characters\)/, from, 3000)), 'beam.log says who asked, the shell and its length');
  check(!!(await waitLog(/Commands: run [a-f0-9]{16} \(Test Phone, PowerShell\) ended: exit code 7 after [\d.]+ s, \d+ characters of output/, from, 5000)), '...and how it ended');
  const log = fs.readFileSync(logPath, 'utf8');
  check(!markers.some(m => log.includes(m)), 'beam.log never has the command or its output');
  const serverLog = fs.readFileSync(dir('server.out.log'), 'utf8');
  check(!markers.some(m => serverLog.includes(m)), '...nor does the server\'s');

  // 2. Quotes and more lines need no escaping (the command goes on PowerShell's input); a failed cmdlet last: 1.
  r = await runCommand(VIEWER(), 'powershell', `$x = "a ""quoted"" thing"\nif ($x -like '*quoted*') {\n  Write-Output "yes: $x"\n}\nWrite-Output 'back\\slash\\'\nGet-Item 'C:\\nope-not-here-cmdtest'`);
  await r.done(30000);
  check(r.text('o').includes('yes: a "quoted" thing') && r.text('o').includes('back\\slash\\'), `quotes and lines as typed (${JSON.stringify(r.text('o').slice(0, 60))})`);
  check(r.end?.code === 1 && /Cannot find path/.test(r.text('e')), `a failed cmdlet last: exit 1 (${r.end?.code})`);
  r = await runCommand(VIEWER(), 'powershell', 'cmd /c exit 5');
  await r.done(30000);
  check(r.end?.code === 5, `a failing program last: its code (${r.end?.code})`);
  r = await runCommand(VIEWER(), 'powershell', '$n = Read-Host "Name"; Write-Output "after:$n"');
  await r.done(30000);
  check(r.text('o').includes('after:') && /NonInteractive/.test(r.text('e')), 'a command that asks for input gets none (no hang)');

  // 3. Command Prompt: one line, its own code page; pause doesn't wait.
  r = await runCommand(VIEWER(), 'cmd', 'echo hello-cmd & ver & pause & exit /b 3');
  await r.done(30000);
  check(r.text('o').includes('hello-cmd') && /Microsoft Windows/.test(r.text('o')) && r.end?.code === 3, `Command Prompt: output and exit code (${r.end?.code})`);

  // 4. Stop: the whole tree goes (PowerShell and the ping it started).
  const marker = `-n 47 127.0.0.1`;
  r = await runCommand(VIEWER(), 'powershell', `ping ${marker}`);
  await waitFor(() => /Reply from|Pinging/.test(r.text('o')), 15000, 100);
  check(processesWith(marker) === 1, 'the command\'s ping is running');
  const stopped = await call(VIEWER(), 'POST', `/api/commands/${r.id}/stop`, {});
  await r.done(15000);
  check(stopped.status === 202 && r.end?.stopped === true, `Stop: the stream ends stopped (${JSON.stringify(r.end)})`);
  await sleep(500);
  check(processesWith(marker) === 0, '...and nothing it started is left');

  // 5. Who: a device not on the PC's list is refused at the PC; one from another Tailscale machine too.
  r = await runCommand(OTHER(), 'powershell', 'Get-Date');
  await r.done(15000);
  check(r.end?.reason === 'not-listed' && /isn't on this PC's list/.test(r.end.error || ''), `a device not on the list: refused at the PC (${r.end?.reason})`);
  for (const ip of selfIps) tsState.nodes[ip].id = 'nANOTHERNODE';
  writeTs();
  r = await runCommand(VIEWER(), 'powershell', 'Get-Date');
  await r.done(15000);
  check(r.end?.reason === 'declined' && /another Tailscale machine/.test(r.end.error || ''), `the phone from another Tailscale machine: refused (${r.end?.error})`);
  for (const ip of selfIps) tsState.nodes[ip].id = 'nTESTNODE1';
  writeTs();

  // 6. Four at once is the most; turning commands off stops what runs.
  const runs = [];
  for (let i = 0; i < 4; i++) runs.push(await runCommand(VIEWER(), 'powershell', 'Start-Sleep -Seconds 40'));
  await waitFor(() => runs.every(x => x.events.some(e => e.event === 'running')), 15000, 100);
  r = await runCommand(VIEWER(), 'cmd', 'ver');
  check(r.status === 429, `a fifth while four run: 429 (${r.status})`);
  check(/Allow commands too \(4 running\)|"commandsRunning":4/.test((await bridge({ type: 'getSettings', id: 'test-cmd-four' })) || ''), 'the PC says four are running');
  from = logLines().length;
  const off = await bridge({ type: 'setSettings', id: 'test-cmd-off', settings: { commandsAllowed: false } });
  check(!!off && /"ok":true/.test(off) && readConfig().commandsAllowed !== true, 'the page turns them off');
  for (const x of runs) await x.done(15000);
  check(runs.every(x => x.end && (x.end.stopped || x.end.reason === 'off')), `...and the four stop (${runs.map(x => x.end?.stopped ? 'stopped' : x.end?.reason).join(', ')})`);
  pc = await waitFor(async () => { const d = await pcRecord(); return d && d.can.commands === false ? d : null; });
  check(!!pc, 'the server hears they are off');

  // 7. Remote control off: commands go with it (and stay off when it's on again).
  rc('commands:on');
  await waitFor(async () => (await pcRecord())?.can?.commands, 10000);
  rc('off');
  await waitFor(async () => (await pcRecord())?.can?.remoteControl === false, 10000);
  check(readConfig().commandsAllowed !== true, 'remote control off turns commands off');
  rc(`allow:${viewerId}`);
  await waitFor(async () => (await pcRecord())?.can?.remoteControl, 10000);
  check((await pcRecord()).can.commands === false && readConfig().commandsAllowed !== true, '...and they stay off when it comes back on');
  rc('commands:on');
  check(!!(await waitFor(async () => (await pcRecord())?.can?.commands, 10000)), 'on again');

  // 8. From this PC's own window (the page in WebView2, its requests through the app's guard, which adds the device
  // key): Run a command on another PC; the output streams in there too.
  const targetStream = await startTarget();
  check(await call(TARGET(), 'PUT', '/api/devices/me/status', { remoteControl: true, locked: false, commands: true }).then(x => x.status) === 204, 'a target PC that takes commands');
  forward(['--test-bridge', JSON.stringify({ type: 'getSettings', id: 'test-window' })]); // (opens the window, off-screen)
  const win = await windowPage();
  check(!!win, 'the window\'s page (DevTools)');
  if (win) {
    const ready = await waitFor(() => win.evaluate(`typeof deviceById === 'function' && deviceById('${targetId}')?.can?.commands === true`), 20000, 300);
    check(!!ready, 'the window knows the target takes commands');
    await win.evaluate(`openCommands(deviceById('${targetId}')); (() => { const t = $('#cmdText'); t.value = 'from-the-window'; t.dispatchEvent(new Event('input')); $('#cmdRunBtn').click(); return true; })()`);
    const firstSeen = await waitFor(() => win.evaluate(`/first/.test($('#cmdOut').textContent) && !/second/.test($('#cmdOut').textContent) && /Running/.test($('#cmdStatus').textContent)`), 10000, 100);
    check(!!firstSeen, 'the first output shows while it runs (streamed through WebView2 and the guard)');
    const done = await waitFor(() => win.evaluate(`/Exit code 0/.test($('#cmdStatus').textContent) && /second/.test($('#cmdOut').textContent)`), 10000, 100);
    check(!!done, `then the rest and its exit code (${await win.evaluate(`$('#cmdStatus').textContent`)})`);
    check(targetRuns.length === 1 && targetRuns[0].command === 'from-the-window' && targetRuns[0].from === pcId, `the target got it from this PC (${targetRuns.map(r => r.from).join(', ')})`);
    await win.evaluate(`$('#genDlg').close(); true`);
    win.close();
  }
  targetStream.abort();

  // 9. Quitting Beam stops what runs (its output would have nowhere to go).
  r = await runCommand(VIEWER(), 'powershell', `ping -n 48 127.0.0.1`);
  await waitFor(() => r.events.some(e => e.event === 'running'), 10000, 100);
  await quitApp();
  await r.done(20000);
  check(processesWith('-n 48 127.0.0.1') === 0, 'quitting stops a running command (nothing left)');
  check(!!r.end, `...and the asker's stream ends (${JSON.stringify(r.end)})`);
} catch (err) {
  console.log(`FAIL ${err.stack || err}`);
  failures.push(String(err));
} finally {
  await quitApp();
  if (server) { server.kill(); await sleep(500); }
  if (tsPipe) await tsPipe.close();
  if (!KEEP) try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
}
