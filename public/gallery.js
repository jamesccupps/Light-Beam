'use strict';
// Selecting several messages, and a gallery of a conversation's photos, videos and files (1.12; the user: "a way to
// select multiple messages pictures or maybe just a gallery of the device pictures that were sent to allow me to copy
// or drag multiple at the same time into another program"). One selection for both: picked in the thread or in the
// gallery, the bar at the bottom copies, saves, forwards or deletes them together. The Windows app copies several files
// at once and drags them out together (HOST-BRIDGE.md: copyFiles, dragOut with itemIds); a browser downloads them.

// ---------------------------------------------------------------- selecting several

const pickedItems = () => [...pick.ids].map(id => itemMap.get(id)).filter(Boolean).sort((a, b) => a.ts - b.ts);
const pickedFiles = () => pickedItems().filter(i => i.kind === 'file');

// Picking starts with one (the message whose menu said "Select", a Ctrl+click) or with none ("Select" in the gallery).
function startPicking(id = '') {
  if (!pick.on) {
    pick.on = true;
    pick.ids.clear();
    pick.last = '';
    $('#app').classList.add('picking');
    $('#galleryPanel .gal-select')?.setAttribute('hidden', '');
    for (const n of $$('#galleryPanel [data-id]')) n.setAttribute('aria-pressed', 'false');
  }
  if (id && itemMap.has(id)) { setPicked(id, true); pick.last = id; }
  renderPickBar();
}

function stopPicking() {
  if (!pick.on) return;
  pick.on = false;
  for (const id of pick.ids) markPicked(id, false);
  pick.ids.clear();
  pick.last = '';
  $('#app').classList.remove('picking');
  $('#galleryPanel .gal-select')?.removeAttribute('hidden');
  for (const n of $$('#galleryPanel [data-id]')) n.removeAttribute('aria-pressed');
}

function markPicked(id, on) {
  view.nodes.get(`m:${id}`)?.classList.toggle('picked', on);
  for (const node of $$(`#galleryPanel [data-id="${CSS.escape(id)}"]`)) {
    node.classList.toggle('picked', on);
    node.setAttribute('aria-pressed', String(on));
  }
}

function setPicked(id, on) {
  if (on) pick.ids.add(id); else pick.ids.delete(id);
  markPicked(id, on);
}

// A tap while picking: that one in or out. With Shift, everything between it and the last one tapped (`order`: the
// ids as they're listed on screen).
function togglePick(id, { range = false, order = null } = {}) {
  if (!itemMap.has(id)) return;
  if (!pick.on) startPicking();
  const from = range && pick.last && order ? order.indexOf(pick.last) : -1;
  const to = order ? order.indexOf(id) : -1;
  if (from >= 0 && to >= 0) for (let i = Math.min(from, to); i <= Math.max(from, to); i++) setPicked(order[i], true);
  else setPicked(id, !pick.ids.has(id));
  pick.last = id;
  renderPickBar();
}

// Everything in the list on screen: the conversation (all of it, not only what's drawn), or the gallery's tab.
function pickAll() {
  if (!pick.on) startPicking();
  for (const item of gallery.open ? galleryItems(gallery.tab) : threadItems()) setPicked(item.id, true);
  renderPickBar();
}

// What Copy does with these. The Windows app copies files as files (any number at once, for any app that takes
// pasted files); otherwise the text of the messages, or one picture. Null: nothing it can copy here.
function copyPlan(list) {
  const files = list.filter(i => i.kind === 'file');
  const texts = list.filter(i => i.kind === 'text');
  if (files.length && HOST && hostHas('copyFiles')) return { kind: 'files', items: files, title: files.length === 1 ? 'Copy the file, to paste it into another program' : `Copy the ${files.length} files, to paste them into another program` };
  if (texts.length) return { kind: 'text', items: texts, title: files.length ? 'Copy the text of the messages (files can only be copied in the Beam app for Windows)' : 'Copy the text' };
  if (files.length === 1 && PREVIEW_IMAGE.test(files[0].mime || '')) return { kind: 'image', items: files, title: 'Copy the picture' };
  return null;
}

