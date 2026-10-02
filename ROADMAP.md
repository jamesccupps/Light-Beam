# Roadmap

Where Beam is heading, roughly in order. Nothing here is promised; ideas and help are welcome (open an issue).

## Done so far
- A private messenger between your own devices: text, clipboard, files of any size, resumable, with delivery ticks.
- Sign-in by Tailscale identity, approvals with a code, passwords, pairing links; per-device sign-ins.
- Offline mode: readable history, an outbox, drafts.
- Device status (battery, storage, version), ringing a lost device, Wake-on-LAN, alerts.
- A speed and battery audit, with speed budgets the tests enforce.
- Phone notifications on your PCs, with replies and actions.
- Remote control of a Windows PC's screen from another PC, a browser or a phone.
- **Beam Family**: the family's own chat, reachable over Tailscale or a public link.

## Next
- **Several at once:** select several messages or pictures to copy, drag into another program, save or forward them
  together, and a gallery of everything a device sent.
- **Beam Family:** voice and video calls; each person's own devices; the Beam apps signing in to a family server.
- **A shared mouse and keyboard** between computers (KVM).
- **Testing beyond Windows:** the server on Linux and macOS, the Docker setup on a NAS.
- **Builds and releases** with GitHub Actions.

## Later
- **Everyday:** an optional automatic clipboard, photo backup, fetching a file from another device, folder sync, the
  phone as a remote, quick actions, reminders.
- **More platforms:** iPhone, Mac and Linux apps; the Android app on the Play Store as a client for anyone's own Beam.
- **Sharing:** share links for people without Beam; a browser extension.
- **Security and server:** end-to-end encryption, a code-signed Windows app, a server dashboard, automatic backups.
- **Integrations:** Home Assistant, webhooks.
- **Off-grid:** devices on one network carrying on when the server is down, and maybe messaging over mesh radios
  (Meshtastic / Reticulum).
