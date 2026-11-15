// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 lorisilbagnino — Fluxy, https://github.com/lorisilbagnino/fluxy (see ADDITIONAL-TERMS.md)
//
// Page scanner: injected (isolated world) into every frame of the active tab when
// the popup opens. Finds videos that need no playback to be saved: <video>/<source>
// files, links to video files, og:video / JSON-LD metadata, player configurations
// with .m3u8/.mpd/.mp4 URLs in scripts or data-* attributes, embedded players
// (iframes of sites yt-dlp knows). Read-only: returns plain data, changes nothing.
// The value of the last expression is the result of chrome.scripting.executeScript.

(() => {
  const MAX_TEXT = 3_000_000;            // characters of inline scripts / attributes scanned per frame
  const FILE_EXT = 'mp4|m4v|webm|mov|mkv|ogv|mp3|m4a|aac|ogg|oga|opus|flac|wav';
  const URL_RE = new RegExp(`(?:https?:)?\\/\\/[^\\s"'<>()\\\\]+?\\.(m3u8|mpd|${FILE_EXT})(?:\\?[^\\s"'<>()\\\\]*)?(?=["'\\s<>()\\\\,;]|$)`, 'gi');
  const EXT_RE = new RegExp(`\\.(m3u8|mpd|${FILE_EXT})(?:[?#]|$)`, 'i');
  const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav)(?:[?#]|$)/i;
  // Embedded players worth handing to yt-dlp (iframe src patterns)
  const EMBED_RE = /^https?:\/\/(?:www\.)?(?:youtube(?:-nocookie)?\.com\/embed\/|player\.vimeo\.com\/video\/|(?:www\.)?dailymotion\.com\/embed\/|geo\.dailymotion\.com\/player|player\.twitch\.tv\/|clips\.twitch\.tv\/embed|streamable\.com\/[eo]\/|rumble\.com\/embed\/|(?:www\.)?facebook\.com\/plugins\/video|player\.bilibili\.com\/|fast\.wistia\.(?:net|com)\/embed\/|(?:www\.)?loom\.com\/embed\/|w\.soundcloud\.com\/player)/i;

  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch { return null; } };
  const unescape = (s) => s.replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const kindOf = (u) => { const m = EXT_RE.exec(u || ''); return m ? (m[1].toLowerCase() === 'm3u8' ? 'hls' : m[1].toLowerCase() === 'mpd' ? 'dash' : 'file') : null; };

  const out = {
    frameUrl: location.href, top: window === window.top, title: document.title || '',
    ogTitle: document.querySelector('meta[property="og:title"],meta[name="og:title"]')?.content || '',
    videos: [], urls: [], embeds: [], blobVideos: 0, drmVideos: 0,
  };
  const seen = new Set();
  const addUrl = (u, via, extra = {}) => {
    u = abs(unescape(u || '').trim());
    if (!u || !/^https?:/.test(u) || seen.has(u)) return null;
    const kind = kindOf(u);
    if (!kind) return null;
    seen.add(u);
    const item = { url: u, kind, via, ...extra };
    out.urls.push(item);
    return item;
  };

  // ---- <video> / <audio> elements --------------------------------------------
  const nearbyTitle = (el) => el.getAttribute('title') || el.getAttribute('aria-label')
    || el.closest('figure')?.querySelector('figcaption')?.textContent?.trim() || '';
  for (const el of document.querySelectorAll('video, audio')) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const visible = r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    const src = el.currentSrc || el.getAttribute('src') || '';
    if (el.mediaKeys) out.drmVideos++;
    const info = {
      tag: el.tagName.toLowerCase(), visible, area: Math.round(r.width * r.height),
      width: el.videoWidth || 0, height: el.videoHeight || 0,
      duration: Number.isFinite(el.duration) ? el.duration : null,
      muted: el.muted, loop: el.loop, autoplay: el.autoplay, controls: el.controls,
      poster: el.getAttribute('poster') ? abs(el.getAttribute('poster')) : null,
      title: nearbyTitle(el), sources: [],
    };
    if (src.startsWith('blob:') || src.startsWith('mediasource:')) out.blobVideos++;
    const cands = [];
    for (const s of el.querySelectorAll('source')) {
      const u = s.getAttribute('src');
      if (u) cands.push({
        url: u, type: s.getAttribute('type') || '',
        label: s.getAttribute('label') || s.getAttribute('title') || s.getAttribute('data-quality') || s.getAttribute('res') || '',
        size: parseInt(s.getAttribute('size') || s.getAttribute('data-res') || s.getAttribute('res') || '', 10) || null,
      });
    }
    // <source> first: they carry the quality labels; the playing URL is usually one of them
    if (src && !src.startsWith('blob:')) cands.push({ url: src, type: el.getAttribute('type') || '' });
    for (const c of cands) {
      const u = abs(c.url);
      if (!u || !/^https?:/.test(u) || info.sources.some((x) => x.url === u)) continue;
      // <source type="application/x-mpegURL"> without extension
      const kind = kindOf(u) || (/mpegurl/i.test(c.type) ? 'hls' : /dash/i.test(c.type) ? 'dash' : /^(video|audio)\//i.test(c.type) ? 'file' : null)
        || 'file';
      info.sources.push({ url: u, kind, type: c.type, label: c.label || '', height: c.size || null });
      seen.add(u);
    }
    if (info.sources.length || info.visible) out.videos.push(info);
  }

  // ---- links to video files ---------------------------------------------------
  for (const a of document.querySelectorAll('a[href]')) {
    const h = a.getAttribute('href');
    if (h && EXT_RE.test(h)) addUrl(h, 'link', { title: a.textContent.trim().slice(0, 120) || a.getAttribute('download') || '' });
  }

  // ---- page metadata ----------------------------------------------------------
  for (const m of document.querySelectorAll('meta[property^="og:video"],meta[name^="og:video"],meta[name="twitter:player:stream"],meta[property="twitter:player:stream"]')) {
    const c = m.getAttribute('content');
    if (c && !/^(video\/|text\/|\d+$)/i.test(c)) addUrl(c, 'meta', { title: out.ogTitle });
  }
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try { data = JSON.parse(s.textContent); } catch { continue; }
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      const t = [].concat(o['@type'] || []);
      if (t.includes('VideoObject') || t.includes('AudioObject')) {
        if (o.contentUrl) addUrl(o.contentUrl, 'jsonld', { title: o.name || '' });
        if (o.embedUrl && EMBED_RE.test(o.embedUrl)) out.embeds.push({ url: o.embedUrl, title: o.name || '' });
      }
      Object.values(o).forEach(walk);
    };
    walk(data);
  }

  // ---- player configurations (inline scripts, data-* attributes) -------------
  let budget = MAX_TEXT;
  const paths = new Set();
  const scanText = (text, via) => {
    if (!text || budget <= 0) return;
    text = text.slice(0, budget); budget -= text.length;
    for (const m of unescape(text).matchAll(URL_RE)) {
      let path;
      try { path = new URL(m[0], document.baseURI).pathname.replace(/\/(exp|psid)=[^/]*/g, ''); } catch { continue; }
      if (paths.has(path)) continue;   // the same file behind several CDNs or signed URLs
      paths.add(path);
      addUrl(m[0], via);
    }
  };
  for (const s of document.querySelectorAll('script:not([src])')) {
    if (s.type && !/javascript|json|module/i.test(s.type) && s.type !== '') continue;
    scanText(s.textContent, 'script');
  }
  for (const el of document.querySelectorAll('[data-setup],[data-config],[data-src],[data-video],[data-video-src],[data-hls],[data-dash],[data-mp4],[data-source],[data-sources],[data-file],[data-stream],[data-url]')) {
    for (const a of el.attributes) if (a.name.startsWith('data-')) scanText(a.value, 'data');
  }

  // ---- embedded players -------------------------------------------------------
  for (const f of document.querySelectorAll('iframe[src],iframe[data-src]')) {
    const u = abs(f.getAttribute('src') || f.getAttribute('data-src'));
    if (u && EMBED_RE.test(u) && !out.embeds.some((e) => e.url === u)) {
      out.embeds.push({ url: u, title: f.getAttribute('title') || '' });
    }
  }

  out.urls.forEach((u) => { if (u.kind === 'file' && AUDIO_EXT.test(u.url)) u.audio = true; });
  return out;
})();
