// The other screens: signing in, joining with an invite, settings, people & channels (admins), the side panels
// (people, pinned messages, search), the picture viewer, and starting a conversation.

import { h, fill, icon, iconBtn, avatar, menu, dialog, confirmDialog, field, toast, copyText, whenShort, fullTime } from './ui.js';
import { api } from './api.js';
import { state, on, person, channel, title, isAdmin } from './store.js';
import { renderBody } from './text.js';
import { pushState, enablePush, disablePush, isIos } from './notify.js';
import { nav } from './nav.js';
import { fastLink } from './fastlinks.js';

// ---------------------------------------------------------------- signing in and joining

function page(...content) {
  return h('div', { class: 'page' }, h('div', { class: 'card' }, h('img', { class: 'logo', src: '/icon.svg', alt: '' }), ...content));
}

export function signInPage(session, onDone) {
  const name = h('input', { class: 'input', name: 'name', autocomplete: 'username', required: true, autocapitalize: 'words' });
  const password = h('input', { class: 'input', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const error = h('p', { class: 'error-text', hidden: true });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
  const form = h('form', {
    onsubmit: async e => {
      e.preventDefault();
      btn.disabled = true;
      error.hidden = true;
      try {
        await api('/api/signin', { method: 'POST', body: { name: name.value.trim(), password: password.value } });
        onDone();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        btn.disabled = false;
        password.select();
      }
    },
  }, field('Your name', name), field('Password', password), error, btn);
  const spaceName = session.name || 'Beam Family';
  if (!session.ownerSetUp) {
    return page(h('h1', {}, 'Beam Family isn’t set up yet'),
      h('p', { class: 'lede' }, 'Whoever runs it opens it first over Tailscale, on their own device: it sets itself up for them. Then they can invite everyone.'));
  }
  if (session.disabled) return page(h('h1', {}, spaceName), h('p', { class: 'lede' }, 'Your access to this family space was turned off. Ask its owner if that’s a mistake.'));
  return page(h('h1', {}, spaceName),
    session.tailscale ? h('p', { class: 'note' }, `You’re on Tailscale as ${session.tailscale.login}, but not in ${spaceName} yet. Ask someone in the family for an invite link, and open it here.`)
      : h('p', { class: 'lede' }, `Sign in to ${spaceName}.`),
    session.tailscale ? h('p', { class: 'muted small' }, 'Joined with a password before? Sign in:') : null,
    form,
    h('p', { class: 'muted small', style: { marginTop: '16px' } }, 'New here? You need an invite link from someone in the family.'));
}

export async function joinPage(code, onDone) {
  let info;
  try {
    info = await api(`/api/invites/${encodeURIComponent(code)}`);
  } catch (err) {
    return page(h('h1', {}, 'This invite doesn’t work'), h('p', { class: 'lede' }, err.message), h('a', { class: 'btn', href: '/' }, 'Go to sign-in'));
  }
  if (info.signedIn) {
    return page(h('h1', {}, `You’re in ${info.space}`), h('p', { class: 'lede' }, `You’re already in, as ${info.signedIn.name}.`), h('a', { class: 'btn primary', href: '/' }, 'Open Beam Family'));
  }
  if (info.reset) return resetPage(code, info, onDone);
  const name = h('input', { class: 'input', name: 'name', required: true, maxlength: 32, autocomplete: 'nickname', autocapitalize: 'words', value: info.tailscale?.name || '' });
  const pw = h('input', { class: 'input', name: 'password', type: 'password', autocomplete: 'new-password', minlength: 10, required: info.needsPassword });
  const pw2 = h('input', { class: 'input', name: 'password2', type: 'password', autocomplete: 'new-password', minlength: 10, required: info.needsPassword });
  const error = h('p', { class: 'error-text', hidden: true });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, `Join ${info.space}`);
  const passwords = h('div', {}, field('Choose a password', pw), field('The password again', pw2));
  const optional = info.needsPassword ? null : h('details', {}, h('summary', { class: 'muted small' }, 'Also set a password, for when you’re not on Tailscale'), passwords);
  const form = h('form', {
    onsubmit: async e => {
      e.preventDefault();
      error.hidden = true;
      if (pw.value !== pw2.value) { error.textContent = 'The two passwords aren’t the same'; error.hidden = false; return; }
      btn.disabled = true;
      try {
        await api(`/api/invites/${encodeURIComponent(code)}`, { method: 'POST', body: { name: name.value.trim(), ...(pw.value ? { password: pw.value } : {}) } });
        onDone();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        btn.disabled = false;
      }
    },
  }, field('Your name, as the family will see it', name), info.needsPassword ? passwords : optional, error, btn);
  return page(h('h1', {}, `Join ${info.space}`),
    h('p', { class: 'lede' }, `${info.by ? `${info.by} invited you` : 'You’re invited'} to ${info.space}, the family’s own chat.`),
    info.tailscale ? h('p', { class: 'note' }, `You’re on Tailscale as ${info.tailscale.login}: on Tailscale you’ll be signed in by that, no password needed.`) : null,
    form);
}

// A password reset link from an admin: a new password, and signed in.
function resetPage(code, info, onDone) {
  const pw = h('input', { class: 'input', name: 'password', type: 'password', autocomplete: 'new-password', minlength: 10, required: true });
  const pw2 = h('input', { class: 'input', name: 'password2', type: 'password', autocomplete: 'new-password', minlength: 10, required: true });
  const error = h('p', { class: 'error-text', hidden: true });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Save the new password');
  const form = h('form', {
    onsubmit: async e => {
      e.preventDefault();
      error.hidden = true;
      if (pw.value !== pw2.value) { error.textContent = 'The two passwords aren’t the same'; error.hidden = false; return; }
      btn.disabled = true;
      try {
        await api(`/api/invites/${encodeURIComponent(code)}`, { method: 'POST', body: { password: pw.value } });
        onDone();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        btn.disabled = false;
      }
    },
  }, field('New password (at least 10 characters)', pw), field('The new password again', pw2), error, btn);
  return page(h('h1', {}, `A new password for ${info.name}`),
    h('p', { class: 'lede' }, `${info.by ? `${info.by} made this link` : 'This link is'} for ${info.name}: choose a new password to sign in to ${info.space} with. Browsers signed in with the old one are signed out.`),
    form);
}

// ---------------------------------------------------------------- settings

export function settingsView() {
  const offs = [];
  const body = h('div', { class: 'inner-page' });
  const view = h('section', { class: 'main', 'aria-label': 'Settings' },
    h('header', { class: 'conv-head' }, iconBtn('back', 'Back', () => nav.go('/'), { class: 'icon-btn back' }), h('div', { class: 'title' }, h('strong', {}, 'Settings'))), body);

  async function render() {
    const me = state.me;
    const colours = h('div', { class: 'row', role: 'radiogroup', 'aria-label': 'Colour' }, [...Array(8).keys()].map(i => h('button', {
      type: 'button', class: `avatar c${i}`, role: 'radio', 'aria-checked': String(me.color === i), 'aria-label': `Colour ${i + 1}`,
      style: { outline: me.color === i ? '3px solid var(--accent)' : 'none', outlineOffset: '2px', border: 0 },
      onclick: () => api('/api/me', { method: 'PATCH', body: { color: i } }).catch(err => toast(err.message, { error: true })),
    }, me.color === i ? icon('check') : '')));
    const nameInput = h('input', { class: 'input', value: me.name, maxlength: 32, 'aria-label': 'Your name' });
    const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: () => setAvatar(fileInput.files[0]) });
    const push = await pushState().catch(() => 'unsupported');
    const pushPart = {
      on: [h('p', {}, 'Notifications are on for this device.'), h('button', { class: 'btn', type: 'button', onclick: async () => { await disablePush(); toast('Notifications are off for this device'); render(); } }, 'Turn off')],
      off: [h('p', {}, 'Notifications are off for this device.'), h('button', { class: 'btn primary', type: 'button', onclick: async () => { try { await enablePush(); toast('Notifications are on for this device'); render(); } catch (err) { toast(err.message, { error: true }); } } }, 'Turn on')],
      blocked: [h('p', {}, 'Notifications are blocked for this site. Allow them in the browser’s site settings, then come back.')],
      install: [h('p', {}, isIos() ? 'On an iPhone or iPad, notifications work in the home-screen app: tap Share, then “Add to Home Screen”, and open Family from there.' : 'Install the app to get notifications.')],
      unsupported: [h('p', {}, 'This browser can’t show notifications from Beam Family.')],
    }[push];
    let theme = 'system';
    try { theme = localStorage.getItem('family.theme') || 'system'; } catch {}
    const themeSel = h('select', { class: 'input', 'aria-label': 'Appearance', onchange: () => setTheme(themeSel.value) },
      [['system', 'Like the device'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('option', { value: v, selected: v === theme }, l)));
    let sessions = [];
    try { sessions = (await api('/api/me/sessions')).sessions; } catch {}
    const viaTailscale = Boolean(me.tailscale);
    fill(body, h('section', {}, h('h2', {}, 'You'), h('div', { class: 'box' },
        h('div', { class: 'row', style: { marginBottom: '14px' } }, avatar(me, { size: 'l' }),
          h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, icon('image'), 'Change picture'),
            me.avatar ? h('button', { class: 'btn ghost', type: 'button', onclick: () => api('/api/me/avatar', { method: 'DELETE' }).catch(err => toast(err.message, { error: true })) }, 'Remove') : null), fileInput),
        h('label', { class: 'field' }, h('span', {}, 'Name'), h('div', { class: 'row' }, nameInput,
          h('button', { class: 'btn', type: 'button', onclick: () => api('/api/me', { method: 'PATCH', body: { name: nameInput.value } }).then(() => toast('Saved')).catch(err => toast(err.message, { error: true })) }, 'Save'))),
        h('div', { class: 'field' }, h('span', {}, 'Colour'), colours))),
      h('section', {}, h('h2', {}, 'Notifications on this device'), h('div', { class: 'box' }, pushPart,
        h('p', { class: 'muted small' }, 'Each conversation’s ⋯ menu chooses what you’re told about there.'))),
      h('section', {}, h('h2', {}, 'Signing in'), h('div', { class: 'box' },
        viaTailscale ? h('p', {}, `On Tailscale you’re signed in as ${me.tailscale}.`) : null,
        h('p', {}, me.password ? 'You have a password, for signing in without Tailscale (the public link).' : 'You have no password: you can only get in over Tailscale.'),
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: changePassword }, me.password ? 'Change password' : 'Set a password'),
          me.password && viaTailscale ? h('button', { class: 'btn ghost', type: 'button', onclick: removePassword }, 'Remove password') : null))),
      sessions.length ? h('section', {}, h('h2', {}, 'Browsers signed in with your password'), h('div', { class: 'box' },
        sessions.map(s => h('div', { class: 'item' }, icon(/Mobile|Android|iPhone/i.test(s.agent) ? 'phone' : 'monitor'),
          h('div', { class: 'grow' }, h('strong', {}, browserName(s.agent)), h('div', { class: 'muted small' }, `${s.current ? 'This browser · ' : ''}last used ${whenShort(s.seen)}${s.ip ? ` · ${s.ip}` : ''}`)),
          s.current ? null : h('button', { class: 'btn ghost', type: 'button', onclick: () => api(`/api/me/sessions/${s.id}`, { method: 'DELETE' }).then(render) }, 'Sign out'))),
        sessions.length > 1 ? h('button', { class: 'btn', type: 'button', style: { marginTop: '10px' }, onclick: () => api('/api/me/sessions/others', { method: 'DELETE' }).then(render) }, 'Sign out all the others') : null)) : null,
      h('section', {}, h('h2', {}, 'Appearance'), h('div', { class: 'box' }, themeSel)),
      h('section', {}, h('div', { class: 'row' },
        isAdmin() ? h('button', { class: 'btn', type: 'button', onclick: () => nav.go('/admin') }, icon('users'), 'People & channels') : null,
        sessions.some(s => s.current) ? h('button', { class: 'btn danger', type: 'button', onclick: signOut }, icon('logout'), 'Sign out') : null),
      h('p', { class: 'muted small', style: { marginTop: '16px' } }, `Beam Family ${state.version}`)),
    );
  }

  async function setAvatar(file) {
    if (!file) return;
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const side = Math.min(bmp.width, bmp.height);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      canvas.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
      await api('/api/me/avatar', { method: 'PUT', body: blob, type: 'image/jpeg' });
      toast('Picture changed');
    } catch (err) {
      toast(err.message || 'That picture couldn’t be used', { error: true });
    }
  }

  async function changePassword() {
    const fields = [];
    const needCurrent = state.me.password && !state.me.tailscale;
    if (needCurrent) fields.push(field('Current password', h('input', { class: 'input', type: 'password', name: 'current', autocomplete: 'current-password', required: true })));
    fields.push(field('New password (at least 10 characters)', h('input', { class: 'input', type: 'password', name: 'password', autocomplete: 'new-password', minlength: 10, required: true })),
      field('The new password again', h('input', { class: 'input', type: 'password', name: 'again', autocomplete: 'new-password', minlength: 10, required: true })));
    const done = await dialog({
      title: state.me.password ? 'Change password' : 'Set a password', body: fields, ok: 'Save',
      onSubmit: v => {
        if (v.password !== v.again) throw new Error('The two passwords aren’t the same');
        return api('/api/me', { method: 'PATCH', body: { password: v.password, current: v.current } });
      },
    });
    if (done) { toast('Password saved. Other browsers that used the old one are signed out.'); render(); }
  }

  async function removePassword() {
    if (!(await confirmDialog({ title: 'Remove your password?', text: 'You’ll only be able to get in over Tailscale.', ok: 'Remove', danger: true }))) return;
    try { await api('/api/me', { method: 'PATCH', body: { password: null } }); render(); } catch (err) { toast(err.message, { error: true }); }
  }

  async function signOut() {
    if (!(await confirmDialog({ title: 'Sign out of this browser?', ok: 'Sign out' }))) return;
    await disablePush().catch(() => {});
    await api('/api/signout', { method: 'POST' }).catch(() => {});
    location.href = '/';
  }

  offs.push(on('me', render));
  render();
  return { el: view, destroy() { for (const off of offs) off(); } };
}