// ---------------------------------------------------------------- the bar (in place of the message box)

const pickUi = {};

function bindPicking() {
  const button = (key, iconName, onclick, cls = '') => {
    pickUi[key] = el('button', { class: `btn small-btn${cls ? ` ${cls}` : ''}`, type: 'button', onclick }, icon(iconName), el('span', { class: 'pick-label' }));
    return pickUi[key];
  };
  pickUi.count = el('span', { class: 'pick-count', role: 'status' });
  $('#pickBar').replaceChildren(pickUi.count,
    button('copy', 'copy', copyPicked), button('save', 'download', savePicked), button('forward', 'forward', forwardPicked),
    button('delete', 'trash', deletePicked, 'danger'),
    el('button', { class: 'icon-btn small', type: 'button', title: 'Stop selecting (Esc)', 'aria-label': 'Stop selecting', onclick: stopPicking }, icon('x')));

  // While picking, a tap on a message picks it (nothing inside it reacts: links, previews, buttons). Otherwise
  // Ctrl+click (⌘ on a Mac) starts picking with that message, as in a file manager; Shift+click picks a range.
  $('#thread').addEventListener('click', e => {
    const node = e.target.closest?.('.msg.pickable[data-id]');
    if (!node || !itemMap.has(node.dataset.id)) return;
    if (!pick.on && !((e.ctrlKey || e.metaKey) && !e.target.closest('a[href]'))) return;
    e.preventDefault();
    e.stopPropagation();
    togglePick(node.dataset.id, { range: e.shiftKey, order: threadItems().map(i => i.id) });
  }, true);
}

const setPickButton = (b, label, { disabled = false, title = '', iconName = '' } = {}) => {
  b.querySelector('.pick-label').textContent = label;
  b.setAttribute('aria-label', label); // (narrow screens show the icons only)
  b.disabled = disabled;
  b.title = title || label;
  if (iconName) b.querySelector('use').setAttribute('href', `#i-${iconName}`);
};

function renderPickBar() {
  if (!pick.on || !pickUi.count) return;
  for (const id of [...pick.ids]) if (!itemMap.has(id)) pick.ids.delete(id); // (deleted meanwhile)
  const list = pickedItems();
  const files = list.filter(i => i.kind === 'file');
  const n = list.length;
  const count = n ? `${n.toLocaleString()} selected` : gallery.open ? 'Tap photos or files to select them' : 'Tap messages to select them';
  if (pickUi.count.textContent !== count) pickUi.count.textContent = count;
  const copy = copyPlan(list);
  setPickButton(pickUi.copy, 'Copy', { disabled: !copy, title: copy?.title || (files.length ? 'A browser can’t copy files: download them instead' : '') });
  const allSaved = HOST && files.length > 0 && files.every(f => isSaved(f.id));
  setPickButton(pickUi.save, HOST ? (allSaved ? 'Show in folder' : 'Save') : files.length > 1 ? `Download ${files.length}` : 'Download', {
    disabled: !files.length, iconName: allSaved ? 'folder' : 'download',
    title: !files.length ? 'No files selected' : HOST ? (allSaved ? 'Show them in their folder' : 'Save them on this PC') : 'Download the files',
  });
  setPickButton(pickUi.forward, 'Forward', { disabled: !n, title: 'Forward them to another device' });
  setPickButton(pickUi.delete, 'Delete', { disabled: !n, title: 'Delete them on every device (Del)' });
}

// The same as a menu (a right-click or long-press while picking, Shift+F10).
function pickMenu(at) {
  const list = pickedItems();
  const files = list.filter(i => i.kind === 'file');
  const allSaved = HOST && files.length > 0 && files.every(f => isSaved(f.id));
  openMenu([
    copyPlan(list) && { label: 'Copy', icon: 'copy', hint: 'Ctrl+C', action: copyPicked },
    files.length && { label: HOST ? (allSaved ? 'Show in folder' : 'Save') : files.length > 1 ? `Download ${files.length}` : 'Download', icon: allSaved ? 'folder' : 'download', action: savePicked },
    list.length && { label: 'Forward…', icon: 'forward', action: forwardPicked },
    'sep',
    { label: 'Select all', icon: 'check', hint: 'Ctrl+A', action: pickAll },
    { label: 'Stop selecting', icon: 'x', hint: 'Esc', action: stopPicking },
    'sep',
    list.length && { label: list.length === 1 ? 'Delete for everyone' : `Delete ${list.length} for everyone`, icon: 'trash', danger: true, hint: 'Del', action: deletePicked },
  ], at, { label: 'Selected messages' });
}

