// Beam service worker: an offline copy of the app (so it opens instantly and without a connection), the Android
// share target, and notification clicks. Paths are relative to where Beam lives, so it also works under /beam/.
'use strict';

const SHELL_CACHE = 'beam-shell-v5';
const SHARE_CACHE = 'beam-share';
const SCOPE = self.registration.scope;
const ROOT = new URL('./', SCOPE).href;
const SHELL = ['./', 'style.css', 'core.js', 'cache.js', 'model.js', 'host.js', 'thread.js', 'send.js', 'live.js', 'signin.js',
  'settings.js', 'devices.js', 'phone.js', 'extras.js', 'gallery.js', 'remote.js', 'app.js', 'icon.svg', 'icon-180.png', 'icon-192.png', 'manifest.webmanifest'].map(p => new URL(p, SCOPE).href);
const EXTRA = ['icon-192.png'].map(p => new URL(p, SCOPE).href); // not named by the page, but needed offline (notifications)
const TIMEOUT_MS = 3000;
const isShell = u => SHELL.includes(u.split(/[?#]/)[0]);
// Beam 1.4 servers name the app's files with ?v=<hash of the file>: such an address never changes its content.
const isVersioned = u => new URL(u).searchParams.has('v');
// The server marks only the current version immutable; an old ?v= gets today's bytes (no-cache). Those must not be
// kept under the old name, nor push the current version out.
const isCurrentVersion = res => res.ok && /\bimmutable\b/.test(res.headers.get('cache-control') || '');

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // The page as it is now, and exactly the files it names: the versioned ones come straight from the browser's
    // cache (the page has just loaded them); the others are revalidated (a 304) rather than downloaded twice.
    let wanted = SHELL;
    const page = await fetch(ROOT, { cache: 'no-cache', credentials: 'same-origin' }).catch(() => null);
    if (page && page.ok) {
      const html = await page.clone().text();
      await cache.put(ROOT, page);
      const named = [...html.matchAll(/\b(?:src|href)="([^"#:]+)"/g)].map(m => new URL(m[1], ROOT).href).filter(isShell);
      if (named.length) wanted = [...new Set([...named, ...EXTRA])];
    }
    await Promise.all(wanted.filter(u => u !== ROOT).map(u => fetch(u, { cache: isVersioned(u) ? 'default' : 'no-cache', credentials: 'same-origin' })
      .then(res => ((isVersioned(u) ? isCurrentVersion(res) : res.ok) ? cache.put(u, res) : null)).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== SHELL_CACHE && name !== SHARE_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const u = new URL(req.url);
  if (u.origin !== location.origin || !req.url.startsWith(SCOPE)) return;
  const rel = req.url.slice(SCOPE.length).split(/[?#]/)[0];
  if (req.method === 'POST' && rel === 'share') { event.respondWith(receiveShare(req)); return; }
  if (req.method !== 'GET' || /^(api|download)\//.test(rel)) return;
  if (req.mode === 'navigate') { event.respondWith(navigate(event)); return; }
  if (isShell(req.url)) event.respondWith(isVersioned(req.url) ? versioned(event) : asset(event));
});

// A versioned file: from the cache when it's there (no network at all), otherwise fetched and kept by its full
// address, and the older versions of the same file are dropped.
async function versioned(event) {
  const req = event.request;
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req.url, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (isCurrentVersion(res)) {
    event.waitUntil((async () => {
      await cache.put(req.url, res.clone());
      const path = req.url.split('?')[0];
      for (const old of await cache.keys()) if (old.url !== req.url && old.url.split('?')[0] === path) await cache.delete(old);
    })().catch(() => {}));
  }
  return res;
}

// Races the network against a timer; the network answer still updates the cache when it arrives late.
function withTimeout(promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS);
    promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

// The page: network first (so updates show up at once), but after 3 s, on a network error or when a proxy says
// the server is down (5xx), the saved copy opens instead and tells the page it came from the cache.
async function navigate(event) {
  const req = event.request;
  const isRoot = req.url.split(/[?#]/)[0] === ROOT;
  const network = fetch(req);
  const save = network.then(async res => {
    if (isRoot && res.ok && res.type === 'basic' && (res.headers.get('content-type') || '').includes('text/html')) await keep(ROOT, res);
  }).catch(() => {});
  event.waitUntil(save);
  try {
    const res = await withTimeout(network);
    if (res.status >= 500) return (await shell()) || res;
    return res;
  } catch {
    return (await shell()) || offlinePage();
  }
}

async function shell() {
  const cached = await caches.match(ROOT);
  if (!cached) return null;
  const text = await cached.text();
  return new Response(text.replace('<html lang="en"', '<html lang="en" data-shell="cache"'), { status: 200, headers: cached.headers });
}

function offlinePage() {
  return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Beam</title>'
    + '<body style="font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;text-align:center">'
    + '<div><h1>Can’t reach Beam</h1><p>Check that this device is online (and that Tailscale is connected), then reload.</p></div>',
  { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// Stores a fresh copy, unless it's the one already stored (a revalidated file comes back as the same response,
// and rewriting the whole app on every open is pointless disk work).
async function keep(key, res) {
  const cache = await caches.open(SHELL_CACHE);
  const tag = res.headers.get('etag');
  if (tag && (await cache.match(key))?.headers.get('etag') === tag) return;
  await cache.put(key, res.clone());
}

async function asset(event) {
  const req = event.request;
  const network = fetch(req).then(async res => {
    if (res.ok) await keep(req.url.split(/[?#]/)[0], res);
    return res;
  });
  event.waitUntil(network.catch(() => {}));
  try {
    const res = await withTimeout(network);
    if (res.status >= 500) return (await caches.match(req.url.split(/[?#]/)[0])) || res;
    return res;
  } catch {
    return (await caches.match(req.url.split(/[?#]/)[0])) || Response.error();
  }
}

// Stash shared files/text, then open the app, which asks where they go and uploads them with a progress bar.
async function receiveShare(request) {
  try {
    const form = await request.formData();
    const cache = await caches.open(SHARE_CACHE);
    const batch = Date.now();
    let n = 0;
    for (const file of form.getAll('files')) {
      if (typeof file === 'string') continue;
      await cache.put(new URL(`__share/${batch}/${n++}`, SCOPE).href, new Response(file, {
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Name': encodeURIComponent(file.name || 'file') },
      }));
    }
    // Apps disagree on which field holds what; prefer text/url and only fall back to the title.
    const field = key => String(form.get(key) || '').trim();
    let parts = [field('text'), field('url')].filter(Boolean);
    parts = parts.filter((p, i) => !parts.some((q, j) => j !== i && q.includes(p) && (q !== p || j < i)));
    if (!parts.length && !n && field('title')) parts = [field('title')];
    if (parts.length) {
      await cache.put(new URL(`__share/${batch}/text`, SCOPE).href, new Response(parts.join('\n'), {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Kind': 'text' },
      }));
    }
    return Response.redirect(new URL(`./?share=${batch}`, SCOPE).href, 303);
  } catch {
    return Response.redirect(new URL('./?share-error=1', SCOPE).href, 303);
  }
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const message = data.approve ? { type: 'approve', code: data.approve } : { type: 'open', conv: data.conv || 'all', itemId: data.itemId };
    if (windows.length) {
      await windows[0].focus();
      windows[0].postMessage(message);
      return;
    }
    const q = data.approve ? `?approve=${encodeURIComponent(data.approve)}` : `?conv=${encodeURIComponent(data.conv || 'all')}`;
    await self.clients.openWindow(new URL(`./${q}`, SCOPE).href);
  })());
});
