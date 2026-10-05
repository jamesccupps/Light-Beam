'use strict';
// Fast links (1.9.0; the user: "we need a temporary fastlink too, that works on any network"; "can the fast link be
// downloaded by someone without a family user account? like if i jsut need to send someone a large file"; "there should
// be a way to send a fast link from a file thats already in the chat"): a file of Beam Family's for anyone who has the
// link, no sign-in, until it expires or is switched off. Its page fetches the file straight from this machine when it
// can (a direct connection, lib/direct.js), else over https through the public link; "Download in the background" is
// https too, for the phone's own download manager. A file still being uploaded can be linked already: the link follows
// it as it arrives. Only the hash of a link's secret is kept: the secret is in the link alone.

const crypto = require('node:crypto');
const { newId, isId } = require('./ids');
const { httpError, send, readJson, sendFile, contentDisposition, BASE_HEADERS } = require('./http');
const { createLimiter, clientIp } = require('./auth');

const now = () => Date.now();
const HOUR = 3600e3;
const MAX_HOURS = 30 * 24;
const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const hashOf = token => crypto.createHash('sha256').update(token).digest('hex');
// (the file itself never runs as a page: no scripts, a sandbox, as every file Family serves)
const FILE_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox";

function createLinks(ctx) {
  const { db, log, config } = ctx;
  const people = () => ctx.people;
  const files = () => ctx.files;
  // Guessing at links: 30 wrong ones a minute from one address, then a wait. (A secret is 192 bits: this only keeps
  // the noise down.)
  const misses = createLimiter({ limit: 30, windowMs: 60e3 });

  const urlOf = token => `${config.publicUrl || ''}/f/${token}`;
  const nameOf = id => (id && people().getUser?.(id)?.name) || db.get('SELECT name FROM users WHERE id = ?', id || '')?.name || 'Someone';

  // A link's secret → { l, a } while it works (not expired or off, its file still here); else a 404, counted.
  function open(req, token) {
    const ip = clientIp(req);
    if (misses.blocked(ip)) throw httpError(429, 'Too many tries: wait a minute');
    const l = TOKEN.test(String(token)) ? db.get('SELECT * FROM links WHERE token_hash = ?', hashOf(token)) : null;
    const a = l && !l.revoked_at && l.expires_at > now() ? db.get('SELECT * FROM attachments WHERE id = ?', l.attachment_id) : null;
    if (!a) {
      misses.hit(ip);
      throw httpError(404, 'This link doesn’t work any more: it expired, or it was switched off');
    }
    return { l, a };
  }

  // For lib/direct.js: what a link's visitor may read (only the link's file).
  function attachmentOf(link, fileId) {
    const l = db.get('SELECT * FROM links WHERE id = ?', link.id);
    const a = l && !l.revoked_at && l.expires_at > now() ? db.get('SELECT * FROM attachments WHERE id = ?', l.attachment_id) : null;
    if (!a || (fileId && fileId !== a.id)) throw httpError(404, 'Not found');
    if (l.clean) throw httpError(403, 'This link shares a copy without location data: over https only'); // (1.15.0)
    return a;
  }

  // (1.15.0) A link with at most so many downloads: none left once they're used (a download already going on, picked
  // up again with a range, isn't a new one).
  const usedUp = l => l.max_downloads != null && l.downloads >= l.max_downloads;
  function mayStart(link) {
    const l = db.get('SELECT * FROM links WHERE id = ?', link.id);
    if (l && usedUp(l)) throw httpError(410, USED_UP);
  }
  const USED_UP = 'This link has been used up: it was downloaded as many times as its sender allowed';

  // { maxDownloads, clean } from a request body: at most 1–1000 downloads (none: no limit), and the copy without
  // location data (photos and videos; lib/clean.js says which).
  function optionsOf(body) {
    const raw = body.maxDownloads;
    const maxDownloads = raw === undefined || raw === null || raw === 0 ? null : Math.round(Number(raw));
    if (maxDownloads !== null && !(maxDownloads >= 1 && maxDownloads <= 1000)) throw httpError(400, 'A fast link can stop after 1 to 1,000 downloads');
    return { maxDownloads, clean: body.removeLocation === true };
  }

  function counted(link) {
    if (link) db.run('UPDATE links SET downloads = downloads + 1 WHERE id = ?', link.id);
  }

  const json = (l, extra = {}) => ({ id: l.id, created: l.created_at, expires: l.expires_at, downloads: l.downloads, by: l.created_by,
    maxDownloads: l.max_downloads ?? null, removeLocation: Boolean(l.clean), ...extra });

  // Whether `user` may make another link lasting `hours`: throws why not.
  function checkNew(user, hours, options = {}, file = null) {
    if (!(hours >= 1 && hours <= MAX_HOURS)) throw httpError(400, `A fast link lasts 1 hour to ${MAX_HOURS / 24} days`);
    if (options.clean && file && !ctx.clean.supported(file)) throw httpError(400, cleanable());
    if (db.get('SELECT count(*) n FROM links WHERE created_by = ? AND revoked_at IS NULL AND expires_at > ?', user.id, now()).n >= 50) {
      throw httpError(429, 'You have 50 fast links working: switch some off first');
    }
  }

  // POST /api/files/:id/links { hours } → 201 { link: { id, url, expires, … } }: a file the person may see (one in a
  // message they can read, or their own still being uploaded).
  async function create(req, res, { id }) {
    const user = people().requireUser(req);
    const body = await readJson(req);
    const a = files().visibleAttachment(user, id);
    const hours = body.hours === undefined ? 24 : Math.round(Number(body.hours));
    send(res, 201, { link: createFor(a, user, hours, optionsOf(body)) });
  }

  // What can lose its location data here (1.15.0).
  const cleanable = () => `Location data can be taken out of JPEG and PNG photos${ctx.media?.ffmpeg?.() ? ' and of videos' : ''}, not this kind of file`;

  // A link to attachment `a` made by `user` (1.13.0: also Beam's, through the admin API) → its JSON with the url, shown
  // this once: only its hash is kept.
  function createFor(a, user, hours, options = {}) {
    checkNew(user, hours, options, a);
    // (the copy without location data is made from the whole file)
    if (options.clean && a.received < a.size) throw httpError(409, 'Wait until the file is all uploaded to share it without location data');
    const token = crypto.randomBytes(24).toString('base64url');
    const l = { id: newId(), token_hash: hashOf(token), attachment_id: a.id, created_by: user.id, created_at: now(), expires_at: now() + hours * HOUR, revoked_at: null, downloads: 0,
      max_downloads: options.maxDownloads ?? null, clean: options.clean ? 1 : 0 };
    db.run('INSERT INTO links (id, token_hash, attachment_id, created_by, created_at, expires_at, downloads, max_downloads, clean) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
      l.id, l.token_hash, l.attachment_id, l.created_by, l.created_at, l.expires_at, l.max_downloads, l.clean);
    if (l.clean) ctx.clean.ensure(a); // (made now, so it's ready when someone opens the link)
    const extras = [l.max_downloads ? `at most ${l.max_downloads} download${l.max_downloads > 1 ? 's' : ''}` : '', l.clean ? 'without location data' : ''].filter(Boolean);
    log.info(`${user.name} made a fast link to ${a.name} (${hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`}${extras.length ? `, ${extras.join(', ')}` : ''})`);
    return json(l, { url: urlOf(token) });
  }

  // GET /api/files/:id/links → { links }: the ones working (an admin sees everyone's, others their own).
  function list(req, res, { id }) {
    const user = people().requireUser(req);
    const a = files().visibleAttachment(user, id);
    const admin = user.role === 'owner' || user.role === 'admin';
    const rows = db.all('SELECT * FROM links WHERE attachment_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC', a.id, now())
      .filter(l => admin || l.created_by === user.id);
    send(res, 200, { links: rows.map(l => json(l, { byName: nameOf(l.created_by) })) });
  }

  // DELETE /api/links/:id: switched off (by whoever made it, or an admin).
  function revoke(req, res, { id }) {
    const user = people().requireUser(req);
    const l = isId(id) ? db.get('SELECT * FROM links WHERE id = ?', id) : null;
    const admin = user.role === 'owner' || user.role === 'admin';
    if (!l || (l.created_by !== user.id && !admin)) throw httpError(404, 'Not found');
    if (!l.revoked_at) db.run('UPDATE links SET revoked_at = ? WHERE id = ?', now(), l.id);
    ctx.direct?.closeLink?.(l.id);
    send(res, 204);
  }

  // GET /api/links/:token → what the link's page shows (no sign-in): the file's name, size, kind, who shared it, how much
  // of it is here yet, until when.
  function info(req, res, { token }) {
    const { l, a } = open(req, token);
    const limit = l.max_downloads != null ? { maxDownloads: l.max_downloads, downloadsLeft: Math.max(0, l.max_downloads - l.downloads), usedUp: usedUp(l) } : {};
    const out = {
      name: a.name, size: a.size, mime: a.mime, received: Math.min(a.received, a.size), from: nameOf(l.created_by),
      // (how the page finds a direct way: the same STUN servers as this end; none when direct connections are off)
      expires: l.expires_at, preview: Boolean(a.thumb), direct: ctx.direct?.enabled ? { stun: config.stun || [] } : null,
      // (1.10.0) a video: its version that plays everywhere (play, playUrl, playSize, playProgress)
      video: Boolean(ctx.media?.isVideo(a)), ...ctx.media?.stateOf(a, `/api/links/${token}`), ...limit,
    };
    if (l.clean) {
      // (1.15.0) the copy without location data: its size once made; https only; a player only for the version that
      // plays everywhere (made without metadata too), never the original
      const state = ctx.clean.ensure(a);
      const row = db.get('SELECT clean_size FROM attachments WHERE id = ?', a.id);
      Object.assign(out, { removeLocation: true, cleaning: state, direct: null });
      if (state === 'ready') Object.assign(out, { size: row.clean_size, received: row.clean_size });
      if (out.play !== 'ready') { out.video = false; for (const k of ['play', 'playUrl', 'playSize', 'playProgress']) delete out[k]; }
    }
    send(res, 200, out, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  }

  // GET /api/links/:token/play[?download]: a video's version that plays everywhere, to watch in the page or to keep
  // (1.10.0).
  async function play(req, res, { token }, url) {
    const { l, a } = open(req, token);
    if (l.clean && a.play !== 'ready') throw httpError(404, 'Not found'); // (1.15.0: never the original)
    if (url.searchParams.has('download') && (!req.headers.range || /^bytes=0-/.test(String(req.headers.range)))) {
      if (usedUp(l)) throw httpError(410, USED_UP);
      counted(l);
    }
    await ctx.media.sendPlay(req, res, a, url, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  }

  // GET /api/links/:token/file: the file over https (the phone's download manager can take it and go on in the
  // background); a part, or one still arriving (followed as it comes).
  async function file(req, res, { token }) {
    const { l, a } = open(req, token);
    const headers = {
      'Content-Disposition': contentDisposition('attachment', a.name),
      'Content-Security-Policy': FILE_CSP,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    };
    const type = a.mime === 'application/octet-stream' ? a.mime : a.mime + (a.mime.startsWith('text/') ? '; charset=utf-8' : '');
    const range = /^bytes=(\d+)-$/.exec(String(req.headers.range || ''));
    // (1.15.0) a new download (not one picked up again) takes one of the link's downloads, if it has a limit
    const starting = !req.headers.range || /^bytes=0-/.test(String(req.headers.range));
    if (starting && usedUp(l)) throw httpError(410, USED_UP);
    if (l.clean) {
      // (1.15.0) the copy without location data, never the original
      const state = ctx.clean.ensure(a);
      if (state !== 'ready') throw httpError(503, state === 'failed' ? 'Beam Family couldn’t make a copy of it without location data' : 'It’s being made ready (without location data): try again in a moment', { retryAfter: 5 });
      if (starting) counted(l);
      const size = db.get('SELECT clean_size FROM attachments WHERE id = ?', a.id).clean_size;
      return sendFile(req, res, ctx.clean.pathOf(a.id), { type, etag: `"${a.id}.c${size}"`, headers });
    }
    if (a.received >= a.size) {
      if (starting) counted(l);
      return sendFile(req, res, files().filePath(a.id), { type, etag: `"${a.id}.${a.size}"`, headers });
    }
    // Still arriving: from the start (or a part from N on), followed until it's all there. (audit B-11) Another kind of
    // range (bounded, or from the end) can't be answered yet: 416, not the whole file as if it had been.
    if (req.headers.range && !range && String(req.headers.range).trim() !== 'bytes=-') {
      res.writeHead(416, { ...BASE_HEADERS, 'Content-Range': `bytes */${a.size}`, 'Cache-Control': 'no-store' });
      return res.end();
    }
    const start = range ? Number(range[1]) : 0;
    if (start >= a.size) throw httpError(416, 'That’s past the end of the file');
    res.writeHead(start ? 206 : 200, {
      ...BASE_HEADERS, ...headers, 'Content-Type': type, 'Accept-Ranges': 'bytes', ETag: `"${a.id}.${a.size}"`,
      'Content-Length': a.size - start, ...(start && { 'Content-Range': `bytes ${start}-${a.size - 1}/${a.size}` }),
    });
    if (req.method === 'HEAD') return res.end();
    if (!start) counted(l);
    let closed = false;
    res.on('close', () => { closed = true; });
    let sent = start;
    try {
      for await (const piece of files().readFollowing(a, start, { isClosed: () => closed })) {
        if (closed) break;
        sent += piece.length;
        if (!res.write(piece)) {
          await new Promise(r => {
            const go = () => { res.off('drain', go); res.off('close', go); r(); };
            res.once('drain', go);
            res.once('close', go);
          });
        }
      }
    } catch (err) {
      log.info(`A fast link's download of ${a.name} stopped: ${err.message}`);
    }
    if (sent >= a.size) res.end(); else res.destroy();
  }

  // GET /api/links/:token/preview: the picture or video's preview, if the sender's app made one.
  async function preview(req, res, { token }) {
    const { a } = open(req, token);
    if (!a.thumb) throw httpError(404, 'No preview');
    await sendFile(req, res, files().thumbPath(a.id), { type: `image/${a.thumb}`, headers: { 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
  }

  // POST /api/links/:token/direct { sdp } → { sdp }: a direct connection for the link's visitor (only its file).
  async function direct(req, res, { token }) {
    const { l } = open(req, token);
    // (1.15.0) a link sharing a copy without location data is https only (the direct way reads the original)
    if (l.clean) throw httpError(403, 'This link shares a copy without location data: over https only');
    const body = await readJson(req);
    send(res, 200, { sdp: await ctx.direct.answer(body.sdp, `link:${l.id}`, { link: { id: l.id } }) }, { 'Cache-Control': 'no-store' });
  }

  return {
    attachmentOf, counted, checkNew, createFor, optionsOf, mayStart,
    routes: [
      ['POST', '/api/files/:id/links', create],
      ['GET', '/api/files/:id/links', list],
      ['DELETE', '/api/links/:id', revoke],
      ['GET', '/api/links/:token', info],
      ['GET', '/api/links/:token/file', file],
      ['GET', '/api/links/:token/preview', preview],
      ['GET', '/api/links/:token/play', play],
      ['POST', '/api/links/:token/direct', direct],
    ],
  };
}

module.exports = { createLinks };
