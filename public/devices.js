'use strict';
// Devices you can check on and act on: the info line (battery, free storage, Beam version, OS), Ring / Stop,
// Wake-on-LAN, Remote Desktop, and alerts (low battery or storage, a device going offline, the server's disk).
// Everything here only shows when the server and the device report it (docs/API.md → devices `status` / `can`).

const RING_MS = 60000;
const ringing = new Map(); // device id -> until (ms), from `ring` events and our own requests
let recentAlerts = null;   // GET /api/alerts, newest first (loaded when Settings → Alerts opens)

const lowBattery = b => b && Number.isFinite(b.level) && b.level <= 15 && !b.charging;
const lowStorage = s => s && Number.isFinite(s.free) && s.free < Math.max(2 * 1024 ** 3, (s.total || 0) * 0.05);
const isRinging = id => (ringing.get(id) || 0) > Date.now();
const beamVersionOf = d => d.appVersion || ''; // the Beam apps report it; browsers don't
// Where Remote Desktop connects: the MagicDNS name, else the Tailscale address (the server only offers it with one).
const rdpHost = d => d.tailscale?.dns || d.tailscale?.ip || '';

// (1.17) Why an app is offline, as Tailscale sees its machine (the server's `tailscale.online`, `expired`): { short, long,
// low } or null. Not for browsers or the command line, which are often away. And "still on Tailscale" only once Beam has
// missed it for 4 minutes: Tailscale notices a machine that lost power or network only after a few.
const WHY_PLATFORMS = new Set(['windows', 'android', 'ios', 'mac', 'linux']);
function offlineWhy(d) {
  const t = d.tailscale;
  if (d.online || !t || typeof t.online !== 'boolean' || !WHY_PLATFORMS.has(d.platform)) return null;
  if (t.expired) return { short: 'Tailscale sign-in ran out', long: 'Its Tailscale sign-in ran out: sign in to Tailscale on it again', low: true };
  if (t.online) {
    if (Date.now() - (d.lastSeen || 0) < 4 * 60e3) return null;
    return d.platform === 'windows'
      ? { short: 'PC on, Beam not running', long: 'The PC is on (Tailscale still sees it), but Beam isn’t running there' }
      : { short: 'On Tailscale, Beam not connected', long: 'It’s on Tailscale, but Beam isn’t connected (the app may be closed)' };
  }
  return { short: 'Off or asleep', long: `Tailscale can’t reach it either: it’s off, asleep or without internet${t.lastSeen ? ` (Tailscale last saw it ${timeAgo(t.lastSeen)})` : ''}` };
}

// (1.17) When a machine's Tailscale sign-in (its key) runs out: { text, low } or null when the server doesn't say.
const longDate = t => dateFormat({ year: 'numeric', month: 'long', day: 'numeric' }).format(t);
function keyExpiryLine(t) {
  if (!t || !('keyExpiry' in t)) return null;
  if (t.expired) return { text: 'Ran out: sign in to Tailscale on it again', low: true };
  if (!Number.isFinite(t.keyExpiry)) return { text: 'Doesn’t run out (key expiry is off)' };
  const days = Math.ceil((t.keyExpiry - Date.now()) / 86400e3);
  return { text: `Runs out ${longDate(t.keyExpiry)}${days <= 30 ? ` (in ${plural(Math.max(days, 1), 'day')})` : ''}`, low: days <= 14 };
}

