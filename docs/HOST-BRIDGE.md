# Beam host bridge (web app ⇄ Windows app)

From version 1.2.0 the Windows app (`Beam.exe`) shows its messenger window by hosting the **web app** (`public/`,
served by the Beam server) in Microsoft Edge **WebView2**. The page is the whole chat UI. The host (the native tray
app) keeps doing everything that must work while the window is closed or that a browser can't do:

- notifications, auto-copy and auto-save of received items, and acknowledging them;
- file transfers (resumable 8 MB-chunk uploads that survive restarts, Range-resumed downloads into the Beam folder);
- the clipboard, Explorer "Send to", outbox folders, hotkeys, starting with Windows, self-update;
- signing in (the native sign-in window) and approving other devices' sign-ins (the native prompt).

This document is the contract between the two sides. Bridge version: **1**.
A page must keep working unchanged in ordinary browsers: everything here only applies in **host mode**.

## 1. Host mode

```js
const HOST = window.beamHost && window.chrome && window.chrome.webview ? window.beamHost : null;
```

The host injects `window.beamHost` before any page script runs (on every document, including reloads):

| Field | Example | Meaning |
|---|---|---|
| `bridge` | `1` | This contract's version. Feature-detect with `features` rather than comparing versions. |
| `app` | `"windows"` | The host kind. |
| `version` | `"1.2.0"` | The app version. |
| `deviceId` | `"a1b2…"` | **This device's id.** The page must use it as its own id (see §2). |
| `deviceName` | `"Desktop"` | This device's name. The app owns it; rename through `setSettings`. |
| `platform` | `"windows"` | Send it as `X-Beam-Platform` and `platform=` (see §2). |
| `server` | `"https://beam.tail1234.ts.net"` | The origin the host trusts. The bridge only works on this origin. |
| `features` | `["transfers","localFiles","settings","clipboard","pickFiles","pickFolder","dragOut","dragOutDone","openPanel","remoteDesktop","phoneNotifications","remoteControl","restoreSettings","copyFiles","dragOutMany","family"]` | What this host supports (`remoteDesktop` since Beam for Windows 1.3.0, `phoneNotifications` since 1.5.0: see §10, `remoteControl` since 1.6.0: see §11, `dragOutDone` since 1.7.1: §5, `restoreSettings` since 1.8.1, `copyFiles` and `dragOutMany` since 1.9.0: §4, `family` since 1.10.0: §4 `openFamily`, §12). |
| `debug` | `false` | `true` when Beam.exe runs with `--devtools` (DevTools and extra logging on). |

`beamHost` is informational. Never treat it as a security boundary; the host re-checks everything it is asked to do.

## 2. Identity and sign-in

The page and the app are **one device**. The host sets things up so the page is already signed in as the app:

- **Cookie.** Before loading the page, the host puts the app's secret (a device token, or the master key on older
  servers) in the `beam_key` cookie for the server's host: `HttpOnly`, `Path=/`, `SameSite=Lax`, `Secure` on https,
  10-year expiry. The page never sees the secret. Over https (1.7.6, audit S-10) also as `__Host-beam_key`, set through
  DevTools `Network.setCookie` with the page's URL (CreateCookie names a Domain, which the `__Host-` prefix forbids).
  The server reads that one first; from the release after 1.7.7 it is the only one it reads over https.
- **Id and name.** The page must take `beamHost.deviceId` and `beamHost.deviceName` instead of its own
  `beam.deviceId` / `beam.device`. (For older pages the host also writes those two localStorage keys before the page runs.)
- **Headers.** Every API call and the SSE stream use the app's id, name and **platform `windows`**:
  `X-Beam-Device-Id`, `X-Beam-Device` (URI-encoded) and `X-Beam-Platform: windows`;
  `/api/events?device=<id>&name=<name>&platform=windows`.
- **Never** show the lock screen, call `/api/autopair`, `/api/login`, `/api/logout` or create login requests in
  host mode. The host signs in natively.
- **The device key (1.6.0)** is the app's alone. Beam.exe sends `X-Beam-Device-Key` (this install's key, DPAPI-protected
  for the Windows account) with its own requests. The page never gets it and keeps using the cookie. The host adds it
  to the page's requests on their way out (`WebResourceRequested`), because the server takes an app token for remote
  control only with it: in the chat window to `/api/rc/*`, in the viewer window (§11.3) to every `/api/` request,
  its event stream included. The page can't read it.
- **On 401** (from any request or when the event stream is refused): send `{ type: "unauthorized" }` once, show a quiet
  "Signing in…" state, and stop retrying. The host opens its sign-in window and reloads the page when it's done.
  Don't call `POST /api/clear-cache` in host mode. When this same Beam confirms the 401 (a revoked sign-in), the host
  clears the web view's profile itself: cookies, storage and the HTTP disk cache (`ClearBrowsingDataAsync`, or deleting
  the profile folder when no web view is open). That reload waits until the clearing is done.
- **On 410 / `moved`** (a `410 { movedTo }` answer, a `moved` event, or `movedTo` in `/api/hello`): send
  `{ type: "moved", movedTo }` and show "Beam is moving…" instead of the "Beam has moved" page. The host checks the new
  address (same `serverId`, valid proof), switches, and reloads the page on the new origin.
