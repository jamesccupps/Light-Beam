// Beam Family's service worker: notifications (Web Push) and opening the right conversation when one is tapped;
// the app's own files kept for a quick start (the server is always asked first when it can be reached).

const CACHE = 'family-v1';
const SHELL = ['/', '/style.css', '/app.js', '/ui.js', '/api.js', '/store.js', '/text.js', '/emoji.js', '/uploads.js', '/direct.js', '/saving.js', '/downloads.js', '/gallery.js', '/fastlinks.js', '/notify.js', '/nav.js', '/chat.js', '/sidebar.js', '/pages.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// (1.9.0) A fast link's page saving a file that arrives in pieces over a direct connection: it hands this worker a
// port, then asks for /f/save/<id>; the answer is a stream of what the page sends down the port, which the browser
// saves as a download (how a phone's browser writes such a file). 'ping' only keeps this worker running meanwhile.
const saves = new Map();
self.addEventListener('message', e => {
  const d = e.data;
  if (d?.type === 'download' && e.ports?.[0] && /^[a-z0-9]{4,16}$/.test(String(d.id))) {
    saves.set(d.id, { name: String(d.name || 'file'), size: Number(d.size) || 0, port: e.ports[0] });
  }
});

function saving(id) {
  const s = saves.get(id);
  if (!s) return null;
  saves.delete(id);
  const body = new ReadableStream({
    start(ctrl) {
      s.port.onmessage = ev => {
        const m = ev.data;
        if (m === 'end') ctrl.close();
        else if (m && m.error) ctrl.error(new Error(m.error));
        else ctrl.enqueue(m instanceof Uint8Array ? m : new Uint8Array(m));
      };
    },
    cancel() { s.port.postMessage('cancel'); },
  });
  const headers = { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(s.name)}`, 'Cache-Control': 'no-store' };
  if (s.size) headers['Content-Length'] = String(s.size);
  return new Response(body, { headers });
}

// The app's files: from the server when it answers (fresh), from the cache otherwise. The API is never cached.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin === location.origin && url.pathname.startsWith('/f/save/')) {
    const res = saving(url.pathname.slice('/f/save/'.length));
    if (res) e.respondWith(res);
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const page = e.request.mode === 'navigate';
  if (!page && !SHELL.includes(url.pathname) && !/\.(png|svg|js|css)$/.test(url.pathname)) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok && !page) caches.open(CACHE).then(c => c.put(e.request, res.clone())).catch(() => {});
      return res;
    } catch {
      return (await caches.match(page ? '/' : e.request)) || Response.error();
    }
  })());
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  if (d.kind !== 'msg') return;
  e.waitUntil((async () => {
    // The conversation is on screen in a window that's in front: no notification.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some(w => w.visibilityState === 'visible' && w.focused && new URL(w.url).pathname === d.url)) return;
    await self.registration.showNotification(d.title || 'Beam Family', {
      body: d.body || '',
      tag: d.channel, // one per conversation: a newer message replaces the older one
      renotify: true,
      icon: '/icon-192.png',
      badge: '/badge-96.png',
      data: { url: d.url || '/' },
      timestamp: Date.now(),
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(w => new URL(w.url).origin === location.origin);
    if (open) {
      await open.focus();
      open.postMessage({ type: 'navigate', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
