'use strict';
// Sending: text (with an offline outbox), resumable chunked uploads, folders (zipped in the browser),
// thumbnails, paste and drag-and-drop. In host mode files go through the Windows app instead (HOST-BRIDGE.md §7).

// ---------------------------------------------------------------- text

async function sendText(text, conv = current, { reply = null } = {}) {
  if (net.state === 'offline') { queueText(text, conv, { reply }); return null; }
  const draft = showSending(text, conv, reply);
  try {
    const item = await apiJson('api/text', jsonBody({ text, to: targetsOf(conv), ...(reply && { reply }) }));
    acceptOwnItem(item, draft);
    return item;
  } catch (err) {
    if (dropSending(draft)) refreshPending();
    if (err.offline) { queueText(text, conv, { maybeSent: true, reply }); return null; }
    throw err;
  }
}

// (1.14.0) What a reply answers, for its bubble while it's on its way (the server keeps its own).
function replyPreview(id) {
  const src = id && itemMap.get(id);
  if (!src) return id ? { id } : undefined;
  return { id, kind: src.kind, from: src.from, ...(src.kind === 'text' ? { text: src.text.slice(0, 140) } : { name: src.name }) };
}

// An item this page just created: show it right away (the event for it may arrive before or after), in place of
// its temporary bubble if it has one.
function acceptOwnItem(item, draft = null) {
  if (!item || !item.id) return;
  const swapped = dropSending(draft && sending.has(draft.id) ? draft : sendingFor(item));
  touchItem(item.id);
  if (putItem(item)) {
    cache.putItem(itemMap.get(item.id));
    onItemAdded(itemMap.get(item.id), { fromMe: true, quiet: swapped });
  } else if (swapped) refreshPending(); // its event already brought it in
}

// A sent text shows at once, with a clock where the tick goes; the server's answer (or its event, whichever comes
// first) swaps in the real message. Waiting for the round trip made every send lag by it, and a phone's radio can
// take most of a second to wake up.
const sending = new Map(); // temporary id -> { id, conv, text, item }

function showSending(text, conv, reply = null) {
  const id = `s${randomId(6)}`;
  const entry = { id, conv, text, item: normalize({ id, kind: 'text', text, from: me.id, to: targetsOf(conv), ts: Date.now(), sending: true, ...(reply && { reply: replyPreview(reply) }) }) };
  sending.set(id, entry);
  if (conv === current && !renderingPaused()) {
    renderThread({ scroll: 'bottom' });
    const node = view.nodes.get(`sending:${id}`);
    if (node && !REDUCED_MOTION.matches) {
      node.classList.add('enter');
      node.addEventListener('animationend', () => node.classList.remove('enter'), { once: true });
    }
  }
  return entry;
}

function dropSending(entry) {
  if (!entry || !sending.delete(entry.id)) return false;
  const key = `sending:${entry.id}`;
  view.nodes.get(key)?.remove();
  view.nodes.delete(key);
  return true;
}

// The temporary bubble a message of ours stands for: the same text to the same conversation, oldest first.
function sendingFor(item) {
  if (!sending.size || item.from !== me.id || item.kind !== 'text') return null;
  const convs = convsOf(item);
  for (const entry of sending.values()) if (entry.text === item.text && convs.includes(entry.conv)) return entry;
  return null;
}

async function sendComposer() {
  const box = $('#text');
  const text = box.value;
  const conv = current;
  if (compose.edit) return saveEdit(text); // (1.14.0)
  if (!text.trim() || !await ensureSendable(conv)) return;
  const reply = compose.reply;
  box.value = '';
  setDraft(conv, '');
  autosize();
  endCompose();
  try {
    await sendText(text, conv, { reply });
  } catch (err) {
    if (current === conv && !box.value) { box.value = text; autosize(); }
    setDraft(conv, text);
    if (err.status !== 401 && !err.moved) toast(friendlyError(err), { error: true, ms: 5000 });
  }
}

// ---------------------------------------------------------------- replying and editing (1.14.0)

// Replying to a message, or changing the words of a text: a bar above the message box says which; × or Esc ends it.
const compose = { reply: null, edit: null, draft: '' };

function startReply(item) {
  if (!serverHas('replies') || !canSendTo(current)) return;
  if (compose.edit) endCompose();
  compose.reply = item.id;
  renderComposeBar();
  $('#text').focus();
}

