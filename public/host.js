'use strict';
// Host mode: the page is the Windows app's messenger window (WebView2). The page ⇄ host contract is
// docs/HOST-BRIDGE.md (bridge v1). In an ordinary browser none of this runs.

const hostState = {
  ready: false,
  app: '', version: '',
  settings: null,
  update: null,
  conn: null,
  transfers: new Map(), // transfer id -> Transfer
  localFiles: new Set(), // item ids saved on this PC
};

let hostSeq = 0;
const hostWaiting = new Map();

function hostCall(type, fields = {}, files) {
  if (!HOST) return Promise.reject(new Error('Not running in the Beam app'));
  const id = ++hostSeq;
  const msg = { type, id, ...fields };
  return new Promise((resolve, reject) => {
    hostWaiting.set(id, { resolve, reject });
    try {
      if (files && files.length) window.chrome.webview.postMessageWithAdditionalObjects(msg, files);
      else window.chrome.webview.postMessage(msg);
    } catch (err) {
      hostWaiting.delete(id);
      reject(err);
    }
  });
}

// Fire-and-forget messages (read, viewing, unauthorized, moved, log).
function hostPost(type, fields = {}) {
  if (!HOST) return;
  try { window.chrome.webview.postMessage({ type, ...fields }); } catch {}
}

function hostLog(level, message) { hostPost('log', { level, message }); }

// A host call that reports failures as a toast (except "cancelled").
async function hostDo(type, fields, files) {
  try {
    return await hostCall(type, fields, files);
  } catch (err) {
    if (err.code !== 'cancelled') toast(err.message || 'The Beam app couldn’t do that.', { error: true });
    return null;
  }
}

function bindHost() {
  if (!HOST) return;
  window.chrome.webview.addEventListener('message', e => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'reply') {
      const w = hostWaiting.get(m.id);
      hostWaiting.delete(m.id);
      if (w) m.ok ? w.resolve(m.result) : w.reject(Object.assign(new Error(m.error || 'The Beam app couldn’t do that.'), { code: m.code }));
      return;
    }
    onHostEvent(m);
  });
}

async function hostHello() {
  if (!HOST) return;
  try {
    const state = await hostCall('hello', { bridge: 1 });
    applyHostState(state || {});
  } catch (err) {
    hostLog('error', `hello failed: ${err.code || 'error'}`);
  }
}

function applyHostState(state) {
  hostState.ready = true;
  hostState.app = state.app || HOST.app || 'windows';
  hostState.version = state.version || HOST.version || '';
  if (state.deviceName && cleanName(state.deviceName) !== me.name) setDeviceName(state.deviceName, { chosen: true });
  if (state.settings) hostState.settings = state.settings;
  if (state.update) hostState.update = state.update;
  if (state.conn) hostState.conn = state.conn;
  hostState.transfers.clear();
  for (const t of state.transfers || []) if (t && t.id) hostState.transfers.set(t.id, t);
  hostState.localFiles = new Set(Object.entries(state.localFiles || {}).filter(([, v]) => v).map(([k]) => k));
  refreshPending();
  patchAllFileActions();
  renderBanner(); // (1.16.1: apps waiting for an answer here)
  if ($('#settingsDlg').open) renderSettings();
  hostViewing();
}

function onHostEvent(m) {
  switch (m.type) {
    case 'navigate': {
      const conv = m.conversation || 'all';
      openConv(conv);
      if (m.itemId) revealItem(m.itemId, { highlight: true });
      if (m.focusComposer) $('#text').focus();
      break;
    }
    case 'openPhoneNotification':
      // A click on the app's balloon for a phone notification: the Phone panel, that one selected, its reply box
      // focused (once this device's list says it shows them).
      if (!openPhone({ select: m.id || '', focus: true })) phone.pendingOpen = m.id || '';
      break;
    case 'transfer':
      if (m.transfer && m.transfer.id) {
        hostState.transfers.set(m.transfer.id, m.transfer);
        upsertTransferRow(m.transfer);
      }
      break;
    case 'transferRemoved':
      hostState.transfers.delete(m.transferId);
      transferNodes.delete(m.transferId);
      removePendingRow(`tr:${m.transferId}`);
      break;
    case 'localFile':
      if (m.saved) hostState.localFiles.add(m.itemId); else hostState.localFiles.delete(m.itemId);
      patchFileActions(m.itemId);
      break;
    case 'settings':
      hostState.settings = m.settings || hostState.settings;
      if (m.settings?.deviceName && cleanName(m.settings.deviceName) !== me.name) setDeviceName(m.settings.deviceName, { chosen: true });
      renderBanner(); // (1.16.1: an app's question came or went)
      if ($('#settingsDlg').open) renderSettings();
      break;
    case 'update':
      hostState.update = m.update || null;
      if ($('#settingsDlg').open) renderSettings();
      break;
    case 'conn':
      hostState.conn = m.conn || null;
      break;
    case 'dragOutDone':
      ownDragEnded(); // the app's drag of a file out of the chat ended (send.js)
      break;
    case 'openPanel':
      // The tray's "Settings" and "Add a device…".
      for (const d of $$('dialog[open]')) if (d.id !== 'approveDlg') d.close();
      if (m.panel === 'pair') openPairDialog();
      else if (m.panel === 'settings') openSettings('pc');
      break;
    default:
      break; // unknown events are ignored (forward compatibility)
  }
}

// Which conversation is on screen, so the app doesn't notify about it while the window is focused.
function hostViewing() {
  if (!HOST) return;
  // The Phone panel counts as a conversation of its own: while it's on screen the app shows no phone balloons.
  if (phonePanelOpen()) hostPost('viewing', { conversation: 'phone', visible: !document.hidden && !$('#app').hidden && (!NARROW.matches || $('#app').classList.contains('in-thread')) });
  else hostPost('viewing', { conversation: current, visible: !document.hidden && threadVisible() });
}

const isSaved = itemId => hostState.localFiles.has(itemId);
