'use strict';
// (1.31) Sites: the web pages the user's machines serve over Tailscale (the user, 2026-11-06: every Tailscale site they have,
// listed in Beam). Each Beam for Windows finds the pages its own PC
// serves to the tailnet (status `sites`); the user adds others by hand (a Raspberry Pi's, a NAS's). The server checks
// each one when someone looks at the list: does it answer, its title, its icon. Nothing here keeps state.

const PAGE_LIMIT = 256 * 1024; // the most of a page read for its title and icon
const ICON_LIMIT = 32 * 1024; // the biggest icon kept (as a data: URL in the list)
const NAME_MAX = 60;
const URL_MAX = 500;

// One line of text: no control or direction characters, spaces collapsed, at most `max` characters.
function oneLine(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.toWellFormed().replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩‎‏؜]/g, ' ').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, max).join('').trim();
}

const siteName = v => oneLine(v, NAME_MAX);

// An address the user typed: http(s) only, no user name or password in it, no #part. "shop-desktop:8000" means http.
function parseSiteUrl(v) {
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (!s || s.length > URL_MAX || /[\s\u0000-\u001f\u007f]/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || !u.hostname) return null;
  u.hash = '';
  return u.href.length > URL_MAX ? null : u.href;
}

// "shop-desktop:8000" for http://shop-desktop.tail1234.ts.net:8000/: what the list shows under a site's name.
function shortHost(href) {
  try {
    const u = new URL(href);
    const host = /\.ts\.net$/i.test(u.hostname) ? u.hostname.split('.')[0] : u.hostname;
    const path = u.pathname !== '/' ? u.pathname : '';
    return `${u.protocol === 'https:' ? 'https://' : ''}${host}${u.port ? `:${u.port}` : ''}${path}`;
  } catch { return href; }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', middot: '·', bull: '•', hellip: '…', copy: '©', reg: '®' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// The page's <title>, as one line of at most 80 characters ('' when it has none).
function pageTitle(html) {
  const m = /<title[^>]*>([^<]{0,2000})/i.exec(html);
  return m ? oneLine(decodeEntities(m[1]), 80) : '';
}

// Where the page's icon is: a PNG/ICO it links (rel="icon", "shortcut icon", "apple-touch-icon"), else /favicon.ico.
// An SVG one is passed over (Android can't draw it, and it can carry script).
function iconHref(html, base) {
  const links = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (/\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1] || '').toLowerCase();
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (!/\bicon\b/.test(rel) || !href) continue;
    const value = decodeEntities(href[1] ?? href[2] ?? href[3] ?? '').trim();
    const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1] || '').toLowerCase();
    if (!value || /^data:/i.test(value) || type.includes('svg') || /\.svg(\?|#|$)/i.test(value)) continue;
    links.push({ value, touch: rel.includes('apple-touch'), size: parseInt(/\bsizes\s*=\s*["']?(\d+)/i.exec(tag)?.[1], 10) || 0 });
  }
  // A small icon of the page's own first (what a browser tab shows); an apple-touch one is bigger but sharper
  links.sort((a, b) => (a.touch - b.touch) || (Math.abs((a.size || 32) - 48) - Math.abs((b.size || 32) - 48)));
  for (const l of links) {
    try {
      const u = new URL(l.value, base);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    } catch {}
  }
  try { return new URL('/favicon.ico', base).href; } catch { return null; }
}

// What an image's first bytes say it is (never what the server's header claims).
function imageType(b) {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && b[4] > 0) return 'image/x-icon';
  return null;
}

// Reads at most `limit` bytes of an answer, then lets the connection go. Resolves the bytes and whether there were more.
async function readSome(stream, limit) {
  const chunks = [];
  let bytes = 0;
  let more = false;
  try {
    for await (const chunk of stream) {
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes > limit) { more = true; break; }
    }
  } finally {
    stream.destroy();
  }
  return { body: Buffer.concat(chunks).subarray(0, limit), more };
}

function withDeadline(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => { onTimeout?.(); reject(new Error('timed out')); }, ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Why a check failed, in words for the list.
function problemOf(err) {
  const code = err?.code || '';
  if (code === 'ECONNREFUSED') return 'nothing answers on that port';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'no machine by that name';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'the machine can’t be reached';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code) || /certificate/i.test(err?.message || '')) return 'its certificate isn’t trusted';
  if (code === 'ECONNRESET') return 'it closed the connection';
  if (/timed out/i.test(err?.message || '') || code === 'ETIMEDOUT') return 'it didn’t answer in time';
  return 'it didn’t answer';
}

// Checks one site: { up, status?, title?, iconUrl?, ms, problem? }. One redirect on the same machine is followed for
// the title (a sign-in page's title is the site's too).
async function checkSite(request, href, { timeout = 5000 } = {}) {
  const started = Date.now();
  let url = href;
  for (let hop = 0; hop < 2; hop++) {
    let res;
    try {
      res = await withDeadline(request(url, { headers: { Accept: 'text/html,*/*;q=0.5', 'User-Agent': 'Beam (checking your sites)' }, timeout }), timeout);
    } catch (err) {
      return { up: false, ms: Date.now() - started, problem: problemOf(err) };
    }
    const status = res.status;
    if (status >= 300 && status < 400 && res.headers.location && hop === 0) {
      res.stream.resume();
      let next;
      try { next = new URL(res.headers.location, url); } catch { next = null; }
      if (next && (next.protocol === 'http:' || next.protocol === 'https:') && next.hostname === new URL(url).hostname) { url = next.href; continue; }
      return { up: true, status, ms: Date.now() - started };
    }
    const type = String(res.headers['content-type'] || '').toLowerCase();
    let title = '';
    let iconUrl = null;
    if (type.includes('html')) {
      try {
        const { body } = await withDeadline(readSome(res.stream, PAGE_LIMIT), Math.max(500, timeout - (Date.now() - started)), () => res.stream.destroy());
        const html = body.toString('utf8');
        title = pageTitle(html);
        iconUrl = iconHref(html, url);
      } catch {}
    } else {
      res.stream.resume();
      try { iconUrl = new URL('/favicon.ico', url).href; } catch {}
    }
    const up = status < 500;
    return { up, status, ms: Date.now() - started, ...(title && { title }), ...(iconUrl && { iconUrl }), ...(!up && { problem: `it answered with an error (${status})` }) };
  }
  return { up: true, ms: Date.now() - started };
}

// The icon at iconUrl as a data: URL, or null (missing, too big, or not an image).
async function fetchIcon(request, iconUrl, { timeout = 4000 } = {}) {
  try {
    const res = await withDeadline(request(iconUrl, { headers: { Accept: 'image/*', 'User-Agent': 'Beam (checking your sites)' }, timeout }), timeout);
    if (res.status !== 200) { res.stream.resume(); return null; }
    const { body, more } = await withDeadline(readSome(res.stream, ICON_LIMIT), timeout, () => res.stream.destroy());
    const type = !more && body.length > 0 ? imageType(body) : null;
    return type ? `data:${type};base64,${body.toString('base64')}` : null;
  } catch {
    return null;
  }
}

module.exports = { parseSiteUrl, siteName, shortHost, pageTitle, iconHref, imageType, checkSite, fetchIcon, oneLine, NAME_MAX };
