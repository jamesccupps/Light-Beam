'use strict';
// Small HTTP helpers for Beam Family: answers, request bodies, cookies, a router and the app's static files.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, extra });
}

// Set on every answer: no framing, no sniffing, no referrer leaking a channel or an invite code.
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const bodyUnread = req => Boolean(req) && !req.complete && (Number(req.headers['content-length']) > 0 || 'transfer-encoding' in req.headers);

// Sends an answer; objects go as JSON. Only the first call for a response counts.
function send(res, status, body = '', headers = {}) {
  if (res.famSent || res.writableEnded) return;
  res.famSent = true;
  let payload = body;
  headers = { ...BASE_HEADERS, 'Cache-Control': 'no-store', ...headers };
  if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) {
    payload = JSON.stringify(body);
    headers['Content-Type'] ??= 'application/json; charset=utf-8';
    if (payload.length > 1024 && /\bgzip\b/.test(String(res.req?.headers['accept-encoding'] || '')) && res.req?.method !== 'HEAD') {
      payload = zlib.gzipSync(payload);
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
    }
  }
  if (bodyUnread(res.req)) headers.Connection = 'close'; // a refused upload isn't read to the end
  if (status !== 204 && status !== 304 && payload !== '' && headers['Content-Length'] === undefined) headers['Content-Length'] = Buffer.byteLength(payload);
  res.writeHead(status, headers);
  res.end(res.req?.method === 'HEAD' ? undefined : payload);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'That is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const isJsonType = req => /^application\/json\b/i.test(String(req.headers['content-type'] || '').trim());

// A JSON object body. Every caller is signed in by a cookie or Tailscale's identity, both of which a browser sends by
// itself: requiring the JSON content type means another site can't send it without the browser asking first (and
// this server never says yes).
async function readJson(req, { limit = 64 * 1024, optional = false } = {}) {
  if (!isJsonType(req) && !(optional && !bodyUnread(req) && !Number(req.headers['content-length']))) {
    throw httpError(415, 'Send JSON (Content-Type: application/json)');
  }
  const text = (await readBody(req, limit)).toString('utf8');
  if (!text.trim()) {
    if (optional) return {};
    throw httpError(400, 'Expected a JSON object');
  }
  let value;
  try { value = JSON.parse(text); } catch { throw httpError(400, 'Invalid JSON'); }
  if (!isPlainObject(value)) throw httpError(400, 'Expected a JSON object');
  return value;
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const value = part.slice(i + 1).trim();
    try { out[part.slice(0, i).trim()] = decodeURIComponent(value); } catch { out[part.slice(0, i).trim()] = value; }
  }
  return out;
}

function cookie(name, value, { maxAge, secure }) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${maxAge !== undefined ? `; Max-Age=${maxAge}` : ''}${secure ? '; Secure' : ''}`;
}

// Routes: [method, '/api/things/:id', handler]. Handlers get (req, res, params, url).
function createRouter(routes) {
  const compiled = routes.map(([method, pattern, handler]) => {
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:([a-z]+)/gi, (_, name) => { names.push(name); return '([^/]+)'; }) + '$');
    return { method, re, names, handler };
  });
  return function match(method, pathname) {
    let allowed = null;
    for (const r of compiled) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) { allowed = (allowed || []).concat(r.method); continue; }
      const params = {};
      r.names.forEach((name, i) => {
        try { params[name] = decodeURIComponent(m[i + 1]); } catch { params[name] = m[i + 1]; }
      });
      return { handler: r.handler, params };
    }
    return allowed ? { allowed } : null;
  };
}

// ---------------------------------------------------------------- the app's files

const TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8', webmanifest: 'application/manifest+json; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', woff2: 'font/woff2', txt: 'text/plain; charset=utf-8',
};

// The page may only load its own scripts and styles; pictures also from blob: (previews of what's being sent).
const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; " +
  "connect-src 'self'; worker-src 'self'; manifest-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function createStatic(root) {
  const cache = new Map(); // path -> { body, gz, etag, type }
  async function load(file) {
    const stat = await fsp.stat(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
    const body = await fsp.readFile(file);
    const ext = path.extname(file).slice(1).toLowerCase();
    const entry = {
      body, mtimeMs: stat.mtimeMs, size: stat.size, type: TYPES[ext] || 'application/octet-stream',
      etag: '"' + crypto.createHash('sha256').update(body).digest('base64url').slice(0, 22) + '"',
      gz: /^(html|js|css|json|webmanifest|svg|txt)$/.test(ext) ? zlib.gzipSync(body) : null,
    };
    cache.set(file, entry);
    return entry;
  }

  // Serves `rel` (a path inside root), or the app's index.html for the app's own routes. Returns false if missing.
  return async function serve(req, res, rel, { fallback = null } = {}) {
    let file = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    if (!file.startsWith(root + path.sep) && file !== root) return false;
    let entry = null;
    try { if ((await fsp.stat(file)).isFile()) entry = await load(file); } catch {}
    if (!entry && fallback) {
      file = path.join(root, fallback);
      try { entry = await load(file); } catch {}
    }
    if (!entry) return false;
    const html = entry.type.startsWith('text/html');
    const headers = {
      ...BASE_HEADERS,
      'Content-Type': entry.type,
      ETag: entry.etag,
      // The app's own files are checked every time (an ETag makes that a quick 304), so a new version never mixes with
      // pieces of the old one; only pictures may be kept for a day.
      'Cache-Control': /^image\//.test(entry.type) ? 'public, max-age=86400' : 'no-cache',
      Vary: 'Accept-Encoding',
    };
    if (html) Object.assign(headers, { 'Content-Security-Policy': APP_CSP, 'Cross-Origin-Opener-Policy': 'same-origin' });
    if (rel === 'sw.js') headers['Service-Worker-Allowed'] = '/';
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    const gzip = entry.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const body = gzip ? entry.gz : entry.body;
    if (gzip) headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}

function contentDisposition(type, name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name.toWellFormed()).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// A file from disk, with Range support (videos seek). `headers` are added to the answer.
async function sendFile(req, res, file, { type, headers = {}, size = null }) {
  let stat;
  try { stat = await fsp.stat(file); } catch { return send(res, 404, { error: 'Not found' }); }
  const total = size ?? stat.size;
  const base = { ...BASE_HEADERS, 'Content-Type': type, 'Accept-Ranges': 'bytes', ...headers };
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  let start = 0;
  let end = total - 1;
  if (range && total > 0) {
    if (range[1] === '' && range[2] !== '') start = Math.max(0, total - Number(range[2]));
    else {
      start = Number(range[1]);
      if (range[2] !== '') end = Math.min(end, Number(range[2]));
    }
    if (start > end || start >= total) {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${total}` });
      return res.end();
    }
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 });
  } else {
    res.writeHead(200, { ...base, 'Content-Length': total });
  }
  if (req.method === 'HEAD' || total === 0) return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

module.exports = { httpError, send, readBody, readJson, isJsonType, parseCookies, cookie, createRouter, createStatic, sendFile, contentDisposition, isPlainObject, BASE_HEADERS };
