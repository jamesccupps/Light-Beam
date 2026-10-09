// (1.23) Control for a Linux computer: the viewer (public/vnc.js with noVNC) against Beam's relay, with this test as the
// computer: its Beam for Linux's end of the relay (a WebSocket) and a little VNC server of its own (RFB 3.8, no password,
// raw pixels: a screen of one colour). Never a real VNC server or screen.
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { assert, eq } from './harness.mjs';
import { sleep } from './cdp.mjs';

const require = createRequire(import.meta.url);
const ws = require('../../lib/websocket.js');

// A WebSocket of the test's own to the relay (a client's masked frames; it answers pings).
function wsClient(port, route, headers) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({ host: '127.0.0.1', port, path: route, headers: { ...headers, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key } });
    req.on('response', res => reject(new Error(`the relay said ${res.statusCode}`)));
    req.on('upgrade', (res, socket, head) => {
      const reader = new ws.FrameReader({ masked: false, max: 64 << 20 });
      const link = {
        onData: null, closed: false,
        send: buf => socket.write(ws.frame(ws.OP.binary, buf, crypto.randomBytes(4))),
        end: () => socket.destroy(),
      };
      const read = chunk => {
        for (const f of reader.push(chunk)) {
          if (f.opcode === ws.OP.ping) socket.write(ws.frame(ws.OP.pong, f.payload, crypto.randomBytes(4)));
          else if (f.opcode === ws.OP.close) link.closed = true;
          else if (f.opcode <= 2) link.onData?.(f.payload);
        }
      };
      socket.on('data', read);
      socket.on('error', () => {});
      socket.on('close', () => { link.closed = true; });
      if (head.length) read(head);
      resolve(link);
    });
    req.on('error', reject);
    req.end();
  });
}

// A VNC server on that link: version, no security, ServerInit, and the screen for the first update asked for.
function rfbServer(link, { width, height, color, got }) {
  let buf = Buffer.alloc(0);
  let stage = 'version';
  let fmt = { bytes: 4, big: false, rs: 16, gs: 8, bs: 0 };
  let sent = false;
  const take = n => { const b = buf.subarray(0, n); buf = buf.subarray(n); return b; };
  const serverInit = () => {
    const name = Buffer.from('Desk Pi');
    const b = Buffer.alloc(24 + name.length);
    b.writeUInt16BE(width, 0);
    b.writeUInt16BE(height, 2);
    Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(b, 4);
    b.writeUInt32BE(name.length, 20);
    name.copy(b, 24);
    return b;
  };
  const screen = () => {
    const head = Buffer.alloc(16);
    head[0] = 0; // FramebufferUpdate
    head.writeUInt16BE(1, 2);
    head.writeUInt16BE(width, 8);
    head.writeUInt16BE(height, 10);
    head.writeInt32BE(0, 12); // raw
    const px = Buffer.alloc(width * height * fmt.bytes);
    const value = ((color[0] << fmt.rs) | (color[1] << fmt.gs) | (color[2] << fmt.bs)) >>> 0;
    for (let i = 0; i < width * height; i++) (fmt.big ? px.writeUInt32BE(value, i * 4) : px.writeUInt32LE(value, i * 4));
    return Buffer.concat([head, px]);
  };
  link.send(Buffer.from('RFB 003.008\n'));
  link.onData = d => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (stage === 'version') { if (buf.length < 12) return; take(12); link.send(Buffer.from([1, 1])); stage = 'security'; continue; }
      if (stage === 'security') { if (buf.length < 1) return; take(1); link.send(Buffer.alloc(4)); stage = 'init'; continue; }
      if (stage === 'init') { if (buf.length < 1) return; take(1); link.send(serverInit()); stage = 'normal'; continue; }
      if (!buf.length) return;
      const type = buf[0];
      if (type === 2) { if (buf.length < 4 || buf.length < 4 + 4 * buf.readUInt16BE(2)) return; take(4 + 4 * buf.readUInt16BE(2)); continue; }
      if (type === 6) { if (buf.length < 8 || buf.length < 8 + buf.readInt32BE(4)) return; const n = buf.readInt32BE(4); take(8); got.cut.push(take(n).toString('latin1')); continue; }
      const len = { 0: 20, 3: 10, 4: 8, 5: 6 }[type];
      if (!len) { got.unknown.push(type); buf = Buffer.alloc(0); return; }
      if (buf.length < len) return;
      const m = take(len);
      if (type === 0) fmt = { bytes: m[4] / 8, big: m[6] === 1, rs: m[14], gs: m[15], bs: m[16] };
      else if (type === 3 && !sent) { sent = true; link.send(screen()); } // (later, incremental: nothing changes)
      else if (type === 4) got.keys.push({ down: m[1] === 1, keysym: m.readUInt32BE(4) });
      else if (type === 5) got.pointer.push({ mask: m[1], x: m.readUInt16BE(2), y: m.readUInt16BE(4) });
    }
  };
  // The computer's clipboard changed (ServerCutText).
  return { cut: text => { const t = Buffer.from(text, 'latin1'); const b = Buffer.alloc(8); b[0] = 3; b.writeUInt32BE(t.length, 4); link.send(Buffer.concat([b, t])); } };
}

