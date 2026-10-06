'use strict';
// Talking to the local tailscaled: its LocalAPI over the unix socket when BEAM_TAILSCALE_SOCKET is set (Docker,
// where there's no `tailscale` command), otherwise the command itself. Answers are cached, and every failure
// just means "unknown": Beam works without Tailscale.

const http = require('node:http');
const net = require('node:net');
const { execFile } = require('node:child_process');

// Tailscale hands out addresses from these ranges, one IPv4 and one IPv6 per machine.
const TAILNET = new net.BlockList();
TAILNET.addSubnet('100.64.0.0', 10, 'ipv4');
TAILNET.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');

function isTailscaleIp(ip) {
  const family = net.isIP(ip || '');
  return family ? TAILNET.check(ip, family === 6 ? 'ipv6' : 'ipv4') : false;
}

// (1.17) Addresses that stay inside one network: a direct path to one of these is "on the same network" (the
// Windows app's RcPolicy.PrivateEndpoint says the same).
const PRIVATE = new net.BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('169.254.0.0', 16, 'ipv4');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');
PRIVATE.addSubnet('fe80::', 10, 'ipv6');

function isPrivateAddress(ip) {
  const family = net.isIP(ip || '');
  return family ? PRIVATE.check(ip, family === 6 ? 'ipv6' : 'ipv4') : false;
}

// The address in an endpoint ("203.0.113.5:41641", "[2001:db8::1]:41641"), or null when it isn't one.
function endpointHost(endpoint) {
  const m = /^\[([0-9a-fA-F:.]+)\]:\d{1,5}$/.exec(endpoint) || /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(endpoint);
  return m && net.isIP(m[1]) ? m[1] : null;
}

// (1.17) How tailscaled reaches a peer, from its `tailscale status` entry: { via: 'direct', lan } (lan: an address of
// the same network), { via: 'peer-relay' } or { via: 'relay', relay: <region code> } through Tailscale's own relay.
// Null while the peer is idle: tailscaled hasn't settled a path then, and Relay is only the peer's home relay.
function pathOf(peer) {
  if (!peer) return null;
  const host = endpointHost(String(peer.CurAddr || ''));
  if (host) return { via: 'direct', lan: isPrivateAddress(host) };
  if (peer.PeerRelay) return { via: 'peer-relay' };
  if (peer.Active === true && peer.Relay) return { via: 'relay', relay: regionCode(peer.Relay) };
  return null;
}

const regionCode = code => clean(code).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16);

// A time from tailscaled, or null (Go's zero time, 0001-01-01, means "never").
function timeOf(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) && t > Date.UTC(2001, 0, 1) ? t : null;
}

// (1.17) What tailscaled knows about every machine, by each of its addresses (like machineIndex): { online, lastSeen
// (while offline: when Tailscale last saw it), keyExpiry (null: its key doesn't run out), expired, path, self }.
function machineFacts(status, at = Date.now()) {
  const facts = new Map();
  if (!status) return facts;
  const add = (node, self) => {
    const keyExpiry = timeOf(node.KeyExpiry);
    const f = {
      online: self || node.Online === true,
      lastSeen: self ? null : timeOf(node.LastSeen),
      keyExpiry,
      expired: node.Expired === true || (keyExpiry !== null && keyExpiry <= at),
      path: self ? null : pathOf(node),
      self,
    };
    for (const ip of node.TailscaleIPs || []) facts.set(ip, f);
  };
  if (status.Self) add(status.Self, true);
  for (const peer of Object.values(status.Peer || {})) add(peer, false);
  return facts;
}

// (1.17) `tailscale ping` prints a line per answer: "pong from pc (100.101.102.103) via 203.0.113.5:41641 in 51ms",
// "via DERP(nyc)" through Tailscale's relay, "via peer-relay(…)" through a peer relay. -> [{ via, lan?, relay?, ms }]
function parsePing(text) {
  const pongs = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^pong from .+? \([^)]*\) via (.+?) in ([\d.]+)(µs|us|ms|s)$/.exec(line.trim());
    const via = m && viaOf(m[1]);
    if (via) pongs.push({ ...via, ms: Math.round(Number(m[2]) * { µs: 0.001, us: 0.001, ms: 1, s: 1000 }[m[3]] * 10) / 10 });
  }
  return pongs;
}

