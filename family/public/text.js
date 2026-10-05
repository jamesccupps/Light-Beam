// Message text as page elements (never as HTML): **bold**, *italic*, ~~struck~~, `code`, ```blocks```, > quotes,
// links, @mentions. And mentions between how they're typed (@Mary) and how they're stored (<@id>).

import { h } from './ui.js';
import { state, person } from './store.js';

const ID = '[0-9A-HJKMNP-TV-Z]{26}';
const TOKEN = new RegExp(
  '(`[^`\\n]+`)' + // inline code
  `|(<@${ID}>)` + // a mention
  '|(https?:\\/\\/[^\\s<>"\']+)' + // a link
  '|(\\*\\*[^*\\n]+?\\*\\*)' + // bold
  '|(~~[^~\\n]+?~~)' + // struck through
  '|(\\*[^*\\s][^*\\n]*?\\*)' + // italic
  '|((?<![\\w])_[^_\\n]+?_(?![\\w]))' + // italic, underscores
  '|((?<![\\w@])@(?:everyone|here)\\b)', // everyone
  'g');

function trimUrl(url) {
  // Punctuation after a link belongs to the sentence (a closing bracket only if it doesn't close one in the link).
  let end = url.length;
  while (end > 0 && /[.,;:!?'"*]/.test(url[end - 1])) end--;
  if (url[end - 1] === ')' && (url.slice(0, end).match(/\(/g) || []).length < (url.slice(0, end).match(/\)/g) || []).length) end--;
  return url.slice(0, end);
}

function inline(text, parent, depth = 0) {
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const [whole, code, mention, url, bold, strike, italic, underscore, everyone] = m;
    if (code) parent.append(h('code', {}, code.slice(1, -1)));
    else if (mention) {
      const id = mention.slice(2, -1);
      parent.append(h('span', { class: `mention-chip${id === state.me?.id ? ' me' : ''}` }, `@${person(id).name}`));
    } else if (url) {
      const clean = trimUrl(url);
      parent.append(h('a', { href: clean, target: '_blank', rel: 'noopener noreferrer' }, clean));
      if (clean.length < url.length) parent.append(url.slice(clean.length));
    } else if (bold && depth < 3) inline(bold.slice(2, -2), parent.appendChild(h('strong')), depth + 1);
    else if (strike && depth < 3) inline(strike.slice(2, -2), parent.appendChild(h('s')), depth + 1);
    else if ((italic || underscore) && depth < 3) inline((italic || underscore).slice(1, -1), parent.appendChild(h('em')), depth + 1);
    else if (everyone) parent.append(h('span', { class: 'mention-chip me' }, everyone));
    else parent.append(whole);
    last = m.index + whole.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function blocks(text, parent) {
  const lines = text.split('\n');
  let quote = null;
  lines.forEach((line, i) => {
    const isQuote = /^> ?/.test(line);
    if (isQuote) {
      if (!quote) parent.append((quote = h('blockquote')));
      else quote.append('\n');
      inline(line.replace(/^> ?/, ''), quote);
      return;
    }
    quote = null;
    inline(line, parent);
    if (i < lines.length - 1) parent.append('\n');
  });
}

export function renderBody(body) {
  const frag = document.createDocumentFragment();
  const parts = String(body || '').split('```');
  parts.forEach((part, i) => {
    const inBlock = i % 2 === 1 && i < parts.length - 1;
    if (inBlock) frag.append(h('pre', {}, h('code', {}, part.replace(/^[a-z0-9+#-]{1,15}\n/i, '').replace(/^\n|\n$/g, ''))));
    else blocks(i % 2 === 1 ? '```' + part : part.replace(/^\n/, i > 0 ? '' : '$&'), frag);
  });
  return frag;
}

// Only emoji (up to 27): shown big, as in other chat apps. (The joiner, variation selector and keycap on their own.)
// eslint-disable-next-line no-misleading-character-class
const EMOJI_ONLY = /^(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️⃣\s]|[#*0-9]️?⃣)+$/u;
export function isJumbo(body) {
  if (!body || body.length > 200 || !EMOJI_ONLY.test(body) || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(body)) return false;
  return [...new Intl.Segmenter().segment(body.replace(/\s+/g, ''))].length <= 27;
}

// Plain text of a message (copying, previews): mentions as @Name.
export const plainText = body => String(body || '').replace(new RegExp(`<@(${ID})>`, 'g'), (_, id) => `@${person(id).name}`);

// A one-line preview (replies): plain text without the formatting marks.
export const snippet = body => plainText(body).replace(/```[\s\S]*?```/g, '[code]').replace(/(\*\*|~~|`)(.+?)\1/g, '$2').replace(/\s+/g, ' ').trim();

// What's typed → what's stored: @Name (a person in the family, longest names first) becomes <@id>.
export function toWire(text) {
  const people = [...state.people.values()].filter(p => !p.disabled).sort((a, b) => b.name.length - a.name.length);
  let out = text;
  for (const p of people) {
    const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|[^\\w@<])@${escaped}(?![\\w])`, 'giu'), (_, before) => `${before}<@${p.id}>`);
  }
  return out;
}
