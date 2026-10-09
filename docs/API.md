# Beam API (v3)

Every Beam client (web app, Windows app, Android app, CLI) talks to the Beam server with this API.
The server is a hub: items (text or files) are sent *to* one or more devices, stored on the server,
and picked up by the target devices, even if they were offline when the item was sent.

**What's new in v3** is marked **(v3)**, and what server 1.3 added on top is marked **(1.3)**. Everything from v2 still
works unchanged: clients that hold the master key keep working. `GET /api/hello` and `GET /api/info` report `api: 3`
and a `features` list; check those before relying on something new. 1.3 adds the features `device-status`, `ring`,
`wake`, `remote-desktop` and `alerts`. Server 1.4 marks its additions **(1.4)** and adds the features `stream-modes`
(background event streams and poke), `items-since` (delta sync), `gzip` (compressed JSON), `live-download` (downloads
of files still arriving), `big-chunks` (upload chunks of any size) and `clear-cache` (`POST /api/clear-cache`), plus
`GET /api/metrics`. Server 1.5 marks its additions **(1.5)** and adds the feature `phone-notifications` (a phone's
notifications on your PCs). Server 1.6 marks its additions **(1.6)** and adds the feature `remote-control` (see and
control a PC's screen from another device). Server 1.8.1 adds `backups` (the apps' settings, the server's own backups)
and 1.13 `fast-links` (a fast link for a file, made by Beam Family on the same machine; listed when `BEAM_FAMILY_URL`
is set), 1.14 `replies`, `reactions` and `edit` (Beam's chat), 1.16 `kvm` (keyboard and mouse across PCs) and 1.17
`connections` (how the server reaches each device over Tailscale, the devices' Tailscale state and `tailscaleKey`
alerts) and 1.18 `history` (each device's history, `powerLoss` alerts) and `speed-test` (speed tests between a
device and the server), and 1.19 `staged-updates` (a Windows build goes to one PC first), 1.20 `setup-check` and
`device-logs` (shipped with 1.19's in Beam 1.20.0), 1.21 `apps`, 1.22 `linux` (Beam for Linux) and 1.23 `vnc` (control
of a Linux computer, relayed). Use each one only when its flag is there; everything older keeps working.

## Credentials

There are three kinds of secrets. Clients treat all of them as opaque strings and store whatever they are
handed as their `key`.

| Secret | Looks like | What it is |
|---|---|---|
| **Device token** (v3) | `bt_…` | Belongs to one device. Every sign-in hands out one of these. It can be revoked on its own. |
| **Pairing token** (v3) | `bp_…` | Goes in pairing links and QR codes. It works **once**, within **15 minutes**, and then becomes the device token of the device that used it. |
| **Master key** | anything else | The original shared key, in `data/key`. It still works everywhere (legacy clients, admin), but no sign-in path hands it out any more. |

Send the secret as `Authorization: Bearer <secret>` (apps, CLI) or in a cookie (browsers; the server sets it,
`HttpOnly`): over https `__Host-beam_key` (host-only, `Secure`, `Path=/`: no other machine of the tailnet can plant
it; audit S-10), over plain http `beam_key`. The server reads `__Host-beam_key` first (since 1.7.6), then `beam_key`
over plain http only: since 1.11.1 `beam_key` over https isn't read (1.7.7 had moved every page's sign-in over: every
sign-in over https sets `__Host-beam_key` and clears `beam_key`). The Windows app's pages still set both; harmless.

- **A device token speaks for its device (v3).** Once a token is bound to a device, the server uses that device's id
  whatever `X-Beam-Device-Id` says. A token issued without a device id is bound to the first id it is used with.
- **Moving off the master key (v3):**
  - A request authenticated with the master key and carrying a device id gets back an `X-Beam-Token: bt_…` response
    header. Browsers get a `Set-Cookie` instead. It is the same token every time for that device.
  - Clients that understand the header should **replace their stored key with it**, and drop the master key.
  - Old clients just ignore it.
- **Revocation (v3):**
  - `DELETE /api/devices/{id}` revokes that device's tokens and closes its event streams. Its next request gets `401`.
  - It also **blocks the device's Tailscale machine** from signing in automatically, so a lost phone that is still on
    your tailnet can't just sign back in (see `blockedNodes` under Settings).
  - The password and approval still work for a blocked machine; the owner decides those.
  - `POST /api/security/sign-out-others` also changes the master key and blocks every other device's machine.
    `{ "disableTailscaleSignIn": true }` also turns automatic Tailscale sign-in off, for "my phone was stolen".
  - A device that still holds the master key can come back until the master key changes.
  - **The real kill switch for a lost device is removing it from your Tailscale account** (admin console). Beam can
    only block the machines it has seen.
- **Sessions (v3):** a sign-in with `remember: false` gets a token that expires after **12 hours without use**. The
  browser gets a cookie without `Max-Age`. Its device is marked `temporary: true` and is forgotten when the session
  ends. Use this for borrowed computers.
- **Other expiry (1.7.3):** a browser's sign-in (platform `web`) ends after **180 days without use** (on the tailnet a
  browser signs itself back in); one approved for a move **48 hours** after it was made, and sooner when the move is
  done or called off. A Beam app's sign-in doesn't expire. Once a device's migration token (the one offered to a
  client still on the master key) is revoked, its next one is a different value.
- **Reserved fields (v3):**
  - Token records and devices carry `user: "owner"`, tokens also `role: "owner"`, and `/api/me` reports them.
  - Everyone is the owner today. The fields are there for a future multi-user version: ignore them, don't depend on
    their values.

Clients generate a **device id** once: a random string of 8–64 characters from `[A-Za-z0-9_-]`, for example a
UUID without dashes. Store it forever; it is the device's identity.

## Pairing links

A pairing link looks like `https://beam.example.ts.net/?key=bp_…`.

- **Server base URL** = the link's origin (scheme + host + port). **Key** = the `key` query parameter.
- **Apps** use the key as their Bearer secret. On first use a pairing token turns into that app's device token
  (same secret), so they can keep it. Check it with `GET /api/me`. (Apps also take an older link with the master key:
  it goes in the Bearer header, never in a URL the server sees.)
- **Browsers** opening `/?key=bp_…` are redirected to `/` with a cookie holding a **new** device token, and the key
  disappears from the address bar.
  - **(1.7.3)** Only an unused pairing key signs a browser in there. A link with the master key or a device's own
    token no longer does (it would stay in the browser's history and in a proxy's logs): the page says the link
    didn't work, and the server logs it once. Those secrets still sign in on the sign-in page (`POST /api/login`).
  - A page that acts as a device gets a sign-in of its own with `POST /api/login` and that device's token in the
    body: the Android remote-control viewer does. (The Windows app gives its WebView the app's token as a cookie.)
- `GET /api/pair` creates a fresh pairing token for building links and QR codes (see Other). **(v3)**

## Signing in a new device

Here are the ways in, from most to least seamless.

**0. Automatically (v3).** `POST /api/autopair` with an optional JSON body
`{ "client": "app" | "web", "deviceId", "name", "platform" }`. It succeeds when:
- **Tailscale vouches for an owner.** This means the request came through `tailscale serve` on the Beam machine, with
  the `Tailscale-User-Login` header. It must come from a Tailscale address and not through Funnel. `tailscale whois`
  must confirm that address belongs to that login (since 1.7.2 no answer counts as no: while tailscaled can't be
  reached, automatic sign-in waits), the login must be one of this Beam's owners, and the `tailscaleSignIn` setting
  must be on. Owners are:
  - `BEAM_TAILSCALE_OWNERS`;
  - accounts learned automatically when a signed-in device makes a request through tailscale serve;
  - the first account to sign in to a brand-new Beam.
- (Until 1.14.3 also a browser while a Beam app was connected from its machine. With Beam on 127.0.0.1 that was any
  local process or account, so such a browser now signs in like any other: the password, a pairing link, or approval,
  which the Beam app on that machine can give.)

Either way only at **this Beam's own address** (1.7.2): the `Host` (or a trusted proxy's `X-Forwarded-Host`) must be
an IP address, `localhost`, this machine's name (or `<name>.local`), its Tailscale name, the public address, or an
address Beam has seen through tailscale serve. A page on another name pointed at the server (DNS rebinding) gets no
sign-in. Behind your own reverse proxy with its own name, set `BEAM_PUBLIC_URL`.

Answers:
- apps: `200 { "key": "bt_…", "server", "via": "tailscale", "you": "<device id>" }` (the server makes up a device
  id if you sent none);
- browsers: `200 { "device", "via" }` plus a cookie;
- otherwise `403 { "error", "reason" }`. `reason` is one of `no-identity`, `not-owner`, `disabled`,
  `whois-mismatch`, `whois-unavailable` (tailscaled couldn't confirm it), `host` (not this Beam's own address), `no-app`,
  `blocked` (the machine was removed; see Revocation).

Apps should try this first when they reach Beam over its `https://…ts.net` address.

**1. Approve from a device that's already signed in (Steam-style).**
1. The new device calls `POST /api/login-requests` with
   `{ "name": "Work Laptop", "platform": "windows", "deviceId": "…", "remember": true }`.
   - No key is needed.
   - `deviceId` (v3, optional) binds the resulting token to that id. It also lets the device recognise its own request
     in lists and events.
   - `remember: false` (v3) asks for a session sign-in.
   - The answer is `201 { "id", "code": "K7QM-4R2X", "secret", "approveUrl", "qrSvg", "expiresAt" }`.
   - Limits: at most **3 pending** requests per address and **30** in total (v3); settled requests don't count.
2. It shows the QR code (`qrSvg` is ready-made SVG of `approveUrl`) and the `code`.
3. It long-polls `GET /api/login-requests/{id}?wait` with header `X-Beam-Login-Secret: <secret>`. Each call returns
   within 20 s:
   - `{ "status": "pending" | "denied" | "expired" | "withdrawn" }`, or
   - `{ "status": "approved", "key": "bt_…", "server", "approvedBy" }`. Browsers also get the cookie, but only when the
     request comes from Beam's own page.

   The key is a **device token** (v3) and is handed out once. Requests expire after 5 minutes; create a fresh one when
   that happens. If the user closes the sign-in screen, withdraw the request with `DELETE /api/login-requests/{id}` and
   the same header.