// One answer's way: an endpoint is direct, DERP(<code>) Tailscale's relay; anything else new says nothing.
function viaOf(via) {
  const derp = /^DERP\(([^)]*)\)$/i.exec(via);
  if (derp) return { via: 'relay', relay: regionCode(derp[1]) };
  const host = endpointHost(via);
  if (host) return { via: 'direct', lan: isPrivateAddress(host) };
  if (/^peer-?relay\b/i.test(via)) return { via: 'peer-relay' };
  return null;
}

// The answers of one test -> the path of the last one (the first may still go through the relay while tailscaled
// finds the direct way) and the middle delay of the answers that took it (the first wakes a sleeping phone).
function summarizePongs(pongs) {
  if (!pongs.length) return null;
  const last = pongs[pongs.length - 1];
  const same = pongs.filter(p => p.via === last.via && p.relay === last.relay).map(p => p.ms).sort((a, b) => a - b);
  return { ...last, ms: same[Math.floor((same.length - 1) / 2)], answers: pongs.length };
}

// Tailscale sends non-ASCII names in headers as RFC 2047 encoded words (=?utf-8?q?J=C3=BCrgen?=).
function decodeHeaderWords(value) {
  return String(value || '').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (word, charset, encoding, text) => {
    try {
      const bytes = encoding.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64')
        : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
      return new TextDecoder(charset.toLowerCase()).decode(bytes);
    } catch {
      return word;
    }
  });
}

const BINARIES = {
  win32: ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe'],
  darwin: ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'],
}[process.platform] || ['tailscale'];