// The facts about a device, most useful first: [{ text, cls, icon, title }].
function deviceFacts(d, { long = false } = {}) {
  const facts = [];
  const s = d.status || {};
  const reported = s.at ? `Reported ${timeAgo(s.at)}` : '';
  facts.push({ text: d.online ? 'Online' : long ? `Offline, last seen ${timeAgo(d.lastSeen)}` : `Last seen ${timeAgo(d.lastSeen)}` });
  const why = offlineWhy(d);
  if (why) facts.push({ text: why.short, cls: why.low ? 'low' : '', title: why.long });
  if (isRinging(d.id)) facts.push({ text: 'Ringing…', cls: 'ringing', icon: 'bell' });
  if (s.battery && Number.isFinite(s.battery.level)) {
    facts.push({ label: 'Battery', text: `${Math.round(s.battery.level)}%${s.battery.charging ? ' charging' : ''}`, icon: s.battery.charging ? 'bolt' : 'battery',
      cls: lowBattery(s.battery) ? 'low' : '', title: `Battery${reported ? ` · ${reported}` : ''}` });
  }
  if (s.storage && Number.isFinite(s.storage.free)) {
    facts.push({ label: 'Storage', text: long && s.storage.total ? `${formatSize(s.storage.free)} free of ${formatSize(s.storage.total)}` : `${formatSize(s.storage.free)} free`,
      icon: 'disk', cls: lowStorage(s.storage) ? 'low' : '', title: `Free storage${reported ? ` · ${reported}` : ''}` });
  }
  const v = beamVersionOf(d);
  if (v) facts.push({ text: `Beam ${v}` });
  facts.push({ text: s.os || PLATFORM_NAME[d.platform] || d.platform });
  if (d.temporary) facts.push({ text: 'this session only' });
  if (d.signedIn === false) facts.push({ text: 'signed out' });
  return facts;
}

function factNodes(facts) {
  return facts.map((f, i) => el('span', { class: `fact${f.cls ? ` ${f.cls}` : ''}`, title: f.title || null },
    i ? el('span', { class: 'sep', 'aria-hidden': 'true' }, ' · ') : '', f.icon && icon(f.icon, 'i tiny'), f.label && el('span', { class: 'visually-hidden' }, `${f.label} `), f.text));
}

// ---------------------------------------------------------------- actions

function deviceActions(d) {
  const can = d.can || {};
  const acts = [];
  if (can.ring) {
    acts.push(isRinging(d.id)
      ? { label: 'Stop ringing', icon: 'bell-off', action: () => ringDevice(d, true) }
      : { label: 'Ring', icon: 'bell', action: () => ringDevice(d) });
  }
  if (can.wake && !d.online) acts.push({ label: 'Wake', icon: 'power', action: () => wakeDevice(d) });
  // Control (1.6, remote.js): a PC whose switch is on; a locked one says to use Remote Desktop instead.
  acts.push(...rcActions(d));
  // In the Windows app it opens directly (Beam for Windows 1.3+); in a browser it's a .rdp file.
  if (can.remoteDesktop && (!HOST || (hostHas('remoteDesktop') && rdpHost(d)))) acts.push({ label: 'Remote Desktop', icon: 'screen', action: () => remoteDesktop(d) });
  return acts;
}

async function ringDevice(d, stop = false) {
  try {
    const r = await apiJson(`api/devices/${encodeURIComponent(d.id)}/ring`, jsonBody(stop ? { stop: true } : {}));
    if (stop) {
      ringing.delete(d.id);
      toast(`Stopped ringing ${d.name}`);
    } else if (r && r.online === false) {
      toast(`${d.name} is offline, so it can’t ring right now.`, { error: true });
    } else {
      ringing.set(d.id, Date.now() + RING_MS);
      toast(`Ringing ${d.name}…`, { action: 'Stop', onAction: () => ringDevice(d, true), ms: 8000 });
      setTimeout(refreshDeviceViews, RING_MS + 500);
    }
  } catch (err) {
    toast(friendlyError(err), { error: true });
  }
  refreshDeviceViews();
}

async function wakeDevice(d) {
  try {
    const r = await apiJson(`api/devices/${encodeURIComponent(d.id)}/wake`, jsonBody({}));
    toast(`Sent a wake-up signal to ${d.name}${r?.macs > 1 ? ` (${r.macs} network cards)` : ''}. It may take a minute to come online.`, { ms: 6000 });
  } catch (err) {
    toast(err.status === 409 ? `Beam doesn’t know ${d.name}’s network card yet. Open the Beam app on it once while it’s on.` : friendlyError(err), { error: true, ms: 6000 });
  }
}

