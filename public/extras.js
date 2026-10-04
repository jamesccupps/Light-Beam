'use strict';
// Menus, copying, deleting with undo, forward/pin/clear, search, the image viewer, previews and keyboard
// shortcuts.

// ---------------------------------------------------------------- copying

async function writeClipboard(text) {
  if (HOST) {
    try { await hostCall('copyText', { text }); return true; } catch {}
  }
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
  }
  const area = el('textarea', { readonly: true });
  area.value = text;
  Object.assign(area.style, { position: 'fixed', top: '0', left: '0', opacity: '0' });
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  area.remove();
  return ok;
}

async function copyText(text, done = 'Copied') {
  toast(await writeClipboard(text) ? done : 'Couldn’t copy. Select the text and copy it with Ctrl+C.', { error: false });
}

async function copyItem(item) {
  if (HOST) {
    try { await hostCall('copyText', { itemId: item.id }); toast('Copied'); return; } catch {}
  }
  let ok;
  const full = view.fullText.get(item.id);
  if (item.truncated && !full && window.ClipboardItem && navigator.clipboard?.write) {
    const blob = api(`api/items/${item.id}/text`).then(r => r.text()).then(t => new Blob([t], { type: 'text/plain' }));
    ok = await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]).then(() => true, () => false);
  } else {
    try {
      ok = await writeClipboard(full || (item.truncated ? await (await api(`api/items/${item.id}/text`)).text() : item.text));
    } catch (err) { return toast(friendlyError(err), { error: true }); }
  }
  toast(ok ? 'Copied' : 'Couldn’t copy. Select the text and copy it with Ctrl+C.');
}

// The picture as PNG (what a clipboard takes everywhere), turned as the photo says.
async function imageAsPng(item) {
  const blob = await (await api(`api/file/${item.id}?inline`)).blob();
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return canvas.convertToBlob({ type: 'image/png' });
}

async function copyImage(item) {
  // The Windows app copies it (its page may be http, which has no image clipboard); a type Windows can't read comes
  // back "unsupported", and is sent as PNG. An app older than 1.6.2 doesn't know the message: the browser's way, then.
  if (HOST) {
    try {
      try {
        await hostCall('copyImage', { itemId: item.id });
      } catch (err) {
        if (err.code !== 'unsupported') throw err;
        const png = await imageAsPng(item);
        const b64 = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
          r.onerror = () => reject(r.error);
          r.readAsDataURL(png);
        });
        await hostCall('copyImage', { png: b64 });
      }
      return void toast('Image copied');
    } catch (err) {
      if (err.code !== 'unknown-type') return void toast(err.status || err.offline ? friendlyError(err) : err.message || 'Couldn’t copy the image.', { error: true });
    }
  }
  if (!window.ClipboardItem || !navigator.clipboard?.write) return toast('This browser can’t copy images from here. Open the image, then right-click it (or press and hold) and copy it.', { error: true });
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': imageAsPng(item) })]);
    toast('Image copied');
  } catch (err) {
    toast(err.status || err.offline ? friendlyError(err) : 'Couldn’t copy the image.', { error: true });
  }
}

// A selection across several messages copies just their text, one message per paragraph (no times,
// "Delivered" ticks or buttons in between).
function onCopy(e) {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const thread = $('#thread');
  if (!thread.contains(range.commonAncestorContainer)) return;
  const msgs = [...thread.querySelectorAll('.msg[data-id]')].filter(m => range.intersectsNode(m));
  if (msgs.length < 2) return;
  const parts = [];
  for (const m of msgs) {
    const target = m.querySelector('.text') || m.querySelector('.fname');
    if (!target) continue;
    const r = document.createRange();
    r.selectNodeContents(target);
    if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset);
    const t = r.toString();
    if (t.trim()) parts.push(t);
  }
  if (!parts.length) return;
  e.clipboardData.setData('text/plain', parts.join('\n\n'));
  e.preventDefault();
}

// The text of the selection if it lies inside this message.
function selectionIn(node) {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
  const range = sel.getRangeAt(0);
  return node.contains(range.commonAncestorContainer) ? sel.toString() : '';
}

let nativeSelect = { id: '', until: 0 }; // "Select text" on touch: the next long-press on that message is the browser's
function selectMessage(item) {
  const node = view.nodes.get(`m:${item.id}`);
  const target = node?.querySelector('.text') || node?.querySelector('.fname');
  if (!target) return;
  node.focus({ preventScroll: true }); // out of the message box, or the selection would land there
  const r = document.createRange();
  r.selectNodeContents(target);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  if (lastPointer === 'touch') {
    nativeSelect = { id: item.id, until: Date.now() + 20000 };
    toast('Long-press the text to adjust the selection');
  }
}

// ---------------------------------------------------------------- the menu (right-click, long-press, ⋯ buttons, Shift+F10)

let menuReturnFocus = null;
let lastPointer = 'mouse';
window.addEventListener('pointerdown', e => { lastPointer = e.pointerType || 'mouse'; }, true);

