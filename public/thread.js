'use strict';
// Rendering: sidebar, thread header and the thread. Nothing on screen is rebuilt: sidebar rows and messages are
// keyed and patched in place, so a text selection, an expanded message or a playing video survive new items,
// receipts and reconnects. Only switching conversations starts a thread from scratch.

// Messages rendered when a conversation opens, and how many more each step up adds (they load by themselves as you
// scroll up). Laying out 150 at once took most of the time it took to open a conversation.
const WINDOW = 60;
const WINDOW_STEP = 120;
const PREVIEW_IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon)$/;
const PREVIEW_VIDEO = /^video\/(mp4|webm|quicktime|ogg)$/;
const TEXTLIKE = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|x-sh|x-httpd-php|sql|toml)$)|\.(txt|md|log|csv|tsv|json|xml|ya?ml|ini|conf|cfg|toml|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|kt|cs|c|h|cpp|hpp|sh|ps1|bat|cmd|sql|html?|css|scss|env|gitignore|properties)$/i;
const autoPreviewMax = () => (navigator.connection?.saveData ? 2 : 16) * 1024 * 1024;

const view = {
  conv: null,
  nodes: new Map(),     // key -> element: "m:<id>" messages, "d:<day>" day separators, pending rows
  start: 0,             // first rendered index into the conversation's items
  pinnedOnly: false,
  expanded: new Set(),  // item ids with "Show more" open (survives re-renders and conversation switches)
  fullText: new Map(),  // item id -> full text fetched for truncated items
  pinnedBottom: true,   // is the thread scrolled to the bottom?
  newCount: 0,
  highlight: null,
  filled: false,        // has this thread shown any messages yet (until then it starts at the newest WINDOW)
};
const acked = new Set();
const forcedPreviews = new Set(); // big photos the user asked to preview anyway

const threadVisible = () => !document.hidden && !$('#app').hidden && !phonePanelOpen() && (!NARROW.matches || $('#app').classList.contains('in-thread'));
const threadItems = () => (view.pinnedOnly ? itemsIn(current).filter(i => i.pinned) : itemsIn(current));

// ---------------------------------------------------------------- hidden pages render nothing

// A hidden page draws nothing, so it renders nothing either (the Windows app's window is hidden most of the time):
// what changes meanwhile is rendered in one go when it's shown again. Only the tab title keeps counting.
const hiddenWork = { all: false, patch: new Set(), replace: new Set(), incoming: false, reveal: null, newHere: 0 };
const renderingPaused = () => document.hidden;

function resumeRendering() {
  if (document.hidden) return;
  const work = { ...hiddenWork };
  Object.assign(hiddenWork, { all: false, patch: new Set(), replace: new Set(), incoming: false, reveal: null, newHere: 0 });
  for (const id of work.replace) { const item = itemMap.get(id); if (item) replaceMsg(item); }
  for (const id of work.patch) { const item = itemMap.get(id); if (item) patchMsg(item); }
  if (work.all) renderAll();
  if (work.incoming) for (const inc of incoming.values()) patchIncoming(inc);
  if (work.newHere && !view.pinnedBottom) showNewPill(work.newHere);
  if (work.reveal) revealItem(work.reveal);
}

// After a forced sign-out nothing of the history stays on the page either (hidden behind the sign-in page, it was
// still there): messages, conversation rows, fetched full texts, previews of sent photos, sends in flight.
function clearRendered() {
  $('#thread').replaceChildren();
  view.nodes.clear();
  view.conv = null;
  view.filled = false;
  view.expanded.clear();
  view.fullText.clear();
  for (const row of rows.values()) row.li.remove();
  rows.clear();
  sidebarLoading?.remove();
  sidebarLoading = null;
  $('#threadName').textContent = '';
  $('#threadSub').replaceChildren();
  $('#text').value = '';
  incoming.clear();
  sending.clear();
  acked.clear();
  for (const id of [...localPreviews.keys()]) releasePreview(id);
  clearPhoneRendered();
  Object.assign(hiddenWork, { all: false, patch: new Set(), replace: new Set(), incoming: false, reveal: null, newHere: 0 });
  document.title = 'Beam';
}

function showNewPill(count) {
  view.newCount += count;
  $('#newPillText').textContent = view.newCount === 1 ? '1 new message' : `${view.newCount} new messages`;
  $('#newPill').hidden = false;
}

// ---------------------------------------------------------------- avatars

function avatar(conv, { big = false } = {}) {
  if (conv === 'all') return el('span', { class: `avatar all${big ? ' big' : ''}` }, icon('all'));
  const d = deviceById(conv);
  const removed = !d;
  return el('span', { class: `avatar${removed ? ' removed' : ''}${big ? ' big' : ''}` },
    icon(removed ? 'ghost' : PLATFORM_ICON[d.platform] || 'globe'),
    !removed && el('span', { class: `dot${d.online ? ' on' : ''}`, title: d.online ? 'Online' : 'Offline' }));
}

// ---------------------------------------------------------------- sidebar (keyed rows, patched in place)

const rows = new Map(); // conv -> { li, button, av, name, time, preview, badge }

