'use strict';
// A small streaming tar.gz writer and reader for Beam's export files. No dependencies.
// Writes ustar headers, with base-256 sizes for files of 8 GiB and more (GNU tar and bsdtar read those).
// Reads ustar, base-256 sizes, PAX ('x') and GNU long-name ('L') headers.

const fs = require('node:fs');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');

const BLOCK = 512;
const MAX_EXTENSION = 1024 * 1024; // (audit S-11) the biggest PAX or long-name header extension read
const OCTAL_MAX = 0o77777777777; // the largest size a 12-byte octal field holds (8 GiB - 1)

const padding = size => (BLOCK - (size % BLOCK)) % BLOCK;

function writeOctal(buf, offset, length, value) {
  buf.write(Math.floor(value).toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
}

function writeSize(buf, offset, value) {
  if (value <= OCTAL_MAX) return writeOctal(buf, offset, 12, value);
  buf[offset] = 0x80; // base-256: high bit set, big-endian binary in the remaining 11 bytes
  let v = BigInt(value);
  for (let i = offset + 11; i > offset; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function header(name, size, mtime, mode = 0o600) {
  if (Buffer.byteLength(name) > 100) throw new Error(`Name too long for the archive: ${name}`);
  const buf = Buffer.alloc(BLOCK);
  buf.write(name, 0, 100, 'utf8');
  writeOctal(buf, 100, 8, mode);
  writeOctal(buf, 108, 8, 0);
  writeOctal(buf, 116, 8, 0);
  writeSize(buf, 124, size);
  writeOctal(buf, 136, 12, Math.floor(mtime / 1000));
  buf.fill(0x20, 148, 156); // the checksum is computed with its own field as spaces
  buf.write('0', 156, 1, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return buf;
}

// Streams a .tar.gz into `out`. Await every add*() call (they respect backpressure), then finish().
function createWriter(out) {
  const gzip = zlib.createGzip({ level: 6 });
  let failure = null;
  const done = pipeline(gzip, out).catch(err => { failure = err; throw err; });
  done.catch(() => {});
  const write = chunk => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    if (gzip.write(chunk)) return resolve();
    const onDrain = () => { gzip.off('error', onError); resolve(); };
    const onError = err => { gzip.off('drain', onDrain); reject(err); };
    gzip.once('drain', onDrain);
    gzip.once('error', onError);
  });
  let bytes = 0;

  return {
    get bytes() { return bytes; },
    async addBuffer(name, data, mtime = Date.now()) {
      data = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      await write(header(name, data.length, mtime));
      await write(data);
      if (padding(data.length)) await write(Buffer.alloc(padding(data.length)));
      bytes += data.length;
    },
    // Adds a file of known size. If the file turns out shorter (it changed while being read), the entry is
    // padded with zeros and false is returned so the caller can leave that item out of the index.
    async addFile(name, file, size, mtime = Date.now()) {
      await write(header(name, size, mtime));
      let sent = 0;
      try {
        for await (const chunk of fs.createReadStream(file, { end: Math.max(0, size - 1) })) {
          if (!size) break;
          const piece = chunk.length > size - sent ? chunk.subarray(0, size - sent) : chunk;
          await write(piece);
          sent += piece.length;
          if (sent >= size) break;
        }
      } catch (err) {
        if (!sent && err.code !== 'ENOENT') throw err;
      }
      const complete = sent === size;
      if (!complete) await write(Buffer.alloc(size - sent));
      if (padding(size)) await write(Buffer.alloc(padding(size)));
      bytes += size;
      return complete;
    },
    async finish() {
      await write(Buffer.alloc(BLOCK * 2));
      gzip.end();
      await done;
    },
    abort(err) {
      gzip.destroy(err || new Error('Export cancelled'));
    },
  };
}

// Pulls exact byte counts out of a stream of chunks.
class ChunkReader {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.ended = false;
  }

  async fill(n) {
    while (this.buffer.length < n && !this.ended) {
      const { value, done } = await this.iterator.next();
      if (done) this.ended = true;
      else this.buffer = this.buffer.length ? Buffer.concat([this.buffer, value]) : value;
    }
  }

  // Exactly n bytes, or null at a clean end of stream when allowEnd is set.
  async read(n, allowEnd = false) {
    await this.fill(n);
    if (this.buffer.length < n) {
      if (allowEnd && this.buffer.length === 0) return null;
      throw new Error('The archive ends unexpectedly');
    }
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  async *take(n) {
    let left = n;
    while (left > 0) {
      if (!this.buffer.length) await this.fill(1);
      if (!this.buffer.length) throw new Error('The archive ends unexpectedly');
      const piece = this.buffer.subarray(0, Math.min(left, this.buffer.length));
      this.buffer = this.buffer.subarray(piece.length);
      left -= piece.length;
      yield piece;
    }
  }

  async skip(n) {
    for await (const _ of this.take(n)); // (read through)
  }
}

function readString(buf, offset, length) {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? length : end).toString('utf8');
}

function readNumber(buf, offset, length) {
  if (buf[offset] & 0x80) {
    let v = BigInt(buf[offset] & 0x7f);
    for (let i = offset + 1; i < offset + length; i++) v = (v << 8n) | BigInt(buf[i]);
    return Number(v);
  }
  const text = readString(buf, offset, length).trim();
  return text ? parseInt(text, 8) : 0;
}

function checksumOk(block) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  return sum === readNumber(block, 148, 8);
}

