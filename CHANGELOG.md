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

## 1.35.2 (2026-11-21): fixes from a review; Notes from Windows' Send to; the phone's Alerts row

**Versions:** server 1.35.2, Windows app 1.27.2, Android app 1.20.2; Beam for Linux 1.6.0 and Beam Family's server
unchanged (its text sizes are named as Beam's).

- **The server no longer stops a minute after a machine is refused automatic sign-in twice** (a log line about the
  refusals was missing its words and threw; the supervisor restarted Beam).
- **One Beam per data folder:** a second `node server.js` on a data folder already in use stops at once, before it
  touches anything (it used to cut an upload in progress short and lose a one-shot upload's file before it noticed
  the port was taken). `pair`, `export`, `backup` and `stop` wait for a busy Beam on that folder instead of deciding
  none is running.
- **A file queued while offline and then cancelled stays cancelled** (it was sent after the next reload of the web
  app), and one retried after a failure is sent once.
- **An upload finished just as Beam stopped is kept:** its item is saved before its upload record goes.
- **Updates of the Windows app go one PC at a time even when the first PC goes away:** another PC is picked when it
  has been offline 5 minutes (it held every other PC until it came back), a PC in a remote control session isn't
  picked first (its app waits for the session to end), and a PC that already runs the build counts as the first.
  The waiting app says so once in its log, not every 30 seconds.
- **Beam's own alerts carry a title** in the Alerts list (Low battery, Server disk, Power loss, Setup check…), and
  the setup check's alert says what is wrong first.
- **Windows: Notes in the Send to picker** (Explorer's Send to, the hotkey, a dragged file) and in Explorer's
  Send to > Beam folder, and under the tray's Send clipboard to.
- **Android:**
  - an upload whose file can't be read any more (deleted or moved before it was read, a cloud file its app can't
    supply, a removed card) stops at once with "Can't read this file any more", and the next upload goes. It said
    "Connection lost, retrying..." for about ten minutes and held every upload behind it.
  - a long text whose whole words can't be fetched waits for the next sync; it was copied and notified cut at 16 KB.
  - one sound for a burst of items: seven at once turned on Android 16's "Notification cooldown", and an urgent
    alert right after was quiet.
  - an Alerts row on the main list, with how many came since the phone last looked, as on the web and Windows.
  - Settings > Alerts has every switch the server has (Tailscale sign-in, power loss, the setup check, a Pi's
    hardware, the server was down); it had three.
  - a photo from the system photo picker is named from when it was taken ("IMG 2026-11-21 16.39.05.jpg"), not by
    its number in the picker ("23.jpg").
- **The web app:** thin scrollbars in the look's colours (the Windows app's window showed Windows' classic ones);
  Settings' list of pages fits the Windows app's default window; the message box says just "Message…" when its whole
  placeholder would wrap (a phone) and is sized right after a first sign-in; a conversation opens at its newest message
  while its pictures load (one could stop a few pictures short); Settings > Shortcuts lines its descriptions up; an app's
  row in Settings > Alerts is no longer indented; a HW Blackbox problem has a red icon (a warning stays yellow); the
  Alerts page has one way to close it.
- **Tests:** two servers on one data folder, a second refused automatic sign-in, an outbox upload cancelled and
  reloaded, the phone's unreadable upload, Notes from Windows. `windows-files` no longer assumes %TEMP% is in
  AppData, and `windows-stream-modes` counts connections after the app's start settles. The first open's size
  budget was raised on purpose (195 KB compressed), and the release run includes both benchmarks.

## 1.35.1 (2026-11-20): HW Blackbox's report in the power-loss alert; steadier tests

**Versions:** server 1.35.1, Windows app 1.27.1; the Android app 1.20.1, Beam for Linux 1.6.0 and Beam Family
unchanged.

- **A power loss's alert says what HW Blackbox saw:** on a PC that runs HW Blackbox, the alert ends with the last
  reading before the PC went down and the power supply's last voltages. While the PC's Beam app is running, the alert
  waits up to 5 minutes for that report; when nobody has signed in yet, the alert goes at once and the report follows
  as a second, shorter one. The Windows app looks for HW Blackbox every minute after it starts until its dashboard
  answers, so the report comes within a minute or two.
- **A file still arriving goes on right after a blip:** the Windows app, saving a big file while its sender is still
  sending, wakes its download when its connection to Beam is back, instead of waiting out a 15-second pause.
- **Apps:** an install answered at the PC while the request came again (after a reconnect) no longer asks a second
  time, and an app found or installed just as the PC reconnected keeps its state on the Apps page.
- **Tailscale's identity check is asked once more** when tailscaled doesn't answer, and a miss is kept 5 seconds
  instead of a minute (it held back automatic sign-in from that device meanwhile).
- **`node server.js stop` waits for a busy Beam:** 2 seconds, then 8 and 20 while something listens on its port.
- **Tests:** the web runner starts a new browser when the one it had went away (and runs that test once more), instead
  of failing every test after it.

## Dependencies (2026-11-18), after 1.35.0

**Versions:** unchanged (server 1.35.0, Windows app 1.27.0, Android app 1.20.1, Beam for Linux 1.6.0); no new release.

- node-datachannel 0.33.6 (Beam Family's direct connections) and eslint 10.15.0, which brings minimatch 11.0.9 (past
  GHSA-g3hv-75wg-m249; a development dependency only). Dependabot's pull request #4 asked for both.
- This repository's Dependabot (`.github/dependabot.yml`: the actions and the npm packages, once a month) and the
  README's screenshot near the top stay.

## 1.35.0 (2026-11-17): HW Blackbox on a PC's page; no second copy of an app

**Versions:** server 1.35.0, Windows app 1.27.0; the Android app 1.20.1, Beam for Linux 1.6.0 and Beam Family
unchanged.

- **HW Blackbox on a PC's page:** where a PC runs [HW Blackbox](https://github.com/jamesccupps/HW-Blackbox) (a
  hardware monitor for Windows), its Beam app reads HW Blackbox's dashboard on that PC (read only, at most every 10
  minutes) and the PC's Device info shows what its Diagnose found: the findings that aren't fine, most serious first,
  and the last time the PC went off without shutting down, with the power supply's last readings before it. On that PC
  itself, a link opens HW Blackbox. The server's log gets its version and counts, never the findings' words.
