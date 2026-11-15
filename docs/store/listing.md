# Scheda per gli store

Testi pronti da incollare per **Chrome Web Store** (vale anche per **Edge Add-ons**) e **addons.mozilla.org** (AMO).
Prima la versione italiana, poi quella inglese: negli store conviene usare l'inglese come lingua predefinita e
aggiungere l'italiano come traduzione.

Pacchetti da caricare (`./build.py`, oppure dalla release GitHub; il link Ko-fi è incluso):

| Store | File |
|---|---|
| Chrome Web Store, Edge Add-ons | `dist/fluxy-<ver>-chrome-store.zip` (senza `key`: l'ID lo assegna lo store; senza YouTube) |
| AMO | `dist/fluxy-<ver>-firefox-store.xpi` (senza YouTube) |

Le versioni store escludono YouTube (obbligatorio per il Chrome Web Store, prudente per AMO); la versione pubblicata
su GitHub lo supporta tramite l'app locale.

**Lingue**: l'estensione è in inglese (predefinita) e italiano; nome e descrizione del manifest vengono presi da
`_locales/`. In entrambi gli store scegliere **inglese come lingua predefinita** e aggiungere l'italiano, ognuno con
la sua descrizione e i suoi screenshot (`images/en/`, `images/it/`).

**Donazioni (Ko-fi)**: consentite da entrambi gli store se spontanee e non legate a funzioni.
- AMO ha un campo apposito, *Contributions URL*, che accetta Ko-fi: compare come pulsante "Support this developer".
- Chrome Web Store non ha un campo: si mette il link in fondo alla descrizione (riga già predisposta sotto) e
  nell'estensione (link "Sostieni Fluxy" nelle impostazioni, attivo se la build ha `DONATE_URL`).
- Pagina Ko-fi: https://ko-fi.com/lorisilbagnino (già inserita nei testi).

Immagini: `docs/store/images/{en,it}/` (vedi in fondo).

---

## Italiano

**Nome**: Fluxy – Stream Downloader

**Riepilogo** (CWS max 132 caratteri, AMO max 250):
> Salva gli stream HLS e DASH in un unico MKV o MP4, con le tracce audio e i sottotitoli che scegli. Senza ricodifica.

**Descrizione**:

```
Tre flussi, un file.

Molti siti trasmettono i video in streaming adattivo (HLS o DASH): il video, ogni lingua dell'audio e ogni
sottotitolo arrivano come flussi separati, spezzati in centinaia di segmenti. Fluxy li trova, ti fa scegliere
cosa tenere e li ricompone in un unico file pronto per qualsiasi player.

• Scegli la qualità del video, fino alla più alta che il sito offre.
• Scegli le tracce audio per lingua: anche più di una nello stesso file.
• Scegli i sottotitoli per lingua, compresi quelli "forced".
• Ottieni un MKV (consigliato) o un MP4, con lingue e tracce predefinite già impostate.
• Nessuna ricodifica: i dati vengono copiati così come sono, senza perdita di qualità e in pochi secondi.

Tutto nel browser
Download in parallelo, decifratura dei flussi AES-128 standard e unione delle tracce avvengono dentro
l'estensione. Non serve installare nulla e nulla viene inviato a server esterni.

App locale (facoltativa)
Per i flussi DASH o per salvare con ffmpeg in una cartella a tua scelta, Fluxy può usare un piccolo programma
locale basato su ffmpeg e yt-dlp. Il pulsante "Installa app locale" prepara lo script di installazione per il
tuo sistema (Linux; macOS in prova).

Rilevamento su richiesta
Di base Fluxy non osserva la navigazione: premi "Rileva" sulla scheda che ti interessa e la pagina viene
ricaricata per intercettare gli stream del player. Se preferisci, puoi attivare il rilevamento automatico.

Cosa Fluxy non fa
• Non scarica contenuti protetti da DRM (Widevine, PlayReady, FairPlay): li riconosce e lo segnala.
• Non funziona su YouTube.
• Non ricodifica e non modifica i contenuti.

Usa Fluxy solo per contenuti che hai il diritto di salvare.

Fluxy è gratuito. Se ti è utile, puoi offrirmi un caffè: https://ko-fi.com/lorisilbagnino
```

---

## English

**Name**: Fluxy – Stream Downloader

**Summary** (CWS max 132 characters, AMO max 250):
> Save HLS and DASH streams as one MKV or MP4 with the audio tracks and subtitles you pick. No re-encoding.

**Description**:

```
Three streams, one file.

Many sites deliver video as adaptive streams (HLS or DASH): the picture, each audio language and each subtitle
arrive as separate streams, split into hundreds of segments. Fluxy finds them, lets you choose what to keep and
puts them back together into a single file that plays anywhere.

• Pick the video quality, up to the highest the site offers.
• Pick audio tracks by language, several in the same file if you like.
• Pick subtitles by language, including "forced" ones.
• Get an MKV (recommended) or an MP4, with languages and default tracks already set.
• No re-encoding: data is copied as is, with no quality loss and in seconds.

All in the browser
Parallel downloads, decryption of standard AES-128 streams and track merging all happen inside the extension.
Nothing to install, nothing sent to external servers.

Local app (optional)
For DASH streams, or to save with ffmpeg into a folder of your choice, Fluxy can use a small local program
based on ffmpeg and yt-dlp. The "Install local app" button prepares the install script for your system
(Linux; macOS in testing).

Detection on demand
By default Fluxy doesn't watch your browsing: press "Detect" on the tab you care about and the page reloads so
the player's streams can be picked up. Automatic detection can be turned on in the settings.

What Fluxy doesn't do
• It doesn't download DRM-protected content (Widevine, PlayReady, FairPlay): it recognises it and says so.
• It doesn't work on YouTube.
• It doesn't re-encode or alter content.

Only use Fluxy for content you have the right to save.

Fluxy is free. If you find it useful, you can buy me a coffee: https://ko-fi.com/lorisilbagnino
```

---

## Chrome Web Store — campi della dashboard

**Categoria**: Strumenti (Tools) · **Lingua predefinita**: Inglese (+ Italiano)

**Scopo unico** (Single purpose):
> Fluxy saves the HLS/DASH video streams played by a web page as a single local video file, with the video,
> audio and subtitle tracks chosen by the user.

**Giustificazione dei permessi**:

| Permesso | Giustificazione (da incollare) |
|---|---|
| `webRequest` | Detects the HLS/DASH playlists (.m3u8/.mpd) requested by the page's player, and the request headers (Referer, Origin, Cookie) the server expects. By default only on the tab where the user pressed "Detect". |
| `host_permissions: <all_urls>` | Video streams are served from arbitrary CDN hosts that cannot be known in advance; the extension must fetch playlists and segments from them. |
| `declarativeNetRequestWithHostAccess` | Adds the page's Referer/Origin/Cookie headers to the extension's own requests for the stream, which CDNs require. Session rules limited to the stream's hosts and removed when the download ends. |
| `downloads` | Saves the finished video file (and subtitle files) to the user's download folder. |
| `offscreen` | Runs the download and merge in an offscreen document, because the service worker may be stopped during long downloads. |
| `unlimitedStorage` | Stages the downloaded segments in the extension's private storage (OPFS) before merging; a film can take several GB. |
| `storage` | Keeps settings and the list of detected streams and downloads. |
| `tabs` | Reads the active tab's title (default file name) and reloads the tab when the user presses "Detect". |
| `nativeMessaging` | Optional local app (ffmpeg + yt-dlp) for DASH streams, used only if the user installs it. |

**Codice remoto**: No, nessun codice remoto (tutto il JavaScript è nel pacchetto; Mediabunny è incluso).

**Pratiche sulla privacy (Data usage)**:
- Dati raccolti: **nessuno**. Spuntare solo se richiesto in modo conservativo: *Website content* e
  *Authentication information* vengono **usati localmente** (indirizzi degli stream, cookie della pagina inoltrati al
  server del video) ma non vengono mai trasmessi allo sviluppatore né a terzi.
- Certificazioni: non venduti a terzi · non usati per scopi estranei alla funzione · non usati per affidabilità
  creditizia.
- URL informativa privacy: pubblicare `docs/PRIVACY.md` (vedi sotto) e incollarne l'indirizzo.

**Requisiti di policy rispettati**: niente download da YouTube (bloccato nel codice), niente aggiramento di DRM,
nessuna raccolta dati, permessi limitati alla funzione.

---

## AMO — campi del Developer Hub

**Categorie**: Download Management · Photos, Music & Videos
**Contributions URL**: `https://ko-fi.com/lorisilbagnino` (Ko-fi è tra i servizi accettati)
**Licenza**: GNU General Public License v3.0 (GPL-3.0-or-later, con termini aggiuntivi in `ADDITIONAL-TERMS.md`:
su AMO scegliere "GNU General Public License v3.0"). Codice sorgente: https://github.com/lorisilbagnino/fluxy
**Informativa privacy**: il testo di `docs/PRIVACY.md`.

**Note per i revisori** (Notes to reviewer):

```
No build step: the uploaded package is a plain copy of the extension/ folder (build.py only adapts manifest.json
for Firefox). All code is readable source except one third-party library:

- engine/mediabunny.min.mjs — Mediabunny 1.66.0 (MPL-2.0), official unmodified ESM bundle:
  https://www.npmjs.com/package/mediabunny/v/1.66.0  (file: dist/bundles/mediabunny.min.mjs)
  https://github.com/Vanilagy/mediabunny
  SHA-256 c26f218c23c3d2e97574c9399a75dccb91ceddcac3a6fd4593e9a390320b494a (identical to the npm tarball)

The optional native app (nativeMessaging, com.fluxy.host) is a Python script shipped in native/ and installed
only if the user runs the generated install script; the extension works fully without it.

Test: open any page that plays an HLS stream (e.g. https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8
in a player page), open the popup, press "Detect", choose tracks, press "Download" (the UI follows the browser language: English or Italian).
```

---

## Immagini

| File | Formato | Uso |
|---|---|---|
Ogni immagine esiste in `images/en/` e `images/it/`:

| File | Formato | Uso |
|---|---|---|
| `screenshot-1-popup.png` | 1280×800 | CWS/AMO: popup con flussi selezionabili |
| `screenshot-2-three-streams.png` | 1280×800 | CWS/AMO: infografica "tre flussi, un file" |
| `screenshot-3-how-it-works.png` | 1280×800 | CWS/AMO: come funziona in 3 passi |
| `screenshot-4-engines.png` | 1280×800 | CWS/AMO: motore nel browser o app locale |
| `screenshot-5-progress.png` | 1280×800 | CWS/AMO: download in corso e completato |
| `promo-small-440x280.png` | 440×280 | CWS: piccolo riquadro promozionale (obbligatorio) |
| `promo-marquee-1400x560.png` | 1400×560 | CWS: riquadro grande (facoltativo) |
| `social-preview-1280x640.png` | 1280×640 | GitHub: anteprima dei link (Settings → Social preview) |
| `icons/icon128.png` (nell'estensione) | 128×128 | Icona dello store |

I sorgenti HTML sono in `docs/store/src/` (testi in `src/strings.js`); si rigenerano con `node docs/store/render.mjs`.

---

## Prima di pubblicare

- [ ] Account sviluppatore: Chrome Web Store (5 $ una tantum), AMO (gratis), Edge (gratis).
- [ ] Informativa privacy raggiungibile da un URL pubblico (il repository è privato: GitHub Pages su repo privati
      richiede un piano a pagamento; in alternativa un gist pubblico o una pagina sul proprio sito).
- [x] Licenza del progetto: GPL-3.0-or-later + termini aggiuntivi.
- [x] Account Ko-fi: https://ko-fi.com/lorisilbagnino (link nel popup, nelle schede e nel pulsante Sponsor di GitHub).
- [ ] Caricare `fluxy-<ver>-chrome-store.zip` / `fluxy-<ver>-firefox-store.xpi`, testi, immagini, giustificazioni.
