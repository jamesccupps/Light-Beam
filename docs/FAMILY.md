# Beam Family

The family's own chat, like Discord or Teams but on your own machine: a family space with channels, direct and group
conversations, photos and files, replies, reactions, mentions, notifications, history kept for good, and search.

It is a **separate server** (`family/server.js`) with its own process, data, port and address. Beam's device hub
(clipboard, files between your devices, remote control, phone notifications) is a different server and doesn't
change. That separation is deliberate: Beam Family can be opened from the internet (the public link), and the
internet must never be one bug away from the server that can control your PCs.

### Big files from a phone (1.8.3)

A message with files appears for everyone when its files are all there. Meanwhile the sender sees how far they are
("Sending 210 MB of 1.9 GB (11%)") with Cancel. The app is a web page, and a phone pauses a page that isn't in front
(another app, the screen locked), so the screen stays on while files are going and Beam Family should stay open
until they're sent; a message that stopped while the page was paused carries on by itself (from where the server got
to) when the app is back in front, and "Try again" does the same. A page that's gone (closed, reloaded, dropped by the
phone) loses the message it showed, but the files stay on the server for a day: opened again, the app offers them
("clip.mp4 stopped at 390 MB of 1.9 GB": pick it again and it goes on from there; one that's all there is attached at
once; or Discard) (1.8.4). The same file can't be attached twice. Until it's sent, a message says "Sending…" where its time goes, with how far
above its pictures (dimmed); it stays through a restart of the server (an update), and an open page reloads itself
into a newer Beam Family once nothing is being sent from it (the live stream's `hello` carries the version) (1.8.5). Through the public link the files go via
Tailscale's relay, which caps the speed (about 20 Mbit/s seen on 2026-10-03, even at home); a phone with Tailscale
goes directly. The largest file is `BEAM_FAMILY_MAX_UPLOAD_MB` (2 GB unless set).

### Fast links and direct connections (1.9)

A **fast link** is a file for anyone who has the link, no account needed, until it runs out (1 hour to 30 days) or is
switched off: "Fast link" on a file in the chat (its message's menu, the viewer), or "Make a fast link" (the paperclip)
for a file on this device, which uploads it and makes the link at once (the link follows the upload as it comes). The
link is `https://<address>:8443/f/<32 characters>`; only a hash of the secret is kept. Its page shows the file and
who shared it: **Download** fetches it straight from this computer over a **direct connection** when one comes up
(WebRTC; written to a file as it comes: a save dialog on a computer, the browser's downloads on a phone through the
service worker), else over https; **Download in the background** is https, for the phone's own download manager (it
goes on with the screen locked). 30 wrong links a minute from one address get a wait.

Direct connections (`family/lib/direct.js`, node-datachannel) also carry the app's big uploads (8 MB and up; the rest
over https from where the server got to if one drops). On the same network the connection stays inside it; elsewhere it
skips Tailscale's relay (through the public link uploads ran ~1–2 MB/s). It needs a way in: an internet peer works
because this end sends first, but a phone on the home network has to reach this computer itself, so on Windows add one
firewall rule (in an administrator PowerShell; it covers only those ports, only from the home network):

```powershell
New-NetFirewallRule -DisplayName "Beam Family direct connections (home network)" -Direction Inbound -Action Allow -Protocol UDP -LocalPort 41700-41799 -Program "C:\Program Files\nodejs\node.exe" -Profile Private -RemoteAddress 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
```

Without it (or when a network blocks direct connections) everything still works over https. The log says how each
direct connection went ("came up on the same network / over the internet / didn't come up").

## Running it

```
node family/server.js               run it (127.0.0.1:8766)
node family/server.js --supervise   run it and restart it if it crashes
node family/server.js stop          stop it cleanly (and its supervisor)
node family/server.js invite [--admin] [--uses n] [--days n]
node family/server.js invite --owner   the owner's link, when nobody owns it yet
node family/server.js status
```

Settings (environment or `.env`):

