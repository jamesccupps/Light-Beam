'use strict';
// Remote control (Beam 1.6, feature `remote-control`): see and control a PC's own signed-in screen.
//
// The viewer is this page at index.html#remote=<PC id>: a browser tab, the Windows app's viewer window, or the
// Android app's RemoteActivity (a WebView). The server only introduces the two devices (docs/API.md → Remote
// control); video and input go directly between them over Tailscale (WebRTC), and the PC enforces every rule itself.
// The messages between the two are plan/rd-contract.md (research §8.7 made exact). This side:
// - gives ICE the PC's candidates only as its attested Tailscale addresses (the strict rewrite), and shows nothing
//   and sends nothing until the connection is seen to go to one of them (the peer check); otherwise it hangs up;
// - sends input once the PC has said hello too (it does after its own check), on three data channels: `ctl`
//   (hello, quality, monitor, clip, lock, ping; from 1.8 fit, settings, video), `in` (buttons, wheel, keys, text,
//   release: ordered and reliable) and `mv` (pointer moves: unordered, no retries, the latest once per frame);
// - (1.8, a PC that says it can) has the PC fit its screen to this one, and sends the picture's settings (quality
//   mode, size, frame rate, data limit, codec) and whether this page is visible; they apply at once;
// - keeps nothing of a session: no frames, nothing in IndexedDB or web storage (only choices of this page's: the
//   touch mode, and per PC the picture's settings). The chat app's scripts are loaded, but none of them start in
//   this mode (no history, no cache, no outbox).
// This file is loaded only on that page (1.12.2: app.js adds it for #remote=, so the chat app doesn't load its
// ~130 KB); RC_ID is app.js's. The chat app's side (Control, Settings → Devices, Settings → This PC) is in devices.js.

const RC_MODES = ['text', 'motion'];  // Sharp text (30 fps, 8 Mbps) / Smooth motion (60 fps, 16 Mbps): the PC applies them
// The picture's settings (1.8), per PC: [value, label, more]. Auto: sharp while the screen is still, smooth while it
// moves, light on mobile data; the PC decides from what it sends.
const RC_PIC = {
  mode: [['auto', 'Auto', 'Sharp while the screen is still, smooth while it moves, light on mobile data'], ['text', 'Sharp text', '30 fps, for reading and writing'],
    ['motion', 'Smooth motion', '60 fps, for video and anything that moves'], ['saver', 'Data saver', '15 fps at up to 720p, for mobile data']],
  size: [['auto', 'Auto: what this screen shows'], ['full', 'The PC’s full size'], ['1080', 'Up to 1080p'], ['720', 'Up to 720p']],
  fps: [[0, 'Auto'], [60, '60 fps'], [30, '30 fps'], [15, '15 fps']],
  kbps: [[0, 'Auto'], [20000, '20 Mbps'], [10000, '10 Mbps'], [5000, '5 Mbps'], [2000, '2 Mbps']],
  codec: [['auto', 'Auto'], ['av1', 'AV1'], ['h264', 'H.264'], ['vp9', 'VP9']],
};
const RC_FIT_MS = 6000;        // a fit of the PC's screen: answered within this long (input waits meanwhile)
const RC_OFFER_MS = 20000;     // the PC has this long to share its screen and offer
const RC_ICE_MS = 15000;       // …and the connection this long to come up after the answer
const RC_RESTART_MS = 3000;    // disconnected this long: ask the PC for an ICE restart
const RC_RETRIES = 2;          // new sessions after a failed connection, before giving up
const RC_CLIP_MAX = 64 * 1024; // clipboard text either way, as UTF-8
// (1.12.4) Pictures through the clipboard (a screenshot): on the `clip` channel of their own, in parts of 48 KB as base64
// (a multiple of 3 bytes: the parts join), sent as it drains; 16 MB at most.
const RC_IMG_MAX = 16 * 1024 * 1024, RC_IMG_PART = 48 * 1024, RC_CLIP_BUFFERED = 1 << 20;
const RC_MV_BUFFERED = 16384;  // a move waits while the `mv` channel has this much queued (latest wins)
const RC_RESOLVE_MS = 5000;    // a peer-reflexive remote reads "" until the PC's own candidate replaces it: this long at most
// No input for this long (a pocketed phone keeps its screen on, and stray touches would click the PC): "Still
// there?", and the session ends after `warn` more. Watching without touching counts as idle.
const RC_IDLE = { touch: 10 * 60e3, desktop: 60 * 60e3, warn: 30e3 };

const rc = {
  id: RC_ID,
  gen: 0,              // +1 for every attempt: what an older attempt finishes is dropped
  device: null,        // the PC's device record, from the server
  name: '',            // its name: the server's, never what the PC's own messages say
  state: 'idle',       // connecting | live | reconnecting | ended
  step: '',            // what Connecting / Reconnecting is doing
  end: null,           // why it ended: { reason, title, text, retry, rdp, signin, close }
  retries: 0,          // new sessions tried after failures in a row
  session: null,       // the server's session: { id, host: { id, name, ip4, ip6 }, you }
  early: [],           // signals that came before the session's id was known
  pc: null,            // the RTCPeerConnection
  ch: null,            // { ctl, in, mv }
  origin: '',          // the current offer's o= session id (another one = a new connection)
  ufrag: '',           // its ICE username fragment (the candidates that carry another wait for their offer)
  pending: [],         // the PC's candidates, waiting for its offer
  added: [],           // what was given to ICE after the rewrite (address:port, for the tests and the curious)
  addedKeys: new Set(),
  localQueue: [],      // our own candidates, sent in small batches
  localTimer: null,
  verified: false,     // the selected pair goes to the PC's attested address
  pair: null,          // { remote, port, type, rtt } of the selected pair
  frames: false,       // a first frame has arrived
  timers: {},          // name -> { id, interval }
  helloSent: false,
  ctlEarly: [],        // what the PC said on `ctl` before our check passed
  hostHello: null,     // the PC said hello (after its own check): input may go
  switching: null,     // { id, name } while the PC starts over on another screen
  monitors: [],        // [{ id, name, w, h, primary, scale }] (from the PC's hello)
  monitor: 0,
  sub: { locked: false, secure: false, elevated: false }, // what the PC reports while live
  quality: 'text',
  qualityInfo: null,   // { fps, kbps }: what the PC applied
  // the picture's settings and the PC's screen (1.8)
  pic: rcLoadPic(),    // { mode, size, fps, kbps, codec, fitPc, details }: remembered per PC (a choice of this page's)
  caps: [],            // what the PC does besides 1.6 (its hello): fit, settings, video
  profile: '',         // what the PC applies now (Auto's pick included): text | motion | saver
  fitted: false,       // the PC's screen is fitted to this one (it says)
  fitting: false,      // a fit asked for and not answered yet: input waits (RC_FIT_MS at most)
  fitSent: '',         // the last fit asked for (w×h@dpr)
  picSent: null,       // the last settings sent
  host: null,          // the PC's own numbers (its stats): screen size, scale-down, limits, network, loss, delay
  videoOff: false,     // the PC was told this page is hidden
  decoder: '',         // this side's decoder (details)
  fit: 'fit',          // fit | 1:1
  clip: false,         // clipboard sync (off by default, per session)
  clipN: 0,
  clipPending: false,  // the PC's clipboard came but couldn't be written here: the Copy button
  lastClip: '',
  lastClipImg: null,   // (1.12.4) the PC's clipboard picture (a Blob), waiting like lastClip
  clipOut: [],         // (1.12.4) a picture's parts for the PC, sent as `clip` drains
  clipIn: null,        // (1.12.4) the PC's picture coming in: { n, of, size, bytes, at, got }
  pasteImg: 0,         // (1.12.4) the picture a held Ctrl+V waits for (its number)
  mvSeq: 0,            // the last `mv` sent (btn and wheel carry it as `n`)
  mvPending: null,
  mvFrame: 0,
  wheel: null,         // { dx, dy, p } waiting for the next frame
  wheelFrame: 0,
  keys: new Set(),     // codes sent down and not yet up
  buttons: new Set(),  // buttons sent down and not yet up
  held: null,          // input held back while a paste goes to the PC first
  composing: false,
  pingN: 0,
  rtt: null,
  delays: [],          // (1.14.2) each frame's way from the PC's screen to this one (ms), since the last stats tick
  cursorCss: null,     // (a Windows app 1.12.6) the PC's pointer as a CSS name while it's drawn here (null: in the picture)
  cursorHidden: false, // ...an app there hid it
  probe: null,         // (1.12.6) a delay probe on its way: { n, t0, answer, frame, check }
  probeRect: null,     // ...the PC's square: { x, y, size } in its screen's pixels
  measuring: null,     // ...a delay measurement under way: { got: [...] }
  measured: null,      // ...its result (medians, ms)
  path: null,          // (1.14.2) how Tailscale reaches the PC, as it says: { via: direct | peer-relay | relay, lan, relay }
  stats: null,         // { fps, kbps, codec, w, h } as received here
  statsPrev: null,
  encoder: '', hostCodec: '', qlr: '',
  stream: null,        // this mode's own event stream (rc-* events)
  streamTries: 0,
  hookOn: false,       // the Windows app's keyboard hook
  kbLocked: false,     // navigator.keyboard.lock() is on (full screen and live)
  lastInput: 0,        // the user's last input (idle); nothing else moves it
  idleWarn: null,      // "Still there?" under way: { until }
  wake: null,
  // touch (the mode is remembered: a choice of this page's, nothing of a session)
  touchMode: ['trackpad', 'touch'].includes(store.get('beam.rc.touchMode')) ? store.get('beam.rc.touchMode') : matchMedia('(pointer: coarse)').matches ? 'trackpad' : 'touch',
  pointer: null,       // where the pointer is on the PC's screen { x, y } (trackpad mode; touch mode: the last tap)
  zoom: 1,             // the picture's zoom here (1 = fit; rcV has the rest)
  sticky: new Set(),   // the key strip's latched modifiers
  sinkText: '',        // phone keyboards: what the PC has of the hidden box's text
};
const rcUi = {}; // the page's nodes (rcBuild)

// ---------------------------------------------------------------- start (app.js calls this for #remote=)

function startRemote() {
  document.documentElement.classList.add('remote-mode');
  document.documentElement.classList.toggle('host', Boolean(HOST));
  rcInitIdentity();
  // Nothing of the chat app runs here: a sign-out ends this view, a move just says so, and the server telling us who
  // we are changes nothing stored (the chat app does that on its own pages).
  onUnauthorized = () => { if (HOST) hostPost('unauthorized'); rcEnded('signed-out'); };
  onMoved = () => rcEnded('moved');
  adoptIdentity = you => { if (!HOST && DEVICE_ID.test(you || '')) me.id = you; return false; };
  rcBuild();
  if (HOST) rcBindHost();
  bindMenu();
  bindDialogs(); // (1.17: the chat app's bindUI never runs here, so the Picture panel's × did nothing)
  window.addEventListener('hashchange', () => location.reload());
  window.addEventListener('pagehide', () => rcLeave());
  window.addEventListener('pageshow', e => { if (e.persisted) rcConnect(); });
  window.addEventListener('blur', () => rcRelease());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) rcRelease();
    else { rcWakeLock(); rcRunStats(); }
    rcVideo(!document.hidden); // (1.8: no frames while nobody can see them)
    rcHook();
  });
  navigator.connection?.addEventListener?.('change', () => rcSendPic()); // (Wi-Fi ↔ mobile data: Auto adjusts)
  document.addEventListener('fullscreenchange', rcOnFullscreen);
  rc.winW = innerWidth;
  rc.winH = innerHeight;
  window.addEventListener('resize', rcOnResize);
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'input']) document.addEventListener(type, rcActivity, { capture: true, passive: true });
  window.addEventListener('focus', rcWriteClip);
  rc.lastInput = Date.now();
  setInterval(rcCheckIdle, 1000);
  rcConnect();
}

// Who this is, read only: this mode stores nothing (the chat app's pages keep the identity; /api/me's `you` is
// taken in memory). In the Windows app it's the app's (nothing is stored there either).
function rcInitIdentity() {
  if (HOST) return initIdentity();
  const id = store.get('beam.deviceId');
  me.id = DEVICE_ID.test(id || '') ? id : randomId(12);
  const saved = cleanName(store.get('beam.device'));
  me.named = store.get('beam.named') === '1' || Boolean(saved && !AUTO_NAME.test(saved));
  me.name = me.named && saved ? saved : defaultName();
}

// ---------------------------------------------------------------- idle: "Still there?"

// Its own clock, apart from the session's attempts: only real input moves it (never the PC's traffic, a reconnect or a
// new session), a countdown under way goes on across reconnects, and while it shows nothing starts a new session.
function rcActivity() {
  rc.lastInput = Date.now();
  if (rc.idleWarn) { rc.idleWarn = null; rcRender(); }
}

function rcIdleLimit() { return rcPhone() ? RC_IDLE.touch : RC_IDLE.desktop; }

// Once a second, from the start.
function rcCheckIdle() {
  if (rc.state === 'ended' || rc.state === 'idle') { rc.idleWarn = null; return; }
  if (rc.idleWarn) {
    if (Date.now() < rc.idleWarn.until) return rcRender(); // (the countdown)
    rcSend('ctl', { t: 'bye', reason: 'idle' });
    return rcEnded('idle', { endSession: true });
  }
  if (Date.now() - rc.lastInput < rcIdleLimit()) return;
  rcRelease();
  rc.idleWarn = { until: Date.now() + RC_IDLE.warn };
  rcRender();
}

// ---------------------------------------------------------------- the page

function rcBuild() {
  const video = el('video', { class: 'rc-video', playsinline: true, autoplay: true, disablepictureinpicture: true, disableremoteplayback: true, hidden: true, 'aria-label': 'The remote screen' });
  video.muted = true;
  video.defaultMuted = true;
  video.addEventListener('loadeddata', () => {
    if (typeof video.requestVideoFrameCallback !== 'function') rcStartMark('picture'); // (else the frame's own time: rcWatchFrames)
    if (!rc.frames) { rc.frames = true; rcLayout(); rcRender(); }
  });
  video.addEventListener('resize', () => rcLayout());
  const canvas = el('canvas', { class: 'rc-canvas', hidden: true, 'aria-hidden': 'true' }); // (1.17: the picture drawn here, rcFast)
  const stage = el('div', { class: 'rc-stage' }, video, canvas);
  const cursor = el('div', { class: 'rc-cursor', hidden: true, 'aria-hidden': 'true' });
  const fx = el('div', { class: 'rc-fxs', 'aria-hidden': 'true' }); // (taps, the hold ring)
  const notice = el('div', { class: 'rc-notice', role: 'status', hidden: true });
  const card = el('div', { class: 'rc-card', role: 'status', 'aria-live': 'polite' });
  const overlay = el('div', { class: 'rc-overlay' }, card);
  const help = el('div', { class: 'rc-help', hidden: true });
  const details = el('div', { class: 'rc-details', hidden: true, 'aria-label': 'Picture details' }); // (1.8: Show details)
  // (phone keyboards: no autocorrect, suggestions or learning from what's typed to the PC, where they honour it)
  const sink = el('textarea', { class: 'rc-sink', rows: '1', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', inputmode: 'text', enterkeyhint: 'enter',
    'aria-autocomplete': 'none', 'data-gramm': 'false', 'aria-label': 'Keyboard input for the remote PC' });
  const name = el('strong', { class: 'rc-name', dir: 'auto' });
  const chip = el('span', { class: 'rc-chip', hidden: true });
  const tools = el('div', { class: 'rc-tools' });
  const bar = el('header', { class: 'rc-bar' }, el('span', { class: 'rc-title' }, icon('monitor'), name), chip, tools);
  const keys = el('div', { class: 'rc-keys', hidden: true });
  const root = el('div', { id: 'remote', class: 'rc' }, bar, el('div', { class: 'rc-body' }, stage, fx, cursor, details, notice, overlay, help), keys, sink);
  document.body.prepend(root);
  Object.assign(rcUi, { root, bar, name, chip, tools, stage, video, canvas, cursor, fx, notice, overlay, help, card, sink, keys, details });
  rcBindInput();
  rcBuildKeyStrip();
  rcRender();
}

// An attempt's own timers: one of an older attempt never fires into a newer one.
function rcTimer(name, fn, ms, interval = false) {
  rcClearTimer(name);
  const gen = rc.gen;
  const run = () => { if (gen === rc.gen) fn(); };
  rc.timers[name] = { id: interval ? setInterval(run, ms) : setTimeout(run, ms), interval };
}
function rcClearTimer(name) {
  const t = rc.timers[name];
  if (!t) return;
  (t.interval ? clearInterval : clearTimeout)(t.id);
  delete rc.timers[name];
}

function rcSetState(state, step = '') {
  rc.state = state;
  rc.step = step;
  if (state !== 'ended') rc.end = null;
  rcRender();
  rcHook();
}

// ---------------------------------------------------------------- connecting

// A new session from the start (the first one, Reconnect, or after a connection that failed).
async function rcConnect({ retry = false } = {}) {
  rc.retries = retry ? rc.retries + 1 : 0;
  rcTeardown({ endSession: true });
  const gen = ++rc.gen;
  rcSetState('connecting', 'Checking your sign-in…');
  if (!rc.id) return rcEnded('unknown');
  if (!window.RTCPeerConnection) return rcEnded('unsupported');
  // (1.15) This attempt's start, step by step: the first from the page's own start (opening it), later ones from now.
  rc.start = { t0: rc.start ? performance.now() : 0, at: {}, pc: null, warm: false };
  try {
    // Who we are and what the server can do, once per page (the PC's record each time). (1.15) The two side by side: each
    // was a round trip of its own before the PC was even asked.
    if (!rc.device) {
      const infoP = apiJson('api/info', { timeout: 15000 }).catch(err => ({ err }));
      const meP = fetch(url('api/me'), { headers: idHeaders(), credentials: 'same-origin', signal: AbortSignal.timeout(10000) }).catch(() => null);
      rcPrimeWebRtc(); // (1.17: while those two are on their way)
      const res = await meP;
      if (gen !== rc.gen) return;
      if (!res || res.status >= 502) return rcEnded('unreachable');
      if (res.status === 401) { if (HOST) hostPost('unauthorized'); return rcEnded('signed-out'); }
      if (res.status === 410) return rcEnded('moved');
      const m = await res.json().catch(() => ({}));
      if (!HOST && DEVICE_ID.test(m.you || '')) me.id = m.you; // (in memory: this page stores nothing)
      if (m.auth?.session || m.temporary) return rcEnded('temporary');
      const info = await infoP;
      if (gen !== rc.gen) return;
      if (info.err) throw info.err;
      server.api = Number(info.api) || 2;
      server.version = info.version || '';
      if (Array.isArray(info.features)) server.features = new Set(info.features);
      if (!serverHas('remote-control')) return rcEnded('old-server');
    }
    rcSetState('connecting', 'Finding the PC…');
    const list = await apiJson('api/devices', { timeout: 15000 });
    if (gen !== rc.gen) return;
    const d = (list.devices || []).find(x => x && x.id === rc.id);
    if (!d) return rcEnded('unknown');
    rc.myName = cleanName((list.devices || []).find(x => x && x.id === me.id)?.name) || me.name; // (as the PC lists it)
    rcSetDevice(d);
    if (d.id === me.id) return rcEnded('self');
    if (d.status?.locked === true) return rcEnded('locked');
    // The event stream first: the PC's offer comes on it, and signals aren't kept for anyone who isn't listening. (Only
    // for a PC that's there: on plain http each open stream holds one of the browser's 6 connections to the server.)
    rcSetState('connecting', 'Connecting to Beam…');
    await rcOpenStream();
    if (gen !== rc.gen) return;
    rcSetState('connecting', `Asking ${rc.name}…`);
    let s;
    try { s = await apiJson('api/rc/sessions', jsonBody({ device: rc.id })); }
    catch (err) { if (gen === rc.gen) rcEndedFromError(err); return; }
    if (gen !== rc.gen) { rcPostEnd(s.id, 'stopped'); return; }
    rcStartMark('asked');
    // Only Tailscale addresses: the server attests nothing else, and nothing else is accepted.
    const host = { id: String(s.host?.id || rc.id), name: s.host?.name, ip4: rcIsTailscale(s.host?.ip4) ? s.host.ip4 : null, ip6: rcIsTailscale(s.host?.ip6) ? s.host.ip6 : null };
    if (!host.ip4 && !host.ip6) { rcPostEnd(s.id, 'failed'); return rcEnded('no-tailscale'); }
    rcSetSession({ id: String(s.id), host, you: s.you || {} });
    rcCreatePeer();
    // (the PC's offer: about 0.2 s after its banner with a warm page, 1 s cold, up to about 12 s; the timeout leaves more)
    rcSetState('connecting', `Starting ${rc.name}’s screen…`);
    rcTimer('offer', () => rcFail('no-offer'), RC_OFFER_MS);
    for (const m of rc.early.splice(0)) rcOnSignal(m);
  } catch (err) {
    if (gen !== rc.gen) return;
    if (err.status === 401) return rcEnded('signed-out');
    rcEnded(err.offline ? 'unreachable' : 'error', { text: friendlyError(err) });
  }
}

// (1.15) The start's steps here, in ms since this attempt began, once each (the PC's own come with its `started`):
// asked (the server answered), offer, answered, connected (both checks passed here), picture (the first frame shown).
function rcStartMark(step, at = performance.now()) {
  const s = rc.start;
  if (s && s.at[step] == null) s.at[step] = Math.max(0, Math.round(at - s.t0));
}

// The Windows app's viewer window ends the session when it's closed: it's told which one is on (or none).
function rcSetSession(s) {
  const was = rc.session?.id || null;
  rc.session = s;
  if (HOST && (s?.id || null) !== was) hostCall('remoteSession', { id: s?.id || null }).catch(() => {});
}

function rcSetDevice(d) {
  const name = cleanName(d.name) || rc.name || 'the PC';
  const changed = name !== rc.name || d.can?.remoteDesktop !== rc.device?.can?.remoteDesktop;
  rc.device = d;
  rc.name = name;
  document.title = `${name} · Beam`;
  if (changed) rcRender();
}

