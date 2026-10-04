// Beam Family's app: starts up (join, sign in, or the app), finds its way (/c/<id>, /settings, /admin), keeps the
// live connection, and tells the server what's on screen (so what you're looking at isn't pushed to your phone).

import { h, fill, toast, isPhone, closeMenu } from './ui.js';
import { api } from './api.js';
import { state, on, applyBootstrap, applyEvent, channel, totals, sortedChannels, title } from './store.js';
import { sidebarView } from './sidebar.js';
import { conversationView } from './chat.js';
import { signInPage, joinPage, settingsView, adminView, panelView, openViewer, newConversation, setTheme } from './pages.js';
import { refreshPush } from './notify.js';
import { busy } from './uploads.js';
import { nav } from './nav.js';

const app = document.getElementById('app');
const EVENTS = ['msg', 'msg-edit', 'msg-del', 'react', 'read', 'typing', 'presence', 'people', 'channel', 'channel-gone', 'space', 'notify'];
let shell = null;
let mainView = null;
let panel = null;
let events = null;
let offlineTimer = null;

try { const t = localStorage.getItem('family.theme'); if (t) setTheme(t); } catch {}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  // A notification tapped while the app is open: go to that conversation.
  navigator.serviceWorker.addEventListener('message', e => { if (e.data?.type === 'navigate' && typeof e.data.url === 'string' && e.data.url.startsWith('/')) nav.go(e.data.url); });
}

function show(node) {
  app.removeAttribute('aria-busy');
  fill(app, node);
}