function openMenu(entries, at, { label = 'Actions' } = {}) {
  const menu = $('#menu');
  menuReturnFocus = document.activeElement;
  const buttons = [];
  const nodes = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === 'sep') { if (nodes.length && !nodes.at(-1).classList.contains('sep')) nodes.push(el('div', { class: 'sep', role: 'separator' })); continue; }
    const btn = el('button', { class: `menu-item${entry.danger ? ' danger' : ''}`, type: 'button', role: 'menuitem', disabled: Boolean(entry.disabled) },
      icon(entry.icon || 'next'), el('span', {}, entry.label), entry.hint && el('kbd', {}, entry.hint));
    btn.addEventListener('click', () => { closeMenu(); entry.action(); });
    buttons.push(btn);
    nodes.push(btn);
  }
  if (nodes.at(-1)?.classList.contains('sep')) nodes.pop();
  menu.replaceChildren(...nodes);
  menu.setAttribute('aria-label', label);
  const sheet = NARROW.matches && lastPointer === 'touch';
  menu.classList.toggle('sheet', sheet);
  menu.hidden = false;
  if (!sheet) {
    const rect = at instanceof Element ? at.getBoundingClientRect() : { left: at.x, right: at.x, top: at.y, bottom: at.y };
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    let x = at instanceof Element ? rect.right - w : rect.left;
    let y = at instanceof Element ? rect.bottom + 4 : rect.top;
    x = clamp(x, 8, innerWidth - w - 8);
    if (y + h > innerHeight - 8) y = Math.max(8, (at instanceof Element ? rect.top - 4 : rect.top) - h);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  } else {
    menu.style.left = '';
    menu.style.top = '';
  }
  if (lastPointer !== 'touch') buttons.find(b => !b.disabled)?.focus({ preventScroll: true });
  else menu.focus?.({ preventScroll: true });
}

function closeMenu() {
  const menu = $('#menu');
  if (menu.hidden) return;
  menu.hidden = true;
  menu.replaceChildren();
  if (menuReturnFocus?.isConnected) menuReturnFocus.focus({ preventScroll: true });
  menuReturnFocus = null;
}

function bindMenu() {
  const menu = $('#menu');
  menu.addEventListener('keydown', e => {
    const items = [...menu.querySelectorAll('.menu-item:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); items.at(-1)?.focus(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeMenu(); }
  });
  document.addEventListener('pointerdown', e => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); }, true);
  window.addEventListener('resize', closeMenu);
  // Only the user scrolling closes it: a message arriving (the thread scrolls itself) mustn't pull it away.
  for (const type of ['wheel', 'touchmove']) $('#thread').addEventListener(type, closeMenu, { passive: true });

  // Right-click / long-press on a message: Beam's menu (Shift+right-click still gives the browser's).
  $('#thread').addEventListener('contextmenu', e => {
    const node = e.target.closest('.msg[data-id]');
    if (!node || e.shiftKey) return;
    const item = itemMap.get(node.dataset.id);
    if (!item) return;
    if ((e.pointerType === 'touch' || lastPointer === 'touch') && nativeSelect.id === item.id && Date.now() < nativeSelect.until) return;
    e.preventDefault();
    // While picking several: the menu is for all of them (a message not picked yet is picked first).
    if (pick.on) { if (!pick.ids.has(item.id)) togglePick(item.id); pickMenu({ x: e.clientX, y: e.clientY }); return; }
    openMenu(itemMenuEntries(item, e.target, node), { x: e.clientX, y: e.clientY }, { label: 'Message actions' });
  });
}

function openItemMenu(item, anchor) {
  const node = view.nodes.get(`m:${item.id}`);
  openMenu(itemMenuEntries(item, null, node), anchor, { label: 'Message actions' });
}

