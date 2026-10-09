#!/usr/bin/env node
// Beam command-line client: send files, text and clipboard contents to your
// Beam server, and receive what your other devices send. Speaks docs/API.md (v3, and v2 servers).
// (1.22) Also Beam for Linux: `beam agent`, what linux/install.sh sets up as a service (see "Beam for Linux" below), and
// (Beam for Linux 1.1) `beam window`, the menu's Beam on a Linux desktop.
'use strict';

// Beam for Linux's version (linux/build.mjs signs the build with it; Beam sees it when this is the Linux app).
const VERSION = '1.2.1';
// The public half of the key Beam for Linux's updates are signed with: linux/build.mjs fills it in (empty here).
const UPDATE_KEY = '';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { parseArgs } = require('node:util');

const CONFIG_FILE = path.join(os.homedir(), '.beam.json');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
// (1.22) Beam for Linux's own parts run on Linux, and in tests anywhere with a stand-in for its / (etc, proc, sys).
const SYSROOT = process.env.BEAM_TEST_LINUX_ROOT || '/';
const AS_LINUX = process.platform === 'linux' || Boolean(process.env.BEAM_TEST_LINUX_ROOT);
const DEFAULT_DIR = path.join(os.homedir(), 'Downloads', 'Beam');

const HELP = `Beam: send text, clipboard contents and files between your devices

Getting connected:
  beam login [address]                             sign in: automatically over Tailscale, else by approving
                                                   a code on a signed-in device (--password to use the password)
  beam setup [pairing-link] [--name "My Laptop"]   sign in with a pairing link instead (without the link, beam
                                                    asks for it: it then stays out of your shell history)
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

Beam for Linux (a Raspberry Pi or another Linux computer, kept connected all day):
  curl -fsSL https://<your beam address>/install/linux | bash
                                                   installs it as a service: signs in, starts with the computer,
                                                   reports its status (disk, temperature…) and updates itself
  beam window [--sign-in]                          Beam in a window of its own (Beam in the menu, with a desktop):
                                                   drop files on it to send them, paste text; --sign-in: sign
                                                   that window in again
  beam control on|off                              let your other devices see and control this computer's screen
                                                   (Control on its page in Beam; needs wayvnc and a desktop)
  beam agent                                       what that service runs: listen (same options), plus the status
  beam version                                     Beam for Linux's version

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
  writeConfigFile({ ...saved, ...changes });
  return true;
}

// (Beam for Linux 1.2.1) Written beside it, then put in its place: a command reading it meanwhile (the agent saves it
// as it runs) never finds it half written.
function writeConfigFile(config) {
  let file = CONFIG_FILE;
  try { file = fs.realpathSync(CONFIG_FILE); } catch {} // (a link to it stays a link)
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
  keepPrivate();
}

// (audit C-5) The mode above applies only when the file is created: an older file, a hand edit or a restored
// dotfile keeps looser permissions. It holds the sign-in, so make it this user's alone on every save.
function keepPrivate() {
  if (IS_WIN) return; // (Windows: the profile folder's own permissions)
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
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
  // (1.22) "linux": this computer's Beam for Linux (BEAM_APP=linux while the installer signs it in): every command here
  // is that device, not a separate command-line one.
  cfg.app = process.env.BEAM_APP === 'linux' || file.app === 'linux' ? 'linux' : undefined;
  return cfg;
}

const linuxApp = cfg => cfg.app === 'linux';

function requireConfig(cfg) {
  if (!cfg.url || !cfg.key) {
    throw new Error('This computer isn\'t signed in to Beam yet. Run:  beam login  (or beam setup "<pairing link>")');
  }
  return cfg;
}

// ---------------------------------------------------------------- server calls

// Who's asking, on every request (and, Beam for Linux 1.2, the VNC relay's WebSocket).
const beamHeaders = cfg => ({
  Authorization: `Bearer ${cfg.key}`,
  'X-Beam-Device-Id': cfg.deviceId,
  'X-Beam-Device': encodeURIComponent(cfg.device),
  'X-Beam-Platform': linuxApp(cfg) ? 'linux' : 'cli',
  ...(linuxApp(cfg) && { 'X-Beam-App-Version': VERSION, 'X-Beam-Profile': linuxProfile() }),
});

async function api(cfg, route, options = {}) {
  let res;
  try {
    res = await fetch(cfg.url + route, { ...options, headers: { ...beamHeaders(cfg), ...options.headers } });
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
  // (audit X-1) The proof always: the id is public, and `api` is whatever the answer says.
  const expected = crypto.createHmac('sha256', h1).update(`${hello.serverId}:${nonce}`).digest('hex');
  if (hello.proof !== expected) {
    console.error(`beam: ${base} answers with this Beam's id but can't prove it holds this sign-in; ignored.`);
    return null;
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
  // (audit C-6) at most 200 bytes, as the server keeps names (some file systems refuse longer ones); the extension stays
  if (Buffer.byteLength(out) > 200) {
    const ext = path.extname(out).slice(0, 20);
    let base = out.slice(0, out.length - path.extname(out).length);
    while (base && Buffer.byteLength(base + ext) > 200) base = base.slice(0, -1);
    out = (base.replace(/[\s.]+$/, '') || 'file') + ext;
  }
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

function run(cmd, args, { input, env, timeout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true, timeout });
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
  const env = IS_MAC ? {} : desktopEnv();
  if (!env) throw new Error('there\'s no desktop here, so no clipboard');
  const text = IS_MAC
    ? await run('pbpaste', [])
    : await firstTool([['wl-paste', ['--no-newline']], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['--clipboard', '--output']]], (cmd, args) => run(cmd, args, { env }));
  return text ? { kind: 'text', text } : { kind: 'empty' };
}

// (Beam for Linux 1.1) The first clipboard program here that works; none: why the first one there didn't, or which to get.
async function firstTool(tools, use) {
  let failed = null;
  for (const [cmd, args] of tools) {
    try { return await use(cmd, args); } catch (err) { if (err.code !== 'ENOENT') failed ??= err; }
  }
  throw failed || new Error('this computer has no clipboard program (sudo apt install wl-clipboard)');
}

// (Beam for Linux 1.1) wl-copy, xclip and xsel go on in the background to hold what they copied (that's how a Linux
// clipboard works), still holding the error output they were started with: waiting for that to close waited until
// something else was copied, and Beam for Linux received nothing more meanwhile. Each is done when it exits.
function copyWith(cmd, args, text, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'ignore', 'ignore'], timeout: 10_000 });
    child.on('error', reject);
    child.on('exit', (code, signal) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${signal ? `was stopped (${signal})` : `exited with code ${code}`}`))));
    child.stdin.on('error', () => {}); // (one that fails may exit before it has read it all)
    child.stdin.end(text);
  });
}

