## Pacchetti

| File | Per | Come si installa |
|---|---|---|
| `fluxy-<ver>-chromium.zip` | Brave, Chrome, Chromium, Edge, Vivaldi | Estrai lo zip → `brave://extensions` (o `chrome://extensions`) → *Modalità sviluppatore* → *Carica estensione non pacchettizzata* → cartella estratta |
| `fluxy-<ver>-firefox.xpi` | Firefox, LibreWolf, Waterfox | Se firmato: trascinalo in una finestra di Firefox. Se non firmato: Firefox Developer Edition/Nightly con `xpinstall.signatures.required = false`, oppure `about:debugging` → *Carica componente aggiuntivo temporaneo* |
| `fluxy-<ver>-chrome-store.zip` | Chrome Web Store, Edge Add-ons | Solo per il caricamento negli store (senza `key`) |
| `fluxy_host.py`, `install.sh` | App locale (facoltativa) | Più comodo dal popup: ⚙ → *App locale* → *Installa app locale* |

Chromium non permette di installare estensioni `.crx` fuori dal Web Store: per questo il pacchetto è uno zip da caricare
in modalità sviluppatore.

Il motore nel browser non richiede altro. Per DASH o per salvare con ffmpeg: ⚙ → *App locale* → *Installa app locale*.

Novità e dettagli: vedi il README del repository.
