// ---------------------------------------------------------------- shared folders (Beam 1.26, Beam for Windows 1.18)
// A PC's folders shared with this device, chosen only at that PC (Settings → This PC → Shared folders…: the folders, and
// for each the devices that see it): look in them here and copy files over. The PC sends what's ticked the way it sends
// anything, so the files arrive in its conversation with this device (and a Beam app saves them as it saves anything).
// Each look is a fresh question through the server (POST /api/devices/{id}/files, …/files/copy); nothing is kept. The
// user: "being able to browser folders on other devices, like from my laptop, look at my desktops downloads folder and
// then copy from that to my laptop", "maybe being able to choose which folders to share with what devices".

const sharedView = { gen: 0, dlgGen: -1, device: null, share: null, name: '', path: '', entries: [], more: false, picked: new Set(), filter: '' };

const canBrowseShared = d => Boolean(d?.can?.files) && d.online && d.id !== me.id && serverHas('shared-folders');

// The folders a PC shares with this device (straight into the folder when there's only one).
async function openSharedFolders(d) {
  Object.assign(sharedView, { device: d, share: null, name: '', path: '', entries: [], more: false, picked: new Set(), filter: '' });
  const gen = ++sharedView.gen;
  toast(`Asking ${d.name} what it shares with this device…`, { ms: 3000 });
  let r;
  try { r = await apiJson(`api/devices/${encodeURIComponent(d.id)}/files`, jsonBody({})); } catch (err) { toast(friendlyError(err), { error: true }); return; }
  if (gen !== sharedView.gen) return;
  const shares = r.shares || [];
  if (shares.length === 1) return openSharedFolder(shares[0].id, '');
  openDialog({
    title: `${d.name}: shared folders`,
    className: 'shared-dlg',
    body: shares.length
      ? [note(`The folders ${d.name} shares with this device. Open one, tick files and copy them here.`),
        el('div', { class: 'shared-list', role: 'list' }, ...shares.map(s => el('button', { class: 'shared-row dir', type: 'button', onclick: () => openSharedFolder(s.id, '') },
          icon('folder'), el('span', { class: 'shared-name' }, s.name))))]
      : [note(`Nothing on ${d.name} is shared with this device. At ${d.name}: Settings → This PC → Shared folders…, add a folder and tick ${me.name || 'this device'}.`)],
  });
  sharedView.dlgGen = dialogGen;
}

// One folder: `path` inside the shared one, its steps joined with /.
async function openSharedFolder(share, path) {
  const v = sharedView, d = v.device;
  const gen = ++v.gen;
  let r;
  try { r = await apiJson(`api/devices/${encodeURIComponent(d.id)}/files`, jsonBody({ share, path })); } catch (err) { toast(friendlyError(err), { error: true }); return; }
  if (gen !== v.gen) return;
  Object.assign(v, { share, name: r.name || 'Shared folder', path: r.path ?? path, entries: r.entries || [], more: Boolean(r.more), picked: new Set(), filter: '' });
  renderSharedFolder();
}

