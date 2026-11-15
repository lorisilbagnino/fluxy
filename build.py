#!/usr/bin/env python3
"""Build Flux Capacitor for Chromium-based browsers and Firefox.

    ./build.py            -> dist/chromium/, dist/firefox/ (unpacked)
                             dist/flux-capacitor-<ver>-chromium.zip
                             dist/flux-capacitor-<ver>-firefox.xpi

`extension/` is the source and stays loadable unpacked in Chromium as is
(after a first ./build.py, which also copies the native host into
extension/native/ for the "install the local app" button).
Only the manifest differs between targets.
"""
import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "extension"
DIST = ROOT / "dist"
GECKO_ID = "flux-capacitor@fluxcapacitor.local"   # must match host/install.sh
SKIP = {".DS_Store"}
NATIVE = [ROOT / "host" / "flux_host.py", ROOT / "host" / "install.sh"]   # bundled for the installer button


def sync_native():
    dest = SRC / "native"
    dest.mkdir(exist_ok=True)
    for f in NATIVE:
        shutil.copy2(f, dest / f.name)


def chromium_manifest(m: dict) -> dict:
    return m


def firefox_manifest(m: dict) -> dict:
    m = dict(m)
    m.pop("key", None)                      # Chromium-only: fixes the extension ID
    m.pop("minimum_chrome_version", None)
    m["permissions"] = [p for p in m["permissions"] if p != "offscreen"]   # Chromium-only API
    sw = m.pop("background")["service_worker"]
    # Firefox MV3 has no service workers for extensions: event page with ES modules
    m["background"] = {"scripts": [sw], "type": "module"}
    m["browser_specific_settings"] = {
        "gecko": {
            "id": GECKO_ID,
            "strict_min_version": "128.0",  # storage.session, MV3 host-permission prompt
            "data_collection_permissions": {"required": ["none"]},
        }
    }
    return m


def build(target: str, transform) -> Path:
    out = DIST / target
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(SRC, out, ignore=shutil.ignore_patterns(*SKIP, "manifest.json"))
    manifest = transform(json.loads((SRC / "manifest.json").read_text(encoding="utf-8")))
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return out


def pack(folder: Path, dest: Path):
    dest.unlink(missing_ok=True)
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(folder.rglob("*")):
            if f.is_file():
                zf.write(f, f.relative_to(folder).as_posix())   # manifest.json at the archive root


def main():
    version = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))["version"]
    sync_native()
    DIST.mkdir(exist_ok=True)
    for target, transform, ext in (("chromium", chromium_manifest, "zip"), ("firefox", firefox_manifest, "xpi")):
        folder = build(target, transform)
        archive = DIST / f"flux-capacitor-{version}-{target}.{ext}"
        pack(folder, archive)
        print(f"✓ {target:9} {folder.relative_to(ROOT)}/  →  {archive.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
