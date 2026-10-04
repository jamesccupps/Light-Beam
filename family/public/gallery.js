// A conversation's photos, videos and files (1.11.0; the user: "gallery select"): newest first, more as you scroll; a
// tap opens one (the viewer) or downloads it; Select picks several to download or delete together. A file goes with its
// message, so deleting one deletes its whole message (only one's own, unless an admin), after asking.
import { h, fill, icon, toast, confirmDialog, formatSize, whenShort } from './ui.js';
import { api } from './api.js';
import { state, person, isAdmin } from './store.js';
import { downloadFile, downloadFiles } from './downloads.js';
import { nav } from './nav.js';

const isMedia = f => /^(image|video)\//.test(f.mime);

export function galleryPanel(bodyEl, channelId, offs) {
  let kind = 'media';
  let items = [];
  let next = null;
  let loading = false;
  let selecting = false;
  let seq = 0;
  const chosen = new Set();
  const tabs = h('div', { class: 'gal-tabs', role: 'tablist' });
  const tools = h('div', { class: 'gal-tools' });
  const list = h('div', { class: 'gal-list' });
  const end = h('p', { class: 'muted small gal-end' });
  fill(bodyEl, tabs, tools, list, end);
  // (the next page once the end comes into view)
  const watch = new IntersectionObserver(seen => { if (seen.some(e => e.isIntersecting) && next && !loading) load(); }, { root: bodyEl, rootMargin: '300px' });
  watch.observe(end);
  offs.push(() => watch.disconnect());

  async function load(reset = false) {
    const mine = reset ? ++seq : seq;
    if (reset) { items = []; next = null; chosen.clear(); }
    loading = true;
    end.textContent = 'Loading…';
    try {
      const r = await api(`/api/channels/${channelId}/files?kind=${kind}${!reset && next ? `&before=${next}` : ''}`);
      if (mine !== seq) return;
      items = items.concat(r.files);
      next = r.next;
    } catch (err) {
      if (mine === seq) toast(err.message, { error: true });
    } finally {
      if (mine === seq) loading = false;
    }
    render();
  }

  function render() {
    fill(tabs, ...[['media', 'Photos & videos'], ['other', 'Files']].map(([k, label]) =>
      h('button', { type: 'button', role: 'tab', class: `gal-tab${k === kind ? ' on' : ''}`, 'aria-selected': String(k === kind), onclick: () => { if (k !== kind) { kind = k; selecting = false; load(true); } } }, label)));
    if (selecting) {
      const n = chosen.size;
      fill(tools, h('span', { class: 'grow' }, n ? `${n} selected` : 'Tap to select'),
        h('button', { type: 'button', class: 'btn', disabled: !n, onclick: downloadChosen }, icon('download'), 'Download'),
        h('button', { type: 'button', class: 'btn danger', disabled: !n, onclick: deleteChosen }, icon('trash'), 'Delete'),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => { selecting = false; chosen.clear(); render(); } }, 'Cancel'));
    } else {
      fill(tools, h('span', { class: 'grow muted small' }, items.length ? `${items.length}${next ? '+' : ''} ${kind === 'media' ? 'photos and videos' : `file${items.length === 1 ? '' : 's'}`}` : ''),
        items.length ? h('button', { type: 'button', class: 'btn', onclick: () => { selecting = true; render(); } }, icon('check'), 'Select') : null);
    }
    list.className = `gal-list ${kind}`;
    fill(list, ...items.map(f => (kind === 'media' ? tile(f) : row(f))));
    end.textContent = loading ? 'Loading…' : items.length ? (next ? '' : 'That’s everything.') : kind === 'media' ? 'No photos or videos here yet.' : 'No files here yet.';
  }

  function tap(f) {
    if (selecting) {
      if (chosen.has(f.id)) chosen.delete(f.id); else chosen.add(f.id);
      return render();
    }
    if (isMedia(f)) {
      const media = items.filter(isMedia);
      return nav.viewer(media, media.indexOf(f));
    }
    downloadFile(f);
  }

  function tile(f) {
    const src = f.thumb || (f.mime.startsWith('image/') ? f.url : null);
    return h('button', { type: 'button', class: `gal-tile${chosen.has(f.id) ? ' chosen' : ''}`, title: f.name, 'aria-pressed': selecting ? String(chosen.has(f.id)) : null, onclick: () => tap(f) },
      src ? h('img', { src, alt: f.name, loading: 'lazy', decoding: 'async' }) : h('span', { class: 'gal-name' }, f.name),
      f.mime.startsWith('video/') ? h('span', { class: 'play' }, icon('play', 'i')) : null,
      selecting ? h('span', { class: 'gal-check' }, icon('check', 'i')) : null);
  }

  function row(f) {
    return h('button', { type: 'button', class: `gal-file${chosen.has(f.id) ? ' chosen' : ''}`, 'aria-pressed': selecting ? String(chosen.has(f.id)) : null, onclick: () => tap(f) },
      selecting ? h('span', { class: 'gal-check' }, icon('check', 'i')) : icon('file', 'i big'),
      h('span', { class: 'meta' }, h('strong', {}, f.name), h('span', { class: 'muted small' }, `${formatSize(f.size)} · ${person(f.author).name} · ${whenShort(f.at)}`)));
  }

  const picked = () => items.filter(f => chosen.has(f.id));

  function downloadChosen() {
    downloadFiles(picked());
    selecting = false;
    chosen.clear();
    render();
  }

  async function deleteChosen() {
    const messages = [...new Set(picked().map(f => f.message))];
    const allowed = messages.filter(id => isAdmin() || items.find(f => f.message === id)?.author === state.me.id);
    if (!allowed.length) return toast('You can only delete your own messages', { error: true });
    const skipped = messages.length - allowed.length;
    const ok = await confirmDialog({
      title: `Delete ${allowed.length === 1 ? 'this message' : `these ${allowed.length} messages`}?`,
      text: `A file goes with its message: ${allowed.length === 1 ? 'its text and every file in it go' : 'their text and every file in them go'} too, for everyone.${skipped ? ` (${skipped} of them ${skipped === 1 ? 'isn’t' : 'aren’t'} yours: ${skipped === 1 ? 'it stays' : 'they stay'}.)` : ''}`,
      ok: 'Delete', danger: true,
    });
    if (!ok) return;
    let failed = 0;
    for (const id of allowed) {
      try { await api(`/api/messages/${id}`, { method: 'DELETE' }); } catch { failed++; }
    }
    if (failed) toast(`${failed} couldn’t be deleted`, { error: true });
    selecting = false;
    load(true);
  }

  render();
  load(true);
}
