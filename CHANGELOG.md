# Changelog

What changed in each release, newest first. Beam's parts are versioned separately:

| Part | Where its version is set |
|---|---|
| Server (and Beam Family) | `package.json` |
| Windows tray app | `windows/src/Version.cs` |
| Android app | `android/app/build.gradle.kts` (`versionName`; `versionCode` always goes up) |
| Beam for Linux / the `beam` command | `cli/beam.js` (`VERSION`) |

Each release is tagged with the server's version (`v1.29.5`), or, when one app moved alone, with that app's
(`android-v1.16.0`). An entry says which other parts moved.

## 1.30.2 (2026-11-06): a review's last rounds, Beam for Linux, speed, polish and CI

**Versions:** server 1.30.2 (Beam Family with it), Windows app 1.23.1, Android app 1.16.1, Beam for Linux 1.6.0.

- **Beam for Linux:** a big file being saved no longer holds the agent up (it went offline for minutes, and what came
  meanwhile was lost); a file too big for the disk waits instead of filling it; an update must run on that computer's
  Node.js before it takes over, and one that keeps stopping goes back to the version before (and is never taken again);
  Wake-on-LAN is relayed once per device in 30 seconds; notifications show `<`, `&` and backslashes and work in any
  locale; remote control's screen sharing starts once however many ask, and stops when a session ends while starting;
  the log is readable by its own account only; an ARMv6 Pi gets a clear message from the installer.
- **Speed:** finding an item by id no longer scans the list (acks and deletes of many at once were slow on a big Beam);
  an ack of many writes one log line; in the web app many removals draw once, and Select all in a big gallery is quick;
  a very long text shows its start in the conversation and the whole in a window of its own; the Windows app's folder
  scans, settings saves and helper checks no longer run on its window's thread; the Android conversation reuses the rows
  that didn't change during a transfer.
- **Sent once:** a text whose answer was lost on the way and was sent again is the same message (web, Android, Beam
  Family).
- **Storage:** a forwarded file counts once; uploads still arriving are counted against the disk; an upload of unknown
  length stops at the room there is; a full storage limit says what holds it ("800 KB waits for Shelf PC"); an upload
  finished just before Beam stopped is kept; a log that can't be rotated (a viewer holds it) no longer grows without end.
- **Windows:** notifications wait 2 seconds at most; a file that can't be moved into place at once (an antivirus
  holding it, a name taken) tries again; "Save as" replaces in one step; leftovers of files to send are cleared after a
  day; a sent screenshot gets its thumbnail; text boxes, the send picker and the keyboard-and-mouse arrangement work with
  a screen reader and the keyboard.
- **Apps:** a GitHub app's chosen file is found again in a release whose file names carry the new version.
- **Beam Family:** search for short words is quick; the downloads panel no longer loses a click on Stop; text sizes
  follow the browser's setting, with a Text size choice in Appearance.
- **CI:** actions pinned to commits (kept current by Dependabot), read-only permissions, `npm audit` of what ships, the
  Linux installer test required, and Beam for Linux tested on Node.js 20 and 22; the Gradle wrapper's download checked
  against its published checksum.

## Android 1.16.0 (2026-11-06): a review's fixes, the Android app

**Versions:** Android app 1.16.0; server 1.30.1, Windows app 1.23.0, Beam for Linux 1.5.1 (all unchanged).

- **Only approved devices make the phone act by itself:** texts are copied and files downloaded automatically only
  from approved devices (the others still notify, with Copy and Download). Restore settings lists only approved phones'
  backups, and never points the Quick Settings tile or automatic copying at a device that isn't approved.
- **Sending files:** Cancel and pause work while a file is still being prepared (it went anyway). A file is measured
  itself, not by the size its app lists (an edited photo went cut short), and one that turns out longer than it said
  goes again, whole. A shared file that has to wait for a connection is kept by Beam when there's room, so the retry no
  longer fails with "Beam no longer has access to that file".
