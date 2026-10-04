#!/usr/bin/env node
// Server speed and cost measurements (plan/speed.md). Scratch servers on 127.0.0.1:8791–8799 and netsim on
// 8841–8849 only, with temporary data folders; it never touches a real Beam.
//
//   node test/perf/server-bench.mjs                  every section (a few minutes)
//   node test/perf/server-bench.mjs lists events     only these sections
//   options: --big <MB>       loopback transfer size (default 2048)
//            --net-mb <MB>    transfer size through netsim (default 512)
//            --idle <s>       idle window (default 60)
//            --json <file>    also save the numbers
//            --server <dir>   measure another copy of Beam (e.g. an older version, to compare)
//            --no-budgets     report the numbers without checking the budgets
//
// Sections: startup lists events disk transfer net livedl notify idle memory loop static keepalive
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { startNetsim } from './netsim.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const ROOT = path.resolve(opt('--server', path.resolve(HERE, '..', '..')));
const SERVER = path.join(ROOT, 'server.js');
const PROBE = path.join(HERE, 'server-probe.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-bench-'));
const MB = 1024 * 1024;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const BIG_MB = Number(opt('--big', 2048));
const NET_MB = Number(opt('--net-mb', 512));
const IDLE_S = Number(opt('--idle', 60));
const JSON_OUT = opt('--json', null);
const SECTIONS = ['startup', 'lists', 'events', 'disk', 'transfer', 'net', 'livedl', 'notify', 'idle', 'memory', 'loop', 'static', 'keepalive'];
const valued = new Set(['--big', '--net-mb', '--idle', '--json', '--server']);
const chosen = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]));
for (const c of chosen) if (!SECTIONS.includes(c)) { console.error(`Unknown section ${c}; sections: ${SECTIONS.join(' ')}`); process.exit(2); }
const run = name => !chosen.length || chosen.includes(name);
const results = {};

// ---------------------------------------------------------------- helpers

const children = new Set();
function cleanup() {
  for (const c of children) try { c.kill(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));

const pct = (list, p) => {
  if (!list.length) return NaN;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const median = list => pct(list, 50);
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const kb = n => r1(n / 1024);

function table(title, rows) {
  console.log(`\n${title}`);
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const width = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c]).length)));
  const line = cells => cells.map((c, i) => String(c).padEnd(width[i])).join('  ');
  console.log('  ' + line(cols));
  for (const r of rows) console.log('  ' + line(cols.map(c => r[c])));
}

function cleanEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('BEAM_')) out[k] = v;
  return out;
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

function request(port, method, route, { headers = {}, body, sink = false, timeout = 120_000, useAgent = agent, expect = false } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = http.request({ host: '127.0.0.1', port, method, path: route, headers, agent: useAgent }, res => {
      const chunks = [];
      let bytes = 0;
      res.on('data', c => { bytes += c.length; if (!sink) chunks.push(c); });
      res.on('end', () => {
        const ms = performance.now() - t0; // when the last byte arrived (parsing below isn't the server's time)
        const buf = sink ? null : Buffer.concat(chunks);
        let json;
        if (buf && !res.headers['content-encoding']) try { json = JSON.parse(buf.toString('utf8')); } catch {}
        else if (buf && res.headers['content-encoding'] === 'gzip') try { json = JSON.parse(zlib.gunzipSync(buf).toString('utf8')); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json, bytes, ms, reused: req.reusedSocket });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    if (expect) {
      req.on('continue', () => (body?.pipe ? body.pipe(req) : req.end(body)));
      req.flushHeaders();
    } else if (body?.pipe) {
      body.pipe(req);
    } else {
      req.end(body);
    }
  });
}

// A server with the probe loaded. fast: the test suite's short timeouts (BEAM_TEST_TIMEOUTS=1).
async function startServer(name, port, { env = {}, seed = 0, fast = false } = {}) {
  const dir = path.join(TMP, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  if (seed) seedData(data, seed);
  const t0 = performance.now();
  const child = spawn(process.execPath, ['--expose-gc', '--require', PROBE, SERVER], {
    env: {
      ...cleanEnv(), BEAM_HOST: '127.0.0.1', BEAM_PORT: String(port), BEAM_DATA: data, BEAM_DIST: path.join(dir, 'dist'),
      BEAM_TAILSCALE: 'off', BEAM_WOL_TARGETS: '127.0.0.1:9', BEAM_MAX_ITEMS: '0', ...(fast && { BEAM_TEST_TIMEOUTS: '1' }), ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  children.add(child);
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const exited = new Promise(resolve => child.once('exit', () => { children.delete(child); resolve(); }));
  const pending = new Map();
  let seq = 0;
  child.on('message', m => { if (m?.probe && pending.has(m.id)) { pending.get(m.id)(m.data); pending.delete(m.id); } });
  const ask = (probe) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); child.send({ probe, id }); });
  while (!/is running/.test(out)) {
    if (child.exitCode !== null) throw new Error(`server ${name} exited: ${out}`);
    if (performance.now() - t0 > 30_000) throw new Error(`server ${name} did not start: ${out}`);
    await sleep(5);
  }
  const running = performance.now() - t0;
  const key = fs.readFileSync(path.join(data, 'key'), 'utf8').trim();
  let info;
  for (;;) {
    try {
      info = await request(port, 'GET', '/api/info', { headers: { Authorization: `Bearer ${key}` }, useAgent: false });
      if (info.status === 200) break;
    } catch {}
    await sleep(5);
  }
  const firstInfo = performance.now() - t0;
  const srv = {
    name, port, dir, data, child, key, out: () => out, ask, features: info.json.features || [], startup: { running, firstInfo },
    async stop() { if (child.exitCode === null) { child.kill(); await exited; } },
  };
  return srv;
}

// Signs a device in the way apps do: the master key once, then the device's own token.
const tokens = new Map();
async function device(srv, id, name = id, platform = 'windows', extra = {}) {
  const base = { 'X-Beam-Device-Id': id, 'X-Beam-Device': encodeURIComponent(name), 'X-Beam-Platform': platform, 'X-Beam-App-Version': '1.3.0', ...extra };
  const cacheKey = `${srv.port}|${srv.key}|${id}`;
  if (!tokens.has(cacheKey)) {
    const r = await request(srv.port, 'GET', '/api/me', { headers: { ...base, Authorization: `Bearer ${srv.key}` } });
    tokens.set(cacheKey, r.headers['x-beam-token'] || srv.key);
  }
  return { ...base, Authorization: `Bearer ${tokens.get(cacheKey)}` };
}

const jsonHeaders = h => ({ ...h, 'Content-Type': 'application/json' });
const post = (srv, route, body, headers) => request(srv.port, 'POST', route, { headers: jsonHeaders(headers), body: JSON.stringify(body) });

// An event stream; events[] fills with { event, data, at } as they arrive.
function openStream(port, headers, route = '/api/events') {
  return new Promise((resolve, reject) => {
    const events = [];
    const waiters = [];
    const s = { events, writes: 0, bytes: 0, closed: false };
    const req = http.request({ host: '127.0.0.1', port, path: route, headers, agent: false }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', d => {
        s.writes++;
        s.bytes += Buffer.byteLength(d);
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!event) continue;
          const e = { event, data: data ? JSON.parse(data) : null, at: performance.now() };
          events.push(e);
          for (const w of [...waiters]) if (w.test(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
        }
      });
      res.on('close', () => { s.closed = true; });
      resolve(s);
    });
    s.close = () => req.destroy();
    s.wait = (name, pred = () => true, ms = 10_000) => {
      const found = events.find(e => e.event === name && pred(e.data));
      if (found) return Promise.resolve(found);
      return new Promise((res2, rej) => {
        const w = { test: e => e.event === name && pred(e.data), resolve: e => { clearTimeout(t); res2(e); } };
        const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`no ${name} event within ${ms} ms`)); }, ms);
        waiters.push(w);
      });
    };
    req.on('error', e => (e.code === 'ECONNRESET' ? null : reject(e)));
    req.end();
  });
}

