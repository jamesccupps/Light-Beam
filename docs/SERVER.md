# Running the server

## Tailscale, ports and firewalls

With Tailscale you don't open or forward any ports. Every device connects *outward* to Tailscale.
The Beam server only listens on the host computer, and `tailscale serve` hands it the traffic. Your network
only needs to allow the outbound connections Tailscale uses:

- TCP 443 to `*.tailscale.com`, `*.tailscale.io` and `acme-v02.api.letsencrypt.org`
- UDP 41641 and 3478, for direct connections; without these Tailscale falls back to relays over 443

Content filters sometimes put Tailscale in a "VPN" category. If a filter blocks any of the names above, allow them
there.

Without Tailscale, Beam works on your home network over plain HTTP. Phones then need the host's firewall to allow
inbound TCP 8765 on private networks.

## Running the server

```bash
node server.js                 # run it (the installers use --supervise, which restarts it if it crashes)
node server.js stop            # stop it cleanly (an -AtBoot task starts it again within 5 minutes)
node server.js pair            # a one-time link + QR code to add a device (the key itself is never printed)
node server.js export          # save everything to beam-export-<date>.tar.gz (also: npm run backup)
node server.js help            # all commands
```

- **Logs:** `data/logs/server.log` (timestamped; the last 25 MB are kept). Also under **Settings → Server → Server log** on any
  signed-in device. Besides sign-ins, settings changes and errors, it records:
  - **Devices:** when each one comes online and goes offline, and which Beam version it runs. Short blips, like a phone
    switching networks, are left out.
  - **Items:** everything sent, who it went to and when it was delivered. Messages appear by length only (never
    their text); files by name and size.
  - **Transfers:** big uploads and downloads with their speed, plus stalls, resumes and cancels.
  - **App updates:** new builds, and which devices downloaded them.
  - **Housekeeping:** clean-ups, and wrong or revoked keys.
  - **Status:** an hourly line (devices online, items, storage, free disk), and a warning when the disk runs low.

  `data/logs/supervisor.log` records crashes and restarts.
- **Backups:** `node server.js export [file]` works while Beam runs. The file holds everything, including the key,
  so keep it private. `node server.js import <file>` restores it into an empty data folder.
- **Safety:** state files are written atomically and fsynced, with a `.bak` of the previous version. Beam never deletes
  stored files it doesn't recognize; it moves them to `data/orphaned/`. Uploads that don't fit on the disk are refused
  up front.
- **Health:** `GET /api/hello` answers without a key; Docker uses it as a health check.
- **Stats:** `GET /api/metrics` (signed in) shows memory and CPU, how long requests take, how often each device's
  connection is woken, and how much the server writes to disk.
- **Alerts** are kept in `data/alerts.json` (the last 100) and also go to ntfy if it's configured.
- **Each device's history** is kept in `data/history.json` (120 days, part of exports and backups).
- **Wake-on-LAN** packets go out from the server itself, so the server must be on the same network as the PCs it
  wakes (in Docker that needs host networking), or from a Beam for Linux 1.3+ computer on their network (the server
  passes each wake to them). `BEAM_WOL_TARGETS` (a list of `address[:port]`) overrides where they're sent, on the
  server and in Beam for Linux.

## Moving Beam

Everything Beam knows lives in its data folder: items, files, devices, sign-ins, settings, the key and its permanent
server id. Moving it keeps every device signed in, and the apps follow by themselves.

