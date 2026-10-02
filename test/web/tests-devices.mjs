// Device status, Ring / Stop, Wake-on-LAN, Remote Desktop, alerts, the Windows app's "open links" setting, and
// device pickers that never offer a choice before the device list is known.
import fs from 'node:fs';
import path from 'node:path';
import { assert, eq } from './harness.mjs';
import { hostPage } from './tests-host.mjs';

const GB = 1024 ** 3;
// A Beam app new enough to ring (the server wants 1.3.0 or later for that).
const app = (ctx, name, platform = 'android', server = ctx.srv) => server.device(`${platform.slice(0, 3)}${ctx.uid()}${ctx.uid()}`, name, platform, ctx.nextIp(), '1.3.0');
const menuLabels = page => page.evaluate(`[...$('#menu').querySelectorAll('.menu-item')].map(b => b.textContent.trim())`);
const clickMenu = (page, label) => page.evaluate(`[...$('#menu').querySelectorAll('.menu-item')].find(b => b.textContent.trim().startsWith(${JSON.stringify(label)})).click()`);
const openThreadMenu = page => page.evaluate(`threadMenu($('#threadMenuBtn'))`);
const recordToasts = page => page.evaluate(`window.__toasts = []; { const o = toast; toast = (m, x) => { __toasts.push(m); return o(m, x); }; } true`);
const until = async (ctx, fn, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await ctx.sleep(100)) if (await fn()) return true; return false; };
const settingsOf = srv => fetch(`${srv.base}/api/settings`, { headers: { Authorization: `Bearer ${srv.key}` } }).then(r => r.json());

// Answers the page's requests for `pattern` itself, one canned response per request (no real Wake-on-LAN packets).
async function fakeResponses(page, pattern, responses) {
  const seen = [];
  page.on(m => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { status, body } = responses[Math.min(seen.length, responses.length - 1)];
    seen.push({ method: m.params.request.method, url: m.params.request.url });
    page.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') }).catch(() => {});
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: pattern, requestStage: 'Request' }] });
  return seen;
}

// Holds the page's requests for these URL patterns until release() (a slow server, for exactly those requests).
async function holdRequests(page, patterns) {
  const held = [];
  let released = false;
  const onPaused = m => {
    if (m.method !== 'Fetch.requestPaused') return;
    if (released) page.send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
    else held.push(m.params.requestId);
  };
  page.on(onPaused);
  await page.send('Fetch.enable', { patterns: patterns.map(urlPattern => ({ urlPattern, requestStage: 'Request' })) });
  return async () => {
    released = true;
    for (const requestId of held.splice(0)) await page.send('Fetch.continueRequest', { requestId }).catch(() => {});
    await page.send('Fetch.disable').catch(() => {});
    page.off(onPaused);
  };
}

// Lets this page's downloads land in a temp folder; resolves the finished ones: [{ url, name, file }].
async function catchDownloads(ctx, page) {
  const b = await page.browser.browserConn();
  const dir = path.join(ctx.TMP, `downloads-${ctx.uid()}`);
  fs.mkdirSync(dir, { recursive: true });
  const list = [];
  const on = m => {
    if (m.method === 'Browser.downloadWillBegin') list.push({ guid: m.params.guid, url: m.params.url, name: m.params.suggestedFilename, file: path.join(dir, m.params.guid) });
    if (m.method === 'Browser.downloadProgress' && m.params.state === 'completed') { const d = list.find(x => x.guid === m.params.guid); if (d) d.done = true; }
  };
  b.on(on);
  ctx.defer(async () => { b.off(on); await b.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId: page.contextId }).catch(() => {}); });
  await b.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dir, browserContextId: page.contextId, eventsEnabled: true });
  return list;
}

