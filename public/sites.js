'use strict';
// (1.31) Sites: the web pages your machines serve over Tailscale (the user, 2026-11-06: every Tailscale site they have,
// listed in Beam). The header's globe opens the list. Each PC's Beam for
// Windows (1.24) finds the pages that PC serves; others (a Raspberry Pi's, a NAS's) are added by address. The server
// checks each one when the list opens: whether it answers, its title and icon. GET /api/sites; the `sites` event says
// when the list changed or a check finished. Approved (trusted) sign-ins only.

let sitesState = null; // { sites, checking, checkedAt, error } while the list is open
let sitesEditing = null; // the site being renamed: the list isn't redrawn under its box
let sitesLoading = null;
let sitesHiddenOpen = false;

function updateSitesButton() {
  const btn = document.getElementById('sitesBtn');
  if (btn) btn.hidden = !(serverHas('sites') && me.trusted === true && !me.temporary);
}

function sitesOpen() {
  const dlg = document.getElementById('genDlg');
  return Boolean(dlg?.open && dlg.classList.contains('sites-dlg'));
}

function loadSites() {
  sitesLoading ||= (async () => {
    try {
      const r = await apiJson('api/sites');
      sitesState = { sites: Array.isArray(r.sites) ? r.sites : [], checking: Boolean(r.checking), checkedAt: Number(r.checkedAt) || 0, error: '' };
    } catch (err) {
      sitesState = { sites: sitesState?.sites || [], checking: false, checkedAt: sitesState?.checkedAt || 0, error: friendlyError(err) };
    }
    renderSites();
  })().finally(() => { sitesLoading = null; });
  return sitesLoading;
}

function onSitesEvent() {
  if (sitesOpen()) loadSites();
}

function openSites() {
  sitesEditing = null;
  sitesState = null;
  openDialog({
    title: 'Sites',
    className: 'sites-dlg',
    body: [
      el('div', { id: 'sitesHead', class: 'sites-head' }),
      el('ul', { id: 'sitesList', class: 'site-list', 'aria-label': 'Your sites' }, el('li', { class: 'muted small site-empty' }, 'Loading…')),
      el('div', { id: 'sitesHidden' }),
      addSiteForm(),
    ],
    onClose: () => { sitesState = null; sitesEditing = null; },
  });
  loadSites();
}

function renderSites() {
  if (!sitesOpen() || !sitesState) return;
  const { sites, checking, checkedAt, error } = sitesState;
  $('#sitesHead').replaceChildren(
    el('span', { class: 'muted small', role: 'status' }, checking ? 'Checking each site…' : checkedAt ? `Checked at ${clock(checkedAt)}` : ''),
    el('button', { class: 'btn ghost small-btn', type: 'button', disabled: checking, onclick: refreshSites }, icon('refresh'), 'Check again'),
    error && el('p', { class: 'warn small sites-error' }, error));
  if (sitesEditing) return;
  const shown = sites.filter(s => !s.hidden);
  const hidden = sites.filter(s => s.hidden);
  $('#sitesList').replaceChildren(...(shown.length ? shown.map(siteRow) : [el('li', { class: 'muted small site-empty' },
    'No sites yet. Beam for Windows lists the web pages each PC serves on Tailscale by itself; add others below.')]));
  if (!hidden.length) { $('#sitesHidden').replaceChildren(); return; }
  const details = el('details', { class: 'sites-hidden', open: sitesHiddenOpen }, el('summary', {}, `Hidden (${hidden.length})`),
    el('ul', { class: 'site-list', 'aria-label': 'Hidden sites' }, ...hidden.map(siteRow)));
  details.addEventListener('toggle', () => { sitesHiddenOpen = details.open; });
  $('#sitesHidden').replaceChildren(details);
}

function siteState(s) {
  if (s.up === true) return { cls: 'up', text: 'Answering' };
  if (s.up === false) return { cls: 'down', text: `Not answering: ${s.problem || 'no answer'}` };
  return { cls: 'unknown', text: sitesState?.checking ? 'Checking…' : 'Not checked yet' };
}

