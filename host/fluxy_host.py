#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 lorisilbagnino — Fluxy, https://github.com/lorisilbagnino/fluxy (see ADDITIONAL-TERMS.md)
"""Fluxy native messaging host.

Speaks the Chrome native messaging protocol on stdin/stdout (4-byte little
endian length + UTF-8 JSON). Probes HLS/DASH manifests, downloads the selected
renditions with yt-dlp / ffmpeg and muxes them into one MKV/MP4 without
re-encoding (stream copy). Also casts streams to Chromecasts and DLNA TVs.

Can also be run by hand for debugging:
    fluxy_host.py probe <url> [Header: value ...]
"""
from __future__ import annotations

import glob
import hashlib
import html
import http.server
import json
import os
import re
import secrets
import shutil
import signal
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

VERSION = "0.13.0"
CACHE_DIR = os.path.join(os.path.expanduser("~/.cache"), "fluxy")
LOG_FILE = os.path.join(CACHE_DIR, "host.log")
UA_FALLBACK = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
               "(KHTML, like Gecko) Chrome/140.0 Safari/537.36")

os.makedirs(CACHE_DIR, exist_ok=True)


SECRET_RE = re.compile(r"((?:cookie|authorization)\s*:\s*)[^\r\n]*?(?=\\r\\n|\r\n| --|$)", re.I)


def redact(text: str) -> str:
    return SECRET_RE.sub(r"\1<redacted>", text)


def log(*args):
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(time.strftime("%Y-%m-%d %H:%M:%S ") + " ".join(str(a) for a in args) + "\n")
    except OSError:
        pass


# --------------------------------------------------------------------------
# Native messaging I/O
# --------------------------------------------------------------------------
_out_lock = threading.Lock()


def send(msg: dict):
    data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    with _out_lock:
        try:
            sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
            sys.stdout.buffer.flush()
        except (BrokenPipeError, OSError, ValueError):
            pass  # browser went away; keep working (downloads finish anyway)


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("<I", raw)
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode("utf-8"))


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
LANG_2_TO_3 = {
    "it": "ita", "en": "eng", "fr": "fre", "de": "ger", "es": "spa", "pt": "por",
    "ja": "jpn", "ko": "kor", "zh": "chi", "ru": "rus", "ar": "ara", "nl": "dut",
    "sv": "swe", "no": "nor", "nb": "nob", "da": "dan", "fi": "fin", "pl": "pol",
    "cs": "cze", "sk": "slo", "hu": "hun", "ro": "rum", "el": "gre", "tr": "tur",
    "he": "heb", "hi": "hin", "th": "tha", "vi": "vie", "id": "ind", "ms": "may",
    "uk": "ukr", "bg": "bul", "hr": "hrv", "sr": "srp", "sl": "slv", "ca": "cat",
    "eu": "baq", "gl": "glg", "et": "est", "lv": "lav", "lt": "lit", "fa": "per",
    "ta": "tam", "te": "tel", "bn": "ben", "ur": "urd", "fil": "fil", "tl": "tgl",
}


# --------------------------------------------------------------------------
# Messages shown in the extension: English, plus Italian
# --------------------------------------------------------------------------
UI_LANG = "en"
TEXT = {
    "it": {
        "Starting": "Avvio",
        "Completed": "Completato",
        "Cancelled": "Annullato",
        "Error": "Errore",
        "Download {label} ({i}/{n})": "Download {label} ({i}/{n})",
        "Subtitles {lang} ({i}/{n})": "Sottotitoli {lang} ({i}/{n})",
        "Merging into one file": "Unione in un unico file",
        "Paused": "In pausa",
        "The TV didn't answer": "La TV non ha risposto",
        "The TV couldn't start the player ({reason})": "La TV non è riuscita ad avviare il lettore ({reason})",
        "The TV refused the stream ({reason})": "La TV ha rifiutato lo stream ({reason})",
        "The TV doesn't support {what}": "La TV non supporta {what}",
        "The TV couldn't play the stream": "La TV non è riuscita a riprodurre lo stream",
        "The TV reported an error: {reason}": "La TV ha segnalato un errore: {reason}",
        "Connection to the TV lost": "Connessione con la TV persa",
        "This video has separate audio and video: use the local app route": "Questo video ha audio e video separati: usa il percorso tramite app locale",
        "This TV can't play this stream by itself: use the local app route": "Questa TV non può riprodurre lo stream da sola: usa il percorso tramite app locale",
        "TV not found: search again": "TV non trovata: cerca di nuovo",
        "No TV answers at {address}": "Nessuna TV risponde all'indirizzo {address}",
        "Downloading {n} tracks": "Download di {n} tracce in parallelo",
        "Nothing left to download: every track was skipped": "Niente da scaricare: tutte le tracce sono state saltate",
        "{label} file not found after the download": "File {label} non trovato dopo il download",
        "{lang} subtitles not downloaded": "Sottotitoli {lang} non scaricati",
        "{lang} subtitles are empty": "Sottotitoli {lang} vuoti",
        "The file doesn't look like an HLS playlist or a DASH manifest": "Il file non sembra una playlist HLS o un manifest DASH",
        "install ffmpeg and yt-dlp with your distribution's package manager": "installa ffmpeg e yt-dlp con il gestore pacchetti della tua distribuzione",
        "add python3Packages.pycryptodomex to yt-dlp's environment": "aggiungi python3Packages.pycryptodomex all'ambiente di yt-dlp",
        "download the latest official executable from github.com/yt-dlp/yt-dlp/releases": "scarica l'eseguibile ufficiale aggiornato da github.com/yt-dlp/yt-dlp/releases",
        "full ffmpeg: RPM Fusion repository": "ffmpeg completo: repository RPM Fusion",
    },
}


def T(text: str, **kw) -> str:
    """Translates an English message into the extension's UI language."""
    out = TEXT.get(UI_LANG.split("-")[0].lower(), {}).get(text, text)
    return out.format(**kw) if kw else out


def lang3(code: str | None) -> str:
    if not code:
        return "und"
    c = code.strip().lower().replace("_", "-").split("-")[0]
    if len(c) == 3:
        return c
    return LANG_2_TO_3.get(c, "und")


def clean_headers(headers: dict | None) -> dict:
    out = {}
    for k, v in (headers or {}).items():
        if v is None:
            continue
        out[str(k)] = str(v)
    if not any(k.lower() == "user-agent" for k in out):
        out["User-Agent"] = UA_FALLBACK
    return out


def http_get(url: str, headers: dict, timeout=20) -> tuple[str, str, str]:
    """Returns (text, final_url, content_type)."""
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read(20 * 1024 * 1024)
        ctype = resp.headers.get("Content-Type", "")
        return data.decode("utf-8", "replace"), resp.geturl(), ctype


def safe_filename(name: str) -> str:
    name = re.sub(r'[\x00-\x1f/\\:*?"<>|]+', " ", name or "").strip(" .")
    name = re.sub(r"\s+", " ", name)
    return name[:180] or "video"


def unique_path(path: str) -> str:
    if not os.path.exists(path):
        return path
    base, ext = os.path.splitext(path)
    i = 2
    while os.path.exists(f"{base} ({i}){ext}"):
        i += 1
    return f"{base} ({i}){ext}"


VIDEO_CODEC_PREFIXES = ("avc", "hvc", "hev", "av01", "vp09", "vp8", "vp9", "dvh", "dva", "mp4v")


def split_codecs(codecs: str | None):
    v, a = [], []
    for c in (codecs or "").split(","):
        c = c.strip()
        if not c:
            continue
        if c.lower().startswith(VIDEO_CODEC_PREFIXES):
            v.append(c)
        elif c.lower().startswith(("stpp", "wvtt")):
            continue
        else:
            a.append(c)
    return v, a


def pretty_codec(c: str | None) -> str:
    if not c:
        return ""
    lc = c.lower()
    table = [
        ("avc1", "H.264"), ("avc3", "H.264"), ("hvc1", "HEVC"), ("hev1", "HEVC"),
        ("dvh", "Dolby Vision"), ("av01", "AV1"), ("vp09", "VP9"), ("vp9", "VP9"),
        ("mp4a.40.5", "HE-AAC"), ("mp4a.40.29", "HE-AACv2"), ("mp4a.40.2", "AAC"),
        ("mp4a", "AAC"), ("ac-3", "AC3"), ("ec-3", "E-AC3"), ("ac-4", "AC4"),
        ("opus", "Opus"), ("flac", "FLAC"), ("mp3", "MP3"), ("aac", "AAC"),
        ("h264", "H.264"), ("hevc", "HEVC"), ("eac3", "E-AC3"), ("ac3", "AC3"),
    ]
    for prefix, name in table:
        if lc.startswith(prefix):
            return name
    return c


# --------------------------------------------------------------------------
# HLS parsing
# --------------------------------------------------------------------------
ATTR_RE = re.compile(r'([A-Z0-9-]+)=("[^"]*"|[^,]*)')


def parse_attrs(s: str) -> dict:
    return {k: v.strip('"') for k, v in ATTR_RE.findall(s)}


def parse_hls_master(text: str, base: str) -> dict:
    lines = [l.strip() for l in text.splitlines()]
    media, variants, session_keys = [], [], []
    pending = None
    for line in lines:
        if line.startswith("#EXT-X-MEDIA:"):
            a = parse_attrs(line[len("#EXT-X-MEDIA:"):])
            if a.get("URI"):
                a["URI"] = urllib.parse.urljoin(base, a["URI"])
            media.append(a)
        elif line.startswith("#EXT-X-STREAM-INF:"):
            pending = parse_attrs(line[len("#EXT-X-STREAM-INF:"):])
        elif line.startswith("#EXT-X-SESSION-KEY:"):
            session_keys.append(parse_attrs(line[len("#EXT-X-SESSION-KEY:"):]))
        elif line and not line.startswith("#") and pending is not None:
            pending["URI"] = urllib.parse.urljoin(base, line)
            variants.append(pending)
            pending = None
    return {"media": media, "variants": variants, "session_keys": session_keys}


def parse_hls_media(text: str) -> dict:
    duration, keys, segs = 0.0, [], 0
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("#EXTINF:"):
            try:
                duration += float(line[8:].split(",")[0])
            except ValueError:
                pass
            segs += 1
        elif line.startswith("#EXT-X-KEY:"):
            keys.append(parse_attrs(line[len("#EXT-X-KEY:"):]))
    live = "#EXT-X-ENDLIST" not in text
    return {"duration": duration, "keys": keys, "segments": segs, "live": live}


def drm_from_keys(keys: list[dict]) -> tuple[str | None, str | None]:
    """Returns (drm_reason, clear_encryption)."""
    clear = None
    for k in keys:
        method = (k.get("METHOD") or "").upper()
        fmt = (k.get("KEYFORMAT") or "identity").lower()
        if method in ("", "NONE"):
            continue
        if method == "AES-128" and fmt == "identity":
            clear = "AES-128"
            continue
        if "widevine" in fmt or "edef8ba9" in fmt:
            return "Widevine", clear
        if "playready" in fmt or "9a04f079" in fmt:
            return "PlayReady", clear
        if "fairplay" in fmt or fmt == "com.apple.streamingkeydelivery":
            return "FairPlay", clear
        return f"{method} ({fmt})", clear
    return None, clear


