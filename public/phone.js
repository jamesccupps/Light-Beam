'use strict';
// Phone notifications (Beam 1.5, feature `phone-notifications`). A phone shares the notifications of the apps picked
// there; devices set to "Show phone notifications" get them (event `notification`) and can reply, run one of their
// actions or dismiss them. The phone carries that out and says how it went (`notification-request-done`).
// Their content stays in memory: never IndexedDB or any other storage, never a log, and gone on sign-out.

const phone = {
  notes: new Map(),     // id ("<phone id>/<key>") -> notification, as the server sends it
  requests: new Map(),  // the server's request id -> request (until the phone answers)
  latest: new Map(),    // notification id -> its latest request: { ids, kind, state: sending|sent|failed, error }
  early: new Map(),     // the phone's answer to a request whose own reply hasn't come back yet
  drafts: new Map(),    // notification id -> the reply being typed
  open: false,          // the panel is on screen instead of a conversation
  selected: '',         // the notification to bring into view (a click on the Windows app's balloon)
  shown: false,         // this device shows phone notifications (as of the latest device list)
  pendingOpen: null,    // a notification the Windows app asked for before the list said it's shown here
  loading: null,        // the list request on its way
  since: null,          // …and the changes since it was sent (made again over its answer, which predates them)
  gen: 0,               // +1 on every clear: an answer to a request sent before it is dropped
  nodes: new Map(),     // "g:<app>" groups and "n:<id>" notifications on the panel
};

const phoneFeature = () => serverHas('phone-notifications');
const phoneShownHere = () => phoneFeature() && Boolean(deviceById(me.id)?.settings?.phoneNotifications);
const phonePanelOpen = () => phone.open;
const PHONE_BULK_MAX = 100;

// Phone text (app names, titles, lines, action titles, the phone's own error messages) may carry bidi controls, an RLO
// say (the server strips them; an older one didn't): every piece is isolated, so it can't reorder what's around it.
// An element holding only phone text gets dir="auto" (and unicode-bidi: isolate, style.css); a line of ours with
// pieces of it in it (the sidebar preview, a status) has each piece as a <bdi>; a placeholder wraps it in FSI…PDI.
const fromPhone = text => ({ text: String(text ?? '') });
const isolated = text => `\u2068${text}\u2069`;
const mixedSigs = new WeakMap();
function setMixed(node, parts) { // parts: strings of ours and fromPhone(…) pieces; rebuilt only when they change
  const sig = JSON.stringify(parts);
  if (mixedSigs.get(node) === sig) return;
  mixedSigs.set(node, sig);
  node.replaceChildren(...parts.map(p => typeof p === 'string' ? p : el('bdi', {}, p.text)));
}

// ---------------------------------------------------------------- what's shown here

// The device list (or the server's features) changed: this device may have been added to the audience or left it.
function phoneAudienceChanged() {
  const shown = phoneShownHere();
  if (shown === phone.shown) return;
  phone.shown = shown;
  if (shown) {
    const open = phone.pendingOpen;
    phone.pendingOpen = null;
    const loading = loadPhoneNotes();
    if (open !== null && paired) loading?.then(() => openPhone({ select: open, focus: true }));
  }
  else {
    if (phone.open) closePhone({ render: true });
    clearPhone();
  }
  renderSidebar();
}

// The current list (after a sign-in, a catch-up or the switch going on): one request, only while it's shown here.
// The server computed the answer when the request came in: what the events said since (a removal, a newer version)
// is made again over it, and it's dropped if everything was cleared meanwhile (sign-out, another Beam, switch off).
function loadPhoneNotes() {
  if (!phone.shown) return null;
  if (phone.loading) return phone.loading;
  const gen = phone.gen;
  const since = phone.since = [];
  const loading = phone.loading = (async () => {
    try {
      const r = await apiJson('api/phone/notifications');
      if (gen !== phone.gen || !phone.shown) return;
      const notes = new Map((r.notifications || []).filter(n => n && n.id).map(n => [n.id, n]));
      for (const change of since) change(notes);
      phone.notes = notes;
    } catch (err) {
      if (err.status === 403 && gen === phone.gen) phone.notes.clear(); // not shown here after all (the list will say so too)
    }
  })().finally(() => {
    if (phone.loading === loading) { phone.loading = null; phone.since = null; }
    renderPhone();
  });
  return loading;
}

