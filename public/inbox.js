'use strict';
// (1.33) The alerts inbox (the user, 2026-11-10: "yeah lets do the alerts inbox"). The programs that sent their alerts
// to the phone their own way (ntfy, webhooks, Home Assistant) post them to Beam instead (server: /notify, the ntfy
// way, with each app's own key), and every device has them in one place: the sidebar's Alerts row, pinned under All
// devices, opens them in place of a conversation, newest first, a chip per app to narrow them. Beam's own alerts are
// there too. Settings → Alerts adds an app (its key is shown once), mutes or snoozes one, makes it a new key or
// removes it. Approved (trusted) sign-ins only. index.html#alerts: the list alone (the Android app's screen).

const alertsBox = {
  loaded: false,
  loading: null,
  error: '',
  senders: new Map(), // id -> { id, name, builtIn?, muted, snoozeUntil, lastAt, count, lastFrom }
  list: [],           // newest first
  read: 0,            // this device looked up to here
  seen: 0,            // ...as it was when the list opened (newer ones stand out while it's open)
  open: false,
  filter: '',         // a sender id, or '' for all
  page: false,        // #alerts: the list alone
  made: null,         // an app just added (or given a new key): its key and addresses, shown once
  pendingOpen: null,  // { sender }: asked to open before this page knew its sign-in is approved
};

const inboxFeature = () => serverHas('inbox') && me.trusted === true && !me.temporary;
const inboxOpen = () => alertsBox.open;
// (1.33) A panel in place of the thread: the phone's notifications or the alerts.
const panelOpen = () => phonePanelOpen() || inboxOpen();
const inboxSenderName = id => alertsBox.senders.get(id)?.name || (id === 'beam' ? 'Beam' : 'An app');
const inboxUnread = () => alertsBox.list.reduce((n, a) => n + (a.at > alertsBox.read ? 1 : 0), 0);
const alertHead = a => `${a.emojis ? `${a.emojis} ` : ''}${a.title || ''}`.trim();

function loadInbox() {
  if (!inboxFeature()) return null;
  alertsBox.loading ||= (async () => {
    try {
      const r = await apiJson('api/inbox');
      alertsBox.senders = new Map((r.senders || []).map(s => [s.id, s]));
      alertsBox.list = Array.isArray(r.alerts) ? r.alerts : [];
      alertsBox.read = Math.max(alertsBox.read, Number(r.read) || 0);
      alertsBox.loaded = true;
      alertsBox.error = '';
      if (alertsBox.open && inboxVisible()) markInboxRead();
    } catch (err) {
      alertsBox.error = friendlyError(err);
    }
    renderInboxAll();
  })().finally(() => { alertsBox.loading = null; });
  return alertsBox.loading;
}

// Everything that shows the alerts: the sidebar's row, the list when open, Settings → Alerts.
function renderInboxAll() {
  if (alertsBox.page) { renderInbox(); return; }
  renderSidebar();
  if (alertsBox.open) { renderInboxHeader(); renderInbox(); }
  if ($('#settingsDlg')?.open) renderSettings();
}

// `inbox { alert, notify, sender }`: one more (a pop-up when `notify`).
function onInboxEvent(d) {
  if (!d?.alert?.id) return;
  if (d.sender?.id) alertsBox.senders.set(d.sender.id, d.sender);
  if (alertsBox.loaded) alertsBox.list = [d.alert, ...alertsBox.list.filter(a => a.id !== d.alert.id)].slice(0, 500);
  else loadInbox();
  if (alertsBox.open && inboxVisible()) markInboxRead();
  renderInboxAll();
  if (d.notify) inboxNotify(d.alert);
}

function onInboxChanged() { if (inboxFeature()) loadInbox(); }

function onInboxRead(d) {
  if (!Number.isFinite(d?.at) || d.at <= alertsBox.read) return;
  alertsBox.read = d.at;
  renderInboxAll();
}

