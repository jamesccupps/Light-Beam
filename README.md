# Light Beam

**Beam** is a private messenger and hub for your own devices, running on your own computer. Send text, links,
photos and files of any size from any device to any other, or to all of them at once. See your phone's
notifications on your PCs and reply to them, ring a lost phone, wake a sleeping PC, or control a PC's screen from
another device. **Beam Family** adds your family's own chat, in the spirit of Discord, on the same machine.

There are no accounts and no third-party cloud. Your devices reach your Beam privately through
[Tailscale](https://tailscale.com), at home or away, without opening any ports.

| Device | How it runs Beam |
|---|---|
| **Anything with a browser** (iPhone, Android, Mac, Linux, Chromebook, Windows) | The web app, which installs to the home screen like an app |
| **Windows** | Optional tray app `Beam.exe`: one self-updating file; its chat window is the same web app (WebView2) |
| **Android** | Optional native app `beam.apk` (share sheet, phone notifications on your PCs, ringing, remote control) |
| **Scripts / terminal** | The `beam` command-line tool, or plain HTTP ([docs/API.md](docs/API.md)) |

The browser is all you need to start: the native apps add system integration, and you build them yourself (see
[Building the apps](#building-the-apps)).

> **Status:** a personal project, now open source. It is developed and used every day on Windows 11 PCs and an
> Android phone. The server is plain Node.js; Linux and macOS should work but haven't been tested yet, and neither
> have the Docker files. Reports and fixes are welcome (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## Quick start (browser only)

You need a computer that stays on, with:
- [Node.js](https://nodejs.org) **22.13 or later** (Beam itself runs on 20.12+; Beam Family needs 22.13+ for its
  built-in SQLite);
- [Tailscale](https://tailscale.com/download), installed and signed in (the free plan is plenty).

```bash
git clone https://github.com/jamesccupps/Light-Beam.git
cd Light-Beam
npm install
node server.js
```

In a second terminal, share it over Tailscale (HTTPS, reachable only by your own devices):

```bash
tailscale serve --bg http://127.0.0.1:8765
```

Then, on any device signed in to the same Tailscale account, open `https://<your-computer>.<your-tailnet>.ts.net`
(`tailscale serve status` shows the exact address). The first Tailscale account to sign in becomes Beam's owner,
and your devices sign in by themselves from then on. Install it as an app: Chrome menu → **Install app**, or on an
iPhone Safari's **Share → Add to Home Screen**.

Without Tailscale, `node server.js pair` prints a one-time link and QR code for a device on your home network
(plain HTTP: see [Security](#security)).

To keep it running in the background:
- **Windows:** `windows\build.cmd`, then `powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
  -Server`. That runs the server hidden (restarting it if it crashes, and again at every sign-in), shares it over
  Tailscale, and installs the Windows app, already paired. Run it again any time; `-Uninstall` removes everything
  except your items.
- **Linux:** a systemd unit is in [deploy/beam.service](deploy/beam.service) (not tested yet).
- **A NAS or a server:** see [Docker and NAS](#docker-and-nas).

## Adding your other devices

Every device needs the **Tailscale app**, signed in to the same account. Then:

- **Any browser:** open `https://<your-computer>.<your-tailnet>.ts.net`.
- **Android:** once you've built the app, get `beam.apk` from **Add device → Get the app** on a signed-in device
  and install it. Chrome will ask you to allow installing apps from it.
- **Windows:** download `Beam.exe` the same way and run it from anywhere. It finds your Beam over Tailscale by
  itself, and can start with Windows (its Settings).

### Signing in

1. **Automatically.** Your own devices sign in by themselves:
   - Any device signed in to your Tailscale account (Tailscale tells Beam who is visiting, when it goes through the
     Beam address). Beam trusts your account from your first sign-in. Another account (a relative's laptop you
     signed in on with the password, say) isn't trusted just because Beam saw it: it shows under **Settings →
     Security** with an **Allow** button, and trusted accounts can be removed there.
   - A browser on a device that's already running the Beam app.
2. **With your phone.** A new browser or app shows a QR code and a short code. Scan it with a signed-in phone (camera
   or the Beam app) and tap **Approve**. Signed-in devices also pop up an Approve / Deny prompt by themselves. You can
   also type the code under **Add device → Approve a sign-in**, or `beam approve <code>`. Always check that the code
   matches before approving.
3. **Password.** Set one in **Settings → Sign-in password**, then type it on any sign-in screen. On a computer that
   isn't yours, sign in **for this session only**: it ends when the browser closes, or after 12 hours unused.
4. **Pairing link.** Shown under **Add device** (or `node server.js pair`). It works once, within 15 minutes.

Every device gets its own sign-in:
- Removing a device (or **Sign out all other devices** in Settings) signs it out for good, and stops it from signing
  back in automatically through Tailscale.
- A lost device that is still in your Tailscale account can't get back in by itself, but for full safety also remove
  it from Tailscale.

Browsers and apps on the same device are linked automatically. The server recognises the machine by its Tailscale
address, so the browser becomes part of that device instead of a separate entry.

## Using Beam

**Everywhere** (the browser, and the Windows app, which shows the same chat)

- **Conversations:** the list on the left has **All devices** plus each device, with online dots, previews and
  unread counts. Reading something on one device clears it on your others too.
- **Sending:**
  - Type and send, or paste with **Ctrl+V**.
  - Drop files and folders anywhere: onto a conversation, or straight onto a device in the list. Folders go as a
    .zip.
- **Messages:**
  - **Select and copy any part of any message.**
  - Right-click, long-press or use the ⋯ button for Copy, Copy link, Select text, Forward, Pin, Save / Open / Show
    in folder, a QR code of a link, and Delete (with Undo).
- **Finding things:** **Ctrl+F** or the search button searches everything, even offline. **Ctrl+K** jumps to a
  conversation, and **Ctrl+/** lists every shortcut.
- **Photos and files:**
  - Photos show as thumbnails; click one for a full-screen viewer with zoom and swipe.
  - Text files can be previewed.
  - **A gallery for each conversation** (Beam 1.12): the picture button in the header shows its photos and videos as
    a grid, newest first, and its other files as a list. Click one to view, play or save it.
- **Several at once** (Beam 1.12):
  - **Select** in a message's menu (or **Ctrl+click**, and **Shift+click** for a range) picks several messages,
    photos or files, in the chat or in the gallery.
  - Then **Copy**, **Save** (Download in a browser), **Forward** or **Delete** them together. **Ctrl+A** picks them
    all and **Esc** stops.
  - In the Windows app, Copy puts the files on the clipboard as files, so you can paste them into any program, and
    dragging one of them out drags them all.
- **Reply, react, edit** (Beam 1.14):
  - **Reply** in a message's menu quotes it above your answer; click the quote to go to the message it answers.
  - A row of quick reactions sits on top of a message's menu (👍 ❤️ 😂 😮 😢 🙏). Reactions show under the message
    with how many; each device has its own, and a click takes yours back.
  - **Edit** changes a text's words; it then says "edited". Other devices see replies, reactions and edits at once.
- **Pin** keeps an item past the clean-up. **Forward** sends an item to another device without uploading it again.
- **Delivery:**
  - Every item shows **Sent**, then **Delivered**.
  - Big files upload in resumable chunks, pausing and carrying on through dropped connections, sleep and restarts.
  - Receivers see incoming files arriving, and can save them while they're still coming in.
- **Offline:** your history stays readable. Anything you send waits in an outbox and goes out by itself when you're
  back online. Each conversation keeps its own draft.
- **Settings:**
  - This device.
  - All your devices, where you can sign one out.
  - Security: password, Tailscale sign-in, blocked machines, and "sign out all other devices".
  - The server: address, version, storage, how long items are kept, the server log, and moving Beam.

**Your devices**

- **At a glance:** each conversation's header shows that device's battery, free storage, Beam version and system.
  **Device info** in the conversation menu and **Settings → Devices** show the rest.
- **Ring a device** to find it. Your phone rings loudly for up to a minute, even on silent, until you tap Stop. A PC
  plays an alarm and shows a Stop window. Needs the Beam app on that device.
- **Wake a sleeping PC** (Wake-on-LAN). The button appears when a PC is offline. It only works if:
  - the Beam server is on the same home network as that PC;
  - Wake-on-LAN is switched on for the PC's network adapter (and in its BIOS/UEFI; wired Ethernet is the most
    reliable).
- **Remote Desktop** into another of your Windows PCs that allows it (Windows Pro, with Remote Desktop turned on in
  Settings → System → Remote Desktop):
  - From the Windows app it opens directly.
  - From a browser it downloads a small `.rdp` file that opens Remote Desktop.
  - On the phone it needs Microsoft's Remote Desktop app ("Windows App").
  - Sign in with that PC's Windows account: its email address (or user name) and password. A PIN or Windows Hello
    doesn't work over Remote Desktop (choosing it ends in "A certification authority could not be contacted"):
    pick **More choices → Use a different account**.
- **Alerts** (Settings → Alerts): a device's battery is low, its storage is nearly full, or the Beam server's disk is
  nearly full. For the devices you pick in Settings → Devices, also when one goes offline and comes back.

**Speed and battery**

- **Quiet in the background:** while Beam isn't on screen, your phone and PCs get what matters at once: messages for
  them, the start of an incoming file, rings, alerts and sign-in requests. Everything else (who's online, delivery
  ticks, battery levels) waits for one small check-in every 3 minutes. On a phone that's about 20 wake-ups an hour
  instead of about 170. Opening Beam catches up instantly.
- **Opens at once:** your saved history shows straight away, and after a reconnect only what changed is fetched. The
  web app and the Windows chat window are cached, so reopening takes one small request.
- **Sending:** a message appears the moment you send it, with a small clock until the server has it.
- **Big files:**
  - Uploads go in bigger pieces, so connections to another site stay busy, and they survive a power cut on the
    server.
  - The Windows app saves big incoming files (32 MB or more) while they're still arriving, so they're ready the moment
    the sender finishes. On the phone tap the "Arriving…" file; in the browser use **Save** on it.
- **Long conversations** open with the newest 60 messages; older ones load as you scroll up.

**Phone notifications on your PCs** (Android app)

- **What it does:** notifications from the phone apps you pick show up on your PCs. You can reply to them (texts,
  WhatsApp, Signal… anything with a reply box), press their buttons, or dismiss them; dismissing clears them on the
  phone too.
- **On the phone:** Settings → **Notifications on your PCs**.
  - Switch it on and allow Android's "notification access" once.
  - Pick the apps to share. None are shared until you pick them, and apps that notify you most are listed first.
  - Choose which PCs show them under **Show on**.
  - The Quick Settings tile **PC notifications** switches sharing on and off with one tap.
  - Replies need **Stay connected** on.
- **On each PC:** the tray menu's **Show phone notifications** checkbox, also in Settings → This PC.
  - A pop-up appears for each new notification, grouped per app ("3 new from WhatsApp").
  - Clicking one opens the **Phone** panel in the chat window, ready to reply.
  - **Show message text in pop-ups** (Settings → This PC) can be turned off: pop-ups then just say "WhatsApp · new
    notification", and the text stays inside Beam.
- **In a browser:** Settings → This device (off by default). The Phone entry sits under All devices.
- **Privacy:**
  - Beam never saves notification text on the server, the PCs or the phone. It's kept in memory only, and only sent
    to the PCs you chose.
  - Windows itself keeps the pop-ups you were shown in its Notification Center until you clear them.
  - Android 15 and later hide one-time codes from apps like Beam.
  - Work-profile apps are never shared.
  - Buttons that would open an app on the phone can't be pressed from a PC; Beam says "Open it on the phone".

**Remote control** (a Windows PC's screen, from another PC, a browser or the phone)

- **See and control a PC's own screen** from another PC (**Control** opens a viewer window), a browser, or the phone.
  Nobody is signed out, and it works on Windows Home too. The video goes directly between your devices over
  Tailscale.
- **On a phone or tablet** (modelled on Chrome Remote Desktop and Microsoft's Remote Desktop app), choose
  **Trackpad** or **Touch** on the bar; the first time, Beam shows how each works (later: **⋯ → How to control**).
  - Both: tap = click; touch and hold until the ring fills, then let go = right-click, or move = drag/select;
    two-finger tap = right-click; three-finger tap = middle-click; pinch = zoom the picture (only on the phone);
    swipe up with three fingers = keyboard.
  - **Trackpad:** one finger moves the pointer like a laptop's touchpad (slow is precise, a flick goes far), two
    fingers scroll; zoomed in, the picture follows the pointer.
  - **Touch:** tap right on things (tap twice to double-click), one finger scrolls, two fingers move and zoom the
    picture.
  - Scrolling carries on after a flick. The zoom stays when the keyboard opens or the phone turns. The key strip
    (Esc, Tab, Ctrl, Alt, Shift, Win, arrows, Del) shows upright, and sideways while the keyboard is up. Back asks
    before it disconnects.
- **Off on every PC until you switch it on at that PC:** tray menu → **Allow remote control**. You tick which of your
  devices may control it. Only tick devices you trust: Beam in another Windows account on the same PC counts as a
  different device. A device added to Beam later needs ticking on that PC (tray → **Remote control devices…**).
- **While someone is connected** the PC shows a red bar, "*device* (*machine* · *address*) is controlling this PC ·
  **Stop**". After 5 seconds it shrinks to a small "Beam · Stop" pill that grows back when the mouse rests on it. Drag it
  anywhere on the screen (it starts there next time); double-click it to put it back at the top.
- **Signed in through Remote Desktop?** Beam can't control a Remote Desktop session (it isn't on the PC's own
  screen, so the PC shows as locked). Right-click Beam's tray icon there → **Back to this PC's screen**: Windows asks
  for administrator rights, Remote Desktop closes, and Beam's Control works. The PC's own monitor then shows your
  desktop, unlocked.
  **Ctrl+Alt+Shift+F12** on the PC ends every session at once. You can also end a session, or turn remote control off
  for a PC, from any of your devices (Settings → Devices). Nothing but the PC itself can turn it on.
- **In the viewer:** the Picture panel (fit the PC to this screen: its resolution and display scaling change to suit
  the screen you view it on and go back when you disconnect, on by default except on phones; Auto, Sharp text, Smooth
  motion or Data saver; picture size, frame rate, data limit, codec and details, kept per PC), choose a screen, full
  screen, a Keys menu (Win, Alt+Tab, Lock this PC…), and clipboard sync (text and pictures, such as a screenshot),
  which is off until you turn it on for that session. A phone asks "Still there?" after 10 minutes without a touch.
- **Lag** (Windows app 1.11): the PC asks every viewer, the phone included, to show each frame the moment it arrives.
  The chip over the picture shows the lag (from your touch to the PC's answer on your screen, measured), and
  "relayed" while Tailscale relays the connection through its servers, which is slower; Show details has the
  breakdown and Tailscale's path (direct on the same network, direct over the internet, or which relay).
- **The pointer drawn here** (Windows app 1.12.6): with a mouse, your pointer moves at once in the PC's shape (arrow,
  text, hand, resize arrows…), the way Parsec does it; the PC hides its own while you control it (its screen capture
  would otherwise draw it into the picture a moment behind), and shows it again when you're done or when its own mouse
  moves. Picture → **Draw the pointer here** turns it off, for when someone watches the PC's own screen. A phone keeps
  its own pointer.
- **Measure the delay** (Picture, Windows app 1.12.6): ten probes go to the PC the way your clicks do; it turns a small
  square in the top left corner of its screen from magenta to green and back, and the viewer times when each change
  reaches your screen. The details then show the whole (from a click to the picture) and each step: to the PC, on its
  screen, the capture, encoding, sending, back, decoding and the wait to be shown.
- **Limits:** a locked or signed-out PC, administrator windows and Ctrl+Alt+Del need Remote Desktop (the existing
  button). Only Beam apps, or a browser where you signed in with a pairing link, approval or password, can start a
  session.
- **Dragging a file out of Beam's chat** on a PC that is being controlled copies it instead (paste it with
  Ctrl+V): a drag there would freeze the session.

**Keyboard and mouse across PCs** (Beam 1.16, Windows app 1.12: one PC's own keyboard and mouse on the PCs beside it)

- On the PC whose keyboard and mouse you use: tray → **Keyboard and mouse across PCs → Arrange the PCs…**: up to three
  of your PCs on a grid around this one, on any side, as they stand on your desk (**+** puts one there, drag one to
  move it, click one to remove it; Windows app 1.12.5), and **On**. Each of those PCs needs "Allow remote control" on
  with this PC ticked (that's only ever set at that PC).
- Move the pointer off an edge of this PC's screens toward a PC and it carries on onto that PC's main screen at the
  same place along the facing edge, across its screens as Windows arranges them there (a TV above a monitor is reached
  from that PC's monitor), and on to the PC beyond. Keys, clicks, the wheel and copied text or pictures go along;
  what's copied there comes back.
- **Back:** move the pointer back over the edge (worked out on this PC, so it works even if the other PC stops
  answering), or that PC's tray → **Back to *this PC***. It also comes back by itself when a PC stops answering for a
  second and a half, or this PC locks. Ctrl+Alt+Del always stays on this PC.
- Each PC shows a banner, "*this PC*'s keyboard and mouse · Hide · Stop": **Hide** folds it into that PC's tray, which
  then shows it (Show the banner, Back, Stop), and it stays folded next time. Stop there ends it until you turn it off
  and on here.
- Nothing is seen or recorded: it's a remote control session with no picture, directly between the PCs over
  Tailscale. **Limits:** not onto a locked PC; no dragging files between PCs yet.

**Windows app** (`Beam.exe`, one self-updating file)

- It lives in the system tray; click the icon to show or hide the chat window. Run a downloaded `Beam.exe` once and it
  installs itself, with a Start menu entry, and starts with Windows.
- **Beam Family** (Windows app 1.10, with `BEAM_FAMILY_URL` set): the chat's ♥, the tray's **Beam Family** or
  `Beam.exe --family` open it in a window of its own, signed in by Tailscale and kept apart from Beam's own sign-in.
- **Hotkeys:**
  - **Ctrl+Alt+B** opens "Send clipboard to…", which remembers your last device.
  - **Ctrl+Alt+Shift+B** sends the clipboard straight to that device.
  - **Ctrl+Alt+Shift+S** snips part of the screen and sends it.
  - **Ctrl+Alt+G** copies the latest text you received.
- **Sending files:** right-click files or folders in Explorer → **Send to → Beam → *device***, or drop them in the
  `Beam\To <device>` folders you set up under Settings → This PC.
- **Receiving:**
  - Text goes onto the clipboard; you can keep it out of clipboard history.
  - Files are saved to `Downloads\Beam` and marked as downloaded from the internet. Big ones start saving while
    they're still arriving.
  - Clicking a notification opens a link or copies text. A picture or a video opens in its conversation; another file
    shows in its folder. A notification for several things at once opens their conversation at the newest.
  - Programs are only ever shown in Explorer, never run.
- **Links open themselves** (optional, Settings → This PC → "Open links sent to this PC automatically"): a link you
  send to this PC by itself opens in the browser right away.
- **Updates** install themselves from your server. If a new version fails to start, Beam goes back to the previous one
  on its own.

**Android app**

- **Sharing:** from any app, your devices appear right in the share sheet for one-tap sending, or pick Beam and then a
  device.
- **Messages:**
  - Long-press a message for Copy, Select text, Open link, Share, Select, Forward, Save/Open, Pin and Delete.
  - Tap a file to open it. Tap an "Arriving…" file to save it while it's still being sent.
- **Several at once and a gallery** (Android app 1.9):
  - **Select** in a message's menu, then tap more messages. The toolbar shows how many, with **Share** (all the files
    in one share, into any app), **Save**, **Forward**, **Delete** and **Copy** (their text). Back stops.
  - Files that aren't on the phone yet are downloaded first. In split screen, dragging a picked file drags them all.
  - The picture button in a conversation shows its **photos and videos** as a grid and its **files** as a list;
    long-press one to pick several there.
- **Reply, react, edit** (Android app 1.11): the same from a message's sheet (Reply, the quick reactions on top, Edit);
  the bar above the message box says what you're replying to or editing, with × to stop.
- **Notifications:** they have **Copy**, **Open link** and quick **Reply**, and files open straight from the
  notification.
- **Shortcuts and tools:**
  - A **Quick Settings tile**, "Send clipboard", with a default device.
  - A **home-screen widget** (Android app 1.12): the last thing you received (tap to open it, **Copy** for a text),
    with **Send clipboard** and **Send a photo**.
  - Launcher shortcuts.
  - Camera and photo picker in the composer.
  - Search.
- **Offline:** history, outbox and drafts work offline, and transfers survive network switches and restarts.
- **Settings:** per-device mute and auto-copy, Wi-Fi-only downloads, server info, and battery exemption.
- **Updates:** it updates itself from your server without asking, where Android allows.

**Web app**

- On Android, installing it (Chrome ⋮ → *Install app*) also adds it to the Share menu.
- On a borrowed computer, tick "shared or borrowed computer" when signing in. You're signed out when the browser
  closes.

## Beam Family: the family's chat

Beam Family is your family's own chat, in the spirit of Discord: a family space with channels (#general, #photos…),
direct and group conversations, photos, videos and files, replies, reactions, @mentions, notifications, search,
and history that's kept. It's a separate server next to Beam (Beam's device features don't change), so it can be
opened from the internet without that ever reaching the server that controls your PCs.

```bash
node family/server.js --supervise
tailscale serve --bg --https=8443 http://127.0.0.1:8766     # your tailnet, and people you share the machine with
tailscale funnel --bg --https=8443 http://127.0.0.1:8766    # optional: a public link (invite + password)
```

- Open `https://<your computer>.<your tailnet>.ts.net:8443` from your own device over Tailscale: you're set up as the
  owner. Invite the family from **People & channels** (a link, or a QR code to scan).
- On Tailscale (your tailnet, or the machine shared with them) people are signed in by Tailscale. Through the public
  link they choose a name and a password; they don't need Tailscale.
- It works in any browser and installs as an app on phones and computers (on an iPhone: Share → Add to Home Screen,
  which notifications need there). Set `BEAM_FAMILY_URL` in `.env` and Beam's own apps open it: the Windows app in a
  window of its own (the ♥, the tray's **Beam Family**), the Android app in a Chrome tab inside it (the menu's **Beam
  Family**), the web app in a new tab. Notifications come through the browser and the phone.
- **Fast links** (1.9): "Fast link" on any file in the chat, or "Make a fast link" (the paperclip) for a file on your
  phone, gives a link anyone can download it with, no account needed, until it runs out (an hour, a day, a week) or
  you switch it off. Its page fetches the file straight from your computer when it can (a direct WebRTC connection:
  on your own Wi-Fi it stays inside the house; elsewhere it skips the public link's relay), else over https. Big
  uploads from the app go the same direct way. On Windows, devices on your own network need one firewall rule to
  connect directly (see [docs/FAMILY.md](docs/FAMILY.md)).
- **Fast links from Beam's own chat too** (1.13): "Fast link…" on a file there (browsers, the Windows app, the Android
  app) makes the same kind of link through Beam Family on the same machine, from the file itself (no copy on the same
  drive); its page says it's from Family's owner.
- **Fast links that stop, or leave the location behind** (1.15): when you make one you can have it stop after one, 3
  or 10 downloads (a download that's picked up again isn't a new one), and share a photo or video without where it was
  taken: Beam Family makes a copy without the location and the camera's other notes (JPEG and PNG photos, and videos
  when ffmpeg is set up), and the link only ever sends that copy (over https: never the original).
- **Fast downloads, a gallery, several at once** (1.11): big files download from the chat over the same direct
  connection as fast links, with progress and Stop; each conversation has a gallery of its photos, videos and files;
  pick several messages or pictures to copy, download or delete them together.
- **Videos that play everywhere** (1.10): a phone's HDR video can refuse to play on another phone (an iPhone, say). Like
  Google Photos, Beam Family keeps the original and makes a copy every phone and browser plays (H.264, standard
  color), with ffmpeg on your computer (the graphics card's encoder when it has one). The chat plays that copy, and so
  does a fast link's page, which also offers it as "Download for any phone". Set `BEAM_FAMILY_FFMPEG` to where
  ffmpeg is (see [docs/FAMILY.md](docs/FAMILY.md)); without it, videos play as they are.

Details, settings and the security model: [docs/FAMILY.md](docs/FAMILY.md).

## Command line

`node cli/beam.js …`, or run `npm link` once to get a `beam` command. Sign it in once:

```bash
beam login                             # finds Beam on your tailnet; signs in through Tailscale,
                                       # or shows a code to approve on a signed-in device
beam login https://beam.your-tailnet.ts.net --password   # or with the sign-in password
beam setup "https://…/?key=…" --name "Laptop"             # or with a pairing link
```

Then:

```bash
beam devices                           # list devices (● = online)
beam report.pdf --to "Pixel"           # send files to one device (names or ids, comma-separated)
beam -t "hello" --to Laptop,Desktop    # send text
git diff | beam --to Desktop           # send piped text
beam clip --to Laptop                  # send what's on the clipboard
beam get                               # latest text sent to this computer → clipboard (--no-copy: just print it)
beam pull                              # latest file sent to this computer → Downloads/Beam
beam ls                                # recent items to and from this computer, with their ids
beam rm 3fa9c1                         # delete an item (the start of its id is enough)
beam approve K7QM-4R2X                 # let a new device in
beam status                            # server, sign-in and storage details
beam listen                            # stay connected: text → clipboard, files → Downloads/Beam
                                       # (catches up on what arrived while it wasn't running)
```

Leave out `--to` to send to all devices. When Beam moves, the `beam` command follows it by itself, once the new
server has proved it holds your key.

## iPhone Shortcuts

Until there's an iPhone app, Shortcuts can send to Beam from the share sheet. Replace `BEAM` with
your Beam address and `KEY` with the key from the pairing link.

- **Send text:** *Get Contents of URL* `BEAM/api/text`, method **POST**.
  - Headers: `Authorization: Bearer KEY`, `X-Beam-Device: iPhone`.
  - Body: **JSON** with `text` = Shortcut Input and, optionally, `to` = a device name.
- **Send files:** *Repeat with Each* item, then *Get Contents of URL* `BEAM/api/file?to=Desktop`, method **PUT**.
  - Same headers, plus `X-Filename` = the item's name and extension.
  - Body: **File**.
- **Copy the latest text:** *Get Contents of URL* `BEAM/api/latest/text` with the Authorization header,
  then *Copy to Clipboard*. Pairs nicely with Back Tap.

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
node server.js stop            # stop it cleanly
node server.js pair            # a one-time link + QR code to add a device (the key itself is never printed)
node server.js export          # save everything to beam-export-<date>.tar.gz (also: npm run backup)
node server.js help            # all commands
```

- **Logs:** `data/logs/server.log` (timestamped; the last 25 MB are kept). Also under **Settings → Server log** on any
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
  stored files it doesn't recognise; it moves them to `data/orphaned/`. Uploads that don't fit on the disk are refused
  up front.
- **Health:** `GET /api/hello` answers without a key; Docker uses it as a health check.
- **Stats:** `GET /api/metrics` (signed in) shows memory and CPU, how long requests take, how often each device's
  connection is woken, and how much the server writes to disk.
- **Alerts** are kept in `data/alerts.json` (the last 100) and also go to ntfy if it's configured.
- **Wake-on-LAN** packets go out from the server itself, so the server must be on the same network as the PCs it
  wakes. In Docker that needs host networking. `BEAM_WOL_TARGETS` (a list of `address[:port]`) overrides where they're
  sent.

## Moving Beam

Everything Beam knows lives in its data folder: items, files, devices, sign-ins, settings, the key and its permanent
server id. Moving it keeps every device signed in, and the apps follow by themselves.

**The easy way: `import-from`.**
1. **Set up the new server** without starting Beam there yet: [Docker/NAS](#docker-and-nas), a
   [Windows Server](#windows-server) or [plain Linux](deploy/beam.service).
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
  deleted). Beam Family backs itself up the same way (see [docs/FAMILY.md](docs/FAMILY.md)).
- **Each PC's Beam app** keeps a copy of its settings on your Beam, sent whenever they change: its name, where files
  are saved, hotkeys, Send to, the outbox, notification choices and which devices may control it. Never its sign-in or
  device key. After a reinstall or a reset, Beam offers once to put them back. Turning remote control back on still asks
  at the PC, with the same devices ticked. Settings → This PC → **Restore settings…** does it any time, also from
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
  signed in, as a scheduled task that restarts it if it stops. (Without `-AtBoot`, Beam starts when you sign in.)
- Keep the data folder out of `Program Files`: set `BEAM_DATA=C:\ProgramData\Beam` (or another drive) in `.env`.
- Logs are in `data\logs\`.

## Configuration

Server settings go in environment variables or a `.env` file (see [.env.example](.env.example)). Retention, item
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
| `BEAM_FAMILY_*` | | Beam Family's settings: see [docs/FAMILY.md](docs/FAMILY.md) |

## Building the apps

The built apps live in `dist/` (not in git). The server offers them for download from there, **and installed apps
update themselves from there**:
- **Windows** swaps itself automatically, unless you turn that off in Settings.
- **Android** shows "Beam update ready: tap to install".

A new build reaches every device within seconds of landing in `dist/`.

- **Windows:** run `windows\build.cmd` (bump the version in `windows\src\Version.cs` first for an update). It uses the
  C# compiler built into Windows (.NET Framework 4.8) and Node.js (already there for the server), so nothing needs
  installing, and writes `dist\Beam.exe` and `dist\Beam.exe.json`. The app isn't code-signed, so SmartScreen and some
  antivirus programs may hold it the first time.
  - **Its updates are signed:** the first build makes a key, `%USERPROFILE%\.beam\windows-update-key.pem` (or wherever
    `BEAM_UPDATE_KEY` points), and puts its public half into the app, which then installs only updates signed with
    it. **Back that key up, like the Android keystore:** without it, every PC needs the next Beam installed by hand.
- **Android:** you need [Android Studio](https://developer.android.com/studio) (its JDK and SDK) and **your own signing
  key**, made once:
  ```bash
  keytool -genkeypair -v -keystore android/keystore/beam-release.jks -alias beam -keyalg RSA -keysize 4096 -validity 10000
  ```
  and `android/keystore.properties` next to it (both are git-ignored):
  ```properties
  storeFile=keystore/beam-release.jks
  storePassword=<the password you chose>
  keyAlias=beam
  keyPassword=<the password you chose>
  ```
  Then run `gradlew publishApk` in `android/` (with `JAVA_HOME` set to Android Studio's `jbr` folder). It writes
  `dist\beam.apk` and `dist\beam.apk.json`. For an update, raise `versionCode`/`versionName` in
  `android/app/build.gradle.kts` first.
  - **Back up the keystore and its passwords.** Every future update has to be signed with the same key, or phones
    will refuse to install it over the old version.

The protocol every client speaks is documented in [docs/API.md](docs/API.md); the Windows app's bridge to the web
app in [docs/HOST-BRIDGE.md](docs/HOST-BRIDGE.md).

## Tests

```bash
node test/server.test.js        # the server (about 4 minutes; scratch servers on ports 8791–8799)
node test/family.test.js        # Beam Family (seconds; ports 8841–8849)
node test/web/run.mjs           # the web apps in headless Edge, Chrome or Chromium (about 10 minutes; ports 8821–8829;
                                # it looks where they usually are on Windows, Linux and macOS, or set BEAM_TEST_BROWSER;
                                # BEAM_TEST_BROWSER_ARGS adds flags, and as root --no-sandbox goes in by itself)
```

Speed budgets live in `test/perf/`, and the Android unit tests run with `gradlew testDebugUnitTest` in `android/`.
The tests only ever start their own scratch servers with their own data folders.

## Security

The short version (the threat model and how to report a problem are in [SECURITY.md](SECURITY.md)):

- Every device has its own sign-in:
  - **Removing a device** signs it out and blocks its Tailscale machine from signing in automatically.
  - **Sign out all other devices** (Settings) also replaces the master key that older apps and pairing links used.
    Optionally it turns automatic Tailscale sign-in off, for when a phone is stolen.
  - A lost device that is still in your Tailscale account could reach Beam, so **remove it from Tailscale** too.
  - **A removed device wipes what Beam saved on it**: history, unsent messages, drafts and cached photos, the next
    time it reaches your Beam. Files you saved stay.
- Pairing links work once, for 15 minutes. The master key (`data/key`) is only needed by older apps and for
  administration; the `beam` command and newer apps swap it for their own sign-in by themselves.
- Signing in with Tailscale only trusts identities that `tailscale serve` on the Beam machine vouches for (never
  through Funnel), confirmed by `tailscale whois` (no answer means no automatic sign-in), and only at this Beam's own
  address, so a page on another name pointed at your server gets nothing.
- Password guesses are limited: 5 per address and 30 overall per 10 minutes, even in parallel. Keys that don't work
  are limited too.
- Browsers only accept changes from Beam's own pages, so another website on your tailnet can't act in your name.
- Over Tailscale, traffic between your devices and the server is encrypted. Over plain HTTP on your home network it
  isn't: behind `tailscale serve`, set `BEAM_HOST=127.0.0.1` so the server isn't reachable any other way (it warns
  at start otherwise). Items are stored unencrypted in the `data` folder until they expire.
- **The data folder is private:** at every start Beam makes sure only the account it runs as can open it (on Windows
  also SYSTEM and Administrators; elsewhere `chmod 700`).
- **The Beam server's computer is trusted:** `tailscale serve` hands requests to Beam on this machine, so programs
  and other accounts on it could pose as Tailscale traffic. Run the server on a computer only you use.
- **Updates are signed:** the apps install what your server's `dist` folder offers only when it's signed with the key
  they were built with (Windows: `windows\build.cmd`'s key; Android: your keystore, checked by Android itself). Keep
  those keys private and backed up.
- **Who signs in by itself:** only Tailscale accounts you trust: yours from the first sign-in, others only when you
  allow them in Settings → Security, from a sign-in made on purpose (password, pairing link, approval).
- Received files are never opened or run automatically. Uploaded files are served with a locked-down content policy,
  so an uploaded web page can't run scripts inside Beam.
- **Beam Family** is the only part meant to face the internet (through Funnel), and it's a separate server that can't
  reach your devices. Its own model is in [docs/FAMILY.md](docs/FAMILY.md#security-model).

## Roadmap and contributing

Where it's going: [ROADMAP.md](ROADMAP.md). How to help, and how the code is laid out:
[CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[MIT](LICENSE). The Windows app embeds Microsoft's WebView2 SDK, under its own BSD-style licence
([windows/lib/webview2/LICENSE.txt](windows/lib/webview2/LICENSE.txt)).
