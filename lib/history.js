'use strict';
// Each PC's history (Beam 1.18; the user: "we should do the history for each pc"). Windows' own records of restarts and
// shutdowns (and who asked), power losses, blue screens and sign-ins, plus Beam's own crashes, as a PC's Beam app reads
// them from its System and Application logs (this server's own PC: the server itself, at start); and the spells Beam
// saw a device offline. This module keeps the records tidy and explains them; server.js stores them per device in
// data/history.json and serves them (GET /api/devices/{id}/history). Pure functions: test/server.test.js checks them.

const DAY = 86400e3;
const KEEP_MS = 120 * DAY;       // records kept this long
const MAX_EVENTS = 800;          // per device (a PC makes a few a day)
const MAX_SPELLS = 300;          // offline spells per device
const MAX_REPORT = 600;          // records in one report
const SPELL_MIN_MS = 10 * 60e3;  // shorter spells offline aren't worth a line
const ALERT_WITHIN_MS = DAY;     // a power loss or crash older than this when Beam learns of it isn't alerted
const MERGE_UPDATES_MS = 20 * 60e3; // restarts for one Windows update, one after another, make one line

// What a PC sends: Windows' records of these kinds (provider and event ids per log), nothing else.
const WANTED = {
  System: {
    'User32': [1074],                                       // a restart or shutdown asked for: who and why
    'Microsoft-Windows-Kernel-Power': [41],                 // started again without a clean shutdown
    'EventLog': [6008],                                     // ...and Windows' estimate of when it went down
    'Microsoft-Windows-Kernel-General': [12, 13],           // Windows started; Windows shut down cleanly
    'Microsoft-Windows-WER-SystemErrorReporting': [1001],   // a blue screen's stop code
    'Microsoft-Windows-Winlogon': [7001],                   // someone signed in
  },
  Application: {
    'Application Error': [1000],                            // Beam.exe crashed (the app sends only its own)
    '.NET Runtime': [1026],                                 // ...with the .NET exception
    'Application Hang': [1002],                             // Beam.exe stopped responding and was closed
  },
};

const wanted = (log, provider, id) => Boolean(WANTED[log]?.[provider]?.includes(id));

// A record as a PC sends it: { log, id, provider, time (ISO), rec (the record number), data: [the record's values as
// text; byte arrays as "hex:…"] }. Returns the kept form ({ …, time: ms }) or null.
function normalizeEvent(raw, at = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { log, provider } = raw;
  const id = Number(raw.id);
  if (typeof log !== 'string' || typeof provider !== 'string' || !Number.isInteger(id) || !wanted(log, provider, id)) return null;
  const time = typeof raw.time === 'string' ? Date.parse(raw.time) : Number(raw.time);
  if (!Number.isFinite(time) || time < at - KEEP_MS || time > at + DAY) return null;
  const rec = Number.isSafeInteger(Number(raw.rec)) && Number(raw.rec) >= 0 ? Number(raw.rec) : null;
  const data = Array.isArray(raw.data) ? raw.data.slice(0, 24).map((v, i) => {
    const s = v === null || v === undefined ? '' : String(v);
    return s.slice(0, provider === '.NET Runtime' && i === 0 ? 2000 : 300);
  }) : [];
  return { log, id, provider, time, rec, data };
}

const keyOf = e => `${e.log}/${e.rec ?? ''}/${e.time}/${e.id}`;

// Adds a report's records to a device's kept ones: duplicates (a record sent twice, by the app and by this server for
// its own PC) once; older than 120 days gone; the newest 800. { events, added }.
function mergeEvents(kept, incoming, at = Date.now()) {
  const byKey = new Map();
  for (const e of kept || []) if (e && Number.isFinite(e.time) && e.time >= at - KEEP_MS) byKey.set(keyOf(e), e);
  let added = 0;
  for (const raw of incoming || []) {
    const e = raw && Number.isFinite(raw.time) && typeof raw.log === 'string' && Array.isArray(raw.data) ? raw : normalizeEvent(raw, at);
    if (!e || e.time < at - KEEP_MS) continue;
    const k = keyOf(e);
    if (byKey.has(k)) continue;
    byKey.set(k, e);
    added++;
  }
  const events = [...byKey.values()].sort((a, b) => a.time - b.time).slice(-MAX_EVENTS);
  return { events, added };
}

