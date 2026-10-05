'use strict';
// Direct connections (1.9.0; the user: "we need a temporary fastlink too, that works on any network [...] there shold be
// a way if needed to speeed up device connections if they see that they are on the same network"): WebRTC data
// channels between a browser and this server, so files go straight between them instead of through Tailscale's relay
// (on the same network they stay inside it). node-datachannel (libdatachannel) is this end; browsers have their own.
// Signalling is one request: the browser's offer (its candidates in it) in, the answer (ours in it) out. Public STUN
// servers find the way (they see the two addresses, never a file). Where no direct path can be made, or without
// node-datachannel (or with BEAM_FAMILY_STUN=off), the app uses https as before.
//
// Over a connection each transfer is a data channel of its own, its label saying what for:
//   {"op":"get","file":"<id>","offset":N}    the file from N on in binary messages, then {"done":true,"size":S}; a file
//                                            still being uploaded is followed as it arrives
//   {"op":"put","upload":"<id>","offset":N}  binary messages from N on; {"offset":M} each time 2 MB are kept, then
//                                            {"done":true} (an offset that isn't the server's: {"offset":M} and closed)
// Something wrong: {"error":"…"} and the channel closes. A connection belongs to whoever made it: a person, or a fast
// link's visitor (only that link's file, only to read).

const { httpError, readJson, send } = require('./http');

let ndc = null;
try { ndc = require('node-datachannel'); } catch {}

const CHUNK = 64 * 1024;
const HIGH = 4 * 1024 * 1024;          // bytes waiting to go before a download waits
const LOW = 1024 * 1024;               // …and goes on again below this
const GATHER_MS = 2500;                // how long the answer waits for this end's addresses
const OPEN_MS = 20_000;                // a connection that doesn't come up by then goes
const IDLE_MS = 2 * 60e3;              // nor one doing nothing
const FOLLOW_MS = 60e3;                // a download following an upload that stopped gives up after this
const MAX_PEERS = 32;
const MAX_PER_WHO = 4;
const MAX_CHANNELS = 8;
const MAX_QUEUED = 64 * 1024 * 1024;   // an upload's bytes waiting for the disk
const LOGGED = 8 * 1024 * 1024;        // transfers from this size on get a line in the log (how fast they went)
const TAILNET = /^(100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|fd7a:115c:a1e0:)/i;

// "1.9 GB in 6 min 40 s (5.1 MB/s, round trip 12 ms)": how a direct transfer went, for the log (1.9.1). The speed
// depends on the other end: headless Chrome/Edge on this PC stopped at ~6–7 MB/s whatever this end did (any number of
// connections), a phone on Wi-Fi got ~5 MB/s, a visitor over the internet 21.7 MB/s.
function howItWent(bytes, since, pc) {
  const s = Math.max((Date.now() - since) / 1000, 0.001);
  const size = bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
  const time = s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  let rtt = null;
  try { rtt = pc.rtt(); } catch {}
  return `${size} in ${time} (${(bytes / 1024 ** 2 / s).toFixed(1)} MB/s${rtt > 0 ? `, round trip ${Math.round(rtt)} ms` : ''})`;
}

// How a connection's chosen pair of addresses goes: on the same network, over Tailscale, or over the internet.
function pathOf(pc) {
  let remote = '';
  try { remote = String(pc.getSelectedCandidatePair()?.remote?.address || ''); } catch {}
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1$|f[cd]|fe80:)/i.test(remote)) return 'on the same network';
  if (TAILNET.test(remote)) return 'over Tailscale';
  return remote ? 'over the internet' : '';
}

