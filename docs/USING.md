# Using Beam

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
  - the Beam server, or a computer running Beam for Linux 1.3 or later (a Raspberry Pi), is on the same network as
    that PC: the server asks every connected Beam for Linux to send the wake-up too, so a Pi at the office wakes the
    office's PCs while Beam runs at home;
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
- **Alerts** (Settings → Alerts): a device's battery is low, its storage is nearly full, the Beam server's disk is
  nearly full, or a Tailscale sign-in is about to run out (two weeks and three days before; the server's own matters
  most: when it runs out, no device can reach Beam). For the devices you pick (Settings → Alerts, or a device’s Device info), also when one goes
  offline (with why, when Tailscale can tell: the PC is on but Beam isn't running, or it's off or asleep) and comes back.
  Also when a PC is back on after losing power, freezing, a blue screen or being forced off.
- **History** (in Device info): what happened to a device, newest first, from Windows' own records: each restart and
  shutdown and who asked (a Windows update, your antivirus, you, a program), power losses and freezes, blue screens
  (with the stop code), being forced off, when it was back on and when someone signed in after, Beam's own crashes, and
  the times Beam saw the device offline for 10 minutes or more. A PC sends it when its Beam app connects; the server's
  own PC reads its own when the server starts (`BEAM_OWN_HISTORY=off` turns that off).
- **Beam log** (in a PC's Device info): the end of that PC's Beam log, sent by its Beam app when you ask, from any of
  your devices. Nothing is kept on the server, and Beam never writes message text, keys or sign-ins into its log.
- **Shared folders** (Beam 1.26, the Windows app 1.18): copy files from another of your PCs without remoting in. At the
  PC, Settings → Control & sharing → **Shared folders…** chooses the folders, and for each one the devices that may see it
  (nothing until you add a folder; only there, never from another device, and not while the PC is being controlled).
  Then on those devices, that PC's Device info → **Shared folders**: look in its folders, tick files and **Copy to this
  device**. The PC sends them the way it sends anything (they arrive in your conversation with it) and shows a notice.
  Read-only: nothing on the PC can be changed or deleted from elsewhere, and nothing else is visible: no hidden files,
  nothing starting with ".", no shortcuts or links to other folders. A whole drive, your user folder itself, AppData,
  Windows and Program Files can't be shared. It takes a trusted sign-in.
  **Like Explorer (Beam 1.28, the Windows app 1.20):** sort by name, date, size or type (folders first), the PC's own
  icons and type names, a grid of Windows' thumbnails (pictures, videos, PDFs), a look at a file before copying it
  (pictures, the start of a text file, PDFs, a frame of a video), a search of the folder and every folder below it,
  Select all, and whole folders (each sent as a .zip of what it shows).
- **Appearance** (Beam 1.27, the Windows app 1.19, Beam Family): Settings → Appearance: light, dark or like the device,
  and an accent colour (nine to pick from, or any colour of your own). For all your devices, or just this one (its own
  wins). In the Windows app its own windows, title bar and tray icon follow too, also on a PC whose Beam window stays
  closed. The Android app (1.14) follows it too and has its own Settings → Appearance; a colour of your own shows there
  as the nearest of the nine. Beam Family: the family's look (admins set it) or your own, on every device you use it on.
  **Text size** (Beam 1.29): Smaller, Normal, Larger or Largest, for Beam's page (the browser and the Windows app's
  window), with the same "all my devices or just this one"; your browser's own text size counts too. The Android app
  follows the phone's own font size.
- **Setup check** (Settings → Server → Setup): Beam looks at its own setup every 6 hours and alerts when something is
  wrong: the servers start when Windows does, Tailscale runs unattended, devices come in over https, backups are
  recent, there's room on the disk, every PC runs the latest Beam and starts it with Windows, no Tailscale sign-in runs
  out soon. Each line says what to do when it's wrong (`BEAM_SETUP_CHECK=off` turns the automatic look off).
