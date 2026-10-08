'use strict';
// Live updates: one event stream per page (docs/API.md → Live events) with a dead-stream watchdog (the server
// sends `ping` events), exponential backoff, and a catch-up sync after every reconnect that patches what's on
// screen instead of rebuilding it. Also notices when a new version of the web app was deployed.

const live = {
  es: null, attempt: 0, timer: null, retryAt: 0, lastEvent: 0, watchdog: false, stopped: false,
  pingSecs: 25,      // the server's heartbeat on this stream (1.3.0 servers: 25 s)
  deadTimer: null,   // the dead-stream watchdog (one timeout, pushed back by every event)
  retryTicker: null, // the "Retrying in N s" countdown, only while a retry is pending and the page is visible
  stream: '',        // this stream's id from its `hello` (servers with stream-modes), for pokes
  mode: 'foreground',
  pokeBusy: false,   // a poke is on its way
  pokeWish: null,    // the mode to ask for once it's answered
  pokeWait: null,    // waiting for the ping that proves a poked stream is still alive
  pokeRetry: null,   // a poke that got no answer is tried again later (pokeFailures: how many in a row)
  pokeFailures: 0,
  serverId: '',      // the Beam this stream's hello came from; '' until then, and again as soon as it drops
  cursor: '',        // where the last catch-up left off (servers with items-since)
  needFull: false,   // the next catch-up must fetch the whole list (a merge happened)
};
let updateReady = false;
let webSeen = '';
let syncing = false;
let syncAgain = false;
let firstSync = true;

function connect() {
  if (!paired || live.stopped) return;
  clearTimeout(live.timer);
  live.timer = null;
  clearTimeout(live.deadTimer);
  live.es?.close();
  live.retryAt = 0;
  runRetryTicker();
  if (net.state === 'online') net.set('connecting');
  // A hidden page opens its stream in background mode (servers with stream-modes): only urgent events at once.
  const mode = serverHas('stream-modes') ? `&mode=${wantedMode()}` : '';
  const es = new EventSource(url(`api/events?device=${encodeURIComponent(me.id)}&name=${encodeURIComponent(me.name)}&platform=${encodeURIComponent(me.platform)}${mode}`));
  live.es = es;
  live.stream = '';
  live.serverId = '';
  clearTimeout(live.pokeWait);
  live.pokeWait = null;
  clearTimeout(live.pokeRetry); // a new stream opens in the wanted mode
  live.pokeRetry = null;
  live.pokeFailures = 0;
  // The first catch-up waits for the stream (so nothing is fetched twice), but not for long: a proxy that holds
  // event streams back mustn't keep the history from loading.
  clearTimeout(live.firstSyncTimer);
  if (firstSync) live.firstSyncTimer = setTimeout(() => { if (firstSync && !syncing) sync('first'); }, 3000);
  es.onopen = () => {
    if (es !== live.es) return;
    clearTimeout(live.firstSyncTimer);
    live.attempt = 0;
    live.lastEvent = Date.now();
    net.ok();
    sync('open');
  };
  es.onerror = () => {
    if (es !== live.es) return;
    // Take over from the browser's fixed 3 s retries: back off, and check for sign-out / move first.
    es.close();
    live.es = null;
    streamGone();
    scheduleReconnect();
  };
  const on = (name, fn) => es.addEventListener(name, e => {
    if (es !== live.es) return;
    live.lastEvent = Date.now();
    let data = {};
    try { data = JSON.parse(e.data || '{}') || {}; } catch {}
    try { fn(data); } catch (err) { console.error(`${name} event:`, err); }
    armWatchdog();
  });
  on('hello', onHello);
  on('ping', () => { live.watchdog = true; });
  on('item', onEventItem);
  on('delete', ({ id }) => onEventDelete(id));
  on('update', onEventUpdate);
  on('devices', ({ devices: list }) => onEventDevices(list));
  on('refresh', onEventRefresh);
  on('read', onEventRead);
  on('moved', ({ movedTo }) => onMoved(movedTo));
  on('settings', onEventSettings);
  on('login-request', onLoginRequestEvent);
  on('login-request-done', onLoginRequestDone);
  on('app-update', data => { server.appUpdates = data; });
  on('upload', onEventUpload);
  on('upload-done', ({ id }) => dropIncoming(id));
  on('upload-cancelled', ({ id }) => dropIncoming(id));
  on('ring', onRingEvent);
  on('alert', onAlertEvent);
  on('apps', onAppsEvent); // (1.21: Settings → Apps reads the list again)
  on('rc-sessions', onRcSessions); // (who controls which PC, for Settings; the viewer has its own stream: remote.js)
  on('notification', onPhoneNotification);
  on('notification-removed', onPhoneNotificationRemoved);
  on('notification-request-done', onPhoneRequestDone);
}

