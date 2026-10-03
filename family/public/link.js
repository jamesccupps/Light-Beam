// A fast link's page (Beam Family 1.9.0): the file, who shared it, and two ways to get it, no sign-in (the link's
// secret is the key).
// - Download: straight from the sharing machine when a direct connection comes up (WebRTC; on the same network it
//   stays inside it), written to a file as it comes (a save dialog on a computer; on a phone the browser's downloads,
//   through this site's service worker); this page stays open meanwhile (1.9.1: with the screen kept on, and a Stop
//   button). Without one: over https.
// - Download in the background: https, for the phone's own download manager (it goes on with the screen locked;
//   through the public link it's slower).
// One download at a time here (1.9.1: two at once made two copies); a second one is asked about first.
// A file still being uploaded at the other end is followed as it arrives.
import { h, fill, formatSize, confirmDialog } from './ui.js';

const token = location.pathname.split('/')[2] || '';
const card = document.getElementById('card');
const fileUrl = `/api/links/${token}/file`;
let info = null;
let running = null;   // the direct download going on: { stop() }
let already = '';     // 'background' once the browser's downloads have it, 'done' once a direct download finished

function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 4000);
}

async function load() {
  let res;
  try { res = await fetch(`/api/links/${token}`, { cache: 'no-store' }); } catch { return problem('Can’t reach it right now. Check the connection and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return problem(data.error || 'This link doesn’t work any more.');
  info = data;
  render();
  if (info.received < info.size && !running) setTimeout(refresh, 3000);
}

async function refresh() {
  if (running) return;
  try {
    const res = await fetch(`/api/links/${token}`, { cache: 'no-store' });
    if (!res.ok) return load();
    info = await res.json();
    const arriving = card.querySelector('.arriving');
    if (arriving) arriving.textContent = arrivingText();
    if (info.received < info.size) setTimeout(refresh, 3000);
  } catch { setTimeout(refresh, 10000); }
}

const arrivingText = () => (info.received < info.size ? `Still arriving at the other end: ${formatSize(info.received)} of ${formatSize(info.size)} so far. It can be downloaded already: it follows as it comes.` : '');

function problem(text) {
  fill(card, h('h1', {}, 'This link doesn’t work'), h('p', { class: 'muted' }, text));
}

function render() {
  const expires = new Date(info.expires).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  fill(card,
    info.preview ? h('img', { class: 'link-preview', src: `/api/links/${token}/preview`, alt: '' }) : null,
    h('h1', { class: 'link-name' }, info.name),
    h('p', { class: 'muted' }, `${formatSize(info.size)} · from ${info.from} · until ${expires}`),
    h('p', { class: 'muted small arriving' }, arrivingText()),
    h('div', { class: 'link-actions' },
      h('button', { class: 'btn primary', type: 'button', id: 'get', onclick: onDownload }, 'Download'),
      h('button', { class: 'btn', type: 'button', id: 'background', onclick: onBackground }, 'Download in the background')),
    h('div', { class: 'link-progress', hidden: true }, h('span', { class: 'track' }, h('span', { class: 'fill' })), h('p', { class: 'small status' })),
    h('p', { class: 'muted small' }, 'Download goes straight to the sender’s computer when it can: fast, and the screen stays on until it’s done (keep this page open). Download in the background uses your browser’s own downloads, which carry on with the screen locked, but through the public link it can be much slower.'));
}

// While a direct download runs: Download becomes Stop, and the other button waits.
function buttons(downloading) {
  const get = card.querySelector('#get');
  const background = card.querySelector('#background');
  if (!get || !background) return;
  get.textContent = downloading ? 'Stop' : 'Download';
  get.classList.toggle('primary', !downloading);
  background.disabled = downloading;
}

// A second download of the same file is asked about first (it would be a second copy).
const again = () => confirmDialog({
  title: 'Download it again?',
  text: already === 'done' ? 'It’s already downloaded: see your downloads.' : 'It’s already downloading in your browser’s downloads (on a phone: pull down the notifications, or Chrome’s ⋮ menu → Downloads).',
  ok: 'Download again',
});

async function onDownload() {
  if (running) return running.stop();
  if (already && !(await again())) return;
  fastDownload();
}

async function onBackground() {
  if (running) return;
  if (already && !(await again())) return;
  plainDownload();
}

// The screen stays on while a download comes straight from the sender (a phone that locks pauses this page).
const awake = {
  lock: null,
  async on() {
    let lock = null;
    try { lock = (await navigator.wakeLock?.request('screen')) || null; } catch {}
    // (a download that ended meanwhile lets go of it at once)
    if (running) this.lock = lock; else lock?.release().catch(() => {});
  },
  off() {
    this.lock?.release().catch(() => {});
    this.lock = null;
  },
};
document.addEventListener('visibilitychange', () => {
  if (running && document.visibilityState === 'visible' && (!awake.lock || awake.lock.released)) awake.on();
});

function setStatus(text, fraction = null) {
  const box = card.querySelector('.link-progress');
  if (!box) return;
  box.hidden = false;
  box.querySelector('.status').textContent = text;
  const fillEl = box.querySelector('.fill');
  fillEl.style.width = fraction === null ? '0' : `${Math.round(fraction * 100)}%`;
  box.querySelector('.track').hidden = fraction === null;
}

function plainDownload(note = '') {
  const a = h('a', { href: fileUrl, download: info.name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  already = 'background';
  setStatus(`${note}Your browser is downloading it: see its downloads (on a phone: pull down the notifications, or Chrome’s ⋮ menu → Downloads). It carries on with the screen locked.`);
}

// ---------------------------------------------------------------- where the bytes go

// A file on a computer (a save dialog), the browser's downloads through the service worker (a phone), or memory for
// a small file; null: none of those (the https download it is).
async function openSink() {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: info.name });
      const w = await handle.createWritable();
      return { kind: 'file', write: b => w.write(b), close: () => w.close(), abort: () => w.abort().catch(() => {}) };
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
    }
  }
  const sw = await workerSink();
  if (sw) return sw;
  if (info.size <= 200 * 1024 * 1024) {
    const parts = [];
    return {
      kind: 'memory', write: b => { parts.push(b); },
      close: () => {
        const url = URL.createObjectURL(new Blob(parts, { type: info.mime || 'application/octet-stream' }));
        const a = h('a', { href: url, download: info.name, hidden: true });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60e3);
      },
      abort: () => { parts.length = 0; },
    };
  }
  return null;
}

