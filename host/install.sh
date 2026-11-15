#!/usr/bin/env bash
# Registers the Flux Capacitor native messaging host for Chromium- and Firefox-based browsers.
# Usage: ./install.sh [extension-id]      (uninstall: ./install.sh --uninstall)
set -euo pipefail

NAME="com.fluxcapacitor.host"
EXT_ID="${1:-kipokjinmlcebonicoplnakgedbnlgjo}"   # Chromium: fixed by the "key" in manifest.json
GECKO_ID="flux-capacitor@fluxcapacitor.local"   # Firefox: browser_specific_settings.gecko.id (build.py)
HOST_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/flux_host.py"

# User-level NativeMessagingHosts dir = <browser user-data-dir>/NativeMessagingHosts
DIRS=(
  "$HOME/.config/BraveSoftware/Brave-Origin"
  "$HOME/.config/BraveSoftware/Brave-Origin-Beta"
  "$HOME/.config/BraveSoftware/Brave-Origin-Nightly"
  "$HOME/.config/BraveSoftware/Brave-Browser"
  "$HOME/.config/google-chrome"
  "$HOME/.config/chromium"
  "$HOME/.config/vivaldi"
  "$HOME/.config/microsoft-edge"
)

# Firefox-family browsers: <dir>/<name>.json with "allowed_extensions"
# Firefox reads user-level hosts from ~/.mozilla/native-messaging-hosts even when
# its profiles live in ~/.config/mozilla (XDG layout). Creating that folder is
# safe: Firefox picks the profile root by looking at ~/.mozilla/firefox.
# The XDG path is written too, for versions that look there.
FF_DIRS=(
  "$HOME/.mozilla/native-messaging-hosts|firefox|$HOME/.mozilla|${XDG_CONFIG_HOME:-$HOME/.config}/mozilla"
  "${XDG_CONFIG_HOME:-$HOME/.config}/mozilla/native-messaging-hosts|firefox|${XDG_CONFIG_HOME:-$HOME/.config}/mozilla"
  "$HOME/.librewolf/native-messaging-hosts|librewolf|$HOME/.librewolf"
  "$HOME/.waterfox/native-messaging-hosts|waterfox|$HOME/.waterfox"
)

if [[ "${1:-}" == "--uninstall" ]]; then
  for d in "${DIRS[@]}"; do rm -f "$d/NativeMessagingHosts/$NAME.json"; done
  for e in "${FF_DIRS[@]}"; do rm -f "${e%%|*}/$NAME.json"; done
  echo "Host rimosso."
  exit 0
fi

for tool in python3 ffmpeg ffprobe yt-dlp; do
  command -v "$tool" >/dev/null || echo "ATTENZIONE: '$tool' non trovato nel PATH: installalo con il gestore pacchetti del sistema"
done

chmod +x "$HOST_PATH"
installed=0
for d in "${DIRS[@]}"; do
  [[ -d "$d" ]] || continue
  mkdir -p "$d/NativeMessagingHosts"
  cat > "$d/NativeMessagingHosts/$NAME.json" <<EOF
{
  "name": "$NAME",
  "description": "Flux Capacitor native host",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
  echo "✓ $d/NativeMessagingHosts/$NAME.json"
  installed=1
done

for e in "${FF_DIRS[@]}"; do
  IFS='|' read -r d cmd roots <<< "$e"
  present=0
  command -v "$cmd" >/dev/null && present=1
  for r in $roots; do [[ -d "$r" ]] && present=1; done
  [[ $present == 1 ]] || continue
  mkdir -p "$d"
  cat > "$d/$NAME.json" <<EOF
{
  "name": "$NAME",
  "description": "Flux Capacitor native host",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_extensions": ["$GECKO_ID"]
}
EOF
  echo "✓ $d/$NAME.json"
  installed=1
done

[[ $installed == 1 ]] || { echo "Nessun browser compatibile trovato."; exit 1; }
echo "Fatto. Estensioni autorizzate: chrome-extension://$EXT_ID (Chromium), $GECKO_ID (Firefox)"
