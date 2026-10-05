// Features: search and find, forward, pin, delete with undo, clear, menus, the image viewer, previews,
// keyboard shortcuts, drafts, the "new messages" pill, drops, QR codes, drag-out, settings, paste, incoming progress.
import { assert, eq } from './harness.mjs';
import { dev, msgCount, PNG_1PX } from './tests-core.mjs';

const serverItems = async server => (await (await fetch(`${server.base}/api/items`, { headers: { Authorization: `Bearer ${server.key}` } })).json()).items;
async function withPhone(ctx, texts = [], opts = {}) {
  const page = await ctx.signedIn(opts);
  const meId = await page.evaluate('me.id');
  const phone = dev(ctx, 'Pixel');
  await phone.me();
  for (const t of texts) await phone.text(t, [meId]);
  await page.waitFor(`Boolean(deviceById('${phone.id}')) && itemsIn('${phone.id}').length === ${texts.length}`, 8000, 'phone known');
  await page.evaluate(`openConv('${phone.id}')`);
  return { page, phone, meId };
}
const key = (page, k, mods = {}) => page.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ctrlKey: ${Boolean(mods.ctrl)}, altKey: ${Boolean(mods.alt)}, shiftKey: ${Boolean(mods.shift)} }))`);

export default function register(test) {
  test('search: finds messages in every conversation (sidebar) and highlights matches in the thread', async ctx => {
    const { page, phone } = await withPhone(ctx, ['the invoice number is 4471', 'something else', 'invoice sent again']);
    await page.evaluate(`openSearch(); $('#searchInput').value = 'invoice'; runSearch.flush()`);
    eq(await page.evaluate(`$$('#searchResults .search-hit').length`), 2, 'two results in the sidebar');
    await page.evaluate(`$('#searchResults .search-hit').click()`);
    await page.waitFor(`current === '${phone.id}'`);
    await page.evaluate(`openThreadSearch(); $('#threadSearchInput').value = 'invoice'; runFind.flush()`);
    eq(await page.evaluate(`$('#threadSearchCount').textContent`), '2 of 2', 'match count');
    const hl = await page.evaluate(`HAS_HIGHLIGHTS ? [CSS.highlights.get('beam-find').size, CSS.highlights.get('beam-find-current').size] : 'none'`);
    eq(hl, [1, 1], 'matches highlighted without touching the DOM');
    await page.evaluate(`stepFind(-1)`);
    eq(await page.evaluate(`$('#threadSearchCount').textContent`), '1 of 2', 'previous match');
  });

  test('forward, pin (and the pinned view), delete with undo, clear a conversation', async ctx => {
    const { page, phone } = await withPhone(ctx, ['forward me', 'pin me', 'delete me']);
    const laptop = dev(ctx, 'Laptop', 'windows');
    await laptop.me();
    await page.waitFor(`Boolean(deviceById('${laptop.id}'))`);
    const id = text => page.evaluate(`itemsIn('${phone.id}').find(i => i.text === '${text}').id`);
    await page.evaluate(`forwardItem(itemMap.get('${await id('forward me')}'), ['${laptop.id}'])`);
    await page.waitFor(`itemsIn('${laptop.id}').some(i => i.text === 'forward me')`, 5000, 'forwarded');
    const fwd = (await serverItems(ctx.srv)).find(i => i.text === 'forward me' && i.to.includes(laptop.id));
    assert(fwd?.forwardedFrom, 'server made a forwarded copy');
    await page.evaluate(`togglePin(itemMap.get('${await id('pin me')}'))`);
    await page.waitFor(`!$('#pinnedBtn').hidden && $('#pinnedCount').textContent === '1'`, 5000, 'pinned count in the header');
    await page.evaluate(`togglePinnedView()`);
    eq(await page.evaluate(msgCount), 1, 'pinned-only view');
    await page.evaluate(`togglePinnedView()`);
    const del = await id('delete me');
    await page.evaluate(`deleteItems(['${del}'])`);
    assert(await page.evaluate(`!itemMap.has('${del}') && /Deleted/.test($('#toastText').textContent) && !$('#toastAction').hidden`), 'gone at once, with Undo');
    await page.evaluate(`$('#toastAction').click()`);
    await page.waitFor(`itemMap.has('${del}') && document.querySelector('[data-id="${del}"]') !== null`, 3000, 'undo brings it back');
    await page.evaluate(`deleteItems(['${del}'])`);
    await ctx.sleep(5600);
    assert(!(await serverItems(ctx.srv)).some(i => i.id === del), 'deleted on the server after the undo window');
    await page.evaluate(`void clearConversation('${phone.id}')`); // it waits for the confirm dialog
    await page.waitFor(`$('#genDlg').open`);
    await page.evaluate(`[...$('#genFoot').querySelectorAll('button')].at(-1).click()`);
    await page.waitFor(`itemsIn('${phone.id}').length === 0`, 3000, 'cleared');
    await ctx.sleep(5600);
    eq((await serverItems(ctx.srv)).filter(i => i.from === phone.id).length, 0, 'cleared on the server');
  }, { timeout: 60000 });

  test('menus: right-click and long-press open Beam’s menu; arrows, Enter and Esc work', async ctx => {
    const { page, phone } = await withPhone(ctx, ['see https://example.com/a and this']);
    const r = await page.evaluate(`(() => {
      const a = document.querySelector('#thread .text a'); const rect = a.getBoundingClientRect();
      a.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 2, clientY: rect.top + 2 }));
      return [...$('#menu').querySelectorAll('.menu-item span')].map(s => s.textContent);
    })()`);
    for (const label of ['Copy', 'Copy link', 'Open link', 'Select text', 'Forward…', 'Delete for everyone']) assert(r.includes(label), `menu has ${label} (${r})`);
    eq(await page.evaluate(`document.activeElement.classList.contains('menu-item')`), true, 'focus is in the menu');
    await key(page, 'ArrowDown');
    await key(page, 'Escape');
    assert(await page.evaluate(`$('#menu').hidden`), 'Esc closes it');
    // A phone: long-press shows the same actions as a bottom sheet.
    await page.viewport(390, 844, true);
    await page.evaluate(`openConv('${phone.id}')`); // phones show one pane at a time
    await ctx.sleep(300); // (the viewport's resize event closes open menus: let it pass first)
    await page.evaluate(`window.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch' })); document.querySelector('#thread .text').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 300 }))`);
    assert(await page.evaluate(`!$('#menu').hidden && $('#menu').classList.contains('sheet')`), 'bottom sheet on a phone');
    await page.evaluate(`[...$('#menu').querySelectorAll('.menu-item')].find(b => b.textContent.includes('Select text')).click()`);
    eq(await page.evaluate(`getSelection().toString()`), 'see https://example.com/a and this', '"Select text" selects the message');
  });

  test('image viewer: opens from a photo, zooms, steps with arrow keys and closes with Esc', async ctx => {
    const { page, phone, meId } = await withPhone(ctx, []);
    await phone.file('one.png', PNG_1PX, [meId]);
    await phone.file('two.png', PNG_1PX, [meId]);
    await page.waitFor(`itemsIn('${phone.id}').length === 2`);
    await page.evaluate(`document.querySelector('#thread .preview').click()`);
    await page.waitFor(`$('#lightbox').open`, 3000, 'viewer open');
    eq(await page.evaluate(`$('#lbCount').textContent`), '1 / 2', 'position');
    await page.evaluate(`$('#lbZoomIn').click()`);
    assert(await page.evaluate(`/scale\\(1\\.5\\)/.test($('#lbImg').style.transform)`), 'zoomed');
    await page.evaluate(`$('#lightbox').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
    eq(await page.evaluate(`[$('#lbCount').textContent, $('#lbImg').style.transform.includes('scale(1)')]`), ['2 / 2', true], 'next photo, zoom reset');
    await page.evaluate(`$('#lightbox').close()`);
  });

  test('previews: a text file shows its first 64 KB; a link gets a QR code', async ctx => {
    const { page, phone, meId } = await withPhone(ctx, ['https://example.com/scan-me']);
    await phone.file('notes.md', Buffer.from('# Notes\n\nline two\n'), [meId]);
    await page.waitFor(`itemsIn('${phone.id}').length === 2`);
    const md = await page.evaluate(`itemsIn('${phone.id}').find(i => i.name === 'notes.md').id`);
    await page.evaluate(`document.querySelector('[data-id="${md}"] .text-peek').click()`);
    await page.waitFor(`$('#genDlg').open && /line two/.test($('#genBody').textContent)`, 5000, 'text preview');
    await page.evaluate(`$('#genDlg').close(); showQr('https://example.com/scan-me')`);
    await page.waitFor(`$('#genBody img')?.complete && $('#genBody img').naturalWidth > 0`, 5000, 'QR image');
  });

  test('keyboard: Ctrl+K, Alt+↓, ↑ into the messages, Delete with undo, Esc back to the composer', async ctx => {
    const { page, phone } = await withPhone(ctx, ['older', 'newest']);
    await page.evaluate(`$('#text').focus()`);
    await key(page, 'k', { ctrl: true });
    await page.waitFor(`$('#genDlg').open && $('#genDlg').classList.contains('switcher')`, 3000, 'switcher');
    await page.evaluate(`$('#genDlg').close(); openConv('all')`);
    await page.evaluate(`$('#text').focus()`);
    await key(page, 'ArrowDown', { alt: true });
    await page.waitFor(`current !== 'all'`, 3000, 'Alt+↓ moved to the next conversation');
    await page.evaluate(`openConv('${phone.id}'); $('#text').value = ''; $('#text').focus()`);
    await key(page, 'ArrowUp');
    eq(await page.evaluate(`document.activeElement.querySelector('.text')?.textContent`), 'newest', '↑ focuses the last message');
    await key(page, 'ArrowUp');
    eq(await page.evaluate(`document.activeElement.querySelector('.text')?.textContent`), 'older', '↑ again');
    const id = await page.evaluate(`document.activeElement.dataset.id`);
    await key(page, 'Delete');
    assert(await page.evaluate(`!itemMap.has('${id}') && !$('#toastAction').hidden`), 'Delete removes it with Undo');
    await page.evaluate(`$('#toastAction').click()`);
    await page.waitFor(`itemMap.has('${id}')`, 3000);
    await page.evaluate(`document.querySelector('#thread .msg[data-id]').focus()`);
    await key(page, 'Escape');
    eq(await page.evaluate(`document.activeElement.id`), 'text', 'Esc returns to the composer');
  });

  test('drafts are kept per conversation; "new messages" pill when scrolled up', async ctx => {
    const texts = Array.from({ length: 40 }, (_, i) => `line ${i}\n`.repeat(3));
    const { page, phone, meId } = await withPhone(ctx, texts);
    await page.evaluate(`$('#text').value = 'half-written for the phone'; onComposerInput(); openConv('all')`);
    eq(await page.evaluate(`$('#text').value`), '', 'the other conversation has its own (empty) draft');
    await page.evaluate(`openConv('${phone.id}')`);
    eq(await page.evaluate(`$('#text').value`), 'half-written for the phone', 'draft restored');
    await page.evaluate(`$('#thread').scrollTop = 0; $('#thread').dispatchEvent(new Event('scroll'))`);
    await ctx.sleep(200);
    await phone.text('while you were reading', [meId]);
    await page.waitFor(`!$('#newPill').hidden`, 5000, 'pill shown');
    await page.evaluate(`$('#newPill').click()`);
    await page.waitFor(`$('#newPill').hidden && atBottom($('#thread'))`, 5000, 'jumped to the new message');
  });

  test('dropping text or a link on the thread sends it; dragging a file out carries a download', async ctx => {
    const { page, phone, meId } = await withPhone(ctx, []);
    await phone.file('drag-me.pdf', Buffer.from('%PDF-1.4'), [meId]);
    await page.waitFor(`itemsIn('${phone.id}').length === 1`);
    const rect = await page.evaluate(`(() => { const r = $('#thread').getBoundingClientRect(); return [r.left + r.width / 2, r.top + 40]; })()`);
    const data = { items: [{ mimeType: 'text/uri-list', data: 'https://example.com/dropped' }, { mimeType: 'text/plain', data: 'https://example.com/dropped' }], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await page.send('Input.dispatchDragEvent', { type, x: rect[0], y: rect[1], data });
    await page.waitFor(`itemsIn('${phone.id}').some(i => i.text === 'https://example.com/dropped')`, 5000, 'dropped link sent');
    const dl = await page.evaluate(`(() => { const dt = new DataTransfer(); document.querySelector('#thread .file-row').dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt })); return dt.getData('DownloadURL'); })()`);
    assert(/^application\/pdf:drag-me\.pdf:http:\/\/127\.0\.0\.1:\d+\/api\/file\/[0-9a-f]+$/.test(dl), `DownloadURL: ${dl}`);
  });

  test('paste: Office text+picture pastes the text; Ctrl+V outside a field asks before sending', async ctx => {
    const { page } = await withPhone(ctx, []);
    const r = await page.evaluate(`(() => {
      const box = $('#text'); box.focus();
      const dt = new DataTransfer(); dt.setData('text/plain', 'Q3 total\\t41,200');
      dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }));
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      box.dispatchEvent(ev);
      return [ev.defaultPrevented, $('#toastText').textContent, $('#toastAction').textContent];
    })()`);
    eq(r, [false, 'Pasted as text', 'Send the picture instead'], 'text wins; the picture is offered');
    await page.evaluate(`(() => { document.activeElement.blur(); const dt = new DataTransfer(); dt.setData('text/plain', 'my-secret-password'); document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
    await page.waitFor(`$('#genDlg').open && /my-secret-password/.test($('#genBody').textContent)`, 3000, 'preview first');
    await page.evaluate(`[...$('#genFoot').querySelectorAll('button')].find(b => b.textContent === 'Cancel').click()`);
    await ctx.sleep(500);
    eq(await page.evaluate(`items.some(i => i.text === 'my-secret-password')`), false, 'nothing sent without a confirm');
  });

  test('another device’s upload shows as “Receiving…” until the file arrives', async ctx => {
    const { page, phone, meId } = await withPhone(ctx, []);
    const size = 3 * 1024 * 1024;
    const init = await phone.post('/api/uploads', { name: 'incoming.bin', size, mime: 'application/octet-stream', to: [meId] });
    const put = (offset, n) => fetch(`${ctx.srv.base}/api/uploads/${init.id}?offset=${offset}`, { method: 'PUT', headers: { ...phone.headers, 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(n, 1) }).then(r => r.json());
    await put(0, 1024 * 1024);
    await page.waitFor(`document.querySelector('#thread .msg.pending')?.textContent.includes('Receiving from Pixel')`, 5000, 'receiving row');
    await ctx.sleep(1100);
    await put(1024 * 1024, 2 * 1024 * 1024);
    await page.waitFor(`itemsIn('${phone.id}').some(i => i.name === 'incoming.bin') && !document.querySelector('#thread .msg.pending')`, 5000, 'row replaced by the file');
  });

  test('settings: blocked Tailscale machines are listed with Unblock', async ctx => {
    const page = await ctx.signedIn();
    const calls = ctx.track(page, /\/api\/settings\/blocked-nodes\//);
    await page.evaluate(`openSettings('security')`);
    await page.waitFor(`serverSettings !== null && $('#set-security') !== null`, 8000);
    await page.evaluate(`serverSettings = { ...serverSettings, blockedNodes: [{ node: 'nABC123', name: 'old-phone', since: Date.now() - 7200e3, device: 'Pixel 7' }] }; document.activeElement.blur(); renderSettings()`);
    const text = await page.evaluate(`$('#set-security').textContent`);
    assert(/Blocked machines/.test(text) && /old-phone/.test(text) && /was Pixel 7/.test(text), `listed: ${text}`);
    await page.evaluate(`[...$('#set-security').querySelectorAll('button')].find(b => b.textContent === 'Unblock').click()`);
    await page.waitFor(`true`);
    await ctx.sleep(500);
    eq(calls.map(c => [c.method, new URL(c.url).pathname]), [['DELETE', '/api/settings/blocked-nodes/nABC123']], 'unblock request');
  });

  test('settings: Tailscale accounts: an owner from Settings can be removed, one from the configuration not; another account that signed in can be allowed, after asking (1.7.3)', async ctx => {
    const page = await ctx.signedIn();
    const calls = ctx.track(page, /\/api\/settings$/);
    await page.evaluate(`openSettings('security')`);
    await page.waitFor(`serverSettings !== null && $('#set-security') !== null`, 8000);
    await page.evaluate(`serverSettings = { ...serverSettings, tailscaleSignIn: true, tailscaleOwners: ['me@example.com', 'env@example.com'], tailscaleOwnersFixed: ['env@example.com'],
      tailscaleSeen: [{ login: 'aunt@example.com', since: Date.now() - 3600e3, last: Date.now() - 60e3, devices: ['Aunt PC'] }] }; document.activeElement.blur(); renderSettings()`);
    const text = await page.evaluate(`$('#set-security').textContent`);
    assert(/me@example\.com/.test(text) && /Set in the server’s configuration/.test(text) && /Other accounts that signed in/.test(text) && /aunt@example\.com/.test(text) && /on Aunt PC/.test(text), `listed: ${text}`);
    eq(await page.evaluate(`[...$('#set-security').querySelectorAll('button')].filter(b => b.textContent === 'Remove').length`), 1, 'only the owner from Settings has Remove');
    await page.evaluate(`[...$('#set-security').querySelectorAll('button')].find(b => b.textContent === 'Allow').click()`);
    await page.waitFor(`$('#genDlg').open && /aunt@example\\.com/.test($('#genTitle').textContent)`, 3000, 'asks first');
    await page.evaluate(`[...$('#genFoot').querySelectorAll('button')].find(b => b.textContent === 'Allow').click()`);
    await page.waitFor(`true`);
    await ctx.sleep(500);
    eq(calls.filter(c => c.method === 'PATCH').map(c => JSON.parse(c.body || '{}')), [{ allowOwner: 'aunt@example.com' }], 'the allow request');
  });

  test('settings: devices, password, retention (server settings), pairing link with expiry', async ctx => {
    const page = await ctx.signedIn();
    const phone = dev(ctx, 'Pixel');
    await phone.me();
    await page.evaluate(`openSettings('devices')`);
    await page.waitFor(`$('#set-devices')?.textContent.includes('Pixel') && $('#set-server')?.textContent.includes('used by')`, 8000, 'devices and storage');
    await page.evaluate(`(() => { const i = $('#set-security input[type=password]'); i.value = 'correct horse battery'; i.nextElementSibling.click(); })()`);
    await page.waitFor(`server.info && server.info.passwordSet === true`, 5000, 'password set');
    await page.evaluate(`(() => { const i = $('#set-server input[type=number]'); i.value = '21'; i.dispatchEvent(new Event('change')); })()`);
    await page.waitFor(`serverSettings && serverSettings.retentionDays === 21`, 5000, 'retention changed');
    const s = await (await fetch(`${ctx.srv.base}/api/settings`, { headers: { Authorization: `Bearer ${ctx.srv.key}` } })).json();
    eq(s.retentionDays, 21, 'saved on the server');
    await fetch(`${ctx.srv.base}/api/settings`, { method: 'PATCH', headers: { Authorization: `Bearer ${ctx.srv.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ retentionDays: 14 }) });
    await fetch(`${ctx.srv.base}/api/password`, { method: 'POST', headers: { Authorization: `Bearer ${ctx.srv.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: '' }) });
    await page.evaluate(`$('#settingsDlg').close(); openPairDialog()`);
    await page.waitFor(`$('#pairDlg').open`);
    await page.evaluate(`$('#pairLinkBox').open = true`);
    await page.waitFor(`/\\?key=bp_/.test($('#pairLink').value) && /Works once/.test($('#pairLinkExpiry').textContent)`, 5000, 'single-use link with expiry');
  });

  test('settings (1.8.1): Server → Backups (where, how often, the last one) and Back up now; Devices says when a PC’s settings were backed up', async ctx => {
    const page = await ctx.signedIn();
    const pc = dev(ctx, 'Desk PC', 'windows');
    await pc.me();
    const put = await fetch(`${ctx.srv.base}/api/devices/me/backup`, { method: 'PUT', headers: { ...pc.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ install: 'webtest-install-1', app: 'windows', version: '1.8.1', settings: { deviceName: 'Desk PC' } }) });
    eq(put.status, 204, 'the PC’s app keeps its settings there');
    await page.evaluate(`openSettings('server')`);
    await page.waitFor(`/A backup of this Beam every 24 h/.test($('#set-server')?.textContent || '') && /None yet/.test($('#set-server').textContent)`, 8000, 'Backups: none yet');
    await page.evaluate(`[...$$('#set-server button')].find(b => b.textContent === 'Back up now').click(); true`);
    await page.waitFor(`/The last: just now \\(/.test($('#set-server').textContent)`, 15000, 'backed up now');
    await page.evaluate(`openSettings('devices')`);
    await page.waitFor(`/Settings backed up just now/.test([...$$('#set-devices .device-row')].find(r => /Desk PC/.test(r.textContent))?.textContent || '')`, 8000, 'Devices: the PC’s settings backed up');
    eq(page.errors, [], 'no page errors');
  });

  test('settings: only the sections scroll, its title and × stay in view (devices listed, a small window); a click outside closes it', async ctx => {
    const page = await ctx.signedIn();
    await page.viewport(1000, 640);
    for (const name of ['Pixel', 'Laptop', 'Camera PC']) await dev(ctx, name).me();
    await page.evaluate(`openSettings('devices')`);
    await page.waitFor(`$('#set-devices')?.textContent.includes('Camera PC')`, 8000, 'devices listed');
    // (1.7.3) Hidden labels far down (the device facts' screen-reader text) made the whole dialog scroll as well, and
    // opening it scrolled the title and × out of view.
    const r = await page.evaluate(`(async () => {
      const d = $('#settingsDlg'), b = $('#settingsBody');
      const deep = el('span', { class: 'visually-hidden' }, 'Battery ');
      b.lastElementChild.append(deep);
      jumpToSection('help');
      await new Promise(res => setTimeout(res, 50));
      const head = d.querySelector('.dlg-head').getBoundingClientRect(), box = d.getBoundingClientRect();
      const out = { dialogScrolls: d.scrollHeight > d.clientHeight + 1, dialogTop: d.scrollTop, sectionsMoved: b.scrollTop > 0, headInView: head.top >= box.top && head.bottom <= box.bottom };
      deep.remove();
      return out;
    })()`);
    eq(r, { dialogScrolls: false, dialogTop: 0, sectionsMoved: true, headInView: true }, 'one scrolling area');
    const left = await page.evaluate(`$('#settingsDlg').getBoundingClientRect().left`);
    const p = { x: Math.max(2, Math.round(left / 2)), y: 300 };
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await page.waitFor(`!$('#settingsDlg').open`, 3000, 'closed by a click outside');
  });

  test('dialogs: one that replaces another (or a second chooser) is not ended by the first one closing', async ctx => {
    const page = await ctx.signedIn();
    const phone = dev(ctx, 'Pixel');
    await phone.me();
    await page.waitFor(`deviceById('${phone.id}') !== undefined`, 8000);
    // The browser fires the first dialog's "close" a moment later, while the second is already showing.
    const r = await page.evaluate(`(async () => {
      openDialog({ title: 'First', body: [] });
      let answer = 'pending';
      confirmDialog({ title: 'Second', text: 'Still here?' }).then(v => { answer = v; });
      await new Promise(res => setTimeout(res, 300));
      const shown = [$('#genDlg').open, $('#genTitle').textContent, answer];
      [...$('#genFoot').querySelectorAll('button')].find(b => b.textContent === 'OK').click();
      await new Promise(res => setTimeout(res, 100));
      return [...shown, answer];
    })()`);
    eq(r, [true, 'Second', 'pending', true], 'the confirm stays open and answers for itself');
    const c = await page.evaluate(`(async () => {
      let first = 'pending', second = 'pending';
      chooseConv('first').then(v => { first = v; });
      chooseConv('second').then(v => { second = v; });
      await new Promise(res => setTimeout(res, 300));
      const shown = [$('#chooseDlg').open, $('#chooseWhat').textContent, first, second];
      $('#chooseList .conv[data-conv="${phone.id}"]').click();
      await new Promise(res => setTimeout(res, 100));
      return [...shown, second];
    })()`);
    eq(c, [true, 'second', null, 'pending', phone.id], 'the first chooser gives way; the second one picks');
  });
}
