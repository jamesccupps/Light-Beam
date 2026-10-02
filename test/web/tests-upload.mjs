// Uploads through a fault-injecting proxy: dropped connections, stalls, lost answers, pausing, reloads, limits.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { assert, eq, readZip } from './harness.mjs';
import { dev, PNG_1PX } from './tests-core.mjs';

const MB = 1024 * 1024;
const upState = `[...uploads.values()].map(u => u.state).join(',')`;
const serverItems = async (ctx, server = ctx.srv) => (await (await fetch(`${server.base}/api/items`, { headers: { Authorization: `Bearer ${server.key}` } })).json()).items;
const sendBlob = (page, mb, name) => page.evaluate(`sendFiles([new File([new Uint8Array(${mb} * 1024 * 1024).map((_, i) => i % 251)], '${name}')], 'all')`);

export default function register(test) {
  test('upload: a dropped connection that leaves the server busy is retried with backoff, then finishes', async ctx => {
    const proxy = await ctx.proxy(8826, 8821);
    ctx.defer(() => proxy.stop());
    const page = await ctx.signedIn({ base: proxy.base });
    let dropped = false;
    // Wi-Fi → 4G: the client's side of a piece dies mid-way, the server's side stays open mid-body. (A 1.4 server
    // takes the whole 20 MB as one piece; older ones in 8 MB chunks.)
    proxy.rules.push(({ dir, conn }) => {
      if (!dropped && dir === 'up' && /PUT \/api\/uploads\/\w+\?offset=\d+/.test(conn.lastReq) && conn.afterPut > 1.5 * MB) { dropped = true; return 'freeze'; }
      return null;
    });
    await sendBlob(page, 20, 'busy.bin');
    for (let i = 0; i < 100 && !dropped; i++) await ctx.sleep(100);
    const putsBefore = proxy.stats.puts;
    await ctx.sleep(10000);
    const putsIn10s = proxy.stats.puts - putsBefore;
    assert(dropped, 'the connection was dropped');
    assert(putsIn10s <= 10, `backs off while the server is busy (${putsIn10s} PUTs in 10 s; the old app made ~250)`);
    // The v3 server takes a chunk over after 30 s without data.
    await page.waitFor(`!uploads.size`, 70000, 'upload finished');
    const item = (await serverItems(ctx)).find(i => i.name === 'busy.bin');
    eq(item?.size, 20 * MB, 'complete file on the server');
    assert(proxy.stats.putBytes < 80 * MB, `no flood of re-sent chunks (${Math.round(proxy.stats.putBytes / MB)} MB sent)`);
  }, { timeout: 110000 });

  test('upload: a stalled request is abandoned after 30 s and the upload carries on', async ctx => {
    const proxy = await ctx.proxy(8826, 8821);
    ctx.defer(() => proxy.stop());
    const page = await ctx.signedIn({ base: proxy.base });
    let stalled = false;
    proxy.rules.push(({ dir, conn }) => {
      if (!stalled && dir === 'up' && /PUT \/api\/uploads\//.test(conn.lastReq) && conn.afterPut > MB) { stalled = true; return 'stall'; }
      return null;
    });
    await sendBlob(page, 12, 'stall.bin');
    await page.waitFor(`!uploads.size`, 100000, 'upload finished after the stall');
    const item = (await serverItems(ctx)).find(i => i.name === 'stall.bin');
    eq(item?.size, 12 * MB, 'complete file on the server');
    assert(stalled, 'a request was stalled');
  }, { timeout: 120000 });

  test('upload: when the answer to the last chunk is lost, it still counts as sent (no error)', async ctx => {
    const proxy = await ctx.proxy(8826, 8821);
    ctx.defer(() => proxy.stop());
    const page = await ctx.signedIn({ base: proxy.base });
    await page.evaluate(`window.__toasts = []; { const o = toast; toast = (m, x) => { __toasts.push(m); o(m, x); }; }`);
    let lost = false;
    proxy.rules.push(({ dir, text, conn }) => {
      if (!lost && dir === 'down' && /^HTTP\/1\.1 201/.test(text) && conn.lastReq.startsWith('PUT /api/uploads/')) { lost = true; return 'drop'; }
      return null;
    });
    await sendBlob(page, 3, 'lost-answer.bin');
    await page.waitFor(`!uploads.size && items.some(i => i.name === 'lost-answer.bin')`, 30000, 'item shown');
    assert(lost, 'the final answer was dropped');
    const toasts = await page.evaluate('__toasts');
    assert(!toasts.some(t => /couldn|not found|error/i.test(t)), `no error shown (${toasts})`);
  });

  test('upload: pause and resume', async ctx => {
    const proxy = await ctx.proxy(8826, 8821);
    ctx.defer(() => proxy.stop());
    proxy.bps = 4 * MB;
    const page = await ctx.signedIn({ base: proxy.base });
    await sendBlob(page, 24, 'pause.bin');
    await page.waitFor(`[...uploads.values()][0]?.state === 'running' && ([...uploads.values()][0].sent || 0) > 2 * 1024 * 1024`, 20000);
    await page.evaluate(`pauseUpload([...uploads.values()][0])`);
    await page.waitFor(`[...uploads.values()][0]?.state === 'paused'`, 5000);
    const at = await page.evaluate(`[...uploads.values()][0].offset`);
    await ctx.sleep(2500);
    const still = await page.evaluate(`[[...uploads.values()][0].state, [...uploads.values()][0].offset]`);
    eq(still, ['paused', at], 'nothing moves while paused');
    proxy.bps = 0;
    await page.evaluate(`resumeUpload([...uploads.values()][0])`);
    await page.waitFor(`!uploads.size`, 30000, 'finished after resuming');
    eq((await serverItems(ctx)).find(i => i.name === 'pause.bin')?.size, 24 * MB, 'complete file');
  });

  test('upload: after a reload, choosing the file again finishes the same upload', async ctx => {
    const file = path.join(ctx.TMP, 'resume-me.bin');
    fs.writeFileSync(file, Buffer.alloc(24 * MB, 7));
    const proxy = await ctx.proxy(8826, 8821);
    ctx.defer(() => proxy.stop());
    proxy.bps = 4 * MB;
    const page = await ctx.signedIn({ base: proxy.base });
    await ctx.setFiles(page, '#fileInput', [file]);
    await page.waitFor(`([...uploads.values()][0]?.sent || 0) > 9 * 1024 * 1024`, 20000);
    const uploadId = await page.evaluate(`[...uploads.values()][0].uploadId`);
    await page.evaluate('window.onbeforeunload = null');
    await page.reload();
    await page.waitFor(`paired && resumeRecords.length === 1`, 15000, 'offers to resume');
    const row = await page.evaluate(`document.querySelector('#thread .msg.pending .status-line')?.textContent || ''`);
    assert(/Choose the file again/.test(row), `resume row: ${row}`);
    proxy.bps = 0;
    await page.evaluate(`document.querySelector('#thread .msg.pending button.btn').click()`);
    await ctx.setFiles(page, '#resumeInput', [file]);
    await page.waitFor(`!uploads.size && !resumeRecords.length`, 30000, 'finished');
    const item = (await serverItems(ctx)).find(i => i.name === 'resume-me.bin');
    eq([item?.id, item?.size], [uploadId, 24 * MB], 'the same upload completed');
  });

  test('upload: keeps retrying through a long outage instead of giving up', async ctx => {
    const proxy = await ctx.proxy(8826, 8821);
    ctx.defer(() => proxy.stop());
    const page = await ctx.signedIn({ base: proxy.base });
    proxy.bps = 3 * MB;
    await sendBlob(page, 16, 'outage.bin');
    await page.waitFor(`([...uploads.values()][0]?.sent || 0) > 4 * 1024 * 1024`, 20000);
    proxy.mode = 'refuse';
    proxy.resetAll();
    await ctx.sleep(25000);
    const mid = await page.evaluate(`[${upState}, [...uploads.values()][0]?.failures]`);
    assert(/retrying|waiting|running|starting/.test(mid[0]) && mid[1] >= 3, `still trying after failures (${mid})`);
    proxy.mode = 'pass';
    proxy.bps = 0;
    await page.waitFor(`!uploads.size`, 45000, 'finished once the server was back');
    eq((await serverItems(ctx)).find(i => i.name === 'outage.bin')?.size, 16 * MB, 'complete file');
  }, { timeout: 110000 });

  test('upload: a proxy with a small body limit (413) gets smaller chunks', async ctx => {
    const proxy = await ctx.proxy(8826, 8821);
    ctx.defer(() => proxy.stop());
    // like nginx's client_max_body_size 2m
    proxy.rules.push(({ dir, text }) => {
      const m = dir === 'up' && /^PUT \/api\/uploads\/[^\s]+ HTTP\/1\.1[\s\S]*?content-length: (\d+)/i.exec(text);
      if (m && Number(m[1]) > 2 * MB) return 'HTTP/1.1 413 Request Entity Too Large\r\nContent-Type: text/html\r\nContent-Length: 13\r\nConnection: close\r\n\r\n<h1>413</h1>';
      return null;
    });
    const page = await ctx.signedIn({ base: proxy.base });
    await sendBlob(page, 10, 'small-chunks.bin');
    await page.waitFor(`!uploads.size`, 40000, 'finished');
    eq((await serverItems(ctx)).find(i => i.name === 'small-chunks.bin')?.size, 10 * MB, 'complete file');
  });

  test('upload: files over the server limit are refused before anything is sent', async ctx => {
    const small = await ctx.startServer(8822, { BEAM_MAX_UPLOAD_MB: '1' });
    ctx.defer(() => small.stop());
    const page = await ctx.signedIn({ server: small });
    const posts = ctx.track(page, /\/api\/uploads/);
    await page.evaluate(`window.__toasts = []; { const o = toast; toast = (m, x) => { __toasts.push(m); o(m, x); }; }`);
    await page.evaluate(`sendFiles([new File([new Uint8Array(2 * 1024 * 1024)], 'too-big.bin')], 'all')`);
    await ctx.sleep(500);
    eq(posts.length, 0, 'no upload started');
    const toasts = await page.evaluate('__toasts');
    assert(toasts.some(t => /too-big\.bin/.test(t) && /1\.0 MB/.test(t)), `explains the limit (${toasts})`);
  });

  test('upload: 150 files at once show one progress card and keep the page responsive', async ctx => {
    const page = await ctx.signedIn();
    const phone = dev(ctx, 'Photo frame');
    await phone.me();
    await page.waitFor(`Boolean(deviceById('${phone.id}'))`, 5000, 'page knows the device');
    await page.evaluate(`openConv('${phone.id}')`);
    const ms = await page.evaluate(`(() => {
      const files = Array.from({ length: 150 }, (_, i) => new File(['photo ' + i], 'IMG_' + String(i).padStart(4, '0') + '.jpg', { type: 'image/jpeg' }));
      const t = performance.now(); window.__done = sendFiles(files, '${phone.id}'); return performance.now() - t;
    })()`);
    await page.waitFor(`document.querySelector('#genDlg[open]') !== null`, 5000, 'asks first (item cap)');
    const text = await page.evaluate(`$('#genBody').textContent`);
    assert(/keeps up to/.test(text), `mentions the cap: ${text}`);
    await page.evaluate(`[...$('#genFoot').querySelectorAll('button')].find(b => /separately/.test(b.textContent)).click()`);
    await page.waitFor(`batches.size === 1`, 5000);
    const rows = await page.evaluate(`document.querySelectorAll('#thread .msg.pending').length`);
    assert(rows <= 3, `one card instead of 150 rows (${rows})`);
    assert(ms < 200, `sendFiles returns at once (${ms.toFixed(0)} ms)`);
    await page.waitFor(`!uploads.size && !batches.size`, 90000, 'all sent');
    eq((await serverItems(ctx)).filter(i => /^IMG_\d{4}\.jpg$/.test(i.name) && i.to.includes(phone.id)).length, 150, 'all 150 arrived');
  }, { timeout: 120000 });

  test('upload: a dropped folder arrives as one valid .zip', async ctx => {
    const dir = path.join(ctx.TMP, 'drop', 'Holiday photos');
    fs.mkdirSync(path.join(dir, 'day 2'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'first file\n');
    fs.writeFileSync(path.join(dir, 'day 2', 'b.bin'), Buffer.alloc(300000, 3));
    fs.writeFileSync(path.join(dir, 'day 2', 'ünïcode.txt'), 'naïve café\n');
    const page = await ctx.signedIn();
    const drag = async type => page.send('Input.dispatchDragEvent', { type, x: 800, y: 400, data: { items: [], files: [dir], dragOperationsMask: 1 } });
    await drag('dragEnter');
    await drag('dragOver');
    await drag('drop');
    await page.waitFor(`items.some(i => i.name === 'Holiday photos.zip') && !uploads.size`, 20000, 'zip sent');
    const item = (await serverItems(ctx)).find(i => i.name === 'Holiday photos.zip');
    const buf = Buffer.from(await (await fetch(`${ctx.srv.base}/api/file/${item.id}`, { headers: { Authorization: `Bearer ${ctx.srv.key}` } })).arrayBuffer());
    const entries = readZip(buf);
    const files = entries.filter(e => !e.name.endsWith('/'));
    eq(files.map(e => e.name).sort(), ['Holiday photos/a.txt', 'Holiday photos/day 2/b.bin', 'Holiday photos/day 2/ünïcode.txt'], 'entries');
    for (const e of files) assert(zlib.crc32(e.data) === e.crc, `CRC of ${e.name}`);
    eq(files.find(e => e.name.endsWith('ünïcode.txt')).data.toString('utf8'), 'naïve café\n', 'content');
  });

  test('upload: photos get a thumbnail and their size, and receivers show the thumbnail', async ctx => {
    const page = await ctx.signedIn();
    const other = await ctx.signedIn();
    await page.evaluate(`(async () => {
      const c = new OffscreenCanvas(1600, 1200); const g = c.getContext('2d');
      g.fillStyle = '#3a7'; g.fillRect(0, 0, 1600, 1200); g.fillStyle = '#fff'; g.fillRect(200, 200, 400, 300);
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      sendFiles([new File([blob], 'photo.jpg', { type: 'image/jpeg' })], 'all');
    })()`);
    await page.waitFor(`!uploads.size && items.some(i => i.name === 'photo.jpg')`, 20000);
    const item = (await serverItems(ctx)).find(i => i.name === 'photo.jpg');
    await other.waitFor(`itemMap.get('${item.id}')?.thumb === true`, 10000, 'thumb announced');
    const img = await other.evaluate(`(() => { const i = document.querySelector('[data-id="${item.id}"] img'); return i && [i.src.includes('/thumb'), i.getAttribute('width'), i.getAttribute('height')]; })()`);
    eq([item.w, item.h], [1600, 1200], 'original size recorded');
    eq(img, [true, '320', '240'], 'receiver shows the thumbnail with its size reserved');
  });
}
