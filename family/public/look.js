'use strict';
// (1.27) The look (the user: "customizable theme and colors … same with the family chat"): light, dark or like the
// device, and an accent colour. A plain script loaded before the page is drawn, so it starts in the colours it had last
// time (kept here); the live look (this person's own, else the family's) comes with the bootstrap (store.js).

const FAMILY_LOOK_KEY = 'family.look';
// The accent colours offered: Family's own (null), then [name, colour]. Any other colour works too (Custom). (On window:
// a classic script's const isn't, and pages.js, a module, reads it there.)
window.FAMILY_ACCENTS = [['Family', null], ['Blue', '#2563eb'], ['Teal', '#0e7c86'], ['Green', '#16803c'], ['Amber', '#b45309'],
  ['Red', '#d12b2b'], ['Pink', '#c2185b'], ['Purple', '#8b3fd9'], ['Graphite', '#4b5563']];

const familyLookColour = (() => {
  const hexRgb = hex => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const rgbHex = rgb => `#${rgb.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
  const luminance = rgb => {
    const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const readable = (rgb, bg, to) => { let c = rgb; for (let i = 0; i < 30 && contrast(c, bg) < 4.5; i++) c = mix(c, to, 0.07); return c; };
  // Its light-theme and dark-theme versions, each readable on that theme's surface (#fff, #1f1c22), with the text
  // colour that reads on it and a soft tint (style.css falls back to Family's own without them).
  return hex => {
    const white = [255, 255, 255], black = [0, 0, 0], night = [31, 28, 34];
    const base = hexRgb(hex);
    const day = readable(base, white, black), dark = readable(base, night, white);
    const ink = c => (contrast(c, white) >= 4.5 ? '#ffffff' : '#141216');
    return {
      '--u-accent': rgbHex(day), '--u-accent-ink': ink(day), '--u-accent-soft': rgbHex(mix(day, white, 0.88)),
      '--u-accent-d': rgbHex(dark), '--u-accent-ink-d': ink(dark), '--u-accent-soft-d': rgbHex(mix(dark, night, 0.78)),
    };
  };
})();

// Shows a look ({ theme: auto|light|dark, accent: '#rrggbb'|null }, or null: Family's own, like the device).
function familyApplyLook(look) {
  const root = document.documentElement;
  const theme = look && (look.theme === 'light' || look.theme === 'dark') ? look.theme : '';
  if (theme) root.dataset.theme = theme; else delete root.dataset.theme;
  for (const name of [...root.style]) if (name.startsWith('--u-')) root.style.removeProperty(name);
  if (look && typeof look.accent === 'string' && /^#[0-9a-f]{6}$/i.test(look.accent)) {
    for (const [name, value] of Object.entries(familyLookColour(look.accent))) root.style.setProperty(name, value);
  }
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = theme === 'dark' ? '#121014' : theme === 'light' ? '#f7f5f3' : /dark/.test(m.media) ? '#121014' : '#f7f5f3';
}

try {
  // (before 1.27 a browser kept only its theme, as family.theme)
  const kept = JSON.parse(localStorage.getItem(FAMILY_LOOK_KEY) || 'null');
  const old = localStorage.getItem('family.theme');
  familyApplyLook(kept || (old ? { theme: old, accent: null } : null));
} catch {}