// What the server's refusal means here (docs/API.md → Remote control: starting).
function rcEndedFromError(err) {
  const reason = err.body?.reason;
  if (err.status === 401) return rcEnded('signed-out');
  if (err.status === 403 && reason === 'temporary') return rcEnded('temporary');
  if (err.status === 403 && (reason === 'sign-in' || reason === 'autopair')) return rcEnded('sign-in');
  if (err.status === 403 && reason === 'not-owner') return rcEnded('not-owner', { text: err.body?.error });
  if (err.status === 409 && reason === 'not-owner') return rcEnded('pc-not-owner', { text: err.body?.error });
  if (err.status === 403) return rcEnded('refused', { text: err.body?.error });
  if (err.status === 404) return rcEnded('unknown');
  if (err.status === 429) return rcEnded('rate', { text: friendlyError(err) });
  if (err.status === 409 && reason) return rcEnded(reason, { text: err.body?.error });
  rcEnded(err.offline ? 'unreachable' : 'error', { text: friendlyError(err) });
}

// The attempt failed on the way (no offer, no direct connection, the connection gone): a new session a couple of
// times, then the reason.
function rcFail(reason) {
  const had = Boolean(rc.session);
  rcTeardown({ endSession: true, reason: 'failed' });
  if (had && rc.retries < RC_RETRIES && !rc.idleWarn) {
    rcSetState('reconnecting', 'Trying again…');
    const gen = ++rc.gen;
    setTimeout(() => { if (gen === rc.gen) rcConnect({ retry: true }); }, 1000 + rc.retries * 2000);
    return;
  }
  rcEnded(rc.idleWarn ? 'idle' : reason); // (nobody there: no new session by itself)
}

// Lets go of everything: the connection, the timers, the session (told to the server unless it told us).
function rcTeardown({ endSession = false, reason = 'stopped' } = {}) {
  rcRelease();
  for (const name of Object.keys(rc.timers)) rcClearTimer(name);
  clearTimeout(rc.localTimer);
  rc.localTimer = null;
  rc.localQueue = [];
  rcClosePeer();
  rc.watched = null; // (the next connection's pair is read from its own transport)
  if (endSession && rc.session) rcPostEnd(rc.session.id, reason, { detail: rc.endDetail });
  rc.endDetail = '';
  rcSetSession(null);
  rc.origin = '';
  rc.early = [];
  rc.verified = false;
  rc.pair = null;
  rc.switching = null;
  rc.sub = { locked: false, secure: false, elevated: false };
  rc.stats = null;
  rc.encoder = rc.hostCodec = rc.qlr = '';
  rc.qualityInfo = null;
  rc.rtt = null;
  rc.path = null;
  rc.delays = [];
  rc.mvSeq = 0;
  rc.clipPending = false;
  rc.lastClip = '';
  rc.lastClipImg = null;
  rc.clipOut = [];
  rc.clipIn = null;
  rc.pasteImg = 0;
  rc.clip = false; // (per session: turned on again in the next one)
  rc.resolving = 0;
  rc.resolveSpent = 0;
  rcWakeRelease();
  rcFastStop();
  rc.track = null;
  if (rcUi.video) rcUi.video.hidden = true;
  if (rcUi.canvas) rcUi.canvas.hidden = true;
}

// The peer connection and what belongs to it (also when a new connection replaces it in the same session).
function rcClosePeer() {
  if (rc.ch) for (const c of Object.values(rc.ch)) { c.onmessage = c.onopen = c.onclose = null; try { c.close(); } catch {} }
  const pc = rc.pc;
  if (pc) {
    pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = pc.oniceconnectionstatechange = null;
    try { pc.close(); } catch {}
  }
  rc.pc = rc.ch = null;
  rc.watched = null;
  rc.resolving = 0;
  rc.resolveSpent = 0;
  rc.ufrag = '';
  rc.pending = [];
  rc.added = [];
  rc.addedKeys.clear();
  rc.helloSent = false;
  rc.ctlEarly = [];
  rc.hostHello = null;
  rc.frames = false;
  rc.statsPrev = null;
  if (rcUi.video) rcUi.video.srcObject = null;
}

function rcPostEnd(id, reason = 'stopped', { keepalive = false, detail = '' } = {}) {
  fetch(url(`api/rc/sessions/${encodeURIComponent(id)}/end`), {
    method: 'POST', credentials: 'same-origin', keepalive,
    headers: { ...idHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(detail ? { reason, detail } : { reason }),
  }).catch(() => {});
}

// The tab is closing (or reloading): goodbye on both paths.
function rcLeave() {
  if (!rc.session) return;
  rcSend('in', { t: 'release' });
  rcSend('ctl', { t: 'bye', reason: 'stopped' });
  rcPostEnd(rc.session.id, 'stopped', { keepalive: true });
  rcTeardown();
  rc.gen++;
}

// Disconnect (the bar's button, or Cancel while connecting).
function rcDisconnect() {
  if (rc.session) { rcSend('in', { t: 'release' }); rcSend('ctl', { t: 'bye', reason: 'stopped' }); }
  rcEnded('disconnected', { endSession: true });
}

// ---------------------------------------------------------------- ended (and why)

function rcEnded(reason, { text = '', by = '', from = '', endSession = false, endReason = 'stopped' } = {}) {
  rcTeardown({ endSession, reason: endReason });
  rc.idleWarn = null;
  rc.gen++;
  rcCloseStreamLater();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  const n = rc.name || 'the PC';
  const fromPc = Boolean(from) && from === rc.device?.id;
  const E = {
    'signed-out': { title: 'Sign in to Beam first', text: HOST ? 'Beam is signing in again. Open the remote screen again once it has.' : 'This browser isn’t signed in to Beam (or its sign-in was revoked).', signin: !HOST },
    moved: { title: 'Beam has moved', text: 'The Beam server moved to a new address. Open Beam to continue there.', signin: !HOST },
    unsupported: { title: 'This browser can’t show a remote screen', text: 'It has no WebRTC. Use a current Edge, Chrome, Firefox or Safari, or the Beam app.' },
    'old-server': { title: 'This Beam server can’t do remote control', text: 'It needs Beam 1.6 or later on the server.' },
    unknown: { title: 'Beam doesn’t know this device', text: 'It may have been removed from Beam.' },
    self: { title: 'That’s this device', text: 'A device can’t control itself.' },
    temporary: { title: 'Not with a sign-in for this session only', text: 'Remote control needs a device that is signed in to Beam for good, not one signed in just for this session.' },
    // (a browser signed in by itself, through Tailscale or a Beam app on the same machine: any account there has that)
    'sign-in': { title: 'Sign in to Beam here first', text: 'To control PCs from this browser, sign in to Beam here with a pairing link, an approval from another device or the password. (Add a device, on a device that’s signed in, makes a link.)' },
    refused: { title: 'Beam refused that', text: text || 'This device can’t start remote control.' },
    'not-owner': { title: 'Not from this Tailscale account', text: text || 'This device’s Tailscale account isn’t one of this Beam’s owners, so it can’t control PCs.' },
    'pc-not-owner': { title: `${n} can’t be controlled`, text: text || `${n}’s Tailscale account isn’t one of this Beam’s owners.` },
    // (the PC's own list of who may control it: changed only at the PC; never tried again by itself)
    'not-listed': { title: `${n} doesn’t allow control from ${rc.myName || me.name}`, text: 'Add it on the PC: tray → Remote control devices…', retry: true, close: true },
    unreachable: { title: 'Can’t reach Beam', text: text || net.cause || offlineCause(), retry: true },
    error: { title: 'Something went wrong', text, retry: true },
    rate: { title: 'Too many tries', text: text || 'Wait a minute, then try again.', retry: true },
    'not-allowed': { title: `Remote control is off on ${n}`, text: `To allow it, turn on “Allow remote control” in Beam on ${n} (its menu in the taskbar corner, or Settings → This PC).`, retry: true },
    locked: { title: `${n} is locked: use Remote Desktop`, text: 'Remote control works while someone is signed in and the PC is unlocked. Remote Desktop can sign in to it.', rdp: true, retry: true },
    offline: { title: `${n} isn’t connected to Beam`, text: 'Turn it on, or start Beam on it.', retry: true },
    busy: { title: `${n} is busy`, text: text || `${n} is being controlled from another device.`, retry: true },
    'no-tailscale': { title: 'Tailscale is needed', text: text || 'Both devices must reach Beam through Tailscale.', retry: true },
    'no-offer': { title: `${n} didn’t answer`, text: `Is Beam running on ${n}, with “Allow remote control” on?`, retry: true },
    'no-ice': { title: `Couldn’t connect directly to ${n}`, text: `Both devices need Tailscale on and connected. A firewall on ${n} may also block it.`, retry: true },
    peer: { title: 'Hung up: the connection didn’t go to the PC', text: `Beam checks that the picture comes straight from ${n}’s Tailscale address, and this connection came from somewhere else. Try again; if it keeps happening, check your Tailscale network.`, retry: true },
    failed: { title: 'The connection failed', text: text || `The direct connection to ${n} stopped working.`, retry: true },
    disconnected: { title: 'Disconnected', text: `You ended the session with ${n}.`, retry: true, close: true },
    idle: { title: 'Ended: nobody was there', text: `Nothing was touched or pressed for ${Math.round(rcIdleLimit() / 60e3)} minutes, so the session with ${n} ended.`, retry: true, close: true },
    stopped: fromPc ? { title: `${n} ended the session`, text: `Someone at ${n} pressed Stop.`, retry: true, close: true }
      : from && from !== me.id ? { title: 'Ended from another device', text: `${by || 'Another device'} ended the session.`, retry: true, close: true }
        : { title: 'Disconnected', text: `The session with ${n} ended.`, retry: true, close: true },
    declined: { title: `${n} declined`, text: `${n} didn’t accept the session.`, retry: true },
    revoked: { title: 'Remote control was turned off', text: `Remote control was turned off on ${n}, or a sign-in was revoked.`, retry: true, close: true },
    lease: { title: `Lost the connection to ${n}`, text: `${n} stopped answering Beam (asleep, off, or its network dropped).`, retry: true },
    server: { title: 'The Beam server restarted', text: 'The Beam server restarted or moved. Try again in a moment.', retry: true },
  };
  rc.end = { reason, ...(E[reason] || { title: 'Disconnected', text: text || `The session with ${n} ended.`, retry: true }) };
  rcSetState('ended');
}

// ---------------------------------------------------------------- the event stream (this mode's own)

// Opens (or reuses) the stream the rc-* events come on; resolves once it's open (or given up for now).
function rcOpenStream() {
  if (rc.stream?.open) return Promise.resolve();
  return new Promise(resolve => {
    rcCloseStream();
    const mode = serverHas('stream-modes') ? '&mode=foreground' : '';
    const es = new EventSource(url(`api/events?device=${encodeURIComponent(me.id)}&name=${encodeURIComponent(me.name)}&platform=${encodeURIComponent(me.platform)}${mode}`));
    const st = { es, open: false, resolve };
    rc.stream = st;
    const settle = () => { st.resolve?.(); st.resolve = null; };
    es.onopen = () => {
      if (rc.stream !== st) return;
      st.open = true;
      rc.streamTries = 0;
      settle();
    };
    es.onerror = () => {
      if (rc.stream !== st) return;
      st.open = false;
      es.close();
      settle();
      // Back after a pause. A negotiation that was under way asks the PC to start over (signals aren't kept).
      const wait = Math.min(15000, 1000 * 2 ** Math.min(rc.streamTries++, 4));
      setTimeout(() => {
        if (rc.stream !== st || rc.state === 'ended') return;
        rcOpenStream().then(() => { if (rc.session && !rc.verified && rc.pc?.remoteDescription) rcSignal('restart'); });
      }, wait);
    };
    const on = (name, fn) => es.addEventListener(name, e => {
      if (rc.stream !== st) return;
      let data = {};
      try { data = JSON.parse(e.data || '{}') || {}; } catch {}
      try { fn(data); } catch (err) { console.error(`${name} event:`, err); }
    });
    on('rc-signal', rcOnSignal);
    on('rc-end', rcOnEnd);
    on('devices', ({ devices: list }) => {
      if (!Array.isArray(list)) return;
      const d = list.find(x => x && x.id === rc.id);
      if (d) rcSetDevice(d);
      else if (rc.state !== 'ended') rcEnded('unknown');
    });
    on('moved', () => rcEnded('moved'));
    setTimeout(() => { if (rc.stream === st) settle(); }, 10000);
  });
}

function rcCloseStream() {
  const st = rc.stream;
  rc.stream = null;
  if (st) { st.es.close(); st.resolve?.(); }
}

// An ended view keeps the stream a minute (Reconnect is likely); then it goes.
function rcCloseStreamLater() {
  clearTimeout(rcCloseStreamLater.t);
  rcCloseStreamLater.t = setTimeout(() => { if (rc.state === 'ended') rcCloseStream(); }, 60000);
}

function rcOnSignal(m) {
  if (!m || typeof m !== 'object') return;
  if (!rc.session) { if (rc.state === 'connecting' && rc.early.length < 20) rc.early.push(m); return; }
  if (m.id !== rc.session.id || m.from !== rc.session.host.id) return; // only our session, only from the PC
  if (m.kind === 'offer' && typeof m.sdp === 'string') rcOnOffer(m.sdp);
  else if (m.kind === 'candidates' && Array.isArray(m.candidates)) for (const c of m.candidates.slice(0, 50)) rcRemoteCandidate(c);
  // (`restart` goes from this side to the PC only)
}

function rcOnEnd(m) {
  if (!m || !rc.session || m.id !== rc.session.id) return;
  const why = String(m.reason || 'stopped');
  rcSetSession(null); // (the server knows: nothing to tell it)
  rcEnded(why, { from: m.from || '', by: cleanName(m.by) });
}

// ---------------------------------------------------------------- WebRTC

// (1.17) WebRTC made ready while this page signs in and asks for the PC: in a fresh browser (a new viewer window) the
// first RTCPeerConnection took ~240 ms on Desktop, more on a laptop, and came just as the PC's offer did (the user's
// desk: the PC had the answer 0.52 s after its offer). A WebRTC decoding query first: ~135 ms then, and the connection
// ~3 ms after (Beam-dev\research\rc-start\AnswerProbe). Once a page.
function rcPrimeWebRtc() {
  if (rcPrimeWebRtc.done) return;
  rcPrimeWebRtc.done = true;
  try {
    navigator.mediaCapabilities?.decodingInfo?.({ type: 'webrtc', video: { contentType: 'video/AV1', width: 1920, height: 1080, bitrate: 8e6, framerate: 60 } })?.catch?.(() => {});
  } catch {}
}

function rcCreatePeer() {
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  const ch = {
    ctl: pc.createDataChannel('ctl', { negotiated: true, id: 0, ordered: true }),
    in: pc.createDataChannel('in', { negotiated: true, id: 1, ordered: true }),
    mv: pc.createDataChannel('mv', { negotiated: true, id: 2, ordered: false, maxRetransmits: 0 }),
    clip: pc.createDataChannel('clip', { negotiated: true, id: 3, ordered: true }), // (1.12.4; a PC before it never opens it)
  };
  rc.pc = pc;
  rc.ch = ch;
  const mine = () => rc.pc === pc;
  pc.ontrack = e => {
    if (!mine()) return;
    // (1.8) Frames are shown as they come, with no buffer held back for smoothness: what the Windows app's viewer does
    // with its playout-delay setting, for browsers and the phone too.
    try { e.receiver.jitterBufferTarget = 0; } catch {}
    try { if ('playoutDelayHint' in e.receiver) e.receiver.playoutDelayHint = 0; } catch {}
    const v = rcUi.video;
    v.srcObject = e.streams[0] || new MediaStream([e.track]);
    v.play().catch(() => {});
    rcWatchFrames(v);
    rc.track = e.track;
    rcFastStart(e.track); // (1.17)
  };
  pc.onicecandidate = e => { if (mine()) rcLocalCandidate(e.candidate); };
  pc.onconnectionstatechange = () => { if (mine()) rcOnConnState(); };
  pc.oniceconnectionstatechange = () => { if (mine()) rcOnConnState(); };
  ch.ctl.onopen = () => { if (mine()) rcOnCtlOpen(); };
  ch.ctl.onmessage = e => { if (mine()) rcOnCtl(e.data); };
  ch.clip.bufferedAmountLowThreshold = 256 * 1024;
  ch.clip.onbufferedamountlow = ch.clip.onopen = () => { if (mine()) rcDrainClip(); };
  ch.clip.onmessage = e => { if (mine() && rc.verified && typeof e.data === 'string' && e.data.length <= 80000) rcClipPart(e.data); };
}

// The offer's o= session id. Another one than the current offer's is a new connection (the PC started capture over,
// e.g. for another screen): a fresh peer connection answers it. The same one is a renegotiation on this one (an ICE
// restart, another codec).
const rcOrigin = sdp => (/^o=\S+ (\S+) /m.exec(sdp) || [])[1] || '';

// The PC's offer: its own candidates (if it put any in) go through the rewrite like the trickled ones.
async function rcOnOffer(sdp) {
  if (!rc.pc || sdp.length > 64 * 1024) return;
  const origin = rcOrigin(sdp);
  if (rc.origin && origin !== rc.origin) {
    // A new connection in the same session: both checks start over (no picture, no input until they pass).
    for (const t of ['restart', 'ice', 'pair', 'ping', 'stats']) rcClearTimer(t);
    rcRelease();
    const early = rc.pending; // (the new connection's own candidates, if they came first)
    rcClosePeer();
    rc.pending = early;
    rc.verified = false;
    rc.pair = null;
    rcCreatePeer();
    if (!rc.switching && rc.state === 'live') rcSetState('reconnecting', 'Starting the picture again…');
    else rcRender();
  }
  rc.origin = origin;
  const pc = rc.pc;
  const gen = rc.gen;
  const current = () => gen === rc.gen && rc.pc === pc;
  rcClearTimer('offer');
  rcStartMark('offer');
  try {
    const { sdp: clean, candidates } = rcStripCandidates(sdp);
    await pc.setRemoteDescription({ type: 'offer', sdp: clean });
    if (!current()) return;
    rc.ufrag = rcUfrag(clean);
    // (its own, and those that came first; candidates of an older offer are dropped)
    const mine = c => typeof c.usernameFragment !== 'string' || !rc.ufrag || c.usernameFragment === rc.ufrag;
    for (const c of [...candidates, ...rc.pending.splice(0).filter(mine)]) rcAddRemote(c);
    const answer = await pc.createAnswer();
    if (!current()) return;
    await pc.setLocalDescription(answer);
    if (!current()) return;
    await rcSignal('answer', { sdp: answer.sdp });
    rcStartMark('answered');
    if (rc.state === 'connecting') rcSetState('connecting', `Connecting directly to ${rc.name} over Tailscale…`);
    if (!rc.verified) rcTimer('ice', () => rcFail('no-ice'), RC_ICE_MS);
  } catch (err) {
    if (!current()) return;
    console.error('remote offer', err);
    rcFail('failed');
  }
}

// A candidate belongs to the offer whose ICE username fragment it carries: one for an offer still on its way (a new
// connection, an ICE restart: its candidates can overtake it) waits for that offer.
function rcRemoteCandidate(c) {
  if (!c || typeof c !== 'object' || typeof c.candidate !== 'string') return;
  const later = !rc.pc?.remoteDescription || (typeof c.usernameFragment === 'string' && rc.ufrag && c.usernameFragment !== rc.ufrag);
  if (later) { if (rc.pending.length < 100) rc.pending.push(c); return; }
  rcAddRemote(c);
}
const rcUfrag = sdp => (/^a=ice-ufrag:(\S+)/m.exec(sdp) || [])[1] || '';

function rcAddRemote(init) {
  const pc = rc.pc;
  if (!pc || !rc.session) return;
  for (const c of rcRewrite(init, rc.session.host)) {
    const parts = c.candidate.split(' ');
    const key = c.candidate === '' ? '' : `${parts[1]}|${parts[4]}|${parts[5]}|${c.usernameFragment || ''}`;
    if (key && rc.addedKeys.has(key)) continue;
    if (key) {
      rc.addedKeys.add(key);
      if (rc.added.length < 50) rc.added.push(`${parts[4]}:${parts[5]}`);
    }
    pc.addIceCandidate(c).catch(() => {}); // (one of an older ICE generation, or a family this side lacks)
  }
}

// The strict rewrite (plan/rd-spike-results.md): every UDP host candidate of the PC's becomes its attested
// Tailscale address with the same port (Chromium's sockets listen on every address); everything else is dropped.
// A literal IPv4 address gives an IPv4 copy, a literal IPv6 one an IPv6 copy, a name (.local) both.
function rcRewrite(init, host) {
  if (!init || typeof init.candidate !== 'string' || !host) return [];
  const base = { sdpMid: typeof init.sdpMid === 'string' ? init.sdpMid : null, sdpMLineIndex: Number.isInteger(init.sdpMLineIndex) ? init.sdpMLineIndex : null };
  if (typeof init.usernameFragment === 'string') base.usernameFragment = init.usernameFragment;
  if (init.candidate === '') return [{ candidate: '', ...base }]; // the end of candidates
  if (init.candidate.length > 1024) return [];
  const p = init.candidate.replace(/^a=/, '').trim().split(/\s+/);
  if (p.length < 8 || !/^candidate:/.test(p[0]) || p[6] !== 'typ') return [];
  if (p[2].toLowerCase() !== 'udp' || p[7] !== 'host') return [];
  const port = Number(p[5]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
  const fam = rcIpFamily(p[4]);
  const out = [];
  for (const ip of [fam !== 6 && host.ip4, fam !== 4 && host.ip6]) {
    if (!ip || !rcIsTailscale(ip)) continue;
    const q = p.slice();
    q[4] = ip;
    out.push({ candidate: q.join(' '), ...base });
  }
  return out;
}

// The offer's own a=candidate lines come out (they go through the rewrite instead), and a=end-of-candidates too.
function rcStripCandidates(sdp) {
  const lines = sdp.split(/\r\n|\n/);
  const mids = [];
  let m = -1;
  for (const line of lines) {
    if (line.startsWith('m=')) mids[++m] = null;
    else if (line.startsWith('a=mid:') && m >= 0) mids[m] = line.slice(6).trim();
  }
  const out = [];
  const candidates = [];
  m = -1;
  for (const line of lines) {
    if (line.startsWith('m=')) m++;
    if (line.startsWith('a=candidate:')) { candidates.push({ candidate: line.slice(2), sdpMid: mids[m] ?? null, sdpMLineIndex: Math.max(0, m) }); continue; }
    if (line.startsWith('a=end-of-candidates')) continue;
    out.push(line);
  }
  return { sdp: out.join('\r\n'), candidates };
}

const rcIsTailscale = a => typeof a === 'string' && (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(a) || /^fd7a:115c:a1e0:[0-9a-f:]*$/i.test(a));
const rcIpFamily = a => (/^\d{1,3}(\.\d{1,3}){3}$/.test(a) ? 4 : a.includes(':') ? 6 : 0);

// One IPv6 address however it's written (zeros compressed or not, any case, a zone, an IPv4 one in IPv6 form).
function rcNormIp(a) {
  a = String(a || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^(?:::|(?:0{1,4}:){5})ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1];
  if (!a.includes(':')) return a;
  const [head, tail = ''] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = a.includes('::') && tail ? tail.split(':') : [];
  const fill = a.includes('::') ? Array(Math.max(0, 8 - h.length - t.length)).fill('0') : [];
  return [...h, ...fill, ...t].map(x => x.replace(/^0+(?=.)/, '')).join(':');
}
const rcIsPeer = addr => Boolean(addr) && Boolean(rc.session) && [rc.session.host.ip4, rc.session.host.ip6].some(ip => ip && rcNormIp(ip) === rcNormIp(addr));
// An address that is one (not "", 0.0.0.0, ::, a name or anything else). What Chrome gives for a remote it won't reveal
// (peer-reflexive: its checks came before its candidates) varies: "" in getStats, and from getSelectedCandidatePair
// newer builds give libwebrtc's placeholder name "redacted-ip.invalid" (2026-10: the phone hung up a moment after its
// check had passed, at the first pair change). Such a remote is "not known yet": never a pass, never at once a
// hang-up (1.7.3).
function rcIpLiteral(a) {
  const s = rcNormIp(a);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s.split('.').every(n => Number(n) <= 255) && s !== '0.0.0.0';
  return /^[0-9a-f]{1,4}(:[0-9a-f]{1,4}){7}$/.test(s) && !/^(0:){7}0$/.test(s);
}

// What the viewer saw when it hung up, for the server's log: kinds only, never the address (1.7.3).
function rcSeen(addr, type) {
  const a = String(addr ?? '');
  const n = rcNormIp(a);
  const what = !a ? 'no address' : !rcIpLiteral(a) ? `something that isn't an address (shaped "${a.replace(/[0-9]/g, '9').replace(/[a-z]/gi, 'x').slice(0, 24)}")`
    : `${rcIsTailscale(n) ? 'another Tailscale' : 'a non-Tailscale'} IPv${rcIpFamily(n)} address`;
  return `the connection went to ${what}${type ? ` (${String(type).slice(0, 12)} candidate)` : ''}`;
}

// Our own candidates, a few at a time (the PC does its own rewrite): at most 20 a signal, each at most 256 characters.
function rcLocalCandidate(c) {
  if (!rc.session) return;
  const init = c ? c.toJSON() : { candidate: '', sdpMid: null, sdpMLineIndex: null };
  if (typeof init.candidate !== 'string' || init.candidate.length > 256) return;
  rc.localQueue.push(init);
  if (rc.localQueue.length >= 20) rcFlushLocal();
  else if (!rc.localTimer) rc.localTimer = setTimeout(rcFlushLocal, 40);
}
function rcFlushLocal() {
  clearTimeout(rc.localTimer);
  rc.localTimer = null;
  const list = rc.localQueue.splice(0, 20).map(c => ({
    candidate: String(c.candidate || ''), sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null,
    ...(c.usernameFragment != null && { usernameFragment: c.usernameFragment }),
  }));
  if (list.length) rcSignal('candidates', { candidates: list });
  if (rc.localQueue.length) rc.localTimer = setTimeout(rcFlushLocal, 40);
}

async function rcSignal(kind, body = {}) {
  const s = rc.session;
  if (!s) return;
  try {
    await api(`api/rc/sessions/${encodeURIComponent(s.id)}/signal`, jsonBody({ kind, ...body }));
  } catch (err) {
    if (rc.session !== s) return;
    if (err.status === 410) rcOnEnd({ id: s.id, reason: err.body?.reason || 'stopped' }); // it ended meanwhile
    else if (err.status === 404) rcFail('failed'); // the server forgot it (it restarted): a new session
  }
}

function rcOnConnState() {
  const pc = rc.pc;
  if (!pc) return;
  // (the connection's state covers ICE and DTLS; ICE's own is the fallback where there's no such thing)
  const ice = pc.iceConnectionState;
  const st = pc.connectionState || (ice === 'completed' ? 'connected' : ice === 'checking' ? 'connecting' : ice);
  if (st === 'connected') {
    rcClearTimer('restart');
    rcCheckPeer();
  } else if (rc.switching) {
    // (the PC closes this connection for its new one: the offer comes next; the switch has its own timeout)
  } else if (st === 'disconnected') {
    if (rc.state === 'live') {
      rcRelease();
      rcSetState('reconnecting', 'The connection dropped. Reconnecting…');
    }
    // Still down after a moment: the PC starts ICE over (restartIce) and offers again.
    if (!rc.timers.restart && rc.verified) {
      rcTimer('restart', () => {
        rcSignal('restart');
        rcSetState('reconnecting', `Asking ${rc.name} to reconnect…`);
        rcTimer('ice', () => rcFail('failed'), RC_ICE_MS);
      }, RC_RESTART_MS);
    }
  } else if (st === 'failed') {
    rcRelease();
    rcFail(rc.verified ? 'failed' : 'no-ice');
  }
}

// The selected candidate pair, from getStats.
async function rcSelectedPair() {
  const pc = rc.pc;
  if (!pc) return null;
  const stats = await pc.getStats();
  let pair = null;
  stats.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
  if (!pair) stats.forEach(r => { if (!pair && r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && r.selected !== false) pair = r; });
  if (!pair) return null;
  const remote = stats.get(pair.remoteCandidateId);
  return {
    remote: remote ? String(remote.address ?? remote.ip ?? '') : '',
    port: remote?.port ?? null,
    type: remote?.candidateType || '',
    rtt: Number.isFinite(pair.currentRoundTripTime) ? Math.round(pair.currentRoundTripTime * 1000) : null,
    stats,
  };
}

// The peer check: once connected, and again whenever the pair might have changed. No pass, no picture, no input.
async function rcCheckPeer() {
  const pc = rc.pc;
  let pair;
  try { pair = await rcSelectedPair(); } catch { pair = null; }
  if (rc.pc !== pc || !pc) return;
  if (!pair) {
    if (!rc.verified) rcTimer('pair', rcCheckPeer, 250); // connected, but the stats don't show the pair yet
    return;
  }
  // (once the ICE transport is known, its own selected pair is the current one: getStats can lag behind a change. When
  // the transport won't say its address, the stats' reading of that same remote (same port) counts.)
  const cur = rc.watched?.getSelectedCandidatePair?.()?.remote;
  let remote = '';
  if (!cur) remote = rcIpLiteral(pair.remote) ? pair.remote : '';
  else if (rcIpLiteral(cur.address)) remote = String(cur.address);
  else if (rcIpLiteral(pair.remote) && cur.port != null && cur.port === pair.port) remote = pair.remote;
  rc.pair = { remote, port: pair.port, type: cur?.type || pair.type, rtt: pair.rtt };
  // The PC's checks often come before its candidates: the remote is then peer-reflexive, and Chrome won't say its
  // address until the PC's own (rewritten) candidate takes its place. Read it again every 200 ms, with nothing shown
  // or sent meanwhile; only an address that isn't the PC's, or none within the connection's 5 s, hangs up.
  if (!remote) {
    if (rcUnresolved()) return rcHangUp(rcSeen(cur ? cur.address : pair.remote, cur?.type || pair.type));
    return rcTimer('pair', rcCheckPeer, 200);
  }
  rcResolved();
  if (!rcIsPeer(remote)) return rcHangUp(rcSeen(remote, cur?.type || pair.type));
  rcWatchPair(pc);
  rcClearTimer('ice');
  if (rc.verified) { if (rc.state === 'reconnecting') rcSetState('live'); return; }
  rc.verified = true;
  rc.retries = 0;
  rcClearTimer('offer');
  rcStartMark('connected');
  rcUi.video.hidden = false;
  rcSetState('live');
  // The PC says hello once its own check passed; one that never does isn't going to let input in (start over).
  if (!rc.hostHello) rcTimer('hello', () => { if (!rc.hostHello) rcFail('failed'); }, RC_ICE_MS);
  if (rc.ch?.ctl.readyState === 'open') rcOnCtlOpen();
  for (const d of rc.ctlEarly.splice(0)) rcOnCtl(d);
  rcRunStats();
  rcWakeLock();
  rcLayout();
  if (!rcTouchUi()) rcFocusSink();
}

function rcHangUp(seen = '') {
  rc.endDetail = seen; // (sent with the end: rcTeardown)
  rcEnded('peer', { endSession: true, endReason: 'failed' });
}

// An unreadable remote address: input waits (let go of once), and the connection has 5 s of that in all, however it
// comes (an attested read in between doesn't start the 5 s over). True when they're spent.
function rcUnresolved() {
  const now = Date.now();
  if (!rc.resolving) {
    rc.resolving = now;
    if (rc.verified) { rcRelease(); rcRender(); }
  }
  return (rc.resolveSpent || 0) + (now - rc.resolving) >= RC_RESOLVE_MS;
}
function rcResolved() {
  if (!rc.resolving) return;
  rc.resolveSpent = (rc.resolveSpent || 0) + (Date.now() - rc.resolving);
  rc.resolving = 0;
  if (rc.verified) rcRender();
}

// The pair changing (a renomination, an ICE restart) is checked at once, not only at the next stats tick: the
// ICE transport says so, and its selected pair can be read straight away.
function rcWatchPair(pc) {
  const it = pc.sctp?.transport?.iceTransport || pc.getReceivers?.()[0]?.transport?.iceTransport;
  if (!it || rc.watched === it) return;
  rc.watched = it;
  it.addEventListener?.('selectedcandidatepairchange', () => {
    if (rc.pc !== pc) return;
    const remote = it.getSelectedCandidatePair?.()?.remote;
    // (an address that is one and isn't the PC's hangs up at once; anything else is checked as above, which waits a
    // moment for a remote that isn't known yet: input is let go of meanwhile)
    if (rcIpLiteral(remote?.address) && rc.verified && !rcIsPeer(remote.address)) return rcHangUp(rcSeen(remote.address, remote.type));
    rcCheckPeer();
  });
}

// ---------------------------------------------------------------- the stats chip (every second while on screen)

function rcRunStats() {
  rcClearTimer('stats');
  if (rc.state === 'ended' || !rc.pc || !rc.verified || document.hidden) return;
  rcTimer('stats', rcStats, 1000, true);
}

async function rcStats() {
  if (document.hidden) return rcClearTimer('stats');
  const pc = rc.pc;
  let pair;
  try { pair = await rcSelectedPair(); } catch { return; }
  if (!pair || rc.pc !== pc) return;
  // (the pair can change after an ICE restart or a renomination: the check holds every time)
  if (rc.verified && (!rcIsPeer(pair.remote) || rc.resolving)) return rcCheckPeer(); // (it decides, with the transport's own pair)
  rc.pair = { remote: pair.remote, port: pair.port, type: pair.type, rtt: pair.rtt };
  let inbound = null;
  pair.stats.forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'video') inbound = r; });
  if (!inbound) return;
  const prev = rc.statsPrev;
  const span = prev ? inbound.timestamp - prev.timestamp : 0;
  const kbps = span > 0 ? Math.round((inbound.bytesReceived - prev.bytesReceived) * 8 / span) : null;
  const fps = Number.isFinite(inbound.framesPerSecond) ? Math.round(inbound.framesPerSecond)
    : span > 0 ? Math.round((inbound.framesDecoded - prev.framesDecoded) * 1000 / span) : null;
  const codec = inbound.codecId && pair.stats.get(inbound.codecId);
  rc.statsPrev = { timestamp: inbound.timestamp, bytesReceived: inbound.bytesReceived, framesDecoded: inbound.framesDecoded };
  // (1.14.2) The picture's delay: the median of this second's frames (a still screen sends few: the last one stays).
  const ds = rc.delays.splice(0).sort((a, b) => a - b);
  const picMs = ds.length >= 3 ? Math.round(ds[ds.length >> 1]) : rc.stats?.picMs ?? null;
  rc.stats = {
    picMs,
    fps, kbps, codec: codec ? String(codec.mimeType || '').replace(/^video\//i, '') : '',
    w: inbound.frameWidth || rcUi.video.videoWidth || 0, h: inbound.frameHeight || rcUi.video.videoHeight || 0,
    jitterMs: Number.isFinite(inbound.jitterBufferDelay) && inbound.jitterBufferEmittedCount > 0 ? Math.round(inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount * 1000) : null,
  };
  if (typeof inbound.decoderImplementation === 'string') rc.decoder = rcClean(inbound.decoderImplementation, 80) + (inbound.powerEfficientDecoder === true ? ' (hardware)' : '');
  rcRenderChip();
  rcRenderDetails();
}