export default function register(test) {
  test('device status: the header shows battery, free storage, version and system; low values stand out', async ctx => {
    const phone = app(ctx, 'Pixel');
    await phone.me();
    eq((await phone.putStatus({ battery: { level: 12, charging: false }, storage: { free: 1.5 * GB, total: 128 * GB }, os: 'Android 16' })).status, 204, 'status accepted');
    const page = await ctx.signedIn();
    await page.waitFor(`deviceById('${phone.id}')?.status?.battery?.level === 12`, 8000, 'status in the device list');
    await page.evaluate(`openConv('${phone.id}')`);
    const text = await page.evaluate(`$('#threadSub').textContent`);
    assert(/12%/.test(text) && /1\.5 GB free/.test(text) && /Beam 1\.3\.0/.test(text) && /Android 16/.test(text), `info line: ${text}`);
    eq(await page.evaluate(`$$('#threadSub .fact.low').length`), 2, 'low battery and low storage stand out');
    await phone.putStatus({ battery: { level: 80, charging: true }, storage: { free: 60 * GB, total: 128 * GB } });
    await page.waitFor(`/80% charging/.test($('#threadSub').textContent) && $$('#threadSub .fact.low').length === 0`, 20000, 'updates live');
    // Device info: everything, with the actions.
    await openThreadMenu(page);
    await clickMenu(page, 'Device info');
    await page.waitFor(`$('#genDlg').open && $('#genDlg').dataset.device === '${phone.id}'`, 3000, 'device info');
    const info = await page.evaluate(`$('#genBody').textContent`);
    assert(/Battery80%, charging/.test(info) && /Storage60 GB free of 128 GB/.test(info) && /SystemAndroid 16/.test(info), `device info: ${info}`);
  }, { timeout: 60000 });

  test('ring: Ring from the conversation menu reaches the phone, and Stop ringing stops it', async ctx => {
    const phone = app(ctx, 'Pixel');
    await phone.me();
    const stream = phone.stream();
    ctx.defer(() => stream.close());
    const page = await ctx.signedIn();
    await page.waitFor(`deviceById('${phone.id}')?.online && deviceById('${phone.id}')?.can?.ring === true`, 8000, 'phone online and ringable');
    await page.evaluate(`openConv('${phone.id}')`);
    await openThreadMenu(page);
    assert((await menuLabels(page)).includes('Ring'), 'Ring in the menu');
    await clickMenu(page, 'Ring');
    assert(await until(ctx, () => stream.events.some(e => e.event === 'ring' && e.data.device === phone.id && !e.data.stop)), 'the phone was told to ring');
    await page.waitFor(`/Ringing/.test($('#threadSub').textContent)`, 5000, '"Ringing…" in the header');
    await openThreadMenu(page);
    assert((await menuLabels(page)).includes('Stop ringing'), 'Stop ringing in the menu');
    await clickMenu(page, 'Stop ringing');
    assert(await until(ctx, () => stream.events.some(e => e.event === 'ring' && e.data.device === phone.id && e.data.stop)), 'the phone was told to stop');
    await page.waitFor(`!/Ringing/.test($('#threadSub').textContent)`, 5000, 'header back to normal');
    // A browser can't ring: no Ring for it.
    const other = await ctx.signedIn();
    const otherId = await other.evaluate('me.id');
    await page.waitFor(`deviceById('${otherId}')`, 8000);
    eq(await page.evaluate(`deviceActions(deviceById('${otherId}')).map(a => a.label)`), [], 'no actions for a browser');
  });

  test('wake: an offline PC with a known network card can be woken (faked: no packets leave the test)', async ctx => {
    const pc = app(ctx, 'Work PC', 'windows');
    await pc.me();
    await pc.putStatus({ macs: ['02:00:00:00:00:01'], os: 'Windows 11 Pro' });
    const page = await ctx.signedIn();
    await recordToasts(page);
    await page.waitFor(`deviceById('${pc.id}')?.can?.wake === true && !deviceById('${pc.id}').online`, 8000, 'wakeable and offline');
    const calls = await fakeResponses(page, '*/wake', [{ status: 200, body: { sent: 12, macs: 1 } }, { status: 409, body: { error: 'Work PC hasn’t told Beam its network adapters yet' } }]);
    await page.evaluate(`openConv('${pc.id}')`);
    await openThreadMenu(page);
    await clickMenu(page, 'Wake');
    await page.waitFor(`__toasts.some(t => /wake-up signal to Work PC/.test(t))`, 5000, 'confirmation');
    eq(calls.map(c => [c.method, new URL(c.url).pathname]), [['POST', `/api/devices/${pc.id}/wake`]], 'wake request');
    await openThreadMenu(page);
    await clickMenu(page, 'Wake');
    await page.waitFor(`__toasts.some(t => /network card/.test(t))`, 5000, 'a 409 explains itself');
  });

  test('remote desktop: a browser downloads the .rdp file; the Windows app gets remoteDesktop { host }', async ctx => {
    const pc = app(ctx, 'Work PC', 'windows');
    await pc.me();
    await pc.putStatus({ remoteDesktop: true, os: 'Windows 11 Pro' });
    const page = await ctx.signedIn();
    await page.waitFor(`deviceById('${pc.id}')?.can?.remoteDesktop === true`, 8000, 'Remote Desktop offered');
    const ip = await page.evaluate(`deviceById('${pc.id}').tailscale.ip`);
    const downloads = await catchDownloads(ctx, page);
    await page.evaluate(`openConv('${pc.id}')`);
    await openThreadMenu(page);
    await clickMenu(page, 'Remote Desktop');
    assert(await until(ctx, () => downloads[0]?.done), 'the .rdp file downloaded');
    eq([new URL(downloads[0].url).pathname, downloads[0].name], [`/api/devices/${pc.id}/remote-desktop.rdp`, 'Work PC.rdp'], 'the .rdp download');
    assert(fs.readFileSync(downloads[0].file, 'utf8').includes(`full address:s:${ip}`), 'it connects to the PC’s Tailscale address');
    // The Windows app: straight to mstsc through the bridge (Beam for Windows 1.3+ only).
    const { page: host } = await hostPage(ctx, { features: ['transfers', 'localFiles', 'settings', 'openPanel', 'remoteDesktop'] });
    await host.waitFor(`paired && hostState.ready && deviceById('${pc.id}')?.can?.remoteDesktop === true`, 10000, 'host ready');
    await recordToasts(host);
    await host.evaluate(`openConv('${pc.id}')`);
    await openThreadMenu(host);
    await clickMenu(host, 'Remote Desktop');
    await host.waitFor(`__host.log.some(m => m.type === 'remoteDesktop' && m.host === '${ip}' && Object.keys(m).sort().join() === 'host,id,type')`, 3000, 'bridge remoteDesktop { host }');
    await host.evaluate(`__host.reply('remoteDesktop', () => ({ ok: false, error: 'mstsc failed', code: 'failed' }))`);
    await openThreadMenu(host);
    await clickMenu(host, 'Remote Desktop');
    await host.waitFor(`__toasts.some(t => /Remote Desktop couldn’t start/.test(t))`, 3000, 'failure explained');
    // An older Windows app (no remoteDesktop feature) doesn't offer it: its downloads can't open a .rdp file.
    const { page: old } = await hostPage(ctx, { features: ['transfers', 'localFiles', 'settings'] });
    await old.waitFor(`paired && hostState.ready && deviceById('${pc.id}')?.can?.remoteDesktop === true`, 10000);
    eq(await old.evaluate(`deviceActions(deviceById('${pc.id}')).map(a => a.label)`), ['Ring'], 'no Remote Desktop in an older app');
    // The page never rings for itself: the Windows app does that.
    await host.evaluate(`onRingEvent({ device: me.id, by: 'Pixel', stop: false, at: Date.now() })`);
    eq(await host.evaluate(`isRinging(me.id)`), false, 'ring for this PC ignored by the page');
  }, { timeout: 60000 });

  test('alerts: a low battery elsewhere pops up (not for this device); Settings → Alerts lists and toggles them', async ctx => {
    const page = await ctx.signedIn();
    await recordToasts(page);
    const phone = app(ctx, 'Pixel');
    await phone.me();
    await phone.putStatus({ battery: { level: 9, charging: false } });
    await page.waitFor(`__toasts.some(t => /Pixel.s battery is at 9%/.test(t))`, 8000, 'alert toast');
    eq(await page.evaluate(`$('#toast').classList.contains('warn')`), true, 'shown as a warning');
    // This device's own alerts are for this device's own app (here: none).
    const before = await page.evaluate(`__toasts.length`);
    await page.evaluate(`onAlertEvent({ id: 'self1', kind: 'battery', device: me.id, level: 'warn', text: 'Mine is low', at: Date.now() })`);
    eq(await page.evaluate(`__toasts.length`), before, 'no alert about itself');
    await page.evaluate(`onAlertEvent({ id: 'disk1', kind: 'serverDisk', device: null, level: 'warn', text: 'The Beam server’s disk is almost full', at: Date.now() })`);
    await page.waitFor(`__toasts.some(t => /disk is almost full/.test(t))`, 2000, 'server disk alerts always show');
    await page.evaluate(`openSettings('alerts')`);
    await page.waitFor(`$('#set-alerts') !== null && /Pixel.s battery is at 9%/.test($('#set-alerts').textContent)`, 8000, 'listed under Recent alerts');
    await page.evaluate(`[...$('#set-alerts').querySelectorAll('label.check')].find(l => /battery is low/.test(l.textContent)).querySelector('input').click()`);
    await page.waitFor(`serverSettings.alerts.battery === false`, 5000, 'battery alerts off');
    const s = await settingsOf(ctx.srv);
    eq([s.alerts?.battery, s.alerts?.storage, s.alerts?.serverDisk], [false, true, true], 'only that one changed on the server');
    await page.evaluate(`[...$('#set-alerts').querySelectorAll('label.check')].find(l => /battery is low/.test(l.textContent)).querySelector('input').click()`);
    await page.waitFor(`serverSettings.alerts.battery === true`, 5000, 'battery alerts back on');
  });

  test('alerts: "Alert me when it goes offline" per device (Settings → Devices), then offline and back-online alerts', async ctx => {
    const fast = await ctx.startServer(8822, { BEAM_TEST_TIMEOUTS: '1' }); // a watched device alerts after 1.5 s offline
    ctx.defer(() => fast.stop());
    const phone = app(ctx, 'Pixel', 'android', fast);
    await phone.me();
    await phone.putStatus({ battery: { level: 55, charging: false }, os: 'Android 16' });
    let offline = phone.online();
    const page = await ctx.signedIn({ server: fast });
    await recordToasts(page);
    await page.evaluate(`openSettings('devices')`);
    const row = `[...$$('#set-devices .device-row')].find(r => /Pixel/.test(r.textContent))`;
    await page.waitFor(`serverSettings?.alerts && /55%/.test(${row}?.textContent)`, 8000, 'device row with its status');
    await page.evaluate(`${row}.querySelector('label.check input').click()`);
    await page.waitFor(`serverSettings.alerts.offline.includes('${phone.id}')`, 5000, 'offline alert on');
    assert((await settingsOf(fast)).alerts.offline.includes(phone.id), 'saved on the server');
    offline();
    await page.waitFor(`__toasts.some(t => /Pixel has been offline/.test(t))`, 15000, 'offline alert');
    offline = phone.online();
    ctx.defer(() => offline());
    await page.waitFor(`__toasts.some(t => /Pixel is back online/.test(t))`, 10000, 'back-online alert');
    // Still on after a re-render, and turning it off saves the whole (now empty) list.
    await page.waitFor(`${row}.querySelector('label.check input').checked`, 3000);
    await page.evaluate(`${row}.querySelector('label.check input').click()`);
    await page.waitFor(`serverSettings.alerts.offline.length === 0`, 5000, 'offline alert off');
  }, { timeout: 60000 });

  test('host: This PC offers "Open links sent to this PC automatically"', async ctx => {
    const { page } = await hostPage(ctx, { state: {} });
    await page.waitFor(`paired && hostState.ready`);
    await page.evaluate(`hostState.settings.autoOpenLinks = false; openSettings('pc')`);
    await page.waitFor(`$('#set-pc') !== null && /Open links sent to this PC automatically/.test($('#set-pc').textContent)`, 5000, 'toggle shown');
    const receiving = await page.evaluate(`(() => { const h = [...$('#set-pc').querySelectorAll('h4')]; const toggle = [...$('#set-pc').querySelectorAll('label.check')].find(l => /Open links sent/.test(l.textContent));
      return h.filter(x => x.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1).textContent; })()`);
    eq(receiving, 'Receiving', 'under Receiving');
    await page.evaluate(`[...$('#set-pc').querySelectorAll('label.check')].find(l => /Open links sent/.test(l.textContent)).querySelector('input').click()`);
    await page.waitFor(`__host.log.some(m => m.type === 'setSettings' && m.settings.autoOpenLinks === true)`, 3000, 'setSettings sent');
    // An older app without the setting: no toggle.
    const { page: old } = await hostPage(ctx);
    await old.waitFor(`paired && hostState.ready`);
    await old.evaluate(`delete hostState.settings.autoOpenLinks; openSettings('pc')`);
    await old.waitFor(`$('#set-pc') !== null && /Receiving/.test($('#set-pc').textContent)`, 5000);
    assert(!(await old.evaluate(`/Open links sent/.test($('#set-pc').textContent)`)), 'hidden when the app has no such setting');
  });

  test('pickers: a cold start with nothing saved waits for the device list (no lone "All devices" to tap)', async ctx => {
    const page = await ctx.signedIn({ mobile: true, width: 390, height: 800 });
    const phone = app(ctx, 'Pixel');
    await phone.me();
    await page.waitFor(`deviceById('${phone.id}') !== undefined`, 8000, 'phone known');
    // Something shared through the installed app waits in the share cache (what sw.js does with a share).
    const share = text => page.evaluate(`caches.open('beam-share').then(c => c.put(new Request('share/${ctx.uid()}'), new Response(${JSON.stringify(text)}, { headers: { 'X-Kind': 'text' } }))).then(() => true)`);
    await share('shared on a cold start');
    // A first launch after the update: no offline cache yet, and a slow device list (and event stream).
    await page.goto('about:blank');
    await page.send('Storage.clearDataForOrigin', { origin: ctx.srv.base, storageTypes: 'indexeddb' });
    let release = await holdRequests(page, ['*/api/devices*', '*/api/events*']);
    await page.goto(`${ctx.srv.base}/`);
    await page.waitFor(`$('#chooseDlg')?.open === true`, 10000, 'the chooser opens for the share');
    await ctx.sleep(300);
    const waiting = await page.evaluate(`({ rows: $$('#chooseList .conv').length, text: $('#chooseList').textContent, sidebar: $('#convList .devices-loading') !== null })`);
    eq(waiting.rows, 0, 'nothing to tap while the devices load');
    assert(/Loading your devices/.test(waiting.text) && !/All devices/.test(waiting.text), `loading state: ${waiting.text}`);
    assert(waiting.sidebar, 'the conversation list says so too');
    // The rows arrive; a tap that lands just as they appear doesn't count.
    await page.evaluate(`window.__early = new Promise(done => { const mo = new MutationObserver(() => { const b = $('#chooseList .conv[data-conv="all"]'); if (b) { mo.disconnect(); b.click(); done($('#chooseDlg').open); } }); mo.observe($('#chooseList'), { childList: true }); }); true`);
    await release();
    eq(await page.evaluate(`__early`), true, 'an early tap is ignored');
    await page.waitFor(`$$('#chooseList .conv').length >= 2 && $('#convList .devices-loading') === null`, 8000, 'devices listed');
    await ctx.sleep(500);
    await page.evaluate(`$('#chooseList .conv[data-conv="${phone.id}"]').click()`);
    await page.waitFor(`!$('#chooseDlg').open`, 3000, 'picked');
    assert(await until(ctx, async () => (await phone.items()).some(i => i.text === 'shared on a cold start')), 'the share was sent');
    eq((await phone.items()).find(i => i.text === 'shared on a cold start').to, [phone.id], 'to the phone only, not every device');
    // Next time the saved devices show at once, even while the server is slow.
    await share('shared again');
    release = await holdRequests(page, ['*/api/devices*', '*/api/events*']);
    await page.goto(`${ctx.srv.base}/`);
    await page.waitFor(`($('#chooseDlg')?.open === true && $$('#chooseList .conv').length >= 2) || $('#chooseList')?.textContent`, 10000, 'saved devices at once');
    await release();
    await page.evaluate(`$('#chooseDlg').close()`);
  }, { timeout: 60000 });
}
