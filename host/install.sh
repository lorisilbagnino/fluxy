#!/usr/bin/env bash
# Registers the Fluxy native messaging host for Chromium- and Firefox-based browsers
# and offers to install its dependencies (ffmpeg, yt-dlp).
#   ./install.sh [extension-id]       ./install.sh --uninstall
# The extension can also generate a self-contained copy of this script (⚙ → Motore → Installa):
# it sets FLUX_HOST_PATH / FLUX_EXT_ID / FLUX_GECKO_ID before this code runs.
set -euo pipefail

NAME="com.fluxy.host"

# Messages in Italian when the system language is Italian, English otherwise.
case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in it*) IT=1 ;; *) IT=0 ;; esac
say() { if [[ $IT == 1 ]]; then echo "$2"; else echo "$1"; fi; }   # say "english" "italiano"
LEGACY_NAMES=("com.fluxcapacitor.host")   # earlier name of the project: removed on install/uninstall
ARG="${1:-}"
[[ "$ARG" == --* ]] && ARG=""
EXT_ID="${ARG:-${FLUX_EXT_ID:-kipokjinmlcebonicoplnakgedbnlgjo}}"   # Chromium: fixed by the "key" in manifest.json
GECKO_ID="${FLUX_GECKO_ID:-fluxy@fluxy-downloader.addon}"    # Firefox: browser_specific_settings.gecko.id
HOST_PATH="${FLUX_HOST_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fluxy_host.py}"

if [[ "$(uname -s)" == Darwin ]]; then
  APP="$HOME/Library/Application Support"
  # <browser user-data-dir>/NativeMessagingHosts
  DIRS=(
    "$APP/BraveSoftware/Brave-Origin" "$APP/BraveSoftware/Brave-Browser"
    "$APP/Google/Chrome" "$APP/Chromium" "$APP/Vivaldi" "$APP/Microsoft Edge"
  )
  FF_DIRS=(
    "$APP/Mozilla/NativeMessagingHosts|firefox|$APP/Firefox"
    "$APP/LibreWolf/NativeMessagingHosts|librewolf|$APP/LibreWolf"
  )
else
  CFG="${XDG_CONFIG_HOME:-$HOME/.config}"
  DIRS=(
    "$CFG/BraveSoftware/Brave-Origin" "$CFG/BraveSoftware/Brave-Origin-Beta" "$CFG/BraveSoftware/Brave-Origin-Nightly"
    "$CFG/BraveSoftware/Brave-Browser" "$CFG/google-chrome" "$CFG/chromium" "$CFG/vivaldi" "$CFG/microsoft-edge"
  )
  # Firefox-family: "<manifest dir>|<command>|<profile roots...>"
  # Firefox reads user-level hosts from ~/.mozilla/native-messaging-hosts even when
  # its profiles live in ~/.config/mozilla (XDG layout). Creating that folder is
  # safe: Firefox picks the profile root by looking at ~/.mozilla/firefox.
  FF_DIRS=(
    "$HOME/.mozilla/native-messaging-hosts|firefox|$HOME/.mozilla $CFG/mozilla"
    "$CFG/mozilla/native-messaging-hosts|firefox|$CFG/mozilla"
    "$HOME/.librewolf/native-messaging-hosts|librewolf|$HOME/.librewolf"
    "$HOME/.waterfox/native-messaging-hosts|waterfox|$HOME/.waterfox"
  )
fi

remove_manifests() {
  for n in "$@"; do
    for d in "${DIRS[@]}"; do rm -f "$d/NativeMessagingHosts/$n.json"; done
    for e in "${FF_DIRS[@]}"; do rm -f "${e%%|*}/$n.json"; done
  done
}
remove_manifests "${LEGACY_NAMES[@]}"

if [[ "${1:-}" == "--uninstall" ]]; then
  remove_manifests "$NAME"
  [[ -n "${FLUX_DEST:-}" ]] && rm -rf "$FLUX_DEST"
  say "Local app removed." "App locale rimossa."
  exit 0
fi

command -v python3 >/dev/null || { say "python3 is required: install it with your package manager and run this again." "Serve python3: installalo con il gestore pacchetti del sistema e riesegui."; exit 1; }
chmod +x "$HOST_PATH"

# ---- dependencies --------------------------------------------------------
ask() {  # ask "question" -> 0 if yes (default yes); never asks without a terminal
  [[ -t 0 ]] || return 1
  local r; read -r -p "$1 [$( [[ $IT == 1 ]] && echo S/n || echo Y/n )] " r; [[ -z "$r" || "$r" =~ ^[sSyY] ]]
}
runnable() { [[ "$1" =~ ^(sudo|brew|nix-env|pipx|python3|winget)\  ]]; }
doctor_field() { python3 -c 'import json,sys; v=json.load(sys.stdin).get(sys.argv[1]); print(" ".join(v) if isinstance(v,list) else (v or ""))' "$1"; }

report="$(python3 "$HOST_PATH" doctor)"
missing="$(doctor_field missing <<< "$report")"
if [[ -n "$missing" ]]; then
  cmd="$(doctor_field tools <<< "$report")"
  say "Missing: $missing" "Mancano: $missing"
  if runnable "$cmd" && ask "$(say "Install them now with: $cmd ?" "Li installo ora con: $cmd ?")"; then
    eval "$cmd" || say "Installation failed: install them manually and restart the browser." "Installazione non riuscita: installali a mano e riavvia il browser."
    report="$(python3 "$HOST_PATH" doctor)"
  else
    say "To install them: $cmd" "Per installarli: $cmd"
  fi
fi
crypto="$(doctor_field cryptodome <<< "$report")"
if [[ -n "$crypto" ]]; then
  say "yt-dlp can't find pycryptodomex: encrypted streams will download more slowly." "yt-dlp non trova pycryptodomex: gli stream cifrati verranno scaricati più lentamente."
  if runnable "$crypto" && ask "$(say "Install it now with: $crypto ?" "Lo installo ora con: $crypto ?")"; then
    eval "$crypto" || say "Installation failed." "Installazione non riuscita."
  else
    say "To install it: $crypto" "Per installarlo: $crypto"
  fi
fi

# ---- registration --------------------------------------------------------
manifest() {  # manifest <file> <"allowed_origins"|"allowed_extensions"> <value>
  python3 - "$@" "$HOST_PATH" "$NAME" <<'PYEOF'
import json, sys
path, key, value, host, name = sys.argv[1:6]
with open(path, "w", encoding="utf-8") as fh:
    json.dump({"name": name, "description": "Fluxy native host", "path": host,
               "type": "stdio", key: [value]}, fh, indent=2)
PYEOF
}

installed=0
for d in "${DIRS[@]}"; do
  [[ -d "$d" ]] || continue
  mkdir -p "$d/NativeMessagingHosts"
  manifest "$d/NativeMessagingHosts/$NAME.json" allowed_origins "chrome-extension://$EXT_ID/"
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
  manifest "$d/$NAME.json" allowed_extensions "$GECKO_ID"
  echo "✓ $d/$NAME.json"
  installed=1
done

[[ $installed == 1 ]] || { say "No compatible browser found." "Nessun browser compatibile trovato."; exit 1; }
echo
say "Done. Program: $HOST_PATH" "Fatto. Programma: $HOST_PATH"
say "Allowed extensions: chrome-extension://$EXT_ID (Chromium), $GECKO_ID (Firefox)" "Estensioni autorizzate: chrome-extension://$EXT_ID (Chromium), $GECKO_ID (Firefox)"
say "Go back to the Fluxy popup and press “verify”." "Torna al popup di Fluxy e premi “verifica”."
