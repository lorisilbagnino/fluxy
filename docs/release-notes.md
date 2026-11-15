## Packages / Pacchetti

| File | For | How to install |
|---|---|---|
| `fluxy-<ver>-chromium.zip` | Brave, Chrome, Chromium, Edge, Vivaldi | Unzip → `chrome://extensions` → *Developer mode* → *Load unpacked* → the unzipped folder |
| `fluxy-<ver>-firefox.xpi` | Firefox, LibreWolf, Waterfox | Signed: drag it into a Firefox window. Unsigned: Firefox Developer Edition/Nightly with `xpinstall.signatures.required = false`, or `about:debugging` → *Load Temporary Add-on* |
| `fluxy-<ver>-chrome-store.zip`, `fluxy-<ver>-firefox-store.xpi` | Store uploads | Store builds: no YouTube, no fixed ID |
| `fluxy_host.py`, `install.sh` | Local app (optional) | Easier from the popup: ⚙ → *Local app* → *Install local app* |

Chromium doesn't install `.crx` files from outside the Web Store, hence a zip to load in developer mode.
The in-browser engine needs nothing else; the local app adds DASH, YouTube (GitHub build) and ffmpeg merging.

---

| File | Per | Come si installa |
|---|---|---|
| `fluxy-<ver>-chromium.zip` | Brave, Chrome, Chromium, Edge, Vivaldi | Estrai → `chrome://extensions` → *Modalità sviluppatore* → *Carica estensione non pacchettizzata* → cartella estratta |
| `fluxy-<ver>-firefox.xpi` | Firefox, LibreWolf, Waterfox | Firmato: trascinalo in una finestra di Firefox. Non firmato: Developer Edition/Nightly con `xpinstall.signatures.required = false`, oppure `about:debugging` → *Carica componente aggiuntivo temporaneo* |
| `fluxy-<ver>-chrome-store.zip`, `fluxy-<ver>-firefox-store.xpi` | Caricamento negli store | Versioni store: senza YouTube, senza ID fisso |
| `fluxy_host.py`, `install.sh` | App locale (facoltativa) | Più comodo dal popup: ⚙ → *App locale* → *Installa app locale* |

Chromium non installa `.crx` fuori dal Web Store: per questo il pacchetto è uno zip da caricare in modalità
sviluppatore. Il motore nel browser non richiede altro; l'app locale aggiunge DASH, YouTube (versione GitHub) e
l'unione con ffmpeg.
