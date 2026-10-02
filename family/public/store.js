// What the app knows: me, the people, spaces, conversations (with unread counts) and the messages loaded so far.
// Live events change it here; views listen to topics: 'people', 'channels', 'channel:<id>', 'messages:<id>',
// 'typing:<id>', 'me', 'unread'.

export const state = {
  me: null,
  people: new Map(),
  spaces: [],
  channels: new Map(),
  messages: new Map(), // channel id -> { list, byId, more: { before, after }, latest }
  typing: new Map(), // channel id -> Map(person id -> until)
  limits: { body: 4000, upload: 0, group: 20 },
  pushKey: null,
  version: '',
  client: null, // this app's live connection id
  current: null, // the conversation on screen
  connected: false,
};

const listeners = new Map();

export function on(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  return () => listeners.get(topic)?.delete(fn);
}

export function emit(topic, detail) {
  for (const fn of [...(listeners.get(topic) || [])]) {
    try { fn(detail); } catch (err) { console.error(err); }
  }
}

export const person = id => state.people.get(id) || { id, name: 'Someone', color: 0 };
export const channel = id => state.channels.get(id) || null;
export const isAdmin = () => state.me && state.me.role !== 'member';

export function applyBootstrap(b) {
  state.me = b.me;
  state.people = new Map(b.people.map(p => [p.id, p]));
  state.spaces = b.spaces;
  state.channels = new Map(b.channels.map(c => [c.id, c]));
  state.limits = b.limits;
  state.pushKey = b.push;
  state.version = b.version;
  // Messages loaded before are kept only for conversations still there (a resync may have changed anything).
  for (const id of [...state.messages.keys()]) if (!state.channels.has(id)) state.messages.delete(id);
  emit('people');
  emit('channels');
  emit('me');
  emit('unread');
}

// The name a conversation is shown by: #channel, the other person, or a group's name (else its people).
export function title(c) {
  if (!c) return '';
  if (c.kind === 'text') return c.name;
  const others = (c.members || []).filter(id => id !== state.me?.id).map(id => person(id).name);
  if (c.kind === 'dm') return others[0] || 'Just you';
  return c.name || others.join(', ') || 'Group';
}

export const otherPerson = c => (c?.kind === 'dm' ? person((c.members || []).find(id => id !== state.me?.id)) : null);

export function sortedChannels() {
  const all = [...state.channels.values()];
  return {
    text: all.filter(c => c.kind === 'text' && !c.archived).sort((a, b) => a.position - b.position || a.created - b.created),
    direct: all.filter(c => c.kind !== 'text').sort((a, b) => (b.last || '').localeCompare(a.last || '') || b.created - a.created),
  };
}

export function totals() {
  let unread = 0;
  let mentions = 0;
  for (const c of state.channels.values()) {
    if (c.notify === 'none' && !c.mentions) continue;
    if (c.kind !== 'text') mentions += c.unread; // every direct message counts like a mention
    else mentions += c.mentions;
    unread += c.unread;
  }
  return { unread, mentions };
}

// ---------------------------------------------------------------- messages

export function cacheOf(channelId) {
  let cache = state.messages.get(channelId);
  if (!cache) state.messages.set(channelId, (cache = { list: [], byId: new Map(), more: { before: true, after: false }, latest: false, loaded: false }));
  return cache;
}