// Sign-out, another Beam, the switch going off: nothing of it stays, nor comes back with an answer on its way.
function clearPhone() {
  phone.gen++;
  phone.loading = null;
  phone.since = null;
  phone.notes.clear();
  phone.requests.clear();
  phone.latest.clear();
  phone.early.clear();
  phone.drafts.clear();
  phone.selected = '';
  clearPhoneRendered();
}

function clearPhoneRendered() {
  for (const node of phone.nodes.values()) node.remove();
  phone.nodes.clear();
  $('#phonePanel')?.replaceChildren();
  phoneRow?.li.remove();
  phoneRow = null;
}

// ---------------------------------------------------------------- events (urgent: they arrive in background mode too)

function onPhoneNotification(n) {
  if (!n || !n.id || !phone.shown) return;
  phone.notes.set(n.id, n);
  phone.since?.push(notes => notes.set(n.id, n)); // (a list answer on its way may have an older version)
  renderPhone();
}

// One notification, all of one phone's (its switch went off), or with no device: everything shown here (this
// device's switch was turned off elsewhere; the device list saying so follows).
function onPhoneNotificationRemoved(d) {
  if (!d) return;
  if (d.all) {
    const gone = n => !d.device || n.device === d.device;
    for (const [id, n] of phone.notes) if (gone(n)) forgetNote(id);
    phone.since?.push(notes => { for (const [id, n] of notes) if (gone(n)) notes.delete(id); }); // (ones only the answer has)
  }
  else if (d.id) forgetNote(d.id);
  renderPhone();
}

// Gone from the phone: from here, and from a list answer on its way (it predates that).
function forgetNote(id) {
  phone.notes.delete(id);
  phone.latest.delete(id);
  phone.drafts.delete(id);
  phone.since?.push(notes => notes.delete(id));
}

function onPhoneRequestDone(d) {
  if (!d || !d.request) return;
  const req = phone.requests.get(d.request);
  if (req) settleRequest(req, d);
  else {
    // The 202 for it is still on its way (or another tab of this device asked: kept briefly, a few at most).
    phone.early.set(d.request, d);
    if (phone.early.size > 50) phone.early.delete(phone.early.keys().next().value);
  }
}

// ---------------------------------------------------------------- reply, action, dismiss

// The server hands it to the phone (202 { request }); the phone's answer comes later as an event, or after 60 s the
// server's "timeout". 409: the phone isn't connected; 404: it's gone from the phone; 403: not shown here.
async function phoneRequest(kind, ids, { body, title = '', text = '' } = {}) {
  ids = ids.filter(id => phone.notes.has(id));
  if (!ids.length) return;
  const req = { ids, kind, title, text, state: 'sending', error: '' };
  for (const id of ids) phone.latest.set(id, req);
  renderPhone();
  const bulk = kind === 'dismiss' && ids.length > 1;
  try {
    const r = await apiJson(bulk ? 'api/phone/notifications/dismiss' : `api/phone/notifications/${encodeURIComponent(ids[0])}/${kind}`, jsonBody(bulk ? { ids } : body || {}));
    req.request = r.request;
    phone.requests.set(r.request, req);
    const early = phone.early.get(r.request);
    if (early) { phone.early.delete(r.request); settleRequest(req, early); }
  } catch (err) {
    if (err.status === 401) return; // signed out: the sign-in page takes over
    req.state = 'failed';
    req.error = [err.status === 409 ? 'Your phone is offline' : err.status === 404 ? 'It’s gone from the phone'
      : err.status === 403 ? 'Phone notifications are off for this device' : friendlyError(err)];
    if (err.status === 404) for (const id of ids) forgetNote(id);
    renderPhone();
  }
}