function scheduleReconnect() {
  if (!paired || live.stopped) return;
  clearTimeout(live.timer);
  // Most drops are blips (a proxy restart, a network hand-over): the first retry comes after about 250 ms, then
  // 1, 2, 4… up to 30 s. A little jitter keeps many devices from coming back in step.
  const base = live.attempt === 0 ? 250 : Math.min(30000, 1000 * 2 ** (live.attempt - 1));
  const delay = base * (0.8 + Math.random() * 0.4);
  live.attempt++;
  live.retryAt = Date.now() + delay;
  // A single blip doesn't deserve a banner; a second failure in a row does.
  if (live.attempt >= 2 || !navigator.onLine) net.fail();
  else net.set('connecting');
  live.timer = setTimeout(probeAndConnect, delay);
  renderBanner();
  runRetryTicker();
}

// A refused stream can mean a sign-out (401) or a move (410); a plain network error just means "try later".
async function probeAndConnect() {
  live.timer = null;
  live.retryAt = 0;
  if (!paired || live.stopped) return;
  streamGone();
  let res;
  try {
    res = await fetch(url('api/me'), { headers: idHeaders(), credentials: 'same-origin', signal: AbortSignal.timeout(12000) });
  } catch (error) {
    net.fail({ error });
    return scheduleReconnect();
  }
  if (res.status === 401) return onUnauthorized('stream', (await res.json().catch(() => ({}))).serverId);
  if (res.status === 410) return onMoved((await res.json().catch(() => ({}))).movedTo);
  if (res.status >= 500) { net.fail({ status: res.status }); return scheduleReconnect(); }
  connect();
}

function reconnectNow() {
  live.attempt = 0;
  clearTimeout(live.timer);
  live.timer = null;
  probeAndConnect();
}

function stopLive() {
  clearTimeout(live.timer);
  live.timer = null;
  clearTimeout(live.deadTimer);
  live.deadTimer = null;
  live.es?.close();
  live.es = null;
  streamGone();
}

// No live stream any more (or a new one is being checked): until a hello says which Beam is there, none counts as
// "the Beam that answered", and the outbox waits.
function streamGone() {
  live.serverId = '';
  server.answered = '';
}

// The watchdog: silence for two heartbeats (plus slack) means the connection is dead even if the browser still
// thinks it's open (sleep, Wi-Fi switch, NAT timeouts). It's one timeout that every event pushes back, so while
// the stream is healthy nothing wakes the page up (a hidden page used to check every 5 s).
const deadAfterMs = () => (2 * live.pingSecs + 20) * 1000;
function armWatchdog(minMs = 1000) {
  clearTimeout(live.deadTimer);
  live.deadTimer = null;
  if (!live.es || !live.watchdog) return;
  live.deadTimer = setTimeout(watchdogFired, Math.max(minMs, live.lastEvent + deadAfterMs() - Date.now()));
}
function watchdogFired() {
  live.deadTimer = null;
  if (!live.es || !live.watchdog) return;
  if (Date.now() - live.lastEvent < deadAfterMs()) { armWatchdog(); return; }
  live.es.close();
  live.es = null;
  streamGone();
  reconnectNow();
}

// ---------------------------------------------------------------- background mode (servers with stream-modes)
// Off screen, the stream switches to background: the server sends only urgent events at once (messages for this
// device, rings, alerts, sign-in requests) and everything else with a heartbeat every 3 minutes, so status reports
// and receipts stop waking the device. Back on screen it switches to foreground, which also delivers what was held.