// In the Windows app: Remote Desktop opens directly (the app checks `host` and runs mstsc /v:host).
// In a browser: a .rdp file for the Remote Desktop app.
// Either way Windows asks who to sign in as. With a personal or local account a PIN or Windows Hello doesn't work there, and picking it ends in "A
// certification authority could not be contacted" (1.7.1: say so up front).
// (1.7.6: between PCs on the same work or school account Windows Hello does work, the user found.)
const RDP_SIGN_IN = 'Sign in with that PC’s Windows account: its email address (or user name) and password. Windows Hello or a PIN works only between PCs on the same work or school account.';

async function remoteDesktop(d) {
  if (HOST) {
    try {
      await hostCall('remoteDesktop', { host: rdpHost(d) });
      toast(`Opening Remote Desktop. ${RDP_SIGN_IN}`, { ms: 10000 });
    } catch (err) {
      toast(err.code === 'bad-request' ? `Beam doesn’t have a usable address for ${d.name}.` : 'Remote Desktop couldn’t start on this PC.', { error: true });
    }
    return;
  }
  const a = el('a', { href: url(`api/devices/${encodeURIComponent(d.id)}/remote-desktop.rdp`), download: `${d.name}.rdp` });
  document.body.append(a);
  a.click();
  a.remove();
  toast(`Open ${d.name}.rdp to connect with Remote Desktop. ${RDP_SIGN_IN}`, { ms: 10000 });
}

// `ring { device, by, stop, at }`: only the target rings; everyone else just shows it.
function onRingEvent(r) {
  if (!r || !r.device || r.device === me.id) return; // this device: the Windows app rings by itself (the page never makes a sound)
  if (r.stop) ringing.delete(r.device);
  else if (deviceById(r.device)?.online === false) return; // it can't hear it (whoever rang was told so)
  else {
    ringing.set(r.device, (r.at || Date.now()) + RING_MS);
    setTimeout(refreshDeviceViews, RING_MS + 500);
  }
  refreshDeviceViews();
}

function refreshDeviceViews() {
  if (current !== 'all' && deviceById(current)) renderHeader();
  if ($('#settingsDlg').open) renderSettings();
  refreshDeviceInfo();
}

function refreshDeviceInfo() {
  const dlg = $('#genDlg');
  if (dlg.open && dlg.dataset.device) openDeviceInfo(deviceById(dlg.dataset.device), { refresh: true });
}

// Everything about one device, with its actions (the "Device info" item in the conversation menu). While it's open
// it follows the device (ringing, coming online, a new status report) in place, keeping the focus where it was.
function openDeviceInfo(d, { refresh = false } = {}) {
  if (!d) return;
  const dlg = $('#genDlg');
  if (refresh && !(dlg.open && dlg.dataset.device === d.id)) return;
  const s = d.status || {};
  const why = offlineWhy(d);
  const key = keyExpiryLine(d.tailscale);
  const rows = [
    ['Status', d.online ? 'Online' : `Offline, last seen ${timeAgo(d.lastSeen)}`],
    why && ['Why', why.long, why.low],
    isRinging(d.id) && ['Ringing', 'Now'],
    s.battery && Number.isFinite(s.battery.level) && ['Battery', `${Math.round(s.battery.level)}%${s.battery.charging ? ', charging' : ''}`, lowBattery(s.battery)],
    s.storage && Number.isFinite(s.storage.free) && ['Storage', `${formatSize(s.storage.free)} free${s.storage.total ? ` of ${formatSize(s.storage.total)}` : ''}`, lowStorage(s.storage)],
    ['System', s.os || PLATFORM_NAME[d.platform] || d.platform],
    beamVersionOf(d) && ['Beam', beamVersionOf(d)],
    (d.tailscale?.dns || d.tailscale?.ip) && ['Tailscale', d.tailscale.dns || d.tailscale.ip],
    key && ['Tailscale sign-in', key.text, key.low],
    s.at && ['Reported', timeAgo(s.at)],
  ].filter(Boolean);
  const facts = el('dl', { class: 'facts' }, ...rows.flatMap(([k, v, low]) => [el('dt', {}, k), el('dd', { class: low ? 'low' : null }, v)]));
  const buttons = deviceActions(d).map(a => el('button', { class: 'btn', type: 'button', disabled: Boolean(a.disabled), onclick: () => a.action() }, icon(a.icon), a.label));
  const body = [facts, alertsSupported() && offlineAlertToggle(d)].filter(Boolean);
  if (refresh) {
    const focusables = () => [...dlg.querySelectorAll('button, input')];
    const at = focusables().indexOf(document.activeElement);
    $('#genTitle').textContent = d.name;
    $('#genBody').replaceChildren(...body);
    $('#genFoot').replaceChildren(...buttons);
    $('#genFoot').hidden = !buttons.length;
    if (at >= 0) focusables()[Math.min(at, focusables().length - 1)]?.focus({ preventScroll: true });
    return;
  }
  openDialog({ title: d.name, body, buttons });
  dlg.dataset.device = d.id;
  // The offline-alert toggle needs the server's settings: load them once, then fill it in.
  if (!serverSettings && serverHas('settings')) loadServerSettings().then(() => openDeviceInfo(deviceById(d.id), { refresh: true }));
}