function settleRequest(req, d) {
  phone.requests.delete(req.request);
  if (d.ok) {
    req.state = 'sent';
    if (req.kind === 'reply') for (const id of req.ids) phone.drafts.delete(id);
    // "Sent ✓" for a moment (a dismissed one goes as soon as the phone has removed it).
    setTimeout(() => { for (const id of req.ids) if (phone.latest.get(id) === req) phone.latest.delete(id); renderPhone(); }, 4000);
  } else {
    req.state = 'failed';
    // (The action's title and the phone's own words are phone text: isolated pieces of the line, see setMixed.)
    const why = fromPhone(d.error || 'the phone couldn’t do it');
    req.error = d.error === 'timeout' ? ['No answer from the phone']
      : req.kind === 'reply' ? ['Couldn’t reply: ', why]
        : req.kind === 'action' ? ['Couldn’t ', fromPhone((req.title || 'do that').toLowerCase()), ': ', why] : ['Couldn’t dismiss it: ', why];
  }
  renderPhone();
}

function replyAction(n) { return (n.actions || []).find(a => a && a.reply); }

function sendPhoneReply(n, input) {
  const text = input.value.trim();
  const action = replyAction(n);
  if (!text || !action || phone.latest.get(n.id)?.state === 'sending') return;
  phone.drafts.set(n.id, input.value);
  phoneRequest('reply', [n.id], { body: { action: action.id, text }, text });
}

// One request per phone (each goes to that phone), at most 100 ids each.
async function dismissAllPhone() {
  const byPhone = new Map();
  for (const n of phone.notes.values()) byPhone.set(n.device, [...(byPhone.get(n.device) || []), n.id]);
  for (const ids of byPhone.values()) for (let i = 0; i < ids.length; i += PHONE_BULK_MAX) await phoneRequest('dismiss', ids.slice(i, i + PHONE_BULK_MAX));
}

// ---------------------------------------------------------------- the panel (instead of the thread)

function openPhone({ select = '', focus = false } = {}) {
  if (!phone.shown) return false;
  if (!phone.open && view.conv !== null) saveComposerDraft(view.conv);
  phone.open = true;
  phone.selected = select || '';
  $('#app').classList.add('phone-open');
  closeThreadSearch();
  if (NARROW.matches && !$('#app').classList.contains('in-thread')) {
    $('#app').classList.add('in-thread');
    history.pushState({ conv: 'phone' }, '');
  }
  renderHeader();
  renderSidebar();
  renderPhone();
  if (!phone.notes.size || (phone.selected && !phone.notes.has(phone.selected))) loadPhoneNotes()?.then(() => focusSelectedNote(focus));
  else focusSelectedNote(focus);
  hostViewing();
  return true;
}

function closePhone({ render = false } = {}) {
  if (!phone.open) return;
  phone.open = false;
  phone.selected = '';
  $('#app').classList.remove('phone-open');
  if (render) { renderAll(); hostViewing(); }
}

// The Windows app's balloon was clicked: bring it into view, its reply box focused (one without a reply action is
// just selected; one that's gone meanwhile leaves the panel as it is).
function focusSelectedNote(focus) {
  if (!phone.open || !phone.selected || renderingPaused()) return;
  const node = phone.nodes.get(`n:${phone.selected}`);
  if (!node) return;
  node.scrollIntoView({ block: 'nearest' });
  node.classList.remove('flash');
  void node.offsetWidth;
  node.classList.add('flash');
  if (focus) node.querySelector('.phone-reply:not([hidden]) input')?.focus({ preventScroll: true });
}

function phoneName() {
  let newest = null;
  for (const n of phone.notes.values()) if (!newest || (n.at || 0) > (newest.at || 0)) newest = n;
  if (!newest) return 'Phone';
  return newest.deviceName || deviceById(newest.device)?.name || 'Phone';
}

