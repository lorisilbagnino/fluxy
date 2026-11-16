# Fluxy

> Three streams, one file.

*[Italiano](README.it.md)*

Browser extension for Chromium and Firefox (tested on **Brave Origin 157** and **Firefox 160**) that detects the **HLS**
and **DASH** streams loaded by web pages, lets you pick the video quality, audio tracks and subtitles, and saves them
as **one MKV or MP4 without re-encoding**. Interface in English and Italian (it follows the browser's language).

<p align="center"><img src="docs/store/images/en/promo-marquee-1400x560.png" alt="Fluxy" width="100%"></p>

<table>
<tr>
<td width="50%"><img src="docs/store/images/en/screenshot-1-popup.png" alt="Pick video quality, audio languages and subtitles"><br><sub>Pick video quality, audio languages and subtitles</sub></td>
<td width="50%"><img src="docs/store/images/en/screenshot-2-three-streams.png" alt="Three streams, one file — no re-encoding"><br><sub>Three streams, one file — no re-encoding</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/store/images/en/screenshot-3-how-it-works.png" alt="Detect, choose, download"><br><sub>Detect, choose, download</sub></td>
<td width="50%"><img src="docs/store/images/en/screenshot-4-engines.png" alt="All in the browser, or with the local app"><br><sub>All in the browser, or with the local app</sub></td>
</tr>
</table>

## Two engines (⚙ → Engine)

| | **All in the browser** (default) | **Local app** |
|---|---|---|
| To install | nothing | `fluxy_host.py` + ffmpeg + yt-dlp (*Install local app* button) |
| Formats | HLS (incl. AES-128, "packed" AAC/AC3/E-AC3 audio, `EXT-X-BYTERANGE`) | HLS, DASH, pages supported by yt-dlp (YouTube…) |
| Merging | [Mediabunny](https://mediabunny.dev) (MPL-2.0), packet copy | `ffmpeg -c copy` |
| Saves to | the browser's Downloads folder | a folder of your choice |
| Subtitles in MP4 | `.srt` files next to the video | `mov_text` track |

DASH streams and yt-dlp pages always use the local app: if it's missing, the popup offers to install it.

## GitHub builds and store builds

| | GitHub release (`chromium`, `firefox`) | Stores (`chrome-store`, `firefox-store`) |
|---|---|---|
| YouTube | yes: on YouTube pages the popup offers *Analyse with yt-dlp* (local app) | no: YouTube is ignored (Chrome Web Store policy) |
| Chromium ID | fixed through the manifest `key` | assigned by the store |

The difference is a single generated file, `build-flags.js` (`STORE_BUILD`, `DONATE_URL`).

## Architecture

```
extension/
  background.js   detects .m3u8/.mpd + the page's headers (Referer, Origin, Cookie…), analyses HLS,
                  dispatches downloads to the chosen engine, saves through the downloads API
  engine/         in-browser engine
    hls.js          master/media playlist analysis (same output as fluxy_host.py)
    net.js          fetch with retries and a shared connection limit
    engine.js       segments → OPFS (AES-128 via WebCrypto), WebVTT subtitles, merging with Mediabunny
    runner.js       one job: download → merge → file ready to save; OPFS cleanup
    i18n.js         engine strings (the offscreen document has no chrome.i18n)
  offscreen.*     Chromium: hidden document running runner.js (the service worker may be stopped)
                  Firefox: runner.js runs in the background page, kept awake during downloads
  popup.*         stream choice, download queue, settings, local app installation
  _locales/       en, it (generated from tools/messages.py)
host/
  fluxy_host.py   local app (native messaging, stdlib only): DASH and page analysis (yt-dlp), downloads with
                  yt-dlp, merging with ffmpeg; `fluxy_host.py doctor` tells what's missing and how to install it
  install.sh      registers the app in the browsers and offers to install ffmpeg/yt-dlp (Linux and macOS)
tools/messages.py UI strings (English + Italian)
```

The page's headers (Referer, Origin, Cookie, Authorization) are added to the extension's own requests through
`declarativeNetRequest` session rules, limited to the stream's hosts and removed when the download ends.

## Languages

Texts live in `tools/messages.py` (one entry per key: English, Italian); the build writes
`extension/_locales/{en,it}/messages.json`. The browser picks the language of its own UI and falls back to English.
The local app and the installer follow the same language (the extension passes it to the app; the installer reads
`LANG`). To add a language: add a column to the table and a locale to `write()`.

## Build

```bash
./build.py                              # DONATE_URL= ./build.py  builds without the Ko-fi link
```

| Target | Unpacked | Archive |
|---|---|---|
| Brave, Chrome, Chromium, Edge, Vivaldi… | `dist/chromium/` | `fluxy-<ver>-chromium.zip` |
| Firefox, LibreWolf, Waterfox | `dist/firefox/` | `fluxy-<ver>-firefox.xpi` |
| Chrome Web Store, Edge Add-ons | `dist/chrome-store/` | `fluxy-<ver>-chrome-store.zip` |
| addons.mozilla.org | `dist/firefox-store/` | `fluxy-<ver>-firefox-store.xpi` |

`extension/` is the source (Chromium manifest) and can be loaded directly after running `./build.py` once (it writes
`_locales/` and copies the local app into `extension/native/` for the *Install local app* button).

## Releases

On every push to `main`, `.github/workflows/release.yml` reads `version` from `extension/manifest.json`: if release
`vX.Y.Z` doesn't exist yet, it runs `build.py` and publishes it with the packages, the local app
(`fluxy_host.py`, `install.sh`) and the install instructions from `docs/release-notes.md`. Bump the version to publish
a new release; it can also be started by hand from *Actions → Build e release*.

- Firefox only installs Mozilla-signed packages permanently: with the repository secrets `AMO_JWT_ISSUER` and
  `AMO_JWT_SECRET` (addons.mozilla.org API keys) the workflow signs the `.xpi` as an *unlisted* add-on.
- Chromium doesn't install `.crx` files from outside the Web Store: load the zip in developer mode.
- The repository variable `DONATE_URL` (e.g. the Ko-fi page) is used by the release builds.

## Stores

Listing texts (EN/IT), permission justifications, reviewer notes and checklist: `docs/store/listing.md`.
Privacy policy: `docs/PRIVACY.md`. Images (1280×800 screenshots and promo tiles, English and Italian) in
`docs/store/images/{en,it}/`, rendered from the HTML sources in `docs/store/src/` with `node docs/store/render.mjs`.

## Installation

1. Load the extension:
   - **Chromium/Brave**: `brave://extensions` → *Developer mode* → *Load unpacked* → `dist/chromium/`. The ID is fixed
     (`kipokjinmlcebonicoplnakgedbnlgjo`) by the manifest `key`.
   - **Firefox**: `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → `dist/firefox/manifest.json`. It
     stays loaded until Firefox closes: for a permanent install the `.xpi` must be signed by Mozilla (see Releases),
     or use Firefox Developer Edition/Nightly with `xpinstall.signatures.required = false`.
2. Done: the in-browser engine needs nothing else.
3. Optional, for DASH, YouTube or saving with ffmpeg to a folder of your choice: ⚙ → *Local app* →
   **Install local app**. The extension saves `fluxy-install.sh` (the app plus this extension's ID) to Downloads and
   shows the command to run:
   ```bash
   bash ~/Downloads/fluxy-install.sh            # remove: … --uninstall
   ```
   It copies the app to `~/.local/share/fluxy/` (macOS: `~/Library/Application Support/fluxy/`), registers it in the
   browsers it finds and, if ffmpeg/yt-dlp/pycryptodomex are missing, offers the right command for the system
   (pacman, apt, dnf, zypper, apk, nix, brew; pipx/pip if yt-dlp comes from there). Then press *verify* in the popup.
   From the repository you can run `./host/install.sh` directly.

Firefox note: the local app must be registered in `~/.mozilla/native-messaging-hosts` even when profiles live in
`~/.config/mozilla` (checked on Firefox 160). Creating that folder is safe: Firefox picks the profile root by looking
at `~/.mozilla/firefox`.

## Detection: manual or automatic

**Without playing anything.** Every time the popup opens, Fluxy reads the active tab (`extension/scanner.js`, all
frames, read-only) and lists the videos that can be saved right away:

| Found in the page | Result |
|---|---|
| `<video>` / `<source>` files, links to `.mp4`/`.webm`/…, `og:video`, JSON-LD `VideoObject` | direct file: choose the quality, saved as is (parallel ranged download when the server allows it) |
| `.m3u8`/`.mpd` URLs in the player's configuration (inline scripts, `data-*` attributes) | stream card, analysed as usual |
| iframes of YouTube, Vimeo, Dailymotion, Twitch… | *Analyse with yt-dlp* (local app) |
| videos played through MSE (`blob:`) or DRM | a hint: press *Detect* and start the video / protected |

Everything lands in one list, *Videos on this page*: streams first, then the visible, bigger and longer videos, then
embedded players. Background loops, muted autoplay previews and very short or tiny clips are folded into *Other
videos*. A player that builds its video URL only when you press play is still found by *Detect*.

- **Manual (default)**: the extension doesn't watch the network until you press *Detect* on a tab; from then on it
  listens to that tab only (also after navigating) until you press *stop* or close it. The page is reloaded because
  the player has usually fetched its playlist before you open the popup.
- **Automatic** (⚙ → *Automatic detection on all tabs*): watches every tab's requests and analyses each stream right
  away. Handy, but it wakes the service worker on every network request.
- **YouTube** (GitHub build): it exposes no standard playlist; the popup shows *Analyse with yt-dlp*, which hands the
  page to the local app.

If you register the app from the repository with `./host/install.sh` and then move the folder, run the script again
(the host manifest holds the absolute path). To remove: `./host/install.sh --uninstall`.

## Usage

- **Video**: the highest quality is preselected. "audio included" = that variant already carries audio.
- **Audio / Subtitles**: the preferred languages are preselected (⚙ → *Preferred languages*, default: the browser's
  language and English), one audio track per language.
- **Subtitles only**: each subtitle row has an **.srt** link that saves just that track; with no video and no audio
  selected, *Download* saves every selected subtitle as its own `.srt` ("Film.it.srt", "Film.it.forced.srt", …),
  timed from the start of the video.
- **MKV** (recommended) takes everything. **MP4**: subtitles as `.srt` next to the video (in-browser engine) or
  `mov_text` (local app).
- In-browser engine: segments are written to the extension's private storage (OPFS), merged, and the final file is
  handed to the browser's download manager; about **2× the film's size** of disk space is needed meanwhile. The
  extension checks the available space before starting.
- Local app: the file is written to a temporary `.flux-<id>` folder inside the destination and moved at the end.

## Downloads: pause, resume, retry

- **Pause / resume**: in-browser engine, the fetches stop and the segments already written stay in OPFS; resume
  continues from the first missing one (direct files: from the last 8 MB piece). Local app: the running tool (yt-dlp
  or ffmpeg) is suspended (`SIGSTOP`) and resumed. Not available while saving.
- **Retry** (failed or cancelled downloads): continues from what was already downloaded (in-browser: the OPFS data
  kept after the error; local app: the `.flux-<id>` folder, with finished tracks marked `tN.done`). Stream links
  often carry short-lived tokens, so the track URLs are renewed first: from a newer detection of the same page
  (after *Detect*) or by analysing the original playlist again. The local app also retries subtitles 3 times on
  its own.
- **The Fluxy page** (⤢ in the popup header, always there) has three tabs: *Downloads* (every job with video
  quality, each audio track, each subtitle, engine, source page, destination, start time, retries and the same
  actions), *Settings* (the same form as the popup, kept in sync) and *About* (GitHub, releases, issues, license,
  credits, Ko-fi). The popup lists active, paused and failed downloads plus the latest finished ones, each with a
  one-line summary (*1080p · audio IT, EN · sub IT*).
- **Persistent history**: downloads are kept across browser restarts; one left running when the browser closed is
  marked *interrupted* and can be retried. *Clear history* (asks twice) or *remove* a single entry; saved files are
  never touched. The history keeps the latest 300 finished downloads.
- **Rename while downloading** (✎): the name is used only when the file is saved, so it can change until then
  (local app: until the merge finishes).
- Removing a paused or failed download deletes its staged data.

## Debug

- Analysis from a terminal: `./host/fluxy_host.py probe "<url.m3u8>" "Referer: https://…"`
- Local app log: `~/.cache/fluxy/host.log` (cookies and Authorization redacted)
- Popup as a normal page: `chrome-extension://kipokjinmlcebonicoplnakgedbnlgjo/popup.html?tab=<tabId>`
- Service worker console: `brave://extensions` → Fluxy → *service worker*; in-browser engine: *offscreen.html* on the
  same page. Firefox: `about:debugging` → *Inspect*.

## Supported systems

- **In-browser engine**: wherever the browser runs (Linux, macOS, Windows).
- **Local app**: Linux supported and tested (CachyOS, Brave Origin and Firefox); the installer has the macOS paths,
  not tested yet. Windows: not yet (registry, `.bat` wrapper, `explorer` for "open folder").

## Known limits

- DRM-protected content (Widevine/PlayReady/FairPlay, SAMPLE-AES) is recognised and **not** downloaded. Standard HLS
  AES-128 is supported by both engines.
- In-browser engine: streams with timestamp jumps (`EXT-X-DISCONTINUITY`, typical of inserted ads) are not realigned;
  no DASH (use the local app).
- HLS audio playlists don't declare a bitrate: progress estimates are approximate.
- For DASH and YouTube, yt-dlp groups subtitles by language: two tracks with the same language can't be told apart.
- URLs with expiring tokens should be downloaded soon after detection (reload the page if they expire).

## License

Fluxy is free software: [GNU GPL v3.0 or later](LICENSE), with the [additional terms](ADDITIONAL-TERMS.md) allowed by
section 7:

- keep the attribution *"Based on Fluxy by lorisilbagnino"* in the code and in the line at the bottom of the
  settings panel;
- modified versions can't be called "Fluxy" and must say they are a modified version;
- the license grants no rights to the Fluxy name and logo.

Mediabunny (`extension/engine/mediabunny.min.mjs`) keeps its own license, MPL-2.0. Contributions sent as pull requests
are accepted under the same license.

## Credits

Fluxy builds on [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0, included); the optional local app uses
[FFmpeg](https://ffmpeg.org), [yt-dlp](https://github.com/yt-dlp/yt-dlp), PyCryptodome and Python, installed by the
user. Details and licenses: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Every package also contains `LICENSE`,
`ADDITIONAL-TERMS.md` and that file.

## Support

Fluxy is free. If it's useful to you, you can support it with a spontaneous donation:
[**ko-fi.com/lorisilbagnino**](https://ko-fi.com/lorisilbagnino) ☕ (also linked in the settings panel and on the store pages).
