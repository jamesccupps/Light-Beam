'use strict';
// (1.26, moved here in 1.28) Shared folders: the parts that need no server state. What another device may ask a PC
// (a shared folder's id, a folder inside it, file names, a search) and what a PC's answer may hold, names cleaned so a
// name can't pose as another. server.js relays the requests (POST /api/devices/{id}/files…) and the answers
// (POST /api/devices/me/files); the PC decides what's shared with whom (windows/src/SharedFolders.cs).

const APP_MIN = '1.18.0';   // Beam for Windows that shares folders
const APP_MORE = '1.20.0';  // ...and answers the 1.28 requests: icons, thumbnails, previews, search, whole folders
const SHARE_ID = /^[a-f0-9]{8}$/;
const REASONS = new Set(['not-shared', 'not-found', 'not-allowed', 'busy', 'error', 'no-preview']);
const MAX_ENTRIES = 2000;     // a folder's listing
const MAX_NAMES = 100;        // files or folders in one copy
const MAX_THUMBS = 24;        // thumbnails in one request
const MAX_THUMB_PX = 256;
const MAX_ICONS = 64;         // file types in one request
const MAX_RESULTS = 300;      // a search's results
const MAX_THUMB_B64 = 96 * 1024;
const MAX_ICON_B64 = 24 * 1024;
const MAX_PREVIEW_B64 = 14 * 1024 * 1024; // (a 10 MB PDF)
// What a preview may be: never html or svg (a page shows a preview from a blob: URL, which runs in Beam's origin).
const PREVIEW_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'text/plain', 'application/pdf']);
const PREVIEW_KINDS = new Set(['picture', 'text', 'pdf', 'video']);
const EXT = /^(?:\.[a-z0-9_+-]{1,16}|\/)$/; // a file type as ".pdf" ("/" = a folder)
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const bad = message => Object.assign(new Error(message), { status: 400 });

// A file's or folder's name as shown elsewhere: no control or bidi characters (a name can't pose as another).
const nameText = (v, max = 255) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '').slice(0, max) : '');
const base64Of = (v, max) => (typeof v === 'string' && v.length && v.length <= max && v.length % 4 === 0 && BASE64.test(v) ? v : null);
const count = v => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

// ------------------------------------------------------------------ what's asked

function shareOf(v, required) {
  if ((v === undefined || v === null || v === '') && !required) return '';
  if (typeof v !== 'string' || !SHARE_ID.test(v)) throw bad('share must be a shared folder’s id (from its list)');
  return v;
}

function pathOf(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || v.length > 1024 || /[\u0000-\u001f]/.test(v)) throw bad('path must be a folder inside the shared one, like "Photos/2026"');
  return v;
}

// Names in the folder: files or folders, or (1.28, from a search) inside one of its folders, like "2026/a.jpg".
function namesOf(v, max = MAX_NAMES) {
  if (!Array.isArray(v) || !v.length || v.length > max || !v.every(n => typeof n === 'string' && n && n.length <= 1024 && !/[\u0000-\u001f]/.test(n))) {
    throw bad(`names must be 1 to ${max} names in that folder`);
  }
  return v;
}

function searchOf(v) {
  if (typeof v !== 'string' || !v.trim() || v.length > 100 || /[\u0000-\u001f]/.test(v)) throw bad('q must be 1 to 100 characters of a name');
  return v.trim();
}

function extsOf(v) {
  if (!Array.isArray(v) || !v.length || v.length > MAX_ICONS || !v.every(e => typeof e === 'string' && EXT.test(e))) {
    throw bad(`exts must be 1 to ${MAX_ICONS} file types, like ".pdf" ("/" for a folder)`);
  }
  return [...new Set(v)];
}

const pxOf = v => (v === undefined ? 160 : Number.isInteger(v) && v >= 32 && v <= MAX_THUMB_PX ? v : (() => { throw bad(`px must be 32 to ${MAX_THUMB_PX}`); })());

// ------------------------------------------------------------------ what a PC answers

const entryOf = e => ({
  n: nameText(e.n), ...(e.dir === true && { dir: true }), s: count(e.s), m: Number.isFinite(e.m) ? Math.floor(e.m) : 0,
  ...(Number.isFinite(e.c) && { c: Math.floor(e.c) }),
});

// The fields this API has only, names cleaned.
function cleanAnswer(b) {
  if (b.ok !== true) return { ok: false, reason: REASONS.has(b.reason) ? b.reason : 'error', error: nameText(b.error, 300) };
  const out = { ok: true };
  if (Array.isArray(b.shares)) out.shares = b.shares.slice(0, 100).filter(s => s && SHARE_ID.test(s.id)).map(s => ({ id: s.id, name: nameText(s.name, 80) || 'Shared folder' }));
  if (typeof b.share === 'string' && SHARE_ID.test(b.share)) out.share = b.share;
  if (typeof b.name === 'string') out.name = nameText(b.name, 80);
  if (typeof b.path === 'string') out.path = nameText(b.path, 1024);
  if (Array.isArray(b.entries)) out.entries = b.entries.slice(0, MAX_ENTRIES).filter(e => e && typeof e === 'object' && nameText(e.n)).map(entryOf);
  if (b.more === true) out.more = true;
  if (Number.isInteger(b.sending) && b.sending >= 0) out.sending = Math.min(b.sending, MAX_NAMES);
  if (Array.isArray(b.skipped)) out.skipped = b.skipped.slice(0, MAX_NAMES).map(s => ({ n: nameText(s?.n, 1024), why: nameText(s?.why, 120) })).filter(s => s.n);
  // (1.28) thumbnails, icons, a preview, a search
  if (b.thumbs && typeof b.thumbs === 'object') {
    out.thumbs = {};
    for (const [n, v] of Object.entries(b.thumbs).slice(0, MAX_THUMBS)) { const d = base64Of(v, MAX_THUMB_B64); if (d && nameText(n) === n) out.thumbs[n] = d; }
  }
  if (Array.isArray(b.none)) out.none = b.none.slice(0, MAX_THUMBS).filter(n => typeof n === 'string' && nameText(n) === n && n);
  if (b.icons && typeof b.icons === 'object') {
    out.icons = {};
    for (const [e, v] of Object.entries(b.icons).slice(0, MAX_ICONS)) { const d = base64Of(v, MAX_ICON_B64); if (d && EXT.test(e)) out.icons[e] = d; }
  }
  if (b.types && typeof b.types === 'object') {
    out.types = {};
    for (const [e, v] of Object.entries(b.types).slice(0, MAX_ICONS)) { const n = nameText(v, 80); if (n && EXT.test(e)) out.types[e] = n; }
  }
  if (typeof b.data === 'string') {
    const data = base64Of(b.data, MAX_PREVIEW_B64);
    if (!data || !PREVIEW_TYPES.has(b.type) || !PREVIEW_KINDS.has(b.kind)) return { ok: false, reason: 'error', error: 'The PC’s preview wasn’t one Beam shows' };
    Object.assign(out, { data, type: b.type, kind: b.kind, size: count(b.size), ...(b.truncated === true && { truncated: true }) });
  }
  if (Array.isArray(b.results)) {
    out.results = b.results.slice(0, MAX_RESULTS).filter(e => e && typeof e === 'object' && nameText(e.n)).map(e => ({ p: nameText(e.p, 1024), ...entryOf(e) }));
  }
  return out;
}

module.exports = {
  APP_MIN, APP_MORE, MAX_NAMES, MAX_THUMBS, MAX_PREVIEW_B64,
  nameText, shareOf, pathOf, namesOf, searchOf, extsOf, pxOf, cleanAnswer,
};
