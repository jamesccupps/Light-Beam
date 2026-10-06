'use strict';
// Settings (one scrolling page with sections) and the "Add a device" dialog.

let settingsSection = 'device';
let serverSettings = null; // API v3 GET /api/settings
const SECTIONS = [
  ['device', 'This device', 'user'],
  ['pc', 'This PC', 'monitor'],
  ['devices', 'Devices', 'phone'],
  ['connections', 'Connections', 'globe'], // (1.17)
  ['alerts', 'Alerts', 'alert'],
  ['security', 'Security', 'shield'],
  ['server', 'Server', 'server'],
  ['notifications', 'Notifications', 'bell'],
  ['help', 'Shortcuts', 'keyboard'],
];

async function openSettings(section = 'device') {
  settingsSection = section;
  backupState = null; // (1.8.1: the Server section asks again)
  connState = null; // (1.17: so does Connections)
  const dlg = $('#settingsDlg');
  renderSettings();
  if (!dlg.open) dlg.showModal();
  jumpToSection(section);
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

function jumpToSection(id) {
  settingsSection = id;
  const target = $(`#set-${id}`);
  // Only the sections scroll (scrollIntoView would scroll the dialog too, hiding its title and ×).
  if (target) $('#settingsBody').scrollTop = Math.max(0, target.offsetTop - 4);
  for (const b of $$('#settingsNav button')) b.setAttribute('aria-current', String(b.dataset.section === id));
}

const visibleSections = () => SECTIONS.filter(([id]) => (id === 'pc' ? Boolean(HOST) : id === 'notifications' ? !HOST : id === 'alerts' ? alertsSupported() : id === 'connections' ? serverHas('connections') : true));

function renderSettings() {
  const body = $('#settingsBody');
  // Don't pull a text box out from under the user's fingers: re-render later.
  const active = body.contains(document.activeElement) ? document.activeElement : null;
  if (active && /TEXTAREA|SELECT/.test(active.tagName) || (active?.tagName === 'INPUT' && !['checkbox', 'radio'].includes(active.type))) {
    clearTimeout(renderSettings.later);
    renderSettings.later = setTimeout(renderSettings, 1500);
    return;
  }
  // A toggle or button keeps the focus across the re-render (keyboard users stay where they were).
  const controls = () => [...body.querySelectorAll('button, input')];
  const focusAt = active ? controls().indexOf(active) : -1;
  const top = body.scrollTop;
  $('#settingsNav').replaceChildren(...visibleSections().map(([id, label, ic]) =>
    el('button', { type: 'button', 'data-section': id, 'aria-current': String(id === settingsSection), onclick: () => jumpToSection(id) }, icon(ic), el('span', {}, label))));
  const builders = { device: sectionDevice, pc: sectionPc, devices: sectionDevices, connections: sectionConnections, alerts: sectionAlerts, security: sectionSecurity, server: sectionServer, notifications: sectionNotifications, help: sectionHelp };
  body.replaceChildren(...visibleSections().map(([id, label]) => el('section', { class: 'set-section', id: `set-${id}`, 'aria-labelledby': `set-h-${id}` },
    el('h3', { id: `set-h-${id}` }, label), ...[].concat(builders[id]()).filter(Boolean))));
  body.scrollTop = top;
  if (focusAt >= 0) controls()[focusAt]?.focus({ preventScroll: true });
}

const field = (label, ...children) => el('div', { class: 'field' }, el('span', { class: 'field-label' }, label), ...children);
const note = text => el('p', { class: 'muted small' }, text);
const row = (...children) => el('div', { class: 'linkrow' }, ...children);
function toggle(label, checked, onchange, { hint, disabled } = {}) {
  const input = el('input', { type: 'checkbox', checked: Boolean(checked), disabled: Boolean(disabled) });
  input.addEventListener('change', () => onchange(input.checked, input));
  return el('label', { class: 'check' }, input, el('span', {}, label, hint && el('small', { class: 'muted block' }, hint)));
}

// ---------------------------------------------------------------- This device

function sectionDevice() {
  const input = el('input', { type: 'text', maxlength: '40', autocomplete: 'off', value: me.name, 'aria-label': 'This device’s name' });
  input.addEventListener('change', () => renameThisDevice(input.value));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  const parts = [field('Name', input, note(HOST ? 'How this PC appears on your other devices.' : 'How this browser appears on your other devices.'))];
  if (phoneFeature() && !HOST) { // (in the Windows app it's the app's: Settings → This PC)
    parts.push(toggle('Show phone notifications here', phoneShownFor(deviceById(me.id)), (v, box) => setPhoneShown(me.id, v, box),
      { hint: 'From the apps picked on your phone (in Beam there: Settings → Notifications on your PCs). Reply, act on or dismiss them from here. Kept in memory only.' }));
  }
  // Written while this browser used another Beam server at this address; they go out if it signs in there again.
  if (otherBeamOutbox > 0) {
    parts.push(row(el('span', {}, `${plural(otherBeamOutbox, 'unsent message')} for another Beam server`),
      el('button', { class: 'btn small-btn', type: 'button', onclick: discardOtherBeamOutbox }, 'Discard')));
  }
  if (!HOST) {
    const temporary = me.temporary || sessionGet('beam.sessionOnly') === '1';
    if (temporary) parts.push(el('p', { class: 'note' }, 'Signed in for this browser session only: closing the browser signs this device out, and nothing is kept here.'));
    parts.push(el('div', { class: 'dlg-foot left' }, el('button', { class: 'btn', type: 'button', onclick: signOutHere }, icon('logout'), 'Sign out on this device')));
  }
  return parts;
}

async function renameThisDevice(value) {
  const name = cleanName(value);
  if (!name) return renderSettings();
  if (HOST) {
    const r = await hostDo('setSettings', { settings: { deviceName: name } });
    if (r?.settings) { hostState.settings = r.settings; setDeviceName(r.settings.deviceName || name, { chosen: true }); toast('Saved'); }
    return;
  }
  setDeviceName(name, { chosen: true });
  api('api/me').catch(() => {}); // any request with the new name renames the device
  connect();
  toast('Saved');
}

// ---------------------------------------------------------------- This PC (host mode, HOST-BRIDGE.md §6/§7)

function sectionPc() {
  const s = hostState.settings;
  if (!s) return note('Loading…');
  const set = async (fields, input) => {
    const r = await hostDo('setSettings', { settings: fields });
    if (r?.settings) { hostState.settings = r.settings; renderSettings(); }
    else if (input) input.checked = !input.checked;
  };
  const folderRow = (label, value, setting, which) => field(label,
    el('div', { class: 'path', title: value || '' }, value || '—'),
    row(el('button', { class: 'btn small-btn', type: 'button', onclick: async () => { const r = await hostDo('browseFolder', { setting }); if (r) { const g = await hostCall('getSettings').catch(() => null); if (g?.settings) { hostState.settings = g.settings; renderSettings(); } } } }, 'Change…'),
      el('button', { class: 'btn small-btn ghost', type: 'button', onclick: () => hostDo('openFolder', { which }) }, 'Open')));
  const maxMb = el('input', { type: 'number', min: '1', step: '1', value: String(s.maxSaveMB ?? 100), class: 'num', 'aria-label': 'Largest file to save automatically, in MB', disabled: !s.autoSave });
  maxMb.addEventListener('change', () => { const v = Math.max(1, Math.round(Number(maxMb.value) || 1)); set({ maxSaveMB: v }); });
  const u = hostState.update || {};
  const updateText = {
    none: 'Beam is up to date.', available: `Version ${u.version || ''} is available.`, downloading: `Downloading version ${u.version || ''}…`,
    waiting: `Version ${u.version || ''} installs when the transfers finish.`, ready: `Version ${u.version || ''} is ready to install.`, failed: `The update failed: ${u.error || 'unknown error'}`,
  }[u.state] || '';
  const srv = s.server || {};
  const hotkeys = (s.hotkeys || []).map(h => el('li', {}, el('kbd', {}, h.keys), ` ${h.action}`, h.registered === false ? el('span', { class: 'warn small' }, ' (in use by another app)') : ''));
  return [
    el('h4', {}, 'Receiving'),
    toggle('Copy received text to the clipboard', s.autoCopy, v => set({ autoCopy: v })),
    toggle('Let received text appear in clipboard history (Win+V)', s.clipboardHistory, v => set({ clipboardHistory: v }), { disabled: !s.autoCopy,
      // (1.15.0, the audit's X-5: said rather than changed)
      hint: 'On: it’s kept in Win+V history and, if Windows’ cloud clipboard is on, synced to your Microsoft account like anything else you copy. Off: it stays out of both.' }),
    'autoOpenLinks' in s && toggle('Open links sent to this PC automatically', s.autoOpenLinks, v => set({ autoOpenLinks: v }), { hint: 'A message that’s just one web link, sent to this PC itself (not to all devices), opens in your default browser. Links more than 10 minutes old (say, after the PC was off) don’t.' }),
    // The app owns this PC's switch (null: the server is older than 1.5).
    typeof s.phoneNotifications === 'boolean' && toggle('Show phone notifications on this PC', s.phoneNotifications, (v, box) => set({ phoneNotifications: v }, box),
      { hint: 'From the apps picked on your phone (in Beam there: Settings → Notifications on your PCs). A balloon for each; reply, act on or dismiss them in the Phone panel.' }),
    // This PC's own (not a server setting); it can be turned off before the notifications go on.
    typeof s.phoneNotifications === 'boolean' && typeof s.phonePopupText === 'boolean' && toggle('Show message text in pop-ups', s.phonePopupText, (v, box) => set({ phonePopupText: v }, box),
      { hint: 'Windows keeps pop-ups in its Notification Center until they’re cleared. Off, they say only “WhatsApp · new notification”; the text stays in the Phone panel.' }),
    toggle('Save received files automatically', s.autoSave, v => set({ autoSave: v })),
    field('…up to this size per file (MB)', maxMb),
    folderRow('Save files to', s.saveFolder, 'saveFolder', 'save'),
    el('h4', {}, 'Sending'),
    toggle('“Send to › Beam” in Explorer', s.sendToMenu, v => set({ sendToMenu: v })),
    toggle('Outbox folders (files dropped in “To <device>” are sent)', s.outbox, v => set({ outbox: v })),
    s.outbox && folderRow('Outbox folders', s.outboxFolder, 'outboxFolder', 'outbox'),
    el('h4', {}, 'Windows'),
    toggle('Start Beam when I sign in to Windows', s.autostart, v => set({ autostart: v })),
    toggle('Clicking a notification about a link opens the link', s.openLinks, v => set({ openLinks: v })),
    hotkeys.length > 0 && field('Hotkeys', el('ul', { class: 'plain' }, ...hotkeys)),
    ...rcPcRows(s), // (1.6: shown when the app reports allowRemoteControl)
    el('h4', {}, 'Updates'),
    note(`Beam app ${u.current || s.app?.version || hostState.version || ''}${s.app && s.app.installed === false ? ' (running from outside its install folder)' : ''}. ${updateText}`),
    toggle('Install updates automatically', s.autoUpdate, v => set({ autoUpdate: v })),
    row(el('button', { class: 'btn small-btn', type: 'button', onclick: async () => { const r = await hostDo('checkForUpdates'); if (r?.update) { hostState.update = r.update; renderSettings(); } } }, 'Check now'),
      u.state === 'ready' && el('button', { class: 'btn small-btn primary', type: 'button', onclick: () => hostDo('installUpdate') }, 'Install now'),
      el('button', { class: 'btn small-btn ghost', type: 'button', onclick: () => hostDo('openFolder', { which: 'logs' }) }, 'Open logs folder')),
    // (1.8.1) This PC's settings are kept on the server too; the app puts a backup back (its native choice).
    hostHas('restoreSettings') && serverHas('backups') && el('h4', {}, 'Backup'),
    hostHas('restoreSettings') && serverHas('backups') && note(deviceById(me.id)?.backup?.at
      ? `This PC’s settings are kept on your Beam too (last ${timeAgo(deviceById(me.id).backup.at)}). After a reinstall, Beam offers to put them back.`
      : 'This PC’s settings are kept on your Beam too, from the next change on. After a reinstall, Beam offers to put them back.'),
    hostHas('restoreSettings') && serverHas('backups') && row(el('button', { class: 'btn small-btn', type: 'button', onclick: () => hostDo('restoreSettings') }, 'Restore settings…')),
    el('h4', {}, 'Server'),
    note(`${srv.url || location.origin}${srv.version ? ` · Beam ${srv.version}` : ''}${srv.storage ? ` · ${formatSize(srv.storage.used)} used, ${formatSize(srv.storage.free)} free` : ''}${srv.connected === false ? ' · not connected' : ''}`),
    row(el('button', { class: 'btn small-btn', type: 'button', onclick: () => hostDo('switchServer') }, 'Switch server…'),
      el('button', { class: 'btn small-btn', type: 'button', onclick: () => hostDo('signInAgain') }, 'Sign in again'),
      el('button', { class: 'btn small-btn ghost danger', type: 'button', onclick: signOutHere }, 'Sign out')),
  ];
}

// ---------------------------------------------------------------- Devices

function sectionDevices() {
  const others = devices.filter(d => d.id !== me.id).sort((a, b) => (b.online - a.online) || (b.lastSeen - a.lastSeen));
  if (!others.length) return note('No other devices yet. Use “Add a device”.');
  const v3 = serverHas('tokens');
  const alerts = alertsSupported();
  return [
    el('ul', { class: 'device-list' }, ...others.map(d => el('li', { class: 'device-row' },
      avatar(d.id),
      el('div', { class: 'dev-body' },
        el('strong', {}, d.name),
        el('span', { class: 'muted small facts-line' }, ...factNodes(deviceFacts(d))),
        d.backup?.at && el('span', { class: 'muted small block' }, `Settings backed up ${timeAgo(d.backup.at)}`), // (1.8.1)
        el('div', { class: 'dev-actions' },
          ...deviceActions(d).map(a => el('button', { class: 'btn small-btn', type: 'button', disabled: Boolean(a.disabled), onclick: () => a.action() }, icon(a.icon), a.label)),
          el('button', { class: 'btn small-btn ghost', type: 'button', onclick: () => removeDevice(d) }, v3 ? 'Sign out…' : 'Forget…')),
        ...rcDeviceRows(d),
        alerts && offlineAlertToggle(d),
        phoneFeature() && toggle('Show phone notifications', phoneShownFor(d), (v, box) => setPhoneShown(d.id, v, box)))))),
    note(v3 ? '“Sign out” cuts that device off and removes it from the list. Its history stays.' : '“Forget” removes a device from the list; it comes back if it connects again.'),
  ];
}

async function removeDevice(d) {
  const v3 = serverHas('tokens');
  const tailscale = serverHas('tailscale-sign-in');
  const ok = await confirmDialog({
    title: v3 ? `Sign out ${d.name}?` : `Forget ${d.name}?`,
    text: v3 ? `${d.name} is signed out of Beam and removed from your devices${tailscale ? ', and its Tailscale machine can’t sign itself back in automatically' : ''}. To use Beam there again, sign in again. Your conversation with it stays.`
      : `${d.name} is removed from your device list. It comes back if it connects again. Your conversation with it stays.`,
    extra: v3 && tailscale && el('p', { class: 'muted small' }, 'Lost or stolen? Also ',
      el('a', { href: 'https://login.tailscale.com/admin/machines', target: '_blank', rel: 'noopener noreferrer', onclick: e => { if (HOST) { e.preventDefault(); openLink(e.currentTarget.href); } } }, 'remove it from your Tailscale network'), '.'),
    confirm: v3 ? 'Sign out' : 'Forget', danger: true,
  });
  if (!ok) return;
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
  const key = keyExpiryLine(m.machine);
  const reach = m.machine.online === false
    ? `Tailscale can’t reach it now${m.machine.lastSeen ? ` (last seen ${timeAgo(m.machine.lastSeen)})` : ''}`
    : testing ? 'Testing…' : pathLine(m.path);
  return el('li', { class: 'device-row', 'data-conn': m.id },
    avatar(m.id),
    el('div', { class: 'dev-body' },
      el('strong', {}, m.name),
      el('span', { class: 'muted small block conn-path' }, reach),
      key && el('span', { class: `muted small block conn-key${key.low ? ' low' : ''}` }, `Tailscale sign-in: ${key.text}`),
      m.machine.online !== false && el('div', { class: 'dev-actions' },
        el('button', { class: 'btn small-btn', type: 'button', disabled: testing, onclick: () => testConnection(m) }, icon('refresh'), testing ? 'Testing…' : 'Test'))));
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
    return note('Loading…');
  }
  if (connState.error) return note(`Couldn’t load the connections: ${connState.error}`);
  if (!connState.tailscale) return note('This Beam server doesn’t see Tailscale, so it can’t tell how your devices reach it.');
  const rows = (connState.machines || []).filter(m => !m.machine.self);
  const serverKey = keyExpiryLine(connState.server);
  const admin = el('a', { href: 'https://login.tailscale.com/admin/machines', target: '_blank', rel: 'noopener noreferrer', onclick: e => { if (HOST) { e.preventDefault(); openLink(e.currentTarget.href); } } }, 'Tailscale’s admin console');
  return [
    note(`How this Beam server (${connState.server?.name || 'this PC'}) reaches each device over Tailscale. Direct is fastest; Tailscale’s relay is the slow way round, used when a direct path is blocked.`),
    serverKey && el('p', { class: `small conn-server${serverKey.low ? ' low' : ''}` }, `This server’s Tailscale sign-in: ${serverKey.text}`),
    rows.length ? el('ul', { class: 'device-list conn-list' }, ...rows.map(connRow)) : note('No devices on Tailscale yet.'),
    rows.length > 1 && el('div', { class: 'dev-actions' }, el('button', { class: 'btn small-btn', type: 'button', disabled: connTesting.size > 0, onclick: testAllConnections }, icon('refresh'), 'Test all')),
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
    field('Sign-in password',
      note(info.passwordSet ? 'A password is set: type it on any sign-in page to sign in there.' : 'Not set yet. With a password you can sign in on any browser by typing it.'),
      current,
      row(pw, save),
      info.passwordSet && el('button', { class: 'btn small-btn ghost', type: 'button', onclick: async () => { if (await confirmDialog({ title: 'Remove the sign-in password?', text: 'Devices that are already signed in stay signed in.', confirm: 'Remove', danger: true })) savePassword('', current?.value); } }, 'Remove password')),
  ];
  const s = serverSettings;
  if (s && 'tailscaleSignIn' in s) {
    const owners = [].concat(s.tailscaleOwners || info.tailscaleOwners || []);
    const locked = new Set(s.locked || []);
    const blocked = [].concat(s.blockedNodes || []);
    const fixed = new Set(s.tailscaleOwnersFixed || []);
    const seen = [].concat(s.tailscaleSeen || []);
    parts.push(field('Tailscale sign-in',
      toggle('Sign in automatically on devices in my tailnet that belong to these accounts', s.tailscaleSignIn, v => patchServerSettings({ tailscaleSignIn: v }),
        { disabled: locked.has('tailscaleSignIn'), hint: locked.has('tailscaleSignIn') ? 'Fixed by the server’s configuration.' : '' }),
      owners.length
        ? el('ul', { class: 'device-list' }, ...owners.map(o => el('li', {}, icon('user'),
          el('div', { class: 'dev-body' }, el('strong', {}, o), fixed.has(o) && el('span', { class: 'muted small' }, 'Set in the server’s configuration')),
          !fixed.has(o) && el('button', { class: 'btn small-btn ghost', type: 'button', onclick: () => removeOwner(o) }, 'Remove'))))
        : note('No trusted accounts yet. Beam learns yours the first time you sign in on purpose (the password, a pairing link or an approval) from a device in your tailnet.'),
      // (1.7.3) Accounts that signed in on purpose somewhere but aren't trusted: never learned by just seeing them.
      seen.length > 0 && el('div', {}, el('span', { class: 'field-label' }, 'Other accounts that signed in'),
        note('Each signed in on a device here, but their other machines don’t sign in by themselves unless you allow it.'),
        el('ul', { class: 'device-list' }, ...seen.map(a => el('li', {}, icon('user'),
          el('div', { class: 'dev-body' }, el('strong', {}, a.login),
            el('span', { class: 'muted small' }, [a.devices?.length && `on ${a.devices.join(', ')}`, a.last && `seen ${timeAgo(a.last)}`].filter(Boolean).join(' · '))),
          el('button', { class: 'btn small-btn ghost', type: 'button', onclick: () => allowOwner(a.login) }, 'Allow'))))),
      blocked.length > 0 && el('div', {}, el('span', { class: 'field-label' }, 'Blocked machines'),
        note('Signed-out devices whose Tailscale machine may not sign itself back in.'),
        el('ul', { class: 'device-list' }, ...blocked.map(b => el('li', {}, icon('lock'),
          el('div', { class: 'dev-body' }, el('strong', {}, b.name || b.node || 'Unknown machine'),
            el('span', { class: 'muted small' }, [b.device && `was ${b.device}`, b.since && `blocked ${timeAgo(b.since)}`].filter(Boolean).join(' · '))),
          el('button', { class: 'btn small-btn ghost', type: 'button', onclick: () => unblockNode(b) }, 'Unblock')))))));
  }
  if (serverHas('tokens')) {
    parts.push(field('Everywhere else',
      note('Signs out every other device and browser at once (for a lost phone or a borrowed computer). This device stays signed in.'),
      el('button', { class: 'btn danger', type: 'button', onclick: signOutOthers }, 'Sign out all other devices…')));
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
    el('dl', { class: 'facts' },
      el('dt', {}, 'Address'), el('dd', {}, address),
      el('dt', {}, 'Version'), el('dd', {}, `Beam ${info.version || server.version || '?'}${info.api ? ` · API ${info.api}` : ''}`),
      info.uptime != null && el('dt', {}, 'Running for'), info.uptime != null && el('dd', {}, formatDuration(info.uptime)),
      st && el('dt', {}, 'Storage'), st && el('dd', {}, `${formatSize(st.used)} used by ${plural(st.items ?? items.length, 'item')}${st.free != null ? ` · ${formatSize(st.free)} free` : ''}`),
      el('dt', {}, 'Files'), el('dd', {}, `Up to ${formatSize(info.maxUpload || server.maxUpload)} each`)),
  ];
  const retention = s?.retentionDays ?? info.retentionDays;
  const maxItems = s?.maxItems ?? info.maxItems ?? server.maxItems;
  if (s && 'retentionDays' in s) {
    const locked = new Set(s.locked || []);
    const days = el('input', { type: 'number', min: '0', max: '3650', step: '1', class: 'num', value: String(retention), 'aria-label': 'Delete items after this many days (0 = never)', disabled: locked.has('retentionDays') });
    const cap = el('input', { type: 'number', min: '0', max: '100000', step: '10', class: 'num', value: String(maxItems), 'aria-label': 'Keep at most this many items (0 = no limit)', disabled: locked.has('maxItems') });
    days.addEventListener('change', () => patchServerSettings({ retentionDays: clamp(Math.round(Number(days.value) || 0), 0, 3650) }));
    cap.addEventListener('change', () => patchServerSettings({ maxItems: clamp(Math.round(Number(cap.value) || 0), 0, 100000) }));
    parts.push(field('Keep items for (days, 0 = forever)', days), field('Keep at most (items, 0 = no limit)', cap),
      note(`Pinned items are always kept. Items another device hasn’t picked up yet are kept longer.${locked.size ? ' Greyed-out values are fixed in the server’s configuration.' : ''}`));
  } else {
    parts.push(note(retention > 0 ? `Items are deleted after ${retention} days (at most ${maxItems.toLocaleString()} are kept).` : `Items are kept until you delete them (at most ${maxItems.toLocaleString()}).`));
  }
  const buttons = [];
  if (serverHas('logs')) buttons.push(el('button', { class: 'btn small-btn', type: 'button', onclick: showLogs }, 'Server log'));
  if (serverHas('move')) buttons.push(el('button', { class: 'btn small-btn', type: 'button', onclick: moveServer }, 'Move Beam to a new address…'));
  buttons.push(el('button', { class: 'btn small-btn danger ghost', type: 'button', onclick: deleteEverything }, 'Delete every item…'));
  parts.push(row(...buttons));
  if (serverHas('backups')) parts.push(...backupRows());
  return parts;
}