async function startEdit(item) {
  if (!serverHas('edit') || item.kind !== 'text') return;
  let text = view.fullText.get(item.id) || item.text;
  if (item.truncated && !view.fullText.has(item.id)) {
    try { text = await (await api(`api/items/${item.id}/text`)).text(); } catch (err) { toast(friendlyError(err), { error: true }); return; }
  }
  const box = $('#text');
  if (!compose.edit) compose.draft = box.value; // (the draft comes back afterwards)
  compose.reply = null;
  compose.edit = item.id;
  box.value = text;
  autosize();
  renderComposeBar();
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

function endCompose() {
  if (!compose.reply && !compose.edit) return;
  if (compose.edit) { $('#text').value = compose.draft; autosize(); }
  compose.reply = null;
  compose.edit = null;
  compose.draft = '';
  renderComposeBar();
}

function renderComposeBar() {
  const bar = $('#composeBar');
  const id = compose.edit || compose.reply;
  const item = id && itemMap.get(id);
  if (!item) {
    compose.reply = null;
    compose.edit = null;
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }
  const what = item.kind === 'text' ? (view.fullText.get(item.id) || item.text).replace(/\s+/g, ' ').trim() : `📎 ${item.name}`;
  const title = compose.edit ? 'Editing' : `Replying to ${item.from === me.id ? 'your message' : senderName(item)}`;
  bar.replaceChildren(icon(compose.edit ? 'edit' : 'reply'),
    el('span', { class: 'cb-text' }, el('strong', {}, title), ' ', el('span', { class: 'muted' }, what)),
    el('button', { class: 'icon-btn small', type: 'button', title: 'Cancel (Esc)', 'aria-label': compose.edit ? 'Stop editing' : 'Don’t reply', onclick: () => { endCompose(); $('#text').focus(); } }, icon('x')));
  bar.hidden = false;
}

// The new words of the text being edited (nothing changes when they're the same).
async function saveEdit(text) {
  const id = compose.edit;
  const item = itemMap.get(id);
  if (!item) { endCompose(); return; }
  if (!text.trim()) { toast('Nothing would be left: delete the message instead', { error: true }); return; }
  if (text === (view.fullText.get(id) || (item.truncated ? null : item.text))) { endCompose(); return; }
  try {
    const updated = await apiJson(`api/items/${id}`, jsonBody({ text }, 'PATCH'));
    view.fullText.delete(id);
    compose.edit = null; // (the box isn't given back its draft: the edit is done)
    $('#text').value = compose.draft;
    compose.draft = '';
    autosize();
    renderComposeBar();
    // (unless another device's edit came in meanwhile: its event is newer)
    if (!(itemMap.get(id)?.edited > updated.edited)) {
      putItem(updated);
      cache.putItem(itemMap.get(id));
      replaceMsg(itemMap.get(id));
    }
  } catch (err) {
    toast(friendlyError(err), { error: true });
  }
}

// The message box grows with its text (up to 40 % of the window). It's measured on an invisible copy outside the
// layout, and the real box only changes when the number of lines does: resizing it on every key made the browser
// lay the whole conversation out again for each keystroke.
let sizer = null;
function autosize() {
  const box = $('#text');
  $('#sendBtn').disabled = !box.value.trim() || box.disabled;
  if (!sizer) {
    sizer = box.cloneNode(false);
    sizer.removeAttribute('id');
    sizer.removeAttribute('aria-label');
    sizer.setAttribute('aria-hidden', 'true');
    sizer.tabIndex = -1;
    Object.assign(sizer.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', left: '0', top: '0', height: '0', minHeight: '0', overflow: 'hidden' });
    box.after(sizer);
  }
  const max = Math.round(window.innerHeight * 0.4);
  sizer.style.width = `${box.offsetWidth}px`;
  sizer.value = box.value;
  const wanted = sizer.scrollHeight + 2;
  const height = `${Math.min(wanted, max)}px`;
  if (box.style.height !== height) box.style.height = height;
  const overflow = wanted > max ? 'auto' : 'hidden';
  if (box.style.overflowY !== overflow) box.style.overflowY = overflow;
}

function onComposerInput() {
  autosize();
  setDraft(current, $('#text').value);
}
function saveComposerDraft(conv) { setDraft(conv, $('#text').value); }
function loadComposerDraft(conv) {
  $('#text').value = drafts[conv] || '';
  autosize();
}

// ---------------------------------------------------------------- outbox (persisted; sent when Beam is reachable again)

const outbox = new Map(); // id -> entry
let flushing = false;

// What's queued for the cache's Beam is shown and sent; what's queued for another Beam (after a sign-in elsewhere)
// stays stored, out of sight, until that Beam signs this page in again, for 30 days at most. Entries from before they
// recorded their Beam are this one's if the cache knows it; otherwise the first Beam that answers takes them.
let otherBeamOutbox = 0; // how many wait for another Beam (Settings → This device can discard them)
async function loadOutbox() {
  if (cacheDisabled) return; // nothing stored to read (a dormant history's outbox waits where it is)
  let others = 0;
  const sent = sentIds();
  for (const entry of await outboxStore.all()) {
    if (sent.has(entry.id)) { outboxStore.remove(entry.id); continue; } // sent already; its delete didn't go through
    if (!entry.serverId && cache.owner) { entry.serverId = cache.owner; outboxStore.put(entry); }
    entry.stored = true;
    if (!entry.serverId || entry.serverId === cache.owner) { if (!outbox.has(entry.id)) outbox.set(entry.id, entry); continue; }
    if (outbox.has(entry.id)) outbox.delete(entry.id);
    if (Date.now() - entry.created > OUTBOX_KEEP_MS) outboxStore.remove(entry.id);
    else others++;
  }
  otherBeamOutbox = others;
  refreshPending();
}

async function discardOtherBeamOutbox() {
  for (const entry of await outboxStore.all()) if (entry.serverId && entry.serverId !== cache.owner) await outboxStore.remove(entry.id);
  otherBeamOutbox = 0;
  if ($('#settingsDlg').open) renderSettings();
}

function queueText(text, conv, { maybeSent = false, reply = null } = {}) {
  const entry = { id: `o${randomId(6)}`, kind: 'text', text, conv, to: targetsOf(conv), created: Date.now(), deviceId: me.id, serverId: outboxBeam(), maybeSent, ...(reply && { reply }) };
  addToOutbox(entry, 'You’re offline. It will be sent when Beam is back.');
}

function queueFile(file, conv) {
  const entry = { id: `o${randomId(6)}`, kind: 'file', blob: file, name: file.name || 'file', type: file.type || '', size: file.size, conv, to: targetsOf(conv), created: Date.now(), deviceId: me.id, serverId: outboxBeam() };
  addToOutbox(entry, 'You’re offline. The file will be sent when Beam is back.');
}

function addToOutbox(entry, message) {
  outbox.set(entry.id, entry);
  saveOutboxEntry(entry);
  if (entry.conv === current) renderThread({ scroll: 'bottom' });
  renderBanner();
  toast(message);
}

// Stored for later (and for after a reload) only once the write has really committed; until then it's sent from
// memory, the row says so, and the write is tried again before each send.
async function saveOutboxEntry(entry) {
  if (cacheDisabled) return false; // a borrowed computer keeps nothing: memory only, as it says
  entry.stored = await outboxStore.put(entry);
  entry.unsaved = !entry.stored;
  patchOutboxRow(entry);
  return entry.stored;
}

// Sent (or handed to an upload): remembered for a while, so a stored copy whose delete didn't go through is never
// sent again (the server can't tell a repeat).
const SENT_KEY = 'beam.outboxSent';
function markSent(entry) {
  const ids = store.json(SENT_KEY, []).filter(id => id !== entry.id);
  ids.push(entry.id);
  store.setJson(SENT_KEY, ids.slice(-200));
}
const sentIds = () => new Set(store.json(SENT_KEY, []));

function dropOutboxEntry(entry) {
  outbox.delete(entry.id);
  outboxStore.remove(entry.id).then(ok => { if (!ok) setTimeout(() => outboxStore.remove(entry.id), 1000); });
  if (entry.node) entry.node.remove();
  view.nodes.delete(`out:${entry.id}`);
  refreshPending();
  renderBanner();
}

function makeOutboxRow(entry) {
  const status = el('span', { class: 'status-line' });
  const buttons = el('span', { class: 'actions always' });
  const body = entry.kind === 'text'
    ? el('div', { class: 'bubble' }, linkify(el('div', { class: 'text clamp-short' }), entry.text))
    : el('div', { class: 'bubble file' }, el('div', { class: 'file-row' }, el('div', { class: 'ext', 'aria-hidden': 'true' }, extOf(entry.name)),
      el('div', { class: 'file-info' }, el('div', { class: 'fname' }, entry.name), el('div', { class: 'fsize' }, formatSize(entry.size)))));
  entry.node = el('div', { class: 'msg mine pending outbox' }, body, el('div', { class: 'meta' }, icon('clock'), status, buttons));
  entry.status = status;
  entry.buttons = buttons;
  patchOutboxRow(entry);
  return entry.node;
}

function patchOutboxRow(entry) {
  if (!entry.status) return;
  entry.status.textContent = entry.error ? `Not sent: ${entry.error}` : entry.sending ? 'Sending…'
    : entry.unsaved ? 'Waiting to send (not saved on this device: keep this page open)' : 'Waiting to send';
  entry.node.classList.toggle('failed', Boolean(entry.error));
  const btns = [];
  if (entry.error && net.state === 'online') btns.push(mini('refresh', 'Try again', () => { entry.error = ''; patchOutboxRow(entry); flushOutbox(); }));
  if (entry.kind === 'text') btns.push(mini('edit', 'Edit', () => { dropOutboxEntry(entry); openConv(entry.conv); $('#text').value = entry.text; onComposerInput(); $('#text').focus(); }));
  btns.push(mini('x', 'Don’t send', () => dropOutboxEntry(entry)));
  entry.buttons.replaceChildren(...btns);
}

// Queued messages only ever go to the Beam they were written for, and only while that Beam's own live stream is up
// (its hello said so; the value is cleared whenever the stream drops or is re-probed, so nothing remembered or stale
// counts). Never while the saved history is dormant.
const outboxBeam = () => live.serverId || cache.owner || '';
const outboxMayGo = () => !dormant && Boolean(live.serverId);

async function flushOutbox() {
  if (flushing || !outbox.size || net.state !== 'online' || !outboxMayGo()) return;
  flushing = true;
  try {
    // Tabs share the stored outbox: one sends at a time, and an entry another tab has sent meanwhile is skipped.
    if (navigator.locks) await navigator.locks.request('beam-outbox', sendOutbox);
    else await sendOutbox();
  } finally {
    flushing = false;
    renderBanner();
  }
}

async function sendOutbox() {
  for (const entry of [...outbox.values()].sort((a, b) => a.created - b.created)) {
    if (net.state !== 'online' || !live.serverId || dormant) break;
    if (entry.error || !outbox.has(entry.id)) continue;
    if (sentIds().has(entry.id)) { dropOutboxEntry(entry); continue; } // sent already (by another tab, or before a reload)
    if (entry.stored && !(await outboxStore.has(entry.id))) { dropOutboxEntry(entry); continue; } // another tab sent it
    if (entry.unsaved) await saveOutboxEntry(entry);
    if (!entry.serverId) { entry.serverId = live.serverId; outboxStore.put(entry); } // from before entries said: the first Beam that answers
    if (entry.serverId !== live.serverId) continue; // written for another Beam
    if (!canSendTo(entry.conv)) { entry.error = 'that device was removed'; patchOutboxRow(entry); continue; }
    entry.sending = true;
    patchOutboxRow(entry);
    try {
      if (entry.kind === 'text') {
        // A request that failed half-way may have arrived after all: don't send it twice.
        const dup = entry.maybeSent && items.find(i => i.from === me.id && i.kind === 'text' && i.text === entry.text && i.ts >= entry.created - 2000);
        if (!dup) acceptOwnItem(await apiJson('api/text', jsonBody({ text: entry.text, to: entry.to, ...(entry.reply && { reply: entry.reply }) })));
        markSent(entry);
        dropOutboxEntry(entry);
      } else {
        const file = new File([entry.blob], entry.name, { type: entry.type });
        markSent(entry);
        dropOutboxEntry(entry);
        enqueueUpload(file, entry.conv);
        refreshPending();
      }
    } catch (err) {
      entry.sending = false;
      if (err.offline) { entry.maybeSent = true; patchOutboxRow(entry); break; }
      if (err.status === 401 || err.moved) { patchOutboxRow(entry); break; }
      entry.error = friendlyError(err);
      saveOutboxEntry(entry);
      patchOutboxRow(entry);
    }
  }
}

// ---------------------------------------------------------------- uploads (browser mode)
// Resumable uploads in pieces (docs/API.md): 8 MB, or sized to the link on servers with big-chunks. Small files never wait behind big ones: two lanes, one big upload at a time
// plus up to three small ones. Network problems are retried for as long as the device is online; a stalled
// request is abandoned after 30 s without progress; nothing is lost on a reload (see "resume after reload").

const uploads = new Map(); // local id -> upload
const batches = new Map(); // batch id -> summary card for many files at once
const BIG_FILE = 64 * 1024 * 1024;
// Servers with big-chunks take pieces of any size: each is sized to about 4 s at the measured speed, at least 64 MB
// and at most what the server allows, so the link rarely sits idle between pieces (8 MB pieces left it idle a fifth
// of the time at 25 ms). Never one request for a whole big file: we can't count on every proxy on the way
// (tailscale serve) to carry a request for hours.
const PIECE_SECS = 4;
const PIECE_MIN = 64 * 1024 * 1024;
function pieceSize(up) {
  if (!up.maxChunk) return up.chunk; // older servers: fixed 8 MB pieces
  // After a failure, small pieces until one gets through: a retry on a flaky link mustn't re-send a whole big piece
  // each time, and a server still busy with an earlier piece (409) is only probed (it reads and drops the body).
  if (up.busyTries) return 256 * 1024;
  if (up.failures) return Math.min(up.chunk, up.chunkCap || Infinity, 8 * 1024 * 1024);
  const bySpeed = up.rate > 0 ? up.rate * PIECE_SECS : 0;
  return Math.max(256 * 1024, Math.min(up.maxChunk, up.chunkCap || Infinity, Math.max(PIECE_MIN, Math.round(bySpeed))));
}
// Something on the way refused or kept cutting pieces of this size: smaller from now on.
function shrinkPieces(up) {
  up.chunk = Math.max(256 * 1024, Math.floor(up.chunk / 2));
  up.chunkCap = up.chunk;
}
const STALL_MS = 30000;
const RETRY_DELAYS = [1, 2, 4, 8, 15, 30];
let runningBig = 0;
let runningSmall = 0;
const localPreviews = new Map(); // item id -> object URL of an image this page sent (no need to download it back)
const LOCAL_PREVIEWS_MAX = 20;  // each keeps its whole file in memory: the newest few are enough
function releasePreview(id) {
  const u = localPreviews.get(id);
  if (!u) return;
  URL.revokeObjectURL(u);
  localPreviews.delete(id);
}

function enqueueUpload(file, conv, opts = {}) {
  const up = {
    id: randomId(6), file, name: opts.name || file.name || 'file', size: file.size, mime: file.type || '',
    conv, to: targetsOf(conv), state: opts.prepare ? 'preparing' : 'queued', uploadId: opts.resume?.uploadId || null,
    offset: 0, chunk: 8 * 1024 * 1024, failures: 0, busyTries: 0, restarts: 0, samples: [], rate: 0,
    batch: opts.batch || null, prepare: opts.prepare || null, persist: opts.persist !== false && file instanceof File && !opts.prepare,
  };
  up.batchHidden = Boolean(up.batch);
  const shell = pendingShell('up', up.name);
  Object.assign(up, { node: shell.node, statusEl: shell.status, bar: shell.bar, buttonsEl: shell.buttons });
  uploads.set(up.id, up);
  if (up.batch) up.batch.members.add(up);
  up.done = new Promise(resolve => { up.resolve = resolve; });
  patchUpload(up);
  if (up.prepare) prepareUpload(up); else pumpUploads();
  return up;
}

async function prepareUpload(up) {
  try {
    const file = await up.prepare(pct => { up.preparePct = pct; patchUpload(up); });
    if (up.cancelled) return;
    if (!file) { dropUpload(up); up.resolve(false); return; }
    up.file = file;
    up.size = file.size;
    up.mime = file.type || 'application/zip';
    up.state = 'queued';
    patchUpload(up);
    pumpUploads();
  } catch (err) {
    up.state = 'failed';
    up.error = err.message || 'Couldn’t prepare the file';
    patchUpload(up);
  }
}

function pumpUploads() {
  for (const up of uploads.values()) {
    if (up.state !== 'queued') continue;
    const big = up.size >= BIG_FILE;
    if (big ? runningBig >= 1 : runningSmall >= 3) continue;
    if (big) runningBig++; else runningSmall++;
    up.lane = big ? 'big' : 'small';
    up.state = 'starting';
    runUpload(up).then(ok => up.resolve(ok)).finally(() => {
      if (up.lane === 'big') runningBig--; else runningSmall--;
      up.lane = null;
      pumpUploads();
    });
  }
  updateBeforeUnload();
}

async function runUpload(up) {
  for (;;) {
    try {
      await uploadSteps(up);
      return true;
    } catch (err) {
      if (up.cancelled || err.cancelled) { cleanupCancelled(up); return false; }
      if (err.paused) { await waitResume(up); continue; }
      const action = await classifyUploadError(up, err);
      if (action === 'now') continue;
      if (action === 'done') return true;
      if (action === 'fatal') {
        up.state = 'failed';
        up.error = up.error || friendlyError(err);
        patchUpload(up);
        if (up.batch) batchChanged(up.batch);
        return false;
      }
      // 'retry': wait (interruptible), then find out where the server is and carry on
      await backoff(up);
      if (up.cancelled) { cleanupCancelled(up); return false; }
    }
  }
}

async function uploadSteps(up) {
  if (!up.uploadId) {
    up.state = 'starting';
    patchUpload(up);
    // Photos get a small preview and their size up front (API v3), so receivers never download the original
    // just to show it and the thread doesn't jump when it loads.
    if (up.thumb === undefined) up.thumb = serverHas('thumbnails') ? await makeThumb(up.file).catch(() => null) : null;
    const dims = up.thumb ? { w: up.thumb.w, h: up.thumb.h } : {};
    const init = await apiJson('api/uploads', jsonBody({ name: up.name, size: up.size, mime: up.mime, to: up.to, ...dims }));
    up.uploadId = init.id;
    up.offset = init.offset || 0;
    if (serverHas('big-chunks') && init.maxChunkSize > 0) up.maxChunk = init.maxChunkSize;
    else if (init.chunkSize) up.chunk = Math.min(up.chunk, init.chunkSize);
    rememberUpload(up);
  } else if (up.needsResync) {
    const info = await apiJson(`api/uploads/${up.uploadId}`, { timeout: 20000 }).catch(async err => {
      if (err.status === 404) {
        // Finished while we weren't looking (the final answer got lost)?
        const item = await apiJson(`api/items/${up.uploadId}`).catch(() => null);
        if (item) throw Object.assign(new Error('done'), { finishedItem: item });
      }
      throw err;
    });
    up.offset = info.offset;
    if (serverHas('big-chunks') && info.maxChunkSize > 0) up.maxChunk = info.maxChunkSize;
  }
  up.needsResync = false;
  up.startedAt = performance.now();
  for (;;) {
    if (up.cancelled) throw { cancelled: true };
    if (up.paused) throw { paused: true };
    if (!navigator.onLine) throw Object.assign(new Error('offline'), { offline: true });
    up.state = 'running';
    patchUpload(up);
    const res = await putChunk(up);
    up.failures = 0;
    up.busyTries = 0;
    if (net.state !== 'online') net.ok();
    if (res.done) { await finishUpload(up, res.item); return; }
    up.offset = res.offset;
  }
}

function putChunk(up) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    up.xhr = xhr;
    up.chunk = pieceSize(up);
    const end = Math.min(up.size, up.offset + up.chunk);
    const offset = up.offset;
    xhr.open('PUT', url(`api/uploads/${up.uploadId}?offset=${offset}`));
    for (const [k, v] of Object.entries(idHeaders())) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    const startedAt = Date.now();
    let last = startedAt;
    let stalled = false;
    const watchdog = setInterval(() => {
      if (Date.now() - last > STALL_MS) { stalled = true; xhr.abort(); }
    }, 2000);
    const done = () => { clearInterval(watchdog); up.xhr = null; };
    xhr.upload.onprogress = e => { last = Date.now(); onUploadProgress(up, offset + e.loaded); };
    xhr.onload = () => {
      done();
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body);
      reject(Object.assign(new Error(body.error || `HTTP ${xhr.status}`), { status: xhr.status, body }));
    };
    xhr.onerror = () => { done(); reject(Object.assign(new Error('connection lost'), { network: true, ranMs: Date.now() - startedAt })); };
    xhr.onabort = () => {
      done();
      if (stalled) reject(Object.assign(new Error('stalled'), { network: true, stall: true }));
      else if (up.paused) reject({ paused: true });
      else reject({ cancelled: true });
    };
    xhr.send(up.file.slice(offset, end));
  });
}

