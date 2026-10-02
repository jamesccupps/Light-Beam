'use strict';
// Offline cache (IndexedDB): devices, item summaries, read markers and the outbox, so Beam opens instantly, history
// stays readable and searchable without a connection, and messages written offline go out by themselves later.
// Everything here degrades to "no cache" when IndexedDB isn't available (private windows, old browsers).

const idb = { db: null, opening: null };
// A borrowed computer (session-only sign-in) keeps no history on disk.
let cacheDisabled = (() => { try { return sessionStorage.getItem('beam.sessionOnly') === '1'; } catch { return false; } })();

async function disableOfflineCache() {
  if (cacheDisabled) return;
  await idbTx(['kv', 'items', 'outbox'], 'readwrite', s => { s.kv.clear(); s.items.clear(); s.outbox.clear(); });
  cacheDisabled = true;
}

function idbOpen(force = false) {
  if (cacheDisabled && !force) return Promise.resolve(null);
  if (idb.db) return Promise.resolve(idb.db);
  if (idb.opening) return idb.opening;
  idb.opening = new Promise(resolve => {
    let req;
    try { req = indexedDB.open('beam', 1); } catch { return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      idb.db = req.result;
      idb.db.onversionchange = () => { idb.db.close(); idb.db = null; idb.opening = null; }; // deleted elsewhere: reopen next time
      resolve(idb.db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return idb.opening;
}

// Runs fn(stores) in one transaction; resolves with fn's value once the transaction commits. With the database
// already open the transaction starts right away (synchronously), so writes made while the page is leaving still land.
// `force` reaches the store while this page keeps away from it (a dormant history being wiped or checked).
function idbTx(names, mode, fn, { force = false } = {}) {
  if (cacheDisabled && !force) return Promise.resolve(undefined);
  if (idb.db) return idbRun(idb.db, names, mode, fn);
  return idbOpen(force).then(db => (db ? idbRun(db, names, mode, fn) : undefined));
}

function idbRun(db, names, mode, fn) {
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(names, mode); } catch (err) { return reject(err); }
    const stores = Object.fromEntries([].concat(names).map(n => [n, tx.objectStore(n)]));
    let value;
    try { value = fn(stores); } catch (err) { tx.abort(); return reject(err); }
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  }).catch(err => { console.warn('IndexedDB:', err && err.message); return undefined; });
}

const reqValue = req => new Promise(resolve => { req.onsuccess = () => resolve(req.result); req.onerror = () => resolve(undefined); });

async function idbGetAll(name) {
  const db = await idbOpen();
  if (!db) return [];
  try { return (await reqValue(db.transaction(name).objectStore(name).getAll())) || []; } catch { return []; }
}
async function kvGet(key, { force = false } = {}) {
  const db = await idbOpen(force);
  if (!db) return undefined;
  try { return await reqValue(db.transaction('kv').objectStore('kv').get(key)); } catch { return undefined; }
}
const kvSet = (key, value) => idbTx('kv', 'readwrite', s => { ownerGuard(s); s.kv.put(value, key); });

// The store is shared by every tab, but each tab knows only the owner it loaded or first heard from. If another tab
// has handed the store to another Beam since (a sign-in there), this tab's writes are undone: the stored owner is
// read first in the same transaction, and a mismatch aborts it.
function ownerGuard(stores) {
  if (!cache.owner) return;
  const r = stores.kv.get('meta');
  r.onsuccess = () => {
    const stored = r.result?.serverId;
    if (stored && stored !== cache.owner) { try { r.transaction.abort(); } catch {} }
  };
}

// ---------------------------------------------------------------- the cache proper

// Each tab marks the cursor it stores, so another tab's write can be told from its own.
const TAB_ID = randomId(6);
const cursorRecord = v => (v && typeof v === 'object' ? { cursor: String(v.cursor || ''), tab: String(v.tab || '') } : { cursor: typeof v === 'string' ? v : '', tab: '' });
const sameRecord = (a, b) => a.cursor === b.cursor && a.tab === b.tab;

const cache = {
  // The cache belongs to one device identity (another one's is thrown away) and to one Beam, its owner: while another
  // Beam answers at this address it lies dormant, and a sign-in there replaces it (answeredBy). Everything in one
  // transaction, so the items and the cursor are from the same moment (another tab may write).
  async load() {
    const db = await idbOpen();
    if (!db) return null;
    const snap = await new Promise(resolve => {
      let tx;
      try { tx = db.transaction(['kv', 'items'], 'readonly'); } catch { return resolve(null); }
      const out = {};
      const kv = tx.objectStore('kv');
      for (const key of ['meta', 'devices', 'read', 'names', 'cursor', 'aside']) { const r = kv.get(key); r.onsuccess = () => { out[key] = r.result; }; }
      const all = tx.objectStore('items').getAll();
      all.onsuccess = () => { out.items = all.result || []; };
      tx.oncomplete = () => resolve(out);
      tx.onerror = tx.onabort = () => resolve(null);
    });
    const meta = snap?.meta;
    if (!meta) return null;
    if (meta.deviceId !== me.id) {
      await this.clear();
      return null;
    }
    this.owner = meta.serverId || '';
    this.aside = typeof snap.aside === 'string' ? snap.aside : '';
    this.stored = snap.cursor === undefined ? null : cursorRecord(snap.cursor);
    return { meta, items: snap.items || [], devices: snap.devices || [], read: snap.read || {}, names: snap.names || {}, cursor: this.stored?.cursor || '', aside: this.aside };
  },
  async clear() {
    this.stored = null;
    this.cursorTainted = false;
    this.owner = this.aside = '';
    await idbTx(['kv', 'items'], 'readwrite', s => { s.kv.clear(); s.items.clear(); }, { force: true });
  },
  // A sign-out forced by the server: the history, and the outbox of that Beam (`outboxOf`; entries that don't say
  // which Beam they're for count as its) go. What's queued for other Beams stays: it exists nowhere else.
  async wipe({ outboxOf = '' } = {}) {
    this.forgetState();
    await idbTx(['kv', 'items', 'outbox'], 'readwrite', s => {
      s.kv.clear();
      s.items.clear();
      const all = s.outbox.getAll();
      all.onsuccess = () => { for (const e of all.result || []) if (!e.serverId || e.serverId === outboxOf) s.outbox.delete(e.id); };
    }, { force: true });
  },
  // Another Beam signed this page in: the old Beam's history goes (it can always be fetched from it again), its
  // outbox stays for it. Untagged entries are tagged with the old Beam in the same transaction, so even a crash half-way
  // can't leave one that the next Beam would take.
  async replaceHistory(oldOwner) {
    this.forgetState();
    await idbTx(['kv', 'items', 'outbox'], 'readwrite', s => {
      s.kv.clear();
      s.items.clear();
      if (!oldOwner) return;
      const all = s.outbox.getAll();
      all.onsuccess = () => { for (const e of all.result || []) if (!e.serverId) s.outbox.put({ ...e, serverId: oldOwner }); };
    }, { force: true });
  },
  forgetState() {
    this.pending.clear();
    this.replaceAll = null;
    this.cursor = '';
    this.stored = null;
    this.cursorTainted = false;
    this.owner = this.aside = '';
  },
  owner: '', // the Beam (serverId) the saved history belongs to
  aside: '', // the other Beam it lay dormant for last time: a start then hears who answers before showing anything
  markAside(other) { this.aside = other; idbTx('kv', 'readwrite', s => { ownerGuard(s); s.kv.put(other, 'aside'); }, { force: true }); },
  forgetAside() { this.aside = ''; idbTx('kv', 'readwrite', s => { ownerGuard(s); s.kv.delete('aside'); }); },
  meta: () => ({ deviceId: me.id, serverId: server.serverId, api: server.api, features: [...server.features], savedAt: Date.now() }),
  // Where the stored list stands (items-since): written with the items it belongs to, never ahead of them.
  cursor: '',
  stored: null, // the cursor record this tab last read or wrote: { cursor, tab }
  cursorTainted: false, // another tab wrote items since: store no cursor until this tab has replaced the whole list
  setCursor(cursor) { if (cursor !== this.cursor) { this.cursor = cursor; this.flushItems(); } },
  saveMeta: batched(() => kvSet('meta', cache.meta()), 500),
  saveDevices: batched(() => kvSet('devices', devices), 800),
  saveRead: batched(() => kvSet('read', readMarks), 800),
  saveNames: batched(() => kvSet('names', knownNames), 1500),
  // Items change one at a time (events) or all at once (sync); both end up here.
  pending: new Map(), // id -> item (put) or null (delete)
  putItem(item) { this.pending.set(item.id, item); this.flushItems(); },
  deleteItem(id) { this.pending.set(id, null); this.flushItems(); },
  replaceItems(list) {
    this.pending.clear();
    this.replaceAll = list;
    this.flushItems();
  },
  flushItems: batched(async function flush() {
    const all = cache.replaceAll;
    const changes = [...cache.pending];
    const cursor = cache.cursor;
    cache.replaceAll = null;
    cache.pending.clear();
    // The items and whose they are, together (a cache without its meta is thrown away on the next start).
    await idbTx(['items', 'kv'], 'readwrite', s => {
      ownerGuard(s);
      if (all) { s.items.clear(); for (const item of all) s.items.put(item); }
      for (const [id, item] of changes) item ? s.items.put(item) : s.items.delete(id);
      s.kv.put(cache.meta(), 'meta');
      // Another tab may have written its own items and cursor since this tab last did: then no cursor is sure to
      // fit what's stored, and '' makes the next start fetch the whole list once. That holds until this tab writes
      // its whole list again (its own cursor then fits exactly what's stored).
      const r = s.kv.get('cursor');
      r.onsuccess = () => {
        const now = r.result;
        const known = cache.stored;
        const ours = now === undefined ? known === null : known !== null && sameRecord(cursorRecord(now), known);
        if (all) cache.cursorTainted = false;
        else if (!ours) cache.cursorTainted = true;
        const next = { cursor: all || !cache.cursorTainted ? cursor : '', tab: TAB_ID };
        s.kv.put(next, 'cursor');
        cache.stored = next;
      };
    });
  }, 400),
  // Leaving (or going to the background, where phones may end the app): write what's waiting now.
  flushPending() {
    for (const save of [this.flushItems, this.saveDevices, this.saveRead, this.saveNames, this.saveMeta]) save.flushPending();
  },
};

// ---------------------------------------------------------------- outbox (texts and small files written while offline)

const OUTBOX_FILE_MAX = 25 * 1024 * 1024;

// Only the data is stored (the entry object also carries its on-screen row, which can't be saved). Each entry
// records the Beam it was written for (serverId) and only ever goes there; one for another Beam than the cache's
// waits for that Beam for 30 days at most (loadOutbox).
const OUTBOX_KEEP_MS = 30 * 24 * 3600 * 1000;
const OUTBOX_FIELDS = ['id', 'kind', 'text', 'blob', 'name', 'type', 'size', 'conv', 'to', 'created', 'deviceId', 'serverId', 'maybeSent', 'error'];
const outboxStore = {
  all: () => idbGetAll('outbox').then(list => list.filter(e => e.deviceId === me.id).sort((a, b) => a.created - b.created)),
  // Outbox writes aren't owner-checked (each entry says which Beam it's for), and they say whether they committed.
  put: (entry, { force = false } = {}) => idbTx('outbox', 'readwrite', s => { s.outbox.put(Object.fromEntries(OUTBOX_FIELDS.filter(k => entry[k] !== undefined).map(k => [k, entry[k]]))); return true; }, { force }).then(ok => ok === true),
  remove: id => idbTx('outbox', 'readwrite', s => { s.outbox.delete(id); return true; }).then(ok => ok === true),
  retag: (from, to) => idbTx('outbox', 'readwrite', s => {
    const all = s.outbox.getAll();
    all.onsuccess = () => { for (const e of all.result || []) if (e.deviceId === from) s.outbox.put({ ...e, deviceId: to }); };
  }, { force: true }),
  // Still stored? (Without a store, the in-memory outbox is all there is.)
  has: async id => {
    const db = await idbOpen();
    if (!db) return true;
    try { return (await reqValue(db.transaction('outbox').objectStore('outbox').count(id))) > 0; } catch { return true; }
  },
};