// (1.22) Beam for Linux runs as a service, outside the desktop session: it uses the desktop of its user that's on
// (Wayland first, then X), found the way a session sets it up. {} when this process has a desktop of its own already,
// null when there isn't one (a computer without a screen).
function desktopEnv() {
  if (process.env.WAYLAND_DISPLAY || process.env.DISPLAY) return {};
  const runtime = process.env.XDG_RUNTIME_DIR || (process.getuid ? `/run/user/${process.getuid()}` : '');
  const env = {};
  if (runtime && !process.env.DBUS_SESSION_BUS_ADDRESS && fs.existsSync(path.join(runtime, 'bus'))) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(runtime, 'bus')}`;
  let wayland = null;
  try { wayland = fs.readdirSync(runtime).filter(n => /^wayland-\d+$/.test(n)).sort()[0] || null; } catch {}
  if (wayland) return { ...env, XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: wayland };
  if (fs.existsSync('/tmp/.X11-unix/X0')) return { ...env, DISPLAY: ':0' };
  return null;
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
  const env = desktopEnv();
  if (!env) throw new Error('there\'s no desktop here, so no clipboard');
  await firstTool([['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]], (cmd, args) => copyWith(cmd, args, text, env));
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
      const env = desktopEnv();
      if (!env) return;
      // (Beam for Linux 1.1) with Beam's icon; without notify-send (not every desktop has it), straight to the desktop's
      // notifications through gdbus (GLib's, there wherever a GTK desktop is)
      const icon = AS_LINUX && fs.existsSync(ICON_FILE) ? ICON_FILE : '';
      await run('notify-send', ['-a', 'Beam', ...(icon ? ['-i', icon] : []), title, body], { env, timeout: 10_000 }).catch(err => {
        if (err.code !== 'ENOENT') throw err;
        return run('gdbus', ['call', '--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications',
          '--method', 'org.freedesktop.Notifications.Notify', gvText('Beam'), '0', gvText(icon), gvText(title), gvText(body), '[]', '{}', '-1'], { env, timeout: 10_000 });
      });
    }
  } catch {}
}

// A string as GVariant text (gdbus call reads its arguments that way).
const gvText = s => `'${String(s).replace(/[\\']/g, c => `\\${c}`).replace(/\n/g, '\\n')}'`;

// Opens the web app signed in, with a pairing key that works once: never the CLI's own key, which would stay in the
// browser's history (and on a command line).
async function openWebApp(cfg, opt) {
  const key = await pairingKey(cfg);
  // (Without a pairing key, the sign-in page: since 1.7.3 a link signs in only with one.)
  openInBrowser(`${cfg.url}/${key ? `?key=${encodeURIComponent(key)}` : ''}${opt.pair ? '#pair' : ''}`);
}

async function pairingKey(cfg) {
  try { return (await (await api(cfg, '/api/pair')).json()).key || null; } catch { return null; }
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
      // (audit C-4) the peer's own address: an unproven `movedTo` in a hello isn't followed from here
      return hello.beam ? { base, hello } : null;
    } catch {
      return null;
    }
  }));
  const seen = new Set();
  return found.filter(f => f && !seen.has(f.hello.serverId) && seen.add(f.hello.serverId));
}

async function saveSignIn(cfg, base, key, serverUrl, name) {
  const next = { ...(readConfigFile() || {}), url: (serverUrl || base).replace(/\/+$/, ''), key, device: name || cfg.device, deviceId: cfg.deviceId, ...(cfg.app && { app: cfg.app }) };
  const probe = { ...cfg, ...next };
  const me = await (await api(probe, '/api/me')).json();
  if (me.you) next.deviceId = me.you;
  next.serverId = (await (await fetch(`${next.url}/api/hello`)).json().catch(() => ({}))).serverId;
  writeConfigFile(next);
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
  const platform = linuxApp(cfg) ? 'linux' : 'cli';
  const who = { deviceId: cfg.deviceId, name, platform };
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
    const res = await post('/api/login-requests', { name, platform, deviceId: cfg.deviceId });
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

// (audit C-3) The link from the input: typed or pasted at a prompt, or piped in (beam setup < link.txt).
async function readLink() {
  if (!process.stdin.isTTY) {
    let text = '';
    for await (const chunk of process.stdin) { text += chunk; if (text.length > 8192) break; }
    return text.trim().split(/\s+/)[0] || '';
  }
  const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await new Promise(resolve => rl.question('Pairing link: ', resolve))).trim();
  } finally {
    rl.close();
  }
}