// While the list is on screen nothing pops up; otherwise a toast here, or a notification when this page is hidden
// (the Windows app's window leaves that to the app).
function inboxNotify(a) {
  const who = inboxSenderName(a.sender);
  const head = alertHead(a);
  if (!document.hidden) {
    if (alertsBox.open) return;
    toast(`${who}: ${head || a.text}`, { warn: a.priority >= 4, ms: 9000, action: 'Show', onAction: () => openInbox({ sender: a.sender }) });
  } else if (!HOST && 'Notification' in window && Notification.permission === 'granted') {
    showNotification(head ? `${who}: ${head}` : who, { body: a.text, icon: url('icon-192.png'), tag: `inbox-${a.id}`, data: { conv: 'all' } }, () => openInbox({ sender: a.sender }));
  }
}

const inboxVisible = () => alertsBox.page || (!document.hidden && !$('#app').hidden && (!NARROW.matches || $('#app').classList.contains('in-thread')));

// Looked at: up to the newest (this device's other windows hear it).
function markInboxRead() {
  const newest = alertsBox.list[0]?.at || 0;
  if (newest <= alertsBox.read) return;
  alertsBox.read = newest;
  patchInboxRow();
  updateTitle();
  api('api/inbox/read', jsonBody({ at: newest }, 'PUT')).catch(() => {});
}

// ---------------------------------------------------------------- opening it in place of a conversation

function openInbox({ sender = '' } = {}) {
  if (!paired || !inboxFeature()) {
    // (The Windows app's window can ask while it starts: before the app is on screen, whose first conversation would
    // close it again, or before this page knows its sign-in is approved. It opens once both are so: openPendingInbox.)
    if (!alertsBox.page) alertsBox.pendingOpen = { sender };
    return false;
  }
  alertsBox.pendingOpen = null;
  closeGallery();
  stopPicking();
  closePhone();
  if (!alertsBox.open && view.conv !== null) saveComposerDraft(view.conv);
  alertsBox.open = true;
  alertsBox.filter = sender && alertsBox.senders.has(sender) ? sender : '';
  alertsBox.seen = alertsBox.read;
  $('#app').classList.add('inbox-open');
  closeThreadSearch();
  if (NARROW.matches && !$('#app').classList.contains('in-thread')) {
    $('#app').classList.add('in-thread');
    history.pushState({ conv: 'alerts' }, '');
  }
  markInboxRead();
  renderHeader();
  renderSidebar();
  if (!alertsBox.loaded) loadInbox(); else renderInbox();
  hostViewing();
  return true;
}

// An open asked for while the app started (openInbox): now, if the app is on screen and this sign-in approved.
function openPendingInbox() {
  if (alertsBox.pendingOpen && paired && inboxFeature()) openInbox(alertsBox.pendingOpen);
}

// Signed out, or signed in to another Beam: none of it stays.
function forgetInbox() {
  closeInbox();
  Object.assign(alertsBox, { loaded: false, error: '', senders: new Map(), list: [], read: 0, seen: 0, made: null, pendingOpen: null });
  inboxRow?.li.remove();
  inboxRow = null;
}

function closeInbox({ render = false } = {}) {
  if (!alertsBox.open) return;
  alertsBox.open = false;
  alertsBox.filter = '';
  $('#app').classList.remove('inbox-open');
  $('#inboxPanel')?.replaceChildren();
  if (render) { renderAll(); hostViewing(); }
}

function renderInboxHeader() {
  const slot = $('#threadAvatar');
  if (!slot.classList.contains('alerts')) slot.replaceWith(Object.assign(el('span', { class: 'avatar alerts' }, icon('bell')), { id: 'threadAvatar' }));
  $('#threadName').textContent = 'Alerts';
  const apps = [...alertsBox.senders.values()].filter(s => !s.builtIn).length;
  $('#threadSub').textContent = apps ? `From Beam and ${plural(apps, 'app')}` : 'From Beam and the apps you add (Settings → Alerts)';
  $('#threadSub').title = '';
}

// ---------------------------------------------------------------- the list

function inboxRoot() { return alertsBox.page ? $('#inboxPage') : $('#inboxPanel'); }

