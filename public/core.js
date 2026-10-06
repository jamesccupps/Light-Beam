'use strict';
// Beam web app. Plain scripts loaded in order (core, cache, model, host, thread, send, live, signin, settings,
// devices, phone, extras, gallery, app; remote.js only on the remote control viewer's page, added by app.js); they
// share one global scope and app.js starts everything. See docs/API.md for the protocol and
// docs/HOST-BRIDGE.md for "host mode" (the page running inside the Windows app).

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const SVG_NS = 'http://www.w3.org/2000/svg';
// The app's root: every URL is relative to it, so Beam also works under a path such as https://nas/beam/.
const BASE = new URL('./', location.href);
const url = path => new URL(path, BASE).href;
const FINE_POINTER = matchMedia('(hover: hover) and (pointer: fine)');
const NARROW = matchMedia('(max-width: 760px)');
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');
const PLATFORM_ICON = { windows: 'monitor', mac: 'monitor', linux: 'monitor', android: 'phone', ios: 'phone', web: 'globe', cli: 'terminal' };
const PLATFORM_NAME = { windows: 'Windows', mac: 'Mac', linux: 'Linux', android: 'Android', ios: 'iPhone', web: 'Browser', cli: 'Command line', other: 'Script' };
// Where Tailscale's relay servers are, by region code (remote control's details and Settings → Connections).
const RELAY_CITIES = {
  nyc: 'New York', sfo: 'San Francisco', sea: 'Seattle', ord: 'Chicago', dfw: 'Dallas', den: 'Denver', mia: 'Miami', lax: 'Los Angeles',
  tor: 'Toronto', hnl: 'Honolulu', sao: 'São Paulo', lhr: 'London', fra: 'Frankfurt', par: 'Paris', mad: 'Madrid', ams: 'Amsterdam',
  waw: 'Warsaw', jnb: 'Johannesburg', nai: 'Nairobi', dbi: 'Dubai', blr: 'Bangalore', sin: 'Singapore', hkg: 'Hong Kong', tok: 'Tokyo', syd: 'Sydney',
};
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;

// Host mode: the page is the Windows app's messenger window (WebView2). Contract: docs/HOST-BRIDGE.md.
const HOST = window.beamHost && window.chrome && window.chrome.webview ? window.beamHost : null;
const hostHas = feature => Boolean(HOST && Array.isArray(HOST.features) && HOST.features.includes(feature));

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
  remove(key) { try { localStorage.removeItem(key); } catch {} },
  json(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  setJson(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};

// ---------------------------------------------------------------- small utils

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter(c => c != null && c !== false));
  return node;
}

