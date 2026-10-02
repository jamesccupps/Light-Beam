'use strict';
// Signing in (browser mode): approve from a signed-in device (QR + code, Steam-style), password or pairing link,
// automatic sign-in (Tailscale identity or a Beam app on the same machine), and the handoff after a move.
// Signed-in devices approve other devices' requests here. In host mode (Windows app) none of this shows: the app
// signs in natively and the page only reports 401/410 (HOST-BRIDGE.md §2).

let paired = false;
let hostSignalSent = { unauthorized: false, moved: false };

// ---------------------------------------------------------------- screens

async function showApp() {
  paired = true;
  clearTimeout(reprobeTimer);
  $('#lock').hidden = true;
  $('#hostWait').hidden = true;
  $('#app').hidden = false;
  loginRun++;
  withdrawLogin();
  renderAll();
  renderBanner();
  connect();
  if (!NARROW.matches) openConv(current, { push: false });
  const approveCode = takePendingApprove();
  if (approveCode) lookUpApproval(approveCode);
  if (location.hash === '#pair') {
    history.replaceState(null, '', BASE.pathname);
    openPairDialog();
  }
}

function showLock(message) {
  paired = false;
  stopLive();
  closeApprovalDialog();
  $('#app').hidden = true;
  $('#hostWait').hidden = true;
  $('#lock').hidden = false;
  $('#lockTitle').textContent = 'Sign in to Beam';
  $('#loginBox').hidden = false;
  $('#lockAlt').hidden = false;
  $('.lock-shared').hidden = false;
  const approving = store.get('beam.approve') || sessionGet('beam.approve');
  $('#approveNote').hidden = !approving;
  $('#dormantNote').hidden = !dormant;
  if (dormant && !reprobeTimer) scheduleReprobe(true);
  if (approving) $('#approveNote').textContent = `To approve the sign-in code ${formatCode(approving)}, sign in on this device first.`;
  layoutLock();
  if (message) {
    setLockMessage(message, true);
    $('#lockAlt').open = true;
  }
  renewals = 0;
  startLoginLoop();
  startAutopairRetry();
}

function showHostWait(title, message) {
  paired = false;
  stopLive();
  $('#app').hidden = true;
  $('#lock').hidden = true;
  $('#hostWait').hidden = false;
  $('#hostWaitTitle').textContent = title;
  $('#hostWaitMsg').textContent = message || '';
}

function setLockMessage(message, isError = false) {
  const msg = $('#lockMsg');
  msg.textContent = message;
  msg.classList.toggle('err', Boolean(isError));
}

// Phones can't scan their own screen: lead with the code there, the QR code on computers.
function layoutLock() {
  const phone = NARROW.matches || !FINE_POINTER.matches;
  $('#lock').classList.toggle('phone', phone);
  $('#loginQrWrap').hidden = phone && !showQrOnPhone;
  $('#showQrBtn').hidden = !phone || showQrOnPhone;
  setLockMessage(phone
    ? 'On a device that’s signed in, open Beam → Add device and type this code. Or approve it when it asks.'
    : 'Scan the QR code with your phone (camera or the Beam app), or type the code on a signed-in device.');
}
let showQrOnPhone = false;

const formatCode = c => { const s = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s; };
const sessionGet = key => { try { return sessionStorage.getItem(key); } catch { return null; } };
const sessionSet = (key, v) => { try { v == null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, v); } catch {} };

function takePendingApprove() {
  const code = sessionGet('beam.approve') || store.get('beam.approve');
  sessionSet('beam.approve', null);
  store.remove('beam.approve');
  return code;
}

// ---------------------------------------------------------------- 401 / 410 while running

