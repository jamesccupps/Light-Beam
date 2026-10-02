// Beam's capture host page (Beam 1.6), embedded in Beam.exe. RcHost runs it in a WebView2 window nobody sees, as
// https://beam-remote-control/rc-host.html. It captures the screen (the browser picks it, with no picker), offers it
// to the viewer over WebRTC with three data channels (ctl, in, mv: research §8.7) and hands everything else to Beam,
// which decides: Beam checks the peer before anything flows (`verified`), injects the input, owns the clipboard and
// talks to the server. This page can't reach the network itself (its CSP has no connect-src; ICE only) and keeps
// nothing: no frames, no input.
'use strict';
(function () {
  const post = m => window.chrome.webview.postMessage(m);
  const log = m => post({ t: 'log', m: String(m).slice(0, 200) });
  window.addEventListener('error', e => log('error: ' + e.message));
  window.addEventListener('unhandledrejection', e => log('rejection: ' + (e.reason && (e.reason.name || e.reason))));

  // "Sharp text" and "Smooth motion" (plan/rd-spike-results.md).
  const QUALITY = { text: { fps: 30, kbps: 8000 }, motion: { fps: 60, kbps: 16000 } };
  let cfg = null, stream = null, track = null, pc = null, ch = null, tr = null;
  let verified = false, hello = null, mode = 'text', battery = false, h264First = false, cpuStrikes = 0;
  let pendingRemote = [], outCands = [], candTimer = 0, restartTimer = 0, statsTimer = 0, prev = null, lastSelected = null;
  let codecNow = null, encoderNow = null, ended = false, candidatesIn = 0, candidatesAdded = 0;

  // ------------------------------------------------------------------ addresses

  const isTailscale = a => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a) || /^fd7a:115c:a1e0:/i.test(a);
  function canon(ip) {
    if (typeof ip !== 'string' || !ip) return null;
    try { return new URL('http://' + (ip.includes(':') ? '[' + ip + ']' : ip) + '/').hostname.replace(/^\[|\]$/g, ''); } catch (e) { return null; }
  }
  const sameIp = (a, b) => { const x = canon(a); return !!x && x === canon(b); };

  // The strict rewrite (plan/rd.md, spike S2): only the viewer's addresses as the server attested them, same ports, UDP.
  // A host candidate that isn't on Tailscale (an mDNS .local name, a LAN address) becomes copies with those addresses;
  // a Tailscale candidate stays only if it is one of them; everything else is dropped.
  function rewrite(c) {
    if (!c || typeof c.candidate !== 'string' || !c.candidate) return [];
    const p = c.candidate.split(' ');
    if (p.length < 8 || (p[2] || '').toLowerCase() !== 'udp') return [];
    const addr = p[4], typ = p[7];
    const peers = [cfg.peer.ip4, cfg.peer.ip6].filter(Boolean);
    const base = { sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex };
    if (c.usernameFragment) base.usernameFragment = c.usernameFragment;
    if (isTailscale(addr)) return peers.some(ip => sameIp(ip, addr)) ? [Object.assign({ candidate: c.candidate }, base)] : [];
    if (typ !== 'host') return [];
    return peers.map(ip => { const q = p.slice(); q[4] = ip; return Object.assign({ candidate: q.join(' ') }, base); });
  }

  // ------------------------------------------------------------------ capture

  function constraints() {
    const q = QUALITY[mode];
    return { width: { max: 3840 }, height: { max: 2160 }, frameRate: { ideal: q.fps, max: q.fps } };
  }

  // Beam starts this through DevTools with a user gesture. A wrong source name hangs silently: 5 s at most.
  window.rcStart = async function (c) {
    if (cfg) return;
    cfg = c;
    mode = c.mode === 'motion' ? 'motion' : 'text';
    battery = !!c.battery;
    let late = false, timer = 0;
    const capture = navigator.mediaDevices.getDisplayMedia({ video: constraints(), audio: false });
    capture.then(s => { if (late) s.getTracks().forEach(t => t.stop()); }, () => {});
    try {
      const r = await Promise.race([capture, new Promise(res => { timer = setTimeout(() => res('timeout'), 5000); })]);
      clearTimeout(timer);
      if (r === 'timeout') { late = true; post({ t: 'ended', reason: 'capture-timeout' }); return; }
      stream = r;
    } catch (e) {
      clearTimeout(timer);
      post({ t: 'ended', reason: 'capture-' + (e && e.name || 'error') });
      return;
    }
    track = stream.getVideoTracks()[0];
    track.contentHint = 'text';
    track.onended = () => { if (!ended) post({ t: 'ended', reason: 'stopped-sharing' }); }; // Windows' "Stop sharing"
    const size = await frameSize(stream); // getSettings() reports the constraint's maximum, not the screen
    post({ t: 'captured', w: size.w, h: size.h });
    await connect();
  };

  function frameSize(s) {
    return new Promise(res => {
      const v = document.createElement('video');
      let done = false;
      const finish = () => { if (done) return; done = true; const r = { w: v.videoWidth, h: v.videoHeight }; v.srcObject = null; res(r); };
      v.muted = true;
      v.onloadedmetadata = () => { if (v.videoWidth) finish(); else v.onresize = finish; };
      setTimeout(finish, 2000);
      v.srcObject = s;
      v.play().catch(() => {});
    });
  }

  // Tests: a capture attempt with no session; Beam's gate must refuse it.
  window.rcProbe = async function () {
    let timer = 0;
    try {
      const capture = navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      capture.then(s => s.getTracks().forEach(t => t.stop()), () => {});
      const r = await Promise.race([capture, new Promise(res => { timer = setTimeout(() => res('timeout'), 5000); })]);
      clearTimeout(timer);
      post({ t: 'probe', result: r === 'timeout' ? 'no answer' : 'CAPTURED: the gate let it through' });
    } catch (e) {
      clearTimeout(timer);
      post({ t: 'probe', result: 'refused (' + (e && e.name) + ')' });
    }
  };

  // ------------------------------------------------------------------ the connection

  async function connect() {
    pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    ch = {
      ctl: pc.createDataChannel('ctl', { negotiated: true, id: 0, ordered: true }),
      in: pc.createDataChannel('in', { negotiated: true, id: 1, ordered: true }),
      mv: pc.createDataChannel('mv', { negotiated: true, id: 2, ordered: false, maxRetransmits: 0 }),
    };
    ch.ctl.onopen = () => { if (verified) sendHello(); };
    ch.ctl.onmessage = e => onCtl(e.data);
    ch.in.onmessage = e => { if (verified && typeof e.data === 'string' && e.data.length <= 16384) post({ t: 'in', d: e.data }); };
    ch.mv.onmessage = e => { if (verified && typeof e.data === 'string' && e.data.length <= 512) post({ t: 'mv', d: e.data }); };
    const q = QUALITY[mode];
    // No video until Beam has checked the peer: the encoding starts inactive.
    tr = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream], sendEncodings: [{ active: false, maxBitrate: q.kbps * 1000, maxFramerate: q.fps }] });
    applyCodecs();
    pc.onicecandidate = e => queueCandidate(e.candidate ? e.candidate.toJSON() : { candidate: '', sdpMid: null, sdpMLineIndex: null });
    pc.onconnectionstatechange = onState;
    try {
      const ice = tr.sender.transport && tr.sender.transport.iceTransport;
      if (ice) ice.onselectedcandidatepairchange = () => { if (pc && pc.connectionState === 'connected') reportSelected(); };
    } catch (e) { }
    await offer(false);
    statsTimer = setInterval(stats, 2000);
  }

  // AV1 first (the sharpest text), then H.264 High (hardware on NVIDIA), VP9, VP8; never H.264 Constrained Baseline
  // (software OpenH264 here). On battery, or when the CPU is the limit, H.264 High goes first.
  function applyCodecs() {
    let caps;
    try { caps = RTCRtpSender.getCapabilities('video').codecs; } catch (e) { return; }
    const type = c => c.mimeType.toLowerCase();
    const high = c => type(c) === 'video/h264' && /profile-level-id=64/i.test(c.sdpFmtpLine || '');
    const baseline = c => type(c) === 'video/h264' && /profile-level-id=42/i.test(c.sdpFmtpLine || '');
    const groups = [c => type(c) === 'video/av1', high, c => type(c) === 'video/vp9', c => type(c) === 'video/vp8'];
    if (battery || h264First) groups.unshift(groups.splice(1, 1)[0]);
    const order = [];
    for (const g of groups) for (const c of caps) if (g(c) && !order.includes(c)) order.push(c);
    for (const c of caps) if (!order.includes(c) && !baseline(c) && !/^video\/(av1|h264|vp9|vp8)$/.test(type(c))) order.push(c); // rtx, red, fec
    for (const c of caps) if (!order.includes(c) && !baseline(c)) order.push(c);
    try { tr.setCodecPreferences(order); } catch (e) { log('codec preferences: ' + e.name); }
  }

  async function offer(restart) {
    if (!pc) return;
    if (restart) pc.restartIce();
    const o = await pc.createOffer();
    await pc.setLocalDescription(o);
    post({ t: 'signal', kind: 'offer', sdp: pc.localDescription.sdp });
  }

  function queueCandidate(c) {
    outCands.push(c);
    if (outCands.length >= 20) flushCandidates();
    else if (!candTimer) candTimer = setTimeout(flushCandidates, 50);
  }

  function flushCandidates() {
    clearTimeout(candTimer);
    candTimer = 0;
    while (outCands.length) post({ t: 'signal', kind: 'candidates', candidates: outCands.splice(0, 20) }); // the server takes 20 a signal
  }

  function addCandidate(c) {
    pc.addIceCandidate(c).catch(e => log('a candidate: ' + e.name));
  }

  async function onSignal(m) {
    if (!pc) return;
    if (m.kind === 'answer') {
      if (pc.signalingState !== 'have-local-offer' || typeof m.sdp !== 'string') return;
      await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
      for (const c of pendingRemote.splice(0)) addCandidate(c);
      await applyParams();
    } else if (m.kind === 'candidates') {
      for (const c of Array.isArray(m.candidates) ? m.candidates : []) {
        candidatesIn++;
        for (const r of rewrite(c)) { candidatesAdded++; if (pc.remoteDescription) addCandidate(r); else pendingRemote.push(r); }
      }
    } else if (m.kind === 'restart') {
      await offer(true);
    }
  }

  async function onState() {
    if (!pc) return;
    const s = pc.connectionState;
    if (s === 'connected') {
      clearTimeout(restartTimer);
      restartTimer = 0;
      await reportSelected();
    } else if (s === 'disconnected') {
      // Gone for over 3 s: an ICE restart (the viewer may ask for one too).
      if (!restartTimer) restartTimer = setTimeout(() => { restartTimer = 0; if (pc && pc.connectionState === 'disconnected') offer(true).catch(e => log('restart: ' + e.name)); }, 3000);
    } else if (s === 'failed') {
      post({ t: 'state', pc: 'failed' });
    }
  }

  async function selected() {
    const s = await pc.getStats();
    let pair = null;
    s.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = s.get(r.selectedCandidatePairId); });
    if (!pair) s.forEach(r => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    const rc = pair && s.get(pair.remoteCandidateId);
    return rc ? { ip: rc.address || rc.ip || '', port: rc.port || 0, type: rc.candidateType || '' } : null;
  }

  // The remote end of the selected pair (local addresses read as ""): Beam checks it before anything flows, and again
  // whenever it changes. A peer-reflexive remote (its checks came before its candidates) reads as "" until the
  // candidate it sent (rewritten to its attested address) replaces it: up to 5 s. One that never resolves fails Beam's
  // check, as does any address but the attested one.
  let reporting = false, reportAgain = false;
  async function reportSelected() {
    if (!pc) return;
    if (reporting) { reportAgain = true; return; }
    reporting = true;
    try {
      let sel = await selected();
      for (let i = 0; i < 25 && pc && sel && !sel.ip; i++) { await new Promise(r => setTimeout(r, 200)); sel = await selected(); }
      if (!pc) return;
      if (sel && !sel.ip) {
        // For beam.log: what the remote side looks like (kinds and counts only, never addresses).
        const s = await pc.getStats();
        const kinds = {};
        s.forEach(r => { if (r.type === 'remote-candidate') { const k = (r.candidateType || '?') + (r.address ? '' : '(no address)'); kinds[k] = (kinds[k] || 0) + 1; } });
        log('the peer stayed unresolved: remote ' + JSON.stringify(kinds) + ', candidates received ' + candidatesIn + ', added ' + candidatesAdded);
      }
      lastSelected = sel ? sel.ip + ' ' + sel.port : '';
      post({ t: 'state', pc: pc.connectionState, ice: pc.iceConnectionState, remoteIp: sel ? sel.ip : '', remotePort: sel ? sel.port : 0, type: sel ? sel.type : '' });
    } finally {
      reporting = false;
      if (reportAgain) { reportAgain = false; reportSelected(); }
    }
  }

  async function applyParams() {
    if (!tr) return;
    const q = QUALITY[mode];
    const p = tr.sender.getParameters();
    if (!p.encodings || !p.encodings.length) return;
    p.encodings[0].active = verified && !ended;
    p.encodings[0].maxBitrate = q.kbps * 1000;
    p.encodings[0].maxFramerate = q.fps;
    p.degradationPreference = 'maintain-resolution';
    try { await tr.sender.setParameters(p); } catch (e) { log('sender parameters: ' + e.name); }
  }

  // ------------------------------------------------------------------ after Beam's check

  async function onVerified(m) {
    verified = true;
    hello = m.hello || {};
    await applyParams(); // the video starts
    if (ch && ch.ctl.readyState === 'open') sendHello();
  }

  function sendHello() {
    if (!hello) return;
    sendCtl(Object.assign({}, hello, { codec: codecNow, encoder: encoderNow }));
  }

  function sendCtl(m) {
    if (verified && ch && ch.ctl.readyState === 'open') { try { ch.ctl.send(JSON.stringify(m)); } catch (e) { } }
  }

  function onCtl(data) {
    if (typeof data !== 'string' || data.length > 100000) return;
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== 'object' || !verified) return;
    if (m.t === 'ping') { sendCtl({ t: 'pong', n: m.n, at: m.at }); return; }
    post({ t: 'ctl', d: data });
  }

  async function setQuality(m) {
    mode = m.mode === 'motion' ? 'motion' : 'text';
    const q = QUALITY[mode];
    try { if (track) await track.applyConstraints(constraints()); } catch (e) { log('constraints: ' + e.name); }
    await applyParams();
    sendCtl({ t: 'quality', mode, maxFps: q.fps, maxKbps: q.kbps });
  }

  async function renegotiate(why) {
    log(why);
    applyCodecs();
    await offer(false);
  }

  async function stats() {
    if (!pc || ended) return;
    const s = await pc.getStats();
    let o = null;
    s.forEach(r => { if (r.type === 'outbound-rtp' && r.kind === 'video') o = r; });
    if (o) {
      const codec = o.codecId && s.get(o.codecId);
      codecNow = codec ? codec.mimeType.replace(/^video\//i, '') : null;
      encoderNow = o.encoderImplementation || null;
      const kbps = prev && o.timestamp > prev.timestamp ? Math.round((o.bytesSent - prev.bytesSent) * 8 / (o.timestamp - prev.timestamp)) : 0;
      prev = o;
      const st = { t: 'stats', codec: codecNow, encoder: encoderNow, fps: o.framesPerSecond || 0, kbps, w: o.frameWidth || 0, h: o.frameHeight || 0, qlr: o.qualityLimitationReason || 'none' };
      post(st);
      sendCtl(st);
      // The CPU can't keep up (software AV1): H.264 High, the hardware encoder.
      if (st.qlr === 'cpu' && codecNow && codecNow.toLowerCase() !== 'h264') cpuStrikes++; else cpuStrikes = 0;
      if (cpuStrikes >= 3 && !h264First) { h264First = true; await renegotiate('the CPU is the limit: switching to H.264'); }
    }
    if (pc && pc.connectionState === 'connected') {
      const sel = await selected();
      const key = sel ? sel.ip + ' ' + sel.port : '';
      if (key !== lastSelected) await reportSelected();
    }
  }

  // ------------------------------------------------------------------ the end

  function end(reason) {
    if (ended) return;
    sendCtl({ t: 'bye', reason: reason || 'stopped' });
    ended = true;
    verified = false;
    clearInterval(statsTimer);
    if (stream) stream.getTracks().forEach(t => t.stop()); // the capture stops now
    setTimeout(() => { try { if (pc) pc.close(); } catch (e) { } pc = null; }, 200); // time for the bye to go out
  }

  // ------------------------------------------------------------------ from Beam

  window.chrome.webview.addEventListener('message', e => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'signal': onSignal(m).catch(err => log('signal ' + m.kind + ': ' + (err && err.name))); break;
      case 'verified': onVerified(m).catch(err => log('verified: ' + (err && err.name))); break;
      case 'send': if (m.ch === 'ctl' && m.m && typeof m.m === 'object') sendCtl(m.m); break;
      case 'quality': setQuality(m).catch(() => {}); break;
      case 'battery':
        battery = !!m.on;
        if (battery && !h264First && codecNow && codecNow.toLowerCase() !== 'h264') renegotiate('on battery: switching to H.264').catch(() => {});
        break;
      case 'end': end(m.reason); break;
    }
  });

  post({ t: 'ready' });
})();
