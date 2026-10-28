#!/usr/bin/env node
// Beam for Windows 1.19.3: what the hand-painted controls tell Windows' accessibility (the audit of 2026-10-11).
//
//   node test/perf/windows-a11y-test.mjs [--keep]
//
// Compiles test/perf/windows-a11y-test.cs with windows/src/Theme.cs and Util.cs into a temp folder and runs it: the
// controls are created and asked (no window shown, nothing clicked or typed). Exits 1 if anything fails.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const KEEP = process.argv.includes('--keep');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-a11y-test-'));
const windir = process.env.WINDIR || 'C:\\Windows';
const csc = [path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')].find(f => fs.existsSync(f));
let code = 1;
try {
  if (!csc) throw new Error('No .NET Framework C# compiler');
  const exe = path.join(TMP, 'a11y-test.exe');
  const build = spawnSync(csc, ['/nologo', '/target:exe', '/platform:anycpu', '/langversion:5', '/codepage:65001', `/out:${exe}`,
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll',
    path.join(HERE, 'windows-a11y-test.cs'), path.join(ROOT, 'windows', 'src', 'Theme.cs'), path.join(ROOT, 'windows', 'src', 'Util.cs')],
  { encoding: 'utf8', windowsHide: true });
  if (build.status !== 0) throw new Error('Build failed:\n' + build.stdout + build.stderr);
  const run = spawnSync(exe, [], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  process.stdout.write(run.stdout || '');
  process.stderr.write(run.stderr || '');
  code = run.status === 0 ? 0 : 1;
} catch (e) {
  console.error(e.message);
} finally {
  if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true });
}
process.exit(code);
