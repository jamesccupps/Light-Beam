'use strict';
// (1.23) The little of WebSocket (RFC 6455) that Beam's VNC relay needs: the handshake's accept key, and reading and
// writing frames. Data frames are treated as bytes (text ones too); messages split over frames simply follow each other,
// which is all a byte stream like VNC's needs. cli/beam.js has its own copy of the client half (it ships as one file).
const crypto = require('node:crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 };

const acceptKey = key => crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64');

// One whole frame. `mask` (4 bytes) for a client's frames; a server's have none.
function frame(opcode, payload = Buffer.alloc(0), mask = null) {
  const len = payload.length;
  const extra = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const head = Buffer.alloc(2 + extra + (mask ? 4 : 0));
  head[0] = 0x80 | opcode;
  head[1] = (mask ? 0x80 : 0) | (len < 126 ? len : len < 65536 ? 126 : 127);
  if (extra === 2) head.writeUInt16BE(len, 2);
  else if (extra === 8) head.writeBigUInt64BE(BigInt(len), 2);
  if (!mask) return Buffer.concat([head, payload]);
  mask.copy(head, 2 + extra);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, body]);
}

// A close frame: a code (1000 normal, 1001 going away, 1002 protocol error, 1008 policy, 1011 server error, 4000–4999
// Beam's own) and a short reason.
function closeFrame(code = 1000, reason = '', mask = null) {
  const text = Buffer.from(String(reason).slice(0, 100), 'utf8').subarray(0, 123);
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return frame(OP.close, payload, mask);
}

// Reads frames out of a stream of bytes. `masked`: the frames must be masked (a server reading a client) or must not be
// (a client reading a server). That broken, reserved bits, a bad control frame or a frame over `max` bytes throw: the
// connection should then close (1002).
class FrameReader {
  constructor({ masked, max = 1 << 20 }) {
    this.masked = masked;
    this.max = max;
    this.buf = Buffer.alloc(0);
  }

  // The frames these bytes complete, in order: [{ fin, opcode, payload }].
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      const b = this.buf;
      if (b.length < 2) break;
      if (b[0] & 0x70) throw new Error('reserved bits set');
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      if (masked !== this.masked) throw new Error(masked ? 'a masked frame from the server' : 'an unmasked frame from a client');
      let len = b[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (b.length < 4) break;
        len = b.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (b.length < 10) break;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.max)) throw new Error('a frame over the limit');
        len = Number(big);
        at = 10;
      }
      if (len > this.max) throw new Error('a frame over the limit');
      if (opcode >= 8 && (len > 125 || !fin)) throw new Error('a bad control frame');
      if (![0, 1, 2, 8, 9, 10].includes(opcode)) throw new Error(`an unknown opcode (${opcode})`);
      const keyAt = at;
      if (masked) at += 4;
      if (b.length < at + len) break;
      const payload = Buffer.from(b.subarray(at, at + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= b[keyAt + (i & 3)];
      out.push({ fin, opcode, payload });
      this.buf = b.subarray(at + len);
    }
    if (!this.buf.length) this.buf = Buffer.alloc(0);
    return out;
  }
}

module.exports = { OP, acceptKey, frame, closeFrame, FrameReader };