function itemMenuEntries(item, target, node) {
  const e = [];
  const selected = node ? selectionIn(node) : '';
  const link = target?.closest?.('a[href]');
  if (selected) e.push({ label: 'Copy', icon: 'copy', hint: 'Ctrl+C', action: () => copyText(selected) });
  if (item.kind === 'text') {
    e.push({ label: selected ? 'Copy whole message' : 'Copy', icon: 'copy', action: () => copyItem(item) });
    if (link) {
      e.push({ label: 'Copy link', icon: 'link', action: () => copyText(link.href, 'Link copied') });
      e.push({ label: 'Open link', icon: 'open', action: () => openLink(link.href) });
    }
    e.push({ label: 'Select text', icon: 'select', action: () => selectMessage(item) });
    if (item.text.length <= 900) e.push({ label: 'Show QR code', icon: 'qr', action: () => showQr(item.text) });
  } else {
    const image = PREVIEW_IMAGE.test(item.mime || '');
    if (image) {
      e.push({ label: 'View', icon: 'eye', action: () => openLightbox(item) });
      e.push({ label: 'Copy image', icon: 'image', action: () => copyImage(item) });
    }
    if (TEXTLIKE.test(item.mime || '') || TEXTLIKE.test(item.name || '')) e.push({ label: 'Preview', icon: 'eye', action: () => previewTextFile(item) });
    if (HOST) {
      if (isSaved(item.id)) {
        e.push({ label: 'Open', icon: 'open', action: () => hostDo('openFile', { itemId: item.id }) });
        e.push({ label: 'Show in folder', icon: 'folder', action: () => hostDo('revealFile', { itemId: item.id }) });
      } else {
        e.push({ label: 'Save', icon: 'download', action: () => hostDo('saveFile', { itemId: item.id }) });
      }
      e.push({ label: 'Save as…', icon: 'download', action: () => hostDo('saveFileAs', { itemId: item.id }) });
    } else {
      e.push({ label: 'Download', icon: 'download', action: () => downloadItem(item) });
      if (navigator.canShare && item.size < 100 * 1024 * 1024) e.push({ label: 'Share…', icon: 'share', action: () => shareFile(item) });
    }
    e.push({ label: 'Copy file name', icon: 'copy', action: () => copyText(item.name) });
  }
  e.push('sep');
  if (itemMap.has(item.id)) e.push({ label: 'Select', icon: 'check', action: () => startPicking(item.id) });
  e.push({ label: 'Forward…', icon: 'forward', action: () => forwardPrompt(item) });
  if (serverHas('pin')) e.push({ label: item.pinned ? 'Unpin' : 'Pin', icon: 'pin', action: () => togglePin(item) });
  e.push('sep');
  e.push({ label: 'Delete for everyone', icon: 'trash', danger: true, hint: 'Del', action: () => deleteItems([item.id]) });
  return e;
}

function downloadItem(item) {
  const a = el('a', { href: fileUrl(item), download: item.name });
  document.body.append(a);
  a.click();
  a.remove();
}

async function shareFile(item) {
  try {
    const blob = await (await api(`api/file/${item.id}`)).blob();
    const file = new File([blob], item.name, { type: item.mime });
    if (!navigator.canShare({ files: [file] })) throw new Error('unsupported');
    await navigator.share({ files: [file] });
  } catch (err) {
    if (err.name !== 'AbortError') toast('Couldn’t open the share sheet. Use Download instead.', { error: true });
  }
}

function openLink(href) {
  if (HOST) { hostDo('openLink', { url: href }); return; }
  window.open(href, '_blank', 'noopener,noreferrer');
}

// ---------------------------------------------------------------- delete (with a 5 s undo), pin, forward, clear

const pendingDeletes = new Map(); // item id -> item, removed on screen but not yet on the server

function deleteItems(ids, { undo = true } = {}) {
  const removed = [];
  for (const id of ids) {
    const item = removeItem(id);
    if (!item) continue;
    touchItem(id);
    removed.push(item);
    pendingDeletes.set(id, item);
    onItemRemoved(id);
  }
  if (!removed.length) return;
  const commit = () => commitDeletes(removed.map(i => i.id));
  if (!undo) { commit(); return; }
  const timer = setTimeout(commit, 5000);
  toast(removed.length === 1 ? 'Deleted for all devices' : `${removed.length.toLocaleString()} items deleted for all devices`, {
    action: 'Undo', ms: 5000,
    onAction: () => {
      clearTimeout(timer);
      for (const item of removed) {
        if (!pendingDeletes.delete(item.id)) continue;
        touchItem(item.id);
        putItem(item);
        onItemAdded(item, { fromMe: false });
      }
      renderThread({ scroll: 'keep' });
    },
  });
}

async function commitDeletes(ids, { keepalive = false } = {}) {
  ids = ids.filter(id => pendingDeletes.has(id));
  if (!ids.length) return;
  const restore = [];
  for (const id of ids) { restore.push(pendingDeletes.get(id)); pendingDeletes.delete(id); cache.deleteItem(id); }
  try {
    if (ids.length > 1 && serverHas('bulk-delete')) {
      await api('api/items/delete', { ...jsonBody({ ids }), keepalive });
    } else {
      for (const id of ids) await api(`api/items/${id}`, { method: 'DELETE', keepalive }).catch(err => { if (err.status !== 404) throw err; });
    }
  } catch (err) {
    for (const item of restore) { putItem(item); cache.putItem(item); onItemAdded(item); }
    toast(`Couldn’t delete: ${friendlyError(err)}`, { error: true });
  }
}

// Closing the page within the undo window still deletes.
function flushDeletes() {
  if (pendingDeletes.size) commitDeletes([...pendingDeletes.keys()], { keepalive: true });
}

async function togglePin(item) {
  const pinned = !item.pinned;
  item.pinned = pinned;
  patchMsg(item);
  renderHeader();
  try {
    await api(`api/items/${item.id}`, jsonBody({ pinned }, 'PATCH'));
    toast(pinned ? 'Pinned. It stays until you unpin it.' : 'Unpinned');
  } catch (err) {
    item.pinned = !pinned;
    patchMsg(item);
    renderHeader();
    toast(friendlyError(err), { error: true });
  }
}