- **No second copy of an app:** before installing an app from Settings → Apps, a PC looks for one it has already,
  installed some other way (Windows' Installed apps by name, App Paths, a folder of that name in its Programs folder).
  Then nothing is installed and nobody there is asked; the Apps page says "already on it, not from Beam", and Beam never
  updates or uninstalls that one. Before, Beam put its own beside it ("Slate (Beam)" next to Slate), with a second
  Start menu entry. Where that already happened, the Apps page now says the app is also installed outside Beam (and
  Uninstall removes only Beam's copy).
- **A setup program inside a .zip:** a release that ships as a .zip with a setup program at its top (HW Blackbox's
  `Setup.exe`) is installed by running that program (Windows asks for administrator rights at the PC), not unpacked as
  the app.

## 1.34.1 (2026-11-15): fixes from an outside review

**Versions:** server 1.34.1 (and Beam Family), Windows app 1.26.2, Android app 1.20.1; Beam for Linux 1.6.0 unchanged.

- **A sign-in for this session only stays one:** a browser signed in with "Remember me" off could trade its
  sign-in for one that lasted. A sign-in made from a session-only one is now session-only too.
- **Pictures that say they're huge:** Beam Family refuses previews and profile pictures whose header says more than
  2048 pixels a side, as Beam already did for thumbnails (a small file like that takes hundreds of MB to draw). The
  Sites list keeps a site's icon only when it's at most 512 pixels a side and comes from the site's own machine, and
  the Android app draws site icons at the size it shows them, without holding up the list.
- **While another device controls a PC (Windows):** "Let Beam install apps" and the question's "Always allow" can't
  be turned on until that session ends, as with commands. A keyboard-and-mouse banner hidden by the other device's own
  click is hidden for that session only; hidden with the PC's own mouse or keyboard, it stays hidden as before.
- **Windows app:** it no longer follows redirects from the server, looks for Tailscale in Program Files before the
  PATH, and ignores an item whose id isn't one.
- **Building:** docs/BUILDING.md says what the two signing keys can do and where to keep them.
- **Tests:** Beam Family's direct-connection tests skip, saying why, where there's no network address.

## Windows 1.26.1 (2026-11-15): out of a game that holds the mouse

**Versions:** Windows app 1.26.1; server 1.34.0, Android app 1.20.0, Beam for Linux 1.6.0 (all unchanged).

- **Remote control gets out of a game:** a game playing in a window (Minecraft, for one) keeps the mouse inside its
  window, and Windows kept the viewer's taps and clicks in there too, so nothing outside the game could be reached
  (the taskbar, another window). A tap or click outside the game's window now lands where it was aimed: that window
  comes to the front and the game lets go of the mouse, as with a touch screen. Inside the game's window everything
  still goes to the game.

## 1.34.0 (2026-11-14): Notes

**Versions:** server 1.34.0, Android app 1.20.0 (the Windows app and Beam for Linux are unchanged).

- **Notes:** a conversation with yourself under All devices, for anything to keep for later: write, paste or drop
  text, links, pictures and files there. A note is a message to the device it was sent from, so every device shows
  every note and none of them buzzes or acts on one; the server keeps notes until they're deleted (the clean-ups
  skip them, as they skip pinned items) and never pushes them to ntfy. A note's menu has Done (it's struck
  through), Edit, Send to… and Delete; every other message has Save to Notes. On Android the share sheet and the
  clipboard tile can save to Notes; so can `beam send --to notes "…"` and the target name `notes` in the API.
  `note` and `done` on items, `PATCH /api/items/{id} {"done"}`, feature `notes` (docs/API.md, "Conversations").