async function classifyUploadError(up, err) {
  if (err.finishedItem) { await finishUpload(up, err.finishedItem); return 'done'; }
  const status = err.status;
  if (status === 401) { onUnauthorized('upload', err.body?.serverId); up.status = 'Waiting for sign-in…'; return 'retry'; }
  if (status === 410) { onMoved(err.body?.movedTo); up.error = 'Beam has moved. Send it again from the new address.'; return 'fatal'; }
  if (status === 409 && typeof err.body?.offset === 'number') {
    if (err.body.offset !== up.offset && up.busyTries < 5) { up.offset = err.body.offset; up.busyTries++; return 'now'; }
    // The server is still writing an earlier request for this upload (after a dropped connection): wait.
    up.busyTries++;
    up.status = 'The server is finishing the previous piece…';
    return 'retry';
  }
  if (status === 404) {
    const item = await apiJson(`api/items/${up.uploadId}`).catch(() => null);
    if (item) { await finishUpload(up, item); return 'done'; }
    if (up.restarts++ < 2) { up.uploadId = null; up.offset = 0; forgetUpload(up); return 'now'; }
    up.error = 'The server lost this upload. Try again.';
    return 'fatal';
  }
  if (status === 413) {
    if (up.chunk > 256 * 1024 && up.uploadId) { shrinkPieces(up); up.needsResync = true; return 'now'; }
    up.error = friendlyStatus(413, err.body?.error);
    return 'fatal';
  }
  if (status === 507) { up.error = friendlyStatus(507); return 'fatal'; }
  if (status && status < 500 && status !== 429 && status !== 408) { up.error = friendlyStatus(status, err.body?.error); return 'fatal'; }
  // Network trouble, 5xx, timeouts, a stall: retry for as long as it takes. When the same piece keeps failing,
  // send smaller pieces: that gets past proxies that cut big requests off (413 or a reset) and loses less on a
  // flaky link.
  up.failures++;
  if (up.failOffset === up.offset) up.sameFailures = (up.sameFailures || 0) + 1;
  else { up.failOffset = up.offset; up.sameFailures = 1; }
  if (up.sameFailures >= 2 && up.chunk > 256 * 1024 && up.uploadId && navigator.onLine) {
    shrinkPieces(up);
    // A big piece cut off on its way: the smaller one goes without the usual pause. Not a request refused at once
    // (a busy server answers and closes before the body is read, which often arrives as a reset): those back off.
    if (!(err.ranMs < 500)) up.failures = Math.max(0, up.failures - 1);
  }
  up.status = err.stall ? 'The connection stalled' : !navigator.onLine ? 'Waiting for a connection' : 'Connection problem';
  if (err.network || err.offline || status >= 502) net.fail({ status, error: err });
  return 'retry';
}

