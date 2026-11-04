#!/usr/bin/env node
// Beam for Windows 1.17.7: the remote control picture's bandwidth floor (windows/rc/rc-host.js `floorNext`), tick by
// tick, without a PC or a viewer: what windows-rc can't make happen on one PC (loss, a long round trip, a link that
// goes slow). The function is read out of rc-host.js as it is and run here. Exits 1 if a check fails.
//
//   node test/perf/rc-floor-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'windows', 'rc', 'rc-host.js'), 'utf8').replace(/\r\n/g, '\n'); // (CRLF in a Windows checkout)
const at = src.indexOf('  function floorNext(s, t) {');
const end = src.indexOf('\n  }\n', at);
if (at < 0 || end < 0) throw new Error('floorNext not found in rc-host.js');
const floorNext = new Function(`${src.slice(at, end + 4)}\nreturn floorNext;`)();

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const off = { kbps: 0, off: false, fast: 0, bad: 0 };
const tick = (o = {}) => ({ rtt: 2, lost: 0, lan: false, allowed: true, limit: 15000, ...o });
// Runs the ticks from a state; returns the last state and every act
function run(ticks, s = off) {
  const acts = [];
  for (const t of ticks) { s = floorNext(s, tick(t)); acts.push(s.act); }
  return { s, acts };
}

let r = run([{}, {}]);
check(r.s.kbps === 12000 && r.acts.join() === ',on' && /round trip of 2 ms/.test(r.s.why), `two fast ticks (a 2 ms round trip): on at 12 Mbps on the second (${r.acts.join()} · ${r.s.why})`);
r = run([{ rtt: 25, lan: true }, { rtt: 25, lan: true }]);
check(r.s.kbps === 12000 && r.s.why === 'Tailscale direct on the LAN', `Tailscale direct on the LAN counts as fast whatever the round trip (${r.s.why})`);
r = run([{ rtt: 25 }, { rtt: 25 }, { rtt: 25 }]);
check(r.s.kbps === 0 && r.acts.every(a => !a), 'across the internet (25 ms, not on the LAN): never on');
r = run([{ rtt: null }, { rtt: null }]);
check(r.s.kbps === 0, 'a round trip not known yet: not fast');
r = run([{}, { rtt: 25 }, {}]);
check(r.s.kbps === 0 && r.s.fast === 1, 'one fast tick, a slow one, a fast one: not yet (two in a row)');
r = run([{ lost: 3 }, { lost: 3 }]);
check(r.s.kbps === 0, 'fast but losing packets: not on');
r = run([{}, {}, { lost: 2.5 }, { lost: 3 }]);
check(r.s.kbps === 0 && r.s.off === true && r.acts[3] === 'off' && r.s.why === 'loss 3%', `on, then two ticks of loss over 2%: off for the session (${r.acts.join()} · ${r.s.why})`);
r = run([{}, {}, { lost: 3 }, { lost: 3 }, {}, {}, {}, {}], );
check(r.s.kbps === 0 && r.acts.slice(4).every(a => !a), '...and fast ticks after that never bring it back');
r = run([{}, {}, { lost: 3 }, {}, { lost: 3 }, {}]);
check(r.s.kbps === 12000 && !r.s.off, 'loss on single ticks, a clean one between: it stays on');
r = run([{}, {}, { rtt: 40 }, { rtt: 45 }]);
check(r.s.off === true && r.s.why === 'a round trip of 45 ms', `on, then two ticks over 30 ms: off for the session (${r.s.why})`);
r = run([{}, {}, { lost: 2 }, { lost: 2 }]);
check(r.s.kbps === 12000, 'exactly 2% loss is fine');
r = run([{ limit: 8000 }, { limit: 8000 }]);
check(r.s.kbps === 8000, 'never over the profile\'s limit (Sharp text: 8 Mbps)');
r = run([{ limit: 8000 }, { limit: 8000 }, { limit: 16000 }]);
const up = r.s;
r = run([{ limit: 25000 }], up);
check(up.kbps === 12000 && up.act === 'on' && up.why === 'the profile changed' && r.s.kbps === 12000 && !r.s.act,
  `the profile's limit goes up: 8 → 12 Mbps (${up.why}), then stays at 12 for a higher one`);
r = run([{ limit: 1500 }, { limit: 1500 }, { limit: 1500 }]);
check(r.s.kbps === 0, 'a limit under 2 Mbps (the viewer set it low): no floor');
r = run([{}, {}, { allowed: false }, {}, {}]);
check(r.acts.join() === ',on,off,,on' && r.s.kbps === 12000 && !r.s.off && r.acts[2] === 'off', `not allowed for a while (mobile data, Data saver): off, and back after two fast ticks (${r.acts.join()})`);
r = run([{ allowed: false }, { allowed: false }]);
check(r.s.kbps === 0, 'never on while not allowed');

