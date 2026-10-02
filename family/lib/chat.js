'use strict';
// The chat: spaces and their channels, direct and group messages, messages (replies, mentions, edits, deletes),
// reactions, pins, what each person has read, typing, notification levels and search.

const { newId, isId } = require('./ids');
const { httpError, send, readJson } = require('./http');
const auth = require('./auth');

const now = () => Date.now();
const MAX_BODY = 4000;
const PAGE = 50;
const MAX_GROUP = 20;
const BIDI = /[‪-‮⁦-⁩]/g; // direction overrides and isolates (they can make text lie)

// Message text: newlines kept, control and direction-override characters dropped, trailing spaces trimmed.
function cleanBody(text) {
  if (text === undefined || text === null) return '';
  if (typeof text !== 'string') throw httpError(400, 'body must be text');
  const s = text.toWellFormed().replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(BIDI, '').replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '');
  if (s.length > MAX_BODY * 2 || [...s].length > MAX_BODY) throw httpError(400, 'A message can be at most 4,000 characters');
  return s;
}

function cleanChannelName(name) {
  const s = String(name ?? '').toWellFormed().replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[‪-‮⁦-⁩‎‏؜]/g, '')
    .replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '');
  if (!s) throw httpError(400, 'Choose a name');
  if ([...s].length > 40) throw httpError(400, 'Use at most 40 characters for the name');
  return s;
}

function cleanTopic(topic) {
  const s = String(topic ?? '').toWellFormed().replace(/[\u0000-\u001f\u007f]/g, ' ').replace(BIDI, '').replace(/\s+/g, ' ').trim();
  if ([...s].length > 200) throw httpError(400, 'Use at most 200 characters for the topic');
  return s;
}

// A reaction: one emoji (flags, keycaps, skin tones and ZWJ sequences included), nothing else.
const EMOJI_CHARS = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️⃣#*0-9\u{e0020}-\u{e007f}]+$/u;
const EMOJI_BASE = /[\p{Extended_Pictographic}\p{Regional_Indicator}⃣]/u;
function cleanEmoji(e) {
  const s = String(e ?? '');
  if (!s || s.length > 32 || [...s].length > 12 || !EMOJI_CHARS.test(s) || !EMOJI_BASE.test(s)) throw httpError(400, 'A reaction is one emoji');
  return s;
}

// <@ID> marks a mention; @everyone and @here mention everyone in the channel.
const MENTION = /<@([0-9A-HJKMNP-TV-Z]{26})>/g;
const EVERYONE = /(^|[^\w@])@(everyone|here)\b/i;