// ---------------------------------------------------------------- realistic data

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ('the of and to in is you that it he was for on are as with his they at be this have from or one had by word but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see number no way could people my than first water been call who oil its now find long down day did get come made may part ' +
  'meeting https://example.com/docs/page?id=42 code function return const let async await server phone laptop desktop photo video file ' +
  'address password(not really) invoice total 12.50 2026-09-30 note todo buy milk remember').split(' ');

function words(rand, bytes) {
  let s = '';
  while (s.length < bytes) s += WORDS[Math.floor(rand() * WORDS.length)] + (rand() < 0.08 ? '.\n' : ' ');
  return s.slice(0, bytes);
}
const logUniform = (rand, lo, hi) => Math.round(Math.exp(Math.log(lo) + rand() * (Math.log(hi) - Math.log(lo))));

// n items like a real Beam's: mostly short texts (50 B – 16 KB, a few over 64 KB kept in data/texts), files with
// thumbnails for images and videos, deliveries to five devices, a few pins.
function seedData(dir, n) {
  const rand = prng(1234 + n);
  for (const sub of ['files', 'texts', 'thumbs', 'uploads', 'logs']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  const devs = ['benchdev0000', 'benchdev0001', 'benchdev0002', 'benchdev0003', 'benchdev0004'];
  const platforms = ['windows', 'android', 'windows', 'windows', 'web'];
  const devices = Object.fromEntries(devs.map((id, i) => [id, { id, name: `Bench ${i}`, platform: platforms[i], firstSeen: Date.now() - 30 * 86400e3, lastSeen: Date.now() - 3600e3, user: 'owner' }]));
  fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify(devices));
  const thumb = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(6000)]);
  const items = [];
  const start = Date.now() - 60_000;
  for (let i = 0; i < n; i++) {
    const id = crypto.randomBytes(8).toString('hex');
    const from = devs[Math.floor(rand() * devs.length)];
    const others = devs.filter(d => d !== from);
    const to = rand() < 0.6 ? [] : [others[Math.floor(rand() * others.length)]];
    const delivered = {};
    for (const d of to.length ? to : others) if (rand() < 0.85) delivered[d] = start - i * 30_000 + 5000;
    const item = { id, from, device: devices[from].name, to, delivered, ts: start - i * 30_000 };
    const r = rand();
    if (r < 0.01) {
      const text = words(rand, logUniform(rand, 70_000, 300_000));
      fs.writeFileSync(path.join(dir, 'texts', `${id}.txt`), text);
      Object.assign(item, { kind: 'text', text: text.slice(0, 16 * 1024), textLength: text.length, textFile: true });
    } else if (r < 0.7) {
      Object.assign(item, { kind: 'text', text: words(rand, logUniform(rand, 50, 16 * 1024)) });
    } else {
      const kind = rand();
      const [name, mime] = kind < 0.45 ? [`IMG_${1000 + i}.jpg`, 'image/jpeg'] : kind < 0.6 ? [`VID_${1000 + i}.mp4`, 'video/mp4'] : kind < 0.85 ? [`Document ${i}.pdf`, 'application/pdf'] : [`archive-${i}.zip`, 'application/zip'];
      Object.assign(item, { kind: 'file', name, size: logUniform(rand, 10_000, 500 * MB), mime });
      if (mime.startsWith('image/')) Object.assign(item, { w: 4032, h: 3024 });
      fs.writeFileSync(path.join(dir, 'files', id), 'x');
      if (/^(image|video)\//.test(mime) && rand() < 0.8) {
        item.thumb = 'jpeg';
        fs.writeFileSync(path.join(dir, 'thumbs', id), thumb);
      }
    }
    if (rand() < 0.02) item.pinned = true;
    items.push(item);
  }
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify(items));
  return items;
}