function backoff(up) {
  const secs = navigator.onLine ? RETRY_DELAYS[Math.min(up.failures + up.busyTries - 1, RETRY_DELAYS.length - 1)] || 1 : 0;
  up.state = navigator.onLine ? 'retrying' : 'waiting';
  up.retryAt = secs ? Date.now() + secs * 1000 : 0;
  up.needsResync = Boolean(up.uploadId);
  patchUpload(up);
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); clearInterval(countdown); window.removeEventListener('online', onOnline); up.wake = null; up.retryAt = 0; resolve(); };
    const onOnline = () => setTimeout(finish, 500);
    const timer = secs ? setTimeout(finish, secs * 1000) : null;
    const countdown = setInterval(() => patchUpload(up), 1000);
    window.addEventListener('online', onOnline);
    up.wake = finish; // Retry now / Cancel / Pause
  });
}

function waitResume(up) {
  up.state = 'paused';
  patchUpload(up);
  return new Promise(resolve => { up.wake = () => { up.wake = null; resolve(); }; });
}

function pauseUpload(up) {
  up.paused = true;
  up.xhr?.abort();
  up.wake?.();
  patchUpload(up);
}
function resumeUpload(up) {
  up.paused = false;
  up.needsResync = Boolean(up.uploadId);
  up.wake?.();
  patchUpload(up);
}
function retryUpload(up) {
  if (up.state === 'failed') {
    up.error = '';
    up.failures = 0;
    up.busyTries = 0;
    up.needsResync = Boolean(up.uploadId);
    up.state = 'queued';
    up.done = new Promise(resolve => { up.resolve = resolve; });
    patchUpload(up);
    pumpUploads();
  } else up.wake?.();
}
function cancelUpload(up) {
  up.cancelled = true;
  up.xhr?.abort();
  up.wake?.();
  if (up.state === 'queued' || up.state === 'failed' || up.state === 'preparing') { cleanupCancelled(up); up.resolve(false); }
}

function cleanupCancelled(up) {
  if (up.uploadId) api(`api/uploads/${up.uploadId}`, { method: 'DELETE' }).catch(() => {});
  forgetUpload(up);
  dropUpload(up);
}

function dropUpload(up) {
  uploads.delete(up.id);
  up.node.remove();
  view.nodes.delete(`up:${up.id}`);
  if (up.batch) { up.batch.members.delete(up); batchChanged(up.batch); }
  refreshPending();
  updateBeforeUnload();
}

async function finishUpload(up, item) {
  up.state = 'done';
  forgetUpload(up);
  if (up.file && /^image\//.test(up.mime) && up.size <= 50 * 1024 * 1024 && item?.id) {
    localPreviews.set(item.id, URL.createObjectURL(up.file));
    if (localPreviews.size > LOCAL_PREVIEWS_MAX) releasePreview(localPreviews.keys().next().value);
  }
  if (up.batch) { up.batch.done++; up.batch.bytesDone += up.size; }
  dropUpload(up);
  acceptOwnItem(item);
  if (up.thumb && item?.id) sendThumb(item.id, up.thumb);
}

