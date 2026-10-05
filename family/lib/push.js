'use strict';
// Web Push: notifications on phones and computers while the app is closed (Android and desktop browsers, and the
// iPhone home-screen app). The server signs each request with its own VAPID key (RFC 8292) and encrypts the content
// for that browser alone (RFC 8291, aes128gcm): the push service carries it without being able to read it.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { newId } = require('./ids');
const { httpError, send, readJson } = require('./http');

const now = () => Date.now();
const b64u = buf => Buffer.from(buf).toString('base64url');
const fromB64u = s => Buffer.from(String(s), 'base64url');

// The push services browsers use: subscriptions anywhere else are refused (the server would be made to call them).
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

function pushHostAllowed(endpoint) {
  try {
    const u = new URL(endpoint);
    // (tests only: a fake push service on this machine)
    if (process.env.BEAM_FAMILY_TEST_PUSH === '1' && u.protocol === 'http:' && u.hostname === '127.0.0.1') return true;
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && PUSH_HOSTS.some(re => re.test(u.hostname));
  } catch {
    return false;
  }
}

// RFC 8291 §3 and RFC 8188: the encrypted body for one subscription. `salt` and `serverKeys` are for the tests' fixed
// vector; normally they're fresh each time.
function encrypt(payload, { p256dh, auth }, { salt = crypto.randomBytes(16), serverKeys = null } = {}) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error('bad subscription keys');
  const ecdh = crypto.createECDH('prime256v1');
  if (serverKeys) ecdh.setPrivateKey(serverKeys.privateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

function createPush(ctx, { file, contact = '' }) {
  const { db, hub, log } = ctx;
  const people = () => ctx.people;

  // This server's VAPID key, made once and kept.
  let keys;
  try { keys = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!keys?.d || !keys?.x || !keys?.y) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    keys = privateKey.export({ format: 'jwk' });
    fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  }
  const privateKey = crypto.createPrivateKey({ key: keys, format: 'jwk' });
  const publicKey = b64u(Buffer.concat([Buffer.from([4]), fromB64u(keys.x), fromB64u(keys.y)]));

  // A VAPID token for a push service's origin, kept for 12 hours (each is good for up to 24).
  const tokens = new Map();
  function vapidHeader(endpoint) {
    const audience = new URL(endpoint).origin;
    const hit = tokens.get(audience);
    if (hit && hit.exp - now() / 1000 > 12 * 3600) return hit.header;
    const exp = Math.floor(now() / 1000) + 24 * 3600 - 60;
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64u(JSON.stringify({ aud: audience, exp, sub: contact || 'mailto:family@beam.invalid' }));
    const signature = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    const header = `vapid t=${head}.${claims}.${b64u(signature)}, k=${publicKey}`;
    tokens.set(audience, { exp, header });
    return header;
  }

  // Sends one notification to every subscription of a person (gone ones are forgotten).
  async function sendTo(userId, payload, { urgency = 'normal', topic = null } = {}) {
    const subs = db.all('SELECT * FROM push_subs WHERE user_id = ?', userId);
    await Promise.all(subs.map(async s => {
      let status = 0;
      try {
        const body = encrypt(JSON.stringify(payload), s);
        const headers = { TTL: '86400', Urgency: urgency, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidHeader(s.endpoint) };
        if (topic) headers.Topic = topic;
        const res = await fetch(s.endpoint, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
        status = res.status;
        await res.arrayBuffer().catch(() => {});
      } catch (err) {
        status = -1;
        if (s.failures === 0) log.warn(`Push to ${new URL(s.endpoint).hostname} failed: ${err.message}`);
      }
      if (status >= 200 && status < 300) db.run('UPDATE push_subs SET ok_at = ?, failures = 0 WHERE id = ?', now(), s.id);
      else if (status === 404 || status === 410) db.run('DELETE FROM push_subs WHERE id = ?', s.id); // the browser dropped it
      else {
        db.run('UPDATE push_subs SET failures = failures + 1 WHERE id = ?', s.id);
        if (s.failures + 1 >= 20) db.run('DELETE FROM push_subs WHERE id = ?', s.id);
        else if (status > 0) log.warn(`Push to ${new URL(s.endpoint).hostname} answered ${status}`);
      }
    }));
  }

  const preview = (text, names) => text.replace(/<@([0-9A-HJKMNP-TV-Z]{26})>/g, (_, id) => `@${names.get(id) || 'someone'}`).replace(/\s+/g, ' ').trim();

  // A new message: who should hear about it on their phone (not the author, not someone looking at it right now, as
  // each person's notification setting for that conversation says).
  async function notifyMessage({ message, channel, author, to, mentions }) {
    const recipients = to.filter(id => id !== author.id && !hub.watching(id, channel.id));
    if (!recipients.length) return;
    const levels = new Map(db.all(`SELECT user_id, level FROM notify WHERE channel_id = ? AND user_id IN (${recipients.map(() => '?').join(', ')})`, channel.id, ...recipients)
      .map(r => [r.user_id, r.level]));
    // (only the people it mentions: every user was loaded for every message; 1.7.3, audit O-09)
    const ids = [...new Set([...String(message.body || '').matchAll(/<@([0-9A-HJKMNP-TV-Z]{26})>/g)].map(m => m[1]))].slice(0, 50);
    const names = new Map(ids.length ? db.all(`SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(', ')})`, ...ids).map(u => [u.id, u.name]) : []);
    const files = message.files || [];
    let text = preview(message.body, names);
    if (!text && files.length) text = files.every(f => f.mime.startsWith('image/')) ? (files.length > 1 ? `📷 ${files.length} photos` : '📷 Photo') : `📎 ${files[0].name}`;
    text = [...text].slice(0, 140).join('');
    const where = channel.kind === 'text' ? `#${channel.name}` : channel.kind === 'group' ? (channel.name || 'Group') : null;
    const payload = { kind: 'msg', channel: channel.id, id: message.id, title: where ? `${author.name} in ${where}` : author.name, body: text, url: `/c/${channel.id}` };
    const topic = crypto.createHash('sha256').update(channel.id).digest('base64url').slice(0, 32);
    await Promise.all(recipients.map(async id => {
      const level = levels.get(id) || 'all';
      const mentioned = mentions.everyone || mentions.ids.includes(id);
      if (level === 'none' || (level === 'mentions' && !mentioned && channel.kind === 'text')) return;
      await sendTo(id, payload, { urgency: channel.kind !== 'text' || mentioned ? 'high' : 'normal', topic });
    }));
  }

  // GET /api/push → { key }; PUT /api/push { endpoint, keys: { p256dh, auth } }; DELETE /api/push { endpoint }
  function getKey(req, res) {
    people().requireUser(req);
    send(res, 200, { key: publicKey });
  }

  async function subscribe(req, res) {
    const user = people().requireUser(req);
    const body = await readJson(req);
    const endpoint = String(body.endpoint || '');
    if (endpoint.length > 1000 || !pushHostAllowed(endpoint)) throw httpError(400, 'That push service isn’t one browsers use');
    const p256dh = String(body.keys?.p256dh || '');
    const auth = String(body.keys?.auth || '');
    if (fromB64u(p256dh).length !== 65 || fromB64u(auth).length !== 16) throw httpError(400, 'The subscription’s keys are missing');
    // (audit S-7) An address stays with the member who registered it: someone else registering it again would stop
    // their notifications. One that has been failing (gone stale) can move.
    const held = db.get('SELECT user_id, failures FROM push_subs WHERE endpoint = ?', endpoint);
    if (held && held.user_id !== user.id && !(held.failures > 0)) throw httpError(409, 'That notification address belongs to someone else');
    db.run(`INSERT INTO push_subs (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, failures = 0`,
    newId(), user.id, endpoint, p256dh, auth, now());
    send(res, 204);
  }

  async function unsubscribe(req, res) {
    const user = people().requireUser(req);
    const body = await readJson(req);
    db.run('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?', String(body.endpoint || ''), user.id);
    send(res, 204);
  }

  return {
    publicKey: () => publicKey, notifyMessage, sendTo,
    routes: [
      ['GET', '/api/push', getKey],
      ['PUT', '/api/push', subscribe],
      ['DELETE', '/api/push', unsubscribe],
    ],
  };
}

module.exports = { createPush, encrypt, pushHostAllowed };