export function setTheme(theme) {
  try { theme === 'system' ? localStorage.removeItem('family.theme') : localStorage.setItem('family.theme', theme); } catch {}
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

function browserName(agent = '') {
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'A browser';
  const os = /iPhone|iPad/.test(agent) ? 'iPhone' : /Android/.test(agent) ? 'Android' : /Windows/.test(agent) ? 'Windows' : /Mac OS/.test(agent) ? 'Mac' : /Linux/.test(agent) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

// ---------------------------------------------------------------- people & channels (admins)

export function adminView() {
  const offs = [];
  const body = h('div', { class: 'inner-page' });
  const view = h('section', { class: 'main', 'aria-label': 'People and channels' },
    h('header', { class: 'conv-head' }, iconBtn('back', 'Back', () => nav.go('/'), { class: 'icon-btn back' }), h('div', { class: 'title' }, h('strong', {}, 'People & channels'))), body);
  let lastInvite = null;

  async function render() {
    if (!isAdmin()) { fill(body, h('p', {}, 'Only the family space’s admins can see this.')); return; }
    let invites = [];
    try { invites = (await api('/api/invites')).invites; } catch {}
    const owner = state.me.role === 'owner';
    const role = h('select', { class: 'input', name: 'role' }, h('option', { value: 'member' }, 'Family member'), owner ? h('option', { value: 'admin' }, 'Admin (can invite and manage)') : null);
    const uses = h('select', { class: 'input', name: 'uses' }, [[1, 'One person'], [5, 'Up to 5 people'], [20, 'Up to 20 people']].map(([v, l]) => h('option', { value: v }, l)));
    const days = h('select', { class: 'input', name: 'days' }, [[7, '7 days'], [1, '1 day'], [30, '30 days']].map(([v, l]) => h('option', { value: v }, l)));
    const people = [...state.people.values()].sort((a, b) => (a.disabled ? 1 : 0) - (b.disabled ? 1 : 0) || a.name.localeCompare(b.name));
    const all = [...state.channels.values()].filter(c => c.kind === 'text').sort((a, b) => a.position - b.position);
    const space = state.spaces[0];
    fill(body, h('section', {}, h('h2', {}, 'Invite family'), h('div', { class: 'box' },
        h('p', { class: 'muted small', style: { marginTop: 0 } }, 'Make a link and send it (a text message, an e-mail) or let them scan the QR code. On Tailscale they’re signed in by Tailscale; otherwise they choose a password.'),
        h('div', { class: 'row' }, field('Who', role), field('How many', uses), field('Works for', days)),
        h('button', { class: 'btn primary', type: 'button', onclick: async () => {
          try {
            lastInvite = await api('/api/invites', { method: 'POST', body: { role: role.value, uses: Number(uses.value), days: Number(days.value) } });
            render();
          } catch (err) { toast(err.message, { error: true }); }
        } }, icon('user-plus'), 'Make an invite link'),
        lastInvite ? h('div', { style: { marginTop: '16px' } },
          h('div', { class: 'invite-link' }, h('code', {}, lastInvite.url), iconBtn('copy', 'Copy the link', () => copyText(lastInvite.url, 'Link copied')),
            navigator.share ? iconBtn('link', 'Share the link', () => navigator.share({ title: `Join ${space?.name || 'the family'} on Beam Family`, url: lastInvite.url }).catch(() => {})) : null),
          lastInvite.qr ? h('img', { class: 'qr', alt: 'QR code of the invite link', src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(lastInvite.qr)}`, style: { marginTop: '12px' } }) : null,
          h('p', { class: 'muted small' }, 'The link is shown only now. It’s like a key: send it only to who it’s for.')) : null,
        invites.length ? h('div', { style: { marginTop: '16px' } }, h('strong', {}, 'Links still open'),
          invites.map(i => h('div', { class: 'item' }, h('div', { class: 'grow' }, h('span', {}, `${i.role === 'admin' ? 'Admin' : 'Member'} · ${i.uses} of ${i.max} used`), h('div', { class: 'muted small' }, `Works until ${fullTime(i.expires)}`)),
            h('button', { class: 'btn ghost danger', type: 'button', onclick: () => api(`/api/invites/${i.id}`, { method: 'DELETE' }).then(render).catch(err => toast(err.message, { error: true })) }, 'Withdraw')))) : null)),
      h('section', {}, h('h2', {}, 'People'), h('div', { class: 'box' }, people.map(p => h('div', { class: 'item', style: { opacity: p.disabled ? 0.55 : 1 } },
        avatar(p, { presence: true }),
        h('div', { class: 'grow' }, h('strong', {}, p.name), h('div', { class: 'muted small' }, [p.tailscale ? `Tailscale ${p.tailscale}` : null, p.password ? 'password' : null, `joined ${whenShort(p.joined)}`].filter(Boolean).join(' · '))),
        h('span', { class: `pill ${p.role !== 'member' ? 'accent' : ''}` }, p.disabled ? 'Turned off' : p.role === 'owner' ? 'Owner' : p.role === 'admin' ? 'Admin' : 'Member'),
        p.role !== 'owner' && p.id !== state.me.id && (owner || p.role === 'member') ? iconBtn('more', `Manage ${p.name}`, e => personMenu(p, e.currentTarget)) : null)))),
      h('section', {}, h('h2', {}, 'Channels'), h('div', { class: 'box' }, all.map((c, i) => h('div', { class: 'item', style: { opacity: c.archived ? 0.55 : 1 } },
        icon('hash'), h('div', { class: 'grow' }, h('strong', {}, c.name), h('div', { class: 'muted small' }, c.archived ? 'Archived' : c.topic || '')),
        c.archived ? h('button', { class: 'btn ghost', type: 'button', onclick: () => api(`/api/channels/${c.id}`, { method: 'PATCH', body: { archived: false } }).then(render) }, 'Bring back')
          : [iconBtn('up', 'Move up', () => move(all, i, -1), { disabled: i === 0 }), iconBtn('down', 'Move down', () => move(all, i, 1), { disabled: i === all.length - 1 })])))),
      space ? h('section', {}, h('h2', {}, 'The family space'), h('div', { class: 'box' }, (() => {
        const n = h('input', { class: 'input', value: space.name, maxlength: 40, 'aria-label': 'Name' });
        return h('div', { class: 'row' }, n, h('button', { class: 'btn', type: 'button', onclick: () => api(`/api/spaces/${space.id}`, { method: 'PATCH', body: { name: n.value } }).then(() => toast('Saved')).catch(err => toast(err.message, { error: true })) }, 'Rename'));
      })())) : null,
    );
  }

  async function move(all, i, d) {
    const order = [...all];
    [order[i], order[i + d]] = [order[i + d], order[i]];
    try { await Promise.all(order.map((c, p) => (c.position !== p ? api(`/api/channels/${c.id}`, { method: 'PATCH', body: { position: p } }) : null))); } catch (err) { toast(err.message, { error: true }); }
    render();
  }

  function personMenu(p, anchor) {
    const owner = state.me.role === 'owner';
    menu(anchor, [
      owner && p.role === 'member' ? { label: 'Make admin', icon: 'shield', onclick: () => update(p, { role: 'admin' }) } : null,
      owner && p.role === 'admin' ? { label: 'Make a regular member', icon: 'user', onclick: () => update(p, { role: 'member' }) } : null,
      p.disabled ? null : { label: 'Make a password reset link', icon: 'lock', onclick: () => resetLink(p) },
      p.disabled ? { label: 'Turn access back on', icon: 'check', onclick: () => update(p, { disabled: false }) }
        : { label: 'Turn off access', icon: 'lock', danger: true, onclick: async () => {
          if (await confirmDialog({ title: `Turn off ${p.name}’s access?`, text: 'They’re signed out everywhere at once and can’t get back in. Their messages stay. You can turn it back on.', ok: 'Turn off', danger: true })) update(p, { disabled: true });
        } },
    ]);
  }

  async function resetLink(p) {
    let r;
    try { r = await api(`/api/people/${p.id}/reset`, { method: 'POST' }); } catch (err) { return toast(err.message, { error: true }); }
    await dialog({
      title: `Password reset link for ${p.name}`, ok: 'Done', cancel: null,
      body: [h('p', { class: 'muted small' }, `Send it to ${p.name} only: it lets them choose a new password (once, within 3 days).`),
        h('div', { class: 'invite-link' }, h('code', {}, r.url), iconBtn('copy', 'Copy the link', () => copyText(r.url, 'Link copied'))),
        r.qr ? h('img', { class: 'qr', alt: 'QR code of the link', src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(r.qr)}`, style: { marginTop: '12px' } }) : null],
    });
  }

  async function update(p, body) {
    try { await api(`/api/people/${p.id}`, { method: 'PATCH', body }); render(); } catch (err) { toast(err.message, { error: true }); }
  }

  offs.push(on('people', render), on('channels', render));
  render();
  return { el: view, destroy() { for (const off of offs) off(); } };
}

// ---------------------------------------------------------------- side panels

export function panelView(kind, { channel: channelId = null } = {}, close) {
  const offs = [];
  const bodyEl = h('div', { class: 'panel-body' });
  const heading = { members: 'People', pins: 'Pinned messages', search: 'Search' }[kind];
  const el = h('aside', { class: 'panel', 'aria-label': heading }, h('div', { class: 'panel-head' }, h('h2', {}, heading), iconBtn('x', 'Close', close)), bodyEl);

  function result(m, { highlight = '' } = {}) {
    const c = channel(m.channel);
    const body = h('div', { class: 'msg-body' }, renderBody(m.body));
    if (highlight) mark(body, highlight);
    return h('button', { class: 'result', type: 'button', onclick: () => { close(); nav.go(`/c/${m.channel}?m=${m.id}`); } },
      h('div', { class: 'where' }, `${c?.kind === 'text' ? '#' : ''}${title(c)} · ${person(m.author).name} · ${whenShort(m.created)}`), body,
      m.files?.length ? h('div', { class: 'muted small' }, `📎 ${m.files.map(f => f.name).join(', ')}`) : null);
  }

  if (kind === 'members') {
    const render = () => {
      const c = channel(channelId);
      const ids = c?.kind === 'text' ? state.spaces.find(s => s.id === c.space)?.members || [] : c?.members || [];
      const ps = ids.map(person).filter(p => !p.disabled).sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.name.localeCompare(b.name));
      fill(bodyEl, ...ps.map(p => h('div', { class: 'person-row' }, avatar(p, { presence: true }), h('div', { class: 'grow' }, h('strong', {}, p.name), h('span', { class: 'muted small' }, p.online ? 'Online' : 'Away')),
        p.id !== state.me.id ? iconBtn('message', `Message ${p.name}`, async () => {
          try { const r = await api('/api/dms', { method: 'POST', body: { people: [p.id] } }); close(); nav.go(`/c/${r.channel.id}`); } catch (err) { toast(err.message, { error: true }); }
        }) : null)));
    };
    offs.push(on('people', render), on('channels', render));
    render();
  } else if (kind === 'pins') {
    bodyEl.append(h('p', { class: 'muted' }, 'Loading…'));
    api(`/api/channels/${channelId}/pins`).then(r => {
      fill(bodyEl, ...(r.messages.length ? r.messages.map(m => result(m)) : [h('p', { class: 'muted' }, 'Nothing pinned yet. A message’s menu pins it.')]));
    }).catch(err => fill(bodyEl, h('p', { class: 'error-text' }, err.message)));
  } else if (kind === 'search') {
    const input = h('input', { class: 'input', type: 'search', placeholder: channelId ? `Search ${channel(channelId)?.kind === 'text' ? '#' : ''}${title(channel(channelId))}` : 'Search everything', 'aria-label': 'Search', enterkeyhint: 'search' });
    const results = h('div', {});
    let timer = null;
    let seq = 0;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        const mine = ++seq;
        if (!q) return fill(results);
        try {
          const r = await api(`/api/search?q=${encodeURIComponent(q)}${channelId ? `&channel=${channelId}` : ''}`);
          if (mine !== seq) return;
          fill(results, ...(r.messages.length ? r.messages.map(m => result(m, { highlight: q })) : [h('p', { class: 'muted' }, 'Nothing found.')]));
        } catch (err) {
          fill(results, h('p', { class: 'error-text' }, err.message));
        }
      }, 250);
    });
    bodyEl.append(input, h('div', { style: { height: '10px' } }), results);
    setTimeout(() => input.focus(), 50);
  }
  return { el, destroy() { for (const off of offs) off(); } };
}

