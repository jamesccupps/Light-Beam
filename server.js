#!/usr/bin/env node
// Beam: a private hub for sending text and files between your own devices.
// Items are sent to one device, several, or all of them; the server holds them until each target picks them
// up. docs/API.md describes the protocol (API v3). `node server.js help` lists the maintenance commands.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const zlib = require('node:zlib');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const QRCode = require('qrcode');
const tar = require('./lib/tar');
const tailscale = require('./lib/tailscale');
const { createLogger } = require('./lib/log');
const { writeFileDurable, writeFileDurableSync, loadState, jsonWriter, storeStats, syncDir } = require('./lib/store');
const { createOutbound } = require('./lib/outbound');
const { makePrivate } = require('./lib/private-dir');
const pcHistory = require('./lib/history');
const winevents = require('./lib/winevents');
const winsetup = require('./lib/winsetup');
const appsLib = require('./lib/apps');
const ws = require('./lib/websocket');
const { version: VERSION } = require('./package.json');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const API_VERSION = 3;
const scrypt = promisify(crypto.scrypt);
const INSTANCE_ID = crypto.randomBytes(8).toString('hex'); // tells a move target apart from this very process

// ---------------------------------------------------------------- config

const env = process.env;
const num = (v, fallback) => (v === undefined || v === '' || isNaN(Number(v)) ? fallback : Number(v));
const isSet = v => v !== undefined && v !== '';
const trimUrl = s => String(s || '').trim().replace(/\/+$/, '');
const MB = 1024 * 1024;

// (1.7) Beam Family's address (a separate server; see family/): an http(s) address, else nothing.
const FAMILY_URL = /^https?:\/\/[^\s/]+(\/\S*)?$/i.test(trimUrl(env.BEAM_FAMILY_URL)) ? trimUrl(env.BEAM_FAMILY_URL) : null;
// (1.13.0) Beam Family on this machine, for fast links of Beam's files: its data folder (its control.key) and its local
// address, as Beam Family reads them from the same .env.
const FAMILY_DATA = path.resolve(env.BEAM_FAMILY_DATA || path.join(__dirname, 'family-data'));
const FAMILY_LOCAL = (() => {
  const host = env.BEAM_FAMILY_HOST || '127.0.0.1';
  const h = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return `http://${h.includes(':') ? `[${h}]` : h}:${num(env.BEAM_FAMILY_PORT, 8766)}`;
})();
const PORT = num(env.BEAM_PORT, 8765);
const HOST = env.BEAM_HOST || '0.0.0.0';
const DATA_DIR = path.resolve(env.BEAM_DATA || path.join(__dirname, 'data'));
const DIR = {
  files: path.join(DATA_DIR, 'files'),
  texts: path.join(DATA_DIR, 'texts'),
  thumbs: path.join(DATA_DIR, 'thumbs'),
  uploads: path.join(DATA_DIR, 'uploads'),
  logs: path.join(DATA_DIR, 'logs'),
  orphaned: path.join(DATA_DIR, 'orphaned'),
  appFiles: path.join(DATA_DIR, 'app-files'), // (1.21) the apps' files, one folder per app
};
const FILE = {
  items: path.join(DATA_DIR, 'items.json'),
  devices: path.join(DATA_DIR, 'devices.json'),
  aliases: path.join(DATA_DIR, 'aliases.json'),
  password: path.join(DATA_DIR, 'password.json'),
  tokens: path.join(DATA_DIR, 'tokens.json'),
  read: path.join(DATA_DIR, 'read.json'),
  settings: path.join(DATA_DIR, 'settings.json'),
  key: path.join(DATA_DIR, 'key'),
  serverId: path.join(DATA_DIR, 'server-id'),
  pid: path.join(DATA_DIR, 'server.pid'),
  stop: path.join(DATA_DIR, 'stop-requested'),
  alerts: path.join(DATA_DIR, 'alerts.json'),
  history: path.join(DATA_DIR, 'history.json'), // (1.18) each device's history
  apps: path.join(DATA_DIR, 'apps.json'), // (1.21) the user's apps, and where each is installed
};
const PUBLIC_DIR = path.join(__dirname, 'public');
const DIST_DIR = path.resolve(env.BEAM_DIST || path.join(__dirname, 'dist'));
const MAX_UPLOAD = num(env.BEAM_MAX_UPLOAD_MB, 4096) * MB;
const MAX_STORAGE = num(env.BEAM_MAX_STORAGE_GB, 0) * 1024 * MB; // 0 = no limit besides the disk
// (1.8.1) Backups of this server: an export every BEAM_BACKUP_HOURS (0: none) into BEAM_BACKUP_DIR (default: a
// "backups" folder next to the data folder, or in it when the data folder is at a drive's root), the newest
// BEAM_BACKUP_KEEP kept; item files go in while they add up to at most BEAM_BACKUP_FILES_MB.
const BACKUP_DIR = path.resolve(env.BEAM_BACKUP_DIR || (() => {
  const parent = path.dirname(DATA_DIR);
  return parent === path.parse(parent).root ? path.join(DATA_DIR, 'backups') : path.join(parent, 'backups');
})());
const BACKUP_HOURS = Math.max(0, num(env.BEAM_BACKUP_HOURS, 24));
const BACKUP_KEEP = Math.max(1, Math.floor(num(env.BEAM_BACKUP_KEEP, 14)));
const BACKUP_FILES = Math.max(0, num(env.BEAM_BACKUP_FILES_MB, 1024)) * MB;
const MAX_TEXT = 5 * MB;
const INLINE_TEXT_LIMIT = 64 * 1024; // longer texts live in data/texts, not in items.json
const LIST_TEXT_LIMIT = 16 * 1024; // texts are cut to this in lists and live events
const CHUNK_SIZE = Math.max(1, num(env.BEAM_CHUNK_MB, 8)) * MB;
// A PUT may carry the whole rest of a file: an interrupted one keeps every byte that arrived (the client asks for
// the offset and goes on), so big chunks cost nothing in safety and save a round trip per chunk.
const MAX_CHUNK = MAX_UPLOAD;
const MAX_THUMB = 256 * 1024;
const DISK_MARGIN = 100 * MB;
const FAST_TIMEOUTS = env.BEAM_TEST_TIMEOUTS === '1'; // test/server.test.js shrinks the timeouts below
const UPLOAD_IDLE_MS = 24 * 3600e3;
const BODY_IDLE_MS = FAST_TIMEOUTS ? 2000 : 60_000;
const REQUEST_TIMEOUT_MS = FAST_TIMEOUTS ? 2000 : 30_000;
const TAKEOVER_IDLE_MS = FAST_TIMEOUTS ? 1500 : 30_000;
const SSE_MAX_QUEUED = MB;
const SESSION_IDLE_MS = 12 * 3600e3;
const PAIRING_TTL = 15 * 60e3;
const HANDOFF_TTL = 10 * 60e3;
const LOGIN_TTL = 5 * 60e3;
const MOVE_FREEZE_MS = 30 * 60e3;
const UNAUTH_PER_IP = 20;
const MAX_CONNECTIONS = num(env.BEAM_MAX_CONNECTIONS, 1000);
const REQUIRE_DATA = env.BEAM_REQUIRE_DATA === '1';
const LAN_REACHABLE = !/^(127\.|localhost$|::1$)/i.test(HOST);
const EXIT_FATAL = 78; // a setup problem: the supervisor doesn't restart the server
const OFFLINE_ALERT_MS = FAST_TIMEOUTS ? 1500 : 10 * 60e3; // how long a watched device may be offline before an alert
const SERVER_DISK_REPEAT_MS = 12 * 3600e3;
const MAX_ALERTS = 100;
const NTFY_URL = env.BEAM_NTFY || '';
const NTFY_TOKEN = env.BEAM_NTFY_TOKEN || '';
const NTFY_PREVIEW = env.BEAM_NTFY_PREVIEW === '1';
const NTFY_SKIP = new Set((env.BEAM_NTFY_SKIP || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

// Settings live in data/settings.json and can be changed from any signed-in device; environment variables win.
const ENV_SETTINGS = {
  movedTo: isSet(env.BEAM_MOVED_TO) ? trimUrl(env.BEAM_MOVED_TO) : undefined,
  publicUrl: isSet(env.BEAM_PUBLIC_URL) ? trimUrl(env.BEAM_PUBLIC_URL) : undefined,
  tailscaleSignIn: isSet(env.BEAM_TAILSCALE_SIGNIN) ? env.BEAM_TAILSCALE_SIGNIN !== '0' : undefined,
  retentionDays: isSet(env.BEAM_RETENTION_DAYS) ? num(env.BEAM_RETENTION_DAYS, 14) : undefined,
  maxItems: isSet(env.BEAM_MAX_ITEMS) ? num(env.BEAM_MAX_ITEMS, 500) : undefined,
};
const ENV_NAMES = { movedTo: 'BEAM_MOVED_TO', publicUrl: 'BEAM_PUBLIC_URL', tailscaleSignIn: 'BEAM_TAILSCALE_SIGNIN', retentionDays: 'BEAM_RETENTION_DAYS', maxItems: 'BEAM_MAX_ITEMS' };
const SETTING_DEFAULTS = { movedTo: '', publicUrl: '', tailscaleSignIn: true, retentionDays: 14, maxItems: 500 };
const ENV_OWNERS = (env.BEAM_TAILSCALE_OWNERS || '').split(',').map(normalizeLogin).filter(Boolean);

// (1.22) beam-linux.js: Beam for Linux (the command-line client made by linux/build.mjs, signed like Beam.exe)
const APPS = { windows: 'Beam.exe', android: 'beam.apk', linux: 'beam-linux.js' };

const MIME = {
  html: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  webmanifest: 'application/manifest+json', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', log: 'text/plain',
  xml: 'application/xml', pdf: 'application/pdf', zip: 'application/zip', '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar', gz: 'application/gzip', tar: 'application/x-tar', apk: 'application/vnd.android.package-archive',
  exe: 'application/vnd.microsoft.portable-executable', msi: 'application/x-msi', dmg: 'application/x-apple-diskimage',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
};

const log = createLogger({ maxBytes: 5 * 1024 * 1024, keep: 5 });

// ---------------------------------------------------------------- small helpers

const now = () => Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256hex = s => crypto.createHash('sha256').update(s).digest('hex');
const sha256raw = s => crypto.createHash('sha256').update(s).digest();
const randomSecret = (prefix, bytes = 32) => prefix + crypto.randomBytes(bytes).toString('base64url');

function normalizeLogin(login) {
  return String(login || '').trim().toLowerCase();
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

// Whether the request accepts a content coding (Accept-Encoding, honouring q=0).
function accepts(req, coding) {
  const header = String(req?.headers['accept-encoding'] || '');
  for (const part of header.split(',')) {
    const [name, ...params] = part.split(';');
    if (name.trim().toLowerCase() !== coding) continue;
    const q = params.map(x => /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(x)?.[1]).find(v => v !== undefined);
    return q === undefined || Number(q) > 0;
  }
  return false;
}

const GZIP_MIN = 1024; // smaller JSON isn't worth compressing
const GZIP_SYNC_MAX = 64 * 1024; // bigger bodies are compressed on the thread pool, not the event loop

// An answer to a request whose body hasn't all arrived (a refused upload chunk, a 401 before reading…) closes the
// connection once it is sent, so the client stops sending: Node would otherwise read and discard the whole body,
// which for a refused 64 MB chunk is 64 MB of wasted upload.
const bodyUnread = req => Boolean(req) && !req.complete && (Number(req.headers['content-length']) > 0 || 'transfer-encoding' in req.headers);
const closeIfUnread = (res, headers) => (bodyUnread(res.req) ? { ...headers, Connection: 'close' } : headers);

// Sends a response; objects go as JSON (see sendJson). Only the first call for a response counts.
// On every API answer too (1.7.2), as files and the app's pages already had them: never sniffed as something else,
// never readable by another site's page.
const ANSWER_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' };

function send(res, status, body = '', headers = {}) {
  if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) return sendJson(res, status, JSON.stringify(body), headers);
  if (res.beamSent || res.writableEnded) return;
  res.beamSent = true;
  headers = closeIfUnread(res, { 'Cache-Control': 'no-store', ...ANSWER_HEADERS, ...headers });
  if (status !== 204 && status !== 304 && body !== '' && headers['Content-Length'] === undefined) headers['Content-Length'] = Buffer.byteLength(body);
  res.writeHead(status, headers);
  res.end(body);
}

// Sends JSON text, gzipped over 1 KB when the client takes gzip. `memo` (an object kept by the caller for the
// same text) remembers the gzipped copy, so an unchanged big answer is compressed only once.
function sendJson(res, status, text, headers = {}, memo = null) {
  if (res.beamSent || res.writableEnded) return;
  res.beamSent = true;
  headers = closeIfUnread(res, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', ...ANSWER_HEADERS, ...headers });
  if (text.length > GZIP_MIN && status !== 204 && status !== 304 && res.req?.method !== 'HEAD' && accepts(res.req, 'gzip')) {
    return sendGzipped(res, status, text, headers, memo);
  }
  // A remembered answer is kept as bytes too: a 12 MB list isn't encoded again for every client.
  const body = memo ? (memo.buf ??= Buffer.from(text)) : text;
  headers['Content-Length'] = Buffer.byteLength(body);
  res.writeHead(status, headers);
  res.end(body);
}

function sendGzipped(res, status, text, headers, memo) {
  const finish = (err, gz) => {
    if (res.destroyed || res.headersSent) return; // the client went away meanwhile
    if (err) {
      res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(text) });
      return res.end(text);
    }
    if (memo) memo.gz = gz;
    res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': gz.length });
    res.end(gz);
  };
  if (memo?.gz) return finish(null, memo.gz);
  if (text.length > GZIP_SYNC_MAX) {
    // Requests that arrive while the same answer is being compressed wait for that one (a refresh makes every
    // client ask for the new list at once).
    if (memo) {
      memo.gzipping ||= new Promise((resolve, reject) => zlib.gzip(text, (err, gz) => (err ? reject(err) : resolve(gz))));
      return memo.gzipping.then(gz => finish(null, gz), err => { memo.gzipping = null; finish(err); });
    }
    return zlib.gzip(text, finish);
  }
  let gz;
  try { gz = zlib.gzipSync(text); } catch (err) { return finish(err); }
  finish(null, gz);
}

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, extra });
}

function parseCookies(req) {
  if (req.beamCookies) return req.beamCookies; // (audit P-3) once per request
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const value = part.slice(i + 1).trim();
    try { out[part.slice(0, i).trim()] = decodeURIComponent(value); } catch { out[part.slice(0, i).trim()] = value; }
  }
  return (req.beamCookies = out);
}

async function rmQuiet(file) {
  await fsp.rm(file, { force: true }).catch(() => {});
}

// Cuts a string to at most n UTF-16 units without splitting a surrogate pair.
function cutText(s, n) {
  if (s.length <= n) return s;
  const code = s.charCodeAt(n - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

// Direction overrides can make "invoice<RLO>gpj.exe" display as "invoiceexe.jpg"; control characters don't belong.
const BIDI = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;

function cleanName(name) {
  const cleaned = String(name || '').toWellFormed().replace(/[\u0000-\u001f\u007f]/g, '').replace(BIDI, '').trim();
  return [...cleaned].slice(0, 40).join('').trim();
}

// Keeps names short enough for every file system (by code point and UTF-8 bytes), keeping the extension.
function limitName(name, maxChars = 200, maxBytes = 240) {
  const fits = s => Buffer.byteLength(s) <= maxBytes;
  let chars = [...name];
  if (chars.length <= maxChars && fits(name)) return name;
  const ext = path.extname(name);
  const keep = ext.length > 1 && ext.length <= 16 ? [...ext] : [];
  chars = chars.slice(0, chars.length - keep.length).slice(0, maxChars - keep.length);
  while (chars.length && !fits(chars.join('') + keep.join(''))) chars.pop();
  return chars.join('').replace(/[\s.]+$/, '') + keep.join('');
}

function sanitizeName(name) {
  name = String(name || '').toWellFormed()
    .split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(BIDI, '')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  name = limitName(name);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) name = '_' + name;
  return name || 'file';
}

function mimeFor(name, declared) {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (MIME[ext]) return MIME[ext];
  const type = String(declared || '').split(';')[0].trim().toLowerCase();
  if (/^[a-z]+\/[\w.+-]+$/.test(type) && !type.startsWith('multipart/') && type !== 'application/x-www-form-urlencoded' && type !== 'application/octet-stream') return type;
  return 'application/octet-stream';
}

function contentDisposition(type, name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name.toWellFormed()).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'Too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// (1.7.3, audit S-20) A text arrives whole in memory (up to MAX_TEXT): all texts on their way in together hold at
// most TEXT_BUFFER_BUDGET, so many slow or stuck senders (a client in a retry loop, say) can't fill a small server's
// memory. Beyond it a sender hears 503 and tries again.
const TEXT_BUFFER_BUDGET = 64 * MB;
let textBuffered = 0;
async function readTextBody(req) {
  const chunks = [];
  let held = 0;
  try {
    for await (const chunk of req) {
      held += chunk.length;
      textBuffered += chunk.length;
      if (held > MAX_TEXT) throw httpError(413, 'Too large');
      if (textBuffered > TEXT_BUFFER_BUDGET) throw Object.assign(httpError(503, 'Beam is busy taking in other texts. Try again in a moment.'), { headers: { 'Retry-After': '10', Connection: 'close' } });
      chunks.push(chunk);
    }
  } finally { textBuffered -= held; }
  return Buffer.concat(chunks);
}

const isJsonType = req => /^application\/json\b/i.test(String(req.headers['content-type'] || '').trim());

// JSON bodies must be objects. Cookie-authenticated requests must also say they are JSON: a cross-site page
// can't send that content type without the browser asking the server first.
async function readJson(req, { limit = 64 * 1024, optional = false } = {}) {
  const text = (await readBody(req, limit)).toString('utf8');
  if (!text.trim()) {
    if (optional) return {};
    throw httpError(400, 'Expected a JSON object');
  }
  if (authOf(req)?.source === 'cookie' && !isJsonType(req)) throw httpError(415, 'Send JSON (Content-Type: application/json)');
  let value;
  try { value = JSON.parse(text); } catch { throw httpError(400, 'Invalid JSON'); }
  if (!isPlainObject(value)) throw httpError(400, 'Expected a JSON object');
  return value;
}

// ---------------------------------------------------------------- state

const ITEM_ID = /^[a-f0-9]{16}$/;
// (never an Object.prototype name: devices, aliases and read marks are plain objects keyed by device id; 1.7.2)
const DEVICE_ID = /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z0-9_-]{8,64}$/;

let KEY = null; // the master key: the legacy credential old clients hold, and the admin credential
let SERVER_ID = null;
let items = []; // newest first
let devices = {}; // id -> { id, name, platform, firstSeen, lastSeen, machine, user, temporary? }
let aliases = {}; // merged-away device id -> the device id it became
let password = {}; // { salt, hash } once a sign-in password is set
let settings = {}; // see SETTING_DEFAULTS, plus learned values (owners, public address)
let readMarks = {}; // device id -> { conversation id or "all" -> time last read }
let tokenStore = { tokens: {}, pairing: {} }; // sha256(secret) -> record
let alerts = []; // newest first, at most MAX_ALERTS (data/alerts.json)
// (1.18) device id -> { events: [Windows' records, lib/history.js], spells: [{ from, until }], alerted: [keys],
// offlineFrom? } (data/history.json)
let history = {};
let apps = []; // (1.21) the user's apps (data/apps.json; see "apps on every PC")
const uploads = new Map(); // id -> upload session (see createUpload)
let dataHealth = { itemsSource: 'new' };

// Item changes are saved within a second (together); creates and deletions wait for their save (see saved()).
const ITEMS_SAVE_DELAY = FAST_TIMEOUTS ? 100 : 1000;
const persist = jsonWriter(FILE.items, () => items, { log, delay: ITEMS_SAVE_DELAY, serialize: () => itemsFileParts() });
const persistDevices = jsonWriter(FILE.devices, () => devices, { log });
const persistAliases = jsonWriter(FILE.aliases, () => aliases, { log });
const persistTokens = jsonWriter(FILE.tokens, () => tokenStore, { log });
const persistRead = jsonWriter(FILE.read, () => readMarks, { log });
const persistSettings = jsonWriter(FILE.settings, () => settings, { log });
const persistPassword = jsonWriter(FILE.password, () => password, { log });
const persistAlerts = jsonWriter(FILE.alerts, () => alerts, { log });
const persistHistory = jsonWriter(FILE.history, () => history, { log, delay: FAST_TIMEOUTS ? 100 : 2000 });
const persistApps = jsonWriter(FILE.apps, () => apps, { log });
const WRITERS = [persist, persistDevices, persistAliases, persistTokens, persistRead, persistSettings, persistPassword, persistAlerts, persistHistory, persistApps];

function flushAll(timeoutMs = 5000) {
  return Promise.race([Promise.all(WRITERS.map(w => w.flush())), sleep(timeoutMs)]);
}

// Waits until the items are on disk: a create or deletion is answered only then. At most 5 s: a disk that keeps
// failing is retried in the background, as before.
const saved = () => Promise.race([persist.flush(), sleep(5000)]);

let itemsNeedSave = false;

function cleanItem(raw) {
  if (!isPlainObject(raw) || !ITEM_ID.test(raw.id) || !Number.isFinite(raw.ts)) return null;
  const { ip, ...item } = raw; // client addresses are no longer kept with items
  if (ip !== undefined) itemsNeedSave = true;
  if (item.kind === 'text') {
    if (typeof item.text !== 'string') return null;
    if (item.textFile && !Number.isSafeInteger(item.textLength)) return null;
  } else if (item.kind === 'file') {
    if (typeof item.name !== 'string' || !Number.isSafeInteger(item.size) || item.size < 0) return null;
    if (typeof item.mime !== 'string') item.mime = 'application/octet-stream';
  } else {
    return null;
  }
  item.to = Array.isArray(item.to) ? item.to.filter(t => typeof t === 'string') : [];
  item.delivered = isPlainObject(item.delivered) ? Object.fromEntries(Object.entries(item.delivered).filter(([, v]) => Number.isFinite(v))) : {};
  item.from = typeof item.from === 'string' ? item.from : null;
  item.device = typeof item.device === 'string' ? item.device : 'Unknown device';
  if (item.pinned !== true) delete item.pinned;
  if (item.thumb !== 'jpeg' && item.thumb !== 'webp') delete item.thumb;
  return item;
}

function validateItems(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const item = cleanItem(raw);
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  }
  if (out.length < list.length) log.warn(`Dropped ${list.length - out.length} invalid entr${list.length - out.length > 1 ? 'ies' : 'y'} from items.json`);
  return out;
}

function validateDevices(obj) {
  const out = {};
  for (const [id, d] of Object.entries(obj)) {
    if (!DEVICE_ID.test(id) || !isPlainObject(d)) continue;
    out[id] = {
      ...d,
      id,
      name: typeof d.name === 'string' ? d.name : 'Unknown device',
      platform: typeof d.platform === 'string' ? d.platform : 'other',
      firstSeen: Number.isFinite(d.firstSeen) ? d.firstSeen : 0,
      lastSeen: Number.isFinite(d.lastSeen) ? d.lastSeen : 0,
      user: typeof d.user === 'string' ? d.user : 'owner',
    };
    delete out[id].ip;
    if (d.settings !== undefined) out[id].settings = { phoneNotifications: d.settings?.phoneNotifications === true };
    delete out[id].rcDisable;
    if (isPlainObject(d.rcDisable)) out[id].rcDisable = { at: Number(d.rcDisable.at) || 0, from: typeof d.rcDisable.from === 'string' ? d.rcDisable.from : null };
    delete out[id].keyHash;
    if (typeof d.keyHash === 'string' && /^[a-f0-9]{64}$/.test(d.keyHash)) out[id].keyHash = d.keyHash;
    delete out[id].speed; // (1.18) its latest speed test
    if (isPlainObject(d.speed) && [d.speed.down, d.speed.up, d.speed.at].every(Number.isFinite)) out[id].speed = { down: d.speed.down, up: d.speed.up, at: d.speed.at };
    delete out[id].rcMachine;
    if (isPlainObject(d.rcMachine) && typeof d.rcMachine.machine === 'string' && typeof d.rcMachine.profile === 'string' && d.rcMachine.profile) {
      out[id].rcMachine = { machine: d.rcMachine.machine, profile: d.rcMachine.profile, node: typeof d.rcMachine.node === 'string' ? d.rcMachine.node : null, at: Number(d.rcMachine.at) || 0 };
    }
    if (d.status !== undefined) {
      try {
        out[id].status = isPlainObject(d.status) ? { ...parseStatus(Object.fromEntries(Object.entries(d.status).filter(([k]) => k !== 'at'))), at: Number(d.status.at) || 0 } : undefined;
      } catch {
        delete out[id].status;
      }
      if (!out[id].status) delete out[id].status;
    }
  }
  return out;
}

function validateAlerts(list) {
  return list.filter(a => isPlainObject(a) && typeof a.id === 'string' && typeof a.kind === 'string' && typeof a.text === 'string' && Number.isFinite(a.at)).slice(0, MAX_ALERTS);
}

// (1.18) Only well-formed records and spells; anything else in a device's history is dropped.
function validateHistory(obj) {
  const out = {};
  for (const [id, h] of Object.entries(obj)) {
    if (!DEVICE_ID.test(id) || !isPlainObject(h)) continue;
    const events = (Array.isArray(h.events) ? h.events : []).filter(e => isPlainObject(e) && typeof e.log === 'string' && typeof e.provider === 'string'
      && Number.isInteger(e.id) && Number.isFinite(e.time) && Array.isArray(e.data) && e.data.every(d => typeof d === 'string'));
    const spells = (Array.isArray(h.spells) ? h.spells : []).filter(s => isPlainObject(s) && Number.isFinite(s.from) && Number.isFinite(s.until));
    const alerted = (Array.isArray(h.alerted) ? h.alerted : []).filter(k => typeof k === 'string').slice(-30);
    out[id] = { events, spells, alerted, ...(Number.isFinite(h.offlineFrom) && { offlineFrom: h.offlineFrom }) };
  }
  return out;
}

function validateAliases(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([a, b]) => DEVICE_ID.test(a) && typeof b === 'string' && DEVICE_ID.test(b) && a !== b));
}

function validateRead(obj) {
  const out = {};
  for (const [id, marks] of Object.entries(obj)) {
    if (!DEVICE_ID.test(id) || !isPlainObject(marks)) continue;
    out[id] = Object.fromEntries(Object.entries(marks).filter(([c, ts]) => (c === 'all' || DEVICE_ID.test(c)) && Number.isFinite(ts)));
  }
  return out;
}

function validateTokens(obj) {
  const out = { tokens: {}, pairing: {} };
  for (const [hash, t] of Object.entries(isPlainObject(obj.tokens) ? obj.tokens : {})) {
    if (!/^[a-f0-9]{64}$/.test(hash) || !isPlainObject(t)) continue;
    out.tokens[hash] = { ...t, device: typeof t.device === 'string' && DEVICE_ID.test(t.device) ? t.device : null, user: t.user || 'owner', role: t.role || 'owner' };
  }
  for (const [hash, p] of Object.entries(isPlainObject(obj.pairing) ? obj.pairing : {})) {
    if (/^[a-f0-9]{64}$/.test(hash) && isPlainObject(p) && Number.isFinite(p.expires)) out.pairing[hash] = p;
  }
  const gens = Object.entries(isPlainObject(obj.migrationGen) ? obj.migrationGen : {}).filter(([id, n]) => DEVICE_ID.test(id) && Number.isSafeInteger(n) && n > 0);
  if (gens.length) out.migrationGen = Object.fromEntries(gens);
  return out;
}

function validateSettings(obj) {
  const out = { ...obj };
  if (!Array.isArray(out.tailscaleOwners)) out.tailscaleOwners = [];
  out.tailscaleOwners = [...new Set(out.tailscaleOwners.map(normalizeLogin).filter(Boolean))];
  if (!isPlainObject(out.ownerSources)) out.ownerSources = {};
  const seen = isPlainObject(out.tailscaleSeen) ? out.tailscaleSeen : {};
  out.tailscaleSeen = Object.fromEntries(Object.entries(seen).filter(([login, e]) => normalizeLogin(login) === login && login && isPlainObject(e))
    .map(([login, e]) => [login, { since: Number(e.since) || 0, last: Number(e.last) || 0, devices: Array.isArray(e.devices) ? e.devices.filter(id => typeof id === 'string' && DEVICE_ID.test(id)) : [] }]));
  if (!Array.isArray(out.knownHosts)) out.knownHosts = [];
  // (1.19) a Windows build going out one PC first
  if (out.rollout !== undefined && !(isPlainObject(out.rollout) && typeof out.rollout.version === 'string' && typeof out.rollout.sha256 === 'string' && Number.isFinite(out.rollout.since))) delete out.rollout;
  return out;
}

function validatePassword(obj) {
  return typeof obj.salt === 'string' && typeof obj.hash === 'string' ? { salt: obj.salt, hash: obj.hash } : {};
}

// State files or stored files mean an existing Beam (used to warn loudly when its key has gone missing).
function dataLooksExisting() {
  const has = file => fs.existsSync(file);
  if ([FILE.items, FILE.devices, FILE.serverId, FILE.tokens, FILE.settings, FILE.password].some(has)) return true;
  try { return fs.readdirSync(DIR.files).length > 0; } catch { return false; }
}

function loadKey() {
  if (env.BEAM_KEY) return env.BEAM_KEY;
  try {
    const key = fs.readFileSync(FILE.key, 'utf8').trim();
    if (key) return key;
  } catch {}
  if (REQUIRE_DATA) fatal(`There is no Beam key in ${DATA_DIR} and BEAM_REQUIRE_DATA=1, so Beam won't create a new one. Is the data folder mounted?`);
  const existing = dataLooksExisting();
  const key = crypto.randomBytes(24).toString('base64url');
  writeFileDurableSync(FILE.key, key + '\n');
  if (existing) log.warn(`Created a NEW Beam key in ${DATA_DIR}, which already holds Beam data. Every device has to sign in again. If this is unexpected, stop Beam and restore data/key from a backup.`);
  else log.warn(`Created a NEW Beam in ${DATA_DIR} (the data folder was empty).`);
  return key;
}

// A permanent id for this Beam, kept in the data folder so it moves with it: apps use it to recognise their
// server at a new address.
function loadServerId() {
  try {
    const id = fs.readFileSync(FILE.serverId, 'utf8').trim();
    if (id) return id;
  } catch {}
  const id = crypto.randomBytes(12).toString('hex');
  writeFileDurableSync(FILE.serverId, id + '\n');
  return id;
}

function fatal(message) {
  log.error(message);
  process.exit(EXIT_FATAL);
}

function ensureDataDirs() {
  try {
    // (0700: if the data folder's own permissions are ever loosened, what's inside still isn't open to others; 1.7.3)
    for (const dir of [DATA_DIR, ...Object.values(DIR)]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
  } catch (err) {
    fatal(`Beam can't write to its data folder ${DATA_DIR} (${err.code || err.message}). In Docker, check that the volume belongs to the user Beam runs as (PUID/PGID).`);
  }
  makeDataPrivate();
}

// The data folder holds the master key, every sign-in and everything sent, so only the account Beam runs as may
// open it (on Windows also SYSTEM and Administrators). A folder on a second drive inherits that drive's default
// permissions, which let every local account read and change it (Authenticated Users: Modify); a new Linux or macOS
// folder is world-readable (0755). Checked at every start; BEAM_DATA_ACL=keep leaves the folder as it is.
// Groups beyond this account, by their SDDL abbreviation: Everyone, Authenticated Users, Users, Interactive,
// Anonymous, Guests.
// The data folder only this account can open (lib/private-dir.js).
const makeDataPrivate = () => makePrivate(DATA_DIR, { log, env, child: DIR.files }); // (audit S-5: a subfolder checked too)

function openData() {
  ensureDataDirs();
  KEY = loadKey();
  SERVER_ID = loadServerId();
  const loaded = loadState(FILE.items, { fallback: [], validate: validateItems, log });
  items = loaded.value.sort((a, b) => b.ts - a.ts);
  dataHealth.itemsSource = loaded.source;
  const loadedDevices = loadState(FILE.devices, { fallback: {}, validate: validateDevices, log });
  devices = loadedDevices.value;
  aliases = loadState(FILE.aliases, { fallback: {}, validate: validateAliases, log }).value;
  password = loadState(FILE.password, { fallback: {}, validate: validatePassword, log }).value;
  settings = loadState(FILE.settings, { fallback: {}, validate: validateSettings, log }).value;
  readMarks = loadState(FILE.read, { fallback: {}, validate: validateRead, log }).value;
  const loadedTokens = loadState(FILE.tokens, { fallback: { tokens: {}, pairing: {} }, validate: validateTokens, log });
  tokenStore = loadedTokens.value;
  // (1.7.3, audit B-09) Every device and sign-in lost to an unreadable file (with no good .tmp or .bak) is the kind of
  // trouble BEAM_REQUIRE_DATA is for: refuse to start, as for a missing key, rather than come up looking fine.
  // (Also on the next start, when the broken one set aside then still has nothing in its place.)
  const setAside = name => { try { return fs.readdirSync(DATA_DIR).some(f => f.startsWith(`${name}.broken-`)); } catch { return false; } };
  const lost = [[loadedDevices, 'devices.json'], [loadedTokens, 'tokens.json']]
    .filter(([l, name]) => l.source === 'lost' || (REQUIRE_DATA && l.source === 'new' && setAside(name))).map(([, name]) => name);
  if (lost.length && REQUIRE_DATA) {
    const them = lost.length > 1 ? 'them' : 'it';
    fatal(`${lost.join(' and ')} in ${DATA_DIR} couldn't be read (kept as .broken-<time>) and BEAM_REQUIRE_DATA=1, so Beam won't start without ${them}. Restore ${them} from a backup (or, to start without ${them}, delete the .broken file).`);
  }
  alerts = loadState(FILE.alerts, { fallback: [], validate: validateAlerts, log }).value;
  history = loadState(FILE.history, { fallback: {}, validate: validateHistory, log }).value;
  apps = loadState(FILE.apps, { fallback: [], validate: validateApps, log }).value; // (1.21)
  indexTokens();
  if (itemsNeedSave || loaded.source === 'tmp' || loaded.source === 'bak') persist();
}

// ---------------------------------------------------------------- settings

function setting(name) {
  if (ENV_SETTINGS[name] !== undefined) return ENV_SETTINGS[name];
  return settings[name] ?? SETTING_DEFAULTS[name];
}

function owners() {
  return new Set([...ENV_OWNERS, ...(settings.tailscaleOwners || [])]);
}

function markInitialized() {
  if (settings.initialized) return;
  settings.initialized = now();
  persistSettings();
}

function publicSettings() {
  return {
    movedTo: setting('movedTo') || null,
    publicUrl: setting('publicUrl') || null,
    publicUrlLearned: ENV_SETTINGS.publicUrl === undefined && Boolean(settings.publicUrl && settings.publicUrlLearned),
    tailscaleSignIn: setting('tailscaleSignIn'),
    tailscaleOwners: [...owners()],
    tailscaleOwnersFixed: ENV_OWNERS, // (1.7.3) from BEAM_TAILSCALE_OWNERS: Settings can't remove these
    // (1.7.3) Accounts that signed in on purpose but aren't owners: Settings offers to allow them.
    tailscaleSeen: Object.entries(settings.tailscaleSeen || {}).filter(([login]) => !owners().has(login))
      .map(([login, e]) => ({ login, since: e.since, last: e.last, devices: e.devices.map(id => devices[id]?.name).filter(Boolean) })),
    retentionDays: setting('retentionDays'),
    maxItems: setting('maxItems'),
    blockedNodes: (settings.blockedNodes || []).map(({ node, name, since, device }) => ({ node, name, since, device })),
    alerts: alertSettings(),
    stagedUpdates: stagedOn(), // (1.19) a Windows build goes to one PC first
    rollout: rolloutInfo(),
    locked: Object.keys(ENV_SETTINGS).filter(k => ENV_SETTINGS[k] !== undefined),
  };
}

// ---------------------------------------------------------------- network identity

// Addresses whose X-Forwarded-* headers are believed: loopback (tailscale serve, a proxy on this machine) plus
// BEAM_TRUSTED_PROXIES (Docker bridge gateways, a NAS reverse proxy…), as IPs or CIDRs.
const trustedProxies = new net.BlockList();
trustedProxies.addSubnet('127.0.0.0', 8, 'ipv4');
trustedProxies.addAddress('::1', 'ipv6');

function normalizeIp(value) {
  let s = String(value || '').trim();
  if (s.startsWith('[')) s = s.slice(1, s.includes(']') ? s.indexOf(']') : undefined);
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) s = s.split(':')[0];
  s = s.replace(/%.*$/, '');
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(s)) s = s.slice(7);
  return net.isIP(s) ? s.toLowerCase() : '';
}

function addTrustedProxies(list) {
  for (const entry of String(list || '').split(',').map(s => s.trim()).filter(Boolean)) {
    if (entry === 'loopback') continue;
    const [addr, bits] = entry.split('/');
    const ip = normalizeIp(addr);
    const family = net.isIP(ip);
    const prefix = Number(bits);
    if (!family || (bits !== undefined && !(Number.isInteger(prefix) && prefix >= 0 && prefix <= (family === 6 ? 128 : 32)))) {
      log.warn(`Ignoring BEAM_TRUSTED_PROXIES entry "${entry}" (expected an IP address or CIDR)`);
      continue;
    }
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) trustedProxies.addAddress(ip, type);
    else trustedProxies.addSubnet(ip, prefix, type);
  }
}
addTrustedProxies(env.BEAM_TRUSTED_PROXIES);

function isTrustedProxy(ip) {
  const family = net.isIP(ip);
  return family ? trustedProxies.check(ip, family === 6 ? 'ipv6' : 'ipv4') : false;
}

const isLoopback = ip => /^127\./.test(ip) || ip === '::1';
const peerIp = req => normalizeIp(req.socket.remoteAddress) || String(req.socket.remoteAddress || '');
const viaTrustedProxy = req => isTrustedProxy(peerIp(req)) && Boolean(req.headers['x-forwarded-for']);

// The caller's address: the socket peer, or, when that is a trusted proxy, the right-most X-Forwarded-For hop
// that isn't one (hops further left were written by the client and can't be believed).
function clientIp(req) {
  if (req._clientIp !== undefined) return req._clientIp;
  let ip = peerIp(req);
  if (isTrustedProxy(ip)) {
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = normalizeIp(hops[i]);
      if (!hop) { ip = 'invalid'; break; }
      ip = hop;
      if (!isTrustedProxy(hop)) break;
    }
  }
  return (req._clientIp = ip);
}

function isHttps(req) {
  if (isTrustedProxy(peerIp(req))) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (proto) return proto === 'https';
    return /\.ts\.net(:\d+)?$/i.test(req.headers.host || '');
  }
  return Boolean(req.socket.encrypted);
}

function requestHost(req) {
  const forwarded = isTrustedProxy(peerIp(req)) ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
  return forwarded || String(req.headers.host || '');
}

const originOf = req => `${isHttps(req) ? 'https' : 'http'}://${requestHost(req)}`;

// Tailscale: machine names, whois and the address `tailscale serve` publishes. See lib/tailscale.js.
const ts = env.BEAM_TAILSCALE === 'off'
  ? { status: async () => null, serveConfig: async () => null, prefs: async () => null, whois: async () => null, ping: async () => null, source: 'off' }
  : tailscale.createClient({ socket: env.BEAM_TAILSCALE_SOCKET || '', statusTtl: FAST_TIMEOUTS ? 300 : 30_000 });
// Requests to other Beams (moves, import-from); through tailscaled's HTTP proxy when BEAM_TAILNET_PROXY is set.
const outbound = createOutbound({ proxy: env.BEAM_TAILNET_PROXY || '', isTailnetHost: host => /\.ts\.net$/i.test(host) || tailscale.isTailscaleIp(host) });
const postJson = (url, body, headers = {}, timeout = 30_000) => outbound.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), timeout });

let tsIndex = new Map(); // tailnet address -> { key, name, user, self }
let tsIndexAt = 0;
let tsRefreshing = null;
let tsSelfName = '';
let tsSelfDns = ''; // this machine's MagicDNS name (e.g. pc.tailnet.ts.net), for ownHost()
let tsFacts = new Map(); // (1.17) tailnet address -> { online, lastSeen, keyExpiry, expired, path, self } (lib/tailscale.js machineFacts)
const tsPaths = new Map(); // (1.17) machine key -> the path tailscaled last took to it: { via, lan?, relay?, at, ms?, tested? }

function refreshTailnet(force = false) {
  if (tsRefreshing || (!force && now() - tsIndexAt < 15_000)) return tsRefreshing || Promise.resolve();
  tsRefreshing = ts.status().then(status => {
    if (status) {
      tsIndex = tailscale.machineIndex(status);
      tsSelfName = statusText(status.Self?.HostName || '');
      tsSelfDns = String(status.Self?.DNSName || '').replace(/\.$/, '').toLowerCase();
      tsFacts = tailscale.machineFacts(status, now());
    }
    tsIndexAt = now();
    if (status) afterTailnet();
  }).catch(() => {}).finally(() => { tsRefreshing = null; });
  return tsRefreshing;
}

// (1.17) After each look at tailscaled: the paths it's using now, the devices' Tailscale state on their pages (sent
// when it changed) and the keys that are about to run out.
let tsDeviceState = '';
function afterTailnet() {
  for (const [ip, f] of tsFacts) {
    const key = tsIndex.get(ip)?.key;
    if (!f.path || !key || key !== ip) continue; // one entry per machine (its key is one of its addresses)
    const had = tsPaths.get(key);
    const same = had && had.via === f.path.via && had.lan === f.path.lan && had.relay === f.path.relay;
    tsPaths.set(key, same ? { ...had, at: now() } : { ...f.path, at: now() });
  }
  const state = JSON.stringify(Object.values(devices).map(d => [d.id, tsStateOf(tailscaleOf(d)?.ip)]));
  if (state !== tsDeviceState) {
    if (tsDeviceState) broadcastDevices();
    tsDeviceState = state;
  }
  checkTailscaleKeys();
}

// What a device's page shows about its machine: Tailscale's own online state, when it last saw it and when its key
// runs out. Nothing when tailscaled hasn't said (no Tailscale, or a machine it doesn't list).
function tsStateOf(ip) {
  const f = ip && tsFacts.get(ip);
  if (!f) return null;
  return { online: f.online, ...(f.lastSeen && { lastSeen: f.lastSeen }), keyExpiry: f.keyExpiry, ...(f.expired && { expired: true }) };
}

// ---- Tailscale keys (1.17): a machine whose key runs out drops off Tailscale until someone signs in there again; for
// this server's own machine that's every device losing Beam. Alerts two weeks and three days before, and when it has.
const TS_KEY_STAGES = { near: 1, soon: 2, expired: 3 };

function keyStageOf(expiry) {
  if (!expiry) return null;
  const left = expiry - now();
  return left <= 0 ? 'expired' : left <= 3 * 86400e3 ? 'soon' : left <= 14 * 86400e3 ? 'near' : null;
}

function keyAlertText(name, expiry, stage, isServer) {
  const days = Math.max(1, Math.ceil((expiry - now()) / 86400e3));
  const when = `${days === 1 ? 'within a day' : `in ${days} days`} (${new Date(expiry).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })})`;
  if (isServer) {
    return stage === 'expired'
      ? `The Beam server's Tailscale sign-in has run out: devices can't reach Beam until you sign in to Tailscale on ${name} again`
      : `The Beam server's Tailscale sign-in runs out ${when}. Then no device can reach Beam until it's renewed: turn off key expiry for ${name} in Tailscale's admin console`;
  }
  return stage === 'expired'
    ? `${name}'s Tailscale sign-in has run out, so it can't reach Beam: sign in to Tailscale on it again`
    : `${name}'s Tailscale sign-in runs out ${when}: turn off key expiry for it in Tailscale's admin console, or sign in to Tailscale on it again`;
}

// holder[field] remembers { expiry, stage } so each stage alerts once per key; a new or endless key starts over.
function keyAlert(holder, field, expiry, name, deviceId, isServer) {
  const stage = keyStageOf(expiry);
  const had = holder[field];
  if (!stage) {
    if (!had) return false;
    delete holder[field];
    return true;
  }
  if (had && had.expiry === expiry && TS_KEY_STAGES[had.stage] >= TS_KEY_STAGES[stage]) return false;
  holder[field] = { expiry, stage };
  const text = keyAlertText(name, expiry, stage, isServer);
  if (alertSettings().tailscaleKey) raiseAlert('tailscaleKey', deviceId, 'warn', text);
  else log.warn(text);
  return true;
}

function checkTailscaleKeys() {
  const self = [...tsFacts.values()].find(f => f.self);
  if (self && keyAlert(settings, 'tailscaleKeyAlert', self.keyExpiry, tsSelfName || os.hostname(), null, true)) persistSettings();
  // One alert per machine, named after its Beam app (a browser on the same machine shares its key).
  const byMachine = new Map();
  for (const d of Object.values(devices)) {
    const ip = tailscaleOf(d)?.ip;
    const f = ip && tsFacts.get(ip);
    if (!f || f.self) continue;
    const key = tsIndex.get(ip)?.key || ip;
    const had = byMachine.get(key);
    if (!had || (!APP_PLATFORMS.has(had.platform) && APP_PLATFORMS.has(d.platform))) byMachine.set(key, d);
  }
  let changed = false;
  for (const d of byMachine.values()) {
    if (keyAlert((d.alerted ||= {}), 'tailscaleKey', tsFacts.get(tailscaleOf(d).ip).keyExpiry, d.name, d.id, false)) changed = true;
  }
  if (changed) persistDevices();
}

let ownIps = { at: 0, set: new Set() };
function isOwnAddress(ip) {
  if (now() - ownIps.at > 60_000) {
    ownIps = { at: now(), set: new Set(Object.values(os.networkInterfaces()).flat().map(a => normalizeIp(a.address)).filter(Boolean)) };
  }
  return ownIps.set.has(ip) || tsIndex.get(ip)?.self === true;
}

// Which physical machine a request came from, for linking a browser to the app on the same machine. Only
// addresses that pin down one machine count: Tailscale addresses (one machine each; its IPv4 and IPv6 share a
// key) and the server itself. LAN, Docker and proxy addresses are shared or reused, so they give null.
function machineOf(req) {
  const peer = peerIp(req);
  if (isLoopback(peer) && !viaTrustedProxy(req)) {
    return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '') ? 'host' : null;
  }
  const ip = clientIp(req);
  if (isOwnAddress(ip)) return 'host';
  if (!tailscale.isTailscaleIp(ip)) return null;
  const known = tsIndex.get(ip);
  if (!known && now() - tsIndexAt > 15_000) refreshTailnet();
  return known ? known.key : ip;
}

function machineName(req) {
  const machine = machineOf(req);
  if (machine === 'host') return tsSelfName || os.hostname();
  return tsIndex.get(clientIp(req))?.name || null;
}

// Tailscale serve vouches for the caller (Tailscale-User-Login), but only on requests it forwarded itself:
// they come from this machine's loopback, from a Tailscale address, and not through Funnel.
function identityFromHeaders(req) {
  const raw = req.headers['tailscale-user-login'];
  if (!raw || Array.isArray(raw)) return null;
  if (!isLoopback(peerIp(req)) || req.headers['tailscale-funnel-request']) return null;
  const ip = clientIp(req);
  if (!tailscale.isTailscaleIp(ip)) return null;
  const login = normalizeLogin(tailscale.decodeHeaderWords(raw));
  if (!login || /[\s\u0000-\u001f]/.test(login)) return null;
  return { login, name: cleanName(tailscale.decodeHeaderWords(req.headers['tailscale-user-name'] || '')), ip };
}

// The header identity, believed only when `tailscale whois` confirms that address belongs to that login (1.7.2: no
// answer used to count as yes, so a request that only looked like tailscale serve's was believed while tailscaled
// was unreachable). Unconfirmed or contradicted: rejected (automatic sign-in waits; passwords and approvals work).
async function verifiedIdentity(req) {
  const header = identityFromHeaders(req);
  if (!header) return null;
  const who = await ts.whois(header.ip);
  if (!who?.login) {
    log.warn(`Ignored a Tailscale identity: tailscale whois couldn't confirm who ${header.ip} is`);
    return { ...header, mismatch: true, unconfirmed: true };
  }
  if (who.login !== header.login) {
    log.warn(`Ignored a Tailscale identity: the headers say ${header.login} but tailscale whois says ${header.ip} belongs to ${who.login}`);
    return { ...header, mismatch: true };
  }
  return { ...header, node: who.node || tsIndex.get(header.ip)?.name || null, tsNode: nodeOf(who, header.ip) };
}

// Automatic sign-in (Tailscale identity, or a Beam app on the same machine) only at this Beam's own addresses (1.7.2):
// a page on another name pointed at this server (DNS rebinding) must not get a sign-in just because its browser runs
// on the right machine. IP addresses can't be rebound; names must be this machine's, its tailnet name, or an address
// Beam knows (its public address, ones seen through tailscale serve).
async function ownHost(req) {
  const raw = requestHost(req).trim().toLowerCase();
  const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.replace(/:\d+$/, '');
  if (!host) return false;
  if (net.isIP(host) || host === 'localhost') return true;
  if (!tsSelfDns && ts.source !== 'off') await refreshTailnet(true);
  const own = new Set([os.hostname().toLowerCase(), `${os.hostname().toLowerCase()}.local`, tsSelfName.toLowerCase(), tsSelfDns]);
  for (const u of [setting('publicUrl'), serveUrlCache]) { try { if (u) own.add(new URL(u).hostname.toLowerCase()); } catch {} }
  for (const h of settings.knownHosts || []) own.add(String(h).toLowerCase().replace(/:\d+$/, ''));
  own.delete('');
  return own.has(host);
}

// The Tailscale machine behind an address: its StableID when whois knows it, else its name and addresses.
function nodeOf(who, ip) {
  const known = tsIndex.get(ip);
  const ips = new Set([ip, ...(who?.ips || [])]);
  if (known) for (const [addr, entry] of tsIndex) if (entry.key === known.key) ips.add(addr);
  const name = who?.node || known?.name || ip;
  return { node: who?.stableId || known?.id || `name:${name}`, name, ips: [...ips] };
}

// Devices remember the Tailscale machine they signed in from, so removing a device also stops that machine from
// signing straight back in with Tailscale (settings.blockedNodes). The password and approvals still work.
function rememberNode(deviceId, node) {
  const device = devices[deviceId];
  if (!device || !node || (device.tsNode?.node === node.node && device.tsNode.ips?.length === node.ips.length)) return;
  device.tsNode = node;
  persistDevices();
}

function nodeBlocked(node, ip) {
  return (settings.blockedNodes || []).some(b => (node && b.node === node.node) || b.ips?.includes(ip));
}

function blockNodesOf(deviceIds, { except = null, reason }) {
  const blocked = (settings.blockedNodes ||= []);
  let added = 0;
  for (const id of deviceIds) {
    const node = devices[id]?.tsNode;
    if (!node || (except && (node.node === except.node || node.ips?.some(ip => except.ips?.includes(ip))))) continue;
    if (blocked.some(b => b.node === node.node)) continue;
    blocked.push({ node: node.node, name: node.name, ips: node.ips, since: now(), device: devices[id]?.name || id });
    log.info(`Tailscale machine ${node.name} may no longer sign in automatically (${reason}); unblock it in Settings`);
    added++;
  }
  if (added) {
    persistSettings();
    broadcast('settings', publicSettings());
  }
}

// The caller's own Tailscale machine, so blocking never locks out the device doing the blocking. On the server
// itself that is the server's own machine, with all of its addresses.
function callerNode(req) {
  const ip = clientIp(req);
  isOwnAddress(ip); // refreshes the list of this machine's addresses
  if (machineOf(req) === 'host') {
    const selfIp = [...tsIndex].find(([, entry]) => entry.self)?.[0];
    const node = selfIp ? nodeOf(null, selfIp) : { node: 'host', name: 'this computer', ips: [] };
    return { ...node, ips: [...new Set([...node.ips, ...ownIps.set])] };
  }
  return tailscale.isTailscaleIp(ip) ? nodeOf(null, ip) : null;
}

function describeWhereSync(req) {
  const ip = clientIp(req);
  if (machineOf(req) === 'host') return 'this computer (the Beam server)';
  const known = tsIndex.get(ip);
  return known?.name ? `${known.name} (${ip})` : ip;
}

// A friendly "where is this coming from" for sign-in prompts: machine name, address and Tailscale account.
async function describeRequester(req) {
  const ip = clientIp(req);
  if (machineOf(req) === 'host') return { where: 'this computer (the Beam server)', tailscale: null };
  if (!tsIndex.has(ip)) await Promise.race([refreshTailnet(), sleep(3000)]);
  const header = identityFromHeaders(req);
  const who = tailscale.isTailscaleIp(ip) ? await Promise.race([ts.whois(ip), sleep(3000).then(() => null)]) : null;
  const node = who?.node || tsIndex.get(ip)?.name || null;
  const user = who?.login || header?.login || tsIndex.get(ip)?.user || null;
  const place = node ? `${node} (${ip})` : ip;
  return { where: user ? `${place} · ${user}` : place, tailscale: node || user ? { node, user } : null };
}

// ---------------------------------------------------------------- tokens & auth

let masterTid = '';
let tidIndex = new Map(); // first 16 hex of sha256(sha256(secret)) -> sha256(secret), for /api/hello proofs

function tidOf(h1) {
  return sha256hex(h1).slice(0, 16);
}

function indexTokens() {
  masterTid = KEY ? tidOf(sha256raw(KEY)) : '';
  tidIndex = new Map(Object.keys(tokenStore.tokens).map(hash => [tidOf(Buffer.from(hash, 'hex')), Buffer.from(hash, 'hex')]));
}

function keyMatches(candidate) {
  if (typeof candidate !== 'string' || !candidate || !KEY) return false;
  return crypto.timingSafeEqual(sha256raw(candidate), sha256raw(KEY));
}

function newTokenRecord({ device = null, via, session = false, scope = null, origin = null, platform = null, keyHash = null, claimed = false }) {
  const record = { device, created: now(), lastUsed: now(), via, user: 'owner', role: 'owner' };
  if (session) record.session = true;
  if (scope) record.scope = scope;
  if (origin && origin !== via) record.origin = origin;
  if (platform) record.platform = platform;
  if (keyHash) record.keyHash = keyHash; // key-bound: made or used with the device's key
  if (claimed) record.claimed = true; // made by Tailscale identity for a device that already existed
  return record;
}

// How a sign-in was first made: its own `via`, or for a token made from another sign-in (a link that uses a
// device's token, a sign-out of the others) that one's origin. Remote control refuses 'autopair' (see rcIneligible).
const tokenOrigin = t => t?.origin || t?.via || null;
// The platform a sign-in was made for: a Beam app's ('windows', 'android', 'cli'…) or a browser's ('web'). A link
// or sign-out made from a sign-in keeps its platform. Tokens from before 1.6 count as a browser's until a Beam app
// uses one for its own requests (see handle).
const tokenPlatform = t => t?.platform || 'web';
const validPlatform = v => (typeof v === 'string' && /^[a-z]{2,12}$/.test(v) ? v : '');

// Device keys (1.6): the Beam app for Windows keeps a secret per installation and Windows account (32 random bytes,
// DPAPI-protected) and sends it as X-Beam-Device-Key on its own requests. The server keeps its SHA-256 with the
// device (keyHash), trusted on first use. From then on the device's bearer requests must carry it, a sign-in that
// names the device without it gets a device of its own, and remote control takes only sign-ins used with it. So
// another Windows account (or program) on the same machine can't pass for that app.
const DEVICE_KEY = /^[A-Za-z0-9_-]{43}$/;
function deviceKeyOf(req) {
  const v = req.headers['x-beam-device-key'];
  return typeof v === 'string' && DEVICE_KEY.test(v) && Buffer.from(v, 'base64url').length === 32 ? sha256hex(v) : null;
}

// A sign-in token made or used with its device's current key.
const keyBound = t => Boolean(t?.keyHash) && devices[resolveAlias(t.device || '')]?.keyHash === t.keyHash;

// A Windows app's sign-in shows its device's key on this request (remote control asks for it even from the app's own
// pages, cookie requests included: a copied sign-in alone can't control anything). True for every other sign-in.
function windowsKeyShown(auth, req) {
  if (auth?.via !== 'token' || tokenPlatform(auth.token) !== 'windows') return true;
  const keyHash = devices[resolveAlias(auth.token.device || '')]?.keyHash;
  return Boolean(keyHash) && deviceKeyOf(req) === keyHash;
}

// A sign-in that names an existing device with a device key gets that id only with the key (keyHash, from the
// request); any other gets an id of its own. How the sign-in was made is for the log.
function claimableId(id, keyHash, how) {
  if (!id) return id;
  const d = devices[resolveAlias(id)];
  if (!d?.keyHash || keyHash === d.keyHash) return id;
  logOnce(`claim ${d.id}`, `A sign-in (${how}) named the device id of ${d.name} without its device key: it gets a device of its own`,
    n => `${n} more sign-in${n === 1 ? '' : 's'} named the device id of ${d.name} without its device key`);
  return crypto.randomBytes(12).toString('hex');
}

// A request (bearer) with a device key: the first key that the device's own Windows app shows is trusted (not one from
// a Tailscale sign-in that took over an existing device); a token used with the key becomes key-bound.
function deviceKeySeen(auth, device, keyHash, req, url) {
  if (!device.keyHash) {
    const own = auth.via === 'master' || (auth.via === 'token' && tokenPlatform(auth.token) === 'windows' && !auth.token.claimed);
    if (!own || explicitPlatform(req, url) !== 'windows' || device.platform !== 'windows') return;
    device.keyHash = keyHash;
    persistDevices();
    log.info(`${device.name}'s Beam app proves itself with its device key from now on`);
  }
  if (auth.via === 'token' && device.keyHash === keyHash && auth.token.keyHash !== keyHash && resolveAlias(auth.token.device || '') === device.id) {
    auth.token.keyHash = keyHash;
    persistTokens();
  }
}

// The platform a sign-in request says it comes from: an app's (client: 'app') or a browser's.
function signInPlatform(req, url, body) {
  if (body.client !== 'app') return 'web';
  const p = validPlatform(body.platform) || explicitPlatform(req, url);
  return p && p !== 'web' ? p : 'other';
}

// Issues a device token (the opaque secret clients store as their `key`).
function issueToken(options) {
  const token = randomSecret('bt_');
  tokenStore.tokens[sha256hex(token)] = newTokenRecord(options);
  indexTokens();
  persistTokens();
  return token;
}

// Clients that still use the master key are offered their own token: the same one every time for a device (so
// parallel requests agree), derived from the master key so nothing secret needs storing.
// (1.7.3, audit B-15) Once one is revoked, the device's next one is a different value (migrationGen): a copy of the
// revoked one mustn't come back to life when the master key is next used for that device.
function migrationToken(deviceId) {
  const gen = tokenStore.migrationGen?.[deviceId] || 0;
  return 'bt_' + crypto.createHmac('sha256', KEY).update(gen ? `device-token:${deviceId}:${gen}` : `device-token:${deviceId}`).digest('base64url');
}

// Session sign-ins end after 12 h without use; one approved for a move (1.7.3) two days after it was made at most
// (it's revoked sooner, when the move is done or called off); a browser's (not a Beam app's) after half a year
// without use (1.7.3, audit S-34: like Family's sessions; on the tailnet a browser signs itself back in).
const MOVE_TOKEN_MS = 48 * 3600e3;
const WEB_IDLE_MS = 180 * 24 * 3600e3;
const expiryOf = t => {
  const idle = now() - (t.lastUsed || t.created || 0);
  if (t.session && idle > SESSION_IDLE_MS) return 'session expired';
  if (t.scope === 'move' && now() - (t.created || 0) > MOVE_TOKEN_MS) return 'a move sign-in expired';
  if (tokenPlatform(t) === 'web' && idle > WEB_IDLE_MS) return 'a browser unused for half a year';
  return null;
};
const tokenExpired = t => expiryOf(t) !== null;
const revokeMoveTokens = reason => revokeTokens((h, t) => t.scope === 'move', reason);

function revokeTokens(predicate, reason) {
  const gone = Object.keys(tokenStore.tokens).filter(hash => predicate(hash, tokenStore.tokens[hash]));
  if (!gone.length) return 0;
  const records = gone.map(h => tokenStore.tokens[h]);
  const devicesAffected = new Set(records.map(t => t.device).filter(Boolean));
  for (const hash of gone) delete tokenStore.tokens[hash];
  for (const t of records) {
    const id = t.via === 'migration' ? t.mid || t.device : null; // (mid: the id its value came from, merges aside)
    if (id && DEVICE_ID.test(id)) (tokenStore.migrationGen ||= {})[id] = (tokenStore.migrationGen[id] || 0) + 1;
  }
  indexTokens();
  persistTokens();
  endRcSessionsOfTokens(gone, records); // while their streams can still hear it
  const set = new Set(gone);
  for (const c of clients) if (c.tokenHash && set.has(c.tokenHash)) c.res.end();
  log.info(`Revoked ${gone.length} sign-in${gone.length > 1 ? 's' : ''} (${reason})${devicesAffected.size ? ': ' + [...devicesAffected].map(nameOf).join(', ') : ''}`);
  return gone.length;
}

// A pairing token (from /api/pair) that an app uses directly becomes that app's device token.
function redeemPairing(hash, req) {
  const pairing = tokenStore.pairing[hash];
  if (!pairing || pairing.expires < now()) return null;
  delete tokenStore.pairing[hash];
  const key = deviceKeyOf(req);
  const raw = claimableId(rawDeviceIdOf(req, new URL(req.url, 'http://beam')), key, 'pairing link');
  tokenStore.tokens[hash] = newTokenRecord({
    device: raw ? resolveAlias(raw) : null, via: 'pairing', platform: explicitPlatform(req, new URL(req.url, 'http://beam')) || 'other',
    keyHash: raw && key && devices[resolveAlias(raw)]?.keyHash === key ? key : null,
  });
  indexTokens();
  persistTokens();
  log.info(`Signed in ${raw ? nameOf(resolveAlias(raw)) : 'a new device'} with a pairing link from ${describeWhereSync(req)}`);
  return tokenStore.tokens[hash];
}

// Who is calling: the master key (legacy, admin) or a device token. Every auth decision goes through here, so
// roles and scopes can be added later without touching the routes. user/role are reserved: always "owner".
function authOf(req) {
  if (req._auth !== undefined) return req._auth;
  const header = String(req.headers.authorization || '');
  // Cookies (audit S-10): `__Host-beam_key` (host-only, so another machine of the tailnet can't plant it); the legacy
  // `beam_key` only over plain http (this PC's own app on localhost: `__Host-` cookies need https). (1.11.1, step 3:
  // over https the old name isn't read any more; 1.7.7 had moved every page over, and none had used it since.)
  const candidates = [];
  if (/^bearer\s/i.test(header)) candidates.push([header.slice(7).trim(), 'bearer']);
  else {
    const cookies = parseCookies(req);
    if (cookies[HOST_COOKIE]) candidates.push([cookies[HOST_COOKIE], 'cookie', HOST_COOKIE]);
    if (cookies.beam_key && !isHttps(req)) candidates.push([cookies.beam_key, 'cookie', 'beam_key']);
  }
  req._authPresented = candidates.length > 0;
  let auth = null;
  for (const [secret, source, name] of candidates) {
    if (secret && (auth = authBySecret(secret, source, req))) {
      auth.cookie = name;
      break;
    }
  }
  return (req._auth = auth);
}

const HOST_COOKIE = '__Host-beam_key';

function authBySecret(secret, source, req) {
  if (keyMatches(secret)) return { via: 'master', tokenId: null, hash: null, token: null, deviceId: null, user: 'owner', role: 'owner', scope: null, source };
  const hash = sha256hex(secret);
  let record = tokenStore.tokens[hash] || (secret.startsWith('bp_') ? redeemPairing(hash, req) : null);
  if (record && tokenExpired(record)) {
    revokeTokens(h => h === hash, expiryOf(record));
    record = null;
  }
  if (!record) return null;
  return {
    via: 'token', tokenId: hash.slice(0, 12), hash, token: record,
    deviceId: record.device ? resolveAlias(record.device) : null,
    user: record.user || 'owner', role: record.role || 'owner', scope: record.scope || null, session: Boolean(record.session), source,
  };
}

const tokenSavedAt = new Map();
function touchToken(auth) {
  if (auth?.via !== 'token') return;
  auth.token.lastUsed = now();
  // lastUsed only needs to be roughly right on disk (it drives session expiry after 12 h idle).
  if (now() - (tokenSavedAt.get(auth.hash) || 0) > 10 * 60e3) {
    tokenSavedAt.set(auth.hash, now());
    persistTokens();
  }
}

// Over https the sign-in is HOST_COOKIE (1.7.7) and the old `beam_key` is cleared; plain http (this PC itself) keeps
// `beam_key`, as `__Host-` cookies need https.
function authCookie(req, value, { session = false, clear = false } = {}) {
  const age = clear ? '; Max-Age=0' : session ? '' : `; Max-Age=${10 * 365 * 86400}`;
  if (!isHttps(req)) return `beam_key=${encodeURIComponent(value)}; Path=/${age}; HttpOnly; SameSite=Lax`;
  return [`${HOST_COOKIE}=${encodeURIComponent(value)}; Path=/${age}; HttpOnly; SameSite=Lax; Secure`, 'beam_key=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure'];
}

// Browsers attach cookies to requests from any page of the same *site*, and every *.ts.net machine of a tailnet
// is the same site (ts.net is on the Public Suffix List). So cookie-authenticated changes must come from Beam's
// own pages: the browser says so (Sec-Fetch-Site), or the Origin matches, or the request carries a header only
// Beam's own scripts set.
function csrfOk(req) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'same-origin' || site === 'none') return true;
  if (req.headers.origin) return originMatches(req);
  return Boolean(req.headers['x-beam-device-id']);
}

// For the sign-in endpoints that set a cookie but need no credentials (login, autopair, logout, the sign-in
// poll): refuse what a browser marks as cross-site. Native apps send neither header and are fine.
function crossSiteBrowser(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site !== 'same-origin' && site !== 'none';
  return Boolean(req.headers.origin) && !originMatches(req);
}

function originMatches(req) {
  try {
    const o = new URL(req.headers.origin);
    const port = o.port || (o.protocol === 'https:' ? '443' : '80');
    const want = `${o.hostname}:${port}`.toLowerCase();
    return [requestHost(req), String(req.headers.host || '')].some(h => {
      const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(h.trim());
      return m && `${m[1]}:${m[2] || port}`.toLowerCase() === want;
    });
  } catch {
    return false;
  }
}

// Sliding-window counters for sign-in attempts and bad credentials.
class Limiter {
  constructor(limit, windowMs, lockMs = 0) {
    Object.assign(this, { limit, windowMs, lockMs, map: new Map() });
  }

  entry(key) {
    let e = this.map.get(key);
    if (!e) this.map.set(key, (e = { times: [], until: 0 }));
    e.times = e.times.filter(t => now() - t < this.windowMs);
    return e;
  }

  blocked(key) {
    const e = this.entry(key);
    return e.until > now() || (!this.lockMs && e.times.length >= this.limit);
  }

  hit(key) {
    const e = this.entry(key);
    e.times.push(now());
    if (this.lockMs && e.times.length >= this.limit) e.until = now() + this.lockMs;
  }

  reset(key) {
    this.map.delete(key);
  }

  retryAfter(key) {
    const e = this.entry(key);
    return Math.max(1, Math.ceil(((e.until > now() ? e.until : (e.times[0] || now()) + this.windowMs) - now()) / 1000));
  }

  prune() {
    for (const [k, e] of this.map) if (e.until < now() && e.times.every(t => now() - t >= this.windowMs)) this.map.delete(k);
  }
}

const passwordIp = new Limiter(5, 5 * 60e3, 5 * 60e3);
const passwordGlobal = new Limiter(30, 10 * 60e3);
const badSecrets = new Limiter(30, 5 * 60e3, 5 * 60e3);
const loginRequestRate = new Limiter(10, 60e3);

// ---------------------------------------------------------------- devices

const presence = new Map(); // device id -> { web, app }: open event streams by kind

const presenceOf = id => presence.get(id) || { web: 0, app: 0 };
const isOnline = id => { const p = presence.get(id); return Boolean(p && p.web + p.app > 0); };
const appOnline = id => (presence.get(id)?.app || 0) > 0;
const resolveAlias = id => aliases[id] || id;
const nameOf = id => devices[id]?.name || id;

function rawDeviceIdOf(req, url) {
  const id = req.headers['x-beam-device-id'] || url.searchParams.get('device') || parseCookies(req).beam_device_id || '';
  return DEVICE_ID.test(id) ? id : null;
}

// The calling device's id: the one its token is bound to, else the id it sends; merges are followed. (1.23.1) Including
// one this very request made: a browser joining the Linux or Windows app on its machine got its old id back in that
// answer's body (/api/me `you`) while X-Beam-You said the app's, and the page took the old one again ("This device:
// Chrome on occ-bkp-02" in the Pi's menu window).
function deviceIdOf(req, url) {
  const auth = authOf(req);
  if (auth?.deviceId) return resolveAlias(auth.deviceId);
  const raw = rawDeviceIdOf(req, url);
  return raw && resolveAlias(raw);
}

// The name the client sent ('' if none).
function deviceNameOf(req, url) {
  let name = req.headers['x-beam-device'];
  if (name) { try { name = decodeURIComponent(name); } catch {} }
  else name = url.searchParams.get('name') || parseCookies(req).beam_device || '';
  return cleanName(name);
}

// Beam apps; a browser on the same machine as one of these is linked to it.
const APP_PLATFORMS = new Set(['windows', 'android', 'ios', 'mac', 'linux', 'cli']);
// Apps a person installs; only these count for "the app was reinstalled" (never the CLI, which can run anywhere).
const GUI_PLATFORMS = new Set(['windows', 'android', 'ios', 'mac', 'linux']);

// The platform the client says it is ('' when it doesn't). Clients that don't say count as browsers only when
// they use the browser cookie; scripts, curl and Shortcuts (bearer key) are 'other' and never linked.
function explicitPlatform(req, url) {
  const p = String(req.headers['x-beam-platform'] || url.searchParams.get('platform') || '').toLowerCase();
  return /^[a-z]{2,12}$/.test(p) ? p : '';
}

function platformOf(req, url) {
  return explicitPlatform(req, url) || (authOf(req)?.source === 'bearer' || /^bearer\s/i.test(req.headers.authorization || '') ? 'other' : 'web');
}

// Which user account on its machine an app runs under (X-Beam-Profile, a hash the app derives; optional). Two
// Windows accounts on one shared PC are two devices, so a new one must never be taken for a reinstall of the other.
function profileOf(req, url) {
  const p = String(req.headers['x-beam-profile'] || url.searchParams.get('profile') || '');
  return /^[A-Fa-f0-9]{8,64}$/.test(p) ? p.toLowerCase() : '';
}

// Registers the calling device (or refreshes its name, platform and last-seen time).
let lastDeviceSave = 0;
function touchDevice(req, url) {
  const id = deviceIdOf(req, url);
  if (!id) return null;
  const sentName = deviceNameOf(req, url);
  const platform = platformOf(req, url);
  let device = devices[id];
  const isNew = !device;
  if (isNew) {
    device = devices[id] = { id, name: sentName || 'Unknown device', platform, firstSeen: now(), lastSeen: 0, user: 'owner' };
    markInitialized();
  }
  device.lastSeen = now();
  // A browser signed in "for this session only" is forgotten when that session ends (apps never are).
  if (authOf(req)?.session && !APP_PLATFORMS.has(device.platform)) device.temporary = true;
  // A browser linked to the app on its machine shares the app's identity but must never rename or re-platform it.
  if (platform === 'web' && APP_PLATFORMS.has(device.platform)) return device;
  const name = sentName || device.name;
  const nextPlatform = explicitPlatform(req, url) || (isNew ? platform : device.platform);
  const changed = isNew || device.name !== name || device.platform !== nextPlatform;
  const profile = APP_PLATFORMS.has(nextPlatform) ? profileOf(req, url) : '';
  const newProfile = Boolean(profile) && device.profile !== profile;
  if (profile) device.profile = profile;
  const appVersion = APP_PLATFORMS.has(nextPlatform) ? appVersionOf(req, url) : '';
  const newVersion = Boolean(appVersion) && device.appVersion !== appVersion;
  if (newVersion) {
    log.info(`${name} ${device.appVersion ? `now runs Beam ${appVersion} (was ${device.appVersion})` : `runs Beam ${appVersion}`}`);
    device.appVersion = appVersion;
    // An update that didn't install there is over once it runs that version or a later one.
    if (device.status?.update && versionAtLeast(appVersion, device.status.update.version)) delete device.status.update;
    pilotRuns(device); // (1.19) the PC trying a new build first now runs it
  }
  device.name = name;
  device.platform = nextPlatform;
  device.machine = machineOf(req);
  delete device.ip;
  if (changed || newProfile || newVersion || now() - lastDeviceSave > 60_000) {
    lastDeviceSave = now();
    persistDevices();
  }
  if (changed) broadcastDevices();
  noteSharedAddress(req, device);
  return linkSameMachine(device);
}

// A browser and a Beam app on the same machine are one device: the browser is merged into the app.
const unmergedNoted = new Set(); // (audit S-2) "old>new" device pairs already logged as not a reinstall
function linkSameMachine(device) {
  if (!device.machine || device.temporary) return device; // a borrowed browser stays separate and temporary
  const recent = d => now() - d.lastSeen < 14 * 86400e3;
  const sameMachine = d => d.id !== device.id && d.machine === device.machine && recent(d);
  if (device.platform === 'web') {
    const app = Object.values(devices)
      .filter(d => sameMachine(d) && APP_PLATFORMS.has(d.platform))
      .sort((a, b) => (GUI_PLATFORMS.has(b.platform) - GUI_PLATFORMS.has(a.platform)) || (b.lastSeen - a.lastSeen))[0];
    if (app) {
      mergeDevice(device.id, app.id, 'same machine');
      return app;
    }
  } else if (APP_PLATFORMS.has(device.platform)) {
    for (const web of Object.values(devices).filter(d => sameMachine(d) && d.platform === 'web' && !d.temporary)) mergeDevice(web.id, device.id, 'same machine');
    // A reinstalled (or re-paired) app comes back with a new id: an older app of the same kind on this machine
    // whose app isn't connected any more is that same device, so its history moves to the new id. A browser tab
    // still open as the old app doesn't count, and neither does an app of another user account on this machine.
    // (audit S-2) Only when both apps say which account they're for (X-Beam-Profile) and it's the same one: an app that
    // never said could be another Windows account's. Such a near miss is logged rather than merged.
    if (GUI_PLATFORMS.has(device.platform)) {
      const looksReplaced = d => sameMachine(d) && d.platform === device.platform && !appOnline(d.id) && d.firstSeen < device.firstSeen;
      for (const old of Object.values(devices).filter(looksReplaced)) {
        if (old.profile && device.profile && old.profile === device.profile) mergeDevice(old.id, device.id, 'reinstalled app');
        else if ((!old.profile || !device.profile) && !unmergedNoted.has(`${old.id}>${device.id}`)) {
          unmergedNoted.add(`${old.id}>${device.id}`); // (once per run: this runs on every request)
          log.info(`Didn't take "${old.name}" over as a reinstall of "${device.name}": ${device.profile ? 'the older app' : 'the new app'} didn't say which Windows account it's for (remove the old device by hand if it's this one)`);
        }
      }
    }
  }
  return device;
}

function mergeDevice(fromId, toId, reason) {
  log.info(`Linked "${nameOf(fromId)}" to "${nameOf(toId)}" (${reason})`);
  endRcSessionsOf([fromId], 'revoked'); // before its streams become the other device's

  aliases[fromId] = toId;
  for (const [a, b] of Object.entries(aliases)) if (b === fromId) aliases[a] = toId;
  const swap = list => [...new Set(list.map(t => (t === fromId ? toId : t)))];
  for (const item of items) {
    if (item.from === fromId) item.from = toId;
    if (item.to?.includes(fromId)) item.to = swap(item.to);
    if (item.delivered?.[fromId]) {
      item.delivered[toId] ??= item.delivered[fromId];
      delete item.delivered[fromId];
    }
  }
  for (const upload of uploads.values()) {
    if (upload.from !== fromId && !upload.to.includes(fromId)) continue;
    if (upload.from === fromId) upload.from = toId;
    upload.to = swap(upload.to);
    saveUploadMeta(upload).catch(() => {});
  }
  let tokensChanged = false;
  for (const t of Object.values(tokenStore.tokens)) {
    if (t.device === fromId) {
      t.device = toId;
      tokensChanged = true;
    }
  }
  if (tokensChanged) persistTokens();
  mergeReadMarks(fromId, toId);
  if (history[fromId]) { // (1.18) a reinstall keeps the PC's history
    const from = history[fromId];
    const to = historyOf(toId);
    to.events = pcHistory.mergeEvents(to.events, from.events, now()).events;
    to.spells = [...to.spells, ...(from.spells || [])].sort((a, b) => a.from - b.from).slice(-300);
    to.alerted = [...new Set([...to.alerted, ...(from.alerted || [])])].slice(-30);
    delete history[fromId];
    persistHistory();
  }
  let appsMoved = false; // (1.21) what a reinstalled PC had installed
  for (const app of apps) {
    if (!app.on[fromId]) continue;
    if (!app.on[toId]) app.on[toId] = app.on[fromId];
    delete app.on[fromId];
    appsMoved = true;
  }
  if (appsMoved) persistApps();
  for (const r of loginRequests.values()) if (r.deviceId === fromId) r.deviceId = toId;
  const open = presence.get(fromId);
  if (open) {
    const into = presenceOf(toId);
    presence.set(toId, { web: into.web + open.web, app: into.app + open.app });
    presence.delete(fromId);
  }
  for (const c of clients) if (c.deviceId === fromId) c.deviceId = toId;
  for (const sources of Object.values(settings.ownerSources || {})) {
    if (sources.devices?.includes(fromId)) sources.devices = [...new Set(sources.devices.map(d => (d === fromId ? toId : d)))];
  }
  if (devices[toId] && !devices[toId].tsNode && devices[fromId]?.tsNode) devices[toId].tsNode = devices[fromId].tsNode;
  if (devices[toId] && !devices[toId].status && devices[fromId]?.status) {
    const { remoteControl, locked, ...status } = devices[fromId].status; // the new app reports those itself
    devices[toId].status = status;
  }
  if (devices[toId] && devices[fromId]?.rcDisable && !devices[toId].rcDisable) {
    devices[toId].rcDisable = devices[fromId].rcDisable;
    sendTo(new Set([toId]), 'rc-disable', { from: devices[toId].rcDisable.from, by: whoName(devices[toId].rcDisable.from) });
  }
  if (devices[toId] && devices[fromId]?.settings?.phoneNotifications && !devices[toId].settings?.phoneNotifications) {
    devices[toId].settings = { ...devices[toId].settings, phoneNotifications: true };
  }
  // (1.8.1) The old install's settings backups go along: a reinstalled app offers to restore them.
  if (devices[toId] && devices[fromId]?.backups?.length) devices[toId].backups = mergedBackups(devices[toId].backups, devices[fromId].backups);
  dropPhoneNotes(fromId);
  if (settings.alerts?.offline?.includes(fromId)) {
    settings.alerts.offline = [...new Set(settings.alerts.offline.map(id => (id === fromId ? toId : id)))];
    persistSettings();
  }
  stopOfflineWatch(fromId);
  delete devices[fromId];
  itemsRewritten();
  persistDevices();
  persistAliases();
  broadcastDevices();
  broadcast('refresh', { reason: 'devices-linked', from: fromId, to: toId });
}

function mergeReadMarks(fromId, toId) {
  let changed = false;
  const mine = readMarks[fromId];
  if (mine) {
    const into = (readMarks[toId] ||= {});
    for (const [conv, ts] of Object.entries(mine)) into[conv] = Math.max(into[conv] || 0, ts);
    delete readMarks[fromId];
    changed = true;
  }
  for (const marks of Object.values(readMarks)) {
    if (marks[fromId] !== undefined) {
      marks[toId] = Math.max(marks[toId] || 0, marks[fromId]);
      delete marks[fromId];
      changed = true;
    }
  }
  if (changed) persistRead();
}

// Several Beam apps from one address that isn't a Tailscale address usually means a proxy or Docker port
// mapping hides the real addresses. Say how to fix it (at most hourly).
const sharedAddresses = new Map(); // address -> Map(device id -> last seen)
let sharedWarnedAt = 0;
function noteSharedAddress(req, device) {
  if (!APP_PLATFORMS.has(device.platform) || device.machine) return;
  const ip = clientIp(req);
  if (!ip || isLoopback(ip)) return;
  let seen = sharedAddresses.get(ip);
  if (!seen) sharedAddresses.set(ip, (seen = new Map()));
  seen.set(device.id, now());
  for (const [id, t] of seen) if (now() - t > 3600e3) seen.delete(id);
  if (seen.size >= 3 && now() - sharedWarnedAt > 3600e3) {
    sharedWarnedAt = now();
    log.warn(`${seen.size} Beam apps connect from the same address ${ip}. If Beam is behind a reverse proxy or Docker port mapping, add the proxy's address to BEAM_TRUSTED_PROXIES so Beam sees each device's real address.`);
  }
}

function deviceList() {
  const signedIn = new Set(Object.values(tokenStore.tokens).map(t => t.device).filter(Boolean));
  return Object.values(devices)
    .map(d => {
      const ts = tailscaleOf(d);
      return {
        id: d.id, name: d.name, platform: d.platform, online: isOnline(d.id), lastSeen: d.lastSeen, user: d.user || 'owner',
        ...(d.appVersion && { appVersion: d.appVersion }),
        signedIn: signedIn.has(d.id), ...(d.temporary && { temporary: true }),
        ...(d.status && { status: publicStatus(d.status) }),
        ...(ts && { tailscale: { ...ts, ...tsStateOf(ts.ip) } }), // (1.17: + online, lastSeen, keyExpiry, expired)
        can: capabilitiesOf(d, ts),
        settings: { phoneNotifications: d.settings?.phoneNotifications === true },
        // (1.8.1) when its app last backed up its settings (only that: the settings are at /backups)
        ...(d.backups?.length && { backup: { at: d.backups[0].at, app: d.backups[0].app } }),
      };
    })
    .sort((a, b) => (b.online - a.online) || (b.lastSeen - a.lastSeen));
}

let devicesTimer;
function broadcastDevices() {
  clearTimeout(devicesTimer);
  devicesTimer = setTimeout(() => broadcast('devices', { devices: deviceList() }), 300);
}

// Forgets a device: its tokens stop working, its streams close, owners learned only through it are dropped.
function forgetDeviceNow(id, reason) {
  endRcSessionsOf([id], 'revoked');
  revokeTokens((h, t) => t.device && resolveAlias(t.device) === id, reason);
  for (const c of clients) if (c.deviceId === id && c.tokenHash) c.res.end();
  delete devices[id];
  for (const [a, b] of Object.entries(aliases)) if (b === id) delete aliases[a];
  if (readMarks[id]) { delete readMarks[id]; persistRead(); }
  if (history[id]) { delete history[id]; persistHistory(); } // (1.18)
  if (apps.some(a => a.on[id])) { for (const a of apps) delete a.on[id]; persistApps(); } // (1.21)
  if (settings.alerts?.offline?.includes(id)) {
    settings.alerts.offline = settings.alerts.offline.filter(d => d !== id);
    persistSettings();
  }
  stopOfflineWatch(id);
  dropOwnerSource(id);
  dropPhoneNotes(id);
  persistAliases();
  persistDevices();
  broadcastDevices();
}

// Targets may be device ids (merged ids are followed) or names; returns ids. Empty = everyone.
function resolveTargets(raw) {
  if (raw === undefined || raw === null) return [];
  let list = raw;
  if (typeof list === 'string') list = list.split(',');
  if (!Array.isArray(list) || !list.every(t => typeof t === 'string')) throw httpError(400, '"to" must be a list of device ids or names, or a comma-separated string');
  const ids = new Set();
  for (let token of list) {
    token = token.trim();
    const id = resolveAlias(token);
    if (devices[id]) { ids.add(id); continue; }
    token = cleanName(token);
    if (!token || /^(all|everyone|\*)$/i.test(token)) continue;
    const byName = Object.values(devices).filter(d => d.name.toLowerCase() === token.toLowerCase());
    if (!byName.length) throw httpError(400, `Unknown device: ${token}`);
    byName.forEach(d => ids.add(d.id));
  }
  return [...ids];
}

function targetsFromRequest(req, url, bodyTo) {
  if (bodyTo !== undefined && bodyTo !== null) return resolveTargets(bodyTo);
  const header = req.headers['x-beam-to'];
  if (header) {
    let value = String(header);
    try { value = decodeURIComponent(value); } catch {}
    return resolveTargets(value);
  }
  return resolveTargets(url.searchParams.get('to') || '');
}

// ---------------------------------------------------------------- owners (Tailscale sign-in)

function addOwner(login, deviceId, how) {
  const known = owners().has(login);
  settings.tailscaleOwners = [...new Set([...(settings.tailscaleOwners || []), login])];
  const sources = (settings.ownerSources ||= {});
  const entry = (sources[login] ||= { since: now(), how, devices: [] });
  if (deviceId && !entry.devices.includes(deviceId)) entry.devices.push(deviceId);
  persistSettings();
  if (!known) {
    log.info(`Tailscale account ${login} is now an owner of this Beam (${how})`);
    broadcast('settings', publicSettings());
  }
}

// Owners learned through a device are forgotten with it (unless another device or a person vouched for them).
function dropOwnerSource(deviceId) {
  let changed = false;
  for (const [login, entry] of Object.entries(settings.ownerSources || {})) {
    if (!entry.devices?.includes(deviceId)) continue;
    entry.devices = entry.devices.filter(d => d !== deviceId);
    if (!entry.devices.length && entry.how === 'learned') {
      settings.tailscaleOwners = (settings.tailscaleOwners || []).filter(l => l !== login);
      delete settings.ownerSources[login];
      log.info(`Tailscale account ${login} is no longer an owner (the device it was learned from was removed)`);
    }
    changed = true;
  }
  for (const [login, entry] of Object.entries(settings.tailscaleSeen || {})) {
    if (!entry.devices.includes(deviceId)) continue;
    entry.devices = entry.devices.filter(d => d !== deviceId);
    if (!entry.devices.length) delete settings.tailscaleSeen[login];
    changed = true;
  }
  if (changed) persistSettings();
}

// (1.7.3, audit S-09) A Tailscale account becomes an owner (every machine of it then signs in by itself) only on
// purpose: the first sign-in on a brand-new Beam, BEAM_TAILSCALE_OWNERS, Settings, or (while a Beam has no owner at
// all) a sign-in made on purpose. Seeing an account isn't enough: a password typed once on a relative's machine
// mustn't let all of that account's machines in. Other accounts that sign in on purpose are noted for Settings.
const ownerChecks = new Map(); // login|device|on purpose -> time checked
function learnOwner(req, deviceId, auth) {
  const header = identityFromHeaders(req);
  if (!header) return;
  const deliberate = rcSignInOk(auth);
  const key = `${header.login}|${deviceId || ''}|${deliberate}`;
  if (now() - (ownerChecks.get(key) || 0) < 10 * 60e3) return;
  ownerChecks.set(key, now());
  if (ownerChecks.size > 1000) ownerChecks.clear();
  verifiedIdentity(req).then(id => {
    if (!id || id.mismatch) return;
    if (deviceId) rememberNode(deviceId, id.tsNode);
    if (owners().has(id.login)) {
      const entry = settings.ownerSources?.[id.login];
      if (deviceId && entry && !entry.devices?.includes(deviceId)) addOwner(id.login, deviceId, entry.how);
      return;
    }
    if (!deliberate) return;
    if (!owners().size) addOwner(id.login, deviceId, 'learned');
    else noteSeenAccount(id.login, deviceId);
  }).catch(() => {});
}

function noteSeenAccount(login, deviceId) {
  const seen = (settings.tailscaleSeen ||= {});
  const entry = seen[login];
  if (entry) {
    entry.last = now();
    if (deviceId && !entry.devices.includes(deviceId)) entry.devices = [...entry.devices, deviceId].slice(-10);
    return persistSettings();
  }
  const logins = Object.keys(seen);
  if (logins.length >= 20) delete seen[logins.reduce((a, b) => (seen[a].last <= seen[b].last ? a : b))];
  seen[login] = { since: now(), last: now(), devices: deviceId ? [deviceId] : [] };
  persistSettings();
  log.info(`Tailscale account ${statusText(login)} signed in on ${whoName(deviceId)}, but its machines don't sign in by themselves (it isn't an owner; Settings → Security can allow it)`);
  broadcast('settings', publicSettings());
}

// ---------------------------------------------------------------- activity log
// What happened, for troubleshooting ("did the phone get it?", "did the laptop update?"): connections, items and
// deliveries, transfers, app updates, clean-ups and an hourly status line. Never message text; file names only.

const BIG_TRANSFER = 50 * 1024 * 1024; // start/finish lines (with speed) for transfers at least this big
const shortId = id => String(id || '').slice(0, 6);
const whoName = (id, fallback) => (id && devices[id]?.name) || fallback || (id ? `device ${shortId(id)}` : 'an unknown sender');
const targetsText = to => (!to?.length ? 'all devices' : to.map(t => whoName(t)).join(', '));

function describeItem(item) {
  if (item.kind === 'text') return `text (${(item.textLength ?? item.text?.length ?? 0).toLocaleString('en-US')} characters)`;
  return `file "${cutText(String(item.name || ''), 80)}" (${formatSize(item.size || 0)})`;
}

function durationText(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ${min % 60} min` : `${Math.round(h / 24)} days`;
}

const speedText = (bytes, ms) => `${formatSize(Math.round(bytes / Math.max(ms / 1000, 0.001)))}/s`;
const percentOf = (part, whole) => (whole ? `${Math.floor((part / whole) * 100)}%` : '0%');

// The app version a client reports (X-Beam-App-Version, `version=` on the event stream, or a Beam/x.y.z user agent).
function appVersionOf(req, url) {
  const raw = String(req.headers['x-beam-app-version'] || url.searchParams.get('version') || /\bBeam\/(\d[\w.+-]*)/.exec(req.headers['user-agent'] || '')?.[1] || '');
  return /^\d+(\.\d+){1,3}([-+][\w.]{1,12})?$/.test(raw) ? raw : '';
}

// Online/offline lines per device. A device that drops and comes back within a minute (a phone switching
// networks, a page reload) is not reported at all.
const onlineSince = new Map(); // device id -> when it came online
const offlinePending = new Map(); // device id -> timer for a pending "went offline" line

function noteOnline(id, req, url) {
  const pending = offlinePending.get(id);
  if (pending) {
    clearTimeout(pending);
    offlinePending.delete(id);
    return;
  }
  endOfflineSpell(id); // (1.18) a spell of 10 minutes or more goes into its history
  onlineSince.set(id, now());
  const d = devices[id];
  const version = appVersionOf(req, url) || d?.appVersion || '';
  // How it connects (1.7.3, audit S-08): https; loopback from this PC itself, which never leaves it (1.7.4: not called
  // plain http any more); or plain http over a network.
  const how = isHttps(req) ? 'https' : !viaTrustedProxy(req) && isLoopback(peerIp(req)) ? 'never leaves this PC' : 'plain http';
  log.info(`${whoName(id)} is online (${d?.platform || 'unknown'}${version ? ` ${version}` : ''}, from ${describeWhereSync(req)}, ${how})`);
}

function noteOffline(id) {
  clearTimeout(offlinePending.get(id));
  const leftAt = now();
  const timer = setTimeout(() => {
    offlinePending.delete(id);
    if (isOnline(id)) return;
    startOfflineSpell(id, leftAt);
    const since = onlineSince.get(id);
    onlineSince.delete(id);
    log.info(`${whoName(id)} went offline${since ? ` after ${durationText(leftAt - since)} online` : ''}`);
    // (1.17) Tailscale notices a machine that lost power or network only after a few minutes: look again then, so its
    // page can say why it's offline.
    setTimeout(() => { if (!isOnline(id)) refreshTailnet(true); }, FAST_TIMEOUTS ? 500 : 4 * 60e3).unref?.();
  }, 60_000);
  timer.unref?.();
  offlinePending.set(id, timer);
}

// Downloads: one line per item and device every 15 minutes (resumed ranges count as the same download).
const downloadSeen = new Map(); // item|device -> time logged

function noteDownload(req, url, item) {
  const deviceId = deviceIdOf(req, url);
  const key = `${item.id}|${deviceId || clientIp(req)}`;
  if (now() - (downloadSeen.get(key) || 0) < 15 * 60e3) return false;
  downloadSeen.set(key, now());
  const resumed = /^bytes=[1-9]\d*-/.test(req.headers.range || '');
  log.info(`${whoName(deviceId, 'A browser')} ${resumed ? 'resumed downloading' : 'is downloading'} ${describeItem(item)} [${shortId(item.id)}]`);
  return true;
}

// Wrong or revoked keys, at most one line per address every 10 minutes.
const badKeyLogged = new Map();
function noteBadKey(req) {
  const ip = clientIp(req);
  if (now() - (badKeyLogged.get(ip) || 0) < 10 * 60e3) return;
  badKeyLogged.set(ip, now());
  log.warn(`Refused a wrong or revoked key from ${describeWhereSync(req)} (an old or signed-out device, or someone guessing)`);
}

// An hourly line to compare against when something seems off, plus a warning when the disk runs low.
async function logStatus() {
  const all = Object.values(devices);
  const online = all.filter(d => isOnline(d.id));
  const disk = await diskInfo().catch(() => null);
  const busyUploads = [...uploads.values()].filter(u => now() - u.touched < 10 * 60e3).length;
  log.info(`Status: ${online.length} of ${all.length} devices online (${online.map(d => d.name).join(', ') || 'none'}); ` +
    `${items.length} items using ${formatSize(storageUsed())}${busyUploads ? `; ${busyUploads} upload${busyUploads > 1 ? 's' : ''} in progress` : ''}` +
    `${noteStats.sharedThisHour ? `; ${noteStats.sharedThisHour} phone notification${noteStats.sharedThisHour > 1 ? 's' : ''} shared` : ''}` +
    `${disk ? `; ${formatSize(disk.free)} free of ${formatSize(disk.total)}` : ''}; up ${durationText(process.uptime() * 1000)}`);
  if (disk && (disk.free < 5 * 1024 ** 3 || disk.free < disk.total * 0.05)) {
    log.warn(`The disk holding Beam's data is almost full: ${formatSize(disk.free)} free. Big files will be refused (507) when it runs out.`);
  }
  noteStats.sharedThisHour = 0;
  for (const [key, at] of downloadSeen) if (now() - at > 3600e3) downloadSeen.delete(key);
  for (const [key, at] of badKeyLogged) if (now() - at > 3600e3) badKeyLogged.delete(key);
}

// ---------------------------------------------------------------- device status, ring, Wake-on-LAN, Remote Desktop
// Apps report their battery, free storage, OS, network adapters (for Wake-on-LAN) and whether Remote Desktop is on.
// MAC addresses stay on the server: they are used to wake a PC and never sent to any client.

// (1.20) startsWithWindows: the PC's Beam app is in Windows' own startup list; startWanted: its user wants it there
// (1.22) model, bootedAt, temperature, throttled: Beam for Linux (a Raspberry Pi first)
const STATUS_FIELDS = new Set(['battery', 'storage', 'os', 'macs', 'remoteDesktop', 'remoteControl', 'locked', 'update', 'startsWithWindows', 'startWanted',
  'model', 'bootedAt', 'temperature', 'throttled']);
// (1.22) What a Raspberry Pi's firmware says about its power and speed (vcgencmd get_throttled), now and since it started.
const THROTTLE_FLAGS = new Set(['undervoltage', 'capped', 'throttled', 'softLimit']);
const HOT_C = 80; // a Pi 4 or 5 slows itself down from 80 °C
// One line of text from a device: no control or direction characters, trimmed.
const statusText = v => typeof v === 'string' ? v.toWellFormed().replace(/[\u0000-\u001f\u007f]/g, ' ').replace(BIDI, '').replace(/\s+/g, ' ').trim() : '';
const MAC = /^([0-9a-f]{2})([:-]?)([0-9a-f]{2})\2([0-9a-f]{2})\2([0-9a-f]{2})\2([0-9a-f]{2})\2([0-9a-f]{2})$/i;

function normalizeMac(value) {
  const m = MAC.exec(String(value ?? '').trim());
  if (!m) return null;
  const bytes = [m[1], m[3], m[4], m[5], m[6], m[7]].map(h => h.toLowerCase());
  // Unset, broadcast and multicast addresses can't belong to a network card.
  if (bytes.every(b => b === '00') || bytes.every(b => b === 'ff') || parseInt(bytes[0], 16) & 1) return null;
  return bytes.join(':');
}

// A status report, validated; null for a field means "no longer known" (e.g. a laptop's battery was removed).
function parseStatus(body) {
  const out = {};
  const bad = message => httpError(400, message);
  for (const [key, value] of Object.entries(body)) {
    if (!STATUS_FIELDS.has(key)) throw bad(`Unknown status field: ${key}`);
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (key === 'battery') {
      if (!isPlainObject(value) || Object.keys(value).some(k => k !== 'level' && k !== 'charging')
        || !Number.isFinite(value.level) || value.level < 0 || value.level > 100
        || (value.charging !== undefined && typeof value.charging !== 'boolean')) {
        throw bad('battery must be {"level": 0-100, "charging": true|false}');
      }
      out.battery = { level: Math.round(value.level), charging: value.charging === true };
    } else if (key === 'storage') {
      if (!isPlainObject(value) || Object.keys(value).some(k => k !== 'free' && k !== 'total')
        || !Number.isSafeInteger(value.free) || !Number.isSafeInteger(value.total) || value.free < 0 || value.total <= 0 || value.free > value.total) {
        throw bad('storage must be {"free": bytes, "total": bytes}');
      }
      out.storage = { free: value.free, total: value.total };
    } else if (key === 'os' || key === 'model') {
      const name = typeof value === 'string' ? value.toWellFormed().replace(/[\u0000-\u001f\u007f]/g, '').replace(BIDI, '').trim() : '';
      if (!name || [...name].length > 60) throw bad(`${key} must be a name of 1 to 60 characters`);
      out[key] = name;
    } else if (key === 'bootedAt') {
      // (1.22) when the device last started, in ms: its "Up since"
      if (!Number.isSafeInteger(value) || value < Date.UTC(2000, 0, 1) || value > now() + 86400e3) throw bad('bootedAt must be a time in milliseconds');
      out.bootedAt = value;
    } else if (key === 'temperature') {
      // (1.22) the CPU's, in °C
      if (typeof value !== 'number' || !Number.isFinite(value) || value < -50 || value > 150) throw bad('temperature must be °C, from -50 to 150');
      out.temperature = Math.round(value * 10) / 10;
    } else if (key === 'throttled') {
      const flags = v => Array.isArray(v) && v.length <= THROTTLE_FLAGS.size && v.every(f => THROTTLE_FLAGS.has(f));
      if (!isPlainObject(value) || Object.keys(value).some(k => k !== 'now' && k !== 'sinceBoot') || !flags(value.now) || !flags(value.sinceBoot)) {
        throw bad(`throttled must be {"now": [...], "sinceBoot": [...]} with ${[...THROTTLE_FLAGS].join(', ')}`);
      }
      out.throttled = { now: [...new Set(value.now)], sinceBoot: [...new Set(value.sinceBoot)] };
    } else if (key === 'macs') {
      const macs = Array.isArray(value) && value.length <= 8 ? value.map(normalizeMac) : [null];
      if (macs.some(m => !m)) throw bad('macs must be a list of up to 8 addresses like aa:bb:cc:dd:ee:ff');
      out.macs = [...new Set(macs)];
    } else if (key === 'remoteDesktop' || key === 'remoteControl' || key === 'locked' || key === 'startsWithWindows' || key === 'startWanted') {
      if (typeof value !== 'boolean') throw bad(`${key} must be true or false`);
      out[key] = value;
    } else if (key === 'update') {
      // (1.6.2) an app update that didn't install there, in the system's words
      const version = statusText(value?.version), problem = statusText(value?.problem);
      if (!isPlainObject(value) || Object.keys(value).some(k => k !== 'version' && k !== 'problem')
        || !/^\d{1,4}(\.\d{1,4}){1,3}$/.test(version) || !problem || [...problem].length > 300) {
        throw bad('update must be {"version": "1.6.2", "problem": "1 to 300 characters"}');
      }
      out.update = { version, problem };
    }
  }
  return out;
}

// What other devices see of a status report (no MAC addresses).
function publicStatus(status) {
  const { battery, storage, os, remoteControl, locked, update, startsWithWindows, startWanted, model, bootedAt, temperature, throttled, at } = status;
  return {
    ...(battery && { battery }), ...(storage && { storage }), ...(os && { os }),
    ...(remoteControl !== undefined && { remoteControl }), ...(locked !== undefined && { locked }), ...(update && { update }),
    ...(startsWithWindows !== undefined && { startsWithWindows }), ...(startWanted !== undefined && { startWanted }), // (1.20)
    ...(model && { model }), ...(bootedAt && { bootedAt }), ...(temperature !== undefined && { temperature }), ...(throttled && { throttled }), // (1.22)
    at: at || 0,
  };
}

function describeStatus(status) {
  const parts = [];
  if (status.os) parts.push(status.os);
  if (status.model) parts.push(status.model);
  if (status.temperature !== undefined) parts.push(`${status.temperature} °C`);
  if (status.throttled?.sinceBoot?.length) parts.push(`since it started: ${status.throttled.sinceBoot.join(', ')}`);
  if (status.battery) parts.push(`battery ${status.battery.level}%${status.battery.charging ? ' (charging)' : ''}`);
  if (status.storage) parts.push(`${formatSize(status.storage.free)} free of ${formatSize(status.storage.total)}`);
  if (status.remoteDesktop !== undefined) parts.push(`Remote Desktop ${status.remoteDesktop ? 'on' : 'off'}`);
  if (status.remoteControl !== undefined) parts.push(`remote control ${status.remoteControl ? 'allowed' : 'off'}`);
  if (status.locked) parts.push('locked');
  if (status.macs?.length) parts.push(`${status.macs.length} network adapter${status.macs.length > 1 ? 's' : ''} for Wake-on-LAN`);
  return parts.join('; ') || 'nothing yet';
}

// The device's Tailscale machine, from the tailnet index: { name, dns, ip } (dns = its MagicDNS name).
function tailscaleOf(device) {
  let ip = null;
  let entry = null;
  if (device.machine === 'host') {
    const self = [...tsIndex].find(([addr, e]) => e.self && net.isIPv4(addr)) || [...tsIndex].find(([, e]) => e.self);
    if (self) [ip, entry] = self;
  } else if (device.machine && tailscale.isTailscaleIp(device.machine)) {
    ip = device.machine;
    entry = tsIndex.get(ip) || null;
  }
  if (!entry && device.tsNode?.ips) {
    const known = device.tsNode.ips.find(a => tsIndex.has(a));
    if (known) [ip, entry] = [known, tsIndex.get(known)];
    else ip ||= device.tsNode.ips.find(a => net.isIPv4(a) && tailscale.isTailscaleIp(a)) || null;
  }
  if (!ip && !entry) return null;
  return { name: entry?.name || device.tsNode?.name || null, dns: entry?.dns || null, ip };
}

// True when a reported app version is at least `min` (numeric parts only; an unknown version is too old).
function versionAtLeast(version, min) {
  if (!version) return false;
  const parts = v => String(v).split(/[-+]/)[0].split('.').map(n => Number(n) || 0);
  const a = parts(version);
  const b = parts(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff > 0;
  }
  return true;
}

// Ringing needs the 1.3 apps: older ones ignore the event, so the button would do nothing.
const RING_MIN_VERSION = '1.3.0';

function capabilitiesOf(device, ts = tailscaleOf(device)) {
  return {
    ring: (device.platform === 'android' || device.platform === 'windows') && versionAtLeast(device.appVersion, RING_MIN_VERSION),
    wake: Boolean(device.status?.macs?.length),
    remoteDesktop: device.platform === 'windows' && device.status?.remoteDesktop === true && Boolean(ts?.dns || ts?.ip),
    remoteControl: rcAllowed(device) && device.status?.locked !== true,
    log: canSendLog(device), // (1.20) its Beam app sends its log when asked
    apps: canInstallApps(device), // (1.21) its Beam app installs Beam's apps (once allowed there)
  };
}

// Status reports can come often (a laptop's battery); the device list goes out at most every 5 s for them.
let statusBroadcastAt = 0;
let statusBroadcastTimer = null;
function broadcastDevicesThrottled() {
  const wait = statusBroadcastAt + 5000 - now();
  if (wait <= 0) {
    statusBroadcastAt = now();
    return broadcastDevices();
  }
  statusBroadcastTimer ??= setTimeout(() => {
    statusBroadcastTimer = null;
    statusBroadcastAt = now();
    broadcastDevices();
  }, wait);
}

// PUT /api/devices/me/status: the calling device reports what it knows; fields it leaves out stay as they were.
async function putStatus(req, res, _m, url) {
  const id = deviceIdOf(req, url);
  const device = id && devices[id];
  if (!device) throw httpError(400, 'X-Beam-Device-Id is required');
  const changes = parseStatus(await readJson(req, { optional: true }));
  await rcStatusFrom(device, req, url, changes);
  const first = !device.status;
  const allowed = device.status?.remoteControl === true;
  const { update } = changes;
  if (update && (update.version !== device.status?.update?.version || update.problem !== device.status?.update?.problem)) {
    log.warn(`${device.name} couldn't install Beam ${update.version}: ${update.problem}`);
    pilotProblem(device, update); // (1.19) on the PC trying it first: it goes no further
  }
  const status = { ...(device.status || {}) };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete status[key];
    else status[key] = value;
  }
  status.at = now();
  device.status = status;
  if (first) log.info(`${device.name} reports its status: ${describeStatus(status)}`);
  if (changes.remoteControl === true && !device.rcMachine) await rcBind(device, req, url);
  if (changes.remoteControl !== undefined) rcSwitchReported(device, allowed);
  checkStatusAlerts(device);
  persistDevices();
  broadcastDevicesThrottled();
  send(res, 204);
}

function targetDevice(id) {
  const device = devices[resolveAlias(id)];
  if (!device) throw httpError(404, 'No such device');
  return device;
}

// POST /api/devices/{id}/ring: every client hears it; only the target rings (or stops ringing).
async function ringDevice(req, res, [id], url) {
  const target = targetDevice(id);
  const body = await readJson(req, { optional: true });
  const unknown = Object.keys(body).filter(k => k !== 'stop');
  if (unknown.length) throw httpError(400, `Can't use ${unknown.join(', ')} here`);
  if (body.stop !== undefined && typeof body.stop !== 'boolean') throw httpError(400, 'stop must be true or false');
  if (!capabilitiesOf(target).ring) throw httpError(409, `${target.name} can't ring (that needs the Beam app ${RING_MIN_VERSION} or later for Android or Windows)`);
  const stop = body.stop === true;
  const me = deviceIdOf(req, url);
  const by = whoName(me, deviceNameOf(req, url) || 'Beam');
  const online = isOnline(target.id);
  broadcast('ring', { device: target.id, by, from: me || null, stop, at: now() });
  log.info(stop ? `${by} stopped ${target.name} ringing` : `${by} rang ${target.name}${online ? '' : ' (it is offline, so it won\u2019t hear it)'}`);
  send(res, 202, { online });
}

function magicPacket(mac) {
  const bytes = Buffer.from(mac.split(':').map(h => parseInt(h, 16)));
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(bytes)]);
}

// Where magic packets go: the limited broadcast address and each LAN's directed broadcast, on ports 9 and 7.
// BEAM_WOL_TARGETS (address[:port], comma-separated) replaces that list.
function wakeTargets() {
  if (env.BEAM_WOL_TARGETS) {
    return env.BEAM_WOL_TARGETS.split(',').map(s => s.trim()).filter(Boolean).map(entry => {
      const [address, port] = entry.split(':');
      return { address, port: Number(port) || 9 };
    });
  }
  const addresses = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask || a.address.startsWith('169.254.') || tailscale.isTailscaleIp(a.address)) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      addresses.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...addresses].flatMap(address => [9, 7].map(port => ({ address, port })));
}

// Three rounds, 300 ms apart, to every target for every adapter. Resolves to the number of packets sent.
async function sendMagicPackets(macs) {
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, () => {
      socket.setBroadcast(true);
      resolve();
    });
  });
  let sent = 0;
  try {
    const targets = wakeTargets();
    for (let round = 0; round < 3; round++) {
      if (round) await sleep(300);
      for (const mac of macs) {
        const packet = magicPacket(mac);
        for (const target of targets) {
          await new Promise(resolve => socket.send(packet, target.port, target.address, err => {
            if (!err) sent++;
            resolve();
          }));
        }
      }
    }
  } finally {
    socket.close();
  }
  return sent;
}

// POST /api/devices/{id}/wake: Wake-on-LAN. Works only when this server is on the same network as the PC (in
// Docker: host networking) and the PC and its network card have Wake-on-LAN enabled.
async function wakeDevice(req, res, [id], url) {
  const target = targetDevice(id);
  await readJson(req, { optional: true });
  const macs = target.status?.macs || [];
  if (!macs.length) throw httpError(409, `${target.name} hasn't told Beam its network adapters yet (the Beam app on that PC does, once it has run there)`);
  const sent = await sendMagicPackets(macs);
  log.info(`${whoName(deviceIdOf(req, url), 'A device')} sent Wake-on-LAN to ${target.name} (${macs.length} network adapter${macs.length > 1 ? 's' : ''}, ${sent} packets)`);
  send(res, 200, { sent, macs: macs.length });
}

// GET /api/devices/{id}/remote-desktop.rdp: a Remote Desktop connection file for the device's Tailscale address.
function remoteDesktopFile(req, res, [id], url) {
  const target = targetDevice(id);
  const ts = tailscaleOf(target);
  const host = ts?.dns || ts?.ip;
  if (!host || !/^[A-Za-z0-9.:-]{1,253}$/.test(host)) throw httpError(404, `Beam doesn't know an address for ${target.name}`);
  const address = net.isIPv6(host) ? `[${host}]` : host;
  const body = [`full address:s:${address}`, 'prompt for credentials:i:1', 'screen mode id:i:2', ''].join('\r\n');
  log.info(`${whoName(deviceIdOf(req, url), 'A browser')} opened Remote Desktop to ${target.name} (${host})`);
  send(res, 200, body, {
    'Content-Type': 'application/x-rdp',
    'Content-Disposition': contentDisposition('attachment', sanitizeName(`${target.name}.rdp`)),
    'X-Content-Type-Options': 'nosniff',
  });
}

// ---------------------------------------------------------------- alerts
// Low battery or storage on a device, a watched device going offline, and the server's own disk running low.
// Each goes out once (SSE `alert`, data/alerts.json, the activity log and ntfy) and re-arms when things recover.

function alertSettings() {
  const a = settings.alerts || {};
  return {
    battery: a.battery !== false,
    storage: a.storage !== false,
    serverDisk: a.serverDisk !== false,
    tailscaleKey: a.tailscaleKey !== false, // (1.17)
    powerLoss: a.powerLoss !== false, // (1.18) a PC came back from a power loss, a blue screen or a forced power-off
    setup: a.setup !== false, // (1.20) the setup check found something wrong
    hardware: a.hardware !== false, // (1.22) a Raspberry Pi or another Linux computer too hot, or short of power
    offline: Array.isArray(a.offline) ? a.offline.filter(id => typeof id === 'string') : [],
  };
}

function raiseAlert(kind, deviceId, level, text) {
  const alert = { id: crypto.randomBytes(6).toString('hex'), kind, device: deviceId || null, level, text, at: now() };
  alerts.unshift(alert);
  if (alerts.length > MAX_ALERTS) alerts.length = MAX_ALERTS;
  persistAlerts();
  broadcast('alert', alert);
  (level === 'warn' ? log.warn : log.info)(`Alert: ${text}`);
  ntfyPost({ title: level === 'warn' ? 'Beam alert' : 'Beam', message: text, tags: [level === 'warn' ? 'warning' : 'information_source'], priority: level === 'warn' ? 4 : 3 });
  return alert;
}

// Battery: at or below 15 % and not charging alerts once; above 25 % or charging re-arms. Storage: free space under
// max(2 GB, 5 %) alerts once; 20 % more than that re-arms. Crossings are logged even with the alert turned off.
function checkStatusAlerts(device) {
  const status = device.status;
  const enabled = alertSettings();
  const flags = (device.alerted ||= {});
  const battery = status.battery;
  if (battery) {
    if (battery.level <= 15 && !battery.charging && !flags.battery) {
      flags.battery = true;
      const text = `${device.name}'s battery is at ${battery.level}%`;
      if (enabled.battery) raiseAlert('battery', device.id, 'warn', text);
      else log.warn(text);
    } else if ((battery.level > 25 || battery.charging) && flags.battery) {
      flags.battery = false;
    }
  }
  const storage = status.storage;
  if (storage) {
    const limit = Math.max(2 * 1024 ** 3, storage.total * 0.05);
    if (storage.free < limit && !flags.storage) {
      flags.storage = true;
      const text = `${device.name} is running out of storage: ${formatSize(storage.free)} free`;
      if (enabled.storage) raiseAlert('storage', device.id, 'warn', text);
      else log.warn(text);
    } else if (storage.free > limit * 1.2 && flags.storage) {
      flags.storage = false;
    }
  }
  // (1.22) a Raspberry Pi (or another Linux computer) running hot, or its power supply too weak
  const hardware = text => (enabled.hardware ? raiseAlert('hardware', device.id, 'warn', text) : log.warn(text));
  const temp = status.temperature;
  if (Number.isFinite(temp)) {
    if (temp >= HOT_C && !flags.hot) {
      flags.hot = true;
      const slowing = status.throttled?.now?.some(f => f === 'throttled' || f === 'softLimit');
      hardware(`${device.name} is too hot: ${Math.round(temp)} °C${slowing ? ', and it is slowing itself down' : ''}`);
    } else if (temp < HOT_C - 10 && flags.hot) {
      flags.hot = false;
    }
  }
  const power = status.throttled;
  if (power) {
    // Once per start of the device: the firmware remembers it until then.
    const underNow = power.now.includes('undervoltage');
    const under = underNow || power.sinceBoot.includes('undervoltage');
    const boot = status.bootedAt || 1;
    if (under && flags.undervoltage !== boot) {
      flags.undervoltage = boot;
      hardware(`${device.name}'s power supply is too weak: under-voltage ${underNow ? 'right now' : 'since it started'} (it can slow down or restart)`);
    } else if (!under && flags.undervoltage) {
      flags.undervoltage = false;
    }
  }
}

// A watched device that stays offline for 10 minutes raises an alert; coming back raises an "info" one.
const offlineTimers = new Map(); // device id -> timer

function watchOffline(id) {
  if (!alertSettings().offline.includes(id) || devices[id]?.alerted?.offline) return;
  clearTimeout(offlineTimers.get(id));
  const timer = setTimeout(async () => {
    offlineTimers.delete(id);
    await refreshTailnet(true); // (1.17: why, as Tailscale sees it now)
    const device = devices[id];
    if (!device || isOnline(id) || !alertSettings().offline.includes(id) || device.alerted?.offline) return;
    (device.alerted ||= {}).offline = true;
    persistDevices();
    raiseAlert('offline', id, 'warn', `${device.name} has been offline for ${durationText(OFFLINE_ALERT_MS)}${offlineReason(device)}`);
  }, OFFLINE_ALERT_MS);
  timer.unref?.();
  offlineTimers.set(id, timer);
}

function stopOfflineWatch(id) {
  clearTimeout(offlineTimers.get(id));
  offlineTimers.delete(id);
}

// (1.17) Why a device is offline, as Tailscale sees its machine: ": <reason>" for the alert, or '' when it can't tell.
function offlineReason(device) {
  const state = tsStateOf(tailscaleOf(device)?.ip);
  if (!state) return '';
  if (state.expired) return ': its Tailscale sign-in has run out';
  if (state.online) return device.platform === 'windows' ? ': the PC is still on Tailscale, so Beam itself isn\'t running there' : ': it\'s still on Tailscale, so Beam itself isn\'t connected';
  return ': Tailscale can\'t reach it either (off, asleep or without internet)';
}

function backOnline(id) {
  stopOfflineWatch(id);
  const device = devices[id];
  if (!device?.alerted?.offline) return;
  device.alerted.offline = false;
  persistDevices();
  if (alertSettings().offline.includes(id)) raiseAlert('online', id, 'info', `${device.name} is back online`);
}

// The server's own disk: under max(5 GB, 5 %) free alerts at most every 12 hours while it lasts.
async function checkServerDisk() {
  if (!alertSettings().serverDisk) return;
  const disk = await diskInfo();
  if (!disk) return;
  const limit = Math.max(5 * 1024 ** 3, disk.total * 0.05);
  if (disk.free < limit && now() - (settings.serverDiskAlertAt || 0) > SERVER_DISK_REPEAT_MS) {
    settings.serverDiskAlertAt = now();
    persistSettings();
    raiseAlert('serverDisk', null, 'warn', `The Beam server's disk is almost full: ${formatSize(disk.free)} free of ${formatSize(disk.total)}`);
  }
}

function getAlerts(req, res) {
  send(res, 200, { alerts });
}

// ---------------------------------------------------------------- connections (1.17)
// How tailscaled on this server reaches each device's machine (web Settings → Connections): the path it last took
// (seen while they talk, or tested: a few disco pings), Tailscale's own online state, and when each key runs out.

const tsTests = new Map(); // machine key -> the test going on

const pathText = p => (p.via === 'direct' ? (p.lan ? 'direct on the same network' : 'direct over the internet')
  : p.via === 'peer-relay' ? 'through a peer relay' : `through Tailscale's relay${p.relay ? ` (${p.relay})` : ''}`);

// One row per machine, named after its Beam app (a browser on it shares the row): online when any of them is.
// (1.18) Also its latest speed test (any of its devices'), whether its app can be asked for one, and `here` for the
// asking device's own machine (that one tests in its own page).
function connectionList(askingId = null) {
  const machines = new Map(); // machine key -> { t: tailscaleOf, list: [device] }
  for (const d of Object.values(devices)) {
    const t = tailscaleOf(d);
    if (!t?.ip) continue;
    const key = tsIndex.get(t.ip)?.key || t.ip;
    const m = machines.get(key) || { t, list: [] };
    m.list.push(d);
    machines.set(key, m);
  }
  return [...machines].map(([key, { t, list }]) => {
    const d = list.find(x => APP_PLATFORMS.has(x.platform)) || list[0];
    const self = tsFacts.get(t.ip)?.self === true;
    const speed = list.map(x => x.speed).filter(Boolean).sort((a, b) => b.at - a.at)[0] || null;
    return {
      id: d.id, name: d.name, platform: d.platform, online: list.some(x => isOnline(x.id)),
      machine: { name: t.name, ip: t.ip, ...(self && { self: true }), ...tsStateOf(t.ip) },
      path: self ? null : tsPaths.get(key) || null,
      speed, ...(canTestSpeed(d) && { speedTest: true }), ...(askingId && list.some(x => x.id === askingId) && { here: true }),
    };
  }).sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
}

async function getConnections(req, res, _m, url) {
  await refreshTailnet(true);
  const self = [...tsFacts.values()].find(f => f.self);
  send(res, 200, {
    tailscale: Boolean(self),
    ...(self && { server: { name: tsSelfName, keyExpiry: self.keyExpiry, ...(self.expired && { expired: true }) } }),
    machines: connectionList(resolveAlias(deviceIdOf(req, url) || '')),
    at: now(),
  });
}

// POST /api/connections/{id}/test: ping the device's machine now. One test per machine at a time (a second request
// gets the same answer). { path: { via, lan?, relay?, ms, at, tested } }, or { path: null } when nothing answered.
async function testConnection(req, res, [id], url) {
  const target = targetDevice(id);
  await readJson(req, { optional: true });
  const t = tailscaleOf(target);
  if (!t?.ip || ts.source === 'off') throw httpError(409, `Beam doesn't know how to reach ${target.name} over Tailscale`);
  if (tsFacts.get(t.ip)?.self) throw httpError(409, `${target.name} is on this server's own machine`);
  const key = tsIndex.get(t.ip)?.key || t.ip;
  const mine = !tsTests.has(key);
  if (mine) tsTests.set(key, ts.ping(t.ip).catch(() => null).finally(() => tsTests.delete(key)));
  const r = await tsTests.get(key) ?? null;
  const by = whoName(deviceIdOf(req, url), 'A browser');
  if (!r) {
    if (mine) log.info(`${by} tested the connection to ${target.name}: no answer`);
    return send(res, 200, { path: null });
  }
  const path = { via: r.via, ...(r.via === 'direct' && { lan: r.lan }), ...(r.relay && { relay: r.relay }), ms: r.ms, at: now(), tested: true };
  if (mine) {
    tsPaths.set(key, path);
    log.info(`${by} tested the connection to ${target.name}: ${pathText(path)}, ${r.ms} ms`);
  }
  send(res, 200, { path });
}

// ---------------------------------------------------------------- speed tests (1.18)
// How fast Beam's own way is between a device and this server (web Settings → Connections; the user: "we should do the
// history for each pc and the speed test"): the device downloads and uploads test data through the address its
// transfers use, about 3 s each way (64 MB at most each), and reports what it measured, kept as its latest. Another
// device can ask a PC's Beam app (Windows 1.13 or later) to test now: the `speed-test` event, answered with the result.

const SPEED_MAX_BYTES = 64 * MB;
const SPEED_ANSWER_MS = FAST_TIMEOUTS ? 5000 : 60_000;
const SPEED_APP_MIN = '1.13.0';
let speedNoise = null; // 1 MB of random bytes, sent over and over: nothing on the way can compress it
const speedAsks = new Map(); // request id -> { target, done(speed) }

const canTestSpeed = d => d?.platform === 'windows' && versionAtLeast(d.appVersion, SPEED_APP_MIN);

// GET /api/speedtest/down?bytes=N: N bytes of noise (8 MB unless asked; 64 MB at most), never cached.
function speedDown(req, res, _m, url) {
  const bytes = Math.min(SPEED_MAX_BYTES, Math.max(1, Math.floor(Number(url.searchParams.get('bytes')) || 8 * MB)));
  speedNoise ||= crypto.randomBytes(MB);
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  let left = bytes;
  res.once('close', () => { left = 0; });
  const pump = () => {
    while (left > 0) {
      const chunk = left >= MB ? speedNoise : speedNoise.subarray(0, left);
      left -= chunk.length;
      if (!res.write(chunk)) return void res.once('drain', pump);
    }
    if (!res.writableEnded) res.end();
  };
  pump();
}

// POST /api/speedtest/up: reads the body (64 MB at most) and keeps none of it. { bytes }.
async function speedUp(req, res) {
  let bytes = 0;
  await new Promise((resolve, reject) => {
    req.on('data', c => {
      bytes += c.length;
      if (bytes > SPEED_MAX_BYTES) { reject(httpError(413, 'A speed test sends 64 MB at most')); req.destroy(); }
    });
    req.once('end', resolve);
    req.once('error', reject);
    req.once('close', resolve); // (a sender that gave up: nothing to answer)
  });
  send(res, 200, { bytes });
}

// POST /api/speedtest/result { down, up (Mbit/s), id? (when asked) }: what this device measured.
async function speedResult(req, res, _m, url) {
  const d = devices[deviceIdOf(req, url)];
  if (!d) throw httpError(400, 'X-Beam-Device-Id is required');
  const body = await readJson(req);
  const mbps = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e6 ? Math.round(v * 10) / 10 : null);
  const down = mbps(body.down);
  const up = mbps(body.up);
  if (down === null || up === null) throw httpError(400, 'Expected {"down": <Mbit/s>, "up": <Mbit/s>}');
  d.speed = { down, up, at: now() };
  persistDevices();
  log.info(`${d.name} tested its speed to this server: ${down} Mbit/s down, ${up} Mbit/s up`);
  const ask = typeof body.id === 'string' ? speedAsks.get(body.id) : null;
  if (ask && ask.target === d.id) ask.done(d.speed);
  send(res, 200, { speed: d.speed });
}

// POST /api/connections/{id}/speed: asks that device's Beam app (Windows 1.13 or later, online) to test now. { speed },
// or 409 when it can't or didn't finish within a minute (not 504: the apps take that for "the server is unreachable").
async function askSpeedTest(req, res, [id], url) {
  const target = targetDevice(id);
  await readJson(req, { optional: true });
  const by = resolveAlias(deviceIdOf(req, url) || '');
  if (target.id === by) throw httpError(409, 'This device tests its own speed itself');
  if (!canTestSpeed(target)) throw httpError(409, `${target.name} can’t run a speed test when asked (that needs Beam for Windows ${SPEED_APP_MIN} or later)`);
  if (!isOnline(target.id)) throw httpError(409, `${target.name} is offline`);
  if ([...speedAsks.values()].some(a => a.target === target.id)) throw httpError(409, `${target.name} is testing already`);
  const askId = crypto.randomBytes(8).toString('hex');
  log.info(`${whoName(by, 'A browser')} asked ${target.name} for a speed test`);
  const speed = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), SPEED_ANSWER_MS);
    speedAsks.set(askId, { target: target.id, done: s => { clearTimeout(timer); resolve(s); } });
    sendTo(new Set([target.id]), 'speed-test', { id: askId });
  });
  speedAsks.delete(askId);
  if (!speed) throw httpError(409, `${target.name} didn’t finish a speed test within a minute`);
  send(res, 200, { speed });
}

// ---------------------------------------------------------------- each PC's history (1.18)
// What happened to a device, newest first (web: its Device info; the user: "we should do the history for each pc"):
// Windows' records of each restart or shutdown and who asked, power losses, blue screens and sign-ins, and Beam's own
// crashes, sent by the PC's Beam app when it connects (lib/history.js explains them); this server's own PC's, read at
// start (lib/winevents.js), so a power loss here is known before anyone signs in; and the spells Beam saw a device
// offline for 10 minutes or more. A PC that comes back from a power loss, a blue screen or a forced power-off raises a
// `powerLoss` alert (once, and only when Beam learns of it within a day).

const OWN_HISTORY = Boolean(env.BEAM_TEST_OWN_EVENTS) || (process.platform === 'win32' && env.BEAM_OWN_HISTORY !== 'off' && env.BEAM_TAILSCALE !== 'off');
const historyOf = id => (history[id] ||= { events: [], spells: [], alerted: [] });
const keepsSpells = id => APP_PLATFORMS.has(devices[id]?.platform) && devices[id]?.platform !== 'cli';

function startOfflineSpell(id, from) {
  if (!keepsSpells(id)) return;
  historyOf(id).offlineFrom = from;
  persistHistory();
}

function endOfflineSpell(id) {
  const h = history[id];
  if (!Number.isFinite(h?.offlineFrom)) return;
  h.spells = pcHistory.addSpell(h.spells, h.offlineFrom, now(), now());
  delete h.offlineFrom;
  persistHistory();
}

// "2:14 AM", or "Oct 6, 2:14 AM" when it isn't today (this server's time zone: the household's).
function clockText(ms) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date(now()).toDateString() ? time : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

function incidentText(device, e) {
  const back = `started again at ${clockText(e.up)}`;
  const text = e.kind === 'crash' ? `${device.name} crashed with a blue screen${e.detail ? ` (${e.detail.replace(/^Stop code/, 'stop code')})` : ''} and ${back}`
    : e.kind === 'forced-off' ? `${device.name} was forced off with its power button and ${back}`
      : `${device.name} went down without warning${e.down ? ` after ${clockText(e.down)}` : ''} (it lost power or froze) and ${back}`;
  return `${text}.${e.signedIn ? '' : ' Nobody has signed in on it since, so its Beam app isn’t running yet.'}`;
}

// Adds a PC's records to its history; a new power loss, blue screen or forced power-off alerts. Returns how many were new.
function ingestHistory(device, records) {
  const h = historyOf(device.id);
  const { events, added } = pcHistory.mergeEvents(h.events, records, now());
  h.events = events;
  if (!added) return 0;
  const { entries } = pcHistory.explain(h.events, [], { at: now(), days: 2 });
  for (const e of pcHistory.alertable(entries, h.alerted, now())) {
    h.alerted = [...h.alerted, `up:${e.up}`].slice(-30);
    const text = incidentText(device, e);
    if (alertSettings().powerLoss) raiseAlert('powerLoss', device.id, 'warn', text);
    else log.warn(text);
  }
  persistHistory();
  return added;
}

// GET /api/devices/me/history/since: where this PC's next report starts ({ System, Application }: ISO or null).
function getHistorySince(req, res, _m, url) {
  const id = deviceIdOf(req, url);
  if (!devices[id]) throw httpError(400, 'X-Beam-Device-Id is required');
  send(res, 200, pcHistory.sinceOf(history[id]?.events));
}

// POST /api/devices/me/history { events: [{ log, id, provider, time, rec, data }] }: Windows' records on this PC (the
// kinds lib/history.js WANTED lists; others are skipped). { added, since }.
async function postHistory(req, res, _m, url) {
  const device = devices[deviceIdOf(req, url)];
  if (!device) throw httpError(400, 'X-Beam-Device-Id is required');
  const body = await readJson(req, { limit: 4 * MB });
  if (!Array.isArray(body.events) || body.events.length > pcHistory.MAX_REPORT) throw httpError(400, `Expected {"events": [...]} with at most ${pcHistory.MAX_REPORT} records`);
  const added = ingestHistory(device, body.events);
  if (added) log.info(`${device.name} sent ${added} new record${added === 1 ? '' : 's'} for its history`);
  send(res, 200, { added, since: pcHistory.sinceOf(history[device.id]?.events) });
}

// GET /api/devices/{id}/history[?days=30]: { device, name, entries (newest first), up, at }.
function getHistory(req, res, [id], url) {
  const target = targetDevice(id);
  const days = Math.min(120, Math.max(1, Math.floor(Number(url.searchParams.get('days')) || 30)));
  const h = history[target.id];
  // (offline now for 10 minutes or more: that spell too, still going)
  const ongoing = Number.isFinite(h?.offlineFrom) && !isOnline(target.id) && now() - h.offlineFrom >= pcHistory.SPELL_MIN_MS;
  const spells = [...(h?.spells || []), ...(ongoing ? [{ from: h.offlineFrom, until: now() }] : [])];
  const { entries, up } = pcHistory.explain(h?.events || [], spells, { at: now(), days });
  if (ongoing) for (const e of entries) if (e.kind === 'offline' && e.at === h.offlineFrom) e.ongoing = true;
  send(res, 200, { device: target.id, name: target.name, entries, up, at: now() });
}

// This server's own PC (its Beam app's device), whose records the server can read itself.
function ownPc() {
  return Object.values(devices).filter(d => d.machine === 'host' && d.platform === 'windows' && !d.temporary)
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))[0] || null;
}

async function readOwnHistory() {
  const pc = ownPc();
  if (!pc) return;
  const since = pcHistory.sinceOf(history[pc.id]?.events).System;
  const from = since ? Date.parse(since) - 60e3 : now() - 30 * 86400e3;
  const added = ingestHistory(pc, await winevents.readOwnEvents({ since: new Date(from).toISOString(), env }));
  if (added) log.info(`${pc.name} (this server's PC): ${added} new record${added === 1 ? '' : 's'} for its history, from Windows`);
}

// ---------------------------------------------------------------- the setup check (1.20)
// Beam looks at its own setup (web Settings → Server → Setup; the user, 2026-10-07, on my list: after a week where
// Desktop's Beam app hadn't started with Windows for days, and Tailscale wasn't unattended, without anything saying so):
// that the servers start when Windows does, that Tailscale doesn't wait for a sign-in, the https address, backups, disk
// space, every PC on the latest Beam and starting with Windows, Tailscale sign-ins not running out. Two minutes after
// start, every 6 hours and when asked; a check that goes wrong raises a `setup` alert (once, until it's right again).

const SETUP_EVERY_MS = 6 * 3600e3;
// A real install looks by itself (not a test's scratch server: BEAM_SETUP_CHECK=on|off decides otherwise).
const SETUP_AUTO = env.BEAM_SETUP_CHECK ? env.BEAM_SETUP_CHECK === 'on' : env.BEAM_TAILSCALE !== 'off' && !FAST_TIMEOUTS;
let setupState = null; // { checks: [{ id, title, ok: true | false | null, detail, fix? }], at }
let setupRun = null;

const setupItem = (id, title, ok, detail, fix) => ({ id, title, ok, detail, ...(fix && ok === false && { fix }) });
const recentApps = () => windowsApps().filter(d => now() - (d.lastSeen || 0) < 14 * 86400e3);

async function setupChecks() {
  const out = [];
  // the servers start when Windows does (Windows servers: a scheduled task with a boot trigger, as install-windows.ps1
  // -AtBoot makes); not for a test's scratch server unless it brings its own task list
  if ((process.platform === 'win32' && env.BEAM_TAILSCALE !== 'off' && !FAST_TIMEOUTS) || env.BEAM_TEST_BOOT_TASKS) {
    try {
      const tasks = await winsetup.serverTasks({ env });
      const parts = [['Beam', path.join(__dirname, 'server.js')], ...(FAMILY_URL ? [['Beam Family', path.join(__dirname, 'family', 'server.js')]] : [])]
        .map(([name, script]) => { const t = winsetup.taskFor(tasks, script); return { name, ok: Boolean(t?.boot), how: t ? (t.boot ? `task "${t.name}" at boot` : `task "${t.name}", not at boot`) : 'no scheduled task' }; });
      const ok = parts.every(p => p.ok);
      out.push(setupItem('boot', 'The servers start when Windows does', ok, parts.map(p => `${p.name}: ${p.how}`).join('; '),
        'Run scripts\\install-windows.ps1 -AtBoot on this PC (Windows asks once): they then start before anyone signs in.'));
    } catch (err) { out.push(setupItem('boot', 'The servers start when Windows does', null, `Windows' task list couldn't be read (${err.message})`)); }
  }
  // Tailscale doesn't wait for a sign-in (Windows: "Run unattended")
  if (process.platform === 'win32' && ts.source !== 'off') {
    const p = await ts.prefs();
    const ok = p ? p.ForceDaemon === true : null;
    out.push(setupItem('unattended', 'Tailscale runs before anyone signs in', ok, ok === null ? 'tailscaled\'s settings couldn\'t be read' : ok ? 'Run unattended is on' : 'Tailscale connects only once someone signs in to this PC',
      'Tailscale\'s tray icon → Run unattended, or run "tailscale set --unattended" on this PC.'));
  }
  // the https address devices use
  const remote = await publicBase();
  out.push(setupItem('https', 'Devices reach Beam over https', /^https:/.test(remote || '') ? true : remote ? false : null,
    remote ? `At ${remote}` : 'No address known yet (one is learned from the first device that signs in through it)',
    'Share Beam with "tailscale serve" (README: Running it) so every device comes in over https.'));
  // backups
  if (BACKUP_HOURS > 0) {
    const list = await listBackups().catch(() => null);
    const last = list?.[0];
    const age = last ? now() - last.at : null;
    const ok = last ? age < 2 * BACKUP_HOURS * 3600e3 : process.uptime() * 1000 < BACKUP_HOURS * 3600e3 ? null : false;
    out.push(setupItem('backups', 'Backups are recent', ok, last ? `The last one ${durationText(age)} ago, in ${BACKUP_DIR}` : `None yet (every ${BACKUP_HOURS} h into ${BACKUP_DIR})`,
      'Look at Settings → Server → Backups (Back up now) and the server log.'));
  } else {
    out.push(setupItem('backups', 'Backups are recent', false, 'Automatic backups are off (BEAM_BACKUP_HOURS=0)', 'Set BEAM_BACKUP_HOURS (24 is the default) in .env and restart Beam.'));
  }
  // disk space
  const disk = await diskInfo();
  if (disk) {
    const limit = Math.max(5 * 1024 ** 3, disk.total * 0.05);
    out.push(setupItem('disk', 'Room on the server\'s disk', disk.free >= limit, `${formatSize(disk.free)} free of ${formatSize(disk.total)}`, 'Free some space, or lower BEAM_MAX_STORAGE_GB or how long items are kept.'));
  }
  // every PC on the latest Beam for Windows, and starting with Windows
  const offer = (await appUpdates().catch(() => ({}))).windows?.version;
  const pcs = recentApps();
  if (offer && pcs.length) {
    // Behind is a problem only for a PC that's online and was offered it a while ago: not while the build goes to one
    // PC first (or stopped there: the `update` alert said so), not in the half hour after it went to every PC, and not
    // for a PC that's off (it updates when it connects).
    const r = settings.rollout;
    const waiting = Boolean(activeRollout() || r?.halted) || (r?.released && now() - r.released < 30 * 60e3);
    const behind = pcs.filter(d => !versionAtLeast(d.appVersion, offer));
    const stuck = behind.filter(d => isOnline(d.id));
    out.push(setupItem('versions', 'Every PC runs the latest Beam', behind.length === 0 ? true : !waiting && stuck.length ? false : null,
      behind.length ? `${behind.map(d => `${d.name} (${d.appVersion}${isOnline(d.id) ? '' : ', off'})`).join(', ')}: Beam for Windows ${offer} is out${activeRollout() ? ', going to one PC first' : ''}` : `All ${pcs.length} run Beam for Windows ${offer} or later`,
      'An online PC that stays behind may have updates turned off, or skipped this version after it failed there: look at its Beam log.'));
  }
  const told = pcs.filter(d => typeof d.status?.startsWithWindows === 'boolean');
  if (told.length) {
    const off = told.filter(d => d.status.startsWithWindows === false && d.status.startWanted !== false);
    out.push(setupItem('autostart', 'Beam starts with Windows on each PC', off.length === 0,
      off.length ? `Not on ${off.map(d => d.name).join(', ')}` : `On all ${told.length} that say${pcs.length > told.length ? ` (${pcs.length - told.length} more tell with Beam for Windows 1.14)` : ''}`,
      'On that PC: Beam\'s Settings → This PC → "Start Beam when I sign in to Windows" (started normally, not from another app).'));
  }
  // Tailscale sign-ins (keys) of this server's and the devices' machines that run out within 30 days
  const mine = new Set(Object.values(devices).map(d => tailscaleOf(d)?.ip).filter(Boolean));
  const machines = new Map(); // machine name -> its facts (its IPv4 and IPv6 address once)
  for (const [ip, f] of tsFacts) if (f.self || mine.has(ip)) machines.set(tsIndex.get(ip)?.name || ip, f);
  if (machines.size) {
    const soon = [...machines].filter(([, f]) => f.expired || (Number.isFinite(f.keyExpiry) && f.keyExpiry - now() < 30 * 86400e3));
    const first = [...machines.values()].map(f => f.keyExpiry).filter(Number.isFinite).sort((a, b) => a - b)[0];
    out.push(setupItem('keys', 'No Tailscale sign-in runs out soon', soon.length === 0,
      soon.length ? soon.map(([name, f]) => `${name}${f.expired ? ' (ran out)' : ` (${new Date(f.keyExpiry).toISOString().slice(0, 10)})`}`).join(', ') : first ? `The first runs out ${new Date(first).toISOString().slice(0, 10)}` : 'None runs out',
      'Turn off key expiry for PCs that stay put in Tailscale\'s admin console (Machines → … → Disable key expiry).'));
  }
  // Beam Family answers
  if (FAMILY_URL) {
    let ok = false;
    try { ok = (await fetch(`${FAMILY_LOCAL}/api/hello`, { signal: AbortSignal.timeout(5000) })).ok; } catch {}
    out.push(setupItem('family', 'Beam Family answers', ok, ok ? `At ${FAMILY_URL}` : `Nothing answers at ${FAMILY_LOCAL}`, 'Start it (the "Beam Family" task) and look at its log.'));
  }
  return out;
}

// Runs the checks (one run at a time) and alerts each one that went wrong since the last run.
function runSetupCheck() {
  setupRun ||= (async () => {
    try {
      const checks = await setupChecks();
      const alerted = new Set(settings.setupAlerted || []);
      for (const c of checks) {
        if (c.ok === false && !alerted.has(c.id)) {
          alerted.add(c.id);
          const text = `Beam's setup check: “${c.title}” isn't so: ${c.detail}.${c.fix ? ` ${c.fix}` : ''}`;
          if (alertSettings().setup) raiseAlert('setup', null, 'warn', text); else log.warn(text);
        } else if (c.ok === true) alerted.delete(c.id);
      }
      if (JSON.stringify([...alerted]) !== JSON.stringify(settings.setupAlerted || [])) { settings.setupAlerted = [...alerted]; persistSettings(); }
      setupState = { checks, at: now() };
    } catch (err) { log.warn(`The setup check failed: ${err.message}`); }
    return setupState;
  })().finally(() => { setupRun = null; });
  return setupRun;
}

// GET /api/setup[?refresh=1]: { checks, at } (refresh: now, at most every 10 s; the first ask runs them).
async function getSetup(req, res, _m, url) {
  const fresh = url.searchParams.get('refresh') === '1' && now() - (setupState?.at || 0) > (FAST_TIMEOUTS ? 200 : 10_000);
  send(res, 200, (!setupState || fresh ? await runSetupCheck() : setupState) || { checks: [], at: 0 });
}

// ---------------------------------------------------------------- a PC's log, from anywhere (1.20)
// "Beam log" in a PC's Device info: its Beam app (Windows 1.14 or later, online) sends the end of its beam.log (never
// message text, keys or tokens: Beam doesn't log those), which goes straight to the device that asked; nothing is kept
// here. For the History's "Beam crashed" on a PC that's out of reach.

const LOG_APP_MIN = '1.14.0';
const LOG_MAX_BYTES = 1024 * 1024;
const LOG_ANSWER_MS = FAST_TIMEOUTS ? 4000 : 30_000;
const logAsks = new Map(); // request id -> { target, done(log) }

const canSendLog = d => (d?.platform === 'windows' && versionAtLeast(d.appVersion, LOG_APP_MIN))
  || (d?.platform === 'linux' && Boolean(d.appVersion)); // (1.22) Beam for Linux, from its first version

// POST /api/devices/{id}/log: { name, text, size, at }, or 409 when it can't (too old, offline, didn't answer in time).
async function askDeviceLog(req, res, [id], url) {
  const target = targetDevice(id);
  await readJson(req, { optional: true });
  if (authOf(req).session) throw httpError(403, 'A sign-in for this browser session only can’t read a PC’s log');
  if (!canSendLog(target)) throw httpError(409, `${target.name} can’t send its log (that needs Beam for Windows ${LOG_APP_MIN} or later, or Beam for Linux)`);
  if (!isOnline(target.id)) throw httpError(409, `${target.name} is offline`);
  const askId = crypto.randomBytes(8).toString('hex');
  const got = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), LOG_ANSWER_MS);
    logAsks.set(askId, { target: target.id, done: l => { clearTimeout(timer); resolve(l); } });
    sendTo(new Set([target.id]), 'log-request', { id: askId });
  });
  logAsks.delete(askId);
  if (!got) throw httpError(409, `${target.name} didn’t send its log in time`);
  log.info(`${whoName(resolveAlias(deviceIdOf(req, url) || ''), 'A browser')} got ${target.name}'s Beam log (${formatSize(got.size)})`);
  send(res, 200, got, { 'Cache-Control': 'no-store' });
}

// POST /api/devices/me/log { id, name, text }: a PC's answer to a log request.
async function postDeviceLog(req, res, _m, url) {
  const d = devices[deviceIdOf(req, url)];
  if (!d) throw httpError(400, 'X-Beam-Device-Id is required');
  const body = await readJson(req, { limit: LOG_MAX_BYTES * 2 + 4096 });
  const ask = typeof body.id === 'string' ? logAsks.get(body.id) : null;
  if (!ask || ask.target !== d.id) throw httpError(404, 'No such request (it may have timed out)');
  if (typeof body.text !== 'string') throw httpError(400, 'Expected {"id", "name", "text"}');
  const text = body.text.length > LOG_MAX_BYTES ? body.text.slice(-LOG_MAX_BYTES) : body.text;
  ask.done({ name: statusText(body.name).slice(0, 80) || 'beam.log', text, size: Buffer.byteLength(text), at: now() });
  send(res, 204);
}

// ---------------------------------------------------------------- apps on every PC (1.21)
// The user's own apps on their PCs (the user: "i want to be able to easily install it on all my beam devices", for
// their Slate). An app comes from a GitHub repository's latest release (its Windows file, checked against the
// checksum the release publishes when it publishes one), from a file sent here, or from winget (each PC runs winget
// itself). A PC installs it for its signed-in user and never raises itself to administrator (an installer that needs
// that gets Windows' own prompt there), and only once someone at that PC has allowed Beam to: the first request asks
// there (Install, Always allow, Not now; the user's choice: "Allow once per PC"). Any device signed in for good may
// add apps and ask; the PCs say how it went. data/apps.json; the files in data/app-files/<id>/.

const APPS_APP_MIN = '1.16.0';
const APP_MAX_BYTES = 2048 * MB;
const APPS_MAX = 50;
const APPS_CHECK_MS = 6 * 3600e3;
const GITHUB_API = (env.BEAM_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
const APP_ID = /^[a-f0-9]{8}$/;
const APP_KINDS = new Set(['github', 'file', 'winget']);
// pending: asked here, not yet there (offline: asked when it connects); asked: waiting for someone at the PC to allow
// it; removing: asked to uninstall. The rest come from the PC.
const APP_ON_STATES = new Set(['pending', 'asked', 'installing', 'installed', 'failed', 'declined', 'removing']);
const APP_REPORTS = new Set(['asked', 'installing', 'installed', 'failed', 'declined', 'removed']);
const appFetches = new Map(); // app id -> the GitHub fetch under way

const canInstallApps = d => d?.platform === 'windows' && versionAtLeast(d.appVersion, APPS_APP_MIN);

// Only well-formed apps, and per device only the states above; an app whose first fetch a restart cut short says so
// (Check again fetches it).
function validateApps(list) {
  const out = [];
  const str = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);
  for (const a of Array.isArray(list) ? list : []) {
    if (!isPlainObject(a) || !APP_ID.test(a.id) || !APP_KINDS.has(a.kind) || typeof a.name !== 'string' || out.some(x => x.id === a.id)) continue;
    const f = a.file;
    const file = isPlainObject(f) && typeof f.name === 'string' && f.name && appsLib.safeFileName(f.name) === f.name && appsLib.fileTypeOf(f.name) === f.type
      && Number.isSafeInteger(f.size) && f.size > 0 && /^[a-f0-9]{64}$/.test(f.sha256 || '') ? { name: f.name, size: f.size, sha256: f.sha256, type: f.type } : null;
    if (a.kind === 'file' && !file) continue;
    const on = {};
    for (const [d, s] of Object.entries(isPlainObject(a.on) ? a.on : {})) {
      if (!DEVICE_ID.test(d) || !isPlainObject(s) || !APP_ON_STATES.has(s.state)) continue;
      on[d] = { state: s.state, at: Number(s.at) || 0, ...(str(s.version, 40) && { version: str(s.version, 40) }), ...(str(s.error, 300) && { error: str(s.error, 300) }) };
    }
    const ready = a.kind === 'winget' || Boolean(file);
    out.push({
      id: a.id, kind: a.kind, name: appsLib.appName(a.name) || 'App', source: str(a.source, 200), version: str(a.version, 40), file,
      state: ready ? 'ready' : 'failed', ...(!ready && { error: str(a.error, 300) || 'Beam restarted while it was fetching it: Check again' }),
      ...(str(a.asset, 200) && { asset: str(a.asset, 200) }), ...(str(a.run, 200) && { run: str(a.run, 200) }), ...(str(a.args, 300) && { args: str(a.args, 300) }),
      ...(Array.isArray(a.choices) && { choices: a.choices.filter(c => typeof c === 'string').slice(0, 8) }),
      ...(a.kind === 'github' && { checksum: str(a.checksum, 200) }), ...(str(a.checkError, 300) && { checkError: str(a.checkError, 300) }),
      addedBy: str(a.addedBy, 64), addedAt: Number(a.addedAt) || 0, checkedAt: Number(a.checkedAt) || 0, updatedAt: Number(a.updatedAt) || 0, on,
    });
  }
  return out;
}

function appById(id) {
  const app = apps.find(a => a.id === id);
  if (!app) throw httpError(404, 'No such app');
  return app;
}

// Who may add, change, install and remove apps: a device signed in for good (not for a browser session only).
function appsCaller(req, url) {
  if (authOf(req).session) throw httpError(403, 'A sign-in for this browser session only can’t manage apps', { reason: 'temporary' });
  const me = resolveAlias(deviceIdOf(req, url) || '');
  if (devices[me]?.temporary) throw httpError(403, 'A device signed in for this session only can’t manage apps', { reason: 'temporary' });
  return me;
}

function publicApp(a) {
  const on = {};
  for (const [d, s] of Object.entries(a.on || {})) if (devices[d]) on[d] = s;
  return {
    id: a.id, kind: a.kind, name: a.name, source: a.source, version: a.version, file: a.file, state: a.state,
    ...(a.asset && { asset: a.asset }), ...(a.run && { run: a.run }), ...(a.args && { args: a.args }),
    ...(a.error && { error: a.error }), ...(a.checkError && { checkError: a.checkError }), ...(a.choices && { choices: a.choices }),
    ...(a.kind === 'github' && { checksum: a.checksum || null }),
    addedAt: a.addedAt, addedBy: a.addedBy, checkedAt: a.checkedAt || 0, updatedAt: a.updatedAt || 0, on,
  };
}

const broadcastApps = () => broadcast('apps', { at: now() });

function newApp({ kind, name, source, by }) {
  let id;
  do id = crypto.randomBytes(4).toString('hex'); while (apps.some(a => a.id === id));
  return { id, kind, name, source, version: null, file: null, state: 'ready', addedBy: by || null, addedAt: now(), checkedAt: 0, updatedAt: 0, on: {} };
}

// A release's files come from GitHub's own addresses only (and in tests the stand-in API's), at every redirect.
function githubAllowed(u) {
  let url;
  try { url = new URL(u); } catch { return false; }
  if (env.BEAM_GITHUB_API && url.origin === new URL(GITHUB_API).origin) return true;
  return url.protocol === 'https:' && (url.hostname === 'github.com' || url.hostname === 'api.github.com' || url.hostname.endsWith('.githubusercontent.com'));
}

async function githubFetch(u, { timeoutMs = 20_000, accept = 'application/octet-stream' } = {}) {
  let url = u;
  for (let hop = 0; hop < 6; hop++) {
    if (!githubAllowed(url)) throw new Error(`Beam only downloads from GitHub, not ${(() => { try { return new URL(url).host; } catch { return 'that address'; } })()}`);
    const res = await fetch(url, {
      redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: accept, 'User-Agent': `Beam/${VERSION}`, 'X-GitHub-Api-Version': '2022-11-28' },
    });
    const to = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!to) return res;
    res.body?.cancel().catch(() => {});
    url = new URL(to, url).href;
  }
  throw new Error('GitHub redirected too many times');
}

async function githubJson(pathname) {
  const res = await githubFetch(`${GITHUB_API}${pathname}`, { accept: 'application/vnd.github+json' });
  if (res.status === 404) throw new Error('GitHub has no published release for it (or the repository is private)');
  if (res.status === 403 || res.status === 429) throw new Error('GitHub’s limit of requests for this hour was reached: try again later');
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res.json();
}

async function githubText(u) {
  const res = await githubFetch(u);
  if (!res.ok) throw new Error(`its checksum file: GitHub answered ${res.status}`);
  const text = await res.text();
  if (text.length > 1e6) throw new Error('its checksum file is too big');
  return text;
}

// A file into data/app-files/<id>/ (in place of an older version once it's whole), its SHA-256 worked out on the way:
// { name, size, sha256, type }. `expected`: the SHA-256 it must have (a release's own); idleMs: how long the input
// may send nothing.
async function storeAppFile(app, input, name, { expected = null, declared = 0, idleMs = 0 } = {}) {
  const disk = await diskInfo();
  if (disk && declared + DISK_MARGIN > disk.free) throw httpError(507, `Not enough space on the Beam server for ${name} (${formatSize(declared)})`);
  const dir = path.join(DIR.appFiles, app.id);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const part = path.join(dir, `.incoming-${crypto.randomBytes(4).toString('hex')}`);
  const hash = crypto.createHash('sha256');
  let size = 0;
  const idle = idleMs ? setTimeout(() => input.destroy(new Error('nothing arrived for a minute')), idleMs) : null;
  try {
    const count = new Transform({
      transform(chunk, _enc, cb) {
        idle?.refresh();
        size += chunk.length;
        if (size > APP_MAX_BYTES) return cb(httpError(413, `An app's file is ${formatSize(APP_MAX_BYTES)} at most`));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    await pipeline(input, count, fs.createWriteStream(part, { mode: 0o600 }));
    clearTimeout(idle);
    const sha256 = hash.digest('hex');
    if (!size) throw httpError(400, `${name} is empty`);
    if (expected && sha256 !== expected) throw httpError(422, `${name} doesn't match the SHA-256 its release publishes`);
    const fh = await fsp.open(part, 'r+');
    try { await fh.sync(); } finally { await fh.close(); }
    await fsp.rename(part, path.join(dir, name));
    for (const f of await fsp.readdir(dir)) if (f !== name && !f.startsWith('.incoming-')) await fsp.rm(path.join(dir, f), { force: true }); // (the old version's)
    return { name, size, sha256, type: appsLib.fileTypeOf(name) };
  } catch (err) {
    clearTimeout(idle);
    await fsp.rm(part, { force: true }).catch(() => {});
    throw err;
  }
}

// An app from GitHub: its latest release's Windows file (the one named `asset` when chosen), checked against the
// release's checksum when it publishes one. A new version goes to the PCs that have the app. In the background:
// an `apps` event when it's done.
function fetchGithubApp(app) {
  if (appFetches.has(app.id)) return appFetches.get(app.id);
  const run = (async () => {
    const was = app.state;
    try {
      const [owner, repo] = app.source.split('/');
      const release = await githubJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`);
      const version = appsLib.versionOfTag(release?.tag_name);
      const { asset, candidates } = appsLib.pickAsset(release, repo, app.asset);
      app.checkedAt = now();
      if (!asset) throw new Error(app.asset ? `its latest release (${release?.tag_name || '?'}) has no ${app.asset}` : `its latest release (${release?.tag_name || '?'}) has no Windows file (.exe, .msi or .zip)`);
      if (candidates.length > 1 && !app.asset) app.choices = candidates.slice(0, 8).map(a => a.name);
      else delete app.choices;
      const name = appsLib.safeFileName(asset.name);
      if (!name) throw new Error(`its file's name (${asset.name}) won't do`);
      if (app.file && app.version === version && app.file.name === name) { // nothing new
        delete app.checkError;
        app.state = 'ready';
        return;
      }
      if (Number.isFinite(asset.size) && asset.size > APP_MAX_BYTES) throw new Error(`${asset.name} is over ${formatSize(APP_MAX_BYTES)}`);
      const sums = appsLib.checksumAsset(release, asset.name);
      const expected = sums ? appsLib.checksumIn(await githubText(sums.browser_download_url), asset.name) : null;
      if (sums && !expected) throw new Error(`${sums.name} doesn't give ${asset.name}'s SHA-256`);
      const res = await githubFetch(asset.browser_download_url, { timeoutMs: 30 * 60e3 });
      if (!res.ok || !res.body) throw new Error(`downloading ${asset.name}: GitHub answered ${res.status}`);
      const old = app.version;
      const file = await storeAppFile(app, Readable.fromWeb(res.body), name, { expected, declared: Number(asset.size) || 0 });
      if (!apps.includes(app)) { // (removed from Beam while it downloaded: nothing of it stays)
        await fsp.rm(path.join(DIR.appFiles, app.id), { recursive: true, force: true }).catch(() => {});
        return;
      }
      app.file = file;
      app.version = version || null;
      app.checksum = sums ? sums.name : null;
      app.state = 'ready';
      app.updatedAt = now();
      delete app.error;
      delete app.checkError;
      log.info(`${app.name} ${version || ''}: ${name} (${formatSize(app.file.size)}) fetched from GitHub ${app.source}${expected ? `, matching the SHA-256 in ${sums.name}` : ' (its release publishes no checksum)'}`);
      if (old && old !== app.version) updateInstalled(app);
    } catch (err) {
      app.checkedAt = now();
      const why = String(err?.message || err).slice(0, 300);
      if (was === 'ready' && app.file) app.checkError = why; // (the version it has stays installable)
      else { app.state = 'failed'; app.error = why; }
      log.warn(`${app.name}: couldn't get its latest release from GitHub ${app.source}: ${why}`);
    } finally {
      appFetches.delete(app.id);
      persistApps();
      broadcastApps();
    }
  })();
  appFetches.set(app.id, run);
  return run;
}

// Every 6 hours (and 3 minutes after a start): a new release of each GitHub app.
function checkGithubApps() {
  for (const a of apps) if (a.kind === 'github' && now() - (a.checkedAt || 0) > APPS_CHECK_MS - 60e3) fetchGithubApp(a);
}

// A new version: each PC that has the app (installed through Beam, or found there) gets it too. A PC that updated it
// itself (Slate does) only says so.
function updateInstalled(app) {
  const ids = Object.entries(app.on || {}).filter(([d, s]) => s.state === 'installed' && canInstallApps(devices[d])).map(([d]) => d);
  if (!ids.length) return;
  for (const d of ids) app.on[d] = { ...app.on[d], state: 'pending', at: now() };
  persistApps();
  sendTo(new Set(ids), 'app-install', { id: app.id, update: true });
  log.info(`${app.name} ${app.version || ''}: offered to ${ids.map(d => devices[d].name).join(', ')}, which have it`);
}

// GET /api/apps: { apps } (every signed-in device: the Apps page).
function listApps(req, res) {
  send(res, 200, { apps: apps.map(publicApp) }, { 'Cache-Control': 'no-store' });
}

// POST /api/apps { github: "owner/repo" or a github.com address, asset?, name? } | { winget: "Publisher.App", name? }:
// 201 { app }. A GitHub app is fetched in the background (state "fetching" until then).
async function addApp(req, res, _m, url) {
  const me = appsCaller(req, url);
  const body = await readJson(req);
  if (apps.length >= APPS_MAX) throw httpError(409, `Beam keeps ${APPS_MAX} apps at most`);
  let app;
  if (body.github !== undefined) {
    const repo = appsLib.parseGithubRepo(body.github);
    if (!repo) throw httpError(400, 'github must be "owner/repo" or a github.com address');
    const source = `${repo.owner}/${repo.repo}`;
    if (apps.some(a => a.kind === 'github' && a.source.toLowerCase() === source.toLowerCase())) throw httpError(409, `${repo.repo} is one of Beam's apps already`);
    if (body.asset !== undefined && (typeof body.asset !== 'string' || body.asset.length > 200 || !appsLib.fileTypeOf(body.asset))) throw httpError(400, 'asset must be the name of an .exe, .msi or .zip in the release');
    app = newApp({ kind: 'github', name: appsLib.appName(body.name) || appsLib.appName(repo.repo), source, by: me });
    if (body.asset) app.asset = body.asset;
    app.state = 'fetching';
  } else if (body.winget !== undefined) {
    if (!appsLib.isWingetId(body.winget)) throw httpError(400, 'winget must be a package id, like "7zip.7zip" (winget search shows them)');
    if (apps.some(a => a.kind === 'winget' && a.source.toLowerCase() === body.winget.toLowerCase())) throw httpError(409, `${body.winget} is one of Beam's apps already`);
    app = newApp({ kind: 'winget', name: appsLib.appName(body.name) || appsLib.appName(body.winget.split('.').slice(1).join(' ')) || body.winget, source: body.winget, by: me });
  } else {
    throw httpError(400, 'Expected {"github": "owner/repo"} or {"winget": "Publisher.App"} (a file: PUT /api/apps/file?name=)');
  }
  apps.push(app);
  persistApps();
  log.info(`${whoName(me, 'A device')} added the app ${app.name} (${app.kind === 'github' ? `GitHub ${app.source}` : `winget ${app.source}`})`);
  broadcastApps();
  if (app.kind === 'github') fetchGithubApp(app);
  send(res, 201, { app: publicApp(app) });
}

// PUT /api/apps/file?name=<the file's name>[&label=<the app's name>][&version=][&app=<id>]: the body is an .exe, .msi or
// .zip (2 GB at most): a new app, or (app=) a new version of a file app. 201 { app }.
async function putAppFile(req, res, _m, url) {
  const me = appsCaller(req, url);
  const name = appsLib.safeFileName(url.searchParams.get('name'));
  if (!name || !appsLib.fileTypeOf(name)) throw httpError(400, 'name must be the name of an .exe, .msi or .zip file');
  const declared = Number(req.headers['content-length']) || 0;
  if (declared > APP_MAX_BYTES) throw httpError(413, `An app's file is ${formatSize(APP_MAX_BYTES)} at most`);
  const id = url.searchParams.get('app');
  const existing = id ? appById(id) : null;
  if (existing && existing.kind !== 'file') throw httpError(409, `${existing.name} comes from ${existing.kind === 'github' ? 'GitHub' : 'winget'}, not from a file`);
  if (!existing && apps.length >= APPS_MAX) throw httpError(409, `Beam keeps ${APPS_MAX} apps at most`);
  const app = existing || newApp({ kind: 'file', name: appsLib.appName(url.searchParams.get('label')) || appsLib.appName(name.replace(/\.[^.]+$/, '')) || 'App', source: null, by: me });
  // (an upload route: no 30 s limit for the whole body, but 60 s without data ends it)
  const file = await storeAppFile(app, req, name, { declared, idleMs: BODY_IDLE_MS });
  const version = (url.searchParams.get('version') || '').trim().replace(/[^\w.+-]/g, '').slice(0, 40) || null;
  app.file = file;
  app.version = version;
  app.updatedAt = now();
  if (!existing) apps.push(app);
  persistApps();
  log.info(`${whoName(me, 'A device')} ${existing ? 'sent a new version of' : 'added'} the app ${app.name}${version ? ` ${version}` : ''} (${name}, ${formatSize(file.size)})`);
  broadcastApps();
  if (existing) updateInstalled(app);
  send(res, existing ? 200 : 201, { app: publicApp(app) });
}

// PATCH /api/apps/{id} { name?, run?, args?, asset? }: its name; the program in a .zip that the shortcut starts (run);
// the switches a setup program is run with (args); another of a GitHub release's files (asset: fetched again).
async function editApp(req, res, [id], url) {
  appsCaller(req, url);
  const app = appById(id);
  const body = await readJson(req);
  if (body.name !== undefined) app.name = appsLib.appName(body.name) || app.name;
  if (body.run !== undefined) {
    if (body.run !== null && (typeof body.run !== 'string' || body.run.length > 200 || !/\.exe$/i.test(body.run) || /(^|[\\/])\.\.([\\/]|$)|^[\\/]|:/.test(body.run))) throw httpError(400, 'run must be the path of an .exe inside the .zip');
    if (body.run) app.run = body.run.replace(/\\/g, '/'); else delete app.run;
  }
  if (body.args !== undefined) {
    if (body.args !== null && (typeof body.args !== 'string' || body.args.length > 300 || /[\r\n\0]/.test(body.args))) throw httpError(400, 'args must be one line of switches');
    if (body.args) app.args = body.args.trim(); else delete app.args;
  }
  let refetch = false;
  if (body.asset !== undefined) {
    if (app.kind !== 'github') throw httpError(400, 'Only an app from GitHub has a release to pick a file from');
    if (body.asset !== null && (typeof body.asset !== 'string' || body.asset.length > 200 || !appsLib.fileTypeOf(body.asset))) throw httpError(400, 'asset must be the name of an .exe, .msi or .zip in the release');
    if ((body.asset || null) !== (app.asset || null)) {
      if (body.asset) app.asset = body.asset; else delete app.asset;
      app.file = null;
      app.version = null;
      app.state = 'fetching';
      refetch = true;
    }
  }
  persistApps();
  broadcastApps();
  if (refetch) fetchGithubApp(app);
  send(res, 200, { app: publicApp(app) });
}

// DELETE /api/apps/{id}: gone from Beam and its file from the server (the PCs keep what they installed: Uninstall
// first to remove it there).
async function deleteApp(req, res, [id], url) {
  const me = appsCaller(req, url);
  const app = appById(id);
  apps = apps.filter(a => a !== app);
  persistApps();
  await fsp.rm(path.join(DIR.appFiles, app.id), { recursive: true, force: true }).catch(() => {});
  log.info(`${whoName(me, 'A device')} removed the app ${app.name} from Beam`);
  broadcastApps();
  send(res, 204);
}

// POST /api/apps/{id}/check: a GitHub app's latest release now. { app } once it's done.
async function checkApp(req, res, [id], url) {
  appsCaller(req, url);
  const app = appById(id);
  if (app.kind !== 'github') throw httpError(400, 'Only an app from GitHub has releases to check');
  if (app.state !== 'ready') app.state = 'fetching';
  broadcastApps();
  await fetchGithubApp(app);
  send(res, 200, { app: publicApp(app) });
}

// GET /api/apps/{id}/file: the app's file, for the PCs installing it.
async function getAppFile(req, res, [id]) {
  const app = appById(id);
  if (!app.file) throw httpError(404, `${app.name} has no file${app.kind === 'winget' ? ' (winget installs it)' : ' yet'}`);
  await serveFile(req, res, path.join(DIR.appFiles, app.id, app.file.name), app.file.name, 'application/octet-stream', false, { cache: 'no-cache' });
}

// Which PCs a request names: the list, or "all" (every PC that can install apps).
function appTargets(body) {
  if (body.devices === 'all') return Object.values(devices).filter(d => canInstallApps(d) && !d.temporary);
  if (!Array.isArray(body.devices) || !body.devices.length || body.devices.length > 100) throw httpError(400, 'devices must be a list of device ids, or "all"');
  return [...new Set(body.devices.map(x => resolveAlias(String(x))))].map(x => devices[x]).filter(Boolean);
}

// POST /api/apps/{id}/install { devices: [...] | "all" }: each of those PCs (the Windows app 1.16 or later) is asked to
// install it; one that's offline when it connects. { app, asked: [names], cannot: [names] }.
async function installApp(req, res, [id], url) {
  const me = appsCaller(req, url);
  const app = appById(id);
  const body = await readJson(req);
  if (app.state !== 'ready') throw httpError(409, app.state === 'fetching' ? `${app.name} is still being fetched from GitHub` : `${app.name} isn't ready: ${app.error || 'check it again'}`);
  const targets = appTargets(body);
  const can = targets.filter(canInstallApps);
  const cannot = targets.filter(d => !canInstallApps(d)).map(d => d.name);
  if (!can.length) throw httpError(409, `${cannot.length ? `${cannot.join(', ')} can’t install apps` : 'No PC can install apps'} (that needs Beam for Windows ${APPS_APP_MIN} or later)`);
  for (const d of can) app.on[d.id] = { ...(app.on[d.id]?.version && { version: app.on[d.id].version }), state: 'pending', at: now() };
  persistApps();
  sendTo(new Set(can.map(d => d.id)), 'app-install', { id: app.id });
  log.info(`${whoName(me, 'A device')} asked ${can.map(d => d.name).join(', ')} to install ${app.name}${app.version ? ` ${app.version}` : ''}`);
  broadcastApps();
  send(res, 200, { app: publicApp(app), asked: can.map(d => d.name), cannot });
}

// POST /api/apps/{id}/uninstall { devices }: those PCs remove what Beam installed there. { app, asked }.
async function uninstallApp(req, res, [id], url) {
  const me = appsCaller(req, url);
  const app = appById(id);
  const body = await readJson(req);
  const targets = appTargets(body).filter(d => app.on[d.id] && canInstallApps(d));
  if (!targets.length) throw httpError(409, `${app.name} isn't installed on ${body.devices === 'all' ? 'any PC' : 'that PC'} through Beam`);
  for (const d of targets) app.on[d.id] = { ...app.on[d.id], state: 'removing', at: now() };
  persistApps();
  sendTo(new Set(targets.map(d => d.id)), 'app-uninstall', { id: app.id });
  log.info(`${whoName(me, 'A device')} asked ${targets.map(d => d.name).join(', ')} to uninstall ${app.name}`);
  broadcastApps();
  send(res, 200, { app: publicApp(app), asked: targets.map(d => d.name) });
}

// POST /api/devices/me/apps { id, state, version?, error? }: a PC says how an install or a removal went
// (asked: waiting for someone at it to allow it; declined: Not now there).
// PUT /api/devices/me/apps { apps: [{ id, version }] }: what Beam installed there and is still there (at its start).
async function reportApps(req, res, _m, url) {
  const d = devices[deviceIdOf(req, url)];
  if (!d) throw httpError(400, 'X-Beam-Device-Id is required');
  const body = await readJson(req, { limit: 64 * 1024 });
  const ver = v => (typeof v === 'string' && v ? v.trim().slice(0, 40) : null);
  if (req.method === 'PUT') {
    if (!Array.isArray(body.apps)) throw httpError(400, 'Expected {"apps": [{"id", "version"}]}');
    const have = new Map(body.apps.filter(x => isPlainObject(x) && typeof x.id === 'string').slice(0, 200).map(x => [x.id, ver(x.version)]));
    let changed = false;
    for (const app of apps) {
      const s = app.on[d.id];
      if (have.has(app.id)) {
        if (!s || s.state === 'installed' || s.state === 'failed') {
          const next = { state: 'installed', at: s?.state === 'installed' ? s.at : now(), ...(have.get(app.id) && { version: have.get(app.id) }) };
          if (JSON.stringify(next) !== JSON.stringify(s)) { app.on[d.id] = next; changed = true; }
        }
      } else if (s?.state === 'installed') { // (removed there by hand)
        delete app.on[d.id];
        changed = true;
      }
    }
    if (changed) { persistApps(); broadcastApps(); }
    return send(res, 204);
  }
  const app = apps.find(a => a.id === body.id);
  if (!app) throw httpError(404, 'No such app');
  if (!APP_REPORTS.has(body.state)) throw httpError(400, `state must be one of: ${[...APP_REPORTS].join(', ')}`);
  const error = typeof body.error === 'string' && body.error ? statusText(body.error).slice(0, 300) : null;
  if (body.state === 'removed') delete app.on[d.id];
  else app.on[d.id] = { state: body.state, at: now(), ...(ver(body.version) && { version: ver(body.version) }), ...(error && { error }) };
  persistApps();
  broadcastApps();
  const v = ver(body.version) ? ` ${ver(body.version)}` : '';
  if (body.state === 'installed') log.info(`${d.name} installed ${app.name}${v}`);
  else if (body.state === 'removed') log.info(`${d.name} uninstalled ${app.name}`);
  else if (body.state === 'failed') log.warn(`${d.name} couldn't install ${app.name}: ${error || 'no reason given'}`);
  else if (body.state === 'declined') log.info(`Someone at ${d.name} chose not to install ${app.name} now`);
  else if (body.state === 'asked') log.info(`${d.name} asks whoever is there before installing ${app.name}`);
  send(res, 204);
}

// A PC that connects: what it was asked meanwhile (or asked again after a restart there).
function appsOnConnect(c) {
  const d = devices[c.deviceId];
  if (!canInstallApps(d)) return;
  for (const app of apps) {
    const s = app.on[d.id]?.state;
    if (s === 'pending' || s === 'asked') writeTo(c, `event: app-install\ndata: ${JSON.stringify({ id: app.id })}\n\n`);
    else if (s === 'removing') writeTo(c, `event: app-uninstall\ndata: ${JSON.stringify({ id: app.id })}\n\n`);
  }
}

// ---------------------------------------------------------------- phone notifications (1.5)
// A phone shares the notifications of the apps its user picked. Devices with "Show phone notifications" on (the
// audience) see them and can reply, run an action or dismiss; the phone does it and answers. The content lives in
// this process's memory only: never in a file, never in the log (log lines name the app at most). A restart forgets
// everything; a phone sends its active notifications again when the stream's `instance` changes.

const NOTE_MAX_PER_PHONE = 100;
const NOTE_TTL_MS = FAST_TIMEOUTS && env.BEAM_TEST_NOTE_TTL_MS ? Number(env.BEAM_TEST_NOTE_TTL_MS) : 24 * 3600e3;
const NOTE_ANSWER_MS = FAST_TIMEOUTS ? 1500 : 60_000; // a phone that doesn't answer a request in time: "timeout"
const NOTE_BODY_MAX = 16 * 1024;
const ICON_MAX = 300;
const ICON_BYTES = 32 * 1024;
const NOTE_KEY = /^[A-Za-z0-9._~-]{1,200}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const phoneNotes = new Map(); // phone device id -> Map(key -> Notification), oldest change first
const phoneIcons = new Map(); // SHA-256 hex -> PNG, least recently used first
const phoneRequests = new Map(); // request id -> { id, phone, from, kind, keys, app, timer }
const notePuts = new Limiter(20, 1000); // per phone: about 20 changes a second
// Each request from a PC wakes the phone and makes it act (a reply sent N times): per asking device about 5 a second
// (10 at once), and at most 20 waiting for one phone's answer.
const noteAsks = new Limiter(10, 2000);
const NOTE_PENDING_MAX = 20;
const NOTE_LOG_MS = FAST_TIMEOUTS ? 1000 : 60_000; // see logOnce
const sharingPhones = new Set(); // phones that have shared since they last stopped (for the activity log)
const noteStats = { posted: 0, updated: 0, removed: 0, sharedThisHour: 0, requests: { reply: 0, action: 0, dismiss: 0 }, answers: { ok: 0, failed: 0, timeout: 0 } };

const showsNotes = id => devices[id]?.settings?.phoneNotifications === true;
// Who sees a phone's notifications: every device that shows them, except that phone itself.
const audienceOf = phone => new Set(Object.keys(devices).filter(id => id !== phone && showsNotes(id)));
const phoneConnected = phone => [...clients].some(c => c.deviceId === phone && !c.res.destroyed && !c.res.writableEnded);

// Events about notifications go only to the devices concerned (no one else's stream is written to), and are urgent:
// a background stream gets them at once.
function sendTo(ids, event, data) {
  if (!ids.size) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (!c.deviceId || !ids.has(c.deviceId) || c.res.writableEnded || c.res.destroyed) continue;
    c.events++;
    writeTo(c, msg);
  }
}

// Bidi overrides, embeddings and isolates (LRE RLE PDF LRO RLO, LRI RLI FSI PDI) can make text read as something it
// isn't and spill into what is shown around it: they go from everything a phone sends.
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;

// Text from the phone, cut to `max`. kind:
// - 'multiline' (text, lines): line breaks (as \n) and tabs stay; other control characters go;
// - 'line' (title, conversation): one line, line breaks and tabs become spaces;
// - 'label' (the app's name, action titles): one line cleaned like a device name, without bidi marks either. Labels
//   are the only phone strings that reach the activity log, so they can't start a line of their own.
function noteText(value, max, field, kind = 'line') {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw httpError(400, `${field} must be text`);
  let text = value.toWellFormed().replace(BIDI_CONTROLS, '');
  text = kind === 'multiline'
    ? text.replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    : text.replace(/[\t\n\r\u2028\u2029]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  if (kind === 'label') text = text.replace(BIDI, '').trim();
  text = cutText(text, max);
  return kind === 'label' ? text.trimEnd() : text;
}

function parseNotification(body, phone, key) {
  if (typeof body.app !== 'string' || !/^[\w.]{1,200}$/.test(body.app)) throw httpError(400, 'app must be the app\'s package name');
  if (body.icon !== undefined && body.icon !== null && !/^[a-f0-9]{64}$/.test(body.icon)) throw httpError(400, 'icon must be the SHA-256 of the icon PNG (64 lowercase hex digits) or null');
  if (body.lines !== undefined && body.lines !== null && !Array.isArray(body.lines)) throw httpError(400, 'lines must be a list of texts');
  if (body.actions !== undefined && body.actions !== null && !Array.isArray(body.actions)) throw httpError(400, 'actions must be a list');
  if (body.when !== undefined && body.when !== null && !(Number.isFinite(body.when) && body.when >= 0)) throw httpError(400, 'when must be a time in milliseconds');
  if (body.silent !== undefined && typeof body.silent !== 'boolean') throw httpError(400, 'silent must be true or false');
  if (body.posted !== undefined && body.posted !== null && !(Number.isFinite(body.posted) && body.posted >= 0)) throw httpError(400, 'posted must be a time in milliseconds');
  if (body.resent !== undefined && typeof body.resent !== 'boolean') throw httpError(400, 'resent must be true or false');
  const lines = (body.lines || []).map((line, i) => noteText(line, 500, `lines[${i}]`, 'multiline')).slice(-10);
  const actions = [];
  for (const [i, a] of (body.actions || []).slice(0, 3).entries()) {
    if (!isPlainObject(a) || typeof a.id !== 'string' || !/^[\w.-]{1,40}$/.test(a.id)) throw httpError(400, `actions[${i}] needs an id (letters, digits, . _ -; at most 40)`);
    if (a.reply !== undefined && typeof a.reply !== 'boolean') throw httpError(400, `actions[${i}].reply must be true or false`);
    if (actions.some(x => x.id === a.id)) throw httpError(400, `actions[${i}] repeats the id ${a.id}`);
    actions.push({ id: a.id, title: noteText(a.title, 40, `actions[${i}].title`, 'label'), ...(a.reply === true && { reply: true }) });
  }
  return {
    id: `${phone}/${key}`, device: phone, deviceName: devices[phone]?.name || 'Phone',
    app: body.app, appName: noteText(body.appName, 100, 'appName', 'label') || body.app, icon: body.icon || null,
    title: noteText(body.title, 200, 'title'), text: noteText(body.text, 4096, 'text', 'multiline'), lines,
    conversation: noteText(body.conversation, 200, 'conversation') || null,
    when: Number.isFinite(body.when) ? Math.round(body.when) : now(),
    // When the phone posted it (when is the app's own time, e.g. an e-mail's), and whether this is a re-send of one it
    // already shared (after a server restart or a reconnect): clients decide from these whether to alert again.
    posted: Number.isFinite(body.posted) ? Math.round(body.posted) : null,
    silent: body.silent === true, resent: body.resent === true, actions, at: now(),
  };
}

// Drops notifications older than a day (they were never removed: a phone that went away).
function expireNotes() {
  const old = now() - NOTE_TTL_MS;
  for (const [phone, list] of phoneNotes) {
    for (const [key, n] of list) {
      if (n.at >= old) continue;
      list.delete(key);
      sendTo(audienceOf(phone), 'notification-removed', { id: n.id });
    }
    if (!list.size) phoneNotes.delete(phone);
  }
}

function notePhone(req, url) {
  const phone = deviceIdOf(req, url);
  if (!phone || !devices[phone]) throw httpError(400, 'X-Beam-Device-Id is required');
  return phone;
}

function noteKey(raw) {
  let key = raw;
  try { key = decodeURIComponent(raw); } catch {}
  if (!NOTE_KEY.test(key)) throw httpError(400, 'The key must be 1 to 200 letters, digits or . _ ~ -');
  return key;
}

function notePutAllowed(phone) {
  if (notePuts.blocked(phone)) throw Object.assign(httpError(429, 'Too many notification changes; slow down'), { headers: { 'Retry-After': '1' } });
  notePuts.hit(phone);
}

// PUT /api/phone/notifications/{key}: the phone shares (or updates) one notification.
async function putPhoneNotification(req, res, [rawKey], url) {
  const phone = notePhone(req, url);
  const key = noteKey(rawKey);
  notePutAllowed(phone);
  const note = parseNotification(await readJson(req, { limit: NOTE_BODY_MAX }), phone, key);
  expireNotes();
  let list = phoneNotes.get(phone);
  if (!list) phoneNotes.set(phone, (list = new Map()));
  const update = list.delete(key);
  list.set(key, note);
  update ? noteStats.updated++ : (noteStats.posted++, noteStats.sharedThisHour++);
  const audience = audienceOf(phone);
  while (list.size > NOTE_MAX_PER_PHONE) {
    const [oldest, n] = list.entries().next().value;
    list.delete(oldest);
    sendTo(audience, 'notification-removed', { id: n.id });
  }
  if (!sharingPhones.has(phone)) {
    sharingPhones.add(phone);
    const names = [...audience].map(id => nameOf(id));
    log.info(`${whoName(phone)} shares notifications with ${names.length ? names.join(', ') : 'no device yet (none has "Show phone notifications" on)'}`);
  }
  sendTo(audience, 'notification', note);
  send(res, 204);
}

// DELETE /api/phone/notifications/{key}: gone on the phone.
function deletePhoneNotification(req, res, [rawKey], url) {
  const phone = notePhone(req, url);
  const key = noteKey(rawKey);
  notePutAllowed(phone);
  const list = phoneNotes.get(phone);
  const n = list?.get(key);
  if (n) {
    list.delete(key);
    noteStats.removed++;
    sendTo(audienceOf(phone), 'notification-removed', { id: n.id });
  }
  send(res, 204);
}

// DELETE /api/phone/notifications: the phone's switch went off (or it lost notification access).
function clearPhoneNotifications(req, res, _m, url) {
  const phone = notePhone(req, url);
  noteStats.removed += phoneNotes.get(phone)?.size || 0;
  phoneNotes.delete(phone);
  sendTo(audienceOf(phone), 'notification-removed', { device: phone, all: true });
  if (sharingPhones.delete(phone)) log.info(`${whoName(phone)} stopped sharing notifications`);
  send(res, 204);
}

function requireAudience(req, url) {
  const me = deviceIdOf(req, url);
  if (!me || !showsNotes(me)) throw httpError(403, 'Phone notifications are off for this device', { reason: 'off' });
  return me;
}

// GET /api/phone/notifications: for devices that show them.
function listPhoneNotifications(req, res, _m, url) {
  const me = requireAudience(req, url);
  expireNotes();
  const all = [];
  for (const [phone, list] of phoneNotes) if (phone !== me) all.push(...list.values());
  all.sort((a, b) => b.at - a.at);
  send(res, 200, { notifications: all });
}

// PUT /api/phone/icons/{sha256}: an app icon (PNG, at most 32 KB) under the SHA-256 of its bytes.
async function putPhoneIcon(req, res, [hash]) {
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'image/png') throw httpError(415, 'Send the icon as image/png');
  const data = await readBody(req, ICON_BYTES).catch(err => { throw err.status === 413 ? httpError(413, 'Icons can be at most 32 KB') : err; });
  if (data.length < PNG_SIGNATURE.length || !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw httpError(400, "That isn't a PNG");
  if (sha256hex(data) !== hash) throw httpError(400, "The icon's SHA-256 doesn't match its address");
  phoneIcons.delete(hash);
  phoneIcons.set(hash, data);
  while (phoneIcons.size > ICON_MAX) phoneIcons.delete(phoneIcons.keys().next().value);
  send(res, 204);
}

function getPhoneIcon(req, res, [hash]) {
  const data = phoneIcons.get(hash);
  if (!data) return send(res, 404, { error: 'No such icon' });
  phoneIcons.delete(hash);
  phoneIcons.set(hash, data);
  send(res, 200, data, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', ETag: `"${hash}"` });
}

// A request from a PC to the phone (reply, action, dismiss): from a device that shows the notifications, about
// notifications the phone still has, while the phone's event stream is open (nothing else would carry it there).
// Activity-log lines about requests: the first of its kind between two devices goes out at once; more of the same
// within a minute are counted and summed up in one line when the minute is over (a flood is two lines, not hundreds).
const requestLogs = new Map();
function logOnce(key, line, more) {
  const e = requestLogs.get(key);
  if (e) {
    e.count++;
    return;
  }
  log.info(line);
  const entry = { count: 0 };
  entry.timer = setTimeout(() => {
    requestLogs.delete(key);
    if (entry.count) log.info(more(entry.count));
  }, NOTE_LOG_MS);
  entry.timer.unref();
  requestLogs.set(key, entry);
}

const REQUEST_WORDS = { reply: ['reply', 'replies'], action: ['action', 'actions'], dismiss: ['dismissal', 'dismissals'] };

function startPhoneRequest(me, phone, kind, keys, extra) {
  if (!phoneConnected(phone)) throw httpError(409, `${nameOf(phone)} isn't connected to Beam right now`, { reason: 'offline' });
  if (noteAsks.blocked(me)) throw Object.assign(httpError(429, 'Too many requests to the phone; slow down'), { headers: { 'Retry-After': String(noteAsks.retryAfter(me)) } });
  const waiting = [...phoneRequests.values()].filter(r => r.phone === phone);
  if (waiting.length >= NOTE_PENDING_MAX) {
    const free = Math.min(...waiting.map(r => r.started)) + NOTE_ANSWER_MS;
    throw Object.assign(httpError(429, `${nameOf(phone)} hasn't answered ${waiting.length} requests yet; try again in a moment`, { reason: 'busy' }),
      { headers: { 'Retry-After': String(Math.max(1, Math.ceil((free - now()) / 1000))) } });
  }
  noteAsks.hit(me);
  const app = phoneNotes.get(phone)?.get(keys[0])?.appName || 'an app'; // a label (see noteText): safe in the log
  const id = crypto.randomBytes(8).toString('hex');
  const timer = setTimeout(() => finishPhoneRequest(id, false, 'timeout'), NOTE_ANSWER_MS);
  timer.unref();
  phoneRequests.set(id, { id, phone, from: me, kind, keys, app, timer, started: now() });
  noteStats.requests[kind]++;
  sendTo(new Set([phone]), 'notification-request', { request: id, kind, keys, ...extra, from: me, by: nameOf(me) });
  const what = kind === 'reply' ? `replied to a ${app} notification`
    : kind === 'action' ? `used an action on a ${app} notification`
    : keys.length > 1 ? `dismissed ${keys.length} notifications` : `dismissed a ${app} notification`;
  logOnce(`${kind} ${me} ${phone}`, `${whoName(me)} ${what} on ${nameOf(phone)}`,
    n => `${whoName(me)} sent ${nameOf(phone)} ${n} more ${REQUEST_WORDS[kind][n === 1 ? 0 : 1]} in the last minute`);
  return id;
}

function finishPhoneRequest(id, ok, error) {
  const r = phoneRequests.get(id);
  if (!r) return false;
  clearTimeout(r.timer);
  phoneRequests.delete(id);
  noteStats.answers[ok ? 'ok' : error === 'timeout' ? 'timeout' : 'failed']++;
  if (!ok && error === 'timeout') {
    logOnce(`timeout ${r.from} ${r.phone}`, `${nameOf(r.phone)} didn't answer ${whoName(r.from)}'s request in time (${r.kind}, ${r.app})`,
      n => `${nameOf(r.phone)} didn't answer ${n} more of ${whoName(r.from)}'s requests in time`);
  } else if (!ok) {
    logOnce(`failed ${r.from} ${r.phone}`, `${nameOf(r.phone)} couldn't do what ${whoName(r.from)} asked (${r.kind}, ${r.app})`,
      n => `${nameOf(r.phone)} couldn't do ${n} more of ${whoName(r.from)}'s requests`);
  }
  sendTo(new Set([r.from]), 'notification-request-done', { request: id, ok, ...(!ok && { error }) });
  return true;
}

// The notification a PC refers to, as "<phone>/<key>" (the id); checks that the caller may act on it.
function noteFor(req, url, phone, rawKey) {
  const me = requireAudience(req, url);
  const key = noteKey(rawKey);
  const n = phoneNotes.get(phone)?.get(key);
  if (!n || me === phone || n.at < now() - NOTE_TTL_MS) throw httpError(404, 'That notification is gone');
  return { me, key, n };
}

// POST /api/phone/notifications/{id}/reply { action, text }
async function replyPhoneNotification(req, res, [phone, rawKey], url) {
  const { me, key, n } = noteFor(req, url, phone, rawKey);
  const body = await readJson(req, { limit: NOTE_BODY_MAX });
  const unknown = Object.keys(body).filter(k => k !== 'action' && k !== 'text');
  if (unknown.length) throw httpError(400, `Can't use ${unknown.join(', ')} here`);
  if (!n.actions.some(a => a.id === body.action && a.reply)) throw httpError(400, 'action must be one of the notification\'s reply actions');
  if (typeof body.text !== 'string' || !body.text.trim()) throw httpError(400, 'text must be the reply');
  if (body.text.length > 4096) throw httpError(400, 'A reply can be at most 4096 characters');
  const request = startPhoneRequest(me, phone, 'reply', [key], { action: body.action, text: body.text.toWellFormed() });
  send(res, 202, { request });
}

// POST /api/phone/notifications/{id}/action { action }
async function actPhoneNotification(req, res, [phone, rawKey], url) {
  const { me, key, n } = noteFor(req, url, phone, rawKey);
  const body = await readJson(req);
  const unknown = Object.keys(body).filter(k => k !== 'action');
  if (unknown.length) throw httpError(400, `Can't use ${unknown.join(', ')} here`);
  if (!n.actions.some(a => a.id === body.action && !a.reply)) throw httpError(400, 'action must be one of the notification\'s actions (replies use /reply)');
  const request = startPhoneRequest(me, phone, 'action', [key], { action: body.action });
  send(res, 202, { request });
}

// POST /api/phone/notifications/{id}/dismiss
async function dismissPhoneNotification(req, res, [phone, rawKey], url) {
  const { me, key } = noteFor(req, url, phone, rawKey);
  const body = await readJson(req, { optional: true });
  if (Object.keys(body).length) throw httpError(400, `Can't use ${Object.keys(body).join(', ')} here`);
  const request = startPhoneRequest(me, phone, 'dismiss', [key], {});
  send(res, 202, { request });
}

// POST /api/phone/notifications/dismiss { ids: ["<phone>/<key>", ...] } (one phone's, up to 100)
async function dismissPhoneNotifications(req, res, _m, url) {
  const me = requireAudience(req, url);
  const { ids, ...rest } = await readJson(req);
  if (Object.keys(rest).length) throw httpError(400, `Can't use ${Object.keys(rest).join(', ')} here`);
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || !ids.every(id => typeof id === 'string')) throw httpError(400, 'Expected {"ids": [...]} (1 to 100 notification ids)');
  const parsed = ids.map(id => /^([A-Za-z0-9_-]{8,64})\/([A-Za-z0-9._~-]{1,200})$/.exec(id));
  if (parsed.some(m => !m)) throw httpError(400, 'Each id is "<phone device id>/<key>"');
  const phones = new Set(parsed.map(m => m[1]));
  if (phones.size > 1) throw httpError(400, 'Dismiss one phone\'s notifications at a time');
  const phone = parsed[0][1];
  const list = phoneNotes.get(phone);
  const keys = [...new Set(parsed.map(m => m[2]))].filter(key => list?.has(key));
  if (!keys.length || phone === me) throw httpError(404, 'Those notifications are gone');
  const request = startPhoneRequest(me, phone, 'dismiss', keys, {});
  send(res, 202, { request });
}

// POST /api/phone/requests/{id} { ok, error? }: the phone's answer, passed on to the device that asked.
async function answerPhoneRequest(req, res, [id], url) {
  const r = phoneRequests.get(id);
  const body = await readJson(req);
  if (!r || r.phone !== deviceIdOf(req, url)) return send(res, 404, { error: 'No such request (it may have timed out)' });
  if (typeof body.ok !== 'boolean') throw httpError(400, 'Expected {"ok": true} or {"ok": false, "error": "…"}');
  if (body.error !== undefined && typeof body.error !== 'string') throw httpError(400, 'error must be text');
  finishPhoneRequest(id, body.ok, body.ok ? undefined : noteText(body.error, 200, 'error') || 'failed');
  send(res, 204);
}

// PUT /api/devices/{id|me}/settings { phoneNotifications }: any signed-in device may set it for any device.
async function putDeviceSettings(req, res, [id], url) {
  const target = id ? targetDevice(id) : devices[deviceIdOf(req, url)];
  if (!target) throw httpError(400, 'X-Beam-Device-Id is required');
  const body = await readJson(req);
  const unknown = Object.keys(body).filter(k => k !== 'phoneNotifications');
  if (unknown.length) throw httpError(400, `Unknown device setting: ${unknown.join(', ')}`);
  if (typeof body.phoneNotifications !== 'boolean') throw httpError(400, 'Expected {"phoneNotifications": true|false}');
  if (showsNotes(target.id) !== body.phoneNotifications) {
    log.info(`${target.name} ${body.phoneNotifications ? 'shows phone notifications now' : 'no longer shows phone notifications'} (set on ${whoName(deviceIdOf(req, url), 'a device')})`);
  }
  const changed = showsNotes(target.id) !== body.phoneNotifications;
  target.settings = { ...(target.settings || {}), phoneNotifications: body.phoneNotifications };
  persistDevices();
  if (changed) {
    // The device itself follows at once (a PC's tray checkbox, its panel), even on a background stream: it gets the
    // new device list now. A `devices` event its streams still hold from before the change is dropped first: an
    // urgent event (the first notification) would flush it ahead of the new list, and the device would see its old
    // state for a moment. Switched off, it also drops every notification it shows. Everyone else gets the usual
    // devices event below (held on background streams).
    const own = new Set([target.id]);
    for (const c of clients) if (own.has(c.deviceId)) c.held = c.held.filter(h => h.key !== 'devices');
    if (!body.phoneNotifications) sendTo(own, 'notification-removed', { all: true });
    sendTo(own, 'devices', { devices: deviceList() });
  }
  broadcastDevices();
  send(res, 204);
}

// ---------------------------------------------------------------- the apps' settings backups (1.8.1)

// Each app keeps a copy of its own settings here (the user: "we should definetly have a way to backup setting and
// everything and restore them if needed for all computers"), sent when they change: never a sign-in or a key. One per
// install of the app (`install`, an id the install made up), the newest three per device; they go along when a
// reinstall's new device is linked to the old one, so the new install can offer to put them back. They're part of
// devices.json, so of every export and backup. Any of the owner's devices signed in for good may read them (to set a
// new PC up like an old one); a session-only sign-in may not.
const BACKUP_SETTINGS_MAX = 32 * 1024;
const BACKUPS_PER_DEVICE = 3;

function mergedBackups(...lists) {
  const seen = new Set();
  return lists.flat().filter(Boolean).sort((a, b) => b.at - a.at).filter(b => !seen.has(b.install) && seen.add(b.install)).slice(0, BACKUPS_PER_DEVICE);
}

// PUT /api/devices/me/backup { install, app: "windows" | "android", version, settings: {...} }
async function putDeviceBackup(req, res, _m, url) {
  const auth = authOf(req);
  if (auth.session) throw httpError(403, 'A sign-in for this browser session only keeps no backups');
  const d = devices[deviceIdOf(req, url)];
  if (!d) throw httpError(400, 'X-Beam-Device-Id is required');
  const body = await readJson(req, { limit: BACKUP_SETTINGS_MAX + 4096 });
  const install = typeof body.install === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.install) ? body.install : null;
  const app = ['windows', 'android'].includes(body.app) ? body.app : null;
  const ok = body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings);
  if (!install || !app || !ok) throw httpError(400, 'Expected {"install": "<its id>", "app": "windows" | "android", "version", "settings": {...}}');
  if (JSON.stringify(body.settings).length > BACKUP_SETTINGS_MAX) throw httpError(413, 'Those settings are too big to keep (32 KB at most)');
  const fresh = !(d.backups || []).some(b => b.install === install);
  d.backups = mergedBackups([{ install, app, version: noteText(body.version, 20, 'version') || null, at: now(), settings: body.settings }], (d.backups || []).filter(b => b.install !== install));
  persistDevices();
  if (fresh) log.info(`${d.name}'s Beam app keeps a backup of its settings here now`);
  broadcastDevices();
  send(res, 204);
}

// GET /api/devices/{id|me}/backups: { device, name, backups: [{ install, app, version, at, settings }] }, newest first.
function getDeviceBackups(req, res, [id], url) {
  if (authOf(req).session) throw httpError(403, 'A sign-in for this browser session only can’t read backups');
  const target = id ? targetDevice(id) : devices[deviceIdOf(req, url)];
  if (!target) throw httpError(400, 'X-Beam-Device-Id is required');
  send(res, 200, { device: target.id, name: target.name, backups: target.backups || [] });
}

// A device that goes away (removed, or merged into another) takes its shared notifications with it.
function dropPhoneNotes(phone) {
  if (!phoneNotes.has(phone)) return;
  const audience = audienceOf(phone);
  phoneNotes.delete(phone);
  sharingPhones.delete(phone);
  sendTo(audience, 'notification-removed', { device: phone, all: true });
}

// ---------------------------------------------------------------- remote control (1.6)
// Seeing and controlling a PC's own signed-in screen from another device. Media and input go directly between the
// two devices over Tailscale (WebRTC); the server only introduces them. It relays a few small signalling messages
// and keeps a table of sessions in memory (never on disk). Log lines name devices, machines and how a session ended,
// never what was sent. The controlled PC enforces every rule itself (its switch, its banner, the lease, the peer's
// Tailscale identity); the server adds what only it knows: who signed in and how, and the Tailscale machines it saw.
//
// Who is who:
// - the PC is its own Beam app: the Tailscale machine and Windows account that first reported "Allow remote
//   control" on (rcMachine, see rcFromPc). Only requests from there act as the PC, its address is attested from
//   there, and the PC's rc events go only to its streams from there;
// - the viewer is the sign-in that started the session (session.viewerKey): its later signals must use it, and the
//   viewer's rc events go only to its streams;
// - both must be sign-ins the user made on purpose (rcIneligible), and with Tailscale, owners' machines.

const RC_MIN_VERSION = '1.6.0';
// (1.16) A session's kind: `view` (the screen, with the mouse and keyboard on it) or `kvm` (another PC's own keyboard
// and mouse, no picture: the viewer's pointer crosses over the edge of its own screen). A kvm session never takes the
// place of someone viewing the PC (busy); someone viewing it ends a kvm session (busy), whose app asks again later.
// (1.23) `vnc`: a Linux computer's own screen sharing (its VNC server, run by its Beam for Linux), relayed by this server
// (see "control of a Linux computer").
const RC_KINDS = new Set(['view', 'kvm', 'vnc']);
const RC_KVM_MIN_VERSION = '1.12.0'; // the Beam app for Windows that takes a kvm session
const RC_LINUX_MIN_VERSION = '1.2.0'; // (1.23) the Beam for Linux that takes a vnc session
// The PC leases every 30 s; a session whose lease is this late ends.
const RC_LEASE_MS = FAST_TIMEOUTS && env.BEAM_TEST_RC_LEASE_MS ? Number(env.BEAM_TEST_RC_LEASE_MS) : 90_000;
const RC_SDP_MAX = 64 * 1024;
const RC_CANDIDATE_MAX = 256; // characters (real ones are under 200)
const RC_CANDIDATES_MAX = 20; // per signal
const RC_SIGNALS_MAX = 300; // per session
const RC_SIGNAL_BYTES_MAX = 512 * 1024; // per session, SDPs and candidates together
const RC_SIGNAL_KINDS = new Set(['offer', 'answer', 'candidates', 'restart']);
// The reasons either party may give for ending; the PC may also say the viewer isn't on its list. Anyone else
// ending a session gives stopped; the server's own reasons are revoked, lease and server.
const RC_END_REASONS = new Set(['stopped', 'declined', 'busy', 'locked', 'failed']);
const RC_PC_END_REASONS = new Set([...RC_END_REASONS, 'not-listed']);
const rcSessions = new Map(); // id -> { id, host, hostKey, viewer, viewerKey, since, state, liveSince, signals, bytes, request, timer }
const rcEnded = new Map(); // id -> { reason, host, viewer, at }: its parties get 410 for a while instead of 404
const rcStarts = new Limiter(10, 60_000); // per asking device
const rcDisables = new Limiter(10, 60_000);
const rcStats = { started: 0, refused: 0, ended: {} };

// What the PC allows: the Beam app for Windows 1.6+ (or, 1.23, Beam for Linux 1.2+) with "Allow remote control" on, tied
// to its machine, and not turned off from another device since (a disable that hasn't reached it yet).
const rcAllowed = d => (d.platform === 'windows' ? versionAtLeast(d.appVersion, RC_MIN_VERSION) : d.platform === 'linux' && versionAtLeast(d.appVersion, RC_LINUX_MIN_VERSION))
  && d.status?.remoteControl === true && !d.rcDisable && Boolean(d.rcMachine);

// Every /api/rc route: a device signed in for good (a session-only sign-in on a borrowed computer can't).
function rcCaller(req, url) {
  const me = resolveAlias(deviceIdOf(req, url)); // this very request may have merged it (a browser joining its app)
  if (authOf(req)?.session || devices[me]?.temporary) {
    throw httpError(403, 'Remote control needs a device that is signed in for good, not just for this session', { reason: 'temporary' });
  }
  if (!me || !devices[me]) throw httpError(400, 'X-Beam-Device-Id is required');
  if (!windowsKeyShown(authOf(req), req)) {
    throw httpError(403, 'Remote control from the Beam app for Windows needs its device key (X-Beam-Device-Key) on every request', { reason: 'device-key' });
  }
  return me;
}

// Who may take part (start a session, or be and act as the PC): what decides is the sign-in (its token), never the
// device id it names. Either a Beam app's own sign-in (made for Windows or Android; the apps' own pages use it as
// their cookie, and the Android activity's exchange (POST /api/login) keeps it), or a browser sign-in made with something only
// the user has: the password, a pairing link or code, a sign-in approved on another device, or the master key. Never
// a browser signed in by Tailscale identity or because a Beam app runs on the same machine (any Windows account on
// that machine gets those), nor the CLI. And a Beam app's own requests (bearer) say which Windows account they come
// from (X-Beam-Profile). (1.23) Beam for Linux's sign-in counts like the Android app's.
const RC_APP_PLATFORMS = new Set(['windows', 'android', 'linux']);
const RC_EXPLICIT = new Set(['password', 'pairing', 'login-request', 'key', 'migration']);

function rcSignInOk(auth) {
  if (auth?.via === 'master') return true;
  if (auth?.via !== 'token') return false;
  const platform = tokenPlatform(auth.token);
  if (platform === 'windows') return keyBound(auth.token); // the app's own: made or used with its device key
  if (RC_APP_PLATFORMS.has(platform)) return tokenOrigin(auth.token) !== 'autopair';
  return platform === 'web' && RC_EXPLICIT.has(tokenOrigin(auth.token));
}

function rcIneligible(req, url) {
  const auth = authOf(req);
  if (!rcSignInOk(auth)) return 'sign-in';
  if (auth.source === 'bearer' && APP_PLATFORMS.has(explicitPlatform(req, url)) && !profileOf(req, url)) return 'profile';
  return null;
}

// The PC is its Beam app for Windows: the master key, or a sign-in made for Windows. (1.23) A Linux computer is its Beam
// for Linux: a sign-in made for it (not an automatic one, as for Android).
const rcPcSignIn = auth => auth?.via === 'master' || (auth?.via === 'token' && ((tokenPlatform(auth.token) === 'windows' && keyBound(auth.token))
  || (tokenPlatform(auth.token) === 'linux' && tokenOrigin(auth.token) !== 'autopair')));

const RC_INELIGIBLE = {
  'sign-in': 'To control PCs from here, sign in to Beam on this device with a pairing link, an approval from another device or the password',
  profile: 'A Beam app must send X-Beam-Profile to use remote control',
};

// With Tailscale, a machine's user must be one of this Beam's owners (when the server knows them).
const rcOwnerOk = user => !user || !owners().size || owners().has(user);

// A sign-in, to tell a session's viewer from other sign-ins naming the same device: its token, or for the master key
// its machine and Windows account.
const rcCredKey = (auth, machine, profile) => (auth?.hash ? `t:${auth.hash}` : `m:${machine || ''}|${profile || ''}`);

// A machine's Tailscale addresses, name, user and StableID, as this server knows them. `machine` is what machineOf()
// made of one of its requests: 'host' (the server's own machine) or the Tailscale address the request came from
// through tailscale serve. whois and the tailnet list add the machine's other address, its name and its user. Never
// anything a client says about itself. null when the machine isn't on Tailscale.
async function tailnetIdentity(machine) {
  const ips = new Set();
  let node = null;
  let user = null;
  let stableId = null;
  if (machine === 'host') {
    for (const [addr, e] of tsIndex) {
      if (!e.self) continue;
      ips.add(addr);
      node ||= e.name || null;
      user ||= e.user || null;
      stableId ||= e.id || null;
    }
  } else if (machine && tailscale.isTailscaleIp(machine)) {
    ips.add(machine);
    const entry = tsIndex.get(machine);
    if (entry) for (const [addr, e] of tsIndex) if (e.key === entry.key) ips.add(addr);
    const who = await Promise.race([ts.whois(machine), sleep(3000).then(() => null)]);
    for (const a of who?.ips || []) ips.add(a);
    node = who?.node || entry?.name || null;
    user = who?.login || entry?.user || null;
    stableId = who?.stableId || entry?.id || null;
  }
  const list = [...ips].filter(a => tailscale.isTailscaleIp(a));
  const ip4 = list.find(a => net.isIPv4(a)) || null;
  const ip6 = list.find(a => net.isIPv6(a)) || null;
  return ip4 || ip6 ? { ip4, ip6, node, user, stableId } : null;
}

// Is this request the PC's own app (rcMachine: its machine and Windows account, from an eligible sign-in)? The same
// Tailscale node at a new address (the same whois StableID) still is, and the PC follows it there.
async function rcFromPc(device, req, url) {
  const m = device?.rcMachine;
  if (!m || rcIneligible(req, url) || !rcPcSignIn(authOf(req)) || profileOf(req, url) !== m.profile) return false;
  const machine = machineOf(req);
  if (!machine) return false;
  if (machine === m.machine) return true;
  if (machine === 'host' || m.machine === 'host' || !m.node || !tailscale.isTailscaleIp(machine)) return false;
  const who = await Promise.race([ts.whois(machine), sleep(3000).then(() => null)]);
  if (!who?.stableId || who.stableId !== m.node || device.rcMachine !== m) return false;
  device.rcMachine = { ...m, machine };
  persistDevices();
  log.info(`${device.name}'s remote control follows its Tailscale machine to ${machine}`);
  return true;
}

function rcNotFromPc(device, req) {
  const ip = clientIp(req);
  logOnce(`rc-machine ${device.id} ${ip}`, `Refused a remote control request as ${device.name} from another machine or Windows account (${ip})`,
    n => `Refused ${n} more remote control request${n === 1 ? '' : 's'} as ${device.name} from another machine or Windows account`);
  return httpError(403, `Only ${device.name}'s own Beam app (its machine and Windows account) may do that`, { reason: 'machine' });
}

// The first "Allow remote control: on" that the PC's own app reports ties remote control to its machine and Windows
// account (rcMachine). Without that, the PC can't be controlled.
async function rcBind(device, req, url) {
  const machine = machineOf(req);
  const profile = profileOf(req, url);
  let why = rcIneligible(req, url) === 'sign-in' || !rcPcSignIn(authOf(req)) ? 'from a sign-in that isn\'t the Beam app\'s own'
    : authOf(req)?.source !== 'bearer' || !APP_PLATFORMS.has(explicitPlatform(req, url)) ? 'not from the Beam app itself'
    : !profile ? 'without X-Beam-Profile'
    : machine !== 'host' && !tailscale.isTailscaleIp(machine) ? 'not through Tailscale' : null;
  if (!why) {
    const at = await tailnetIdentity(machine);
    if (!at) why = 'not through Tailscale';
    else if (!rcOwnerOk(at.user)) why = `from the Tailscale account ${at.user}, which isn't one of this Beam's owners`;
    else if (!device.rcMachine) {
      device.rcMachine = { machine, profile, node: at.stableId || null, at: now() };
      log.info(`${device.name}'s remote control is tied to its Beam app on ${at.node || 'its machine'} (${machine === 'host' ? 'this server' : machine})`);
      return;
    }
  }
  if (why) {
    logOnce(`rc-bind ${device.id}`, `${device.name} turned on "Allow remote control" ${why}: it can't be controlled`,
      n => `${device.name} reported "Allow remote control" ${n} more time${n === 1 ? '' : 's'} without being able to be controlled`);
  }
}

const rcSessionList = () => [...rcSessions.values()].map(x => ({ id: x.id, host: x.host, viewer: x.viewer, since: x.since, state: x.state, kind: x.kind }));

// rc-sessions, for every device's UI ("Desktop is being controlled from Robin Laptop · End"): not urgent (a
// background stream holds only the latest), and never to session-only sign-ins.
let rcSessionsTimer = null;
function broadcastRcSessions() {
  clearTimeout(rcSessionsTimer);
  rcSessionsTimer = setTimeout(() => broadcast('rc-sessions', { sessions: rcSessionList() }, null, c => !c.temporary), 300);
}

const streamOpen = c => !c.res.writableEnded && !c.res.destroyed;
const rcEventText = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
// The PC's own app streams: its device, from its rcMachine, with an eligible sign-in.
const rcPcStream = (c, pc) => c.deviceId === pc.id && c.rcOk && c.rcPc && Boolean(pc.rcMachine) && c.machine === pc.rcMachine.machine && c.profile === pc.rcMachine.profile;

// rc events to the PC: urgent, to its own app streams only.
function sendToPc(pcId, event, data) {
  const pc = devices[pcId];
  if (!pc) return;
  const msg = rcEventText(event, data);
  for (const c of clients) {
    if (!streamOpen(c) || !rcPcStream(c, pc)) continue;
    c.events++;
    writeTo(c, msg);
  }
}

// rc events to the viewer: urgent, to the streams of the sign-in that started the session only.
function sendToViewer(session, event, data) {
  const msg = rcEventText(event, data);
  for (const c of clients) {
    if (!streamOpen(c) || c.deviceId !== session.viewer || c.credKey !== session.viewerKey || !c.rcKey) continue;
    c.events++;
    writeTo(c, msg);
  }
}

function armRcLease(session) {
  clearTimeout(session.timer);
  session.timer = setTimeout(() => endRcSession(session, 'lease'), RC_LEASE_MS);
  session.timer.unref();
}

const rcDuration = ms => (ms < 60e3 ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < 3600e3 ? `${Math.round(ms / 60e3)} min` : `${(ms / 3600e3).toFixed(1)} h`);

// Ends a session: both parties hear it at once (rc-end), and its lease and signals answer 410 from then on.
function endRcSession(session, reason, by = null, detail = '') {
  if (rcSessions.get(session.id) !== session) return;
  rcSessions.delete(session.id);
  clearTimeout(session.timer);
  rcEnded.set(session.id, { reason, host: session.host, viewer: session.viewer, at: now() });
  for (const [id, e] of rcEnded) {
    if (rcEnded.size <= 200 && now() - e.at < 10 * 60e3) break;
    rcEnded.delete(id);
  }
  rcStats.ended[reason] = (rcStats.ended[reason] || 0) + 1;
  // (1.23) A Linux computer's own words on why it stopped ("wayvnc isn't installed") go to the viewer too: it has no
  // other way to say.
  const data = { id: session.id, reason, from: by, by: by ? nameOf(by) : null, ...(session.kind === 'vnc' && detail && { detail }) };
  sendToPc(session.host, 'rc-end', data);
  sendToViewer(session, 'rc-end', data);
  if (session.relay) vncShut(session, reason);
  const how = (by ? `${reason}, by ${whoName(by)}` : reason) + (detail ? `: ${detail}` : '');
  if (session.kind === 'kvm') {
    log.info(session.state === 'live'
      ? `${whoName(session.viewer)}'s keyboard and mouse stopped reaching ${nameOf(session.host)} after ${rcDuration(now() - session.liveSince)} (${how})`
      : `${whoName(session.viewer)}'s request to share its keyboard and mouse with ${nameOf(session.host)} ended (${how})`);
  } else {
    log.info(session.state === 'live'
      ? `${whoName(session.viewer)} stopped controlling ${nameOf(session.host)} after ${rcDuration(now() - session.liveSince)} (${how})`
      : `${whoName(session.viewer)}'s request to control ${nameOf(session.host)} ended (${how})`);
  }
  broadcastRcSessions();
}

// Ends every session these devices are part of (removed, signed out, merged away), or every session.
function endRcSessionsOf(ids, reason, by = null) {
  const set = new Set(ids);
  for (const x of [...rcSessions.values()]) if (set.has(x.host) || set.has(x.viewer)) endRcSession(x, reason, by);
}

function endAllRcSessions(reason, by = null) {
  for (const x of [...rcSessions.values()]) endRcSession(x, reason, by);
}

// Sign-ins revoked one by one (signed out, expired) end only the sessions they take part in: as the viewer, the
// sign-in that started it; as the PC, the sign-in its app acts with (before the PC has acted: any Windows sign-in of
// that PC). Removing a device, signing out the others or a merge end all of a device's sessions (endRcSessionsOf).
function endRcSessionsOfTokens(hashes, records) {
  const keys = new Set(hashes.map(h => `t:${h}`));
  const pcs = new Set(records.filter(t => t.device && tokenPlatform(t) === 'windows').map(t => resolveAlias(t.device)));
  for (const x of [...rcSessions.values()]) {
    if (keys.has(x.viewerKey) || (x.hostKey ? keys.has(x.hostKey) : pcs.has(x.host))) endRcSession(x, 'revoked');
  }
}

// The PC accepted (its first lease or signal).
function rcLive(session) {
  if (session.state === 'live') return;
  session.state = 'live';
  session.liveSince = now();
  log.info(session.kind === 'kvm' ? `${whoName(session.viewer)}'s keyboard and mouse can reach ${nameOf(session.host)}` : `${whoName(session.viewer)} is controlling ${nameOf(session.host)}`);
  broadcastRcSessions();
}

// The PC's own switch, as its own app reports it. Off: its sessions end, and a pending disable is done with. On
// while a disable is pending: it hears that again.
function rcSwitchReported(device, was) {
  const on = device.status?.remoteControl === true;
  if (!on) {
    delete device.rcDisable;
    for (const x of [...rcSessions.values()]) if (x.host === device.id) endRcSession(x, 'revoked', device.id);
  } else if (device.rcDisable) {
    sendTo(new Set([device.id]), 'rc-disable', { from: device.rcDisable.from, by: whoName(device.rcDisable.from) });
  }
  if (on !== was) log.info(`${device.name} ${on ? 'allows remote control now' : 'no longer allows remote control'}`);
}

// PUT /api/devices/me/status with remoteControl or locked: only the PC's own app may change them once remote
// control is tied to it, and its first "on" ties it.
async function rcStatusFrom(device, req, url, changes) {
  if (changes.remoteControl === undefined && changes.locked === undefined) return;
  if (device.rcMachine && !(await rcFromPc(device, req, url))) throw rcNotFromPc(device, req);
}

// A PC's app connecting: it hears a pending disable, and requests it may have missed while it was away.
function rcOnConnect(c) {
  const device = devices[c.deviceId];
  if (!device) return;
  const write = (event, data) => {
    c.events++;
    writeTo(c, rcEventText(event, data));
  };
  if (device.rcDisable) write('rc-disable', { from: device.rcDisable.from, by: whoName(device.rcDisable.from) });
  if (!rcPcStream(c, device)) return;
  for (const x of rcSessions.values()) if (x.host === c.deviceId && x.state === 'requested') write('rc-request', x.request);
}

// The session `id` for one of its parties (with hostOnly: for the PC): 410 once it has ended, else 404.
function rcSessionOf(id, me, { hostOnly = false } = {}) {
  const session = rcSessions.get(id);
  if (session && (session.host === me || (!hostOnly && session.viewer === me))) return session;
  const ended = !session && rcEnded.get(id);
  if (ended && (ended.host === me || (!hostOnly && ended.viewer === me))) {
    throw httpError(410, 'That remote control session has ended', { reason: ended.reason });
  }
  throw httpError(404, 'No such remote control session');
}

// Still the same session after an await? (It may have ended meanwhile.)
function rcStillOn(session) {
  if (rcSessions.get(session.id) === session) return session;
  throw httpError(410, 'That remote control session has ended', { reason: rcEnded.get(session.id)?.reason || 'stopped' });
}

function rcRefused(me, pc, reason, message, status = 409) {
  rcStats.refused++;
  logOnce(`rc-refused ${reason} ${me} ${pc.id}`, `Refused remote control of ${pc.name} for ${whoName(me)}: ${message}`,
    n => `Refused remote control of ${pc.name} for ${whoName(me)} ${n} more time${n === 1 ? '' : 's'} (${reason})`);
  return httpError(status, message, { reason });
}

function rcNotAllowed(pc) {
  if (pc.platform === 'linux') { // (1.23)
    if (!versionAtLeast(pc.appVersion, RC_LINUX_MIN_VERSION)) return `${pc.name} needs Beam for Linux ${RC_LINUX_MIN_VERSION} or later to be controlled`;
    if (pc.status?.remoteControl === true && !pc.rcDisable && !pc.rcMachine) return `${pc.name}'s remote control isn't tied to its Beam for Linux on a Tailscale machine yet`;
    return `Remote control is off on ${pc.name} (turn it on there: beam control on)`;
  }
  if (pc.platform !== 'windows') return `${pc.name} can't be controlled (only PCs with the Beam app for Windows and computers with Beam for Linux can)`;
  if (!versionAtLeast(pc.appVersion, RC_MIN_VERSION)) return `${pc.name} needs the Beam app ${RC_MIN_VERSION} or later to be controlled`;
  if (pc.status?.remoteControl === true && !pc.rcDisable && !pc.rcMachine) return `${pc.name}'s remote control isn't tied to its Beam app on a Tailscale machine yet`;
  return `Remote control is off on ${pc.name} ("Allow remote control" is turned on at that PC)`;
}

// POST /api/rc/sessions { device, kind? }: the caller (the viewer) asks to see and control that PC, or (kind kvm, 1.16)
// to work it with the viewer's own keyboard and mouse.
async function startRemoteControl(req, res, _m, url) {
  const me = rcCaller(req, url);
  const why = rcIneligible(req, url);
  if (why) throw httpError(403, RC_INELIGIBLE[why], { reason: why });
  if (rcStarts.blocked(me)) {
    throw Object.assign(httpError(429, 'Too many remote control requests; try again in a minute'), { headers: { 'Retry-After': String(rcStarts.retryAfter(me)) } });
  }
  rcStarts.hit(me);
  const body = await readJson(req);
  if (typeof body.device !== 'string' || !body.device) throw httpError(400, 'Expected {"device": "<the PC\'s device id>"}');
  if (body.kind !== undefined && !RC_KINDS.has(body.kind)) throw httpError(400, 'kind must be view, kvm or vnc');
  const kind = RC_KINDS.has(body.kind) ? body.kind : 'view';
  const pc = devices[resolveAlias(body.device)];
  if (!pc) throw httpError(404, 'No such device');
  const viewer = devices[me];
  const auth = authOf(req);
  const key = KEY;
  const check = () => {
    if (pc.id === me) throw rcRefused(me, pc, 'self', "A device can't control itself");
    // (1.23) A Linux computer shares its screen through VNC: the PCs' viewer (the Windows app's viewer window always
    // opens it) moves over to the VNC one when it hears this.
    if (pc.platform === 'linux' && kind !== 'vnc') throw httpError(409, `${pc.name} shares its screen through VNC`, { reason: 'vnc' });
    if (kind === 'vnc' && pc.platform !== 'linux') throw httpError(400, 'kind vnc is for computers with Beam for Linux');
    if (!rcAllowed(pc)) throw rcRefused(me, pc, 'not-allowed', rcNotAllowed(pc));
    if (kind === 'kvm' && !versionAtLeast(pc.appVersion, RC_KVM_MIN_VERSION)) {
      throw rcRefused(me, pc, 'old-app', `${pc.name} needs the Beam app ${RC_KVM_MIN_VERSION} or later to take another device's keyboard and mouse`);
    }
    if (pc.status?.locked === true) throw rcRefused(me, pc, 'locked', `${pc.name} is locked: use Remote Desktop`);
    if (!appOnline(pc.id)) throw rcRefused(me, pc, 'offline', `${pc.name} isn't connected to Beam right now`);
    const running = [...rcSessions.values()].find(x => x.host === pc.id);
    // What makes way: the same viewer's own session of the same kind (it reloaded, or its link came back), and a kvm
    // session for anyone viewing the PC. A kvm session never ends someone viewing it.
    if (running && !(running.viewer === me && running.kind === kind) && !(kind === 'view' && running.kind === 'kvm')) {
      throw rcRefused(me, pc, 'busy', running.kind === 'kvm' ? `${pc.name} is using ${whoName(running.viewer)}'s keyboard and mouse`
        : `${pc.name} is being controlled from ${whoName(running.viewer)}`);
    }
    return running;
  };
  check();
  // Where both are on the tailnet, as this server saw them: the viewer on this very request, the PC where its app is.
  const machine = machineOf(req);
  const [you, host] = await Promise.all([tailnetIdentity(machine), tailnetIdentity(pc.rcMachine.machine)]);
  // Things may have changed while whois answered: the viewer removed, merged away or signed out; the PC too.
  if (devices[me] !== viewer || (auth.via === 'token' ? !tokenStore.tokens[auth.hash] : KEY !== key)) {
    throw httpError(401, 'This device was signed out or removed meanwhile');
  }
  if (devices[pc.id] !== pc) throw httpError(404, 'No such device');
  const running = check();
  if (!you) throw rcRefused(me, pc, 'no-tailscale', 'This device has no Tailscale address the server knows: connect to Beam through Tailscale');
  if (!rcOwnerOk(you.user)) throw rcRefused(me, pc, 'not-owner', `This device's Tailscale account (${you.user}) isn't one of this Beam's owners`, 403);
  if (!host) throw rcRefused(me, pc, 'no-tailscale', `${pc.name} has no Tailscale address the server knows`);
  if (!rcOwnerOk(host.user)) throw rcRefused(me, pc, 'not-owner', `${pc.name}'s Tailscale account (${host.user}) isn't one of this Beam's owners`);
  // The same viewer again (it reloaded) makes way; a kvm session makes way for someone viewing the PC (busy: its app
  // asks again later).
  if (running) endRcSession(running, running.kind === 'kvm' && kind === 'view' ? 'busy' : 'stopped', me);
  const id = crypto.randomBytes(8).toString('hex');
  const session = {
    id, kind, host: pc.id, viewer: me, viewerKey: rcCredKey(auth, machine, profileOf(req, url)),
    since: now(), state: 'requested', liveSince: 0, signals: 0, bytes: 0, timer: null,
  };
  // by: the name the viewer chose for itself. viewer.node, .user and .ip: what Tailscale and the request confirm.
  const ip = clientIp(req);
  session.request = {
    id, from: me, by: nameOf(me), at: session.since,
    viewer: { ip: tailscale.isTailscaleIp(ip) ? ip : you.ip4 || you.ip6, ip4: you.ip4, ip6: you.ip6, node: you.node, user: you.user, platform: viewer.platform || null },
    ...(kind !== 'view' && { kind }),
  };
  rcSessions.set(id, session);
  armRcLease(session);
  rcStats.started++;
  sendToPc(pc.id, 'rc-request', session.request);
  const where = `from ${you.node || 'a Tailscale machine'}, ${session.request.viewer.ip}${you.user ? `, ${you.user}` : ''}`;
  log.info(kind === 'kvm' ? `${whoName(me)} asked to share its keyboard and mouse with ${pc.name} (${where})` : `${whoName(me)} asked to control ${pc.name} (${where})`);
  broadcastRcSessions();
  send(res, 201, { id, host: { id: pc.id, name: pc.name, ip4: host.ip4, ip6: host.ip6 }, you: { ip4: you.ip4, ip6: you.ip6 } });
}

function rcCandidate(c, i) {
  const bad = () => httpError(400, `candidates[${i}] must be {"candidate" (at most ${RC_CANDIDATE_MAX} characters), "sdpMid", "sdpMLineIndex", "usernameFragment"?}`);
  if (!isPlainObject(c) || typeof c.candidate !== 'string' || c.candidate.length > RC_CANDIDATE_MAX) throw bad();
  if (c.sdpMid != null && (typeof c.sdpMid !== 'string' || c.sdpMid.length > 64)) throw bad();
  if (c.sdpMLineIndex != null && !(Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 100)) throw bad();
  if (c.usernameFragment != null && (typeof c.usernameFragment !== 'string' || c.usernameFragment.length > 256)) throw bad();
  return {
    candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null,
    ...(c.usernameFragment != null && { usernameFragment: c.usernameFragment }),
  };
}

// POST /api/rc/sessions/{id}/signal { kind, sdp?, candidates? }: relayed to the other party only (rc-signal). The
// PC offers first; the viewer answers; both trickle candidates and may ask for an ICE restart.
async function signalRemoteControl(req, res, [id], url) {
  const me = rcCaller(req, url);
  const body = await readJson(req, { limit: RC_SDP_MAX + 32 * 1024 });
  const session = rcSessionOf(id, me);
  const fromPc = me === session.host;
  if (fromPc) {
    if (!(await rcFromPc(devices[session.host], req, url))) throw rcNotFromPc(devices[session.host], req);
    session.hostKey = rcCredKey(authOf(req), machineOf(req), profileOf(req, url));
  } else if (rcCredKey(authOf(req), machineOf(req), profileOf(req, url)) !== session.viewerKey) {
    throw httpError(404, 'No such remote control session'); // the device, but not the sign-in that started it
  }
  rcStillOn(session);
  if (!RC_SIGNAL_KINDS.has(body.kind)) throw httpError(400, 'kind must be offer, answer, candidates or restart');
  if (body.kind === 'offer' && !fromPc) throw httpError(400, 'Only the PC sends offers');
  if (body.kind === 'answer' && fromPc) throw httpError(400, 'Only the viewer answers');
  if (!fromPc && session.state === 'requested') throw httpError(409, `${nameOf(session.host)} hasn't accepted yet`, { reason: 'waiting' });
  const out = { id, from: me, kind: body.kind };
  if (body.kind === 'offer' || body.kind === 'answer') {
    if (typeof body.sdp !== 'string' || !body.sdp) throw httpError(400, 'sdp is required');
    if (Buffer.byteLength(body.sdp) > RC_SDP_MAX) throw httpError(413, 'The SDP is over 64 KB');
    out.sdp = body.sdp;
  } else if (body.kind === 'candidates') {
    if (!Array.isArray(body.candidates) || !body.candidates.length || body.candidates.length > RC_CANDIDATES_MAX) {
      throw httpError(400, `candidates must be a list of 1 to ${RC_CANDIDATES_MAX}`);
    }
    out.candidates = body.candidates.map(rcCandidate);
  }
  const bytes = Buffer.byteLength(out.sdp || '') + (out.candidates ? Buffer.byteLength(JSON.stringify(out.candidates)) : 0);
  if (session.signals >= RC_SIGNALS_MAX || session.bytes + bytes > RC_SIGNAL_BYTES_MAX) {
    throw httpError(429, `At most ${RC_SIGNALS_MAX} signals and ${RC_SIGNAL_BYTES_MAX / 1024} KB a session`, { reason: 'signals' });
  }
  session.signals++;
  session.bytes += bytes;
  if (fromPc) {
    rcLive(session);
    sendToViewer(session, 'rc-signal', out);
  } else {
    sendToPc(session.host, 'rc-signal', out);
  }
  send(res, 204);
}

// POST /api/rc/sessions/{id}/lease: the PC's own app, as soon as it has accepted (its banner is up) and every 30 s
// while the session lasts. Anything but 200 means it is over.
async function leaseRemoteControl(req, res, [id], url) {
  const me = rcCaller(req, url);
  await readJson(req, { optional: true });
  const session = rcSessionOf(id, me, { hostOnly: true });
  if (!(await rcFromPc(devices[session.host], req, url))) throw rcNotFromPc(devices[session.host], req);
  rcStillOn(session);
  session.hostKey = rcCredKey(authOf(req), machineOf(req), profileOf(req, url));
  armRcLease(session);
  rcLive(session);
  send(res, 200, { ok: true });
}

// POST /api/rc/sessions/{id}/end { reason? }: either party, or any other signed-in device (Settings: End). Only
// the PC's own app may say not-listed; only the parties (as themselves) give reasons at all.
async function endRemoteControl(req, res, [id], url) {
  const me = rcCaller(req, url);
  const body = await readJson(req, { optional: true });
  if (body.reason !== undefined && !RC_PC_END_REASONS.has(body.reason)) throw httpError(400, `reason must be one of: ${[...RC_PC_END_REASONS].join(', ')}`);
  const session = rcSessions.get(id);
  if (!session) {
    if (rcEnded.has(id)) return send(res, 204); // over already
    throw httpError(404, 'No such remote control session');
  }
  let reason = 'stopped';
  let party = false;
  if (body.reason && me === session.host && (await rcFromPc(devices[session.host], req, url))) { reason = body.reason; party = true; }
  else if (body.reason && me === session.viewer && RC_END_REASONS.has(body.reason)
    && rcCredKey(authOf(req), machineOf(req), profileOf(req, url)) === session.viewerKey) { reason = body.reason; party = true; }
  // (1.7.3) Why its own check hung up, from the session's viewer or PC: for the log, as kinds only. The log never holds
  // an address a session used, so anything shaped like one is left out.
  const detail = party && typeof body.detail === 'string'
    ? statusText(body.detail).replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<address>').replace(/\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, '<address>').slice(0, 160)
    : '';
  endRcSession(session, reason, me, detail); // a no-op if it ended meanwhile
  send(res, 204);
}

// GET /api/rc/sessions: the sessions going on, for every device's UI.
function listRemoteControl(req, res, _m, url) {
  rcCaller(req, url);
  send(res, 200, { sessions: rcSessionList() });
}

// POST /api/rc/disable { device }: any signed-in device turns a PC's "Allow remote control" off (never on: only the
// PC itself can). Its sessions end at once. The PC hears rc-disable now, and again whenever it connects or reports
// the switch on, until its own app reports it off.
async function disableRemoteControl(req, res, _m, url) {
  const me = rcCaller(req, url);
  if (rcDisables.blocked(me)) {
    throw Object.assign(httpError(429, 'Too many requests; try again in a minute'), { headers: { 'Retry-After': String(rcDisables.retryAfter(me)) } });
  }
  rcDisables.hit(me);
  const body = await readJson(req);
  if (typeof body.device !== 'string' || !body.device) throw httpError(400, 'Expected {"device": "<the PC\'s device id>"}');
  const pc = devices[resolveAlias(body.device)];
  if (!pc) throw httpError(404, 'No such device');
  for (const x of [...rcSessions.values()]) if (x.host === pc.id) endRcSession(x, 'revoked', me);
  if (pc.status?.remoteControl === true && !pc.rcDisable) {
    pc.rcDisable = { at: now(), from: me };
    persistDevices();
    broadcastDevices();
  }
  sendTo(new Set([pc.id]), 'rc-disable', { from: me, by: nameOf(me) });
  log.info(`${whoName(me)} turned off remote control on ${pc.name}`);
  send(res, 202, {});
}

// ---------------------------------------------------------------- control of a Linux computer (1.23)
// A session of kind vnc: the computer's own VNC server (wayvnc, which its Beam for Linux runs on a private socket)
// relayed here between the viewer's page (noVNC) and that computer's Beam for Linux. Both open a WebSocket to
// GET /api/rc/sessions/{id}/vnc: the viewer with the sign-in that started the session (its page's cookie, from Beam's
// own pages only), the computer as itself (rcFromPc, as for leases). Bytes only, nothing kept or logged. Either side
// leaving ends the session, and the session ending closes both.

const VNC_WAIT_MS = FAST_TIMEOUTS ? 4000 : 30_000; // for the other side to join
const VNC_PING_MS = FAST_TIMEOUTS ? 1000 : 30_000; // each side is pinged; no pong in time: gone
const VNC_PENDING_MAX = 1 << 20; // what one side may send before the other is there
const VNC_FRAME_MAX = 4 << 20;
const vncStats = { relayed: 0 };

function onUpgrade(req, socket, head) {
  socket.on('error', () => {});
  vncUpgrade(req, socket, head).catch(err => {
    if (!err.status) log.error('VNC relay:', err);
    refuseUpgrade(socket, err.status || 500, err.status ? err.message : 'Server error', err.extra);
  });
}

function refuseUpgrade(socket, status, message, extra = {}) {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error: message, ...extra });
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Error'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

async function vncUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://beam');
  const m = /^\/api\/rc\/sessions\/([a-f0-9]{16})\/vnc$/.exec(url.pathname);
  if (!m || req.method !== 'GET' || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !req.headers['sec-websocket-key']) {
    throw httpError(400, 'Only a VNC relay (GET /api/rc/sessions/{id}/vnc) takes a WebSocket');
  }
  if (setting('movedTo')) throw httpError(410, 'Beam moved', { movedTo: setting('movedTo') });
  const ip = clientIp(req);
  const host = machineOf(req) === 'host' && !viaTrustedProxy(req);
  if (!host && badSecrets.blocked(ip)) throw httpError(429, 'Too many failed sign-ins from this address. Try again in a few minutes.');
  const auth = authOf(req);
  if (!auth) {
    if (req._authPresented && !host) badSecrets.hit(ip);
    throw httpError(401, 'Not signed in', { serverId: SERVER_ID });
  }
  // (a page of another machine of the tailnet is the same site, and WebSockets aren't held to the same origin)
  if (auth.source === 'cookie' && !originMatches(req)) throw httpError(403, 'Blocked a cross-site request', { reason: 'csrf' });
  if (auth.scope) throw httpError(403, 'This sign-in can only be used to move Beam');
  touchToken(auth);
  const me = deviceIdOf(req, url);
  const session = rcSessionOf(m[1], me);
  if (session.kind !== 'vnc') throw httpError(404, 'No such VNC session');
  let side;
  if (me === session.host) {
    if (!(await rcFromPc(devices[session.host], req, url))) throw rcNotFromPc(devices[session.host], req);
    side = 'host';
  } else if (rcCredKey(auth, machineOf(req), profileOf(req, url)) === session.viewerKey) {
    side = 'viewer';
  } else {
    throw httpError(404, 'No such remote control session'); // the device, but not the sign-in that started it
  }
  rcStillOn(session);
  if (socket.destroyed) return;
  // noVNC asks for the "binary" subprotocol (a browser that asked for one fails a handshake that names none); nothing
  // else is spoken here, so nothing else is named
  const asked = String(req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
  const protocol = asked.includes('binary') ? 'binary' : null;
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${ws.acceptKey(req.headers['sec-websocket-key'])}\r\n${protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ''}\r\n`);
  vncJoin(session, side, socket, head);
}

function vncJoin(session, side, socket, head) {
  socket.setTimeout(0);
  socket.setNoDelay(true);
  const relay = (session.relay ||= { viewer: null, host: null, waiting: null, ping: null });
  const other = side === 'host' ? 'viewer' : 'host';
  const old = relay[side];
  const end = { side, socket, reader: new ws.FrameReader({ masked: true, max: VNC_FRAME_MAX }), alive: true, pending: [], pendingBytes: 0 };
  relay[side] = end;
  if (old) { old.replaced = true; vncCloseEnd(old, 4001, 'replaced'); } // (the same party again: the newest wins)
  const forward = payload => {
    const to = relay[other];
    if (!to) {
      end.pendingBytes += payload.length;
      if (end.pendingBytes > VNC_PENDING_MAX) return endRcSession(session, 'failed', null, `the ${other === 'host' ? 'computer' : 'viewer'} didn't join`);
      return end.pending.push(payload);
    }
    vncStats.relayed += payload.length;
    if (!to.socket.write(ws.frame(ws.OP.binary, payload)) && !end.held) {
      end.held = true; // (the other side's connection is behind: this side waits for it)
      socket.pause();
      to.socket.once('drain', () => { end.held = false; socket.resume(); });
    }
  };
  const onData = chunk => {
    let frames;
    try { frames = end.reader.push(chunk); } catch (err) {
      vncCloseEnd(end, 1002, 'protocol error');
      return endRcSession(session, 'failed', null, `the ${side === 'host' ? 'computer' : 'viewer'}'s connection broke the protocol (${err.message})`);
    }
    for (const f of frames) {
      if (rcSessions.get(session.id) !== session) return;
      if (f.opcode === ws.OP.ping) socket.write(ws.frame(ws.OP.pong, f.payload));
      else if (f.opcode === ws.OP.pong) end.alive = true;
      else if (f.opcode === ws.OP.close) {
        vncCloseEnd(end, 1000, '');
        return endRcSession(session, 'stopped', side === 'host' ? session.host : session.viewer);
      } else if (f.payload.length) forward(f.payload);
    }
  };
  socket.on('data', onData);
  socket.on('close', () => {
    if (relay[side] !== end || end.replaced) return;
    relay[side] = null;
    endRcSession(session, 'stopped', side === 'host' ? session.host : session.viewer);
  });
  if (head?.length) onData(head);
  // The other side's bytes that came first
  const there = relay[other];
  if (there?.pending.length) {
    const queued = there.pending;
    there.pending = [];
    there.pendingBytes = 0;
    for (const p of queued) socket.write(ws.frame(ws.OP.binary, p));
  }
  if (relay.viewer && relay.host) {
    clearTimeout(relay.waiting);
    relay.waiting = null;
    rcLive(session);
  } else {
    clearTimeout(relay.waiting);
    relay.waiting = setTimeout(() => endRcSession(session, 'failed', null, `the ${other === 'host' ? 'computer' : 'viewer'} didn't join`), VNC_WAIT_MS);
    relay.waiting.unref();
  }
  relay.ping ||= setInterval(() => {
    for (const e of [relay.viewer, relay.host]) {
      if (!e) continue;
      if (!e.alive) {
        vncCloseEnd(e, 1001, 'no answer');
        endRcSession(session, 'failed', null, `the ${e.side === 'host' ? 'computer' : 'viewer'} stopped answering`);
        return;
      }
      e.alive = false;
      e.socket.write(ws.frame(ws.OP.ping));
    }
  }, VNC_PING_MS);
  relay.ping.unref();
}

function vncCloseEnd(end, code, reason) {
  if (end.closing || end.socket.destroyed) return;
  end.closing = true;
  try { end.socket.end(ws.closeFrame(code, reason)); } catch {}
  setTimeout(() => end.socket.destroy(), 1000).unref();
}

// The session is over: both sides hear why (a close frame) and are let go.
function vncShut(session, reason) {
  const relay = session.relay;
  clearTimeout(relay.waiting);
  clearInterval(relay.ping);
  for (const side of ['viewer', 'host']) {
    const end = relay[side];
    relay[side] = null;
    if (end) vncCloseEnd(end, reason === 'stopped' ? 1000 : 4000, reason);
  }
}

// ---------------------------------------------------------------- live updates
// Event streams come in two modes. foreground (the default): every event goes out at once, and a ping after 25 s
// without data. background (an app that isn't on screen): only urgent events go out at once; the rest wait for
// the heartbeat (180 s) and go out together instead of its ping, so an idle phone's radio wakes about 20 times an
// hour instead of 144. Any data counts as the heartbeat. POST /api/events/poke switches a live stream's mode.

const clients = new Set(); // see events()
const PING_UNIT_MS = FAST_TIMEOUTS ? 40 : 1000; // test/server.test.js runs heartbeats 25 times faster
const STREAM_PING = { foreground: 25, background: 180 }; // seconds
const HELD_MAX = 100; // a background stream gets its held events early past this many
const PING_EVENT = 'event: ping\ndata: {}\n\n';
// Heartbeats fall on a 5 s grid, so the server wakes once for all the streams that are due together rather than
// once per stream (a heartbeat comes at most 5 s late).
const BEAT_GRID_MS = 5 * PING_UNIT_MS;

const clampPing = v => Math.min(300, Math.max(15, Math.round(v)));
const streamPing = (mode, raw) => (raw !== null && raw !== '' && Number.isFinite(Number(raw)) ? clampPing(Number(raw)) : STREAM_PING[mode]);

// What a background stream gets at once: things for its device, and things that want an answer soon. (The first
// `upload` event of an upload is urgent for its recipients too; createUpload says so when it broadcasts it.)
function urgentFor(c, event, data) {
  switch (event) {
    case 'item': return isFor(data, c.deviceId);
    case 'ring': return data.device === c.deviceId;
    case 'alert': return !data.device || data.device !== c.deviceId;
    case 'login-request': case 'login-request-done': case 'moved': return true;
    default: return false;
  }
}

// Held events that only describe the latest state replace their older copy (keeping their place at the end).
const coalesceKey = (event, data) => (event === 'devices' || event === 'rc-sessions' ? event : event === 'upload' || event === 'update' ? `${event}:${data.id}` : null);

function hold(c, event, data, msg) {
  const key = coalesceKey(event, data);
  if (key) {
    const i = c.held.findIndex(h => h.key === key);
    if (i >= 0) c.held.splice(i, 1);
  }
  c.held.push({ key, msg });
  c.heldTotal++;
  if (c.held.length > HELD_MAX) writeTo(c, '');
}

// Writes to one stream, its held events first so everything keeps its order. Every write restarts the heartbeat.
function writeTo(c, msg) {
  if (c.res.writableEnded || c.res.destroyed) return;
  // A client that stopped reading (a phone in a tunnel) would otherwise make the server buffer every event.
  if (c.res.writableLength > SSE_MAX_QUEUED) {
    log.warn(`Dropped a stalled event stream (${nameOf(c.deviceId)}): over 1 MB unread`);
    c.res.destroy();
    return;
  }
  const text = c.held.length ? c.held.map(h => h.msg).join('') + msg : msg;
  c.held = [];
  if (!text) return;
  c.res.write(text);
  c.writes++;
  c.bytes += Buffer.byteLength(text);
  c.lastWrite = now();
}

// urgent(c), when given, decides instead of urgentFor which background streams get this event at once; only(c), when
// given, which streams get it at all.
function broadcast(event, data, urgent = null, only = null) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (c.res.writableEnded || c.res.destroyed || (only && !only(c))) continue;
    c.events++;
    if (c.mode === 'background' && !(urgent ? urgent(c) : urgentFor(c, event, data))) hold(c, event, data, msg);
    else writeTo(c, msg);
  }
}

// Due `ping` seconds after the stream's last write: the held events if there are any, else a ping. A write since
// the timer was set moves the heartbeat on instead.
function heartbeat(c) {
  if (c.res.writableEnded || c.res.destroyed) return;
  if (now() - c.lastWrite >= c.ping * PING_UNIT_MS - BEAT_GRID_MS) writeTo(c, c.held.length ? '' : PING_EVENT);
  scheduleBeat(c);
}

function scheduleBeat(c) {
  const due = Math.ceil((c.lastWrite + c.ping * PING_UNIT_MS) / BEAT_GRID_MS) * BEAT_GRID_MS;
  clearTimeout(c.beat);
  c.beat = setTimeout(() => heartbeat(c), Math.max(0, due - now()));
  c.beat.unref();
}

// The socket gives up after 2 × ping + 30 s without any traffic (a client that vanished). TCP keepalive probes
// would only wake the far end between heartbeats, so they start after a heartbeat is due.
function setStreamTimers(c) {
  c.socket.setTimeout((2 * c.ping + 30) * PING_UNIT_MS);
  c.socket.setKeepAlive(true, Math.max(1000, (c.ping + 15) * PING_UNIT_MS));
  scheduleBeat(c);
}

// A stream belongs to the sign-in that opened it (or, for the master key, to its device).
const ownsStream = (c, auth, deviceId) => (c.tokenHash ? c.tokenHash === auth?.hash : Boolean(c.deviceId && c.deviceId === deviceId));

// POST /api/events/poke: is my stream still there? Held events and a ping {poke: true} go out on it at once, and it
// can switch mode or heartbeat without reconnecting. { alive: false } means: reconnect now.
async function pokeStream(req, res, _m, url) {
  const body = await readJson(req, { optional: true });
  const unknown = Object.keys(body).filter(k => !['stream', 'mode', 'ping'].includes(k));
  if (unknown.length) throw httpError(400, `Can't use ${unknown.join(', ')} here`);
  if (typeof body.stream !== 'string' || !body.stream) throw httpError(400, 'stream must be the id from the hello event');
  if (body.mode !== undefined && body.mode !== 'foreground' && body.mode !== 'background') throw httpError(400, 'mode must be "foreground" or "background"');
  if (body.ping !== undefined && !Number.isFinite(body.ping)) throw httpError(400, 'ping must be a number of seconds (15 to 300)');
  let c = null;
  for (const x of clients) if (x.id === body.stream) c = x;
  if (!c || c.res.writableEnded || c.res.destroyed || !ownsStream(c, authOf(req), deviceIdOf(req, url))) return send(res, 200, { alive: false });
  c.pokes++;
  if (body.mode && body.mode !== c.mode) {
    c.mode = body.mode;
    c.ping = STREAM_PING[c.mode];
  }
  if (body.ping !== undefined) c.ping = clampPing(body.ping);
  setStreamTimers(c);
  writeTo(c, 'event: ping\ndata: {"poke":true}\n\n');
  send(res, 200, { alive: true, mode: c.mode, ping: c.ping });
}

// A short hash of the web app's files, so open pages can reload themselves after a deploy.
let webHash = { at: 0, value: '' };
function webVersion() {
  if (webHash.value && now() - webHash.at < 60_000) return webHash.value;
  const hash = crypto.createHash('sha256');
  try {
    for (const name of fs.readdirSync(PUBLIC_DIR, { recursive: true }).map(String).sort()) {
      const st = fs.statSync(path.join(PUBLIC_DIR, name));
      if (st.isFile()) hash.update(`${name}:${st.size}:${st.mtimeMs}\n`);
    }
  } catch {}
  webHash = { at: now(), value: hash.digest('hex').slice(0, 12) };
  return webHash.value;
}

// Every item change is sent with its full state: clients replace `delivered` wholesale on `update`.
function broadcastUpdate(item) {
  const out = { id: item.id, delivered: item.delivered || {}, pinned: Boolean(item.pinned), thumb: Boolean(item.thumb) };
  // (1.14.0) reactions (all of them: {} when none are left), and an edited text with its new words (cut as in lists)
  out.reactions = item.reactions || {};
  if (item.edited) {
    out.edited = item.edited;
    if (item.kind === 'text') {
      const s = summary(item);
      Object.assign(out, { text: s.text, truncated: Boolean(s.truncated) }, s.truncated ? { textLength: s.textLength } : {});
    }
  }
  broadcast('update', out);
}

async function pushNtfy(item) {
  if (!NTFY_URL || NTFY_SKIP.has(item.device.toLowerCase())) return;
  const isText = item.kind === 'text';
  const message = isText
    ? (NTFY_PREVIEW ? item.text.slice(0, 300) : 'Tap to open Beam')
    : (NTFY_PREVIEW ? `${item.name} · ${formatSize(item.size)}` : formatSize(item.size));
  await ntfyPost({ title: `${isText ? 'Text' : 'File'} from ${item.device}`, message, tags: [isText ? 'clipboard' : 'package'] });
}

async function ntfyPost(fields) {
  if (!NTFY_URL) return;
  try {
    const url = new URL(NTFY_URL);
    const payload = { topic: url.pathname.replace(/^\/+|\/+$/g, ''), ...fields };
    const base = await publicBase();
    if (base) payload.click = base;
    const res = await fetch(url.origin + '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(NTFY_TOKEN && { Authorization: `Bearer ${NTFY_TOKEN}` }) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log.warn(`ntfy push failed: HTTP ${res.status}`);
  } catch (err) {
    log.warn('ntfy push failed:', err.message);
  }
}

// ---------------------------------------------------------------- items & storage

const filePath = id => path.join(DIR.files, id);
const textPath = id => path.join(DIR.texts, `${id}.txt`);
const thumbPath = id => path.join(DIR.thumbs, id);
const findItem = id => items.find(i => i.id === id);

function newId() {
  let id;
  do id = crypto.randomBytes(8).toString('hex'); while (findItem(id) || uploads.has(id));
  return id;
}

async function dropContent(item) {
  if (item.kind === 'file') await rmQuiet(filePath(item.id));
  if (item.textFile) await rmQuiet(textPath(item.id));
  if (item.thumb) await rmQuiet(thumbPath(item.id));
}

// An item counts as delivered once every target has acknowledged it (targets that were forgotten can't);
// a broadcast once any other device has.
function isDelivered(item) {
  const others = Object.keys(item.delivered || {}).filter(d => d !== item.from);
  if (!item.to?.length) return others.length > 0;
  return item.to.every(t => t === item.from || item.delivered?.[t] || !devices[t]);
}

// Delta sync (GET /api/items?since=<cursor>). Every change to an item goes through itemChanged(), which gives it
// the next revision; a removal leaves a tombstone. A cursor is "<epoch>.<revision>". The epoch is new for every
// server process, so after a restart or an import every old cursor gets the full list; so do cursors from before a
// device merge (it rewrites items wholesale) or older than the oldest tombstone kept.
const SYNC_EPOCH = crypto.randomBytes(6).toString('hex');
const itemRevs = new Map(); // item id -> revision of its last change (absent: unchanged since the server started)
let tombstones = []; // { id, rev }, oldest first
const MAX_TOMBSTONES = 10_000;
let syncRev = 0;
let syncFloor = 0; // cursors below this revision can't be answered exactly

const syncCursor = () => `${SYNC_EPOCH}.${syncRev}`;

// The one place an item's change is recorded: its revision for delta sync, and the save.
function itemChanged(item) {
  itemRevs.set(item.id, ++syncRev);
  persist();
}

function itemsRemoved(gone) {
  for (const item of gone) {
    removedItems.add(item);
    itemRevs.delete(item.id);
    savedJson.delete(item.id);
    listedJson.delete(item.id);
    tombstones.push({ id: item.id, rev: ++syncRev });
  }
  if (tombstones.length > MAX_TOMBSTONES) {
    const dropped = tombstones.slice(0, tombstones.length - MAX_TOMBSTONES);
    tombstones = tombstones.slice(dropped.length);
    syncFloor = Math.max(syncFloor, dropped.at(-1).rev);
  }
}

// Changes a delta can't describe item by item (a device merge rewrites senders and targets everywhere).
function itemsRewritten() {
  syncFloor = ++syncRev;
  savedJson.clear();
  listedJson.clear();
  persist();
}

// Each item's JSON (as saved, and as listed) is kept until the item changes (a new revision), so saving items.json
// or answering GET /api/items joins strings instead of serializing thousands of unchanged items again. The one rule
// that keeps this right: every change to an item goes through itemChanged() (or itemsRewritten()).
const savedJson = new Map(); // id -> { rev, json } as in items.json
const removedItems = new WeakSet(); // removed while a save of the old list may still be writing them: not cached again
const listedJson = new Map(); // id -> { rev, json } of summary(item)

function jsonOf(cache, item, shape) {
  const rev = itemRevs.get(item.id) || 0;
  let c = cache.get(item.id);
  if (!c || c.rev !== rev) cache.set(item.id, (c = { rev, json: JSON.stringify(shape(item)) }));
  return c.json;
}

// items.json in pieces of about 256 KB, made while the file is written: the whole list as one string blocked the
// server for tens of milliseconds at 5000 items. It saves the list as it was when the save started; any change
// meanwhile has already asked for the next save.
async function* itemsFileParts() {
  const list = items.slice();
  yield '[';
  let batch = [];
  let size = 0;
  for (let i = 0; i < list.length; i++) {
    const json = removedItems.has(list[i]) ? JSON.stringify(list[i]) : jsonOf(savedJson, list[i], x => x);
    batch.push(json);
    size += json.length;
    if (size >= 256 * 1024 || i === list.length - 1) {
      yield (i + 1 > batch.length ? ',' : '') + batch.join(',');
      batch = [];
      size = 0;
    }
  }
  yield ']';
}

// The full list for the current revision, kept (with its gzipped copy) until anything changes.
let listMemo = null;
function listJson() {
  const cursor = syncCursor();
  if (listMemo?.cursor !== cursor) listMemo = { cursor, text: `{"items":[${items.map(i => jsonOf(listedJson, i, summary)).join(',')}],"cursor":"${cursor}"` };
  return listMemo;
}

// The revision a cursor stands for, or -1 when it can't be answered exactly (foreign, unknown, too old).
function cursorRev(cursor) {
  const m = /^([a-f0-9]{12})\.(\d{1,15})$/.exec(String(cursor));
  if (!m || m[1] !== SYNC_EPOCH) return -1;
  const rev = Number(m[2]);
  return rev <= syncRev && rev >= syncFloor ? rev : -1;
}

function addItem(item) {
  log.info(`${item.forwardedFrom ? 'Forwarded' : 'Sent'} ${describeItem(item)} from ${whoName(item.from, item.device)} to ${targetsText(item.to)} [${shortId(item.id)}]`);
  items.unshift(item);
  enforceMaxItems(item.id);
  itemChanged(item);
  broadcast('item', summary(item));
  pushNtfy(item);
}

function removeItems(predicate) {
  const gone = items.filter(predicate);
  if (!gone.length) return 0;
  const set = new Set(gone);
  items = items.filter(i => !set.has(i));
  gone.forEach(dropContent);
  itemsRemoved(gone);
  persist();
  for (const item of gone) broadcast('delete', { id: item.id });
  return gone.length;
}

// Over the item limit, the oldest delivered, unpinned items go first; pinned items are never removed.
function enforceMaxItems(keepId) {
  const max = setting('maxItems');
  if (!(max > 0) || items.length <= max) return;
  const excess = items.length - max;
  // (audit P-1) "delivered" worked out once per item, not in the comparator (O(n log n) allocating calls at 100,000)
  const candidates = items
    .filter(i => !i.pinned && i.id !== keepId)
    .map(i => ({ i, delivered: isDelivered(i) }))
    .sort((a, b) => (b.delivered - a.delivered) || (a.i.ts - b.i.ts))
    .slice(0, excess)
    .map(x => x.i);
  const gone = new Set(candidates.map(i => i.id));
  if (gone.size && removeItems(i => gone.has(i.id))) {
    log.info(`Removed the ${gone.size} oldest item${gone.size > 1 ? 's' : ''} to stay under the limit of ${max} items`);
  }
}

function sweep() {
  expireNotes();
  const retention = setting('retentionDays');
  if (retention > 0) {
    const day = 86400e3;
    // Undelivered items wait up to three times longer for their device to come back; pinned ones stay.
    const expired = items.filter(i => !i.pinned && (now() - i.ts > 3 * retention * day || (now() - i.ts > retention * day && isDelivered(i))));
    if (expired.length) {
      const bytes = expired.reduce((n, i) => n + (i.kind === 'file' ? i.size || 0 : 0), 0);
      const undelivered = expired.filter(i => !isDelivered(i)).length;
      const set = new Set(expired);
      removeItems(i => set.has(i));
      log.info(`Clean-up: removed ${expired.length} item${expired.length > 1 ? 's' : ''} (${formatSize(bytes)}) older than ${retention} days${undelivered ? `, ${undelivered} of them never picked up` : ''}`);
    }
  }
  enforceMaxItems();
  for (const upload of uploads.values()) {
    if (!upload.busy && now() - upload.touched > UPLOAD_IDLE_MS) {
      log.info(`Gave up on the unfinished upload of "${upload.name}" [${shortId(upload.id)}] from ${whoName(upload.from, upload.device)} (${percentOf(upload.offset, upload.size)} done, idle for a day)`);
      dropUpload(upload);
      broadcast('upload-cancelled', { id: upload.id });
    }
  }
  // Every browser that opens Beam becomes a device; forget the ones nobody has used for a month.
  let forgot = false;
  for (const d of Object.values(devices)) {
    if (d.platform === 'web' && !isOnline(d.id) && now() - d.lastSeen > 30 * 86400e3) {
      delete devices[d.id];
      forgot = true;
    }
  }
  if (forgot) { persistDevices(); broadcastDevices(); }
  expireSessions();
  let pruned = false;
  for (const [hash, p] of Object.entries(tokenStore.pairing)) {
    if (p.expires < now()) { delete tokenStore.pairing[hash]; pruned = true; }
  }
  if (pruned) persistTokens();
  for (const [value, exp] of usedHandoffs) if (exp < now()) usedHandoffs.delete(value);
  for (const limiter of [passwordIp, passwordGlobal, badSecrets, loginRequestRate, notePuts, noteAsks, rcStarts, rcDisables]) limiter.prune();
}

// Session sign-ins (borrowed computers) end after 12 h without use; their temporary devices are forgotten. (Also
// move sign-ins and long-unused browsers': expiryOf.)
function expireSessions() {
  for (const reason of new Set(Object.values(tokenStore.tokens).map(expiryOf).filter(Boolean))) revokeTokens((h, t) => expiryOf(t) === reason, reason);
  const withTokens = new Set(Object.values(tokenStore.tokens).map(t => t.device && resolveAlias(t.device)).filter(Boolean));
  for (const d of Object.values(devices)) {
    if (d.temporary && !APP_PLATFORMS.has(d.platform) && !withTokens.has(d.id) && !isOnline(d.id)) {
      log.info(`Forgot the temporary device "${d.name}" (its session ended)`);
      forgetDeviceNow(d.id, 'temporary device');
    }
  }
}

// Moves files the index doesn't know about to data/orphaned (never deletes them), and drops index entries
// whose file is gone, unless every file is gone (then the storage probably isn't mounted: keep the entries).
function reconcileFiles() {
  const known = new Set(items.filter(i => i.kind === 'file').map(i => i.id));
  const knownTexts = new Set(items.filter(i => i.textFile).map(i => `${i.id}.txt`));
  const knownThumbs = new Set(items.filter(i => i.thumb).map(i => i.id));
  let moved = 0;
  const present = new Map(); // folder -> the names in it (checked instead of one stat per item)
  const unreadable = new Set(); // (audit B-6) folders that couldn't be listed: their items stay
  for (const [dir, keep] of [[DIR.files, known], [DIR.texts, knownTexts], [DIR.thumbs, knownThumbs]]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (err) { unreadable.add(dir); log.error(`Couldn't list ${dir} (${err.code || err.message}): keeping the items whose files are in it`); }
    present.set(dir, new Set(names));
    for (const name of names) {
      if (keep.has(name) || name.endsWith('.tmp')) continue;
      const dest = path.join(DIR.orphaned, `${path.basename(dir)}-${name}`);
      try { fs.renameSync(path.join(dir, name), fs.existsSync(dest) ? `${dest}-${now()}` : dest); moved++; } catch {}
    }
  }
  if (moved) log.warn(`Moved ${moved} file${moved > 1 ? 's' : ''} that no item refers to into ${DIR.orphaned} (${dataHealth.itemsSource === 'file' ? 'probably left over from an interrupted upload' : 'items.json had to be recovered'}). Delete them once you don't need them.`);
  const fileItems = items.filter(i => i.kind === 'file');
  const missing = unreadable.has(DIR.files) ? [] : fileItems.filter(i => !present.get(DIR.files).has(i.id));
  const missingTexts = unreadable.has(DIR.texts) ? [] : items.filter(i => i.textFile && !present.get(DIR.texts).has(`${i.id}.txt`));
  // (audit B-6: also a single file item, which the guard used to miss)
  if (missing.length && missing.length === fileItems.length) {
    log.error(`None of the ${fileItems.length} stored file${fileItems.length > 1 ? 's are' : ' is'} in ${DIR.files}. Is the data volume mounted? Keeping ${fileItems.length > 1 ? 'their entries' : 'its entry'}.`);
  } else if (missing.length || missingTexts.length) {
    const gone = new Set([...missing, ...missingTexts]);
    items = items.filter(i => !gone.has(i));
    log.warn(`Removed ${gone.size} item${gone.size > 1 ? 's' : ''} whose file is missing`);
    itemsRewritten();
  }
  for (const item of items.filter(i => i.thumb && !unreadable.has(DIR.thumbs) && !present.get(DIR.thumbs).has(i.id))) {
    delete item.thumb;
    itemChanged(item);
  }
}

// Texts over 64 KB live in data/texts/<id>.txt; the item keeps a preview. Older data had them inline.
function moveBigTextsOut() {
  let moved = 0;
  for (const item of items) {
    if (item.kind !== 'text' || item.textFile || item.text.length <= INLINE_TEXT_LIMIT) continue;
    writeFileDurableSync(textPath(item.id), item.text);
    item.textLength = item.text.length;
    item.text = cutText(item.text, LIST_TEXT_LIMIT);
    item.textFile = true;
    moved++;
  }
  if (moved) {
    log.info(`Moved ${moved} long text${moved > 1 ? 's' : ''} out of items.json into ${DIR.texts}`);
    itemsRewritten();
  }
}

async function fullText(item) {
  return item.textFile ? fsp.readFile(textPath(item.id), 'utf8') : item.text;
}

// What clients see of an item. Internal fields stay server-side.
function publicItem(item) {
  const { textFile, thumb, lastEvent, ...rest } = item;
  return { from: null, to: [], delivered: {}, ...rest, pinned: Boolean(item.pinned), thumb: Boolean(thumb) };
}

// Lists and live events cut texts to 16 KB; the full text is at /api/items/{id}/text.
function summary(item) {
  const out = publicItem(item);
  if (item.kind !== 'text') return out;
  const length = item.textFile ? item.textLength : item.text.length;
  if (length <= LIST_TEXT_LIMIT) return out;
  return { ...out, text: cutText(item.text, LIST_TEXT_LIMIT), truncated: true, textLength: length };
}

async function fullItem(item) {
  const out = publicItem(item);
  if (item.textFile) {
    out.text = await fullText(item);
    delete out.textLength;
  }
  return out;
}

function storageUsed() {
  let used = 0;
  for (const i of items) used += i.kind === 'file' ? i.size : i.textFile ? i.textLength : 0;
  for (const u of uploads.values()) used += u.size;
  return used;
}

async function diskInfo() {
  if (FAST_TIMEOUTS && env.BEAM_TEST_DISK) {
    const [free, total] = env.BEAM_TEST_DISK.split(',').map(Number);
    return { free, total };
  }
  try {
    const s = await fsp.statfs(DATA_DIR);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

// Refuses (507) what the disk can't hold with 100 MB to spare, and keeps under BEAM_MAX_STORAGE_GB by removing
// the oldest delivered, unpinned items first.
async function ensureSpace(bytes) {
  const disk = await diskInfo();
  if (disk && bytes + DISK_MARGIN > disk.free) {
    throw httpError(507, `Not enough space on the Beam server: ${formatSize(Math.max(0, disk.free - DISK_MARGIN))} available, ${formatSize(bytes)} needed.`, { free: disk.free });
  }
  if (MAX_STORAGE > 0 && storageUsed() + bytes > MAX_STORAGE) {
    evictForSpace(storageUsed() + bytes - MAX_STORAGE);
    if (storageUsed() + bytes > MAX_STORAGE) throw httpError(507, `Beam's storage limit (${formatSize(MAX_STORAGE)}) is full. Delete or unpin some items.`);
  }
}

function evictForSpace(needed) {
  const candidates = items.filter(i => !i.pinned && isDelivered(i) && (i.kind === 'file' || i.textFile)).sort((a, b) => a.ts - b.ts);
  const gone = new Set();
  let freed = 0;
  for (const i of candidates) {
    if (freed >= needed) break;
    gone.add(i.id);
    freed += i.kind === 'file' ? i.size : i.textLength;
  }
  if (gone.size) {
    removeItems(i => gone.has(i.id));
    log.info(`Removed ${gone.size} delivered item${gone.size > 1 ? 's' : ''} (${formatSize(freed)}) to stay under BEAM_MAX_STORAGE_GB`);
  }
}

const diskFull = offset => httpError(507, "The Beam server's disk is full.", offset === undefined ? undefined : { offset });

// Copies the request body to a file. Fails when it grows beyond `limit` bytes or stops arriving for 60 s
// (a phone that walked out of Wi-Fi mid-upload leaves a connection that would otherwise hang forever); what arrived
// until then is still written. Network reads come in 64 KB pieces; they are written about 1 MB at a time (one
// write per piece cost a sixth of an upload's CPU), one write in flight while the next batch fills.
// onData(bytes received), onWritten(bytes written).
// durable: { want(written, end, failed), done(written) }: after each write, and once at the end (end is true, and
// failed when the body broke off), want() decides whether to fsync now; done() then learns how many bytes are
// surely on disk.
const WRITE_BATCH = MB;

async function receiveBody(req, dest, limit, { flags = 'w', onData, onWritten, durable } = {}) {
  let size = 0;
  let stored = 0;
  let synced = 0;
  const idle = setTimeout(() => req.destroy(Object.assign(new Error('No data for 60 s'), { code: 'EIDLE' })), BODY_IDLE_MS);
  const fh = await fsp.open(dest, flags, 0o600); // (only this account, like every state file; 1.7.3)
  const sync = async (end, failed = false) => {
    if (stored > synced && durable?.want(stored, end, failed)) {
      await fh.sync();
      synced = stored;
      await durable.done(stored);
    }
  };
  let batch = [];
  let batched = 0;
  let writing = null;
  const write = async () => {
    const bufs = batch;
    const bytes = batched;
    batch = [];
    batched = 0;
    await writeAll(fh, bufs);
    stored += bytes;
    onWritten?.(stored);
    await sync(false);
  };
  let ok = false;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw httpError(413, 'More data than expected');
      idle.refresh();
      onData?.(size);
      batch.push(chunk);
      batched += chunk.length;
      if (batched >= WRITE_BATCH) {
        await writing;
        writing = write();
      }
    }
    ok = true;
  } finally {
    clearTimeout(idle);
    try {
      await writing;
      if (batched) await write();
      await sync(true, !ok);
    } finally {
      await fh.close();
    }
  }
  return size;
}

// Writes every byte of the buffers (a short write, rare for files, is finished off).
async function writeAll(fh, bufs) {
  while (bufs.length) {
    const { bytesWritten } = await fh.writev(bufs);
    if (!bytesWritten) throw Object.assign(new Error('The disk took no data'), { code: 'EIO' });
    let n = bytesWritten;
    const rest = [];
    for (const b of bufs) {
      if (n >= b.length) n -= b.length;
      else {
        rest.push(n ? b.subarray(n) : b);
        n = 0;
      }
    }
    bufs = rest;
  }
}

// ---------------------------------------------------------------- API: devices & items

function getMe(req, res, _m, url) {
  const you = deviceIdOf(req, url);
  const auth = authOf(req);
  const name = machineName(req);
  send(res, 200, {
    ok: true, you, api: API_VERSION, read: (you && readMarks[you]) || {},
    auth: { via: auth.via, user: auth.user, role: auth.role, ...(auth.session && { session: true }) },
    machine: name ? { name } : null,
  });
}

function getDevices(req, res, _m, url) {
  send(res, 200, { devices: deviceList(), you: deviceIdOf(req, url) });
}

function forgetDevice(req, res, [id]) {
  id = resolveAlias(id);
  if (!devices[id]) return send(res, 404, { error: 'Not found' });
  log.info(`Removed the device "${nameOf(id)}" (by ${nameOf(deviceIdOf(req, new URL(req.url, 'http://beam')))})`);
  blockNodesOf([id], { except: callerNode(req), reason: `the device "${nameOf(id)}" was removed` });
  forgetDeviceNow(id, 'device removed');
  send(res, 204);
}

// GET /api/items[?since=<cursor>]: the list (newest first, texts cut to 16 KB) with a cursor; with since, only what
// changed after that cursor (items created or changed, ids deleted) or, when that can't be told exactly, the full
// list with delta: false.
function listItems(req, res, _m, url) {
  const since = url.searchParams.get('since');
  const rev = since === null ? -1 : cursorRev(since);
  if (rev < 0) {
    const list = listJson();
    const full = since === null ? list.text + '}' : list.text + ',"delta":false}';
    return sendJson(res, 200, full, {}, since === null ? (list.plain ||= {}) : (list.fallback ||= {}));
  }
  const changed = items.filter(i => (itemRevs.get(i.id) || 0) > rev).map(i => jsonOf(listedJson, i, summary));
  const deleted = [];
  for (let k = tombstones.length - 1; k >= 0 && tombstones[k].rev > rev; k--) deleted.push(tombstones[k].id);
  sendJson(res, 200, `{"items":[${changed.join(',')}],"deleted":${JSON.stringify(deleted.reverse())},"cursor":"${syncCursor()}","delta":true}`);
}

async function getItem(req, res, [id]) {
  const item = findItem(id);
  item ? send(res, 200, await fullItem(item)) : send(res, 404, { error: 'Not found' });
}

async function getItemText(req, res, [id]) {
  const item = findItem(id);
  if (!item || item.kind !== 'text') return send(res, 404, { error: 'Not found' });
  const length = item.textFile ? item.textLength : item.text.length;
  const etag = `"t-${item.id}-${length}"`;
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ETag: etag,
    'Last-Modified': new Date(item.ts).toUTCString(), 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-cache',
  };
  if (req.headers['if-none-match'] === etag) return send(res, 304, '', headers);
  send(res, 200, await fullText(item), headers);
}

function ackItem(req, res, [id], url) {
  const item = findItem(id);
  if (!item) return send(res, 404, { error: 'Not found' });
  const deviceId = deviceIdOf(req, url);
  if (!deviceId) throw httpError(400, 'X-Beam-Device-Id is required');
  if (deviceId !== item.from && !item.delivered?.[deviceId]) {
    log.info(`Delivered [${shortId(id)}] to ${whoName(deviceId)} after ${durationText(now() - item.ts)}`);
    item.delivered = { ...item.delivered, [deviceId]: now() };
    itemChanged(item);
    broadcastUpdate(item);
  }
  send(res, 200, { id, delivered: item.delivered || {} });
}

async function deleteItem(req, res, [id]) {
  const item = findItem(id);
  if (!item || !removeItems(i => i.id === id)) return send(res, 404, { error: 'Not found' });
  log.info(`Deleted ${describeItem(item)} [${shortId(id)}] (by ${whoName(deviceIdOf(req, new URL(req.url, 'http://beam')))})`);
  await saved();
  send(res, 204);
}

async function clearItems(req, res) {
  const deleted = removeItems(() => true);
  log.info(`Deleted every item (${deleted}) (by ${whoName(deviceIdOf(req, new URL(req.url, 'http://beam')))})`);
  await saved();
  send(res, 200, { deleted });
}

async function deleteSome(req, res) {
  const { ids } = await readJson(req);
  if (!Array.isArray(ids) || ids.length > 1000 || !ids.every(id => typeof id === 'string')) throw httpError(400, 'Expected {"ids": [...]} (up to 1000)');
  const set = new Set(ids);
  const deleted = removeItems(i => set.has(i.id));
  if (deleted) log.info(`Deleted ${deleted} item${deleted > 1 ? 's' : ''} (by ${whoName(deviceIdOf(req, new URL(req.url, 'http://beam')))})`);
  await saved();
  send(res, 200, { deleted });
}

async function patchItem(req, res, [id]) {
  const item = findItem(id);
  if (!item) return send(res, 404, { error: 'Not found' });
  // (1.14.0: a text's words too, so as much as a text may hold)
  const body = await readJson(req, { limit: MAX_TEXT + 64 * 1024 });
  const unknown = Object.keys(body).filter(k => k !== 'pinned' && k !== 'text');
  if (unknown.length) throw httpError(400, `Can't change ${unknown.join(', ')}`);
  if (!('pinned' in body) && !('text' in body)) throw httpError(400, 'Expected {"pinned": true|false} or {"text": "…"}');
  if ('pinned' in body && typeof body.pinned !== 'boolean') throw httpError(400, 'Expected {"pinned": true|false}');
  if ('text' in body) await editText(item, body.text);
  if (body.pinned === true) item.pinned = true;
  else if (body.pinned === false) delete item.pinned;
  itemChanged(item);
  broadcastUpdate(item);
  send(res, 200, summary(item));
}

// A new item from the caller with the same content. Files are hard-linked (copied if that's impossible).
async function forwardItem(req, res, [id], url) {
  const source = findItem(id);
  if (!source) return send(res, 404, { error: 'Not found' });
  const body = await readJson(req);
  const to = resolveTargets(body.to);
  const copy = { id: newId(), kind: source.kind, forwardedFrom: source.id };
  if (source.kind === 'text') {
    copy.text = source.text;
    if (source.textFile) {
      await linkOrCopy(textPath(source.id), textPath(copy.id), source.textLength);
      Object.assign(copy, { textFile: true, textLength: source.textLength });
    }
  } else {
    await linkOrCopy(filePath(source.id), filePath(copy.id), source.size);
    Object.assign(copy, { name: source.name, size: source.size, mime: source.mime });
    if (source.w) Object.assign(copy, { w: source.w, h: source.h });
  }
  if (source.thumb) {
    try {
      await linkOrCopy(thumbPath(source.id), thumbPath(copy.id), 0);
      copy.thumb = source.thumb;
    } catch {}
  }
  const item = newItem(req, url, copy, to);
  addItem(item);
  await saved();
  send(res, 201, summary(item));
}

// (1.13.0) "Fast link" on a file in Beam's chat (the user: "Make a fast link" from Beam's own apps): Beam Family, on this
// machine, makes it, since Beam isn't reachable from the internet and Family's public link is. Family takes the file as
// a second name for it (a hard link: no copy on the same drive) and answers with a link anyone can use without signing
// in until it runs out; its page says it's from Family's owner. POST /api/items/:id/fastlink { hours, maxDownloads?,
// removeLocation? } → 201 { link } (1.15.0: at most so many downloads; a copy without location data, Family's choices).
async function fastLinkItem(req, res, [id], url) {
  if (!FAMILY_URL) throw httpError(404, 'Fast links need Beam Family on this server (BEAM_FAMILY_URL)');
  const item = findItem(id);
  if (!item) return send(res, 404, { error: 'Not found' });
  if (item.kind !== 'file') throw httpError(400, 'Only files get fast links');
  const file = filePath(item.id);
  const st = await fsp.stat(file).catch(() => null);
  // (not 410 or 502/504 below: the apps take those for "Beam moved" and "offline")
  if (!st || st.size !== item.size) throw httpError(404, 'That file isn’t on the server any more');
  const body = await readJson(req, { optional: true });
  const hours = body?.hours === undefined ? 24 : Math.round(Number(body.hours));
  let control = '';
  try { control = (await fsp.readFile(path.join(FAMILY_DATA, 'control.key'), 'utf8')).trim(); } catch {}
  if (!control) throw httpError(503, 'Beam Family isn’t set up on this server');
  let r;
  try {
    r = await fetch(`${FAMILY_LOCAL}/api/admin/fastlink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Family-Control': control },
      body: JSON.stringify({ path: file, name: item.name, size: item.size, mime: item.mime, hours,
        ...(body?.maxDownloads != null && { maxDownloads: body.maxDownloads }), ...(body?.removeLocation === true && { removeLocation: true }) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw httpError(503, 'Beam Family isn’t answering on this machine');
  }
  const answer = await r.json().catch(() => ({}));
  if (!r.ok || !answer.link?.url) {
    // (404: a Beam Family before 1.13 or another key; its own errors pass on: no owner yet, the 50 links, storage)
    throw httpError(r.ok || r.status === 404 || r.status >= 500 ? 503 : r.status, r.status === 404 ? 'Beam Family on this machine needs version 1.13 or later' : answer.error || `Beam Family answered ${r.status}`);
  }
  const extras = [answer.link.maxDownloads ? `at most ${answer.link.maxDownloads} download${answer.link.maxDownloads > 1 ? 's' : ''}` : '', answer.link.removeLocation ? 'without location data' : ''].filter(Boolean);
  log.info(`${whoName(deviceIdOf(req, url))} made a fast link to ${item.name} (through Beam Family, ${hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`}${extras.length ? `, ${extras.join(', ')}` : ''})`);
  send(res, 201, { link: answer.link });
}

async function linkOrCopy(from, to, size) {
  try {
    await fsp.link(from, to);
  } catch (err) {
    if (err.code === 'ENOENT') throw httpError(404, 'The original is missing on the server');
    if (size) await ensureSpace(size);
    try {
      await fsp.copyFile(from, to);
    } catch (copyErr) {
      await fsp.rm(to, { force: true }).catch(() => {}); // (no half copy left behind; 1.7.2)
      throw copyErr;
    }
  }
}

// (1.14.0) What a reply answers: that item's id with a short preview of it as it is now (so the reply still reads right
// after that item is edited or deleted). Null for no reply; an id that isn't here any more keeps just the id.
function replyRef(id) {
  if (id == null || id === '') return null;
  if (typeof id !== 'string' || !ITEM_ID.test(id)) throw httpError(400, 'reply must be a message id');
  const src = findItem(id);
  if (!src) return { id };
  const ref = { id, kind: src.kind, from: src.from || null, device: src.device || null };
  if (src.kind === 'text') ref.text = cutText(src.text, 140);
  else ref.name = src.name;
  return ref;
}

// (1.14.0) A text edited: the new words in place (a long one in data/texts, as when it was sent), marked `edited`. Any of
// the owner's devices may edit (they're all the owner's). Nothing is delivered again, and nobody auto-copies it again.
async function editText(item, text) {
  if (item.kind !== 'text') throw httpError(400, 'Only texts can be edited');
  if (typeof text !== 'string') throw httpError(400, 'Expected {"text": "..."}');
  text = text.replace(/^\uFEFF/, '').toWellFormed();
  if (!text.trim()) throw httpError(400, 'Nothing would be left: delete it instead');
  if (Buffer.byteLength(text) > MAX_TEXT) throw httpError(413, 'Too large');
  const before = item.textFile ? item.textLength : item.text.length;
  if (text.length > before) await ensureSpace(Buffer.byteLength(text) - before);
  if (text.length > INLINE_TEXT_LIMIT) {
    await writeFileDurable(textPath(item.id), text);
    Object.assign(item, { text: cutText(text, LIST_TEXT_LIMIT), textLength: text.length, textFile: true });
  } else {
    if (item.textFile) await fsp.rm(textPath(item.id), { force: true }).catch(() => {});
    item.text = text;
    delete item.textFile;
    delete item.textLength;
  }
  item.edited = now();
}

// (1.14.0) Reactions: each device's own, any emoji (one short string), at most 20 kinds on a message.
// PUT /api/items/{id}/reactions/{emoji} → this device's on; DELETE → off. 200 + the message; an `update` event.
const MAX_REACTION_KINDS = 20;
async function setReaction(req, res, [id, raw], url) {
  const item = findItem(id);
  if (!item) return send(res, 404, { error: 'Not found' });
  let emoji = '';
  try { emoji = decodeURIComponent(raw).normalize('NFC'); } catch {}
  if (!emoji || emoji.length > 16 || /[\s<>\u0000-\u001f\u007f-\u009f]/.test(emoji)) throw httpError(400, 'A reaction is one emoji');
  if (['__proto__', 'constructor', 'prototype'].includes(emoji)) throw httpError(400, 'A reaction is one emoji'); // (audit B-10: keys of every object)
  const who = deviceIdOf(req, url);
  if (!who || !devices[who]) throw httpError(400, 'X-Beam-Device-Id is required');
  const reactions = { ...(item.reactions || {}) };
  const by = new Set(reactions[emoji] || []);
  if (req.method === 'PUT') {
    if (!reactions[emoji] && Object.keys(reactions).length >= MAX_REACTION_KINDS) throw httpError(409, 'That message has as many kinds of reactions as it can');
    by.add(who);
  } else by.delete(who);
  if (by.size) reactions[emoji] = [...by]; else delete reactions[emoji];
  if (Object.keys(reactions).length) item.reactions = reactions; else delete item.reactions;
  itemChanged(item);
  broadcastUpdate(item);
  send(res, 200, summary(item));
}

function newItem(req, url, fields, to) {
  return { id: fields.id || newId(), ...fields, from: deviceIdOf(req, url), device: deviceNameOf(req, url) || nameOf(deviceIdOf(req, url)) || 'Unknown device', to, delivered: {}, ts: now() };
}

async function postText(req, res, _m, url) {
  const type = String(req.headers['content-type'] || '');
  if (authOf(req).source === 'cookie' && !isJsonType(req)) throw httpError(415, 'Send JSON (Content-Type: application/json)');
  let text = (await readTextBody(req)).toString('utf8');
  let bodyTo, bodyReply;
  if (type.includes('application/json')) {
    let body;
    try { body = JSON.parse(text); } catch { throw httpError(400, 'Invalid JSON'); }
    if (!isPlainObject(body)) throw httpError(400, 'Expected {"text": "..."}');
    text = body.text;
    bodyTo = body.to;
    bodyReply = body.reply; // (1.14.0)
    if (typeof text !== 'string') throw httpError(400, 'Expected {"text": "..."}');
  } else if (type.includes('application/x-www-form-urlencoded')) {
    // `curl -d "hello"` sends raw text with this type; only unwrap a real `text=` field.
    const field = new URLSearchParams(text).get('text');
    if (field !== null) text = field;
  }
  text = text.replace(/^\uFEFF/, '').toWellFormed();
  if (!text.trim()) throw httpError(400, 'Nothing to send');
  const to = targetsFromRequest(req, url, bodyTo);
  await ensureSpace(Buffer.byteLength(text));
  const fields = { kind: 'text', text };
  const reply = replyRef(bodyReply); // (1.14.0)
  if (reply) fields.reply = reply;
  if (text.length > INLINE_TEXT_LIMIT) {
    fields.id = newId();
    await writeFileDurable(textPath(fields.id), text);
    Object.assign(fields, { text: cutText(text, LIST_TEXT_LIMIT), textLength: text.length, textFile: true });
  }
  const item = newItem(req, url, fields, to);
  addItem(item);
  await saved();
  send(res, 201, summary(item));
}

// Optional image size from the sender, for laying out previews before they load.
function imageSize(w, h) {
  const ok = v => Number.isInteger(v) && v > 0 && v <= 100_000;
  w = Number(w);
  h = Number(h);
  return ok(w) && ok(h) ? { w, h } : {};
}

// Simple one-shot upload: the whole file is the request body.
async function postFile(req, res, _m, url) {
  if (String(req.headers['content-type'] || '').startsWith('multipart/')) {
    throw httpError(400, 'Send the file as the raw request body (e.g. curl -T file), not as a multipart form');
  }
  const declared = Number(req.headers['content-length']);
  if (declared > MAX_UPLOAD) throw httpError(413, `File is larger than the ${formatSize(MAX_UPLOAD)} limit`);
  const to = targetsFromRequest(req, url);
  await ensureSpace(Number.isFinite(declared) ? declared : 0);
  const name = fileNameFrom(req, url);
  const id = newId();
  const dest = filePath(id);
  let size;
  try {
    size = await receiveBody(req, dest, MAX_UPLOAD, { durable: { want: (_n, end) => end, done: () => syncDir(DIR.files) } });
  } catch (err) {
    await rmQuiet(dest);
    if (err.status === 413) throw httpError(413, `File is larger than the ${formatSize(MAX_UPLOAD)} limit`);
    if (err.code === 'ENOSPC') throw diskFull();
    if (!res.headersSent && !res.socket?.destroyed) throw httpError(400, 'Upload interrupted');
    return;
  }
  const item = newItem(req, url, { id, kind: 'file', name, size, mime: mimeFor(name, req.headers['content-type']), ...imageSize(url.searchParams.get('w'), url.searchParams.get('h')) }, to);
  addItem(item);
  await saved();
  send(res, 201, publicItem(item));
}

function fileNameFrom(req, url) {
  let raw = url.searchParams.get('name');
  if (!raw) {
    // Header values arrive as latin1; clients send either %-encoded or raw UTF-8 names.
    raw = String(req.headers['x-filename'] || '');
    if (/[^\x00-\x7f]/.test(raw)) raw = Buffer.from(raw, 'latin1').toString('utf8');
    else try { raw = decodeURIComponent(raw); } catch {}
  }
  return sanitizeName(raw);
}

// ---------------------------------------------------------------- API: resumable uploads

function uploadPaths(id) {
  return { meta: path.join(DIR.uploads, `${id}.json`), part: path.join(DIR.uploads, `${id}.part`) };
}

function saveUploadMeta(upload) {
  const { busy, activeReq, settled, cancelled, lastByte, lastEvent, watchers, syncedAt, metaSaving, ...meta } = upload;
  const json = JSON.stringify(meta);
  const write = () => writeFileDurable(uploadPaths(upload.id).meta, json);
  // One save at a time per upload: two at once would trip over the same temporary file.
  const saving = (upload.metaSaving || Promise.resolve()).then(write, write);
  upload.metaSaving = saving.catch(() => {});
  return saving;
}

// An upload's resume point survives a power cut only once its bytes are fsynced: after one, the partial file may be
// longer than what reached the disk (a zero-filled tail). So the partial file is fsynced every 64 MB or 4 s of a
// transfer, when a PUT fails, and before the upload finishes; only then is `synced` (in its metadata) moved on,
// and a restart resumes from `synced`, cutting the file back to it. A PUT's reply gives the offset to go on from;
// after a crash, the next PUT's 409 names the last durable one.
const SYNC_BYTES = FAST_TIMEOUTS ? 256 * 1024 : 64 * MB;
const SYNC_MS = FAST_TIMEOUTS ? 1000 : 4000;

// On a clean stop: every upload's bytes so far are made durable, so a restart doesn't cut anything off.
async function checkpointUploads() {
  const all = [...uploads.values()];
  for (const u of all) if (u.busy) u.activeReq?.destroy(); // an interrupted PUT checkpoints what arrived
  await Promise.race([Promise.all(all.map(u => u.settled)), sleep(3000)]);
  for (const u of all) {
    if (u.cancelled || !uploads.has(u.id) || u.offset <= u.synced) continue;
    try {
      const fh = await fsp.open(uploadPaths(u.id).part, 'r+');
      try { await fh.sync(); } finally { await fh.close(); }
      u.synced = u.offset;
      await saveUploadMeta(u);
    } catch {}
  }
}

async function removeUploadFiles(id) {
  const p = uploadPaths(id);
  await Promise.all([rmQuiet(p.meta), rmQuiet(p.part), rmQuiet(`${p.meta}.tmp`)]);
}

function dropUpload(upload) {
  uploads.delete(upload.id);
  upload.cancelled = true;
  upload.activeReq?.destroy();
  notifyUpload(upload);
  removeUploadFiles(upload.id);
}

// Wakes the downloads that are reading this upload while it arrives (see serveLive).
function notifyUpload(upload) {
  if (upload.watchers?.size) for (const wake of [...upload.watchers]) wake();
}

function loadUploads() {
  for (const name of fs.readdirSync(DIR.uploads)) {
    if (!name.endsWith('.json')) continue;
    try {
      const upload = JSON.parse(fs.readFileSync(path.join(DIR.uploads, name), 'utf8'));
      if (!ITEM_ID.test(upload.id)) continue;
      const part = uploadPaths(upload.id).part;
      const size = fs.existsSync(part) ? fs.statSync(part).size : 0;
      // Resume from the last fsynced point: after a power cut the rest may not be real data. (Uploads saved by 1.3
      // have no checkpoint and keep their size.)
      const durable = Number.isSafeInteger(upload.synced) && upload.synced >= 0 ? Math.min(upload.synced, size) : size;
      if (size > durable) {
        fs.truncateSync(part, durable);
        log.info(`Upload of "${upload.name}" [${shortId(upload.id)}] goes on from its last saved point, ${formatSize(durable)} (dropped ${formatSize(size - durable)} that might not have reached the disk)`);
      }
      upload.offset = upload.synced = durable;
      upload.to = Array.isArray(upload.to) ? upload.to : [];
      delete upload.ip;
      Object.assign(upload, { busy: false, lastByte: 0, syncedAt: now() });
      uploads.set(upload.id, upload);
    } catch {}
  }
  // Remove .part files without metadata.
  for (const name of fs.readdirSync(DIR.uploads)) {
    if (name.endsWith('.part') && !uploads.has(name.slice(0, -5))) fs.rmSync(path.join(DIR.uploads, name), { force: true });
  }
}

// `offset` is where the next chunk goes (it moves when a chunk ends); `received` (1.15.1) is what has reached the
// server, the chunk still arriving included: a download trailing the upload goes on from it after a blip instead of
// waiting for the sender.
function uploadInfo(u) {
  return { id: u.id, name: u.name, size: u.size, offset: u.offset, received: Math.max(u.offset, u.received || 0), chunkSize: CHUNK_SIZE, maxChunkSize: MAX_CHUNK };
}

const uploadEvent = (u, offset = u.offset) => ({ id: u.id, name: u.name, size: u.size, offset, mime: u.mime, from: u.from, device: u.device, to: u.to });

async function createUpload(req, res, _m, url) {
  const body = await readJson(req);
  const size = Number(body.size);
  if (!Number.isSafeInteger(size) || size < 0) throw httpError(400, 'size must be a whole number of bytes');
  if (size > MAX_UPLOAD) throw httpError(413, `File is larger than the ${formatSize(MAX_UPLOAD)} limit`);
  const to = targetsFromRequest(req, url, body.to);
  await ensureSpace(size);
  const name = sanitizeName(body.name);
  const upload = {
    id: newId(),
    name,
    size,
    mime: mimeFor(name, body.mime),
    ...imageSize(body.w, body.h),
    to,
    from: deviceIdOf(req, url),
    device: deviceNameOf(req, url) || nameOf(deviceIdOf(req, url)) || 'Unknown device',
    offset: 0,
    synced: 0,
    touched: now(),
    busy: false,
    lastByte: 0,
  };
  upload.started = now();
  upload.syncedAt = now();
  if (size >= BIG_TRANSFER) log.info(`Upload started: "${cutText(name, 80)}" (${formatSize(size)}) from ${whoName(upload.from, upload.device)} to ${targetsText(to)} [${shortId(upload.id)}]`);
  uploads.set(upload.id, upload);
  await fsp.writeFile(uploadPaths(upload.id).part, '');
  await saveUploadMeta(upload);
  // Its first event wakes the devices it is for, even in background mode: they may start downloading at once.
  broadcast('upload', uploadEvent(upload), c => isFor(upload, c.deviceId));
  send(res, 201, uploadInfo(upload));
}

function getUpload(req, res, [id]) {
  const upload = uploads.get(id);
  upload ? send(res, 200, uploadInfo(upload)) : send(res, 404, { error: 'Upload not found (it may have finished or expired)' });
}

async function cancelUpload(req, res, [id]) {
  const upload = uploads.get(id);
  if (!upload) return send(res, 404, { error: 'Not found' });
  uploads.delete(id);
  upload.cancelled = true;
  notifyUpload(upload);
  log.info(`Upload of "${upload.name}" [${shortId(id)}] cancelled at ${percentOf(upload.offset, upload.size)} (by ${whoName(deviceIdOf(req, new URL(req.url, 'http://beam')))})`);
  if (upload.busy) {
    upload.activeReq?.destroy();
    await upload.settled;
  }
  await removeUploadFiles(id);
  broadcast('upload-cancelled', { id });
  send(res, 204);
}

async function partSize(id) {
  try { return (await fsp.stat(uploadPaths(id).part)).size; } catch { return 0; }
}

async function putChunk(req, res, [id], url) {
  const upload = uploads.get(id);
  if (!upload) throw httpError(404, 'Upload not found (it may have finished or expired)');
  if (upload.busy) {
    // A chunk whose connection went quiet (a phone that switched networks) would block the upload until the
    // server restarts; a new PUT takes over once it has been idle for 30 s.
    if (now() - upload.lastByte < TAKEOVER_IDLE_MS) throw httpError(409, 'Another chunk is still being written', { offset: upload.offset });
    log.warn(`Upload of "${upload.name}" [${shortId(id)}]: its connection stalled, taking over with a new one (the device probably changed networks)`);
    upload.activeReq?.destroy();
    await upload.settled;
    if (upload.cancelled || !uploads.has(id)) throw httpError(404, 'Upload not found (it may have finished or expired)');
    if (upload.busy) throw httpError(409, 'Another chunk is still being written', { offset: upload.offset });
  }
  const rawOffset = url.searchParams.get('offset');
  const offset = rawOffset === null || rawOffset === '' ? 0 : Number(rawOffset);
  if (offset !== upload.offset) throw httpError(409, 'Wrong offset', { offset: upload.offset });

  if (offset > 0 && now() - upload.touched > 60_000) {
    log.info(`Upload of "${upload.name}" [${shortId(id)}] resumed at ${percentOf(offset, upload.size)} after ${durationText(now() - upload.touched)}`);
  }
  let settle;
  upload.settled = new Promise(resolve => { settle = resolve; });
  Object.assign(upload, { busy: true, activeReq: req, lastByte: now(), touched: now() });
  let failure = null;
  const start = upload.offset;
  const durable = {
    // During the PUT: every 64 MB or 4 s. At its end: also when it broke off or finished the upload.
    want: (written, end, failed) => !upload.cancelled && (start + written - upload.synced >= SYNC_BYTES
      || now() - upload.syncedAt >= SYNC_MS || (end && (failed || start + written === upload.size))),
    done: written => {
      upload.synced = start + written;
      upload.syncedAt = now();
      return upload.cancelled ? undefined : saveUploadMeta(upload);
    },
  };
  try {
    await receiveBody(req, uploadPaths(id).part, upload.size - upload.offset, {
      flags: 'a',
      durable,
      onWritten: () => notifyUpload(upload),
      onData: received => {
        upload.received = start + received;
        upload.lastByte = upload.touched = now();
        if (now() - (upload.lastEvent || 0) >= 1000) {
          upload.lastEvent = now();
          broadcast('upload', uploadEvent(upload, upload.offset + received));
        }
      },
    });
  } catch (err) {
    failure = err;
  }
  notifyUpload(upload); // the chunk's last bytes are on disk now
  try {
    if (upload.cancelled) {
      if (!res.headersSent && !res.socket?.destroyed) send(res, 404, { error: 'The upload was cancelled' });
      return;
    }
    // Keep whatever arrived intact; the client resumes from the real size.
    upload.offset = await partSize(id);
    if (upload.offset > upload.size) {
      dropUpload(upload);
      broadcast('upload-cancelled', { id });
      throw httpError(413, 'More data than the declared size');
    }
    if (failure) {
      if (failure.status === 413) throw httpError(413, 'More data than the declared size', { offset: upload.offset });
      if (failure.code === 'ENOSPC') throw diskFull(upload.offset);
      if (!res.headersSent && !res.socket?.destroyed) throw httpError(400, 'Chunk interrupted', { offset: upload.offset });
      return;
    }
    if (upload.offset < upload.size) return send(res, 200, { offset: upload.offset, done: false });
    // The item appears in the same turn as the rename completes, so a download never finds neither the partial
    // file nor the item; the folder is fsynced before the answer.
    await fsp.rename(uploadPaths(id).part, filePath(id));
    uploads.delete(id);
    const { name, size, mime, w, h, from, device, to } = upload;
    const item = { id, kind: 'file', name, size, mime, ...(w && { w, h }), from, device, to, delivered: {}, ts: now() };
    if (size >= BIG_TRANSFER && upload.started) {
      log.info(`Upload finished: "${cutText(name, 80)}" [${shortId(id)}] in ${durationText(now() - upload.started)} (average ${speedText(size, now() - upload.started)})`);
    }
    broadcast('upload-done', { id });
    addItem(item);
    notifyUpload(upload);
    await syncDir(DIR.files);
    await rmQuiet(uploadPaths(id).meta);
    await saved();
    send(res, 201, { done: true, item: publicItem(item) });
  } finally {
    upload.busy = false;
    upload.activeReq = null;
    settle();
  }
}

// ---------------------------------------------------------------- API: files, thumbnails, events, misc

async function getFile(req, res, [id], url) {
  const item = findItem(id);
  const upload = !item && uploads.get(id);
  if (upload && !upload.cancelled) return serveLive(req, res, upload, url);
  if (!item || item.kind !== 'file') return send(res, 404, { error: 'Not found' });
  const inline = url.searchParams.has('inline');
  const logged = !inline && req.method !== 'HEAD' && noteDownload(req, url, item);
  await serveFile(req, res, filePath(id), item.name, item.mime, inline, {
    etag: `"f-${item.id}-${item.size}"`, lastModified: item.ts,
    onFinish: ({ bytes, ms }) => {
      if (logged && bytes >= BIG_TRANSFER) log.info(`Download finished: [${shortId(id)}] to ${whoName(deviceIdOf(req, url), 'a browser')}, ${formatSize(bytes)} in ${durationText(ms)} (${speedText(bytes, ms)})`);
    },
  });
}

// A file that is still being uploaded (GET /api/file/<upload id>). The response announces the final size and sends
// bytes as they reach the disk, read from the partial file, so a slow reader never slows the upload; a range beyond
// what has arrived waits. It is cut off when no new bytes arrive for 60 s or the upload is cancelled; the client
// then resumes with Range and If-Range, and the ETag is the finished file's, so that works across the finish.
const LIVE_IDLE_MS = FAST_TIMEOUTS ? 1500 : 60_000;
const LIVE_READ = 1024 * 1024;

async function serveLive(req, res, upload, url) {
  const { id, size, mime, name } = upload;
  const etag = `"f-${id}-${size}"`;
  const inline = url.searchParams.has('inline') && /^(image|video|audio)\//.test(mime) && mime !== 'image/svg+xml';
  const headers = {
    'Content-Type': mime,
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', name),
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    ETag: etag,
  };
  // No Last-Modified yet (the item's time is when it finishes), so only an ETag If-Range resumes.
  const range = rangeOf(req, size, { etag, lastModified: Infinity });
  if (range === 'unsatisfiable') return send(res, 416, '', { 'Content-Range': `bytes */${size}` });
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range) {
    ({ start, end } = range);
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = size ? end - start + 1 : 0;
  let fh;
  try {
    fh = await fsp.open(uploadPaths(id).part, 'r');
  } catch {
    // It finished in the meantime: the partial file is the item's file now.
    try {
      fh = await fsp.open(filePath(id), 'r');
    } catch {
      return findItem(id) ? getFile(req, res, [id], url) : send(res, 404, { error: 'Not found' });
    }
  }
  const watchers = (upload.watchers ||= new Set());
  let wake = null;
  const onWake = () => wake?.();
  watchers.add(onWake);
  res.once('close', onWake);
  let pos = start;
  try {
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || !size) return res.end();
    res.flushHeaders(); // the client learns the size (and that it's coming) before the first byte has arrived
    if (!url.searchParams.has('inline') && !/^bytes=[1-9]/.test(req.headers.range || '')) noteDownload(req, url, { id, kind: 'file', name, size });
    let grew = now();
    let known = 0; // (audit P-2) the size last seen on disk: looked at again only once it has been read up to
    // The client can leave during any await below: check after each one, or the loop would wait for a 'drain' or
    // 'close' that already happened and keep the file open for good.
    while (pos <= end && !res.destroyed) {
      if (pos >= known) known = (await fh.stat()).size;
      const available = Math.min(known, end + 1);
      if (res.destroyed) break;
      if (available > pos) {
        const chunk = Buffer.allocUnsafe(Math.min(LIVE_READ, available - pos));
        const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
        if (res.destroyed) break;
        if (bytesRead > 0) {
          pos += bytesRead;
          grew = now();
          if (!res.write(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead))) await drained(res);
          continue;
        }
      }
      // Nothing new on disk. Finished just now: the handle still reads the renamed file, so read the rest.
      // Cancelled, or nothing new for 60 s: cut off.
      if (uploads.get(id) !== upload || upload.cancelled) {
        if (findItem(id) && (await fh.stat()).size > pos && !res.destroyed) continue;
        break;
      }
      if (now() - grew > LIVE_IDLE_MS) break;
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 1000);
        wake = () => { clearTimeout(timer); resolve(); };
      });
      wake = null;
    }
  } finally {
    watchers.delete(onWake);
    await fh.close().catch(() => {});
  }
  if (res.destroyed || res.writableEnded) return;
  if (pos > end) res.end();
  else res.destroy(); // cut off: the client resumes (or gives up on upload-cancelled)
}

// Resolves once the client has taken what was sent ('drain') or is gone ('close', or already destroyed). Only those
// end the wait: new upload data must not, or a slow reader would have the upload piled up in memory for it.
function drained(res) {
  return new Promise(resolve => {
    if (res.destroyed || !res.writableNeedDrain) return resolve();
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

function rangeOf(req, size, { etag, lastModified }) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!match || (!match[1] && !match[2]) || !size) return null; // absent, invalid or multi-range, or empty file
  // If-Range: only resume when the client's copy is this very file.
  const ifRange = req.headers['if-range'];
  if (ifRange) {
    const ok = /^(W\/)?"/.test(ifRange) ? ifRange === etag : Date.parse(ifRange) >= Math.floor(lastModified / 1000) * 1000;
    if (!ok) return null;
  }
  let start;
  let end = size - 1;
  if (match[1] === '') {
    start = Math.max(0, size - Number(match[2]));
    if (Number(match[2]) === 0) return 'unsatisfiable';
  } else {
    start = Number(match[1]);
    if (match[2] !== '') {
      const last = Number(match[2]);
      if (last < start) return null; // "5-2" is invalid: ignore the header
      end = Math.min(end, last);
    }
  }
  return start >= size ? 'unsatisfiable' : { start, end };
}

async function serveFile(req, res, file, name, mime, inline, { cache = 'private, max-age=31536000, immutable', etag, lastModified, onFinish } = {}) {
  let stat;
  try { stat = await fsp.stat(file); } catch { return send(res, 404, { error: 'File is missing' }); }
  inline = inline && /^(image|video|audio)\//.test(mime) && mime !== 'image/svg+xml';
  lastModified ??= stat.mtimeMs;
  etag ??= `"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  const headers = {
    'Content-Type': mime,
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', name),
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': cache,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': new Date(lastModified).toUTCString(),
  };
  if (req.headers['if-none-match'] === etag) return send(res, 304, '', headers);
  const range = rangeOf(req, stat.size, { etag, lastModified });
  if (range === 'unsatisfiable') return send(res, 416, '', { 'Content-Range': `bytes */${stat.size}` });
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  if (range) {
    ({ start, end } = range);
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length'] = stat.size ? end - start + 1 : 0;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || !stat.size) return res.end();
  const began = now();
  const complete = await pipeline(fs.createReadStream(file, { start, end, highWaterMark: MB }), res).then(() => true, () => false);
  if (complete) onFinish?.({ bytes: end - start + 1, ms: now() - began });
}

const THUMB_TYPES = { 'image/jpeg': 'jpeg', 'image/webp': 'webp' };

// Sender-made thumbnails for image and video items (the server has no image libraries).
async function putThumb(req, res, [id]) {
  const item = findItem(id);
  if (!item || item.kind !== 'file') return send(res, 404, { error: 'Not found' });
  if (!/^(image|video)\//.test(item.mime)) throw httpError(400, 'Thumbnails are only for images and videos');
  const format = THUMB_TYPES[String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()];
  if (!format) throw httpError(415, 'Send the thumbnail as image/jpeg or image/webp');
  const data = await readBody(req, MAX_THUMB).catch(err => { throw err.status === 413 ? httpError(413, 'Thumbnails can be at most 256 KB') : err; });
  const looksRight = format === 'jpeg'
    ? data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
    : data.length > 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  if (!looksRight) throw httpError(400, `That isn't a ${format.toUpperCase()} image`);
  await writeFileDurable(thumbPath(id), data);
  if (!findItem(id)) { await rmQuiet(thumbPath(id)); return send(res, 404, { error: 'Not found' }); }
  item.thumb = format;
  itemChanged(item);
  broadcastUpdate(item);
  send(res, 204);
}

async function getThumb(req, res, [id]) {
  const item = findItem(id);
  if (!item?.thumb) return send(res, 404, { error: 'No thumbnail' });
  await serveFile(req, res, thumbPath(id), `${item.id}.${item.thumb === 'webp' ? 'webp' : 'jpg'}`, `image/${item.thumb}`, true, { cache: 'private, max-age=86400' });
}

const APP_LABEL = { windows: 'Windows', android: 'Android', linux: 'Linux' };

async function downloadApp(req, res, [platform]) {
  const file = path.join(DIST_DIR, APPS[platform]);
  const mime = platform === 'android' ? MIME.apk : platform === 'linux' ? MIME.js : MIME.exe;
  if (!fs.existsSync(file)) return send(res, 404, { error: `The ${platform} app hasn't been built yet` });
  if (req.method !== 'HEAD' && !/^bytes=[1-9]/.test(req.headers.range || '')) {
    const url = new URL(req.url, 'http://beam');
    const version = readJsonQuiet(`${file}.json`)?.version || '?';
    log.info(`${whoName(deviceIdOf(req, url), `A device at ${describeWhereSync(req)}`)} is downloading the ${APP_LABEL[platform]} app ${version}`);
  }
  // The file changes whenever the app is rebuilt, so it must not be cached for long.
  await serveFile(req, res, file, APPS[platform], mime, false, { cache: 'no-cache' });
}

// ---------------------------------------------------------------- Beam for Linux's installer (1.22)
// `curl -fsSL <Beam>/install/linux | bash` on a Linux computer that's on the tailnet: GET /install/linux is the script
// (linux/install.sh) with this Beam's address in it, GET /install/linux/beam.js the app it installs (dist's
// beam-linux.js). Both without a sign-in: that's how a new computer gets the app, which then signs in as it installs
// (Tailscale, else a code to approve). Neither holds anything that isn't in the app's source.

const LINUX_INSTALLER = path.join(__dirname, 'linux', 'install.sh');
const HOST_HEADER = /^([a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*|\[[0-9a-f:.]{2,45}\])(:\d{1,5})?$/;

// The address the request came to (through tailscale serve: the name it was asked for): the computer reached Beam
// there, so its app will too. Only a plain host name or address, as it goes into a shell script.
function requestBase(req) {
  const host = requestHost(req).trim().toLowerCase();
  if (HOST_HEADER.test(host)) return `${isHttps(req) ? 'https' : 'http'}://${host}`;
  const known = publicBaseSync();
  return known && /^https?:\/\/[a-z0-9.:[\]-]+$/i.test(known) ? known : null;
}

async function linuxInstall(req, res, pathname) {
  req.routeName = 'linuxInstall';
  if (pathname === '/install/linux/beam.js') {
    const file = path.join(DIST_DIR, APPS.linux);
    if (!fs.existsSync(file)) return send(res, 404, 'Beam for Linux hasn\'t been built on this Beam yet (node linux/build.mjs).\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    if (req.method !== 'HEAD') log.info(`A computer at ${describeWhereSync(req)} is installing Beam for Linux ${readJsonQuiet(`${file}.json`)?.version || '?'}`);
    return serveFile(req, res, file, 'beam.js', MIME.js, true, { cache: 'no-cache' });
  }
  const base = requestBase(req);
  let script;
  try { script = await fsp.readFile(LINUX_INSTALLER, 'utf8'); } catch { return send(res, 404, 'No installer here.\n', { 'Content-Type': 'text/plain; charset=utf-8' }); }
  if (!base) return send(res, 400, 'Open this through Beam\'s own address.\n', { 'Content-Type': 'text/plain; charset=utf-8' });
  // (text/plain: a browser shows it, to read before running it)
  send(res, 200, script.replace(/\r\n/g, '\n').replace('__BEAM_URL__', base), { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
}

// ---------------------------------------------------------------- app updates
// Each build drops a sidecar next to the app in dist/ (beam.apk.json, Beam.exe.json) with its version; apps
// compare it with their own and update themselves, verifying the SHA-256.

const sha256Cache = new Map(); // file -> { mtimeMs, size, hash }
async function fileSha256(file) {
  const stat = await fsp.stat(file);
  const cached = sha256Cache.get(file);
  if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return { hash: cached.hash, size: stat.size };
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  const hex = hash.digest('hex');
  sha256Cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, hash: hex });
  return { hash: hex, size: stat.size };
}

// Reads a sidecar without touching it: a build may still be writing it.
function readJsonQuiet(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

async function appUpdates() {
  const out = {};
  for (const [platform, name] of Object.entries(APPS)) {
    const file = path.join(DIST_DIR, name);
    const meta = readJsonQuiet(`${file}.json`);
    if (!fs.existsSync(file) || !meta?.version) continue;
    const { hash, size } = await fileSha256(file);
    out[platform] = { ...meta, url: `/download/${platform}`, size, sha256: hash };
  }
  return out;
}

// (1.19) While a Windows build goes to one PC first, the other Windows apps aren't offered it yet.
async function getUpdates(req, res, _m, url) {
  const updates = await appUpdates();
  noticeWindowsBuild(updates);
  send(res, 200, offersFor(deviceIdOf(req, url), updates));
}

// A Windows app that connects while running an older version than the one in dist is told at once (1.7.2). It checks
// only when it starts, every 6 hours and when told: three PCs that reconnected 2 s after a restart's "app-update"
// broadcast missed it (1.7.1's deploy). Android checks by itself; not repeated there.
async function offerUpdateOnConnect(client, req, url) {
  if (platformOf(req, url) !== 'windows') return;
  const version = appVersionOf(req, url);
  if (!version) return;
  try {
    const updates = await appUpdates();
    noticeWindowsBuild(updates);
    const mine = offersFor(client.deviceId, updates); // (1.19)
    const offered = mine.windows?.version;
    if (!offered || offered === version || !versionAtLeast(offered, version) || client.res.writableEnded) return;
    writeTo(client, `event: app-update\ndata: ${JSON.stringify(mine)}\n\n`);
  } catch {}
}

// Tell connected apps as soon as a new build lands in dist/: fs.watch for speed (re-armed when dist/ is
// recreated), plus a check every minute for file systems where watching doesn't work (network shares).
let distWatcher = null;
let distWatchedIno = null;
let distTimer;
let lastUpdatesSent = null;

function distSignature() {
  return Object.values(APPS).flatMap(name => [name, `${name}.json`]).map(name => {
    try { const s = fs.statSync(path.join(DIST_DIR, name)); return `${name}:${s.size}:${s.mtimeMs}`; } catch { return `${name}:-`; }
  }).join('|');
}

function watchDist() {
  let ino;
  try {
    fs.mkdirSync(DIST_DIR, { recursive: true });
    ino = fs.statSync(DIST_DIR).ino;
  } catch {
    return;
  }
  if (distWatcher && ino === distWatchedIno) return;
  try { distWatcher?.close(); } catch {}
  try {
    distWatcher = fs.watch(DIST_DIR, () => {
      clearTimeout(distTimer);
      distTimer = setTimeout(checkDist, 3000); // builds write several files; wait for them to settle
    });
    distWatcher.on('error', () => { try { distWatcher.close(); } catch {} distWatcher = null; });
    distWatchedIno = ino;
  } catch {
    distWatcher = null;
  }
}

let distSeen = null;
async function checkDist() {
  const signature = distSignature();
  if (signature === distSeen) return;
  distSeen = signature;
  try {
    const updates = await appUpdates();
    const json = JSON.stringify(updates);
    if (lastUpdatesSent !== null && json !== lastUpdatesSent) {
      const before = JSON.parse(lastUpdatesSent);
      const changed = Object.entries(updates).filter(([p, u]) => before[p]?.sha256 !== u.sha256)
        .map(([p, u]) => `${APP_LABEL[p] || p} ${u.version}`);
      if (changed.length) log.info(`New app build${changed.length > 1 ? 's' : ''} published: ${changed.join(', ')}; telling connected apps to update`);
      noticeWindowsBuild(updates);
      broadcast('app-update', updates, null, c => offersFor(c.deviceId, updates) === updates); // (1.19: not the held-back PCs)
    }
    lastUpdatesSent = json;
  } catch {}
}

// ---------------------------------------------------------------- updates one PC at a time (1.19)
// A new Windows build goes to one PC first (the pilot: this server's own PC when its Beam app is online, else the
// Windows app seen last), and to the others once the pilot has run it for 10 minutes and is still connected (the user:
// "lets keep going", on updates one PC at a time: on 2026-10-07 all 7 PCs installed 1.13.0 within 3 minutes). A pilot
// that tries it and goes back (Beam for Windows rolls back a build that fails its health check, and reports why) stops
// it there, with an alert. A pilot that hasn't installed it within 30 minutes (asleep, updates turned off, being
// controlled) hands over to another online PC. Settings → Server shows where it is, can offer it to every PC at once,
// and turns this off (`stagedUpdates`). Windows only: Android is one phone. State: settings.rollout.

const PILOT_MS = FAST_TIMEOUTS ? 1500 : 10 * 60e3;
const PILOT_SWITCH_MS = FAST_TIMEOUTS ? 3000 : 30 * 60e3;
let knownWindowsBuild = null; // the Windows build in dist when last looked at (its sha256; '' for none)

const stagedOn = () => settings.stagedUpdates !== false && env.BEAM_STAGED_UPDATES !== '0';
const windowsApps = () => Object.values(devices).filter(d => d.platform === 'windows' && d.appVersion && !d.temporary);
const activeRollout = () => { const r = settings.rollout; return r && !r.released && !r.halted ? r : null; };

function rolloutChanged() {
  persistSettings();
  broadcast('settings', publicSettings());
}

function choosePilot(skip = new Set()) {
  const ok = d => d && d.appVersion && isOnline(d.id) && !skip.has(d.id);
  const own = ownPc();
  if (ok(own)) return own;
  return windowsApps().filter(ok).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))[0] || null;
}

// Looks at the Windows build in dist: the first look at it (a server start) only notes it (a rollout already under way
// for it goes on); a new one starts a rollout when there's more than one PC to update.
function noticeWindowsBuild(updates) {
  const w = updates.windows;
  const sha = w?.sha256 || '';
  // (the file and its sidecar together: a look between a build's two writes sees a new file with the old version)
  const key = `${sha}|${w?.version || ''}`;
  if (knownWindowsBuild === null) {
    knownWindowsBuild = key;
    if (settings.rollout && (settings.rollout.sha256 !== sha || settings.rollout.version !== w?.version)) { delete settings.rollout; persistSettings(); }
    return;
  }
  if (key === knownWindowsBuild) return;
  knownWindowsBuild = key;
  if (!w || !stagedOn() || windowsApps().length < 2) {
    if (settings.rollout) { delete settings.rollout; rolloutChanged(); }
    return;
  }
  const pilot = choosePilot();
  settings.rollout = { version: w.version, sha256: sha, pilot: pilot?.id || null, since: now() };
  log.info(`Windows ${w.version}: ${pilot ? `offered to ${pilot.name} first` : 'held until a PC connects to try it first'}; the other PCs get it once it has run there for ${durationText(PILOT_MS)}`);
  if (pilot && versionAtLeast(pilot.appVersion, w.version)) pilotRuns(pilot);
  rolloutChanged();
}

// What a device is offered: the build being rolled out only to the pilot among the Windows apps (a rollout without a
// pilot takes the first Windows app that connects).
function offersFor(deviceId, updates) {
  const r = activeRollout();
  const d = devices[resolveAlias(deviceId || '')];
  if (!r || !updates.windows || updates.windows.sha256 !== r.sha256 || d?.platform !== 'windows' || d.id === r.pilot) return updates;
  if (!r.pilot && d.appVersion && isOnline(d.id)) {
    r.pilot = d.id;
    r.since = now();
    log.info(`Windows ${r.version}: offered to ${d.name} first (the first PC to connect)`);
    rolloutChanged();
    return updates;
  }
  const { windows, ...rest } = updates;
  return rest;
}

function pilotRuns(device) {
  const r = activeRollout();
  if (!r || device.id !== r.pilot || r.installedAt || !versionAtLeast(device.appVersion, r.version)) return;
  r.installedAt = now();
  log.info(`${device.name} runs Windows ${r.version}: the other PCs get it at ${clockText(r.installedAt + PILOT_MS)} if it keeps running`);
  rolloutChanged();
}

// The pilot reported that the build didn't install (or rolled back): it goes no further.
function pilotProblem(device, update) {
  const r = activeRollout();
  if (!r || device.id !== r.pilot || update.version !== r.version || !update.problem) return;
  r.halted = { at: now(), problem: String(update.problem).slice(0, 200) };
  raiseAlert('update', null, 'warn', `Beam for Windows ${r.version} didn’t work on ${device.name} (${r.halted.problem}), so the other PCs keep the version they have. Settings → Server can offer it to them anyway.`);
  rolloutChanged();
}

async function releaseRollout(why) {
  const r = activeRollout();
  if (!r) return false;
  r.released = now();
  log.info(`Windows ${r.version}: ${why}; offering it to every PC now`);
  rolloutChanged();
  try { broadcast('app-update', await appUpdates()); } catch {}
  return true;
}

function rolloutTick() {
  const r = activeRollout();
  if (!r) return;
  if (r.installedAt && now() - r.installedAt >= PILOT_MS && isOnline(r.pilot)) {
    releaseRollout(`${nameOf(r.pilot)} has run it for ${durationText(PILOT_MS)}`);
    return;
  }
  if (r.installedAt || now() - r.since < PILOT_SWITCH_MS) return;
  const next = choosePilot(new Set([r.pilot].filter(Boolean)));
  if (!next) return;
  log.info(`Windows ${r.version}: ${r.pilot ? `${nameOf(r.pilot)} hasn't installed it in ${durationText(PILOT_SWITCH_MS)}` : 'no PC has taken it'}; offering it to ${next.name} first instead`);
  r.pilot = next.id;
  r.since = now();
  rolloutChanged();
  appUpdates().then(u => sendTo(new Set([next.id]), 'app-update', u)).catch(() => {});
  if (versionAtLeast(next.appVersion, r.version)) pilotRuns(next);
}

// For Settings → Server: where the latest Windows build is (null when none went out one PC first).
function rolloutInfo() {
  const r = settings.rollout;
  if (!r) return null;
  const apps = windowsApps();
  return {
    version: r.version, pilot: r.pilot || null, pilotName: r.pilot ? nameOf(r.pilot) : null, since: r.since,
    installedAt: r.installedAt || null, releaseAt: r.installedAt && !r.released && !r.halted ? r.installedAt + PILOT_MS : null,
    released: r.released || null, halted: r.halted || null,
    running: apps.filter(d => versionAtLeast(d.appVersion, r.version)).length, pcs: apps.length,
  };
}

// POST /api/updates/release: the build waiting on its pilot (or stopped there) goes to every PC now.
async function releaseUpdate(req, res, _m, url) {
  if (authOf(req).session) throw httpError(403, 'A sign-in for this browser session only can’t do that');
  await readJson(req, { optional: true });
  const r = settings.rollout;
  if (!r || r.released) throw httpError(409, 'No Windows build is waiting to go to every PC');
  delete r.halted;
  await releaseRollout(`${whoName(deviceIdOf(req, url), 'A browser')} offered it to every PC`);
  send(res, 200, { rollout: rolloutInfo() });
}

// ---------------------------------------------------------------- API: misc

async function latestText(req, res, _m, url) {
  const me = deviceIdOf(req, url);
  const item = items.find(i => i.kind === 'text' && (!me || isFor(i, me)));
  item ? send(res, 200, await fullText(item), { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }) : send(res, 404, '', { 'Content-Type': 'text/plain' });
}

async function latest(req, res, _m, url) {
  const kind = url.searchParams.get('kind');
  const me = deviceIdOf(req, url);
  const item = items.find(i => (!kind || i.kind === kind) && (!me || isFor(i, me)));
  item ? send(res, 200, await fullItem(item)) : send(res, 404, { error: 'Nothing yet' });
}

const isFor = (item, deviceId) => (!item.to || item.to.length === 0 || item.to.includes(deviceId)) && item.from !== deviceId;

// GET /api/events[?mode=background|foreground][&ping=<seconds>]: the event stream (see "live updates").
function events(req, res, _m, url) {
  if (req.method === 'HEAD') return send(res, 405, { error: 'Open the event stream with GET' });
  const auth = authOf(req);
  const mode = url.searchParams.get('mode') === 'background' ? 'background' : 'foreground';
  const ping = streamPing(mode, url.searchParams.get('ping'));
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  req.socket.setNoDelay(true);
  const deviceId = deviceIdOf(req, url);
  const kind = platformOf(req, url) === 'web' ? 'web' : 'app';
  const machine = machineOf(req);
  const profile = profileOf(req, url);
  const client = {
    id: crypto.randomBytes(9).toString('base64url'), res, socket: req.socket, deviceId, kind, tokenHash: auth.hash, master: auth.via === 'master',
    mode, ping, held: [], beat: null, since: now(), lastWrite: now(), writes: 0, bytes: 0, events: 0, heldTotal: 0, pokes: 0,
    // For remote control: a session-only sign-in, the machine and Windows account, the sign-in, and whether it may
    // take part at all (see rcPcStream, sendToViewer).
    temporary: Boolean(auth.session) || Boolean(devices[deviceId]?.temporary), machine, profile,
    credKey: rcCredKey(auth, machine, profile), rcOk: !rcIneligible(req, url), rcPc: rcPcSignIn(auth), rcKey: windowsKeyShown(auth, req),
  };
  setStreamTimers(client);
  clients.add(client);
  writeTo(client, `retry: 3000\n\nevent: hello\ndata: ${JSON.stringify({ serverId: SERVER_ID, instance: INSTANCE_ID, version: VERSION, api: API_VERSION, web: webVersion(), features: FEATURES, stream: client.id, mode, ping })}\n\n`);
  if (deviceId) {
    const p = presenceOf(deviceId);
    if (p.web + p.app === 0) {
      noteOnline(deviceId, req, url);
      backOnline(deviceId);
    }
    presence.set(deviceId, { ...p, [kind]: p[kind] + 1 });
    broadcastDevices();
    if (kind === 'app') rcOnConnect(client);
    if (kind === 'app') offerUpdateOnConnect(client, req, url);
    if (kind === 'app') appsOnConnect(client); // (1.21) installs or removals asked while it was away
  }
  res.on('close', () => {
    clearTimeout(client.beat);
    clients.delete(client);
    if (!client.deviceId) return;
    const id = resolveAlias(client.deviceId); // it may have been merged while connected
    const p = presenceOf(id);
    const left = { ...p, [kind]: Math.max(0, p[kind] - 1) };
    left.web + left.app > 0 ? presence.set(id, left) : presence.delete(id);
    if (!(left.web + left.app > 0)) {
      noteOffline(id);
      watchOffline(id);
    }
    if (devices[id]) devices[id].lastSeen = now();
    broadcastDevices();
  });
}

async function info(req, res) {
  const apps = Object.fromEntries(Object.entries(APPS).map(([k, f]) => [k, fs.existsSync(path.join(DIST_DIR, f))]));
  const disk = await diskInfo();
  const fileItems = items.filter(i => i.kind === 'file');
  send(res, 200, {
    version: VERSION,
    api: API_VERSION,
    serverId: SERVER_ID,
    features: FEATURES,
    uptime: Math.round(process.uptime()),
    retentionDays: setting('retentionDays'),
    maxItems: setting('maxItems'),
    maxUpload: MAX_UPLOAD,
    chunkSize: CHUNK_SIZE,
    maxChunkSize: MAX_CHUNK,
    maxStorage: MAX_STORAGE || null,
    storage: { used: storageUsed(), items: items.length, files: fileItems.length, free: disk?.free ?? null, total: disk?.total ?? null },
    publicUrl: (await publicBase()) || null,
    urls: knownUrls(),
    tailscaleSignIn: setting('tailscaleSignIn'),
    tailscaleOwners: [...owners()],
    moving: isFrozen(),
    ntfy: Boolean(NTFY_URL),
    apps,
    passwordSet: hasPassword(),
    settings: publicSettings(),
    // (1.7) Beam Family, the family's chat (its own server): where it is, for a "Family" link in the apps
    family: FAMILY_URL,
  });
}

const FEATURES = [
  'tokens', 'tailscale-sign-in', 'settings', 'move', 'handoff', 'export', 'forward', 'bulk-delete', 'pin', 'read-markers',
  'logs', 'text-files', 'thumbnails', 'sessions', 'upload-progress', 'proof',
  'device-status', 'ring', 'wake', 'remote-desktop', 'alerts',
  'stream-modes', 'items-since', 'gzip', 'live-download', 'big-chunks', 'clear-cache',
  'phone-notifications', 'remote-control', 'backups',
  ...(FAMILY_URL ? ['fast-links'] : []), // (1.13.0: Beam Family on this machine makes fast links of Beam's files)
  'replies', 'reactions', 'edit', // (1.14.0)
  'kvm', // (1.16.0: a remote control session of kind kvm, a PC's keyboard and mouse shared with another)
  'connections', // (1.17.0: GET /api/connections + test, devices' Tailscale state, tailscaleKey alerts)
  'history', // (1.18.0: each device's history, POST/GET /api/devices/…/history, powerLoss alerts)
  'speed-test', // (1.18.0: /api/speedtest/down|up|result, POST /api/connections/{id}/speed, the `speed-test` event)
  'staged-updates', // (1.19.0: a Windows build goes to one PC first; settings `stagedUpdates`, `rollout`; POST /api/updates/release)
  'setup-check', // (1.20.0: GET /api/setup, `setup` alerts, status startsWithWindows/startWanted)
  'device-logs', // (1.20.0: POST /api/devices/{id}/log, the `log-request` event, POST /api/devices/me/log)
  'apps', // (1.21.0: /api/apps (GitHub, files, winget), `app-install`/`app-uninstall`, /api/devices/me/apps, `can.apps`)
  'linux', // (1.22.0: Beam for Linux: /install/linux, updates `linux`, status model/bootedAt/temperature/throttled, `hardware` alerts)
  'vnc', // (1.23.0: remote control of a Linux computer: rc sessions of kind vnc, relayed at GET /api/rc/sessions/{id}/vnc)
];

// A pairing link for another device: a single-use token that becomes that device's own token (15 minutes).
function createPairing(byDevice) {
  const token = randomSecret('bp_', 24);
  tokenStore.pairing[sha256hex(token)] = { created: now(), expires: now() + PAIRING_TTL, by: byDevice || null, user: 'owner', role: 'owner' };
  persistTokens();
  return token;
}

async function pairInfo(req, res, _m, url) {
  const key = createPairing(deviceIdOf(req, url));
  const lanUrl = lanBase();
  const publicUrl = (await publicBase()) || null;
  const base = publicUrl || lanUrl;
  send(res, 200, { key, lanUrl, publicUrl, expiresAt: now() + PAIRING_TTL, link: base ? `${base}/?key=${encodeURIComponent(key)}` : null });
}

async function qrSvg(req, res, _m, url) {
  const data = url.searchParams.get('data') || '';
  if (!data || data.length > 1000) throw httpError(400, 'Bad QR data');
  const svg = await QRCode.toString(data, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
  send(res, 200, svg, { 'Content-Type': 'image/svg+xml', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' });
}

// The same QR code as a PNG, for apps that can't show SVG (the Windows app).
async function qrPng(req, res, _m, url) {
  const data = url.searchParams.get('data') || '';
  if (!data || data.length > 1000) throw httpError(400, 'Bad QR data');
  const png = await QRCode.toBuffer(data, { type: 'png', margin: 2, scale: 8, errorCorrectionLevel: 'M' });
  send(res, 200, png, { 'Content-Type': 'image/png' });
}

async function putRead(req, res, _m, url) {
  const me = deviceIdOf(req, url);
  if (!me) throw httpError(400, 'X-Beam-Device-Id is required');
  const { conversation, ts } = await readJson(req);
  if (typeof conversation !== 'string' || !(conversation === 'all' || DEVICE_ID.test(conversation))) throw httpError(400, 'conversation must be a device id or "all"');
  if (!Number.isFinite(ts) || ts < 0) throw httpError(400, 'ts must be a time in milliseconds');
  const conv = conversation === 'all' ? 'all' : resolveAlias(conversation);
  const marks = (readMarks[me] ||= {});
  const value = Math.min(ts, now() + 60e3);
  if (!(marks[conv] >= value)) {
    marks[conv] = value;
    persistRead();
    broadcast('read', { device: me, conversation: conv, ts: value });
  }
  send(res, 200, { read: marks });
}

function getSettings(req, res) {
  send(res, 200, publicSettings());
}

const SETTING_RULES = {
  publicUrl: v => {
    if (v === null || v === '') return '';
    const url = normalizeBaseUrl(v);
    if (!url) throw httpError(400, 'publicUrl must be an http(s) address like https://beam.example.ts.net');
    return url;
  },
  tailscaleSignIn: v => { if (typeof v !== 'boolean') throw httpError(400, 'tailscaleSignIn must be true or false'); return v; },
  tailscaleOwners: v => {
    if (!Array.isArray(v) || v.length > 50 || !v.every(x => typeof x === 'string' && x.trim() && x.length <= 200)) throw httpError(400, 'tailscaleOwners must be a list of Tailscale login names');
    return [...new Set(v.map(normalizeLogin))];
  },
  retentionDays: v => { if (!Number.isInteger(v) || v < 0 || v > 3650) throw httpError(400, 'retentionDays must be 0 (keep forever) to 3650'); return v; },
  maxItems: v => { if (!Number.isInteger(v) || v < 0 || v > 100_000) throw httpError(400, 'maxItems must be 0 (no limit) to 100000'); return v; },
  stagedUpdates: v => { if (typeof v !== 'boolean') throw httpError(400, 'stagedUpdates must be true or false'); return v; }, // (1.19)
  // Partial: only the given kinds change. offline is the full list of watched device ids.
  alerts: v => {
    if (!isPlainObject(v)) throw httpError(400, 'alerts must be an object like {"battery": true, "offline": ["<device id>"]}');
    const next = alertSettings();
    for (const [key, value] of Object.entries(v)) {
      if (['battery', 'storage', 'serverDisk', 'tailscaleKey', 'powerLoss', 'setup', 'hardware'].includes(key)) {
        if (typeof value !== 'boolean') throw httpError(400, `alerts.${key} must be true or false`);
        next[key] = value;
      } else if (key === 'offline') {
        if (!Array.isArray(value) || value.length > 100 || !value.every(id => typeof id === 'string' && DEVICE_ID.test(id))) throw httpError(400, 'alerts.offline must be a list of device ids');
        next.offline = [...new Set(value.map(resolveAlias))];
      } else {
        throw httpError(400, `Unknown alert setting: ${key}`);
      }
    }
    return next;
  },
};

async function patchSettings(req, res) {
  const body = await readJson(req);
  const url = new URL(req.url, 'http://beam');
  // (1.7.3) Letting more in (another owner, automatic sign-in back on) takes a sign-in made on purpose, not one that
  // Tailscale or this machine's Beam app made by itself. Taking away needs no more than any sign-in.
  const widens = body.allowOwner !== undefined || body.tailscaleOwners !== undefined || body.tailscaleSignIn === true;
  if (widens && !rcSignInOk(authOf(req))) {
    throw httpError(403, 'To change who signs in automatically, sign in on this device with the password, a pairing link or an approval first', { reason: 'sign-in' });
  }
  // Everything is checked before anything changes.
  const { unblockNode, allowOwner, removeOwner, ...rest } = body;
  const nodes = unblockNode === undefined ? [] : [].concat(unblockNode);
  if (!nodes.every(n => typeof n === 'string')) throw httpError(400, 'unblockNode must be a node id (from blockedNodes)');
  const loginOf = (value, name) => {
    if (value === undefined) return null;
    const login = typeof value === 'string' ? normalizeLogin(value) : '';
    if (!login || login.length > 200) throw httpError(400, `${name} must be a Tailscale login name`);
    return login;
  };
  const allow = loginOf(allowOwner, 'allowOwner');
  const remove = loginOf(removeOwner, 'removeOwner');
  if (remove && ENV_OWNERS.includes(remove)) throw httpError(409, `${remove} is set by BEAM_TAILSCALE_OWNERS on the server`);
  const changes = {};
  for (const [key, value] of Object.entries(rest)) {
    if (!SETTING_RULES[key]) throw httpError(400, `${key} can't be changed here${key === 'movedTo' ? ' (use POST /api/move)' : ''}`);
    if (ENV_SETTINGS[key] !== undefined) throw httpError(409, `${key} is set by ${ENV_NAMES[key]} on the server`);
    changes[key] = SETTING_RULES[key](value);
  }
  const by = nameOf(deviceIdOf(req, url));
  if (nodes.length) unblockNodes(nodes);
  if (allow && !owners().has(allow)) {
    settings.tailscaleOwners = [...(settings.tailscaleOwners || []), allow];
    (settings.ownerSources ||= {})[allow] = { since: now(), how: 'set', devices: settings.tailscaleSeen?.[allow]?.devices || [] };
    log.info(`Tailscale account ${statusText(allow)} is now an owner of this Beam (allowed by ${by})`);
  }
  if (remove && (settings.tailscaleOwners || []).includes(remove)) {
    settings.tailscaleOwners = settings.tailscaleOwners.filter(l => l !== remove);
    delete settings.ownerSources?.[remove];
    log.info(`Tailscale account ${statusText(remove)} is no longer an owner (removed by ${by})`);
  }
  for (const login of [allow, remove]) if (login) delete settings.tailscaleSeen?.[login];
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'tailscaleOwners') {
      settings.tailscaleOwners = value;
      settings.ownerSources = Object.fromEntries(value.map(login => [login, { ...(settings.ownerSources?.[login] || { since: now(), devices: [] }), how: settings.ownerSources?.[login]?.how === 'learned' ? 'learned' : 'set' }]));
    } else if (key === 'publicUrl') {
      settings.publicUrl = value;
      settings.publicUrlLearned = false;
    } else if (key === 'alerts') {
      const watched = new Set(value.offline);
      for (const id of alertSettings().offline) if (!watched.has(id)) stopOfflineWatch(id);
      settings.alerts = value;
    } else {
      settings[key] = value;
    }
  }
  persistSettings();
  if (Object.keys(changes).length) log.info(`Settings changed by ${by}: ${Object.keys(changes).join(', ')}`);
  if ('retentionDays' in changes || 'maxItems' in changes) setImmediate(sweep);
  if (changes.stagedUpdates === false && activeRollout()) await releaseRollout('one PC first was turned off'); // (1.19)
  broadcast('settings', publicSettings());
  send(res, 200, publicSettings());
}

function unblockNodes(nodes) {
  const before = (settings.blockedNodes || []).length;
  settings.blockedNodes = (settings.blockedNodes || []).filter(b => !nodes.includes(b.node));
  if (settings.blockedNodes.length !== before) {
    log.info(`Tailscale machine${nodes.length > 1 ? 's' : ''} ${nodes.join(', ')} may sign in automatically again`);
    persistSettings();
  }
}

function deleteBlockedNode(req, res, [node]) {
  let id = node;
  try { id = decodeURIComponent(node); } catch {}
  if (!(settings.blockedNodes || []).some(b => b.node === id)) return send(res, 404, { error: 'Not found' });
  unblockNodes([id]);
  broadcast('settings', publicSettings());
  send(res, 200, publicSettings());
}

// (audit B-3/S-3) The activity log names devices, accounts, addresses and file names: a lasting sign-in only, as backups.
async function getLogs(req, res, _m, url) {
  if (authOf(req).session) throw httpError(403, 'A sign-in for this browser session only can’t read the activity log');
  const lines = Math.min(5000, Math.max(1, Number(url.searchParams.get('lines')) || 200));
  send(res, 200, { lines: await log.tail(lines) });
}

// ---------------------------------------------------------------- sign-in: password

const hasPassword = () => Boolean(password.hash);

// One password check at a time (scrypt is deliberately slow; a burst of guesses must not stall the server).
let passwordQueue = Promise.resolve();
function passwordMatches(candidate) {
  if (!hasPassword() || typeof candidate !== 'string' || !candidate) return Promise.resolve(false);
  const { salt, hash } = password;
  const check = passwordQueue.then(async () => {
    const derived = await scrypt(candidate, Buffer.from(salt, 'base64'), 32);
    return crypto.timingSafeEqual(derived, Buffer.from(hash, 'base64'));
  });
  passwordQueue = check.catch(() => {});
  return check;
}

// Browsers sign in with the password, a pairing link/key, or a move handoff. Every attempt counts as soon as it
// starts, so parallel guesses can't slip past the limits: 5 per address per 5 minutes, 30 overall per 10.
async function login(req, res) {
  if (crossSiteBrowser(req)) return send(res, 403, { error: 'Blocked a cross-site sign-in', reason: 'csrf' });
  const ip = clientIp(req);
  const body = await readJson(req, { limit: 4096 });
  const url = new URL(req.url, 'http://beam');
  const remember = body.remember !== false;
  const client = body.client === 'app' ? 'app' : 'web';
  let via = null;
  let origin = null;
  let platform = signInPlatform(req, url, body);
  let device = typeof body.deviceId === 'string' && DEVICE_ID.test(body.deviceId) ? body.deviceId : rawDeviceIdOf(req, url);
  // A valid link, device token or master key (an app's web view signing in with its own token, say) is no password
  // guess: it never touches the password limits. Password attempts and every wrong secret count, as before.
  const secret = typeof body.handoff === 'string' ? '' : String(body.secret ?? body.key ?? body.password ?? '').trim();
  if (typeof body.handoff === 'string') {
    if (verifyHandoff(body.handoff)) via = 'handoff';
  } else {
    let key = secret;
    try { key = new URL(secret).searchParams.get('key') || secret; } catch {}
    const linked = linkSecret(key);
    if (linked) {
      via = linked.via;
      origin = linked.origin || null;
      if (linked.platform) platform = linked.platform;
      if (linked.device) device = linked.device; // a device's own token signs in as that device
    }
  }
  if (!via) {
    if (passwordIp.blocked(ip)) {
      const minutes = Math.ceil(passwordIp.retryAfter(ip) / 60);
      return send(res, 429, { error: `Too many wrong attempts. Try again in ${minutes} minute${minutes > 1 ? 's' : ''}.` }, { 'Retry-After': String(passwordIp.retryAfter(ip)) });
    }
    if (passwordGlobal.blocked('all')) return send(res, 429, { error: 'Too many sign-in attempts right now. Try again in a few minutes, or approve this device from another one.' });
    passwordIp.hit(ip);
    passwordGlobal.hit('all');
    if (secret && await passwordMatches(secret)) via = 'password';
  }
  if (!via) {
    await sleep(600);
    return send(res, 403, { error: hasPassword() ? 'That password or link isn’t right' : 'That link isn’t right. No sign-in password has been set yet.' });
  }
  if (via === 'password') passwordIp.reset(ip);
  const key = deviceKeyOf(req);
  device = claimableId(device ? resolveAlias(device) : null, key, via === 'password' ? 'password' : 'link or key');
  const token = issueToken({ device: device ? resolveAlias(device) : null, via, session: !remember, origin, platform, keyHash: device && key && devices[resolveAlias(device)]?.keyHash === key ? key : null });
  log.info(`Signed in ${device ? `"${nameOf(resolveAlias(device))}"` : 'a new device'} with ${via === 'password' ? 'the password' : via === 'handoff' ? 'a move handoff' : 'a link or key'} from ${describeWhereSync(req)}${remember ? '' : ' (this session only)'}`);
  withdrawRequestsOf(device && resolveAlias(device));
  if (client === 'app') return send(res, 200, { key: token, server: (await publicBase()) || originOf(req), ...(device && { you: resolveAlias(device) }) });
  send(res, 204, '', { 'Set-Cookie': authCookie(req, token, { session: !remember }) });
}

// What a pasted link or key signs in as: the master key, a pairing token (used up), or a device token (a new
// token for the same device, e.g. an app opening its web view). `pairingOnly`: only a pairing token (/?key=).
function linkSecret(secret, { pairingOnly = false } = {}) {
  if (!secret) return null;
  if (!pairingOnly && keyMatches(secret)) return { via: 'key' };
  const hash = sha256hex(secret);
  const pairing = tokenStore.pairing[hash];
  if (pairing && pairing.expires > now()) {
    delete tokenStore.pairing[hash];
    persistTokens();
    return { via: 'pairing' };
  }
  if (pairingOnly) return null;
  const token = tokenStore.tokens[hash];
  if (token && !tokenExpired(token) && !token.scope) {
    return { via: 'link', device: token.device && resolveAlias(token.device), origin: tokenOrigin(token), platform: tokenPlatform(token) };
  }
  return null;
}

// Set, change or (with an empty password) remove the sign-in password.
async function setPassword(req, res) {
  const body = await readJson(req);
  const next = body.password;
  if (typeof next !== 'string') throw httpError(400, 'Expected {"password": "..."}');
  // Changing or removing a set password needs the current one (1.7.2), except from a sign-in made deliberately (as
  // remote control counts them: the password, a pairing link, an approval, the master key, a Beam app's own): a
  // browser that is only signed in because of Tailscale or an app on its machine can't take the password over.
  if (hasPassword() && !rcSignInOk(authOf(req))) {
    const ip = clientIp(req);
    if (passwordIp.blocked(ip)) throw httpError(429, 'Too many wrong attempts. Try again in a few minutes.');
    if (typeof body.current !== 'string' || !body.current) throw httpError(403, 'Type your current password to change it', { reason: 'current-password' });
    passwordIp.hit(ip);
    if (!(await passwordMatches(body.current))) {
      log.warn(`A password change with a wrong current password from ${describeWhereSync(req)}`);
      throw httpError(403, 'Your current password isn’t right', { reason: 'current-password' });
    }
    passwordIp.reset(ip);
  }
  if (next === '') {
    password = {};
    persistPassword();
    log.info('The sign-in password was removed');
    return send(res, 200, { passwordSet: false });
  }
  if (next.length < 8) throw httpError(400, 'Use at least 8 characters');
  const salt = crypto.randomBytes(16);
  password = { salt: salt.toString('base64'), hash: (await scrypt(next, salt, 32)).toString('base64') };
  persistPassword();
  log.info('The sign-in password was changed');
  send(res, 200, { passwordSet: true });
}

// ---------------------------------------------------------------- sign in with another device
// A new browser or app asks to sign in and shows a QR code / short code; an already signed-in device approves
// it (Steam-style). The new device then gets its own device token (apps) or a cookie with it (browsers).

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const loginRequests = new Map(); // id -> request

const formatCode = c => `${c.slice(0, 4)}-${c.slice(4)}`;
const normalizeCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function newCode() {
  let code;
  do code = [...crypto.randomBytes(8)].map(b => CODE_CHARS[b % CODE_CHARS.length]).join('');
  while ([...loginRequests.values()].some(r => r.code === code));
  return code;
}

const publicLoginRequest = r => ({
  id: r.id, code: formatCode(r.code), name: r.name, platform: r.platform, where: r.where, createdAt: r.created, expiresAt: r.expires,
  deviceId: r.deviceId || null, tailscale: r.tailscale || null, purpose: r.purpose, remember: r.remember,
});

function settleLoginRequest(r, status, by) {
  r.status = status;
  r.by = by;
  r.settledAt = now();
  for (const wake of r.waiters) wake();
  r.waiters.clear();
  broadcast('login-request-done', { id: r.id, status });
}

function pruneLoginRequests() {
  for (const r of loginRequests.values()) {
    if (r.status === 'pending' && now() > r.expires) settleLoginRequest(r, 'expired');
    if (r.status !== 'pending' && now() - r.settledAt > 60e3) loginRequests.delete(r.id);
  }
}
setInterval(pruneLoginRequests, 30e3).unref();

const pendingRequests = () => [...loginRequests.values()].filter(r => r.status === 'pending' && now() <= r.expires);

// A device that got in some other way (password, Tailscale, pairing link) no longer needs its pending requests.
function withdrawRequestsOf(deviceId) {
  if (!deviceId) return;
  for (const r of pendingRequests()) if (r.deviceId && resolveAlias(r.deviceId) === deviceId) settleLoginRequest(r, 'withdrawn');
}

// POST /api/login-requests (no key needed): { name, platform, deviceId?, remember?, purpose? }
async function createLoginRequest(req, res) {
  pruneLoginRequests();
  const ip = clientIp(req);
  const pending = pendingRequests();
  if (loginRequestRate.blocked(ip) || pending.filter(r => r.ip === ip).length >= 3 || pending.length >= 30) {
    throw httpError(429, 'Too many sign-in requests. Wait a minute and try again.');
  }
  loginRequestRate.hit(ip);
  const body = await readJson(req, { limit: 4096 });
  const purpose = body.purpose === 'move' ? 'move' : 'sign-in';
  const secret = crypto.randomBytes(24).toString('base64url');
  const who = await describeRequester(req);
  const r = {
    id: newId(),
    code: newCode(),
    secretHash: sha256raw(secret),
    name: cleanName(body.name) || (purpose === 'move' ? 'New Beam server' : 'New device'),
    platform: validPlatform(body.platform) || 'web',
    deviceId: typeof body.deviceId === 'string' && DEVICE_ID.test(body.deviceId) ? body.deviceId : null,
    keyHash: deviceKeyOf(req), // the device key the requester showed, if any
    remember: body.remember !== false,
    purpose,
    ip,
    where: who.where,
    tailscale: who.tailscale,
    created: now(),
    expires: now() + LOGIN_TTL,
    status: 'pending',
    waiters: new Set(),
  };
  loginRequests.set(r.id, r);
  log.info(`${purpose === 'move' ? 'Move' : 'Sign-in'} request from "${r.name}" (${r.where}), code ${formatCode(r.code)}`);
  // The phone scanning this must be able to open it, so never put a localhost address in the QR code.
  const origin = originOf(req);
  const local = /^https?:\/\/(localhost|127\.|\[::1\])/i.test(origin);
  const approveUrl = `${(await publicBase()) || (local && lanBase()) || origin}/?approve=${r.code}`;
  const qrSvg = await QRCode.toString(approveUrl, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
  broadcast('login-request', publicLoginRequest(r));
  send(res, 201, { id: r.id, code: formatCode(r.code), secret, approveUrl, qrSvg, expiresAt: r.expires });
}

// GET /api/login-requests/{id}?wait (no key needed; X-Beam-Login-Secret proves it's the requester).
// With ?wait it holds the connection up to 20 s until something changes.
async function pollLoginRequest(req, res, [id], url) {
  const r = loginRequests.get(id);
  const secret = String(req.headers['x-beam-login-secret'] || url.searchParams.get('secret') || '');
  if (!r || !crypto.timingSafeEqual(sha256raw(secret), r.secretHash)) return send(res, 404, { error: 'This sign-in request was not found or has expired' });
  if (r.status === 'pending' && now() > r.expires) settleLoginRequest(r, 'expired');
  if (r.status === 'pending' && url.searchParams.has('wait')) {
    await new Promise(resolve => {
      const timer = setTimeout(done, 20_000);
      function done() { clearTimeout(timer); r.waiters.delete(done); resolve(); }
      r.waiters.add(done);
      req.on('close', done);
    });
    if (res.destroyed) return;
  }
  if (r.status === 'approved' && r.token) {
    const token = r.token;
    delete r.token; // the token is handed out once
    loginRequests.delete(id);
    const server = (await publicBase()) || originOf(req);
    // Only Beam's own pages may receive the sign-in cookie; the key in the body is readable only by the requester.
    const cookie = csrfOk(req) && r.purpose !== 'move' ? { 'Set-Cookie': authCookie(req, token, { session: !r.remember }) } : {};
    return send(res, 200, { status: 'approved', key: token, server, approvedBy: r.by }, cookie);
  }
  send(res, 200, { status: r.status === 'approved' ? 'expired' : r.status, expiresAt: r.expires });
}

// DELETE /api/login-requests/{id} (no key; X-Beam-Login-Secret): the new device gave up (window closed).
function withdrawLoginRequest(req, res, [id], url) {
  const r = loginRequests.get(id);
  const secret = String(req.headers['x-beam-login-secret'] || url.searchParams.get('secret') || '');
  if (!r || !crypto.timingSafeEqual(sha256raw(secret), r.secretHash)) return send(res, 404, { error: 'Not found' });
  if (r.status === 'pending') settleLoginRequest(r, 'withdrawn');
  loginRequests.delete(id);
  send(res, 204);
}

function findLoginRequest(code) {
  pruneLoginRequests();
  const wanted = normalizeCode(code);
  const r = [...loginRequests.values()].find(x => x.code === wanted);
  if (!r) throw httpError(404, 'No sign-in request with that code. It may have expired.');
  if (r.status !== 'pending') throw httpError(409, `That sign-in request was already ${r.status}`);
  return r;
}

// Signed-in devices: list pending requests, look one up by code, approve or deny.
function listLoginRequests(req, res, _m, url) {
  if (url.searchParams.get('code')) return send(res, 200, publicLoginRequest(findLoginRequest(url.searchParams.get('code'))));
  pruneLoginRequests();
  send(res, 200, { requests: pendingRequests().map(publicLoginRequest) });
}

async function answerLoginRequest(req, res, [action], url) {
  const { code } = await readJson(req);
  const r = findLoginRequest(code);
  const by = nameOf(deviceIdOf(req, url)) || deviceNameOf(req, url) || 'a signed-in device';
  if (action === 'approve') {
    const device = claimableId(r.deviceId ? resolveAlias(r.deviceId) : null, r.keyHash, 'approved request');
    r.token = issueToken({
      device: device ? resolveAlias(device) : null,
      keyHash: device && r.keyHash && devices[resolveAlias(device)]?.keyHash === r.keyHash ? r.keyHash : null,
      via: r.purpose === 'move' ? 'move' : 'login-request',
      session: !r.remember,
      scope: r.purpose === 'move' ? 'move' : null,
      platform: r.platform || 'web',
    });
  }
  settleLoginRequest(r, action === 'approve' ? 'approved' : 'denied', by);
  log.info(`Sign-in request from "${r.name}" (${r.where}) ${r.status} by ${by}${r.purpose === 'move' ? ' [move: full copy]' : ''}`);
  send(res, 200, { status: r.status, name: r.name });
}

// ---------------------------------------------------------------- sign-in: automatic

// Signs in a browser or app without any key when Tailscale vouches for one of the owner's accounts. (audit S-1: until
// 1.14.3 also a browser while a Beam app was connected from the same machine; with Beam on 127.0.0.1 that was every
// local process and account. Such a browser asks for approval now, which the app on that PC can give.)
async function autoPair(req, res) {
  if (crossSiteBrowser(req)) return send(res, 403, { error: 'Blocked a cross-site sign-in', reason: 'csrf' });
  const body = await readJson(req, { limit: 4096, optional: true });
  if (!(await ownHost(req))) {
    log.warn(`Refused an automatic sign-in at an address that isn't this Beam's (${statusText(requestHost(req)).slice(0, 80)}) from ${describeWhereSync(req)}`);
    return send(res, 403, { error: 'Automatic sign-in only works at this Beam’s own address', reason: 'host' });
  }
  const url = new URL(req.url, 'http://beam');
  const client = body.client === 'app' ? 'app' : 'web';
  let via = null;
  let reason = 'no-identity';
  const identity = await verifiedIdentity(req);
  if (identity?.mismatch) reason = identity.unconfirmed ? 'whois-unavailable' : 'whois-mismatch';
  else if (identity && !setting('tailscaleSignIn')) reason = 'disabled';
  else if (identity && nodeBlocked(identity.tsNode, identity.ip)) reason = 'blocked';
  else if (identity) {
    if (owners().has(identity.login)) via = 'tailscale';
    else if (!owners().size && !settings.initialized && !Object.keys(devices).length) {
      // A brand-new Beam: the first Tailscale account to sign in becomes its owner.
      addOwner(identity.login, null, 'first sign-in on a new Beam');
      via = 'tailscale';
    } else reason = 'not-owner';
  }
  if (!via) {
    const messages = {
      'no-identity': 'Tailscale didn’t say who this is', 'not-owner': 'This Tailscale account isn’t one of this Beam’s owners',
      disabled: 'Signing in with Tailscale is turned off', 'whois-mismatch': 'Tailscale gave conflicting answers about this device',
      'whois-unavailable': 'Tailscale couldn’t confirm who this is right now',
      blocked: 'This device was removed from Beam, so it can’t sign in automatically. Use the password or approve it from another device.',
    };
    return send(res, 403, { error: messages[reason], reason });
  }
  let deviceId = typeof body.deviceId === 'string' && DEVICE_ID.test(body.deviceId) ? body.deviceId : rawDeviceIdOf(req, url);
  if (!deviceId && client === 'app') deviceId = crypto.randomBytes(12).toString('hex');
  const key = deviceKeyOf(req);
  let claimed = false;
  if (deviceId) {
    deviceId = resolveAlias(claimableId(resolveAlias(deviceId), key, 'automatic'));
    // A Tailscale sign-in for an app device that exists but has no device key yet can't set its key (deviceKeySeen):
    // another Windows account on that machine could otherwise take the device over first.
    claimed = via === 'tailscale' && client === 'app' && Boolean(devices[deviceId]) && !devices[deviceId].keyHash;
    const name = cleanName(body.name) || deviceNameOf(req, url);
    const platform = validPlatform(body.platform) || (client === 'web' ? 'web' : 'other');
    if (!devices[deviceId]) {
      devices[deviceId] = { id: deviceId, name: name || identity?.node || 'New device', platform, firstSeen: now(), lastSeen: now(), user: 'owner', machine: machineOf(req) };
      markInitialized();
      persistDevices();
      broadcastDevices();
    }
    if (via === 'tailscale' && !ENV_OWNERS.includes(identity.login)) addOwner(identity.login, deviceId, 'learned');
    if (via === 'tailscale') rememberNode(deviceId, identity.tsNode);
  }
  const token = issueToken({
    device: deviceId || null, via: via === 'tailscale' ? 'tailscale' : 'autopair', platform: signInPlatform(req, url, body), claimed,
    keyHash: deviceId && key && devices[deviceId]?.keyHash === key ? key : null,
  });
  log.info(`Signed in ${deviceId ? `"${nameOf(deviceId)}"` : 'a browser'} automatically (Tailscale account ${identity.login}) from ${describeWhereSync(req)}`);
  withdrawRequestsOf(deviceId);
  if (client === 'app') return send(res, 200, { key: token, server: (await publicBase()) || originOf(req), via, you: deviceId });
  send(res, 200, { device: nameOf(deviceId) || null, via }, { 'Set-Cookie': authCookie(req, token) });
}

// POST /api/clear-cache: the page asks for this after a 401 it has confirmed came from its own Beam (same serverId)
// and after wiping its own data; the answer makes the browser drop its HTTP cache for this site (thumbnails, files
// viewed inline, which are cached for a year). No sign-in and no server state; only from Beam's own pages.
function clearCache(req, res) {
  const site = req.headers['sec-fetch-site'];
  if ((site !== undefined && site !== 'same-origin') || (req.headers.origin && !originMatches(req))) {
    return send(res, 403, { error: 'Blocked a cross-site request', reason: 'csrf' });
  }
  send(res, 204, '', { 'Clear-Site-Data': '"cache"', 'Cache-Control': 'no-store' });
}

async function logout(req, res) {
  if (crossSiteBrowser(req)) return send(res, 403, { error: 'Blocked a cross-site request', reason: 'csrf' });
  const auth = authOf(req);
  if (auth?.via === 'token') revokeTokens(h => h === auth.hash, 'signed out');
  // (over https both cookie names go: see authCookie)
  send(res, 204, '', { 'Set-Cookie': authCookie(req, '', { clear: true }), 'Clear-Site-Data': '"cache", "storage"' });
}

// Signs out every other device: the master key changes (old clients holding it must sign in again), every
// token is revoked, and the caller gets a fresh token.
async function signOutOthers(req, res, _m, url) {
  if (env.BEAM_KEY) throw httpError(409, 'The master key is set by BEAM_KEY on the server; change it there instead');
  const body = await readJson(req, { optional: true });
  const me = deviceIdOf(req, url);
  const auth = authOf(req);
  const identity = identityFromHeaders(req);
  blockNodesOf(Object.keys(devices).filter(id => id !== me), { except: devices[me]?.tsNode || callerNode(req), reason: 'every other device was signed out' });
  if (body.disableTailscaleSignIn === true && ENV_SETTINGS.tailscaleSignIn === undefined) {
    settings.tailscaleSignIn = false;
    log.info('Signing in with Tailscale was turned off');
  }
  KEY = crypto.randomBytes(24).toString('base64url');
  await writeFileDurable(FILE.key, KEY + '\n');
  const revoked = Object.keys(tokenStore.tokens).length;
  tokenStore = { tokens: {}, pairing: {} };
  for (const r of pendingRequests()) settleLoginRequest(r, 'denied', 'sign-out of all devices');
  // Owners learned from other devices are dropped; people named in settings or the environment stay.
  for (const [login, entry] of Object.entries(settings.ownerSources || {})) {
    if (entry.how === 'learned' && login !== identity?.login) {
      settings.tailscaleOwners = settings.tailscaleOwners.filter(l => l !== login);
      delete settings.ownerSources[login];
    }
  }
  settings.tailscaleSeen = {};
  persistSettings();
  const shownKey = deviceKeyOf(req);
  const token = issueToken({
    device: me, via: 'sign-out-others', origin: auth.via === 'token' ? tokenOrigin(auth.token) : 'key',
    platform: auth.via === 'token' ? tokenPlatform(auth.token) : auth.source === 'cookie' ? 'web' : explicitPlatform(req, url) || 'other',
    keyHash: (auth.via === 'token' && keyBound(auth.token) && auth.token.keyHash) || (shownKey && devices[me]?.keyHash === shownKey ? shownKey : null),
  });
  log.info(`${nameOf(me)} signed out every other device: new master key, ${revoked} sign-in${revoked === 1 ? '' : 's'} revoked`);
  endAllRcSessions('revoked', me);
  for (const c of clients) c.res.end();
  const headers = auth.source === 'cookie' ? { 'Set-Cookie': authCookie(req, token) } : { 'X-Beam-Token': token };
  broadcast('settings', publicSettings());
  send(res, 200, { key: token, revoked, tailscaleSignIn: setting('tailscaleSignIn') }, headers);
}

// ---------------------------------------------------------------- moving to another server

let moving = null; // { until, by } while a move is being prepared: changes are refused so nothing gets lost
let moveWatch = null;

const isFrozen = () => Boolean(moving && moving.until > now());

function normalizeBaseUrl(value) {
  try {
    const u = new URL(String(value).trim());
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) return '';
    return trimUrl(u.origin + u.pathname);
  } catch {
    return '';
  }
}

// The Beam at `to` must answer /api/hello with this Beam's server id and prove it holds this Beam's master key
// (an HMAC over a fresh nonce), so a stranger can't catch the clients. This server never answers its own nonces
// (helloProof): a stranger at `to` could otherwise pass them on to it and hand back its proof.
const ownNonces = new Set();
async function verifyMoveTarget(to) {
  const nonce = crypto.randomBytes(16).toString('base64url');
  let hello;
  ownNonces.add(nonce);
  try {
    const res = await outbound.request(`${to}/api/hello?nonce=${nonce}&tid=${masterTid}`, { timeout: 10_000 });
    hello = await res.json();
  } catch (err) {
    return { ok: false, retry: true, error: `${to} isn't answering (${err.cause?.code || err.message})` };
  } finally {
    setTimeout(() => ownNonces.delete(nonce), 60_000).unref?.(); // (a late relay still finds it)
  }
  if (!hello?.beam) return { ok: false, retry: true, error: `${to} isn't a Beam server` };
  if (hello.instance === INSTANCE_ID) return { ok: false, retry: false, error: `${to} is this server` };
  if (hello.serverId !== SERVER_ID) return { ok: false, retry: false, error: `${to} is a different Beam (its server id differs)` };
  const expected = crypto.createHmac('sha256', sha256raw(KEY)).update(`${SERVER_ID}:${nonce}`).digest('hex');
  // (a proof is 64 hex digits; anything else isn't compared: a 64-character string with é in it is 65 bytes, and
  // timingSafeEqual threw on it, every 5 s while a move waited; 1.7.2)
  if (typeof hello.proof !== 'string' || !/^[0-9a-f]{64}$/.test(hello.proof) || !crypto.timingSafeEqual(Buffer.from(hello.proof), Buffer.from(expected))) {
    return { ok: false, retry: false, error: `${to} doesn't hold this Beam's key (did you copy the data folder?)` };
  }
  return { ok: true };
}

function completeMove(to, by) {
  settings.movedTo = to;
  moving = null;
  if (moveWatch) { clearInterval(moveWatch.timer); moveWatch = null; }
  persistSettings();
  log.info(`Beam has moved to ${to} (by ${by}). Every client is being sent there.`);
  revokeMoveTokens('the move is done'); // (1.7.3: they could export everything until then)
  endAllRcSessions('server');
  broadcast('moved', { movedTo: to });
  setTimeout(() => { for (const c of clients) c.res.end(); }, 1000);
}

// Waits for the new server to come up (it is usually started right after the export), then moves.
function watchForTarget(to, by) {
  if (moveWatch) clearInterval(moveWatch.timer);
  moving = { until: now() + MOVE_FREEZE_MS, by };
  moveWatch = { to, timer: setInterval(async () => {
    if (!moveWatch || moveWatch.to !== to) return;
    if (!isFrozen()) {
      clearInterval(moveWatch.timer);
      moveWatch = null;
      log.warn(`Gave up waiting for ${to}; Beam stays here`);
      return;
    }
    const check = await verifyMoveTarget(to);
    if (check.ok) completeMove(to, by);
  }, 5000) };
  moveWatch.timer.unref?.();
}

async function postMove(req, res, _m, url) {
  const auth = authOf(req);
  const body = await readJson(req);
  const to = normalizeBaseUrl(body.to);
  if (!to) throw httpError(400, 'Expected {"to": "https://new-address"}');
  const by = nameOf(deviceIdOf(req, url)) || 'the server console';
  if (body.force === true) {
    if (auth.via !== 'master') throw httpError(403, 'Only the master key can skip the check');
  } else {
    const check = await verifyMoveTarget(to);
    if (!check.ok) {
      if (body.wait === true && check.retry) {
        watchForTarget(to, by);
        log.info(`Waiting for ${to} to come up before moving (up to 30 minutes); changes are paused meanwhile`);
        return send(res, 202, { status: 'waiting', movedTo: to });
      }
      // (1.7.3) One answer for "nothing there" and "something that isn't Beam" (which would tell open ports from
      // closed ones); the details go to the log.
      if (check.retry) {
        log.warn(`Not moving to ${to}: ${check.error}`);
        return send(res, 409, { error: `No Beam server answered at ${to}` });
      }
      return send(res, 409, { error: check.error });
    }
  }
  completeMove(to, by);
  send(res, 200, { movedTo: to });
}

// Undo: stop a pending move, or (with the master key, even after the move) clear the new address.
function deleteMove(req, res) {
  const auth = authOf(req);
  if (setting('movedTo') && auth?.via !== 'master') throw httpError(403, 'Only the master key can undo a move');
  if (ENV_SETTINGS.movedTo) throw httpError(409, 'The new address is set by BEAM_MOVED_TO on the server');
  const was = setting('movedTo');
  settings.movedTo = '';
  moving = null;
  if (moveWatch) { clearInterval(moveWatch.timer); moveWatch = null; }
  persistSettings();
  log.info(was ? `Move to ${was} undone; Beam is served here again` : 'Pending move cancelled');
  revokeMoveTokens(was ? 'the move was undone' : 'the move was called off'); // (also the end of import-from --no-redirect)
  send(res, 204);
}

// A signed-in browser leaving the old server gets a handoff: HMAC(master key, expiry). The new server has the
// same key, so it can check it and sign the browser in (POST /api/login { handoff }).
const usedHandoffs = new Map(); // handoff -> expiry

function makeHandoff() {
  const exp = now() + HANDOFF_TTL;
  return `${exp}.${crypto.createHmac('sha256', KEY).update(`handoff:${exp}`).digest('base64url')}`;
}

function verifyHandoff(value) {
  const m = /^(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(value || '');
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp < now() || exp > now() + HANDOFF_TTL + 60e3 || usedHandoffs.has(value)) return false;
  const expected = crypto.createHmac('sha256', KEY).update(`handoff:${exp}`).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(expected))) return false;
  usedHandoffs.set(value, exp);
  return true;
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const MOVED_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function movedPage(movedTo, handoff) {
  const to = escapeHtml(movedTo);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="beam-moved-to" content="${to}">${handoff ? `<meta name="beam-handoff" content="${escapeHtml(handoff)}">` : ''}
<title>Beam has moved</title><style>body{font:16px system-ui,sans-serif;background:#0e1014;color:#e8eaee;display:grid;place-items:center;min-height:90vh;margin:0;text-align:center}a{color:#8d80ff;font-weight:600}</style>
<div><h1>Beam has moved</h1><p>It now lives at <a id="to" href="${to}/">${to}</a></p><p>Taking you there… Bookmark the new address. The Beam apps switch over by themselves.</p></div>
<script src="moved.js"></script>`;
}

// Carries the browser's Beam identity (kept in this origin's localStorage) and the handoff to the new address.
const MOVED_JS = `'use strict';
(function () {
  var meta = function (name) { var m = document.querySelector('meta[name="' + name + '"]'); return m ? m.getAttribute('content') : ''; };
  var to = meta('beam-moved-to');
  if (!/^https?:\\/\\//.test(to)) return;
  var parts = [];
  var handoff = meta('beam-handoff');
  if (handoff) parts.push('handoff=' + encodeURIComponent(handoff));
  try {
    var id = localStorage.getItem('beam.deviceId');
    var name = localStorage.getItem('beam.device');
    if (id) parts.push('device=' + encodeURIComponent(id));
    if (name) parts.push('name=' + encodeURIComponent(name));
  } catch (e) {}
  location.replace(to + '/' + (parts.length ? '#' + parts.join('&') : ''));
})();
`;

// Served in place of the old service worker so installed web apps drop it.
const RETIRED_SW = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.registration.unregister().then(() => self.clients.matchAll()).then(cs => cs.forEach(c => c.navigate(c.url)))));
`;

// After a move, the old server only points everyone to the new address.
function handleMoved(req, res, url) {
  const movedTo = setting('movedTo');
  const { pathname } = url;
  if (pathname === '/api/hello') return hello(req, res, url);
  // The master key can still undo the move or point it somewhere else (node server.js moved-to).
  if (pathname === '/api/move' && authOf(req)?.via === 'master') {
    if (req.method === 'DELETE') return deleteMove(req, res);
    if (req.method === 'POST') return postMove(req, res, [], url);
  }
  if (pathname.startsWith('/api/') || pathname.startsWith('/download/')) return send(res, 410, { error: `Beam has moved to ${movedTo}`, movedTo });
  if (pathname === '/sw.js') return send(res, 200, RETIRED_SW, { 'Content-Type': 'text/javascript; charset=utf-8' });
  if (pathname.endsWith('/moved.js')) return send(res, 200, MOVED_JS, { 'Content-Type': 'text/javascript; charset=utf-8' });
  // Only pages get the moved page; old cached scripts and styles must not be replaced by HTML.
  if (/\.(?!html?$)[a-z0-9]+$/i.test(pathname)) return send(res, 410, 'Beam has moved', { 'Content-Type': 'text/plain; charset=utf-8' });
  const handoff = authOf(req) ? makeHandoff() : '';
  send(res, 200, movedPage(movedTo, handoff), {
    'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': MOVED_CSP, 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  });
}

// ---------------------------------------------------------------- discovery & addresses

function lanAddresses() {
  const skip = /vethernet|virtual|vmware|vbox|docker|wsl|hyper-v|loopback|bluetooth/i;
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      let score = skip.test(name) ? 3 : 0;
      if (a.address.startsWith('100.')) score += 2; // Tailscale / CGNAT
      if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) score -= 1;
      found.push({ address: a.address, score });
    }
  }
  return found.sort((a, b) => a.score - b.score).map(a => a.address);
}

// In a container the "LAN" address is the container's own; it's useless to other devices.
const IN_CONTAINER = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');

function lanBase() {
  const ip = LAN_REACHABLE && !IN_CONTAINER && lanAddresses()[0];
  return ip ? `http://${ip}:${PORT}` : null;
}

// If `tailscale serve` forwards to this server, its https://<machine>.<tailnet>.ts.net address.
let serveUrlCache = null;
async function tailscaleUrl() {
  let url = null;
  try {
    const config = await ts.serveConfig();
    const target = new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost|\\[::1\\]):${PORT}/?$`);
    const visit = node => {
      if (!node || typeof node !== 'object' || url) return;
      for (const [key, value] of Object.entries(node)) {
        const proxy = value?.Handlers?.['/']?.Proxy;
        if (/^[\w.-]+:\d+$/.test(key) && proxy && target.test(proxy)) {
          const [host, port] = key.split(':');
          url = `https://${host}${port === '443' ? '' : ':' + port}`;
          return;
        }
        visit(value);
      }
    };
    visit(config);
  } catch {}
  serveUrlCache = url;
  return url;
}

async function publicBase() {
  return setting('publicUrl') || (await tailscaleUrl());
}

function publicBaseSync() {
  return setting('publicUrl') || serveUrlCache || null;
}

// Every address this Beam is known by, for apps to remember (they can look here after a move).
function knownUrls() {
  const urls = [publicBaseSync(), ...(settings.knownHosts || []).map(h => `https://${h}`), lanBase()].filter(Boolean);
  return [...new Set(urls)];
}

// The first https address seen through tailscale serve (or another trusted proxy) on a signed-in request becomes
// the public address, unless one is configured; others are remembered for knownUrls().
function learnAddress(req) {
  if (!viaTrustedProxy(req) || !isHttps(req)) return;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  const m = /^([a-z0-9-]+(\.[a-z0-9-]+)+)(:\d+)?$/.exec(host);
  if (!m || net.isIP(m[1]) || /^localhost/.test(host)) return;
  const known = settings.knownHosts || [];
  if (!known.includes(host)) {
    settings.knownHosts = [host, ...known].slice(0, 5);
    if (!settings.publicUrl && ENV_SETTINGS.publicUrl === undefined) {
      settings.publicUrl = `https://${host}`;
      settings.publicUrlLearned = true;
      log.info(`Learned this Beam's address: https://${host}`);
    }
    persistSettings();
  }
}

// (1.7.7, audit S-33) Without `urls`: the apps read this Beam's addresses from the signed-in /api/info.
function hello(req, res, url) {
  const body = { beam: true, version: VERSION, serverId: SERVER_ID, api: API_VERSION, instance: INSTANCE_ID };
  if (setting('movedTo')) body.movedTo = setting('movedTo');
  const proof = helloProof(url);
  if (proof) body.proof = proof;
  send(res, 200, body);
}

// Proves this server holds the caller's secret without seeing it: the caller sends tid (a hash of a hash of its
// key or token) and a nonce, and checks HMAC(sha256(secret), serverId + ':' + nonce). Not for a nonce this server
// made itself (a move target being checked could relay it here), and not once Beam has moved: clients then look for
// the new server, and a stranger's address must not borrow this one's proofs.
function helloProof(url) {
  const nonce = url.searchParams.get('nonce') || '';
  const tid = url.searchParams.get('tid') || '';
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(nonce) || !/^[a-f0-9]{16}$/.test(tid)) return null;
  if (ownNonces.has(nonce) || setting('movedTo')) return null;
  const h1 = tid === masterTid ? sha256raw(KEY) : tidIndex.get(tid);
  return h1 ? crypto.createHmac('sha256', h1).update(`${SERVER_ID}:${nonce}`).digest('hex') : null;
}

// ---------------------------------------------------------------- export / import

const EXPORT_NAME = /^(beam-export\.json|key|server-id|settings\.json|password\.json|devices\.json|aliases\.json|tokens\.json|read\.json|alerts\.json|history\.json|apps\.json|items\.json|files\/[a-f0-9]{16}|texts\/[a-f0-9]{16}\.txt|thumbs\/[a-f0-9]{16}|app-files\/[a-f0-9]{8}\/[A-Za-z0-9_()+-][A-Za-z0-9._ ()+-]{0,99}|apps\/(Beam\.exe|beam\.apk|beam-linux\.js)(\.json)?)$/;

// Everything a Beam is, as a .tar.gz: the key, server id, settings, sign-ins, devices, items and their files.
// Leaves out unfinished uploads, logs and temporary files. items.json comes last and lists only the items whose
// content made it into the archive, so the snapshot is consistent even while the server keeps running.
async function writeExport(out, state, extra = {}) {
  const writer = tar.createWriter(out);
  try {
    const manifest = {
      format: 1, beam: VERSION, api: API_VERSION, serverId: state.serverId, created: new Date().toISOString(),
      items: state.items.length, devices: Object.keys(state.devices).length, ...extra,
    };
    await writer.addBuffer('beam-export.json', JSON.stringify(manifest, null, 2));
    await writer.addBuffer('key', state.key + '\n');
    await writer.addBuffer('server-id', state.serverId + '\n');
    await writer.addBuffer('settings.json', JSON.stringify(state.settings));
    if (state.password.hash) await writer.addBuffer('password.json', JSON.stringify(state.password));
    await writer.addBuffer('devices.json', JSON.stringify(state.devices));
    await writer.addBuffer('aliases.json', JSON.stringify(state.aliases));
    await writer.addBuffer('tokens.json', JSON.stringify(state.tokens));
    await writer.addBuffer('read.json', JSON.stringify(state.read));
    await writer.addBuffer('alerts.json', JSON.stringify(state.alerts || []));
    await writer.addBuffer('history.json', JSON.stringify(state.history || {})); // (1.18)
    const kept = [];
    for (const item of state.items) {
      let ok = true;
      if (item.kind === 'file') ok = await addStored(writer, `files/${item.id}`, filePath(item.id));
      if (ok && item.textFile) ok = await addStored(writer, `texts/${item.id}.txt`, textPath(item.id));
      if (ok && item.thumb && !(await addStored(writer, `thumbs/${item.id}`, thumbPath(item.id)))) delete item.thumb;
      if (ok) kept.push(item);
    }
    for (const name of Object.values(APPS)) {
      for (const f of [name, `${name}.json`]) await addStored(writer, `apps/${f}`, path.join(DIST_DIR, f));
    }
    // (1.21) The user's apps with their files (one whose file didn't make it in has none: a file app is left out, a
    // GitHub one fetches it again)
    const keptApps = [];
    for (const a of state.apps || []) {
      if (a.file && !(await addStored(writer, `app-files/${a.id}/${a.file.name}`, path.join(DIR.appFiles, a.id, a.file.name)))) a.file = null;
      keptApps.push(a);
    }
    await writer.addBuffer('apps.json', JSON.stringify(keptApps));
    await writer.addBuffer('items.json', JSON.stringify(kept));
    await writer.finish();
    return { items: kept.length, bytes: writer.bytes };
  } catch (err) {
    writer.abort(err);
    throw err;
  }
}

async function addStored(writer, name, file) {
  let stat;
  try { stat = await fsp.stat(file); } catch { return false; }
  if (!stat.isFile()) return false;
  return writer.addFile(name, file, stat.size, stat.mtimeMs);
}

function snapshotState() {
  return structuredClone({ key: KEY, serverId: SERVER_ID, settings, password, devices, aliases, tokens: tokenStore, read: readMarks, alerts, history, apps, items });
}

async function exportApi(req, res, _m, url) {
  const auth = authOf(req);
  if (auth.via !== 'master' && auth.scope !== 'move') throw httpError(403, 'Only the master key or an approved move can export this Beam');
  const freeze = url.searchParams.has('freeze');
  if (freeze) {
    moving = { until: now() + MOVE_FREEZE_MS, by: 'export for a move' };
    log.info('Exporting for a move: changes are paused until the move completes (at most 30 minutes)');
  }
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  res.writeHead(200, {
    'Content-Type': 'application/gzip',
    'Content-Disposition': contentDisposition('attachment', `beam-export-${stamp}.tar.gz`),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  try {
    const result = await writeExport(res, snapshotState());
    log.info(`Exported this Beam (${result.items} items, ${formatSize(result.bytes)}) to ${describeWhereSync(req)}`);
  } catch (err) {
    if (freeze) moving = null;
    log.warn(`Export stopped: ${err.message}`);
    res.destroy();
  }
}

// ---------------------------------------------------------------- backups of this server (1.8.1)

// An export every BACKUP_HOURS into BACKUP_DIR as beam-backup-<UTC time>.tar.gz; the newest BACKUP_KEEP of that name
// are kept (nothing else in the folder is touched). Item files go in while they add up to at most BACKUP_FILES, the
// smallest first (audit B-1: it used to be all or none, so with a big storage cap usually none): items expire anyway,
// and the key, sign-ins, devices, their apps' settings and the server's own are what a backup is for. A file left out
// isn't in the backup's item list (Beam has no "file gone" state: the same as a file cleared for space). To restore one: stop Beam, then
// `node server.js import <backup> --force` (the data folder's contents are moved aside, not deleted).
const BACKUP_NAME = /^beam-backup-\d{8}-\d{6}\.tar\.gz$/;
let backupTimer = null;
let backupRun = null;  // the backup being written
let lastBackup = null; // { at, name, bytes, files, filesLeftOut, why } or { at, error, why }
let backupDirPrivate = false; // (audit B-2) made private once per run, like the data folder

async function listBackups() {
  let names = [];
  try { names = (await fsp.readdir(BACKUP_DIR)).filter(n => BACKUP_NAME.test(n)); } catch { return []; }
  const list = [];
  for (const name of names) {
    try { const st = await fsp.stat(path.join(BACKUP_DIR, name)); list.push({ name, at: Math.round(st.mtimeMs), bytes: st.size }); } catch {}
  }
  return list.sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
}

// One at a time: a second asks while one is written get that one.
function backupNow(why) {
  return (backupRun ||= (async () => {
    const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const name = `beam-backup-${stamp}.tar.gz`;
    const file = path.join(BACKUP_DIR, name);
    const partial = `${file}.partial`;
    try {
      await fsp.mkdir(BACKUP_DIR, { recursive: true });
      if (!backupDirPrivate) { backupDirPrivate = true; makePrivate(BACKUP_DIR, { log, env, label: 'backups folder' }); }
      const state = snapshotState();
      const fileItems = state.items.filter(i => i.kind === 'file');
      let room = BACKUP_FILES;
      const fit = new Set(fileItems.slice().sort((a, b) => (a.size || 0) - (b.size || 0))
        .filter(i => (i.size || 0) <= room && ((room -= i.size || 0), true)).map(i => i.id));
      const leftOut = fileItems.filter(i => !fit.has(i.id));
      if (leftOut.length) state.items = state.items.filter(i => i.kind !== 'file' || fit.has(i.id));
      await writeExport(fs.createWriteStream(partial, { mode: 0o600 }), state, { filesLeftOut: leftOut.length });
      await fsp.rename(partial, file);
      const bytes = (await fsp.stat(file)).size;
      const files = !leftOut.length; // (every file in it: what 1.8.1's `files` meant)
      lastBackup = { at: now(), name, bytes, files, filesLeftOut: leftOut.length, why };
      const outBytes = leftOut.reduce((n, i) => n + (i.size || 0), 0);
      const without = leftOut.length ? `, without ${leftOut.length} of its ${fileItems.length} files (${formatSize(outBytes)}: backups hold ${formatSize(BACKUP_FILES)} of files, the smallest first; BEAM_BACKUP_FILES_MB)` : '';
      log.info(`Backed up this Beam (${why}): ${name}, ${formatSize(bytes)}${without}, in ${BACKUP_DIR}`);
      const old = (await listBackups()).slice(BACKUP_KEEP);
      for (const b of old) await rmQuiet(path.join(BACKUP_DIR, b.name));
      if (old.length) log.info(`Removed ${old.length} old backup${old.length > 1 ? 's' : ''} (the newest ${BACKUP_KEEP} are kept)`);
      return lastBackup;
    } catch (err) {
      await rmQuiet(partial);
      lastBackup = { at: now(), error: err.message, why };
      log.warn(`The backup (${why}) failed: ${err.message}`);
      throw err;
    } finally {
      backupRun = null;
    }
  })());
}

// The next backup BACKUP_HOURS after the newest one, and 10 minutes after the start at the earliest (a start stays light).
async function scheduleBackups() {
  if (!BACKUP_HOURS) return log.info('Backups are off (BEAM_BACKUP_HOURS=0)');
  for (const n of await fsp.readdir(BACKUP_DIR).catch(() => [])) if (/^beam-backup-.*\.partial$/.test(n)) await rmQuiet(path.join(BACKUP_DIR, n));
  const newest = (await listBackups())[0];
  if (newest) lastBackup = { at: newest.at, name: newest.name, bytes: newest.bytes };
  const every = BACKUP_HOURS * 3600e3;
  const plan = ms => {
    clearTimeout(backupTimer);
    backupTimer = setTimeout(() => backupNow(`every ${BACKUP_HOURS} h`).catch(() => {}).finally(() => plan(every)), Math.min(ms, 2 ** 31 - 1));
    backupTimer.unref();
  };
  plan(Math.max(10 * 60e3, newest ? newest.at + every - now() : 0));
}

function backupsInfo(list) {
  return { dir: BACKUP_DIR, hours: BACKUP_HOURS, keep: BACKUP_KEEP, filesMB: Math.round(BACKUP_FILES / MB), running: Boolean(backupRun), last: lastBackup, backups: list };
}

// GET /api/backups: where they go, how often, the last one and the ones there (names, times, sizes).
async function getBackups(req, res) {
  if (authOf(req).session) throw httpError(403, 'A sign-in for this browser session only can’t see backups');
  send(res, 200, backupsInfo(await listBackups()));
}

// POST /api/backups: one now (`node server.js backup`, Settings → Server). 201 with the backups after it.
async function postBackup(req, res) {
  const auth = authOf(req);
  if (auth.session) throw httpError(403, 'A sign-in for this browser session only can’t make backups');
  const who = auth.via === 'master' && machineOf(req) === 'host' && !viaTrustedProxy(req) ? 'asked on this PC' : `asked by ${whoName(deviceIdOf(req, new URL(req.url, 'http://beam')), 'a device')}`;
  try { await backupNow(who); } catch (err) { throw httpError(500, `The backup failed: ${err.message}`); }
  send(res, 201, backupsInfo(await listBackups()));
}

// Writes an archive into DATA_DIR (and app builds into DIST_DIR when they aren't there yet).
async function importArchive(input) {
  let manifest = null;
  let count = 0;
  let bytes = 0;
  for await (const entry of tar.entries(input)) {
    if (!manifest && entry.name !== 'beam-export.json') throw new Error("This isn't a Beam export (it doesn't start with beam-export.json)");
    if (entry.type !== '0') continue;
    if (!EXPORT_NAME.test(entry.name)) {
      log.warn(`Skipping unexpected ${entry.name} in the archive`);
      continue;
    }
    if (entry.name === 'beam-export.json') {
      const chunks = [];
      for await (const c of entry.content()) chunks.push(c);
      manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!manifest.serverId || manifest.format !== 1) throw new Error('This export was made by an incompatible version of Beam');
      continue;
    }
    const dest = entry.name.startsWith('apps/') ? path.join(DIST_DIR, entry.name.slice(5)) : path.join(DATA_DIR, entry.name);
    if (entry.name.startsWith('apps/') && fs.existsSync(dest)) continue; // keep builds that are already here
    await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    const tmp = `${dest}.importing`;
    await pipeline(Readable.from(entry.content()), fs.createWriteStream(tmp, { mode: 0o600 }));
    await fsp.rename(tmp, dest);
    count++;
    bytes += entry.size;
  }
  if (!manifest) throw new Error("This isn't a Beam export");
  return { manifest, files: count, bytes };
}

// After an import: the old server's address, moves and move sign-ins don't belong to this server.
function tidyImportedSettings({ keepPublicUrl }) {
  const s = readJsonQuiet(FILE.settings) || {};
  delete s.movedTo;
  delete s.pendingMove;
  if (!keepPublicUrl) {
    delete s.publicUrl;
    delete s.publicUrlLearned;
    delete s.knownHosts;
  }
  writeFileDurableSync(FILE.settings, JSON.stringify(s));
  const t = readJsonQuiet(FILE.tokens);
  if (t?.tokens) {
    for (const [hash, record] of Object.entries(t.tokens)) if (record?.scope === 'move') delete t.tokens[hash];
    writeFileDurableSync(FILE.tokens, JSON.stringify(t));
  }
}

function dataDirHasBeam() {
  return fs.existsSync(FILE.key) || fs.existsSync(FILE.items) || fs.existsSync(FILE.devices) || fs.existsSync(FILE.serverId);
}

// Moves an existing data folder's contents aside (never deletes) before --force imports over it.
function setAsideData() {
  const aside = path.join(DATA_DIR, `replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(aside, { recursive: true });
  for (const name of fs.readdirSync(DATA_DIR)) {
    // Logs stay, and so does Tailscale's state (docker-compose keeps the machine's identity in data/tailscale), and the
    // backups when they're kept in here (1.8.1).
    if (name.startsWith('replaced-') || name === 'logs' || name === 'tailscale' || name === 'backups') continue;
    fs.renameSync(path.join(DATA_DIR, name), path.join(aside, name));
  }
  return aside;
}

// ---------------------------------------------------------------- pending move (a server made with import-from)

// When import-from couldn't tell the old server where this one lives, this server does it itself once it
// knows its own address (configured, or learned from the first request through tailscale serve).
let pendingMoveBusy = false;
let pendingMoveWarned = 0;
const warnPendingMove = message => {
  if (now() - pendingMoveWarned < 10 * 60e3) return;
  pendingMoveWarned = now();
  log.warn(message);
};

async function tryPendingMove() {
  const pending = settings.pendingMove;
  if (!pending || pendingMoveBusy) return;
  if (now() - pending.since > 24 * 3600e3) {
    log.warn(`Gave up telling ${pending.from} to send everyone here (24 hours passed). Run "node server.js moved-to ${publicBaseSync() || '<this address>'}" on the old server.`);
    delete settings.pendingMove;
    persistSettings();
    return;
  }
  const to = publicBaseSync();
  if (!to) return;
  pendingMoveBusy = true;
  try {
    const res = await postJson(`${pending.from}/api/move`, { to }, { Authorization: `Bearer ${pending.token}` }, 20_000);
    const body = await res.json().catch(() => ({}));
    if (res.ok || res.status === 410) {
      log.info(`${pending.from} now sends everyone to ${to}`);
      delete settings.pendingMove;
      persistSettings();
    } else {
      warnPendingMove(`${pending.from} didn't accept the move yet: ${body.error || res.status}`);
    }
  } catch (err) {
    warnPendingMove(`Couldn't reach ${pending.from} to finish the move: ${err.cause?.code || err.message}`);
  } finally {
    pendingMoveBusy = false;
  }
}

// ---------------------------------------------------------------- metrics (GET /api/metrics)
// Counters and fixed-size histograms, cheap enough to keep all the time. Event-loop delay needs a timer every
// 20 ms, so it is only sampled for an hour after each GET /api/metrics (an unwatched server pays nothing for it).

const BUCKETS = 80; // request times: bucket i ends at 0.1 ms × 1.25^i (the last one, at about 9 minutes, takes the rest)
const routeStats = new Map(); // route name -> { count, bytes, bytesIn, hist }

// Bytes are counted on the connection, from where its previous request ended (headers included). The socket is the
// one the request came on: by now req.socket may be gone (a refused body detaches it).
function requestDone(req, socket, started) {
  const written = socket.bytesWritten - (socket.beamWritten || 0);
  const read = socket.bytesRead - (socket.beamRead || 0);
  socket.beamWritten = socket.bytesWritten;
  socket.beamRead = socket.bytesRead;
  const name = req.routeName || 'other';
  if (name === 'events') return; // streams have their own numbers
  const ms = performance.now() - started;
  let r = routeStats.get(name);
  if (!r) routeStats.set(name, (r = { count: 0, bytes: 0, bytesIn: 0, hist: new Uint32Array(BUCKETS) }));
  r.count++;
  r.bytes += Math.max(0, written);
  r.bytesIn += Math.max(0, read);
  r.hist[Math.min(BUCKETS - 1, Math.max(0, Math.ceil(Math.log(Math.max(ms, 0.1) / 0.1) / Math.log(1.25))))]++;
}

// A percentile from the histogram, interpolated within its bucket (good to a few per cent).
function histPercentile(hist, count, p) {
  const target = count * p;
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    if (!hist[i]) continue;
    if (seen + hist[i] >= target) {
      const upper = 0.1 * 1.25 ** i;
      return Math.round((i ? upper / 1.25 : 0) + (upper - (i ? upper / 1.25 : 0)) * ((target - seen) / hist[i]) * 100) / 100;
    }
    seen += hist[i];
  }
  return null;
}

let loopHist = null;
let loopSince = 0;
let loopStop = null;
function watchLoop() {
  loopHist ||= monitorEventLoopDelay({ resolution: 20 });
  if (!loopSince) {
    loopHist.reset();
    loopHist.enable();
    loopSince = now();
  }
  clearTimeout(loopStop);
  loopStop = setTimeout(() => { loopHist.disable(); loopSince = 0; }, 3600e3);
  loopStop.unref();
}

function getMetrics(req, res) {
  // (audit B-3) a lasting sign-in, as backups and the activity log (every sign-in is an owner today: `role` can't tell)
  if (authOf(req).session) throw httpError(403, 'A sign-in for this browser session only can’t read the metrics');
  const ms = ns => (Number.isFinite(ns) && loopHist?.count ? Math.round(ns / 1e4) / 100 : null);
  const loop = { utilization: Math.round(performance.eventLoopUtilization().utilization * 1e4) / 1e4, since: loopSince || null, p50: ms(loopHist?.percentile(50)), p99: ms(loopHist?.percentile(99)), max: ms(loopHist?.max) };
  watchLoop();
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  send(res, 200, {
    at: now(),
    version: VERSION,
    uptime: Math.round(process.uptime()),
    process: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external, cpu: { user: cpu.user / 1e6, system: cpu.system / 1e6 }, loop },
    requests: Object.fromEntries([...routeStats].sort(([a], [b]) => a.localeCompare(b)).map(([name, r]) => [name, {
      count: r.count, p50: histPercentile(r.hist, r.count, 0.5), p95: histPercentile(r.hist, r.count, 0.95), bytes: r.bytes, bytesIn: r.bytesIn,
    }])),
    streams: [...clients].map(c => ({
      device: c.deviceId, name: c.deviceId ? nameOf(c.deviceId) : null, kind: c.kind, mode: c.mode, ping: c.ping, since: c.since,
      writes: c.writes, bytes: c.bytes, events: c.events, held: c.held.length, heldTotal: c.heldTotal, pokes: c.pokes,
    })),
    store: storeStats(),
    phone: {
      notifications: [...phoneNotes.values()].reduce((n, list) => n + list.size, 0), phones: phoneNotes.size, icons: phoneIcons.size,
      pending: phoneRequests.size, posted: noteStats.posted, updated: noteStats.updated, removed: noteStats.removed,
      requests: { ...noteStats.requests }, answers: { ...noteStats.answers },
    },
    rc: {
      sessions: rcSessions.size, live: [...rcSessions.values()].filter(x => x.state === 'live').length,
      started: rcStats.started, refused: rcStats.refused, ended: { ...rcStats.ended },
    },
  });
}

// ---------------------------------------------------------------- routing

const ID = '([a-f0-9]{16})';
const DEV = '([A-Za-z0-9_-]{8,64})';
const routes = [
  ['GET', '/api/me', getMe],
  ['GET', '/api/info', info],
  ['GET', '/api/devices', getDevices],
  ['PUT', '/api/devices/me/status', putStatus],
  ['PUT', '/api/devices/me/settings', putDeviceSettings],
  ['PUT', '/api/devices/me/backup', putDeviceBackup],
  ['GET', '/api/devices/me/backups', getDeviceBackups],
  ['GET', '/api/devices/me/history/since', getHistorySince],
  ['POST', '/api/devices/me/history', postHistory],
  ['GET', `/api/devices/${DEV}/history`, getHistory],
  ['POST', '/api/devices/me/log', postDeviceLog],
  ['POST', `/api/devices/${DEV}/log`, askDeviceLog],
  ['POST', '/api/devices/me/apps', reportApps], // (1.21) apps on every PC
  ['PUT', '/api/devices/me/apps', reportApps],
  ['GET', '/api/apps', listApps],
  ['POST', '/api/apps', addApp],
  ['PUT', '/api/apps/file', putAppFile],
  ['PATCH', '/api/apps/([a-f0-9]{8})', editApp],
  ['DELETE', '/api/apps/([a-f0-9]{8})', deleteApp],
  ['POST', '/api/apps/([a-f0-9]{8})/check', checkApp],
  ['GET', '/api/apps/([a-f0-9]{8})/file', getAppFile],
  ['POST', '/api/apps/([a-f0-9]{8})/install', installApp],
  ['POST', '/api/apps/([a-f0-9]{8})/uninstall', uninstallApp],
  ['GET', '/api/setup', getSetup],
  ['GET', `/api/devices/${DEV}/backups`, getDeviceBackups],
  ['GET', '/api/backups', getBackups],
  ['POST', '/api/backups', postBackup],
  ['PUT', `/api/devices/${DEV}/settings`, putDeviceSettings],
  ['GET', '/api/phone/notifications', listPhoneNotifications],
  ['DELETE', '/api/phone/notifications', clearPhoneNotifications],
  ['POST', '/api/phone/notifications/dismiss', dismissPhoneNotifications],
  ['PUT', '/api/phone/notifications/([^/]+)', putPhoneNotification],
  ['DELETE', '/api/phone/notifications/([^/]+)', deletePhoneNotification],
  ['POST', `/api/phone/notifications/${DEV}(?:/|%2[Ff])([^/]+)/reply`, replyPhoneNotification],
  ['POST', `/api/phone/notifications/${DEV}(?:/|%2[Ff])([^/]+)/action`, actPhoneNotification],
  ['POST', `/api/phone/notifications/${DEV}(?:/|%2[Ff])([^/]+)/dismiss`, dismissPhoneNotification],
  ['POST', '/api/phone/requests/([a-f0-9]{16})', answerPhoneRequest],
  ['PUT', '/api/phone/icons/([a-f0-9]{64})', putPhoneIcon],
  ['GET', '/api/phone/icons/([a-f0-9]{64})', getPhoneIcon],
  ['POST', '/api/rc/sessions', startRemoteControl],
  ['GET', '/api/rc/sessions', listRemoteControl],
  ['POST', '/api/rc/sessions/([a-f0-9]{16})/signal', signalRemoteControl],
  ['POST', '/api/rc/sessions/([a-f0-9]{16})/lease', leaseRemoteControl],
  ['POST', '/api/rc/sessions/([a-f0-9]{16})/end', endRemoteControl],
  ['POST', '/api/rc/disable', disableRemoteControl],
  ['DELETE', `/api/devices/${DEV}`, forgetDevice],
  ['POST', `/api/devices/${DEV}/ring`, ringDevice],
  ['POST', `/api/devices/${DEV}/wake`, wakeDevice],
  ['GET', `/api/devices/${DEV}/remote-desktop\\.rdp`, remoteDesktopFile],
  ['GET', '/api/alerts', getAlerts],
  ['GET', '/api/connections', getConnections],
  ['POST', `/api/connections/${DEV}/test`, testConnection],
  ['POST', `/api/connections/${DEV}/speed`, askSpeedTest],
  ['GET', '/api/speedtest/down', speedDown],
  ['POST', '/api/speedtest/up', speedUp],
  ['POST', '/api/speedtest/result', speedResult],
  ['GET', '/api/metrics', getMetrics],
  ['GET', '/api/items', listItems],
  ['DELETE', '/api/items', clearItems],
  ['POST', '/api/items/delete', deleteSome],
  ['GET', `/api/items/${ID}`, getItem],
  ['PATCH', `/api/items/${ID}`, patchItem],
  ['GET', `/api/items/${ID}/text`, getItemText],
  ['POST', `/api/items/${ID}/ack`, ackItem],
  ['POST', `/api/items/${ID}/forward`, forwardItem],
  ['POST', `/api/items/${ID}/fastlink`, fastLinkItem],
  ['PUT', `/api/items/${ID}/reactions/([^/]+)`, setReaction],
  ['DELETE', `/api/items/${ID}/reactions/([^/]+)`, setReaction],
  ['PUT', `/api/items/${ID}/thumb`, putThumb],
  ['GET', `/api/items/${ID}/thumb`, getThumb],
  ['DELETE', `/api/items/${ID}`, deleteItem],
  ['POST', '/api/text', postText],
  ['PUT', '/api/file', postFile],
  ['POST', '/api/file', postFile],
  ['GET', `/api/file/${ID}`, getFile],
  ['POST', '/api/uploads', createUpload],
  ['GET', `/api/uploads/${ID}`, getUpload],
  ['PUT', `/api/uploads/${ID}`, putChunk],
  ['DELETE', `/api/uploads/${ID}`, cancelUpload],
  ['GET', '/api/latest', latest],
  ['GET', '/api/latest/text', latestText],
  ['GET', '/api/events', events],
  ['POST', '/api/events/poke', pokeStream],
  ['GET', '/api/pair', pairInfo],
  ['POST', '/api/password', setPassword],
  ['GET', '/api/updates', getUpdates],
  ['POST', '/api/updates/release', releaseUpdate],
  ['GET', '/api/login-requests', listLoginRequests],
  ['POST', '/api/login-requests/(approve|deny)', answerLoginRequest],
  ['GET', '/api/qr\\.svg', qrSvg],
  ['GET', '/api/qr\\.png', qrPng],
  ['PUT', '/api/read', putRead],
  ['GET', '/api/settings', getSettings],
  ['PATCH', '/api/settings', patchSettings],
  ['DELETE', '/api/settings/blocked-nodes/([^/]+)', deleteBlockedNode],
  ['GET', '/api/logs', getLogs],
  ['POST', '/api/security/sign-out-others', signOutOthers],
  ['POST', '/api/move', postMove],
  ['DELETE', '/api/move', deleteMove],
  ['GET', '/api/admin/export', exportApi],
  ['POST', '/api/admin/shutdown', adminShutdown],
  ['GET', '/download/(windows|android|linux)', downloadApp],
].map(([method, pattern, handler]) => ({ method, re: new RegExp(`^${pattern}$`), handler, name: handler.name }));

// A token from an approved move may only export and move.
const MOVE_SCOPE_PATHS = new Set(['/api/admin/export', '/api/move']);
// While a move is being prepared, these still work (everything else that changes data waits).
const FROZEN_OK = /^\/api\/(move|login|logout|autopair|login-requests|events\/poke|rc\/sessions)(\/|$)/;
const UPLOAD_ROUTE = /^\/api\/(uploads\/[a-f0-9]{16}|file|apps\/file)$/;

// ---------------------------------------------------------------- static app

const APP_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

// The web app's files are kept in memory with gzip and brotli copies (brotli at its best level is slow, so it is
// made on the thread pool at start and after a deploy; gzip serves until it is ready). index.html refers to its
// scripts, styles and icons as name?v=<first 10 hex digits of the file's SHA-256>, and those URLs are served as
// immutable: a warm open asks only for index.html (no-cache) instead of revalidating every file.
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json|javascript)|image\/svg)/;
const staticCache = new Map(); // file -> { mtimeMs, size, data, gz, br, etag, version }
const staticLoading = new Map(); // file -> promise of its entry
const gzipAsync = promisify(zlib.gzip);
const brotliAsync = promisify(zlib.brotliCompress);

async function compressEntry(entry, type) {
  if (!COMPRESSIBLE.test(type) || entry.data.length <= 1024) return entry;
  entry.gz = await gzipAsync(entry.data, { level: 9 });
  brotliAsync(entry.data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: entry.data.length } })
    .then(br => { entry.br = br; }, () => {});
  return entry;
}

async function staticEntry(file) {
  const stat = await fsp.stat(file);
  if (!stat.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
  const cached = staticCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
  const key = `${file}|${stat.mtimeMs}|${stat.size}`;
  if (!staticLoading.has(key)) {
    staticLoading.set(key, (async () => {
      const data = await fsp.readFile(file);
      const hash = sha256hex(data);
      const entry = { mtimeMs: stat.mtimeMs, size: stat.size, data, etag: `"${hash.slice(0, 20)}"`, version: hash.slice(0, 10), gz: null, br: null };
      await compressEntry(entry, staticType(file));
      staticCache.set(file, entry);
      return entry;
    })().finally(() => staticLoading.delete(key)));
  }
  return staticLoading.get(key);
}

const staticType = file => MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';

// An HTML page with ?v=<version> added to every reference to a file of the app (not links to routes like
// download/, anchors or other sites). Cached until the page or one of those files changes.
const htmlCache = new Map(); // file -> { signature, entry }
async function versionedHtml(file, entry) {
  const html = entry.data.toString('utf8');
  const refs = new Map();
  for (const m of html.matchAll(/\s(?:src|href)="([^"#?:]+)"/g)) {
    const target = path.normalize(path.join(path.dirname(file), m[1]));
    if (!refs.has(m[1]) && target.startsWith(PUBLIC_DIR + path.sep)) {
      try { refs.set(m[1], (await staticEntry(target)).version); } catch {}
    }
  }
  const signature = `${entry.etag}|${[...refs].join(',')}`;
  const cached = htmlCache.get(file);
  if (cached?.signature === signature) return cached.entry;
  const data = Buffer.from(html.replace(/(\s(?:src|href)=")([^"#?:]+)(")/g, (all, a, ref, b) => (refs.has(ref) ? `${a}${ref}?v=${refs.get(ref)}${b}` : all)));
  const out = await compressEntry({ data, etag: `"${sha256hex(data).slice(0, 20)}"`, gz: null, br: null }, 'text/html');
  htmlCache.set(file, { signature, entry: out });
  return out;
}

// Loads (and compresses) every file of the app, so the first visitor after a start doesn't wait for it.
async function warmStatic() {
  try {
    for (const name of await fsp.readdir(PUBLIC_DIR, { recursive: true })) {
      const file = path.join(PUBLIC_DIR, String(name));
      await staticEntry(file).then(e => (/\.html$/.test(file) ? versionedHtml(file, e) : e)).catch(() => {});
    }
  } catch {}
}

async function serveStatic(req, res, pathname, version) {
  if (pathname === '/') pathname = '/index.html';
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return send(res, 400, 'Bad path', { 'Content-Type': 'text/plain' }); }
  const file = path.normalize(path.join(PUBLIC_DIR, decoded));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  let entry;
  try { entry = await staticEntry(file); } catch { return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' }); }
  const ext = path.extname(file).slice(1).toLowerCase();
  if (ext === 'html') entry = await versionedHtml(file, entry);
  const type = staticType(file);
  // Only the exact current version is immutable: an old page asking for an old version gets today's file, fresh.
  const immutable = ext !== 'html' && version === entry.version;
  const headers = {
    'Content-Type': /^(text\/|application\/(json|manifest\+json)|image\/svg)/.test(type) ? `${type}; charset=utf-8` : type,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ETag: entry.etag,
    Vary: 'Accept-Encoding',
  };
  if (ext === 'html') Object.assign(headers, { 'Content-Security-Policy': APP_CSP, 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin' });
  if (req.headers['if-none-match'] === entry.etag) return send(res, 304, '', headers);
  if (entry.br && accepts(req, 'br')) return send(res, 200, entry.br, { ...headers, 'Content-Encoding': 'br' });
  if (entry.gz && accepts(req, 'gzip')) return send(res, 200, entry.gz, { ...headers, 'Content-Encoding': 'gzip' });
  send(res, 200, entry.data, headers);
}

// ---------------------------------------------------------------- server

// Unauthenticated requests in flight per address: enough for a browser loading the page, too few to tie up
// the server with slow or idle connections.
const unauthOpen = new Map();

function countUnauthenticated(req, res) {
  const ip = clientIp(req);
  const n = (unauthOpen.get(ip) || 0) + 1;
  if (n > UNAUTH_PER_IP) {
    send(res, 429, { error: 'Too many connections' }, { Connection: 'close' });
    return false;
  }
  unauthOpen.set(ip, n);
  res.once('close', () => {
    const left = (unauthOpen.get(ip) || 1) - 1;
    left > 0 ? unauthOpen.set(ip, left) : unauthOpen.delete(ip);
  });
  return true;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://beam');
  const { pathname } = url;
  if (setting('movedTo')) return handleMoved(req, res, url);
  const isApi = pathname.startsWith('/api/') || pathname.startsWith('/download/');

  if (!isApi) {
    req.routeName = 'static';
    if (!countUnauthenticated(req, res)) return;
    // Opening a pairing link (/?key=...) signs the browser in with its own token, then drops the key from the
    // address bar. (1.7.3, audit S-19) Only a pairing key, which works once and expires: the master key or a
    // device's sign-in in a link would stay in the browser's history and in a proxy's logs. Those sign in on the
    // sign-in page (POST /api/login) instead; the page says the link didn't work (and drops it from the address bar).
    if (pathname === '/' && url.searchParams.has('key')) {
      const secret = url.searchParams.get('key');
      const linked = linkSecret(secret, { pairingOnly: true });
      if (linked) {
        const device = claimableId(linked.device || rawDeviceIdOf(req, url), deviceKeyOf(req), 'link');
        const token = issueToken({ device: device ? resolveAlias(device) : null, via: linked.via, origin: linked.origin, platform: linked.platform || 'web' });
        log.info(`Signed in ${device ? `"${nameOf(resolveAlias(device))}"` : 'a browser'} with a pairing link from ${describeWhereSync(req)}`);
        return send(res, 302, '', { Location: './', 'Set-Cookie': authCookie(req, token), 'Referrer-Policy': 'no-referrer' });
      }
      if (keyMatches(secret) || tokenStore.tokens[sha256hex(secret || '')]) {
        logOnce('key link', `A link with a lasting sign-in (not a pairing key) was opened from ${describeWhereSync(req)}: links sign in only with a pairing key now (Add a device makes one)`,
          n => `${n} more links with a lasting sign-in were opened`);
      }
    }
    // Share-target posts are normally caught by the service worker; if it isn't running yet, just open the app.
    if (pathname === '/share' && req.method === 'POST') return send(res, 303, '', { Location: './' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain' });
    if (pathname === '/install/linux' || pathname === '/install/linux/beam.js') return linuxInstall(req, res, pathname); // (1.22)
    return serveStatic(req, res, pathname, url.searchParams.get('v'));
  }

  // Unauthenticated: discovery, signing in, and a new device asking to be let in.
  const polled = /^\/api\/login-requests\/([a-f0-9]{16})$/.exec(pathname);
  const open = pathname === '/api/hello' || (pathname === '/api/login-requests' && req.method === 'POST') || polled
    || (['/api/login', '/api/logout', '/api/autopair', '/api/clear-cache'].includes(pathname) && req.method === 'POST');
  if (open) {
    req.routeName = pathname === '/api/clear-cache' ? 'clearCache' : 'signIn';
    if (!countUnauthenticated(req, res)) return;
    if (pathname === '/api/hello') return hello(req, res, url);
    if (pathname === '/api/clear-cache') return clearCache(req, res);
    if (pathname === '/api/login') return login(req, res);
    if (pathname === '/api/logout') return logout(req, res);
    if (pathname === '/api/autopair') return autoPair(req, res);
    if (pathname === '/api/login-requests') return createLoginRequest(req, res);
    if (req.method === 'GET') return pollLoginRequest(req, res, [polled[1]], url);
    if (req.method === 'DELETE') return withdrawLoginRequest(req, res, [polled[1]], url);
    return send(res, 405, { error: 'Method not allowed' });
  }

  const ip = clientIp(req);
  const host = machineOf(req) === 'host' && !viaTrustedProxy(req);
  const cookies = parseCookies(req);
  if (!host && badSecrets.blocked(ip) && (req.headers.authorization || cookies.beam_key || cookies[HOST_COOKIE])) {
    return send(res, 429, { error: 'Too many failed sign-ins from this address. Try again in a few minutes.' }, { 'Retry-After': String(badSecrets.retryAfter(ip)) });
  }
  const auth = authOf(req);
  if (!auth) {
    req.routeName = 'unauthorized';
    if (req._authPresented) {
      if (!host) badSecrets.hit(ip); // this machine itself is never locked out, but still logged
      noteBadKey(req);
    }
    if (!countUnauthenticated(req, res)) return;
    // serverId (public anyway through /api/hello) lets a client tell "this Beam signed me out" from a different,
    // fresh Beam at the same address (a botched move), which must not make it throw away its sign-in and data. A 401
    // clears nothing by itself: the page asks POST /api/clear-cache once it has made sure.
    return send(res, 401, { error: 'Not paired — open a pairing link first', serverId: SERVER_ID });
  }
  if (auth.source === 'cookie' && req.method !== 'GET' && req.method !== 'HEAD' && !csrfOk(req)) {
    return send(res, 403, { error: 'Blocked a cross-site request', reason: 'csrf' });
  }
  if (auth.scope === 'move' && !MOVE_SCOPE_PATHS.has(pathname)) return send(res, 403, { error: 'This sign-in can only be used to move Beam' });
  if (isFrozen() && req.method !== 'GET' && req.method !== 'HEAD' && !FROZEN_OK.test(pathname)) {
    return send(res, 503, { error: 'Beam is moving to a new server. Try again in a minute.', retryAfter: 30 }, { 'Retry-After': '30' });
  }

  touchToken(auth);
  if (auth.via === 'token' && !auth.token.platform && auth.source === 'bearer') {
    const p = explicitPlatform(req, url);
    if (RC_APP_PLATFORMS.has(p) && devices[auth.deviceId]?.platform === p) {
      auth.token.platform = p;
      persistTokens();
    }
  }
  const deviceKey = deviceKeyOf(req);
  if (auth.via === 'token' && !auth.token.device) {
    const raw = claimableId(rawDeviceIdOf(req, url), deviceKey, 'first use');
    if (raw) {
      auth.token.device = auth.deviceId = resolveAlias(raw);
      persistTokens();
    }
  }
  // A device with a device key: requests with a bearer credential acting as it must carry that key.
  const keyed = auth.source === 'bearer' && devices[deviceIdOf(req, url)];
  if (keyed?.keyHash && deviceKey !== keyed.keyHash) {
    req.routeName = 'deviceKey';
    return send(res, 403, { error: `This isn't ${keyed.name}'s Beam app (its device key is missing or different). Sign in again.`, reason: 'device-key' });
  }
  const raw = rawDeviceIdOf(req, url);
  const device = touchDevice(req, url);
  if (auth.source === 'bearer' && deviceKey && device) deviceKeySeen(auth, device, deviceKey, req, url);
  const you = device?.id || deviceIdOf(req, url);
  if (you && raw && you !== raw) res.setHeader('X-Beam-You', you);
  if (auth.via === 'master' && you) offerDeviceToken(req, res, auth, you);
  withdrawRequestsOf(you);
  learnOwner(req, you, auth);
  learnAddress(req);

  const method = req.method === 'HEAD' ? 'GET' : req.method;
  let pathMatched = false;
  for (const route of routes) {
    const m = route.re.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (route.method === method) {
      req.routeName = route.name;
      return route.handler(req, res, m.slice(1), url);
    }
  }
  req.routeName = 'notFound';
  send(res, pathMatched ? 405 : 404, { error: pathMatched ? 'Method not allowed' : 'Not found' });
}

// Old clients hold the master key. Each device is offered its own token: a cookie for browsers, the
// X-Beam-Token response header for apps (clients that understand it replace their stored key with it).
function offerDeviceToken(req, res, auth, deviceId) {
  const keyHash = devices[deviceId]?.keyHash;
  if (keyHash && deviceKeyOf(req) !== keyHash) return;
  const token = migrationToken(deviceId);
  const hash = sha256hex(token);
  if (!tokenStore.tokens[hash]) {
    tokenStore.tokens[hash] = newTokenRecord({ device: deviceId, via: 'migration', platform: auth.source === 'cookie' ? 'web' : explicitPlatform(req, new URL(req.url, 'http://beam')) || 'other', keyHash: keyHash || null });
    tokenStore.tokens[hash].mid = deviceId; // (the device id its value is made from: `device` may follow a merge)
    indexTokens();
    persistTokens();
  }
  if (auth.source === 'cookie') res.setHeader('Set-Cookie', authCookie(req, token));
  else res.setHeader('X-Beam-Token', token);
}

// `node server.js stop` asks the running server to shut down cleanly (from this machine, with the master key).
function adminShutdown(req, res) {
  if (authOf(req).via !== 'master' || machineOf(req) !== 'host' || viaTrustedProxy(req)) throw httpError(403, 'Only the master key, from the server itself');
  send(res, 202, { stopping: true });
  log.info('Stopping (requested with "node server.js stop")');
  setTimeout(() => shutdown(0), 100);
}

// Ordinary requests must arrive within 30 s (texts, up to 5 MB, within 5 minutes); uploads instead fail after
// 60 s without data (see receiveBody).
function applyRequestTimeout(req, res) {
  const hasBody = Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'];
  const route = req.url.split('?')[0];
  if (!hasBody || UPLOAD_ROUTE.test(route)) return;
  // Not cleared when the response is sent: a body that is never finished must not hold the connection open.
  const timer = setTimeout(() => req.destroy(), /^\/api\/(text|items\/[a-f0-9]{16}\/thumb)$/.test(route) ? 5 * 60e3 : REQUEST_TIMEOUT_MS);
  const clear = () => clearTimeout(timer);
  req.once('end', clear);
  req.once('close', clear);
}

let server = null;
let shuttingDown = false;

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  endAllRcSessions('server');
  for (const c of clients) c.res.end();
  server?.close();
  await Promise.race([checkpointUploads(), sleep(5000)]).catch(() => {});
  await flushAll();
  try { if (Number(fs.readFileSync(FILE.pid, 'utf8')) === process.pid) fs.rmSync(FILE.pid, { force: true }); } catch {}
  process.exit(code);
}

function serve() {
  log.setFile(path.join(DIR.logs, 'server.log'));
  openData();
  moveBigTextsOut();
  loadUploads();
  reconcileFiles();
  sweep();
  refreshTailnet(true);
  tailscaleUrl();
  distSeen = distSignature();
  appUpdates().then(u => { lastUpdatesSent = JSON.stringify(u); noticeWindowsBuild(u); }).catch(() => {});
  watchDist();

  server = http.createServer((req, res) => {
    const started = performance.now();
    const socket = req.socket;
    res.once('close', () => requestDone(req, socket, started));
    applyRequestTimeout(req, res);
    handle(req, res).catch(err => {
      if (err.code === 'ENOSPC') err = diskFull();
      if (!err.status) log.error('Request failed:', req.method, req.url.split('?')[0], err);
      if (res.headersSent || res.beamSent) return res.headersSent ? res.destroy() : undefined;
      send(res, err.status || 500, { error: err.status ? err.message : 'Server error', ...err.extra }, { ...(err.status === 413 && { Connection: 'close' }), ...err.headers });
    });
  });
  server.on('upgrade', onUpgrade); // (1.23) only the VNC relay takes a WebSocket
  server.requestTimeout = 0; // per-request limits are applied above (uploads can take hours on slow links)
  // Idle connections stay open 100 s (Node's default is 5 s): a client that asks again soon skips a new connection
  // (and its round trip), and tailscaled's proxy, which drops idle connections after 90 s, always closes first;
  // otherwise it could send a request on a connection Node is closing and turn a POST into a 502. (Since Node 18
  // headersTimeout only runs while a request's headers arrive, not on idle connections, so it stays at 30 s.)
  server.keepAliveTimeout = 100_000;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.maxConnections = MAX_CONNECTIONS;
  // A backstop for connections where nothing moves at all (event streams send a ping every 25 s).
  server.setTimeout(FAST_TIMEOUTS ? 25_000 : 120_000);

  setInterval(sweep, 30 * 60e3).unref();
  // The tailnet's machines and the serve address change rarely: look every 5 minutes (an unknown Tailscale address
  // triggers a look at once). Without a LocalAPI socket (Windows) every look starts the tailscale command.
  setInterval(() => refreshTailnet(), 5 * 60e3).unref();
  setInterval(() => tailscaleUrl(), 5 * 60e3).unref();
  setInterval(() => { if (settings.pendingMove) tailscaleUrl().then(tryPendingMove); }, 30_000).unref();
  setInterval(() => { watchDist(); checkDist(); }, FAST_TIMEOUTS ? 2000 : 60_000).unref();
  setInterval(rolloutTick, FAST_TIMEOUTS ? 300 : 30_000).unref(); // (1.19)
  setInterval(() => checkServerDisk().catch(() => {}), FAST_TIMEOUTS ? 1000 : 10 * 60e3).unref();
  setTimeout(() => checkServerDisk().catch(() => {}), FAST_TIMEOUTS ? 200 : 60_000).unref();
  for (const id of alertSettings().offline) if (devices[id]) watchOffline(id);

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') fatal(`Port ${PORT} is already in use (is Beam already running?). Set BEAM_PORT to use a different one.`);
    log.error(err);
    process.exit(1);
  });

  server.listen(PORT, HOST, async () => {
    try { fs.writeFileSync(FILE.pid, String(process.pid)); } catch {}
    warmStatic();
    const lan = lanBase();
    const remote = await publicBase();
    log.info(`Beam ${VERSION} (API ${API_VERSION}) is running on port ${PORT}; data in ${DATA_DIR}`);
    log.info(`Settings: listening on ${HOST}:${PORT}; items kept ${setting('retentionDays') || 'forever'}${setting('retentionDays') ? ' days' : ''}, at most ${setting('maxItems') || 'unlimited'} items; ` +
      `files up to ${formatSize(MAX_UPLOAD)}; Tailscale sign-in ${setting('tailscaleSignIn') ? 'on' : 'off'}; address ${remote || lan || 'local only'}`);
    // Behind tailscale serve (HTTPS), every other way in is plain HTTP: sign-ins would cross the local network in the
    // clear if a firewall rule let it in.
    if (LAN_REACHABLE && /^https:\/\/[^/]+\.ts\.net\b/i.test(remote || '') && !isSet(env.BEAM_HOST)) {
      // (only advice: devices that still use an http:// address would be cut off by it)
      log.warn(`Beam also listens for plain HTTP on every network (0.0.0.0:${PORT}). Once every device uses ${remote}, set BEAM_HOST=127.0.0.1 in .env so nothing else can reach it directly (a device still on an http:// address would lose its connection).`);
    }
    appUpdates().then(u => {
      const offered = Object.entries(u).map(([p, x]) => `${p === 'android' ? 'Android' : 'Windows'} ${x.version}`);
      if (offered.length) log.info(`Apps offered for updates: ${offered.join(', ')}`);
    }).catch(() => {});
    setTimeout(() => logStatus().catch(() => {}), 60_000).unref();
    setInterval(() => logStatus().catch(() => {}), 3600e3).unref();
    scheduleBackups().catch(err => log.warn(`Backups couldn't be planned: ${err.message}`));
    // (1.18) This server's own PC's history from Windows: a power loss here is known before anyone signs in.
    if (OWN_HISTORY) setTimeout(() => readOwnHistory().catch(err => log.warn(`This server's PC's history couldn't be read from Windows: ${err.message}`)), FAST_TIMEOUTS ? 300 : 15_000).unref();
    // (1.20) The setup check: 2 minutes in (devices have come back), then every 6 hours.
    if (SETUP_AUTO) {
      setTimeout(() => runSetupCheck(), FAST_TIMEOUTS ? 500 : 120_000).unref();
      setInterval(() => runSetupCheck(), SETUP_EVERY_MS).unref();
    }
    // (1.21) The apps from GitHub: a new release, 3 minutes in and then every 6 hours (tests ask with Check).
    if (!FAST_TIMEOUTS) {
      setTimeout(checkGithubApps, 180_000).unref();
      setInterval(checkGithubApps, APPS_CHECK_MS).unref();
    }
    console.log(`\n  This computer:  http://localhost:${PORT}`);
    if (lan) console.log(`  Local network:  ${lan}`);
    if (remote) console.log(`  Address:        ${remote}`);
    if (process.stdout.isTTY && !setting('movedTo')) {
      const link = `${remote || lan || `http://localhost:${PORT}`}/?key=${encodeURIComponent(createPairing(null))}`;
      console.log(`\nAdd a device by opening this link on it (works once, for 15 minutes):\n  ${link}\n`);
      try { console.log(await QRCode.toString(link, { type: 'terminal', small: true })); } catch {}
    } else {
      console.log(`\nTo add a device, use "Add device" on a signed-in device, or run:  node "${__filename}" pair\n`);
    }
    if (setting('movedTo')) log.info(`This Beam has moved to ${setting('movedTo')}; it only redirects clients there.`);
    tryPendingMove();
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try { process.on(signal, () => shutdown(0)); } catch {}
  }
  process.on('message', m => { if (m?.cmd === 'shutdown') shutdown(0); });
  process.on('uncaughtException', err => {
    log.error('Crashed:', err);
    flushAll(2000).finally(() => process.exit(1));
  });
  process.on('unhandledRejection', err => log.error('Unhandled promise rejection:', err));
}

// ---------------------------------------------------------------- commands

const LOCAL_HOST = /^(0\.0\.0\.0|::|)$/.test(HOST) ? '127.0.0.1' : HOST;
const LOCAL_URL = `http://${LOCAL_HOST.includes(':') ? `[${LOCAL_HOST}]` : LOCAL_HOST}:${PORT}`;

function readKeyFile() {
  if (env.BEAM_KEY) return env.BEAM_KEY;
  try { return fs.readFileSync(FILE.key, 'utf8').trim() || null; } catch { return null; }
}

// The server running on this data folder, if any (answers on the configured port with this folder's id).
async function runningServer() {
  let id;
  try { id = fs.readFileSync(FILE.serverId, 'utf8').trim(); } catch { return false; }
  try {
    const hello = await (await fetch(`${LOCAL_URL}/api/hello`, { signal: AbortSignal.timeout(2000) })).json();
    return hello.beam && hello.serverId === id;
  } catch {
    return false;
  }
}

async function localApi(route, options = {}) {
  const key = readKeyFile();
  if (!key) throw new Error(`No Beam key in ${DATA_DIR}`);
  return fetch(`${LOCAL_URL}${route}`, { ...options, headers: { Authorization: `Bearer ${key}`, ...options.headers } });
}

async function commandPair() {
  let link;
  if (await runningServer()) {
    const res = await localApi('/api/pair');
    const info = await res.json();
    if (!res.ok) throw new Error(info.error || `HTTP ${res.status}`);
    link = info.link || `http://localhost:${PORT}/?key=${encodeURIComponent(info.key)}`;
  } else {
    openData();
    const token = createPairing(null);
    await flushAll();
    const base = setting('publicUrl') || (await tailscaleUrl()) || lanBase() || `http://localhost:${PORT}`;
    link = `${base}/?key=${encodeURIComponent(token)}`;
  }
  console.log(`Open this link on the device you want to add (it works once, for 15 minutes):\n\n  ${link}\n`);
  try { console.log(await QRCode.toString(link, { type: 'terminal', small: true })); } catch {}
}

async function commandExport(file) {
  const target = file || `beam-export-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.tar.gz`;
  const out = target === '-' ? process.stdout : fs.createWriteStream(target, { mode: 0o600 });
  if (await runningServer()) {
    const res = await localApi('/api/admin/export');
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), out);
  } else {
    openData();
    await writeExport(out, snapshotState());
  }
  if (target !== '-') console.error(`Saved ${path.resolve(target)} (${formatSize(fs.statSync(target).size)}). It contains the Beam key: keep it private.`);
}

// (1.8.1) A backup now, into BEAM_BACKUP_DIR: by the running server, else here.
async function commandBackup() {
  let dir = BACKUP_DIR, last;
  if (await runningServer()) {
    const res = await localApi('/api/backups', { method: 'POST' });
    const info = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(info.error || `HTTP ${res.status}`);
    ({ dir, last } = info);
  } else {
    openData();
    last = await backupNow('node server.js backup, with Beam stopped');
  }
  console.error(`Saved ${path.join(dir, last.name)} (${formatSize(last.bytes)}). It contains the Beam key: keep it private.`);
}

async function assertDataFolderFree(force) {
  if (await runningServer()) throw new Error(`Beam is running on ${DATA_DIR}. Stop it first (node server.js stop).`);
  if (dataDirHasBeam()) {
    if (!force) throw new Error(`${DATA_DIR} already holds a Beam. Use --force to replace it (the current contents are moved to a "replaced-…" folder, not deleted).`);
    console.error(`Moved the current contents of ${DATA_DIR} to ${setAsideData()}`);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

async function commandImport(file, flags) {
  if (!file) throw new Error('Usage: node server.js import <beam-export.tar.gz> [--force]');
  await assertDataFolderFree(flags.has('--force'));
  const result = await importArchive(fs.createReadStream(file));
  tidyImportedSettings({ keepPublicUrl: flags.has('--keep-public-url') });
  console.error(`Imported ${result.files} files (${formatSize(result.bytes)}) into ${DATA_DIR}: Beam ${result.manifest.serverId}, exported ${result.manifest.created}.`);
}

async function postJsonTo(url, body, headers = {}) {
  const res = await postJson(url, body, headers);
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

// Copies a running Beam to this machine: approve it once on a signed-in device, and the old server sends every
// client here as soon as this one is up.
async function commandImportFrom(oldUrl, flags, options) {
  const base = normalizeBaseUrl(oldUrl || '');
  if (!base) throw new Error('Usage: node server.js import-from <old address> [--public-url <new address>] [--no-redirect] [--force]');
  await assertDataFolderFree(flags.has('--force'));
  const hello = await outbound.request(`${base}/api/hello`, { timeout: 15_000 }).then(r => r.json()).catch(err => {
    throw new Error(`Can't reach ${base} (${err.message})${outbound.proxied ? '' : '. In a container with userspace Tailscale, set BEAM_TAILNET_PROXY (see docker-compose.yml)'}`);
  });
  if (!hello?.beam) throw new Error(`${base} doesn't answer like a Beam server`);
  if (!(hello.api >= 3)) throw new Error(`${base} runs an older Beam (API ${hello.api || 2}). Update it first, or copy it with "node server.js export" there.`);
  let token = null;
  while (!token) {
    const { res, data: request } = await postJsonTo(`${base}/api/login-requests`, { name: `Move Beam to ${os.hostname()}`, platform: 'server', purpose: 'move' });
    if (!res.ok) throw new Error(request.error || `HTTP ${res.status}`);
    console.log(`\nApprove this on a device that's signed in to ${base}. It copies EVERYTHING (items, files, devices, keys).\n\n  Code: ${request.code}\n`);
    try { console.log(await QRCode.toString(request.approveUrl, { type: 'terminal', small: true })); } catch {}
    for (;;) {
      const poll = await outbound.request(`${base}/api/login-requests/${request.id}?wait`, { headers: { 'X-Beam-Login-Secret': request.secret }, timeout: 45_000 }).then(r => r.json()).catch(() => ({ status: 'pending' }));
      if (poll.status === 'approved') { token = poll.key; break; }
      if (poll.status === 'denied') throw new Error('The move was denied');
      if (poll.status !== 'pending') { console.log('The code expired; here is a new one.'); break; }
    }
  }
  console.log('Approved. Copying…');
  const res = await outbound.request(`${base}/api/admin/export?freeze=1`, { headers: { Authorization: `Bearer ${token}` }, timeout: 120_000 });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Export failed: HTTP ${res.status}`);
  const result = await importArchive(res.stream);
  tidyImportedSettings({ keepPublicUrl: false });
  console.log(`Copied ${result.files} files (${formatSize(result.bytes)}).`);
  if (flags.has('--no-redirect')) {
    await outbound.request(`${base}/api/move`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    console.log(`${base} keeps serving everyone. Point them here later with "node server.js moved-to <new address>" on the old server.`);
    return;
  }
  const to = normalizeBaseUrl(options['--public-url'] || env.BEAM_PUBLIC_URL || '');
  if (to) {
    const { res: moved, data } = await postJsonTo(`${base}/api/move`, { to, wait: true }, { Authorization: `Bearer ${token}` });
    if (!moved.ok) throw new Error(`The old server didn't accept ${to}: ${data.error || moved.status}`);
    console.log(`\nStart Beam here now. ${base} sends every device to ${to} as soon as it answers (it waits up to 30 minutes; changes are paused meanwhile).`);
  } else {
    const s = readJsonQuiet(FILE.settings) || {};
    s.pendingMove = { from: base, token, since: now() };
    writeFileDurableSync(FILE.settings, JSON.stringify(s));
    console.log(`\nStart Beam here now. Once it knows its own address (open it once through tailscale serve, or set BEAM_PUBLIC_URL), it tells ${base} to send every device here.`);
  }
}

async function commandMovedTo(target, flags) {
  const clear = flags.has('--clear');
  const to = clear ? '' : normalizeBaseUrl(target || '');
  if (!clear && !to) throw new Error('Usage: node server.js moved-to <new address> [--force] | --clear');
  if (await runningServer()) {
    const res = clear
      ? await localApi('/api/move', { method: 'DELETE' })
      : await localApi('/api/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, force: flags.has('--force') }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}${res.status === 409 ? ' (use --force to skip the check)' : ''}`);
    console.log(clear ? 'Beam is served here again.' : `Beam now sends every device to ${to}.`);
    return;
  }
  const s = readJsonQuiet(FILE.settings) || {};
  s.movedTo = to;
  writeFileDurableSync(FILE.settings, JSON.stringify(s));
  console.log(clear ? 'Cleared. Beam will be served here when it starts.' : `Saved. When Beam starts here it sends every device to ${to}.`);
}

async function commandStop() {
  // Written first, even when no server answers: a supervisor waiting to restart a crashed server sees it and stays
  // stopped. The supervisor clears it when it starts. (Audit B-5 suggested removing it when nothing runs: that would
  // let such a supervisor start Beam again.)
  try { fs.writeFileSync(FILE.stop, String(now())); } catch {}
  if (!(await runningServer())) {
    console.log('Beam is not running (the supervisor, if any, will not restart it).');
    return;
  }
  const res = await localApi('/api/admin/shutdown', { method: 'POST' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  for (let i = 0; i < 50 && (await runningServer()); i++) await sleep(200);
  console.log('Beam stopped.');
}

// Runs the server as a child process and restarts it when it crashes (1 s, 2 s, 4 s … up to a minute).
function supervise(args) {
  log.setFile(path.join(DIR.logs, 'supervisor.log'));
  try { fs.mkdirSync(DIR.logs, { recursive: true }); fs.rmSync(FILE.stop, { force: true }); } catch {}
  let child = null;
  let stopping = false;
  let failures = 0;
  const stopRequested = () => fs.existsSync(FILE.stop);
  const start = () => {
    if (stopping || stopRequested()) return finish(0);
    const started = now();
    child = spawn(process.execPath, [__filename, ...args], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true, env: { ...process.env, BEAM_SUPERVISED: '1' } });
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping || code === 0 || stopRequested()) return finish(code ?? 0);
      if (code === EXIT_FATAL) {
        log.error('Beam stopped because of a setup problem (see server.log); not restarting.');
        return finish(code);
      }
      failures = now() - started > 60_000 ? 1 : failures + 1;
      const delay = Math.min(60_000, 1000 * 2 ** (failures - 1));
      log.warn(`Beam stopped unexpectedly (${signal || `exit ${code}`}); restarting in ${Math.round(delay / 1000)} s`);
      const wait = setInterval(() => { if (stopRequested()) { clearInterval(wait); clearTimeout(timer); finish(0); } }, 1000);
      const timer = setTimeout(() => { clearInterval(wait); start(); }, delay);
    });
  };
  const finish = code => {
    try { fs.rmSync(FILE.stop, { force: true }); } catch {}
    process.exit(code);
  };
  const stop = () => {
    stopping = true;
    if (!child) return finish(0);
    try { child.send({ cmd: 'shutdown' }); } catch { child.kill(); }
    setTimeout(() => child?.kill(), 10_000).unref();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try { process.on(signal, stop); } catch {}
  }
  log.info(`Supervising Beam ${VERSION} (restarts it if it crashes)`);
  start();
}

const HELP = `Beam server ${VERSION}

  node server.js                     run the server
  node server.js --supervise         run it and restart it if it crashes (used by the installers)
  node server.js stop                stop a running server cleanly (and its supervisor)
  node server.js pair                print a one-time link + QR code to add a device
  node server.js export [file]       save everything to a .tar.gz (default beam-export-<date>.tar.gz; - = stdout)
  node server.js backup              a backup now, into ${BACKUP_DIR} (Beam makes one every ${BACKUP_HOURS || '(off)'} h itself)
  node server.js import <file> [--force] [--keep-public-url]
                                     load an export or a backup into an empty data folder (--force moves the old
                                     one aside)
  node server.js import-from <old address> [--public-url <new address>] [--no-redirect] [--force]
                                     copy a running Beam here after you approve it on a signed-in device; the old
                                     server then sends every device here
  node server.js moved-to <address> [--force] | --clear
                                     send every device to a new address (or stop doing that)

Settings come from environment variables or .env (see .env.example); the data folder is ${DATA_DIR}.`;

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter(a => a.startsWith('--')));
  const options = {};
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--public-url') options['--public-url'] = argv[i + 1];
  const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--public-url');
  const [command, arg] = positional;
  if (flags.has('--help') || command === 'help') return console.log(HELP);
  if (flags.has('--supervise')) return supervise(argv.filter(a => a !== '--supervise'));
  if (!command) return serve();
  const commands = {
    pair: () => commandPair(),
    export: () => commandExport(arg),
    backup: () => commandBackup(),
    import: () => commandImport(arg, flags),
    'import-from': () => commandImportFrom(arg, flags, options),
    'moved-to': () => commandMovedTo(arg, flags),
    stop: () => commandStop(),
  };
  if (!Object.hasOwn(commands, command)) {
    console.error(`Unknown command "${command}".\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  try {
    await commands[command]();
    await flushAll();
  } catch (err) {
    console.error(`beam: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
