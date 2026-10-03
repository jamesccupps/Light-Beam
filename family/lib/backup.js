'use strict';
// Beam Family's backups (Beam 1.8.1): every `hours` a family-backup-<UTC time>.tar.gz in the backups folder (the
// newest `keep` kept; nothing else there is touched), holding:
// - the database as a consistent snapshot, taken while the server runs (SQLite's VACUUM INTO: never a copy of the
//   live file, which the write-ahead log keeps changing);
// - control.key and vapid.json (the phones' push subscriptions are tied to that key), and the avatars;
// - the files people sent and their thumbnails while they add up to at most `filesMB` (above that the database still
//   lists them, and Beam Family shows them as gone after a restore).
// Restore: stop Beam Family, then `node family/server.js restore <backup> [--force]` (--force moves the current data
// aside into a replaced-… folder; nothing is deleted).
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const tar = require('../../lib/tar');

const NAME = /^family-backup-\d{8}-\d{6}\.tar\.gz$/;
const MANIFEST = 'family-backup.json';
const MB = 1024 * 1024;
// What an archive may hold, and where each goes in the data folder.
const ENTRY = /^(family-backup\.json|family\.db|control\.key|vapid\.json|(avatars|files|thumbs)\/[A-Za-z0-9._-]{1,120})$/;

const stampOf = t => new Date(t).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

async function listBackups(dir) {
  let names = [];
  try { names = (await fsp.readdir(dir)).filter(n => NAME.test(n)); } catch { return []; }
  const list = [];
  for (const name of names) {
    try { const st = await fsp.stat(path.join(dir, name)); list.push({ name, at: Math.round(st.mtimeMs), bytes: st.size }); } catch {}
  }
  return list.sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
}

async function filesIn(dir) {
  const out = [];
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return out; }
  for (const name of names) {
    try { const st = await fsp.stat(path.join(dir, name)); if (st.isFile()) out.push({ name, file: path.join(dir, name), size: st.size, mtime: st.mtimeMs }); } catch {}
  }
  return out;
}

function createBackups({ db, dataDir, backupDir, hours, keep, filesMB, version, log }) {
  let timer = null;
  let running = null;
  let last = null;

  // One at a time: a second asks while one is written get that one.
  function now(why) {
    return (running ||= (async () => {
      const name = `family-backup-${stampOf(Date.now())}.tar.gz`;
      const file = path.join(backupDir, name);
      const partial = `${file}.partial`;
      const snapshot = path.join(backupDir, `.family-snapshot-${process.pid}.db`);
      try {
        await fsp.mkdir(backupDir, { recursive: true });
        await fsp.rm(snapshot, { force: true });
        db.raw.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
        const [avatars, files, thumbs] = await Promise.all(['avatars', 'files', 'thumbs'].map(d => filesIn(path.join(dataDir, d))));
        const sent = files.concat(thumbs).reduce((n, f) => n + f.size, 0);
        const withFiles = sent <= filesMB * MB;
        const writer = tar.createWriter(fs.createWriteStream(partial, { mode: 0o600 }));
        try {
          await writer.addBuffer(MANIFEST, JSON.stringify({ format: 1, family: version, created: new Date().toISOString(), files: withFiles }, null, 2));
          const st = await fsp.stat(snapshot);
          await writer.addFile('family.db', snapshot, st.size, st.mtimeMs);
          for (const key of ['control.key', 'vapid.json']) {
            const f = path.join(dataDir, key);
            try { const s = await fsp.stat(f); await writer.addFile(key, f, s.size, s.mtimeMs); } catch {}
          }
          const add = async (sub, list) => { for (const f of list) if (ENTRY.test(`${sub}/${f.name}`)) await writer.addFile(`${sub}/${f.name}`, f.file, f.size, f.mtime); };
          await add('avatars', avatars);
          if (withFiles) { await add('files', files); await add('thumbs', thumbs); }
          await writer.finish();
        } catch (err) {
          writer.abort(err);
          throw err;
        }
        await fsp.rename(partial, file);
        const bytes = (await fsp.stat(file)).size;
        last = { at: Date.now(), name, bytes, files: withFiles, why };
        log.info(`Backed up Beam Family (${why}): ${name}, ${fmt(bytes)}${withFiles ? '' : `, without its ${fmt(sent)} of files`}, in ${backupDir}`);
        const old = (await listBackups(backupDir)).slice(keep);
        for (const b of old) await fsp.rm(path.join(backupDir, b.name), { force: true });
        if (old.length) log.info(`Removed ${old.length} old backup${old.length > 1 ? 's' : ''} (the newest ${keep} are kept)`);
        return last;
      } catch (err) {
        await fsp.rm(partial, { force: true }).catch(() => {});
        last = { at: Date.now(), error: err.message, why };
        log.warn(`The backup (${why}) failed: ${err.message}`);
        throw err;
      } finally {
        await fsp.rm(snapshot, { force: true }).catch(() => {});
        running = null;
      }
    })());
  }

  // The next one `hours` after the newest, and 10 minutes after the start at the earliest.
  async function schedule() {
    if (!hours) return log.info('Backups are off (BEAM_FAMILY_BACKUP_HOURS=0)');
    for (const n of await fsp.readdir(backupDir).catch(() => [])) {
      if (/^family-backup-.*\.partial$|^\.family-snapshot-/.test(n)) await fsp.rm(path.join(backupDir, n), { force: true }).catch(() => {});
    }
    const newest = (await listBackups(backupDir))[0];
    if (newest) last = { at: newest.at, name: newest.name, bytes: newest.bytes };
    const every = hours * 3600e3;
    const plan = ms => {
      clearTimeout(timer);
      timer = setTimeout(() => now(`every ${hours} h`).catch(() => {}).finally(() => plan(every)), Math.min(ms, 2 ** 31 - 1));
      timer.unref();
    };
    plan(Math.max(10 * 60e3, newest ? newest.at + every - Date.now() : 0));
  }

  return { now, schedule, list: () => listBackups(backupDir), last: () => last, stop: () => clearTimeout(timer) };
}