4. Signed-in devices are told live with the SSE event `login-request`:
   - Payload: `{ id, code, name, platform, where, createdAt, expiresAt, deviceId, tailscale, purpose, remember }`.
   - v3 adds `tailscale: { node, user }` (the requester's Tailscale machine and account, when known) and
     `purpose: "sign-in" | "move"`.
   - `where` is e.g. `"work-laptop (100.64.0.50) · alice@example.com"`.
   - When the request is settled anywhere, `login-request-done { id, status }` follows.
   - If a pending request's `deviceId` makes any signed-in request (it got in another way), the request is settled as
     `withdrawn`.
   - Answer with `POST /api/login-requests/approve` or `/deny`, body `{ "code" }`. Always show the requester's name,
     `where` and code before approving.
   - A request with `purpose: "move"` asks for a **full copy of this Beam** (`node server.js import-from`, see
     Moving). Warn clearly before approving it.

   The QR code encodes `https://<server>/?approve=<CODE>`. Scanning it with a signed-in phone should open the approval
   prompt.

**2. Password.** `POST /api/login` with JSON `{ "secret": "<password>", "client": "app", "deviceId", "remember" }`.
- Apps (`client: "app"`) get `200 { "key": "bt_…", "server" }`, **(1.6)** plus `you` (the device id the sign-in got).
  Browsers omit `client` and get a cookie (`204`).
- A pairing link, pairing token, device token or the master key also works in `secret`. An app's web view signs in
  with its own device token this way (the Android remote viewer, for one).
- Limits (v3):
  - 5 attempts per address per 5 minutes, then `429` until the lock ends, even for the right password;
  - 30 attempts in total per 10 minutes;
  - attempts count as soon as they start.
  - **(1.6)** Only password attempts and wrong secrets count. A valid pairing link, device token, master key or
    handoff never touches these limits and isn't held up by them.
- `{ "handoff": "…" }` instead of `secret` signs a browser in after a move (see Moving). **(v3)**

**3. Pairing link.** See above.

**Finding the server.** `GET /api/hello` answers without a key:
`{ "beam": true, "version", "serverId", "api": 3, "movedTo"?, "proof"? }`.
- Every address this Beam is known by is in the signed-in `GET /api/info` (`urls`). Remember them for finding it
  again after a move. Servers before 1.7.7 also listed them here, to anyone (audit S-33).
- An app on a new computer can find Beam by running `tailscale status --json` and probing
  `https://<peer DNSName>/api/hello` on each online peer (strip the trailing dot from `DNSName`).

**Proving it's really your Beam (v3).** `GET /api/hello?nonce=N&tid=T` adds
`proof = hex(HMAC-SHA256(key = sha256(secret), serverId + ":" + N))`.
- `N` is 8–128 characters `[A-Za-z0-9_-]`.
- `T` is the first 16 hex characters of `sha256(sha256(secret))`, where `secret` is your stored key (token or master
  key).
- The server answers only when it holds that secret, and never sees it.
- Check it before following a move or trusting a server found by `serverId`. The `serverId` alone is public.

## Browsers: what the page must send (v3)

Every `*.ts.net` machine of a tailnet counts as the same *site* for browsers. So cookie-authenticated requests that
change something (any method except GET/HEAD) are accepted only when one of these is true:
- `Sec-Fetch-Site` is `same-origin` or `none` (every current browser sends this for same-origin `fetch`/XHR);
- or `Origin` matches the Host;
- or, when neither header is there, the request carries `X-Beam-Device-Id`.

Anything else gets `403 { "reason": "csrf" }`.

Cookie-authenticated requests with a JSON body must say `Content-Type: application/json` (`415` otherwise). This
includes `POST /api/text` from browsers.

`/api/login`, `/api/autopair`, `/api/logout` and the sign-in poll need no credentials. They refuse only what a
browser marks as cross-site (`Sec-Fetch-Site` other than same-origin/none, or a foreign `Origin`). Native apps send
neither header and are unaffected. Bearer requests are never affected.

## When the server moves

Beam can be moved to another machine with its data folder (`node server.js export` / `import`, or
`import-from`; see README). The key, items, devices, sign-ins and `serverId` travel with it.

- **(v3)** `POST /api/move { "to": "https://new-address" }` (any signed-in device):
  - The old server checks that `to/api/hello` answers with the same `serverId` and a valid **proof** for the master
    key.
  - It then remembers the new address in `data/settings.json`, sends the SSE event **`moved { movedTo }`** to every
    connected client, and closes the streams.
  - Answers `200 { movedTo }`, or `409 { error }` when the target doesn't check out. **(1.7.3)** Nothing answering
    and something that isn't Beam get the same `error` ("No Beam server answered at …"); the details go to the log.
  - `{ "wait": true }`: when the target isn't answering yet, the server answers `202` and keeps checking every 5 s for
    up to 30 minutes. Meanwhile it refuses changes with `503` so nothing is lost.
  - `{ "force": true }` skips the check (master key only; also `node server.js moved-to <url> --force`).
  - `DELETE /api/move` cancels a pending move. After a move it needs the master key; it undoes the move.
  - **(1.7.3)** Sign-ins approved for a move (`import-from`) are revoked when the move is done, undone or called off
    (`import-from --no-redirect` calls it off at its end), and expire 48 hours after they were made anyway.
  - `BEAM_MOVED_TO` still works and overrides the setting.
- From then on **every** `/api/*` call answers `410 { "error", "movedTo" }`, and `/api/hello` includes `movedTo`.
- On a `410` or a `moved` event:
  1. Check `GET <movedTo>/api/hello?nonce&tid`. It must be `beam: true` with the same `serverId`, and **its `proof`
     must verify** (v3).
  2. Then save `movedTo` as the new server address (the key stays the same), reconnect, and tell the user
     "Beam moved to …".
- **Browsers (v3):** the old address serves a small page that goes straight to the new address. If the browser was
  signed in there, it carries a one-time **handoff** in the fragment:
  `https://new/#handoff=<exp>.<mac>&device=<id>&name=<name>`.
  - `device` and `name` come from the old origin's `localStorage` (`beam.deviceId`, `beam.device`).
  - The new page should adopt them, then call `POST /api/login { "handoff": "<exp>.<mac>" }` (same-origin). That sets
    the cookie (`204`) for the device in `X-Beam-Device-Id` / the `beam_device_id` cookie.
  - Handoffs last 10 minutes and work once.
- If the server simply stops answering for a long time, apps may look for their Beam again among the remembered
  `urls` and the tailnet peers. Verify `serverId` **and** `proof`.

## App updates

Apps update themselves from the Beam server.
- Each build writes a sidecar next to the app in `dist/`:
  - `beam.apk.json`: `{ "version": "<versionName>", "versionCode": 7 }`
  - `Beam.exe.json`: `{ "version": "1.7.3", "sha256", "size", "sig" }` (1.7.3: signed by the build; below)
  - `beam-linux.js.json` **(1.22)**: the same for Beam for Linux (`linux/build.mjs`; see Beam for Linux)
- `GET /api/updates` answers `{ "android": { "version", "versionCode", "url", "size", "sha256" }, "windows": { … }, "linux": { … } }`.
  An app only appears there when both the file and a readable sidecar exist. The sidecar's fields are passed on;
  `size` and `sha256` are always the server's own, from the file.
- **Signed Windows updates (1.7.3):** `windows\build.cmd` signs every build with its builder's key (ECDSA P-256 with
  SHA-256; `windows/update-key.mjs`; the private key stays on the building computer, by default
  `~/.beam/windows-update-key.pem`), and the app carries the public half. `sig` is base64 of r‖s over the UTF-8 text
  `beam-windows-update\n<version>\n<sha256, lowercase hex>\n<size>`. The app checks it before downloading (and the
  download's SHA-256 and size after) and installs nothing else: a Beam.exe in `dist/` that its builder didn't sign,
  an older signed one offered as new, or one changed on the way is refused (and not downloaded again until offered
  anew). A build made without a key checks only `sha256`, as before. The Android app has this from Android itself:
  an update must be signed with the same key as the installed app. **(1.22)** Beam for Linux's builds are signed with
  the same key over `beam-linux-update\n<version>\n<sha256>\n<size>` (so neither app's build passes for the other's).
- When `dist/` changes, the server broadcasts the SSE event `app-update` with the same object.
  - It is sent once per real change.
  - The server re-watches `dist/` if it is deleted and recreated, and also checks every minute (network shares).
- Apps check on launch, every 6 hours and on `app-update`. When a newer build is available, they download
  `url` (with the key), **verify `sha256`** and install:
  - **Android:** compare `versionCode`, then ask with a notification; Android always shows its own confirmation.
  - **Windows:** compare `version` and swap the exe automatically.
- **One PC first (1.19, feature `staged-updates`):** a new Windows build goes to one PC first: the pilot, this server's
  own PC when its Beam app is online, else the Windows app seen last (a rollout without one takes the first Windows
  app that connects). Meanwhile the other Windows apps aren't offered it: `GET /api/updates` and `app-update` leave out
  `windows` for them (browsers, the command line and the master key still see it). Once the pilot runs it (its
  `X-Beam-App-Version`) and has for 10 minutes and is connected, everyone gets `app-update`. A pilot that reports the
  build didn't install (its status `update.problem` for that version) stops it there: an `update` alert, and the others
  keep their version until `POST /api/updates/release` offers it to every PC anyway. A pilot that hasn't installed it
  within 30 minutes hands over to another online PC. Only when more than one Windows app is known. The setting
  `stagedUpdates` (true unless turned off; `BEAM_STAGED_UPDATES=0` overrides) turns it off; turning it off on the way
  offers it to every PC. `GET /api/settings` → `rollout`: `{ "version", "pilot", "pilotName", "since", "installedAt",
  "releaseAt", "released", "halted": { "at", "problem" } | null, "running", "pcs" }`, or `null`.

## Every request

| Header | Required | Value |
|---|---|---|
| `Authorization` | yes (apps) | `Bearer <key>` (browsers use the cookie) |
| `X-Beam-Device-Id` | yes (for apps) | the device id |
| `X-Beam-Device` | yes (for apps) | display name, **URI-encoded** (`encodeURIComponent`) |
| `X-Beam-Platform` | yes (for apps) | `windows`, `android`, `ios`, `mac`, `linux`, `web` or `cli`. Without it: `web` for browsers (cookie login), otherwise `other` |
| `X-Beam-App-Version` | optional (apps) | the app's own version, e.g. `1.3.0` (`version=` on `/api/events`). Shown as the device's `appVersion` and in the server log |
| `X-Beam-Profile` | optional (apps, v3) | 8–64 hex chars identifying the OS user account the app runs under, stable across reinstalls (Windows: a hash of the user SID and MachineGuid). `profile=` on `/api/events`. Keeps two accounts on one shared PC from being merged as a "reinstall" |
| `X-Beam-Device-Key` | the Windows app 1.6+ | **(1.6)** the app's device key: base64url of 32 random bytes, one per installation and Windows account, kept DPAPI-protected. On every native request (bearer) and the event stream. See Device keys |

- Device names are cut to 40 characters. Control characters and text-direction overrides are removed.
- A request without a name keeps the device's current name (v3).
- Any request carrying these headers registers or updates the device in the server's device list.
- A request with platform `web` never renames or re-platforms a device that is an app (the Windows app's WebView sends
  `windows`).

**Response header `X-Beam-You` (v3)**: sent when the effective device id differs from the one you sent (after a
merge). Adopt it. `GET /api/me` and `GET /api/devices` also return `you`. **(1.23.1)** Both say the same id, even in
the answer to the very request that merged the device (a browser joining the app on its machine); before, that
answer's body still named the old id.

**Same-machine linking.**
- The server works out which machine each device talks from, but only where an address pins down one machine:
  - a **Tailscale address** (a machine's IPv4 and IPv6 count as one when Tailscale status is available);
  - **the server itself**: a loopback request for `localhost`/`127.0.0.1`, or one of the server's own addresses.

  LAN, Docker and reverse-proxy addresses are never used for linking or automatic sign-in (v3).
- A browser (`platform: web`) on the same machine as a Beam app (any other platform) is merged into that app:
  - Installed apps are preferred over the CLI.
  - The browser's id becomes an alias of the app's id.
  - Items, pending uploads, tokens and read markers move to the app's id (v3).
  - A `refresh` event is broadcast.
  - Browsers signed in for a session only (`temporary`) are never merged.
- A **reinstalled app** comes back with a new id from the same machine and platform. Any older app of that platform on
  that machine whose *app* isn't connected is merged into the new one, so its history carries over.
  - This applies to installed apps only, never the CLI.
  - A browser tab still open as the old app doesn't block it (v3).
  - Apps that report different `X-Beam-Profile` values are different user accounts and are never merged (v3), and
    (1.14.3) only apps that **both** report one, the same, are: an older app that never said which account it's for
    stays a device of its own (the server logs the near miss once).
- Browsers can't set headers on `EventSource`, so `/api/events` also accepts them as query parameters (`device`,
  `name`, `platform`). The web app sends the key as a cookie.
- **Behind a reverse proxy (v3):** the server believes `X-Forwarded-For/-Proto/-Host` only from loopback plus
  `BEAM_TRUSTED_PROXIES`, and takes the right-most address that isn't a trusted proxy.

Errors are JSON `{"error": "message"}` with a 4xx/5xx status, sometimes with more fields (`offset`, `reason`,
`movedTo`, `retryAfter`).

**Device keys (1.6).** A Windows PC may have several Windows accounts on one Tailscale machine (personal and work,
say). The device key lets the Beam app of one account prove it is that installation, so a program in another account
can't pass for it.
- **Trust on first use.** The server keeps only `keyHash` = SHA-256 of the header value, with the device. It is set
  by the first request that meets all of these:
  - it is bearer, with `X-Beam-Platform: windows`;
  - it uses that Windows app's own sign-in (a token made for `windows`, or the master key);
  - it shows a key while the device has none.

  A Tailscale-identity sign-in that named an **existing** device which had no key yet can't set it: another account on
  that machine could otherwise get there first.
- **Then every bearer request acting as that device must carry the key**, the event stream included. Otherwise:
  `403 { "reason": "device-key" }`. The app should then sign in again; without the key it gets a new device id.
- **A sign-in that names a keyed device without its key gets a device id of its own:** automatic, password, pairing
  link, approved request, link or key alike. With the key (in `X-Beam-Device-Key` on the sign-in request, or on the
  sign-in request's creation for approvals), it keeps the id. The new id comes back as `you` (autopair, `/api/login`
  for apps, `/api/me`) and in `X-Beam-You`.
- **Key-bound sign-ins.** A token made or used with the device's current key is key-bound. Remote control takes
  Windows sign-ins only when key-bound.
- **On every `/api/rc/…` route**, a Windows sign-in must show the matching `X-Beam-Device-Key`, cookie requests
  included. Otherwise: `403 { "reason": "device-key" }`. So a copied sign-in (a token from a copied config) controls
  nothing.
  - The app's own pages (the viewer window) use its token as their cookie. The app adds the header to their `/api/`
    requests itself, and the page never sees the key.
  - The viewer's events go only to streams that showed the key as well.
  - Android and browser sign-ins are unaffected; CSRF is unchanged.
- **Reinstalls, merges and sign-outs:**
  - A reinstall with a fresh config has a new key and a new device id. The reinstall merge keeps the new device's
    key, never the old one's: the old installation's tokens aren't bound to it.
  - A move carries keys with the data.
  - `sign-out-others` keeps the keys; the caller's new token stays key-bound if the old one was.
  - Removing a device forgets its key.
- **Android** has no device key yet (a follow-up).

## Data model

**Device**
```json
{ "id": "a1b2c3d4e5f6", "name": "Pixel 9", "platform": "android", "online": true, "lastSeen": 1790723000000,
  "user": "owner", "signedIn": true, "temporary": false, "appVersion": "1.3.0",
  "status": { "battery": { "level": 64, "charging": false }, "storage": { "free": 51200000000, "total": 256000000000 },
              "os": "Android 16", "at": 1790723000000 },
  "tailscale": { "name": "pixel-9", "dns": "pixel-9.tail1234.ts.net", "ip": "100.70.248.8", "online": true, "keyExpiry": 1806278692000 },
  "can": { "ring": true, "wake": false, "remoteDesktop": false, "remoteControl": false, "log": false, "apps": false },
  "settings": { "phoneNotifications": false } }
```
- `online` is true while the device holds an open `/api/events` connection.
- `signedIn` (v3): the device holds at least one device token.
- `temporary` (v3): only present when true (a session sign-in).
- `appVersion`: the version of the Beam app on it, when the app reports one (`X-Beam-App-Version`).
- `status` (1.3): what the device last reported about itself (see Device status). Only present once it has reported.
  `at` is when.
- `tailscale` (1.3): its Tailscale machine, when known:
  - `name`: the machine name;
  - `dns`: its MagicDNS name (may be `null`);
  - `ip`: its Tailscale IPv4 address.
  - **(1.17)** what tailscaled on the server says about that machine, when it says (absent without Tailscale):
    - `online`: Tailscale's own online state, apart from Beam's `online`;
    - `lastSeen`: while it's offline, when Tailscale last saw it (absent when it doesn't know);
    - `keyExpiry`: when its Tailscale key runs out (ms), `null` when it doesn't (key expiry turned off);
    - `expired: true` once it has run out: the machine is off Tailscale until someone signs in there again.

    Why an app is offline, then: `tailscale.online` true means the machine is on but Beam isn't running or connected
    there; `false` means it's off, asleep or without internet; `expired`, its Tailscale sign-in ran out. Tailscale
    notices a machine that lost power or network only after a few minutes, so the web app says "still on" only once
    Beam has missed the device for 4 minutes.
