# ⚡ Flux Capacitor

> "1.21 gigabytes?!"

Estensione per browser Chromium e Firefox (testata su **Brave Origin 157** e **Firefox 160**) che rileva gli stream **HLS**
e **DASH** caricati dalle pagine, ti fa scegliere qualità video, tracce audio e sottotitoli, e li salva in **un unico
MKV o MP4 senza ricodifica**.

## Due motori, a scelta (⚙ → Motore)

| | **Tutto nel browser** (predefinito) | **App locale** |
|---|---|---|
| Da installare | niente | `flux_host.py` + ffmpeg + yt-dlp (pulsante *Installa app locale*) |
| Formati | HLS (anche AES-128, audio "packed" AAC/AC3/E-AC3, `EXT-X-BYTERANGE`) | HLS e DASH |
| Unione | [Mediabunny](https://mediabunny.dev) (MPL-2.0), copia dei pacchetti | `ffmpeg -c copy` |
| Dove salva | cartella Download del browser | cartella a scelta |
| Sottotitoli in MP4 | file `.srt` accanto al video | traccia `mov_text` |

Gli stream DASH usano sempre l'app locale: se non c'è, il popup propone di installarla.

## Architettura

```
extension/
  background.js   rileva .m3u8/.mpd + header della pagina (Referer, Origin, Cookie…), analizza gli HLS,
                  smista i download al motore scelto, salva con l'API downloads
  engine/         motore nel browser
    hls.js          analisi master/media playlist (stesso formato di flux_host.py)
    net.js          fetch con nuovi tentativi e limite di connessioni condiviso
    engine.js       segmenti → OPFS (AES-128 via WebCrypto), sottotitoli WebVTT, unione con Mediabunny
    runner.js       un job: download → unione → file pronto da salvare; pulizia di OPFS
  offscreen.*     Chromium: documento nascosto che esegue runner.js (il service worker può essere fermato)
                  Firefox: runner.js gira nella pagina di background, tenuta sveglia durante i download
  popup.*         scelta flussi, coda download, impostazioni, installazione dell'app locale
host/
  flux_host.py    app locale (native messaging, solo stdlib): analisi DASH (yt-dlp), download con yt-dlp,
                  unione con ffmpeg; `flux_host.py doctor` dice cosa manca e come installarlo
  install.sh      registra l'app nei browser e propone di installare ffmpeg/yt-dlp (Linux e macOS)
```

Gli header della pagina (Referer, Origin, Cookie, Authorization) vengono aggiunti alle richieste dell'estensione con
regole di sessione `declarativeNetRequest`, limitate agli host dello stream e rimosse a fine download.

## Build

```bash
./build.py
```

Genera in `dist/`:

| Browser | Cartella non pacchettizzata | Archivio |
|---|---|---|
| Brave, Chrome, Chromium, Edge, Vivaldi… | `dist/chromium/` | `flux-capacitor-<ver>-chromium.zip` |
| Firefox, LibreWolf, Waterfox | `dist/firefox/` | `flux-capacitor-<ver>-firefox.xpi` |

`extension/` è il sorgente (manifest Chromium) e si può caricare anche direttamente dopo aver lanciato `./build.py`
almeno una volta: la build copia l'app locale in `extension/native/`, da cui il pulsante *Installa app locale* genera
l'installer. Per Firefox cambia solo il manifest: background come *event page*, niente `offscreen` e `key`,
ID `flux-capacitor@fluxcapacitor.local`.

## Installazione

1. Carica l'estensione:
   - **Chromium/Brave**: `brave://extensions` → *Modalità sviluppatore* → *Carica estensione non pacchettizzata* →
     `dist/chromium/`. L'ID è fisso (`kipokjinmlcebonicoplnakgedbnlgjo`) grazie alla `key` nel manifest.
   - **Firefox**: `about:debugging#/runtime/this-firefox` → *Carica componente aggiuntivo temporaneo* →
     `dist/firefox/manifest.json`. Resta caricata fino alla chiusura di Firefox: per un'installazione permanente
     l'`.xpi` va firmato da Mozilla (anche come estensione "non in elenco", gratis, con `web-ext sign`) oppure si usa
     Firefox Developer Edition/Nightly con `xpinstall.signatures.required = false`.
2. Fine: il motore nel browser non richiede altro.
3. Facoltativo, per DASH o per salvare con ffmpeg in una cartella a scelta: ⚙ → *App locale* → **Installa app locale**.
   L'estensione salva in Download `flux-capacitor-install.sh` (contiene l'app e l'ID di questa estensione) e mostra il
   comando da lanciare:
   ```bash
   bash ~/Downloads/flux-capacitor-install.sh            # rimozione: … --uninstall
   ```
   Copia l'app in `~/.local/share/flux-capacitor/` (macOS: `~/Library/Application Support/flux-capacitor/`), la
   registra nei browser trovati e, se mancano ffmpeg/yt-dlp/pycryptodomex, propone il comando giusto per il sistema
   (pacman, apt, dnf, zypper, apk, nix, brew; pipx/pip se yt-dlp viene da lì). Poi *verifica* nel popup.
   Dal repository si può usare direttamente `./host/install.sh`.

Nota Firefox: l'app locale va registrata in `~/.mozilla/native-messaging-hosts` anche quando i profili sono in
`~/.config/mozilla` (verificato su Firefox 160). Crearla è sicuro: Firefox sceglie la cartella dei profili in base a
`~/.mozilla/firefox`.

## Rilevamento: manuale o automatico

- **Manuale (predefinito)**: l'estensione non osserva la rete finché non premi *Rileva* su una scheda; da quel momento
  ascolta solo quella scheda (anche dopo una navigazione) finché non premi *ferma* o la chiudi. Serve ricaricare la
  pagina perché di solito il player ha già scaricato la playlist prima che apri il popup.
- **Automatico** (⚙ → *Rilevamento automatico su tutte le schede*): osserva le richieste di tutte le schede e analizza
  subito ogni stream trovato. Comodo, ma sveglia il service worker a ogni richiesta di rete.

Se registri l'app dal repository con `./host/install.sh` e poi sposti la cartella, riesegui lo script (il manifest
dell'host contiene il percorso assoluto). Per rimuovere: `./host/install.sh --uninstall`.

## Uso

- **Video**: preselezionata la qualità più alta. "audio incluso" = la variante ha già l'audio dentro.
- **Audio / Sottotitoli**: preselezionate le lingue preferite (⚙ → *Lingue preferite*), una traccia audio per lingua.
- **MKV** (consigliato) accetta tutto. **MP4**: sottotitoli come `.srt` accanto al video (motore nel browser) o
  `mov_text` (app locale).
- Motore nel browser: i segmenti vengono scritti nello spazio privato dell'estensione (OPFS), uniti, e il file finale
  passato al gestore download del browser; durante il lavoro serve circa **2× la dimensione del film** su disco.
  Prima di iniziare l'estensione controlla lo spazio disponibile.
- App locale: il file viene scritto in una cartella temporanea `.flux-<id>` dentro la destinazione e spostato alla fine.

## Debug

- Analisi da terminale: `./host/flux_host.py probe "<url.m3u8>" "Referer: https://…"`
- Log del programma locale: `~/.cache/flux-capacitor/host.log` (cookie e Authorization oscurati)
- Popup come pagina normale: `chrome-extension://kipokjinmlcebonicoplnakgedbnlgjo/popup.html?tab=<tabId>`
- Console del service worker: `brave://extensions` → Flux Capacitor → *service worker*; motore nel browser:
  *offscreen.html* nella stessa pagina. Firefox: `about:debugging` → *Ispeziona*.

## Sistemi supportati

- **Motore nel browser**: ovunque giri il browser (Linux, macOS, Windows).
- **App locale**: Linux supportato e testato (CachyOS, Brave Origin e Firefox); l'installer include i percorsi macOS,
  non ancora provati. Windows: non ancora (registro, wrapper `.bat`, `explorer` per "apri cartella").

## Limiti noti

- I contenuti protetti da DRM (Widevine/PlayReady/FairPlay, SAMPLE-AES) sono riconosciuti e **non** scaricati.
  AES-128 standard di HLS è supportato da entrambi i motori.
- Motore nel browser: gli stream con salti di timestamp (`EXT-X-DISCONTINUITY`, tipici delle pubblicità inserite)
  non vengono riallineati; DASH non supportato (usa l'app locale).
- Nell'audio HLS il bitrate non è dichiarato nel manifest: la stima dell'avanzamento è approssimativa.
- Per DASH yt-dlp raggruppa i sottotitoli per lingua: due tracce con la stessa lingua non si distinguono.
- Gli URL con token a scadenza vanno scaricati poco dopo il rilevamento (ricarica la pagina se scadono).
