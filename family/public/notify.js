// Notifications on this device (Web Push): what's possible here, turning them on and off. An iPhone or iPad only
// allows them in the home-screen app, so there the first step is "Add to Home Screen".

import { api } from './api.js';
import { state } from './store.js';

export const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// 'on' | 'off' | 'blocked' | 'install' (iPhone, not added to the home screen yet) | 'unsupported'
export async function pushState() {
  if (isIos() && !isStandalone()) return 'install';
  if (!supported() || !state.pushKey) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

// Asks (this must come from a tap) and subscribes; the server is told where to send.
export async function enablePush() {
  if (!supported()) throw new Error('This browser can’t show notifications from Beam Family');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications are blocked for this site in the browser’s settings' : 'Notifications weren’t allowed');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const key = Uint8Array.from(atob(state.pushKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  if (sub && !sameKey(sub.options?.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('/api/push', { method: 'PUT', body: sub.toJSON() });
}

function sameKey(a, b) {
  if (!a) return true; // (some browsers don't say: keep the subscription)
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api('/api/push', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}

// After signing in again on a device that already had notifications on: the server learns the subscription again.
export async function refreshPush() {
  try {
    if (!supported() || Notification.permission !== 'granted' || !state.pushKey) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) await api('/api/push', { method: 'PUT', body: sub.toJSON() });
  } catch {}
}
