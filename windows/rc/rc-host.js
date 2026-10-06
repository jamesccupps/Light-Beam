// Beam's capture host page (Beam 1.6), embedded in Beam.exe. RcHost runs it in a WebView2 window nobody sees, as
// https://beam-remote-control/rc-host.html. It captures the screen (the browser picks it, with no picker), offers it
// to the viewer over WebRTC with three data channels (ctl, in, mv: research §8.7) and hands everything else to Beam,
// which decides: Beam checks the peer before anything flows (`verified`), injects the input, owns the clipboard and
// talks to the server. This page can't reach the network itself (its CSP has no connect-src; ICE only) and keeps
// nothing: no frames, no input.
// (1.12) A kvm session (another PC's own keyboard and mouse working this one) captures nothing: the same connection
// with its three channels, and no picture at all.
'use strict';
(function () {
  const post = m => window.chrome.webview.postMessage(m);
  const log = m => post({ t: 'log', m: String(m).slice(0, 200) });
  window.addEventListener('error', e => log('error: ' + e.message));
  window.addEventListener('unhandledrejection', e => log('rejection: ' + (e.reason && (e.reason.name || e.reason))));

  // The picture's profiles: "Sharp text" and "Smooth motion" (plan/rd-spike-results.md), and from Beam 1.8 "Data saver"
  // (a phone on mobile data: smaller, fewer frames) and "Auto" (sharp while the screen is still, smooth while it moves,
  // a data saver on mobile data; budgets up to what the network carries). The viewer's settings can override frame
  // rate, data rate, size and codec.
  const PROFILES = {
    text: { fps: 30, kbps: 8000, hint: 'text', pref: 'maintain-resolution' },
    motion: { fps: 60, kbps: 16000, hint: 'motion', pref: 'maintain-framerate' },
    saver: { fps: 15, kbps: 1500, hint: 'text', pref: 'maintain-resolution', box: [1280, 720] },
  };
  const AUTO_KBPS = { text: 15000, motion: 25000 };
  let cfg = null, stream = null, track = null, pc = null, ch = null, tr = null;
  let verified = false, hello = null, battery = false, h264First = false, cpuStrikes = 0;
  let settings = { mode: 'text', size: 'auto', vw: 0, vh: 0, fps: 0, kbps: 0, codec: 'auto', net: '' };
  let autoPick = 'text', busyTicks = 0, calmTicks = 0, videoOn = true, src = { w: 0, h: 0 }, codecsKey = '';
  let pendingRemote = [], outCands = [], candTimer = 0, restartTimer = 0, statsTimer = 0, prev = null, lastSelected = null;
  let codecNow = null, encoderNow = null, ended = false, candidatesIn = 0, candidatesAdded = 0, recapturing = null, kvm = false;
  // (1.12.4) Pictures through the clipboard: the `clip` channel of their own (on `ctl` a big one would hold up the pings),
  // Beam's parts sent as it drains (at most 1 MB waiting in it), the viewer's passed to Beam.
  let clipOut = [];
  // (1.12.4) The viewer's control messages from before Beam's own peer check (its hello, when its check was quicker):
  // kept until the check passes, then handled in order; nothing of them counts before it.
  let earlyCtl = [];
  const CLIP_BUFFERED = 1 << 20;
  // Windows' "Stop sharing", or a display change that ended the capture: Beam tells them apart (1.11.4: the second
  // starts again).
  const onTrackEnded = () => { if (!ended) post({ t: 'ended', reason: 'stopped-sharing' }); };

  // The profile now: the viewer's mode (Auto's pick), with its overrides.
  function profile() {
    const mode = settings.mode === 'auto' ? (settings.net === 'cellular' ? 'saver' : autoPick) : settings.mode;
    const p = Object.assign({ name: mode }, PROFILES[mode] || PROFILES.text);
    if (settings.mode === 'auto' && mode !== 'saver') p.kbps = AUTO_KBPS[mode];
    if (settings.fps) p.fps = settings.fps;
    if (settings.kbps) p.kbps = settings.kbps;
    return p;
  }

  // How much smaller than the screen the picture goes (scaleResolutionDownBy): never larger than the viewer shows it
  // (its picture area, zoom included: `window`, and `auto` when the viewer said), or a fixed box (1080p, 720p, Data saver).
  function downscale(p) {
    if (!src.w || !src.h) return 1;
    let box = null;
    if (settings.size === '1080') box = [1920, 1080];
    else if (settings.size === '720') box = [1280, 720];
    else if (settings.size === 'full') box = null;
    else if (p.box && settings.size === 'auto') box = p.box;
    if (box && src.h > src.w) box = [box[1], box[0]];
    let s = box ? Math.max(src.w / box[0], src.h / box[1]) : 1;
    // (the viewer fits the picture into its area, so it shows it at 1/max(w/vw, h/vh) of the screen's size)
    if ((settings.size === 'window' || settings.size === 'auto') && settings.vw >= 64 && settings.vh >= 64) s = Math.max(s, src.w / settings.vw, src.h / settings.vh);
    return Math.max(1, Math.round(s * 100) / 100);
  }

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
    const fps = profile().fps;
    return { width: { max: 3840 }, height: { max: 2160 }, frameRate: { ideal: fps, max: fps } };
  }

  // Beam starts this through DevTools with a user gesture. A wrong source name hangs silently: 5 s at most.
  window.rcStart = async function (c) {
    if (cfg) return;
    cfg = c;
    if (c.kvm === true) { kvm = true; await connect(); return; } // (no capture, ever)
    if (c.settings && typeof c.settings === 'object') takeSettings(c.settings); // (a new page after a switch of screens)
    else settings.mode = c.mode === 'motion' ? 'motion' : 'text';
    videoOn = c.video !== false;
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
    track.contentHint = profile().hint;
    track.onended = onTrackEnded;
    const size = await frameSize(stream); // getSettings() reports the constraint's maximum, not the screen
    src = { w: size.w, h: size.h };
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

  // (1.11.4) A fresh capture of the same screen in place of the old one, on the same connection (replaceTrack: no new
  // offer): after a display change, which can end the capture and leaves Windows' sharing bar drawn for the old
  // scaling; the new capture comes with a new bar. Beam's gate allows it as it did the first (the session is on).
  function recapture() {
    if (recapturing || ended || !stream) return recapturing;
    recapturing = (async () => {
      let late = false, timer = 0, s;
      const capture = navigator.mediaDevices.getDisplayMedia({ video: constraints(), audio: false });
      capture.then(x => { if (late || ended) x.getTracks().forEach(t => t.stop()); }, () => {});
      try {
        s = await Promise.race([capture, new Promise(res => { timer = setTimeout(() => res('timeout'), 5000); })]);
      } catch (e) {
        clearTimeout(timer);
        if (!ended) post({ t: 'ended', reason: 'capture-' + (e && e.name || 'error') + '-again' });
        return;
      }
      clearTimeout(timer);
      if (s === 'timeout') { late = true; if (!ended) post({ t: 'ended', reason: 'capture-timeout-again' }); return; }
      if (ended) return;
      const old = stream;
      const t = s.getVideoTracks()[0];
      t.contentHint = profile().hint;
      t.onended = onTrackEnded;
      try { if (tr) await tr.sender.replaceTrack(t); } catch (e) { log('replace track: ' + e.name); }
      stream = s;
      track = t;
      if (old) old.getTracks().forEach(x => { x.onended = null; x.stop(); });
      const size = await frameSize(s);
      src = { w: size.w, h: size.h };
      post({ t: 'recaptured', w: size.w, h: size.h });
      await applyProfile();
    })().finally(() => { recapturing = null; });
    return recapturing;
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
    earlyCtl = [];
    pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    ch = {
      ctl: pc.createDataChannel('ctl', { negotiated: true, id: 0, ordered: true }),
      in: pc.createDataChannel('in', { negotiated: true, id: 1, ordered: true }),
      mv: pc.createDataChannel('mv', { negotiated: true, id: 2, ordered: false, maxRetransmits: 0 }),
      clip: pc.createDataChannel('clip', { negotiated: true, id: 3, ordered: true }), // (1.12.4; a viewer before it never opens it)
    };
    ch.clip.bufferedAmountLowThreshold = 256 * 1024;
    ch.clip.onbufferedamountlow = drainClip;
    ch.clip.onopen = drainClip;
    ch.clip.onmessage = e => { if (verified && typeof e.data === 'string' && e.data.length <= 80000) post({ t: 'clip', d: e.data }); };
    ch.ctl.onopen = () => { if (verified) sendHello(); };
    ch.ctl.onmessage = e => onCtl(e.data);
    ch.in.onmessage = e => { if (verified && typeof e.data === 'string' && e.data.length <= 16384) post({ t: 'in', d: e.data }); };
    ch.mv.onmessage = e => { if (verified && typeof e.data === 'string' && e.data.length <= 512) post({ t: 'mv', d: e.data }); };
    if (!kvm) {
      const p = profile();
      // No video until Beam has checked the peer: the encoding starts inactive.
      tr = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream], sendEncodings: [{ active: false, maxBitrate: p.kbps * 1000, maxFramerate: p.fps, scaleResolutionDownBy: downscale(p) }] });
      applyCodecs();
    }
    pc.onicecandidate = e => queueCandidate(e.candidate ? e.candidate.toJSON() : { candidate: '', sdpMid: null, sdpMLineIndex: null });
    pc.onconnectionstatechange = onState;
    try {
      // (kvm: the stats tick looks at the pair every 2 s instead)
      const ice = tr && tr.sender.transport && tr.sender.transport.iceTransport;
      if (ice) ice.onselectedcandidatepairchange = () => { if (pc && pc.connectionState === 'connected') reportSelected(); };
    } catch (e) { }
    await offer(false);
    statsTimer = setInterval(stats, 2000);
  }

  // AV1 first (the sharpest text), then H.264 High (hardware on NVIDIA), VP9, VP8; never H.264 Constrained Baseline
  // (software OpenH264 here). On battery, or when the CPU is the limit, H.264 High goes first; a codec the viewer
  // picked (1.8) goes before all. Returns whether the order changed (a new offer applies it).
  function applyCodecs() {
    let caps;
    try { caps = RTCRtpSender.getCapabilities('video').codecs; } catch (e) { return false; }
    const type = c => c.mimeType.toLowerCase();
    const high = c => type(c) === 'video/h264' && /profile-level-id=64/i.test(c.sdpFmtpLine || '');
    const baseline = c => type(c) === 'video/h264' && /profile-level-id=42/i.test(c.sdpFmtpLine || '');
    const groups = [c => type(c) === 'video/av1', high, c => type(c) === 'video/vp9', c => type(c) === 'video/vp8'];
    if (battery || h264First) groups.unshift(groups.splice(1, 1)[0]);
    const picked = { av1: 'video/av1', h264: 'video/h264', vp9: 'video/vp9' }[settings.codec];
    if (picked) { const i = groups.findIndex(g => caps.some(c => g(c) && type(c) === picked)); if (i > 0) groups.unshift(groups.splice(i, 1)[0]); }
    const order = [];
    for (const g of groups) for (const c of caps) if (g(c) && !order.includes(c)) order.push(c);
    for (const c of caps) if (!order.includes(c) && !baseline(c) && !/^video\/(av1|h264|vp9|vp8)$/.test(type(c))) order.push(c); // rtx, red, fec
    for (const c of caps) if (!order.includes(c) && !baseline(c)) order.push(c);
    const key = order.slice(0, 4).map(c => type(c) + (c.sdpFmtpLine || '')).join('|');
    if (key === codecsKey) return false;
    codecsKey = key;
    try { tr.setCodecPreferences(order); } catch (e) { log('codec preferences: ' + e.name); }
    return true;
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
    // (an address that isn't one, like libwebrtc's "redacted-ip.invalid" for a remote it won't reveal, reads as "":
    // not known yet; 1.7.3)
    const ip = rc ? String(rc.address || rc.ip || '') : '';
    return rc ? { ip: isIp(ip) ? ip : '', port: rc.port || 0, type: rc.candidateType || '' } : null;
  }
  function isIp(a) {
    const s = a.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s !== '0.0.0.0';
    return s.includes(':') && /^[0-9a-f:.]+$/i.test(s) && /[1-9a-f]/i.test(s); // (IPv6, also with an IPv4 tail)
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

  // The encoding's parameters from the profile now, one change at a time (setParameters takes the latest
  // getParameters only). Video flows once Beam's check passed, while the viewer is visible.
  let paramsChain = Promise.resolve();
  function applyParams() {
    paramsChain = paramsChain.then(setParams, setParams);
    return paramsChain;
  }
  async function setParams() {
    if (!tr) return;
    const pr = profile();
    const p = tr.sender.getParameters();
    if (!p.encodings || !p.encodings.length) return;
    p.encodings[0].active = verified && !ended && videoOn;
    p.encodings[0].maxBitrate = pr.kbps * 1000;
    p.encodings[0].maxFramerate = pr.fps;
    p.encodings[0].scaleResolutionDownBy = downscale(pr);
    p.degradationPreference = pr.pref;
    try { await tr.sender.setParameters(p); } catch (e) { log('sender parameters: ' + e.name); }
  }

  // ------------------------------------------------------------------ after Beam's check

  async function onVerified(m) {
    verified = true;
    hello = m.hello || {};
    earlyCtl.splice(0).forEach(onCtl);
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
    if (!m || typeof m !== 'object') return;
    if (!verified) { if (!ended && earlyCtl.length < 20) earlyCtl.push(data); return; }
    if (m.t === 'ping') { sendCtl({ t: 'pong', n: m.n, at: m.at }); return; }
    post({ t: 'ctl', d: data });
  }

  // The profile's frame rate, data rate, size and kind of content, at once (the same connection), and the viewer told
  // (`mode` for 1.6 viewers: text or motion).
  let profileChain = Promise.resolve();
  function applyProfile() {
    profileChain = profileChain.then(async () => {
      if (!track || ended) return;
      const p = profile();
      if (track.contentHint !== p.hint) track.contentHint = p.hint;
      try { await track.applyConstraints(constraints()); } catch (e) { log('constraints: ' + e.name); }
      await applyParams();
      sendCtl({ t: 'quality', mode: p.name === 'motion' ? 'motion' : 'text', profile: p.name, auto: settings.mode === 'auto', maxFps: p.fps, maxKbps: p.kbps, down: downscale(p) });
    }).catch(e => log('profile: ' + (e && e.name)));
    return profileChain;
  }

  // A 1.6 viewer's choice: Sharp text or Smooth motion.
  function setQuality(m) {
    settings.mode = m.mode === 'motion' ? 'motion' : 'text';
    return applyProfile();
  }

  // The viewer's settings (1.8; Beam checked them too).
  function takeSettings(m) {
    const one = (v, list) => (list.includes(v) ? v : list[0]);
    const px = v => (Number.isFinite(v) ? Math.max(0, Math.min(16384, Math.round(v))) : 0);
    settings = {
      mode: one(m.mode, ['auto', 'text', 'motion', 'saver']),
      size: one(m.size, ['auto', 'full', '1080', '720', 'window']),
      vw: px(m.vw), vh: px(m.vh),
      fps: [15, 30, 60].includes(m.fps) ? m.fps : 0,
      kbps: Number.isFinite(m.kbps) && m.kbps >= 500 && m.kbps <= 100000 ? Math.round(m.kbps) : 0,
      codec: one(m.codec, ['auto', 'av1', 'h264', 'vp9']),
      net: m.net === 'cellular' ? 'cellular' : '',
    };
  }

  async function setSettings(m) {
    takeSettings(m);
    if (settings.mode !== 'auto') busyTicks = calmTicks = 0;
    if (pc && tr && applyCodecs()) await offer(false); // another codec first: a new offer (the same connection)
    await applyProfile();
  }

  // Auto: busy (15+ frames a second at 2.5+ Mbps for 4 s: a video, a game, scrolling) → smooth motion; calm (under
  // 1 Mbps for 6 s) → sharp text again.
  function autoStep(fps, kbps) {
    if (settings.mode !== 'auto' || settings.net === 'cellular' || !videoOn) { busyTicks = calmTicks = 0; return; }
    if (fps >= 15 && kbps >= 2500) { busyTicks++; calmTicks = 0; }
    else if (kbps < 1000) { calmTicks++; busyTicks = 0; }
    else busyTicks = calmTicks = 0;
    const want = autoPick === 'text' ? (busyTicks >= 2 ? 'motion' : 'text') : (calmTicks >= 3 ? 'text' : 'motion');
    if (want === autoPick) return;
    autoPick = want;
    busyTicks = calmTicks = 0;
    applyProfile();
  }

  async function renegotiate(why) {
    log(why);
    applyCodecs();
    await offer(false);
  }

  async function stats() {
    if (!pc || ended) return;
    const s = await pc.getStats();
    let o = null, source = null, back = null, pair = null;
    s.forEach(r => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') o = r;
      else if (r.type === 'media-source' && r.kind === 'video') source = r;
      else if (r.type === 'remote-inbound-rtp' && r.kind === 'video') back = r;
      else if (r.type === 'transport' && r.selectedCandidatePairId) pair = s.get(r.selectedCandidatePairId);
    });
    // The screen's own size now (fitting the PC to the viewer changes it): the picture's size follows.
    if (source && source.width > 0 && source.height > 0 && (source.width !== src.w || source.height !== src.h)) {
      src = { w: source.width, h: source.height };
      applyParams();
    }
    if (o) {
      const codec = o.codecId && s.get(o.codecId);
      codecNow = codec ? codec.mimeType.replace(/^video\//i, '') : null;
      encoderNow = o.encoderImplementation || null;
      const kbps = prev && o.timestamp > prev.timestamp ? Math.round((o.bytesSent - prev.bytesSent) * 8 / (o.timestamp - prev.timestamp)) : 0;
      // (1.12.6, the viewer's delay measurement) A frame's encoding and its packets' wait to go out, lately, in ms.
      const per = (total, count) => (prev && Number.isFinite(o[total]) && Number.isFinite(prev[total]) && o[count] > prev[count]
        ? Math.round((o[total] - prev[total]) / (o[count] - prev[count]) * 10000) / 10 : null);
      const encMs = per('totalEncodeTime', 'framesEncoded'), sendMs = per('totalPacketSendDelay', 'packetsSent');
      prev = o;
      const p = profile();
      const ms = v => (Number.isFinite(v) ? Math.round(v * 1000) : null);
      const st = {
        t: 'stats', codec: codecNow, encoder: encoderNow, fps: o.framesPerSecond || 0, kbps, w: o.frameWidth || 0, h: o.frameHeight || 0, qlr: o.qualityLimitationReason || 'none',
        // 1.8, for the viewer's details: the screen's size, the profile and its limits, the network's estimate, loss, delay
        srcW: src.w, srcH: src.h, down: downscale(p), profile: p.name, auto: settings.mode === 'auto', maxFps: p.fps, maxKbps: p.kbps,
        avail: pair && pair.availableOutgoingBitrate ? Math.round(pair.availableOutgoingBitrate / 1000) : 0,
        lost: back && Number.isFinite(back.fractionLost) ? Math.round(back.fractionLost * 1000) / 10 : null,
        rtt: back && Number.isFinite(back.roundTripTime) ? ms(back.roundTripTime) : pair ? ms(pair.currentRoundTripTime) : null,
        video: videoOn, encMs, sendMs,
      };
      post(st);
      sendCtl(st);
      // The CPU can't keep up (software AV1): H.264 High, the hardware encoder (unless the viewer picked a codec).
      if (st.qlr === 'cpu' && codecNow && codecNow.toLowerCase() !== 'h264' && settings.codec === 'auto') cpuStrikes++; else cpuStrikes = 0;
      if (cpuStrikes >= 3 && !h264First) { h264First = true; await renegotiate('the CPU is the limit: switching to H.264'); }
      autoStep(st.fps, kbps);
    }
    if (pc && pc.connectionState === 'connected') {
      const sel = await selected();
      const key = sel ? sel.ip + ' ' + sel.port : '';
      if (key !== lastSelected) await reportSelected();
    }
  }

  function drainClip() {
    const c = ch && ch.clip;
    if (!verified || !c || c.readyState !== 'open') { if (!c || c.readyState === 'closed') clipOut = []; return; }
    while (clipOut.length && c.bufferedAmount < CLIP_BUFFERED) {
      try { c.send(clipOut.shift()); } catch (e) { clipOut = []; return; }
    }
  }

  // ------------------------------------------------------------------ the end

  function end(reason) {
    if (ended) return;
    sendCtl({ t: 'bye', reason: reason || 'stopped' });
    ended = true;
    verified = false;
    clipOut = [];
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
      case 'clipout': if (typeof m.d === 'string' && m.d.length <= 80000) { clipOut.push(m.d); drainClip(); } break;
      case 'quality': setQuality(m).catch(() => {}); break;
      case 'settings': setSettings(m).catch(err => log('settings: ' + (err && err.name))); break;
      case 'video':
        videoOn = m.on !== false;
        applyParams().catch(() => {});
        break;
      case 'battery':
        battery = !!m.on;
        if (battery && !h264First && codecNow && codecNow.toLowerCase() !== 'h264') renegotiate('on battery: switching to H.264').catch(() => {});
        break;
      case 'recapture': recapture(); break;
      case 'end': end(m.reason); break;
    }
  });

  post({ t: 'ready' });
})();