- **Read markers** (API v3, `PUT /api/read`, `read` event): the page keeps using them as in a browser. It *also* sends
  `{ type: "read", conversation, ts }` so the tray's unread count updates at once (works on older servers too).

## 3. Transport

**Page → host:** `chrome.webview.postMessage(message)`, where `message` is a plain JSON-able object with a `type`.
Requests that expect an answer carry a numeric or string `id`:

```js
let seq = 0; const waiting = new Map();
function hostCall(type, fields = {}, files) {
  const id = ++seq;
  const msg = { type, id, ...fields };
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    files ? chrome.webview.postMessageWithAdditionalObjects(msg, files) : chrome.webview.postMessage(msg);
  });
}
chrome.webview.addEventListener('message', e => {
  const m = e.data;                       // already parsed (the host uses PostWebMessageAsJson)
  if (m.type === 'reply') { const w = waiting.get(m.id); waiting.delete(m.id); if (w) m.ok ? w.resolve(m.result) : w.reject(Object.assign(new Error(m.error), { code: m.code })); return; }
  onHostEvent(m);                         // see §5
});
```

**Host → page:** `{ type: "reply", id, ok: true, result }` or `{ type: "reply", id, ok: false, code, error }`, plus the
events in §5. `code` is machine-readable (`"not-found"`, `"not-saved"`, `"empty"`, `"cancelled"`, `"busy"`,
`"bad-request"`, `"unknown-type"`, `"offline"`, `"failed"`), `error` is a sentence for the user.

**Handshake.** The host sends nothing until the page says `{ type: "hello", id, bridge: 1 }` (send it once the app has
initialised, even while offline). The reply is the full host state (§4, `hello`). Events are queued until then.
If an old page never says hello, the host still works (downloads are intercepted, see §8), just without the extras.

**Origin rule.** The host accepts messages only from a top-level document whose origin equals `beamHost.server`, and
ignores everything else. The page must not send from iframes or other origins.

Unknown message types get `{ ok: false, code: "unknown-type" }`. Unknown fields are ignored in both directions, so
either side can add fields without breaking the other.

## 4. Page → host messages

Conversations use the web app's keys: `"all"` or a device id. Targets (`to`) are an array of device ids; `[]` means
every device.