// Where a PC's next report should start: the newest record kept per log (ISO), or null for "from 30 days ago".
function sinceOf(events) {
  const out = { System: null, Application: null };
  for (const e of events || []) if (e.log in out && (!out[e.log] || e.time > Date.parse(out[e.log]))) out[e.log] = new Date(e.time).toISOString();
  return out;
}

// A spell offline, as Beam saw it (from, until: ms): kept when it lasted 10 minutes or more.
function addSpell(spells, from, until, at = Date.now()) {
  const list = (spells || []).filter(s => s.until >= at - KEEP_MS);
  if (Number.isFinite(from) && Number.isFinite(until) && until - from >= SPELL_MIN_MS) list.push({ from, until });
  return list.sort((a, b) => a.from - b.from).slice(-MAX_SPELLS);
}

// ---------------------------------------------------------------- explaining them

const exeOf = text => {
  const path = String(text || '').replace(/\s*\([^()]*\)\s*$/, ''); // "C:\…\x.exe (PC-NAME)"
  return path.split(/[\\/]/).pop().toLowerCase();
};

// Who asked for a restart or shutdown (Event 1074), from the program that asked and Windows' reason.
function requestedBy(e) {
  const exe = exeOf(e.data[0]);
  const reason = e.data[2] || '';
  const comment = (e.data[5] || '').replace(/^Reason:\s*/i, '').replace(/\.$/, '').trim();
  const base = { exe, comment };
  if (/^(monotificationux|mousocoreworker|trustedinstaller|usoclient|wuauclt|musnotification|musnotificationux|tiworker|sihclient)\.exe$/.test(exe)) return { ...base, by: 'update', phrase: 'for a Windows update' };
  if (exe === 'svchost.exe' && /operating system: (upgrade|service pack|hot ?fix|security fix)/i.test(reason)) return { ...base, by: 'update', phrase: 'for a Windows update' };
  if (exe === 'ekrn.exe' || exe === 'egui.exe') return { ...base, by: 'antivirus', phrase: 'by ESET' };
  if (exe === 'msmpeng.exe') return { ...base, by: 'antivirus', phrase: 'by Microsoft Defender' };
  if (/^(startmenuexperiencehost|explorer|shellexperiencehost|shellhost)\.exe$/.test(exe)) return { ...base, by: 'you', phrase: 'from the Start menu' };
  if (exe === 'logonui.exe') return { ...base, by: 'you', phrase: 'from the sign-in screen' };
  if (exe === 'winlogon.exe') return { ...base, by: 'you', phrase: 'from the lock or sign-in screen' };
  if (exe === 'shutdown.exe') return { ...base, by: 'program', phrase: 'by the shutdown command' };
  if (exe === 'beam.exe') return { ...base, by: 'program', phrase: 'by Beam' };
  const name = exe.replace(/\.exe$/, '');
  return { ...base, by: 'program', phrase: name ? `by ${name}` : '' };
}

const isRestart = e => /restart/i.test(e.data[4] || '');

// Blue screens: the stop codes people meet most, by name.
const STOP_NAMES = {
  0x0a: 'IRQL_NOT_LESS_OR_EQUAL', 0x1a: 'MEMORY_MANAGEMENT', 0x1e: 'KMODE_EXCEPTION_NOT_HANDLED', 0x3b: 'SYSTEM_SERVICE_EXCEPTION',
  0x50: 'PAGE_FAULT_IN_NONPAGED_AREA', 0x7e: 'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED', 0x7f: 'UNEXPECTED_KERNEL_MODE_TRAP',
  0x9f: 'DRIVER_POWER_STATE_FAILURE', 0xc2: 'BAD_POOL_CALLER', 0xd1: 'DRIVER_IRQL_NOT_LESS_OR_EQUAL',
  0xef: 'CRITICAL_PROCESS_DIED', 0x101: 'CLOCK_WATCHDOG_TIMEOUT', 0x116: 'VIDEO_TDR_FAILURE', 0x119: 'VIDEO_SCHEDULER_INTERNAL_ERROR',
  0x124: 'WHEA_UNCORRECTABLE_ERROR', 0x133: 'DPC_WATCHDOG_VIOLATION', 0x139: 'KERNEL_SECURITY_CHECK_FAILURE', 0x13a: 'KERNEL_MODE_HEAP_CORRUPTION',
  0x154: 'UNEXPECTED_STORE_EXCEPTION', 0x1a8: 'BUGCODE_ID_DRIVER',
};