function renderInbox() {
  const box = inboxRoot();
  if (!box || (!alertsBox.open && !alertsBox.page)) return;
  if (!alertsBox.page && renderingPaused()) { hiddenWork.all = true; return; }
  if (!alertsBox.loaded) {
    box.replaceChildren(el('p', { class: 'muted small inbox-empty-line' }, alertsBox.error || 'Loading…'));
    return;
  }
  const shown = alertsBox.filter ? alertsBox.list.filter(a => a.sender === alertsBox.filter) : alertsBox.list;
  const withAlerts = new Set(alertsBox.list.map(a => a.sender));
  const senders = [...alertsBox.senders.values()].filter(s => withAlerts.has(s.id) || !s.builtIn);
  const unreadOf = id => alertsBox.list.reduce((n, a) => n + (a.sender === id && a.at > alertsBox.seen ? 1 : 0), 0);
  const chip = (id, label, n) => el('button', { class: `chip${alertsBox.filter === id ? ' on' : ''}`, type: 'button', 'aria-pressed': String(alertsBox.filter === id),
    onclick: () => { alertsBox.filter = id; renderInbox(); } }, label, n ? el('span', { class: 'chip-dot', 'aria-label': `${n} new` }) : null);
  const bar = el('div', { class: 'inbox-bar' },
    el('div', { class: 'inbox-chips', role: 'group', 'aria-label': 'Which app' },
      chip('', 'All', 0), ...senders.map(s => chip(s.id, s.name, unreadOf(s.id)))),
    !alertsBox.page && smallBtn('Apps…', () => openSettings('alerts'), { kind: 'ghost', ic: 'gear', title: 'Add, mute or remove the apps that send alerts' }));
  const parts = [bar];
  const s = alertsBox.filter ? alertsBox.senders.get(alertsBox.filter) : null;
  if (s) parts.push(senderBar(s));
  if (!shown.length) {
    parts.push(el('div', { class: 'thread-empty inbox-empty' }, icon('bell', 'i big'),
      el('strong', {}, s ? `Nothing from ${s.name}` : 'No alerts yet'),
      el('span', { class: 'muted small' }, s ? 'Its alerts show up here as they come.'
        : alertsBox.page ? 'Beam’s own and your apps’ alerts show up here. Apps are added in Beam on a PC: Settings → Alerts.'
          : 'Beam’s own alerts show up here, and your other programs’ once you add them in Settings → Alerts: each gets an address to send to, the way they’d send to ntfy.')));
  } else {
    let day = '';
    for (const a of shown.slice(0, 300)) {
      const d = dayKey(a.at);
      if (d !== day) { parts.push(el('div', { class: 'day', role: 'separator' }, dayLabel(a.at))); day = d; }
      parts.push(alertCard(a));
    }
  }
  box.replaceChildren(...parts);
}

// The chosen app: muted or snoozed, and what can be done to it.
function senderBar(s) {
  const state = s.muted ? 'Muted: its alerts are listed, they don’t pop up'
    : s.snoozeUntil > Date.now() ? `Snoozed until ${shortWhen(s.snoozeUntil)}: its alerts are listed, they don’t pop up` : '';
  const more = el('button', { class: 'icon-btn', type: 'button', 'aria-label': `More for ${s.name}`, title: 'More' }, icon('more'));
  more.addEventListener('click', () => senderMenu(s, more));
  return el('div', { class: 'inbox-sender' }, el('span', { class: 'muted small' }, state || (s.builtIn ? 'Beam’s own alerts (they pop up as before)' : s.lastFrom ? `Last from ${s.lastFrom}` : '')), more);
}

