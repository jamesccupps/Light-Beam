// ---------------------------------------------------------------- shared folders (Beam 1.26, Beam for Windows 1.18)
// A PC's folders shared with this device, chosen only at that PC (Settings → Control & sharing → Shared folders…: the folders, and
// for each the devices that see it): look in them here and copy files over. The PC sends what's ticked the way it sends
// anything, so the files arrive in its conversation with this device (and a Beam app saves them as it saves anything).
// Each look is a fresh question through the server (POST /api/devices/{id}/files, …/files/copy); nothing is kept. The
// user: "being able to browser folders on other devices, like from my laptop, look at my desktops downloads folder and
// then copy from that to my laptop", "maybe being able to choose which folders to share with what devices".
// (Beam 1.28, Beam for Windows 1.20; the user: "we should add like windows type things to it like preview and sort and
// everything") Sorting (folders first), the PC's own icon and name for each type, a grid of Windows' thumbnails, a file's
// preview before copying it, a search in the folder and its subfolders, select all, and whole folders (a .zip each).

const sharedView = {
  gen: 0, dlgGen: -1, device: null, share: null, name: '', path: '', entries: [], more: false, picked: new Map(), filter: '',
  search: null,  // (1.28) { q, results, more } while a search's results are shown (results: null while it runs)
  preview: null, // (1.28) the file looked at: { list, index, url }
  scroll: 0,     // the list's place, kept while a file is looked at
};
// (1.28) How folders are shown, remembered on this device: list or grid, sorted by name, date, size or type.
const sharedLook = { view: 'list', sort: 'name', desc: false, ...store.json('beam.sharedLook', {}) };
const sharedIcons = new Map(); // (1.28) device id -> Map(".pdf" / "/" -> { src, name }): the PC's own
const sharedThumbs = new Map(); // (1.28) "device|share|path|m" -> a data: URL ('' none): the last 400
const sharedCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }); // (file2 before file10, as Explorer)
const SHARED_THUMBS = /\.(jpe?g|jfif|png|gif|webp|bmp|tiff?|heic|heif|avif|mp4|mov|m4v|avi|mkv|wmv|webm|mpe?g|3gp|mts|m2ts|pdf)$/i;

const canBrowseShared = d => Boolean(d?.can?.files) && d.online && d.id !== me.id && serverHas('shared-folders');
const canSharedMore = d => Boolean(d?.can?.files2) && serverHas('shared-folders-2');
const sharedExt = name => (/\.[^./]{1,16}$/.exec(name)?.[0] || '').toLowerCase();
const sharedJoin = (...parts) => parts.filter(Boolean).join('/');
const sharedApi = (d, what) => `api/devices/${encodeURIComponent(d.id)}/files${what ? `/${what}` : ''}`;

// The folders a PC shares with this device (straight into the folder when there's only one).
async function openSharedFolders(d) {
  Object.assign(sharedView, { device: d, share: null, name: '', path: '', entries: [], more: false, picked: new Map(), filter: '', search: null, preview: null });
  const gen = ++sharedView.gen;
  toast(`Asking ${d.name} what it shares with this device…`, { ms: 3000 });
  let r;
  try { r = await apiJson(sharedApi(d), jsonBody({})); } catch (err) { toast(friendlyError(err), { error: true }); return; }
  if (gen !== sharedView.gen) return;
  const shares = r.shares || [];
  if (shares.length === 1) return openSharedFolder(shares[0].id, '');
  openDialog({
    title: `${d.name}: shared folders`,
    className: 'shared-dlg',
    body: shares.length
      ? [note(`The folders ${d.name} shares with this device. Open one, tick files and copy them here.`),
        el('div', { class: 'shared-list', role: 'list' }, ...shares.map(s => el('button', { class: 'shared-row dir', type: 'button', onclick: () => openSharedFolder(s.id, '') },
          icon('folder'), el('span', { class: 'shared-name' }, s.name))))]
      : [note(`Nothing on ${d.name} is shared with this device. At ${d.name}: Settings → Control & sharing → Shared folders…, add a folder and tick ${me.name || 'this device'}.`)],
    onClose: () => closeSharedPreview(),
  });
  sharedView.dlgGen = dialogGen;
}