function icon(name, cls = 'i') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function mini(iconName, label, onclick, extra = {}) {
  return el('button', { class: 'mini', type: 'button', title: label, 'aria-label': label, onclick, ...extra }, icon(iconName));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const plural = (n, word, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;

function formatSize(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function formatDuration(secs) {
  if (!Number.isFinite(secs) || secs < 0) return '';
  if (secs < 60) return `${Math.max(1, Math.round(secs))} s`;
  if (secs < 3600) return `${Math.round(secs / 60)} min`;
  return `${Math.floor(secs / 3600)} h ${Math.round((secs % 3600) / 60)} min`;
}

function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// toLocale…String builds a locale formatter on every call (a fifth of the time it took to open a conversation),
// so the few formats Beam shows are built once. Same output.
const dateFormats = new Map();
const dateFormat = (options, key = JSON.stringify(options)) => {
  let f = dateFormats.get(key);
  if (!f) dateFormats.set(key, (f = new Intl.DateTimeFormat(undefined, options)));
  return f;
};
const clock = ts => dateFormat({ hour: 'numeric', minute: '2-digit' }).format(ts);
// What Date#toLocaleString() shows: the date and the time with seconds.
const fullWhen = ts => dateFormat({ year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).format(ts);
const dayKey = ts => new Date(ts).toDateString();

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  const opts = { weekday: 'long', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return dateFormat(opts).format(d);
}

function shortWhen(ts) {
  if (dayKey(ts) === dayKey(Date.now())) return clock(ts);
  if (Date.now() - ts < 6 * 86400e3) return dateFormat({ weekday: 'short' }).format(ts);
  return dateFormat({ month: 'short', day: 'numeric' }).format(ts);
}

function stamp(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

const extOf = name => (name && name.includes('.') ? name.split('.').pop().slice(0, 4).toUpperCase() : 'FILE');
const randomId = (bytes = 12) => [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
const isHttpUrl = s => { try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; } };

function debounce(fn, ms) {
  let t;
  const run = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  run.flush = (...args) => { clearTimeout(t); fn(...args); };
  return run;
}

// Runs fn once, `ms` after the first call since it last ran. Later calls join that run instead of pushing it back,
// so a steady stream of changes can't postpone it forever (fn reads the current state when it runs).
function batched(fn, ms) {
  let t = null;
  const run = () => { if (t === null) t = setTimeout(() => { t = null; fn(); }, ms); };
  run.flushPending = () => { if (t !== null) { clearTimeout(t); t = null; fn(); } };
  return run;
}

// ---------------------------------------------------------------- toast (with an optional action button)

let toastTimer;
let toastAction = null;
function toast(message, opts = {}) {
  if (typeof opts === 'number') opts = { ms: opts };
  const node = $('#toast');
  $('#toastText').textContent = message;
  const btn = $('#toastAction');
  toastAction = opts.onAction || null;
  btn.hidden = !opts.action;
  btn.textContent = opts.action || '';
  node.classList.toggle('error', Boolean(opts.error));
  node.classList.toggle('warn', Boolean(opts.warn) && !opts.error);
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, opts.ms || (opts.action ? 6000 : 2600));
}
function hideToast() {
  $('#toast').classList.remove('show');
  toastAction = null;
}

// ---------------------------------------------------------------- generic dialogs (no window.confirm: it blocks the event stream and looks foreign in the Windows app)

let dialogGen = 0;
function openDialog({ title, body = [], buttons = [], wide = false, className = '', onClose } = {}) {
  const dlg = $('#genDlg');
  const gen = ++dialogGen;
  if (dlg.open) dlg.close('replaced');
  delete dlg.dataset.device; // set again by openDeviceInfo; any other content isn't about a device
  $('#genTitle').textContent = title || '';
  $('#genBody').replaceChildren(...[].concat(body).filter(Boolean));
  $('#genFoot').replaceChildren(...buttons);
  $('#genFoot').hidden = !buttons.length;
  dlg.className = `dlg${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`;
  dlg.returnValue = '';
  if (onClose) {
    // The browser fires `close` a moment after close(): the event for the dialog this one replaced arrives while
    // this one is already open, and must not count as closing this one.
    const handler = () => {
      if (gen === dialogGen && dlg.open) return;
      dlg.removeEventListener('close', handler);
      onClose(gen === dialogGen ? dlg.returnValue : 'replaced');
    };
    dlg.addEventListener('close', handler);
  }
  dlg.showModal();
  return dlg;
}

// Resolves true/false. `danger` styles the confirm button red.
function confirmDialog({ title, text, confirm = 'OK', cancel = 'Cancel', danger = false, extra } = {}) {
  return new Promise(resolve => {
    const ok = el('button', { class: `btn ${danger ? 'danger-fill' : 'primary'}`, type: 'button', onclick: () => { dlg.returnValue = 'ok'; dlg.close('ok'); } }, confirm);
    const no = el('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close('cancel') }, cancel);
    const dlg = openDialog({ title, body: [text && el('p', {}, text), extra], buttons: [no, ok], onClose: v => resolve(v === 'ok') });
    ok.focus();
  });
}

// ---------------------------------------------------------------- this device

// Browsers are named for what they are ("Chrome on work-laptop") so they aren't mistaken for the native app.
function browserName() {
  const ua = navigator.userAgent;
  return /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox'
    : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
}
function osName() {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
    : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : '';
}
function defaultName() {
  const machine = cleanName(store.get('beam.machine') || '');
  const where = machine || osName();
  return where ? `${browserName()} on ${where}` : browserName();
}
const cleanName = s => String(s || '').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g, '').trim().slice(0, 40);
// Names the app picked by itself (older versions too); anything else was chosen by the user.
const AUTO_NAME = /^((Chrome|Edge|Firefox|Opera|Safari|Samsung Internet|Browser)( on .+)?|iPhone|iPad|Android (phone|tablet)|Windows PC|Mac|Chromebook|Linux PC)( browser)?$/;

const me = { id: '', name: '', platform: 'web', named: false, temporary: false };

function setCookie(name, value) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=${BASE.pathname}; max-age=315360000; samesite=lax${location.protocol === 'https:' ? '; secure' : ''}`;
}

function initIdentity() {
  if (HOST) {
    me.id = String(HOST.deviceId || '');
    me.platform = /^[a-z]{2,12}$/.test(HOST.platform || '') ? HOST.platform : 'windows';
    setDeviceName(cleanName(HOST.deviceName) || 'Windows PC', { chosen: true });
    return;
  }
  me.id = store.get('beam.deviceId');
  if (!DEVICE_ID.test(me.id || '')) {
    me.id = randomId(12);
    store.set('beam.deviceId', me.id);
  }
  setCookie('beam_device_id', me.id);
  const saved = cleanName(store.get('beam.device'));
  me.named = store.get('beam.named') === '1' || Boolean(saved && !AUTO_NAME.test(saved));
  setDeviceName(me.named ? saved : '', { chosen: me.named });
}

function setDeviceName(name, { chosen = false } = {}) {
  name = cleanName(name);
  me.named = chosen && Boolean(name);
  me.name = me.named ? name : defaultName();
  if (!HOST) {
    store.set('beam.device', me.name);
    store.set('beam.named', me.named ? '1' : '0');
    setCookie('beam_device', me.name);
  }
  const label = $('#deviceLabel');
  if (label) label.textContent = me.name;
}

// The server told us the Tailscale machine name (API v3 /api/me → machine.name): better default names.
function learnMachineName(name) {
  name = cleanName(name);
  if (!name || HOST || name === store.get('beam.machine')) return false;
  store.set('beam.machine', name);
  if (me.named) return false;
  setDeviceName('');
  return true;
}

const idHeaders = () => ({ 'X-Beam-Device-Id': me.id, 'X-Beam-Device': encodeURIComponent(me.name), 'X-Beam-Platform': me.platform });

// ---------------------------------------------------------------- connection state (drives the status dot, offline banner and outbox)

const net = {
  state: 'connecting', // online | connecting | offline
  cause: '',           // why we're offline, in words
  since: 0,
  listeners: new Set(),
  set(state, cause = '') {
    if (this.state === state && this.cause === cause) return;
    const was = this.state;
    this.state = state;
    this.cause = cause;
    this.since = Date.now();
    for (const fn of this.listeners) { try { fn(state, was); } catch (err) { console.error(err); } }
  },
  ok() { this.set('online'); },
  fail(info = {}) { this.set('offline', offlineCause(info)); },
};

// A best guess at why the server can't be reached, in words the user can act on.
function offlineCause({ status, error } = {}) {
  const host = location.hostname;
  if (!navigator.onLine) return 'This device is offline.';
  if (status >= 502 && status <= 504) return 'The address answers, but the Beam server isn’t running there right now.';
  if (status === 503) return 'The Beam server is busy or restarting.';
  if (/\.ts\.net$/i.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return 'Is Tailscale connected on this device? The server PC may also be asleep or off.';
  if (error && error.name === 'TimeoutError') return 'The server isn’t answering. Its PC may be asleep or off.';
  return 'The server PC may be asleep or off, or not on this network.';
}

// Friendly wording for HTTP errors.
function friendlyStatus(status, serverMessage, retryAfter = 0) {
  const wait = retryAfter > 0 ? ` Try again in ${formatDuration(retryAfter)}.` : '';
  if (status === 413) return serverMessage && /limit|larger/i.test(serverMessage) ? serverMessage : 'That’s too big for this Beam server.';
  if (status === 507) return 'The Beam server is out of disk space. Delete some items or free up space on the server.';
  if (status === 429) return serverMessage ? `${serverMessage}${/again/i.test(serverMessage) ? '' : wait}` : `Too many tries.${wait || ' Wait a minute and try again.'}`;
  if (status === 503) return `Beam is busy moving to a new address.${wait || ' Try again in a moment.'}`;
  if (status === 403) return serverMessage || 'Beam refused that.';
  if (status === 404) return serverMessage || 'That item is gone (it may have been deleted or expired).';
  if (status >= 500) return 'The Beam server had a problem. Try again in a moment.';
  return serverMessage || `Something went wrong (${status}).`;
}

function friendlyError(err) {
  if (!err) return 'Something went wrong.';
  if (err.offline) return `Can’t reach Beam. ${net.cause || offlineCause()}`;
  if (err.name === 'AbortError') return 'Cancelled.';
  if (err.name === 'TypeError' && /fetch|network/i.test(err.message)) return `Can’t reach Beam. ${offlineCause()}`;
  return err.message || 'Something went wrong.';
}

// These are set by signin.js (lock screen / host states).
let onUnauthorized = () => {};
let onMoved = () => {};

async function api(path, options = {}) {
  const { timeout, allow401, ...init } = options;
  let res;
  try {
    res = await fetch(url(path), {
      credentials: 'same-origin',
      ...init,
      signal: init.signal || (timeout ? AbortSignal.timeout(timeout) : undefined),
      headers: { ...idHeaders(), ...init.headers },
    });
  } catch (err) {
    if (err.name === 'AbortError' && !timeout) throw err;
    net.fail({ error: err });
    throw Object.assign(new Error('offline'), { offline: true, cause: err });
  }
  if (res.status === 401 && !allow401) {
    onUnauthorized('api', (await res.json().catch(() => ({}))).serverId);
    throw Object.assign(new Error('This device is not signed in.'), { status: 401 });
  }
  if (res.status === 410) {
    const body = await res.json().catch(() => ({}));
    onMoved(body.movedTo);
    throw Object.assign(new Error('Beam has moved.'), { status: 410, moved: true });
  }
  if (res.status === 502 || res.status === 504) {
    net.fail({ status: res.status });
    throw Object.assign(new Error('offline'), { offline: true, status: res.status });
  }
  if (!res.ok && res.status !== 401) {
    const body = await res.json().catch(() => ({}));
    const retryAfter = Number(res.headers.get('Retry-After')) || body.retryAfter || 0;
    throw Object.assign(new Error(friendlyStatus(res.status, body.error, retryAfter)), { status: res.status, body, retryAfter });
  }
  // After a merge the server tells us who we are now (API v3).
  const you = res.headers.get('X-Beam-You');
  if (you && you !== me.id && !HOST && typeof adoptIdentity === 'function') adoptIdentity(you);
  if (net.state !== 'online' && res.ok) net.ok();
  return res;
}

const apiJson = (path, options) => api(path, options).then(r => r.json());
const jsonBody = (body, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// What the server can do (filled from /api/info and the `hello` event).
const server = { api: 2, features: new Set(), version: '', serverId: '', answered: '', web: '', info: null, maxUpload: 4096 * 1024 * 1024, maxItems: 500 };
const serverHas = feature => server.features.has(feature) || (server.api >= 3 && V3_DEFAULT_FEATURES.has(feature));
const V3_DEFAULT_FEATURES = new Set(['tokens', 'settings', 'move', 'handoff', 'forward', 'bulk-delete', 'pin', 'read-markers', 'logs', 'thumbnails', 'sessions', 'upload-progress']);

// One request at a time (callers that overlap share it).
let infoLoading = null;
function loadServerInfo() {
  infoLoading ||= (async () => {
    try {
      const info = await apiJson('api/info', { timeout: 15000 });
      server.info = info;
      server.api = Number(info.api) || 2;
      if (Array.isArray(info.features)) server.features = new Set(info.features);
      server.version = info.version || '';
      if (info.serverId) answeredBy(info.serverId);
      phoneAudienceChanged();
      if (info.maxUpload) server.maxUpload = info.maxUpload;
      const maxItems = info.maxItems ?? info.settings?.maxItems;
      if (Number.isFinite(maxItems)) server.maxItems = maxItems;
      // (1.7) Beam Family, when this Beam knows where it is: a link in the header (it opens in the browser).
      const family = document.getElementById('familyLink');
      if (family) {
        const url = /^https?:\/\//i.test(info.family || '') ? info.family : '';
        family.hidden = !url;
        if (url) family.href = url;
      }
      return info;
    } catch {
      return server.info;
    }
  })().finally(() => { infoLoading = null; });
  return infoLoading;
}
