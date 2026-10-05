// Saving a file that arrives in pieces over a direct connection (1.9.0 on a fast link's page; 1.11.0 the app's own
// downloads too): a save dialog on a computer (the link's page asks for one), the browser's downloads through this
// site's service worker (sw.js turns what the page sends into a download: how a phone's browser writes such a file),
// memory for a small file. And the browser's own download of an address: Safari's on an iPhone or iPad, where what the
// service worker's stream saved didn't open (even a plain H.264 video).
import { h } from './ui.js';

export const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IN_MEMORY = 200 * 1024 * 1024;

export function plainSave(url, name = '') {
  const a = h('a', { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
}

// "6 min 40 s"
export const took = s => (s < 10 ? `${s.toFixed(1)} s` : s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);

// → { kind: 'file' | 'worker' | 'memory', write(Uint8Array), close(), abort() }; 'cancelled' (its save dialog was);
// null (nothing here can take it: the browser's own download it is). `dialog`: a save dialog where there's one, which
// needs the tap that asked for it: call this before awaiting anything.
export async function openSink(name, size, mime, { dialog = true } = {}) {
  if (dialog && window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name });
      const w = await handle.createWritable();
      return { kind: 'file', write: b => w.write(b), close: () => w.close(), abort: () => w.abort().catch(() => {}) };
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
    }
  }
  const sw = await workerSink(name, size);
  if (sw) return sw;
  if (size <= IN_MEMORY) {
    const parts = [];
    return {
      kind: 'memory',
      write: b => { parts.push(b); },
      close: () => {
        const url = URL.createObjectURL(new Blob(parts, { type: mime || 'application/octet-stream' }));
        plainSave(url, name);
        setTimeout(() => URL.revokeObjectURL(url), 60e3);
      },
      abort: () => { parts.length = 0; },
    };
  }
  return null;
}

// The service worker answers a download of /f/save/<id> with a stream this page fills; null without a service worker.
async function workerSink(name, size) {
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
    worker.postMessage({ type: 'download', id, name, size }, [port2]);
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

// A file over a direct connection: a data channel labelled `label` ({"op":"get",…}: lib/direct.js), `size` bytes,
// written to `sink` in batches of 2 MB, one after another. onProgress(got, bytes a second, true) at most 4 times a
// second. Resolves { got, seconds } once the server says it's all sent and the sink has it all; rejects on the
// server's error, a cancel in the browser's downloads ("cancelled") or `signal` ("stopped"). What's already on its way
// after that is ignored (it would put the progress back). (1.15.1) `from`: the byte it starts at (the label's offset).
// A connection that drops (the channel closes early, the connection fails or stays lost for 8 s) rejects with
// `dropped` and `got` once the sink has every byte that came: the caller can go on from there (receiveResuming).
export function receiveDirect(pc, label, size, sink, { onProgress = null, signal = null, from = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const dc = pc.createDataChannel(JSON.stringify(label));
    dc.binaryType = 'arraybuffer';
    const started = Date.now();
    let got = from;
    let shown = 0;
    let batch = [];
    let batched = 0;
    let writing = Promise.resolve();
    let lostSince = 0;
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
    // (a connection that dropped doesn't always say so on the channel: looked at every 2 s too)
    const look = setInterval(() => {
      const state = pc.connectionState;
      if (dc.readyState === 'closed' || state === 'failed' || state === 'closed') return dropped();
      if (state !== 'disconnected') lostSince = 0;
      else if (!lostSince) lostSince = Date.now();
      else if (Date.now() - lostSince >= 8000) dropped();
    }, 2000);
    const onAbort = () => fail(new Error('stopped'));
    const quiet = () => { dc.onmessage = null; dc.onclose = null; clearInterval(look); signal?.removeEventListener('abort', onAbort); };
    const fail = err => { quiet(); try { dc.close(); } catch {} reject(err); };
    // What came goes into the sink first: the caller goes on from `got`.
    const dropped = () => {
      quiet();
      try { dc.close(); } catch {}
      flush().then(() => reject(Object.assign(new Error('the connection closed'), { dropped: true, got })), reject);
    };
    if (signal?.aborted) return fail(new Error('stopped'));
    signal?.addEventListener('abort', onAbort, { once: true });
    dc.onmessage = e => {
      if (typeof e.data === 'string') {
        const j = JSON.parse(e.data);
        if (j.error) return fail(new Error(j.error));
        if (j.done) {
          quiet();
          dc.close();
          flush().then(() => sink.close()).then(() => resolve({ got, seconds: (Date.now() - started) / 1000 }), reject);
        }
        return;
      }
      const b = new Uint8Array(e.data);
      batch.push(b);
      batched += b.byteLength;
      got += b.byteLength;
      if (batched >= 2 * 1024 * 1024) flush().catch(fail);
      const now = Date.now();
      if (onProgress && now - shown > 250) {
        shown = now;
        onProgress(got, (got - from) / Math.max((now - started) / 1000, 0.1), true);
      }
    };
    dc.onclose = () => { if (got < size) dropped(); };
  });
}

