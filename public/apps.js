'use strict';
// (1.21) Settings → Apps: the user's own apps on their PCs (the user: "i want to be able to easily install it on all my
// beam devices"). An app comes from a GitHub repository's latest release, a file sent here, or winget; Install on all
// PCs asks each PC's Beam app (Windows 1.16 or later), which asks once there before installing anything (Install,
// Always allow, Not now: the user's choice). GET /api/apps; the `apps` event says when it changed.

let appsState = null; // { apps, error } while Settings is open (null: not loaded)

async function loadApps() {
  if (!serverHas('apps')) return;
  try {
    const r = await apiJson('api/apps');
    appsState = { apps: Array.isArray(r.apps) ? r.apps : [], error: '' };
  } catch (err) {
    appsState = { apps: appsState?.apps || [], error: friendlyError(err) };
  }
  if ($('#settingsDlg').open) renderSettings();
}

function onAppsEvent() {
  if (appsState && $('#settingsDlg').open) loadApps();
}

const appPcs = () => devices.filter(d => d.platform === 'windows' && !d.temporary);

function sectionApps() {
  if (!appsState) { loadApps(); return note('Loading…'); }
  const pcs = appPcs();
  const older = pcs.filter(d => !d.can?.apps);
  return [
    note('Your own apps on your PCs: from a GitHub repository’s releases, a file you send, or winget. The first time, each PC asks before Beam installs anything there (Install, Always allow, Not now). Apps go in for the PC’s signed-in user; Beam never installs as administrator (an installer that needs that asks on the PC).'),
    appsState.error && el('p', { class: 'warn small' }, appsState.error),
    appsState.apps.length ? el('ul', { class: 'app-list' }, ...appsState.apps.map(appRow)) : note('No apps yet: add one below.'),
    el('h4', {}, 'Add an app'),
    ...addAppRows(),
    older.length > 0 && note(`${older.map(d => d.name).join(', ')} ${older.length > 1 ? 'need' : 'needs'} Beam for Windows 1.16 or later to install apps.`),
  ];
}

// One app: what it is, where it's installed, and what can be done with it.
function appRow(a) {
  const pcs = appPcs().filter(d => d.can?.apps);
  const source = a.kind === 'github' ? `GitHub ${a.source}` : a.kind === 'winget' ? `winget ${a.source}` : 'a file you sent';
  const file = a.file ? `${a.file.name}, ${formatSize(a.file.size)}` : '';
  const sum = a.kind === 'github' && a.file ? (a.checksum ? 'checked against the release’s SHA-256' : 'the release publishes no checksum') : '';
  const status = a.state === 'fetching' ? 'Getting its latest release from GitHub…' : a.state === 'failed' ? `Couldn’t get it: ${a.error || 'unknown error'}` : '';
  const where = Object.entries(a.on || {}).map(([id, s]) => ({ d: deviceById(id), s })).filter(x => x.d);
  const ready = a.state === 'ready';
  const notYet = pcs.filter(d => !a.on?.[d.id] || ['failed', 'declined'].includes(a.on[d.id].state));
  const button = (label, ic, action, extra = {}) => el('button', { class: 'btn small-btn', type: 'button', onclick: action, ...extra }, ic && icon(ic), label);
  const menuAt = e => e.currentTarget;
  return el('li', { class: 'app-row', 'data-app': a.id },
    el('div', { class: 'app-head' }, el('strong', {}, a.name), a.version && el('span', { class: 'muted' }, ` ${a.version}`)),
    el('p', { class: 'muted small' }, [source, file, sum].filter(Boolean).join(' · ')),
    status && el('p', { class: a.state === 'failed' ? 'warn small' : 'small' }, status),
    a.checkError && el('p', { class: 'warn small' }, `The last check for a new release failed: ${a.checkError}`),
    where.length > 0 && el('ul', { class: 'plain app-where' }, ...where.map(({ d, s }) => el('li', { class: 'small' },
      el('span', {}, `${d.name}: ${appStateText(s, d)}`),
      s.state === 'installed' && el('button', { class: 'linkish', type: 'button', onclick: () => uninstallApp(a, d) }, 'Uninstall'),
      // (1.16.1) This PC's own question: the Windows app's window for it
      s.state === 'asked' && d.id === me.id && hostHas('appAsk') && el('button', { class: 'linkish', type: 'button', onclick: () => hostDo('appAsk', { app: a.id }) }, 'Answer…')))),
    el('div', { class: 'dev-actions' },
      ready && pcs.length > 0 && button('Install on all PCs', 'download', () => installApp(a, 'all'), { 'data-act': 'install-all' }),
      ready && notYet.length > 0 && button('Install on…', null, e => openMenu(notYet.map(d => ({ label: d.name, icon: 'monitor', action: () => installApp(a, [d.id]) })), menuAt(e), { label: 'Install on' }), { 'data-act': 'install-on' }),
      a.kind === 'github' && a.state !== 'fetching' && button(a.state === 'failed' ? 'Try again' : 'Check for a new version', 'refresh', () => checkApp(a)),
      a.kind === 'file' && button('Send a new version…', 'upload', () => pickAppFile(a)),
      el('button', { class: 'btn small-btn ghost', type: 'button', onclick: () => removeApp(a) }, 'Remove…')),
    ...appOptions(a));
}