// One folder: `path` inside the shared one, its steps joined with /.
async function openSharedFolder(share, path) {
  const v = sharedView, d = v.device;
  const gen = ++v.gen;
  let r;
  try { r = await apiJson(sharedApi(d), jsonBody({ share, path })); } catch (err) { toast(friendlyError(err), { error: true }); return; }
  if (gen !== v.gen) return;
  Object.assign(v, { share, name: r.name || 'Shared folder', path: r.path ?? path, entries: r.entries || [], more: Boolean(r.more), picked: new Map(), filter: '', search: null, scroll: 0 });
  renderSharedFolder();
  loadSharedIcons(d, v.entries);
}

// The dialog's title, body and buttons: replaced while it shows this PC's folders, else a new dialog.
function showShared(title, body, buttons) {
  const v = sharedView;
  if ($('#genDlg').open && dialogGen === v.dlgGen) {
    $('#genTitle').textContent = title;
    $('#genBody').replaceChildren(...body);
    $('#genFoot').replaceChildren(...buttons);
    $('#genFoot').hidden = !buttons.length;
    $('#genDlg').classList.add('wide');
  } else {
    openDialog({ title, className: 'shared-dlg', wide: true, body, buttons, onClose: () => closeSharedPreview() });
    v.dlgGen = dialogGen;
  }
}

// (1.28) A type's name: the PC's ("Text Document"), else from its extension.
function sharedTypeName(d, e) {
  const icons = sharedIcons.get(d.id);
  if (e.dir) return icons?.get('/')?.name || 'Folder';
  const x = sharedExt(e.n);
  return icons?.get(x)?.name || (x ? `${x.slice(1).toUpperCase()} file` : 'File');
}

function sortShared(d, list) {
  const { sort, desc } = sharedLook;
  const by = sort === 'size' ? (a, b) => a.s - b.s : sort === 'date' ? (a, b) => a.m - b.m
    : sort === 'type' ? (a, b) => sharedCollator.compare(sharedTypeName(d, a), sharedTypeName(d, b)) : () => 0;
  return [...list].sort((a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0) || (by(a, b) || sharedCollator.compare(a.n, b.n)) * (desc ? -1 : 1));
}