async function forwardPrompt(item) {
  const conv = await chooseConv(item.kind === 'text' ? 'Message' : item.name, { title: 'Forward to…', exclude: [] });
  if (conv) forwardItem(item, [conv]);
}

function forwardItem(item, convs) { return forwardItems([item], convs); }

// Several (picked together, 1.12): oldest first, so they arrive in the order they were sent.
async function forwardItems(list, convs) {
  const to = convs.flatMap(targetsOf);
  const where = convs.map(convName).join(', ');
  let done = 0;
  try {
    for (const item of list) {
      if (serverHas('forward')) {
        acceptOwnItem(await apiJson(`api/items/${item.id}/forward`, jsonBody({ to })));
      } else if (item.kind === 'text') {
        const text = view.fullText.get(item.id) || (item.truncated ? await (await api(`api/items/${item.id}/text`)).text() : item.text);
        for (const c of convs) await sendText(text, c);
      } else {
        if (list.length === 1) return toast('Forwarding files needs the updated Beam server.', { error: true });
        continue;
      }
      done++;
    }
    if (list.length === 1) toast(`Forwarded to ${where}`);
    else toast(done === list.length ? `Forwarded ${done} to ${where}` : `Forwarded ${done} of ${list.length} to ${where} (forwarding files needs the updated Beam server)`, { error: done < list.length });
  } catch (err) {
    toast(done ? `Forwarded ${done} of ${list.length}. ${friendlyError(err)}` : friendlyError(err), { error: true });
  }
}

async function clearConversation(conv = current) {
  const ids = itemsIn(conv).filter(i => conv === 'all' || i.to.length > 0).map(i => i.id);
  if (!ids.length) return toast('Nothing to clear');
  const ok = await confirmDialog({
    title: `Clear ${convName(conv)}?`,
    text: `${plural(ids.length, 'item')} ${conv === 'all' ? 'sent to all devices' : `between you and ${convName(conv)}`} will be deleted on every device.`,
    confirm: 'Delete them', danger: true,
  });
  if (ok) deleteItems(ids);
}

function threadMenu(anchor) {
  const d = deviceById(current);
  const pinned = itemsIn(current).some(i => i.pinned);
  openMenu([
    ...(d ? [...deviceActions(d), { label: 'Device info…', icon: 'eye', action: () => openDeviceInfo(d) }, 'sep'] : []),
    { label: 'Find in conversation', icon: 'search', hint: 'Ctrl+F', action: openThreadSearch },
    itemsIn(current).some(i => i.kind === 'file') && { label: 'Photos and files', icon: 'image', action: () => openGallery() },
    itemsIn(current).length > 0 && { label: 'Select messages', icon: 'check', action: () => { closeGallery(); startPicking(); } },
    (pinned || view.pinnedOnly) && { label: view.pinnedOnly ? 'Show all messages' : 'Show pinned only', icon: 'pin', action: togglePinnedView },
    canSendTo(current) && { label: 'Send clipboard', icon: 'clip', hint: 'Ctrl+Shift+V', action: pasteAndSend },
    canSendTo(current) && { label: 'Send files…', icon: 'attach', hint: 'Ctrl+O', action: attachFiles },
    canSendTo(current) && (!HOST || hostHas('pickFolder')) && { label: 'Send a folder…', icon: 'folder', action: attachFolder },
    'sep',
    { label: 'Clear conversation…', icon: 'trash', action: () => clearConversation(current) },
    d && { label: serverHas('tokens') ? `Sign out ${d.name}…` : `Forget ${d.name}…`, icon: 'logout', danger: true, action: () => removeDevice(d) },
  ], anchor, { label: 'Conversation options' });
}

function togglePinnedView() {
  view.pinnedOnly = !view.pinnedOnly;
  view.conv = null; // a different list: start the thread fresh
  renderHeader();
  renderThread({ scroll: 'bottom' });
}

// ---------------------------------------------------------------- search (all conversations, in the sidebar)

let searchQuery = '';
function openSearch() {
  $('#sideSearch').hidden = false;
  if (NARROW.matches) showList();
  $('#searchInput').focus();
  $('#searchInput').select();
}
function closeSearch() {
  $('#sideSearch').hidden = true;
  $('#searchInput').value = '';
  searchQuery = '';
  $('#searchResults').hidden = true;
  $('#convList').hidden = false;
}