function alertCard(a) {
  const isNew = a.at > alertsBox.seen;
  const del = el('button', { class: 'icon-btn inbox-del', type: 'button', 'aria-label': 'Delete this alert', title: 'Delete' }, icon('x'));
  del.addEventListener('click', () => deleteAlert(a));
  const head = alertHead(a);
  const buttons = [
    a.click && el('button', { class: 'btn small-btn', type: 'button', onclick: () => openLink(a.click) }, icon('open'), 'Open'),
    ...(a.actions || []).filter(x => x.url !== a.click || x.label !== 'Open').map(x => el('button', { class: 'btn small-btn ghost', type: 'button', onclick: () => openLink(x.url) }, x.label)),
    a.attach && el('button', { class: 'btn small-btn ghost', type: 'button', onclick: () => openLink(a.attach.url) }, icon('attach'), a.attach.name || 'Attachment'),
  ].filter(Boolean);
  return el('article', { class: `inbox-alert p${a.priority || 3}${isNew ? ' new' : ''}`, 'data-id': a.id },
    el('header', { class: 'inbox-alert-head' },
      el('span', { class: 'inbox-app', dir: 'auto' }, inboxSenderName(a.sender)),
      a.priority >= 4 && el('span', { class: `inbox-prio p${a.priority}` }, a.priority >= 5 ? 'Urgent' : 'High'),
      a.priority <= 2 && el('span', { class: 'inbox-prio quiet', title: 'It didn’t pop up (the app sent it as low priority)' }, 'Quiet'),
      el('time', { class: 'muted small inbox-time', datetime: new Date(a.at).toISOString(), title: new Date(a.at).toLocaleString() }, shortWhen(a.at)),
      del),
    head && el('strong', { class: 'inbox-title', dir: 'auto' }, head),
    el('p', { class: 'inbox-text', dir: 'auto' }, a.text),
    (a.tags?.length || a.from) && el('div', { class: 'inbox-meta muted small' }, ...(a.tags || []).map(t => el('span', { class: 'inbox-tag' }, t)), a.from && el('span', {}, `from ${a.from}`)),
    buttons.length > 0 && el('div', { class: 'inbox-actions' }, ...buttons));
}

async function deleteAlert(a) {
  alertsBox.list = alertsBox.list.filter(x => x.id !== a.id);
  renderInboxAll();
  try { await api(`api/inbox/alerts/${encodeURIComponent(a.id)}`, { method: 'DELETE' }); }
  catch (err) { if (err.status !== 404) { toast(friendlyError(err), { error: true }); loadInbox(); } }
}

// Mute, snooze, a new key, rename, remove (Beam's own: only clear).
function senderMenu(s, at) {
  const snooze = ms => patchSender(s, { snoozeUntil: Date.now() + ms }, 'Snoozed');
  const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d.getTime() - Date.now(); };
  openMenu([
    !s.builtIn && (s.muted ? { label: 'Unmute', icon: 'bell', action: () => patchSender(s, { muted: false }, 'Unmuted') } : { label: 'Mute', icon: 'bell-off', action: () => patchSender(s, { muted: true }, 'Muted') }),
    !s.builtIn && !s.muted && (s.snoozeUntil > Date.now() ? { label: 'Stop snoozing', icon: 'bell', action: () => patchSender(s, { snoozeUntil: 0 }, 'Not snoozed') }
      : [{ label: 'Snooze for an hour', icon: 'clock', action: () => snooze(3600e3) }, { label: 'Snooze for 8 hours', icon: 'clock', action: () => snooze(8 * 3600e3) },
        { label: 'Snooze until tomorrow 8:00', icon: 'clock', action: () => snooze(tomorrow()) }]),
    !s.builtIn && !alertsBox.page && { label: 'Rename', icon: 'edit', action: () => renameSender(s) },
    !s.builtIn && !alertsBox.page && { label: 'New key…', icon: 'refresh', action: () => newSenderKey(s) },
    'sep',
    { label: `Clear its alerts`, icon: 'trash', action: () => clearSender(s) },
    !s.builtIn && !alertsBox.page && { label: 'Remove the app…', icon: 'trash', danger: true, action: () => removeSender(s) },
  ].flat().filter(Boolean), at, { label: s.name });
}

async function patchSender(s, change, done) {
  try {
    const r = await apiJson(`api/inbox/senders/${encodeURIComponent(s.id)}`, jsonBody(change, 'PATCH'));
    if (r.sender) alertsBox.senders.set(r.sender.id, r.sender);
    renderInboxAll();
    if (done) toast(`${done}: ${s.name}`);
  } catch (err) { toast(friendlyError(err), { error: true }); }
}

async function clearSender(s) {
  if (!await confirmDialog({ title: `Clear ${s.name}’s alerts?`, text: 'They’re gone from every device.', confirm: 'Clear', danger: true })) return;
  try {
    await api(`api/inbox/alerts?sender=${encodeURIComponent(s.id)}`, { method: 'DELETE' });
    alertsBox.list = alertsBox.list.filter(a => a.sender !== s.id);
    renderInboxAll();
  } catch (err) { toast(friendlyError(err), { error: true }); }
}

