# Fluxy

> Tre flussi, un file.

*[English](README.md)*

Estensione per browser Chromium e Firefox (testata su **Brave Origin 157** e **Firefox 160**) che rileva gli stream
**HLS** e **DASH** caricati dalle pagine, ti fa scegliere qualità video, tracce audio e sottotitoli, e li salva in
**un unico MKV o MP4 senza ricodifica**. Interfaccia in italiano e inglese (segue la lingua del browser).

<p align="center"><img src="docs/store/images/it/promo-marquee-1400x560.png" alt="Fluxy" width="100%"></p>

<table>
<tr>
<td width="50%"><img src="docs/store/images/it/screenshot-1-popup.png" alt="Scegli qualità video, lingue audio e sottotitoli"><br><sub>Scegli qualità video, lingue audio e sottotitoli</sub></td>
<td width="50%"><img src="docs/store/images/it/screenshot-2-three-streams.png" alt="Tre flussi, un file — senza ricodifica"><br><sub>Tre flussi, un file — senza ricodifica</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/store/images/it/screenshot-3-how-it-works.png" alt="Rileva, scegli, scarica"><br><sub>Rileva, scegli, scarica</sub></td>
<td width="50%"><img src="docs/store/images/it/screenshot-4-engines.png" alt="Tutto nel browser, o con l'app locale"><br><sub>Tutto nel browser, o con l'app locale</sub></td>
</tr>
</table>

## Due motori (⚙ → Motore)

| | **Tutto nel browser** (predefinito) | **App locale** |
|---|---|---|
| Da installare | niente | `fluxy_host.py` + ffmpeg + yt-dlp (pulsante *Installa app locale*) |
| Formati | HLS (anche AES-128, audio "packed" AAC/AC3/E-AC3, `EXT-X-BYTERANGE`) | HLS, DASH, pagine supportate da yt-dlp (YouTube…) |
| Unione | [Mediabunny](https://mediabunny.dev) (MPL-2.0), copia dei pacchetti | `ffmpeg -c copy` |
| Dove salva | cartella Download del browser | cartella a scelta |
| Sottotitoli in MP4 | file `.srt` accanto al video | traccia `mov_text` |

DASH e le pagine yt-dlp usano sempre l'app locale: se non c'è, il popup propone di installarla.

## Versione GitHub e versione store

| | Release GitHub (`chromium`, `firefox`) | Store (`chrome-store`, `firefox-store`) |
|---|---|---|
| YouTube | sì: sulle pagine YouTube il popup propone *Analizza con yt-dlp* (app locale) | no: YouTube viene ignorato (policy del Chrome Web Store) |
| ID Chromium | fisso grazie alla `key` del manifest | assegnato dallo store |

La differenza sta in un solo file generato, `build-flags.js` (`STORE_BUILD`, `DONATE_URL`).

## Lingue

I testi stanno in `tools/messages.py` (per ogni chiave: inglese, italiano); la build scrive
`extension/_locales/{en,it}/messages.json`. Il browser usa la lingua della sua interfaccia e, se manca, l'inglese.
App locale e installer seguono la stessa lingua (l'estensione la comunica all'app; l'installer legge `LANG`).

## Build, release, store

```bash
./build.py                              # DONATE_URL= ./build.py  crea la build senza il link Ko-fi
```

Genera in `dist/` i pacchetti `chromium` (.zip), `firefox` (.xpi), `chrome-store` (.zip) e `firefox-store` (.xpi).
A ogni push su `main` il workflow pubblica la release `vX.Y.Z` se la versione del manifest non ne ha ancora una
(dettagli e firma Firefox nel [README inglese](README.md#releases)). Materiale per gli store: `docs/store/listing.md`,
`docs/PRIVACY.md`, immagini in `docs/store/images/{en,it}/`.

## Installazione

1. Carica l'estensione:
   - **Chromium/Brave**: `brave://extensions` → *Modalità sviluppatore* → *Carica estensione non pacchettizzata* →
     `dist/chromium/` (ID fisso `kipokjinmlcebonicoplnakgedbnlgjo`).
   - **Firefox**: `about:debugging#/runtime/this-firefox` → *Carica componente aggiuntivo temporaneo* →
     `dist/firefox/manifest.json`; per un'installazione permanente serve l'`.xpi` firmato (vedi release).
2. Il motore nel browser non richiede altro.
3. Facoltativo (DASH, YouTube, cartella a scelta): ⚙ → *App locale* → **Installa app locale**, poi nel terminale
   `bash ~/Downloads/fluxy-install.sh` (rimozione: `--uninstall`) e *verifica* nel popup. Dal repository:
   `./host/install.sh`.

Nota Firefox: l'app va registrata in `~/.mozilla/native-messaging-hosts` anche con i profili in `~/.config/mozilla`.

## Rilevamento

- **Manuale (predefinito)**: premi *Rileva* sulla scheda; la pagina si ricarica e Fluxy ascolta solo quella scheda
  finché non premi *ferma* o la chiudi.
- **Automatico** (⚙): osserva tutte le schede; comodo, ma sveglia il service worker a ogni richiesta.
- **YouTube** (versione GitHub): niente playlist standard; il popup propone *Analizza con yt-dlp* tramite l'app locale.

## Uso

- **Video**: preselezionata la qualità più alta. **Audio / Sottotitoli**: preselezionate le lingue preferite
  (predefinite: la lingua del browser e l'inglese).
- **MKV** consigliato. **MP4**: sottotitoli `.srt` accanto al video (motore nel browser) o `mov_text` (app locale).
- Motore nel browser: durante il lavoro serve circa **2× la dimensione del film** su disco (controllato prima di
  iniziare).

## Debug, sistemi, limiti

Vedi le sezioni corrispondenti del [README inglese](README.md#debug). In breve: log dell'app in
`~/.cache/fluxy/host.log`; app locale testata su Linux (macOS da provare, Windows non ancora); niente DRM;
`EXT-X-DISCONTINUITY` non riallineato nel motore nel browser.

## Licenza

Fluxy è software libero: [GNU GPL v3.0 o successiva](LICENSE), con i [termini aggiuntivi](ADDITIONAL-TERMS.md)
previsti dalla sezione 7:

- va conservata l'attribuzione *"Based on Fluxy by lorisilbagnino"* nel codice e nella riga in fondo alle
  impostazioni;
- le versioni modificate non possono chiamarsi "Fluxy" e devono dichiararsi modificate;
- la licenza non concede diritti su nome e logo di Fluxy.

Mediabunny (`extension/engine/mediabunny.min.mjs`) mantiene la sua licenza, MPL-2.0. I contributi inviati come pull
request sono accettati con la stessa licenza.

## Sostieni Fluxy

Fluxy è gratuito. Se ti è utile puoi sostenerlo con una donazione spontanea:
[**ko-fi.com/lorisilbagnino**](https://ko-fi.com/lorisilbagnino) ☕ (il link è anche nelle impostazioni e nelle schede degli store).
