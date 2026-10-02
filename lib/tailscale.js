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

function createClient({ socket = '' } = {}) {
  let binary = null; // the first command that exists, once found

  function runCli(args) {
    const tryAt = i => new Promise(resolve => {
      const cmd = binary || BINARIES[i];
      if (!cmd) return resolve(null);
      execFile(cmd, args, { timeout: 5000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err?.code === 'ENOENT' && !binary) return resolve(tryAt(i + 1));
        if (!err) binary = cmd;
        resolve(err ? null : stdout);
      });
    });
    return tryAt(0);
  }

  function localApi(route) {
    return new Promise(resolve => {
      const req = http.request({ socketPath: socket, path: `/localapi/v0/${route}`, headers: { Host: 'local-tailscaled.sock' }, timeout: 5000 }, res => {
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

  const status = cached(30_000, () => query('status', ['status', '--json']));
  const serveConfig = cached(30_000, () => query('serve-config', ['serve', 'status', '--json']));
  const whoisRaw = cached(60_000, ip => query(`whois?addr=${encodeURIComponent(net.isIPv6(ip) ? `[${ip}]:0` : `${ip}:0`)}`, ['whois', '--json', ip]));

  // { login, name, node, stableId, ips, tagged } for a tailnet address, or null when unknown.
  async function whois(ip) {
    if (!isTailscaleIp(ip)) return null;
    const d = await whoisRaw(ip);
    if (!d || !d.UserProfile) return null;
    const node = d.Node || {};
    return {
      login: String(d.UserProfile.LoginName || '').trim().toLowerCase(),
      name: String(d.UserProfile.DisplayName || ''),
      node: node.ComputedName || node.Hostinfo?.Hostname || String(node.Name || '').split('.')[0] || '',
      stableId: String(node.StableID || ''),
      ips: (Array.isArray(node.Addresses) ? node.Addresses : []).map(a => String(a).split('/')[0]),
      tagged: Array.isArray(node.Tags) && node.Tags.length > 0,
    };
  }

  return { status, serveConfig, whois, source: socket ? `LocalAPI at ${socket}` : 'the tailscale command' };
}

// Every Tailscale address in a status answer -> { key, id, name, dns, user, self }. A machine's IPv4 and IPv6
// addresses share one key, so a browser on IPv6 and an app on IPv4 are still the same machine. id is its StableID,
// dns its MagicDNS name (without the trailing dot).
function machineIndex(status) {
  const index = new Map();
  if (!status) return index;
  const userOf = id => status.User?.[id]?.LoginName || '';
  const dnsOf = node => String(node.DNSName || '').replace(/\.$/, '').toLowerCase();
  const self = status.Self || {};
  for (const ip of self.TailscaleIPs || []) index.set(ip, { key: 'host', id: String(self.ID || ''), name: self.HostName || '', dns: dnsOf(self), user: userOf(self.UserID), self: true });
  for (const peer of Object.values(status.Peer || {})) {
    const ips = peer.TailscaleIPs || [];
    const key = ips.find(a => net.isIPv4(a)) || ips[0];
    const name = peer.HostName || String(peer.DNSName || '').split('.')[0];
    for (const ip of ips) index.set(ip, { key, id: String(peer.ID || ''), name, dns: dnsOf(peer), user: userOf(peer.UserID), self: false });
  }
  return index;
}

module.exports = { createClient, isTailscaleIp, decodeHeaderWords, machineIndex };
