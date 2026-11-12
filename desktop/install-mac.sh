#!/bin/sh
# Makes "Spotify Quiet.app" in ~/Applications (or the folder given as the first
# argument). Opening that app starts Spotify through launch.mjs, so use it in
# place of the Spotify icon. Run this again if you move this folder.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
node="$(command -v node || true)"
[ -n "$node" ] || { echo "Node 22 or newer is needed. Install it from nodejs.org and run this again." >&2; exit 1; }
"$node" -e 'process.exit(typeof WebSocket === "function" ? 0 : 1)' || { echo "Node 22 or newer is needed (found $("$node" --version))." >&2; exit 1; }

dest="${1:-$HOME/Applications}"
app="$dest/Spotify Quiet.app"
mkdir -p "$dest" "$HOME/Library/Logs"
if [ -e "$app" ]; then
  # Only replace an app this script made earlier.
  [ -f "$app/Contents/Resources/spotify-quiet" ] || { echo "$app exists and was not made by this script. Move it away first." >&2; exit 1; }
  rm -rf "$app"
fi

source="$(mktemp -t spotify-quiet).applescript"
cat > "$source" <<SCRIPT
set nodePath to "$node"
set launcher to "$here/launch.mjs"
do shell script quoted form of nodePath & " " & quoted form of launcher & " > " & quoted form of (POSIX path of (path to home folder) & "Library/Logs/spotify-quiet.log") & " 2>&1 &"
SCRIPT
osacompile -o "$app" "$source"
rm -f "$source"
# A marker so a later run knows this app is ours to replace.
echo "$here" > "$app/Contents/Resources/spotify-quiet"
if [ -f "$here/icon.icns" ]; then
  cp "$here/icon.icns" "$app/Contents/Resources/applet.icns"
  # The icon changed the app after it was made, so sign it again (locally, no certificate).
  codesign --force --sign - "$app" 2>/dev/null || true
  touch "$app"
fi
echo "Made $app"
echo "Open it instead of Spotify. Its log is ~/Library/Logs/spotify-quiet.log"
