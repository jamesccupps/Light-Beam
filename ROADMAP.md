# Roadmap

Where Beam is heading, roughly in order. Nothing here is promised; ideas and help are welcome (open an issue).

## Done so far
- A private messenger between your own devices: text, clipboard, files of any size, resumable, with delivery ticks.
- Sign-in by Tailscale identity, approvals with a code, passwords, pairing links; per-device sign-ins.
- Offline mode: readable history, an outbox, drafts.
- Device status (battery, storage, version), ringing a lost device, Wake-on-LAN, alerts.
- A speed and battery audit, with speed budgets the tests enforce.
- Phone notifications on your PCs, with replies and actions.
- Remote control of a Windows PC's screen from another PC, a browser or a phone; the PC's resolution and scaling
  fitted to the screen you view it on (put back after), and a Picture panel that applies at once: Auto, Sharp text,
  Smooth motion or Data saver, picture size, frame rate, data limit, codec and details.
- **Beam Family**: the family's own chat, reachable over Tailscale or a public link.
- Two security audits worked through, including signed Windows updates (the apps install only builds signed with
  your own key).
- **Backups:** the server and Beam Family back themselves up every day (a restore puts one back), and each PC's and
  phone's Beam app keeps its settings on your Beam, offered back after a reinstall.
- **Several at once** (Beam 1.12, the Android app 1.9, Beam Family 1.11): select several messages, photos or files to
  copy, share, save, forward or delete them together (the Windows app copies them as files and drags them out
  together; Android shares them into any app in one go), and a gallery of each conversation's photos, videos and files.
- **A shared mouse and keyboard** (Beam 1.16, the Windows app 1.12): one PC's own keyboard and mouse work the PCs beside
  it, on any side (arranged by dragging, 1.12.5); the pointer crosses over the edge of its screens, with the keyboard and
  what was copied (text or a picture), and comes back the same way (or by itself if a PC stops answering).

## Next
- **Beam Family:** voice and video calls; each person's own devices; the Beam apps signing in to a family server;
  several separate families on one server, each its own site, and guests who see only the channels they're given.
- **Servers that talk to each other** (with several families): other people's family servers and Beams, linked only
  when both owners allow it: a channel shared between two families, files sent to another person's devices like
  AirDrop, or one of your devices shared with someone (they can send files to it, or control it remotely, as you
  choose), each side keeping its own data. Over Tailscale (sharing just the server's machine) or the public link
  (servers signing their requests), big files going direct.
- **Remote control, further:** a Lowest delay mode (measured end to end), capture straight into the hardware encoder,
  decoding on the phone with WebCodecs, the cursor drawn on the viewing device, full-colour text, sound.
- **The shared mouse and keyboard, further:** dragging files between the PCs, and the phone as a trackpad and keyboard
  for a PC without the picture (next to screen sharing, not instead of it).
- **Testing beyond Windows:** the server on Linux and macOS, the Docker setup on a NAS.
- **Builds and releases** with GitHub Actions.

## Later
- **Everyday:** an optional automatic clipboard, photo backup, fetching a file from another device, folder sync, the
  phone as a remote, quick actions, reminders.
- **More platforms:** iPhone, Mac and Linux apps; the Android app on the Play Store as a client for anyone's own Beam.
- **Sharing:** a browser extension (links for people without an account: ✅ Beam Family's fast links, 1.9).
- **Security and server:** end-to-end encryption, a code-signed Windows app, a server dashboard.
- **Integrations:** Home Assistant, webhooks.
- **Off-grid:** devices on one network carrying on when the server is down, and maybe messaging over mesh radios
  (Meshtastic / Reticulum).