// (1.14.2) Each frame's way from the PC's screen to this one: the browser knows when the PC captured it (from the PC's
// sender reports, in this page's clock) and when it's shown here (requestVideoFrameCallback). Kept until the next
// stats tick. A newer connection's watch takes over from an older one's.
function rcWatchFrames(v) {
  if (typeof v.requestVideoFrameCallback !== 'function') return;
  const gen = v.rcFrameGen = (v.rcFrameGen || 0) + 1;
  const tick = (now, m) => {
    if (v.rcFrameGen !== gen) return;
    rcStartMark('picture', m.expectedDisplayTime || now); // (1.15: the first frame shown)
    // (1.17: drawn by this page, the frame was on its way to the screen when it was drawn)
    const shownAt = (rcFast.on && rcFast.drawn.get(m.rtpTimestamp)) || m.expectedDisplayTime;
    const d = m.captureTime ? shownAt - m.captureTime : null;
    if (d != null && d >= 0 && d < 10000 && rc.delays.length < 600) rc.delays.push(d);
    const p = rc.probe;
    if (p && !p.frame && p.fast && (p.fast.rtp == null || p.fast.rtp === m.rtpTimestamp)) {
      // (1.17) The probe's frame, drawn by this page (rcFastDraw): its receive time and decoding are this callback's.
      p.frame = { shown: p.fast.shown, received: p.fast.rtp != null ? m.receiveTime : null, decode: Number.isFinite(m.processingDuration) ? m.processingDuration * 1000 : null, drawn: true };
      p.check();
    } else if (p && !p.frame && !rcFast.on) rcProbeLook(v, m);
    v.requestVideoFrameCallback(tick);
  };
  v.requestVideoFrameCallback(tick);
}

// ---------------------------------------------------------------- the delay, measured end to end (a Windows app 1.12.6)

// "Measure the delay" (Picture): probes go the way input goes (`in`); for each, the PC turns a square in the top left
// corner of its screen from magenta to green or back and says how long that took there, and this page watches each
// frame (requestVideoFrameCallback) for the change: from sending a probe to its frame being shown here, and each
// step's share (half the round trip each way; the PC's own time; its encoding and sending, from its stats; the
// capture, what's left of the way here; decoding; the wait to be shown).
const RC_PROBES = 10;

async function rcMeasure() {
  if (rc.measuring) return;
  const v = rcUi.video;
  if (!rc.caps.includes('probe') || !rcLive()) { toast('Measuring the delay needs Beam 1.12.6 or later on the PC, and control of it.'); return; }
  if (typeof v.requestVideoFrameCallback !== 'function') { toast('This browser can’t time the picture’s frames, so it can’t measure the delay.'); return; }
  const gen = rc.gen;
  rc.measuring = { got: [], caps: {} };
  rc.measured = null;
  if (!rc.pic.details) rcSetPic('details', true);
  rcRenderDetails();
  try {
    if (!(await rcProbe(0, true))) throw new Error('The PC’s square didn’t show up in the picture, so the delay couldn’t be measured.');
    for (let i = 1; i <= RC_PROBES && rc.gen === gen && rc.measuring; i++) {
      await new Promise(r => setTimeout(r, 120 + Math.random() * 180)); // (each probe at another point between frames)
      const r = await rcProbe(i, false);
      if (r && rc.measuring) rc.measuring.got.push(r);
      rcRenderDetails();
    }
    if (rc.gen === gen && rc.measuring) {
      await new Promise(r => setTimeout(r, 200)); // (the PC's word on its own capture of the last one, if it's late)
      if (rc.gen === gen && rc.measuring) {
        rc.measured = rcMeasureSum(rc.measuring.got, rc.measuring.caps);
        if (!rc.measured) toast('No probe came back in time, so the delay couldn’t be measured.');
      }
    }
  } catch (e) {
    toast(e.message);
  } finally {
    if (rc.gen === gen) rcSend('in', { t: 'probe', off: true });
    rc.measuring = null;
    rc.probe = null;
    rcRenderDetails();
  }
}

// One probe: sent, then both the PC's answer and the frame showing the change (3 s at most).
function rcProbe(n, on) {
  return new Promise(resolve => {
    const p = { n, t0: performance.now(), answer: null, frame: null, done: false };
    const finish = r => { if (p.done) return; p.done = true; clearTimeout(timer); if (rc.probe === p) rc.probe = null; resolve(r); };
    const timer = setTimeout(() => finish(null), 3000);
    p.check = () => {
      if (!p.answer || !p.frame) return;
      const f = p.frame;
      finish({ n, total: f.shown - p.t0, pc: p.answer.ms, received: Number.isFinite(f.received) ? f.received - p.t0 : null, decode: f.decode,
        shown: Number.isFinite(f.received) ? f.shown - f.received - (f.decode || 0) : null, drawn: f.drawn === true });
    };
    rc.probe = p;
    if (!rcSend('in', on ? { t: 'probe', n, on: true } : { t: 'probe', n })) finish(null);
  });
}

// A frame (requestVideoFrameCallback's metadata): does the square show the colour this probe makes it?
function rcProbeLook(v, m) {
  const p = rc.probe;
  const want = p.n % 2 ? 'green' : 'magenta'; // (it starts magenta; each probe after turns it)
  if (rcProbeColor(v, rc.probeRect || { x: 0, y: 0, size: 32 }) !== want) return;
  p.frame = { shown: m.expectedDisplayTime, received: m.receiveTime, decode: Number.isFinite(m.processingDuration) ? m.processingDuration * 1000 : null };
  p.check();
}

// The colour in the middle of the square, in the frame shown now: magenta, green, or null (anything else).
function rcProbeColor(v, r) {
  const mon = rc.monitors.find(x => x.id === rc.monitor);
  const vw = v.videoWidth ?? v.displayWidth; // (the <video>, or a decoded frame: 1.17's rcFastDraw)
  if (!mon?.w || !vw) return null;
  const k = vw / mon.w;
  const half = Math.max(1, r.size * k / 4);
  const cx = (r.x + r.size / 2) * k, cy = (r.y + r.size / 2) * k;
  let c = rcUi.probeCanvas;
  if (!c) { c = rcUi.probeCanvas = document.createElement('canvas'); c.width = c.height = 2; }
  const g = c.getContext('2d', { willReadFrequently: true });
  try { g.drawImage(v, cx - half, cy - half, half * 2, half * 2, 0, 0, 2, 2); } catch { return null; }
  const d = g.getImageData(0, 0, 2, 2).data;
  let R = 0, G = 0, B = 0;
  for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; }
  R /= 4; G /= 4; B /= 4;
  if (R > 150 && B > 150 && G < 110) return 'magenta';
  if (G > 150 && R < 110 && B < 110) return 'green';
  return null;
}

