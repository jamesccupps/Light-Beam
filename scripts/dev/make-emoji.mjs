// Makes lib/emoji.js (the alerts inbox: ntfy-style tags that are emoji names, shown as the emoji) from gemoji's
// db/emoji.json (MIT, Copyright (c) 2019 GitHub, Inc.). Usage: node scripts/dev/make-emoji.mjs <gemoji emoji.json> <out lib/emoji.js>
import fs from 'node:fs';

const [src, out] = process.argv.slice(2);
const list = JSON.parse(fs.readFileSync(src, 'utf8'));
const map = {};
for (const e of list) for (const alias of e.aliases || []) if (/^[a-z0-9_+-]{1,40}$/.test(alias) && !(alias in map)) map[alias] = e.emoji;
const body = Object.entries(map).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',');
fs.writeFileSync(out, `'use strict';
// (1.33) Emoji names, as ntfy reads a message's tags ("warning" shows as the emoji; others stay tags): the aliases of
// gemoji's db/emoji.json (https://github.com/github/gemoji), MIT licence, Copyright (c) 2019 GitHub, Inc. Made by
// scripts/dev/make-emoji.mjs; ${Object.keys(map).length} names.
module.exports = Object.freeze({${body}});
`);
console.log(Object.keys(map).length, 'names,', fs.statSync(out).size, 'bytes');