// ---------------------------------------------------------------- alerts

const alertsSupported = () => Boolean(serverSettings?.alerts) || serverHas('alerts');

// `alert { id, kind, device, level, text, at }`: a toast (and a notification when Beam is in the background).
function onAlertEvent(a) {
  if (!a || !a.text) return;
  if (recentAlerts) recentAlerts = [a, ...recentAlerts.filter(x => x.id !== a.id)].slice(0, 100); // the history has them all
  if ($('#settingsDlg').open) renderSettings();
  if (a.device && a.device === me.id && a.kind !== 'serverDisk' && a.kind !== 'tailscaleKey') return; // the device itself tells its user (not about its Tailscale key)
  if (!document.hidden) {
    toast(a.text, { warn: a.level === 'warn', ms: 9000, action: a.device && deviceById(a.device) ? 'Show' : null, onAction: () => { openConv(a.device); } });
  } else if (!HOST && 'Notification' in window && Notification.permission === 'granted') {
    showNotification(a.level === 'warn' ? 'Beam alert' : 'Beam', { body: a.text, icon: url('icon-192.png'), tag: `alert-${a.id || a.at}`, data: { conv: a.device && deviceById(a.device) ? a.device : 'all' } },
      () => { if (a.device) openConv(a.device); });
  }
}

async function loadAlerts() {
  try {
    const res = await apiJson('api/alerts');
    recentAlerts = (Array.isArray(res) ? res : res.alerts || []).slice().sort((x, y) => (y.at || 0) - (x.at || 0));
  } catch { recentAlerts = recentAlerts || []; }
  return recentAlerts;
}

// Only what changed (the server merges); `offline` is always the whole list.
async function setAlerts(fields) {
  await patchServerSettings({ alerts: fields });
  refreshDeviceInfo();
}

function offlineAlertToggle(d) {
  const watched = (serverSettings?.alerts?.offline || []).includes(d.id);
  return toggle('Alert me when it goes offline', watched, v => {
    const list = new Set(serverSettings?.alerts?.offline || []);
    if (v) list.add(d.id); else list.delete(d.id);
    setAlerts({ offline: [...list] });
  }, { hint: 'After 10 minutes offline, and again when it’s back.' });
}