// ---------------------------------------------------------------- sections

async function startup() {
  const rows = [];
  for (const n of [0, 5000]) {
    const s = await startServer(`startup-${n}`, 8791, { seed: n });
    rows.push({ items: n, 'listening ms': Math.round(s.startup.running), 'first /api/info ms': Math.round(s.startup.firstInfo) });
    await s.stop();
  }
  table('Startup (spawn → "is running" → first /api/info)', rows);
  results.startup = rows;
}

async function lists() {
  const rows = [];
  for (const n of [100, 500, 5000]) {
    const s = await startServer(`lists-${n}`, 8791, { seed: n });
    const h = await device(s, 'benchdev0001', 'Bench 1', 'android');
    const measure = async (headers, route = '/api/items') => {
      for (let i = 0; i < 3; i++) await request(s.port, 'GET', route, { headers });
      const times = [];
      let last;
      for (let i = 0; i < 20; i++) { last = await request(s.port, 'GET', route, { headers }); times.push(last.ms); }
      return { ms: median(times), p95: pct(times, 95), bytes: last.bytes, encoding: last.headers['content-encoding'] || '-', last };
    };
    await s.ask('reset');
    const plain = await measure(h);
    const gz = await measure({ ...h, 'Accept-Encoding': 'gzip, deflate, br' });
    const loop = (await s.ask('stats')).loop;
    const row = {
      items: n, 'median ms': r2(plain.ms), 'p95 ms': r2(plain.p95), 'KB': kb(plain.bytes),
      'with Accept-Encoding: KB': kb(gz.bytes), encoding: gz.encoding, 'gz median ms': r2(gz.ms), 'loop max ms': loop.max,
    };
    if (s.features.includes('items-since')) {
      const cursor = plain.last.json.cursor;
      const d0 = await measure({ ...h, 'Accept-Encoding': 'gzip' }, `/api/items?since=${encodeURIComponent(cursor)}`);
      row['delta (no change) B'] = d0.bytes;
      row['delta ms'] = r2(d0.ms);
    }
    rows.push(row);
    await s.stop();
  }
  table('GET /api/items (loopback, keep-alive; 20 requests after 3 warm-ups)', rows);
  results.lists = rows;
}

async function events() {
  const rows = [];
  const s = await startServer('events', 8791, { seed: 500 });
  const sender = await device(s, 'benchdev0000', 'Bench 0');
  for (const count of [5, 50]) {
    const streams = [];
    for (let i = 0; i < count; i++) {
      const id = `streamdev${String(i).padStart(4, '0')}`;
      const st = await openStream(s.port, await device(s, id, `Stream ${i}`, 'android'));
      await st.wait('hello');
      streams.push(st);
    }
    await sleep(500);
    const sendLat = [];
    for (let k = 0; k < 20; k++) {
      const t0 = performance.now();
      const r = await post(s, '/api/text', { text: `bench ${k}` }, sender);
      const id = r.json.id;
      for (const st of streams) sendLat.push((await st.wait('item', d => d.id === id)).at - t0);
    }
    const ackLat = [];
    const acker = await device(s, 'streamdev0000', 'Stream 0', 'android');
    for (let k = 0; k < 20; k++) {
      const item = (await post(s, '/api/text', { text: `ack ${k}` }, sender)).json;
      await streams[streams.length - 1].wait('item', d => d.id === item.id);
      const t0 = performance.now();
      await request(s.port, 'POST', `/api/items/${item.id}/ack`, { headers: acker });
      ackLat.push((await streams[streams.length - 1].wait('update', d => d.id === item.id && d.delivered.streamdev0000)).at - t0);
    }
    rows.push({ streams: count, 'send→item median ms': r2(median(sendLat)), 'send→item max ms': r2(Math.max(...sendLat)), 'ack→update median ms': r2(median(ackLat)), 'ack→update max ms': r2(Math.max(...ackLat)) });
    for (const st of streams) st.close();
    await sleep(300);
  }
  await s.stop();
  table('Event latency (loopback; send = POST /api/text until each stream has the item event)', rows);
  results.events = rows;
}

