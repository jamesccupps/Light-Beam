// A fake second device for test/perf/windows-perf.ps1 (scratch servers only).
//   node windows-peer.mjs <base> <key> register
//   node windows-peer.mjs <base> <key> upload <toDeviceId> <file>     → prints {"id","mbps"}
//   node windows-peer.mjs <base> <key> items
import fs from 'node:fs';
import path from 'node:path';

const [base, key, cmd, ...rest] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:88\d\d$/.test(base || '')) {
  console.error('scratch servers only (http://127.0.0.1:88xx)');
  process.exit(2);
}
const H = {
  Authorization: `Bearer ${key}`,
  'X-Beam-Device-Id': 'perfphone0001perfphone0001',
  'X-Beam-Device': encodeURIComponent('Perf Phone'),
  'X-Beam-Platform': 'android',
};

async function json(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { ...H, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

if (cmd === 'register') {
  const r = await json('GET', '/api/devices');
  console.log(JSON.stringify({ status: r.status, devices: r.data.devices?.length }));
} else if (cmd === 'items') {
  const r = await json('GET', '/api/items');
  console.log(JSON.stringify(r.data.items.map(i => ({ id: i.id, name: i.name, size: i.size, delivered: Object.keys(i.delivered || {}) }))));
} else if (cmd === 'upload') {
  const [to, file] = rest;
  const size = fs.statSync(file).size;
  const started = process.hrtime.bigint();
  const c = await json('POST', '/api/uploads', { name: path.basename(file), size, mime: 'application/octet-stream', to: [to] });
  if (c.status !== 201) throw new Error(JSON.stringify(c));
  const fd = fs.openSync(file, 'r');
  let off = 0;
  for (;;) {
    const n = Math.min(c.data.chunkSize, size - off);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, off);
    const res = await fetch(`${base}/api/uploads/${c.data.id}?offset=${off}`, { method: 'PUT', headers: { ...H, 'Content-Type': 'application/octet-stream' }, body: buf });
    const d = await res.json();
    if (res.status === 201) break;
    if (res.status !== 200) throw new Error(`chunk at ${off}: ${res.status} ${JSON.stringify(d)}`);
    off = d.offset;
  }
  fs.closeSync(fd);
  const secs = Number(process.hrtime.bigint() - started) / 1e9;
  console.log(JSON.stringify({ id: c.data.id, mbps: +(size / 1048576 / secs).toFixed(1) }));
} else {
  console.error('usage: register | upload <to> <file> | items');
  process.exit(2);
}
