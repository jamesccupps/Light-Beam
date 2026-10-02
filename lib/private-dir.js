'use strict';
// A data folder only the account Beam runs as can open (plus SYSTEM and Administrators): a folder made inside one that
// every local account may change (D:\Beam was) would otherwise inherit that. Used by Beam and by Beam Family.
// BEAM_DATA_ACL=keep leaves the permissions alone; a network share keeps the share's own.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// Groups that mean "other people": Everyone, Authenticated Users, Users, Interactive, Anonymous, Guests.
const BROAD_SIDS = { WD: 'S-1-1-0', AU: 'S-1-5-11', BU: 'S-1-5-32-545', IU: 'S-1-5-4', AN: 'S-1-5-7', BG: 'S-1-5-32-546' };
const BROAD = new Set(Object.values(BROAD_SIDS));

function makePrivate(dir, { log, env = process.env, label = 'data folder' }) {
  if (env.BEAM_DATA_ACL === 'keep') return;
  if (process.platform !== 'win32') {
    try {
      const st = fs.statSync(dir);
      if ((st.mode & 0o077) && st.uid === process.getuid?.()) {
        fs.chmodSync(dir, 0o700);
        log.info(`Made the ${label} ${dir} private to this account (others could read it)`);
      } else if (st.mode & 0o077) {
        // (1.7.3) Not this account's folder, so chmod isn't ours to do: say so rather than look private.
        log.warn(`The ${label} ${dir} is open to other accounts (mode ${(st.mode & 0o777).toString(8)}) and belongs to another one (uid ${st.uid}), so Beam can't make it private. Give it to the account Beam runs as, or chmod 700 it.`);
      }
    } catch (err) {
      log.warn(`Couldn't make the ${label} ${dir} private (${err.code || err.message})`);
    }
    return;
  }
  if (dir.startsWith('\\\\')) return; // a network share keeps the share's own permissions
  const icacls = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  const broad = () => {
    const file = path.join(os.tmpdir(), `beam-acl-${process.pid}-${crypto.randomBytes(4).toString('hex')}.txt`);
    try {
      execFileSync(icacls, [dir, '/save', file], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
      const sddl = fs.readFileSync(file).toString('utf16le').split(/\r?\n/)[1] || '';
      // Allow entries (A;flags;rights;;;SID) for groups beyond this account.
      const sids = [...sddl.matchAll(/\(A;[^;]*;[^;]*;[^;]*;[^;]*;([^)]+)\)/g)].map(m => BROAD_SIDS[m[1].toUpperCase()] || m[1].toUpperCase());
      return [...new Set(sids.filter(sid => BROAD.has(sid)))];
    } finally {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
  };
  try {
    const found = broad();
    if (!found.length) return;
    const user = /"(S-1-[\d-]+)"\s*$/.exec(execFileSync(path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 15000 }).toString().trim())?.[1];
    if (!user) throw new Error("couldn't tell which account Beam runs as");
    const full = sid => `*${sid}:(OI)(CI)F`;
    execFileSync(icacls, [dir, '/inheritance:r', '/grant:r', full(user), full('S-1-5-18'), full('S-1-5-32-544')], { windowsHide: true, stdio: 'ignore', timeout: 60000 });
    execFileSync(icacls, [dir, '/remove:g', ...found.map(sid => `*${sid}`)], { windowsHide: true, stdio: 'ignore', timeout: 60000 });
    const left = broad();
    if (left.length) throw new Error(`other accounts still have access (${left.join(', ')})`);
    log.info(`Made the ${label} ${dir} private to this account (every local account could read and change it)`);
  } catch (err) {
    log.warn(`The ${label} ${dir} can be opened by other accounts on this computer and Beam couldn't change that (${err.message}). Its permissions should allow only the account Beam runs as.`);
  }
}

module.exports = { makePrivate, BROAD_SIDS };