function showError(err) {
  show(h('div', { class: 'page' }, h('div', { class: 'card' }, h('img', { class: 'logo', src: '/icon.svg', alt: '' }), h('h1', {}, 'Can’t open Beam Family'),
    h('p', { class: 'lede' }, err.message), h('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, 'Try again'))));
}

async function boot() {
  const join = /^\/join\/([A-Za-z0-9_-]{16,64})\/?$/.exec(location.pathname);
  let session;
  try {
    session = await api('/api/session');
  } catch (err) {
    return showError(err);
  }
  if (join) return show(await joinPage(join[1], () => { location.href = '/'; }));
  if (!session.signedIn) return show(signInPage(session, () => location.reload()));
  try {
    applyBootstrap(await api('/api/bootstrap'));
  } catch (err) {
    return showError(err);
  }
  buildShell();
  connect();
  refreshPush();
  route();
  // (1.11.0) a step back that leaves the address as it was is an overlay's own (the viewer's): it closes that alone,
  // without the page being made again (that closed the gallery behind the viewer, and redrew the conversation)
  window.addEventListener('popstate', () => { if (location.pathname + location.search !== routedAt) route(); });
}

// ---------------------------------------------------------------- the frame and finding the way

function buildShell() {
  const side = sidebarView();
  const main = h('div', { class: 'main' });
  const el = h('div', { class: 'shell' }, side.el, main);
  shell = { el, side, main };
  show(el);
}

function setMain(view, inConversation) {
  mainView?.destroy();
  mainView = view;
  shell.main.replaceWith(view.el);
  shell.main = view.el;
  shell.el.classList.toggle('in-conv', inConversation);
}

function emptyMain() {
  setMain({ el: h('section', { class: 'main' }, h('div', { class: 'boot' }, h('img', { src: '/icon.svg', alt: '', width: 64, height: 64 }), h('p', {}, 'Choose a conversation'))), destroy() {} }, false);
}

function defaultChannel() {
  let last = null;
  try { last = localStorage.getItem('family.last'); } catch {}
  if (last && channel(last)) return last;
  return sortedChannels().text[0]?.id || sortedChannels().direct[0]?.id || null;
}

let routedAt = null;
function route() {
  routedAt = location.pathname + location.search;
  closeMenu();
  closePanel();
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  let m;
  if ((m = /^\/c\/([0-9A-HJKMNP-TV-Z]{26})$/.exec(path))) {
    const id = m[1];
    if (!channel(id)) {
      toast('That conversation isn’t there (any more)', { error: true });
      return nav.go('/', { replace: true });
    }
    state.current = id;
    try { localStorage.setItem('family.last', id); } catch {}
    shell.side.setActive(id);
    setMain(conversationView(id, { jump: params.get('m') }), true);
  } else if (path === '/settings') {
    state.current = null;
    shell.side.setActive(null);
    setMain(settingsView(), true);
  } else if (path === '/admin') {
    state.current = null;
    shell.side.setActive(null);
    setMain(adminView(), true);
  } else {
    state.current = null;
    // A computer opens the last conversation; a phone shows the list.
    const id = isPhone() ? null : defaultChannel();
    if (id) return nav.go(`/c/${id}`, { replace: true });
    shell.side.setActive(null);
    emptyMain();
  }
  sendFocus();
  updateTitle();
}

nav.go = (path, { replace = false } = {}) => {
  if (path === location.pathname + location.search && !replace) return route();
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  route();
};

function closePanel() {
  if (!panel) return;
  panel.destroy();
  panel.el.remove();
  panel = null;
}

nav.panel = (kind, opts = {}) => {
  const same = panel?.kind === kind && panel.channel === (opts.channel || null);
  closePanel();
  if (same) return;
  const view = panelView(kind, opts, closePanel);
  panel = { ...view, kind, channel: opts.channel || null };
  shell.el.append(view.el);
};
nav.viewer = (items, i) => openViewer(items, i);
nav.newConversation = () => newConversation();

// ---------------------------------------------------------------- the live connection

function connect() {
  events?.close();
  events = new EventSource('/api/events');
  events.addEventListener('hello', e => {
    const d = JSON.parse(e.data);
    if (d.version && state.pageVersion && d.version !== state.pageVersion) reloadWhenIdle();
    state.client = d.client;
    state.connected = true;
    clearTimeout(offlineTimer);
    document.querySelector('.offline-bar')?.remove();
    sendFocus();
  });
  events.addEventListener('resync', () => resync());
  for (const type of EVENTS) events.addEventListener(type, e => { try { applyEvent(type, JSON.parse(e.data)); } catch (err) { console.error(err); } });
  events.onerror = () => {
    state.connected = false;
    clearTimeout(offlineTimer);
    // Shown only if it lasts (a server restart, the phone switching networks).
    offlineTimer = setTimeout(() => {
      if (state.connected || document.querySelector('.offline-bar')) return;
      shell?.el.prepend(h('div', { class: 'offline-bar', style: { gridColumn: '1 / -1' } }, 'Reconnecting…'));
    }, 4000);
    // A refused stream (signed out, turned off) doesn't come back by itself.
    if (events.readyState === EventSource.CLOSED) setTimeout(checkSession, 2000);
  };
}

// (1.8.5) Beam Family was updated: this page runs the app it loaded, so it reloads, once nothing is being sent from it
// (a file in the tray or a message on its way) and nobody is typing (a draft is kept anyway).
let reloading = false;
function reloadWhenIdle() {
  if (reloading) return;
  reloading = true;
  const now = () => {
    const typing = document.activeElement?.matches?.('textarea, input') && document.activeElement.value;
    if (!busy.size && !document.querySelector('.msg.pending') && !typing) location.reload();
    else setTimeout(now, 5000);
  };
  now();
}

// Everything again (the server restarted, or too much was missed): conversations, counts, the one on screen.
async function resync() {
  try {
    applyBootstrap(await api('/api/bootstrap'));
    for (const cache of state.messages.values()) cache.loaded = false;
    route();
  } catch {}
}

async function checkSession() {
  try {
    const s = await api('/api/session');
    if (!s.signedIn) return location.reload();
    connect();
  } catch {
    setTimeout(checkSession, 5000);
  }
}
window.addEventListener('family:signed-out', () => { if (shell) checkSession(); });

// What's on screen, for the server (no push for a conversation that's being looked at).
function sendFocus() {
  if (!state.client) return;
  const visible = document.visibilityState === 'visible';
  api('/api/focus', { method: 'PUT', body: { client: state.client, channel: state.current, visible } }).catch(() => {});
}
document.addEventListener('visibilitychange', () => {
  sendFocus();
  // Back after a while (a phone in a pocket): the stream may have died quietly.
  if (document.visibilityState === 'visible' && events?.readyState === EventSource.CLOSED) checkSession();
});

// ---------------------------------------------------------------- title and badge

function updateTitle() {
  const { unread, mentions } = totals();
  const space = state.spaces[0]?.name || 'Beam Family';
  const c = state.current && channel(state.current);
  document.title = `${mentions ? `(${mentions}) ` : unread ? '• ' : ''}${c ? `${c.kind === 'text' ? '#' : ''}${title(c)} · ` : ''}${space}`;
  if ('setAppBadge' in navigator) (mentions ? navigator.setAppBadge(mentions) : navigator.clearAppBadge?.())?.catch?.(() => {});
}
on('unread', updateTitle);
on('channels', updateTitle);

// Ctrl+K: search.
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && shell) {
    e.preventDefault();
    nav.panel('search', {});
  }
});

boot();