- `can` (1.3): what the device can do:
  - `ring`: an Android or Windows app at version 1.3.0 or later, as reported with `X-Beam-App-Version` (an unknown
    version counts as older);
  - `wake`: it has reported its network adapters. Show "Wake" while it is offline;
  - `remoteDesktop`: a Windows PC that accepts Remote Desktop and has a Tailscale name or address;
  - `remoteControl` **(1.6)**: a Windows PC with the Beam app 1.6.0 or later whose "Allow remote control" switch is
    on (`status.remoteControl`) and tied to its app on a Tailscale machine, that isn't locked (`status.locked`) and
    wasn't turned off from another device since (see Remote control).
  - `log` **(1.20)**: a Windows PC with the Beam app 1.14 or later, which sends its log when asked (see A PC's log).
- **MAC addresses are never sent to clients.** Devices report them, but only the server uses them, to wake the device.
- `settings` (1.5): the device's own settings, which any signed-in device may change (`PUT /api/devices/{id}/settings`):
  - `phoneNotifications`: it shows phone notifications (see Phone notifications). Always present, `false` by default.
- `user`: reserved.

**Item**
```json
{
  "id": "0123456789abcdef",
  "kind": "text",
  "text": "hello",
  "from": "a1b2c3d4e5f6",
  "device": "Pixel 9",
  "to": ["f00dfeedbeef1234"],
  "delivered": { "f00dfeedbeef1234": 1790723001000 },
  "ts": 1790723000000,
  "pinned": false,
  "thumb": false
}
```
- `kind` is `"text"` or `"file"`. File items have `name`, `size` (bytes) and `mime` instead of `text`. Image and video
  items may have `w`, `h` (pixels, from the sender) (v3).
- `from` is the sender's device id (`null` for old clients). `device` is the sender's name at send time.
- `to` holds the target device ids. **An empty array means every device.**
- `delivered` maps each device id to the time that device acknowledged the item.
- `pinned` (v3): retention and the item limit never remove it.
- `thumb` (v3): a thumbnail exists at `/api/items/{id}/thumb`.
- `forwardedFrom` (v3): the item it was forwarded from.
- `reply` (1.14): what a reply answers, as it was when the reply was sent: `{ "id", "kind", "from", "device", "text" }`
  (the first 140 characters) or `"name"` for a file; only `{ "id" }` when that item was gone already.
- `reactions` (1.14): `{ "👍": ["<device id>", …] }`, each emoji with the devices that chose it (absent when none).
- `edited` (1.14): when a text's words were last changed.
- **Long texts (v3):**
  - In lists and live events, texts over **16 KB** are cut short (`"truncated": true, "textLength": N`). This was
    64 KB in v2.
  - The full text is at `GET /api/items/{id}/text`; `GET /api/items/{id}` also returns it in full.
  - Texts over 64 KB are stored in a file on the server.

**An item is for me** when `(to is empty OR to contains my id) AND from != my id`.
Show items that are for me or from me. Auto-actions (copy, save, notify) apply only to items for me.

## Conversations (how apps present items)

Apps present Beam like a messenger whose contacts are your devices. There is one conversation per other device, plus
an **All devices** conversation for broadcasts.

- **Conversation with device X** (me = my device id):
  `(from == me AND to contains X)` OR `(from == X AND (to contains me OR to is empty))`
- **All devices**: items where `to` is empty (from anyone, including me).
- An item sent to several devices appears in each of those conversations.
- The conversation list shows each device's online dot, last message preview + time, and an unread count: items for
  me in that conversation newer than the time I last opened it. Sort by most recent activity, with All devices pinned
  first.
- **Read markers (v3):** keep "last opened" on the server so a browser tab and the app sharing one identity agree:
  - Write it with `PUT /api/read { "conversation": "<device id>" | "all", "ts": <ms> }`. It only ever moves forward.
  - Read it from `GET /api/me` → `read: { "<conversation>": ts }`.
  - Follow it live with the `read { device, conversation, ts }` event (apply it when `device` is you).
- In a thread, my items are on the right and theirs on the left (chat bubbles). The compose box sends to that
  conversation's device (or to all, in All devices). Dropping files onto the thread, or onto a device in the list,
  sends them to that device.
- Items without `from` (sent by curl, iOS Shortcuts or old clients) appear in All devices when they are for me. Apps
  may instead file them under a device whose name matches the item's `device`.

## Endpoints

### Devices
| Method & path | Result |
|---|---|
| `GET /api/devices` | `{ "devices": [Device...], "you": "<your device id or null>" }`, online first |
| `DELETE /api/devices/{id}` | Forget a device, **revoke its sign-ins and block its Tailscale machine from automatic sign-in** (v3) → `204`. A device still holding the master key comes back when it next connects |
| `PUT /api/devices/me/status` | **(1.3)** the calling device reports its status (see below) → `204`; event `devices` |
| `PUT /api/devices/{id}/settings`, `PUT /api/devices/me/settings` | **(1.5)** `{ "phoneNotifications": true\|false }` → `204`; event `devices`. When the value changes, the device itself gets the new list at once (see Phone notifications); switched off, also `notification-removed { "all": true }`. Any signed-in device may change any device's settings. `400` for unknown keys or a non-boolean, `404` unknown device |
| `PUT /api/devices/me/backup` | **(1.8.1, feature `backups`)** an app keeps a copy of its own settings here: `{ "install": "<its id, 8–64 of A–Z a–z 0–9 _ ->", "app": "windows"\|"android", "version", "settings": {…} }` → `204`; event `devices`. Never a sign-in or a key. One per install (the same install replaces its own), the newest three per device; when a reinstall's new device is linked to the old one, they go along. `settings` is an object of at most 32 KB (`413` above). `403` for a session-only sign-in. What the apps keep: Windows (1.8.1) its Settings, hotkeys and remote control's devices; Android (1.8.2) `deviceName`, `stayConnected`, `autoCopy`, `autoDownload`, `wifiOnlyDownloads`, `maxDownloadMb`, `tileTarget` (`""` = ask), `mutedDevices`, `autoCopyDevices`, `shareNotifications`, `sharedApps` (package names), sent only when they changed. A reinstalled phone comes back with the same device id (from ANDROID_ID), so it finds its earlier install's here |
| `GET /api/devices/{id}/backups`, `GET /api/devices/me/backups` | **(1.8.1)** `{ "device", "name", "backups": [{ "install", "app", "version", "at", "settings" }] }`, newest first: for an app to offer them back after a reinstall, or to set up a new PC like another. Any of the owner's devices signed in for good (`403` for a session-only sign-in). The device list says only when: `backup: { "at", "app" }` |
| `POST /api/devices/{id}/ring` | **(1.3)** body `{ "stop"?: true }` → `202 { "online" }`; event `ring`. `404` unknown device, `409` a device that can't ring (`can.ring` is false) |
| `POST /api/devices/{id}/wake` | **(1.3)** Wake-on-LAN → `200 { "sent": <packets>, "macs": <number of adapters> }`. `409` when the device hasn't reported any adapters |
| `GET /api/devices/{id}/remote-desktop.rdp` | **(1.3)** a Remote Desktop connection file (`application/x-rdp`, attachment `<name>.rdp`). `404` when no Tailscale name or address is known |

### Device status, ring, Wake-on-LAN, Remote Desktop (1.3)
**Status.** Apps send `PUT /api/devices/me/status` on connect, every 15 minutes, and when something really changes
(battery ±5 %, charging starts or stops, crossing 20 % or 15 %). Every field is optional; the ones you leave out keep
their last value, and `null` clears one. Unknown fields or bad values are `400`.
```json
{ "battery": { "level": 0-100, "charging": true },
  "storage": { "free": 51200000000, "total": 256000000000 },
  "os": "Windows 11 Pro 24H2",
  "macs": ["aa:bb:cc:dd:ee:ff"],
  "remoteDesktop": true,
  "remoteControl": false, "locked": false }
```
- `os`: 1–60 characters.
- `macs`: up to 8 physical Ethernet and Wi-Fi adapters, never virtual, VPN, Tailscale or loopback ones. `-` separators
  are accepted.
- `remoteDesktop` (Windows): true when this PC accepts Remote Desktop, i.e. not a Home edition and
  `fDenyTSConnections` = 0.
- `remoteControl` **(1.6, Windows)**: the PC's "Allow remote control" switch. Only the PC turns it on. Reporting
  `false` ends its remote control sessions.
  - The first `true` from the app itself (bearer, `X-Beam-Profile`, through Tailscale) ties remote control to that
    machine and Windows account.
  - From then on, a report with `remoteControl` or `locked` from anywhere else gets `403 { "reason": "machine" }`.
- `locked` **(1.6, Windows)**: the PC's session is locked (or signed out to the lock screen). A locked PC can't be
  controlled (use Remote Desktop).
- `update` **(1.6.2)**: `{ "version": "1.6.3", "problem": "…" }`, an app update that didn't install there, in the
  system's words (1–300 characters; Beam for Android sends it when Android refuses an install). The server log says
  "<device> couldn't install Beam <version>: <problem>" (again only when it changes). It goes away by itself once
  the device runs that version or a later one. Older servers answer `400` (send it on its own, not with other fields).
- `startsWithWindows`, `startWanted` **(1.20, Windows, feature `setup-check`)**: whether Windows' own startup list has
  the app, and whether its user wants it there (the setup check flags a PC where it's wanted and missing). Shown in the
  device list's `status`. Older servers answer `400`: send them only when the server lists `setup-check`.
- Both show in `status` in the device list.
- **(1.22, Beam for Linux, feature `linux`)** Older servers answer `400`: send these only when the server lists `linux`.
  - `model`: the hardware, 1–60 characters ("Raspberry Pi 5 Model B Rev 1.0"; a PC's maker and model).
  - `bootedAt`: when the computer last started, in ms (its "Up since").
  - `temperature`: the processor's, in °C (-50 to 150; kept to one decimal).
  - `throttled`: what a Raspberry Pi's firmware says (`vcgencmd get_throttled`): `{ "now": [...], "sinceBoot": [...] }`,
    each a list of `undervoltage` (its power supply is too weak), `capped` (its speed is capped), `throttled` (it's
    slowing itself down), `softLimit` (it's near its temperature limit).
- Others see `status` (without the MACs), `tailscale` and `can` in the device list; the `devices` event goes out at
  most every 5 s for status changes. Low battery or storage, and (1.22) a hot or under-powered Pi can raise alerts
  (see Alerts).

**Ring.**
- `POST /api/devices/{id}/ring` sends the event `ring { "device", "by", "from", "stop", "at" }` to every client:
  - `device` is the target id;
  - `by` is the name of the device that rang, `from` its id.
- Only the device whose id is `device` reacts. It rings loudly for up to 60 s with a "Ringing from `by`" notice and a
  Stop button. It stops on Stop, when Beam is opened, or on a `ring` event with `stop: true` (`{ "stop": true }` in the
  request).

**Wake-on-LAN.** `POST /api/devices/{id}/wake` sends magic packets for each reported adapter (UDP ports 9 and 7) to
`255.255.255.255` and to the directed broadcast address of each of the server's LAN interfaces, three times, 300 ms
apart. It only works when:
- the Beam server is on the same local network as the PC (in Docker it needs host networking, not the Tailscale
  sidecar);
- Wake-on-LAN is enabled on that PC and its network card.

`BEAM_WOL_TARGETS` (`address[:port]`, comma-separated) on the server replaces the list of destinations.

**Remote Desktop.** `GET /api/devices/{id}/remote-desktop.rdp` returns
```
full address:s:<MagicDNS name, or the Tailscale address>
prompt for credentials:i:1
screen mode id:i:2
```
In the Windows app's WebView, ask the app to run `mstsc.exe /v:<host>` instead (host = `tailscale.dns || tailscale.ip`);
in a browser, link to the file.

### Alerts (1.3)
The server watches for trouble and tells every client:
- **battery:** a device's battery at or below 15 % and not charging. It fires once, and re-arms above 25 % or when
  charging.
- **storage:** a device's free storage below max(2 GB, 5 % of its total). It fires once, and re-arms once free space is
  20 % above that.
- **offline:** a device listed in `alerts.offline` has been offline for 10 minutes. A `kind: "online"`, `level: "info"`
  alert follows when it comes back. Dropping out for less than that is not reported.
- **serverDisk:** the server's own disk has less than max(5 GB, 5 %) free. It is repeated at most every 12 hours while
  it lasts.
- **tailscaleKey (1.17):** a machine's Tailscale key runs out within 14 days, within 3 days, and once it has: one alert
  per stage and key (a renewed key, or expiry turned off, starts over). `device` is the device's Beam app (one per
  machine), or `null` for the server's own machine: when that one runs out, no device can reach Beam until it's
  renewed. Checked whenever the server looks at tailscaled (every 5 minutes).
- **powerLoss (1.18):** a PC came back on after a power loss or a freeze, a blue screen or a forced power-off (see
  Each PC's history): once per start of Windows, and only when the server learns of it within a day. The text says when
  it went down and came back, and when nobody has signed in on it since (its Beam app isn't running yet).
- **(1.17)** An offline alert says why when tailscaled knows ("…: the PC is still on Tailscale, so Beam itself isn't
  running there", "…: Tailscale can't reach it either (off, asleep or without internet)", "…: its Tailscale sign-in has
  run out").
- **hardware (1.22):** from a device's status (Beam for Linux): its processor at 80 °C or more (once; again only after
  it was below 70 °C), and a power supply too weak for it (`throttled` has `undervoltage`, now or since it started: once
  per start, by `bootedAt`).

Each alert is the event `alert { "id", "kind", "device", "level": "warn" | "info", "text", "at" }`:
- `kind` is one of `battery`, `storage`, `offline`, `online`, `serverDisk`, `tailscaleKey` (1.17), `powerLoss` (1.18), `update` (1.19: a Windows build that didn't work on the PC that tried it first; `device` null), `setup` (1.20: a setup
  check that went wrong; `device` null), `hardware` (1.22);
- `device` is the device it is about (`null` for `serverDisk` and the server's own `tailscaleKey`);
- `text` is ready to show.

The last 100 are kept (`GET /api/alerts` → `{ "alerts": [...] }`, newest first). They are also written to the server
log and pushed through ntfy when that is configured. **Clients ignore alerts about themselves** (`alert.device === me`),
except `serverDisk`, `tailscaleKey` (the apps don't watch their own Tailscale key) and `powerLoss` (1.18: why this PC
restarted).

The settings are `alerts: { "battery": true, "storage": true, "serverDisk": true, "tailscaleKey": true (1.17), "powerLoss": true (1.18), "setup": true (1.20), "hardware": true (1.22), "offline": ["<device id>", …] }`,
changed with `PATCH /api/settings`; see Settings. Crossings are logged even when that kind of alert is turned off.

### Each PC's history (1.18)
Feature `history`. What happened to a device, newest first: a PC's restarts and shutdowns and who asked, power losses,
blue screens, when someone signed in after, and Beam's own crashes, from Windows' own records; and the spells Beam saw
a device offline for 10 minutes or more.

| Method & path | Result |
|---|---|
| `GET /api/devices/me/history/since` | `{ "System": "<ISO>" \| null, "Application": "<ISO>" \| null }`: the newest record the server keeps from the calling PC, per log. Report from a minute before it (the server keeps each record once); with `null`, from 30 days back |
| `POST /api/devices/me/history` | `{ "events": [Record...] }` (600 at most, body 4 MB at most) → `{ "added", "since" }`. Records of other kinds, older than 120 days or in the future are skipped. A new power loss, blue screen or forced power-off raises a `powerLoss` alert (see Alerts) |
| `GET /api/devices/{id}/history?days=30` | `{ "device", "name", "entries": [Entry...], "up", "at" }`: 1–120 days (30 unless asked). `up`: `{ "since", "kind", "text" }`, the latest start of Windows, or `null` |

A **Record** is one of Windows' event records as the PC read it: `{ "log": "System" | "Application", "id": <event id>,
"provider": "<provider name>", "time": "<ISO>", "rec": <record number>, "data": ["<each value as text>", ...] }`: dates
as ISO in UTC, byte arrays as `"hex:…"` (the first 64 bytes). The kinds the server takes (`WANTED` in lib/history.js):
- System: `User32` 1074 (a restart or shutdown asked for: the program, the reason, the type), `Microsoft-Windows-Kernel-Power`
  41 (started again without a clean shutdown), `EventLog` 6008 (Windows' estimate of when it went down: the second
  SYSTEMTIME of its binary value), `Microsoft-Windows-Kernel-General` 12 and 13 (Windows started, shut down),
  `Microsoft-Windows-WER-SystemErrorReporting` 1001 (a blue screen's stop code), `Microsoft-Windows-Winlogon` 7001
  (someone signed in);
- Application: `Application Error` 1000, `.NET Runtime` 1026 and `Application Hang` 1002, only the app's own
  (Beam.exe at the app's own path; a 1026 only with a 1000 of its own from the same moment).

An **Entry**: `{ "at", "kind", "text", "detail"?, "by"?, "down"?, "downEstimate"?, "up"?, "signedIn"?, "count"?,
"until"?, "ongoing"? }`, times in ms:
- `restart`, `shutdown` (`by`: `update`, `antivirus`, `you`, `program`, `unknown`), `power-loss`, `crash` (a blue
  screen; `detail`: its stop code), `forced-off`, `start` (nothing known before it): one start of Windows each: how it
  went down (`down`; with `downEstimate`, Windows' last note of it running, so "after"), when it was back (`up`) and the
  first sign-in after (`signedIn`). Restarts for one Windows update, one after another within 20 minutes, are one entry
  with `count`;
- `app-crash` (`detail`: the .NET exception, else the error code), `app-hang`: Beam itself;
- `offline`: Beam saw it offline from `at` to `until` (`ongoing` while it still is).

The server's own PC (a Windows server with Tailscale on, unless `BEAM_OWN_HISTORY=off`) reads its own System log at
start (PowerShell's Get-WinEvent, as the server's account), for its Beam app's device (the Windows app on this machine):
a power loss there is known, and alerted, before anyone signs in. `BEAM_TEST_OWN_EVENTS` (a JSON file of records)
stands in for Windows in tests.

### The setup check (1.20)
Feature `setup-check`. The server looks at its own setup two minutes after it starts and every 6 hours (a real
install: Tailscale on and not a test; `BEAM_SETUP_CHECK=on|off` decides otherwise), and when asked:

| Method & path | Result |
|---|---|
| `GET /api/setup?refresh=1` | `{ "checks": [{ "id", "title", "ok": true \| false \| null, "detail", "fix"? }], "at" }`: without `refresh`, the last results (the first ask runs them); with it, a new look (at most every 10 s). `ok: null` is "can't tell yet"; `fix` (only when `ok` is false) says what to do |

The checks (each only where it applies):
- `boot`: the servers start when Windows does (a Windows server: a scheduled task with a boot trigger runs this
  server.js, and Beam Family's when `BEAM_FAMILY_URL` is set; PowerShell's Get-ScheduledTask; `BEAM_TEST_BOOT_TASKS`
  stands in for tests);
- `unattended`: Tailscale runs before anyone signs in (Windows: tailscaled's `ForceDaemon`);
- `https`: the address devices use is https;
- `backups`: the last backup is younger than twice `BEAM_BACKUP_HOURS` (false when backups are off);
- `disk`: at least max(5 GB, 5 %) free;
- `versions`: every Windows PC seen in the last 14 days runs the build in dist (or later);
- `autostart`: every PC that says (Beam for Windows 1.14+, status `startsWithWindows`) has its Beam app in Windows' own
  startup list, unless its user turned that off (`startWanted: false`);
- `keys`: no Tailscale sign-in of this server's or the devices' machines runs out within 30 days;
- `family`: Beam Family answers on its local address.

A check that turns `false` raises a `setup` alert once; it alerts again only after it was right in between.

### A PC's log (1.20)
Feature `device-logs`. A device asks a PC's Beam app (Windows 1.14 or later, or (1.22) Beam for Linux; online: its
`can.log`) for the end of its beam.log; the server passes the request on (the event `log-request { id }`, to that PC's
streams only) and the answer back, and keeps nothing.

| Method & path | Result |
|---|---|
| `POST /api/devices/{id}/log` | `{ "name", "text", "size", "at" }` (`Cache-Control: no-store`), within 30 s. `409` when it can't (too old, offline, no answer in time); `403` for a session-only sign-in |
| `POST /api/devices/me/log` | the PC's answer: `{ "id", "name", "text" }` (1 MB at most is passed on, the end of it) → `204`; `404` for a request that isn't for this device or timed out |

### Beam for Linux (1.22)
Feature `linux`. A Raspberry Pi (or another Linux computer that stays on) as a device of its own: the command-line client
(`cli/beam.js`) run as a service, `beam agent`. `linux/build.mjs` makes it into `dist/beam-linux.js` (the client with
the public update key filled in) + `beam-linux.js.json`, signed (see App updates).

| Method & path | Result |
|---|---|
| `GET /install/linux` | **No sign-in.** The install script (`linux/install.sh`, `text/plain`) with this Beam's address in it: the one the request came to (through `tailscale serve`, the name it was asked for); only a plain host name, else the known public address, else `400`. On the computer: `curl -fsSL <Beam>/install/linux \| bash [-s -- --name "…" \| --uninstall]` |
| `GET /install/linux/beam.js` | **No sign-in.** The app the script installs (dist's `beam-linux.js`); `404` until it's built |
| `GET /download/linux` | Its updates (signed in), like `/download/windows` |

The script: Linux only, never as root; Node.js 20 or later from the system, else the newest 24 (22 on 32-bit ARM) from
nodejs.org, checked against its SHASUMS256.txt, in `~/.local/share/beam/node`; the app in `~/.local/share/beam/beam.js`;
the `beam` command in `~/.local/bin`; `beam login` (Tailscale sign-in, else a code to approve on another device) with
the device's platform `linux`; a systemd user service `beam.service` (`Restart=always`) and `loginctl enable-linger`
so it starts with the computer. Run again, it updates; `--uninstall` takes away the app and the service.

The app (`beam agent`; the config `~/.beam.json` says `"app": "linux"`, and then every `beam` command there is that
device): every request has `X-Beam-Platform: linux`, `X-Beam-App-Version` and `X-Beam-Profile` (a hash of
`/etc/machine-id` and the user id, so a reinstall merges); it listens like `beam listen` (files to `~/Downloads/Beam`;
text to the clipboard and a notification only with a desktop: it finds the user's Wayland or X session itself); it
sends its status (os, model, storage, bootedAt, temperature, throttled) on each connect (after `hello`), every 15
minutes and when it changes (a start, the firmware's flags, 5 °C either way or across 70 or 80 °C); it answers
`log-request` with its own log (`~/.local/state/beam/beam.log`, never a message's text); and on each connect, each
`app-update` and every 6 hours it takes a newer `linux` update signed with its key, checks it with `node --check`,
replaces its own file and exits (the service starts it again). Only the installed copy updates itself.

**(Beam for Linux 1.1)** On a computer with a desktop (a session in `/usr/share/wayland-sessions` or `xsessions`), the
installed app puts Beam in the menu: `~/.local/share/applications/beam.desktop` (Internet → Beam; Beam's icon in
`~/.local/share/beam/beam.svg`), which runs `beam window`: Beam's pages in a Chromium-family browser's app window with
a profile of its own (`~/.local/share/beam/window`; no such browser: the default browser). The first time (or with
`--sign-in`) the window opens a pairing link (`GET /api/pair`, as `beam open` does), and Beam takes the window for this
computer's device, like any browser on the same machine as a Beam app. Such a page leaves notifications to the app,
which shows them itself (`notify-send`, else the desktop's notification service through `gdbus`). An entry taken out of
the menu by hand isn't put back; `--uninstall` removes it.

**(Beam for Linux 1.2)** Remote control of its screen, turned on only at the computer (`beam control on|off`; status
`remoteControl` when the server lists `vnc`): see "Control for a Linux computer (1.23)".

### Apps on every PC (1.21)
Feature `apps`. The user's own apps, which Beam installs on their PCs (the Windows app 1.16 or later: `can.apps`). An
app comes from a GitHub repository's latest published release, from a file sent here, or from winget. Each PC installs
it for its signed-in user, never raising itself to administrator (an installer that needs that gets Windows' own prompt
there), and only once someone at that PC has allowed it: until then a request makes the PC ask (Install / Always allow /
Not now; the app's `appsAllowed`, turned on only at the PC, see HOST-BRIDGE; from the Windows app 1.16.1 the question
opens there by itself, near the clock, and the app's window shows a bar until it's answered). Adding, changing, installing and
removing need a device signed in for good (`403 { reason: "temporary" }` for a session-only one). `data/apps.json`, the
files in `data/app-files/<id>/` (both in exports and backups).

App: `{ id (8 hex), kind: "github" | "file" | "winget", name, source ("owner/repo", the winget id, or null), version,
file: { name, size, sha256, type: "exe" | "msi" | "zip" } | null, state: "ready" | "fetching" | "failed", error?,
checkError? (a GitHub check that failed while an earlier version stays), checksum? (GitHub: the release's checksum file,
or null when it publishes none), asset? (the release file chosen), choices? (the release's Windows files when there are
several), run? (a .zip's program), args? (an installer's switches), addedAt, addedBy, checkedAt, updatedAt,
on: { <device id>: { state, version?, error?, at } } }`. A PC's state: `pending` (asked; an offline PC is asked when it
connects), `asked` (waiting for someone at the PC), `installing`, `installed`, `failed`, `declined` (Not now at the PC),
`removing`.

| Method & path | Result |
|---|---|
| `GET /api/apps` | `{ "apps": [App...] }` |
| `POST /api/apps` | `{ "github": "owner/repo" or a github.com address, "asset"?, "name"? }` → `201 { app }` in state `fetching` (the server gets the release in the background: the Windows .exe/.msi/.zip named like the repository first, never other systems' builds; when the release has `<file>.sha256` or a sums file, the file must match it); or `{ "winget": "Publisher.App", "name"? }` → `201`. `409` for one that's there already, or 50 apps |
| `PUT /api/apps/file?name=&label=&version=` | the body is the file (.exe, .msi or .zip, 2 GB at most; no 30 s limit, 60 s without data ends it) → `201 { app }`; `&app=<id>`: a new version of that file app (`200`) |
| `PATCH /api/apps/{id}` | `{ "name"?, "run"? (an .exe path inside the .zip), "args"? (one line), "asset"? (GitHub: another file of the release, fetched again) }` → `{ app }` |
| `DELETE /api/apps/{id}` | `204`; its file goes from the server (the PCs keep what they installed) |
| `POST /api/apps/{id}/check` | GitHub: the latest release now → `{ app }`. A new version goes to the PCs that have it |
| `GET /api/apps/{id}/file` | the file (ranges, `no-cache`) |
| `POST /api/apps/{id}/install` | `{ "devices": [ids] or "all" }` → `{ app, asked: [names], cannot: [names] }` and `app-install { id }` to each (`409` when none can) |
| `POST /api/apps/{id}/uninstall` | `{ "devices": [ids] or "all" }` → `{ app, asked }` and `app-uninstall { id }` (`409` when it isn't installed there through Beam) |
| `POST /api/devices/me/apps` | the PC: `{ "id", "state": "asked" \| "installing" \| "installed" \| "failed" \| "declined" \| "removed", "version"?, "error"? }` → `204` |
| `PUT /api/devices/me/apps` | the PC, after each connect: `{ "apps": [{ "id", "version" }] }`, what Beam installed and is still there (its own version now: Slate updates itself); one not listed any more is forgotten there → `204` |

Events: `apps { at }` (to every stream: read the list again), `app-install { id, update? }` and `app-uninstall { id }`
(only to that PC's streams). GitHub releases are looked for 3 minutes after a start and every 6 hours (`BEAM_GITHUB_API`
points the server at a stand-in for tests); downloads only from github.com and its download hosts, at every redirect.

### Items
| Method & path | Result |
|---|---|
| `GET /api/items` | `{ "items": [Item...], "cursor" }`, newest first (`cursor` is 1.4) |
| `GET /api/items?since=<cursor>` | **(1.4)** only what changed since that cursor: `{ "items", "deleted", "cursor", "delta": true }`, or the full list with `"delta": false` (see Delta sync) |
| `GET /api/items/{id}` | the full Item |
| `GET /api/items/{id}/text` | full text as `text/plain`. Sends `ETag`/`Last-Modified` (`304` with `If-None-Match`) (v3) |
| `POST /api/items/{id}/ack` | Mark as delivered to the calling device → `{ "id", "delivered" }` |
| `PATCH /api/items/{id}` | **(v3)** `{ "pinned": true|false }` and **(1.14, feature `edit`)** `{ "text": "…" }` (a text's new words: any of the owner's devices may; `edited` is set; a long one goes to data/texts as when it was sent; `400` for a file or nothing left) → the Item; event `update` |
| `PUT /api/items/{id}/reactions/{emoji}`, `DELETE …` | **(1.14, feature `reactions`)** this device's reaction (one emoji, at most 16 characters, URL-encoded in the path) on or off → `200` + the Item; at most 20 kinds on an item (`409`); event `update` |
| `POST /api/items/{id}/forward` | **(v3)** `{ "to": [...] }` → `201` + a new Item from the caller with the same content (files are hard-linked, not copied) |
| `POST /api/items/{id}/fastlink` | **(1.13, feature `fast-links`)** `{ "hours": 1–720 }` (default 24; **1.15:** also `"maxDownloads": 1–1000` and `"removeLocation": true`, Beam Family's choices: see docs/FAMILY.md) → `201 { "link": { "id", "url", "expires", "created", "downloads", "by", "maxDownloads", "removeLocation" } }`: a link anyone can download this file with, without Beam or signing in, until it runs out. Beam Family on the same machine makes it (its local admin API, with the control.key in `BEAM_FAMILY_DATA`; docs/FAMILY.md), from the file itself: a hard link on the same drive, else a copy the link follows as it arrives. `400` not a file, or hours out of range; `404` not on the server any more; `503` Beam Family isn't set up, answering, or new enough; Family's own errors pass on (`409` no owner yet, `429` 50 links working, `507` storage full) |
| `POST /api/items/delete` | **(v3)** `{ "ids": [...] }` (up to 1000) → `{ "deleted": n }`; events `delete` |
| `PUT /api/items/{id}/thumb` | **(v3)** body = a JPEG or WebP thumbnail (`Content-Type: image/jpeg|image/webp`, ≤ 256 KB), only for image/video items → `204`; event `update` with `thumb: true` |
| `GET /api/items/{id}/thumb` | **(v3)** the thumbnail, or `404` |
| `DELETE /api/items/{id}` | Delete one → `204` |
| `DELETE /api/items` | Delete all → `{ "deleted": n }` |
| `GET /api/latest/text` | Newest text *for the calling device* (or any, without a device id), `text/plain`. `404` if none |
| `GET /api/latest?kind=text|file` | Newest item for the calling device → the full Item, `404` if none |

### Delta sync (1.4)
`GET /api/items?since=<cursor>` (feature `items-since`), with a `cursor` from an earlier `GET /api/items` of this
server:
- `{ "items": [Item...], "deleted": ["<id>", ...], "cursor": "<new cursor>", "delta": true }`:
  - `items`: every item created or changed in any way since the cursor (delivered, pinned, thumbnail …), cut like the
    list (texts over 16 KB are truncated), newest first;
  - `deleted`: the ids removed since then (it may include ids you never saw; ignore those).
- To update a cached list: drop the `deleted` ids, then replace or add each of `items` by id. The result equals a full
  `GET /api/items` at that moment. Keep the new `cursor` with the list.
- When the server can't answer exactly it sends the full list with `"delta": false` (replace your cache). That happens
  for a cursor that is unknown, garbled or from another server, after the server restarted (cursors live as long as
  the server process), after an import or restore, after a device merge (`refresh` event) since the cursor, and for a
  cursor older than the last 10,000 deletions.
- Clients: store the cursor with the cached list; after every (re)connect fetch with `since`; fetch the full list when
  `delta` is false, on a `refresh` event, or when the cache is empty.

### Sending text
`POST /api/text` with JSON `{ "text": "hello", "to": ["<device id>", ...] }` → `201` + Item.
- **(1.14, feature `replies`)** `"reply": "<item id>"` makes it a reply: the item gets `reply` (see the Item's fields),
  a preview of what it answers as it was then. `400` for something that isn't an item id.
- Omit `to`, or pass `[]` or `null`, to send to all devices.
- **(v3)** `to` must be a list of strings or a comma-separated string. Anything else is `400` (it used to silently
  mean "everyone").
- Plain-text bodies also work (not from browsers), with targets in the `X-Beam-To: id1,id2` header or the
  `?to=id1,id2` query.
- **Targets may be device ids (merged-away ids are followed, v3) or device names** (matched case-insensitively). An
  unknown target returns `400`.
- Up to 5 MB. **(1.7.3)** All texts on their way in together hold at most 64 MB of the server's memory; beyond that
  a sender gets `503` with `Retry-After` and tries again.

### Sending files: simple (small files, curl, Shortcuts)
`PUT /api/file?name=<url-encoded name>&to=<ids or names, comma-separated>` (v3: optional `&w=&h=`). The body is the
raw file bytes (not multipart) → `201` + Item.

### Sending files: resumable (use this in apps, required for large files)
1. `POST /api/uploads` with JSON `{ "name": "video.mp4", "size": 123456789, "mime": "video/mp4", "to": [...], "w", "h" }`
   → `201 { "id", "name", "size", "offset": 0, "chunkSize": 8388608, "maxChunkSize" }` (`maxChunkSize` is 1.4).
   - `507` (v3) when the server hasn't room for it: less than the size plus 100 MB free, or the storage limit is
     reached.
2. Repeat `PUT /api/uploads/{id}?offset={offset}` with the next chunk (up to `chunkSize` bytes; **(1.4)** up to
   `maxChunkSize` when the server has the feature `big-chunks`) as the raw body (`Content-Type: application/octet-stream`):
   - → `200 { "offset": <new offset>, "done": false }`, then keep going
   - → `201 { "done": true, "item": Item }` after the last byte
   - A zero-byte file completes on a single `PUT ?offset=0` with an empty body.
3. After a network error, `GET /api/uploads/{id}` → `{ "id", "name", "size", "offset", "received" }` and resume from
   `offset`. **(1.15.1)** `received` is what has reached the server, a chunk still arriving included (`offset` moves
   only when a chunk ends): for downloads of a file still arriving, below.
   - A `PUT` with the wrong offset returns `409 { "error", "offset": <actual> }`. Resume from that.
   - **(1.4)** The server fsyncs an upload every 64 MB or 4 s, when a `PUT` breaks off and before it finishes, and
     after a crash or power cut it goes on from the last fsynced point (never from bytes that may not have reached
     its disk). So the offset can be earlier than the last reply said: the next `PUT` then gets the `409` above.
   - **(1.4)** A `PUT` refused before its body is read (`409`, `413`, `507`, or `401`/`403`) is answered with
     `Connection: close`, and the server closes the connection once the answer is sent instead of reading the rest.
     Stop sending. If the connection breaks before you see the answer, ask `GET /api/uploads/{id}` for the offset.
   - A `409` "still being written" means another `PUT` for this upload is in progress. **(v3)** A chunk that has
     received nothing for 30 s is taken over by the next `PUT`, and one with no data for 60 s is cut off. So retry
     after a short wait; the upload never stays stuck.
4. Cancel with `DELETE /api/uploads/{id}` → `204` (also while a chunk is in flight). Unfinished uploads are deleted
   after 24 hours idle.
5. The finished item has the same id as the upload. If the final response was lost, `GET /api/items/{id}` returns it.

**Big chunks (1.4, feature `big-chunks`).** Each chunk waits a full round trip for its reply before the next one
starts: with 8 MB chunks at 25 ms and 50 MB/s that leaves the link idle about 20 % of the time.
- `maxChunkSize` (in `POST /api/uploads`, `GET /api/uploads/{id}` and `GET /api/info`) is the largest body one `PUT`
  may carry. It equals `maxUpload`.
- An interrupted `PUT` keeps every byte that reached the server. `GET /api/uploads/{id}` gives the offset to go on from,
  so a big chunk risks nothing.
- **Recommended: adaptive chunks.** Size each `PUT` to about 4 s at the rate the previous chunks reached, at least
  64 MB, at most `maxChunkSize` and the rest of the file. Start with 64 MB. Stream each chunk from disk (never read a
  chunk into memory).
- A single `PUT` for the whole rest of the file is allowed but not recommended: apps reach the server through
  `tailscale serve` (a reverse proxy), and requests that run for many minutes haven't been verified there.
- Skip `Expect: 100-continue`: it costs another round trip per chunk.

### Downloading files
`GET /api/file/{id}` returns the bytes with `Content-Disposition: attachment`, `Content-Length` and **Range support**,
so interrupted downloads can resume with `Range: bytes=N-`.
- **(v3)** It also sends `ETag` and `Last-Modified`, and honours `If-Range` and `If-None-Match`.
- An invalid range such as `bytes=5-2` is ignored (`200`).
- A zero-byte file always answers `200`.
- Add `?inline` to view images, video or audio in a browser (never SVG or HTML).

**Downloads while the upload is still running (1.4, feature `live-download`).** `GET /api/file/{id}` also works with
the id of an upload that is still arriving (from the `upload` event), with the same sign-in rules as a finished file:
- The answer is `200` (or `206` for a range) with `Content-Length` = the final size, sent at once; the bytes follow as
  they reach the server. A range beyond what has arrived waits for it.
- It is cut off (the body ends short) when no new bytes arrive for 60 s, or when the upload is cancelled. Resume as
  after any broken download: `Range: bytes=N-` with `If-Range: <ETag>`. On `upload-cancelled`, give up and delete the
  partial file.
- The `ETag` (`"f-<id>-<size>"`) is the same before and after the upload finishes, so `If-Range` resumes across the
  finish. There is no `Last-Modified` until it finishes, so use the ETag.
- The server reads what arrived from its disk, so a slow download never slows the upload.
- Apps that save received files automatically may start on the first `upload` event for them (the Windows app does for
  files of 32 MB or more).
- **(1.15.1)** After a broken download of such a file, `GET /api/uploads/{id}` says how far the upload has got:
  `received` past what you have means the sender is still sending, so go on at once; otherwise wait for the next
  `upload` event (in background mode only the first one is urgent, so also look again now and then).

### Live events
`GET /api/events?device=<id>&name=<uri-encoded name>&platform=<platform>` is a Server-Sent Events stream:

| event | data |
|---|---|
| `hello` | **(v3)** always first: `{ "serverId", "version", "api", "web" }`. `web` is a short hash of the web app's files: a page can reload when it changes. **(1.4)** Also `"features"` (as in `GET /api/info`), `"stream"` (this stream's id, for poke), `"mode"` and `"ping"` (the effective heartbeat in seconds). **(1.5)** Also `"instance"`: a new value means the server restarted (as in `GET /api/hello`) |
| `ping` | **(v3)** `{}` after 25 s without other data (it was a `: ping` comment). **(1.4)** After `ping` seconds; `{ "poke": true }` answers a poke |
| `item` | an Item (new item) |
| `delete` | `{ "id" }` |
| `update` | `{ "id", "delivered", "pinned", "thumb" }`. The item's delivery receipts, pin or thumbnail changed. `delivered` is always the complete map (v3 adds `pinned`, `thumb`). **(1.14)** Also `reactions` (always the complete map: `{}` when none are left) and, once a text was edited, `edited`, `text` (cut as in lists) and `truncated` (with `textLength`) |
| `devices` | `{ "devices": [Device...] }` (someone came online, went offline or was renamed) |
| `refresh` | `{ "reason" }`. Devices were linked, so item senders/targets changed: re-fetch `GET /api/items` |
| `read` | **(v3)** `{ "device", "conversation", "ts" }`: a read marker moved (see Conversations) |
| `upload` | **(v3)** `{ "id", "name", "size", "offset", "mime", "from", "device", "to" }`: an upload started or progressed (at most once a second per upload), for "incoming 35%" |
| `upload-done` | **(v3)** `{ "id" }`, followed by the `item` event |
| `upload-cancelled` | **(v3)** `{ "id" }` (cancelled or expired) |
| `settings` | **(v3)** the settings object, after a change |
| `moved` | **(v3)** `{ "movedTo" }`: Beam moved (see above); the stream closes |
| `ring` | **(1.3)** `{ "device", "by", "from", "stop", "at" }`: ring (or stop ringing) the device `device`; everyone else ignores it |
| `alert` | **(1.3)** `{ "id", "kind", "device", "level", "text", "at" }` (see Alerts); ignore ones where `device` is you, except `serverDisk`, `tailscaleKey` (1.17) and `powerLoss` (1.18) |
| `speed-test` | **(1.18)** `{ "id" }`, to the asked device's own streams only (at once): run a speed test (see Speed tests) and send the result with this `id` |
| `log-request` | **(1.20)** `{ "id" }`, to the asked PC's own streams only (at once): send the end of its log with this `id` (see A PC's log) |
| `notification`, `notification-removed`, `notification-request`, `notification-request-done` | **(1.5)** see Phone notifications; only the devices concerned get them, urgent on background streams |
| `rc-request`, `rc-signal`, `rc-end`, `rc-disable` | **(1.6)** see Remote control; only the devices named get them, urgent on background streams |
| `rc-sessions` | **(1.6)** the remote control sessions going on, to everyone (not urgent) |
| `login-request`, `login-request-done` | see Signing in |
| `app-update` | see App updates |

Other notes on the stream:
- If nothing arrives for about 70 seconds, treat the connection as dead and reconnect. **(1.4)** With the feature
  `stream-modes`: after `2 × ping + 20` seconds (`ping` from `hello`). Reconnect with backoff (1s, 2s, 4s … up to 30s).
- After every (re)connect, call `GET /api/items` and process anything for you that you haven't handled yet (track
  handled item ids): events sent while you were disconnected are not replayed.
- A client that stops reading (over 1 MB unread) is disconnected (v3).
- `HEAD /api/events` is refused (`405`).

### Background streams (1.4)
With the feature `stream-modes`, `GET /api/events` takes `mode=foreground|background` and `ping=<seconds>`:

| | `foreground` (the default) | `background` |
|---|---|---|
| Heartbeat (`ping`) | 25 s | 180 s |
| Events | sent at once | urgent ones at once; the rest are held until the next heartbeat |

- `ping=` sets the heartbeat explicitly: 15–300 s (clamped).
- **Urgent** (sent at once, after anything held, so the order is kept):
  - an `item` for this device (`to` empty or containing it, `from` not it);
  - the first `upload` event of an upload for this device (the one sent when it is created; same rule on `to` and
    `from`), so apps can start a live download;
  - a `ring` for this device;
  - an `alert` that isn't about this device (and `serverDisk`);
  - `login-request`, `login-request-done` and `moved`;
  - **(1.5)** the `notification…` events (only the devices concerned get them), and a `devices` event sent when this
    device's `settings` change (any older `devices` event the stream holds is dropped);
  - **(1.6)** `rc-request`, `rc-signal`, `rc-end` and `rc-disable` (only the devices named get them).
- **Everything else is held** and goes out, in order, when the heartbeat is due, instead of the `ping`: any data counts
  as the heartbeat. Held events that only describe the latest state are merged: only the latest `devices` (and
  **(1.6)** `rc-sessions`), the latest `upload` per upload id (progress) and the latest `update` per item are kept. Past
  100 held events they go out early.
- Presence is unchanged: a device stays `online` while its stream is open. With 180 s heartbeats a phone that vanished
  may look online a few minutes longer.
- The server closes a stream after `2 × ping + 30` seconds without any traffic.

**Poke.** `POST /api/events/poke { "stream": "<id from hello>", "mode"?: "foreground"|"background", "ping"?: <seconds> }`:
- The stream is open and yours (same sign-in, or with the master key the same device) → `200 { "alive": true, "mode",
  "ping" }`. The stream gets anything held at once, then `ping { "poke": true }`. `mode` and `ping` change on the open
  stream without reconnecting (a new `mode` without `ping` takes that mode's default heartbeat).
- Otherwise → `200 { "alive": false }`: reconnect now.
- `400` for anything else in the body, an unknown `mode` or a `ping` that isn't a number.
- When to poke: when the app comes on screen (switch to `foreground`), when it leaves the screen (switch to
  `background`), and after a network change or waking from sleep. If `alive` is false, or the poke's ping doesn't
  arrive within about 5 s, reconnect.

### Phone notifications (1.5)
A phone shares the notifications of the apps its user picked; devices with `settings.phoneNotifications` on show
them and can reply, run an action or dismiss, which the phone then does. Feature `phone-notifications`.

- **Audience** of a phone's notifications: every device with `phoneNotifications: true`, except that phone.
- **Privacy:** the content (titles, texts, lines, replies) lives only in the server's memory: never in a file, never in
  the log (log lines name the app at most). Only the audience gets it. Clients keep it in memory too. A server
  restart forgets every notification; its stream `hello` then has a new `instance`, and phones send their active
  notifications again.
- **Events** about notifications go only to the devices concerned and are urgent: a background stream gets them at
  once, and no other stream is written to.
- **A device's own switch**, changed on any device (that one included): when the value changes, that device's
  streams get a `devices` event with the new list at once. Any older `devices` event they still hold is dropped
  first, so nothing from before the change arrives after it. Other devices get the usual `devices` event (held on
  background streams). Switched off, the device first gets `notification-removed { "all": true }` (without `device`):
  drop every notification shown, of every phone.

**Notification**
```json
{ "id": "<phone device id>/<key>", "device": "<phone device id>", "deviceName": "Robin Phone",
  "app": "com.whatsapp", "appName": "WhatsApp", "icon": "<sha256 of the icon PNG>" | null,
  "title": "Mom", "text": "Dinner at 7?", "lines": ["Mom: Dinner at 7?", "Dad: 👍"], "conversation": "Family" | null,
  "when": 1790723000000, "posted": 1790723000050 | null, "silent": false, "resent": false,
  "actions": [ { "id": "a0", "title": "Reply", "reply": true }, { "id": "a1", "title": "Mark as read" } ],
  "at": 1790723000123 }
```
- `when` is the app's own time for it, which can be much older (an e-mail's sent time).
- `posted` is when the phone posted it (Android's `postTime`), or `null` if the phone didn't say.
- `resent: true` means the phone sent it again, not because it changed: after a server restart (a new `instance`) or
  a reconnect. Clients use `resent` and `posted` to decide whether to alert. A re-sent notification posted long ago
  shouldn't pop up again; a new one should, however old its `when`.
- `at` is when the server got it (or its last update).

**From the sharing phone** (its `X-Beam-Device-Id` is the phone):

| Method & path | Result |
|---|---|
| `PUT /api/phone/notifications/{key}` | body: a Notification's `app`, `appName`, `icon`, `title`, `text`, `lines`, `conversation`, `when`, `posted`, `silent`, `resent`, `actions` → `204`; event `notification` (the Notification) to the audience. `key`: 1–200 of `A-Z a-z 0-9 . _ ~ -`, chosen by the phone (e.g. a hash of the notification's key). The same key again replaces it (an update) |
| `DELETE /api/phone/notifications/{key}` | gone on the phone → `204` (also for a key the server doesn't have); event `notification-removed { "id" }` to the audience |
| `DELETE /api/phone/notifications` | all of this phone's (its switch went off, or it lost notification access) → `204`; event `notification-removed { "device", "all": true }` |
| `HEAD /api/phone/icons/{sha256}` | `200` if the server has that icon, else `404`: then upload it |
| `PUT /api/phone/icons/{sha256}` | the app icon: `Content-Type: image/png`, at most 32 KB, its SHA-256 (lowercase hex) must be `{sha256}` → `204`. `400` for a wrong hash or not a PNG, `413` too big, `415` another type |
| `POST /api/phone/requests/{request}` | the answer to a `notification-request`: `{ "ok": true }` or `{ "ok": false, "error": "Open it on the phone" }` → `204`; event `notification-request-done` to the device that asked. `404` for an unknown, answered or timed-out request, or one meant for another phone |

- `app` is the package name (`[A-Za-z0-9_.]`, at most 200, required). `appName` defaults to `app`. `icon` is `null`
  or 64 lowercase hex digits.
- `when` and `posted` are times in milliseconds, or `null`. A missing `when` becomes the server's time; a missing
  `posted` stays `null`.
- `silent` and `resent` are `true` or `false` (`false` when left out).
- Limits:
  - `title` at most 200 characters, `text` 4096, `conversation` 200;
  - `lines` at most 10 of 500 (the last ten are kept);
  - `actions` at most 3 (the first three are kept), each `{ "id", "title", "reply"? }`, with ids of at most 40 of
    `A-Z a-z 0-9 . _ -`, unique, and titles of at most 40;
  - longer values are cut; wrong types get `400`; unknown fields are dropped;
  - the whole body at most 16 KB, else `413`.
- Text is cleaned:
  - bidi overrides, embeddings and isolates (U+202A–U+202E, U+2066–U+2069) are removed from every text;
  - `appName` and action titles become one line without control characters or bidi marks (like device names);
  - `title` and `conversation` become one line (line breaks and tabs turn into spaces);
  - `text` and `lines` keep line breaks (as `\n`) and tabs; other control characters are removed.
- About 20 changes a second per phone (PUT and DELETE of single notifications); more get `429` with `Retry-After: 1`.
- At most 100 per phone: a new one beyond that drops the oldest (`notification-removed`). Notifications are dropped a
  day after their last update.

**For the audience:**

| Method & path | Result |
|---|---|
| `GET /api/phone/notifications` | `{ "notifications": [Notification...] }`, newest first (by `at`); other phones' only. `403 { "reason": "off" }` for a device that doesn't show phone notifications |
| `GET /api/phone/icons/{sha256}` | the PNG, `Cache-Control: private, max-age=31536000, immutable`, or `404` (any signed-in device) |
| `POST /api/phone/notifications/{id}/reply` | `{ "action": "<an action with reply: true>", "text": "On my way" }` (text 1–4096 characters) → `202 { "request" }` |
| `POST /api/phone/notifications/{id}/action` | `{ "action": "<an action without reply>" }` → `202 { "request" }` |
| `POST /api/phone/notifications/{id}/dismiss` | no body → `202 { "request" }` |
| `POST /api/phone/notifications/dismiss` | `{ "ids": [...] }`, 1–100 ids of **one** phone → `202 { "request" }`. Ids that are already gone are left out; `404` when none is left, `400` for ids of several phones |

- `{id}` is the Notification's id. Either form works in the path: `<phone>/<key>`, or `<phone>%2F<key>`.
- Errors:
  - `403 { "reason": "off" }`: the caller doesn't show phone notifications;
  - `404`: the notification is gone;
  - `409 { "reason": "offline" }`: the phone has no open event stream;
  - `400`: a wrong `action` or an empty `text`;
  - `429` with `Retry-After`: this device sent more than 10 requests in 2 s (about 5 a second), or, with
    `{ "reason": "busy" }`, 20 requests are already waiting for that phone's answer.

**A request's way:**
1. The phone (only that phone) gets event `notification-request` (urgent):
   `{ "request", "kind": "reply"|"action"|"dismiss", "keys": ["<key>"...], "action"?, "text"?, "from": "<device id>", "by": "<device name>" }`.
2. The phone does it for its own keys and answers `POST /api/phone/requests/{request}`.
3. The device that asked (only that device) gets event `notification-request-done`:
   `{ "request", "ok": true }` or `{ "request", "ok": false, "error" }`.
   - Without an answer within 60 s, the server sends `{ "ok": false, "error": "timeout" }` itself; a later answer
     gets `404`.
4. A dismissed notification disappears everywhere when the phone's own removal sends `DELETE` (not when the request
   is made).

The activity log records only:
- sharing switched on or off ("Robin Phone shares notifications with Desktop, Robin Laptop");
- each device's switch;
- each request, with the app name only ("Desktop replied to a WhatsApp notification on Robin Phone");
- failures and timeouts;
- an hourly count.

Requests, failures and timeouts are logged at most twice a minute per kind and pair of devices. The first line
comes at once; the rest are summed up in one line ("Desktop sent Robin Phone 9 more replies in the last minute").

`GET /api/metrics` gains `phone`: counters only.

### Remote control (1.6)
See and control a PC's own signed-in screen from another PC, a browser or the phone. Feature `remote-control`.

Media and input go directly between the two devices over Tailscale (WebRTC). The server only introduces them:
- it relays their signalling;
- it keeps a table of sessions **in memory only**: never on disk, and a restart forgets them;
- it logs who controlled which PC, from which machine, when, for how long and how it ended, never what was sent.

The PC enforces every rule itself: its switch, its banner, the lease, and the peer's Tailscale address.

**Who takes part**
- **Every route** needs a device signed in for good: a session-only sign-in (a borrowed computer) gets
  `403 { "reason": "temporary" }`. Browsers need same-origin proof (CSRF), as everywhere. Every answer is
  `Cache-Control: no-store`.
- **Which sign-ins.** The sign-in (its token) decides, never the device id it names. To start a session, or to be
  or act as the PC, the request's sign-in must be one of these:
  - **a Beam app's own sign-in**: made for Windows or Android, however it was made (Tailscale identity included). A
    Windows sign-in must also be key-bound (see Device keys). The apps' own pages use it as their cookie, so the
    Windows viewer window qualifies. So does the Android activity's cookie from `POST /api/login` with the app's token: a token made
    from another keeps its platform and origin;
  - **a browser sign-in made with something only the user has**: the password, a pairing link or code, a sign-in
    request approved on another device, or the master key;
  - the master key itself.

  Never eligible, with `403 { "reason": "sign-in" }` ("sign in to Beam on this device with a pairing link, an approval
  or the password"):
  - a browser signed in by Tailscale identity (or, before 1.14.3, because a Beam app ran on the same machine). Any
    Windows account on that machine gets those; a browser linked to an app's id is still refused;
  - the CLI.

  More:
  - The PC itself must be a key-bound Windows app sign-in (or the master key).
  - A Beam app's own requests (`Authorization: Bearer` with `X-Beam-Platform` of an app) must send `X-Beam-Profile`
    (`403 { "reason": "profile" }`).
  - Tokens from before 1.6 don't record their platform. They count as a browser's until the app they belong to uses
    one for its own requests (bearer, its platform); then it counts as that app's.
- **Owners' machines.** With Tailscale, when the server knows its owners (`BEAM_TAILSCALE_OWNERS`, or learned from
  sign-ins through `tailscale serve`):
  - a viewer whose machine's whois login isn't an owner gets `403 { "reason": "not-owner" }`;
  - a PC on such a machine is never tied to its app (below) and can't be controlled.
- **The PC** is a Windows PC with `can.remoteControl`: the Beam app 1.6+, "Allow remote control" on, tied to its app,
  not locked. Only the PC itself turns its switch on; any device can turn it off (`POST /api/rc/disable`).
- **The PC's app ("tied").** The first `remoteControl: true` that the PC's own app reports ties remote control to
  that app's Tailscale machine (or the server's own machine) and Windows account (`X-Beam-Profile`). It must come
  through Tailscale, from a sign-in that qualifies.
  - From then on, only requests from there may act as the PC: lease, signal, end with a PC reason, and report
    `remoteControl` or `locked` in its status. Anything else gets `403 { "reason": "machine" }`.
  - The PC's address is attested from there, and the PC's events go only to its streams from there.
  - The same Tailscale node at a new address (the same whois StableID) is followed.
  - Otherwise the tie is kept until the device is removed. To tie a PC to a new machine or account, remove it in
    Settings and sign it in again.
- **The viewer is the sign-in that started the session.** Its signals must use that sign-in (another sign-in naming
  the same device gets `404`), and the viewer's events go only to that sign-in's streams.
- **One session per PC.** A viewer may control several PCs at once.
- **Addresses are attested.** The server tells each side the other's Tailscale addresses as it saw them (through
  `tailscale serve`, plus `tailscale whois`), never what a client claims.
  - The viewer's come from the request that starts the session.
  - The PC's come from the machine its app is tied to.
  - A PC on the server's own machine has the server's addresses.
  - A device that reaches Beam without Tailscale can't take part (`no-tailscale`).

| Method & path | Who | Result |
|---|---|---|
| `POST /api/rc/sessions` | the viewer | `{ "device": "<PC id>", "kind"? }` → `201 { "id", "host": { "id", "name", "ip4", "ip6" }, "you": { "ip4", "ip6" } }`; event `rc-request` to the PC. `kind` (1.16): `view` (the default) or `kvm` (below; another value is `400`). Other fields in the body are ignored |
| `POST /api/rc/sessions/{id}/signal` | either party | `{ "kind": "offer"\|"answer"\|"candidates"\|"restart", "sdp"?, "candidates"? }` → `204`; event `rc-signal` to the other party only |
| `POST /api/rc/sessions/{id}/lease` | the PC | → `200 { "ok": true }`. `410 { "reason" }` once the session has ended, `404` when the server doesn't know it (it restarted): end the session then |
| `POST /api/rc/sessions/{id}/end` | either party, or any other signed-in device | `{ "reason"?, "detail"? }` → `204` (also for a session that has just ended); event `rc-end` to both parties. `detail` (1.7.3, from a party only): why its own check hung up, for the server's log, as kinds only (anything shaped like an address is left out), e.g. "the connection went to no address (prflx candidate)" |
| `GET /api/rc/sessions` | any signed-in device | `{ "sessions": [{ "id", "host", "viewer", "since", "state", "kind" }] }` (`kind` 1.16) |
| `POST /api/rc/disable` | any signed-in device | `{ "device": "<PC id>" }` → `202`; event `rc-disable` to the PC; its sessions end (`revoked`) |

- **Sessions:**
  - `id` is 16 hex digits;
  - `host` and `viewer` are device ids;
  - `since` is when it was asked for;
  - `state` is `requested` until the PC's first lease or signal, then `live`.
- **Starting.** Errors, in this order:
  1. `403 { "reason" }`: `temporary`, `sign-in` or `profile`;
  2. `429` with `Retry-After`: more than 10 requests a minute from this device;
  3. `400` without `device`; `404` for an unknown device;
  4. `409 { "reason" }`, one of:
     - `self`: it's the device itself;
     - `not-allowed`: not a Windows PC with Beam 1.6+, its switch is off or not tied to its app, or it was turned
       off from elsewhere;
     - `old-app` (1.16, kind `kvm`): the PC's app is older than 1.12;
     - `locked`;
     - `offline`: the PC's app has no open event stream;
     - `busy`: another device controls it;
  5. `401`: the viewer was signed out or removed while the server looked up the addresses;
  6. `409 no-tailscale`, `403 not-owner` (this device's machine) or `409 not-owner` (the PC's).

  The same viewer asking again (after a reload) replaces its own session of the same kind; the old one ends `stopped`.
- **Keyboard and mouse (kind `kvm`, 1.16; feature `kvm`).** Another PC's own keyboard and mouse work this PC: its
  pointer comes over the edge of its own screen (the Windows app 1.12's "Keyboard and mouse across PCs"). The same
  rules as above, the same signalling and channels (with `clip`, Windows 1.12.4: clipboard pictures), and **no
  picture**: the PC captures nothing. Its banner can be folded into its tray there.
  - The PC needs the Beam app 1.12 or later (`409 old-app`). `rc-request` carries `"kind": "kvm"`.
  - A kvm session never takes the place of someone viewing the PC: it gets `409 busy`. Someone asking to view the PC
    ends a kvm session (`rc-end` reason `busy`, `from`/`by` the one viewing); the viewer's app asks again later. The
    same viewer's kvm request again replaces its own kvm session.
  - The log says "… asked to share its keyboard and mouse with …", "…'s keyboard and mouse can reach …" and "…'s keyboard
    and mouse stopped reaching … after …".
- **Signals:** the PC offers (`offer`) and the viewer answers (`answer`). Both trickle `candidates` and may ask for an
  ICE restart (`restart`, no payload).
  - The viewer sends nothing before the PC has accepted (its first lease or signal): `409 { "reason": "waiting" }`.
  - `sdp` is required for offer and answer, at most 64 KB (`413`).
  - `candidates`: 1–20 `RTCIceCandidateInit` objects, `{ "candidate", "sdpMid", "sdpMLineIndex",
    "usernameFragment"? }`. `candidate` is at most 256 characters, and `""` means the end of candidates. Other
    fields are dropped.
  - A session carries at most 300 signals and 512 KB of SDPs and candidates (`429 { "reason": "signals" }`).
  - A wrong kind or role gets `400`, a device or sign-in that isn't a party `404`, an ended session `410`, and the PC
    from another machine or account `403 machine`.
  - Signals aren't stored or replayed. A side that missed one (its stream reconnected) asks for a `restart`.
- **Lease:** the PC leases as soon as it has accepted (its banner is up), then every 30 s. The server ends a session
  whose lease is 90 s late (`rc-end`, reason `lease`).
- **End reasons:**
  - either party may give `stopped` (the default), `declined`, `busy`, `locked` or `failed`;
  - only the PC (its own app) may give `not-listed`: the viewer isn't on the PC's "Who can control this PC" list. The
    viewer then shows "This PC doesn't allow control from <device>; add it on the PC";
  - anyone else, or a party giving a reason it may not, ends it as `stopped`;
  - an unknown reason is `400`;
  - the server's own are `revoked`, `lease` and `server`.
- **What ends sessions:**
  - `/end` (both parties hear `rc-end` at once);
  - a lease that is 90 s late (`lease`);
  - removing either device, `sign-out-others` or a device merge: all of that device's sessions (`revoked`);
  - signing out (revoking) one sign-in: only the sessions it takes part in (`revoked`). That's a session it started as
    the viewer, or one where it is the PC app's own sign-in. Before the PC has acted, that means any Windows sign-in
    of the PC;
  - the PC reporting `remoteControl: false`, or `POST /api/rc/disable` (`revoked`);
  - a move or a shutdown (`server`).

  A restart forgets every session without events: the PC's next lease gets `404`.

| Event | To | Data |
|---|---|---|
| `rc-request` | the PC | `{ "id", "from": "<viewer id>", "by": "<viewer name>", "viewer": { "ip", "ip4", "ip6", "node", "user", "platform" }, "at" }` |
| `rc-signal` | the other party | `{ "id", "from", "kind", "sdp"?, "candidates"? }` |
| `rc-end` | both parties | `{ "id", "reason", "from", "by" }`: the device that ended it (`from` its id, `by` its name), both `null` when the server did |
| `rc-disable` | the PC | `{ "from", "by" }`: turn "Allow remote control" off and end every session |
| `rc-sessions` | everyone signed in for good | `{ "sessions": [...] }`, as `GET /api/rc/sessions` |

- **`rc-request`, `rc-signal` and `rc-end`** are urgent (a background stream gets them at once).
  - The PC's go only to its app's streams from the machine and account it's tied to.
  - The viewer's go only to the streams of the sign-in that started the session.
- **`rc-disable`** goes to every stream of the PC's device.
- **What `rc-request` confirms:**
  - `by` is the name the viewer chose for itself;
  - `viewer.node` (the Tailscale machine name), `viewer.user` (its Tailscale login, an owner when the server knows its
    owners) and `viewer.ip` (the Tailscale address the request came from) are confirmed by Tailscale and the request:
    lead with those;
  - `ip4` and `ip6` are the machine's addresses (either may be `null`); `platform` is its Beam platform.
- **`rc-sessions`** isn't urgent (background streams hold only the latest) and never reaches session-only sign-ins.
- **A PC's app that connects again** hears `rc-request` for sessions still waiting for it, and a pending `rc-disable`.
- **A pending disable:** `POST /api/rc/disable` for a PC whose switch is on keeps it out of reach (`can.remoteControl`
  false, `not-allowed`) until its own app reports `remoteControl: false`.
  - It repeats `rc-disable` whenever that PC's app connects or reports the switch on.
  - It also moves with a reinstalled app (a device merge). The new app reports its own switch and lock; they are
    never inherited.
- **On disk, with the device:** the pending disable `{ at, from }` and the tie `{ machine, profile, node, at }`. That's
  the only remote control state on disk.

The activity log records only:
- "Desktop's remote control is tied to its Beam app on desk (100.64.0.1)";
- "Robin Laptop asked to control Desktop (from robin-laptop, 100.64.0.2, robin@example.com)";
- "Robin Laptop is controlling Desktop";
- "Robin Laptop stopped controlling Desktop after 14 min (stopped, by Robin Laptop)";
- refusals, summed up per minute;
- "Pixel turned off remote control on Desktop" and "Desktop allows remote control now".

`GET /api/metrics` gains `rc`: `{ "sessions", "live", "started", "refused", "ended": { "<reason>": count } }`.

### Control for a Linux computer (1.23)
Feature `vnc`. A computer with Beam for Linux 1.2 or later (a Raspberry Pi first) shares its own screen through its
desktop's VNC server, [wayvnc](https://github.com/any1/wayvnc), and the server relays the bytes between it and the
viewer. Unlike a PC's, nothing goes directly between the two devices. Everything above holds, with these differences:
- **The session's kind is `vnc`** (`POST /api/rc/sessions { "device", "kind": "vnc" }`), only for a `linux` device. A
  `view` request for one gets `409 { "reason": "vnc" }` (the PCs' viewer then opens the VNC one), and `vnc` for
  anything else `400`. `rc-request` carries `"kind": "vnc"`.
- **The computer** is its Beam for Linux: `can.remoteControl` needs 1.2 or later (else `not-allowed`, "needs Beam for
  Linux 1.2.0 or later"), `remoteControl: true` in its status (turned on only there: `beam control on`, kept in its
  `~/.beam.json`), and the tie to its machine and account (`X-Beam-Profile`). Its own sign-in counts like the Android
  app's (made for `linux`, not automatically); it leases as a PC does and may end with a PC's reasons.
- **The relay:** `GET /api/rc/sessions/{id}/vnc` with `Upgrade: websocket` (RFC 6455; a `binary` subprotocol is echoed),
  from each party:
  - the viewer, with the sign-in that started the session (`404` for any other); with a cookie, only from Beam's own
    pages (the `Origin` must be this Beam's: `403 { "reason": "csrf" }`);
  - the computer's own Beam for Linux (as for a lease: `403 { "reason": "machine" }` from elsewhere).
  
  `401` without a sign-in, `404`/`410` as for the session, `400` for any other path or a request that isn't a WebSocket
  upgrade. The server pings each side every 30 s; one that doesn't answer is let go. Data frames (binary or text) are a
  byte stream either way: what one side sends, the other gets, in order, each side waiting for the other when it's
  behind. Up to 1 MB that one side sends before the other has joined is kept for it; the other side has 30 s to join.
- **Either side closing its WebSocket ends the session** (`stopped`, by that side), and the session ending closes both
  (close code 1000 for `stopped`, 4000 otherwise, with the reason as its text). The other side not joining in time ends it
  `failed` ("the computer didn't join"; "the viewer didn't join").
- **`rc-end` for a vnc session carries `detail`**: the computer's own words when it ended it with one ("wayvnc isn't
  installed (sudo apt install wayvnc)"), or the server's.
- **Beam for Linux's side:** on `rc-request` (kind `vnc`) it checks its switch, starts wayvnc on a socket only its user
  can open (`$XDG_RUNTIME_DIR/beam/vnc.sock`, the folder 0700; `-u <path>`, or `unix:<path>` for newer wayvnc;
  `--render-cursor`; the keyboard layout from `/etc/default/keyboard`), leases, opens the relay and joins the two;
  wayvnc stops a minute after the last session. A notification on the computer says who is controlling it. `rc-disable`
  turns its switch off there too. It needs a Wayland desktop that's on (Raspberry Pi OS's labwc or Wayfire); otherwise
  it ends the session `failed` with why.
- **The viewer** is `index.html#vnc=<device id>` (`public/vnc.js`, with noVNC 1.7 in `public/novnc/`, unchanged,
  MPL-2.0): Fit (shrinks a screen bigger than the window, never enlarges one; 1.23.1) or 1:1 (scrolls), JPEG quality 9
  (sharp text; 1.23.1), mouse, keyboard and touch through noVNC, "Paste there" (this device's clipboard to the
  computer's) and Copy (what was copied on the computer), full screen, Disconnect. `#remote=<id>` for a Linux computer
  moves to it.

### Settings (v3)
| Method & path | Result |
|---|---|
| `GET /api/settings` | `{ "movedTo", "publicUrl", "publicUrlLearned", "tailscaleSignIn", "tailscaleOwners": [...], "tailscaleOwnersFixed": [...] (1.7.3: from BEAM_TAILSCALE_OWNERS), "tailscaleSeen": [{ "login", "since", "last", "devices": [names] }] (1.7.3: accounts that signed in on purpose but aren't owners), "retentionDays", "maxItems", "blockedNodes": [{ "node", "name", "since", "device" }], "alerts": { "battery", "storage", "serverDisk", "offline": [...] }, "locked": [...] }` |
| `DELETE /api/settings/blocked-nodes/{node}` | unblock one Tailscale machine (URI-encode `node`) → the new settings |
| `PATCH /api/settings` | any of `publicUrl` (`""`/`null` = learn again), `tailscaleSignIn`, `tailscaleOwners`, `retentionDays` (0 = forever … 3650), `maxItems` (0 = no limit … 100000), and `unblockNode: "<node>"` (or a list) to let a blocked Tailscale machine sign in automatically again. (1.7.3) `allowOwner: "<login>"` / `removeOwner: "<login>"` add or remove one owner (not one from BEAM_TAILSCALE_OWNERS: `409`). Owners are never learned by just seeing an account: a login becomes one on a brand-new Beam's first sign-in, from these settings or BEAM_TAILSCALE_OWNERS, or, on a Beam with no owner at all, from a sign-in made on purpose; other accounts that sign in on purpose are listed in `tailscaleSeen`. Letting more in (`allowOwner`, `tailscaleOwners`, `tailscaleSignIn: true`) needs a sign-in made on purpose (the password, a pairing link or code, an approval, the master key, a Beam app's own): else `403` reason `sign-in`. Everything is checked before anything changes. Also `alerts` (1.3): any of `battery`, `storage`, `serverDisk` (true/false) and `offline` (the full list of watched device ids); kinds you leave out keep their value. → the new settings; event `settings`. `400` for unknown or invalid values, `409` for ones fixed by an environment variable (listed in `locked`) |

`publicUrl` is learned from the first https address seen through `tailscale serve` (or another trusted proxy) on a
signed-in request, unless configured.

### Other
| Method & path | Result |
|---|---|
| `GET /api/me` | `{ "ok": true, "you", "api": 3, "read": {...}, "auth": { "via": "master"|"token", "user", "role", "session"? }, "machine": { "name" } | null }`. `machine.name` is this device's Tailscale machine name when known (v3) |
| `GET /api/info` | `{ "version", "api", "serverId", "features": [...], "uptime", "retentionDays", "maxItems", "maxUpload", "chunkSize", "maxChunkSize" (1.4), "maxStorage", "storage": { "used", "items", "files", "free", "total" }, "publicUrl", "urls", "tailscaleSignIn", "tailscaleOwners", "moving", "apps": { "windows", "android" }, "passwordSet", "ntfy", "settings", "family" (1.7: Beam Family's address from `BEAM_FAMILY_URL`, or null; see docs/FAMILY.md) }` |
| `GET /api/pair` | `{ "key": "bp_…", "lanUrl", "publicUrl", "expiresAt", "link" }`. `key` is a single-use pairing token valid 15 minutes (v3; it was the master key) |
| `POST /api/password` | `{ "password", "current"? }` sets it (≥ 8 characters); `""` removes it. Changing or removing a set password takes `current` (1.7.2; `403 reason: "current-password"` without it or when wrong), except from a sign-in made deliberately (the password, a pairing link, an approval, the master key, a Beam app's own) |
| `POST /api/security/sign-out-others` | **(v3)** optional body `{ "disableTailscaleSignIn": true }`. New master key, every sign-in revoked, every other device's Tailscale machine blocked, learned Tailscale owners dropped; the caller gets `{ "key": "bt_…", "revoked": n, "tailscaleSignIn" }` (and `X-Beam-Token` / a cookie). `409` when the key comes from `BEAM_KEY` |
| `POST /api/logout` | Signs this browser out: revokes its token, clears the cookie, and sends `Clear-Site-Data: "cache", "storage"` (v3) |
| `GET /api/logs?lines=200` | **(v3)** `{ "lines": [...] }`, the end of the server log (`data/logs/server.log`). **(1.14.3)** `403` for a session-only sign-in, as backups |
| `GET /api/alerts` | **(1.3)** `{ "alerts": [Alert...] }`, the last 100, newest first (see Alerts) |
| `GET /api/connections` | **(1.17, feature `connections`)** how tailscaled on this server reaches each device's machine: `{ "tailscale": true, "server": { "name", "keyExpiry", "expired"? }, "machines": [{ "id", "name", "platform", "online", "machine": { "name", "ip", "self"?, "online", "lastSeen"?, "keyExpiry", "expired"? }, "path" }], "at" }`. One row per machine, named after its Beam app (a browser on it shares the row; `online` when any of them is). `path`: `{ "via": "direct", "lan" }` (lan: an address of the same network), `{ "via": "peer-relay" }` or `{ "via": "relay", "relay": "nyc" }` (Tailscale's relay, by region), plus `at` and, from a test, `ms` and `tested: true`; `null` until tailscaled has used a path to it (an idle machine has none). `tailscale: false` (and no `server`) when the server doesn't see Tailscale **(1.18)** Each machine also has `speed` (its devices' latest speed test, `{ "down", "up", "at" }` in Mbit/s, or `null`), `speedTest: true` when its Beam app can be asked for one (Windows 1.13 or later), and `here: true` for the asking device's own machine (that one tests in its own page) |
| `POST /api/connections/{id}/test` | **(1.17)** three disco pings to that device's machine now (`tailscale ping`; about 3 s, longer for a machine that doesn't answer) → `{ "path": { "via", "lan"?, "relay"?, "ms", "at", "tested": true } }` (the way of the last answer, the middle delay of the answers that took it; a sleeping phone answers slower), or `{ "path": null }` when nothing answered. One test per machine at a time (a second request gets the same answer). `409` for a device without a Tailscale machine, or the server's own |
| `POST /api/connections/{id}/speed` | **(1.18, feature `speed-test`)** asks that device's Beam app (Windows 1.13 or later, online) for a speed test now: the event `speed-test { id }` goes to it; it tests and answers through `POST /api/speedtest/result` with that `id` → `{ "speed": { "down", "up", "at" } }`. `409` when it can't (too old, offline, already testing, the asking device itself) or didn't finish within a minute |
| `GET /api/speedtest/down?bytes=N` | **(1.18)** N bytes of noise (8 MB unless asked, 64 MB at most), `no-store`, never compressed |
| `POST /api/speedtest/up` | **(1.18)** a body of test data (64 MB at most; `413` beyond), read and dropped → `{ "bytes" }` |
| `POST /api/speedtest/result` | **(1.18)** `{ "down", "up" }` (Mbit/s, what this device measured), `"id"` when it was asked → `{ "speed" }`, kept as its latest. A test: requests one after another, each bigger while they're quick (256 KB up to 16 MB), for about 3 s each way and 64 MB at most each, through the address the device's transfers use |
| `POST /api/events/poke` | **(1.4)** see Background streams |
| `POST /api/clear-cache` | **(1.4, feature `clear-cache`)** no sign-in needed, changes nothing on the server → `204` with `Clear-Site-Data: "cache"` (and `Cache-Control: no-store`): the browser drops what it cached from this Beam (thumbnails, files viewed inline, which are cached for a year). Call it after a `401` confirmed to come from your own Beam, once you have wiped your data. Only from Beam's own pages: a `Sec-Fetch-Site` other than `same-origin`, or a foreign `Origin`, gets `403 { reason: "csrf" }` |
| `GET /api/metrics` | **(1.4)** how the server is doing (see Metrics). **(1.14.3)** `403` for a session-only sign-in, as backups |
| `POST /api/move`, `DELETE /api/move` | **(v3)** see When the server moves |
| `GET /api/admin/export` | **(v3)** the whole Beam as a `.tar.gz` (master key, or a token from an approved `purpose: "move"` request). `?freeze` pauses changes until a move completes |
| `GET /api/backups` | **(1.8.1, feature `backups`)** this server's own backups: `{ "dir", "hours", "keep", "filesMB", "running", "last": { "at", "name", "bytes", "files", "filesLeftOut", "why" } \| { "at", "error" } \| null, "backups": [{ "name", "at", "bytes" }] }` (newest first). A backup is an export (`beam-backup-<UTC time>.tar.gz`), made every `BEAM_BACKUP_HOURS` into `BEAM_BACKUP_DIR`; the newest `BEAM_BACKUP_KEEP` are kept. Item files go in while they add up to `BEAM_BACKUP_FILES_MB`, the smallest first (1.14.3; before, all or none): `files` is true when every one went in, `filesLeftOut` counts the rest (also in the archive's `beam-export.json`); a file left out isn't in the backup's item list. Restore: stop Beam, then `node server.js import <backup> --force`. `403` for a session-only sign-in |
| `POST /api/backups` | **(1.8.1)** a backup now (Settings → Server, `node server.js backup`) → `201` with the same as `GET`; one at a time (a second gets the one being written). `500` if writing it failed |
| `POST /api/admin/shutdown` | **(v3)** stops the server cleanly; master key, from the server machine only (`node server.js stop`) |
| `GET /api/qr.svg?data=…`, `GET /api/qr.png?data=…` | a QR code (signed-in only) |
| `GET /api/updates` | see App updates |
| `POST /api/updates/release` | **(1.19, feature `staged-updates`)** the Windows build waiting on the PC that tries it first (or stopped there) goes to every PC now → `{ "rollout" }`; `409` when nothing is waiting; `403` for a session-only sign-in |
| `GET /download/windows` | the Windows app (`Beam.exe`), if built |
| `GET /download/android` | the Android app (`beam.apk`), if built |

### Compression and connections (1.4)
- JSON responses over 1 KB are gzipped when the request says `Accept-Encoding: gzip` (feature `gzip`). Event streams
  and file bodies never are. Browsers, OkHttp and Node's `fetch` ask by themselves; .NET Framework needs
  `AutomaticDecompression`.
- JSON responses carry `Content-Length`.
- Idle connections stay open 100 s (it was 5 s; longer than the 90 s `tailscale serve` keeps them), so a client that
  reuses its connection skips a new one (a round trip,
  more with TLS).
- Creating an item (text, file, finished upload, forward) and deleting items are answered once the change is on the
  server's disk (at most 5 s later if the disk is failing). Other changes are saved within about a second.
- The web app's files are also served with brotli (`br`) when asked. `index.html` refers to the app's scripts, styles
  and icons as `name?v=<first 10 hex digits of the file's SHA-256>`; those exact URLs are
  `Cache-Control: public, max-age=31536000, immutable`. `index.html` itself, and any file asked for without `?v=` or
  with another version, is `no-cache` (revalidate with its `ETag`).

### Metrics (1.4)
`GET /api/metrics` (a lasting sign-in: `403` for a session-only one since 1.14.3) →
```json
{ "at": 1790723000000, "version": "1.4.0", "uptime": 3600,
  "process": { "rss": 0, "heapUsed": 0, "heapTotal": 0, "external": 0, "cpu": { "user": 1.2, "system": 0.4 },
               "loop": { "utilization": 0.0021, "since": 1790723000000, "p50": 10.1, "p99": 12.3, "max": 25.7 } },
  "requests": { "listItems": { "count": 12, "p50": 1.9, "p95": 4.2, "bytes": 120000, "bytesIn": 3000 } },
  "streams": [ { "device", "name", "kind": "app", "mode": "background", "ping": 180, "since", "writes", "bytes",
                 "events", "held", "heldTotal", "pokes" } ],
  "store": { "writes": 40, "bytes": 800000, "fsyncs": 40, "ms": 120.5, "files": { "items.json": { "writes", "bytes", "ms" } } } }
```
- `cpu` is seconds since start; `loop.utilization` is the share of time the server was busy since start.
- Event-loop delay (`p50`/`p99`/`max`, ms) is sampled only for an hour after each `GET /api/metrics`, so the first
  call starts it (`null` until then) and an unwatched server pays nothing for it.
- `requests`: per route (the handler's name, e.g. `listItems`, `putChunk`, `getFile`; `static`, `signIn`,
  `unauthorized`, `notFound`), with times in ms and bytes on the wire (headers included) since start. Event streams
  are under `streams`.
- `streams`: `writes` is how often the server wrote to the stream (each one wakes the device's radio), `events` the
  events offered to it, `held` how many wait now, `heldTotal` how many ever waited, `pokes` the pokes it got.
- `store`: durable saves (state files, upload metadata, thumbnails and long texts) with their fsyncs and time.

### Limits and errors (v3)
| Status | Meaning |
|---|---|
| `400` | bad input: JSON bodies must be objects; `to` must be a list or comma string |
| `401` | not signed in, or the token was revoked. **(1.4)** The body is `{ "error", "serverId" }`: wipe a cached sign-in, outbox or offline copy only when `serverId` is the Beam you signed in to (a different or fresh server at the same address, e.g. during a move, must not sign you out); without `serverId` (a 1.3 server) compare `GET /api/hello`. A `401` never clears anything by itself: once a page has confirmed the `serverId` and wiped its own data, it calls `POST /api/clear-cache` to drop the browser's HTTP cache too |
| `403` | refused. `reason: "csrf"` for cross-site browser requests; see autopair for its reasons |
| `409` | wrong upload offset / chunk still being written / move target doesn't check out / setting fixed by an env var / a device that can't ring or hasn't reported adapters to wake (1.3) |
| `410` | Beam moved: `{ movedTo }` |
| `413` | too large |
| `415` | cookie request without `Content-Type: application/json`, or a thumbnail that isn't JPEG/WebP |
| `429` | too many attempts: sign-in (password, pending requests) or bad keys (30 per address per 5 minutes), or too many connections from one address; `Retry-After` when known |
| `503` | Beam is moving; retry after `Retry-After` seconds |
| `507` | not enough space on the server (disk, or `BEAM_MAX_STORAGE_GB`) |

Other limits:
- Ordinary request bodies must arrive within 30 s (texts within 5 minutes).
- Uploads fail after 60 s without data.
- Retention: items older than `retentionDays` are removed once delivered. Undelivered ones get up to three times as
  long. Pinned ones stay.
- When over `maxItems` or the storage limit, the oldest delivered, unpinned items go first.

## Client behaviour checklist

- Acknowledge (`POST /api/items/{id}/ack`) an item for you once you have handled it (shown a notification, copied it,
  or saved the file). The sender's UI shows "Delivered".
- Save received files with a unique name (`photo (1).jpg`). Download to a temporary name, then rename when complete.
  Resume with `Range` + `If-Range`.
- Never auto-open or run a received file. Only save it, show it, or reveal it in the file manager.
- **(v3)** Store whatever `key` you're given. On `X-Beam-Token`, replace your stored key with it. On `401`, show sign-in
  again: the device may have been removed.
- **(v3)** Adopt `you` / `X-Beam-You` when it differs from your device id.
- **(v3)** Before following a move or a rediscovered server, check `serverId` **and** the hello `proof`.
- **(v3)** Replace an item's `delivered` wholesale on every `update` event (it is always complete); read `pinned`/`thumb`
  from it.
- **(1.3)** Apps report their status (`PUT /api/devices/me/status`) on connect, every 15 minutes and on real changes.
  Send `X-Beam-App-Version` on requests.
- **(1.3)** React to a `ring` event only when `device` is you. Ignore `alert` events about yourself (except
  `serverDisk`).
- **(1.4)** Check `features` and fall back when a flag is missing (a 1.3 server has none of these):
  - `stream-modes`: open the stream with `mode=background` whenever no Beam window is on screen, poke to switch to
    `foreground` when one is, and poke after network changes and waking up.
  - `items-since`: keep the list cached with its `cursor` and fetch with `since` after reconnecting.
  - `gzip`: send `Accept-Encoding: gzip`.
  - `live-download`: a download started on a file that is still arriving must just work.
  - `big-chunks`: upload in big chunks (see Big chunks).
- **(1.5)** With the feature `phone-notifications`:
  - show the switch "Show phone notifications" from `settings.phoneNotifications` (off by default in browsers);
  - keep notification content in memory only;
  - follow the device's own switch from `devices` events (it may be changed on another device), and drop everything
    shown on `notification-removed { "all": true }` without `device`;
  - phones send their active notifications again when the stream's `instance` changes.
- **(1.6)** With the feature `remote-control`:
  - offer "Control" for devices with `can.remoteControl`; for a PC whose `status.locked` is true, Remote Desktop
    instead;
  - a viewer opens its event stream before `POST /api/rc/sessions` (signals arrive there), with the same sign-in it
    starts the session with. It keeps the session id, sends nothing before the PC's offer, and ends the session when
    it leaves;
  - a Beam app sends `X-Beam-Profile` on its own requests and its event stream;
  - the PC's banner leads with what `rc-request` confirms (`viewer.node`, `viewer.ip`, `viewer.user`), then `by`;
  - the PC ends a session with `not-listed` when the viewer isn't on its list;
  - the PC (Beam for Windows) reports `remoteControl` and `locked` in its status, leases as soon as it has accepted and
    every 30 s, ends a session on any lease answer but `200`, and turns its switch off on `rc-disable`;
  - both sides check the peer's address against the one the server attested (`rc-request` `viewer`, the `201`'s
    `host`). A remote whose address the browser won't tell (a peer-reflexive candidate: "" in `getStats`, and the
    placeholder `redacted-ip.invalid` from newer `getSelectedCandidatePair()`) is "not known yet": input waits, and
    only one that stays so for 5 s, or an address that isn't the attested one, hangs up (1.7.3: the Android viewer
    took the placeholder for a stranger and hung up a moment after connecting).