async function disk() {
  const s = await startServer('disk', 8791, { seed: 500 });
  const a = await device(s, 'benchdev0000', 'Bench 0');
  const b = await device(s, 'benchdev0001', 'Bench 1', 'android');
  const itemsJson = fs.statSync(path.join(s.data, 'items.json')).size;
  const list = (await request(s.port, 'GET', '/api/items', { headers: a })).json.items;
  const undelivered = list.filter(i => !i.delivered.benchdev0001 && i.from !== 'benchdev0001').map(i => i.id);
  let flip = false;
  let n = 0;
  const ops = {
    send: () => post(s, '/api/text', { text: `a short text ${n++}` }, a),
    ack: () => request(s.port, 'POST', `/api/items/${undelivered.pop()}/ack`, { headers: b }),
    pin: () => request(s.port, 'PATCH', `/api/items/${list[5].id}`, { headers: jsonHeaders(a), body: JSON.stringify({ pinned: (flip = !flip) }) }),
    delete: () => request(s.port, 'DELETE', `/api/items/${list.pop().id}`, { headers: a }),
    'read marker': () => request(s.port, 'PUT', '/api/read', { headers: jsonHeaders(b), body: JSON.stringify({ conversation: 'benchdev0000', ts: Date.now() + n++ }) }),
    'status report': () => request(s.port, 'PUT', '/api/devices/me/status', { headers: jsonHeaders(a), body: JSON.stringify({ battery: { level: 50 + (n++ % 40), charging: false } }) }),
  };
  await sleep(1500); // let the start-up writes settle
  const rows = [];
  for (const [name, op] of Object.entries(ops)) {
    const reps = 10;
    await s.ask('reset');
    const times = [];
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now();
      const r = await op();
      if (r.status >= 300) throw new Error(`${name}: HTTP ${r.status} ${r.body}`);
      times.push(performance.now() - t0);
      await sleep(250); // spaced like real use, so writes are not merged
    }
    const st = await s.ask('stats');
    const top = Object.entries(st.files).sort((x, y) => y[1].bytes - x[1].bytes).slice(0, 3).map(([f, v]) => `${f} ${kb(v.bytes / reps)}K`).join(', ');
    const syncCalls = Object.values(st.sync).reduce((x, y) => x + y, 0);
    rows.push({ operation: name, 'ms': r2(median(times)), 'KB written': kb(st.bytes / reps), 'write calls': r1(st.writes / reps), fsyncs: r1(st.fsyncs / reps), 'renames+links': r1((st.renames + st.links) / reps), 'sync fs calls': r1(syncCalls / reps), 'biggest writes (per op)': top });
  }
  await s.stop();
  table(`Disk per operation at 500 items (items.json is ${kb(itemsJson)} KB); averages over 10`, rows);
  results.disk = { itemsJsonKB: kb(itemsJson), rows };
}

let BLOCK = null; // one random 8 MB block, reused for every upload body
function bodyOf(size) {
  const block = (BLOCK ||= crypto.randomBytes(8 * MB));
  let left = size;
  return Readable.from((function* () {
    while (left > 0) {
      const n = Math.min(left, block.length);
      left -= n;
      yield n === block.length ? block : block.subarray(0, n);
    }
  })());
}

// The resumable upload the apps use: sequential PUTs of `chunk` bytes, each waiting for the reply.
async function uploadFile(port, headers, size, { chunk = 8 * MB, expect = false } = {}) {
  const init = await request(port, 'POST', '/api/uploads', { headers: jsonHeaders(headers), body: JSON.stringify({ name: 'bench.bin', size }) });
  if (init.status !== 201) throw new Error(`upload init: ${init.status} ${init.body}`);
  const id = init.json.id;
  let offset = 0;
  const gaps = [];
  let lastEnd = null;
  while (offset < size) {
    const n = Math.min(chunk, size - offset);
    const t = performance.now();
    if (lastEnd !== null) gaps.push(t - lastEnd);
    const r = await request(port, 'PUT', `/api/uploads/${id}?offset=${offset}`, {
      headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(n), ...(expect && { Expect: '100-continue' }) },
      body: bodyOf(n), expect,
    });
    if (r.status !== 200 && r.status !== 201) throw new Error(`chunk at ${offset}: ${r.status} ${r.body}`);
    lastEnd = performance.now();
    offset += n;
  }
  return { id, chunks: Math.ceil(size / chunk) };
}

async function transferRound(srv, port, size, label, variants) {
  const h = await device(srv, 'benchdev0000', 'Bench 0');
  const rows = [];
  let lastId = null;
  for (const v of variants) {
    const before = await srv.ask('stats');
    const t0 = performance.now();
    let bytes = size;
    if (v.kind === 'upload') {
      const up = await uploadFile(port, h, size, v);
      lastId = up.id;
    } else {
      const r = await request(port, 'GET', `/api/file/${lastId}`, { headers: h, sink: true });
      if (r.status !== 200) throw new Error(`download: ${r.status}`);
      bytes = r.bytes;
    }
    const secs = (performance.now() - t0) / 1000;
    const after = await srv.ask('stats');
    const cpu = (after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system) / 1e6;
    const kernel = (after.cpu.system - before.cpu.system) / 1e6;
    rows.push({ path: label, transfer: v.name, 'MB/s': r1(size / MB / secs), seconds: r1(secs), 'server CPU s/GB': r2(cpu / (bytes / 1024 ** 3)), 'of it kernel': r2(kernel / (bytes / 1024 ** 3)), 'loop max ms': after.loop.max });
    if (v.kind === 'upload' && v.deleteAfter) await request(srv.port, 'DELETE', `/api/items/${lastId}`, { headers: h });
  }
  if (lastId) await request(srv.port, 'DELETE', `/api/items/${lastId}`, { headers: h });
  return rows;
}

