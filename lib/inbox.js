'use strict';
// (1.33) The alerts inbox: what an app posts to Beam, read as an ntfy server reads it (https://docs.ntfy.sh/publish/),
// so programs that already talk to ntfy only need their server and topic changed (the user's SHOPTrend, Stock Watcher,
// LocalCast), and a JSON webhook read for its title, text and link (PingerPlot, Stock Watcher's "JSON to any address",
// the print server's notify_url, Home Assistant). Pure functions: server.js does the keys, storage and events.
//
// ntfy's ways in: text in the body with the title, priority, tags, click URL and actions in headers (X-Title, Title,
// t, …: case-insensitive) or lowercase query parameters; JSON at the server's root with the topic in it; GET
// /<topic>/publish|send|trigger with query parameters. A message is up to 4,096 bytes (ntfy makes a longer one an
// attachment; here it's cut), a title 250 characters, tags 512 bytes in all. Kept of the rest: `view` actions (a label
// and an http(s) link) and an attachment's link (never fetched). Not kept: icons, Markdown (shown as text), delays
// (delivered now), sequence ids, e-mail, calls, other actions.

const EMOJI = require('./emoji');
const { trimEnds } = require('./trim');

const TEXT_MAX_BYTES = 4096;
const TITLE_MAX = 250;
const TAGS_MAX_BYTES = 512;
const TAGS_MAX = 10;
const URL_MAX = 2000;
const ACTIONS_MAX = 3;
const LABEL_MAX = 40;
const PRIORITY_NAMES = Object.freeze({ min: 1, low: 2, default: 3, high: 4, max: 5, urgent: 5 });
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const isSpace = c => /\s/.test(c);

class InboxError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const bad = message => new InboxError(400, 40000, message);

// One line: no control or direction characters, spaces folded, cut to `max` characters (never half a character).
function oneLine(v, max) {
  if (v === undefined || v === null) return '';
  const s = String(v).toWellFormed().replace(BIDI, '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ');
  const folded = trimEnds(s.replace(/ {2,}/g, ' '), isSpace);
  const chars = [...folded];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : folded;
}

// Text: line breaks and tabs stay (\r\n as \n), other control and direction characters go; cut to TEXT_MAX_BYTES of
// UTF-8 (on a character), with "…" when it was longer.
function multiline(v) {
  if (v === undefined || v === null) return '';
  let s = String(v).toWellFormed().replace(BIDI, '').replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  s = trimEnds(s, isSpace);
  if (Buffer.byteLength(s) <= TEXT_MAX_BYTES) return s;
  const buf = Buffer.from(s).subarray(0, TEXT_MAX_BYTES - 3);
  return `${buf.toString('utf8').replace(/\ufffd$/, '')}…`;
}

// A header as sent: raw UTF-8 (Node reads header bytes as Latin-1), or RFC 2047 (=?UTF-8?B?…?= / =?UTF-8?Q?…?=), as ntfy
// takes them.
function headerText(v) {
  if (typeof v !== 'string') return v;
  const words = /=\?utf-8\?([bq])\?([^?]*)\?=/gi;
  if (words.test(v)) {
    // (the space between two encoded words isn't part of the text)
    return v.replace(/(\?=)[ \t]+(?==\?)/g, '$1').replace(words, (_, kind, data) => (kind.toLowerCase() === 'b' ? Buffer.from(data, 'base64')
      : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16))), 'latin1')).toString('utf8'));
  }
  if (!/[\u0080-\u00ff]/.test(v)) return v;
  const utf8 = Buffer.from(v, 'latin1').toString('utf8');
  return utf8.includes('\ufffd') ? v : utf8;
}

// A parameter from the headers (any case, as Node lowercases them) or the query (lowercase), by any of its names.
function param(headers, query, names) {
  for (const n of names) {
    const h = headers[n];
    if (h !== undefined) return headerText(Array.isArray(h) ? h.join(',') : h);
  }
  for (const n of names) if (query && query.has(n)) return query.get(n);
  return undefined;
}

const NAMES = {
  message: ['x-message', 'message', 'm'],
  title: ['x-title', 'title', 't'],
  priority: ['x-priority', 'priority', 'prio', 'p'],
  tags: ['x-tags', 'tags', 'tag', 'ta'],
  click: ['x-click', 'click'],
  actions: ['x-actions', 'actions', 'action'],
  attach: ['x-attach', 'attach', 'a'],
  filename: ['x-filename', 'filename', 'file', 'f'],
};