- **Alerts from your other programs** (Beam 1.33, the Windows app 1.26, the Android app 1.19): anything that can
  send to ntfy or post a webhook can send its alerts to Beam instead. Settings → Alerts gives each program its own
  key (it can send alerts and nothing else); point the program's ntfy server at `<your Beam>/notify` with the key as
  its topic (or post to `<your Beam>/notify/<key>`). They show up under Alerts on every device, with Beam's own:
  newest first, one chip per program, a pop-up for the ones that matter (mute or snooze a program).
- **Commands on a PC** (Beam 1.32, the Windows app 1.25, the Android app 1.18): run a PowerShell or Command Prompt
  command on one of your PCs from another device (Device info → Run a command) and see what it prints while it runs,
  with Stop and its exit code. Only for the devices that may control that PC, and only once "Allow commands too" is
  on at that PC; it runs as that PC's signed-in user, never as administrator.
- **Sites** (Beam 1.31, the Windows app 1.24, the Android app 1.17): the web pages your machines serve over Tailscale, in
  one list on every device (the globe at the top of the web app; Sites in the Android app's menu). Each PC's Beam app
  finds the pages that PC serves to your tailnet by itself (it asks only the ports web pages use); add others by
  address, like a Raspberry Pi's `http://my-pi:8080`. Beam checks each one when you open the list: a green dot when it
  answers, red with the reason when it doesn't, its title and icon. Rename, hide a found one, remove an added one.
- **Connections** (Settings → Connections): how the Beam server reaches each device over Tailscale: direct on the same
  network, direct over the internet, through a peer relay, or through Tailscale's relay (slower), with **Test** to
  check it now and the delay. It also shows when each Tailscale sign-in runs out: turn off key expiry in Tailscale's
  admin console for PCs that stay put. A device that's offline says why on its line and in Device info. **Test speed**
  measures how fast Beam's own way is, both ways, about 3 seconds each (64 MB at most each): this device's in its own
  page, and a PC's when its Beam app is asked from another device.

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
- **On each PC:** the tray menu's **Show phone notifications** checkbox, also in Settings → Notifications.
  - A pop-up appears for each new notification, grouped per app ("3 new from WhatsApp").
  - Clicking one opens the **Phone** panel in the chat window, ready to reply.
  - **Show message text in pop-ups** (Settings → Notifications) can be turned off: pop-ups then just say "WhatsApp · new
    notification", and the text stays inside Beam.
- **In a browser:** Settings → Notifications (off by default). The Phone entry sits under All devices.
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
- **On a phone or tablet** (modeled on Chrome Remote Desktop and Microsoft's Remote Desktop app), choose
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
- **Off on every PC until you switch it on at that PC:** Settings → Security → **Allow remote control** in its Beam
  window (Windows app 1.19.1), or the tray menu. You tick which of your
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
  for a PC, from any of your devices (Settings → Devices, then the PC). Nothing but the PC itself can turn it on.
- **In the viewer:** the Picture panel (fit the PC to this screen, off unless you turn it on (Windows app 1.12.7: a new
  resolution makes some apps, like Windows' Settings, lay out wrong until reopened): its resolution changes to suit the
  screen you view it on and goes back when you disconnect; Auto, Sharp text, Smooth motion or Data saver; picture size, frame rate, data limit, codec and details, kept per PC), choose a screen, full
  screen, a Keys menu (Win, Alt+Tab, Lock this PC…), and clipboard sync (text and pictures, such as a screenshot),
  which is off until you turn it on for that session (Ctrl+V sends nothing back while your clipboard still holds what
  the PC put there, 1.12.7). A phone asks "Still there?" after 10 minutes without a touch.
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
  screen, the capture, encoding, sending, back, decoding and the wait to be shown. Since the Windows app 1.22.1 six big
  changes follow (a block of text the size of a window swaps its page), shown as "A big change (… about N KB): N ms".
- **A bandwidth floor** (Windows app 1.17.7, across the internet since 1.22.1): WebRTC's own estimate stays low while
  the screen is mostly still, so a window opening would trickle out and hold up what comes after it. On a fast local
  link the PC asks for at least 12 Mbps; across the internet, half of what the Connections speed tests measured
  between the two (the PC's upload, your download, each taken where the device is now), at most 20 Mbps. Never on
  mobile data or in Data saver, only on a direct path, and off for the session if packets get lost or the delay climbs.
- **Limits:** a locked or signed-out PC and Ctrl+Alt+Del need Remote Desktop (the existing button); administrator
  windows and Windows' prompts need that PC's "Administrator windows" set up (Windows app 1.22). Only Beam apps, or a browser where you signed in with a pairing link, approval or password, can start a
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

**Apps on every PC** (Beam 1.21, Windows app 1.16; Settings → Apps)

- **Add an app** from a GitHub repository (`owner/repo` or its link: its latest published release, the Windows .exe,
  .msi or .zip, checked against the SHA-256 the release publishes when it publishes one), from a file you send (an
  .exe, .msi or .zip, up to 2 GB), or from winget (a package id like `7zip.7zip`; each PC runs winget itself). Beam looks
  for a new GitHub release every 6 hours, and the PCs that have the app get it too.
- **Install on all PCs** (or one): each PC's Beam app installs it for its signed-in user: a single .exe goes to
  `%LOCALAPPDATA%\Programs\<app>` with a Start menu shortcut and an entry in Windows' Installed apps; a .zip is unpacked
  there; an .msi or a setup program runs (with the switches you give it for a quiet install). Beam never installs as
  administrator: an installer that needs that shows Windows' own prompt on that PC.
- **Each PC asks once:** until someone at the PC allows it, a request there asks **Install** (this once), **Always
  allow** or **Not now**. Turn it on or off later in its Settings → Security (**Let Beam install apps**), the tray menu, or Settings → Control & sharing.
- **Where it is:** the Apps page shows each PC's state (installed and its version, waiting for someone at the PC,
  couldn't install and why), with **Uninstall** per PC, **Check for a new version** and **Remove**.

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
  `Beam\To <device>` folders you set up under Settings → Sending.
- **Receiving:**
  - Text goes onto the clipboard; you can keep it out of clipboard history.
  - Files are saved to `Downloads\Beam` and marked as downloaded from the internet. Big ones start saving while
    they're still arriving.
  - Clicking a notification opens a link or copies text. A picture or a video opens in its conversation; another file
    shows in its folder. A notification for several things at once opens their conversation at the newest.
  - **Windows' own notifications** (Windows app 1.21): a text that comes has a **Reply** box (what you type goes back
    to whoever sent it) and **Copy** or **Open link**; a file **Open** and **Show in folder** (or **Save**). They work
    from the notification centre later too. Settings → Notifications → "Notifications with Reply and Copy" (off: the
    plain pop-ups from before, which is also what you get if Windows has Beam's notifications turned off).
  - Programs are only ever shown in Explorer, never run.
- **Links open themselves** (optional, Settings → Receiving → "Open links sent to this PC automatically"): a link you
  send to this PC by itself opens in the browser right away.
- **Updates** install themselves from your server. If a new version fails to start, Beam goes back to the previous one
  on its own. A new version goes to one PC first (the server's own, when its Beam app is on); the others get it once it
  has run there for 10 minutes, and not at all if it failed there, unless you offer it to them anyway (Settings →
  Server, which can also turn this off).

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
- **Shared folders** (Android app 1.15): long-press a PC's conversation (or Settings → Devices, that PC) → **Shared
  folders**: the folders that PC shares with the phone, with everything the web page has (pictures, a look at a file,
  search, sort, whole folders). Back steps back a folder; what you copy arrives in your conversation with that PC.
- **Offline:** history, outbox and drafts work offline, and transfers survive network switches and restarts.
- **Settings:** per-device mute and auto-copy, Wi-Fi-only downloads, server info, and battery exemption.
- **Updates:** it updates itself from your server without asking, where Android allows.

**Web app**

- On Android, installing it (Chrome ⋮ → *Install app*) also adds it to the Share menu.
- On a borrowed computer, tick "shared or borrowed computer" when signing in. You're signed out when the browser
  closes.