async function transfer() {
  const s = await startServer('transfer', 8792, { env: { BEAM_MAX_UPLOAD_MB: String(BIG_MB * 2) } });
  const size = BIG_MB * MB;
  const rows = await transferRound(s, s.port, size, 'loopback', [
    { name: 'upload, 8 MB chunks', kind: 'upload', chunk: 8 * MB, deleteAfter: true },
    { name: 'upload, one PUT', kind: 'upload', chunk: size },
    { name: 'download', kind: 'download' },
  ]);
  await s.stop();
  table(`Transfers of ${BIG_MB} MB on loopback`, rows);
  results.transfer = rows;
}

async function net() {
  const s = await startServer('net', 8793, { env: { BEAM_MAX_UPLOAD_MB: String(NET_MB * 2) } });
  const size = NET_MB * MB;
  const sim = await startNetsim({ listen: 8841, to: `127.0.0.1:${s.port}`, rtt: 25, mbps: 400 });
  const rows = await transferRound(s, sim.port, size, 'netsim 25 ms, 400 Mbit/s', [
    { name: 'upload, 8 MB chunks', kind: 'upload', chunk: 8 * MB, deleteAfter: true },
    { name: 'upload, 8 MB + Expect: 100-continue', kind: 'upload', chunk: 8 * MB, expect: true, deleteAfter: true },
    { name: 'upload, 64 MB chunks', kind: 'upload', chunk: 64 * MB, deleteAfter: true },
    { name: 'upload, one PUT', kind: 'upload', chunk: size },
    { name: 'download', kind: 'download' },
  ]);
  for (const r of rows) r['link idle %'] = Math.max(0, Math.round(100 - (r['MB/s'] / 50) * 100));
  // Small request chains: a text and the item list after a reconnect.
  const h = await device(s, 'benchdev0000', 'Bench 0');
  const chain = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await request(sim.port, 'POST', '/api/text', { headers: jsonHeaders(h), body: JSON.stringify({ text: 'hello' }) });
    chain.push(performance.now() - t0);
  }
  await sim.close();
  await s.stop();
  table(`Transfers of ${NET_MB} MB through netsim (25 ms round trip, 400 Mbit/s = 50 MB/s each way)`, rows);
  console.log(`  send a text through netsim: median ${r1(median(chain))} ms (one round trip = 25 ms)`);
  results.net = { rows, textMs: r1(median(chain)) };
}

// A PC downloads a file while it arrives (P4) but reads slowly (a far site behind a slow uplink) while the upload
// comes in at full speed: the server must not pile the difference up in memory.
async function liveDownload() {
  const s = await startServer('livedl', 8798, { env: { BEAM_MAX_UPLOAD_MB: '4096' } });
  const desk = await device(s, 'benchdev0000', 'Bench 0');
  const far = await device(s, 'benchdev0002', 'Bench 2');
  const size = 512 * MB;
  const init = (await post(s, '/api/uploads', { name: 'live.bin', size }, desk)).json;
  await s.ask('gc');
  const base = (await s.ask('stats')).mem.external;
  let got = 0;
  const reader = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: s.port, path: `/api/file/${init.id}`, headers: far, agent: false }, res => {
      // Read about 8 MB/s: pause after each piece for as long as it takes at that rate.
      res.on('data', c => {
        got += c.length;
        res.pause();
        setTimeout(() => res.resume(), (c.length / (8 * MB)) * 1000);
      });
      resolve(r);
    });
    r.on('error', () => {});
    r.end();
  });
  const t0 = performance.now();
  const upload = request(s.port, 'PUT', `/api/uploads/${init.id}?offset=0`, {
    headers: { ...desk, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) }, body: bodyOf(size),
  });
  let peak = base;
  let done = false;
  upload.then(() => { done = true; }, () => { done = true; });
  while (!done) {
    peak = Math.max(peak, (await s.ask('stats')).mem.external);
    await sleep(100);
  }
  const status = (await upload).status;
  const secs = (performance.now() - t0) / 1000;
  reader.destroy();
  await s.stop();
  const row = { upload: `${size / MB} MB, HTTP ${status}`, 'upload MB/s': r1(size / MB / secs), 'slow reader got MB': r1(got / MB), 'server memory growth MB': r1((peak - base) / MB) };
  table('Live download by a slow reader while 512 MB arrive at full speed', [row]);
  results.livedl = row;
}

// Phone notifications (1.5): a phone shares 40 changes; 5 PCs show them, 5 don't. Every stream is in background
// mode, so a write is a radio wakeup on that device: the 5 outside the audience (and the phone) must get none.
async function notifyCost() {
  const s = await startServer('notify', 8797);
  const phone = await device(s, 'benchphone01', 'Bench phone', 'android');
  const audience = [];
  const others = [];
  for (let i = 0; i < 10; i++) {
    const h = await device(s, `benchpc${String(i).padStart(5, '0')}`, `PC ${i}`, 'windows');
    if (i < 5) {
      await request(s.port, 'PUT', '/api/devices/me/settings', { headers: jsonHeaders(h), body: JSON.stringify({ phoneNotifications: true }) });
      audience.push(await openStream(s.port, h, '/api/events?mode=background'));
    } else {
      others.push(await openStream(s.port, h, '/api/events?mode=background'));
    }
  }
  const own = await openStream(s.port, phone, '/api/events?mode=background');
  for (const st of [...audience, ...others, own]) await st.wait('hello');
  await sleep(1000); // the presence changes above settle (held: background streams aren't woken for them)
  for (const st of [...audience, ...others, own]) { st.writes = 0; st.bytes = 0; }
  const latency = [];
  for (let i = 0; i < 40; i++) {
    const key = `n${i % 25}`; // 25 new, then 15 updates
    const t0 = performance.now();
    const r = await request(s.port, 'PUT', `/api/phone/notifications/${key}`, {
      headers: jsonHeaders(phone),
      body: JSON.stringify({ app: 'com.example.chat', appName: 'Chat', title: `Message ${i}`, text: 'Hello there', lines: [], actions: [{ id: 'r', title: 'Reply', reply: true }] }),
    });
    if (r.status !== 204) throw new Error(`notification PUT: ${r.status} ${r.body}`);
    latency.push((await audience[0].wait('notification', d => d.title === `Message ${i}`)).at - t0);
    await sleep(55); // under the 20-a-second limit
  }
  await sleep(500);
  const per = list => r1(list.reduce((n, st) => n + st.writes, 0) / list.length);
  const row = {
    changes: 40, 'audience writes/stream': per(audience), 'other writes/stream': per(others), 'phone writes': own.writes,
    'PUT → event median ms': r2(median(latency)), 'max ms': r2(Math.max(...latency)),
  };
  for (const st of [...audience, ...others, own]) st.close();
  await s.stop();
  table('Phone notifications: 40 shared changes, 5 PCs in the audience and 5 not (all streams in background mode)', [row]);
  results.notify = row;
}