const wantedMode = () => (document.hidden ? 'background' : 'foreground');

// Going off screen: at once, without waiting (the Windows app suspends a hidden page 5 s later), and the request
// outlives the page if it has to (keepalive).
function goBackground() {
  if (!live.es || !live.stream || !serverHas('stream-modes') || live.mode === 'background') return;
  poke('background');
}

// Coming back: foreground again. The server flushes what it held and pings; "not alive", or nothing on the stream
// within 5 s, means it died meanwhile (sleep, a network change): reconnect.
function goForeground() {
  if (!live.es) { reconnectNow(); return; }
  if (!live.stream || !serverHas('stream-modes')) return;
  poke('foreground', { expectData: true });
}

// One poke at a time per stream. The server applies pokes in the order they arrive, so two in flight (hidden, then
// on screen again at once) could leave a page that's on screen in background mode. A wish made while a poke is on
// its way goes out once that one is answered, and every answer is checked against what's wanted by then. A page
// being left sends none (its stream closes anyway).
function poke(mode, { expectData = false } = {}) {
  if (leaving) return;
  if (live.pokeRetry && !expectData) return; // going off screen again: the pending retry (with its pause) covers it
  clearTimeout(live.pokeRetry);
  live.pokeRetry = null;
  live.pokeWish = { mode, expectData };
  if (!live.pokeBusy) runPokes();
}

async function runPokes() {
  live.pokeBusy = true;
  try {
    while (live.pokeWish) {
      const { mode, expectData } = live.pokeWish;
      live.pokeWish = null;
      const result = await pokeOnce(mode, expectData);
      if (result === 'failed') { live.pokeWish = null; retryPokeLater(); break; }
      if (result !== 'ok') { live.pokeWish = null; break; } // replaced by a new stream (it opens in the wanted mode)
      live.pokeFailures = 0;
      if (!live.pokeWish && !leaving && live.mode !== wantedMode()) live.pokeWish = { mode: wantedMode(), expectData: !document.hidden };
    }
  } finally {
    live.pokeBusy = false;
  }
}

// A poke that got no answer (no network, a proxy's 502) is tried again after about 15 s, then 30 s, 1 min… up to
// 5 min, and only if the page still wants the other mode. A poke that works, or a new stream, starts over.
function retryPokeLater() {
  clearTimeout(live.pokeRetry);
  live.pokeFailures++;
  const delay = Math.min(300000, 15000 * 2 ** (live.pokeFailures - 1)) * (0.8 + Math.random() * 0.4);
  live.pokeRetry = setTimeout(() => {
    live.pokeRetry = null;
    if (live.es && live.stream && live.mode !== wantedMode()) poke(wantedMode(), { expectData: !document.hidden });
  }, delay);
}

// Sends one poke: 'ok', 'gone' (the stream had to be replaced; the new one opens in the wanted mode) or 'failed'
// (no answer, the stream left as it was).
async function pokeOnce(mode, expectData) {
  clearTimeout(live.pokeWait);
  live.pokeWait = null;
  const stream = live.stream;
  if (!stream || !live.es) return 'gone';
  const sentAt = Date.now();
  // The server switches (and pings) before it answers, and the answer may come late (a suspended page): from now
  // on the next heartbeat may be 3 minutes away, so the watchdog must not call the stream dead after 70 s.
  const pingBefore = live.pingSecs;
  if (mode === 'background') { live.pingSecs = Math.max(live.pingSecs, 180); armWatchdog(); }
  let res;
  try {
    res = await apiJson('api/events/poke', { ...jsonBody({ stream, mode }), keepalive: true, timeout: 10000 });
  } catch (err) {
    if (err.status === 401 || err.moved) return 'gone';
    if (expectData && stream === live.stream) { reconnectNow(); return 'gone'; } // can't reach the server
    if (stream !== live.stream) return 'gone';
    // Going off screen without an answer: the stream most likely stays in its mode, so does the watchdog's pace.
    if (mode === 'background') { live.pingSecs = pingBefore; armWatchdog(); }
    return 'failed';
  }
  if (stream !== live.stream) return 'gone'; // another stream took over meanwhile
  if (!res || !res.alive) { reconnectNow(); return 'gone'; }
  live.mode = res.mode || mode;
  if (Number(res.ping) > 0) live.pingSecs = Number(res.ping);
  // Back on screen after a long break: the flushed events and the poke's ping get their 5 s.
  armWatchdog(expectData ? 5000 : 1000);
  if (expectData && live.lastEvent < sentAt) {
    live.pokeWait = setTimeout(() => {
      live.pokeWait = null;
      if (stream === live.stream && live.lastEvent < sentAt) reconnectNow();
    }, 5000);
  }
  return 'ok';
}

