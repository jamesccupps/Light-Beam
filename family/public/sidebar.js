// The list on the left (the whole screen on a phone): the space's channels, direct and group conversations, a
// nudge to turn on notifications, and me.

import { h, fill, icon, iconBtn, avatar, dialog, field, toast } from './ui.js';
import { api } from './api.js';
import { state, on, title, otherPerson, sortedChannels, isAdmin } from './store.js';
import { pushState, enablePush, isIos } from './notify.js';
import { nav } from './nav.js';

const HINT_KEY = 'family.hint.push';

export function sidebarView() {
  const offs = [];
  const listEl = h('nav', { class: 'side-list', 'aria-label': 'Conversations' });
  const headTitle = h('h1', {});
  const banner = h('div', {});
  const meBar = h('div', { class: 'me-bar' });
  let active = null;

  const head = h('div', { class: 'side-head' }, headTitle,
    isAdmin() ? iconBtn('user-plus', 'Invite family', () => nav.go('/admin')) : null,
    iconBtn('search', 'Search', () => nav.panel('search', {})));

  function chanRow(c) {
    const unread = c.unread > 0;
    const mentions = c.kind === 'text' ? c.mentions : c.unread;
    const muted = c.notify === 'none';
    const label = title(c);
    const glyph = c.kind === 'text' ? h('span', { class: 'glyph' }, icon('hash', 'i small'))
      : c.kind === 'dm' ? avatar(otherPerson(c), { size: 's', presence: true }) : h('span', { class: 'avatar s c6' }, icon('users', 'i small'));
    return h('a', {
      class: `chan${c.id === active ? ' active' : ''}${unread && !muted ? ' unread' : ''}${muted ? ' muted-chan' : ''}`,
      href: `/c/${c.id}`, 'aria-current': c.id === active ? 'page' : null,
      'aria-label': `${c.kind === 'text' ? '#' : ''}${label}${mentions ? `, ${mentions} new` : unread ? ', unread' : ''}`,
      onclick: e => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); nav.go(`/c/${c.id}`); } },
    }, glyph, h('span', { class: 'name' }, label), mentions > 0 && !(muted && c.kind === 'text' && !c.mentions) ? h('span', { class: 'badge' }, mentions > 99 ? '99+' : String(mentions)) : null);
  }

  function render() {
    const space = state.spaces[0];
    headTitle.textContent = space?.name || 'Family';
    const { text, direct } = sortedChannels();
    fill(listEl, h('div', { class: 'side-section' }, h('span', {}, 'Channels'), isAdmin() && space ? iconBtn('plus', 'New channel', () => newChannel(space.id)) : null),
      text.map(chanRow),
      h('div', { class: 'side-section' }, h('span', {}, 'Direct messages'), iconBtn('plus', 'New conversation', () => nav.newConversation())),
      direct.length ? direct.map(chanRow) : h('p', { class: 'muted small', style: { margin: '4px 10px' } }, 'Start a conversation with someone with the + above.'),
    );
    const me = state.me;
    fill(meBar, avatar(me, { presence: false }), h('div', { class: 'who' }, h('strong', {}, me.name), h('span', { class: 'muted small' }, me.role === 'owner' ? 'Owner' : me.role === 'admin' ? 'Admin' : 'Family')),
      iconBtn('gear', 'Settings', () => nav.go('/settings')));
  }

  async function renderBanner() {
    let dismissed = false;
    try { dismissed = localStorage.getItem(HINT_KEY) === 'no'; } catch {}
    const s = await pushState().catch(() => 'unsupported');
    if (dismissed || (s !== 'off' && s !== 'install')) return fill(banner);
    const close = iconBtn('x', 'Not now', () => { try { localStorage.setItem(HINT_KEY, 'no'); } catch {} fill(banner); }, { style: { marginLeft: 'auto' } });
    if (s === 'install' && isIos()) {
      fill(banner, h('div', { class: 'banner' }, icon('bell'), h('span', {}, 'For notifications on this iPhone: tap Share, then “Add to Home Screen”, and open Family from there.'), close));
    } else if (s === 'off') {
      const btn = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        try { await enablePush(); toast('Notifications are on for this device'); fill(banner); } catch (err) { toast(err.message, { error: true }); }
      } }, 'Turn on');
      fill(banner, h('div', { class: 'banner' }, icon('bell'), h('span', {}, 'Get notified about new messages on this device?'), btn, close));
    }
  }

  async function newChannel(spaceId) {
    const name = h('input', { class: 'input', name: 'name', maxlength: 40, required: true, placeholder: 'e.g. recipes' });
    const topic = h('input', { class: 'input', name: 'topic', maxlength: 200, placeholder: 'What it’s for (optional)' });
    const out = await dialog({
      title: 'New channel', body: [field('Name', name), field('Topic', topic)], ok: 'Create',
      onSubmit: v => api(`/api/spaces/${spaceId}/channels`, { method: 'POST', body: { name: v.name, topic: v.topic } }),
    });
    if (out?.channel) nav.go(`/c/${out.channel.id}`);
  }

  offs.push(on('channels', render), on('people', render), on('me', render));
  render();
  renderBanner();

  const el = h('aside', { class: 'side', 'aria-label': 'Family' }, head, banner, listEl, meBar);
  return {
    el,
    setActive(id) { active = id; render(); },
    destroy() { for (const off of offs) off(); },
  };
}
