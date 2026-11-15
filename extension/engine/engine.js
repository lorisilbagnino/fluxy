// Flux Capacitor — in-browser download engine.
// Downloads HLS renditions with fetch (parallel, AES-128 via WebCrypto), stages
// them in OPFS, then remuxes them with Mediabunny (packet copy, no re-encode)
// into one MKV/MP4 written back to OPFS.

import {
  Input, Output, BlobSource, StreamTarget, ALL_FORMATS, EncodedPacket, EncodedPacketSink,
  EncodedVideoPacketSource, EncodedAudioPacketSource, TextSubtitleSource,
  MkvOutputFormat, Mp4OutputFormat,
} from './mediabunny.min.mjs';
import { fetchBytes, fetchText, CancelledError } from './net.js';
import { parseMediaPlaylist } from './hls.js';

// ISO 639-1 -> 639-2/T (what Matroska/MP4 muxers expect)
const LANG3 = {
  it: 'ita', en: 'eng', fr: 'fra', de: 'deu', es: 'spa', pt: 'por', ja: 'jpn', ko: 'kor', zh: 'zho', ru: 'rus',
  ar: 'ara', nl: 'nld', sv: 'swe', no: 'nor', nb: 'nob', da: 'dan', fi: 'fin', pl: 'pol', cs: 'ces', sk: 'slk',
  hu: 'hun', ro: 'ron', el: 'ell', tr: 'tur', he: 'heb', hi: 'hin', th: 'tha', vi: 'vie', id: 'ind', ms: 'msa',
  uk: 'ukr', bg: 'bul', hr: 'hrv', sr: 'srp', sl: 'slv', ca: 'cat', eu: 'eus', gl: 'glg', et: 'est', lv: 'lav',
  lt: 'lit', fa: 'fas', ta: 'tam', te: 'tel', bn: 'ben', ur: 'urd', tl: 'tgl',
};
export const lang3 = (c) => { if (!c) return 'und'; const b = c.toLowerCase().split(/[-_]/)[0]; return b.length === 3 ? b : (LANG3[b] || 'und'); };

// ---------------------------------------------------------------- fetch ----
const keyCache = new Map();
async function getKey(uri, fetchOpts) {
  if (!keyCache.has(uri)) {
    const p = (async () => crypto.subtle.importKey('raw', await fetchBytes(uri, fetchOpts), 'AES-CBC', false, ['decrypt']))();
    p.catch(() => keyCache.delete(uri));
    keyCache.set(uri, p);
  }
  return keyCache.get(uri);
}

function ivFor(seg) {
  const iv = new Uint8Array(16);
  if (seg.key.iv) {
    const hex = seg.key.iv.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else new DataView(iv.buffer).setUint32(12, seg.seq);
  return iv;
}

async function fetchSegment(seg, fetchOpts) {
  const opts = seg.range
    ? { ...fetchOpts, headers: { ...fetchOpts?.headers, Range: `bytes=${seg.range.start}-${seg.range.end - 1}` } }
    : fetchOpts;
  const buf = await fetchBytes(seg.url, opts);
  if (!seg.key) return buf;
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(seg) }, await getKey(seg.key.uri, fetchOpts), buf));
}

const segmentHosts = (segs) => [...new Set(segs.flatMap((s) => [s.url, s.key?.uri, s.map].filter(Boolean)))];

// ---------------------------------------------------------- packed audio ---
// HLS "packed audio" segments (raw AAC/AC3/E-AC3) start with an ID3 tag that
// carries the segment's MPEG-TS timestamp (com.apple.streaming.transportStreamTimestamp).
function stripId3(u8) {
  let off = 0, pts = null;
  while (u8.length - off > 10 && u8[off] === 0x49 && u8[off + 1] === 0x44 && u8[off + 2] === 0x33) {
    const size = (u8[off + 6] << 21) | (u8[off + 7] << 14) | (u8[off + 8] << 7) | u8[off + 9];
    const footer = u8[off + 5] & 0x10 ? 10 : 0;
    const tag = u8.subarray(off, off + 10 + size + footer);
    const txt = new TextDecoder('latin1').decode(tag);
    const i = txt.indexOf('com.apple.streaming.transportStreamTimestamp');
    if (i >= 0 && pts === null) {
      const p = i + 'com.apple.streaming.transportStreamTimestamp'.length + 1;
      const hi = tag[p + 3] & 1;
      const lo = ((tag[p + 4] << 24) >>> 0) + (tag[p + 5] << 16) + (tag[p + 6] << 8) + tag[p + 7];
      pts = (hi * 2 ** 32 + lo) / 90000;
    }
    off += 10 + size + footer;
  }
  return { data: off ? u8.subarray(off) : u8, pts };
}

