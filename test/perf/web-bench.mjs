// Web app performance bench (speed audit, Beam 1.4.0). Measures, in headless Edge against a scratch server:
//   load       first usable screen, cold (nothing cached) and warm, with 30 and 500 items; requests and bytes
//   ui         opening, scrolling and switching conversations; typing latency; send (tap → bubble → confirmed)
//   reconnect  what a dropped event stream costs: requests, bytes, re-render work
//   hidden     what a hidden page does (browser tab and the Windows app's window): timers, wakeups, rendering
//   memory     an hour of simulated traffic (10× a busy hour): heap, DOM nodes, listeners, object URLs
// plus long tasks (> 50 ms) everywhere. Everything runs on 127.0.0.1: the server on 8821, a counting proxy on 8822
// (it sees every byte and request on the wire, and can add a round trip), Edge on 8829.
//
//   node test/perf/web-bench.mjs                      measure everything and check the budgets (about 3 minutes)
//   node test/perf/web-bench.mjs --beam <dir>         measure another copy of Beam (its server.js and public/)
//   node test/perf/web-bench.mjs --only "load|hidden" just the scenarios matching a regular expression
//   node test/perf/web-bench.mjs --rtt 50             add 50 ms of round trip between the browser and the server
//   node test/perf/web-bench.mjs --hidden-secs 120    how long to watch the hidden pages (default 90)
//   node test/perf/web-bench.mjs --idle-secs 120      how long to watch the visible idle pages (default 60)
//   node test/perf/web-bench.mjs --reps 5             time each load 5 times (default 3; the median run counts)
//   node test/perf/web-bench.mjs --json out.json      also save every number
//   node test/perf/web-bench.mjs --no-budgets         measure only
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Browser, launchBrowser, sleep } from '../web/cdp.mjs';
import { Scratch, TMP, fakeHostScript } from '../web/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const opt = (name, fallback = '') => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const BEAM = path.resolve(opt('--beam') || ROOT);
const ONLY = opt('--only') ? new RegExp(opt('--only'), 'i') : null;
const RTT = Number(opt('--rtt', '0')) || 0;
const HIDDEN_SECS = Number(opt('--hidden-secs', '90')) || 90;
const IDLE_SECS = Number(opt('--idle-secs', '60')) || 60; // how long to watch the visible idle pages
const REPS = Math.max(1, Number(opt('--reps', '3')) || 3); // each load is timed this many times; the median run counts
const JSON_OUT = opt('--json');
const CHECK_BUDGETS = !args.includes('--no-budgets');
const want = name => !ONLY || ONLY.test(name);

// ---------------------------------------------------------------- budgets (set from measured numbers, with headroom)

// Measured on loopback with the 1.4 server (plan/speed-results-web.md); timings have about 3× headroom, bytes about
// 2×, counts a margin. Each returns what's wrong, or null.
const over = (value, max, unit = '') => (value > max ? `${value}${unit} (budget ${max}${unit})` : null);
const loadRow = (s, name) => s.load.find(r => r.scenario === name);
const uiRow = (s, prefix) => s.ui.rows.find(r => r.interaction.startsWith(prefix));
const hiddenRows = (s, phase) => s.hidden.rows.filter(r => r.phase.startsWith(phase));
const memRow = (s, name) => s.memory.find(r => r.measure === name);
const BUDGETS = {
  'warm start, 500 items: history on screen': s => over(loadRow(s, '500 items, warm').content_ms, 250, ' ms'),
  'warm start, 500 items: usable': s => over(loadRow(s, '500 items, warm').usable_ms, 400, ' ms'),
  'warm start, 500 items: bytes from the server': s => over(loadRow(s, '500 items, warm').down_kb, 40, ' KB'),
  'warm start: the app comes from the cache (app files)': s => over(loadRow(s, '500 items, warm').app_kb, 2, ' KB'),
  'cold start, 500 items: bytes from the server': s => over(loadRow(s, '500 items, cold').down_kb, 400, ' KB'),
  'cold start, 500 items: the item list only once': s => over(loadRow(s, '500 items, cold').api_kb, 150, ' KB'),
  'Windows app window, warm: requests': s => over(loadRow(s, '500 items, Windows app window, warm').requests, 12),
  'Windows app window, warm: bytes': s => over(loadRow(s, '500 items, Windows app window, warm').down_kb, 30, ' KB'),
  'open a conversation (to frame)': s => over(uiRow(s, 'open a conversation').to_frame_ms, 90, ' ms'),
  'switch conversations (median, to frame)': s => over(uiRow(s, 'switch conversations').to_frame_ms, 90, ' ms'),
  'typing, 95th percentile (key to handled)': s => over(uiRow(s, 'typing, 95th').script_ms, 30, ' ms'),
  'send: the bubble is on the page after the tap': s => over(uiRow(s, 'send: tap → bubble').script_ms, 40, ' ms'),
  'long tasks during the interactions': s => over(s.ui.longTasks.length, 3),
  'reconnect: bytes to catch up': s => over(s.reconnect.down_kb, 60, ' KB'),
  'hidden and idle: timers per minute': s => over(Math.max(...hiddenRows(s, 'idle').map(r => r.timer_fires_per_min)), 1),
  'hidden and idle: stream wakeups per minute': s => over(Math.max(...hiddenRows(s, 'idle').map(r => r.stream_wakeups_per_min)), 1),
  'hidden and idle: DOM changes': s => over(Math.max(...hiddenRows(s, 'idle').map(r => r.dom_mutations)), 0),
  'hidden with traffic: DOM changes': s => over(Math.max(...hiddenRows(s, 'traffic').map(r => r.dom_mutations)), 20),
  'visible and idle: CPU per minute': s => over(Math.max(...s.idle.map(r => r.cpu_ms_per_min)), 100, ' ms'),
  'visible and idle: infinite animations running': s => over(Math.max(...s.idle.map(r => r.infinite_animations)), 0),
  'visible and idle: observer callbacks per minute (no loops)': s => over(Math.max(...s.idle.map(r => r.observer_calls)), 2),
  'memory: object URLs alive after an hour': s => over(memRow(s, 'object_urls').after, 20),
  'memory: heap growth over an hour': s => over(memRow(s, 'heap_mb').change, 2, ' MB'),
};

