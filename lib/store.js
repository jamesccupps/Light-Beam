'use strict';
// Durable JSON state files. A write goes to <file>.tmp and is fsynced; the current file is kept as <file>.bak (a
// hard link, so <file> never goes missing; a rename where links aren't supported) and the new one replaces it.
// After a crash or power cut one of <file>, <file>.tmp or <file>.bak is intact, and loadState() picks it up.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';

// Counters for GET /api/metrics: durable writes, their bytes and fsyncs, and the time they took, per file.
const stats = { writes: 0, bytes: 0, fsyncs: 0, ms: 0, files: {} };
const statName = file => path.basename(file).replace(/^[a-f0-9]{16}/, '<id>');

function counted(file, bytes, started) {
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  stats.writes++;
  stats.bytes += bytes;
  stats.fsyncs += IS_WIN ? 1 : 2; // the file, and (not on Windows) its folder
  stats.ms += ms;
  const f = (stats.files[statName(file)] ||= { writes: 0, bytes: 0, ms: 0 });
  f.writes++;
  f.bytes += bytes;
  f.ms += ms;
}

function storeStats() {
  const round = v => Math.round(v * 10) / 10;
  return { writes: stats.writes, bytes: stats.bytes, fsyncs: stats.fsyncs, ms: round(stats.ms), files: Object.fromEntries(Object.entries(stats.files).map(([k, v]) => [k, { ...v, ms: round(v.ms) }])) };
}

// Makes a rename durable. Windows can't open directories for this (and NTFS journals renames anyway).
async function syncDir(dir) {
  if (IS_WIN) return;
  let fh;
  try {
    fh = await fsp.open(dir, 'r');
    await fh.sync();
  } catch {} finally {
    await fh?.close().catch(() => {});
  }
}

