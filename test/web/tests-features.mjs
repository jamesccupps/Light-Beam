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
    eq(await page.evaluate(`[...$$('#searchResults .search-hit mark')].map(m => m.textContent)`), ['invoice', 'invoice'], 'the word marked in each text');
    eq(await page.evaluate(`[...$('#searchResults').childNodes].filter(n => n.nodeType === 3).map(n => n.textContent)`), [], 'no stray text (it said "false")');
    // (the audit, 2026-10-29) Found by the sender's name: the name is marked, not the text's first letters
    await page.evaluate(`$('#searchInput').value = 'pixel'; runSearch.flush()`);
    eq(await page.evaluate(`[...$$('#searchResults .search-hit')].map(h => [h.querySelector('.conv-name mark')?.textContent, h.querySelector('.conv-preview mark')?.textContent || null])[0]`), ['Pixel', null], 'the sender’s name marked');
    await page.evaluate(`$('#searchInput').value = 'invoice'; runSearch.flush()`);
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

  test('keyboard and screen readers (2026-10-28, audit 2026-10-11): the thread is one Tab stop and a message’s buttons join it only while it has focus; Enter opens its menu, whose reactions keys reach; arrivals read out, not the whole thread; errors as alerts', async ctx => {
    const { page, phone, meId } = await withPhone(ctx, ['older', 'newest']);
    await page.evaluate(`openConv('${phone.id}')`);
    eq(await page.evaluate(`[$('#thread').getAttribute('aria-live'), $('#arrivals').getAttribute('aria-live')]`), ['off', 'polite'], 'no live thread; a live region for arrivals');
    const stops = `[...$('#thread').querySelectorAll('.msg[data-id]')].map(m => m.tabIndex)`;
    eq(await page.evaluate(stops), [-1, 0], 'one message in the Tab order: the newest');
    eq(await page.evaluate(`[...$('#thread').querySelectorAll('.msg[data-id] button, .msg[data-id] a[href]')].filter(b => b.tabIndex >= 0).length`), 0, 'no message’s buttons in it');
    await page.evaluate(`$('#text').value = ''; $('#text').focus()`);
    await key(page, 'ArrowUp');
    await key(page, 'ArrowUp');
    eq(await page.evaluate(stops), [0, -1], 'the one focused last is the Tab stop');
    eq(await page.evaluate(`[...document.activeElement.querySelectorAll('button')].every(b => b.tabIndex === 0)`), true, 'with its buttons while it has focus');
    await key(page, 'Enter');
    await page.waitFor(`!$('#menu').hidden && document.activeElement.classList.contains('menu-item')`, 3000, 'Enter opens its menu');
    eq(await page.evaluate(`$$('#menu .quick-emoji').length`), 6, 'with the quick reactions');
    await key(page, 'ArrowUp');
    eq(await page.evaluate(`document.activeElement.textContent`), '👍', '↑ from the first item: the reactions');
    await key(page, 'ArrowRight');
    eq(await page.evaluate(`document.activeElement.textContent`), '❤️', '→ along them');
    await key(page, 'ArrowDown');
    eq(await page.evaluate(`document.activeElement === $$('#menu .menu-item:not(:disabled)')[0]`), true, '↓ back to the first item');
    await key(page, 'Escape');
    await phone.text('Are you there?', [meId]);
    await page.waitFor(`$('#arrivals').textContent.endsWith(': Are you there?')`, 5000, 'an arrival is read out');
    await page.evaluate(`toast('That didn’t work', { error: true })`);
    eq(await page.evaluate(`[$('#toast').getAttribute('role'), $('#toast').getAttribute('aria-live')]`), ['alert', 'assertive'], 'an error: an alert');
    await page.evaluate(`toast('Saved')`);
    eq(await page.evaluate(`$('#toast').getAttribute('role')`), 'status', 'the rest: a status');
    eq(page.errors, [], 'no page errors');
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
    await page.waitFor(`$('#set-devices')?.textContent.includes('Pixel')`, 8000, 'devices');
    await page.evaluate(`showSettingsPage('security')`);
    await page.waitFor(`$('#set-security input[type=password]') !== null`, 5000, 'Security');
    await page.evaluate(`(() => { const i = $('#set-security input[type=password]'); i.value = 'correct horse battery'; i.nextElementSibling.click(); })()`);
    await page.waitFor(`server.info && server.info.passwordSet === true`, 5000, 'password set');
    await page.evaluate(`showSettingsPage('server')`);
    await page.waitFor(`$('#set-server')?.textContent.includes('used by') && $('#set-server input[type=number]') !== null`, 8000, 'storage and retention');
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

  test('settings (1.8.1): Server → Backups (where, how often, the last one) and Back up now; a PC’s Device info says when its settings were backed up', async ctx => {
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
    await page.waitFor(`Boolean(deviceById('${pc.id}')?.backup)`, 8000, 'the page knows the PC and its backup');
    await page.evaluate(`$('#settingsDlg').close(); openDeviceInfo(deviceById('${pc.id}')); true`);
    await page.waitFor(`$('#genDlg').open && /Settings backed up\\s*just now/.test($('#genBody').textContent)`, 8000, 'Device info: the PC’s settings backed up');
    await page.evaluate(`$('#genDlg').close(); true`);
    eq(page.errors, [], 'no page errors');
  });

  test('settings: only the page scrolls, its title and × stay in view (a long page, a small window); a click outside closes it', async ctx => {
    const page = await ctx.signedIn();
    await page.viewport(1000, 640);
    for (const name of ['Pixel', 'Laptop', 'Camera PC']) await dev(ctx, name).me();
    await page.evaluate(`openSettings('devices')`);
    await page.waitFor(`$('#set-devices')?.textContent.includes('Camera PC')`, 8000, 'devices listed');
    // (1.7.3) Hidden labels far down (the device facts' screen-reader text) made the whole dialog scroll as well, and
    // opening it scrolled the title and × out of view.
    const r = await page.evaluate(`(async () => {
      const d = $('#settingsDlg'), b = $('#settingsBody');
      showSettingsPage('help');
      const deep = el('span', { class: 'visually-hidden' }, 'Battery ');
      b.lastElementChild.append(deep);
      await new Promise(res => setTimeout(res, 50));
      b.scrollTop = b.scrollHeight;
      await new Promise(res => setTimeout(res, 50));
      const head = d.querySelector('.dlg-head').getBoundingClientRect(), box = d.getBoundingClientRect();
      const out = { dialogScrolls: d.scrollHeight > d.clientHeight + 1, dialogTop: d.scrollTop, pageScrolled: b.scrollTop > 0, headInView: head.top >= box.top && head.bottom <= box.bottom };
      deep.remove();
      return out;
    })()`);
    eq(r, { dialogScrolls: false, dialogTop: 0, pageScrolled: true, headInView: true }, 'one scrolling area');
    const left = await page.evaluate(`$('#settingsDlg').getBoundingClientRect().left`);
    const p = { x: Math.max(2, Math.round(left / 2)), y: 300 };
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await page.waitFor(`!$('#settingsDlg').open`, 3000, 'closed by a click outside');
  });

  test('appearance (1.27): Settings → Appearance sets the look for all devices (another page follows at once) or this device’s own (it wins; the others keep theirs); a reload starts in it', async ctx => {
    const server = await ctx.startServer(8823); // (its own server: the look for all devices would follow other tests)
    ctx.defer(() => server.stop());
    const page = await ctx.signedIn({ server });
    const other = await ctx.signedIn({ server });
    const look = p => p.evaluate(`[document.documentElement.dataset.theme || '', getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()]`);
    eq(await look(page), ['', '#5a4bf0'], 'Beam’s own to start with (light, like the device here)');
    await page.evaluate(`openSettings('look')`);
    await page.waitFor(`$('#set-look') !== null && $$('#set-look .swatch').length === 10`, 5000, 'Appearance: the swatches');
    // All devices: dark, teal
    // Dark, then Teal at once (the second click builds on the first even before the server answers)
    await page.evaluate(`[...$$('#set-look .seg')].find(b => b.textContent === 'Dark').click(); $$('#set-look .swatch')[2].click(); true`);
    await page.waitFor(`fetch('api/settings').then(r => r.json()).then(s => s.appearance?.theme === 'dark' && s.appearance?.accent === '#0e7c86')`, 5000, 'dark and teal, saved for all devices');
    eq(await look(page), ['dark', await page.evaluate(`accentVars('#0e7c86')['--u-accent-d']`)], 'drawn: dark, teal readable on dark');
    await other.waitFor(`document.documentElement.dataset.theme === 'dark' && getComputedStyle(document.documentElement).getPropertyValue('--u-accent').trim() !== ''`, 8000, 'the other page follows at once');
    eq(await other.evaluate(`JSON.parse(localStorage.getItem('beam.look'))`), { theme: 'dark', accent: '#0e7c86' }, 'and keeps it for its next start');
    // This device only: light; the other page keeps the look for all devices
    await page.evaluate(`[...$$('#set-look input[type=radio]')][1].click()`);
    await page.waitFor(`Boolean(ownLook())`, 5000, 'its own look (a copy of the shared one to start)');
    await page.evaluate(`[...$$('#set-look .seg')].find(b => b.textContent === 'Light').click()`);
    await page.waitFor(`document.documentElement.dataset.theme === 'light' && ownLook()?.theme === 'light'`, 5000, 'light, here only');
    await ctx.sleep(800);
    eq((await look(other))[0], 'dark', 'the other page keeps dark');
    eq(await page.evaluate(`/has a look of its own/.test($('#set-look').textContent)`), true, 'the page says so');
    // A reload starts in its look, before the server answers (theme.js)
    await page.goto('about:blank');
    await page.goto(`${server.base}/`);
    eq(await page.evaluate(`document.documentElement.dataset.theme`), 'light', 'at once after a reload');
    await page.waitFor(`typeof paired !== 'undefined' && paired && net.state === 'online'`, 10000, 'signed in again');
    // Back to all devices: its own is dropped, the shared look comes back
    await page.evaluate(`openSettings('look')`);
    await page.waitFor(`$$('#set-look input[type=radio]').length === 2`, 5000);
    await page.evaluate(`[...$$('#set-look input[type=radio]')][0].click()`);
    await page.waitFor(`!ownLook() && document.documentElement.dataset.theme === 'dark'`, 5000, 'back to all devices: dark');
    // Like the device and Beam's own accent: nothing left over
    await page.evaluate(`[...$$('#set-look .seg')].find(b => b.textContent === 'Like the device').click()`);
    await page.waitFor(`serverLook?.theme === 'auto'`, 5000);
    await page.evaluate(`$$('#set-look .swatch')[0].click()`);
    await page.waitFor(`serverLook?.accent === null`, 5000);
    eq(await look(page), ['', '#5a4bf0'], 'Beam’s own again');
    await other.waitFor(`!document.documentElement.dataset.theme && getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#5a4bf0'`, 8000, 'on the other page too');
    eq([...page.errors, ...other.errors], [], 'no page errors');
  });

  test('text size (1.29): Settings → Appearance → Text size sizes every text (rem), for all devices or this one; another page follows; a reload starts in it; Normal leaves nothing', async ctx => {
    const server = await ctx.startServer(8823); // (its own server: the look for all devices would follow other tests)
    ctx.defer(() => server.stop());
    const page = await ctx.signedIn({ server });
    const other = await ctx.signedIn({ server });
    // The sizes: the body's text, a dialog title's, and the root's (16 px: the browser's own)
    const sizes = p => p.evaluate(`[getComputedStyle(document.body).fontSize, getComputedStyle(document.documentElement).fontSize, document.documentElement.dataset.text || '']`);
    eq(await sizes(page), ['15px', '16px', ''], 'Normal to start with');
    await page.evaluate(`openSettings('look')`);
    await page.waitFor(`[...$$('#set-look .seg')].some(b => b.textContent === 'Largest')`, 5000, 'Appearance: Text size');
    const pick = (p, label) => p.evaluate(`[...$$('#set-look .seg')].find(b => b.textContent === ${JSON.stringify(label)}).click(); true`);
    await pick(page, 'Largest');
    await page.waitFor(`document.documentElement.dataset.text === 'larger'`, 3000, 'at once here');
    eq(await sizes(page), ['19.5px', '20.8px', 'larger'], 'every text 130 %');
    await page.waitFor(`fetch('api/settings').then(r => r.json()).then(s => s.appearance?.text === 'larger')`, 5000, 'saved for all devices');
    await other.waitFor(`document.documentElement.dataset.text === 'larger'`, 8000, 'the other page follows');
    eq(await page.evaluate(`[...$$('#set-look .seg')].find(b => b.textContent === 'Largest').getAttribute('aria-pressed')`), 'true', 'shown as chosen');
    // A field keeps 16 px at least (a phone zooms into a smaller one): at Smaller too
    await pick(page, 'Smaller');
    await page.waitFor(`document.documentElement.dataset.text === 'small'`, 3000);
    eq(await page.evaluate(`[getComputedStyle(document.body).fontSize, getComputedStyle($('#text')).fontSize]`), ['13.5px', '16px'], 'Smaller: 90 %, the message box 16 px');
    // This device only: Larger here, the other page keeps Smaller
    await page.evaluate(`[...$$('#set-look input[type=radio]')][1].click()`);
    await page.waitFor(`Boolean(ownLook())`, 5000, 'its own look');
    await pick(page, 'Larger');
    await page.waitFor(`document.documentElement.dataset.text === 'large' && ownLook()?.text === 'large'`, 5000, 'Larger, here only');
    await ctx.sleep(800);
    eq((await sizes(other))[2], 'small', 'the other page keeps Smaller');
    // A reload starts in it (theme.js), before the server answers
    await page.goto('about:blank');
    await page.goto(`${server.base}/`);
    eq(await page.evaluate(`document.documentElement.dataset.text`), 'large', 'at once after a reload');
    await page.waitFor(`typeof paired !== 'undefined' && paired && net.state === 'online'`, 10000, 'signed in again');
    // Normal: nothing left (the server keeps no text at all)
    await page.evaluate(`openSettings('look')`);
    await page.waitFor(`[...$$('#set-look .seg')].some(b => b.textContent === 'Normal')`, 5000);
    await pick(page, 'Normal');
    await page.waitFor(`!document.documentElement.dataset.text`, 3000, 'Normal here');
    await page.waitFor(`fetch('api/devices').then(r => r.json()).then(r => { const a = r.devices.find(d => d.id === me.id)?.settings?.appearance; return a && !('text' in a); })`, 5000, 'nothing kept for Normal');
    eq(await sizes(page), ['15px', '16px', ''], 'as it was');
    eq([...page.errors, ...other.errors], [], 'no page errors');
  });

  test('settings, remade (2026-10-15): one page at a time by group; the search finds rows on every page and Esc clears it; old section names open the right page; a phone shows the list first and ‹ goes back', async ctx => {
    const page = await ctx.signedIn();
    await dev(ctx, 'Pixel').me();
    await page.evaluate(`openSettings('devices')`);
    await page.waitFor(`$('#set-devices')?.textContent.includes('Pixel')`, 8000, 'Devices');
    eq(await page.evaluate(`[$$('#settingsBody > .set-page').length, $('#settingsNav [aria-current="true"]').dataset.page, [...$$('#settingsNav .set-group-label')].map(x => x.textContent)]`),
      [1, 'devices', ['This device', 'All devices', 'Your Beam']], 'one page, its button current, the groups');
    await page.evaluate(`$('#settingsNav [data-page="security"]').click()`);
    await page.waitFor(`$('#set-security') !== null && !$('#set-devices')`, 3000, 'Security instead');
    const search = q => page.evaluate(`(() => { const s = $('#settingsSearch'); s.value = ${JSON.stringify(q)}; s.dispatchEvent(new Event('input')); return true; })()`);
    await search('password');
    await page.waitFor(`$('#settingsDlg').classList.contains('searching') && $('#set-security') !== null`, 3000, 'results');
    eq(await page.evaluate(`[...$$('#settingsBody .set-page')].map(p => p.id)`), ['set-security'], 'only Security has a password');
    await search('battery');
    await page.waitFor(`$('#set-alerts') !== null && [...$$('#set-alerts label.check')].filter(l => !l.closest('[hidden]')).length === 1`, 3000, 'Alerts: just the battery switch');
    await search('zzzz nothing');
    await page.waitFor(`/No settings match/.test($('#settingsBody').textContent)`, 3000, 'nothing found');
    await page.evaluate(`$('#settingsSearch').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true`);
    await page.waitFor(`!$('#settingsDlg').classList.contains('searching') && $('#settingsSearch').value === '' && $('#set-security') !== null && $('#settingsDlg').open`, 3000, 'Esc: the page again, Settings open');
    await page.evaluate(`openSettings('device')`);
    await page.waitFor(`$('#set-general input[type=text]') !== null`, 3000, 'the old "device": General');
    await page.evaluate(`$('#settingsDlg').close()`);
    // A phone: the list of pages, then a page with its name in the head and ‹ back.
    await page.viewport(390, 844, true);
    await page.evaluate(`openSettings()`);
    await page.waitFor(`$('#settingsDlg').classList.contains('on-list') && $('#settingsBody').children.length === 0`, 3000, 'the list of pages');
    await page.evaluate(`$('#settingsNav [data-page="alerts"]').click()`);
    await page.waitFor(`$('#settingsDlg').classList.contains('on-page') && $('#set-alerts') !== null && $('#settingsTitle').textContent === 'Alerts'`, 3000, 'Alerts, its name in the head');
    await page.evaluate(`$('#settingsBack').click()`);
    await page.waitFor(`$('#settingsDlg').classList.contains('on-list') && $('#settingsTitle').textContent === 'Settings'`, 3000, 'back to the list');
    await page.evaluate(`$('#settingsDlg').close()`);
    eq(page.errors, [], 'no page errors');
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

  test('text preview (1.25.3): UTF-16 with its mark or without, the Windows code page and UTF-8 read right; a file that isn’t text says so; a big log’s end; “Show only lines with…”', async ctx => {
    const { page, phone, meId } = await withPhone(ctx);
    const utf16 = (s, bom = true) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(s, 'utf16le')]);
    const lines = n => Array.from({ length: n }, (_, i) => `line ${i + 1}${i % 50 === 0 ? ' ERROR disk full' : ''}`).join('\r\n');
    const files = [
      ['ipconfig.txt', utf16('Windows IP Configuration\r\nIPv4 Address. . : 192.0.2.7\r\n')], // (Windows PowerShell's `>`)
      ['nobom.log', utf16('started fine\r\nstill fine\r\n', false)],
      ['ansi.csv', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x3b, 0x31, 0x0d, 0x0a])], // "café;1" in Windows-1252
      ['program.ppcl', Buffer.from('00010 C THE AIR HANDLER\n00020 ON(AHU1)\n')],
      ['really.txt', PNG_1PX], // a picture named .txt
      ['big.log', Buffer.from(lines(20000))],
    ];
    for (const [name, bytes] of files) await phone.file(name, bytes, [meId]);
    await page.waitFor(`itemsIn('${phone.id}').length === ${files.length}`, 8000, 'the files');
    eq(await page.evaluate(`TEXTLIKE.test('program.ppcl') && TEXTLIKE.test('settings.reg')`), true, 'PPCL and .reg are previewed');
    const open = async name => {
      await page.evaluate(`previewTextFile(itemsIn('${phone.id}').find(i => i.name === ${JSON.stringify(name)})); true`);
      await page.waitFor(`$('#genDlg').open && $('#genTitle').textContent === ${JSON.stringify(name)} && !/^Loading/.test($('#genBody pre').textContent)`, 8000, `${name} shown`);
      return page.evaluate(`[$('#genBody p').textContent, $('#genBody pre').textContent]`);
    };
    let [about, text] = await open('ipconfig.txt');
    assert(/UTF-16/.test(about) && text.startsWith('Windows IP Configuration') && !text.includes('\u0000'), `${about} | ${text.slice(0, 80)}`);
    [about, text] = await open('nobom.log');
    assert(/UTF-16/.test(about) && text.startsWith('started fine'), `${about} | ${text.slice(0, 40)}`);
    [about, text] = await open('ansi.csv');
    assert(/Windows \(ANSI\)/.test(about) && text.startsWith('café;1'), `${about} | ${text}`);
    [about, text] = await open('program.ppcl');
    assert(/UTF-8/.test(about) && /ON\(AHU1\)/.test(text), `${about} | ${text}`);
    [, text] = await open('really.txt');
    assert(/doesn’t look like a text file/.test(text), text);
    eq(await page.evaluate(`$('#genBody .line-filter').hidden`), true, 'no filter for it');
    // A big log: its start, then its end, then only its lines with “error” (case doesn't count).
    [about, text] = await open('big.log');
    assert(/^The first 64 KB of/.test(about) && text.startsWith('line 1 ERROR'), about);
    await page.evaluate(`[...$('#genFoot').querySelectorAll('button')].find(b => b.textContent === 'End').click(); true`);
    await page.waitFor(`/^The last 64 KB/.test($('#genBody p').textContent)`, 8000, 'its end');
    text = await page.evaluate(`$('#genBody pre').textContent`);
    assert(text.trimEnd().endsWith('line 20000') && !text.startsWith('line 1 '), text.slice(-40));
    await page.evaluate(`(() => { const i = $('#genBody .line-filter input[type=search]'); i.value = 'error'; i.dispatchEvent(new Event('input')); return true; })()`);
    await page.waitFor(`/ of /.test($('#genBody .line-count').textContent)`, 3000, 'filtered');
    const shown = await page.evaluate(`$('#genBody pre').textContent.split('\\n')`);
    assert(shown.length > 10 && shown.every(l => /ERROR disk full/.test(l)), shown.slice(0, 3).join(' | '));
    await page.evaluate(`$('#genDlg').close()`);
  });

  test('server log (1.25.3): Settings → Server log shows only the lines with what you type, or only warnings and errors; More lines', async ctx => {
    const page = await ctx.signedIn();
    await page.waitFor(`serverHas('logs')`, 8000, 'the server has its log');
    await page.evaluate(`showLogs(); true`);
    await page.waitFor(`$('#genDlg').open && $('#genBody pre').textContent.length > 0 && !/^Loading/.test($('#genBody pre').textContent)`, 8000, 'the log');
    const all = await page.evaluate(`$('#genBody pre').textContent.split('\\n').length`);
    await page.evaluate(`(() => { const i = $('#genBody .line-filter input[type=search]'); i.value = 'signed in'; i.dispatchEvent(new Event('input')); return true; })()`);
    await page.waitFor(`/ of /.test($('#genBody .line-count').textContent)`, 3000, 'filtered');
    const lines = await page.evaluate(`$('#genBody pre').textContent.split('\\n')`);
    assert(lines.length < all && lines.every(l => /signed in/i.test(l)), lines.slice(0, 3).join(' | '));
    await page.evaluate(`(() => { const i = $('#genBody .line-filter input[type=search]'); i.value = ''; i.dispatchEvent(new Event('input')); $('#genBody .line-filter label.check input').click(); return true; })()`);
    await page.waitFor(`/ of /.test($('#genBody .line-count').textContent)`, 3000, 'warnings and errors');
    const important = await page.evaluate(`$('#genBody pre').textContent.split('\\n')`);
    assert(important.every(l => /WARN|ERROR|FAIL|Crashed|Exception|!!|No warnings/i.test(l)), important.slice(0, 3).join(' | '));
    eq(await page.evaluate(`[...$('#genFoot').querySelectorAll('button')].map(b => b.textContent)`), ['More lines', 'Refresh']);
    await page.evaluate(`$('#genDlg').close()`);
  });
}