const runSearch = debounce(() => {
  const q = $('#searchInput').value.trim().toLowerCase();
  searchQuery = q;
  const box = $('#searchResults');
  if (!q) { box.hidden = true; $('#convList').hidden = false; return; }
  const hits = [];
  for (let i = items.length - 1; i >= 0 && hits.length < 200; i--) {
    const item = items[i];
    const convs = convsOf(item);
    if (!convs.length) continue;
    const text = item.kind === 'text' ? (view.fullText.get(item.id) || item.text) : item.name;
    const hay = `${text}\n${senderName(item)}`.toLowerCase();
    if (hay.includes(q)) hits.push(item);
  }
  const truncated = items.some(i => i.truncated && !view.fullText.has(i.id));
  box.replaceChildren(
    el('p', { class: 'muted small search-count', role: 'status' }, hits.length ? `${plural(hits.length, 'result')}${hits.length === 200 ? '+' : ''}` : 'No results'),
    ...hits.map(item => searchResult(item, q)),
    truncated && el('button', { class: 'btn ghost small-btn', type: 'button', onclick: loadFullTextsForSearch }, 'Also search inside long messages'));
  box.hidden = false;
  $('#convList').hidden = true;
}, 150);

function searchResult(item, q) {
  const conv = convsOf(item).find(c => c !== 'all') || 'all';
  const text = item.kind === 'text' ? (view.fullText.get(item.id) || item.text).replace(/\s+/g, ' ') : `📄 ${item.name}`;
  const at = Math.max(0, text.toLowerCase().indexOf(q));
  const start = Math.max(0, at - 30);
  const snippet = el('span', { class: 'conv-preview' }, start > 0 ? '…' : '', text.slice(start, at), el('mark', {}, text.slice(at, at + q.length)), text.slice(at + q.length, at + q.length + 80));
  const btn = el('button', { class: 'conv search-hit', type: 'button' },
    avatar(conv),
    el('span', { class: 'conv-body' }, el('span', { class: 'conv-top' }, el('span', { class: 'conv-name' }, convName(conv)), el('span', { class: 'conv-time' }, shortWhen(item.ts))), el('span', { class: 'conv-bottom' }, snippet)));
  btn.addEventListener('click', () => { openConv(conv); revealItem(item.id); });
  return btn;
}

async function loadFullTextsForSearch() {
  const long = items.filter(i => i.truncated && !view.fullText.has(i.id)).slice(0, 50);
  for (const item of long) {
    try { view.fullText.set(item.id, await (await api(`api/items/${item.id}/text`)).text()); } catch { break; }
  }
  runSearch.flush();
}

// ---------------------------------------------------------------- find in this conversation (highlights without touching the DOM)

const find = { query: '', hits: [], index: -1 };
const HAS_HIGHLIGHTS = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';

function openThreadSearch() {
  if (NARROW.matches && !$('#app').classList.contains('in-thread')) return openSearch();
  closeGalleryByUser(); // (it's in the thread)
  $('#threadSearch').hidden = false;
  $('#threadSearchInput').focus();
  $('#threadSearchInput').select();
}
function closeThreadSearch() {
  $('#threadSearch').hidden = true;
  $('#threadSearchInput').value = '';
  find.query = '';
  find.hits = [];
  find.index = -1;
  $('#threadSearchCount').textContent = '';
  if (HAS_HIGHLIGHTS) { CSS.highlights.delete('beam-find'); CSS.highlights.delete('beam-find-current'); }
}

const runFind = debounce(() => {
  const q = $('#threadSearchInput').value.trim().toLowerCase();
  find.query = q;
  find.hits = !q ? [] : itemsIn(current).filter(i => (i.kind === 'text' ? (view.fullText.get(i.id) || i.text) : i.name).toLowerCase().includes(q));
  find.index = find.hits.length ? find.hits.length - 1 : -1;
  showFind();
}, 120);

function stepFind(dir) {
  if (!find.hits.length) return;
  find.index = (find.index + dir + find.hits.length) % find.hits.length;
  showFind();
}

function showFind() {
  $('#threadSearchCount').textContent = find.query ? (find.hits.length ? `${find.index + 1} of ${find.hits.length}` : 'No matches') : '';
  const item = find.hits[find.index];
  if (item) revealItem(item.id, { highlight: !HAS_HIGHLIGHTS });
  paintFind();
}

function textRanges(node, q) {
  const out = [];
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const s = t.data.toLowerCase();
    for (let i = s.indexOf(q); i >= 0; i = s.indexOf(q, i + q.length)) {
      const r = new Range();
      r.setStart(t, i);
      r.setEnd(t, i + q.length);
      out.push(r);
    }
  }
  return out;
}

function paintFind() {
  if (!HAS_HIGHLIGHTS) return;
  if (!find.query) { CSS.highlights.delete('beam-find'); CSS.highlights.delete('beam-find-current'); return; }
  const all = [];
  let cur = [];
  for (const [key, node] of view.nodes) {
    if (!key.startsWith('m:')) continue;
    const target = node.querySelector('.text') || node.querySelector('.fname');
    if (!target) continue;
    const ranges = textRanges(target, find.query);
    if (find.hits[find.index]?.id === node.dataset.id) cur = ranges; else all.push(...ranges);
  }
  CSS.highlights.set('beam-find', new Highlight(...all));
  CSS.highlights.set('beam-find-current', new Highlight(...cur));
}

// ---------------------------------------------------------------- image viewer (zoom, pan, swipe)

