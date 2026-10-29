#!/usr/bin/env node
// Beam for Windows 1.21: Windows' own notifications (Toasts.cs). A test instance can't show one (its registration stays
// in a sandbox, and nothing may pop up on this desktop), so it describes each in beam.log (--test-toasts on) and is told
// of clicks as Windows would tell it (--test-toasts click:<arguments>|<reply>): what a text and a file that came show
// (Reply to the sender, Copy, Open link; Open, Save), that Reply sends the text back to that device (from this run's
// notification and from an earlier run's, by its arguments), that arguments from outside can't name anything but ids,
// that Windows' "-Embedding" start is never a file to send, and the setting. Exits 1 if a check fails.
//
//   node test/perf/windows-toasts.mjs [--exe <Beam.exe>] [--keep]
//
// Isolated like the other windows-* checks: a scratch server (this checkout's server.js) on 127.0.0.1:8809 and a copy
// of Beam.exe with --config in a temp folder (quiet, off-screen). Nothing is clicked or typed; no clipboard, no browser.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = 8809;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const exeArg = args.indexOf('--exe');
const EXE = exeArg >= 0 ? args[exeArg + 1] : [path.join(ROOT, 'windows', 'bin', 'Beam.exe'), path.join(ROOT, 'dist', 'Beam.exe')].find(f => fs.existsSync(f));
const KEEP = args.includes('--keep');
const TMP = path.join(os.tmpdir(), `beam-toasts-win-${Date.now()}`);
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); return ok; };
const dir = p => path.join(TMP, p);
for (const d of ['data', 'dist', 'app', 'cfg']) fs.mkdirSync(dir(d), { recursive: true });
const base = `http://127.0.0.1:${PORT}`;
const appExe = dir('app/Beam.exe');
const env = { ...process.env, BEAM_LOCAL_URLS: base, BEAM_TEST_PEERS: base };
let server, app, key, exited = false;