function makeRow(conv, onPick) {
  const name = el('span', { class: 'conv-name' });
  const time = el('span', { class: 'conv-time' });
  const preview = el('span', { class: 'conv-preview' });
  const badge = el('span', { class: 'badge', hidden: true });
  const av = el('span', { class: 'av-slot' });
  const button = el('button', { class: 'conv', type: 'button', 'data-conv': conv },
    av, el('span', { class: 'conv-body' }, el('span', { class: 'conv-top' }, name, time), el('span', { class: 'conv-bottom' }, preview, badge)));
  button.addEventListener('click', () => onPick(conv));
  bindDropTarget(button, conv);
  return { li: el('li', {}, button), button, av, name, time, preview, badge, avKey: '' };
}

function preview(item) {
  if (!item) return '';
  const who = item.from === me.id ? 'You: ' : '';
  if (item.kind === 'text') return who + item.text.replace(/\s+/g, ' ').slice(0, 90);
  return `${who}${/^image\//.test(item.mime || '') ? 'Photo' : /^video\//.test(item.mime || '') ? 'Video' : 'File'} · ${item.name}`;
}

function patchRow(row, conv, { active }) {
  const list = itemsIn(conv);
  const last = list.at(-1);
  const d = deviceById(conv);
  const count = unread(conv);
  const avKey = conv === 'all' ? 'all' : d ? `${d.platform}:${d.online}` : 'removed';
  if (row.avKey !== avKey) { row.av.replaceChildren(avatar(conv)); row.avKey = avKey; }
  const name = convName(conv);
  if (row.name.textContent !== name) row.name.textContent = name;
  const time = last ? shortWhen(last.ts) : '';
  if (row.time.textContent !== time) row.time.textContent = time;
  const sub = last ? preview(last) : conv === 'all' ? 'Send to every device' : !d ? 'Removed device' : d.online ? 'Online' : `Last seen ${timeAgo(d.lastSeen)}`;
  if (row.preview.textContent !== sub) row.preview.textContent = sub;
  row.badge.hidden = count === 0;
  if (count) {
    row.badge.textContent = count > 99 ? '99+' : String(count);
    row.badge.setAttribute('aria-label', `${count} unread`);
  }
  row.button.classList.toggle('active', Boolean(active));
  row.button.classList.toggle('removed', !d && conv !== 'all');
  row.button.classList.toggle('unread', count > 0);
  if (active) row.button.setAttribute('aria-current', 'true'); else row.button.removeAttribute('aria-current');
}

let sidebarLoading = null; // the "Loading your devices…" row
function renderSidebar() {
  if (renderingPaused()) { hiddenWork.all = true; updateTitle(); return; }
  const list = $('#convList');
  const order = conversationOrder();
  const keep = new Set(order);
  for (const [conv, row] of rows) if (!keep.has(conv)) { row.li.remove(); rows.delete(conv); }
  let cursor = list.firstElementChild;
  for (const conv of order) {
    let row = rows.get(conv);
    if (!row) { row = makeRow(conv, c => openConv(c)); rows.set(conv, row); }
    patchRow(row, conv, { active: conv === current && !phonePanelOpen() });
    if (row.li === cursor) cursor = cursor.nextElementSibling;
    else list.insertBefore(row.li, cursor);
    if (conv === 'all') cursor = placePhoneRow(list, cursor); // pinned under All devices
  }
  // First start with nothing saved: say the devices are on their way instead of showing "All devices" alone.
  if (devicesKnown) { sidebarLoading?.remove(); sidebarLoading = null; }
  else {
    const fresh = devicesLoadingRow();
    if (sidebarLoading?.textContent !== fresh.textContent) { sidebarLoading?.remove(); sidebarLoading = fresh; }
    if (list.lastElementChild !== sidebarLoading) list.append(sidebarLoading);
  }
  updateTitle();
}

function updateTitle() {
  const total = totalUnread();
  const title = total ? `(${total}) Beam` : 'Beam';
  if (document.title !== title) document.title = title;
}

// ---------------------------------------------------------------- header

function renderHeader() {
  if (renderingPaused()) { hiddenWork.all = true; return; }
  if (phonePanelOpen()) { renderPhoneHeader(); return; }
  const d = deviceById(current);
  const slot = $('#threadAvatar');
  const fresh = Object.assign(avatar(current), { id: 'threadAvatar' });
  if (slot.outerHTML !== fresh.outerHTML) slot.replaceWith(fresh);
  $('#threadName').textContent = convName(current);
  // The info line: online / last seen · battery · free storage · Beam version · system (whatever the device reports).
  const sub = $('#threadSub');
  if (d) sub.replaceChildren(...factNodes(deviceFacts(d)));
  else sub.textContent = current === 'all' ? 'Sent to every device' : devicesKnown ? 'Removed device · its history is kept' : '';
  sub.title = d ? deviceFacts(d, { long: true }).map(f => f.title ? `${f.title}: ${f.text}` : f.text).join('\n') : '';
  const pinned = itemsIn(current).filter(i => i.pinned).length;
  $('#pinnedBtn').hidden = !pinned && !view.pinnedOnly;
  $('#pinnedCount').textContent = pinned ? String(pinned) : '';
  $('#pinnedBtn').setAttribute('aria-pressed', String(view.pinnedOnly));
  $('#pinnedBtn').setAttribute('aria-label', view.pinnedOnly ? 'Show all messages' : `Show pinned messages (${pinned})`);
  $('#pinnedBtn').title = view.pinnedOnly ? 'Show all messages' : 'Show pinned messages';
  renderComposerState();
}

