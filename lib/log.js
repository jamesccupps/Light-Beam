'use strict';
// Timestamped log lines to the console and a size-capped file (server.log, server.log.1 … .N).
// The Windows server runs hidden, so the file is the only place its messages end up.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function createLogger({ file = null, maxBytes = 2 * 1024 * 1024, keep = 3 } = {}) {
  let size = null;
  let fd = null; // kept open: one write per line instead of open + write + close

  function close() {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
    fd = null;
  }

  function rotate() {
    close();
    try {
      for (let i = keep - 1; i >= 1; i--) {
        try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch {}
      }
      fs.renameSync(file, `${file}.1`);
    } catch {}
    size = 0;
  }

  function toFile(line) {
    if (!file) return;
    try {
      if (size === null) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try { size = fs.statSync(file).size; } catch { size = 0; }
      }
      if (size > maxBytes) rotate();
      if (fd === null) fd = fs.openSync(file, 'a');
      fs.writeSync(fd, line + '\n');
      size += Buffer.byteLength(line) + 1;
    } catch {}
  }

  function format(parts) {
    return parts.map(p => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  }

  function write(level, parts) {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${format(parts)}`;
    (level === 'INFO' ? console.log : console.error)(line);
    toFile(line);
  }

  // The last `count` lines of the log (reading the rotated file too when needed).
  // The newest `count` lines (a promise). (audit S-3) Read asynchronously, and only as far back as they need: from
  // ~400 bytes a line, doubling while too few came, at most 2 MB of each file (it read 2 MB of both, synchronously).
  async function tail(count) {
    if (!file) return [];
    const MAX = 2 * 1024 * 1024;
    const lines = [];
    for (const f of [file, `${file}.1`]) {
      const need = count - lines.length;
      let got = [];
      let fh = null;
      try {
        fh = await fsp.open(f, 'r');
        const { size: total } = await fh.stat();
        const limit = Math.min(total, MAX);
        for (let want = Math.min(limit, Math.max(64 * 1024, need * 400)); ; want = Math.min(limit, want * 2)) {
          const buf = Buffer.alloc(want);
          await fh.read(buf, 0, want, total - want);
          got = buf.toString('utf8').split('\n').filter(Boolean);
          if (want < total && got.length) got.shift(); // probably a partial first line
          if (got.length >= need || want >= limit) break;
        }
      } catch {
        continue;
      } finally {
        await fh?.close().catch(() => {});
      }
      lines.unshift(...got);
      if (lines.length >= count) break;
    }
    return lines.slice(-count);
  }

  return {
    info: (...parts) => write('INFO', parts),
    warn: (...parts) => write('WARN', parts),
    error: (...parts) => write('ERROR', parts),
    tail,
    setFile(next) { close(); file = next; size = null; },
    get file() { return file; },
  };
}

module.exports = { createLogger };
