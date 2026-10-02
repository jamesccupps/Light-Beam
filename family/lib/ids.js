'use strict';
// Ids for everything in Beam Family: 26 characters of Crockford base32, 48 bits of time (milliseconds) then 80 random
// bits (a ULID). They sort in creation order, so a message id is also its place in the channel; ids made in the same
// millisecond count up from the last one, so they still sort.

const crypto = require('node:crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const RANDOM_MAX = (1n << 80n) - 1n;

let lastTime = -1;
let lastRandom = 0n;

function encode(value, length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

function newId(now = Date.now()) {
  let time = Math.max(now, lastTime);
  let random;
  if (time === lastTime) {
    random = lastRandom + 1n;
    if (random > RANDOM_MAX) { time += 1; random = BigInt('0x' + crypto.randomBytes(10).toString('hex')); }
  } else {
    random = BigInt('0x' + crypto.randomBytes(10).toString('hex'));
  }
  lastTime = time;
  lastRandom = random;
  return encode(BigInt(time), 10) + encode(random, 16);
}

// The time an id was made (milliseconds), or NaN for something that isn't one.
function timeOf(id) {
  if (!ID.test(id)) return NaN;
  let value = 0;
  for (const c of id.slice(0, 10)) value = value * 32 + ALPHABET.indexOf(c);
  return value;
}

const isId = v => typeof v === 'string' && ID.test(v);

module.exports = { newId, timeOf, isId };
