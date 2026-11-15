// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 lorisilbagnino — Fluxy, https://github.com/lorisilbagnino/fluxy (see ADDITIONAL-TERMS.md)
// Helpers shared by the background worker and the popup.

import { STORE_BUILD } from './build-flags.js';

// Preferred languages default to the browser's language, plus English.
const uiLang = (globalThis.chrome?.i18n?.getUILanguage?.() || 'en').split('-')[0].toLowerCase();

export const DEFAULT_SETTINGS = {
  engine: 'browser',          // 'browser' = everything in the extension, 'native' = ffmpeg + yt-dlp via the local app
  outputDir: '~/Downloads',   // native engine only (the browser engine saves to the browser's download folder)
  container: 'mkv', langs: [...new Set([uiLang, 'en'])].join(', '), fragments: 8, autoDetect: false,
};

export function stripQuery(u) {
  try { const x = new URL(u); return x.origin + x.pathname; } catch { return u; }
}

/** URLs of renditions already described by an analysed master playlist. */
export function childSet(streams) {
  const set = new Set();
  for (const s of streams) {
    if (s.probe?.status === 'ok') {
      for (const u of s.probe.data.childUrls || []) { set.add(u); set.add(stripQuery(u)); }
    }
  }
  return set;
}

export function isChild(stream, set) {
  // An analysed master playlist is never hidden: many players serve master and
  // renditions from the same path, differing only in the query string
  // (/playlist/123?token=… vs /playlist/123?rendition=1080p&token=…).
  if (stream.probe?.status === 'ok' && stream.probe.data?.master) return false;
  return set.has(stream.url) || set.has(stripQuery(stream.url));
}

// Store builds leave YouTube out (Chrome Web Store policy). The GitHub build supports it via yt-dlp.
const BLOCKED_HOST_RE = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|googlevideo\.com|ytimg\.com)$/i;

export function isBlockedUrl(u) {
  if (!STORE_BUILD) return false;
  try { return BLOCKED_HOST_RE.test(new URL(u).hostname); } catch { return false; }
}

/** Pages that yt-dlp handles but that expose no HLS/DASH playlist to detect. */
const PAGE_SITE_RE = /(^|\.)(youtube\.com|youtu\.be)$/i;
export function isPageSite(u) {
  try { return PAGE_SITE_RE.test(new URL(u).hostname); } catch { return false; }
}