function renderSharedFolder() {
  const v = sharedView, d = v.device, more = canSharedMore(d);
  const grid = more && sharedLook.view === 'grid';
  const steps = v.path ? v.path.split('/') : [];
  const go = p => () => openSharedFolder(v.share, p);
  const crumbs = el('nav', { class: 'shared-crumbs', 'aria-label': 'Where' },
    steps.length || v.search ? el('button', { class: 'linkish', type: 'button', onclick: go('') }, v.name) : el('b', {}, v.name),
    ...steps.flatMap((s, i) => [el('span', { class: 'muted', 'aria-hidden': 'true' }, ' / '),
      i === steps.length - 1 && !v.search ? el('b', {}, s) : el('button', { class: 'linkish', type: 'button', onclick: go(steps.slice(0, i + 1).join('/')) }, s)]),
    v.search && [el('span', { class: 'muted', 'aria-hidden': 'true' }, ' / '), el('b', {}, `Names with “${v.search.q}”, subfolders too`)]);
  const filter = el('input', { type: 'search', class: 'shared-filter', placeholder: 'Show only names with…', 'aria-label': more ? 'Show only names with (Enter: in subfolders too)' : 'Show only names with', value: v.filter, enterkeyhint: 'search' });
  const deep = more && el('button', { class: 'btn ghost shared-deep', type: 'button', title: 'Look for that in every folder below this one too (Enter)', 'aria-label': 'Search subfolders too', onclick: () => searchShared(filter.value) },
    icon('search'), el('span', { class: 'shared-deep-text' }, 'Subfolders too'));
  const sortBy = el('select', { class: 'shared-sort', 'aria-label': 'Sort by' },
    ...[['name', 'Name'], ['date', 'Date modified'], ['size', 'Size'], ['type', 'Type']].map(([k, t]) => el('option', { value: k, selected: sharedLook.sort === k }, t)));
  const look = changes => { Object.assign(sharedLook, changes); store.setJson('beam.sharedLook', sharedLook); renderSharedFolder(); };
  sortBy.onchange = () => look({ sort: sortBy.value, desc: sortBy.value === 'date' }); // (dates: newest first)
  const ways = { name: ['A to Z', 'Z to A'], date: ['oldest first', 'newest first'], size: ['smallest first', 'largest first'], type: ['A to Z', 'Z to A'] }[sharedLook.sort] || ['A to Z', 'Z to A'];
  const [now, other] = sharedLook.desc ? [ways[1], ways[0]] : ways;
  const order = mini(sharedLook.desc ? 'down' : 'up', `Sorted ${now}: click for ${other}`, () => look({ desc: !sharedLook.desc }));
  const view = more && mini(grid ? 'file' : 'image', grid ? 'Show as a list' : 'Show as pictures', () => look({ view: grid ? 'list' : 'grid' }));
  const bar = el('div', { class: 'shared-bar' }, filter, deep, sortBy, order, view);
  const allBox = el('input', { type: 'checkbox' });
  const allLabel = el('span', {}, 'Select all');
  const head = el('label', { class: 'shared-head small' }, allBox, allLabel);
  const list = el('div', { class: `shared-list${grid ? ' grid' : ''}`, role: 'list', 'aria-label': v.search ? 'Search results' : v.name });
  const copyLabel = el('span', {}, 'Copy to this device');
  const copyBtn = el('button', { class: 'btn primary shared-copy', type: 'button', onclick: copySharedPicked }, icon('download'), copyLabel);
  // Each entry with its name inside the folder looked in (`rel`: "2026/a.jpg" from a search)
  const all = (v.search ? (v.search.results || []) : v.entries).map(e => ({ ...e, rel: v.search ? sharedJoin(e.p, e.n) : e.n }));
  let shown = [];
  const count = () => {
    const n = v.picked.size, dirs = [...v.picked.values()].filter(Boolean).length;
    copyBtn.disabled = !n;
    copyLabel.textContent = !n ? 'Copy to this device' : `Copy ${dirs ? plural(n, 'item') : plural(n, 'file')} to this device`;
    const pickable = shown.filter(e => more || !e.dir);
    allBox.checked = pickable.length > 0 && pickable.every(e => v.picked.has(e.rel));
    allBox.indeterminate = !allBox.checked && pickable.some(e => v.picked.has(e.rel));
    allBox.disabled = !pickable.length;
    const bytes = [...v.picked.keys()].reduce((t, rel) => t + (all.find(e => e.rel === rel)?.s || 0), 0);
    allLabel.textContent = n ? `${plural(n, 'selected', 'selected')} (${dirs ? `${plural(dirs, 'folder')} as .zip files` : formatSize(bytes)})` : 'Select all';
  };
  const pick = (e, on, node) => { if (on) v.picked.set(e.rel, Boolean(e.dir)); else v.picked.delete(e.rel); node?.classList.toggle('picked', on); count(); };
  const drawList = () => {
    const q = v.filter.trim().toLowerCase();
    shown = sortShared(d, all).filter(e => !q || e.n.toLowerCase().includes(q));
    const files = shown.filter(e => !e.dir);
    const rows = [];
    if (steps.length && !v.search && !q) rows.push(sharedUpRow(grid, go(steps.slice(0, -1).join('/'))));
    if (v.search && !v.search.results) rows.push(note(`Looking for “${v.search.q}” in every folder below this one…`));
    for (const e of shown) rows.push(sharedEntry(d, e, { grid, more, picked: v.picked.has(e.rel), pick,
      open: e.dir ? go(sharedJoin(v.path, e.rel)) : more ? () => openSharedPreview(files, files.indexOf(e)) : null }));
    if (!shown.length && (!v.search || v.search.results)) {
      rows.push(note(v.search ? `Nothing below ${steps.length ? steps[steps.length - 1] : v.name} has “${v.search.q}” in its name.`
        : all.length ? 'Nothing here has those letters in its name.' : 'This folder is empty (or holds only what Beam doesn’t show: hidden files, names starting with “.”, links).'));
    }
    if (v.search?.more) rows.push(note(`Only the first ${all.length.toLocaleString()} found are listed (or the search stopped after a while): type more of the name.`));
    else if (v.more && !v.search) rows.push(note(`Only the first ${all.length.toLocaleString()} are listed: the filter looks among them.`));
    list.replaceChildren(...rows);
    count();
    if (grid) requestAnimationFrame(() => watchSharedThumbs(d, list)); // (once the list is on the page)
  };
  allBox.onchange = () => { const on = allBox.checked; for (const e of shown) if (more || !e.dir) pick(e, on); drawList(); };
  filter.oninput = () => { v.filter = filter.value; drawList(); };
  filter.onkeydown = ev => { if (ev.key === 'Enter' && more && filter.value.trim()) { ev.preventDefault(); searchShared(filter.value); } };
  drawList();
  const here = v.search ? `“${v.search.q}”` : steps.length ? steps[steps.length - 1] : v.name;
  const buttons = [v.search && el('button', { class: 'btn ghost', type: 'button', onclick: () => { v.search = null; v.filter = ''; v.picked = new Map(); renderSharedFolder(); } }, icon('back'), 'Back to the folder'), copyBtn].filter(Boolean);
  showShared(`${d.name}: ${here}`, [crumbs, bar, head, list], buttons);
  list.scrollTop = v.scroll;
}

