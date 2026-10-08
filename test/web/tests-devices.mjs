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
    // (1.7.1) How to sign in there: picking a PIN or Windows Hello ends in "A certification authority could not be contacted".
    await host.waitFor(`__toasts.some(t => /Opening Remote Desktop\\. Sign in with that PC’s Windows account: its email address \\(or user name\\) and password\\. Windows Hello or a PIN works only between PCs on the same work or school account/.test(t))`, 3000, 'how to sign in');
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

  test('connections (1.17): Settings → Connections shows each machine’s way and key, Test asks again; an offline app says why', async ctx => {
    const page = await ctx.signedIn();
    await recordToasts(page);
    await page.waitFor(`serverHas('connections')`, 8000, 'the server offers it');
    await page.waitFor(`navigator.serviceWorker.controller !== null`, 8000, 'the service worker took over (before the interception)');
    const DAY = 86400e3;
    const now = Date.now();
    const list = { tailscale: true, server: { name: 'beam-host', keyExpiry: now + 10 * DAY - 60e3 }, at: now, machines: [
      { id: 'shopdesk017', name: 'Shop Desktop', platform: 'windows', online: true, machine: { name: 'shop-desktop', ip: '100.64.17.2', online: true, keyExpiry: now + 170 * DAY }, path: { via: 'direct', lan: true, at: now - 120e3 } },
      { id: 'pixelphone1', name: 'Robin Phone', platform: 'android', online: true, machine: { name: 'pixel', ip: '100.64.17.3', online: true, keyExpiry: now + 2 * DAY - 60e3 }, path: null },
      { id: 'cameradesk1', name: 'Office Desktop', platform: 'windows', online: false, machine: { name: 'camera-desktop', ip: '100.64.17.4', online: false, lastSeen: now - 3 * 3600e3, keyExpiry: null }, path: null },
      { id: 'serverpc001', name: 'Desktop', platform: 'windows', online: true, machine: { name: 'beam-host', ip: '100.64.17.1', self: true, keyExpiry: now + 10 * DAY }, path: null },
    ] };
    const seen = [];
    page.on(m => {
      if (m.method !== 'Fetch.requestPaused') return;
      const { url, method } = m.params.request;
      seen.push([method, new URL(url).pathname]);
      const body = method === 'GET' ? list : { path: { via: 'relay', relay: 'nyc', ms: 48.6, at: Date.now(), tested: true } };
      page.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') }).catch(() => {});
    });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api/connections*', requestStage: 'Request' }] });
    ctx.defer(() => page.send('Fetch.disable').catch(() => {}));
    await page.evaluate(`openSettings('connections')`);
    const sec = `$('#set-connections')`;
    await page.waitFor(`${sec}?.querySelectorAll('.conn-list .device-row').length === 3`, 8000, 'three machines (not the server’s own)');
    const text = await page.evaluate(`${sec}.textContent`);
    assert(/This server’s Tailscale sign-in: Runs out .+ \(in 10 days\)/.test(text), `the server's key: ${text}`);
    assert(/Direct, on the same network · seen 2 min ago/.test(text), 'SHOP: the way it saw');
    assert(/Not talking to the server right now/.test(text), 'the phone: idle');
    assert(/Tailscale can’t reach it now \(last seen 3 h ago\)/.test(text), 'Camera: off');
    assert(/Doesn’t run out \(key expiry is off\)/.test(text), 'Camera: no expiry');
    eq(await page.evaluate(`[...${sec}.querySelectorAll('.conn-key.low, .conn-server.low')].length`), 2, 'the phone’s key (2 days) and the server’s (10 days) stand out');
    eq(await page.evaluate(`[...${sec}.querySelectorAll('.conn-list button')].map(b => b.textContent.trim())`), ['Test', 'Test'], 'no Test for a machine Tailscale can’t reach');
    await page.evaluate(`[...${sec}.querySelectorAll('.device-row')].find(r => /Robin Phone/.test(r.textContent)).querySelector('button').click()`);
    await page.waitFor(`/Through Tailscale’s relay in New York \\(slower\\) · 49 ms · tested just now/.test(${sec}.textContent)`, 5000, 'the test’s answer');
    assert(seen.some(([m, p]) => m === 'POST' && p === '/api/connections/pixelphone1/test'), JSON.stringify(seen));
    // Why an app is offline, from Tailscale's view of its machine (not in the first minutes: Tailscale is slow to notice)
    const why = d => page.evaluate(`offlineWhy(${JSON.stringify(d)})`);
    eq((await why({ online: false, platform: 'windows', lastSeen: now - 10 * 60e3, tailscale: { online: true } }))?.short, 'PC on, Beam not running');
    eq(await why({ online: false, platform: 'windows', lastSeen: Date.now() - 60e3, tailscale: { online: true } }), null, 'too soon to say');
    eq((await why({ online: false, platform: 'android', lastSeen: 0, tailscale: { online: false, lastSeen: now - 3600e3 } }))?.short, 'Off or asleep');
    eq((await why({ online: false, platform: 'android', lastSeen: 0, tailscale: { online: true, expired: true } }))?.low, true, 'a key that ran out stands out');
    eq(await why({ online: false, platform: 'web', lastSeen: 0, tailscale: { online: false } }), null, 'not for a browser');
    eq(await why({ online: true, platform: 'windows', tailscale: { online: true } }), null, 'online');
    await page.evaluate(`$('#settingsDlg').close()`);
    await page.evaluate(`openDeviceInfo({ id: 'someid00001', name: 'Garage PC', platform: 'windows', online: false, lastSeen: Date.now() - 600e3, tailscale: { ip: '100.64.17.9', online: false, keyExpiry: Date.now() + 5 * ${DAY} } })`);
    const facts = await page.evaluate(`[...$('#genBody').querySelectorAll('dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent, dt.nextElementSibling.classList.contains('low')])`);
    eq(facts.find(f => f[0] === 'Why')?.[1], 'Tailscale can’t reach it either: it’s off, asleep or without internet', 'device info says why');
    assert(/^Runs out .+ \(in 5 days\)$/.test(facts.find(f => f[0] === 'Tailscale sign-in')?.[1] || ''), JSON.stringify(facts));
    eq(facts.find(f => f[0] === 'Tailscale sign-in')?.[2], true, 'soon: stands out');
    await page.evaluate(`$('#genDlg').close()`);
  });

  test('history (1.18): a PC’s Device info shows what happened (a power loss, a Windows Update restart, when someone signed in) and since when it’s up', async ctx => {
    const page = await ctx.signedIn();
    await page.waitFor(`serverHas('history')`, 8000, 'the server offers it');
    const pc = app(ctx, 'Garage PC', 'windows');
    await pc.me();
    const H = 3600e3;
    const now = Date.now();
    const rec = (provider, id, at, data = []) => ({ log: 'System', id, provider, time: new Date(at).toISOString(), rec: Math.floor(at / 1000) % 1e7 + id, data });
    const start = at => rec('Microsoft-Windows-Kernel-General', 12, at, ['10', '0', '0', '0', '0', '0', new Date(at).toISOString()]);
    const lost = now - 2 * H;
    const upd = now - 26 * H;
    const r = await pc.post('/api/devices/me/history', { events: [
      rec('User32', 1074, upd, ['C:\\Windows\\uus\\AMD64\\MoNotificationUx.exe (GARAGE)', 'GARAGE', 'Operating System: Service pack (Planned)', '0x80020010', 'restart', '', 'GARAGE\\robin']),
      rec('Microsoft-Windows-Kernel-General', 13, upd + 60e3, [new Date(upd + 60e3).toISOString()]), start(upd + 90e3),
      rec('Microsoft-Windows-Winlogon', 7001, upd + 90e3 + 28 * 60e3, ['1', 'S-1-5-21-1-1-1-1001']),
      start(lost), rec('Microsoft-Windows-Kernel-Power', 41, lost + 3000, ['0', '0', '0', '0', '0', '0', '0']),
    ] });
    eq(r.added, 6, JSON.stringify(r));
    ctx.defer(pc.online()); // ("Up since" shows only while it's online)
    await page.waitFor(`deviceById('${pc.id}')?.online === true`, 8000, 'online');
    await page.evaluate(`openDeviceInfo(deviceById('${pc.id}'))`);
    await page.waitFor(`$('#genBody .history-list li') !== null`, 8000, 'the history');
    const rows = await page.evaluate(`[...$$('#genBody .history-list li')].map(li => [li.className, li.textContent])`);
    eq(rows.length, 2, JSON.stringify(rows));
    assert(/Lost power or froze \(no warning\)/.test(rows[0][1]) && /back up/.test(rows[0][1]) && /nobody has signed in since/.test(rows[0][1]), rows[0][1]);
    eq(rows[0][0], 'warn-row', 'a power loss stands out');
    assert(/Restarted for a Windows update/.test(rows[1][1]) && /signed in .+ \(28 min later\)/.test(rows[1][1]), rows[1][1]);
    const facts = await page.evaluate(`[...$('#genBody').querySelectorAll('dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent, dt.nextElementSibling.classList.contains('low')])`);
    const up = facts.find(f => f[0] === 'Up since');
    assert(up && /, after a power loss or freeze$/.test(up[1]) && up[2] === true, JSON.stringify(facts));
    await page.evaluate(`$('#genDlg').close()`);
    await page.evaluate(`openSettings('alerts')`);
    await page.waitFor(`/A PC lost power or crashed/.test($('#settingsDlg').textContent)`, 5000, 'the alert’s switch');
    await page.evaluate(`$('#settingsDlg').close()`);
  });

  test('speed test (1.18): Connections tests this device in the page (real test data to the server) and asks a PC’s app', async ctx => {
    const page = await ctx.signedIn();
    await recordToasts(page);
    await page.waitFor(`serverHas('speed-test')`, 8000, 'the server offers it');
    await page.waitFor(`navigator.serviceWorker.controller !== null`, 8000, 'the service worker took over (before the interception)');
    const meId = await page.evaluate(`me.id`);
    const now = Date.now();
    const list = { tailscale: true, server: { name: 'beam-host', keyExpiry: null }, at: now, machines: [
      { id: meId, name: 'This laptop', platform: 'web', online: true, machine: { name: 'laptop', ip: '100.64.20.5', online: true, keyExpiry: null }, path: null, speed: null, here: true },
      { id: 'shoppc00120', name: 'Shop Desktop', platform: 'windows', online: true, machine: { name: 'shop', ip: '100.64.20.2', online: true, keyExpiry: null }, path: null, speed: { down: 812.4, up: 38, at: now - 3600e3 }, speedTest: true },
      { id: 'phone000120', name: 'Robin Phone', platform: 'android', online: true, machine: { name: 'phone', ip: '100.64.20.4', online: true, keyExpiry: null }, path: null, speed: null },
    ] };
    const seen = [];
    page.on(m => {
      if (m.method !== 'Fetch.requestPaused') return;
      const { url, method } = m.params.request;
      seen.push([method, new URL(url).pathname]);
      const body = method === 'GET' ? list : { speed: { down: 95.2, up: 21.3, at: Date.now() } };
      page.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') }).catch(() => {});
    });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api/connections*', requestStage: 'Request' }] });
    ctx.defer(() => page.send('Fetch.disable').catch(() => {}));
    await page.evaluate(`openSettings('connections')`);
    const sec = `$('#set-connections')`;
    await page.waitFor(`${sec}?.querySelectorAll('.conn-list .device-row').length === 3`, 8000, 'three rows');
    const buttons = await page.evaluate(`[...${sec}.querySelectorAll('.device-row')].map(r => [r.querySelector('strong').textContent, [...r.querySelectorAll('button')].map(b => b.textContent.trim())])`);
    eq(buttons, [['This laptop · this device', ['Test', 'Test speed']], ['Shop Desktop', ['Test', 'Test speed']], ['Robin Phone', ['Test']]], 'Test speed for this device and a PC’s app (not the phone)');
    assert(/Speed: 812 Mbit\/s down · 38 Mbit\/s up · tested 1 h ago/.test(await page.evaluate(`${sec}.textContent`)), 'the PC’s last result');
    // this device: real test data to the scratch server, about 3 s each way
    const t0 = Date.now();
    await page.evaluate(`[...${sec}.querySelectorAll('.device-row')][0].querySelectorAll('button')[1].click()`);
    await page.waitFor(`/Testing download speed…/.test(${sec}.textContent)`, 3000, 'it says what it does');
    await page.waitFor(`/Speed: [\\d.]+ Mbit\\/s down · [\\d.]+ Mbit\\/s up · tested just now/.test([...${sec}.querySelectorAll('.device-row')][0].textContent)`, 20000, 'this device’s result');
    const took = Date.now() - t0;
    assert(took < 15000, `about 3 s each way at most, or 64 MB each way when quicker (${took} ms)`);
    console.log(`        (this PC through loopback: ${await page.evaluate(`[...${sec}.querySelectorAll('.device-row')][0].querySelector('.conn-speed').textContent`)})`);
    const kept = await fetch(`${ctx.srv.base}/api/devices`, { headers: { Authorization: `Bearer ${ctx.srv.key}` } }).then(r => r.json());
    assert(kept.devices.some(d => d.id === meId), 'the page’s device');
    // a PC's app: asked through the server (answered here by the interception)
    await page.evaluate(`[...${sec}.querySelectorAll('.device-row')][1].querySelectorAll('button')[1].click()`);
    await page.waitFor(`/Speed: 95 Mbit\\/s down · 21 Mbit\\/s up · tested just now/.test([...${sec}.querySelectorAll('.device-row')][1].textContent)`, 8000, 'the PC’s new result');
    assert(seen.some(([m, p]) => m === 'POST' && p === '/api/connections/shoppc00120/speed'), JSON.stringify(seen));
    eq(await page.evaluate(`__toasts.filter(t => /error|couldn/i.test(t))`), [], 'no errors');
    await page.evaluate(`$('#settingsDlg').close()`);
  }, { timeout: 60000 });

  test('updates one PC first (1.19): Settings → Server says where a new Windows build is, and can offer it to every PC', async ctx => {
    const page = await ctx.signedIn();
    await recordToasts(page);
    await page.waitFor(`serverHas('staged-updates')`, 8000, 'the server offers it');
    await page.evaluate(`openSettings('server')`);
    await page.waitFor(`/A new version goes to one PC first/.test($('#set-server')?.textContent || '')`, 8000, 'the switch');
    const now = Date.now();
    const show = rollout => page.evaluate(`serverSettings = { ...serverSettings, rollout: ${JSON.stringify(rollout)} }; renderSettings(); $('#set-server').textContent`);
    let text = await show({ version: '1.14.0', pilot: 'hostpc00120', pilotName: 'Desktop', since: now - 120e3, installedAt: now - 60e3, releaseAt: now + 540e3, released: null, halted: null, running: 1, pcs: 7 });
    assert(/Desktop runs Beam for Windows 1\.14\.0 since .+\. The other PCs get it at .+ if it keeps running\./.test(text), text);
    assert(/Offer it to every PC now/.test(text), 'the button');
    text = await show({ version: '1.15.0', pilot: 'hostpc00120', pilotName: 'Desktop', since: now - 120e3, installedAt: null, releaseAt: null, released: null, halted: { at: now, problem: 'it didn’t start' }, running: 0, pcs: 7 });
    assert(/Beam for Windows 1\.15\.0 didn’t work on Desktop \(it didn’t start\), so the other PCs kept the version they have\./.test(text) && /Offer it to every PC anyway/.test(text), text);
    text = await show({ version: '1.14.0', pilot: 'hostpc00120', pilotName: 'Desktop', since: now - 3600e3, installedAt: now - 3000e3, releaseAt: null, released: now - 2400e3, halted: null, running: 6, pcs: 7 });
    assert(/went to every PC 40 min ago \(6 of 7 PCs run it\)/.test(text) && !/Offer it to every PC/.test(text), text);
    // the button asks the server (here a real one, with nothing waiting: it says so)
    await show({ version: '1.15.0', pilot: 'hostpc00120', pilotName: 'Desktop', since: now - 120e3, installedAt: null, releaseAt: null, released: null, halted: null, running: 0, pcs: 7 });
    await page.evaluate(`[...$('#set-server').querySelectorAll('button')].find(b => /Offer it to every PC now/.test(b.textContent)).click()`);
    await page.waitFor(`__toasts.some(t => /No Windows build is waiting to go to every PC/.test(t))`, 5000, 'the server’s answer');
    await page.evaluate(`$('#settingsDlg').close()`);
  });

  test('setup check and a PC’s log (1.20): Settings → Server → Setup lists the checks; Device info → Beam log shows the PC’s answer', async ctx => {
    const page = await ctx.signedIn();
    await recordToasts(page);
    await page.waitFor(`serverHas('setup-check') && serverHas('device-logs')`, 8000, 'the server offers them');
    await page.evaluate(`openSettings('server')`);
    await page.waitFor(`$$('#set-server .setup-list li').length >= 2`, 10000, 'the checks');
    const rows = await page.evaluate(`[...$$('#set-server .setup-list li')].map(li => li.textContent)`);
    assert(rows.some(t => /^Room on the server’s disk/.test(t.replace(/'/g, '’'))) && rows.some(t => /^Devices reach Beam over https/.test(t)), JSON.stringify(rows));
    assert(/Checked [^.]+\. Beam looks again every 6 hours/.test(await page.evaluate(`$('#set-server').textContent`)), 'when (the first ask, or an earlier one in a long run)');
    await page.evaluate(`[...$('#set-server').querySelectorAll('button')].find(b => b.textContent === 'Check again').click()`);
    await page.waitFor(`[...$('#set-server').querySelectorAll('button')].some(b => b.textContent === 'Check again' && !b.disabled)`, 8000, 'checked again');
    await page.evaluate(`$('#settingsDlg').close()`);
    // a PC with Beam for Windows 1.14: its log, asked from here, answered by it (a stand-in) through the server
    const pc = ctx.srv.device(`win${ctx.uid()}${ctx.uid()}`, 'Shop PC', 'windows', ctx.nextIp(), '1.14.0');
    await pc.me();
    const stream = pc.stream();
    ctx.defer(() => stream.close());
    await page.waitFor(`deviceById('${pc.id}')?.online === true && deviceById('${pc.id}')?.can?.log === true`, 8000, 'online, and can send its log');
    await page.evaluate(`openDeviceInfo(deviceById('${pc.id}'))`);
    await page.waitFor(`[...$('#genFoot').querySelectorAll('button')].some(b => b.textContent.trim() === 'Beam log')`, 5000, 'the button');
    await page.evaluate(`[...$('#genFoot').querySelectorAll('button')].find(b => b.textContent.trim() === 'Beam log').click()`);
    const deadline = Date.now() + 8000;
    let req;
    while (!(req = stream.events.find(e => e.event === 'log-request')) && Date.now() < deadline) await ctx.sleep(100);
    assert(req, 'the PC was asked');
    const text = '2026-10-07 21:00:00.000  Events: connected\n2026-10-07 21:00:01.000  History: nothing new\n';
    await pc.post('/api/devices/me/log', { id: req.data.id, name: 'beam.log', text });
    await page.waitFor(`$('#genTitle')?.textContent === 'Shop PC: beam.log' && /History: nothing new/.test($('#genBody pre.logs')?.textContent || '')`, 8000, 'the log shown');
    const foot = await page.evaluate(`[...$('#genFoot').querySelectorAll('button')].map(b => b.textContent.trim())`);
    assert(foot.includes('Copy') && foot.includes('Save'), JSON.stringify(foot));
    await page.evaluate(`$('#genDlg').close()`);
  });

  test('apps (1.21): Settings → Apps adds an app (winget, a file), installs it on all PCs (a PC asks first, then says it’s installed) and uninstalls it; This PC’s switch', async ctx => {
    const page = await ctx.signedIn();
    await recordToasts(page);
    await page.waitFor(`serverHas('apps')`, 8000, 'the server offers it');
    const pc = ctx.srv.device(`win${ctx.uid()}${ctx.uid()}`, 'Shop PC', 'windows', ctx.nextIp(), '1.16.0');
    await pc.me();
    const stream = pc.stream();
    ctx.defer(() => stream.close());
    await page.waitFor(`deviceById('${pc.id}')?.online === true && deviceById('${pc.id}')?.can?.apps === true`, 8000, 'online, and can install apps');
    await page.evaluate(`openSettings('apps')`);
    await page.waitFor(`/No apps yet/.test($('#set-apps')?.textContent || '') || $$('#set-apps .app-row').length > 0`, 8000, 'the section');
    // winget: typed and added
    const name = `Pkg${ctx.uid()}`;
    await page.evaluate(`(() => { const i = $('#set-apps input[aria-label="winget id"]'); i.value = 'Test.${name}'; $('#set-apps [data-act="add-winget"]').click(); })()`);
    await page.waitFor(`[...$$('#set-apps .app-row')].some(r => r.textContent.includes('${name}') && r.textContent.includes('winget Test.${name}'))`, 8000, 'the winget app listed');
    // a file, sent from the page
    await page.evaluate(`sendAppFile(new File([new Uint8Array([77, 90, 0, 1])], 'tool${name}.exe'), null)`);
    await page.waitFor(`[...$$('#set-apps .app-row')].some(r => r.textContent.includes('tool${name}') && r.textContent.includes('a file you sent · tool${name}.exe, 4 B'))`, 8000, 'the file app listed');
    const appId = await page.evaluate(`appsState.apps.find(a => a.name === 'tool${name}').id`);
    const asks = () => stream.events.filter(e => e.event === 'app-install' && e.data.id === appId).length;
    // (1.16.1) Install on…: the list of PCs opens inside Settings, on top (it opened unseen behind it), and asks that PC
    await page.evaluate(`$('#set-apps .app-row[data-app="${appId}"] [data-act="install-on"]').click()`);
    await page.waitFor(`!$('#menu').hidden && $('#menu').parentElement === $('#settingsDlg')`, 5000, 'Install on…: the list, in Settings');
    eq(await page.evaluate(`(() => { const b = [...$$('#menu .menu-item')].find(x => x.textContent.includes('Shop PC')); if (!b) return 'no Shop PC';
      const r = b.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.menu-item') === b || 'covered'; })()`), true, 'Shop PC in the list, on top');
    await page.evaluate(`[...$$('#menu .menu-item')].find(x => x.textContent.includes('Shop PC')).click()`);
    for (const until = Date.now() + 8000; !asks() && Date.now() < until;) await ctx.sleep(100);
    assert(asks() === 1, 'Install on… → Shop PC: the PC was asked');
    await page.waitFor(`$('#menu').hidden && $('#settingsDlg').open`, 3000, 'the list closed, Settings still open');
    // Install on all PCs: the PC is asked; it asks whoever is there; then it's installed
    await page.evaluate(`$('#set-apps .app-row[data-app="${appId}"] [data-act="install-all"]').click()`);
    for (const until = Date.now() + 8000; asks() < 2 && Date.now() < until;) await ctx.sleep(100);
    assert(asks() === 2, 'Install on all PCs: the PC was asked');
    await page.waitFor(`__toasts.some(t => /tool${name}: asked .*Shop PC/.test(t))`, 5000, 'the toast');
    await pc.post('/api/devices/me/apps', { id: appId, state: 'asked' });
    await page.waitFor(`/Shop PC: waiting for an answer at the PC \\(Beam shows the question there\\)/.test($('#set-apps .app-row[data-app="${appId}"]')?.textContent || '')`, 8000, 'asked, shown');
    await pc.post('/api/devices/me/apps', { id: appId, state: 'installed', version: '1.0' });
    await page.waitFor(`/Shop PC: installed 1\\.0Uninstall/.test($('#set-apps .app-row[data-app="${appId}"]')?.textContent || '')`, 8000, 'installed, shown, with Uninstall');
    // Uninstall (confirmed): asked of the PC; gone from the list once it says so
    await page.evaluate(`[...$('#set-apps .app-row[data-app="${appId}"]').querySelectorAll('button')].find(b => b.textContent === 'Uninstall').click()`);
    await page.waitFor(`/Uninstall tool${name} from Shop PC\\?/.test($('#genTitle')?.textContent || '')`, 5000, 'confirm');
    await page.evaluate(`[...$('#genFoot').querySelectorAll('button')].find(b => b.textContent === 'Uninstall').click()`);
    let un;
    for (const until = Date.now() + 8000; !(un = stream.events.find(e => e.event === 'app-uninstall' && e.data.id === appId)) && Date.now() < until;) await ctx.sleep(100);
    assert(un, 'the PC was asked to uninstall');
    await pc.post('/api/devices/me/apps', { id: appId, state: 'removed' });
    await page.waitFor(`!/Shop PC:/.test($('#set-apps .app-row[data-app="${appId}"]')?.textContent || 'Shop PC:')`, 8000, 'gone from the PC');
    // Remove the winget app from Beam
    const wgId = await page.evaluate(`appsState.apps.find(a => a.source === 'Test.${name}').id`);
    await page.evaluate(`[...$('#set-apps .app-row[data-app="${wgId}"]').querySelectorAll('button')].find(b => b.textContent === 'Remove…').click()`);
    await page.waitFor(`/Remove ${name} from Beam\\?/.test($('#genTitle')?.textContent || '')`, 5000, 'confirm');
    await page.evaluate(`[...$('#genFoot').querySelectorAll('button')].find(b => b.textContent === 'Remove').click()`);
    await page.waitFor(`!$('#set-apps .app-row[data-app="${wgId}"]')`, 8000, 'removed');
    await page.evaluate(`$('#settingsDlg').close()`);
    eq(page.errors, [], 'no page errors');
    // The Windows app's This PC: on → "Ask first again" turns it off; off → the app's own confirmation.
    const { page: host } = await hostPage(ctx, { state: {} });
    await host.waitFor(`paired && hostState.ready`);
    await host.evaluate(`hostState.settings.appsAllowed = true; openSettings('pc')`);
    await host.waitFor(`/without asking, each with a notice/.test($('#set-pc')?.textContent || '')`, 5000, 'on');
    await host.evaluate(`[...$('#set-pc').querySelectorAll('button')].find(b => /Ask first again/.test(b.textContent)).click()`);
    await host.waitFor(`__host.log.some(m => m.type === 'setSettings' && m.settings.appsAllowed === false)`, 3000, 'off: setSettings');
    await host.evaluate(`hostState.settings.appsAllowed = false; renderSettings()`);
    await host.waitFor(`/Beam asks here before installing an app/.test($('#set-pc')?.textContent || '')`, 5000, 'off');
    // (1.16.1) An app waiting for an answer at this PC: a bar at the top of the window (not only a notification and the
    // tray menu). Install… brings up the app's own question; Not now answers; the bar goes when the app says so.
    await host.evaluate(`$('#settingsDlg').close(); hostState.settings.appAsks = [{ id: 'old1', name: 'Slate' }]; renderBanner()`);
    assert(!(await host.evaluate(`!!$('#banner [data-app-ask]')`)), 'an app without appAsk: no bar');
    const { page: asking } = await hostPage(ctx, { features: ['transfers', 'localFiles', 'settings', 'openPanel', 'allowApps', 'appAsk'],
      settings: { appsAllowed: false, appAsks: [{ id: 'app1', name: 'Slate', version: '0.3.0', by: 'Desktop', source: 'GitHub example/slate' }] } });
    await asking.waitFor(`paired && hostState.ready`);
    await asking.waitFor(`!$('#banner').hidden && /Install Slate 0\\.3\\.0 on this PC\\? Desktop asked for it\\./.test($('#banner').textContent)`, 5000, 'the bar');
    await asking.evaluate(`$('#banner [data-act="app-ask"]').click()`);
    await asking.waitFor(`__host.log.some(m => m.type === 'appAsk' && m.app === 'app1' && !m.choice)`, 3000, 'Install…: the app’s own question');
    await asking.evaluate(`$('#banner [data-act="app-notnow"]').click()`);
    await asking.waitFor(`__host.log.some(m => m.type === 'appAsk' && m.app === 'app1' && m.choice === 'notnow')`, 3000, 'Not now');
    await asking.evaluate(`__host.emit({ type: 'settings', settings: { ...hostState.settings, appAsks: [] } })`);
    await asking.waitFor(`$('#banner').hidden`, 3000, 'answered: the bar goes');
    eq(asking.errors, [], 'no page errors (the bar)');
  });

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