// Progress and speed (smoothed over the last few seconds).
function onUploadProgress(up, sent) {
  const now = performance.now();
  up.sent = sent;
  up.samples.push([now, sent]);
  while (up.samples.length > 2 && now - up.samples[0][0] > 4000) up.samples.shift();
  const [t0, b0] = up.samples[0];
  if (now - t0 > 500) up.rate = (sent - b0) / ((now - t0) / 1000);
  if (up.batch) batchProgress(up.batch);
  if (!up.batchHidden && (!up.lastPaint || now - up.lastPaint > 200)) { up.lastPaint = now; patchUpload(up); }
}

function patchUpload(up) {
  if (up.batchHidden && up.state !== 'failed') { if (up.batch) batchProgress(up.batch); return; }
  if (up.batchHidden && up.state === 'failed') { up.batchHidden = false; refreshPending(); }
  const sent = up.sent ?? up.offset;
  setProgress(up.bar, sent, up.size || 1);
  up.node.classList.toggle('failed', up.state === 'failed');
  up.node.classList.toggle('paused', up.state === 'paused');
  let line;
  switch (up.state) {
    case 'preparing': line = `Preparing… ${Math.round((up.preparePct || 0) * 100)}%`; break;
    case 'queued': line = `${formatSize(up.size)} · waiting…`; break;
    case 'starting': line = `${formatSize(up.size)} · starting…`; break;
    case 'running': line = transferLine(sent, up.size, up.rate, up.rate > 0 ? (up.size - sent) / up.rate : -1); break;
    case 'paused': line = `Paused · ${formatSize(sent)} of ${formatSize(up.size)}`; break;
    case 'waiting': line = `Waiting for a connection · ${formatSize(sent)} of ${formatSize(up.size)}`; break;
    case 'retrying': {
      const secs = up.retryAt ? Math.max(0, Math.ceil((up.retryAt - Date.now()) / 1000)) : 0;
      line = `${up.status || 'Connection problem'} · retrying${secs ? ` in ${secs} s` : '…'}`;
      break;
    }
    case 'failed': line = up.error || 'Couldn’t send it'; break;
    default: line = '';
  }
  up.statusEl.textContent = line;
  const btns = [];
  if (up.state === 'retrying') btns.push(mini('refresh', 'Retry now', () => retryUpload(up)));
  if (up.state === 'failed') btns.push(mini('refresh', 'Try again', () => retryUpload(up)));
  if (up.state === 'running' || up.state === 'retrying' || up.state === 'waiting') {
    if (up.size > 8 * 1024 * 1024) btns.push(mini('pause', 'Pause', () => pauseUpload(up)));
  }
  if (up.state === 'paused') btns.push(mini('play', 'Resume', () => resumeUpload(up)));
  btns.push(mini('x', up.state === 'failed' ? 'Remove' : 'Cancel', () => cancelUpload(up)));
  up.buttonsEl.replaceChildren(...btns);
}

// ---------------------------------------------------------------- many files at once: one summary card

function newBatch(conv, files) {
  const b = { id: randomId(4), conv, total: files.length, done: 0, bytes: files.reduce((n, f) => n + f.size, 0), bytesDone: 0, members: new Set(), visible: true };
  const shell = pendingShell('up', '');
  shell.node.classList.add('batch');
  Object.assign(b, { node: shell.node, statusEl: shell.status, bar: shell.bar, buttonsEl: shell.buttons, nameEl: shell.node.querySelector('.fname') });
  batches.set(b.id, b);
  // buttons and numbers are filled in once its files are queued (batchChanged)
  return b;
}

function batchProgress(b) {
  const now = performance.now();
  if (b.lastPaint && now - b.lastPaint < 250) return;
  b.lastPaint = now;
  let running = 0;
  let rate = 0;
  for (const up of b.members) { running += up.sent ?? 0; rate += up.state === 'running' ? up.rate : 0; }
  const sent = b.bytesDone + running;
  setProgress(b.bar, sent, b.bytes || 1);
  const failed = [...b.members].filter(u => u.state === 'failed').length;
  b.nameEl.textContent = `Sending ${Math.min(b.done + 1, b.total).toLocaleString()} of ${plural(b.total, 'file')}`;
  b.statusEl.textContent = `${transferLine(sent, b.bytes, rate, rate > 0 ? (b.bytes - sent) / rate : -1)}${failed ? ` · ${failed} failed` : ''}`;
}

function batchChanged(b) {
  const left = [...b.members].filter(u => u.state !== 'failed');
  if (!left.length) {
    batches.delete(b.id);
    b.node.remove();
    view.nodes.delete(`batch:${b.id}`);
    refreshPending();
    return;
  }
  const paused = left.every(u => u.paused);
  b.buttonsEl.replaceChildren(
    paused ? mini('play', 'Resume all', () => left.forEach(resumeUpload)) : mini('pause', 'Pause all', () => left.forEach(pauseUpload)),
    mini('x', 'Cancel all', async () => {
      if (await confirmDialog({ title: 'Cancel sending?', text: `${plural(left.length, 'file')} haven’t been sent yet.`, confirm: 'Cancel them', cancel: 'Keep sending', danger: true })) left.forEach(cancelUpload);
    }));
  b.lastPaint = 0;
  batchProgress(b);
}

// ---------------------------------------------------------------- resume after a reload (the File is gone; ask for it again)

let resumeRecords = [];
function loadResumeRecords() {
  const day = Date.now() - 23 * 3600e3; // the server drops idle uploads after 24 h
  resumeRecords = store.json('beam.uploads', []).filter(r => r.deviceId === me.id && r.created > day && !uploadsByServerId(r.uploadId));
}
const uploadsByServerId = id => [...uploads.values()].find(u => u.uploadId === id);
const saveResumeRecords = () => store.setJson('beam.uploads', [...resumeRecords, ...liveRecords.values()]);
const liveRecords = new Map(); // upload id -> record for uploads running now

function rememberUpload(up) {
  if (!up.persist || !up.uploadId) return;
  liveRecords.set(up.uploadId, { uploadId: up.uploadId, name: up.name, size: up.size, lastModified: up.file.lastModified || 0, conv: up.conv, to: up.to, created: Date.now(), deviceId: me.id });
  saveResumeRecords();
}
function forgetUpload(up) {
  if (!up.uploadId) return;
  liveRecords.delete(up.uploadId);
  resumeRecords = resumeRecords.filter(r => r.uploadId !== up.uploadId);
  saveResumeRecords();
}

// After sign-in: which unfinished uploads still exist on the server?
async function checkResumeRecords() {
  if (HOST) return;
  loadResumeRecords();
  const alive = [];
  for (const r of resumeRecords) {
    try {
      const info = await apiJson(`api/uploads/${r.uploadId}`);
      alive.push({ ...r, offset: info.offset });
    } catch (err) {
      if (!err.status) alive.push(r); // offline: keep it for later
    }
  }
  resumeRecords = alive;
  saveResumeRecords();
  if (alive.length) refreshPending();
}

function makeResumeRow(r) {
  const shell = pendingShell('up', r.name);
  shell.node.classList.add('paused');
  setProgress(shell.bar, r.offset || 0, r.size || 1);
  shell.status.textContent = `${r.offset ? `${Math.round((r.offset / r.size) * 100)}% sent. ` : ''}Choose the file again to finish sending it.`;
  shell.buttons.append(
    el('button', { class: 'btn small-btn', type: 'button', onclick: () => pickResumeFile(r) }, 'Choose file…'),
    mini('x', 'Discard', () => {
      api(`api/uploads/${r.uploadId}`, { method: 'DELETE' }).catch(() => {});
      resumeRecords = resumeRecords.filter(x => x !== r);
      saveResumeRecords();
      removePendingRow(`resume:${r.uploadId}`);
    }));
  return shell.node;
}