async function idleCost(mode) {
  const s = await startServer(`idle-${mode}`, 8794, { seed: 100, env: { BEAM_PROBE_TIMERS: '1' } });
  const streams = [];
  for (let i = 0; i < 10; i++) {
    const route = mode === 'background' ? '/api/events?mode=background' : '/api/events';
    streams.push(await openStream(s.port, await device(s, `idledev${String(i).padStart(4, '0')}`, `Idle ${i}`, 'android'), route));
  }
  await sleep(3000);
  for (const st of streams) { st.writes = 0; st.bytes = 0; }
  await s.ask('reset');
  const before = await s.ask('stats');
  await sleep(IDLE_S * 1000);
  const after = await s.ask('stats');
  const cpuMs = (after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system) / 1000;
  const perMin = v => r1((v / IDLE_S) * 60);
  const writes = streams.reduce((n, st) => n + st.writes, 0) / streams.length;
  const row = { mode, 'server CPU ms/min': perMin(cpuMs), 'timer callbacks/min': perMin(after.timers + after.immediates), 'timer wakeups/min': perMin(after.wakeups), 'writes/min per stream': perMin(writes), 'bytes/min per stream': perMin(streams.reduce((n, st) => n + st.bytes, 0) / streams.length), 'rss MB': r1(after.mem.rss / MB) };
  for (const st of streams) st.close();
  await s.stop();
  return row;
}

async function idle() {
  const rows = [await idleCost('foreground')];
  const probe = await startServer('idle-probe', 8794);
  const hasModes = probe.features.includes('stream-modes');
  await probe.stop();
  if (hasModes) rows.push(await idleCost('background'));
  table(`Idle cost with 10 event streams open, over ${IDLE_S} s (production timings)`, rows);
  results.idle = rows;
}

async function memory() {
  const s = await startServer('memory', 8795, { env: { BEAM_MAX_ITEMS: '500' } });
  const devs = [];
  for (let i = 0; i < 5; i++) devs.push(await device(s, `memdev${String(i).padStart(6, '0')}`, `Mem ${i}`, 'android'));
  const streams = [];
  for (const h of devs) streams.push(await openStream(s.port, h));
  const g0 = await s.ask('gc');
  const t0 = performance.now();
  const recent = [];
  const rand = prng(99);
  const one = async i => {
    const h = devs[i % devs.length];
    const r = rand();
    if (r < 0.4 || recent.length < 5) {
      const res = await post(s, '/api/text', { text: `memory test ${i} ${'x'.repeat(Math.floor(rand() * 2000))}` }, h);
      recent.push(res.json.id);
      if (recent.length > 50) recent.shift();
    } else if (r < 0.7) {
      await request(s.port, 'POST', `/api/items/${recent[Math.floor(rand() * recent.length)]}/ack`, { headers: h });
    } else if (r < 0.8) {
      await request(s.port, 'GET', '/api/items', { headers: h, sink: true });
    } else if (r < 0.9) {
      await request(s.port, 'PATCH', `/api/items/${recent[Math.floor(rand() * recent.length)]}`, { headers: jsonHeaders(h), body: JSON.stringify({ pinned: rand() < 0.5 }) });
    } else {
      const id = recent.splice(Math.floor(rand() * recent.length), 1)[0];
      await request(s.port, 'DELETE', `/api/items/${id}`, { headers: h });
    }
  };
  const total = 10_000;
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { while (next < total) await one(next++); }));
  const secs = (performance.now() - t0) / 1000;
  await sleep(1000);
  const g1 = await s.ask('gc');
  for (const st of streams) st.close();
  await s.stop();
  const row = { operations: total, seconds: r1(secs), 'ops/s': Math.round(total / secs), 'heap before MB': r1(g0.heapUsed / MB), 'heap after MB': r1(g1.heapUsed / MB), 'rss before MB': r1(g0.rss / MB), 'rss after MB': r1(g1.rss / MB) };
  table('Memory after 10,000 mixed operations (4 at a time, 5 streams open, at most 500 items)', [row]);
  results.memory = row;
}