const lb = { list: [], index: 0, scale: 1, x: 0, y: 0, pointers: new Map(), start: null };

function openLightbox(item) {
  lb.list = itemsIn(current).filter(i => PREVIEW_IMAGE.test(i.mime || ''));
  lb.index = Math.max(0, lb.list.findIndex(i => i.id === item.id));
  if (!lb.list.length) lb.list = [item];
  showLightboxItem();
  const dlg = $('#lightbox');
  if (!dlg.open) dlg.showModal();
  $('#lbClose').focus();
}

function showLightboxItem() {
  const item = lb.list[lb.index];
  if (!item) return;
  lb.scale = 1; lb.x = 0; lb.y = 0;
  applyLightbox();
  const img = $('#lbImg');
  img.alt = item.name;
  img.src = localPreviews.get(item.id) || fileUrl(item, true);
  $('#lbName').textContent = `${item.name} · ${formatSize(item.size)} · ${senderName(item)}, ${shortWhen(item.ts)}`;
  $('#lbCount').textContent = lb.list.length > 1 ? `${lb.index + 1} / ${lb.list.length}` : '';
  $('#lbPrev').hidden = lb.index <= 0;
  $('#lbNext').hidden = lb.index >= lb.list.length - 1;
  const action = $('#lbAction');
  const saved = HOST && isSaved(item.id);
  action.setAttribute('aria-label', HOST ? (saved ? 'Open' : 'Save') : 'Download');
  action.title = action.getAttribute('aria-label');
  action.querySelector('use').setAttribute('href', HOST && saved ? '#i-open' : '#i-download');
}

function applyLightbox() {
  $('#lbImg').style.transform = `translate(${lb.x}px, ${lb.y}px) scale(${lb.scale})`;
  $('#lbStage').classList.toggle('zoomed', lb.scale > 1.01);
}

function zoomLightbox(factor, cx, cy) {
  const stage = $('#lbStage').getBoundingClientRect();
  const px = (cx ?? stage.left + stage.width / 2) - (stage.left + stage.width / 2);
  const py = (cy ?? stage.top + stage.height / 2) - (stage.top + stage.height / 2);
  const next = clamp(lb.scale * factor, 1, 8);
  const k = next / lb.scale;
  lb.x = px - (px - lb.x) * k;
  lb.y = py - (py - lb.y) * k;
  lb.scale = next;
  if (next === 1) { lb.x = 0; lb.y = 0; }
  applyLightbox();
}

function stepLightbox(dir) {
  const next = lb.index + dir;
  if (next < 0 || next >= lb.list.length) return;
  lb.index = next;
  showLightboxItem();
}

function bindLightbox() {
  const dlg = $('#lightbox');
  const stage = $('#lbStage');
  $('#lbClose').addEventListener('click', () => dlg.close());
  $('#lbPrev').addEventListener('click', () => stepLightbox(-1));
  $('#lbNext').addEventListener('click', () => stepLightbox(1));
  $('#lbZoomIn').addEventListener('click', () => zoomLightbox(1.5));
  $('#lbZoomOut').addEventListener('click', () => zoomLightbox(1 / 1.5));
  $('#lbAction').addEventListener('click', () => {
    const item = lb.list[lb.index];
    if (!item) return;
    if (HOST) hostDo(isSaved(item.id) ? 'openFile' : 'saveFile', { itemId: item.id });
    else downloadItem(item);
  });
  dlg.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') stepLightbox(-1);
    else if (e.key === 'ArrowRight') stepLightbox(1);
    else if (e.key === '+' || e.key === '=') zoomLightbox(1.25);
    else if (e.key === '-') zoomLightbox(0.8);
    else if (e.key === '0') { lb.scale = 1; lb.x = 0; lb.y = 0; applyLightbox(); }
  });
  stage.addEventListener('click', e => { if (e.target === stage && lb.scale === 1) dlg.close(); });
  stage.addEventListener('wheel', e => { e.preventDefault(); zoomLightbox(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY); }, { passive: false });
  stage.addEventListener('dblclick', e => { lb.scale > 1 ? zoomLightbox(1 / lb.scale) : zoomLightbox(2.5, e.clientX, e.clientY); });
  stage.addEventListener('pointerdown', e => {
    stage.setPointerCapture(e.pointerId);
    lb.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lb.start = { x: e.clientX, y: e.clientY, lx: lb.x, ly: lb.y, scale: lb.scale, dist: pinchDistance(), t: Date.now() };
  });
  stage.addEventListener('pointermove', e => {
    if (!lb.pointers.has(e.pointerId) || !lb.start) return;
    lb.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (lb.pointers.size === 2 && lb.start.dist) {
      const pts = [...lb.pointers.values()];
      const factor = (pinchDistance() / lb.start.dist) * lb.start.scale / lb.scale;
      zoomLightbox(factor, (pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
    } else if (lb.scale > 1) {
      lb.x = lb.start.lx + e.clientX - lb.start.x;
      lb.y = lb.start.ly + e.clientY - lb.start.y;
      applyLightbox();
    }
  });
  const end = e => {
    if (!lb.pointers.has(e.pointerId)) return;
    const s = lb.start;
    lb.pointers.delete(e.pointerId);
    if (s && lb.pointers.size === 0 && lb.scale === 1 && Date.now() - s.t < 600) {
      const dx = e.clientX - s.x;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(e.clientY - s.y)) stepLightbox(dx < 0 ? 1 : -1);
    }
    lb.start = lb.pointers.size ? { ...lb.start, dist: pinchDistance(), scale: lb.scale } : null;
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  dlg.addEventListener('close', () => { $('#lbImg').removeAttribute('src'); lb.pointers.clear(); });
}

function pinchDistance() {
  const pts = [...lb.pointers.values()];
  return pts.length === 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
}

// ---------------------------------------------------------------- text file preview (first 64 KB), QR codes

async function previewTextFile(item) {
  const pre = el('pre', { class: 'file-preview' }, 'Loading…');
  const buttons = [HOST
    ? el('button', { class: 'btn', type: 'button', onclick: () => hostDo(isSaved(item.id) ? 'openFile' : 'saveFile', { itemId: item.id }) }, isSaved(item.id) ? 'Open' : 'Save')
    : el('button', { class: 'btn', type: 'button', onclick: () => downloadItem(item) }, 'Download')];
  openDialog({ title: item.name, body: [pre], buttons, wide: true });
  try {
    const res = await api(`api/file/${item.id}`, { headers: { Range: 'bytes=0-65535' } });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 65536));
    pre.textContent = text + (item.size > 65536 ? '\n\n… (showing the first 64 KB)' : '');
  } catch (err) {
    pre.textContent = friendlyError(err);
  }
}