function appStateText(s, d) {
  const v = s.version ? ` ${s.version}` : '';
  switch (s.state) {
    case 'installed': return `installed${v}`;
    case 'pending': return d.online ? `asked${s.version ? ` (has${v})` : ''}` : 'asked: when it’s online';
    case 'asked': return d.id === me.id ? 'waiting for an answer on this PC' : 'waiting for an answer at the PC (Beam shows the question there)';
    case 'installing': return 'installing…';
    case 'failed': return `couldn’t install: ${s.error || 'no reason given'}`;
    case 'declined': return 'not now (chosen at the PC)';
    case 'removing': return d.online ? 'uninstalling…' : 'uninstalls when it’s online';
    default: return s.state;
  }
}

// Its options where they matter: another file of the release, the program in a .zip, an installer's switches.
function appOptions(a) {
  const out = [];
  const set = async (fields, what) => {
    try {
      await apiJson(`api/apps/${a.id}`, jsonBody(fields, 'PATCH'));
      toast(`${what} saved`);
      loadApps();
    } catch (err) { toast(friendlyError(err)); }
  };
  if (a.kind === 'github' && Array.isArray(a.choices) && a.choices.length > 1 && !a.asset) {
    const box = el('select', { 'aria-label': 'Which file of the release' }, ...a.choices.map(n => el('option', { value: n, selected: n === a.file?.name }, n)));
    box.addEventListener('change', () => set({ asset: box.value }, 'The file'));
    out.push(field('The release has several Windows files: this one', box));
  }
  if (a.file?.type === 'zip') {
    const input = el('input', { type: 'text', value: a.run || '', placeholder: 'its only .exe, or the one named like the app', 'aria-label': 'The program in the .zip' });
    input.addEventListener('change', () => set({ run: input.value.trim() || null }, 'The program'));
    out.push(field('The program in the .zip (the Start menu shortcut starts it)', input));
  }
  if (a.file && (a.file.type === 'msi' || (a.file.type === 'exe' && (/setup|install/i.test(a.file.name) || a.args)))) {
    const input = el('input', { type: 'text', value: a.args || '', placeholder: a.file.type === 'msi' ? 'more MSI properties (optional)' : 'for a quiet install, like /S or /VERYSILENT', 'aria-label': 'Switches for its installer' });
    input.addEventListener('change', () => set({ args: input.value.trim() || null }, 'The switches'));
    out.push(field('Switches for its installer', input));
  }
  return out;
}

function addAppRows() {
  const gh = el('input', { type: 'text', placeholder: 'owner/repo, or its github.com link', 'aria-label': 'GitHub repository', autocomplete: 'off', spellcheck: 'false' });
  const wg = el('input', { type: 'text', placeholder: 'a winget id, like 7zip.7zip', 'aria-label': 'winget id', autocomplete: 'off', spellcheck: 'false' });
  const add = async (body, input, btn) => {
    if (!input.value.trim()) return input.focus();
    btn.disabled = true;
    try {
      const r = await apiJson('api/apps', jsonBody(body(input.value.trim())));
      input.value = '';
      toast(r.app?.state === 'fetching' ? `Getting ${r.app.name} from GitHub…` : `${r.app?.name || 'The app'} added`);
      loadApps();
    } catch (err) { toast(friendlyError(err)); } finally { btn.disabled = false; }
  };
  const ghAdd = el('button', { class: 'btn small-btn primary', type: 'button', 'data-act': 'add-github', onclick: () => add(v => ({ github: v }), gh, ghAdd) }, 'Add');
  const wgAdd = el('button', { class: 'btn small-btn', type: 'button', 'data-act': 'add-winget', onclick: () => add(v => ({ winget: v }), wg, wgAdd) }, 'Add');
  gh.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ghAdd.click(); } });
  wg.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); wgAdd.click(); } });
  return [
    field('From GitHub', row(gh, ghAdd), note('Its latest published release: the Windows .exe, .msi or .zip, checked against the SHA-256 the release publishes when it publishes one. Beam looks for a new release every 6 hours, and the PCs that have it get it too.')),
    field('From winget', row(wg, wgAdd), note('Each PC installs it with winget itself (Windows 10 and 11; Windows Server 2019 doesn’t have winget). Installing accepts the app’s license, as winget’s own “yes” would.')),
    field('A file', row(el('button', { class: 'btn small-btn', type: 'button', onclick: () => pickAppFile(null) }, icon('upload'), 'Choose a file…')),
      note('An .exe (the app itself, or a setup program), an .msi or a .zip, up to 2 GB.')),
  ];
}

