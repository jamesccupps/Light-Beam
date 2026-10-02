'use strict';
// Who is asking: Tailscale's identity (tailnet members, and people the server is shared with), else a session cookie
// from a password sign-in (the public link). Plus passwords, sessions, invites, rate limits and the same-origin rule.

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { decodeHeaderWords, isTailscaleIp } = require('../../lib/tailscale');
const { newId } = require('./ids');

const scrypt = promisify(crypto.scrypt);
const now = () => Date.now();
const DAY = 86400e3;

// ---------------------------------------------------------------- passwords

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

// A few slow password checks at once (each takes 32 MB and a moment of CPU): a crowd of sign-ins or password
// changes waits its turn, and past a long queue is told to come back, instead of taking the server's memory
// (1.7.3, audit S-17).
const SCRYPT_AT_ONCE = 4;
const SCRYPT_QUEUE = 200;
let scryptBusy = 0;
const scryptWaiting = [];
async function slowHash(...args) {
  if (scryptBusy >= SCRYPT_AT_ONCE) {
    if (scryptWaiting.length >= SCRYPT_QUEUE) throw Object.assign(new Error('Too many sign-ins right now: try again in a minute'), { status: 503 });
    await new Promise(resolve => scryptWaiting.push(resolve)); // (a finished one hands its turn over)
  } else scryptBusy++;
  try { return await scrypt(...args); } finally {
    const next = scryptWaiting.shift();
    if (next) next();
    else scryptBusy--;
  }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await slowHash(String(password).normalize('NFC'), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

// A stored hash to check against when the name is unknown, so a wrong name takes as long as a wrong password.
let decoy = null;

async function checkPassword(password, stored) {
  if (!stored) {
    // (made again if it couldn't be: a busy moment mustn't leave it failed for good)
    decoy ??= hashPassword(crypto.randomBytes(12).toString('base64url')).catch(err => { decoy = null; throw err; });
    stored = await decoy;
  }
  const [kind, n, r, p, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await slowHash(String(password).normalize('NFC'), Buffer.from(salt, 'base64url'), expected.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(key, expected) && stored !== (await decoy);
}

// (1.7.3, audit S-12: the public path, so at least 10 characters, and the usual long ones turned away.)
const MIN_PASSWORD = 10;
const COMMON = new Set(['password12', 'password123', 'password1234', 'passw0rd123', 'iloveyou12', 'iloveyou123', 'qwerty1234',
  'qwerty12345', 'qwertyuiop1', '1q2w3e4r5t', '1q2w3e4r5t6y', 'q1w2e3r4t5', 'q1w2e3r4t5y6', 'zaq12wsxcde3', 'qazwsxedc123',
  '1qaz2wsx3edc', 'abc1234567', 'abcd123456', 'welcome123', 'welcome1234', 'letmein123', 'football123', 'baseball123',
  'sunshine123', 'princess123', 'monkey12345', 'dragon12345', 'trustno1234', 'starwars123', 'superman123', 'pokemon123',
  'liverpool1', 'chocolate1', 'basketball', 'basketball1', 'football12', 'baseball12', 'whatever12', 'charlie123',
  'michael123', 'jennifer12', 'jordan2323', 'ashley1234', 'computer12', 'internet12', 'administrator', 'changeme123',
  'family1234', 'familypassword', 'ourfamily1', 'mypassword', 'mypassword1', 'secret1234', 'letmein1234', 'test123456',
  'iloveyou1234', 'lovelove12', 'asdfghjkl1', 'asdfghjkl12', 'zxcvbnm123', 'qwertyuiop12']);
// Runs along the keyboard or the alphabet ("1234567890", "qwertyuiop", "abcdefghij"), either way round.
const RUNS = ['01234567890123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiopasdfghjklzxcvbnm', '1q2w3e4r5t6y7u8i9o0p', 'qazwsxedcrfvtgbyhnujmikolp'];

// Why a password won't do, or null.
function passwordProblem(password, name = '') {
  if (typeof password !== 'string') return 'Choose a password';
  const length = [...password].length;
  if (length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters`;
  if (length > 200) return 'Use at most 200 characters';
  const lower = password.toLowerCase();
  const run = RUNS.some(r => r.includes(lower) || r.includes([...lower].reverse().join('')));
  if (COMMON.has(lower) || run || (name && lower.includes(String(name).toLowerCase()) && lower.replace(String(name).toLowerCase(), '').length < 6)
    || /^(.)\1+$/.test(password) || /^(..?)\1+$/.test(lower)) return 'That password is too easy to guess';
  return null;
}

// ---------------------------------------------------------------- sessions

const SESSION_DAYS = 90;
const COOKIE = 'fam_s';
// (1.7.3, audit S-10) Over https: host-only, Secure and Path=/ by the browser's own rules, so another machine under
// the same ts.net name can't plant a session cookie for this site.
const HOST_COOKIE = '__Host-fam_s';
const hashToken = token => crypto.createHash('sha256').update(String(token)).digest('base64url');

function createSession(db, userId, { agent = '', ip = '' } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  db.run('INSERT INTO sessions (hash, user_id, created_at, seen_at, expires_at, agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
    hashToken(token), userId, t, t, t + SESSION_DAYS * DAY, String(agent).slice(0, 200), String(ip).slice(0, 64));
  return token;
}

// The session's person, or null; a session in use lives on (90 days from its last use, noted at most once a minute).
function sessionUser(db, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const hash = hashToken(token);
  const row = db.get(`SELECT s.hash, s.seen_at, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.hash = ? AND s.expires_at > ? AND u.disabled_at IS NULL`, hash, now());
  if (!row) return null;
  if (now() - row.seen_at > 60_000) db.run('UPDATE sessions SET seen_at = ?, expires_at = ? WHERE hash = ?', now(), now() + SESSION_DAYS * DAY, hash);
  const { seen_at: _s, expires_at: _e, hash: sessionHash, ...user } = row;
  return { user, sessionHash };
}

const endSession = (db, token) => db.run('DELETE FROM sessions WHERE hash = ?', hashToken(token));

// ---------------------------------------------------------------- Tailscale identity

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const fromLoopback = req => LOOPBACK.has(req.socket.remoteAddress);

// Tailscale's identity headers, believed only from this machine: `tailscale serve` (which strips any a client sends)
// is the one that connects from here. Funnel's public visitors never have them.
function identityOf(req) {
  const raw = req.headers['tailscale-user-login'];
  if (!raw || Array.isArray(raw) || !fromLoopback(req)) return null;
  // (1.7.2, as Beam's own server does) never on a Funnel request, and only for a caller at a Tailscale address
  if (req.headers['tailscale-funnel-request'] || !isTailscaleIp(clientIp(req))) return null;
  const login = decodeHeaderWords(raw).trim().toLowerCase();
  if (!login || login.length > 200) return null;
  return {
    login,
    name: decodeHeaderWords(req.headers['tailscale-user-name'] || '').trim().slice(0, 100),
    pic: String(req.headers['tailscale-user-profile-pic'] || '').slice(0, 500),
  };
}

// The client's address: through serve or Funnel (which connect from here) the last X-Forwarded-For entry, the one they
// add (any before it came from the client, and could be anything: per-address limits would be easy to dodge).
function clientIp(req) {
  const peer = req.socket.remoteAddress || '';
  if (LOOPBACK.has(peer)) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
    if (forwarded) return forwarded.slice(0, 64);
  }
  return peer.replace(/^::ffff:/, '');
}

// ---------------------------------------------------------------- the same-origin rule

// Changes may only come from this app's own pages: both ways in (the cookie and Tailscale's identity) are added by
// the browser and Tailscale by themselves, so a page on another site must not be able to make a change.
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser (tests, scripts): neither header, nothing ambient to abuse
  try { return new URL(origin).host === String(req.headers.host || ''); } catch { return false; }
}

// ---------------------------------------------------------------- rate limits

// Up to `limit` hits per key in a sliding `windowMs` (kept as timestamps; small keys only).
function createLimiter({ limit, windowMs }) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = now() - windowMs;
    for (const [key, list] of hits) {
      while (list.length && list[0] <= cutoff) list.shift();
      if (!list.length) hits.delete(key);
    }
  }, Math.min(windowMs, 60_000)).unref();
  return {
    hit(key) {
      const cutoff = now() - windowMs;
      let list = hits.get(key);
      if (!list) hits.set(key, (list = []));
      while (list.length && list[0] <= cutoff) list.shift();
      if (list.length >= limit) return false;
      list.push(now());
      return true;
    },
    // Seconds until the next hit is allowed.
    wait(key) {
      const list = hits.get(key);
      return list && list.length >= limit ? Math.max(1, Math.ceil((list[0] + windowMs - now()) / 1000)) : 0;
    },
    // Whether a hit now would be refused, without counting one (for limits that only count failures).
    blocked(key) {
      const list = hits.get(key);
      if (!list) return false;
      const cutoff = now() - windowMs;
      while (list.length && list[0] <= cutoff) list.shift();
      return list.length >= limit;
    },
    reset: key => hits.delete(key),
  };
}

// ---------------------------------------------------------------- invites

const INVITE_DAYS = 7;

// userId: a password reset for that person (single use) rather than an invite for someone new.
function createInvite(db, { createdBy, role = 'member', spaceId = null, maxUses = 1, days = INVITE_DAYS, note = '', userId = null }) {
  const code = crypto.randomBytes(16).toString('base64url');
  const id = newId();
  const t = now();
  if (userId) db.run('UPDATE invites SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', t, userId); // (only the newest reset link works)
  db.run(`INSERT INTO invites (id, hash, created_by, role, space_id, uses, max_uses, expires_at, created_at, note, user_id)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`, id, hashToken(code), createdBy, role, spaceId, maxUses, t + days * DAY, t, String(note).slice(0, 100), userId);
  return { id, code, expiresAt: t + days * DAY };
}

// The invite for a code if it can still be used, else null (unknown, used up, expired, withdrawn).
function findInvite(db, code) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(code)) return null;
  return db.get('SELECT * FROM invites WHERE hash = ? AND revoked_at IS NULL AND expires_at > ? AND uses < max_uses', hashToken(code), now()) || null;
}

module.exports = {
  hashPassword, checkPassword, passwordProblem, MIN_PASSWORD,
  COOKIE, HOST_COOKIE, SESSION_DAYS, createSession, sessionUser, endSession, hashToken,
  identityOf, clientIp, fromLoopback, sameOrigin, createLimiter,
  createInvite, findInvite,
};
