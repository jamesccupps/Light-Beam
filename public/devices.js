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

// The facts about a device, most useful first: [{ text, cls, icon, title }].
function deviceFacts(d, { long = false } = {}) {
  const facts = [];
  const s = d.status || {};
  const reported = s.at ? `Reported ${timeAgo(s.at)}` : '';
  facts.push({ text: d.online ? 'Online' : long ? `Offline, last seen ${timeAgo(d.lastSeen)}` : `Last seen ${timeAgo(d.lastSeen)}` });
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
// Either way Windows asks who to sign in as. A PIN or Windows Hello doesn't work there, and picking it ends in "A
// certification authority could not be contacted" (1.7.1: say so up front).
const RDP_SIGN_IN = 'Sign in with that PC’s Windows account: its email address (or user name) and password. A PIN or Windows Hello doesn’t work over Remote Desktop.';

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
  const rows = [
    ['Status', d.online ? 'Online' : `Offline, last seen ${timeAgo(d.lastSeen)}`],
    isRinging(d.id) && ['Ringing', 'Now'],
    s.battery && Number.isFinite(s.battery.level) && ['Battery', `${Math.round(s.battery.level)}%${s.battery.charging ? ', charging' : ''}`, lowBattery(s.battery)],
    s.storage && Number.isFinite(s.storage.free) && ['Storage', `${formatSize(s.storage.free)} free${s.storage.total ? ` of ${formatSize(s.storage.total)}` : ''}`, lowStorage(s.storage)],
    ['System', s.os || PLATFORM_NAME[d.platform] || d.platform],
    beamVersionOf(d) && ['Beam', beamVersionOf(d)],
    (d.tailscale?.dns || d.tailscale?.ip) && ['Tailscale', d.tailscale.dns || d.tailscale.ip],
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
  if (a.device && a.device === me.id && a.kind !== 'serverDisk') return; // the device itself tells its user
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