function stopCodeText(code) {
  if (!Number.isFinite(code) || code <= 0) return '';
  const hex = `0x${code.toString(16).toUpperCase().padStart(8, '0')}`;
  return STOP_NAMES[code] ? `${hex} (${STOP_NAMES[code]})` : hex;
}

// Event 41's BugcheckCode is a number; Event 1001 starts "0x0000009f (0x…, …)".
function stopCodeOf(e) {
  if (!e) return 0;
  if (e.provider === 'Microsoft-Windows-Kernel-Power') return Number(e.data[0]) || 0;
  const m = /0x([0-9a-f]{1,16})/i.exec(e.data.find(d => /0x[0-9a-f]+/i.test(d)) || '');
  return m ? parseInt(m[1], 16) : 0;
}

// Event 6008's binary value holds two SYSTEMTIMEs: when Windows last noted it running, local and UTC (the second).
function lastAliveOf(e) {
  const hex = (e?.data || []).find(d => /^hex:[0-9a-f]+$/i.test(d));
  if (!hex) return null;
  const b = Buffer.from(hex.slice(4), 'hex');
  if (b.length < 32) return null;
  const w = i => b.readUInt16LE(16 + i * 2);
  const t = Date.UTC(w(0), w(1) - 1, w(3), w(4), w(5), w(6), w(7));
  return Number.isFinite(t) && w(0) > 2000 ? t : null;
}

// The first line worth showing from a .NET crash (Event 1026): the exception's type and message.
function exceptionOf(text) {
  const m = /Exception Info:\s*([^\r\n]+)/.exec(text || '');
  return m ? m[1].trim().slice(0, 200) : '';
}

