// Signing in: the request loop, approvals, the signed-out approve link, session sign-in, autopair, moves.
import fs from 'node:fs';
import path from 'node:path';
import { assert, eq } from './harness.mjs';
import { dev } from './tests-core.mjs';

const pending = async server => (await (await fetch(`${server.base}/api/login-requests`, { headers: { Authorization: `Bearer ${server.key}` } })).json()).requests || [];
const lockPage = async (ctx, opts = {}) => {
  const page = await ctx.browser.newPage({ xff: ctx.nextIp(), ...opts });
  await page.goto(`${(opts.server || ctx.srv).base}/${opts.query || ''}`);
  await page.waitFor(`!$('#lock').hidden && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test($('#loginCode').textContent)`, 15000, 'sign-in code shown');
  return page;
};

export default function register(test) {
  test('another Beam at the same address: the saved history lies dormant (its 401s, or no way to tell), its own Beam wakes it, a sign-in there replaces it; the outbox only ever goes to its own Beam (and survives until it’s back)', async ctx => {
    // A reverse proxy that picks the server per request (browsers keep connections open across page loads).
    const proxy = await ctx.prefixProxy(8826, 8821, '');
    ctx.defer(() => proxy.stop());
    const switchTo = port => { proxy.upstream = port; };
    const page = await ctx.signedIn({ base: proxy.base });
    // Requests to clear the browser's HTTP cache (POST /api/clear-cache), with the server's answers.
    const cleared = [];
    page.on(m => { if (m.method === 'Network.responseReceived' && /\/api\/clear-cache$/.test(m.params.response.url)) cleared.push(m.params.response.status); });
    const meId = await page.evaluate('me.id');
    const ownId = (await (await fetch(`${ctx.srv.base}/api/hello`)).json()).serverId;
    const phone = dev(ctx, 'Pixel');
    await phone.me();
    for (let i = 0; i < 4; i++) await phone.text(`kept ${i}`, [meId]);
    await page.waitFor(`deviceById('${phone.id}') !== undefined && itemsIn('${phone.id}').length === 4`, 8000, 'history');
    await page.evaluate(`openConv('${phone.id}'); true`);
    // Written while its Beam was unreachable: one for the phone, one for every device (another Beam would take that).
    const queue = (id, text, conv) => page.evaluate(`outboxStore.put({ id: '${id}', kind: 'text', text: '${text}', conv: '${conv}', to: ${conv === 'all' ? '[]' : `['${conv}']`}, created: Date.now(), deviceId: me.id, serverId: '${ownId}' }).then(() => true)`);
    await queue('ophone1', 'queued for the phone', phone.id);
    await queue('oall1', 'queued for all', 'all');
    await page.waitFor(`(cache.flushPending(), idbGetAll('items').then(l => l.length >= 4))`, 5000, 'saved');
    // A fresh Beam answers at this address now (a move gone wrong, a reinstall).
    const other = await ctx.startServer(8822);
    ctx.defer(() => other.stop());
    const otherId = other.hello.serverId;
    // What's saved, read straight from IndexedDB (the page's own helpers keep away from a dormant history).
    const saved = `new Promise(resolve => { const r = indexedDB.open('beam'); r.onerror = () => resolve(null); r.onsuccess = () => {
      const tx = r.result.transaction(['kv', 'items', 'outbox']); const o = {};
      tx.objectStore('items').count().onsuccess = e => { o.items = e.target.result; };
      tx.objectStore('outbox').count().onsuccess = e => { o.outbox = e.target.result; };
      tx.objectStore('kv').get('meta').onsuccess = e => { o.serverId = e.target.result?.serverId || ''; };
      tx.objectStore('kv').get('aside').onsuccess = e => { o.aside = e.target.result || ''; };
      tx.oncomplete = () => { r.result.close(); resolve(o); }; }; })`;
    const state = `${saved}.then(o => [o.items >= 4, o.serverId, o.outbox, items.some(i => /^kept/.test(i.text || '')), [...document.querySelectorAll('#thread .msg')].some(n => /kept/.test(n.textContent))])`;
    const signInPage = `typeof paired !== 'undefined' && !paired && !$('#lock').hidden`;
    const note = `!$('#dormantNote').hidden`;
    const leave = async () => { await page.goto('about:blank'); await ctx.sleep(300); };
    const textsOn = async srv => (await (await fetch(`${srv.base}/api/items`, { headers: { Authorization: `Bearer ${srv.key}` } })).json()).items.map(i => i.text || '');
    const fake401 = requestId => page.send('Fetch.fulfillRequest', { requestId, responseCode: 401, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{"error":"Not paired"}').toString('base64') }).catch(() => {});

    // 1. Another Beam's 401 (1.4 says who it is; 1.3 is asked), and one that can't be told at all: dormant. Off the
    //    screen, nothing wiped, nothing sent, and the sign-in page says what signing in there would do.
    for (const [how, kind] of [['it says who it is (1.4)', '1.4'], ['it doesn’t (1.3: the page asks /api/hello)', '1.3'], ['no way to tell (/api/hello unreachable)', 'unsure']]) {
      await leave();
      switchTo(8822);
      const intercept = m => {
        if (m.method !== 'Fetch.requestPaused') return;
        if (kind === '1.3') fake401(m.params.requestId); // /api/me, answered without a serverId
        else if (m.params.request.url.includes('/api/hello')) page.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'ConnectionRefused' }).catch(() => {});
        else fake401(m.params.requestId);
      };
      if (kind !== '1.4') {
        page.on(intercept);
        await page.send('Fetch.enable', { patterns: kind === '1.3' ? [{ urlPattern: '*/api/me', requestStage: 'Response' }] : [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
      }
      await page.goto(`${proxy.base}/`);
      await page.waitFor(`${signInPage} && ${note}`, 10000, `the sign-in page, with the note (${how})`);
      await ctx.sleep(500);
      eq(await page.evaluate(state), [true, ownId, 2, false, false], `dormant: kept on the device, off the screen (${how})`);
      if (kind !== '1.4') { await page.send('Fetch.disable'); page.off(intercept); }
    }
    eq(cleared, [], 'nothing cleared for another Beam, or when it can’t be told');
    eq((await textsOn(other)).filter(t => /queued/.test(t)), [], 'nothing sent to the other Beam');

    // 2. Its own Beam answers again: awake. The history is back, and the outbox goes out, to it only.
    await leave();
    switchTo(8821);
    await page.goto(`${proxy.base}/`);
    await page.waitFor(`typeof paired !== 'undefined' && paired && itemsIn('${phone.id}').some(i => i.text === 'kept 3') && $('#dormantNote').hidden`, 10000, 'awake: the history is back');
    await page.evaluate(`openConv('${phone.id}'); true`);
    await page.waitFor(`[...document.querySelectorAll('#thread .msg')].some(n => /kept 3/.test(n.textContent))`, 5000, 'on the page');
    const queuedOnOwn = async () => (await textsOn(ctx.srv)).filter(t => /^queued/.test(t)).sort();
    for (let i = 0; i < 50 && (await queuedOnOwn()).length < 2; i++) await ctx.sleep(200);
    eq(await queuedOnOwn(), ['queued for all', 'queued for the phone'], 'the outbox went to its own Beam');
    await page.waitFor(`${saved}.then(o => o.serverId === '${ownId}' && o.aside === '' && o.outbox === 0)`, 5000, 'no longer dormant');
    eq((await textsOn(other)).filter(t => /queued/.test(t)), [], 'and nothing to the other Beam');

    // 3. Straight from its own Beam to the other Beam's pairing link (no visit in between): the saved history is
    //    replaced and that Beam starts fresh; the old Beam's outbox stays, out of sight, and nothing reaches the other Beam.
    await queue('oall2', 'second batch for all', 'all');
    await page.waitFor(`idbGetAll('outbox').then(l => l.length === 1)`, 5000, 'queued again');
    await leave();
    switchTo(8822);
    const laptop = dev(ctx, 'Laptop', 'windows', other);
    await laptop.me();
    await laptop.text('from the other Beam');
    await page.goto(await ctx.keyLink(other, proxy.base));
    const onB = `typeof paired !== 'undefined' && paired && items.some(i => i.text === 'from the other Beam')`;
    await page.waitFor(onB, 10000, 'signed in to the other Beam');
    await page.waitFor(`${saved}.then(o => o.serverId === '${otherId}' && o.items === 1)`, 5000, 'the cache is the other Beam’s, fresh');
    eq(await page.evaluate(state), [false, otherId, 1, false, false], 'the old history is gone; its outbox stays, for its own Beam');
    eq(await page.evaluate('outbox.size'), 0, 'not shown with the other Beam’s conversations');
    await ctx.sleep(1000);
    eq((await textsOn(other)).filter(t => /queued|batch/.test(t)), [], 'nothing of the old outbox went to the other Beam');
    // From now on every start of this page counts what of the old history shows, even for a moment.
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const t = window.__flash = { kept: 0, other: 0 }; new MutationObserver(() => { const all = [...document.querySelectorAll('#thread .msg')].map(n => n.textContent).join(' '); if (/kept/.test(all)) t.kept++; if (/from the other Beam/.test(all)) t.other++; }).observe(document, { subtree: true, childList: true }); })()` });
    await page.reload();
    await page.waitFor(onB, 10000, 'the other Beam again');
    await ctx.sleep(500);
    eq(await page.evaluate(state), [false, otherId, 1, false, false], 'its own cache now');
    eq(await page.evaluate('__flash.kept'), 0, 'the old history never shows again');

    // 4. Its first Beam again (the cookie is the other Beam's now, so a 401 that says who it is): this history lies
    //    dormant, also on the next start (not shown even for a moment); signing in there (its pairing link) replaces
    //    it, the first Beam's history comes back from the server, and what was queued for it goes out now.
    await leave();
    switchTo(8821);
    for (const visit of ['first', 'next start']) {
      await page.goto(`${proxy.base}/`);
      await page.waitFor(`${signInPage} && ${note}`, 10000, `dormant for the first Beam (${visit})`);
      await ctx.sleep(500);
      eq(await page.evaluate(`${saved}.then(o => [o.items, o.serverId, o.outbox, o.aside])`), [1, otherId, 1, ownId], `kept, untouched (${visit})`);
      if (visit === 'next start') eq(await page.evaluate('__flash.other'), 0, 'a dormant history isn’t shown at start, even for a moment');
      await leave();
    }
    await page.goto(await ctx.keyLink(ctx.srv, proxy.base));
    await page.waitFor(`typeof paired !== 'undefined' && paired && itemsIn('${phone.id}').some(i => i.text === 'kept 3')`, 10000, 'signed in to the first Beam again');
    await page.waitFor(`${saved}.then(o => o.serverId === '${ownId}' && o.items >= 4 && o.aside === '')`, 5000, 'the cache is the first Beam’s again');
    eq(await page.evaluate(`items.some(i => i.text === 'from the other Beam')`), false, 'nothing of the replaced history in memory');
    for (let i = 0; i < 50 && !(await textsOn(ctx.srv)).includes('second batch for all'); i++) await ctx.sleep(200);
    eq((await textsOn(ctx.srv)).filter(t => /batch/.test(t)), ['second batch for all'], 'what was queued for it went out when it came back');
    eq((await textsOn(other)).filter(t => /batch/.test(t)), [], 'and never to the other Beam');

    // 5. Revoked by the Beam it belongs to, which doesn't say who it is in its 401s (1.3): asked, it matches, and
    //    everything goes, the browser's HTTP cache too.
    await leave();
    eq((await fetch(`${ctx.srv.base}/api/devices/${meId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ctx.srv.key}` } })).status, 204, 'revoked');
    const strip = m => {
      if (m.method !== 'Fetch.requestPaused') return;
      if (m.params.responseStatusCode === 401) fake401(m.params.requestId);
      else page.send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
    };
    page.on(strip);
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Response' }] });
    await page.goto(`${proxy.base}/`);
    await page.waitFor(signInPage, 10000, 'the sign-in page (its own 1.3 Beam)');
    await ctx.sleep(500);
    eq(await page.evaluate(`${saved}.then(o => [o.items, o.serverId, o.outbox])`), [0, '', 0], 'wiped: it was its own Beam');
    for (let n = 0; n < 50 && !cleared.length; n++) await ctx.sleep(100);
    eq(cleared, [204], 'its HTTP cache cleared too');
    await page.send('Fetch.disable');
    page.off(strip);
  }, { timeout: 120000 });

  test('an old tab left open across a server swap: what it queued for its Beam never reaches the other Beam, and gets there (once) when its Beam is back', async ctx => {
    const proxy = await ctx.prefixProxy(8826, 8821, '');
    ctx.defer(() => proxy.stop());
    const other = await ctx.startServer(8822);
    ctx.defer(() => other.stop());
    const ownId = (await (await fetch(`${ctx.srv.base}/api/hello`)).json()).serverId;
    const otherId = other.hello.serverId;
    const textsOn = async srv => (await (await fetch(`${srv.base}/api/items`, { headers: { Authorization: `Bearer ${srv.key}` } })).json()).items.map(i => i.text || '');
    const t1 = await ctx.signedIn({ base: proxy.base });
    await t1.waitFor(`live.serverId === '${ownId}'`, 8000, 'the old tab on its Beam');
    // Its Beam goes away (nothing listens on 8827); the old tab queues a message for it.
    proxy.upstream = 8827;
    await t1.evaluate(`(live.es?.close(), live.es = null, reconnectNow(), true)`);
    await t1.waitFor(`net.state === 'offline'`, 15000, 'offline');
    await t1.evaluate(`sendText('queued in the old tab', 'all').then(() => true)`);
    await t1.waitFor(`outbox.size === 1 && [...outbox.values()][0].serverId === '${ownId}' && idbGetAll('outbox').then(l => l.length === 1)`, 5000, 'queued for its Beam');
    // Another Beam answers now, and a second tab of the same browser signs in there (shared cookie and store).
    proxy.upstream = 8822;
    const t2 = await ctx.browser.newTabBeside(t1, { xff: ctx.nextIp() });
    ctx.defer(() => t2.close());
    await t2.goto(await ctx.keyLink(other, proxy.base));
    await t2.waitFor(`typeof paired !== 'undefined' && paired && cache.owner === '${otherId}'`, 15000, 'the second tab on the other Beam');
    // The old tab comes back (its retry, made at once here): the other Beam's stream; its message stays out of sight.
    await t1.evaluate(`(reconnectNow(), true)`);
    await t1.waitFor(`live.serverId === '${otherId}' && cache.owner === '${otherId}' && outbox.size === 0`, 10000, 'the old tab follows the store');
    await ctx.sleep(1500);
    eq((await textsOn(other)).filter(t => /old tab/.test(t)), [], 'the other Beam never got it');
    eq(await t1.evaluate(`idbGetAll('outbox').then(l => l.map(e => e.serverId === '${ownId}'))`), [true], 'still stored, for its Beam');
    // Its Beam is back and this browser signs in there again: the message goes out, once.
    await t1.goto('about:blank');
    proxy.upstream = 8821;
    await t2.goto(await ctx.keyLink(ctx.srv, proxy.base));
    await t2.waitFor(`typeof paired !== 'undefined' && paired && cache.owner === '${ownId}'`, 15000, 'signed in to its Beam again');
    const onOwn = async () => (await textsOn(ctx.srv)).filter(t => t === 'queued in the old tab').length;
    for (let i = 0; i < 50 && !(await onOwn()); i++) await ctx.sleep(200);
    await ctx.sleep(1000);
    eq(await onOwn(), 1, 'delivered to its Beam, once');
    eq((await textsOn(other)).filter(t => /old tab/.test(t)), [], 'and never to the other Beam');
  });

  test('an old tab that queues messages after another tab handed the store to another Beam: both are kept and reach their Beam once, never the other', async ctx => {
    const proxy = await ctx.prefixProxy(8826, 8821, '');
    ctx.defer(() => proxy.stop());
    const other = await ctx.startServer(8822);
    ctx.defer(() => other.stop());
    const ownId = (await (await fetch(`${ctx.srv.base}/api/hello`)).json()).serverId;
    const otherId = other.hello.serverId;
    const count = async (srv, text) => (await (await fetch(`${srv.base}/api/items`, { headers: { Authorization: `Bearer ${srv.key}` } })).json()).items.filter(i => i.text === text).length;
    const M1 = 'M1 queued before the other tab signed in elsewhere';
    const M2 = 'M2 queued after the other tab signed in elsewhere';
    const t1 = await ctx.signedIn({ base: proxy.base });
    await t1.waitFor(`live.serverId === '${ownId}'`, 8000, 'the old tab on its Beam');
    // (Its service worker takes charge of it first: the requests of a page it took over after interception started
    // weren't intercepted any more.)
    await t1.waitFor(`navigator.serviceWorker.ready.then(() => Boolean(navigator.serviceWorker.controller))`, 10000, 'the old tab’s service worker in charge');
    // The old tab's own network goes down (every request it makes fails); the other tab's doesn't.
    const failed = [];
    const failAll = m => { if (m.method === 'Fetch.requestPaused') { failed.push(m.params.request.url.replace(/^.*?\/\/[^/]+/, '')); t1.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'InternetDisconnected' }).catch(() => {}); } };
    t1.on(failAll);
    await t1.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    // Interception takes effect a moment after Fetch.enable answers (later under load, or with a busy page just loaded):
    // wait until a probe request is caught before the reconnect goes out.
    await t1.waitFor(`fetch('api/hello?probe=' + Date.now(), { cache: 'no-store' }).then(() => false, () => true)`, 10000, 'the old tab’s requests intercepted');
    await t1.evaluate(`(live.es?.close(), live.es = null, reconnectNow(), true)`);
    try {
      await t1.waitFor(`net.state === 'offline'`, 15000, 'the old tab offline');
    } catch (err) {
      const why = await t1.evaluate(`JSON.stringify({ net: net.state, es: live.es?.readyState ?? null, timer: Boolean(live.timer), retryAt: live.retryAt ? live.retryAt - Date.now() : 0, attempt: live.attempt, paired, dormant })`).catch(e => e.message);
      throw new Error(`${err.message}: ${why}; failed: ${JSON.stringify(failed.slice(0, 12))}`);
    }
    await t1.evaluate(`sendText(${JSON.stringify(M1)}, 'all').then(() => true)`);
    // Another Beam answers; a second tab signs in there and its catch-up hands the store to that Beam.
    proxy.upstream = 8822;
    const t2 = await ctx.browser.newTabBeside(t1, { xff: ctx.nextIp() });
    ctx.defer(() => t2.close());
    await t2.goto(await ctx.keyLink(other, proxy.base));
    await t2.waitFor(`typeof paired !== 'undefined' && paired && cache.owner === '${otherId}' && live.serverId === '${otherId}'`, 15000, 'the second tab on the other Beam');
    await t2.waitFor(`kvGet('meta').then(m => m?.serverId === '${otherId}')`, 5000, 'the store is the other Beam’s');
    // The old tab, still offline as far as it knows, gets another message written: it's stored, for its own Beam.
    await t1.evaluate(`sendText(${JSON.stringify(M2)}, 'all').then(() => true)`);
    await t1.waitFor(`[...outbox.values()].every(e => e.stored && !e.unsaved)`, 5000, 'both stored');
    eq(await t2.evaluate(`idbGetAll('outbox').then(l => l.map(e => [e.text, e.serverId === '${ownId}']).sort())`), [[M1, true], [M2, true]], 'both stored, for its own Beam');
    // The old tab gets its network back: it reaches the other Beam (shared cookie), which gets nothing.
    await t1.send('Fetch.disable');
    t1.off(failAll);
    await t1.evaluate(`(reconnectNow(), true)`);
    await t1.waitFor(`live.serverId === '${otherId}' && cache.owner === '${otherId}' && outbox.size === 0`, 10000, 'the old tab follows the store');
    await ctx.sleep(1000);
    eq([await count(other, M1), await count(other, M2)], [0, 0], 'the other Beam got neither');
    // Its own Beam is back; the second tab signs in there, and the old tab follows: each message reaches it once.
    proxy.upstream = 8821;
    await t2.goto(await ctx.keyLink(ctx.srv, proxy.base));
    await t2.waitFor(`typeof paired !== 'undefined' && paired && live.serverId === '${ownId}'`, 15000, 'the second tab on its Beam');
    await t1.evaluate(`(reconnectNow(), true)`);
    for (let i = 0; i < 50 && ((await count(ctx.srv, M1)) < 1 || (await count(ctx.srv, M2)) < 1); i++) await ctx.sleep(200);
    await ctx.sleep(2000);
    eq([await count(ctx.srv, M1), await count(ctx.srv, M2)], [1, 1], 'its own Beam got each once');
    eq([await count(other, M1), await count(other, M2)], [0, 0], 'the other Beam still none');
    eq(await t2.evaluate(`idbGetAll('outbox').then(l => l.length)`), 0, 'nothing left queued');
  });

  test('signed in to another Beam by itself (this PC’s Beam app is signed in there): the history is replaced, what was queued stays for its Beam (Settings says so) and gets there later', async ctx => {
    const proxy = await ctx.prefixProxy(8826, 8821, '');
    ctx.defer(() => proxy.stop());
    // This browser and the Beam app run on one machine: they come from the same address.
    const xff = ctx.nextIp();
    const page = await ctx.signedIn({ base: proxy.base, xff });
    const meId = await page.evaluate('me.id');
    const ownId = (await (await fetch(`${ctx.srv.base}/api/hello`)).json()).serverId;
    const textsOn = async srv => (await (await fetch(`${srv.base}/api/items`, { headers: { Authorization: `Bearer ${srv.key}` } })).json()).items.map(i => i.text || '');
    const phone = dev(ctx, 'Pixel');
    await phone.me();
    await phone.text('history on its Beam', [meId]);
    await page.waitFor(`items.some(i => i.text === 'history on its Beam')`, 8000, 'history');
    // Its Beam goes away; a message is written meanwhile.
    proxy.upstream = 8827;
    await page.evaluate(`(live.es?.close(), live.es = null, reconnectNow(), true)`);
    await page.waitFor(`net.state === 'offline'`, 15000, 'offline');
    await page.evaluate(`sendText('written while its Beam was down', 'all').then(() => true)`);
    await page.waitFor(`(cache.flushPending(), idbGetAll('outbox').then(l => l.length === 1))`, 5000, 'queued');
    await page.goto('about:blank');
    // A fresh Beam answers at the address, and the Beam app on this PC is signed in there and online.
    const other = await ctx.startServer(8822);
    ctx.defer(() => other.stop());
    const otherId = other.hello.serverId;
    const app = other.device(`win${ctx.uid()}${ctx.uid()}`, 'This PC', 'windows', xff);
    await app.me();
    const appOffline = app.online();
    ctx.defer(() => appOffline());
    await ctx.sleep(300);
    proxy.upstream = 8822;
    await page.goto(`${proxy.base}/`);
    await page.waitFor(`typeof paired !== 'undefined' && paired && cache.owner === '${otherId}'`, 15000, 'signed in to the other Beam by itself');
    await ctx.sleep(1000);
    eq(await page.evaluate(`idbGetAll('outbox').then(l => [items.some(i => i.text === 'history on its Beam'), outbox.size, l.length])`), [false, 0, 1], 'the old history is gone, its outbox stored, out of sight');
    eq((await textsOn(other)).filter(t => /written while/.test(t)), [], 'not sent to the other Beam');
    await page.evaluate(`openSettings('device'); true`);
    await page.waitFor(`$('#settingsDlg').open && /1 unsent message for another Beam server/.test($('#settingsDlg').textContent)`, 5000, 'Settings → This device says so');
    await page.evaluate(`$('#settingsDlg').close(); true`);
    // Its Beam is back, and this browser signs in there again: the message goes out.
    appOffline();
    await page.goto('about:blank');
    proxy.upstream = 8821;
    await page.goto(await ctx.keyLink(ctx.srv, proxy.base));
    await page.waitFor(`typeof paired !== 'undefined' && paired && cache.owner === '${ownId}'`, 15000, 'signed in to its Beam again');
    const delivered = async () => (await textsOn(ctx.srv)).includes('written while its Beam was down');
    for (let i = 0; i < 50 && !(await delivered()); i++) await ctx.sleep(200);
    assert(await delivered(), 'its Beam got the message');
    eq((await textsOn(other)).filter(t => /written while/.test(t)), [], 'the other Beam never did');
  });

  test('dormant on the sign-in page: its own Beam answering again is noticed (the cookie is tried again) and the history is back', async ctx => {
    const proxy = await ctx.prefixProxy(8826, 8821, '');
    ctx.defer(() => proxy.stop());
    const page = await ctx.signedIn({ base: proxy.base });
    const meId = await page.evaluate('me.id');
    const phone = dev(ctx, 'Pixel');
    await phone.me();
    await phone.text('kept while away', [meId]);
    await page.waitFor(`items.some(i => i.text === 'kept while away')`, 8000, 'history');
    await page.waitFor(`(cache.flushPending(), idbGetAll('items').then(l => l.some(i => i.text === 'kept while away')))`, 5000, 'saved');
    const other = await ctx.startServer(8822);
    ctx.defer(() => other.stop());
    await page.goto('about:blank');
    await ctx.sleep(300);
    proxy.upstream = 8822;
    await page.goto(`${proxy.base}/`);
    await page.waitFor(`typeof paired !== 'undefined' && !paired && !$('#lock').hidden && dormant`, 10000, 'dormant on the sign-in page');
    // Its Beam answers again at the address; the page is still on the sign-in page. Shown again (the timer would also
    // try, after 30 s, then 1, 2, 4, 5 min), it tries the cookie it still has.
    proxy.upstream = 8821;
    await ctx.setHidden(page, true);
    await ctx.setHidden(page, false);
    await page.waitFor(`(paired && !dormant && $('#lock').hidden && items.some(i => i.text === 'kept while away')) || JSON.stringify({ paired, dormant, lock: !$('#lock').hidden, items: items.length, reprobe: Boolean(reprobeTimer), hidden: document.hidden, net: net.state })`, 10000, 'back on its Beam, the history with it');
  });

  test('signed out while away: the saved history shows for a moment at most, then everything cached is wiped (a 502 keeps it)', async ctx => {
    const proxy = await ctx.proxy(8826, 8821);
    ctx.defer(() => proxy.stop());
    const page = await ctx.signedIn({ base: proxy.base });
    const meId = await page.evaluate('me.id');
    const phone = dev(ctx, 'Pixel');
    await phone.me();
    for (let i = 0; i < 5; i++) await phone.text(`private ${i}`, [meId]);
    await page.waitFor(`deviceById('${phone.id}') !== undefined && itemsIn('${phone.id}').length === 5`, 8000, 'history');
    await page.evaluate(`openConv('${phone.id}'); true`);
    // Also something waiting in the share cache and in the outbox.
    await page.evaluate(`caches.open('beam-share').then(c => c.put(new Request('share/x'), new Response('shared secret', { headers: { 'X-Kind': 'text' } }))).then(() => true)`);
    await page.evaluate(`outboxStore.put({ id: 'otest', kind: 'text', text: 'queued secret', conv: '${phone.id}', to: ['${phone.id}'], created: Date.now(), deviceId: me.id }).then(() => true)`);
    await page.waitFor(`(cache.flushPending(), idbGetAll('items').then(l => l.length >= 5))`, 5000, 'saved');
    // The server is down (a 502): offline mode, the saved history opens and stays.
    proxy.mode = '502';
    proxy.resetAll();
    await page.reload();
    await page.waitFor(`typeof items !== 'undefined' && items.some(i => i.text === 'private 4') && document.querySelector('#thread .msg') !== null`, 10000, 'history from the cache while the server is down');
    eq(await page.evaluate(`idbGetAll('items').then(l => l.length >= 5)`), true, 'kept on a 502');
    proxy.mode = 'pass';
    await page.goto('about:blank');
    // Signed out from another device while this one was closed.
    eq((await fetch(`${ctx.srv.base}/api/devices/${meId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ctx.srv.key}` } })).status, 204, 'revoked');
    // Requests to clear the browser's HTTP cache (POST /api/clear-cache), with the server's answers.
    const cleared = [];
    page.on(m => { if (m.method === 'Network.responseReceived' && /\/api\/clear-cache$/.test(m.params.response.url)) cleared.push(m.params.response.status); });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const t = window.__wipe = { shown: 0, gone: 0 }; new MutationObserver(() => { const n = document.querySelectorAll('#thread .msg').length; if (n && !t.shown) t.shown = performance.now(); if (t.shown && !n && !t.gone) t.gone = performance.now(); }).observe(document, { subtree: true, childList: true }); })()` });
    await page.goto(`${proxy.base}/`);
    await page.waitFor(`typeof paired !== 'undefined' && !paired && !$('#lock').hidden`, 10000, 'the sign-in page');
    await ctx.sleep(500);
    const r = await page.evaluate(`Promise.all([idbGetAll('items'), kvGet('meta'), kvGet('cursor'), idbGetAll('outbox'), caches.has('beam-share')]).then(([saved, meta, cursor, queued, share]) => ({
      saved: saved.length, meta: Boolean(meta), cursor: cursor || '', queued: queued.length, share, inMemory: items.length, onPage: document.querySelectorAll('#thread .msg').length,
      shownFor: __wipe.shown ? (__wipe.gone ? Math.round(__wipe.gone - __wipe.shown) : -1) : 0 }))`);
    eq([r.saved, r.meta, r.cursor, r.queued, r.share, r.inMemory, r.onPage], [0, false, '', 0, false, 0, 0], 'nothing of it is left');
    assert(r.shownFor >= 0 && r.shownFor < 1500, `the saved history showed for a moment at most (${r.shownFor} ms)`);
    for (let n = 0; n < 50 && !cleared.length; n++) await ctx.sleep(100);
    eq(cleared, [204], 'the browser’s HTTP cache too (thumbnails, files viewed inline)');
  });

  test('sign-in page: asks only while visible, withdraws when hidden, "new code" after two renewals', async ctx => {
    const page = await lockPage(ctx);
    const code = await page.evaluate(`pendingLogin.code`);
    assert((await pending(ctx.srv)).some(r => r.code === code), 'request pending while the page is visible');
    await ctx.setHidden(page, true);
    await ctx.sleep(600);
    assert(!(await pending(ctx.srv)).some(r => r.code === code), 'withdrawn when the page is hidden');
    await ctx.setHidden(page, false);
    await page.waitFor(`pendingLogin && pendingLogin.code !== '${code}'`, 10000, 'new request when visible again');
    // Let three requests run out (the test withdraws them, which looks like expiry to the page).
    for (let i = 0; i < 3; i++) {
      const r = await page.evaluate(`JSON.stringify({ id: pendingLogin.id, secret: pendingLogin.secret })`).then(JSON.parse);
      await fetch(`${ctx.srv.base}/api/login-requests/${r.id}`, { method: 'DELETE', headers: { 'X-Beam-Login-Secret': r.secret } });
      if (i < 2) await page.waitFor(`pendingLogin && pendingLogin.id !== '${r.id}'`, 25000, `renewal ${i + 1}`);
    }
    await page.waitFor(`!$('#newCodeBtn').hidden`, 25000, '"Tap for a new code"');
    await ctx.sleep(500);
    const myId = await page.evaluate('me.id');
    eq((await pending(ctx.srv)).filter(r => r.deviceId === myId).length, 0, 'nothing pending for this browser');
    assert(await page.evaluate('!pendingLogin'), 'stopped asking');
    await page.evaluate(`$('#newCodeBtn').click()`);
    await page.waitFor(`Boolean(pendingLogin)`, 10000, 'asks again after the tap');
  }, { timeout: 90000 });

  test('sign-in page: a spinner (not a broken image) while the code loads', async ctx => {
    const page = await lockPage(ctx);
    const r = await page.evaluate(`(() => {
      $('#loginQr').removeAttribute('src'); $('#loginCode').textContent = '';
      return [getComputedStyle($('#loginQr')).visibility, getComputedStyle($('#loginQrWrap'), '::after').animationName, getComputedStyle($('#loginCode'), '::before').animationName];
    })()`);
    eq(r, ['hidden', 'spin', 'pulse'], 'placeholder states');
  });

  test('sign-in page: using the password withdraws the request, and no device is left asking', async ctx => {
    const srv = await ctx.startServer(8822); // own server: no requests left over from other tests
    ctx.defer(() => srv.stop());
    const admin = dev(ctx, 'Admin', 'windows', srv);
    await admin.post('/api/password', { password: 'correct horse battery' });
    const other = await ctx.signedIn({ server: srv });
    const page = await lockPage(ctx, { server: srv });
    const code = await page.evaluate(`pendingLogin.code`);
    await other.waitFor(`$('#approveDlg').open && $('#approveCode').textContent === '${code}'`, 8000, 'the other device is asked');
    await page.evaluate(`$('#keyInput').value = 'correct horse battery'; $('#lockForm').requestSubmit()`);
    await page.waitFor(`paired && !$('#app').hidden`, 10000, 'signed in');
    await ctx.sleep(800);
    assert(!(await pending(srv)).some(r => r.code === code), 'request withdrawn');
    assert(await other.evaluate(`!$('#approveDlg').open`), 'the other device stopped asking');
    assert(await page.evaluate(`!$('#approveDlg').open`), 'the page does not ask about itself');
    await admin.post('/api/password', { password: '' });
  });

  test('approvals queue up, never swap under the user, and Approve waits a moment', async ctx => {
    const srv = await ctx.startServer(8822);
    ctx.defer(() => srv.stop());
    const page = await ctx.signedIn({ server: srv });
    const mk = async name => (await fetch(`${srv.base}/api/login-requests`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ctx.nextIp() }, body: JSON.stringify({ name, platform: 'web' }) })).json();
    const r1 = await mk('Laptop one');
    await page.waitFor(`$('#approveDlg').open && $('#approveCode').textContent === '${r1.code}'`, 8000, 'first request shown');
    assert(await page.evaluate(`$('#approveBtn').disabled`), 'Approve disabled right after it appears');
    const r2 = await mk('Laptop two');
    await page.waitFor(`!$('#approveQueue').hidden`, 5000, 'second request queued');
    eq(await page.evaluate(`$('#approveCode').textContent`), r1.code, 'still showing the first request');
    await ctx.sleep(1100);
    assert(await page.evaluate(`!$('#approveBtn').disabled`), 'Approve works after a second');
    await page.evaluate(`$('#denyBtn').click()`);
    await page.waitFor(`$('#approveCode').textContent === '${r2.code}'`, 5000, 'the next request follows');
    assert(await page.evaluate(`$('#approveBtn').disabled`), 'Approve disabled again for the new content');
    await ctx.sleep(1100);
    await page.evaluate(`$('#approveBtn').click()`);
    const poll = await (await fetch(`${srv.base}/api/login-requests/${r2.id}?wait`, { headers: { 'X-Beam-Login-Secret': r2.secret } })).json();
    eq(poll.status, 'approved', 'the second one was approved');
    await page.waitFor(`!$('#approveDlg').open`, 5000, 'dialog closed');
  });

  test('a signed-out phone opening an approve link is asked to sign in first, then gets the prompt', async ctx => {
    const r = await (await fetch(`${ctx.srv.base}/api/login-requests`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ctx.nextIp() }, body: JSON.stringify({ name: 'New laptop', platform: 'web' }) })).json();
    const admin = dev(ctx, 'Admin', 'windows');
    await admin.post('/api/password', { password: 'correct horse battery' });
    const page = await lockPage(ctx, { query: `?approve=${r.code}`, width: 390, height: 844, mobile: true });
    const note = await page.evaluate(`$('#approveNote').hidden ? '' : $('#approveNote').textContent`);
    assert(note.includes(r.code), `explains why: ${note}`);
    assert(await page.evaluate(`$('#loginQrWrap').hidden && !$('#showQrBtn').hidden`), 'a phone leads with the code, not the QR');
    await page.evaluate(`$('#keyInput').value = 'correct horse battery'; $('#lockForm').requestSubmit()`);
    await page.waitFor(`$('#approveDlg').open && $('#approveCode').textContent === '${r.code}'`, 10000, 'approve prompt after sign-in');
    await admin.post('/api/password', { password: '' });
  });

  test('a borrowed computer (session sign-in) keeps nothing and shows as temporary', async ctx => {
    const admin = dev(ctx, 'Admin', 'windows');
    await admin.post('/api/password', { password: 'correct horse battery' });
    const page = await lockPage(ctx);
    await page.evaluate(`$('#sharedPc').checked = true; $('#keyInput').value = 'correct horse battery'; $('#lockForm').requestSubmit()`);
    await page.waitFor(`paired && net.state === 'online'`, 10000, 'signed in');
    const meId = await page.evaluate('me.id');
    await admin.text('something private', [meId]);
    await page.waitFor(`items.some(i => i.text === 'something private')`);
    await ctx.sleep(1200);
    const stored = await page.evaluate(`idbGetAll('items').then(l => l.length)`);
    eq(stored, 0, 'no history written to disk');
    const d = (await admin.get('/api/devices')).devices.find(x => x.id === meId);
    eq(d?.temporary, true, 'the server marks the device temporary');
    const cookie = (await page.send('Network.getCookies', { urls: [ctx.srv.base] })).cookies.find(c => c.name === 'beam_key');
    assert(cookie && cookie.session, 'the sign-in cookie ends with the browser session');
    await admin.post('/api/password', { password: '' });
  });

  test('the sign-in page signs in by itself once a Beam app runs on the same machine', async ctx => {
    // No X-Forwarded-For: this browser is on the server machine itself, like the app below.
    const page = await ctx.browser.newPage({});
    await page.goto(`${ctx.srv.base}/`);
    await page.waitFor(`!$('#lock').hidden`, 10000, 'sign-in page');
    const app = ctx.srv.device(`win${ctx.uid()}${ctx.uid()}`, 'This PC', 'windows', undefined);
    delete app.headers['X-Forwarded-For'];
    const stop = app.online();
    ctx.defer(stop);
    await page.waitFor(`paired && !$('#app').hidden`, 25000, 'signed in automatically');
  }, { timeout: 60000 });

  test('signed out elsewhere: the page explains and shows the sign-in screen', async ctx => {
    const page = await ctx.signedIn();
    const meId = await page.evaluate('me.id');
    const admin = dev(ctx, 'Admin', 'windows');
    await admin.me();
    await admin.forget(meId); // revokes this browser's sign-in
    await page.evaluate(`api('api/me').catch(() => {})`);
    await page.waitFor(`!$('#lock').hidden`, 10000, 'lock screen');
    const msg = await page.evaluate(`$('#lockMsg').textContent`);
    assert(/signed out/i.test(msg), `explains: ${msg}`);
  });

  test('moved: only http(s) addresses are followed', async ctx => {
    const page = await ctx.signedIn();
    await page.evaluate(`onMoved('javascript:alert(1)')`);
    eq(await page.evaluate(`[$('#lockTitle').textContent, $('#lockMsg').querySelector('a') === null]`), ['Beam has moved', true], 'no link for a non-http address');
    await page.evaluate(`clearTimeout(movedTimer); onMoved('https://beam.example.ts.net'); clearTimeout(movedTimer)`);
    eq(await page.evaluate(`$('#lockMsg a')?.getAttribute('href')`), 'https://beam.example.ts.net/', 'a proper link');
  });

  test('moving the server: the browser follows with a handoff and stays the same device', async ctx => {
    const oldSrv = await ctx.startServer(8823);
    ctx.defer(() => oldSrv.stop());
    const page = await ctx.signedIn({ server: oldSrv });
    const meId = await page.evaluate('me.id');
    await page.evaluate(`sendText('before the move', 'all')`);
    await ctx.sleep(500);
    // The new server starts from a copy of the old one's data (same key, serverId, devices, items).
    const newData = path.join(ctx.TMP, `moved-${Date.now()}`);
    fs.cpSync(oldSrv.data, newData, { recursive: true });
    const { Scratch } = await import('./harness.mjs');
    const newSrv = new Scratch(ctx.SERVER, 8824);
    newSrv.data = newData;
    await newSrv.start();
    ctx.defer(() => newSrv.stop());
    const res = await fetch(`${oldSrv.base}/api/move`, { method: 'POST', headers: { Authorization: `Bearer ${oldSrv.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ to: newSrv.base }) });
    assert(res.ok, `move accepted (${res.status} ${await res.text()})`);
    await page.waitFor(`location.origin === '${newSrv.base}' && typeof paired !== 'undefined' && paired`, 30000, 'arrived at the new address, signed in');
    eq(await page.evaluate('me.id'), meId, 'same device id');
    await page.waitFor(`items.some(i => i.text === 'before the move')`, 10000, 'history is there');
  }, { timeout: 90000 });
}