function sharedUpRow(grid, onclick) {
  return grid
    ? el('div', { class: 'shared-tile', role: 'listitem' }, el('button', { class: 'shared-open', type: 'button', onclick }, el('span', { class: 'shared-pic' }, icon('up')), el('span', { class: 'shared-name' }, 'Up')))
    : el('div', { class: 'shared-item up', role: 'listitem' }, el('span'), icon('up'), el('button', { class: 'shared-open', type: 'button', onclick }, el('span', { class: 'shared-name' }, 'Up')));
}

// One file or folder: a row (tick, icon, name, modified, type, size) or a tile (its thumbnail, or its icon, and name).
function sharedEntry(d, e, { grid, more, picked, pick, open }) {
  const v = sharedView;
  const ic = sharedIconOf(d, e, grid);
  const when = e.m ? historyWhen(e.m) : '';
  const size = e.dir ? '' : formatSize(e.s);
  const label = e.dir ? `${e.n}, folder` : `${e.n}, ${size}`;
  const box = (more || !e.dir) && el('input', { type: 'checkbox', 'aria-label': `Select ${e.n}` });
  const name = el('span', { class: 'shared-name' }, e.n);
  const where = v.search && el('span', { class: 'shared-where muted small' }, e.p ? `in ${e.p.replaceAll('/', ' / ')}` : `in ${v.path ? v.path.split('/').pop() : v.name}`);
  const meta = !grid && el('span', { class: 'shared-meta muted small' }, [when, size].filter(Boolean).join(' · '));
  // A file's name opens its preview (Beam for Windows 1.20), else it ticks it; a folder's opens it
  const opener = open
    ? el('button', { class: 'shared-open', type: 'button', onclick: open, title: e.dir ? `Open ${e.n}` : `Look at ${e.n}`, 'aria-label': `${e.dir ? 'Open' : 'Look at'} ${label}` }, grid && el('span', { class: 'shared-pic' }, ic), name, where, meta)
    : el('span', { class: 'shared-open', onclick: () => { if (box) { box.checked = !box.checked; box.onchange(); } } }, grid && el('span', { class: 'shared-pic' }, ic), name, where, meta);
  const node = grid
    ? el('div', { class: `shared-tile${picked ? ' picked' : ''}`, role: 'listitem' }, box, opener)
    : el('div', { class: `shared-item${picked ? ' picked' : ''}`, role: 'listitem' }, box || el('span'), ic, opener,
      el('span', { class: 'shared-when muted small' }, when), el('span', { class: 'shared-type muted small', 'data-type': e.dir ? '/' : sharedExt(e.n) }, sharedTypeName(d, e)),
      el('span', { class: 'shared-size muted small' }, size));
  if (box) {
    box.checked = picked;
    box.onchange = () => pick(e, box.checked, node);
  }
  if (grid && !e.dir && more && SHARED_THUMBS.test(e.n)) {
    const key = `${d.id}|${v.share}|${sharedJoin(v.path, e.rel)}|${e.m}`;
    const got = sharedThumbs.get(key);
    if (got) ic.replaceWith(el('img', { class: 'thumb', src: got, alt: '', loading: 'lazy', decoding: 'async' }));
    else if (got === undefined) Object.assign(node.dataset, { thumb: key, rel: e.rel });
  }
  return node;
}