async function setup(cfg, link, opt) {
  if (!link) link = await readLink();
  if (!link) throw new Error('Usage: beam setup ["<pairing link>"] [--name "My Laptop"]   (or just: beam login)');
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

// (1.22) hooks (Beam for Linux's agent): onHello(hello) after each connect, onEvent(name, data) for other events.
async function listen(cfg, opt, hooks = {}) {
  const copy = !opt['no-copy'];
  const save = !opt['no-save'];
  const notify = !opt['no-notify'];
  const dir = path.resolve(opt.dir || DEFAULT_DIR);
  const maxSave = (Number(opt['max-save']) || 1024) * 1024 * 1024;
  const seen = new Set();
  const log = logLine;
  let clipProblem = '';

  async function receive(item, { clipboard = true } = {}) {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    // (audit C-6) a listener that runs for months: the newest 10,000 are enough to skip repeats (a Set keeps its order)
    if (seen.size > 10_000) for (const id of seen) { seen.delete(id); if (seen.size <= 9_000) break; }
    if (!isFor(cfg, item)) return;
    if (item.kind === 'text') {
      const text = await fullText(cfg, item);
      // (Beam for Linux's log can be read from another device: never the text itself there)
      log(opt.agent ? `Text from ${item.device} (${text.length} characters)` : `Text from ${item.device}: ${preview(text)}`);
      if (copy && clipboard) {
        // (1.22) Not a reason to leave the text unread: a computer without a desktop has no clipboard (said once a run)
        try { await writeClipboard(text); clipProblem = ''; } catch (err) {
          if (clipProblem !== err.message) log(`Not put on the clipboard: ${(clipProblem = err.message)}`);
        }
      }
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
        else if (ev.event === 'hello') hooks.onHello?.(jsonOr(ev.data));
        else hooks.onEvent?.(ev.event, jsonOr(ev.data));
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

// ---------------------------------------------------------------- Beam for Linux (1.22)
// `beam agent` is Beam for Linux: what its service runs (linux/install.sh: a systemd user service that starts with the
// computer and again whenever it stops). It is `beam listen` that also
// - tells Beam how the computer is, like the PCs' apps do: its system and model, disk, when it started, its CPU's
//   temperature and (a Raspberry Pi) what its firmware says about power and throttling. On each connect, every 15
//   minutes, and when that changes (a minute's look);
// - sends its own log when another device asks for it (Device info → Beam log): ~/.local/state/beam/beam.log;
// - updates itself: a newer build that Beam offers (GET /api/updates `linux`), signed with the key this one carries,
//   replaces this file, and it stops; the service starts it again.

const LINUX_HOME = path.join(os.homedir(), '.local', 'share', 'beam'); // where the installer puts it
const LOG_FILE = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'beam', 'beam.log');
const LOG_MAX = 512 * 1024;
const STATUS_EVERY = 15 * 60e3;
const UPDATE_EVERY = 6 * 3600e3;
let logToFile = false;

const jsonOr = (text, fallback = {}) => { try { return JSON.parse(text); } catch { return fallback; } };

function logLine(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
  if (!logToFile) return;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if ((fs.statSync(LOG_FILE, { throwIfNoEntry: false })?.size || 0) > LOG_MAX) fs.renameSync(LOG_FILE, `${LOG_FILE}.old`);
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

const readSys = file => { try { return fs.readFileSync(path.join(SYSROOT, file), 'utf8'); } catch { return null; } };
const oneLine = (text, max = 60) => String(text || '').replace(/\0/g, '').replace(/\s+/g, ' ').trim().slice(0, max).trim();

// Which user account on which computer this is (X-Beam-Profile): a reinstall here is the same device again.
let profile = '';
function linuxProfile() {
  profile ||= sha256(`beam-linux:${oneLine(readSys('etc/machine-id') || readSys('var/lib/dbus/machine-id') || os.hostname(), 64)}:${process.getuid?.() ?? os.userInfo().username}`).toString('hex').slice(0, 32);
  return profile;
}

// "Raspberry Pi OS 12 (bookworm)": Raspberry Pi OS calls itself Debian; its /etc/rpi-issue says it's the Pi's.
function osName() {
  const f = {};
  for (const line of (readSys('etc/os-release') || readSys('usr/lib/os-release') || '').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) f[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  if (readSys('etc/rpi-issue') !== null && !/raspberry|raspbian/i.test(f.PRETTY_NAME || '') && f.VERSION_ID) {
    return oneLine(`Raspberry Pi OS ${f.VERSION_ID}${f.VERSION_CODENAME ? ` (${f.VERSION_CODENAME})` : ''}`);
  }
  return oneLine(f.PRETTY_NAME || f.NAME || `Linux ${os.release()}`) || 'Linux';
}

// "Raspberry Pi 5 Model B Rev 1.0" (the device tree), else the PC's maker and model as its firmware says.
function hardwareModel() {
  const tree = oneLine(readSys('proc/device-tree/model'));
  if (tree) return tree;
  const dmi = ['sys_vendor', 'product_name'].map(f => oneLine(readSys(`sys/devices/virtual/dmi/id/${f}`)))
    .filter(v => v && !/o\.?e\.?m|default string|not specified|not applicable|system product name|to be filled/i.test(v));
  return oneLine(dmi.join(' ')) || null;
}

function bootTime() {
  const btime = /^btime (\d+)$/m.exec(readSys('proc/stat') || '');
  return btime ? Number(btime[1]) * 1000 : Math.round((Date.now() - os.uptime() * 1000) / 60e3) * 60e3;
}

// The CPU's thermal zone (a Pi's "cpu-thermal"), else the first one that reads, in °C.
function cpuTemperature() {
  let zones = [];
  try { zones = fs.readdirSync(path.join(SYSROOT, 'sys/class/thermal')).filter(n => /^thermal_zone\d+$/.test(n)).sort(); } catch {}
  const read = zones.map(z => ({ type: oneLine(readSys(`sys/class/thermal/${z}/type`)), raw: (readSys(`sys/class/thermal/${z}/temp`) || '').trim() }))
    .filter(z => /^-?\d+$/.test(z.raw) && Math.abs(Number(z.raw)) < 150_000);
  const cpu = read.find(z => /cpu|x86_pkg|soc|k10temp|coretemp|package/i.test(z.type)) || read[0];
  return cpu ? Math.round(Number(cpu.raw) / 100) / 10 : null;
}

// A Raspberry Pi's firmware (vcgencmd get_throttled): bits 0–3 now, 16–19 since it started. null elsewhere.
const THROTTLE_BITS = [['undervoltage', 0], ['capped', 1], ['throttled', 2], ['softLimit', 3]];
let noVcgencmd = false;
async function throttling() {
  let text = process.env.BEAM_TEST_THROTTLED;
  if (text === undefined) {
    if (noVcgencmd) return null;
    try { text = await run('vcgencmd', ['get_throttled'], { timeout: 5000 }); } catch (err) {
      if (err.code === 'ENOENT') noVcgencmd = true; // not a Raspberry Pi
      return null;
    }
  }
  const m = /0x([0-9a-f]{1,8})\b/i.exec(text);
  if (!m) return null;
  const bits = parseInt(m[1], 16);
  return {
    now: THROTTLE_BITS.filter(([, b]) => bits & (1 << b)).map(([f]) => f),
    sinceBoot: THROTTLE_BITS.filter(([, b]) => bits & (1 << (b + 16))).map(([f]) => f),
  };
}

function rootStorage() {
  try {
    const s = fs.statfsSync(SYSROOT);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return Number.isSafeInteger(total) && total > 0 && free >= 0 && free <= total ? { free, total } : null;
  } catch { return null; }
}

// What PUT /api/devices/me/status gets. A Beam from before 1.22 knows only os and storage (it refuses other fields);
// (Beam for Linux 1.2) one that takes vnc sessions hears whether remote control is on here.
async function linuxStatus(full, vnc = false) {
  const status = { os: osName() };
  const storage = rootStorage();
  if (storage) status.storage = storage;
  if (vnc) status.remoteControl = controlAllowed();
  if (!full) return status;
  const model = hardwareModel();
  if (model) status.model = model;
  status.bootedAt = bootTime();
  const temperature = cpuTemperature();
  if (temperature !== null) status.temperature = temperature;
  const throttled = await throttling();
  if (throttled) status.throttled = throttled;
  return status;
}

// Worth telling Beam between the 15-minute reports: a restart, the firmware's flags, 5 °C either way or across 70 or 80.
function statusChanged(was, now) {
  if (!was) return true;
  if (was.bootedAt !== now.bootedAt || JSON.stringify(was.throttled) !== JSON.stringify(now.throttled)) return true;
  if (was.remoteControl !== now.remoteControl) return true; // (Beam for Linux 1.2: beam control on/off)
  const [a, b] = [was.temperature, now.temperature];
  if ((a === undefined) !== (b === undefined)) return true;
  return a !== undefined && (Math.abs(b - a) >= 5 || [70, 80].some(t => (a >= t) !== (b >= t)));
}

const newerThan = (a, b) => {
  const parts = v => String(v).split('.').map(n => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

// An update is this build's own: signed with the key it carries (linux/build.mjs). A copy built without a key (a
// plain checkout) checks only the SHA-256, like a Beam.exe built without one.
function signedByOurBuilder(offer, sha, size) {
  if (!UPDATE_KEY) return true;
  try {
    const xy = Buffer.from(UPDATE_KEY, 'base64');
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: xy.subarray(0, 32).toString('base64url'), y: xy.subarray(32, 64).toString('base64url') }, format: 'jwk' });
    const message = Buffer.from(`beam-linux-update\n${offer.version}\n${sha}\n${size}`, 'utf8');
    return typeof offer.sig === 'string' && crypto.verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(offer.sig, 'base64'));
  } catch {
    return false;
  }
}

const SELF = path.resolve(__filename);
const refusedUpdates = new Set(); // "version sha256" of builds that weren't right (not tried again until offered anew)
let updating = null;
let updated = false;

// Only the installed app replaces itself (never a copy run from a checkout of Beam).
function checkForUpdate(cfg) {
  if (SELF !== path.join(LINUX_HOME, 'beam.js') || updating || updated) return updating;
  updating = (async () => {
    const offer = (await (await api(cfg, '/api/updates')).json()).linux;
    if (!offer?.version || !newerThan(offer.version, VERSION) || refusedUpdates.has(`${offer.version} ${offer.sha256}`)) return;
    logLine(`Beam offers Beam for Linux ${offer.version}: updating`);
    const data = Buffer.from(await (await api(cfg, '/download/linux')).arrayBuffer());
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    const problem = sha !== offer.sha256 || data.length !== offer.size ? 'it changed on the way'
      : !signedByOurBuilder(offer, sha, data.length) ? 'it isn\'t signed by whoever built this one'
        : !data.toString('utf8').includes(`\nconst VERSION = '${offer.version}';\n`) ? 'it says it\'s another version' : null;
    const next = path.join(path.dirname(SELF), 'beam.new.js'); // (.js: Node.js won't check a file it can't tell is a script)
    if (!problem) {
      fs.writeFileSync(next, data, { mode: 0o644 });
      try { await run(process.execPath, ['--check', next], { timeout: 60_000 }); } catch (err) {
        fs.rmSync(next, { force: true });
        return refuse(offer, `Node.js can't read it (${oneLine(err.message, 200)})`);
      }
      fs.renameSync(next, SELF);
      updated = true;
      logLine(`Updated to Beam for Linux ${offer.version}: starting again`);
      setTimeout(() => process.exit(0), 200); // (the service starts it again; let the log line out first)
      return;
    }
    refuse(offer, problem);
  })().catch(err => logLine(`Couldn't check for an update: ${err.message}`)).finally(() => { updating = null; });
  return updating;
}

function refuse(offer, why) {
  refusedUpdates.add(`${offer.version} ${offer.sha256}`);
  logLine(`Didn't update to Beam for Linux ${offer.version}: ${why}`);
}

// Device info → Beam log on another device: the end of this log (Beam keeps none of it).
async function sendLog(cfg, id) {
  logLine('Sending this log (asked from another device)');
  let text = '';
  for (const f of [`${LOG_FILE}.old`, LOG_FILE]) { try { text += fs.readFileSync(f, 'utf8'); } catch {} }
  await api(cfg, '/api/devices/me/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name: 'beam.log', text: text.slice(-2 * LOG_MAX) }) });
}

// ---------------------------------------------------------------- Beam in the menu (Beam for Linux 1.1)
// On a computer with a desktop, Beam for Linux puts Beam in the menu (Internet → Beam): Beam's own pages in a window of
// their own, to drop files on, paste text into and see what came. The window is a Chromium-family browser's app mode
// with a profile of its own (~/.local/share/beam/window: it stays signed in apart from the browser). The first time (or
// `beam window --sign-in`) it signs in with a pairing link that works once, and Beam takes it for this computer's device,
// as it does any browser on the same computer as a Beam app. Without such a browser: Beam in the default browser.

const ICON_FILE = path.join(LINUX_HOME, 'beam.svg');
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">'
  + '<stop offset="0" stop-color="#6c5cff"/><stop offset="1" stop-color="#1fb3d6"/></linearGradient></defs>'
  + '<rect width="512" height="512" rx="116" fill="url(#bg)"/><g transform="translate(256 262) scale(14.5) translate(-12 -12)">'
  + '<path d="M3 11 21 3 11 13Z" fill="#fff"/><path d="M11 13 21 3 13 21Z" fill="#fff" fill-opacity=".78"/></g></svg>\n'; // (public/icon.svg)
const MENU_ENTRY = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'applications', 'beam.desktop');
const MENU_ADDED = path.join(LINUX_HOME, 'menu-added'); // (taken out of the menu by hand: it stays out)
const WINDOW_PROFILE = path.join(LINUX_HOME, 'window');
const BROWSERS = ['chromium-browser', 'chromium', 'google-chrome-stable', 'google-chrome', 'microsoft-edge-stable', 'microsoft-edge', 'brave-browser'];

const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

// A desktop to sign in to is installed here (Raspberry Pi OS with desktop, Ubuntu…; not Raspberry Pi OS Lite).
function hasDesktop() {
  return ['usr/share/wayland-sessions', 'usr/share/xsessions'].some(dir => {
    try { return fs.readdirSync(path.join(SYSROOT, dir)).some(n => n.endsWith('.desktop')); } catch { return false; }
  });
}

// An Exec= argument, quoted the way the desktop entry spec wants when it needs to be.
const execArg = s => (/^[\w/.+-]+$/.test(s) ? s : `"${s.replace(/[`"$\\]/g, c => `\\${c}`)}"`.replace(/\\/g, '\\\\').replace(/%/g, '%%'));

function menuEntry() {
  return [
    '# Beam for Linux: Beam in the menu (its service keeps this up to date; its installer\'s --uninstall takes it away)',
    '[Desktop Entry]',
    'Type=Application',
    'Name=Beam',
    'GenericName=Send to your devices',
    'Comment=Send files and text to your other devices, and see what they sent',
    `Exec=${execArg(path.join(os.homedir(), '.local', 'bin', 'beam'))} window --toast`,
    `Icon=${ICON_FILE}`,
    'Terminal=false',
    'Categories=Network;FileTransfer;',
    'Keywords=send;share;files;clipboard;',
    'StartupWMClass=Beam',
    '',
  ].join('\n');
}

// Puts Beam in the menu, or brings its entry up to date: only the installed app (never a copy run from a checkout), only
// with a desktop, never over another program's beam.desktop, and not again once someone took it out of the menu.
function ensureMenuEntry() {
  if (SELF !== path.join(LINUX_HOME, 'beam.js') || !hasDesktop()) return;
  try {
    if (readText(ICON_FILE) !== ICON_SVG) fs.writeFileSync(ICON_FILE, ICON_SVG);
    const entry = menuEntry();
    const had = readText(MENU_ENTRY);
    if (had === entry || (had === null ? fs.existsSync(MENU_ADDED) : !had.startsWith('# Beam for Linux'))) return;
    fs.mkdirSync(path.dirname(MENU_ENTRY), { recursive: true });
    fs.writeFileSync(`${MENU_ENTRY}.tmp`, entry);
    fs.renameSync(`${MENU_ENTRY}.tmp`, MENU_ENTRY);
    if (had === null) {
      fs.writeFileSync(MENU_ADDED, `${new Date().toISOString()}\n`);
      logLine('Put Beam in the menu (Internet → Beam: a window to send files and text from here)');
    }
  } catch (err) {
    logLine(`Couldn't put Beam in the menu: ${err.message}`);
  }
}

// The first of these programs on the PATH (in the order given).
function findOnPath(names) {
  const dirs = (process.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(path.delimiter).filter(Boolean);
  for (const name of [].concat(names)) {
    for (const dir of dirs) {
      try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return path.join(dir, name); } catch {}
    }
  }
  return null;
}
const findBrowser = () => findOnPath(BROWSERS);

// `beam window`: what Beam in the menu runs.
async function openWindow(cfg, opt) {
  if (!AS_LINUX) return openWebApp(cfg, opt); // (elsewhere: Beam's own apps, or the browser)
  const env = desktopEnv();
  if (!env) throw new Error('there\'s no desktop on this computer to open Beam\'s window on');
  // (tests: BEAM_TEST_BROWSER, a Node.js script that stands in for the browser)
  const browser = process.env.BEAM_TEST_BROWSER ? [process.execPath, process.env.BEAM_TEST_BROWSER] : [findBrowser()].filter(Boolean);
  if (!browser.length) return openWebApp(cfg, opt);
  const first = !fs.existsSync(WINDOW_PROFILE);
  const key = first || opt['sign-in'] ? await pairingKey(cfg) : null;
  fs.mkdirSync(WINDOW_PROFILE, { recursive: true, mode: 0o700 });
  const [cmd, ...before] = browser;
  // (--password-store=basic: no keyring to unlock first, which a desktop that signs in by itself would ask for)
  const args = [...before, `--app=${cfg.url}/${key ? `?key=${encodeURIComponent(key)}` : ''}`, `--user-data-dir=${WINDOW_PROFILE}`, '--class=Beam',
    '--no-first-run', '--no-default-browser-check', '--password-store=basic', ...(first ? ['--window-size=1000,720'] : [])];
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env: { ...process.env, ...env } });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

// ---------------------------------------------------------------- remote control (Beam for Linux 1.2)
// Like the PCs' "Allow remote control": off until someone at this computer turns it on (`beam control on`, kept in
// ~/.beam.json; another device can only turn it off). A session (kind vnc, asked for from another device's Beam) is
// this computer's own screen sharing: wayvnc, the VNC server of Raspberry Pi OS's desktop, on a socket only this user
// can open ($XDG_RUNTIME_DIR/beam/vnc.sock), its bytes relayed by Beam to the viewer's page (noVNC) through a
// WebSocket of the agent's own. wayvnc stops a minute after the last session. A notification here says who controls it.

const controlAllowed = () => readConfigFile()?.remoteControl === true;
const RUN_DIR = path.join(process.env.XDG_RUNTIME_DIR || (process.getuid ? `/run/user/${process.getuid()}` : os.tmpdir()), 'beam');
// (tests: BEAM_TEST_VNC_SOCKET, a named pipe on Windows)
const VNC_SOCKET = process.env.BEAM_TEST_VNC_SOCKET || path.join(RUN_DIR, 'vnc.sock');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const controls = new Map(); // session id -> { id, by, link, vnc, lease, started }
let wayvnc = null; // { child, exited, err, stopTimer }
let controlNotices = true; // (the agent's --no-notify turns these off too)

// Why this computer's screen can't be shared at all (null: it can).
function controlUnavailable() {
  if (!process.env.BEAM_TEST_WAYVNC && !findOnPath('wayvnc')) return 'wayvnc isn\'t installed (sudo apt install wayvnc)';
  if (!hasDesktop()) return 'this computer has no desktop';
  return null;
}

// `beam control [on|off]`
async function control(cfg, args) {
  const [want = 'status'] = args;
  if (!AS_LINUX || !linuxApp(cfg)) throw new Error('beam control is Beam for Linux\'s: it lets your other devices control this computer\'s screen');
  if (want === 'status') return `Remote control of this computer is ${controlAllowed() ? 'on (beam control off turns it off)' : 'off (beam control on turns it on)'}`;
  if (want !== 'on' && want !== 'off') throw new Error('Usage: beam control on|off');
  if (want === 'on') {
    const why = controlUnavailable();
    if (why) throw new Error(`not turned on: ${why}`);
  }
  saveConfig({ remoteControl: want === 'on' });
  // (Beam hears it at once; the service says so too, within a minute)
  await api(cfg, '/api/devices/me/status', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remoteControl: want === 'on' }) }).catch(() => {});
  return want === 'on'
    ? 'Remote control of this computer is on: your other devices can see and control its screen (Control, on its page in Beam). beam control off turns it off.'
    : 'Remote control of this computer is off.';
}