| Setting | Default | |
|---|---|---|
| `BEAM_FAMILY_DATA` | `family-data/` | its data folder (made private to the account it runs as) |
| `BEAM_FAMILY_HOST`, `BEAM_FAMILY_PORT` | `127.0.0.1`, `8766` | where it listens: keep it on 127.0.0.1, behind `tailscale serve` / Funnel |
| `BEAM_FAMILY_URL` | — | the address people use (invite links, push); also read by Beam's own server for its "Beam Family" link |
| `BEAM_FAMILY_NAME` | `Family` | the first space's name (rename it later in the app) |
| `BEAM_FAMILY_OWNER` | the machine's Tailscale user | whose first visit over Tailscale sets them up as the owner |
| `BEAM_FAMILY_MAX_UPLOAD_MB` | `2048` | the largest file |
| `BEAM_FAMILY_MAX_STORAGE_GB` | `100` | all files together; when full, uploads are refused (nothing is ever deleted to make room) |
| `BEAM_FAMILY_STUN` | Google's and Cloudflare's | (1.9) STUN servers direct connections find their way with (they see addresses, never files); `local`: the same network only; `off`: no direct connections |
| `BEAM_FAMILY_DIRECT_PORTS` | `41700-41799` | (1.9) the UDP ports direct connections use |
| `BEAM_FAMILY_BACKUP_DIR` | `backups` next to the data folder | **(1.8.1)** where its backups go (another drive or a NAS keeps them safe from a failing disk) |
| `BEAM_FAMILY_BACKUP_HOURS`, `…_KEEP`, `…_FILES_MB` | `24`, `14`, `1024` | a backup that often (`0`: none), the newest kept, files in it up to that size |

It needs Node 22.13 or later (it uses the built-in `node:sqlite`). No other dependencies besides Beam's own
(`qrcode`, for invite QR codes).

