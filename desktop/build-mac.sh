#!/bin/sh
# Builds "Spotify Quiet.app" for Apple Silicon and Intel Macs and zips it for a
# release. Needs the Xcode Command Line Tools (xcode-select --install).
#   sh desktop/build-mac.sh [output-folder]
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$here/../manifest.json")"
out="${1:-$here/build}"
app="$out/Spotify Quiet.app"

mkdir -p "$out"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -target "$arch-apple-macos12.0" -o "$out/launcher-$arch" "$here/mac/main.swift"
done
lipo -create -output "$app/Contents/MacOS/Spotify Quiet" "$out/launcher-arm64" "$out/launcher-x86_64"
rm -f "$out/launcher-arm64" "$out/launcher-x86_64"

sed "s/@VERSION@/$version/g" "$here/mac/Info.plist" > "$app/Contents/Info.plist"
cp "$here/quiet.js" "$here/icon.icns" "$app/Contents/Resources/"

# Signed locally with no certificate, which Apple Silicon needs to run it at all.
codesign --force --sign - "$app"

rm -f "$out/spotify-quiet-mac-$version.zip"
(cd "$out" && ditto -c -k --keepParent "Spotify Quiet.app" "spotify-quiet-mac-$version.zip")
echo "Built $app"
echo "Zipped $out/spotify-quiet-mac-$version.zip"