- **"Wi-Fi only" follows the network:** an automatic download pauses on mobile data and carries on on Wi-Fi (also
  behind Tailscale, where the network doesn't seem to change); one restarted after Beam was stopped waits too.
- **Smaller:** a picture preview from the server can't crash the app however large it says it is; dropped or pasted
  `file://` links are refused, like shared ones; the update screen never starts a second install when it's turned or
  made again; the alarm volume comes back if Beam stopped while ringing; another device's accent change no longer ends
  a remote control session or reloads Shared folders, which isn't kept as a recent-apps snapshot; the viewer pages'
  sign-ins are kept sealed; a full phone is reported as such, not as a connection problem.

## 1.30.1 (2026-11-05): a review's fixes, the Windows app

**Versions:** server 1.30.1, Windows app 1.23.0, Android app 1.15.0, Beam for Linux 1.5.1 (unchanged).

- **Only approved devices make a PC act by itself:** copying a text, opening a link and saving a file automatically
  happen only for this PC's own items or an approved device's (the others still show their notification, with Copy and
  Save). Restore settings lists only approved PCs and never takes another PC's folders. On the server, a sign-in that
  isn't approved can change only its own messages and can't delete everything.
- **Receiving:** a long text whose full copy can't be fetched is never copied as its cut-off preview; an automatic save
  needs room on the drive; a save that fails on the PC isn't reported to the sender as delivered; a saved file is on the
  disk before it's renamed.
- **Outbox:** an entry whose upload a restart interrupted is sent once (it went twice) and then moved to Sent.
- **Apps:** an app never takes over another program's folder of the same name ("Python" goes to "Python (Beam)"), and
  an uninstall removes only the files Beam put there.
- **Remote control and KVM:** "Answer Windows' prompts (UAC)" says what it costs (any program on the PC could answer
  them) and Device info shows the PCs where it's on; the keyboard and mouse link no longer reads a big clipboard at
  every crossing; "Allow remote control" lists only devices that can control a PC and ticks only approved ones.
- **Smaller:** previews only from pictures up to 100 megapixels; names Windows treats as devices are renamed and long
  names keep their extension; shared folders are judged by where they really are (links, subst and network drives); the
  delay probe can't take Beam down; Device info → Beam log → Save works in the app's window; the elevated input-helper
  setup writes only its own result file.

## 1.30.0 (2026-11-05): a review's fixes, server, web app and Beam Family

**Versions:** server 1.30.0 (Beam Family with it; its database moves to version 7), Windows app 1.22.1, Android app
1.15.0, Beam for Linux 1.5.1 (unchanged).

- **Sign-in and trust:** a sign-in that isn't approved can no longer take the id of a device that already has a sign-in
  (approving that device used to approve both); the approval switch says when a device has more than one sign-in.
  Automatic (Tailscale) sign-ins are limited per machine and check the request's own Host header too; a removed or
  unapproved device's pairing links stop working; Wake-on-LAN only for PCs whose Beam app proves itself, a few a minute;
  the setup check and turning down a sign-in need an approved, lasting sign-in.
- **No more stalls from long names or messages:** trimming is linear (a name or message with a very long run of dots,
  spaces or blank lines held the server for seconds).
- **Data:** a move stays paused for as long as its copy runs; a failed import leaves a marker so the server doesn't
  start on half a data folder; static files only by their names on disk; an edited long text isn't served from an old
  copy; thumbnails bigger than 2048 px a side are refused.
- **Web app:** a link that asks to paste shows the paste preview first; a share shows what it holds before you choose
  where it goes; a file queued offline is kept until its upload finishes; messages show above open dialogs; dangerous
  confirmations start on Cancel.
- **Beam Family:** sign-in limits apply before a request's body is read; browser notifications stop when the sign-in
  that turned them on ends (each browser registers again when Family is next opened there); an invite stops working when
  the admin who made it is turned off or made a member.
- **Packaging:** `.dockerignore` keeps backups and Family's data out of images.

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
