# Spotify Quiet

Spotify ad blocker for the web player and the desktop app. Runs on your machine, no proxy or extra accounts.

## web player

Chrome, Opera and Opera GX.

1. Download the ZIP from [releases](https://github.com/dmonskull/spotify-quiet/releases/latest) and extract it.
2. Open `chrome://extensions` in Chrome or `opera://extensions` in Opera / Opera GX. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `spotify-quiet` folder.
4. Reload open.spotify.com. That's it.

Ad breaks still happen, but each ad is swapped for one second of silence. Sponsored cards and banners are hidden. Changes to the toggle need a reload to take effect.

## desktop app

Nothing inside Spotify is modified. The launcher opens Spotify with a local debugging port and switches every ad slot off through the app's own ad settings. Open Spotify the normal way and it's stock again.

macOS:

1. Download `spotify-quiet-mac` from [releases](https://github.com/dmonskull/spotify-quiet/releases/latest) and unzip it.
2. Move **Spotify Quiet** to Applications and open it instead of Spotify.

macOS blocks it the first time because it isn't signed with an Apple developer certificate. Allow it under System Settings → Privacy & Security → **Open Anyway**, or run:

```sh
xattr -dr com.apple.quarantine "/Applications/Spotify Quiet.app"
```

It has no window. It runs while Spotify is open and quits with it.

Windows and Linux (needs [Node 22+](https://nodejs.org), not tested yet):

```sh
node desktop/launch.mjs
```

The port only listens on your computer, but any program on it can reach it while Spotify is open.

## status

Still experimental.

- Web: passes its offline tests in Chrome 157, Opera 139 and Opera GX 138. Not confirmed against a real ad on a free account yet.
- Desktop: tested on Spotify 1.3.8 for macOS (Apple Silicon) with a Premium account. The sponsored home card is gone and every ad slot, podcast ones included, is switched off. Audio ads on a free account haven't been tested yet, and neither has a real Intel Mac.

If something gets through, use **Copy report** in the extension popup. On desktop run the launcher with `--report` (`"/Applications/Spotify Quiet.app/Contents/MacOS/Spotify Quiet" --report`, or `node desktop/launch.mjs --report`). Both hold slot names and timings only, no tokens or account data.

Tests: `node test/desktop.mjs`, and `node test/fixture.mjs` against a browser started with `test/launch.sh`. The Mac app is built with `sh desktop/build-mac.sh`.

Blocking ads is against Spotify's terms. Use at your own risk. Not affiliated with Spotify.
