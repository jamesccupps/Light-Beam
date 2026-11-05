# Changelog

What changed in each release, newest first. Beam's parts are versioned separately:

| Part | Where its version is set |
|---|---|
| Server (and Beam Family) | `package.json` |
| Windows tray app | `windows/src/Version.cs` |
| Android app | `android/app/build.gradle.kts` (`versionName`; `versionCode` always goes up) |
| Beam for Linux / the `beam` command | `cli/beam.js` (`VERSION`) |

Each release is tagged with the server's version (`v1.29.5`). An entry says which other parts moved.

## 1.29.5 (2026-11-05): where things stand

**Versions:** server 1.29.5, Windows app 1.22.1, Android app 1.15.0, Beam for Linux 1.5.1.

- **Server:** the web app (chat, files of any size, the gallery, shared folders, Settings), sign-ins (Tailscale,
  pairing links, approvals, a password), each device's status, history and alerts, app updates one PC at a time,
  remote control's signalling and the relay for Linux computers, daily backups. **Beam Family** runs beside it.
- **Windows app:** the tray, hotkeys, Send to, Windows' own notifications with Reply, transfers that carry on after a
  blip, remote control of the PC (and, once set up on that PC, of its administrator windows and Windows' prompts), the
  keyboard and mouse shared across PCs, shared folders, apps installed on every PC.
- **Android app:** the share sheet, the phone's notifications on your PCs, ringing, remote control of a PC from the
  phone, shared folders, the home-screen widget.
- **Beam for Linux:** the `beam` agent on a Raspberry Pi or other Linux computer (status, temperature, Beam in the
  menu, control of its screen through VNC).

Recent changes:

- **1.29.5:** Measure the delay finishes in a viewer that draws the frames itself (big changes waited out their 3
  seconds). The tests and `docs/API.md` use made-up addresses and device names only. The README has screenshots
  (`docs/images/`, made-up devices on a test server).
- **1.29.4 / Windows 1.22.1:** Measure the delay also times a big change (a window's worth of new text). The picture's
  bandwidth floor works across the internet too, sized from the Connections speed tests of both ends.
- **1.29.3 / Windows 1.22.0:** remote control reaches administrator windows and Windows' prompts on a PC set up for it
  (Settings → Security → This PC → Administrator windows: a small input helper signed with your own certificate).
- **1.29.2 / Windows 1.21.2–1.21.3:** a full review's fixes (app updates on PCs with an older copy still open, clicks on
  notifications from before a restart, Select all in big folders); a text that arrives while a PC is locked is copied
  when it's unlocked.
- **1.29.0–1.29.1 / Windows 1.21.1 / Beam for Linux 1.5.0:** a text size setting; Windows' own notifications with
  Reply, Copy and Open; `beam <folder>` sends a folder as a .zip.