// "Retrying in N s" in the banner: counts down only while a retry is pending and someone can see it.
function runRetryTicker() {
  clearInterval(live.retryTicker);
  live.retryTicker = null;
  if (!live.retryAt || document.hidden) return;
  tickRetryCountdown();
  live.retryTicker = setInterval(() => {
    if (live.retryAt && !document.hidden) tickRetryCountdown();
    else { clearInterval(live.retryTicker); live.retryTicker = null; }
  }, 5000);
}

// ---------------------------------------------------------------- catch-up sync (patches, never rebuilds)

// A snapshot must never undo what live events (or this page) changed after it was taken: a device that just
// registered, an item that just arrived or was just deleted.
const changedAt = new Map(); // item id -> when an event or this page added/removed it
let devicesAt = 0;
function touchItem(id) {
  changedAt.set(id, performance.now());
  if (changedAt.size > 2000) for (const [k, t] of changedAt) if (performance.now() - t > 300000) changedAt.delete(k);
}

async function sync(reason = '') {
  if (!paired) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  const started = performance.now();
  try {
    // With items-since, a catch-up only brings what changed since the last one (a reconnect used to download the
    // whole history). The whole list comes when there's nothing to go on, after a merge, or when the server says so.
    const delta = serverHas('items-since') && live.cursor && items.length && !live.needFull;
    const [d, i, m] = await Promise.all([apiJson('api/devices'), apiJson(delta ? `api/items?since=${encodeURIComponent(live.cursor)}` : 'api/items'), apiJson('api/me')]);
    // Only the saved history's own Beam is merged into it: by now the server info or the stream's hello normally
    // said who answers; if neither did, ask before using the answers.
    if (cache.owner && !server.answered) await loadServerInfo();
    // Answers from the saved history's own Beam wake it if it was dormant; another Beam's (signed in there) replace
    // it first. Either way it's settled before anything is applied or written.
    if (waking) await waking;
    if (replacing) await replacing;
    applyMe(m);
    if (devicesAt < started) applyDevices(d.devices);
    if (i.delta === true) applyDelta(i, started);
    else {
      live.needFull = false;
      applyItems(i.items || [], started);
      cache.replaceItems(items);
    }
    if (typeof i.cursor === 'string') { live.cursor = i.cursor; cache.setCursor(i.cursor); }
    if (!readMarks) seedReadMarks();
    cache.saveDevices();
    if (firstSync) cache.flushPending(); // what a (cold) start learned is kept at once, even if Beam is closed right away
    renderAll();
    if (firstSync) {
      firstSync = false;
      checkResumeRecords();
      catchUpApprovals();
    }
    flushOutbox();
    reconcileIncoming();
    if (phone.shown) loadPhoneNotes(); // what came and went while the stream was down
  } catch (err) {
    if (!err.offline && !err.status) console.error('sync', err);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; sync('again'); }
  }
}

function applyMe(m) {
  if (!m) return;
  if (!HOST && m.you && m.you !== me.id && DEVICE_ID.test(m.you)) adoptIdentity(m.you);
  if (m.machine?.name && learnMachineName(m.machine.name)) api('api/me').catch(() => {}); // tell the server the new name
  if (m.read && mergeReadMarks(m.read)) renderSidebar();
  me.temporary = Boolean(m.auth?.session || m.temporary);
  if (me.temporary && !cacheDisabled) disableOfflineCache(); // a borrowed computer keeps nothing
}

