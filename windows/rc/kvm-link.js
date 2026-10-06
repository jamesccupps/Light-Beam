// Beam's keyboard-and-mouse links (Beam 1.12), embedded in Beam.exe. KvmController runs this page in a WebView2 window
// nobody sees, as https://beam-kvm/kvm-link.html: the viewer's end of a kvm session with each PC beside this one, a
// remote control session with no picture (three data channels: ctl, in, mv). For each PC it answers the PC's offer,
// gives ICE the PC's candidates only as its attested Tailscale addresses (the strict rewrite), says which address the
// connection went to (Beam checks it before anything is sent), then sends Beam's input on. It pings each PC twice a
// second, so a link that goes quiet is noticed at once (Beam then gives this PC its keyboard and mouse back). It can't
// reach the network itself (its CSP has no connect-src; ICE only) and keeps nothing.
'use strict';
(function () {
  const post = m => window.chrome.webview.postMessage(m);
  const log = m => post({ t: 'log', m: String(m).slice(0, 200) });
  window.addEventListener('error', e => log('error: ' + e.message));
  window.addEventListener('unhandledrejection', e => log('rejection: ' + (e.reason && (e.reason.name || e.reason))));

  const PING_MS = 500;        // this page's pings to each PC's page (answered there at once)
  const QUIET_MS = 1500;      // no answer for this long: Beam hears `quiet`
  const RESOLVE_MS = 5000;    // a peer-reflexive remote reads "" until the PC's own candidate replaces it: this long at most
  const MV_BUFFERED = 16384;  // a move waits while the `mv` channel has this much queued (the next one is newer anyway)
  const CLIP_BUFFERED = 1 << 20; // (1.12.4) a picture's parts go on `clip` as it drains: at most this much waiting in it
  const links = new Map();    // link id -> its state

  // ------------------------------------------------------------------ addresses (as rc-host.js and remote.js)

  const isTailscale = a => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a) || /^fd7a:115c:a1e0:/i.test(a);
  const family = a => (/^\d{1,3}(\.\d{1,3}){3}$/.test(a) ? 4 : a.includes(':') ? 6 : 0);

  // The strict rewrite: every UDP host candidate of the PC's becomes its attested Tailscale address with the same port;
  // a Tailscale candidate stays only if it is one of them; everything else is dropped.
  function rewrite(l, c) {
    if (!c || typeof c.candidate !== 'string') return [];
    const base = { sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid : null, sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null };
    if (typeof c.usernameFragment === 'string') base.usernameFragment = c.usernameFragment;
    if (c.candidate === '') return [Object.assign({ candidate: '' }, base)]; // the end of candidates
    if (c.candidate.length > 1024) return [];
    const p = c.candidate.replace(/^a=/, '').trim().split(/\s+/);
    if (p.length < 8 || !/^candidate:/.test(p[0]) || p[6] !== 'typ' || p[2].toLowerCase() !== 'udp') return [];
    const port = Number(p[5]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
    const peers = [l.peer.ip4, l.peer.ip6].filter(ip => typeof ip === 'string' && isTailscale(ip));
    if (isTailscale(p[4])) return peers.includes(p[4]) ? [Object.assign({ candidate: p.join(' ') }, base)] : [];
    if (p[7] !== 'host') return [];
    const fam = family(p[4]);
    return peers.filter(ip => !fam || family(ip) === fam).map(ip => { const q = p.slice(); q[4] = ip; return Object.assign({ candidate: q.join(' ') }, base); });
  }

  // The offer's own a=candidate lines come out (they go through the rewrite instead), and a=end-of-candidates too.
  function strip(sdp) {
    const lines = sdp.split(/\r\n|\n/);
    const mids = [];
    let m = -1;
    for (const line of lines) {
      if (line.startsWith('m=')) mids[++m] = null;
      else if (line.startsWith('a=mid:') && m >= 0) mids[m] = line.slice(6).trim();
    }
    const out = [], candidates = [];
    m = -1;
    for (const line of lines) {
      if (line.startsWith('m=')) m++;
      if (line.startsWith('a=candidate:')) { candidates.push({ candidate: line.slice(2), sdpMid: mids[m] === undefined ? null : mids[m], sdpMLineIndex: Math.max(0, m) }); continue; }
      if (line.startsWith('a=end-of-candidates')) continue;
      out.push(line);
    }
    return { sdp: out.join('\r\n'), candidates };
  }

  function isIp(a) {
    const s = a.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s !== '0.0.0.0';
    return s.includes(':') && /^[0-9a-f:.]+$/i.test(s) && /[1-9a-f]/i.test(s);
  }

  // ------------------------------------------------------------------ a link

  function open(id, peer) {
    close(id);
    const l = { id, peer: peer || {}, pc: null, ch: null, origin: '', pending: [], out: [], outTimer: 0, verified: false, hello: null,
      pingN: 0, pingTimer: 0, lastPong: 0, quiet: false, reporting: false, again: false, lastSel: null, statsTimer: 0, clipOut: [] };
    links.set(id, l);
    return l;
  }

  function fresh(l) {
    shut(l);
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    l.pc = pc;
    l.ch = {
      ctl: pc.createDataChannel('ctl', { negotiated: true, id: 0, ordered: true }),
      in: pc.createDataChannel('in', { negotiated: true, id: 1, ordered: true }),
      mv: pc.createDataChannel('mv', { negotiated: true, id: 2, ordered: false, maxRetransmits: 0 }),
      clip: pc.createDataChannel('clip', { negotiated: true, id: 3, ordered: true }), // (1.12.4: pictures; a PC before it never opens it)
    };
    const mine = () => l.pc === pc;
    l.ch.clip.bufferedAmountLowThreshold = 256 * 1024;
    l.ch.clip.onbufferedamountlow = l.ch.clip.onopen = () => { if (mine()) drainClip(l); };
    l.ch.clip.onmessage = e => { if (mine() && l.verified && typeof e.data === 'string' && e.data.length <= 80000) post({ t: 'clip', link: l.id, d: e.data }); };
    l.ch.ctl.onopen = () => { if (mine() && l.verified) sendHello(l); };
    l.ch.ctl.onmessage = e => { if (mine()) onCtl(l, e.data); };
    l.ch.ctl.onclose = () => { if (mine() && links.get(l.id) === l) post({ t: 'state', link: l.id, pc: 'closed' }); };
    pc.onicecandidate = e => { if (mine()) queueCandidate(l, e.candidate ? e.candidate.toJSON() : { candidate: '', sdpMid: null, sdpMLineIndex: null }); };
    pc.onconnectionstatechange = () => { if (mine()) onState(l); };
    l.pending = [];
    l.statsTimer = setInterval(() => { if (mine() && pc.connectionState === 'connected') reportSelected(l); }, 2000);
  }

  // Lets go of the connection (another one replaces it, or the link closes).
  function shut(l) {
    clearInterval(l.pingTimer);
    clearInterval(l.statsTimer);
    clearTimeout(l.outTimer);
    l.pingTimer = l.statsTimer = l.outTimer = 0;
    if (l.ch) for (const c of Object.values(l.ch)) { c.onopen = c.onmessage = c.onclose = null; try { c.close(); } catch (e) { } }
    if (l.pc) { l.pc.onicecandidate = l.pc.onconnectionstatechange = null; try { l.pc.close(); } catch (e) { } }
    l.pc = l.ch = null;
    l.clipOut = [];
    l.verified = false;
    l.lastSel = null;
    l.lastPong = 0;
    l.quiet = false;
  }

  function close(id) {
    const l = links.get(id);
    if (!l) return;
    links.delete(id);
    shut(l);
  }

  // The PC's offer: a new o= session id is a new connection (both checks start over); the same one a renegotiation (an
  // ICE restart) on this one.
  async function onOffer(l, sdp) {
    if (typeof sdp !== 'string' || sdp.length > 64 * 1024) return;
    const origin = (/^o=\S+ (\S+) /m.exec(sdp) || [])[1] || '';
    if (!l.pc || origin !== l.origin) { fresh(l); l.origin = origin; }
    const pc = l.pc;
    const { sdp: clean, candidates } = strip(sdp);
    await pc.setRemoteDescription({ type: 'offer', sdp: clean });
    if (l.pc !== pc) return;
    for (const c of [...candidates, ...l.pending.splice(0)]) addRemote(l, c);
    const answer = await pc.createAnswer();
    if (l.pc !== pc) return;
    await pc.setLocalDescription(answer);
    if (l.pc !== pc) return;
    post({ t: 'answer', link: l.id, sdp: pc.localDescription.sdp });
  }

  function addRemote(l, c) {
    for (const r of rewrite(l, c)) l.pc.addIceCandidate(r).catch(() => {}); // (one of an older ICE generation, or a family this side lacks)
  }

  function onCandidates(l, list) {
    for (const c of Array.isArray(list) ? list.slice(0, 50) : []) {
      if (l.pc && l.pc.remoteDescription) addRemote(l, c);
      else if (l.pending.length < 100) l.pending.push(c);
    }
  }

  // Our own candidates, a few at a time (the PC does its own rewrite): at most 20 a signal.
  function queueCandidate(l, c) {
    if (typeof c.candidate !== 'string' || c.candidate.length > 256) return;
    l.out.push({ candidate: c.candidate, sdpMid: c.sdpMid === undefined ? null : c.sdpMid, sdpMLineIndex: c.sdpMLineIndex === undefined ? null : c.sdpMLineIndex,
      ...(c.usernameFragment != null && { usernameFragment: c.usernameFragment }) });
    if (l.out.length >= 20) flushCandidates(l);
    else if (!l.outTimer) l.outTimer = setTimeout(() => flushCandidates(l), 40);
  }

  function flushCandidates(l) {
    clearTimeout(l.outTimer);
    l.outTimer = 0;
    while (l.out.length) post({ t: 'cands', link: l.id, candidates: l.out.splice(0, 20) });
  }

  function onState(l) {
    const pc = l.pc;
    const st = pc.connectionState;
    if (st === 'connected') { l.lastSel = null; reportSelected(l); } // (back after a drop: said again, even on the same path)
    else if (st === 'failed' || st === 'closed' || st === 'disconnected') post({ t: 'state', link: l.id, pc: st });
  }

  async function selected(pc) {
    const s = await pc.getStats();
    let pair = null;
    s.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = s.get(r.selectedCandidatePairId); });
    if (!pair) s.forEach(r => { if (!pair && r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    const rc = pair && s.get(pair.remoteCandidateId);
    const ip = rc ? String(rc.address || rc.ip || '') : '';
    return rc ? { ip: isIp(ip) ? ip : '', port: rc.port || 0, type: rc.candidateType || '' } : null;
  }

  // The remote end of the selected pair: Beam checks it before anything goes, and again whenever it changes. A
  // peer-reflexive remote reads "" until the PC's candidate (rewritten to its attested address) replaces it: up to 5 s.
  async function reportSelected(l) {
    const pc = l.pc;
    if (!pc) return;
    if (l.reporting) { l.again = true; return; }
    l.reporting = true;
    try {
      let sel = await selected(pc);
      for (let i = 0; i < RESOLVE_MS / 200 && l.pc === pc && sel && !sel.ip; i++) { await new Promise(r => setTimeout(r, 200)); sel = await selected(pc); }
      if (l.pc !== pc) return;
      const key = sel ? sel.ip + ' ' + sel.port : '';
      if (key === l.lastSel) return;
      l.lastSel = key;
      post({ t: 'state', link: l.id, pc: pc.connectionState, remoteIp: sel ? sel.ip : '', type: sel ? sel.type : '' });
    } catch (e) { log('selected pair: ' + (e && e.name)); } finally {
      l.reporting = false;
      if (l.again) { l.again = false; reportSelected(l); }
    }
  }

  // ------------------------------------------------------------------ after Beam's check

  function onVerified(l, hello) {
    if (!l.pc) return;
    l.verified = true;
    l.hello = hello && typeof hello === 'object' ? hello : null;
    if (l.ch && l.ch.ctl.readyState === 'open') sendHello(l);
    clearInterval(l.pingTimer);
    l.pingTimer = setInterval(() => ping(l), PING_MS);
  }

  function sendHello(l) {
    if (l.hello) send(l, 'ctl', l.hello);
  }

  function send(l, name, m) {
    if (!l.verified || !l.ch) return false;
    const c = l.ch[name];
    if (!c || c.readyState !== 'open') return false;
    if (name === 'mv' && c.bufferedAmount > MV_BUFFERED) return false;
    try { c.send(JSON.stringify(m)); return true; } catch (e) { return false; }
  }

  function drainClip(l) {
    const c = l.ch && l.ch.clip;
    if (!l.verified || !c || c.readyState !== 'open') { if (!c || c.readyState === 'closed') l.clipOut = []; return; }
    while (l.clipOut.length && c.bufferedAmount < CLIP_BUFFERED) {
      try { c.send(l.clipOut.shift()); } catch (e) { l.clipOut = []; return; }
    }
  }

  // Twice a second; the PC's page answers at once. Quiet (no answer for 1.5 s, once one has come) and back again are
  // told to Beam once each.
  function ping(l) {
    if (!l.verified) return;
    send(l, 'ctl', { t: 'ping', n: ++l.pingN, at: Date.now() });
    if (l.lastPong && !l.quiet && Date.now() - l.lastPong > QUIET_MS) { l.quiet = true; post({ t: 'quiet', link: l.id }); }
  }

  function onCtl(l, data) {
    if (typeof data !== 'string' || data.length > 100000 || !l.verified) return;
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'pong') {
      l.lastPong = Date.now();
      if (l.quiet) { l.quiet = false; post({ t: 'alive', link: l.id }); }
      return;
    }
    if (m.t === 'ping') send(l, 'ctl', { t: 'pong', n: m.n, at: m.at }); // (the PC's own: its Beam lets go of keys without them)
    post({ t: 'ctl', link: l.id, d: data });
  }

  // ------------------------------------------------------------------ from Beam

  window.chrome.webview.addEventListener('message', e => {
    const m = e.data;
    if (!m || typeof m !== 'object' || typeof m.link !== 'string') return;
    if (m.t === 'open') { open(m.link, m.peer); return; }
    const l = links.get(m.link);
    if (!l) return;
    switch (m.t) {
      case 'signal':
        if (m.kind === 'offer') onOffer(l, m.sdp).catch(err => { log('offer: ' + (err && err.name)); post({ t: 'state', link: l.id, pc: 'failed' }); });
        else if (m.kind === 'candidates') onCandidates(l, m.candidates);
        break;
      case 'verified': onVerified(l, m.hello); break;
      case 'send': if (m.m && typeof m.m === 'object' && (m.ch === 'in' || m.ch === 'mv' || m.ch === 'ctl')) send(l, m.ch, m.m); break;
      case 'clipout': if (l.verified && typeof m.d === 'string' && m.d.length <= 80000) { l.clipOut.push(m.d); drainClip(l); } break; // (a picture's part, as text)
      case 'close': close(m.link); break;
    }
  });

  post({ t: 'ready' });
})();
