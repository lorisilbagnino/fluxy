#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 lorisilbagnino — Fluxy, https://github.com/lorisilbagnino/fluxy (see ADDITIONAL-TERMS.md)
"""Fluxy native messaging host.

Speaks the Chrome native messaging protocol on stdin/stdout (4-byte little
endian length + UTF-8 JSON). Probes HLS/DASH manifests, downloads the selected
renditions with yt-dlp / ffmpeg and muxes them into one MKV/MP4 without
re-encoding (stream copy).

Can also be run by hand for debugging:
    fluxy_host.py probe <url> [Header: value ...]
"""
from __future__ import annotations

import glob
import hashlib
import json
import os
import re
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request

VERSION = "0.7.0"
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


class Job:
    def __init__(self, job_id: str, spec: dict):
        self.id = job_id
        self.spec = spec
        self.proc: subprocess.Popen | None = None
        self.cancelled = False
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
    def run(self, cmd: list[str], on_line=None):
        self.resumed.wait()          # paused between two steps: don't start the next one
        if self.cancelled:
            raise Cancelled()
        log("run", redact(" ".join(cmd)))
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     stdin=subprocess.DEVNULL, bufsize=0, start_new_session=True)
        tail = []
        buf = b""
        fd = self.proc.stdout.fileno()
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
        rc = self.proc.wait()
        self.proc = None
        if self.cancelled:
            raise Cancelled()
        if rc != 0:
            msg = next((l for l in reversed(tail) if "ERROR" in l or "rror" in l), tail[-1] if tail else "")
            log("failed", rc, "\n".join(tail))
            raise RuntimeError(msg.strip() or f"exit code {rc}")

    def cancel(self):
        self.cancelled = True
        p = self.proc
        if p and p.poll() is None:
            try:
                if self.paused:
                    os.killpg(p.pid, signal.SIGCONT)   # a stopped process can't handle SIGTERM
                os.killpg(p.pid, signal.SIGTERM)
            except OSError:
                pass
        self.paused = False
        self.resumed.set()

    # Pause = SIGSTOP on the running tool (yt-dlp / ffmpeg) and its children; nothing is lost.
    def pause(self):
        if self.paused or self.cancelled:
            return
        self.paused = True
        self.resumed.clear()
        p = self.proc
        if p and p.poll() is None:
            try:
                os.killpg(p.pid, signal.SIGSTOP)
            except OSError:
                pass
        self.emit(force=True, state="paused", stage=T("Paused"), speed=None, eta=None)

    def resume(self):
        if not self.paused:
            return
        self.paused = False
        p = self.proc
        if p and p.poll() is None:
            try:
                os.killpg(p.pid, signal.SIGCONT)
            except OSError:
                pass
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

        # Progress weights from bitrate (fallbacks: video 3 Mbps, audio 128 kbps)
        weights = [(t.get("bandwidth") or (3_000_000 if r == "video" else 128_000)) for r, t in tracks]
        weights += [20_000] * len(subs)
        mux_weight = max(1, sum(weights)) * 0.04
        total_w = sum(weights) + mux_weight
        done_w = 0.0

        def report(stage, frac_of_current, cur_w, **extra):
            self.emit(state="running", stage=stage,
                      progress=min(0.999, (done_w + cur_w * frac_of_current) / total_w), **extra)

        files = []
        n = len(tracks)
        for i, (role, t) in enumerate(tracks):
            label = "video" if role == "video" else f"audio {t.get('lang') or ''}".strip()
            stage = T("Download {label} ({i}/{n})", label=label, i=i + 1, n=n)
            report(stage, 0, weights[i])
            prefix = os.path.join(self.tmp, f"t{i}")
            marker = prefix + ".done"
            found = [f for f in glob.glob(prefix + ".*") if not f.endswith((".json", ".part", ".ytdl", ".done"))]
            if os.path.exists(marker) and found:
                files.append((role, t, found[0]))
                done_w += weights[i]
                continue
            for f in glob.glob(prefix + ".*"):      # leftovers of an interrupted attempt
                os.remove(f)

            ff = {"t": None, "bytes": None}

            def on_line(line, w=weights[i], stage=stage, ff=ff):
                m = FF_TIME_RE.search(line)
                if m and duration:
                    # yt-dlp delegated the download to ffmpeg (e.g. AES-128 without pycryptodomex)
                    pos = int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])
                    sx = FF_SPEED_RE.search(line)
                    sx = float(sx[1]) if sx else 0
                    sz = FF_SIZE_RE.search(line)
                    speed = None
                    if sz:
                        nbytes = int(sz[1]) * 1024
                        now = time.time()
                        if ff["t"] and now > ff["t"]:
                            speed = (nbytes - ff["bytes"]) / (now - ff["t"])
                        ff["t"], ff["bytes"] = now, nbytes
                    eta = max(0, (duration - pos) / sx) if sx else None
                    report(stage, min(1, pos / duration), w, speed=speed, eta=eta)
                elif line.startswith("FCPROG "):
                    p = json.loads(line[7:])
                    total = p.get("total_bytes") or p.get("total_bytes_estimate")
                    frac = (p.get("downloaded_bytes") or 0) / total if total else 0
                    if p.get("fragment_count"):
                        frac = max(frac, (p.get("fragment_index") or 0) / p["fragment_count"])
                    report(stage, frac, w, speed=p.get("speed"), eta=p.get("eta"))

            cmd = ["yt-dlp", "--newline", "--no-warnings", "--no-playlist", "--no-mtime",
                   "--no-part", "--fixup", "never", "-N", str(s.get("fragments") or 8),
                   "--retries", "10", "--fragment-retries", "20",
                   "--progress-template", "download:FCPROG %(progress)j",
                   *ytdlp_header_args(headers), "-o", prefix + ".%(ext)s"]
            if t.get("formatId"):
                info_path = info_cache_path(s["url"])
                if not os.path.exists(info_path):
                    probe_ytdlp(s["url"], headers)
                cmd += ["--load-info-json", info_path, "-f", t["formatId"]]
            else:
                cmd += [t["url"]]
            self.run(cmd, on_line)
            found = [f for f in glob.glob(prefix + ".*") if not f.endswith((".json", ".part", ".ytdl", ".done"))]
            if not found:
                raise RuntimeError(T("{label} file not found after the download", label=label))
            open(marker, "w").close()
            files.append((role, t, found[0]))
            done_w += weights[i]

        sub_files = []
        for j, sub in enumerate(subs):
            stage = T("Subtitles {lang} ({i}/{n})", lang=sub.get("lang") or "", i=j + 1, n=len(subs))
            report(stage, 0, 20_000)
            dst = os.path.join(self.tmp, f"s{j}.srt")
            if sub.get("ytLang"):
                pfx = os.path.join(self.tmp, f"s{j}")
                self.run(["yt-dlp", "--no-warnings", "--skip-download", "--write-subs",
                          "--sub-langs", "^" + re.escape(sub["ytLang"]) + "$", "--convert-subs", "srt",
                          *ytdlp_header_args(headers), "--load-info-json", info_cache_path(s["url"]),
                          "-o", pfx + ".%(ext)s"])
                got = glob.glob(pfx + "*.srt")
                if not got:
                    raise RuntimeError(T("{lang} subtitles not downloaded", lang=sub.get("lang")))
                os.replace(got[0], dst)
            else:
                for attempt in range(3):
                    try:
                        self.run(["ffmpeg", "-nostdin", "-v", "error", "-y", *ffmpeg_header_args(headers),
                                  "-extension_picky", "0", "-i", sub["url"], "-map", "0:s:0?",
                                  "-c:s", "srt", dst])
                        break
                    except Cancelled:
                        raise
                    except RuntimeError:
                        if attempt == 2:
                            raise
                        log("subtitles failed, retrying", attempt + 1)
                        time.sleep(2 * (attempt + 1))
                if not os.path.exists(dst) or os.path.getsize(dst) == 0:
                    raise RuntimeError(T("{lang} subtitles are empty", lang=sub.get("lang")))
                clean_srt(dst)
            sub_files.append((sub, dst))
            done_w += 20_000

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
        final = unique_path(os.path.join(out_dir, safe_filename(s.get("filename") or title) + "." + container))
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
        os.replace(tmp_out, final)
        return final


JOBS: dict[str, Job] = {}


# --------------------------------------------------------------------------
# Dispatcher
# --------------------------------------------------------------------------
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
    while JOBS:
        time.sleep(1)
    log("host exit")


if __name__ == "__main__":
    main()