// 1-5, from a number or ntfy's names (min, low, default, high, max, urgent). Missing: 3. Wrong: a 400, as ntfy.
function priorityOf(v) {
  if (v === undefined || v === null || v === '') return 3;
  const s = String(v).trim().toLowerCase();
  if (/^[1-5]$/.test(s)) return Number(s);
  if (Object.hasOwn(PRIORITY_NAMES, s)) return PRIORITY_NAMES[s];
  throw bad('invalid priority');
}

// Tags (a list, or comma-separated): the ones that are emoji names become their emoji (in front of the title, as ntfy
// shows them); the others stay tags.
function tagsOf(v) {
  if (v === undefined || v === null || v === '') return { emojis: '', tags: [] };
  const list = (Array.isArray(v) ? v : String(v).split(',')).map(t => oneLine(t, 64)).filter(Boolean);
  if (Buffer.byteLength(list.join(',')) > TAGS_MAX_BYTES) throw bad('tags too long (512 bytes at most)');
  let emojis = '';
  const tags = [];
  for (const t of list.slice(0, TAGS_MAX)) {
    const name = t.toLowerCase();
    if (Object.hasOwn(EMOJI, name)) emojis += EMOJI[name];
    else if (!tags.includes(t)) tags.push(t.slice(0, 40));
  }
  return { emojis, tags };
}

// An http(s) link, or null (anything else is dropped: no javascript:, file: or app links).
function linkOf(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > URL_MAX) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return u.href;
}

// ntfy's actions, as JSON or its header format ("view, Open, https://…; http, …"): the `view` ones (a label and a
// link), three at most.
function actionsOf(v) {
  if (v === undefined || v === null || v === '') return [];
  let list = v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('[')) {
      try { list = JSON.parse(s); } catch { throw bad('invalid actions'); }
    } else {
      list = splitQuoted(s, ';').map(part => {
        const fields = splitQuoted(part, ',').map(f => f.trim());
        const out = {};
        const loose = [];
        for (const f of fields) {
          const eq = f.indexOf('=');
          const key = eq > 0 ? f.slice(0, eq).trim().toLowerCase() : '';
          if (eq > 0 && /^[a-z.]+$/.test(key) && !/^https?:/i.test(f)) out[key] = unquote(f.slice(eq + 1).trim());
          else loose.push(unquote(f));
        }
        // short format: <action>, <label>, <url>
        if (!out.action && loose.length) out.action = loose.shift();
        if (!out.label && loose.length) out.label = loose.shift();
        if (!out.url && loose.length) out.url = loose.shift();
        return out;
      });
    }
  }
  if (!Array.isArray(list)) throw bad('invalid actions');
  const out = [];
  for (const a of list) {
    if (!a || typeof a !== 'object' || String(a.action || '').toLowerCase() !== 'view') continue;
    const url = linkOf(a.url);
    const label = oneLine(a.label, LABEL_MAX);
    if (url && label) out.push({ label, url });
    if (out.length >= ACTIONS_MAX) break;
  }
  return out;
}

