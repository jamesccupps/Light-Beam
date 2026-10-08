// Remote control (1.6, feature `remote-control`): the viewer (public/remote.js) against a fake PC. The fake PC is a
// page in its own browser context that talks the PC's side of plan/rd-contract.md to the scratch server: it offers a
// canvas for a screen (never a real capture), injects nothing, and records what the viewer sends.
//
// A real connection needs an address both sides can reach that counts as Tailscale: this machine's own Tailscale
// address (the spike's way). Tests that connect are skipped without one. The server attests the PC's address from
// its (fake) X-Forwarded-For, so those tests stand in for that attestation in the viewer's 201 (attestAs below).
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { sleep } from './cdp.mjs';
import { assert, eq } from './harness.mjs';
import { dev } from './tests-core.mjs';
import { hostPage } from './tests-host.mjs';

const FEATURE = 'remote-control';
const TS4 = Object.values(os.networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address))?.address || '';
const MONITORS = [
  { id: 0, name: 'Screen 1', x: 0, y: 0, w: 2560, h: 1440, primary: true, scale: 1.5 },
  { id: 1, name: 'Screen 2', x: 2560, y: 0, w: 1920, h: 1080, primary: false, scale: 1 },
];

// The PC's side, in its page. cfg: { id, name, key, version, viewerIp, monitors }.
function fakePcMain(cfg) {
  const H = {
    Authorization: `Bearer ${cfg.key}`, 'X-Beam-Device-Id': cfg.id, 'X-Beam-Device': encodeURIComponent(cfg.name),
    'X-Beam-Platform': 'windows', 'X-Beam-App-Version': cfg.version, 'X-Beam-Profile': 'a1b2c3d4e5f60718' /* (its Windows account, as the app hashes it) */,
  };
  const pcs = window.fakePc = {
    cfg, headers: H, rec: { ctl: [], in: [], mv: [], clip: [], events: [], order: [], answers: 0, offers: 0, peer: [] },
    session: null, pc: null, ch: null, connected: false, monitor: 0, monitors: cfg.monitors,
    decline: false, offer: true, hello: true, viewerIp: cfg.viewerIp,
    holdCandidates: false, // (its checks then come before its candidates, as they often do)
    imgIn: null, // (1.12.4) a picture coming in on `clip`: its size so far, as the PC's app assembles it
  };
  let seq = 0;
  const api = (method, path, body) => fetch(path, { method, headers: { ...H, ...(body !== undefined && { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  pcs.api = api;
  pcs.status = fields => api('PUT', '/api/devices/me/status', fields).then(r => r.status);
  pcs.signal = (kind, body = {}) => pcs.session && api('POST', `/api/rc/sessions/${pcs.session.id}/signal`, { kind, ...body }).then(r => r.status);
  pcs.end = (reason = 'stopped') => pcs.session && api('POST', `/api/rc/sessions/${pcs.session.id}/end`, { reason }).then(r => r.status);
  pcs.send = (name, msg) => { const c = pcs.ch?.[name]; if (c?.readyState === 'open') { c.send(JSON.stringify(msg)); return true; } return false; };
  // (1.12.4) Its clipboard picture (base64 of a PNG) to the viewer, in parts of 48 KB, as Beam's PC side sends it.
  pcs.sendImage = (b64, n) => {
    const size = atob(b64).length, part = 65536, of = Math.max(1, Math.ceil(b64.length / part));
    for (let i = 0; i < of; i++) pcs.send('clip', { t: 'img', n, i, of, size, type: 'image/png', d: b64.slice(i * part, (i + 1) * part) });
    return of;
  };

  // Its event stream (an app's: platform windows), read with fetch.
  pcs.open = () => new Promise(resolve => {
    const ac = new AbortController();
    pcs.abort = ac;
    fetch(`/api/events?device=${encodeURIComponent(cfg.id)}&platform=windows&name=${encodeURIComponent(cfg.name)}&version=${cfg.version}`, { headers: H, signal: ac.signal }).then(async res => {
      resolve(res.status);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev && data && /^rc-/.test(ev)) { try { pcs.onEvent(ev, JSON.parse(data)); } catch (e) { console.error('fake pc', e); } }
        }
      }
    }).catch(() => resolve(0));
  });
  pcs.offline = () => pcs.abort?.abort();

  pcs.onEvent = (ev, d) => {
    pcs.rec.events.push({ ev, id: d.id, kind: d.kind, reason: d.reason, from: d.from });
    if (ev === 'rc-request') pcs.onRequest(d);
    else if (ev === 'rc-signal' && pcs.session && d.id === pcs.session.id) pcs.onSignal(d);
    else if (ev === 'rc-end' && pcs.session && d.id === pcs.session.id) { pcs.closePeer(); pcs.session = null; }
  };

  pcs.onRequest = async req => {
    if (pcs.decline) { await api('POST', `/api/rc/sessions/${req.id}/end`, { reason: 'declined' }); return; }
    pcs.closePeer();
    pcs.session = { id: req.id, viewer: req.viewer, from: req.from };
    await api('POST', `/api/rc/sessions/${req.id}/lease`);
    if (pcs.offer) await pcs.connect();
  };

  // A synthetic screen: a canvas (nothing of this PC's real screen). `cfg.scene` 'desktop' (screenshots): a made-up
  // desktop at 2560×1440 with windows and small text, to judge how a phone shows it.
  pcs.screen = () => {
    if (pcs.track) return;
    const cv = document.createElement('canvas');
    const desk = cfg.scene === 'desktop';
    cv.width = desk ? 2560 : 1280;
    cv.height = desk ? 1440 : 720;
    const g = cv.getContext('2d');
    let n = 0;
    const desktop = () => {
      g.fillStyle = '#1d4e89';
      g.fillRect(0, 0, 2560, 1440);
      g.fillStyle = '#20242c';
      g.fillRect(0, 1368, 2560, 72);
      g.fillStyle = '#e8eaee';
      g.font = '22px Segoe UI, sans-serif';
      g.fillText('Start    Search    Files    Edge    Terminal', 40, 1412);
      g.fillText('10:42 AM', 2420, 1412);
      const win = (x, y, w, h, title, lines) => {
        g.fillStyle = '#f3f3f3';
        g.fillRect(x, y, w, h);
        g.fillStyle = '#dcdcdc';
        g.fillRect(x, y, w, 46);
        g.fillStyle = '#202020';
        g.font = '21px Segoe UI, sans-serif';
        g.fillText(title, x + 18, y + 30);
        g.fillText('—   ☐   ✕', x + w - 130, y + 30);
        g.font = '20px Segoe UI, sans-serif';
        lines.forEach((l, i) => g.fillText(l, x + 24, y + 90 + i * 32));
      };
      win(120, 100, 1100, 760, 'Notepad — notes.txt', Array.from({ length: 20 }, (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog, 0123456789.`));
      win(1320, 220, 1100, 700, 'Settings', ['System', 'Bluetooth & devices', 'Network & internet', 'Personalization', 'Apps', 'Accounts', 'Time & language', 'Gaming', 'Accessibility', 'Privacy & security', 'Windows Update']);
      g.fillStyle = '#0067c0';
      g.fillRect(2200, 860, 180, 44);
      g.fillStyle = '#ffffff';
      g.fillText('Save', 2265, 890);
    };
    pcs.drawTimer = setInterval(() => {
      n++;
      if (desk) return desktop();
      g.fillStyle = '#204060';
      g.fillRect(0, 0, 1280, 720);
      g.fillStyle = '#f0c040';
      g.fillRect((n * 8) % 1280, 300, 120, 120);
      g.fillStyle = '#ffffff';
      g.font = '40px sans-serif';
      g.fillText(`frame ${n}`, 40, 80);
      // (1.12.6) The delay probe's square, as Beam's PC side shows it: 32 of its screen's pixels in the top left corner.
      if (pcs.probeColor) {
        const s = 32 * cv.width / (pcs.monitors.find(x => x.id === pcs.monitor) || pcs.monitors[0]).w;
        g.fillStyle = pcs.probeColor === 'green' ? '#00ff00' : '#ff00ff';
        g.fillRect(0, 0, Math.ceil(s), Math.ceil(s));
      }
    }, 33);
    pcs.stream = cv.captureStream(30);
    pcs.track = pcs.stream.getVideoTracks()[0];
  };

  pcs.closePeer = () => {
    if (pcs.ch) for (const c of Object.values(pcs.ch)) try { c.close(); } catch {}
    if (pcs.pc) try { pcs.pc.close(); } catch {}
    clearInterval(pcs.pingTimer);
    pcs.pc = pcs.ch = null;
    pcs.connected = false;
  };

  // A connection: a new one for every session and every switch of screens (a new o= id); offered by the PC.
  pcs.connect = async () => {
    pcs.closePeer();
    pcs.screen();
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    pcs.pc = pc;
    const ch = pcs.ch = {
      ctl: pc.createDataChannel('ctl', { negotiated: true, id: 0, ordered: true }),
      in: pc.createDataChannel('in', { negotiated: true, id: 1, ordered: true }),
      mv: pc.createDataChannel('mv', { negotiated: true, id: 2, ordered: false, maxRetransmits: 0 }),
      clip: pc.createDataChannel('clip', { negotiated: true, id: 3, ordered: true }), // (1.12.4: pictures)
    };
    const tr = pc.addTransceiver('video', { direction: 'sendonly', streams: [pcs.stream] });
    pcs.tr = tr;
    const codecs = RTCRtpSender.getCapabilities('video').codecs;
    tr.setCodecPreferences([...codecs.filter(c => /vp8/i.test(c.mimeType)), ...codecs.filter(c => !/vp8/i.test(c.mimeType))]);
    let queue = [];
    let timer = null;
    const flush = () => { timer = null; if (pcs.holdCandidates) return; const list = queue.splice(0, 20); if (list.length) pcs.signal('candidates', { candidates: list }); if (queue.length) timer = setTimeout(flush, 30); };
    pcs.releaseCandidates = () => { pcs.holdCandidates = false; flush(); };
    pc.onicecandidate = e => {
      if (pcs.pc !== pc) return;
      queue.push(e.candidate ? e.candidate.toJSON() : { candidate: '', sdpMid: null, sdpMLineIndex: null });
      timer ||= setTimeout(flush, 30);
    };
    pc.onconnectionstatechange = () => { if (pcs.pc === pc && pc.connectionState === 'connected') pcs.onConnected(pc); };
    const mark = (list, m) => { m.seq = ++seq; list.push(m); pcs.rec.order.push(m.t + (m.c ? `:${m.c}` : '')); };
    ch.ctl.onmessage = e => { const m = JSON.parse(e.data); mark(pcs.rec.ctl, m); pcs.onCtl(m); };
    ch.in.onmessage = e => { const m = JSON.parse(e.data); mark(pcs.rec.in, m); if (m.t === 'probe') pcs.onProbe(m); };
    ch.mv.onmessage = e => mark(pcs.rec.mv, JSON.parse(e.data));
    // (1.12.4) A picture's parts, as Beam's PC side takes them: in order, then `clip-img` on ctl once whole.
    ch.clip.onmessage = e => {
      const m = JSON.parse(e.data);
      const len = atob(m.d).length;
      mark(pcs.rec.clip, { t: m.t, n: m.n, i: m.i, of: m.of, size: m.size, len });
      if (m.i === 0) pcs.imgIn = { n: m.n, got: 0 };
      if (!pcs.imgIn || pcs.imgIn.n !== m.n) return;
      pcs.imgIn.got += len;
      if (m.i === m.of - 1) { const ok = pcs.imgIn.got === m.size; pcs.imgIn = null; pcs.send('ctl', { t: 'clip-img', n: m.n, ok }); }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    pcs.rec.offers++;
    await pcs.signal('offer', { sdp: offer.sdp });
  };

  // Its own peer check stands for the real one (it only records the pair); then the picture, hello and pings.
  pcs.onConnected = async pc => {
    if (pcs.connected) return;
    pcs.connected = true;
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
    pcs.rec.peer.push(pair ? stats.get(pair.remoteCandidateId)?.address || '' : null);
    await pcs.tr.sender.replaceTrack(pcs.track);
    // (ICE can say connected before the data channels are open)
    const ready = () => {
      if (pcs.pc !== pc) return;
      if (pcs.hello) pcs.sendHello();
      let n = 0;
      clearInterval(pcs.pingTimer);
      pcs.pingTimer = setInterval(() => pcs.send('ctl', { t: 'ping', n: ++n, at: Date.now() }), 2000);
    };
    if (pcs.ch.ctl.readyState === 'open') ready();
    else pcs.ch.ctl.addEventListener('open', ready, { once: true });
  };
  pcs.cursor = null; // (1.6.1: where its cursor is, in its hello)
  // (1.8: a PC that fits its screen to the viewer and takes the picture's settings says so)
  pcs.sendHello = () => pcs.send('ctl', { t: 'hello', v: 1, role: 'host', name: cfg.name, monitors: pcs.monitors, monitor: pcs.monitor, codec: 'VP8', encoder: 'libvpx', ...(pcs.cursor && { cursor: pcs.cursor }),
    ...(cfg.caps && { caps: cfg.caps, fitted: false }) });

  pcs.onSignal = async d => {
    const pc = pcs.pc;
    if (!pc) return;
    if (d.kind === 'answer') { pcs.rec.answers++; await pc.setRemoteDescription({ type: 'answer', sdp: d.sdp }); }
    else if (d.kind === 'candidates') {
      for (const c of d.candidates) {
        if (c.candidate === '') { pc.addIceCandidate(c).catch(() => {}); continue; }
        const p = c.candidate.split(' ');
        if (p[2].toLowerCase() !== 'udp' || p[7] !== 'host') continue;
        if (pcs.viewerIp) p[4] = pcs.viewerIp; // (the strict rewrite, to where this test's viewer really is)
        pc.addIceCandidate({ ...c, candidate: p.join(' ') }).catch(() => {});
      }
    } else if (d.kind === 'restart') {
      pcs.rec.restarts = (pcs.rec.restarts || 0) + 1;
      pc.restartIce();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      pcs.rec.offers++;
      await pcs.signal('offer', { sdp: offer.sdp });
    }
  };

  // (1.12.6) A delay probe, as Beam's PC side answers it: `on` shows the square (magenta), each probe after turns it,
  // `off` takes it away; the answer says the colour and the PC's own time (made up here: 1.5 ms).
  pcs.probeColor = null;
  pcs.probeCap = null; // (1.15) its own capture's time for each probe, when a test makes one up (a Windows app 1.15 says)
  pcs.onProbe = m => {
    if (m.off) { pcs.probeColor = null; return; }
    pcs.probeColor = m.on ? 'magenta' : pcs.probeColor === 'magenta' ? 'green' : 'magenta';
    pcs.send('ctl', { t: 'probe', n: m.n, color: pcs.probeColor, ms: 1.5, x: 0, y: 0, size: 32 });
    if (pcs.probeCap != null && !m.on) pcs.send('ctl', { t: 'probe-cap', n: m.n, ms: pcs.probeCap });
  };

  pcs.onCtl = m => {
    if (m.t === 'ping') pcs.send('ctl', { t: 'pong', n: m.n, at: m.at });
    else if (m.t === 'quality') pcs.send('ctl', { t: 'quality', mode: m.mode, maxFps: m.mode === 'motion' ? 60 : 30, maxKbps: m.mode === 'motion' ? 16000 : 8000 });
    else if (m.t === 'settings') pcs.send('ctl', { t: 'quality', mode: m.mode === 'motion' ? 'motion' : 'text', profile: m.mode === 'auto' ? 'text' : m.mode, auto: m.mode === 'auto', maxFps: m.fps || 30, maxKbps: m.kbps || 15000 });
    else if (m.t === 'fit') {
      // (1.8) Its screen becomes 1920×1080 at 125% while fitted, and is as it was after.
      pcs.monitors = m.on ? cfg.monitors.map(x => (x.id === pcs.monitor ? { ...x, w: 1920, h: 1080, scale: 1.25 } : x)) : cfg.monitors;
      pcs.send('ctl', { t: 'display', monitors: pcs.monitors, monitor: pcs.monitor, fitted: m.on === true });
    }
    else if (m.t === 'monitor' && pcs.monitors.some(x => x.id === m.id)) { pcs.monitor = m.id; pcs.connect(); }
    else if (m.t === 'lock') pcs.end('locked');
  };
}

// A PC (Beam 1.6 for Windows, remote control on) on its own "machine"; `online`: its app's stream is open.
async function fakePc(ctx, { name = `Desk ${ctx.uid()}`, ip = ctx.nextIp(), status = { remoteControl: true, locked: false }, online = true, version = '1.6.0', viewerIp = TS4, monitors = MONITORS, scene = '', caps = null } = {}) {
  const id = `pc${ctx.uid()}${ctx.uid()}`.slice(0, 18);
  const page = await ctx.browser.newPage({ xff: ip });
  await page.goto(`${ctx.srv.base}/manifest.webmanifest`);
  await page.evaluate(`(${fakePcMain})(${JSON.stringify({ id, name, key: ctx.srv.key, version, viewerIp, monitors, scene, caps })}); true`);
  await page.evaluate(`fetch('/api/me', { headers: fakePc.headers }).then(r => r.status)`);
  if (status) eq(await page.evaluate(`fakePc.status(${JSON.stringify(status)})`), 204, 'the PC reports its switch');
  if (online) eq(await page.evaluate('fakePc.open()'), 200, 'the PC’s app stream');
  ctx.defer(async () => { await page.evaluate('fakePc.offline(); fakePc.end && fakePc.end(); true').catch(() => {}); });
  return { id, name, ip, page, js: expr => page.evaluate(expr) };
}

// The viewer's 201 says the PC is at `ip` (the server attested the PC's fake X-Forwarded-For address).
async function attestAs(page, ip) {
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/rc/sessions', requestStage: 'Response' }] });
  page.on(async m => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request, responseStatusCode, responseHeaders = [] } = m.params;
    if (request.method !== 'POST' || responseStatusCode !== 201) return page.send('Fetch.continueRequest', { requestId }).catch(() => {});
    const { body, base64Encoded } = await page.send('Fetch.getResponseBody', { requestId });
    const json = JSON.parse(base64Encoded ? Buffer.from(body, 'base64').toString() : body);
    json.host.ip4 = ip;
    json.host.ip6 = null;
    const headers = responseHeaders.filter(h => !/^(content-length|content-encoding)$/i.test(h.name));
    await page.send('Fetch.fulfillRequest', { requestId, responseCode: 201, responseHeaders: headers, body: Buffer.from(JSON.stringify(json)).toString('base64') }).catch(() => {});
  });
}

// A signed-in browser opening the viewer for `pcId` (attested at this machine's Tailscale address unless told).
async function viewer(ctx, pcId, { attest = TS4, page, mobile = false } = {}) {
  page ||= await ctx.signedIn(mobile ? { width: 412, height: 860, mobile: true } : {});
  if (attest) await attestAs(page, attest);
  await page.goto('about:blank');
  await page.goto(`${ctx.srv.base}/#remote=${pcId}`);
  return page;
}

// Live: both checks passed and the picture is on. On a timeout, what each side knew (for the log).
const live = (page, pc) => waitRc(page, pc, `rc.state === 'live' && rc.verified && rc.frames && Boolean(rc.hostHello)`, 20000, 'live');
async function waitRc(page, pc, expr, ms, label) {
  try {
    return await page.waitFor(expr, ms, label);
  } catch (err) {
    const v = await page.evaluate(`JSON.stringify({ state: rc.state, step: rc.step, end: rc.end?.reason, endText: rc.end?.text, verified: rc.verified, frames: rc.frames, hello: Boolean(rc.hostHello),
      pair: rc.pair, added: rc.added, conn: rc.pc?.connectionState, ice: rc.pc?.iceConnectionState, origin: rc.origin, ufrag: rc.ufrag, pending: rc.pending.length, switching: rc.switching, monitor: rc.monitor, session: rc.session?.id, stream: rc.stream?.open })`).catch(e => e.message);
    const p = pc ? await pc.js(`JSON.stringify({ connected: fakePc.connected, peer: fakePc.rec.peer, offers: fakePc.rec.offers, answers: fakePc.rec.answers, events: fakePc.rec.events.slice(-6), conn: fakePc.pc?.connectionState })`).catch(e => e.message) : '';
    throw new Error(`${err.message}\n viewer: ${v}\n pc: ${p}`);
  }
}
const rec = (pc, what) => pc.js(`fakePc.rec.${what}`);
// The video's rectangle in the window, and a point at fractions of it.
const at = async (page, fx, fy) => page.evaluate(`(r => ({ x: r.left + r.width * ${fx}, y: r.top + r.height * ${fy} }))(rcUi.video.getBoundingClientRect())`);
const mouse = (page, type, p, extra = {}) => page.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, ...extra });
const key = async (page, code, k = code, extra = {}) => {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: k, ...extra });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: k, ...extra });
};

export default function register(test) {
  // Screenshots of the viewer (only with --shots; the fake PC's canvas, never a real screen).
  if (process.argv.includes('--shots') && TS4) {
    test('screenshots: the remote control viewer', async ctx => {
      const { default: path } = await import('node:path');
      const shot = (page, name) => page.screenshot(path.join(ctx.SHOTS, `${name}.png`));
      const pc = await fakePc(ctx, { name: 'Desktop' });
      const page = await viewer(ctx, pc.id);
      await live(page, pc);
      await page.waitFor(`/fps/.test(rcUi.chip.textContent)`, 8000, 'the chip');
      await shot(page, 'remote-desktop-live');
      await page.evaluate(`document.querySelector('.rc-tool[data-tool="keyboard"]').click(); true`);
      await sleep(200);
      await shot(page, 'remote-desktop-keys');
      await page.evaluate(`rcClosePop(); document.querySelector('.rc-tool.danger').click(); true`);
      await sleep(300);
      await shot(page, 'remote-desktop-ended');
      // A phone (a made-up desktop on the PC's side): how to, trackpad, zoomed, a hold, More, sideways, touch mode.
      const pc2 = await fakePc(ctx, { name: 'Desktop', scene: 'desktop' });
      await pc2.js('fakePc.cursor = { x: 1500, y: 600 }; true');
      const phone = await viewer(ctx, pc2.id, { mobile: true });
      await live(phone, pc2);
      await phone.waitFor('!rcUi.help.hidden', 5000, 'how to');
      await sleep(500);
      await shot(phone, 'remote-phone-help');
      await phone.evaluate(`rcUi.help.querySelector('.btn.primary').click(); true`);
      await sleep(200);
      await shot(phone, 'remote-phone-live');
      const touch = touchOf(phone);
      const c = await at(phone, 0.5, 0.5);
      await touch('touchStart', [{ x: c.x - 30, y: c.y }, { x: c.x + 30, y: c.y }]);
      for (let i = 1; i <= 10; i++) { await touch('touchMove', [{ x: c.x - 30 - i * 14, y: c.y }, { x: c.x + 30 + i * 14, y: c.y }]); await sleep(16); }
      await touch('touchEnd', []);
      await sleep(300);
      await shot(phone, 'remote-phone-zoomed');
      await touch('touchStart', [c]);
      await sleep(650);
      await shot(phone, 'remote-phone-hold');
      await touch('touchEnd', []);
      await sleep(600);
      await phone.evaluate(`document.querySelector('.rc-tool[data-tool="more"]').click(); true`);
      await sleep(300);
      await shot(phone, 'remote-phone-more');
      await phone.evaluate(`closeMenu(); true`);
      await phone.viewport(860, 412, true);
      await sleep(400);
      await shot(phone, 'remote-phone-landscape');
      await phone.evaluate(`rcShowKeyboard(); true`);
      await phone.viewport(860, 230, true);
      await sleep(400);
      await shot(phone, 'remote-phone-landscape-keyboard');
      await phone.evaluate(`rcUi.sink.blur(); true`);
      await phone.viewport(412, 860, true);
      await sleep(300);
      await phone.evaluate(`document.querySelector('.rc-tool[data-tool="pointer"]').click(); true`);
      await sleep(400);
      await shot(phone, 'remote-phone-touch-help');
      await phone.evaluate(`rcUi.help.querySelector('.btn.primary').click(); true`);
      await pc2.js(`fakePc.send('ctl', { t: 'state', locked: false, secure: true, elevated: false })`);
      await sleep(300);
      await shot(phone, 'remote-phone-secure');
    }, { requires: FEATURE, timeout: 90000 });
  }

  test('remote control: the viewer’s states before a connection (unknown, switched off, locked, offline, busy, itself, signed out)', async ctx => {
    const page = await ctx.signedIn();
    const meId = await page.evaluate('me.id');
    const open = async id => { await page.goto('about:blank'); await page.goto(`${ctx.srv.base}/#remote=${id}`); };
    const ended = () => page.waitFor(`rc.state === 'ended' && rc.end ? [rc.end.reason, document.querySelector('.rc-card').textContent] : rc.state + ': ' + rc.step`, 15000, 'ended');
    await open('nosuchdevice42');
    eq((await ended())[0], 'unknown', 'a device Beam doesn’t know');
    eq(await page.evaluate(`getComputedStyle($('#app')).display`), 'none', 'none of the chat app shows');
    const off = await fakePc(ctx, { status: { remoteControl: false, locked: false } });
    await open(off.id);
    let [reason, text] = await ended();
    eq(reason, 'not-allowed', 'switched off on the PC');
    assert(text.includes(`Remote control is off on ${off.name}`) && text.includes('Allow remote control') && text.includes('Reconnect'), `says how to turn it on there: ${text}`);
    const locked = await fakePc(ctx, { status: { remoteControl: true, locked: true } });
    await open(locked.id);
    [reason, text] = await ended();
    eq(reason, 'locked', 'locked');
    assert(text.includes(`${locked.name} is locked: use Remote Desktop`), `the locked text: ${text}`);
    const away = await fakePc(ctx, { online: false });
    await open(away.id);
    eq((await ended())[0], 'offline', 'its app isn’t connected');
    // Another device already controls it.
    const pc = await fakePc(ctx);
    await pc.js('fakePc.offer = false; true');
    const other = dev(ctx, `Other ${ctx.uid()}`, 'web');
    await other.me();
    const r = await fetch(`${ctx.srv.base}/api/rc/sessions`, { method: 'POST', headers: { ...other.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ device: pc.id }) });
    eq(r.status, 201, 'another device started a session');
    await open(pc.id);
    [reason, text] = await ended();
    eq(reason, 'busy', 'busy');
    assert(/being controlled from/i.test(text), `who has it: ${text}`);
    await open(meId);
    eq((await ended())[0], 'self', 'not itself');
    // A browser that isn't signed in.
    const out = await ctx.browser.newPage({ xff: ctx.nextIp() });
    await out.goto(`${ctx.srv.base}/#remote=${pc.id}`);
    await out.waitFor(`rc.state === 'ended' && rc.end.reason === 'signed-out' && document.querySelector('.rc-card a.btn')?.textContent === 'Open Beam'`, 15000, 'signed out: Open Beam');
    // (the harness itself sets beam.notifyOffered on every page)
    eq(await out.evaluate(`[Object.keys(localStorage).filter(k => k !== 'beam.notifyOffered'), /beam_device/.test(document.cookie)]`), [[], false], 'remote mode wrote no identity (nothing stored)');
    eq(page.errors.concat(out.errors), [], 'no page errors');
  }, { requires: FEATURE });

  test('remote control: the strict rewrite keeps only the PC’s attested Tailscale addresses (same port), and the offer’s own candidates go through it too', async ctx => {
    const page = await ctx.signedIn();
    await page.goto('about:blank');
    await page.goto(`${ctx.srv.base}/#remote=nosuchdevice43`);
    await page.waitFor(`rc.state === 'ended'`, 15000, 'remote mode');
    const host = { ip4: '100.101.102.103', ip6: 'fd7a:115c:a1e0::abcd' };
    const cases = {
      mdns: 'candidate:1 1 udp 2122260223 4bd2e6f4-1e0b-44a1-8a2c-6f3e4d1a2b3c.local 54400 typ host generation 0 ufrag abcd network-cost 999',
      lan4: 'candidate:2 1 udp 2122194687 192.168.1.32 54401 typ host generation 0',
      lan6: 'candidate:3 1 udp 2122129151 2001:db8::5 54402 typ host generation 0',
      otherTs: 'candidate:4 1 udp 2122063615 100.64.0.9 54403 typ host generation 0',
      attested: 'candidate:5 1 udp 2122063615 100.101.102.103 54404 typ host generation 0',
      tcp: 'candidate:6 1 tcp 1518280447 192.168.1.32 9 typ host tcptype active generation 0',
      srflx: 'candidate:7 1 udp 1686052607 203.0.113.9 54405 typ srflx raddr 192.168.1.32 rport 54401 generation 0',
      relay: 'candidate:8 1 udp 41885439 198.51.100.4 3478 typ relay raddr 0.0.0.0 rport 0 generation 0',
      junk: 'candidate:9 1 udp nonsense',
      badPort: 'candidate:10 1 udp 2122260223 192.168.1.32 70000 typ host generation 0',
    };
    const out = await page.evaluate(`(() => {
      const host = ${JSON.stringify(host)};
      const cases = ${JSON.stringify(cases)};
      const r = {};
      for (const [k, c] of Object.entries(cases)) r[k] = rcRewrite({ candidate: c, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' }, host).map(x => x.candidate.split(' ').slice(4, 6).join(' '));
      r.end = rcRewrite({ candidate: '', sdpMid: '0', sdpMLineIndex: 0 }, host);
      r.v4only = rcRewrite({ candidate: ${JSON.stringify(cases.mdns)}, sdpMid: '0', sdpMLineIndex: 0 }, { ip4: '100.101.102.103', ip6: null }).length;
      r.notTailscale = rcRewrite({ candidate: ${JSON.stringify(cases.mdns)}, sdpMid: '0', sdpMLineIndex: 0 }, { ip4: '192.168.1.5', ip6: null }).length;
      return r;
    })()`);
    eq(out.mdns, ['100.101.102.103 54400', 'fd7a:115c:a1e0::abcd 54400'], 'a .local name: both attested addresses, same port');
    eq(out.lan4, ['100.101.102.103 54401'], 'a LAN IPv4: the attested IPv4');
    eq(out.lan6, ['fd7a:115c:a1e0::abcd 54402'], 'an IPv6: the attested IPv6');
    eq(out.otherTs, ['100.101.102.103 54403'], 'another Tailscale address: the attested one, not that');
    eq(out.attested, ['100.101.102.103 54404'], 'already the attested address');
    for (const k of ['tcp', 'srflx', 'relay', 'junk', 'badPort']) eq(out[k], [], `dropped: ${k}`);
    eq(out.end, [{ candidate: '', sdpMid: '0', sdpMLineIndex: 0 }], 'the end of candidates passes');
    eq([out.v4only, out.notTailscale], [1, 0], 'only attested Tailscale addresses are ever used');
    const sdp = ['v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'c=IN IP4 0.0.0.0',
      `a=${cases.lan4}`, 'a=mid:0', `a=${cases.tcp}`, 'a=end-of-candidates', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=mid:1', `a=${cases.mdns}`, ''].join('\r\n');
    const stripped = await page.evaluate(`(s => { const r = rcStripCandidates(s); return { left: r.sdp.split('\\r\\n').filter(l => /candidate/.test(l)).length, mids: r.candidates.map(c => [c.sdpMid, c.sdpMLineIndex]), origin: rcOrigin(s) }; })(${JSON.stringify(sdp)})`);
    eq(stripped, { left: 0, mids: [['0', 0], ['0', 0], ['1', 1]], origin: '4611731400430051336' }, 'the offer’s candidates come out (with their mid), and its o= id');
    eq(await page.evaluate(`[rcNormIp('FD7A:115C:A1E0:0:0:0:0:ABCD') === rcNormIp('fd7a:115c:a1e0::abcd'), rcIsTailscale('100.63.1.1'), rcIsTailscale('100.128.0.1'), rcIsTailscale('100.64.0.1'), rcIsTailscale('fd7a:115c:a1e0::1')]`),
      [true, false, false, true, true], 'IPv6 compared however written; the Tailscale ranges');
  }, { requires: FEATURE });

  if (!TS4) return;

  test('remote control: a live session (strict rewrite, peer check, hello both ways); input mapping, coalescing, keys, the Keys menu, release; quality; Disconnect and Reconnect', async ctx => {
    const pc = await fakePc(ctx);
    const page = await viewer(ctx, pc.id);
    await live(page, pc);
    eq(await page.evaluate('[rc.pair.remote, [...new Set(rc.added.map(a => a.split(":").slice(0, -1).join(":")))]]'), [TS4, [TS4]], 'connected to the attested address only');
    const hello = (await rec(pc, 'ctl')).find(m => m.t === 'hello');
    eq([hello?.role, hello?.v, hello?.caps], ['viewer', 1, ['clip', 'text', 'clipimg', 'cursor']], 'the viewer’s hello (1.12.4: it takes pictures; 1.12.6: with a mouse, it can draw the PC’s pointer)');
    eq((await rec(pc, 'ctl')).find(m => m.t === 'quality')?.mode, 'text', 'Sharp text asked for');
    await page.waitFor(`/fps/.test(rcUi.chip.textContent) && rcUi.chip.title.includes('libvpx')`, 8000, 'the quality chip (and the PC’s encoder)');
    eq(await page.evaluate(`[rc.monitors.length, rc.monitor, document.title]`), [2, 0, `${pc.name} · Beam`], 'its screens; the title');
    // Moves: physical pixels of monitor 0 (2560×1440, whatever the picture's size), one per frame.
    const p = await at(page, 0.25, 0.5);
    await mouse(page, 'mouseMoved', p);
    await pc.page.waitFor(`fakePc.rec.mv.length >= 1`, 5000, 'a move');
    eq((await rec(pc, 'mv')).at(-1), { t: 'mv', n: 1, x: 640, y: 720, m: 0, seq: (await rec(pc, 'mv')).at(-1).seq }, 'a move in the monitor’s own pixels');
    await page.evaluate(`(() => { const r = rcUi.video.getBoundingClientRect(); for (let i = 1; i <= 50; i++) rcUi.stage.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: r.left + r.width * i / 100, clientY: r.top + r.height * 0.75, bubbles: true })); return true; })()`);
    await sleep(400);
    const mv = await rec(pc, 'mv');
    eq([mv.length, mv.at(-1).x, mv.at(-1).y, mv.at(-1).n], [2, 1280, 1080, 2], '50 moves in one frame: one message, the last position');
    // A click carries its own position and the last move's number.
    const q = await at(page, 0.5, 0.25);
    await mouse(page, 'mouseMoved', q);
    await mouse(page, 'mousePressed', q, { button: 'left', buttons: 1, clickCount: 1 });
    await mouse(page, 'mouseReleased', q, { button: 'left', buttons: 0, clickCount: 1 });
    await pc.page.waitFor(`fakePc.rec.in.filter(m => m.t === 'btn').length >= 2`, 5000, 'the click');
    const btns = (await rec(pc, 'in')).filter(m => m.t === 'btn').map(({ seq, ...m }) => m);
    // (`n`: the last move sent before it, here the one to this very point, sent first)
    await pc.page.waitFor(`fakePc.rec.mv.some(m => m.n === ${btns[0].n} && m.x === 1280 && m.y === 360)`, 5000, 'the move it names');
    const n = btns[0]?.n;
    assert(n >= 3, `n names a move to the click’s point (${n})`);
    eq(btns, [{ t: 'btn', b: 0, d: true, x: 1280, y: 360, m: 0, n }, { t: 'btn', b: 0, d: false, x: 1280, y: 360, m: 0, n }], 'left down/up where it is');
    await mouse(page, 'mousePressed', q, { button: 'right', buttons: 2, clickCount: 1 });
    await mouse(page, 'mouseReleased', q, { button: 'right', buttons: 0, clickCount: 1 });
    await pc.page.waitFor(`fakePc.rec.in.filter(m => m.t === 'btn' && m.b === 2).length === 2`, 5000, 'the right button');
    // Wheel: 120 a notch, dy > 0 = down.
    await mouse(page, 'mouseWheel', q, { deltaX: 0, deltaY: 100 });
    await pc.page.waitFor(`fakePc.rec.in.some(m => m.t === 'wheel')`, 5000, 'the wheel');
    const wheel = (await rec(pc, 'in')).find(m => m.t === 'wheel');
    eq([wheel.dx, wheel.dy, wheel.x, wheel.y, wheel.m, typeof wheel.n], [0, 120, 1280, 360, 0, 'number'], 'one notch down, where the pointer is');
    // Keys by code, kept from the browser (Tab doesn't move the focus, F5 doesn't reload).
    eq(await page.evaluate('document.activeElement === rcUi.sink'), true, 'the keys go to the PC');
    await key(page, 'KeyA', 'a');
    await key(page, 'Tab', 'Tab');
    await key(page, 'F5', 'F5');
    await pc.page.waitFor(`fakePc.rec.in.filter(m => m.t === 'key').length >= 6`, 5000, 'keys');
    eq((await rec(pc, 'in')).filter(m => m.t === 'key').map(m => `${m.c}${m.d ? '↓' : '↑'}`), ['KeyA↓', 'KeyA↑', 'Tab↓', 'Tab↑', 'F5↓', 'F5↑'], 'KeyboardEvent.code, down and up');
    eq(await page.evaluate('[document.activeElement === rcUi.sink, rc.state]'), [true, 'live'], 'the page kept the focus and wasn’t reloaded');
    // The Keys menu: Alt+Tab pressed in order, let go in reverse; Ctrl+Alt+Del can't be sent.
    await page.evaluate(`document.querySelector('.rc-tool[data-tool="keyboard"]').click(); true`);
    await page.waitFor(`Boolean(rcUi.pop)`, 3000, 'the Keys menu');
    eq(await page.evaluate(`[...rcUi.pop.querySelectorAll('.menu-item')].map(b => [b.textContent, b.disabled])`), [['Windows key', false], ['Alt+Tab', false], ['Ctrl+Esc', false], ['Ctrl+Shift+Esc', false], ['Print Screen', false], ['Lock this PC', false], ['Ctrl+Alt+Delneeds Remote Desktop', true]], 'the Keys menu');
    await page.evaluate(`[...rcUi.pop.querySelectorAll('.menu-item')].find(b => b.textContent === 'Alt+Tab').click(); true`);
    await pc.page.waitFor(`fakePc.rec.in.filter(m => m.t === 'key').length >= 10`, 5000, 'Alt+Tab');
    eq((await rec(pc, 'in')).filter(m => m.t === 'key').slice(6).map(m => `${m.c}${m.d ? '↓' : '↑'}`), ['AltLeft↓', 'Tab↓', 'Tab↑', 'AltLeft↑'], 'Alt+Tab');
    // Release: on blur, and when the page is hidden.
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'ShiftLeft', key: 'Shift' });
    await page.evaluate(`window.dispatchEvent(new Event('blur')); true`);
    await pc.page.waitFor(`fakePc.rec.in.some(m => m.t === 'release')`, 5000, 'release on blur');
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'ShiftLeft', key: 'Shift' });
    const releases = (await rec(pc, 'in')).filter(m => m.t === 'release').length;
    await ctx.setHidden(page, true);
    await pc.page.waitFor(`fakePc.rec.in.filter(m => m.t === 'release').length > ${releases}`, 5000, 'release when hidden');
    await ctx.setHidden(page, false);
    eq((await rec(pc, 'in')).filter(m => m.t === 'key' && m.c === 'ShiftLeft').map(m => m.d), [true], 'a key let go of while away isn’t sent up again');
    // Smooth motion (a PC before 1.8: Picture offers its two modes, and nothing else goes): asked for, and the PC says
    // what it applied.
    await page.evaluate(`document.querySelector('.rc-tool[data-tool="gear"]').click(); true`);
    await page.waitFor(`$('#genDlg').open && document.querySelectorAll('#genBody input[name="rc-mode"]').length === 2 && !document.querySelector('#genBody select')`, 3000, 'Picture: the two modes only');
    await page.evaluate(`document.querySelector('#genBody input[value="motion"]').click(); $('#genDlg').close(); true`);
    await page.waitFor(`rc.quality === 'motion' && rc.qualityInfo?.fps === 60`, 5000, 'Smooth motion');
    assert(!(await rec(pc, 'ctl')).some(m => ['settings', 'fit', 'video'].includes(m.t)), 'nothing of 1.8 to a PC that didn’t say it does it');
    eq((await rec(pc, 'ctl')).filter(m => m.t === 'quality').map(m => Object.keys(m).filter(k => k !== 'seq').sort().join(',') + ':' + m.mode), ['mode,t:text', 'mode,t:motion'], '{ t: "quality", mode } only');
    // Pings both ways.
    await page.waitFor(`rc.rtt !== null`, 5000, 'our ping answered');
    await pc.page.waitFor(`fakePc.rec.ctl.some(m => m.t === 'pong')`, 5000, 'the PC’s ping answered');
    // Disconnect: bye and release, the session ends at the server; Reconnect starts a new one.
    const first = await page.evaluate('rc.session.id');
    await page.evaluate(`document.querySelector('.rc-tool.danger').click(); true`);
    await page.waitFor(`rc.state === 'ended' && rc.end.reason === 'disconnected'`, 5000, 'Disconnected');
    await pc.page.waitFor(`fakePc.rec.events.some(e => e.ev === 'rc-end' && e.id === '${first}')`, 5000, 'the PC heard it end');
    assert((await rec(pc, 'ctl')).some(m => m.t === 'bye'), 'bye');
    eq((await pc.js(`fakePc.api('GET', '/api/rc/sessions').then(r => r.json())`)).sessions.filter(s => s.host === pc.id), [], 'no session left');
    await page.evaluate(`[...document.querySelectorAll('.rc-card button')].find(b => b.textContent === 'Reconnect').click(); true`);
    await live(page, pc);
    assert(await page.evaluate(`rc.session.id !== '${first}'`), 'a new session');
    // Lock this PC: the PC locks and ends the session (locked).
    await page.evaluate(`document.querySelector('.rc-tool[data-tool="keyboard"]').click(); true`);
    await page.waitFor(`Boolean(rcUi.pop)`, 3000, 'the Keys menu again');
    await page.evaluate(`rcUi.pop.querySelector('[data-key="lock"]').click(); true`);
    await page.waitFor(`rc.state === 'ended' && rc.end.reason === 'locked'`, 8000, 'locked: ended');
    eq(page.errors, [], 'no page errors');
  }, { requires: FEATURE, timeout: 90000 });

  test('remote control 1.14.2: the picture’s delay from the PC’s screen to this one, measured per frame, and the lag in the chip and details; the PC says how Tailscale reaches this viewer (direct, or through a relay)', async ctx => {
    const pc = await fakePc(ctx, { caps: ['fit', 'settings', 'video'] });
    const page = await viewer(ctx, pc.id);
    await live(page, pc);
    // Measured from the frames themselves (when the PC captured each one, when it's shown here).
    await page.waitFor(`rc.stats?.picMs != null`, 10000, 'the picture’s delay');
    const pic = await page.evaluate('rc.stats.picMs');
    assert(pic >= 0 && pic < 2000, `a plausible delay (${pic} ms)`);
    await page.waitFor(`rcLag() != null && rcUi.chip.textContent.includes(rcLag() + ' ms')`, 5000, 'the lag in the chip');
    // Through Tailscale's relay (New York): the chip and the details say so; then direct, on the same network.
    eq(await pc.js(`fakePc.send('ctl', { t: 'path', via: 'relay', relay: 'nyc' })`), true, 'the PC says: relayed');
    await page.waitFor(`rc.path?.via === 'relay' && /relayed/.test(rcUi.chip.textContent)`, 5000, 'relayed: in the chip');
    await page.evaluate('rc.pic.details = true; rcRenderDetails(); true');
    await page.waitFor(`/through its relay in New York/.test(rcUi.details.textContent) && /from the PC’s screen to this one/.test(rcUi.details.textContent)`, 3000, 'the details: the relay, and the picture’s delay');
    await pc.js(`fakePc.send('ctl', { t: 'path', via: 'direct', lan: true })`);
    await page.waitFor(`rc.path?.via === 'direct' && !/relayed/.test(rcUi.chip.textContent) && /direct on the same network/.test(rcUi.details.textContent)`, 5000, 'direct, on the same network');
    // Anything else from the PC is dropped.
    await pc.js(`fakePc.send('ctl', { t: 'path', via: 'teleport', relay: '<b>x</b>' })`);
    await page.waitFor(`rc.path === null && !/Tailscale,/.test(rcUi.details.textContent)`, 3000, 'an unknown path: dropped');
    eq(page.errors, [], 'no page errors');
  }, { requires: FEATURE, timeout: 90000 });

  test('remote control 1.8: the picture’s settings (applied at once, kept per PC), fitting the PC to this screen (input waits, then maps to its new size; off puts it back), no frames while hidden, frames shown as they come', async ctx => {
    const pc = await fakePc(ctx, { caps: ['fit', 'fit-scale', 'settings', 'video'] });
    const page = await viewer(ctx, pc.id);
    await live(page, pc);
    // Right after the PC's hello: the settings (Auto) and visible; no fit (1.12.7: off until chosen), then Fit turned on.
    try {
      await pc.page.waitFor(`['settings', 'video'].every(t => fakePc.rec.ctl.some(m => m.t === t))`, 5000, 'settings, video');
      eq(await pc.js(`fakePc.rec.ctl.some(m => m.t === 'fit')`), false, 'no fit unless chosen (1.12.7)');
      await page.evaluate(`document.querySelector('.rc-tool[data-tool="gear"]').click(); true`);
      await page.waitFor(`$('#genDlg').open && [...document.querySelectorAll('#genBody label.check')].some(l => /^Fit /.test(l.textContent))`, 3000, 'Picture: the Fit switch');
      eq(await page.evaluate(`[...document.querySelectorAll('#genBody label.check')].find(l => /^Fit /.test(l.textContent)).querySelector('input').checked`), false, 'Fit off');
      await page.evaluate(`[...document.querySelectorAll('#genBody label.check')].find(l => /^Fit /.test(l.textContent)).querySelector('input').click(); $('#genDlg').close(); true`);
      await pc.page.waitFor(`fakePc.rec.ctl.some(m => m.t === 'fit')`, 5000, 'the fit, once chosen');
    } catch (err) {
      const got = await pc.js(`JSON.stringify(fakePc.rec.ctl.map(m => m.t))`);
      const v = await page.evaluate(`JSON.stringify({ caps: rc.caps, hello: rc.hostHello, verified: rc.verified, fitSent: rc.fitSent, picSent: rc.picSent, videoOff: rc.videoOff, hidden: document.hidden, stage: [rcUi.stage.clientWidth, rcUi.stage.clientHeight], fitOn: rcFitOn() })`);
      throw new Error(`${err.message}\n pc got: ${got}\n viewer: ${v}`);
    }
    const ctl = await rec(pc, 'ctl');
    const area = await page.evaluate(`[Math.round(rcUi.stage.clientWidth * devicePixelRatio), Math.round(rcUi.stage.clientHeight * devicePixelRatio), Math.round(devicePixelRatio * 1000) / 1000]`);
    const s = ctl.find(m => m.t === 'settings');
    eq([s.mode, s.size, s.fps, s.kbps, s.codec, s.net, s.vw, s.vh], ['auto', 'auto', 0, 0, 'auto', '', area[0], area[1]], 'the settings: Auto, with the picture area in physical pixels');
    const fit = ctl.find(m => m.t === 'fit');
    eq([fit.on, fit.w, fit.h, fit.dpr], [true, ...area], 'Fit the PC to this screen: this area and scaling');
    eq(fit.scale, false, '...its own scaling kept (no "Bigger text", 1.11.4)');
    eq(ctl.find(m => m.t === 'video').on, true, 'visible');
    // The PC's new sizes: input maps to them.
    await page.waitFor(`rc.fitted && !rc.fitting && rc.monitors[0].w === 1920 && rc.monitors[0].h === 1080`, 5000, 'fitted: 1920×1080');
    const p = await at(page, 0.25, 0.5);
    await mouse(page, 'mouseMoved', p);
    await pc.page.waitFor(`fakePc.rec.mv.length >= 1`, 5000, 'a move');
    const mv = (await rec(pc, 'mv')).at(-1);
    eq([mv.x, mv.y], [480, 540], 'a move in the fitted screen’s pixels');
    eq(await page.evaluate(`rc.pc.getReceivers().find(r => r.track?.kind === 'video')?.jitterBufferTarget`), 0, 'frames shown as they come (no jitter buffer target)');
    // Picture: four modes and the rest; each change goes at once.
    await page.evaluate(`document.querySelector('.rc-tool[data-tool="gear"]').click(); true`);
    await page.waitFor(`$('#genDlg').open && document.querySelectorAll('#genBody input[name="rc-mode"]').length === 4 && document.querySelectorAll('#genBody select').length === 4`, 3000, 'Picture: four modes, four lists');
    await page.evaluate(`(() => {
      document.querySelector('#genBody input[value="motion"]').click();
      const set = (label, v) => { const s = [...document.querySelectorAll('#genBody select')].find(x => x.getAttribute('aria-label') === label); s.value = v; s.dispatchEvent(new Event('change')); };
      set('Frame rate', '30'); set('Data limit', '10000'); set('Codec', 'h264');
      [...document.querySelectorAll('#genBody label.check')].find(l => /Show details/.test(l.textContent)).querySelector('input').click();
      return true; })()`);
    await pc.page.waitFor(`fakePc.rec.ctl.filter(m => m.t === 'settings').at(-1)?.codec === 'h264'`, 5000, 'the last change');
    const last = (await rec(pc, 'ctl')).filter(m => m.t === 'settings').at(-1);
    eq([last.mode, last.fps, last.kbps, last.codec], ['motion', 30, 10000, 'h264'], 'the settings, as chosen');
    await page.waitFor(`!rcUi.details.hidden && /Mode/.test(rcUi.details.textContent) && /1920×1080/.test(rcUi.details.textContent)`, 5000, 'the details (the fitted screen in them)');
    // 1.11.4: "Bigger text" asks for the PC's scaling too.
    await page.evaluate(`[...document.querySelectorAll('#genBody label.check')].find(l => /^Bigger text/.test(l.textContent)).querySelector('input').click(); true`);
    await pc.page.waitFor(`fakePc.rec.ctl.filter(m => m.t === 'fit').at(-1)?.scale === true`, 5000, 'a fit with the scaling (Bigger text)');
    // Fit off: asked for, and the PC's own sizes come back.
    await page.evaluate(`[...document.querySelectorAll('#genBody label.check')].find(l => /^Fit /.test(l.textContent)).querySelector('input').click(); $('#genDlg').close(); true`);
    await pc.page.waitFor(`fakePc.rec.ctl.some(m => m.t === 'fit' && m.on === false)`, 5000, 'fit off');
    await page.waitFor(`!rc.fitted && rc.monitors[0].w === 2560`, 5000, 'back to 2560×1440');
    // Hidden: no frames; seen again: frames.
    await ctx.setHidden(page, true);
    await pc.page.waitFor(`fakePc.rec.ctl.filter(m => m.t === 'video').at(-1)?.on === false`, 5000, 'video off while hidden');
    await ctx.setHidden(page, false);
    await pc.page.waitFor(`fakePc.rec.ctl.filter(m => m.t === 'video').at(-1)?.on === true`, 5000, 'video on again');
    // Kept for this PC on this device: the next session starts with them.
    eq(await page.evaluate(`JSON.parse(localStorage.getItem('beam.rc.pic.${pc.id}'))`), { mode: 'motion', size: 'auto', fps: 30, kbps: 10000, codec: 'h264', fitPc: false, fitScale: true, details: true, pointer: true }, 'kept for this PC');
    const n0 = (await rec(pc, 'ctl')).length;
    await page.evaluate('location.reload(); true');
    await live(page, pc);
    await pc.page.waitFor(`fakePc.rec.ctl.slice(${n0}).some(m => m.t === 'settings')`, 5000, 'the settings again');
    const next = (await rec(pc, 'ctl')).slice(n0);
    eq([next.find(m => m.t === 'settings').mode, next.find(m => m.t === 'settings').codec, next.some(m => m.t === 'fit')], ['motion', 'h264', false], 'a new session starts with them (and no fit)');
    eq(page.errors, [], 'no page errors');
  }, { requires: FEATURE, timeout: 90000 });

  test('remote control in Beam for Android: Close on the ended card leaves for Beam’s page (the app’s WebView takes window.close() and then does nothing)', async ctx => {
    const pc = await fakePc(ctx);
    const page = await ctx.signedIn({ width: 412, height: 860, mobile: true });
    const ua = await page.evaluate('navigator.userAgent');
    await page.send('Emulation.setUserAgentOverride', { userAgent: `${ua} BeamAndroid/1.6.2` });
    await viewer(ctx, pc.id, { page, mobile: true });
    await live(page, pc);
    await page.evaluate('rcDisconnect(); true');
    await page.waitFor(`rc.state === 'ended' && rc.end.reason === 'disconnected'`, 5000, 'Disconnected');
    // As that WebView does: window.close() is taken, and nothing happens after (here: noted, to check it isn't used).
    await page.evaluate(`window.close = () => sessionStorage.setItem('rcTest.closed', '1'); true`);
    await page.evaluate(`[...document.querySelectorAll('.rc-card button')].find(b => b.textContent === 'Close').click(); true`);
    await page.waitFor(`!/#remote=/.test(location.href) && typeof paired !== 'undefined'`, 8000, 'Beam’s page');
    eq(await page.evaluate(`[location.origin + location.pathname, sessionStorage.getItem('rcTest.closed')]`), [`${ctx.srv.base}/`, null], 'went to Beam’s page, without window.close()');
    await pc.page.waitFor(`fakePc.rec.events.some(e => e.ev === 'rc-end')`, 5000, 'the session ended at the PC');
  }, { requires: FEATURE, timeout: 60000 });

  test('remote control: the peer check hangs up when the connection doesn’t come from the attested address (no picture, no input sent)', async ctx => {
    const pc = await fakePc(ctx);
    // No stand-in for the attestation: the 201 names the PC's fake address, but the PC reaches the viewer from this
    // machine's real one (a peer-reflexive pair), as an impostor would.
    const page = await viewer(ctx, pc.id, { attest: '' });
    await page.waitFor(`rc.state === 'ended'`, 30000, 'ended');
    eq(await page.evaluate('[rc.end.reason, rc.verified, rcUi.video.hidden]'), ['peer', false, true], 'hung up: the peer check');
    await pc.page.waitFor('fakePc.rec.peer.length >= 1', 5000, 'the PC side did connect');
    await pc.page.waitFor(`fakePc.rec.events.some(e => e.ev === 'rc-end' && e.reason === 'failed')`, 5000, 'the session ended (failed)');
    eq([(await rec(pc, 'ctl')).filter(m => m.t !== 'pong' && m.t !== 'ping'), await rec(pc, 'in'), await rec(pc, 'mv')], [[], [], []], 'nothing sent: no hello, no input');
    assert(await page.evaluate(`document.querySelector('.rc-card').textContent.includes('didn’t go to the PC')`), 'it says why');
  }, { requires: FEATURE, timeout: 60000 });

  test('remote control: the peer check runs again as soon as the selected pair changes (a renomination to another address hangs up)', async ctx => {
    const pc = await fakePc(ctx);
    const page = await viewer(ctx, pc.id);
    await live(page, pc);
    eq(await page.evaluate('Boolean(rc.watched)'), true, 'watching the ICE transport');
    const n = (await rec(pc, 'in')).length;
    await page.evaluate(`(() => { rc.watched.getSelectedCandidatePair = () => ({ remote: { address: '100.64.9.9' }, local: {} }); rc.watched.dispatchEvent(new Event('selectedcandidatepairchange')); return true; })()`);
    eq(await page.evaluate('[rc.state, rc.end?.reason, rcUi.video.hidden]'), ['ended', 'peer', true], 'hung up at once');
    await pc.page.waitFor(`fakePc.rec.events.some(e => e.ev === 'rc-end' && e.reason === 'failed')`, 5000, 'the session ended (failed)');
    eq((await rec(pc, 'in')).slice(n).filter(m => m.t !== 'release'), [], 'nothing more sent');
    // (1.7.3) The server's log says what the viewer saw, as kinds only: never the address.
    const logged = () => ctx.srv.log.split('\n').filter(l => /stopped controlling .*: the connection went to another Tailscale IPv4 address/.test(l)).pop() || '';
    for (let i = 0; i < 30 && !logged(); i++) await sleep(100);
    assert(logged() && !logged().includes('100.64.9.9'), `logged without the address: ${logged() || ctx.srv.log.split('\n').filter(l => /the connection went to/.test(l)).join(' | ')}`);
  }, { requires: FEATURE, timeout: 60000 });

  test('remote control: a pair change to something that isn’t an address (some Android WebViews give one for a remote they won’t reveal) holds input like an unreadable one, and goes on once the attested address reads back (1.7.3)', async ctx => {
    const pc = await fakePc(ctx);
    const page = await viewer(ctx, pc.id);
    await live(page, pc);
    const setPair = addr => page.evaluate(`(() => { rc.watched.getSelectedCandidatePair = () => ({ remote: { address: ${JSON.stringify(addr)}, type: 'prflx' }, local: {} }); rc.watched.dispatchEvent(new Event('selectedcandidatepairchange')); return true; })()`);
    for (const placeholder of ['redacted-ip.invalid', '54321', '0.0.0.0', '::', 'abcd.local']) {
      await setPair(placeholder);
      await page.waitFor('rc.resolving > 0', 2000, `${placeholder}: not known yet`);
      eq(await page.evaluate('[rc.state, rcLive()]'), ['live', false], `${placeholder}: still on, input held`);
      await setPair(TS4);
      await page.waitFor('rcLive() && rc.resolving === 0', 3000, `${placeholder}: input again once the address reads back`);
    }
    eq(await page.evaluate('rc.state'), 'live', 'never hung up');
  }, { requires: FEATURE, timeout: 60000 });

  test('remote control: a pair change to an unreadable address holds input (one release); the connection has one 5 s budget for that, an attested read in between doesn’t renew it', async ctx => {
    const pc = await fakePc(ctx);
    const page = await viewer(ctx, pc.id);
    await live(page, pc);
    const releases = async () => (await rec(pc, 'in')).filter(m => m.t === 'release').length;
    const r0 = await releases();
    const setPair = addr => page.evaluate(`(() => { rc.watched.getSelectedCandidatePair = () => ({ remote: { address: ${JSON.stringify(addr)}, type: 'prflx' }, local: {} }); rc.watched.dispatchEvent(new Event('selectedcandidatepairchange')); return true; })()`);
    await setPair('');
    eq(await page.evaluate('[rcLive(), rc.resolving > 0, rc.state]'), [false, true, 'live'], 'unreadable: input held');
    await pc.page.waitFor(`fakePc.rec.in.filter(m => m.t === 'release').length === ${r0 + 1}`, 3000, 'let go of once');
    const keys = (await rec(pc, 'in')).filter(m => m.t === 'key').length;
    await key(page, 'KeyA', 'a');
    await sleep(1200);
    eq([(await rec(pc, 'in')).filter(m => m.t === 'key').length, await releases()], [keys, r0 + 1], 'no keys while held, and no second release');
    // Readable and attested again: input goes; then unreadable again: what's left of the 5 s, not 5 s more.
    await setPair(TS4);
    await page.waitFor('rcLive() && rc.resolving === 0', 3000, 'input again');
    const spent = await page.evaluate('rc.resolveSpent');
    assert(spent >= 1000 && spent < 4000, `spent ${spent} ms of the budget`);
    await key(page, 'KeyB', 'b');
    await pc.page.waitFor(`fakePc.rec.in.some(m => m.t === 'key' && m.c === 'KeyB')`, 3000, 'a key goes again');
    const t0 = Date.now();
    await setPair('');
    await page.waitFor(`rc.state === 'ended'`, 6000, 'hung up');
    const took = Date.now() - t0;
    eq(await page.evaluate('rc.end.reason'), 'peer', 'the peer check');
    assert(took < 5000 - spent + 1500, `after the rest of the budget (${took} ms, ${spent} ms spent before)`);
  }, { requires: FEATURE, timeout: 60000 });

  test('remote control: the PC’s checks come before its candidates (a peer-reflexive remote reads "" at first): the viewer waits for the address, then goes live', async ctx => {
    const pc = await fakePc(ctx);
    await pc.js('fakePc.holdCandidates = true; true');
    const page = await viewer(ctx, pc.id);
    await page.waitFor(`rc.pc?.connectionState === 'connected'`, 15000, 'connected, the PC’s candidates still held back');
    await sleep(1500);
    const waiting = await page.evaluate(`[rc.state, rc.verified, rc.pair?.remote, rc.pair?.type, rc.resolving > 0, rcUi.video.hidden]`);
    eq(waiting, ['connecting', false, '', 'prflx', true, true], 'waiting on an unreadable peer-reflexive remote: nothing shown');
    eq([(await rec(pc, 'ctl')).filter(m => m.t === 'hello'), await rec(pc, 'in'), await rec(pc, 'mv')], [[], [], []], 'and nothing sent');
    const sid = await page.evaluate('rc.session.id');
    await pc.js('fakePc.releaseCandidates(); true');
    await live(page, pc);
    eq(await page.evaluate('[rc.pair.remote, rc.resolving, rc.end, rc.session.id]'), [TS4, 0, null, sid], 'the PC’s own candidate took its place: the attested address, live, the same session');
    // (the PC said hello after its own check, before ours passed: kept and read then, not lost)
    eq(await pc.js('fakePc.rec.offers'), 1, 'one connection, no retry');
    eq(page.errors, [], 'no page errors');
  }, { requires: FEATURE, timeout: 60000 });

  test('remote control: a peer-reflexive remote that stays unreadable for 5 s is hung up on (nothing shown or sent)', async ctx => {
    const pc = await fakePc(ctx);
    await pc.js('fakePc.holdCandidates = true; true');
    const page = await viewer(ctx, pc.id);
    await page.waitFor(`rc.pc?.connectionState === 'connected' && rc.resolving > 0`, 15000, 'connected, waiting on the address');
    const t0 = await page.evaluate('rc.resolving');
    await page.waitFor(`rc.state === 'ended'`, 9000, 'hung up');
    const [reason, waited, hidden] = await page.evaluate(`[rc.end.reason, Date.now() - ${t0}, rcUi.video.hidden]`);
    eq([reason, hidden], ['peer', true], 'hung up: the peer check');
    assert(waited >= 4800, `after about 5 s (${waited} ms)`);
    await pc.page.waitFor(`fakePc.rec.events.some(e => e.ev === 'rc-end' && e.reason === 'failed')`, 5000, 'the session ended (failed)');
    eq([(await rec(pc, 'ctl')).filter(m => m.t === 'hello'), await rec(pc, 'in'), await rec(pc, 'mv')], [[], [], []], 'nothing sent');
  }, { requires: FEATURE, timeout: 60000 });

  test('remote control: "Still there?" goes on across a reconnect (only real input stops it) and ends the session; a failure while it shows starts no new session', async ctx => {
    const pc = await fakePc(ctx);
    const page = await viewer(ctx, pc.id);
    await live(page, pc);
    await page.evaluate('RC_IDLE.desktop = 1000; RC_IDLE.warn = 9000; true');
    await page.waitFor('Boolean(rc.idleWarn)', 6000, 'Still there?');
    const [until, last] = await page.evaluate('[rc.idleWarn.until, rc.lastInput]');
    // The connection drops and comes back on its own (restart, the PC offers again): the countdown goes on.
    await page.evaluate(`(() => { Object.defineProperty(rc.pc, 'connectionState', { configurable: true, get: () => 'disconnected' }); rc.pc.dispatchEvent(new Event('connectionstatechange')); return true; })()`);
    await pc.page.waitFor('fakePc.rec.restarts === 1 && fakePc.rec.answers === 2', 8000, 'restarted');
    await page.evaluate(`(() => { delete rc.pc.connectionState; rc.pc.dispatchEvent(new Event('connectionstatechange')); return true; })()`);
    await page.waitFor(`rc.state === 'live'`, 5000, 'live again');
    eq(await page.evaluate('[rc.idleWarn?.until, rc.lastInput, /Still there/.test(document.querySelector(".rc-card").textContent)]'), [until, last, true], 'the same countdown, still showing, no input counted');
    // No input: it ends when the countdown does.
    await page.waitFor(`rc.state === 'ended'`, 9000, 'ended');
    eq(await page.evaluate('rc.end.reason'), 'idle', 'ended: idle');
    assert(await page.evaluate('Date.now()') >= until, 'not before the countdown ran out');
    await pc.page.waitFor(`fakePc.rec.ctl.some(m => m.t === 'bye' && m.reason === 'idle')`, 5000, 'bye (idle)');
    // Reconnect (a click: input), then a failure while "Still there?" shows: no new session by itself.
    await page.evaluate(`[...document.querySelectorAll('.rc-card button')].find(b => b.textContent === 'Reconnect').click(); true`);
    await live(page, pc);
    await page.evaluate('RC_IDLE.desktop = 1000; RC_IDLE.warn = 20000; true');
    await page.waitFor('Boolean(rc.idleWarn)', 6000, 'Still there? again');
    const requests = (await rec(pc, 'events')).filter(e => e.ev === 'rc-request').length;
    await pc.js(`fakePc.send('ctl', { t: 'bye', reason: 'stopped' }); fakePc.closePeer(); true`);
    await page.waitFor(`rc.state === 'ended'`, 10000, 'ended');
    await sleep(2500);
    eq([await page.evaluate('[rc.state, rc.end.reason]'), (await rec(pc, 'events')).filter(e => e.ev === 'rc-request').length], [['ended', 'idle'], requests], 'ended, and no new session');
    eq(page.errors, [], 'no page errors');
  }, { requires: FEATURE, timeout: 90000 });

  test('remote control: full screen takes the keyboard only while input goes to the PC; the clipboard opt-in is per session', async ctx => {
    const pc = await fakePc(ctx);
    const page = await viewer(ctx, pc.id);
    await live(page, pc);
    // (the Keyboard Lock API and full screen, watched)
    await page.evaluate(`(() => {
      window.__kb = [];
      const kb = { lock: () => { __kb.push('lock'); return Promise.resolve(); }, unlock: () => { __kb.push('unlock'); } };
      Object.defineProperty(navigator, 'keyboard', { configurable: true, get: () => kb });
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => rcUi.root });
      document.dispatchEvent(new Event('fullscreenchange'));
      return true;
    })()`);
    eq(await page.evaluate('__kb'), ['lock'], 'full screen and live: the keyboard is taken');
    await pc.js(`fakePc.send('ctl', { t: 'state', locked: false, secure: true, elevated: false })`);
    await page.waitFor('__kb.length === 2', 5000, 'a security prompt');
    await pc.js(`fakePc.send('ctl', { t: 'state', locked: false, secure: false, elevated: false })`);
    await page.waitFor('__kb.length === 3', 5000, 'back');
    await page.evaluate(`(() => { Object.defineProperty(rc.pc, 'connectionState', { configurable: true, get: () => 'disconnected' }); rc.pc.dispatchEvent(new Event('connectionstatechange')); return true; })()`);
    await page.waitFor('__kb.length === 4', 5000, 'reconnecting');
    await page.evaluate(`(() => { delete rc.pc.connectionState; rc.pc.dispatchEvent(new Event('connectionstatechange')); return true; })()`);
    await page.waitFor(`rc.state === 'live' && __kb.length === 5`, 5000, 'live again');
    await page.evaluate(`(() => { delete document.fullscreenElement; document.dispatchEvent(new Event('fullscreenchange')); return true; })()`);
    eq(await page.evaluate('__kb'), ['lock', 'unlock', 'lock', 'unlock', 'lock', 'unlock'], 'let go of at a security prompt, while reconnecting and out of full screen; taken again when live');
    // The clipboard: on in this session; the next session starts with it off (nothing sent until turned on again).
    await page.evaluate(`document.querySelector('.rc-tool[data-tool="clip"]').click(); true`);
    await pc.page.waitFor(`fakePc.rec.ctl.some(m => m.t === 'clip' && m.on === true)`, 5000, 'on');
    await page.evaluate(`document.querySelector('.rc-tool.danger').click(); true`);
    await page.waitFor(`rc.state === 'ended'`, 5000, 'disconnected');
    const clips = (await rec(pc, 'ctl')).filter(m => m.t === 'clip').length;
    await page.evaluate(`[...document.querySelectorAll('.rc-card button')].find(b => b.textContent === 'Reconnect').click(); true`);
    await live(page, pc);
    await sleep(500);
    eq([await page.evaluate(`[rc.clip, document.querySelector('.rc-tool[data-tool="clip"]').getAttribute('aria-pressed')]`), (await rec(pc, 'ctl')).filter(m => m.t === 'clip').length], [[false, 'false'], clips], 'off in the new session, nothing sent');
    eq(page.errors, [], 'no page errors');
  }, { requires: FEATURE, timeout: 90000 });

  test('remote control: reconnecting (disconnected 3 s: restart, the PC offers again on the same connection), a new session when it failed, another screen (a new connection)', async ctx => {
    const pc = await fakePc(ctx);
    const page = await viewer(ctx, pc.id);
    await live(page, pc);
    // Disconnected (as the browser would say): input let go of at once, a restart after 3 s, then live again.
    await page.evaluate(`(() => { Object.defineProperty(rc.pc, 'connectionState', { configurable: true, get: () => 'disconnected' }); Object.defineProperty(rc.pc, 'iceConnectionState', { configurable: true, get: () => 'disconnected' }); rc.pc.dispatchEvent(new Event('connectionstatechange')); return true; })()`);
    eq(await page.evaluate('rc.state'), 'reconnecting', 'Reconnecting');
    await pc.page.waitFor(`fakePc.rec.in.some(m => m.t === 'release')`, 3000, 'released at once');
    const t0 = Date.now();
    await pc.page.waitFor(`fakePc.rec.restarts === 1`, 8000, 'restart asked for');
    assert(Date.now() - t0 > 2000, `after about 3 s (${Date.now() - t0} ms after)`);
    await pc.page.waitFor(`fakePc.rec.answers === 2`, 8000, 'answered the new offer');
    const origin = await page.evaluate('rc.origin');
    await page.evaluate(`(() => { delete rc.pc.connectionState; delete rc.pc.iceConnectionState; rc.pc.dispatchEvent(new Event('connectionstatechange')); return true; })()`);
    await page.waitFor(`rc.state === 'live'`, 8000, 'live again');
    eq(await page.evaluate(`[rc.origin === ${JSON.stringify(origin)}, rc.verified]`), [true, true], 'the same connection (the same o= id), checked again');
    // Another screen: the PC starts over as a new connection (a new o= id); hello again with its monitor.
    const pcBefore = await page.evaluate('(window.__oldPc = rc.pc, true)');
    assert(pcBefore, 'kept');
    await page.evaluate(`rcSwitchMonitor(rc.monitors[1]); true`);
    eq(await page.evaluate(`[rc.switching?.name, document.querySelector('.rc-card').textContent.includes('Switching to Screen 2')]`), ['Screen 2', true], 'Switching to Screen 2…');
    await waitRc(page, pc, `rc.state === 'live' && !rc.switching && rc.monitor === 1 && rc.verified && rc.frames && Boolean(rc.hostHello)`, 20000, 'on Screen 2');
    eq(await page.evaluate(`[rc.pc !== window.__oldPc, window.__oldPc.connectionState, rc.origin !== ${JSON.stringify(origin)}]`), [true, 'closed', true], 'a fresh peer connection for the new o= id');
    const p = await at(page, 0.5, 0.5);
    const before = (await rec(pc, 'mv')).length;
    await mouse(page, 'mouseMoved', p);
    await pc.page.waitFor(`fakePc.rec.mv.length > ${before}`, 5000, 'a move on Screen 2');
    const mv = (await rec(pc, 'mv')).at(-1);
    eq([mv.x, mv.y, mv.m], [960, 540, 1], 'Screen 2’s own pixels (1920×1080)');
    // Failed: a new session, by itself.
    const first = await page.evaluate('rc.session.id');
    await page.evaluate(`(() => { Object.defineProperty(rc.pc, 'connectionState', { configurable: true, get: () => 'failed' }); rc.pc.dispatchEvent(new Event('connectionstatechange')); return true; })()`);
    await page.waitFor(`rc.state === 'live' && rc.session && rc.session.id !== '${first}'`, 30000, 'live in a new session');
    await pc.page.waitFor(`fakePc.rec.events.some(e => e.ev === 'rc-end' && e.id === '${first}' && e.reason === 'failed')`, 5000, 'the old one ended (failed)');
    // The PC's user pressed Stop: ended, with who did it.
    await pc.js(`fakePc.end('stopped')`);
    await page.waitFor(`rc.state === 'ended' && rc.end.reason === 'stopped'`, 8000, 'ended by the PC');
    assert(await page.evaluate(`document.querySelector('.rc-card').textContent.includes(${JSON.stringify(`${pc.name} ended the session`)})`), 'says the PC ended it');
    eq(page.errors, [], 'no page errors');
  }, { requires: FEATURE, timeout: 120000 });

  test('remote control: the PC’s states (locked, a security prompt, an elevated window) stop input; not-listed ends without trying again; nothing of a session is stored', async ctx => {
    const pc = await fakePc(ctx);
    const page = await viewer(ctx, pc.id);
    const dbsBefore = await page.evaluate(`indexedDB.databases ? indexedDB.databases().then(l => l.map(d => d.name).sort()) : []`);
    await live(page, pc);
    await pc.js(`fakePc.send('ctl', { t: 'state', locked: false, secure: false, elevated: true })`);
    await page.waitFor(`!rcUi.notice.hidden && /administrator/.test(rcUi.notice.textContent)`, 5000, 'the elevated note');
    eq(await page.evaluate('rcLive()'), true, 'input still goes (only that window ignores it)');
    await pc.js(`fakePc.send('ctl', { t: 'state', locked: false, secure: true, elevated: false })`);
    await page.waitFor(`/security prompt/.test(document.querySelector('.rc-card').textContent) && !rcUi.overlay.hidden`, 5000, 'the security prompt');
    const n = (await rec(pc, 'in')).length;
    const p = await at(page, 0.5, 0.5);
    await mouse(page, 'mousePressed', p, { button: 'left', buttons: 1, clickCount: 1 });
    await mouse(page, 'mouseReleased', p, { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(300);
    eq((await rec(pc, 'in')).slice(n).filter(m => m.t === 'btn'), [], 'no input while it waits');
    await pc.js(`fakePc.send('ctl', { t: 'state', locked: true, secure: false, elevated: false })`);
    await page.waitFor(`/is locked: use Remote Desktop/.test(document.querySelector('.rc-card').textContent)`, 5000, 'locked');
    await pc.js(`fakePc.send('ctl', { t: 'state', locked: false, secure: false, elevated: false })`);
    await page.waitFor(`rcUi.overlay.hidden && rcUi.notice.hidden && rcLive()`, 5000, 'back');
    // The PC's own list doesn't have this viewer: ended, no automatic retry.
    const sid = await page.evaluate('rc.session.id');
    await pc.js(`fakePc.end('not-listed')`).catch(() => {});
    const r = await pc.js(`fakePc.api('POST', '/api/rc/sessions/${sid}/end', { reason: 'not-listed' }).then(r => r.status)`);
    if (r === 204) {
      await page.waitFor(`rc.state === 'ended' && rc.end.reason === 'not-listed'`, 8000, 'not listed');
      const text = await page.evaluate(`document.querySelector('.rc-card').textContent`);
      assert(text.includes('doesn’t allow control from') && text.includes('tray → Remote control devices…'), `not-listed text: ${text}`);
      await sleep(2500);
      eq(await page.evaluate('[rc.state, rc.session]'), ['ended', null], 'no new session by itself');
    } else {
      // (a server that doesn't know the reason yet answers 400: the viewer's handling is checked with the event)
      await page.evaluate(`rcOnEnd({ id: '${sid}', reason: 'not-listed', from: '${pc.id}', by: 'x' }); true`);
      eq(await page.evaluate('rc.end.reason'), 'not-listed', 'not listed (event)');
      await sleep(2500);
      eq(await page.evaluate('rc.state'), 'ended', 'no new session by itself');
    }
    // Nothing of the session anywhere: no new databases, nothing in storage.
    const dbsAfter = await page.evaluate(`indexedDB.databases ? indexedDB.databases().then(l => l.map(d => d.name).sort()) : []`);
    eq(dbsAfter, dbsBefore, 'no database opened by the viewer');
    const stored = await page.evaluate(`(async () => {
      const parts = [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })];
      for (const { name } of (indexedDB.databases ? await indexedDB.databases() : [])) {
        const db = await new Promise(r => { const q = indexedDB.open(name); q.onsuccess = () => r(q.result); q.onerror = () => r(null); });
        if (!db) continue;
        for (const s of db.objectStoreNames) parts.push(JSON.stringify(await new Promise(r => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => r(q.result); q.onerror = () => r([]); })));
        db.close();
      }
      for (const k of await caches.keys()) for (const req of await (await caches.open(k)).keys()) parts.push(req.url);
      return parts.join(' ');
    })()`);
    // (the device list the chat app keeps has Tailscale addresses of its own: what's checked is the session's)
    for (const s of [sid, 'candidate:', 'a=fingerprint', 'blob:']) assert(!stored.includes(s), `nothing of the session stored (${s})`);
    eq(page.errors, [], 'no page errors');
  }, { requires: FEATURE, timeout: 90000 });

  // Phones (1.6.1): the gestures of each mode, as Chrome Remote Desktop and Microsoft's apps do them.
  const touchOf = page => (type, points) => page.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i })) });
  const btns = async pc => (await rec(pc, 'in')).filter(m => m.t === 'btn').map(m => [m.b, m.d, m.x, m.y]);
  const sentCount = async pc => (await rec(pc, 'in')).length + (await rec(pc, 'mv')).length;
  const armed = page => page.waitFor(`Boolean(document.querySelector('.rc-fx.hold.armed'))`, 3000, 'the hold is ready');
  // (ripples last a third of a second: they're recorded as they appear, so a busy machine can't miss them)
  const recordFx = page => page.evaluate(`window.fxSeen = []; new MutationObserver(l => l.forEach(r => r.addedNodes.forEach(n => fxSeen.push(n.className)))).observe(rcUi.fx, { childList: true }); true`);
  async function gotIt(page, mode) {
    await page.waitFor(`!rcUi.help.hidden && /${mode === 'trackpad' ? 'Trackpad' : 'Touch'} mode/.test(rcUi.help.textContent)`, 5000, `how ${mode} works`);
    await page.evaluate(`rcUi.help.querySelector('.btn.primary').click(); true`);
    eq(await page.evaluate(`[rcUi.help.hidden, localStorage.getItem('beam.rc.help.${mode}')]`), [true, '1'], 'shown once');
  }

  test('remote control on a phone: trackpad (tap, slow tap, hold = right-click, hold and move = drag, two- and three-finger taps, scroll with momentum, pinch), the bar, the keyboard and the key strip', async ctx => {
    const pc = await fakePc(ctx);
    await pc.js('fakePc.cursor = { x: 300, y: 200 }; true');
    const page = await viewer(ctx, pc.id, { mobile: true });
    await live(page, pc);
    await gotIt(page, 'trackpad');
    eq(await page.evaluate(`[rc.touchMode, !rcUi.keys.hidden, document.activeElement === rcUi.sink]`), ['trackpad', true, false], 'trackpad mode, the key strip (upright), no keyboard yet');
    eq(await page.evaluate(`[...rcUi.tools.querySelectorAll('.rc-tool')].map(b => b.dataset.tool)`), ['pointer', 'keyboard', 'more', 'x'], 'a phone’s bar: the mode, the keyboard, more, disconnect');
    eq(await page.evaluate(`rcUi.tools.querySelector('.rc-tool.mode .rc-tool-label').offsetWidth > 0`), true, 'the mode says its name');
    eq(await page.evaluate(`['autocomplete', 'autocorrect', 'autocapitalize', 'spellcheck', 'inputmode'].map(a => rcUi.sink.getAttribute(a))`), ['off', 'off', 'off', 'false', 'text'], 'the soft keyboard’s box: no autocorrect, suggestions or learning');
    eq(await page.evaluate('rcIdleLimit()'), 10 * 60e3, 'a touch screen: idle after 10 minutes');
    eq(await page.evaluate('rc.pointer'), { x: 300, y: 200 }, 'the pointer starts where the PC’s cursor is');
    const touch = touchOf(page);
    await recordFx(page);
    const c = await at(page, 0.5, 0.5);
    // A tap clicks where the pointer is; a little wobble doesn't move the click.
    await touch('touchStart', [c]);
    await touch('touchMove', [{ x: c.x + 3, y: c.y + 2 }]);
    await touch('touchEnd', []);
    await pc.page.waitFor(`fakePc.rec.in.filter(m => m.t === 'btn').length === 2`, 5000, 'tap');
    eq(await btns(pc), [[0, true, 300, 200], [0, false, 300, 200]], 'a click where the PC’s cursor was');
    assert(await page.evaluate('fxSeen.some(c => /\\btap\\b/.test(c))'), 'a ripple where it clicked');
    // A slow tap (350 ms) is still a tap (1.6.0 did nothing for 300–450 ms).
    await touch('touchStart', [c]);
    await sleep(350);
    await touch('touchEnd', []);
    await pc.page.waitFor(`fakePc.rec.in.filter(m => m.t === 'btn').length === 4`, 5000, 'slow tap');
    // One finger moves the pointer: right and down, further when quicker.
    await touch('touchStart', [c]);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', [{ x: c.x + i * 6, y: c.y + i * 3 }]); await sleep(16); }
    await touch('touchEnd', []);
    await sleep(200);
    const mv = await rec(pc, 'mv');
    assert(mv.length >= 1 && mv.at(-1).x > 300 && mv.at(-1).y > 200, `moved right and down: ${JSON.stringify(mv.at(-1))}`);
    eq((await btns(pc)).length, 4, 'moving the finger isn’t a click');
    const p1 = await page.evaluate('rcPointerPoint()');
    // Touch and hold, then let go: the right button, where the pointer is; the ring shows it's ready.
    await touch('touchStart', [c]);
    await sleep(200);
    assert(await page.evaluate(`Boolean(document.querySelector('.rc-fx.hold'))`), 'the hold ring fills');
    await armed(page);
    await touch('touchEnd', []);
    await pc.page.waitFor(`fakePc.rec.in.filter(m => m.t === 'btn').length === 6`, 5000, 'hold: right-click');
    eq((await btns(pc)).slice(-2), [[2, true, p1.x, p1.y], [2, false, p1.x, p1.y]], 'the right button at the pointer');
    eq(await page.evaluate(`Boolean(document.querySelector('.rc-fx.hold'))`), false, 'the ring went');
    // Touch and hold, then move: a drag (the left button down where the pointer was, up where it ends).
    await touch('touchStart', [c]);
    await armed(page);
    for (let i = 1; i <= 6; i++) { await touch('touchMove', [{ x: c.x + i * 8, y: c.y }]); await sleep(16); }
    eq(await page.evaluate(`rcUi.cursor.classList.contains('down')`), true, 'the pointer shows the button is down');
    await touch('touchEnd', []);
    await pc.page.waitFor(`fakePc.rec.in.filter(m => m.t === 'btn').length === 8`, 5000, 'drag');
    const drag = (await btns(pc)).slice(-2);
    eq([drag[0].slice(0, 4), drag[1].slice(0, 2)], [[0, true, p1.x, p1.y], [0, false]], 'pressed where the pointer was');
    assert(drag[1][2] > p1.x, `let go further right: ${JSON.stringify(drag)}`);
    // Two fingers: a tap is the right button (at the pointer), a drag scrolls (and goes on a moment after a flick).
    const a = { x: c.x - 40, y: c.y };
    const b = { x: c.x + 40, y: c.y };
    await touch('touchStart', [a, b]);
    await touch('touchEnd', []);
    await pc.page.waitFor(`fakePc.rec.in.filter(m => m.t === 'btn' && m.b === 2).length === 4`, 5000, 'two-finger tap');
    await touch('touchStart', [a, b]);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', [{ x: a.x, y: a.y - i * 14 }, { x: b.x, y: b.y - i * 14 }]); await sleep(16); }
    const wheels = async () => (await rec(pc, 'in')).filter(m => m.t === 'wheel');
    await touch('touchEnd', []);
    const atEnd = (await wheels()).length;
    assert(atEnd > 0, 'two-finger scroll');
    await sleep(500);
    const after = await wheels();
    assert(after.length > atEnd, `it goes on after the flick (${atEnd} → ${after.length})`);
    assert(after.every(m => m.dy > 0), 'fingers up: down the page');
    const p2 = await page.evaluate('rcPointerPoint()');
    assert(after.every(m => m.x === p2.x && m.y === p2.y), 'where the pointer is');
    await sleep(3500); // (the momentum ends)
    // Three fingers: a tap is the middle button.
    await touch('touchStart', [a, b, { x: c.x, y: c.y + 60 }]);
    await touch('touchEnd', []);
    await pc.page.waitFor(`fakePc.rec.in.some(m => m.t === 'btn' && m.b === 1)`, 5000, 'three-finger tap');
    // A pinch zooms the picture here (around the pointer); nothing goes to the PC.
    const sent = await sentCount(pc);
    await touch('touchStart', [a, b]);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', [{ x: a.x - i * 12, y: a.y }, { x: b.x + i * 12, y: b.y }]); await sleep(16); }
    await touch('touchEnd', []);
    await sleep(300);
    const zoom = await page.evaluate('rc.zoom');
    assert(zoom > 1.5, `zoomed in: ${zoom}`);
    eq(await sentCount(pc), sent, 'a pinch sends nothing');
    // The picture keeps its zoom when the layout changes: the video's own size, the keyboard (a shorter window).
    await page.evaluate(`rcLayout(); rcUi.video.dispatchEvent(new Event('resize')); true`);
    eq(await page.evaluate('rc.zoom'), zoom, 'a new video size keeps the zoom');
    await page.evaluate(`rcShowKeyboard(); true`);
    eq(await page.evaluate('document.activeElement === rcUi.sink'), true, 'the keyboard');
    await page.viewport(412, 520, true);
    await sleep(300);
    const kb = await page.evaluate('({ zoom: rc.zoom, s: rcV.s, kb: rcV.kb, pointerOnScreen: (q => q.y > rcUi.stage.getBoundingClientRect().top && q.y < rcUi.stage.getBoundingClientRect().bottom)(rcClient(rc.pointer)) })');
    assert(kb.kb && kb.pointerOnScreen, `the keyboard: the picture keeps its size and the pointer stays in view: ${JSON.stringify(kb)}`);
    // A tap on the picture leaves the keyboard up.
    await touch('touchStart', [await at(page, 0.5, 0.5)]);
    await touch('touchEnd', []);
    await sleep(100);
    eq(await page.evaluate('document.activeElement === rcUi.sink'), true, 'still typing after a tap');
    // The key strip: Ctrl stays down for the next key (here a letter from the phone's keyboard).
    await page.evaluate(`rcUi.keys.querySelector('[data-key="Ctrl"]').click(); true`);
    eq(await page.evaluate(`rcUi.keys.querySelector('[data-key="Ctrl"]').getAttribute('aria-pressed')`), 'true', 'Ctrl latched');
    const k0 = (await rec(pc, 'in')).filter(m => m.t === 'key').length;
    await page.send('Input.insertText', { text: 'c' });
    await pc.page.waitFor(`fakePc.rec.in.filter(m => m.t === 'key').length >= ${k0 + 4}`, 5000, 'Ctrl+C');
    eq((await rec(pc, 'in')).filter(m => m.t === 'key').slice(k0).map(m => `${m.c}${m.d ? '↓' : '↑'}`), ['ControlLeft↓', 'KeyC↓', 'KeyC↑', 'ControlLeft↑'], 'Ctrl+C');
    // Typing: text.
    await page.send('Input.insertText', { text: 'hé' });
    await pc.page.waitFor(`fakePc.rec.in.some(m => m.t === 'text')`, 5000, 'text');
    eq((await rec(pc, 'in')).filter(m => m.t === 'text').map(m => m.s).join(''), 'hé', 'typed as text');
    // The keyboard closing by itself (Android's back): the window grows back, the box lets go, the zoom is as before.
    await page.viewport(412, 860, true);
    await sleep(300);
    eq(await page.evaluate('[document.activeElement === rcUi.sink, rcV.kb, Math.abs(rc.zoom - ' + zoom + ') < 0.01]'), [false, false, true], 'the keyboard went: the box let go, the zoom is as it was');
    // Sideways, the key strip waits for the keyboard (the picture gets the height).
    await page.viewport(860, 412, true);
    await sleep(300);
    eq(await page.evaluate('rcUi.keys.hidden'), true, 'no key strip sideways without the keyboard');
    await page.evaluate(`rcShowKeyboard(); true`);
    await sleep(100);
    eq(await page.evaluate('rcUi.keys.hidden'), false, '…and there with it');
    // More: zoom to fit, how to control, the other things.
    await page.evaluate(`rcUi.sink.blur(); document.querySelector('.rc-tool[data-tool="more"]').click(); true`);
    const items = await page.evaluate(`[...document.querySelectorAll('#menu .menu-item span')].map(s => s.textContent)`);
    for (const want of ['How to control', 'Zoom to fit', 'Picture: Sharp text…', 'Clipboard sync is off']) assert(items.includes(want), `More has ${want}: ${items}`);
    await page.evaluate(`[...document.querySelectorAll('#menu .menu-item')].find(b => /Zoom to fit/.test(b.textContent)).click(); true`);
    eq(await page.evaluate('[rc.zoom, rcV.fit]'), [1, true], 'zoomed to fit');
    eq(page.errors, [], 'no page errors');
  }, { requires: FEATURE, timeout: 120000 });

  test('remote control on a phone: touch mode (tap where the finger is, a double tap is one pixel, one finger scrolls, two fingers move and zoom the picture, hold = right-click, hold and move = drag), remembered', async ctx => {
    const pc = await fakePc(ctx);
    let page = await viewer(ctx, pc.id, { mobile: true });
    await live(page, pc);
    await gotIt(page, 'trackpad');
    await page.evaluate(`document.querySelector('.rc-tool[data-tool="pointer"]').click(); true`);
    eq(await page.evaluate(`[rc.touchMode, localStorage.getItem('beam.rc.touchMode'), rcUi.cursor.hidden]`), ['touch', 'touch', true], 'touch mode (remembered), no pointer drawn');
    await gotIt(page, 'touch');
    const touch = touchOf(page);
    // A tap clicks under the finger.
    const t = await at(page, 0.25, 0.25);
    await touch('touchStart', [t]);
    await touch('touchEnd', []);
    await pc.page.waitFor(`fakePc.rec.in.filter(m => m.t === 'btn').length === 2`, 5000, 'tap in touch mode');
    eq(await btns(pc), [[0, true, 640, 360], [0, false, 640, 360]], 'where the finger was');
    // A double tap a few pixels apart: both clicks on the first one's pixel (Windows sees a double-click).
    await sleep(600);
    const d = await at(page, 0.6, 0.4);
    await touch('touchStart', [d]);
    await touch('touchEnd', []);
    await sleep(120);
    await touch('touchStart', [{ x: d.x + 6, y: d.y + 4 }]);
    await touch('touchEnd', []);
    await pc.page.waitFor(`fakePc.rec.in.filter(m => m.t === 'btn').length === 6`, 5000, 'double tap');
    const dbl = (await btns(pc)).slice(-4);
    eq(new Set(dbl.map(m => `${m[2]},${m[3]}`)).size, 1, `one pixel: ${JSON.stringify(dbl)}`);
    // Black bars aren't the PC's: a touch there does nothing.
    const bar = await page.evaluate(`(r => ({ x: r.left + r.width / 2, y: r.bottom + 30 }))(rcUi.video.getBoundingClientRect())`);
    const n0 = await sentCount(pc);
    await touch('touchStart', [bar]);
    await touch('touchEnd', []);
    await sleep(200);
    eq(await sentCount(pc), n0, 'nothing from the black bars');
    // One finger scrolls what's under it (fingers up: down the page), and goes on after a flick.
    const s = await at(page, 0.5, 0.7);
    await touch('touchStart', [s]);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', [{ x: s.x, y: s.y - i * 12 }]); await sleep(16); }
    await touch('touchEnd', []);
    // A touch while it still goes on stops it, and isn't a click (as on a phone).
    const going = await page.evaluate('Boolean(rcFlinging)');
    await touch('touchStart', [s]);
    await touch('touchEnd', []);
    eq(going, true, 'still going after the flick');
    await sleep(150);
    const wheelsThen = (await rec(pc, 'in')).filter(m => m.t === 'wheel').length;
    await sleep(300);
    eq([(await btns(pc)).length, (await rec(pc, 'in')).filter(m => m.t === 'wheel').length], [6, wheelsThen], 'stopped, and nothing clicked');
    const under = await page.evaluate(`rcPx(rcDesk(${s.x}, ${s.y}))`);
    const w1 = (await rec(pc, 'in')).filter(m => m.t === 'wheel');
    assert(w1.length > 0 && w1.every(m => m.dy > 0 && m.x === under.x && m.y === under.y), `down the page, under the finger: ${JSON.stringify(w1.slice(0, 2))} ${JSON.stringify(under)}`);
    // Two fingers move and zoom the picture; nothing goes to the PC.
    const sent = await sentCount(pc);
    const c = await at(page, 0.5, 0.5);
    const a = { x: c.x - 40, y: c.y };
    const b = { x: c.x + 40, y: c.y };
    await touch('touchStart', [a, b]);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', [{ x: a.x - i * 14, y: a.y }, { x: b.x + i * 14, y: b.y }]); await sleep(16); }
    await touch('touchEnd', []);
    await sleep(200);
    const z = await page.evaluate('rc.zoom');
    assert(z > 1.5, `zoomed: ${z}`);
    const before = await page.evaluate('[rcV.ox, rcV.oy]');
    await touch('touchStart', [a, b]);
    for (let i = 1; i <= 6; i++) { await touch('touchMove', [{ x: a.x + i * 10, y: a.y }, { x: b.x + i * 10, y: b.y }]); await sleep(16); }
    await touch('touchEnd', []);
    await sleep(200);
    const moved = await page.evaluate('[rcV.ox, rcV.oy]');
    assert(moved[0] > before[0] + 30, `two fingers moved the picture: ${before} → ${moved}`);
    await page.evaluate(`rcUi.video.dispatchEvent(new Event('resize')); true`);
    eq(await page.evaluate('[rcV.ox, rcV.oy]'), moved, 'a new video size (WebRTC adapting) leaves the picture where it is');
    eq(await sentCount(pc), sent, 'nothing sent');
    // Touch and hold, then let go: the right button under the finger.
    const h = await at(page, 0.5, 0.5);
    const hp = await page.evaluate(`rcPx(rcDesk(${h.x}, ${h.y}))`);
    await touch('touchStart', [h]);
    await armed(page);
    await touch('touchEnd', []);
    await pc.page.waitFor(`fakePc.rec.in.filter(m => m.t === 'btn' && m.b === 2).length === 2`, 5000, 'hold: right-click');
    eq((await btns(pc)).slice(-2), [[2, true, hp.x, hp.y], [2, false, hp.x, hp.y]], 'under the finger');
    // Touch and hold, then move: a drag from there to where the finger goes.
    await touch('touchStart', [h]);
    await armed(page);
    for (let i = 1; i <= 6; i++) { await touch('touchMove', [{ x: h.x + i * 10, y: h.y + i * 4 }]); await sleep(16); }
    const end = { x: h.x + 60, y: h.y + 24 };
    const ep = await page.evaluate(`rcPx(rcDesk(${end.x}, ${end.y}))`);
    await touch('touchEnd', []);
    await pc.page.waitFor(`fakePc.rec.in.filter(m => m.t === 'btn' && m.b === 0).length === 8`, 5000, 'drag');
    eq((await btns(pc)).slice(-2), [[0, true, hp.x, hp.y], [0, false, ep.x, ep.y]], 'pressed under the finger, let go where it ended');
    eq(page.errors, [], 'no page errors');
    // Next time: touch mode, and no how-to.
    page = await viewer(ctx, pc.id, { page, attest: null }); // (its 201 is already rewritten)
    await live(page, pc);
    await sleep(300);
    eq(await page.evaluate('[rc.touchMode, rcUi.help.hidden]'), ['touch', true], 'remembered; no how-to again');
  }, { requires: FEATURE, timeout: 120000 });

  test('remote control: idle (an hour on a PC, 10 minutes on a phone): Still there?, input keeps it going, else it ends', async ctx => {
    const pc = await fakePc(ctx);
    const page = await viewer(ctx, pc.id);
    await live(page, pc);
    eq(await page.evaluate('rcIdleLimit()'), 60 * 60e3, 'a PC: an hour');
    // (shortened for the test)
    await page.evaluate('RC_IDLE.desktop = 1000; RC_IDLE.warn = 4000; true');
    await page.waitFor(`Boolean(rc.idleWarn) && /Still there/.test(document.querySelector('.rc-card').textContent)`, 9000, 'Still there?');
    await pc.page.waitFor(`fakePc.rec.in.some(m => m.t === 'release')`, 3000, 'let go of everything');
    await key(page, 'KeyA', 'a');
    eq(await page.evaluate('[Boolean(rc.idleWarn), rc.state, rcUi.overlay.hidden]'), [false, 'live', true], 'a key: still there');
    await page.waitFor(`Boolean(rc.idleWarn)`, 9000, 'Still there? again');
    await page.waitFor(`rc.state === 'ended' && rc.end.reason === 'idle'`, 9000, 'ended: idle');
    await pc.page.waitFor(`fakePc.rec.ctl.some(m => m.t === 'bye' && m.reason === 'idle') && fakePc.rec.events.some(e => e.ev === 'rc-end')`, 5000, 'bye (idle), and the session ended');
    assert(await page.evaluate(`/Nothing was touched or pressed/.test(document.querySelector('.rc-card').textContent)`), 'it says why');
    eq(page.errors, [], 'no page errors');
  }, { requires: FEATURE, timeout: 60000 });

  test('remote control: the clipboard is off until turned on; then both ways (Ctrl+V sends ours before the keys)', async ctx => {
    const pc = await fakePc(ctx);
    const page = await ctx.signedIn();
    const b = await ctx.browser.browserConn();
    await b.send('Browser.grantPermissions', { origin: ctx.srv.base, browserContextId: page.contextId, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await viewer(ctx, pc.id, { page });
    await live(page, pc);
    await page.evaluate(`navigator.clipboard.writeText('before').then(() => true)`);
    await pc.js(`fakePc.send('ctl', { t: 'clip', n: 1, text: 'from the PC, unasked' })`);
    await sleep(400);
    eq(await page.evaluate('navigator.clipboard.readText()'), 'before', 'off: the PC’s clipboard isn’t taken');
    // Ctrl+V with it off: just the keys.
    const ctrlV = async () => {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'ControlLeft', key: 'Control', modifiers: 2 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyV', key: 'v', modifiers: 2, commands: ['paste'] });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyV', key: 'v', modifiers: 2 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'ControlLeft', key: 'Control' });
    };
    await ctrlV();
    await pc.page.waitFor(`fakePc.rec.in.filter(m => m.t === 'key').length >= 4`, 5000, 'the keys');
    eq((await rec(pc, 'ctl')).filter(m => m.t === 'clip'), [], 'nothing of ours sent');
    eq((await rec(pc, 'in')).filter(m => m.t === 'key').map(m => `${m.c}${m.d ? '↓' : '↑'}`), ['ControlLeft↓', 'KeyV↓', 'KeyV↑', 'ControlLeft↑'], 'just Ctrl+V');
    // On.
    await page.evaluate(`document.querySelector('.rc-tool[data-tool="clip"]').click(); true`);
    await pc.page.waitFor(`fakePc.rec.ctl.some(m => m.t === 'clip' && m.on === true)`, 5000, '{ t: "clip", on: true }');
    await pc.js(`fakePc.send('ctl', { t: 'clip', n: 2, text: 'from the PC' })`);
    await page.waitFor(`navigator.clipboard.readText().then(t => t === 'from the PC')`, 5000, 'the PC’s clipboard here');
    await page.evaluate(`navigator.clipboard.writeText('from the viewer').then(() => true)`);
    const order0 = (await rec(pc, 'order')).length;
    await ctrlV();
    await pc.page.waitFor(`fakePc.rec.ctl.some(m => m.t === 'clip' && m.text === 'from the viewer') && fakePc.rec.order.slice(${order0}).includes('key:KeyV')`, 5000, 'ours, then the keys');
    await pc.page.waitFor(`fakePc.rec.order.slice(${order0}).filter(o => o.startsWith('key:')).length >= 4`, 5000, 'all the keys');
    const order = (await rec(pc, 'order')).slice(order0).filter(o => /^(clip|key:)/.test(o));
    eq(order, ['key:ControlLeft', 'clip', 'key:KeyV', 'key:KeyV', 'key:ControlLeft'], 'our clipboard reaches the PC before the V (and the Ctrl let go of after)');
    eq(page.errors, [], 'no page errors');
  }, { requires: FEATURE, timeout: 60000 });

  test('remote control 1.12.4: pictures through the clipboard both ways (a screenshot pasted here goes to the PC in parts before the keys; the PC\'s picture lands here)', async ctx => {
    const pc = await fakePc(ctx, { caps: ['clipimg'] });
    const page = await ctx.signedIn();
    const b = await ctx.browser.browserConn();
    await b.send('Browser.grantPermissions', { origin: ctx.srv.base, browserContextId: page.contextId, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await viewer(ctx, pc.id, { page });
    await live(page, pc);
    await page.evaluate(`document.querySelector('.rc-tool[data-tool="clip"]').click(); true`);
    await pc.page.waitFor(`fakePc.rec.ctl.some(m => m.t === 'clip' && m.on === true)`, 5000, '{ t: "clip", on: true }');
    // A screenshot-like picture on this device's clipboard (noise: it doesn't compress, so it takes several parts).
    const size = await page.evaluate(`(async () => {
      const c = document.createElement('canvas'); c.width = 400; c.height = 300;
      const g = c.getContext('2d'); const d = g.createImageData(400, 300);
      let x = 7; for (let i = 0; i < d.data.length; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; d.data[i] = x >>> 24; }
      for (let i = 3; i < d.data.length; i += 4) d.data[i] = 255;
      g.putImageData(d, 0, 0);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return blob.size;
    })()`);
    assert(size > 2 * 48 * 1024, `a picture of several parts: ${size} bytes`);
    const order0 = (await rec(pc, 'order')).length;
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'ControlLeft', key: 'Control', modifiers: 2 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyV', key: 'v', modifiers: 2, commands: ['paste'] });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyV', key: 'v', modifiers: 2 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'ControlLeft', key: 'Control' });
    await pc.page.waitFor(`fakePc.rec.order.slice(${order0}).filter(o => o.startsWith('key:')).length >= 4`, 10000, 'all the keys');
    const parts = await rec(pc, 'clip');
    eq(parts.reduce((t, p) => t + p.len, 0), parts[0]?.size, 'the whole picture went to the PC (as pasted: the clipboard re-encodes what was written to it)');
    assert(parts.length >= 3 && parts.every((p, i) => p.i === i && p.of === parts.length && p.size === parts[0].size), `in order, in ${parts.length} parts`);
    eq(await rec(pc, 'ctl').then(l => l.filter(m => m.t === 'clip' && m.text)), [], 'no text sent instead');
    const order = (await rec(pc, 'order')).slice(order0).filter(o => /^(img|key:)/.test(o));
    eq(order, ['key:ControlLeft', ...parts.map(() => 'img'), 'key:KeyV', 'key:KeyV', 'key:ControlLeft'], 'the picture reaches the PC before the V');
    // The PC's picture: here, on this device's clipboard.
    const pcPng = await pc.page.evaluate(`(async () => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 200;
      const g = c.getContext('2d'); g.fillStyle = '#3a7'; g.fillRect(0, 0, 320, 200); g.fillStyle = '#fff'; g.fillRect(40, 40, 120, 80);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const u8 = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (const x of u8) s += String.fromCharCode(x);
      return { b64: btoa(s), size: u8.length };
    })()`);
    await pc.js(`fakePc.sendImage(${JSON.stringify(pcPng.b64)}, 7)`);
    // (Ours stays on this clipboard until the PC's lands, and a read can meet that write: read it whole, until it's the PC's.)
    await page.waitFor(`navigator.clipboard.read().then(async items => { const i = items.find(x => x.types.includes('image/png')); if (!i) return 'no picture'; const bmp = await createImageBitmap(await i.getType('image/png')); return (bmp.width === 320 && bmp.height === 200) || bmp.width + ' x ' + bmp.height; })`, 8000, 'the PC\'s picture (320 x 200) on this clipboard');
    eq(page.errors, [], 'no page errors');
  }, { requires: FEATURE, timeout: 60000 });

  test('remote control 1.12.7: Ctrl+V sends nothing back while this clipboard holds what the PC put there (its text, or the same picture), and the keys go at once; something else still goes first', async ctx => {
    const pc = await fakePc(ctx, { caps: ['clipimg'] });
    const page = await ctx.signedIn();
    const b = await ctx.browser.browserConn();
    await b.send('Browser.grantPermissions', { origin: ctx.srv.base, browserContextId: page.contextId, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await viewer(ctx, pc.id, { page });
    await live(page, pc);
    await page.evaluate(`document.querySelector('.rc-tool[data-tool="clip"]').click(); true`);
    await pc.page.waitFor(`fakePc.rec.ctl.some(m => m.t === 'clip' && m.on === true)`, 5000, '{ t: "clip", on: true }');
    const ctrlV = async () => {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'ControlLeft', key: 'Control', modifiers: 2 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyV', key: 'v', modifiers: 2, commands: ['paste'] });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyV', key: 'v', modifiers: 2 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'ControlLeft', key: 'Control' });
    };
    const marks = async () => ({ ctl: (await rec(pc, 'ctl')).length, order: (await rec(pc, 'order')).length, clip: (await rec(pc, 'clip')).length });
    const keysArrive = m => pc.page.waitFor(`fakePc.rec.order.slice(${m.order}).filter(o => o.startsWith('key:')).length >= 4`, 5000, 'the keys');
    const sentBack = async m => ({
      text: (await rec(pc, 'ctl')).slice(m.ctl).filter(x => x.t === 'clip' && typeof x.text === 'string').map(x => x.text),
      parts: (await rec(pc, 'clip')).length - m.clip,
    });
    // The PC's text lands on this clipboard; Ctrl+V: the keys at once, nothing sent back.
    await pc.js(`fakePc.send('ctl', { t: 'clip', text: 'copied on the PC' }); true`);
    await page.waitFor(`rc.lastClip === 'copied on the PC' && !rc.clipPending`, 5000, 'the PC’s text on this clipboard');
    let m = await marks();
    await ctrlV();
    await keysArrive(m);
    eq(await sentBack(m), { text: [], parts: 0 }, 'its own text: nothing sent back');
    // The PC's picture: the same pixels (re-encoded by the clipboard), so nothing goes back either.
    const pcPng = await pc.page.evaluate(`(async () => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 200;
      const g = c.getContext('2d'); g.fillStyle = '#3a7'; g.fillRect(0, 0, 320, 200); g.fillStyle = '#fff'; g.fillRect(40, 40, 120, 80);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const u8 = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (const x of u8) s += String.fromCharCode(x);
      return { b64: btoa(s), size: u8.length };
    })()`);
    await pc.js(`fakePc.sendImage(${JSON.stringify(pcPng.b64)}, 9)`);
    await page.waitFor(`Boolean(rc.lastClipImg) && !rc.clipPending`, 5000, 'the PC’s picture on this clipboard');
    m = await marks();
    await ctrlV();
    await keysArrive(m);
    eq(await sentBack(m), { text: [], parts: 0 }, 'its own picture: nothing sent back');
    // Something copied on this device: it still goes to the PC first.
    await page.evaluate(`navigator.clipboard.writeText('copied on this device').then(() => true)`);
    m = await marks();
    await ctrlV();
    await keysArrive(m);
    eq(await sentBack(m), { text: ['copied on this device'], parts: 0 }, 'this device’s text goes first');
    eq(page.errors, [], 'no page errors');
  }, { requires: FEATURE, timeout: 60000 });

  test('remote control 1.12.6: the PC\'s pointer drawn here with a mouse (the PC hides its own; a phone keeps its own), and the delay measured end to end (1.15: Edge\'s capture apart; the start, step by step)', async ctx => {
    const pc = await fakePc(ctx, { caps: ['settings', 'video', 'cursor', 'probe'] });
    const page = await viewer(ctx, pc.id);
    await live(page, pc);
    // A mouse here: our hello says we draw the PC's pointer, and we ask it to hide its own.
    await pc.page.waitFor(`fakePc.rec.ctl.some(m => m.t === 'pointer' && m.here === true)`, 5000, '{ t: "pointer", here: true }');
    eq((await rec(pc, 'ctl')).find(m => m.t === 'hello').caps, ['clip', 'text', 'clipimg', 'cursor'], 'our hello: we can draw its pointer');
    const cursor = () => page.evaluate(`rcUi.stage.style.cursor`);
    eq(await cursor(), '', 'until the PC says which pointer shows: the dot');
    const say = m => pc.js(`fakePc.send('ctl', ${JSON.stringify({ t: 'cursor', ...m })}); true`);
    await say({ css: 'text', hidden: false });
    await page.waitFor(`rcUi.stage.style.cursor === 'text'`, 3000, 'the text pointer, drawn here');
    await say({ css: 'url(x.png), auto', hidden: false });
    await page.waitFor(`rcUi.stage.style.cursor === ''`, 3000, 'a name it doesn\'t know: the dot (only the standard names)');
    await say({ css: 'pointer', hidden: false });
    await page.waitFor(`rcUi.stage.style.cursor === 'pointer'`, 3000, 'the hand');
    await say({ css: null, hidden: true });
    await page.waitFor(`rcUi.stage.style.cursor === 'none'`, 3000, 'hidden by an app there: none here');
    await say({ css: null, hidden: false });
    await page.waitFor(`rcUi.stage.style.cursor === ''`, 3000, 'an app\'s own pointer (in the picture): the dot');
    // Off (Picture): the PC shows its own again; the dot here.
    await say({ css: 'text', hidden: false });
    await page.waitFor(`rcUi.stage.style.cursor === 'text'`, 3000, 'text again');
    await page.evaluate(`rcSetPic('pointer', false); true`);
    await pc.page.waitFor(`fakePc.rec.ctl.some(m => m.t === 'pointer' && m.here === false)`, 5000, '{ t: "pointer", here: false }');
    eq(await cursor(), '', 'turned off: the dot, and the PC\'s own pointer in the picture');
    await page.evaluate(`rcSetPic('pointer', true); true`);
    // The delay: probes the way input goes; the PC's square turns in its picture; each step's share.
    await page.evaluate(`rcMeasure(); true`);
    await page.waitFor(`rc.measured && rc.measured.n >= 8 && !rc.measuring`, 40000, 'measured');
    const m = await page.evaluate(`rc.measured`);
    assert(m.total > 0 && m.total < 3000 && m.pc === 1.5 && m.toPc != null, `from a probe to its frame shown here, with the PC's own 1.5 ms: ${JSON.stringify(m)}`);
    assert((m.capture != null && m.back != null && m.decode != null && m.shown != null) || m.rest != null, `each step's share, or what's left: ${JSON.stringify(m)}`);
    const probes = (await rec(pc, 'in')).filter(x => x.t === 'probe');
    eq([probes[0].n, probes[0].on, probes.at(-1).off], [0, true, true], 'the probes went on `in`: on first, off last');
    assert(probes.length >= 10, `${probes.length} probes`);
    eq(await pc.js('fakePc.probeColor'), null, 'the square is gone');
    const text = await page.evaluate(`rcUi.details.hidden ? '' : rcUi.details.textContent`);
    assert(/Measured\d+ ms from a click to the picture \(median of \d+\): to the PC/.test(text), `the details say it: ${text.slice(text.indexOf('Measured'), text.indexOf('Measured') + 160)}`);
    assert(!/\(Edge /.test(text), 'a PC that doesn\'t time its own capture: no split');
    // (1.15) A PC that does (`probe-cap`: from the probe reaching it to its own capture showing the colour): less its own
    // 1.5 ms to put the square on its screen, that's Edge's capture; the rest of the capture step is the queue.
    await pc.js(`fakePc.probeCap = 2.5; true`);
    await page.evaluate(`rcMeasure(); true`);
    await page.waitFor(`rc.measured && rc.measured.n >= 8 && !rc.measuring`, 40000, 'measured again');
    const m2 = await page.evaluate(`rc.measured`);
    assert(m2.capture != null, `the capture step is known here: ${JSON.stringify(m2)}`);
    eq(m2.edge, 1, `Edge's capture: the PC's 2.5 less its own 1.5 (${JSON.stringify(m2)})`);
    const text2 = await page.evaluate(`rcUi.details.textContent`);
    assert(/capture [\d.]+ \(Edge [\d.]+ \+ queue [\d.]+\)/.test(text2), `the details split it: ${text2.slice(text2.indexOf('Measured'), text2.indexOf('Measured') + 220)}`);
    // (1.15) The start: this page's own time to the picture, and the PC's steps (its `started`; a made-up step is left out).
    const mine = await page.evaluate(`rc.start.at`);
    assert(['asked', 'offer', 'answered', 'connected', 'picture'].every(k => Number.isFinite(mine[k])) && mine.asked <= mine.offer && mine.offer <= mine.picture,
      `this page's steps: ${JSON.stringify(mine)}`);
    await pc.js(`fakePc.send('ctl', { t: 'started', at: { banner: 70, page: 120, offer: 150, answer: 310, connected: 340, checked: 350, capture: 680, picture: 930, bogus: 5 }, warm: true }); true`);
    await page.waitFor(`rc.start.pc`, 5000, 'the PC\'s steps');
    const st = await page.evaluate(`rcStartText()`);
    assert(/^\d+\.\d\d s to the picture · on .+: banner 0\.07 · its page 0\.12 · offer 0\.15 · answer 0\.31 · connected 0\.34 · checked 0\.35 · capture 0\.68 · picture out 0\.93 \(its page was warm\)$/.test(st), `the details' Start: ${st}`);
    assert((await page.evaluate(`rcUi.details.textContent`)).includes(`Start${st}`), 'in the details');
    eq(page.errors, [], 'no page errors');
    // A phone draws its own pointer (the trackpad's ring): it never asks the PC to hide its own.
    const pc2 = await fakePc(ctx, { caps: ['settings', 'video', 'cursor', 'probe'] });
    const phone = await viewer(ctx, pc2.id, { mobile: true });
    await live(phone, pc2);
    await sleep(800);
    const ctl2 = await rec(pc2, 'ctl');
    eq([ctl2.find(x => x.t === 'hello').caps, ctl2.some(x => x.t === 'pointer')], [['clip', 'text', 'clipimg'], false], 'a phone: no `cursor` in its hello, no `pointer`');
  }, { requires: FEATURE, timeout: 120000 });

  test('remote control in the chat app: Control (a new tab), a locked PC says to use Remote Desktop, Settings → Devices shows who controls a PC (End) and turns it off', async ctx => {
    const pc = await fakePc(ctx);
    await pc.js('fakePc.offer = false; true'); // (it accepts sessions but never offers: enough for the lists)
    const page = await ctx.signedIn();
    await page.waitFor(`deviceById('${pc.id}')?.can?.remoteControl === true`, 8000, 'the PC can be controlled');
    await page.evaluate(`window.__opened = []; window.open = (u, t, f) => { __opened.push([u, t, f]); return null; }; true`);
    const action = await page.evaluate(`deviceActions(deviceById('${pc.id}')).map(a => a.label)`);
    assert(action.includes('Control') && action.indexOf('Control') < (action.indexOf('Remote Desktop') + 1 || 99), `Control, next to Remote Desktop: ${action}`);
    await page.evaluate(`deviceActions(deviceById('${pc.id}')).find(a => a.label === 'Control').action(); true`);
    eq(await page.evaluate('__opened'), [[`${ctx.srv.base}/#remote=${pc.id}`, '_blank', 'noopener']], 'a new tab on #remote=');
    // A session from another device: Settings → Devices shows it, with End.
    const other = dev(ctx, `Laptop ${ctx.uid()}`, 'web');
    await other.me();
    const s = await (await fetch(`${ctx.srv.base}/api/rc/sessions`, { method: 'POST', headers: { ...other.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ device: pc.id }) })).json();
    assert(s.id, 'a session');
    await page.evaluate(`openSettings('devices'); true`);
    const row = `[...document.querySelectorAll('#set-devices .device-row')].find(r => r.textContent.includes(${JSON.stringify(pc.name)}))`;
    await page.waitFor(`/is connecting to control it|Being controlled from/.test(${row}?.textContent || '')`, 8000, 'who controls it');
    await page.evaluate(`[...${row}.querySelectorAll('.rc-line button')].find(b => b.textContent === 'End').click(); true`);
    await pc.page.waitFor(`fakePc.rec.events.some(e => e.ev === 'rc-end' && e.id === '${s.id}')`, 5000, 'ended from Settings');
    await page.waitFor(`!/is connecting to control it|Being controlled from/.test(${row}?.textContent || '')`, 8000, 'gone from the list');
    // Turn off remote control (never on): confirmed, then the PC hears rc-disable.
    await page.evaluate(`[...${row}.querySelectorAll('button')].find(b => b.textContent === 'Turn off remote control').click(); true`);
    await page.waitFor(`$('#genDlg').open`, 3000, 'confirm');
    await page.evaluate(`[...$('#genFoot').querySelectorAll('button')].find(b => b.textContent === 'Turn off').click(); true`);
    await page.waitFor(`/Turning off remote control/.test(${row}?.textContent || '')`, 5000, 'turning off');
    const disabled = await pc.page.waitFor(`fakePc.rec.events.some(e => e.ev === 'rc-disable') || null`, 5000, 'rc-disable').catch(() => false);
    if (!disabled) {
      // (this harness's PC stream only keeps rc-* events it parses: rc-disable is one)
      throw new Error('the PC never heard rc-disable');
    }
    await page.waitFor(`deviceById('${pc.id}')?.can?.remoteControl === false`, 8000, 'no longer controllable');
    // A locked PC: "is locked: use Remote Desktop" instead of Control.
    const locked = await fakePc(ctx, { status: { remoteControl: true, locked: true } });
    await page.waitFor(`deviceById('${locked.id}')?.status?.locked === true`, 8000, 'locked PC known');
    eq(await page.evaluate(`deviceActions(deviceById('${locked.id}')).filter(a => /locked|Control/.test(a.label)).map(a => [a.label, Boolean(a.disabled)])`), [[`${locked.name} is locked: use Remote Desktop`, true]], 'locked: use Remote Desktop');
    eq(page.errors, [], 'no page errors');
  }, { requires: FEATURE, timeout: 60000 });

  test('remote control in the Windows app: Control opens its viewer window; This PC shows the switch (off only) and who may control it; the viewer window says which session is on, uses the keyboard hook and closes itself', async ctx => {
    const pc = await fakePc(ctx);
    // The chat window: Control asks the app for its viewer window.
    const features = ['transfers', 'localFiles', 'settings', 'clipboard', 'pickFiles', 'pickFolder', 'dragOut', 'openPanel', 'remoteDesktop', 'remoteControl'];
    const chat = await hostPage(ctx, { features, settings: { allowRemoteControl: true, remoteControlDevices: [{ id: 'abc12345', name: 'Robin Laptop' }] } });
    await chat.page.waitFor(`paired && hostState.ready && deviceById('${pc.id}')?.can?.remoteControl === true`, 10000, 'host mode, the PC known');
    await chat.page.evaluate(`deviceActions(deviceById('${pc.id}')).find(a => a.label === 'Control').action(); true`);
    await chat.page.waitFor(`__host.log.some(m => m.type === 'openRemote' && m.device === '${pc.id}')`, 5000, 'openRemote');
    await chat.page.evaluate(`openSettings('pc'); true`);
    await chat.page.waitFor(`/Remote control/.test($('#set-pc').textContent) && /Robin Laptop/.test($('#set-pc').textContent)`, 5000, 'This PC: remote control');
    assert(await chat.page.evaluate(`/changed in Beam’s own settings/.test($('#set-pc').textContent) && !$('#set-pc').querySelector('.rc-allowed input')`), 'the list is read-only');
    await chat.page.evaluate(`[...$('#set-pc').querySelectorAll('button')].find(b => b.textContent === 'Turn off remote control').click(); true`);
    await chat.page.waitFor(`__host.log.some(m => m.type === 'setSettings' && m.settings?.allowRemoteControl === false)`, 5000, 'turned off through the app');
    assert(!(await chat.page.evaluate(`__host.log.some(m => m.type === 'setSettings' && m.settings?.allowRemoteControl === true)`)), 'never on');
    // The viewer window (beamHost.window = "remote").
    const win = await hostPage(ctx, { features: ['keyboardHook', 'fullscreen'], hostExtra: { window: 'remote' }, path: `/#remote=${pc.id}` });
    // (Beam for Windows 1.6 uses its token with its device key: from then on it's key-bound, and its window's cookie qualifies)
    const deviceKey = randomBytes(32).toString('base64url');
    const bound = await fetch(`${ctx.srv.base}/api/me`, { headers: { Authorization: `Bearer ${win.key}`, 'X-Beam-Device-Id': win.appId, 'X-Beam-Platform': 'windows', 'X-Beam-App-Version': '1.6.0',
      'X-Beam-Profile': 'a1b2c3d4e5f60718', 'X-Beam-Device-Key': deviceKey, 'X-Forwarded-For': ctx.nextIp() } });
    eq(bound.status, 200, 'the app’s token, used with its device key');
    // (the app adds its device key to the window's requests itself; the page never sees it)
    await win.page.send('Network.setExtraHTTPHeaders', { headers: { 'X-Forwarded-For': ctx.nextIp(), 'X-Beam-Device-Key': deviceKey } });
    await attestAs(win.page, TS4);
    await win.page.evaluate('location.reload(); true');
    await sleep(500);
    await waitRc(win.page, pc, `rc.state === 'live' && rc.verified && Boolean(rc.hostHello)`, 20000, 'live in the viewer window');
    const log = await win.page.evaluate('__host.log.map(m => m.type)');
    assert(log.includes('hello') && log.includes('remoteSession'), `hello and remoteSession: ${log}`);
    eq(await win.page.evaluate(`__host.log.filter(m => m.type === 'remoteSession').at(-1).id === rc.session.id`), true, 'remoteSession { id }');
    await win.page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await win.page.evaluate(`window.dispatchEvent(new Event('focus')); true`);
    await win.page.waitFor(`__host.log.some(m => m.type === 'keyboardHook' && m.on === true)`, 5000, 'keyboardHook on');
    // The app's hook: the Windows key comes as remoteKey.
    await win.page.evaluate(`__host.emit({ type: 'remoteKey', code: 'MetaLeft', down: true }); __host.emit({ type: 'remoteKey', code: 'MetaLeft', down: false }); true`);
    await pc.page.waitFor(`fakePc.rec.in.filter(m => m.t === 'key' && m.c === 'MetaLeft').length === 2`, 5000, 'the Windows key reached the PC');
    eq(await win.page.evaluate(`__host.log.find(m => m.type === 'hello')?.bridge`), 1, 'hello { bridge: 1 }');
    eq(await win.page.evaluate(`__host.log.filter(m => !['hello', 'remoteSession', 'keyboardHook', 'log'].includes(m.type)).map(m => m.type)`), [], 'nothing else asked of the app');
    // Disconnect, then Close: remoteSession null, keyboardHook off, closeWindow.
    await win.page.evaluate(`document.querySelector('.rc-tool.danger').click(); true`);
    await win.page.waitFor(`rc.state === 'ended'`, 5000, 'disconnected');
    await win.page.evaluate(`[...document.querySelectorAll('.rc-card button')].find(b => b.textContent === 'Close').click(); true`);
    eq(await win.page.evaluate(`[__host.log.filter(m => m.type === 'remoteSession').at(-1).id, __host.log.filter(m => m.type === 'keyboardHook').at(-1).on, __host.log.some(m => m.type === 'closeWindow')]`), [null, false, true], 'session off, hook off, the window closes');
    eq(chat.page.errors.concat(win.page.errors), [], 'no page errors');
  }, { requires: FEATURE, timeout: 90000 });
}
