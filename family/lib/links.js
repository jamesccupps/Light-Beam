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
    return a;
  }

  function counted(link) {
    if (link) db.run('UPDATE links SET downloads = downloads + 1 WHERE id = ?', link.id);
  }

  const json = (l, extra = {}) => ({ id: l.id, created: l.created_at, expires: l.expires_at, downloads: l.downloads, by: l.created_by, ...extra });

  // POST /api/files/:id/links { hours } → 201 { link: { id, url, expires, … } }: a file the person may see (one in a
  // message they can read, or their own still being uploaded). The url is shown once: only its hash is kept.
  async function create(req, res, { id }) {
    const user = people().requireUser(req);
    const body = await readJson(req);
    const a = files().visibleAttachment(user, id);
    const hours = body.hours === undefined ? 24 : Math.round(Number(body.hours));
    if (!(hours >= 1 && hours <= MAX_HOURS)) throw httpError(400, `A fast link lasts 1 hour to ${MAX_HOURS / 24} days`);
    if (db.get('SELECT count(*) n FROM links WHERE created_by = ? AND revoked_at IS NULL AND expires_at > ?', user.id, now()).n >= 50) {
      throw httpError(429, 'You have 50 fast links working: switch some off first');
    }
    const token = crypto.randomBytes(24).toString('base64url');
    const l = { id: newId(), token_hash: hashOf(token), attachment_id: a.id, created_by: user.id, created_at: now(), expires_at: now() + hours * HOUR, revoked_at: null, downloads: 0 };
    db.run('INSERT INTO links (id, token_hash, attachment_id, created_by, created_at, expires_at, downloads) VALUES (?, ?, ?, ?, ?, ?, 0)',
      l.id, l.token_hash, l.attachment_id, l.created_by, l.created_at, l.expires_at);
    log.info(`${user.name} made a fast link to ${a.name} (${hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`})`);
    send(res, 201, { link: json(l, { url: urlOf(token) }) });
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
    send(res, 200, {
      name: a.name, size: a.size, mime: a.mime, received: Math.min(a.received, a.size), from: nameOf(l.created_by),
      // (how the page finds a direct way: the same STUN servers as this end; none when direct connections are off)
      expires: l.expires_at, preview: Boolean(a.thumb), direct: ctx.direct?.enabled ? { stun: config.stun || [] } : null,
      // (1.10.0) a video: its version that plays everywhere (play, playUrl, playSize, playProgress)
      video: Boolean(ctx.media?.isVideo(a)), ...ctx.media?.stateOf(a, `/api/links/${token}`),
    }, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  }

  // GET /api/links/:token/play[?download]: a video's version that plays everywhere, to watch in the page or to keep
  // (1.10.0).
  async function play(req, res, { token }, url) {
    const { l, a } = open(req, token);
    if (url.searchParams.has('download') && (!req.headers.range || /^bytes=0-/.test(String(req.headers.range)))) counted(l);
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
    if (a.received >= a.size) {
      if (!req.headers.range || /^bytes=0-/.test(String(req.headers.range))) counted(l);
      return sendFile(req, res, files().filePath(a.id), { type, etag: `"${a.id}.${a.size}"`, headers });
    }
    // Still arriving: from the start (or a part from N on), followed until it's all there.
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
        if (!res.write(piece)) await new Promise(r => { res.once('drain', r); res.once('close', r); });
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
    const body = await readJson(req);
    send(res, 200, { sdp: await ctx.direct.answer(body.sdp, `link:${l.id}`, { link: { id: l.id } }) }, { 'Cache-Control': 'no-store' });
  }

  return {
    attachmentOf, counted,
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