- **Fixed:** in the web app, the Alerts or Phone row going away from the sidebar could leave the next row with
  nowhere to go (an error, and a sidebar drawn only partly).

## 1.33.0 (2026-11-10): Alerts from your other programs

**Versions:** server 1.33.0, Windows app 1.26.0, Android app 1.19.0.

- **The alerts inbox:** your other programs send their alerts to Beam the way they'd send them to ntfy (JSON to
  `<Beam>/notify/`, text and headers to `<Beam>/notify/<key>`, `…/trigger` by GET, an access token), or as any webhook's
  JSON; each program gets its own key in Settings → Alerts (shown once, kept hashed, it sends alerts and nothing else).
  They show up under Alerts (a row in the sidebar, in place of a conversation; the Android app's menu) with Beam's own
  alerts: newest first, a chip per program, title (with its tags' emojis), text, Open and its link buttons, High and
  Urgent marked. Priority 3 and up pops up on every device (Windows' notifications, Android's, the browser's), 1-2
  are only listed, and a program can be muted or snoozed. Approved devices only; never an alert's words in a log.
  `/notify`, `/api/inbox`, `/api/inbox/senders`, `/api/inbox/alerts`, the `inbox` events (docs/API.md "The alerts
  inbox"). The emoji names are gemoji's (MIT, Copyright (c) 2019 GitHub, Inc.: `lib/emoji.js`).

## 1.32.0 (2026-11-07): Commands on a PC

**Versions:** server 1.32.0, Windows app 1.25.0, Android app 1.18.0.

- **Commands on a PC:** Device info → Run a command (the web app, the Windows app's window, the Android app): a
  PowerShell or Command Prompt command on one of your PCs, its output (errors in their own colour) while it runs, Stop
  (the whole process tree), the exit code, Copy, recent commands kept in that browser. Only the devices that may
  control that PC can, and only once "Allow commands too" is on at that PC (its tray menu or Settings → Security);
  turning remote control off turns it off too. It runs as the PC's signed-in user in a hidden window, never as
  administrator; PowerShell gets the command on its input (never on its command line). The logs say who ran one and
  how it ended, never the command or its output. `POST /api/devices/{id}/commands` (answered with an event stream),
  `GET /api/commands/{run}`, `POST /api/commands/{run}/stop`, status `commands` (docs/API.md "Commands on a PC").

## 1.31.0 (2026-11-06): Sites

**Versions:** server 1.31.0, Windows app 1.24.0, Android app 1.17.0.

- **Sites:** the web pages your machines serve over Tailscale, in one list on every device: the globe at the top of
  the web app (and the Windows app's window), Sites in the Android app's menu. Each PC's Beam app finds the pages that
  PC serves to the tailnet (programs listening on every address or the Tailscale one, on the ports web pages use,
  whose front page is a web page), listed at its Tailscale name. Pages on machines without the Windows app are added
  by address. When the list opens, the server checks each one: whether it answers (with the reason when it doesn't),
  its title and its icon. A site can be renamed; a found one hidden, an added one removed. Approved devices only.
  `GET/POST /api/sites`, `PATCH/DELETE /api/sites/{id}`, `POST /api/sites/check`, the `sites` event, status `sites`
  (docs/API.md "Sites").

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