def probe_hls(url: str, headers: dict, text: str, final_url: str) -> dict:
    if "#EXT-X-STREAM-INF" not in text:
        # A media playlist on its own
        info = parse_hls_media(text)
        drm, enc = drm_from_keys(info["keys"])
        meta = ffprobe_meta(final_url, headers)
        v = {
            "id": "v0", "url": final_url, "width": meta.get("width"), "height": meta.get("height"),
            "bandwidth": None, "codec": meta.get("vcodec"), "fps": meta.get("fps"),
            "hasAudio": bool(meta.get("acodec")), "audioCodec": meta.get("acodec"),
        }
        result = {
            "kind": "hls", "master": False, "duration": info["duration"] or None, "live": info["live"],
            "drm": drm, "encryption": enc, "video": [], "audio": [], "subs": [], "childUrls": [],
        }
        if meta.get("vcodec") or not meta.get("acodec"):
            result["video"] = [v]
        else:  # audio-only playlist
            result["audio"] = [{"id": "a0", "url": final_url, "lang": None, "name": "Audio",
                                "codec": meta.get("acodec"), "channels": meta.get("channels"),
                                "default": True}]
        return result

    m = parse_hls_master(text, final_url)
    group_audio_codec: dict[str, str] = {}
    for var in m["variants"]:
        _, ac = split_codecs(var.get("CODECS"))
        if var.get("AUDIO") and ac:
            group_audio_codec.setdefault(var["AUDIO"], ac[0])

    audio_groups_with_uri = {x.get("GROUP-ID") for x in m["media"]
                             if x.get("TYPE") == "AUDIO" and x.get("URI")}

    # Video variants: dedupe by URL (same rendition is often repeated per audio group)
    videos: dict[str, dict] = {}
    for var in m["variants"]:
        uri = var["URI"]
        res = var.get("RESOLUTION", "")
        w = h = None
        if "x" in res:
            try:
                w, h = (int(x) for x in res.lower().split("x"))
            except ValueError:
                pass
        vc, ac = split_codecs(var.get("CODECS"))
        bw = int(var.get("AVERAGE-BANDWIDTH") or var.get("BANDWIDTH") or 0) or None
        separate_audio = bool(var.get("AUDIO")) and var.get("AUDIO") in audio_groups_with_uri
        has_audio = bool(ac) and not separate_audio
        if not vc and not w and ac:
            # audio-only variant listed as STREAM-INF
            continue
        fps = None
        try:
            fps = float(var["FRAME-RATE"]) if var.get("FRAME-RATE") else None
        except ValueError:
            pass
        cur = videos.get(uri)
        if cur is None or (bw or 0) < (cur["bandwidth"] or 0):
            # keep the lowest bandwidth reading (= closest to video-only bitrate)
            videos[uri] = {
                "url": uri, "width": w, "height": h, "bandwidth": bw,
                "codec": vc[0] if vc else None, "fps": fps,
                "hasAudio": has_audio, "audioCodec": ac[0] if (ac and has_audio) else None,
                "range": var.get("VIDEO-RANGE"),
            }
    video_list = sorted(videos.values(), key=lambda v: ((v["height"] or 0), (v["bandwidth"] or 0)), reverse=True)
    for i, v in enumerate(video_list):
        v["id"] = f"v{i}"

    audio_list, subs_list, seen = [], [], set()
    for x in m["media"]:
        t = x.get("TYPE")
        uri = x.get("URI")
        if not uri or uri in seen:
            continue
        seen.add(uri)
        if t == "AUDIO":
            ch = x.get("CHANNELS", "").split("/")[0] or None
            audio_list.append({
                "id": f"a{len(audio_list)}", "url": uri, "lang": x.get("LANGUAGE"),
                "name": x.get("NAME"), "codec": group_audio_codec.get(x.get("GROUP-ID")),
                "channels": ch, "default": x.get("DEFAULT") == "YES",
                "group": x.get("GROUP-ID"),
            })
        elif t == "SUBTITLES":
            subs_list.append({
                "id": f"s{len(subs_list)}", "url": uri, "lang": x.get("LANGUAGE"),
                "name": x.get("NAME"), "forced": x.get("FORCED") == "YES",
                "default": x.get("DEFAULT") == "YES",
            })

    drm, enc = drm_from_keys(m["session_keys"])
    duration, live = None, False
    # Inspect the best video playlist for duration + encryption
    probe_target = video_list[0]["url"] if video_list else (audio_list[0]["url"] if audio_list else None)
    if probe_target:
        try:
            mt, _, _ = http_get(probe_target, headers)
            info = parse_hls_media(mt)
            duration, live = info["duration"] or None, info["live"]
            d2, e2 = drm_from_keys(info["keys"])
            drm = drm or d2
            enc = enc or e2
        except Exception as e:  # noqa: BLE001
            log("media probe failed", probe_target, e)

    child = [v["url"] for v in video_list] + [a["url"] for a in audio_list] + [s["url"] for s in subs_list]
    return {
        "kind": "hls", "master": True, "duration": duration, "live": live, "drm": drm,
        "encryption": enc, "video": video_list, "audio": audio_list, "subs": subs_list,
        "childUrls": child,
    }


def ffprobe_meta(url: str, headers: dict) -> dict:
    cmd = ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams",
           *ffmpeg_header_args(headers), "-i", url]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=25).stdout
        data = json.loads(out or "{}")
    except Exception as e:  # noqa: BLE001
        log("ffprobe failed", e)
        return {}
    meta = {}
    for s in data.get("streams", []):
        if s.get("codec_type") == "video" and "vcodec" not in meta:
            meta["vcodec"] = s.get("codec_name")
            meta["width"], meta["height"] = s.get("width"), s.get("height")
            try:
                n, d = (s.get("avg_frame_rate") or "0/1").split("/")
                meta["fps"] = round(int(n) / int(d), 3) if int(d) else None
            except ValueError:
                pass
        elif s.get("codec_type") == "audio" and "acodec" not in meta:
            meta["acodec"] = s.get("codec_name")
            meta["channels"] = str(s.get("channels")) if s.get("channels") else None
    return meta


# --------------------------------------------------------------------------
# DASH (via yt-dlp)
# --------------------------------------------------------------------------
def ytdlp_header_args(headers: dict) -> list[str]:
    args = []
    for k, v in headers.items():
        args += ["--add-header", f"{k}:{v}"]
    return args


def ffmpeg_header_args(headers: dict) -> list[str]:
    hdrs = dict(headers)
    ua = None
    for k in list(hdrs):
        if k.lower() == "user-agent":
            ua = hdrs.pop(k)
    args = []
    if ua:
        args += ["-user_agent", ua]
    if hdrs:
        args += ["-headers", "".join(f"{k}: {v}\r\n" for k, v in hdrs.items())]
    return args


def info_cache_path(url: str) -> str:
    return os.path.join(CACHE_DIR, "probes", hashlib.sha1(url.encode()).hexdigest() + ".json")


def probe_ytdlp(url: str, headers: dict, kind: str = "dash") -> dict:
    """DASH manifests and whole pages (YouTube…): yt-dlp extracts the formats."""
    cmd = ["yt-dlp", "-J", "--no-warnings", "--no-playlist", *ytdlp_header_args(headers), url]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or "yt-dlp failed").strip().splitlines()[-1])
    info = json.loads(p.stdout)
    os.makedirs(os.path.dirname(info_cache_path(url)), exist_ok=True)
    with open(info_cache_path(url), "w", encoding="utf-8") as fh:
        fh.write(p.stdout)

    video, audio, drm = [], [], None
    for f in info.get("formats", []):
        if f.get("has_drm"):
            drm = "DRM"
        vc, ac = f.get("vcodec"), f.get("acodec")
        if vc and vc != "none":
            video.append({
                "id": f["format_id"], "formatId": f["format_id"], "url": f.get("url"),
                "width": f.get("width"), "height": f.get("height"),
                "bandwidth": int((f.get("vbr") or f.get("tbr") or 0) * 1000) or None,
                "codec": vc, "fps": f.get("fps"),
                "hasAudio": bool(ac and ac != "none"), "audioCodec": ac if ac != "none" else None,
            })
        elif ac and ac != "none":
            audio.append({
                "id": f["format_id"], "formatId": f["format_id"], "url": f.get("url"),
                "lang": f.get("language"), "name": f.get("format_note") or f.get("format_id"),
                "codec": ac, "channels": str(f.get("audio_channels")) if f.get("audio_channels") else None,
                "default": False, "bandwidth": int((f.get("abr") or f.get("tbr") or 0) * 1000) or None,
            })
    video.sort(key=lambda v: ((v["height"] or 0), (v["bandwidth"] or 0)), reverse=True)
    subs = []
    for lang, entries in (info.get("subtitles") or {}).items():
        subs.append({"id": f"s{len(subs)}", "lang": lang, "name": lang, "forced": False,
                     "default": False, "ytLang": lang,
                     "ext": entries[0].get("ext") if entries else None})
    return {
        "kind": kind, "extractor": info.get("extractor_key"),
        "master": True, "duration": info.get("duration"), "live": bool(info.get("is_live")),
        "drm": drm, "encryption": None, "video": video, "audio": audio, "subs": subs,
        "childUrls": [], "title": info.get("title"),
    }


def probe(url: str, headers: dict, kind: str | None = None) -> dict:
    headers = clean_headers(headers)
    if kind == "page":
        return probe_ytdlp(url, headers, "page")
    text, final_url, ctype = http_get(url, headers)
    head = text.lstrip()[:2000]
    if head.startswith("#EXTM3U"):
        return probe_hls(url, headers, text, final_url)
    if "<MPD" in head or "dash+xml" in ctype:
        return probe_ytdlp(url, headers)
    raise RuntimeError(T("The file doesn't look like an HLS playlist or a DASH manifest"))


# --------------------------------------------------------------------------
# Download jobs
# --------------------------------------------------------------------------
FF_TIME_RE = re.compile(r"time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)")
FF_SPEED_RE = re.compile(r"speed=\s*([\d.]+)x")
FF_SIZE_RE = re.compile(r"size=\s*(\d+)\s*[kK]i?B")


def ytdlp_env() -> dict:
    """What yt-dlp itself sees: its optional libraries and how it was installed.

    Checking our own interpreter would be wrong: yt-dlp may run from a pipx venv,
    a standalone binary (which bundles pycryptodomex), Homebrew, etc.
    """
    env = {"libs": [], "variant": None, "path": shutil.which("yt-dlp")}
    try:
        out = subprocess.run(["yt-dlp", "-v", "--ignore-config", "-s", ""], stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True, timeout=20).stdout
    except Exception:  # noqa: BLE001
        out = ""
    for line in out.splitlines():
        if "Optional libraries:" in line:
            env["libs"] = [x.strip() for x in line.split(":", 1)[1].split(",") if x.strip()]
        elif "yt-dlp version" in line:
            m = re.search(r"\(([^)]+)\)\s*$", line)
            env["variant"] = m[1] if m else None
    env["cryptodome"] = any(x.lower().startswith(("cryptodome", "pycryptodome", "crypto-"))
                            for x in env["libs"])
    return env


def os_release() -> dict:
    data = {}
    try:
        with open("/etc/os-release", encoding="utf-8") as fh:
            for line in fh:
                k, _, v = line.strip().partition("=")
                data[k] = v.strip('"')
    except OSError:
        pass
    return data


def install_hints(env: dict) -> dict:
    """Install commands suited to this system for the missing pieces."""
    path = os.path.realpath(env.get("path") or "")
    variant = (env.get("variant") or "").lower()
    crypto = None
    tools = None
    if sys.platform == "darwin":
        crypto = "brew reinstall yt-dlp" if "/homebrew/" in path or "/Cellar/" in path \
            else 'python3 -m pip install -U "yt-dlp[default]"'
        tools = "brew install ffmpeg yt-dlp"
    elif sys.platform.startswith("win"):
        crypto = "winget install yt-dlp.yt-dlp"
        tools = "winget install yt-dlp.yt-dlp Gyan.FFmpeg"
    else:
        osr = os_release()
        fam = " ".join([osr.get("ID", ""), osr.get("ID_LIKE", "")]).lower()
        if "arch" in fam:
            crypto, tools = "sudo pacman -S python-pycryptodomex", "sudo pacman -S ffmpeg yt-dlp"
        elif "debian" in fam or "ubuntu" in fam:
            crypto, tools = "sudo apt install python3-pycryptodome", "sudo apt install ffmpeg yt-dlp"
        elif "fedora" in fam or "rhel" in fam:
            crypto = "sudo dnf install python3-pycryptodomex"
            tools = "sudo dnf install ffmpeg yt-dlp   # " + T("full ffmpeg: RPM Fusion repository")
        elif "suse" in fam:
            crypto, tools = "sudo zypper install python3-pycryptodomex", "sudo zypper install ffmpeg yt-dlp"
        elif "alpine" in fam:
            crypto, tools = "sudo apk add py3-pycryptodomex", "sudo apk add ffmpeg yt-dlp"
        elif "nixos" in fam:
            crypto = T("add python3Packages.pycryptodomex to yt-dlp's environment")
            tools = "nix-env -iA nixpkgs.ffmpeg nixpkgs.yt-dlp"
        else:
            crypto = "python3 -m pip install pycryptodomex"
            tools = T("install ffmpeg and yt-dlp with your distribution's package manager")
    # yt-dlp not from the system package manager: fix it where it actually lives
    if "pipx" in path:
        crypto = "pipx inject yt-dlp pycryptodomex"
    elif variant == "pip" or "/.local/" in path or "site-packages" in path:
        crypto = 'python3 -m pip install -U "yt-dlp[default]"'
    elif "exe" in variant or variant == "zip":
        crypto = T("download the latest official executable from github.com/yt-dlp/yt-dlp/releases")
    return {"cryptodome": crypto, "tools": tools}


def track_list(spec: dict) -> list[dict]:
    """video, audio…, subtitles: the order of the per-track progress and of "skip" indices."""
    return ([spec["video"]] if spec.get("video") else []) + list(spec.get("audio") or []) + list(spec.get("subs") or [])


def track_key(role: str, t: dict) -> str:
    """Stable name for a track's temp file: survives URL refreshes and skipped neighbours on retry."""
    ident = "|".join(str(t.get(k) or "") for k in ("height", "lang", "name", "formatId", "codec", "forced", "ytLang"))
    return role[0] + hashlib.sha1(f"{role}|{ident}".encode()).hexdigest()[:10]


SRT_JUNK_RE = re.compile(r"^(WEBVTT\b.*|X-TIMESTAMP-MAP=.*|NOTE\b.*|STYLE)$")


