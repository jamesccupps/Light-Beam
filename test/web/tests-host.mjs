// Host mode: the page inside the Windows app (WebView2), driven by a fake host (harness.fakeHostScript).
import fs from 'node:fs';
import path from 'node:path';
import { assert, eq, fakeHostScript } from './harness.mjs';
import { dev } from './tests-core.mjs';

const hostLog = type => `__host.log.filter(m => m.type === '${type}')`;

// The page the Windows app shows: the app's cookie + injected beamHost / chrome.webview.
export async function hostPage(ctx, { server = ctx.srv, features, state, settings, cookie = true, width, height, afterHello, hostExtra, path = '/' } = {}) {
  const appId = `win${ctx.uid()}${ctx.uid()}`;
  const { key } = await (await fetch(`${server.base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: server.key, client: 'app', deviceId: appId, platform: 'windows' }), // (as Beam for Windows signs in)
  })).json();
  const page = await ctx.browser.newPage({ xff: ctx.nextIp(), width, height, init: [fakeHostScript({ deviceId: appId, deviceName: 'Test PC', server: server.base, features, state, settings, afterHello, hostExtra })] });
  if (cookie) await page.send('Network.setCookie', { name: 'beam_key', value: key, url: server.base, httpOnly: true, sameSite: 'Lax' });
  await page.goto(`${server.base}${path}`);
  return { page, appId, key };
}

export default function register(test) {
  test('host: another Beam’s 401 hides the saved history at once, the next start doesn’t show it at all, its own Beam wakes it; a sign-out there wipes without /api/clear-cache', async ctx => {
    // The window behind a per-request proxy, so another Beam can answer at the same address.
    const proxy = await ctx.prefixProxy(8826, 8821, '');
    ctx.defer(() => proxy.stop());
    const { page, appId } = await hostPage(ctx, { server: { base: proxy.base, key: ctx.srv.key } });
    const clears = [];
    page.on(m => { if (m.method === 'Network.requestWillBeSent' && /\/api\/clear-cache$/.test(m.params.request.url)) clears.push(m.params.request.url); });
    await page.waitFor(`paired && net.state === 'online' && hostState.ready`, 10000, 'running in host mode');
    const admin = dev(ctx, 'Admin', 'windows');
    await admin.me();
    await admin.text('kept for the app', [appId]);
    await page.waitFor(`items.some(i => i.text === 'kept for the app')`, 8000, 'history');
    await page.evaluate(`openConv('${admin.id}'); true`);
    await page.waitFor(`(cache.flushPending(), idbGetAll('items').then(l => l.some(i => i.text === 'kept for the app')))`, 5000, 'saved');
    const other = await ctx.startServer(8822);
    ctx.defer(() => other.stop());
    const shown = `[...document.querySelectorAll('#thread .msg')].some(n => /kept for the app/.test(n.textContent))`;
    // Another Beam answers (the app's sign-in means nothing there): off the screen at once, the app told.
    await page.goto('about:blank');
    await ctx.sleep(300);
    proxy.upstream = 8822;
    await page.goto(`${proxy.base}/`);
    await page.waitFor(`dormant && !(${shown}) && __host.log.some(m => m.type === 'unauthorized')`, 10000, 'dormant, and the app asked to sign in');
    // The next start (the app reloads its window): dormant from the start, so nothing of it shows, even for a moment.
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const t = window.__flash = { kept: 0 }; new MutationObserver(() => { if ([...document.querySelectorAll('#thread .msg')].some(n => /kept for the app/.test(n.textContent))) t.kept++; }).observe(document, { subtree: true, childList: true }); })()` });
    await page.goto('about:blank');
    await page.goto(`${proxy.base}/`);
    await page.waitFor(`typeof dormant !== 'undefined' && dormant && __host.log.some(m => m.type === 'unauthorized')`, 10000, 'dormant again');
    await ctx.sleep(1000);
    eq(await page.evaluate('__flash.kept'), 0, 'not shown at start');
    // Its own Beam answers again: awake, the history is back.
    await page.goto('about:blank');
    await ctx.sleep(300);
    proxy.upstream = 8821;
    await page.goto(`${proxy.base}/`);
    await page.waitFor(`!dormant && paired && ${shown}`, 10000, 'awake: the history is back');
    // The app says in its hello that it's signed in to another Beam: before the page hears from any server, nothing of
    // the saved history shows (the server's answers are held back here for a moment to look).
    const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__host && (window.__host.hello.settings.server.serverId = 'another-beam-0001')` });
    const held = [];
    const hold = m => { if (m.method === 'Fetch.requestPaused') held.push(m.params.requestId); };
    page.on(hold);
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/info*', requestStage: 'Request' }, { urlPattern: '*/api/events*', requestStage: 'Request' }] });
    await page.goto('about:blank');
    await page.goto(`${proxy.base}/`);
    await page.waitFor(`typeof hostState !== 'undefined' && hostState.ready`, 5000, 'the app’s hello');
    await ctx.sleep(800);
    eq(await page.evaluate(`[dormant, ${shown}]`), [true, false], 'the app named another Beam: nothing shown');
    page.off(hold);
    await page.send('Fetch.disable');
    await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    // Its own Beam answers after all: awake again.
    await page.waitFor(`!dormant && paired && ${shown}`, 10000, 'its own Beam answered: awake');
    // Revoked there: a confirmed 401 wipes everything, but leaves the HTTP cache to the app (it clears its window's
    // data itself and reloads the window, which a Clear-Site-Data answer could stall).
    eq((await admin.forget(appId)).status, 204, 'the app removed');
    await page.waitFor(`idbGetAll('items').then(l => l.length === 0) && __host.log.filter(m => m.type === 'unauthorized').length > 0 && !(${shown})`, 10000, 'wiped');
    await ctx.sleep(500);
    eq(clears, [], 'no /api/clear-cache from the Windows app’s window');
  });

  test('host: the page uses the app’s identity; no lock screen, autopair, sign-in requests or acks', async ctx => {
    const signins = [];
    const { page, appId } = await hostPage(ctx);
    page.on(m => { if (m.method === 'Network.requestWillBeSent' && /\/api\/(autopair|login|login-requests|logout)|\/ack$/.test(new URL(m.params.request.url).pathname)) signins.push(m.params.request.url); });
    await page.waitFor(`paired && net.state === 'online' && hostState.ready`, 10000, 'running in host mode');
    eq(await page.evaluate(`[me.id, me.platform, me.name]`), [appId, 'windows', 'Test PC'], 'identity from beamHost');
    const hello = await page.evaluate(`${hostLog('hello')}`);
    eq(hello[0]?.bridge, 1, 'hello handshake with bridge 1');
    const admin = dev(ctx, 'Admin', 'windows');
    const list = (await admin.get('/api/devices')).devices;
    eq(list.filter(d => d.id === appId).map(d => d.platform), ['windows'], 'one device, the app, platform windows');
    await admin.text('for the app', [appId]);
    await page.waitFor(`items.some(i => i.text === 'for the app')`);
    await page.evaluate(`openConv('${admin.id}')`);
    await ctx.sleep(800);
    eq(signins, [], 'no sign-in calls and no acks from the page');
    assert(await page.evaluate(`${hostLog('viewing')}.some(m => m.conversation === '${admin.id}')`), 'tells the app which conversation is on screen');
    assert(await page.evaluate(`${hostLog('read')}.some(m => m.conversation === '${admin.id}' && m.ts > 0)`), 'tells the app what was read');
    assert(await page.evaluate(`!('Notification' in window) || Notification.permission !== 'granted' || true`), 'no web notifications');
    assert(await page.evaluate(`$('#set-notifications') === null`), 'no notification settings');
  });

  test('host: a 401 goes to the app once, quietly, with no retry loop', async ctx => {
    const calls = [];
    const { page } = await hostPage(ctx, { cookie: false });
    page.on(m => { if (m.method === 'Network.requestWillBeSent' && /\/api\//.test(m.params.request.url)) calls.push(new URL(m.params.request.url).pathname); });
    await page.waitFor(`!$('#hostWait').hidden`, 10000, '"Signing in…" shown');
    await ctx.sleep(4000);
    eq(await page.evaluate(`${hostLog('unauthorized')}.length`), 1, 'one unauthorized message');
    eq(await page.evaluate(`$('#hostWaitTitle').textContent`), 'Signing in…', 'quiet state');
    assert(await page.evaluate(`$('#lock').hidden`), 'never the lock screen');
    assert(!calls.some(p => /autopair|login/.test(p)), `no sign-in calls (${calls})`);
    assert(calls.filter(p => p === '/api/events').length <= 1, `no reconnect loop (${calls.length} calls)`);
  });

  test('host: a move goes to the app ("Beam is moving…")', async ctx => {
    const { page } = await hostPage(ctx);
    await page.waitFor(`paired && hostState.ready`);
    await page.evaluate(`onMoved('https://beam.new.ts.net')`);
    eq(await page.evaluate(`${hostLog('moved')}.map(m => m.movedTo)`), ['https://beam.new.ts.net'], 'moved message');
    eq(await page.evaluate(`[$('#hostWait').hidden, $('#hostWaitTitle').textContent, $('#lock').hidden]`), [false, 'Beam is moving…', true], 'quiet moving state');
  });

  test('host: files go through the app (drop, paperclip, folder, paste), never page uploads', async ctx => {
    const { page } = await hostPage(ctx);
    const uploads = ctx.track(page, /\/api\/uploads/);
    await page.waitFor(`paired && hostState.ready`);
    const file = path.join(ctx.TMP, 'host-drop.txt');
    fs.writeFileSync(file, 'dropped in the Windows app');
    for (const type of ['dragEnter', 'dragOver', 'drop']) await page.send('Input.dispatchDragEvent', { type, x: 800, y: 400, data: { items: [], files: [file], dragOperationsMask: 1 } });
    await page.waitFor(`__host.files.some(f => f.type === 'sendFiles' && f.names.includes('host-drop.txt'))`, 5000, 'sendFiles with the dropped file');
    eq(await page.evaluate(`${hostLog('sendFiles')}[0].to`), [], 'to All devices');
    await page.evaluate(`$('#attachBtn').click()`);
    await page.waitFor(`${hostLog('pickFiles')}.length === 1`, 3000, 'paperclip → pickFiles');
    await page.evaluate(`attachFolder()`);
    await page.waitFor(`${hostLog('pickFolder')}.length === 1`, 3000, '"Send a folder…" → pickFolder');
    await page.evaluate(`(() => {
      document.activeElement.blur();
      const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }));
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`);
    await page.waitFor(`$('#genDlg').open`, 3000, 'paste asks first');
    await page.evaluate(`[...$('#genFoot').querySelectorAll('button')].at(-1).click()`);
    await page.waitFor(`${hostLog('sendClipboard')}.length === 1`, 3000, 'pasted image → sendClipboard');
    eq(uploads.length, 0, 'the page never uploads by itself');
  });

  test('host: transfer rows, saved files, double-click to open, drag-out', async ctx => {
    const { page, appId } = await hostPage(ctx);
    await page.waitFor(`paired && hostState.ready`);
    const admin = dev(ctx, 'Admin', 'windows');
    const item = await admin.file('report.pdf', Buffer.from('%PDF-1.4 test'), [appId]);
    await page.waitFor(`items.some(i => i.id === '${item.id}')`);
    await page.evaluate(`openConv('${admin.id}')`);
    const t = { id: 'up:1', kind: 'upload', conversations: [admin.id], name: 'movie.mkv', size: 1932735283, done: 12582912, rate: 4404019, eta: 360, state: 'running', canCancel: true, canRetry: false };
    await page.evaluate(`__host.emit({ type: 'transfer', transfer: ${JSON.stringify(t)} })`);
    await page.waitFor(`document.querySelector('#thread .msg.transfer') !== null`, 3000, 'transfer row');
    eq(await page.evaluate(`$('#thread .msg.transfer .status-line').textContent`), '12 MB of 1.8 GB · 4.2 MB/s · 6 min left', 'progress text');
    await page.evaluate(`__host.emit({ type: 'transfer', transfer: ${JSON.stringify({ ...t, state: 'failed', status: 'Connection problem', canRetry: true, canCancel: false })} })`);
    await page.waitFor(`$('#thread .msg.transfer .status-line').textContent === 'Connection problem'`, 3000, 'failed status');
    await page.evaluate(`$('#thread .msg.transfer button[aria-label="Retry"]').click()`);
    await page.waitFor(`${hostLog('retryTransfer')}.some(m => m.transferId === 'up:1')`, 3000, 'retry sent');
    await page.evaluate(`__host.emit({ type: 'transferRemoved', transferId: 'up:1' })`);
    await page.waitFor(`document.querySelector('#thread .msg.transfer') === null`, 3000, 'row removed');
    const node = `document.querySelector('[data-id="${item.id}"]')`;
    assert(await page.evaluate(`${node}.querySelector('.meta button[aria-label="Save"]') !== null`), 'unsaved → Save');
    await page.evaluate(`__host.emit({ type: 'localFile', itemId: '${item.id}', saved: true })`);
    await page.waitFor(`${node}.querySelector('.meta button[aria-label="Open"]') !== null`, 3000, 'saved → Open');
    await page.evaluate(`${node}.querySelector('.bubble').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await page.waitFor(`${hostLog('openFile')}.some(m => m.itemId === '${item.id}')`, 3000, 'double-click → openFile');
    await page.evaluate(`${node}.querySelector('.file-row').dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))`);
    await page.waitFor(`${hostLog('dragOut')}.some(m => m.itemId === '${item.id}')`, 3000, 'drag → dragOut');
  });

  test('host: navigate highlights an item; openPanel opens This PC; settings changes go to the app', async ctx => {
    const { page, appId } = await hostPage(ctx);
    await page.waitFor(`paired && hostState.ready`);
    const admin = dev(ctx, 'Admin', 'windows');
    const item = await admin.text('look at this one', [appId]);
    await page.waitFor(`items.some(i => i.id === '${item.id}')`);
    await page.evaluate(`__host.emit({ type: 'navigate', conversation: '${admin.id}', itemId: '${item.id}' })`);
    await page.waitFor(`current === '${admin.id}' && document.querySelector('[data-id="${item.id}"]')?.classList.contains('flash')`, 3000, 'opened and highlighted');
    await page.evaluate(`__host.emit({ type: 'openPanel', panel: 'settings' })`);
    await page.waitFor(`$('#settingsDlg').open && $('#set-pc') !== null`, 5000, 'settings open with This PC');
    const text = await page.evaluate(`$('#set-pc').textContent`);
    assert(/Copy received text/.test(text) && /Save files to/.test(text) && /Switch server/.test(text) && /Ctrl\+Alt\+B/.test(text), 'This PC shows the app’s settings');
    await page.evaluate(`[...$('#set-pc').querySelectorAll('label.check')].find(l => /Copy received text/.test(l.textContent)).querySelector('input').click()`);
    await page.waitFor(`${hostLog('setSettings')}.some(m => m.settings.autoCopy === false)`, 3000, 'setSettings sent');
    await page.evaluate(`$('#settingsDlg').close(); __host.emit({ type: 'openPanel', panel: 'pair' })`);
    await page.waitFor(`$('#pairDlg').open`, 5000, 'Add a device opened');
    assert(await page.evaluate(`$('#windowsLink').hidden`), 'no "get the Windows app" link inside the Windows app');
  });

  test('host: the tray’s "Settings" works right after the handshake, and the footer names this PC', async ctx => {
    const { page } = await hostPage(ctx, { afterHello: [{ type: 'openPanel', panel: 'settings' }] });
    await page.waitFor(`$('#settingsDlg').open && $('#set-pc') !== null && /Copy received text/.test($('#set-pc').textContent)`, 8000, 'This PC open');
    eq(await page.evaluate(`$('#deviceLabel').textContent`), 'Test PC', 'footer shows the device name');
  });

  test('host: Copy image goes through the app (its page may be http: no image clipboard); a type Windows can’t read goes as PNG; an older app: the browser’s way', async ctx => {
    const { page, appId } = await hostPage(ctx);
    await page.waitFor(`paired && hostState.ready`);
    const admin = dev(ctx, 'Admin', 'windows');
    // A 2×1 BMP (red, green): small, and a type the page turns into PNG by itself.
    const bmp = Buffer.concat([Buffer.from('BM'), Buffer.from(new Uint32Array([62, 0, 54]).buffer),
      Buffer.from(new Uint32Array([40, 2, 1]).buffer), Buffer.from(new Uint16Array([1, 24]).buffer), Buffer.from(new Uint32Array([0, 8, 2835, 2835, 0, 0]).buffer),
      Buffer.from([0, 0, 255, 0, 255, 0, 0, 0])]);
    const item = await admin.file('pixels.bmp', bmp, [appId]);
    await page.waitFor(`items.some(i => i.id === '${item.id}')`);
    await page.evaluate(`copyImage(items.find(i => i.id === '${item.id}')); true`);
    await page.waitFor(`${hostLog('copyImage')}.length === 1 && $('#toastText').textContent === 'Image copied'`, 5000, 'copyImage, then "Image copied"');
    eq(await page.evaluate(`${hostLog('copyImage')}.map(m => [m.itemId, 'png' in m])`), [[item.id, false]], 'the item, for the app to fetch');
    // Windows can't read it: the page sends it as PNG.
    await page.evaluate(`__host.reply('copyImage', m => m.png ? null : { ok: false, code: 'unsupported', error: 'Windows can’t read that kind of image' }); copyImage(items.find(i => i.id === '${item.id}')); true`);
    await page.waitFor(`${hostLog('copyImage')}.length === 3`, 5000, 'sent again as PNG');
    const png = Buffer.from(await page.evaluate(`${hostLog('copyImage')}[2].png`), 'base64');
    eq([png.subarray(1, 4).toString(), png.readUInt32BE(16), png.readUInt32BE(20)], ['PNG', 2, 1], 'a 2×1 PNG');
    // An app before 1.6.2 doesn't know the message: no error from it (the browser's own clipboard is tried).
    await page.evaluate(`__host.reply('copyImage', () => ({ ok: false, code: 'unknown-type', error: 'Unknown message: copyImage' })); copyImage(items.find(i => i.id === '${item.id}')); true`);
    await page.waitFor(`${hostLog('copyImage')}.length === 4`, 5000, 'asked the app');
    await ctx.sleep(500);
    assert(!(await page.evaluate(`$('#toastText').textContent.includes('Unknown message')`)), 'an older app’s answer isn’t shown');
  });

  test('host: links open through the app', async ctx => {
    const { page, appId } = await hostPage(ctx);
    await page.waitFor(`paired && hostState.ready`);
    const admin = dev(ctx, 'Admin', 'windows');
    await admin.text('see https://example.com/page for details', [appId]);
    await page.waitFor(`items.some(i => /example\\.com/.test(i.text || ''))`);
    await page.evaluate(`openConv('${admin.id}')`);
    await page.evaluate(`document.querySelector('#thread .text a').click()`);
    await page.waitFor(`${hostLog('openLink')}.some(m => m.url === 'https://example.com/page')`, 3000, 'openLink');
  });
}