// (1.22.1) Across the internet: sized from the speed tests (`link`, Mbit/s), only on a direct path
const far = (o = {}) => ({ rtt: 24, direct: true, link: 20, ...o });
r = run([far(), far()]);
check(r.s.kbps === 10000 && r.acts.join() === ',on' && r.s.kind === 'measured' && r.s.why === 'the speed tests: 20 Mbit/s between them',
  `24 ms away, 20 Mbit/s measured: on at half of it, 10 Mbps, on the second tick (${r.acts.join()} · ${r.s.why})`);
r = run([far({ link: 48 }), far({ link: 48 })]);
check(r.s.kbps === 15000, `48 Mbit/s measured: at most the profile's limit (Auto's 15 Mbps): ${r.s.kbps}`);
r = run([far({ link: 100, limit: 25000 }), far({ link: 100, limit: 25000 })]);
check(r.s.kbps === 20000, `100 Mbit/s and Smooth motion's 25: at most 20 Mbps (${r.s.kbps})`);
r = run([far({ link: 8 }), far({ link: 8 }), far({ link: 8 })]);
check(r.s.kbps === 0, '8 Mbit/s measured (4 Mbps, no more than WebRTC\'s own estimate): no floor');
r = run([far({ direct: false }), far({ direct: false }), far({ direct: false })]);
check(r.s.kbps === 0, 'through a relay (not direct): never on');
r = run([far({ link: 0 }), far({ link: 0 })]);
check(r.s.kbps === 0, 'no speed tests from where they are: never on');
r = run([far({ rtt: null }), far({ rtt: null })]);
check(r.s.kbps === 0, 'the round trip not known yet: not on (no lowest to watch)');
r = run([far({ allowed: false }), far({ allowed: false })]);
check(r.s.kbps === 0, 'mobile data, Data saver, keyboard and mouse: never on');
r = run([far({ lan: true }), far({ lan: true })]);
check(r.s.kbps === 12000 && r.s.kind === 'near', `Tailscale direct on the LAN: the LAN's 12 Mbps, not the speed tests' (${r.s.kbps}, ${r.s.why})`);
r = run([far(), far(), far({ rtt: 50 }), far({ rtt: 30 }), far({ rtt: 55 })]);
check(r.s.kbps === 10000 && !r.s.off, 'on, then a round trip of 50 and 55 ms with 30 between (lowest 24, the limit 56): it stays on');
r = run([far(), far(), far({ rtt: 60 }), far({ rtt: 70 })]);
check(r.s.off === true && r.acts[3] === 'off' && r.s.why === 'a round trip of 70 ms (lowest 24)', `on, then two ticks over 24 × 1.5 + 20 ms: off for the session (${r.s.why})`);
r = run([far(), far(), far({ rtt: 40 }), far({ rtt: 45 })]);
check(r.s.kbps === 10000 && !r.s.off, 'on across the internet: the LAN\'s fixed 30 ms doesn\'t apply (40 and 45 ms, lowest 24)');
r = run([far({ rtt: 30 }), far({ rtt: 22 }), far({ rtt: 54 }), far({ rtt: 55 })]);
check(r.s.off === true && r.s.low === 22, `the lowest is the session's own (22 ms, then 54 and 55 > 53): off (${r.s.why})`);
r = run([far(), far(), far({ lost: 3 }), far({ lost: 4 })]);
check(r.s.off === true && r.s.why === 'loss 4%', `on, then two ticks of loss: off for the session (${r.s.why})`);
r = run([far(), far(), far({ direct: false }), far(), far()]);
check(r.acts.join() === ',on,off,,on' && r.s.kbps === 10000 && !r.s.off, `the path stops being direct: off for now, back after two direct ticks (${r.acts.join()})`);
r = run([far(), far(), far({ direct: false })]);
check(r.s.why === 'the path isn\'t direct now', `...and says so (${r.s.why})`);
r = run([far(), far(), far({ rtt: 8 }), far({ rtt: 8 })]);
check(r.s.kbps === 10000 && r.s.kind === 'measured' && r.acts.slice(2).every(a => !a), 'on from the speed tests, then a round trip of 8 ms: stays as it was (no switching between kinds)');
r = run([far({ link: 48 }), far({ link: 48 }), far({ link: 48, limit: 8000 })]);
check(r.s.kbps === 8000 && r.s.why === 'the profile changed', `the profile's limit comes down (Sharp text, 8 Mbps): ${r.s.kbps} (${r.s.why})`);

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