def clean_srt(path: str):
    """ffmpeg reading segmented WebVTT: when a segment's last cue has no blank line after it, the next
    segment's header ("WEBVTT", "X-TIMESTAMP-MAP=...") ends up in the cue text. Drop those lines."""
    with open(path, encoding="utf-8", errors="replace") as fh:
        blocks = fh.read().replace("\r\n", "\n").split("\n\n")
    out = []
    for b in blocks:
        lines = [l for l in b.split("\n") if not SRT_JUNK_RE.match(l.strip())]
        if len(lines) >= 3 or (len(lines) == 2 and "-->" in lines[1]):
            out.append("\n".join(lines).strip("\n"))
    for i, b in enumerate(out, 1):   # renumber
        out[i - 1] = re.sub(r"^\d+\n", f"{i}\n", b, count=1)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n\n".join(out) + "\n")


class Cancelled(Exception):
    pass


class Skipped(Exception):
    """The user dropped this track while it was downloading."""


class Job:
    def __init__(self, job_id: str, spec: dict):
        self.id = job_id
        self.spec = spec
        self.procs: dict = {}            # task -> running Popen (tracks download in parallel)
        self.skipped: set[int] = {i for i, x in enumerate(track_list(spec)) if x.get("skip")}
        self.cancelled = False
        self.failing = False              # one task failed: the others are being stopped
        self.tmp = None
        self.last_emit = 0.0
        self.last_stage = None
        self.paused = False
        self.resumed = threading.Event()
        self.resumed.set()

    # -- reporting --------------------------------------------------------
    def emit(self, force=False, **fields):
        now = time.time()
        stage_changed = fields.get("stage") is not None and fields.get("stage") != self.last_stage
        if not force and not stage_changed and now - self.last_emit < 0.4:
            return
        self.last_emit = now
        if fields.get("stage") is not None:
            self.last_stage = fields["stage"]
        send({"type": "job", "jobId": self.id, **fields})

    # -- process helpers --------------------------------------------------
    def _signal(self, proc, sig):
        if proc and proc.poll() is None:
            try:
                os.killpg(proc.pid, sig)
            except OSError:
                pass

    def run(self, cmd: list[str], on_line=None, task="main"):
        self.resumed.wait()          # paused between two steps: don't start the next one
        if self.cancelled or self.failing:
            raise Cancelled()
        if task in self.skipped:
            raise Skipped()
        log("run", redact(" ".join(cmd)))
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, bufsize=0, start_new_session=True)
        self.procs[task] = proc
        if self.paused:
            self._signal(proc, signal.SIGSTOP)
        tail = []
        buf = b""
        fd = proc.stdout.fileno()
        # Split on \r as well as \n: ffmpeg (also when yt-dlp delegates to it)
        # rewrites its progress line with carriage returns.
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            buf += chunk
            *lines, buf = re.split(rb"[\r\n]", buf)
            for raw in lines:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                tail = (tail + [line])[-15:]
                if on_line:
                    try:
                        on_line(line)
                    except Exception:  # noqa: BLE001
                        log("on_line error", traceback.format_exc(limit=2))
        rc = proc.wait()
        self.procs.pop(task, None)
        if task in self.skipped:
            raise Skipped()
        if self.cancelled or self.failing:
            raise Cancelled()
        if rc != 0:
            msg = next((l for l in reversed(tail) if "ERROR" in l or "rror" in l), tail[-1] if tail else "")
            log("failed", rc, "\n".join(tail))
            raise RuntimeError(msg.strip() or f"exit code {rc}")

    def _stop(self, proc):
        if self.paused:
            self._signal(proc, signal.SIGCONT)   # a stopped process can't handle SIGTERM
        self._signal(proc, signal.SIGTERM)

    def cancel(self):
        self.cancelled = True
        for proc in list(self.procs.values()):
            self._stop(proc)
        self.paused = False
        self.resumed.set()

    def fail_fast(self):
        """A track failed: stop the others (finished tracks stay on disk for "retry")."""
        self.failing = True
        for proc in list(self.procs.values()):
            self._stop(proc)

    def skip(self, idx: int):
        """Drop one track (index in video, audio…, subtitles order): stop it, leave it out of the file."""
        self.skipped.add(idx)
        proc = self.procs.get(idx)
        if proc:
            self._stop(proc)

    # Pause = SIGSTOP on the running tool (yt-dlp / ffmpeg) and its children; nothing is lost.
    def pause(self):
        if self.paused or self.cancelled:
            return
        self.paused = True
        self.resumed.clear()
        for proc in list(self.procs.values()):
            self._signal(proc, signal.SIGSTOP)
        self.emit(force=True, state="paused", stage=T("Paused"), speed=None, eta=None)

    def resume(self):
        if not self.paused:
            return
        self.paused = False
        for proc in list(self.procs.values()):
            self._signal(proc, signal.SIGCONT)
        self.resumed.set()
        self.emit(force=True, state="running", stage=self.last_stage)

    # -- main -------------------------------------------------------------
    def start(self):
        threading.Thread(target=self._main, daemon=True).start()

    def _main(self):
        try:
            out = self._work()
            self.emit(force=True, state="done", progress=1, stage=T("Completed"), output=out)
        except Cancelled:
            self.emit(force=True, state="cancelled", stage=T("Cancelled"))
        except Exception as e:  # noqa: BLE001
            log("job error", traceback.format_exc())
            self.emit(force=True, state="error", stage=T("Error"), error=str(e), speed=None, eta=None)
            if self.tmp and os.path.isdir(self.tmp) and not self.spec.get("keepTemp"):
                return self._done()     # keep .flux-<id> for "retry" (removed by "discard")
        if self.tmp and os.path.isdir(self.tmp) and not self.spec.get("keepTemp"):
            shutil.rmtree(self.tmp, ignore_errors=True)
        self._done()

    def _done(self):
        JOBS.pop(self.id, None)

    def _work(self) -> str:
        s = self.spec
        headers = clean_headers(s.get("headers"))
        container = "mp4" if s.get("container") == "mp4" else "mkv"
        out_dir = os.path.expanduser(s.get("outputDir") or "~/Downloads")
        os.makedirs(out_dir, exist_ok=True)
        self.tmp = os.path.join(out_dir, f".flux-{self.id}")
        os.makedirs(self.tmp, exist_ok=True)
        duration = s.get("duration") or 0

        tracks = []  # (role, track dict)
        if s.get("video"):
            tracks.append(("video", s["video"]))
        for a in s.get("audio") or []:
            tracks.append(("audio", a))
        subs = s.get("subs") or []
        # per-track progress shown under the job's bar: [{k: video|audio|sub, l: label, f: 0..1}]
        tlabels = [(r, (f"{t['height']}p" if r == "video" and t.get("height") else (t.get("lang") or ""))) for r, t in tracks]
        tlabels += [("sub", (x.get("lang") or "") + (" forced" if x.get("forced") else "")) for x in subs]
        tf = [0.0] * len(tlabels)
        # bytes of each track: estimated from the declared bitrate until yt-dlp tells us more
        tb = [0] * len(tracks)
        tt = [int((t.get("bandwidth") or 0) * (duration or 0) / 8) for _, t in tracks]
        tdone = [False] * len(tracks)
        conns = {"v": None}      # shown as "connections" while a track is downloading
        ts = [0.0] * len(tlabels)  # current speed of each task (they run in parallel)

        # Progress weights from bitrate (fallbacks: video 3 Mbps, audio 128 kbps)
        weights = [(t.get("bandwidth") or (3_000_000 if r == "video" else 128_000)) for r, t in tracks]
        weights += [20_000] * len(subs)
        mux_weight = max(1, sum(weights)) * 0.04
        total_w = sum(weights) + mux_weight
        done_w = 0.0

        progress_lock = threading.Lock()

        def report(stage, frac_of_current, cur_w, idx=None, speed=None, eta=None, **extra):
            with progress_lock:
                if idx is not None:
                    tf[idx] = max(tf[idx], min(1.0, frac_of_current))
                    if speed is not None:
                        ts[idx] = speed or 0.0
                live = [i for i in range(len(tlabels)) if i not in self.skipped]
                known = all(tt[i] for i in live if i < len(tracks)) and any(i < len(tracks) for i in live)
                done_part = sum(weights[i] * tf[i] for i in live)
                if idx is None and cur_w:          # merge step (weight mux_weight)
                    done_part += cur_w * min(1.0, frac_of_current)
                live_w = sum(weights[i] for i in live) + mux_weight
                total_speed = sum(ts[i] for i in live)
                total_speed = total_speed if total_speed >= 1024 else None   # nothing measurable yet
                remaining = sum(max(0, tt[i] - tb[i]) for i in live if i < len(tracks))
                self.emit(state="running", stage=stage,
                          progress=min(0.999, done_part / live_w) if live_w else 0,
                          tracks=[{"k": k, "l": l, "f": round(f, 3), **({"s": True} if i in self.skipped else {})}
                                  for i, ((k, l), f) in enumerate(zip(tlabels, tf))],
                          bytes=sum(tb[i] for i in live if i < len(tracks)),
                          total=sum(tt[i] for i in live if i < len(tracks)) if known else None,
                          approx=not all(tdone[i] for i in live if i < len(tracks)),
                          conns=conns["v"], speed=total_speed,
                          eta=(remaining / total_speed) if total_speed and remaining else eta, **extra)

        n = len(tracks)
        frag_total = int(s.get("fragments") or 8)
        dl_tasks = [i for i in range(n) if i not in self.skipped]
        # connections split among the tracks so that they add up to the setting (at least one each)
        share = {i: max(1, frag_total // max(1, len(dl_tasks)) + (1 if r < frag_total % max(1, len(dl_tasks)) else 0))
                 for r, i in enumerate(dl_tasks)}
        rate_each = int(s["speedLimit"] / max(1, len(dl_tasks))) if s.get("speedLimit") else 0
        files_by = {}       # i -> (role, t, path)
        subs_by = {}        # j -> (sub, path)
        errors = []

        def download_track(i, role, t):
            label = "video" if role == "video" else f"audio {t.get('lang') or ''}".strip()
            stage = T("Download {label} ({i}/{n})", label=label, i=i + 1, n=n) if n == 1 else T("Downloading {n} tracks", n=len(dl_tasks))
            prefix = os.path.join(self.tmp, track_key(role, t))
            marker = prefix + ".done"
            found = [f for f in glob.glob(prefix + ".*") if not f.endswith((".json", ".part", ".ytdl", ".done"))]
            if os.path.exists(marker) and found:          # finished in an earlier attempt
                files_by[i] = (role, t, found[0])
                tb[i] = tt[i] = os.path.getsize(found[0])
                tdone[i] = True
                report(stage, 1.0, weights[i], idx=i)
                return
            for f in glob.glob(prefix + ".*"):            # leftovers of an interrupted attempt
                os.remove(f)
            ff = {"t": None, "bytes": None}

            def on_line(line):
                m = FF_TIME_RE.search(line)
                if m and duration:
                    # yt-dlp delegated the download to ffmpeg (e.g. AES-128 without pycryptodomex)
                    pos = int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])
                    sz = FF_SIZE_RE.search(line)
                    speed = None
                    if sz:
                        nbytes = int(sz[1]) * 1024
                        tb[i] = nbytes
                        now = time.time()
                        if ff["t"] and now > ff["t"]:
                            speed = (nbytes - ff["bytes"]) / (now - ff["t"])
                        ff["t"], ff["bytes"] = now, nbytes
                    report(stage, min(1, pos / duration), weights[i], idx=i, speed=speed)
                elif line.startswith("FCPROG "):
                    pr = json.loads(line[7:])
                    total = pr.get("total_bytes") or pr.get("total_bytes_estimate")
                    frac = (pr.get("downloaded_bytes") or 0) / total if total else 0
                    tb[i] = int(pr.get("downloaded_bytes") or 0)
                    if total:
                        tt[i] = int(total)
                    if pr.get("fragment_count"):
                        frac = max(frac, (pr.get("fragment_index") or 0) / pr["fragment_count"])
                    report(stage, frac, weights[i], idx=i, speed=pr.get("speed"), eta=pr.get("eta"))

            cmd = ["yt-dlp", "--newline", "--no-warnings", "--no-playlist", "--no-mtime",
                   "--no-part", "--fixup", "never", "-N", str(share[i]),
                   "--retries", "10", "--fragment-retries", "20",
                   "--retry-sleep", "http:exp=1:60", "--retry-sleep", "fragment:exp=1:60",
                   "--progress-template", "download:FCPROG %(progress)j",
                   *ytdlp_header_args(headers), "-o", prefix + ".%(ext)s"]
            if rate_each:
                cmd += ["--limit-rate", str(max(1024, rate_each))]   # bytes/s
            if t.get("formatId"):
                info_path = info_cache_path(s["url"])
                if not os.path.exists(info_path):
                    probe_ytdlp(s["url"], headers)
                cmd += ["--load-info-json", info_path, "-f", t["formatId"]]
            else:
                cmd += [t["url"]]
            self.run(cmd, on_line, task=i)
            found = [f for f in glob.glob(prefix + ".*") if not f.endswith((".json", ".part", ".ytdl", ".done"))]
            if not found:
                raise RuntimeError(T("{label} file not found after the download", label=label))
            open(marker, "w").close()
            files_by[i] = (role, t, found[0])
            tb[i] = tt[i] = os.path.getsize(found[0])
            tdone[i] = True
            ts[i] = 0.0
            report(stage, 1.0, weights[i], idx=i, speed=0)

        def download_sub(j, sub):
            idx = n + j
            stage = T("Subtitles {lang} ({i}/{n})", lang=sub.get("lang") or "", i=j + 1, n=len(subs))
            dst = os.path.join(self.tmp, f"{track_key('sub', sub)}.srt")
            if sub.get("ytLang"):
                pfx = dst[:-4]
                self.run(["yt-dlp", "--no-warnings", "--skip-download", "--write-subs",
                          "--sub-langs", "^" + re.escape(sub["ytLang"]) + "$", "--convert-subs", "srt",
                          *ytdlp_header_args(headers), "--load-info-json", info_cache_path(s["url"]),
                          "-o", pfx + ".%(ext)s"], task=idx)
                got = [g for g in glob.glob(pfx + ".*.srt")]
                if not got:
                    raise RuntimeError(T("{lang} subtitles not downloaded", lang=sub.get("lang")))
                os.replace(got[0], dst)
            else:
                for attempt in range(3):
                    try:
                        self.run(["ffmpeg", "-nostdin", "-v", "error", "-y", *ffmpeg_header_args(headers),
                                  "-extension_picky", "0", "-i", sub["url"], "-map", "0:s:0?",
                                  "-c:s", "srt", dst], task=idx)
                        break
                    except (Cancelled, Skipped):
                        raise
                    except RuntimeError:
                        if attempt == 2:
                            raise
                        log("subtitles failed, retrying", attempt + 1)
                        time.sleep(2 * (attempt + 1))
                if not os.path.exists(dst) or os.path.getsize(dst) == 0:
                    raise RuntimeError(T("{lang} subtitles are empty", lang=sub.get("lang")))
                clean_srt(dst)
            subs_by[j] = (sub, dst)
            report(stage, 1.0, weights[idx], idx=idx)

        def worker(fn, *args):
            try:
                fn(*args)
            except (Skipped, Cancelled):
                pass
            except Exception as e:  # noqa: BLE001
                if not self.failing and not self.cancelled:
                    errors.append(e)
                    self.fail_fast()

        conns["v"] = {"active": None, "max": sum(share.values())} if dl_tasks else None
        report(T("Downloading {n} tracks", n=len(dl_tasks)) if n != 1 else T("Download {label} ({i}/{n})", label="video" if tracks[0][0] == "video" else "audio", i=1, n=1), 0, 0)
        threads = [threading.Thread(target=worker, args=(download_track, i, role, t), daemon=True)
                   for i, (role, t) in enumerate(tracks) if i not in self.skipped]
        threads += [threading.Thread(target=worker, args=(download_sub, j, sub), daemon=True)
                    for j, sub in enumerate(subs) if n + j not in self.skipped]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        conns["v"] = None
        if self.cancelled:
            raise Cancelled()
        if errors:
            raise errors[0]
        # what is left after the skipped tracks, in the original order
        files = [files_by[i] for i in sorted(files_by) if i not in self.skipped]
        sub_files = [subs_by[j] for j in sorted(subs_by) if n + j not in self.skipped]
        if not files and not sub_files:
            raise RuntimeError(T("Nothing left to download: every track was skipped"))
        done_w = sum(weights[i] for i in range(len(tlabels)) if i not in self.skipped)

        # ---- subtitles only: one .srt per track next to each other -------------
        if not files:
            stem = safe_filename(s.get("filename") or s.get("title") or "video")
            saved, seen = [], set()
            for sub, path in sub_files:
                ext = f"{(sub.get('lang') or '').lower()}.srt" if lang3(sub.get("lang")) != "und" else "srt"
                if sub.get("forced"):
                    ext = ext[:-3] + "forced.srt"
                k = 2
                while ext in seen:
                    ext = re.sub(r"(\.\d+)?\.srt$", f".{k}.srt", ext); k += 1
                seen.add(ext)
                dst = unique_path(os.path.join(out_dir, f"{stem}.{ext}"))
                shutil.move(path, dst)
                saved.append(dst)
            if not saved:
                raise RuntimeError(T("{lang} subtitles are empty", lang=""))
            return saved[0]

        # ---- mux ----------------------------------------------------------
        title = s.get("title") or "video"
        tmp_out = os.path.join(self.tmp, "out." + container)
        cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-progress", "pipe:1", "-nostats"]
        for _, _, f in files:
            cmd += ["-i", f]
        for _, f in sub_files:
            cmd += ["-i", f]
        maps, meta = [], []
        has_sep_audio = any(r == "audio" for r, _, _ in files)
        a_idx = 0
        for idx, (role, t, _) in enumerate(files):
            if role == "video":
                maps += ["-map", f"{idx}:v:0"]
                meta += ["-disposition:v:0", "default"]
                if not has_sep_audio:
                    maps += ["-map", f"{idx}:a?"]
            else:
                maps += ["-map", f"{idx}:a:0"]
                meta += [f"-metadata:s:a:{a_idx}", f"language={lang3(t.get('lang'))}"]
                if t.get("name"):
                    meta += [f"-metadata:s:a:{a_idx}", f"title={t['name']}"]
                meta += [f"-disposition:a:{a_idx}", "default" if a_idx == 0 else "0"]
                a_idx += 1
        for k, (sub, _) in enumerate(sub_files):
            maps += ["-map", f"{len(files) + k}:0"]
            meta += [f"-metadata:s:s:{k}", f"language={lang3(sub.get('lang'))}"]
            name = sub.get("name") or ""
            if sub.get("forced") and "forced" not in name.lower():
                name = (name + " (forced)").strip()
            if name:
                meta += [f"-metadata:s:s:{k}", f"title={name}"]
            meta += [f"-disposition:s:{k}", "forced" if sub.get("forced") else "0"]
        cmd += maps + ["-c", "copy"]
        if sub_files:
            cmd += ["-c:s", "mov_text" if container == "mp4" else "srt"]
        if container == "mp4":
            cmd += ["-tag:v", "hvc1"] if any(r == "video" and (t.get("codec") or "").lower().startswith(("hev1", "hvc1", "hevc"))
                                              for r, t, _ in files) else []
        cmd += meta + ["-metadata", f"title={title}", tmp_out]

        def on_mux(line):
            if line.startswith("out_time_us=") and duration:
                us = int(line.split("=", 1)[1] or 0)
                report(T("Merging into one file"), min(1, us / 1e6 / duration), mux_weight)

        report(T("Merging into one file"), 0, mux_weight)
        self.run(cmd, on_mux)
        # the name is read only now: it may have been changed while downloading ("rename")
        final = unique_path(os.path.join(out_dir, safe_filename(s.get("filename") or title) + "." + container))
        os.replace(tmp_out, final)
        return final