// Marks the searched words in a result (text nodes only).
function mark(root, query) {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  if (!words.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    const parts = [];
    let i = 0;
    while (i < text.length) {
      let at = -1;
      let len = 0;
      for (const w of words) { const j = lower.indexOf(w, i); if (j >= 0 && (at < 0 || j < at)) { at = j; len = w.length; } }
      if (at < 0) { parts.push(text.slice(i)); break; }
      if (at > i) parts.push(text.slice(i, at));
      parts.push(h('mark', {}, text.slice(at, at + len)));
      i = at + len;
    }
    if (parts.length > 1) node.replaceWith(...parts);
  }
}

// ---------------------------------------------------------------- the picture viewer

export function openViewer(items, start = 0) {
  let i = start;
  const stage = h('div', { class: 'viewer-stage' });
  const name = h('span', { class: 'name' });
  const download = h('a', { class: 'icon-btn', title: 'Download', 'aria-label': 'Download' }, icon('download'));
  const el = h('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Picture' },
    h('div', { class: 'viewer-head' }, name, iconBtn('link', 'Fast link', () => fastLink(items[i])), download, iconBtn('x', 'Close', () => close())), stage);
  const show = () => {
    const f = items[i];
    name.textContent = `${f.name}${items.length > 1 ? ` · ${i + 1} of ${items.length}` : ''}`;
    download.href = `${f.url}?download`;
    download.setAttribute('download', f.name);
    const media = f.mime.startsWith('video/') ? h('video', { src: f.url, controls: true, autoplay: true, playsinline: true }) : h('img', { src: f.url, alt: f.name });
    fill(stage, media,
      i > 0 ? h('button', { class: 'nav prev', type: 'button', 'aria-label': 'Previous', onclick: () => step(-1) }, icon('back')) : null,
      i < items.length - 1 ? h('button', { class: 'nav next', type: 'button', 'aria-label': 'Next', onclick: () => step(1) }, icon('next')) : null);
  };
  const step = d => { const n = i + d; if (n >= 0 && n < items.length) { i = n; show(); } };
  const onKey = e => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  };
  let sx = null;
  stage.addEventListener('touchstart', e => { sx = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
  stage.addEventListener('touchend', e => { if (sx !== null) { const dx = e.changedTouches[0].clientX - sx; if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1); } sx = null; });
  function close() {
    el.remove();
    document.removeEventListener('keydown', onKey, true);
    if (history.state?.viewer) history.back();
  }
  const onPop = () => { if (el.isConnected) { el.remove(); document.removeEventListener('keydown', onKey, true); } window.removeEventListener('popstate', onPop); };
  document.addEventListener('keydown', onKey, true);
  // Back (a phone's back gesture) closes the viewer rather than leaving the conversation.
  history.pushState({ ...(history.state || {}), viewer: true }, '');
  window.addEventListener('popstate', onPop);
  document.body.append(el);
  show();
}

