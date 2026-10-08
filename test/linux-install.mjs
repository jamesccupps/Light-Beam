#!/usr/bin/env node
// Beam for Linux's installer end to end, on a real Linux computer with systemd: CI's Ubuntu runner (ci.yml runs it
// after `sudo loginctl enable-linger`). It installs Beam for Linux as a service for the user running it, so it refuses
// to run anywhere but CI. A scratch Beam (127.0.0.1:8799) serves linux/install.sh and a build signed with a throwaway
// key; the installer runs the way a person runs it (curl | bash, with Beam's own Node.js from nodejs.org); its sign-in
// request is approved here; then the service must be on, the computer's status in Beam and its log readable from
// another device; --uninstall takes it all away again.
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (process.platform !== 'linux' || process.env.CI !== 'true') {
  console.error('test/linux-install.mjs installs Beam for Linux for this user, as a service: it runs only in CI (Linux, CI=true).');
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-linux-install-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BEAM_')));
const serverEnv = { ...env, BEAM_HOST: '127.0.0.1', BEAM_PORT: String(PORT), BEAM_DATA: path.join(tmp, 'data'), BEAM_DIST: path.join(tmp, 'dist'), BEAM_TAILSCALE: 'off', BEAM_TEST_TIMEOUTS: '1', BEAM_WOL_TARGETS: '127.0.0.1:9' };
const uid = process.getuid();
// systemctl --user from a CI step: the user manager that linger started
const userEnv = { ...env, XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` };
let server;
let failed = false;

function check(ok, what, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${!ok && detail ? `\n      ${String(detail).split('\n').slice(-15).join('\n      ')}` : ''}`);
  if (!ok) {
    failed = true;
    console.log(`::error title=Beam for Linux's installer::${what}: ${String(detail).slice(-1500).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A')}`);
  }
  return ok;
}

// (not spawnSync: the sign-in is approved from this process while the installer waits)
const installer = (args = '') => new Promise(resolve => {
  const child = spawn('bash', ['-c', `curl -fsSL ${BASE}/install/linux | bash -s -- ${args}`], { env: userEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  child.on('close', status => resolve({ status, stdout, stderr }));
});

try {
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  execFileSync(process.execPath, [path.join(ROOT, 'linux', 'build.mjs'), '--out', path.join(tmp, 'dist')], { env: { ...env, BEAM_UPDATE_KEY: path.join(tmp, 'throwaway-key.pem') }, stdio: 'pipe' });
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: serverEnv, stdio: 'ignore' });
  let key = null;
  for (let i = 0; i < 150 && !key; i++) { await sleep(100); try { key = fs.readFileSync(path.join(tmp, 'data', 'key'), 'utf8').trim(); } catch {} }
  const admin = { Authorization: `Bearer ${key}`, 'X-Beam-Device-Id': 'ciadmin00001', 'X-Beam-Device': 'CI', 'X-Beam-Platform': 'windows', 'Content-Type': 'application/json' };
  const api = async (route, opts = {}) => (await fetch(`${BASE}${route}`, { ...opts, headers: admin })).json();
  for (let i = 0; i < 50 && !fs.existsSync(`/run/user/${uid}/bus`); i++) await sleep(200);
  // The installer's sign-in, approved the way a person does on another device.
  const approving = setInterval(async () => {
    try {
      for (const r of (await api('/api/login-requests')).requests || []) await api('/api/login-requests/approve', { method: 'POST', body: JSON.stringify({ code: r.code }) });
    } catch {}
  }, 500);

  let r = await installer('--name "CI Linux" --own-node');
  clearInterval(approving);
  check(r.status === 0, 'the installer finishes', `${r.stdout}\n${r.stderr}`);
  check(/Node\.js v\d+/.test(r.stdout), 'it brought its own Node.js from nodejs.org (checked against its checksums)', r.stdout);
  const active = spawnSync('systemctl', ['--user', 'is-active', 'beam.service'], { env: userEnv, encoding: 'utf8' });
  check(active.stdout.trim() === 'active', 'the service is on', active.stdout + active.stderr);
  const linger = spawnSync('loginctl', ['show-user', os.userInfo().username, '--property=Linger', '--value'], { encoding: 'utf8' });
  check(linger.stdout.trim() === 'yes', 'it starts with the computer (linger)', linger.stdout);
  let dev = null;
  for (let i = 0; i < 60 && !dev?.status?.os; i++) {
    await sleep(500);
    dev = ((await api('/api/devices')).devices || []).find(d => d.name === 'CI Linux');
  }
  check(dev?.platform === 'linux' && Boolean(dev?.appVersion), 'Beam knows it as Beam for Linux', JSON.stringify(dev));
  check(Boolean(dev?.status?.os && dev.status.storage?.total && dev.status.bootedAt), 'its status: system, disk, when it started', JSON.stringify(dev?.status));
  console.log(`      (${dev?.status?.os} · ${dev?.status?.model || 'no model'} · ${dev?.status?.temperature ?? 'no'} °C)`);
  if (dev) {
    const res = await fetch(`${BASE}/api/devices/${dev.id}/log`, { method: 'POST', headers: admin, body: '{}' });
    const log = await res.json();
    check(res.status === 200 && /Beam for Linux/.test(log.text || ''), 'its log, from another device', JSON.stringify(log).slice(0, 500));
  }
  r = await installer();
  check(r.status === 0 && /Signed in already/.test(r.stdout), 'running it again updates it (signed in already)', `${r.stdout}\n${r.stderr}`);
  r = await installer('--uninstall');
  check(r.status === 0, '--uninstall', `${r.stdout}\n${r.stderr}`);
  const gone = spawnSync('systemctl', ['--user', 'is-active', 'beam.service'], { env: userEnv, encoding: 'utf8' });
  check(gone.stdout.trim() !== 'active' && !fs.existsSync(path.join(os.homedir(), '.local', 'share', 'beam')), 'and it is gone', gone.stdout);
} catch (err) {
  check(false, 'the run', err.stack);
} finally {
  server?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? '\nBeam for Linux\'s installer: FAILED' : '\nBeam for Linux\'s installer: ok');
process.exit(failed ? 1 : 0);
