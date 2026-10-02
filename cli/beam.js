#!/usr/bin/env node
// Beam command-line client: send files, text and clipboard contents to your
// Beam server, and receive what your other devices send. Speaks docs/API.md (v3, and v2 servers).
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { parseArgs } = require('node:util');

const CONFIG_FILE = path.join(os.homedir(), '.beam.json');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const DEFAULT_DIR = path.join(os.homedir(), 'Downloads', 'Beam');

const HELP = `Beam: send text, clipboard contents and files between your devices

Getting connected:
  beam login [address]                             sign in: automatically over Tailscale, else by approving
                                                   a code on a signed-in device (--password to use the password)
  beam setup <pairing-link> [--name "My Laptop"]   sign in with a pairing link instead
  beam status                                      server, sign-in and storage details

Sending:
  beam <file> [file...]   or   beam send <file>    send files
  beam -t "some text"   or   beam text some text   send text
  some-command | beam                              send piped text
  beam clip                                        send what's on the clipboard (files, image or text)
      --to <device>[,<device>...]                  with any of the above: send only to these devices
                                                   (names or ids; default: all devices)

Receiving:
  beam get [--no-copy]                             the latest text sent to you → clipboard (and printed)
  beam pull [folder]                               download the latest file sent to you (default: Downloads/Beam)
  beam listen                                      stay connected and receive automatically:
      --no-copy        don't put incoming text on the clipboard
      --no-save        don't save incoming files
      --no-notify      no desktop notifications
      --dir <folder>   where to save files (default: Downloads/Beam)
      --max-save <MB>  only auto-save files up to this size (default: 1024)

Everything else:
  beam devices                                     list your devices (● online)
  beam ls [count]                                  list recent items (with their ids)
  beam rm <id> [id...]                             delete items (ids or the start of them, from beam ls)
  beam approve <code> [--yes]                      let a new device in (the code it shows)
  beam open [--pair]                               open Beam in your browser (--pair: show "Add device")
  beam pair                                        show a one-time pairing link and QR code

Add --toast to any command to report the result as a desktop notification.`;

// ---------------------------------------------------------------- config

const sha256 = s => crypto.createHash('sha256').update(s).digest();
const newDeviceId = () => crypto.randomBytes(12).toString('hex');

// Runs configured only through BEAM_URL/BEAM_KEY still get one stable identity per computer and user, so they
// don't show up as a new device every time.
const stableDeviceId = () => sha256(`beam-cli:${os.hostname()}:${os.userInfo().username}`).toString('hex').slice(0, 24);

function readConfigFile() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; }
}

function saveConfig(changes) {
  const saved = readConfigFile();
  if (!saved) return false; // configured through the environment: nothing to update
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...saved, ...changes }, null, 2) + '\n', { mode: 0o600 });
  return true;
}

function loadConfig() {
  const file = readConfigFile() || {};
  // Configs from before devices existed get a permanent device id on first use.
  if (file.url && !file.deviceId) {
    file.deviceId = newDeviceId();
    saveConfig({ deviceId: file.deviceId });
  }
  const cfg = { ...file };
  cfg.url = (process.env.BEAM_URL || file.url || '').replace(/\/+$/, '');
  cfg.key = process.env.BEAM_KEY || file.key;
  cfg.device = process.env.BEAM_DEVICE || file.device || os.hostname();
  cfg.deviceId = process.env.BEAM_DEVICE_ID || file.deviceId || stableDeviceId();
  return cfg;
}

function requireConfig(cfg) {
  if (!cfg.url || !cfg.key) {
    throw new Error('This computer isn\'t signed in to Beam yet. Run:  beam login  (or beam setup "<pairing link>")');
  }
  return cfg;
}

// ---------------------------------------------------------------- server calls

async function api(cfg, route, options = {}) {
  let res;
  try {
    res = await fetch(cfg.url + route, {
      ...options,
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        'X-Beam-Device-Id': cfg.deviceId,
        'X-Beam-Device': encodeURIComponent(cfg.device),
        'X-Beam-Platform': 'cli',
        ...options.headers,
      },
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw Object.assign(new Error(`Can't reach Beam at ${cfg.url} (${err.cause?.code || err.message})`), { network: true });
  }
  adoptServerHints(cfg, res);
  if (res.status === 401) throw new Error('Beam doesn\'t accept this computer\'s sign-in any more (it may have been removed). Run  beam login  again.');
  if (res.status === 410 && !options.moved) {
    // Beam moved to another machine (docs/API.md "When the server moves"): follow it and remember.
    const body = await res.json().catch(() => ({}));
    if (body.movedTo && !options.body && await followMove(cfg, body.movedTo)) return api(cfg, route, { ...options, moved: true });
    throw Object.assign(new Error(body.movedTo ? `Beam has moved to ${body.movedTo}, and that server couldn't prove it's yours` : 'Beam has moved'), { status: 410, body });
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status, body });
  }
  return res;
}

