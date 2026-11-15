'use strict';
// Pictures' sizes from their headers (the servers have no image libraries). A small file can say it is 8000×8000 and
// take hundreds of MB to draw: a phone that showed one crashed every time (the user's review M8, 2026-11-05). Beam's
// thumbnails, Beam Family's previews and avatars, and the Sites icons are checked with these (the 2026-11-14 audit).

// A JPEG's or WebP's width and height from its header, or null.
function thumbDims(b, format) {
  if (format === 'jpeg') {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return null;
  }
  if (b.length < 16) return null;
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ' && b.length >= 30) return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L' && b.length >= 25) { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
  if (chunk === 'VP8X' && b.length >= 30) return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
  return null;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = b => b.length >= 8 && b.subarray(0, 8).equals(PNG);
const pngDims = b => (b.length >= 24 && b.toString('latin1', 12, 16) === 'IHDR' ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null);

// A PNG's, GIF's, JPEG's, WebP's or ICO's width and height from its header, or null when it can't be read. An ICO
// says the largest of its pictures (by its list and by each picture's own header: a PNG inside says its own).
function imageDims(b) {
  if (!Buffer.isBuffer(b)) return null;
  if (isPng(b)) return pngDims(b);
  if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return thumbDims(b, 'jpeg');
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return thumbDims(b, 'webp');
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) {
    const count = b.readUInt16LE(4);
    if (count === 0 || count > 64 || 6 + 16 * count > b.length) return null;
    let w = 0;
    let h = 0;
    for (let i = 0; i < count; i++) {
      const e = 6 + 16 * i;
      const at = b.readUInt32LE(e + 12);
      if (at >= b.length) return null;
      const inner = b.subarray(at);
      let d;
      if (isPng(inner)) d = pngDims(inner);
      else if (inner.length >= 12) d = { w: Math.abs(inner.readInt32LE(4)), h: Math.abs(inner.readInt32LE(8)) / 2 }; // (a bitmap's height counts its mask too)
      if (!d) return null;
      w = Math.max(w, b[e] || 256, d.w);
      h = Math.max(h, b[e + 1] || 256, d.h);
    }
    return { w, h };
  }
  return null;
}

module.exports = { thumbDims, imageDims };