function sectionAlerts() {
  const a = serverSettings?.alerts;
  if (!a) return note('This Beam server doesn’t send alerts.');
  const watched = (a.offline || []).map(id => nameOf(id));
  const parts = [
    note('Alerts show up here and on your devices (and through ntfy, if the server has it set up).'),
    toggle('A device’s battery is low', a.battery, v => setAlerts({ battery: v }), { hint: '15% or less and not charging.' }),
    toggle('A device is running out of storage', a.storage, v => setAlerts({ storage: v }), { hint: 'Less than 2 GB (or 5%) free.' }),
    toggle('The Beam server’s disk is almost full', a.serverDisk, v => setAlerts({ serverDisk: v })),
    typeof a.tailscaleKey === 'boolean' && toggle('A Tailscale sign-in is running out', a.tailscaleKey, v => setAlerts({ tailscaleKey: v }), { hint: 'Two weeks and three days before, for your devices and this server.' }), // (1.17)
    field('Devices going offline', note(watched.length ? `Watching ${watched.join(', ')}.` : 'None yet. Turn it on for a device under Devices.')),
    el('h4', {}, 'Recent alerts'),
  ];
  if (!recentAlerts) {
    parts.push(note('Loading…'));
    loadAlerts().then(() => { if ($('#settingsDlg').open) renderSettings(); });
  } else if (!recentAlerts.length) parts.push(note('No alerts so far.'));
  else {
    parts.push(el('ul', { class: 'alert-list' }, ...recentAlerts.slice(0, 30).map(x => el('li', { class: x.level === 'warn' ? 'warn-row' : '' },
      icon(x.level === 'warn' ? 'alert' : 'bell'), el('span', { class: 'alert-text' }, x.text), el('span', { class: 'muted small' }, x.at ? shortWhen(x.at) : '')))));
  }
  return parts;
}

// ---------------------------------------------------------------- remote control, the chat app's side: Control, Settings
// (1.6; here since 1.12.2: the viewer itself, remote.js, loads only on its own page)

let rcSessionList = null;       // the sessions going on (GET /api/rc/sessions, `rc-sessions`), for Settings
const rcTurningOff = new Set(); // PCs asked to turn remote control off, until their switch says so
const rcFeature = () => serverHas('remote-control');

// Control (next to Remote Desktop) for a PC this device can control. A locked one says what to use instead.
function rcActions(d) {
  if (!rcFeature() || !d || d.id === me.id) return [];
  if (d.can?.remoteControl && (!HOST || hostHas('remoteControl'))) return [{ label: 'Control', icon: 'pointer', action: () => openRemote(d) }];
  if (d.status?.remoteControl === true && d.status?.locked === true && !rcTurningOff.has(d.id) && (!HOST || hostHas('remoteControl'))) {
    return [{ label: `${d.name} is locked: use Remote Desktop`, icon: 'lock', disabled: true, action: () => {} }];
  }
  return [];
}

// The viewer: the Windows app's own window, else a new tab.
function openRemote(d) {
  if (HOST) {
    hostCall('openRemote', { device: d.id }).catch(err => toast(err.message || 'The Beam app couldn’t open the remote screen.', { error: true }));
    return;
  }
  window.open(`${BASE.href}#remote=${encodeURIComponent(d.id)}`, '_blank', 'noopener');
}

function onRcSessions(d) {
  rcSessionList = Array.isArray(d?.sessions) ? d.sessions.filter(s => s && typeof s.id === 'string') : [];
  if ($('#settingsDlg')?.open) renderSettings();
}

async function loadRcSessions() {
  if (!rcFeature()) return;
  try { onRcSessions(await apiJson('api/rc/sessions')); } catch {}
}

// What a session line says. (1.16) A kvm session is another device's own keyboard and mouse working the PC (no picture).
const rcLineText = s => (s.kind === 'kvm'
  ? (s.state === 'live' ? `Using ${nameOf(s.viewer)}’s keyboard and mouse` : `${nameOf(s.viewer)}’s keyboard and mouse are connecting`)
  : s.state === 'live' ? `Being controlled from ${nameOf(s.viewer)}` : `${nameOf(s.viewer)} is connecting to control it`);