// The probes' medians, each step's own. (1.15) `caps`: the PC's own capture showing each probe's colour, from the probe
// reaching its page (a Windows app 1.15): less its time to put the square on its screen, that's Edge's capture.
function rcMeasureSum(got, caps = {}) {
  if (!got.length) return null;
  const med = list => { const a = list.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
  const rtt = rc.rtt ?? rc.pair?.rtt;
  const half = Number.isFinite(rtt) ? rtt / 2 : null;
  const enc = rc.host?.encMs ?? null, send = rc.host?.sendMs ?? null;
  // (on the PC's screen → here, per probe: the capture, encoding, sending and the way back)
  const out = got.map(g => (g.received != null && g.pc != null && half != null ? g.received - half - g.pc : null));
  const way = med(out);
  const capture = way != null ? Math.max(0, way - half - (enc || 0) - (send || 0)) : null;
  const edge = med(got.map(g => (Number.isFinite(caps[g.n]) && g.pc != null ? Math.max(0, caps[g.n] - g.pc) : null)));
  return {
    n: got.length, at: Date.now(), total: med(got.map(g => g.total)), toPc: half, pc: med(got.map(g => g.pc)),
    capture, edge: capture != null ? edge : null, enc, send, back: way != null ? half : null,
    decode: med(got.map(g => g.decode)), shown: med(got.map(g => g.shown)), drawn: got.some(g => g.drawn),
    rest: way == null ? Math.max(0, med(got.map(g => g.total)) - (half || 0) - (med(got.map(g => g.pc)) || 0)) : null,
  };
}

// (1.15) The PC's steps of a start (its `started`, a Windows app 1.15), as the details name them, in the order they came.
const RC_PC_STEPS = ['banner', 'page', 'offer', 'answer', 'connected', 'checked', 'capture', 'picture'];
const RC_PC_STEP_NAMES = { banner: 'banner', page: 'its page', offer: 'offer', answer: 'answer', connected: 'connected', checked: 'checked', capture: 'capture', picture: 'picture out' };

// "2.05 s to the picture · here: asked 0.42 · offer 0.60 · … · on Desktop: banner 0.07 · its page 0.12 · …". This
// page's seconds count from its own start (a first attempt: the page's, its sign-in checks and the request included;
// a later one: from Reconnect); the PC's from when the request got there. (1.17: this page's steps shown too.)
const RC_HERE_STEPS = ['asked', 'offer', 'answered', 'connected'];
function rcStartText() {
  const s = rc.start;
  if (!s || s.at.picture == null) return '';
  const sec = v => (v / 1000).toFixed(2);
  const here = RC_HERE_STEPS.filter(k => s.at[k] != null).map(k => `${k} ${sec(s.at[k])}`);
  const pc = s.pc ? Object.entries(s.pc).sort((a, b) => a[1] - b[1]).map(([k, v]) => `${RC_PC_STEP_NAMES[k] || k} ${sec(v)}`) : [];
  return `${sec(s.at.picture)} s to the picture${here.length ? ` · here: ${here.join(' · ')}` : ''}` +
    `${pc.length ? ` · on ${rc.name || 'the PC'}: ${pc.join(' · ')}${s.warm ? ' (its page was warm)' : ''}` : ''}`;
}

// The result for the details: "48 ms from a click to the picture: to the PC 2 · …".
function rcMeasuredText() {
  if (rc.measuring) return `measuring… ${rc.measuring.got.length} of ${RC_PROBES}`;
  const m = rc.measured;
  if (!m) return '';
  const ms = v => `${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)}`;
  const parts = [
    m.toPc != null && `to the PC ${ms(m.toPc)}`, m.pc != null && `on its screen ${ms(m.pc)}`,
    m.capture != null && `capture ${ms(m.capture)}${m.edge != null ? ` (Edge ${ms(Math.min(m.edge, m.capture))} + queue ${ms(Math.max(0, m.capture - m.edge))})` : ''}`,
    m.enc != null && m.capture != null && `encode ${ms(m.enc)}`, m.send != null && m.capture != null && `send ${ms(m.send)}`,
    m.back != null && `back ${ms(m.back)}`, m.decode != null && `decode ${ms(m.decode)}`, m.shown != null && `${m.drawn ? 'drawn' : 'shown'} ${ms(m.shown)}`,
    m.rest != null && `the rest ${ms(m.rest)}`,
  ].filter(Boolean);
  return `${Math.round(m.total)} ms from a click to the picture (median of ${m.n}): ${parts.join(' · ')}`;
}

// ---------------------------------------------------------------- the PC's pointer, drawn here (a Windows app 1.12.6)

// With a mouse (Picture → "Draw the pointer here", on by default): the PC hides its own pointer, which Edge's capture
// would otherwise draw into the picture a moment behind this mouse, and says which one is showing; the picture area
// then shows that one at once. An app's own pointer (it can't be hidden there) stays in the picture, with the dot here.
const RC_CURSORS = new Set(['default', 'text', 'wait', 'crosshair', 'nwse-resize', 'nesw-resize', 'ew-resize', 'ns-resize', 'move', 'not-allowed', 'pointer', 'progress', 'help']);
const rcPointerHere = () => rc.pic.pointer !== false && !rcPhone() && rc.caps.includes('cursor');

function rcSendPointer() {
  if (!rc.verified || !rc.hostHello || !rc.caps.includes('cursor') || rcPhone()) return rcApplyCursor();
  rcSend('ctl', { t: 'pointer', here: rcPointerHere() });
  if (!rcPointerHere()) { rc.cursorCss = null; rc.cursorHidden = false; }
  rcApplyCursor();
}

function rcApplyCursor() {
  const st = rcUi.stage;
  if (!st) return;
  const on = rcPointerHere() && rc.state === 'live';
  st.style.cursor = !on ? '' : rc.cursorHidden ? 'none' : rc.cursorCss || ''; // ('': the stylesheet's dot)
}

// The lag: a touch's way to the PC (half the round trip) and the picture's way back (measured per frame). A browser
// that can't measure the picture: the round trip, as before.
function rcLag() {
  const rtt = rc.rtt ?? rc.pair?.rtt;
  const pic = rc.stats?.picMs;
  if (pic == null) return rtt ?? null;
  return Math.round(pic + (rtt ?? 0) / 2);
}

// Tailscale's path to the PC, as the PC sees it (a Windows app 1.11 says): direct (on the same network, or over the
// internet), through a peer relay, or through Tailscale's relay servers, which add delay.
const RC_DERP = RELAY_CITIES; // (core.js since 1.17: Settings → Connections names them too)
function rcPathText() {
  const p = rc.path;
  if (p?.via === 'direct') return p.lan ? 'Tailscale, direct on the same network' : 'Tailscale, direct over the internet';
  if (p?.via === 'peer-relay') return 'Tailscale, through a peer relay';
  if (p?.via === 'relay') return `Tailscale, through its relay${p.relay ? ` in ${RC_DERP[p.relay] || p.relay.toUpperCase()}` : ''} (slower: it usually goes direct within seconds)`;
  return rc.pair?.remote ? `over Tailscale (${rc.pair.remote})` : '';
}

// ---------------------------------------------------------------- the data channels

function rcSend(name, msg) {
  const c = rc.ch?.[name];
  if (!c || c.readyState !== 'open' || !rc.verified) return false; // (nothing goes out before our peer check)
  try { c.send(JSON.stringify(msg)); return true; } catch { return false; }
}

// Our hello (once our check passed), the quality we want and the clipboard if it's on; pings both ways every 2 s.
function rcOnCtlOpen() {
  if (!rc.verified || rc.helloSent) return;
  rc.helloSent = true;
  const app = HOST ? 'windows' : /; wv\)/.test(navigator.userAgent) ? 'android' : 'web';
  // (a Windows app 1.12.6: `cursor`, the PC's pointer drawn here, with a mouse; a phone has its own)
  rcSend('ctl', { t: 'hello', v: 1, role: 'viewer', app, caps: ['clip', 'text', 'clipimg', ...(rcPhone() ? [] : ['cursor'])] });
  rc.quality = rc.pic.mode === 'motion' ? 'motion' : 'text'; // (a 1.6 PC's two; a 1.8 one gets the settings after its hello)
  rcSend('ctl', { t: 'quality', mode: rc.quality });
  if (rc.clip) rcSend('ctl', { t: 'clip', on: true });
  rcTimer('ping', () => rcSend('ctl', { t: 'ping', n: ++rc.pingN, at: Date.now() }), 2000, true);
}

// What the PC says on `ctl`, checked: it decides nothing here but the picture's details.
function rcOnCtl(data) {
  if (typeof data !== 'string' || data.length > 4 * RC_CLIP_MAX) return;
  // Before our own check passes (the PC's can pass first, and it says hello then): kept, and read once it passes.
  // (the same connection, so the same peer; if the check fails, they go with it)
  if (!rc.verified) { if (rc.ctlEarly.length < 20) rc.ctlEarly.push(data); return; }
  let m;
  try { m = JSON.parse(data); } catch { return; }
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'hello': // after the PC's own peer check; again after a switch of screens (a new connection)
      rc.hostHello = { v: Number(m.v) || 1 };
      rc.monitors = rcMonitors(m.monitors);
      rc.monitor = Number.isInteger(m.monitor) && rc.monitors.some(x => x.id === m.monitor) ? m.monitor
        : rc.monitors.find(x => x.primary)?.id ?? rc.monitors[0]?.id ?? 0;
      rcHostStats(m);
      rc.switching = null;
      rcClearTimer('switch');
      rcClearTimer('hello');
      rc.pointer = rcHostCursor(m.cursor); // (the trackpad's pointer starts where the PC's cursor is, from 1.6.1)
      // (1.8) What it does besides 1.6's: then the picture's settings, the fit, and whether this page is visible.
      rc.caps = Array.isArray(m.caps) ? m.caps.filter(x => typeof x === 'string').slice(0, 16) : [];
      rc.fitted = m.fitted === true;
      rc.fitting = false;
      rc.fitSent = '';
      rc.picSent = null;
      rc.videoOff = null; // (unknown: said once, whatever it is)
      rcLayout();
      rcRender();
      rcHook();
      rcMaybeHelp();
      rcSendPic();
      rcSendFit();
      rc.cursorCss = null; // (a new connection: the PC says again which pointer shows)
      rc.cursorHidden = false;
      rcSendPointer();
      rcVideo(!document.hidden);
      break;
    case 'stats':
      rcHostStats(m);
      rcRenderChip();
      rcRenderDetails();
      break;
    case 'cursor': // (a Windows app 1.12.6) the pointer showing there, drawn here: a CSS name; null: an app's own (in the picture)
      rc.cursorCss = typeof m.css === 'string' && RC_CURSORS.has(m.css) ? m.css : null;
      rc.cursorHidden = m.hidden === true;
      rcApplyCursor();
      break;
    case 'probe': // (1.12.6) a delay probe's answer: the square's colour now, and the PC's own time to put it on its screen
      if (rc.probe && m.n === rc.probe.n && ['magenta', 'green'].includes(m.color)) {
        rc.probe.answer = { color: m.color, ms: Number.isFinite(m.ms) ? Math.max(0, Math.min(m.ms, 5000)) : null };
        if (Number.isFinite(m.size) && m.size > 0 && m.size <= 256) rc.probeRect = { x: Number(m.x) || 0, y: Number(m.y) || 0, size: m.size };
        rc.probe.check();
      }
      break;
    case 'probe-cap': // (a Windows app 1.15) the PC's own capture showed that probe's colour this long after it got there
      if (rc.measuring && Number.isInteger(m.n) && m.n > 0 && m.n <= RC_PROBES && Number.isFinite(m.ms)) rc.measuring.caps[m.n] = Math.max(0, Math.min(m.ms, 5000));
      break;
    case 'started': // (a Windows app 1.15) how the PC's side of the start went: ms since the request got there, per step
      if (rc.start && !rc.start.pc && m.at && typeof m.at === 'object') {
        const at = {};
        for (const k of RC_PC_STEPS) if (Number.isFinite(m.at[k]) && m.at[k] >= 0 && m.at[k] < 600000) at[k] = Math.round(m.at[k]);
        rc.start.pc = at;
        rc.start.warm = m.warm === true;
        rcRenderDetails();
      }
      break;
    case 'path': // (1.14.2, a Windows app 1.11) how Tailscale reaches this viewer: direct, or through a relay
      rc.path = ['direct', 'relay', 'peer-relay'].includes(m.via)
        ? { via: m.via, lan: m.lan === true, relay: typeof m.relay === 'string' && /^[a-z0-9-]{1,16}$/.test(m.relay) ? m.relay : '' } : null;
      rcRenderChip();
      rcRenderDetails();
      break;
    case 'quality':
      if (RC_MODES.includes(m.mode)) {
        rc.quality = m.mode;
        rc.qualityInfo = { fps: Number(m.maxFps) || null, kbps: Number(m.maxKbps) || null };
        if (['text', 'motion', 'saver'].includes(m.profile)) rc.profile = m.profile;
        rcRenderBar();
        rcRenderDetails();
      }
      break;
    case 'display': // (1.8) after a fit or a restore: the screens' sizes now (input maps to them)
      rc.monitors = rcMonitors(m.monitors);
      if (Number.isInteger(m.monitor) && rc.monitors.some(x => x.id === m.monitor)) rc.monitor = m.monitor;
      rc.fitted = m.fitted === true;
      rc.fitting = false;
      rcClearTimer('fit');
      if (typeof m.note === 'string' && m.note) toast(rcClean(m.note, 160));
      rcLayout();
      rcRender();
      rcRenderDetails();
      break;
    case 'state':
      rc.sub = { locked: m.locked === true, secure: m.secure === true, elevated: m.elevated === true };
      if (rc.sub.locked || rc.sub.secure) rcRelease();
      rcRender();
      rcHook();
      break;
    case 'clip':
      if (rc.clip && typeof m.text === 'string' && rcUtf8Size(m.text) <= RC_CLIP_MAX) rcClipFromPc(m.text);
      break;
    case 'clip-img': // (1.12.4) the PC has the picture a held Ctrl+V waits for
      if (rc.pasteImg && m.n === rc.pasteImg) { rc.pasteImg = 0; rcFlushHeld(); }
      break;
    case 'ping':
      if (Number.isFinite(m.n) && Number.isFinite(m.at)) rcSend('ctl', { t: 'pong', n: m.n, at: m.at });
      break;
    case 'pong':
      if (Number.isFinite(m.at) && m.at <= Date.now()) rc.rtt = Date.now() - m.at;
      break;
    case 'bye':
      // The session's end comes from the server (rc-end). Unless the server forgot it (a restart: the PC's lease got
      // 404): then nothing comes, and a new session finds out whether the PC is back.
      rcRelease();
      rcTimer('bye', () => rcFail('lease'), 2500);
      break;
    default:
      break; // newer messages: ignored
  }
}

// Where the PC's cursor is on the screen it shares (its hello says, from 1.6.1), or null (elsewhere, or not said).
function rcHostCursor(c) {
  const mon = rc.monitors.find(x => x.id === rc.monitor);
  if (!c || !mon || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return null;
  if (c.x < 0 || c.y < 0 || c.x >= mon.w || c.y >= mon.h) return null;
  return { x: Math.floor(c.x), y: Math.floor(c.y) };
}

function rcMonitors(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 16).filter(x => x && Number.isInteger(x.id) && x.w > 0 && x.h > 0 && x.w <= 16384 && x.h <= 16384).map(x => ({
    id: x.id, name: rcClean(x.name || '', 40) || `Screen ${x.id + 1}`, w: Math.round(x.w), h: Math.round(x.h),
    primary: x.primary === true, scale: Number.isFinite(x.scale) ? x.scale : 1,
  }));
}

// The PC's own numbers (only it sees its encoder): codec, encoder, what limits it; from 1.8 also its screen's size, how
// much smaller it sends it, the profile and its limits, the network's estimate, loss and delay (for the details).
function rcHostStats(m) {
  if (typeof m.encoder === 'string') rc.encoder = rcClean(m.encoder, 120);
  if (typeof m.codec === 'string') rc.hostCodec = rcClean(m.codec, 40);
  if (typeof m.qlr === 'string') rc.qlr = rcClean(m.qlr, 20);
  if (m.t !== 'stats' || !Number.isFinite(m.srcW)) return;
  const num = (v, max) => (Number.isFinite(v) && v >= 0 ? Math.min(v, max) : null);
  rc.host = {
    srcW: num(m.srcW, 16384), srcH: num(m.srcH, 16384), w: num(m.w, 16384), h: num(m.h, 16384), down: num(m.down, 64),
    fps: num(m.fps, 1000), kbps: num(m.kbps, 1e7), maxFps: num(m.maxFps, 1000), maxKbps: num(m.maxKbps, 1e7),
    avail: num(m.avail, 1e7), lost: num(m.lost, 100), rtt: num(m.rtt, 1e5), auto: m.auto === true, video: m.video !== false,
    encMs: num(m.encMs, 1000), sendMs: num(m.sendMs, 1000), // (1.12.6) a frame's encoding, and its packets' wait to go out
  };
  if (['text', 'motion', 'saver'].includes(m.profile)) rc.profile = m.profile;
}

// Text from the PC for the bar: one line, no control or bidi characters, cut short.
const rcClean = (v, n) => String(v).replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩‎‏؜]/g, '').trim().slice(0, n);
const rcUtf8Size = s => new TextEncoder().encode(s).length;

// ---------------------------------------------------------------- input: where a point is on the remote screen

// The remote screen's size in its own pixels: the monitor's (from the PC's hello) or, until then, the picture's.
function rcScreenSize() {
  const mon = rc.monitors.find(x => x.id === rc.monitor);
  if (mon) return { w: mon.w, h: mon.h };
  return { w: rcUi.video.videoWidth || 0, h: rcUi.video.videoHeight || 0 };
}

// A point in the window → physical pixels within the monitor (clamped to it). `inside`: on the picture at all (the
// black bars around it aren't).
function rcPoint(clientX, clientY) {
  const { w, h } = rcScreenSize();
  const r = rcUi.video.getBoundingClientRect();
  if (!w || !h || r.width < 1 || r.height < 1) return null;
  const fx = (clientX - r.left) / r.width;
  const fy = (clientY - r.top) / r.height;
  return {
    x: Math.min(w - 1, Math.max(0, Math.floor(fx * w))),
    y: Math.min(h - 1, Math.max(0, Math.floor(fy * h))),
    inside: fx >= 0 && fx < 1 && fy >= 0 && fy < 1,
  };
}

// Input goes once both checks passed: ours, and the PC's (it says hello after its own, and drops input until then);
// not while the PC's screen changes size for a fit (1.8: its sizes come right after).
const rcLive = () => rc.state === 'live' && rc.verified && !rc.resolving && Boolean(rc.hostHello) && !rc.switching && !rc.sub.locked && !rc.sub.secure && !rc.fitting;

// Moves: the latest one goes once per animation frame on `mv` (unordered, no retries); a full channel waits.
function rcMove(p) {
  if (!p || !rcLive()) return;
  rc.mvPending = p;
  if (!rc.mvFrame) rc.mvFrame = requestAnimationFrame(rcFlushMove);
}
function rcFlushMove() {
  rc.mvFrame = 0;
  const p = rc.mvPending;
  if (!p || !rcLive()) { rc.mvPending = null; return; }
  const c = rc.ch?.mv;
  if (!c || c.readyState !== 'open') return;
  if (c.bufferedAmount > RC_MV_BUFFERED) { rc.mvFrame = requestAnimationFrame(rcFlushMove); return; }
  rc.mvPending = null;
  if (rcSend('mv', { t: 'mv', n: rc.mvSeq + 1, x: p.x, y: p.y, m: rc.monitor })) rc.mvSeq++;
}

// Buttons carry their own position (a lost move never misplaces a click) and `n`, the last move sent before them
// (so a late move never pulls the pointer back). b: 0 left, 1 middle, 2 right, 3 back, 4 forward.
function rcButton(b, down, p) {
  if (!p) return;
  if (down) { if (!rcLive() || rc.buttons.has(b)) return; rc.buttons.add(b); }
  else if (!rc.buttons.delete(b)) return;
  if (rc.mvPending) { cancelAnimationFrame(rc.mvFrame); rc.mvFrame = 0; rcFlushMove(); } // (the move first, now)
  rcInput({ t: 'btn', b, d: down, x: p.x, y: p.y, m: rc.monitor, n: rc.mvSeq });
}

function rcClick(p, b = 0) {
  rcButton(b, true, p);
  rcButton(b, false, p);
}

// Wheel: added up per frame. 120 = one notch, with WheelEvent's signs (dy > 0 scrolls down, dx > 0 right).
function rcScroll(dx, dy, p) {
  if (!p || !rcLive()) return;
  const w = rc.wheel || (rc.wheel = { dx: 0, dy: 0, p });
  w.dx += dx;
  w.dy += dy;
  w.p = p;
  if (!rc.wheelFrame) rc.wheelFrame = requestAnimationFrame(rcFlushWheel);
}
function rcFlushWheel() {
  rc.wheelFrame = 0;
  const w = rc.wheel;
  if (!w || !rcLive()) { rc.wheel = null; return; }
  const dx = Math.trunc(w.dx);
  const dy = Math.trunc(w.dy);
  if (!dx && !dy) return;
  w.dx -= dx; // (fractions wait for the next frame)
  w.dy -= dy;
  rcInput({ t: 'wheel', dx, dy, x: w.p.x, y: w.p.y, m: rc.monitor, n: rc.mvSeq });
}

// Keys by KeyboardEvent.code (the PC maps them to scancodes; AltGr's extra ControlLeft is the PC's to drop).
function rcKey(code, down) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(code)) return;
  if (down) { if (!rcLive()) return; rc.keys.add(code); }
  else if (!rc.keys.delete(code)) return;
  rcInput({ t: 'key', c: code, d: down });
}

// A combination: pressed in order, let go in reverse (the Keys menu, the key strip).
function rcCombo(codes) {
  if (!rcLive()) return;
  for (const c of codes) rcKey(c, true);
  for (const c of [...codes].reverse()) rcKey(c, false);
}

// Text (an IME's, a phone keyboard's, a paste): Unicode on the PC; line breaks as Enter.
function rcType(s) {
  if (!s || !rcLive()) return;
  s.replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
    if (i) rcCombo(['Enter']);
    for (let j = 0; j < line.length; j += 512) rcInput({ t: 'text', s: line.slice(j, j + 512) });
  });
}

// `in`, in order (held back while a paste goes to the PC first).
function rcInput(msg) {
  if (rc.held) { if (rc.held.length < 200) rc.held.push(msg); return; }
  rcSend('in', msg);
}

// Let go of everything: the PC releases what it holds down (blur, a hidden page, a lost connection, the end).
function rcRelease() {
  if (rc.mvFrame) { cancelAnimationFrame(rc.mvFrame); rc.mvFrame = 0; }
  if (rc.wheelFrame) { cancelAnimationFrame(rc.wheelFrame); rc.wheelFrame = 0; }
  rc.mvPending = rc.wheel = null;
  const had = rc.keys.size || rc.buttons.size || rc.held;
  rc.keys.clear();
  rc.buttons.clear();
  rc.held = null;
  rcClearTimer('paste');
  if (rc.sticky.size) { rc.sticky.clear(); rcRenderKeyStrip(); }
  rcTouchReset();
  if (rc.ch?.in?.readyState === 'open' && rc.verified) rcSend('in', { t: 'release' });
  return had;
}

// ---------------------------------------------------------------- input: mouse and pen, wheel, keys

const rcTouchUi = () => matchMedia('(any-pointer: coarse)').matches;
const rcPhone = () => matchMedia('(pointer: coarse)').matches; // (touch first: a phone or a tablet)
// The buttons bitmask → the protocol's buttons (left, middle, right, back, forward).
const RC_BUTTON_BITS = [[1, 0], [4, 1], [2, 2], [8, 3], [16, 4]];

function rcBindInput() {
  const { stage, sink } = rcUi;
  stage.addEventListener('contextmenu', e => e.preventDefault());
  // (focus stays in the hidden box; the mouse's back and forward buttons don't leave the page)
  stage.addEventListener('mousedown', e => { e.preventDefault(); if (lastPointer !== 'touch') rcFocusSink(); });
  stage.addEventListener('mouseup', e => { if (e.button === 3 || e.button === 4) e.preventDefault(); });
  stage.addEventListener('pointerdown', rcOnPointerDown);
  stage.addEventListener('pointermove', rcOnPointerMove);
  stage.addEventListener('pointerup', rcOnPointerUp);
  stage.addEventListener('pointercancel', rcOnPointerUp);
  stage.addEventListener('lostpointercapture', rcOnPointerUp);
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 360 : 1.2; // (a notch: 3 lines, or 100 px)
    rcScroll(e.deltaX * k, e.deltaY * k, rcPoint(e.clientX, e.clientY));
  }, { passive: false });
  sink.addEventListener('keydown', rcOnKeyDown);
  sink.addEventListener('keyup', rcOnKeyUp);
  sink.addEventListener('compositionstart', () => { rc.composing = true; });
  sink.addEventListener('compositionend', rcOnCompositionEnd);
  sink.addEventListener('beforeinput', rcOnBeforeInput);
  sink.addEventListener('input', rcOnSinkInput);
  sink.addEventListener('paste', rcOnPaste);
  sink.addEventListener('focus', () => rcRenderBar());
  sink.addEventListener('blur', () => { rcRelease(); rcRenderBar(); });
}

