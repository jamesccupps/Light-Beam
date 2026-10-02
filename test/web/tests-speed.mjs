// Speed round (1.4.0): background event streams and pokes (P1), delta catch-ups (P2), downloads of files still
// arriving (P4), upload pieces sized to the link (P5), versioned app files from the service worker, the instant
// send bubble, and hidden pages that render nothing.
import { assert, eq } from './harness.mjs';
import { dev } from './tests-core.mjs';

const auth = srv => ({ Authorization: `Bearer ${srv.key}` });
const metrics = srv => fetch(`${srv.base}/api/metrics`, { headers: auth(srv) }).then(r => r.json());
const streamOf = async (srv, device) => (await metrics(srv)).streams.find(s => s.device === device && s.kind === 'web');
const until = async (ctx, fn, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end; await ctx.sleep(100)) { const v = await fn(); if (v) return v; } return null; };

export default function register(test) {
  test('background mode: a hidden page asks the server to hold what isn’t urgent; on screen again it pokes back', async ctx => {
    const page = await ctx.signedIn();
    const meId = await page.evaluate('me.id');
    await page.waitFor(`live.stream !== '' && serverHas('stream-modes')`, 8000, 'stream id from hello');
    eq((await streamOf(ctx.srv, meId))?.mode, 'foreground', 'visible: foreground');
    const pokes = ctx.track(page, /\/api\/events\/poke$/);
    await page.evaluate(`window.__es = live.es; true`);
    await ctx.setHidden(page, true);
    assert(await until(ctx, async () => (await streamOf(ctx.srv, meId))?.mode === 'background'), 'hidden: background');
    eq((await streamOf(ctx.srv, meId)).ping, 180, 'a heartbeat every 3 minutes');
    await ctx.setHidden(page, false);
    assert(await until(ctx, async () => (await streamOf(ctx.srv, meId))?.mode === 'foreground'), 'back on screen: foreground');
    await ctx.sleep(5500); // the poke's ping arrived, so nothing reconnects
    eq(await page.evaluate(`live.es === window.__es && net.state === 'online'`), true, 'the same stream, no reconnect');
    eq(pokes.length, 2, 'one poke each way');
  });

  test('background mode: the stream isn’t taken for dead before the longer heartbeat, even when the poke’s answer is late', async ctx => {
    const page = await ctx.signedIn();
    const meId = await page.evaluate('me.id');
    await page.waitFor(`live.stream !== ''`, 8000, 'stream id');
    // Hold the poke's answer (a suspended page would get it late); the server has switched to background already.
    const held = [];
    page.on(m => { if (m.method === 'Fetch.requestPaused') held.push(m.params.requestId); });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/events/poke', requestStage: 'Response' }] });
    await page.evaluate(`window.__es = live.es; true`);
    await ctx.setHidden(page, true);
    assert(await until(ctx, async () => (await streamOf(ctx.srv, meId))?.mode === 'background'), 'background on the server');
    await ctx.sleep(75000); // the old 70 s limit, and then some: no heartbeat comes for 3 minutes now
    eq(await page.evaluate(`live.es === window.__es && live.es.readyState === 1`), true, 'the same stream after 75 s');
    for (const id of held) await page.send('Fetch.continueRequest', { requestId: id }).catch(() => {});
    await page.send('Fetch.disable');
    await ctx.setHidden(page, false);
  }, { timeout: 120000 });

  test('delta catch-up: a deletion always lands, even for an item this page just touched or holds for Undo', async ctx => {
    const page = await ctx.signedIn();
    const meId = await page.evaluate('me.id');
    const phone = dev(ctx, 'Pixel');
    await phone.me();
    for (let i = 0; i < 4; i++) await phone.text(`doomed ${i}`, [meId]);
    await page.waitFor(`itemsIn('${phone.id}').length === 4 && live.cursor !== ''`, 10000, 'history and a cursor');
    await page.waitFor(`(cache.flushPending(), idbGetAll('items').then(l => l.length >= 4))`, 5000, 'saved');
    const list = await phone.items();
    const touched = list.find(i => i.text === 'doomed 1').id;
    const held = list.find(i => i.text === 'doomed 2').id;
    // One changed here after the catch-up began, one deleted here with Undo still on offer; the delta says both are gone.
    const r = await page.evaluate(`(async () => {
      touchItem('${touched}');
      deleteItems(['${held}']);
      applyDelta({ items: [], deleted: ['${touched}', '${held}'] }, 0);
      cache.flushPending();
      await new Promise(res => setTimeout(res, 300));
      const saved = (await idbGetAll('items')).map(i => i.id);
      return [itemMap.has('${touched}'), pendingDeletes.has('${held}'), saved.includes('${touched}'), saved.includes('${held}')];
    })()`);
    eq(r, [false, false, false, false], 'gone from memory, from Undo and from the saved history');
  });

  test('"Receiving…" rows of uploads that ended while the page wasn’t listening go away', async ctx => {
    const page = await ctx.signedIn();
    const meId = await page.evaluate('me.id');
    const phone = dev(ctx, 'Pixel');
    await phone.me();
    await page.waitFor(`deviceById('${phone.id}') !== undefined`, 8000, 'phone known');
    await page.evaluate(`openConv('${phone.id}'); true`);
    const start = async name => {
      const up = await phone.post('/api/uploads', { name, size: 2000000, mime: 'application/octet-stream', to: [meId] });
      await page.waitFor(`incoming.has('${up.id}') && document.querySelector('#thread .msg.pending') !== null`, 8000, `receiving ${name}`);
      return up;
    };
    // Cancelled while the stream was down: the catch-up after the reconnect clears the row.
    const a = await start('never.bin');
    await page.evaluate(`stopLive(); true`);
    await phone.del(`/api/uploads/${a.id}`);
    await page.evaluate(`connect(); true`);
    await page.waitFor(`!incoming.has('${a.id}') && document.querySelector('#thread .msg.pending') === null`, 8000, 'row gone after the catch-up');
    // Cancelled and never heard of: its Save button finds nothing, and the row goes.
    const b = await start('gone.bin');
    await page.evaluate(`stopLive(); true`);
    await phone.del(`/api/uploads/${b.id}`);
    await page.evaluate(`document.querySelector('#thread .msg.pending a.mini[download]').click(); true`);
    await page.waitFor(`!incoming.has('${b.id}') && document.querySelector('#thread .msg.pending') === null`, 8000, 'row gone after Save found nothing');
  });

  test('background mode: one poke at a time, so a quick hide and show ends in foreground', async ctx => {
    const page = await ctx.signedIn();
    const meId = await page.evaluate('me.id');
    await page.waitFor(`live.stream !== ''`, 8000, 'stream id');
    const held = [];
    let pass = false;
    page.on(m => {
      if (m.method !== 'Fetch.requestPaused') return;
      if (pass) page.send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
      else held.push(m.params);
    });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/events/poke', requestStage: 'Request' }] });
    await ctx.setHidden(page, true);
    assert(await until(ctx, () => held.length > 0, 3000), 'the background poke is on its way');
    await ctx.setHidden(page, false);
    await ctx.sleep(500);
    eq(held.map(p => JSON.parse(p.request.postData || '{}').mode), ['background'], 'only the first poke is on its way');
    pass = true;
    for (const p of held) await page.send('Fetch.continueRequest', { requestId: p.requestId });
    assert(await until(ctx, async () => (await streamOf(ctx.srv, meId))?.mode === 'foreground' && await page.evaluate(`live.mode === 'foreground' && !live.pokeBusy`)), 'ends in foreground');
    await page.send('Fetch.disable');
  });

  test('background mode: hidden pokes, but a page being left (reload, navigation, close) doesn’t', async ctx => {
    // Counted on the wire (DevTools doesn't always report a request made as the page goes).
    const proxy = await ctx.proxy(8826, 8821);
    ctx.defer(() => proxy.stop());
    const pokes = [];
    proxy.rules.push(({ dir, text }) => { if (dir === 'up') for (const m of text.matchAll(/^POST \/api\/events\/poke /gm)) pokes.push(m.index); });
    const page = await ctx.signedIn({ base: proxy.base });
    await page.waitFor(`live.stream !== ''`, 8000, 'stream id');
    await ctx.setHidden(page, true);
    assert(await until(ctx, () => pokes.length === 1, 3000), 'hidden: background');
    await ctx.setHidden(page, false);
    assert(await until(ctx, () => pokes.length === 2, 3000), 'shown: foreground');
    await page.goto('about:blank'); // its stream closes anyway; a request still in flight would only meet the next page
    await ctx.sleep(500);
    eq(pokes.length, 2, 'no poke on the way out');
  });

  test('background mode: a poke that gets no answer (network error, 502) is retried after a pause, not at once', async ctx => {
    const page = await ctx.signedIn();
    await page.waitFor(`live.stream !== '' && live.mode === 'foreground'`, 8000, 'stream id');
    for (const [how, fail] of [['network error', 'fail'], ['502 from a proxy', '502']]) {
      let pokes = 0;
      const onPaused = m => {
        if (m.method !== 'Fetch.requestPaused') return;
        pokes++;
        if (fail === 'fail') page.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'ConnectionRefused' }).catch(() => {});
        else page.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 502, responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }], body: Buffer.from('Bad Gateway').toString('base64') }).catch(() => {});
      };
      page.on(onPaused);
      await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/events/poke', requestStage: 'Request' }] });
      await ctx.setHidden(page, true);
      await ctx.sleep(4000);
      // Before: about 2,500 requests in 3 s. Now one, then the next try after about 15 s (then 30 s, 1 min… 5 min).
      assert(pokes >= 1 && pokes <= 2, `${how}: ${pokes} poke requests in 4 s while hidden`);
      eq(await page.evaluate(`[live.pokeFailures, live.pokeRetry !== null, live.pokeBusy, Boolean(live.es)]`), [1, true, false, true], `${how}: one failure, a retry waiting, the stream kept`);
      await page.send('Fetch.disable');
      page.off(onPaused);
      // Shown again: a foreground poke goes at once (and works), which ends the waiting retry.
      await ctx.setHidden(page, false);
      await page.waitFor(`live.mode === 'foreground' && !live.pokeBusy && live.pokeRetry === null && live.pokeFailures === 0 && Boolean(live.es)`, 10000, `${how}: foreground again`);
    }
  });

  test('two tabs: once another tab has written, a tab stores no cursor until it has written its whole list again', async ctx => {
    // Two tabs of one browser: they share the cookie and IndexedDB (the default context; cleared afterwards).
    const tab1 = await ctx.browser.newPage({ fresh: false, xff: ctx.nextIp() });
    ctx.defer(() => tab1.send('Storage.clearDataForOrigin', { origin: ctx.srv.base, storageTypes: 'all' }).catch(() => {}));
    await tab1.goto(`${ctx.srv.base}/?key=${encodeURIComponent(ctx.srv.key)}`);
    await tab1.waitFor(`typeof paired !== 'undefined' && paired && net.state === 'online' && cache.cursor !== '' && !syncing`, 15000, 'tab 1 signed in, with a cursor');
    const tab2 = await ctx.browser.newPage({ fresh: false, xff: ctx.nextIp() });
    await tab2.goto(`${ctx.srv.base}/`);
    await tab2.waitFor(`typeof paired !== 'undefined' && paired && net.state === 'online' && cache.cursor !== '' && !syncing`, 15000, 'tab 2 too');
    await ctx.sleep(500);
    const stored = `kvGet('cursor').then(c => (c && c.cursor) || '')`;
    const write = (tab, expr) => tab.evaluate(`(${expr}, cache.flushPending(), true)`);
    // Tab 2 stores its own cursor (as after a catch-up of its own).
    await write(tab2, `cache.setCursor('cursor-of-tab-2')`);
    await tab1.waitFor(`${stored}.then(c => c === 'cursor-of-tab-2')`, 5000, 'tab 2 wrote');
    // Tab 1 writes an item: what's stored is no longer only its own, so no cursor.
    const item = n => `cache.putItem({ id: 'twotabs${n}', ts: Date.now(), kind: 'text', text: 'two tabs ${n}', from: me.id, to: [], delivered: {} })`;
    await write(tab1, item(1));
    await tab1.waitFor(`${stored}.then(c => c === '')`, 5000, 'no cursor after tab 2 wrote');
    // Still none on its next writes (the first fix trusted its own blank record again).
    for (const n of [2, 3]) {
      await write(tab1, item(n));
      await ctx.sleep(300);
      eq(await tab1.evaluate(stored), '', `still no cursor (write ${n})`);
    }
    // Its whole list written again: its own cursor fits what's stored.
    await write(tab1, `cache.replaceItems(items)`);
    const own = await tab1.evaluate('cache.cursor');
    await tab1.waitFor(`${stored}.then(c => c === ${JSON.stringify(own)})`, 5000, 'its cursor again after a full write');
  });

  test('background mode: a poke that finds the stream gone reconnects at once', async ctx => {
    const page = await ctx.signedIn();
    await page.waitFor(`live.stream !== ''`, 8000);
    await page.evaluate(`live.stream = 'gone00000000'; window.__es = live.es; true`); // as if the server had dropped it
    await ctx.setHidden(page, true);
    await ctx.setHidden(page, false);
    await page.waitFor(`live.es !== window.__es && live.es?.readyState === 1 && live.stream !== 'gone00000000' && live.stream !== ''`, 10000, 'a new stream');
  });

  test('delta catch-up: a reconnect brings only what changed, and a merge brings the whole list', async ctx => {
    const page = await ctx.signedIn();
    const meId = await page.evaluate('me.id');
    const phone = dev(ctx, 'Pixel');
    await phone.me();
    for (let i = 0; i < 40; i++) await phone.text(`history ${i} ${'x'.repeat(300)}`, [meId]);
    await page.waitFor(`itemsIn('${phone.id}').length === 40 && live.cursor !== ''`, 10000, 'history and a cursor');
    const lists = [];
    page.on(m => { if (m.method === 'Network.responseReceived' && /\/api\/items(\?|$)/.test(m.params.response.url)) lists.push(m.params.response.url); });
    const gone = (await phone.items()).find(i => i.text.startsWith('history 0 '));
    await page.evaluate(`stopLive(); true`);
    await phone.text('while you were away', [meId]);
    await phone.del(`/api/items/${gone.id}`);
    await page.evaluate(`connect(); true`);
    await page.waitFor(`items.some(i => i.text === 'while you were away') && !itemMap.has('${gone.id}')`, 10000, 'caught up');
    assert(lists.length >= 1 && lists.every(u => /[?&]since=/.test(u)), `delta requests: ${lists.join(', ')}`);
    eq(await page.evaluate(`itemsIn('${phone.id}').length`), 40, 'one gone, one new');
    lists.length = 0;
    await page.evaluate(`onEventRefresh({}); true`);
    await ctx.sleep(1500);
    assert(lists.length >= 1 && lists.every(u => !/since=/.test(u)), `after a merge, the whole list: ${lists.join(', ')}`);
  });

  test('live download: a file still arriving can be downloaded; the download follows the upload', async ctx => {
    const page = await ctx.signedIn();
    const meId = await page.evaluate('me.id');
    const phone = dev(ctx, 'Pixel');
    await phone.me();
    await page.waitFor(`deviceById('${phone.id}') !== undefined`, 8000, 'phone known');
    await page.evaluate(`openConv('${phone.id}'); true`);
    const size = 3 * 1024 * 1024;
    const body = Buffer.alloc(size, 7);
    const up = await phone.post('/api/uploads', { name: 'arriving.bin', size, mime: 'application/octet-stream', to: [meId] });
    const put = (from, to) => fetch(`${ctx.srv.base}/api/uploads/${up.id}?offset=${from}`, { method: 'PUT', headers: { ...phone.headers, 'Content-Type': 'application/octet-stream' }, body: body.subarray(from, to) });
    await put(0, size / 3);
    await page.waitFor(`document.querySelector('#thread .msg.pending a.mini[download]')?.getAttribute('href')?.endsWith('api/file/${up.id}')`, 8000, 'a download button on the incoming row');
    await page.evaluate(`window.__got = fetch($('#thread .msg.pending a.mini[download]').href).then(r => r.arrayBuffer()).then(b => b.byteLength); true`);
    await ctx.sleep(500);
    await put(size / 3, size);
    eq(await page.evaluate('__got'), size, 'the whole file, streamed as it arrived');
  });

  test('upload pieces: at least 64 MB and about 4 s each on servers with big-chunks, 8 MB on older ones', async ctx => {
    const page = await ctx.signedIn();
    const sizes = await page.evaluate(`[
      pieceSize({ maxChunk: 4e9, rate: 0, chunk: 8388608 }),
      pieceSize({ maxChunk: 4e9, rate: 50e6, chunk: 8388608 }),
      pieceSize({ maxChunk: 100e6, rate: 50e6, chunk: 8388608 }),
      pieceSize({ maxChunk: 4e9, rate: 50e6, chunk: 1048576, chunkCap: 1048576 }),
      pieceSize({ rate: 50e6, chunk: 8388608 }),
      pieceSize({ maxChunk: 4e9, rate: 50e6, chunk: 67108864, failures: 1 }),
    ]`);
    eq(sizes, [67108864, 200000000, 100000000, 1048576, 8388608, 8388608], 'piece sizes (small again after a failure)');
    const puts = ctx.track(page, /\/api\/uploads\/[0-9a-f]+\?offset=/);
    await page.evaluate(`sendFiles([new File([new Uint8Array(20 * 1024 * 1024)], 'twenty.bin')], 'all'); true`);
    await page.waitFor(`items.some(i => i.name === 'twenty.bin') && !uploads.size`, 20000, 'uploaded');
    eq(puts.length, 1, 'a 20 MB file goes in one piece');
  });

  test('versioned app files come from the service worker, not the server, once it has them', async ctx => {
    const page = await ctx.signedIn();
    await page.evaluate(`navigator.serviceWorker.ready.then(() => true)`); // installed (and its precache done)
    await page.reload();
    await page.waitFor(`typeof paired !== 'undefined' && paired && navigator.serviceWorker.controller !== null`, 10000, 'controlled by the service worker');
    const before = (await metrics(ctx.srv)).requests.static?.count || 0;
    await page.reload();
    await page.waitFor(`typeof paired !== 'undefined' && paired && net.state === 'online'`, 10000);
    const scripts = await page.evaluate(`[...document.scripts].map(s => s.getAttribute('src'))`);
    assert(scripts.every(s => /\?v=[0-9a-f]{10}$/.test(s)), `scripts are versioned: ${scripts.join(', ')}`);
    const after = (await metrics(ctx.srv)).requests.static?.count || 0;
    assert(after - before <= 2, `only the page itself (and at most sw.js) reached the server: ${after - before} static requests`);
  });

  test('send: the bubble shows at once (clock) and becomes the real message', async ctx => {
    const page = await ctx.signedIn();
    const phone = dev(ctx, 'Pixel');
    await phone.me();
    await page.waitFor(`deviceById('${phone.id}') !== undefined`, 8000, 'phone known');
    await page.evaluate(`openConv('${phone.id}'); true`);
    // Hold the send on its way to the server.
    const held = [];
    page.on(m => { if (m.method === 'Fetch.requestPaused') held.push(m.params.requestId); });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/text', requestStage: 'Request' }] });
    await ctx.sleep(200); // (interception takes effect a moment after Fetch.enable answers; under load it took longer)
    await page.evaluate(`$('#text').value = 'instant bubble'; $('#text').dispatchEvent(new Event('input', { bubbles: true })); $('#sendBtn').click(); true`);
    await page.waitFor(`[...document.querySelectorAll('#thread .msg')].some(m => m.textContent.includes('instant bubble') && m.querySelector('.tick[title="Sending…"]'))`, 3000, 'bubble before the server answers');
    for (let i = 0; i < 100 && held.length < 1; i++) await ctx.sleep(50); // (the paused request is reported a moment later)
    if (held.length !== 1) {
      const why = await page.evaluate(`JSON.stringify({ net: net.state, outbox: [...outbox.values()].map(e => ({ state: e.state, kind: e.kind, to: e.to, tries: e.tries, wait: e.retryAt ? e.retryAt - Date.now() : null })), stream: live.es?.readyState })`).catch(e => e.message);
      throw new Error(`the send is still on its way (${held.length} held): ${why}`);
    }
    for (const id of held) await page.send('Fetch.continueRequest', { requestId: id });
    await page.send('Fetch.disable');
    await page.waitFor(`items.some(i => i.text === 'instant bubble')`, 5000, 'confirmed');
    await ctx.sleep(800); // its event arrives too
    const shown = await page.evaluate(`[...document.querySelectorAll('#thread .msg')].filter(m => m.textContent.includes('instant bubble')).map(m => [m.dataset.id === items.find(i => i.text === 'instant bubble').id, Boolean(m.querySelector('.tick[title="Sending…"]'))])`);
    eq(shown, [[true, false]], 'exactly one bubble: the real message');
  });

  test('a hidden page renders nothing; the tab title still counts, and it all shows when it’s back', async ctx => {
    const page = await ctx.signedIn();
    const meId = await page.evaluate('me.id');
    const phone = dev(ctx, 'Pixel');
    await phone.me();
    await page.waitFor(`deviceById('${phone.id}') !== undefined`, 8000, 'phone known');
    await page.evaluate(`openConv('${phone.id}'); true`);
    await ctx.setHidden(page, true);
    await page.evaluate(`window.__mut = 0; new MutationObserver(ms => { __mut += ms.length; }).observe($('#app'), { subtree: true, childList: true, characterData: true }); true`);
    await phone.text('while hidden', [meId]);
    await page.waitFor(`items.some(i => i.text === 'while hidden')`, 8000, 'received');
    await ctx.sleep(300);
    eq(await page.evaluate(`[__mut, /\\(1\\) Beam/.test(document.title)]`), [0, true], 'nothing rendered, but the title counts it');
    await ctx.setHidden(page, false);
    await page.waitFor(`[...document.querySelectorAll('#thread .msg')].some(m => m.textContent.includes('while hidden'))`, 3000, 'rendered on return');
  });
}