// The server tells old sign-ins their own device token (X-Beam-Token) and a merged device its new id (X-Beam-You).
function adoptServerHints(cfg, res) {
  const token = res.headers.get('x-beam-token');
  if (token && token !== cfg.key && /^bt_[\w-]+$/.test(token) && !process.env.BEAM_KEY) {
    if (saveConfig({ key: token })) cfg.key = token;
  }
  const you = res.headers.get('x-beam-you');
  if (you && you !== cfg.deviceId && /^[A-Za-z0-9_-]{8,64}$/.test(you)) {
    cfg.deviceId = you;
    saveConfig({ deviceId: you });
  }
}

// Asks a server to prove it holds our key (an HMAC over a fresh nonce) without sending the key.
async function verifyServer(base, cfg) {
  const nonce = crypto.randomBytes(16).toString('base64url');
  const h1 = sha256(cfg.key);
  const tid = crypto.createHash('sha256').update(h1).digest('hex').slice(0, 16);
  const hello = await (await fetch(`${base}/api/hello?nonce=${nonce}&tid=${tid}`, { signal: AbortSignal.timeout(15_000) })).json();
  if (!hello.beam || !cfg.serverId || hello.serverId !== cfg.serverId) return null;
  if (hello.api >= 3) {
    const expected = crypto.createHmac('sha256', h1).update(`${hello.serverId}:${nonce}`).digest('hex');
    if (hello.proof !== expected) return null;
  }
  return hello;
}

async function followMove(cfg, movedTo) {
  try {
    const base = movedTo.replace(/\/+$/, '');
    if (!(await verifyServer(base, cfg))) return false;
    cfg.url = base;
    saveConfig({ url: base });
    console.error(`beam: Beam moved to ${base}; settings updated.`);
    return true;
  } catch {
    return false;
  }
}

// `to` is a list of device names or ids (the server resolves names); empty = all devices.
const parseTargets = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);