// The keyboard layout the computer is set to (Raspberry Pi OS: /etc/default/keyboard), for wayvnc's keyboard.
function keyboardLayout() {
  const text = readSys('etc/default/keyboard') || '';
  const layout = /^XKBLAYOUT="?([a-z]{2,8})/m.exec(text)?.[1];
  const variant = /^XKBVARIANT="?([a-z0-9_]{1,24})/m.exec(text)?.[1];
  return layout ? (variant ? `${layout}-${variant}` : layout) : null;
}

// wayvnc on the private socket, started if it isn't on. Throws, in words for the viewer, when it can't be.
async function startWayvnc() {
  if (wayvnc && !wayvnc.exited) { clearTimeout(wayvnc.stopTimer); return; }
  const env = desktopEnv();
  if (!env) throw new Error('its desktop isn\'t on (nobody is signed in on its screen)');
  if (!(env.WAYLAND_DISPLAY || process.env.WAYLAND_DISPLAY)) throw new Error('its desktop runs on X11, and Beam\'s remote control needs a Wayland one (Raspberry Pi OS: Raspberry Pi Configuration → Advanced)');
  // (tests: BEAM_TEST_WAYVNC, a Node.js script standing in for it)
  const [cmd, ...before] = process.env.BEAM_TEST_WAYVNC ? [process.execPath, process.env.BEAM_TEST_WAYVNC] : [findOnPath('wayvnc')];
  if (!cmd) throw new Error('wayvnc isn\'t installed (sudo apt install wayvnc)');
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(RUN_DIR, 0o700);
  const layout = keyboardLayout();
  const said = [];
  // (wayvnc up to 0.9 listens on a socket with -u <path>; later ones take unix:<path>)
  for (const listen of [['-u', VNC_SOCKET], [`unix:${VNC_SOCKET}`]]) {
    try { fs.rmSync(VNC_SOCKET, { force: true }); } catch {} // (an old one's socket; wayvnc says so if it's still in the way)
    const args = [...before, '--render-cursor', `--socket=${path.join(RUN_DIR, 'wayvncctl')}`, ...(layout ? [`--keyboard=${layout}`] : []), ...listen];
    const state = { child: spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] }), exited: false, err: '', stopTimer: null };
    state.child.stderr.on('data', d => { state.err = (state.err + d).slice(-2000); });
    state.child.on('error', err => { state.exited = true; state.err ||= err.message; });
    state.child.on('exit', code => {
      state.exited = true;
      if (wayvnc !== state) return;
      wayvnc = null;
      logLine(`wayvnc stopped${code ? ` (${oneLine(state.err, 200) || `code ${code}`})` : ''}`);
      for (const id of [...controls.keys()]) stopControl(id); // (its sessions end with it)
    });
    // (looked at once each time: on Windows, where tests put it on a named pipe, each look takes up one of its connections)
    let up = false;
    for (let i = 0; i < 50 && !state.exited && !(up = fs.existsSync(VNC_SOCKET)); i++) await new Promise(r => setTimeout(r, 100));
    if (!state.exited && up) {
      wayvnc = state;
      logLine(`Started wayvnc for remote control${layout ? ` (keyboard ${layout})` : ''}`);
      return;
    }
    state.child.kill();
    said.push(oneLine(state.err.replace(/^.*\bat .*$/gm, ''), 200));
  }
  // (what the first way said, unless it didn't know -u: then the second's)
  const why = /unrecognized|invalid option|unknown option/i.test(said[0]) ? said[1] : said[0] || said[1];
  throw new Error(`wayvnc didn't start${why ? ` (${why})` : ''}`);
}