async function loop() {
  const rows = [];
  const s = await startServer('loop', 8796, { seed: 5000 });
  const h = await device(s, 'benchdev0000', 'Bench 0');
  const pinger = async (until) => {
    const lat = [];
    while (!until.done) {
      lat.push((await request(s.port, 'GET', '/api/me', { headers: h })).ms);
      await sleep(20);
    }
    return lat;
  };
  const scenario = async (name, work) => {
    await s.ask('reset');
    const until = { done: false };
    const p = pinger(until);
    await work();
    until.done = true;
    const lat = await p;
    const st = await s.ask('stats');
    const topSync = Object.entries(st.sync).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => `${k}×${v}`).join(', ');
    rows.push({ load: name, 'GET /api/me p50 ms': r2(median(lat)), 'p99 ms': r2(pct(lat, 99)), 'max ms': r2(Math.max(...lat)), 'loop p99 ms': st.loop.p99, 'loop max ms': st.loop.max, 'sync fs calls': topSync || '-' });
  };
  await scenario('idle', () => sleep(2000));
  await scenario('GET /api/items (5000) ×20', async () => { for (let i = 0; i < 20; i++) await request(s.port, 'GET', '/api/items', { headers: h, sink: true }); });
  await scenario('100 texts + acks', async () => {
    const b = await device(s, 'benchdev0001', 'Bench 1', 'android');
    for (let i = 0; i < 100; i++) {
      const it = (await post(s, '/api/text', { text: `loop ${i}` }, h)).json;
      await request(s.port, 'POST', `/api/items/${it.id}/ack`, { headers: b });
    }
  });
  await scenario('upload 512 MB', () => uploadFile(s.port, h, 512 * MB));
  await s.stop();
  table('Event-loop blocking at 5000 items (a GET /api/me every 20 ms alongside the load)', rows);
  results.loop = rows;
}

