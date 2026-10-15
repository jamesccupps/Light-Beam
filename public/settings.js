'use strict';
// Settings and the "Add a device" dialog. (Remade 2026-10-15, the user: "its not very easyy to usee, it seems like it
// could be grouped and done better".) One page at a time, grouped by what it's about: this PC (or browser), all your
// devices, your Beam. A search over every page's rows. Each page is cards of rows, with switches for on/off. On a phone
// the list of pages comes first, and a page has ‹ back. Only what's shown is built, so an event redraws one page.

let settingsSection = 'general'; // the page shown (kept while Settings is closed: it opens where it was)
let settingsQuery = '';          // the search box: every page's matching rows instead of one page
let settingsList = false;        // a phone showing the list of pages rather than a page
let serverSettings = null; // API v3 GET /api/settings
const SETTINGS_PAGES = [
  { id: 'general', title: 'General', icon: 'gear', group: 'here' },
  { id: 'receiving', title: 'Receiving', icon: 'arrow-down', group: 'here', when: () => Boolean(HOST) },
  { id: 'sending', title: 'Sending', icon: 'send', group: 'here', when: () => Boolean(HOST) },
  { id: 'notifications', title: 'Notifications', icon: 'bell', group: 'here' },
  { id: 'control', title: 'Control & sharing', icon: 'screen', group: 'here', when: () => hasControlPage() },
  { id: 'help', title: 'Shortcuts', icon: 'keyboard', group: 'here' },
  { id: 'devices', title: 'Devices', icon: 'phone', group: 'all' },
  { id: 'apps', title: 'Apps', icon: 'download', group: 'all', when: () => serverHas('apps') }, // (1.21: apps.js)
  { id: 'alerts', title: 'Alerts', icon: 'alert', group: 'all', when: () => alertsSupported() },
  { id: 'connections', title: 'Connections', icon: 'globe', group: 'all', when: () => serverHas('connections') }, // (1.17)
  { id: 'security', title: 'Security', icon: 'shield', group: 'beam' },
  { id: 'server', title: 'Server', icon: 'server', group: 'beam' },
];
const SETTINGS_GROUPS = { here: () => (HOST ? 'This PC' : 'This device'), all: () => 'All devices', beam: () => 'Your Beam' };
const SETTINGS_OLD = { device: 'general', pc: 'general' }; // the sections before the remake (the tray's Settings asks for 'pc')
const DEVICE_PAGES = new Set(['devices', 'notifications', 'alerts']); // pages that list the devices
const visiblePages = () => SETTINGS_PAGES.filter(p => !p.when || p.when());
const settingsNarrow = () => matchMedia('(max-width: 760px)').matches;
const settingsShowsDevices = () => Boolean(settingsQuery.trim()) || DEVICE_PAGES.has(settingsSection);

// `section`: a page to open (an old section name works too); none: where it was (a phone: the list of pages).
async function openSettings(section = null) {
  const id = SETTINGS_OLD[section] || section;
  settingsQuery = '';
  $('#settingsSearch').value = '';
  if (id) { settingsSection = id; settingsList = false; } else settingsList = settingsNarrow();
  backupState = null; // (1.8.1: the Server page asks again)
  connState = null; // (1.17: so does Connections)
  setupView = null; // (1.20: and the setup check)
  appsState = null; // (1.21: and the apps)
  const dlg = $('#settingsDlg');
  renderSettings();
  if (!dlg.open) dlg.showModal();
  $('#settingsBody').scrollTop = 0;
  await Promise.all([loadServerInfo(), loadServerSettings()]);
  await loadRcSessions(); // (who controls which PC; `rc-sessions` keeps it current)
  if (dlg.open) renderSettings();
  if (HOST) hostCall('getSettings').then(r => { if (r?.settings) { hostState.settings = r.settings; if (dlg.open) renderSettings(); } }).catch(() => {});
}

async function loadServerSettings() {
  if (!serverHas('settings')) return null;
  try {
    const res = await apiJson('api/settings');
    serverSettings = res.settings || res;
  } catch { serverSettings = null; }
  return serverSettings;
}

function showSettingsPage(id) {
  settingsSection = SETTINGS_OLD[id] || id;
  settingsList = false;
  if (settingsQuery) { settingsQuery = ''; $('#settingsSearch').value = ''; }
  renderSettings();
  $('#settingsBody').scrollTop = 0;
}
const jumpToSection = showSettingsPage; // (its name before the remake)

// The search box, ‹ back and the keys (once: the dialog's own controls are in index.html).
function bindSettings() {
  const search = $('#settingsSearch');
  let queued = 0;
  search.addEventListener('input', () => {
    settingsQuery = search.value;
    cancelAnimationFrame(queued);
    queued = requestAnimationFrame(() => { renderSettings(); $('#settingsBody').scrollTop = 0; });
  });
  search.addEventListener('keydown', e => {
    if (e.key === 'Escape' && search.value) { e.preventDefault(); e.stopPropagation(); search.value = ''; settingsQuery = ''; renderSettings(); }
    if (e.key === 'Enter') { e.preventDefault(); $('#settingsBody').querySelector('button, input, select')?.focus(); }
  });
  $('#settingsBack').addEventListener('click', () => {
    if (settingsQuery) { search.value = ''; settingsQuery = ''; }
    settingsList = true;
    renderSettings();
    $('#settingsNav').querySelector(`[data-page="${settingsSection}"]`)?.focus();
  });
  $('#settingsDlg').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); search.focus(); search.select(); }
  });
  matchMedia('(max-width: 760px)').addEventListener('change', () => { if ($('#settingsDlg').open) renderSettings(); });
}

function renderSettings() {
  const body = $('#settingsBody');
  // Don't pull a text box out from under the user's fingers: re-render later.
  const active = body.contains(document.activeElement) ? document.activeElement : null;
  if (active && /TEXTAREA|SELECT/.test(active.tagName) || (active?.tagName === 'INPUT' && !['checkbox', 'radio'].includes(active.type))) {
    clearTimeout(renderSettings.later);
    renderSettings.later = setTimeout(renderSettings, 1500);
    return;
  }
  const pages = visiblePages();
  if (!pages.some(p => p.id === settingsSection)) settingsSection = pages[0].id;
  const page = pages.find(p => p.id === settingsSection);
  const searching = Boolean(settingsQuery.trim());
  const dlg = $('#settingsDlg');
  const listing = settingsList && !searching;
  dlg.classList.toggle('on-list', listing);
  dlg.classList.toggle('on-page', !listing && !searching);
  dlg.classList.toggle('searching', searching);
  $('#settingsTitle').textContent = !listing && !searching && settingsNarrow() ? page.title : 'Settings';
  renderSettingsNav(pages, searching);
  // A toggle or button keeps the focus across the re-render (keyboard users stay where they were).
  const controls = () => [...body.querySelectorAll('button, input, select')];
  const focusAt = active ? controls().indexOf(active) : -1;
  const shown = searching ? `?${settingsQuery.trim().toLowerCase()}` : page.id;
  const top = body.scrollTop;
  body.replaceChildren(...(listing && settingsNarrow() ? [] : searching ? settingsSearchResults(pages) : [settingsPageNode(page)]));
  body.scrollTop = body.dataset.shown === shown ? top : 0;
  body.dataset.shown = shown;
  if (focusAt >= 0) controls()[focusAt]?.focus({ preventScroll: true });
}

