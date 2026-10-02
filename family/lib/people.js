'use strict';
// People: who's asking, signing in and out, invites, the owner's first visit, profiles, sessions, roles.

const QRCode = require('qrcode');
const { newId, isId } = require('./ids');
const { httpError, send, readJson, cookie, parseCookies } = require('./http');
const auth = require('./auth');

const now = () => Date.now();
const COLORS = 8; // avatar colours the app knows
const BIDI = /[‪-‮⁦-⁩‎‏؜]/g;

// A shown name: 1–32 characters, no control or direction characters, single spaces.
function cleanName(name) {
  const cleaned = String(name ?? '').toWellFormed().replace(/[\u0000-\u001f\u007f]/g, ' ').replace(BIDI, '').replace(/\s+/g, ' ').trim();
  const chars = [...cleaned];
  if (!chars.length) throw httpError(400, 'Choose a name');
  if (chars.length > 32) throw httpError(400, 'Use at most 32 characters for the name');
  return cleaned;
}

function createPeople(ctx) {
  const { db, hub, log, config } = ctx;
  const signinByIp = auth.createLimiter({ limit: 10, windowMs: 10 * 60e3 });
  // (1.7.3, audit S-12) Wrong passwords count per name *and* address: guessing at someone's name from elsewhere can't
  // lock them out (20 tries from 20 addresses did, for an hour). A high cap of wrong passwords per name from
  // everywhere slows a guess spread over many addresses; an address with a live session for that person passes it.
  const failByNameIp = auth.createLimiter({ limit: 10, windowMs: 60 * 60e3 });
  const failByName = auth.createLimiter({ limit: 200, windowMs: 60 * 60e3 });
  const sessionFrom = (name, ip) => Boolean(db.get(`SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE u.name = ? COLLATE NOCASE AND s.ip = ? AND s.expires_at > ?`, name, ip, now()));
  // (every sign-in costs a deliberately slow password check: many addresses at once can't keep the server busy)
  const signinAll = auth.createLimiter({ limit: 120, windowMs: 60e3 });
  const inviteByIp = auth.createLimiter({ limit: 20, windowMs: 10 * 60e3 });

  const getUser = id => (isId(id) ? db.get('SELECT * FROM users WHERE id = ?', id) : null);
  const audit = (userId, action, detail = '') => db.run('INSERT INTO audit (at, user_id, action, detail) VALUES (?, ?, ?, ?)', now(), userId || null, action, String(detail).slice(0, 500));

  // What others see of a person; admins (and the person) also see how they sign in.
  function personJson(u, viewer = null) {
    const out = {
      id: u.id, name: u.name, role: u.role, color: u.color, avatar: u.avatar ? `/api/people/${u.id}/avatar?v=${encodeURIComponent(u.avatar)}` : null,
      joined: u.created_at, online: hub.isOnline(u.id),
    };
    if (u.disabled_at) out.disabled = true;
    if (viewer && (viewer.id === u.id || viewer.role !== 'member')) {
      out.tailscale = u.login || null;
      out.password = Boolean(u.pass_hash);
    }
    return out;
  }

  // ---------------------------------------------------------------- who's asking

  // { user, via: 'tailscale' | 'session', identity, sessionHash } — or { user: null, identity } — memoised per request.
  function whoIs(req) {
    if (req.famAuth) return req.famAuth;
    const identity = auth.identityOf(req);
    let result = { user: null, identity, via: null };
    if (identity) {
      const user = db.get('SELECT * FROM users WHERE login = ?', identity.login);
      if (user && !user.disabled_at) result = { user, identity, via: 'tailscale' };
      else if (user) result = { user: null, identity, via: null, disabled: true };
      else if (identity.login === ctx.ownerLogin() && !hasOwner()) result = { user: createOwner(identity), identity, via: 'tailscale' };
    }
    if (!result.user && !result.disabled) {
      const jar = sessionCookie(req);
      const found = jar ? auth.sessionUser(db, jar.token) : null;
      if (found) result = { user: found.user, identity, via: 'session', sessionHash: found.sessionHash, legacyCookie: jar.legacy ? jar.token : null };
    }
    req.famAuth = result;
    return result;
  }

  function requireUser(req) {
    const who = whoIs(req);
    if (!who.user) throw httpError(401, who.disabled ? 'Your access to this family space was turned off' : 'Sign in first');
    return who.user;
  }

  function requireAdmin(req) {
    const user = requireUser(req);
    if (user.role === 'member') throw httpError(403, 'Only the family space’s admins can do that');
    return user;
  }

  const hasOwner = () => Boolean(db.get("SELECT 1 FROM users WHERE role = 'owner'"));

  // The machine owner's first visit over Tailscale: they become the owner, with a family space and its first channels.
  function createOwner(identity, { name = '', password = null } = {}) {
    return db.tx(() => {
      if (hasOwner()) throw httpError(409, 'This family space already has an owner');
      const id = newId();
      let shown = name || identity?.name || identity?.login?.split('@')[0] || 'Owner';
      try { shown = cleanName(shown); } catch { shown = 'Owner'; }
      db.run('INSERT INTO users (id, name, login, pass_hash, role, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, shown, identity?.login || null, password, 'owner', 0, now());
      const space = ctx.chat.createDefaultSpace(id);
      db.run('INSERT INTO space_members (space_id, user_id, joined_at) VALUES (?, ?, ?)', space, id, now());
      audit(id, 'owner', identity ? `Tailscale ${identity.login}` : 'owner invite');
      log.info(`${shown} set up the family space and owns it${identity ? ` (Tailscale ${identity.login})` : ''}`);
      return db.get('SELECT * FROM users WHERE id = ?', id);
    });
  }

  // ---------------------------------------------------------------- sessions in the browser

  // Secure when the address is https, or this request came over https through tailscale serve / Funnel (1.7.2: it
  // went without when BEAM_FAMILY_URL wasn't set).
  const secure = req => /^https:/i.test(config.publicUrl || '') || (Boolean(req) && auth.fromLoopback(req) && req.headers['x-forwarded-proto'] === 'https');

  // The session cookie: `__Host-fam_s` over https (1.7.3), `fam_s` over plain http (a LAN address, tests). A browser
  // that still has `fam_s` from before over https gets the new one on its next visit (GET /api/session).
  function sessionCookie(req) {
    const jar = parseCookies(req);
    if (jar[auth.HOST_COOKIE]) return { token: jar[auth.HOST_COOKIE], legacy: false };
    return jar[auth.COOKIE] ? { token: jar[auth.COOKIE], legacy: true } : null;
  }

  function setSessionCookie(req, res, token, maxAge) {
    res.setHeader('Set-Cookie', secure(req)
      ? [cookie(auth.HOST_COOKIE, token, { maxAge, secure: true }), cookie(auth.COOKIE, '', { maxAge: 0, secure: true })]
      : cookie(auth.COOKIE, token, { maxAge, secure: false }));
  }

  function startSession(req, res, user) {
    const token = auth.createSession(db, user.id, { agent: req.headers['user-agent'], ip: auth.clientIp(req) });
    setSessionCookie(req, res, token, auth.SESSION_DAYS * 86400);
  }

  // GET /api/session: who am I, or how to get in.
  function getSession(req, res) {
    const who = whoIs(req);
    // The family space's name only for those in it (and anyone on the tailnet): the public address can be found by
    // anyone (certificate logs list it), and the page there needn't say whose family it is.
    const out = { signedIn: Boolean(who.user), via: who.via, name: who.user || who.identity ? ctx.spaceName() : null };
    if (who.user) out.me = personJson(who.user, who.user);
    if (who.identity) out.tailscale = { login: who.identity.login, name: who.identity.name, known: Boolean(who.user) || Boolean(who.disabled) };
    if (who.disabled) out.disabled = true;
    out.ownerSetUp = hasOwner();
    if (who.legacyCookie && secure(req)) setSessionCookie(req, res, who.legacyCookie, auth.SESSION_DAYS * 86400);
    send(res, 200, out);
  }

  // POST /api/signin { name, password }
  async function signIn(req, res) {
    const body = await readJson(req);
    const ip = auth.clientIp(req);
    const name = String(body.name ?? '').trim().toLowerCase().slice(0, 64);
    const nameIp = `${name}|${ip}`;
    const nameHeld = () => failByNameIp.blocked(nameIp) || (failByName.blocked(name) && !sessionFrom(name, ip));
    // (per address first: an address that is already held back mustn't use up everyone's budget; 1.7.2)
    if (!signinByIp.hit(ip) || !signinAll.hit('all') || (name && nameHeld())) {
      const wait = Math.max(signinAll.wait('all'), signinByIp.wait(ip), name ? Math.max(failByNameIp.wait(nameIp), failByName.wait(name)) : 0);
      throw httpError(429, `Too many tries: wait ${wait > 90 ? `${Math.ceil(wait / 60)} minutes` : `${wait} seconds`}`, { retryAfter: wait });
    }
    const user = name ? db.get('SELECT * FROM users WHERE name = ? COLLATE NOCASE', name) : null;
    const ok = await auth.checkPassword(String(body.password ?? ''), user?.pass_hash || null);
    if (!ok || !user || user.disabled_at) {
      if (name) { failByNameIp.hit(nameIp); failByName.hit(name); }
      // (the name as typed, quoted and escaped: a public visitor's line breaks can't fake lines in the log)
      log.warn(`Sign-in failed for ${JSON.stringify(name.slice(0, 32))} from ${ip}`);
      throw httpError(401, user?.disabled_at && ok ? 'Your access to this family space was turned off' : 'That name and password don’t match');
    }
    failByNameIp.reset(nameIp);
    startSession(req, res, user);
    audit(user.id, 'signin', ip);
    log.info(`${user.name} signed in with a password from ${ip}`);
    send(res, 200, { me: personJson(user, user) });
  }

  // POST /api/signout: this browser's session ends (Tailscale's identity can't be signed out of: it's the device).
  async function signOut(req, res) {
    const token = sessionCookie(req)?.token;
    if (token) {
      auth.endSession(db, token);
      hub.disconnectSessions([auth.hashToken(token)]);
    }
    setSessionCookie(req, res, '', 0);
    send(res, 204);
  }

  // ---------------------------------------------------------------- invites

  // The address people use: the configured one, else the one this request came through (over tailscale serve or
  // Funnel that's https and the server's name).
  function inviteUrl(code, req = null) {
    let base = (config.publicUrl || '').replace(/\/+$/, '');
    if (!base && req) {
      const proxied = auth.fromLoopback(req) && (req.headers['x-forwarded-for'] || req.headers['tailscale-user-login']);
      const host = String(req.headers.host || '').replace(/[^A-Za-z0-9.:\-\[\]]/g, '');
      if (host) base = `${proxied && !/^(127\.|localhost|\[::1\])/.test(host) ? 'https' : 'http'}://${host}`;
    }
    return `${base}/join/${code}`;
  }

  // GET /api/invites/:code — what the join page shows (no sign-in needed; rate limited).
  function getInvite(req, res, { code }) {
    if (!inviteByIp.hit(auth.clientIp(req))) throw httpError(429, 'Too many tries: wait a few minutes');
    const invite = auth.findInvite(db, code);
    if (!invite) throw httpError(404, 'This invite link is used up, expired or was withdrawn. Ask for a new one.');
    const who = whoIs(req);
    const by = invite.created_by ? getUser(invite.created_by) : null;
    if (invite.user_id) {
      const person = getUser(invite.user_id);
      if (!person || person.disabled_at) throw httpError(404, 'This link doesn’t work any more. Ask for a new one.');
      return send(res, 200, { reset: true, name: person.name, space: ctx.spaceName(), by: by?.name || null, expires: invite.expires_at, needsPassword: true, tailscale: null, signedIn: null });
    }
    send(res, 200, {
      space: ctx.spaceName(), role: invite.role, by: by?.name || null, expires: invite.expires_at,
      tailscale: who.identity ? { login: who.identity.login, name: who.identity.name } : null,
      signedIn: who.user ? personJson(who.user, who.user) : null,
      // Over Tailscale no password is needed (one can be added later for the public link).
      needsPassword: !who.identity,
    });
  }

  // POST /api/invites/:code { name, password? } — joins: a new person, signed in.
  async function acceptInvite(req, res, { code }) {
    const ip = auth.clientIp(req);
    if (!inviteByIp.hit(ip)) throw httpError(429, 'Too many tries: wait a few minutes');
    const body = await readJson(req);
    const who = whoIs(req);
    const pending = auth.findInvite(db, code);
    if (!pending) throw httpError(404, 'This invite link is used up, expired or was withdrawn. Ask for a new one.');
    if (pending.user_id) return resetPassword(req, res, pending, body, code);
    if (who.user) throw httpError(409, `You’re already in, as ${who.user.name}`);
    if (who.disabled) throw httpError(403, 'Your access to this family space was turned off');
    const name = cleanName(body.name);
    let passHash = null;
    if (!who.identity || body.password) {
      const problem = auth.passwordProblem(body.password, name);
      if (problem) throw httpError(400, problem);
      passHash = await auth.hashPassword(body.password);
    }
    const user = db.tx(() => {
      const invite = auth.findInvite(db, code);
      if (!invite) throw httpError(404, 'This invite link is used up, expired or was withdrawn. Ask for a new one.');
      if (db.get('SELECT 1 FROM users WHERE name = ? COLLATE NOCASE', name)) throw httpError(409, 'Someone already has that name: choose another');
      db.run('UPDATE invites SET uses = uses + 1 WHERE id = ?', invite.id);
      if (invite.role === 'owner') return createOwner(who.identity, { name, password: passHash });
      const id = newId();
      const color = db.get('SELECT count(*) n FROM users').n % COLORS;
      db.run('INSERT INTO users (id, name, login, pass_hash, role, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, name, who.identity?.login || null, passHash, invite.role, color, now());
      const space = invite.space_id && db.get('SELECT id FROM spaces WHERE id = ?', invite.space_id) ? invite.space_id : ctx.chat.mainSpace();
      ctx.chat.addToSpace(space, id);
      audit(id, 'joined', `invite ${invite.id}${who.identity ? `, Tailscale ${who.identity.login}` : ', password'}`);
      return db.get('SELECT * FROM users WHERE id = ?', id);
    });
    if (!who.identity) startSession(req, res, user);
    log.info(`${user.name} joined the family space${who.identity ? ` (Tailscale ${who.identity.login})` : ` from ${ip}`}`);
    hub.emit(null, 'people', { person: personJson(user) });
    ctx.chat.announceJoin(user);
    send(res, 201, { me: personJson(user, user) });
  }

  // A password reset link used: the new password, every old session ended, this browser signed in.
  async function resetPassword(req, res, invite, body, code) {
    const person = getUser(invite.user_id);
    if (!person || person.disabled_at) throw httpError(404, 'This link doesn’t work any more. Ask for a new one.');
    const problem = auth.passwordProblem(body.password, person.name);
    if (problem) throw httpError(400, problem);
    const hash = await auth.hashPassword(body.password);
    const ended = db.tx(() => {
      if (!auth.findInvite(db, code)) throw httpError(404, 'This link doesn’t work any more. Ask for a new one.');
      db.run('UPDATE invites SET uses = uses + 1 WHERE id = ?', invite.id);
      db.run('UPDATE users SET pass_hash = ? WHERE id = ?', hash, person.id);
      const hashes = db.all('SELECT hash FROM sessions WHERE user_id = ?', person.id).map(s => s.hash);
      db.run('DELETE FROM sessions WHERE user_id = ?', person.id);
      return hashes;
    });
    hub.disconnectSessions(ended);
    audit(person.id, 'password-reset', invite.id);
    log.info(`${person.name} set a new password with a reset link from ${auth.clientIp(req)}`);
    startSession(req, res, person);
    send(res, 201, { me: personJson(person, person) });
  }

  // POST /api/people/:id/reset (admins) → { url, qr, expires }: a link that lets that person choose a new password.
  async function resetLink(req, res, { id }) {
    const admin = requireAdmin(req);
    const person = getUser(id);
    if (!person || person.disabled_at) throw httpError(404, 'No such person');
    if (person.role === 'owner' && admin.role !== 'owner') throw httpError(403, 'Only the owner can do that for the owner');
    if (person.role === 'admin' && admin.role !== 'owner' && person.id !== admin.id) throw httpError(403, 'Only the owner can do that for an admin');
    const invite = auth.createInvite(db, { createdBy: admin.id, role: person.role, maxUses: 1, days: 3, userId: person.id });
    audit(admin.id, 'reset-link', person.id);
    log.info(`${admin.name} made a password reset link for ${person.name}`);
    const url = inviteUrl(invite.code, req);
    const qr = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).catch(() => null);
    send(res, 201, { url, qr, expires: invite.expiresAt });
  }

  // POST /api/invites { role?, uses?, days?, note? } (admins) → { id, code, url, expires }
  async function createInvite(req, res) {
    const admin = requireAdmin(req);
    const body = await readJson(req, { optional: true });
    const role = body.role === 'admin' ? 'admin' : 'member';
    if (role === 'admin' && admin.role !== 'owner') throw httpError(403, 'Only the owner can invite admins');
    const uses = Math.min(50, Math.max(1, Math.floor(Number(body.uses) || 1)));
    const days = Math.min(30, Math.max(1, Math.floor(Number(body.days) || 7)));
    const invite = auth.createInvite(db, { createdBy: admin.id, role, maxUses: uses, days, note: String(body.note || ''), spaceId: ctx.chat.mainSpace() });
    audit(admin.id, 'invite', `${invite.id} ${role} x${uses} ${days}d`);
    log.info(`${admin.name} made an invite link (${role}, ${uses === 1 ? 'one person' : `${uses} people`}, ${days} days)`);
    const url = inviteUrl(invite.code, req);
    // (a QR code of the link, for inviting someone in person: their phone's camera opens it)
    const qr = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).catch(() => null);
    send(res, 201, { id: invite.id, code: invite.code, url, qr, expires: invite.expiresAt, role, uses });
  }

  // GET /api/invites (admins): the links still open.
  function listInvites(req, res) {
    requireAdmin(req);
    const rows = db.all('SELECT * FROM invites WHERE revoked_at IS NULL AND expires_at > ? AND uses < max_uses AND user_id IS NULL ORDER BY created_at DESC', now());
    send(res, 200, { invites: rows.map(i => ({ id: i.id, role: i.role, uses: i.uses, max: i.max_uses, expires: i.expires_at, created: i.created_at, by: i.created_by, note: i.note || '' })) });
  }

  // DELETE /api/invites/:id (admins): the link stops working.
  function revokeInvite(req, res, { id }) {
    const admin = requireAdmin(req);
    if (!isId(id)) throw httpError(404, 'No such invite');
    const r = db.run('UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now(), id);
    if (!r.changes) throw httpError(404, 'No such invite');
    audit(admin.id, 'invite-revoked', id);
    send(res, 204);
  }

  // ---------------------------------------------------------------- me

  // PATCH /api/me { name?, color?, password?, current? }
  async function updateMe(req, res) {
    const user = requireUser(req);
    const body = await readJson(req);
    const changes = {};
    if (body.name !== undefined) {
      const name = cleanName(body.name);
      if (name.toLowerCase() !== user.name.toLowerCase() && db.get('SELECT 1 FROM users WHERE name = ? COLLATE NOCASE AND id != ?', name, user.id)) {
        throw httpError(409, 'Someone already has that name: choose another');
      }
      changes.name = name;
    }
    if (body.color !== undefined) {
      const color = Number(body.color);
      if (!Number.isInteger(color) || color < 0 || color >= COLORS) throw httpError(400, 'Unknown colour');
      changes.color = color;
    }
    if (body.password !== undefined) {
      // Changing a password needs the current one, unless signed in by Tailscale (who already proved who they are).
      // Those checks count like sign-ins (1.7.2: a stolen session could otherwise guess the password without limit).
      if (user.pass_hash && whoIs(req).via !== 'tailscale') {
        const ip = auth.clientIp(req);
        const name = user.name.toLowerCase();
        if (!signinByIp.hit(ip) || failByNameIp.blocked(`${name}|${ip}`) || failByName.blocked(name)) throw httpError(429, 'Too many tries: wait a few minutes');
        if (!(await auth.checkPassword(String(body.current ?? ''), user.pass_hash))) {
          failByNameIp.hit(`${name}|${ip}`);
          failByName.hit(name);
          throw httpError(403, 'Your current password isn’t right');
        }
      }
      if (body.password === null) {
        if (!user.login) throw httpError(400, 'You sign in with your password: you can change it but not remove it');
        changes.pass_hash = null;
      } else {
        const problem = auth.passwordProblem(body.password, changes.name || user.name);
        if (problem) throw httpError(400, problem);
        changes.pass_hash = await auth.hashPassword(body.password);
      }
    }
    const keys = Object.keys(changes);
    if (keys.length) {
      db.run(`UPDATE users SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => changes[k]), user.id);
      if (changes.pass_hash !== undefined) {
        // Other browsers signed in with the old password are signed out, and their open streams end.
        const keep = whoIs(req).sessionHash || '';
        const ended = db.all('SELECT hash FROM sessions WHERE user_id = ? AND hash != ?', user.id, keep).map(s => s.hash);
        db.run('DELETE FROM sessions WHERE user_id = ? AND hash != ?', user.id, keep);
        hub.disconnectSessions(ended);
        audit(user.id, 'password', changes.pass_hash ? 'set' : 'removed');
      }
    }
    const updated = getUser(user.id);
    hub.emit(null, 'people', { person: personJson(updated) });
    send(res, 200, { me: personJson(updated, updated) });
  }

  // GET /api/me/sessions: the browsers signed in with my password.
  function listSessions(req, res) {
    const user = requireUser(req);
    const current = whoIs(req).sessionHash;
    const rows = db.all('SELECT hash, created_at, seen_at, agent, ip FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY seen_at DESC', user.id, now());
    send(res, 200, { sessions: rows.map(s => ({ id: s.hash.slice(0, 16), created: s.created_at, seen: s.seen_at, agent: s.agent, ip: s.ip, current: s.hash === current })) });
  }

  // DELETE /api/me/sessions/:id — or "others" for all but this one.
  function endSessions(req, res, { id }) {
    const user = requireUser(req);
    const current = whoIs(req).sessionHash || '';
    let ended;
    if (id === 'others') {
      ended = db.all('SELECT hash FROM sessions WHERE user_id = ? AND hash != ?', user.id, current).map(s => s.hash);
      db.run('DELETE FROM sessions WHERE user_id = ? AND hash != ?', user.id, current);
    } else if (/^[A-Za-z0-9_-]{16}$/.test(id)) {
      ended = db.all('SELECT hash FROM sessions WHERE user_id = ? AND substr(hash, 1, 16) = ?', user.id, id).map(s => s.hash);
      db.run('DELETE FROM sessions WHERE user_id = ? AND substr(hash, 1, 16) = ?', user.id, id);
    } else throw httpError(404, 'No such session');
    hub.disconnectSessions(ended); // (their open streams end now too; 1.7.2)
    send(res, 204);
  }

  // ---------------------------------------------------------------- admins

  // PATCH /api/people/:id { role?, disabled? }
  async function updatePerson(req, res, { id }) {
    const admin = requireAdmin(req);
    const body = await readJson(req);
    const person = getUser(id);
    if (!person) throw httpError(404, 'No such person');
    if (person.role === 'owner') throw httpError(403, 'The owner can’t be changed');
    if (person.id === admin.id) throw httpError(403, 'Ask another admin');
    if (person.role === 'admin' && admin.role !== 'owner') throw httpError(403, 'Only the owner can change an admin');
    if (body.role !== undefined) {
      if (body.role !== 'admin' && body.role !== 'member') throw httpError(400, 'role must be admin or member');
      if (body.role === 'admin' && admin.role !== 'owner') throw httpError(403, 'Only the owner can make admins');
      db.run('UPDATE users SET role = ? WHERE id = ?', body.role, person.id);
      audit(admin.id, 'role', `${person.id} ${body.role}`);
      log.info(`${admin.name} made ${person.name} ${body.role === 'admin' ? 'an admin' : 'a member'}`);
    }
    if (body.disabled !== undefined) {
      if (typeof body.disabled !== 'boolean') throw httpError(400, 'disabled must be true or false');
      db.run('UPDATE users SET disabled_at = ? WHERE id = ?', body.disabled ? now() : null, person.id);
      if (body.disabled) {
        db.run('DELETE FROM sessions WHERE user_id = ?', person.id);
        db.run('DELETE FROM push_subs WHERE user_id = ?', person.id);
        hub.disconnectUser(person.id);
      }
      audit(admin.id, body.disabled ? 'disabled' : 'enabled', person.id);
      log.info(`${admin.name} ${body.disabled ? 'turned off' : 'turned back on'} ${person.name}’s access`);
    }
    const updated = getUser(person.id);
    hub.emit(null, 'people', { person: personJson(updated) });
    send(res, 200, { person: personJson(updated, admin) });
  }

  return {
    whoIs, requireUser, requireAdmin, personJson, getUser, audit, hasOwner, createOwner,
    routes: [
      ['GET', '/api/session', getSession],
      ['POST', '/api/signin', signIn],
      ['POST', '/api/signout', signOut],
      ['GET', '/api/invites/:code', getInvite],
      ['POST', '/api/invites/:code', acceptInvite],
      ['POST', '/api/invites', createInvite],
      ['GET', '/api/invites', listInvites],
      ['DELETE', '/api/invites/:id', revokeInvite],
      ['PATCH', '/api/me', updateMe],
      ['GET', '/api/me/sessions', listSessions],
      ['DELETE', '/api/me/sessions/:id', endSessions],
      ['PATCH', '/api/people/:id', updatePerson],
      ['POST', '/api/people/:id/reset', resetLink],
    ],
  };
}

module.exports = { createPeople, cleanName, COLORS };
