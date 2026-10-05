// Fast links in the app (1.9.0; the user: "we need a temporary fastlink too"; "there should be a way to send a fast link
// from a file thats already in the chat"; "could that link be sent for a file on a phone?"): "Fast link" on a file in
// the chat (its message's menu, the viewer), and "Make a fast link" for a file on this device (it uploads, and the link
// works at once, following it as it comes). Anyone with a link can download the file without signing in, until it
// runs out or is switched off.
import { h, fill, toast, copyText, formatSize, whenShort } from './ui.js';
import { api } from './api.js';
import { upload, busy, sendingFiles } from './uploads.js';

const HOW_LONG = [[1, 'An hour'], [24, 'A day'], [24 * 7, 'A week']];
// (1.15.0) How many downloads before it stops (none: until it runs out), and whether a photo or video goes without where
// it was taken (the server makes a copy: JPEG and PNG photos, and videos where it has ffmpeg).
const HOW_MANY = [[0, 'No limit'], [1, 'One download'], [3, '3 downloads'], [10, '10 downloads']];
const mayLoseLocation = f => /^(image\/(jpeg|png)|video\/)/i.test(f.mime || '') || /\.(jpe?g|png|mp4|m4v|mov|3gp|mkv|webm)$/i.test(f.name || '');

// The sheet for one file: how long, then the link to copy or share; the file's other working links (switch off).
// `item`: an upload of this device's still going (its progress shows here).
export function fastLink(file, { item = null } = {}) {
  let hours = 24;
  let maxDownloads = 0;
  let removeLocation = false;
  const dlg = h('dialog', { class: 'dlg fastlink' });
  const progress = h('p', { class: 'muted small fl-progress', hidden: !item });
  const others = h('div', { class: 'fl-others' });
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener('cancel', e => { e.preventDefault(); close(); });
  const head = [h('h2', {}, 'Fast link'), h('p', { class: 'fl-file' }, h('strong', {}, file.name), ` · ${formatSize(file.size)}`)];

  const choose = () => fill(dlg, h('form', { method: 'dialog', onsubmit: e => { e.preventDefault(); make(); } }, ...head,
    h('p', { class: 'muted small' }, 'Anyone with the link can download it, without signing in, until it runs out. Fast: it comes straight from this computer when it can.'),
    h('fieldset', { class: 'fl-hours' }, h('legend', { class: 'small' }, 'How long it works'),
      ...HOW_LONG.map(([n, label]) => h('label', { class: 'fl-choice' },
        h('input', { type: 'radio', name: 'hours', value: String(n), checked: n === hours, onchange: () => { hours = n; } }), ` ${label}`))),
    h('label', { class: 'fl-limit small' }, 'Stop after ',
      h('select', { class: 'input', 'aria-label': 'How many downloads', onchange: e => { maxDownloads = Number(e.target.value); } },
        ...HOW_MANY.map(([n, label]) => h('option', { value: String(n), selected: n === maxDownloads }, label)))),
    mayLoseLocation(file) && !item ? h('label', { class: 'fl-choice fl-location small' },
      h('input', { type: 'checkbox', checked: removeLocation, onchange: e => { removeLocation = e.target.checked; } }),
      ' Take out where it was taken (location data) and the camera’s other notes') : null,
    progress, others,
    h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Close'), h('button', { class: 'btn primary', type: 'submit' }, 'Make the link'))));

  async function make() {
    let link;
    try {
      ({ link } = await api(`/api/files/${file.id}/links`, { method: 'POST', body: { hours, maxDownloads, removeLocation } }));
    } catch (err) {
      toast(err.message, { error: true });
      return;
    }
    const box = h('input', { class: 'input fl-url', readOnly: true, value: link.url, 'aria-label': 'The link', onfocus: e => e.target.select() });
    fill(dlg, h('div', {}, ...head,
      h('p', { class: 'muted small' }, `It works until ${new Date(link.expires).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}${link.maxDownloads ? ` or ${link.maxDownloads === 1 ? 'one download' : `${link.maxDownloads} downloads`}` : ''}, for anyone who has it${link.removeLocation ? ', without its location data' : ''}. Send it however you like.`),
      box,
      h('div', { class: 'actions fl-share' },
        navigator.share ? h('button', { class: 'btn', type: 'button', onclick: () => navigator.share({ title: file.name, url: link.url }).catch(() => {}) }, 'Share') : null,
        h('button', { class: 'btn primary', type: 'button', onclick: () => copyText(link.url, 'Link copied') }, 'Copy')),
      progress, others,
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Done'))));
    copyText(link.url, 'Link made and copied');
    listOthers();
  }

  // The file's links still working (switch off): the person's own, or everyone's for an admin.
  async function listOthers() {
    try {
      const { links } = await api(`/api/files/${file.id}/links`);
      fill(others, links.length ? h('p', { class: 'small fl-others-title' }, `Working links for this file: ${links.length}`) : null,
        ...links.map(l => h('div', { class: 'fl-other small' },
          h('span', { class: 'muted' }, `${l.byName} · until ${whenShort(l.expires)} · downloaded ${l.downloads}×${l.maxDownloads ? ` of ${l.maxDownloads}` : ''}${l.removeLocation ? ' · without location data' : ''}`),
          h('button', { class: 'btn small ghost', type: 'button', onclick: async () => {
            try { await api(`/api/links/${l.id}`, { method: 'DELETE' }); toast('That link doesn’t work any more'); listOthers(); } catch (err) { toast(err.message, { error: true }); }
          } }, 'Switch off'))));
    } catch {}
  }

  // How far this device's upload is (the link follows it as it comes).
  const show = () => {
    if (!item) return;
    const sent = Math.min(item.offset || 0, file.size);
    progress.hidden = false;
    progress.textContent = item.done
      ? 'All uploaded: the link has it all.'
      : item.failed ? 'The upload stopped. Open Beam Family again and pick the same file to go on.'
        : `Uploading ${formatSize(sent)} of ${formatSize(file.size)} (${Math.floor(sent / file.size * 100)}%)${item.via === 'direct' ? ' straight to the server' : ''} · keep this page open · the link works already`;
  };

  choose();
  show();
  listOthers();
  document.body.append(dlg);
  dlg.showModal();
  return { show };
}

// "Make a fast link": a file on this device. It uploads (not into a conversation) and the link can be made at once.
export function makeFastLink() {
  const input = h('input', { type: 'file', hidden: true });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    const item = { key: Math.random().toString(36).slice(2), file, progress: 0, offset: 0, abort: new AbortController() };
    try {
      const started = await api('/api/uploads', { method: 'POST', body: { name: file.name, size: file.size, mime: file.type } });
      item.id = started.id;
      item.offset = started.offset;
      busy.add(item.id);
    } catch (err) {
      toast(err.message, { error: true });
      return;
    }
    const sheet = fastLink({ id: item.id, name: file.name, size: file.size }, { item });
    sendingFiles(1);
    upload(item, () => sheet.show(), item.abort.signal)
      .then(() => { busy.delete(item.id); sheet.show(); toast(`${file.name} is all uploaded`); })
      .catch(err => { item.failed = true; sheet.show(); if (err.name !== 'AbortError') toast(`${file.name}: ${err.message}`, { error: true }); })
      .finally(() => sendingFiles(-1));
  });
  document.body.append(input);
  input.click();
}
