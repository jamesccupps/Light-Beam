# Beam for Linux (a Raspberry Pi first)

A Raspberry Pi, or another Linux computer that stays on, as a device of its own. Put Tailscale on it, signed in to your
tailnet, then in its terminal (as yourself, not root):

```bash
curl -fsSL https://beam.your-tailnet.ts.net/install/linux | bash                       # install, or update
curl -fsSL https://beam.your-tailnet.ts.net/install/linux | bash -s -- --name "Garage Pi"   # with a name
curl -fsSL https://beam.your-tailnet.ts.net/install/linux | bash -s -- --uninstall         # take it away
```

It needs no root: Node.js 20 or later from the computer, else its own from nodejs.org (checked against its checksums),
the app and the `beam` command in your home folder, a systemd user service that starts with the computer. The first
install takes the app from your server as it is; its updates after that are checked against the key inside it. Then:
- files sent to it land in `~/Downloads/Beam`; text goes to its clipboard, with a notification, when it has a desktop;
- with a desktop, **Beam is in its menu** (Internet → Beam): Beam in a window of its own, to drop files on and paste text
  into (`beam window` from a terminal);
- its page in Beam shows its system, disk, uptime, processor temperature and, on a Pi, its power supply and throttling,
  with alerts; **Beam log** on that page shows the end of its log;
- **Control** it from your other devices: turn it on there, in Settings → Security of Beam's window on it, or with
  `beam control on` (only there; `beam control off` turns it off again). Its page then has **Control**: its screen in a
  window of Beam's, with its mouse and keyboard, through its desktop's own VNC server (wayvnc on Wayland, x11vnc on
  X11; `sudo apt install` it if it isn't there) relayed by your Beam (Sharp, or Fast across the internet);
- **Wake** works for the PCs on its network (1.3): a wake from any of your devices is sent from there too, so a Pi at
  the office wakes the office's PCs while your Beam runs somewhere else;
- it updates itself when a newer build lands in the server's `dist` (`node linux/build.mjs`, signed like the Windows
  app's updates).
