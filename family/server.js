#!/usr/bin/env node
// Beam Family: the family's own chat (spaces, channels, direct and group messages), separate from Beam's device hub.
// It runs as its own server with its own data, on 127.0.0.1 behind `tailscale serve` (people on the tailnet, or
// whom the machine is shared with, are signed in by Tailscale) and Funnel (the public link: invite + password).
// docs/FAMILY.md describes it. `node family/server.js help` lists the commands.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}

const { createLogger } = require('../lib/log');
const { makePrivate } = require('../lib/private-dir');
const tailscale = require('../lib/tailscale');
// (BEAM_FAMILY_VERSION: what it says it runs, for tests of a page meeting a newer server)
const VERSION = process.env.BEAM_FAMILY_VERSION || require('../package.json').version;
const { openDb } = require('./lib/db');
const { send, httpError, readJson, createRouter, createStatic } = require('./lib/http');
const auth = require('./lib/auth');
const { createHub } = require('./lib/events');
const { createPeople } = require('./lib/people');
const { createChat } = require('./lib/chat');
const { createFiles } = require('./lib/files');
const { createPush } = require('./lib/push');
const { createDirect } = require('./lib/direct');
const { createLinks } = require('./lib/links');
const { createMedia } = require('./lib/media');
const { createBackups, restoreBackup } = require('./lib/backup');

const env = process.env;
const num = (v, fallback) => (v === undefined || v === '' || isNaN(Number(v)) ? fallback : Number(v));
const now = () => Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MB = 1024 * 1024;

// ---------------------------------------------------------------- config

const DATA_DIR = path.resolve(env.BEAM_FAMILY_DATA || path.join(ROOT, 'family-data'));
const HOST = env.BEAM_FAMILY_HOST || '127.0.0.1';
const PORT = num(env.BEAM_FAMILY_PORT, 8766);
const FILE = {
  db: path.join(DATA_DIR, 'family.db'),
  control: path.join(DATA_DIR, 'control.key'),
  stop: path.join(DATA_DIR, 'stop'),
};
const DIR = { logs: path.join(DATA_DIR, 'logs'), files: path.join(DATA_DIR, 'files'), uploads: path.join(DATA_DIR, 'uploads'), thumbs: path.join(DATA_DIR, 'thumbs'), avatars: path.join(DATA_DIR, 'avatars'), play: path.join(DATA_DIR, 'play') };
// "41700-41799" → [41700, 41799]; anything else (or "any"): null, any port.
function portRange(value) {
  const m = /^(\d{4,5})-(\d{4,5})$/.exec(String(value).trim());
  const [a, b] = m ? [Number(m[1]), Number(m[2])] : [];
  return m && a >= 1024 && b <= 65535 && a <= b ? [a, b] : null;
}
function stunServers(value) {
  const v = String(value).trim();
  if (v === 'off') return null;
  if (v === 'local') return [];
  return v.split(',').map(s => s.trim()).filter(s => /^stun:[\w.-]+(:\d+)?$/.test(s));
}
const config = {
  publicUrl: String(env.BEAM_FAMILY_URL || '').trim().replace(/\/+$/, ''),
  spaceName: env.BEAM_FAMILY_NAME || 'Family',
  maxUpload: num(env.BEAM_FAMILY_MAX_UPLOAD_MB, 2048) * MB,
  maxStorage: num(env.BEAM_FAMILY_MAX_STORAGE_GB, 100) * 1024 * MB,
  owner: String(env.BEAM_FAMILY_OWNER || '').trim().toLowerCase(),
  postsPer10s: num(env.BEAM_FAMILY_POSTS_PER_10S, 20), // (how fast one person may post; tests that post a lot raise it)
  tailscale: env.BEAM_TAILSCALE !== 'off',
  // (1.9.0) Direct connections find their way with these STUN servers (they see addresses, never a file); "local":
  // none (the same network only, as the tests use); "off": no direct connections.
  stun: stunServers(env.BEAM_FAMILY_STUN ?? 'stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478'),
  // (1.9.0) the UDP ports direct connections use here (a firewall rule can let the home network in on just these)
  directPorts: portRange(env.BEAM_FAMILY_DIRECT_PORTS ?? '41700-41799'),
  // (1.10.0) videos that play everywhere (lib/media.js): ffmpeg's path (ffprobe next to it), or "off"; unset: ffmpeg on
  // the PATH
  ffmpeg: String(env.BEAM_FAMILY_FFMPEG || '').trim(),
};
// (1.8.1) Backups (lib/backup.js): every BEAM_FAMILY_BACKUP_HOURS (0: none) into BEAM_FAMILY_BACKUP_DIR (default the
// "backups" folder next to the data folder, as Beam's), the newest BEAM_FAMILY_BACKUP_KEEP kept.
const BACKUP = {
  dir: path.resolve(env.BEAM_FAMILY_BACKUP_DIR || (() => {
    const parent = path.dirname(DATA_DIR);
    return parent === path.parse(parent).root ? path.join(DATA_DIR, 'backups') : path.join(parent, 'backups');
  })()),
  hours: Math.max(0, num(env.BEAM_FAMILY_BACKUP_HOURS, 24)),
  keep: Math.max(1, Math.floor(num(env.BEAM_FAMILY_BACKUP_KEEP, 14))),
  filesMB: Math.max(0, num(env.BEAM_FAMILY_BACKUP_FILES_MB, 1024)),
};
const LOCAL_URL = `http://${HOST.includes(':') ? `[${HOST}]` : HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`;
const EXIT_FATAL = 3;
const backupsOf = db => createBackups({ db, dataDir: DATA_DIR, backupDir: BACKUP.dir, hours: BACKUP.hours, keep: BACKUP.keep, filesMB: BACKUP.filesMB, version: VERSION, log });