// The server says this device isn't signed in any more (signed out from another device, revoked, expired): nothing
// it had stays on it. The saved history, the catch-up cursor, the outbox for that Beam, drafts, anything waiting in
// the service worker's share cache, what was on screen, and (in a browser) the thumbnails and files in the HTTP
// cache all go. Only messages queued for other Beams stay (they exist nowhere else). Network errors, 5xx and moves
// never get here: that's offline mode, and the history stays.
let wiping = null;
function wipeSignedOut(owner = '') {
  wiping ||= (async () => {
    stopLive();
    clearRendered();
    await forgetLocalData();
    await cache.wipe({ outboxOf: owner });
    if ('caches' in window) await caches.delete('beam-share').catch(() => {});
    clearHttpCache();
    // Nothing is left to lie dormant: a sign-in from here starts fresh.
    dormant = false;
    cacheDisabled = keepsNothing();
    $('#dormantNote').hidden = true;
  })().catch(err => console.error('wipe', err)).finally(() => { wiping = null; });
  return wiping;
}

// Thumbnails and files viewed inline can stay in the browser's HTTP cache for up to a year, and a page can't clear
// that itself: the server's POST /api/clear-cache answers with Clear-Site-Data: "cache" (1.4; an older server's
// 404 is ignored, like any other answer). Never while the page is being left (such an answer arriving as the next
// page loads can stall that load), and not in the Windows app: it clears its window's data itself after a 401 and
// reloads the window at once.
function clearHttpCache() {
  if (leaving || HOST) return;
  fetch(url('api/clear-cache'), { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(10000) }).catch(() => {});
}

// ---------------------------------------------------------------- whose saved history this is
// The saved history and its outbox belong to one Beam, the cache's owner (its serverId). When another Beam answers
// at this address (a move gone wrong, a reinstall with a fresh data folder) they lie dormant: off the screen at once,
// neither read nor written, the outbox not sent, and the sign-in page says that signing in there replaces them.
// - The owner answers again: they come back, and the outbox goes out (to the owner only).
// - A sign-in to the other Beam completes: they're wiped (the outbox unsent) and that Beam's history starts fresh.
//   Only a completed sign-in gets an authenticated answer from it (its server info, its stream).
// - A 401 from the owner itself is a sign-out: everything is wiped, as above.
let dormant = false;
const keepsNothing = () => me.temporary || sessionGet('beam.sessionOnly') === '1';

// A 401: whose? 1.4 servers say in it; older ones are asked (/api/hello). The owner's wipes; another Beam's, or one
// that can't be told, leaves the saved history dormant (nothing wiped).
let checking = null;
function signedOutBy(serverId) {
  checking ||= (async () => {
    const ours = (await kvGet('meta', { force: true }))?.serverId || ''; // what's stored (another tab may have changed it)
    let answering = typeof serverId === 'string' ? serverId : '';
    if (!answering && ours) {
      answering = await fetch(url('api/hello'), { credentials: 'same-origin', signal: AbortSignal.timeout(8000) })
        .then(r => (r.ok ? r.json() : {})).then(h => h.serverId || '').catch(() => '');
    }
    if (!ours || answering === ours) await wipeSignedOut(ours);
    else { stopLive(); goDormant(answering); }
  })().catch(err => console.error('sign-out check', err)).finally(() => { checking = null; });
  return checking;
}

// An authenticated answer (the server info, the stream's hello) says which Beam this is.
function answeredBy(serverId) {
  if (!serverId) return;
  server.serverId = server.answered = serverId;
  if (replacing) return; // the replace under way settles the rest (and catches up after)
  if (!cache.owner) { cache.owner = serverId; loadOutbox(); return; }
  if (serverId === cache.owner) {
    if (dormant) wakeDormant();
    else if (cache.aside) cache.forgetAside();
    return;
  }
  replaceDormant(serverId);
}

// Off the screen at once, and nothing of it read, written or sent until its owner answers again. `other`: the Beam
// that answered instead, remembered so that the next start waits to hear who answers before showing anything.
function goDormant(other) {
  if (!dormant) {
    dormant = true;
    if (other) cache.markAside(other);
    cacheDisabled = true;
    clearRendered();
    forgetInMemory();
    scheduleReprobe(true); // (only on the way in: later 401s from the other Beam don't put it off)
  }
  $('#dormantNote').hidden = false;
}

