# noVNC 1.7.0, vendored

The browser VNC client that Beam's viewer for Linux computers uses (`public/vnc.js`, Beam 1.23). These are unchanged
files from https://github.com/novnc/noVNC, tag `v1.7.0`: `core/`, `vendor/pako/lib/` and the licence texts
(`LICENSE.txt`, `AUTHORS`, `docs/LICENSE.*`, `vendor/pako/LICENSE`). Each file was checked against GitHub's own list of
that tag's files (their git blob SHA-1s) before it was added.

Licences: noVNC's core is under the MPL 2.0 (`docs/LICENSE.MPL-2.0`); `core/crypto/des.js` carries BSD-style terms in
the file itself; pako is under the MIT licence (`vendor/pako/LICENSE`). Beam itself is MIT; these files keep their own
licences, and Light Beam publishes them exactly as they are here.

To update: replace this folder with the same parts of a newer tag, check them the same way, and run the web test
"Control for a Linux computer".
