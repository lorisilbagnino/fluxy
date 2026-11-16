# Fluxy – Informativa sulla privacy

*Ultimo aggiornamento: 16 novembre 2026*

**In breve: Fluxy non raccoglie, non conserva e non invia a nessuno dati personali o sulla tua navigazione.**

## Cosa fa Fluxy con i dati

- **Video della pagina.** Quando apri il popup, Fluxy legge la scheda attiva (comprese le sue cornici) per trovare
  i video che si possono salvare senza avviarli: elementi `<video>`, link a file video, metadati della pagina,
  indirizzi di playlist nella configurazione del player e player incorporati di altri siti. Conserva solo questi
  indirizzi e il titolo, nella memoria di sessione; non legge altro della pagina e non lo invia a nessuno.
- **Rilevamento degli stream.** Quando premi "Rileva" su una scheda (o se attivi il rilevamento automatico),
  l'estensione osserva le richieste di rete di quella scheda per riconoscere le playlist video (HLS `.m3u8`, DASH
  `.mpd`). Insieme all'indirizzo della playlist conserva gli header che il player ha usato (Referer, Origin, Cookie,
  Authorization), perché il server del video li richiede per consegnare i segmenti.
- **Download.** Per scaricare lo stream, Fluxy invia quegli stessi header **solo ai server da cui proviene il
  video**, come farebbe il player della pagina.
- **Archiviazione locale.** L'elenco degli stream rilevati resta nella memoria di sessione del browser e viene
  cancellato alla chiusura. La cronologia dei download (nome del file, titolo e indirizzo della pagina, tracce scelte,
  avanzamento) e le impostazioni restano nella memoria locale dell'estensione, finché non le cancelli ("Cancella
  cronologia" o "rimuovi"). Per i download in pausa, interrotti o falliti la cronologia conserva anche indirizzi e
  header dello stream, così da poterli riprendere; quando un download è completato gli header (cookie compresi) vengono
  eliminati. I segmenti scaricati vengono scritti temporaneamente nello spazio privato dell'estensione (OPFS):
  vengono cancellati appena il file finale è salvato, oppure quando annulli o rimuovi un download incompleto.
- **App locale (facoltativa).** Se la installi, l'estensione le passa gli stessi dati (indirizzi e header dello
  stream) per eseguire il download sul tuo computer. Il programma scrive un registro in `~/.cache/fluxy/host.log`
  con cookie e Authorization oscurati.

## Cosa Fluxy non fa

- Non invia dati allo sviluppatore né a terzi: non ci sono server di Fluxy, statistiche d'uso, pubblicità o
  tracciamento.
- Non legge il contenuto delle pagine (a parte gli indirizzi dei video, come descritto sopra) e non registra la
  cronologia di navigazione.
- Non vende né condivide dati.

## Contatti

Per domande: apri una segnalazione nel repository del progetto.

---

# Fluxy – Privacy policy

*Last updated: 16 November 2026*

**In short: Fluxy does not collect, store or send anyone personal data or data about your browsing.**

- **Videos on the page.** When you open the popup, Fluxy reads the active tab (including its frames) to find videos
  that can be saved without playing them: `<video>` elements, links to video files, page metadata, playlist addresses
  in the player's configuration and embedded players of other sites. It keeps only those addresses and the title, in
  session storage; it reads nothing else from the page and sends it to no one.
- **Stream detection.** When you press "Detect" on a tab (or turn on automatic detection), the extension watches
  that tab's network requests to recognise video playlists (HLS `.m3u8`, DASH `.mpd`). Along with the playlist
  address it keeps the headers the player used (Referer, Origin, Cookie, Authorization), because the video server
  requires them to deliver the segments.
- **Downloads.** Those headers are sent **only to the servers the video comes from**, as the page's player would.
- **Local storage.** Detected streams live in the browser's session storage and are cleared when the browser
  closes. The download history (file name, page title and address, chosen tracks, progress) and the settings stay in
  the extension's local storage until you clear them ("Clear history" or "remove"). For paused, interrupted or failed
  downloads the history also keeps the stream addresses and headers, so they can be resumed; once a download has
  completed, the headers (cookies included) are deleted. Downloaded segments are written temporarily to the
  extension's private storage (OPFS) and deleted as soon as the final file is saved, or when you cancel or remove an
  unfinished download.
- **Local app (optional).** If you install it, the extension passes it the same data (stream addresses and headers)
  to run the download on your computer. It keeps a log in `~/.cache/fluxy/host.log` with cookies and Authorization
  redacted.
- Fluxy has no servers, analytics, ads or tracking; it does not read page content (other than the video addresses described above), record browsing history, or sell
  or share any data.

Questions: open an issue in the project repository.
