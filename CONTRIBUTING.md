# Contributing

Thanks for looking! Bug reports, fixes and ideas are all welcome. For anything bigger than a fix, please open an
issue first, so we can agree on the shape before you spend time on it.

## How the code is laid out

| Path | What |
|---|---|
| `server.js`, `lib/` | The Beam server (Node.js 20.12+; its only dependency is `qrcode`). All state lives in `data/` (or `BEAM_DATA`). Also a CLI: `node server.js help` |
| `public/` | The web app: plain scripts sharing one scope, loaded in order (no build step). Also the Windows app's chat window (WebView2 "host mode", see [docs/HOST-BRIDGE.md](docs/HOST-BRIDGE.md)). The viewer for Linux computers (`vnc.js`) is an ES module using noVNC, vendored unchanged in `public/novnc/` (MPL-2.0) |
| `family/` | Beam Family: its own server (`family/server.js`, Node 22.13+ for `node:sqlite`), modules in `family/lib/`, and its web app in `family/public/` (ES modules, no build step) |
| `cli/beam.js` | The `beam` command-line tool; also **Beam for Linux** (`beam agent`, installed by `linux/install.sh`, built by `linux/build.mjs`) |
| `windows/` | The Windows tray app (C# 5 / .NET Framework 4.8, built by `windows\build.cmd` with the compiler built into Windows; WebView2 SDK vendored in `windows/lib/webview2/`) |
| `android/` | The Android app (Kotlin, Views, OkHttp) |
| `test/` | Server, Beam Family and web tests; speed budgets and Windows checks in `test/perf/` |
| `docs/` | [API.md](docs/API.md) (the protocol every client speaks: the source of truth), [FAMILY.md](docs/FAMILY.md), [HOST-BRIDGE.md](docs/HOST-BRIDGE.md) |
| `scripts/`, `deploy/`, `Dockerfile` | Installing on Windows, a systemd unit, Docker (untested) |

## Ground rules

- **No build step** for the web apps, and **no new dependencies** unless there's no reasonable way around one.
  Everything should keep running from a plain `git clone` + `npm install`.
- **Protocol changes go in [docs/API.md](docs/API.md)** in the same change; every client follows it.
- **Plain words in the interface:** say what happened and what to do, without jargon.
- **Match the code around you:** naming, comment density, idioms. Comments explain *why*, not *what*.
- **Security-sensitive changes** (sign-in, tokens, file serving, identity headers, updates) need a test that shows
  the attack failing, not only the happy path.

## Tests

Every change comes with tests, and the suites it touches should pass:

```bash
node test/server.test.js [filter]   # the server
node test/family.test.js            # Beam Family
node test/web/run.mjs [--only re]   # the web apps, in headless Edge/Chrome
```

- The tests start their **own scratch servers** with throwaway data folders, on fixed port ranges (server
  8791–8799, web 8821–8829, Beam Family 8841–8849). Never point a test at the Beam you actually use.
- Windows app: `windows\build.cmd` must build cleanly; `node test/perf/windows-regress.mjs all` runs the app's
  regression checks against a scratch server, with an isolated config (`--config`), never your real one.
- Android: `gradlew testDebugUnitTest lintDebug assembleDebug` in `android/`. About 50 integration tests skip
  unless `BEAM_TEST_URL` / `BEAM_TEST_KEY` point at scratch servers.
- Speed: `node test/perf/server-bench.mjs` fails when a budget is broken.

## Pull requests

- One topic per pull request, with a short description of what changes for the person using Beam.
- Say which suites you ran, on which system.
- Don't include builds (`dist/`), data folders, `.env` files or signing keys; `.gitignore` keeps them out.

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).