**Backups (1.8.1).** Every day (`BEAM_FAMILY_BACKUP_HOURS`) Beam Family saves `family-backup-<UTC time>.tar.gz`: its
database as a snapshot taken while it runs (SQLite's `VACUUM INTO`, never a copy of the live file), `control.key`,
`vapid.json` (the phones' push subscriptions belong to it), the avatars, and the files and their previews while they
add up to at most `BEAM_FAMILY_BACKUP_FILES_MB`. The newest 14 are kept. `node family/server.js backup` makes one now.
To restore one: `node family/server.js stop`, then `node family/server.js restore <backup> --force` (the data that was
there moves to a `replaced-…` folder in the data folder, nothing is deleted), then start it again.

## How people get in

One address for everyone, e.g. `https://<machine>.<tailnet>.ts.net:8443`:

```
tailscale serve --bg --https=8443 http://127.0.0.1:8766     tailnet only
tailscale funnel --bg --https=8443 http://127.0.0.1:8766    also the public link (Funnel: ports 443, 8443, 10000)
```

Funnel is per port: Beam's own server stays on 443, tailnet-only.

- **Over Tailscale** (your tailnet, and people you **share the machine with** in the Tailscale admin console):
  `tailscale serve` adds `Tailscale-User-Login` / `-Name` / `-Profile-Pic` and strips any a client sends. A known
  login is signed in at once. An invite link opened over Tailscale binds that login (no password needed).
  - Sharing a machine needs a Tailscale account and app on the other person's side, and shares **every port** of it
    (Beam's own server too) unless the tailnet policy limits `autogroup:shared`, e.g. to `tcp:8443`. For family
    members, the public link is usually simpler.
- **The public link** (Funnel): never any identity headers. People join with an invite link and choose a name and a
  password; afterwards they sign in with them. Sessions are cookies (`fam_s`, HttpOnly, SameSite=Lax, Secure on
  https), kept 90 days from their last use.
- **The owner**: the machine's Tailscale user (or `BEAM_FAMILY_OWNER`) on their first visit over Tailscale, or whoever
  opens `invite --owner`'s link. They get the space "Family" with #general and #photos.
- **Roles**: owner (everything), admins (invites, people, channels, deleting any message), members.
- **Invites**: single use by default, 7 days, shown once (with a QR code), withdrawable. A **password reset link** for
  one person (admins: People & channels → ⋯) lets them choose a new password once within 3 days.
- **Turning someone off** ends their sessions, live connection and notifications at once; their messages stay.

## The app

`family/public/` (no build step): the browser, and as an installed app (PWA) on phones and computers. On an iPhone or
iPad, notifications need the home-screen app (Share → Add to Home Screen). Beam's own apps link to it: the web app's
♥ button and the Android app's menu open it in the browser, where notifications work.

## Security model

- It listens on 127.0.0.1 only. Tailscale's identity headers are believed only from this machine (where `tailscale
  serve` connects from), for a caller at a Tailscale address, and never on a Funnel request (1.7.2: local checks on
  top of serve removing any such header a client sends, as Tailscale documents). **Limit:** a program running on the
  server machine itself can connect directly and claim any identity, as with Beam's own server: the machine is
  trusted.
- Live streams: ending a sign-in (signing out, "other browsers", a new password, a reset link) ends the streams it
  opened at once; at most 20 per person; a stream that stops reading is dropped at 1 MB unread; 1,000 connections in
  all. A request body has 60 s to arrive (a piece of a file 15 min). (1.7.2)
- Unsent uploads: 30 at a time per person (their declared sizes count against the storage until sent or swept);
  expired sign-ins and invites are cleaned up daily. (1.7.2) The sender can drop one at once (`DELETE
  /api/uploads/:id`: the tray's ×, Cancel on a message still sending); otherwise one that stopped goes a day after its
  last piece. (1.8.3)
- Changes need the app's own pages: `Sec-Fetch-Site` same-origin (or a matching `Origin`) and JSON bodies; both ways
  in are ambient (cookies, Tailscale), so this is what stops another site from acting as you.
- Who sees what is checked on every request: channels for the space's members, DMs and groups for theirs; files only
  through a message you can see (or your own unsent upload). A file or preview a browser has cached is checked again
  before each use (a quick `304`), so it stops showing once its message is deleted or you leave its conversation
  (1.7.3; it was kept a day).
- Text is always text in the app (no HTML from messages); only http(s) links become links. Files show inline only as
  pictures, video or sound a browser plays, everything else downloads; every file answer is sandboxed and `nosniff`.
- Passwords: scrypt (N=2^15, r=8, p=1), at least 10 characters (1.7.3; was 8), not a well-known one, not a run along
  the keyboard or the alphabet, not one or two characters over and over. At most 4 are checked at once (a crowd waits
  its turn; past 200 waiting: "try again"). Sign-in: 10 tries per address per 10 minutes (the address Funnel saw: the
  last `X-Forwarded-For` entry; checked first, so a held-back address doesn't use up the rest), 120 a minute in all;
  wrong passwords count per name *and* address (10 an hour), so guessing at someone's name from elsewhere can't lock
  them out (1.7.3: it was 20 per name per hour from anywhere), plus 200 an hour per name from everywhere, which an
  address with a live session for that person doesn't hit. Checking the current password when changing it counts the
  same. Unknown names take as long as wrong passwords.
- The session cookie: over https `__Host-fam_s` (1.7.3: host-only, `Secure`, `Path=/` by the browser's own rules, so
  another machine under the same ts.net name can't plant one; a browser with the old `fam_s` gets the new one on its
  next visit), over plain http `fam_s`. `Secure` whenever the request came over https (1.7.2). Cookies don't tell
  ports apart: a browser sends Beam's own cookie (`beam_key`) here too and this server ignores it; for full separation
  run Family on a Tailscale machine of its own.
- Admins can make a reset link for anyone's password (they could then sign in as them and read their messages): an
  admin is trusted with that, as with turning someone off.
- Anonymous visitors (the public address is in certificate logs) see the sign-in page only, not the family's name.
- Notifications: Web Push signed with the server's VAPID key and encrypted for each browser (RFC 8291); only the push
  services browsers use (Google, Apple, Mozilla, Microsoft) are ever contacted.
- JSON bodies are at most 64 KB (and have 60 s to arrive, above). Answers over 4 KB are compressed off the event
  loop (1.7.3).

## API

JSON under `/api`, live events at `/api/events` (server-sent events; `Last-Event-ID` replays what was missed, else
`resync`). The code is the reference (`family/lib/*.js`); in short:

- Session: `GET /api/session`, `POST /api/signin {name, password}`, `POST /api/signout`.
- Invites: `GET|POST /api/invites/:code` (see / join, or use a reset link), `POST /api/invites {role, uses, days}`,
  `GET /api/invites`, `DELETE /api/invites/:id`; `POST /api/people/:id/reset`.
- `GET /api/bootstrap`: me, people, spaces, channels with unread/mention counts and notification levels.
- Me: `PATCH /api/me {name, color, password, current}`, `PUT|DELETE /api/me/avatar`, `GET /api/me/sessions`,
  `DELETE /api/me/sessions/:id|others`. Admins: `PATCH /api/people/:id {role, disabled}`.
- Spaces and channels: `PATCH /api/spaces/:id`, `POST /api/spaces/:id/channels`, `PATCH /api/channels/:id`,
  `POST /api/dms {people, name}`, `DELETE /api/channels/:id/members/me`.
- Messages: `GET /api/channels/:id/messages?before|after|around`, `POST /api/channels/:id/messages {body, reply,
  files, nonce}` (mentions as `<@id>`, `@everyone`), `PATCH|DELETE /api/messages/:id`,
  `PUT|DELETE /api/messages/:id/reactions/:emoji`, `PUT|DELETE /api/messages/:id/pin`, `GET /api/channels/:id/pins`,
  `POST /api/channels/:id/read {id}`, `POST /api/channels/:id/typing`, `PUT /api/channels/:id/notify {level}`,
  `GET /api/search?q=&channel=`, `PUT /api/focus {client, channel, visible}`.
- Files: `POST /api/uploads {name, size, mime}`, `PUT /api/uploads/:id?offset=`, `GET /api/uploads/:id`,
  `DELETE /api/uploads/:id` (1.8.3, only one's own and only while unsent), `GET /api/uploads` (1.8.4: one's own unsent ones,
  `{ uploads: [{ id, name, size, received, mime, created, linked }] }`),
- Direct connections (1.9): `POST /api/direct {sdp}` → `{sdp}` (the browser's offer with its candidates, the answer with
  ours); then a data channel per transfer, labelled `{"op":"get","file","offset"}` (binary from the offset on, then
  `{"done":true,"size"}`; a file still arriving is followed) or `{"op":"put","upload","offset"}` (binary in; `{"offset"}`
  each 2 MB kept, then `{"done":true}`); `{"error"}` and closed when something's wrong.
- Fast links (1.9): `POST /api/files/:id/links {hours}` → `{link: {id, url, expires}}` (the url only now),
  `GET /api/files/:id/links`, `DELETE /api/links/:id`; for anyone with the link: `GET /f/:token` (the page),
  `GET /api/links/:token` (name, size, mime, received, from, expires, preview, direct), `GET /api/links/:token/file`
  (https, Range, follows an upload), `GET /api/links/:token/preview`, `POST /api/links/:token/direct {sdp}`.
  `PUT /api/files/:id/thumb?w=&h=`, `GET /api/files/:id[?download]`, `GET /api/files/:id/thumb`,
  `GET /api/people/:id/avatar`.
- Push: `GET /api/push` (VAPID key), `PUT /api/push {endpoint, keys}`, `DELETE /api/push {endpoint}`.

## Tests

`node test/family.test.js` (the server; ports 8841–8849) and the `family:` tests in `node test/web/run.mjs` (the
app in a headless browser; port 8828).
