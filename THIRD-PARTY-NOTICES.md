# Third-party software

Fluxy is © 2026 lorisilbagnino, GPL-3.0-or-later with the additional terms in `ADDITIONAL-TERMS.md`
(<https://github.com/lorisilbagnino/fluxy>). It builds on the following work by others.

## Included in the extension

| Component | Version | License | Where | Source |
|---|---|---|---|---|
| **Mediabunny** — © Vanilagy and contributors | 1.66.0 | Mozilla Public License 2.0 | `engine/mediabunny.min.mjs` (official ESM bundle, unmodified), license in `engine/MEDIABUNNY-LICENSE` | <https://github.com/Vanilagy/mediabunny> · npm package `mediabunny@1.66.0`, file `dist/bundles/mediabunny.min.mjs` |

Mediabunny reads and writes the media containers of the in-browser engine (packet copy into MKV/MP4). Its source code
is available at the address above, as section 3.2 of the MPL-2.0 requires.

## Used by the optional local app (not included: installed by the user)

The local app (`fluxy_host.py`, Python standard library only) runs these programs as separate processes when the user
chooses the "Local app" engine; Fluxy does not ship them.

| Program | License | Project |
|---|---|---|
| **FFmpeg** (`ffmpeg`, `ffprobe`) — merging, subtitles | LGPL-2.1+ / GPL-2.0+ depending on the build | <https://ffmpeg.org> |
| **yt-dlp** — DASH and page analysis, downloads | The Unlicense | <https://github.com/yt-dlp/yt-dlp> |
| **PyCryptodome(x)** — optional, speeds up encrypted streams in yt-dlp | BSD 2-Clause / public domain | <https://www.pycryptodome.org> |
| **Python 3** — runs the local app | Python Software Foundation License | <https://www.python.org> |

## Store artwork (not part of the extension)

The store screenshots and promotional images in `docs/store/` are rendered with the **Inter** typeface by Rasmus
Andersson, SIL Open Font License 1.1 (<https://rsms.me/inter>, served by Google Fonts). The video scenes in them are
made up for the purpose; the Fluxy icon is original.

---

*In italiano:* Fluxy include solo **Mediabunny** (MPL-2.0, invariato, sorgente all'indirizzo sopra). L'app locale,
facoltativa, usa **FFmpeg**, **yt-dlp**, **PyCryptodome** e **Python**, installati dall'utente e non distribuiti con
Fluxy. Le immagini per gli store usano il font **Inter** (SIL OFL 1.1).
