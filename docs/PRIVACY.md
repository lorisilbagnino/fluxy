# Fluxy – Informativa sulla privacy

*Ultimo aggiornamento: 15 novembre 2026*

**In breve: Fluxy non raccoglie, non conserva e non invia a nessuno dati personali o sulla tua navigazione.**

## Cosa fa Fluxy con i dati

- **Rilevamento degli stream.** Quando premi "Rileva" su una scheda (o se attivi il rilevamento automatico),
  l'estensione osserva le richieste di rete di quella scheda per riconoscere le playlist video (HLS `.m3u8`, DASH
  `.mpd`). Insieme all'indirizzo della playlist conserva gli header che il player ha usato (Referer, Origin, Cookie,
  Authorization), perché il server del video li richiede per consegnare i segmenti.
- **Download.** Per scaricare lo stream, Fluxy invia quegli stessi header **solo ai server da cui proviene il
  video**, come farebbe il player della pagina.
- **Archiviazione locale.** L'elenco degli stream rilevati e dei download resta nella memoria di sessione del
  browser e viene cancellato alla chiusura. Le impostazioni restano nella memoria locale dell'estensione. I segmenti
  scaricati vengono scritti temporaneamente nello spazio privato dell'estensione (OPFS) e cancellati appena il file
  finale è salvato nella cartella Download.
- **Registrazione di un video.** Solo quando premi "Registra un video", Fluxy aggiunge alla scheda un pannello
  per scegliere il video; registra lo stream di quel solo video (ed eventualmente l'audio della pagina, se lo
  scegli) dentro il browser e lo salva dove indichi tu. Nulla viene inviato fuori dal tuo computer.
- **App locale (facoltativa).** Se la installi, l'estensione le passa gli stessi dati (indirizzi e header dello
  stream) per eseguire il download sul tuo computer. Il programma scrive un registro in `~/.cache/fluxy/host.log`
  con cookie e Authorization oscurati.

## Cosa Fluxy non fa

- Non invia dati allo sviluppatore né a terzi: non ci sono server di Fluxy, statistiche d'uso, pubblicità o
  tracciamento.
- Non legge il contenuto delle pagine (a parte il video che scegli di registrare) e non registra la cronologia di
  navigazione.
- Non vende né condivide dati.

## Contatti

Per domande: apri una segnalazione nel repository del progetto.

---

# Fluxy – Privacy policy

*Last updated: 15 November 2026*

**In short: Fluxy does not collect, store or send anyone personal data or data about your browsing.**

- **Stream detection.** When you press "Detect" on a tab (or turn on automatic detection), the extension watches
  that tab's network requests to recognise video playlists (HLS `.m3u8`, DASH `.mpd`). Along with the playlist
  address it keeps the headers the player used (Referer, Origin, Cookie, Authorization), because the video server
  requires them to deliver the segments.
- **Downloads.** Those headers are sent **only to the servers the video comes from**, as the page's player would.
- **Local storage.** Detected streams and downloads live in the browser's session storage and are cleared when the
  browser closes; settings stay in the extension's local storage. Downloaded segments are written temporarily to the
  extension's private storage (OPFS) and deleted as soon as the final file is saved to your Downloads folder.
- **Recording a video.** Only when you press "Record a video", Fluxy adds a panel to the tab to pick the video;
  it records that video's stream (and, if you choose so, the page's audio) inside the browser and saves it where
  you choose. Nothing leaves your computer.
- **Local app (optional).** If you install it, the extension passes it the same data (stream addresses and headers)
  to run the download on your computer. It keeps a log in `~/.cache/fluxy/host.log` with cookies and Authorization
  redacted.
- Fluxy has no servers, analytics, ads or tracking; it does not read page content (other than the video you choose to record), record browsing history, or sell
  or share any data.

Questions: open an issue in the project repository.