// ---------------------------------------------------------------- the server's backups (1.8.1)

let backupState = null; // GET /api/backups, asked when the Server section is first drawn after opening Settings

function backupRows() {
  const head = el('h4', {}, 'Backups');
  if (!backupState) { loadBackups(); return [head, note('Loading…')]; }
  if (backupState.loading) return [head, note('Loading…')];
  if (backupState.error) return [head, note(backupState.error)];
  const b = backupState;
  const last = b.last;
  const every = b.hours ? `A backup of this Beam every ${b.hours} h, into ${b.dir}; the newest ${b.keep} are kept. ` : 'Automatic backups are off (BEAM_BACKUP_HOURS=0). ';
  const lastText = last?.error ? `The last one failed: ${last.error}`
    : last?.name ? `The last: ${timeAgo(last.at)} (${formatSize(last.bytes)}${last.filesLeftOut ? `, without ${plural(last.filesLeftOut, 'file')} (the biggest)` : last.files === false ? ', without the files sent' : ''}).` : 'None yet.';
  const busy = b.running || b.busy;
  return [
    head,
    note(every + lastText),
    note('Each PC’s Beam app keeps a copy of its settings here too (Devices shows when), and offers it back after a reinstall. To bring this Beam back from a backup: stop it, then run “node server.js import <backup> --force” on the server.'),
    row(el('button', { class: 'btn small-btn', type: 'button', disabled: Boolean(busy), onclick: backupNow }, busy ? 'Backing up…' : 'Back up now')),
  ];
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
  const refresh = async () => {
    try {
      const res = await api('api/logs?lines=400');
      const type = res.headers.get('content-type') || '';
      const body = type.includes('json') ? await res.json() : await res.text();
      pre.textContent = typeof body === 'string' ? body : (body.lines || []).join('\n');
      pre.scrollTop = pre.scrollHeight;
    } catch (err) { pre.textContent = friendlyError(err); }
  };
  openDialog({ title: 'Server log', body: pre, wide: true, buttons: [el('button', { class: 'btn', type: 'button', onclick: refresh }, 'Refresh')] });
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

// ---------------------------------------------------------------- Notifications (browser)

function sectionNotifications() {
  const supported = 'Notification' in window && window.isSecureContext;
  if (!supported) return note('This browser can’t show notifications for Beam here (it needs https).');
  const state = Notification.permission;
  const btn = el('button', { class: 'btn', type: 'button', disabled: state !== 'default' },
    state === 'granted' ? 'Notifications are on' : state === 'denied' ? 'Blocked in the browser’s settings' : 'Turn on notifications');
  btn.addEventListener('click', async () => { await Notification.requestPermission(); renderSettings(); });
  return [btn, note('Beam notifies you when something arrives while it’s open in the background. Keep a tab open (or install Beam as an app) to get them.')];
}

// ---------------------------------------------------------------- Shortcuts

function sectionHelp() {
  return [shortcutList(), note(`Beam web ${WEB_VERSION}${server.version ? ` · server ${server.version}` : ''}`)];
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