// ---------------------------------------------------------------- the wire: a proxy that counts (and can delay)

class WireProxy {
  constructor(port, upstream, rtt) {
    this.port = port;
    this.upstream = upstream;
    this.rtt = rtt;
    this.base = `http://127.0.0.1:${port}`;
    this.socks = new Set();
    this.reset();
  }
  reset() { this.log = []; this.streamWrites = 0; }
  start() {
    this.server = net.createServer(client => {
      const upstream = net.connect(this.upstream, '127.0.0.1');
      const conn = { queue: [], current: null };
      for (const s of [client, upstream]) {
        this.socks.add(s);
        s.setNoDelay(true);
        s.on('close', () => this.socks.delete(s));
        s.on('error', () => {});
      }
      // Half the round trip each way; chunks keep their order (equal delays fire in order).
      const later = fn => (this.rtt ? setTimeout(fn, this.rtt / 2) : fn());
      client.on('data', d => {
        const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\S+) HTTP\/1\.[01]\r\n/.exec(d.toString('latin1', 0, Math.min(d.length, 2048)));
        if (m) {
          const r = { method: m[1], path: m[2], status: 0, up: 0, down: 0, writes: 0, at: Date.now() };
          this.log.push(r);
          conn.queue.push(r);
          conn.lastSent = r;
        }
        if (conn.lastSent) conn.lastSent.up += d.length;
        later(() => { if (!upstream.destroyed) upstream.write(d); });
      });
      upstream.on('data', d => {
        const m = /^HTTP\/1\.1 (\d{3})/.exec(d.toString('latin1', 0, 16));
        let body = d;
        if (m) {
          conn.current = conn.queue.shift() || null;
          const r = conn.current;
          if (r) {
            r.status = Number(m[1]);
            // Some local HTTP filters (this PC has one) decompress responses in transit and say so in
            // X-Content-Encoding-Over-Network. Keep such bodies to count what the server really sent.
            const end = d.indexOf('\r\n\r\n');
            const head = d.toString('latin1', 0, end < 0 ? Math.min(d.length, 4096) : end);
            const over = /^x-content-encoding-over-network:\s*(\S+)/im.exec(head);
            if (over && end >= 0) {
              r.filtered = over[1].toLowerCase();
              r.chunked = /^transfer-encoding:\s*chunked/im.test(head);
              r.headBytes = end + 4;
              r.body = [];
              body = d.subarray(end + 4);
            }
          }
        }
        if (conn.current) {
          conn.current.down += d.length;
          conn.current.writes++;
          if (conn.current.body) conn.current.body.push(body);
          if (conn.current.path.startsWith('/api/events')) this.streamWrites++; // each one wakes the receiving device
        }
        later(() => { if (!client.destroyed) client.write(d); });
      });
      client.on('close', () => later(() => upstream.destroy()));
      upstream.on('close', () => later(() => client.destroy()));
    });
    return new Promise(r => this.server.listen(this.port, '127.0.0.1', () => r(this)));
  }
  dropAll() { for (const s of this.socks) s.destroy(); }
  async stop() { this.dropAll(); await new Promise(r => this.server.close(r)); }
  // Everything since the last reset (optionally filtered): requests, bytes each way, 304s, and the list. `down`
  // counts what the server sent: a body a local filter decompressed is counted compressed again.
  summary(filter = () => true) {
    const reqs = this.log.filter(filter);
    const sum = f => reqs.reduce((n, r) => n + f(r), 0);
    return {
      requests: reqs.length, up: sum(r => r.up), down: sum(sentBytes), notModified: reqs.filter(r => r.status === 304).length,
      list: reqs.map(r => `${r.method} ${r.path.replace(/\?.*$/, '')} ${r.status} ${sentBytes(r)}`),
    };
  }
}