// A WebSocket to Beam of our own (no npm packages here): https.request's upgrade, then frames, masked as a client's must
// be (lib/websocket.js is the server's half).
function wsFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  const extra = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const head = Buffer.alloc(6 + extra);
  head[0] = 0x80 | opcode;
  head[1] = 0x80 | (len < 126 ? len : len < 65536 ? 126 : 127);
  if (extra === 2) head.writeUInt16BE(len, 2);
  else if (extra === 8) head.writeBigUInt64BE(BigInt(len), 2);
  const mask = crypto.randomBytes(4);
  mask.copy(head, 2 + extra);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, body]);
}

function wsConnect(cfg, route) {
  return new Promise((resolve, reject) => {
    const url = new URL(cfg.url + route);
    const key = crypto.randomBytes(16).toString('base64');
    const req = require(url.protocol === 'https:' ? 'node:https' : 'node:http').request(url, {
      headers: { ...beamHeaders(cfg), Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key },
    });
    const timer = setTimeout(() => req.destroy(new Error('Beam didn\'t answer')), 15_000);
    req.on('upgrade', (res, socket, head) => {
      clearTimeout(timer);
      if (res.headers['sec-websocket-accept'] !== crypto.createHash('sha1').update(key + WS_GUID).digest('base64')) {
        socket.destroy();
        return reject(new Error('Beam\'s answer wasn\'t a WebSocket'));
      }
      resolve(wsLink(socket, head));
    });
    req.on('response', res => {
      clearTimeout(timer);
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => reject(Object.assign(new Error(jsonOr(body).error || `HTTP ${res.statusCode}`), { status: res.statusCode })));
    });
    req.on('error', err => { clearTimeout(timer); reject(err); });
    req.end();
  });
}