function pickResumeFile(r) {
  const input = $('#resumeInput');
  input.value = '';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    if (file.name !== r.name || file.size !== r.size) {
      toast(`That’s a different file. Choose ${r.name} (${formatSize(r.size)}).`, { error: true, ms: 5000 });
      return;
    }
    resumeRecords = resumeRecords.filter(x => x !== r);
    saveResumeRecords();
    removePendingRow(`resume:${r.uploadId}`);
    const up = enqueueUpload(file, r.conv, { resume: r });
    up.needsResync = true;
    refreshPending();
  };
  input.click();
}

// Leaving the page while uploads run cancels them: ask first.
function updateBeforeUnload() {
  const busy = [...uploads.values()].some(u => !['failed', 'done'].includes(u.state));
  window.onbeforeunload = busy ? e => { e.preventDefault(); e.returnValue = ''; return ''; } : null;
}

// ---------------------------------------------------------------- the front door for files

async function sendFiles(fileList, conv = current, { fromDrop = null } = {}) {
  let files = [...fileList].filter(Boolean);
  if (!files.length && !(fromDrop && fromDrop.folders.length)) return;
  if (!await ensureSendable(conv)) return toast('That device was removed from Beam.', { error: true });
  if (HOST) {
    const r = await hostDo('sendFiles', { to: targetsOf(conv) }, fromDrop ? fromDrop.raw : files);
    if (r) toast(conv === current ? `Sending ${plural(r.count ?? files.length, 'file')}…` : `Sending to ${convName(conv)}`);
    return;
  }
  const folders = fromDrop ? fromDrop.folders : [];
  const tooBig = files.filter(f => f.size > server.maxUpload);
  if (tooBig.length) {
    toast(`${tooBig[0].name} is ${formatSize(tooBig[0].size)}. This Beam accepts files up to ${formatSize(server.maxUpload)}.${tooBig.length > 1 ? ` (${tooBig.length} files are too big.)` : ''}`, { error: true, ms: 6000 });
    files = files.filter(f => f.size <= server.maxUpload);
  }
  for (const folder of folders) sendFolder(folder, conv);
  if (!files.length) return;
  if (files.length > 100 || files.length > server.maxItems / 4) {
    const choice = await manyFilesDialog(files.length, conv);
    if (!choice) return;
    if (choice === 'zip') { sendFolder({ name: `Beam files ${stamp()}`, entries: files.map(f => ({ file: f, path: f.name })) }, conv); return; }
  }
  if (net.state === 'offline' && files.every(f => f.size <= OUTBOX_FILE_MAX)) {
    for (const f of files) queueFile(f, conv);
    return;
  }
  const batch = files.length > 3 ? newBatch(conv, files) : null;
  for (const f of files) enqueueUpload(f, conv, { batch });
  if (batch) batchChanged(batch);
  refreshPending();
  if (conv === current) scrollToBottom();
  else toast(files.length === 1 ? `Sending to ${convName(conv)}` : `Sending ${plural(files.length, 'file')} to ${convName(conv)}`);
}

function manyFilesDialog(count, conv) {
  return new Promise(resolve => {
    let choice = null;
    const zip = el('button', { class: 'btn primary', type: 'button', onclick: () => { choice = 'zip'; dlg.close(); } }, 'Send as one .zip');
    const each = el('button', { class: 'btn', type: 'button', onclick: () => { choice = 'each'; dlg.close(); } }, 'Send separately');
    const cancel = el('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, 'Cancel');
    const dlg = openDialog({
      title: `Send ${count.toLocaleString()} files?`,
      body: el('p', {}, `Beam keeps up to ${server.maxItems.toLocaleString()} items, so sending them one by one to ${convName(conv)} could push older items out. As one .zip they stay together.`),
      buttons: [cancel, each, zip],
      onClose: () => resolve(choice),
    });
    zip.focus();
  });
}

// ---------------------------------------------------------------- folders: read a dropped folder, zip it (store), send the .zip

async function entriesFromDrop(dt) {
  const files = [];
  const folders = [];
  const raw = [];
  const handles = [];
  for (const item of [...dt.items]) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    const file = item.getAsFile();
    if (file) raw.push(file);
    handles.push({ entry, file });
  }
  for (const { entry, file } of handles) {
    if (entry && entry.isDirectory) folders.push({ name: entry.name, entry });
    else if (file) files.push(file);
  }
  return { files, folders, raw };
}

function readDirectory(dirEntry) {
  const out = [];
  const walk = (dir, prefix) => new Promise((resolve, reject) => {
    const reader = dir.createReader();
    const batch = () => reader.readEntries(async entries => {
      if (!entries.length) return resolve();
      try {
        for (const e of entries) {
          if (e.isDirectory) { out.push({ dir: true, path: `${prefix}${e.name}/` }); await walk(e, `${prefix}${e.name}/`); }
          else out.push({ file: await new Promise((res, rej) => e.file(res, rej)), path: `${prefix}${e.name}` });
        }
        batch();
      } catch (err) { reject(err); }
    }, reject);
    batch();
  });
  return walk(dirEntry, `${dirEntry.name}/`).then(() => out);
}