// The service worker answers a download of /f/save/<id> with a stream this page fills (how a phone's browser writes a
// file that arrives in pieces); null if there's no service worker here.
async function workerSink() {
  if (!navigator.serviceWorker || !window.MessageChannel || !window.ReadableStream) return null;
  try {
    await navigator.serviceWorker.register('/sw.js');
    const reg = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await Promise.race([new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })), new Promise(r => setTimeout(r, 3000))]);
    }
    const worker = navigator.serviceWorker.controller || reg.active;
    if (!worker) return null;
    const id = Math.random().toString(36).slice(2);
    const { port1, port2 } = new MessageChannel();
    worker.postMessage({ type: 'download', id, name: info.name, size: info.size }, [port2]);
    let cancelled = false;
    port1.onmessage = e => { if (e.data === 'cancel') cancelled = true; };
    const ping = setInterval(() => worker.postMessage({ type: 'ping' }), 10_000); // (keeps it running meanwhile)
    const frame = h('iframe', { src: `/f/save/${id}`, hidden: true, title: 'download' });
    document.body.append(frame);
    return {
      kind: 'worker',
      // (cancelled in the browser's downloads)
      write: b => { if (cancelled) throw new Error('cancelled'); port1.postMessage(b, [b.buffer]); },
      close: () => { port1.postMessage('end'); clearInterval(ping); setTimeout(() => frame.remove(), 60e3); },
      abort: () => { port1.postMessage({ error: 'stopped' }); clearInterval(ping); frame.remove(); },
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the direct connection

async function connect() {
  const pc = new RTCPeerConnection({ iceServers: info.direct.stun.length ? [{ urls: info.direct.stun }] : [] });
  const ctl = pc.createDataChannel('beam');
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') return resolve();
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve(); });
    setTimeout(resolve, 2500);
  });
  const res = await fetch(`/api/links/${token}/direct`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sdp: pc.localDescription.sdp }) });
  if (!res.ok) { pc.close(); throw new Error((await res.json().catch(() => ({}))).error || 'No direct connection'); }
  await pc.setRemoteDescription({ type: 'answer', sdp: (await res.json()).sdp });
  await new Promise((resolve, reject) => {
    if (ctl.readyState === 'open') return resolve();
    ctl.onopen = resolve;
    setTimeout(() => reject(new Error('No direct connection came up')), 10_000);
  });
  return { pc, ctl };
}

