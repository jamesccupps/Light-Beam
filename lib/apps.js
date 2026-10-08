'use strict';
// (1.21) Apps on every PC: the parts that need no server state. Which GitHub repository a text names, which of a
// release's files is the Windows app, the checksum a release publishes for it, and the names and kinds Beam accepts.

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const TYPES = { '.exe': 'exe', '.msi': 'msi', '.zip': 'zip' };
// (other systems' builds, and files that only describe a release)
const OTHER_SYSTEMS = /linux|ubuntu|debian|\.deb$|\.rpm$|\.appimage$|mac|darwin|osx|apple|android|\.apk$|freebsd/i;
const NOT_THE_APP = /\.(sha\d+|sha\d+sum|md5|sig|asc|pem|txt|json|ya?ml|sbom|spdx)$|checksums?|sums$/i;

// "owner/repo", "https://github.com/owner/repo", "github.com/owner/repo/releases/latest" → { owner, repo }, or null.
function parseGithubRepo(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim().replace(/\.git$/i, '');
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)/i.exec(s);
  if (m) s = `${m[1]}/${m[2]}`;
  const [owner, repo, more] = s.split('/');
  if (more !== undefined || !OWNER.test(owner || '') || !REPO.test(repo || '') || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

// .exe, .msi or .zip (lower case), or null for anything Beam doesn't install.
function fileTypeOf(name) {
  const m = /\.[A-Za-z0-9]+$/.exec(String(name || ''));
  return (m && TYPES[m[0].toLowerCase()]) || null;
}

// A name that reads like an installer (it's run, not copied) rather than the app itself.
const isSetupName = name => /setup|install/i.test(String(name || ''));

// The release's Windows app: the asset named `wanted` when given, else the best of its .exe/.msi/.zip files (named
// like the repository, then saying Windows, then x64), never other systems' builds or checksum files.
// { asset, candidates } (candidates: every possible one, best first; asset null when there's none).
function pickAsset(release, repo, wanted) {
  const assets = (Array.isArray(release?.assets) ? release.assets : [])
    .filter(a => a && typeof a.name === 'string' && typeof a.browser_download_url === 'string');
  if (wanted) {
    const a = assets.find(x => x.name === wanted);
    return { asset: a && fileTypeOf(a.name) ? a : null, candidates: a ? [a] : [] };
  }
  const base = String(repo || '').toLowerCase();
  const score = a => {
    const n = a.name.toLowerCase();
    let s = 0;
    if (base && n.replace(/[-_. ]/g, '').includes(base.replace(/[-_. ]/g, ''))) s += 4;
    if (/win(dows|64|32)?\b|win[-_]/.test(n)) s += 2;
    if (/x64|amd64|x86_64|win64/.test(n)) s += 1;
    if (/arm64|aarch64/.test(n)) s -= 3; // (doesn't run on an x64 PC: after even an installer)
    if (fileTypeOf(n) === 'exe' && !isSetupName(n)) s += 1; // (the app itself before an installer)
    return s;
  };
  const candidates = assets
    .filter(a => fileTypeOf(a.name) && !OTHER_SYSTEMS.test(a.name) && !NOT_THE_APP.test(a.name))
    .map(a => ({ a, s: score(a) }))
    .sort((x, y) => y.s - x.s || x.a.name.localeCompare(y.a.name))
    .map(x => x.a);
  return { asset: candidates[0] || null, candidates };
}

// Where the release says the asset's SHA-256 is: `<name>.sha256` (or .sha256sum), else a sums file
// (SHA256SUMS, checksums.txt…). null when it publishes none.
function checksumAsset(release, name) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const own = assets.find(a => a && (a.name === `${name}.sha256` || a.name === `${name}.sha256sum`));
  if (own) return own;
  return assets.find(a => a && typeof a.name === 'string' && /sha256|checksums?|sums/i.test(a.name) && !fileTypeOf(a.name)) || null;
}

// The 64-hex SHA-256 for `name` in a checksum file's text: a line naming it ("<hex>  name", "<hex> *name",
// "SHA256 (name) = <hex>"), or the only hash in a file of its own. Lower case, or null.
function checksumIn(text, name) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const hex = /\b([a-f0-9]{64})\b/i.exec(line);
    if (!hex) continue;
    const rest = line.replace(hex[1], ' ').replace(/[*()=]/g, ' ').split(/\s+/).filter(Boolean);
    if (rest.some(w => w === name || w.endsWith(`/${name}`))) return hex[1].toLowerCase();
  }
  const all = lines.map(l => /^([a-f0-9]{64})(\s|$)/i.exec(l)).filter(Boolean);
  return all.length === 1 && lines.length === 1 ? all[0][1].toLowerCase() : null;
}

// A winget package id ("7zip.7zip", "Microsoft.VisualStudioCode"): letters, digits and + _ - in dot-separated parts.
const isWingetId = id => typeof id === 'string' && id.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9+_-]*(\.[A-Za-z0-9+_-]+)+$/.test(id);

// A file name Beam keeps and the PCs install under: letters, digits, spaces and . _ - ( ) +, at most 100.
function safeFileName(name) {
  const s = String(name || '').replace(/[^A-Za-z0-9._ ()+-]/g, '').replace(/^[. ]+|[. ]+$/g, '').slice(0, 100);
  return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s) ? `_${s}` : s;
}

// A name to show (and the folder the PCs install into): one line, no path characters, at most 60.
function appName(text) {
  return String(text || '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

// A release's version from its tag ("v0.3.0" → "0.3.0"), at most 40 characters.
const versionOfTag = tag => String(tag || '').trim().replace(/^v(?=\d)/i, '').slice(0, 40);

module.exports = { parseGithubRepo, fileTypeOf, isSetupName, pickAsset, checksumAsset, checksumIn, isWingetId, safeFileName, appName, versionOfTag };
