#!/usr/bin/env node
// Beam Family server tests. No dependencies. Starts family/server.js on 127.0.0.1:8841–8849 with temporary data
// (Tailscale lookups off): Tailscale's identity headers are sent the way `tailscale serve` sends them (from this
// machine), and a fake push service on this machine receives the notifications, which are decrypted as a browser
// would.
//   node test/family.test.js            run everything
//   node test/family.test.js invite dm  run the tests whose names contain one of the words
'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'family', 'server.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-family-test-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OWNER = 'owner@example.com';
// (1.10.0) ffmpeg for F-R: BEAM_TEST_FFMPEG, else ffmpeg on the PATH; without one F-R says so and passes.
const FFMPEG = (() => {
  if (process.env.BEAM_TEST_FFMPEG) return fs.existsSync(process.env.BEAM_TEST_FFMPEG) ? process.env.BEAM_TEST_FFMPEG : null;
  return spawnSync('ffmpeg', ['-hide_banner', '-version'], { windowsHide: true }).status === 0 ? 'ffmpeg' : null;
})();
const FFPROBE = FFMPEG && path.join(path.dirname(FFMPEG), path.basename(FFMPEG).replace(/ffmpeg/i, 'ffprobe'));

// ---------------------------------------------------------------- harness

const children = new Set();
process.on('exit', () => { for (const c of children) try { c.kill(); } catch {} });

function familyEnv(port, dir, env = {}) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('BEAM_')) out[k] = v;
  return { ...out, BEAM_FAMILY_DATA: path.join(dir, 'data'), BEAM_FAMILY_PORT: String(port), BEAM_FAMILY_HOST: '127.0.0.1', BEAM_TAILSCALE: 'off',
    BEAM_FAMILY_OWNER: OWNER, BEAM_FAMILY_TEST_PUSH: '1', BEAM_FAMILY_STUN: 'off', BEAM_FAMILY_FFMPEG: 'off', ...env }; // (direct connections and
  // ffmpeg: only where a test asks)
}

async function start(name, port, { env = {}, keep = false, args = [] } = {}) {
  assert.ok(port >= 8841 && port <= 8849, 'family test ports are 8841–8849');
  const dir = path.join(TMP, name);
  if (!keep) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, [SERVER, ...args], { env: familyEnv(port, dir, env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(child);
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const exited = new Promise(resolve => child.once('exit', code => { children.delete(child); resolve(code); }));
  const srv = {
    port, dir, data: path.join(dir, 'data'), child, exited, env: familyEnv(port, dir, env),
    get out() { return out; },
    stop: async () => { if (child.exitCode === null) { child.kill(); await exited; } },
    req: (method, route, opts) => request(port, method, route, opts),
  };
  const deadline = Date.now() + 15000;
  while (!/is running/.test(out)) {
    if (child.exitCode !== null) throw new Error(`family server ${name} exited: ${out}`);
    if (Date.now() > deadline) throw new Error(`family server ${name} did not start: ${out}`);
    await sleep(50);
  }
  return srv;
}

function request(port, method, route, { headers = {}, body, raw = false, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host, port, method, path: route, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json;
        try { json = JSON.parse(buf.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: raw ? buf : buf.toString('utf8'), json });
      });
    });
    r.setTimeout(20000, () => r.destroy(new Error('timeout')));
    r.on('error', e => (['ECONNRESET', 'EPIPE'].includes(e.code) ? resolve({ status: 'reset', headers: {}, body: '', json: null }) : reject(e)));
    r.end(body);
  });
}

function openEvents(port, headers) {
  return new Promise((resolve, reject) => {
    const events = [];
    let closed = false;
    const r = http.request({ host: '127.0.0.1', port, path: '/api/events', headers, agent: false }, res => {
      let buf = '';
      res.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const lines = block.split('\n');
          const event = lines.find(l => l.startsWith('event: '))?.slice(7);
          const data = lines.find(l => l.startsWith('data: '))?.slice(6);
          const id = lines.find(l => l.startsWith('id: '))?.slice(4);
          if (event) events.push({ event, id, data: data ? JSON.parse(data) : null });
        }
      });
      res.on('close', () => { closed = true; });
      resolve({
        status: res.statusCode, events, get closed() { return closed; }, close: () => r.destroy(),
        wait: (name, pred = () => true, ms = 5000) => waitFor(() => events.find(e => e.event === name && pred(e.data)), ms),
        lastId: () => [...events].reverse().find(e => e.id)?.id,
      });
    });
    r.on('error', e => (e.code === 'ECONNRESET' ? null : reject(e)));
    r.end();
  });
}

async function waitFor(check, ms = 5000, step = 40) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(step);
  }
}

