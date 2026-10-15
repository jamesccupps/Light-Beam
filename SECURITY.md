# Security

## Reporting a problem

Please report security problems **privately**: use **Report a vulnerability** on this repository's Security tab
(GitHub's private vulnerability reporting), not a public issue. Say what you found, how to reproduce it, and which
version (the server's version is in Settings → Server, or `GET /api/hello`). Only the latest release gets fixes.

## What Beam is built to withstand

Beam is a server you run for **yourself**: one owner, their own devices. Beam Family adds a second, separate server
for the owner's family, which may face the internet.

- **Other people and devices on your networks.** Through Tailscale, only devices in your Tailscale account (or
  machines you explicitly share) reach Beam, encrypted. Set `BEAM_HOST=127.0.0.1` behind `tailscale serve` and
  nothing on your home network can reach it directly; on plain HTTP over a home network, traffic is not encrypted.
- **Other websites.** Changes are only accepted from Beam's own pages (`Sec-Fetch-Site` / `Origin` checks, JSON
  bodies), so a page on another site, or another site on your tailnet, can't act as you through your browser.
- **Lost or stolen devices.** Every device has its own sign-in, revocable from any other device; removing one also
  blocks its Tailscale machine from signing in again automatically, and wipes Beam's local data on it the next time
  it connects. "Sign out all other devices" also replaces the master key.
- **Guessing.** Passwords are limited per address and overall; pairing links work once within 15 minutes; sign-in
  approvals show a code to compare.
- **Files.** Received files are never opened or run automatically. Files are served with `nosniff` and a sandboxing
  content policy, and only pictures, video and sound are shown inline, so an uploaded page can't run as Beam.
- **A server move.** Devices follow Beam to a new address only when the new server proves it holds this Beam's key.
  Asking for a move (a full copy of Beam) pops up on no device: it's approved only by typing the code the new server
  shows.
- **Updates.** The apps install only what your own server offers, and only when it's signed with the key they were
  built with: Windows checks the build's signature (`windows/update-key.mjs`, since 1.7.3), Android that the update is
  signed with the same key as the installed app. A changed `dist` folder or a server that isn't yours can't push
  its own build.

## What Beam trusts

- **The server's computer.** `tailscale serve` hands requests to Beam on this machine, and Beam believes Tailscale's
  identity headers only from there; any program or account on that computer could pose as Tailscale traffic. Run the
  server on a computer only you use. The data folder is made private to the account Beam runs as.
- **Your Tailscale account.** Devices signed in to it sign in to Beam by themselves (this can be turned off). Whoever
  controls your Tailscale account controls that. Since 1.25 such an automatic sign-in only sends and receives: remote
  control, installing apps, the phone's notifications, the password, moves, signing the others out and (1.25.4) the
  owner's tools (the server's log, each PC's log and history, backups, a Windows update to every PC at once) take a
  *trusted* sign-in (the password, a pairing link or approval from a trusted device, or approved on one), because
  Tailscale vouches for a machine, not for the program or account on it.
- **The `data` folder and the signing keys.** `data` holds the key, sign-ins and every stored item, unencrypted. The
  apps update from `dist` but install only builds signed with your keys (the Windows update key, the Android keystore):
  whoever has those keys can change every app. A first install (the Windows app, the Android app, Beam for Linux) is
  taken as the server hands it out: only the updates after it are checked against the key it came with.
- **The server itself.** Messages and files are not end-to-end encrypted: the server stores and relays them.
- **Apps on every PC** (off until allowed at each PC): installers are checked against the SHA-256 and size in your
  server's own list, which a trusted sign-in can add to (1.25). That makes sure a PC installs what the list says,
  not that the list is trustworthy: whoever controls your server's list can install programs on every PC that allows
  it. Unlike the Beam apps' own updates, the list isn't signed with a key the server never holds.

## Trade-offs, on purpose

- **One global cap on password guesses** (30 per 10 minutes, after a per-address one): it stops guessing spread over
  many addresses, and anyone who can reach the sign-in page can use it up for a while. Approvals, pairing links and
  Tailscale sign-in still work meanwhile.
- **Beam and Beam Family on one machine share its name:** browsers send a site's cookies to every port, so each
  server receives the other's (and ignores it). For full separation, give Family a Tailscale machine of its own.
- **Plain HTTP:** by default Beam also listens for plain HTTP on every network, for devices that use a local address.
  The activity log says how each device connects; once all of them use the https address, set `BEAM_HOST=127.0.0.1`.
- **ntfy:** with the public ntfy.sh, the topic name is the only secret unless `BEAM_NTFY_TOKEN` is set: use a long
  random topic, a token, or your own ntfy server.
- **Docker:** the compose file mounts tailscaled's socket into Beam's container (needed to ask who is visiting), and
  pins images by tag, not digest. It is the least tested way to run Beam.

## Beam Family

Beam Family is the only part meant to be reachable from the internet (through Tailscale Funnel). It's a separate
process with its own data, listening on 127.0.0.1 only, and it can't do anything to your devices. People reach it
with invite links and passwords (scrypt, rate-limited sign-ins, sessions in HttpOnly cookies); identity headers from
Tailscale count only from the local machine, and Funnel never sends them. Since 1.25.2, someone signed in by Tailscale
identity also gives their password for the changes that let someone in (invites, password-reset links, roles, turning
people off), since Tailscale vouches for a machine, not for the program on it; an owner's first password comes with a
link made on the server's PC. Details: [docs/FAMILY.md](docs/FAMILY.md#security-model).
