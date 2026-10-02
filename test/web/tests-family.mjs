// Beam Family's web app (family/public), against its own scratch server (family/server.js on 127.0.0.1:8828, data in
// a temp folder, Tailscale off). Tailscale's identity is sent the way tailscale serve sends it (an extra header, from
// this machine); the public link's people join with an invite and a password.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './cdp.mjs';
import { TMP } from './harness.mjs';
import { assert, eq } from './harness.mjs';

const PORT = 8828;
const OWNER = 'owner@example.com';

async function familyServer(ctx) {
  const data = path.join(TMP, `family-${Date.now()}`);
  fs.mkdirSync(data, { recursive: true });
  const base = `http://127.0.0.1:${PORT}`;
  const busy = await fetch(`${base}/api/hello`).then(() => true, () => false);
  if (busy) throw new Error(`port ${PORT} is already in use`);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BEAM_'))), BEAM_FAMILY_DATA: data, BEAM_FAMILY_PORT: String(PORT),
    BEAM_FAMILY_HOST: '127.0.0.1', BEAM_TAILSCALE: 'off', BEAM_FAMILY_OWNER: OWNER, BEAM_FAMILY_POSTS_PER_10S: '200' };
  const server = path.join(ctx.ROOT, 'family', 'server.js');
  const child = spawn(process.execPath, [server], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/hello`)).ok) break; } catch {}
    await sleep(100);
  }
  const srv = {
    base, data, get log() { return log; },
    stop: async () => { child.kill(); await new Promise(r => { child.once('exit', r); setTimeout(r, 3000); }); },
    // The API as someone (Tailscale login or a cookie).
    call: async (who, method, p, body) => {
      const headers = { ...(who.login ? { 'Tailscale-User-Login': who.login, 'Tailscale-User-Name': who.name || '', 'X-Forwarded-For': '100.64.7.7' } : { Cookie: who.cookie }), ...(body ? { 'Content-Type': 'application/json' } : {}) };
      const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, json, cookie: res.headers.get('set-cookie')?.split(';')[0] };
    },
  };
  ctx.defer(() => srv.stop());
  return srv;
}

const owner = { login: OWNER, name: 'Robin' };

// A page signed in by Tailscale (the headers tailscale serve adds: the identity, and the caller's Tailscale address).
async function tailscalePage(ctx, login, name, opts = {}) {
  const page = await ctx.browser.newPage(opts);
  await page.send('Network.setExtraHTTPHeaders', { headers: { 'Tailscale-User-Login': login, 'Tailscale-User-Name': name, 'X-Forwarded-For': '100.64.7.8' } });
  return page;
}

const send = (page, text) => page.evaluate(`(async () => {
  const t = document.querySelector('.composer textarea');
  t.value = ${JSON.stringify(text)};
  t.dispatchEvent(new Event('input'));
  document.querySelector('.send-btn').click();
  return true;
})()`);

export default function register(test) {
  test('family: the owner by Tailscale, someone joining by invite + password; messages, mentions, unread, replies and reactions arrive live', async ctx => {
    const srv = await familyServer(ctx);
    const robin = await tailscalePage(ctx, OWNER, 'Robin');
    await robin.goto(`${srv.base}/`);
    await robin.waitFor(`location.pathname.startsWith('/c/') && document.querySelector('.composer textarea') !== null`, 10000, 'the owner in #general');
    eq(await robin.evaluate(`[document.querySelector('.side-head h1').textContent, [...document.querySelectorAll('.side-list .chan')].map(a => a.textContent.trim())]`),
      ['Family', ['general', 'photos']], 'the family space and its channels');
    // An invite from the admin page, opened in another browser.
    await robin.evaluate(`history.pushState({}, '', '/admin'); dispatchEvent(new PopStateEvent('popstate')); true`);
    await robin.waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('Make an invite link'))`);
    await robin.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Make an invite link')).click(); true`);
    await robin.waitFor(`Boolean(document.querySelector('.invite-link code')?.textContent)`, 5000, 'the invite link');
    const link = await robin.evaluate(`document.querySelector('.invite-link code').textContent`);
    assert(await robin.evaluate(`Boolean(document.querySelector('img.qr'))`), 'a QR code');
    assert(link.startsWith(`${srv.base}/join/`), link);
    const mary = await ctx.browser.newPage({});
    await mary.goto(link);
    await mary.waitFor(`document.querySelector('form [name=name]') !== null`, 10000, 'the join page');
    assert(/Robin invited you to Family/.test(await mary.evaluate('document.body.innerText')), 'says who invited');
    await mary.evaluate(`(() => { const f = document.querySelector('form'); f.name.value = 'Mary'; f.password.value = 'a long family password'; f.password2.value = 'a long family password!'; f.requestSubmit(); return true; })()`);
    await mary.waitFor(`/aren’t the same/.test(document.querySelector('.error-text').textContent)`, 3000, 'passwords must match');
    await mary.evaluate(`(() => { const f = document.querySelector('form'); f.password2.value = 'a long family password'; f.requestSubmit(); return true; })()`);
    await mary.waitFor(`location.pathname.startsWith('/c/') && document.querySelector('.composer textarea') !== null`, 10000, 'Mary in #general');
    // Robin back in #general sees Mary's join line, then her message with a mention: highlighted.
    await robin.evaluate(`[...document.querySelectorAll('.side-list .chan')].find(a => a.textContent.includes('general')).click(); true`);
    await robin.waitFor(`/Mary joined the family space/.test(document.querySelector('.messages').innerText)`, 5000, 'the join line, live');
    await send(mary, 'Hi @Robin! Look **at this**');
    await robin.waitFor(`document.querySelector('.msg.mentioned .mention-chip.me')?.textContent === '@Robin'`, 5000, 'the mention, live and highlighted');
    eq(await robin.evaluate(`document.querySelector('.msg.mentioned strong:not(.mention-chip)')?.textContent`), 'Mary', 'by Mary');
    // Read when it's on screen in front (a window in the background doesn't mark anything read).
    await ctx.setHidden(robin, false);
    try {
      await robin.waitFor(`[...document.querySelectorAll('.side-list .chan')].some(a => a.getAttribute('aria-label') === '#general')`, 5000, '#general read once Robin looks');
    } catch (err) {
      const l = await robin.evaluate(`(() => { const l = document.querySelector('.messages'); return JSON.stringify({ vis: document.visibilityState, scroll: [l.scrollHeight, l.scrollTop, l.clientHeight], labels: [...document.querySelectorAll('.side-list .chan')].map(a => a.getAttribute('aria-label')), path: location.pathname }); })()`);
      throw new Error(`${err.message} ${l}`);
    }
    // A DM from Mary: Robin sees the unread badge in the list, and the tab title counts it.
    await mary.evaluate(`(async () => { const r = await fetch('/api/bootstrap').then(r => r.json()); const j = r.people.find(p => p.name === 'Robin'); const dm = await fetch('/api/dms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ people: [j.id] }) }).then(r => r.json()); await fetch('/api/channels/' + dm.channel.id + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'Just for you' }) }); return true; })()`);
    await robin.waitFor(`[...document.querySelectorAll('.side-list .chan')].some(a => a.textContent.includes('Mary') && a.querySelector('.badge')?.textContent === '1')`, 5000, 'the DM badge');
    const jt = await robin.evaluate(`[document.title, JSON.stringify([...document.querySelectorAll('.side-list .chan')].map(a => a.getAttribute('aria-label')))]`);
    assert(/^\(1\)/.test(jt[0]), `the title counts it (${jt.join(' ')})`);
    // A reply with a reaction: Mary sees both live.
    await robin.evaluate(`document.querySelector('.msg.mentioned .tools button[aria-label="Reply"]').click(); true`);
    await robin.waitFor(`/Replying to Mary/.test(document.querySelector('.compose-bar').textContent)`);
    await send(robin, 'Wow!');
    try {
      await mary.waitFor(`[...document.querySelectorAll('.msg')].some(m => m.querySelector('.reply-to')?.textContent.includes('Look at this') && m.textContent.includes('Wow!'))`, 5000, 'the reply (formatting marks out of the preview)');
    } catch (err) {
      const seen = await mary.evaluate(`JSON.stringify([location.pathname, [...document.querySelectorAll('.msg')].map(m => m.textContent.slice(0, 90))])`);
      const sent = await robin.evaluate(`JSON.stringify([location.pathname, [...document.querySelectorAll('.msg')].slice(-2).map(m => m.className + ' ' + m.textContent.slice(0, 90)), document.querySelector('.composer textarea').value])`);
      throw new Error(`${err.message}
Mary sees ${seen}
Robin ${sent}`);
    }
    await robin.evaluate(`(async () => { const m = [...document.querySelectorAll('.msg')].find(m => m.textContent.includes('Look at this') && !m.querySelector('.reply-to')); const id = m.dataset.id; await fetch('/api/messages/' + id + '/reactions/' + encodeURIComponent('❤️'), { method: 'PUT' }); return true; })()`);
    await mary.waitFor(`[...document.querySelectorAll('.react')].some(b => b.textContent.includes('❤️') && b.textContent.includes('1'))`, 5000, 'the reaction, live');
    eq(robin.errors, [], 'no errors for Robin');
    eq(mary.errors, [], 'no errors for Mary');
  }, { timeout: 90000 });

  test('family: sign-in page (wrong password, then right), a stranger on Tailscale is told to ask for an invite, the owner turns someone off', async ctx => {
    const srv = await familyServer(ctx);
    await srv.call(owner, 'GET', '/api/session');
    const inv = await srv.call(owner, 'POST', '/api/invites', {});
    const join = await srv.call({ cookie: '' }, 'POST', `/api/invites/${inv.json.url.split('/join/')[1]}`, { name: 'Bob', password: 'bob family password' });
    eq(join.status, 201, 'Bob joined');
    const page = await ctx.browser.newPage({});
    await page.goto(`${srv.base}/`);
    await page.waitFor(`document.querySelector('form [name=password]') !== null`, 10000, 'the sign-in page');
    await page.evaluate(`(() => { const f = document.querySelector('form'); f.name.value = 'bob'; f.password.value = 'not it at all'; f.requestSubmit(); return true; })()`);
    await page.waitFor(`/don’t match/.test(document.querySelector('.error-text').textContent)`, 5000, 'a wrong password');
    await page.evaluate(`(() => { const f = document.querySelector('form'); f.password.value = 'bob family password'; f.requestSubmit(); return true; })()`);
    await page.waitFor(`document.querySelector('.composer textarea') !== null`, 10000, 'Bob is in');
    // A stranger on Tailscale.
    const stranger = await tailscalePage(ctx, 'cousin@example.com', 'Cousin Ed');
    await stranger.goto(`${srv.base}/`);
    await stranger.waitFor(`/You’re on Tailscale as cousin@example\\.com, but not in Family yet/.test(document.body.innerText)`, 10000, 'told to ask for an invite');
    // Turned off: Bob's open app ends up on a page saying so.
    const people = (await srv.call(owner, 'GET', '/api/bootstrap')).json.people;
    await srv.call(owner, 'PATCH', `/api/people/${people.find(p => p.name === 'Bob').id}`, { disabled: true });
    await page.waitFor(`document.querySelector('form [name=password]') !== null || /turned off/.test(document.body.innerText)`, 15000, 'Bob is out');
  }, { timeout: 90000, allowErrors: true });

  test('family: a photo dropped on a conversation is sent with its preview; the other person opens it in the viewer', async ctx => {
    const srv = await familyServer(ctx);
    const robin = await tailscalePage(ctx, OWNER, 'Robin');
    await robin.goto(`${srv.base}/`);
    await robin.waitFor(`document.querySelector('.composer textarea') !== null`, 10000, 'in #general');
    await robin.evaluate(`(async () => {
      const c = document.createElement('canvas'); c.width = 1600; c.height = 900;
      const g = c.getContext('2d'); g.fillStyle = '#3fa7d6'; g.fillRect(0, 0, 1600, 900);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
      const dt = new DataTransfer(); dt.items.add(new File([blob], 'sky.jpg', { type: 'image/jpeg' }));
      document.querySelector('section.main').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await robin.waitFor(`document.querySelector('.tray-item img') !== null`, 5000, 'the preview in the tray');
    await send(robin, 'The sky today');
    await robin.waitFor(`[...document.querySelectorAll('.msg')].some(m => !m.classList.contains('pending') && m.querySelector('.shot img')?.getAttribute('src')?.endsWith('/thumb'))`, 15000, 'sent, shown from its preview');
    const size = await robin.evaluate(`(() => { const i = [...document.querySelectorAll('.shot img')].at(-1); return [i.width, i.height]; })()`);
    eq(size, [420, 236], 'laid out at its own proportions before it loads');
    // Bob (a cookie) sees it and opens the viewer: the full picture.
    const bob = await ctx.browser.newPage({});
    const inv2 = await srv.call(owner, 'POST', '/api/invites', {});
    await bob.goto(inv2.json.url);
    await bob.waitFor(`document.querySelector('form [name=name]') !== null`);
    await bob.evaluate(`(() => { const f = document.querySelector('form'); f.name.value = 'Bob'; f.password.value = 'bob family password'; f.password2.value = 'bob family password'; f.requestSubmit(); return true; })()`);
    await bob.waitFor(`document.querySelector('.shot') !== null`, 10000, 'Bob sees the photo');
    await bob.evaluate(`document.querySelector('.shot').click(); true`);
    await bob.waitFor(`document.querySelector('.viewer img')?.complete && document.querySelector('.viewer img').naturalWidth === 1600`, 10000, 'the full picture in the viewer');
    await bob.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await bob.waitFor(`document.querySelector('.viewer') === null`, 3000, 'Esc closes it');
  }, { timeout: 90000 });

  test('family: on a phone: the list, a conversation, back; nothing scrolls sideways', async ctx => {
    const srv = await familyServer(ctx);
    const page = await tailscalePage(ctx, OWNER, 'Robin', { width: 390, height: 844, mobile: true });
    await page.goto(`${srv.base}/`);
    await page.waitFor(`document.querySelector('.side-list .chan') !== null`, 10000, 'the list');
    eq(await page.evaluate(`[location.pathname, getComputedStyle(document.querySelector('.main')).display]`), ['/', 'none'], 'a phone starts at the list');
    await page.evaluate(`document.querySelector('.side-list .chan').click(); true`);
    await page.waitFor(`document.querySelector('.shell.in-conv') !== null && getComputedStyle(document.querySelector('.side')).display === 'none'`, 5000, 'the conversation, full screen');
    await send(page, 'From my phone '.repeat(12) + 'https://example.com/a/very/long/link/that/should/wrap/rather/than/scroll/sideways/at/all');
    await page.waitFor(`[...document.querySelectorAll('.msg')].some(m => /From my phone/.test(m.textContent) && !m.classList.contains('pending'))`, 5000, 'sent');
    eq(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.messages').scrollWidth <= document.querySelector('.messages').clientWidth`), true, 'no sideways scrolling');
    await page.evaluate(`document.querySelector('.conv-head .back').click(); true`);
    await page.waitFor(`location.pathname === '/' && getComputedStyle(document.querySelector('.side')).display !== 'none'`, 5000, 'back to the list');
  }, { timeout: 60000 });

  test('family: what people type stays text: markup and scripts never run, only http(s) links are links', async ctx => {
    const srv = await familyServer(ctx);
    const page = await tailscalePage(ctx, OWNER, 'Robin');
    await page.goto(`${srv.base}/`);
    await page.waitFor(`document.querySelector('.composer textarea') !== null`, 10000, 'in #general');
    await page.evaluate(`window.__pwned = 0; true`);
    const evil = '<img src=x onerror="window.__pwned=1"> <script>window.__pwned=2</script> javascript:window.__pwned=3 [x](javascript:alert(1)) **<b>bold</b>** https://example.com/"onmouseover="window.__pwned=4';
    await send(page, evil);
    await page.waitFor(`[...document.querySelectorAll('.msg-body')].some(b => b.textContent.includes('<img src=x'))`, 5000, 'shown as text');
    eq(await page.evaluate(`[window.__pwned, document.querySelectorAll('.msg-body img, .msg-body script, .msg-body b').length]`), [0, 0], 'nothing ran, no elements made from it');
    const links = await page.evaluate(`[...document.querySelectorAll('.msg-body a')].map(a => [a.getAttribute('href'), a.target, a.rel])`);
    eq(links, [['https://example.com/', '_blank', 'noopener noreferrer']], 'one link, to https, opened safely; the quote ends it');
  }, { timeout: 60000 });
}