async function sendText(cfg, text, to = []) {
  const res = await api(cfg, '/api/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, to }) });
  return res.json();
}

// Chunks for a server that allows big ones (maxChunkSize, Beam 1.4): about 4 s of transfer each at the rate the last
// one reached, at least 64 MB. Each chunk costs a round trip, so small ones leave a fast link idle.
const BIG_CHUNK_MIN = 64 * 1024 * 1024;
const CHUNK_SECONDS = 4;

// Resumable, chunked upload (see docs/API.md), so big files survive dropped connections.
async function sendFile(cfg, file, { name, quiet, to = [] } = {}) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat) throw new Error(`No such file: ${file}`);
  if (stat.isDirectory()) throw new Error(`${file} is a folder. Zip it first, then send the zip.`);
  name ||= path.basename(file);
  const showProgress = !quiet && process.stderr.isTTY && stat.size > 2 * 1024 * 1024;
  const upload = await (await api(cfg, '/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, size: stat.size, to }),
  })).json();

  let offset = upload.offset;
  let failures = 0;
  const adaptive = Number.isSafeInteger(upload.maxChunkSize) && upload.maxChunkSize > upload.chunkSize;
  let chunkSize = adaptive ? Math.min(BIG_CHUNK_MIN, upload.maxChunkSize) : upload.chunkSize;
  for (;;) {
    const end = Math.min(offset + chunkSize, stat.size);
    const started = Date.now();
    const from = offset;
    try {
      async function* chunk() {
        let sent = offset;
        if (end > offset) {
          for await (const piece of fs.createReadStream(file, { start: offset, end: end - 1 })) {
            sent += piece.length;
            if (showProgress) process.stderr.write(`\r  ${name}: ${Math.floor((sent / stat.size) * 100)}%   `);
            yield piece;
          }
        }
      }
      const res = await (await api(cfg, `/api/uploads/${upload.id}?offset=${offset}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(end - offset) },
        body: chunk(),
        duplex: 'half',
      })).json();
      failures = 0;
      if (res.done) {
        if (showProgress) process.stderr.write('\r' + ' '.repeat(name.length + 12) + '\r');
        return res.item;
      }
      offset = res.offset;
      if (adaptive) {
        const rate = (offset - from) / Math.max((Date.now() - started) / 1000, 0.05);
        chunkSize = Math.min(upload.maxChunkSize, Math.max(BIG_CHUNK_MIN, Math.round(rate * CHUNK_SECONDS)));
      }
    } catch (err) {
      if (err.status === 409 && typeof err.body?.offset === 'number') {
        if (err.body.offset === offset) await new Promise(r => setTimeout(r, 2000)); // another chunk is still finishing
        offset = err.body.offset;
        continue;
      }
      if (!err.network && !(err.status >= 500 && err.status !== 507)) throw err;
      if (++failures > 8) throw err;
      if (showProgress) process.stderr.write(`\r  ${name}: connection lost, retrying…   `);
      await new Promise(r => setTimeout(r, Math.min(30_000, 1000 * 2 ** failures)));
      try { offset = (await (await api(cfg, `/api/uploads/${upload.id}`)).json()).offset; } catch {}
    }
  }
}

async function listDevices(cfg) {
  return (await api(cfg, '/api/devices')).json();
}

async function listItems(cfg) {
  return (await (await api(cfg, '/api/items')).json()).items;
}

async function fullText(cfg, item) {
  return item.truncated ? (await api(cfg, `/api/items/${item.id}/text`)).text() : item.text;
}

function safeName(name) {
  let out = String(name).split(/[\\/]/).pop().replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '') || 'file';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(out)) out = '_' + out;
  return out;
}

async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const candidate = path.join(dir, i ? `${base} (${i})${ext}` : name);
    try { await fsp.access(candidate); } catch { return candidate; }
  }
}

async function download(cfg, item, dir) {
  await fsp.mkdir(dir, { recursive: true });
  const res = await api(cfg, `/api/file/${item.id}`);
  const dest = await uniquePath(dir, safeName(item.name));
  const part = `${dest}.beam-part`;
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
    await fsp.rename(part, dest);
  } catch (err) {
    await fsp.rm(part, { force: true });
    throw err;
  }
  return dest;
}

// ---------------------------------------------------------------- OS integration

function run(cmd, args, { input, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(Buffer.concat(err).toString('utf8').trim() || `${cmd} exited with code ${code}`));
    });
    child.stdin.end(input);
  });
}

function powershell(script, env) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], { env });
}

async function firstWorking(attempts) {
  let lastError;
  for (const [cmd, args, opts] of attempts) {
    try { return await run(cmd, args, opts); } catch (err) { lastError = err; }
  }
  throw lastError;
}

const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');

// Returns { kind: 'files', files } | { kind: 'image', path } | { kind: 'text', text } | { kind: 'empty' }
async function readClipboard() {
  if (IS_WIN) {
    const out = await powershell(`
      Add-Type -AssemblyName System.Windows.Forms, System.Drawing
      $c = [System.Windows.Forms.Clipboard]
      $r = @{ kind = 'empty' }
      if ($c::ContainsFileDropList()) { $r = @{ kind = 'files'; files = @($c::GetFileDropList()) } }
      elseif ($c::ContainsImage()) {
        $p = Join-Path ([IO.Path]::GetTempPath()) ('clipboard-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.png')
        $c::GetImage().Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
        $r = @{ kind = 'image'; path = $p }
      }
      elseif ($c::ContainsText()) { $r = @{ kind = 'text'; text = $c::GetText() } }
      [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($r | ConvertTo-Json -Compress)))
    `);
    const result = JSON.parse(Buffer.from(out.trim(), 'base64').toString('utf8'));
    if (result.kind === 'files') result.files = [].concat(result.files);
    return result;
  }
  const text = IS_MAC
    ? await run('pbpaste', [])
    : await firstWorking([['wl-paste', ['--no-newline']], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['--clipboard', '--output']]]);
  return text ? { kind: 'text', text } : { kind: 'empty' };
}

async function writeClipboard(text) {
  if (IS_WIN) {
    const tmp = path.join(os.tmpdir(), `beam-clip-${process.pid}-${Date.now()}.txt`);
    await fsp.writeFile(tmp, text, 'utf8');
    try {
      await powershell(`
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.Clipboard]::SetText([IO.File]::ReadAllText($env:BEAM_CLIP_FILE, [Text.Encoding]::UTF8))
      `, { BEAM_CLIP_FILE: tmp });
    } finally {
      await fsp.rm(tmp, { force: true });
    }
    return;
  }
  if (IS_MAC) return void (await run('pbcopy', [], { input: text }));
  await firstWorking([['wl-copy', [], { input: text }], ['xclip', ['-selection', 'clipboard'], { input: text }], ['xsel', ['--clipboard', '--input'], { input: text }]]);
}

// Clicking a notification opens Beam in the browser. (Windows refuses custom beam: links
// from notifications, so this uses the plain web address.)
let webUrl = '';

async function desktopNotify(title, body = '', launch = webUrl) {
  try {
    if (IS_WIN) {
      await powershell(`
        $dec = { param($v) [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($v)) }
        $esc = { param($s) [Security.SecurityElement]::Escape($s) }
        $launch = & $dec $env:BEAM_LAUNCH
        $click = ''
        if ($launch) { $click = ' activationType="protocol" launch="' + (& $esc $launch) + '"' }
        $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml('<toast' + $click + '><visual><binding template="ToastGeneric"><text>' + (& $esc (& $dec $env:BEAM_TITLE)) + '</text><text>' + (& $esc (& $dec $env:BEAM_BODY)) + '</text></binding></visual></toast>')
        $app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
        if (Test-Path 'HKCU:\\Software\\Classes\\AppUserModelId\\Beam') { $app = 'Beam' }
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
      `, { BEAM_TITLE: b64(title), BEAM_BODY: b64(body), BEAM_LAUNCH: b64(launch || '') });
    } else if (IS_MAC) {
      await run('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body]);
    } else {
      await run('notify-send', ['-a', 'Beam', title, body]);
    }
  } catch {}
}

// Opens the web app signed in, with a pairing key that works once: never the CLI's own key, which would stay in the
// browser's history (and on a command line).
async function openWebApp(cfg, opt) {
  let key = cfg.key;
  try { key = (await (await api(cfg, '/api/pair')).json()).key || key; } catch {}
  openInBrowser(`${cfg.url}/?key=${encodeURIComponent(key)}${opt.pair ? '#pair' : ''}`);
}

function openInBrowser(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error(`Not a web address: ${url}`);
  // (no cmd.exe: it would read & | < > ^ % in the address as commands)
  if (IS_WIN) return spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  spawn(IS_MAC ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

function preview(text, max = 80) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function ask(question, { hidden = false } = {}) {
  return new Promise(resolve => {
    const input = process.stdin;
    process.stderr.write(question);
    if (!input.isTTY) {
      let data = '';
      input.setEncoding('utf8');
      input.on('data', d => { data += d; });
      input.on('end', () => resolve(data.split(/\r?\n/)[0] || ''));
      return;
    }
    let value = '';
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const onData = ch => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        input.setRawMode(false);
        input.pause();
        input.off('data', onData);
        process.stderr.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        process.stderr.write('\n');
        process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') {
        value = value.slice(0, -1);
      } else {
        value += ch;
        if (!hidden) process.stderr.write(ch);
      }
    };
    input.on('data', onData);
  });
}

async function printQr(text) {
  try {
    const QRCode = require('qrcode');
    console.log(await QRCode.toString(text, { type: 'terminal', small: true }));
  } catch {}
}

// ---------------------------------------------------------------- signing in

// Beam servers on this tailnet: every online peer that answers /api/hello like Beam.
async function discover() {
  const status = await new Promise(resolve => {
    const bins = IS_WIN ? ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe'] : ['tailscale'];
    const tryAt = i => (i >= bins.length ? resolve(null) : execFile(bins[i], ['status', '--json'], { timeout: 5000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err?.code === 'ENOENT') return tryAt(i + 1);
      try { resolve(err ? null : JSON.parse(out)); } catch { resolve(null); }
    }));
    tryAt(0);
  });
  if (!status) return [];
  const peers = Object.values(status.Peer || {}).filter(p => p.Online && p.DNSName);
  const found = await Promise.all(peers.map(async p => {
    const base = `https://${p.DNSName.replace(/\.$/, '')}`;
    try {
      const hello = await (await fetch(`${base}/api/hello`, { signal: AbortSignal.timeout(4000) })).json();
      return hello.beam ? { base: (hello.movedTo || base).replace(/\/+$/, ''), hello } : null;
    } catch {
      return null;
    }
  }));
  const seen = new Set();
  return found.filter(f => f && !seen.has(f.hello.serverId) && seen.add(f.hello.serverId));
}

