'use strict';
// Files in messages: resumable uploads (POST, then PUT pieces at an offset), thumbnails the sender's app makes,
// avatars, and serving them. A file is only ever shown inline when it's a picture, video or sound a browser plays;
// everything else downloads, under a sandbox, so nothing sent can run as the app.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { newId, isId } = require('./ids');
const { httpError, send, readJson, readBody, sendFile, contentDisposition } = require('./http');

const now = () => Date.now();
const MAX_THUMB = 256 * 1024;
const MAX_AVATAR = 512 * 1024;
const MAX_PIECE = 16 * 1024 * 1024;
const KEEP_EVERY = 2 * 1024 * 1024;
const UNSENT_HOURS = 24;

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', heic: 'image/heic',
  heif: 'image/heif', bmp: 'image/bmp', svg: 'image/svg+xml', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav',
  flac: 'audio/flac', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
// What a browser may show inline: pictures, videos and sounds (never SVG, HTML or PDF, which can carry scripts).
const INLINE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/flac', 'audio/webm']);
const BIDI = /[‪-‮⁦-⁩‎‏؜]/g;

function cleanFileName(name) {
  let s = String(name ?? '').toWellFormed().split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(BIDI, '').replace(/^[\s.]+|[\s.]+$/g, '');
  const chars = [...s];
  if (chars.length > 150) {
    const ext = path.extname(s);
    s = chars.slice(0, 150 - [...ext].length).join('') + (ext.length <= 16 ? ext : '');
  }
  return s || 'file';
}

function mimeFor(name, declared) {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (MIME[ext]) return MIME[ext];
  const type = String(declared || '').split(';')[0].trim().toLowerCase();
  if (/^[a-z]+\/[\w.+-]+$/.test(type) && !/html|xml|javascript|ecmascript|svg/.test(type)) return type;
  return 'application/octet-stream';
}

// Reads and drops a request's body (up to one piece; a longer one is cut off).
async function drain(req) {
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_PIECE) return req.destroy();
    }
  } catch {}
}