// The open WebSocket: send(bytes), close(), and what comes in through receive(fn) and closed(fn).
function wsLink(socket, head) {
  socket.setNoDelay(true);
  socket.on('error', () => {});
  let buf = Buffer.alloc(0);
  let onData = null;
  let onClose = null;
  const queued = [];
  const link = {
    socket, gone: false,
    send: payload => socket.write(wsFrame(2, payload)),
    receive: fn => { onData = fn; for (const p of queued.splice(0)) fn(p); },
    closed: fn => { onClose = fn; if (link.gone) fn(); },
    close: (code = 1000) => {
      if (socket.destroyed || link.closing) return;
      link.closing = true;
      const p = Buffer.alloc(2);
      p.writeUInt16BE(code);
      try { socket.end(wsFrame(8, p)); } catch {}
      setTimeout(() => socket.destroy(), 1000).unref();
    },
  };
  const read = chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      if (buf[1] & 0x80) return socket.destroy(); // (a server's frames are never masked)
      let len = buf[1] & 0x7f;
      let at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        at = 10;
      }
      if (len > 16 << 20) return socket.destroy();
      if (buf.length < at + len) return;
      const payload = Buffer.from(buf.subarray(at, at + len));
      buf = buf.subarray(at + len);
      if (opcode === 9) socket.write(wsFrame(10, payload));
      else if (opcode === 8) link.close();
      else if (opcode <= 2 && payload.length) { if (onData) onData(payload); else queued.push(payload); }
    }
  };
  socket.on('data', read);
  socket.on('close', () => { link.gone = true; onClose?.(); });
  if (head?.length) read(head);
  return link;
}