// The history, newest first: { entries, up }. Entries:
//   { at, kind, text, detail?, by?, down?, downEstimate?, up?, signedIn?, count?, until? }
// kind: restart | shutdown | power-loss | crash | forced-off | start (each about one start of Windows: how it went
// down before it, `down` .. `up`, and the first sign-in after) | app-crash | app-hang (Beam itself) | offline (a spell
// Beam saw, `at` .. `until`). `up` (outside entries): { since, kind, text } for the latest start.
function explain(events, spells, { at = Date.now(), days = 30 } = {}) {
  const list = (events || []).slice().sort((a, b) => a.time - b.time);
  const is = (e, provider, id) => e.provider === provider && e.id === id;
  const boots = list.filter(e => is(e, 'Microsoft-Windows-Kernel-General', 12)).map(e => {
    const start = Date.parse(e.data[6]);
    return Number.isFinite(start) && Math.abs(start - e.time) < 10 * 60e3 ? start : e.time;
  });
  const near = (pred, from, to) => list.filter(e => pred(e) && e.time >= from && e.time <= to);
  const entries = [];
  boots.forEach((up, i) => {
    const prev = i > 0 ? boots[i - 1] : -Infinity;
    const next = i + 1 < boots.length ? boots[i + 1] : Infinity;
    const lost = near(e => is(e, 'Microsoft-Windows-Kernel-Power', 41), up - 60e3, Math.min(up + 10 * 60e3, next)).pop();
    const est = near(e => is(e, 'EventLog', 6008), up - 60e3, Math.min(up + 10 * 60e3, next)).pop();
    const blue = near(e => is(e, 'Microsoft-Windows-WER-SystemErrorReporting', 1001), up - 60e3, Math.min(up + 30 * 60e3, next)).pop();
    const ask = near(e => is(e, 'User32', 1074), prev, up).pop();
    const stop = near(e => is(e, 'Microsoft-Windows-Kernel-General', 13), prev, up).pop();
    const signIn = near(e => is(e, 'Microsoft-Windows-Winlogon', 7001), up, next).shift();
    const entry = { at: up, up, ...(signIn && { signedIn: signIn.time }) };
    if (lost) {
      const code = stopCodeOf(blue) || stopCodeOf(lost);
      const pressed = (lost.data[6] || '0') !== '0';
      const alive = lastAliveOf(est);
      if (alive && alive < up) Object.assign(entry, { at: alive, down: alive, downEstimate: true });
      if (code) Object.assign(entry, { kind: 'crash', text: 'Crashed with a blue screen', detail: `Stop code ${stopCodeText(code)}` });
      else if (pressed) Object.assign(entry, { kind: 'forced-off', text: 'Forced off with the power button' });
      else Object.assign(entry, { kind: 'power-loss', text: 'Lost power or froze (no warning)' });
      if (ask && (!stop || ask.time > stop.time)) {
        const r = requestedBy(ask);
        entry.detail = [entry.detail, `It was ${isRestart(ask) ? 'restarting' : 'shutting down'}${r.phrase ? ` ${r.phrase}` : ''} at the time`].filter(Boolean).join('. ');
      }
    } else if (ask) {
      const r = requestedBy(ask);
      const restart = isRestart(ask);
      Object.assign(entry, { at: ask.time, down: stop ? stop.time : ask.time, kind: restart ? 'restart' : 'shutdown', by: r.by,
        text: `${restart ? 'Restarted' : 'Shut down'}${r.phrase ? ` ${r.phrase}` : ''}` });
      if (r.comment && r.by !== 'update' && r.by !== 'you') entry.detail = r.comment.charAt(0).toUpperCase() + r.comment.slice(1);
    } else if (stop) {
      const restart = up - stop.time < 3 * 60e3;
      Object.assign(entry, { at: stop.time, down: stop.time, kind: restart ? 'restart' : 'shutdown', by: 'unknown',
        text: restart ? 'Restarted' : 'Shut down', detail: 'Windows didn’t record who asked' });
    } else {
      Object.assign(entry, { kind: 'start', text: 'Started' });
    }
    entries.push(entry);
  });

  // Windows Update often restarts a PC several times in a row: one line for them.
  const merged = [];
  for (const e of entries) {
    const last = merged[merged.length - 1];
    if (last && last.kind === 'restart' && last.by === 'update' && e.kind === 'restart' && e.by === 'update' && e.down - last.up <= MERGE_UPDATES_MS) {
      last.count = (last.count || 1) + 1;
      last.up = e.up;
      last.text = `Restarted ${last.count} times for a Windows update`;
      if (e.signedIn) last.signedIn = e.signedIn; // (the first sign-in after the last start)
      else delete last.signedIn;
      continue;
    }
    merged.push(e);
  }

  // Beam's own crashes and hangs (the app sends only its own Beam.exe's); a .NET crash comes with an Application Error.
  const appErrors = list.filter(e => is(e, 'Application Error', 1000));
  const dotnet = list.filter(e => is(e, '.NET Runtime', 1026));
  for (const e of appErrors) {
    const ex = dotnet.find(d => Math.abs(d.time - e.time) <= 15e3);
    const detail = ex ? exceptionOf(ex.data[0]) : '';
    merged.push({ at: e.time, kind: 'app-crash', text: 'Beam crashed', ...((detail || e.data[6]) && { detail: detail || `Error ${e.data[6]}${e.data[3] ? ` in ${e.data[3]}` : ''}` }) });
  }
  for (const d of dotnet) {
    if (appErrors.some(e => Math.abs(d.time - e.time) <= 15e3)) continue;
    const detail = exceptionOf(d.data[0]);
    merged.push({ at: d.time, kind: 'app-crash', text: 'Beam crashed', ...(detail && { detail }) });
  }
  for (const e of list.filter(x => is(x, 'Application Hang', 1002))) merged.push({ at: e.time, kind: 'app-hang', text: 'Beam stopped responding and was closed' });

  for (const s of spells || []) merged.push({ at: s.from, until: s.until, kind: 'offline', text: 'Beam was offline' });

  const from = at - days * DAY;
  const out = merged.filter(e => e.at >= from || (e.up || 0) >= from).sort((a, b) => b.at - a.at).slice(0, 200);
  const last = entries[entries.length - 1];
  const up = last ? { since: last.up, kind: last.kind, text: last.text } : null;
  return { entries: out, up };
}

// The starts worth an alert: a power loss, a blue screen or a forced power-off, learned within a day of it.
function alertable(entries, alerted, at = Date.now()) {
  const done = new Set(alerted || []);
  return (entries || []).filter(e => ['power-loss', 'crash', 'forced-off'].includes(e.kind) && e.up >= at - ALERT_WITHIN_MS && !done.has(`up:${e.up}`));
}

module.exports = {
  WANTED, MAX_REPORT, SPELL_MIN_MS, KEEP_MS,
  normalizeEvent, mergeEvents, sinceOf, addSpell, explain, alertable,
  requestedBy, stopCodeText, lastAliveOf, exceptionOf,
};