// While the history lies dormant on the sign-in page, its own Beam may come back: the cookie this browser still has
// is tried again now and then (30 s, doubling up to 5 min, only while the page is visible). If it works, the page
// carries on: its own Beam wakes the history; another one replaces it (its outbox kept for its Beam). Anything else
// (still another Beam's 401, no network) just waits for the next try.
let reprobeTimer = null;
let reprobeDelay = 30000;
function scheduleReprobe(reset = false) {
  clearTimeout(reprobeTimer);
  reprobeTimer = null;
  if (reset) reprobeDelay = 30000;
  if (!dormant || paired || HOST) return;
  reprobeTimer = setTimeout(reprobe, reprobeDelay * (0.8 + Math.random() * 0.4));
  reprobeDelay = Math.min(300000, reprobeDelay * 2);
}
async function reprobe() {
  reprobeTimer = null;
  if (!dormant || paired || HOST) return;
  if (document.hidden) return; // tried again when the page is shown (onVisibility)
  const res = await fetch(url('api/me'), { headers: idHeaders(), credentials: 'same-origin', signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!dormant || paired) return;
  if (res?.ok) {
    applyMe(await res.json().catch(() => ({})));
    return onSignedIn('again');
  }
  scheduleReprobe();
}

function forgetInMemory() {
  closePhone();
  clearPhone();
  phone.shown = false;
  // Only the in-memory copy goes: what's saved stays. Anything not saved yet is saved now (for its own Beam).
  for (const entry of outbox.values()) if (!entry.stored && !keepsNothing()) outboxStore.put(entry, { force: true });
  outbox.clear();
  readMarks = null;
  drafts = {};
  setItems([]);
  setDevices([]);
  devicesKnown = false;
  live.cursor = cache.cursor = '';
  live.needFull = true;
  view.conv = null;
}

// The owner answered again: the saved history and outbox come back.
let waking = null;
function wakeDormant() {
  waking ||= (async () => {
    dormant = false;
    cacheDisabled = keepsNothing();
    $('#dormantNote').hidden = true;
    clearTimeout(reprobeTimer);
    const cached = await cache.load();
    cache.forgetAside();
    if (cached) applyCached(cached);
    await loadOutbox();
    if (paired) { renderAll(); sync('its own Beam'); }
  })().catch(err => console.error('wake', err)).finally(() => { waking = null; });
  return waking;
}

// Signed in to another Beam (by hand or by itself: autopair, the app signing itself in): the old Beam's history goes
// (it can be fetched from it again), and this Beam's starts fresh. The old Beam's outbox stays, tagged with it, out
// of sight: it goes out if that Beam signs this page in again (30 days at most). If another tab got there first, the
// store already holds this Beam's history: this tab adopts it instead.
let replacing = null;
function replaceDormant(serverId) {
  replacing ||= (async () => {
    goDormant('');
    const old = cache.owner;
    const adopt = (await kvGet('meta', { force: true }))?.serverId === serverId;
    if (!adopt) {
      forgetLocalPrefs({ machine: false });
      await cache.replaceHistory(old);
    }
    cache.owner = serverId;
    dormant = false;
    cacheDisabled = keepsNothing();
    $('#dormantNote').hidden = true;
    clearTimeout(reprobeTimer);
    if (adopt) {
      const cached = await cache.load();
      if (cache.aside) cache.forgetAside();
      if (cached) applyCached(cached);
    }
    await loadOutbox(); // what's queued for this Beam (if it signed this page in before); the old Beam's stays stored
    if (paired) { renderAll(); sync('another Beam'); }
  })().catch(err => console.error('replace', err)).finally(() => { replacing = null; });
  return replacing;
}

onUnauthorized = (reason, serverId) => {
  const other = typeof serverId === 'string' && serverId && cache.owner && serverId !== cache.owner;
  signedOutBy(serverId);
  if (HOST) {
    if (!hostSignalSent.unauthorized) { hostSignalSent.unauthorized = true; hostPost('unauthorized'); }
    showHostWait('Signing in…', 'Beam is signing this PC in again. This window reloads when it’s done.');
    return;
  }
  if (!$('#lock').hidden) return;
  showLock(paired && !other && !dormant ? 'You were signed out on this device (the sign-in was removed or expired). Sign in again to continue.' : undefined);
};

onMoved = movedTo => {
  const target = isHttpUrl(movedTo) ? String(movedTo).replace(/\/+$/, '') : '';
  if (HOST) {
    if (!hostSignalSent.moved) { hostSignalSent.moved = true; hostPost('moved', { movedTo: target || String(movedTo || '') }); }
    showHostWait('Beam is moving…', target ? `To ${target}. This window switches over by itself.` : 'This window switches over by itself.');
    return;
  }
  showMoved(target);
};

let movedTimer;
function showMoved(target) {
  paired = false;
  loginRun++;
  stopLive();
  $('#app').hidden = true;
  $('#lock').hidden = false;
  $('#loginBox').hidden = true;
  $('#lockAlt').hidden = true;
  $('.lock-shared').hidden = true;
  $('#approveNote').hidden = true;
  $('#lockTitle').textContent = 'Beam has moved';
  const msg = $('#lockMsg');
  msg.classList.remove('err');
  if (!target) {
    msg.textContent = 'It now lives at a new address. The Beam apps switch over by themselves; ask one of them for the new address.';
    return;
  }
  // The old server's page sends us on with a sign-in handoff, so this device stays signed in (and keeps its id).
  const go = el('button', { class: 'btn primary', type: 'button', onclick: () => location.replace(BASE.href) }, 'Take me there');
  msg.replaceChildren('It now lives at ', el('a', { href: `${target}/` }, target), '. Taking you there…', el('div', { class: 'lock-actions' }, go));
  clearTimeout(movedTimer);
  movedTimer = setTimeout(() => location.replace(BASE.href), 2500);
}

// ---------------------------------------------------------------- the move handoff (#handoff=…&device=…&name=… from the old server)

function takeHandoff() {
  if (HOST || !location.hash.includes('handoff=')) return null;
  const h = new URLSearchParams(location.hash.slice(1));
  const handoff = h.get('handoff');
  const device = h.get('device');
  const name = cleanName(h.get('name'));
  if (device && DEVICE_ID.test(device)) store.set('beam.deviceId', device);
  if (name) {
    store.set('beam.device', name);
    store.set('beam.named', AUTO_NAME.test(name) ? '0' : '1');
  }
  history.replaceState(null, '', BASE.pathname + location.search);
  return handoff;
}

async function signInWithHandoff(handoff) {
  try {
    const res = await fetch(url('api/login'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...idHeaders() }, body: JSON.stringify({ handoff, deviceId: me.id }) });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- sign-in requests (QR + code), only while the page is visible

let loginRun = 0;
let pendingLogin = null; // { id, secret, code, expiresAt }
let renewals = 0;
let expiryTimer;

function startLoginLoop() {
  if (HOST || paired || $('#lock').hidden || $('#loginBox').hidden) return;
  if (document.visibilityState !== 'visible') return;
  $('#newCodeBtn').hidden = true;
  loginLoop(++loginRun);
}

async function createLoginRequest() {
  const body = { name: me.name, platform: 'web', deviceId: me.id, remember: !$('#sharedPc').checked };
  const res = await fetch(url('api/login-requests'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...idHeaders() }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (res.status === 410) { onMoved((await res.json().catch(() => ({}))).movedTo); throw Object.assign(new Error('moved'), { stop: true }); }
  if (res.status === 429) throw Object.assign(new Error('Too many sign-in requests from here. Wait a minute.'), { wait: 30000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loginLoop(run) {
  const active = () => run === loginRun && !paired && !$('#lock').hidden && document.visibilityState === 'visible';
  while (active()) {
    // Don't keep asking your other devices forever: after two renewals, wait for a tap.
    if (renewals > 2) { offerNewCode('The code expired.'); return; }
    let request;
    try {
      request = await createLoginRequest();
    } catch (err) {
      if (err.stop) return;
      $('#loginCode').textContent = '';
      $('#loginQr').removeAttribute('src');
      $('#loginExpiry').textContent = err.wait ? err.message : 'Can’t reach Beam right now. Retrying…';
      await sleep(err.wait || 5000);
      continue;
    }
    if (!active()) { withdraw(request); return; }
    pendingLogin = request;
    showLoginRequest(request);
    for (;;) {
      if (!active()) return;
      let status;
      try {
        const res = await fetch(url(`api/login-requests/${request.id}?wait`), { credentials: 'same-origin', headers: { 'X-Beam-Login-Secret': request.secret, ...idHeaders() }, signal: AbortSignal.timeout(35000) });
        status = res.ok ? (await res.json()).status : res.status === 404 ? 'expired' : 'error';
      } catch {
        await sleep(3000);
        continue;
      }
      if (run !== loginRun) return;
      if (status === 'approved') {
        pendingLogin = null;
        return onSignedIn('approved');
      }
      if (status === 'denied') {
        pendingLogin = null;
        offerNewCode('That sign-in was denied on the other device.', true);
        return;
      }
      if (status === 'expired' || status === 'withdrawn') {
        pendingLogin = null;
        renewals++;
        if (renewals <= 2) { $('#loginCode').textContent = ''; $('#loginQr').removeAttribute('src'); }
        break;
      }
      if (status === 'error') await sleep(3000);
    }
  }
}

function showLoginRequest(request) {
  $('#loginQr').src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(request.qrSvg)}`;
  $('#loginCode').textContent = request.code;
  $('#newCodeBtn').hidden = true;
  $('#loginBox').classList.remove('expired');
  clearInterval(expiryTimer);
  const tickExpiry = () => {
    const left = Math.max(0, Math.round(((request.expiresAt || 0) - Date.now()) / 1000));
    $('#loginExpiry').textContent = left ? `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : '';
  };
  tickExpiry();
  expiryTimer = setInterval(tickExpiry, 1000);
}

function offerNewCode(message, isError = false) {
  clearInterval(expiryTimer);
  $('#loginExpiry').textContent = message;
  $('#loginExpiry').classList.toggle('err', isError);
  $('#loginBox').classList.add('expired');
  $('#newCodeBtn').hidden = false;
}

function withdraw(request, keepalive = false) {
  if (!request) return;
  fetch(url(`api/login-requests/${request.id}`), { method: 'DELETE', keepalive, credentials: 'same-origin', headers: { 'X-Beam-Login-Secret': request.secret, ...idHeaders() } }).catch(() => {});
}

// Take back an open request so signed-in devices stop being asked (page hidden, closed, or signed in another way).
function withdrawLogin(keepalive = false) {
  clearInterval(expiryTimer);
  const request = pendingLogin;
  pendingLogin = null;
  withdraw(request, keepalive);
}

// ---------------------------------------------------------------- other ways in

async function submitKey(event) {
  event.preventDefault();
  const secret = $('#keyInput').value.trim();
  if (!secret) return;
  const btn = event.submitter || $('#lockForm button');
  btn.disabled = true;
  try {
    const res = await fetch(url('api/login'), {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...idHeaders() },
      body: JSON.stringify({ secret, remember: !$('#sharedPc').checked, deviceId: me.id }),
    }).catch(() => null);
    if (res?.ok) {
      $('#keyInput').value = '';
      onSignedIn('password');
    } else {
      const body = await res?.json().catch(() => ({}));
      setLockMessage(res ? body?.error || 'That didn’t work.' : `Can’t reach the Beam server. ${offlineCause()}`, true);
      $('#lockAlt').open = true;
      $('#keyInput').select();
    }
  } finally {
    btn.disabled = false;
  }
}

async function tryAutopair() {
  try {
    const res = await fetch(url('api/autopair'), {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...idHeaders() },
      body: JSON.stringify({ client: 'web', deviceId: me.id, name: me.name, platform: 'web', remember: !$('#sharedPc').checked }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// If the Beam app starts on this machine (or Tailscale sign-in gets enabled) while the sign-in page is open,
// sign in by ourselves.
let autopairTimer;
function startAutopairRetry() {
  clearInterval(autopairTimer);
  autopairTimer = setInterval(async () => {
    if (paired || $('#lock').hidden) { clearInterval(autopairTimer); return; }
    if (document.visibilityState !== 'visible' || $('#loginBox').hidden) return;
    if (await tryAutopair()) onSignedIn('autopair');
  }, 15000);
}

async function onSignedIn(how) {
  clearInterval(autopairTimer);
  clearInterval(expiryTimer);
  if ($('#sharedPc').checked) { sessionSet('beam.sessionOnly', '1'); await disableOfflineCache(); }
  loginRun++;
  withdrawLogin();
  setLockMessage('');
  await loadServerInfo();
  hostLog('info', `signed in (${how})`);
  await showApp();
  pickUpShares(); // something shared while signed out waits in the share cache (the chooser waits for the devices)
}

// ---------------------------------------------------------------- approving other devices (signed-in side)
// Requests queue up; what's on screen is never swapped for another request while you look at it, and Approve
// only works a moment after the content appeared (so a late request can't catch a tap meant for another).

const approvals = [];
let approving = null;
let approveGuard;

function onLoginRequestEvent(r) {
  if (HOST || !paired || !r || !r.id) return;
  if (r.deviceId && r.deviceId === me.id) return; // our own (stale) request
  enqueueApproval(r, { notify: true });
}

function onLoginRequestDone(data) {
  if (!data) return;
  const i = approvals.findIndex(a => a.id === data.id);
  if (i >= 0) { approvals.splice(i, 1); updateApprovalQueueNote(); }
  if (approving && approving.id === data.id) {
    const was = approving;
    approving = null;
    if ($('#approveDlg').open && data.status !== 'approved' && data.status !== 'denied') toast(`The sign-in request from ${was.name} ${data.status === 'withdrawn' ? 'was withdrawn' : 'expired'}.`);
    showNextApproval();
  }
}

function enqueueApproval(r, { notify: shouldNotify = false } = {}) {
  if ((approving && approving.id === r.id) || approvals.some(a => a.id === r.id)) return;
  approvals.push(r);
  if (!approving) showNextApproval(); else updateApprovalQueueNote();
  if (shouldNotify && document.hidden && !HOST && 'Notification' in window && Notification.permission === 'granted') {
    showNotification('Approve a sign-in?', { body: `${r.name} · code ${r.code}`, icon: url('icon-192.png'), tag: `login-${r.id}`, data: { approve: r.code }, requireInteraction: true }, () => lookUpApproval(r.code));
  }
}

function showNextApproval() {
  clearTimeout(approveGuard);
  approving = approvals.shift() || null;
  const dlg = $('#approveDlg');
  if (!approving) { if (dlg.open) dlg.close(); return; }
  const r = approving;
  const move = r.purpose === 'move';
  $('#approveTitle').textContent = move ? 'Copy all of Beam to a new server?' : 'Sign in a new device?';
  $('#approveName').textContent = r.name || 'A new device';
  $('#approveWhere').textContent = [r.where, PLATFORM_NAME[r.platform]].filter(Boolean).join(' · ') || 'Unknown';
  const ts = r.tailscale || {};
  const who = [ts.user, ts.node && `Tailscale machine ${ts.node}`].filter(Boolean).join(' · ');
  $('#approveWho').textContent = who;
  $('#approveWho').hidden = !who;
  $('#approveWhoLabel').hidden = !who;
  $('#approveCode').textContent = r.code;
  $('#approveWarn').textContent = move
    ? 'This asks for a full copy of your Beam (every message, file and sign-in) for a new server. Only approve it if you are moving Beam yourself right now and the code matches.'
    : `Only approve if it's your device and the code matches what it shows. It will be able to see and send everything.${r.remember === false ? ' It will be signed in for one session only.' : ''}`;
  const btn = $('#approveBtn');
  btn.disabled = true;
  approveGuard = setTimeout(() => { btn.disabled = false; }, 1000);
  updateApprovalQueueNote();
  if (!dlg.open) dlg.showModal();
  $('#denyBtn').focus();
}

function updateApprovalQueueNote() {
  const note = $('#approveQueue');
  note.hidden = !approvals.length;
  note.textContent = approvals.length ? `${plural(approvals.length, 'more request')} waiting after this one.` : '';
}

function closeApprovalDialog() {
  approvals.length = 0;
  approving = null;
  if ($('#approveDlg').open) $('#approveDlg').close();
}

async function answerApproval(action) {
  const r = approving;
  if (!r) return;
  if (action === 'approve' && $('#approveBtn').disabled) return;
  approving = null;
  try {
    await api(`api/login-requests/${action}`, jsonBody({ code: r.code }));
    toast(action === 'approve' ? `${r.name} is signed in` : 'Sign-in denied');
  } catch (err) {
    toast(friendlyError(err), { error: true });
  }
  showNextApproval();
}

async function lookUpApproval(code) {
  try {
    const r = await apiJson(`api/login-requests?code=${encodeURIComponent(code)}`);
    enqueueApproval(r);
  } catch (err) {
    toast(friendlyError(err), { error: true, ms: 5000 });
  }
}

// Requests made while this page was closed.
async function catchUpApprovals() {
  if (HOST) return;
  try {
    const { requests } = await apiJson('api/login-requests');
    for (const r of requests || []) if (!(r.deviceId && r.deviceId === me.id)) enqueueApproval(r);
  } catch {}
}

// ---------------------------------------------------------------- signing out (browser)

async function signOutHere() {
  if (HOST) {
    if (await confirmDialog({ title: 'Sign this PC out of Beam?', text: 'The Beam app stops receiving until you sign in again.', confirm: 'Sign out', danger: true })) hostDo('unpair');
    return;
  }
  const ok = await confirmDialog({ title: 'Sign out of Beam on this device?', text: 'This device stops receiving. Its history on this device is removed; everything stays on your other devices.', confirm: 'Sign out', danger: true });
  if (!ok) return;
  await fetch(url('api/logout'), { method: 'POST', credentials: 'same-origin', headers: idHeaders() }).catch(() => {});
  await forgetLocalData();
  $('#settingsDlg').close();
  showLock();
}

// Everything this browser keeps about Beam (except its device id, so signing in again is the same device).
async function forgetLocalData() {
  await cache.clear();
  for (const e of outbox.values()) outboxStore.remove(e.id);
  outbox.clear();
  forgetLocalPrefs();
}

// What's kept outside the cache (read marks, drafts, upload resume records, the open conversation) and in memory.
function forgetLocalPrefs({ machine = true } = {}) {
  closePhone();
  clearPhone(); // phone notifications were only ever in memory
  phone.shown = false;
  for (const key of ['beam.read', 'beam.drafts', 'beam.uploads', 'beam.conv', ...(machine ? ['beam.machine'] : [])]) store.remove(key);
  readMarks = null;
  drafts = {};
  setItems([]);
  setDevices([]);
  devicesKnown = false;
  live.cursor = cache.cursor = '';
  view.conv = null;
}
