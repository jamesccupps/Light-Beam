'use strict';
// (1.36) LocalCast's weather in Beam (the user, 2026-11-21: "my local cast weather should be part of this app"; then
// "you should just implement the page that is served by tailscale into beam, i wont change that link"). Beam reads
// LocalCast's own page data (GET <its page>api/dashboard) as it is and never changes LocalCast: this is the summary
// for the Weather row. Temperatures stay in °C as LocalCast gives them; `units` says how its page shows them.
const sites = require('./sites');

const LIMIT = 2 * 1024 * 1024; // its page data was ~70 KB on 2026-11-21

const num = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const words = (v, max) => sites.oneLine(v, max) || null;
const KIND = /^[a-z][a-z-]{0,19}$/;

// LocalCast's /api/dashboard → { name, locale, units, now, today, hazards }, or null when it isn't that.
function summarize(d) {
  if (!d || typeof d !== 'object' || !d.now || typeof d.now !== 'object' || Array.isArray(d.now)) return null;
  const n = d.now;
  const m = d.meta && typeof d.meta === 'object' ? d.meta : {};
  const day = Array.isArray(d.days) && d.days[0] && typeof d.days[0] === 'object' ? d.days[0] : {};
  const hazards = (Array.isArray(d.hazards) ? d.hazards : []).slice(0, 4).map(h => {
    const title = words(typeof h === 'string' ? h : h?.title, 100);
    return title && { title, kind: KIND.test(h?.kind) ? h.kind : null, ...(h?.kind === 'nws' && { official: true }) };
  }).filter(Boolean);
  return {
    name: words(d.site?.name, 60) || words(m.site, 60),
    locale: words(m.locale, 80),
    units: m.units === 'metric' ? 'metric' : 'imperial',
    now: {
      temp: num(n.temp), feels: num(n.feels), text: words(n.text, 60), kind: KIND.test(n.kind) ? n.kind : null,
      day: n.day !== false, age: num(n.age_s),
    },
    today: { hi: num(day.hi ?? n.hi), lo: num(day.lo ?? n.lo), pop: num(day.pop) },
    hazards,
  };
}

// Reads LocalCast's page data at base (its page's address) through `request` (the server's outbound: the tailnet proxy
// when there is one). Resolves the summary; rejects with a reason in words.
async function read(request, base, { timeout = 5000 } = {}) {
  const url = new URL('api/dashboard', base).href;
  let res;
  try {
    res = await sites.withDeadline(request(url, { headers: { Accept: 'application/json', 'User-Agent': 'Beam (weather)' }, timeout }), timeout);
  } catch (err) {
    throw new Error(sites.problemOf(err));
  }
  if (res.status !== 200) { res.stream.resume(); throw new Error(`it answered with ${res.status}`); }
  const { body, more } = await sites.withDeadline(sites.readSome(res.stream, LIMIT), timeout, () => res.stream.destroy());
  if (more) throw new Error('its answer is too big');
  let data;
  try { data = JSON.parse(body.toString('utf8')); } catch { throw new Error('that isn’t LocalCast’s page'); }
  const summary = summarize(data);
  if (!summary) throw new Error('that isn’t LocalCast’s page');
  return summary;
}

module.exports = { summarize, read, LIMIT };