// Ways in: Tailscale (as serve sends it) or a session cookie.
// (as tailscale serve sends them: the identity, and the caller's Tailscale address in X-Forwarded-For)
const ts = (login, name = '') => ({ 'Tailscale-User-Login': login, 'X-Forwarded-For': '100.64.7.7', ...(name ? { 'Tailscale-User-Name': name } : {}) });
const as = who => (typeof who === 'string' ? { Cookie: who } : who);
const call = (srv, method, route, who = {}, body) => srv.req(method, route, {
  headers: { ...as(who), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined,
});
const sessionOf = res => /fam_s=([^;]*)/.exec([].concat(res.headers['set-cookie'] || []).join('\n'))?.[1];

// An owner (by Tailscale) and the family space's channels.
async function family(srv) {
  const owner = ts(OWNER, 'Robin');
  const b = (await call(srv, 'GET', '/api/bootstrap', owner)).json;
  return { owner, me: b.me, space: b.spaces[0].id, general: b.channels.find(c => c.name === 'general').id, photos: b.channels.find(c => c.name === 'photos').id };
}

// A new person through an invite: by password (returns their cookie) or by Tailscale identity.
async function join(srv, inviter, name, { login = null, role } = {}) {
  const inv = await call(srv, 'POST', '/api/invites', inviter, role ? { role } : {});
  assert.equal(inv.status, 201, inv.body);
  const code = inv.json.url.split('/join/')[1];
  if (login) {
    const r = await call(srv, 'POST', `/api/invites/${code}`, ts(login), { name });
    assert.equal(r.status, 201, r.body);
    return { who: ts(login), id: r.json.me.id };
  }
  const r = await call(srv, 'POST', `/api/invites/${code}`, {}, { name, password: 'a long family password' });
  assert.equal(r.status, 201, r.body);
  return { who: `fam_s=${sessionOf(r)}`, id: r.json.me.id };
}

const post = async (srv, who, channel, body, extra = {}) => {
  const r = await call(srv, 'POST', `/api/channels/${channel}/messages`, who, { body, ...extra });
  assert.equal(r.status, 201, r.body);
  return r.json.message;
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('F-K (1.7.2): Tailscale identity only for a caller at a Tailscale address and never through Funnel; signing out ends that sign-in’s live stream; 30 unsent uploads each at most', async () => {
  const s = await start('audit172', 8848);
  try {
    const f = await family(s);
    let r = await call(s, 'GET', '/api/session', { ...ts(OWNER, 'Robin'), 'X-Forwarded-For': '203.0.113.5' });
    assert.equal(r.json.signedIn, false, 'identity headers for a caller that isn’t at a Tailscale address don’t count');
    r = await call(s, 'GET', '/api/session', { ...ts(OWNER, 'Robin'), 'Tailscale-Funnel-Request': '?1' });
    assert.equal(r.json.signedIn, false, '...nor on a Funnel request');
    assert.equal((await call(s, 'GET', '/api/session', f.owner)).json.signedIn, true, '...as tailscale serve sends them, they do');
    // A password sign-in's live stream ends when it signs out (it went on receiving everything).
    const mary = await join(s, f.owner, 'Mary');
    const ev = await openEvents(s.port, { Cookie: mary.who });
    await ev.wait('hello');
    assert.equal((await call(s, 'POST', '/api/signout', mary.who)).status, 204);
    await waitFor(() => ev.closed, 3000);
    // Unsent uploads count against the storage by their declared size: 30 at a time each.
    for (let i = 0; i < 30; i++) assert.equal((await call(s, 'POST', '/api/uploads', f.owner, { name: `f${i}.txt`, size: 10 })).status, 201);
    r = await call(s, 'POST', '/api/uploads', f.owner, { name: 'one-more.txt', size: 10 });
    assert.equal(r.status, 429, r.body);
  } finally { await s.stop(); }
});

test('F-L (1.7.3): over https the session cookie is __Host- (older ones move over); guessing at a name can’t lock its person out; longer passwords; a file in the cache is checked again', async () => {
  const s = await start('audit173', 8848);
  try {
    const f = await family(s);
    const mary = await join(s, f.owner, 'Mary');
    const https = { 'X-Forwarded-Proto': 'https' }; // (as tailscale serve / Funnel send it, from this machine)
    const cookies = r => [].concat(r.headers['set-cookie'] || []);
    // Signing in over https: __Host-fam_s, and any old fam_s goes.
    let r = await call(s, 'POST', '/api/signin', https, { name: 'mary', password: 'a long family password' });
    assert.equal(r.status, 200, r.body);
    const token = /__Host-fam_s=([^;]+)/.exec(cookies(r).join('\n'))?.[1];
    assert.ok(token && cookies(r).some(c => /^__Host-fam_s=.*; Path=\/;.*Secure/.test(c)) && cookies(r).some(c => /^fam_s=;.*Max-Age=0/.test(c)), cookies(r).join(' | '));
    assert.equal((await call(s, 'GET', '/api/session', { ...https, Cookie: `__Host-fam_s=${token}` })).json.signedIn, true);
    // A browser with the old cookie gets the new one on its next visit (same session); plain http keeps fam_s.
    r = await call(s, 'GET', '/api/session', { ...https, Cookie: mary.who });
    assert.equal(r.json.signedIn, true);
    assert.equal(/__Host-fam_s=([^;]+)/.exec(cookies(r).join('\n'))?.[1], mary.who.split('=')[1], 'moved over');
    assert.deepEqual(cookies(await call(s, 'GET', '/api/session', mary.who)), [], 'nothing to move over plain http');
    r = await call(s, 'POST', '/api/signout', { ...https, Cookie: `__Host-fam_s=${token}` });
    assert.ok(cookies(r).some(c => /^__Host-fam_s=;.*Max-Age=0/.test(c)) && cookies(r).some(c => /^fam_s=;.*Max-Age=0/.test(c)), 'both go on signing out');
    // Wrong passwords for a name from 25 addresses: its person still gets in from their own (it was 20 an hour, from anywhere).
    for (let i = 0; i < 25; i++) {
      const w = await s.req('POST', '/api/signin', { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `203.0.113.${100 + i}` }, body: JSON.stringify({ name: 'mary', password: `guess ${i}` }) });
      assert.equal(w.status, 401, `guess ${i}`);
    }
    r = await s.req('POST', '/api/signin', { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.5' }, body: JSON.stringify({ name: 'mary', password: 'a long family password' }) });
    assert.equal(r.status, 200, r.body);
    // New passwords: at least 10 characters, not a run along the keyboard or the alphabet, not a short pattern again and again.
    const inv = (await call(s, 'POST', '/api/invites', f.owner, {})).json.url.split('/join/')[1];
    for (const password of ['nine char', 'qwertyuiop', '0987654321', 'abababababab']) {
      r = await call(s, 'POST', `/api/invites/${inv}`, {}, { name: 'Tom', password });
      assert.equal(r.status, 400, `${password}: ${r.body}`);
    }
    assert.equal((await call(s, 'POST', `/api/invites/${inv}`, {}, { name: 'Tom', password: 'ten chars!' })).status, 201);
    // A file is checked again on every use: a quick 304 while its message is there, gone once it's deleted.
    const data = crypto.randomBytes(3000);
    const id = (await call(s, 'POST', '/api/uploads', f.owner, { name: 'note.bin', size: data.length })).json.id;
    await s.req('PUT', `/api/uploads/${id}?offset=0`, { headers: { ...as(f.owner), 'Content-Type': 'application/octet-stream' }, body: data });
    const msg = await post(s, f.owner, f.general, '', { files: [id] });
    r = await call(s, 'GET', `/api/files/${id}`, f.owner);
    assert.deepEqual([r.status, r.headers['cache-control']], [200, 'private, no-cache']);
    const etag = r.headers.etag;
    assert.ok(etag);
    assert.equal((await call(s, 'GET', `/api/files/${id}`, { ...f.owner, 'If-None-Match': etag })).status, 304);
    assert.equal((await call(s, 'DELETE', `/api/messages/${msg.id}`, f.owner)).status, 204);
    assert.equal((await call(s, 'GET', `/api/files/${id}`, { ...f.owner, 'If-None-Match': etag })).status, 404, 'not from the cache either');
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- push: a fake push service, and a browser's keys

function pushService() {
  const got = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      got.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(req.url.startsWith('/gone') ? 410 : 201);
      res.end();
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ got, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

function browserKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}

// RFC 8291: what the browser does with a push message.
function decryptPush(body, { ecdh, auth }) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const data = body.subarray(21 + idlen);
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(data.subarray(-16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  assert.equal(plain[end], 2, 'last record delimiter');
  return JSON.parse(plain.subarray(0, end).toString('utf8'));
}

// ---------------------------------------------------------------- tests

test('F-A: the machine owner becomes the owner over Tailscale; nobody else; the app pages carry their protections', async () => {
  const s = await start('owner', 8841);
  try {
    let r = await call(s, 'GET', '/api/session');
    assert.deepEqual([r.status, r.json.signedIn, r.json.ownerSetUp], [200, false, false]);
    r = await call(s, 'GET', '/api/session', ts('someone@example.com', 'Someone'));
    assert.deepEqual([r.json.signedIn, r.json.tailscale.known, r.json.ownerSetUp], [false, false, false], 'a stranger over Tailscale is not let in');
    r = await call(s, 'GET', '/api/session', ts('=?utf-8?q?Owner=40Example=2Ecom?=', 'Robin'));
    assert.deepEqual([r.json.signedIn, r.json.me.role, r.json.me.name, r.json.via], [true, 'owner', 'Robin', 'tailscale'], 'RFC 2047 login decoded; the owner set up');
    r = await call(s, 'GET', '/api/bootstrap', ts(OWNER));
    assert.deepEqual(r.json.channels.map(c => c.name).sort(), ['general', 'photos']);
    assert.equal(r.json.me.tailscale, OWNER, 'the owner sees how they sign in');
    assert.match(s.out, /Robin set up the family space and owns it \(Tailscale owner@example\.com\)/);
    // The page: strict CSP, no framing; its own routes get the page; other paths 404.
    r = await s.req('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-security-policy'], /default-src 'self'; script-src 'self'/);
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    for (const route of ['/c/01ABCDEFGHJKMNPQRSTVWXYZ01', '/join/abcdefghijklmnopqrstuv', '/settings']) assert.equal((await s.req('GET', route)).status, 200, route);
    assert.equal((await s.req('GET', '/nothing-here')).status, 404);
    assert.equal((await s.req('GET', '/../server.js')).status, 404, 'no way out of the app folder');
    assert.equal((await s.req('GET', '/api/nothing')).status, 404);
    assert.equal((await s.req('DELETE', '/api/bootstrap')).status, 405);
  } finally { await s.stop(); }
});

test('F-B: invites: admins make them, single use, by password over the public link or bound to a Tailscale login; names and passwords checked', async () => {
  const s = await start('invites', 8842);
  try {
    const f = await family(s);
    const mary = await join(s, f.owner, 'Mary');
    let r = await call(s, 'POST', '/api/invites', mary.who, {});
    assert.equal(r.status, 403, 'a member can’t invite');
    r = await call(s, 'POST', '/api/invites', f.owner, { uses: 2, days: 3 });
    const code = r.json.url.split('/join/')[1];
    assert.equal(r.json.uses, 2);
    r = await call(s, 'GET', `/api/invites/${code}`);
    assert.deepEqual([r.json.by, r.json.needsPassword, r.json.role], ['Robin', true, 'member']);
    r = await call(s, 'GET', `/api/invites/${code}`, ts('aunt@example.com', 'Aunt Sue'));
    assert.deepEqual([r.json.needsPassword, r.json.tailscale.login], [false, 'aunt@example.com'], 'over Tailscale no password is needed');
    for (const [body, status] of [[{ name: 'Bob', password: 'short' }, 400], [{ name: 'Bob', password: 'password123' }, 400], [{ name: 'MARY', password: 'a long family password' }, 409],
      [{ name: '', password: 'a long family password' }, 400], [{ name: 'x'.repeat(33), password: 'a long family password' }, 400]]) {
      assert.equal((await call(s, 'POST', `/api/invites/${code}`, {}, body)).status, status, JSON.stringify(body));
    }
    r = await call(s, 'POST', `/api/invites/${code}`, ts('aunt@example.com', 'Aunt Sue'), { name: 'Aunt Sue' });
    assert.equal(r.status, 201, r.body);
    assert.equal(sessionOf(r), undefined, 'Tailscale needs no session cookie');
    r = await call(s, 'GET', '/api/session', ts('AUNT@example.com'));
    assert.deepEqual([r.json.signedIn, r.json.me.name], [true, 'Aunt Sue'], 'her Tailscale login signs her in');
    r = await call(s, 'POST', `/api/invites/${code}`, ts('aunt@example.com'), { name: 'Sue again' });
    assert.equal(r.status, 409, 'already in');
    r = await call(s, 'POST', `/api/invites/${code}`, {}, { name: 'Bob', password: 'a long family password' });
    assert.equal(r.status, 201, 'the second use');
    r = await call(s, 'POST', `/api/invites/${code}`, {}, { name: 'Carl', password: 'a long family password' });
    assert.equal(r.status, 404, 'used up');
    // Withdrawn: stops working; only admins can.
    r = await call(s, 'POST', '/api/invites', f.owner, {});
    const id = r.json.id;
    const code2 = r.json.url.split('/join/')[1];
    assert.equal((await call(s, 'DELETE', `/api/invites/${id}`, mary.who)).status, 403);
    assert.equal((await call(s, 'DELETE', `/api/invites/${id}`, f.owner)).status, 204);
    assert.equal((await call(s, 'GET', `/api/invites/${code2}`)).status, 404);
    assert.equal((await call(s, 'GET', '/api/invites/not-a-real-code-at-all')).status, 404);
    // Signing in: case-insensitive name, wrong password, 10 tries per address per 10 minutes.
    r = await call(s, 'POST', '/api/signin', {}, { name: 'bob', password: 'a long family password' });
    assert.equal(r.status, 200, r.body);
    assert.match([].concat(r.headers['set-cookie']).join(), /HttpOnly; SameSite=Lax/);
    for (let i = 0; i < 9; i++) assert.equal((await s.req('POST', '/api/signin', { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' }, body: JSON.stringify({ name: 'bob', password: `wrong ${i}` }) })).status, 401);
    r = await s.req('POST', '/api/signin', { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' }, body: JSON.stringify({ name: 'bob', password: 'wrong 9' }) });
    assert.equal(r.status, 401);
    r = await s.req('POST', '/api/signin', { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' }, body: JSON.stringify({ name: 'bob', password: 'a long family password' }) });
    assert.equal(r.status, 429, 'the 11th try from that address waits, right password or not');
    // Made-up addresses in front of the one Funnel adds (the last) change nothing.
    r = await s.req('POST', '/api/signin', { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.77, 203.0.113.9' }, body: JSON.stringify({ name: 'bob', password: 'a long family password' }) });
    assert.equal(r.status, 429, 'a forged first X-Forwarded-For entry doesn’t dodge the limit');
    assert.ok(Number(r.headers['retry-after']) > 0);
    r = await s.req('POST', '/api/signin', { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.10' }, body: JSON.stringify({ name: 'bob', password: 'a long family password' }) });
    assert.equal(r.status, 200, 'another address is fine');
    // A name with a line break can't fake a line in the log (it's quoted and escaped).
    const forged = await s.req('POST', '/api/signin', { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.11' }, body: JSON.stringify({ name: 'x\nINFO  Bob owns it now', password: 'not the password' }) });
    assert.equal(forged.status, 401);
    assert.match(s.out, /Sign-in failed for "x\\ninfo {2}bob owns it now" from 203\.0\.113\.11/);
    assert.doesNotMatch(s.out, /^info {2}bob owns it now/m);
    // Signing out ends that session only.
    const bob = `fam_s=${sessionOf(r)}`;
    assert.equal((await call(s, 'POST', '/api/signout', bob)).status, 204);
    assert.equal((await call(s, 'GET', '/api/bootstrap', bob)).status, 401);
    // An owner invite is refused while there's an owner; the CLI's invite needs an owner first.
    const cli = spawnSync(process.execPath, [SERVER, 'invite', '--owner'], { env: s.env, encoding: 'utf8' });
    assert.match(cli.stderr, /already has an owner/);
    const cli2 = spawnSync(process.execPath, [SERVER, 'invite', '--uses', '3'], { env: s.env, encoding: 'utf8' });
    assert.match(cli2.stdout, /Invite \(member, until .*\):\n.*\/join\/[A-Za-z0-9_-]{22}/);
    assert.equal((await call(s, 'GET', `/api/invites/${cli2.stdout.trim().split('/join/')[1]}`)).status, 200, 'the running server takes the CLI’s invite');
  } finally { await s.stop(); }
});

test('F-C: Tailscale’s identity headers count only from this machine (as tailscale serve sends them), never from the network', async () => {
  const lan = Object.values(os.networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal)?.address;
  if (!lan) return console.log('      (skipped: no network address)');
  const s = await start('trust', 8843, { env: { BEAM_FAMILY_HOST: '0.0.0.0' } });
  try {
    await family(s);
    let r = await s.req('GET', '/api/session', { headers: ts(OWNER), host: lan });
    assert.deepEqual([r.status, r.json.signedIn, r.json.tailscale], [200, false, undefined], `from ${lan}: no identity`);
    r = await s.req('GET', '/api/bootstrap', { headers: ts(OWNER), host: lan });
    assert.equal(r.status, 401);
    r = await s.req('GET', '/api/session', { headers: ts(OWNER) });
    assert.equal(r.json.signedIn, true, 'from this machine: yes');
  } finally { await s.stop(); }
});

test('F-D: who sees what: DMs and groups private to their members, channels to the space, archived ones read-only and hidden from members', async () => {
  const s = await start('visibility', 8844);
  try {
    const f = await family(s);
    const mary = await join(s, f.owner, 'Mary');
    const bob = await join(s, f.owner, 'Bob');
    let r = await call(s, 'POST', '/api/dms', mary.who, { people: [f.me.id] });
    assert.equal(r.status, 201);
    const dm = r.json.channel.id;
    await post(s, mary.who, dm, 'just between us: the surprise party is Saturday');
    // Bob: not in the DM.
    assert.equal((await call(s, 'GET', `/api/channels/${dm}/messages`, bob.who)).status, 404);
    assert.equal((await call(s, 'POST', `/api/channels/${dm}/messages`, bob.who, { body: 'hi' })).status, 404);
    assert.ok(!(await call(s, 'GET', '/api/bootstrap', bob.who)).json.channels.some(c => c.id === dm));
    assert.deepEqual((await call(s, 'GET', '/api/search?q=surprise', bob.who)).json.messages, [], 'search doesn’t reach into others’ DMs');
    assert.equal((await call(s, 'GET', '/api/search?q=surprise', f.owner)).json.messages.length, 1);
    assert.equal((await call(s, 'GET', `/api/search?q=surprise&channel=${dm}`, bob.who)).status, 404);
    // The same DM again; nobody can open one with someone disabled or unknown.
    assert.equal((await call(s, 'POST', '/api/dms', f.owner, { people: [mary.id] })).json.channel.id, dm);
    assert.equal((await call(s, 'POST', '/api/dms', mary.who, { people: ['01ABCDEFGHJKMNPQRSTVWXYZ01'] })).status, 400);
    assert.equal((await call(s, 'POST', '/api/dms', mary.who, { people: [] })).status, 400);
    // A group: members rename it; others can't; leaving.
    r = await call(s, 'POST', '/api/dms', mary.who, { people: [bob.id, f.me.id], name: 'Trip planning' });
    const group = r.json.channel.id;
    assert.deepEqual([r.json.channel.kind, r.json.channel.name, r.json.channel.members.length], ['group', 'Trip planning', 3]);
    r = await call(s, 'PATCH', `/api/channels/${group}`, bob.who, { name: 'Beach trip 🏖️' });
    assert.equal(r.json.channel.name, 'Beach trip 🏖️');
    assert.equal((await call(s, 'PATCH', `/api/channels/${group}`, bob.who, { topic: 'x' })).status, 400);
    assert.equal((await call(s, 'DELETE', `/api/channels/${group}/members/me`, bob.who)).status, 204);
    assert.equal((await call(s, 'GET', `/api/channels/${group}/messages`, bob.who)).status, 404, 'gone after leaving');
    // Channels: admins make them, the name is unique, members can't; archived: hidden from members, read-only.
    assert.equal((await call(s, 'POST', `/api/spaces/${f.space}/channels`, mary.who, { name: 'recipes' })).status, 403);
    r = await call(s, 'POST', `/api/spaces/${f.space}/channels`, f.owner, { name: '#Recipes 🍲', topic: 'Grandma’s cookbook' });
    assert.equal(r.status, 201);
    const recipes = r.json.channel.id;
    assert.equal(r.json.channel.name, 'Recipes 🍲');
    assert.equal((await call(s, 'POST', `/api/spaces/${f.space}/channels`, f.owner, { name: 'recipes 🍲' })).status, 409);
    await post(s, mary.who, recipes, 'Lasagne');
    assert.equal((await call(s, 'PATCH', `/api/channels/${recipes}`, mary.who, { archived: true })).status, 403);
    assert.equal((await call(s, 'PATCH', `/api/channels/${recipes}`, f.owner, { archived: true })).status, 200);
    assert.ok(!(await call(s, 'GET', '/api/bootstrap', mary.who)).json.channels.some(c => c.id === recipes));
    assert.equal((await call(s, 'GET', `/api/channels/${recipes}/messages`, mary.who)).status, 404);
    assert.equal((await call(s, 'POST', `/api/channels/${recipes}/messages`, f.owner, { body: 'x' })).status, 403, 'archived: read-only');
    assert.equal((await call(s, 'GET', `/api/channels/${recipes}/messages`, f.owner)).json.messages.length, 1);
    // A newcomer's channels start read; renaming the space.
    await post(s, mary.who, f.general, 'before Carl');
    const carl = await join(s, f.owner, 'Carl');
    const g = (await call(s, 'GET', '/api/bootstrap', carl.who)).json.channels.find(c => c.id === f.general);
    assert.equal(g.unread, 0, 'no backlog for a newcomer');
    assert.equal((await call(s, 'PATCH', `/api/spaces/${f.space}`, mary.who, { name: 'x' })).status, 403);
    assert.equal((await call(s, 'PATCH', `/api/spaces/${f.space}`, f.owner, { name: 'The Smiths' })).json.space.name, 'The Smiths');
    assert.equal((await call(s, 'GET', '/api/session', mary.who)).json.name, 'The Smiths');
    assert.equal((await call(s, 'GET', '/api/session')).json.name, null, 'not to anonymous visitors (the public address can be found by anyone)');
  } finally { await s.stop(); }
});

test('F-E: messages: replies, mentions and unread counts, edits and deletes by whom, reactions, pins, paging, read state, limits', async () => {
  const s = await start('messages', 8845, { env: { BEAM_FAMILY_POSTS_PER_10S: '1000' } });
  try {
    const f = await family(s);
    const mary = await join(s, f.owner, 'Mary');
    const bob = await join(s, f.owner, 'Bob');
    const first = await post(s, mary.who, f.general, 'Hello\r\nfamily  ‮txt.exe\u0007 ');
    assert.equal(first.body, 'Hello\nfamily  txt.exe', 'CRLF → LF; control characters, direction overrides and trailing spaces gone');
    const reply = await post(s, f.owner, f.general, `Welcome <@${mary.id}> and <@01ABCDEFGHJKMNPQRSTVWXYZ01>`, { reply: first.id });
    assert.deepEqual([reply.reply.id, reply.reply.author, reply.reply.body], [first.id, mary.id, first.body]);
    let b = (await call(s, 'GET', '/api/bootstrap', mary.who)).json.channels.find(c => c.id === f.general);
    assert.deepEqual([b.unread, b.mentions], [1, 1]);
    b = (await call(s, 'GET', '/api/bootstrap', bob.who)).json.channels.find(c => c.id === f.general);
    assert.deepEqual([b.unread, b.mentions], [2, 0], 'Bob: unread, not mentioned (unknown ids aren’t mentions)');
    await post(s, f.owner, f.general, 'Dinner at 6, @everyone');
    b = (await call(s, 'GET', '/api/bootstrap', bob.who)).json.channels.find(c => c.id === f.general);
    assert.deepEqual([b.unread, b.mentions], [3, 1], '@everyone mentions Bob');
    // Replies only within the conversation.
    const dm = (await call(s, 'POST', '/api/dms', mary.who, { people: [bob.id] })).json.channel.id;
    assert.equal((await call(s, 'POST', `/api/channels/${dm}/messages`, mary.who, { body: 'x', reply: first.id })).status, 400);
    // Limits.
    assert.equal((await call(s, 'POST', `/api/channels/${f.general}/messages`, mary.who, { body: '   ' })).status, 400, 'empty');
    assert.equal((await call(s, 'POST', `/api/channels/${f.general}/messages`, mary.who, { body: 'x'.repeat(4001) })).status, 400, 'too long');
    assert.equal((await call(s, 'POST', `/api/channels/${f.general}/messages`, mary.who, { body: '😀'.repeat(4000) })).status, 201, '4,000 characters (code points) is fine');
    assert.equal((await s.req('POST', `/api/channels/${f.general}/messages`, { headers: { Cookie: mary.who }, body: '{"body":"x"}' })).status, 415, 'JSON only');
    // Edits: the author only; deletes: the author or an admin.
    assert.equal((await call(s, 'PATCH', `/api/messages/${first.id}`, bob.who, { body: 'hacked' })).status, 403);
    let r = await call(s, 'PATCH', `/api/messages/${first.id}`, mary.who, { body: `Hi all, especially <@${bob.id}>` });
    assert.ok(r.json.message.edited);
    b = (await call(s, 'GET', '/api/bootstrap', bob.who)).json.channels.find(c => c.id === f.general);
    assert.equal(b.mentions, 2, 'an edit can add a mention');
    assert.equal((await call(s, 'DELETE', `/api/messages/${reply.id}`, bob.who)).status, 403);
    const bobs = await post(s, bob.who, f.general, 'oops');
    assert.equal((await call(s, 'DELETE', `/api/messages/${bobs.id}`, f.owner)).status, 204, 'an admin deletes another’s message');
    assert.match(s.out, /Robin deleted a message by Bob/);
    assert.equal((await call(s, 'PATCH', `/api/messages/${bobs.id}`, bob.who, { body: 'x' })).status, 404, 'deleted: gone');
    // A reply to a deleted message says so.
    const quoted = await post(s, mary.who, f.general, 'to be deleted');
    const answer = await post(s, bob.who, f.general, 'answer', { reply: quoted.id });
    await call(s, 'DELETE', `/api/messages/${quoted.id}`, mary.who);
    let page = (await call(s, 'GET', `/api/channels/${f.general}/messages`, bob.who)).json.messages;
    assert.deepEqual(page.find(m => m.id === answer.id).reply, { id: quoted.id, deleted: true });
    assert.ok(!page.some(m => m.id === quoted.id), 'deleted messages aren’t listed');
    // Reactions: emoji only (ZWJ sequences, flags, keycaps, skin tones), on and off, at most 20 kinds.
    for (const e of ['👍', '❤️', '👨‍👩‍👧', '🇬🇧', '1️⃣', '👋🏽']) assert.equal((await call(s, 'PUT', `/api/messages/${first.id}/reactions/${encodeURIComponent(e)}`, bob.who)).status, 204, e);
    for (const e of ['a', '<b>', '👍x', '']) assert.ok([400, 404].includes((await call(s, 'PUT', `/api/messages/${first.id}/reactions/${encodeURIComponent(e)}`, bob.who)).status), JSON.stringify(e));
    await call(s, 'PUT', `/api/messages/${first.id}/reactions/${encodeURIComponent('👍')}`, mary.who);
    await call(s, 'DELETE', `/api/messages/${first.id}/reactions/${encodeURIComponent('❤️')}`, bob.who);
    page = (await call(s, 'GET', `/api/channels/${f.general}/messages`, bob.who)).json.messages;
    const reacted = page.find(m => m.id === first.id).reactions;
    assert.deepEqual(reacted.find(x => x.emoji === '👍').users.sort(), [bob.id, mary.id].sort());
    assert.ok(!reacted.some(x => x.emoji === '❤️'));
    const emoji = ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😌']; // 20 kinds with the 5 above
    for (const e of emoji) await call(s, 'PUT', `/api/messages/${first.id}/reactions/${encodeURIComponent(e)}`, bob.who);
    assert.equal((await call(s, 'PUT', `/api/messages/${first.id}/reactions/${encodeURIComponent('😍')}`, bob.who)).status, 400, 'a 21st kind');
    // Pins.
    assert.equal((await call(s, 'PUT', `/api/messages/${reply.id}/pin`, mary.who)).status, 200);
    assert.deepEqual((await call(s, 'GET', `/api/channels/${f.general}/pins`, bob.who)).json.messages.map(m => m.id), [reply.id]);
    // Paging: 120 messages, then before / after / around.
    const ids = [];
    for (let i = 0; i < 120; i++) ids.push((await post(s, bob.who, dm, `n${i}`)).id);
    page = (await call(s, 'GET', `/api/channels/${dm}/messages`, mary.who)).json;
    assert.deepEqual([page.messages.length, page.more.before, page.messages.at(-1).body], [50, true, 'n119']);
    page = (await call(s, 'GET', `/api/channels/${dm}/messages?before=${ids[50]}&limit=100`, mary.who)).json;
    assert.deepEqual([page.messages.length, page.more.before, page.messages[0].body, page.messages.at(-1).body], [50, false, 'n0', 'n49']);
    page = (await call(s, 'GET', `/api/channels/${dm}/messages?after=${ids[100]}`, mary.who)).json;
    assert.deepEqual([page.messages.length, page.more.after, page.messages[0].body], [19, false, 'n101']);
    page = (await call(s, 'GET', `/api/channels/${dm}/messages?around=${ids[60]}&limit=10`, mary.who)).json;
    assert.deepEqual(page.messages.map(m => m.body), ['n55', 'n56', 'n57', 'n58', 'n59', 'n60', 'n61', 'n62', 'n63', 'n64']);
    assert.equal((await call(s, 'GET', `/api/channels/${dm}/messages?before=junk`, mary.who)).status, 400);
    // Read state: only forward, never past the last message; counts stop at 100 ("99+"); posting reads up to there.
    b = (await call(s, 'GET', '/api/bootstrap', mary.who)).json.channels.find(c => c.id === dm);
    assert.equal(b.unread, 100);
    await call(s, 'POST', `/api/channels/${dm}/read`, mary.who, { id: ids[100] });
    await call(s, 'POST', `/api/channels/${dm}/read`, mary.who, { id: ids[10] });
    b = (await call(s, 'GET', '/api/bootstrap', mary.who)).json.channels.find(c => c.id === dm);
    assert.deepEqual([b.read, b.unread], [ids[100], 19]);
    const own = await post(s, mary.who, dm, 'caught up');
    b = (await call(s, 'GET', '/api/bootstrap', mary.who)).json.channels.find(c => c.id === dm);
    assert.deepEqual([b.read, b.unread], [own.id, 0]);
    // Notification levels.
    assert.equal((await call(s, 'PUT', `/api/channels/${f.general}/notify`, mary.who, { level: 'mentions' })).status, 204);
    assert.equal((await call(s, 'PUT', `/api/channels/${f.general}/notify`, mary.who, { level: 'loud' })).status, 400);
    assert.equal((await call(s, 'GET', '/api/bootstrap', mary.who)).json.channels.find(c => c.id === f.general).notify, 'mentions');
    // Search: words, the last one as a prefix; FTS syntax is just text.
    assert.equal((await call(s, 'GET', `/api/search?q=${encodeURIComponent('dinn')}`, mary.who)).json.messages.length, 1);
    assert.equal((await call(s, 'GET', `/api/search?q=${encodeURIComponent('"NEAR( OR * dinner')}`, mary.who)).status, 200);
  } finally { await s.stop(); }
});

test('F-F: live events go only to who sees the conversation; a reconnect gets what it missed; after a restart: resync', async () => {
  const s = await start('events', 8846);
  try {
    const f = await family(s);
    const mary = await join(s, f.owner, 'Mary');
    const bob = await join(s, f.owner, 'Bob');
    const evMary = await openEvents(s.port, as(mary.who));
    const evBob = await openEvents(s.port, as(bob.who));
    await evMary.wait('hello');
    await evBob.wait('hello');
    const dm = (await call(s, 'POST', '/api/dms', f.owner, { people: [mary.id] })).json.channel.id;
    await evMary.wait('channel', d => d.channel.id === dm);
    const m = await post(s, f.owner, dm, 'secret', { nonce: 'abc' });
    const got = await evMary.wait('msg', d => d.message.id === m.id);
    assert.equal(got.data.nonce, 'abc');
    await call(s, 'POST', `/api/channels/${dm}/typing`, mary.who);
    await call(s, 'PUT', `/api/messages/${m.id}/reactions/${encodeURIComponent('👍')}`, mary.who);
    await evMary.wait('react', d => d.id === m.id);
    await post(s, mary.who, f.general, 'in general');
    await evBob.wait('msg', d => d.message.body === 'in general');
    await sleep(200);
    assert.ok(!evBob.events.some(e => JSON.stringify(e.data).includes('secret') || e.data?.channel === dm || e.data?.channel?.id === dm), 'Bob gets nothing of the DM');
    // Presence: Bob goes, everyone hears.
    evBob.close();
    await evMary.wait('presence', d => d.person === bob.id && d.online === false);
    // Missed while away: replayed from Last-Event-ID.
    const last = evMary.lastId();
    evMary.close();
    await post(s, f.owner, dm, 'while you were away');
    const back = await openEvents(s.port, { ...as(mary.who), 'Last-Event-ID': last });
    await back.wait('msg', d => d.message.body === 'while you were away');
    assert.ok(!back.events.some(e => e.event === 'resync'));
    const lastAgain = back.lastId();
    back.close();
    // A restart: the old ids mean nothing, so resync.
    await s.stop();
    const s2 = await start('events', 8846, { keep: true });
    try {
      const again = await openEvents(s2.port, { ...as(mary.who), 'Last-Event-ID': lastAgain });
      await again.wait('resync');
      again.close();
      // Focus: what an open app is looking at.
      const ev = await openEvents(s2.port, as(mary.who));
      const hello = await ev.wait('hello');
      assert.equal((await call(s2, 'PUT', '/api/focus', mary.who, { client: hello.data.client, channel: dm, visible: true })).status, 204);
      assert.equal((await call(s2, 'PUT', '/api/focus', bob.who, { client: hello.data.client, channel: null })).status, 404, 'not someone else’s connection');
      // Turned off: the stream ends at once.
      await call(s2, 'PATCH', `/api/people/${mary.id}`, f.owner, { disabled: true });
      await waitFor(() => ev.closed);
      assert.equal((await call(s2, 'GET', '/api/bootstrap', mary.who)).status, 401);
    } finally { await s2.stop(); }
  } finally { await s.stop(); }
});

test('F-G: files: resumable uploads, limits, only sent to the conversation, inline only for pictures/videos/sounds, previews, avatars', async () => {
  const s = await start('files', 8847, { env: { BEAM_FAMILY_MAX_UPLOAD_MB: '1', BEAM_FAMILY_MAX_STORAGE_GB: String(3 / 1024) } });
  try {
    const f = await family(s);
    const mary = await join(s, f.owner, 'Mary');
    const bob = await join(s, f.owner, 'Bob');
    const upload = async (who, name, data, mime) => {
      const r = await call(s, 'POST', '/api/uploads', who, { name, size: data.length, mime });
      assert.equal(r.status, 201, r.body);
      const id = r.json.id;
      const half = Math.floor(data.length / 2);
      let p = await s.req('PUT', `/api/uploads/${id}?offset=0`, { headers: { ...as(who), 'Content-Type': 'application/octet-stream' }, body: data.subarray(0, half) });
      assert.deepEqual(p.json, { offset: half, done: false });
      p = await s.req('PUT', `/api/uploads/${id}?offset=0`, { headers: { ...as(who), 'Content-Type': 'application/octet-stream' }, body: data.subarray(half) });
      assert.deepEqual([p.status, p.json.offset], [409, half], 'the wrong offset is refused, with the right one');
      p = await s.req('PUT', `/api/uploads/${id}?offset=${half}`, { headers: { ...as(who), 'Content-Type': 'application/octet-stream' }, body: data.subarray(half) });
      assert.deepEqual(p.json, { offset: data.length, done: true });
      return id;
    };
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(300_000)]);
    const photo = await upload(mary.who, 'beach.jpg', jpeg, 'image/jpeg');
    // Not sent yet: only Mary sees it.
    assert.equal((await call(s, 'GET', `/api/files/${photo}`, bob.who)).status, 404);
    assert.equal((await call(s, 'GET', `/api/files/${photo}`, mary.who)).status, 200);
    // A preview with the picture's size.
    let r = await s.req('PUT', `/api/files/${photo}/thumb?w=4000&h=3000`, { headers: { ...as(mary.who), 'Content-Type': 'image/jpeg' }, body: Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]) });
    assert.equal(r.status, 204);
    r = await s.req('PUT', `/api/files/${photo}/thumb`, { headers: { ...as(mary.who), 'Content-Type': 'image/jpeg' }, body: Buffer.from('<svg/>') });
    assert.equal(r.status, 400, 'a preview must be what it says');
    // Sending it: in a DM with the owner.
    const dm = (await call(s, 'POST', '/api/dms', mary.who, { people: [f.me.id] })).json.channel.id;
    r = await call(s, 'POST', `/api/channels/${dm}/messages`, mary.who, { body: '', files: [photo] });
    assert.equal(r.status, 201, r.body);
    assert.deepEqual([r.json.message.files[0].name, r.json.message.files[0].width, r.json.message.files[0].thumb], ['beach.jpg', 4000, `/api/files/${photo}/thumb`]);
    assert.equal((await call(s, 'POST', `/api/channels/${dm}/messages`, mary.who, { files: [photo] })).status, 400, 'a file is sent once');
    r = await s.req('GET', `/api/files/${photo}`, { headers: as(f.owner), raw: true });
    assert.deepEqual([r.status, r.headers['content-type'], r.body.equals(jpeg)], [200, 'image/jpeg', true]);
    assert.match(r.headers['content-disposition'], /^inline; filename="beach.jpg"/);
    assert.match(r.headers['content-security-policy'], /sandbox/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    r = await s.req('GET', `/api/files/${photo}`, { headers: { ...as(f.owner), Range: 'bytes=4-13' }, raw: true });
    assert.deepEqual([r.status, r.headers['content-range'], r.body.equals(jpeg.subarray(4, 14))], [206, `bytes 4-13/${jpeg.length}`, true]);
    assert.equal((await call(s, 'GET', `/api/files/${photo}`, bob.who)).status, 404, 'not in Bob’s conversations');
    assert.equal((await call(s, 'GET', `/api/files/${photo}/thumb`, bob.who)).status, 404);
    assert.equal((await call(s, 'GET', `/api/files/${photo}/thumb`, f.owner)).status, 200);
    // Pages and scripts never show inline (they'd run as the app); the declared type of a .html file is ignored.
    const page = await upload(mary.who, 'page.html', Buffer.from('<script>alert(1)</script>'), 'text/html');
    const svg = await upload(mary.who, 'logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml');
    await call(s, 'POST', `/api/channels/${f.general}/messages`, mary.who, { body: 'files', files: [page, svg] });
    for (const id of [page, svg]) {
      r = await s.req('GET', `/api/files/${id}`, { headers: as(bob.who) });
      assert.match(r.headers['content-disposition'], /^attachment;/, id);
      assert.match(r.headers['content-security-policy'], /sandbox/);
    }
    assert.notEqual((await s.req('GET', `/api/files/${page}`, { headers: as(bob.who) })).headers['content-type'], 'text/html');
    // Limits: 1 MB a file; 3 MB in all (then 507, nothing evicted).
    assert.equal((await call(s, 'POST', '/api/uploads', mary.who, { name: 'big.bin', size: 2 * 1024 * 1024 })).status, 413);
    await upload(bob.who, 'a.bin', crypto.randomBytes(1024 * 1024), 'application/octet-stream');
    await upload(bob.who, 'b.bin', crypto.randomBytes(1024 * 1024), 'application/octet-stream');
    r = await call(s, 'POST', '/api/uploads', bob.who, { name: 'c.bin', size: 900 * 1024 });
    assert.equal(r.status, 507, r.body);
    assert.match(r.json.error, /storage is full/);
    // Someone else's upload can't be continued or sent.
    const mine = (await call(s, 'POST', '/api/uploads', mary.who, { name: 'x.txt', size: 3 })).json.id;
    assert.equal((await s.req('PUT', `/api/uploads/${mine}?offset=0`, { headers: { ...as(bob.who), 'Content-Type': 'application/octet-stream' }, body: 'abc' })).status, 404);
    assert.equal((await call(s, 'POST', `/api/channels/${f.general}/messages`, bob.who, { files: [mine] })).status, 400);
    // Deleting the message deletes its files.
    const gone = (await call(s, 'GET', `/api/channels/${dm}/messages`, mary.who)).json.messages[0].id;
    await call(s, 'DELETE', `/api/messages/${gone}`, mary.who);
    assert.equal((await call(s, 'GET', `/api/files/${photo}`, mary.who)).status, 404);
    await waitFor(() => !fs.existsSync(path.join(s.data, 'files', photo)));
    // Avatars: JPEG/PNG/WebP that are what they say, seen by everyone signed in.
    r = await s.req('PUT', '/api/me/avatar', { headers: { ...as(mary.who), 'Content-Type': 'image/png' }, body: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), crypto.randomBytes(100)]) });
    assert.equal(r.status, 200, r.body);
    const avatar = r.json.me.avatar;
    assert.match(avatar, /^\/api\/people\/[0-9A-Z]{26}\/avatar\?v=/);
    assert.equal((await s.req('GET', avatar, { headers: as(bob.who) })).headers['content-type'], 'image/png');
    assert.equal((await s.req('GET', avatar)).status, 401);
    assert.equal((await s.req('PUT', '/api/me/avatar', { headers: { ...as(mary.who), 'Content-Type': 'image/png' }, body: '<svg/>' })).status, 400);
  } finally { await s.stop(); }
});

test('F-H: push: only the push services browsers use; encrypted for that browser; not to the author, someone looking at it, or as each person chose', async () => {
  const push = await pushService();
  const s = await start('push', 8848);
  try {
    const f = await family(s);
    const mary = await join(s, f.owner, 'Mary');
    const bob = await join(s, f.owner, 'Bob');
    let r = await call(s, 'GET', '/api/push', mary.who);
    assert.equal(Buffer.from(r.json.key, 'base64url').length, 65, 'the VAPID public key');
    const key = r.json.key;
    for (const endpoint of ['https://evil.example.com/push', 'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.net/x', 'file:///etc/passwd']) {
      assert.equal((await call(s, 'PUT', '/api/push', mary.who, { endpoint, keys: browserKeys().keys })).status, 400, endpoint);
    }
    const maryKeys = browserKeys();
    const bobKeys = browserKeys();
    assert.equal((await call(s, 'PUT', '/api/push', mary.who, { endpoint: `${push.url}/mary`, keys: maryKeys.keys })).status, 204);
    assert.equal((await call(s, 'PUT', '/api/push', bob.who, { endpoint: `${push.url}/bob`, keys: bobKeys.keys })).status, 204);
    // A message in #general: Mary and Bob are told, not the owner who wrote it.
    await post(s, f.owner, f.general, `Look at this, <@${mary.id}>!`);
    await waitFor(() => push.got.length >= 2);
    await sleep(200);
    assert.deepEqual(push.got.map(g => g.path).sort(), ['/bob', '/mary']);
    const toMary = push.got.find(g => g.path === '/mary');
    assert.equal(toMary.headers['content-encoding'], 'aes128gcm');
    assert.equal(toMary.headers.urgency, 'high', 'a mention is urgent');
    assert.match(toMary.headers.authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${key}$`));
    const [head, claims, sig] = toMary.headers.authorization.slice(8).split(', k=')[0].split('.');
    assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).aud, push.url, 'the token is for that push service');
    const jwk = { kty: 'EC', crv: 'P-256', x: Buffer.from(key, 'base64url').subarray(1, 33).toString('base64url'), y: Buffer.from(key, 'base64url').subarray(33).toString('base64url') };
    assert.ok(crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), 'signed with the VAPID key');
    const payload = decryptPush(toMary.body, maryKeys);
    assert.deepEqual([payload.title, payload.body, payload.channel, payload.url], ['Robin in #general', 'Look at this, @Mary!', f.general, `/c/${f.general}`]);
    assert.equal(push.got.find(g => g.path === '/bob').headers.urgency, 'normal');
    // Mary looks at #general in an open app: not pushed to her. Bob mutes it except mentions.
    const ev = await openEvents(s.port, as(mary.who));
    const hello = await ev.wait('hello');
    await call(s, 'PUT', '/api/focus', mary.who, { client: hello.data.client, channel: f.general, visible: true });
    await call(s, 'PUT', `/api/channels/${f.general}/notify`, bob.who, { level: 'mentions' });
    push.got.length = 0;
    await post(s, f.owner, f.general, 'Nothing special');
    await sleep(500);
    assert.deepEqual(push.got.map(g => g.path), [], 'Mary is looking; Bob only wants mentions');
    await post(s, f.owner, f.general, `<@${bob.id}> your turn`);
    await waitFor(() => push.got.length === 1);
    assert.equal(push.got[0].path, '/bob');
    // A DM always notifies (unless none); a 410 forgets that browser.
    push.got.length = 0;
    await call(s, 'PUT', '/api/push', bob.who, { endpoint: `${push.url}/gone`, keys: browserKeys().keys });
    const dm = (await call(s, 'POST', '/api/dms', f.owner, { people: [bob.id] })).json.channel.id;
    await post(s, f.owner, dm, 'private');
    await waitFor(() => push.got.length === 2);
    await sleep(200);
    const subs = await (async () => {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(s.data, 'family.db'), { readOnly: true });
      try { return db.prepare('SELECT endpoint FROM push_subs').all().map(r => r.endpoint).sort(); } finally { db.close(); }
    })();
    assert.deepEqual(subs, [`${push.url}/bob`, `${push.url}/mary`], 'the gone subscription was removed');
    assert.equal(decryptPush(push.got.find(g => g.path === '/bob').body, bobKeys).title, 'Robin', 'a DM is titled with the sender');
    ev.close();
  } finally { await s.stop(); push.close(); }
});

test('F-I: changes only from the app’s own pages; admins and roles; turning someone off ends everything', async () => {
  const s = await start('rules', 8849);
  try {
    const f = await family(s);
    const mary = await join(s, f.owner, 'Mary');
    const admin = await join(s, f.owner, 'Ann', { role: 'admin' });
    // Same-origin: cross-site or same-site (another machine on the tailnet) is refused, even with Tailscale's identity.
    for (const site of ['cross-site', 'same-site']) {
      const r = await s.req('POST', `/api/channels/${f.general}/messages`, { headers: { ...f.owner, 'Content-Type': 'application/json', 'Sec-Fetch-Site': site }, body: '{"body":"x"}' });
      assert.equal(r.status, 403, site);
    }
    let r = await s.req('POST', `/api/channels/${f.general}/messages`, { headers: { ...f.owner, 'Content-Type': 'application/json', Origin: 'https://evil.example.com' }, body: '{"body":"x"}' });
    assert.equal(r.status, 403, 'a foreign Origin');
    r = await s.req('POST', `/api/channels/${f.general}/messages`, { headers: { ...f.owner, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: '{"body":"from the app"}' });
    assert.equal(r.status, 201);
    // Too fast: 20 posts in 10 seconds per person.
    let limited = 0;
    for (let i = 0; i < 25; i++) if ((await call(s, 'POST', `/api/channels/${f.photos}/messages`, mary.who, { body: `fast ${i}` })).status === 429) limited++;
    assert.ok(limited >= 5, `slowed down (${limited})`);
    assert.equal((await call(s, 'POST', `/api/channels/${f.photos}/messages`, admin.who, { body: 'not me' })).status, 201, 'per person');
    // Roles: only the owner makes admins; admins can't change admins or the owner; nobody changes themselves.
    assert.equal((await call(s, 'PATCH', `/api/people/${mary.id}`, admin.who, { role: 'admin' })).status, 403);
    assert.equal((await call(s, 'PATCH', `/api/people/${f.me.id}`, admin.who, { disabled: true })).status, 403);
    assert.equal((await call(s, 'PATCH', `/api/people/${admin.id}`, admin.who, { role: 'member' })).status, 403);
    assert.equal((await call(s, 'PATCH', `/api/people/${mary.id}`, mary.who, { disabled: true })).status, 403);
    assert.equal((await call(s, 'POST', '/api/invites', admin.who, { role: 'admin' })).status, 403, 'only the owner invites admins');
    assert.equal((await call(s, 'PATCH', `/api/people/${mary.id}`, f.owner, { role: 'admin' })).json.person.role, 'admin');
    assert.equal((await call(s, 'PATCH', `/api/people/${mary.id}`, f.owner, { role: 'member' })).json.person.role, 'member');
    // Me: name, colour, password (the current one is needed with a password session).
    assert.equal((await call(s, 'PATCH', '/api/me', mary.who, { name: 'ann' })).status, 409);
    assert.equal((await call(s, 'PATCH', '/api/me', mary.who, { name: 'Mary B', color: 3 })).json.me.name, 'Mary B');
    assert.equal((await call(s, 'PATCH', '/api/me', mary.who, { password: 'another long password', current: 'wrong' })).status, 403);
    // A second browser signed in as Mary is signed out by her password change.
    const other = `fam_s=${sessionOf(await call(s, 'POST', '/api/signin', {}, { name: 'Mary B', password: 'a long family password' }))}`;
    assert.equal((await call(s, 'GET', '/api/me/sessions', mary.who)).json.sessions.length, 2);
    assert.equal((await call(s, 'PATCH', '/api/me', mary.who, { password: 'another long password', current: 'a long family password' })).status, 200);
    assert.equal((await call(s, 'GET', '/api/bootstrap', other)).status, 401);
    assert.equal((await call(s, 'GET', '/api/bootstrap', mary.who)).status, 200, 'the browser that changed it stays in');
    // A forgotten password: an admin's reset link (members can't make one; only the owner for the owner).
    assert.equal((await call(s, 'POST', `/api/people/${mary.id}/reset`, mary.who)).status, 403);
    assert.equal((await call(s, 'POST', `/api/people/${f.me.id}/reset`, admin.who)).status, 403);
    r = await call(s, 'POST', `/api/people/${mary.id}/reset`, admin.who);
    assert.equal(r.status, 201, r.body);
    const resetCode = r.json.url.split('/join/')[1];
    assert.ok(r.json.qr.startsWith('<svg'), 'a QR code');
    assert.ok(!(await call(s, 'GET', '/api/invites', f.owner)).json.invites.some(i => i.uses === 0 && i.max === 1 && i.role === 'member' && i.id === r.json.id), 'not among the open invites');
    r = await call(s, 'GET', `/api/invites/${resetCode}`);
    assert.deepEqual([r.json.reset, r.json.name, r.json.by], [true, 'Mary B', 'Ann']);
    assert.equal((await call(s, 'POST', `/api/invites/${resetCode}`, {}, { password: 'short' })).status, 400);
    r = await call(s, 'POST', `/api/invites/${resetCode}`, {}, { password: 'a brand new password' });
    assert.equal(r.status, 201, r.body);
    assert.equal(r.json.me.name, 'Mary B', 'the same person, not a new one');
    const fresh = `fam_s=${sessionOf(r)}`;
    assert.equal((await call(s, 'GET', '/api/bootstrap', mary.who)).status, 401, 'her old sessions ended');
    assert.equal((await call(s, 'GET', '/api/bootstrap', fresh)).status, 200, 'signed in by the reset');
    assert.equal((await call(s, 'POST', `/api/invites/${resetCode}`, {}, { password: 'yet another password' })).status, 404, 'used once');
    assert.equal((await call(s, 'POST', '/api/signin', {}, { name: 'Mary B', password: 'another long password' })).status, 401, 'the old password is gone');
    mary.who = fresh;
    assert.match(s.out, /Mary B set a new password with a reset link/);
    // Turning off: no sign-in, no session; turned back on: signs in again.
    assert.equal((await call(s, 'PATCH', `/api/people/${mary.id}`, admin.who, { disabled: true })).status, 200);
    assert.equal((await call(s, 'GET', '/api/bootstrap', mary.who)).status, 401);
    r = await call(s, 'POST', '/api/signin', {}, { name: 'Mary B', password: 'a brand new password' });
    assert.deepEqual([r.status, r.json.error], [401, 'Your access to this family space was turned off']);
    await call(s, 'PATCH', `/api/people/${mary.id}`, admin.who, { disabled: false });
    assert.equal((await call(s, 'POST', '/api/signin', {}, { name: 'Mary B', password: 'a brand new password' })).status, 200);
    assert.match(s.out, /Ann turned off Mary B’s access/);
  } finally { await s.stop(); }
});

test('F-J: the CLI: an owner invite before anyone owns it; status; stop under the supervisor', async () => {
  const dir = path.join(TMP, 'cli');
  fs.mkdirSync(dir, { recursive: true });
  const env = familyEnv(8841, dir, { BEAM_FAMILY_OWNER: '' });
  let r = spawnSync(process.execPath, [SERVER, 'invite'], { env, encoding: 'utf8' });
  assert.match(r.stderr, /Set up the owner first/);
  r = spawnSync(process.execPath, [SERVER, 'invite', '--owner'], { env, encoding: 'utf8' });
  const code = /\/join\/([A-Za-z0-9_-]{22})/.exec(r.stdout)?.[1];
  assert.ok(code, r.stdout + r.stderr);
  const child = spawn(process.execPath, [SERVER, '--supervise'], { env, stdio: 'ignore', windowsHide: true });
  children.add(child);
  try {
    await waitFor(async () => { try { return (await request(8841, 'GET', '/api/hello')).json?.family; } catch { return false; } }, 15000);
    // The owner invite over the public link: name and password, then that's the owner.
    let res = await request(8841, 'POST', `/api/invites/${code}`, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', password: 'the owner password' }) });
    assert.equal(res.status, 201, res.body);
    assert.equal(res.json.me.role, 'owner');
    r = spawnSync(process.execPath, [SERVER, 'status'], { env, encoding: 'utf8' });
    assert.match(r.stdout, /Beam Family: 1 person, 0 messages/);
    r = spawnSync(process.execPath, [SERVER, 'stop'], { env, encoding: 'utf8' });
    assert.match(r.stdout, /Beam Family stopped/);
    await waitFor(() => child.exitCode !== null, 15000);
    assert.equal(child.exitCode, 0, 'the supervisor ends too');
    // Only this machine's owner (with the control key, from here, not through a proxy) can stop it.
    const again = await start('cli-again', 8842, {});
    res = await again.req('POST', '/api/admin/shutdown', { headers: { 'X-Family-Control': 'guess' } });
    assert.equal(res.status, 404);
    const key = fs.readFileSync(path.join(again.data, 'control.key'), 'utf8');
    res = await again.req('POST', '/api/admin/shutdown', { headers: { 'X-Family-Control': key, 'X-Forwarded-For': '203.0.113.5' } });
    assert.equal(res.status, 404, 'not through tailscale serve or Funnel');
    await again.stop();
  } finally { try { child.kill(); } catch {} }
});

test('F-M (1.8.1): backups: the database as a snapshot taken while it runs, its keys, the files; the newest kept; restored only with the server stopped (--force moves the data there aside), and it works again', async () => {
  const bk = path.join(TMP, 'family-backups');
  const env = { BEAM_FAMILY_BACKUP_DIR: bk, BEAM_FAMILY_BACKUP_KEEP: '2' };
  let s = await start('backup', 8843, { env });
  try {
    const f = await family(s);
    await post(s, f.owner, f.general, 'Before the backups');
    const cli = (...args) => spawnSync(process.execPath, [SERVER, ...args], { env: s.env, encoding: 'utf8' });
    let r = cli('backup');
    assert.match(r.stdout, /Saved .*family-backup-\d{8}-\d{6}\.tar\.gz \(\d+ KB\)\. It holds the family's messages and keys: keep it private\./, r.stdout + r.stderr);
    await waitFor(() => /Backed up Beam Family \(asked on this PC\): family-backup-/.test(s.out), 5000); // (spawnSync held this process: the output comes now)
    await post(s, f.owner, f.general, 'Between them');
    for (let i = 0; i < 2; i++) { await sleep(1100); assert.equal(cli('backup').status, 0); }
    const names = fs.readdirSync(bk).filter(n => /^family-backup-/.test(n)).sort();
    assert.equal(names.length, 2, `the newest two are kept: ${names}`);
    await waitFor(() => /Removed 1 old backup \(the newest 2 are kept\)/.test(s.out), 5000);
    assert.deepEqual(fs.readdirSync(bk).filter(n => !/^family-backup-\d{8}-\d{6}\.tar\.gz$/.test(n)), [], 'no snapshot or partial file left');
    await post(s, f.owner, f.general, 'After the last one');
    r = cli('restore', path.join(bk, names[1]));
    assert.match(r.stderr, /Beam Family is running\. Stop it first/);
    await s.stop();
    r = cli('restore', path.join(bk, names[1]));
    assert.match(r.stderr, /already holds Beam Family data\. Use --force/);
    r = cli('restore', path.join(bk, names[1]), '--force');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Restored \d+ files into .* from the backup of .*; what was there is in .*replaced-/);
    s = await start('backup', 8843, { env, keep: true });
    const bodies = (await call(s, 'GET', `/api/channels/${f.general}/messages`, f.owner)).json.messages.map(m => m.body);
    assert.ok(bodies.includes('Before the backups') && bodies.includes('Between them') && !bodies.includes('After the last one'), `as it was at that backup: ${bodies}`);
    r = cli('restore', path.join(bk, 'nope.tar.gz'));
    assert.notEqual(r.status, 0, 'a backup that isn’t there: nothing happens');
  } finally { await s.stop(); }
});

test('F-N (1.8.3): the sender can drop an upload at once (the ×, Cancel on a message still sending): only their own, only while it isn’t sent; what came goes with it', async () => {
  const s = await start('cancel', 8847);
  try {
    const f = await family(s);
    const mary = await join(s, f.owner, 'Mary');
    const piece = crypto.randomBytes(200_000);
    const id = (await call(s, 'POST', '/api/uploads', mary.who, { name: 'movie.mp4', size: piece.length * 3, mime: 'video/mp4' })).json.id;
    let r = await s.req('PUT', `/api/uploads/${id}?offset=0`, { headers: { ...as(mary.who), 'Content-Type': 'application/octet-stream' }, body: piece });
    assert.deepEqual(r.json, { offset: piece.length, done: false });
    const part = path.join(s.data, 'uploads', `${id}.part`);
    assert.ok(fs.existsSync(part));
    assert.equal((await call(s, 'DELETE', `/api/uploads/${id}`, f.owner)).status, 404, 'not someone else’s');
    assert.equal((await call(s, 'DELETE', `/api/uploads/${id}`, mary.who)).status, 204);
    assert.equal((await call(s, 'GET', `/api/uploads/${id}`, mary.who)).status, 404);
    // (a small piece: the 404 comes before a big body is read, and the connection may be cut instead)
    r = await s.req('PUT', `/api/uploads/${id}?offset=${piece.length}`, { headers: { ...as(mary.who), 'Content-Type': 'application/octet-stream' }, body: piece.subarray(0, 16) });
    assert.equal(r.status, 404, 'nothing more goes to it');
    await waitFor(() => !fs.existsSync(part));
    assert.equal((await call(s, 'POST', `/api/channels/${f.general}/messages`, mary.who, { files: [id] })).status, 400, 'and it can’t be sent');
    // A file already sent: its message is deleted instead.
    const sent = (await call(s, 'POST', '/api/uploads', mary.who, { name: 'note.txt', size: 3 })).json.id;
    await s.req('PUT', `/api/uploads/${sent}?offset=0`, { headers: { ...as(mary.who), 'Content-Type': 'application/octet-stream' }, body: 'abc' });
    assert.equal((await call(s, 'POST', `/api/channels/${f.general}/messages`, mary.who, { files: [sent] })).status, 201);
    assert.equal((await call(s, 'DELETE', `/api/uploads/${sent}`, mary.who)).status, 409);
    assert.equal((await call(s, 'GET', `/api/files/${sent}`, f.owner)).status, 200, 'still there');
  } finally { await s.stop(); }
});

test('F-O (1.8.4): a page opened again finds the files it left unsent (only one’s own, only unsent, how far each got)', async () => {
  const s = await start('unsent', 8847);
  try {
    const f = await family(s);
    const mary = await join(s, f.owner, 'Mary');
    const piece = crypto.randomBytes(100_000);
    const half = (await call(s, 'POST', '/api/uploads', mary.who, { name: 'clip.mp4', size: piece.length * 2, mime: 'video/mp4' })).json.id;
    await s.req('PUT', `/api/uploads/${half}?offset=0`, { headers: { ...as(mary.who), 'Content-Type': 'application/octet-stream' }, body: piece });
    const whole = (await call(s, 'POST', '/api/uploads', mary.who, { name: 'note.txt', size: 3 })).json.id;
    await s.req('PUT', `/api/uploads/${whole}?offset=0`, { headers: { ...as(mary.who), 'Content-Type': 'application/octet-stream' }, body: 'abc' });
    const sent = (await call(s, 'POST', '/api/uploads', mary.who, { name: 'sent.txt', size: 3 })).json.id;
    await s.req('PUT', `/api/uploads/${sent}?offset=0`, { headers: { ...as(mary.who), 'Content-Type': 'application/octet-stream' }, body: 'xyz' });
    await call(s, 'POST', `/api/channels/${f.general}/messages`, mary.who, { files: [sent] });
    await call(s, 'POST', '/api/uploads', f.owner, { name: 'owners.bin', size: 10 });
    const r = await call(s, 'GET', '/api/uploads', mary.who);
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(r.json.uploads.map(u => [u.id, u.name, u.size, u.received]).sort((a, b) => a[1].localeCompare(b[1])),
      [[half, 'clip.mp4', piece.length * 2, piece.length], [whole, 'note.txt', 3, 3]]);
    assert.equal((await s.req('GET', '/api/uploads')).status, 401);
  } finally { await s.stop(); }
});

// (1.9.0) A direct connection the way a browser makes one (node-datachannel standing in for it): the offer with its
// candidates to POST /api/direct, the answer back, then a data channel per transfer.
async function directConnect(srv, who, route = '/api/direct') {
  const ndc = require('node-datachannel');
  const pc = new ndc.PeerConnection('test', { iceServers: [] });
  const keep = new Set(); // (an unreferenced channel is closed when it's garbage-collected)
  const ctl = pc.createDataChannel('beam');
  keep.add(ctl);
  await new Promise(r => { pc.onGatheringStateChange(st => { if (st === 'complete') r(); }); setTimeout(r, 3000); });
  const r = await call(srv, 'POST', route, who, { sdp: pc.localDescription().sdp });
  if (r.status !== 200) { pc.close(); return { status: r.status, error: r.json?.error }; }
  pc.setRemoteDescription(r.json.sdp, 'answer');
  await new Promise((res, rej) => { if (ctl.isOpen()) res(); ctl.onOpen(res); setTimeout(() => rej(new Error('no direct connection came up')), 10000); });
  const channel = label => { const dc = pc.createDataChannel(JSON.stringify(label)); keep.add(dc); return dc; };
  const answerOf = (dc, onBinary) => new Promise((res, rej) => {
    dc.onMessage(m => {
      if (typeof m !== 'string') return onBinary?.(Buffer.from(m));
      const j = JSON.parse(m);
      if (j.error) { rej(Object.assign(new Error(j.error), { answer: j })); dc.close(); } else if (j.done || j.offset !== undefined) { res(j); if (j.done) dc.close(); }
    });
  });
  return {
    status: 200, pc, answer: r.json.sdp,
    get: async (file, offset = 0) => {
      const parts = [];
      const dc = channel({ op: 'get', file, offset });
      await answerOf(dc, b => parts.push(b));
      return Buffer.concat(parts);
    },
    put: (upload, offset, data) => {
      const dc = channel({ op: 'put', upload, offset });
      const answered = answerOf(dc);
      dc.onOpen(() => { for (let i = 0; i < data.length; i += 65536) dc.sendMessageBinary(data.subarray(i, i + 65536)); });
      // (an {offset} on the way is progress, and the answer we want is the last one)
      return new Promise((res, rej) => {
        dc.onMessage(m => {
          if (typeof m !== 'string') return;
          const j = JSON.parse(m);
          if (j.error) rej(new Error(j.error)); else if (j.done) { res(j); dc.close(); } else if (j.offset !== undefined && !data.length) res(j);
        });
        answered.catch(rej);
      });
    },
    close: () => { for (const dc of keep) { try { dc.close(); } catch {} } pc.close(); },
  };
}

test('F-P (1.9.0): direct connections: a file comes over a data channel (from any offset), an upload goes up one; only what the person may see; none without a sign-in', async () => {
  const s = await start('direct', 8846, { env: { BEAM_FAMILY_STUN: 'local' } });
  const conns = [];
  try {
    const f = await family(s);
    const mary = await join(s, f.owner, 'Mary');
    const data = crypto.randomBytes(3 * 1024 * 1024 + 123);
    const id = (await call(s, 'POST', '/api/uploads', mary.who, { name: 'clip.bin', size: data.length })).json.id;
    for (let o = 0; o < data.length; o += 1024 * 1024) {
      await s.req('PUT', `/api/uploads/${id}?offset=${o}`, { headers: { ...as(mary.who), 'Content-Type': 'application/octet-stream' }, body: data.subarray(o, o + 1024 * 1024) });
    }
    await call(s, 'POST', `/api/channels/${f.general}/messages`, mary.who, { files: [id] });
    const conn = await directConnect(s, f.owner);
    conns.push(conn);
    assert.equal(conn.status, 200, conn.error);
    assert.ok((await conn.get(id)).equals(data), 'the whole file');
    assert.ok((await conn.get(id, 1_000_000)).equals(data.subarray(1_000_000)), 'from an offset');
    // An upload over the connection: the same writer as https pieces.
    const big = crypto.randomBytes(5 * 1024 * 1024 + 7);
    const up = (await call(s, 'POST', '/api/uploads', f.owner, { name: 'up.bin', size: big.length })).json.id;
    assert.deepEqual(await conn.put(up, 0, big), { done: true });
    const back = await s.req('GET', `/api/files/${up}`, { headers: as(f.owner), raw: true });
    assert.ok(back.body.equals(big), 'what went up is the file');
    // Only what this person may see; another's unsent upload is nobody else's.
    const hers = (await call(s, 'POST', '/api/uploads', mary.who, { name: 'x.bin', size: 10 })).json.id;
    await assert.rejects(conn.get(hers), /Not found/);
    await assert.rejects(conn.put(hers, 0, Buffer.alloc(10)), /No such upload/);
    // No direct connection without a sign-in.
    assert.equal((await call(s, 'POST', '/api/direct', {}, { sdp: conn.answer })).status, 401);
  } finally {
    for (const c of conns) c.close?.();
    await s.stop();
  }
});

test('F-Q (1.9.0): fast links: anyone with the link gets the file, no sign-in, over https or a direct connection, also while it still uploads; only that file; switched off: gone; guessing is slowed', async () => {
  const s = await start('links', 8845, { env: { BEAM_FAMILY_STUN: 'local', BEAM_FAMILY_URL: 'https://family.example.ts.net:8443' } });
  const conns = [];
  try {
    const f = await family(s);
    const mary = await join(s, f.owner, 'Mary');
    const putAll = async (id, data, from = 0, piece = 1024 * 1024) => {
      for (let o = from; o < data.length; o += piece) {
        await s.req('PUT', `/api/uploads/${id}?offset=${o}`, { headers: { ...as(mary.who), 'Content-Type': 'application/octet-stream' }, body: data.subarray(o, o + piece) });
      }
    };
    const data = crypto.randomBytes(2 * 1024 * 1024 + 99);
    const id = (await call(s, 'POST', '/api/uploads', mary.who, { name: 'holiday.mp4', size: data.length, mime: 'video/mp4' })).json.id;
    await putAll(id, data);
    await call(s, 'POST', `/api/channels/${f.general}/messages`, mary.who, { files: [id] });
    // A file already in the chat: anyone in the conversation may link it.
    assert.equal((await call(s, 'POST', `/api/files/${id}/links`, mary.who, { hours: 0 })).status, 400, 'at least an hour');
    let r = await call(s, 'POST', `/api/files/${id}/links`, f.owner, { hours: 24 });
    assert.equal(r.status, 201, r.body);
    const link = r.json.link;
    assert.match(link.url, /^https:\/\/family\.example\.ts\.net:8443\/f\/[A-Za-z0-9_-]{32}$/);
    const token = link.url.split('/f/')[1];
    assert.ok(!fs.readFileSync(path.join(s.data, 'family.db')).includes(token), 'only its hash is kept');
    // The page and what it shows, without a sign-in.
    const page = await s.req('GET', `/f/${token}`);
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>A file for you/);
    r = await s.req('GET', `/api/links/${token}`);
    assert.equal(r.status, 200, r.body);
    assert.deepEqual([r.json.name, r.json.size, r.json.received, r.json.from, r.json.direct], ['holiday.mp4', data.length, data.length, 'Robin', { stun: [] }]);
    // Over https: an attachment, sandboxed; a part of it too.
    r = await s.req('GET', `/api/links/${token}/file`, { raw: true });
    assert.ok(r.body.equals(data), 'the file over https');
    assert.match(r.headers['content-disposition'], /^attachment;/);
    assert.match(r.headers['content-security-policy'], /sandbox/);
    r = await s.req('GET', `/api/links/${token}/file`, { headers: { Range: 'bytes=1000-' }, raw: true });
    assert.equal(r.status, 206);
    assert.ok(r.body.equals(data.subarray(1000)));
    // Over a direct connection: that file only, and nothing goes up.
    const conn = await directConnect(s, {}, `/api/links/${token}/direct`);
    conns.push(conn);
    assert.equal(conn.status, 200, conn.error);
    assert.ok((await conn.get(null)).equals(data), 'the file over a direct connection');
    const other = (await call(s, 'POST', '/api/uploads', mary.who, { name: 'other.txt', size: 3 })).json.id;
    await putAll(other, Buffer.from('abc'));
    await call(s, 'POST', `/api/channels/${f.general}/messages`, mary.who, { files: [other] });
    await assert.rejects(conn.get(other), /Not found/);
    await assert.rejects(conn.put(other, 0, Buffer.from('abc')), /Not a request/);
    // A file still on its way: linked at once by the one uploading it, and the link follows it as it comes.
    const later = crypto.randomBytes(3 * 1024 * 1024 + 5);
    const up = (await call(s, 'POST', '/api/uploads', mary.who, { name: 'big.mov', size: later.length })).json.id;
    await putAll(up, later.subarray(0, 1024 * 1024));
    assert.equal((await call(s, 'POST', `/api/files/${up}/links`, f.owner, { hours: 1 })).status, 404, 'not someone else’s upload');
    r = await call(s, 'POST', `/api/files/${up}/links`, mary.who, { hours: 1 });
    const token2 = r.json.link.url.split('/f/')[1];
    assert.equal((await s.req('GET', `/api/links/${token2}`)).json.received, 1024 * 1024);
    const following = s.req('GET', `/api/links/${token2}/file`, { raw: true });
    const viaDirect = conn.get; // (the visitor's connection is bound to the first link: the second gets its own)
    const conn2 = await directConnect(s, {}, `/api/links/${token2}/direct`);
    conns.push(conn2);
    const followingDirect = conn2.get(null);
    await new Promise(r2 => setTimeout(r2, 400));
    await putAll(up, later, 1024 * 1024, 512 * 1024);
    assert.ok((await following).body.equals(later), 'https followed the upload to its end');
    assert.ok((await followingDirect).equals(later), 'so did the direct connection');
    assert.ok(viaDirect);
    // The list, and switching it off: gone for the page, the file and new connections.
    r = await call(s, 'GET', `/api/files/${id}/links`, f.owner);
    assert.deepEqual(r.json.links.map(l => [l.id, l.downloads >= 2]), [[link.id, true]]);
    assert.equal((await call(s, 'DELETE', `/api/links/${link.id}`, mary.who)).status, 404, 'only whoever made it (or an admin)');
    assert.equal((await call(s, 'DELETE', `/api/links/${link.id}`, f.owner)).status, 204);
    for (const p of [`/api/links/${token}`, `/api/links/${token}/file`]) assert.equal((await s.req('GET', p)).status, 404, p);
    assert.equal((await call(s, 'POST', `/api/links/${token}/direct`, {}, { sdp: conn.answer })).status, 404);
    // Guessing at links: slowed after 30 wrong ones a minute.
    let last = 0;
    for (let i = 0; i < 32; i++) last = (await s.req('GET', `/api/links/${crypto.randomBytes(24).toString('base64url')}`)).status;
    assert.equal(last, 429);
  } finally {
    for (const c of conns) c.close?.();
    await s.stop();
  }
});

test('F-R (1.10.0): videos that play everywhere: a phone\'s HDR video gets an H.264 copy in standard color, played in the chat and from a fast link (and kept with ?download); an ordinary one plays as it is; deleting the message deletes the copy', async () => {
  if (!FFMPEG) { console.log('    (no ffmpeg here: set BEAM_TEST_FFMPEG to run F-R)'); return; }
  const s = await start('media', 8846, { env: { BEAM_FAMILY_FFMPEG: FFMPEG } });
  try {
    const f = await family(s);
    // A phone's HDR video (10-bit HEVC, HLG, BT.2020; H.264 10-bit where this ffmpeg has no x265) and an ordinary one.
    const x265 = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true }).stdout.includes('libx265');
    const make = (file, args) => {
      const r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=2', '-f', 'lavfi', '-i', 'sine=d=2', ...args, '-c:a', 'aac', '-shortest', file], { encoding: 'utf8', windowsHide: true });
      assert.equal(r.status, 0, r.stderr);
      return fs.readFileSync(file);
    };
    // (the encoders' own settings: ffmpeg's -color_trc didn't reach x265's stream)
    const tags = 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc';
    const hdr = make(path.join(s.dir, 'hdr.mp4'), [...(x265 ? ['-c:v', 'libx265', '-tag:v', 'hvc1', '-x265-params', `log-level=error:${tags}`] : ['-c:v', 'libx264', '-x264-params', tags]), '-pix_fmt', 'yuv420p10le']);
    const plain = make(path.join(s.dir, 'plain.mp4'), ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', '400k', '-movflags', '+faststart']);
    const upload = async (name, data) => {
      const id = (await call(s, 'POST', '/api/uploads', f.owner, { name, size: data.length, mime: 'video/mp4' })).json.id;
      const r = await s.req('PUT', `/api/uploads/${id}?offset=0`, { headers: { ...as(f.owner), 'Content-Type': 'application/octet-stream' }, body: data });
      assert.ok(r.status < 300, r.body);
      return id;
    };
    const hdrId = await upload('Birthday.mp4', hdr);
    const plainId = await upload('plain.mp4', plain);
    const m = await post(s, f.owner, f.general, 'Videos', { files: [hdrId, plainId] });
    // Both settle (the HDR one is made in a moment; the ordinary one already plays everywhere).
    let files = [];
    for (let i = 0; i < 300; i++) {
      const list = (await call(s, 'GET', `/api/channels/${f.general}/messages`, f.owner)).json.messages;
      files = list.find(x => x.id === m.id).files;
      if (files.every(x => x.play && x.play !== 'working')) break;
      await sleep(200);
    }
    const [h, p] = [files.find(x => x.id === hdrId), files.find(x => x.id === plainId)];
    assert.deepEqual([h.play, h.playUrl, p.play, p.playUrl], ['ready', `/api/files/${hdrId}/play`, 'original', `/api/files/${plainId}/play`], s.out);
    assert.ok(h.playSize > 0);
    // The copy: H.264, 8-bit, standard color (BT.709), with sound; inline, seekable; only for who sees the message.
    let r = await s.req('GET', h.playUrl, { headers: as(f.owner), raw: true });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'video/mp4');
    assert.match(r.headers['content-disposition'], /^inline;/);
    const copy = path.join(s.dir, 'copy.mp4');
    fs.writeFileSync(copy, r.body);
    const probe = JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', copy], { encoding: 'utf8', windowsHide: true }).stdout).streams;
    const v = probe.find(x => x.codec_type === 'video');
    assert.deepEqual([v.codec_name, v.pix_fmt, v.color_transfer, v.width, v.height, probe.find(x => x.codec_type === 'audio')?.codec_name], ['h264', 'yuv420p', 'bt709', 360, 640, 'aac'], JSON.stringify([v.codec_name, v.pix_fmt, v.color_transfer, v.width, v.height]));
    r = await s.req('GET', h.playUrl, { headers: { ...as(f.owner), Range: 'bytes=0-99' }, raw: true });
    assert.deepEqual([r.status, r.body.length], [206, 100]);
    r = await s.req('GET', p.playUrl, { headers: as(f.owner), raw: true });
    assert.ok(r.body.equals(plain), 'the ordinary one as it is');
    assert.equal((await s.req('GET', h.playUrl)).status, 401, 'not without a sign-in');
    assert.match(s.out + fs.readFileSync(path.join(s.data, 'logs', 'family.log'), 'utf8'), /Made a version of Birthday\.mp4 that plays everywhere/);
    // A fast link to it: the page can play it and keep it.
    const token = (await call(s, 'POST', `/api/files/${hdrId}/links`, f.owner, { hours: 1 })).json.link.url.split('/f/')[1];
    r = await s.req('GET', `/api/links/${token}`);
    assert.deepEqual([r.json.video, r.json.play, r.json.playUrl, r.json.playSize], [true, 'ready', `/api/links/${token}/play`, h.playSize]);
    r = await s.req('GET', `/api/links/${token}/play?download`, { raw: true });
    assert.equal(r.status, 200);
    assert.ok(r.body.equals(fs.readFileSync(copy)), 'the same copy');
    assert.match(r.headers['content-disposition'], /^attachment;.*Birthday \(plays everywhere\)\.mp4/);
    // The message deleted: the copy goes too.
    assert.ok(fs.existsSync(path.join(s.data, 'play', `${hdrId}.mp4`)));
    assert.equal((await call(s, 'DELETE', `/api/messages/${m.id}`, f.owner)).status, 204);
    for (let i = 0; i < 20 && fs.existsSync(path.join(s.data, 'play', `${hdrId}.mp4`)); i++) await sleep(100);
    assert.ok(!fs.existsSync(path.join(s.data, 'play', `${hdrId}.mp4`)), 'the copy is gone');
  } finally { await s.stop(); }
});

test('F-S (1.11.0): a conversation\'s photos, videos and files for the gallery: newest first, page by page, the other files apart; not a deleted message\'s; only for who sees the conversation', async () => {
  const s = await start('gallery', 8847);
  try {
    const f = await family(s);
    const mary = await join(s, f.owner, 'Mary');
    const upload = async (who, name, mime) => {
      const data = Buffer.from(`${name} ${'x'.repeat(100)}`);
      const id = (await call(s, 'POST', '/api/uploads', who, { name, size: data.length, mime })).json.id;
      await s.req('PUT', `/api/uploads/${id}?offset=0`, { headers: { ...as(who), 'Content-Type': 'application/octet-stream' }, body: data });
      return id;
    };
    const one = await post(s, f.owner, f.general, 'Beach', { files: [await upload(f.owner, 'beach.jpg', 'image/jpeg'), await upload(f.owner, 'notes.pdf', 'application/pdf')] });
    const two = await post(s, mary.who, f.general, 'Party', { files: [await upload(mary.who, 'party.mp4', 'video/mp4')] });
    const three = await post(s, f.owner, f.general, 'Sunset', { files: [await upload(f.owner, 'sunset.png', 'image/png')] });
    const gone = await post(s, f.owner, f.general, 'Oops', { files: [await upload(f.owner, 'oops.jpg', 'image/jpeg')] });
    assert.equal((await call(s, 'DELETE', `/api/messages/${gone.id}`, f.owner)).status, 204);
    // Photos and videos, newest first, with who sent each and when; a page at a time.
    let r = await call(s, 'GET', `/api/channels/${f.general}/files`, mary.who);
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(r.json.files.map(x => [x.name, x.message, x.author]), [['sunset.png', three.id, f.me.id], ['party.mp4', two.id, mary.id], ['beach.jpg', one.id, f.me.id]]);
    assert.ok(r.json.files.every(x => x.at > 0 && x.url === `/api/files/${x.id}`));
    assert.equal(r.json.next, null);
    r = await call(s, 'GET', `/api/channels/${f.general}/files?limit=2`, mary.who);
    assert.deepEqual([r.json.files.map(x => x.name), Boolean(r.json.next)], [['sunset.png', 'party.mp4'], true]);
    r = await call(s, 'GET', `/api/channels/${f.general}/files?limit=2&before=${r.json.next}`, mary.who);
    assert.deepEqual([r.json.files.map(x => x.name), r.json.next], [['beach.jpg'], null]);
    assert.equal((await call(s, 'GET', `/api/channels/${f.general}/files?before=nonsense`, mary.who)).status, 400);
    // The other files.
    r = await call(s, 'GET', `/api/channels/${f.general}/files?kind=other`, mary.who);
    assert.deepEqual(r.json.files.map(x => x.name), ['notes.pdf']);
    // A direct message's files: only for the two in it.
    const dm = (await call(s, 'POST', '/api/dms', f.owner, { people: [mary.id] })).json.channel.id;
    await post(s, f.owner, dm, 'Just for you', { files: [await upload(f.owner, 'secret.jpg', 'image/jpeg')] });
    assert.deepEqual((await call(s, 'GET', `/api/channels/${dm}/files`, mary.who)).json.files.map(x => x.name), ['secret.jpg']);
    const bob = await join(s, f.owner, 'Bob');
    assert.equal((await call(s, 'GET', `/api/channels/${dm}/files`, bob.who)).status, 404, 'not for someone else');
    assert.equal((await call(s, 'GET', `/api/channels/${f.general}/files`)).status, 401, 'not without a sign-in');
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- runner

(async () => {
  const filters = process.argv.slice(2).map(s => s.toLowerCase());
  const chosen = tests.filter(t => !filters.length || filters.some(f => t.name.toLowerCase().includes(f)));
  let failed = 0;
  const started = Date.now();
  for (const t of chosen) {
    const t0 = Date.now();
    try {
      await t.fn();
      console.log(`ok    ${t.name} (${Date.now() - t0} ms)`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${t.name}\n      ${String(err.stack || err).split('\n').slice(0, 6).join('\n      ')}`);
    }
    for (const c of children) try { c.kill(); } catch {}
  }
  console.log(`\n${chosen.length - failed} passed, ${failed} failed (${Math.round((Date.now() - started) / 1000)} s)`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