function sniff(u8) {
  if (u8[0] === 0x47 && (u8.length < 189 || u8[188] === 0x47)) return 'ts';
  if (u8[0] === 0xff && (u8[1] & 0xf0) === 0xf0) return 'adts';
  if (u8[0] === 0x0b && u8[1] === 0x77) return (u8[5] >> 3) > 10 ? 'eac3' : 'ac3';
  const box = new TextDecoder('latin1').decode(u8.subarray(4, 8));
  if (['ftyp', 'styp', 'moof', 'sidx', 'moov'].includes(box)) return 'mp4';
  return 'unknown';
}

// ------------------------------------------------------------- download ----
/** Downloads one rendition into an OPFS file. Returns {file, kind, startPts}. */
export async function downloadTrack(url, { dir, name, fetchOpts, parallel = 8, onProgress, ensureHosts }) {
  const signal = fetchOpts?.signal;
  await ensureHosts?.([url]);
  const segs = parseMediaPlaylist(await fetchText(url, fetchOpts), url);
  if (!segs.length) throw new Error('Playlist vuota');
  await ensureHosts?.(segmentHosts(segs));
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  let kind = null, startPts = null, bytes = 0, written = 0, next = 0;
  const done = new Map();
  let writing = Promise.resolve();

  if (segs[0].map) {
    const init = await fetchSegment({ ...segs[0], url: segs[0].map, key: null, range: segs[0].mapRange }, fetchOpts);
    await w.write(init); bytes += init.length; kind = 'mp4';
  }
  const flush = () => (writing = writing.then(async () => {
    while (done.has(written)) {
      let d = done.get(written); done.delete(written);
      if (kind !== 'mp4' && kind !== 'ts') {
        const s = stripId3(d); d = s.data;
        if (written === 0) startPts = s.pts;
      }
      if (kind === null) kind = sniff(d);
      await w.write(d); bytes += d.length; written++;
      onProgress?.({ done: written, total: segs.length, bytes });
    }
  }));
  const worker = async () => {
    while (next < segs.length) {
      if (signal?.aborted) throw new CancelledError();
      if (next - written > parallel * 4) { await writing; await new Promise((r) => setTimeout(r, 20)); continue; }
      const i = next++;
      done.set(i, await fetchSegment(segs[i], fetchOpts));
      await flush();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(parallel, segs.length) }, worker));
    await writing;
  } catch (e) {
    await w.abort().catch(() => {});
    throw e;
  }
  await w.close();
  if (kind === null || kind === 'unknown') throw new Error(`Formato dei segmenti non riconosciuto (${name})`);
  return { file: await fh.getFile(), kind, startPts, duration: segs.reduce((a, s) => a + s.dur, 0), segments: segs.length };
}

