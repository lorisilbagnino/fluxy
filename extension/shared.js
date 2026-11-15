// Helpers shared by the background worker and the popup.

export const DEFAULT_SETTINGS = {
  engine: 'browser',          // 'browser' = everything in the extension, 'native' = ffmpeg + yt-dlp via the local app
  outputDir: '~/Downloads',   // native engine only (the browser engine saves to the browser's download folder)
  container: 'mkv', langs: 'it, en', fragments: 8, autoDetect: false,
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

// YouTube is out of scope (and its downloads are forbidden by the Chrome Web Store policy).
const BLOCKED_HOST_RE = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|googlevideo\.com|ytimg\.com)$/i;

export function isBlockedUrl(u) {
  try { return BLOCKED_HOST_RE.test(new URL(u).hostname); } catch { return false; }
}