// PAX records are "<length> <key>=<value>\n", the length in bytes for the whole record. Read from the bytes (1.7.3,
// audit B-11: re-encoding the rest for every record was quadratic, and cutting text at a byte count could split a
// character).
function parsePax(data) {
  const out = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0 || space - pos > 20) break;
    const length = parseInt(data.toString('latin1', pos, space), 10);
    if (!(length > 0) || pos + length > data.length || space + 1 >= pos + length) break;
    const kv = data.toString('utf8', space + 1, pos + length - 1); // (without its newline)
    const eq = kv.indexOf('=');
    if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1);
    pos += length;
  }
  return out;
}

// Yields { name, size, type, mtime, content() } for each entry of a .tar.gz stream. content() is an async
// iterable of the entry's bytes; whatever isn't consumed is skipped.
async function* entries(input) {
  const gunzip = zlib.createGunzip();
  const piping = pipeline(input, gunzip);
  piping.catch(err => gunzip.destroy(err));
  const reader = new ChunkReader(gunzip);
  let longName = null;
  let pax = {};
  for (;;) {
    const block = await reader.read(BLOCK, true);
    if (!block || block.every(b => b === 0)) break;
    if (!checksumOk(block)) throw new Error('The archive is damaged (bad header checksum)');
    const type = block[156] ? String.fromCharCode(block[156]) : '0';
    let name = readString(block, 0, 100);
    const prefix = block.subarray(257, 262).toString('ascii') === 'ustar' ? readString(block, 345, 155) : '';
    if (prefix) name = `${prefix}/${name}`;
    let size = readNumber(block, 124, 12);
    if (type === 'x' || type === 'g' || type === 'L') {
      // (audit S-11) a name or PAX header far past anything real: a damaged (or crafted) archive, not an allocation
      if (size > MAX_EXTENSION) throw new Error('The archive is damaged (a header extension is too big)');
      const data = await reader.read(size);
      await reader.skip(padding(size));
      if (type === 'x') pax = parsePax(data);
      if (type === 'L') longName = readString(data, 0, data.length);
      continue;
    }
    if (pax.path) name = pax.path;
    if (longName) name = longName;
    if (pax.size !== undefined && /^\d+$/.test(pax.size)) size = Number(pax.size);
    longName = null;
    pax = {};
    let left = size;
    const entry = {
      name,
      size,
      type,
      mtime: readNumber(block, 136, 12) * 1000,
      content: () => (async function* () {
        for await (const piece of reader.take(left)) {
          left -= piece.length;
          yield piece;
        }
      })(),
    };
    yield entry;
    if (left > 0) await reader.skip(left);
    await reader.skip(padding(size));
  }
  // Let the rest of the gzip stream drain so the input is closed cleanly.
  gunzip.resume();
  await piping.catch(() => {});
}

module.exports = { createWriter, entries, header, BLOCK };
