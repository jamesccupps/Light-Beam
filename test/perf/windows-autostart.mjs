#!/usr/bin/env node
// Beam for Windows 1.12.7: "Start with Windows" follows the user's choice, kept in the config. An entry that went
// missing is put back at the next start; one the user turned off stays off; an install from before 1.12.7 learns its
// choice from the entry it has. Exits 1 if a check fails.
//
//   node test/perf/windows-autostart.mjs [--exe <Beam.exe>] [--keep]
//
// Isolated: a copy of Beam.exe with --config in a temp folder, so its startup entry is the marker file autostart.txt
// there (never the real Run key); no server (an unpaired instance whose discovery only sees 127.0.0.1:8806, where
// nothing listens); quiet and off-screen.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const exeArg = args.indexOf('--exe');
const EXE = exeArg >= 0 ? args[exeArg + 1] : [path.join(ROOT, 'windows', 'bin', 'Beam.exe'), path.join(ROOT, 'dist', 'Beam.exe')].find(f => fs.existsSync(f));
const KEEP = args.includes('--keep');
const TMP = path.join(os.tmpdir(), `beam-autostart-win-${Date.now()}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures.push(what); };

const dir = p => path.join(TMP, p);
for (const d of ['cfg', 'app']) fs.mkdirSync(dir(d), { recursive: true });
const cfgPath = dir('cfg/config.json'), logPath = dir('cfg/beam.log'), marker = dir('cfg/autostart.txt'), appExe = dir('app/Beam.exe');
const NOWHERE = 'http://127.0.0.1:8806';
const env = { ...process.env, BEAM_LOCAL_URLS: NOWHERE, BEAM_TEST_PEERS: NOWHERE };
const logText = () => { try { return fs.readFileSync(logPath, 'utf8'); } catch { return ''; } };
const config = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
function writeConfig(extra = {}) {
  fs.writeFileSync(cfgPath, JSON.stringify({ quiet: true, testOffscreen: true, autoUpdate: false, autostartInitialized: true,
    sendToMenu: false, outbox: false, autoCopy: false, autoSave: false, ...extra }, null, 2));
}

// One start: wait for the tray (the startup entry is looked at before it), then --quit. -> what it logged.
async function run(label) {
  const from = logText().length;
  const app = spawn(appExe, ['--config', cfgPath, '--background'], { env, windowsHide: true, stdio: 'ignore' });
  let exited = false;
  app.on('exit', () => { exited = true; });
  const until = Date.now() + 30000;
  while (Date.now() < until && !/Perf: tray ready/.test(logText().slice(from))) await sleep(100);
  const up = /Perf: tray ready/.test(logText().slice(from));
  spawnSync(appExe, ['--config', cfgPath, '--quit'], { env, windowsHide: true, timeout: 20000 });
  for (let i = 0; i < 150 && !exited; i++) await sleep(100);
  if (!exited) { try { app.kill(); } catch {} }
  if (!up) throw new Error(`${label}: the tray never came up`);
  return logText().slice(from);
}

try {
  if (!EXE) throw new Error('no Beam.exe: build it first (windows\\build.cmd)');
  fs.copyFileSync(EXE, appExe);
  console.log(`Beam.exe: ${EXE}`);

  // 1. Installed before 1.12.7, its entry there: the choice is learned as on.
  writeConfig();
  fs.writeFileSync(marker, `"${appExe}" --background --config "${cfgPath}"`);
  await run('learned on');
  check(config().autostartWanted === true, 'an install from before 1.12.7 with its entry: the choice is learned as on');
  check(fs.existsSync(marker), '...and the entry stays');

  // 2. The entry went missing (as on Desktop: written into another app's private registry): put back.
  fs.rmSync(marker);
  let log = await run('put back');
  check(/Start with Windows was missing; put it back/.test(log), 'a missing entry is put back at the next start (logged)');
  check(fs.existsSync(marker) && /--background/.test(fs.readFileSync(marker, 'utf8')), '...with --background');

  // 3. Turned off by the user: stays off.
  writeConfig({ autostartWanted: false });
  fs.rmSync(marker, { force: true });
  log = await run('stays off');
  check(!fs.existsSync(marker), 'turned off by the user: not put back');
  check(!/put it back/.test(log), '...and nothing logged about it');

  // 4. Installed before 1.12.7 without an entry (turned off then): learned as off.
  writeConfig();
  await run('learned off');
  check(config().autostartWanted === false, 'an install from before 1.12.7 without its entry: learned as off');
  check(!fs.existsSync(marker), '...and nothing written');
} catch (err) {
  failures.push(err.message);
  console.log(`FAIL  ${err.message}`);
} finally {
  if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true });
  else console.log(`kept: ${TMP}`);
}
console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
process.exit(failures.length ? 1 : 0);
