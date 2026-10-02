'use strict';
// Live updates over server-sent events. Each event goes to a list of people (or everyone); the last 2,000 are kept,
// so a client that reconnects (Last-Event-ID "<boot>-<seq>") gets what it missed. If that's gone, or the server
// restarted, it gets `resync` and reloads. Also: who's online, and which channel each open app is looking at (so a
// message there needn't be pushed to that person's phone).

const crypto = require('node:crypto');
const { BASE_HEADERS } = require('./http');

const KEEP = 2000;
const HEARTBEAT_MS = 25_000;

function createHub({ onPresence = () => {} } = {}) {
  const boot = crypto.randomBytes(4).toString('hex');
  let seq = 0;
  const recent = []; // { seq, to: Set|null, type, data }
  const clients = new Map(); // id -> { id, user, res, focus, visible }
  const byUser = new Map(); // user id -> Set of client ids

  function write(client, event) {
    try {
      client.res.write(`id: ${boot}-${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    } catch {}
  }

  // `to`: an array of person ids, or null for everyone.
  function emit(to, type, data) {
    const event = { seq: ++seq, to: to ? new Set(to) : null, type, data };
    recent.push(event);
    if (recent.length > KEEP) recent.shift();
    if (to) {
      for (const user of event.to) for (const id of byUser.get(user) || []) write(clients.get(id), event);
    } else {
      for (const client of clients.values()) write(client, event);
    }
  }

  function connect(req, res, user) {
    const id = crypto.randomBytes(9).toString('base64url');
    res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.socket?.setNoDelay?.(true);
    res.socket?.setKeepAlive?.(true, 30_000);
    const client = { id, user: user.id, res, focus: null, visible: false };
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
    res.write(`event: hello\ndata: ${JSON.stringify({ client: id, boot })}\n\n`);
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

  function closeAll() {
    for (const client of clients.values()) { try { client.res.end(); } catch {} }
  }

  return { emit, connect, setFocus, watching, isOnline, onlineIds, disconnectUser, closeAll, boot, count: () => clients.size };
}

module.exports = { createHub };