function renderComposerState() {
  const box = $('#text');
  const sendable = canSendTo(current) || !devicesKnown; // until the list is known, nothing counts as removed
  box.disabled = !sendable;
  $('#attachBtn').disabled = !sendable;
  $('#pasteBtn').disabled = !sendable;
  box.placeholder = !sendable ? 'This device was removed from Beam' : current === 'all' ? 'Message all devices…' : `Message ${convName(current)}…`;
  const note = $('#composerNote');
  note.hidden = sendable;
  if (!sendable) note.textContent = 'This device was removed from Beam. Its history stays here; it comes back if it connects again.';
  $('#sendBtn').disabled = !sendable || !box.value.trim();
}

// ---------------------------------------------------------------- opening conversations

function openConv(conv, { push = true, focus = true } = {}) {
  closePhone();
  if (devicesKnown && conv !== 'all' && !deviceById(conv) && !itemsIn(conv).length) conv = 'all';
  const changed = conv !== view.conv;
  if (changed && view.conv !== null) saveComposerDraft(view.conv);
  current = conv;
  store.set('beam.conv', conv);
  if (changed) {
    view.pinnedOnly = false;
    resetThread();
    loadComposerDraft(conv);
    closeThreadSearch();
  }
  renderHeader();
  renderThread({ scroll: changed ? 'bottom' : 'keep' });
  renderSidebar();
  if (NARROW.matches && !$('#app').classList.contains('in-thread')) {
    $('#app').classList.add('in-thread');
    if (push) history.pushState({ conv }, '');
    renderSidebar();
  }
  hostViewing();
  if (focus && FINE_POINTER.matches && !$('#text').disabled && !document.querySelector('dialog[open]')) $('#text').focus({ preventScroll: true });
  checkRead();
}

function showList() {
  $('#app').classList.remove('in-thread');
  renderSidebar();
  hostViewing();
}

// ---------------------------------------------------------------- the thread

function resetThread() {
  const box = $('#thread');
  box.replaceChildren();
  view.nodes.clear();
  view.filled = false;
  view.conv = current;
  const n = threadItems().length;
  view.start = Math.max(0, n - WINDOW);
  view.pinnedBottom = true;
  view.newCount = 0;
  $('#newPill').hidden = true;
}

const atBottom = box => box.scrollHeight - box.scrollTop - box.clientHeight < 80;

function scrollToBottom(smooth = false) {
  const box = $('#thread');
  box.scrollTo({ top: box.scrollHeight, behavior: smooth && !REDUCED_MOTION.matches ? 'smooth' : 'auto' });
  view.pinnedBottom = true;
  view.newCount = 0;
  $('#newPill').hidden = true;
}

// The first message visible at the top, and where it is, so content added above can't move what you're reading.
function captureAnchor(box) {
  const top = box.getBoundingClientRect().top;
  for (const node of box.children) {
    if (!node.classList.contains('msg')) continue;
    const r = node.getBoundingClientRect();
    if (r.bottom > top) return { node, top: r.top };
  }
  return null;
}
function restoreAnchor(anchor) {
  if (!anchor || !anchor.node.isConnected) return;
  const delta = anchor.node.getBoundingClientRect().top - anchor.top;
  if (Math.abs(delta) > 0.5) $('#thread').scrollTop += delta;
}

function renderThread({ scroll = 'keep' } = {}) {
  if (renderingPaused()) { hiddenWork.all = true; return; }
  if (phonePanelOpen()) return;
  const box = $('#thread');
  if (view.conv !== current) resetThread();
  const list = threadItems();
  // A thread that opened before its history arrived (a first start) still starts with the newest WINDOW messages.
  if (!view.filled) view.start = Math.max(0, list.length - WINDOW);
  view.filled = list.length > 0;
  view.start = clamp(view.start, 0, Math.max(0, list.length - 1));
  if (list.length <= WINDOW) view.start = 0;
  const wasBottom = view.pinnedBottom || atBottom(box);
  const anchor = scroll === 'keep' && !wasBottom ? captureAnchor(box) : null;
  const desired = [];
  if (view.start > 0) desired.push({ key: 'older', make: makeOlder });
  let lastDay = '';
  for (let i = view.start; i < list.length; i++) {
    const item = list[i];
    const day = dayKey(item.ts);
    if (day !== lastDay) { desired.push({ key: `d:${day}`, make: () => el('div', { class: 'day', role: 'separator' }, dayLabel(item.ts)) }); lastDay = day; }
    desired.push({ key: `m:${item.id}`, make: () => buildMsg(item) });
  }
  const pending = pendingRowsFor(current);
  desired.push(...pending);
  if (!list.length && !pending.length) desired.push({ key: 'empty', make: makeEmpty });
  reconcile(box, desired);
  const older = view.nodes.get('older');
  if (older) older.querySelector('span').textContent = `${plural(view.start, 'earlier message')}`;
  if (scroll === 'bottom' || (scroll === 'keep' && wasBottom)) scrollToBottom();
  else if (anchor) restoreAnchor(anchor);
  scheduleCheckRead();
}

