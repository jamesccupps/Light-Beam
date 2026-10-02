# Beam Family

The family's own chat, like Discord or Teams but on your own machine: a family space with channels, direct and group
conversations, photos and files, replies, reactions, mentions, notifications, history kept for good, and search.

It is a **separate server** (`family/server.js`) with its own process, data, port and address. Beam's device hub
(clipboard, files between your devices, remote control, phone notifications) is a different server and doesn't
change. That separation is deliberate: Beam Family can be opened from the internet (the public link), and the
internet must never be one bug away from the server that can control your PCs.

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

It needs Node 22.13 or later (it uses the built-in `node:sqlite`). No other dependencies besides Beam's own
(`qrcode`, for invite QR codes).

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
  expired sign-ins and invites are cleaned up daily. (1.7.2)
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
  `PUT /api/files/:id/thumb?w=&h=`, `GET /api/files/:id[?download]`, `GET /api/files/:id/thumb`,
  `GET /api/people/:id/avatar`.
- Push: `GET /api/push` (VAPID key), `PUT /api/push {endpoint, keys}`, `DELETE /api/push {endpoint}`.

## Tests

`node test/family.test.js` (the server; ports 8841–8849) and the `family:` tests in `node test/web/run.mjs` (the
app in a headless browser; port 8828).
