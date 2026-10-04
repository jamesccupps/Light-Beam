// Replies, reactions and edits in Beam's chat (1.14.0): from a message's menu, the bar above the message box, the
// quote (a tap goes to what it answers), the reactions row and the quick ones on top of the menu, the "edited" mark;
// what another device does arrives live.
import { assert, eq } from './harness.mjs';
import { dev } from './tests-core.mjs';

// A message's menu entry by its label, run as a tap would (false: not there).
const menuEntry = (page, id, label) => page.evaluate(`(() => {
  const e = itemMenuEntries(itemMap.get('${id}'), null, null).find(x => x && x.label === ${JSON.stringify(label)});
  if (!e) return false;
  e.action();
  return true;
})()`);

export default function register(test) {
  test('chat: Reply quotes the message (a tap on the quote goes there); quick reactions and the chips, another device’s arriving live; Edit puts the words in the box and the bubble says edited; another device’s edit arrives live (1.14.0)', async ctx => {
    const page = await ctx.signedIn();
    const meId = await page.evaluate('me.id');
    const phone = dev(ctx, 'Pixel');
    await phone.me();
    await phone.text('Where are the keys?', [meId]);
    await page.waitFor(`Boolean(deviceById('${phone.id}')) && itemsIn('${phone.id}').length === 1 && serverHas('replies')`, 8000, 'the question');
    await page.evaluate(`openConv('${phone.id}')`);
    const qid = await page.evaluate(`itemsIn('${phone.id}')[0].id`);
    const node = id => `view.nodes.get('m:${id}')`;

    // Reply: the bar, then the quote; Esc would have ended it.
    assert(await menuEntry(page, qid, 'Reply'), 'Reply in its menu');
    await page.waitFor(`!$('#composeBar').hidden && /Replying to Pixel/.test($('#composeBar').textContent)`, 3000, 'the bar');
    await page.evaluate(`$('#text').value = 'On the hook'; autosize(); sendComposer(); true`);
    await page.waitFor(`itemsIn('${phone.id}').some(i => i.text === 'On the hook' && i.reply?.id === '${qid}' && !i.sending)`, 8000, 'sent as a reply');
    eq(await page.evaluate(`$('#composeBar').hidden`), true, 'the bar is gone');
    const aid = await page.evaluate(`itemsIn('${phone.id}').find(i => i.text === 'On the hook').id`);
    eq(await page.evaluate(`[${node(aid)}.querySelector('.reply-quote .rq-who').textContent, ${node(aid)}.querySelector('.reply-quote .rq-text').textContent]`),
      ['Pixel', 'Where are the keys?'], 'the quote');
    const onServer = (await phone.items()).find(i => i.id === aid);
    eq(onServer.reply, { id: qid, kind: 'text', from: phone.id, device: 'Pixel', text: 'Where are the keys?' }, 'the server keeps what it answers');
    await page.evaluate(`${node(aid)}.querySelector('.reply-quote').click(); true`);
    await page.waitFor(`${node(qid)}.classList.contains('flash')`, 3000, 'the quote goes to the question');

    // Reactions: the quick row on top of the menu; another device's arrives live; a chip takes mine back.
    await page.evaluate(`openItemMenu(itemMap.get('${qid}'), $('#thread'))`);
    eq(await page.evaluate(`$$('#menu .quick-emoji').map(b => b.textContent)`), ['👍', '❤️', '😂', '😮', '😢', '🙏'], 'quick reactions on top');
    await page.evaluate(`$$('#menu .quick-emoji')[0].click(); true`);
    await page.waitFor(`(itemMap.get('${qid}').reactions?.['👍'] || []).includes(me.id) && ${node(qid)}.querySelector('.reaction.on') !== null`, 5000, 'mine, shown');
    const put = await fetch(`${ctx.srv.base}/api/items/${qid}/reactions/${encodeURIComponent('👍')}`, { method: 'PUT', headers: phone.headers });
    eq(put.status, 200, 'the phone reacts too');
    await page.waitFor(`${node(qid)}.querySelector('.reaction .r-n')?.textContent === '2'`, 5000, 'two, live');
    await page.evaluate(`${node(qid)}.querySelector('.reaction').click(); true`);
    await page.waitFor(`(itemMap.get('${qid}').reactions?.['👍'] || []).join() === '${phone.id}' && ${node(qid)}.querySelector('.reaction.on') === null`, 5000, 'mine taken back, the phone’s stays');

    // Edit: the words in the box, the bar says so; Enter saves; the bubble says edited.
    assert(await menuEntry(page, aid, 'Edit'), 'Edit in a text’s menu');
    await page.waitFor(`/Editing/.test($('#composeBar').textContent) && $('#text').value === 'On the hook'`, 3000, 'in the box');
    await page.evaluate(`$('#text').value = 'On the hook by the door'; autosize(); sendComposer(); true`);
    await page.waitFor(`itemMap.get('${aid}').text === 'On the hook by the door' && ${node(aid)}.querySelector('.meta .edited') !== null`, 5000, 'edited');
    eq(await page.evaluate(`[$('#composeBar').hidden, $('#text').value]`), [true, ''], 'the box is free again');
    // Another device's edit arrives live.
    const patch = await fetch(`${ctx.srv.base}/api/items/${qid}`, { method: 'PATCH', headers: { ...phone.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Where are the car keys?' }) });
    eq(patch.status, 200, 'the phone edits its question');
    await page.waitFor(`${node(qid)}.querySelector('.text').textContent === 'Where are the car keys?' && ${node(qid)}.querySelector('.meta .edited') !== null`, 5000, 'live');
    eq(await page.evaluate(`${node(aid)}.querySelector('.reply-quote .rq-text').textContent`), 'Where are the keys?', 'the reply still quotes it as it was');
  }, { timeout: 60000 });
}