async function saveSignIn(cfg, base, key, serverUrl, name) {
  const next = { ...(readConfigFile() || {}), url: (serverUrl || base).replace(/\/+$/, ''), key, device: name || cfg.device, deviceId: cfg.deviceId };
  const probe = { ...cfg, ...next };
  const me = await (await api(probe, '/api/me')).json();
  if (me.you) next.deviceId = me.you;
  next.serverId = (await (await fetch(`${next.url}/api/hello`)).json().catch(() => ({}))).serverId;
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

async function login(cfg, address, opt) {
  let base = (address || cfg.url || '').replace(/\/+$/, '');
  if (base && !/^https?:\/\//.test(base)) base = `https://${base}`;
  if (!base) {
    const found = await discover();
    if (!found.length) throw new Error('No Beam server found on your tailnet. Run:  beam login https://<your beam address>');
    if (found.length > 1) throw new Error(`Found several Beam servers; pick one:\n${found.map(f => `  beam login ${f.base}`).join('\n')}`);
    base = found[0].base;
    console.error(`Found Beam at ${base}`);
  }
  const name = opt.name || cfg.device;
  const who = { deviceId: cfg.deviceId, name, platform: 'cli' };
  const post = (route, body, headers = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Beam-Device-Id': cfg.deviceId, ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });

  if (opt.password) {
    const password = process.env.BEAM_PASSWORD || await ask('Beam password: ', { hidden: true });
    const res = await post('/api/login', { secret: password, client: 'app', deviceId: cfg.deviceId });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    const saved = await saveSignIn(cfg, base, body.key, body.server, name);
    return `Signed in to ${saved.url} as "${saved.device}"`;
  }

  // 1. Tailscale says who we are: no questions asked.
  const auto = await post('/api/autopair', { client: 'app', ...who }).catch(() => null);
  if (auto?.ok) {
    const body = await auto.json();
    const saved = await saveSignIn(cfg, base, body.key, body.server, name);
    return `Signed in to ${saved.url} as "${saved.device}" (Tailscale)`;
  }

  // 2. Approve a code on a device that's already signed in.
  for (;;) {
    const res = await post('/api/login-requests', { name, platform: 'cli', deviceId: cfg.deviceId });
    const request = await res.json().catch(() => ({}));
    if (res.status === 410 && request.movedTo) return login(cfg, request.movedTo, opt);
    if (!res.ok) throw new Error(request.error || `HTTP ${res.status}`);
    console.error(`\nApprove this computer on a device that's signed in to Beam (it asks by itself, or scan the code):\n\n  Code: ${request.code}\n`);
    await printQr(request.approveUrl);
    console.error('Waiting… (Ctrl+C to stop, or run  beam login --password)');
    for (;;) {
      const poll = await fetch(`${base}/api/login-requests/${request.id}?wait`, { headers: { 'X-Beam-Login-Secret': request.secret }, signal: AbortSignal.timeout(45_000) })
        .then(r => r.json()).catch(() => ({ status: 'pending' }));
      if (poll.status === 'approved') {
        const saved = await saveSignIn(cfg, base, poll.key, poll.server, name);
        return `Signed in to ${saved.url} as "${saved.device}" (approved by ${poll.approvedBy || 'another device'})`;
      }
      if (poll.status === 'denied') throw new Error('That sign-in was denied.');
      if (poll.status !== 'pending') break; // expired: new code
    }
    console.error('The code expired; here is a new one.');
  }
}

// ---------------------------------------------------------------- commands

async function setup(cfg, link, opt) {
  if (!link) throw new Error('Usage: beam setup "<pairing link>" [--name "My Laptop"]   (or just: beam login)');
  let url;
  try { url = new URL(link); } catch { throw new Error('That doesn\'t look like a pairing link. It should start with http:// or https://'); }
  const key = url.searchParams.get('key');
  if (!key) return login(cfg, url.origin, opt); // just an address: sign in the usual way
  const saved = await saveSignIn({ ...cfg, url: url.origin, key }, url.origin, key, null, opt.name || cfg.device);
  return `Connected to ${saved.url} as "${saved.device}". Settings saved to ${CONFIG_FILE}`;
}

async function sendFiles(cfg, files, opt) {
  if (!files.length) throw new Error('Nothing to send. Usage: beam <file> [file...]');
  const to = parseTargets(opt.to);
  const sent = [];
  for (const file of files) {
    const item = await sendFile(cfg, file, { quiet: opt.toast, to });
    sent.push(item);
    if (!opt.toast) console.log(`Sent ${item.name} (${formatSize(item.size)})`);
  }
  return sent.length === 1 ? `Sent ${sent[0].name}` : `Sent ${sent.length} files`;
}

async function sendClipboard(cfg, opt) {
  const to = parseTargets(opt.to);
  const clip = await readClipboard();
  if (clip.kind === 'files') return sendFiles(cfg, clip.files, opt);
  if (clip.kind === 'image') {
    try {
      await sendFile(cfg, clip.path, { quiet: true, to });
    } finally {
      await fsp.rm(clip.path, { force: true });
    }
    return 'Sent the image on your clipboard';
  }
  if (clip.kind === 'text' && clip.text.trim()) {
    await sendText(cfg, clip.text, to);
    return `Sent: ${preview(clip.text, 60)}`;
  }
  throw new Error('Your clipboard is empty');
}

// An item is for this device when it targets everyone or this device, and wasn't sent from here.
const isFor = (cfg, item) => (!item.to?.length || item.to.includes(cfg.deviceId)) && item.from !== cfg.deviceId;

async function ack(cfg, item) {
  await api(cfg, `/api/items/${item.id}/ack`, { method: 'POST' }).catch(() => {});
}

// Asks the server who we are first: after a merge the effective id differs from the stored one.
async function whoAmI(cfg) {
  const me = await (await api(cfg, '/api/me')).json();
  if (me.you && me.you !== cfg.deviceId) {
    cfg.deviceId = me.you;
    saveConfig({ deviceId: me.you });
  }
  return me;
}

async function getLatestText(cfg, opt) {
  await whoAmI(cfg);
  const item = (await listItems(cfg)).find(i => i.kind === 'text' && isFor(cfg, i));
  if (!item) throw new Error('No text has been sent to this computer yet');
  const text = await fullText(cfg, item);
  if (!opt['no-copy']) await writeClipboard(text);
  await ack(cfg, item);
  if (process.stdout.isTTY) console.error(`(${opt['no-copy'] ? 'from' : 'copied to clipboard, from'} ${item.device}, ${timeAgo(item.ts)})`);
  process.stdout.write(text + (process.stdout.isTTY && !text.endsWith('\n') ? '\n' : ''));
  return `Copied text from ${item.device}`;
}

async function pullLatestFile(cfg, dir) {
  await whoAmI(cfg);
  const item = (await listItems(cfg)).find(i => i.kind === 'file' && isFor(cfg, i));
  if (!item) throw new Error('No files have been sent to this computer yet');
  const dest = await download(cfg, item, path.resolve(dir || DEFAULT_DIR));
  await ack(cfg, item);
  console.log(dest);
  return `Saved ${path.basename(dest)}`;
}

async function list(cfg, count = 10) {
  await whoAmI(cfg);
  const [items, { devices }] = await Promise.all([listItems(cfg), listDevices(cfg)]);
  const name = id => (id === cfg.deviceId ? 'you' : devices.find(d => d.id === id)?.name || '?');
  const shown = items.filter(i => isFor(cfg, i) || i.from === cfg.deviceId).slice(0, count);
  if (!shown.length) return console.log('Nothing here yet.');
  for (const item of shown) {
    const route = `${item.from === cfg.deviceId ? 'you' : item.device} → ${item.to?.length ? item.to.map(name).join(', ') : 'all'}`;
    const what = item.kind === 'text' ? preview(item.text, 50) : `[file] ${item.name} (${formatSize(item.size)})`;
    console.log(`${item.id.slice(0, 8)}  ${timeAgo(item.ts).padStart(8)}  ${route.padEnd(24).slice(0, 24)}  ${item.pinned ? '* ' : ''}${what}`);
  }
}

async function remove(cfg, ids) {
  if (!ids.length) throw new Error('Usage: beam rm <id> [id...]   (the ids are the first column of beam ls)');
  const items = await listItems(cfg);
  const full = ids.map(prefix => {
    const matches = items.filter(i => i.id.startsWith(prefix.toLowerCase()));
    if (prefix.length < 4 || matches.length !== 1) throw new Error(matches.length > 1 ? `"${prefix}" matches several items; use more of the id` : `No item starts with "${prefix}"`);
    return matches[0].id;
  });
  const res = await api(cfg, '/api/items/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: full }) }).catch(async err => {
    if (err.status !== 404) throw err;
    for (const id of full) await api(cfg, `/api/items/${id}`, { method: 'DELETE' }); // an older server
    return null;
  });
  const deleted = res ? (await res.json()).deleted : full.length;
  return `Deleted ${deleted} item${deleted === 1 ? '' : 's'}`;
}

async function approve(cfg, code, opt) {
  if (!code) throw new Error('Usage: beam approve <code> [--yes]   (the code the new device shows)');
  const request = await (await api(cfg, `/api/login-requests?code=${encodeURIComponent(code)}`)).json();
  console.error(`Sign-in request: "${request.name}" (${request.platform}) from ${request.where}, code ${request.code}`);
  if (request.purpose === 'move') console.error('WARNING: this asks for a complete copy of your Beam (to move it to a new server).');
  if (!opt.yes) {
    const answer = await ask('Let it in? [y/N] ');
    if (!/^y(es)?$/i.test(answer.trim())) {
      await api(cfg, '/api/login-requests/deny', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      return 'Denied';
    }
  }
  await api(cfg, '/api/login-requests/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  return `Approved "${request.name}"`;
}

async function status(cfg) {
  const me = await whoAmI(cfg);
  const [info, { devices }] = await Promise.all([(await api(cfg, '/api/info')).json(), listDevices(cfg)]);
  const self = devices.find(d => d.id === me.you);
  const lines = [
    `Server:      ${cfg.url}  (Beam ${info.version}${info.api ? `, API ${info.api}` : ''})`,
    `This device: ${self?.name || cfg.device} (${me.you || cfg.deviceId}), signed in with ${me.auth?.via === 'token' ? 'its own token' : 'the master key'}`,
    `Devices:     ${devices.filter(d => d.online).length} online of ${devices.length}`,
  ];
  if (info.storage) lines.push(`Storage:     ${formatSize(info.storage.used)} in ${info.storage.items} items${info.storage.free != null ? `, ${formatSize(info.storage.free)} free on the server` : ''}`);
  lines.push(`Keeps items: ${info.retentionDays ? `${info.retentionDays} days` : 'until deleted'}, at most ${info.maxItems || 'unlimited'}`);
  if (info.publicUrl) lines.push(`Address:     ${info.publicUrl}`);
  if (info.tailscaleSignIn !== undefined) lines.push(`Tailscale sign-in: ${info.tailscaleSignIn ? `on (${(info.tailscaleOwners || []).join(', ') || 'no owners yet'})` : 'off'}`);
  console.log(lines.join('\n'));
}

async function showDevices(cfg) {
  const { devices, you } = await listDevices(cfg);
  if (you && you !== cfg.deviceId) { cfg.deviceId = you; saveConfig({ deviceId: you }); }
  for (const d of devices) {
    const self = d.id === cfg.deviceId ? '  (this computer)' : '';
    console.log(`${d.online ? '●' : '○'} ${d.name.padEnd(24)} ${d.platform.padEnd(8)} ${d.online ? 'online' : `last seen ${timeAgo(d.lastSeen)}`}${self}`);
  }
}

// The address other devices should use: Tailscale/public URL if there is one, else the LAN address.
async function pairLink(cfg) {
  const info = await (await api(cfg, '/api/pair')).json();
  if (info.link) return info.link;
  const local = /^(localhost|127\.|\[::1\])/.test(new URL(cfg.url).hostname);
  const base = info.publicUrl || (local && info.lanUrl) || cfg.url;
  return `${base}/?key=${encodeURIComponent(info.key)}`;
}

async function pair(cfg) {
  const link = await pairLink(cfg);
  console.log(`Open this on the device you want to add${link.includes('key=bp_') ? ' (it works once, for 15 minutes)' : ''}:\n  ${link}\n`);
  await printQr(link);
}

async function* sseEvents(body, onActivity) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    onActivity();
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  }
}

async function listen(cfg, opt) {
  const copy = !opt['no-copy'];
  const save = !opt['no-save'];
  const notify = !opt['no-notify'];
  const dir = path.resolve(opt.dir || DEFAULT_DIR);
  const maxSave = (Number(opt['max-save']) || 1024) * 1024 * 1024;
  const seen = new Set();
  const log = msg => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

  async function receive(item, { clipboard = true } = {}) {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    if (!isFor(cfg, item)) return;
    if (item.kind === 'text') {
      const text = await fullText(cfg, item);
      log(`Text from ${item.device}: ${preview(text)}`);
      if (copy && clipboard) await writeClipboard(text);
      if (notify && clipboard) desktopNotify(copy ? `Copied from ${item.device}` : `Text from ${item.device}`, preview(text, 120));
    } else if (save && item.size <= maxSave) {
      const dest = await download(cfg, item, dir);
      log(`Saved ${item.name} from ${item.device} → ${dest}`);
      if (notify) desktopNotify(`${item.name}`, `From ${item.device} · saved to ${path.basename(dir)}`);
    } else {
      log(`File from ${item.device}: ${item.name} (${formatSize(item.size)}), not saved`);
      if (notify) desktopNotify(`File from ${item.device}`, `${item.name} (${formatSize(item.size)})`);
    }
    await ack(cfg, item);
  }

  // Whatever was sent here while nothing was listening (laptop asleep, listen not running): everything this
  // device hasn't acknowledged yet. Only the newest text goes to the clipboard.
  async function catchUp() {
    const pending = (await listItems(cfg)).filter(i => isFor(cfg, i) && !i.delivered?.[cfg.deviceId] && !seen.has(i.id)).reverse();
    const newestText = pending.filter(i => i.kind === 'text').at(-1);
    for (const item of pending) await receive(item, { clipboard: item === newestText }).catch(err => log(`Error: ${err.message}`));
  }

  await whoAmI(cfg);
  log(`Listening as "${cfg.device}" on ${cfg.url}`);
  log(`Text → ${copy ? 'clipboard' : 'printed only'} · files → ${save ? dir : 'not saved'}`);
  let connectedBefore = false;
  for (let delay = 1000; ;) {
    const abort = new AbortController();
    let watchdog;
    const alive = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => abort.abort(), 70_000); // the server pings every 25s
    };
    try {
      alive();
      const res = await api(cfg, '/api/events', { headers: { Accept: 'text/event-stream' }, signal: abort.signal });
      log(connectedBefore ? 'Reconnected' : 'Connected');
      delay = 1000;
      connectedBefore = true;
      await catchUp();
      for await (const ev of sseEvents(res.body, alive)) {
        if (ev.event === 'item') await receive(JSON.parse(ev.data)).catch(err => log(`Error: ${err.message}`));
        else if (ev.event === 'refresh') await whoAmI(cfg).then(catchUp).catch(() => {});
        else if (ev.event === 'moved') throw Object.assign(new Error('Beam moved'), { moved: JSON.parse(ev.data).movedTo });
      }
      throw new Error('connection closed');
    } catch (err) {
      if (err.moved && await followMove(cfg, err.moved)) { log(`Beam moved to ${cfg.url}`); continue; }
      const reason = err.name === 'AbortError' ? 'connection timed out' : err.message;
      log(`Disconnected (${reason}). Retrying in ${delay / 1000}s`);
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    } finally {
      clearTimeout(watchdog);
    }
  }
}

