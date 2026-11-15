#!/usr/bin/env python3
"""Source of the UI strings: writes extension/_locales/{en,it}/messages.json.

Edit the table below, then run ./build.py (or this script). "$1".."$9" are
positional substitutions; they become named placeholders, which both Chrome and
Firefox support.
"""
import json
import re
from pathlib import Path

M = {
    # manifest
    "extName": ("Fluxy – Stream Downloader", "Fluxy – Stream Downloader"),
    "extDescription": ("Save HLS/DASH streams as one MKV/MP4 with the audio tracks and subtitles you pick. No re-encoding, nothing to install.",
                       "Salva gli stream HLS/DASH in un unico MKV/MP4 con le tracce audio e i sottotitoli che scegli. Senza ricodifica, senza installare nulla."),
    # popup: static
    "engineStatusTitle": ("Download engine", "Motore di download"),
    "settings": ("Settings", "Impostazioni"),
    "engine": ("Engine", "Motore"),
    "engineBrowser": ("All in the browser", "Tutto nel browser"),
    "engineBrowserHelp": ("Nothing to install. Files go to the browser's Downloads folder. HLS only.",
                          "Niente da installare. Il file finisce nella cartella Download del browser. Solo HLS."),
    "engineNative": ("Local app (ffmpeg + yt-dlp)", "App locale (ffmpeg + yt-dlp)"),
    "engineNativeHelp": ("DASH too, any destination folder, merging with ffmpeg.",
                         "Anche DASH, cartella di destinazione a scelta, unione con ffmpeg."),
    "verify": ("verify", "verifica"),
    "installLocalApp": ("Install local app", "Installa app locale"),
    "outputDir": ("Destination folder (local app)", "Cartella di destinazione (app locale)"),
    "defaultFormat": ("Default format", "Formato predefinito"),
    "parallel": ("Parallel connections", "Connessioni in parallelo"),
    "autoDetect": ("Automatic detection on all tabs", "Rilevamento automatico su tutte le schede"),
    "autoDetectHelp": ("When off, the extension doesn't watch network traffic until you press “Detect” on a tab.",
                       "Se disattivo, l'estensione non osserva la rete finché non premi “Rileva” su una scheda."),
    "prefLangs": ("Preferred languages (preselected)", "Lingue preferite (preselezionate)"),
    "downloads": ("Downloads", "Download"),
    "clearFinished": ("clear finished", "rimuovi completati"),
    "streamsInTab": ("Streams in this tab", "Stream in questa scheda"),
    "clear": ("clear", "svuota"),
    "clearTitle": ("Clear the list", "Svuota l'elenco"),
    "stop": ("stop", "ferma"),
    "detect": ("⟳ Detect", "⟳ Rileva"),
    "detectTitle": ("Reload the page and catch the streams the player loads", "Ricarica la pagina e intercetta gli stream che il player carica"),
    "reload": ("⟳ Reload", "⟳ Ricarica"),
    "copyUrl": ("copy URL", "copia URL"),
    "copyUrlTitle": ("Copy the manifest URL", "Copia l'URL del manifest"),
    "copied": ("copied ✓", "copiato ✓"),
    "donate": ("Support Fluxy ♥", "Sostieni Fluxy ♥"),
    # popup: dynamic
    "langUnknown": ("Unknown language", "Lingua sconosciuta"),
    "appNotChecked": ("Local app: not checked", "App locale: non verificata"),
    "appMissingTools": ("Local app installed, $1 missing", "App locale installata, manca $1"),
    "appReady": ("Local app ready (v$1)", "App locale pronta (v$1)"),
    "appNotInstalled": ("Local app not installed", "App locale non installata"),
    "appCommError": ("Local app: communication error", "App locale: errore di comunicazione"),
    "missing": ("missing", "mancante"),
    "pillBrowser": ("in browser", "nel browser"),
    "pillBrowserTitle": ("Download and merge in the browser, nothing to install", "Download e unione nel browser, niente da installare"),
    "pillNative": ("local app", "app locale"),
    "pillNativeMissing": ("app missing", "app mancante"),
    "pillNativeError": ("app error", "errore app"),
    "toolsMissing": ("Missing: $1. To install:", "Mancano: $1. Per installarli:"),
    "cryptoMissing": ("yt-dlp can't find pycryptodomex: encrypted (AES-128) streams will be downloaded by ffmpeg one segment at a time, much more slowly. To install it:",
                      "yt-dlp non trova pycryptodomex: gli stream cifrati (AES-128) verranno scaricati da ffmpeg un segmento alla volta, molto più lentamente. Per installarlo:"),
    "nativeChosenMissing": ("You chose the local app, but it isn't installed.", "Hai scelto l'app locale, ma non è installata."),
    "nativeCommError": ("Communication error with the local app: ", "Errore di comunicazione con l'app locale: "),
    "useBrowserEngine": ("use the in-browser engine", "usa il motore nel browser"),
    "preparingInstaller": ("Preparing the installer…", "Preparo l'installer…"),
    "installerSaved": ("Installer saved to Downloads. Open a terminal and run:", "Installer salvato in Download. Apri un terminale ed esegui:"),
    "installerExplain": ("It copies the app to ~/.local/share/fluxy, registers it in Brave/Chrome/Firefox and offers to install ffmpeg and yt-dlp if they're missing.",
                         "Copia l'app in ~/.local/share/fluxy, la registra in Brave/Chrome/Firefox e propone di installare ffmpeg e yt-dlp se mancano."),
    "copyCommand": ("copy command", "copia comando"),
    "doneVerify": ("done, verify", "fatto, verifica"),
    "detectActive": ("Detection active on this tab", "Rilevamento attivo su questa scheda"),
    "detectManual": ("Manual detection", "Rilevamento manuale"),
    "youtubeUnsupported": ("YouTube videos aren't supported.", "I video di YouTube non sono supportati."),
    "noStreamsYet": ("No streams yet. Start playing the video: streams show up here as soon as the player loads them.",
                     "Nessuno stream ancora. Avvia la riproduzione del video: gli stream compaiono qui appena il player li carica."),
    "autoOff": ("Automatic detection is off. Press “Detect”: the page reloads and the streams the player loads show up here.",
                "Rilevamento automatico disattivato. Premi “Rileva”: la pagina viene ricaricata e gli stream che il player carica compaiono qui."),
    "analysing": ("Analysing the stream…", "Analisi dello stream…"),
    "unknownError": ("Unknown error", "Errore sconosciuto"),
    "retry": ("Retry", "Riprova"),
    "installLocalAppLink": ("install local app", "installa app locale"),
    "drmProtected": ("DRM protected ($1): it can't be downloaded.", "Protetto da DRM ($1): non è possibile scaricarlo."),
    "liveStream": ("Live stream: only what's already available will be downloaded.", "Stream in diretta: verrà scaricato solo ciò che è già disponibile."),
    "encryptionOk": ("$1 encryption with a clear key: supported.", "Cifratura $1 con chiave in chiaro: supportata."),
    "video": ("Video", "Video"),
    "audio": ("Audio", "Audio"),
    "subtitles": ("Subtitles", "Sottotitoli"),
    "audioIncluded": ("audio included", "audio incluso"),
    "noVideo": ("No video (audio only)", "Nessun video (solo audio)"),
    "forced": ("forced", "forced"),
    "download": ("Download", "Scarica"),
    "fileName": ("File name", "Nome del file"),
    "cancel": ("cancel", "annulla"),
    "showFile": ("show file", "mostra file"),
    "openFolder": ("open folder", "apri cartella"),
    "remove": ("remove", "rimuovi"),
    "error": ("Error", "Errore"),
    "pageCardTitle": ("This page", "Questa pagina"),
    "pageCardText": ("YouTube doesn't use standard HLS/DASH playlists: the local app can analyse the page with yt-dlp.",
                     "YouTube non usa playlist HLS/DASH standard: l'app locale può analizzare la pagina con yt-dlp."),
    "pageCardButton": ("Analyse with yt-dlp", "Analizza con yt-dlp"),
    # recorder (popup)
    "recConvert": ("Convert recordings to the default format", "Converti le registrazioni nel formato predefinito"),
    "recConvertHelp": ("MKV: same tracks as the recorded WebM, no re-encoding. MP4: H.264 + AAC, recorded straight to H.264 where the browser allows it, otherwise converted on stop. When off, the browser's recorded WebM is saved.",
                       "MKV: stesse tracce del WebM registrato, senza ricodifica. MP4: H.264 + AAC, registrato direttamente in H.264 dove il browser lo permette, altrimenti convertito allo stop. Se disattivo, salva il WebM registrato dal browser."),
    "recSection": ("Videos on this page", "Video in questa pagina"),
    "recBoxTitle": ("Video calls and WebRTC videos", "Videochiamate e video WebRTC"),
    "recBoxHelp": ("Click a video on the page and record it.", "Clicca un video della pagina e registralo."),
    "recButton": ("● Record a video", "● Registra un video"),
    "recStopSave": ("stop and save", "stop e salva"),
    "recSaveAs": ("save…", "salva…"),
    "recDiscard": ("discard", "scarta"),
    # recorder (background, bridge, page panel)
    "recDefaultName": ("recording", "registrazione"),
    "errRestrictedPage": ("The browser doesn't let extensions access this page.", "Il browser non permette alle estensioni di accedere a questa pagina."),
    "errVideosNotRecordable": ("The page's videos can't be recorded: start playback and try again.", "I video della pagina non si possono registrare: avvia la riproduzione e riprova."),
    "errNoVideos": ("No video found on this page.", "Nessun video trovato in questa pagina."),
    "errUnknownTab": ("Unknown tab", "Scheda sconosciuta"),
    "stageChooseWhere": ("Choose where to save", "Scegli dove salvare"),
    "rec_pickAgain": ("Pick the video again from the extension's button.", "Scegli di nuovo il video dal pulsante dell'estensione."),
    "rec_noAnswer": ("The extension isn't answering", "L'estensione non risponde"),
    "rec_notReady": ("The video hasn't started yet or doesn't expose its stream", "Il video non è ancora partito o non espone il suo flusso"),
    "rec_recordThis": ("● Record this video", "● Registra questo video"),
    "rec_recordCapture": ("● Record (capture from the player)", "● Registra (cattura dal player)"),
    "rec_notRecordable": ("Can't be recorded", "Non registrabile"),
    "rec_pickBanner": ("Fluxy: click the video to record", "Fluxy: clicca il video da registrare"),
    "rec_cancelPick": ("Cancel", "Annulla"),
    "rec_noTracks": ("The video has no active tracks", "Il video non ha tracce attive"),
    "rec_withAudio": ("with audio", "con audio"),
    "rec_noAudio": ("without audio", "senza audio"),
    "rec_capture": ("capture from the player", "cattura dal player"),
    "rec_addOthers": ("Add the audio of the page's other elements ($1)", "Aggiungi l'audio degli altri elementi della pagina ($1)"),
    "rec_saveHint": ("When you stop, choose where to save the file.", "Allo stop scegli dove salvare il file."),
    "rec_starting": ("Starting…", "Avvio…"),
    "rec_record": ("● Record", "● Registra"),
    "rec_cancel": ("cancel", "annulla"),
    "rec_stop": ("■ Stop", "■ Stop"),
    "rec_stopping": ("Closing the recording…", "Chiudo la registrazione…"),
    "rec_stopped": ("Recording finished: choose where to save the file.", "Registrazione terminata: scegli dove salvare il file."),
    "rec_aborted": ("Recording cancelled.", "Registrazione annullata."),
    "rec_cantRecord": ("Can't record this video: $1", "Impossibile registrare questo video: $1"),
    "rec_cantStart": ("Can't start the recording: $1", "Impossibile avviare la registrazione: $1"),
    "rec_recorderError": ("recorder error", "errore del registratore"),
    # background
    "stageQueued": ("Queued", "In coda"),
    "stageDone": ("Completed", "Completato"),
    "stageCancelled": ("Cancelled", "Annullato"),
    "stageError": ("Error", "Errore"),
    "errNotAnalysed": ("Stream not analysed", "Stream non analizzato"),
    "errPickOne": ("Select at least one video or audio stream", "Seleziona almeno un flusso video o audio"),
    "errNeedsHost": ("This stream needs the local app (ffmpeg + yt-dlp): install it from ⚙ → Engine.",
                     "Questo stream richiede l'app locale (ffmpeg + yt-dlp): installala da ⚙ → Motore."),
    "errEngineRestarted": ("Interrupted: the in-browser engine was restarted", "Interrotto: il motore del browser è stato riavviato"),
    "errSuspended": ("Interrupted: the browser suspended the extension", "Interrotto: il browser ha sospeso l'estensione"),
    "errSaveFailed": ("Saving failed: $1", "Salvataggio non riuscito: $1"),
    "errSaveInterrupted": ("Saving failed ($1)", "Salvataggio non riuscito ($1)"),
    "errWindowsInstaller": ("Automatic installation isn't available on Windows yet.", "Su Windows l'installazione automatica non è ancora disponibile."),
    "errMissingFile": ("File $1 missing from the extension: run ./build.py", "File $1 mancante nell'estensione: esegui ./build.py"),
    "errInstallerFailed": ("Installer download failed ($1)", "Download dell'installer non riuscito ($1)"),
    "errInstallerIncomplete": ("Installer download didn't complete", "Download dell'installer non completato"),
    "hostDisconnected": ("Local app disconnected", "Programma locale disconnesso"),
    "hostTimeout": ("The local app didn't answer in time", "Il programma locale non ha risposto in tempo"),
    "offscreenJustification": ("Downloads the segments and merges the tracks into one file", "Scarica i segmenti e unisce le tracce in un unico file"),
    # engine (also used by the offscreen document, which has no chrome.i18n: see engine/i18n.js)
    "eng_cancelled": ("Cancelled", "Annullato"),
    "eng_http": ("$1 from $2", "$1 da $2"),
    "eng_httpDenied": (" — the server refuses the request: reopen the page and press Detect to refresh the permissions",
                       " — il server rifiuta la richiesta: riapri la pagina e premi Rileva per aggiornare i permessi"),
    "eng_unsupportedEnc": ("Unsupported encryption: $1", "Cifratura non supportata: $1"),
    "eng_notHls": ("The file doesn't look like an HLS playlist", "Il file non sembra una playlist HLS"),
    "eng_emptyPlaylist": ("Empty playlist", "Playlist vuota"),
    "eng_unknownSegments": ("Unrecognised segment format ($1)", "Formato dei segmenti non riconosciuto ($1)"),
    "eng_noTrack": ("No $1 track in the downloaded file ($2)", "Nessuna traccia $1 nel file scaricato ($2)"),
    "eng_nothingToMux": ("No tracks to merge", "Nessuna traccia da unire"),
    "eng_noSpace": ("Not enough space: about $1 GB free needed, the browser allows $2 GB",
                    "Spazio insufficiente: servono circa $1 GB liberi, il browser ne concede $2"),
    "eng_stageDownload1": ("Download (1 track)", "Download (1 traccia)"),
    "eng_stageDownloadN": ("Download ($1 tracks)", "Download ($1 tracce)"),
    "eng_stageSubs": ("Subtitles", "Sottotitoli"),
    "eng_stageMux": ("Merging into one file", "Unione in un unico file"),
    "eng_stageSaving": ("Saving", "Salvataggio"),
    "eng_stageRecording": ("Recording", "Registrazione"),
    "eng_stagePreparing": ("Preparing the file", "Preparo il file"),
    "eng_stageConverting": ("Converting to $1", "Converto in $1"),
    "eng_convertImpossible": ("Conversion to $1 not possible: $2", "Conversione in $1 non possibile: $2"),
    "eng_writeFailed": ("Writing failed: $1", "Scrittura non riuscita: $1"),
    "eng_noData": ("Nothing was recorded", "Nessun dato registrato"),
    "eng_convertFailed": ("Conversion failed, saved as $1: $2", "Conversione non riuscita, salvato come $1: $2"),
}


def entry(text: str) -> dict:
    nums = sorted(set(re.findall(r"\$(\d)", text)))
    if not nums:
        return {"message": text}
    msg = re.sub(r"\$(\d)", r"$p\1$", text)
    return {"message": msg, "placeholders": {f"p{n}": {"content": f"${n}"} for n in nums}}


def write(ext_dir: Path):
    for i, lang in enumerate(("en", "it")):
        d = ext_dir / "_locales" / lang
        d.mkdir(parents=True, exist_ok=True)
        data = {k: entry(v[i]) for k, v in M.items()}
        (d / "messages.json").write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


ENGINE_KEYS = [k for k in M if k.startswith("eng_")] + ["stageCancelled", "stageError", "stageChooseWhere"]
REC_PAGE_KEYS = [k for k in M if k.startswith("rec_")]

if __name__ == "__main__":
    write(Path(__file__).resolve().parent.parent / "extension")
    print("✓ extension/_locales/{en,it}/messages.json")