// Splits on `sep` outside '…' and "…" (ntfy's header format quotes values that hold commas or semicolons).
function splitQuoted(s, sep) {
  const out = [];
  let cur = '';
  let quote = '';
  for (const c of s) {
    if (quote) { if (c === quote) quote = ''; cur += c; }
    else if (c === '"' || c === "'") { quote = c; cur += c; }
    else if (c === sep) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.filter(x => x.trim());
}
const unquote = s => (s.length > 1 && (s[0] === '"' || s[0] === "'") && s.at(-1) === s[0] ? s.slice(1, -1) : s);

function attachOf(url, name) {
  const link = linkOf(url);
  if (!link) return null;
  const n = oneLine(name, 120);
  return n ? { url: link, name: n } : { url: link };
}

// The alert from what was asked: { title, text, priority, emojis, tags, click, actions, attach }.
function shape({ title, text, priority, tags, click, actions, attach, filename }) {
  const t = oneLine(title, TITLE_MAX);
  const body = multiline(text);
  const { emojis, tags: rest } = tagsOf(tags);
  const out = { title: t, text: body || 'triggered', priority: priorityOf(priority) };
  if (emojis) out.emojis = emojis;
  if (rest.length) out.tags = rest;
  const link = linkOf(click);
  if (link) out.click = link;
  const acts = actionsOf(actions);
  if (acts.length) out.actions = acts;
  const att = attachOf(attach, filename);
  if (att) out.attach = att;
  return out;
}

// ntfy's text publishing: the body is the message (or the m/message parameter when the body is empty, as with GET).
// `body` is a Buffer.
function fromNtfy({ headers = {}, query = null, body = Buffer.alloc(0) }) {
  if (body.length > TEXT_MAX_BYTES * 16) throw new InboxError(413, 41300, 'message too large (ntfy\'s attachments aren\'t taken here)');
  const asText = body.length ? body.toString('utf8') : '';
  if (asText.includes('\u0000')) throw new InboxError(400, 40000, 'a binary body (an attachment) isn\'t taken here: send text');
  return shape({
    title: param(headers, query, NAMES.title),
    text: asText || param(headers, query, NAMES.message),
    priority: param(headers, query, NAMES.priority),
    tags: param(headers, query, NAMES.tags),
    click: param(headers, query, NAMES.click),
    actions: param(headers, query, NAMES.actions),
    attach: param(headers, query, NAMES.attach),
    filename: param(headers, query, NAMES.filename),
  });
}

// ntfy's JSON publishing (the topic in the body): { topic, message, title, priority, tags, click, actions, attach,
// filename, ... }.
function fromNtfyJson(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw bad('expected a JSON object');
  return shape({ title: o.title, text: typeof o.message === 'string' ? o.message : '', priority: o.priority, tags: o.tags, click: o.click,
    actions: o.actions, attach: o.attach, filename: o.filename });
}

// A webhook's JSON (posted to /notify/<key>): its title, its text, its link and how urgent, from the names programs use
// (title/subject/summary; message/text/body/content/description, Discord's embeds; url/click/link; priority, or
// level/severity/status/event words). With none of them, the JSON itself, pretty-printed, is the text.
const LEVELS = [
  [/^(critical|crit|emergency|emerg|fatal|panic|disaster)$/, 5],
  [/^(alert|alarm|error|err|high|major|down|failed|failure|firing|problem|raised|warn|warning)$/, 4],
  [/^(info|information|notice|ok|resolved|recovered|recovery|clear|cleared|up|default|normal|success|test)$/, 3],
  [/^(low|minor|debug|trace|verbose)$/, 2],
];
function levelPriority(...words) {
  for (const w of words) {
    if (typeof w !== 'string') continue;
    const s = w.trim().toLowerCase();
    for (const [re, p] of LEVELS) if (re.test(s)) return p;
  }
  return null;
}
const firstString = (...vs) => vs.find(v => typeof v === 'string' && v.trim()) || '';

function fromWebhook(o) {
  if (!o || typeof o !== 'object') throw bad('expected a JSON object');
  if (Array.isArray(o)) return shape({ text: JSON.stringify(o, null, 2) });
  const embed = Array.isArray(o.embeds) && o.embeds[0] && typeof o.embeds[0] === 'object' ? o.embeds[0] : {};
  const title = firstString(o.title, o.subject, o.summary, embed.title);
  let text = firstString(o.message, o.text, o.body, o.content, o.description, embed.description);
  if (!text && (o.message || o.text || o.body) && typeof (o.message || o.text || o.body) === 'object') text = JSON.stringify(o.message || o.text || o.body, null, 2);
  const known = Boolean(title || text);
  if (!known) text = JSON.stringify(o, null, 2);
  let priority = o.priority;
  try { priorityOf(priority); } catch { priority = undefined; }
  if (priority === undefined || priority === null || priority === '') priority = levelPriority(o.level, o.severity, o.status, o.event, o.state) ?? 3;
  return shape({ title, text, priority, tags: Array.isArray(o.tags) || typeof o.tags === 'string' ? o.tags : undefined,
    click: firstString(o.click, o.url, o.link, o.href, embed.url), actions: o.actions, attach: o.attach, filename: o.filename });
}

// ntfy's answer to a publish: the message as stored (its id, the time in seconds, the topic as it was asked).
function ntfyAnswer(alert, topic) {
  return {
    id: alert.id, time: Math.floor(alert.at / 1000), expires: Math.floor(alert.at / 1000) + 30 * 86400, event: 'message', topic,
    message: alert.text, ...(alert.title && { title: alert.title }), ...(alert.priority !== 3 && { priority: alert.priority }),
    ...(alert.tags || alert.emojis ? { tags: alert.tags || [] } : {}), ...(alert.click && { click: alert.click }),
  };
}

// ntfy's error body.
const ntfyError = (status, code, error) => ({ code, http: status, error });

module.exports = { InboxError, fromNtfy, fromNtfyJson, fromWebhook, ntfyAnswer, ntfyError, priorityOf, tagsOf, linkOf, actionsOf, headerText, oneLine, multiline, TEXT_MAX_BYTES, TITLE_MAX };
