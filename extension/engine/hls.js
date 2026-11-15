// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 lorisilbagnino — Fluxy, https://github.com/lorisilbagnino/fluxy (see ADDITIONAL-TERMS.md)
// HLS playlist parsing and stream analysis (no Mediabunny: runs in the
// background worker too). Mirrors probe_hls() in host/fluxy_host.py: the result
// has the same shape whichever engine downloads it.

import { fetchText } from './net.js';
import { m } from './i18n.js';

export const attrs = (s) => Object.fromEntries(
  [...s.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)].map((m) => [m[1], m[2].replace(/^"|"$/g, '')]));

const abs = (u, base) => new URL(u, base).href;

// ------------------------------------------------------------- segments ---
/** Segments of a media playlist: [{url, dur, key, map, seq, range}] */
export function parseMediaPlaylist(text, base) {
  const segs = [];
  let key = null, map = null, seq = 0, dur = 0, range = null, lastEnd = 0, mapRange = null;
  const parseRange = (v, prevEnd) => {
    const [len, off] = v.split('@');
    const start = off != null ? Number(off) : prevEnd;
    return { start, end: start + Number(len) };   // end exclusive
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = parseInt(line.slice(22), 10) || 0;
    else if (line.startsWith('#EXT-X-KEY:')) {
      const a = attrs(line.slice(11));
      const method = (a.METHOD || 'NONE').toUpperCase();
      const fmt = (a.KEYFORMAT || 'identity').toLowerCase();
      if (method === 'NONE') key = null;
      else if (method === 'AES-128' && fmt === 'identity') key = { uri: abs(a.URI, base), iv: a.IV || null };
      else throw new Error(m('eng_unsupportedEnc', `${method} ${fmt}`));
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = attrs(line.slice(11));
      map = abs(a.URI, base);
      mapRange = a.BYTERANGE ? parseRange(a.BYTERANGE, 0) : null;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) range = line.slice(17);
    else if (line.startsWith('#EXTINF:')) dur = parseFloat(line.slice(8)) || 0;
    else if (line && !line.startsWith('#')) {
      const url = abs(line, base);
      const r = range ? parseRange(range, lastEnd) : null;
      if (r) lastEnd = r.end;
      segs.push({ url, dur, key, map, mapRange, seq: seq + segs.length, range: r });
      range = null;
    }
  }
  return segs;
}

// -------------------------------------------------------------- probe -----
const VIDEO_PREFIXES = ['avc', 'hvc', 'hev', 'av01', 'vp09', 'vp8', 'vp9', 'dvh', 'dva', 'mp4v'];

function splitCodecs(codecs) {
  const v = [], a = [];
  for (let c of (codecs || '').split(',')) {
    c = c.trim();
    if (!c) continue;
    const lc = c.toLowerCase();
    if (VIDEO_PREFIXES.some((p) => lc.startsWith(p))) v.push(c);
    else if (!lc.startsWith('stpp') && !lc.startsWith('wvtt')) a.push(c);
  }
  return [v, a];
}

function drmFromKeys(keys) {
  let clear = null;
  for (const k of keys) {
    const method = (k.METHOD || '').toUpperCase();
    const fmt = (k.KEYFORMAT || 'identity').toLowerCase();
    if (!method || method === 'NONE') continue;
    if (method === 'AES-128' && fmt === 'identity') { clear = 'AES-128'; continue; }
    if (fmt.includes('widevine') || fmt.includes('edef8ba9')) return ['Widevine', clear];
    if (fmt.includes('playready') || fmt.includes('9a04f079')) return ['PlayReady', clear];
    if (fmt.includes('fairplay') || fmt === 'com.apple.streamingkeydelivery') return ['FairPlay', clear];
    return [`${method} (${fmt})`, clear];
  }
  return [null, clear];
}

function mediaInfo(text) {
  let duration = 0, segments = 0;
  const keys = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) { duration += parseFloat(line.slice(8)) || 0; segments++; }
    else if (line.startsWith('#EXT-X-KEY:')) keys.push(attrs(line.slice(11)));
  }
  return { duration, keys, segments, live: !text.includes('#EXT-X-ENDLIST') };
}