// ---------------------------------------------------------------- what the bar does

// Copy keeps the selection (copy, then forward or delete them too); Forward and Delete end it.
async function copyPicked() {
  const plan = copyPlan(pickedItems());
  if (!plan) return;
  if (plan.kind === 'files') return copyFilesHost(plan.items);
  if (plan.kind === 'image') return copyImage(plan.items[0]);
  if (plan.items.length === 1) return copyItem(plan.items[0]);
  // The text of each, oldest first, with a blank line between them.
  try {
    const parts = [];
    for (const item of plan.items) parts.push(view.fullText.get(item.id) || (item.truncated ? await (await api(`api/items/${item.id}/text`)).text() : item.text));
    copyText(parts.join('\n\n'), `Copied ${parts.length} messages`);
  } catch (err) { toast(friendlyError(err), { error: true }); }
}

// The Windows app puts them on the clipboard as Explorer's Copy does. Files that aren't on this PC yet are saved
// first and then copied, unless something else was copied meanwhile (that stays: the app checks).
async function copyFilesHost(files) {
  const itemIds = files.map(f => f.id);
  try {
    let r = await hostCall('copyFiles', { itemIds });
    if (r?.missing?.length) {
      toast(files.length === 1 ? 'Saving it on this PC first…' : `Saving ${r.missing.length === files.length ? 'them' : `${r.missing.length} of them`} on this PC first…`, { ms: 8000 });
      for (const itemId of r.missing) hostDo('saveFile', { itemId });
      const why = await whenSaved(r.missing);
      if (why) return toast(why, { error: true });
      r = await hostCall('copyFiles', { itemIds, clipSeq: r.clipSeq });
    }
    const n = r?.copied || itemIds.length;
    toast(n === 1 ? 'Copied. Paste it with Ctrl+V.' : `${n} files copied. Paste them with Ctrl+V.`);
  } catch (err) {
    if (err.code === 'clipboard-changed') toast('Saved. Something else was copied meanwhile, so Beam left it there.', { action: 'Copy them now', onAction: () => copyFilesHost(files), ms: 9000 });
    else toast(err.message || 'Couldn’t copy them.', { error: true });
  }
}

// Resolves once every one of them is saved on this PC: '' then, or why not (a download that failed or was cancelled,
// a file deleted meanwhile).
function whenSaved(ids) {
  return new Promise(resolve => {
    const started = Date.now();
    const seen = new Set(); // the ones whose download showed up
    const check = () => {
      if (ids.every(isSaved)) return resolve('');
      if (ids.some(id => !itemMap.has(id))) return resolve('One of them was deleted meanwhile, so nothing was copied.');
      const running = new Map([...hostState.transfers.values()].filter(t => t.kind === 'download').map(t => [t.itemId, t]));
      for (const id of ids) {
        if (isSaved(id)) continue;
        const t = running.get(id);
        if (t) seen.add(id);
        const name = itemMap.get(id)?.name || 'a file';
        if (t?.state === 'failed') return resolve(`Couldn’t save ${name}, so nothing was copied.`);
        // (a cancelled download's row goes away; one that never started had its reason shown already)
        if (!t && (seen.has(id) || Date.now() - started > 10000)) return resolve(`${name} wasn’t saved, so nothing was copied.`);
      }
      setTimeout(check, 400);
    };
    check();
  });
}

function savePicked() {
  const files = pickedFiles();
  if (!files.length) return;
  if (!HOST) return void downloadItems(files);
  const missing = files.filter(f => !isSaved(f.id));
  if (!missing.length) return void hostDo('revealFile', { itemId: files[0].id });
  for (const f of missing) hostDo('saveFile', { itemId: f.id });
  toast(missing.length === 1 ? `Saving ${missing[0].name}…` : `Saving ${missing.length} files…`);
}

