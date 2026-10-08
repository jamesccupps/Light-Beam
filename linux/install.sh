#!/usr/bin/env bash
# Beam for Linux: puts the Beam app on this computer (a Raspberry Pi, or another Linux computer that stays on), signs it
# in, and runs it as a service that starts with the computer and updates itself. Your Beam serves this script with its
# own address filled in:
#
#   curl -fsSL https://<your Beam>/install/linux | bash
#   curl -fsSL https://<your Beam>/install/linux | bash -s -- --name "Garage Pi"     (the name Beam shows)
#   curl -fsSL https://<your Beam>/install/linux | bash -s -- --uninstall           (takes it away again)
#
# Run it again any time: it updates what's there. It needs Tailscale on this computer, signed in to your tailnet.
# Everything goes into your home folder, as you (never as root): the app in ~/.local/share/beam (with its own Node.js
# when this computer has none from 20 on), the `beam` command in ~/.local/bin, the service in
# ~/.config/systemd/user/beam.service. Only one thing may ask for your password (sudo): letting the service start when
# the computer does, before anyone signs in (loginctl enable-linger).

set -euo pipefail

# (The whole script is one function, run on its last line: bash reads it all first, so a download cut short does
# nothing, and nothing in it reads what's still coming down the pipe.)
main() {
  local beam_url='__BEAM_URL__'
  local app_dir="$HOME/.local/share/beam"
  local bin_dir="$HOME/.local/bin"
  local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  local name='' uninstall=0 service=1 own_node=0 node='' node_arch=''

  while [ $# -gt 0 ]; do
    case "$1" in
      --name) name="${2:-}"; shift 2 || shift ;;
      --name=*) name="${1#--name=}"; shift ;;
      --uninstall) uninstall=1; shift ;;
      --no-service) service=0; shift ;; # (tests, and computers without systemd: run `beam agent` yourself)
      --own-node) own_node=1; shift ;;  # (tests: Beam's own Node.js even when this computer has one)
      -h|--help) sed -n '2,15p' "$0" 2>/dev/null || true; return 0 ;;
      *) fail "I don't know the option $1 (there's --name \"…\" and --uninstall)" ;;
    esac
  done

  [ "$(uname -s)" = Linux ] || fail "this installer is for Linux. Windows and Android have Beam apps of their own (Settings → Add a device)."
  [ "$(id -u)" != 0 ] || fail "run it as yourself, not as root or with sudo: Beam for Linux lives in your home folder."
  case "$beam_url" in http://*|https://*) ;; *) fail "this copy of the installer doesn't know your Beam's address: get it from your Beam (Settings → Add a device)." ;; esac

  if [ "$uninstall" = 1 ]; then
    if has systemctl; then
      systemctl --user disable --now beam.service >/dev/null 2>&1 || true
      rm -f "$unit_dir/beam.service"
      systemctl --user daemon-reload >/dev/null 2>&1 || true
    fi
    if [ -f "$bin_dir/beam" ] && grep -q 'Beam for Linux' "$bin_dir/beam"; then rm -f "$bin_dir/beam"; fi
    rm -rf "$app_dir"
    say "Beam for Linux is off this computer. Still here: its sign-in (~/.beam.json), what it received (~/Downloads/Beam)"
    say "and its log (~/.local/state/beam). To sign it out of Beam too, remove the device there (its Device info)."
    return 0
  fi

  has curl || fail "curl is needed (sudo apt install curl)"
  case "$(dpkg --print-architecture 2>/dev/null || uname -m)" in
    arm64|aarch64) node_arch=arm64 ;;
    armhf|armv7l) node_arch=armv7l ;;
    amd64|x86_64) node_arch=x64 ;;
    *) node_arch='' ;;
  esac

  # Node.js: this computer's own from version 20 on, else one of Beam's own from nodejs.org (checked against the
  # checksums nodejs.org publishes), kept with the app.
  if [ -x "$app_dir/node/bin/node" ] && node_ok "$app_dir/node/bin/node"; then
    node="$app_dir/node/bin/node"
  elif [ "$own_node" = 0 ] && has node && node_ok "$(command -v node)"; then
    node="$(command -v node)"
  else
    [ -n "$node_arch" ] || fail "Beam for Linux needs Node.js 20 or later, and nodejs.org has none for this computer ($(uname -m)): install one, then run this again."
    get_node "$app_dir" "$node_arch"
    node="$app_dir/node/bin/node"
  fi

  say "Getting Beam for Linux from $beam_url…"
  mkdir -p "$app_dir" "$bin_dir"
  # (a CommonJS script, whatever a package.json further up says; beam.new.js: Node.js checks only a file it can tell is
  # a script)
  printf '{ "type": "commonjs" }\n' > "$app_dir/package.json"
  curl -fsSL --retry 2 "$beam_url/install/linux/beam.js" -o "$app_dir/beam.new.js" \
    || fail "couldn't get it from $beam_url (is Tailscale on and signed in here? tailscale status)"
  "$node" --check "$app_dir/beam.new.js" || fail "what came from $beam_url isn't Beam for Linux"
  mv -f "$app_dir/beam.new.js" "$app_dir/beam.js"
  cat > "$bin_dir/beam" <<EOF
