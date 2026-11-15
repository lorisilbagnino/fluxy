# Fluxy

> Tre flussi, un file.

*[English](README.md)*

Estensione per browser Chromium e Firefox (testata su **Brave Origin 157** e **Firefox 160**) che rileva gli stream
**HLS** e **DASH** caricati dalle pagine, ti fa scegliere qualità video, tracce audio e sottotitoli, e li salva in
**un unico MKV o MP4 senza ricodifica**. Può anche **registrare i video WebRTC** (videochiamate, dirette) di una
pagina. Interfaccia in italiano e inglese (segue la lingua del browser).

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
./build.py                              # DONATE_URL=https://ko-fi.com/<nome> ./build.py  mostra "Sostieni Fluxy"
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

## Registrare un video WebRTC

1. Nel popup premi **● Registra un video**: i video della pagina (anche dentro i riquadri) vengono evidenziati.
2. Clicca quello da registrare: compare un pannello in alto a destra. Se l'audio è riprodotto da altri elementi
   della pagina (tipico delle videochiamate), la casella *Aggiungi l'audio degli altri elementi* li mescola nella
   registrazione.
3. **● Registra**, poi **■ Stop** (dal pannello o da *stop e salva* nel popup): si apre "Salva con nome" per
   scegliere dove salvare il file. Se chiudi la finestra senza salvare, la registrazione resta nel popup con
   *salva…* / *scarta*.

Formato (⚙ → *Converti le registrazioni nel formato predefinito*, attivo di default): le registrazioni seguono il
*Formato predefinito*.

| | Come viene prodotto |
|---|---|
| **MKV** | il WebM registrato (VP9/VP8 + Opus) copiato in MKV, senza ricodifica |
| **MP4** | Chromium registra direttamente in H.264 → solo copia (Opus convertito in AAC se il browser lo sa codificare); Firefox registra solo VP8 → allo stop ricodifica in H.264 + AAC con WebCodecs |
| conversione disattivata | il `.webm` registrato dal browser |

Se la conversione non riesce, il file viene salvato così come è stato registrato e il popup lo segnala.

Come funziona: `MediaRecorder` registra lo stream del `<video>` (`srcObject`, oppure `captureStream()` per i video
normali su Chromium) in pezzi da 1 s che finiscono nello spazio privato dell'estensione (OPFS). Allo stop il file
viene riscritto con la `Conversion` di Mediabunny, che aggiunge anche durata e indici: senza, molti player non
permettono di spostarsi nel file. Se la scheda viene chiusa durante la registrazione, quanto registrato fino a quel
momento viene comunque proposto per il salvataggio.

Limiti: la registrazione **ricodifica**: un video WebRTC arriva già decodificato, non ci sono
pacchetti originali da copiare. Le tracce audio aggiunte dopo l'avvio (nuovi partecipanti) e i cambi di
`srcObject` durante la registrazione non vengono seguiti. Su Firefox si registrano solo i video WebRTC
(`mozCaptureStream` toglierebbe l'audio alla pagina).

## Debug, sistemi, limiti

Vedi le sezioni corrispondenti del [README inglese](README.md#debug). In breve: log dell'app in
`~/.cache/fluxy/host.log`; app locale testata su Linux (macOS da provare, Windows non ancora); niente DRM;
`EXT-X-DISCONTINUITY` non riallineato nel motore nel browser.

## Sostieni Fluxy

Fluxy è gratuito. Se ti è utile puoi sostenerlo con una donazione spontanea (link nelle impostazioni e nelle schede
degli store).
