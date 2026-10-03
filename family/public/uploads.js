// Sending files: a preview made here for pictures and videos (turned the right way up), then the file in pieces of
// 4 MB that pick up where they stopped after a dropped connection.

import { api, ApiError } from './api.js';

const PIECE = 4 * 1024 * 1024;
const THUMB = 480;

// A JPEG preview (and the original's size) of a picture or video, or null.
export async function makeThumb(file) {
  try {
    if (file.type.startsWith('image/') && !/svg|heic|heif/i.test(file.type)) {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const out = await draw(bmp, bmp.width, bmp.height);
      bmp.close?.();
      return out;
    }
    if (file.type.startsWith('video/')) return await videoThumb(file);
  } catch {}
  return null;
}

async function draw(source, width, height) {
  const scale = Math.min(1, THUMB / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff'; // (pictures with transparency get a white background in the JPEG)
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  return blob ? { blob, width, height } : null;
}

function videoThumb(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const done = value => { URL.revokeObjectURL(url); video.removeAttribute('src'); resolve(value); };
    const timer = setTimeout(() => done(null), 8000);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.onloadedmetadata = () => { video.currentTime = Math.min(0.5, (video.duration || 1) / 3); };
    video.onseeked = async () => {
      clearTimeout(timer);
      done(video.videoWidth ? await draw(video, video.videoWidth, video.videoHeight) : null);
    };
    video.onerror = () => { clearTimeout(timer); done(null); };
    video.src = url;
  });
}

// (1.8.3) While files are being sent the screen stays on: a phone that locks (or another app) pauses the page, and
// the upload with it. Released when the last one ends; asked again when the page is back in front.
let sendingNow = 0;
let wake = null;
let asking = false;
async function syncWake() {
  try {
    if (sendingNow && !wake && !asking && document.visibilityState === 'visible' && navigator.wakeLock) {
      asking = true;
      try { wake = await navigator.wakeLock.request('screen'); } finally { asking = false; }
      wake.addEventListener('release', () => { wake = null; });
      if (!sendingNow) wake?.release();
    } else if (!sendingNow && wake) {
      const w = wake;
      wake = null;
      await w.release();
    }
  } catch { wake = null; }
}
export function sendingFiles(delta) {
  sendingNow = Math.max(0, sendingNow + delta);
  syncWake();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncWake(); });

// (1.8.4) The uploads this page is sending (in the tray or a message on its way): the rest of one's unsent uploads on the
// server were left by a page that's gone (closed, reloaded, a phone that dropped it).
export const busy = new Set();

// One's unsent uploads that no file here is sending: [{ id, name, size, received, mime }].
export async function leftOver() {
  const r = await api('/api/uploads');
  return (r?.uploads || []).filter(u => !busy.has(u.id));
}

// Stops sending a file (the tray's ×, Cancel on a message still sending), and the server drops what it got (1.8.3).
export function cancelUpload(item) {
  item.cancelled = true;
  item.abort?.abort();
  if (item.id) {
    busy.delete(item.id);
    api(`/api/uploads/${item.id}`, { method: 'DELETE' }).catch(() => {});
  }
}

// Drops an upload a page that's gone left behind (1.8.4).
export function discardUpload(id) {
  return api(`/api/uploads/${id}`, { method: 'DELETE' }).catch(() => {});
}

// Uploads one file: the item gets id, progress (0–1); onChange is called as it goes. Resolves with the id.
export async function upload(item, onChange, signal) {
  const { file } = item;
  if (!item.id) {
    // (not cut short when cancelled: its id is what the server needs to drop it, 1.8.3)
    const started = await api('/api/uploads', { method: 'POST', body: { name: file.name, size: file.size, mime: file.type } });
    item.id = started.id;
    busy.add(item.id);
    item.offset = started.offset;
    if (item.cancelled) {
      api(`/api/uploads/${item.id}`, { method: 'DELETE' }).catch(() => {});
      throw new DOMException('Cancelled', 'AbortError');
    }
  }
  let tries = 0;
  while (item.offset < file.size) {
    const end = Math.min(file.size, item.offset + PIECE);
    try {
      const r = await api(`/api/uploads/${item.id}?offset=${item.offset}`, { method: 'PUT', body: file.slice(item.offset, end), type: 'application/octet-stream', signal });
      item.offset = r.offset;
      tries = 0;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (err instanceof ApiError && err.status === 409 && Number.isFinite(err.data?.offset)) { item.offset = err.data.offset; continue; }
      if (err instanceof ApiError && err.status && err.status !== 409 && err.status < 500) throw err;
      if (++tries > 6) throw err;
      await new Promise(r => setTimeout(r, Math.min(15000, 1000 * 2 ** tries)));
      // Where the server got to, before trying again.
      try { item.offset = (await api(`/api/uploads/${item.id}`, { signal })).offset; } catch {}
    }
    item.progress = file.size ? item.offset / file.size : 1;
    onChange?.(item);
  }
  if (item.thumb) {
    await api(`/api/files/${item.id}/thumb?w=${item.thumb.width}&h=${item.thumb.height}`, { method: 'PUT', body: item.thumb.blob, type: 'image/jpeg', signal }).catch(() => {});
  }
  item.progress = 1;
  item.done = true;
  onChange?.(item);
  return item.id;
}