// When a Beam app runs on this same machine, the server links this browser to it and tells us the app's
// device id; from then on this browser *is* that device (same conversations as the app).
function adoptIdentity(you) {
  if (HOST || !you || you === me.id || !DEVICE_ID.test(you)) return false;
  const old = me.id;
  me.id = you;
  store.set('beam.deviceId', you);
  setCookie('beam_device_id', you);
  carryMerge(old, you);
  // What this browser queued is now this device's (the stored copies too, even those waiting for another Beam).
  for (const entry of outbox.values()) if (entry.deviceId === old) entry.deviceId = you;
  outboxStore.retag(old, you);
  dataVersion++;
  view.conv = null; // mine/theirs changed everywhere: start the thread fresh (only happens once)
  cache.saveMeta();
  if (paired) connect();
  return true;
}

function applyDevices(list) {
  const before = new Map(devices.map(d => [d.id, d.name]));
  setDevices(list);
  cache.saveDevices();
  const renamed = devices.some(d => before.has(d.id) && before.get(d.id) !== d.name);
  if (renamed) for (const key of view.nodes.keys()) if (key.startsWith('m:')) { const it = itemMap.get(key.slice(2)); if (it) patchMsg(it); }
  markDevicesKnown(); // open pickers catch up (every caller re-renders the sidebar next)
  phoneAudienceChanged(); // shown here (or not any more)?
  refreshDeviceInfo();
  if (HOST && !$('#settingsDlg').open) return;
  if ($('#settingsDlg').open && settingsSection === 'devices') renderSettings();
}

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// A snapshot's copy of one item, unless an event (or this page) changed it after the snapshot was asked for.
const changedSince = (id, since) => (changedAt.get(id) || 0) > since;
function applyItem(raw, since) {
  const item = normalize(raw);
  const old = itemMap.get(item.id);
  if (!old) { if (!changedSince(item.id, since)) putItem(item); return item.id; }
  const moved = old.from !== item.from || !sameJson(old.to, item.to);
  // (1.14.0) reactions and edits redraw the bubble
  const content = !sameJson(old.reactions || {}, item.reactions || {}) || old.edited !== item.edited || (item.kind === 'text' && old.text !== item.text);
  const changed = moved || content || !sameJson(old.delivered, item.delivered) || old.pinned !== item.pinned || !sameJson(old.thumb, item.thumb)
    || old.truncated !== item.truncated;
  if (!changed) return item.id;
  const thumbChanged = !sameJson(old.thumb, item.thumb);
  if (item.kind === 'text' && old.text !== item.text) view.fullText.delete(item.id);
  if (!item.reactions) delete old.reactions;
  Object.assign(old, item);
  if (moved || thumbChanged || content) replaceMsg(old); else patchMsg(old);
  dataVersion++;
  return item.id;
}

function applyItems(list, since = Infinity) {
  const fresh = new Set();
  for (const raw of list) fresh.add(applyItem(raw, since));
  for (const item of [...items]) if (!fresh.has(item.id) && !pendingDeletes.has(item.id) && !changedSince(item.id, since)) removeItem(item.id);
}

// A delta (items-since): drop what was deleted, then add or update what changed. The result is the full list.
function applyDelta({ items: changedItems = [], deleted = [] }, since) {
  // A deletion is final (ids are never reused) and a delta reports it only once, so it always applies: whatever
  // this page did meanwhile, and even if Undo is still on offer for it here.
  for (const id of deleted) {
    pendingDeletes.delete(id);
    removeItem(id);
    cache.deleteItem(id);
  }
  for (const raw of changedItems) {
    const id = applyItem(raw, since);
    if (itemMap.has(id)) cache.putItem(itemMap.get(id));
  }
}

function renderAll() {
  // An unknown conversation falls back to All devices, but only once the device list is known (a cold start
  // would otherwise lose the conversation it was on).
  if (devicesKnown && current !== 'all' && !deviceById(current) && !itemsIn(current).length) current = 'all';
  renderHeader();
  renderThread({ scroll: 'keep' });
  renderSidebar();
  renderPhone();
}

// ---------------------------------------------------------------- events

