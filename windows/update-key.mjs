#!/usr/bin/env node
// Signed Windows updates (1.7.3, audit S-07). The build signs every Beam.exe with a private key that never leaves the
// computer it's built on, and the apps carry the public half: they install only an update signed with it. The
// server just passes the signature on, so a changed dist/ folder, a broken server or a stranger on the way can't
// hand the PCs a Beam.exe of their own (the SHA-256 that came with the offer only caught a damaged download).
//
//   node windows/update-key.mjs public-cs <out.cs>                     the public key as C# (made first if needed)
//   node windows/update-key.mjs sign <Beam.exe> <version> <out.json>   the sidecar: version, sha256, size, sig
//   node windows/update-key.mjs public                                 (1.22) the public key, X‖Y in base64
//   node windows/update-key.mjs sign <file> <version> <out.json> linux (1.22) Beam for Linux's (linux/build.mjs)
//
// The key: BEAM_UPDATE_KEY, else ~/.beam/windows-update-key.pem: one per person who builds, shared by every copy of
// the project on that computer (a staging copy signs with the same key). BACK IT UP, like the Android keystore:
// apps built with it install only updates signed with it, and without it every PC needs Beam installed by hand once.
//
// What is signed (ECDSA P-256 with SHA-256, the signature as r‖s in base64): the UTF-8 text
//   "beam-windows-update\n<version>\n<sha256 in lowercase hex>\n<size in bytes>"
// The version is in it so an older signed build can't be offered as new. Beam for Linux's begins "beam-linux-update"
// instead: one app's signed build can't pass for the other's.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY_FILE = process.env.BEAM_UPDATE_KEY || path.join(os.homedir(), '.beam', 'windows-update-key.pem');
const message = (version, sha256, size, app = 'windows') => `beam-${app}-update\n${version}\n${sha256.toLowerCase()}\n${size}`;

function privateKey() {
  if (!fs.existsSync(KEY_FILE)) {
    const { privateKey: key } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(KEY_FILE, key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    console.error(`Made a new key for signing Beam's Windows updates: ${KEY_FILE}\n` +
      'Back it up (like the Android keystore): apps built from now on install only updates signed with it.');
  }
  const key = crypto.createPrivateKey(fs.readFileSync(KEY_FILE));
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error(`${KEY_FILE} isn't a P-256 key`);
  return key;
}

// The public key as the app reads it: X and Y, 32 bytes each, in base64.
function publicXY(key) {
  const jwk = crypto.createPublicKey(key).export({ format: 'jwk' });
  return Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64');
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'public-cs' && args.length === 1) {
    const cs = '// Made by windows/update-key.mjs when Beam is built (not in git): the public half of the key its updates are\n' +
      '// signed with (see UpdateSignature.cs).\n' +
      `namespace Beam { static class UpdateKey { public const string PublicKey = "${publicXY(privateKey())}"; } }\n`;
    fs.mkdirSync(path.dirname(args[0]), { recursive: true });
    fs.writeFileSync(args[0], cs);
  } else if (cmd === 'public' && !args.length) {
    process.stdout.write(`${publicXY(privateKey())}\n`);
  } else if (cmd === 'sign' && (args.length === 3 || (args.length === 4 && args[3] === 'linux'))) {
    const [exe, version, out, app = 'windows'] = args;
    if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(version)) throw new Error(`not a version: ${version}`);
    const data = fs.readFileSync(exe);
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const sig = crypto.sign('sha256', Buffer.from(message(version, sha256, data.length, app), 'utf8'), { key: privateKey(), dsaEncoding: 'ieee-p1363' });
    fs.writeFileSync(out, JSON.stringify({ version, sha256, size: data.length, sig: sig.toString('base64') }));
  } else {
    console.error('Usage: node windows/update-key.mjs public-cs <out.cs> | public | sign <file> <version> <out.json> [linux]');
    process.exit(2);
  }
} catch (err) {
  console.error(`update-key: ${err.message}`);
  process.exit(1);
}