function createFiles(ctx) {
  const { db, hub, log, config, dirs } = ctx;
  const people = () => ctx.people;
  const writing = new Set(); // uploads with a PUT in progress (one at a time each)

  const filePath = id => path.join(dirs.files, id);
  const partPath = id => path.join(dirs.uploads, `${id}.part`);
  const thumbPath = id => path.join(dirs.thumbs, id);

  function attachmentJson(a) {
    const out = { id: a.id, name: a.name, mime: a.mime, size: a.size, url: `/api/files/${a.id}` };
    if (a.width && a.height) { out.width = a.width; out.height = a.height; }
    if (a.thumb) out.thumb = `/api/files/${a.id}/thumb`;
    return out;
  }

  const storageUsed = () => db.get('SELECT coalesce(sum(size), 0) n FROM attachments').n;

  // The attachment if this person may see it: they sent it, or it's in a conversation they see.
  function visibleAttachment(user, id) {
    const a = isId(id) ? db.get('SELECT * FROM attachments WHERE id = ?', id) : null;
    if (!a) throw httpError(404, 'Not found');
    if (a.message_id) {
      const m = db.get('SELECT channel_id, deleted_at FROM messages WHERE id = ?', a.message_id);
      if (!m || m.deleted_at) throw httpError(404, 'Not found');
      ctx.chat.channelFor(user, m.channel_id);
    } else if (a.uploader_id !== user.id) {
      throw httpError(404, 'Not found');
    }
    return a;
  }

  // POST /api/uploads { name, size, mime? } → { id, offset: 0 }
  async function startUpload(req, res) {
    const user = people().requireUser(req);
    const body = await readJson(req);
    const name = cleanFileName(body.name);
    const size = Number(body.size);
    if (!Number.isSafeInteger(size) || size < 0) throw httpError(400, 'size must be a whole number of bytes');
    if (size > config.maxUpload) throw httpError(413, `Files can be at most ${Math.round(config.maxUpload / 1024 / 1024)} MB`);
    // (1.7.2) a few unsent uploads at a time: declared sizes count against the storage until they're sent or swept
    if (db.get('SELECT count(*) n FROM attachments WHERE uploader_id = ? AND message_id IS NULL', user.id).n >= 30) {
      throw httpError(429, 'Send or remove the files you’re already sending first');
    }
    if (storageUsed() + size > config.maxStorage) {
      log.warn(`Storage is full: refused ${name} from ${user.name}`);
      throw httpError(507, 'The family space’s storage is full. Ask the owner to make room.');
    }
    const id = newId();
    db.run('INSERT INTO attachments (id, uploader_id, name, mime, size, received, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)', id, user.id, name, mimeFor(name, body.mime), size, now());
    if (size === 0) await fsp.writeFile(filePath(id), '');
    else await fsp.writeFile(partPath(id), '');
    send(res, 201, { id, offset: 0, done: size === 0 });
  }

  // GET /api/uploads: one's own files not sent yet, newest first (a page closed or reloaded on a phone left them), so the
  // app can offer to go on with them (1.8.4): { uploads: [{ id, name, size, received, mime, created }] }.
  function listUnsent(req, res) {
    const user = people().requireUser(req);
    const rows = db.all('SELECT * FROM attachments WHERE uploader_id = ? AND message_id IS NULL ORDER BY created_at DESC', user.id);
    send(res, 200, { uploads: rows.map(a => ({ id: a.id, name: a.name, size: a.size, received: a.received, mime: a.mime, created: a.created_at })) });
  }

  // GET /api/uploads/:id → { offset, size, done } (where to go on after a dropped connection)
  function uploadState(req, res, { id }) {
    const user = people().requireUser(req);
    const a = isId(id) && db.get('SELECT * FROM attachments WHERE id = ? AND uploader_id = ?', id, user.id);
    if (!a) throw httpError(404, 'No such upload');
    send(res, 200, { offset: a.received, size: a.size, done: a.received >= a.size });
  }

  // PUT /api/uploads/:id?offset=N (the bytes from N on; any length up to 16 MB)
  async function putPiece(req, res, { id }, url) {
    const user = people().requireUser(req);
    const a = isId(id) && db.get('SELECT * FROM attachments WHERE id = ? AND uploader_id = ?', id, user.id);
    if (!a) throw httpError(404, 'No such upload');
    if (a.received >= a.size) return send(res, 200, { offset: a.size, done: true });
    const offset = Number(url.searchParams.get('offset'));
    // (the piece is read and dropped first, so the app gets this answer rather than a cut connection)
    if (offset !== a.received) { await drain(req); return send(res, 409, { error: 'Continue from the offset the server has', offset: a.received }); }
    if (writing.has(id)) { await drain(req); throw httpError(409, 'That upload is already being sent'); }
    writing.add(id);
    let received = a.received;
    let handle;
    try {
      handle = await fsp.open(partPath(id), 'r+');
      const limit = Math.min(MAX_PIECE, a.size - a.received);
      let written = 0;
      let kept = 0;
      try {
        for await (const chunk of req) {
          if (written + chunk.length > limit) throw httpError(413, 'That is more than the file’s size');
          await handle.write(chunk, 0, chunk.length, offset + written);
          written += chunk.length;
          // Progress is kept every 2 MB on the way: a phone whose connection drops goes on from there, not from the
          // start of the 16 MB piece (1.7.3, audit O-10).
          if (written - kept >= KEEP_EVERY && written < limit) {
            await handle.sync();
            kept = written;
            db.run('UPDATE attachments SET received = ? WHERE id = ?', offset + kept, id);
          }
        }
      } catch (err) {
        // A piece cut off on the way (the app goes on from the offset): not a server error (1.7.2)
        if (!err.status && (req.aborted || err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_PREMATURE_CLOSE')) throw httpError(400, 'The piece was cut off');
        throw err;
      }
      await handle.sync();
      received = offset + written;
      db.run('UPDATE attachments SET received = ? WHERE id = ?', received, id);
    } finally {
      await handle?.close().catch(() => {});
      writing.delete(id);
    }
    // (1.8.3) cancelled while this piece came in: nothing of it stays
    if (!db.get('SELECT id FROM attachments WHERE id = ?', id)) {
      await fsp.rm(partPath(id), { force: true }).catch(() => {});
      throw httpError(404, 'That upload was cancelled');
    }
    if (received >= a.size) await fsp.rename(partPath(id), filePath(id));
    send(res, 200, { offset: received, done: received >= a.size });
  }

  // DELETE /api/uploads/:id: the sender stopped it (the ×, or Cancel on a message still sending): what came goes now
  // rather than after a day (1.8.3). Only one's own, and only while it isn't in a message.
  async function cancelUpload(req, res, { id }) {
    const user = people().requireUser(req);
    const a = isId(id) && db.get('SELECT * FROM attachments WHERE id = ? AND uploader_id = ?', id, user.id);
    if (!a) throw httpError(404, 'No such upload');
    if (a.message_id) throw httpError(409, 'That file was sent already: delete its message instead');
    db.run('DELETE FROM attachments WHERE id = ?', id);
    await removeStored(a).catch(() => {});
    send(res, 204);
  }

  // PUT /api/files/:id/thumb?w=&h= (a JPEG or WebP preview from the sender's app; w×h: the original's size)
  async function putThumb(req, res, { id }, url) {
    const user = people().requireUser(req);
    const a = isId(id) && db.get('SELECT * FROM attachments WHERE id = ? AND uploader_id = ?', id, user.id);
    if (!a) throw httpError(404, 'Not found');
    if (!/^(image|video)\//.test(a.mime)) throw httpError(400, 'Only pictures and videos have previews');
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const format = type === 'image/jpeg' ? 'jpeg' : type === 'image/webp' ? 'webp' : null;
    if (!format) throw httpError(415, 'Send the preview as image/jpeg or image/webp');
    const data = await readBody(req, MAX_THUMB);
    const looksRight = format === 'jpeg' ? data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
      : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
    if (!looksRight) throw httpError(400, `That isn’t a ${format.toUpperCase()} picture`);
    const w = Math.floor(Number(url.searchParams.get('w')));
    const h = Math.floor(Number(url.searchParams.get('h')));
    await fsp.writeFile(thumbPath(id), data);
    db.run('UPDATE attachments SET thumb = ?, width = ?, height = ? WHERE id = ?', format,
      w > 0 && w <= 100000 ? w : null, h > 0 && h <= 100000 ? h : null, id);
    // Already in a message: everyone there gets the preview now.
    if (a.message_id) {
      const m = db.get('SELECT channel_id FROM messages WHERE id = ?', a.message_id);
      const c = db.get('SELECT * FROM channels WHERE id = ?', m.channel_id);
      hub.emit(ctx.chat.audience(c), 'msg-edit', { message: ctx.chat.messagesJson([db.get('SELECT * FROM messages WHERE id = ?', a.message_id)])[0] });
    }
    send(res, 204);
  }

  // GET /api/files/:id[?download]
  async function getFile(req, res, { id }, url) {
    const user = people().requireUser(req);
    const a = visibleAttachment(user, id);
    if (a.received < a.size) throw httpError(409, 'That file hasn’t finished uploading');
    const inline = INLINE.has(a.mime) && !url.searchParams.has('download');
    // (Checked again on every use, a quick 304: once a message is deleted or someone leaves its conversation, a copy in
    // their browser's cache no longer shows it; it was kept a day. 1.7.3, audit B-10)
    await sendFile(req, res, filePath(a.id), {
      type: inline ? a.mime : a.mime === 'application/octet-stream' ? a.mime : a.mime + (a.mime.startsWith('text/') ? '; charset=utf-8' : ''),
      etag: `"${a.id}.${a.size}"`,
      headers: {
        'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', a.name),
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
        'Cache-Control': 'private, no-cache',
      },
    });
  }

  // GET /api/files/:id/thumb
  async function getThumb(req, res, { id }) {
    const user = people().requireUser(req);
    const a = visibleAttachment(user, id);
    if (!a.thumb) throw httpError(404, 'No preview');
    await sendFile(req, res, thumbPath(a.id), { type: `image/${a.thumb}`, etag: `"${a.id}.t"`, headers: { 'Cache-Control': 'private, no-cache', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
  }

  // PUT /api/me/avatar (a square JPEG, WebP or PNG from the app, at most 512 KB); DELETE /api/me/avatar
  async function putAvatar(req, res) {
    const user = people().requireUser(req);
    if (req.method === 'DELETE') {
      if (user.avatar) await fsp.rm(path.join(dirs.avatars, user.avatar), { force: true });
      db.run('UPDATE users SET avatar = NULL WHERE id = ?', user.id);
    } else {
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const ext = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' }[type];
      if (!ext) throw httpError(415, 'Send the picture as JPEG, WebP or PNG');
      const data = await readBody(req, MAX_AVATAR);
      const ok = ext === 'jpg' ? data[0] === 0xff && data[1] === 0xd8 : ext === 'png' ? data.toString('latin1', 1, 4) === 'PNG'
        : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
      if (!ok) throw httpError(400, 'That isn’t the picture it says it is');
      const file = `${user.id}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
      await fsp.writeFile(path.join(dirs.avatars, file), data);
      if (user.avatar) await fsp.rm(path.join(dirs.avatars, user.avatar), { force: true });
      db.run('UPDATE users SET avatar = ? WHERE id = ?', file, user.id);
    }
    const updated = people().getUser(user.id);
    hub.emit(null, 'people', { person: people().personJson(updated) });
    send(res, 200, { me: people().personJson(updated, updated) });
  }

  // GET /api/people/:id/avatar
  async function getAvatar(req, res, { id }) {
    people().requireUser(req);
    const u = people().getUser(id);
    if (!u?.avatar) throw httpError(404, 'No picture');
    const type = { jpg: 'image/jpeg', webp: 'image/webp', png: 'image/png' }[path.extname(u.avatar).slice(1)] || 'application/octet-stream';
    await sendFile(req, res, path.join(dirs.avatars, u.avatar), { type, headers: { 'Cache-Control': 'private, max-age=604800, immutable', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
  }

  async function removeStored(a) {
    await Promise.all([filePath(a.id), partPath(a.id), thumbPath(a.id)].map(f => fsp.rm(f, { force: true })));
  }

  // Files uploaded but never sent go after a day, counted from the last piece that came (1.7.2: from the start, so a
  // big upload paused overnight went mid-way).
  function sweepUnsent() {
    const cutoff = now() - UNSENT_HOURS * 3600e3;
    const old = db.all('SELECT * FROM attachments WHERE message_id IS NULL AND created_at < ?', cutoff).filter(a => {
      try { return fs.statSync(a.received < a.size ? partPath(a.id) : filePath(a.id)).mtimeMs < cutoff; } catch { return true; }
    });
    for (const a of old) {
      db.run('DELETE FROM attachments WHERE id = ?', a.id);
      removeStored(a).catch(() => {});
    }
    if (old.length) log.info(`Removed ${old.length} file${old.length === 1 ? '' : 's'} uploaded but never sent`);
  }
  setInterval(sweepUnsent, 3600e3).unref();
  setTimeout(sweepUnsent, 60e3).unref();

  // (1.7.2) A crash between recording an upload's last piece and moving it into place: move it now.
  for (const a of db.all('SELECT id FROM attachments WHERE received >= size AND size > 0')) {
    if (!fs.existsSync(filePath(a.id)) && fs.existsSync(partPath(a.id))) {
      try { fs.renameSync(partPath(a.id), filePath(a.id)); log.info(`Finished moving an upload a restart interrupted (${a.id})`); } catch {}
    }
  }

  return {
    attachmentJson, removeStored, storageUsed, sweepUnsent,
    routes: [
      ['POST', '/api/uploads', startUpload],
      ['GET', '/api/uploads', listUnsent],
      ['GET', '/api/uploads/:id', uploadState],
      ['PUT', '/api/uploads/:id', putPiece],
      ['DELETE', '/api/uploads/:id', cancelUpload],
      ['PUT', '/api/files/:id/thumb', putThumb],
      ['GET', '/api/files/:id', getFile],
      ['GET', '/api/files/:id/thumb', getThumb],
      ['PUT', '/api/me/avatar', putAvatar],
      ['DELETE', '/api/me/avatar', putAvatar],
      ['GET', '/api/people/:id/avatar', getAvatar],
    ],
  };
}

module.exports = { createFiles, mimeFor, cleanFileName, INLINE };