function createDirect(ctx) {
  const { db, log, config } = ctx;
  const people = () => ctx.people;
  const enabled = Boolean(ndc) && config.stun !== null;
  // Every connection and channel in use stays referenced here: node-datachannel closes one that's garbage-collected.
  const peers = new Set();
  if (!ndc) log.info('Direct connections are off: node-datachannel isn’t installed (files go over https)');

  function closePeer(peer) {
    if (peer.closed) return;
    peer.closed = true;
    peers.delete(peer);
    clearTimeout(peer.openTimer);
    clearInterval(peer.idleTimer);
    for (const dc of peer.channels) { try { dc.close(); } catch {} }
    peer.channels.clear();
    try { peer.pc.close(); } catch {}
  }

  // The answer to a browser's offer (with this end's candidates): a connection bound to `who` (a person's id, or
  // "link:<token>") with what it may do.
  async function answer(offer, who, { user = null, link = null } = {}) {
    if (!enabled) throw httpError(503, 'Direct connections are off here');
    if (typeof offer !== 'string' || offer.length > 64 * 1024 || !/^v=0/.test(offer) || !/m=application/.test(offer)) throw httpError(400, 'Not an offer');
    // Room: this one's oldest go first, and nobody may have more than a few.
    const mine = [...peers].filter(p => p.who === who).sort((a, b) => a.created - b.created);
    while (mine.length >= MAX_PER_WHO) closePeer(mine.shift());
    if (peers.size >= MAX_PEERS) throw httpError(503, 'Too many direct connections right now');

    // (UDP ports from config.directPorts only: the one firewall rule on this PC covers just those)
    const pc = new ndc.PeerConnection('family', {
      iceServers: config.stun || [], maxMessageSize: 256 * 1024,
      ...(config.directPorts && { portRangeBegin: config.directPorts[0], portRangeEnd: config.directPorts[1] }),
    });
    const peer = { pc, who, user, link, channels: new Set(), created: Date.now(), last: Date.now(), closed: false, up: false };
    peers.add(peer);
    // (which way it went, for the log: never the addresses)
    const whose = user ? user.name : 'a fast link’s visitor';
    pc.onStateChange(state => {
      if (state === 'connected' && !peer.up) {
        peer.up = true;
        clearTimeout(peer.openTimer);
        log.info(`A direct connection for ${whose} came up ${pathOf(pc)}`);
      }
      if (state === 'failed' && !peer.up) log.info(`A direct connection for ${whose} didn’t come up (https it is)`);
      if (state === 'failed' || state === 'closed' || state === 'disconnected') closePeer(peer);
    });
    pc.onDataChannel(dc => onChannel(peer, dc));
    peer.openTimer = setTimeout(() => {
      if (peer.up) return;
      log.info(`A direct connection for ${whose} didn’t come up in ${OPEN_MS / 1000} s (https it is)`);
      closePeer(peer);
    }, OPEN_MS);
    peer.idleTimer = setInterval(() => { if (!peer.channels.size && Date.now() - peer.last > IDLE_MS) closePeer(peer); }, 30e3);
    peer.idleTimer.unref?.();
    const gathered = new Promise(resolve => {
      pc.onGatheringStateChange(state => { if (state === 'complete') resolve(); });
      setTimeout(resolve, GATHER_MS);
    });
    try {
      pc.setRemoteDescription(offer, 'offer');
    } catch (err) {
      closePeer(peer);
      throw httpError(400, `That offer didn’t work: ${err.message}`);
    }
    await gathered;
    let sdp = pc.localDescription()?.sdp || '';
    // A fast link's visitor has no use for this machine's Tailscale addresses.
    if (link) sdp = sdp.split(/\r?\n/).filter(l => !/^a=candidate:/.test(l) || !TAILNET.test(l.split(' ')[4] || '')).join('\r\n');
    if (!/^a=candidate:/m.test(sdp)) log.warn('A direct connection’s answer has no addresses of this machine in it');
    return sdp;
  }

  function fail(dc, message) {
    try { dc.sendMessage(JSON.stringify({ error: message })); } catch {}
    setTimeout(() => { try { dc.close(); } catch {} }, 200);
  }

  function onChannel(peer, dc) {
    peer.channels.add(dc);
    peer.last = Date.now();
    dc.onClosed(() => { peer.channels.delete(dc); peer.last = Date.now(); });
    let req = null;
    try { req = JSON.parse(dc.getLabel()); } catch {}
    if (dc.getLabel() === 'beam') return; // (the one the connection was opened with: kept, says nothing)
    if (!req || typeof req !== 'object' || peer.channels.size > MAX_CHANNELS) return fail(dc, 'Not a request');
    const start = () => {
      const work = req.op === 'get' ? sendFile(peer, dc, req) : req.op === 'put' && peer.user ? receiveFile(peer, dc, req) : Promise.reject(httpError(400, 'Not a request'));
      work.catch(err => {
        if (!err.status) log.warn(`A direct ${req.op === 'put' ? 'upload' : 'download'} failed: ${err.message}`);
        fail(dc, err.status ? err.message : 'Something went wrong on the server');
      });
    };
    if (dc.isOpen()) start(); else dc.onOpen(start);
  }

  // A file to the other end (one the person may see, or the link's), from `offset` on.
  async function sendFile(peer, dc, req) {
    const a = peer.link ? ctx.links.attachmentOf(peer.link, req.file) : ctx.files.visibleAttachment(peer.user, String(req.file || ''));
    let pos = Math.max(0, Math.floor(Number(req.offset) || 0));
    // (1.15.0) a link with no downloads left starts none. (1.15.1) A new one counts as it starts, as over https; it
    // counted once sent whole from byte 0, so one picked up again after a drop (from where it got to) never counted.
    if (peer.link && !pos) {
      ctx.links.mayStart(peer.link);
      ctx.links.counted(peer.link);
    }
    if (pos > a.size) throw httpError(416, 'That’s past the end of the file');
    let drained = null;
    dc.setBufferedAmountLowThreshold(LOW);
    dc.onBufferedAmountLow(() => { const d = drained; drained = null; d?.(); });
    const gone = () => !dc.isOpen() || peer.closed;
    const started = Date.now();
    let sent = 0;
    // (a file still on its way here is followed as it arrives)
    for await (const piece of ctx.files.readFollowing(a, pos, { chunk: CHUNK, followMs: FOLLOW_MS, isClosed: gone })) {
      if (gone()) break;
      dc.sendMessageBinary(piece);
      sent += piece.length;
      peer.last = Date.now();
      // (and looked at again each second: a channel that closes meanwhile says nothing)
      while (dc.bufferedAmount() > HIGH && !gone()) await new Promise(r => { drained = r; setTimeout(r, 1000); });
    }
    const who = peer.link ? 'A fast link’s visitor' : peer.user.name;
    if (gone()) {
      if (sent >= LOGGED) log.info(`${who} stopped a direct download of ${a.name} after ${howItWent(sent, started, peer.pc)}`);
      return;
    }
    dc.sendMessage(JSON.stringify({ done: true, size: a.size })); // (the other end closes the channel once it has it all)
    if (sent >= LOGGED) log.info(`${who} downloaded ${a.name} directly ${pathOf(peer.pc)}: ${howItWent(sent, started, peer.pc)}`);
  }

  // An upload of the person's from the other end, from `offset` on (the same writer as https pieces).
  async function receiveFile(peer, dc, req) {
    const id = String(req.upload || '');
    const a = db.get('SELECT * FROM attachments WHERE id = ? AND uploader_id = ? AND message_id IS NULL', id, peer.user.id);
    if (!a) throw httpError(404, 'No such upload');
    if (Number(req.offset) !== a.received || ctx.files.isWriting(id)) {
      dc.sendMessage(JSON.stringify({ offset: a.received }));
      setTimeout(() => { try { dc.close(); } catch {} }, 200);
      return;
    }
    const want = a.size - a.received;
    const queue = [];
    let queued = 0;
    let got = 0;
    let ended = false;
    let wake = null;
    const poke = () => { const w = wake; wake = null; w?.(); };
    dc.onMessage(msg => {
      if (typeof msg === 'string') return;
      queue.push(msg);
      queued += msg.length;
      if (queued > MAX_QUEUED) { ended = true; fail(dc, 'Too much at once'); }
      poke();
    });
    dc.onClosed(() => { peer.channels.delete(dc); ended = true; poke(); });
    // Ends once the whole rest of the file is here (a channel doesn't end by itself), or when the channel goes.
    const source = (async function* () {
      while (got < want) {
        if (queue.length) {
          const m = queue.shift();
          queued -= m.length;
          got += m.length;
          yield m;
          continue;
        }
        if (ended) return;
        await new Promise(r => { wake = r; });
      }
    })();
    const started = Date.now();
    const r = await ctx.files.receive(a, a.received, source, want, {
      onKept: kept => { peer.last = Date.now(); try { dc.sendMessage(JSON.stringify({ offset: kept })); } catch {} },
    });
    try { dc.sendMessage(JSON.stringify(r.done ? { done: true } : { offset: r.received })); } catch {}
    if (got >= LOGGED) log.info(`${peer.user.name} ${r.done ? 'sent' : 'sent part of'} ${a.name} directly ${pathOf(peer.pc)}: ${howItWent(got, started, peer.pc)}`);
  }

  // POST /api/direct { sdp } → { sdp }: a direct connection for the person signed in.
  async function connect(req, res) {
    const user = people().requireUser(req);
    const body = await readJson(req);
    send(res, 200, { sdp: await answer(body.sdp, user.id, { user }) });
  }

  return {
    enabled, answer,
    closeAll: () => { for (const p of [...peers]) closePeer(p); },
    // (a fast link switched off: its visitors' connections go too)
    closeLink: id => { for (const p of [...peers]) if (p.who === `link:${id}`) closePeer(p); },
    count: () => peers.size,
    routes: [['POST', '/api/direct', connect]],
  };
}

module.exports = { createDirect };