function dechunk(buf) {
  const parts = [];
  let i = 0;
  while (i < buf.length) {
    const eol = buf.indexOf('\r\n', i);
    if (eol < 0) break;
    const size = parseInt(buf.toString('latin1', i, eol), 16);
    if (!size) break;
    parts.push(buf.subarray(eol + 2, eol + 2 + size));
    i = eol + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

// Bytes the server sent for a response: as seen, or re-compressed when a filter had decompressed it on the way.
function sentBytes(r) {
  if (!r.filtered) return r.down;
  const raw = Buffer.concat(r.body);
  const body = r.chunked ? dechunk(raw) : raw;
  const packed = r.filtered === 'br' ? zlib.brotliCompressSync(body).length : zlib.gzipSync(body).length;
  return r.headBytes + packed;
}

// ---------------------------------------------------------------- what every bench page records about itself

// Timers are counted by where they were scheduled (file:line of the caller and its caller), so "what runs while
// hidden" can be read straight off the table.
const INSTRUMENT = `(() => {
  const P = window.__perf = { marks: {}, longTasks: [], events: [], timers: {}, timerFires: 0, rafs: 0, mutations: 0, urls: new Set(), urlsMade: 0, calls: {} };
  const frameAt = (stack, i) => { const m = /([\\w.-]+\\.js):(\\d+)/.exec(stack[i] || ''); return m ? m[1] + ':' + m[2] : '?'; };
  const wrap = (orig, kind) => function (fn, ms, ...rest) {
    if (typeof fn !== 'function') return orig.call(this, fn, ms, ...rest);
    const stack = (new Error().stack || '').split('\\n');
    const where = kind + ' ' + frameAt(stack, 2) + ' < ' + frameAt(stack, 3) + ' (' + (ms | 0) + ' ms)';
    return orig.call(this, function (...a) { P.timerFires++; P.timers[where] = (P.timers[where] || 0) + 1; return fn.apply(this, a); }, ms, ...rest);
  };
  window.setTimeout = wrap(window.setTimeout, 'timeout');
  window.setInterval = wrap(window.setInterval, 'interval');
  const raf = window.requestAnimationFrame.bind(window);
  P.raf = raf;
  window.requestAnimationFrame = fn => raf(t => { P.rafs++; fn(t); });
  const make = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = o => { const u = make.call(URL, o); P.urlsMade++; P.urls.add(u); return u; };
  URL.revokeObjectURL = u => { P.urls.delete(u); return revoke.call(URL, u); };
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) P.longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true }); } catch {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) P.events.push([e.name, Math.round(e.startTime), e.duration]); }).observe({ type: 'event', durationThreshold: 16, buffered: true }); } catch {}
  new MutationObserver(ms => { P.mutations += ms.length; }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  // The page's own observers, counted by callback (a feedback loop shows up as a steady stream of them).
  P.observers = {};
  for (const name of ['IntersectionObserver', 'ResizeObserver', 'MutationObserver']) {
    const Orig = window[name];
    if (!Orig) continue;
    window[name] = class extends Orig { constructor(cb, opts) { super((...a) => { P.observers[name] = (P.observers[name] || 0) + 1; return cb(...a); }, opts); } };
  }
  // First usable screen: the conversation list and the open thread are on screen (content), and the page is
  // connected and has synced once (usable).
  const ready = () => {
    try {
      if (!P.marks.content && paired && document.querySelectorAll('#convList .conv').length > 1 && document.querySelector('#thread .msg')) P.marks.content = performance.now();
      if (P.marks.content && !P.marks.usable && net.state === 'online' && !firstSync && live.es && live.es.readyState === 1) P.marks.usable = performance.now();
    } catch {}
    if (!P.marks.usable) raf(ready);
  };
  raf(ready);
})();`;

// Counts calls of the page's big functions (installed through DevTools: the page's CSP rightly forbids eval).
const COUNT_CALLS = `(() => {
  if (__perf.counting) return true;
  __perf.counting = true;
  for (const name of ['sync', 'renderAll', 'renderThread', 'renderSidebar', 'renderHeader', 'applyDevices', 'applyItems', 'connect']) {
    const orig = window[name];
    if (typeof orig === 'function') window[name] = function (...a) { __perf.calls[name] = (__perf.calls[name] || 0) + 1; return orig.apply(this, a); };
  }
  return true;
})()`;

// Really hides a page: another tab of its browser is brought to the front. Headless Edge then treats it like any
// background tab (visibilityState "hidden", timers throttled, no frames), as WebView2 does with IsVisible = false.
async function hide(page) {
  const conn = await page.browser.browserConn();
  const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank', browserContextId: page.contextId });
  await conn.send('Target.activateTarget', { targetId });
  await page.waitFor(`document.visibilityState === 'hidden'`, 5000, 'page hidden');
  return async () => {
    await conn.send('Target.closeTarget', { targetId }).catch(() => {});
    await conn.send('Target.activateTarget', { targetId: page.targetId }).catch(() => {});
    await page.waitFor(`document.visibilityState === 'visible'`, 5000, 'page visible again');
  };
}

const RESET_COUNTERS = `(() => { const P = __perf; P.timers = {}; P.timerFires = 0; P.rafs = 0; P.mutations = 0; P.longTasks.length = 0; P.events.length = 0; P.calls = {}; return true; })()`;
const FRAME = 'new Promise(r => __perf.raf(() => __perf.raf(r)))'; // resolves once the next frame has been produced

// With --profile: a CPU profile of `fn`, printed as the functions with the most time of their own.
const PROFILE = args.includes('--profile');
async function profiled(page, label, fn) {
  if (!PROFILE) return fn();
  await page.send('Profiler.enable');
  await page.send('Profiler.setSamplingInterval', { interval: 100 });
  await page.send('Profiler.start');
  const out = await fn();
  const { profile } = await page.send('Profiler.stop');
  const self = new Map();
  const byId = new Map(profile.nodes.map(n => [n.id, n]));
  profile.samples.forEach((id, i) => {
    const f = byId.get(id).callFrame;
    const key = `${f.functionName || '(anonymous)'} ${f.url ? `${f.url.split('/').pop()}:${f.lineNumber + 1}` : ''}`.trim();
    self.set(key, (self.get(key) || 0) + (profile.timeDeltas[i] || 0) / 1000);
  });
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  const top = [...self].filter(([k]) => k !== '(idle)').sort((a, b) => b[1] - a[1]).slice(0, 18);
  console.log(`\nProfile: ${label} (${Math.round(total)} ms sampled)\n${top.map(([k, ms]) => `  ${ms.toFixed(1).padStart(8)} ms  ${k}`).join('\n')}`);
  return out;
}

async function metrics(page) {
  const { metrics: list } = await page.send('Performance.getMetrics');
  return Object.fromEntries(list.map(m => [m.name, m.value]));
}
// CPU time between two metric snapshots (a navigation that lands in a fresh renderer starts from zero).
const cpuMs = (a, b) => Math.round((b.TaskDuration >= a.TaskDuration ? b.TaskDuration - a.TaskDuration : b.TaskDuration) * 1000);
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : 0; };
const kb = n => Math.round(n / 102.4) / 10;
const r1 = n => Math.round(n * 10) / 10;

// A tiny deterministic random generator, so every run creates the same history.
function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const WORDS = 'the quick brown fox jumps over a lazy dog while beam sends notes links photos and files between phones laptops and desktops every day tickets address meeting build finished saturday harbour road recipe lemon cake https://example.com/page'.split(' ');
function sampleText(len, rand) {
  let s = '';
  while (s.length < len) s += WORDS[Math.floor(rand() * WORDS.length)] + (rand() < 0.08 ? '.\n' : ' ');
  return s.slice(0, len).trim() || 'ok';
}

// ---------------------------------------------------------------- run

const results = { beam: BEAM, rtt: RTT, at: new Date().toISOString(), scenarios: {} };
const tables = [];
function table(title, rows) {
  tables.push(title);
  const cols = Object.keys(rows[0] || {});
  const width = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c]).length)));
  const line = cells => cells.map((c, i) => String(c).padEnd(width[i])).join('  ');
  const text = [`\n${title}`, line(cols), line(width.map(w => '-'.repeat(w))), ...rows.map(r => line(cols.map(c => r[c])))].join('\n');
  console.log(text);
}