function rcFocusSink() {
  if (rc.state === 'live' && document.activeElement !== rcUi.sink) rcUi.sink.focus({ preventScroll: true });
}

// Mouse and pen act where they are; their buttons follow the buttons bitmask (a second button while one is down
// comes as a move). Touch has its gestures (below).
let rcMouseOn = false; // a mouse button went down on the picture (the pointer is captured until they're all up)

function rcOnPointerDown(e) {
  if (e.pointerType === 'touch') return rcTouchDown(e);
  const p = rcPoint(e.clientX, e.clientY);
  if (!p || !p.inside || !rcLive()) return;
  rcUi.stage.setPointerCapture?.(e.pointerId);
  rcMouseOn = true;
  rcMove(p);
  rcSyncButtons(e.buttons, p);
}

function rcOnPointerMove(e) {
  if (e.pointerType === 'touch') return rcTouchMove(e);
  const p = rcPoint(e.clientX, e.clientY);
  rcMove(p);
  if (rcMouseOn && p) rcSyncButtons(e.buttons, p);
}

function rcOnPointerUp(e) {
  if (e.pointerType === 'touch') return rcTouchUp(e);
  if (!rcMouseOn) return;
  const p = rcPoint(e.clientX, e.clientY) || { x: 0, y: 0 };
  rcSyncButtons(e.type === 'pointerup' ? e.buttons : 0, p);
  if (!rc.buttons.size) rcMouseOn = false;
}

function rcSyncButtons(mask, p) {
  for (const [bit, b] of RC_BUTTON_BITS) {
    const down = (mask & bit) !== 0;
    if (down !== rc.buttons.has(b)) rcButton(b, down, p);
  }
}

const rcKeysToRemote = () => document.activeElement === rcUi.sink && rcLive() && $('#menu').hidden && !rcUi.pop;

function rcOnKeyDown(e) {
  if (!rcKeysToRemote()) return;
  if (e.isComposing || e.keyCode === 229 || e.key === 'Process') return; // an IME or a phone keyboard: text comes as text
  const code = e.code;
  if (!code || code === 'Unidentified') {
    // A key without a physical code (some soft keyboards): its character, if it has one.
    if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey) { e.preventDefault(); rcType(e.key); }
    return;
  }
  // Ctrl+V / Shift+Insert with the clipboard on: the browser pastes into the hidden box first, and the PC gets our
  // clipboard before the keys (they wait meanwhile).
  if (rc.clip && !e.repeat && !rc.held && ((code === 'KeyV' && (e.ctrlKey || e.metaKey) && !e.altKey) || (code === 'Insert' && e.shiftKey))) {
    rc.held = [];
    rcKey(code, true); // (held, with what follows, until the clipboard has gone)
    rcTimer('paste', rcFlushHeld, 400);
    return; // (not prevented: that's what makes the paste happen)
  }
  // Ctrl+V with the clipboard off pastes what the PC itself copied: say once how to bring this device's across (1.7.2,
  // the user's paste from the laptop "didn't paste": sync is off in each session until it's turned on).
  if (!rc.clip && !rc.clipHinted && !e.repeat && ((code === 'KeyV' && (e.ctrlKey || e.metaKey) && !e.altKey) || (code === 'Insert' && e.shiftKey))) {
    rc.clipHinted = true;
    if (typeof toast === 'function') toast('To paste what this device copied, turn on Clipboard in the bar (it’s off in each session until you turn it on).', { ms: 8000 });
  }
  e.preventDefault();
  if (rc.sticky.size && !rcModifier(code)) return rcWithSticky([code]);
  rcKey(code, true);
}

function rcOnKeyUp(e) {
  if (!e.code || !rc.keys.has(e.code)) return;
  e.preventDefault();
  rcKey(e.code, false);
}

// ---------------------------------------------------------------- text: IMEs, phone keyboards, paste

// The hidden box has the focus while the remote screen does. A PC's keyboard sends keys (their keydown is never let
// through, so nothing lands in the box), and an IME's composition goes as text once committed. Phone keyboards
// compose words as you type: there the box is kept in step with the PC by its difference with what was sent (letters
// deleted become Backspace, letters added become text), so autocorrect just works.
const RC_SINK_PAD = '  '; // phones: something for Backspace to delete in an empty box
const rcSoftKeyboard = () => matchMedia('(pointer: coarse)').matches;

function rcOnCompositionEnd(e) {
  rc.composing = false;
  if (rcLive()) {
    if (rcSoftKeyboard()) rcDiffSink();
    else if (e.data) rcType(e.data);
  }
  if (!rcSoftKeyboard()) rcClearSinkSoon();
}

function rcOnBeforeInput(e) {
  if (!rcLive() || document.activeElement !== rcUi.sink) return;
  const t = e.inputType;
  const box = rcUi.sink;
  if (t === 'insertLineBreak' || t === 'insertParagraph') { e.preventDefault(); rcWithSticky(['Enter']); rcClearSink(); }
  else if (t === 'deleteContentBackward' && !e.isComposing && rcSoftKeyboard() && box.value.length <= RC_SINK_PAD.length && box.selectionStart <= RC_SINK_PAD.length) {
    e.preventDefault(); // (nothing left to delete here: the PC's Backspace all the same)
    rcWithSticky(['Backspace']);
  }
}

function rcOnSinkInput() {
  if (!rcLive()) return;
  if (rcSoftKeyboard()) return rcDiffSink();
  if (!rc.composing) rcClearSinkSoon(); // (on a PC only a composition should land in the box)
}

function rcDiffSink() {
  const now = rcUi.sink.value;
  const was = rc.sinkText;
  let p = 0;
  while (p < now.length && p < was.length && now[p] === was[p]) p++;
  const removed = Math.min(was.length - p, 200);
  const added = now.slice(p);
  rc.sinkText = now;
  for (let i = 0; i < removed; i++) rcCombo(['Backspace']);
  if (added) {
    const code = added.length === 1 && rc.sticky.size ? RC_CHAR_CODE(added) : '';
    if (code) rcWithSticky([code]);
    else rcType(added);
  }
  if (!rc.composing && (now.length > 64 || now.includes('\n'))) rcClearSinkSoon();
}

function rcClearSink() {
  const box = rcUi.sink;
  box.value = rcSoftKeyboard() ? RC_SINK_PAD : '';
  rc.sinkText = box.value;
  try { box.setSelectionRange(box.value.length, box.value.length); } catch {}
}
function rcClearSinkSoon() { setTimeout(() => { if (!rc.composing) rcClearSink(); }, 0); }

// Pasting into the hidden box. After Ctrl+V with the clipboard on: our clipboard to the PC first, then the keys
// that were waiting. Otherwise (a phone keyboard's Paste): typed in.
function rcOnPaste(e) {
  e.preventDefault();
  if (!rcLive()) return;
  const text = e.clipboardData?.getData('text/plain') || '';
  if (rc.held) {
    // (1.12.7) What the PC itself put on our clipboard, unchanged: the keys go at once, and the PC's clipboard stays as
    // it was (its own formats). A picture used to go there and back first: seconds, and a paste that could miss.
    if (text && rc.clip && !rc.clipPending && text === rc.lastClip) return rcFlushHeld();
    const img = !text && rc.clip ? rcClipImageOf(e.clipboardData) : null;
    if (img && rc.lastClipImg && !rc.clipPending) {
      const theirs = rc.lastClipImg;
      rcSamePicture(img, theirs).then(same => { if (rc.held) { if (same && rc.lastClipImg === theirs) rcFlushHeld(); else rcSendClipImage(img); } });
      return;
    }
    if (text && rcUtf8Size(text) <= RC_CLIP_MAX && rc.clip) {
      rcSend('ctl', { t: 'clip', n: ++rc.clipN, text });
      rcTimer('paste', rcFlushHeld, 120); // (`ctl` and `in` aren't in order with each other: a moment for the PC)
    } else if (img) rcSendClipImage(img); // (1.12.4)
    else rcFlushHeld();
    return;
  }
  if (text && rcUtf8Size(text) <= RC_CLIP_MAX) rcType(text);
}

// (1.12.4) A picture on the clipboard (a screenshot), when there's no text: to the PC on `clip`, and the keys wait until
// it says it has it (`clip-img`; 15 s at most).
function rcClipImageOf(dt) {
  for (const it of dt?.items || []) if (it.kind === 'file' && /^image\//.test(it.type)) return it.getAsFile();
  return null;
}

// (1.12.7) Whether two pictures have the same pixels: the PC's comes back from our clipboard re-encoded, never the same
// bytes. Both drawn at full size, with a little leeway for the colours' round trip; over 16 megapixels they count as
// different (sending is the safe way).
async function rcSamePicture(a, b) {
  let x, y;
  try {
    [x, y] = await Promise.all([createImageBitmap(a), createImageBitmap(b)]);
    if (x.width !== y.width || x.height !== y.height || x.width * x.height > 16e6) return false;
    const px = bmp => {
      const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      return g.getImageData(0, 0, bmp.width, bmp.height).data;
    };
    const p = px(x), q = px(y);
    for (let i = 0; i < p.length; i += 4) {
      if (p[i + 3] < 4 && q[i + 3] < 4) continue; // both see-through: their colours don't count
      if (Math.abs(p[i] - q[i]) > 3 || Math.abs(p[i + 1] - q[i + 1]) > 3 || Math.abs(p[i + 2] - q[i + 2]) > 3 || Math.abs(p[i + 3] - q[i + 3]) > 3) return false;
    }
    return true;
  } catch { return false; } finally { x?.close?.(); y?.close?.(); }
}

const rcB64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };

async function rcSendClipImage(file) {
  if (!file || !rc.caps.includes('clipimg') || rc.ch?.clip?.readyState !== 'open') {
    if (file && !rc.caps.includes('clipimg') && typeof toast === 'function') toast('Pictures go across once the PC has Beam for Windows 1.12.4.', { ms: 6000 });
    return rcFlushHeld();
  }
  if (file.size > RC_IMG_MAX) { if (typeof toast === 'function') toast('That picture is too big to send (over 16 MB).'); return rcFlushHeld(); }
  const n = ++rc.clipN;
  rc.pasteImg = n;
  rcTimer('paste', rcFlushHeld, 15000);
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); } catch { rc.pasteImg = 0; return rcFlushHeld(); }
  if (rc.pasteImg !== n) return;
  const of = Math.max(1, Math.ceil(bytes.length / RC_IMG_PART));
  for (let i = 0; i < of; i++) rc.clipOut.push(JSON.stringify({ t: 'img', n, i, of, size: bytes.length, type: file.type || 'image/png', d: rcB64(bytes.subarray(i * RC_IMG_PART, (i + 1) * RC_IMG_PART)) }));
  rcDrainClip();
}

function rcDrainClip() {
  const c = rc.ch?.clip;
  if (!c || c.readyState !== 'open' || !rc.verified) { if (!c || c.readyState === 'closed') rc.clipOut = []; return; }
  while (rc.clipOut.length && c.bufferedAmount < RC_CLIP_BUFFERED) {
    try { c.send(rc.clipOut.shift()); } catch { rc.clipOut = []; return; }
  }
}

// (1.12.4) The PC's clipboard picture, part by part (in order, decoded as they come): whole, it waits as text does.
function rcClipPart(data) {
  let p;
  try { p = JSON.parse(data); } catch { return; }
  if (!p || p.t !== 'img' || !rc.clip) return;
  if (p.i === 0) {
    const ok = Number.isInteger(p.of) && p.of >= 1 && p.of <= Math.ceil(RC_IMG_MAX / RC_IMG_PART) && Number.isInteger(p.size) && p.size > 0 && p.size <= RC_IMG_MAX;
    rc.clipIn = ok ? { n: p.n, of: p.of, size: p.size, bytes: new Uint8Array(p.size), at: 0, got: 0 } : null;
  }
  const c = rc.clipIn;
  if (!c || p.n !== c.n || p.i !== c.got || typeof p.d !== 'string') { rc.clipIn = null; return; }
  let part;
  try { part = atob(p.d); } catch { rc.clipIn = null; return; }
  if (c.at + part.length > c.size) { rc.clipIn = null; return; }
  for (let i = 0; i < part.length; i++) c.bytes[c.at++] = part.charCodeAt(i);
  if (++c.got < c.of) return;
  rc.clipIn = null;
  if (c.at === c.size) rcClipImgFromPc(new Blob([c.bytes], { type: 'image/png' }));
}

async function rcClipImgFromPc(blob) {
  rc.lastClipImg = blob;
  rc.lastClip = '';
  rc.clipPending = true;
  await rcWriteClip();
}

const rcClipWaiting = () => rc.clip && rc.clipPending && Boolean(rc.lastClip || rc.lastClipImg);
const rcWriteImage = async img => { try { await navigator.clipboard.write([new ClipboardItem({ [img.type || 'image/png']: img })]); return true; } catch { return false; } };

function rcFlushHeld() {
  rcClearTimer('paste');
  const held = rc.held || [];
  rc.held = null;
  for (const m of held) rcSend('in', m);
  rcClearSink();
}

// The PC's clipboard (with sync on): onto ours, but only while this window has the focus (else the PC could replace
// it while the user works elsewhere); the latest waits for the focus, with a Copy button meanwhile and where the
// browser won't write it. (The Windows app's viewer window lets the page use the clipboard without asking.)
async function rcClipFromPc(text) {
  rc.lastClip = text;
  rc.lastClipImg = null; // (1.12.4: text after a picture)
  rc.clipPending = true;
  await rcWriteClip();
}

async function rcWriteClip() {
  if (rcClipWaiting() && document.hasFocus() && navigator.clipboard && window.isSecureContext) {
    const text = rc.lastClip, img = rc.lastClipImg;
    if (img) { if (await rcWriteImage(img) && rc.lastClipImg === img) rc.clipPending = false; }
    else { try { await navigator.clipboard.writeText(text); if (rc.lastClip === text) rc.clipPending = false; } catch {} }
  }
  rcRenderBar();
}

// The key strip's Ctrl / Alt / Shift / Win stay down for the next key.
const RC_MODIFIERS = { Ctrl: 'ControlLeft', Alt: 'AltLeft', Shift: 'ShiftLeft', Win: 'MetaLeft' };
const rcModifier = code => /^(Control|Alt|Shift|Meta)(Left|Right)$/.test(code);
function rcWithSticky(codes) {
  const mods = [...rc.sticky].map(m => RC_MODIFIERS[m]);
  if (rc.sticky.size) { rc.sticky.clear(); rcRenderKeyStrip(); }
  rcCombo([...mods, ...codes]);
}
const RC_CHAR_CODE = ch => (/^[a-z]$/i.test(ch) ? `Key${ch.toUpperCase()}` : /^\d$/.test(ch) ? `Digit${ch}` : ch === ' ' ? 'Space' : '');

// ---------------------------------------------------------------- touch: trackpad (relative) or touch (where the finger is)

// The gestures follow Chrome Remote Desktop's and Microsoft Remote Desktop's. Both modes:
// tap = click; touch and hold, then let go = right-click; touch and hold, then move = drag (a ring fills while you
// hold, and the phone buzzes once it's ready); two-finger tap = right-click; three-finger tap = middle-click (a
// three-finger swipe up or down shows or hides the keyboard); pinch = zoom the picture (here only, nothing goes to the
// PC).
// - Trackpad: one finger moves the pointer like a laptop's touchpad (slow is precise, quick goes far), two fingers
//   scroll where the pointer is; zoomed in, the picture follows the pointer.
// - Touch: a tap clicks under the finger (a second tap there is a double-click), one finger scrolls what's under it
//   (like a touch screen), two fingers move and zoom the picture (like a photo).
// Scrolls keep going for a moment after a quick flick.
const RC_STILL = 6;       // CSS px: a finger held still stays this close (a hold, a slow tap)
const RC_TAP_SLOP = 12;   // …and a quick tap this close
const RC_TAP_MS = 250;    // quicker than this is a quick tap
const RC_HOLD_MS = 450;   // held still this long: a hold
const RC_MULTI_TAP_MS = 450; // two or three fingers on and off within this: a tap
const RC_DOUBLE_MS = 450; // touch mode: a tap this soon after another…
const RC_DOUBLE_PX = 28;  // …and this close clicks where that one did (Windows sees a double-click)
const RC_FLING = { tau: 300, min: 0.25, max: 8 }; // momentum: fades with this time constant (ms); CSS px per ms
const RC_EDGE = 0.18;     // trackpad zoomed in: the picture moves when the pointer gets this close to an edge (of the size)

const rcTouch = {
  fingers: new Map(), // pointerId -> { x, y, x0, y0, far, hist: [[t, x, y]…] }
  g: null,            // one | point | scroll | hold | drag | two | three | ignore
  t0: 0,
  at: null,           // the first finger's start: { x, y } in the window, p on the PC's screen
  p0: null,           // trackpad: where the pointer was when it started
  holdTimer: 0,
  caught: false,      // this touch stopped a scroll's momentum
  speed: 0,           // trackpad: the finger's speed, smoothed (CSS px per ms)
  two: null,
  three: null,
  lastTap: null,      // touch mode: { t, x, y, p }
  edgeFrame: 0,       // touch-mode drag at an edge of a zoomed picture: it scrolls
};

// A finger's speed and direction over its last ~80 ms (CSS px per ms).
function rcVelocity(hist) {
  if (hist.length < 2) return { vx: 0, vy: 0 };
  const [t1, x1, y1] = hist.at(-1);
  let i = hist.length - 2;
  while (i > 0 && t1 - hist[i][0] < 80) i--;
  const [t0, x0, y0] = hist[i];
  const dt = Math.max(8, t1 - t0);
  return { vx: (x1 - x0) / dt, vy: (y1 - y0) / dt };
}

const rcMid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const rcDist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function rcTouchReset() {
  const t = rcTouch;
  clearTimeout(t.holdTimer);
  cancelAnimationFrame(t.edgeFrame);
  t.edgeFrame = 0;
  t.fingers.clear();
  t.g = null;
  t.two = t.three = null;
  rcHoldRing(null);
  rcFlingStop();
  if (rcUi.cursor) rcUi.cursor.classList.remove('down');
}

function rcTouchDown(e) {
  e.preventDefault();
  rcUi.stage.setPointerCapture?.(e.pointerId);
  const t = rcTouch;
  const flinging = Boolean(rcFlinging);
  rcFlingStop();
  t.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, far: 0, hist: [[e.timeStamp, e.clientX, e.clientY]] });
  const n = t.fingers.size;
  if (n === 1) {
    t.two = t.three = null;
    t.t0 = e.timeStamp;
    t.speed = 0;
    const p = rcDesk(e.clientX, e.clientY);
    // (touch mode: the black bars around the picture aren't the PC's)
    if (!rcLive() || !p || (rc.touchMode === 'touch' && !p.inside)) { t.g = 'ignore'; return; }
    t.g = 'one';
    t.at = { x: e.clientX, y: e.clientY, p };
    t.caught = flinging; // (a touch that stops a scroll's momentum only stops it, as on a phone: it isn't a tap)
    t.p0 = rc.touchMode === 'trackpad' ? rcPointerPoint() : null;
    clearTimeout(t.holdTimer);
    t.holdTimer = setTimeout(rcHoldFired, RC_HOLD_MS);
    rcHoldRing('start');
    return;
  }
  if (t.g === 'drag' || t.g === 'ignore' || !t.g) return; // (a drag keeps to its finger)
  if (t.g === 'three') { t.g = 'ignore'; return; } // (four fingers: nothing)
  clearTimeout(t.holdTimer);
  rcHoldRing(null);
  if (t.g === 'one' && t.p0) rcSetPointer(t.p0); // (the first finger's wobble wasn't a move)
  const list = [...t.fingers.values()];
  for (const f of list) { f.sx = f.x; f.sy = f.y; } // (each finger's start for this many fingers)
  if (n === 2) {
    const [a, b] = list;
    const mid = rcMid(a, b);
    t.g = 'two';
    t.two = { t: e.timeStamp, d0: Math.max(1, rcDist(a, b)), last: mid, kind: rc.touchMode === 'touch' ? 'view' : '', moved: false, hist: [[e.timeStamp, mid.x, mid.y]],
      anchor: rcDesk(mid.x, mid.y), s0: rcScale(), zoomFrom: null, at: t.at };
  } else if (n === 3) {
    t.g = 'three';
    t.three = { t: e.timeStamp, moved: false, swiped: false };
  } else t.g = 'ignore';
}

function rcTouchMove(e) {
  const t = rcTouch;
  const f = t.fingers.get(e.pointerId);
  if (!f) return;
  e.preventDefault();
  const dx = e.clientX - f.x;
  const dy = e.clientY - f.y;
  const dt = Math.max(4, e.timeStamp - f.hist.at(-1)[0]);
  f.x = e.clientX;
  f.y = e.clientY;
  f.far = Math.max(f.far, Math.hypot(f.x - f.x0, f.y - f.y0));
  f.hist.push([e.timeStamp, f.x, f.y]);
  if (f.hist.length > 12) f.hist.shift();
  if (!rcLive() || !t.g || t.g === 'ignore') return;
  if (t.g === 'one' || t.g === 'hold') {
    if (f.far > RC_STILL) { clearTimeout(t.holdTimer); rcHoldRing(null); }
    if (t.g === 'hold') {
      if (f.far > RC_STILL) rcDragStart();
      else return;
    } else if (rc.touchMode === 'touch') {
      if (f.far <= RC_TAP_SLOP) return;
      t.g = 'scroll'; // (from here what's under the finger scrolls; nothing moved before this)
      return rcScrollBy(f.x - f.x0, f.y - f.y0, t.at.p);
    } else if (f.far > RC_TAP_SLOP) t.g = 'point';
  }
  switch (t.g) {
    case 'one': // trackpad: moves straight away (a tap puts the pointer back)
    case 'point':
      t.speed = t.speed * 0.6 + (Math.hypot(dx, dy) / dt) * 0.4;
      return rcNudgePointer(dx, dy, t.speed);
    case 'scroll':
      return rcScrollBy(dx, dy, t.at.p);
    case 'drag':
      if (rc.touchMode === 'trackpad') {
        t.speed = t.speed * 0.6 + (Math.hypot(dx, dy) / dt) * 0.4;
        return rcNudgePointer(dx, dy, t.speed);
      }
      rcDragTo(f.x, f.y);
      return rcDragEdge();
    case 'two':
      return rcTwoMove(e);
    case 'three': {
      const list = [...t.fingers.values()];
      if (list.some(x => Math.hypot(x.x - x.sx, x.y - x.sy) > RC_TAP_SLOP)) t.three.moved = true;
      const avg = list.reduce((s, x) => s + (x.y - x.sy), 0) / list.length;
      if (!t.three.swiped && Math.abs(avg) > 48) {
        t.three.swiped = true;
        if (avg < 0) rcShowKeyboard(true);
        else if (document.activeElement === rcUi.sink) rcUi.sink.blur();
      }
      return;
    }
    default:
  }
}