| `type` | Fields | Reply `result` | What the host does |
|---|---|---|---|
| `hello` | `bridge` | `{ app, version, deviceId, deviceName, settings, update, conn, transfers: [Transfer], localFiles: { itemId: true } }` | Handshake; returns the current state. |
| `sendFiles` | `to`, files as additional objects | `{ count }` | Uploads the files natively (resumable, keeps going if the window closes). Folders are zipped first. Use for **drops** and `<input type=file>` files. |
| `pickFiles` | `to` | `{ count }` (0 if cancelled) | Native "Open" dialog (any size), then sends. Use this for the paperclip button. |
| `pickFolder` | `to` | `{ count }` | Native folder picker, sends the folder as a .zip. |
| `sendClipboard` | `to` | `{ kind: "text" \| "image" \| "files", description }` or `code: "empty"` | Reads the Windows clipboard itself (text, screenshots, files copied in Explorer) and sends it. Use it for **pasted files/images** and the paste button: pasted blobs have no disk path. |
| `saveFile` | `itemId` | `{}` | Downloads the file into the Beam folder (resumes after restarts). Progress arrives as `transfer` events, then `localFile`. |
| `saveFileAs` | `itemId` | `{}` or `code: "cancelled"` | Native "Save as" dialog, then downloads there. |
| `openFile` | `itemId` | `{}` | Opens the local copy with its default app. If it isn't saved yet, saves first and opens when done. **Executables and scripts are never run**: they're shown in the folder instead. |
| `revealFile` | `itemId` | `{}` | Shows the local copy selected in Explorer (saves first if needed). |
| `cancelTransfer` | `transferId` | `{}` | Cancels a queued or running upload or download. |
| `retryTransfer` | `transferId` | `{}` | Retries a failed one. |
| `dismissTransfer` | `transferId` | `{}` | Removes a failed/cancelled row. |
| `copyText` | `itemId` or `text` | `{}` | Puts the text on the clipboard (fetches the full text of truncated items; honours "keep out of clipboard history"). |
| `copyImage` **(1.6.2)** | `itemId` (an image file), or `png`: base64 PNG bytes | `{}`; `code: "unsupported"` (a type Windows can't read, e.g. WebP or HEIC: send it again as `png`), `"too-big"` (over 64 MB or 100 megapixels), `"not-found"`, `"failed"` | Puts the picture on the clipboard as a bitmap, plus PNG when it has transparency, turned as its EXIF orientation says; honours "keep out of clipboard history". The page's own clipboard can't take images over http. An app before 1.6.2 answers `unknown-type`. |
| `openLink` | `url` | `{}` | Opens an `http:`, `https:` or `mailto:` link in the default browser. Anything else → `bad-request`. |
| `remoteDesktop` | `host`: a DNS name or IP address (use the device's `tailscale.dns`, else its Tailscale IP) | `{}`; `code: "bad-request"` if `host` isn't a plain name/address; `code: "failed"` if the client couldn't start | Runs Windows' Remote Desktop client: `mstsc.exe /v:<host>`. Only if `features` has `remoteDesktop`; offer it for devices with `can.remoteDesktop`. |
| `dragOut` | `itemId`, or `itemIds` **(1.9.0, `features` has `dragOutMany`)**: several files picked together (≤ 1,000), all in one drag | `{}`, `{ copied: true }`, or `code: "not-saved"` (any of them isn't saved on this PC: no drag) / `"clipboard"` / `"bad-request"` (over 1,000) | Starts a native drag of the local file (or files) (call it from `dragstart` on a file bubble with the mouse still down, after `preventDefault()`); `dragOutDone` follows when it ends. Only if `features` has `dragOut`. **While another device controls this PC** (1.7.1) there is no drag: the file goes onto the clipboard as Explorer's Copy puts it, and the reply is `{ copied: true }` (the page says to paste it). A drag's modal loop on the app's thread held up the remote session's own input, so the mouse button never came back up. |
| `copyFiles` **(1.9.0)** | `itemIds` (1 to 1,000 file items), optional `clipSeq` | `{ copied: n }`; or `{ missing: [itemId…], clipSeq }` when some aren't saved on this PC (nothing copied); `code: "clipboard-changed"` (`clipSeq` given and something else was copied since), `"not-found"` (one isn't a file the app knows), `"bad-request"`, `"clipboard"` | Puts the files on the clipboard together, as Explorer's Copy does (any program that takes pasted files takes them). For files not on this PC yet the page saves them (`saveFile`), waits for their `localFile`, and asks again with the `clipSeq` it was given: the app never replaces something the user copied in between. Only if `features` has `copyFiles`. |
| `read` | `conversation`, `ts` | (no reply needed) | Updates the tray unread count. |
| `viewing` | `conversation`, `visible` | (no reply needed) | Which conversation is on screen. The host doesn't notify about items in it while the window is visible and focused. Send on every conversation switch. Use `"phone"` while the **Phone panel** is open: the host then shows no phone-notification balloons (1.5.0). |
| `getSettings` | | `{ settings }` | See §6. |
| `setSettings` | `settings` (only the fields to change) | `{ settings }` (the result, after validation) | Saves and applies them; `code: "bad-request"` with a message if a value is invalid. |
| `browseFolder` | `setting`: `"saveFolder"` or `"outboxFolder"` | `{ path }` or `code: "cancelled"` | Native folder picker; applies the choice. |
| `openFolder` | `which`: `"save"`, `"outbox"` or `"logs"` | `{}` | Opens it in Explorer. |
| `checkForUpdates` | | `{ update }` | Asks the server now. |
| `installUpdate` | | `{}` | Installs a downloaded update now (the window reopens by itself). |
| `signInAgain` | | `{}` | Native sign-in window for the current server. |
| `switchServer` | | `{}` | Native sign-in window that looks for servers again (keeps this device's identity). |
| `unpair` | | `{}` | Signs this PC out (ask the user to confirm first). |
| `unauthorized` | | (none) | See §2. |
| `moved` | `movedTo` | (none) | See §2. |
| `log` | `level`: `"info"` or `"error"`, `message` | (none) | Writes a line to beam.log. **Never include message text, file names or secrets.** |
| `openRemote` | `device`: a device id | `{}`; `code: "bad-request"` for this PC or a device it doesn't know | Opens the **viewer window** for that PC (§11.3), or brings it to the front. Only if `features` has `remoteControl`; offer it ("Control") for devices with `can.remoteControl`. |
| `restoreSettings` | (none) | `{}` | **(1.8.1)** The app's own choice of settings backups (this PC's earlier installs', and the newest of each other PC's): it puts the chosen one back; remote control comes back only through its own confirmation. Only if `features` has `restoreSettings` and the server's has `backups` (Settings → This PC → "Restore settings…"). |
| `openFamily` | (none) | `{}`; `code: "unavailable"` when the server names no Beam Family (its `/api/info` has no `family`) | **(1.10.0)** The header's ♥: Beam Family in a window of the app's own (§12), or brought to the front. The address is the one the server's `/api/info` gives the app, never one from the page. Only if `features` has `family`; otherwise the ♥ stays a link (the window hands it to the browser). |

## 5. Host → page events

| `type` | Fields | The page should |
|---|---|---|
| `navigate` | `conversation`, `itemId?`, `focusComposer?` | Open that conversation; if `itemId`, scroll to it and highlight it briefly. Sent after a notification or tray click. |
| `transfer` | `transfer` (Transfer, below) | Insert or update that transfer's row. |
| `transferRemoved` | `transferId`, `itemId?` | Remove the row. `itemId` is the finished item (its `item` SSE event arrives separately). |
| `localFile` | `itemId`, `saved` | Update the file's actions (Open / Show in folder when saved, Save when not). |
| `settings` | `settings` | Refresh the "This PC" section. |
| `update` | `update` | Refresh the update line. |
| `conn` | `conn` | Optional: the host's own connection state. |
| `openPanel` | `panel`: `"settings"` or `"pair"` | Open that dialog (the tray's "Settings" and "Add a device…" land here). Scroll Settings to the "This PC" section. |
| `openPhoneNotification` | `id` (a phone notification's `id`, `"<phone id>/<key>"`) | Open the **Phone panel** with that notification selected and its reply box focused (no reply action: just selected). If it's gone meanwhile, open the panel. Sent after a click on its balloon (1.5.0, `features` has `phoneNotifications`). |
| `dragOutDone` | `itemId` (the first, for several) | The native drag started by `dragOut` ended (dropped anywhere, or cancelled). Until then a file drag over the page is that drag coming back: no "Drop to send", and a drop on the page sends nothing (1.7.1, `features` has `dragOutDone`). |

**Transfer**

| Field | Meaning |
|---|---|
| `id` | `"up:<n>"` or `"down:<itemId>"` — use it with cancel/retry/dismiss |
| `kind` | `"upload"` or `"download"` |
| `itemId` | the item (downloads; uploads once finished) |
| `conversations` | where to show the row: `["all"]` for broadcasts, else the target device ids (uploads) or the sender's conversation (downloads) |
| `name`, `size` | file name and total bytes |
| `done` | bytes transferred so far |
| `rate` | bytes per second (smoothed), or 0 |
| `eta` | seconds left, or -1 when unknown |
| `state` | `"queued"` (also while a folder is being zipped; `status` says so), `"running"`, `"retrying"`, `"failed"`, `"done"`, `"cancelled"` |
| `status` | a short sentence for `queued`/`retrying`/`failed` (e.g. "Zipping the folder…", "Connection problem, retrying in 8 s", "Waiting for the sender", the error) |
| `canCancel`, `canRetry` | which buttons to show |
| `auto` | `true` for automatic saves of received files |

## 6. Settings (owned by the app, shown by the page)

`settings` is one object. Read-only fields are marked **ro**; send only the fields you change.

| Field | Type | Meaning |
|---|---|---|
| `deviceName` | string ≤ 40 | This PC's name in Beam |
| `autoCopy` | bool | Copy received text to the clipboard |
| `clipboardHistory` | bool | Let received text appear in Windows clipboard history (Win+V) and cloud clipboard |
| `autoSave` | bool | Save received files automatically |
| `maxSaveMB` | int ≥ 1 | …up to this size per file |
| `saveFolder` | string | Where files are saved (change with `browseFolder`) |
| `openLinks` | bool | Clicking a notification about a link opens the link |
| `autoOpenLinks` | bool | "Open links sent to this PC automatically" (default off, Beam for Windows 1.3.0+): a text that is just one http(s) link, sent to this PC itself (not to all devices), opens in the default browser at once |
| `sendToMenu` | bool | Explorer "Send to › Beam" entries |
| `outbox` | bool | Outbox folders on/off |
| `outboxFolder` | string | Outbox root (change with `browseFolder`) |
| `autostart` | bool | Start Beam when I sign in |
| `autoUpdate` | bool | Install updates automatically |
| `phoneNotifications` | bool, or **null** | "Show phone notifications" on this PC (1.5.0): this device's server setting `settings.phoneNotifications`, which the app owns. Change it with `setSettings({ phoneNotifications })`; the app sends `PUT /api/devices/me/settings` and the result comes back as a `settings` event. `null`: the server doesn't have the `phone-notifications` feature (hide the switch, or say it needs Beam server 1.5). |
| `phonePopupText` | bool | "Show message text in pop-ups" (1.5.0, default on, this PC only; show it with `phoneNotifications`): off, phone balloons say only "<app> · new notification" or "3 new from <app>". Windows keeps shown pop-ups in its Notification Center until they're cleared, so it's worth a short note next to it. |
| `allowRemoteControl` | bool, or **null** | "Allow remote control" (1.6.0, default off). `null`: the server has no `remote-control`. **The page can only turn it off**: `setSettings({ allowRemoteControl: false })`. `true` gets `code: "native-only"`: it's turned on only at the PC, in the tray menu or the native Settings, always through a native confirmation that lists the devices. |
| `remoteControlDevices` | **ro** `[{ id, name, machine }]` | The devices that may control this PC (1.6.0), chosen in that confirmation; `machine` is the Tailscale machine each one is pinned to (null until known). Changing the list from the page gets `code: "native-only"`. |
| `hotkeys` | **ro** `[{ id, keys, action, registered }]` | e.g. `{ id: "picker", keys: "Ctrl+Alt+B", action: "Send clipboard to…", registered: true }` |
| `server` | **ro** `{ url, version, api, serverId, storage: { used, free, total } \| null, connected }` | For the "About / Server" section |
| `app` | **ro** `{ version, installed, path }` | `installed` is false when Beam runs from outside its install folder |

`update` = `{ state: "none" \| "available" \| "downloading" \| "waiting" \| "ready" \| "failed", version?, error?, current }`
(`waiting` = waits for transfers to finish; a download that only waits for its paused sender doesn't hold it up). `conn` = `{ state: "online" \| "connecting" \| "offline" \| "unauthorized", text }`.

## 7. What changes in the page in host mode

Switch **off**:
- the lock screen, login requests, `/api/autopair`, password sign-in and "Unpair" (use `unpair`);
- the "Beam has moved" page (send `moved`);
- web notifications and the "Turn on notifications" button (the app notifies natively; the host swallows any `Notification` the page creates);
- the automatic **approval dialog** on `login-request` events (the app shows its own prompt). The "Approve a sign-in"
  code form may stay;
- **acknowledging items** (`POST /api/items/{id}/ack`): the app acks once it has copied, saved or notified;
- **XHR uploads**: every file send goes through `sendFiles` / `pickFiles` / `sendClipboard`, so it survives closing the
  window and restarts. Text is still sent by the page (`POST /api/text`);
- **downloads** (`<a download>` links): use `saveFile`; for images/video/audio, clicking the preview calls `openFile`
  instead of opening `?inline` in a new window (inline previews inside the thread are fine);
- the share-target pickup and `navigator.share`;
- the "Windows" app download link (keep Android);
- renaming the device in the page's own field: use `setSettings({ deviceName })`.

Render **in addition**:
- **Transfer rows** from `transfer` events in each of `transfer.conversations`: name, size, progress bar,
  "12 MB of 1.8 GB · 4.2 MB/s · 6 min left", `status` text for retrying/failed, and Cancel / Retry / Remove buttons
  (`canCancel`, `canRetry`). Rows are not items; they disappear on `transferRemoved`.
- **File actions** from `localFiles` / `localFile`: saved → **Open** and **Show in folder** (and drag-out); not saved →
  **Save** (and "Save as…"). Double-clicking a file bubble = Open.
- A **"This PC"** section in Settings from `settings` (§6): receiving (auto-copy, clipboard history, auto-save + size +
  folder, "Open links sent to this PC automatically" = `autoOpenLinks`), sending (Send to menu, outbox folders +
  folder), Windows (start with Windows, hotkeys list, link notifications), updates (version, state, auto-update, Check now / Install), and **About / Server** (address, server
  version, storage used/free, **Switch server…**, **Sign in again**, **Sign out**).
- **Highlight** for `navigate` with `itemId`.
- **Remote Desktop** (device actions, for devices with `can.remoteDesktop`): call `remoteDesktop { host }` instead of
  linking to the `.rdp` file.

Keep as in a browser: sending text, the event stream, read markers, delete/forget/pin/forward, the pairing QR
("Add a device"), the password setting, search, previews, text selection and Copy.

**Several at once (Beam 1.12, Windows 1.9.0):** messages picked together (or photos and files picked in a
conversation's gallery) are copied as files with `copyFiles`, and a drag of a picked file takes every picked file along
(`dragOut` with `itemIds`). Save saves the ones not on this PC yet (`saveFile` each); with all of them saved it's
"Show in folder" (`revealFile` of the first). A test instance (its own `--config`) never starts a real drag: the paths
go to `drag-files.txt` in its folder, as its clipboard goes to `clipboard-files.txt`.

Phone notifications (1.5.0): see §10.

## 8. What the host enforces (for the page author's awareness)

- **Navigation:** the top-level page stays on `beamHost.server`. Links to other origins open in the default browser;
  `file:` and other schemes are blocked. New windows are never opened inside Beam: `/api/file/{id}` URLs become
  `openFile`, other http(s) URLs go to the default browser.
- **Downloads** that start anyway (an old page, a stray `<a download>`) are cancelled and handed to the native
  downloader when they are `/api/file/{id}`; anything else is saved into the Beam folder.
- **Drops:** WebView2 delivers Explorer drops to the page as normal HTML5 drop events. The page must
  `preventDefault()` on `dragover`/`drop` everywhere (otherwise Chromium would navigate to the file; the host blocks
  that) and hand the files to `sendFiles`.
- **Context menu:** Cut, Copy, Paste, Select all, Copy link, Copy image and spelling only. No Inspect, Save as, Print
  or Reload (unless `--devtools`).
- **Keys:** Ctrl+R/F5 reload and Ctrl +/- zoom work (the zoom is remembered); DevTools is off.
- **Lifecycle:** the WebView is created when the window opens and **destroyed about 3 minutes after the window is
  hidden** (a hidden window is suspended first). The page must restore everything from the server and `hello`; don't
  keep unsent state only in memory. The last conversation is kept in localStorage as usual.
- **Hidden (closed to the tray, or minimized; Beam for Windows 1.4.0+):** the page gets `visibilitychange` →
  `hidden` at once and its memory is trimmed; **5 seconds later it is suspended** (frozen), so do anything that must
  happen on hiding (e.g. switch the event stream to background mode with a poke) within that time. While hidden, the
  host holds its events and delivers only the latest `transfer` per transfer, `localFile` per item, and `settings`,
  `update`, `conn` when the page is visible again; `transferRemoved` is delivered then too. `navigate`, `openPanel` and
  `openPhoneNotification` only come with the window showing.
- **Offline:** if the server can't be reached when the window opens, the host shows its own small local page
  ("Can't reach Beam… retrying") and loads the real page once it's back. If the page is already open, it shows its
  usual offline state.
- **Security:** `openFile` / `revealFile` / `dragOut` / `copyFiles` only ever act on items the host saved or sent itself,
  looked up by item id; the page never passes file-system paths. `openLink` only opens http, https and mailto. `remoteDesktop`
  only accepts a DNS name (letters, digits, hyphens, dots) or an IP address, nothing else reaches the command line.
  Nothing returns the key or token.

## 9. Compatibility

- **New page, browser:** no `beamHost` → everything behaves as today.
- **Old page, new host:** works: the page signs in with the cookie, downloads are intercepted, drops upload through the
  page itself while the window is open. No transfer rows, local-file actions or "This PC" settings until the page is
  updated.
- **Older servers (API < 3):** the host falls back to the master key, skips read markers and storage stats, and follows
  moves with the old 410 rule.

## 10. Phone notifications (Beam 1.5.0; `features` has `phoneNotifications`, the server has `phone-notifications`)

The phone shares the apps the user picked with every device whose `settings.phoneNotifications` is on. The page shows
the **Phone panel** (list, Reply, actions, dismiss); the app shows the balloons and owns this PC's switch.

- **Balloons (the app):** one per new notification, "<appName> · <title>" plus its last 1–2 lines; at most one per app
  per 5 seconds ("3 new from WhatsApp"); none for `silent` ones, for a re-send with the same content, or while the
  page says `viewing { conversation: "phone" }` with the window focused. Windows' Focus / Do not disturb applies. A
  click opens the window and sends `openPhoneNotification { id }` (§5); balloons of several apps due at once become one
  ("New on your phone"), whose click opens the latest. With `phonePopupText` off they carry no message text. A
  re-send (`resent: true`, e.g. after a server restart) never pops up; from a phone that doesn't send `resent`, one
  whose post time (`posted`, else `when`) is over 10 minutes older than the server's `at` doesn't either.
- **The page** keeps its own Phone panel from its own event stream and `GET /api/phone/notifications`, and sends
  replies, actions and dismissals itself. It never shows web notifications for them in host mode (the app does).
- **The switch:** Settings → This PC shows `settings.phoneNotifications` and changes it with `setSettings` (§6); the
  tray menu has the same checkbox. Settings → Devices (any device's switch) stays the page's own, as in a browser.
- **Memory only, on both sides:** no IndexedDB, localStorage, files or cache for titles, texts, lines or replies; the
  `log` message (§4) never carries them. The app logs the app name and the notification id only.

## 11. Remote control (Beam 1.6.0; `features` has `remoteControl`, the server has `remote-control`)

Another of the owner's devices sees this PC's screen and uses its mouse and keyboard over a direct WebRTC connection
through Tailscale; the server only introduces the two (docs/API.md, "Remote control (1.6)"). The Windows app is both
ends: the **PC** (native, plus a hidden capture page of its own) and, in a **viewer window**, the viewer.

### 11.1 This PC (what the chat page needs to know)

- **The switch and the list** are native (§6): the page shows `allowRemoteControl` and `remoteControlDevices`, offers
  "Turn off" (`setSettings({ allowRemoteControl: false })`), and points to the tray menu to turn it on. Other devices
  turn it off with `POST /api/rc/disable`; the app hears `rc-disable`, switches off and reports it.
- **Who:** the app checks every request itself, whatever the server said:
  - its switch is on, and it isn't locked;
  - the viewer is a device of the owner's that is signed in for good, and it's on this PC's list;
  - the app's own `tailscale whois` of the address the request came from names the same Tailscale owner as this PC,
    and the node the device was pinned to when it was ticked;
  - one session at a time.

  A device that isn't on the list is refused with `rc-end` reason `not-listed`: show "This PC doesn't allow control
  from <device>; add it on the PC".
- **No banner, no session.** Before anything else the app shows a top-most banner at the top of the screen,
  "<device> (<machine> · <Tailscale IP>) is controlling this PC · Stop". It's drawn from the device list and the app's
  own whois, ignores clicks for 500 ms and re-asserts itself; closing it is Stop. **Ctrl+Alt+Shift+F12** ends every
  session at once (the banner's tooltip says so). Windows' own "beam-remote-control is sharing your screen" bar also
  shows, at the bottom; its "Stop sharing" ends the session too.
  **1.7.4:** the banner can be dragged anywhere but never off a screen (anything else that moves it off puts it back at
  the top within a second); the next session's banner starts where it was put (`rcBannerSpot` in config.json: Stop's
  centre as fractions of that screen's working area); a double-click puts it back at the top and forgets the spot.
  After 5 s it shrinks to a "Beam · Stop" pill that grows back when the mouse rests on it for 0.4 s; Stop (the right
  end) stays where it is through all of that, and a drag that ends over Stop isn't a click on it.
- **Capture** happens only while a session is on and its banner is up. The gate is `ScreenCaptureStarting` in a
  WebView2 with a profile of its own (`WebView2\RemoteHost`), never shown.
- **Ends:**
  - Stop, the kill switch, or Windows' Stop sharing;
  - the viewer leaving, the server (`rc-end`), or a lease that doesn't get `200` (the app leases every 30 s);
  - the switch turned off, the device taken off the list or removed, signing out;
  - this PC locked (`locked` is in its status; locked PCs are Remote Desktop's job).
- **Input** goes through `SendInput` with scancodes and absolute coordinates. Win+L and the power keys are never
  passed on, and everything held is let go on `release`, at the end, and after 5 s without a pong.
- **The clipboard** (text only, at most 64 KB) is synced only while the viewer has it on. Secret-marked text is never
  sent. Text from the viewer never reaches the cloud clipboard, and stays out of Win+V history when `clipboardHistory`
  is off.
- **beam.log** records who, from which machine, when, for how long and how it ended. It never records keys, text,
  clipboard content, SDP, candidates or session ids.
- **While another device controls this PC, nothing here widens access to Beam.** The viewer could click anything on
  screen, so these are refused ("Stop the remote control session first"):
  - natively: turning remote control on, the device list (tray and Settings), Add a device, approving a sign-in (the
    prompt and the code), Switch server, and `openRemote`;
  - in both windows' pages, the host answers these with `403 { reason: "rc-active" }`:
    - a pairing link or its QR code (`GET /api/pair`, `/api/qr.*`);
    - `POST /api/login-requests/approve`, `POST /api/password`, `PATCH /api/settings`, `DELETE /api/settings/blocked-nodes/*`;
    - `POST /api/security/sign-out-others`, `/api/move`, `/api/admin/*`;
    - `POST /api/rc/sessions` (controlling another PC from this one).

  Turning remote control off, ending sessions, denying sign-ins and everything else stay as they are.

### 11.2 The PC's connection to the viewer (research §8.7, with these rules)

The PC offers: video plus three negotiated data channels, `ctl` (id 0), `in` (id 1) and `mv` (id 2, unordered, no
retransmits).

- **The viewer's side of the signalling:**
  - `iceServers: []`;
  - the strict candidate rewrite, to the PC's attested `host.ip4`/`host.ip6` from the 201 only;
  - candidates in batches of at most 20; `""` ends them.
- **Order.** Nothing flows until the PC's own check of the connection's peer passes. The selected pair's remote
  address must be the address it checked with whois, or that node's other address. A peer-reflexive peer whose
  address stays unreadable is hung up on.
  - Then the PC enables the video and sends `{ t: "hello", v: 1, role: "host", name, monitors: [{ id, name, x, y, w, h,
    primary, scale }], monitor, codec, encoder }`.
  - Input sent before that hello is dropped.
- **Coordinates:** `btn`, `wheel` and `mv` carry physical pixels within monitor `m` (0…w-1, 0…h-1); the PC clamps them.
  `btn` and `wheel` may carry `n`, the last `mv` number sent before them, so that a late `mv` never moves the pointer
  back.
- **Wheel:** the WheelEvent sign (`dy` > 0 scrolls down, `dx` > 0 right). 120 is one notch; fractions add up.
- **Keys:** `{ t: "key", c: KeyboardEvent.code, d }`. Send the events as they come: the PC drops the fake ControlLeft
  that comes just before AltRight (AltGr). `{ t: "text", s }` takes committed text (IME, phone keyboards).
  `{ t: "release" }` lets go of everything.
- **Ping:** both sides send `{ t: "ping", n, at }` every 2 s, and each answers `{ t: "pong", n, at }`.
- **From the PC:**
  - `{ t: "stats", codec, encoder, fps, kbps, w, h, qlr }` every 2 s;
  - `{ t: "state", locked, secure, elevated }` on change (`elevated`: the window in front runs as administrator, so
    input can't reach it; `secure`: a UAC prompt or the lock screen);
  - `{ t: "bye", reason }` before it ends.
- **Clipboard:** `{ t: "clip", on }` from the viewer turns it on or off. While on, `{ t: "clip", n, text }` goes both
  ways.
- **Quality:** `{ t: "quality", mode: "text" | "motion" }` gives 30 fps / 8 Mbps or 60 fps / 16 Mbps. The PC answers
  with the limits it applied (from 1.8 also `profile`: what it applies now, Auto's pick included).
- **1.8, when the PC's hello has `caps` (`fit`, `settings`, `video`) and `fitted`:**
  - `{ t: "settings", mode: "auto" | "text" | "motion" | "saver", size: "auto" | "full" | "1080" | "720" | "window",
    vw, vh, fps: 0 | 15 | 30 | 60, kbps: 0 | 500…100000, codec: "auto" | "av1" | "h264" | "vp9", net: "" | "cellular" }`
    applies at once, on the same connection (a codec change re-offers with the same `o=` id). 0 and `auto` leave it to
    the PC. `vw` × `vh` is the viewer's picture area in physical pixels, zoom included: the picture is sent no
    larger. Auto: sharp text while the screen is still, smooth motion while it's busy, Data saver on mobile data.
  - `{ t: "fit", on: true, w, h, dpr }` fits the PC's screen to the viewer's picture area (physical pixels) and
    scaling: the monitor's best mode, and the display scaling to match; `{ t: "fit", on: false }` puts it back, as
    does the session's end. The PC answers `{ t: "display", monitors, monitor, fitted, note? }` with the new sizes
    (input maps to them; the viewer holds input until it comes, 6 s at most).
  - `{ t: "video", on }`: the viewer can or can't be seen; no frames while it can't.
  - The PC's `stats` add `srcW`, `srcH` (its screen), `down` (how much smaller it's sent), `profile`, `auto`, `maxFps`,
    `maxKbps`, `avail` (the network's estimate, kbps), `lost` (%), `rtt` (ms) and `video`.
- **1.11 (Windows app):**
  - Every video frame carries WebRTC's playout delay 0 (the capture page's sender field trial
    `WebRTC-ForceSendPlayoutDelay/min_ms:0,max_ms:0/`): any Chromium viewer (the phone's WebView, browsers) shows each
    frame as soon as it's whole, holding none back for smoothness, as the Windows viewer's own flag does.
  - `{ t: "path", via: "direct" | "peer-relay" | "relay", lan, relay? }`: how Tailscale reaches the viewer, from the PC's
    own `tailscale status` (the peer's `CurAddr`; `lan`: that address is a private one, the same network; `relay`: the
    relay region, e.g. `"nyc"`). Sent when it changes; asked 2, 10 and 30 s into the session, then every 30 s.
  - (The viewer, web 1.14.2) It measures each frame's way from the PC's screen to its own (requestVideoFrameCallback's
    `expectedDisplayTime - captureTime`) and shows the lag: that plus half the round trip.
- **Screens:** `{ t: "monitor", id }` restarts the capture as a new connection. The new `offer` has a different SDP
  `o=` session id, so the viewer answers it with a fresh RTCPeerConnection. An offer with the same `o=` id is a
  renegotiation on the same connection: an ICE restart (after `restart`, or 3 s of `disconnected`), or a switch to
  H.264 when the PC is on battery or its CPU is the limit.
- **`{ t: "lock" }`** locks the PC (`LockWorkStation`). The session then ends with `locked`.

### 11.3 The viewer window

"Control" (`openRemote`) opens a window of its own on `<server>/#remote=<id>`. It has a WebView2 profile of its own
(`WebView2\RemoteView`, with the WebRTC playout-delay field trial), is signed in like the chat window (cookie +
`beamHost`), and is never suspended. Browser accelerator keys are off, so Ctrl+R, F5 and Ctrl+F reach the page;
`requestFullscreen()` makes the window full screen; `navigator.clipboard` works without a prompt.

`beamHost` there has `window: "remote"` and `features: ["keyboardHook", "fullscreen"]`. Its bridge:

| Page → host | Reply | What the host does |
|---|---|---|
| `hello` | `{ app, window: "remote", version, deviceId, deviceName, device, features }` | Handshake. |
| `keyboardHook { on }` | `{ on }` | While on and the window has the focus, a low-level keyboard hook takes the keys Windows would act on: the Win keys (and everything pressed while one is held), Alt+Tab, Alt+Esc, Alt+Space, Alt+F4, Ctrl+Esc, Ctrl+Shift+Esc, Print Screen. They come as `remoteKey` events instead of DOM events. Every other key reaches the page as usual. Losing the focus lets go of what the hook held (`remoteKey` ups). A reload or a failed page turns it off: the new page asks again. |
| `remoteSession { id }` | `{}` | The page's session id (null when none): closing the window ends it (`stopped`). |
| `closeWindow` | `{}` | Closes the window. |
| `openLink { url }`, `log`, `unauthorized` | | As in §4. |

Host → page: `{ type: "remoteKey", code, down }`, a `KeyboardEvent.code`.

## 12. Beam Family's window (Beam for Windows 1.10.0; `features` has `family`)

The header's ♥ (`openFamily`), the tray's "Beam Family" and `Beam.exe --family` open Beam Family (the address the
server's `/api/info` gives as `family`) in a window of its own, with a WebView2 profile of its own
(`WebView2\Family`): Beam's sign-in cookie never reaches Family (Family is often on Beam's own machine name, on another
port, and cookies don't keep to a port), and Family signs people in itself (Tailscale on the tailnet). The page there
gets no bridge (`chrome.webview` messages go nowhere) and no Beam identity, only
`beamHost = { app: "windows", window: "family", version }` on Family's own origin: Family's page then offers no
notifications, which WebView2 can't get (it has no push service); they stay with the browser and the phone.

- Minimized, the page is hidden (`document.visibilityState`), so Family pushes to the person's other devices and marks
  nothing read meanwhile; restored, it's visible again. Closing the window lets it go; it's made again when opened.
- Links to other sites, and anything opening a window of its own, go to the default browser; downloads are WebView2's
  own (the Downloads folder). Pasting and saving several files are allowed; other permissions are refused.
- An update reopens it (without the focus) when it was open; signing out of Beam, or the sign-in revoked, closes it and
  deletes its profile (the Family sign-in made in it).