async function fastDownload() {
  if (!info.direct || !window.RTCPeerConnection) return plainDownload();
  const stopping = new AbortController();
  running = { stop: () => stopping.abort() };
  buttons(true);
  let sink = null;
  let conn = null;
  try {
    sink = await openSink();
    if (sink === 'cancelled') { sink = null; return; }
    if (!sink) return plainDownload();
    setStatus('Connecting straight to the sender’s computer…');
    try {
      conn = await connect();
    } catch {
      sink.abort();
      sink = null;
      if (stopping.signal.aborted) return setStatus('Stopped.');
      return plainDownload('No direct connection could be made, so it goes through the public link. ');
    }
    if (stopping.signal.aborted) throw new Error('stopped');
    awake.on();
    await receive(conn, sink, stopping.signal);
    already = 'done';
  } catch (err) {
    sink?.abort();
    if (stopping.signal.aborted) setStatus('Stopped.');
    else if (err.message === 'cancelled') setStatus('The download was cancelled.');
    else setStatus(`It stopped: ${err.message}. Try again, or use Download in the background.`);
  } finally {
    running = null;
    buttons(false);
    awake.off();
    conn?.pc.close();
  }
}

function receive(conn, sink, signal) {
  return new Promise((resolve, reject) => {
    const dc = conn.pc.createDataChannel(JSON.stringify({ op: 'get', offset: 0 }));
    dc.binaryType = 'arraybuffer';
    // (what's already on its way after this is ignored: it would put the progress back over "Stopped.")
    const fail = err => { dc.onmessage = null; dc.onclose = null; try { dc.close(); } catch {} reject(err); };
    signal.addEventListener('abort', () => fail(new Error('stopped')), { once: true });
    const started = Date.now();
    let got = 0;
    let shown = 0;
    // (written in batches of a couple of MB, one after another)
    let batch = [];
    let batched = 0;
    let writing = Promise.resolve();
    const flush = () => {
      if (!batched) return writing;
      const whole = new Uint8Array(batched);
      let at = 0;
      for (const b of batch) { whole.set(b, at); at += b.byteLength; }
      batch = [];
      batched = 0;
      writing = writing.then(() => sink.write(whole));
      return writing;
    };
    dc.onmessage = e => {
      if (typeof e.data === 'string') {
        const j = JSON.parse(e.data);
        if (j.error) { dc.close(); reject(new Error(j.error)); }
        if (j.done) {
          dc.close();
          flush().then(() => sink.close()).then(() => {
            const s = (Date.now() - started) / 1000;
            const took = s < 10 ? `${s.toFixed(1)} s` : s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
            setStatus(`Done: ${formatSize(got)} in ${took}, straight from the sender (${formatSize(got / Math.max(s, 0.1))}/s).${sink.kind === 'worker' ? ' It’s in your downloads.' : ''}`, 1);
            resolve();
          }, reject);
        }
        return;
      }
      const b = new Uint8Array(e.data);
      batch.push(b);
      batched += b.byteLength;
      got += b.byteLength;
      if (batched >= 2 * 1024 * 1024) flush().catch(fail);
      const now = Date.now();
      if (now - shown > 250) {
        shown = now;
        const s = (now - started) / 1000;
        setStatus(`Downloading straight from the sender: ${formatSize(got)} of ${formatSize(info.size)} · ${formatSize(got / Math.max(s, 0.1))}/s`, got / info.size);
      }
    };
    dc.onclose = () => { if (got < info.size) reject(new Error('the connection closed')); };
  });
}

load();
