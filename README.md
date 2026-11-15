# ⚡ Flux Capacitor

> "1.21 gigabytes?!"

Estensione per browser Chromium e Firefox (testata su **Brave Origin 157** e **Firefox 160**) che rileva gli stream **HLS** e **DASH**
caricati dalle pagine, ti fa scegliere qualità video, tracce audio e sottotitoli, e li salva in **un unico
MKV o MP4 senza ricodifica** (`ffmpeg -c copy`).

## Architettura

```
extension/                       host/
  background.js  rileva .m3u8/.mpd   flux_host.py  native messaging host (Python, solo stdlib)
                 + header (Referer,                  - analizza HLS (parser proprio) e DASH (yt-dlp)
                 Cookie, Origin…)                    - scarica i flussi con yt-dlp (frammenti in parallelo)
  popup.*        scelta flussi,                      - sottotitoli WebVTT segmentati → SRT (ffmpeg)
                 coda download                       - unione finale con ffmpeg, tag lingua e flag
  shared.js                          install.sh    registra l'host nel browser
```

## Build

```bash
./build.py
```

Genera in `dist/`:

| Browser | Cartella non pacchettizzata | Archivio |
|---|---|---|
| Brave, Chrome, Chromium, Edge, Vivaldi… | `dist/chromium/` | `flux-capacitor-<ver>-chromium.zip` |
| Firefox, LibreWolf, Waterfox | `dist/firefox/` | `flux-capacitor-<ver>-firefox.xpi` |

`extension/` è il sorgente (manifest Chromium) e si può caricare anche direttamente. Per Firefox cambia solo il
manifest: background come *event page* invece di service worker, ID `flux-capacitor@fluxcapacitor.local`, niente `key`.

## Installazione

Requisiti: `python3`, `ffmpeg`, `yt-dlp` (e `pycryptodomex` per gli stream cifrati: il popup suggerisce il comando).

1. Registra il programma locale (rileva da solo i browser installati):
   ```bash
   ./host/install.sh
   ```
2. Carica l'estensione:
   - **Chromium/Brave**: `brave://extensions` → *Modalità sviluppatore* → *Carica estensione non pacchettizzata* →
     `dist/chromium/` (o `extension/`). L'ID è fisso (`kipokjinmlcebonicoplnakgedbnlgjo`) grazie alla `key` nel manifest.
   - **Firefox**: `about:debugging#/runtime/this-firefox` → *Carica componente aggiuntivo temporaneo* →
     `dist/firefox/manifest.json`. Resta caricata fino alla chiusura di Firefox: per un'installazione permanente
     l'`.xpi` va firmato da Mozilla (anche come estensione "non in elenco", gratis, con `web-ext sign`) oppure si usa
     Firefox Developer Edition/Nightly con `xpinstall.signatures.required = false`.
3. Apri la pagina del video, clicca l'icona e premi **⟳ Rileva**: la pagina viene ricaricata e gli stream che il
   player carica compaiono nel popup (il badge ne indica il numero).

Nota Firefox: il programma locale va registrato in `~/.mozilla/native-messaging-hosts` anche quando i profili sono in
`~/.config/mozilla` (verificato su Firefox 160). Crearla è sicuro: Firefox sceglie la cartella dei profili in base a
`~/.mozilla/firefox`.

## Rilevamento: manuale o automatico

- **Manuale (predefinito)**: l'estensione non osserva la rete finché non premi *Rileva* su una scheda; da quel momento
  ascolta solo quella scheda (anche dopo una navigazione) finché non premi *ferma* o la chiudi. Serve ricaricare la
  pagina perché di solito il player ha già scaricato la playlist prima che apri il popup.
- **Automatico** (⚙ → *Rilevamento automatico su tutte le schede*): osserva le richieste di tutte le schede e analizza
  subito ogni stream trovato. Comodo, ma sveglia il service worker a ogni richiesta di rete.

Se sposti la cartella del progetto, riesegui `install.sh` (il manifest dell'host contiene il percorso assoluto).
Per rimuovere: `./host/install.sh --uninstall`.

## Uso

- **Video**: preselezionata la qualità più alta. "audio incluso" = la variante ha già l'audio dentro.
- **Audio / Sottotitoli**: preselezionate le lingue preferite (⚙ → *Lingue preferite*), una traccia audio per lingua.
- **MKV** (consigliato) accetta tutto. **MP4** converte i sottotitoli in `mov_text`.
- Il file viene scritto in una cartella temporanea `.flux-<id>` dentro la destinazione e spostato alla fine.

## Debug

- Analisi da terminale: `./host/flux_host.py probe "<url.m3u8>" "Referer: https://…"`
- Log del programma locale: `~/.cache/flux-capacitor/host.log` (cookie e Authorization oscurati)
- Popup come pagina normale: `chrome-extension://kipokjinmlcebonicoplnakgedbnlgjo/popup.html?tab=<tabId>`
- Console del service worker: `brave://extensions` → Flux Capacitor → *service worker*

## Sistemi supportati

- **Linux**: supportato e testato (CachyOS, Brave Origin e Firefox). Se manca qualcosa, il popup suggerisce il comando
  adatto alla distribuzione (Arch, Debian/Ubuntu, Fedora, openSUSE, Alpine, NixOS) e a come è installato yt-dlp
  (pacchetto di sistema, pip, pipx, eseguibile ufficiale).
- **macOS / Windows**: l'estensione funziona, ma `install.sh` e il programma locale non sono ancora adattati
  (percorsi `NativeMessagingHosts`, registro di Windows, wrapper `.bat`, `open`/`explorer` per "apri cartella").

## Limiti noti

- I contenuti protetti da DRM (Widevine/PlayReady/FairPlay, SAMPLE-AES) sono riconosciuti e **non** scaricati.
  AES-128 standard di HLS è supportato.
- Nell'audio HLS il bitrate non è dichiarato nel manifest: la stima dell'avanzamento è approssimativa.
- Per DASH yt-dlp raggruppa i sottotitoli per lingua: due tracce con la stessa lingua non si distinguono.
- Gli URL con token a scadenza vanno scaricati poco dopo il rilevamento (ricarica la pagina se scadono).