// Settings → Devices, under a PC: who controls it (End), and turning remote control off. Never on: that's only at
// the PC itself.
function rcDeviceRows(d) {
  if (!rcFeature() || !d) return [];
  if (rcTurningOff.has(d.id) && d.status?.remoteControl !== true) rcTurningOff.delete(d.id);
  const out = (rcSessionList || []).filter(x => x.host === d.id).map(s => el('p', { class: 'rc-line small' }, icon('screen', 'i tiny'),
    el('span', {}, rcLineText(s)), ' · ',
    el('button', { class: 'linkish', type: 'button', onclick: () => endRcFromHere(s, d) }, 'End')));
  if (d.status?.remoteControl === true) {
    out.push(rcTurningOff.has(d.id) ? el('p', { class: 'muted small' }, `Turning off remote control on ${d.name}…`)
      : el('div', { class: 'dev-actions' }, el('button', { class: 'btn small-btn ghost', type: 'button', onclick: () => disableRemote(d) }, icon('power'), 'Turn off remote control')));
  }
  return out;
}

async function endRcFromHere(s, d) {
  try {
    await api(`api/rc/sessions/${encodeURIComponent(s.id)}/end`, jsonBody({}));
    toast(`Ended the session on ${d?.name || 'the PC'}`);
    rcSessionList = (rcSessionList || []).filter(x => x.id !== s.id);
    if ($('#settingsDlg')?.open) renderSettings();
  } catch (err) { toast(friendlyError(err), { error: true }); }
}

async function disableRemote(d) {
  const ok = await confirmDialog({
    title: `Turn off remote control on ${d.name}?`,
    text: `A session going on ends at once, and nobody can control ${d.name} until someone turns “Allow remote control” on again at that PC.`,
    confirm: 'Turn off', danger: true,
  });
  if (!ok) return;
  try {
    await api('api/rc/disable', jsonBody({ device: d.id }));
    rcTurningOff.add(d.id);
    toast(`Turning off remote control on ${d.name}`);
  } catch (err) { toast(friendlyError(err), { error: true }); }
  if ($('#settingsDlg')?.open) renderSettings();
}

// Settings → This PC (the Windows app): its own switch, which the page can only turn off (`native-only` for on), and
// who may control it (read-only here: the list is changed in the app's own settings).
function rcPcRows(s) {
  if (typeof s?.allowRemoteControl !== 'boolean') return [];
  const mine = (rcSessionList || []).filter(x => x.host === me.id);
  const allowed = Array.isArray(s.remoteControlDevices) ? s.remoteControlDevices.filter(x => x && typeof x.id === 'string') : null;
  return [
    el('h4', {}, 'Remote control'),
    s.allowRemoteControl
      ? el('div', { class: 'field rc-pc' }, el('p', { class: 'small' }, 'On: your devices can see and control this PC. It shows a banner while they do, with Stop (or press Ctrl+Alt+Shift+F12).'),
        el('div', { class: 'dev-actions' }, el('button', { class: 'btn small-btn ghost', type: 'button', onclick: async () => {
          const r = await hostDo('setSettings', { settings: { allowRemoteControl: false } });
          if (r?.settings) { hostState.settings = r.settings; renderSettings(); }
        } }, icon('power'), 'Turn off remote control')))
      : note('Off. To let your devices control this PC, turn on “Allow remote control” in Beam’s menu in the taskbar corner (it asks you to confirm).'),
    allowed && field('Can be controlled from', el('p', { class: 'small rc-allowed' }, allowed.length ? allowed.map(x => cleanName(x.name) || nameOf(x.id)).join(', ') : 'No device yet'),
      note('The list is changed in Beam’s own settings on this PC: tray → Remote control devices…')),
    ...mine.map(x => el('p', { class: 'rc-line small' }, icon('screen', 'i tiny'), el('span', {}, rcLineText(x)), ' · ',
      el('button', { class: 'linkish', type: 'button', onclick: () => endRcFromHere(x, { name: 'this PC' }) }, 'End'))),
  ].filter(Boolean);
}
