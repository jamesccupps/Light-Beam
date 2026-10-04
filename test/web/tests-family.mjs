// Beam Family's web app (family/public), against its own scratch server (family/server.js on 127.0.0.1:8828, data in
// a temp folder, Tailscale off). Tailscale's identity is sent the way tailscale serve sends it (an extra header, from
// this machine); the public link's people join with an invite and a password.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './cdp.mjs';
import { TMP } from './harness.mjs';
import { dev } from './tests-core.mjs';
import { assert, eq } from './harness.mjs';

const PORT = 8828;
const OWNER = 'owner@example.com';

async function familyServer(ctx, extra = {}) {
  const data = path.join(TMP, `family-${Date.now()}`);
  fs.mkdirSync(data, { recursive: true });
  const base = `http://127.0.0.1:${PORT}`;
  const busy = await fetch(`${base}/api/hello`).then(() => true, () => false);
  if (busy) throw new Error(`port ${PORT} is already in use`);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BEAM_'))), BEAM_FAMILY_DATA: data, BEAM_FAMILY_PORT: String(PORT),
    BEAM_FAMILY_HOST: '127.0.0.1', BEAM_TAILSCALE: 'off', BEAM_FAMILY_OWNER: OWNER, BEAM_FAMILY_POSTS_PER_10S: '200',
    // (1.9.0) no direct connections unless a test asks (then 'local': no STUN servers out there either)
    BEAM_FAMILY_STUN: 'off',
    // (1.10.0) no ffmpeg unless a test asks
    BEAM_FAMILY_FFMPEG: 'off' };
  const server = path.join(ctx.ROOT, 'family', 'server.js');
  let child = null;
  let log = '';
  const run = async (more = {}) => {
    child = spawn(process.execPath, [server], { env: { ...env, ...more }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/api/hello`)).ok) break; } catch {}
      await sleep(100);
    }
  };
  await run(extra);
  const stop = async () => { const c = child; c.kill(); await new Promise(r => { c.once('exit', r); setTimeout(r, 3000); }); };
  const srv = {
    base, data, get log() { return log; },
    stop,
    // The same data, started again (with these settings too).
    restart: async more => { await stop(); await run(more); },
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

// (1.10.0) ffmpeg for the "plays everywhere" test: BEAM_TEST_FFMPEG, else ffmpeg on the PATH; without one it says so.
const FFMPEG = (() => {
  if (process.env.BEAM_TEST_FFMPEG) return fs.existsSync(process.env.BEAM_TEST_FFMPEG) ? process.env.BEAM_TEST_FFMPEG : null;
  return spawnSync('ffmpeg', ['-hide_banner', '-version'], { windowsHide: true }).status === 0 ? 'ffmpeg' : null;
})();

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

  test('family: a big file still sending shows how far it is; Cancel stops it and the server drops it, and so does the ×  in the tray (1.8.3)', async ctx => {
    const srv = await familyServer(ctx);
    const robin = await tailscalePage(ctx, OWNER, 'Robin');
    await robin.goto(`${srv.base}/`);
    await robin.waitFor(`document.querySelector('.composer textarea') !== null`, 10000, 'in #general');
    // A slow connection up (1 MB/s), so the 24 MB file takes a while.
    await robin.send('Network.enable', {});
    await robin.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 50 * 1024 * 1024, uploadThroughput: 1024 * 1024 });
    const drop = name => robin.evaluate(`(() => {
      const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(24 * 1024 * 1024)], ${JSON.stringify(name)}, { type: 'application/octet-stream' }));
      document.querySelector('section.main').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return true;
    })()`);
    const parts = () => fs.readdirSync(path.join(srv.data, 'uploads')).filter(f => f.endsWith('.part'));
    const until = async (what, ok) => { for (let i = 0; i < 100 && !ok(); i++) await sleep(100); assert(ok(), what); };
    await drop('movie.bin');
    await robin.waitFor(`document.querySelector('.tray-item') !== null`, 5000, 'in the tray');
    await send(robin, 'A big one');
    await robin.waitFor(`/Sending [0-9.]+ [KM]?B of 24 MB \\(\\d+%\\)/.test(document.querySelector('.msg.pending .sending')?.textContent || '')`, 15000, 'how far it is, on the message');
    await until('its upload on the server', () => parts().length === 1);
    await robin.evaluate(`[...document.querySelectorAll('.msg.pending .sending a')].find(a => a.textContent === 'Cancel').click(); true`);
    await robin.waitFor(`document.querySelector('.msg.pending') === null`, 5000, 'the message is gone');
    // (cancelled at once: before the app had heard the upload's id back, the race 1.8.3's first try lost)
    await until('the server dropped what came', () => parts().length === 0);
    // The tray's ×, before sending: the upload stops and goes too.
    await drop('second.bin');
    await until('uploading', () => parts().length === 1);
    await robin.evaluate(`document.querySelector('.tray-item .x').click(); true`);
    await until('the × dropped it on the server', () => parts().length === 0);
    await sleep(500);
    eq(await robin.evaluate(`[...document.querySelectorAll('.msg')].some(m => /A big one/.test(m.textContent))`), false, 'nothing was sent');
  }, { timeout: 90000 });

  test('family: a file whose sending stopped (no connection, or the phone paused the page) carries on by itself when the app is back in front, from where it got to (1.8.3)', async ctx => {
    const srv = await familyServer(ctx);
    const robin = await tailscalePage(ctx, OWNER, 'Robin');
    await robin.goto(`${srv.base}/`);
    await robin.waitFor(`document.querySelector('.composer textarea') !== null`, 10000, 'in #general');
    // The connection goes once the first 4 MB are there: every piece after it fails until it's back (the app tries again
    // for about a minute, then gives up). Every piece sent is noted.
    let away = true;
    const pieces = [];
    await robin.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/uploads/*', requestStage: 'Request' }] });
    const paused = m => {
      if (m.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = m.params;
      const offset = request.method === 'PUT' ? Number(new URL(request.url).searchParams.get('offset')) : null;
      if (offset !== null) pieces.push({ offset, away });
      if (away && offset) robin.send('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' }).catch(() => {});
      else robin.send('Fetch.continueRequest', { requestId }).catch(() => {});
    };
    robin.on(paused);
    ctx.defer(() => robin.off(paused));
    await robin.evaluate(`(() => {
      const bytes = new Uint8Array(8 * 1024 * 1024); for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 251;
      const dt = new DataTransfer(); dt.items.add(new File([bytes], 'clip.bin', { type: 'application/octet-stream' }));
      document.querySelector('section.main').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await robin.waitFor(`document.querySelector('.tray-item') !== null`, 5000, 'in the tray');
    await send(robin, 'A clip');
    await robin.waitFor(`/Sending 4 MB of 8 MB/.test(document.querySelector('.msg.pending .sending')?.textContent || '')`, 20000, 'half of it there, then stuck');
    await robin.waitFor(`/Not sent/.test(document.querySelector('.msg.pending')?.textContent || '')`, 90000, 'it stopped: Not sent');
    const part = fs.readdirSync(path.join(srv.data, 'uploads')).find(f => f.endsWith('.part'));
    eq((await srv.call(owner, 'GET', `/api/uploads/${part.replace('.part', '')}`)).json.offset, 4 * 1024 * 1024, 'the server has the first half');
    away = false;
    await robin.evaluate(`document.dispatchEvent(new Event('visibilitychange')); true`); // back in front
    await robin.waitFor(`[...document.querySelectorAll('.msg')].some(m => /A clip/.test(m.textContent) && !m.classList.contains('pending'))`, 20000, 'sent by itself');
    eq(pieces.find(p => !p.away)?.offset, 4 * 1024 * 1024, 'it went on from where it got to, not from the start');
    const files = fs.readdirSync(path.join(srv.data, 'files'));
    eq(files.map(f => fs.statSync(path.join(srv.data, 'files', f)).size), [8 * 1024 * 1024], 'the whole file, once');
  }, { timeout: 150000 });

  test('family: on a phone a tap on a message opens its menu (and press and hold still does), Delete there removes it; the same file can’t be attached twice (1.8.4)', async ctx => {
    const srv = await familyServer(ctx);
    const page = await tailscalePage(ctx, OWNER, 'Robin', { width: 390, height: 844, mobile: true });
    await page.goto(`${srv.base}/`);
    await page.waitFor(`document.querySelector('.side-list .chan') !== null`, 10000, 'the list');
    await page.evaluate(`document.querySelector('.side-list .chan').click(); true`);
    await page.waitFor(`document.querySelector('.composer textarea') !== null`, 5000, 'a conversation');
    await send(page, 'Oops, wrong chat');
    await page.waitFor(`[...document.querySelectorAll('.msg')].some(m => /Oops, wrong chat/.test(m.textContent) && !m.classList.contains('pending'))`, 5000, 'sent');
    const spot = await page.evaluate(`(() => { const r = [...document.querySelectorAll('.msg')].find(m => /Oops, wrong chat/.test(m.textContent)).querySelector('.msg-body').getBoundingClientRect(); return [r.left + 20, r.top + r.height / 2]; })()`);
    const touch = async holdMs => {
      await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: spot[0], y: spot[1] }] });
      await sleep(holdMs);
      await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    // Press and hold: the menu, still there once the finger is up.
    // (Lifting the finger lands a click on the scrim the menu put under it: that closed the menu at once before 1.8.4.)
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: spot[0], y: spot[1] }] });
    await sleep(700);
    const during = await page.evaluate(`Boolean(document.querySelector('.sheet'))`);
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(400);
    eq([during, await page.evaluate(`/Delete/.test(document.querySelector('.sheet')?.textContent || '')`)], [true, true], 'press and hold: the menu opens and stays');
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 120 }] }); // a tap beside it
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitFor(`document.querySelector('.sheet') === null`, 3000, 'a tap beside it closes it');
    // A tap: the menu too, with Delete.
    await touch(60);
    await page.waitFor(`/Delete/.test(document.querySelector('.sheet')?.textContent || '')`, 3000, 'a tap: the menu, with Delete');
    await page.evaluate(`[...document.querySelectorAll('.sheet button')].find(b => /Delete/.test(b.textContent)).click(); true`);
    await page.waitFor(`document.querySelector('dialog.dlg[open] button.danger') !== null`, 3000, 'asked first');
    await page.evaluate(`document.querySelector('dialog.dlg[open] button.danger').click(); true`);
    await page.waitFor(`![...document.querySelectorAll('.msg')].some(m => /Oops, wrong chat/.test(m.textContent))`, 5000, 'gone');
    // The same file twice: attached once.
    const drop = `(() => {
      const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(1000)], 'twice.bin', { type: 'application/octet-stream', lastModified: 7 }));
      document.querySelector('section.main').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return true;
    })()`;
    await page.evaluate(drop);
    await page.evaluate(drop);
    await sleep(300);
    eq(await page.evaluate(`document.querySelectorAll('.tray-item').length`), 1, 'one in the tray');
    eq(await page.evaluate(`/attached already/.test(document.body.textContent)`), true, 'and it says so');
  }, { timeout: 60000 });

  test('family: a file a closed or reloaded page left half sent: the app offers it, picking it again goes on from where it got to, and Discard drops another (1.8.4)', async ctx => {
    const srv = await familyServer(ctx);
    const robin = await tailscalePage(ctx, OWNER, 'Robin');
    await robin.goto(`${srv.base}/`);
    await robin.waitFor(`document.querySelector('.composer textarea') !== null`, 10000, 'in #general');
    // Pieces after the first 4 MB don't get through until the page is opened again (the phone dropped it halfway).
    let away = true;
    const pieces = [];
    await robin.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/uploads/*', requestStage: 'Request' }] });
    const paused = m => {
      if (m.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = m.params;
      const offset = request.method === 'PUT' ? Number(new URL(request.url).searchParams.get('offset')) : null;
      if (offset !== null) pieces.push({ offset, away });
      if (away && offset) robin.send('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' }).catch(() => {});
      else robin.send('Fetch.continueRequest', { requestId }).catch(() => {});
    };
    robin.on(paused);
    ctx.defer(() => robin.off(paused));
    const dropClip = `(() => {
      const bytes = new Uint8Array(8 * 1024 * 1024); for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 251;
      const dt = new DataTransfer(); dt.items.add(new File([bytes], 'clip.bin', { type: 'application/octet-stream', lastModified: 5 }));
      document.querySelector('section.main').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return true;
    })()`;
    await robin.evaluate(dropClip);
    await robin.waitFor(`document.querySelector('.tray-item') !== null`, 5000, 'in the tray');
    await send(robin, 'The clip');
    await robin.waitFor(`/Sending 4 MB of 8 MB/.test(document.querySelector('.msg.pending .sending')?.textContent || '')`, 20000, 'half of it there');
    await srv.call(owner, 'POST', '/api/uploads', { name: 'extra.bin', size: 10 }); // another one left behind
    // The page goes and is opened again: the message it showed is gone, the files are offered.
    away = false;
    await robin.goto(`${srv.base}/`);
    await robin.waitFor(`/clip\\.bin stopped at 4 MB of 8 MB/.test(document.querySelector('.unsent')?.textContent || '')`, 10000, 'offered: clip.bin, how far it got');
    eq(await robin.evaluate(`document.querySelectorAll('.unsent-row').length`), 2, 'and the other one');
    await robin.evaluate(`[...document.querySelectorAll('.unsent-row')].find(r => /extra\\.bin/.test(r.textContent)).querySelector('.ghost').click(); true`);
    await robin.waitFor(`document.querySelectorAll('.unsent-row').length === 1`, 3000, 'Discard: that one goes');
    // The same file again: it goes on from 4 MB, and is sent once.
    const before = pieces.length;
    await robin.evaluate(dropClip);
    await robin.waitFor(`document.querySelector('.unsent').hidden`, 3000, 'no longer offered');
    await send(robin, 'The clip, again');
    await robin.waitFor(`[...document.querySelectorAll('.msg')].some(m => /The clip, again/.test(m.textContent) && !m.classList.contains('pending'))`, 20000, 'sent');
    eq(pieces.slice(before)[0]?.offset, 4 * 1024 * 1024, 'it went on from where it got to');
    const files = fs.readdirSync(path.join(srv.data, 'files'));
    eq(files.map(f => fs.statSync(path.join(srv.data, 'files', f)).size), [8 * 1024 * 1024], 'the whole file, once');
    eq((await srv.call(owner, 'GET', '/api/uploads')).json.uploads, [], 'nothing left unsent');
  }, { timeout: 90000 });

  test('family: a message still sending says "Sending…" for its time, how far above its pictures (dimmed); a page meeting a newer Beam Family reloads itself, but only once nothing is being sent (1.8.5)', async ctx => {
    const srv = await familyServer(ctx);
    const robin = await tailscalePage(ctx, OWNER, 'Robin');
    await robin.goto(`${srv.base}/`);
    await robin.waitFor(`document.querySelector('.composer textarea') !== null`, 10000, 'in #general');
    // No piece gets through: it stays "sending".
    let away = true;
    let puts = 0;
    await robin.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/uploads/*', requestStage: 'Request' }] });
    const paused = m => {
      if (m.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = m.params;
      if (request.method === 'PUT') puts++;
      if (away && request.method === 'PUT') robin.send('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' }).catch(() => {});
      else robin.send('Fetch.continueRequest', { requestId }).catch(() => {});
    };
    robin.on(paused);
    ctx.defer(() => robin.off(paused));
    await robin.evaluate(`(async () => {
      const c = document.createElement('canvas'); c.width = 900; c.height = 1600;
      const g = c.getContext('2d'); g.fillStyle = '#c96'; g.fillRect(0, 0, 900, 1600);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
      const dt = new DataTransfer(); dt.items.add(new File([blob], 'tall.jpg', { type: 'image/jpeg' }));
      document.querySelector('section.main').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await robin.waitFor(`document.querySelector('.tray-item img') !== null`, 5000, 'in the tray');
    await send(robin, '');
    await robin.waitFor(`document.querySelector('.msg.pending .sending-label')?.textContent === 'Sending…'`, 5000, '"Sending…" where its time goes');
    eq(await robin.evaluate(`(() => { const m = document.querySelector('.msg.pending'); const s = m.querySelector('.sending'), f = m.querySelector('.files');
      return [Boolean(s && f && (s.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING)), getComputedStyle(f).opacity]; })()`), [true, '0.5'], 'how far, above the picture, which is dimmed');
    for (let i = 0; i < 150 && !puts; i++) await sleep(100);
    assert(puts > 0, 'its pieces are going (and not getting through)');
    // Beam Family is updated (the same data, a newer version): the page waits while something is being sent.
    await robin.evaluate(`window.__before = 1; true`);
    await srv.restart({ BEAM_FAMILY_VERSION: '9.9.9' });
    await sleep(8000);
    eq(await robin.evaluate(`window.__before === 1 && document.querySelector('.msg.pending') !== null`), true, 'not reloaded while sending');
    // Nothing being sent any more: it reloads, into the newer app.
    away = false;
    await robin.evaluate(`[...document.querySelectorAll('.msg.pending .sending a')].find(a => a.textContent === 'Cancel').click(); true`);
    await robin.waitFor(`typeof window.__before === 'undefined' && document.querySelector('.composer textarea') !== null`, 15000, 'reloaded by itself');
    await robin.evaluate(`window.__after = 1; true`);
    await sleep(5000);
    eq(await robin.evaluate(`window.__after === 1`), true, 'once (it runs the newer app now)');
  }, { timeout: 90000 });

  test('family: a fast link made from a message’s menu; someone without an account opens it and downloads the file straight from the server (a direct connection), or over https (1.9.0)', async ctx => {
    const srv = await familyServer(ctx, { BEAM_FAMILY_STUN: 'local' });
    const robin = await tailscalePage(ctx, OWNER, 'Robin');
    await robin.goto(`${srv.base}/`);
    await robin.waitFor(`document.querySelector('.composer textarea') !== null`, 10000, 'in #general');
    await robin.evaluate(`(() => {
      const bytes = new Uint8Array(3 * 1024 * 1024 + 7); for (let i = 0; i < bytes.length; i += 1000) bytes[i] = (i / 1000) % 251;
      const dt = new DataTransfer(); dt.items.add(new File([bytes], 'trip.bin', { type: 'application/octet-stream' }));
      document.querySelector('section.main').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await robin.waitFor(`document.querySelector('.tray-item') !== null`, 5000, 'in the tray');
    await send(robin, 'For Grandma');
    await robin.waitFor(`[...document.querySelectorAll('.msg')].some(m => /For Grandma/.test(m.textContent) && !m.classList.contains('pending'))`, 10000, 'sent');
    // Its menu: Fast link → a week → the link.
    await robin.evaluate(`(() => { const m = [...document.querySelectorAll('.msg')].find(m => /For Grandma/.test(m.textContent)); m.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })); return true; })()`);
    await robin.waitFor(`[...document.querySelectorAll('.menu button, .sheet button')].some(b => /Fast link/.test(b.textContent))`, 3000, 'Fast link in its menu');
    await robin.evaluate(`[...document.querySelectorAll('.menu button, .sheet button')].find(b => /Fast link/.test(b.textContent)).click(); true`);
    await robin.waitFor(`document.querySelector('dialog.fastlink[open]') !== null`, 3000, 'the sheet');
    await robin.evaluate(`document.querySelector('dialog.fastlink input[value="168"]').click(); document.querySelector('dialog.fastlink button[type=submit]').click(); true`);
    await robin.waitFor(`/\\/f\\/[A-Za-z0-9_-]{32}$/.test(document.querySelector('dialog.fastlink .fl-url')?.value || '')`, 5000, 'the link');
    const url = await robin.evaluate(`document.querySelector('dialog.fastlink .fl-url').value`);
    const token = url.split('/f/')[1];
    // Someone with no account: the page, the file straight from the server.
    const visitor = await ctx.browser.newPage({});
    const dir = path.join(srv.data, 'visitor-downloads');
    fs.mkdirSync(dir, { recursive: true });
    await visitor.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
    await visitor.goto(`${srv.base}/f/${token}`);
    await visitor.waitFor(`/trip\\.bin/.test(document.querySelector('.link-name')?.textContent || '') && /3 MB · from Robin/.test(document.body.textContent)`, 10000, 'the file, its size, who shared it');
    // (as on a phone: no save dialog there, so the browser's downloads take it through the service worker; a headless
    // browser has no dialog to show either)
    await visitor.evaluate(`window.showSaveFilePicker = undefined; [...document.querySelectorAll('.link-actions button')].find(b => b.textContent === 'Download').click(); true`);
    try {
      await visitor.waitFor(`/^Done: .* straight from the sender/.test(document.querySelector('.link-progress .status')?.textContent || '')`, 30000, 'downloaded straight from the server');
    } catch (err) {
      throw new Error(`${err.message}; the page says: ${await visitor.evaluate(`document.querySelector('.link-progress .status')?.textContent || '(nothing)'`)}; errors: ${JSON.stringify(visitor.errors || [])}; downloads: ${fs.readdirSync(dir)}`);
    }
    const want = await robin.evaluate(`(() => { const b = new Uint8Array(3 * 1024 * 1024 + 7); for (let i = 0; i < b.length; i += 1000) b[i] = (i / 1000) % 251; return [b.length, [...b.subarray(0, 4)], b[2000], b[b.length - 7]]; })()`);
    let saved = null;
    for (let i = 0; i < 50 && !saved; i++) {
      saved = fs.readdirSync(dir).find(f => f === 'trip.bin' && fs.statSync(path.join(dir, f)).size === want[0]);
      if (!saved) await sleep(200);
    }
    assert(saved, `saved in the downloads: ${fs.readdirSync(dir)}`);
    const got = fs.readFileSync(path.join(dir, saved));
    eq([got.length, [...got.subarray(0, 4)], got[2000], got[got.length - 7]], want, 'the same bytes');
    // Over https too (Download in the background), and nothing else of the family's.
    eq(await visitor.evaluate(`fetch('/api/links/${token}/file').then(r => r.arrayBuffer()).then(b => b.byteLength)`), want[0], 'over https');
    eq(await visitor.evaluate(`fetch('/api/bootstrap').then(r => r.status)`), 401, 'not signed in to anything');
  }, { timeout: 90000 });

  test('family: a fast link’s page: Download turns into Stop while it runs and the other button waits; a second download is asked about first (1.9.1)', async ctx => {
    const srv = await familyServer(ctx, { BEAM_FAMILY_STUN: 'local' });
    const size = 96 * 1024 * 1024;
    const headers = { 'Tailscale-User-Login': OWNER, 'Tailscale-User-Name': 'Robin', 'X-Forwarded-For': '100.64.7.7' };
    const id = (await srv.call(owner, 'POST', '/api/uploads', { name: 'film.bin', size })).json.id;
    const piece = Buffer.alloc(16 * 1024 * 1024, 7);
    for (let o = 0; o < size; o += piece.length) {
      await fetch(`${srv.base}/api/uploads/${id}?offset=${o}`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: piece.subarray(0, Math.min(piece.length, size - o)) });
    }
    const link = (await srv.call(owner, 'POST', `/api/files/${id}/links`, { hours: 1 })).json.link;
    const visitor = await ctx.browser.newPage({});
    const dir = path.join(srv.data, 'visitor-downloads');
    fs.mkdirSync(dir, { recursive: true });
    await visitor.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
    await visitor.goto(`${srv.base}/f/${link.url.split('/f/')[1]}`);
    await visitor.waitFor(`/film\\.bin/.test(document.querySelector('.link-name')?.textContent || '')`, 10000, 'the page');
    const state = `(() => { const s = document.querySelector('.link-progress .status')?.textContent || ''; return { get: document.querySelector('#get').textContent, background: document.querySelector('#background').disabled, status: s }; })()`;
    await visitor.evaluate(`window.showSaveFilePicker = undefined; document.querySelector('#get').click(); true`);
    // (a quarter of it first: the log has a line only from 8 MB on)
    await visitor.waitFor(`/Downloading straight from the sender/.test(document.querySelector('.link-progress .status')?.textContent || '') && parseFloat(document.querySelector('.link-progress .fill').style.width) >= 25`, 20000, 'downloading directly');
    const during = await visitor.evaluate(state);
    eq([during.get, during.background], ['Stop', true], 'Download is Stop now, and the other button waits');
    await visitor.evaluate(`document.querySelector('#get').click(); true`);
    await visitor.waitFor(`document.querySelector('.link-progress .status')?.textContent === 'Stopped.' || document.querySelector('.link-progress .status')?.textContent`, 5000, 'stopped').then(t => eq(t, true, 'Stopped.'), async err => { throw new Error(`${err.message}; the page says: ${await visitor.evaluate("document.querySelector('.link-progress .status')?.textContent")}`); });
    const after = await visitor.evaluate(state);
    eq([after.get, after.background], ['Download', false], 'both buttons back');
    // In the background, then Download again: asked first; "Cancel" starts nothing. (The browser drops that download at
    // once: a headless browser closed with a download still going died and took the next tests with it.)
    await visitor.send('Page.setDownloadBehavior', { behavior: 'deny' });
    await visitor.evaluate(`document.querySelector('#background').click(); true`);
    await visitor.waitFor(`/Your browser is downloading it/.test(document.querySelector('.link-progress .status')?.textContent || '')`, 5000, 'in the browser’s downloads');
    await visitor.evaluate(`document.querySelector('#get').click(); true`);
    await visitor.waitFor(`/Download it again/.test(document.querySelector('dialog[open] h2')?.textContent || '')`, 3000, 'asked first');
    await visitor.evaluate(`[...document.querySelectorAll('dialog[open] button')].find(b => b.textContent === 'Cancel').click(); true`);
    await sleep(500);
    eq(await visitor.evaluate(`[document.querySelector('dialog[open]') === null, document.querySelector('#get').textContent, /Your browser is downloading it/.test(document.querySelector('.link-progress .status').textContent)]`), [true, 'Download', true], 'nothing new started');
    // (the server notices within a second or so)
    let log = '';
    for (let i = 0; i < 30 && !/stopped a direct download/.test(log); i++) {
      log = fs.readFileSync(path.join(srv.data, 'logs', 'family.log'), 'utf8');
      if (!/stopped a direct download/.test(log)) await sleep(200);
    }
    assert(/A fast link’s visitor stopped a direct download of film\.bin after \d+ MB in /.test(log), `the log says how far it got: ${log.split('\n').filter(l => /direct/.test(l)).join(' | ')}`);
  }, { timeout: 90000 });

  test('family: a phone’s HDR video plays everywhere: the chat’s viewer and a fast link’s page play its H.264 copy, which can be downloaded too; on an iPhone Download is Safari’s own (1.10.0)', async ctx => {
    if (!FFMPEG) { console.log('    (no ffmpeg here: set BEAM_TEST_FFMPEG to run this one)'); return; }
    const srv = await familyServer(ctx, { BEAM_FAMILY_FFMPEG: FFMPEG, BEAM_FAMILY_STUN: 'local' });
    // A phone's HDR video (10-bit, HLG, BT.2020) and its preview.
    const dir = path.join(srv.data, 'made');
    fs.mkdirSync(dir, { recursive: true });
    const x265 = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true }).stdout.includes('libx265');
    const tags = 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc';
    let r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=3', '-f', 'lavfi', '-i', 'sine=d=3',
      ...(x265 ? ['-c:v', 'libx265', '-tag:v', 'hvc1', '-x265-params', `log-level=error:${tags}`] : ['-c:v', 'libx264', '-x264-params', tags]), '-pix_fmt', 'yuv420p10le',
      '-c:a', 'aac', '-shortest', path.join(dir, 'party.mp4')], { encoding: 'utf8', windowsHide: true });
    assert(r.status === 0, r.stderr);
    r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640', '-frames:v', '1', path.join(dir, 'party.jpg')], { encoding: 'utf8', windowsHide: true });
    assert(r.status === 0, r.stderr);
    const video = fs.readFileSync(path.join(dir, 'party.mp4'));
    const headers = { 'Tailscale-User-Login': OWNER, 'Tailscale-User-Name': 'Robin', 'X-Forwarded-For': '100.64.7.7' };
    const id = (await srv.call(owner, 'POST', '/api/uploads', { name: 'Party.mp4', size: video.length, mime: 'video/mp4' })).json.id;
    await fetch(`${srv.base}/api/uploads/${id}?offset=0`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: video });
    await fetch(`${srv.base}/api/files/${id}/thumb?w=360&h=640`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'image/jpeg' }, body: fs.readFileSync(path.join(dir, 'party.jpg')) });
    const general = (await srv.call(owner, 'GET', '/api/bootstrap')).json.channels.find(c => c.name === 'general').id;
    await srv.call(owner, 'POST', `/api/channels/${general}/messages`, { body: 'Party', files: [id] });
    let file = null;
    for (let i = 0; i < 150 && file?.play !== 'ready'; i++) {
      file = (await srv.call(owner, 'GET', `/api/channels/${general}/messages`)).json.messages.find(m => m.body === 'Party')?.files[0];
      if (file?.play !== 'ready') await sleep(200);
    }
    eq(file?.play, 'ready', 'its copy is made');
    // In the chat: the viewer plays the copy.
    const robin = await tailscalePage(ctx, OWNER, 'Robin');
    await robin.goto(`${srv.base}/`);
    await robin.waitFor(`document.querySelector('.shot') !== null`, 10000, 'the video in the chat');
    await robin.evaluate(`document.querySelector('.shot').click(); true`);
    await robin.waitFor(`/\\/api\\/files\\/${id}\\/play$/.test(document.querySelector('.viewer video')?.getAttribute('src') || '')`, 5000, 'the viewer plays the copy');
    await robin.waitFor(`document.querySelector('.viewer video').readyState >= 1 && Math.round(document.querySelector('.viewer video').duration) === 3`, 10000, 'it loads in the viewer');
    // A fast link: its page plays it, and offers it to keep.
    const link = (await srv.call(owner, 'POST', `/api/files/${id}/links`, { hours: 1 })).json.link;
    const page = `${srv.base}/f/${link.url.split('/f/')[1]}`;
    const visitor = await ctx.browser.newPage({});
    await visitor.goto(page);
    await visitor.waitFor(`document.querySelector('video.link-video')?.readyState >= 1`, 10000, 'the player on the link’s page');
    eq(await visitor.evaluate(`[Math.round(document.querySelector('video.link-video').duration), /^Download for any phone \\(/.test(document.querySelector('#playable')?.textContent || '')]`), [3, true], 'it plays there, and the copy can be downloaded');
    // On an iPhone, Download is Safari's own download (the service worker's stream broke files there).
    const iphone = await ctx.browser.newPage({ mobile: true, width: 390, height: 844 });
    await iphone.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1', platform: 'iPhone' });
    await iphone.send('Page.setDownloadBehavior', { behavior: 'deny' });
    await iphone.goto(page);
    await iphone.waitFor(`document.querySelector('#get') !== null`, 10000, 'the page on an iPhone');
    await iphone.evaluate(`document.querySelector('#get').click(); true`);
    await iphone.waitFor(`/Safari’s own download/.test(document.querySelector('.link-progress .status')?.textContent || '')`, 5000, 'Safari’s own download on an iPhone');
  }, { timeout: 90000 });

  test('family: a big file in the chat downloads over the direct connection: not over https, a panel with how far it got, the same bytes; a small one as before (1.11.0)', async ctx => {
    const srv = await familyServer(ctx, { BEAM_FAMILY_STUN: 'local' });
    const headers = { 'Tailscale-User-Login': OWNER, 'Tailscale-User-Name': 'Robin', 'X-Forwarded-For': '100.64.7.7' };
    const up = async (name, data) => {
      const id = (await srv.call(owner, 'POST', '/api/uploads', { name, size: data.length })).json.id;
      for (let o = 0; o < data.length; o += 16 * 1024 * 1024) {
        await fetch(`${srv.base}/api/uploads/${id}?offset=${o}`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: data.subarray(o, o + 16 * 1024 * 1024) });
      }
      return id;
    };
    const big = Buffer.alloc(24 * 1024 * 1024 + 5);
    for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) % 251;
    const general = (await srv.call(owner, 'GET', '/api/bootstrap')).json.channels.find(c => c.name === 'general').id;
    await srv.call(owner, 'POST', `/api/channels/${general}/messages`, { body: 'The backup', files: [await up('backup.bin', big)] });
    await srv.call(owner, 'POST', `/api/channels/${general}/messages`, { body: 'A note', files: [await up('note.txt', Buffer.from('a small file'))] });
    const robin = await tailscalePage(ctx, OWNER, 'Robin');
    const dir = path.join(srv.data, 'robin-downloads');
    fs.mkdirSync(dir, { recursive: true });
    await robin.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
    await robin.goto(`${srv.base}/`);
    await robin.waitFor(`document.querySelectorAll('.file-card').length === 2`, 10000, 'both files in the chat');
    // (which files go over https)
    const gets = [];
    await robin.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/files/*', requestStage: 'Request' }] });
    const paused = m => {
      if (m.method !== 'Fetch.requestPaused') return;
      gets.push(m.params.request.url);
      robin.send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
    };
    robin.on(paused);
    ctx.defer(() => robin.off(paused));
    await robin.evaluate(`[...document.querySelectorAll('.file-card')].find(a => /backup\\.bin/.test(a.textContent)).click(); true`);
    await robin.waitFor(`/^Done in .*: it’s in your downloads$/.test(document.querySelector('.downloads .dl-row .dl-status')?.textContent || '')`, 30000, 'downloaded directly, the panel says so');
    eq(gets.filter(u => /\?download/.test(u)), [], 'not over https');
    let saved = null;
    for (let i = 0; i < 50 && !saved; i++) {
      saved = fs.readdirSync(dir).find(n => n === 'backup.bin' && fs.statSync(path.join(dir, n)).size === big.length);
      if (!saved) await sleep(200);
    }
    assert(saved, `in the downloads: ${fs.readdirSync(dir)}`);
    assert(fs.readFileSync(path.join(dir, saved)).equals(big), 'the same bytes');
    // A small file: the browser's own download, as before.
    await robin.evaluate(`[...document.querySelectorAll('.file-card')].find(a => /note\\.txt/.test(a.textContent)).click(); true`);
    for (let i = 0; i < 50 && !gets.some(u => /\?download/.test(u)); i++) await sleep(100);
    eq(gets.filter(u => /\?download/.test(u)).length, 1, 'the small one over https');
  }, { timeout: 90000 });

  test('family: a conversation’s gallery: its photos newest first, one opens in the viewer, Select picks two and deletes their messages; the files on their own tab (1.11.0)', async ctx => {
    const srv = await familyServer(ctx);
    const headers = { 'Tailscale-User-Login': OWNER, 'Tailscale-User-Name': 'Robin', 'X-Forwarded-For': '100.64.7.7' };
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const up = async (name, data, mime) => {
      const id = (await srv.call(owner, 'POST', '/api/uploads', { name, size: data.length, mime })).json.id;
      await fetch(`${srv.base}/api/uploads/${id}?offset=0`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: data });
      return id;
    };
    const general = (await srv.call(owner, 'GET', '/api/bootstrap')).json.channels.find(c => c.name === 'general').id;
    for (const [body, name, data, mime] of [['Dog', 'dog.png', png, 'image/png'], ['Cat', 'cat.png', png, 'image/png'], ['Bird', 'bird.png', png, 'image/png'], ['Plans', 'plans.pdf', Buffer.from('%PDF-1.4 plans'), 'application/pdf']]) {
      await srv.call(owner, 'POST', `/api/channels/${general}/messages`, { body, files: [await up(name, data, mime)] });
    }
    const robin = await tailscalePage(ctx, OWNER, 'Robin');
    await robin.goto(`${srv.base}/`);
    await robin.waitFor(`document.querySelector('.composer textarea') !== null`, 10000, 'in #general');
    await robin.evaluate(`document.querySelector('button[aria-label="Photos and files"]').click(); true`);
    await robin.waitFor(`document.querySelectorAll('.panel .gal-tile').length === 3`, 5000, 'three photos in the gallery');
    eq(await robin.evaluate(`[...document.querySelectorAll('.panel .gal-tile')].map(t => t.title)`), ['bird.png', 'cat.png', 'dog.png'], 'newest first');
    // One opens in the viewer.
    await robin.evaluate(`document.querySelector('.panel .gal-tile').click(); true`);
    await robin.waitFor(`/bird\\.png · 1 of 3/.test(document.querySelector('.viewer .name')?.textContent || '')`, 3000, 'the viewer, with the others');
    await robin.evaluate(`document.querySelector('.viewer button[aria-label="Close"]').click(); true`);
    await robin.waitFor(`document.querySelector('.viewer') === null`, 3000, 'closed');
    // Select two, Delete: asked first, then their messages go.
    await robin.evaluate(`[...document.querySelectorAll('.panel .gal-tools button')].find(b => /Select/.test(b.textContent)).click(); true`);
    await robin.evaluate(`(() => { const t = document.querySelectorAll('.panel .gal-tile'); t[0].click(); return true; })()`);
    await robin.evaluate(`(() => { const t = document.querySelectorAll('.panel .gal-tile'); t[2].click(); return true; })()`);
    await robin.waitFor(`/^2 selected$/.test(document.querySelector('.panel .gal-tools .grow')?.textContent || '')`, 3000, 'two selected');
    await robin.evaluate(`[...document.querySelectorAll('.panel .gal-tools button')].find(b => /Delete/.test(b.textContent)).click(); true`);
    await robin.waitFor(`/Delete these 2 messages/.test(document.querySelector('dialog[open] h2')?.textContent || '')`, 3000, 'asked first');
    await robin.evaluate(`[...document.querySelectorAll('dialog[open] button')].find(b => b.textContent === 'Delete').click(); true`);
    await robin.waitFor(`document.querySelectorAll('.panel .gal-tile').length === 1 && document.querySelector('.panel .gal-tile').title === 'cat.png'`, 5000, 'only the cat left');
    const left = (await srv.call(owner, 'GET', `/api/channels/${general}/messages`)).json.messages.filter(m => m.files?.length).map(m => m.body);
    eq(left.sort(), ['Cat', 'Plans'], 'their messages are gone');
    // The files tab.
    await robin.evaluate(`[...document.querySelectorAll('.panel .gal-tab')].find(b => b.textContent === 'Files').click(); true`);
    await robin.waitFor(`/plans\\.pdf/.test(document.querySelector('.panel .gal-file')?.textContent || '')`, 3000, 'the file on its own tab');
  }, { timeout: 90000 });

  test('family: selecting several messages: Select in a message’s menu, taps pick and unpick, Delete asks and deletes them all; Escape stops (1.11.0)', async ctx => {
    const srv = await familyServer(ctx);
    const general = (await srv.call(owner, 'GET', '/api/bootstrap')).json.channels.find(c => c.name === 'general').id;
    for (const body of ['One', 'Two', 'Three', 'Four']) await srv.call(owner, 'POST', `/api/channels/${general}/messages`, { body });
    const robin = await tailscalePage(ctx, OWNER, 'Robin');
    await robin.goto(`${srv.base}/`);
    await robin.waitFor(`[...document.querySelectorAll('.msg')].some(m => /Four/.test(m.textContent))`, 10000, 'the messages');
    const msg = text => `[...document.querySelectorAll('.msg[data-pickable]')].find(m => m.querySelector('.msg-body')?.textContent.trim() === '${text}')`;
    await robin.evaluate(`${msg('One')}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })); true`);
    await robin.waitFor(`[...document.querySelectorAll('.menu button, .sheet button')].some(b => b.textContent.trim() === 'Select')`, 3000, 'Select in its menu');
    await robin.evaluate(`[...document.querySelectorAll('.menu button, .sheet button')].find(b => b.textContent.trim() === 'Select').click(); true`);
    await robin.waitFor(`document.querySelector('.main.selecting') !== null && /^1 selected$/.test(document.querySelector('.select-bar .grow')?.textContent || '')`, 3000, 'selecting, one picked');
    eq(await robin.evaluate(`document.querySelector('.composer').hidden`), true, 'the bar instead of the composer');
    for (const t of ['Two', 'Three', 'Two', 'Two']) await robin.evaluate(`${msg(t)}.click(); true`); // (Two: picked, unpicked, picked)
    await robin.waitFor(`/^3 selected$/.test(document.querySelector('.select-bar .grow')?.textContent || '')`, 3000, 'three picked');
    eq(await robin.evaluate(`[...document.querySelectorAll('.msg.selected')].map(m => m.querySelector('.msg-body').textContent.trim())`), ['One', 'Two', 'Three'], 'the right ones');
    await robin.evaluate(`[...document.querySelectorAll('.select-bar button')].find(b => /Delete/.test(b.textContent)).click(); true`);
    await robin.waitFor(`/Delete these 3 messages/.test(document.querySelector('dialog[open] h2')?.textContent || '')`, 3000, 'asked first');
    await robin.evaluate(`[...document.querySelectorAll('dialog[open] button')].find(b => b.textContent === 'Delete').click(); true`);
    await robin.waitFor(`document.querySelector('.main.selecting') === null && document.querySelector('.composer').hidden === false`, 5000, 'back to normal');
    for (let i = 0; i < 30; i++) {
      const left = (await srv.call(owner, 'GET', `/api/channels/${general}/messages`)).json.messages.map(m => m.body).filter(b => ['One', 'Two', 'Three', 'Four'].includes(b));
      if (left.length === 1) break;
      await sleep(100);
    }
    eq((await srv.call(owner, 'GET', `/api/channels/${general}/messages`)).json.messages.map(m => m.body).filter(b => ['One', 'Two', 'Three', 'Four'].includes(b)), ['Four'], 'the three are gone');
    // Escape stops selecting.
    await robin.evaluate(`${msg('Four')}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })); true`);
    await robin.waitFor(`[...document.querySelectorAll('.menu button, .sheet button')].some(b => b.textContent.trim() === 'Select')`, 3000, 'its menu');
    await robin.evaluate(`[...document.querySelectorAll('.menu button, .sheet button')].find(b => b.textContent.trim() === 'Select').click(); true`);
    await robin.waitFor(`document.querySelector('.main.selecting') !== null`, 3000, 'selecting');
    await robin.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await robin.waitFor(`document.querySelector('.main.selecting') === null`, 3000, 'Escape stopped it');
  }, { timeout: 60000 });

  test('family: a big file goes up over a direct connection: no https pieces (1.9.0)', async ctx => {
    const srv = await familyServer(ctx, { BEAM_FAMILY_STUN: 'local' });
    const robin = await tailscalePage(ctx, OWNER, 'Robin');
    await robin.goto(`${srv.base}/`);
    await robin.waitFor(`document.querySelector('.composer textarea') !== null`, 10000, 'in #general');
    const pieces = [];
    await robin.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/uploads/*', requestStage: 'Request' }] });
    const paused = m => {
      if (m.method !== 'Fetch.requestPaused') return;
      if (m.params.request.method === 'PUT') pieces.push(m.params.request.url);
      robin.send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
    };
    robin.on(paused);
    ctx.defer(() => robin.off(paused));
    await robin.evaluate(`(() => {
      const bytes = new Uint8Array(12 * 1024 * 1024); for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 253;
      const dt = new DataTransfer(); dt.items.add(new File([bytes], 'movie.bin', { type: 'application/octet-stream' }));
      document.querySelector('section.main').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await robin.waitFor(`document.querySelector('.tray-item') !== null`, 5000, 'in the tray');
    await send(robin, 'Big one');
    await robin.waitFor(`[...document.querySelectorAll('.msg')].some(m => /Big one/.test(m.textContent) && !m.classList.contains('pending'))`, 30000, 'sent');
    eq(pieces, [], 'no https pieces: it went over the direct connection');
    const files = fs.readdirSync(path.join(srv.data, 'files'));
    eq(files.map(f => fs.statSync(path.join(srv.data, 'files', f)).size), [12 * 1024 * 1024], 'all of it on the server');
  }, { timeout: 60000 });

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

  test('family: Beam’s own chat makes a fast link for a file: its menu → Fast link… → a week → the link, made by Beam Family on the same machine from the file itself; anyone downloads it; a text has none, nor a Beam without Family (1.13.0)', async ctx => {
    const fam = await familyServer(ctx, { BEAM_FAMILY_URL: `http://127.0.0.1:${PORT}` });
    await fam.call(owner, 'GET', '/api/bootstrap'); // (the owner, as on their first visit)
    const beam = await ctx.startServer(8823, { BEAM_FAMILY_URL: fam.base, BEAM_FAMILY_DATA: fam.data, BEAM_FAMILY_PORT: String(PORT) });
    ctx.defer(() => beam.stop());
    const page = await ctx.signedIn({ server: beam });
    const meId = await page.evaluate('me.id');
    const phone = dev(ctx, 'Pixel', 'android', beam);
    await phone.me();
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 5);
    for (let i = 0; i < bytes.length; i += 997) bytes[i] = (i / 997) % 251;
    await phone.file('trip.bin', bytes, [meId]);
    await phone.text('just words', [meId]);
    await page.waitFor(`Boolean(deviceById('${phone.id}')) && itemsIn('${phone.id}').length === 2 && serverHas('fast-links')`, 8000, 'the file and a text');
    await page.evaluate(`openConv('${phone.id}')`);
    const [fileId, textId] = await page.evaluate(`['file', 'text'].map(k => itemsIn('${phone.id}').find(i => i.kind === k).id)`);
    const entry = id => `itemMenuEntries(itemMap.get('${id}'), null, null).find(e => e && e.label === 'Fast link…')`;
    eq(await page.evaluate(`[Boolean(${entry(fileId)}), Boolean(${entry(textId)})]`), [true, false], 'in a file’s menu, not a text’s');
    await page.evaluate(`${entry(fileId)}.action()`);
    await page.waitFor(`$('#genDlg').open && $('#genDlg').classList.contains('fastlink-dlg')`, 3000, 'the dialog');
    await page.evaluate(`$('#genDlg input[value="168"]').click(); [...$$('#genFoot button')].find(b => /Make the link/.test(b.textContent)).click(); true`);
    await page.waitFor(`/\\/f\\/[A-Za-z0-9_-]{32}$/.test($('#genDlg .fl-url')?.value || '')`, 8000, 'the link');
    const url = await page.evaluate(`$('#genDlg .fl-url').value`);
    assert(url.startsWith(`${fam.base}/f/`), `Beam Family’s address: ${url}`);
    const token = url.split('/f/')[1];
    const info = await (await fetch(`${fam.base}/api/links/${token}`)).json();
    eq([info.name, info.size, info.received, info.from, Math.round((info.expires - Date.now()) / 3600e3)], ['trip.bin', bytes.length, bytes.length, 'Robin', 168], 'the file, from Family’s owner, for a week');
    assert(Buffer.from(await (await fetch(`${fam.base}/api/links/${token}/file`)).arrayBuffer()).equals(bytes), 'the same bytes, without an account');
    assert(/made a fast link to trip\.bin \(through Beam Family, 7 days\)/.test(beam.log || ''), 'Beam’s log says so');
    // A Beam without Beam Family doesn't offer it.
    const plain = await ctx.signedIn();
    await plain.waitFor(`typeof server !== 'undefined' && Boolean(server.info)`, 10000, 'info loaded');
    eq(await plain.evaluate(`serverHas('fast-links')`), false, 'no fast links without Beam Family');
  }, { timeout: 60000 });
}
