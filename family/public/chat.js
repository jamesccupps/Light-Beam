// A conversation: its header, the messages (grouped by person and day, paged both ways), and the composer.

import { h, fill, icon, iconBtn, avatar, menu, closeMenu, dialog, confirmDialog, field, toast, copyText, timeShort, fullTime, dayLabel, dayKey, formatSize, isTouch, isPhone } from './ui.js';
import { api, ApiError } from './api.js';
import { state, on, emit, person, channel, title, otherPerson, isAdmin, cacheOf, mergePage, addPending, dropPending, applyEvent, mentionsMe } from './store.js';
import { renderBody, isJumbo, plainText, snippet, toWire } from './text.js';
import { pickEmoji, QUICK, noteUsed } from './emoji.js';
import { makeThumb, upload, cancelUpload, sendingFiles, busy, leftOver, discardUpload } from './uploads.js';
import { nav } from './nav.js';
import { fastLink, makeFastLink } from './fastlinks.js';
import { downloadFile, downloadFiles } from './downloads.js';

const GROUP_MS = 7 * 60e3;
const SYSTEM = { joined: 'joined the family space', left: 'left the group', renamed: 'renamed the group' };
const drafts = new Map();
const SAFE_INLINE = /^image\/(jpeg|png|gif|webp|avif|bmp)$/;

function loadDraft(id) {
  if (drafts.has(id)) return drafts.get(id);
  try { return localStorage.getItem(`family.draft.${id}`) || ''; } catch { return ''; }
}
function saveDraft(id, text) {
  drafts.set(id, text);
  try { text ? localStorage.setItem(`family.draft.${id}`, text) : localStorage.removeItem(`family.draft.${id}`); } catch {}
}

