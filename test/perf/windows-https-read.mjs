#!/usr/bin/env node
// Beam for Windows: the download read loop over HTTPS vs plain HTTP (re-review R4) and at a sender's pause (R1).
//
//   node test/perf/windows-https-read.mjs [--mb 256] [--runs 3]
//
// A scratch server (this checkout's server.js) on 127.0.0.1:8806 and a TLS-terminating proxy in front of it on 8856
// (like `tailscale serve`: records of up to 16 KB), with a throwaway self-signed certificate made by openssl in a temp
// folder. windows-https-read.cs (compiled with the app's own src\SliceReader.cs) downloads through both, with three
// read loops: new (SliceReader), short (1.4.0 after the first review) and full (1.4.0 as first built), and reports
// MB/s, reads, writes and CPU. The certificate is accepted by that harness alone, by thumbprint: nothing is added to
// any certificate store, and Beam.exe itself isn't involved.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = 8806, TLS_PORT = 8856;
const MB = 1 << 20;
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? Number(args[i + 1]) : def; };
const SIZE_MB = opt('mb', 256), RUNS = opt('runs', 3);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TMP = path.join(os.tmpdir(), `beam-https-read-${Date.now()}`);
fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'dist'), { recursive: true });

function findOpenssl() {
  const candidates = ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe'];
  return candidates.find(c => { try { return spawnSync(c, ['version'], { windowsHide: true }).status === 0; } catch { return false; } });
}