function renderPhoneHeader() {
  const slot = $('#threadAvatar');
  if (!slot.classList.contains('phone')) slot.replaceWith(Object.assign(el('span', { class: 'avatar phone' }, icon('phone')), { id: 'threadAvatar' }));
  $('#threadName').textContent = phoneName();
  const count = phone.notes.size;
  $('#threadSub').textContent = count ? `${plural(count, 'notification')} from your phone` : 'Notifications from your phone';
  $('#threadSub').title = '';
}

// Newest first, grouped by app; every node is kept and patched (a reply being typed survives everything).
function renderPhone() {
  if (renderingPaused()) { hiddenWork.all = true; return; }
  if (phoneRow) patchPhoneRow();
  if (!phone.open) return;
  renderPhoneHeader();
  const box = $('#phonePanel');
  const groups = new Map();
  const sorted = [...phone.notes.values()].sort((a, b) => (b.when || b.at || 0) - (a.when || a.at || 0));
  for (const n of sorted) {
    const key = n.app || n.appName || '?';
    if (!groups.has(key)) groups.set(key, { key, appName: n.appName || n.app || 'App', icon: n.icon, notes: [] });
    groups.get(key).notes.push(n);
  }
  let bar = phone.nodes.get('bar');
  if (!bar) {
    bar = el('div', { class: 'phone-bar' },
      el('span', { class: 'muted small phone-count' }),
      el('button', { class: 'btn small-btn ghost', type: 'button', onclick: dismissAllPhone }, 'Dismiss all'));
    phone.nodes.set('bar', bar);
  }
  bar.querySelector('.phone-count').textContent = sorted.length ? plural(sorted.length, 'notification') : '';
  bar.querySelector('button').hidden = sorted.length < 2;
  const desired = [bar];
  for (const g of groups.values()) desired.push(phoneGroup(g));
  if (!sorted.length) {
    let empty = phone.nodes.get('empty');
    if (!empty) {
      empty = el('div', { class: 'thread-empty phone-empty' }, icon('bell', 'i big'),
        el('strong', {}, 'No notifications from your phone'),
        el('span', { class: 'muted small' }, 'They show up here from the apps picked on the phone (Beam on the phone: Settings → Notifications on your PCs).'));
      phone.nodes.set('empty', empty);
    }
    desired.push(empty);
  }
  placeChildren(box, desired);
  const keep = new Set(desired);
  for (const g of groups.values()) for (const n of g.notes) keep.add(phone.nodes.get(`n:${n.id}`));
  for (const [key, node] of phone.nodes) if (!keep.has(node) && key !== 'bar' && key !== 'empty') { node.remove(); phone.nodes.delete(key); }
}

// Children in this order, moving only what's out of place (focus and typing survive).
function placeChildren(parent, nodes) {
  let cursor = parent.firstElementChild;
  for (const node of nodes) {
    if (node === cursor) { cursor = cursor.nextElementSibling; continue; }
    parent.insertBefore(node, cursor);
  }
  while (cursor) { const next = cursor.nextElementSibling; cursor.remove(); cursor = next; }
}

function phoneGroup(g) {
  let node = phone.nodes.get(`g:${g.key}`);
  if (!node) {
    node = el('section', { class: 'phone-group', 'data-app': g.key },
      el('header', { class: 'phone-app' }, el('span', { class: 'phone-app-icon' }), el('strong', { class: 'phone-app-name', dir: 'auto' }), el('span', { class: 'muted small phone-app-count' })),
      el('div', { class: 'phone-notes' }));
    phone.nodes.set(`g:${g.key}`, node);
  }
  const iconSlot = node.querySelector('.phone-app-icon');
  if (iconSlot.dataset.icon !== (g.icon || '')) {
    iconSlot.dataset.icon = g.icon || '';
    iconSlot.replaceChildren(appIcon(g.icon));
  }
  node.querySelector('.phone-app-name').textContent = g.appName;
  node.querySelector('.phone-app-count').textContent = g.notes.length > 1 ? String(g.notes.length) : '';
  placeChildren(node.querySelector('.phone-notes'), g.notes.map(phoneNote));
  return node;
}