async function startServer() {
  const out = fs.openSync(dir('server.out.log'), 'a');
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, BEAM_TAILSCALE: 'off', BEAM_HOST: '127.0.0.1', BEAM_PORT: String(PORT), BEAM_DATA: dir('data'), BEAM_DIST: dir('dist') } });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/api/hello`)).ok) break; } catch {} await sleep(200); }
}

const as = (id, name) => ({ Authorization: `Bearer ${key}`, 'X-Beam-Device-Id': id, 'X-Beam-Device': encodeURIComponent(name), 'X-Beam-Platform': 'android', 'X-Forwarded-For': '100.64.21.10' });
async function call(h, method, p, body, raw = false) {
  const r = await fetch(base + p, { method, headers: { ...h, ...(body !== undefined && { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }) }, ...(body !== undefined && { body: raw ? body : JSON.stringify(body) }) });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
const logPath = dir('cfg/beam.log');
const lines = () => { try { return fs.readFileSync(logPath, 'utf8').split(/\r?\n/); } catch { return []; } };
async function waitLog(re, ms = 15000, from = 0) {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(100)) { const l = lines().slice(from).find(x => re.test(x)); if (l) return l; }
  return null;
}
async function waitFor(fn, ms = 15000, step = 200) {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(step)) { const v = await fn(); if (v) return v; }
  return null;
}
// The notification described last (after line `from`): its XML.
const toastAfter = async from => (await waitLog(/Toast \(test\): /, 15000, from))?.replace(/.*Toast \(test\): /, '') || '';
const attr = (xml, re) => (re.exec(xml) || [])[1] || '';
const unesc = s => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

try {
  if (!EXE) throw new Error('No Beam.exe: build with windows\\build.cmd or pass --exe');
  fs.copyFileSync(EXE, appExe);
  console.log(`Beam: ${EXE}\ntemp: ${TMP}`);
  await startServer();
  key = fs.readFileSync(dir('data/key'), 'utf8').trim();
  const phone = as(`phone${crypto.randomBytes(5).toString('hex')}`, 'Robin Phone');
  await call(phone, 'GET', '/api/me');
  const phoneId = phone['X-Beam-Device-Id'];
  const pcId = `toastpc${crypto.randomBytes(6).toString('hex')}`;
  const made = await (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Beam-Platform': 'windows' },
    body: JSON.stringify({ secret: key, client: 'app', platform: 'windows', deviceId: pcId }) })).json();
  if (!made.key) throw new Error('no device token for the PC');
  const cfgDir = dir('cfg');
  const cfgPath = path.join(cfgDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ server: base, key: made.key, deviceId: pcId, deviceName: 'Test PC', quiet: true, testOffscreen: true,
    autoUpdate: false, autostartInitialized: true, sendToMenu: false, outbox: false, autoCopy: false, autoSave: false }, null, 2));
  app = spawn(appExe, ['--config', cfgPath, '--background'], { env, windowsHide: true, stdio: 'ignore' });
  app.on('exit', () => { exited = true; });
  const forward = a => spawnSync(appExe, ['--config', cfgPath, ...a], { env, windowsHide: true, timeout: 20000 });
  const online = await waitFor(async () => (await call(phone, 'GET', '/api/devices')).json?.devices?.find(x => x.id === pcId && x.online), 30000);
  await sleep(3000); // (its first start swaps the sign-in for one bound to its device key, and connects again)
  check(!!online, 'the PC is online');
  forward(['--test-toasts', 'on']);
  check(!!(await waitLog(/Notifications \(test\): described, not shown/)), 'notifications described in beam.log (--test-toasts on)');

  // A text that came: Reply to the sender, Copy
  let at = lines().length;
  const text = (await call(phone, 'POST', '/api/text', { text: 'Are you at the desk?', to: [pcId] })).json;
  let xml = await toastAfter(at);
  const launch = unesc(attr(xml, /<toast launch="([^"]*)"/));
  check(launch === `t=${launch.match(/t=(\d+)/)?.[1]};i=${text?.id};d=${phoneId}`, `a text: the click's arguments name the notification, the item and the sender (${launch})`);
  check(/<text>Text from Robin Phone<\/text><text>Are you at the desk\?<\/text>/.test(xml) && !/Click to/.test(xml), 'its title and text, without a balloon\'s "Click to…"');
  check(/<input id="reply" type="text" placeHolderContent="Reply to Robin Phone"\/>/.test(xml) && new RegExp(`<action content="Send" hint-inputId="reply" activationType="background" arguments="${launch.replace(/[;.]/g, m => `\\${m}`)};a=reply"/>`).test(xml), 'a Reply box with Send');
  check(new RegExp(`<action content="Copy" activationType="background" arguments="[^"]*;a=b0"/>`).test(xml), 'Copy');
  // Reply: the text goes back to the phone, from the PC
  at = lines().length;
  forward(['--test-toasts', `click:${launch};a=reply|On my way`]);
  check(!!(await waitLog(/Notification: a reply to Robin Phone sent/, 15000, at)), 'Reply: sent');
  const items = async () => (await call(phone, 'GET', '/api/items')).json?.items || [];
  let reply = await waitFor(async () => (await items()).find(i => i.kind === 'text' && i.text === 'On my way'), 10000);
  check(!!reply && reply.from === pcId && JSON.stringify(reply.to) === JSON.stringify([phoneId]), `...from the PC to the phone alone (${reply && `${reply.from} → ${reply.to}`})`);
  // A click on one from an earlier run: its arguments are enough
  at = lines().length;
  forward(['--test-toasts', `click:t=99999;i=${text.id};d=${phoneId};a=reply|From an earlier one`]);
  check(!!(await waitLog(/Notification clicked \(reply\), from an earlier run/, 15000, at)) && !!(await waitFor(async () => (await items()).find(i => i.text === 'From an earlier one'), 10000)), 'Reply from an earlier run\'s notification: sent by its arguments');
  // Arguments from outside name ids only: a made-up device gets nothing
  at = lines().length;
  forward(['--test-toasts', `click:t=99998;d=..\\..\\x;a=reply|Never`]);
  await waitLog(/Notification clicked \(reply\)/, 15000, at);
  await sleep(1500);
  check(!(await items()).some(i => i.text === 'Never'), 'a device that isn\'t an id: nothing sent');
  // An empty reply sends nothing
  at = lines().length;
  forward(['--test-toasts', `click:${launch};a=reply|   `]);
  await waitLog(/Notification clicked \(reply\)/, 15000, at);
  await sleep(1000);
  check(!lines().slice(at).some(l => /a reply to/.test(l)), 'an empty reply: nothing sent');

  // A link: Open link (not clicked: it would open a browser)
  at = lines().length;
  await call(phone, 'POST', '/api/text', { text: 'https://example.com/plan', to: [pcId] });
  xml = await toastAfter(at);
  check(/<text>Link from Robin Phone<\/text>/.test(xml) && /<action content="Open link" [^>]*a=b0"\/>/.test(xml) && /<action content="Copy" [^>]*a=b1"\/>/.test(xml), 'a link: Open link, Copy');

  // A file that came (not saved by itself here): Open, Save, and Reply
  at = lines().length;
  const up = (await call(phone, 'POST', '/api/uploads', { name: 'plan.pdf', size: 5, to: [pcId] })).json;
  await call(phone, 'PUT', `/api/uploads/${up.id}?offset=0`, Buffer.from('%PDF-'), true);
  xml = await toastAfter(at);
  check(/<text>File from Robin Phone<\/text><text>plan\.pdf \(5 B\)<\/text>/.test(xml), `a file: its name and size (${xml.slice(0, 200)})`);
  check(/<action content="Open" [^>]*a=b0"\/>/.test(xml) && /<action content="Save" [^>]*a=b1"\/>/.test(xml) && /<input id="reply"/.test(xml), '...Open, Save, Reply');

  // Windows starting Beam for a click (--toast-activated -Embedding): never a file to send, no window
  at = lines().length;
  forward(['--toast-activated', '-Embedding']);
  await sleep(2000);
  check(!lines().slice(at).some(l => /Embedding/.test(l) && /[Ss]end/.test(l)) && !(await items()).some(i => /Embedding/.test(i.name || '')), 'Windows\' "-Embedding" start: nothing sent');

  // The setting: the page sees it and can turn it off (balloons again)
  forward(['--test-bridge', JSON.stringify({ type: 'getSettings', id: 'test-toasts-get' })]);
  const got = await waitLog(/Bridge test reply: .*"id":"test-toasts-get"/);
  check(!!got && got.includes('"nativeToasts":true'), 'the page sees "nativeToasts": true');
  forward(['--test-bridge', JSON.stringify({ type: 'setSettings', id: 'test-toasts-set', settings: { nativeToasts: false } })]);
  await waitLog(/Bridge test reply: .*"id":"test-toasts-set"/);
  await sleep(500);
  check(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).nativeToasts === false, 'it can turn them off (kept in the config)');
} catch (err) {
  check(false, `the run: ${err && err.stack || err}`);
} finally {
  if (app && !exited) {
    spawnSync(appExe, ['--config', dir('cfg/config.json'), '--quit'], { env, windowsHide: true, timeout: 20000 });
    for (let i = 0; i < 80 && !exited; i++) await sleep(250);
    if (!exited) { try { app.kill(); } catch {} }
  }
  if (server) { try { server.kill(); } catch {} }
  await sleep(500);
  if (!KEEP && !failures.length) fs.rmSync(TMP, { recursive: true, force: true });
  else console.log(`kept ${TMP}`);
  console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nAll notification checks passed.');
  process.exit(failures.length ? 1 : 0);
}
