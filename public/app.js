'use strict';
// Starts Beam: identity, the cached history (instant, and readable offline), then the server.

const WEB_VERSION = '1.6.0';

function bindUI() {
  const box = $('#text');
  box.addEventListener('input', onComposerInput);
  box.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing) return;
    if (e.ctrlKey || e.metaKey || (FINE_POINTER.matches && !e.shiftKey)) { e.preventDefault(); sendComposer(); }
  });
  $('#sendBtn').addEventListener('click', sendComposer);
  $('#attachBtn').addEventListener('click', attachFiles);
  $('#fileInput').addEventListener('change', e => { sendFiles(e.target.files); e.target.value = ''; });
  $('#folderInput').addEventListener('change', e => { onFolderPicked(e.target.files); e.target.value = ''; });
  $('#pasteBtn').hidden = HOST ? !hostHas('clipboard') : !(navigator.clipboard && (navigator.clipboard.read || navigator.clipboard.readText));
  $('#pasteBtn').addEventListener('click', pasteAndSend);
  // (Windows app 1.10) The ♥: Beam Family in a window of the app's own rather than the browser.
  $('#familyLink').addEventListener('click', e => { if (hostHas('family')) { e.preventDefault(); hostDo('openFamily'); } });

  const thread = $('#thread');
  thread.addEventListener('scroll', onThreadScroll, { passive: true });
  thread.addEventListener('focus', e => { if (e.target === thread) moveFocus(null, -1); });
  thread.addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if (a && HOST && !a.hasAttribute('download')) { e.preventDefault(); openLink(a.href); }
  });
  $('#newPill').addEventListener('click', () => { scrollToBottom(true); scheduleCheckRead(); });
  document.addEventListener('paste', onPaste);
  document.addEventListener('copy', onCopy);
  document.addEventListener('keydown', onKeydown);
  bindDragAndDrop();
  bindMenu();
  bindLightbox();
  bindPicking();
  bindGallery();

  $('#backBtn').addEventListener('click', () => (gallery.open ? closeGalleryByUser() : history.state?.conv ? history.back() : showList()));
  window.addEventListener('popstate', e => { if (!galleryPopState(e) && !e.state?.conv && NARROW.matches) showList(); });
  NARROW.addEventListener('change', () => {
    if (!NARROW.matches) { $('#app').classList.remove('in-thread'); if (paired) openConv(current, { push: false }); }
    layoutLock();
  });
  $('#threadMenuBtn').addEventListener('click', e => threadMenu(e.currentTarget));
  $('#threadSearchBtn').addEventListener('click', openThreadSearch);
  $('#pinnedBtn').addEventListener('click', togglePinnedView);

  $('#searchBtn').addEventListener('click', () => ($('#sideSearch').hidden ? openSearch() : closeSearch()));
  $('#searchInput').addEventListener('input', runSearch);
  $('#searchInput').addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
    if (e.key === 'Enter') { e.preventDefault(); $('#searchResults .search-hit')?.click(); }
  });
  $('#searchClose').addEventListener('click', closeSearch);
  $('#threadSearchInput').addEventListener('input', runFind);
  $('#threadSearchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); runFind.flush(); stepFind(e.shiftKey ? 1 : -1); }
    if (e.key === 'Escape') { e.preventDefault(); closeThreadSearch(); $('#text').focus(); }
  });
  $('#threadSearchPrev').addEventListener('click', () => stepFind(-1));
  $('#threadSearchNext').addEventListener('click', () => stepFind(1));
  $('#threadSearchClose').addEventListener('click', closeThreadSearch);

  $('#pairBtn').addEventListener('click', openPairDialog);
  $('#settingsBtn').addEventListener('click', () => openSettings());
  $('#meBtn').addEventListener('click', async () => { await openSettings('device'); $('#set-device input')?.focus(); });
  for (const b of $$('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());
  // A click on the dimmed area around a dialog closes it, as its × does (not a sign-in approval: Esc there means
  // "decide later"). Both ends of the click count: a text selection dragged out of the dialog doesn't close it.
  for (const dlg of $$('dialog.dlg')) {
    if (dlg.id === 'approveDlg') continue;
    const outside = e => {
      const r = dlg.getBoundingClientRect();
      return e.target === dlg && (e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom);
    };
    let downOutside = false;
    dlg.addEventListener('pointerdown', e => { downOutside = outside(e); });
    dlg.addEventListener('click', e => { if (downOutside && outside(e)) dlg.close(); downOutside = false; });
  }

  $('#copyAddressBtn').addEventListener('click', () => copyText($('#pairAddress').textContent, 'Address copied'));
  $('#pairLinkBox').addEventListener('toggle', () => { if ($('#pairLinkBox').open) showPairingLink(); });
  $('#copyLinkBtn').addEventListener('click', () => copyText($('#pairLink').value, 'Link copied'));
  $('#newLinkBtn').addEventListener('click', showPairingLink);
  $('#pairDlg').addEventListener('close', () => clearInterval(pairExpiryTimer));
  $('#approveForm').addEventListener('submit', e => {
    e.preventDefault();
    const code = $('#approveInput').value.trim();
    if (!code) return;
    $('#approveInput').value = '';
    $('#pairDlg').close();
    lookUpApproval(code);
  });

  $('#approveBtn').addEventListener('click', () => answerApproval('approve'));
  $('#denyBtn').addEventListener('click', () => answerApproval('deny'));
  $('#approveDlg').addEventListener('cancel', e => {
    // Esc = decide later: the request stays open (it can still be approved by its code).
    e.preventDefault();
    approving = null;
    showNextApproval();
  });

  $('#lockForm').addEventListener('submit', submitKey);
  $('#newCodeBtn').addEventListener('click', () => { renewals = 0; setLockMessage(''); layoutLock(); startLoginLoop(); });
  $('#showQrBtn').addEventListener('click', () => { showQrOnPhone = true; layoutLock(); });

  $('#toastAction').addEventListener('click', () => { const fn = toastAction; hideToast(); fn?.(); });

  navigator.serviceWorker?.addEventListener('message', e => {
    const m = e.data || {};
    if (m.type === 'open' && paired) { openConv(m.conv || 'all'); if (m.itemId) revealItem(m.itemId); }
    if (m.type === 'approve' && paired && m.code) lookUpApproval(m.code);
  });

  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('resume', () => { if (paired && !document.hidden) goForeground(); });
  window.addEventListener('online', () => { if (paired) reconnectNow(); else if (!$('#lock').hidden) startLoginLoop(); });
  window.addEventListener('offline', () => net.fail());
  window.addEventListener('pageshow', () => { leaving = false; });
  window.addEventListener('hashchange', () => { if (/^#remote=/.test(location.hash)) location.reload(); }); // (the viewer: remote.js)
  window.addEventListener('pagehide', () => {
    leaving = true;
    if (pendingLogin) withdrawLogin(true);
    flushDeletes();
    cache.flushPending();
  });
  net.listeners.add((state, was) => {
    setStatus();
    renderBanner();
    for (const entry of outbox.values()) patchOutboxRow(entry);
    if (state === 'online' && was !== 'online') flushOutbox();
    if (!devicesKnown) { renderSidebar(); for (const refresh of [...devicePickers]) refresh(); } // "Loading…" vs "offline"
  });
  runClocks();
}

// Relative times ("5 min ago") stay fresh while Beam is on screen; only text that changed is touched. A hidden
// page runs no timer for them at all, and catches up when it's shown again.
let clockTimer = null;
function runClocks() {
  clearInterval(clockTimer);
  clockTimer = document.hidden ? null : setInterval(() => { if (paired) { renderSidebar(); renderHeader(); if (phone.open) renderPhone(); } }, 60000);
}

function onThreadScroll() {
  const box = $('#thread');
  view.pinnedBottom = atBottom(box);
  if (view.pinnedBottom && view.newCount) { view.newCount = 0; $('#newPill').hidden = true; }
  scheduleCheckRead();
}

// Set while the page is being left (closed, reloaded, navigated away or put in the back/forward cache).
let leaving = false;

function onVisibility() {
  hostViewing();
  runClocks();
  runRetryTicker();
  if (document.hidden) {
    // Hidden but still running: the stream goes quiet. A page being left needs no poke (its stream closes anyway),
    // and a request still in flight as the next page loads only gets in its way. pagehide may come just after.
    if (paired) setTimeout(() => { if (document.hidden && !leaving) goBackground(); }, 0);
    cache.flushPending();
    // Nobody is looking at the sign-in page: stop asking the signed-in devices.
    if (!$('#lock').hidden && pendingLogin) { loginRun++; withdrawLogin(true); }
    if (pendingUpdateReload) maybeReloadForUpdate(pendingUpdateReload);
    return;
  }
  if (!paired) {
    if (!$('#lock').hidden) { renewals = 0; startLoginLoop(); }
    if (dormant && !HOST) { clearTimeout(reprobeTimer); reprobeTimer = setTimeout(reprobe, 1000); } // its own Beam back?
    return;
  }
  // What happened while hidden is drawn now, in one go (relative times too).
  hiddenWork.all = true;
  resumeRendering();
  if (!live.es) reconnectNow();
  else if (live.stream && serverHas('stream-modes')) goForeground(); // also proves the stream survived the break
  else if (live.watchdog && Date.now() - live.lastEvent > 40000) reconnectNow();
  else if (!live.watchdog) sync('visible'); // older servers send no pings we could trust: catch up (cheap: nothing is rebuilt)
  scheduleCheckRead();
  pickUpShares();
}

// ---------------------------------------------------------------- Android share sheet (the service worker parks shared items)

let pickingUp = false;
async function pickUpShares() {
  if (HOST || pickingUp || !paired || !('caches' in window)) return;
  pickingUp = true;
  try {
    const shareCache = await caches.open('beam-share');
    const requests = await shareCache.keys();
    if (!requests.length) return;
    const conv = await chooseConv(`${plural(requests.length, 'shared item')}`);
    if (!conv) { await Promise.all(requests.map(r => shareCache.delete(r))); return; }
    openConv(conv);
    for (const request of requests) {
      const res = await shareCache.match(request);
      if (!res) continue;
      if (res.headers.get('X-Kind') === 'text') {
        try { await sendText(await res.text(), conv); await shareCache.delete(request); } catch (err) { toast(friendlyError(err), { error: true }); }
      } else {
        const blob = await res.blob();
        const file = new File([blob], decodeURIComponent(res.headers.get('X-Name') || 'file'), { type: blob.type });
        const up = enqueueUpload(file, conv);
        refreshPending();
        up.done.then(ok => { if (ok) shareCache.delete(request); });
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    pickingUp = false;
  }
}

// A one-time offer to turn on notifications, after something has arrived (a click is needed to ask).
function offerNotifications() {
  if (HOST || store.get('beam.notifyOffered') || !('Notification' in window) || !window.isSecureContext || Notification.permission !== 'default') return;
  if ($('#toast').classList.contains('show') || document.querySelector('dialog[open]')) return; // never over another message; next time

  store.set('beam.notifyOffered', '1');
  toast('Get a notification when something arrives while Beam is in the background?', {
    action: 'Turn on', ms: 9000,
    onAction: () => Notification.requestPermission().then(p => { if (p === 'granted') toast('Notifications are on'); }),
  });
}

// ---------------------------------------------------------------- start

// index.html#remote=<PC id>: this page is the remote control viewer (remote.js).
const RC_ID = (/^#remote=([A-Za-z0-9_-]{8,64})$/.exec(location.hash) || [])[1] || '';

// The viewer's script, only on its own page (1.12.2: the chat app never needs its ~130 KB, a quarter of what it
// loaded). index.html names it inside a <template> (inert: nothing loads), so the server gives it its version.
function loadViewer() {
  document.documentElement.classList.add('remote-mode'); // (the chat app's screens stay hidden meanwhile)
  const script = document.createElement('script');
  script.src = $('#viewerScript')?.content.querySelector('script')?.getAttribute('src') || 'remote.js';
  script.onload = () => startRemote();
  script.onerror = () => document.body.append(el('div', { id: 'remote', class: 'rc', 'data-state': 'ended' },
    el('div', { class: 'rc-body' }, el('div', { class: 'rc-overlay' }, el('div', { class: 'rc-card', role: 'alert' },
      el('strong', {}, 'The remote screen didn’t open'),
      el('p', {}, 'Beam couldn’t load it. Check the connection, then try again.'),
      el('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, 'Try again'))))));
  document.head.append(script);
}

async function init() {
  // index.html#remote=<PC id>: the remote control viewer, and nothing of the chat app (remote.js).
  if (RC_ID) return loadViewer();
  document.documentElement.classList.toggle('host', Boolean(HOST));
  const params = new URLSearchParams(location.search);
  const handoff = takeHandoff();
  if (params.get('approve')) sessionSet('beam.approve', params.get('approve'));
  const convParam = params.get('conv');
  const triedKey = params.has('key');
  const wantsPaste = params.get('action') === 'paste';
  const shareError = params.has('share-error');
  if ([...params.keys()].length) history.replaceState(history.state, '', BASE.pathname + location.hash);
  if (convParam) current = convParam;

  initIdentity();
  bindUI();
  bindHost();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // 1. What we had last time, right away (and when there's no connection at all). If another Beam answered here last
  // time, it lies dormant instead: nothing of it shows until its own Beam answers (Windows app window included).
  const cached = await cache.load();
  if (cached) {
    server.serverId = cached.meta.serverId || '';
    server.api = cached.meta.api || 2;
    if (Array.isArray(cached.meta.features)) server.features = new Set(cached.meta.features);
    if (cached.aside) { dormant = true; cacheDisabled = true; }
    else applyCached(cached);
  }
  await loadOutbox();

  // The first catch-up runs when the event stream opens (connect → sync), so a 1.3 server's whole list isn't
  // fetched twice. With nothing saved and a server that sends deltas, it starts at once instead: the stream's own
  // catch-up is then only a delta.
  if (HOST) {
    // The app says which Beam it's signed in to (its hello, a local round trip): if that's another one than the saved
    // history's, the history lies dormant from the start (nothing of it shown); the page's own answers settle the rest.
    await Promise.race([hostHello(), sleep(1500)]);
    const appBeam = hostState.settings?.server?.serverId;
    if (appBeam && cache.owner && appBeam !== cache.owner && !dormant) goDormant(appBeam);
    await showApp();
    loadServerInfo().then(() => { if (!cached) syncEarly(); });
    return;
  }

  if (handoff) await signInWithHandoff(handoff);

  // 2. Are we signed in? With a saved history we were: show it at once and ask the server meanwhile (a revoked
  // sign-in still ends on the sign-in page, a moment later). Without one, or with a dormant one, ask first.
  const early = Boolean(cached) && !dormant && !handoff && !triedKey;
  if (early) { loadServerInfo(); await showApp(); }
  const res = await fetch(url('api/me'), { headers: idHeaders(), credentials: 'same-origin', signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!res || res.status >= 502) {
    // Offline: show what we have; the connection keeps retrying (and asks for sign-in if needed).
    net.fail({ status: res?.status });
    if (!early) await showApp();
  } else if (res.status === 410) {
    onMoved((await res.json().catch(() => ({}))).movedTo);
  } else if (res.status === 401) {
    // Signed out (or revoked) while away: the saved history shown a moment ago goes, if it's this Beam's.
    await signedOutBy((await res.json().catch(() => ({}))).serverId);
    if (await tryAutopair()) return onSignedIn('autopair');
    showLock(triedKey ? 'That pairing link didn’t work (it may be used up or expired). Ask a signed-in device for a new one, or approve this device from there.' : undefined);
  } else {
    applyMe(await res.json().catch(() => ({})));
    if (!early) { await loadServerInfo(); await showApp(); if (!cached) syncEarly(); }
  }
  if (paired) {
    loadComposerDraft(current);
    pickUpShares();
    if (wantsPaste) pasteAndSend();
    if (shareError) toast('Couldn’t take that share (not enough storage on this device?).', { error: true });
  }
  window.launchQueue?.setConsumer(p => {
    if (!p?.targetURL) return;
    const q = new URL(p.targetURL).searchParams;
    if (q.get('approve') && paired) lookUpApproval(q.get('approve'));
    if (q.get('conv') && paired) openConv(q.get('conv'));
    if (q.get('action') === 'paste' && paired) pasteAndSend();
  });
}

// The saved history into memory (at start, or when its Beam answers again after it lay dormant).
function applyCached(cached) {
  setDevices(cached.devices);
  if (devices.length) devicesKnown = true;
  setItems(cached.items);
  knownNames = { ...(cached.names || {}), ...knownNames };
  if (cached.read) mergeReadMarks(cached.read);
  live.cursor = cache.cursor = cached.cursor; // a warm start catches up with a delta
}

function syncEarly() {
  if (firstSync && !syncing && serverHas('items-since')) sync('start');
}

init();
