#!/usr/bin/env node
// Beam for Linux (1.22): the command-line client, cli/beam.js, made into the app that dist/ offers. The public half of
// the update key goes into it (UPDATE_KEY), and it's signed like Beam.exe (windows/update-key.mjs, "beam-linux-update"):
// dist/beam-linux.js + dist/beam-linux.js.json { version, sha256, size, sig }. Every Beam for Linux installs only an
// update signed with the key it carries; the server offers the build to them (GET /api/updates `linux`) and to new
// computers (GET /install/linux).
//
//   node linux/build.mjs [--out <folder>]      (default: BEAM_DIST, else the project's dist/)
//
// The key is the one Beam.exe is signed with (BEAM_UPDATE_KEY, else ~/.beam/windows-update-key.pem).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const OUT = path.resolve(outArg > 0 ? process.argv[outArg + 1] : process.env.BEAM_DIST || path.join(ROOT, 'dist'));
const KEY_TOOL = path.join(ROOT, 'windows', 'update-key.mjs');

try {
  const source = fs.readFileSync(path.join(ROOT, 'cli', 'beam.js'), 'utf8').replace(/\r\n/g, '\n');
  const version = /^const VERSION = '(\d+\.\d+\.\d+)';/m.exec(source)?.[1];
  if (!version) throw new Error('cli/beam.js has no `const VERSION = \'x.y.z\';`');
  if (!/^const UPDATE_KEY = '';/m.test(source)) throw new Error('cli/beam.js has no `const UPDATE_KEY = \'\';` to fill in');
  const key = execFileSync(process.execPath, [KEY_TOOL, 'public'], { encoding: 'utf8' }).trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(key)) throw new Error('update-key.mjs gave no public key');
  const app = source.replace(/^const UPDATE_KEY = '';/m, `const UPDATE_KEY = '${key}';`);
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'beam-linux.js');
  // The app first, its sidecar after (the server offers a build only with both), each by a rename.
  fs.writeFileSync(`${file}.tmp`, app);
  execFileSync(process.execPath, [KEY_TOOL, 'sign', `${file}.tmp`, version, `${file}.json.tmp`, 'linux'], { stdio: 'inherit' });
  fs.renameSync(`${file}.tmp`, file);
  fs.renameSync(`${file}.json.tmp`, `${file}.json`);
  console.log(`Beam for Linux ${version} → ${file} (signed)`);
} catch (err) {
  console.error(`linux/build: ${err.message}`);
  process.exit(1);
}