function syncDirSync(dir) {
  if (IS_WIN) return;
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {} finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// `data` is a string, a Buffer, or an async iterable of them (written piece by piece, so a big file never has to be
// one string in memory, and the event loop gets a turn between pieces).
async function writeFileDurable(file, data, { mode = 0o600, backup = false } = {}) {
  const started = process.hrtime.bigint();
  const parts = typeof data?.[Symbol.asyncIterator] === 'function' ? data : [data];
  const tmp = `${file}.tmp`;
  const fh = await fsp.open(tmp, 'w', mode);
  let bytes = 0;
  try {
    for await (const part of parts) {
      const buf = typeof part === 'string' ? Buffer.from(part) : part;
      await fh.writeFile(buf);
      bytes += buf.length;
    }
    await fh.sync();
  } finally {
    await fh.close();
  }
  if (backup) await keepBackup(file);
  await fsp.rename(tmp, file);
  await syncDir(path.dirname(file));
  counted(file, bytes, started);
}

async function keepBackup(file) {
  const bak = `${file}.bak`;
  await fsp.rm(bak, { force: true });
  try {
    await fsp.link(file, bak);
  } catch (err) {
    if (err.code === 'ENOENT') return; // the first write
    try { await fsp.rename(file, bak); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

function keepBackupSync(file) {
  const bak = `${file}.bak`;
  fs.rmSync(bak, { force: true });
  try {
    fs.linkSync(file, bak);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    try { fs.renameSync(file, bak); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

function writeFileDurableSync(file, data, { mode = 0o600, backup = false } = {}) {
  const started = process.hrtime.bigint();
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeFileSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (backup) keepBackupSync(file);
  fs.renameSync(tmp, file);
  syncDirSync(path.dirname(file));
  counted(file, buf.length, started);
}

// Reads a JSON state file, falling back to <file>.tmp (a write that didn't get its final rename) and then to
// <file>.bak (the previous version). An unreadable or wrong-type file is kept as <file>.broken-<time>.
// Returns { value, source }; source is 'file', 'tmp', 'bak', 'new' (no file yet) or 'lost' (nothing usable).
function loadState(file, { fallback, validate, log }) {
  const name = path.basename(file);
  const shapeOk = v => v !== null && typeof v === 'object' && Array.isArray(v) === Array.isArray(fallback);
  let problem = null;
  for (const [source, candidate] of [['file', file], ['tmp', `${file}.tmp`], ['bak', `${file}.bak`]]) {
    let text;
    try {
      text = fs.readFileSync(candidate, 'utf8');
    } catch (err) {
      if (source === 'file') problem = err.code === 'ENOENT' ? 'missing' : err.message;
      continue;
    }
    let value;
    try {
      value = JSON.parse(text);
      if (!shapeOk(value)) throw new Error(`it holds ${value === null ? 'null' : typeof value} instead of ${Array.isArray(fallback) ? 'a list' : 'an object'}`);
    } catch (err) {
      if (source === 'file') {
        problem = err.message;
        const broken = `${file}.broken-${Date.now()}`;
        try {
          fs.renameSync(file, broken);
          log.error(`${name} is unreadable (${err.message}); kept it as ${path.basename(broken)}`);
        } catch {}
      }
      continue;
    }
    if (source !== 'file') log.warn(`${name} was ${problem === 'missing' ? 'missing' : `unreadable (${problem})`}; recovered it from ${path.basename(candidate)}`);
    return { value: validate ? validate(value) : value, source };
  }
  if (problem && problem !== 'missing') log.error(`${name} could not be recovered from a .tmp or .bak copy; starting with an empty one`);
  return { value: structuredClone(fallback), source: problem && problem !== 'missing' ? 'lost' : 'new' };
}

// Serialized, coalesced writes: many changes in a row produce one write. With `delay`, a change waits that long for
// others to join it (flush() writes at once). A failed write stays pending and is retried with backoff (antivirus or
// backup tools can briefly lock files on Windows). `serialize` replaces JSON.stringify(getValue()); it may return
// an async iterable of pieces (see writeFileDurable).
function jsonWriter(file, getValue, { log, backup = true, delay = 0, serialize = null } = {}) {
  const name = path.basename(file);
  let dirty = false;
  let running = null;
  let timer = null;
  let failures = 0;
  let lastError = '';
  // Every change bumps `changes`; a write remembers how many it covers (`saved` once it's done). flush() waits for
  // the first write that covers the changes made before it was called, not for the writer to go idle: under a burst
  // of other changes that could take seconds.
  let changes = 0;
  let saved = 0;
  let waiters = []; // { upTo, wake }

  function release() {
    const done = waiters.filter(w => w.upTo <= saved);
    waiters = waiters.filter(w => w.upTo > saved);
    done.forEach(w => w.wake());
  }

  function start() {
    clearTimeout(timer);
    timer = null;
    if (!running) running = loop();
  }

  async function loop() {
    while (dirty) {
      dirty = false;
      const covers = changes; // the snapshot below includes every change made so far
      try {
        await writeFileDurable(file, serialize ? serialize() : JSON.stringify(getValue()), { backup });
        saved = covers;
        release();
        if (failures) log.info(`Saved ${name} after ${failures} failed attempt${failures > 1 ? 's' : ''}`);
        failures = 0;
        lastError = '';
      } catch (err) {
        dirty = true;
        failures++;
        if (failures === 1 || err.message !== lastError || failures % 20 === 0) log.error(`Couldn't save ${name} (attempt ${failures}, will retry): ${err.message}`);
        lastError = err.message;
        await new Promise(r => setTimeout(r, Math.min(30_000, 250 * 2 ** Math.min(failures, 7))));
      }
    }
    running = null;
    release();
  }

  function write() {
    changes++;
    dirty = true;
    if (running || timer) return; // a write in progress picks the change up when it's done
    if (delay > 0) timer = setTimeout(start, delay);
    else start();
  }
  write.flush = () => {
    if (timer) start();
    if (saved >= changes) return Promise.resolve();
    return new Promise(wake => waiters.push({ upTo: changes, wake }));
  };
  write.failing = () => failures > 0;
  write.file = file;
  return write;
}

module.exports = { writeFileDurable, writeFileDurableSync, loadState, jsonWriter, syncDir, storeStats };