function siteRow(s) {
  const state = siteState(s);
  const where = s.kind === 'found' ? `on ${s.deviceName || 'a PC'}` : 'added';
  const letter = (String(s.name).match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();
  const pic = s.icon && /^data:image\/(png|gif|jpeg|webp|x-icon);base64,/.test(s.icon)
    ? el('img', { class: 'site-icon', src: s.icon, alt: '', width: 32, height: 32, decoding: 'async' })
    : el('span', { class: 'site-icon letter', 'aria-hidden': 'true' }, letter);
  return el('li', { class: `site-row ${state.cls}`, 'data-site': s.id },
    el('a', { class: 'site-link', href: s.url, target: '_blank', rel: 'noopener noreferrer', title: s.url, onclick: e => { if (HOST) { e.preventDefault(); openLink(s.url); } } },
      pic,
      el('span', { class: 'site-text' },
        el('strong', { class: 'site-name' }, s.name),
        el('span', { class: 'muted small' }, `${s.host} · ${where}`),
        s.up === false && el('span', { class: 'warn small' }, state.text))),
    el('span', { class: `site-dot ${state.cls}`, role: 'img', 'aria-label': state.text, title: state.text }),
    el('button', { class: 'icon-btn small', type: 'button', 'aria-label': `More for ${s.name}`, 'aria-haspopup': 'menu', onclick: e => siteMenu(s, e.currentTarget) }, icon('more')));
}

function siteMenu(s, at) {
  openMenu([
    { label: 'Open', icon: 'open', action: () => openLink(s.url) },
    { label: 'Copy address', icon: 'copy', action: () => copyText(s.url, 'Address copied') },
    { label: 'Rename', icon: 'edit', action: () => renameSite(s) },
    s.renamed && { label: s.kind === 'found' || s.title ? 'Use the page’s own title' : 'Use its address as the name', icon: 'undo', action: () => patchSite(s, { name: null }) },
    'sep',
    s.kind === 'found'
      ? (s.hidden ? { label: 'Show it again', icon: 'eye', action: () => patchSite(s, { hidden: false }) } : { label: 'Hide', icon: 'x', action: () => patchSite(s, { hidden: true }) })
      : { label: 'Remove', icon: 'trash', danger: true, action: () => removeSite(s) },
  ], at, { label: s.name });
}

async function refreshSites() {
  if (!sitesState) return;
  sitesState.checking = true;
  renderSites();
  try { await api('api/sites/check', { method: 'POST' }); } catch (err) { toast(friendlyError(err), { error: true }); loadSites(); }
}

async function patchSite(s, change) {
  try {
    await api(`api/sites/${encodeURIComponent(s.id)}`, jsonBody(change, 'PATCH'));
    if (change.hidden === true) toast(`${s.name} is hidden`, { action: 'Undo', onAction: () => patchSite(s, { hidden: false }) });
  } catch (err) {
    toast(friendlyError(err), { error: true });
  }
  await loadSites();
}

// Removed at once, with Undo (a question would replace the list: both are this window).
async function removeSite(s) {
  try {
    await api(`api/sites/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
    toast(`${s.name} removed`, { action: 'Undo', onAction: () => addSite(s.url, s.renamed ? s.name : '') });
  } catch (err) {
    toast(friendlyError(err), { error: true });
  }
  await loadSites();
}

async function addSite(url, name) {
  try {
    const r = await apiJson('api/sites', jsonBody({ url, ...(name && { name }) }));
    await loadSites();
    return r.site;
  } catch (err) {
    toast(friendlyError(err), { error: true });
    return null;
  }
}

function renameSite(s) {
  const row = [...document.querySelectorAll('#genBody [data-site]')].find(r => r.dataset.site === s.id);
  if (!row) return;
  sitesEditing = s.id;
  const input = el('input', { type: 'text', class: 'site-name-input', value: s.name, maxlength: '60', 'aria-label': `New name for ${s.name}`, spellcheck: 'false', autocomplete: 'off' });
  let finished = false;
  const done = async save => {
    if (finished) return;
    finished = true;
    sitesEditing = null;
    const name = input.value.trim();
    if (save && name !== s.name) await patchSite(s, { name: name || null });
    else renderSites();
  };
  // Esc ends the rename, not the whole window
  input.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } });
  row.replaceChildren(el('form', { class: 'site-rename', onsubmit: e => { e.preventDefault(); done(true); } },
    input,
    el('button', { class: 'btn primary small-btn', type: 'submit' }, 'Save'),
    el('button', { class: 'btn ghost small-btn', type: 'button', onclick: () => done(false) }, 'Cancel')));
  input.focus();
  input.select();
}

function addSiteForm() {
  const input = el('input', { type: 'text', id: 'siteAddress', placeholder: 'http://my-pi:8080', 'aria-label': 'The site’s address', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', inputmode: 'url' });
  const btn = el('button', { class: 'btn primary', type: 'submit' }, 'Add');
  const form = el('form', { class: 'linkrow site-add', onsubmit: async e => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url) { input.focus(); return; }
    btn.disabled = true;
    const site = await addSite(url, '');
    btn.disabled = false;
    if (site) { input.value = ''; toast(`${site.name} added${site.up === false ? ' (it isn’t answering yet)' : ''}`); }
  } }, input, btn);
  return el('div', { class: 'sites-add' },
    el('p', { class: 'field-label' }, 'Add a site'),
    form,
    el('p', { class: 'muted small' }, 'For a machine without Beam for Windows, like a Raspberry Pi or a NAS: its Tailscale name and port work from every device.'));
}