// The PC's icon for its type (once it has sent them), else Beam's own.
function sharedIconOf(d, e, big) {
  const type = e.dir ? '/' : sharedExt(e.n);
  const src = sharedIcons.get(d.id)?.get(type)?.src;
  if (src) return el('img', { class: 'shared-ic', src, alt: '', 'data-ic': type });
  const ic = icon(e.dir ? 'folder' : SHARED_THUMBS.test(e.n) && !/\.pdf$/i.test(e.n) ? 'image' : 'file', big ? 'i big' : 'i');
  ic.dataset.ic = type;
  return ic;
}

// (1.28) The PC's icon and name for each type in the folder, asked once per device; put in place when they come.
async function loadSharedIcons(d, entries) {
  if (!canSharedMore(d)) return;
  let icons = sharedIcons.get(d.id);
  if (!icons) sharedIcons.set(d.id, (icons = new Map()));
  const wanted = [...new Set(entries.map(e => (e.dir ? '/' : sharedExt(e.n))).filter(x => x && !icons.has(x)))].slice(0, 64);
  if (!wanted.length) return;
  for (const x of wanted) icons.set(x, { src: null, name: null }); // (asked: not again while this one runs)
  let r;
  try { r = await apiJson(sharedApi(d, 'icons'), jsonBody({ exts: wanted })); } catch { for (const x of wanted) icons.delete(x); return; }
  for (const x of wanted) icons.set(x, { src: r.icons?.[x] ? `data:image/png;base64,${r.icons[x]}` : null, name: r.types?.[x] || null });
  if (sharedView.device !== d || !$('#genDlg').open || dialogGen !== sharedView.dlgGen) return;
  for (const node of $('#genBody').querySelectorAll('[data-ic]')) {
    const src = icons.get(node.dataset.ic)?.src;
    if (src) node.replaceWith(el('img', { class: 'shared-ic', src, alt: '', 'data-ic': node.dataset.ic }));
  }
  for (const node of $('#genBody').querySelectorAll('[data-type]')) {
    const name = icons.get(node.dataset.type)?.name;
    if (name) node.textContent = name;
  }
  if (sharedLook.sort === 'type' && !sharedView.preview) renderSharedFolder();
}

// (1.28) Windows' thumbnails for the tiles in sight: 24 at a time, two requests at most at once.
const sharedThumbWork = { observer: null, queue: new Map(), busy: 0, tries: new Map() };
function watchSharedThumbs(d, list) {
  const w = sharedThumbWork;
  w.observer?.disconnect();
  w.queue.clear();
  if (!('IntersectionObserver' in window)) return;
  w.observer = new IntersectionObserver(seen => {
    for (const s of seen) if (s.isIntersecting && s.target.dataset.thumb) { w.queue.set(s.target.dataset.thumb, s.target); w.observer.unobserve(s.target); }
    fetchSharedThumbs(d);
  }, { root: list, rootMargin: '200px' });
  for (const node of list.querySelectorAll('[data-thumb]')) w.observer.observe(node);
}

async function fetchSharedThumbs(d) {
  const w = sharedThumbWork, v = sharedView;
  while (w.busy < 2 && w.queue.size) {
    const batch = [...w.queue].slice(0, 24);
    for (const [key] of batch) w.queue.delete(key);
    w.busy++;
    const share = v.share, path = v.path;
    const px = Math.min(256, Math.round(128 * (window.devicePixelRatio || 1)));
    const show = (node, src) => { const ic = node.querySelector('.shared-pic > :first-child'); if (ic && src) ic.replaceWith(el('img', { class: 'thumb', src, alt: '', decoding: 'async' })); };
    apiJson(sharedApi(d, 'thumbs'), jsonBody({ share, path, names: batch.map(([, node]) => node.dataset.rel), px })).then(r => {
      for (const [key, node] of batch) {
        const rel = node.dataset.rel, got = r.thumbs?.[rel];
        if (got) { sharedThumbs.set(key, `data:image/jpeg;base64,${got}`); show(node, sharedThumbs.get(key)); } else if (r.none?.includes(rel) || (w.tries.get(key) || 0) >= 1) sharedThumbs.set(key, '');
        else { w.tries.set(key, 1); if (share === v.share && path === v.path) w.queue.set(key, node); } // (not reached in time: once more)
      }
      while (sharedThumbs.size > 400) sharedThumbs.delete(sharedThumbs.keys().next().value);
    }).catch(() => {}).finally(() => { w.busy--; if (share === v.share && path === v.path) fetchSharedThumbs(d); });
  }
}