// rc-request (kind vnc): wayvnc, the session's lease, the relay and the socket, joined.
async function startControl(cfg, request) {
  const { id } = request;
  if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id) || controls.has(id)) return;
  const by = oneLine(request.by, 60) || 'Another device';
  const session = { id, by, link: null, vnc: null, lease: null, started: false };
  controls.set(id, session);
  logLine(`${by} asked to control this computer`);
  try {
    if (!controlAllowed()) throw Object.assign(new Error('remote control is off here (beam control on)'), { reason: 'declined' });
    await startWayvnc();
    await api(cfg, `/api/rc/sessions/${id}/lease`, { method: 'POST' });
    session.lease = setInterval(() => {
      api(cfg, `/api/rc/sessions/${id}/lease`, { method: 'POST' }).catch(err => { if (err.status === 404 || err.status === 410) stopControl(id); });
    }, 30e3);
    session.lease.unref();
    if (!controls.has(id)) return;
    const link = await wsConnect(cfg, `/api/rc/sessions/${id}/vnc`);
    session.link = link;
    if (!controls.has(id)) return link.close();
    const vnc = await new Promise((resolve, reject) => {
      const s = net.connect(VNC_SOCKET);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    session.vnc = vnc;
    if (!controls.has(id)) return vnc.destroy();
    vnc.on('error', () => {});
    // Both ways, each waiting for the other when it's behind.
    vnc.on('data', d => {
      if (!link.send(d) && !session.heldVnc) {
        session.heldVnc = true;
        vnc.pause();
        link.socket.once('drain', () => { session.heldVnc = false; vnc.resume(); });
      }
    });
    link.receive(d => {
      if (!vnc.write(d) && !session.heldLink) {
        session.heldLink = true;
        link.socket.pause();
        vnc.once('drain', () => { session.heldLink = false; link.socket.resume(); });
      }
    });
    vnc.on('close', () => { if (controls.get(id) === session) endControl(cfg, id, 'stopped', 'wayvnc closed the connection'); });
    link.closed(() => stopControl(id));
    session.started = true;
    logLine(`${by} is controlling this computer`);
    if (controlNotices) desktopNotify(`${by} is controlling this computer`, 'Through Beam. To turn remote control off: beam control off');
  } catch (err) {
    logLine(`Didn't share this computer's screen with ${by}: ${err.message}`);
    endControl(cfg, id, err.reason || 'failed', err.message);
  }
}

// This end gives up the session: Beam hears why (the viewer sees its words), then it's let go here.
function endControl(cfg, id, reason, detail = '') {
  if (!controls.has(id)) return;
  stopControl(id);
  api(cfg, `/api/rc/sessions/${id}/end`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason, ...(detail && { detail: oneLine(detail, 160) }) }) }).catch(() => {});
}