// ------------------------------------------------------------ subtitles ----
const vttTime = (t) => { const p = t.split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
const fmtTime = (s) => { s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = (s % 60).toFixed(3).padStart(6, '0'); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${x}`; };

/** Fetches a segmented WebVTT playlist and returns one WebVTT text on the MPEG-TS clock minus `base`. */
export async function downloadSubtitles(url, { fetchOpts, base = 0, parallel = 8, ensureHosts }) {
  await ensureHosts?.([url]);
  const segs = parseMediaPlaylist(await fetchText(url, fetchOpts), url);
  await ensureHosts?.(segmentHosts(segs));
  const texts = new Array(segs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallel, segs.length) }, async () => {
    while (next < segs.length) { const i = next++; texts[i] = new TextDecoder().decode(await fetchSegment(segs[i], fetchOpts)); }
  }));
  const cues = [], seen = new Set();
  for (const t of texts) {
    let offset = 0;
    const m = t.match(/X-TIMESTAMP-MAP=([^\r\n]+)/);
    if (m) {
      // X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000  (key and value separated by the FIRST colon)
      const a = Object.fromEntries(m[1].split(',').map((kv) => { const i = kv.indexOf(':'); return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]; }));
      offset = (Number(a.MPEGTS) || 0) / 90000 - vttTime(a.LOCAL || '00:00:00.000');
    }
    for (const block of t.split(/\r?\n\r?\n/)) {
      const lines = block.split(/\r?\n/);
      const idx = lines.findIndex((l) => l.includes('-->'));
      if (idx < 0) continue;
      const [a, rest] = lines[idx].split('-->');
      const [b, ...settings] = rest.trim().split(/\s+/);
      const start = vttTime(a.trim()) + offset - base, end = vttTime(b) + offset - base;
      const body = lines.slice(idx + 1).join('\n').trim();
      const k = `${start.toFixed(3)}|${body}`;
      if (!body || seen.has(k)) continue;   // cues repeated across segment boundaries
      seen.add(k);
      cues.push({ start, end, line: `${fmtTime(start)} --> ${fmtTime(end)}${settings.length ? ' ' + settings.join(' ') : ''}`, body });
    }
  }
  cues.sort((x, y) => x.start - y.start);
  return 'WEBVTT\n\n' + cues.map((c) => `${c.line}\n${c.body}`).join('\n\n') + '\n';
}

// ------------------------------------------------------- AC3/E-AC3 frames --
const AC3_RATES = [48000, 44100, 32000];
const AC3_SIZES = [ // words per frame, [frmsizecod>>1][fscod]
  [64, 69, 96], [80, 87, 120], [96, 104, 144], [112, 121, 168], [128, 139, 192], [160, 174, 240], [192, 208, 288],
  [224, 243, 336], [256, 278, 384], [320, 348, 480], [384, 417, 576], [448, 487, 672], [512, 557, 768],
  [640, 696, 960], [768, 835, 1152], [896, 975, 1344], [1024, 1114, 1536], [1152, 1253, 1728], [1280, 1393, 1920]];
const AC3_CH = [2, 1, 2, 3, 3, 4, 4, 5];

function ac3Info(f, eac3) {
  if (!eac3) {
    const fscod = f[4] >> 6, frmsizecod = f[4] & 0x3f;
    let size = AC3_SIZES[frmsizecod >> 1][fscod] * 2;
    if (fscod === 1 && (frmsizecod & 1)) size += 2;
    // BSI starts at byte 5: bsid(5) bsmod(3) acmod(3) [cmixlev(2)] [surmixlev(2)] [dsurmod(2)] lfeon(1)
    const bitAt = (n) => (f[n >> 3] >> (7 - (n & 7))) & 1;
    let bit = 5 * 8 + 8;
    const acmod = (bitAt(bit) << 2) | (bitAt(bit + 1) << 1) | bitAt(bit + 2);
    bit += 3;
    if ((acmod & 1) && acmod !== 1) bit += 2;
    if (acmod & 4) bit += 2;
    if (acmod === 2) bit += 2;
    const lfe = bitAt(bit);
    return { size, rate: AC3_RATES[fscod], samples: 1536, channels: AC3_CH[acmod] + lfe };
  }
  const size = ((((f[2] & 0x07) << 8) | f[3]) + 1) * 2;
  const fscod = f[4] >> 6;
  const numblkscod = fscod === 3 ? 3 : (f[4] >> 4) & 3;
  const rate = fscod === 3 ? [24000, 22050, 16000][(f[4] >> 4) & 3] : AC3_RATES[fscod];
  const acmod = (f[4] >> 1) & 7, lfe = f[4] & 1;
  return { size, rate, samples: [1, 2, 3, 6][numblkscod] * 256, channels: AC3_CH[acmod] + lfe };
}

/** Async generator of EncodedPackets for a raw AC3/E-AC3 elementary stream stored in a File. */
async function* ac3Packets(file, eac3, info) {
  const CH = 4 << 20;
  let buf = new Uint8Array(0), pos = 0, t = 0;
  while (pos < file.size || buf.length >= 8) {
    if (buf.length < 4096 && pos < file.size) {
      const more = new Uint8Array(await file.slice(pos, pos + CH).arrayBuffer());
      pos += more.length;
      const nb = new Uint8Array(buf.length + more.length); nb.set(buf); nb.set(more, buf.length); buf = nb;
    }
    let i = 0;
    while (i + 8 <= buf.length) {
      if (buf[i] !== 0x0b || buf[i + 1] !== 0x77) { i++; continue; }
      const fi = ac3Info(buf.subarray(i), eac3);
      if (i + fi.size > buf.length) break;
      if (!info.rate) Object.assign(info, fi);
      const d = fi.samples / fi.rate;
      yield new EncodedPacket(buf.slice(i, i + fi.size), 'key', t, d);
      t += d; i += fi.size;
    }
    buf = buf.slice(i);
    if (pos >= file.size && i === 0) break;
  }
}

// ------------------------------------------------------------------ mux ----
/** Opens a downloaded track as a stream of packets (+ decoder config). */
async function openTrack(dl, want) {
  if (dl.kind === 'ac3' || dl.kind === 'eac3') {
    const info = {};
    const gen = ac3Packets(dl.file, dl.kind === 'eac3', info);
    const first = await gen.next();
    return {
      type: 'audio', codec: dl.kind, first: first.value, rest: gen,
      decoderConfig: { codec: dl.kind === 'eac3' ? 'ec-3' : 'ac-3', sampleRate: info.rate, numberOfChannels: info.channels },
      // our own packets start at 0: the real start is the ID3 timestamp of the first segment
      startTs: dl.startPts ?? 0, shiftIn: dl.startPts ?? 0,
    };
  }
  const input = new Input({ source: new BlobSource(dl.file), formats: ALL_FORMATS });
  const track = want === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
  if (!track) throw new Error(`Nessuna traccia ${want} nel file scaricato (${dl.kind})`);
  const sink = new EncodedPacketSink(track);
  const gen = sink.packets();
  const first = await gen.next();
  // packed audio (ADTS): timestamps restart from 0, the real start is in the ID3 tag
  const startTs = dl.startPts != null ? dl.startPts : first.value.timestamp;
  const shiftIn = dl.startPts != null ? dl.startPts - first.value.timestamp : 0;
  return { type: want, codec: track.codec, first: first.value, rest: gen, decoderConfig: await track.getDecoderConfig(), startTs, shiftIn, input };
}

/**
 * Remuxes downloaded tracks into one file.
 * tracks: [{dl, type:'video'|'audio', lang, name, optional}]
 * subs:   [{url | text, lang, name, forced}]  — `text` is filled in (WebVTT on the output clock)
 * embedSubs: false keeps subtitles out of the file (MP4: `wvtt` is poorly supported, use .srt sidecars)
 */
export async function mux({ tracks, subs = [], container = 'mkv', embedSubs = container !== 'mp4', outHandle, duration, fetchOpts, onProgress, onStage, ensureHosts }) {
  const signal = fetchOpts?.signal;
  const opened = [];
  for (const t of tracks) {
    try { opened.push({ ...t, ...(await openTrack(t.dl, t.type)) }); }
    catch (e) { if (!t.optional) throw e; }   // e.g. video rendition without muxed audio
  }
  if (!opened.length) throw new Error('Nessuna traccia da unire');
  const base = Math.min(...opened.map((o) => o.startTs));
  // subtitles are placed on the same clock as audio/video
  if (subs.length) onStage?.('Sottotitoli');
  for (const s of subs) if (s.url && !s.text) s.text = await downloadSubtitles(s.url, { fetchOpts, base, ensureHosts });
  onStage?.('Unione in un unico file');

  const writable = await outHandle.createWritable();
  const output = new Output({
    format: container === 'mp4' ? new Mp4OutputFormat() : new MkvOutputFormat(),
    target: new StreamTarget(writable, { chunked: true }),
  });
  let aIdx = 0;
  for (const o of opened) {
    const meta = { languageCode: o.type === 'audio' ? lang3(o.lang) : undefined, name: o.name || undefined };
    if (o.type === 'video') {
      o.source = new EncodedVideoPacketSource(o.codec);
      output.addVideoTrack(o.source, { ...meta, disposition: { default: true } });
    } else {
      o.source = new EncodedAudioPacketSource(o.codec);
      output.addAudioTrack(o.source, { ...meta, disposition: { default: aIdx++ === 0 } });
    }
    o.offset = (o.shiftIn || 0) - base;  // input timestamp -> output timestamp
    o.cur = o.first; o.sentConfig = false; o.progress = -Infinity;
  }
  const subSources = (embedSubs ? subs : []).map((s) => {
    const src = new TextSubtitleSource('webvtt');
    let name = s.name || '';
    if (s.forced && !/forced/i.test(name)) name = `${name} (forced)`.trim();
    output.addSubtitleTrack(src, { languageCode: lang3(s.lang), name: name || undefined, disposition: { forced: !!s.forced, default: false } });
    return { src, text: s.text };
  });
  await output.start();
  for (const s of subSources) await s.src.add(s.text);

  // Interleave: always feed the track that is furthest behind (keeps the muxer's buffers small).
  let lastReport = 0;
  for (;;) {
    if (signal?.aborted) { await output.cancel().catch(() => {}); throw new CancelledError(); }
    let pick = null;
    for (const o of opened) if (o.cur && (!pick || o.progress < pick.progress)) pick = o;
    if (!pick) break;
    const p = pick.cur;
    const ts = p.timestamp + pick.offset;
    const pkt = p.clone({ timestamp: ts });
    await pick.source.add(pkt, pick.sentConfig ? undefined : { decoderConfig: pick.decoderConfig });
    pick.sentConfig = true;
    pick.progress = Math.max(pick.progress, ts);
    pick.cur = (await pick.rest.next()).value || null;
    if (duration && performance.now() - lastReport > 300) {
      lastReport = performance.now();
      onProgress?.(Math.min(1, Math.min(...opened.map((o) => (o.cur ? o.progress : duration))) / duration));
    }
  }
  for (const s of subSources) s.src.close?.();
  for (const o of opened) o.source.close?.();
  await output.finalize();
  for (const o of opened) o.input?.dispose?.();
  if (container !== 'mp4' && subSources.length) await patchMkvSubtitleCodec(outHandle);
  return outHandle.getFile();
}

/**
 * Mediabunny writes WebVTT tracks as "S_TEXT/WEBVTT" (Matroska spec), which
 * FFmpeg-based players (mpv, Kodi, ...) don't recognise. The block payload is
 * plain cue text, i.e. exactly what "S_TEXT/UTF8" (SRT) carries, and EBML
 * strings may be zero-padded: rewrite the ID in place, same length.
 */
async function patchMkvSubtitleCodec(handle) {
  const file = await handle.getFile();
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, 1 << 20)).arrayBuffer());
  const from = new TextEncoder().encode('S_TEXT/WEBVTT');
  const to = new Uint8Array(from.length); to.set(new TextEncoder().encode('S_TEXT/UTF8'));
  const hits = [];
  outer: for (let i = 0; i <= head.length - from.length; i++) {
    for (let j = 0; j < from.length; j++) if (head[i + j] !== from[j]) continue outer;
    hits.push(i);
  }
  if (!hits.length) return;
  const w = await handle.createWritable({ keepExistingData: true });
  for (const position of hits) await w.write({ type: 'write', position, data: to });
  await w.close();
}

/** WebVTT (as produced by downloadSubtitles) -> SRT */
export function vttToSrt(vtt) {
  const out = [];
  for (const block of vtt.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, rest] = lines[i].split('-->');
    const b = rest.trim().split(/\s+/)[0];
    const fix = (t) => { t = t.trim(); if (t.split(':').length === 2) t = '00:' + t; return t.replace('.', ','); };
    const text = lines.slice(i + 1).join('\n')
      .replace(/<(\/?)(?:c|v|lang|ruby|rt)(?:[.\s][^>]*)?>/g, '')   // WebVTT-only tags
      .trim();
    if (text) out.push(`${out.length + 1}\n${fix(a)} --> ${fix(b)}\n${text}`);
  }
  return out.join('\n\n') + '\n';
}