// The list of pages, by group. Built again only when which pages show changes (the focus stays on its button).
function renderSettingsNav(pages, searching) {
  const nav = $('#settingsNav');
  const key = `${HOST ? 'app' : 'web'}:${pages.map(p => p.id).join()}`;
  if (nav.dataset.key !== key) {
    const had = nav.contains(document.activeElement) ? document.activeElement.dataset.page : null;
    const groups = [];
    for (const p of pages) {
      let g = groups.find(x => x.id === p.group);
      if (!g) groups.push(g = { id: p.group, pages: [] });
      g.pages.push(p);
    }
    nav.replaceChildren(...groups.map(g => el('div', { class: 'set-group', role: 'group', 'aria-labelledby': `set-g-${g.id}` },
      el('div', { class: 'set-group-label', id: `set-g-${g.id}` }, SETTINGS_GROUPS[g.id]()),
      ...g.pages.map(p => el('button', { type: 'button', 'data-page': p.id, 'data-section': p.id, onclick: () => showSettingsPage(p.id) },
        icon(p.icon), el('span', {}, p.title), icon('next', 'i chev'))))));
    nav.dataset.key = key;
    if (had) nav.querySelector(`[data-page="${had}"]`)?.focus({ preventScroll: true });
  }
  for (const b of nav.querySelectorAll('button')) b.setAttribute('aria-current', String(!searching && b.dataset.page === settingsSection));
}

// (Looked up when a page is drawn: apps.js and devices.js load after this script.)
const PAGE_BUILDERS = {
  general: () => pageGeneral(), receiving: () => pageReceiving(), sending: () => pageSending(), notifications: () => pageNotifications(),
  control: () => pageControl(), help: () => pageHelp(), devices: () => pageDevices(), apps: () => sectionApps(), alerts: () => sectionAlerts(),
  connections: () => sectionConnections(), security: () => sectionSecurity(), server: () => sectionServer(),
};

function settingsPageNode(p, { search = false } = {}) {
  return el('section', { class: 'set-page', id: `set-${p.id}`, 'aria-labelledby': `set-h-${p.id}` },
    el('h3', { id: `set-h-${p.id}` }, search
      ? el('button', { class: 'set-goto', type: 'button', onclick: () => showSettingsPage(p.id) }, p.title, icon('next', 'i tiny'))
      : p.title),
    ...[].concat(PAGE_BUILDERS[p.id]()).filter(Boolean));
}

// Searching: every page, keeping the cards whose title matches and, in the others, the rows that match; a page whose
// name matches shows whole. The rows work as they do on their page.
function settingsSearchResults(pages) {
  const q = settingsQuery.trim().toLowerCase();
  const hit = node => node.textContent.toLowerCase().includes(q);
  const out = [];
  for (const p of pages) {
    const node = settingsPageNode(p, { search: true });
    if (!p.title.toLowerCase().includes(q)) {
      let shown = 0;
      for (const c of node.querySelectorAll(':scope > .set-card')) {
        const title = c.querySelector(':scope > h4');
        if (title && hit(title)) { shown++; continue; }
        let rows = 0;
        for (const r of c.querySelectorAll(':scope > .set-rows > *')) { r.hidden = !hit(r); if (!r.hidden) rows++; }
        c.hidden = !rows;
        shown += rows;
      }
      for (const x of node.querySelectorAll(':scope > :not(h3):not(.set-card)')) x.hidden = true;
      if (!shown) continue;
    }
    out.push(node);
  }
  return out.length ? out : [el('p', { class: 'set-empty muted' }, `No settings match “${settingsQuery.trim()}”.`)];
}

// ---------------------------------------------------------------- building blocks
// A page is cards (a title, then rows). Other scripts use them too (devices.js, apps.js, files.js).

const field = (label, ...children) => el('div', { class: 'field' }, el('span', { class: 'field-label' }, label), ...children);
const note = text => el('p', { class: 'muted small' }, text);
const row = (...children) => el('div', { class: 'linkrow' }, ...children);
// `sw`: a switch row for Settings and Device info (still a checkbox, so a label click and the keyboard work as before).
function toggle(label, checked, onchange, { hint, disabled, sw = false } = {}) {
  const input = el('input', { type: 'checkbox', checked: Boolean(checked), disabled: Boolean(disabled), role: sw ? 'switch' : null });
  input.addEventListener('change', () => onchange(input.checked, input));
  const text = el('span', {}, label, hint && el('small', { class: 'muted block' }, hint));
  return sw ? el('label', { class: `check switch set-row${disabled ? ' off' : ''}` }, text, input) : el('label', { class: 'check' }, input, text);
}
const switchRow = (label, checked, onchange, opts = {}) => toggle(label, checked, onchange, { ...opts, sw: true });
function card(title, ...rows) {
  const list = rows.flat(2).filter(Boolean);
  return list.length ? el('div', { class: 'set-card' }, title && el('h4', {}, title), el('div', { class: 'set-rows' }, ...list)) : null;
}
// A card whose rows are a list (`li`s): devices, apps, connections.
const listCard = (title, items, extra = {}) => el('div', { class: 'set-card' }, title && el('h4', {}, title), el('ul', { class: 'set-rows set-list', ...extra }, ...items));
const cardInfo = (text, cls = '') => el('p', { class: `set-row set-info small${cls ? ` ${cls}` : ' muted'}` }, text);
const intro = (...text) => el('p', { class: 'set-intro muted small' }, ...text);
// A label (and its hint) on the left, its control on the right.
const inlineRow = (label, control, hint) => el('div', { class: 'set-row set-inline' }, el('span', { class: 'set-text' }, label, hint && el('small', { class: 'muted block' }, hint)), control);
// A label over what goes with it (a text box, a folder, a list).
const stackRow = (label, ...children) => el('div', { class: 'set-row set-stack' }, label && el('span', { class: 'set-label' }, label), ...children);
function buttonRow(...buttons) {
  const list = buttons.flat().filter(Boolean);
  return list.length ? el('div', { class: 'set-row set-buttons' }, ...list) : null;
}
const smallBtn = (label, onclick, { kind = '', ic = null, ...attrs } = {}) => el('button', { class: `btn small-btn${kind ? ` ${kind}` : ''}`, type: 'button', onclick, ...attrs }, ic && icon(ic), label);

// ---------------------------------------------------------------- General (this PC, browser or computer)