// The computer: Beam for Linux 1.2 with remote control on (or not), its stream open; every vnc session asked of it is
// leased, joined and served.
async function fakePi(ctx, { allow = true, width = 64, height = 48, color = [0, 128, 255] } = {}) {
  const id = `pi${ctx.uid()}${ctx.uid()}`.slice(0, 16);
  const dev = ctx.srv.device(id, `Desk Pi ${ctx.uid().slice(0, 4)}`, 'linux', ctx.nextIp(), '1.2.0');
  dev.headers['X-Beam-Profile'] = 'ab'.repeat(8);
  await dev.me();
  eq((await dev.putStatus({ remoteControl: allow })).status, 204, 'the computer says whether it allows control');
  const stream = dev.stream();
  const pi = { id, name: dev.name, dev, got: { pointer: [], keys: [], cut: [], unknown: [] }, links: [], servers: [], stream, served: new Set() };
  const port = Number(new URL(ctx.srv.base).port);
  const timer = setInterval(async () => {
    for (const e of stream.events) {
      if (e.event !== 'rc-request' || e.data.kind !== 'vnc' || pi.served.has(e.data.id)) continue;
      pi.served.add(e.data.id);
      try {
        await dev.post(`/api/rc/sessions/${e.data.id}/lease`);
        const link = await wsClient(port, `/api/rc/sessions/${e.data.id}/vnc`, dev.headers);
        pi.links.push(link);
        pi.servers.push(rfbServer(link, { width, height, color, got: pi.got }));
      } catch (err) { pi.error = err.message; }
    }
  }, 50);
  ctx.defer(() => { clearInterval(timer); stream.close(); for (const l of pi.links) l.end(); });
  return pi;
}

const state = page => page.evaluate(`document.querySelector('#remote')?.dataset.state || ''`);
const pixel = page => page.evaluate(`(() => { const c = document.querySelector('.rc-vnc canvas'); if (!c || !c.width) return null; const d = c.getContext('2d').getImageData(5, 5, 1, 1).data; return [d[0], d[1], d[2]]; })()`);

