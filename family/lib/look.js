'use strict';
// (1.27) A look (the user: "customizable theme and colors … same with the family chat"; their pick: each person's own,
// and a family default the owner sets): light, dark or like the device ("auto"), and an accent colour (null: Family's
// own). Kept as JSON in users.appearance and spaces.appearance (database v6); the page works out the colours.

const { httpError } = require('./http');

const THEMES = ['auto', 'light', 'dark'];

function cleanLook(v) {
  if (v === null) return null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw httpError(400, 'appearance must be {"theme": "auto"|"light"|"dark", "accent": "#rrggbb"|null} or null');
  const unknown = Object.keys(v).filter(k => k !== 'theme' && k !== 'accent');
  if (unknown.length) throw httpError(400, `Unknown appearance field: ${unknown.join(', ')}`);
  const theme = v.theme ?? 'auto';
  if (!THEMES.includes(theme)) throw httpError(400, 'appearance.theme must be auto, light or dark');
  const accent = v.accent ?? null;
  if (accent !== null && !(typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent))) throw httpError(400, 'appearance.accent must be a colour like #2563eb, or null');
  return { theme, accent: accent && accent.toLowerCase() };
}

// What's kept (JSON text), read back safely.
function lookOf(text) {
  if (!text) return null;
  try { return cleanLook(JSON.parse(text)); } catch { return null; }
}

module.exports = { cleanLook, lookOf };