function pageGeneral() {
  // (1.23.2) A page that's part of a Beam app (Beam for Linux's window, a browser next to the app) has the app's name:
  // Beam for Linux takes it from here, the others in their own settings.
  const app = linkedApp();
  const input = el('input', { type: 'text', maxlength: '40', autocomplete: 'off', value: app ? app.name : me.name, 'aria-label': 'This device’s name', disabled: Boolean(app) && app.platform !== 'linux' });
  input.addEventListener('change', () => renameThisDevice(input.value));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  const about = HOST ? 'How this PC appears on your other devices.'
    : app?.platform === 'linux' ? 'How this computer appears on your other devices.'
    : app ? `This browser is part of ${app.name}: its Beam app sets the name.`
    : 'How this browser appears on your other devices.';
  const name = stackRow('Name', input, el('small', { class: 'muted' }, about));
  if (HOST) {
    const s = hostState.settings;
    if (!s) return card('This PC', name, cardInfo('Loading…'));
    const srv = s.server || {};
    return [
      card('This PC', name, switchRow('Start Beam when I sign in to Windows', s.autostart, (v, box) => setHostSettings({ autostart: v }, box))),
      appUpdatesCard(s),
      // (1.8.1) This PC's settings are kept on the server too; the app puts a backup back (its native choice).
      hostHas('restoreSettings') && serverHas('backups') && card('Settings backup',
        cardInfo(deviceById(me.id)?.backup?.at
          ? `This PC’s settings are kept on your Beam too (last ${timeAgo(deviceById(me.id).backup.at)}). After a reinstall, Beam offers to put them back.`
          : 'This PC’s settings are kept on your Beam too, from the next change on. After a reinstall, Beam offers to put them back.'),
        buttonRow(smallBtn('Restore settings…', () => hostDo('restoreSettings')))),
      card('Connected to',
        cardInfo(`${srv.url || location.origin}${srv.version ? ` · Beam ${srv.version}` : ''}${srv.storage ? ` · ${formatSize(srv.storage.used)} used, ${formatSize(srv.storage.free)} free` : ''}${srv.connected === false ? ' · not connected' : ''}`),
        buttonRow(smallBtn('Switch server…', () => hostDo('switchServer')), smallBtn('Sign in again', () => hostDo('signInAgain')),
          smallBtn('Sign out', signOutHere, { kind: 'ghost danger' }))),
    ];
  }
  const temporary = me.temporary || sessionGet('beam.sessionOnly') === '1';
  return [
    card(app?.platform === 'linux' ? 'This computer' : 'This browser', name,
      temporary && cardInfo('Signed in for this browser session only: closing the browser signs this device out, and nothing is kept here.'),
      // Written while this browser used another Beam server at this address; they go out if it signs in there again.
      otherBeamOutbox > 0 && inlineRow(`${plural(otherBeamOutbox, 'unsent message')} for another Beam server`, smallBtn('Discard', discardOtherBeamOutbox))),
    card(null, buttonRow(smallBtn('Sign out on this device', signOutHere, { ic: 'logout' }))),
  ];
}

async function renameThisDevice(value) {
  const name = cleanName(value);
  if (!name) return renderSettings();
  if (HOST) {
    const r = await hostDo('setSettings', { settings: { deviceName: name } });
    if (r?.settings) { hostState.settings = r.settings; setDeviceName(r.settings.deviceName || name, { chosen: true }); toast('Saved'); }
    return;
  }
  const app = linkedApp();
  if (app?.platform === 'linux') { // (1.23.2) to Beam for Linux, through Beam
    try {
      const r = await (await api('api/devices/me/name', jsonBody({ name }, 'PUT'))).json();
      app.name = r.name || name;
      showDeviceLabel();
      toast('Saved');
    } catch (err) {
      toast(friendlyError(err));
      renderSettings();
    }
    return;
  }
  if (app) return renderSettings();
  setDeviceName(name, { chosen: true });
  api('api/me').catch(() => {}); // any request with the new name renames the device
  connect();
  toast('Saved');
}

// The Windows app's own settings (HOST-BRIDGE.md §6/§7): a switch that didn't take flips back.
async function setHostSettings(fields, input) {
  const r = await hostDo('setSettings', { settings: fields });
  if (r?.settings) { hostState.settings = r.settings; renderSettings(); }
  else if (input) input.checked = !input.checked;
}

const appUpdateText = u => ({
  none: 'Beam is up to date.', available: `Version ${u.version || ''} is available.`, downloading: `Downloading version ${u.version || ''}…`,
  waiting: `Version ${u.version || ''} installs when the transfers finish.`, ready: `Version ${u.version || ''} is ready to install.`, failed: `The update failed: ${u.error || 'unknown error'}`,
}[u.state] || '');

function appUpdatesCard(s) {
  const u = hostState.update || {};
  return card('Beam app',
    cardInfo(`Beam app ${u.current || s.app?.version || hostState.version || ''}${s.app && s.app.installed === false ? ' (running from outside its install folder)' : ''}. ${appUpdateText(u)}`),
    switchRow('Install updates automatically', s.autoUpdate, (v, box) => setHostSettings({ autoUpdate: v }, box)),
    buttonRow(smallBtn(updateChecking ? 'Checking…' : 'Check now', checkAppUpdates, { disabled: updateChecking }),
      u.state === 'ready' && smallBtn('Install now', () => hostDo('installUpdate'), { kind: 'primary' }),
      smallBtn('Open logs folder', () => hostDo('openFolder', { which: 'logs' }), { kind: 'ghost' })));
}

// Check now: the app asks the server for a newer Beam app, and this window looks for a newer web app (Settings and the
// rest come from the server: a deploy of them alone needs no new app). It says what it found (the user, 2026-10-15:
// "when you press check now, it doesnt seem to do anything": the page redrew the same "up to date").
let updateChecking = false;
async function checkAppUpdates() {
  if (updateChecking) return;
  updateChecking = true;
  renderSettings();
  const [r, web] = await Promise.all([hostDo('checkForUpdates'), checkWebFiles(true)]);
  updateChecking = false;
  if (r?.update) hostState.update = r.update;
  if ($('#settingsDlg').open) renderSettings();
  if (web) {
    if ([...uploads.values()].some(x => !['failed', 'done'].includes(x.state))) {
      toast('A newer version of this window is ready: it loads once what’s being sent here is done.');
      return;
    }
    toast('A newer version of this window is ready: loading it…');
    setTimeout(() => location.reload(), 1200);
    return;
  }
  if (!r) return; // (hostDo said why)
  const u = hostState.update || {};
  toast(r.message || (u.state === 'none' ? `Beam app ${u.current || hostState.version || ''} is up to date.` : appUpdateText(u)), { error: u.state === 'failed' });
}

// A folder of this PC's: where it is, Change… and Open.
function folderRow(label, value, setting, which) {
  return stackRow(label, el('div', { class: 'path', title: value || '' }, value || '—'),
    el('div', { class: 'dev-actions' },
      smallBtn('Change…', async () => { const r = await hostDo('browseFolder', { setting }); if (r) { const g = await hostCall('getSettings').catch(() => null); if (g?.settings) { hostState.settings = g.settings; renderSettings(); } } }),
      smallBtn('Open', () => hostDo('openFolder', { which }), { kind: 'ghost' })));
}

const hostLoading = () => card(null, cardInfo('Loading…'));

// ---------------------------------------------------------------- Receiving, Sending (the Windows app)

function pageReceiving() {
  const s = hostState.settings;
  if (!s) return hostLoading();
  const maxMb = el('input', { type: 'number', min: '1', step: '1', value: String(s.maxSaveMB ?? 100), class: 'num', 'aria-label': 'Largest file to save automatically, in MB', disabled: !s.autoSave });
  maxMb.addEventListener('change', () => setHostSettings({ maxSaveMB: Math.max(1, Math.round(Number(maxMb.value) || 1)) }));
  return [
    card('Text',
      switchRow('Copy received text to the clipboard', s.autoCopy, (v, box) => setHostSettings({ autoCopy: v }, box)),
      // (1.15.0, the audit's X-5: said rather than changed)
      switchRow('Let received text appear in clipboard history (Win+V)', s.clipboardHistory, (v, box) => setHostSettings({ clipboardHistory: v }, box), { disabled: !s.autoCopy,
        hint: 'Win+V keeps it then, and if Windows’ cloud clipboard is on, it syncs to your Microsoft account like anything you copy.' })),
    'autoOpenLinks' in s && card('Links',
      switchRow('Open links sent to this PC automatically', s.autoOpenLinks, (v, box) => setHostSettings({ autoOpenLinks: v }, box),
        { hint: 'A message that’s just one web link, sent to this PC (not to all devices), opens in your browser. Not when it’s over 10 minutes old.' })),
    card('Files',
      switchRow('Save received files automatically', s.autoSave, (v, box) => setHostSettings({ autoSave: v }, box)),
      inlineRow('Largest file to save automatically (MB)', maxMb),
      folderRow('Save files to', s.saveFolder, 'saveFolder', 'save')),
  ];
}

