'use strict';
// Data: items, devices, conversations and read state. Rendering lives in thread.js.

let devices = [];          // every device the server knows, including this one
const deviceMap = new Map();
// Whether `devices` is real yet: from the server, or a non-empty list from the offline cache. Until then no
// device picker shows anything to tap (on a cold start "All devices" would otherwise be the only choice).
let devicesKnown = false;
const devicePickers = new Set(); // open pickers: re-rendered whenever the device list changes

function markDevicesKnown() {
  devicesKnown = true;
  for (const refresh of [...devicePickers]) refresh();
}

// A line for a picker that is still waiting for the device list.
function devicesLoadingRow(tag = 'li') {
  const text = net.state === 'offline'
    ? 'Your devices will show up here once Beam reaches the server.'
    : 'Loading your devices…';
  return el(tag, { class: 'devices-loading', role: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), el('span', {}, text));
}
let items = [];            // oldest first
const itemMap = new Map(); // id -> item
let knownNames = {};       // device id -> last name seen, so removed devices keep a readable name
let readMarks = store.json('beam.read', null); // conversation -> newest ts read on this device (null = never seeded)
let current = store.get('beam.conv') || 'all';
let dataVersion = 0;       // bumps whenever items/devices change; caches below key off it

const normalize = item => ({ from: null, to: [], delivered: {}, ...item });

function setDevices(list) {
  devices = Array.isArray(list) ? list : [];
  deviceMap.clear();
  for (const d of devices) {
    deviceMap.set(d.id, d);
    if (d.name && knownNames[d.id] !== d.name) { knownNames[d.id] = d.name; cache.saveNames(); }
  }
  dataVersion++;
}

function setItems(list) {
  items = list.map(normalize).sort((a, b) => a.ts - b.ts);
  itemMap.clear();
  for (const item of items) {
    itemMap.set(item.id, item);
    rememberSenderName(item);
  }
  dataVersion++;
}

// Returns true when the item is new.
function putItem(raw) {
  const item = normalize(raw);
  const old = itemMap.get(item.id);
  if (old) {
    Object.assign(old, item);
    dataVersion++;
    return false;
  }
  itemMap.set(item.id, item);
  let i = items.length;
  while (i > 0 && items[i - 1].ts > item.ts) i--;
  items.splice(i, 0, item);
  rememberSenderName(item);
  dataVersion++;
  return true;
}

function removeItem(id) {
  const item = itemMap.get(id);
  if (!item) return null;
  itemMap.delete(id);
  items.splice(items.indexOf(item), 1);
  dataVersion++;
  acked.delete(id);    // what this page kept for it goes with it
  releasePreview(id);
  return item;
}

function rememberSenderName(item) {
  if (item.from && item.device && !deviceMap.has(item.from) && knownNames[item.from] !== item.device) {
    knownNames[item.from] = item.device;
    cache.saveNames();
  }
}

// ---------------------------------------------------------------- conversations (docs/API.md → Conversations)

const deviceById = id => deviceMap.get(id);
const isForMe = item => (item.to.length === 0 || item.to.includes(me.id)) && item.from !== me.id;
const nameOf = id => deviceById(id)?.name || knownNames[id] || 'Removed device';
const senderName = item => (item.from === me.id ? 'You' : deviceById(item.from)?.name || item.device || knownNames[item.from] || 'Unknown');

// Which conversations an item belongs to, from this device's point of view. A broadcast shows in All devices
// and in its sender's conversation. Conversations with devices that were removed stay (their history is
// still on the server); they show as "Removed device" and can't be sent to.
function convsOf(item) {
  if (item.to.length === 0) return item.from && item.from !== me.id ? ['all', item.from] : ['all'];
  if (!item.from) return item.to.includes(me.id) ? ['all'] : [];
  if (item.from === me.id) return item.to.filter(t => t !== me.id);
  if (item.to.includes(me.id)) return [item.from];
  return [];
}

// conversation -> its items (oldest first), rebuilt lazily when data changes.
let convIndex = { version: -1, id: '', map: new Map() };
function index() {
  if (convIndex.version === dataVersion && convIndex.id === me.id) return convIndex.map;
  const map = new Map([['all', []]]);
  for (const item of items) {
    for (const c of convsOf(item)) {
      if (!map.has(c)) map.set(c, []);
      map.get(c).push(item);
    }
  }
  convIndex = { version: dataVersion, id: me.id, map };
  return map;
}
const itemsIn = conv => index().get(conv) || [];