function renderSharedFolder() {
  const v = sharedView, d = v.device;
  const steps = v.path ? v.path.split('/') : [];
  const go = p => () => openSharedFolder(v.share, p);
  const crumbs = el('nav', { class: 'shared-crumbs', 'aria-label': 'Where' },
    steps.length ? el('button', { class: 'linkish', type: 'button', onclick: go('') }, v.name) : el('b', {}, v.name),
    ...steps.flatMap((s, i) => [el('span', { class: 'muted', 'aria-hidden': 'true' }, ' / '),
      i === steps.length - 1 ? el('b', {}, s) : el('button', { class: 'linkish', type: 'button', onclick: go(steps.slice(0, i + 1).join('/')) }, s)]));
  const filter = el('input', { type: 'search', class: 'shared-filter', placeholder: 'Show only names with…', 'aria-label': 'Show only names with', value: v.filter });
  const list = el('div', { class: 'shared-list', role: 'list' });
  const copyLabel = el('span', {}, 'Copy to this device');
  const copyBtn = el('button', { class: 'btn primary shared-copy', type: 'button', onclick: copySharedPicked }, icon('download'), copyLabel);
  const count = () => {
    copyBtn.disabled = !v.picked.size;
    copyLabel.textContent = v.picked.size ? `Copy ${plural(v.picked.size, 'file')} to this device` : 'Copy to this device';
  };
  const drawList = () => {
    const q = v.filter.trim().toLowerCase();
    const shown = v.entries.filter(e => !q || e.n.toLowerCase().includes(q));
    const rows = [];
    if (steps.length) rows.push(el('button', { class: 'shared-row dir up', type: 'button', onclick: go(steps.slice(0, -1).join('/')) }, icon('up'), el('span', { class: 'shared-name' }, 'Up')));
    for (const e of shown) {
      const when = el('span', { class: 'shared-when muted small' }, e.m ? historyWhen(e.m) : '');
      if (e.dir) {
        rows.push(el('button', { class: 'shared-row dir', type: 'button', onclick: go([...steps, e.n].join('/')) }, icon('folder'), el('span', { class: 'shared-name' }, e.n), el('span', { class: 'shared-size' }), when));
        continue;
      }
      const box = el('input', { type: 'checkbox', 'aria-label': `Copy ${e.n}` });
      box.checked = v.picked.has(e.n);
      box.onchange = () => { if (box.checked) v.picked.add(e.n); else v.picked.delete(e.n); count(); };
      rows.push(el('label', { class: 'shared-row file' }, box, el('span', { class: 'shared-name' }, e.n), el('span', { class: 'shared-size muted small' }, formatSize(e.s)), when));
    }
    if (!shown.length) rows.push(note(v.entries.length ? 'Nothing here has those letters in its name.' : 'This folder is empty (or holds only what Beam doesn’t show: hidden files, names starting with “.”, links).'));
    if (v.more) rows.push(note(`Only the first ${v.entries.length.toLocaleString()} are listed: the filter looks among them.`));
    list.replaceChildren(...rows);
  };
  filter.oninput = () => { v.filter = filter.value; drawList(); };
  drawList();
  count();
  const title = `${d.name}: ${steps.length ? steps[steps.length - 1] : v.name}`;
  const body = [crumbs, filter, list];
  if ($('#genDlg').open && dialogGen === v.dlgGen) {
    $('#genTitle').textContent = title;
    $('#genBody').replaceChildren(...body);
    $('#genFoot').replaceChildren(copyBtn);
    $('#genFoot').hidden = false;
  } else {
    openDialog({ title, className: 'shared-dlg', wide: true, body, buttons: [copyBtn] });
    v.dlgGen = dialogGen;
  }
}

// The ticked files: the PC sends them to this device (an ordinary send from it).
async function copySharedPicked() {
  const v = sharedView, d = v.device;
  const names = [...v.picked];
  if (!names.length) return;
  let r;
  try { r = await apiJson(`api/devices/${encodeURIComponent(d.id)}/files/copy`, jsonBody({ share: v.share, path: v.path, names })); } catch (err) { toast(friendlyError(err), { error: true }); return; }
  const n = r.sending || 0, skipped = r.skipped || [];
  const left = skipped.length ? `${n ? ' (' : ': '}left out: ${skipped.map(s => `${s.n} (${s.why})`).join(', ')}${n ? ')' : ''}` : '';
  toast(n ? `${d.name} is sending ${plural(n, 'file')}: they arrive in your conversation with it${left}.` : `${d.name} sent nothing${left}.`, { ms: 6000, error: !n });
  v.picked.clear();
  renderSharedFolder();
}

// This PC (host mode, Beam for Windows 1.18): the folders shared from here and who sees each (chosen only in the app's own
// window: Shared folders…).
function sharedPcRows(s) {
  if (!Array.isArray(s?.sharedFolders)) return [];
  const list = s.sharedFolders;
  return [
    el('h4', {}, 'Shared folders'),
    el('div', { class: 'field' },
      el('p', { class: 'small' }, list.length
        ? 'The devices ticked for a folder can look in it and copy files from it, nothing else on this PC; they can’t change anything here.'
        : 'Nothing is shared: your other devices can’t see this PC’s files.'),
      ...list.map(f => el('p', { class: 'small' }, el('b', {}, f.name), ` (${f.path}): ${f.devices?.length ? f.devices.join(', ') : 'no device yet'}`)),
      hostHas('sharedFolders') && el('div', { class: 'dev-actions' }, el('button', { class: 'btn small-btn', type: 'button', onclick: async () => {
        const r = await hostDo('sharedFolders');
        if (r?.settings) { hostState.settings = r.settings; renderSettings(); }
      } }, icon('folder'), 'Shared folders…'))),
  ];
}