// The session is over (rc-end, the relay closed, or this end gave up): everything of it here goes.
function stopControl(id) {
  const session = controls.get(id);
  if (!session) return;
  controls.delete(id);
  clearInterval(session.lease);
  session.link?.close();
  session.vnc?.destroy();
  if (session.started) {
    logLine(`${session.by} stopped controlling this computer`);
    if (controlNotices) desktopNotify(`${session.by} stopped controlling this computer`, 'Beam');
  }
  if (!controls.size && wayvnc && !wayvnc.exited) {
    clearTimeout(wayvnc.stopTimer);
    const was = wayvnc;
    was.stopTimer = setTimeout(() => { if (wayvnc === was && !controls.size) { wayvnc = null; was.child.kill(); logLine('Stopped wayvnc (no one is controlling this computer)'); } }, Number(process.env.BEAM_TEST_WAYVNC_IDLE) || 60e3);
    was.stopTimer.unref();
  }
}

async function agent(cfg, opt) {
  if (!AS_LINUX) throw new Error('beam agent is Beam for Linux; on Windows and Android use their Beam apps (or beam listen)');
  if (!linuxApp(cfg)) {
    cfg.app = 'linux';
    saveConfig({ app: 'linux' });
  }
  logToFile = true;
  controlNotices = !opt['no-notify'];
  logLine(`Beam for Linux ${VERSION} on ${osName()}${hardwareModel() ? `, ${hardwareModel()}` : ''} (Node.js ${process.versions.node})`);
  ensureMenuEntry();
  // At boot the service can start before the network (or Tailscale) is up: wait for Beam, rather than stopping.
  for (let wait = 2000; ; wait = Math.min(wait * 2, 60e3)) {
    try {
      await whoAmI(cfg);
      break;
    } catch (err) {
      if (!err.network) throw err;
      if (wait === 2000) logLine(`Waiting for Beam (${err.message})`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  let full = false; // the server knows the 1.22 fields
  let vnc = false; // (Beam for Linux 1.2) and takes vnc sessions
  let sent = null;
  let reporting = null;
  let quiet = '';
  const report = force => {
    reporting ??= (async () => {
      const status = await linuxStatus(full, vnc);
      if (!force && !statusChanged(sent, status)) return;
      await api(cfg, '/api/devices/me/status', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(status) });
      if (!sent) logLine(`Told Beam how this computer is: ${[status.os, status.model, status.temperature !== undefined && `${status.temperature} °C`, status.storage && `${formatSize(status.storage.free)} free`].filter(Boolean).join(', ')}`);
      sent = status;
      quiet = '';
    })().catch(err => {
      if (!err.network && quiet !== err.message) logLine(`Couldn't report this computer's status: ${(quiet = err.message)}`);
    }).finally(() => { reporting = null; });
    return reporting;
  };
  setInterval(() => report(false), 60e3).unref();
  setInterval(() => report(true), STATUS_EVERY).unref();
  setInterval(() => checkForUpdate(cfg), UPDATE_EVERY).unref();
  await listen(cfg, { ...opt, agent: true }, {
    onHello: hello => {
      full = Array.isArray(hello.features) && hello.features.includes('linux');
      vnc = Array.isArray(hello.features) && hello.features.includes('vnc');
      sent = null; // a new connection: tell it all again
      report(true);
      checkForUpdate(cfg);
    },
    onEvent: (name, data) => {
      if (name === 'log-request' && typeof data.id === 'string') sendLog(cfg, data.id).catch(err => logLine(`Couldn't send the log: ${err.message}`));
      else if (name === 'app-update' && data.linux) checkForUpdate(cfg);
      else if (name === 'rc-request' && data.kind === 'vnc') startControl(cfg, data); // (Beam for Linux 1.2)
      else if (name === 'rc-end' && typeof data.id === 'string') stopControl(data.id);
      else if (name === 'rename' && typeof data.name === 'string' && data.name.trim() && data.name !== cfg.device) {
        // (Beam for Linux 1.2.1) renamed in Beam's window here: kept, and said from now on (which tells Beam it's done)
        cfg.device = data.name;
        try { saveConfig({ device: data.name }); } catch (err) { logLine(`Couldn't keep the new name in ${CONFIG_FILE}: ${err.message}`); }
        logLine(`This computer is called ${oneLine(data.name, 60)} in Beam now`);
        report(true);
      }
      else if (name === 'rc-disable' && controlAllowed()) {
        // turned off from another device: off here too (only someone at this computer turns it on again)
        saveConfig({ remoteControl: false });
        logLine(`${oneLine(data.by, 60) || 'Another device'} turned remote control of this computer off`);
        for (const id of [...controls.keys()]) stopControl(id);
        report(true);
      }
    },
  });
}

// ---------------------------------------------------------------- main

const COMMANDS = new Set(['login', 'setup', 'status', 'devices', 'send', 'text', 'clip', 'get', 'pull', 'ls', 'list', 'rm', 'approve', 'listen', 'open', 'pair', 'help', 'agent', 'version', 'window', 'control']);

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
        'sign-in': { type: 'boolean' },
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
  if (cmd === 'version') return console.log(VERSION);
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
        case 'agent': await agent(cfg, opt); break;
        case 'open': await openWebApp(cfg, opt); break;
        case 'window': await openWindow(cfg, opt); break;
        case 'control': result = await control(cfg, args); break;
        case 'pair': await pair(cfg); break;
      }
    }
  } catch (err) {
    if (opt.toast) await desktopNotify('Beam: something went wrong', err.message);
    console.error(`beam: ${err.message}`);
    process.exitCode = 1;
    if (cmd === 'agent' && AS_LINUX) {
      // (1.22) Its service starts it again: in its log why, and once a minute rather than every few seconds.
      logToFile = true;
      logLine(`Stopped: ${err.message}`);
      await new Promise(r => setTimeout(r, Number(process.env.BEAM_TEST_AGENT_PAUSE) || 60e3));
    }
    return;
  }
  if (!result) return;
  if (opt.toast) await desktopNotify('Beam', result);
  else if (!['get', 'pull', 'send'].includes(cmd)) console.log(result);
}

main();
