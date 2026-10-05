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
// (1.10.0) A video plays right here, in its version that plays everywhere (H.264, standard color; made by the server
// with ffmpeg), which can also be downloaded ("for any phone"); while it's being made, the page says how far it got.
// On an iPhone or iPad, Download is Safari's own download: an iPhone couldn't open what the service worker's stream
// saved (even a plain H.264 video), and Safari had bugs there (fixed only in iOS 26).
import { h, fill, formatSize, confirmDialog } from './ui.js';
import { IOS, openSink, plainSave, receiveDirect, took } from './saving.js';

const token = location.pathname.split('/')[2] || '';
const card = document.getElementById('card');
const fileUrl = `/api/links/${token}/file`;
let info = null;
let running = null;   // the direct download going on: { stop() }
let already = '';     // 'background' once the browser's downloads have it, 'done' once a direct download finished

async function load() {
  let res;
  try { res = await fetch(`/api/links/${token}`, { cache: 'no-store' }); } catch { return problem('Can’t reach it right now. Check the connection and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return problem(data.error || 'This link doesn’t work any more.');
  info = data;
  // (1.15.0) used up: nothing more to download; a copy without location data still being made: wait for it
  if (info.usedUp) return problem('It was downloaded as many times as its sender allowed.', 'This link has been used up');
  if (info.cleaning === 'failed') return problem('Its sender asked for it without location data, and that copy couldn’t be made.');
  if (info.cleaning === 'working') {
    fill(card, h('h1', { class: 'link-name' }, info.name), h('p', { class: 'muted' }, 'Getting it ready: taking out where it was taken (location data)…'));
    return setTimeout(load, 2000);
  }
  render();
  if (info.received < info.size && !running) setTimeout(refresh, 3000);
  if (info.play === 'working') setTimeout(watchPlay, 5000);
}

// (1.10.0) While the version that plays everywhere is being made: how far, then the player once it's there.
async function watchPlay() {
  try {
    const res = await fetch(`/api/links/${token}`, { cache: 'no-store' });
    if (!res.ok) return;
    const next = await res.json();
    Object.assign(info, { play: next.play, playUrl: next.playUrl, playSize: next.playSize, playProgress: next.playProgress });
    if (next.play === 'working') {
      const p = card.querySelector('.preparing');
      if (p) p.textContent = preparingText();
      return setTimeout(watchPlay, 5000);
    }
    const box = card.querySelector('.link-media');
    if (box) fill(box, mediaEl());
    const other = card.querySelector('#playable');
    if (!other && info.play === 'ready') card.querySelector('.link-actions')?.append(playableButton());
  } catch { setTimeout(watchPlay, 15000); }
}

const preparingText = () => `Getting it ready to play on any phone or browser${info.playProgress ? `: ${Math.round(info.playProgress * 100)}%` : '…'}`;

// A video: the player (its version that plays everywhere, or the original when that already does); else the preview.
function mediaEl() {
  const preview = info.preview ? `/api/links/${token}/preview` : null;
  if (info.video && info.playUrl) return h('video', { class: 'link-video', src: info.playUrl, controls: true, playsinline: true, preload: 'metadata', poster: preview });
  const pic = preview ? h('img', { class: 'link-preview', src: preview, alt: '' }) : null;
  if (info.video && info.play === 'working') return [pic, h('p', { class: 'small muted preparing' }, preparingText())];
  return pic;
}

// The version that plays everywhere, to keep (Safari's or the browser's own download).
function playableButton() {
  return h('button', { class: 'btn', type: 'button', id: 'playable', onclick: onPlayable }, `Download for any phone (${formatSize(info.playSize)})`);
}

async function onPlayable() {
  if (running) return;
  if (already && !(await again())) return;
  plainSave(`${info.playUrl}?download`);
  already = 'background';
  setStatus('Your browser is downloading the version that plays on any phone: see its downloads (on a phone: pull down the notifications, or Safari’s or Chrome’s downloads).');
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

function problem(text, title = 'This link doesn’t work') {
  fill(card, h('h1', {}, title), h('p', { class: 'muted' }, text));
}

function render() {
  const expires = new Date(info.expires).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  fill(card,
    h('div', { class: 'link-media' }, mediaEl()),
    h('h1', { class: 'link-name' }, info.name),
    h('p', { class: 'muted' }, `${formatSize(info.size)} · from ${info.from} · until ${expires}${info.maxDownloads ? ` · ${info.downloadsLeft === 1 ? 'one download left' : `${info.downloadsLeft} downloads left`}` : ''}`),
    info.removeLocation ? h('p', { class: 'muted small' }, 'Shared without its location data.') : null,
    h('p', { class: 'muted small arriving' }, arrivingText()),
    h('div', { class: 'link-actions' },
      h('button', { class: 'btn primary', type: 'button', id: 'get', onclick: onDownload }, 'Download'),
      h('button', { class: 'btn', type: 'button', id: 'background', onclick: onBackground }, 'Download in the background'),
      info.play === 'ready' ? playableButton() : null),
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
  const playable = card.querySelector('#playable');
  if (playable) playable.disabled = downloading;
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
  plainSave(fileUrl, info.name);
  already = 'background';
  setStatus(`${note}Your browser is downloading it: see its downloads (on a phone: pull down the notifications, or Chrome’s ⋮ menu → Downloads). It carries on with the screen locked.`);
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
  if (IOS) return plainDownload('On an iPhone or iPad this is Safari’s own download (the fast way saves broken files there). ');
  const stopping = new AbortController();
  running = { stop: () => stopping.abort() };
  buttons(true);
  let sink = null;
  let conn = null;
  try {
    sink = await openSink(info.name, info.size, info.mime);
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

async function receive(conn, sink, signal) {
  const r = await receiveDirect(conn.pc, { op: 'get', offset: 0 }, info.size, sink, {
    signal,
    onProgress: (got, rate) => setStatus(`Downloading straight from the sender: ${formatSize(got)} of ${formatSize(info.size)} · ${formatSize(rate)}/s`, got / info.size),
  });
  setStatus(`Done: ${formatSize(r.got)} in ${took(r.seconds)}, straight from the sender (${formatSize(r.got / Math.max(r.seconds, 0.1))}/s).${sink.kind === 'worker' ? ' It’s in your downloads.' : ''}`, 1);
}

load();