function rcTouchUp(e) {
  const t = rcTouch;
  const f = t.fingers.get(e.pointerId);
  if (!f) return;
  t.fingers.delete(e.pointerId);
  const up = e.type === 'pointerup';
  const dur = e.timeStamp - t.t0;
  const left = t.fingers.size;
  switch (t.g) {
    case 'one': {
      clearTimeout(t.holdTimer);
      rcHoldRing(null);
      const tap = up && rcLive() && !t.caught && ((dur < RC_TAP_MS && f.far <= RC_TAP_SLOP) || f.far <= RC_STILL);
      if (tap) rcTap(f);
      break;
    }
    case 'hold': // let go without moving: the right button
      rcHoldRing(null);
      if (up && rcLive()) {
        const p = rc.touchMode === 'trackpad' ? rcPointerPoint() : rcPx(t.at.p);
        rcClick(p, 2);
        rcFx('right', rcClient(p));
      }
      break;
    case 'drag':
      rcDragEnd(rc.touchMode === 'trackpad' ? rcPointerPoint() : rcPx(rcDesk(f.x, f.y) || t.at.p));
      break;
    case 'scroll':
      if (up) { const v = rcVelocity(f.hist); rcFlingStart(v.vx, v.vy, t.at.p); }
      break;
    case 'two': {
      const two = t.two;
      if (left) {
        // The first of the two lifting: a scroll goes on by itself after a flick; the other finger only ends it.
        if (two.kind === 'scroll' && up && !two.lifting) { const v = rcVelocity(two.hist); rcFlingStart(v.vx, v.vy, null); }
        two.lifting = true;
        return;
      }
      // A quick two-finger tap (the second finger lifting ends it): the right button.
      if (up && !two.moved && (two.kind === '' || two.kind === 'view') && e.timeStamp - two.t < RC_MULTI_TAP_MS && rcLive()) {
        const p = rc.touchMode === 'trackpad' ? rcPointerPoint() : rcPx(two.at.p);
        rcClick(p, 2);
        rcFx('right', rcClient(p));
      }
      break;
    }
    case 'three': {
      if (left) return;
      if (up && !t.three.moved && !t.three.swiped && e.timeStamp - t.three.t < RC_MULTI_TAP_MS && rcLive()) {
        const p = rc.touchMode === 'trackpad' ? rcPointerPoint() : rcPx(t.at.p);
        rcClick(p, 1);
        rcFx('tap', rcClient(p));
      }
      break;
    }
    default:
  }
  if (!left) {
    t.g = null;
    cancelAnimationFrame(t.edgeFrame);
    t.edgeFrame = 0;
  } else if (t.g !== 'drag') t.g = 'ignore';
}

// A tap: trackpad, where the pointer was when the finger came down (a wobble doesn't move the click); touch, under the
// finger (a second tap close and soon after clicks the very same pixel, so Windows sees a double-click).
function rcTap(f) {
  const t = rcTouch;
  if (rc.touchMode === 'trackpad') {
    const p = t.p0 || rcPointerPoint();
    if (!p) return;
    rcSetPointer(p);
    rcClick(p);
    rcFx('tap small', rcClient(p));
    return;
  }
  let p = rcPx(t.at.p);
  const last = t.lastTap;
  const now = performance.now();
  if (last && now - last.t < RC_DOUBLE_MS && Math.hypot(t.at.x - last.x, t.at.y - last.y) < RC_DOUBLE_PX) { p = last.p; t.lastTap = null; }
  else t.lastTap = { t: now, x: t.at.x, y: t.at.y, p };
  rcSetPointer(p);
  rcClick(p);
  rcFx('tap', rcClient(p));
}

// Held still: ready to drag (on a move) or to right-click (on letting go).
function rcHoldFired() {
  const t = rcTouch;
  if (t.g !== 'one' || !rcLive()) return;
  t.g = 'hold';
  if (rc.touchMode === 'trackpad' && t.p0) rcSetPointer(t.p0);
  navigator.vibrate?.(12);
  rcHoldRing('armed');
}

function rcDragStart() {
  const t = rcTouch;
  t.g = 'drag';
  rcHoldRing(null);
  const p = rc.touchMode === 'trackpad' ? rcPointerPoint() : rcPx(t.at.p);
  rcSetPointer(p);
  rcMove(p);
  rcButton(0, true, p);
  rcUi.cursor.classList.add('down');
}

function rcDragTo(x, y) {
  const p = rcDesk(x, y);
  if (!p) return;
  const q = rcPx(p);
  rcSetPointer(q);
  rcMove(q);
}

function rcDragEnd(p) {
  rcUi.cursor.classList.remove('down');
  if (p) rcButton(0, false, p);
  else rcRelease();
}

// Touch mode, dragging near an edge of a zoomed picture: the picture scrolls (so the drag can go past what's shown).
function rcDragEdge() {
  const t = rcTouch;
  if (t.edgeFrame || rc.fit === '1:1') return;
  const step = () => {
    t.edgeFrame = 0;
    if (t.g !== 'drag' || rc.touchMode !== 'touch' || !rcLive()) return;
    const f = [...t.fingers.values()][0];
    if (!f) return;
    const st = rcUi.stage.getBoundingClientRect();
    const zone = 40;
    const push = (pos, lo, hi) => (pos < lo + zone ? (lo + zone - pos) / zone : pos > hi - zone ? -(pos - (hi - zone)) / zone : 0);
    const kx = push(f.x, st.left, st.right);
    const ky = push(f.y, st.top, st.bottom);
    if (!kx && !ky) return;
    const ox = rcV.ox;
    const oy = rcV.oy;
    rcV.ox += kx * 12;
    rcV.oy += ky * 12;
    rcClampView();
    if (rcV.ox === ox && rcV.oy === oy) return; // (at the picture's edge)
    rcV.fit = false;
    rcApplyView();
    rcDragTo(f.x, f.y);
    t.edgeFrame = requestAnimationFrame(step);
  };
  t.edgeFrame = requestAnimationFrame(step);
}

// Two fingers. Trackpad: a scroll (both the same way) or a pinch (apart or together; it zooms around the pointer).
// Touch: they hold the picture (it moves and zooms with them).
function rcTwoMove(e) {
  const t = rcTouch;
  const two = t.two;
  const list = [...t.fingers.values()];
  if (list.length !== 2 || two.lifting) return;
  const [a, b] = list;
  const mid = rcMid(a, b);
  const dist = rcDist(a, b);
  two.hist.push([e.timeStamp, mid.x, mid.y]);
  if (two.hist.length > 12) two.hist.shift();
  const da = { x: a.x - a.sx, y: a.y - a.sy };
  const db = { x: b.x - b.sx, y: b.y - b.sy };
  const la = Math.hypot(da.x, da.y);
  const lb = Math.hypot(db.x, db.y);
  if (la > RC_TAP_SLOP || lb > RC_TAP_SLOP) two.moved = true;
  if (!two.kind) {
    // (as Chrome Remote Desktop tells them apart: both moving the same way is a scroll; apart, together, or one
    // finger alone is a pinch)
    if (Math.abs(dist / two.d0 - 1) > 0.2) two.kind = 'pinch';
    else if (la > RC_STILL && lb > RC_STILL) two.kind = da.x * db.x + da.y * db.y > 0 ? 'scroll' : 'pinch';
    else if (Math.max(la, lb) > RC_STILL * 3) two.kind = 'pinch';
    if (!two.kind) return;
    two.d0 = Math.max(1, dist); // (from here on)
    two.s0 = rcScale();
    two.last = mid;
    return;
  }
  if (two.kind === 'scroll') {
    rcScrollBy(mid.x - two.last.x, mid.y - two.last.y, null);
    two.last = mid;
    return;
  }
  if (rc.fit === '1:1') return; // (1:1 doesn't zoom)
  if (two.kind === 'pinch') {
    // Around the pointer (it's what the trackpad works on) while it's on screen; else around the fingers.
    const c = rc.pointer ? rcClient(rc.pointer) : null;
    const st = rcUi.stage.getBoundingClientRect();
    const on = c && c.x >= st.left && c.x <= st.right && c.y >= st.top && c.y <= st.bottom;
    rcZoomTo(two.s0 * dist / two.d0, on ? c.x : mid.x, on ? c.y : mid.y);
    two.last = mid;
    return;
  }
  // 'view' (touch): the point under the fingers stays under them; spreading them zooms (past a small dead zone).
  if (!two.zoomFrom && Math.abs(dist / two.d0 - 1) > 0.06) two.zoomFrom = { d: Math.max(1, dist), s: rcScale() };
  const s = two.zoomFrom ? two.zoomFrom.s * dist / two.zoomFrom.d : rcScale();
  if (two.anchor) rcPlace(two.anchor, mid.x, mid.y, s);
  two.last = mid;
}

// ---------------------------------------------------------------- scrolling (wheel) and its momentum

// Wheel units per CSS px of finger movement, so what's scrolled follows the finger: Chrome and Edge scroll 100 DIP a
// notch (120), and the PC's own scale for that screen came with its hello.
function rcWheelPerCss() {
  const mon = rc.monitors.find(x => x.id === rc.monitor);
  const k = mon?.scale > 0 ? mon.scale : 1;
  return (120 / (100 * k)) / Math.max(0.02, rcScale());
}

// Fingers moved by (dx, dy) CSS px: the page under them moves with them (fingers up: down the page). `p`: where (a
// point on the PC's screen); null: the pointer.
function rcScrollBy(dx, dy, p) {
  const k = rcWheelPerCss();
  rcScroll(-dx * k, -dy * k, p ? rcPx(p) : rcPointerPoint());
}

let rcFlinging = null;
function rcFlingStart(vx, vy, p) {
  rcFlingStop();
  const speed = Math.hypot(vx, vy);
  if (speed < RC_FLING.min) return;
  const k = Math.min(1, RC_FLING.max / speed);
  const f = rcFlinging = { vx: vx * k, vy: vy * k, p, at: performance.now(), start: performance.now(), frame: 0 };
  const step = now => {
    if (rcFlinging !== f || !rcLive()) return;
    const dt = Math.min(50, Math.max(0, now - f.at));
    f.at = now;
    const decay = Math.exp(-dt / RC_FLING.tau);
    const dx = f.vx * RC_FLING.tau * (1 - decay);
    const dy = f.vy * RC_FLING.tau * (1 - decay);
    f.vx *= decay;
    f.vy *= decay;
    rcScrollBy(dx, dy, f.p);
    if (Math.hypot(f.vx, f.vy) < 0.03 || now - f.start > 4000) { rcFlinging = null; return; }
    f.frame = requestAnimationFrame(step);
  };
  f.frame = requestAnimationFrame(step);
}
function rcFlingStop() {
  if (rcFlinging) cancelAnimationFrame(rcFlinging.frame);
  rcFlinging = null;
}

// ---------------------------------------------------------------- the pointer (trackpad mode), drawn here at once

// Where the pointer is on the PC's screen (its own pixels, fractions kept): where the PC said its cursor was, else the
// middle. The PC's own cursor follows in the picture a moment later.
function rcPointerPoint() {
  if (!rc.pointer) {
    const { w, h } = rcScreenSize();
    if (!w || !h) return null;
    rc.pointer = { x: Math.floor(w / 2), y: Math.floor(h / 2) };
  }
  return { x: Math.round(rc.pointer.x), y: Math.round(rc.pointer.y), inside: true };
}
function rcSetPointer(p) {
  if (!p) return;
  rc.pointer = { x: p.x, y: p.y };
  rcDrawPointer();
}

// A finger moved (dx, dy) CSS px at `speed`: the pointer moves as far on the picture, times a gain (0.6 slow, so a
// slow finger is precise, up to 2.5 quick, so a flick crosses the screen).
function rcNudgePointer(dx, dy, speed) {
  const { w, h } = rcScreenSize();
  const s = rcScale();
  if (!w || !h || !s || !rcPointerPoint()) return;
  const gain = speed <= 0.1 ? 0.6 : speed <= 0.4 ? 0.6 + (speed - 0.1) / 0.3 * 0.4 : speed <= 1.2 ? 1 + (speed - 0.4) / 0.8 : Math.min(2.5, 2 + (speed - 1.2) * 1.25);
  rc.pointer = {
    x: Math.min(w - 1, Math.max(0, rc.pointer.x + dx * gain / s)),
    y: Math.min(h - 1, Math.max(0, rc.pointer.y + dy * gain / s)),
  };
  rcFollowPointer();
  rcMove(rcPointerPoint());
}

function rcDrawPointer() {
  const c = rcUi.cursor;
  if (!c) return;
  const show = rc.state === 'live' && rc.touchMode === 'trackpad' && rcTouchUi() && Boolean(rc.hostHello) && Boolean(rc.pointer || rcPointerPoint());
  c.hidden = !show;
  if (!show) return;
  const q = rcClient(rc.pointer);
  const body = rcUi.stage.parentElement.getBoundingClientRect();
  if (q) c.style.transform = `translate(${q.x - body.left}px, ${q.y - body.top}px)`;
}

// Zoomed in, the picture follows the pointer (it stays clear of the edges, so there's room to see where it goes).
function rcFollowPointer() {
  if (!rc.pointer || rc.fit === '1:1' || !rcV.s) return rcDrawPointer();
  const v = rcV;
  if (v.W * v.s > v.SW + 0.5 || v.H * v.s > v.SH + 0.5) {
    const mx = Math.max(32, v.SW * RC_EDGE);
    const my = Math.max(32, v.SH * RC_EDGE);
    const px = v.ox + (rc.pointer.x + 0.5) * v.s;
    const py = v.oy + (rc.pointer.y + 0.5) * v.s;
    if (px < mx) v.ox += mx - px;
    else if (px > v.SW - mx) v.ox -= px - (v.SW - mx);
    if (py < my) v.oy += my - py;
    else if (py > v.SH - my) v.oy -= py - (v.SH - my);
    rcClampView();
    rcApplyView();
  } else rcDrawPointer();
}

// ---------------------------------------------------------------- feedback: taps, the hold ring

// A short ripple where something was clicked (`kind`: tap, tap small, right), at a point in the window. `keep`: it
// stays until removed (the hold ring).
function rcFx(kind, q, keep = false) {
  if (!q || !rcUi.fx) return null;
  const body = rcUi.stage.parentElement.getBoundingClientRect();
  const n = el('div', { class: `rc-fx ${kind}`, 'aria-hidden': 'true' });
  n.style.left = `${q.x - body.left}px`;
  n.style.top = `${q.y - body.top}px`;
  rcUi.fx.append(n);
  if (!keep) {
    n.addEventListener('animationend', () => n.remove());
    setTimeout(() => n.remove(), 1500); // (no animations: reduced motion)
  }
  return n;
}

// The hold ring: `start` (it fills while the finger stays still), `armed` (ready: move to drag, let go to right-click),
// null (gone). Trackpad mode: around the pointer; touch mode: around the finger.
function rcHoldRing(state) {
  const old = rcUi.hold;
  if (!state) { old?.remove(); rcUi.hold = null; return; }
  if (state === 'armed') { old?.classList.add('armed'); return; }
  old?.remove();
  const t = rcTouch;
  const q = rc.touchMode === 'trackpad' ? (rc.pointer && rcClient(rc.pointer)) : t.at && { x: t.at.x, y: t.at.y };
  rcUi.hold = q ? rcFx('hold', q, true) : null;
  if (rcUi.hold) rcUi.hold.style.setProperty('--hold', `${RC_HOLD_MS - 120}ms`); // (it starts filling 120 ms in: a tap shows none)
}

// ---------------------------------------------------------------- the picture: fit, zoom and pan

// The view: `s` = CSS px per pixel of the PC's screen (from "fit" up to rcMaxScale), `ox`/`oy` = where the picture's
// top-left corner is in the stage. Zoom and pan are this page's own (nothing goes to the PC). They last through layout
// changes (the keyboard opening, turning the phone, the video's size changing); another screen or "Zoom to fit" puts
// them back. W×H: the PC's screen; SW×SH: the stage; base: the fit scale the video element is laid out at.
const rcV = { s: 0, ox: 0, oy: 0, fit: true, W: 0, H: 0, SW: 0, SH: 0, base: 0, kb: false };

// The scale now (CSS px per pixel of the PC's screen), however the picture is laid out (1:1 too).
function rcScale() {
  const { w } = rcScreenSize();
  const r = rcUi.video?.getBoundingClientRect();
  return w && r && r.width > 0 ? r.width / w : 0;
}

// Up to 4 of this screen's pixels for one of the PC's (and at least 3× fit).
const rcMaxScale = fit => Math.min(fit * 12, Math.max(fit * 3, 4 / (window.devicePixelRatio || 1)));

// A point in the window → on the PC's screen, in its pixels with fractions (outside the picture too).
function rcDesk(clientX, clientY) {
  const { w, h } = rcScreenSize();
  const r = rcUi.video.getBoundingClientRect();
  if (!w || !h || r.width < 1 || r.height < 1) return null;
  const x = ((clientX - r.left) / r.width) * w;
  const y = ((clientY - r.top) / r.height) * h;
  return { x, y, inside: x >= 0 && x < w && y >= 0 && y < h };
}
// …and back (the middle of that pixel).
function rcClient(p) {
  const { w, h } = rcScreenSize();
  const r = rcUi.video?.getBoundingClientRect();
  if (!p || !w || !h || !r || r.width < 1) return null;
  return { x: r.left + ((p.x + 0.5) / w) * r.width, y: r.top + ((p.y + 0.5) / h) * r.height };
}
// A point for the PC: whole pixels, on the screen.
function rcPx(p) {
  const { w, h } = rcScreenSize();
  if (!p || !w || !h) return null;
  return { x: Math.min(w - 1, Math.max(0, Math.floor(p.x))), y: Math.min(h - 1, Math.max(0, Math.floor(p.y))), inside: true };
}

function rcClampView() {
  const v = rcV;
  const pw = v.W * v.s;
  const ph = v.H * v.s;
  v.ox = pw <= v.SW ? (v.SW - pw) / 2 : Math.min(0, Math.max(v.SW - pw, v.ox));
  v.oy = ph <= v.SH ? (v.SH - ph) / 2 : Math.min(0, Math.max(v.SH - ph, v.oy));
}

function rcApplyView() {
  const v = rcV;
  if (!v.base) return;
  rcUi.video.style.transform = `translate(${v.ox}px, ${v.oy}px) scale(${v.s / v.base})`;
  const zoom = v.s / v.base;
  if (Math.abs(zoom - rc.zoom) > 0.01) rcPicSoon(); // (zoomed in, the PC sends more of its pixels: 1.8)
  rc.zoom = zoom;
  rcFastDraw(false);
  rcDrawPointer();
}

// ---------------------------------------------------------------- the picture drawn here (Windows app 1.17 + the viewer)

// (1.17) Where the browser can, this page draws the picture itself: each frame as it's decoded, into a
// "desynchronized" canvas over the stage, at the stage's size in device pixels (one scaled by CSS reached the screen
// late now and then). That skips the browser's own wait to show a video frame (the user's desk: "shown 25" of 83 ms).
// On Desktop's 143 Hz screen, a change reached the screen 43 ms after it was made instead of 54 (median of 60, the
// screen's own capture watching), and never later; in a web view hosted as the Windows app's viewer is, 34 against 54
// (Beam-dev\research\rc-display). The <video> stays, hidden: its frame callbacks keep the delay's figures, and it's
// the picture again in 1:1, on a phone or tablet, or with "Show each frame as it arrives" off (the Picture panel).
const rcFast = { on: false, gen: 0, reader: null, clone: null, frame: null, g: null, key: '', drawn: new Map(), first: false };

const rcFastWanted = () => typeof MediaStreamTrackProcessor === 'function' && rc.pic.fast !== false && rc.fit !== '1:1' && !rcPhone();

// On or off for the session's track (`ontrack`, Fit/1:1, the setting); the frames come from a copy of the track.
async function rcFastStart(track) {
  rcFastStop();
  if (!track || track.readyState === 'ended' || !rcFastWanted()) return;
  const gen = rcFast.gen;
  let reader;
  try {
    rcFast.clone = track.clone();
    reader = rcFast.reader = new MediaStreamTrackProcessor({ track: rcFast.clone }).readable.getReader();
  } catch {
    rcFastStop();
    return;
  }
  rcFastShow(true);
  for (;;) {
    let r;
    try { r = await reader.read(); } catch { break; }
    if (r.done) break;
    if (gen !== rcFast.gen) { r.value.close(); break; }
    rcFast.frame?.close();
    rcFast.frame = r.value;
    rcFastDraw(true);
  }
  if (gen === rcFast.gen) rcFastStop();
}

function rcFastStop() {
  rcFast.gen++;
  try { rcFast.reader?.cancel(); } catch {}
  try { rcFast.clone?.stop(); } catch {}
  try { rcFast.frame?.close(); } catch {}
  Object.assign(rcFast, { reader: null, clone: null, frame: null, key: '', first: false });
  rcFast.drawn.clear();
  rcFastShow(false);
}

function rcFastShow(on) {
  rcFast.on = on;
  rcUi.stage?.classList.toggle('fast', on);
}