function onEventItem(raw) {
  touchItem(raw.id);
  const isNew = putItem(raw);
  const item = itemMap.get(raw.id);
  cache.putItem(item);
  dropIncoming(item.id);
  if (item.from && item.from !== me.id && !deviceById(item.from)) refreshDevices();
  if (!isNew) { patchMsg(item); return; }
  onItemAdded(item, { quiet: dropSending(sendingFor(item)) }); // our own text: it takes its temporary bubble's place
  if (isForMe(item)) {
    notify(item);
    if (!document.hidden) setTimeout(offerNotifications, 1500); // once per device, after the first thing arrives
  }
}

function onEventDelete(id) {
  touchItem(id);
  if (!removeItem(id)) return;
  cache.deleteItem(id);
  onItemRemoved(id);
}

function onEventUpdate(data) {
  const item = itemMap.get(data.id);
  if (!item) return;
  const thumbChanged = 'thumb' in data && !sameJson(item.thumb, data.thumb);
  const pinChanged = 'pinned' in data && item.pinned !== data.pinned;
  // (1.14.0) reactions and edits change the bubble itself
  const textChanged = 'text' in data && data.text !== item.text;
  const redraw = thumbChanged || textChanged || ('reactions' in data && !sameJson(item.reactions || {}, data.reactions || {})) || ('edited' in data && item.edited !== data.edited);
  if (textChanged) view.fullText.delete(item.id);
  for (const [k, v] of Object.entries(data)) if (k !== 'id') item[k] = v;
  if (item.reactions && !Object.keys(item.reactions).length) delete item.reactions;
  dataVersion++;
  cache.putItem(item);
  if (redraw) replaceMsg(item); else patchMsg(item);
  if (textChanged && compose.reply === item.id) renderComposeBar();
  if (pinChanged) { renderHeader(); if (view.pinnedOnly) renderThread({ scroll: 'keep' }); }
}

// A device we haven't heard of yet (it just registered; the server announces devices a moment later).
async function refreshDevicesNow() {
  const started = performance.now();
  try {
    const d = await apiJson('api/devices');
    if (devicesAt > started) return;
    devicesAt = performance.now();
    applyDevices(d.devices);
    renderSidebar();
    renderHeader();
  } catch {}
}
const refreshDevices = debounce(refreshDevicesNow, 150);

// Before refusing to send to a conversation whose device we don't know: make sure it's really gone.
async function ensureSendable(conv) {
  if (canSendTo(conv)) return true;
  await refreshDevicesNow();
  return canSendTo(conv);
}

function onEventDevices(list) {
  if (!Array.isArray(list)) return;
  devicesAt = performance.now();
  applyDevices(list);
  renderSidebar();
  renderHeader();
  if (current !== 'all' && !deviceById(current)) renderThread({ scroll: 'keep' }); // removed: keep history, disable sending
}

function onEventRefresh(data) {
  if (data && data.from && data.to) carryMerge(data.from, data.to);
  live.needFull = true; // a merge changes whose items are whose: the whole list
  sync('refresh');
}

function onEventRead(data) {
  if (!data || data.device !== me.id || !data.conversation) return;
  if (mergeReadMarks({ [data.conversation]: data.ts })) renderSidebar();
}

function onEventSettings(data) {
  const s = data?.settings || data;
  if (s && Number.isFinite(s.maxItems)) server.maxItems = s.maxItems;
  if (s && serverSettings) serverSettings = { ...serverSettings, ...s }; // changed from another device
  if ($('#settingsDlg').open) renderSettings();
  refreshDeviceInfo();
}

// Another device is sending a file: show its progress (API v3 `upload` events, at most one a second).
function onEventUpload(data) {
  if (!data || !data.id || data.from === me.id || uploadsByServerId(data.id)) return;
  const convs = convsOf(normalize({ from: data.from, to: data.to || [], id: data.id }));
  if (!convs.length) return;
  if (itemMap.has(data.id)) { dropIncoming(data.id); return; }
  const inc = incoming.get(data.id) || { id: data.id, from: data.from, name: data.name, size: data.size, convs, offset: 0 };
  const now = Date.now();
  if (inc.lastAt && data.offset > inc.offset) inc.rate = (data.offset - inc.offset) / ((now - inc.lastAt) / 1000);
  inc.offset = data.offset || 0;
  inc.lastAt = now;
  const isNew = !incoming.has(data.id);
  incoming.set(data.id, inc);
  if (isNew) { if (convs.includes(current)) refreshPending(); }
  else patchIncoming(inc);
}