let server, proxy;
const sockets = new Set();
try {
  // The harness.
  const csc = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const exe = path.join(TMP, 'https-read.exe');
  const built = spawnSync(csc, ['/nologo', '/target:exe', '/optimize+', '/langversion:5', `/out:${exe}`, '/r:System.Net.Http.dll',
    path.join(HERE, 'windows-https-read.cs'), path.join(ROOT, 'windows', 'src', 'SliceReader.cs')], { encoding: 'utf8', windowsHide: true });
  if (built.status !== 0) throw new Error('harness build failed: ' + built.stdout + built.stderr);

  // A throwaway certificate for 127.0.0.1.
  const openssl = findOpenssl();
  if (!openssl) throw new Error('openssl not found (Git for Windows has one)');
  const key = path.join(TMP, 'key.pem'), certFile = path.join(TMP, 'cert.pem');
  const made = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certFile, '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8', windowsHide: true });
  if (made.status !== 0) throw new Error('openssl: ' + made.stderr);
  const certPem = fs.readFileSync(certFile, 'utf8');
  const thumb = new crypto.X509Certificate(certPem).fingerprint.replace(/:/g, '');

  // The scratch server, and the TLS proxy in front of it.
  const out = fs.openSync(path.join(TMP, 'server.log'), 'a');
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, BEAM_TAILSCALE: 'off', BEAM_HOST: '127.0.0.1', BEAM_PORT: String(PORT), BEAM_DATA: path.join(TMP, 'data'), BEAM_DIST: path.join(TMP, 'dist') } });
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/hello')).ok) break; } catch {} await sleep(200); }
  const apiKey = fs.readFileSync(path.join(TMP, 'data', 'key'), 'utf8').trim();
  proxy = tls.createServer({ key: fs.readFileSync(key), cert: certPem }, c => {
    const s = net.connect(PORT, '127.0.0.1');
    sockets.add(c); sockets.add(s);
    c.pipe(s); s.pipe(c);
    const done = () => { c.destroy(); s.destroy(); sockets.delete(c); sockets.delete(s); };
    c.on('error', done); s.on('error', done); c.on('close', done); s.on('close', done);
  });
  await new Promise(r => proxy.listen(TLS_PORT, '127.0.0.1', r));

  const peer = 'httpsreadpeer' + crypto.randomBytes(6).toString('hex');
  const headers = { Authorization: `Bearer ${apiKey}`, 'X-Beam-Device-Id': peer, 'X-Beam-Device': 'Read Test', 'X-Beam-Platform': 'android', 'X-Forwarded-For': '100.64.0.2' };
  const api = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  };
  const upload = async (id, data, from, to) => {
    for (let off = from; off < to;) {
      const n = Math.min(8 * MB, to - off);
      const r = await fetch(`${base}/api/uploads/${id}?offset=${off}`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: data.subarray(off, off + n) });
      const d = await r.json().catch(() => ({}));
      if (r.status === 201) return;
      if (r.status !== 200) throw new Error(`PUT ${off}: ${r.status}`);
      off = d.offset;
    }
  };
  await api('GET', '/api/devices');
  const hdrArgs = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  // Run asynchronously: the TLS proxy lives in this process and must keep serving meanwhile.
  const read = (url, reader, from = 0, idleStop = 0) => new Promise((resolve, reject) => {
    const p = spawn(exe, [url, reader, path.join(TMP, `out-${reader}.bin`), thumb, String(from), String(idleStop), ...hdrArgs], { windowsHide: true });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, 300000);
    p.on('close', code => {
      clearTimeout(timer);
      const line = stdout.trim().split(/\r?\n/).pop();
      try { resolve(JSON.parse(line)); } catch { reject(new Error(`harness (exit ${code}): ${stdout} ${stderr}`)); }
    });
  });

  // Throughput: a finished file, every reader over both transports, interleaved.
  const data = crypto.randomBytes(SIZE_MB * MB);
  const c = await api('POST', '/api/uploads', { name: 'r.bin', size: data.length, mime: 'application/octet-stream', to: [] });
  await upload(c.id, data, 0, data.length);
  const urls = { http: `${base}/api/file/${c.id}`, https: `https://127.0.0.1:${TLS_PORT}/api/file/${c.id}` };
  const results = {};
  for (let run = 0; run < RUNS + 1; run++)
    for (const t of ['http', 'https'])
      for (const reader of ['full', 'short', 'new']) {
        const r = await read(urls[t], reader);
        if (r.error || r.written !== data.length) throw new Error(`${t}/${reader}: ${JSON.stringify(r)}`);
        if (run === 0) continue; // warm-up (page cache, JIT of the server's paths)
        (results[`${t}/${reader}`] ||= []).push(r);
      }
  const median = xs => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(`\n${SIZE_MB} MB, ${RUNS} runs each (median), loopback; CPU of the reading process`);
  console.log('transport/reader  MB/s     reads  avg read  writes  avg write  CPU ms/GB  Mcycles/GB');
  for (const [k, rs] of Object.entries(results)) {
    const gb = data.length / 1024 / MB;
    const secs = median(rs.map(r => r.secs));
    const row = [k.padEnd(16), (data.length / MB / secs).toFixed(1).padStart(6), String(median(rs.map(r => r.reads))).padStart(8),
      ((data.length / median(rs.map(r => r.reads))) / 1024).toFixed(1).padStart(7) + ' KB', String(median(rs.map(r => r.writes))).padStart(7),
      ((data.length / median(rs.map(r => r.writes))) / 1024).toFixed(0).padStart(7) + ' KB', (median(rs.map(r => r.cpuMs)) / gb).toFixed(0).padStart(9),
      (median(rs.map(r => r.mcycles)) / gb).toFixed(0).padStart(11)];
    console.log(row.join('  '));
  }

  // A sender that pauses right after full reads: the upload stands at 8 MB + 64 KB, the reader starts 192 KB before.
  // What reaches the file before the read that waits is given up (3 s without bytes)?
  const big = crypto.randomBytes(40 * MB);
  const u = await api('POST', '/api/uploads', { name: 'p.bin', size: big.length, mime: 'application/octet-stream', to: [] });
  const paused = 8 * MB + 64 * 1024, start = paused - 192 * 1024;
  await upload(u.id, big, 0, paused);
  console.log(`\nSender paused at ${paused}; reading from ${start} (192 KB available), stopping after 3 s without bytes`);
  for (const t of ['http', 'https'])
    for (const reader of ['full', 'short', 'new']) {
      const url = t === 'http' ? `${base}/api/file/${u.id}` : `https://127.0.0.1:${TLS_PORT}/api/file/${u.id}`;
      const r = await read(url, reader, start, 3000);
      console.log(`${(t + '/' + reader).padEnd(16)}  written ${String(r.onDisk).padStart(6)} of ${paused - start}  (${r.reads} reads, ${r.writes} writes)${r.onDisk === paused - start ? '' : '  <- held back'}`);
    }
} catch (e) {
  console.error('ERROR ' + (e.stack || e));
  process.exitCode = 1;
} finally {
  try { proxy && proxy.close(); for (const s of sockets) s.destroy(); } catch {}
  try { server && server.kill(); } catch {}
  await sleep(500);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}