// (1.28) Names with q in the folder and every folder below it (the PC looks, a few seconds at most).
async function searchShared(text) {
  const q = text.trim();
  if (!q) return;
  const v = sharedView, d = v.device;
  const gen = ++v.gen;
  Object.assign(v, { search: { q, results: null }, filter: '', picked: new Map(), scroll: 0 });
  renderSharedFolder();
  let r;
  try { r = await apiJson(sharedApi(d, 'search'), jsonBody({ share: v.share, path: v.path, q })); } catch (err) {
    if (gen !== v.gen) return;
    v.search = null;
    renderSharedFolder();
    toast(friendlyError(err), { error: true });
    return;
  }
  if (gen !== v.gen) return;
  v.search = { q, results: r.results || [], more: Boolean(r.more) };
  renderSharedFolder();
  loadSharedIcons(d, v.search.results);
}

// (1.28) One file to look at before copying it, through the PC: a picture, a text's start, a PDF, a video's frame.
// ‹ › (and the arrow keys) step through the folder's files in the order shown; Back goes back to the folder.
async function openSharedPreview(list, index) {
  const v = sharedView, d = v.device, e = list[index];
  if (!e) return;
  if (!v.preview) v.scroll = $('#genBody .shared-list')?.scrollTop || 0;
  closeSharedPreview();
  const gen = ++v.gen;
  v.preview = { list, index, url: null };
  const stage = el('div', { class: 'shared-stage' }, el('p', { class: 'muted' }, 'Asking for it…'));
  const about = el('p', { class: 'muted small shared-about' }, [formatSize(e.s), e.m && `modified ${historyWhen(e.m)}`, e.c && `made ${historyWhen(e.c)}`, sharedTypeName(d, e), e.p && `in ${e.p.replaceAll('/', ' / ')}`].filter(Boolean).join(' · '));
  const step = by => el('button', { class: 'btn ghost', type: 'button', disabled: !list[index + by], 'aria-label': by < 0 ? 'The one before' : 'The next one', title: by < 0 ? 'The one before (←)' : 'The next one (→)', onclick: () => openSharedPreview(list, index + by) }, icon(by < 0 ? 'back' : 'next'));
  const back = el('button', { class: 'btn ghost', type: 'button', onclick: () => { v.gen++; closeSharedPreview(); renderSharedFolder(); } }, icon('folder'), 'Back to the folder');
  const copy = el('button', { class: 'btn primary', type: 'button', onclick: () => copyShared([e.rel], false) }, icon('download'), 'Copy to this device');
  showShared(`${d.name}: ${e.n}`, [el('div', { class: 'shared-preview' }, stage, about)], [back, step(-1), step(1), copy]);
  bindSharedKeys();
  const say = text => stage.replaceChildren(el('p', { class: 'muted shared-say' }, text));
  if (/\.pdf$/i.test(e.n) && navigator.pdfViewerEnabled === false) return say('This browser can’t show a PDF here: copy it to this device to open it.');
  let res;
  try { res = await api(sharedApi(d, 'preview'), jsonBody({ share: v.share, path: v.path, name: e.rel })); } catch (err) {
    if (gen === v.gen) say(err.status === 415 ? 'There’s no preview for this kind of file: copy it to this device to open it.' : friendlyError(err));
    return;
  }
  const kind = res.headers.get('X-Beam-Preview'), cut = res.headers.get('X-Beam-Truncated') === '1';
  const blob = await res.blob().catch(() => null);
  if (gen !== v.gen || !blob) return;
  if (kind === 'text') {
    const got = decodeText(new Uint8Array(await blob.arrayBuffer()), { cut });
    if (!got) return say('This doesn’t look like a text file: it has bytes no text has. Copy it to open it in an app.');
    const pre = el('pre', { class: 'file-preview' });
    const filter = lineFilter(pre);
    filter.set(got.text);
    stage.replaceChildren(filter.bar, pre);
    stage.classList.add('text');
    about.textContent = `${cut ? `The first ${formatSize(blob.size)} of ${formatSize(e.s)}` : formatSize(e.s)} · ${ENCODING_NAMES[got.encoding] || got.encoding} · ${about.textContent.split(' · ').slice(1).join(' · ')}`;
    return;
  }
  v.preview.url = URL.createObjectURL(blob);
  if (kind === 'pdf') stage.replaceChildren(el('iframe', { src: v.preview.url, title: e.n }));
  else stage.replaceChildren(...[el('img', { src: v.preview.url, alt: e.n }), kind === 'video' && el('p', { class: 'muted small shared-say' }, 'A picture from the video: copy it to this device to watch it.')].filter(Boolean));
}