// Insert missing nodes and drop unwanted ones without touching the rest (a selection inside them survives).
function reconcile(box, desired) {
  const keys = new Set(desired.map(d => d.key));
  for (const child of [...box.children]) {
    const key = child.dataset.key;
    if (!keys.has(key)) {
      child.remove();
      if (view.nodes.get(key) === child) view.nodes.delete(key);
    }
  }
  let cursor = box.firstElementChild;
  for (const d of desired) {
    let node = view.nodes.get(d.key);
    if (!node) {
      node = d.make();
      node.dataset.key = d.key;
      view.nodes.set(d.key, node);
    }
    if (node === cursor) { cursor = cursor.nextElementSibling; continue; }
    box.insertBefore(node, cursor);
  }
}

function makeOlder() {
  const btn = el('button', { class: 'older', type: 'button' }, icon('up'), el('span', {}, 'Earlier messages'));
  btn.addEventListener('click', loadOlder);
  olderObserver.observe(btn);
  return btn;
}

const olderObserver = new IntersectionObserver(entries => {
  if (entries.some(e => e.isIntersecting) && $('#thread').scrollTop < 400) loadOlder();
}, { root: null, rootMargin: '200px 0px 0px 0px' });

function loadOlder() {
  if (view.start <= 0) return;
  const box = $('#thread');
  const anchor = captureAnchor(box);
  view.start = Math.max(0, view.start - WINDOW_STEP);
  box.setAttribute('aria-busy', 'true');
  renderThread({ scroll: 'none' });
  restoreAnchor(anchor);
  box.removeAttribute('aria-busy');
}

function makeEmpty() {
  const sendable = canSendTo(current);
  return el('div', { class: 'thread-empty' },
    el('strong', {}, view.pinnedOnly ? 'No pinned messages' : current === 'all' ? 'Send to every device' : `Nothing with ${convName(current)} yet`),
    view.pinnedOnly ? 'Pin a message from its menu to keep it here (and past the retention period).'
      : !sendable ? '' : FINE_POINTER.matches ? 'Type a message, paste with Ctrl+V, or drop files here.' : 'Type a message or tap the paperclip to send files.');
}

// ---------------------------------------------------------------- messages

// Links in received text become clickable; the text itself stays plain (no HTML is ever interpreted).
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+[^\s<>"'.,;:!?)\]}]/gi;
function linkify(node, text) {
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    if (match.index > last) node.append(text.slice(last, match.index));
    const href = match[0].startsWith('www.') ? `https://${match[0]}` : match[0];
    node.append(el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, match[0]));
    last = match.index + match[0].length;
  }
  if (last < text.length) node.append(text.slice(last));
  return node;
}

function tick(item) {
  const others = devices.filter(d => d.id !== me.id);
  const targets = item.to.length ? item.to : others.map(d => d.id);
  const got = Object.keys(item.delivered || {}).filter(id => id !== me.id);
  if (!got.length) return el('span', { class: 'tick', title: 'Waiting for the other device to pick it up' }, icon('check'), 'Sent');
  const names = got.map(id => nameOf(id));
  const label = item.to.length === 1 ? 'Delivered'
    : got.length >= targets.length ? 'Delivered to all'
      : `Delivered to ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''}`;
  const detail = got.map(id => `${nameOf(id)}: ${fullWhen(item.delivered[id])}`).join('\n');
  return el('span', { class: 'tick done', title: detail }, icon('check'), label);
}

function senderLine(item) {
  const mine = item.from === me.id;
  if (!mine && current === 'all') return senderName(item);
  if (current !== 'all' && item.to.length === 0) return mine ? 'To all devices' : `${senderName(item)} · to all devices`;
  if (mine && item.to.length > 1) return `Also to ${item.to.filter(t => t !== current).map(nameOf).join(', ')}`;
  return '';
}