JOBS: dict[str, Job] = {}


# --------------------------------------------------------------------------
# Dispatcher
# --------------------------------------------------------------------------
# --------------------------------------------------------------------------
# Casting: Chromecast (Cast v2) and DLNA/UPnP renderers, standard library only
# --------------------------------------------------------------------------
# Discovery: mDNS (_googlecast._tcp) for Chromecasts, SSDP for DLNA MediaRenderers.
# Routes: "direct" = the TV fetches the original URL itself; "relay" = this app fetches the stream with the
# page's headers/cookies and serves it to the TV on the local network (also fixes CORS for Chromecasts).

CAST_APP_DEFAULT = "CC1AD845"   # Google's Default Media Receiver
NS_CONN = "urn:x-cast:com.google.cast.tp.connection"
NS_HB = "urn:x-cast:com.google.cast.tp.heartbeat"
NS_RECV = "urn:x-cast:com.google.cast.receiver"
NS_MEDIA = "urn:x-cast:com.google.cast.media"
RELAY_PORT = int(os.environ.get("FLUXY_RELAY_PORT") or 8790)   # TCP port the TVs connect to (relay route)
DEVICES: dict = {}               # id -> device description (last discovery)
CAST: dict = {"session": None}   # the active cast session (one at a time)


# ---- discovery -------------------------------------------------------------------------------
def _dns_name(name: str) -> bytes:
    return b"".join(bytes([len(p.encode())]) + p.encode() for p in name.split(".") if p) + b"\0"


def _dns_read_name(buf: bytes, off: int) -> tuple[str, int]:
    labels, end, jumps = [], None, 0
    while True:
        n = buf[off]
        if n == 0:
            off += 1
            break
        if n & 0xC0 == 0xC0:
            if end is None:
                end = off + 2
            off = ((n & 0x3F) << 8) | buf[off + 1]
            jumps += 1
            if jumps > 30:
                raise ValueError("dns loop")
            continue
        labels.append(buf[off + 1:off + 1 + n].decode("utf-8", "replace"))
        off += 1 + n
    return ".".join(labels), end if end is not None else off


def _dns_records(buf: bytes) -> list[tuple]:
    qd, an, ns, ar = struct.unpack(">4H", buf[4:12])
    off = 12
    for _ in range(qd):
        _, off = _dns_read_name(buf, off)
        off += 4
    out = []
    for _ in range(an + ns + ar):
        name, off = _dns_read_name(buf, off)
        rtype, _cls, _ttl, rdlen = struct.unpack(">HHIH", buf[off:off + 10])
        off += 10
        rd = buf[off:off + rdlen]
        if rtype == 12:                      # PTR
            out.append((name.lower(), "PTR", _dns_read_name(buf, off)[0]))
        elif rtype == 33:                    # SRV
            port = struct.unpack(">H", rd[4:6])[0]
            out.append((name.lower(), "SRV", (port, _dns_read_name(buf, off + 6)[0].lower())))
        elif rtype == 16:                    # TXT
            txt, i = {}, 0
            while i < len(rd):
                n = rd[i]
                k, _, v = rd[i + 1:i + 1 + n].decode("utf-8", "replace").partition("=")
                txt[k] = v
                i += 1 + n
            out.append((name.lower(), "TXT", txt))
        elif rtype == 1 and rdlen == 4:      # A
            out.append((name.lower(), "A", socket.inet_ntoa(rd)))
        off += rdlen
    return out


