#!/usr/bin/env node
// Beam for Windows 1.6: the remote control input mapping, without any real input.
//
//   node test/perf/windows-input-test.mjs [--keep]
//
// Compiles test/perf/windows-input-test.cs with windows/src/InputInjector.cs and RcPolicy.cs (/define:NO_REAL_INPUT:
// no SendInput in the binary; checked below) into a temp folder and runs it. The test records INPUT structures and
// asserts them exactly: several monitors with mixed DPI, scancodes, extended keys, AltGr, Unicode text, release-all,
// rate caps, plus the session policy and peer checks, signed updates (1.7.3) and the remote-control banner's place
// (RcBannerPlace.cs, 1.7.4). Exits 1 if anything fails.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const KEEP = process.argv.includes('--keep');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-input-test-'));
const windir = process.env.WINDIR || 'C:\\Windows';
const csc = [path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')].find(f => fs.existsSync(f));
let code = 1;
try {
  if (!csc) throw new Error('No .NET Framework C# compiler');
  const exe = path.join(TMP, 'input-test.exe');
  // Signed updates (1.7.3): two throwaway keys (never the builder's), a signature from each over a made-up update.
  const xy = key => { const j = crypto.createPublicKey(key).export({ format: 'jwk' }); return Buffer.concat([Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64'); };
  const [mine, other] = [0, 1].map(() => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey);
  const update = { version: '9.8.7', sha: crypto.randomBytes(32).toString('hex'), size: 1234567 };
  const sign = key => crypto.sign('sha256', Buffer.from(`beam-windows-update\n${update.version}\n${update.sha}\n${update.size}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64');
  const vectors = path.join(TMP, 'update-vectors.cs');
  fs.writeFileSync(vectors, `namespace Beam {
  static class UpdateKey { public const string PublicKey = "${xy(mine)}"; }
  static class UpdateVectors {
    public const string Version = "${update.version}", Sha = "${update.sha}", Sig = "${sign(mine)}", OtherKey = "${xy(other)}", OtherSig = "${sign(other)}";
    public const long Size = ${update.size};
  }
}
`);
  const build = spawnSync(csc, ['/nologo', '/target:exe', '/platform:anycpu', '/langversion:5', '/codepage:65001', '/define:NO_REAL_INPUT',
    `/out:${exe}`, '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll',
    path.join(HERE, 'windows-input-test.cs'), path.join(ROOT, 'windows', 'src', 'InputInjector.cs'), path.join(ROOT, 'windows', 'src', 'RcPolicy.cs'),
    path.join(ROOT, 'windows', 'src', 'UpdateSignature.cs'), path.join(ROOT, 'windows', 'src', 'RcBannerPlace.cs'), vectors],
  { encoding: 'utf8', windowsHide: true });
  if (build.status !== 0) throw new Error('Build failed:\n' + build.stdout + build.stderr);
  // The binary must not even contain SendInput (nor the backend that calls it).
  const bytes = fs.readFileSync(exe);
  const has = s => bytes.includes(Buffer.from(s, 'utf8')) || bytes.includes(Buffer.from(s, 'utf16le'));
  const clean = !has('SendInput') && !has('mouse_event') && !has('keybd_event');
  console.log(`${clean ? 'ok  ' : 'FAIL'} the test binary has no SendInput, mouse_event or keybd_event`);
  const run = spawnSync(exe, [], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  process.stdout.write(run.stdout || '');
  process.stderr.write(run.stderr || '');
  code = clean && run.status === 0 ? 0 : 1;
} catch (e) {
  console.error(e.message);
} finally {
  if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true });
  else console.log('kept ' + TMP);
}
process.exit(code);
