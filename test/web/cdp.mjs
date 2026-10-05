// Minimal Chrome DevTools Protocol client for a HEADLESS Edge/Chrome with its own throwaway profile.
// Pages are only ever pointed at scratch servers on 127.0.0.1 (see guard()).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function guard(u) {
  if (u === 'about:blank') return;
  const x = new URL(u);
  if (x.hostname !== '127.0.0.1' || !/^88(2\d)$/.test(x.port)) throw new Error(`refusing non-scratch url ${u}`);
}

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge',
];

// Starts a headless browser on `port` unless one already answers there. Returns a stop() function.
export async function launchBrowser(port, profileDir) {
  try { await fetch(`http://127.0.0.1:${port}/json/version`); return { stop: async () => {} }; } catch {}
  const exe = process.env.BEAM_TEST_BROWSER || BROWSERS.find(p => fs.existsSync(p));
  if (!exe) throw new Error('No Edge/Chrome found (set BEAM_TEST_BROWSER)');
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(exe, [`--headless=new`, `--remote-debugging-port=${port}`, '--remote-allow-origins=*', `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--disable-component-update', 'about:blank'], { stdio: 'ignore' });
  const exited = new Promise(r => child.once('exit', r));
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(100); }
  }
  // stop(): asks the browser to quit (so it lets go of its profile), then makes sure it has.
  return {
    stop: async () => {
      try {
        const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        const ws = new WebSocket(v.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
        ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      } catch {}
      if (await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]) === false) child.kill();
      await Promise.race([exited, sleep(3000)]);
      await sleep(300);
    },
  };
}

export class Browser {
  constructor(port) { this.port = port; this.conn = null; }

  async browserConn() {
    if (this.conn) return this.conn;
    const v = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json();
    this.conn = await wsConn(v.webSocketDebuggerUrl);
    return this.conn;
  }

  // A page in a fresh browser context = a different browser (own cookies, storage, service workers).
  async newPage({ fresh = true, xff, width = 1280, height = 860, mobile = false, dark = false, init = [] } = {}) {
    const b = await this.browserConn();
    let contextId;
    if (fresh) contextId = (await b.send('Target.createBrowserContext', { disposeOnDetach: false })).browserContextId;
    // Never into the real Downloads folder: a test that wants a download allows it into a temp folder itself.
    await b.send('Browser.setDownloadBehavior', { behavior: 'deny', ...(contextId ? { browserContextId: contextId } : {}) }).catch(() => {});
    const { targetId } = await b.send('Target.createTarget', { url: 'about:blank', ...(contextId ? { browserContextId: contextId } : {}) });
    const conn = await wsConn(`ws://127.0.0.1:${this.port}/devtools/page/${targetId}`);
    const page = new Page(this, conn, targetId, contextId);
    await conn.send('Runtime.enable');
    await conn.send('Network.enable');
    await conn.send('Page.enable');
    await conn.send('Performance.enable');
    if (xff) await conn.send('Network.setExtraHTTPHeaders', { headers: { 'X-Forwarded-For': xff } });
    await page.viewport(width, height, mobile);
    await conn.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
    // The one-time "turn on notifications?" toast would race the toasts tests look at.
    await conn.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('beam.notifyOffered', '1'); } catch {}` });
    for (const src of init) await conn.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
    return page;
  }

  // Another tab in the same browser context as `page` (same cookies, IndexedDB, service worker). Closing it
  // leaves the context to the first page.
  async newTabBeside(page, { xff } = {}) {
    const b = await this.browserConn();
    const { targetId } = await b.send('Target.createTarget', { url: 'about:blank', browserContextId: page.contextId });
    const conn = await wsConn(`ws://127.0.0.1:${this.port}/devtools/page/${targetId}`);
    const tab = new Page(this, conn, targetId, undefined);
    await conn.send('Runtime.enable');
    await conn.send('Network.enable');
    await conn.send('Page.enable');
    if (xff) await conn.send('Network.setExtraHTTPHeaders', { headers: { 'X-Forwarded-For': xff } });
    await conn.send('Page.addScriptToEvaluateOnNewDocument', { source: "try { localStorage.setItem('beam.notifyOffered', '1'); } catch {}" });
    return tab;
  }

  close() { this.conn?.close(); }
}

async function wsConn(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) for (const l of listeners) l(m);
  });
  // (a browser that went away: every call waiting on it fails at once, instead of the run waiting for good)
  let gone = null;
  const lost = () => {
    gone ||= new Error('the browser closed its connection');
    for (const { reject } of pending.values()) reject(gone);
    pending.clear();
  };
  ws.addEventListener('close', lost);
  ws.addEventListener('error', lost);
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      if (gone) return reject(gone);
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    on: fn => listeners.add(fn),
    off: fn => listeners.delete(fn),
    close: () => ws.close(),
  };
}

export class Page {
  constructor(browser, conn, targetId, contextId) {
    this.browser = browser;
    this.conn = conn;
    this.targetId = targetId;
    this.contextId = contextId;
    this.logs = [];
    this.errors = [];
    conn.on(m => {
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = m.params.args.map(a => a.value ?? a.description ?? '').join(' ');
        this.logs.push(`${m.params.type}: ${text}`);
        if (m.params.type === 'error') this.errors.push(text);
      }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    });
  }
  send(method, params) { return this.conn.send(method, params); }
  on(fn) { this.conn.on(fn); }
  off(fn) { this.conn.off(fn); }
  async viewport(width, height, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async goto(u) {
    guard(u);
    const loaded = new Promise(r => { const f = m => { if (m.method === 'Page.loadEventFired') { this.off(f); r(); } }; this.on(f); });
    await this.send('Page.navigate', { url: u });
    await Promise.race([loaded, sleep(20000)]);
  }
  async reload() {
    const loaded = new Promise(r => { const f = m => { if (m.method === 'Page.loadEventFired') { this.off(f); r(); } }; this.on(f); });
    await this.send('Page.reload', {});
    await Promise.race([loaded, sleep(20000)]);
  }
  async waitFor(expr, ms = 10000, label = expr) {
    const end = Date.now() + ms;
    let last;
    for (;;) {
      try { last = await this.evaluate(expr); } catch (err) { last = err.message; }
      if (last === true || (last && typeof last !== 'string')) return last;
      if (Date.now() > end) throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)?.slice(0, 200)})`);
      await sleep(100);
    }
  }
  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }
  async close() {
    try { await this.browser.conn.send('Target.closeTarget', { targetId: this.targetId }); } catch {}
    if (this.contextId) { try { await this.browser.conn.send('Target.disposeBrowserContext', { browserContextId: this.contextId }); } catch {} }
    this.conn.close();
    await sleep(30);
  }
}