def _mcast_socket(group: str, port: int) -> tuple[socket.socket, bool]:
    """UDP socket for a discovery protocol. Bound to the protocol's own port (shared with avahi & co.) when
    possible: many desktop firewalls drop replies sent to a random port but let the standard ones through."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    shared = False
    try:
        if hasattr(socket, "SO_REUSEPORT"):
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        sock.bind(("", port))
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP,
                        struct.pack("4s4s", socket.inet_aton(group), socket.inet_aton("0.0.0.0")))
        shared = True
    except OSError as e:
        log("discovery: can't share port", port, e)
        sock.close()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
    sock.settimeout(0.3)
    return sock, shared


def discover_chromecasts(timeout: float = 3.0) -> list[dict]:
    service = "_googlecast._tcp.local"
    sock, shared = _mcast_socket("224.0.0.251", 5353)
    # on port 5353 the answers come back by multicast; from a random port ask for a unicast answer (QU bit)
    query = struct.pack(">6H", 0, 0, 1, 0, 0, 0) + _dns_name(service) + struct.pack(">HH", 12, 1 if shared else 0x8001)
    recs, senders = [], {}
    end = time.time() + timeout
    sent = 0
    try:
        while time.time() < end:
            if sent < 3 and time.time() > end - timeout + sent * 0.8:
                try:
                    sock.sendto(query, ("224.0.0.251", 5353))
                except OSError as e:
                    log("mdns send", e)
                sent += 1
            try:
                data, addr = sock.recvfrom(9000)
            except socket.timeout:
                continue
            try:
                got = _dns_records(data)
            except (ValueError, IndexError, struct.error):
                continue
            recs += got
            for name, kind, _v in got:
                senders.setdefault(name, addr[0])
    finally:
        sock.close()
    ptr = {v.lower() for n, k, v in recs if k == "PTR" and n == service.lower()}
    srv = {n: v for n, k, v in recs if k == "SRV"}
    txt = {n: v for n, k, v in recs if k == "TXT"}
    a = {n: v for n, k, v in recs if k == "A"}
    out = []
    for inst in ptr:
        port, target = srv.get(inst, (8009, ""))
        host = a.get(target) or senders.get(inst) or senders.get(target)
        if not host:
            continue
        t = txt.get(inst, {})
        try:
            audio_only = not int(t.get("ca") or 1) & 1          # capability bit 0: video output
        except ValueError:
            audio_only = False
        out.append({"id": "cc:" + (t.get("id") or host), "kind": "chromecast", "name": t.get("fn") or inst.split(".")[0],
                    "model": t.get("md") or "Chromecast", "host": host, "port": port, "audioOnly": audio_only})
    return out


def _xml_text(el, path, ns):
    found = el.find(path, ns)
    return (found.text or "").strip() if found is not None and found.text else ""


def discover_dlna(timeout: float = 3.0) -> list[dict]:
    msg = ("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\n"
           "ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n").encode()
    sock, _shared = _mcast_socket("239.255.255.250", 1900)
    locations = set()
    end = time.time() + timeout
    sent = 0
    try:
        while time.time() < end:
            if sent < 2 and time.time() > end - timeout + sent:
                try:
                    sock.sendto(msg, ("239.255.255.250", 1900))
                except OSError as e:
                    log("ssdp send", e)
                sent += 1
            try:
                data, _addr = sock.recvfrom(9000)
            except socket.timeout:
                continue
            if data.startswith(b"M-SEARCH"):
                continue
            if data.startswith(b"NOTIFY") and not re.search(rb"^NT:.*MediaRenderer", data, re.I | re.M):
                continue                      # periodic announcements of other kinds of devices
            m = re.search(rb"^location:\s*(\S+)", data, re.I | re.M)
            if m:
                locations.add(m.group(1).decode("latin-1"))
    finally:
        sock.close()
    out = []
    for loc in locations:
        try:
            dev = dlna_device(loc)
        except Exception as e:  # noqa: BLE001
            log("dlna description", loc, e)
            continue
        if dev:
            out.append(dev)
    return out


def dlna_device(loc: str) -> dict | None:
    """A DLNA renderer from its description URL (the LOCATION of its SSDP answer)."""
    ns = {"d": "urn:schemas-upnp-org:device-1-0"}
    with urllib.request.urlopen(loc, timeout=3) as r:
        root = ET.fromstring(r.read())
    base = _xml_text(root, "d:URLBase", ns) or loc
    for dev in root.iter("{urn:schemas-upnp-org:device-1-0}device"):
        svcs = {}
        for s in dev.findall("d:serviceList/d:service", ns):
            st = _xml_text(s, "d:serviceType", ns)
            ctl = urllib.parse.urljoin(base, _xml_text(s, "d:controlURL", ns))
            if ":AVTransport:" in st:
                svcs["avt"] = (st, ctl)
            elif ":RenderingControl:" in st:
                svcs["rc"] = (st, ctl)
        if "avt" not in svcs:
            continue
        return {"id": "dlna:" + (_xml_text(dev, "d:UDN", ns) or loc), "kind": "dlna",
                "name": _xml_text(dev, "d:friendlyName", ns) or urllib.parse.urlparse(loc).hostname,
                "model": " ".join(x for x in (_xml_text(dev, "d:manufacturer", ns), _xml_text(dev, "d:modelName", ns)) if x),
                "host": urllib.parse.urlparse(loc).hostname, "services": svcs}
    return None


def discover(timeout: float = 3.0) -> list[dict]:
    found: list = []
    def run(fn):
        try:
            found.extend(fn(timeout))
        except Exception:  # noqa: BLE001
            log("discovery", fn.__name__, traceback.format_exc())
    ths = [threading.Thread(target=run, args=(f,), daemon=True) for f in (discover_chromecasts, discover_dlna)]
    for th in ths:
        th.start()
    for th in ths:
        th.join(timeout + 5)
    uniq = {d["id"]: d for d in found}
    DEVICES.update(uniq)
    return sorted(uniq.values(), key=lambda d: (d["kind"], d["name"].lower()))


def add_device(address: str) -> dict:
    """A TV the discovery can't see (firewall, other subnet): a Chromecast IP[:port] or a DLNA description URL."""
    address = address.strip()
    if address.startswith(("http://", "https://")):
        dev = dlna_device(address)
        if not dev:
            raise RuntimeError("no AVTransport")
    else:
        host, _, port = address.partition(":")
        c = CastV2(host, int(port or 8009), lambda ev: None)
        try:
            st = c.request("receiver-0", NS_RECV, {"type": "GET_STATUS"}, timeout=6)
        finally:
            c.close()
        if st.get("type") != "RECEIVER_STATUS":
            raise RuntimeError("not a Chromecast")
        name, model = f"Chromecast {host}", "Chromecast"
        try:      # the name set in Google Home, from the device's own setup page
            with urllib.request.urlopen(f"http://{host}:8008/setup/eureka_info?params=name,device_info", timeout=2) as r:
                info = json.loads(r.read())
                name = info.get("name") or name
                model = (info.get("device_info") or {}).get("model_name") or model
        except Exception:  # noqa: BLE001
            pass
        dev = {"id": f"cc:{host}:{port or 8009}", "kind": "chromecast", "name": name, "model": model,
               "host": host, "port": int(port or 8009), "audioOnly": False}
    DEVICES[dev["id"]] = dev
    return dev


def public_device(d: dict) -> dict:
    return {k: d.get(k) for k in ("id", "kind", "name", "model", "host", "audioOnly")}


# ---- Chromecast: Cast v2 over TLS, protobuf CastMessage written by hand ---------------------
def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def cast_encode(src: str, dst: str, ns: str, payload: str) -> bytes:
    def s(field, v):
        b = v.encode()
        return _varint(field << 3 | 2) + _varint(len(b)) + b
    return _varint(1 << 3) + _varint(0) + s(2, src) + s(3, dst) + s(4, ns) + _varint(5 << 3) + _varint(0) + s(6, payload)


def cast_decode(buf: bytes) -> dict:
    out, i = {}, 0
    while i < len(buf):
        key, shift = 0, 0
        while True:
            b = buf[i]; i += 1
            key |= (b & 0x7F) << shift; shift += 7
            if not b & 0x80:
                break
        field, wt = key >> 3, key & 7
        if wt == 0:
            v, shift = 0, 0
            while True:
                b = buf[i]; i += 1
                v |= (b & 0x7F) << shift; shift += 7
                if not b & 0x80:
                    break
            out[field] = v
        elif wt == 2:
            n, shift = 0, 0
            while True:
                b = buf[i]; i += 1
                n |= (b & 0x7F) << shift; shift += 7
                if not b & 0x80:
                    break
            out[field] = buf[i:i + n]
            i += n
        else:
            raise ValueError(f"wire type {wt}")
    return {"src": out.get(2, b"").decode(), "dst": out.get(3, b"").decode(), "ns": out.get(4, b"").decode(),
            "payload": out.get(6, b"").decode("utf-8", "replace")}