// The last frame, where rcV puts the picture (`fresh`: a new frame, else the view changed).
function rcFastDraw(fresh) {
  const f = rcFast.frame;
  const v = rcV;
  if (!rcFast.on || !f || !v.base) return;
  const c = rcUi.canvas;
  const d = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(v.SW * d));
  const H = Math.max(1, Math.round(v.SH * d));
  if (c.width !== W || c.height !== H) {
    c.width = W;
    c.height = H;
    c.style.width = `${W / d}px`; // (exactly its pixels: never scaled)
    c.style.height = `${H / d}px`;
  }
  const g = rcFast.g || (rcFast.g = c.getContext('2d', { desynchronized: true, alpha: false }));
  if (!g) return;
  const x = v.ox * d, y = v.oy * d, w = v.W * v.s * d, h = v.H * v.s * d;
  const key = `${W}x${H} ${x} ${y} ${w} ${h}`;
  if (key !== rcFast.key) { g.fillStyle = getComputedStyle(rcUi.root).backgroundColor || '#000'; g.fillRect(0, 0, W, H); rcFast.key = key; } // (bars as the page's)
  g.imageSmoothingQuality = 'high';
  g.drawImage(f, x, y, w, h);
  if (!fresh) return;
  const now = performance.now();
  const rtp = rcFastRtp(f);
  if (rtp != null) {
    rcFast.drawn.set(rtp, now);
    if (rcFast.drawn.size > 120) rcFast.drawn.delete(rcFast.drawn.keys().next().value);
  }
  if (!rcFast.first) { rcFast.first = true; rcStartMark('picture', now); }
  const p = rc.probe;
  if (p && !p.frame && !p.fast && rcProbeColor(f, rc.probeRect || { x: 0, y: 0, size: 32 }) === (p.n % 2 ? 'green' : 'magenta')) {
    // (its receive time and decoding come with the video's own callback for the same frame: rcWatchFrames)
    p.fast = { shown: now, rtp };
  }
}

function rcFastRtp(f) {
  try { const r = f.metadata?.().rtpTimestamp; return Number.isFinite(r) ? r : null; } catch { return null; }
}

// Zoom to scale `s` keeping the point at (cx, cy) in the window where it is.
function rcZoomTo(s, cx, cy) {
  if (!rcV.base || rc.fit === '1:1') return;
  const p = rcDesk(cx, cy);
  if (p) rcPlace(p, cx, cy, s);
}

// The PC's point `p` at (cx, cy) in the window, at scale `s` (clamped between fit and the most).
function rcPlace(p, cx, cy, s) {
  const v = rcV;
  if (!v.base || rc.fit === '1:1') return;
  const st = rcUi.stage.getBoundingClientRect();
  v.s = Math.min(rcMaxScale(v.base), Math.max(v.base, s));
  v.fit = v.s <= v.base * 1.02;
  if (v.fit) v.s = v.base;
  v.ox = cx - st.left - p.x * v.s;
  v.oy = cy - st.top - p.y * v.s;
  rcClampView();
  rcApplyView();
}

function rcZoomToFit() {
  if (!rcV.base) return;
  rcV.s = rcV.base;
  rcV.fit = true;
  rcClampView();
  rcApplyView();
  rcRenderBar();
}

// ---------------------------------------------------------------- the picture's size: Fit or 1:1

function rcLayout() {
  const v = rcUi.video;
  const stage = rcUi.stage;
  if (!v) return;
  if (rc.track && rcFast.on !== rcFastWanted()) { if (rcFast.on) rcFastStop(); else rcFastStart(rc.track); } // (1.17: not in 1:1)
  const one = rc.fit === '1:1' && !rcPhone();
  stage.classList.toggle('one-to-one', one);
  if (one) {
    // One of the PC's pixels on one of this screen's; the stage scrolls.
    const d = window.devicePixelRatio || 1;
    v.style.width = v.videoWidth ? `${v.videoWidth / d}px` : '';
    v.style.height = v.videoHeight ? `${v.videoHeight / d}px` : '';
    v.style.transform = '';
    rcV.base = rcV.s = 0;
    rc.zoom = 1;
    return rcDrawPointer();
  }
  const { w: W, h: H } = rcScreenSize();
  const SW = stage.clientWidth;
  const SH = stage.clientHeight;
  if (!W || !H || SW < 1 || SH < 1) return;
  const fit = Math.min(SW / W, SH / H);
  const old = { ...rcV };
  const same = old.s > 0 && old.W === W && old.H === H;
  // What stays in view: the pointer (or the last tap), else what was in the middle, at the same place in the stage.
  const focus = !same ? null : rc.pointer ? { x: rc.pointer.x + 0.5, y: rc.pointer.y + 0.5 } : { x: (old.SW / 2 - old.ox) / old.s, y: (old.SH / 2 - old.oy) / old.s };
  // The soft keyboard opening (the same width, less height, typing): the picture keeps its size rather than shrinking
  // to fit above the keyboard, and what's typed into stays in view.
  const opening = same && SW === old.SW && SH < old.SH && document.activeElement === rcUi.sink;
  Object.assign(rcV, { W, H, SW, SH, base: fit });
  v.style.width = `${W * fit}px`;
  v.style.height = `${H * fit}px`;
  if (!same) Object.assign(rcV, { s: fit, fit: true, kb: false }); // (the first picture, another screen)
  else if (opening) Object.assign(rcV, { s: Math.max(fit, old.s), kb: true });
  else Object.assign(rcV, { s: old.fit ? fit : Math.max(fit, Math.min(rcMaxScale(fit), old.s)), kb: false });
  if (!rcV.kb) rcV.fit = rcV.s <= fit * 1.02;
  if (rcV.fit && !rcV.kb) rcV.s = fit;
  if (focus) {
    rcV.ox = ((old.ox + focus.x * old.s) / old.SW) * SW - focus.x * rcV.s;
    rcV.oy = ((old.oy + focus.y * old.s) / old.SH) * SH - focus.y * rcV.s;
  }
  rcClampView();
  rcApplyView();
  // (only when the stage changed size: a new video size, as WebRTC adapts, never moves the picture under the fingers)
  if (rc.pointer && (SW !== old.SW || SH !== old.SH)) rcFollowPointer();
}

// ---------------------------------------------------------------- the bar

function rcRenderBar() {
  if (!rcUi.bar) return;
  rcUi.name.textContent = rc.name || 'Remote screen';
  rcRenderChip();
  rcRenderTools();
}

// The chip: frames and bits as they arrive here, the codec, the round trip; the PC's encoder in its tooltip.
function rcRenderChip() {
  const live = rc.state === 'live' || rc.state === 'reconnecting';
  const s = rc.stats;
  const parts = [];
  if (s?.fps != null) parts.push(`${s.fps} fps`);
  if (s?.kbps != null) parts.push(s.kbps >= 1000 ? `${(s.kbps / 1000).toFixed(1)} Mbps` : `${s.kbps} kbps`);
  const codec = s?.codec || rc.hostCodec;
  if (codec) parts.push(codec);
  const lag = rcLag();
  if (lag != null) parts.push(`${lag} ms`);
  if (rc.path?.via === 'relay') parts.push('relayed');
  if (rc.fitting) parts.splice(0, parts.length, 'Fitting the PC to this screen…');
  rcUi.chip.hidden = !live || !parts.length;
  rcUi.chip.textContent = parts.join(' · ');
  rcUi.chip.title = [
    s?.w && s?.h ? `${s.w}×${s.h}` : '',
    rc.profile && `${rcPicLabel('mode', rc.pic.mode)}${rc.pic.mode === 'auto' ? ` (${rcPicLabel('mode', rc.profile).toLowerCase()} now)` : ''}`,
    rc.encoder && `Encoder: ${rc.encoder}`,
    rc.qlr && rc.qlr !== 'none' && `Limited by ${rc.qlr === 'cpu' ? 'the PC’s processor' : rc.qlr === 'bandwidth' ? 'the network' : rc.qlr}`,
    rc.qualityInfo?.fps && `Up to ${rc.qualityInfo.fps} fps${rc.qualityInfo.kbps ? `, ${Math.round(rc.qualityInfo.kbps / 1000)} Mbps` : ''}`,
    s?.picMs != null && `About ${lag} ms from a touch here to the PC’s answer on this screen`,
    rcPathText(),
  ].filter(Boolean).join(' · ');
}

// The tools, made again only when what they show changes (a click mid-press survives the stats ticking).
function rcRenderTools() {
  const live = rc.state === 'live' || rc.state === 'reconnecting';
  const phone = rcPhone();
  const kb = document.activeElement === rcUi.sink && rcTouchUi();
  const sig = JSON.stringify([rc.state, phone, live && [rc.monitors.map(x => x.name), rc.monitor, rc.fit, rc.quality, rc.pic.mode, rc.caps.includes('settings'), rc.clip, rcClipWaiting(),
    rc.touchMode, rcTouchUi(), kb, Boolean(document.fullscreenElement), document.fullscreenEnabled]]);
  rcRenderKeyStrip();
  if (sig === rcUi.toolsSig) return;
  rcUi.toolsSig = sig;
  const tools = [];
  const btn = (label, ic, onclick, { pressed, cls = '', title } = {}) => el('button', {
    class: `rc-tool ${cls}`, type: 'button', title: title || label, 'aria-label': label, 'data-tool': ic,
    ...(pressed !== undefined && { 'aria-pressed': String(Boolean(pressed)) }),
    onclick: e => { onclick(e); if (!rcUi.pop && $('#menu').hidden && !rcTouchUi()) rcFocusSink(); },
  }, icon(ic), el('span', { class: 'rc-tool-label' }, label));
  const mode = () => btn(rc.touchMode === 'trackpad' ? 'Trackpad' : 'Touch', rc.touchMode === 'trackpad' ? 'pointer' : 'touch',
    () => rcSetTouchMode(rc.touchMode === 'trackpad' ? 'touch' : 'trackpad'),
    { cls: 'mode', title: rc.touchMode === 'trackpad' ? 'Trackpad: one finger moves the pointer, a tap clicks (tap for touch)' : 'Touch: tap where you want to click, one finger scrolls (tap for trackpad)' });
  if (live && phone) {
    // A phone: the mode (labelled: it decides what a finger does), the keyboard, and the rest under ⋯.
    tools.push(mode());
    tools.push(btn('Keyboard', 'keyboard', () => rcShowKeyboard(), { pressed: kb, title: kb ? 'Hide the keyboard' : 'Show the keyboard' }));
    tools.push(btn('More', 'more', e => rcMoreMenu(e.currentTarget), { cls: rcClipWaiting() ? 'attn' : '', title: 'Screens, quality, keys, clipboard, zoom and help' }));
  } else if (live) {
    const mon = rc.monitors.find(x => x.id === rc.monitor);
    if (rc.monitors.length > 1) tools.push(btn(mon?.name || 'Screen', 'monitor', e => rcMonitorMenu(e.currentTarget), { title: 'Choose a screen' }));
    tools.push(btn(rc.fit === 'fit' ? 'Fit' : '1:1', rc.fit === 'fit' ? 'zoom-out' : 'zoom-in', () => { rc.fit = rc.fit === 'fit' ? '1:1' : 'fit'; rcLayout(); rcRenderBar(); rcSendPic(); },
      { title: rc.fit === 'fit' ? 'Fit to the window (click for 1:1)' : 'One to one (click to fit)' }));
    // (1.8) The picture's settings: the mode on the button, everything else (fit, size, frame rate…) behind it.
    const shown = rc.caps.includes('settings') ? rc.pic.mode : rc.quality;
    tools.push(btn(rcPicLabel('mode', shown), 'gear', () => rcShowSettings(), { title: 'Picture settings: quality, fitting the PC to this screen, size, frame rate, data limit, codec, details' }));
    tools.push(btn('Keys', 'keyboard', e => rcKeysMenu(e.currentTarget), { title: 'Send keys (Windows key, Alt+Tab, F-keys…)' }));
    tools.push(btn('Clipboard', 'clip', () => rcSetClip(!rc.clip), { pressed: rc.clip, cls: rc.clipPending ? 'attn' : '', title: rc.clip ? 'Clipboard sync is on (click to turn it off)' : 'Clipboard sync is off (click to share the clipboard both ways)' }));
    if (rcClipWaiting()) tools.push(btn('Copy', 'copy', rcCopyFromPc, { title: 'Copy what was copied on the PC' }));
    if (rcTouchUi()) {
      // (a PC with a touch screen too)
      tools.push(mode());
      tools.push(btn('Keyboard', 'keyboard', () => rcShowKeyboard(), { pressed: kb, title: 'Show the keyboard' }));
    }
    if (document.fullscreenEnabled) tools.push(btn(document.fullscreenElement ? 'Exit full screen' : 'Full screen', document.fullscreenElement ? 'shrink' : 'expand', rcToggleFullscreen));
  }
  if (rc.state !== 'ended') tools.push(btn('Disconnect', 'x', rcDisconnect, { cls: 'danger' }));
  rcUi.tools.replaceChildren(...tools);
}

function rcCopyFromPc() {
  if (rc.lastClipImg) {
    rcWriteImage(rc.lastClipImg).then(ok => { rc.clipPending = !ok; if (!ok) toast('Couldn’t copy the picture here.'); rcRenderBar(); });
    return;
  }
  writeClipboard(rc.lastClip).then(ok => { rc.clipPending = !ok; rcRenderBar(); });
}

// A phone's ⋯: everything that isn't used every minute.
function rcMoreMenu(anchor) {
  if (!rcLive() && rc.state !== 'live') return;
  const zoomed = rc.zoom > 1.02;
  openMenu([
    { label: 'How to control', icon: 'help', action: () => rcShowHelp() },
    zoomed && { label: 'Zoom to fit', icon: 'zoom-out', action: rcZoomToFit },
    'sep',
    ...(rc.monitors.length > 1 ? rc.monitors.map(mon => ({ label: `${mon.name}${mon.primary ? ' (main)' : ''}`, icon: mon.id === rc.monitor ? 'check' : 'monitor', action: () => rcSwitchMonitor(mon) })) : []),
    rc.monitors.length > 1 && 'sep',
    { label: `Picture: ${rcPicLabel('mode', rc.caps.includes('settings') ? rc.pic.mode : rc.quality)}…`, icon: 'gear', action: () => rcShowSettings() },
    'sep',
    { label: 'Send keys (Windows key, Alt+Tab, F-keys…)', icon: 'keyboard', action: () => rcKeysMenu(anchor) },
    { label: rc.clip ? 'Clipboard sync is on' : 'Clipboard sync is off', icon: rc.clip ? 'check' : 'clip', action: () => rcSetClip(!rc.clip) },
    rcClipWaiting() && { label: 'Copy what was copied on the PC', icon: 'copy', action: rcCopyFromPc },
  ], anchor, { label: 'More' });
}

// Trackpad or touch (remembered here for next time). The first time each is used: how it works.
function rcSetTouchMode(mode) {
  if (mode === rc.touchMode) return;
  rcTouchReset();
  if (rc.buttons.size) rcRelease();
  rc.touchMode = mode;
  store.set('beam.rc.touchMode', mode);
  rcDrawPointer();
  rcRenderBar();
  if (!rcMaybeHelp()) toast(mode === 'trackpad' ? 'Trackpad: one finger moves the pointer, tap to click.' : 'Touch: tap where you want to click, one finger scrolls.');
}

// ---------------------------------------------------------------- the picture's settings and the PC's screen (1.8)

// Remembered per PC here (a choice of this page's, nothing of a session). fitPc null: the default (on, but not on a
// phone or tablet, where a PC's desktop squeezed to fit would be tiny anyway).
function rcLoadPic() {
  const p = store.json(`beam.rc.pic.${RC_ID}`, null);
  const q = p && typeof p === 'object' ? p : {};
  const one = key => (RC_PIC[key].some(([v]) => v === q[key]) ? q[key] : RC_PIC[key][0][0]);
  return { mode: one('mode'), size: one('size'), fps: one('fps'), kbps: one('kbps'), codec: one('codec'), fitPc: typeof q.fitPc === 'boolean' ? q.fitPc : null, fitScale: q.fitScale === true, details: q.details === true,
    pointer: q.pointer !== false, fast: q.fast !== false };
}
const rcPicLabel = (key, v) => RC_PIC[key].find(([x]) => x === v)?.[1] || String(v);
// (1.12.7) Off unless chosen: a new resolution makes some of the PC's apps (Windows' Settings) lay out wrong until
// they're reopened, and a mode of another shape than its monitor's is blurrier there.
const rcFitOn = () => rc.pic.fitPc === true;

function rcSetPic(key, value) {
  rc.pic[key] = value;
  store.setJson(`beam.rc.pic.${RC_ID}`, rc.pic);
  if (key === 'fitPc' || key === 'fitScale') rcSendFit();
  else if (key === 'pointer') rcSendPointer();
  else if (key === 'fast') rcFastStart(rc.track); // (1.17: this page's own)
  else if (key !== 'details') rcSendPic();
  rcRenderBar();
  rcRenderDetails();
}

// (the old toggle's name, for a PC before 1.8: its two modes)
function rcSetQuality(q) { rcSetPic('mode', q); }

// The picture area here in physical pixels, zoom included (zoomed in, more of the PC's pixels are worth sending).
function rcArea(zoomed) {
  const st = rcUi.stage;
  const d = window.devicePixelRatio || 1;
  if (!st || st.clientWidth < 1 || st.clientHeight < 1) return null;
  const z = zoomed ? Math.max(1, rc.zoom || 1) : 1;
  return { w: Math.round(st.clientWidth * d * z), h: Math.round(st.clientHeight * d * z), dpr: Math.round(d * 1000) / 1000 };
}

// The settings to the PC: all of them to a 1.8 one, Sharp text or Smooth motion to an older one. A new picture area
// goes only when it changed by over 15% (resizing and zooming would send one a frame).
function rcSendPic() {
  if (!rc.verified || !rc.hostHello) return;
  if (!rc.caps.includes('settings')) {
    const q = rc.pic.mode === 'motion' ? 'motion' : 'text';
    if (q !== rc.quality && rcSend('ctl', { t: 'quality', mode: q })) { rc.quality = q; rc.qualityInfo = null; rcRenderBar(); }
    return;
  }
  const a = rc.fit === '1:1' && !rcPhone() ? null : rcArea(true); // (1:1: the PC's full size is shown anyway)
  const net = navigator.connection?.type === 'cellular' ? 'cellular' : '';
  const m = { t: 'settings', mode: rc.pic.mode, size: rc.pic.size, vw: a ? Math.min(16384, a.w) : 0, vh: a ? Math.min(16384, a.h) : 0, fps: rc.pic.fps, kbps: rc.pic.kbps, codec: rc.pic.codec, net };
  const was = rc.picSent;
  const near = (x, y) => (!x && !y) || (x > 0 && y > 0 && Math.abs(x - y) / y < 0.15);
  if (was && ['mode', 'size', 'fps', 'kbps', 'codec', 'net'].every(k => was[k] === m[k]) && near(m.vw, was.vw) && near(m.vh, was.vh)) return;
  if (rcSend('ctl', m)) rc.picSent = m;
}

// After resizing, full screen or zooming has settled: the fit and the picture's size again.
function rcPicSoon() {
  rcTimer('pic', () => { rcSendFit(); rcSendPic(); }, 1200);
}

// Fit the PC to this screen: it takes the size its monitor has that suits this picture area best (and, with "Bigger text"
// on, 1.11.4, the scaling that shows its interface at the size of this device's own: off by default, since a change of
// scaling freezes apps there for a moment and closed one); it goes back when the session ends or Fit is turned off.
function rcSendFit() {
  if (!rc.verified || !rc.hostHello || !rc.caps.includes('fit')) return;
  if (!rcFitOn()) {
    if ((rc.fitSent || rc.fitted) && rcSend('ctl', { t: 'fit', on: false })) rc.fitSent = '';
    return;
  }
  const a = rcArea(false);
  if (!a || a.w < 200 || a.h < 200) return;
  const scale = rc.pic.fitScale === true;
  const key = `${a.w}x${a.h}@${a.dpr}${scale ? '+scale' : ''}`;
  if (key === rc.fitSent || !rcSend('ctl', { t: 'fit', on: true, w: a.w, h: a.h, dpr: a.dpr, scale })) return;
  rc.fitSent = key;
  rc.fitting = true; // (input waits for the PC's new sizes)
  rcRelease();
  rcRender();
  rcTimer('fit', () => { rc.fitting = false; rcRender(); }, RC_FIT_MS);
}

// Whether this page can be seen: a hidden one gets no frames (the PC encodes and sends nothing meanwhile).
function rcVideo(on) {
  if (!rc.verified || !rc.caps.includes('video') || rc.videoOff === !on) return;
  if (rcSend('ctl', { t: 'video', on })) rc.videoOff = !on;
}