// A file for a new app, or a new version of `app`.
function pickAppFile(app) {
  const input = el('input', { type: 'file', accept: '.exe,.msi,.zip' });
  input.addEventListener('change', () => { if (input.files?.[0]) sendAppFile(input.files[0], app); });
  input.click();
}

async function sendAppFile(file, app) {
  if (!/\.(exe|msi|zip)$/i.test(file.name)) return toast('Only an .exe, .msi or .zip');
  const q = new URLSearchParams({ name: file.name });
  if (app) q.set('app', app.id);
  toast(`Sending ${file.name} (${formatSize(file.size)})…`);
  try {
    const r = await apiJson(`api/apps/file?${q}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    toast(app ? `${r.app?.name || 'The app'}: the new version is in Beam` : `${r.app?.name || 'The app'} added`);
    loadApps();
  } catch (err) { toast(friendlyError(err)); }
}

async function installApp(a, which) {
  try {
    const r = await apiJson(`api/apps/${a.id}/install`, jsonBody({ devices: which }));
    toast(`${a.name}: asked ${r.asked.join(', ')}${r.cannot?.length ? ` (${r.cannot.join(', ')} can’t yet)` : ''}`);
    loadApps();
  } catch (err) { toast(friendlyError(err)); }
}

async function uninstallApp(a, d) {
  const ok = await confirmDialog({ title: `Uninstall ${a.name} from ${d.name}?`, text: `Beam removes what it installed there${d.online ? '' : ', once the PC is online'}.`, confirm: 'Uninstall', danger: true });
  if (!ok) return;
  try {
    await apiJson(`api/apps/${a.id}/uninstall`, jsonBody({ devices: [d.id] }));
    loadApps();
  } catch (err) { toast(friendlyError(err)); }
}

async function checkApp(a) {
  toast(`Looking for a new release of ${a.name}…`);
  try {
    const r = await apiJson(`api/apps/${a.id}/check`, jsonBody({}));
    const b = r.app || {};
    toast(b.state === 'failed' ? `Couldn’t get it: ${b.error}` : b.checkError ? `The check failed: ${b.checkError}` : b.version && b.version !== a.version ? `${b.name} ${b.version} is in Beam` : `${b.name} is up to date`);
    loadApps();
  } catch (err) { toast(friendlyError(err)); }
}

async function removeApp(a) {
  const on = Object.values(a.on || {}).filter(s => s.state === 'installed').length;
  const ok = await confirmDialog({
    title: `Remove ${a.name} from Beam?`, confirm: 'Remove', danger: true,
    text: on ? `The ${on > 1 ? `${on} PCs` : 'PC'} that have it keep it: uninstall it there first to remove it from them too.` : 'Beam forgets it and its file.',
  });
  if (!ok) return;
  try {
    await api(`api/apps/${a.id}`, { method: 'DELETE' });
    loadApps();
  } catch (err) { toast(friendlyError(err)); }
}

// This PC (host mode): Beam installs apps here without asking only once someone here allowed it.
function appsPcRows(s) {
  if (typeof s?.appsAllowed !== 'boolean') return [];
  return [
    el('h4', {}, 'Apps'),
    s.appsAllowed
      ? el('div', { class: 'field' }, el('p', { class: 'small' }, 'On: apps you install from Beam’s Apps page on your other devices go onto this PC without asking, each with a notice.'),
        el('div', { class: 'dev-actions' }, el('button', { class: 'btn small-btn ghost', type: 'button', onclick: async () => {
          const r = await hostDo('setSettings', { settings: { appsAllowed: false } });
          if (r?.settings) { hostState.settings = r.settings; renderSettings(); }
        } }, icon('power'), 'Ask first again')))
      : el('div', { class: 'field' }, el('p', { class: 'small' }, 'Beam asks here before installing an app from your other devices (Install, Always allow, Not now).'),
        hostHas('allowApps') && el('div', { class: 'dev-actions' }, el('button', { class: 'btn small-btn', type: 'button', onclick: async () => {
          const r = await hostDo('allowApps');
          if (r?.settings) { hostState.settings = r.settings; renderSettings(); }
        } }, 'Let Beam install apps…'))),
  ];
}
