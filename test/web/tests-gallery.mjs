// Selecting several messages and the gallery (1.12, public/gallery.js): picking from a message's menu, taps,
// Shift+click and Ctrl+A; Copy, Forward and Delete on all of them; a conversation's photos, videos and files; the
// Windows app's copyFiles and dragOut with several files (a fake host).
import { assert, eq } from './harness.mjs';
import { dev, PNG_1PX } from './tests-core.mjs';
import { hostPage } from './tests-host.mjs';

const serverItems = async server => (await (await fetch(`${server.base}/api/items`, { headers: { Authorization: `Bearer ${server.key}` } })).json()).items;
const key = (page, k, mods = {}) => page.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ctrlKey: ${Boolean(mods.ctrl)}, shiftKey: ${Boolean(mods.shift)} }))`);
// A click; resolves whether its default action was prevented (a link that didn't open).
const tap = (page, sel, mods = {}) => page.evaluate(`(() => { const ev = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: ${Boolean(mods.ctrl)}, shiftKey: ${Boolean(mods.shift)} }); document.querySelector(${JSON.stringify(sel)}).dispatchEvent(ev); return ev.defaultPrevented; })()`);

async function withPhone(ctx, texts = []) {
  const page = await ctx.signedIn();
  const meId = await page.evaluate('me.id');
  const phone = dev(ctx, 'Pixel');
  await phone.me();
  for (const t of texts) await phone.text(t, [meId]);
  await page.waitFor(`Boolean(deviceById('${phone.id}')) && itemsIn('${phone.id}').length === ${texts.length}`, 8000, 'phone known');
  await page.evaluate(`openConv('${phone.id}')`);
  return { page, phone, meId };
}

export default function register(test) {
  test('select several: a message’s menu starts it, taps and Shift+click pick more; Copy, Forward and Delete act on all of them', async ctx => {
    const { page, phone } = await withPhone(ctx, ['first https://example.com/x', 'second', 'third', 'fourth']);
    const laptop = dev(ctx, 'Laptop', 'windows');
    await laptop.me();
    await page.waitFor(`Boolean(deviceById('${laptop.id}'))`);
    const ids = await page.evaluate(`itemsIn('${phone.id}').map(i => i.id)`);
    const sel = id => `#thread .msg[data-id="${id}"] .bubble`;
    // The menu's "Select": that message is picked, and the bar takes the message box's place.
    await page.evaluate(`openItemMenu(itemMap.get('${ids[1]}'), document.querySelector('[data-id="${ids[1]}"]'))`);
    await page.evaluate(`[...$('#menu').querySelectorAll('.menu-item')].find(b => b.textContent.trim() === 'Select').click()`);
    eq(await page.evaluate(`[pick.on, [...pick.ids], getComputedStyle($('#composer')).display, getComputedStyle($('#pickBar')).display, $('#pickBar .pick-count').textContent]`),
      [true, [ids[1]], 'none', 'flex', '1 selected'], 'picked, the bar instead of the message box');
    assert(await page.evaluate(`document.querySelector('[data-id="${ids[1]}"]').classList.contains('picked')`), 'it shows as picked');
    // A tap picks another: a link inside it doesn't open.
    const followed = !(await tap(page, `#thread .msg[data-id="${ids[0]}"] .text a`));
    eq([await page.evaluate(`[...pick.ids].sort()`), followed], [[ids[0], ids[1]].sort(), false], 'a tap on its link picks it instead (the link doesn’t open)');
    // A tap on a picked one unpicks it; Shift+click picks the range from the last one tapped.
    await tap(page, sel(ids[0]));
    eq(await page.evaluate(`[...pick.ids]`), [ids[1]], 'tapped again: unpicked');
    await tap(page, sel(ids[1])); // (unpicks ids[1]; the last one tapped is ids[1])
    await tap(page, sel(ids[3]), { shift: true });
    eq(await page.evaluate(`[...pick.ids].sort()`), [ids[1], ids[2], ids[3]].sort(), 'Shift+click: the range');
    eq(await page.evaluate(`$('#pickBar .pick-count').textContent`), '3 selected', 'the count');
    // Copy: their text, oldest first, a blank line between them.
    await page.evaluate(`window.__copied = null; writeClipboard = async t => { __copied = t; return true; }; 0`);
    await page.evaluate(`pickUi.copy.click()`);
    await page.waitFor(`__copied !== null`, 3000, 'copied');
    eq(await page.evaluate('__copied'), 'second\n\nthird\n\nfourth', 'the text of each, in order');
    assert(await page.evaluate('pick.on'), 'Copy keeps the selection');
    // Forward: one choice, all of them, in order.
    await page.evaluate(`pickUi.forward.click()`);
    await page.waitFor(`$('#chooseDlg').open && $('#chooseList [data-conv="${laptop.id}"]')`, 3000, 'the chooser');
    await page.evaluate(`$('#chooseList [data-conv="${laptop.id}"]').click()`);
    await page.waitFor(`itemsIn('${laptop.id}').length === 3`, 8000, 'forwarded');
    const fwd = (await serverItems(ctx.srv)).filter(i => i.to.includes(laptop.id) && i.forwardedFrom).sort((a, b) => a.ts - b.ts).map(i => i.text);
    eq(fwd, ['second', 'third', 'fourth'], 'forwarded copies on the server, in order');
    assert(await page.evaluate(`!pick.on && !$('#app').classList.contains('picking')`), 'Forward ends the selection');
    // Ctrl+click starts picking too; Ctrl+A picks the whole conversation; Delete removes them all, with Undo.
    await page.evaluate(`openConv('${phone.id}')`);
    await tap(page, sel(ids[0]), { ctrl: true });
    eq(await page.evaluate(`[pick.on, [...pick.ids]]`), [true, [ids[0]]], 'Ctrl+click started picking');
    await page.evaluate(`document.querySelector('[data-id="${ids[0]}"]').focus()`);
    await key(page, 'a', { ctrl: true });
    eq(await page.evaluate(`pick.ids.size`), 4, 'Ctrl+A: all four');
    await key(page, 'Delete');
    assert(await page.evaluate(`itemsIn('${phone.id}').length === 0 && /4 items deleted/.test($('#toastText').textContent) && !$('#toastAction').hidden && !pick.on`), 'gone at once, with Undo');
    await page.evaluate(`$('#toastAction').click()`);
    await page.waitFor(`itemsIn('${phone.id}').length === 4`, 3000, 'Undo brings them back');
    // Esc stops picking.
    await page.evaluate(`startPicking('${ids[2]}')`);
    await key(page, 'Escape');
    assert(await page.evaluate(`!pick.on && !document.querySelector('#thread .msg.picked') && getComputedStyle($('#composer')).display !== 'none'`), 'Esc: back to the message box');
    await page.evaluate(`startPicking('${ids[2]}'); pickUi.delete.click()`);
    await ctx.sleep(5600);
    eq((await serverItems(ctx.srv)).filter(i => ids.includes(i.id)).length, 3, 'deleted on the server after the undo window');
  }, { timeout: 60000 });

  test('gallery: photos and videos in a grid, other files in a list, newest first; a tap opens the viewer; Select picks several to download; Esc closes it', async ctx => {
    const texts = Array.from({ length: 30 }, (_, i) => `line ${i}\n`.repeat(3));
    const { page, phone, meId } = await withPhone(ctx, texts);
    for (const [name, bytes] of [['one.png', PNG_1PX], ['two.png', PNG_1PX], ['clip.mp4', Buffer.from('not really a video')], ['notes.txt', Buffer.from('notes')]]) await phone.file(name, bytes, [meId]);
    await page.waitFor(`itemsIn('${phone.id}').length === 34 && !$('#galleryBtn').hidden`, 8000, 'the header’s Photos and files');
    // Scrolled up in the thread: it comes back there afterwards.
    await page.evaluate(`$('#thread').scrollTop = 200; onThreadScroll()`);
    const before = await page.evaluate(`$('#thread').scrollTop`);
    await page.evaluate(`$('#galleryBtn').click()`);
    await page.waitFor(`gallery.open && $$('#galleryPanel .gal-tile').length === 3`, 3000, 'three tiles');
    eq(await page.evaluate(`[getComputedStyle($('#thread')).display, getComputedStyle($('#composer')).display, $$('#galleryPanel .gal-month').length, $$('#galleryPanel .gal-tab').map(t => t.textContent), $('#galleryBtn').getAttribute('aria-pressed')]`),
      ['none', 'none', 1, ['Photos & videos3', 'Files1'], 'true'], 'in place of the thread: one month, two tabs');
    eq(await page.evaluate(`$$('#galleryPanel .gal-tile').map(t => t.title.split(' · ')[0])`), ['clip.mp4', 'two.png', 'one.png'], 'newest first');
    eq(await page.evaluate(`$$('#galleryPanel .gal-tile').map(t => [Boolean(t.querySelector('img')), Boolean(t.querySelector('.gal-ph'))])`), [[false, true], [true, false], [true, false]], 'photos show, a video without a thumbnail shows its name');
    // A photo opens in the viewer (with the others: oldest first there, as in the thread).
    await tap(page, '#galleryPanel .gal-tile:nth-of-type(2)');
    await page.waitFor(`$('#lightbox').open`, 3000, 'the viewer');
    eq(await page.evaluate(`$('#lbCount').textContent`), '2 / 2', 'two.png, the newer of two photos');
    await page.evaluate(`$('#lightbox').close()`);
    // The video plays in a dialog.
    await tap(page, '#galleryPanel .gal-tile:nth-of-type(1)');
    await page.waitFor(`$('#genDlg').open && $('#genDlg video.gal-video')`, 3000, 'a video player');
    await page.evaluate(`$('#genDlg').close()`);
    // Files: a list.
    await page.evaluate(`$$('#galleryPanel .gal-tab')[1].click()`);
    eq(await page.evaluate(`$$('#galleryPanel .gal-file .gal-file-name').map(n => n.textContent)`), ['notes.txt'], 'other files as a list');
    await page.evaluate(`$$('#galleryPanel .gal-tab')[0].click()`);
    // Select: two photos, downloaded together (oldest first).
    await page.evaluate(`window.__dl = []; downloadItem = item => __dl.push(item.name); $('#galleryPanel .gal-select').click()`);
    assert(await page.evaluate(`pick.on && $('#galleryPanel .gal-select').hidden && /Tap photos/.test($('#pickBar .pick-count').textContent)`), 'Select: the bar, nothing picked yet');
    await tap(page, '#galleryPanel .gal-tile:nth-of-type(2)');
    await tap(page, '#galleryPanel .gal-tile:nth-of-type(3)');
    eq(await page.evaluate(`[$('#pickBar .pick-count').textContent, pickUi.save.textContent, $$('#galleryPanel .gal-tile.picked').length, $('#lightbox').open]`), ['2 selected', 'Download 2', 2, false], 'two picked (no viewer)');
    await page.evaluate(`pickUi.save.click()`);
    await page.waitFor(`__dl.length === 2`, 3000, 'both downloaded');
    eq(await page.evaluate('__dl'), ['one.png', 'two.png'], 'oldest first');
    // A photo deleted elsewhere goes from the gallery and from the selection.
    const two = await page.evaluate(`itemsIn('${phone.id}').find(i => i.name === 'two.png').id`);
    await phone.del(`/api/items/${two}`);
    await page.waitFor(`$$('#galleryPanel .gal-tile').length === 2 && pick.ids.size === 1 && $('#pickBar .pick-count').textContent === '1 selected'`, 8000, 'gone from the gallery and the selection');
    // Esc stops picking; Esc again closes the gallery, and the thread is where it was.
    await key(page, 'Escape');
    assert(await page.evaluate(`!pick.on && gallery.open`), 'Esc: picking stopped');
    await key(page, 'Escape');
    await page.waitFor(`!gallery.open && getComputedStyle($('#thread')).display !== 'none'`, 3000, 'closed');
    eq(await page.evaluate(`Math.abs($('#thread').scrollTop - ${before}) < 2`), true, 'the thread where it was');
    // Ctrl+F from the gallery: it closes, and find in the conversation opens.
    await page.evaluate(`openGallery()`);
    await key(page, 'f', { ctrl: true });
    await page.waitFor(`!gallery.open && !$('#threadSearch').hidden && document.activeElement === $('#threadSearchInput')`, 3000, 'Ctrl+F: find in the conversation');
    await page.evaluate(`closeThreadSearch()`);
    // A forced sign-out leaves nothing of it.
    await page.evaluate(`openGallery(); startPicking(); resetGallery()`);
    eq(await page.evaluate(`[gallery.open, pick.on, $('#app').classList.contains('gallery-open'), $('#galleryPanel').childElementCount]`), [false, false, false, 0], 'reset');
    // On a phone, the back button closes it (and nothing more).
    await page.viewport(390, 844, true);
    await page.evaluate(`openConv('${phone.id}')`);
    await ctx.sleep(300);
    await page.evaluate(`openGallery()`);
    await page.waitFor(`gallery.open && history.state?.gallery`, 3000, 'open on a phone');
    await page.evaluate(`history.back()`);
    await page.waitFor(`!gallery.open && $('#app').classList.contains('in-thread')`, 3000, 'back: closed, still in the conversation');
    // Opened with nothing before it in the history (a conversation opened from a link): Back or its × still only close it.
    for (const how of ['Back', 'its ×']) {
      await page.evaluate(`history.replaceState(null, ''); openGallery()`);
      await page.evaluate(how === 'Back' ? `history.back()` : `$('#galleryPanel .gal-bar .icon-btn').click()`);
      await ctx.sleep(500);
      eq(await page.evaluate(`[gallery.open, $('#app').classList.contains('in-thread')]`), [false, true], `${how}: closed, still in the conversation`);
    }
  }, { timeout: 60000 });

  test('host: picked files go onto the app’s clipboard together (copyFiles; ones not on this PC saved first), and a drag takes all of them (dragOut itemIds)', async ctx => {
    const features = ['transfers', 'localFiles', 'settings', 'clipboard', 'pickFiles', 'pickFolder', 'dragOut', 'dragOutDone', 'openPanel', 'copyFiles', 'dragOutMany'];
    const { page, appId } = await hostPage(ctx, { features });
    await page.waitFor(`paired && net.state === 'online' && hostState.ready`, 10000, 'host mode');
    const phone = dev(ctx, 'Pixel');
    await phone.me();
    await phone.file('a.png', PNG_1PX, [appId]);
    await phone.file('b.png', PNG_1PX, [appId]);
    await phone.text('words', [appId]);
    await page.waitFor(`itemsIn('${phone.id}').length === 3`, 8000, 'items');
    await page.evaluate(`openConv('${phone.id}')`);
    const [a, b, words] = await page.evaluate(`itemsIn('${phone.id}').map(i => i.id)`);
    const log = type => page.evaluate(`__host.log.filter(m => m.type === '${type}')`);
    // a.png is on this PC, b.png isn't: the first copyFiles names it; the page saves it, then asks again with the
    // clipboard's number.
    await page.evaluate(`__host.emit({ type: 'localFile', itemId: '${a}', saved: true }); 0`);
    await page.evaluate(`__host.reply('copyFiles', m => m.clipSeq === 7 ? { ok: true, result: { copied: m.itemIds.length } } : { ok: true, result: { missing: ['${b}'], clipSeq: 7 } });
      __host.reply('saveFile', m => { setTimeout(() => __host.emit({ type: 'localFile', itemId: m.itemId, saved: true }), 300); return null; }); 0`);
    await page.evaluate(`startPicking('${a}'); togglePick('${b}'); togglePick('${words}')`);
    eq(await page.evaluate(`[pickUi.copy.disabled, pickUi.save.textContent]`), [false, 'Save'], 'Copy (files, in the app); Save (one isn’t on this PC)');
    await page.evaluate(`pickUi.copy.click()`);
    await page.waitFor(`__host.log.filter(m => m.type === 'copyFiles').length === 2 && /2 files copied/.test($('#toastText').textContent)`, 8000, 'saved, then copied');
    const copies = await log('copyFiles');
    eq(copies.map(m => [m.itemIds, m.clipSeq ?? null]), [[[a, b], null], [[a, b], 7]], 'the files only (not the text), then again with the clipboard’s number');
    eq((await log('saveFile')).map(m => m.itemId), [b], 'the missing one saved first');
    eq(await page.evaluate(`pickUi.save.textContent`), 'Show in folder', 'all saved now');
    // Something else was copied meanwhile: the app leaves it, the page says so.
    await page.evaluate(`__host.reply('copyFiles', m => m.clipSeq ? { ok: false, code: 'clipboard-changed', error: 'Something else was copied meanwhile' } : { ok: true, result: { missing: ['${b}'], clipSeq: 9 } }); copyFilesHost([itemMap.get('${a}'), itemMap.get('${b}')]); 0`);
    await page.waitFor(`/Something else was copied meanwhile/.test($('#toastText').textContent) && $('#toastAction').textContent === 'Copy them now'`, 8000, 'clipboard changed: left alone');
    // A drag of a picked file takes the picked files along; a file not picked goes alone.
    await page.evaluate(`document.querySelector('[data-id="${b}"] .file-row').dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true })); 0`);
    await page.waitFor(`__host.log.filter(m => m.type === 'dragOut').length === 1`, 3000, 'dragOut');
    eq((await log('dragOut'))[0].itemIds, [a, b], 'one drag, both files');
    await page.evaluate(`__host.emit({ type: 'dragOutDone', itemId: '${a}' }); togglePick('${b}'); document.querySelector('[data-id="${b}"] .file-row').dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true })); 0`);
    await page.waitFor(`__host.log.filter(m => m.type === 'dragOut').length === 2`, 3000, 'dragOut again');
    eq(await page.evaluate(`[__host.log.filter(m => m.type === 'dragOut')[1].itemId, 'itemIds' in __host.log.filter(m => m.type === 'dragOut')[1]]`), [b, false], 'not picked: that one alone');
    // An app without copyFiles: Copy copies the text (files only come along in a newer app).
    await page.evaluate(`HOST.features = HOST.features.filter(f => f !== 'copyFiles'); renderPickBar(); 0`);
    eq(await page.evaluate(`copyPlan(pickedItems()).kind`), 'text', 'an older app: the text');
  });
}