// statusTtl: how long a `tailscale status` answer is reused (the tests make it short, to see their changes).
function createClient({ socket = '', statusTtl = 30_000 } = {}) {
  let binary = null; // the first command that exists, once found

  // partial: also what it printed before failing (`tailscale ping` exits with an error when a ping goes unanswered).
  function runCli(args, { timeout = 5000, partial = false } = {}) {
    const tryAt = i => new Promise(resolve => {
      const cmd = binary || BINARIES[i];
      if (!cmd) return resolve(null);
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err?.code === 'ENOENT' && !binary) return resolve(tryAt(i + 1));
        if (!err || (partial && typeof err.code === 'number')) binary = cmd;
        resolve(!err ? stdout : partial && err.code !== 'ENOENT' ? String(stdout || '') : null);
      });
    });
    return tryAt(0);
  }

  function localApi(route, { method = 'GET', timeout = 5000 } = {}) {
    return new Promise(resolve => {
      const req = http.request({ socketPath: socket, method, path: `/localapi/v0/${route}`, headers: { Host: 'local-tailscaled.sock' }, timeout }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
        });
        res.on('error', () => resolve(null));
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  async function query(route, args) {
    if (socket) return localApi(route);
    const out = await runCli(args);
    if (!out) return null;
    try { return JSON.parse(out); } catch { return null; }
  }

  // One cached value per key, refreshed after `ttl`; concurrent callers share one lookup.
  function cached(ttl, load) {
    const entries = new Map();
    return (key = '') => {
      const hit = entries.get(key);
      if (hit && (hit.pending || Date.now() - hit.at < ttl)) return hit.pending || Promise.resolve(hit.value);
      const pending = load(key).catch(() => null).then(value => {
        entries.set(key, { at: Date.now(), value });
        if (entries.size > 500) entries.delete(entries.keys().next().value);
        return value;
      });
      entries.set(key, { ...hit, pending });
      return pending;
    };
  }

  const status = cached(statusTtl, () => query('status', ['status', '--json']));
  const serveConfig = cached(30_000, () => query('serve-config', ['serve', 'status', '--json']));
  const whoisRaw = cached(60_000, ip => query(`whois?addr=${encodeURIComponent(net.isIPv6(ip) ? `[${ip}]:0` : `${ip}:0`)}`, ['whois', '--json', ip]));

  // { login, name, node, stableId, ips, tagged } for a tailnet address, or null when unknown.
  async function whois(ip) {
    if (!isTailscaleIp(ip)) return null;
    const d = await whoisRaw(ip);
    if (!d || !d.UserProfile) return null;
    const node = d.Node || {};
    return {
      login: clean(d.UserProfile.LoginName).toLowerCase(),
      name: clean(d.UserProfile.DisplayName),
      node: clean(node.ComputedName || node.Hostinfo?.Hostname || String(node.Name || '').split('.')[0] || ''),
      stableId: String(node.StableID || ''),
      ips: (Array.isArray(node.Addresses) ? node.Addresses : []).map(a => String(a).split('/')[0]),
      tagged: Array.isArray(node.Tags) && node.Tags.length > 0,
    };
  }

  // (1.17) How tailscaled reaches `ip` right now: `count` disco pings (`tailscale ping`, or the LocalAPI's in Docker)
  // -> summarizePongs: { via, lan?, relay?, ms, answers }, or null when nothing answered (or there's no tailscaled).
  async function ping(ip, { count = 3 } = {}) {
    if (!isTailscaleIp(ip)) return null;
    if (!socket) {
      const out = await runCli(['ping', '--c', String(count), '--until-direct=false', '--timeout', '3s', ip], { timeout: count * 4500 + 2000, partial: true });
      return summarizePongs(parsePing(out));
    }
    const pongs = [];
    for (let i = 0; i < count; i++) {
      if (i) await new Promise(r => setTimeout(r, 500));
      const r = await localApi(`ping?ip=${encodeURIComponent(ip)}&type=disco`, { method: 'POST', timeout: 4000 });
      if (!r || r.Err || !Number.isFinite(r.LatencySeconds)) continue;
      const via = r.DERPRegionID ? { via: 'relay', relay: regionCode(r.DERPRegionCode) } : r.PeerRelay ? { via: 'peer-relay' } : viaOf(String(r.Endpoint || ''));
      if (via) pongs.push({ ...via, ms: Math.round(r.LatencySeconds * 10000) / 10 });
    }
    return summarizePongs(pongs);
  }

  return { status, serveConfig, whois, ping, source: socket ? `LocalAPI at ${socket}` : 'the tailscale command' };
}

// Names from tailscaled end up in the activity log and on pages: one line, no control or bidi characters, a sane
// length (1.7.3, audit S-30; Tailscale constrains them anyway).
function clean(value) {
  return String(value ?? '').toWellFormed()
    .replace(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 200);
}

// Every Tailscale address in a status answer -> { key, id, name, dns, user, self }. A machine's IPv4 and IPv6
// addresses share one key, so a browser on IPv6 and an app on IPv4 are still the same machine. id is its StableID,
// dns its MagicDNS name (without the trailing dot).
function machineIndex(status) {
  const index = new Map();
  if (!status) return index;
  const userOf = id => clean(status.User?.[id]?.LoginName);
  const dnsOf = node => clean(String(node.DNSName || '').replace(/\.$/, '')).toLowerCase();
  const self = status.Self || {};
  for (const ip of self.TailscaleIPs || []) index.set(ip, { key: 'host', id: String(self.ID || ''), name: clean(self.HostName), dns: dnsOf(self), user: userOf(self.UserID), self: true });
  for (const peer of Object.values(status.Peer || {})) {
    const ips = peer.TailscaleIPs || [];
    const key = ips.find(a => net.isIPv4(a)) || ips[0];
    const name = clean(peer.HostName || String(peer.DNSName || '').split('.')[0]);
    for (const ip of ips) index.set(ip, { key, id: String(peer.ID || ''), name, dns: dnsOf(peer), user: userOf(peer.UserID), self: false });
  }
  return index;
}

module.exports = { createClient, isTailscaleIp, decodeHeaderWords, machineIndex, machineFacts, pathOf, parsePing, summarizePongs, isPrivateAddress };