let browserProc, browser, srv, proxy, proxyApp;
const cleanups = [];

async function main() {
  const started = Date.now();
  browserProc = await launchBrowser(8829, path.join(TMP, 'browser-profile'));
  browser = new Browser(8829);
  srv = await new Scratch(path.join(BEAM, 'server.js'), 8821).start();
  proxy = await new WireProxy(8822, 8821, RTT).start();
  proxyApp = await new WireProxy(8823, 8821, RTT).start(); // the Windows app's window, counted on its own
  const base = proxy.base;
  const info = await (await fetch(`${srv.base}/api/info`, { headers: { Authorization: `Bearer ${srv.key}` } })).json();
  results.features = info.features || [];
  const newFeatures = results.features.filter(x => /^(stream-modes|items-since|gzip|live-download|big-chunks)$/.test(x));
  console.log(`Beam ${srv.hello.version} (API ${srv.hello.api}) from ${BEAM}${RTT ? `, ${RTT} ms round trip` : ''}; 1.4 features: ${newFeatures.join(', ') || 'none'}`);

  // The household: a phone (online), a laptop and a work PC, and this browser.
  const phone = srv.device('androidpixel0001', 'Pixel 9 Pro XL', 'android', '100.64.9.2', '1.3.0');
  const laptop = srv.device('windowslaptop001', 'Laptop', 'windows', '100.64.9.3', '1.3.0');
  const work = srv.device('windowsworkpc001', 'Work PC', 'windows', '100.64.9.4', '1.3.0');
  for (const d of [phone, laptop, work]) await d.me();
  cleanups.push(phone.online());

  const page = await browser.newPage({ xff: '100.64.9.10', width: 1280, height: 800, init: [INSTRUMENT] });
  const { key: pairKey } = await (await fetch(`${base}/api/pair`, { headers: { Authorization: `Bearer ${srv.key}` } })).json(); // (a link signs in only with a pairing key, 1.7.3)
  await page.goto(`${base}/?key=${encodeURIComponent(pairKey)}`);
  await page.waitFor(`typeof paired !== 'undefined' && paired && net.state === 'online'`, 15000, 'signed in');
  const [meId, meName] = await page.evaluate(`[me.id, me.name]`);
  const self = srv.device(meId, meName, 'web', '100.64.9.10');
  await page.evaluate(`store.set('beam.conv', '${phone.id}'); true`);

  // A real JPEG for photos and thumbnails.
  const jpeg = Buffer.from(await page.evaluate(`(async () => {
    const c = new OffscreenCanvas(320, 213); const g = c.getContext('2d'); const grd = g.createLinearGradient(0, 0, 320, 213);
    grd.addColorStop(0, '#6d5ef5'); grd.addColorStop(1, '#f5a25e'); g.fillStyle = grd; g.fillRect(0, 0, 320, 213);
    const a = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 })).arrayBuffer());
    let s = ''; for (const x of a) s += String.fromCharCode(x); return btoa(s);
  })()`), 'base64');

  // History: mostly short texts between the phone and this browser, some long ones (a few over the 16 KB list
  // limit), broadcasts from the laptop, photos with thumbnails, documents.
  let made = 0;
  const rand = rng(7);
  const thumbOf = async (dev, item) => {
    await fetch(`${srv.base}/api/items/${item.id}/thumb`, { method: 'PUT', headers: { ...dev.headers, 'Content-Type': 'image/jpeg' }, body: jpeg });
  };
  async function populate(total) {
    while (made < total) {
      const i = made++;
      const r = rand();
      const len = r < 0.01 ? 70000 : r < 0.03 ? 16000 : r < 0.12 ? 2000 : 30 + Math.floor(rand() * 250);
      const text = sampleText(len, rand);
      const k = rand();
      if (k < 0.07) { const it = await phone.file(`IMG_${2000 + i}.jpg`, jpeg, [meId]); if (rand() < 0.85) await thumbOf(phone, it); }
      else if (k < 0.1) await laptop.file(`Report ${i}.pdf`, Buffer.alloc(30000 + i, 7), [meId]);
      else if (k < 0.52) await phone.text(text, [meId]);
      else if (k < 0.72) await self.text(text, [phone.id]);
      else if (k < 0.82) await laptop.text(text, []);
      else if (k < 0.92) await work.text(text, [meId]);
      else await self.text(text, [laptop.id]);
    }
  }

  // ------------------------------------------------------------ load: first usable screen
  async function load(label, { cold, target = page, wire = proxy, conv = phone.id }) {
    await target.goto(`${wire.base}/icon.svg`); // same origin, so the renderer (and its counters) stays the same
    await target.evaluate(`localStorage.setItem('beam.conv', '${conv}'); true`); // the conversation it opens on
    if (cold) {
      await target.send('Network.clearBrowserCache');
      await target.send('Storage.clearDataForOrigin', { origin: wire.base, storageTypes: 'indexeddb,cache_storage,service_workers' });
    }
    await sleep(400);
    wire.reset();
    const m0 = await metrics(target);
    await target.send('Page.navigate', { url: `${wire.base}/` });
    await target.waitFor(`(window.__perf && __perf.marks.usable > 0) || JSON.stringify((() => { try { return { marks: __perf.marks, paired, net: net.state, firstSync, es: live.es && live.es.readyState, rows: document.querySelectorAll('#convList .conv').length, msgs: document.querySelectorAll('#thread .msg').length, host: typeof hostState !== 'undefined' && hostState.ready }; } catch (e) { return String(e); } })())`, 30000, `${label}: usable`);
    const m1 = await metrics(target);
    await sleep(700); // what follows right after (thumbnails, read markers) still belongs to opening
    const p = await target.evaluate(`({ marks: __perf.marks, longTasks: __perf.longTasks, msgs: document.querySelectorAll('#thread .msg').length, conv: current })`);
    const not = r => !/\/icon\.svg/.test(r.path);
    const w = wire.summary(not);
    const part = re => kb(wire.summary(r => not(r) && re.test(r.path)).down);
    const lt = p.longTasks.filter(([s]) => s <= p.marks.usable + 700);
    return {
      scenario: label, content_ms: Math.round(p.marks.content), usable_ms: Math.round(p.marks.usable), requests: w.requests, '304s': w.notModified,
      down_kb: kb(w.down), app_kb: part(/^\/(?!api\/)/), api_kb: part(/^\/api\/(?!file|items\/\w+\/thumb|events)/), media_kb: part(/^\/api\/(file|items\/\w+\/thumb)/),
      cpu_ms: cpuMs(m0, m1), long_tasks: lt.length, longest_ms: Math.max(0, ...lt.map(([, d]) => d)),
      shows: `${p.conv === 'all' ? 'All devices' : p.conv === phone.id ? 'phone' : p.conv} (${p.msgs})`, _requests: w.list,
    };
  }

  // The median run (by time to usable) of REPS.
  async function loadMedian(label, options) {
    const runs = [];
    for (let i = 0; i < REPS; i++) runs.push(await load(label, options));
    runs.sort((a, b) => a.usable_ms - b.usable_ms);
    const mid = runs[Math.floor((runs.length - 1) / 2)];
    return { ...mid, spread_ms: `${runs[0].usable_ms}–${runs.at(-1).usable_ms}` };
  }

  const loadRows = [];
  if (want('load')) {
    await populate(30);
    await sleep(500);
    loadRows.push(await loadMedian('30 items, cold', { cold: true }));
    loadRows.push(await loadMedian('30 items, warm', { cold: false }));
  }
  await populate(500);
  await sleep(500);
  if (want('load')) {
    loadRows.push(await loadMedian('500 items, cold', { cold: true }));
    loadRows.push(await loadMedian('500 items, warm', { cold: false }));
  }
  // The Windows app's window: same page, host mode, signed in with the app's cookie.
  const app = await (await fetch(`${srv.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: srv.key, client: 'app', deviceId: 'windowsthispc001' }) })).json();
  const host = await browser.newPage({ xff: '100.64.9.11', width: 1100, height: 760, init: [fakeHostScript({ deviceId: 'windowsthispc001', deviceName: 'This PC', server: proxyApp.base }), INSTRUMENT] });
  await host.send('Network.setCookie', { name: 'beam_key', value: app.key, url: proxyApp.base, httpOnly: true, sameSite: 'Lax' });
  await host.goto(`${proxyApp.base}/`);
  await host.waitFor(`typeof paired !== 'undefined' && paired && hostState.ready && net.state === 'online' && !firstSync`, 20000, 'host page ready');
  // This PC's own history is the laptop's broadcasts (All devices).
  await host.evaluate(`store.set('beam.conv', 'all'); openConv('all'); true`);
  if (want('load')) {
    loadRows.push(await loadMedian('500 items, Windows app window, warm', { cold: false, target: host, wire: proxyApp, conv: 'all' }));
    table('First usable screen (content = list and thread on screen; usable = connected and synced)', loadRows.map(({ _requests, ...r }) => r));
    for (const r of loadRows.filter(x => /cold|warm$/.test(x.scenario))) {
      const top = r._requests.map(s => s.split(' ')).sort((a, b) => b[3] - a[3]).slice(0, 8).map(([m, p, s, d]) => `${p} ${s} ${kb(d)} KB`);
      console.log(`  ${r.scenario}, largest: ${top.join(', ')}`);
    }
    results.scenarios.load = loadRows;
  }

  // Back to the browser page with 500 items, warm, on the phone's conversation.
  await page.goto(`${base}/`);
  await page.waitFor(`window.__perf && __perf.marks.usable > 0`, 30000, 'page ready');
  await page.evaluate(`openConv('${phone.id}'); true`);
  await page.evaluate(COUNT_CALLS);
  await host.waitFor(`window.__perf && __perf.marks.usable > 0`, 30000, 'app window ready');
  await host.evaluate(COUNT_CALLS);
  await sleep(500);

  // ------------------------------------------------------------ idle: a visible window where nothing happens
  // The Windows chat window left open on screen: a conversation open, the message box focused, no traffic.
  if (want('idle')) {
    const rows = [];
    const watched = [['browser tab', page, `openConv('${phone.id}')`], ['Windows app window', host, `openConv('all')`]];
    for (const [, p, open] of watched) await p.evaluate(`${open}; $('#text').focus(); true`);
    // Pages the scenarios before closed can leave streams the server hasn't noticed are gone yet (a filter between
    // browser and proxy may hold them until the next ping), and each one it notices sends the device list out again.
    // So: drop every connection, let the watched pages reconnect, then settle before measuring.
    proxy.dropAll();
    proxyApp.dropAll();
    await sleep(1000);
    for (const [label, p] of watched) await p.waitFor(`live.es?.readyState === 1 && net.state === 'online' && !syncing && !firstSync`, 15000, `${label}: back online`);
    // First let the browser finish acknowledging the history it was away for (a one-off catch-up, not idle). The
    // Windows app window sends none: the app does.
    for (const [label, p] of watched) await p.waitFor(`acksInFlight === 0 && (HOST || itemsIn(current).every(i => !isForMe(i) || i.delivered[me.id] || acked.has(i.id)))`, 60000, `${label}: receipts sent`);
    await sleep(5000);
    for (const [, p] of watched) await p.evaluate(`${RESET_COUNTERS}; __perf.observers = {}; true`);
    const m0 = await Promise.all(watched.map(([, p]) => metrics(p)));
    await sleep(IDLE_SECS * 1000);
    for (const [i, [label, p]] of watched.entries()) {
      const m1 = await metrics(p);
      const s = await p.evaluate(`({ fires: __perf.timerFires, timers: { ...__perf.timers }, rafs: __perf.rafs, observers: { ...__perf.observers },
        anims: document.getAnimations().filter(a => a.playState === 'running').map(a => {
          const t = a.effect?.target; const timing = a.effect?.getComputedTiming?.() || {};
          return (a.animationName || a.transitionProperty || a.constructor.name) + (timing.iterations === Infinity ? ' (infinite)' : '') + ' on ' + (t ? (t.id ? '#' + t.id : t.tagName?.toLowerCase() + (t.className && typeof t.className === 'string' ? '.' + t.className.trim().replace(/\\s+/g, '.') : '')) : '?') + (a.effect?.pseudoElement || '');
        }) })`);
      const perMin = x => r1(x * 60 / IDLE_SECS);
      rows.push({
        page: label, cpu_ms_per_min: perMin(cpuMs(m0[i], m1)), script_ms: perMin((m1.ScriptDuration - m0[i].ScriptDuration) * 1000),
        layout_ms: perMin((m1.LayoutDuration - m0[i].LayoutDuration) * 1000), style_ms: perMin((m1.RecalcStyleDuration - m0[i].RecalcStyleDuration) * 1000),
        layouts: perMin(m1.LayoutCount - m0[i].LayoutCount), style_recalcs: perMin(m1.RecalcStyleCount - m0[i].RecalcStyleCount),
        timer_fires: perMin(s.fires), rafs: perMin(s.rafs), observer_calls: perMin(Object.values(s.observers).reduce((a, b) => a + b, 0)),
        running_animations: s.anims.length, infinite_animations: s.anims.filter(x => x.includes('(infinite)')).length,
        _detail: s,
      });
    }
    table(`Visible and idle, per minute (${IDLE_SECS} s; a conversation open, the message box focused, no traffic)`, rows.map(({ _detail, ...r }) => r));
    for (const r of rows) {
      const d = r._detail;
      console.log(`  ${r.page}: timers ${Object.entries(d.timers).map(([k, v]) => `${k} ×${v}`).join('; ') || 'none'}; observers ${JSON.stringify(d.observers)}; animations ${d.anims.join(', ') || 'none'}`);
    }
    results.scenarios.idle = rows;
  }

  // ------------------------------------------------------------ ui: interactions with 500 items
  if (want('ui')) {
    const rows = [];
    await page.evaluate(RESET_COUNTERS);
    const open = await profiled(page, 'open a conversation, 7 times', () => page.evaluate(`(async () => {
      const out = [];
      for (let i = 0; i < 7; i++) {
        openConv('${laptop.id}'); await ${FRAME};
        const t0 = performance.now(); openConv('${phone.id}'); const t1 = performance.now(); await ${FRAME};
        out.push([t1 - t0, performance.now() - t0]);
      }
      return out;
    })()`));
    rows.push({ interaction: `open a conversation (${await page.evaluate(`itemsIn('${phone.id}').length`)} items)`, script_ms: r1(median(open.map(x => x[0]))), to_frame_ms: r1(median(open.map(x => x[1]))), worst_ms: r1(Math.max(...open.map(x => x[1]))) });
    const convs = [phone.id, laptop.id, work.id, 'all'];
    const sw = await page.evaluate(`(async () => {
      const convs = ${JSON.stringify(convs)}; const out = [];
      for (let i = 0; i < 24; i++) { const t0 = performance.now(); openConv(convs[i % 4]); const t1 = performance.now(); await ${FRAME}; out.push([t1 - t0, performance.now() - t0]); }
      return out;
    })()`);
    rows.push({ interaction: 'switch conversations (24 switches)', script_ms: r1(median(sw.map(x => x[0]))), to_frame_ms: r1(median(sw.map(x => x[1]))), worst_ms: r1(Math.max(...sw.map(x => x[1]))) });
    const scroll = await page.evaluate(`(async () => {
      openConv('${phone.id}'); await ${FRAME};
      const box = $('#thread'); const frames = []; const t0 = performance.now(); let last = t0;
      while ((box.scrollTop > 0 || view.start > 0) && frames.length < 600) {
        box.scrollTop -= 500;
        await new Promise(r => __perf.raf(r));
        const now = performance.now(); frames.push(now - last); last = now;
      }
      return { ms: performance.now() - t0, frames, start: view.start, rendered: document.querySelectorAll('#thread .msg').length };
    })()`);
    rows.push({ interaction: `scroll to the top (${scroll.rendered} messages rendered)`, script_ms: '', to_frame_ms: r1(median(scroll.frames)), worst_ms: r1(Math.max(...scroll.frames)) });
    // Typing: keys through the browser's input pipeline; latency = key event → the page handled it / next frame.
    await page.evaluate(`(() => {
      openConv('${phone.id}'); $('#text').focus(); window.__keys = [];
      addEventListener('keydown', e => { __keys.push({ ts: e.timeStamp }); }, true);
      $('#text').addEventListener('input', () => { const k = __keys[__keys.length - 1]; if (k && k.handled === undefined) { k.handled = performance.now() - k.ts; __perf.raf(() => __perf.raf(() => { k.frame = performance.now() - k.ts; })); } });
      return true;
    })()`);
    await profiled(page, 'typing 54 keys', async () => {
      for (const ch of 'The quick brown fox jumps over the lazy dog 0123456789') {
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
        await sleep(30);
      }
    });
    await sleep(200);
    const keys = (await page.evaluate(`__keys`)).filter(k => k.handled !== undefined);
    rows.push({ interaction: `typing (${keys.length} keys), median`, script_ms: r1(median(keys.map(k => k.handled))), to_frame_ms: r1(median(keys.map(k => k.frame || 0))), worst_ms: r1(Math.max(...keys.map(k => k.frame || 0))) });
    rows.push({ interaction: `typing, 95th percentile`, script_ms: r1(pct(keys.map(k => k.handled), 0.95)), to_frame_ms: r1(pct(keys.map(k => k.frame || 0), 0.95)), worst_ms: '' });
    await page.evaluate(`$('#text').value = ''; $('#text').dispatchEvent(new Event('input', { bubbles: true })); true`);
    const send = await page.evaluate(`(async () => {
      const box = $('#thread'); const out = [];
      for (let i = 0; i < 10; i++) {
        const text = 'bench send ' + i + ' ' + Math.random().toString(36).slice(2);
        $('#text').value = text; $('#text').dispatchEvent(new Event('input', { bubbles: true }));
        let shown = 0, painted = 0;
        const mo = new MutationObserver(() => {
          if (!shown && [...box.querySelectorAll('.msg')].slice(-5).some(m => m.textContent.includes(text))) { shown = performance.now(); __perf.raf(() => __perf.raf(() => { painted = performance.now(); })); }
        });
        mo.observe(box, { childList: true, subtree: true, characterData: true });
        const t0 = performance.now();
        $('#sendBtn').click();
        let confirmed = 0;
        const end = t0 + 8000;
        while ((!painted || !confirmed) && performance.now() < end) {
          if (!confirmed && items.some(it => it.text === text && !String(it.id).startsWith('out'))) confirmed = performance.now();
          await new Promise(r => setTimeout(r, 2));
        }
        mo.disconnect();
        out.push([shown - t0, painted - t0, confirmed - t0]);
        await new Promise(r => setTimeout(r, 120));
      }
      return out;
    })()`);
    rows.push({ interaction: 'send: tap → bubble on screen (median of 10)', script_ms: r1(median(send.map(x => x[0]))), to_frame_ms: r1(median(send.map(x => x[1]))), worst_ms: r1(Math.max(...send.map(x => x[1]))) });
    rows.push({ interaction: 'send: tap → confirmed by the server', script_ms: '', to_frame_ms: r1(median(send.map(x => x[2]))), worst_ms: r1(Math.max(...send.map(x => x[2]))) });
    const lt = await page.evaluate(`__perf.longTasks`);
    table(`Interactions, 500 items (long tasks during these: ${lt.length}, longest ${Math.max(0, ...lt.map(([, d]) => d))} ms)`, rows);
    results.scenarios.ui = { rows, longTasks: lt, scrollFrames: scroll.frames.length };
  }

  // ------------------------------------------------------------ reconnect: the event stream drops
  if (want('reconnect')) {
    await page.evaluate(`openConv('${phone.id}'); ${RESET_COUNTERS}`);
    await sleep(300);
    proxy.reset();
    const m0 = await metrics(page);
    const t0 = Date.now();
    proxy.dropAll();
    await page.waitFor(`!live.es || live.es.readyState !== 1 || net.state !== 'online'`, 10000, 'drop noticed');
    await page.waitFor(`live.es && live.es.readyState === 1 && net.state === 'online' && !syncing && (__perf.calls.sync || 0) > 0`, 30000, 'back and synced');
    const backMs = Date.now() - t0;
    await sleep(800);
    const m1 = await metrics(page);
    const p = await page.evaluate(`({ mutations: __perf.mutations, calls: __perf.calls, longTasks: __perf.longTasks })`);
    const wire = proxy.summary();
    const row = {
      after_drop: 'reconnect + catch-up (500 items)', back_ms: backMs, requests: wire.requests, down_kb: kb(wire.down), up_kb: kb(wire.up), cpu_ms: cpuMs(m0, m1),
      dom_mutations: p.mutations, renders: `${p.calls.renderThread || 0} thread / ${p.calls.renderSidebar || 0} list`, long_tasks: p.longTasks.length,
    };
    table('Reconnect after the event stream drops', [row]);
    console.log(`  requests: ${wire.list.join(' | ')}`);
    results.scenarios.reconnect = { ...row, requests_list: wire.list };
  }

  // ------------------------------------------------------------ hidden: a background tab and the app's hidden window
  if (want('hidden')) {
    const rows = [];
    const watched = [['browser tab', page, proxy], ['Windows app window', host, proxyApp]];
    const shows = [];
    for (const [, p] of watched) shows.push(await hide(p));
    await sleep(1500);
    // What each page does, and what reaches it: timers that fired (by where they were set), event-stream writes
    // (each one wakes the device), requests, DOM changes, render calls, CPU.
    const watch = async secs => {
      for (const [, p, w] of watched) { await p.evaluate(RESET_COUNTERS); w.reset(); w.streamWrites = 0; }
      const m0 = await Promise.all(watched.map(([, p]) => metrics(p)));
      return async () => Promise.all(watched.map(async ([label, p, w], i) => {
        const m = await metrics(p);
        const s = await p.evaluate(`({ timers: { ...__perf.timers }, fires: __perf.timerFires, rafs: __perf.rafs, mutations: __perf.mutations, calls: { ...__perf.calls }, anims: document.getAnimations().filter(a => a.playState === 'running').length })`);
        const requests = w.log.filter(r => !r.path.startsWith('/api/events')).map(r => `${r.method} ${r.path.replace(/\?.*$/, '')}`);
        return { label, s, cpu: cpuMs(m0[i], m), writes: w.streamWrites, requests, secs };
      }));
    };
    const idleSecs = Math.round(HIDDEN_SECS * 2 / 3);
    let done = await watch(idleSecs);
    await sleep(idleSecs * 1000);
    const idle = await done();
    const busySecs = HIDDEN_SECS - idleSecs;
    done = await watch(busySecs);
    const t0 = Date.now();
    let n = 0;
    while (Date.now() - t0 < busySecs * 1000) {
      const dev = [laptop, work][n % 2];
      await dev.putStatus({ battery: { level: 40 + (n % 50), charging: n % 3 === 0 }, storage: { free: (100 + n) * 1e9, total: 512e9 } });
      if (n % 3 === 0) await phone.text(`background message ${n}`, [meId, 'windowsthispc001']);
      n++;
      await sleep(2000);
    }
    const busy = await done();
    const perMin = (x, secs) => r1(x * 60 / secs);
    for (const [phase, list] of [[`idle ${idleSecs} s`, idle], [`traffic ${busySecs} s`, busy]]) {
      for (const x of list) {
        rows.push({
          page: x.label, phase, timer_fires_per_min: perMin(x.s.fires, x.secs), stream_wakeups_per_min: perMin(x.writes, x.secs), requests: x.requests.length,
          dom_mutations: x.s.mutations, render_calls: (x.s.calls.renderThread || 0) + (x.s.calls.renderSidebar || 0) + (x.s.calls.renderHeader || 0),
          rafs: x.s.rafs, running_animations: x.s.anims, cpu_ms_per_min: perMin(x.cpu, x.secs),
        });
      }
    }
    table(`Hidden pages, per minute (idle = no traffic at all; traffic = ${n} status reports and ${Math.ceil(n / 3)} messages)`, rows);
    for (const [phase, list] of [['idle', idle], ['traffic', busy]]) {
      for (const x of list) {
        console.log(`  ${x.label}, ${phase}: timers ${Object.entries(x.s.timers).map(([k, v]) => `${k} ×${v}`).join('; ') || 'none'}${x.requests.length ? `; requests ${x.requests.join(', ')}` : ''}`);
      }
    }
    results.scenarios.hidden = { rows, idle: idle.map(x => ({ label: x.label, timers: x.s.timers, requests: x.requests })), busy: busy.map(x => ({ label: x.label, timers: x.s.timers, requests: x.requests })) };
    for (const show of shows) await show();
    await sleep(500);
  }

  // ------------------------------------------------------------ memory: an hour of traffic, ten times over
  if (want('memory')) {
    await page.evaluate(`openConv('${phone.id}'); true`);
    await sleep(500);
    const snapshot = async () => {
      await page.evaluate(`openConv('${laptop.id}'); openConv('${phone.id}'); true`); // the same view each time
      await sleep(300);
      await page.send('HeapProfiler.collectGarbage');
      await sleep(200);
      const m = await metrics(page);
      const p = await page.evaluate(`({ urls: __perf.urls.size, items: items.length, viewNodes: view.nodes.size, previews: localPreviews.size, changedAt: changedAt.size, acked: acked.size, knownNames: Object.keys(knownNames).length })`);
      return { heap_mb: r1(m.JSHeapUsedSize / 1048576), dom_nodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents, object_urls: p.urls, items: p.items, rendered: p.viewNodes, local_previews: p.previews, changedAt: p.changedAt, acked: p.acked };
    };
    const before = await snapshot();
    const t0 = Date.now();
    const photo = jpeg.toString('base64');
    let sentIds = [];
    for (let minute = 0; minute < 60; minute++) {
      for (let k = 0; k < 10; k++) {
        const from = [phone, laptop, work][k % 3];
        await from.text(`minute ${minute}, message ${k}: ${sampleText(80, rand)}`, k % 3 === 1 ? [] : [meId]);
      }
      const mine = await page.evaluate(`Promise.all([sendText('reply ${minute} a', '${phone.id}'), sendText('reply ${minute} b', '${laptop.id}')]).then(r => r.map(x => x && x.id))`);
      sentIds.push(...mine.filter(Boolean));
      for (const id of sentIds.splice(0, 3)) await phone.ack(id);
      await [laptop, work][minute % 2].putStatus({ battery: { level: 30 + minute, charging: minute % 2 === 0 } });
      if (minute % 5 === 0) {
        const it = await phone.file(`Photo ${minute}.jpg`, jpeg, [meId]);
        await thumbOf(phone, it);
        await page.evaluate(`(async () => { const b = Uint8Array.from(atob('${photo}'), c => c.charCodeAt(0)); sendFiles([new File([b], 'Sent ${minute}.jpg', { type: 'image/jpeg' })], '${phone.id}'); return true; })()`);
      }
      if (minute % 2 === 0) {
        const old = await page.evaluate(`items.find(i => i.from === '${phone.id}' && !i.pinned)?.id || ''`);
        if (old) await phone.del(`/api/items/${old}`);
      }
      if (minute % 10 === 9) proxy.dropAll();
      if (minute % 6 === 3) await page.evaluate(`(async () => { const it = [...items].reverse().find(i => /^image\\//.test(i.mime || '')); if (it) { openLightbox(it); await new Promise(r => setTimeout(r, 150)); $('#lightbox').close(); } return true; })()`);
      await page.evaluate(`openConv(['${phone.id}', '${laptop.id}', '${work.id}', 'all'][${minute} % 4]); true`);
      await sleep(250);
    }
    await page.waitFor(`net.state === 'online' && live.es?.readyState === 1 && !uploads.size`, 30000, 'traffic done');
    await sleep(1500);
    const after = await snapshot();
    const rows = Object.keys(before).map(k => ({ measure: k, before: before[k], after: after[k], change: typeof before[k] === 'number' ? r1(after[k] - before[k]) : '' }));
    table(`Memory after a simulated hour (${Math.round((Date.now() - t0) / 1000)} s: 600 received and 120 sent texts, 12 photos each way, 60 status reports, 30 deletes, 6 reconnects, 60 switches)`, rows);
    results.scenarios.memory = rows;
  }

  // ------------------------------------------------------------ budgets
  // The budgets describe Beam 1.4: this page against a server with the 1.4 protocol, on loopback.
  const failures = [];
  const budgeted = CHECK_BUDGETS && !RTT && results.features.includes('stream-modes') && results.features.includes('items-since');
  let checked = 0;
  if (budgeted) {
    for (const [name, check] of Object.entries(BUDGETS)) {
      let problem;
      try { problem = check(results.scenarios); } catch { continue; } // that scenario wasn't run (--only)
      checked++;
      if (problem) failures.push(`${name}: ${problem}`);
    }
  }
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
  const verdict = failures.length ? `BUDGETS EXCEEDED:\n  ${failures.join('\n  ')}`
    : budgeted ? `All ${checked} budgets met.` : 'No budgets checked (they need a server with the 1.4 protocol, no --rtt and no --no-budgets).';
  console.log(`\n${verdict} (${Math.round((Date.now() - started) / 1000)} s)`);
  return failures.length ? 1 : 0;
}

async function shutdown() {
  for (const fn of cleanups) { try { fn(); } catch {} }
  try { await proxy?.stop(); } catch {}
  try { await proxyApp?.stop(); } catch {}
  try { await srv?.stop(); } catch {}
  try { browser?.close(); await browserProc?.stop(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch {}
}

main().then(async code => { await shutdown(); process.exit(code); }, async err => { console.error(err); await shutdown(); process.exit(2); });