function buildMsg(item) {
  const mine = item.from === me.id;
  const node = el('div', { class: `msg ${mine ? 'mine' : 'theirs'}`, 'data-id': item.id, tabindex: '-1', role: 'group' });
  const who = senderLine(item);
  node.append(el('div', { class: 'sender' }, who));
  let bubble;
  if (item.kind === 'text') {
    const text = view.fullText.get(item.id) || item.text;
    const body = linkify(el('div', { class: 'text' }), text);
    bubble = el('div', { class: 'bubble' }, body);
    if (text.length > 700 || text.split('\n').length > 12) {
      const open = view.expanded.has(item.id);
      body.classList.toggle('clamp', !open);
      const more = el('button', { class: 'more', type: 'button', 'aria-expanded': String(open) }, open ? 'Show less' : 'Show more');
      more.addEventListener('click', () => {
        const nowOpen = body.classList.toggle('clamp') === false;
        nowOpen ? view.expanded.add(item.id) : view.expanded.delete(item.id);
        more.textContent = nowOpen ? 'Show less' : 'Show more';
        more.setAttribute('aria-expanded', String(nowOpen));
      });
      bubble.append(more);
    }
    if (item.truncated && !view.fullText.has(item.id)) {
      const btn = el('button', { class: 'more', type: 'button' }, `Show all ${item.textLength.toLocaleString()} characters`);
      btn.addEventListener('click', () => loadFullText(item));
      bubble.append(el('div', { class: 'fsize trunc' }, btn));
    }
  } else {
    bubble = el('div', { class: 'bubble file' });
    const media = buildMedia(item);
    if (media) bubble.append(media);
    const row = el('div', { class: 'file-row' },
      el('div', { class: 'ext', 'aria-hidden': 'true' }, extOf(item.name)),
      el('div', { class: 'file-info' }, el('div', { class: 'fname' }, item.name), el('div', { class: 'fsize' }, formatSize(item.size))));
    bindDragOut(row, item);
    bubble.append(row);
    bubble.addEventListener('dblclick', e => {
      if (HOST && !e.target.closest('a, button, video, audio')) { getSelection().removeAllRanges(); hostDo('openFile', { itemId: item.id }); }
    });
  }
  node.setAttribute('aria-label', `${mine ? 'You' : senderName(item)}, ${clock(item.ts)}`);
  const meta = el('div', { class: 'meta' });
  fillMeta(meta, item);
  node.append(bubble, meta);
  return node;
}

async function loadFullText(item) {
  try {
    const text = await (await api(`api/items/${item.id}/text`)).text();
    view.fullText.set(item.id, text);
    replaceMsg(item);
  } catch (err) {
    toast(friendlyError(err), { error: true });
  }
}

// Rebuild one message (only on explicit user actions: expanding the full text, loading a preview).
function replaceMsg(item) {
  if (renderingPaused()) { hiddenWork.replace.add(item.id); return; }
  const key = `m:${item.id}`;
  const old = view.nodes.get(key);
  if (!old) return;
  const fresh = buildMsg(item);
  fresh.dataset.key = key;
  old.replaceWith(fresh);
  view.nodes.set(key, fresh);
}