// A name of its own, in Beam's own dialog (never window.prompt: it holds the event stream up, and the Windows app's
// window shows it as a foreign box).
function renameSender(s) {
  const input = el('input', { type: 'text', value: s.name, maxlength: '60', 'aria-label': 'The app’s name', autocomplete: 'off' });
  const save = el('button', { class: 'btn primary', type: 'submit', form: 'inboxRename' }, 'Rename');
  const cancel = el('button', { class: 'btn ghost', type: 'button', onclick: () => $('#genDlg').close() }, 'Cancel');
  const form = el('form', { id: 'inboxRename', class: 'field' }, input);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = input.value.trim();
    $('#genDlg').close();
    if (name && name !== s.name) await patchSender(s, { name }, 'Renamed');
  });
  openDialog({ title: `Rename ${s.name}`, body: [form], buttons: [cancel, save] });
  input.select();
}

async function newSenderKey(s) {
  if (!await confirmDialog({ title: `A new key for ${s.name}?`, text: 'Its old one stops working at once: put the new one into the app.', confirm: 'Make a new key' })) return;
  try {
    const r = await apiJson(`api/inbox/senders/${encodeURIComponent(s.id)}/key`, jsonBody({}));
    alertsBox.made = r;
    if (r.sender) alertsBox.senders.set(r.sender.id, r.sender);
    if (!$('#settingsDlg').open) openSettings('alerts'); else renderSettings();
  } catch (err) { toast(friendlyError(err), { error: true }); }
}

