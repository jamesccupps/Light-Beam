#!/usr/bin/env node
// A TCP proxy that puts a round trip and a bandwidth cap between a client and a scratch server, so protocol
// round-trip costs show up on one machine: gaps between upload chunks, Expect: 100-continue, new connections,
// chains of requests. It doesn't model TCP congestion or packet loss.
//
//   node test/perf/netsim.mjs --listen 8841 --to 127.0.0.1:8791 --rtt 25 --mbps 200
//
// Options: --listen <port> (required), --host <address to listen on, default 127.0.0.1>, --to <host:port>
// (required), --rtt <ms> (default 25), --mbps <megabits per second each way, 0 = no cap; default 0>,
// --window <KB buffered per direction before the sender is paused, default 4096>, --no-handshake (a new
// connection normally costs one extra round trip, like TCP's), --quiet.
//
// From a script: const sim = await startNetsim({ listen: 8841, to: '127.0.0.1:8791', rtt: 25, mbps: 200 });
//   sim.stats() -> { connections, up, down } (bytes); await sim.close();
//
// Timers on Windows fire about every 15.6 ms, so the last stretch before a release is spun with setImmediate
// (one busy core while data is in flight). Delays are then accurate to well under a millisecond.
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// How late a short setTimeout fires here (about 15.6 ms on Windows, about 1 ms elsewhere).
async function timerGranularity() {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    await sleep(1);
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  return samples[2];
}

export async function startNetsim({ listen, host = '127.0.0.1', to, rtt = 25, mbps = 0, window = 4096 * 1024, handshake = true, log = () => {} }) {
  const [toHost, toPort] = String(to).includes(':') ? [String(to).slice(0, String(to).lastIndexOf(':')), Number(String(to).slice(String(to).lastIndexOf(':') + 1))] : ['127.0.0.1', Number(to)];
  const oneWay = rtt / 2;
  const bytesPerMs = mbps > 0 ? (mbps * 1e6) / 8 / 1000 : Infinity;
  const spinWindow = (await timerGranularity()) + 1;
  // One link per direction, shared by every connection (like a real uplink and downlink).
  const links = { up: { freeAt: 0 }, down: { freeAt: 0 } };
  const totals = { connections: 0, up: 0, down: 0 };
  const sockets = new Set();

  function direction(src, dst, link, name, firstDelay) {
    const q = { items: [], bytes: 0, paused: false, scheduled: false, ended: false, endSent: false, first: firstDelay };
    const pump = () => {
      if (q.scheduled || dst.destroyed) return;
      while (q.items.length) {
        const head = q.items[0];
        const wait = head.at - performance.now();
        if (wait > 0) {
          q.scheduled = true;
          const next = () => { q.scheduled = false; pump(); };
          if (wait > spinWindow) setTimeout(next, wait - spinWindow);
          else setImmediate(next);
          return;
        }
        if (dst.writableNeedDrain) {
          q.scheduled = true;
          dst.once('drain', () => { q.scheduled = false; pump(); });
          return;
        }
        q.items.shift();
        q.bytes -= head.chunk.length;
        dst.write(head.chunk);
        if (q.paused && q.bytes < window / 2) {
          q.paused = false;
          src.resume();
        }
      }
      if (q.ended && !q.endSent) {
        q.endSent = true;
        dst.end();
      }
    };
    src.on('data', chunk => {
      const t = performance.now();
      const start = Math.max(t, link.freeAt);
      link.freeAt = start + chunk.length / bytesPerMs;
      let at = link.freeAt + oneWay;
      if (q.first) {
        at += q.first; // the handshake a real connection needs before its first bytes can go
        q.first = 0;
      }
      q.items.push({ chunk, at });
      q.bytes += chunk.length;
      totals[name] += chunk.length;
      if (q.bytes > window && !q.paused) {
        q.paused = true;
        src.pause();
      }
      pump();
    });
    src.on('end', () => {
      q.ended = true;
      pump();
    });
  }

  // Half-open connections are kept (each direction ends on its own, after its queue drains); a reset on either
  // side resets both.
  const server = net.createServer({ allowHalfOpen: true }, client => {
    totals.connections++;
    client.setNoDelay(true);
    const upstream = net.connect({ host: toHost, port: toPort, allowHalfOpen: true });
    upstream.setNoDelay(true);
    sockets.add(client);
    sockets.add(upstream);
    const reset = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', reset);
    upstream.on('error', reset);
    client.on('close', () => sockets.delete(client));
    upstream.on('close', () => sockets.delete(upstream));
    direction(client, upstream, links.up, 'up', handshake ? rtt : 0);
    direction(upstream, client, links.down, 'down', 0);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen, host, resolve);
  });
  log(`netsim: ${host}:${listen} -> ${toHost}:${toPort}, round trip ${rtt} ms, ${mbps > 0 ? `${mbps} Mbit/s each way` : 'no bandwidth cap'}${handshake ? '' : ', no handshake cost'}`);
  return {
    port: listen,
    stats: () => ({ ...totals }),
    close: () => new Promise(resolve => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

function parseArgs(argv) {
  const opts = { rtt: 25, mbps: 0, host: '127.0.0.1', window: 4096, handshake: true, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--listen') opts.listen = Number(value());
    else if (a === '--host') opts.host = value();
    else if (a === '--to') opts.to = value();
    else if (a === '--rtt') opts.rtt = Number(value());
    else if (a === '--mbps') opts.mbps = Number(value());
    else if (a === '--window') opts.window = Number(value());
    else if (a === '--no-handshake') opts.handshake = false;
    else if (a === '--quiet') opts.quiet = true;
    else throw new Error(`Unknown option ${a}`);
  }
  if (!Number.isInteger(opts.listen) || !opts.to) throw new Error('Usage: node test/perf/netsim.mjs --listen <port> --to <host:port> [--rtt ms] [--mbps n]');
  if (!(opts.rtt >= 0) || !(opts.mbps >= 0) || !(opts.window > 0)) throw new Error('--rtt, --mbps and --window must be positive numbers');
  return opts;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const sim = await startNetsim({ ...opts, window: opts.window * 1024, log: opts.quiet ? () => {} : console.log });
  const report = () => {
    const s = sim.stats();
    if (!opts.quiet) console.log(`netsim: ${s.connections} connections, ${(s.up / 1e6).toFixed(1)} MB up, ${(s.down / 1e6).toFixed(1)} MB down`);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    try { process.on(signal, async () => { report(); await sim.close(); process.exit(0); }); } catch {}
  }
}
