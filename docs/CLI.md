# Command line and iPhone Shortcuts

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
beam Photos/                           # a folder goes as Photos.zip (1.5.0)
beam -t "hello" --to Laptop,Desktop    # send text
git diff | beam --to Desktop           # send piped text
beam clip --to Laptop                  # send what's on the clipboard
beam get                               # latest text sent to this computer → clipboard (--no-copy: just print it)
beam pull                              # latest file sent to this computer → Downloads/Beam
beam ls                                # recent items to and from this computer, with their ids
beam get 3fa9c1 / beam pull 3fa9c1     # that text or file instead of the latest
beam rm 3fa9c1                         # delete an item (the start of its id is enough)
beam approve K7QM-4R2X                 # let a new device in
beam status                            # server, sign-in and storage details
beam ls --json                         # (also devices and status) for scripts
beam listen                            # stay connected: text → clipboard, files → Downloads/Beam
                                       # (catches up on what arrived while it wasn't running)
beam logout                            # sign this computer out (beam login signs it in again)
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