function showQr(text) {
  openDialog({
    title: 'Scan to open on another device',
    body: [el('div', { class: 'qr-wrap' }, el('img', { src: url(`api/qr.svg?data=${encodeURIComponent(text)}`), alt: 'QR code', width: '240', height: '240' })),
      el('p', { class: 'muted small center' }, text.length > 120 ? `${text.slice(0, 120)}…` : text)],
  });
}

// ---------------------------------------------------------------- quick switcher (Ctrl+K)

function openSwitcher() {
  const input = el('input', { type: 'search', placeholder: 'Go to a conversation…', 'aria-label': 'Conversation name', autocomplete: 'off' });
  const list = el('ul', { class: 'choose-list', role: 'listbox' });
  let active = 0;
  let matches = [];
  const render = () => {
    if (!devicesKnown) { matches = []; list.replaceChildren(devicesLoadingRow()); return; }
    const q = input.value.trim().toLowerCase();
    matches = conversationOrder().filter(c => convName(c).toLowerCase().includes(q));
    active = clamp(active, 0, Math.max(0, matches.length - 1));
    list.replaceChildren(...matches.map((conv, i) => {
      const r = makeRow(conv, c => { dlg.close(); openConv(c); });
      patchRow(r, conv, { active: i === active });
      r.button.setAttribute('role', 'option');
      r.button.setAttribute('aria-selected', String(i === active));
      return r.li;
    }));
  };
  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(matches.length - 1, active + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = matches[active]; if (c) { dlg.close(); openConv(c); } }
  });
  const dlg = openDialog({ title: 'Go to…', body: [input, list], className: 'switcher' });
  if (!devicesKnown) {
    const refresh = () => { if (devicesKnown) { devicePickers.delete(refresh); render(); } else render(); };
    devicePickers.add(refresh);
    dlg.addEventListener('close', () => devicePickers.delete(refresh), { once: true });
  }
  render();
  input.focus();
}

// ---------------------------------------------------------------- keyboard

const SHORTCUTS = [
  ['Ctrl+K', 'Go to a conversation'],
  ['Alt+↑ / Alt+↓', 'Previous / next conversation'],
  ['Ctrl+F', 'Find in this conversation'],
  ['Ctrl+Shift+V', 'Send what’s on the clipboard'],
  ['Ctrl+O', 'Send files'],
  ['Enter / Shift+Enter', 'Send / new line (Ctrl+Enter on touch screens)'],
  ['↑ in an empty message box', 'Go to the messages'],
  ['↑ ↓ Home End', 'Move between messages'],
  ['Ctrl+C', 'Copy the selected message (or the selection)'],
  ['Delete', 'Delete the selected message (with Undo)'],
  ['Ctrl+click / Shift+click', 'Pick several messages (then Ctrl+A, Ctrl+C or Delete)'],
  ['Shift+F10 / Menu key', 'Message actions'],
  ['Esc', 'Close, go back, or return to the message box'],
  ['Ctrl+/', 'This list'],
];

function shortcutList() {
  return el('dl', { class: 'shortcuts' }, ...SHORTCUTS.flatMap(([k, d]) => [el('dt', {}, el('kbd', {}, k)), el('dd', {}, d)]));
}