const isRemoved = conv => conv !== 'all' && !deviceById(conv);
const convName = conv => (conv === 'all' ? 'All devices' : nameOf(conv));
const targetsOf = conv => (conv === 'all' ? [] : [conv]);
const canSendTo = conv => conv === 'all' || Boolean(deviceById(conv));

// Every conversation to list: All devices, each other device, and removed devices that still have history.
function conversationOrder() {
  const map = index();
  const ids = new Set(devices.map(d => d.id).filter(id => id !== me.id));
  for (const conv of map.keys()) if (conv !== 'all' && conv !== me.id && map.get(conv).length) ids.add(conv);
  const last = conv => (map.get(conv) || []).at(-1)?.ts || 0;
  return ['all', ...[...ids].sort((a, b) =>
    (isRemoved(a) - isRemoved(b)) || (last(b) - last(a)) || ((deviceById(b)?.online || 0) - (deviceById(a)?.online || 0)) || nameOf(a).localeCompare(nameOf(b)))];
}

// ---------------------------------------------------------------- read state
// An item counts as read once it has been seen in ANY of its conversations on this device (a broadcast read in
// All devices is read in its sender's conversation too). Markers sync through the server (API v3) and, in the
// Windows app, to the tray's unread count.

function isRead(item) {
  if (!readMarks) return true;
  for (const c of convsOf(item)) if ((readMarks[c] || 0) >= item.ts) return true;
  return false;
}

function unread(conv) {
  let n = 0;
  for (const item of itemsIn(conv)) if (isForMe(item) && !isRead(item)) n++;
  return n;
}

function totalUnread() {
  let n = 0;
  for (const item of items) if (isForMe(item) && convsOf(item).length && !isRead(item)) n++;
  return n;
}

const pushRead = debounce(() => {
  if (!serverHas('read-markers') || !readDirty.size) return;
  const dirty = [...readDirty];
  readDirty.clear();
  for (const conv of dirty) {
    api('api/read', jsonBody({ conversation: conv, ts: readMarks[conv] }, 'PUT')).catch(() => readDirty.add(conv));
  }
}, 1200);
const readDirty = new Set();

// Advance the marker for a conversation (never backwards).
function markConvRead(conv, ts, { local = false } = {}) {
  if (!ts) return false;
  if (!readMarks) readMarks = {};
  if ((readMarks[conv] || 0) >= ts) return false;
  readMarks[conv] = ts;
  store.setJson('beam.read', readMarks);
  cache.saveRead();
  if (!local) {
    readDirty.add(conv);
    pushRead();
    if (HOST) hostPost('read', { conversation: conv, ts });
  }
  return true;
}

// Merge markers from the server or another tab (take the newest of each).
function mergeReadMarks(marks) {
  if (!marks || typeof marks !== 'object') return false;
  let changed = false;
  if (!readMarks) readMarks = {};
  for (const [conv, ts] of Object.entries(marks)) {
    if (Number.isFinite(ts) && ts > (readMarks[conv] || 0)) { readMarks[conv] = ts; changed = true; }
  }
  if (changed) { store.setJson('beam.read', readMarks); cache.saveRead(); }
  return changed;
}

// First sign-in on this device: what's already there counts as read (instead of "137 unread").
function seedReadMarks() {
  if (readMarks) return false;
  readMarks = {};
  for (const [conv, list] of index()) if (list.length) readMarks[conv] = list.at(-1).ts;
  store.setJson('beam.read', readMarks);
  cache.saveRead();
  for (const conv of Object.keys(readMarks)) readDirty.add(conv);
  pushRead();
  return true;
}

// Another device was merged into one we know (same machine): carry its read state and open thread over.
function carryMerge(from, to) {
  if (!from || !to || from === to) return;
  if (readMarks && readMarks[from]) {
    if ((readMarks[from] || 0) > (readMarks[to] || 0)) { readMarks[to] = readMarks[from]; readDirty.add(to); pushRead(); }
    delete readMarks[from];
    store.setJson('beam.read', readMarks);
    cache.saveRead();
  }
  if (current === from) { current = to; store.set('beam.conv', to); }
  moveDraft(from, to);
}

// ---------------------------------------------------------------- drafts (one per conversation)

let drafts = store.json('beam.drafts', {});
const saveDrafts = debounce(() => store.setJson('beam.drafts', drafts), 300);
function setDraft(conv, text) {
  if (text) drafts[conv] = text; else delete drafts[conv];
  saveDrafts();
}
function moveDraft(from, to) {
  if (drafts[from] && !drafts[to]) drafts[to] = drafts[from];
  delete drafts[from];
  saveDrafts();
}
