#!/usr/bin/env node
// The whole Android suite, with its integration tests (audit T-1): without scratch servers ~50 of them skip themselves
// and the run still looks green. This starts two scratch Beam servers (127.0.0.1:8811 and 8812, this checkout's
// server.js, temporary data folders), runs `gradlew testDebugUnitTest --rerun lintDebug assembleRelease` with the
// integration environment set, then reads the test reports and FAILS if any test skipped other than the slow
// performance measurements (they need BEAM_PERF=1 and a netsim proxy, and say so).
//
//   node scripts/dev/android-full.mjs [gradle tasks…]
//
// Never touches a live server: only its own scratch ports (8811–8819) and folders. JAVA_HOME defaults to Android
// Studio's bundled JDK.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ANDROID = path.join(ROOT, 'android');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-android-full-'));
const tasks = process.argv.slice(2).length ? process.argv.slice(2) : ['testDebugUnitTest', '--rerun', 'lintDebug', 'assembleRelease'];
// Skips that are fine: opt-in measurements (their assumption names BEAM_PERF).
const OPTIONAL = /BEAM_PERF/;

function startServer(port, name) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  const env = { ...process.env, BEAM_TAILSCALE: 'off', BEAM_HOST: '127.0.0.1', BEAM_PORT: String(port),
    BEAM_DATA: path.join(dir, 'data'), BEAM_DIST: path.join(dir, 'dist') };
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: 'ignore', windowsHide: true });
  return { child, dir, port };
}

async function waitUp(port) {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/hello`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`the scratch server on ${port} didn't start`);
}

// Every <testcase> of the run's reports that skipped, with its message (the assumption's text, when there is one).
function skippedTests() {
  const dir = path.join(ANDROID, 'app', 'build', 'test-results', 'testDebugUnitTest');
  const out = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.xml')) : []) {
    const xml = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of xml.matchAll(/<testcase name="([^"]*)" classname="([^"]*)"[^>]*>\s*<skipped(?: message="([^"]*)")?/g)) {
      out.push({ test: `${m[2].replace(/^app\.beam\.android\./, '')}.${m[1]}`, why: (m[3] || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&') });
    }
  }
  return out;
}

// (no old reports: a run that stops before the tests mustn't read the last one's)
fs.rmSync(path.join(ANDROID, 'app', 'build', 'test-results', 'testDebugUnitTest'), { recursive: true, force: true });
const a = startServer(8811, 'a');
const b = startServer(8812, 'b');
let code = 1;
try {
  await waitUp(8811);
  await waitUp(8812);
  const env = {
    ...process.env,
    JAVA_HOME: process.env.JAVA_HOME || 'C:\\Program Files\\Android\\Android Studio\\jbr',
    BEAM_TEST_URL: 'http://127.0.0.1:8811', BEAM_TEST_KEY: fs.readFileSync(path.join(a.dir, 'data', 'key'), 'utf8').trim(),
    BEAM_SHOTS_URL: 'http://127.0.0.1:8812', BEAM_SHOTS_KEY: fs.readFileSync(path.join(b.dir, 'data', 'key'), 'utf8').trim(),
    BEAM_TEST_DIST: path.join(a.dir, 'dist'), BEAM_SHOTS_DIST: path.join(b.dir, 'dist'),
    BEAM_SERVER_JS: path.join(ROOT, 'server.js'), BEAM_TEST_PORTS: '8813-8819',
  };
  const gradlew = process.platform === 'win32' ? ['cmd.exe', ['/c', path.join(ANDROID, 'gradlew.bat')]] : [path.join(ANDROID, 'gradlew'), []];
  const r = spawnSync(gradlew[0], [...gradlew[1], '--no-daemon', ...tasks], { cwd: ANDROID, env, stdio: 'inherit' });
  code = r.status ?? 1;
  if (tasks.includes('testDebugUnitTest')) {
    const skipped = skippedTests();
    const unexpected = skipped.filter(s => !OPTIONAL.test(s.why));
    console.log(`\n${skipped.length} test(s) skipped: ${skipped.length - unexpected.length} opt-in measurement(s), ${unexpected.length} other.`);
    for (const s of unexpected) console.log(`  SKIPPED ${s.test}${s.why ? `: ${s.why}` : ''}`);
    if (unexpected.length) {
      console.log('FAILED: tests skipped that should have run against the scratch servers.');
      code ||= 1;
    }
  }
} finally {
  a.child.kill();
  b.child.kill();
  await new Promise(r => setTimeout(r, 500));
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(`EXIT ${code}`);
process.exit(code);