// The personal Beam's web app links to Beam Family when its .env says where it is (BEAM_FAMILY_URL).
export function registerLink(test) {
  test('family: the personal Beam shows a "Beam Family" link when BEAM_FAMILY_URL is set (and none when not)', async ctx => {
    const beam = await ctx.startServer(8823, { BEAM_FAMILY_URL: 'https://desk.example.ts.net:8443/' });
    ctx.defer(() => beam.stop());
    const info = await (await fetch(`${beam.base}/api/info`, { headers: { Authorization: `Bearer ${beam.key}` } })).json();
    eq(info.family, 'https://desk.example.ts.net:8443', 'in /api/info, without the trailing slash');
    const page = await ctx.signedIn({ server: beam });
    await page.waitFor(`!document.getElementById('familyLink').hidden`, 10000, 'the link');
    eq(await page.evaluate(`[document.getElementById('familyLink').href, document.getElementById('familyLink').target, document.getElementById('familyLink').rel]`),
      ['https://desk.example.ts.net:8443/', '_blank', 'noopener noreferrer'], 'opens Beam Family in a new tab');
    const plain = await ctx.signedIn();
    await plain.waitFor(`typeof server !== 'undefined' && Boolean(server.info)`, 10000, 'info loaded');
    eq(await plain.evaluate(`document.getElementById('familyLink').hidden`), true, 'no link without the setting');
  }, { timeout: 60000 });
}
