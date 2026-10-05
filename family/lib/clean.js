'use strict';
// Copies without location data, for fast links that leave the family (1.15.0; the user's audit, S-9: "offer remove
// location data when a fast link is made for a photo or video"; the user: "yeah do your recommendations").
//
// One copy per file, in clean/<attachment id>, made the first time a link asks for it and counted in the storage:
// - a JPEG photo: the Exif, XMP, IPTC and makers' blocks and comments go (where it was taken, when, the camera and
//   its owner); its orientation stays, in a small Exif of its own, so it still shows the right way up; whatever
//   follows the picture (a motion photo's video, more pictures) goes too;
// - a PNG: its text, time and Exif chunks go;
// - a video: copied by ffmpeg with its pictures and sound as they are, without its metadata (the place, the phone)
//   or its data tracks (GPS tracks). Needs ffmpeg (BEAM_FAMILY_FFMPEG); without it videos aren't offered.
// Anything else (HEIC, WebP, …) isn't offered.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_PHOTO = 200 * 1024 * 1024; // (read whole: photos are a few MB)

// The orientation (Exif tag 0x0112) in an APP1 block's payload ("Exif\0\0" + TIFF), or 0.
function exifOrientation(payload) {
  if (payload.length < 14 || payload.toString('latin1', 0, 6) !== 'Exif\0\0') return 0;
  const t = payload.subarray(6);
  const le = t.toString('latin1', 0, 2) === 'II';
  const u16 = o => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = o => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  try {
    const ifd = u32(4);
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (u16(e) === 0x0112) {
        const o = u16(e + 8);
        return o >= 1 && o <= 8 ? o : 0;
      }
    }
  } catch {}
  return 0;
}

// An APP1 Exif block holding only the orientation (a big-endian TIFF with one IFD entry: SHORT, count 1).
function orientationBlock(o) {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(o, 18);
  tiff.writeUInt32BE(0, 22);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

// A JPEG without its metadata: the blocks that draw the picture (and its color profile and JFIF/Adobe notes) stay.
function cleanJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('it isn’t a JPEG');
  const head = [];
  let orientation = 0;
  let jfifAt = -1;
  let pos = 2;
  for (;;) {
    if (pos + 4 > buf.length || buf[pos] !== 0xff) throw new Error('the JPEG is damaged');
    const marker = buf[pos + 1];
    if (marker === 0xff) { pos++; continue; } // (fill)
    if (marker === 0xda) break; // the picture's data starts
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { pos += 2; continue; } // (no length)
    const len = buf.readUInt16BE(pos + 2);
    if (len < 2 || pos + 2 + len > buf.length) throw new Error('the JPEG is damaged');
    const seg = buf.subarray(pos, pos + 2 + len);
    const payload = buf.subarray(pos + 4, pos + 2 + len);
    if (marker === 0xe1) {
      if (!orientation) orientation = exifOrientation(payload); // Exif, XMP: out (the orientation is kept)
    } else if (marker === 0xe2) {
      if (payload.toString('latin1', 0, 12) === 'ICC_PROFILE\0') head.push(seg); // the color profile; MPF and others out
    } else if (marker === 0xe0) {
      if (jfifAt < 0) jfifAt = head.length;
      head.push(seg); // JFIF
    } else if (marker === 0xee) {
      head.push(seg); // Adobe (how its colors are stored)
    } else if ((marker >= 0xe3 && marker <= 0xef) || marker === 0xfe) {
      // other APPn (IPTC, makers' notes, …) and comments: out
    } else {
      head.push(seg); // tables, the frame
    }
    pos += 2 + len;
  }
  // The scans (with the tables between them) up to the end of the picture; what follows is left out.
  const scansFrom = pos;
  for (;;) {
    if (pos + 2 > buf.length || buf[pos] !== 0xff) throw new Error('the JPEG is damaged');
    const marker = buf[pos + 1];
    if (marker === 0xd9) { pos += 2; break; }
    if (marker === 0xff) { pos++; continue; }
    if (pos + 4 > buf.length) throw new Error('the JPEG ends early');
    const len = buf.readUInt16BE(pos + 2);
    pos += 2 + len;
    if (marker === 0xda) {
      // entropy-coded data: up to a 0xFF that isn't stuffing (00) or a restart marker
      for (;;) {
        const ff = buf.indexOf(0xff, pos);
        if (ff < 0 || ff + 1 >= buf.length) throw new Error('the JPEG ends early');
        const next = buf[ff + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { pos = ff + 2; continue; }
        pos = ff;
        break;
      }
    }
  }
  if (orientation > 1) head.splice(jfifAt >= 0 ? jfifAt + 1 : 0, 0, orientationBlock(orientation));
  return Buffer.concat([buf.subarray(0, 2), ...head, buf.subarray(scansFrom, pos)]);
}

// A PNG without its text, time and Exif chunks.
function cleanPng(buf) {
  if (buf.toString('latin1', 0, 8) !== '\x89PNG\r\n\x1a\n') throw new Error('it isn’t a PNG');
  const out = [buf.subarray(0, 8)];
  let pos = 8;
  for (;;) {
    if (pos + 12 > buf.length) throw new Error('the PNG ends early');
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + len;
    if (end > buf.length) throw new Error('the PNG is damaged');
    if (!['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME'].includes(type)) out.push(buf.subarray(pos, end));
    pos = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

const VIDEO_FORMATS = { mp4: 'mp4', m4v: 'mp4', mov: 'mov', '3gp': '3gp', mkv: 'matroska', webm: 'webm' };

// What kind of copy a file can get, or null.
function kindOf(a, { isVideo, ffmpeg }) {
  const name = String(a.name || '');
  if (/^image\/p?jpeg$/i.test(a.mime) || /\.jpe?g$/i.test(name)) return 'jpeg';
  if (/^image\/png$/i.test(a.mime) || /\.png$/i.test(name)) return 'png';
  if (isVideo(a) && ffmpeg && VIDEO_FORMATS[(/\.([a-z0-9]+)$/i.exec(name)?.[1] || '').toLowerCase()]) return 'video';
  return null;
}

function remux(ffmpeg, src, dest, name) {
  const format = VIDEO_FORMATS[(/\.([a-z0-9]+)$/i.exec(name)?.[1] || '').toLowerCase()];
  const args = ['-hide_banner', '-v', 'error', '-y', '-i', src,
    '-map', '0:v?', '-map', '0:a?', '-map', '0:s?', '-c', 'copy',
    '-map_metadata', '-1', '-map_metadata:s:v', '-1', '-map_metadata:s:a', '-1', '-map_chapters', '-1',
    ...(format === 'mp4' || format === 'mov' ? ['-movflags', '+faststart'] : []), '-f', format, dest];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err = (err + d).slice(-2000); });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(err.trim().split(/\r?\n/).pop() || `ffmpeg stopped (${code})`))));
  });
}