function sortList(cache) {
  cache.list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// A page from the server, merged in (older or newer than what's there, or around a message).
export function mergePage(channelId, messages, { more, latest = false, reset = false }) {
  const cache = cacheOf(channelId);
  if (reset) { cache.list = []; cache.byId = new Map(); cache.latest = false; }
  for (const m of messages) {
    if (cache.byId.has(m.id)) Object.assign(cache.byId.get(m.id), m);
    else { cache.byId.set(m.id, m); cache.list.push(m); }
  }
  sortList(cache);
  if (more) {
    if ('before' in more) cache.more.before = more.before;
    if ('after' in more) cache.more.after = more.after;
  }
  if (latest) cache.latest = true;
  cache.loaded = true;
  return cache;
}

// A message just sent from here, shown at once (it's replaced by the server's copy, matched by nonce).
export function addPending(channelId, pending) {
  const cache = cacheOf(channelId);
  cache.list.push(pending);
  cache.byId.set(pending.id, pending);
  emit(`messages:${channelId}`, { op: 'add', id: pending.id });
}

export function dropPending(channelId, id) {
  const cache = state.messages.get(channelId);
  if (!cache?.byId.has(id)) return;
  cache.byId.delete(id);
  cache.list = cache.list.filter(m => m.id !== id);
  emit(`messages:${channelId}`, { op: 'reset' });
}

function addMessage(m, nonce) {
  const c = state.channels.get(m.channel);
  // Newer than anything known in that conversation: the same message again (the answer to sending it, a replay
  // after reconnecting) changes nothing.
  const fresh = !c || !c.last || m.id > c.last;
  const cache = state.messages.get(m.channel);
  if (cache) {
    const pending = nonce && cache.list.find(x => x.pending && x.nonce === nonce);
    if (pending) {
      cache.byId.delete(pending.id);
      cache.list = cache.list.filter(x => x !== pending);
    }
    const added = !cache.byId.has(m.id) && cache.latest;
    if (added) {
      cache.byId.set(m.id, m);
      cache.list.push(m);
      sortList(cache);
    }
    if (pending) emit(`messages:${m.channel}`, { op: 'reset' });
    else if (added) emit(`messages:${m.channel}`, { op: 'add', id: m.id });
  }
  if (c && fresh) {
    c.last = m.id;
    if (m.author === state.me?.id) {
      c.read = m.id;
      c.unread = 0;
      c.mentions = 0;
    } else if (m.kind !== 'joined' && m.kind !== 'left' && m.kind !== 'renamed' && (!c.read || m.id > c.read)) {
      c.unread = Math.min(100, (c.unread || 0) + 1);
      if (mentionsMe(m)) c.mentions = (c.mentions || 0) + 1;
    }
    emit('channels');
    emit(`channel:${c.id}`);
    emit('unread');
  }
  // Whoever just wrote isn't typing any more.
  const t = state.typing.get(m.channel);
  if (t?.delete(m.author)) emit(`typing:${m.channel}`);
}

export const mentionsMe = m => Boolean(state.me) && m.author !== state.me.id && (m.everyone || (m.body || '').includes(`<@${state.me.id}>`));

function replaceMessage(m) {
  const cache = state.messages.get(m.channel);
  if (!cache?.byId.has(m.id)) return;
  Object.assign(cache.byId.get(m.id), m, { reactions: m.reactions, files: m.files, pinned: m.pinned, edited: m.edited });
  if (!m.reactions) delete cache.byId.get(m.id).reactions;
  emit(`messages:${m.channel}`, { op: 'edit', id: m.id });
}

// ---------------------------------------------------------------- live events

export function applyEvent(type, d) {
  switch (type) {
    case 'msg': return addMessage(d.message, d.nonce);
    case 'msg-edit': return replaceMessage(d.message);
    case 'msg-del': {
      const cache = state.messages.get(d.channel);
      if (cache?.byId.has(d.id)) {
        cache.byId.delete(d.id);
        cache.list = cache.list.filter(m => m.id !== d.id);
        for (const m of cache.list) if (m.reply?.id === d.id) m.reply = { id: d.id, deleted: true };
        emit(`messages:${d.channel}`, { op: 'reset' });
      }
      return;
    }
    case 'react': {
      const m = state.messages.get(d.channel)?.byId.get(d.id);
      if (!m) return;
      const list = (m.reactions ||= []);
      let r = list.find(x => x.emoji === d.emoji);
      if (d.on) {
        if (!r) list.push((r = { emoji: d.emoji, users: [] }));
        if (!r.users.includes(d.person)) r.users.push(d.person);
      } else if (r) {
        r.users = r.users.filter(u => u !== d.person);
        if (!r.users.length) m.reactions = list.filter(x => x !== r);
      }
      return emit(`messages:${d.channel}`, { op: 'edit', id: d.id });
    }
    case 'read': {
      const c = state.channels.get(d.channel);
      if (!c || (c.read && d.id <= c.read)) return;
      c.read = d.id;
      if (!c.last || d.id >= c.last) { c.unread = 0; c.mentions = 0; }
      emit('channels');
      emit(`channel:${c.id}`);
      return emit('unread');
    }
    case 'typing': {
      if (!state.typing.has(d.channel)) state.typing.set(d.channel, new Map());
      state.typing.get(d.channel).set(d.person, Date.now() + 6000);
      return emit(`typing:${d.channel}`);
    }
    case 'presence': {
      const p = state.people.get(d.person);
      if (p) { p.online = d.online; emit('people'); }
      return;
    }
    case 'people': {
      const p = d.person;
      const old = state.people.get(p.id);
      state.people.set(p.id, { ...old, ...p });
      if (p.id === state.me?.id) { state.me = { ...state.me, ...p }; emit('me'); }
      return emit('people');
    }
    case 'channel': {
      const old = state.channels.get(d.channel.id);
      state.channels.set(d.channel.id, { read: null, unread: 0, mentions: 0, notify: 'all', ...old, ...d.channel });
      emit('channels');
      return emit(`channel:${d.channel.id}`);
    }
    case 'channel-gone': {
      state.channels.delete(d.id);
      state.messages.delete(d.id);
      emit('channels');
      emit('unread');
      return emit(`channel:${d.id}`);
    }
    case 'space': {
      const s = state.spaces.find(x => x.id === d.space.id);
      if (s) s.name = d.space.name;
      return emit('channels');
    }
    case 'notify': {
      const c = state.channels.get(d.channel);
      if (c) { c.notify = d.level; emit('channels'); emit(`channel:${c.id}`); emit('unread'); }
      return;
    }
    default:
  }
}
