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

// Uploads one file: the item gets id, progress (0–1); onChange is called as it goes. Resolves with the id.
export async function upload(item, onChange, signal) {
  const { file } = item;
  if (!item.id) {
    const started = await api('/api/uploads', { method: 'POST', body: { name: file.name, size: file.size, mime: file.type }, signal });
    item.id = started.id;
    item.offset = started.offset;
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
