// Downloads in the app (1.11.0; the user: "do fast downloads"): a file of 8 MB and more comes over the direct
// connection, as a fast link's does (14–28 MB/s seen where the public link carries ~2 MB/s), into the browser's
// downloads through the service worker (no save dialog in the app), one at a time, in a small panel with how far each
// got, how fast, and Stop. The browser's own download instead for a smaller file, on an iPhone or iPad (Safari's own:
// the service worker's stream broke files there), or when no direct connection comes up (then from the start).
// (1.15.1) A connection that drops goes on from where it got to (a new direct connection, else https from that byte);
// it used to start over in the browser's own download.
import { h, fill, formatSize, iconBtn } from './ui.js';
import { DIRECT_MIN, directAvailable, directConnection } from './direct.js';
import { IOS, openSink, plainSave, receiveResuming, took } from './saving.js';

const jobs = [];   // this round's downloads, shown in the panel until a while after the last one ends
let running = null;
let panel = null;
let hideTimer = null;
let lock = null;
const LIVE = new Set(['waiting', 'connecting', 'going', 'resuming']);

// One file (an attachment's JSON: id, name, size, mime, url); `href`: the browser's own download of it instead.
export function downloadFile(f, href = `${f.url}?download`) {
  if (IOS || f.size < DIRECT_MIN || !directAvailable()) return plainSave(href, f.name);
  if (jobs.some(j => j.f.id === f.id && LIVE.has(j.state))) return;
  jobs.push({ f, href, state: 'waiting', got: 0, rate: 0, note: '', stop: null });
  render();
  pump();
}

export function downloadFiles(files) {
  for (const f of files) if (f.url) downloadFile(f);
}

async function pump() {
  if (running) return;
  for (let job; (job = jobs.find(j => j.state === 'waiting'));) {
    running = job;
    await run(job);
    running = null;
  }
  awake(false);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { if (!running) { jobs.length = 0; render(); } }, 8000);
}

async function run(job) {
  const stop = new AbortController();
  job.stop = () => stop.abort();
  job.state = 'connecting';
  render();
  awake(true);
  let sink = null;
  try {
    const conn = await directConnection();
    if (!conn) throw Object.assign(new Error('no direct connection'), { plain: true });
    if (stop.signal.aborted) throw new Error('stopped');
    sink = await openSink(job.f.name, job.f.size, job.f.mime, { dialog: false });
    if (!sink || sink === 'cancelled') throw Object.assign(new Error('this browser can’t save it that way'), { plain: true });
    job.state = 'going';
    render();
    const r = await receiveResuming({
      pc: conn.pc,
      connect: async () => (await directConnection())?.pc || null,
      label: offset => ({ op: 'get', file: job.f.id, offset }),
      url: job.f.url,
      size: job.f.size,
      sink,
      signal: stop.signal,
      onProgress: (got, rate) => { job.state = 'going'; job.got = got; job.rate = rate; render(); },
      onResume: got => { job.state = 'resuming'; job.got = got; render(); },
    });
    job.state = 'done';
    job.got = r.got;
    job.note = `${took(r.seconds)} · ${formatSize(r.got / Math.max(r.seconds, 0.1))}/s`;
  } catch (err) {
    if (sink && typeof sink === 'object') sink.abort();
    if (stop.signal.aborted || err.message === 'stopped') job.state = 'stopped';
    else if (err.message === 'cancelled') job.state = 'cancelled';
    else {
      // (the browser's own download, from the start)
      job.state = 'plain';
      job.note = err.plain ? 'no direct connection' : err.message;
      plainSave(job.href, job.f.name);
    }
  }
  render();
}

// The screen stays on while a download comes over the direct connection (a phone that locks pauses the page).
async function awake(on) {
  if (!on) { lock?.release().catch(() => {}); lock = null; return; }
  if (lock && !lock.released) return;
  try { lock = (await navigator.wakeLock?.request('screen')) || null; } catch { lock = null; }
}
document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible') awake(true); });

const STATUS = {
  waiting: () => 'Waiting',
  connecting: () => 'Connecting straight to the server…',
  going: j => `${formatSize(j.got)} of ${formatSize(j.f.size)} · ${formatSize(j.rate)}/s`,
  resuming: j => `The connection dropped: going on from ${formatSize(j.got)}…`,
  done: j => `Done in ${j.note}: it’s in your downloads`,
  stopped: () => 'Stopped',
  cancelled: () => 'Cancelled in your downloads',
  plain: j => `Downloading the usual way (${j.note}): see your downloads`,
};

function render() {
  if (!jobs.length) { panel?.remove(); panel = null; return; }
  if (!panel) {
    panel = h('div', { class: 'downloads', role: 'status', 'aria-live': 'polite', 'aria-label': 'Downloads' });
    document.body.append(panel);
  }
  if (running) clearTimeout(hideTimer);
  fill(panel, ...jobs.map(j => {
    const live = LIVE.has(j.state);
    return h('div', { class: `dl-row ${j.state}` },
      h('div', { class: 'dl-text' }, h('strong', { class: 'dl-name' }, j.f.name), h('span', { class: 'dl-status' }, STATUS[j.state](j))),
      live ? iconBtn('x', `Stop downloading ${j.f.name}`, () => {
        if (j.state === 'waiting') { j.state = 'stopped'; render(); } else j.stop?.();
      }) : null,
      h('span', { class: 'dl-track' }, h('span', { class: 'dl-fill', style: { width: `${j.state === 'done' ? 100 : Math.round((j.got / Math.max(j.f.size, 1)) * 100)}%` } })));
  }));
}
