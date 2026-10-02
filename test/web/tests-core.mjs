// Rendering, selection and copying, unread rules, merges and removed devices, windowing, phone layout.
import { assert, eq } from './harness.mjs';

export const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
export const dev = (ctx, name, platform = 'android', server = ctx.srv) => server.device(`${platform.slice(0, 3)}${ctx.uid()}${ctx.uid()}`, name, platform, ctx.nextIp());
export const msgCount = `document.querySelectorAll('#thread .msg[data-id]').length`;

export default function register(test) {
  test('selection survives new items, receipts, uploads, refocus and presence changes', async ctx => {
    const page = await ctx.signedIn();
    const phone = dev(ctx, 'Pixel');
    await phone.me();
    const meId = await page.evaluate('me.id');
    for (const t of ['First message to copy', 'Second message', 'Third']) await phone.text(t, [meId]);
    await page.evaluate(`openConv('${phone.id}')`);
    await page.waitFor(`${msgCount} === 3`);
    const selected = await page.evaluate(`(() => {
      const t = document.querySelector('#thread .msg[data-id] .text');
      window.__node = t.closest('.msg');
      const r = document.createRange(); r.selectNodeContents(t);
      getSelection().removeAllRanges(); getSelection().addRange(r);
      return getSelection().toString();
    })()`);
    eq(selected, 'First message to copy', 'selection made');
    const kept = `getSelection().toString() === 'First message to copy' && document.querySelector('#thread .msg[data-id]') === window.__node`;
    await phone.text('A new message arrives', [meId]);
    await page.waitFor(`${msgCount} === 4`);
    assert(await page.evaluate(kept), 'kept after an incoming item');
    await page.evaluate(`sendText('reply from the page', '${phone.id}')`);
    await page.waitFor(`Boolean(itemsIn('${phone.id}').find(i => i.from === me.id))`);
    const mine = await page.evaluate(`itemsIn('${phone.id}').find(i => i.from === me.id).id`);
    await phone.ack(mine);
    await page.waitFor(`document.querySelector('[data-id="${mine}"] .tick.done') !== null`, 8000, 'delivery tick');
    assert(await page.evaluate(kept), 'kept after a delivery receipt');
    await page.evaluate(`sendFiles([new File(['hello'], 'note.txt', { type: 'text/plain' })])`);
    await ctx.sleep(200);
    assert(await page.evaluate(kept), 'kept while an upload starts');
    await page.waitFor(`items.some(i => i.name === 'note.txt') && !uploads.size`, 10000, 'upload finished');
    assert(await page.evaluate(kept), 'kept when the upload finishes');
    await ctx.setHidden(page, true);
    await ctx.setHidden(page, false);
    await page.evaluate('sync()');
    assert(await page.evaluate(kept), 'kept after the tab comes back and syncs');
    const off = phone.online();
    await ctx.sleep(900);
    off();
    await ctx.sleep(900);
    assert(await page.evaluate(kept), 'kept across presence changes');
  });

  test('copying across messages gives just their text; meta rows cannot be selected', async ctx => {
    const page = await ctx.signedIn();
    const phone = dev(ctx, 'Pixel');
    await phone.me();
    const meId = await page.evaluate('me.id');
    for (const t of ['one', 'two', 'three']) await phone.text(t, [meId]);
    await page.evaluate(`openConv('${phone.id}')`);
    await page.waitFor(`${msgCount} === 3`);
    const r = await page.evaluate(`(() => {
      const texts = [...document.querySelectorAll('#thread .msg[data-id] .text')];
      const range = document.createRange();
      range.setStart(texts[0].firstChild, 0);
      const last = texts.at(-1).firstChild;
      range.setEnd(last, last.length);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      const dt = new DataTransfer();
      const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      return { text: dt.getData('text/plain'), prevented: ev.defaultPrevented,
        userSelect: ['.meta', '.day', '.sender', '.ext', '.thread-head', '.conv'].map(s => { const n = document.querySelector(s); return n ? getComputedStyle(n).userSelect : 'none'; }),
        textSelect: getComputedStyle(document.querySelector('.msg .text')).userSelect };
    })()`);
    eq(r.text, 'one\n\ntwo\n\nthree', 'copied text');
    assert(r.prevented, 'our copy handler took over');
    assert(r.userSelect.every(v => v === 'none'), `meta/day/sender not selectable: ${r.userSelect}`);
    assert(r.textSelect !== 'none', 'message text is selectable');
  });

  test('a sync patches the thread instead of rebuilding it (expanded text, images, node identity)', async ctx => {
    const page = await ctx.signedIn();
    const phone = dev(ctx, 'Pixel');
    await phone.me();
    const meId = await page.evaluate('me.id');
    await phone.text(`long ${'lorem ipsum dolor sit amet '.repeat(60)}`, [meId]);
    await phone.file('pic.png', (await import('./tests-core.mjs')).PNG_1PX, [meId]);
    await page.evaluate(`openConv('${phone.id}')`);
    await page.waitFor(`${msgCount} === 2 && document.querySelector('#thread img')?.complete`);
    await page.evaluate(`document.querySelector('#thread .more').click(); window.__nodes = [...document.querySelectorAll('#thread .msg[data-id], #thread img')]`);
    const files = ctx.track(page, /\/api\/(file|items\/[^/]+\/thumb)/);
    await page.evaluate('sync()');
    await ctx.setHidden(page, true);
    await ctx.setHidden(page, false);
    await page.evaluate('sync()');
    await ctx.sleep(500);
    const same = await page.evaluate(`window.__nodes.every(n => n.isConnected) && [...document.querySelectorAll('#thread .msg[data-id], #thread img')].every((n, i) => n === window.__nodes[i])`);
    assert(same, 'the same message and image nodes stay on screen');
    assert(await page.evaluate(`!document.querySelector('#thread .text').classList.contains('clamp')`), '"Show more" stays open');
    eq(files.length, 0, 'no image re-downloads');
  });

  test('unread: history is read on first sign-in; a broadcast counts once and reading it anywhere clears it', async ctx => {
    const phone = dev(ctx, 'Pixel');
    const laptop = dev(ctx, 'Laptop', 'windows');
    await phone.me();
    await laptop.me();
    await phone.text('old broadcast from before this browser existed');
    const page = await ctx.signedIn();
    const meId = await page.evaluate('me.id');
    await page.waitFor('readMarks !== null && items.length > 0');
    eq(await page.evaluate('document.title'), 'Beam', 'a fresh browser starts with nothing unread');
    await laptop.text('from laptop', [meId]);
    await page.evaluate(`openConv('${laptop.id}')`);
    await phone.text('new broadcast');
    await phone.text('new direct', [meId]);
    await page.waitFor(`items.some(i => i.text === 'new direct')`);
    eq(await page.evaluate('document.title'), '(2) Beam', 'two unread items, the broadcast counted once');
    eq(await page.evaluate(`[unread('all'), unread('${phone.id}')]`), [1, 2], 'badges');
    await page.evaluate(`openConv('all')`);
    await page.waitFor(`document.title === '(1) Beam'`, 5000, 'title after reading All devices');
    eq(await page.evaluate(`unread('${phone.id}')`), 1, 'the broadcast read in All devices is read in Pixel too');
  });

  test('a merge keeps the open thread and its read state', async ctx => {
    const page = await ctx.signedIn();
    const meId = await page.evaluate('me.id');
    const ip = ctx.nextIp();
    const browserW = ctx.srv.device(`web${ctx.uid()}${ctx.uid()}`, 'Chrome on Work PC', 'web', ip);
    await browserW.me();
    await browserW.text('hello from the work browser', [meId]);
    await page.evaluate(`openConv('${browserW.id}')`);
    await page.waitFor(`${msgCount} === 1 && unread('${browserW.id}') === 0`);
    const app = ctx.srv.device(`win${ctx.uid()}${ctx.uid()}`, 'Work PC', 'windows', ip);
    await app.me(); // same machine: the work browser is merged into the app
    await page.waitFor(`current === '${app.id}' && !syncing && Boolean(deviceById('${app.id}'))`, 8000, 'thread follows the merge');
    eq(await page.evaluate(`[document.querySelector('#threadName').textContent, ${msgCount}, unread('${app.id}')]`), ['Work PC', 1, 0], 'same thread, nothing unread');
  });

  test('a removed device keeps its conversation (read-only) instead of vanishing', async ctx => {
    const page = await ctx.signedIn();
    const meId = await page.evaluate('me.id');
    const phone = dev(ctx, 'Old phone');
    const laptop = dev(ctx, 'Laptop', 'windows');
    await phone.me();
    await laptop.me();
    await phone.text('from the old phone', [meId]);
    await page.evaluate(`sendText('to the old phone', '${phone.id}')`);
    await page.evaluate(`openConv('${phone.id}')`);
    await page.waitFor(`${msgCount} === 2`);
    await laptop.forget(phone.id);
    await page.waitFor(`!deviceById('${phone.id}')`, 8000, 'device list update');
    await page.evaluate('sync()');
    const r = await page.evaluate(`({ name: $('#threadName').textContent, sub: $('#threadSub').textContent, msgs: ${msgCount},
      disabled: $('#text').disabled, listed: conversationOrder().includes('${phone.id}'), current })`);
    eq([r.name, r.msgs, r.disabled, r.listed, r.current], ['Old phone', 2, true, true, phone.id], 'history stays, sending is off');
    assert(/Removed/.test(r.sub), 'header says it was removed');
  });

  test('long threads are windowed; loading earlier messages keeps your place', async ctx => {
    const page = await ctx.signedIn();
    const meId = await page.evaluate('me.id');
    const phone = dev(ctx, 'Chatty phone');
    await phone.me();
    for (let i = 0; i < 330; i++) await phone.text(`message ${i}`, [meId]);
    await page.waitFor(`itemsIn('${phone.id}').length === 330`, 20000);
    await page.evaluate(`openConv('${phone.id}')`);
    const first = await page.evaluate(msgCount);
    eq(first, await page.evaluate('WINDOW'), `rendered a window (${first})`);
    const ms = await page.evaluate(`(() => { const t = performance.now(); renderThread(); return performance.now() - t; })()`);
    assert(ms < 40, `re-render with nothing new is cheap (${ms.toFixed(1)} ms)`);
    const before = await page.evaluate(`(() => { const box = $('#thread'); box.scrollTop = 0; box.dispatchEvent(new Event('scroll')); const n = [...box.querySelectorAll('.msg[data-id]')][3]; window.__anchor = n; return n.getBoundingClientRect().top; })()`);
    await page.evaluate(`loadOlder()`);
    const after = await page.evaluate(`[${msgCount}, window.__anchor.getBoundingClientRect().top]`);
    assert(after[0] > first, 'earlier messages were added');
    assert(Math.abs(after[1] - before) < 3, `the message you were looking at stays put (${before} → ${after[1]})`);
  });

  test('phone layout: nothing overflows at 375 px', async ctx => {
    const page = await ctx.signedIn({ width: 375, height: 812, mobile: true });
    const phone = dev(ctx, 'A device with a really quite long name for a phone');
    await phone.me();
    const meId = await page.evaluate('me.id');
    await phone.text(`${'averyveryverylongwordwithoutspaces'.repeat(6)} and a long preview line that keeps going`, [meId]);
    await page.waitFor(`rows.has('${phone.id}')`);
    const list = await page.evaluate(`[document.documentElement.scrollWidth, document.querySelector('.sidebar').getBoundingClientRect().width, $('#convList').scrollWidth <= $('#convList').clientWidth]`);
    assert(list[0] <= 375 && list[1] <= 375 && list[2], `list view fits: ${list}`);
    await page.evaluate(`openConv('${phone.id}')`);
    const thread = await page.evaluate(`[document.documentElement.scrollWidth, $('#thread').scrollWidth <= $('#thread').clientWidth, $('#app').classList.contains('in-thread')]`);
    assert(thread[0] <= 375 && thread[1] && thread[2], `thread view fits: ${thread}`);
    const target = await page.evaluate(`Math.min(...[...document.querySelectorAll('.composer button:not([hidden])')].map(b => b.getBoundingClientRect().height))`);
    assert(target >= 40, `composer buttons are big enough to tap (${target}px)`);
  });
}