function focusedMsg() {
  const node = document.activeElement?.closest?.('.msg[data-id]');
  return node && $('#thread').contains(node) ? node : null;
}

function moveFocus(node, dir) {
  const msgs = [...$('#thread').querySelectorAll('.msg[data-id]')];
  if (!msgs.length) return;
  let i = node ? msgs.indexOf(node) : msgs.length;
  i = dir === 'home' ? 0 : dir === 'end' ? msgs.length - 1 : clamp(i + dir, 0, msgs.length - 1);
  if (dir === -1 && node && msgs.indexOf(node) === 0 && view.start > 0) { loadOlder(); return moveFocus(node, -1); }
  msgs[i].focus();
  msgs[i].scrollIntoView({ block: 'nearest' });
}

function stepConversation(dir) {
  const order = conversationOrder();
  const i = order.indexOf(current);
  const next = order[clamp(i + dir, 0, order.length - 1)];
  if (next && next !== current) openConv(next);
}

function onKeydown(e) {
  if (!signedIn()) return;
  const mod = e.ctrlKey || e.metaKey;
  const typing = e.target.closest?.('input, textarea, select, [contenteditable="true"]');
  const dialogOpen = document.querySelector('dialog[open]');
  if (!$('#menu').hidden) return; // the menu handles its own keys
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!dialogOpen) openSwitcher(); return; }
  if (dialogOpen) return;
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); openThreadSearch(); return; }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteAndSend(); return; }
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); attachFiles(); return; }
  if (mod && e.key === '/') { e.preventDefault(); openDialog({ title: 'Keyboard shortcuts', body: shortcutList() }); return; }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); stepConversation(e.key === 'ArrowUp' ? -1 : 1); return; }
  if (e.key === 'Escape') {
    if (pick.on) { stopPicking(); return; }
    if (gallery.open) { closeGalleryByUser(); return; }
    if (!$('#threadSearch').hidden) { closeThreadSearch(); $('#text').focus(); return; }
    if (!$('#sideSearch').hidden) { closeSearch(); return; }
    if (NARROW.matches && $('#app').classList.contains('in-thread')) { $('#backBtn').click(); return; }
    if (focusedMsg()) { $('#text').focus(); return; }
    return;
  }
  // Picking several: the keys act on all of them; Space or Enter picks the focused message.
  if (pick.on && !typing) {
    const k = e.key.toLowerCase();
    if (mod && k === 'a') { e.preventDefault(); pickAll(); return; }
    if (mod && k === 'c' && getSelection().isCollapsed) { e.preventDefault(); copyPicked(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deletePicked(); return; }
    if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') { e.preventDefault(); pickMenu(focusedMsg() || $('#pickBar')); return; }
    const node = focusedMsg();
    if (node && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); togglePick(node.dataset.id); return; }
  }
  const msg = focusedMsg();
  if (msg && !typing) {
    const item = itemMap.get(msg.dataset.id);
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); moveFocus(msg, e.key === 'ArrowUp' ? -1 : 1); return; }
    if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); moveFocus(msg, e.key === 'Home' ? 'home' : 'end'); return; }
    if (!item) return;
    if (mod && e.key.toLowerCase() === 'c' && getSelection().isCollapsed) { e.preventDefault(); item.kind === 'text' ? copyItem(item) : copyText(item.name); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); const next = msg.nextElementSibling || msg.previousElementSibling; deleteItems([item.id]); next?.focus?.(); return; }
    if (e.key === 'Enter' && item.kind === 'file') { e.preventDefault(); if (PREVIEW_IMAGE.test(item.mime || '')) openLightbox(item); else if (HOST) hostDo('openFile', { itemId: item.id }); else downloadItem(item); return; }
    if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') { e.preventDefault(); openItemMenu(item, msg); return; }
  }
  if (e.target === $('#text') && e.key === 'ArrowUp' && !$('#text').value) { e.preventDefault(); moveFocus(null, -1); }
}

function attachFiles() {
  if (!canSendTo(current)) return;
  if (HOST) { hostDo('pickFiles', { to: targetsOf(current) }).then(r => { if (r && r.count) toast(`Sending ${plural(r.count, 'file')}…`); }); return; }
  $('#fileInput').click();
}

// A whole folder arrives as one .zip (the Windows app zips it natively; browsers zip it here).
function attachFolder() {
  if (!canSendTo(current)) return;
  if (HOST) { hostDo('pickFolder', { to: targetsOf(current) }).then(r => { if (r && r.count) toast('Sending the folder…'); }); return; }
  $('#folderInput').click();
}

function onFolderPicked(fileList) {
  const files = [...fileList];
  if (!files.length) return toast('That folder is empty.');
  const top = (files[0].webkitRelativePath || files[0].name).split('/')[0] || 'Folder';
  sendFolder({ name: top, entries: files.map(f => ({ file: f, path: f.webkitRelativePath || f.name })) }, current);
}