function closeSharedPreview() {
  const p = sharedView.preview;
  if (p?.url) URL.revokeObjectURL(p.url);
  sharedView.preview = null;
}

let sharedKeysBound = false;
function bindSharedKeys() {
  if (sharedKeysBound) return;
  sharedKeysBound = true;
  $('#genDlg').addEventListener('keydown', ev => {
    const p = sharedView.preview;
    if (!p || dialogGen !== sharedView.dlgGen || ev.target.closest?.('input, textarea, select')) return;
    if (ev.key === 'ArrowLeft' && p.list[p.index - 1]) { ev.preventDefault(); openSharedPreview(p.list, p.index - 1); }
    else if (ev.key === 'ArrowRight' && p.list[p.index + 1]) { ev.preventDefault(); openSharedPreview(p.list, p.index + 1); }
  });
}

// The ticked files: the PC sends them to this device (an ordinary send from it). (1.28) Folders go as a .zip each.
function copySharedPicked() {
  const v = sharedView;
  return copyShared([...v.picked.keys()], [...v.picked.values()].some(Boolean));
}

async function copyShared(names, folders) {
  const v = sharedView, d = v.device;
  if (!names.length) return;
  let r;
  try { r = await apiJson(sharedApi(d, 'copy'), jsonBody({ share: v.share, path: v.path, names })); } catch (err) { toast(friendlyError(err), { error: true }); return; }
  const n = r.sending || 0, skipped = r.skipped || [];
  const left = skipped.length ? `${n ? ' (' : ': '}left out: ${skipped.map(s => `${s.n} (${s.why})`).join(', ')}${n ? ')' : ''}` : '';
  const zipped = folders && n ? ' Folders come as .zip files, once the PC has made them.' : '';
  toast(n ? `${d.name} is sending ${plural(n, 'file')}: they arrive in your conversation with it${left}.${zipped}` : `${d.name} sent nothing${left}.`, { ms: 6000, error: !n });
  if (v.preview) return;
  v.picked.clear();
  v.scroll = $('#genBody .shared-list')?.scrollTop || 0;
  renderSharedFolder();
}

// Settings → Control & sharing (host mode, Beam for Windows 1.18): the folders shared from here and who sees each (chosen
// only in the app's own window: Shared folders…).
function sharedPcCard(s) {
  if (!Array.isArray(s?.sharedFolders)) return null;
  const list = s.sharedFolders;
  return card('Shared folders',
    cardInfo(list.length
      ? 'The devices ticked for a folder can look in it and copy files from it, nothing else on this PC; they can’t change anything here.'
      : 'Nothing is shared: your other devices can’t see this PC’s files.'),
    ...list.map(f => el('div', { class: 'set-row set-share' }, el('span', { class: 'set-text' }, el('b', {}, f.name),
      el('small', { class: 'muted block' }, f.path), el('small', { class: 'block' }, f.devices?.length ? `Seen from ${f.devices.join(', ')}` : 'No device yet')))),
    hostHas('sharedFolders') && buttonRow(smallBtn('Shared folders…', async () => {
      const r = await hostDo('sharedFolders');
      if (r?.settings) { hostState.settings = r.settings; renderSettings(); }
    }, { ic: 'folder' })));
}