const AUDIO_EXT_RE = /\.(aac|ac3|ec3|eac3|mp3|m4a|opus)(?:[?#]|$)/i;

/**
 * Analyses an HLS playlist. `get(url)` fetches text (with the page's headers),
 * `onHosts(urls)` is told about every URL about to be fetched.
 */
export async function probeHls(url, { get = fetchText, fetchOpts, onHosts } = {}) {
  const load = async (u) => { await onHosts?.([u]); return get(u, fetchOpts); };
  const text = await load(url);
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error(m('eng_notHls'));

  if (!text.includes('#EXT-X-STREAM-INF')) {
    // A media playlist on its own
    const info = mediaInfo(text);
    const [drm, enc] = drmFromKeys(info.keys);
    const first = parseMediaPlaylist(text, url)[0];
    const audioOnly = !!first && AUDIO_EXT_RE.test(first.url);
    const base = { kind: 'hls', master: false, duration: info.duration || null, live: info.live, drm, encryption: enc, video: [], audio: [], subs: [], childUrls: [] };
    if (audioOnly) base.audio = [{ id: 'a0', url, lang: null, name: 'Audio', codec: null, channels: null, default: true }];
    // resolution unknown without reading a segment; muxed audio is picked up if present
    else base.video = [{ id: 'v0', url, width: null, height: null, bandwidth: null, codec: null, fps: null, hasAudio: true, audioCodec: null, maybeAudio: true }];
    return base;
  }

  const media = [], variants = [], sessionKeys = [];
  let pending = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attrs(line.slice(13));
      if (a.URI) a.URI = abs(a.URI, url);
      media.push(a);
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) pending = attrs(line.slice(18));
    else if (line.startsWith('#EXT-X-SESSION-KEY:')) sessionKeys.push(attrs(line.slice(19)));
    else if (line && !line.startsWith('#') && pending) { pending.URI = abs(line, url); variants.push(pending); pending = null; }
  }

  const groupAudioCodec = {};
  for (const v of variants) {
    const [, ac] = splitCodecs(v.CODECS);
    if (v.AUDIO && ac.length && !groupAudioCodec[v.AUDIO]) groupAudioCodec[v.AUDIO] = ac[0];
  }
  const audioGroupsWithUri = new Set(media.filter((m) => m.TYPE === 'AUDIO' && m.URI).map((m) => m['GROUP-ID']));

  const videos = new Map();
  for (const v of variants) {
    let w = null, h = null;
    const m = /^(\d+)x(\d+)$/i.exec(v.RESOLUTION || '');
    if (m) { w = +m[1]; h = +m[2]; }
    const [vc, ac] = splitCodecs(v.CODECS);
    const bw = parseInt(v['AVERAGE-BANDWIDTH'] || v.BANDWIDTH || 0, 10) || null;
    const separateAudio = !!v.AUDIO && audioGroupsWithUri.has(v.AUDIO);
    const hasAudio = ac.length > 0 && !separateAudio;
    if (!vc.length && !w && ac.length) continue;   // audio-only variant listed as STREAM-INF
    const cur = videos.get(v.URI);
    if (!cur || (bw || 0) < (cur.bandwidth || 0)) {
      // keep the lowest bandwidth reading (= closest to the video-only bitrate)
      videos.set(v.URI, {
        url: v.URI, width: w, height: h, bandwidth: bw, codec: vc[0] || null,
        fps: v['FRAME-RATE'] ? parseFloat(v['FRAME-RATE']) || null : null,
        hasAudio, audioCodec: hasAudio ? ac[0] : null, range: v['VIDEO-RANGE'] || null,
      });
    }
  }
  const video = [...videos.values()].sort((a, b) => ((b.height || 0) - (a.height || 0)) || ((b.bandwidth || 0) - (a.bandwidth || 0)));
  video.forEach((v, i) => { v.id = `v${i}`; });

  const audio = [], subs = [], seen = new Set();
  for (const x of media) {
    if (!x.URI || seen.has(x.URI)) continue;
    seen.add(x.URI);
    if (x.TYPE === 'AUDIO') {
      audio.push({
        id: `a${audio.length}`, url: x.URI, lang: x.LANGUAGE || null, name: x.NAME || null,
        codec: groupAudioCodec[x['GROUP-ID']] || null, channels: (x.CHANNELS || '').split('/')[0] || null,
        default: x.DEFAULT === 'YES', group: x['GROUP-ID'] || null,
      });
    } else if (x.TYPE === 'SUBTITLES') {
      subs.push({
        id: `s${subs.length}`, url: x.URI, lang: x.LANGUAGE || null, name: x.NAME || null,
        forced: x.FORCED === 'YES', default: x.DEFAULT === 'YES',
      });
    }
  }

  let [drm, enc] = drmFromKeys(sessionKeys);
  let duration = null, live = false;
  const target = video[0]?.url || audio[0]?.url;
  if (target) {
    try {
      const info = mediaInfo(await load(target));
      duration = info.duration || null;
      live = info.live;
      const [d2, e2] = drmFromKeys(info.keys);
      drm = drm || d2;
      enc = enc || e2;
    } catch (e) {
      console.warn('[flux] media playlist probe failed', target, e);
    }
  }
  return {
    kind: 'hls', master: true, duration, live, drm, encryption: enc, video, audio, subs,
    childUrls: [...video.map((v) => v.url), ...audio.map((a) => a.url), ...subs.map((s) => s.url)],
  };
}