// ---------------------------------------------------------------- starting a conversation

export async function newConversation() {
  const others = [...state.people.values()].filter(p => p.id !== state.me.id && !p.disabled).sort((a, b) => a.name.localeCompare(b.name));
  if (!others.length) {
    toast(isAdmin() ? 'Nobody else is here yet: invite family from People & channels' : 'Nobody else is here yet');
    return;
  }
  const nameField = field('A name for the group (optional)', h('input', { class: 'input', name: 'name', maxlength: 40 }));
  nameField.hidden = true;
  const boxes = others.map(p => h('label', { class: 'pick-row' }, h('input', { type: 'checkbox', name: 'p', value: p.id, onchange: () => {
    nameField.hidden = boxes.filter(b => b.querySelector('input').checked).length < 2;
  } }), avatar(p, { size: 's', presence: true }), h('span', {}, p.name)));
  const out = await dialog({
    title: 'New conversation', body: [h('p', { class: 'muted small', style: { marginTop: 0 } }, 'One person: a direct conversation. More: a group.'), h('div', { class: 'picker-list' }, boxes), nameField],
    ok: 'Start',
    onSubmit: () => {
      const people = boxes.map(b => b.querySelector('input')).filter(i => i.checked).map(i => i.value);
      if (!people.length) throw new Error('Choose at least one person');
      const name = nameField.querySelector('input').value.trim();
      return api('/api/dms', { method: 'POST', body: { people, ...(people.length > 1 && name ? { name } : {}) } });
    },
  });
  if (out?.channel) nav.go(`/c/${out.channel.id}`);
}