const log = createLogger();

// ---------------------------------------------------------------- the server

function serve() {
  // (audit S-5) The data folder made private before the rest is made in it (they inherit that), each 0700 as Beam's.
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(DIR.logs, { recursive: true, mode: 0o700 });
  log.setFile(path.join(DIR.logs, 'family.log'));
  makePrivate(DATA_DIR, { log, env, label: 'family data folder', child: DIR.logs });
  for (const d of Object.values(DIR)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  if (fs.existsSync(FILE.stop)) fs.rmSync(FILE.stop, { force: true });
  let db;
  try {
    db = openDb(FILE.db);
  } catch (err) {
    log.error(`Can't open the database ${FILE.db}: ${err.message}`);
    process.exit(EXIT_FATAL);
  }
  // A secret only this account can read: `family/server.js stop` proves it's this machine's owner with it.
  let control;
  try { control = fs.readFileSync(FILE.control, 'utf8').trim(); } catch {}
  if (!control) {
    control = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(FILE.control, control, { mode: 0o600 });
  }

  // The machine owner's Tailscale login (they become the owner on their first visit), refreshed now and then.
  const ts = config.tailscale ? tailscale.createClient({ socket: env.BEAM_TAILSCALE_SOCKET || '' }) : null;
  let machineOwner = '';
  const refreshOwner = async () => {
    if (!ts) return;
    const status = await ts.status().catch(() => null);
    const login = status?.User?.[status?.Self?.UserID]?.LoginName;
    if (login) machineOwner = String(login).toLowerCase();
  };
  refreshOwner();
  setInterval(refreshOwner, 10 * 60e3).unref();

  const hub = createHub({
    version: VERSION,
    onPresence: (user, online) => hub.emit(null, 'presence', { person: user, online }),
    onDrop: user => log.warn(`Dropped a stalled live connection (${ctx.people?.getUser(user)?.name || 'someone'}): over 1 MB unread`),
  });
  const ctx = {
    db, hub, log, config, version: VERSION, dirs: DIR,
    ownerLogin: () => config.owner || machineOwner,
    spaceName: () => ctx.chat.spaceName(),
  };
  ctx.people = createPeople(ctx);
  ctx.chat = createChat(ctx);
  ctx.files = createFiles(ctx);
  ctx.push = createPush(ctx, { file: path.join(DATA_DIR, 'vapid.json'), contact: /^https:/.test(config.publicUrl) ? config.publicUrl : '' });
  ctx.direct = createDirect(ctx);
  ctx.links = createLinks(ctx);
  ctx.media = createMedia(ctx);
  const router = createRouter([...ctx.people.routes, ...ctx.chat.routes, ...ctx.files.routes, ...ctx.push.routes, ...ctx.direct.routes, ...ctx.links.routes, ...ctx.media.routes]);

  // (1.13.0) Beam (the server on this machine) shares one of its files by a fast link, for its apps' "Fast link": the
  // file becomes an unsent upload of the owner's (hard-linked: no copy on the same drive) and the link is the owner's
  // ("from <the owner>" on its page). The sweep removes the file a day after its link stops working.
  async function adminFastLink(body) {
    const owner = db.get("SELECT * FROM users WHERE role = 'owner' AND disabled_at IS NULL ORDER BY created_at LIMIT 1");
    if (!owner) throw httpError(409, 'Beam Family has no owner yet: open it once over Tailscale');
    if (typeof body.path !== 'string' || !path.isAbsolute(body.path)) throw httpError(400, 'Expected {"path", "name", "size", "mime", "hours"}');
    const hours = body.hours === undefined ? 24 : Math.round(Number(body.hours));
    ctx.links.checkNew(owner, hours); // (before anything is adopted for a link that can't be made)
    const a = await ctx.files.adoptFile({ path: body.path, name: body.name, size: Number(body.size), mime: body.mime, owner, link: body.link !== false });
    return { link: ctx.links.createFor(a, owner, hours) };
  }
  const serveStatic = createStatic(path.join(__dirname, 'public'));
  const backups = backupsOf(db);

  let server;
  async function shutdown(reason) {
    log.info(`Stopping (${reason})`);
    backups.stop();
    hub.closeAll();
    ctx.direct.closeAll();
    ctx.media.stop();
    server.close();
    setTimeout(() => process.exit(0), 3000).unref();
    await new Promise(r => server.close(r));
    try { db.close(); } catch {}
    process.exit(0);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://family');
    const p = url.pathname;
    // A body has 60 s to arrive in full, except a piece of a file (15 min, the server's limit): a visitor trickling a
    // sign-in for minutes mustn't hold a connection that long (1.7.2).
    if (!(req.method === 'PUT' && /^\/api\/uploads\//.test(p)) && !req.complete) {
      const slow = setTimeout(() => { if (!req.complete) req.destroy(); }, 60_000);
      slow.unref();
      req.on('end', () => clearTimeout(slow));
      res.on('close', () => clearTimeout(slow));
    }
    try {
      if (p.startsWith('/api/')) {
        if (p === '/api/hello') return send(res, 200, { family: true, version: VERSION });
        if (p === '/api/admin/shutdown' || p === '/api/admin/backup' || p === '/api/admin/fastlink') {
          const given = Buffer.from(String(req.headers['x-family-control'] || ''));
          const ok = req.method === 'POST' && auth.fromLoopback(req) && !req.headers['x-forwarded-for'] && given.length === Buffer.byteLength(control) && crypto.timingSafeEqual(given, Buffer.from(control));
          if (!ok) throw httpError(404, 'Not found');
          if (p === '/api/admin/backup') return send(res, 201, { dir: BACKUP.dir, last: await backups.now('asked on this PC') }); // (1.8.1)
          if (p === '/api/admin/fastlink') return send(res, 201, await adminFastLink(await readJson(req))); // (1.13.0, Beam's)
          send(res, 202, {});
          return shutdown('requested with "family/server.js stop"');
        }
        if (req.method !== 'GET' && req.method !== 'HEAD' && !auth.sameOrigin(req)) throw httpError(403, 'Changes must come from Beam Family’s own pages');
        const route = router(req.method, p);
        if (!route) throw httpError(404, 'Not found');
        if (route.allowed) return send(res, 405, { error: 'Method not allowed' }, { Allow: route.allowed.join(', ') });
        return await route.handler(req, res, route.params, url);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
      // (1.9.0) A fast link's page, for anyone who has the link (it asks the API whether the link is any good).
      if (/^\/f\/[A-Za-z0-9_-]{32}$/.test(p)) {
        if (await serveStatic(req, res, 'link.html')) return;
      }
      // The app's pages: its files, and index.html for its own routes (/c/…, /join/…, /settings…).
      const rel = p === '/' ? 'index.html' : p.slice(1);
      const appRoute = /^\/(c|join|dm|settings|admin)(\/|$)/.test(p);
      if (await serveStatic(req, res, rel, { fallback: appRoute ? 'index.html' : null })) return;
      send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    } catch (err) {
      // An error with a status is an answer (its message is for the person); anything else is a bug.
      const status = err.status || 500;
      if (!err.status) log.error(`${req.method} ${p}: ${err.stack || err.message}`);
      const headers = {};
      if (status === 429 && err.extra?.retryAfter) headers['Retry-After'] = String(err.extra.retryAfter);
      if (res.headersSent) return res.destroy();
      send(res, status, { error: err.status ? err.message : 'Something went wrong on the server' }, headers);
    }
  }

  // (a request has 15 minutes to arrive in full: enough for a 16 MB piece of a file over a slow link, not for ever)
  server = http.createServer({ requestTimeout: 15 * 60e3, headersTimeout: 30_000, keepAliveTimeout: 65_000 }, handle);
  server.maxConnections = 1000; // (1.7.2) live streams included
  server.on('clientError', (err, socket) => { try { socket.destroy(); } catch {} });
  // Expired sign-ins and invites go once a day (1.7.2: they stayed for good); the audit trail is kept for a year.
  const purge = () => {
    try {
      const t = now();
      const gone = db.run('DELETE FROM sessions WHERE expires_at < ?', t).changes + db.run('DELETE FROM invites WHERE expires_at < ?', t - 30 * 86400e3).changes
        + db.run('DELETE FROM audit WHERE at < ?', t - 365 * 86400e3).changes;
      if (gone) log.info(`Cleaned up ${gone} expired sign-in${gone === 1 ? '' : 's'}, invites and old audit lines`);
    } catch (err) { log.warn(`Clean-up: ${err.message}`); }
  };
  setTimeout(purge, 5 * 60e3).unref();
  setInterval(purge, 24 * 3600e3).unref();
  server.listen(PORT, HOST, () => {
    ctx.media.start().catch(err => log.warn(`Videos that play everywhere: ${err.message}`));
    log.info(`Beam Family ${VERSION} is running on ${HOST}:${PORT}; data in ${DATA_DIR}${config.publicUrl ? `; address ${config.publicUrl}` : ''}`);
    backups.schedule().catch(err => log.warn(`Backups couldn't be planned: ${err.message}`));
    process.send?.({ ready: true });
  });
  server.on('error', err => {
    log.error(`Can't listen on ${HOST}:${PORT}: ${err.message}`);
    process.exit(err.code === 'EADDRINUSE' ? EXIT_FATAL : 1);
  });
  process.on('message', m => { if (m?.cmd === 'shutdown') shutdown('the supervisor is stopping'); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));
  process.on('uncaughtException', err => { log.error(`Uncaught: ${err.stack || err.message}`); process.exit(1); });
  process.on('unhandledRejection', err => log.error(`Unhandled: ${err?.stack || err}`));
}

// ---------------------------------------------------------------- commands

async function runningServer() {
  try {
    const hello = await (await fetch(`${LOCAL_URL}/api/hello`, { signal: AbortSignal.timeout(2000) })).json();
    return Boolean(hello.family);
  } catch {
    return false;
  }
}

async function commandStop() {
  try { fs.writeFileSync(FILE.stop, String(now())); } catch {}
  if (!(await runningServer())) return console.log('Beam Family is not running (the supervisor, if any, will not restart it).');
  const control = fs.readFileSync(FILE.control, 'utf8').trim();
  await fetch(`${LOCAL_URL}/api/admin/shutdown`, { method: 'POST', headers: { 'X-Family-Control': control } }).catch(() => {});
  for (let i = 0; i < 50 && (await runningServer()); i++) await sleep(200);
  console.log('Beam Family stopped.');
}

// An invite link, made straight in the database (works whether or not the server runs).
function commandInvite(flags, options) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = openDb(FILE.db);
  try {
    const owner = flags.has('--owner');
    if (owner && db.get("SELECT 1 FROM users WHERE role = 'owner'")) throw new Error('The family space already has an owner');
    if (!owner && !db.get("SELECT 1 FROM users WHERE role = 'owner'")) throw new Error('Set up the owner first: open Beam Family over Tailscale on your own device, or use "invite --owner"');
    const role = owner ? 'owner' : flags.has('--admin') ? 'admin' : 'member';
    const invite = auth.createInvite(db, { createdBy: null, role, maxUses: owner ? 1 : Math.min(50, Math.max(1, num(options.uses, 1))), days: Math.min(30, Math.max(1, num(options.days, 7))) });
    const base = config.publicUrl || LOCAL_URL;
    console.log(`Invite (${role}, until ${new Date(invite.expiresAt).toLocaleString()}):\n${base}/join/${invite.code}`);
  } finally {
    db.close();
  }
}

// (1.8.1) A backup now, into the backups folder: by the running server, else here.
async function commandBackup() {
  let dir = BACKUP.dir, last;
  if (await runningServer()) {
    const control = fs.readFileSync(FILE.control, 'utf8').trim();
    const r = await fetch(`${LOCAL_URL}/api/admin/backup`, { method: 'POST', headers: { 'X-Family-Control': control } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    ({ dir, last } = body);
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const db = openDb(FILE.db);
    try { last = await backupsOf(db).now('family/server.js backup, with Beam Family stopped'); } finally { db.close(); }
  }
  console.log(`Saved ${path.join(dir, last.name)} (${Math.max(1, Math.round(last.bytes / 1024))} KB). It holds the family's messages and keys: keep it private.`);
}

// (1.8.1) A backup back into the data folder, with the server stopped (--force: the data there is moved aside).
async function commandRestore(file, flags) {
  if (!file) throw new Error('Usage: node family/server.js restore <family-backup-….tar.gz> [--force]');
  if (await runningServer()) throw new Error('Beam Family is running. Stop it first (node family/server.js stop), then restore, then start it again.');
  const r = await restoreBackup(path.resolve(file), DATA_DIR, { force: flags.has('--force') });
  console.log(`Restored ${r.files} files into ${DATA_DIR} from the backup of ${r.manifest.created}${r.aside ? `; what was there is in ${r.aside}` : ''}.`);
}

function commandStatus() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = openDb(FILE.db);
  try {
    const people = db.get('SELECT count(*) n FROM users WHERE disabled_at IS NULL').n;
    const messages = db.get("SELECT count(*) n FROM messages WHERE deleted_at IS NULL AND kind = 'user'").n;
    console.log(`Beam Family: ${people} ${people === 1 ? 'person' : 'people'}, ${messages} messages; data in ${DATA_DIR}`);
  } finally {
    db.close();
  }
}

// Runs the server as a child and restarts it when it crashes (1 s, 2 s, 4 s … up to a minute).
function supervise(args) {
  fs.mkdirSync(DIR.logs, { recursive: true });
  log.setFile(path.join(DIR.logs, 'supervisor.log'));
  try { fs.rmSync(FILE.stop, { force: true }); } catch {}
  let child = null;
  let stopping = false;
  let failures = 0;
  const stopRequested = () => fs.existsSync(FILE.stop);
  const finish = code => { try { fs.rmSync(FILE.stop, { force: true }); } catch {} process.exit(code); };
  const start = () => {
    if (stopping || stopRequested()) return finish(0);
    const started = now();
    child = spawn(process.execPath, [__filename, ...args], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true, env: { ...process.env, BEAM_SUPERVISED: '1' } });
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping || code === 0 || stopRequested()) return finish(code ?? 0);
      if (code === EXIT_FATAL) { log.error('Beam Family stopped because of a setup problem (see family.log); not restarting.'); return finish(code); }
      failures = now() - started > 60_000 ? 1 : failures + 1;
      const delay = Math.min(60_000, 1000 * 2 ** (failures - 1));
      log.warn(`Beam Family stopped unexpectedly (${signal || `exit ${code}`}); restarting in ${Math.round(delay / 1000)} s`);
      setTimeout(start, delay);
    });
  };
  const stop = () => {
    stopping = true;
    if (!child) return finish(0);
    try { child.send({ cmd: 'shutdown' }); } catch { child.kill(); }
    setTimeout(() => child?.kill(), 10_000).unref();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) { try { process.on(signal, stop); } catch {} }
  log.info(`Supervising Beam Family ${VERSION} (restarts it if it crashes)`);
  start();
}