class CastV2:
    """One connection to a Chromecast, running Google's Default Media Receiver."""

    def __init__(self, host: str, port: int, on_event):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE      # Chromecasts use self-signed certificates
        raw = socket.create_connection((host, port), timeout=8)
        self.sock = ctx.wrap_socket(raw)
        self.sock.settimeout(None)
        self.on_event = on_event
        self.lock = threading.Lock()
        self.req = 0
        self.waiters: dict = {}
        self.transport = None
        self.app_session = None
        self.media_session = None
        self.closed = False
        self.send("receiver-0", NS_CONN, {"type": "CONNECT"})
        threading.Thread(target=self._reader, daemon=True).start()
        threading.Thread(target=self._heartbeat, daemon=True).start()

    def send(self, dst: str, ns: str, obj: dict):
        data = cast_encode("sender-0", dst, ns, json.dumps(obj))
        with self.lock:
            self.sock.sendall(struct.pack(">I", len(data)) + data)

    def request(self, dst: str, ns: str, obj: dict, timeout: float = 15) -> dict:
        with self.lock:
            self.req += 1
            rid = self.req
        box = {"ev": threading.Event(), "msg": None}
        self.waiters[rid] = box
        self.send(dst, ns, {**obj, "requestId": rid})
        if not box["ev"].wait(timeout):
            self.waiters.pop(rid, None)
            raise RuntimeError(T("The TV didn't answer"))
        return box["msg"]

    def _recv_exact(self, n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("closed")
            buf += chunk
        return buf

    def _reader(self):
        try:
            while not self.closed:
                n = struct.unpack(">I", self._recv_exact(4))[0]
                m = cast_decode(self._recv_exact(n))
                try:
                    p = json.loads(m["payload"]) if m["payload"] else {}
                except ValueError:
                    continue
                typ = p.get("type")
                if m["ns"] == NS_HB and typ == "PING":
                    self.send(m["src"], NS_HB, {"type": "PONG"})
                    continue
                if m["ns"] == NS_CONN and typ == "CLOSE" and m["src"] == self.transport:
                    self.transport = None
                    self.on_event({"type": "closed"})
                    continue
                if typ == "RECEIVER_STATUS":
                    self.on_event({"type": "receiver", "status": p.get("status") or {}})
                elif typ == "MEDIA_STATUS":
                    st = (p.get("status") or [None])[0]
                    if st:
                        self.media_session = st.get("mediaSessionId") or self.media_session
                        self.on_event({"type": "media", "status": st})
                elif typ in ("LOAD_FAILED", "LOAD_CANCELLED", "INVALID_REQUEST", "LAUNCH_ERROR", "ERROR"):
                    self.on_event({"type": "error", "error": p.get("reason") or p.get("detailedErrorCode") or typ, "raw": p})
                rid = p.get("requestId")
                if rid and rid in self.waiters:
                    box = self.waiters.pop(rid)
                    box["msg"] = p
                    box["ev"].set()
        except Exception as e:  # noqa: BLE001
            if not self.closed:
                log("cast reader", e)
                self.closed = True
                self.on_event({"type": "closed", "error": str(e)})

    def _heartbeat(self):
        while not self.closed:
            time.sleep(5)
            try:
                self.send("receiver-0", NS_HB, {"type": "PING"})
            except OSError:
                return

    def launch(self, app: str = CAST_APP_DEFAULT):
        r = self.request("receiver-0", NS_RECV, {"type": "LAUNCH", "appId": app}, timeout=25)
        deadline = time.time() + 20
        while True:
            apps = (r.get("status") or {}).get("applications") or []
            mine = next((a for a in apps if a.get("appId") == app and a.get("transportId")), None)
            if mine:
                self.transport, self.app_session = mine["transportId"], mine.get("sessionId")
                self.send(self.transport, NS_CONN, {"type": "CONNECT"})
                return
            if r.get("type") in ("LAUNCH_ERROR", "INVALID_REQUEST") or time.time() > deadline:
                raise RuntimeError(T("The TV couldn't start the player ({reason})", reason=r.get("reason") or r.get("type")))
            time.sleep(0.7)
            r = self.request("receiver-0", NS_RECV, {"type": "GET_STATUS"})

    def load(self, media: dict, current_time: float = 0, active_tracks=None):
        body = {"type": "LOAD", "media": media, "autoplay": True, "currentTime": max(0, current_time)}
        if active_tracks:
            body["activeTrackIds"] = active_tracks
        r = self.request(self.transport, NS_MEDIA, body, timeout=40)
        if r.get("type") != "MEDIA_STATUS":
            raise RuntimeError(T("The TV refused the stream ({reason})", reason=r.get("reason") or r.get("detailedErrorCode") or r.get("type")))
        return r

    def media(self, typ: str, **extra):
        if not self.transport or self.media_session is None:
            return
        self.send(self.transport, NS_MEDIA, {"type": typ, "mediaSessionId": self.media_session, "requestId": 0, **extra})

    def play(self): self.media("PLAY")
    def pause(self): self.media("PAUSE")
    def seek(self, t: float): self.media("SEEK", currentTime=max(0, t), resumeState="PLAYBACK_START")
    def set_tracks(self, ids: list[int]): self.media("EDIT_TRACKS_INFO", activeTrackIds=ids)

    def set_volume(self, level: float):
        self.send("receiver-0", NS_RECV, {"type": "SET_VOLUME", "volume": {"level": max(0.0, min(1.0, level))}, "requestId": 0})

    def set_muted(self, muted: bool):
        self.send("receiver-0", NS_RECV, {"type": "SET_VOLUME", "volume": {"muted": bool(muted)}, "requestId": 0})

    def stop(self):
        try:
            if self.app_session:
                self.send("receiver-0", NS_RECV, {"type": "STOP", "sessionId": self.app_session, "requestId": 0})
        except OSError:
            pass
        self.close()

    def close(self):
        self.closed = True
        try:
            self.sock.close()
        except OSError:
            pass


# ---- DLNA: AVTransport + RenderingControl over SOAP ------------------------------------------
DLNA_FLAGS = "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000"
DLNA_STREAM_FLAGS = "DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000"


def hms(t: float) -> str:
    t = max(0, int(t))
    return f"{t // 3600}:{t // 60 % 60:02d}:{t % 60:02d}"


def parse_hms(s: str | None) -> float | None:
    if not s or not re.match(r"^\d+:\d{1,2}:\d{1,2}", s):
        return None
    h, m, sec = s.split(":")[:3]
    return int(h) * 3600 + int(m) * 60 + float(sec)


class Dlna:
    def __init__(self, dev: dict, on_event):
        self.dev = dev
        self.on_event = on_event
        self.closed = False
        self.volume = None
        self.muted = None
        threading.Thread(target=self._poll, daemon=True).start()

    def soap(self, svc: str, action: str, **args) -> dict:
        st, url = self.dev["services"].get(svc, (None, None))
        if not url:
            raise RuntimeError(T("The TV doesn't support {what}", what=action))
        body = "".join(f"<{k}>{html.escape(str(v))}</{k}>" for k, v in args.items())
        env = ('<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
               's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
               f'<u:{action} xmlns:u="{st}">{body}</u:{action}></s:Body></s:Envelope>').encode()
        req = urllib.request.Request(url, data=env, method="POST", headers={
            "Content-Type": 'text/xml; charset="utf-8"', "SOAPACTION": f'"{st}#{action}"'})
        try:
            with urllib.request.urlopen(req, timeout=8) as r:
                root = ET.fromstring(r.read())
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            m = re.search(r"<errorDescription>(.*?)</errorDescription>", detail)
            raise RuntimeError(f"{action}: {m.group(1) if m else e.code}") from None
        out = {}
        for el in root.iter():
            if el.tag.endswith("Response"):
                for c in el:
                    out[c.tag.split("}")[-1]] = c.text or ""
        return out

    def load(self, url: str, mime: str, title: str, sub_url: str | None = None, streaming: bool = False):
        flags = DLNA_STREAM_FLAGS if streaming else DLNA_FLAGS
        sub = ""
        if sub_url:
            sub = (f'<res protocolInfo="http-get:*:text/srt:*">{html.escape(sub_url)}</res>'
                   f'<sec:CaptionInfoEx sec:type="srt">{html.escape(sub_url)}</sec:CaptionInfoEx>')
        didl = ('<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" '
                'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:sec="http://www.sec.co.kr/">'
                f'<item id="0" parentID="-1" restricted="1"><dc:title>{html.escape(title)}</dc:title>'
                '<upnp:class>object.item.videoItem</upnp:class>'
                f'<res protocolInfo="http-get:*:{mime}:{flags}">{html.escape(url)}</res>{sub}</item></DIDL-Lite>')
        try:
            self.soap("avt", "Stop", InstanceID=0)
        except Exception:  # noqa: BLE001
            pass
        self.soap("avt", "SetAVTransportURI", InstanceID=0, CurrentURI=url, CurrentURIMetaData=didl)
        self.soap("avt", "Play", InstanceID=0, Speed=1)

    def play(self): self.soap("avt", "Play", InstanceID=0, Speed=1)
    def pause(self): self.soap("avt", "Pause", InstanceID=0)
    def seek(self, t: float): self.soap("avt", "Seek", InstanceID=0, Unit="REL_TIME", Target=hms(t))

    def set_volume(self, level: float):
        self.soap("rc", "SetVolume", InstanceID=0, Channel="Master", DesiredVolume=int(round(max(0, min(1, level)) * 100)))
        self.volume = level

    def set_muted(self, muted: bool):
        self.soap("rc", "SetMute", InstanceID=0, Channel="Master", DesiredMute=1 if muted else 0)
        self.muted = bool(muted)

    def stop(self):
        try:
            self.soap("avt", "Stop", InstanceID=0)
        except Exception:  # noqa: BLE001
            pass
        self.close()

    def close(self):
        self.closed = True

    def _poll(self):
        n = 0
        while not self.closed:
            try:
                st = self.soap("avt", "GetTransportInfo", InstanceID=0).get("CurrentTransportState")
                pos = self.soap("avt", "GetPositionInfo", InstanceID=0)
                if n % 3 == 0 and "rc" in self.dev["services"]:
                    try:
                        self.volume = int(self.soap("rc", "GetVolume", InstanceID=0, Channel="Master").get("CurrentVolume") or 0) / 100
                        self.muted = self.soap("rc", "GetMute", InstanceID=0, Channel="Master").get("CurrentMute") in ("1", "true")
                    except Exception:  # noqa: BLE001
                        pass
                self.on_event({"type": "dlna", "state": st, "position": parse_hms(pos.get("RelTime")),
                               "duration": parse_hms(pos.get("TrackDuration")), "volume": self.volume, "muted": self.muted})
            except Exception as e:  # noqa: BLE001
                if not self.closed:
                    self.on_event({"type": "dlna", "pollError": str(e)})
            n += 1
            time.sleep(1)


# ---- relay: a small HTTP server on the local network -----------------------------------------
def lan_ip_for(host: str) -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((host, 9))
        return s.getsockname()[0]
    finally:
        s.close()


class _RelayHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Fluxy"

    def log_message(self, fmt, *args):
        pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self.handle_any(False)

    def do_HEAD(self):
        self.handle_any(True)

    def handle_any(self, head: bool):
        parts = self.path.split("?")[0].split("/", 3)          # '', token, kind, rest
        route = RELAY.routes.get(parts[1]) if len(parts) > 2 else None
        if not route:
            self.send_error(404)
            return
        try:
            route.serve(self, parts[2], parts[3] if len(parts) > 3 else "", head)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:  # noqa: BLE001
            log("relay", self.path, traceback.format_exc())
            try:
                self.send_error(502)
            except OSError:
                pass

    def reply(self, code: int, body: bytes, ctype: str, head: bool, extra: dict | None = None):
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if not head:
            self.wfile.write(body)


class Relay:
    def __init__(self):
        self.routes: dict = {}
        self.server = None
        self.port = None
        self.lock = threading.Lock()

    def add(self, route) -> str:
        with self.lock:
            if not self.server:
                try:      # a fixed port, so it can be opened once in the firewall
                    self.server = http.server.ThreadingHTTPServer(("0.0.0.0", RELAY_PORT), _RelayHandler)
                except OSError:
                    self.server = http.server.ThreadingHTTPServer(("0.0.0.0", 0), _RelayHandler)
                self.server.daemon_threads = True
                self.port = self.server.server_address[1]
                threading.Thread(target=self.server.serve_forever, daemon=True).start()
                log("relay listening on port", self.port)
            token = secrets.token_urlsafe(12)
            self.routes[token] = route
            route.token = token
            return token

    def remove(self, route):
        with self.lock:
            self.routes.pop(getattr(route, "token", None), None)
        route.close()

    def base(self, route, device_host: str) -> str:
        return f"http://{lan_ip_for(device_host)}:{self.port}/{route.token}/"


RELAY = Relay()


def _sub_file(url: str, headers: dict, fmt: str) -> bytes:
    """A whole subtitle track (HLS WebVTT playlist, .vtt, .srt…) as one WebVTT or SRT file."""
    out = os.path.join(CACHE_DIR, f"cast-sub-{hashlib.sha1((url + fmt).encode()).hexdigest()[:16]}.{fmt}")
    if not os.path.exists(out):
        p = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", *ffmpeg_header_args(headers),
                            "-extension_picky", "0", "-i", url, "-map", "0:s:0?",
                            "-c:s", "webvtt" if fmt == "vtt" else "srt", out], capture_output=True, text=True, timeout=180)
        if p.returncode != 0 or not os.path.exists(out):
            raise RuntimeError((p.stderr or "ffmpeg").strip()[-300:])
        if fmt == "srt":
            clean_srt(out)
    with open(out, "rb") as fh:
        return fh.read()


class ProxyRoute:
    """Proxies the stream's URLs with the page's headers; HLS playlists are rewritten to point back here."""

    def __init__(self, headers: dict, master: str | None = None, subs: list | None = None):
        self.headers = headers
        self.master = master
        self.subs = subs or []        # [(url, headers)]
        self.urls: list[str] = []
        self.ids: dict = {}
        self.token = None
        self.lock = threading.Lock()

    def close(self):
        pass

    def ref(self, url: str) -> str:
        with self.lock:
            if url not in self.ids:
                self.ids[url] = len(self.urls)
                self.urls.append(url)
            n = self.ids[url]
        path = urllib.parse.urlparse(url).path
        ext = os.path.splitext(path)[1][:6] if "." in os.path.basename(path) else ""
        return f"/{self.token}/u/{n}{ext}"

    def rewrite(self, text: str, base: str) -> str:
        out = []
        for line in text.splitlines():
            s = line.strip()
            if s and not s.startswith("#"):
                out.append(self.ref(urllib.parse.urljoin(base, s)))
            elif s.startswith("#") and 'URI="' in s:
                out.append(re.sub(r'URI="([^"]+)"', lambda m: f'URI="{self.ref(urllib.parse.urljoin(base, m.group(1)))}"', s))
            else:
                out.append(line)
        return "\n".join(out) + "\n"

    def serve(self, h: _RelayHandler, kind: str, rest: str, head: bool):
        if kind == "m":
            return h.reply(200, (self.master or "").encode(), "application/vnd.apple.mpegurl", head)
        if kind == "s":
            j, fmt = rest.split(".", 1) if "." in rest else (rest, "vtt")
            url, hdrs = self.subs[int(j)]
            body = _sub_file(url, hdrs, "srt" if fmt == "srt" else "vtt")
            return h.reply(200, body, "text/srt" if fmt == "srt" else "text/vtt; charset=utf-8", head)
        if kind != "u":
            return h.send_error(404)
        url = self.urls[int(re.match(r"\d+", rest).group(0))]
        req_headers = dict(self.headers)
        if h.headers.get("Range"):
            req_headers["Range"] = h.headers["Range"]
        req = urllib.request.Request(url, headers={"User-Agent": UA_FALLBACK, **req_headers}, method="HEAD" if head else "GET")
        try:
            r = urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as e:
            return h.reply(e.code, b"", "text/plain", head)
        with r:
            first = b"" if head else r.read(7)
            if first.startswith(b"#EXTM3U"):
                text = (first + r.read()).decode("utf-8", "replace")
                return h.reply(200, self.rewrite(text, r.geturl()).encode(), "application/vnd.apple.mpegurl", head)
            h.send_response(r.status)
            h.cors()
            for k in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"):
                if r.headers.get(k):
                    h.send_header(k, r.headers[k])
            h.send_header("transferMode.dlna.org", "Streaming")
            h.end_headers()
            if head:
                return
            h.wfile.write(first)
            while True:
                chunk = r.read(256 * 1024)
                if not chunk:
                    break
                h.wfile.write(chunk)


class RemuxRoute:
    """ffmpeg joins the chosen video and audio (no re-encoding) into one stream from a start position."""

    def __init__(self, inputs: list, fmt: str, start: float = 0, subs: list | None = None):
        self.inputs = inputs          # [(url, headers, ['0:v:0', ...])]
        self.fmt = fmt                # 'mpegts' (DLNA) or 'mp4' (fragmented, Chromecast)
        self.start = start
        self.subs = subs or []
        self.token = None
        self.procs: list = []

    def mime(self) -> str:
        return "video/mp2t" if self.fmt == "mpegts" else "video/mp4"

    def close(self):
        for p in self.procs:
            if p.poll() is None:
                p.kill()

    def serve(self, h: _RelayHandler, kind: str, rest: str, head: bool):
        if kind == "s":
            j, fmt = rest.split(".", 1) if "." in rest else (rest, "vtt")
            url, hdrs = self.subs[int(j)]
            body = _sub_file(url, hdrs, "srt" if fmt == "srt" else "vtt")
            return h.reply(200, body, "text/srt" if fmt == "srt" else "text/vtt; charset=utf-8", head)
        if kind != "v":
            return h.send_error(404)
        h.send_response(200)
        h.cors()
        h.send_header("Content-Type", self.mime())
        h.send_header("transferMode.dlna.org", "Streaming")
        h.send_header("contentFeatures.dlna.org", DLNA_STREAM_FLAGS)
        h.send_header("Connection", "close")
        h.end_headers()
        h.close_connection = True
        if head:
            return
        cmd = ["ffmpeg", "-nostdin", "-v", "error"]
        maps = []
        for i, (url, hdrs, m) in enumerate(self.inputs):
            if self.start > 0:
                cmd += ["-ss", f"{self.start:.3f}"]
            cmd += [*ffmpeg_header_args(hdrs), "-i", url]
            maps += [x for spec in m for x in ("-map", spec.replace("0:", f"{i}:", 1))]
        cmd += [*maps, "-c", "copy", "-sn", "-dn"]
        if self.fmt == "mp4":
            cmd += ["-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-"]
        else:
            cmd += ["-f", "mpegts", "-mpegts_copyts", "0", "-"]
        log("relay remux", redact(" ".join(cmd)))
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        self.procs.append(p)
        try:
            while True:
                chunk = p.stdout.read(188 * 1024)
                if not chunk:
                    break
                h.wfile.write(chunk)
        finally:
            if p.poll() is None:
                p.kill()