#!/bin/sh
# Beam for Linux (made by Beam's installer: $beam_url/install/linux)
exec "$node" "$app_dir/beam.js" "\$@"
EOF
  chmod 755 "$bin_dir/beam"
  local beam="$bin_dir/beam"

  # Signed in already (to this Beam)? Else: Tailscale signs it in, or it shows a code to approve on another device.
  if signed_in "$node" "$beam_url" && BEAM_APP=linux "$beam" status >/dev/null 2>&1 </dev/null; then
    say "Signed in already."
  else
    say "Signing in to Beam…"
    if [ -n "$name" ]; then
      BEAM_APP=linux "$beam" login "$beam_url" --name "$name" </dev/null || fail "it didn't sign in (run this again to try once more)"
    else
      BEAM_APP=linux "$beam" login "$beam_url" </dev/null || fail "it didn't sign in (run this again to try once more)"
    fi
  fi

  if [ "$service" = 0 ]; then
    say "Installed. Start it with:  $beam agent"
    return 0
  fi
  if ! has systemctl || ! systemctl --user show-environment >/dev/null 2>&1; then
    say "Installed, but this computer has no systemd user service manager to keep it running."
    say "Start it with  $beam agent  (and have something start that when the computer does)."
    return 0
  fi
  mkdir -p "$unit_dir"
  cat > "$unit_dir/beam.service" <<EOF
# Beam for Linux (made by Beam's installer: $beam_url/install/linux)
[Unit]
Description=Beam for Linux: receives what you send it, says how this computer is, updates itself

[Service]
ExecStart="$beam" agent
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable beam.service >/dev/null 2>&1 || fail "systemd didn't take the service (systemctl --user enable beam)"
  systemctl --user restart beam.service
  # Start with the computer, before anyone signs in on it.
  if [ "$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || true)" != yes ]; then
    loginctl --no-ask-password enable-linger "$(id -un)" >/dev/null 2>&1 \
      || { say "Letting Beam start with the computer (sudo may ask for your password)…"; sudo loginctl enable-linger "$(id -un)" </dev/tty; } \
      || say "Beam couldn't be set to start before you sign in (sudo loginctl enable-linger $(id -un)): it starts when you sign in."
  fi
  sleep 3
  if systemctl --user is-active --quiet beam.service; then
    say ""
    say "Beam for Linux $("$beam" version) is on, and starts by itself with this computer."
    say "  Files sent to it are saved in ~/Downloads/Beam. Send from here:  beam <file>   or   some-command | beam"
    say "  Its page in Beam shows how it's doing (Device info). Its log: ~/.local/state/beam/beam.log"
    say "  Stop it: systemctl --user stop beam   ·   Take it away: curl -fsSL $beam_url/install/linux | bash -s -- --uninstall"
    case ":$PATH:" in *":$bin_dir:"*) ;; *) say "  (Open a new terminal for the beam command, or run it as $beam.)" ;; esac
  else
    say "The service didn't stay on. What it said:"
    tail -n 20 "${XDG_STATE_HOME:-$HOME/.local/state}/beam/beam.log" 2>/dev/null \
      || journalctl --user -u beam.service -n 20 --no-pager 2>/dev/null || systemctl --user status beam.service --no-pager || true
    return 1
  fi
}

say() { printf '%s\n' "$*"; }
fail() { printf 'Beam: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

node_ok() { "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; }

# The newest Node.js 24 from nodejs.org (22 for a 32-bit ARM system: 24 has no build for one), checked against its
# SHASUMS256.txt, into <app dir>/node.
get_node() {
  local app_dir="$1" arch="$2" base='https://nodejs.org/dist/latest-v24.x' tmp file
  [ "$arch" != armv7l ] || base='https://nodejs.org/dist/latest-v22.x'
  has tar || fail "tar is needed to unpack Node.js"
  has sha256sum || fail "sha256sum is needed to check Node.js"
  say "Getting Node.js (Beam for Linux runs on it; this computer has none from version 20 on) from nodejs.org…"
  tmp="$(mktemp -d)"
  curl -fsSL --retry 2 "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || { rm -rf "$tmp"; fail "couldn't reach nodejs.org"; }
  file="$(grep -oE "node-v[0-9]+\.[0-9]+\.[0-9]+-linux-$arch\.tar\.gz" "$tmp/SHASUMS256.txt" | head -n 1 || true)"
  [ -n "$file" ] || { rm -rf "$tmp"; fail "nodejs.org has no Node.js for this computer ($arch): install Node.js 20 or later, then run this again"; }
  curl -fsSL --retry 2 "$base/$file" -o "$tmp/$file" || { rm -rf "$tmp"; fail "couldn't download $file"; }
  (cd "$tmp" && grep "  $file\$" SHASUMS256.txt | sha256sum -c --status -) || { rm -rf "$tmp"; fail "$file didn't match the checksum nodejs.org gives"; }
  rm -rf "$app_dir/node.new"
  mkdir -p "$app_dir/node.new"
  tar -xzf "$tmp/$file" -C "$app_dir/node.new" --strip-components=1 || { rm -rf "$tmp" "$app_dir/node.new"; fail "couldn't unpack $file"; }
  rm -rf "$tmp" "$app_dir/node"
  mv "$app_dir/node.new" "$app_dir/node"
  say "Node.js $("$app_dir/node/bin/node" --version) is in $app_dir/node."
}

# ~/.beam.json signs in to this Beam (the address the installer came from).
signed_in() {
  [ -f "$HOME/.beam.json" ] || return 1
  "$1" -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(c.key && c.url === process.argv[2] ? 0 : 1)' "$HOME/.beam.json" "$2" >/dev/null 2>&1
}

main "$@"