// "Receiving…" rows whose upload ended while this page wasn't listening (a held upload-done or upload-cancelled is
// lost with its stream): gone once the file is an item, or once the server no longer knows the upload.
async function reconcileIncoming() {
  for (const inc of [...incoming.values()]) {
    if (itemMap.has(inc.id)) { dropIncoming(inc.id); continue; }
    const err = await api(`api/uploads/${encodeURIComponent(inc.id)}`, { timeout: 10000 }).then(() => null, e => e);
    if (err?.status === 404) dropIncoming(inc.id);
  }
}

function dropIncoming(id) {
  if (incoming.delete(id)) removePendingRow(`in:${id}`);
}

// ---------------------------------------------------------------- server hello: moves, a different Beam, new web versions

function onHello(h) {
  live.watchdog = true;
  if (h.movedTo) { onMoved(h.movedTo); return; }
  if (Array.isArray(h.features)) { server.features = new Set(h.features); cache.saveMeta(); phoneAudienceChanged(); }
  live.pingSecs = Number(h.ping) > 0 ? Number(h.ping) : 25; // a 1.3 server says nothing: its 25 s pings
  if (h.stream) {
    live.stream = h.stream;
    live.mode = h.mode || 'foreground';
    // The page went on or off screen while its stream was opening.
    if (serverHas('stream-modes') && live.mode !== wantedMode()) poke(wantedMode());
  }
  if (h.serverId) {
    answeredBy(h.serverId); // its own Beam, or (signed in to another one) the saved history is replaced
    live.serverId = h.serverId; // this stream's Beam: what's queued for it may go now
    cache.saveMeta();
    flushOutbox();
  }
  if (h.api) server.api = Number(h.api) || server.api;
  if (h.version) server.version = h.version;
  if (h.web) {
    if (!webSeen) {
      webSeen = h.web;
      if (document.documentElement.dataset.shell === 'cache') markUpdateReady(h.web); // started from the offline copy
    } else if (h.web !== webSeen) markUpdateReady(h.web);
  }
}

function markUpdateReady(web) {
  if (HOST) {
    // The Windows window reloads itself once it's hidden or idle; nothing to show.
    updateReady = true;
    maybeReloadForUpdate(web);
    return;
  }
  updateReady = true;
  renderBanner();
  maybeReloadForUpdate(web);
}

// Reload into the new version when it can't disturb anything: the page is hidden, nothing is uploading, and we
// haven't just reloaded for this same version (no loops).
function maybeReloadForUpdate(web) {
  if (!updateReady) return;
  let already = '';
  try { already = sessionStorage.getItem('beam.reloadedFor') || ''; } catch {}
  if (already === (web || 'x')) return;
  const busy = [...uploads.values()].some(u => !['failed', 'done'].includes(u.state));
  if (!document.hidden || busy || document.querySelector('dialog[open]')) {
    pendingUpdateReload = web || 'x';
    return;
  }
  try { sessionStorage.setItem('beam.reloadedFor', web || 'x'); } catch {}
  location.reload();
}
let pendingUpdateReload = '';

// ---------------------------------------------------------------- notifications (browser mode only; the Windows app notifies natively)

async function notify(item) {
  if (HOST || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  const title = `${item.kind === 'text' ? 'Message' : 'File'} from ${senderName(item)}`;
  const conv = convsOf(item)[0] || 'all';
  const options = {
    body: item.kind === 'text' ? item.text.slice(0, 160) : `${item.name} · ${formatSize(item.size)}`,
    icon: url('icon-192.png'), tag: item.id, data: { conv, itemId: item.id },
  };
  showNotification(title, options, () => { openConv(conv); revealItem(item.id); });
}

async function showNotification(title, options, onclick) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) return await reg.showNotification(title, options);
    const n = new Notification(title, options); // desktop browsers without a service worker
    n.onclick = () => { window.focus(); onclick?.(); n.close(); };
  } catch {}
}
