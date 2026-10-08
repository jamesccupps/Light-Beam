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
  fitted to the screen you view it on if you choose (put back after), and a Picture panel that applies at once: Auto, Sharp text,
  Smooth motion or Data saver, picture size, frame rate, data limit, codec and details; your pointer drawn on the
  viewing device at once, and the delay measured end to end, step by step (the Windows app 1.12.6).
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
- **Connections** (Beam 1.17): how the server reaches each device over Tailscale (direct, a peer relay or Tailscale's
  relay) with a test and its delay, alerts before a Tailscale sign-in runs out, and why a device is offline (the PC is
  on but Beam isn't running, or it's off or asleep).
- **Each PC's history and a speed test** (Beam 1.18, the Windows app 1.13): every restart and shutdown and who asked
  (a Windows update, your antivirus, you, a program), power losses, blue screens, when someone signed in after,
  Beam's own crashes and the times it was offline, on each PC's page, with an alert when a PC comes back from a power
  loss or a crash; and a speed test of Beam's own way in Connections, for this device or a PC asked from another.
- **Updates one PC at a time, a setup check, a PC's log** (Beam 1.20, the Windows app 1.14): a new Windows build goes to
  one PC first and to the others once it has run there for 10 minutes (one that fails there goes no further unless you
  say so); Beam checks its own setup every 6 hours and alerts when something is wrong; a PC's Beam log from any device.
- **Remote control starts faster** (the Windows app 1.15): over a second less for every remote control and shared
  mouse start (the PC's own pages no longer wait for Windows to look up their made-up names), the connection made
  while the capture starts, Auto at 60 fps, and each start shown step by step in the viewer's details.

## Next
- **Remote control, further:** less delay where the measurement shows it goes (the first measurements, a PC 25 ms
  away over the internet: 92–146 ms from a click to the picture, half of it in the PC's screen capture; 60 fps saved
  25 ms, and Windows' hardware H.264 path added 30; the Windows app 1.15 splits the capture step into Edge's own and
  the wait before the encoder): the capture step shortened, the viewer's wait to show a frame; then a Lowest delay
  mode, capture straight into the hardware encoder, decoding on the phone with WebCodecs, full-colour text, sound.
- **The shared mouse and keyboard, further:** dragging files between the PCs, and the phone as a trackpad and keyboard
  for a PC without the picture (next to screen sharing, not instead of it).
- **Testing beyond Windows:** the server on Linux and macOS, the Docker setup on a NAS.
- **Builds and releases** with GitHub Actions.
- **Beam Family:** voice and video calls; each person's own devices; the Beam apps signing in to a family server;
  several separate families on one server, each its own site, and guests who see only the channels they're given.
- **Servers that talk to each other** (with several families): other people's family servers and Beams, linked only
  when both owners allow it: a channel shared between two families, files sent to another person's devices like
  AirDrop, or one of your devices shared with someone (they can send files to it, or control it remotely, as you
  choose), each side keeping its own data. Over Tailscale (sharing just the server's machine) or the public link
  (servers signing their requests), big files going direct.

## Later
- **Everyday:** an optional automatic clipboard, photo backup, fetching a file from another device, folder sync, the
  phone as a remote, quick actions, reminders.
- **More platforms:** iPhone, Mac and Linux apps; the Android app on the Play Store as a client for anyone's own Beam.
- **Sharing:** a browser extension (links for people without an account: ✅ Beam Family's fast links, 1.9).
- **Security and server:** end-to-end encryption, a code-signed Windows app, a server dashboard.
- **Integrations:** Home Assistant, webhooks.
- **Off-grid:** devices on one network carrying on when the server is down, and maybe messaging over mesh radios
  (Meshtastic / Reticulum).
