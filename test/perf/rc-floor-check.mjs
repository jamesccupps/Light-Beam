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

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
