'use strict';
// Live updates over server-sent events. Each event goes to a list of people (or everyone); the last 2,000 are kept,
// so a client that reconnects (Last-Event-ID "<boot>-<seq>") gets what it missed. If that's gone, or the server
// restarted, it gets `resync` and reloads. Also: who's online, and which channel each open app is looking at (so a
// message there needn't be pushed to that person's phone).

const crypto = require('node:crypto');
const { BASE_HEADERS } = require('./http');

const KEEP = 2000;
const HEARTBEAT_MS = 25_000;
const MAX_QUEUED = 1024 * 1024; // a stream that doesn't read this much of what it was sent is dropped (it reconnects)
const MAX_PER_PERSON = 20;      // open streams per person; a new one ends their oldest

function createHub({ version = '', onPresence = () => {}, onDrop = () => {} } = {}) {
  const boot = crypto.randomBytes(4).toString('hex');
  let seq = 0;
  const recent = []; // { seq, to: Set|null, type, frame }
  const clients = new Map(); // id -> { id, user, session, res, focus, visible }
  const byUser = new Map(); // user id -> Set of client ids

  // (1.7.2) The event is written out once for everyone; a stream that stopped reading is dropped rather than buffered
  // without end (a stalled phone on the public link must not grow the server's memory).
  function write(client, event) {
    if (!client) return;
    try {
      if (client.res.writableLength > MAX_QUEUED) {
        onDrop(client.user);
        client.res.destroy();
        return;
      }
      client.res.write(event.frame);
    } catch {}
  }

  // `to`: an array of person ids, or null for everyone.
  function emit(to, type, data) {
    const event = { seq: ++seq, to: to ? new Set(to) : null, type };
    event.frame = `id: ${boot}-${event.seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    recent.push(event);
    if (recent.length > KEEP) recent.shift();
    if (to) {
      for (const user of event.to) for (const id of byUser.get(user) || []) write(clients.get(id), event);
    } else {
      for (const client of clients.values()) write(client, event);
    }
  }

  // session: the sign-in's session hash (null when signed in by Tailscale), so ending it ends this stream too.
  function connect(req, res, user, session = null) {
    const id = crypto.randomBytes(9).toString('base64url');
    // (1.7.2) at most MAX_PER_PERSON streams each: a new one ends that person's oldest
    const open = byUser.get(user.id);
    if (open && open.size >= MAX_PER_PERSON) { try { clients.get(open.values().next().value)?.res.end(); } catch {} }
    res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.socket?.setNoDelay?.(true);
    res.socket?.setKeepAlive?.(true, 30_000);
    const client = { id, user: user.id, session, res, focus: null, visible: false };
    clients.set(id, client);
    let mine = byUser.get(user.id);
    const wasOnline = Boolean(mine?.size);
    if (!mine) byUser.set(user.id, (mine = new Set()));
    mine.add(id);
    res.write(`retry: 3000\n\n`);
    // What was missed while away, if it's all still here.
    const last = /^([0-9a-f]{8})-(\d+)$/.exec(String(req.headers['last-event-id'] || ''));
    if (last) {
      const from = Number(last[2]);
      const complete = last[1] === boot && from <= seq && (recent.length ? recent[0].seq <= from + 1 : from === seq);
      if (!complete) {
        res.write(`event: resync\ndata: {}\n\n`);
      } else {
        for (const event of recent) if (event.seq > from && (!event.to || event.to.has(user.id))) write(client, event);
      }
    }
    // (1.8.5) with the version: a page that loaded another reloads itself once it's idle
    res.write(`event: hello\ndata: ${JSON.stringify({ client: id, boot, version })}\n\n`);
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, HEARTBEAT_MS);
    const done = () => {
      clearInterval(beat);
      if (!clients.delete(id)) return;
      mine.delete(id);
      if (!mine.size) {
        byUser.delete(user.id);
        onPresence(user.id, false);
      }
    };
    req.on('close', done);
    res.on('close', done);
    res.on('error', done);
    if (!wasOnline) onPresence(user.id, true);
    return id;
  }

  // The channel an open app shows, and whether its window is in front.
  function setFocus(clientId, userId, channel, visible) {
    const client = clients.get(clientId);
    if (!client || client.user !== userId) return false;
    client.focus = channel || null;
    client.visible = Boolean(visible);
    return true;
  }

  // True if one of this person's open apps shows this channel in front right now.
  const watching = (userId, channel) => [...(byUser.get(userId) || [])].some(id => {
    const c = clients.get(id);
    return c && c.visible && c.focus === channel;
  });

  const isOnline = userId => Boolean(byUser.get(userId)?.size);
  const onlineIds = () => [...byUser.keys()];

  // A person signed out everywhere or removed: their open streams end now.
  function disconnectUser(userId) {
    for (const id of [...(byUser.get(userId) || [])]) {
      try { clients.get(id)?.res.end(); } catch {}
    }
  }

  // Sign-ins ended (signed out, "other browsers", a new password, a reset link): the streams they opened end now too
  // (1.7.2: they went on receiving everything until they disconnected by themselves).
  function disconnectSessions(hashes) {
    const ended = new Set(hashes);
    for (const client of [...clients.values()]) {
      if (client.session && ended.has(client.session)) { try { client.res.end(); } catch {} }
    }
  }

  function closeAll() {
    for (const client of clients.values()) { try { client.res.end(); } catch {} }
  }

  return { emit, connect, setFocus, watching, isOnline, onlineIds, disconnectUser, disconnectSessions, closeAll, boot, count: () => clients.size };
}

module.exports = { createHub };