// One after another (the browser may ask once whether Beam may download several files).
async function downloadItems(list) {
  toast(list.length === 1 ? `Downloading ${list[0].name}` : `Downloading ${list.length} files`);
  for (const [i, item] of list.entries()) {
    if (i) await sleep(350);
    downloadItem(item);
  }
}

async function forwardPicked() {
  const list = pickedItems();
  if (!list.length) return;
  const what = list.length > 1 ? plural(list.length, 'message') : list[0].kind === 'text' ? 'Message' : list[0].name;
  const conv = await chooseConv(what, { title: 'Forward to…' });
  if (!conv) return;
  stopPicking();
  forwardItems(list, [conv]);
}

function deletePicked() {
  const ids = pickedItems().map(i => i.id);
  if (!ids.length) return;
  stopPicking();
  deleteItems(ids); // (Undo for 5 s, as for one)
}

// ---------------------------------------------------------------- the gallery: a conversation's photos, videos and files

const isMediaItem = i => /^(image|video)\//.test(i.mime || '');
// Newest first.
const galleryItems = (tab, conv = current) => itemsIn(conv).filter(i => i.kind === 'file' && isMediaItem(i) === (tab === 'media')).reverse();
let galleryBack = false; // closed by the user on a phone: the history entry it added goes too (that popstate is ours)