function createChat(ctx) {
  const { db, hub, log, config } = ctx;
  const typingLimit = auth.createLimiter({ limit: 1, windowMs: 2500 });
  const postLimit = auth.createLimiter({ limit: config.postsPer10s || 20, windowMs: 10_000 });
  const people = () => ctx.people;

  // ---------------------------------------------------------------- spaces

  function createDefaultSpace(ownerId) {
    const space = newId();
    db.run('INSERT INTO spaces (id, name, created_at, created_by) VALUES (?, ?, ?, ?)', space, config.spaceName || 'Family', now(), ownerId);
    ['general', 'photos'].forEach((name, i) => db.run('INSERT INTO channels (id, space_id, kind, name, topic, position, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      newId(), space, 'text', name, i === 0 ? 'Say hello' : 'Pictures and videos', i, now(), ownerId));
    return space;
  }

  const mainSpace = () => db.get('SELECT id FROM spaces ORDER BY created_at, id LIMIT 1')?.id || null;
  const spaceName = () => db.get('SELECT name FROM spaces ORDER BY created_at, id LIMIT 1')?.name || config.spaceName || 'Family';

  // Joining a space: its channels start out read (a newcomer isn't greeted by years of unread history).
  function addToSpace(spaceId, userId) {
    db.run('INSERT OR IGNORE INTO space_members (space_id, user_id, joined_at) VALUES (?, ?, ?)', spaceId, userId, now());
    for (const c of db.all('SELECT id, last_id FROM channels WHERE space_id = ? AND last_id IS NOT NULL', spaceId)) {
      db.run('INSERT OR REPLACE INTO reads (user_id, channel_id, last_id) VALUES (?, ?, ?)', userId, c.id, c.last_id);
    }
  }

  function announceJoin(user) {
    const space = db.get('SELECT space_id FROM space_members WHERE user_id = ? ORDER BY joined_at LIMIT 1', user.id)?.space_id;
    const general = space && db.get("SELECT * FROM channels WHERE space_id = ? AND kind = 'text' AND archived_at IS NULL ORDER BY position, created_at LIMIT 1", space);
    if (general) systemMessage(general, user.id, 'joined');
  }

  // ---------------------------------------------------------------- who sees what

  function visibleChannels(user) {
    return db.all(`
      SELECT c.* FROM channels c JOIN space_members sm ON sm.space_id = c.space_id AND sm.user_id = ?
        WHERE c.kind = 'text' AND (c.archived_at IS NULL OR ? != 'member')
      UNION ALL
      SELECT c.* FROM channels c JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = ?
        WHERE c.kind IN ('dm', 'group')`, user.id, user.role, user.id);
  }

  // The channel if this person may see it (else 404, as if it weren't there); `write`: may post (not archived).
  function channelFor(user, id, { write = false } = {}) {
    const c = isId(id) ? db.get('SELECT * FROM channels WHERE id = ?', id) : null;
    const ok = c && (c.kind === 'text'
      ? Boolean(db.get('SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?', c.space_id, user.id)) && (!c.archived_at || user.role !== 'member')
      : Boolean(db.get('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?', c.id, user.id)));
    if (!ok) throw httpError(404, 'No such conversation');
    if (write && c.archived_at) throw httpError(403, 'This channel is archived');
    return c;
  }

  // Everyone who sees a channel (the people its events go to).
  function audience(c) {
    const rows = c.kind === 'text'
      ? db.all('SELECT u.id FROM space_members sm JOIN users u ON u.id = sm.user_id WHERE sm.space_id = ? AND u.disabled_at IS NULL', c.space_id)
      : db.all('SELECT u.id FROM channel_members cm JOIN users u ON u.id = cm.user_id WHERE cm.channel_id = ? AND u.disabled_at IS NULL', c.id);
    return rows.map(r => r.id);
  }

  function channelJson(c) {
    const out = { id: c.id, kind: c.kind, name: c.name || '', topic: c.topic || '', position: c.position, created: c.created_at, last: c.last_id || null };
    if (c.space_id) out.space = c.space_id;
    if (c.archived_at) out.archived = true;
    if (c.kind !== 'text') out.members = db.all('SELECT user_id FROM channel_members WHERE channel_id = ? ORDER BY added_at', c.id).map(r => r.user_id);
    return out;
  }

  // ---------------------------------------------------------------- messages as JSON

  const placeholders = n => Array(n).fill('?').join(', ');

  function messagesJson(rows) {
    if (!rows.length) return [];
    const ids = rows.map(r => r.id);
    const reactions = new Map();
    for (const r of db.all(`SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${placeholders(ids.length)}) ORDER BY created_at`, ...ids)) {
      let list = reactions.get(r.message_id);
      if (!list) reactions.set(r.message_id, (list = new Map()));
      if (!list.has(r.emoji)) list.set(r.emoji, []);
      list.get(r.emoji).push(r.user_id);
    }
    const files = new Map();
    for (const a of db.all(`SELECT * FROM attachments WHERE message_id IN (${placeholders(ids.length)}) ORDER BY created_at, id`, ...ids)) {
      if (!files.has(a.message_id)) files.set(a.message_id, []);
      files.get(a.message_id).push(ctx.files ? ctx.files.attachmentJson(a) : { id: a.id, name: a.name, mime: a.mime, size: a.size });
    }
    const replyIds = [...new Set(rows.map(r => r.reply_to).filter(Boolean))];
    const replies = new Map();
    if (replyIds.length) {
      for (const r of db.all(`SELECT m.id, m.author_id, m.body, m.deleted_at, (SELECT count(*) FROM attachments a WHERE a.message_id = m.id) AS files
        FROM messages m WHERE m.id IN (${placeholders(replyIds.length)})`, ...replyIds)) {
        replies.set(r.id, r.deleted_at ? { id: r.id, deleted: true } : { id: r.id, author: r.author_id, body: [...r.body].slice(0, 200).join(''), files: r.files });
      }
    }
    return rows.map(r => {
      const m = { id: r.id, channel: r.channel_id, author: r.author_id, body: r.body, created: r.created_at };
      if (r.kind !== 'user') m.kind = r.kind;
      if (r.edited_at) m.edited = r.edited_at;
      if (r.deleted_at) m.deleted = true;
      if (r.pinned_at) m.pinned = r.pinned_at;
      if (r.mentions_all) m.everyone = true;
      if (r.reply_to) m.reply = replies.get(r.reply_to) || { id: r.reply_to, deleted: true };
      const reacts = reactions.get(r.id);
      if (reacts) m.reactions = [...reacts].map(([emoji, users]) => ({ emoji, users }));
      if (files.has(r.id)) m.files = files.get(r.id);
      return m;
    });
  }

  const messageJson = id => messagesJson([db.get('SELECT * FROM messages WHERE id = ?', id)])[0];

  function getMessage(user, id) {
    const m = isId(id) ? db.get('SELECT * FROM messages WHERE id = ?', id) : null;
    if (!m || m.deleted_at) throw httpError(404, 'No such message');
    const c = channelFor(user, m.channel_id);
    return { m, c };
  }

  // A line like "Mary joined" (kind system), from the server.
  function systemMessage(c, userId, kind, body = '') {
    const id = newId();
    db.tx(() => {
      db.run('INSERT INTO messages (id, channel_id, author_id, body, created_at, kind) VALUES (?, ?, ?, ?, ?, ?)', id, c.id, userId, body, now(), kind);
      db.run('UPDATE channels SET last_id = ? WHERE id = ?', id, c.id);
    });
    hub.emit(audience(c), 'msg', { message: messageJson(id) });
    return id;
  }

  // ---------------------------------------------------------------- bootstrap and live updates

  // GET /api/bootstrap: everything the app shows at first.
  function bootstrap(req, res) {
    const user = people().requireUser(req);
    const channels = visibleChannels(user);
    const reads = new Map(db.all('SELECT channel_id, last_id FROM reads WHERE user_id = ?', user.id).map(r => [r.channel_id, r.last_id]));
    const levels = new Map(db.all('SELECT channel_id, level FROM notify WHERE user_id = ?', user.id).map(r => [r.channel_id, r.level]));
    const out = {
      me: people().personJson(user, user),
      people: db.all('SELECT * FROM users ORDER BY created_at').map(u => people().personJson(u, user)),
      spaces: db.all('SELECT s.* FROM spaces s JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ? ORDER BY s.created_at', user.id)
        .map(s => ({ id: s.id, name: s.name, members: db.all('SELECT user_id FROM space_members WHERE space_id = ? ORDER BY joined_at', s.id).map(r => r.user_id) })),
      channels: channels.map(c => {
        const j = channelJson(c);
        const last = reads.get(c.id) || '';
        j.read = last || null;
        j.unread = c.last_id && c.last_id > last ? db.get(`SELECT count(*) n FROM (SELECT 1 FROM messages WHERE channel_id = ? AND id > ? AND deleted_at IS NULL
          AND kind = 'user' AND (author_id IS NULL OR author_id != ?) LIMIT 100)`, c.id, last, user.id).n : 0;
        // (counted up to 100, like unread: 1.7.3, audit B-08)
        j.mentions = j.unread ? db.get(`SELECT count(*) n FROM (SELECT 1 FROM messages m WHERE m.channel_id = ? AND m.id > ? AND m.deleted_at IS NULL AND m.author_id != ?
          AND (m.mentions_all = 1 OR EXISTS (SELECT 1 FROM mentions x WHERE x.message_id = m.id AND x.user_id = ?)) LIMIT 100)`, c.id, last, user.id, user.id).n : 0;
        j.notify = levels.get(c.id) || 'all';
        return j;
      }),
      limits: { body: MAX_BODY, upload: config.maxUpload, group: MAX_GROUP },
      version: ctx.version,
      push: ctx.push ? ctx.push.publicKey() : null,
    };
    send(res, 200, out);
  }

  // GET /api/events
  function events(req, res) {
    const user = people().requireUser(req);
    hub.connect(req, res, user, people().whoIs(req).sessionHash || null); // (its sign-in ending ends it too)
  }

  // PUT /api/focus { client, channel, visible }: what an open app shows (no push for what's being looked at).
  async function focus(req, res) {
    const user = people().requireUser(req);
    const body = await readJson(req);
    if (body.channel) channelFor(user, body.channel);
    if (!hub.setFocus(String(body.client || ''), user.id, body.channel || null, body.visible !== false)) throw httpError(404, 'That live connection is gone');
    send(res, 204);
  }

  // ---------------------------------------------------------------- channels

  // POST /api/spaces/:id/channels { name, topic? } (admins)
  async function createChannel(req, res, { id }) {
    const admin = people().requireAdmin(req);
    const space = isId(id) && db.get('SELECT * FROM spaces WHERE id = ?', id);
    if (!space || !db.get('SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?', id, admin.id)) throw httpError(404, 'No such space');
    const body = await readJson(req);
    const name = cleanChannelName(body.name);
    if (db.get("SELECT 1 FROM channels WHERE space_id = ? AND kind = 'text' AND archived_at IS NULL AND name = ? COLLATE NOCASE", id, name)) {
      throw httpError(409, 'There’s already a channel with that name');
    }
    const c = { id: newId(), space_id: id, kind: 'text', name, topic: cleanTopic(body.topic), position: (db.get('SELECT max(position) p FROM channels WHERE space_id = ?', id).p ?? -1) + 1, created_at: now(), created_by: admin.id };
    db.run('INSERT INTO channels (id, space_id, kind, name, topic, position, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      c.id, c.space_id, c.kind, c.name, c.topic, c.position, c.created_at, c.created_by);
    people().audit(admin.id, 'channel', `${c.id} ${name}`);
    log.info(`${admin.name} made the channel #${name}`);
    const row = db.get('SELECT * FROM channels WHERE id = ?', c.id);
    hub.emit(audience(row), 'channel', { channel: { ...channelJson(row), read: null, unread: 0, mentions: 0, notify: 'all' } });
    send(res, 201, { channel: channelJson(row) });
  }

  // PATCH /api/spaces/:id { name } (admins)
  async function updateSpace(req, res, { id }) {
    const admin = people().requireAdmin(req);
    const space = isId(id) && db.get('SELECT * FROM spaces WHERE id = ?', id);
    if (!space) throw httpError(404, 'No such space');
    const body = await readJson(req);
    const name = cleanChannelName(body.name);
    db.run('UPDATE spaces SET name = ? WHERE id = ?', name, id);
    people().audit(admin.id, 'space', `${id} ${name}`);
    hub.emit(db.all('SELECT user_id FROM space_members WHERE space_id = ?', id).map(r => r.user_id), 'space', { space: { id, name } });
    send(res, 200, { space: { id, name } });
  }

  // PATCH /api/channels/:id { name?, topic?, position?, archived? }: admins for channels; members for a group's name.
  async function updateChannel(req, res, { id }) {
    const user = people().requireUser(req);
    const c = channelFor(user, id);
    const body = await readJson(req);
    if (c.kind === 'dm') throw httpError(400, 'A direct conversation has no settings');
    if (c.kind === 'text' && user.role === 'member') throw httpError(403, 'Only the family space’s admins can change channels');
    if (c.kind === 'group' && (body.position !== undefined || body.archived !== undefined || body.topic !== undefined)) throw httpError(400, 'A group can only be renamed');
    const sets = {};
    if (body.name !== undefined) {
      sets.name = c.kind === 'group' && (body.name === null || body.name === '') ? null : cleanChannelName(body.name);
      if (c.kind === 'text' && db.get("SELECT 1 FROM channels WHERE space_id = ? AND kind = 'text' AND archived_at IS NULL AND name = ? COLLATE NOCASE AND id != ?", c.space_id, sets.name, c.id)) {
        throw httpError(409, 'There’s already a channel with that name');
      }
    }
    if (body.topic !== undefined) sets.topic = cleanTopic(body.topic);
    if (body.position !== undefined) {
      const p = Number(body.position);
      if (!Number.isInteger(p) || p < 0 || p > 1000) throw httpError(400, 'position must be a whole number');
      sets.position = p;
    }
    if (body.archived !== undefined) {
      if (typeof body.archived !== 'boolean') throw httpError(400, 'archived must be true or false');
      sets.archived_at = body.archived ? now() : null;
    }
    const keys = Object.keys(sets);
    if (keys.length) db.run(`UPDATE channels SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => sets[k]), c.id);
    const row = db.get('SELECT * FROM channels WHERE id = ?', c.id);
    if (keys.length) {
      people().audit(user.id, 'channel-update', `${c.id} ${keys.join(',')}`);
      if (sets.name !== undefined && c.kind === 'group') systemMessage(row, user.id, 'renamed', row.name || '');
    }
    hub.emit(audience(row), 'channel', { channel: channelJson(row) });
    send(res, 200, { channel: channelJson(row) });
  }

  // POST /api/dms { people: [ids], name? }: a direct conversation (one other person: the same one each time) or a
  // new group.
  async function openDm(req, res) {
    const user = people().requireUser(req);
    const body = await readJson(req);
    const others = [...new Set((Array.isArray(body.people) ? body.people : []).filter(id => id !== user.id))];
    if (!others.length) throw httpError(400, 'Choose who to talk to');
    if (others.length + 1 > MAX_GROUP) throw httpError(400, `A group can have at most ${MAX_GROUP} people`);
    for (const id of others) {
      const p = people().getUser(id);
      if (!p || p.disabled_at) throw httpError(400, 'One of those people isn’t in the family space');
    }
    const members = [user.id, ...others];
    let c;
    if (others.length === 1) {
      const key = [...members].sort().join(',');
      c = db.get('SELECT * FROM channels WHERE dm_key = ?', key);
      if (c) return send(res, 200, { channel: channelJson(c) });
      c = db.tx(() => {
        const id = newId();
        db.run('INSERT INTO channels (id, kind, created_at, created_by, dm_key) VALUES (?, ?, ?, ?, ?)', id, 'dm', now(), user.id, key);
        for (const m of members) db.run('INSERT INTO channel_members (channel_id, user_id, added_at) VALUES (?, ?, ?)', id, m, now());
        return db.get('SELECT * FROM channels WHERE id = ?', id);
      });
    } else {
      const name = body.name ? cleanChannelName(body.name) : null;
      c = db.tx(() => {
        const id = newId();
        db.run('INSERT INTO channels (id, kind, name, created_at, created_by) VALUES (?, ?, ?, ?, ?)', id, 'group', name, now(), user.id);
        for (const m of members) db.run('INSERT INTO channel_members (channel_id, user_id, added_at) VALUES (?, ?, ?)', id, m, now());
        return db.get('SELECT * FROM channels WHERE id = ?', id);
      });
    }
    hub.emit(members, 'channel', { channel: { ...channelJson(c), read: null, unread: 0, mentions: 0, notify: 'all' } });
    send(res, 201, { channel: channelJson(c) });
  }

  // DELETE /api/channels/:id/members/me: leaving a group.
  function leaveGroup(req, res, { id }) {
    const user = people().requireUser(req);
    const c = channelFor(user, id);
    if (c.kind !== 'group') throw httpError(400, 'Only a group can be left');
    systemMessage(c, user.id, 'left');
    db.run('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?', c.id, user.id);
    hub.emit([user.id], 'channel-gone', { id: c.id });
    hub.emit(audience(c), 'channel', { channel: channelJson(c) });
    send(res, 204);
  }

  // ---------------------------------------------------------------- messages

  // GET /api/channels/:id/messages?before=|after=|around=&limit=
  function listMessages(req, res, { id }, url) {
    const user = people().requireUser(req);
    const c = channelFor(user, id);
    const limit = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get('limit')) || PAGE)));
    const before = url.searchParams.get('before');
    const after = url.searchParams.get('after');
    const around = url.searchParams.get('around');
    let rows;
    let more = {};
    const live = 'channel_id = ? AND deleted_at IS NULL';
    if (after) {
      if (!isId(after)) throw httpError(400, 'after must be a message id');
      rows = db.all(`SELECT * FROM messages WHERE ${live} AND id > ? ORDER BY id LIMIT ?`, c.id, after, limit + 1);
      more.after = rows.length > limit;
      rows = rows.slice(0, limit);
    } else if (around) {
      if (!isId(around)) throw httpError(400, 'around must be a message id');
      const half = Math.floor(limit / 2);
      const older = db.all(`SELECT * FROM messages WHERE ${live} AND id < ? ORDER BY id DESC LIMIT ?`, c.id, around, half + 1);
      const newer = db.all(`SELECT * FROM messages WHERE ${live} AND id >= ? ORDER BY id LIMIT ?`, c.id, around, limit - half + 1);
      more = { before: older.length > half, after: newer.length > limit - half };
      rows = [...older.slice(0, half).reverse(), ...newer.slice(0, limit - half)];
    } else {
      if (before && !isId(before)) throw httpError(400, 'before must be a message id');
      rows = before
        ? db.all(`SELECT * FROM messages WHERE ${live} AND id < ? ORDER BY id DESC LIMIT ?`, c.id, before, limit + 1)
        : db.all(`SELECT * FROM messages WHERE ${live} ORDER BY id DESC LIMIT ?`, c.id, limit + 1);
      more.before = rows.length > limit;
      rows = rows.slice(0, limit).reverse();
    }
    send(res, 200, { messages: messagesJson(rows), more });
  }

  // Mentions in a text: people in the channel (by <@id>), and whether it says @everyone.
  function mentionsIn(body, c) {
    const allowed = new Set(audience(c));
    const ids = new Set();
    for (const m of body.matchAll(MENTION)) if (allowed.has(m[1])) ids.add(m[1]);
    return { ids: [...ids], everyone: EVERYONE.test(body) };
  }

  // POST /api/channels/:id/messages { body, reply?, files?: [attachment ids], nonce? }
  async function postMessage(req, res, { id }) {
    const user = people().requireUser(req);
    const c = channelFor(user, id, { write: true });
    if (!postLimit.hit(user.id)) throw httpError(429, 'You’re sending very fast: wait a moment');
    const body = await readJson(req, { limit: 64 * 1024 });
    const text = cleanBody(body.body);
    const fileIds = Array.isArray(body.files) ? [...new Set(body.files)] : [];
    if (fileIds.length > 10) throw httpError(400, 'Send at most 10 files in one message');
    if (!text && !fileIds.length) throw httpError(400, 'The message is empty');
    let replyTo = null;
    if (body.reply) {
      const r = isId(body.reply) && db.get('SELECT id, channel_id FROM messages WHERE id = ? AND deleted_at IS NULL', body.reply);
      if (!r || r.channel_id !== c.id) throw httpError(400, 'The message you’re replying to isn’t in this conversation');
      replyTo = r.id;
    }
    const nonce = typeof body.nonce === 'string' ? body.nonce.slice(0, 64) : undefined;
    const mentions = mentionsIn(text, c);
    const messageId = newId();
    db.tx(() => {
      // Files: this person's, finished, not sent before.
      for (const f of fileIds) {
        const a = isId(f) && db.get('SELECT * FROM attachments WHERE id = ?', f);
        if (!a || a.uploader_id !== user.id || a.message_id) throw httpError(400, 'One of the files isn’t ready to send');
        if (a.received < a.size) throw httpError(409, `${a.name} hasn’t finished uploading`);
      }
      db.run('INSERT INTO messages (id, channel_id, author_id, body, reply_to, created_at, mentions_all) VALUES (?, ?, ?, ?, ?, ?, ?)',
        messageId, c.id, user.id, text, replyTo, now(), mentions.everyone ? 1 : 0);
      for (const f of fileIds) db.run('UPDATE attachments SET message_id = ? WHERE id = ?', messageId, f);
      for (const m of mentions.ids) db.run('INSERT INTO mentions (message_id, user_id) VALUES (?, ?)', messageId, m);
      db.run('UPDATE channels SET last_id = ? WHERE id = ?', messageId, c.id);
      db.run('INSERT OR REPLACE INTO reads (user_id, channel_id, last_id) VALUES (?, ?, ?)', user.id, c.id, messageId);
    });
    const message = messageJson(messageId);
    const to = audience(c);
    hub.emit(to, 'msg', { message, nonce });
    ctx.push?.notifyMessage({ message, channel: c, author: user, to, mentions }).catch(err => log.warn(`Push: ${err.message}`));
    send(res, 201, { message, nonce });
  }

  // PATCH /api/messages/:id { body }: the author's own messages.
  async function editMessage(req, res, { id }) {
    const user = people().requireUser(req);
    const { m, c } = getMessage(user, id);
    if (m.author_id !== user.id || m.kind !== 'user') throw httpError(403, 'You can only edit your own messages');
    if (c.archived_at) throw httpError(403, 'This channel is archived');
    const body = await readJson(req, { limit: 64 * 1024 });
    const text = cleanBody(body.body);
    if (!text && !db.get('SELECT 1 FROM attachments WHERE message_id = ?', m.id)) throw httpError(400, 'The message is empty: delete it instead');
    if (text === m.body) return send(res, 200, { message: messageJson(m.id) });
    const mentions = mentionsIn(text, c);
    db.tx(() => {
      db.run('UPDATE messages SET body = ?, edited_at = ?, mentions_all = ? WHERE id = ?', text, now(), mentions.everyone ? 1 : 0, m.id);
      db.run('DELETE FROM mentions WHERE message_id = ?', m.id);
      for (const p of mentions.ids) db.run('INSERT INTO mentions (message_id, user_id) VALUES (?, ?)', m.id, p);
    });
    const message = messageJson(m.id);
    hub.emit(audience(c), 'msg-edit', { message });
    send(res, 200, { message });
  }

  // DELETE /api/messages/:id: the author, or an admin. The text, reactions and files go; only "deleted" stays.
  function deleteMessage(req, res, { id }) {
    const user = people().requireUser(req);
    const { m, c } = getMessage(user, id);
    const own = m.author_id === user.id;
    if (!own && user.role === 'member') throw httpError(403, 'You can only delete your own messages');
    const files = db.all('SELECT * FROM attachments WHERE message_id = ?', m.id);
    db.tx(() => {
      db.run('UPDATE messages SET body = ?, deleted_at = ?, pinned_at = NULL WHERE id = ?', '', now(), m.id);
      db.run('DELETE FROM reactions WHERE message_id = ?', m.id);
      db.run('DELETE FROM mentions WHERE message_id = ?', m.id);
      db.run('DELETE FROM attachments WHERE message_id = ?', m.id);
    });
    for (const a of files) ctx.files?.removeStored(a).catch(() => {});
    if (!own) {
      people().audit(user.id, 'message-deleted', `${m.id} by ${m.author_id}`);
      log.info(`${user.name} deleted a message by ${people().getUser(m.author_id)?.name || 'someone'}`);
    }
    hub.emit(audience(c), 'msg-del', { id: m.id, channel: c.id });
    send(res, 204);
  }

  // PUT|DELETE /api/messages/:id/reactions/:emoji
  function react(req, res, { id, emoji }) {
    const user = people().requireUser(req);
    const { m, c } = getMessage(user, id);
    if (c.archived_at) throw httpError(403, 'This channel is archived');
    const e = cleanEmoji(emoji);
    const on = req.method === 'PUT';
    if (on) {
      const distinct = db.get('SELECT count(DISTINCT emoji) n FROM reactions WHERE message_id = ? AND emoji != ?', m.id, e).n;
      if (distinct >= 20) throw httpError(400, 'That message has as many different reactions as it can take');
      db.run('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', m.id, user.id, e, now());
    } else {
      db.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', m.id, user.id, e);
    }
    hub.emit(audience(c), 'react', { id: m.id, channel: c.id, emoji: e, person: user.id, on });
    send(res, 204);
  }

  // PUT|DELETE /api/messages/:id/pin
  function pin(req, res, { id }) {
    const user = people().requireUser(req);
    const { m, c } = getMessage(user, id);
    if (c.archived_at) throw httpError(403, 'This channel is archived');
    const on = req.method === 'PUT';
    db.run('UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ?', on ? now() : null, on ? user.id : null, m.id);
    const message = messageJson(m.id);
    hub.emit(audience(c), 'msg-edit', { message });
    send(res, 200, { message });
  }

  // GET /api/channels/:id/pins
  function pins(req, res, { id }) {
    const user = people().requireUser(req);
    const c = channelFor(user, id);
    send(res, 200, { messages: messagesJson(db.all('SELECT * FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL ORDER BY pinned_at DESC LIMIT 100', c.id)) });
  }

  // POST /api/channels/:id/read { id }: read up to that message (only ever forward).
  async function markRead(req, res, { id }) {
    const user = people().requireUser(req);
    const c = channelFor(user, id);
    const body = await readJson(req);
    let last = body.id;
    if (!isId(last)) throw httpError(400, 'id must be a message id');
    if (c.last_id && last > c.last_id) last = c.last_id;
    const current = db.get('SELECT last_id FROM reads WHERE user_id = ? AND channel_id = ?', user.id, c.id)?.last_id || '';
    if (last > current) {
      db.run('INSERT OR REPLACE INTO reads (user_id, channel_id, last_id) VALUES (?, ?, ?)', user.id, c.id, last);
      hub.emit([user.id], 'read', { channel: c.id, id: last });
    }
    send(res, 204);
  }

  // POST /api/channels/:id/typing
  function typing(req, res, { id }) {
    const user = people().requireUser(req);
    const c = channelFor(user, id, { write: true });
    if (typingLimit.hit(`${user.id}:${c.id}`)) hub.emit(audience(c).filter(p => p !== user.id), 'typing', { channel: c.id, person: user.id });
    send(res, 204);
  }

  // PUT /api/channels/:id/notify { level: all | mentions | none }
  async function setNotify(req, res, { id }) {
    const user = people().requireUser(req);
    const c = channelFor(user, id);
    const body = await readJson(req);
    if (!['all', 'mentions', 'none'].includes(body.level)) throw httpError(400, 'level must be all, mentions or none');
    db.run('INSERT OR REPLACE INTO notify (user_id, channel_id, level) VALUES (?, ?, ?)', user.id, c.id, body.level);
    hub.emit([user.id], 'notify', { channel: c.id, level: body.level });
    send(res, 204);
  }

  // GET /api/search?q=&channel=: messages with all those words (the last one may be the start of a word).
  function search(req, res, _p, url) {
    const user = people().requireUser(req);
    const words = String(url.searchParams.get('q') || '').toWellFormed().split(/\s+/).map(w => w.replace(/"/g, '')).filter(Boolean).slice(0, 8);
    if (!words.length) return send(res, 200, { messages: [] });
    const match = words.map((w, i) => `"${w}"${i === words.length - 1 ? '*' : ''}`).join(' ');
    const only = url.searchParams.get('channel');
    const ids = only ? [channelFor(user, only).id] : visibleChannels(user).map(c => c.id);
    if (!ids.length) return send(res, 200, { messages: [] });
    let rows;
    try {
      rows = db.all(`SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
        WHERE messages_fts MATCH ? AND m.deleted_at IS NULL AND m.kind = 'user' AND m.channel_id IN (${placeholders(ids.length)})
        ORDER BY m.id DESC LIMIT 50`, match, ...ids);
    } catch {
      throw httpError(400, 'Try other words');
    }
    send(res, 200, { messages: messagesJson(rows) });
  }

  return {
    createDefaultSpace, mainSpace, spaceName, addToSpace, announceJoin, visibleChannels, channelFor, audience, messagesJson, cleanBody,
    routes: [
      ['GET', '/api/bootstrap', bootstrap],
      ['GET', '/api/events', events],
      ['PUT', '/api/focus', focus],
      ['POST', '/api/spaces/:id/channels', createChannel],
      ['PATCH', '/api/spaces/:id', updateSpace],
      ['PATCH', '/api/channels/:id', updateChannel],
      ['POST', '/api/dms', openDm],
      ['DELETE', '/api/channels/:id/members/me', leaveGroup],
      ['GET', '/api/channels/:id/messages', listMessages],
      ['POST', '/api/channels/:id/messages', postMessage],
      ['GET', '/api/channels/:id/pins', pins],
      ['POST', '/api/channels/:id/read', markRead],
      ['POST', '/api/channels/:id/typing', typing],
      ['PUT', '/api/channels/:id/notify', setNotify],
      ['PATCH', '/api/messages/:id', editMessage],
      ['DELETE', '/api/messages/:id', deleteMessage],
      ['PUT', '/api/messages/:id/reactions/:emoji', react],
      ['DELETE', '/api/messages/:id/reactions/:emoji', react],
      ['PUT', '/api/messages/:id/pin', pin],
      ['DELETE', '/api/messages/:id/pin', pin],
      ['GET', '/api/search', search],
    ],
  };
}

module.exports = { createChat, cleanBody, cleanEmoji, MAX_BODY };
