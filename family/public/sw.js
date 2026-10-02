// Beam Family's service worker: notifications (Web Push) and opening the right conversation when one is tapped;
// the app's own files kept for a quick start (the server is always asked first when it can be reached).

const CACHE = 'family-v1';
const SHELL = ['/', '/style.css', '/app.js', '/ui.js', '/api.js', '/store.js', '/text.js', '/emoji.js', '/uploads.js', '/notify.js', '/nav.js', '/chat.js', '/sidebar.js', '/pages.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// The app's files: from the server when it answers (fresh), from the cache otherwise. The API is never cached.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
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
