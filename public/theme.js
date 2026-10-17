'use strict';
// (1.27) The look (the user: "customizable theme and colors, maybe per device or for all devices"): light, dark or
// like the device, and an accent colour. Loaded before the page is drawn (not deferred), so it starts in the colours
// it had last time (kept here); the live look comes with the server's hello and this device's own (settings.js).

const LOOK_KEY = 'beam.look';
// The accent colours offered: Beam's own (null), then [name, colour]. Any other colour works too (Custom).
const ACCENTS = [['Beam', null], ['Blue', '#2563eb'], ['Teal', '#0e7c86'], ['Green', '#16803c'], ['Amber', '#b45309'],
  ['Red', '#d12b2b'], ['Pink', '#c2185b'], ['Purple', '#8b3fd9'], ['Graphite', '#4b5563']];
const LOOK_BG = { light: '#f5f6f8', dark: '#0e1014' }; // (the page's background: the phone browser's own bar)

const hexRgb = hex => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbHex = rgb => `#${rgb.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
function luminance(rgb) {
  const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mixRgb = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
// Toward `to` (black or white) in small steps until it reads on `bg` (WCAG AA for text: 4.5).
function readable(rgb, bg, to) {
  let c = rgb;
  for (let i = 0; i < 30 && contrast(c, bg) < 4.5; i++) c = mixRgb(c, to, 0.07);
  return c;
}

// The CSS variables for an accent (style.css falls back to Beam's own without them): its light-theme and dark-theme
// versions, each readable on that theme's surfaces, with the text colour that reads on it and a soft tint.
function accentVars(hex) {
  const white = [255, 255, 255], black = [0, 0, 0], night = [23, 26, 32]; // (night: the dark theme's surface)
  const base = hexRgb(hex);
  const day = readable(base, white, black);
  const dark = readable(base, night, white);
  const ink = c => (contrast(c, white) >= 4.5 ? '#ffffff' : '#0e1014');
  return {
    '--u-accent': rgbHex(day), '--u-accent-ink': ink(day), '--u-accent-soft': rgbHex(mixRgb(day, white, 0.88)),
    '--u-mine': rgbHex(day), '--u-mine-ink': ink(day),
    '--u-accent-d': rgbHex(dark), '--u-accent-ink-d': ink(dark), '--u-accent-soft-d': rgbHex(mixRgb(dark, night, 0.8)),
    '--u-mine-d': rgbHex(day), '--u-mine-ink-d': ink(day),
  };
}

// Shows a look ({ theme: auto|light|dark, accent: '#rrggbb'|null }, or null: Beam's own, like the device).
function applyLook(look) {
  const root = document.documentElement;
  const theme = look && (look.theme === 'light' || look.theme === 'dark') ? look.theme : '';
  if (theme) root.dataset.theme = theme; else delete root.dataset.theme;
  for (const name of [...root.style]) if (name.startsWith('--u-')) root.style.removeProperty(name);
  if (look && typeof look.accent === 'string' && /^#[0-9a-f]{6}$/i.test(look.accent)) {
    for (const [name, value] of Object.entries(accentVars(look.accent))) root.style.setProperty(name, value);
  }
  const scheme = document.querySelector('meta[name="color-scheme"]');
  if (scheme) scheme.content = theme || 'light dark';
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = theme ? LOOK_BG[theme] : /dark/.test(m.media) ? LOOK_BG.dark : LOOK_BG.light;
}

try { applyLook(JSON.parse(localStorage.getItem(LOOK_KEY) || 'null')); } catch {}