**The easy way: `import-from`.**
1. **Set up the new server** without starting Beam there yet: [Docker/NAS](#docker-and-nas), a
   [Windows Server](#windows-server) or [plain Linux](../deploy/beam.service).
2. **On the new server**, copy the running Beam over:
   ```bash
   node server.js import-from https://your-pc.<tailnet>.ts.net --public-url https://beam.<tailnet>.ts.net
   # Docker:  docker compose run --rm beam node server.js import-from https://… --public-url https://beam.<tailnet>.ts.net
   ```
   - It shows a code. Approve it on your phone like any sign-in; it is marked as a full copy of Beam.
   - It then copies everything. Changes on the old server pause until the move finishes, so nothing gets lost.
3. **Start Beam on the new server.** As soon as the new server answers, and has proved it holds the key:
   - the old server sends every app to it (the apps check that proof too);
   - browsers are taken to the new address and stay signed in;
   - the `beam` command follows too.

   Leave the old server running for a while to catch devices that were off, then remove just the server from the
   old computer with `install-windows.ps1 -RemoveServer`. The Beam app there stays installed, and follows Beam to its
   new address like every other device.

**By hand.** Run `node server.js export` on the old server and copy the file over. Then `node server.js import <file>`
on the new one, and start it. Finally, on the old server, `node server.js moved-to https://<new address>`. It checks
the new server first; `--force` skips the check and `--clear` undoes it. Everything else is the same.

**Never move again.** With Docker, Beam runs as its own Tailscale machine called **beam**, and that machine's
identity is kept in `data/tailscale`. Moving the whole data folder to new hardware keeps the address
`https://beam.<tailnet>.ts.net`, so clients don't even notice. Stop the old container first.

## Backups

- **The server** saves a backup of itself every day: an export (the key, sign-ins, devices, settings, items, and the
  files while they add up to at most 1 GB) into a `backups` folder next to its data folder, the newest 14 kept.
  `BEAM_BACKUP_DIR` puts them elsewhere; another drive or a NAS share keeps them safe from a failing disk too.
  Settings → Server shows the last one and has **Back up now**; `node server.js backup` does the same. To restore one:
  stop Beam, then `node server.js import <backup> --force` (what was in the data folder moves aside, nothing is
  deleted). Beam Family backs itself up the same way (see [docs/FAMILY.md](FAMILY.md)).
- **Each PC's Beam app** keeps a copy of its settings on your Beam, sent whenever they change: its name, where files
  are saved, hotkeys, Send to, the outbox, notification choices and which devices may control it. Never its sign-in or
  device key. After a reinstall or a reset, Beam offers once to put them back. Turning remote control back on still asks
  at the PC, with the same devices ticked. Settings → General → **Restore settings…** does it any time, also from
  another PC's backup.
- **The phone's Beam app** (1.8.2) keeps its settings there too: its name, what it receives and downloads, the Quick
  Settings tile's device, muted and auto-copy devices, and which apps' notifications go to your PCs. After a reinstall
  it offers once to put them back; sharing notifications with your PCs is switched on again on its own screen (Android
  asks for notification access again). Settings → **Restore settings** does it any time, also from another phone's
  backup.

## Docker and NAS

> Not tested yet: the files are written to work, but nobody has run them. Reports welcome.

`docker-compose.yml` runs Beam next to a Tailscale container:
- Beam gets its own Tailscale machine and HTTPS address, and is reachable only through Tailscale.
- It is meant for amd64 and ARM64 (Synology, QNAP, Unraid, TrueNAS, a Raspberry Pi, a VPS).
- The notes at the top of the file walk through the three steps: an auth key, a `.env` file, and
  `docker compose up -d`.

- **File ownership:** Beam runs as `PUID:PGID` (default 1000:1000) and needs to own `./data`. Typical values:
  - Synology: `id <you>` usually shows `1026` and group `100` (users).
  - Unraid: `99:100` (nobody:users).
  - TrueNAS SCALE apps: `568:568`.

  If Beam can't write there, it stops with a message saying so (`docker compose logs beam`).
- **Tailscale:**
  - Userspace networking is the default, so it needs no `/dev/net/tun` and no extra privileges (Synology lacks them
    out of the box).
  - Give the "beam" machine a tag (`TS_EXTRA_ARGS=--advertise-tags=tag:beam`) or disable its key expiry in the admin
    console, or it drops off the tailnet when its key expires.
  - If a stale "beam" machine exists, remove it first, or the new one is called beam-1.
- **App updates:** new builds go in `data/dist` (`Beam.exe` + `Beam.exe.json`, `beam.apk` + `beam.apk.json`; the names
  are case-sensitive). They reach every device within a minute.
- **Other reverse proxies:**
  - Beam needs a hostname of its own; it can't live under a sub-path like `/beam`.
  - If you put nginx or a NAS proxy in front of it, allow bodies of at least 9 MB (`client_max_body_size 9m;`) for
    the 8 MB upload chunks, or lower `BEAM_CHUNK_MB`.
  - Turn off response buffering for `/api/events` (Beam sends `X-Accel-Buffering: no`).
  - Add the proxy's address to `BEAM_TRUSTED_PROXIES`. Without it, every device looks like the proxy, so browsers
    aren't linked to apps and automatic sign-in only works through Tailscale.
- **Keep the data on a local disk** of the NAS rather than a network share: renames and change notifications are
  unreliable over SMB/NFS.

## Windows Server

On Windows Server, or any PC where nobody stays signed in:
- Install Node.js and Tailscale.
- In Tailscale, turn on **Run unattended** (tray menu → Preferences), or it disconnects when you sign out.
- Then run `windows\build.cmd` and `scripts\install-windows.ps1 -Server -AtBoot`. It starts Beam at boot, with no one
  signed in, as a scheduled task that restarts it if it stops, and starts it again within 5 minutes if something closes
  it (a Node.js update's installer does). (Without `-AtBoot`, Beam starts when you sign in.) Once Beam is back after
  being down, an alert says for how long and why (Settings → Alerts).
- Keep the data folder out of `Program Files`: set `BEAM_DATA=C:\ProgramData\Beam` (or another drive) in `.env`.
- Logs are in `data\logs\`.

## Configuration

Server settings go in environment variables or a `.env` file (see [.env.example](../.env.example)). Retention, item
limit, public address and Tailscale sign-in can also be changed from **Settings** on any signed-in device; an
environment variable wins and locks the setting.

| Variable | Default | |
|---|---|---|
| `BEAM_PORT` / `BEAM_HOST` | `8765` / `0.0.0.0` | Where the server listens (`127.0.0.1` = only through Tailscale) |
| `BEAM_DATA` | `./data` | Everything Beam keeps |
| `BEAM_DATA_ACL` | (on) | `keep`: don't make the data folder private at start |
| `BEAM_DIST` | `./dist` | App builds handed out for download and updates (Docker: `/data/dist`) |
| `BEAM_REQUIRE_DATA` | off | `1` = refuse to start without an existing key instead of creating a new, empty Beam (e.g. a disk not mounted yet) |
| `BEAM_PUBLIC_URL` | learned | Address used in pairing links, QR codes and ntfy. Learned from the first visit through Tailscale |
| `BEAM_MOVED_TO` | (none) | Send every device to this new address (normally set by `moved-to` / `import-from`) |
| `BEAM_RETENTION_DAYS` | `14` | Delete delivered items after N days (undelivered ones get up to 3×; pinned ones stay; `0` = never) |
| `BEAM_MAX_ITEMS` | `500` | Keep at most this many items |
| `BEAM_MAX_UPLOAD_MB` | `4096` | Largest file |
| `BEAM_MAX_STORAGE_GB` | `0` | Cap on everything stored (`0` = only the disk limits it) |
| `BEAM_BACKUP_DIR` | `backups` next to the data folder | Where the server's backups go (see [Backups](#backups)) |
| `BEAM_BACKUP_HOURS`, `BEAM_BACKUP_KEEP`, `BEAM_BACKUP_FILES_MB` | `24`, `14`, `1024` | A backup that often (`0` = none), the newest kept, files in each up to that size |
| `BEAM_WOL_TARGETS` | (all local networks) | Where Wake-on-LAN packets are sent, as `address[:port]`, comma-separated |
| `BEAM_TAILSCALE_OWNERS` | (learned) | Tailscale accounts whose devices sign in by themselves |
| `BEAM_TAILSCALE_SIGNIN` | on | `0` turns automatic Tailscale sign-in off |
| `BEAM_TAILSCALE_SOCKET` / `BEAM_TAILNET_PROXY` | (none) | tailscaled's LocalAPI socket / outbound proxy, for containers (see `docker-compose.yml`) |
| `BEAM_TRUSTED_PROXIES` | loopback | Reverse proxies whose `X-Forwarded-*` headers to believe (IPs/CIDRs) |
| `BEAM_CHUNK_MB` | `8` | Upload chunk size |
| `BEAM_NTFY`, `BEAM_NTFY_TOKEN`, `BEAM_NTFY_PREVIEW`, `BEAM_NTFY_SKIP` | (none) | Optional push notifications through [ntfy](https://ntfy.sh) |
| `BEAM_FAMILY_*` | | Beam Family's settings: see [docs/FAMILY.md](FAMILY.md) |