export default function register(test) {
  test('Control for a Linux computer (1.23): its screen through Beam with noVNC, its mouse and keys, its clipboard, Disconnect; the PCs’ viewer moves over; one that doesn’t allow it says so', async ctx => {
    const pi = await fakePi(ctx);
    const page = await ctx.signedIn();
    // Control on its page: the VNC viewer
    await page.waitFor(`deviceById('${pi.id}')?.can?.remoteControl === true`, 8000, 'the computer can be controlled');
    eq(await page.evaluate(`rcActions(deviceById('${pi.id}')).map(a => a.label)`), ['Control'], 'Control on its page');
    await page.goto('about:blank');
    await page.goto(`${ctx.srv.base}/#vnc=${pi.id}`);
    try {
      await page.waitFor(`document.querySelector('#remote')?.dataset.state === 'live'`, 15000, 'its screen is on');
    } catch (err) {
      throw new Error(`${err.message}: the page says "${await page.evaluate(`document.querySelector('#remote')?.textContent || document.body.textContent.slice(0, 200)`)}"; the computer: ${pi.error || 'no error'}, ${pi.links.length} link(s)`);
    }
    await page.waitFor(`(() => { const c = document.querySelector('.rc-vnc canvas'); if (!c || !c.width) return false; const d = c.getContext('2d').getImageData(5, 5, 1, 1).data; return d[0] === 0 && d[1] === 128 && d[2] === 255; })()`, 8000, 'its picture');
    eq(await pixel(page), [0, 128, 255], 'the colour of its screen');
    eq(await page.evaluate(`document.title`), `${pi.name} · Beam`, 'the window says which computer');
    // A click in the middle of the screen, and a key, reach the computer
    const mid = await page.evaluate(`(r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }))(document.querySelector('.rc-vnc canvas').getBoundingClientRect())`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mid.x, y: mid.y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mid.x, y: mid.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mid.x, y: mid.y, button: 'left', clickCount: 1 });
    const t0 = Date.now();
    while (!pi.got.pointer.some(p => p.mask === 1) && Date.now() - t0 < 5000) await sleep(50);
    const press = pi.got.pointer.find(p => p.mask === 1);
    assert(press && Math.abs(press.x - 32) <= 2 && Math.abs(press.y - 24) <= 2, `the press at the middle of its 64×48 screen: ${JSON.stringify(pi.got.pointer.slice(0, 4))}`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyA', key: 'a', text: 'a', windowsVirtualKeyCode: 65 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyA', key: 'a', windowsVirtualKeyCode: 65 });
    const t1 = Date.now();
    while (pi.got.keys.length < 2 && Date.now() - t1 < 5000) await sleep(50);
    eq(pi.got.keys.slice(0, 2), [{ down: true, keysym: 0x61 }, { down: false, keysym: 0x61 }], 'the key, down and up');
    // What was copied on the computer: a Copy button here
    pi.servers[0].cut('copied on the Pi');
    await page.waitFor(`Boolean(document.querySelector('.rc-tool[data-tool="copy"]'))`, 5000, 'Copy appears');
    if (process.argv.includes('--shots')) await page.screenshot(path.join(ctx.SHOTS, 'vnc-live.png'));
    eq(pi.got.unknown, [], 'nothing the little VNC server didn’t expect');
    // Disconnect: the session ends for both, and the page offers to connect again
    await page.evaluate(`document.querySelector('.rc-tool.danger').click()`);
    await page.waitFor(`document.querySelector('#remote')?.dataset.state === 'ended'`, 5000, 'ended');
    await page.waitFor(`/Disconnected/.test(document.querySelector('.rc-card').textContent) && /Connect again/.test(document.querySelector('.rc-card').textContent)`, 5000, 'says so');
    const t2 = Date.now();
    while (!pi.stream.events.some(e => e.event === 'rc-end') && Date.now() - t2 < 5000) await sleep(50);
    eq(pi.stream.events.filter(e => e.event === 'rc-end').map(e => e.data.reason), ['stopped'], 'the computer heard it end');
    assert(pi.links[0].closed, 'and its end of the relay was closed');

    // The PCs' viewer for it (what the Windows app's viewer window opens) moves over to this one
    await page.goto('about:blank');
    await page.goto(`${ctx.srv.base}/#remote=${pi.id}`);
    await page.waitFor(`location.hash === '#vnc=${pi.id}' && document.querySelector('#remote')?.dataset.state === 'live'`, 15000, 'moved over, and on');
    await page.evaluate(`document.querySelector('.rc-tool.danger').click()`);
    await page.waitFor(`document.querySelector('#remote')?.dataset.state === 'ended'`, 5000, 'ended again');

    // A computer that doesn't allow it: why, and what to do there
    const off = await fakePi(ctx, { allow: false });
    await page.goto('about:blank');
    await page.goto(`${ctx.srv.base}/#vnc=${off.id}`);
    await page.waitFor(`document.querySelector('#remote')?.dataset.state === 'ended'`, 10000, 'refused');
    const card = await page.evaluate(`document.querySelector('.rc-card').textContent`);
    assert(/Remote control is off there/.test(card) && /beam control on/.test(card), `the card: ${card}`);
    if (process.argv.includes('--shots')) await page.screenshot(path.join(ctx.SHOTS, 'vnc-not-allowed.png'));
    eq(await state(page), 'ended', 'still ended');
    eq(page.errors, [], 'no page errors');
  }, { requires: 'vnc' });
}