// Into an empty data folder (the server stopped): the archive is read through first, so a damaged one changes nothing.
async function restoreBackup(file, dataDir, { force = false } = {}) {
  let manifest = null;
  let count = 0;
  for await (const entry of tar.entries(fs.createReadStream(file))) {
    if (!manifest && entry.name !== MANIFEST) throw new Error("This isn't a Beam Family backup (it doesn't start with family-backup.json)");
    if (entry.type !== '0') continue;
    if (!ENTRY.test(entry.name)) throw new Error(`Unexpected ${entry.name} in the backup`);
    if (entry.name === MANIFEST) {
      const chunks = [];
      for await (const c of entry.content()) chunks.push(c);
      manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (manifest.format !== 1) throw new Error('This backup was made by an incompatible version of Beam Family');
      continue;
    }
    for await (const _ of entry.content()) { /* read through: checks the whole archive */ }
    count++;
  }
  if (!manifest) throw new Error("This isn't a Beam Family backup");
  await fsp.mkdir(dataDir, { recursive: true });
  const present = (await fsp.readdir(dataDir)).filter(n => !/^(logs|replaced-.*)$/.test(n));
  let aside = null;
  if (present.length) {
    if (!force) throw new Error(`${dataDir} already holds Beam Family data. Use --force to replace it (it's moved to a replaced-… folder, not deleted).`);
    aside = path.join(dataDir, `replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await fsp.mkdir(aside, { recursive: true });
    for (const name of present) await fsp.rename(path.join(dataDir, name), path.join(aside, name));
  }
  for await (const entry of tar.entries(fs.createReadStream(file))) {
    if (entry.type !== '0' || entry.name === MANIFEST || !ENTRY.test(entry.name)) { for await (const _ of entry.content()) { /* skip */ } continue; }
    const dest = path.join(dataDir, entry.name);
    await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    const out = fs.createWriteStream(`${dest}.restoring`, { mode: 0o600 });
    for await (const c of entry.content()) if (!out.write(c)) await new Promise(r => out.once('drain', r));
    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
    await fsp.rename(`${dest}.restoring`, dest);
  }
  return { manifest, files: count, aside };
}

function fmt(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

module.exports = { createBackups, restoreBackup, listBackups };