function pageSending() {
  const s = hostState.settings;
  if (!s) return hostLoading();
  const hotkeys = (s.hotkeys || []).map(h => el('li', { class: 'set-row set-shortcut' }, el('kbd', {}, h.keys),
    el('span', {}, h.action, h.registered === false ? el('span', { class: 'warn small' }, ' (in use by another app)') : '')));
  return [
    card('From Windows',
      switchRow('“Send to › Beam” in Explorer', s.sendToMenu, (v, box) => setHostSettings({ sendToMenu: v }, box), { hint: 'Right-click files → Send to → Beam.' }),
      switchRow('Outbox folders', s.outbox, (v, box) => setHostSettings({ outbox: v }, box), { hint: 'Files dropped in a “To <device>” folder are sent to that device.' }),
      s.outbox && folderRow('Outbox folders are in', s.outboxFolder, 'outboxFolder', 'outbox')),
    hotkeys.length > 0 && listCard('Hotkeys (anywhere in Windows)', hotkeys),
  ];
}

// ---------------------------------------------------------------- Notifications

function pageNotifications() {
  const parts = [];
  if (HOST) {
    const s = hostState.settings;
    if (!s) return hostLoading();
    const phone = typeof s.phoneNotifications === 'boolean'; // the app owns this PC's switch (null: the server is older than 1.5)
    parts.push(card('On this PC',
      phone && switchRow('Show phone notifications on this PC', s.phoneNotifications, (v, box) => setHostSettings({ phoneNotifications: v }, box),
        { hint: 'From the apps picked on your phone (Beam there: Settings → Notifications on your PCs). A pop-up for each; reply, act on or dismiss them in the Phone panel.' }),
      // This PC's own (not a server setting); it can be turned off before the notifications go on.
      phone && typeof s.phonePopupText === 'boolean' && switchRow('Show message text in pop-ups', s.phonePopupText, (v, box) => setHostSettings({ phonePopupText: v }, box),
        { hint: 'Windows keeps pop-ups in its Notification Center. Off, they say only “WhatsApp · new notification”; the text stays in the Phone panel.' }),
      switchRow('Clicking a notification about a link opens the link', s.openLinks, (v, box) => setHostSettings({ openLinks: v }, box))));
  } else {
    parts.push(card(appNotifiesHere() ? 'This computer' : 'This browser', browserNotificationRow(),
      phoneFeature() && switchRow('Show phone notifications here', phoneShownFor(deviceById(me.id)), (v, box) => setPhoneShown(me.id, v, box),
        { hint: 'From the apps picked on your phone (Beam there: Settings → Notifications on your PCs). Reply, act on or dismiss them from here. Kept in memory only.' })));
  }
  // (1.5) the phone's notifications on the other devices: any device may switch it for any
  const others = phoneFeature() ? devices.filter(d => d.id !== me.id).sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name)) : [];
  if (others.length) {
    parts.push(card('Phone notifications on your other devices',
      ...others.map(d => switchRow(d.name, phoneShownFor(d), (v, box) => setPhoneShown(d.id, v, box)))));
  }
  return parts;
}

function browserNotificationRow() {
  if (appNotifiesHere()) return cardInfo('Beam for Linux on this computer shows a notification when something arrives (this window doesn’t as well).');
  if (!('Notification' in window && window.isSecureContext)) return cardInfo('This browser can’t show notifications for Beam here (it needs https).');
  const state = Notification.permission;
  const btn = smallBtn(state === 'granted' ? 'On' : state === 'denied' ? 'Blocked in the browser’s settings' : 'Turn on',
    async () => { await Notification.requestPermission(); renderSettings(); }, { disabled: state !== 'default', kind: state === 'default' ? 'primary' : '' });
  return inlineRow('Notifications when something arrives', btn, 'While Beam is open in the background: keep a tab open, or install Beam as an app.');
}

// ---------------------------------------------------------------- Control & sharing (the Windows app)
// What your other devices may do on this PC: control it, look in its shared folders, install apps. Each is turned on
// at the PC itself (devices.js rcPcCard, files.js sharedPcCard, apps.js appsPcCard).

function hasControlPage() {
  const s = HOST ? hostState.settings : null;
  return Boolean(s) && (typeof s.allowRemoteControl === 'boolean' || typeof s.appsAllowed === 'boolean' || Array.isArray(s.sharedFolders));
}

function pageControl() {
  const s = hostState.settings;
  if (!s) return hostLoading();
  return [intro('What your other devices can do on this PC. Each is allowed here, at this PC, never from another device.'),
    rcPcCard(s), sharedPcCard(s), appsPcCard(s)];
}

// ---------------------------------------------------------------- Shortcuts

// One row per shortcut (so a search finds one), from extras.js's list.
function pageHelp() {
  return listCard(null, SHORTCUTS.map(([k, d]) => el('li', { class: 'set-row set-shortcut' }, el('kbd', {}, k), el('span', {}, d))));
}

// ---------------------------------------------------------------- Devices
// A short row per device; everything about one (its actions, switches, history, Sign out) is in its Device info.
// Here only what needs you: a device waiting to be approved, a session controlling a PC.

function pageDevices() {
  const others = devices.filter(d => d.id !== me.id).sort((a, b) => (b.online - a.online) || (b.lastSeen - a.lastSeen));
  return [
    el('div', { class: 'set-intro-row' },
      intro('Click a device for everything about it: ring it, wake it, control it, its history, sign it out.'),
      smallBtn('Add a device…', () => openPairDialog(), { ic: 'qr' })),
    others.length ? listCard(null, others.map(deviceItem), { class: 'set-rows set-list dev-list' }) : card(null, cardInfo('No other devices yet. Use “Add a device”.')),
  ];
}

function deviceItem(d) {
  const extra = [...rcSessionLines(d), d.trusted === false && trustToggle(d, true)].filter(Boolean); // (1.25)
  return el('li', { class: 'dev-item', 'data-device': d.id },
    el('button', { class: 'dev-open', type: 'button', onclick: () => openDeviceInfo(d) },
      avatar(d.id),
      el('span', { class: 'dev-body' }, el('strong', {}, d.name), el('span', { class: 'muted small facts-line' }, ...factNodes(deviceFacts(d)))),
      icon('next', 'i chev')),
    extra.length > 0 && el('div', { class: 'dev-extra' }, ...extra));
}