async function removeSender(s) {
  if (!await confirmDialog({ title: `Remove ${s.name}?`, text: 'Its key stops working, and its alerts go from every device.', confirm: 'Remove', danger: true })) return;
  try {
    await api(`api/inbox/senders/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
    alertsBox.senders.delete(s.id);
    alertsBox.list = alertsBox.list.filter(a => a.sender !== s.id);
    if (alertsBox.filter === s.id) alertsBox.filter = '';
    if (alertsBox.made?.sender?.id === s.id) alertsBox.made = null;
    renderInboxAll();
  } catch (err) { toast(friendlyError(err), { error: true }); }
}

// ---------------------------------------------------------------- the sidebar entry (pinned under All devices)

let inboxRow = null;

// Called by renderSidebar after the All devices row (and the phone's): the Alerts row, once there's anything to show.
function placeInboxRow(list, cursor) {
  if (!inboxFeature() || !alertsBox.loaded || (!alertsBox.list.length && alertsBox.senders.size < 2)) {
    if (inboxRow) { inboxRow.li.remove(); inboxRow = null; }
    return cursor;
  }
  if (!inboxRow) {
    const name = el('span', { class: 'conv-name' }, 'Alerts');
    const time = el('span', { class: 'conv-time' });
    const preview = el('span', { class: 'conv-preview' });
    const badge = el('span', { class: 'badge', hidden: true });
    const button = el('button', { class: 'conv inbox-row', type: 'button', 'data-conv': 'alerts' },
      el('span', { class: 'av-slot' }, el('span', { class: 'avatar alerts' }, icon('bell'))),
      el('span', { class: 'conv-body' }, el('span', { class: 'conv-top' }, name, time), el('span', { class: 'conv-bottom' }, preview, badge)));
    button.addEventListener('click', () => openInbox());
    inboxRow = { li: el('li', {}, button), button, time, preview, badge };
  }
  patchInboxRow();
  if (inboxRow.li === cursor) return cursor.nextElementSibling;
  list.insertBefore(inboxRow.li, cursor);
  return cursor;
}

function patchInboxRow() {
  const r = inboxRow;
  if (!r) return;
  const newest = alertsBox.list[0];
  const time = newest ? shortWhen(newest.at) : '';
  if (r.time.textContent !== time) r.time.textContent = time;
  const sub = newest ? `${inboxSenderName(newest.sender)}: ${alertHead(newest) || newest.text}`.replace(/\s+/g, ' ').slice(0, 120) : 'Beam’s and your apps’ alerts';
  if (r.preview.textContent !== sub) r.preview.textContent = sub;
  const count = inboxUnread();
  r.badge.hidden = count === 0;
  if (count) { r.badge.textContent = count > 99 ? '99+' : String(count); r.badge.setAttribute('aria-label', `${count} new alerts`); }
  r.button.classList.toggle('active', alertsBox.open);
  r.button.classList.toggle('unread', count > 0);
  if (alertsBox.open) r.button.setAttribute('aria-current', 'true'); else r.button.removeAttribute('aria-current');
}

// ---------------------------------------------------------------- Settings → Alerts: the apps that send them

function inboxSendersCard() {
  if (!serverHas('inbox')) return null;
  if (!me.trusted || me.temporary) return card('Your apps’ alerts', cardInfo('Only an approved device signed in for good sees and adds the apps that send alerts.'));
  if (!alertsBox.loaded) {
    loadInbox();
    return card('Your apps’ alerts', cardInfo(alertsBox.error || 'Loading…'));
  }
  const apps = [...alertsBox.senders.values()].filter(s => !s.builtIn).sort((a, b) => a.name.localeCompare(b.name));
  const rows = apps.map(s => {
    const more = el('button', { class: 'icon-btn', type: 'button', 'aria-label': `More for ${s.name}`, title: 'More' }, icon('more'));
    more.addEventListener('click', () => senderMenu(s, more));
    const facts = [s.lastAt ? `last alert ${timeAgo(s.lastAt)}` : 'no alerts yet', s.count ? plural(s.count, 'alert') : '', s.lastFrom ? `from ${s.lastFrom}` : '',
      s.muted ? 'muted' : s.snoozeUntil > Date.now() ? `snoozed until ${shortWhen(s.snoozeUntil)}` : ''].filter(Boolean).join(' · ');
    return el('li', { class: 'set-row inbox-app-row' }, el('span', { class: 'set-text' }, el('span', { dir: 'auto' }, s.name), el('small', { class: 'muted block' }, facts)), more);
  });
  const name = el('input', { type: 'text', placeholder: 'The app’s name (UniFi Stock Watcher, SHOPTrend…)', 'aria-label': 'The app’s name', maxlength: '60', autocomplete: 'off' });
  const add = el('button', { class: 'btn', type: 'submit' }, 'Add');
  const form = el('form', { class: 'set-row inbox-add' }, row(name, add));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!name.value.trim()) return name.focus();
    add.disabled = true;
    try {
      const r = await apiJson('api/inbox/senders', jsonBody({ name: name.value.trim() }));
      alertsBox.made = r;
      alertsBox.senders.set(r.sender.id, r.sender);
      renderSettings();
      requestAnimationFrame(() => $('.inbox-made')?.scrollIntoView({ block: 'nearest' }));
    } catch (err) { toast(friendlyError(err), { error: true }); add.disabled = false; }
  });
  return [
    card('Your apps’ alerts',
      cardInfo('Your other programs can send their alerts to Beam the way they’d send them to ntfy: each one you add here gets its own key, which can send alerts and nothing else. They show up under Alerts on every device; 1–2 (low priority) are only listed, 3 and up pop up.'),
      alertsBox.made && madePanel(alertsBox.made),
      apps.length ? el('ul', { class: 'set-list inbox-apps' }, ...rows) : null,
      form),
  ];
}

// An app's key and where to send: shown once (the server keeps only its hash).
function madePanel(m) {
  const copyRow = (label, value, hint) => el('div', { class: 'set-row set-stack inbox-made-row' }, el('span', { class: 'set-label' }, label),
    row(el('code', { class: 'address inbox-made-value' }, value), smallBtn('Copy', () => copyText(value, `${label} copied`), { ic: 'copy' })), hint && el('small', { class: 'muted' }, hint));
  const close = smallBtn('Done', () => { alertsBox.made = null; renderSettings(); }, { kind: 'ghost' });
  const where = m.url || m.localUrl;
  return el('div', { class: 'inbox-made', role: 'region', 'aria-label': `${m.sender.name}’s key` },
    el('p', { class: 'set-row' }, el('strong', {}, `${m.sender.name}’s key: copy it now.`), ' Beam shows it only this once (New key makes another).'),
    m.server && copyRow('ntfy server', m.server, 'In an app that sends to ntfy: its server (SHOPTrend: alerts.ntfy_server)…'),
    copyRow('Topic', m.topic, m.server ? '…and this as its topic.' : 'The app’s topic in ntfy’s terms: its key.'),
    where && copyRow('Topic address / webhook', where, 'Where an app takes a whole address: Stock Watcher’s topic address, a webhook, Home Assistant’s rest_command.'),
    m.localUrl && m.url && copyRow('On this PC', m.localUrl, 'For a program on the Beam server’s own PC (no Tailscale needed).'),
    copyRow('Try it', `curl -H "Title: Hello" -d "It works" ${where}`, 'In a terminal: an alert from it shows up under Alerts.'),
    buttonRow(close));
}

// ---------------------------------------------------------------- the page of its own (#alerts)

async function startAlertsPage() {
  document.documentElement.classList.add('files-mode', 'alerts-mode');
  alertsBox.page = true;
  const stored = store.get('beam.deviceId');
  me.id = DEVICE_ID.test(stored || '') ? stored : randomId(12);
  me.name = cleanName(store.get('beam.device')) || defaultName();
  onUnauthorized = () => alertsPageSays('This page isn’t signed in any more: close it and open Alerts again.');
  onMoved = () => alertsPageSays('Beam has moved to another address: close this and open it again from the app.');
  adoptIdentity = you => { if (DEVICE_ID.test(you || '')) me.id = you; return false; };
  bindDialogs();
  window.addEventListener('hashchange', () => location.reload());
  try {
    const [info, mine, settings] = await Promise.all([apiJson('api/info'), apiJson('api/me'), apiJson('api/settings').catch(() => null)]);
    server.features = new Set(info.features || []);
    server.api = info.api || 2;
    if (DEVICE_ID.test(mine.you || '')) me.id = mine.you;
    me.trusted = mine.auth?.trusted === true;
    me.temporary = Boolean(mine.auth?.session || mine.temporary);
    if (typeof applyLook === 'function') applyLook(mine.settings?.appearance || settings?.appearance || null);
  } catch (err) {
    if (err.status !== 401) alertsPageSays(friendlyError(err));
    return;
  }
  if (!serverHas('inbox')) return alertsPageSays('This Beam has no Alerts yet (that needs Beam 1.33).');
  if (!inboxFeature()) return alertsPageSays('Only an approved device sees the alerts: approve this one in Beam on a PC (Settings → Devices).');
  const close = el('button', { class: 'btn primary', type: 'button', onclick: () => $('#genDlg').close() }, 'Close');
  openDialog({ title: 'Alerts', className: 'inbox-dlg', body: [el('div', { id: 'inboxPage', class: 'inbox-list-page' })], buttons: [close],
    onClose: how => { if (how !== 'replaced') location.replace(BASE.pathname); } });
  alertsBox.open = true;
  await loadInbox();
  alertsBox.seen = alertsBox.read;
  markInboxRead();
  renderInbox();
  // The list keeps up while it's open (a stream of its own, as the chat app's).
  const es = new EventSource('api/events?mode=foreground');
  es.addEventListener('inbox', e => { try { onInboxEvent(JSON.parse(e.data)); } catch {} });
  es.addEventListener('inbox-changed', () => loadInbox());
  es.addEventListener('inbox-read', e => { try { onInboxRead(JSON.parse(e.data)); } catch {} });
}

function alertsPageSays(text) {
  const close = el('button', { class: 'btn primary', type: 'button', onclick: () => $('#genDlg').close() }, 'Close');
  openDialog({ title: 'Alerts', body: [el('p', {}, text)], buttons: [close], onClose: how => { if (how !== 'replaced') location.replace(BASE.pathname); } });
}

// Back (the Android app's back button): one app's alerts back to all of them; else false (the app closes the screen).
function alertsBack() {
  if (alertsBox.page && alertsBox.filter) { alertsBox.filter = ''; renderInbox(); return true; }
  return false;
}