function bindGallery() {
  const panel = $('#galleryPanel');
  $('#galleryBtn').addEventListener('click', () => (gallery.open ? closeGalleryByUser() : openGallery()));
  panel.addEventListener('contextmenu', e => {
    const node = e.target.closest('[data-id]');
    const item = node && itemMap.get(node.dataset.id);
    if (!item || e.shiftKey) return;
    e.preventDefault();
    if (pick.on) { if (!pick.ids.has(item.id)) togglePick(item.id); pickMenu({ x: e.clientX, y: e.clientY }); }
    else openMenu(galleryMenuEntries(item), { x: e.clientX, y: e.clientY }, { label: 'Actions' });
  });
  panel.addEventListener('keydown', e => {
    const node = e.target.closest?.('[data-id]');
    const item = node && itemMap.get(node.dataset.id);
    if (!item || !((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu')) return;
    e.preventDefault();
    if (pick.on) pickMenu(node); else openMenu(galleryMenuEntries(item), node, { label: 'Actions' });
  });
}

// Back (app.js asks this first): while the gallery is open it only closes it, and the history.back() that follows
// closing it with its × is ours. True when handled.
function galleryPopState(e) {
  if (galleryBack) { galleryBack = false; return true; }
  if (gallery.open && !e.state?.gallery) { closeGallery(); return true; }
  return false;
}

const galleryMenuEntries = item => [
  { label: 'Show in conversation', icon: 'next', action: () => { closeGalleryByUser(); revealItem(item.id); } },
  'sep',
  ...itemMenuEntries(item, null, null),
];

function openGallery({ tab = '' } = {}) {
  if (phonePanelOpen() || gallery.open) return;
  gallery.tab = tab || (!galleryItems('media').length && galleryItems('other').length ? 'other' : 'media');
  // Where the thread was, to come back to the same place (a hidden thread can't keep its own).
  const box = $('#thread');
  gallery.scroll = view.pinnedBottom || atBottom(box) ? null : box.scrollTop;
  gallery.open = true;
  gallery.key = '';
  stopPicking();
  closeThreadSearch();
  $('#app').classList.add('gallery-open');
  if (NARROW.matches) history.pushState({ conv: current, gallery: true }, '');
  renderHeader();
  renderGallery();
  $('#galleryPanel').scrollTop = 0;
  hostViewing();
}

// Closed by a conversation switch or the back button: the thread comes back where it was.
function closeGallery() {
  if (!gallery.open) return;
  gallery.open = false;
  stopPicking();
  $('#app').classList.remove('gallery-open');
  $('#galleryPanel').replaceChildren();
  gallery.nodes.clear();
  gallery.key = '';
  renderHeader();
  renderThread({ scroll: 'none' });
  if (gallery.scroll === null) scrollToBottom(); else { $('#thread').scrollTop = gallery.scroll; view.pinnedBottom = atBottom($('#thread')); }
  scheduleCheckRead();
  hostViewing();
}

// After a forced sign-out: nothing of it stays (no rendering: the page is going to the sign-in screen).
function resetGallery() {
  stopPicking();
  gallery.open = false;
  gallery.key = '';
  gallery.conv = null;
  gallery.nodes.clear();
  $('#app').classList.remove('gallery-open');
  $('#galleryPanel').replaceChildren();
}

// Closed with its ×, Esc or the header's button.
function closeGalleryByUser() {
  if (!gallery.open) return;
  closeGallery();
  if (NARROW.matches && history.state?.gallery) { galleryBack = true; history.back(); }
}

const monthLabel = ts => dateFormat({ month: 'long', year: 'numeric' }).format(ts);

// Drawn again only when something changed (a new photo, one deleted, a thumbnail that came); tiles are kept, so their
// pictures aren't fetched again.
function renderGallery() {
  if (!gallery.open) return;
  if (renderingPaused()) { hiddenWork.all = true; return; }
  const key = `${current}|${gallery.tab}|${dataVersion}|${me.id}`;
  if (gallery.key === key) return;
  gallery.key = key;
  if (gallery.conv !== current) { gallery.nodes.clear(); gallery.conv = current; }
  const media = galleryItems('media');
  const other = galleryItems('other');
  const list = gallery.tab === 'media' ? media : other;
  const keep = new Set();
  const node = (item, make) => {
    const k = `${gallery.tab}:${item.id}:${JSON.stringify(item.thumb ?? null)}`;
    keep.add(k);
    let n = gallery.nodes.get(k);
    if (!n) { n = make(item); gallery.nodes.set(k, n); }
    n.classList.toggle('picked', pick.ids.has(item.id));
    if (pick.on) n.setAttribute('aria-pressed', String(pick.ids.has(item.id))); else n.removeAttribute('aria-pressed');
    return n;
  };
  let body;
  if (!list.length) {
    body = el('div', { class: 'thread-empty gal-empty' }, el('strong', {}, gallery.tab === 'media' ? 'No photos or videos here yet' : 'No files here yet'),
      gallery.tab === 'media' ? 'Pictures and videos sent in this conversation show up here.' : 'Other files sent in this conversation show up here.');
  } else if (gallery.tab === 'media') {
    body = el('div', { class: 'gal-grid', 'aria-label': 'Photos and videos' });
    let month = '';
    for (const item of list) {
      const m = monthLabel(item.ts);
      if (m !== month) { body.append(el('div', { class: 'gal-month' }, m)); month = m; }
      body.append(node(item, galleryTile));
    }
  } else {
    body = el('div', { class: 'gal-files', 'aria-label': 'Files' }, ...list.map(item => node(item, galleryRow)));
  }
  for (const k of [...gallery.nodes.keys()]) if (!keep.has(k)) gallery.nodes.delete(k);
  $('#galleryPanel').replaceChildren(galleryBar(media.length, other.length), body);
  if (pick.on) renderPickBar();
}

function galleryBar(nMedia, nOther) {
  const tab = (key, label, n) => el('button', {
    class: 'gal-tab', type: 'button', role: 'tab', 'aria-selected': String(gallery.tab === key),
    onclick: () => { if (gallery.tab === key) return; gallery.tab = key; stopPicking(); renderGallery(); $('#galleryPanel').scrollTop = 0; },
  }, label, el('span', { class: 'gal-n' }, n.toLocaleString()));
  const empty = !(gallery.tab === 'media' ? nMedia : nOther);
  return el('div', { class: 'gal-bar' },
    el('div', { class: 'gal-tabs', role: 'tablist', 'aria-label': 'Photos and files' }, tab('media', 'Photos & videos', nMedia), tab('other', 'Files', nOther)),
    el('button', { class: 'btn small-btn gal-select', type: 'button', hidden: pick.on, disabled: empty, title: 'Pick several, to copy, save, forward or delete them together', onclick: () => startPicking() }, icon('check'), el('span', {}, 'Select')),
    el('button', { class: 'icon-btn small', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close photos and files', onclick: closeGalleryByUser }, icon('x')));
}

// A square picture: the thumbnail the sender made, or the photo itself if it's small (as in the thread); else its name.
function galleryTile(item) {
  const video = /^video\//.test(item.mime || '');
  const small = PREVIEW_IMAGE.test(item.mime || '') && item.size <= autoPreviewMax();
  const src = hasThumb(item) ? thumbUrl(item) : small ? fileUrl(item, true) : '';
  const placeholder = () => el('span', { class: 'gal-ph' }, icon(video ? 'play' : 'image'), el('span', {}, item.name));
  const tile = el('button', {
    class: 'gal-tile', type: 'button', 'data-id': item.id,
    title: `${item.name} · ${formatSize(item.size)} · ${senderName(item)}, ${shortWhen(item.ts)}`, 'aria-label': `${video ? 'Video' : 'Photo'} ${item.name}`,
  });
  if (src) {
    const img = el('img', { src, alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => {
      if (hasThumb(item) && small && !img.dataset.fallback) { img.dataset.fallback = '1'; img.src = fileUrl(item, true); }
      else img.replaceWith(placeholder());
    });
    tile.append(img);
    if (video) tile.append(el('span', { class: 'gal-play', 'aria-hidden': 'true' }, icon('play')));
  } else tile.append(placeholder());
  tile.append(el('span', { class: 'gal-check', 'aria-hidden': 'true' }, icon('check')));
  tile.addEventListener('click', e => onGalleryTap(e, item));
  bindDragOut(tile, item);
  return tile;
}

function galleryRow(item) {
  const row = el('button', { class: 'gal-file', type: 'button', 'data-id': item.id },
    el('span', { class: 'ext', 'aria-hidden': 'true' }, extOf(item.name)),
    el('span', { class: 'gal-file-body' }, el('span', { class: 'gal-file-name' }, item.name),
      el('span', { class: 'muted small' }, `${formatSize(item.size)} · ${senderName(item)} · ${shortWhen(item.ts)}`)),
    el('span', { class: 'gal-check', 'aria-hidden': 'true' }, icon('check')));
  row.addEventListener('click', e => onGalleryTap(e, item));
  bindDragOut(row, item);
  return row;
}

// A tap: picks it while picking (Ctrl/Shift+click start picking, as in the thread); otherwise a photo opens in the
// viewer, a video plays, another file opens (the Windows app; it's saved first) or downloads.
function onGalleryTap(e, item) {
  if (pick.on || e.ctrlKey || e.metaKey || e.shiftKey) return togglePick(item.id, { range: e.shiftKey, order: galleryItems(gallery.tab).map(i => i.id) });
  if (PREVIEW_IMAGE.test(item.mime || '')) return openLightbox(item);
  if (/^video\//.test(item.mime || '')) return playVideo(item);
  if (HOST) return void hostDo(isSaved(item.id) ? 'openFile' : 'saveFile', { itemId: item.id });
  downloadItem(item);
}

function playVideo(item) {
  const video = el('video', { class: 'gal-video', controls: true, autoplay: true, playsinline: true, preload: 'metadata', src: fileUrl(item, true) });
  if (hasThumb(item)) video.poster = thumbUrl(item);
  const saved = HOST && isSaved(item.id);
  openDialog({
    title: item.name, body: [video], wide: true, className: 'video-dlg',
    buttons: [
      el('button', { class: 'btn ghost', type: 'button', onclick: () => { $('#genDlg').close(); closeGalleryByUser(); revealItem(item.id); } }, 'Show in conversation'),
      HOST ? el('button', { class: 'btn', type: 'button', onclick: () => hostDo(saved ? 'openFile' : 'saveFile', { itemId: item.id }) }, saved ? 'Open' : 'Save')
        : el('button', { class: 'btn', type: 'button', onclick: () => downloadItem(item) }, 'Download'),
    ],
    onClose: () => { video.pause(); video.removeAttribute('src'); video.load(); },
  });
}