// ---------------------------------------------------------------- main

const COMMANDS = new Set(['login', 'setup', 'status', 'devices', 'send', 'text', 'clip', 'get', 'pull', 'ls', 'list', 'rm', 'approve', 'listen', 'open', 'pair', 'help']);

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        text: { type: 'string', short: 't' },
        to: { type: 'string' },
        name: { type: 'string' },
        dir: { type: 'string' },
        'max-save': { type: 'string' },
        'no-copy': { type: 'boolean' },
        'no-save': { type: 'boolean' },
        'no-notify': { type: 'boolean' },
        toast: { type: 'boolean' },
        pair: { type: 'boolean' },
        password: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    console.error(`beam: ${err.message.replace(/\. To specify a positional argument.*$/s, '')}\nRun  beam --help  for the list of commands and options.`);
    process.exitCode = 2;
    return;
  }
  const { values: opt, positionals } = parsed;
  const cfg = loadConfig();
  webUrl = cfg.url ? `${cfg.url}/` : '';
  let [cmd, ...args] = positionals;
  if (opt.help || cmd === 'help') return console.log(HELP);
  if (cmd && !COMMANDS.has(cmd)) { args = positionals; cmd = 'send'; }

  let result;
  try {
    const to = parseTargets(opt.to);
    if (opt.text !== undefined) result = (await sendText(requireConfig(cfg), opt.text, to), `Sent: ${preview(opt.text, 60)}`);
    else if (!cmd) {
      if (process.stdin.isTTY) return console.log(HELP);
      const text = await readStdin();
      if (!text.trim()) throw new Error('Nothing to send (stdin was empty)');
      await sendText(requireConfig(cfg), text, to);
      result = `Sent: ${preview(text, 60)}`;
    } else if (cmd === 'setup') result = await setup(cfg, args[0], opt);
    else if (cmd === 'login') result = await login(cfg, args[0], opt);
    else {
      requireConfig(cfg);
      switch (cmd) {
        case 'status': await status(cfg); break;
        case 'devices': await showDevices(cfg); break;
        case 'send': result = await sendFiles(cfg, args, opt); break;
        case 'text': {
          const text = args.join(' ');
          if (!text.trim()) throw new Error('Usage: beam text <words...>');
          await sendText(cfg, text, to);
          result = `Sent: ${preview(text, 60)}`;
          break;
        }
        case 'clip': result = await sendClipboard(cfg, opt); break;
        case 'get': result = await getLatestText(cfg, opt); break;
        case 'pull': result = await pullLatestFile(cfg, args[0]); break;
        case 'ls': case 'list': await list(cfg, Number(args[0]) || 10); break;
        case 'rm': result = await remove(cfg, args); break;
        case 'approve': result = await approve(cfg, args[0], opt); break;
        case 'listen': await listen(cfg, opt); break;
        case 'open': await openWebApp(cfg, opt); break;
        case 'pair': await pair(cfg); break;
      }
    }
  } catch (err) {
    if (opt.toast) await desktopNotify('Beam: something went wrong', err.message);
    console.error(`beam: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (!result) return;
  if (opt.toast) await desktopNotify('Beam', result);
  else if (!['get', 'pull', 'send'].includes(cmd)) console.log(result);
}

main();