export function conversationView(channelId, { jump = null } = {}) {
  const c = channel(channelId);
  const cache = cacheOf(channelId);
  const offs = [];
  let destroyed = false;
  let loading = false;
  let readAtOpen = c.unread ? c.read : null; // where the "new messages" line goes
  let reply = null; // the message being replied to
  let tray = []; // files being attached
  let lastTyping = 0;
  let editing = null;
  let selecting = null; // (1.11.0) the messages picked while selecting several (a Set of ids), or null

  // ---------------------------------------------------------------- header

  const head = h('header', { class: 'conv-head' });
  function renderHead() {
    const ch = channel(channelId) || c;
    const other = otherPerson(ch);
    const glyph = ch.kind === 'text' ? icon('hash') : ch.kind === 'dm' ? avatar(other, { size: 's', presence: true }) : icon('users');
    const sub = ch.kind === 'text' ? ch.topic : ch.kind === 'dm' ? (other?.online ? 'Online' : '') : `${(ch.members || []).length} people`;
    fill(head, iconBtn('back', 'Back', () => nav.go('/'), { class: 'icon-btn back' }),
      h('div', { class: 'title' }, glyph, h('div', { style: { minWidth: 0 } }, h('strong', {}, title(ch)), sub ? h('div', { class: 'topic' }, sub) : null)),
      iconBtn('search', 'Search this conversation', () => nav.panel('search', { channel: channelId })),
      iconBtn('pin', 'Pinned messages', () => nav.panel('pins', { channel: channelId })),
      iconBtn('image', 'Photos and files', () => nav.panel('gallery', { channel: channelId })),
      ch.kind !== 'dm' ? iconBtn('users', 'People', () => nav.panel('members', { channel: channelId })) : null,
      iconBtn('more', 'More', e => conversationMenu(e.currentTarget)),
    );
  }

  function conversationMenu(anchor) {
    const ch = channel(channelId);
    const level = ch.notify || 'all';
    const mark = l => (level === l ? '✓ ' : '');
    const setLevel = async l => {
      try { await api(`/api/channels/${channelId}/notify`, { method: 'PUT', body: { level: l } }); } catch (err) { toast(err.message, { error: true }); }
    };
    menu(anchor, [
      { label: `${mark('all')}Notify me about every message`, icon: 'bell', onclick: () => setLevel('all') },
      ch.kind !== 'dm' ? { label: `${mark('mentions')}Only when I’m @mentioned`, icon: 'at', onclick: () => setLevel('mentions') } : null,
      { label: `${mark('none')}Don’t notify me`, icon: 'bell-off', onclick: () => setLevel('none') },
      'hr',
      ch.kind === 'group' ? { label: 'Rename the group', icon: 'edit', onclick: renameGroup } : null,
      ch.kind === 'group' ? { label: 'Leave the group', icon: 'logout', danger: true, onclick: leaveGroup } : null,
      ch.kind === 'text' && isAdmin() ? { label: 'Edit channel', icon: 'edit', onclick: editChannel } : null,
      ch.kind === 'text' && isAdmin() ? { label: 'Archive channel', icon: 'archive', danger: true, onclick: archiveChannel } : null,
    ]);
  }

  async function renameGroup() {
    const input = h('input', { class: 'input', name: 'name', maxlength: 40, value: channel(channelId).name || '', placeholder: 'A name for the group' });
    await dialog({ title: 'Rename the group', body: [field('Name', input)], ok: 'Save', onSubmit: v => api(`/api/channels/${channelId}`, { method: 'PATCH', body: { name: v.name.trim() || null } }) });
  }
  async function leaveGroup() {
    if (!(await confirmDialog({ title: 'Leave the group?', text: 'You won’t see its messages any more unless someone adds you again.', ok: 'Leave', danger: true }))) return;
    try { await api(`/api/channels/${channelId}/members/me`, { method: 'DELETE' }); nav.go('/'); } catch (err) { toast(err.message, { error: true }); }
  }
  async function editChannel() {
    const ch = channel(channelId);
    const name = h('input', { class: 'input', name: 'name', maxlength: 40, value: ch.name, required: true });
    const topic = h('input', { class: 'input', name: 'topic', maxlength: 200, value: ch.topic || '', placeholder: 'What it’s for' });
    await dialog({ title: 'Edit channel', body: [field('Name', name), field('Topic', topic)], ok: 'Save', onSubmit: v => api(`/api/channels/${channelId}`, { method: 'PATCH', body: { name: v.name, topic: v.topic } }) });
  }
  async function archiveChannel() {
    if (!(await confirmDialog({ title: `Archive #${channel(channelId).name}?`, text: 'Its messages are kept; only admins see it, and nobody can post. You can bring it back from People & channels.', ok: 'Archive', danger: true }))) return;
    try { await api(`/api/channels/${channelId}`, { method: 'PATCH', body: { archived: true } }); nav.go('/'); } catch (err) { toast(err.message, { error: true }); }
  }

  // ---------------------------------------------------------------- the list

  const list = h('div', { class: 'messages', role: 'log', 'aria-live': 'polite', 'aria-label': 'Messages', tabindex: '0' });
  const jumpBtn = h('button', { class: 'jump', type: 'button', hidden: true, onclick: () => jumpToLatest() }, icon('arrow-down', 'i small'), h('span', {}, 'Latest messages'));
  const typingLine = h('div', { class: 'typing', 'aria-live': 'polite' });
  const els = new Map(); // message id -> element

  const isSystem = m => Boolean(m.kind && m.kind !== 'user');
  const continues = (m, prev) => Boolean(prev) && !isSystem(m) && !isSystem(prev) && prev.author === m.author && !m.reply &&
    m.created - prev.created < GROUP_MS && dayKey(prev.created) === dayKey(m.created) && Boolean(prev.pending) === Boolean(m.pending);

  function startEl() {
    const ch = channel(channelId) || c;
    const other = otherPerson(ch);
    return h('div', { class: 'start' },
      ch.kind === 'text' ? h('span', { class: 'avatar l c0' }, icon('hash', 'i big')) : ch.kind === 'dm' ? avatar(other, { size: 'l' }) : h('span', { class: 'avatar l c6' }, icon('users', 'i big')),
      h('h2', {}, ch.kind === 'text' ? `Welcome to #${ch.name}` : title(ch)),
      h('p', { class: 'muted' }, ch.kind === 'text' ? `This is the start of #${ch.name}.${ch.topic ? ` ${ch.topic}` : ''}` : ch.kind === 'dm' ? `This is the beginning of your conversation with ${other?.name || 'them'}.` : 'This is the beginning of the group.'));
  }

  function renderAll() {
    els.clear();
    const nodes = [];
    if (!cache.more.before && cache.loaded) nodes.push(startEl());
    else if (cache.loaded) nodes.push(h('div', { class: 'loading-more' }, 'Loading earlier messages…'));
    let prev = null;
    let lineShown = false;
    for (const m of cache.list) {
      if (!prev || dayKey(prev.created) !== dayKey(m.created)) nodes.push(h('div', { class: 'day', role: 'separator' }, dayLabel(m.created)));
      if (readAtOpen && !lineShown && m.id > readAtOpen && m.author !== state.me.id && !m.pending) {
        nodes.push(h('div', { class: 'new-line', id: 'new-line' }, 'New'));
        lineShown = true;
      }
      const el = msgEl(m, prev);
      els.set(m.id, el);
      nodes.push(el);
      prev = m;
    }
    fill(list, ...nodes);
  }

  // One message's element again (an edit, a reaction), keeping its place.
  function refresh(id) {
    const old = els.get(id);
    const i = cache.list.findIndex(m => m.id === id);
    if (!old || i < 0) return renderAll();
    const el = msgEl(cache.list[i], cache.list[i - 1]);
    if (editing?.id === id) return; // (the editor stays until saved or cancelled)
    old.replaceWith(el);
    els.set(id, el);
  }

  function msgEl(m, prev) {
    if (isSystem(m)) {
      const who = person(m.author);
      const what = m.kind === 'renamed' ? (m.body ? `renamed the group to “${m.body}”` : 'removed the group’s name') : SYSTEM[m.kind] || m.kind;
      return h('div', { class: 'msg cont', dataset: { id: m.id } }, h('span', { class: 'side-time', title: fullTime(m.created) }, timeShort(m.created)),
        h('div', { class: 'sys' }, h('strong', {}, who.name), ` ${what}`));
    }
    const cont = continues(m, prev);
    const author = person(m.author);
    const el = h('div', {
      class: `msg${cont ? ' cont' : ''}${mentionsMe(m) ? ' mentioned' : ''}${m.pending ? ' pending' : ''}${m.failed ? ' failed' : ''}${selecting?.has(m.id) ? ' selected' : ''}`,
      dataset: { id: m.id, ...(!m.pending && { pickable: '1' }) },
    });
    if (!m.pending) el.append(h('span', { class: 'pick', 'aria-hidden': 'true' }, icon('check', 'i small')));
    if (cont) el.append(h('span', { class: 'side-time', title: fullTime(m.created) }, timeShort(m.created)));
    else el.append(avatar(author), h('div', { class: 'msg-head' }, h('strong', {}, author.name), m.pending && !m.failed
      ? h('span', { class: 'sending-label' }, 'Sending…') // (1.8.5: until it's sent; it looked sent)
      : h('time', { datetime: new Date(m.created).toISOString(), title: fullTime(m.created) }, timeShort(m.created))));
    if (m.reply) {
      el.append(h('button', { class: 'reply-to', type: 'button', onclick: () => jumpTo(m.reply.id) }, icon('reply', 'i small'),
        m.reply.deleted ? h('span', { class: 'snip' }, 'The original message was deleted')
          : [h('strong', {}, person(m.reply.author).name), h('span', { class: 'snip' }, snippet(m.reply.body) || (m.reply.files ? '📎 A file' : ''))]));
    }
    if (m.body) {
      const body = h('div', { class: `msg-body${isJumbo(m.body) ? ' jumbo' : ''}` }, renderBody(m.body));
      if (m.edited) body.append(h('span', { class: 'edited', title: `Edited ${fullTime(m.edited)}` }, '(edited)'));
      el.append(body);
    }
    // (1.8.5: how far, above the pictures: under a tall video it was out of sight)
    if (m.pending && !m.failed && m.request?.items?.length) el.append(sendingEl(m));
    if (m.files?.length) el.append(filesEl(m));
    if (m.reactions?.length) el.append(reactionsEl(m));
    if (m.failed) {
      el.append(h('div', { class: 'msg-body small' }, 'Not sent. ', h('a', { href: '#', onclick: e => { e.preventDefault(); retry(m); } }, 'Try again'), ' · ',
        h('a', { href: '#', onclick: e => { e.preventDefault(); cancelSending(m); } }, 'Remove')));
    }
    if (!m.pending) {
      el.append(h('div', { class: 'tools' },
        iconBtn('smile', 'Add a reaction', e => { e.stopPropagation(); reactWithPicker(m, e.currentTarget); }),
        iconBtn('reply', 'Reply', () => startReply(m)),
        iconBtn('more', 'More', e => { e.stopPropagation(); messageMenu(m, e.currentTarget, el); })));
      longPress(el, point => messageMenu(m, point, el));
      // (1.8.4) On a phone a tap opens it too: press and hold isn't something people find.
      el.addEventListener('click', e => {
        if (!(e.pointerType === 'touch' || isTouch()) || e.target.closest('a, button, img, video, audio, textarea, input') || String(window.getSelection() || '')) return;
        messageMenu(m, { x: e.clientX, y: e.clientY }, el);
      });
      el.addEventListener('contextmenu', e => {
        if (e.target.closest('a, img, video')) return;
        e.preventDefault();
        messageMenu(m, { x: e.clientX, y: e.clientY }, el);
      });
      el.addEventListener('dblclick', e => { if (!selecting && !isTouch() && m.author === state.me.id && !e.target.closest('a, button, img, video')) startEdit(m); });
    }
    return el;
  }

  // (1.8.3) A message whose files are still on their way: how far they are, and a way to stop it.
  function sendingEl(m) {
    const fill = h('span', { class: 'fill' });
    const text = h('span', { class: 'muted small' });
    const stop = h('a', { href: '#', class: 'small', onclick: e => { e.preventDefault(); cancelSending(m); } }, 'Cancel');
    m.progressEl = { fill, text, stop };
    showProgress(m);
    return h('div', { class: 'sending' }, h('span', { class: 'track' }, fill), text, stop);
  }

  function showProgress(m) {
    const p = m.progressEl;
    if (!p || !m.request) return;
    const items = m.request.items;
    const total = items.reduce((n, i) => n + i.file.size, 0);
    const sent = items.reduce((n, i) => n + (i.done ? i.file.size : Math.min(i.offset || 0, i.file.size)), 0);
    const all = items.every(i => i.done);
    const pct = total ? Math.floor(sent / total * 100) : 100;
    p.fill.style.width = `${pct}%`;
    p.text.textContent = all ? 'Sending…' : `Sending ${formatSize(sent)} of ${formatSize(total)} (${pct}%) · keep Beam Family open`;
    p.stop.hidden = all;
  }

  // Cancel (or Remove, after it failed): its files stop and the server drops what it got; the message goes.
  function cancelSending(m) {
    m.cancelled = true;
    for (const i of m.request?.items || []) cancelUpload(i);
    dropPending(channelId, m.id);
  }

  function filesEl(m) {
    const media = m.files.filter(f => (f.mime.startsWith('image/') && (f.thumb || SAFE_INLINE.test(f.mime) || f.local)) || (f.mime.startsWith('video/') && (f.thumb || f.local)));
    const box = h('div', { class: `files${media.length > 1 ? ' many' : ''}` });
    for (const f of m.files) {
      if (media.includes(f)) {
        const src = f.local || f.thumb || f.url;
        const img = h('img', { src, alt: f.name, loading: 'lazy', decoding: 'async' });
        if (f.width && f.height && media.length === 1) {
          const scale = Math.min(1, 420 / f.width, 360 / f.height);
          img.width = Math.round(f.width * scale);
          img.height = Math.round(f.height * scale);
        }
        img.addEventListener('load', () => { if (atBottom(80)) scrollToBottom(); });
        box.append(h('button', { class: 'shot', type: 'button', title: f.name, 'aria-label': `Open ${f.name}`, onclick: () => openViewer(f) },
          img, f.mime.startsWith('video/') ? h('span', { class: 'play' }, icon('play', 'i big')) : null));
      } else if (f.mime.startsWith('audio/') && f.url) {
        box.append(h('audio', { controls: true, preload: 'none', src: f.url }));
      } else {
        box.append(h('a', { class: 'file-card', href: f.url ? `${f.url}?download` : '#', download: f.name, onclick: e => { e.preventDefault(); if (f.url) downloadFile(f); } },
          icon('file', 'i big'), h('span', { class: 'meta' }, h('strong', {}, f.name), h('span', { class: 'muted small' }, formatSize(f.size)))));
      }
    }
    return box;
  }

  // The viewer: every picture and video loaded in this conversation, starting at this one.
  function openViewer(f) {
    const items = [];
    for (const m of cache.list) for (const x of m.files || []) if (x.url && (x.mime.startsWith('image/') || x.mime.startsWith('video/'))) items.push(x);
    const i = Math.max(0, items.findIndex(x => x.id === f.id));
    nav.viewer(items.length ? items : [f], i);
  }

  function reactionsEl(m) {
    const box = h('div', { class: 'reactions' });
    for (const r of m.reactions) {
      const mine = r.users.includes(state.me.id);
      const names = r.users.map(id => (id === state.me.id ? 'You' : person(id).name));
      box.append(h('button', {
        type: 'button', class: `react${mine ? ' mine' : ''}`, title: `${names.join(', ')} reacted with ${r.emoji}`, 'aria-pressed': String(mine),
        onclick: () => toggleReaction(m, r.emoji, !mine),
      }, h('span', {}, r.emoji), h('span', { class: 'n' }, String(r.users.length))));
    }
    box.append(h('button', { type: 'button', class: 'react', title: 'Add a reaction', 'aria-label': 'Add a reaction', onclick: e => reactWithPicker(m, e.currentTarget) }, icon('smile', 'i small')));
    return box;
  }

  async function toggleReaction(m, emoji, on) {
    noteUsed(emoji);
    // Shown at once; the server's event confirms it (or puts it back).
    applyEvent('react', { id: m.id, channel: channelId, emoji, person: state.me.id, on });
    try { await api(`/api/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`, { method: on ? 'PUT' : 'DELETE' }); } catch (err) {
      applyEvent('react', { id: m.id, channel: channelId, emoji, person: state.me.id, on: !on });
      toast(err.message, { error: true });
    }
  }

  const reactWithPicker = (m, anchor) => pickEmoji(anchor, e => toggleReaction(m, e, !(m.reactions || []).some(r => r.emoji === e && r.users.includes(state.me.id))));

  function messageMenu(m, anchor, el) {
    if (selecting) return pick(m.id);
    const mine = m.author === state.me.id;
    el.classList.add('menu-open');
    menu(anchor, [
      { label: 'Reply', icon: 'reply', onclick: () => startReply(m) },
      mine ? { label: 'Edit', icon: 'edit', onclick: () => startEdit(m) } : null,
      m.body ? { label: 'Copy text', icon: 'copy', onclick: () => copyText(plainText(m.body)) } : null,
      // (1.11.0) several at once: copy, download or delete them together
      { label: 'Select', icon: 'check', onclick: () => startSelecting(m.id) },
      { label: 'Copy link', icon: 'link', onclick: () => copyText(`${location.origin}/c/${channelId}?m=${m.id}`, 'Link copied') },
      // (1.11.0) its files (big ones over the direct connection)
      m.files?.some(f => f.url) ? { label: m.files.length > 1 ? `Download ${m.files.length} files` : 'Download', icon: 'download', onclick: () => downloadFiles(m.files) } : null,
      // (1.9.0) a link anyone can download its file with, no sign-in
      m.files?.length ? { label: 'Fast link', icon: 'link', onclick: () => (m.files.length === 1 ? fastLink(m.files[0]) : menu(anchor, m.files.map(f => ({ label: f.name, icon: 'file', onclick: () => fastLink(f) })))) } : null,
      { label: m.pinned ? 'Unpin' : 'Pin', icon: 'pin', onclick: () => api(`/api/messages/${m.id}/pin`, { method: m.pinned ? 'DELETE' : 'PUT' }).catch(err => toast(err.message, { error: true })) },
      mine || isAdmin() ? 'hr' : null,
      mine || isAdmin() ? { label: 'Delete', icon: 'trash', danger: true, onclick: () => deleteMessage(m) } : null,
    ], {
      quick: QUICK,
      onQuick: e => toggleReaction(m, e, !(m.reactions || []).some(r => r.emoji === e && r.users.includes(state.me.id))),
      onClose: () => el.classList.remove('menu-open'),
    });
  }

  // ---------------------------------------------------------------- selecting several (1.11.0; the user: "gallery select")

  const selectBar = h('div', { class: 'select-bar', hidden: true, role: 'toolbar', 'aria-label': 'Selected messages' });
  const pickedMessages = () => cache.list.filter(m => selecting?.has(m.id));

  function startSelecting(id) {
    selecting = new Set([id]);
    view.classList.add('selecting');
    els.get(id)?.classList.add('selected');
    document.addEventListener('keydown', onSelectKey, true);
    renderSelectBar();
  }

  function stopSelecting() {
    if (!selecting) return;
    for (const id of selecting) els.get(id)?.classList.remove('selected');
    selecting = null;
    view.classList.remove('selecting');
    document.removeEventListener('keydown', onSelectKey, true);
    renderSelectBar();
  }

  function onSelectKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopSelecting(); }
  }

  function pick(id) {
    if (!selecting) return;
    if (selecting.has(id)) selecting.delete(id); else selecting.add(id);
    els.get(id)?.classList.toggle('selected', selecting.has(id));
    renderSelectBar();
  }

  function renderSelectBar() {
    if (composer) composer.hidden = Boolean(selecting);
    selectBar.hidden = !selecting;
    if (!selecting) return fill(selectBar);
    for (const id of [...selecting]) if (!cache.list.some(m => m.id === id)) selecting.delete(id); // (deleted meanwhile)
    const picked = pickedMessages();
    const files = picked.flatMap(m => m.files || []).filter(f => f.url);
    fill(selectBar,
      h('span', { class: 'grow' }, picked.length ? `${picked.length} selected` : 'Tap messages to select them'),
      h('button', { type: 'button', class: 'btn', disabled: !picked.some(m => m.body), onclick: copyPicked }, icon('copy'), 'Copy'),
      h('button', { type: 'button', class: 'btn', disabled: !files.length, onclick: () => { downloadFiles(files); stopSelecting(); } }, icon('download'), files.length > 1 ? `Download ${files.length}` : 'Download'),
      h('button', { type: 'button', class: 'btn danger', disabled: !picked.some(m => m.author === state.me.id || isAdmin()), onclick: deletePicked }, icon('trash'), 'Delete'),
      iconBtn('x', 'Stop selecting', stopSelecting));
  }

  // Their text, oldest first, each with who wrote it.
  function copyPicked() {
    const picked = pickedMessages().filter(m => m.body);
    copyText(picked.length === 1 ? plainText(picked[0].body) : picked.map(m => `${person(m.author).name}: ${plainText(m.body)}`).join('\n'));
    stopSelecting();
  }

  async function deletePicked() {
    const picked = pickedMessages();
    const allowed = picked.filter(m => m.author === state.me.id || isAdmin());
    const skipped = picked.length - allowed.length;
    const ok = await confirmDialog({
      title: allowed.length === 1 ? 'Delete this message?' : `Delete these ${allowed.length} messages?`,
      text: `They go for everyone, with their files.${skipped ? ` (${skipped} of them ${skipped === 1 ? 'isn’t' : 'aren’t'} yours: ${skipped === 1 ? 'it stays' : 'they stay'}.)` : ''}`,
      ok: 'Delete', danger: true,
    });
    if (!ok) return;
    let failed = 0;
    for (const m of allowed) {
      try { await api(`/api/messages/${m.id}`, { method: 'DELETE' }); } catch { failed++; }
    }
    if (failed) toast(`${failed} couldn’t be deleted`, { error: true });
    stopSelecting();
  }

  async function deleteMessage(m) {
    const theirs = m.author !== state.me.id;
    if (!(await confirmDialog({ title: 'Delete this message?', text: theirs ? `It’s ${person(m.author).name}’s message. It goes for everyone, with its files.` : 'It goes for everyone, with its files.', ok: 'Delete', danger: true }))) return;
    try { await api(`/api/messages/${m.id}`, { method: 'DELETE' }); } catch (err) { toast(err.message, { error: true }); }
  }

  // Press and hold on a phone: the message's menu.
  function longPress(el, fire) {
    let timer = null;
    let start = null;
    el.addEventListener('touchstart', e => {
      if (e.touches.length !== 1 || e.target.closest('a, button, video, audio')) return;
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      timer = setTimeout(() => { timer = null; navigator.vibrate?.(10); fire(start); }, 450);
    }, { passive: true });
    const cancel = () => { clearTimeout(timer); timer = null; };
    el.addEventListener('touchmove', e => { if (start && Math.hypot(e.touches[0].clientX - start.x, e.touches[0].clientY - start.y) > 10) cancel(); }, { passive: true });
    el.addEventListener('touchend', cancel);
    el.addEventListener('touchcancel', cancel);
  }

  // ---------------------------------------------------------------- editing in place

  function startEdit(m) {
    const el = els.get(m.id);
    if (!el || m.author !== state.me.id) return;
    editing = m;
    const text = plainText(m.body);
    const box = h('textarea', { class: 'input', rows: 2, 'aria-label': 'Edit the message' });
    box.value = text;
    const save = async () => {
      const body = toWire(box.value.trim());
      if (!body && !m.files?.length) return deleteMessage(m);
      try {
        if (body !== m.body) await api(`/api/messages/${m.id}`, { method: 'PATCH', body: { body } });
        stop();
      } catch (err) { toast(err.message, { error: true }); }
    };
    const stop = () => { editing = null; refresh(m.id); composerInput.focus(); };
    box.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); stop(); }
      if (e.key === 'Enter' && !e.shiftKey && !isTouch()) { e.preventDefault(); save(); }
    });
    const editor = h('div', { class: 'msg-body' }, box, h('div', { class: 'row small muted', style: { marginTop: '6px' } },
      h('button', { class: 'btn primary', type: 'button', onclick: save }, 'Save'), h('button', { class: 'btn ghost', type: 'button', onclick: stop }, 'Cancel'),
      isTouch() ? null : h('span', {}, 'Esc to cancel · Enter to save')));
    el.querySelector('.msg-body')?.remove();
    el.querySelector('.tools')?.remove();
    el.querySelector('.msg-head, .side-time')?.after(editor);
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    autoGrow(box);
    box.addEventListener('input', () => autoGrow(box));
  }

  // ---------------------------------------------------------------- scrolling and paging

  const atBottom = (slack = 40) => list.scrollHeight - list.scrollTop - list.clientHeight <= slack;
  const scrollToBottom = () => { list.scrollTop = list.scrollHeight; };

  async function loadLatest() {
    loading = true;
    try {
      const page = await api(`/api/channels/${channelId}/messages?limit=50`);
      mergePage(channelId, page.messages, { more: { before: page.more.before, after: false }, latest: true, reset: true });
    } finally {
      loading = false;
    }
  }

  async function loadOlder() {
    if (loading || !cache.more.before || !cache.list.length) return;
    loading = true;
    const first = cache.list.find(m => !m.pending)?.id;
    const before = list.scrollHeight - list.scrollTop;
    try {
      const page = await api(`/api/channels/${channelId}/messages?before=${first}&limit=50`);
      if (destroyed) return;
      mergePage(channelId, page.messages, { more: { before: page.more.before } });
      renderAll();
      list.scrollTop = list.scrollHeight - before;
    } catch (err) {
      if (!destroyed) toast(err.message, { error: true });
    } finally {
      loading = false;
    }
  }

  async function loadNewer() {
    if (loading || cache.latest) return;
    loading = true;
    const last = [...cache.list].reverse().find(m => !m.pending)?.id;
    try {
      const page = await api(`/api/channels/${channelId}/messages?after=${last}&limit=50`);
      if (destroyed) return;
      mergePage(channelId, page.messages, { more: { after: page.more.after }, latest: !page.more.after });
      const top = list.scrollTop;
      renderAll();
      list.scrollTop = top;
    } catch (err) {
      if (!destroyed) toast(err.message, { error: true });
    } finally {
      loading = false;
    }
  }

  async function jumpTo(id) {
    let el = els.get(id);
    if (!el) {
      try {
        const page = await api(`/api/channels/${channelId}/messages?around=${id}&limit=50`);
        if (destroyed) return;
        mergePage(channelId, page.messages, { more: page.more, reset: true, latest: !page.more.after });
        renderAll();
        el = els.get(id);
      } catch (err) {
        return toast(err.status === 404 ? 'That message isn’t there any more' : err.message, { error: true });
      }
    }
    if (!el) return toast('That message isn’t there any more', { error: true });
    el.scrollIntoView({ block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    updateJump();
  }

  async function jumpToLatest() {
    if (!cache.latest) {
      await loadLatest();
      renderAll();
    }
    scrollToBottom();
    updateJump();
    markRead();
  }

  function updateJump() {
    jumpBtn.hidden = cache.latest && atBottom(600);
  }

  let readTimer = null;
  // Read up to the newest message, when it's actually on screen.
  function markRead() {
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      const ch = channel(channelId);
      if (destroyed || !ch || document.visibilityState !== 'visible' || !cache.latest || !atBottom(80)) return;
      const last = [...cache.list].reverse().find(m => !m.pending)?.id;
      if (!last || (ch.read && last <= ch.read)) return;
      applyEvent('read', { channel: channelId, id: last });
      api(`/api/channels/${channelId}/read`, { method: 'POST', body: { id: last } }).catch(() => {});
    }, 300);
  }

  list.addEventListener('scroll', () => {
    if (list.scrollTop < 400) loadOlder();
    if (!cache.latest && atBottom(400)) loadNewer();
    updateJump();
    if (atBottom(80)) markRead();
  }, { passive: true });

  // ---------------------------------------------------------------- live changes

  offs.push(on(`messages:${channelId}`, change => {
    if (destroyed) return;
    const wasAtBottom = atBottom(120);
    if (change.op === 'add' && els.has(change.id)) return;
    if (change.op === 'add' && cache.list.at(-1)?.id === change.id && els.size) {
      const m = cache.list.at(-1);
      const prev = cache.list.at(-2);
      if (!prev || dayKey(prev.created) !== dayKey(m.created)) list.append(h('div', { class: 'day', role: 'separator' }, dayLabel(m.created)));
      const el = msgEl(m, prev);
      els.set(m.id, el);
      list.append(el);
      if (wasAtBottom || m.author === state.me.id) scrollToBottom();
    } else if (change.op === 'edit') {
      refresh(change.id);
      if (wasAtBottom) scrollToBottom();
    } else {
      const top = list.scrollTop;
      renderAll();
      if (wasAtBottom) scrollToBottom(); else list.scrollTop = top;
    }
    updateJump();
    markRead();
  }));
  offs.push(on(`channel:${channelId}`, () => { if (!destroyed && channel(channelId)) renderHead(); }));
  offs.push(on('people', () => { if (!destroyed) { renderHead(); renderTyping(); } }));

  function renderTyping() {
    const now = Date.now();
    const t = state.typing.get(channelId);
    const names = t ? [...t].filter(([id, until]) => until > now && id !== state.me.id).map(([id]) => person(id).name) : [];
    typingLine.textContent = !names.length ? '' : names.length === 1 ? `${names[0]} is typing…` : names.length === 2 ? `${names[0]} and ${names[1]} are typing…` : 'Several people are typing…';
  }
  offs.push(on(`typing:${channelId}`, renderTyping));
  const typingTimer = setInterval(renderTyping, 2000);

  // ---------------------------------------------------------------- the composer

  const ch0 = channel(channelId);
  const readonly = ch0.archived;
  const composerInput = h('textarea', {
    rows: 1, placeholder: `Message ${ch0.kind === 'text' ? '#' : ''}${title(ch0)}`, 'aria-label': 'Write a message', enterkeyhint: isTouch() ? 'enter' : 'send',
    autocapitalize: 'sentences', spellcheck: 'true',
  });
  composerInput.value = loadDraft(channelId);
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { addFiles([...fileInput.files]); fileInput.value = ''; } });
  const sendBtn = h('button', { class: 'icon-btn send-btn', type: 'button', title: 'Send', 'aria-label': 'Send', onclick: () => send() }, icon('send'));
  const replyBar = h('div', { class: 'compose-bar', hidden: true });
  const trayEl = h('div', { class: 'tray', hidden: true });
  const unsentEl = h('div', { class: 'unsent', hidden: true });
  const suggest = h('div', { class: 'suggest', role: 'listbox', hidden: true });
  const composer = readonly ? h('div', { class: 'readonly' }, 'This channel is archived: its messages are kept, but nobody can post.')
    : h('div', { class: 'composer' }, suggest, h('div', { class: 'compose-box' }, replyBar, unsentEl, trayEl,
      h('div', { class: 'compose-row' },
        // (1.9.0) files here, or a fast link for one on this device
        iconBtn('attach', 'Attach files', e => menu(e.currentTarget, [
          { label: 'Send files here', icon: 'attach', onclick: () => fileInput.click() },
          { label: 'Make a fast link', icon: 'link', onclick: () => makeFastLink() },
        ])),
        composerInput,
        iconBtn('smile', 'Emoji', e => pickEmoji(e.currentTarget, insertEmoji)),
        sendBtn)), fileInput);

  function autoGrow(t) {
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, window.innerHeight * 0.4)}px`;
  }

  function insertEmoji(e) {
    const { selectionStart: s, selectionEnd: end, value } = composerInput;
    composerInput.value = value.slice(0, s) + e + value.slice(end);
    composerInput.setSelectionRange(s + e.length, s + e.length);
    composerInput.focus();
    onInput();
  }

  function startReply(m) {
    reply = m;
    replyBar.hidden = false;
    fill(replyBar, icon('reply', 'i small'), h('span', {}, 'Replying to ', h('strong', {}, person(m.author).name)), h('span', { class: 'spacer' }),
      iconBtn('x', 'Cancel the reply', cancelReply, { style: { width: '28px', height: '28px' } }));
    composerInput.focus();
  }
  function cancelReply() {
    reply = null;
    replyBar.hidden = true;
  }

  // Files to send: a preview at once, uploading right away (two at a time).
  async function addFiles(files) {
    if (readonly) return;
    for (const file of files) {
      if (state.limits.upload && file.size > state.limits.upload) { toast(`${file.name} is too big (at most ${formatSize(state.limits.upload)})`, { error: true }); continue; }
      if (tray.some(i => !i.failed && i.file.name === file.name && i.file.size === file.size && i.file.lastModified === file.lastModified)) {
        toast(`${file.name} is attached already`);
        continue;
      }
      const item = { key: Math.random().toString(36).slice(2), file, progress: 0, local: file.type.startsWith('image/') ? URL.createObjectURL(file) : null };
      // (1.8.4) the same file as one a gone page left unsent: it goes on from where the server got to
      const left = unsent.find(u => u.name === file.name && u.size === file.size && !busy.has(u.id));
      if (left) {
        item.id = left.id;
        item.offset = left.received;
        busy.add(left.id);
        unsent = unsent.filter(u => u !== left);
        renderUnsent();
      }
      tray.push(item);
      startUpload(item);
    }
    renderTray();
  }

  // (1.8.4) Files a page that's gone (closed, reloaded, a phone that dropped it) left unsent: go on with them (pick the
  // same file again; one that's all there is attached at once) or discard them.
  let unsent = [];
  function renderUnsent() {
    unsentEl.hidden = !unsent.length || readonly;
    fill(unsentEl, ...unsent.slice(0, 3).map(u => {
      const whole = u.received >= u.size;
      return h('div', { class: 'unsent-row' },
        icon('file'),
        h('span', { class: 'what' }, h('strong', {}, u.name), ' ', whole ? 'is uploaded but wasn’t sent' : `stopped at ${formatSize(u.received)} of ${formatSize(u.size)}`),
        h('button', { type: 'button', class: 'btn small', onclick: () => (whole ? attachLeftOver(u) : fileInput.click()) }, whole ? 'Attach' : 'Pick it again'),
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => { discardUpload(u.id); unsent = unsent.filter(x => x !== u); renderUnsent(); } }, 'Discard'));
    }));
  }
  function attachLeftOver(u) {
    const item = { key: Math.random().toString(36).slice(2), file: { name: u.name, size: u.size, type: u.mime }, id: u.id, offset: u.size, progress: 1, done: true, thumbTried: true, local: null };
    item.ready = Promise.resolve(u.id);
    busy.add(u.id);
    unsent = unsent.filter(x => x !== u);
    tray.push(item);
    renderUnsent();
    renderTray();
  }
  if (!readonly) leftOver().then(list => { if (!destroyed) { unsent = list; renderUnsent(); } }).catch(() => {});

  // Sends a file of the tray, or again after it failed (from where the server got to). item.abort stops it (1.8.3).
  function startUpload(item) {
    item.failed = false;
    item.error = null;
    const abort = item.abort = new AbortController();
    item.ready = (async () => {
      if (!item.thumbTried) {
        item.thumbTried = true;
        item.thumb = await makeThumb(item.file);
        if (!item.local && item.thumb) item.local = URL.createObjectURL(item.thumb.blob);
        renderTray();
      }
      await uploadSlot();
      sendingFiles(1);
      try {
        if (item.cancelled) throw new DOMException('Cancelled', 'AbortError'); // (while it waited for its turn)
        return await upload(item, progressed, abort.signal);
      } catch (err) {
        item.failed = true;
        item.error = err.message;
        renderTray();
        throw err;
      } finally {
        sendingFiles(-1);
        releaseSlot();
      }
    })();
    item.ready.catch(() => {});
  }

  // A piece more of a file went: the tray, and the message it's in once sent.
  function progressed(item) {
    if (tray.includes(item)) renderTray();
    if (item.message) showProgress(item.message);
  }

  let active = 0;
  const waiting = [];
  const uploadSlot = () => (active < 2 ? (active++, Promise.resolve()) : new Promise(r => waiting.push(r)));
  const releaseSlot = () => { const next = waiting.shift(); if (next) next(); else active--; };

  function renderTray() {
    trayEl.hidden = !tray.length;
    fill(trayEl, ...tray.map(item => h('div', { class: `tray-item${item.failed ? ' failed' : ''}`, title: item.error || item.file.name },
      item.local ? h('img', { src: item.local, alt: '' }) : h('span', {}, icon('file'), h('br'), item.file.name),
      h('span', { class: 'bar', style: { width: `${Math.round((item.progress || 0) * 100)}%` } }),
      h('button', { class: 'x', type: 'button', 'aria-label': `Remove ${item.file.name}`, onclick: () => { cancelUpload(item); tray = tray.filter(x => x !== item); renderTray(); } }, '×'))));
  }

  // @mentions: who's in this conversation, as you type.
  let choices = [];
  let chosen = 0;
  function audienceIds() {
    const ch = channel(channelId);
    if (ch.kind === 'text') return state.spaces.find(s => s.id === ch.space)?.members || [...state.people.keys()];
    return ch.members || [];
  }
  function updateSuggest() {
    const before = composerInput.value.slice(0, composerInput.selectionStart);
    const m = /(^|\s)@([^\s@]{0,32})$/.exec(before);
    if (!m) { suggest.hidden = true; choices = []; return; }
    const q = m[2].toLowerCase();
    const ids = audienceIds().filter(id => id !== state.me.id && !person(id).disabled);
    choices = ids.map(person).filter(p => p.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 8).map(p => ({ label: p.name, person: p }));
    if (channel(channelId).kind !== 'dm') for (const word of ['everyone', 'here']) if (word.startsWith(q)) choices.push({ label: word, everyone: true });
    if (!choices.length) { suggest.hidden = true; return; }
    chosen = Math.min(chosen, choices.length - 1);
    suggest.hidden = false;
    fill(suggest, ...choices.map((ch, i) => h('button', { type: 'button', role: 'option', class: i === chosen ? 'on' : '', 'aria-selected': String(i === chosen), onmousedown: e => { e.preventDefault(); pickSuggestion(i); } },
      ch.person ? avatar(ch.person, { size: 's' }) : icon('at'), h('span', {}, ch.person ? ch.person.name : `@${ch.label}`), ch.everyone ? h('span', { class: 'muted small' }, ch.label === 'here' ? 'everyone here' : 'everyone in the conversation') : null)));
  }
  function pickSuggestion(i) {
    const c2 = choices[i];
    const pos = composerInput.selectionStart;
    const before = composerInput.value.slice(0, pos).replace(/@([^\s@]{0,32})$/, `@${c2.label} `);
    composerInput.value = before + composerInput.value.slice(pos);
    composerInput.setSelectionRange(before.length, before.length);
    suggest.hidden = true;
    choices = [];
    onInput();
  }

  function onInput() {
    autoGrow(composerInput);
    saveDraft(channelId, composerInput.value);
    updateSuggest();
    if (composerInput.value.trim() && Date.now() - lastTyping > 3000) {
      lastTyping = Date.now();
      api(`/api/channels/${channelId}/typing`, { method: 'POST' }).catch(() => {});
    }
  }

  composerInput.addEventListener('input', onInput);
  composerInput.addEventListener('click', updateSuggest);
  composerInput.addEventListener('keydown', e => {
    if (!suggest.hidden && choices.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); chosen = (chosen + (e.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length; updateSuggest(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSuggestion(chosen); return; }
      if (e.key === 'Escape') { e.preventDefault(); suggest.hidden = true; return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouch()) { e.preventDefault(); send(); }
    else if (e.key === 'Escape' && reply) { e.preventDefault(); cancelReply(); }
    else if (e.key === 'ArrowUp' && !composerInput.value) {
      const last = [...cache.list].reverse().find(m => m.author === state.me.id && !m.pending && !isSystem(m));
      if (last) { e.preventDefault(); startEdit(last); }
    }
  });
  composerInput.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  // Sends now; files still uploading go with it as soon as they're done (the message waits, shown as sending).
  async function send() {
    const text = toWire(composerInput.value.trim());
    const items = tray.filter(i => !i.failed);
    if (!text && !items.length) return;
    if (text.length > 16000 || [...text].length > state.limits.body) return toast(`A message can be at most ${state.limits.body.toLocaleString()} characters`, { error: true });
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const pending = {
      id: `~${nonce}`, nonce, channel: channelId, author: state.me.id, body: text, created: Date.now(), pending: true,
      reply: reply ? { id: reply.id, author: reply.author, body: reply.body } : undefined,
      files: items.map(i => ({ id: i.key, name: i.file.name, mime: i.file.type || 'application/octet-stream', size: i.file.size, local: i.local, width: i.thumb?.width, height: i.thumb?.height })),
    };
    pending.request = { body: text, reply: reply?.id, items };
    for (const i of items) i.message = pending;
    composerInput.value = '';
    saveDraft(channelId, '');
    autoGrow(composerInput);
    cancelReply();
    tray = [];
    renderTray();
    suggest.hidden = true;
    if (!cache.latest) await jumpToLatest();
    addPending(channelId, pending);
    scrollToBottom();
    deliver(pending);
  }

  async function deliver(pending) {
    try {
      const ids = await Promise.all(pending.request.items.map(i => i.ready));
      const r = await api(`/api/channels/${channelId}/messages`, { method: 'POST', body: { body: pending.request.body, reply: pending.request.reply, files: ids, nonce: pending.nonce } });
      for (const id of ids) busy.delete(id);
      applyEvent('msg', { message: r.message, nonce: pending.nonce });
    } catch (err) {
      if (pending.cancelled) return;
      pending.failed = true;
      pending.error = err.message;
      // (no connection, or the page was paused: worth going on by itself when the app is back in front)
      pending.resumable = !(err instanceof ApiError && err.status && err.status < 500);
      emit(`messages:${channelId}`, { op: 'edit', id: pending.id });
      toast(err instanceof ApiError && err.status ? err.message : 'Not sent: check your connection and try again', { error: true });
    }
  }

  function retry(m) {
    m.failed = false;
    for (const i of m.request.items) if (i.failed) startUpload(i);
    emit(`messages:${channelId}`, { op: 'edit', id: m.id });
    deliver(m);
  }

  // Dropping files anywhere on the conversation.
  const view = h('section', { class: 'main', 'aria-label': 'Conversation' }, head, h('div', { class: 'list-wrap' }, list, jumpBtn), typingLine, composer, selectBar);
  list.addEventListener('click', e => {
    if (!selecting) return;
    const el = e.target.closest('.msg[data-pickable]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    pick(el.dataset.id);
  }, true);
  view.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files') && !readonly) e.preventDefault(); });
  view.addEventListener('drop', e => {
    if (!e.dataTransfer?.files?.length || readonly) return;
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
  });

  // ---------------------------------------------------------------- start

  renderHead();
  (async () => {
    try {
      if (jump) await jumpTo(jump);
      else {
        if (!cache.loaded || !cache.latest) await loadLatest();
        if (destroyed) return;
        renderAll();
        const line = list.querySelector('#new-line');
        if (line && line.offsetTop > list.clientHeight / 2) list.scrollTop = line.offsetTop - list.clientHeight / 3;
        else scrollToBottom();
      }
      updateJump();
      markRead();
      if (!isPhone() && !readonly) composerInput.focus({ preventScroll: true });
      autoGrow(composerInput);
      if (list.scrollHeight <= list.clientHeight && cache.more.before) loadOlder();
    } catch (err) {
      if (!destroyed) {
        fill(list, h('div', { class: 'start' }, h('p', { class: 'error-text' }, err.message), h('button', { class: 'btn', type: 'button', onclick: () => nav.go(`/c/${channelId}`, { replace: true }) }, 'Try again')));
      }
    }
  })();

  // Back in front: read marks, and (1.8.3) a message whose files stopped while the page was paused (a phone does that in
  // the background) carries on by itself, from where the server got to.
  const onVisible = () => {
    markRead();
    if (destroyed || document.visibilityState !== 'visible') return;
    for (const m of cache.list.filter(m => m.pending && m.failed && m.resumable && !m.cancelled && m.request)) retry(m);
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);

  return {
    el: view,
    jumpTo,
    focusComposer: () => composerInput.focus(),
    destroy() {
      destroyed = true;
      stopSelecting();
      closeMenu();
      clearInterval(typingTimer);
      clearTimeout(readTimer);
      for (const off of offs) off();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    },
  };
}
