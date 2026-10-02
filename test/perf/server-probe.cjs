'use strict';
// Loaded into a scratch server by test/perf/server-bench.mjs (node --require): counts what the server writes to disk
// (bytes, fsyncs, renames, per file), its synchronous fs calls, event-loop delay, timer wakeups and CPU, and answers
// over the IPC channel. It only observes; every call goes through unchanged.
//
// BEAM_PROBE_TIMERS=1 counts timer wakeups instead of sampling event-loop delay (the sampler itself wakes the
// process every 10 ms, which would swamp an idle measurement; async hooks slow promises, so they are off otherwise).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const asyncHooks = require('node:async_hooks');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const COUNT_TIMERS = process.env.BEAM_PROBE_TIMERS === '1';

let stats;
function reset() {
  stats = { writes: 0, bytes: 0, fsyncs: 0, renames: 0, links: 0, files: {}, sync: {}, timers: 0, immediates: 0, wakeups: 0 };
}
reset();

const fdNames = new Map(); // fd -> file name (for the per-file totals)
const nameOf = file => {
  const base = path.basename(String(file));
  return base.replace(/\.tmp$/, '').replace(/^[a-f0-9]{16}(\.txt|\.part|\.json)?$/, (m, ext) => `<id>${ext || ''}`);
};
const sizeOf = (data, length) => (Number.isInteger(length) ? length : typeof data === 'string' ? Buffer.byteLength(data) : data?.byteLength ?? 0);

let nested = 0; // inside a counted call that makes further fs calls itself (appendFileSync -> writeFileSync)

function wrote(name, bytes) {
  if (nested) return;
  stats.writes++;
  stats.bytes += bytes;
  const f = (stats.files[name] ||= { writes: 0, bytes: 0, fsyncs: 0 });
  f.writes++;
  f.bytes += bytes;
}
function synced(name) {
  if (nested) return;
  stats.fsyncs++;
  (stats.files[name] ||= { writes: 0, bytes: 0, fsyncs: 0 }).fsyncs++;
}

function wrap(obj, name, before, after) {
  const original = obj[name];
  if (typeof original !== 'function') return;
  obj[name] = function (...args) {
    const outer = !nested;
    if (outer) before?.(args);
    nested++;
    try {
      const result = original.apply(this, args);
      return after ? after(result, args) : result;
    } finally {
      nested--;
    }
  };
}

const syncCall = name => () => { stats.sync[name] = (stats.sync[name] || 0) + 1; };
const remember = (result, args) => { if (Number.isInteger(result)) fdNames.set(result, nameOf(args[0])); return result; };

wrap(fs, 'openSync', syncCall('openSync'), remember);
wrap(fs, 'open', args => {
  const cb = args[args.length - 1];
  if (typeof cb === 'function') args[args.length - 1] = (err, fd) => { if (!err) fdNames.set(fd, nameOf(args[0])); cb(err, fd); };
});
wrap(fs, 'writeSync', args => { syncCall('writeSync')(); wrote(fdNames.get(args[0]) || '?', sizeOf(args[1], typeof args[1] === 'string' ? undefined : args[3])); });
wrap(fs, 'write', args => wrote(fdNames.get(args[0]) || '?', sizeOf(args[1], typeof args[1] === 'string' || typeof args[3] !== 'number' ? undefined : args[3])));
wrap(fs, 'writev', args => wrote(fdNames.get(args[0]) || '?', args[1].reduce((n, b) => n + b.byteLength, 0)));
wrap(fs, 'writeFileSync', args => { syncCall('writeFileSync')(); wrote(typeof args[0] === 'number' ? fdNames.get(args[0]) || '?' : nameOf(args[0]), sizeOf(args[1])); });
wrap(fs, 'appendFileSync', args => { syncCall('appendFileSync')(); wrote(nameOf(args[0]), sizeOf(args[1])); });
wrap(fs, 'writeFile', args => wrote(nameOf(args[0]), sizeOf(args[1])));
wrap(fs, 'appendFile', args => wrote(nameOf(args[0]), sizeOf(args[1])));
for (const name of ['fsync', 'fdatasync']) wrap(fs, name, args => synced(fdNames.get(args[0]) || '?'));
for (const name of ['fsyncSync', 'fdatasyncSync']) wrap(fs, name, args => { syncCall(name)(); synced(fdNames.get(args[0]) || '?'); });
wrap(fs, 'rename', () => { stats.renames++; });
wrap(fs, 'renameSync', () => { syncCall('renameSync')(); stats.renames++; });
wrap(fs, 'link', () => { stats.links++; });
wrap(fs, 'linkSync', () => { syncCall('linkSync')(); stats.links++; });
// The remaining synchronous calls only block: count them by name.
for (const name of Object.keys(fs)) {
  if (name.endsWith('Sync') && typeof fs[name] === 'function' && !['openSync', 'writeSync', 'writeFileSync', 'appendFileSync', 'fsyncSync', 'fdatasyncSync', 'renameSync', 'linkSync'].includes(name)) wrap(fs, name, syncCall(name));
}
wrap(fs, 'closeSync', args => fdNames.delete(args[0]));
wrap(fsp, 'writeFile', args => wrote(nameOf(args[0]), sizeOf(args[1])));
wrap(fsp, 'appendFile', args => wrote(nameOf(args[0]), sizeOf(args[1])));
wrap(fsp, 'rename', () => { stats.renames++; });
wrap(fsp, 'link', () => { stats.links++; });

const openHandle = fsp.open;
fsp.open = async function (file, ...rest) {
  const fh = await openHandle.call(this, file, ...rest);
  const name = nameOf(file);
  for (const method of ['write', 'writeFile', 'appendFile']) {
    const original = fh[method];
    fh[method] = function (data, ...more) { wrote(name, sizeOf(data, method === 'write' && typeof data !== 'string' && typeof more[1] === 'number' ? more[1] : undefined)); return original.call(this, data, ...more); };
  }
  for (const method of ['sync', 'datasync']) {
    const original = fh[method];
    fh[method] = function () { synced(name); return original.call(this); };
  }
  return fh;
};

const loop = monitorEventLoopDelay({ resolution: 10 });
if (!COUNT_TIMERS) loop.enable();

if (COUNT_TIMERS) {
  // Timer callbacks, and wakeups: callbacks less than 2 ms apart ran in the same turn of the event loop.
  const kinds = new Map();
  let last = 0n;
  asyncHooks.createHook({
    init(id, type) { if (type === 'Timeout' || type === 'Immediate') kinds.set(id, type); },
    before(id) {
      const type = kinds.get(id);
      if (!type) return;
      if (type === 'Timeout') stats.timers++;
      else stats.immediates++;
      const t = process.hrtime.bigint();
      if (t - last > 2_000_000n) stats.wakeups++;
      last = t;
    },
    destroy(id) { kinds.delete(id); },
  }).enable();
}

const ms = ns => Math.round(ns / 1e4) / 100;

process.on('message', msg => {
  if (!msg || typeof msg.probe !== 'string' || !process.send) return;
  let data = null;
  if (msg.probe === 'reset') {
    reset();
    loop.reset();
  } else if (msg.probe === 'stats') {
    data = { ...stats, cpu: process.cpuUsage(), mem: process.memoryUsage(), loop: COUNT_TIMERS ? null : { p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), max: ms(loop.max), mean: ms(loop.mean) } };
  } else if (msg.probe === 'gc') {
    if (global.gc) { global.gc(); global.gc(); }
    data = process.memoryUsage();
  }
  process.send({ probe: msg.probe, id: msg.id, data });
});
