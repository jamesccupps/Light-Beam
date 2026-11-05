'use strict';
// (2026-11-05, the user's review M1) Trimming in linear time. A regex like /^[\s.]+|[\s.]+$/g or /[ \t]+$/gm tries again
// from every position of a long run, so its time grows with the square of the run: 64,000 dots in a file name held
// Beam for 7 s on one request, 64,000 spaces in a Family message Family for 12 s, every other request waiting.
// Used by Beam (server.js, lib/apps.js) and Beam Family (family/lib); cli/beam.js has its own copy (one file).

// The ends of `s` where `isTrim(c)` holds, cut off.
function trimEnds(s, isTrim) {
  let a = 0, b = s.length;
  while (a < b && isTrim(s[a])) a++;
  while (b > a && isTrim(s[b - 1])) b--;
  return s.slice(a, b);
}

// Spaces (any kind) and dots: what Windows can't have at either end of a file name.
const isSpaceOrDot = c => c === '.' || /\s/.test(c);

// Each line's trailing spaces and tabs, cut off.
function trimLineEnds(s) {
  return s.split('\n').map(line => {
    let b = line.length;
    while (b > 0 && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
    return line.slice(0, b);
  }).join('\n');
}

module.exports = { trimEnds, isSpaceOrDot, trimLineEnds };