const HELP = `Beam Family ${VERSION}

  node family/server.js                          run the server
  node family/server.js --supervise              run it and restart it if it crashes
  node family/server.js stop                     stop a running server cleanly (and its supervisor)
  node family/server.js invite [--admin] [--uses n] [--days n]
                                                 print an invite link
  node family/server.js invite --owner           the owner's link, when nobody owns the family space yet
  node family/server.js status                   how many people and messages
  node family/server.js backup                   a backup now (it makes one every ${BACKUP.hours || '(off)'} h itself), into ${BACKUP.dir}
  node family/server.js restore <backup> [--force]
                                                 put a backup back, with the server stopped (--force moves the
                                                 data that's there aside)

Settings (environment or .env): BEAM_FAMILY_DATA (${DATA_DIR}), BEAM_FAMILY_HOST/PORT (${HOST}:${PORT}),
BEAM_FAMILY_URL (the address people use), BEAM_FAMILY_NAME, BEAM_FAMILY_OWNER, BEAM_FAMILY_MAX_UPLOAD_MB,
BEAM_FAMILY_MAX_STORAGE_GB, BEAM_FAMILY_BACKUP_DIR/HOURS/KEEP/FILES_MB, BEAM_FAMILY_STUN (direct connections: STUN
servers, comma-separated, or "off"), BEAM_FAMILY_FFMPEG (videos that play everywhere: ffmpeg's path, or
"off").`;

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter(a => a.startsWith('--')));
  const options = {};
  for (let i = 0; i < argv.length; i++) if (/^--(uses|days)$/.test(argv[i])) options[argv[i].slice(2)] = argv[i + 1];
  const positional = argv.filter((a, i) => !a.startsWith('--') && !/^--(uses|days)$/.test(argv[i - 1] || ''));
  const [command, arg] = positional;
  if (flags.has('--help') || command === 'help') return console.log(HELP);
  if (flags.has('--supervise')) return supervise(argv.filter(a => a !== '--supervise'));
  if (!command) return serve();
  const commands = { stop: commandStop, invite: () => commandInvite(flags, options), status: commandStatus, backup: commandBackup, restore: () => commandRestore(arg, flags) };
  if (!Object.hasOwn(commands, command)) {
    console.error(`Unknown command "${command}".\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  try {
    await commands[command]();
  } catch (err) {
    console.error(`beam family: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
