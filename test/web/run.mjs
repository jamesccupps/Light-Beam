// End-to-end tests for the web app (public/) in headless Edge/Chrome, against scratch servers started from
// ../../server.js. Nothing touches a real Beam: servers, proxies and the browser listen on 127.0.0.1:8821-8829
// only, with data in a temp folder.
//
//   node test/web/run.mjs                 run everything (about 10 minutes)
//   node test/web/run.mjs --only upload   run tests whose name matches /upload/i (a regular expression)
//   node test/web/run.mjs --shots         also save screenshots to test/web/shots/
//   node test/web/run.mjs --list          list the tests
//
// The browser: Edge, Chrome or Chromium where they usually are (cdp.mjs), or BEAM_TEST_BROWSER=<path>; extra flags in
// BEAM_TEST_BROWSER_ARGS (as root, --no-sandbox and --disable-dev-shm-usage go in by themselves). Chromium as Linux
// distributions ship it plays no H.264, so the one test that needs it says so and passes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, launchBrowser, sleep } from './cdp.mjs';
import { Scratch, FaultProxy, PrefixProxy, TMP } from './harness.mjs';
import coreTests from './tests-core.mjs';
import uploadTests from './tests-upload.mjs';
import signinTests from './tests-signin.mjs';
import offlineTests from './tests-offline.mjs';
import hostTests from './tests-host.mjs';
import featureTests from './tests-features.mjs';
import deviceTests from './tests-devices.mjs';
import speedTests from './tests-speed.mjs';
import phoneTests from './tests-phone.mjs';
import remoteTests from './tests-remote.mjs';
import familyTests, { registerLink as familyLinkTests } from './tests-family.mjs';
import galleryTests from './tests-gallery.mjs';
import chatTests from './tests-chat.mjs';
import shotTests from './tests-shots.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const opt = name => (args.includes(name) ? args[args.indexOf(name) + 1] : '');
const only = opt('--only');
const SERVER = path.resolve(opt('--server') || path.join(ROOT, 'server.js'));
const CDP_PORT = 8829;

const tests = [];
const test = (name, fn, options = {}) => tests.push({ name, fn, ...options });
for (const register of [coreTests, uploadTests, signinTests, offlineTests, hostTests, featureTests, galleryTests, chatTests, deviceTests, speedTests, phoneTests, remoteTests, familyTests, familyLinkTests]) register(test);
if (args.includes('--shots')) shotTests(test);
if (args.includes('--list')) { for (const t of tests) console.log(t.name); removeTmp(); process.exit(0); }

