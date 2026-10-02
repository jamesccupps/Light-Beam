// Offline mode (cache, outbox, service worker), the dead-stream watchdog, reload after a deploy, path prefixes.
import fs from 'node:fs';
import path from 'node:path';
import { assert, eq, Scratch } from './harness.mjs';
import { dev } from './tests-core.mjs';

const serverItems = async server => (await (await fetch(`${server.base}/api/items`, { headers: { Authorization: `Bearer ${server.key}` } })).json()).items;
const swReady = page => page.waitFor(`navigator.serviceWorker.controller !== null`, 15000, 'service worker in control');

export default function register(test) {
  test('offline: history opens from the cache without a connection, and search works', async ctx => {
    const proxy = await ctx.proxy(8826, 8821);
    ctx.defer(() => proxy.stop());
    const page = await ctx.signedIn({ base: proxy.base });
    const meId = await page.evaluate('me.id');
    const phone = dev(ctx, 'Pixel');
    await phone.me();
    await phone.text('the wifi password is on the fridge', [meId]);
    await phone.text('second message', [meId]);
    await page.waitFor(`items.length >= 2`);
    await page.reload(); // let the service worker take control
    await page.waitFor(`paired && net.state === 'online'`);
    await swReady(page);
    await ctx.sleep(1200); // the cache writes are batched
    proxy.mode = 'refuse';
    proxy.resetAll();
    await page.reload();
    await page.waitFor(`typeof paired !== 'undefined' && !$('#app').hidden && items.length >= 2`, 10000, 'app with cached history');
    eq(await page.evaluate(`document.documentElement.dataset.shell`), 'cache', 'opened from the saved copy');
    await page.waitFor(`net.state === 'offline' && !$('#banner').hidden`, 10000, 'offline banner');
    assert(/Can’t reach Beam/.test(await page.evaluate(`$('#banner').textContent`)), 'banner explains');
    await page.evaluate(`openSearch(); $('#searchInput').value = 'fridge'; runSearch.flush()`);
    eq(await page.evaluate(`$$('#searchResults .search-hit').length`), 1, 'search finds it offline');
  });

  test('offline: messages and small files wait in the outbox (across a reload) and go out when Beam is back', async ctx => {
    const proxy = await ctx.proxy(8826, 8821);
    ctx.defer(() => proxy.stop());
    const page = await ctx.signedIn({ base: proxy.base });
    await swReady(page);
    await ctx.sleep(500);
    proxy.mode = 'refuse';
    proxy.resetAll();
    // Once the page has noticed the drop (else its own "connecting…" can land after this and win).
    await page.waitFor(`!live.es || live.es.readyState !== 1`, 5000, 'the page noticed the drop');
    await page.evaluate(`net.fail()`);
    await page.evaluate(`$('#text').value = 'written on the train'; onComposerInput(); sendComposer()`);
    await page.evaluate(`sendFiles([new File(['tiny offline file'], 'offline.txt', { type: 'text/plain' })], 'all')`);
    await page.waitFor(`outbox.size === 2 && $$('#thread .msg.outbox').length === 2`, 5000, 'two items waiting');
    assert(/Waiting to send/.test(await page.evaluate(`$('#thread .msg.outbox').textContent`)), 'says so');
    await ctx.sleep(600);
    await page.reload();
    await page.waitFor(`typeof outbox !== 'undefined' && outbox.size === 2`, 10000, 'still waiting after a reload').catch(async err => {
      throw new Error(`${err.message} ${await page.evaluate(`typeof outbox === 'undefined' ? document.body.innerText.slice(0, 200) : idbGetAll('outbox').then(l => JSON.stringify([outbox.size, l.length, l.map(e => e.deviceId), me.id]))`)}`);
    });
    proxy.mode = 'pass';
    await page.evaluate(`reconnectNow()`);
    await page.waitFor(`outbox.size === 0 && !uploads.size`, 20000, 'sent');
    const list = await serverItems(ctx.srv);
    assert(list.some(i => i.text === 'written on the train'), 'text arrived');
    assert(list.some(i => i.name === 'offline.txt'), 'file arrived');
    eq(list.filter(i => i.text === 'written on the train').length, 1, 'sent once');
  });

  test('service worker: the saved app opens when the server is down (502) or silent (3 s)', async ctx => {
    const proxy = await ctx.proxy(8826, 8821);
    ctx.defer(() => proxy.stop());
    const page = await ctx.signedIn({ base: proxy.base });
    await page.reload();
    await swReady(page);
    proxy.mode = '502';
    proxy.resetAll();
    await page.reload();
    await page.waitFor(`document.documentElement.dataset.shell === 'cache' && !$('#app').hidden`, 10000, 'app instead of "Bad Gateway"');
    proxy.mode = 'hang';
    proxy.resetAll();
    const t0 = Date.now();
    page.reload().catch(() => {});
    await page.waitFor(`document.documentElement.dataset.shell === 'cache' && typeof paired !== 'undefined'`, 12000, 'app after the 3 s timeout');
    const secs = (Date.now() - t0) / 1000;
    assert(secs < 8, `opened in ${secs.toFixed(1)} s`);
  });

  test('a silently dead event stream is noticed (about 70 s) and nothing is missed', async ctx => {
    const proxy = await ctx.proxy(8826, 8821);
    ctx.defer(() => proxy.stop());
    const page = await ctx.signedIn({ base: proxy.base });
    const meId = await page.evaluate('me.id');
    await page.waitFor(`live.watchdog === true`, 30000, 'server pings seen');
    // A laptop waking up on another network: the event stream goes silent (no error, just nothing), and the
    // browser drops its idle connections, as it does when the network changes.
    for (const c of [...proxy.conns]) {
      if (c.lastReq.startsWith('GET /api/events')) { c.client.pause(); c.server?.pause(); } else { c.client.destroy(); c.server?.destroy(); }
    }
    const phone = dev(ctx, 'Pixel');
    await phone.me();
    await phone.text('sent while the stream was dead', [meId]);
    await page.waitFor(`items.some(i => i.text === 'sent while the stream was dead')`, 100000, 'caught up after the watchdog');
  }, { timeout: 130000 });

  test('after a deploy, an open page offers "Reload" and reloads by itself once hidden', async ctx => {
    // A private copy of the server + web app, so its files can change.
    const app = path.join(ctx.TMP, 'deploy-app');
    fs.mkdirSync(app, { recursive: true });
    for (const f of ['server.js', 'package.json']) fs.copyFileSync(path.join(ctx.ROOT, f), path.join(app, f));
    for (const d of ['public', 'lib']) if (fs.existsSync(path.join(ctx.ROOT, d))) fs.cpSync(path.join(ctx.ROOT, d), path.join(app, d), { recursive: true });
    const env = { NODE_PATH: path.join(ctx.ROOT, 'node_modules') };
    let srv = await new Scratch(path.join(app, 'server.js'), 8825, env).start();
    const data = srv.data;
    ctx.defer(() => srv.stop());
    const page = await ctx.signedIn({ server: srv });
    await page.waitFor(`webSeen !== ''`, 10000, 'first hello');
    await page.evaluate(`window.__marker = 1`);
    fs.appendFileSync(path.join(app, 'public', 'style.css'), '\n/* deploy */\n');
    await srv.stop();
    srv = new Scratch(path.join(app, 'server.js'), 8825, env);
    srv.data = data;
    await srv.start();
    await page.waitFor(`updateReady === true && !$('#banner').hidden`, 40000, '"Beam was updated" banner');
    assert(/updated/.test(await page.evaluate(`$('#banner').textContent`)), 'banner text');
    await ctx.setHidden(page, true);
    await page.waitFor(`typeof window.__marker === 'undefined' && typeof paired !== 'undefined' && paired`, 20000, 'reloaded into the new version');
  }, { timeout: 100000 });

  test('works behind a reverse proxy under a path (/beam/)', async ctx => {
    const proxy = await ctx.prefixProxy(8827, 8821, '/beam');
    ctx.defer(() => proxy.stop());
    const page = await ctx.browser.newPage({ xff: ctx.nextIp() });
    const api = ctx.track(page, /\/api\//);
    await page.goto(`${proxy.base}/?key=${encodeURIComponent(ctx.srv.key)}`);
    await page.waitFor(`typeof paired !== 'undefined' && paired && net.state === 'online'`, 15000, 'signed in under /beam/');
    await page.evaluate(`sendText('hello from under a prefix', 'all')`);
    await page.waitFor(`items.some(i => i.text === 'hello from under a prefix')`);
    assert(api.length && api.every(r => new URL(r.url).pathname.startsWith('/beam/api/')), 'every API call stays under /beam/');
    await page.reload();
    await page.waitFor(`navigator.serviceWorker.controller !== null`, 15000, 'service worker');
    eq(await page.evaluate(`navigator.serviceWorker.getRegistration().then(r => new URL(r.scope).pathname)`), '/beam/', 'service worker scoped to /beam/');
    eq(await page.evaluate(`location.pathname`), '/beam/', 'address bar stays under /beam/');
  });
}