function sendFolder(folder, conv) {
  const name = `${folder.name}.zip`;
  enqueueUpload(new File([], name, { type: 'application/zip' }), conv, {
    name,
    persist: false,
    prepare: async progress => {
      const entries = folder.entries || await readDirectory(folder.entry);
      const files = entries.filter(e => !e.dir);
      if (!files.length) { toast(`The folder “${folder.name}” is empty.`); return null; }
      const total = files.reduce((n, e) => n + e.file.size, 0);
      if (total > 3.9 * 1024 ** 3 || entries.length > 65000) throw new Error(`“${folder.name}” is too big to zip in the browser. Zip it yourself, then send the .zip.`);
      const blob = await zipStore(entries, progress);
      return new File([blob], name, { type: 'application/zip' });
    },
  });
  refreshPending();
  if (conv === current) scrollToBottom();
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

async function crc32OfFile(file, onBytes) {
  let crc = 0xffffffff;
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (let i = 0; i < value.length; i++) crc = CRC_TABLE[(crc ^ value[i]) & 0xff] ^ (crc >>> 8);
    onBytes(value.length);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// A ZIP with every file stored (not compressed): no memory use beyond the headers, since the Blob only
// references the files. Up to 4 GB / 65,000 entries (no ZIP64).
async function zipStore(entries, progress) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const total = entries.reduce((n, e) => n + (e.file ? e.file.size : 0), 0) || 1;
  let hashed = 0;
  for (const e of entries) {
    const name = enc.encode(e.path);
    const date = new Date(e.file?.lastModified || Date.now());
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dosDate = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const size = e.file ? e.file.size : 0;
    const crc = e.file ? await crc32OfFile(e.file, n => { hashed += n; progress(hashed / total); }) : 0;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name);
    if (e.file) parts.push(e.file);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(38, e.dir ? 0x10 : 0, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  progress(1);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

// ---------------------------------------------------------------- thumbnails (API v3): the sender makes a small preview

let thumbsUnsupported = false;
async function makeThumb(file) {
  if (thumbsUnsupported || typeof OffscreenCanvas === 'undefined') return null;
  let source;
  let w;
  let h;
  if (/^image\/(jpeg|png|webp|gif|bmp|avif)$/.test(file.type) && file.size <= 40 * 1024 * 1024) {
    source = await createImageBitmap(file);
    w = source.width;
    h = source.height;
  } else if (/^video\/(mp4|webm|quicktime|ogg)$/.test(file.type)) {
    ({ source, w, h } = await videoFrame(file));
    if (!source) return null;
  } else return null;
  const scale = Math.min(1, 320 / Math.max(w, h));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  for (const quality of [0.82, 0.65, 0.5]) {
    let blob = await canvas.convertToBlob({ type: 'image/webp', quality });
    if (blob.type !== 'image/webp') blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    if (blob.size <= 256 * 1024) return { blob, w, h };
  }
  return null;
}

// A frame from a second into the video (or 10%), for its poster; gives up after 5 s.
function videoFrame(file) {
  return new Promise(resolve => {
    const src = URL.createObjectURL(file);
    const video = el('video', { muted: true, preload: 'metadata', playsinline: true });
    const done = result => { clearTimeout(timer); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(src); resolve(result); };
    const timer = setTimeout(() => done({}), 5000);
    video.addEventListener('loadedmetadata', () => { video.currentTime = Math.min(1, (video.duration || 10) * 0.1); }, { once: true });
    video.addEventListener('seeked', async () => {
      try { done({ source: await createImageBitmap(video), w: video.videoWidth, h: video.videoHeight }); } catch { done({}); }
    }, { once: true });
    video.addEventListener('error', () => done({}), { once: true });
    video.src = src;
  });
}

async function sendThumb(itemId, thumbPromise) {
  const t = await thumbPromise;
  if (!t || thumbsUnsupported) return;
  try {
    await api(`api/items/${itemId}/thumb?w=${t.w}&h=${t.h}`, { method: 'PUT', headers: { 'Content-Type': t.blob.type }, body: t.blob });
  } catch (err) {
    if (err.status === 404 || err.status === 405) thumbsUnsupported = true;
  }
}

// ---------------------------------------------------------------- paste

// Pasted screenshots arrive as "image.png"; give them a name you can tell apart later.
function namePasted(file) {
  if (file.name && !/^image\.\w+$/i.test(file.name)) return file;
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\+.*$/, '');
  return new File([file], `pasted-${stamp()}.${ext}`, { type: file.type });
}

const signedIn = () => paired && !$('#app').hidden;

// Ctrl+V anywhere: text into the message box pastes as usual; everything else gets a preview to confirm first,
// so a stray Ctrl+V can't send your clipboard (a password…) by itself.
function onPaste(event) {
  if (!signedIn()) return;
  const openDlg = document.querySelector('dialog[open]');
  if (openDlg) return; // dialogs paste normally
  const data = event.clipboardData;
  if (!data) return;
  const target = event.target;
  const composer = $('#text');
  const inComposer = target === composer;
  const inField = target.closest?.('textarea, input, [contenteditable="true"]');
  const text = data.getData('text/plain');
  const files = [...data.files];
  const onlyImages = files.length > 0 && files.every(f => /^image\//.test(f.type));
  if (text.trim() && (!files.length || onlyImages)) {
    // Office apps put a picture of the selection next to the text: the text wins.
    if (inField) {
      if (inComposer && files.length) toast('Pasted as text', { action: 'Send the picture instead', onAction: () => confirmPaste({ files: files.map(namePasted) }) });
      return;
    }
    event.preventDefault();
    confirmPaste({ text });
    return;
  }
  if (files.length) {
    if (inField && !inComposer) return;
    event.preventDefault();
    confirmPaste({ files: files.map(namePasted) });
  }
}

async function confirmPaste({ text, files }) {
  let conv = await targetConv(text ? 'Pasted text' : 'Pasted files');
  if (!conv) return;
  if (!await ensureSendable(conv)) return toast('That device was removed from Beam.', { error: true });
  const urls = [];
  const body = [];
  if (text) {
    body.push(el('pre', { class: 'paste-preview' }, text.length > 4000 ? `${text.slice(0, 4000)}…` : text));
    body.push(el('p', { class: 'muted small' }, `${plural(text.length, 'character')}`));
  } else {
    const list = el('div', { class: 'paste-files' });
    for (const f of files.slice(0, 12)) {
      if (/^image\//.test(f.type)) {
        const u = URL.createObjectURL(f);
        urls.push(u);
        list.append(el('figure', {}, el('img', { src: u, alt: '' }), el('figcaption', {}, `${f.name} · ${formatSize(f.size)}`)));
      } else list.append(el('div', { class: 'fname' }, `${f.name} · ${formatSize(f.size)}`));
    }
    if (files.length > 12) list.append(el('div', { class: 'muted small' }, `and ${files.length - 12} more`));
    body.push(list);
  }
  const send = el('button', { class: 'btn primary', type: 'button' }, `Send to ${convName(conv)}`);
  const buttons = [el('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, 'Cancel')];
  if (text) buttons.push(el('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); openConv(conv); const box = $('#text'); box.setRangeText(text, box.selectionStart, box.selectionEnd, 'end'); onComposerInput(); box.focus(); } }, 'Put in message box'));
  buttons.push(send);
  const dlg = openDialog({ title: 'Send what you pasted?', body, buttons, onClose: () => urls.forEach(u => URL.revokeObjectURL(u)) });
  send.addEventListener('click', async () => {
    dlg.close();
    if (text) {
      try {
        const item = await sendText(text, conv);
        if (item) toast(`Sent to ${convName(conv)}`, { action: 'Undo', onAction: () => deleteItems([item.id], { undo: false }) });
      } catch (err) { toast(friendlyError(err), { error: true }); }
    } else if (HOST) {
      const r = await hostDo('sendClipboard', { to: targetsOf(conv) });
      if (r) toast(`Sending ${r.description || 'your clipboard'}…`);
    } else sendFiles(files, conv);
  });
  send.focus();
}

// The paste button / Ctrl+Shift+V: send the clipboard now (text wins over an image of it, like Office).
async function pasteAndSend() {
  const conv = await targetConv('Your clipboard');
  if (!conv) return;
  if (!await ensureSendable(conv)) return toast('That device was removed from Beam.', { error: true });
  if (HOST) {
    const r = await hostDo('sendClipboard', { to: targetsOf(conv) });
    if (r) toast(`Sending ${r.description || 'your clipboard'} to ${convName(conv)}`);
    return;
  }
  try {
    let text = '';
    let image = null;
    if (navigator.clipboard.read) {
      for (const entry of await navigator.clipboard.read()) {
        if (entry.types.includes('text/plain')) text = text || await (await entry.getType('text/plain')).text();
        const type = entry.types.find(t => t.startsWith('image/'));
        if (type && !image) image = namePasted(new File([await entry.getType(type)], 'image.png', { type }));
      }
    } else text = await navigator.clipboard.readText();
    if (text.trim()) {
      const item = await sendText(text, conv);
      if (item) toast(`Sent to ${convName(conv)}`, { action: 'Undo', onAction: () => deleteItems([item.id], { undo: false }) });
    } else if (image) sendFiles([image], conv);
    else toast('Your clipboard is empty');
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
      toast('Clipboard access was blocked. Paste into the message box instead.', { ms: 4000 });
      $('#text').focus();
    } else toast(friendlyError(err), { error: true });
  }
}

// Where should something go when there's no open thread (phone list view)?
async function targetConv(what) {
  if (!NARROW.matches || $('#app').classList.contains('in-thread')) return current;
  return chooseConv(what);
}

// Never offers a choice before the device list is known (a cold start would show "All devices" alone, one quick tap
// from sending to everything). Once rows are shown they keep their places: newcomers go at the end, and taps are
// ignored for a moment after the rows appear or change, so a tap meant for the loading state can't land on a row.
const CHOOSER_SETTLE_MS = 400;
let chooserGen = 0;
function chooseConv(what, { exclude = [], title = 'Send to…' } = {}) {
  const dlg = $('#chooseDlg');
  const box = $('#chooseList');
  const gen = ++chooserGen;
  if (dlg.open) dlg.close(); // a chooser already showing gives way (it picks nothing)
  $('#chooseTitle').textContent = title;
  $('#chooseWhat').textContent = what;
  return new Promise(resolve => {
    let picked = null;
    let settleUntil = 0;
    let opening = true; // rows shown right away (devices already known) need no settling
    const rows = new Map(); // conv -> row, in the order first shown
    const pick = conv => {
      if (performance.now() < settleUntil || !canSendTo(conv)) return;
      picked = conv;
      dlg.close();
    };
    const fill = () => {
      if (gen !== chooserGen) return; // replaced by a newer chooser
      if (!devicesKnown) {
        box.replaceChildren(devicesLoadingRow());
        box.setAttribute('aria-busy', 'true');
        opening = false;
        return;
      }
      box.removeAttribute('aria-busy');
      const order = conversationOrder().filter(c => canSendTo(c) && !exclude.includes(c));
      const keep = new Set(order);
      let changed = !rows.size;
      for (const [conv, row] of rows) if (!keep.has(conv)) { rows.delete(conv); changed = true; }
      for (const conv of order) {
        if (!rows.has(conv)) { rows.set(conv, makeRow(conv, pick)); changed = true; }
        patchRow(rows.get(conv), conv, { active: false });
      }
      const nodes = [...rows.values()].map(r => r.li);
      if (changed || box.children.length !== nodes.length || nodes.some((n, i) => box.children[i] !== n)) {
        box.replaceChildren(...nodes);
        if (!opening) settleUntil = performance.now() + CHOOSER_SETTLE_MS;
      }
      opening = false;
    };
    devicePickers.add(fill);
    fill();
    // The browser fires `close` a moment after close(): the replaced chooser's event must not end this one.
    const onClose = () => {
      if (gen === chooserGen && dlg.open) return;
      dlg.removeEventListener('close', onClose);
      devicePickers.delete(fill);
      resolve(gen === chooserGen ? picked : null);
    };
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

// ---------------------------------------------------------------- drag and drop

const dragHas = (e, type) => [...(e.dataTransfer?.types || [])].includes(type);
const hasFiles = e => dragHas(e, 'Files');
let internalDrag = false; // text dragged around inside the page (a selection) must never be sent by accident
const hasText = e => !internalDrag && !hasFiles(e) && (dragHas(e, 'text/uri-list') || dragHas(e, 'text/plain')) && !dragHas(e, 'application/x-beam-item');
const hasBeamItem = e => dragHas(e, 'application/x-beam-item');
// The Windows app's own drag of a file out of the chat (bindDragOut) comes back to the page as a file drag: it must
// never count as a file dropped here (1.7.1: it was sent straight back). It ends when the app says so (dragOutDone,
// from Beam for Windows 1.7.1 on), or after 10 minutes in case that never comes.
let ownDragOut = 0;
const ownDrag = () => ownDragOut > 0 && Date.now() - ownDragOut < 10 * 60e3;
function ownDragEnded() { ownDragOut = 0; }

function bindDropTarget(node, conv) {
  node.addEventListener('dragover', e => {
    if (ownDrag()) return; // (the window's handler below says "no drop here")
    if (!(hasFiles(e) || hasText(e) || hasBeamItem(e)) || !canSendTo(conv)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    node.classList.add('drop-target');
    $('#dropLabel').textContent = hasBeamItem(e) ? `Drop to forward to ${convName(conv)}` : `Drop to send to ${convName(conv)}`;
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
  node.addEventListener('drop', e => {
    if (ownDrag() || !canSendTo(conv)) return;
    e.preventDefault();
    e.stopPropagation();
    endDrag();
    handleDrop(e.dataTransfer, conv);
  });
}

let dragDepth = 0;
function endDrag() {
  dragDepth = 0;
  $('#drop').classList.remove('show');
  $$('.drop-target').forEach(n => n.classList.remove('drop-target'));
}

async function handleDrop(dt, conv) {
  if (!signedIn()) return;
  const beamItem = dt.getData('application/x-beam-item');
  if (beamItem) { const item = itemMap.get(beamItem); if (item && conv !== current) forwardItem(item, [conv]); return; }
  if ([...dt.types].includes('Files')) {
    const drop = await entriesFromDrop(dt);
    const target = conv || await targetConv(`${plural(drop.files.length + drop.folders.length, 'item')}`);
    if (target) sendFiles(drop.files, target, { fromDrop: drop });
    return;
  }
  const text = (dt.getData('text/uri-list').split(/\r?\n/).find(l => l && !l.startsWith('#')) || dt.getData('text/plain') || '').trim();
  if (!text) return;
  const target = conv || await targetConv('Dropped text');
  if (!target || !canSendTo(target)) return;
  try {
    const item = await sendText(text, target);
    if (item) toast(`Sent to ${convName(target)}`, { action: 'Undo', onAction: () => deleteItems([item.id], { undo: false }) });
  } catch (err) { toast(friendlyError(err), { error: true }); }
}

function bindDragAndDrop() {
  window.addEventListener('dragstart', () => { internalDrag = true; }, true);
  window.addEventListener('dragend', () => { internalDrag = false; }, true);
  window.addEventListener('dragenter', e => {
    if (!hasFiles(e) || !signedIn()) return;
    e.preventDefault();
    if (ownDrag()) return; // the app's own drag out of the chat: no "Drop to send"
    dragDepth++;
    $('#drop').classList.add('show');
  });
  window.addEventListener('dragover', e => {
    // Always swallow file drags: otherwise the browser (or WebView2) would open the file instead of Beam.
    if (hasFiles(e)) e.preventDefault();
    if (ownDrag()) { if (hasFiles(e)) e.dataTransfer.dropEffect = 'none'; return; }
    if (!signedIn()) return;
    if (hasText(e) && e.target.closest?.('#thread')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
    if (hasFiles(e) && !e.target.closest?.('.conv')) {
      $('#dropLabel').textContent = NARROW.matches && !$('#app').classList.contains('in-thread') ? 'Drop to send' : `Drop to send to ${convName(current)}`;
    }
  });
  window.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) endDrag();
  });
  window.addEventListener('drop', e => {
    if (hasFiles(e)) e.preventDefault();
    if (ownDrag() && hasFiles(e)) { endDrag(); return; } // dropped back on the chat: nothing to send
    if (!signedIn()) { endDrag(); internalDrag = false; return; }
    if (hasFiles(e)) {
      endDrag();
      const inThread = !NARROW.matches || $('#app').classList.contains('in-thread');
      handleDrop(e.dataTransfer, inThread && canSendTo(current) ? current : null);
    } else if (hasText(e) && e.target.closest?.('#thread')) {
      e.preventDefault();
      handleDrop(e.dataTransfer, canSendTo(current) ? current : null);
    }
  });
  window.addEventListener('dragend', endDrag);
}

// Drag a received file out of the page: Chrome/Edge download it where it's dropped; the Windows app starts a
// native drag of the saved file. A file picked with others (1.12) takes all the picked files along in the Windows app
// (a browser drags one file at a time).
function bindDragOut(node, item) {
  node.setAttribute('draggable', 'true');
  node.addEventListener('dragstart', e => {
    if (HOST) {
      if (hostHas('dragOut')) {
        e.preventDefault();
        const several = pick.on && pick.ids.has(item.id) && hostHas('dragOutMany') ? pickedFiles() : [];
        const files = several.length > 1 ? several : [item];
        if (hostHas('dragOutDone')) ownDragOut = Date.now();
        hostCall('dragOut', files.length > 1 ? { itemIds: files.map(f => f.id) } : { itemId: item.id }).then(r => {
          // While this PC is being controlled from another device the app copies the file instead (a drag froze it).
          if (r?.copied) {
            ownDragEnded();
            toast(`Copied. Paste ${files.length > 1 ? 'them' : 'it'} where you want ${files.length > 1 ? 'them' : 'it'} (Ctrl+V): files can’t be dragged out of Beam while this PC is being controlled.`, { ms: 8000 });
          }
        }).catch(err => {
          ownDragEnded();
          const missing = files.filter(f => !isSaved(f.id));
          const save = () => (missing.length ? missing : files).forEach(f => hostDo('saveFile', { itemId: f.id }));
          if (err.code === 'not-saved') toast(files.length > 1 ? `Save them first (${missing.length === 1 ? 'one isn’t' : `${missing.length || 'some'} aren’t`} on this PC yet), then drag them.` : 'Save the file first, then drag it.', { action: 'Save', onAction: save });
          else if (err.code === 'clipboard') toast('Couldn’t copy it. Try again.', { error: true });
        });
      }
      return;
    }
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('DownloadURL', `${item.mime || 'application/octet-stream'}:${item.name.replace(/:/g, '_')}:${fileUrl(item)}`);
    e.dataTransfer.setData('application/x-beam-item', item.id);
  });
}