async function removeDevice(d) {
  const v3 = serverHas('tokens');
  const tailscale = serverHas('tailscale-sign-in');
  const fromInfo = $('#genDlg').open && $('#genDlg').dataset.device === d.id; // (Cancel goes back to its Device info)
  const ok = await confirmDialog({
    title: v3 ? `Sign out ${d.name}?` : `Forget ${d.name}?`,
    text: v3 ? `${d.name} is signed out of Beam and removed from your devices${tailscale ? ', and its Tailscale machine can’t sign itself back in automatically' : ''}. To use Beam there again, sign in again. Your conversation with it stays.`
      : `${d.name} is removed from your device list. It comes back if it connects again. Your conversation with it stays.`,
    extra: v3 && tailscale && el('p', { class: 'muted small' }, 'Lost or stolen? Also ',
      el('a', { href: 'https://login.tailscale.com/admin/machines', target: '_blank', rel: 'noopener noreferrer', onclick: e => { if (HOST) { e.preventDefault(); openLink(e.currentTarget.href); } } }, 'remove it from your Tailscale network'), '.'),
    confirm: v3 ? 'Sign out' : 'Forget', danger: true,
  });
  if (!ok) { if (fromInfo && deviceById(d.id)) openDeviceInfo(deviceById(d.id)); return; }
  try {
    await api(`api/devices/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
    toast(v3 ? `${d.name} is signed out` : `${d.name} was removed`);
  } catch (err) { toast(friendlyError(err), { error: true }); }
}

// ---------------------------------------------------------------- Connections (1.17)
// How the server reaches each device's machine over Tailscale (GET /api/connections): the way it last took (seen
// while they talked, or tested: a few pings), whether Tailscale sees the machine, and when its sign-in runs out.

let connState = null; // the last GET /api/connections, or { error }
let connLoading = false;
const connTesting = new Set(); // device ids being tested

async function loadConnections() {
  if (connLoading) return;
  connLoading = true;
  try { connState = await apiJson('api/connections'); } catch (err) { connState = { error: friendlyError(err) }; }
  connLoading = false;
  if ($('#settingsDlg').open) renderSettings();
}

function pathLine(p) {
  if (!p) return 'Not talking to the server right now: Test shows the way';
  const how = p.via === 'direct' ? (p.lan ? 'Direct, on the same network' : 'Direct over the internet')
    : p.via === 'peer-relay' ? 'Through a peer relay'
    : `Through Tailscale’s relay${p.relay ? ` in ${RELAY_CITIES[p.relay] || p.relay.toUpperCase()}` : ''} (slower)`;
  return `${how}${Number.isFinite(p.ms) ? ` · ${Math.round(p.ms)} ms` : ''} · ${p.tested ? 'tested' : 'seen'} ${timeAgo(p.at)}`;
}

function connRow(m) {
  const testing = connTesting.has(m.id);
  const speeding = connSpeeding.get(m.id);
  const key = keyExpiryLine(m.machine);
  const reach = m.machine.online === false
    ? `Tailscale can’t reach it now${m.machine.lastSeen ? ` (last seen ${timeAgo(m.machine.lastSeen)})` : ''}`
    : testing ? 'Testing…' : pathLine(m.path);
  // (1.18) a speed test: this device's own in this page; a PC's Beam app (Windows 1.13+) when asked
  const canSpeed = serverHas('speed-test') && m.machine.online !== false && (m.here || (m.speedTest && m.online));
  return el('li', { class: 'device-row conn-row', 'data-conn': m.id },
    avatar(m.id),
    el('div', { class: 'dev-body' },
      el('strong', {}, m.name, m.here ? el('span', { class: 'muted small' }, ' · this device') : ''),
      el('span', { class: 'muted small block conn-path' }, reach),
      (speeding || m.speed) && el('span', { class: 'muted small block conn-speed' }, speeding || speedLine(m.speed)),
      key && el('span', { class: `muted small block conn-key${key.low ? ' low' : ''}` }, `Tailscale sign-in: ${key.text}`),
      m.machine.online !== false && el('div', { class: 'dev-actions' },
        el('button', { class: 'btn small-btn', type: 'button', disabled: testing, onclick: () => testConnection(m) }, icon('refresh'), testing ? 'Testing…' : 'Test'),
        canSpeed && el('button', { class: 'btn small-btn', type: 'button', disabled: Boolean(speeding), onclick: () => testSpeed(m) }, icon('download'), speeding ? 'Testing speed…' : 'Test speed'))));
}

// ---- speed tests (1.18): through the server's own address, as transfers go; about 3 s each way, 64 MB at most each

const connSpeeding = new Map(); // device id -> what the row says while it tests
const SPEED_SECONDS = 3;
const SPEED_MAX = 64 * 1024 * 1024;
const mbitText = v => (v >= 100 ? `${Math.round(v)}` : v >= 10 ? v.toFixed(0) : v.toFixed(1));
const speedLine = s => `Speed: ${mbitText(s.down)} Mbit/s down · ${mbitText(s.up)} Mbit/s up · tested ${timeAgo(s.at)}`;

// Mbit/s one way: requests one after another, each bigger while they're quick, for about 3 s.
async function measureSpeed(dir) {
  let bytes = 0;
  let size = 256 * 1024;
  const start = performance.now();
  while (performance.now() - start < SPEED_SECONDS * 1000 && bytes < SPEED_MAX) {
    const t0 = performance.now();
    if (dir === 'down') {
      const res = await api(`api/speedtest/down?bytes=${size}&n=${randomId(4)}`, { cache: 'no-store' });
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
    } else {
      // (a Blob: the browser sends it from its own process, about twice as fast as a buffer handed over from the page)
      await api('api/speedtest/up', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Blob([new Uint8Array(size)]) });
      bytes += size;
    }
    const took = performance.now() - t0;
    if (took < 700) size = Math.min(size * 4, 16 * 1024 * 1024);
    else if (took < 1500) size = Math.min(size * 2, 16 * 1024 * 1024);
  }
  return (bytes * 8) / ((performance.now() - start) / 1000) / 1e6;
}

async function testSpeed(m) {
  const row = () => connState?.machines?.find(x => x.id === m.id);
  const show = text => { if (text) connSpeeding.set(m.id, text); else connSpeeding.delete(m.id); if ($('#settingsDlg').open) renderSettings(); };
  try {
    let speed;
    if (m.here) {
      show('Testing download speed…');
      const down = await measureSpeed('down');
      show('Testing upload speed…');
      const up = await measureSpeed('up');
      speed = (await apiJson('api/speedtest/result', jsonBody({ down, up }))).speed;
    } else {
      show(`Asking ${m.name} to test (about 10 seconds)…`);
      speed = (await apiJson(`api/connections/${encodeURIComponent(m.id)}/speed`, jsonBody({}))).speed;
    }
    if (row() && speed) row().speed = speed;
  } catch (err) {
    toast(friendlyError(err), { error: true });
  }
  show(null);
}

async function testConnection(m) {
  connTesting.add(m.id);
  if ($('#settingsDlg').open) renderSettings();
  try {
    const r = await apiJson(`api/connections/${encodeURIComponent(m.id)}/test`, jsonBody({}));
    const row = connState?.machines?.find(x => x.id === m.id);
    if (r?.path && row) row.path = r.path;
    if (!r?.path) toast(`${m.name} didn’t answer`, { error: true });
  } catch (err) { toast(friendlyError(err), { error: true }); }
  connTesting.delete(m.id);
  if ($('#settingsDlg').open) renderSettings();
}

async function testAllConnections() {
  for (const m of (connState?.machines || []).filter(x => !x.machine.self && x.machine.online !== false)) await testConnection(m);
}

function sectionConnections() {
  if (!connState) {
    loadConnections();
    return card(null, cardInfo('Loading…'));
  }
  if (connState.error) return card(null, cardInfo(`Couldn’t load the connections: ${connState.error}`));
  if (!connState.tailscale) return card(null, cardInfo('This Beam server doesn’t see Tailscale, so it can’t tell how your devices reach it.'));
  const rows = (connState.machines || []).filter(m => !m.machine.self);
  const serverKey = keyExpiryLine(connState.server);
  const admin = el('a', { href: 'https://login.tailscale.com/admin/machines', target: '_blank', rel: 'noopener noreferrer', onclick: e => { if (HOST) { e.preventDefault(); openLink(e.currentTarget.href); } } }, 'Tailscale’s admin console');
  return [
    el('div', { class: 'set-intro-row' },
      intro(`How this Beam server (${connState.server?.name || 'this PC'}) reaches each device over Tailscale. Direct is fastest; Tailscale’s relay is the slow way round.`),
      rows.length > 1 && smallBtn('Test all', testAllConnections, { ic: 'refresh', disabled: connTesting.size > 0 })),
    serverKey && card(null, el('p', { class: `set-row small conn-server${serverKey.low ? ' low' : ''}` }, `This server’s Tailscale sign-in: ${serverKey.text}`)),
    rows.length ? listCard('Devices', rows.map(connRow), { class: 'set-rows set-list conn-list' }) : card(null, cardInfo('No devices on Tailscale yet.')),
    el('p', { class: 'muted small' }, 'A Tailscale sign-in runs out after a while (180 days unless your tailnet says otherwise), and the machine drops off Tailscale until someone signs in there again. For PCs that stay put, turn off key expiry in ', admin, '. A sleeping phone answers slower.'),
  ];
}

// ---------------------------------------------------------------- Security

function sectionSecurity() {
  const info = server.info || {};
  const pw = el('input', { type: 'password', placeholder: 'New password (8+ characters)', autocomplete: 'new-password', 'aria-label': 'New sign-in password' });
  // (1.7.2) Changing or removing a set password takes the current one (the server may also accept it without, from a
  // sign-in made with the password or an approval: then this is just ignored).
  const current = info.passwordSet && el('input', { type: 'password', placeholder: 'Current password', autocomplete: 'current-password', 'aria-label': 'Current sign-in password' });
  const save = el('button', { class: 'btn', type: 'button' }, info.passwordSet ? 'Change' : 'Set');
  save.addEventListener('click', () => {
    if (pw.value.length < 8) return toast('Use at least 8 characters', { error: true });
    savePassword(pw.value, current?.value);
  });
  pw.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save.click(); } });
  const parts = [
    card('Sign-in password',
      cardInfo(info.passwordSet ? 'A password is set: type it on any sign-in page to sign in there.' : 'Not set yet. With a password you can sign in on any browser by typing it.'),
      el('div', { class: 'set-row set-stack' }, current, row(pw, save)),
      info.passwordSet && buttonRow(smallBtn('Remove password', async () => { if (await confirmDialog({ title: 'Remove the sign-in password?', text: 'Devices that are already signed in stay signed in.', confirm: 'Remove', danger: true })) savePassword('', current?.value); }, { kind: 'ghost' }))),
  ];
  const s = serverSettings;
  if (s && 'tailscaleSignIn' in s) {
    const owners = [].concat(s.tailscaleOwners || info.tailscaleOwners || []);
    const locked = new Set(s.locked || []);
    const blocked = [].concat(s.blockedNodes || []);
    const fixed = new Set(s.tailscaleOwnersFixed || []);
    const seen = [].concat(s.tailscaleSeen || []);
    parts.push(card('Tailscale sign-in',
      switchRow('Sign in automatically on devices in my tailnet that belong to these accounts', s.tailscaleSignIn, v => patchServerSettings({ tailscaleSignIn: v }),
        { disabled: locked.has('tailscaleSignIn'), hint: locked.has('tailscaleSignIn') ? 'Fixed by the server’s configuration.' : '' }),
      owners.length
        ? stackRow('Accounts', el('ul', { class: 'device-list' }, ...owners.map(o => el('li', {}, icon('user'),
          el('div', { class: 'dev-body' }, el('strong', {}, o), fixed.has(o) && el('span', { class: 'muted small' }, 'Set in the server’s configuration')),
          !fixed.has(o) && el('button', { class: 'btn small-btn ghost', type: 'button', onclick: () => removeOwner(o) }, 'Remove')))))
        : cardInfo('No trusted accounts yet. Beam learns yours the first time you sign in on purpose (the password, a pairing link or an approval) from a device in your tailnet.'),
      // (1.7.3) Accounts that signed in on purpose somewhere but aren't trusted: never learned by just seeing them.
      seen.length > 0 && stackRow('Other accounts that signed in',
        el('small', { class: 'muted' }, 'Each signed in on a device here, but their other machines don’t sign in by themselves unless you allow it.'),
        el('ul', { class: 'device-list' }, ...seen.map(a => el('li', {}, icon('user'),
          el('div', { class: 'dev-body' }, el('strong', {}, a.login),
            el('span', { class: 'muted small' }, [a.devices?.length && `on ${a.devices.join(', ')}`, a.last && `seen ${timeAgo(a.last)}`].filter(Boolean).join(' · '))),
          el('button', { class: 'btn small-btn ghost', type: 'button', onclick: () => allowOwner(a.login) }, 'Allow'))))),
      blocked.length > 0 && stackRow('Blocked machines',
        el('small', { class: 'muted' }, 'Signed-out devices whose Tailscale machine may not sign itself back in.'),
        el('ul', { class: 'device-list' }, ...blocked.map(b => el('li', {}, icon('lock'),
          el('div', { class: 'dev-body' }, el('strong', {}, b.name || b.node || 'Unknown machine'),
            el('span', { class: 'muted small' }, [b.device && `was ${b.device}`, b.since && `blocked ${timeAgo(b.since)}`].filter(Boolean).join(' · '))),
          el('button', { class: 'btn small-btn ghost', type: 'button', onclick: () => unblockNode(b) }, 'Unblock')))))));
  }
  if (serverHas('tokens')) {
    parts.push(card('Everywhere else',
      inlineRow('Sign out all other devices', smallBtn('Sign out…', signOutOthers, { kind: 'danger' }),
        'For a lost phone or a borrowed computer: every other device and browser signs in again. This device stays signed in.')));
  }
  return parts;
}

async function savePassword(value, current) {
  try {
    const { passwordSet } = await apiJson('api/password', jsonBody(current ? { password: value, current } : { password: value }));
    if (server.info) server.info.passwordSet = passwordSet;
    toast(passwordSet ? 'Password saved' : 'Password removed');
    renderSettings();
  } catch (err) { toast(friendlyError(err), { error: true }); }
}

async function signOutOthers() {
  const tailscale = serverHas('tailscale-sign-in') && serverSettings?.tailscaleSignIn;
  const stopAuto = el('input', { type: 'checkbox' });
  const ok = await confirmDialog({
    title: 'Sign out all other devices?',
    text: 'Every other device, app and browser must sign in again. Pairing links stop working. This device stays signed in.',
    extra: tailscale && el('label', { class: 'check' }, stopAuto, el('span', {}, 'Also turn off automatic sign-in with Tailscale (use this if a device was lost or stolen)')),
    confirm: 'Sign them out', danger: true,
  });
  if (!ok) return;
  try {
    await api('api/security/sign-out-others', jsonBody(stopAuto.checked ? { disableTailscaleSignIn: true } : {}));
    toast('All other devices are signed out');
    loadServerSettings().then(() => $('#settingsDlg').open && renderSettings());
  } catch (err) { toast(friendlyError(err), { error: true }); }
}

// Let a machine that was signed out sign itself in with Tailscale again.
async function unblockNode(b) {
  try {
    const res = await apiJson(`api/settings/blocked-nodes/${encodeURIComponent(b.node)}`, { method: 'DELETE' });
    serverSettings = res.settings || res;
    toast(`${b.name || 'That machine'} can sign in automatically again`);
  } catch (err) { toast(friendlyError(err), { error: true }); }
  renderSettings();
}

async function allowOwner(login) {
  const ok = await confirmDialog({ title: `Let ${login} sign in by itself?`, text: 'Every machine of this Tailscale account will then sign in to Beam without a password. Only allow accounts that are yours.', confirm: 'Allow' });
  if (ok) patchServerSettings({ allowOwner: login });
}

async function removeOwner(login) {
  const ok = await confirmDialog({ title: `Stop ${login} signing in by itself?`, text: 'Devices signed in now stay signed in. New ones of this account will need the password, a pairing link or an approval.', confirm: 'Remove', danger: true });
  if (ok) patchServerSettings({ removeOwner: login });
}

async function patchServerSettings(fields) {
  try {
    const res = await apiJson('api/settings', jsonBody(fields, 'PATCH'));
    serverSettings = res.settings || res;
    toast('Saved');
  } catch (err) { toast(friendlyError(err), { error: true }); }
  renderSettings();
}

// ---------------------------------------------------------------- Server

function sectionServer() {
  const info = server.info || {};
  const s = serverSettings;
  const address = info.publicUrl || BASE.href.replace(/\/$/, '');
  const st = info.storage;
  const parts = [
    card('This server',
      el('div', { class: 'set-row' }, el('dl', { class: 'facts' },
        el('dt', {}, 'Address'), el('dd', {}, address),
        el('dt', {}, 'Version'), el('dd', {}, `Beam ${info.version || server.version || '?'}${info.api ? ` · API ${info.api}` : ''}`),
        info.uptime != null && el('dt', {}, 'Running for'), info.uptime != null && el('dd', {}, formatDuration(info.uptime)),
        st && el('dt', {}, 'Storage'), st && el('dd', {}, `${formatSize(st.used)} used by ${plural(st.items ?? items.length, 'item')}${st.free != null ? ` · ${formatSize(st.free)} free` : ''}`),
        el('dt', {}, 'Files'), el('dd', {}, `Up to ${formatSize(info.maxUpload || server.maxUpload)} each`))),
      serverHas('logs') && buttonRow(smallBtn('Server log', showLogs, { ic: 'file' }))),
  ];
  const retention = s?.retentionDays ?? info.retentionDays;
  const maxItems = s?.maxItems ?? info.maxItems ?? server.maxItems;
  if (s && 'retentionDays' in s) {
    const locked = new Set(s.locked || []);
    const days = el('input', { type: 'number', min: '0', max: '3650', step: '1', class: 'num', value: String(retention), 'aria-label': 'Delete items after this many days (0 = never)', disabled: locked.has('retentionDays') });
    const cap = el('input', { type: 'number', min: '0', max: '100000', step: '10', class: 'num', value: String(maxItems), 'aria-label': 'Keep at most this many items (0 = no limit)', disabled: locked.has('maxItems') });
    days.addEventListener('change', () => patchServerSettings({ retentionDays: clamp(Math.round(Number(days.value) || 0), 0, 3650) }));
    cap.addEventListener('change', () => patchServerSettings({ maxItems: clamp(Math.round(Number(cap.value) || 0), 0, 100000) }));
    parts.push(card('Messages and files',
      inlineRow('Keep items for (days, 0 = forever)', days), inlineRow('Keep at most (items, 0 = no limit)', cap),
      cardInfo(`Pinned items are always kept. Items another device hasn’t picked up yet are kept longer.${locked.size ? ' Greyed-out values are fixed in the server’s configuration.' : ''}`)));
  } else {
    parts.push(card('Messages and files', cardInfo(retention > 0 ? `Items are deleted after ${retention} days (at most ${maxItems.toLocaleString()} are kept).` : `Items are kept until you delete them (at most ${maxItems.toLocaleString()}).`)));
  }
  parts.push(setupCard(), updatesCard());
  if (serverHas('backups')) parts.push(backupCard());
  parts.push(card('Moving or starting over',
    serverHas('move') && inlineRow('Move Beam to a new address', smallBtn('Move…', moveServer), 'Once Beam runs at the new address with a copy of this server’s data.'),
    inlineRow('Delete every item', smallBtn('Delete…', deleteEverything, { kind: 'danger ghost' }), 'Every message and file, on every device.')));
  return parts;
}

// ---------------------------------------------------------------- the setup check (1.20)
// What Beam found when it last looked at its own setup (GET /api/setup): each check with what to do when it's wrong.

let setupView = null; // the last answer, or { error }; `loading` while it asks

async function loadSetup(refresh = false) {
  setupView = { ...(setupView || {}), loading: true };
  if (refresh && $('#settingsDlg').open) renderSettings();
  try { setupView = await apiJson(`api/setup${refresh ? '?refresh=1' : ''}`); } catch (err) { setupView = { error: friendlyError(err) }; }
  if ($('#settingsDlg').open) renderSettings();
}

function setupCard() {
  if (!serverHas('setup-check')) return null;
  if (!setupView) { loadSetup(); return card('Setup', cardInfo('Checking…')); }
  if (setupView.error) return card('Setup', cardInfo(`The setup check couldn’t run: ${setupView.error}`));
  const checks = setupView.checks || [];
  if (!checks.length) return card('Setup', cardInfo(setupView.loading ? 'Checking…' : 'Nothing to check yet.'));
  return card('Setup',
    el('ul', { class: 'set-row alert-list setup-list' }, ...checks.map(c => el('li', { class: c.ok === false ? 'warn-row' : '' },
      icon(c.ok === true ? 'check' : c.ok === false ? 'alert' : 'help'),
      el('span', { class: 'alert-text history-text' }, el('span', {}, c.title), el('span', { class: 'muted small' }, c.detail), c.fix ? el('span', { class: 'small' }, c.fix) : '')))),
    cardInfo(`Checked ${timeAgo(setupView.at)}. Beam looks again every 6 hours and alerts when something goes wrong.`),
    buttonRow(smallBtn(setupView.loading ? 'Checking…' : 'Check again', () => loadSetup(true), { disabled: Boolean(setupView.loading) })));
}

// ---------------------------------------------------------------- Windows app updates, one PC first (1.19)

function rolloutText(r) {
  const what = `Beam for Windows ${r.version}`;
  if (r.halted) return `${what} didn’t work on ${r.pilotName || 'the PC that tried it'} (${r.halted.problem}), so the other PCs kept the version they have.`;
  if (r.released) return `${what} went to every PC ${timeAgo(r.released)} (${r.running} of ${plural(r.pcs, 'PC')} run it).`;
  if (r.installedAt) return `${r.pilotName} runs ${what} since ${clock(r.installedAt)}. The other PCs get it at ${clock(r.releaseAt)} if it keeps running.`;
  if (r.pilot) return `${what} went to ${r.pilotName} first ${timeAgo(r.since)}. The others get it once it has run there for 10 minutes.`;
  return `${what} waits for a PC to connect and try it first.`;
}

function updatesCard() {
  const s = serverSettings;
  if (!serverHas('staged-updates') || !s || !('stagedUpdates' in s)) return null;
  const r = s.rollout;
  return card('Windows app updates',
    switchRow('A new version goes to one PC first', s.stagedUpdates, v => patchServerSettings({ stagedUpdates: v }), { hint: 'This server’s own PC tries it first (or the PC seen last). The others get it once it has run there for 10 minutes; if it fails there, it goes no further.' }),
    r && cardInfo(rolloutText(r)),
    r && !r.released && buttonRow(smallBtn(r.halted ? 'Offer it to every PC anyway' : 'Offer it to every PC now', releaseRollout)));
}

async function releaseRollout() {
  try {
    await apiJson('api/updates/release', jsonBody({}));
    toast('Offered to every PC: each installs it when it can.');
    await loadServerSettings();
  } catch (err) { toast(friendlyError(err), { error: true }); }
  if ($('#settingsDlg').open) renderSettings();
}

// ---------------------------------------------------------------- the server's backups (1.8.1)

let backupState = null; // GET /api/backups, asked when the Server page is first drawn after opening Settings

function backupCard() {
  if (!backupState) { loadBackups(); return card('Backups', cardInfo('Loading…')); }
  if (backupState.loading) return card('Backups', cardInfo('Loading…'));
  if (backupState.error) return card('Backups', cardInfo(backupState.error));
  const b = backupState;
  const last = b.last;
  const every = b.hours ? `A backup of this Beam every ${b.hours} h, into ${b.dir}; the newest ${b.keep} are kept. ` : 'Automatic backups are off (BEAM_BACKUP_HOURS=0). ';
  const lastText = last?.error ? `The last one failed: ${last.error}`
    : last?.name ? `The last: ${timeAgo(last.at)} (${formatSize(last.bytes)}${last.filesLeftOut ? `, without ${plural(last.filesLeftOut, 'file')} (the biggest)` : last.files === false ? ', without the files sent' : ''}).` : 'None yet.';
  const busy = b.running || b.busy;
  return card('Backups',
    cardInfo(every + lastText),
    cardInfo('Each PC’s Beam app keeps a copy of its settings here too (its Device info shows when), and offers it back after a reinstall. To bring this Beam back from a backup: stop it, then run “node server.js import <backup> --force” on the server.'),
    buttonRow(smallBtn(busy ? 'Backing up…' : 'Back up now', backupNow, { disabled: Boolean(busy) })));
}

async function loadBackups() {
  backupState = { loading: true };
  try {
    const res = await api('api/backups');
    const body = await res.json().catch(() => ({}));
    backupState = res.ok ? body : { error: body.error || `The backups couldn’t be read (${res.status}).` };
  } catch { backupState = { error: 'The backups couldn’t be read: Beam isn’t answering.' }; }
  renderSettings();
}

async function backupNow() {
  backupState = { ...backupState, busy: true };
  renderSettings();
  try {
    const res = await api('api/backups', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    backupState = res.ok ? body : { ...backupState, busy: false };
    toast(res.ok ? `Backed up (${formatSize(body.last?.bytes || 0)}).` : body.error || 'The backup failed.');
  } catch {
    backupState = { ...backupState, busy: false };
    toast('The backup failed: Beam isn’t answering.');
  }
  renderSettings();
}

async function showLogs() {
  const pre = el('pre', { class: 'logs' }, 'Loading…');
  const filter = lineFilter(pre, { important: true }); // (1.25.3)
  let lines = 400;
  const refresh = async () => {
    try {
      const res = await api(`api/logs?lines=${lines}`);
      const type = res.headers.get('content-type') || '';
      const body = type.includes('json') ? await res.json() : await res.text();
      filter.set(typeof body === 'string' ? body : (body.lines || []).join('\n'));
      pre.scrollTop = pre.scrollHeight;
    } catch (err) { pre.textContent = friendlyError(err); }
  };
  // (1.25.3) 400 lines, then 2,000, then the 5,000 the server gives at most
  const more = el('button', { class: 'btn ghost', type: 'button', onclick: () => { lines = Math.min(5000, lines * 5); more.hidden = lines >= 5000; refresh(); } }, 'More lines');
  openDialog({ title: 'Server log', body: [filter.bar, pre], wide: true, buttons: [more, el('button', { class: 'btn', type: 'button', onclick: refresh }, 'Refresh')] });
  refresh();
}

async function moveServer() {
  const input = el('input', { type: 'url', placeholder: 'https://beam.your-tailnet.ts.net', 'aria-label': 'New address', autocomplete: 'off' });
  const ok = await confirmDialog({
    title: 'Move Beam to a new address',
    text: 'Use this after Beam is already running at the new address with a copy of this server’s data (Settings are in the README under “Moving Beam”). Every device then switches over by itself, and this server only points to the new one.',
    confirm: 'Move', danger: true,
    extra: field('New address', input),
  });
  if (!ok) return;
  const to = input.value.trim().replace(/\/+$/, '');
  if (!isHttpUrl(to)) return toast('That isn’t an http(s) address.', { error: true });
  try {
    await api('api/move', jsonBody({ to }));
    toast(`Beam is moving to ${to}`);
  } catch (err) { toast(friendlyError(err), { error: true, ms: 6000 }); }
}

async function deleteEverything() {
  const ok = await confirmDialog({ title: 'Delete every item?', text: 'Every message and file is deleted on every device. This can’t be undone.', confirm: 'Delete everything', danger: true });
  if (!ok) return;
  try {
    await api('api/items', { method: 'DELETE' });
    setItems([]);
    cache.replaceItems([]);
    view.conv = null;
    renderAll();
    $('#settingsDlg').close();
  } catch (err) { toast(friendlyError(err), { error: true }); }
}

// ---------------------------------------------------------------- Add a device

async function openPairDialog() {
  const dlg = $('#pairDlg');
  await loadServerInfo();
  const info = server.info || {};
  const address = info.publicUrl || BASE.href.replace(/\/$/, '');
  $('#pairAddress').textContent = address;
  $('#androidLink').hidden = !info.apps?.android;
  $('#windowsLink').hidden = HOST || !info.apps?.windows;
  $('#appsBox').hidden = $('#androidLink').hidden && $('#windowsLink').hidden;
  // (1.22) Beam for Linux: one command in the computer's terminal (GET /install/linux)
  $('#linuxBox').hidden = !(serverHas('linux') && info.apps?.linux);
  $('#linuxCmd').value = `curl -fsSL ${address}/install/linux | bash`;
  // (audit 2026-10-11 S-9) never a plain http address on a local network (the server refuses those too)
  const safe = /^https:/i.test(address) || /^http:\/\/(100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[fd7a:115c:a1e0:|localhost[:/]|127\.)/i.test(`${address}/`);
  $('#linuxCmdRow').hidden = !safe;
  $('#linuxHttpsOnly').hidden = safe;
  $('#pairLinkBox').open = false;
  $('#pairLink').value = '';
  $('#qrImg').removeAttribute('src');
  if (!dlg.open) dlg.showModal();
  $('#approveInput').focus();
}

let pairExpiryTimer;
async function showPairingLink() {
  clearInterval(pairExpiryTimer);
  $('#pairLinkExpiry').textContent = '';
  try {
    const { key, lanUrl, publicUrl, link: given, expiresAt } = await apiJson('api/pair');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const base = (publicUrl || (local && lanUrl) || BASE.href).replace(/\/$/, '');
    const link = given || `${base}/?key=${encodeURIComponent(key)}`;
    $('#pairLink').value = link;
    $('#qrImg').src = url(`api/qr.svg?data=${encodeURIComponent(link)}`);
    // v3 links work once, for 15 minutes.
    const tick = () => {
      if (!expiresAt) { $('#pairLinkExpiry').textContent = 'This link doesn’t expire.'; return; }
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      $('#pairLinkExpiry').textContent = left ? `Works once, for the next ${Math.ceil(left / 60)} min.` : 'This link expired.';
      $('#pairLinkBox').classList.toggle('expired', !left);
      if (!left) clearInterval(pairExpiryTimer);
    };
    tick();
    pairExpiryTimer = setInterval(tick, 15000);
  } catch (err) {
    toast(friendlyError(err), { error: true });
  }
}
