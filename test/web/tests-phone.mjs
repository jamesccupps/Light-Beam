// Phone notifications (1.5, feature `phone-notifications`): the Phone entry and panel, reply / action / dismiss /
// Dismiss all with their outcomes, the switches, memory only, the Windows app's window and hidden pages. A fake phone
// (below) talks the protocol to the scratch server like Beam for Android does.
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './cdp.mjs';
import { assert, eq } from './harness.mjs';
import { dev } from './tests-core.mjs';
import { hostPage } from './tests-host.mjs';

const FEATURE = 'phone-notifications';

// A phone sharing notifications: it posts and removes them, keeps its event stream open (or not: "offline") and
// answers what PCs ask it, by default by doing it ('ok'; a dismissal also removes the notification, as Android
// does), or with an error ('fail:<message>'), or not at all ('silent').
function fakePhone(ctx, server = ctx.srv, name = 'Pixel 9') {
  const d = dev(ctx, name, 'android', server);
  const phone = { id: d.id, dev: d, answer: 'ok', requests: [], abort: null };
  const call = (method, path, body) => fetch(`${server.base}${path}`, {
    method, headers: { ...d.headers, ...(body !== undefined && { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  phone.post = async (key, fields = {}) => {
    const r = await call('PUT', `/api/phone/notifications/${encodeURIComponent(key)}`, {
      app: 'com.example.chat', appName: 'Chat', icon: null, title: 'Someone', text: 'Hello', lines: [], conversation: null,
      when: Date.now(), silent: false, actions: [{ id: 'a0', title: 'Reply', reply: true }, { id: 'a1', title: 'Mark as read' }], ...fields,
    });
    if (r.status !== 204) throw new Error(`posting ${key}: ${r.status} ${await r.text()}`);
  };
  phone.remove = key => call('DELETE', `/api/phone/notifications/${encodeURIComponent(key)}`);
  phone.removeAll = () => call('DELETE', '/api/phone/notifications');
  phone.online = async () => {
    await d.me();
    const ac = new AbortController();
    phone.abort = ac;
    let opened;
    const ready = new Promise(r => { opened = r; });
    fetch(`${server.base}/api/events?device=${d.id}&platform=android&name=${encodeURIComponent(name)}`, { headers: d.headers, signal: ac.signal }).then(async res => {
      opened();
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^event: notification-request$/m.test(block)) phone.handle(JSON.parse(/^data: (.*)$/m.exec(block)[1]));
        }
      }
    }).catch(() => {});
    await ready;
  };
  phone.offline = () => { phone.abort?.abort(); phone.abort = null; };
  phone.handle = async req => {
    phone.requests.push(req);
    if (phone.answer === 'silent') return;
    const fail = phone.answer.startsWith('fail:') ? phone.answer.slice(5) : '';
    if (!fail && req.kind === 'dismiss') for (const key of req.keys || []) await phone.remove(key);
    await call('POST', `/api/phone/requests/${encodeURIComponent(req.request)}`, fail ? { ok: false, error: fail } : { ok: true });
  };
  // Afterwards: nothing of this phone's left on the shared server (another test's page would list it).
  ctx.defer(async () => { phone.offline(); await phone.removeAll().catch(() => {}); });
  return phone;
}

const setShown = (server, id, on) => fetch(`${server.base}/api/devices/${encodeURIComponent(id)}/settings`, {
  method: 'PUT', headers: { Authorization: `Bearer ${server.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ phoneNotifications: on }),
}).then(r => r.status);

const note = id => `document.querySelector('.phone-note[data-id="${id}"]')`;
const statusOf = id => `(${note(id)}?.querySelector('.phone-status')?.textContent || '')`;

// What `re` matches in anything the page keeps (IndexedDB: every database and store; Cache Storage; web storage),
// with a little around it; false if nothing.
const inStorage = (page, re) => page.evaluate(`(async () => {
  const dbs = indexedDB.databases ? await indexedDB.databases() : [{ name: 'beam' }];
  const parts = [];
  for (const { name } of dbs) {
    const db = await new Promise(r => { const q = indexedDB.open(name); q.onsuccess = () => r(q.result); q.onerror = () => r(null); });
    if (!db) continue;
    for (const store of db.objectStoreNames) {
      const all = await new Promise(r => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => r(q.result); q.onerror = () => r([]); });
      parts.push(JSON.stringify(all));
    }
    db.close();
  }
  for (const key of await caches.keys()) for (const req of await (await caches.open(key)).keys()) parts.push(req.url + await (await (await caches.open(key)).match(req)).text().catch(() => ''));
  parts.push(JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }));
  const all = parts.join(' '), m = ${re}.exec(all);
  return m ? all.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60) : false;
})()`);

// Holds the page's list answers (GET /api/phone/notifications, already computed by the server) until release(),
// which comes back once the page has them.
async function holdLists(page) {
  const held = [];
  const finished = new Set();
  const on = m => {
    if (m.method === 'Fetch.requestPaused') held.push(m.params);
    else if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') finished.add(m.params.requestId);
  };
  page.on(on);
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/phone/notifications', requestStage: 'Response' }] });
  return {
    async caught() { for (let i = 0; !held.length; i++) { if (i > 160) throw new Error('no list request'); await sleep(50); } },
    async release() {
      const ids = [];
      for (const p of held.splice(0)) { ids.push(p.networkId); await page.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}); }
      for (let i = 0; !ids.every(id => !id || finished.has(id)); i++) { if (i > 100) throw new Error('the held answer never arrived'); await sleep(50); }
      await sleep(150); // (and what the page does with it has run)
    },
    async stop() { page.off(on); await page.send('Fetch.disable').catch(() => {}); },
  };
}

// The left edge of the first character of `needle` in an element's text, as laid out (bidi reordering included).
const X_OF = `window.__xOf = (root, needle) => {
  const at = root.textContent.indexOf(needle);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let pos = 0, node; (node = walker.nextNode()); pos += node.data.length) {
    if (at < pos + node.data.length) { const r = document.createRange(); r.setStart(node, at - pos); r.setEnd(node, at - pos + 1); return r.getBoundingClientRect().left; }
  }
  return NaN;
}; true`;

// A page in the audience with a phone sharing two notifications; the panel open.
async function panelWithTwo(ctx) {
  const page = await ctx.signedIn();
  const meId = await page.evaluate('me.id');
  eq(await setShown(ctx.srv, meId, true), 204, 'shown on this browser');
  const phone = fakePhone(ctx);
  await phone.online();
  await phone.post('mom', { app: 'com.whatsapp', appName: 'WhatsApp', title: 'Mom', text: 'Dinner at 7?', lines: ['Mom: Dinner at 7?', 'Dad: 👍'], conversation: 'Family' });
  await phone.post('alex', { app: 'com.google.android.apps.messaging', appName: 'Messages', title: 'Alex', text: 'Running late, 10 min', actions: [{ id: 'a0', title: 'Reply', reply: true }, { id: 'a1', title: 'Mark as read' }, { id: 'a2', title: 'Call back' }] });
  await page.waitFor(`phone.shown && phone.notes.size === 2 && document.querySelector('#convList .phone-row .badge')?.textContent === '2'`, 8000, 'the Phone entry with 2');
  await page.evaluate(`document.querySelector('#convList .phone-row').click(); true`);
  await page.waitFor(`phone.open && document.querySelectorAll('.phone-note').length === 2`, 5000, 'the panel');
  return { page, phone, meId, mom: `${phone.id}/mom`, alex: `${phone.id}/alex` };
}

export default function register(test) {
  test('phone notifications: the Phone entry (under All devices) and the panel, grouped by app; reply, action, dismiss and Dismiss all reach the phone and show how it went', async ctx => {
    const { page, phone, mom, alex } = await panelWithTwo(ctx);
    eq(await page.evaluate(`[...document.querySelectorAll('#convList > li')].findIndex(li => li.querySelector('.phone-row'))`), 1, 'pinned under All devices');
    eq(await page.evaluate(`document.querySelector('#convList .phone-row .conv-name').textContent`), 'Pixel 9', 'the phone’s name');
    eq(await page.evaluate(`[...document.querySelectorAll('.phone-group .phone-app-name')].map(n => n.textContent)`), ['Messages', 'WhatsApp'], 'newest app first');
    eq(await page.evaluate(`[${note(mom)}.querySelector('.phone-title').textContent, ${note(mom)}.querySelector('.phone-lines').textContent]`), ['Mom', 'Mom: Dinner at 7?Dad: 👍'], 'title and lines');
    eq(await page.evaluate(`[...${note(alex)}.querySelectorAll('.phone-actions button')].map(b => b.textContent)`), ['Mark as read', 'Call back'], 'up to 3 actions (the reply one is the box)');
    // Reply.
    await page.evaluate(`(() => { const box = ${note(alex)}.querySelector('.phone-reply input'); box.value = 'On my way'; box.dispatchEvent(new Event('input')); ${note(alex)}.querySelector('.phone-reply').requestSubmit(); return true; })()`);
    await page.waitFor(`${statusOf(alex)} === 'Sent ✓' && ${note(alex)}.querySelector('.phone-reply input').value === ''`, 8000, 'Sent ✓, the box emptied');
    eq(phone.requests.map(r => [r.kind, r.keys, r.action, r.text]), [['reply', ['alex'], 'a0', 'On my way']], 'the phone got the reply');
    // An action.
    await page.evaluate(`${note(mom)}.querySelector('[data-action="a1"]').click(); true`);
    await page.waitFor(`${statusOf(mom)} === 'Sent ✓'`, 8000, 'action: Sent ✓');
    eq(phone.requests.at(-1).kind === 'action' && phone.requests.at(-1).action, 'a1', 'the phone got the action');
    // Dismiss one: the phone removes it, so it goes everywhere.
    await page.evaluate(`${note(mom)}.querySelector('.phone-dismiss').click(); true`);
    await page.waitFor(`!${note(mom)} && phone.notes.size === 1 && document.querySelector('#convList .phone-row .badge').textContent === '1'`, 8000, 'dismissed');
    // Dismiss all: one request with every key.
    for (const k of ['n1', 'n2', 'n3']) await phone.post(k, { title: `Note ${k}` });
    await page.waitFor(`phone.notes.size === 4`, 5000, 'four');
    const before = phone.requests.length;
    await page.evaluate(`document.querySelector('.phone-bar button').click(); true`);
    await page.waitFor(`phone.notes.size === 0 && document.querySelector('.phone-empty') !== null && document.querySelector('#convList .phone-row .badge').hidden`, 8000, 'all dismissed');
    eq(phone.requests.slice(before).map(r => [r.kind, [...r.keys].sort()]), [['dismiss', ['alex', 'n1', 'n2', 'n3']]], 'one bulk dismissal');
  }, { requires: FEATURE });

  test('phone notifications: the phone offline, a refusal from it, and no answer at all', async ctx => {
    const { page, phone, mom, alex } = await panelWithTwo(ctx);
    phone.offline();
    await ctx.sleep(300);
    await page.evaluate(`${note(mom)}.querySelector('[data-action="a1"]').click(); true`);
    await page.waitFor(`${statusOf(mom)} === 'Your phone is offline'`, 8000, '409: offline');
    await phone.online();
    phone.answer = 'fail:Open it on the phone';
    await page.evaluate(`${note(mom)}.querySelector('[data-action="a1"]').click(); true`);
    await page.waitFor(`${statusOf(mom)} === 'Couldn’t mark as read: Open it on the phone'`, 8000, 'the phone said no');
    phone.answer = 'silent';
    await page.evaluate(`(() => { const box = ${note(alex)}.querySelector('.phone-reply input'); box.value = 'Hello?'; ${note(alex)}.querySelector('.phone-reply').requestSubmit(); return true; })()`);
    await page.waitFor(`${statusOf(alex)} === 'Sending…'`, 3000, 'sending');
    await page.waitFor(`${statusOf(alex)} === 'No answer from the phone'`, 75000, 'timeout (the server gives up after 60 s)');
    eq(await page.evaluate(`${note(alex)}.querySelector('.phone-reply input').value`), 'Hello?', 'the reply is kept for another try');
  }, { requires: FEATURE, timeout: 120000 });

  test('phone notifications: the switches (This device, off by default in a browser; any device in Settings → Devices) take effect at once', async ctx => {
    const page = await ctx.signedIn();
    const meId = await page.evaluate('me.id');
    const phone = fakePhone(ctx);
    await phone.online();
    await phone.post('hello', { title: 'Hi there' });
    await ctx.sleep(500);
    eq(await page.evaluate(`[phone.shown, document.querySelector('#convList .phone-row') === null, phone.notes.size]`), [false, true, 0], 'off by default: nothing here');
    // This device: on.
    await page.evaluate(`openSettings('device'); true`);
    await page.waitFor(`[...document.querySelectorAll('#settingsDlg label.check')].some(l => /Show phone notifications here/.test(l.textContent))`, 5000, 'the switch');
    const box = `[...document.querySelectorAll('#settingsDlg label.check')].find(l => /Show phone notifications here/.test(l.textContent)).querySelector('input')`;
    eq(await page.evaluate(`${box}.checked`), false, 'off');
    await page.evaluate(`${box}.click(); true`);
    await page.waitFor(`phone.shown && phone.notes.size === 1 && document.querySelector('#convList .phone-row') !== null`, 8000, 'on: the Phone entry and its notification');
    eq(await (await fetch(`${ctx.srv.base}/api/devices`, { headers: { Authorization: `Bearer ${ctx.srv.key}` } })).json().then(r => r.devices.find(d => d.id === meId)?.settings?.phoneNotifications), true, 'a server setting');
    await page.evaluate(`$('#settingsDlg').close(); true`);
    // Settings → Devices: switched for another device.
    const laptopName = `Laptop ${ctx.uid()}`; // (the shared server knows other laptops from other tests)
    const other = dev(ctx, laptopName, 'windows');
    await other.me();
    await page.evaluate(`openSettings('devices'); true`);
    const devBox = `[...[...document.querySelectorAll('#set-devices .device-row')].find(r => r.textContent.includes('${laptopName}'))?.querySelectorAll('label.check') || []].find(l => /Show phone notifications/.test(l.textContent))?.querySelector('input')`;
    await page.waitFor(`Boolean(${devBox})`, 5000, 'the per-device switch');
    await page.evaluate(`${devBox}.click(); true`);
    for (let i = 0; i < 30; i++) {
      const on = await (await fetch(`${ctx.srv.base}/api/devices`, { headers: { Authorization: `Bearer ${ctx.srv.key}` } })).json().then(r => r.devices.find(d => d.id === other.id)?.settings?.phoneNotifications);
      if (on) break;
      await ctx.sleep(100);
    }
    eq(await (await fetch(`${ctx.srv.base}/api/devices`, { headers: { Authorization: `Bearer ${ctx.srv.key}` } })).json().then(r => r.devices.find(d => d.id === other.id)?.settings?.phoneNotifications), true, 'the laptop shows them now');
    await page.evaluate(`$('#settingsDlg').close(); true`);
    // Switched off for this browser from elsewhere: gone at once. The server's notification-removed { all } (no
    // device: everything) comes first and empties it on its own; the device list saying so follows. (A listener of
    // ours after the page's own one sees the state that event left.)
    await page.evaluate(`window.__afterAll = null; live.es.addEventListener('notification-removed', e => { const d = JSON.parse(e.data); if (d.all && !d.device) __afterAll = [phone.shown, phone.notes.size]; }); true`);
    eq(await setShown(ctx.srv, meId, false), 204, 'switched off elsewhere');
    await page.waitFor(`!phone.shown && phone.notes.size === 0 && document.querySelector('#convList .phone-row') === null`, 8000, 'gone');
    eq(await page.evaluate('__afterAll'), [true, 0], 'emptied by notification-removed { all } before the device list came');
  }, { requires: FEATURE });

  test('phone notifications: phone text is only ever text (HTML and script in every field), and each piece of it is bidi-isolated (an RLO can’t reorder what’s around it)', async ctx => {
    const page = await ctx.signedIn();
    const meId = await page.evaluate('me.id');
    eq(await setShown(ctx.srv, meId, true), 204, 'shown here');
    const phone = fakePhone(ctx);
    await phone.online();
    await page.evaluate(`window.__xss = 0; ${X_OF}`);
    const x = '<img src=x onerror=__xss++>'; // (action titles are 40 characters at most)
    const fields = { appName: `Evil${x}`, title: `T${x}<script>__xss++</script>`, text: x, lines: [`L${x}`, '<b>bold</b>'], conversation: `C${x}`,
      actions: [{ id: 'a0', title: `R${x}`, reply: true }, { id: 'a1', title: `A${x}` }] };
    await phone.post('xss', fields);
    await page.waitFor(`phone.notes.size === 1`, 8000, 'it came');
    await page.evaluate(`openPhone(); true`);
    await page.waitFor(`document.querySelectorAll('.phone-note').length === 1`, 5000, 'the panel');
    await ctx.sleep(500); // (an <img> that made it into the page would have failed to load by now)
    const xss = note(`${phone.id}/xss`);
    eq(await page.evaluate(`({
      xss: window.__xss,
      elements: document.querySelectorAll('#phonePanel img, #phonePanel script, #phonePanel b, .phone-row img, .phone-row script').length,
      app: document.querySelector('.phone-app-name').textContent,
      title: ${xss}.querySelector('.phone-title').textContent,
      conv: ${xss}.querySelector('.phone-conv').textContent,
      lines: [...${xss}.querySelectorAll('.phone-lines p')].map(p => p.textContent),
      actions: [...${xss}.querySelectorAll('.phone-actions button')].map(b => b.textContent),
      preview: document.querySelector('.phone-row .conv-preview').textContent,
    })`), { xss: 0, elements: 0, app: fields.appName, title: fields.title, conv: fields.conversation, lines: fields.lines, actions: [fields.actions[1].title], preview: `${fields.appName}: ${fields.title}` }, 'all of it shown as text');
    // Bidi: the server strips the controls now, so this one comes as an older server would pass it on (one event).
    phone.answer = 'fail:Not now';
    await phone.post('rlo', { appName: 'Evil', title: 'Hi you', actions: [{ id: 'a0', title: 'Reply', reply: true }, { id: 'a1', title: 'Archive' }] });
    const rlo = `${phone.id}/rlo`;
    await page.waitFor(`phone.notes.has('${rlo}')`, 8000, 'the second one');
    await page.evaluate(`onPhoneNotification({ ...phone.notes.get('${rlo}'), appName: 'Evil\\u202egpj.exe', lines: ['\\u202eabc', 'Next'],
      actions: [{ id: 'a0', title: 'Reply', reply: true }, { id: 'a1', title: '\\u202eArchive' }] }); true`);
    await page.waitFor(`document.querySelector('.phone-row .conv-preview').textContent === 'Evil\\u202egpj.exe: Hi you'`, 5000, 'the preview');
    eq(await page.evaluate(`(p => __xOf(p, ':') < __xOf(p, 'Hi'))(document.querySelector('.phone-row .conv-preview'))`), true, 'the preview: the RLO in the app’s name doesn’t flip “: Hi you”');
    await page.evaluate(`${note(rlo)}.querySelector('[data-action="a1"]').click(); true`);
    await page.waitFor(`${statusOf(rlo)} === 'Couldn’t \\u202earchive: Not now'`, 8000, 'the phone said no');
    eq(await page.evaluate(`(s => [__xOf(s, 'Couldn') < __xOf(s, ':'), __xOf(s, ':') < __xOf(s, 'Not now')])(${note(rlo)}.querySelector('.phone-status'))`), [true, true], 'the status: the action’s RLO doesn’t flip the phone’s answer');
    eq(await page.evaluate(`${note(rlo)}.querySelector('.phone-reply input').placeholder`), '\u2068Reply\u2069 to \u2068Hi you\u2069…', 'the reply box’s placeholder: FSI…PDI');
    const notIsolated = await page.evaluate(`[...document.querySelectorAll('.phone-row .conv-name, .phone-row .conv-preview, .phone-row bdi, #threadName, .phone-app-name, .phone-title, .phone-conv, .phone-lines p, .phone-actions button, .phone-status, .phone-status bdi')]
      .filter(e => getComputedStyle(e).unicodeBidi !== 'isolate').map(e => e.className || e.tagName)`);
    eq(notIsolated, [], 'every element showing phone text is isolated');
  }, { requires: FEATURE });

  test('phone notifications: a list answer that’s overtaken brings nothing back (removed or changed since it was computed, or the switch went off or the device signed out meanwhile)', async ctx => {
    const page = await ctx.signedIn();
    const meId = await page.evaluate('me.id');
    eq(await setShown(ctx.srv, meId, true), 204, 'shown here');
    const phone = fakePhone(ctx);
    await phone.online();
    const id = key => `${phone.id}/${key}`;
    const tag = ctx.uid(); // (in every title: the storage check looks for it)
    await phone.post('keep', { title: `Kept ${tag}` });
    await phone.post('gone', { title: `Removed ${tag}` });
    await phone.post('edit', { title: `Old ${tag}` });
    await page.waitFor(`phone.shown && phone.notes.size === 3 && phone.loading === null`, 8000, 'three, no list request on its way');
    const hold = await holdLists(page);
    ctx.defer(() => hold.stop());
    // Computed with all three; meanwhile one goes, one changes and a new one comes.
    await page.evaluate('(loadPhoneNotes(), true)');
    await hold.caught();
    await phone.remove('gone');
    await phone.post('edit', { title: `New ${tag}` });
    await phone.post('new', { title: `Brand new ${tag}` });
    await page.waitFor(`phone.notes.size === 3 && !phone.notes.has('${id('gone')}') && phone.notes.get('${id('edit')}')?.title === 'New ${tag}'`, 5000, 'the events');
    await hold.release();
    eq(await page.evaluate(`[[...phone.notes.keys()].sort(), phone.notes.get('${id('edit')}')?.title, document.querySelector('#convList .phone-row .badge').textContent]`),
      [[id('edit'), id('keep'), id('new')].sort(), `New ${tag}`, '3'], 'the removed one stays gone, the newer version stays');
    eq(await inStorage(page, new RegExp(tag)), false, 'none of it in storage');
    // On its way while the switch goes off (elsewhere): dropped when it comes.
    await page.evaluate('(loadPhoneNotes(), true)');
    await hold.caught();
    eq(await setShown(ctx.srv, meId, false), 204, 'switched off elsewhere');
    await page.waitFor(`!phone.shown && phone.notes.size === 0`, 8000, 'off: emptied');
    await hold.release();
    eq(await page.evaluate(`[phone.shown, phone.notes.size, document.querySelector('#convList .phone-row') === null]`), [false, 0, true], 'nothing came back');
    // On its way (the switch going on asks for the list) while this device is signed out: dropped too.
    eq(await setShown(ctx.srv, meId, true), 204, 'on again');
    await hold.caught();
    await page.waitFor('phone.shown', 5000, 'shown again');
    eq((await fetch(`${ctx.srv.base}/api/devices/${meId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ctx.srv.key}` } })).status, 204, 'revoked');
    await page.waitFor(`!paired && !phone.shown`, 15000, 'signed out');
    await hold.release();
    eq(await page.evaluate('phone.notes.size'), 0, 'nothing came back after the sign-out');
  }, { requires: FEATURE });

  test('phone notifications: memory only (nothing in IndexedDB, Cache Storage or web storage), and gone on sign-out', async ctx => {
    const { page, meId } = await panelWithTwo(ctx);
    eq(await inStorage(page, /Dinner|Running late|Mom|Alex/), false, 'no notification content anywhere in the browser’s storage');
    // Nor on the server's disk or in its log (the server keeps it in memory).
    const onDisk = [];
    const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/Dinner at 7|Running late/.test(fs.readFileSync(p).toString('latin1'))) onDisk.push(p); } };
    walk(ctx.srv.data);
    eq([onDisk, /Dinner at 7|Running late/.test(ctx.srv.log)], [[], false], 'nothing in the server’s data folder or log');
    // Signed out (revoked elsewhere): nothing of it stays in memory either.
    eq((await fetch(`${ctx.srv.base}/api/devices/${meId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ctx.srv.key}` } })).status, 204, 'revoked');
    await page.waitFor(`!paired && phone.notes.size === 0 && !phone.open && document.querySelectorAll('.phone-note').length === 0`, 15000, 'cleared on sign-out');
  }, { requires: FEATURE });

  test('phone notifications in the Windows app’s window: the app owns the switches (This PC: show them, message text in pop-ups), openPhoneNotification opens the panel with that one selected and its reply box focused, and the panel counts as viewing "phone"', async ctx => {
    const features = ['transfers', 'localFiles', 'settings', 'clipboard', 'pickFiles', 'pickFolder', 'dragOut', 'openPanel', 'phoneNotifications'];
    const { page, appId } = await hostPage(ctx, { features, settings: { phoneNotifications: false, phonePopupText: true } });
    await page.waitFor(`paired && net.state === 'online' && hostState.ready`, 10000, 'host mode');
    // This PC: the app's switch, changed through the bridge (the app does the PUT); This device has none here.
    await page.evaluate(`openSettings('device'); true`);
    await ctx.sleep(300);
    eq(await page.evaluate(`/Show phone notifications/.test($('#set-device').textContent)`), false, 'not under This device');
    await page.evaluate(`openSettings('pc'); true`);
    const pcLabel = re => `[...document.querySelectorAll('#set-pc label.check')].find(l => ${re}.test(l.textContent))`;
    const pcBox = `${pcLabel('/Show phone notifications on this PC/')}?.querySelector('input')`;
    await page.waitFor(`Boolean(${pcBox}) && !${pcBox}.checked`, 5000, 'This PC shows the app’s value');
    // "Show message text in pop-ups": this PC's own, right under it (it can be turned off before the notifications
    // go on), with the note that Windows keeps pop-ups.
    const textBox = `${pcLabel('/Show message text in pop-ups/')}?.querySelector('input')`;
    eq(await page.evaluate(`[${textBox}?.checked, /Notification Center until they’re cleared/.test(${pcLabel('/Show message text in pop-ups/')}?.textContent), ${pcLabel('/Show phone notifications on this PC/')}.nextElementSibling === ${pcLabel('/Show message text in pop-ups/')}]`),
      [true, true, true], 'Show message text in pop-ups: on, with its note, next to the switch');
    await page.evaluate(`${textBox}.click(); true`);
    await page.waitFor(`__host.log.some(m => m.type === 'setSettings' && m.settings?.phonePopupText === false && !('phoneNotifications' in m.settings)) && ${textBox}?.checked === false`, 5000, 'asked the app (that field only)');
    await page.evaluate(`${pcBox}.click(); true`);
    await page.waitFor(`__host.log.some(m => m.type === 'setSettings' && m.settings?.phoneNotifications === true)`, 5000, 'asked the app');
    await page.evaluate(`$('#settingsDlg').close(); true`);
    // The app did the PUT (here: the test does it for it).
    eq(await setShown(ctx.srv, appId, true), 204, 'shown on this PC');
    const phone = fakePhone(ctx);
    await phone.online();
    await phone.post('older', { title: 'Older one' });
    await phone.post('pick', { app: 'com.whatsapp', appName: 'WhatsApp', title: 'Mom', text: 'Call me' });
    await page.waitFor(`phone.shown && phone.notes.size === 2`, 8000, 'two notifications');
    await page.evaluate(`openConv('all'); __host.emit({ type: 'openPhoneNotification', id: '${phone.id}/pick' }); true`);
    await page.waitFor(`phone.open && ${note(`${phone.id}/pick`)}?.classList.contains('selected') && document.activeElement === ${note(`${phone.id}/pick`)}.querySelector('.phone-reply input')`, 5000, 'selected, its reply box focused');
    assert(await page.evaluate(`__host.log.some(m => m.type === 'viewing' && m.conversation === 'phone' && m.visible === true)`), 'viewing "phone" while the panel is open');
    // One that's gone: just the panel.
    await page.evaluate(`openConv('all'); __host.emit({ type: 'openPhoneNotification', id: '${phone.id}/gone' }); true`);
    await page.waitFor(`phone.open && !document.querySelector('.phone-note.selected')`, 5000, 'the panel, nothing selected');
    // The app on a server older than 1.5 (phoneNotifications null): neither switch.
    const older = await hostPage(ctx, { features, settings: { phoneNotifications: null, phonePopupText: true } });
    await older.page.waitFor(`paired && hostState.ready`, 10000, 'host mode (older server)');
    await older.page.evaluate(`openSettings('pc'); true`);
    await older.page.waitFor(`/Copy received text/.test($('#set-pc')?.textContent || '')`, 5000, 'This PC');
    eq(await older.page.evaluate(`/Show phone notifications|Show message text in pop-ups/.test($('#set-pc').textContent)`), false, 'neither switch');
  }, { requires: FEATURE });

  test('phone notifications: a hidden page keeps the count but renders nothing until it’s shown', async ctx => {
    const page = await ctx.signedIn();
    const meId = await page.evaluate('me.id');
    eq(await setShown(ctx.srv, meId, true), 204, 'shown here');
    const phone = fakePhone(ctx);
    await phone.online();
    await page.waitFor(`phone.shown && document.querySelector('#convList .phone-row') !== null`, 8000, 'the Phone entry');
    await ctx.setHidden(page, true);
    await page.evaluate(`window.__mut = 0; new MutationObserver(ms => { __mut += ms.length; }).observe($('#app'), { subtree: true, childList: true, characterData: true }); true`);
    await phone.post('h1', { title: 'While hidden 1' });
    await phone.post('h2', { title: 'While hidden 2' });
    await page.waitFor(`phone.notes.size === 2`, 8000, 'counted while hidden');
    await ctx.sleep(300);
    eq(await page.evaluate('__mut'), 0, 'nothing rendered while hidden');
    await ctx.setHidden(page, false);
    await page.waitFor(`document.querySelector('#convList .phone-row .badge').textContent === '2'`, 5000, 'shown: the count');
  }, { requires: FEATURE });
}