// The app's icon (the phone uploads it once; the browser keeps it), or a bell when there's none or it won't load.
function appIcon(hash) {
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return icon('bell');
  const img = el('img', { src: url(`api/phone/icons/${hash}`), alt: '', width: '20', height: '20', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(icon('bell')), { once: true });
  return img;
}

function phoneNote(n) {
  const key = `n:${n.id}`;
  let node = phone.nodes.get(key);
  if (!node) {
    const input = el('input', { type: 'text', maxlength: '4096', autocomplete: 'off', 'aria-label': 'Reply' });
    const form = el('form', { class: 'phone-reply' }, input, el('button', { class: 'btn small-btn primary', type: 'submit' }, icon('send'), 'Send'));
    form.addEventListener('submit', e => { e.preventDefault(); const cur = phone.notes.get(n.id); if (cur) sendPhoneReply(cur, input); });
    input.addEventListener('input', () => { if (input.value) phone.drafts.set(n.id, input.value); else phone.drafts.delete(n.id); });
    node = el('article', { class: 'phone-note', 'data-id': n.id },
      el('div', { class: 'phone-note-head' },
        el('strong', { class: 'phone-title', dir: 'auto' }), el('span', { class: 'muted small phone-conv', dir: 'auto' }), el('time', { class: 'muted small phone-time' }),
        mini('x', 'Dismiss', () => phoneRequest('dismiss', [n.id]), { class: 'mini phone-dismiss' })),
      el('div', { class: 'phone-lines' }),
      el('div', { class: 'phone-actions' }),
      form,
      el('p', { class: 'phone-status small', role: 'status' }));
    phone.nodes.set(key, node);
  }
  patchPhoneNote(node, n);
  return node;
}

function patchPhoneNote(node, n) {
  const req = phone.latest.get(n.id);
  const busy = req?.state === 'sending';
  node.querySelector('.phone-title').textContent = n.title || n.appName || 'Notification';
  const conv = n.conversation && n.conversation !== n.title ? n.conversation : '';
  node.querySelector('.phone-conv').textContent = conv;
  const when = n.when || n.at || Date.now();
  const time = node.querySelector('.phone-time');
  time.textContent = shortWhen(when);
  time.title = fullWhen(when);
  const lines = Array.isArray(n.lines) && n.lines.length ? n.lines : n.text ? [n.text] : [];
  const linesBox = node.querySelector('.phone-lines');
  const sig = JSON.stringify(lines);
  if (linesBox.dataset.sig !== sig) { linesBox.dataset.sig = sig; linesBox.replaceChildren(...lines.map(l => el('p', { dir: 'auto' }, String(l)))); }
  const actions = (n.actions || []).filter(a => a && !a.reply).slice(0, 3);
  const actBox = node.querySelector('.phone-actions');
  const actSig = JSON.stringify(actions.map(a => [a.id, a.title]));
  if (actBox.dataset.sig !== actSig) {
    actBox.dataset.sig = actSig;
    actBox.replaceChildren(...actions.map(a => el('button', { class: 'btn small-btn', type: 'button', dir: 'auto', 'data-action': a.id,
      onclick: () => phoneRequest('action', [n.id], { body: { action: a.id }, title: a.title }) }, a.title)));
  }
  for (const b of actBox.children) b.disabled = busy;
  node.querySelector('.phone-dismiss').disabled = busy;
  const form = node.querySelector('.phone-reply');
  const reply = replyAction(n);
  form.hidden = !reply;
  const input = form.querySelector('input');
  input.placeholder = reply ? `${isolated(reply.title || 'Reply')} to ${isolated(n.title || n.appName || 'it')}…` : '';
  // Sent: the box empties (unless something new was typed meanwhile); otherwise it shows what was being typed.
  const draft = phone.drafts.get(n.id);
  if (req?.state === 'sent' && req.kind === 'reply' && input.value.trim() === req.text) input.value = '';
  else if (draft !== undefined && document.activeElement !== input && input.value !== draft) input.value = draft;
  form.querySelector('button').disabled = busy;
  const status = node.querySelector('.phone-status');
  setMixed(status, !req ? [] : req.state === 'sending' ? ['Sending…'] : req.state === 'sent' ? ['Sent ✓'] : req.error);
  status.classList.toggle('err', req?.state === 'failed');
  node.classList.toggle('selected', phone.selected === n.id);
}

// ---------------------------------------------------------------- the sidebar entry (pinned under All devices)

let phoneRow = null;

// Called by renderSidebar right after the All devices row: puts the Phone row there (or takes it away).
function placePhoneRow(list, cursor) {
  if (!phone.shown) {
    if (phoneRow) { phoneRow.li.remove(); phoneRow = null; }
    return cursor;
  }
  if (!phoneRow) {
    const name = el('span', { class: 'conv-name' });
    const time = el('span', { class: 'conv-time' });
    const preview = el('span', { class: 'conv-preview' });
    const badge = el('span', { class: 'badge', hidden: true });
    const button = el('button', { class: 'conv phone-row', type: 'button', 'data-conv': 'phone' },
      el('span', { class: 'av-slot' }, el('span', { class: 'avatar phone' }, icon('phone'))),
      el('span', { class: 'conv-body' }, el('span', { class: 'conv-top' }, name, time), el('span', { class: 'conv-bottom' }, preview, badge)));
    button.addEventListener('click', () => openPhone());
    phoneRow = { li: el('li', {}, button), button, name, time, preview, badge };
  }
  patchPhoneRow();
  if (phoneRow.li === cursor) return cursor.nextElementSibling;
  list.insertBefore(phoneRow.li, cursor);
  return cursor;
}

function patchPhoneRow() {
  const r = phoneRow;
  let newest = null;
  for (const n of phone.notes.values()) if (!newest || (n.when || n.at || 0) > (newest.when || newest.at || 0)) newest = n;
  const name = phoneName();
  if (r.name.textContent !== name) r.name.textContent = name;
  const time = newest ? shortWhen(newest.when || newest.at) : '';
  if (r.time.textContent !== time) r.time.textContent = time;
  const app = fromPhone(newest?.appName || newest?.app || 'App');
  setMixed(r.preview, !newest ? ['Notifications from your phone'] : newest.title ? [app, ': ', fromPhone(newest.title)] : [app]);
  const count = phone.notes.size;
  r.badge.hidden = count === 0;
  if (count) { r.badge.textContent = count > 99 ? '99+' : String(count); r.badge.setAttribute('aria-label', `${count} phone notifications`); }
  r.button.classList.toggle('active', phone.open);
  if (phone.open) r.button.setAttribute('aria-current', 'true'); else r.button.removeAttribute('aria-current');
}

// ---------------------------------------------------------------- the switch ("Show phone notifications")

// A per-device server setting; any signed-in device can set it for any device. The Windows app owns its own PC's
// (its tray, and Settings → This PC through the bridge); everything else goes straight to the server.
function phoneShownFor(d) { return Boolean(d?.settings?.phoneNotifications); }

async function setPhoneShown(id, on, input) {
  try {
    await api(`api/devices/${id === me.id ? 'me' : encodeURIComponent(id)}/settings`, jsonBody({ phoneNotifications: on }, 'PUT'));
    const d = deviceById(id);
    if (d) d.settings = { ...(d.settings || {}), phoneNotifications: on }; // the devices event confirms it
    phoneAudienceChanged();
    if (id === me.id) toast(on ? 'Phone notifications show here now' : 'Phone notifications no longer show here');
  } catch (err) {
    if (input) input.checked = !on;
    toast(friendlyError(err), { error: true });
  }
}
