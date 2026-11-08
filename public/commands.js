'use strict';
// (1.32) Commands on a PC (the user, 2026-11-06: "being able to remotely run powershell or other commands through beam").
// Device info → Run a command: a PowerShell or Command Prompt command on that PC, its output here while it runs, Stop,
// the exit code, Copy. Only for a PC whose Beam for Windows (1.25+) has "Allow commands too" on (turned on at that PC),
// from a device that may control it. The answer to POST api/devices/{id}/commands is the command's own event stream
// (start, running, out, end); a dropped connection picks it up again (GET api/commands/{run}?from=<seq>), and closing
// the panel stops what still runs. Recent commands are kept in this browser only (Clear forgets them).
// index.html#commands=<PC id>: the panel alone, full screen (the Android app's screen hosts it, as #files=).

const CMD_RECENT_MAX = 15;
const CMD_SHOWN_MAX = 2 * 1024 * 1024; // characters kept on screen (the oldest go first)
const cmdView = { device: null, run: null, page: false, dlgGen: 0, ticker: null, shownChars: 0 };

// How long, in words: tenths of a second under 10 s.
const cmdTook = ms => (ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)} s` : formatDuration(ms / 1000));

const canRunCommandsOn = d => Boolean(d) && serverHas('commands') && d.id !== me.id && d.online && d.can?.commands === true;

// Device info: why a PC that could run commands doesn't (null: it can, or it never could).
function commandsOffNote(d) {
  if (!serverHas('commands') || !d || d.id === me.id || d.platform !== 'windows' || d.can?.commands) return null;
  if (d.status?.remoteControl === true && d.status?.commands === false) return 'Commands are off there: “Allow commands too” is turned on at that PC (Beam’s menu in its taskbar corner, or Settings → Security).';
  return null;
}

function cmdRecentKey(d) { return `beam.commands.${d.id}`; }
function cmdRecent(d) {
  const list = store.json(cmdRecentKey(d), []);
  return Array.isArray(list) ? list.filter(x => x && typeof x.text === 'string' && (x.shell === 'powershell' || x.shell === 'cmd')).slice(0, CMD_RECENT_MAX) : [];
}
function cmdRemember(d, shell, text) {
  const list = cmdRecent(d).filter(x => !(x.shell === shell && x.text === text));
  list.unshift({ shell, text });
  store.setJson(cmdRecentKey(d), list.slice(0, CMD_RECENT_MAX));
}

function commandsOpen() {
  const dlg = $('#genDlg');
  return Boolean(dlg?.open && dlg.classList.contains('cmd-dlg') && dialogGen === cmdView.dlgGen);
}

function openCommands(d, { page = false } = {}) {
  cmdView.device = d;
  cmdView.page = page;
  cmdView.run = null;
  cmdView.shownChars = 0;
  const shell = el('select', { id: 'cmdShell', class: 'cmd-shell', 'aria-label': 'Shell' },
    el('option', { value: 'powershell' }, 'PowerShell'), el('option', { value: 'cmd' }, 'Command Prompt'));
  shell.value = store.get('beam.commands.shell') === 'cmd' ? 'cmd' : 'powershell';
  const text = el('textarea', { id: 'cmdText', class: 'cmd-text', rows: '3', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', 'aria-label': 'Command' });
  const placeholder = () => {
    text.placeholder = shell.value === 'cmd' ? 'ipconfig /all' : 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 5';
  };
  placeholder();
  shell.addEventListener('change', () => { store.set('beam.commands.shell', shell.value); placeholder(); cmdButtons(); });
  text.addEventListener('keydown', e => {
    // Enter runs; Shift+Enter is a new line (PowerShell only: Command Prompt takes one line).
    if (e.key === 'Enter' && !e.isComposing && (!e.shiftKey || shell.value === 'cmd')) { e.preventDefault(); cmdRun(); }
  });
  text.addEventListener('input', cmdButtons);
  const run = el('button', { id: 'cmdRunBtn', class: 'btn primary', type: 'button', onclick: () => cmdRun() }, icon('play'), 'Run');
  const stop = el('button', { id: 'cmdStopBtn', class: 'btn danger', type: 'button', hidden: true, onclick: () => cmdStop() }, icon('x'), 'Stop');
  const copy = el('button', { class: 'btn ghost', type: 'button', onclick: () => cmdCopy() }, icon('copy'), 'Copy');
  const clear = el('button', { id: 'cmdClearBtn', class: 'btn ghost', type: 'button', onclick: () => cmdClear() }, 'Clear');
  openDialog({
    title: `Run a command on ${d.name}`,
    className: 'cmd-dlg',
    wide: true,
    body: [
      el('p', { class: 'muted small cmd-who' }, `It runs on ${d.name} as its signed-in user, never as administrator. What it prints shows here.`),
      el('div', { class: 'cmd-input' }, el('div', { class: 'cmd-bar' }, shell, run, stop), text),
      el('div', { class: 'cmd-status-row' }, el('span', { id: 'cmdStatus', class: 'cmd-status muted small', role: 'status', 'aria-live': 'polite' }), el('span', { class: 'cmd-tools' }, copy, clear)),
      el('pre', { id: 'cmdOut', class: 'logs cmd-out', tabindex: '0', 'aria-label': 'Output', hidden: true }),
      el('div', { id: 'cmdRecent', class: 'cmd-recent' }),
    ],
    onClose: how => {
      cmdLeave();
      if (cmdView.page && how !== 'replaced') leaveCommandsPage();
    },
  });
  cmdView.dlgGen = dialogGen; // (never dlg.dataset.device: a device update would redraw Device info over the panel)
  cmdRenderRecent();
  cmdButtons();
  text.focus();
}

// The panel closes (or its page goes): what still runs is stopped, the ticker ends.
function cmdLeave() {
  const run = cmdView.run;
  cmdView.run = null;
  clearInterval(cmdView.ticker);
  cmdView.ticker = null;
  if (run && run.state !== 'ended') {
    run.left = true;
    if (run.id) api(`api/commands/${encodeURIComponent(run.id)}/stop`, { ...jsonBody({}), keepalive: true }).catch(() => {});
    run.ctrl.abort();
  }
}

function cmdButtons() {
  if (!commandsOpen()) return;
  const busy = Boolean(cmdView.run && cmdView.run.state !== 'ended');
  $('#cmdRunBtn').hidden = busy;
  $('#cmdStopBtn').hidden = !busy;
  $('#cmdRunBtn').disabled = !$('#cmdText').value.trim();
  $('#cmdShell').disabled = busy;
  $('#cmdClearBtn').disabled = busy || !$('#cmdOut').textContent;
}

function cmdStatus(text, cls = '') {
  if (!commandsOpen()) return;
  const s = $('#cmdStatus');
  s.textContent = text;
  s.className = `cmd-status small ${cls || 'muted'}`;
}

function cmdRenderRecent() {
  if (!commandsOpen()) return;
  const d = cmdView.device;
  const list = cmdRecent(d);
  const box = $('#cmdRecent');
  if (!list.length) return void box.replaceChildren();
  box.replaceChildren(
    el('div', { class: 'cmd-recent-head' }, el('span', { class: 'muted small' }, 'Recent here'),
      el('button', { class: 'btn ghost small', type: 'button', onclick: () => { store.remove(cmdRecentKey(d)); cmdRenderRecent(); } }, 'Forget them')),
    el('ul', { class: 'cmd-recent-list' }, list.map(x => el('li', {},
      el('button', { class: 'cmd-recent-item', type: 'button', title: x.text, onclick: () => {
        if (cmdView.run && cmdView.run.state !== 'ended') return;
        $('#cmdShell').value = x.shell;
        $('#cmdText').value = x.text;
        $('#cmdText').focus();
        cmdButtons();
      } }, el('span', { class: 'cmd-recent-shell' }, x.shell === 'cmd' ? 'cmd' : 'PS'), el('code', {}, x.text.split('\n')[0].slice(0, 200))))))
  );
}

// Output, on screen: stderr in its own colour; the oldest goes past CMD_SHOWN_MAX.
function cmdAppend(text, cls = '') {
  if (!commandsOpen() || !text) return;
  const out = $('#cmdOut');
  out.hidden = false;
  const stick = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  const last = out.lastChild;
  if (last && last.nodeType === 1 && last.className === cls && !cls.includes('cmd-head')) last.textContent += text;
  else out.append(cls ? el('span', { class: cls }, text) : el('span', {}, text));
  cmdView.shownChars += text.length;
  while (cmdView.shownChars > CMD_SHOWN_MAX && out.firstChild && out.childNodes.length > 1) {
    cmdView.shownChars -= out.firstChild.textContent.length;
    out.firstChild.remove();
  }
  if (stick) out.scrollTop = out.scrollHeight;
  cmdButtons();
}

async function cmdRun() {
  if (!commandsOpen() || (cmdView.run && cmdView.run.state !== 'ended')) return;
  const d = cmdView.device;
  const shell = $('#cmdShell').value === 'cmd' ? 'cmd' : 'powershell';
  const command = $('#cmdText').value;
  if (!command.trim()) return;
  if (shell === 'cmd' && command.trim().includes('\n')) return cmdStatus('Command Prompt takes one line: chain commands with &, or pick PowerShell for more lines.', 'err');
  cmdRemember(d, shell, shell === 'cmd' ? command.trim() : command);
  cmdRenderRecent();
  const out = $('#cmdOut');
  if (out.textContent && !out.textContent.endsWith('\n')) cmdAppend('\n');
  cmdAppend(`${shell === 'cmd' ? '>' : 'PS>'} ${command.trim().split('\n')[0]}${command.trim().includes('\n') ? ' …' : ''}\n`, 'cmd-head');
  const run = { id: null, seq: 0, ctrl: new AbortController(), state: 'asking', at: Date.now(), runningAt: 0, end: null, left: false };
  cmdView.run = run;
  cmdButtons();
  cmdStatus(`Asking ${d.name}…`);
  clearInterval(cmdView.ticker);
  cmdView.ticker = setInterval(() => cmdTick(run), 1000);
  try {
    const res = await api(`api/devices/${encodeURIComponent(d.id)}/commands`, { ...jsonBody({ shell, command }), signal: run.ctrl.signal });
    await cmdRead(run, res);
  } catch (err) {
    if (run.left) return;
    if (run.id && err.name !== 'AbortError') return void cmdReattach(run);
    cmdFinish(run, { error: friendlyError(err) });
  }
}

function cmdTick(run) {
  if (run !== cmdView.run || run.state !== 'running') return;
  cmdStatus(`Running on ${cmdView.device.name} · ${formatDuration((Date.now() - run.runningAt) / 1000)}`);
}

// Reads the command's stream to its end (or until the connection drops: then it's picked up again).
async function cmdRead(run, res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        // (split on \n only, as EventSource does: U+2028 in the JSON is no line break)
        const lines = block.split('\n');
        const event = lines.find(l => l.startsWith('event: '))?.slice(7);
        const data = lines.find(l => l.startsWith('data: '))?.slice(6);
        if (event) cmdEvent(run, event, data ? JSON.parse(data) : {});
      }
    }
  } catch (err) {
    if (run.left || err.name === 'AbortError') return;
  }
  if (run.state !== 'ended' && !run.left) await cmdReattach(run);
}

function cmdEvent(run, event, data) {
  if (Number.isSafeInteger(data.seq) && data.seq > run.seq) run.seq = data.seq;
  const name = cmdView.device?.name || 'the PC';
  if (event === 'start') {
    run.id = data.id;
    run.state = 'waiting';
    if (run === cmdView.run) cmdStatus(`Waiting for ${name}…`);
  } else if (event === 'running') {
    run.state = 'running';
    run.runningAt = Date.now();
    if (run === cmdView.run) cmdTick(run);
  } else if (event === 'out' && Array.isArray(data.out)) {
    if (run !== cmdView.run) return;
    for (const part of data.out) if (part && typeof part.t === 'string') cmdAppend(part.t, part.s === 'e' ? 'cmd-err' : '');
  } else if (event === 'gap') {
    if (run === cmdView.run) cmdAppend('\n[Some of the output came while this page was away and is missing here.]\n', 'cmd-note');
  } else if (event === 'end') {
    cmdFinish(run, data);
  }
}

function cmdFinish(run, end) {
  if (run.state === 'ended') return;
  run.state = 'ended';
  run.end = end;
  if (run !== cmdView.run) return;
  clearInterval(cmdView.ticker);
  cmdView.ticker = null;
  const took = Number.isFinite(end.ms) ? ` · ${cmdTook(end.ms)}` : '';
  if (end.error) cmdStatus(end.error, 'err');
  else if (end.stopped) cmdStatus(`Stopped${end.code != null ? ` (exit code ${end.code})` : ''}${took}`);
  else cmdStatus(`Exit code ${end.code ?? 'unknown'}${took}${end.cut ? ' · the output was cut' : ''}`, end.code === 0 ? 'muted' : 'err');
  const out = $('#cmdOut');
  if (out && out.textContent && !out.textContent.endsWith('\n')) cmdAppend('\n');
  cmdButtons();
  if (commandsOpen()) $('#cmdText').focus();
}

// The connection dropped before the end: the server holds the last of the output for a minute.
async function cmdReattach(run) {
  const until = Date.now() + 50_000;
  let wait = 500;
  while (run === cmdView.run && run.state !== 'ended' && !run.left && Date.now() < until) {
    cmdStatus('The connection dropped: picking the command up again…');
    await sleep(wait);
    wait = Math.min(wait * 2, 5000);
    if (run !== cmdView.run || run.left) return;
    try {
      const res = await api(`api/commands/${encodeURIComponent(run.id)}?from=${run.seq}`, { signal: run.ctrl.signal });
      return cmdRead(run, res);
    } catch (err) {
      if (run.left || err.name === 'AbortError') return;
      if (err.status === 404) return cmdFinish(run, { error: 'The command is gone here: it ended, or was stopped, while this page was away.' });
    }
  }
  if (run === cmdView.run && run.state !== 'ended' && !run.left) cmdFinish(run, { error: 'Lost the connection to Beam. A command that was still running is stopped within a minute.' });
}

async function cmdStop() {
  const run = cmdView.run;
  if (!run || run.state === 'ended') return;
  if (!run.id) { run.left = true; run.ctrl.abort(); return cmdFinish(run, { error: 'Cancelled.' }); }
  cmdStatus('Stopping…');
  try { await api(`api/commands/${encodeURIComponent(run.id)}/stop`, jsonBody({})); }
  catch (err) { if (err.status !== 404) toast(friendlyError(err), { error: true }); }
}

async function cmdCopy() {
  const text = $('#cmdOut')?.textContent || '';
  if (!text) return toast('Nothing to copy yet');
  try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copying didn’t work here: select the text instead', { error: true }); }
}

function cmdClear() {
  if (cmdView.run && cmdView.run.state !== 'ended') return;
  const out = $('#cmdOut');
  out.replaceChildren();
  out.hidden = true;
  cmdView.shownChars = 0;
  cmdStatus('');
  cmdButtons();
}

// ---------------------------------------------------------------- the page of its own (#commands=<PC id>)

async function startCommandsPage(id) {
  document.documentElement.classList.add('files-mode', 'commands-mode');
  const stored = store.get('beam.deviceId');
  me.id = DEVICE_ID.test(stored || '') ? stored : randomId(12);
  me.name = cleanName(store.get('beam.device')) || defaultName();
  onUnauthorized = () => commandsPageSays('Run a command', 'This page isn’t signed in any more: close it and open it again.');
  onMoved = () => commandsPageSays('Run a command', 'Beam has moved to another address: close this and open it again from the app.');
  adoptIdentity = you => { if (DEVICE_ID.test(you || '')) me.id = you; return false; };
  bindDialogs();
  window.addEventListener('hashchange', () => location.reload());
  window.addEventListener('pagehide', () => cmdLeave()); // (the app closing its screen: what runs is stopped)
  let d;
  try {
    const [info, list, settings] = await Promise.all([apiJson('api/info'), apiJson('api/devices'), apiJson('api/settings').catch(() => null)]);
    server.features = new Set(info.features || []);
    server.api = info.api || 2;
    if (DEVICE_ID.test(list.you || '')) me.id = list.you;
    const mine = (list.devices || []).find(x => x.id === me.id);
    if (typeof applyLook === 'function') applyLook(mine?.settings?.appearance || settings?.appearance || null);
    d = (list.devices || []).find(x => x.id === id);
  } catch (err) {
    if (err.status !== 401) commandsPageSays('Run a command', friendlyError(err));
    return;
  }
  if (!d) return commandsPageSays('Run a command', 'That PC isn’t one of this Beam’s devices any more.');
  if (!canRunCommandsOn(d)) {
    return commandsPageSays(d.name, !d.online ? `${d.name} is offline: commands can run there once it’s back.`
      : !serverHas('commands') ? 'This Beam can’t run commands on PCs yet (that needs Beam 1.32).'
        : commandsOffNote(d) || `${d.name} doesn’t run commands from here (that needs Beam for Windows 1.25 with remote control and “Allow commands too” on at that PC, and this device on its list).`);
  }
  openCommands(d, { page: true });
}

function commandsPageSays(title, text) {
  cmdView.page = true;
  const close = el('button', { class: 'btn primary', type: 'button', onclick: () => $('#genDlg').close() }, 'Close');
  openDialog({ title, body: [el('p', {}, text)], buttons: [close], onClose: how => { if (how !== 'replaced') leaveCommandsPage(); } });
}

function leaveCommandsPage() {
  location.replace(BASE.pathname);
}

// Back (the Android app's back button): what runs is stopped as the screen closes; false: the app closes it.
function commandsBack() {
  cmdLeave();
  return false;
}