// (1.15.1) The rest of a file over https, from byte `from` on (a Range request), into `sink` like receiveDirect, with
// the same answers (onProgress's third argument is false).
export async function receiveHttps(url, from, size, sink, { onProgress = null, signal = null } = {}) {
  const started = Date.now();
  let got = from;
  let shown = 0;
  let batch = [];
  let batched = 0;
  const flush = async () => {
    if (!batched) return;
    const whole = new Uint8Array(batched);
    let at = 0;
    for (const b of batch) { whole.set(b, at); at += b.byteLength; }
    batch = [];
    batched = 0;
    await sink.write(whole);
  };
  const dropped = () => Object.assign(new Error('the connection closed'), { dropped: true, got });
  let res;
  try {
    res = await fetch(url, { headers: from ? { Range: `bytes=${from}-` } : {}, cache: 'no-store', signal });
  } catch {
    if (signal?.aborted) throw new Error('stopped');
    throw dropped();
  }
  const at = Number(/^bytes (\d+)-/.exec(res.headers.get('Content-Range') || '')?.[1]);
  if (from ? res.status !== 206 || at !== from : res.status !== 200) {
    const answer = await res.json().catch(() => ({}));
    throw new Error(answer.error || `the server answered ${res.status}`);
  }
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      batch.push(value);
      batched += value.byteLength;
      got += value.byteLength;
      if (batched >= 2 * 1024 * 1024) await flush();
      const now = Date.now();
      if (onProgress && now - shown > 250) {
        shown = now;
        onProgress(got, (got - from) / Math.max((now - started) / 1000, 0.1), false);
      }
    }
  } catch (err) {
    if (signal?.aborted) throw new Error('stopped');
    if (err.message === 'cancelled') throw err; // (the sink's: cancelled in the browser's downloads)
    await flush();
    throw dropped();
  }
  await flush();
  if (got < size) throw dropped();
  await sink.close();
  return { got, seconds: (Date.now() - started) / 1000 };
}

// (1.15.1) A file over a direct connection that goes on from where it got to when the connection drops (it used to
// start over): over a new direct connection when one comes up (`connect()` → a peer connection, or null), else over
// https from that byte (`url`). `label(offset)`: the data channel's label from that byte on. onResume(got): it goes on
// from there. After 8 drops in a row with nothing in between it gives up (the last one's error). Resolves
// { got, seconds, https } (https: some of it came that way).
export async function receiveResuming({ pc, connect, label, url, size, sink, signal = null, onProgress = null, onResume = null }) {
  const started = Date.now();
  let got = 0;
  let https = false;
  for (let fruitless = 0; ;) {
    try {
      if (!pc) https = true;
      const r = pc ? await receiveDirect(pc, label(got), size, sink, { onProgress, signal, from: got })
        : await receiveHttps(url, got, size, sink, { onProgress, signal });
      return { got: r.got, seconds: (Date.now() - started) / 1000, https };
    } catch (err) {
      if (!err.dropped) throw err;
      fruitless = err.got > got ? 1 : fruitless + 1;
      if (fruitless > 8) throw err;
      got = err.got;
      onResume?.(got);
      await pause(Math.min(1000 * 2 ** (fruitless - 1), 15_000), signal);
      pc = await connect().catch(() => null);
    }
  }
}

// Waits `ms`; rejects with "stopped" if `signal` says so meanwhile.
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('stopped'));
    const stop = () => { clearTimeout(timer); reject(new Error('stopped')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}
