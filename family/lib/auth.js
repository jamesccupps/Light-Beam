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

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password).normalize('NFC'), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

// A stored hash to check against when the name is unknown, so a wrong name takes as long as a wrong password.
let decoy = null;

async function checkPassword(password, stored) {
  if (!stored) {
    decoy ??= hashPassword(crypto.randomBytes(12).toString('base64url'));
    stored = await decoy;
  }
  const [kind, n, r, p, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scrypt(String(password).normalize('NFC'), Buffer.from(salt, 'base64url'), expected.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(key, expected) && stored !== (await decoy);
}

const COMMON = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyuiop', 'iloveyou',
  'letmein1', 'welcome1', 'abcd1234', '11111111', '00000000', 'baseball', 'football', 'sunshine', 'princess', 'qwerty123']);

// Why a password won't do, or null.
function passwordProblem(password, name = '') {
  if (typeof password !== 'string') return 'Choose a password';
  const length = [...password].length;
  if (length < 8) return 'Use at least 8 characters';
  if (length > 200) return 'Use at most 200 characters';
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || (name && lower === String(name).toLowerCase()) || /^(.)\1+$/.test(password)) return 'That password is too easy to guess';
  return null;
}

// ---------------------------------------------------------------- sessions

const SESSION_DAYS = 90;
const COOKIE = 'fam_s';
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
  hashPassword, checkPassword, passwordProblem,
  COOKIE, SESSION_DAYS, createSession, sessionUser, endSession, hashToken,
  identityOf, clientIp, fromLoopback, sameOrigin, createLimiter,
  createInvite, findInvite,
};