async function staticFiles() {
  const s = await startServer('static', 8797);
  const accept = { 'Accept-Encoding': 'gzip, deflate, br' };
  const index = await request(s.port, 'GET', '/', { headers: accept });
  const html = (index.headers['content-encoding'] === 'br' ? zlib.brotliDecompressSync(index.body) : index.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(index.body) : index.body).toString('utf8');
  // (not what's inside a <template>: inert, nothing of it loads; 1.12.2 names the viewer's remote.js there)
  const loaded = html.replace(/<template[\s\S]*?<\/template>/g, '');
  const refs = [...loaded.matchAll(/(?:src|href)="([^"#]+)"/g)].map(m => m[1]).filter(u => !/^(https?:|data:|mailto:|download\/)/.test(u));
  const urls = ['/', ...new Set(refs.map(u => new URL(u, 'http://x/').pathname + new URL(u, 'http://x/').search))];
  let raw = 0;
  let sent = 0;
  const etags = {};
  const cache = {};
  for (const u of urls) {
    const r = await request(s.port, 'GET', u, { headers: accept });
    const plain = await request(s.port, 'GET', u, {});
    raw += plain.bytes;
    sent += r.bytes;
    etags[u] = r.headers.etag;
    cache[r.headers['cache-control']] = (cache[r.headers['cache-control']] || 0) + 1;
  }
  // A warm open: what a browser asks again. Files marked immutable aren't asked for at all.
  let revalidated = 0;
  let notModified = 0;
  for (const u of urls) {
    const r = await request(s.port, 'GET', u, { headers: { ...accept } });
    if (/immutable/.test(r.headers['cache-control'] || '')) continue;
    revalidated++;
    const again = await request(s.port, 'GET', u, { headers: { ...accept, 'If-None-Match': etags[u] } });
    if (again.status === 304) notModified++;
  }
  await s.stop();
  const row = { files: urls.length, 'raw KB': kb(raw), 'sent KB (compressed)': kb(sent), 'cache-control': Object.entries(cache).map(([k, v]) => `${k}×${v}`).join('; '), 'warm open: requests': revalidated, '304s': notModified };
  table('Static web app (first open, then a warm open)', [row]);
  results.static = row;
}

async function keepalive() {
  const s = await startServer('keepalive', 8798);
  const h = await device(s, 'benchdev0000', 'Bench 0');
  const sim = await startNetsim({ listen: 8842, to: `127.0.0.1:${s.port}`, rtt: 25, mbps: 0 });
  const ka = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const rows = [];
  for (const idleS of [1, 6, 30]) {
    await request(sim.port, 'GET', '/api/me', { headers: h, useAgent: ka });
    await sleep(idleS * 1000);
    const r = await request(sim.port, 'GET', '/api/me', { headers: h, useAgent: ka });
    rows.push({ 'idle before request': `${idleS} s`, 'connection reused': r.reused ? 'yes' : 'no', 'ms through netsim (25 ms)': r1(r.ms) });
  }
  ka.destroy();
  await sim.close();
  await s.stop();
  table('Keep-alive: a request after an idle pause, through netsim', rows);
  results.keepalive = rows;
}

// ---------------------------------------------------------------- budgets
// Limits that fail the run, set from the 1.4.0 numbers on the development PC (Ryzen 5 5600G, Windows, NVMe) with
// room for noise from other work on the machine. Each guards one of the fixes; --no-budgets only reports.
const row = (list, key, value) => list?.find(r => r[key] === value);
const BUDGETS = [
  ['startup', 'listening, 5000 items (ms)', r => row(r.startup, 'items', 5000)?.['listening ms'], '<=', 1500],
  ['lists', 'list of 5000 items, gzipped (KB)', r => row(r.lists, 'items', 5000)?.['with Accept-Encoding: KB'], '<=', 4500],
  ['lists', 'list of 5000 items, gzipped, median (ms)', r => row(r.lists, 'items', 5000)?.['gz median ms'], '<=', 250],
  ['lists', 'delta with no changes (bytes)', r => row(r.lists, 'items', 500)?.['delta (no change) B'], '<=', 200],
  ['events', 'send → item with 50 streams, median (ms)', r => row(r.events, 'streams', 50)?.['send→item median ms'], '<=', 25],
  ['disk', 'fsyncs per ack (acks 250 ms apart)', r => row(r.disk?.rows, 'operation', 'ack')?.fsyncs, '<=', 0.6],
  ['disk', 'KB written per pin (pins 250 ms apart)', r => row(r.disk?.rows, 'operation', 'pin')?.['KB written'], '<=', 600],
  ['transfer', 'loopback upload, one PUT (MB/s)', r => row(r.transfer, 'transfer', 'upload, one PUT')?.['MB/s'], '>=', 100],
  ['transfer', 'loopback download (MB/s)', r => row(r.transfer, 'transfer', 'download')?.['MB/s'], '>=', 150],
  ['transfer', 'server CPU per GB downloaded (s)', r => row(r.transfer, 'transfer', 'download')?.['server CPU s/GB'], '<=', 2],
  ['net', 'upload in 64 MB chunks at 25 ms: link idle (%)', r => row(r.net?.rows, 'transfer', 'upload, 64 MB chunks')?.['link idle %'], '<=', 15],
  ['livedl', 'memory growth while a slow reader follows a 512 MB upload (MB)', r => r.livedl?.['server memory growth MB'], '<=', 128],
  ['notify', 'writes on streams outside the audience (per 40 shared changes)', r => r.notify && r.notify['other writes/stream'] + r.notify['phone writes'], '<=', 0],
  ['notify', 'shared notification → audience event, median (ms)', r => r.notify?.['PUT → event median ms'], '<=', 25],
  ['idle', 'background stream: writes per minute', r => row(r.idle, 'mode', 'background')?.['writes/min per stream'], '<=', 0.5],
  ['idle', 'foreground stream: writes per minute', r => row(r.idle, 'mode', 'foreground')?.['writes/min per stream'], '<=', 3],
  ['idle', 'server CPU with 10 idle streams (ms/min)', r => row(r.idle, 'mode', 'foreground')?.['server CPU ms/min'], '<=', 400],
  ['idle', 'timer wakeups with 10 idle streams (per min)', r => row(r.idle, 'mode', 'foreground')?.['timer wakeups/min'], '<=', 30],
  ['memory', 'heap growth over 10,000 operations (MB)', r => r.memory && r.memory['heap after MB'] - r.memory['heap before MB'], '<=', 10],
  ['loop', 'GET /api/me p99 while lists of 5000 are served (ms)', r => row(r.loop, 'load', 'GET /api/items (5000) ×20')?.['p99 ms'], '<=', 80],
  ['static', 'warm open: requests', r => r.static?.['warm open: requests'], '<=', 1],
  // 1.5 phone.js and 1.6 remote.js grew the first open from ~114 to ~151 KB, 1.8–1.12 to 174–180; 1.12.2 loads remote.js
  // only for #remote= (its own page): 140 KB.
  ['static', 'first open: compressed KB', r => r.static?.['sent KB (compressed)'], '<=', 150],
  ['keepalive', 'connection reused after 30 s idle', r => (row(r.keepalive, 'idle before request', '30 s')?.['connection reused'] === 'yes' ? 1 : row(r.keepalive, 'idle before request', '30 s') ? 0 : undefined), '>=', 1],
];

function checkBudgets() {
  const rows = [];
  for (const [section, label, get, op, limit] of BUDGETS) {
    if (!results[section]) continue;
    const value = get(results);
    if (value === undefined || value === null || Number.isNaN(value)) continue;
    const ok = op === '<=' ? value <= limit : value >= limit;
    rows.push({ budget: label, value: r2(value), limit: `${op} ${limit}`, result: ok ? 'ok' : 'OVER' });
  }
  if (rows.length) table('Budgets', rows);
  return rows.filter(r => r.result !== 'ok').length;
}

// ---------------------------------------------------------------- main

const t0 = performance.now();
console.log(`Beam server bench: ${SERVER}\nNode ${process.version}, ${os.cpus().length} × ${os.cpus()[0]?.model?.trim()}, ${os.platform()} ${os.release()}`);
try {
  if (run('startup')) await startup();
  if (run('lists')) await lists();
  if (run('events')) await events();
  if (run('disk')) await disk();
  if (run('transfer')) await transfer();
  if (run('net')) await net();
  if (run('livedl')) await liveDownload();
  if (run('notify')) await notifyCost();
  if (run('idle')) await idle();
  if (run('memory')) await memory();
  if (run('loop')) await loop();
  if (run('static')) await staticFiles();
  if (run('keepalive')) await keepalive();
} catch (err) {
  console.error('\nBench failed:', err);
  process.exitCode = 1;
}
if (!argv.includes('--no-budgets') && !process.exitCode && !opt('--server')) {
  const over = checkBudgets();
  if (over) {
    console.log(`\n${over} budget${over > 1 ? 's' : ''} exceeded`);
    process.exitCode = 1;
  }
}
console.log(`\nDone in ${Math.round((performance.now() - t0) / 1000)} s`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), node: process.version, results }, null, 2));
agent.destroy();
cleanup();
process.exit(process.exitCode || 0);