# ---- the cast session ------------------------------------------------------------------------
def _ytdlp_info(url: str, headers: dict) -> dict:
    path = info_cache_path(url)
    if not os.path.exists(path):
        probe_ytdlp(url, headers, "page")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _guess_mime(url: str, kind: str) -> str:
    if kind == "hls":
        return "application/x-mpegurl"
    if kind == "dash":
        return "application/dash+xml"
    ext = os.path.splitext(urllib.parse.urlparse(url).path)[1].lower()
    return {".webm": "video/webm", ".mkv": "video/x-matroska", ".ts": "video/mp2t", ".mov": "video/quicktime",
            ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac"}.get(ext, "video/mp4")


def _hls_formats(url: str, headers: dict) -> tuple[str | None, str | None]:
    """hlsSegmentFormat / hlsVideoSegmentFormat for the Default Media Receiver, from a media playlist."""
    try:
        text, final, _ = http_get(url, headers)
    except Exception:  # noqa: BLE001
        return None, None
    seg = next((ln.strip() for ln in text.splitlines() if ln.strip() and not ln.startswith("#")), "")
    ext = os.path.splitext(urllib.parse.urlparse(seg).path)[1].lower()
    if "#EXT-X-MAP" in text or ext in (".m4s", ".mp4", ".m4a", ".m4v", ".cmfv", ".cmfa"):
        return "fmp4", "fmp4"
    return {".aac": "aac", ".ac3": "ac3", ".ec3": "e_ac3", ".mp3": "mp3"}.get(ext, "ts"), "mpeg2_ts"


class CastSession:
    def __init__(self, sid: str, device: dict, route: str, spec: dict):
        self.id = sid
        self.device = device
        self.route = route                    # 'direct' | 'relay'
        self.spec = spec
        self.sel = dict(spec.get("sel") or {})
        self.headers = clean_headers(spec.get("headers") or {})
        self.ctl = None
        self.relay_route = None
        self.offset = 0.0                     # remuxed streams restart from 0 at each seek
        self.restart = False                  # True when seeking means reloading from the new position
        self.state = "connecting"
        self.error = None
        self.position = 0.0
        self.pos_at = time.time()
        self.rate = 0.0
        self.duration = spec.get("duration")
        self.volume = None
        self.muted = None
        self.volume_fixed = False
        self.rx_tracks: list = []             # Chromecast: tracks reported by the receiver
        self.text_ids: dict = {}              # sub id -> Chromecast text trackId
        self.want_audio = True                # apply the chosen audio track once the receiver lists them
        self.stopped = False
        self.lock = threading.Lock()
        self.last_emit = 0

    # -- status ----------------------------------------------------------------------------
    def pos(self) -> float:
        p = self.position + (time.time() - self.pos_at) * self.rate
        return self.offset + (min(p, self.duration - self.offset) if self.duration else p)

    def emit(self, force=False):
        now = time.time()
        if not force and now - self.last_emit < 0.9:
            return
        self.last_emit = now
        send({"type": "cast", "sessionId": self.id, "state": self.state, "error": self.error,
              "position": round(self.pos(), 1), "duration": self.duration, "volume": self.volume, "muted": self.muted,
              "sel": self.sel, "caps": self.caps()})

    def caps(self) -> dict:
        cc = self.device["kind"] == "chromecast"
        hls = self.spec["kind"] == "hls"
        return {"video": self.restart or (hls and self.route == "relay") or (not cc and self.route == "relay"),
                "audio": True, "subs": True, "seek": True, "volume": not self.volume_fixed}

    def on_event(self, ev: dict):
        t = ev.get("type")
        if t == "media":
            st = ev["status"]
            ps = st.get("playerState")
            if "currentTime" in st:
                self.position, self.pos_at = float(st["currentTime"]), time.time()
            self.rate = 1.0 if ps == "PLAYING" else 0.0
            media = st.get("media") or {}
            if media.get("duration") and not self.restart:
                self.duration = media["duration"]
            if media.get("tracks"):
                self.rx_tracks = media["tracks"]
                if self.want_audio:
                    self.want_audio = False
                    threading.Thread(target=self.apply_tracks, daemon=True).start()
            if "volume" in st:
                self.volume = st["volume"].get("level", self.volume)
                self.muted = st["volume"].get("muted", self.muted)
            if ps == "IDLE":
                reason = st.get("idleReason")
                if reason == "ERROR":
                    self.state, self.error = "error", T("The TV couldn't play the stream")
                elif reason == "FINISHED":
                    self.state = "ended"
                elif self.state not in ("connecting", "loading"):
                    self.state = "idle"
            elif ps:
                self.state = {"PLAYING": "playing", "PAUSED": "paused", "BUFFERING": "buffering", "LOADING": "loading"}.get(ps, self.state)
            self.emit(force=True)
        elif t == "receiver":
            v = ev["status"].get("volume") or {}
            self.volume, self.muted = v.get("level", self.volume), v.get("muted", self.muted)
            self.volume_fixed = v.get("controlType") == "fixed"     # e.g. HDMI dongles: the TV sets the volume
            self.emit()
        elif t == "dlna":
            if ev.get("pollError"):
                return
            st = ev.get("state")
            mapped = {"PLAYING": "playing", "PAUSED_PLAYBACK": "paused", "TRANSITIONING": "buffering",
                      "STOPPED": "idle", "NO_MEDIA_PRESENT": "idle"}.get(st or "", self.state)
            if not (mapped == "idle" and self.state in ("connecting", "loading")):
                self.state = mapped
            if ev.get("position") is not None:
                self.position, self.pos_at = ev["position"], time.time()
            self.rate = 1.0 if self.state == "playing" else 0.0
            if ev.get("duration") and not self.restart:
                self.duration = ev["duration"]
            self.volume, self.muted = ev.get("volume", self.volume), ev.get("muted", self.muted)
            self.emit()
        elif t == "error":
            self.state, self.error = "error", T("The TV reported an error: {reason}", reason=ev.get("error"))
            self.emit(force=True)
        elif t == "closed" and not self.stopped:
            self.state = "idle" if not ev.get("error") else "error"
            self.error = ev.get("error") and T("Connection to the TV lost")
            self.emit(force=True)

    # -- sources ---------------------------------------------------------------------------
    def find(self, kind: str, tid):
        return next((x for x in self.spec.get(kind) or [] if x.get("id") == tid), None)

    def video(self):
        return self.find("video", self.sel.get("videoId")) or (self.spec.get("video") or [None])[0]

    def audio(self):
        return self.find("audio", self.sel.get("audioId"))

    def sub_sources(self) -> list:
        """(url, headers) for every subtitle track, in the order of spec['subs']."""
        out = []
        info = None
        for s in self.spec.get("subs") or []:
            url, hdrs = s.get("url"), self.headers
            if s.get("ytLang"):
                info = info or _ytdlp_info(self.spec["url"], self.headers)
                entries = (info.get("subtitles") or {}).get(s["ytLang"]) or []
                e = next((x for x in entries if x.get("ext") == "vtt"), entries[0] if entries else {})
                url, hdrs = e.get("url"), {**self.headers, **(e.get("http_headers") or {})}
            out.append((url, hdrs))
        return out

    def page_inputs(self) -> list:
        """yt-dlp pages: the chosen formats' direct URLs and headers."""
        info = _ytdlp_info(self.spec["url"], self.headers)
        fmts = {f["format_id"]: f for f in info.get("formats") or []}
        v, a = self.video(), self.audio()
        out = []
        if v:
            f = fmts.get(v.get("formatId") or v.get("id")) or {}
            out.append((f.get("url") or v.get("url"), {**self.headers, **(f.get("http_headers") or {})},
                        ["0:v:0"] + (["0:a:0?"] if not a else [])))
        if a:
            f = fmts.get(a.get("formatId") or a.get("id")) or {}
            out.append((f.get("url") or a.get("url"), {**self.headers, **(f.get("http_headers") or {})}, ["0:a:0"]))
        return out

    def remux_inputs(self) -> list:
        if self.spec["kind"] == "page":
            return self.page_inputs()
        v, a = self.video(), self.audio()
        if self.spec["kind"] == "file":
            return [((v or {}).get("url") or self.spec["url"], self.headers, ["0:v:0?", "0:a:0?"])]
        if self.spec["kind"] == "dash":
            return self.page_inputs()
        out = []
        if v:
            out.append((v["url"], self.headers, ["0:v:0"] + (["0:a:0?"] if not a else [])))
        if a:
            out.append((a["url"], self.headers, ["0:a:0"]))
        if not out:
            out.append((self.spec["url"], self.headers, ["0:v:0?", "0:a:0?"]))
        return out

    def synth_master(self, proxy: ProxyRoute) -> str:
        """The page's master playlist with only the chosen video variant (audio renditions kept)."""
        text, final, _ = http_get(self.spec["url"], self.headers)
        if "#EXT-X-STREAM-INF" not in text:
            return proxy.rewrite(text, final)
        v = self.video()
        want = v.get("url") if v else None
        variants = [urllib.parse.urljoin(final, x.strip()) for i, x in enumerate(text.splitlines())
                    if x.strip() and not x.startswith("#") and "#EXT-X-STREAM-INF" in text.splitlines()[i - 1]]
        if want not in variants:      # e.g. the master was redirected: match by path, else take the first one
            path = urllib.parse.urlparse(want or "").path
            want = next((u for u in variants if path and urllib.parse.urlparse(u).path == path), None)
        lines, out, keep_next = text.splitlines(), [], False
        chosen_audio = self.audio()
        for i, line in enumerate(lines):
            s = line.strip()
            if s.startswith("#EXT-X-STREAM-INF"):
                nxt = next((x.strip() for x in lines[i + 1:] if x.strip() and not x.startswith("#")), "")
                keep_next = not want or urllib.parse.urljoin(final, nxt) == want
                if keep_next:
                    out.append(line)
                    want = want or "taken"
                continue
            if s and not s.startswith("#"):
                if keep_next:
                    out.append(line)
                keep_next = False
                continue
            if s.startswith("#EXT-X-I-FRAME-STREAM-INF"):
                continue
            if s.startswith("#EXT-X-MEDIA") and "TYPE=SUBTITLES" in s:
                continue                       # subtitles are side-loaded as WebVTT
            if s.startswith("#EXT-X-MEDIA") and "TYPE=AUDIO" in s and chosen_audio:
                m = re.search(r'URI="([^"]+)"', s)
                is_chosen = m and urllib.parse.urljoin(final, m.group(1)) == chosen_audio.get("url")
                s = re.sub(r"DEFAULT=(YES|NO)", f"DEFAULT={'YES' if is_chosen else 'NO'}", s)
                if "DEFAULT=" not in s:
                    s += f",DEFAULT={'YES' if is_chosen else 'NO'}"
                out.append(s)
                continue
            out.append(line)
        return proxy.rewrite("\n".join(out), final)

    # -- loading ---------------------------------------------------------------------------
    def start(self):
        try:
            if self.device["kind"] == "chromecast":
                self.ctl = CastV2(self.device["host"], self.device.get("port") or 8009, self.on_event)
                self.ctl.launch()
            else:
                self.ctl = Dlna(self.device, self.on_event)
            self.load(0)
        except Exception as e:  # noqa: BLE001
            log("cast start", traceback.format_exc())
            self.state, self.error = "error", str(e)
            self.emit(force=True)

    def new_route(self, route):
        if self.relay_route:
            RELAY.remove(self.relay_route)
        self.relay_route = route
        RELAY.add(route)
        return RELAY.base(route, self.device["host"])

    def load(self, at: float):
        with self.lock:
            self.state, self.error = "loading", None
            self.emit(force=True)
            kind = self.spec["kind"]
            subs = self.sub_sources() if self.spec.get("subs") else []
            sub_j = next((j for j, s in enumerate(self.spec.get("subs") or []) if s.get("id") == self.sel.get("subId")), None)
            if self.device["kind"] == "chromecast":
                self.load_chromecast(at, kind, subs, sub_j)
            else:
                self.load_dlna(at, kind, subs, sub_j)

    def load_chromecast(self, at, kind, subs, sub_j):
        media = {"streamType": "BUFFERED", "metadata": {"metadataType": 0, "title": self.spec.get("title") or "Fluxy"}}
        self.restart, self.offset = False, 0.0
        if kind == "hls":
            if self.route == "relay":
                proxy = ProxyRoute(self.headers, subs=subs)
                base = self.new_route(proxy)
                proxy.master = self.synth_master(proxy)
                url = base + "m/master.m3u8"
            else:
                proxy = ProxyRoute(self.headers, subs=subs)      # only for the subtitle files
                base = self.new_route(proxy) if subs else ""
                url = self.spec["url"]
            v, a = self.video(), self.audio()
            fa, fv = _hls_formats((a or v or {}).get("url") or self.spec["url"], self.headers)
            media.update({"contentId": url, "contentUrl": url, "contentType": "application/x-mpegurl"})
            if fa:
                media["hlsSegmentFormat"] = fa
            if fv and v:
                media["hlsVideoSegmentFormat"] = fv
        elif self.route == "direct" and kind in ("file", "dash"):
            url = (self.video() or {}).get("url") if kind == "file" else self.spec["url"]
            url = url or self.spec["url"]
            media.update({"contentId": url, "contentUrl": url, "contentType": _guess_mime(url, kind)})
            base = self.new_route(ProxyRoute(self.headers, subs=subs)) if subs else ""
        elif self.route == "direct" and kind == "page":
            v = self.video()
            if not (v and v.get("hasAudio")):
                raise RuntimeError(T("This video has separate audio and video: use the local app route"))
            url = self.page_inputs()[0][0]
            media.update({"contentId": url, "contentUrl": url, "contentType": _guess_mime(url, "file")})
            base = self.new_route(ProxyRoute(self.headers, subs=subs)) if subs else ""
        elif kind == "file":
            proxy = ProxyRoute(self.headers, subs=subs)
            base = self.new_route(proxy)
            src = (self.video() or {}).get("url") or self.spec["url"]
            url = base.rstrip("/") + proxy.ref(src)[len(f"/{proxy.token}"):]
            media.update({"contentId": url, "contentUrl": url, "contentType": _guess_mime(src, "file")})
        else:
            route = RemuxRoute(self.remux_inputs(), "mp4", at, subs=subs)
            base = self.new_route(route)
            url = base + "v/stream.mp4"
            media.update({"contentId": url, "contentUrl": url, "contentType": "video/mp4"})
            self.restart, self.offset, at = True, at, 0
            if self.spec.get("duration"):
                media["duration"] = max(0, self.spec["duration"] - self.offset)
        tracks, self.text_ids = [], {}
        for j, s in enumerate(self.spec.get("subs") or []):
            tid = 100 + j
            self.text_ids[s["id"]] = tid
            tracks.append({"trackId": tid, "type": "TEXT", "subtype": "SUBTITLES", "trackContentId": f"{base}s/{j}.vtt",
                           "trackContentType": "text/vtt", "language": s.get("lang") or "und",
                           "name": (s.get("name") or s.get("lang") or "") + (" (forced)" if s.get("forced") else "")})
        if tracks:
            media["tracks"] = tracks
        self.want_audio = True
        self.position, self.pos_at, self.rate = at, time.time(), 0
        self.ctl.load(media, at, [100 + sub_j] if sub_j is not None else None)

    def load_dlna(self, at, kind, subs, sub_j):
        self.restart, self.offset = False, 0.0
        title = self.spec.get("title") or "Fluxy"
        if self.route == "direct":
            if kind == "page" or kind == "dash":
                raise RuntimeError(T("This TV can't play this stream by itself: use the local app route"))
            url = (self.video() or {}).get("url") if kind == "file" else self.spec["url"]
            url = url or self.spec["url"]
            sub_url = None
            if sub_j is not None:
                base = self.new_route(ProxyRoute(self.headers, subs=subs))
                sub_url = f"{base}s/{sub_j}.srt"
            self.ctl.load(url, _guess_mime(url, kind) if kind != "hls" else "application/vnd.apple.mpegurl", title, sub_url)
        elif kind == "file":
            proxy = ProxyRoute(self.headers, subs=subs)
            base = self.new_route(proxy)
            src = (self.video() or {}).get("url") or self.spec["url"]
            url = base.rstrip("/") + proxy.ref(src)[len(f"/{proxy.token}"):]
            self.ctl.load(url, _guess_mime(src, "file"), title, f"{base}s/{sub_j}.srt" if sub_j is not None else None)
        else:
            route = RemuxRoute(self.remux_inputs(), "mpegts", at, subs=subs)
            base = self.new_route(route)
            self.restart, self.offset, at = True, at, 0
            self.ctl.load(base + "v/stream.ts", "video/mpeg", title, f"{base}s/{sub_j}.srt" if sub_j is not None else None, streaming=True)
        self.position, self.pos_at, self.rate = at, time.time(), 0
        if at > 0 and not self.restart:
            threading.Thread(target=self._seek_when_playing, args=(at,), daemon=True).start()

    def _seek_when_playing(self, at: float):
        for _ in range(30):
            if self.state == "playing":
                try:
                    self.ctl.seek(at)
                except Exception as e:  # noqa: BLE001
                    log("dlna seek", e)
                return
            time.sleep(0.5)

    def apply_tracks(self):
        """Chromecast: turn on the chosen audio (by language/name) and subtitle tracks."""
        ids = []
        a = self.audio()
        if a:
            audio_tracks = [x for x in self.rx_tracks if x.get("type") == "AUDIO"]
            lang = (a.get("lang") or "").lower().split("-")[0]
            hit = next((x for x in audio_tracks if (x.get("name") or "") == (a.get("name") or "") and (x.get("language") or "").lower().startswith(lang)), None) \
                or next((x for x in audio_tracks if lang and (x.get("language") or "").lower().startswith(lang)), None)
            if hit:
                ids.append(hit["trackId"])
        sid = self.sel.get("subId")
        if sid in self.text_ids:
            ids.append(self.text_ids[sid])
        if ids or self.text_ids:
            self.ctl.set_tracks(ids)

    # -- commands from the extension -------------------------------------------------------
    def control(self, action: str, value=None):
        if action == "stop":
            return self.stop()
        if action == "play":
            self.ctl.play()
        elif action == "pause":
            self.ctl.pause()
        elif action in ("seek", "seekBy"):
            t = float(value or 0) + (self.pos() if action == "seekBy" else 0)
            t = max(0.0, min(t, (self.duration or t + 1) - 1))
            if self.restart:
                self.load(t)
            else:
                self.ctl.seek(t)
                self.position, self.pos_at = t, time.time()
        elif action == "volume":
            self.ctl.set_volume(float(value))
            self.volume = float(value)
        elif action == "mute":
            self.ctl.set_muted(bool(value))
            self.muted = bool(value)
        self.emit(force=True)

    def select(self, kind: str, tid):
        key = {"video": "videoId", "audio": "audioId", "sub": "subId"}[kind]
        self.sel[key] = tid
        cc = self.device["kind"] == "chromecast"
        if cc and not self.restart and kind in ("audio", "sub") and (self.spec["kind"] == "hls" or kind == "sub"):
            self.apply_tracks()
            self.emit(force=True)
            return
        self.load(self.pos())

    def stop(self):
        self.stopped = True
        try:
            if self.ctl:
                self.ctl.stop()
        finally:
            if self.relay_route:
                RELAY.remove(self.relay_route)
                self.relay_route = None
            self.state = "stopped"
            self.emit(force=True)
            for f in glob.glob(os.path.join(CACHE_DIR, "cast-sub-*")):     # converted subtitles
                try:
                    os.remove(f)
                except OSError:
                    pass
            if CAST.get("session") is self:
                CAST["session"] = None

    def active(self) -> bool:
        return not self.stopped and self.state not in ("idle", "ended", "error", "stopped")


def cast_ticker():
    """Position updates while playing (the TVs report it only now and then)."""
    while True:
        time.sleep(1)
        s = CAST.get("session")
        if s and not s.stopped and s.state == "playing":
            s.emit()


def cast_handle(msg: dict):
    t = msg.get("type")
    rid = msg.get("id")
    if t == "castDiscover":
        def work():
            try:
                devs = discover(float(msg.get("timeout") or 3))
                send({"type": "castDevices", "id": rid, "ok": True, "devices": [public_device(d) for d in devs]})
            except Exception as e:  # noqa: BLE001
                send({"type": "castDevices", "id": rid, "ok": False, "error": str(e)})
        threading.Thread(target=work, daemon=True).start()
    elif t == "castAddDevice":
        def work():
            try:
                dev = add_device(msg.get("address") or "")
                send({"type": "castDevices", "id": rid, "ok": True, "devices": [public_device(dev)]})
            except Exception as e:  # noqa: BLE001
                send({"type": "castDevices", "id": rid, "ok": False, "error": T("No TV answers at {address}", address=msg.get("address")) + f" ({e})"})
        threading.Thread(target=work, daemon=True).start()
    elif t == "castStart":
        dev = DEVICES.get(msg.get("deviceId"))
        if not dev:
            send({"type": "cast", "sessionId": msg.get("sessionId"), "state": "error", "error": T("TV not found: search again")})
            return
        old = CAST.get("session")
        if old:
            threading.Thread(target=old.stop, daemon=True).start()
        s = CastSession(msg["sessionId"], dev, msg.get("route") or "relay", msg["spec"])
        CAST["session"] = s
        threading.Thread(target=s.start, daemon=True).start()
    elif t in ("castControl", "castSelect"):
        s = CAST.get("session")
        if not s or s.id != msg.get("sessionId"):
            send({"type": "cast", "sessionId": msg.get("sessionId"), "state": "stopped"})
            return
        def work():
            try:
                if t == "castControl":
                    s.control(msg.get("action"), msg.get("value"))
                else:
                    s.select(msg.get("kind"), msg.get("trackId"))
            except Exception as e:  # noqa: BLE001
                log("cast command", traceback.format_exc())
                s.error = str(e)
                s.emit(force=True)
        threading.Thread(target=work, daemon=True).start()


def tool_version(name, args):
    try:
        return subprocess.run([name, *args], capture_output=True, text=True, timeout=10).stdout.splitlines()[0]
    except Exception:  # noqa: BLE001
        return None


def handle(msg: dict):
    global UI_LANG
    UI_LANG = msg.get("lang") or UI_LANG
    t = msg.get("type")
    rid = msg.get("id")
    if t == "hello":
        env = ytdlp_env() if shutil.which("yt-dlp") else {"cryptodome": False, "variant": None, "path": None}
        send({"type": "hello", "id": rid, "version": VERSION,
              "ffmpeg": tool_version("ffmpeg", ["-version"]),
              "ytdlp": tool_version("yt-dlp", ["--version"]),
              "cryptodome": env["cryptodome"], "ytdlpVariant": env["variant"],
              "hints": install_hints(env)})
    elif t and t.startswith("cast"):
        cast_handle(msg)
    elif t == "probe":
        def work():
            try:
                data = probe(msg["url"], msg.get("headers") or {}, msg.get("kind"))
                send({"type": "probe", "id": rid, "ok": True, "data": data})
            except Exception as e:  # noqa: BLE001
                log("probe error", msg.get("url"), traceback.format_exc())
                send({"type": "probe", "id": rid, "ok": False, "error": str(e)})
        threading.Thread(target=work, daemon=True).start()
    elif t == "download":
        job = Job(msg["jobId"], msg["spec"])
        JOBS[job.id] = job
        job.emit(force=True, state="running", progress=0, stage=T("Starting"))
        job.start()
    elif t == "cancel":
        job = JOBS.get(msg.get("jobId"))
        if job:
            job.cancel()
    elif t == "rename":
        job = JOBS.get(msg.get("jobId"))
        if job and msg.get("filename"):
            job.spec["filename"] = msg["filename"]
    elif t == "skipTrack":
        job = JOBS.get(msg.get("jobId"))
        if job and isinstance(msg.get("index"), int):
            job.skip(msg["index"])
    elif t in ("pause", "resume"):
        job = JOBS.get(msg.get("jobId"))
        if job:
            job.pause() if t == "pause" else job.resume()
    elif t == "discard":
        # temp folder kept by a failed job for "retry"
        jid = re.sub(r"[^\w-]", "", msg.get("jobId") or "")
        out_dir = os.path.expanduser(msg.get("outputDir") or "~/Downloads")
        tmp = os.path.join(out_dir, f".flux-{jid}")
        if jid and jid not in JOBS and os.path.isdir(tmp):
            shutil.rmtree(tmp, ignore_errors=True)
    elif t == "reveal":
        path = msg.get("path") or ""
        target = os.path.dirname(path) if os.path.isfile(path) else path
        if target and os.path.isdir(target):
            subprocess.Popen(["xdg-open", target], start_new_session=True,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        send({"type": "error", "id": rid, "error": f"unknown message type {t}"})


def doctor() -> dict:
    """For install.sh: what is missing and the command that installs it on this system."""
    has_ytdlp = bool(shutil.which("yt-dlp"))
    env = ytdlp_env() if has_ytdlp else {"cryptodome": False, "variant": None, "path": None}
    missing = [t for t in ("ffmpeg", "ffprobe", "yt-dlp") if not shutil.which(t)]
    hints = install_hints(env)
    return {"missing": missing, "tools": hints["tools"],
            "cryptodome": None if (not has_ytdlp or env["cryptodome"]) else hints["cryptodome"]}


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "doctor":
        print(json.dumps(doctor()))
        return
    if len(sys.argv) > 2 and sys.argv[1] == "probe":
        hdrs = dict(h.split(":", 1) for h in sys.argv[3:])
        print(json.dumps(probe(sys.argv[2], {k.strip(): v.strip() for k, v in hdrs.items()}), indent=2))
        return
    log("host started", VERSION)
    threading.Thread(target=cast_ticker, daemon=True).start()
    while True:
        msg = read_message()
        if msg is None:
            break
        try:
            handle(msg)
        except Exception:  # noqa: BLE001
            log("handler error", traceback.format_exc())
    # Browser closed the port: let running downloads finish (paused ones too).
    for job in list(JOBS.values()):
        job.resume()
    # ...and keep relaying to the TV while a cast is playing
    while JOBS or (CAST.get("session") and CAST["session"].active()):
        time.sleep(1)
    log("host exit")


if __name__ == "__main__":
    main()
