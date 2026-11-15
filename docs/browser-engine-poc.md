# Prova tecnica: motore interamente nel browser

Obiettivo: verificare se il download e l'unione dei flussi si possono fare **senza programma locale**
(niente ffmpeg/yt-dlp/Python), con [Mediabunny](https://mediabunny.dev) (MPL-2.0) per l'unione senza ricodifica.

> Il codice della prova è stato integrato nell'estensione (`extension/engine/`, v0.2.0); la pagina di test non c'è
> più. Questo documento conserva i risultati delle misure.

- `engine.js` (ora `extension/engine/`) — download HLS (fetch in parallelo con limite di connessioni condiviso, nuovi tentativi, AES-128 via
  WebCrypto), "packed audio" (ID3 + AAC/AC3/E-AC3), sottotitoli WebVTT segmentati, unione con Mediabunny in modalità
  copia, scrittura a pezzi in OPFS.
- `poc.html` / `poc.js` — pagina di test (`runPoc(spec)`), salvataggio finale con l'API dei download.
- `mediabunny.min.mjs` — Mediabunny 1.66.0 (bundle ESM ufficiale), licenza in `MEDIABUNNY-LICENSE`.

## Risultati (15/11/2026, Brave Origin 157 e Firefox 160, headless)

| Caso | Brave | Firefox |
|---|---|---|
| Apple bipbop: video TS + AAC/AC3/E-AC3 "packed audio" + 2 sottotitoli → MKV | ✓ tracce, lingue, flag e tempi corretti | ✓ identico |
| Stream AES-128 con audio dentro il video → MKV | ✓ | — (non ripetuto) |
| Apple bipbop → MP4 | ✓ video/audio; sottotitoli `wvtt` non letti da ffmpeg | — |
| 2,1 GB, 10 min 1080p, video + audio separati | unione 38 s, RAM browser +570 MB, heap JS 56 MB | unione 87 s, RAM +315 MB |
| 2 h, AC3 5.1 (≈ 300 MB, ~550k pacchetti) | unione 13 s, RAM +290 MB, A/V allineati a 7190 s | unione 38 s, RAM +290 MB |

La memoria non cresce con la dimensione o la durata del file: i dati passano da disco (OPFS) a disco.

## Problemi trovati e risolti durante la prova

- Connessioni interrotte a metà risposta con molte richieste parallele: nuovi tentativi sull'intera lettura e limite
  di connessioni condiviso tra le tracce.
- I segmenti "packed audio" hanno il timestamp in un tag ID3: va letto per allineare l'audio al video.
- Mediabunny non legge AC3/E-AC3 grezzi: parser di frame scritto a mano (~60 righe).
- Mediabunny scrive i WebVTT in MKV come `S_TEXT/WEBVTT`, sconosciuto a ffmpeg (quindi mpv, Kodi…): l'ID viene
  riscritto in `S_TEXT/UTF8` (SRT) sul posto, stessa lunghezza.

## Limiti ancora aperti

- **Spazio su disco**: servono ~2× la dimensione del film (segmenti + file finale), come con il programma locale;
  con l'API dei download il file viene poi copiato in Download (picco ~3×). Su Chromium, scrivendo direttamente nel
  file scelto con `showSaveFilePicker`, si torna a 2×.
- **MP4 + sottotitoli**: `wvtt` è poco supportato → per MP4 salvare anche `.srt` a parte (o consigliare MKV).
- Non ancora coperti: DASH, `EXT-X-BYTERANGE`, salti nei timestamp (`EXT-X-DISCONTINUITY`), header Referer/Origin
  personalizzati (da fare con regole `declarativeNetRequest`).