function fitDims(w, h, maxW = 320, maxH = 320) {
  if (!(w > 0 && h > 0)) return null;
  const scale = Math.min(1, maxW / w, maxH / h);
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

const thumbUrl = item => url(`api/items/${item.id}/thumb${typeof item.thumb === 'string' ? `?v=${encodeURIComponent(item.thumb)}` : ''}`);
const fileUrl = (item, inline = false) => url(`api/file/${item.id}${inline ? '?inline' : ''}`);
const hasThumb = item => Boolean(item.thumb);
const mediaDims = item => fitDims(item.w || item.width || item.thumb?.w, item.h || item.height || item.thumb?.h);

function buildMedia(item) {
  const mime = item.mime || '';
  const dims = mediaDims(item);
  if (PREVIEW_IMAGE.test(mime)) {
    // Big photos without a thumbnail aren't downloaded just to show a preview (phones, metered links).
    if (!hasThumb(item) && item.size > autoPreviewMax() && !forcedPreviews.has(item.id)) {
      const btn = el('button', { class: 'preview placeholder', type: 'button' }, icon('image'), el('span', {}, `Photo · ${formatSize(item.size)} · Show preview`));
      btn.addEventListener('click', () => { forcedPreviews.add(item.id); replaceMsg(item); });
      return btn;
    }
    const img = el('img', { alt: item.name, loading: 'lazy', decoding: 'async', draggable: 'true' });
    if (dims) { img.width = dims.w; img.height = dims.h; } else img.classList.add('unsized');
    img.src = hasThumb(item) ? thumbUrl(item) : fileUrl(item, true);
    img.addEventListener('load', () => { img.classList.remove('unsized'); if (view.pinnedBottom) scrollToBottom(); }, { once: true });
    img.addEventListener('error', () => { if (hasThumb(item) && !img.dataset.fallback) { img.dataset.fallback = '1'; img.src = fileUrl(item, true); } }, { once: false });
    const box = el('button', { class: 'preview', type: 'button', 'aria-label': `Open ${item.name}` }, img);
    box.addEventListener('click', () => openLightbox(item));
    bindDragOut(img, item);
    return box;
  }
  if (PREVIEW_VIDEO.test(mime)) {
    const video = el('video', { controls: true, preload: 'none', playsinline: true, src: fileUrl(item, true) });
    if (hasThumb(item)) video.poster = thumbUrl(item);
    const wrap = el('div', { class: 'preview video' }, video);
    if (dims) { wrap.style.aspectRatio = `${dims.w} / ${dims.h}`; wrap.style.width = `${dims.w}px`; }
    return wrap;
  }
  if (/^audio\//.test(mime)) return el('audio', { controls: true, preload: 'none', src: fileUrl(item, true) });
  if (TEXTLIKE.test(mime) || TEXTLIKE.test(item.name || '')) {
    const btn = el('button', { class: 'btn ghost small-btn text-peek', type: 'button' }, icon('eye'), 'Preview');
    btn.addEventListener('click', () => previewTextFile(item));
    return btn;
  }
  return null;
}

// Time, pin, delivery tick and the quick actions. Rebuilt on receipts/pins; it can't hold a text selection.
function fillMeta(meta, item) {
  const mine = item.from === me.id;
  const parts = [el('span', { class: 'when', title: fullWhen(item.ts) }, clock(item.ts))];
  if (item.pinned) parts.push(el('span', { class: 'pinned-mark', title: 'Pinned' }, icon('pin'), 'Pinned'));
  if (mine) parts.push(item.sending ? el('span', { class: 'tick', title: 'Sending…' }, icon('clock')) : tick(item));
  if (!item.sending) parts.push(el('span', { class: 'actions' }, ...quickActions(item)));
  meta.replaceChildren(...parts);
}

function quickActions(item) {
  const acts = [];
  if (item.kind === 'text') {
    acts.push(mini('copy', 'Copy', () => copyItem(item), { class: 'mini hover-only' }));
  } else if (HOST) {
    if (isSaved(item.id)) {
      acts.push(mini('open', 'Open', () => hostDo('openFile', { itemId: item.id })));
      acts.push(mini('folder', 'Show in folder', () => hostDo('revealFile', { itemId: item.id }), { class: 'mini hover-only' }));
    } else {
      acts.push(mini('download', 'Save', () => hostDo('saveFile', { itemId: item.id })));
    }
  } else {
    acts.push(el('a', { class: 'mini', href: fileUrl(item), download: item.name, title: 'Download', 'aria-label': `Download ${item.name}` }, icon('download')));
  }
  acts.push(mini('more', 'More', e => openItemMenu(item, e.currentTarget), { class: 'mini hover-only', 'aria-haspopup': 'menu' }));
  return acts;
}

function patchMsg(item) {
  const node = view.nodes.get(`m:${item.id}`);
  if (!node) return;
  if (renderingPaused()) { hiddenWork.patch.add(item.id); return; }
  fillMeta(node.querySelector('.meta'), item);
  const who = senderLine(item);
  const sender = node.querySelector('.sender');
  if (sender.textContent !== who) sender.textContent = who;
}

function patchFileActions(itemId) {
  const item = itemMap.get(itemId);
  if (item) patchMsg(item);
}
function patchAllFileActions() {
  for (const [key] of view.nodes) if (key.startsWith('m:')) { const item = itemMap.get(key.slice(2)); if (item && item.kind === 'file') patchMsg(item); }
}

// Scroll to an item (loading earlier messages if needed) and flash it.
function revealItem(itemId, { highlight = true } = {}) {
  if (renderingPaused()) { hiddenWork.reveal = itemId; return true; }
  const list = threadItems();
  const i = list.findIndex(x => x.id === itemId);
  if (i < 0) return false;
  if (i < view.start) { view.start = Math.max(0, i - 20); renderThread({ scroll: 'none' }); }
  const node = view.nodes.get(`m:${itemId}`);
  if (!node) return false;
  node.scrollIntoView({ block: 'center', behavior: REDUCED_MOTION.matches ? 'auto' : 'smooth' });
  view.pinnedBottom = atBottom($('#thread'));
  if (highlight) {
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 2400);
  }
  return true;
}

// ---------------------------------------------------------------- new items, deletions, receipts

function onItemAdded(item, { fromMe = false, quiet = false } = {}) {
  const inThread = convsOf(item).includes(current) && (!view.pinnedOnly || item.pinned);
  if (renderingPaused()) {
    if (inThread && !fromMe && isForMe(item)) hiddenWork.newHere++;
    hiddenWork.all = true;
    updateTitle();
    return;
  }
  if (inThread) {
    const box = $('#thread');
    const bottom = view.pinnedBottom || atBottom(box);
    renderThread({ scroll: fromMe || bottom ? 'bottom' : 'keep' });
    const node = view.nodes.get(`m:${item.id}`);
    if (node && !quiet && !REDUCED_MOTION.matches) {
      node.classList.add('enter');
      node.addEventListener('animationend', () => node.classList.remove('enter'), { once: true });
    }
    if (!fromMe && !bottom && isForMe(item)) showNewPill(1);
  }
  renderSidebar();
  if (item.pinned || convsOf(item).includes(current)) renderHeader();
}

function onItemRemoved(id) {
  const key = `m:${id}`;
  if (view.nodes.has(key)) renderThread({ scroll: 'keep' });
  view.expanded.delete(id);
  view.fullText.delete(id);
  renderSidebar();
  renderHeader();
}

// ---------------------------------------------------------------- read state and delivery receipts

let readCheckQueued = false;
function scheduleCheckRead() {
  if (readCheckQueued) return;
  readCheckQueued = true;
  requestAnimationFrame(() => { readCheckQueued = false; checkRead(); });
}

// What's actually on screen counts as read: everything when scrolled to the bottom, otherwise up to the last
// visible message. The web app acknowledges items once they've been seen ("Delivered").
function checkRead() {
  if (!threadVisible() || $('#app').hidden) return;
  const box = $('#thread');
  const list = itemsIn(current);
  if (!list.length) return;
  let upto = 0;
  if (!view.pinnedOnly && atBottom(box)) upto = list.at(-1).ts;
  else {
    const bottom = box.getBoundingClientRect().bottom;
    const msgs = [...box.children].filter(n => n.classList.contains('msg'));
    for (let i = msgs.length - 1; i >= 0; i--) {
      const r = msgs[i].getBoundingClientRect();
      if (r.top < bottom - 24) { upto = itemMap.get(msgs[i].dataset.id)?.ts || 0; break; }
    }
  }
  if (upto && markConvRead(current, upto)) renderSidebar();
  if (!HOST) ackSeen(list, upto);
}

let acksInFlight = 0;
function ackSeen(list, upto) {
  for (const item of list) {
    if (acksInFlight >= 6) { setTimeout(scheduleCheckRead, 500); break; }
    if (item.ts > upto || !isForMe(item) || item.delivered[me.id] || acked.has(item.id)) continue;
    acked.add(item.id);
    acksInFlight++;
    api(`api/items/${item.id}/ack`, { method: 'POST' })
      .catch(err => { if (!err.status) acked.delete(item.id); })
      .finally(() => { acksInFlight--; });
  }
}

// ---------------------------------------------------------------- pending rows (uploads, outbox, native transfers)

// Everything that isn't an item yet but belongs in a conversation, as keyed rows after the messages.
function pendingRowsFor(conv) {
  const out = [];
  for (const s of sending.values()) if (s.conv === conv) out.push({ key: `sending:${s.id}`, make: () => buildMsg(s.item) });
  for (const r of resumeRecords) if (r.conv === conv) out.push({ key: `resume:${r.uploadId}`, make: () => makeResumeRow(r) });
  for (const entry of outbox.values()) if (entry.conv === conv) out.push({ key: `out:${entry.id}`, make: () => entry.node || makeOutboxRow(entry) });
  for (const b of batches.values()) if (b.conv === conv && b.visible) out.push({ key: `batch:${b.id}`, make: () => b.node });
  for (const up of uploads.values()) if (up.conv === conv && !up.batchHidden) out.push({ key: `up:${up.id}`, make: () => up.node });
  for (const t of hostState.transfers.values()) if ((t.conversations || []).includes(conv)) out.push({ key: `tr:${t.id}`, make: () => makeTransferRow(t) });
  for (const inc of incoming.values()) if (inc.convs.includes(conv)) out.push({ key: `in:${inc.id}`, make: () => makeIncomingRow(inc) });
  return out;
}

function refreshPending() {
  if (view.conv === current) renderThread({ scroll: 'keep' });
}

function removePendingRow(key) {
  const node = view.nodes.get(key);
  if (node) { node.remove(); view.nodes.delete(key); }
  refreshPending();
}

function pendingShell(kind, name, extra = {}) {
  const status = el('div', { class: 'fsize status-line' });
  const bar = el('i');
  const buttons = el('span', { class: 'actions always' });
  const node = el('div', { class: `msg ${kind === 'down' || kind === 'in' ? 'theirs' : 'mine'} pending`, ...extra },
    el('div', { class: 'bubble file' },
      el('div', { class: 'file-row' }, el('div', { class: 'ext', 'aria-hidden': 'true' }, icon(kind === 'down' || kind === 'in' ? 'download' : kind === 'text' ? 'clock' : 'upload')),
        el('div', { class: 'file-info' }, el('div', { class: 'fname' }, name), status)),
      el('div', { class: 'progress' }, bar)),
    el('div', { class: 'meta' }, buttons));
  return { node, status, bar, buttons };
}

function setProgress(bar, done, total) {
  const pct = total > 0 ? clamp(Math.round((done / total) * 100), 0, 100) : 0;
  bar.style.width = `${pct}%`;
  return pct;
}

function transferLine(done, size, rate, eta) {
  const parts = [`${formatSize(done)} of ${formatSize(size)}`];
  if (rate > 0) parts.push(`${formatSize(Math.round(rate))}/s`);
  if (eta > 0) parts.push(`${formatDuration(eta)} left`);
  return parts.join(' · ');
}

// Native (Windows app) transfers: HOST-BRIDGE.md → Transfer.
const transferNodes = new Map();
function makeTransferRow(t) {
  const kind = t.kind === 'download' ? 'down' : 'up';
  const shell = pendingShell(kind, t.name || 'file');
  shell.node.classList.add('transfer');
  transferNodes.set(t.id, shell);
  patchTransferRow(shell, t);
  return shell.node;
}

function patchTransferRow(shell, t) {
  const running = t.state === 'running';
  setProgress(shell.bar, t.done || 0, t.size || 0);
  shell.node.classList.toggle('failed', t.state === 'failed');
  const verb = t.kind === 'download' ? (t.auto ? 'Saving' : 'Downloading') : 'Sending';
  let line;
  if (t.state === 'queued') line = t.status || `${verb} · waiting… · ${formatSize(t.size)}`;
  else if (t.state === 'retrying' || t.state === 'failed') line = t.status || (t.state === 'failed' ? 'Failed' : 'Retrying…');
  else if (t.state === 'done') line = t.kind === 'download' ? 'Saved' : 'Sent';
  else if (t.state === 'cancelled') line = 'Cancelled';
  else line = transferLine(t.done || 0, t.size || 0, running ? t.rate : 0, running ? t.eta : -1);
  shell.status.textContent = line;
  const btns = [];
  if (t.canCancel) btns.push(mini('x', 'Cancel', () => hostDo('cancelTransfer', { transferId: t.id })));
  if (t.canRetry) btns.push(mini('refresh', 'Retry', () => hostDo('retryTransfer', { transferId: t.id })));
  if (t.state === 'failed' || t.state === 'cancelled') btns.push(mini('trash', 'Remove', () => hostDo('dismissTransfer', { transferId: t.id })));
  shell.buttons.replaceChildren(...btns);
}

function upsertTransferRow(t) {
  const shell = transferNodes.get(t.id);
  if (shell && shell.node.isConnected) patchTransferRow(shell, t);
  else if ((t.conversations || []).includes(current)) refreshPending();
}

// Incoming uploads another device is sending (API v3 upload progress events, when the server sends them).
const incoming = new Map(); // upload id -> { id, name, size, offset, convs, node }
function makeIncomingRow(inc) {
  const shell = pendingShell('in', inc.name || 'file');
  inc.shell = shell;
  // Servers with live-download serve a file while it's still arriving: the browser's download follows the upload.
  // (The Windows app saves files itself.)
  if (!HOST && serverHas('live-download')) {
    const save = el('a', { class: 'mini', href: fileUrl(inc), download: inc.name || 'file', title: 'Download', 'aria-label': `Download ${inc.name || 'the file'}` }, icon('download'));
    // Still coming? A row can outlive its upload (a cancel the page never heard of): then there's nothing to save.
    save.addEventListener('click', async e => {
      e.preventDefault();
      const res = await fetch(save.href, { method: 'HEAD', credentials: 'same-origin', headers: idHeaders() }).catch(() => null);
      if (res?.status === 404) { dropIncoming(inc.id); toast(`${inc.name || 'That file'} isn’t coming any more.`); return; }
      const a = el('a', { href: save.href, download: inc.name || 'file' });
      document.body.append(a);
      a.click();
      a.remove();
    });
    shell.buttons.append(save);
  }
  patchIncoming(inc);
  return shell.node;
}
function patchIncoming(inc) {
  if (!inc.shell) return;
  if (renderingPaused()) { hiddenWork.incoming = true; return; }
  setProgress(inc.shell.bar, inc.offset, inc.size);
  inc.shell.status.textContent = `Receiving from ${nameOf(inc.from)} · ${transferLine(inc.offset, inc.size, inc.rate || 0, -1)}`;
}

// ---------------------------------------------------------------- banners (connection, updates)

function bannerParts() {
  const parts = [];
  if (net.state === 'offline' && !$('#app').hidden) {
    const waiting = outbox.size ? ` ${plural(outbox.size, 'message')} will be sent when it’s back.` : '';
    parts.push(el('div', { class: 'banner-row offline' }, icon('offline'),
      el('span', { class: 'banner-text' }, el('strong', {}, 'Can’t reach Beam. '), `${net.cause}${waiting}`, el('span', { class: 'retry-in', 'data-retry': '' })),
      el('button', { class: 'btn small-btn', type: 'button', onclick: () => reconnectNow('manual') }, 'Retry now')));
  }
  if (updateReady && !HOST) {
    parts.push(el('div', { class: 'banner-row' }, icon('refresh'), el('span', { class: 'banner-text' }, 'Beam was updated.'),
      el('button', { class: 'btn small-btn primary', type: 'button', onclick: () => location.reload() }, 'Reload')));
  }
  return parts;
}

// The same banner goes at the top of the thread and (on phones, in the list view) at the top of the sidebar.
function renderBanner() {
  for (const id of ['#banner', '#sideBanner']) {
    const node = $(id);
    const parts = bannerParts();
    node.replaceChildren(...parts);
    node.hidden = !parts.length;
  }
  tickRetryCountdown();
}

function tickRetryCountdown() {
  for (const span of $$('[data-retry]')) {
    const secs = live.retryAt ? Math.max(0, Math.ceil((live.retryAt - Date.now()) / 1000)) : 0;
    span.textContent = secs ? ` Retrying in ${secs} s.` : ' Retrying…';
  }
}

function setStatus() {
  const dot = $('#status');
  const state = net.state;
  dot.className = `status ${state}`;
  const label = { online: 'Connected', offline: 'Offline, retrying', connecting: 'Connecting…' }[state];
  dot.setAttribute('aria-label', label);
  dot.title = label;
}
