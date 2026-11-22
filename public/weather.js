'use strict';
// ---------------------------------------------------------------- weather (1.36)
// LocalCast's weather (the user's own forecaster: its page on the tailnet, which Sites finds) as a row under Alerts:
// now, today's high and low and chance of rain, its warnings first. The row opens LocalCast's page as it is (the user:
// "you should just implement the page that is served by tailscale into beam, i wont change that link"): a new tab in
// a browser, a window of its own in the Windows app (`openWeather`). The server reads LocalCast's page data
// (GET /api/weather: trusted sign-ins). Settings → Server says where it comes from (found, set, off).

const weatherBox = { data: null, loading: null, at: 0 };
const WEATHER_EVERY_MS = 10 * 60e3;
let weatherRow = null;

const weatherFeature = () => serverHas('weather') && me.trusted === true && !me.temporary;

// LocalCast gives °C; its page says how it shows them (imperial: °F).
function weatherDeg(c, units) {
  if (typeof c !== 'number' || !Number.isFinite(c)) return '';
  return `${Math.round(units === 'metric' ? c : c * 9 / 5 + 32)}°`;
}

function loadWeather(force = false) {
  if (!weatherFeature() || document.documentElement.classList.contains('files-mode')) return null;
  if (!force && weatherBox.loading) return weatherBox.loading;
  if (!force && Date.now() - weatherBox.at < 60e3) return null;
  weatherBox.loading = apiJson('api/weather')
    .then(d => {
      const had = Boolean(weatherBox.data?.url);
      weatherBox.data = d;
      weatherBox.at = Date.now();
      if (had !== Boolean(d?.url)) renderSidebar(); else patchWeatherRow();
    })
    .catch(() => { weatherBox.at = Date.now(); })
    .finally(() => { weatherBox.loading = null; });
  return weatherBox.loading;
}

// What the row says: [the temperature now, the line under it, whether it's a warning].
function weatherLine(d) {
  if (!d?.now) return ['', d?.error ? `LocalCast didn’t answer (${d.error})` : 'LocalCast’s weather', false];
  const u = d.units;
  const t = d.today || {};
  const day = [t.hi != null && `↑${weatherDeg(t.hi, u)}`, t.lo != null && `↓${weatherDeg(t.lo, u)}`].filter(Boolean).join(' ');
  const rain = typeof t.pop === 'number' && t.pop >= 10 ? `rain ${Math.round(t.pop)}%` : '';
  const warn = d.hazards?.[0]?.title || '';
  const line = [warn, d.now.text, day, rain].filter(Boolean).join(' · ');
  return [weatherDeg(d.now.temp, u), line, Boolean(warn)];
}

// Called by renderSidebar after the Alerts row: the Weather row, once LocalCast's page is known.
function placeWeatherRow(list, cursor) {
  if (!weatherFeature() || !weatherBox.data?.url) {
    if (weatherRow) { if (weatherRow.li === cursor) cursor = cursor.nextElementSibling; weatherRow.li.remove(); weatherRow = null; }
    if (weatherFeature() && !weatherBox.data && !weatherBox.loading) loadWeather();
    return cursor;
  }
  if (!weatherRow) {
    const name = el('span', { class: 'conv-name' }, 'Weather');
    const time = el('span', { class: 'conv-time weather-now' });
    const preview = el('span', { class: 'conv-preview' });
    const button = el('button', { class: 'conv weather-row', type: 'button', 'data-conv': 'weather' },
      el('span', { class: 'av-slot' }, el('span', { class: 'avatar weather' }, icon('weather'))),
      el('span', { class: 'conv-body' }, el('span', { class: 'conv-top' }, name, time), el('span', { class: 'conv-bottom' }, preview)));
    button.addEventListener('click', openWeather);
    weatherRow = { li: el('li', {}, button), button, time, preview };
  }
  patchWeatherRow();
  if (weatherRow.li === cursor) return cursor.nextElementSibling;
  list.insertBefore(weatherRow.li, cursor);
  return cursor;
}

function patchWeatherRow() {
  const r = weatherRow;
  if (!r) return;
  const d = weatherBox.data;
  const [now, line, warn] = weatherLine(d);
  if (r.time.textContent !== now) r.time.textContent = now;
  if (r.preview.textContent !== line) r.preview.textContent = line;
  r.preview.classList.toggle('warn', warn);
  const where = [d?.name, d?.locale].filter(Boolean).join(', ');
  r.button.title = `${where ? `${where}: ` : ''}LocalCast’s page (${d?.url || ''})`;
  r.button.setAttribute('aria-label', `Weather${where ? ` in ${where}` : ''}: ${[now, line].filter(Boolean).join(', ')}. Opens LocalCast’s page.`);
}

// LocalCast's own page, as it is: the Windows app's window (1.28), else the browser.
function openWeather() {
  const url = weatherBox.data?.url;
  if (!url) return;
  if (hostHas('weather')) { hostDo('openWeather', { url }); return; }
  openLink(url);
  loadWeather();
}

// ---------------------------------------------------------------- Settings → Server: where it comes from

function weatherCard() {
  const w = serverHas('weather') ? serverSettings?.weather : null;
  if (!w) return null;
  const from = w.off ? 'Off: no Weather row on your devices.'
    : !w.url ? 'Not found yet: a site titled LocalCast (Sites) becomes the Weather row’s page.'
      : `${w.how === 'found' ? 'LocalCast, found among your sites' : w.how === 'env' ? 'Set in the server’s configuration (BEAM_WEATHER_URL)' : 'The address you set'}: ${w.url}`;
  const other = smallBtn('Another address…', askWeatherUrl, { kind: 'ghost' });
  const onOff = w.off ? smallBtn('Turn on', () => patchServerSettings({ weather: null }))
    : smallBtn('Turn off', () => patchServerSettings({ weather: false }), { kind: 'ghost' });
  const find = !w.off && w.how === 'set' && smallBtn('Find it among the sites', () => patchServerSettings({ weather: null }), { kind: 'ghost' });
  return card('Weather',
    cardInfo(from),
    !w.fixed && buttonRow(other, find, onOff),
    cardInfo('The Weather row (under Alerts) shows LocalCast’s weather now and today, and opens its page.'));
}

function askWeatherUrl() {
  const input = el('input', { type: 'url', placeholder: 'http://my-pc:8787', 'aria-label': 'LocalCast’s page', value: serverSettings?.weather?.url || '', autocomplete: 'off' });
  const save = el('button', { class: 'btn primary', type: 'submit' }, 'Use it');
  const cancel = el('button', { class: 'btn ghost', type: 'button', onclick: () => $('#genDlg').close() }, 'Cancel');
  const form = el('form', { class: 'set-stack' }, el('p', { class: 'muted small' }, 'The address of LocalCast’s page on your tailnet, as you open it in a browser.'), input);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url) return input.focus();
    $('#genDlg').close();
    await patchServerSettings({ weather: { url } });
    weatherBox.at = 0;
    loadWeather(true);
  });
  save.setAttribute('form', 'weatherForm');
  form.id = 'weatherForm';
  openDialog({ title: 'Weather', body: [form], buttons: [cancel, save] });
  requestAnimationFrame(() => input.focus());
}

setInterval(() => { if (!document.hidden && typeof paired !== 'undefined' && paired) loadWeather(); }, WEATHER_EVERY_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden && weatherBox.at && Date.now() - weatherBox.at > WEATHER_EVERY_MS) loadWeather(); });
