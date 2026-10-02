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
- **Updates.** The apps install only what your own server offers, checked against the SHA-256 it announces, and
  Android also checks that the update is signed with the same key as the installed app.

## What Beam trusts

- **The server's computer.** `tailscale serve` hands requests to Beam on this machine, and Beam believes Tailscale's
  identity headers only from there; any program or account on that computer could pose as Tailscale traffic. Run the
  server on a computer only you use. The data folder is made private to the account Beam runs as.
- **Your Tailscale account.** Devices signed in to it sign in to Beam by themselves (this can be turned off). Whoever
  controls your Tailscale account controls that.
- **The `data` and `dist` folders.** `data` holds the key, sign-ins and every stored item, unencrypted. `dist` is what
  every app updates itself from. Whoever can write there can change every app.
- **The server itself.** Messages and files are not end-to-end encrypted: the server stores and relays them.

## Beam Family

Beam Family is the only part meant to be reachable from the internet (through Tailscale Funnel). It's a separate
process with its own data, listening on 127.0.0.1 only, and it can't do anything to your devices. People reach it
with invite links and passwords (scrypt, rate-limited sign-ins, sessions in HttpOnly cookies); identity headers from
Tailscale count only from the local machine, and Funnel never sends them. Details: [docs/FAMILY.md](docs/FAMILY.md#security-model).