let ipSeq = 20;
const ctx = {
  ROOT, HERE, SERVER, TMP, SHOTS: path.join(HERE, 'shots'),
  browser: null,
  srv: null,
  sleep,
  nextIp: () => { ipSeq++; return `100.64.${Math.floor(ipSeq / 250) + 1}.${(ipSeq % 250) + 1}`; },
  uid: () => Math.random().toString(36).slice(2, 10),
  // A browser (own profile) signed in to `server` through `base` (a proxy in front of it, or the server itself).
  async signedIn({ server = ctx.srv, base = server.base, ...opts } = {}) {
    await ctx.denyPending(server); // sign-in requests other tests left behind would pop up here
    const page = await ctx.browser.newPage({ xff: ctx.nextIp(), ...opts });
    await page.goto(await ctx.keyLink(server, base));
    await page.waitFor(`typeof paired !== 'undefined' && paired && net.state === 'online'`, 15000, 'signed in and online');
    return page;
  },
  // A pairing link to `server` through `base` (since 1.7.3 a link signs in only with a pairing key, never the key).
  async keyLink(server = ctx.srv, base = server.base) {
    const res = await fetch(`${server.base}/api/pair`, { headers: { Authorization: `Bearer ${server.key}` } });
    const { key } = await res.json();
    if (!key?.startsWith('bp_')) throw new Error(`no pairing key from ${server.base} (HTTP ${res.status})`);
    return `${base}/?key=${encodeURIComponent(key)}`;
  },
  async denyPending(server = ctx.srv) {
    const auth = { Authorization: `Bearer ${server.key}`, 'Content-Type': 'application/json' };
    const { requests = [] } = await (await fetch(`${server.base}/api/login-requests`, { headers: auth })).json().catch(() => ({}));
    for (const r of requests) await fetch(`${server.base}/api/login-requests/deny`, { method: 'POST', headers: auth, body: JSON.stringify({ code: r.code }) });
  },
  async startServer(port, env = {}) { return new Scratch(SERVER, port, env).start(); },
  async proxy(port, upstream) { return new FaultProxy(port, upstream).start(); },
  async prefixProxy(port, upstream, prefix) { return new PrefixProxy(port, upstream, prefix).start(); },
  // Pretend the tab went to the background / came back (headless tabs are always "visible").
  async setHidden(page, hidden) {
    await page.evaluate(`(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => ${hidden ? "'hidden'" : "'visible'"} });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => ${hidden} });
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);
  },
  // Record requests whose URL matches a pattern.
  track(page, pattern) {
    const seen = [];
    page.on(m => {
      if (m.method === 'Network.requestWillBeSent' && pattern.test(m.params.request.url)) seen.push({ method: m.params.request.method, url: m.params.request.url, body: m.params.request.postData, t: Date.now() });
    });
    return seen;
  },
  async setFiles(page, selector, files) {
    const { root } = await page.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    await page.send('DOM.setFileInputFiles', { nodeId, files });
  },
};

// The browser's helper processes can hold its profile for a moment after it quits: retry, and never fail the run over it.
function removeTmp() {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch (err) { console.log(`(couldn’t remove ${TMP}: ${err.code})`); }
}

let browserProc = null;
async function main() {
  const started = Date.now();
  browserProc = await launchBrowser(CDP_PORT, path.join(TMP, 'browser-profile'));
  ctx.browser = new Browser(CDP_PORT);
  ctx.srv = await ctx.startServer(8821);
  // Tests of a newer feature (`requires`) are skipped against a server without it.
  ctx.features = new Set((await (await fetch(`${ctx.srv.base}/api/info`, { headers: { Authorization: `Bearer ${ctx.srv.key}` } })).json()).features || []);
  console.log(`server ${SERVER}\nAPI ${ctx.srv.hello.api}, version ${ctx.srv.hello.version}\n`);
  let passed = 0;
  const failed = [];
  const skipped = [];
  for (const t of tests) {
    if (only && !new RegExp(only, 'i').test(t.name)) continue;
    if (t.requires && !ctx.features.has(t.requires)) { skipped.push(t.name); console.log(`  skip  ${t.name} (the server has no ${t.requires})`); continue; }
    const t0 = Date.now();
    const pages = [];
    const orig = ctx.browser.newPage.bind(ctx.browser);
    ctx.browser.newPage = async o => { const p = await orig(o); pages.push(p); return p; };
    const cleanups = [];
    ctx.defer = fn => cleanups.push(fn);
    try {
      await Promise.race([t.fn(ctx), sleep(t.timeout || 120000).then(() => { throw new Error(`timed out after ${(t.timeout || 120000) / 1000} s`); })]);
      const errors = pages.flatMap(p => p.errors).filter(e => !/net::ERR|Failed to load resource|favicon/i.test(e));
      if (errors.length && !t.allowErrors) throw new Error(`page errors: ${errors.slice(0, 3).join(' | ')}`);
      passed++;
      console.log(`  ok    ${t.name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (err) {
      failed.push(t.name);
      console.log(`  FAIL  ${t.name} (${((Date.now() - t0) / 1000).toFixed(1)} s)\n        ${String((process.env.BEAM_TEST_STACK && err.stack) || err.message || err).split('\n').join('\n        ')}`);
    } finally {
      ctx.browser.newPage = orig;
      for (const fn of cleanups.reverse()) { try { await fn(); } catch {} }
      for (const p of pages) await p.close().catch(() => {});
    }
  }
  await ctx.srv.stop();
  ctx.browser.close();
  await browserProc.stop();
  if (!args.includes('--keep')) removeTmp();
  console.log(`\n${passed} passed, ${failed.length} failed${skipped.length ? `, ${skipped.length} skipped` : ''} (${Math.round((Date.now() - started) / 1000)} s)`);
  if (failed.length) console.log(`failed: ${failed.join(', ')}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async err => {
  console.error(err);
  try { await ctx.srv?.stop(); } catch {}
  try { ctx.browser?.close(); await browserProc?.stop(); } catch {}
  if (!args.includes('--keep')) removeTmp();
  process.exit(2);
});
