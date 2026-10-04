// Screenshots of the main screens (only with --shots): desktop and phone, light and dark, host mode.
import path from 'node:path';
import { fakeHostScript } from './harness.mjs';
import { hostPage } from './tests-host.mjs';

export default function register(test) {
  test('screenshots', async ctx => {
    const srv = await ctx.startServer(8825);
    ctx.defer(() => srv.stop());
    const shot = (page, name) => page.screenshot(path.join(ctx.SHOTS, `${name}.png`));
    const phone = srv.device('androidpixel0001', 'Pixel 9 Pro XL', 'android', ctx.nextIp(), '1.3.0');
    const laptop = srv.device('windowslaptop001', 'Laptop', 'windows', ctx.nextIp(), '1.3.0');
    const work = srv.device('windowsworkpc001', 'Work PC', 'windows', ctx.nextIp(), '1.3.0');
    for (const d of [phone, laptop, work]) await d.me();
    // What the apps report (1.3.0). The low battery and storage raise alerts now, before any page is open (no toasts).
    await phone.putStatus({ battery: { level: 12, charging: false }, storage: { free: 1.6e9, total: 128e9 }, os: 'Android 16' });
    await laptop.putStatus({ battery: { level: 64, charging: true }, storage: { free: 180e9, total: 512e9 }, os: 'Windows 11 Home 24H2' });
    await work.putStatus({ storage: { free: 212e9, total: 1024e9 }, os: 'Windows 11 Pro 24H2', macs: ['02:00:00:00:00:01'], remoteDesktop: true });
    const stopPhone = phone.online();
    ctx.defer(stopPhone);

    // The browser whose screens we capture, and some history.
    const page = await ctx.signedIn({ server: srv, width: 1280, height: 800 });
    const meId = await page.evaluate('me.id');
    await phone.text('Here’s the address for Saturday: 42 Harbour Road', [meId]);
    await page.evaluate(`sendText('Thanks! Sending the tickets now.', 'androidpixel0001')`);
    await phone.text('Link from the recipe: https://example.com/recipes/lemon-cake', [meId]);
    // A photo with a real thumbnail, sent by another browser.
    const maker = await ctx.signedIn({ server: srv });
    await maker.evaluate(`(async () => {
      const c = new OffscreenCanvas(1600, 1066); const g = c.getContext('2d');
      const grd = g.createLinearGradient(0, 0, 1600, 1066); grd.addColorStop(0, '#6d5ef5'); grd.addColorStop(1, '#f5a25e');
      g.fillStyle = grd; g.fillRect(0, 0, 1600, 1066); g.fillStyle = 'rgba(255,255,255,.85)'; g.beginPath(); g.arc(1150, 330, 170, 0, 7); g.fill();
      g.fillStyle = '#2a3d2f'; g.beginPath(); g.moveTo(0, 1066); g.lineTo(520, 560); g.lineTo(900, 1066); g.fill(); g.beginPath(); g.moveTo(600, 1066); g.lineTo(1150, 480); g.lineTo(1600, 1066); g.fill();
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      sendFiles([new File([blob], 'IMG_2041.jpg', { type: 'image/jpeg' })], '${meId}');
    })()`);
    await maker.waitFor(`!uploads.size && items.some(i => i.name === 'IMG_2041.jpg' && i.thumb)`, 20000);
    await phone.file('Tickets - Saturday.pdf', Buffer.alloc(284000, 1), [meId]);
    await laptop.text('Meeting notes are in the shared folder', [meId]);
    await work.text('Build finished ✔', []);
    await page.evaluate(`openConv('androidpixel0001')`);
    await page.waitFor(`itemsIn('androidpixel0001').length >= 4 && [...document.querySelectorAll('#thread img')].every(i => i.complete)`, 10000);
    const mine = await page.evaluate(`itemsIn('androidpixel0001').find(i => i.from === me.id).id`);
    await phone.ack(mine);
    // (A slow upload, so it's still going when it's paused: on an idle PC 48 MB to localhost was done before the pause.)
    await page.send('Network.enable');
    await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 4 * 1024 * 1024 });
    await page.evaluate(`sendFiles([new File([new Uint8Array(48 * 1024 * 1024)], 'Holiday video.mp4', { type: 'video/mp4' })], 'androidpixel0001')`);
    await page.waitFor(`[...uploads.values()].some(u => (u.sent || 0) > 0)`, 10000);
    await page.evaluate(`pauseUpload([...uploads.values()][0])`);
    await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await ctx.sleep(600);
    await shot(page, 'desktop-light-thread');

    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await ctx.sleep(300);
    await shot(page, 'desktop-dark-thread');
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

    // Context menu and settings.
    await page.evaluate(`(() => { const t = document.querySelector('#thread .msg.theirs .text'); const r = t.getBoundingClientRect(); t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 10 })); })()`);
    await ctx.sleep(200);
    await shot(page, 'desktop-menu');
    await page.evaluate(`closeMenu(); openSettings('security')`);
    await page.waitFor(`$('#set-server')?.textContent.includes('used by')`, 8000);
    await ctx.sleep(300);
    await shot(page, 'desktop-settings');
    await page.evaluate(`$('#settingsDlg').close(); openPairDialog()`);
    await page.waitFor(`$('#pairDlg').open`);
    await shot(page, 'desktop-add-device');
    await page.evaluate(`$('#pairDlg').close(); openLightbox(items.find(i => i.name === 'IMG_2041.jpg'))`);
    await ctx.sleep(600);
    await shot(page, 'desktop-viewer');
    await page.evaluate(`$('#lightbox').close()`);
    // An approval request.
    await fetch(`${srv.base}/api/login-requests`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ctx.nextIp() }, body: JSON.stringify({ name: 'Chrome on work-laptop', platform: 'web' }) });
    await page.waitFor(`$('#approveDlg').open`, 5000);
    await ctx.sleep(1100);
    await shot(page, 'desktop-approve');
    await page.evaluate(`$('#denyBtn').click()`);
    // Offline banner.
    await page.evaluate(`net.fail({ error: new TypeError('Failed to fetch') }); renderBanner()`);
    await ctx.sleep(200);
    await shot(page, 'desktop-offline');
    await page.evaluate(`net.ok()`);
    // Device info and alerts (1.3.0).
    await page.evaluate(`openDeviceInfo(deviceById('androidpixel0001'))`);
    await page.waitFor(`$('#genDlg').open && Boolean(serverSettings?.alerts) && $('#genBody label.check') !== null`, 5000);
    await ctx.sleep(300);
    await shot(page, 'desktop-device-info');
    await page.evaluate(`$('#genDlg').close(); openSettings('alerts')`);
    await page.waitFor(`/battery is at 12/.test($('#set-alerts')?.textContent || '')`, 8000);
    await page.evaluate(`jumpToSection('alerts')`);
    await ctx.sleep(300);
    await shot(page, 'desktop-settings-alerts');
    await page.evaluate(`$('#settingsDlg').close()`);

    // Photos and files (1.12): a conversation's gallery, picking several there and in the thread.
    const makerId = await maker.evaluate('me.id');
    await maker.evaluate(`(async () => {
      const files = [];
      for (const [i, [a, b]] of [['#1f7a8c', '#bfdbf7'], ['#e07a5f', '#f2cc8f'], ['#3d405b', '#81b29a'], ['#ef476f', '#ffd166'], ['#118ab2', '#06d6a0'], ['#5f0f40', '#fb8b24']].entries()) {
        const c = new OffscreenCanvas(1200, 900); const g = c.getContext('2d');
        const grd = g.createLinearGradient(0, 0, 1200, 900); grd.addColorStop(0, a); grd.addColorStop(1, b);
        g.fillStyle = grd; g.fillRect(0, 0, 1200, 900); g.fillStyle = 'rgba(255,255,255,.7)'; g.beginPath(); g.arc(260 + i * 130, 330, 150, 0, 7); g.fill();
        files.push(new File([await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 })], 'PXL_2026100' + i + '.jpg', { type: 'image/jpeg' }));
      }
      files.push(new File([new Uint8Array(96000)], 'Receipt.pdf', { type: 'application/pdf' }));
      sendFiles(files, '${meId}');
    })()`);
    await maker.waitFor(`!uploads.size && items.filter(i => /^PXL_/.test(i.name) && i.thumb).length === 6 && items.some(i => i.name === 'Receipt.pdf')`, 30000);
    await page.evaluate(`openConv('${makerId}'); openGallery()`);
    await page.waitFor(`$$('#galleryPanel .gal-tile').length === 7 && $$('#galleryPanel .gal-tile img').every(i => i.complete && i.naturalWidth > 0)`, 10000);
    await shot(page, 'desktop-gallery');
    await page.evaluate(`startPicking(); for (const t of $$('#galleryPanel .gal-tile').slice(1, 4)) t.click()`);
    await ctx.sleep(200);
    await shot(page, 'desktop-gallery-picking');
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await ctx.sleep(300);
    await shot(page, 'desktop-dark-gallery-picking');
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await page.evaluate(`stopPicking(); closeGallery(); openConv('androidpixel0001'); startPicking(itemsIn('androidpixel0001')[0].id); togglePick(itemsIn('androidpixel0001')[2].id)`);
    await ctx.sleep(300);
    await shot(page, 'desktop-picking');
    await page.evaluate(`stopPicking()`);
    await page.viewport(390, 844, true);
    await page.evaluate(`openConv('${makerId}'); openGallery(); startPicking(); for (const t of $$('#galleryPanel .gal-tile').slice(0, 2)) t.click()`);
    await ctx.sleep(400);
    await shot(page, 'phone-gallery-picking');
    await page.evaluate(`stopPicking(); closeGallery()`);
    await page.viewport(1280, 800, false);

    // Phone.
    for (const dark of [false, true]) {
      const p = await ctx.signedIn({ server: srv, width: 390, height: 844, mobile: true, dark });
      await p.waitFor(`rows.size >= 4`, 8000);
      await ctx.sleep(400);
      await shot(p, `phone-${dark ? 'dark' : 'light'}-list`);
      const pid = await p.evaluate('me.id');
      await phone.text('On my way, 10 minutes', [pid]);
      await p.evaluate(`openConv('androidpixel0001')`);
      await ctx.sleep(500);
      await shot(p, `phone-${dark ? 'dark' : 'light'}-thread`);
      if (!dark) {
        await p.evaluate(`window.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch' })); document.querySelector('#thread .msg.theirs .text').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 300 }))`);
        await ctx.sleep(300);
        await shot(p, 'phone-menu-sheet');
        // A share on a cold start: the chooser waits for the device list instead of offering "All devices" alone.
        await p.evaluate(`closeMenu(); devicesKnown = false; window.__choice = chooseConv('1 shared item'); true`);
        await ctx.sleep(300);
        await shot(p, 'phone-chooser-loading');
        await p.evaluate(`markDevicesKnown(); $('#chooseDlg').close(); true`);
      }
    }

    // Sign-in screens.
    const lock = await ctx.browser.newPage({ xff: ctx.nextIp(), width: 1280, height: 800 });
    await lock.goto(`${srv.base}/`);
    await lock.waitFor(`/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test($('#loginCode').textContent)`, 10000);
    await shot(lock, 'desktop-sign-in');
    const lockPhone = await ctx.browser.newPage({ xff: ctx.nextIp(), width: 390, height: 844, mobile: true });
    await lockPhone.goto(`${srv.base}/`);
    await lockPhone.waitFor(`/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test($('#loginCode').textContent)`, 10000);
    await shot(lockPhone, 'phone-sign-in');

    // Host mode (the Windows app's window): transfers, saved files, This PC.
    const { page: host, appId } = await hostPage(ctx, { server: srv, width: 1100, height: 760 });
    await host.waitFor(`paired && hostState.ready`);
    const item = await phone.file('Scan 2026-09-30.pdf', Buffer.alloc(1200000, 2), [appId]);
    await phone.text('Can you print this?', [appId]);
    await host.waitFor(`items.some(i => i.id === '${item.id}')`);
    await host.evaluate(`openConv('androidpixel0001')`);
    await host.evaluate(`__host.emit({ type: 'localFile', itemId: '${item.id}', saved: true })`);
    await host.evaluate(`__host.emit({ type: 'transfer', transfer: { id: 'up:7', kind: 'upload', conversations: ['androidpixel0001'], name: 'Photos 2026.zip', size: 1932735283, done: 612368384, rate: 11534336, eta: 114, state: 'running', canCancel: true, canRetry: false } })`);
    await host.evaluate(`__host.emit({ type: 'transfer', transfer: { id: 'down:x', kind: 'download', auto: true, conversations: ['androidpixel0001'], name: 'Holiday video.mp4', size: 50331648, done: 20971520, rate: 0, eta: -1, state: 'retrying', status: 'Connection problem, retrying in 8 s', canCancel: true, canRetry: true } })`);
    await ctx.sleep(500);
    await shot(host, 'host-thread');
    await host.evaluate(`hostState.settings.autoOpenLinks = false; openSettings('pc')`);
    await host.waitFor(`$('#set-pc')?.textContent.includes('Save files to')`, 5000);
    await ctx.sleep(300);
    await shot(host, 'host-settings-this-pc');
  }, { timeout: 180000 });
}
