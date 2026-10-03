// Small UI helpers: building elements (text is always text, never HTML), avatars, times and sizes, toasts, menus
// (a sheet on a phone), dialogs.

export const isPhone = () => matchMedia('(max-width: 899px)').matches;
export const isTouch = () => matchMedia('(hover: none)').matches;

// h('button', { class: 'btn', onclick }, 'Text', child, [more]) — attributes; on* are listeners; children are nodes or text.
export function h(tag, attrs = {}, ...children) {
  const el = tag === 'svg' || tag === 'use' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.setAttribute('class', v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

// Replaces an element's content: lists are flattened; null, undefined and false are left out (the DOM's own
// replaceChildren would print them).
export function fill(el, ...children) {
  el.textContent = '';
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function icon(name, cls = 'i') {
  const svg = h('svg', { class: cls, 'aria-hidden': 'true' });
  svg.append(h('use', { href: `#i-${name}` }));
  return svg;
}

export const iconBtn = (name, label, onclick, extra = {}) => h('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label, onclick, ...extra }, icon(name));

export function initials(name) {
  const words = String(name || '?').trim().split(/\s+/).filter(Boolean);
  const first = [...(words[0] || '?')][0] || '?';
  const second = words.length > 1 ? [...words[words.length - 1]][0] : '';
  return (first + second).toUpperCase();
}

// A person's picture, or their initials on their colour; `presence`: a dot for online.
export function avatar(person, { size = '', presence = false } = {}) {
  const el = h('span', { class: `avatar ${size} c${person?.color ?? 0}`, 'aria-hidden': 'true' });
  if (person?.avatar) el.append(h('img', { src: person.avatar, alt: '', loading: 'lazy', decoding: 'async' }));
  else el.textContent = initials(person?.name || '?');
  if (!presence) return el;
  return h('span', { class: `presence ${person?.online ? 'on' : ''}` }, el);
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export const timeShort = ts => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const fullTime = ts => new Date(ts).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' });

export function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400e3);
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

export const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

// "14:05" today, "Yesterday", "Mon", "Sep 29" — for lists.
export function whenShort(ts) {
  const d = new Date(ts);
  if (sameDay(d, new Date())) return timeShort(ts);
  if (Date.now() - ts < 6 * 86400e3) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function formatSize(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')} ${units[i]}`;
}

let toastTimer;
export function toast(message, { error = false, ms = 3200 } = {}) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast${error ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export async function copyText(text, done = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast('Couldn’t copy', { error: true });
  }
}

// ---------------------------------------------------------------- menus and sheets

let openMenu = null;
export function closeMenu() {
  if (!openMenu) return;
  const m = openMenu;
  openMenu = null;
  m.close();
}

// items: [{ label, icon, onclick, danger }, 'hr', ...]; quick: emoji buttons on top (reactions). Anchored to an
// element (or a point) on a computer; a sheet from the bottom on a phone.
export function menu(anchor, items, { quick = null, onQuick = null, onClose = null } = {}) {
  closeMenu();
  const phone = isPhone() || isTouch();
  const build = cls => items.filter(Boolean).map(it => (it === 'hr' ? h('hr') : h('button', {
    type: 'button', class: `${cls}${it.danger ? ' danger' : ''}`,
    onclick: e => { e.stopPropagation(); closeMenu(); it.onclick(); },
  }, it.icon ? icon(it.icon) : null, h('span', {}, it.label))));
  const quickRow = quick ? h('div', { class: 'quick' }, quick.map(e => h('button', { type: 'button', 'aria-label': `React with ${e}`, onclick: ev => { ev.stopPropagation(); closeMenu(); onQuick(e); } }, e))) : null;
  let el;
  let scrim = null;
  if (phone) {
    // (1.8.4) Only a tap that began on it closes it: lifting the finger of a press and hold (which opened the menu) lands
    // on it too, and closed the menu at once, so a message's menu (Delete…) couldn't be used on a phone.
    let pressed = false;
    scrim = h('div', { class: 'scrim', onpointerdown: () => { pressed = true; }, onclick: () => { if (pressed) closeMenu(); } });
    el = h('div', { class: 'sheet', role: 'menu' }, h('div', { class: 'grab' }), quickRow, build('item-btn'));
    document.body.append(scrim, el);
  } else {
    el = h('div', { class: 'menu', role: 'menu' }, quickRow, build(''));
    document.body.append(el);
    const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    let left = Math.min(r.right - w, window.innerWidth - w - 8);
    if (left < 8) left = Math.min(r.left, window.innerWidth - w - 8);
    let top = r.bottom + 6;
    if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 6);
    Object.assign(el.style, { left: `${Math.max(8, left)}px`, top: `${top}px` });
  }
  const onKey = e => { if (e.key === 'Escape') closeMenu(); };
  const onDown = e => { if (!el.contains(e.target)) closeMenu(); };
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => document.addEventListener('pointerdown', onDown, true));
  openMenu = {
    close() {
      el.remove();
      scrim?.remove();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      onClose?.();
    },
  };
  el.querySelector('button')?.focus({ preventScroll: true });
  return el;
}

// ---------------------------------------------------------------- dialogs

// A dialog built from fields; resolves with the form's values (or null when cancelled).
export function dialog({ title, body = [], ok = 'OK', cancel = 'Cancel', danger = false, onSubmit = null }) {
  return new Promise(resolve => {
    const error = h('p', { class: 'error-text', hidden: true });
    const okBtn = h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'submit' }, ok);
    const form = h('form', { method: 'dialog' }, h('h2', {}, title), body, error,
      h('div', { class: 'actions' }, cancel ? h('button', { class: 'btn ghost', type: 'button', onclick: () => finish(null) }, cancel) : null, okBtn));
    const dlg = h('dialog', { class: 'dlg' }, form);
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const values = Object.fromEntries(new FormData(form).entries());
      if (!onSubmit) return finish(values);
      okBtn.disabled = true;
      try {
        const out = await onSubmit(values);
        finish(out === undefined ? values : out);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        okBtn.disabled = false;
      }
    });
    dlg.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
    document.body.append(dlg);
    dlg.showModal();
    form.querySelector('input:not([type=hidden]), textarea, select')?.focus();
  });
}

export const confirmDialog = ({ title, text = '', ok = 'OK', danger = false }) =>
  dialog({ title, body: text ? [h('p', { class: 'muted' }, text)] : [], ok, danger }).then(v => v !== null);

export function field(label, input) {
  return h('label', { class: 'field' }, h('span', {}, label), input);
}
