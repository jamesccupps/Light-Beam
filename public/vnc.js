// Remote control of a Linux computer (Beam 1.23): index.html#vnc=<device id>. The computer's own screen sharing (its
// VNC server, which its Beam for Linux runs) relayed by Beam, shown with noVNC (public/novnc, MPL-2.0, unchanged).
// A module, loaded only on this page (app.js loadVnc); it uses the chat app's helpers (core.js), whose scripts load
// first. Like the PCs' viewer (remote.js) this page stores nothing: the identity is read, never written.
import RFB from './novnc/core/rfb.js';

const vnc = {
  id: (/^#vnc=([A-Za-z0-9_-]{8,64})$/.exec(location.hash) || [])[1] || '',
  name: '', session: '', rfb: null, events: null,
  state: 'connecting', step: '', end: null, fit: true, piClip: '', live: false,
};
const ui = {};

// What a session's end says, by reason (the server's rc-end, or this page's own).
const ENDED = {
  stopped: () => ['Disconnected', vnc.end?.by && vnc.end.from !== me.id ? `${vnc.end.by} ended it.` : ''],
  declined: () => ['Remote control is off there', `Turn it on at ${vnc.name || 'that computer'}: beam control on`],
  'not-allowed': () => ['Remote control is off there', ''],
  busy: () => ['Someone else is controlling it', ''],
  revoked: () => ['Remote control was turned off', ''],
  failed: () => [`${vnc.name || 'The computer'} couldn’t share its screen`, ''],
  lease: () => ['The connection was lost', ''],
  server: () => ['Beam restarted', ''],
  offline: () => [`${vnc.name || 'That computer'} isn’t connected to Beam`, 'Check that it’s on and its Beam for Linux is running.'],
  'signed-out': () => ['This device was signed out', ''],
  error: () => ['Something went wrong', ''],
};

// ---------------------------------------------------------------- start

function start() {
  document.documentElement.classList.add('remote-mode');
  document.documentElement.classList.toggle('host', Boolean(HOST));
  initVncIdentity();
  // Nothing of the chat app runs here: a sign-out ends this view, a move just says so, a new identity changes nothing.
  onUnauthorized = () => { if (HOST) hostPost('unauthorized'); ended({ reason: 'signed-out' }); };
  onMoved = () => ended({ reason: 'error', text: 'Beam has moved.' });
  adoptIdentity = you => { if (!HOST && DEVICE_ID.test(you || '')) me.id = you; return false; };
  build();
  window.addEventListener('hashchange', () => location.reload());
  window.addEventListener('pagehide', leave);
  document.addEventListener('fullscreenchange', renderTools);
  window.addEventListener('resize', applyFit);
  setInterval(() => { if (vnc.live) applyFit(); }, 1000); // (the computer's own screen may change size: noVNC says nothing)
  connect();
}

function initVncIdentity() {
  if (HOST) return initIdentity();
  const id = store.get('beam.deviceId');
  me.id = DEVICE_ID.test(id || '') ? id : randomId(12);
  const saved = cleanName(store.get('beam.device'));
  me.named = store.get('beam.named') === '1' || Boolean(saved && !AUTO_NAME.test(saved));
  me.name = me.named && saved ? saved : defaultName();
}

function build() {
  ui.name = el('strong', { class: 'rc-name', dir: 'auto' });
  ui.tools = el('div', { class: 'rc-tools' });
  ui.screen = el('div', { class: 'rc-vnc', 'aria-label': 'The remote screen' });
  ui.card = el('div', { class: 'rc-card', role: 'status', 'aria-live': 'polite' });
  ui.overlay = el('div', { class: 'rc-overlay' }, ui.card);
  ui.root = el('div', { id: 'remote', class: 'rc vnc' },
    el('header', { class: 'rc-bar' }, el('span', { class: 'rc-title' }, icon('monitor'), ui.name), ui.tools),
    el('div', { class: 'rc-body' }, ui.screen, ui.overlay));
  document.body.prepend(ui.root);
  render();
}

// ---------------------------------------------------------------- the session

async function connect() {
  vnc.end = null;
  vnc.live = false;
  vnc.piClip = '';
  setState('connecting', 'Connecting to Beam…');
  try {
    const list = await apiJson('api/devices', { timeout: 15000 });
    const d = (list.devices || []).find(x => x && x.id === vnc.id);
    if (!d) return ended({ reason: 'error', text: 'Beam doesn’t know that device (it may have been removed).' });
    vnc.name = cleanName(d.name) || 'The computer';
    document.title = `${vnc.name} · Beam`;
    if (d.platform !== 'linux') { location.replace(`${BASE.pathname}#remote=${encodeURIComponent(vnc.id)}`); return; } // (a PC: its own viewer)
    openEvents();
    setState('connecting', `Asking ${vnc.name}…`);
    const s = await apiJson('api/rc/sessions', jsonBody({ device: vnc.id, kind: 'vnc' }));
    vnc.session = String(s.id);
    setState('connecting', `Starting ${vnc.name}’s screen…`);
    const rfb = new RFB(ui.screen, relayUrl(vnc.session), { wsProtocols: ['binary'] });
    rfb.scaleViewport = false; // (fit: see applyFit)
    rfb.clipViewport = false; // (1:1 scrolls when the screen is bigger than the window)
    rfb.dragViewport = false;
    rfb.resizeSession = false;
    rfb.showDotCursor = true;
    rfb.focusOnClick = true;
    // (1.23.1, the user: "the resolution isnt that high": the best JPEG quality, for sharp text; the link is the tailnet)
    rfb.qualityLevel = 9;
    rfb.compressionLevel = 2;
    rfb.background = '#0b0c0f';
    rfb.addEventListener('connect', () => { vnc.live = true; setState('live'); applyFit(); rfb.focus(); });
    rfb.addEventListener('disconnect', e => {
      if (vnc.rfb !== rfb) return;
      vnc.rfb = null;
      // (the server's rc-end, with the reason and the computer's own words, comes on the event stream: give it a moment)
      setTimeout(() => ended(vnc.end || { reason: e.detail?.clean && vnc.live ? 'stopped' : 'failed' }), vnc.end ? 0 : 600);
    });
    rfb.addEventListener('credentialsrequired', () => { vnc.end = { reason: 'failed', detail: 'its VNC server asks for a password' }; rfb.disconnect(); });
    rfb.addEventListener('securityfailure', e => { vnc.end = { reason: 'failed', detail: e.detail?.reason || 'its VNC server refused the connection' }; });
    rfb.addEventListener('clipboard', e => { vnc.piClip = String(e.detail?.text || ''); renderTools(); });
    vnc.rfb = rfb;
  } catch (err) {
    if (err.status === 401) return ended({ reason: 'signed-out' });
    ended({ reason: err.body?.reason || 'error', text: err.offline ? 'Can’t reach Beam right now.' : friendlyError(err) });
  }
}

// wss://<Beam>/api/rc/sessions/<id>/vnc (the page's own sign-in goes with it)
function relayUrl(id) {
  const u = new URL(`api/rc/sessions/${encodeURIComponent(id)}/vnc`, BASE);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.href;
}

// Beam's events for this page: only the end of its session (why, by whom, the computer's own words).
function openEvents() {
  if (vnc.events) return;
  const es = new EventSource(url(`api/events?device=${encodeURIComponent(me.id)}&name=${encodeURIComponent(me.name)}&platform=${encodeURIComponent(me.platform)}`));
  es.addEventListener('rc-end', e => {
    let d = {};
    try { d = JSON.parse(e.data); } catch {}
    if (!vnc.session || d.id !== vnc.session) return;
    vnc.end = d;
    if (vnc.rfb) vnc.rfb.disconnect();
    else ended(d);
  });
  vnc.events = es;
}

function closeEvents() {
  vnc.events?.close();
  vnc.events = null;
}

function disconnect() {
  vnc.end = { reason: 'stopped', from: me.id };
  if (vnc.rfb) vnc.rfb.disconnect(); // (the relay closing ends the session)
  else ended(vnc.end);
}

// The page going away: the relay closes with it; and the session ends now, not when Beam notices.
function leave() {
  if (!vnc.session || vnc.state === 'ended') return;
  try { fetch(url(`api/rc/sessions/${vnc.session}/end`), { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', ...idHeaders() }, body: '{}' }); } catch {}
  vnc.rfb?.disconnect();
}

function ended(end) {
  vnc.end = end;
  vnc.live = false;
  closeEvents();
  setState('ended');
}

// ---------------------------------------------------------------- the clipboard and the window

// What was copied here, onto the computer's clipboard (then Ctrl+V there pastes it).
async function pasteToPi() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch {
    return toast('Beam can’t read this device’s clipboard here (the browser didn’t allow it).', { error: true });
  }
  if (!text) return toast('There’s no text on this device’s clipboard.');
  vnc.rfb?.clipboardPasteFrom(text);
  toast(`On ${vnc.name}’s clipboard: paste it there with Ctrl+V`);
  vnc.rfb?.focus();
}

async function copyFromPi() {
  try {
    await navigator.clipboard.writeText(vnc.piClip);
    toast(`Copied what was copied on ${vnc.name}`);
  } catch { toast('Beam can’t write to this device’s clipboard here.', { error: true }); }
  vnc.rfb?.focus();
}

function toggleFit() {
  vnc.fit = !vnc.fit;
  applyFit();
  renderTools();
  vnc.rfb?.focus();
}

// Fit only ever shrinks: a screen bigger than the window is scaled down to it, one that fits is shown pixel for pixel
// (centred), as enlarging it softens its text (1.23.1). 1:1: always pixel for pixel, scrolling when it's bigger. Looked at
// again when the window or the computer's screen changes size.
function applyFit() {
  const rfb = vnc.rfb;
  const canvas = ui.screen.querySelector('canvas');
  if (!rfb || !canvas || !canvas.width) return;
  const shrink = vnc.fit && (canvas.width > ui.screen.clientWidth || canvas.height > ui.screen.clientHeight);
  if (rfb.scaleViewport !== shrink) rfb.scaleViewport = shrink;
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}

// ---------------------------------------------------------------- drawing

function setState(state, step = '') {
  vnc.state = state;
  vnc.step = step;
  render();
}

function render() {
  if (!ui.root) return;
  ui.root.dataset.state = vnc.state;
  ui.name.textContent = vnc.name || 'Remote control';
  ui.overlay.hidden = vnc.state === 'live';
  renderCard();
  renderTools();
}

function renderCard() {
  if (vnc.state === 'live') return ui.card.replaceChildren();
  if (vnc.state === 'connecting') return ui.card.replaceChildren(el('div', { class: 'rc-spin', 'aria-hidden': 'true' }), el('p', {}, vnc.step || 'Connecting…'));
  const end = vnc.end || { reason: 'error' };
  const [title, line] = (ENDED[end.reason] || ENDED.error)();
  // (the computer's own words, as its log has them: "wayvnc isn't installed (sudo apt install wayvnc)")
  const detail = end.text || (end.detail ? `${vnc.name || 'It'}: ${end.detail}` : '') || line;
  ui.card.replaceChildren(
    icon(end.reason === 'stopped' ? 'monitor' : 'alert', 'i big'),
    el('strong', {}, title),
    detail && el('p', {}, detail),
    el('div', { class: 'rc-actions' },
      el('button', { class: 'btn primary', type: 'button', onclick: () => connect() }, end.reason === 'stopped' ? 'Connect again' : 'Try again'),
      !HOST && el('button', { class: 'btn', type: 'button', onclick: () => { location.href = BASE.pathname; } }, 'Back to Beam')));
}

function renderTools() {
  if (!ui.tools) return;
  const live = vnc.state === 'live';
  const btn = (label, ic, onclick, { pressed, cls = '', title } = {}) => el('button', {
    class: `rc-tool ${cls}`, type: 'button', title: title || label, 'aria-label': label, 'data-tool': ic,
    ...(pressed !== undefined && { 'aria-pressed': String(Boolean(pressed)) }), onclick,
  }, icon(ic), el('span', { class: 'rc-tool-label' }, label));
  const tools = [];
  if (live) {
    tools.push(btn(vnc.fit ? 'Fit' : '1:1', vnc.fit ? 'zoom-out' : 'zoom-in', toggleFit, { title: vnc.fit ? 'Fit to the window (click for 1:1)' : 'One to one (click to fit)' }));
    tools.push(btn('Paste there', 'clip', pasteToPi, { title: `Put what was copied here on ${vnc.name}’s clipboard` }));
    if (vnc.piClip) tools.push(btn('Copy', 'copy', copyFromPi, { cls: 'attn', title: `Copy what was copied on ${vnc.name}` }));
    if (document.fullscreenEnabled) tools.push(btn(document.fullscreenElement ? 'Exit full screen' : 'Full screen', document.fullscreenElement ? 'shrink' : 'expand', toggleFullscreen));
  }
  if (vnc.state !== 'ended') tools.push(btn('Disconnect', 'x', disconnect, { cls: 'danger' }));
  ui.tools.replaceChildren(...tools);
}

start();
