// Compares the staging tree (next/) with the live project and, with --apply, copies the changes over after backing
// up every file it replaces or deletes. Never touches data/, dist/, keystores, build outputs or the user's notes.
//   node scripts/dev/deploy-diff.mjs --staging <dir> [--only a,b/]               # show what would change
//   node scripts/dev/deploy-diff.mjs --staging <dir> [--only a,b/] --apply <backupDir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const stagingArg = process.argv.indexOf('--staging');
const STAGING = stagingArg > 0 ? process.argv[stagingArg + 1] : process.env.BEAM_STAGING;
if (!STAGING) throw new Error('Give the staging folder: --staging <dir> (or BEAM_STAGING)');

// Paths (relative, forward slashes) that are never compared, copied or deleted.
const SKIP = [
  /^\.git(\/|$)/, /^\.gitignore$/, /^\.gitattributes$/, // the project's git repository (the staging copy has none)
  /^data(\/|$)/, /^dist(\/|$)/, /^node_modules(\/|$)/, /^\.env$/,
  /^CLAUDE\.md$/, /^README\.md$/, /^docs\/IDEAS\.md$/, /^PROGRESS-[a-z]+\.md$/,
  /^android\/keystore(\/|$)/, /^android\/keystore\.properties$/, /^android\/local\.properties$/,
  /(^|\/)build(\/|$)/, /^android\/\.gradle(\/|$)/, /^android\/\.kotlin(\/|$)/, /^android\/\.idea(\/|$)/,
  /^windows\/bin(\/|$)/, /^windows\/lib\/webview2(\/|$)/,
  /^test\/web\/shots(\/|$)/, /^test\/.*\/(tmp|scratch)(\/|$)/, /\.log$/,
];
const skipped = rel => SKIP.some(re => re.test(rel));

function walk(root, rel = '', out = new Map()) {
  let entries = [];
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (skipped(r)) continue;
    if (e.isDirectory()) walk(root, r, out);
    else if (e.isFile()) out.set(r, path.join(root, r));
  }
  return out;
}

const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
// --only server.js,windows/ limits everything to paths starting with one of these prefixes.
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg > 0 ? process.argv[onlyArg + 1].split(',').map(s => s.trim()).filter(Boolean) : null;
const keep = rel => !only || only.some(p => rel === p || rel.startsWith(p));
const live = new Map([...walk(PROJECT)].filter(([rel]) => keep(rel)));
const next = new Map([...walk(STAGING)].filter(([rel]) => keep(rel)));

const added = [], changed = [], deleted = [];
for (const [rel, file] of next) {
  if (!live.has(rel)) added.push(rel);
  else if (hash(file) !== hash(live.get(rel))) changed.push(rel);
}
for (const rel of live.keys()) if (!next.has(rel)) deleted.push(rel);

const group = list => {
  const by = {};
  for (const rel of list.sort()) (by[rel.split('/')[0]] ||= []).push(rel);
  return by;
};
for (const [label, list] of [['ADDED', added], ['CHANGED', changed], ['DELETED', deleted]]) {
  console.log(`\n== ${label} (${list.length})`);
  for (const [top, files] of Object.entries(group(list))) console.log(`  ${top}/: ${files.length}${files.length <= 25 ? '\n    ' + files.join('\n    ') : ''}`);
}

const apply = process.argv.indexOf('--apply');
if (apply > 0) {
  const backup = process.argv[apply + 1];
  if (!backup) throw new Error('--apply needs a backup directory');
  for (const rel of [...changed, ...deleted]) {
    const dest = path.join(backup, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(PROJECT, rel), dest);
  }
  fs.writeFileSync(path.join(backup, 'deploy-manifest.json'), JSON.stringify({ at: new Date().toISOString(), added, changed, deleted }, null, 1));
  for (const rel of [...added, ...changed]) {
    const dest = path.join(PROJECT, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(STAGING, rel), dest);
  }
  for (const rel of deleted) fs.rmSync(path.join(PROJECT, rel), { force: true });
  console.log(`\nApplied. Backup of replaced/deleted files: ${backup}`);
}