function createClean(ctx) {
  const { db, log } = ctx;
  const dir = ctx.dirs.clean;
  const pathOf = id => path.join(dir, id);
  const making = new Map(); // attachment id → its promise
  // (a copy left half-made by a stop is made again when a link next asks)
  db.run("UPDATE attachments SET clean = NULL, clean_size = NULL WHERE clean = 'working'");

  const tools = () => ({ isVideo: ctx.media.isVideo, ffmpeg: ctx.media.ffmpeg?.() || null });
  const supported = a => kindOf(a, tools());

  // The copy's state: 'ready', 'working' or 'failed' (made now if there's none yet).
  function ensure(a) {
    const row = db.get('SELECT clean, clean_size FROM attachments WHERE id = ?', a.id);
    if (row?.clean === 'ready' && fs.existsSync(pathOf(a.id))) return 'ready';
    if (row?.clean === 'failed') return 'failed';
    if (!making.has(a.id)) making.set(a.id, make(a).finally(() => making.delete(a.id)));
    return 'working';
  }

  async function make(a) {
    const kind = supported(a);
    db.run("UPDATE attachments SET clean = 'working', clean_size = NULL WHERE id = ?", a.id);
    const dest = pathOf(a.id);
    const partial = `${dest}.partial`;
    try {
      if (!kind) throw new Error('not a kind of file it can do');
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      const src = ctx.files.filePath(a.id);
      if (kind === 'video') {
        await remux(tools().ffmpeg, src, partial, a.name);
      } else {
        const st = await fsp.stat(src);
        if (st.size > MAX_PHOTO) throw new Error('too big for a photo');
        const buf = await fsp.readFile(src);
        await fsp.writeFile(partial, kind === 'jpeg' ? cleanJpeg(buf) : cleanPng(buf), { mode: 0o600 });
      }
      await fsp.rename(partial, dest);
      const size = (await fsp.stat(dest)).size;
      db.run("UPDATE attachments SET clean = 'ready', clean_size = ? WHERE id = ?", size, a.id);
      log.info(`Made a copy of ${a.name} without location data for a fast link`);
    } catch (err) {
      await fsp.rm(partial, { force: true }).catch(() => {});
      db.run("UPDATE attachments SET clean = 'failed', clean_size = NULL WHERE id = ?", a.id);
      log.warn(`Couldn’t make a copy of ${a.name} without location data: ${err.message}`);
    }
  }

  // The file went: its copy too.
  function forget(id) {
    return fsp.rm(pathOf(id), { force: true }).catch(() => {});
  }

  // (for tests and the links) the promise of a copy being made, if one is
  const whenMade = id => making.get(id) || Promise.resolve();

  return { supported, ensure, pathOf, forget, whenMade };
}

module.exports = { createClean, cleanJpeg, cleanPng, exifOrientation, orientationBlock, remux };