function rcShowSettings() {
  const n = rc.name || 'the PC';
  const full = rc.caps.includes('settings');
  const pick = (key, label, list, value) => {
    const box = el('select', { 'aria-label': label, onchange: () => rcSetPic(key, typeof list[0][0] === 'number' ? Number(box.value) : box.value) },
      ...list.map(([v, text]) => el('option', { value: String(v), selected: v === value }, text)));
    return field(label, box);
  };
  const modes = full ? RC_PIC.mode : RC_PIC.mode.filter(([v]) => RC_MODES.includes(v));
  const radios = el('div', { class: 'rc-modes', role: 'radiogroup', 'aria-label': 'Quality' }, ...modes.map(([v, label, more]) => {
    const input = el('input', { type: 'radio', name: 'rc-mode', value: v, checked: v === (full ? rc.pic.mode : rc.quality) });
    input.addEventListener('change', () => { if (input.checked) rcSetPic('mode', v); });
    return el('label', { class: 'check' }, input, el('span', {}, label, el('small', { class: 'muted block' }, more)));
  }));
  const body = [
    rc.caps.includes('fit')
      ? toggle(`Fit ${n} to this screen`, rcFitOn(), v => rcSetPic('fitPc', v),
        { hint: `Off: ${n}’s display stays as it is, and the picture fits this window. On: its resolution changes to suit this screen (its own monitor shows it too) and goes back when you disconnect; some apps, like Windows’ Settings, lay out wrong until they’re reopened.` })
      : note(`Fitting ${n} to this screen needs Beam 1.8 or later on it.`),
    rc.caps.includes('fit') && (rc.caps.includes('fit-scale')
      ? toggle('Bigger text: change its scaling too', rc.pic.fitScale === true, v => rcSetPic('fitScale', v),
        { hint: `With Fit on, ${n}’s display scaling changes too, so its text shows at the size of this device’s own. Some apps on ${n} freeze for a moment, or close, when its scaling changes.` })
      : note(`On ${n}’s Beam (before 1.11.4) Fit changes its scaling too.`)),
    field('Quality', radios),
    full && pick('size', 'Picture size', RC_PIC.size, rc.pic.size),
    full && pick('fps', 'Frame rate', RC_PIC.fps, rc.pic.fps),
    full && pick('kbps', 'Data limit', RC_PIC.kbps, rc.pic.kbps),
    full && pick('codec', 'Codec', RC_PIC.codec, rc.pic.codec),
    !full && note(`More settings (picture size, frame rate, data limit, codec) need Beam 1.8 or later on ${n}.`),
    rc.caps.includes('cursor') && !rcPhone() && toggle('Draw the pointer here', rc.pic.pointer !== false, v => rcSetPic('pointer', v),
      { hint: `Your pointer moves at once, in ${n}’s shape (arrow, text, hand…), and ${n} hides its own while you control it. Turn this off while someone is watching ${n}’s own screen.` }),
    typeof MediaStreamTrackProcessor === 'function' && !rcPhone() && toggle('Show each frame as it arrives', rc.pic.fast !== false, v => rcSetPic('fast', v),
      { hint: 'Beam draws the picture itself, without the browser’s own wait to show a video frame: less delay. Turn it off if the picture tears or stutters here.' }),
    toggle('Show details', rc.pic.details, v => rcSetPic('details', v), { hint: 'Picture size, frames, data rate, codec, delay and losses, over the picture.' }),
    rc.caps.includes('probe') && field('Delay', el('div', {},
      el('button', { class: 'btn', type: 'button', disabled: Boolean(rc.measuring), onclick: () => { $('#genDlg').close('ok'); rcMeasure(); } }, 'Measure the delay'),
      el('small', { class: 'muted block' }, `From a click to the picture, step by step (in the details). A small square in the top left corner of ${n}’s screen changes colour a few times meanwhile.`))),
    note(`Kept for ${n} on this device. They apply at once.`),
  ];
  const done = el('button', { class: 'btn primary', type: 'button', onclick: () => $('#genDlg').close('ok') }, 'Done');
  rcRelease();
  openDialog({ title: 'Picture', body, buttons: [done], className: 'rc-settings', onClose: () => { if (!rcTouchUi()) rcFocusSink(); } });
}

// The details over the picture (Show details): what is sent and received, and what limits it.
function rcRenderDetails() {
  const box = rcUi.details;
  if (!box) return;
  const live = rc.state === 'live' || rc.state === 'reconnecting';
  box.hidden = !rc.pic.details || !live;
  if (box.hidden) return;
  const s = rc.stats || {};
  const h = rc.host;
  const rate = k => (k == null ? '' : k >= 1000 ? `${(k / 1000).toFixed(1)} Mbps` : `${Math.round(k)} kbps`);
  const mon = rc.monitors.find(x => x.id === rc.monitor);
  const rtt = rc.rtt ?? rc.pair?.rtt;
  const hw = v => (/MediaFoundation|Accelerat|Hardware|NVENC|QuickSync|AMF|D3D/i.test(v) ? ' (hardware)' : '');
  const rows = [
    ['Mode', rc.caps.includes('settings') ? `${rcPicLabel('mode', rc.pic.mode)}${rc.pic.mode === 'auto' && rc.profile ? ` · ${rcPicLabel('mode', rc.profile).toLowerCase()} now` : ''}` : rcPicLabel('mode', rc.quality)],
    ['Screen', mon ? `${mon.w}×${mon.h} at ${Math.round(mon.scale * 100)}%${rc.fitted ? ', fitted to this one' : ''}` : ''],
    ['Picture', s.w && s.h ? `${s.w}×${s.h}${h?.down > 1.01 ? ` (sent at 1/${h.down.toFixed(2).replace(/\.?0+$/, '')})` : ''}` : ''],
    ['Frames', s.fps != null ? `${s.fps} fps${h?.maxFps ? `, up to ${h.maxFps}` : ''}` : ''],
    ['Data', s.kbps != null ? `${rate(s.kbps)}${h?.maxKbps ? `, limit ${rate(h.maxKbps)}` : ''}${h?.avail ? `, network about ${rate(h.avail)}` : ''}` : ''],
    ['Codec', [s.codec || rc.hostCodec, rc.encoder && `encoder ${rc.encoder}${hw(rc.encoder)}`, rc.decoder && `decoder ${rc.decoder}`].filter(Boolean).join(' · ')],
    ['Delay', [s.picMs != null && `about ${rcLag()} ms from a touch to the picture`, s.picMs != null && `${s.picMs} ms from the PC’s screen to this one`,
      rtt != null && `${rtt} ms round trip`, s.jitterMs != null && `${s.jitterMs} ms buffered here`, h?.lost != null && `${h.lost}% lost`].filter(Boolean).join(' · ')],
    ['Measured', rcMeasuredText()],
    ['Start', rcStartText()],
    ['Limited by', rc.qlr && rc.qlr !== 'none' ? (rc.qlr === 'cpu' ? 'the PC’s processor' : rc.qlr === 'bandwidth' ? 'the network' : rc.qlr) : 'nothing'],
    ['Path', rcPathText()],
  ].filter(([, v]) => v);
  box.replaceChildren(...rows.map(([k, v]) => el('div', {}, el('b', {}, k), el('span', {}, v))));
}

function rcSetClip(on) {
  rc.clip = on;
  rc.clipPending = false;
  rc.lastClip = '';
  rc.lastClipImg = null;
  rc.clipIn = null;
  rcSend('ctl', { t: 'clip', on });
  toast(on ? 'Clipboard sync is on: what you copy on either side can be pasted on the other.' : 'Clipboard sync is off.');
  rcRenderBar();
}

// Another screen: the PC starts capture over as a new connection (a new offer), then says hello again.
function rcMonitorMenu(anchor) {
  openMenu(rc.monitors.map(mon => ({
    label: `${mon.name}${mon.primary ? ' (main)' : ''} · ${mon.w}×${mon.h}`, icon: mon.id === rc.monitor ? 'check' : 'monitor',
    action: () => rcSwitchMonitor(mon),
  })), anchor, { label: 'Screens' });
}

function rcSwitchMonitor(mon) {
  if (mon.id === rc.monitor || !rcLive()) return;
  if (!rcSend('ctl', { t: 'monitor', id: mon.id })) return;
  rcRelease();
  rc.switching = { id: mon.id, name: mon.name };
  rcRender();
  rcTimer('switch', () => { if (rc.switching) rcFail('failed'); }, RC_OFFER_MS);
}

// The Keys menu: what a browser can't send by itself. Ctrl+Alt+Del can't be sent at all (Windows only takes it from
// a real keyboard), and the PC locks itself when asked (the session ends).
const RC_KEYS = [
  ['Windows key', ['MetaLeft']],
  ['Alt+Tab', ['AltLeft', 'Tab']],
  ['Ctrl+Esc', ['ControlLeft', 'Escape']],
  ['Ctrl+Shift+Esc', ['ControlLeft', 'ShiftLeft', 'Escape']],
  ['Print Screen', ['PrintScreen']],
];

function rcKeysMenu(anchor) {
  if (rcUi.pop) return rcClosePop();
  const fn = Array.from({ length: 12 }, (_, i) => el('button', { class: 'rc-fkey', type: 'button', onclick: () => { rcCombo([`F${i + 1}`]); rcClosePop(); } }, `F${i + 1}`));
  const pop = el('div', { class: 'rc-pop menu', role: 'menu', 'aria-label': 'Send keys' },
    ...RC_KEYS.map(([label, codes]) => el('button', { class: 'menu-item', type: 'button', role: 'menuitem', onclick: () => { rcCombo(codes); rcClosePop(); } }, icon('keyboard'), el('span', {}, label))),
    el('div', { class: 'rc-fkeys' }, ...fn),
    el('button', { class: 'menu-item', type: 'button', role: 'menuitem', 'data-key': 'lock', title: 'Locks the PC (like the Windows key + L); the session ends',
      onclick: () => { rcClosePop(); if (rcLive()) rcSend('ctl', { t: 'lock' }); } }, icon('lock'), el('span', {}, 'Lock this PC')),
    el('button', { class: 'menu-item', type: 'button', role: 'menuitem', disabled: true, title: 'Windows takes Ctrl+Alt+Del only from a real keyboard: use Remote Desktop for it' },
      icon('shield'), el('span', {}, 'Ctrl+Alt+Del'), el('kbd', {}, 'needs Remote Desktop')));
  rcUi.root.append(pop);
  rcUi.pop = pop;
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.min(r.bottom + 4, innerHeight - pop.offsetHeight - 8)}px`;
  pop.style.left = `${Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth))}px`;
  if (lastPointer !== 'touch') pop.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  const close = e => {
    if (e.type === 'keydown') { if (e.key === 'Escape') { e.preventDefault(); rcClosePop(); } return; }
    if (!pop.contains(e.target) && !anchor.contains(e.target)) rcClosePop();
  };
  document.addEventListener('pointerdown', close, true);
  document.addEventListener('keydown', close, true);
  rcUi.popClose = () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', close, true); };
}

function rcClosePop() {
  rcUi.popClose?.();
  rcUi.pop?.remove();
  rcUi.pop = rcUi.popClose = null;
  if (!rcTouchUi()) rcFocusSink();
}

// The phone's key strip: Esc, Tab, sticky Ctrl/Alt/Shift/Win, the arrows, Delete (the keyboard button is on the bar).
// Shown upright, and sideways while the keyboard is up (sideways, the picture needs the height).
function rcBuildKeyStrip() {
  const keys = [['Esc', 'Escape'], ['Tab', 'Tab'], ['Ctrl'], ['Alt'], ['Shift'], ['Win'], ['←', 'ArrowLeft'], ['↑', 'ArrowUp'], ['↓', 'ArrowDown'], ['→', 'ArrowRight'], ['Del', 'Delete']];
  const keep = e => e.preventDefault(); // (a tap here keeps the phone keyboard up)
  rcUi.keys.replaceChildren(...keys.map(([label, code]) => el('button', {
    class: 'rc-key', type: 'button', 'data-key': label, 'aria-label': code ? label : `${label} (stays down for the next key)`,
    ...(!code && { 'aria-pressed': 'false' }),
    onpointerdown: keep,
    onclick: () => {
      if (code) rcWithSticky([code]);
      else { if (rc.sticky.has(label)) rc.sticky.delete(label); else rc.sticky.add(label); rcRenderKeyStrip(); }
    },
  }, label)));
}

function rcRenderKeyStrip() {
  if (!rcUi.keys) return;
  const live = rc.state === 'live' || rc.state === 'reconnecting';
  const kb = document.activeElement === rcUi.sink;
  const hide = !(live && rcPhone() && (kb || innerHeight > innerWidth));
  if (rcUi.keys.hidden !== hide) { rcUi.keys.hidden = hide; requestAnimationFrame(() => rcLayout()); }
  for (const b of rcUi.keys.querySelectorAll('[data-key]')) {
    if (RC_MODIFIERS[b.dataset.key]) b.setAttribute('aria-pressed', String(rc.sticky.has(b.dataset.key)));
  }
}

// The phone's keyboard: on (`on` true), or on and off.
function rcShowKeyboard(on) {
  if (rc.state !== 'live') return;
  const box = rcUi.sink;
  if (document.activeElement === box) {
    if (on !== true) { box.blur(); rcRenderBar(); }
    return;
  }
  rcClearSink();
  box.focus({ preventScroll: true });
  rcRenderBar();
}

// The window changed size. A phone keyboard that went away by itself (Android's back closes it, the page isn't told)
// shows as the window growing back while the box still has the focus: the box lets go of it then.
function rcOnResize() {
  const h = innerHeight;
  const was = rc.winH;
  rc.winH = h;
  // (a touch keyboard coming or going changes only the height: the PC's fit and picture stay as they are)
  const keyboard = rcTouchUi() && document.activeElement === rcUi.sink && innerWidth === rc.winW;
  if (rcPhone() && document.activeElement === rcUi.sink && h > was + 100 && innerWidth === rc.winW) rcUi.sink.blur();
  rc.winW = innerWidth;
  rcLayout();
  rcRenderBar();
  if (!keyboard) rcPicSoon();
}

// ---------------------------------------------------------------- how to control (a phone or a tablet)

const RC_HELP = {
  trackpad: {
    title: 'Trackpad',
    rows: [
      ['pointer', 'Move the pointer', 'Slide one finger anywhere'],
      ['check', 'Click', 'Tap'],
      ['more', 'Right-click', 'Tap with two fingers, or touch and hold until the ring fills, then let go'],
      ['select', 'Drag or select', 'Touch and hold until the ring fills, then move'],
      ['down', 'Scroll', 'Slide two fingers'],
      ['zoom-in', 'Zoom', 'Pinch (the picture follows the pointer)'],
      ['keyboard', 'Keyboard', 'The keyboard button, or swipe up with three fingers'],
    ],
  },
  touch: {
    title: 'Touch',
    rows: [
      ['check', 'Click', 'Tap where you want to click (tap twice to double-click)'],
      ['more', 'Right-click', 'Touch and hold until the ring fills, then let go (or tap with two fingers)'],
      ['select', 'Drag or select', 'Touch and hold until the ring fills, then move'],
      ['down', 'Scroll', 'Slide one finger'],
      ['zoom-in', 'Zoom and move the picture', 'Pinch, and slide two fingers'],
      ['keyboard', 'Keyboard', 'The keyboard button, or swipe up with three fingers'],
    ],
  },
};

function rcShowHelp() {
  const h = RC_HELP[rc.touchMode];
  const other = rc.touchMode === 'trackpad' ? 'touch' : 'trackpad';
  const close = () => {
    store.set(`beam.rc.help.${rc.touchMode}`, '1');
    rcUi.help.hidden = true;
    rcUi.help.replaceChildren();
  };
  rcTouchReset();
  rcUi.help.replaceChildren(el('div', { class: 'rc-help-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': `How to control: ${h.title}` },
    el('strong', {}, `${h.title} mode`),
    el('ul', {}, ...h.rows.map(([ic, what, how]) => el('li', {}, icon(ic), el('span', {}, el('b', {}, what), el('small', {}, how))))),
    el('p', { class: 'rc-help-note' }, other === 'touch' ? 'Rather tap right on things? Use touch mode.' : 'Rather move a pointer, like on a laptop? Use trackpad mode.',
      innerHeight > innerWidth ? ' Turn the phone sideways for a bigger picture.' : ''),
    el('div', { class: 'rc-actions' },
      el('button', { class: 'btn ghost', type: 'button', onclick: () => { close(); rcSetTouchMode(other); } }, other === 'touch' ? 'Use touch' : 'Use trackpad'),
      el('button', { class: 'btn primary', type: 'button', onclick: close }, 'Got it'))));
  rcUi.help.onclick = e => { if (e.target === rcUi.help) close(); }; // (a tap beside the card closes it too)
  rcUi.help.hidden = false;
  rcUi.help.querySelector('.btn.primary')?.focus({ preventScroll: true });
}

// The first time on a phone or tablet in each mode, once the picture is up: how it works. True if it showed.
function rcMaybeHelp() {
  if (!rcPhone() || rc.state !== 'live' || !rc.hostHello || !rcUi.help.hidden || store.get(`beam.rc.help.${rc.touchMode}`) === '1') return false;
  rcShowHelp();
  return true;
}

async function rcToggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await rcUi.root.requestFullscreen({ navigationUI: 'hide' });
  } catch {}
}

// Full screen takes the keyboard too where the browser can (Esc, Alt+Tab and the Windows key reach the PC), but only
// while input goes to the PC: let go of while reconnecting, locked, at a security prompt or switching screens.
function rcKeyboardLock() {
  const want = Boolean(document.fullscreenElement) && rcLive();
  if (want === rc.kbLocked) return;
  rc.kbLocked = want;
  if (want) navigator.keyboard?.lock?.().catch(() => {});
  else navigator.keyboard?.unlock?.();
}

function rcOnFullscreen() {
  rcKeyboardLock();
  rcUi.root.classList.toggle('full', Boolean(document.fullscreenElement));
  setTimeout(rcLayout, 50);
  rcRenderBar();
  rcPicSoon(); // (full screen: a bigger area to fit the PC to)
}

function rcWakeRelease() {
  const w = rc.wake;
  rc.wake = null;
  w?.release?.().catch(() => {});
}

// A phone's screen stays on while the session is live.
async function rcWakeLock() {
  if (rc.state !== 'live' || document.hidden || !navigator.wakeLock || rc.wake) return;
  try {
    rc.wake = await navigator.wakeLock.request('screen');
    rc.wake.addEventListener('release', () => { rc.wake = null; });
  } catch {}
}

// ---------------------------------------------------------------- what's on screen

function rcRender() {
  if (!rcUi.root) return;
  const { card, overlay, notice, video } = rcUi;
  const n = rc.name || 'the PC';
  rcRenderBar();
  rcDrawPointer();
  rcApplyCursor();
  rcUi.root.dataset.state = rc.state;
  // The PC's foreground window runs as administrator: a note over the picture. Windows drops all injected input then
  // (UIPI), not just input to that window (1.7.6: the user found every click and key blocked).
  notice.hidden = !(rc.state === 'live' && rc.sub.elevated && !rc.sub.locked && !rc.sub.secure);
  notice.textContent = 'An administrator window is in front on the PC, so Windows blocks all of Beam’s clicks and keys. Close it there, or with Remote Desktop.';
  const button = (label, onclick, cls = '') => el('button', { class: `btn ${cls}`, type: 'button', onclick }, label);
  const rdp = () => rc.device?.can?.remoteDesktop && (!HOST || hostHas('remoteDesktop')) && button('Remote Desktop', () => remoteDesktop(rc.device), 'primary');
  const spin = () => el('div', { class: 'rc-spin', 'aria-hidden': 'true' });
  let parts = null;
  if (rc.idleWarn && rc.state !== 'ended') {
    const secs = Math.max(0, Math.ceil((rc.idleWarn.until - Date.now()) / 1000));
    parts = [icon('clock', 'i big'), el('strong', {}, 'Still there?'), el('p', {}, `Nothing was touched or pressed for a while. The session with ${n} ends in ${secs} s.`),
      el('div', { class: 'rc-actions' }, button('I’m here', rcActivity, 'primary'), button('Disconnect', rcDisconnect, 'ghost'))];
  } else if (rc.state === 'connecting' || rc.state === 'reconnecting') {
    parts = [spin(), el('strong', {}, rc.state === 'connecting' ? `Connecting to ${n}` : `Reconnecting to ${n}`), el('p', {}, rc.step || ''),
      el('div', { class: 'rc-actions' }, button(rc.state === 'connecting' ? 'Cancel' : 'Disconnect', rcDisconnect, 'ghost'))];
  } else if (rc.state === 'ended' && rc.end) {
    const e = rc.end;
    const r = e.rdp && rdp();
    parts = [icon(e.reason === 'locked' ? 'lock' : e.reason === 'peer' ? 'shield' : 'monitor', 'i big'), el('strong', {}, e.title), e.text && el('p', {}, e.text),
      el('div', { class: 'rc-actions' },
        r,
        e.retry && button('Reconnect', () => rcConnect(), r ? '' : 'primary'),
        e.signin && el('a', { class: 'btn primary', href: BASE.href }, 'Open Beam'),
        e.close && button('Close', rcClose, 'ghost'))];
  } else if (rc.state === 'live' && rc.sub.locked) {
    parts = [icon('lock', 'i big'), el('strong', {}, `${n} is locked: use Remote Desktop`), el('p', {}, 'Remote control comes back once it’s unlocked.'),
      el('div', { class: 'rc-actions' }, rdp(), button('Disconnect', rcDisconnect, 'ghost'))];
  } else if (rc.state === 'live' && rc.sub.secure) {
    parts = [icon('shield', 'i big'), el('strong', {}, 'Waiting for a Windows security prompt'),
      el('p', {}, `${n} shows a security prompt (User Account Control). Someone at the PC has to answer it; the picture comes back after.`)];
  } else if (rc.state === 'live' && rc.switching) {
    parts = [spin(), el('strong', {}, `Switching to ${rc.switching.name}…`), el('p', {}, 'The picture comes back in a moment.')];
  } else if (rc.state === 'live' && (!rc.frames || !rc.hostHello)) {
    parts = [spin(), el('strong', {}, `Connected to ${n}`), el('p', {}, 'Waiting for the picture…')];
  }
  overlay.hidden = !parts;
  card.replaceChildren(...(parts || []).filter(Boolean));
  video.hidden = !rc.verified;
  rcUi.canvas.hidden = !rc.verified;
  rcKeyboardLock();
}

// Close: the app's viewer window, or the tab that opened for this (else back to Beam). Beam for Android's viewer
// leaves for Beam's page, which ends it there: its WebView takes window.close() and then does nothing at all.
function rcClose() {
  if (HOST) return void hostCall('closeWindow').catch(() => {});
  if (/\bBeamAndroid\//.test(navigator.userAgent)) return void (location.href = BASE.href);
  window.close();
  setTimeout(() => { if (!window.closed) location.href = BASE.href; }, 300);
}

// ---------------------------------------------------------------- the Windows app's viewer window (plan/rd-contract.md)

// beamHost.window is "remote" there. The page says hello, keeps the app's keyboard hook on while it's live and
// focused (the Windows keys, Alt+Tab and the like then come as remoteKey { code, down }), and says which session is
// on (remoteSession), so closing the window ends it.
function rcBindHost() {
  window.chrome.webview.addEventListener('message', e => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'reply') {
      const w = hostWaiting.get(m.id);
      hostWaiting.delete(m.id);
      if (w) m.ok ? w.resolve(m.result) : w.reject(Object.assign(new Error(m.error || 'The Beam app couldn’t do that.'), { code: m.code }));
    } else if (m.type === 'remoteKey') { rcActivity(); rcKey(m.code, m.down === true); }
  });
  hostCall('hello', { bridge: 1 }).catch(() => {});
  window.addEventListener('focus', rcHook);
  window.addEventListener('blur', rcHook);
}

function rcHook() {
  if (!HOST || !hostHas('keyboardHook')) return;
  const on = rcLive() && document.hasFocus() && !document.hidden;
  if (on === rc.hookOn) return;
  rc.hookOn = on;
  hostCall('keyboardHook', { on }).catch(() => {});
}
