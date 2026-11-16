// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 lorisilbagnino — Fluxy, https://github.com/lorisilbagnino/fluxy (see ADDITIONAL-TERMS.md)
// Fluxy — background (service worker on Chromium, event page on Firefox)
// Detects HLS/DASH manifests, analyses them, runs downloads with the in-browser
// engine (offscreen document / background page) or the optional native host.

import { DEFAULT_SETTINGS, childSet, isChild, isBlockedUrl, EMBED_PLAYER_RE } from './shared.js';
import { probeHls } from './engine/hls.js';
import { fetchText } from './engine/net.js';
import { engineStrings } from './engine/i18n.js';

const tx = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;
const UI_LANG = chrome.i18n.getUILanguage();

const HOST = 'com.fluxy.host';
const MANIFEST_URL_RE = /\.(m3u8|mpd)(?:[?#;]|$)/i;
const MANIFEST_CT_RE = /(mpegurl|dash\+xml)/i;
const KEEP_HEADER_RE = /^(referer|origin|cookie|user-agent|authorization|x-[\w-]+)$/i;
const PROBE_DELAY_MS = 1200;
const PORT_IDLE_MS = 60_000;
// Firefox exposes `browser` and rejects the Chromium-only 'extraHeaders' option
// (it already includes Cookie/Referer in requestHeaders).
const IS_FIREFOX = typeof browser !== 'undefined' && !!browser.runtime?.getBrowserInfo;
const SEND_HEADERS_OPTS = IS_FIREFOX ? ['requestHeaders'] : ['requestHeaders', 'extraHeaders'];
const HOST_MISSING_RE = /not found|no such native application|forbidden|not allowed|access to the specified native messaging host/i;


// ---------------------------------------------------------------- state ---
const tabCache = new Map();       // tabId -> {streams: []}
const tabLocks = new Map();       // tabId -> Promise chain
const reqHeaders = new Map();     // requestId -> headers object

async function loadTab(tabId) {
  if (tabCache.has(tabId)) return tabCache.get(tabId);
  const key = `tab:${tabId}`;
  const stored = (await chrome.storage.session.get(key))[key];
  const t = stored || { streams: [] };
  if (!tabCache.has(tabId)) tabCache.set(tabId, t);
  return tabCache.get(tabId);
}

function withTab(tabId, fn) {
  const prev = tabLocks.get(tabId) || Promise.resolve();
  const next = prev.then(async () => {
    const t = await loadTab(tabId);
    const r = await fn(t);
    await chrome.storage.session.set({ [`tab:${tabId}`]: t });
    updateBadge(tabId, t);
    return r;
  }).catch((e) => console.error('[flux] tab op failed', e));
  tabLocks.set(tabId, next);
  return next;
}

async function clearTab(tabId) {
  tabCache.delete(tabId);
  await chrome.storage.session.remove(`tab:${tabId}`);
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

function updateBadge(tabId, t) {
  const kids = childSet(t.streams);
  const n = t.streams.filter((s) => !isChild(s, kids)).length;
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#f59e0b' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
}

// ------------------------------------------------------------ detection ---
// Network listening is the costly part (it wakes the worker on every request of
// every tab), so it is only active when auto-detection is on or a tab has been
// armed with the "Rileva" button.
const FILTER = { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] };

let autoDetect = DEFAULT_SETTINGS.autoDetect;
const armed = new Set();          // tabIds with manual detection active

const watching = (tabId) => tabId >= 0 && (autoDetect || armed.has(tabId));

function onSendHeaders(d) {
  if (!watching(d.tabId)) return;
  const h = {};
  for (const { name, value } of d.requestHeaders || []) {
    if (KEEP_HEADER_RE.test(name) && value != null) h[name] = value;
  }
  reqHeaders.set(d.requestId, h);
}

function forget(d) { reqHeaders.delete(d.requestId); }

function onHeadersReceived(d) {
  if (!watching(d.tabId) || d.statusCode >= 400) return;
  const ct = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type')?.value || '';
  let kind = null;
  const m = d.url.match(MANIFEST_URL_RE);
  if (m) kind = m[1].toLowerCase() === 'mpd' ? 'dash' : 'hls';
  else if (MANIFEST_CT_RE.test(ct)) kind = /dash/i.test(ct) ? 'dash' : 'hls';
  if (!kind) return;
  const headers = reqHeaders.get(d.requestId) || {};
  onManifest(d.tabId, { url: d.url, kind, headers, initiator: d.initiator || null });
}

// A real navigation of the tab wipes its streams.
function onMainFrame(d) {
  if (d.tabId >= 0 && d.type === 'main_frame') clearTab(d.tabId);
}

// Events that arrive before settings are loaded (e.g. the one that woke the
// worker) are handled once they are, instead of being dropped.
let loaded = false;
const gated = (fn) => (d) => { loaded ? fn(d) : ready.then(() => fn(d)); };

const LISTENERS = [
  [chrome.webRequest.onSendHeaders, gated(onSendHeaders), FILTER, SEND_HEADERS_OPTS],
  [chrome.webRequest.onCompleted, forget, FILTER],
  [chrome.webRequest.onErrorOccurred, forget, FILTER],
  [chrome.webRequest.onHeadersReceived, gated(onHeadersReceived), FILTER, ['responseHeaders']],
  [chrome.webRequest.onBeforeRequest, onMainFrame, { urls: ['<all_urls>'], types: ['main_frame'] }],
];

function setListening(on) {
  for (const [event, fn, filter, extra] of LISTENERS) {
    if (on && !event.hasListener(fn)) extra ? event.addListener(fn, filter, extra) : event.addListener(fn, filter);
    else if (!on && event.hasListener(fn)) event.removeListener(fn);
  }
}

const refreshListening = () => setListening(autoDetect || armed.size > 0);

// Registered synchronously so that, when listening is wanted, events can wake
// the worker; removed right after if settings say otherwise.
setListening(true);
const ready = (async () => {
  const [{ settings }, { armed: stored }] = await Promise.all([
    chrome.storage.local.get('settings'), chrome.storage.session.get('armed'),
  ]);
  autoDetect = { ...DEFAULT_SETTINGS, ...settings }.autoDetect;
  for (const id of stored || []) armed.add(id);
  loaded = true;
  // Firefox: a new event page means the previous one (and its downloads) is gone.
  if (IS_FIREFOX) failRunningJobs(tx('errSuspended'), 'browser');
  refreshListening();
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    autoDetect = { ...DEFAULT_SETTINGS, ...changes.settings.newValue }.autoDetect;
    refreshListening();
  }
});

async function setArmed(tabId, on) {
  await ready;
  on ? armed.add(tabId) : armed.delete(tabId);
  await chrome.storage.session.set({ armed: [...armed] });
  refreshListening();
}

async function armTab(tabId) {
  await setArmed(tabId, true);
  await clearTab(tabId);
  await chrome.tabs.reload(tabId);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTab(tabId);
  if (armed.has(tabId)) setArmed(tabId, false);
});

function onManifest(tabId, info) {
  if (isBlockedUrl(info.url) || isBlockedUrl(info.initiator)) return;
  withTab(tabId, async (t) => {
    const existing = t.streams.find((s) => s.url === info.url);
    if (existing) {
      existing.headers = { ...existing.headers, ...info.headers };
      return;
    }
    let title = '';
    let pageUrl = '';
    try { const tab = await chrome.tabs.get(tabId); title = tab.title || ''; pageUrl = tab.url || ''; } catch {}
    if (isBlockedUrl(pageUrl)) return;
    const stream = {
      id: crypto.randomUUID().slice(0, 8),
      url: info.url, kind: info.kind, headers: info.headers, initiator: info.initiator,
      title, pageUrl, detectedAt: Date.now(), probe: null,
    };
    t.streams.push(stream);
    setTimeout(() => autoProbe(tabId, stream.id), PROBE_DELAY_MS);
  });
}

async function autoProbe(tabId, streamId, attempt = 0) {
  const t = await loadTab(tabId);
  const s = t.streams.find((x) => x.id === streamId);
  if (!s || s.probe || s.manual) return;
  if (s.kind === 'file') return probeStream(tabId, streamId);
  if (isChild(s, childSet(t.streams))) return; // already described by a master playlist
  // A master playlist is being analysed: wait for it, it will probably cover this one.
  // (streams detected earlier and not analysed yet count too: their probe may not have started)
  const busy = t.streams.some((x) => x.id !== s.id && (x.probe?.status === 'loading'
    || (!x.probe && x.detectedAt <= s.detectedAt)));
  if (busy && attempt < 20) {
    setTimeout(() => autoProbe(tabId, streamId, attempt + 1), 1500);
    return;
  }
  probeStream(tabId, streamId);
}

async function probeStream(tabId, streamId) {
  let target;
  await withTab(tabId, (t) => {
    target = t.streams.find((x) => x.id === streamId);
    if (target) target.probe = { status: 'loading' };
  });
  if (!target) return;
  let probe;
  try {
    probe = { status: 'ok', data: await analyse(target) };
  } catch (e) {
    probe = { status: 'error', error: e.message, needsHost: !!e.needsHost };
  }
  await withTab(tabId, (t) => {
    const s = t.streams.find((x) => x.id === streamId);
    if (s) s.probe = { ...probe, at: Date.now() };
  });
}

/** Adds the tab's page itself as a "stream" analysed by yt-dlp (sites without HLS/DASH playlists, e.g. YouTube). */
async function probePage(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (isBlockedUrl(tab.url)) throw new Error(tx('youtubeUnsupported'));
  let id;
  await withTab(tabId, (tt) => {
    const existing = tt.streams.find((x) => x.kind === 'page' && x.url === tab.url);
    if (existing) { id = existing.id; existing.probe = null; return; }
    id = crypto.randomUUID().slice(0, 8);
    tt.streams.push({ id, url: tab.url, kind: 'page', headers: {}, title: tab.title || '', pageUrl: tab.url, detectedAt: Date.now(), probe: null });
  });
  await probeStream(tabId, id);
  return id;
}

// HLS is analysed here (no native host needed); DASH and pages need the native host (yt-dlp).
async function analyse(stream) {
  if (stream.kind === 'file') return analyseFile(stream);
  if (stream.kind === 'hls' || /\.m3u8(?:[?#;]|$)/i.test(stream.url)) {
    const key = `probe:${stream.id}`;
    try {
      return await probeHls(stream.url, {
        get: fetchText, fetchOpts: { credentials: 'include' },
        onHosts: (urls) => ensureHeaderHosts(key, stream.headers, urls),
      });
    } finally {
      removeHeaderRule(key);
    }
  }
  let res;
  try {
    res = await hostRequest({ type: 'probe', url: stream.url, headers: stream.headers, kind: stream.kind }, 120_000);
  } catch (e) {
    if (HOST_MISSING_RE.test(e.message)) throw Object.assign(new Error(tx('errNeedsHost')), { needsHost: true });
    throw e;
  }
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

// ------------------------------------------------- headers for our fetches ---
// The page's player sends Referer/Origin/Cookie…; many CDNs refuse requests
// without them. fetch() can't set those, so a session rule adds them to the
// extension's own requests towards the stream's hosts, for as long as needed.
const SELF_HOST = new URL(chrome.runtime.getURL('/')).host;
const RULE_HEADER_RE = /^(referer|origin|cookie|authorization|x-[\w-]+)$/i;
const ruleHosts = new Map();    // key -> Set(hostname)
const ruleLocks = new Map();    // key -> Promise

function ruleIdFor(key) {
  let h = 7;
  for (const c of key) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return (Math.abs(h) % 2_000_000_000) + 1;
}

function headerList(headers) {
  return Object.entries(headers || {})
    .filter(([k, v]) => RULE_HEADER_RE.test(k) && v)
    .map(([header, value]) => ({ header, operation: 'set', value: String(value) }));
}

async function ensureHeaderHosts(key, headers, urls) {
  const requestHeaders = headerList(headers);
  if (!requestHeaders.length) return;
  const set = ruleHosts.get(key) || new Set();
  ruleHosts.set(key, set);
  let changed = false;
  for (const u of urls || []) {
    try { const h = new URL(u).hostname; if (!set.has(h)) { set.add(h); changed = true; } } catch {}
  }
  const prev = ruleLocks.get(key) || Promise.resolve();
  if (!changed) return prev;
  const next = prev.then(() => {
    const id = ruleIdFor(key);
    return chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [{
        id, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders },
        condition: {
          requestDomains: [...set], initiatorDomains: [SELF_HOST],
          resourceTypes: ['xmlhttprequest', 'media', 'other'],
        },
      }],
    });
  }).catch((e) => console.warn('[flux] header rule failed', e));
  ruleLocks.set(key, next);
  return next;
}

function removeHeaderRule(key) {
  const prev = ruleLocks.get(key) || Promise.resolve();
  ruleHosts.delete(key);
  ruleLocks.delete(key);
  return prev.then(() => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleIdFor(key)] }))
    .catch(() => {});
}

// ---------------------------------------------------------- native host ---
let port = null;
let seq = 0;
const pending = new Map();
let idleTimer = null;

function getPort() {
  if (port) return port;
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener((p) => {
    const err = p?.error?.message || chrome.runtime.lastError?.message || tx('hostDisconnected');
    port = null;
    for (const p of pending.values()) p.reject(new Error(err));
    pending.clear();
    const missing = HOST_MISSING_RE.test(err);
    setHostState(missing ? { status: 'missing', error: err } : { status: 'error', error: err });
    failRunningJobs(err);
  });
  return port;
}

function touchPort() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const jobs = await getJobs();
    if (pending.size || Object.values(jobs).some((j) => (j.engine || 'native') === 'native' && j.state === 'running')) return touchPort();
    port?.disconnect();
    port = null;
  }, PORT_IDLE_MS);
}

function hostRequest(msg, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(tx('hostTimeout')));
    }, timeout);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try { getPort().postMessage({ ...msg, id, lang: UI_LANG }); touchPort(); }
    catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
  });
}

function hostSend(msg) {
  getPort().postMessage({ ...msg, lang: UI_LANG });
  touchPort();
}

function onHostMessage(msg) {
  if (msg.type === 'job') return updateJob(msg.jobId, msg);
  const p = pending.get(msg.id);
  if (p) { pending.delete(msg.id); p.resolve(msg); }
}

async function setHostState(state) {
  await chrome.storage.session.set({ host: { ...state, at: Date.now() } });
}

async function checkHost() {
  try {
    const r = await hostRequest({ type: 'hello' }, 10_000);
    await setHostState({ status: 'ok', version: r.version, ffmpeg: r.ffmpeg, ytdlp: r.ytdlp, cryptodome: r.cryptodome, hints: r.hints });
  } catch (e) {
    const missing = HOST_MISSING_RE.test(e.message);
    await setHostState({ status: missing ? 'missing' : 'error', error: e.message });
  }
}

// ----------------------------------------------------------------- jobs ---
let jobsLock = Promise.resolve();

async function getJobs() {
  return (await chrome.storage.session.get('jobs')).jobs || {};
}

function mutateJobs(fn) {
  jobsLock = jobsLock.then(async () => {
    const jobs = await getJobs();
    fn(jobs);
    await chrome.storage.session.set({ jobs });
  }).catch((e) => console.error('[flux] jobs op failed', e));
  return jobsLock;
}

function updateJob(jobId, msg) {
  return mutateJobs((jobs) => {
    const j = jobs[jobId];
    if (!j) return;
    for (const k of ['state', 'progress', 'stage', 'speed', 'eta', 'output', 'error']) {
      if (msg[k] !== undefined) j[k] = msg[k];
    }
    if (msg.state && msg.state !== 'running' && msg.state !== 'saving') j.finishedAt = Date.now();
  });
}

function failRunningJobs(err, engine = 'native') {
  return mutateJobs((jobs) => {
    for (const j of Object.values(jobs)) {
      if ((j.engine || 'native') === engine && (j.state === 'running' || j.state === 'saving')) {
        Object.assign(j, { state: 'error', error: err, stage: tx('stageError'), finishedAt: Date.now() });
      }
    }
  });
}

/** What a job downloads, shown in the popup (short) and on the downloads page (full). */
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
function jobDetail(s, d, video, audio, subs) {
  return {
    kind: d.kind, title: s.title || '', pageUrl: s.pageUrl || '', host: hostOf(s.url),
    video: video ? {
      height: video.height || null, width: video.width || null, codec: video.codec || null, bandwidth: video.bandwidth || null,
      fps: video.fps || null, label: video.label || null, size: video.size || null, ext: video.ext || null,
    } : null,
    audio: (audio || []).map((a) => ({ lang: a.lang || null, name: a.name || null, codec: a.codec || null, channels: a.channels || null })),
    subs: (subs || []).map((x) => ({ lang: x.lang || null, name: x.name || null, forced: !!x.forced })),
  };
}
const storedSpec = ({ strings, ...spec }) => spec;   // the strings are rebuilt at each (re)start

const describeSel = (video, audio, subs) => [
  video ? `${video.height ? video.height + 'p' : 'video'}` : null,
  audio.length ? `${audio.length} audio` : null,
  subs.length ? `${subs.length} sub` : null,
].filter(Boolean).join(' · ');

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get('settings')).settings };
}

async function startDownload({ tabId, streamId, videoId, audioIds, subIds, container, filename }) {
  const t = await loadTab(tabId);
  const s = t.streams.find((x) => x.id === streamId);
  if (!s || s.probe?.status !== 'ok') throw new Error(tx('errNotAnalysed'));
  const d = s.probe.data;
  const settings = await getSettings();
  if (d.kind === 'file') return startFileDownload(s, d, videoId, filename);
  const pick = (list, ids) => list.filter((x) => ids.includes(x.id));
  const video = d.video.find((v) => v.id === videoId) || null;
  const audio = pick(d.audio, audioIds || []);
  const subs = pick(d.subs, subIds || []);
  if (!video && !audio.length) {
    if (subs.length) return startSubsDownload(s, d, subs, filename, settings);
    throw new Error(tx('errPickOne'));
  }

  // Only HLS has an in-browser engine: DASH and yt-dlp pages need the native host (their analysis already did).
  const engine = d.kind === 'hls' ? settings.engine : 'native';
  // Start the engine first: a fresh offscreen document fails jobs left by a previous one.
  if (engine === 'browser') await browserEngine.prepare();
  const jobId = crypto.randomUUID().slice(0, 12);
  const spec = {
    url: s.url, headers: s.headers, container: container || settings.container,
    outputDir: settings.outputDir, fragments: Number(settings.fragments) || 8, parallel: Number(settings.fragments) || 8,
    title: filename || s.title, filename: filename || s.title, duration: d.duration,
    video, audio, subs, streamKind: d.kind, pageUrl: s.pageUrl || '',
    strings: engine === 'browser' ? engineStrings() : undefined,
  };
  await mutateJobs((jobs) => {
    jobs[jobId] = {
      id: jobId, engine, filename: spec.filename, container: spec.container, describe: describeSel(video, audio, subs),
      detail: jobDetail(s, d, video, audio, subs), spec: storedSpec(spec),
      state: 'running', progress: 0, stage: tx('stageQueued'), startedAt: Date.now(),
      headers: engine === 'browser' ? s.headers : undefined,
    };
  });
  if (engine === 'browser') {
    await browserEngine.start(jobId, spec);
  } else {
    hostSend({ type: 'download', jobId, spec });
  }
  return jobId;
}

// ------------------------------------------------------- page scanning ---
// When the popup opens (and after "Detect" reloads an armed tab) scanner.js reads
// every frame of the tab: <video> files, video links, og:video / JSON-LD, player
// configurations with .m3u8/.mpd/.mp4 URLs, embedded players. Nothing has to play.
const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
const extOf = (u, type) => {
  const m = /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(new URL(u).pathname);
  if (m) return m[1].toLowerCase();
  return { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' }[(type || '').split(';')[0]] || 'mp4';
};

async function scanTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !/^https?:/.test(tab.url || '') || isBlockedUrl(tab.url)) return { frames: 0 };
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['scanner.js'] });
  } catch (e) {
    return { frames: 0, error: e.message };
  }
  const frames = results.map((r) => r.result).filter(Boolean);
  const pageTitle = tab.title || '';
  const added = [];
  await withTab(tabId, (t) => {
    const known = new Set();
    for (const s of t.streams) { known.add(s.url); for (const src of s.sources || []) known.add(src.url); }
    const push = (stream) => {
      if (known.has(stream.url) || isBlockedUrl(stream.url)) return;
      for (const src of stream.sources || []) known.add(src.url);
      known.add(stream.url);
      t.streams.push({ id: crypto.randomUUID().slice(0, 8), detectedAt: Date.now(), probe: null, pageUrl: tab.url, from: 'scan', ...stream });
      added.push(t.streams.at(-1));
    };
    const headersFor = (frameUrl, kind) => {
      const h = { Referer: frameUrl };
      if (kind !== 'file') h.Origin = originOf(frameUrl);   // players fetch playlists with CORS requests
      return h;
    };
    let blob = 0, drm = 0;
    for (const f of frames) {
      // inside an embedded player of another site: its internals are covered by the embed card (yt-dlp)
      if (!f.top && EMBED_PLAYER_RE.test(f.frameUrl)) continue;
      blob += f.blobVideos || 0; drm += f.drmVideos || 0;
      const title = (v) => v || f.ogTitle || (f.top ? pageTitle : f.title) || pageTitle;
      for (const v of f.videos) {
        const files = v.sources.filter((x) => x.kind === 'file');
        for (const m of v.sources.filter((x) => x.kind !== 'file')) push({ url: m.url, kind: m.kind, headers: headersFor(f.frameUrl, m.kind), title: title(v.title) });
        if (!files.length) continue;
        push({
          url: files[0].url, kind: 'file', headers: headersFor(f.frameUrl, 'file'), title: title(v.title),
          sources: files.map((x) => ({ url: x.url, type: x.type, label: x.label, height: x.height })),
          media: { tag: v.tag, visible: v.visible, area: v.area, duration: v.duration, width: v.width, height: v.height, muted: v.muted, loop: v.loop, autoplay: v.autoplay, controls: v.controls },
        });
      }
      for (const u of f.urls) {
        if (u.kind === 'file') push({ url: u.url, kind: 'file', headers: headersFor(f.frameUrl, 'file'), title: title(u.title), sources: [{ url: u.url }], media: { via: u.via, audio: !!u.audio } });
        else push({ url: u.url, kind: u.kind, headers: headersFor(f.frameUrl, u.kind), title: title(u.title) });
      }
      for (const e of f.embeds) {
        push({ url: e.url, kind: 'page', manual: true, embed: true, headers: {}, title: e.title || title('') });
      }
    }
    t.scan = { at: Date.now(), frames: frames.length, blobVideos: blob, drmVideos: drm };
  });
  for (const s of added) if (!s.manual) setTimeout(() => autoProbe(tabId, s.id), s.kind === 'file' ? 0 : PROBE_DELAY_MS);
  return { frames: frames.length, added: added.length };
}

/** Size, type and range support of each source of a direct file, without downloading it. */
async function analyseFile(stream) {
  const key = `probe:${stream.id}`;
  await ensureHeaderHosts(key, stream.headers, stream.sources.map((x) => x.url));
  try {
    const probed = await Promise.all(stream.sources.slice(0, 8).map(async (src, i) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      try {
        const r = await fetch(src.url, { credentials: 'include', headers: { Range: 'bytes=0-0' }, signal: ctrl.signal });
        if (!r.ok) return { ...src, error: `HTTP ${r.status}` };
        const total = r.status === 206 ? parseInt((r.headers.get('content-range') || '').split('/')[1], 10) : parseInt(r.headers.get('content-length') || '', 10);
        const type = r.headers.get('content-type') || src.type || '';
        ctrl.abort();   // don't download the body of a 200 answer
        if (/text\/html/i.test(type)) return { ...src, error: 'HTML' };
        return { ...src, id: `f${i}`, size: Number.isFinite(total) ? total : null, ranges: r.status === 206, type, ext: extOf(src.url, type) };
      } catch (e) {
        return { ...src, error: e.name === 'AbortError' ? 'timeout' : e.message };
      } finally {
        clearTimeout(timer);
      }
    }));
    const ok = probed.filter((x) => !x.error);
    if (!ok.length) throw new Error(probed[0]?.error || tx('unknownError'));
    const heightOf = (x) => x.height || parseInt(/(\d{3,4})p/.exec(x.label || x.url)?.[1] || '', 10) || null;
    const video = ok.map((x) => ({ ...x, height: heightOf(x) }))
      .sort((a, b) => ((b.height || 0) - (a.height || 0)) || ((b.size || 0) - (a.size || 0)));
    const audioOnly = video.every((x) => /^audio\//i.test(x.type) || /^(mp3|m4a|aac|ogg|oga|opus|flac|wav)$/.test(x.ext));
    return {
      kind: 'file', master: true, audioOnly, duration: stream.media?.duration || null, live: false, drm: null, encryption: null,
      video, audio: [], subs: [], childUrls: [],
    };
  } finally {
    removeHeaderRule(key);
  }
}

/** Only subtitles: .srt files (HLS in the browser; DASH / yt-dlp pages through the local app). */
async function startSubsDownload(s, d, subs, filename, settings) {
  const engine = d.kind === 'hls' ? 'browser' : 'native';
  if (engine === 'browser') await browserEngine.prepare();
  const jobId = crypto.randomUUID().slice(0, 12);
  const name = filename || s.title;
  const spec = {
    kind: 'subs', url: s.url, headers: s.headers, subs, video: null, audio: [], filename: name, title: name,
    outputDir: settings.outputDir, duration: d.duration, strings: engine === 'browser' ? engineStrings() : undefined,
    streamKind: d.kind, pageUrl: s.pageUrl || '',
  };
  await mutateJobs((jobs) => {
    jobs[jobId] = {
      detail: jobDetail(s, d, null, [], subs), spec: storedSpec(spec),
      id: jobId, engine, filename: name, container: 'srt', describe: subs.map((x) => x.lang || '?').join(' · '),
      state: 'running', progress: 0, stage: tx('stageQueued'), startedAt: Date.now(),
      headers: engine === 'browser' ? s.headers : undefined,
    };
  });
  if (engine === 'browser') await browserEngine.start(jobId, spec);
  else hostSend({ type: 'download', jobId, spec });
  return jobId;
}

/** Direct files: one GET (parallel ranges when the server allows them) straight to Downloads, no muxing. */
async function startFileDownload(s, d, sourceId, filename) {
  const src = d.video.find((x) => x.id === sourceId) || d.video[0];
  if (!src) throw new Error(tx('errPickOne'));
  const settings = await getSettings();
  await browserEngine.prepare();
  const jobId = crypto.randomUUID().slice(0, 12);
  const name = filename || s.title;
  const spec = {
    kind: 'file', url: src.url, size: src.size, ranges: src.ranges, ext: src.ext, headers: s.headers,
    filename: name, title: name, parallel: Number(settings.fragments) || 8, strings: engineStrings(),
  };
  await mutateJobs((jobs) => {
    jobs[jobId] = {
      detail: jobDetail(s, d, src, [], []), spec: storedSpec(spec),
      id: jobId, engine: 'browser', filename: name, container: src.ext,
      describe: [src.height ? `${src.height}p` : src.label || null, src.size ? fmtBytes(src.size) : null].filter(Boolean).join(' · '),
      state: 'running', progress: 0, stage: tx('stageQueued'), startedAt: Date.now(), headers: s.headers,
    };
  });
  await browserEngine.start(jobId, spec);
  return jobId;
}

const fmtBytes = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GB` : `${Math.max(0.1, b / 1048576).toFixed(1)} MB`);

// After "Detect" reloads an armed tab, its new page is scanned as soon as it has loaded.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete' && armed.has(tabId)) scanTab(tabId).catch(() => {});
});

// ---------------------------------------------------- browser engine ---
// Chromium: offscreen document (the worker may be stopped mid-download).
// Firefox: no offscreen API, the event page itself runs the engine.
const browserEngine = IS_FIREFOX ? localEngine() : offscreenEngine();

function localEngine() {
  let runner = null;
  const load = () => (runner ||= import('./engine/runner.js'));
  const bridge = {
    emit: (jobId, fields) => onEngineEvent(jobId, fields),
    ensureHosts: (jobId, urls) => ensureJobHosts(jobId, urls),
  };
  return {
    prepare: load,
    start: async (jobId, spec) => { const r = await load(); keepAlive(); r.startJob(jobId, spec, bridge); },
    cancel: async (jobId) => (await load()).cancelJob(jobId, bridge),
    pause: async (jobId) => (await load()).pauseJob(jobId),
    cleanup: async (jobId) => (await load()).cleanupJob(jobId),
  };
}

function offscreenEngine() {
  let creating = null;
  const ensure = async () => {
    if (await chrome.offscreen.hasDocument()) return;
    creating ||= chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['BLOBS', 'WORKERS'],
      justification: tx('offscreenJustification'),
    }).then(() => failRunningJobs(tx('errEngineRestarted'), 'browser'))
      .finally(() => { creating = null; });
    await creating;
  };
  const send = async (type, extra) => {
    await ensure();
    for (let i = 0; ; i++) {
      try { return await chrome.runtime.sendMessage({ target: 'offscreen', type, ...extra }); }
      catch (e) { if (i > 10) throw e; await new Promise((r) => setTimeout(r, 100)); }
    }
  };
  return {
    prepare: ensure,
    start: (jobId, spec) => send('start', { jobId, spec }),
    cancel: (jobId) => send('cancel', { jobId }),
    pause: (jobId) => send('pause', { jobId }),
    cleanup: async (jobId) => { if (await chrome.offscreen.hasDocument()) await send('cleanup', { jobId }); },
  };
}

// Firefox suspends an idle event page after ~30 s even with fetches in flight:
// calling an extension API resets its idle timer.
let keepAliveTimer = null;
function keepAlive() {
  if (!IS_FIREFOX || keepAliveTimer) return;
  keepAliveTimer = setInterval(async () => {
    const jobs = await getJobs();
    if (!Object.values(jobs).some((j) => j.engine === 'browser' && (j.state === 'running' || j.state === 'saving'))) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }, 10_000);
}

async function ensureJobHosts(jobId, urls) {
  const j = (await getJobs())[jobId];
  if (j) await ensureHeaderHosts(`job:${jobId}`, j.headers, urls);
}

async function onEngineEvent(jobId, fields) {
  const { files, ...rest } = fields;
  await updateJob(jobId, rest);
  if (rest.state && rest.state !== 'running') removeHeaderRule(`job:${jobId}`);
  if (rest.state === 'saving') saveFiles(jobId, files).catch(async (e) => {
    await updateJob(jobId, { state: 'error', stage: tx('stageError'), error: tx('errSaveFailed', e.message) });
    browserEngine.cleanup(jobId);
  });
}

const safeName = (n) => (n || 'video').replace(/[\x00-\x1f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, 180) || 'video';
const basename = (p) => p.split(/[\\/]/).pop();

async function downloadFilename(id) {
  for (let i = 0; i < 50; i++) {
    const [item] = await chrome.downloads.search({ id });
    if (item?.filename) return item.filename;
    await new Promise((r) => setTimeout(r, 100));
  }
  return '';
}

/** Hands the finished file(s) to the browser's download manager. */
async function saveFiles(jobId, files) {
  const j = (await getJobs())[jobId];
  if (!j || j.state !== 'saving') return;
  const main = files.find((f) => f.main);
  const ids = [];
  const mainId = await chrome.downloads.download({ url: main.url, filename: `${safeName(j.filename)}.${main.ext}`, conflictAction: 'uniquify', saveAs: false });
  ids.push(mainId);
  // sidecar subtitles follow the name the browser actually gave the video ("film (1).mp4" → "film (1).it.srt")
  const got = basename(await downloadFilename(mainId));
  const stem = (got.endsWith(`.${main.ext}`) ? got.slice(0, -main.ext.length - 1) : got.replace(/\.[^.]+$/, '')) || safeName(j.filename);
  for (const f of files.filter((x) => !x.main)) {
    ids.push(await chrome.downloads.download({ url: f.url, filename: `${stem}.${f.ext}`, conflictAction: 'uniquify', saveAs: false }));
  }
  await mutateJobs((jobs) => {
    if (jobs[jobId]) Object.assign(jobs[jobId], { downloadIds: ids, downloadsLeft: ids.length, mainDownloadId: mainId });
  });
  // A download may have finished before its id was recorded.
  for (const id of ids) {
    const [item] = await chrome.downloads.search({ id });
    if (item && item.state !== 'in_progress') onDownloadChanged({ id, state: { current: item.state }, error: item.error && { current: item.error } });
  }
}

const settledDownloads = new Set();
async function onDownloadChanged(delta) {
  const st = delta.state?.current;
  if (!st || st === 'in_progress' || settledDownloads.has(delta.id)) return;
  const j = Object.values(await getJobs()).find((x) => x.downloadIds?.includes(delta.id));
  if (!j) return;
  settledDownloads.add(delta.id);
  let finished = false;
  if (st === 'complete') {
    const output = delta.id === j.mainDownloadId ? await downloadFilename(delta.id) : undefined;
    await mutateJobs((jobs) => {
      const x = jobs[j.id];
      if (!x || x.state !== 'saving') return;
      if (output) x.output = output;
      x.downloadsLeft = (x.downloadsLeft || 1) - 1;
      if (x.downloadsLeft <= 0) Object.assign(x, { state: 'done', progress: 1, stage: tx('stageDone'), finishedAt: Date.now() });
      finished = x.state === 'done';
    });
  } else {
    const why = delta.error?.current || 'interrotto';
    await updateJob(j.id, { state: 'error', stage: tx('stageError'), error: tx('errSaveInterrupted', why) });
    finished = true;
  }
  if (finished) browserEngine.cleanup(j.id);
}
chrome.downloads.onChanged.addListener(onDownloadChanged);

// ----------------------------------------------------------- installer ---
// Builds a self-contained shell script (host + registration for this very
// extension ID) and saves it in Downloads: the user runs it once.
const b64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/.{76}/g, '$&\n');
};

async function downloadInstaller() {
  const { os } = await chrome.runtime.getPlatformInfo();
  if (os === 'win') throw new Error(tx('errWindowsInstaller'));
  const get = async (p) => {
    const r = await fetch(chrome.runtime.getURL(p));
    if (!r.ok) throw new Error(tx('errMissingFile', p));
    return r.text();
  };
  const [py, sh] = await Promise.all([get('native/fluxy_host.py'), get('native/install.sh')]);
  const ids = IS_FIREFOX ? `FLUX_GECKO_ID=${chrome.runtime.id}` : `FLUX_EXT_ID=${chrome.runtime.id}`;
  const script = [
    '#!/usr/bin/env bash',
    '# Fluxy — installs the local app (generated by the extension).',
    '# Run:  bash "<this file>"      Remove:  bash "<this file>" --uninstall',
    'set -euo pipefail',
    'case "$(uname -s)" in',
    '  Darwin) FLUX_DEST="$HOME/Library/Application Support/fluxy" ;;',
    '  *) FLUX_DEST="${XDG_DATA_HOME:-$HOME/.local/share}/fluxy" ;;',
    'esac',
    'if [[ "${1:-}" != "--uninstall" ]]; then',
    '  mkdir -p "$FLUX_DEST"',
    "  base64 --decode > \"$FLUX_DEST/fluxy_host.py\" <<'FLUX_HOST_PAYLOAD'",
    b64(py),
    'FLUX_HOST_PAYLOAD',
    'fi',
    `export FLUX_HOST_PATH="$FLUX_DEST/fluxy_host.py" ${ids}`,
    sh.replace(/^#!.*\n/, ''),
  ].join('\n');
  const name = 'fluxy-install.sh';
  const url = IS_FIREFOX
    ? URL.createObjectURL(new Blob([script], { type: 'application/x-sh' }))
    : `data:application/x-sh;base64,${b64(script).replace(/\n/g, '')}`;
  const id = await chrome.downloads.download({ url, filename: name, conflictAction: 'overwrite', saveAs: false });
  for (let i = 0; i < 100; i++) {
    const [item] = await chrome.downloads.search({ id });
    if (item?.state === 'complete') return { path: item.filename, os };
    if (item?.state === 'interrupted') throw new Error(tx('errInstallerFailed', item.error));
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(tx('errInstallerIncomplete'));
}

// ------------------------------------------------------ popup messages ---
async function cancelJob(jobId) {
  const j = (await getJobs())[jobId];
  if (!j) return;
  if (j.engine === 'browser') {
    if (j.state === 'saving') {
      for (const id of j.downloadIds || []) await chrome.downloads.cancel(id).catch(() => {});
      await updateJob(jobId, { state: 'cancelled', stage: tx('stageCancelled') });
      browserEngine.cleanup(jobId);
    } else await browserEngine.cancel(jobId);
  } else if (j.state === 'running' || j.state === 'paused') {
    hostSend({ type: 'cancel', jobId });
  } else {
    discardJobData(j);
    await updateJob(jobId, { state: 'cancelled', stage: tx('stageCancelled') });
  }
}

/** Drops what a paused / failed job keeps on disk for resume and retry. */
function discardJobData(j) {
  if (!['error', 'paused', 'cancelled'].includes(j.state)) return;
  if (j.engine === 'browser') browserEngine.cleanup(j.id).catch(() => {});
  else if (j.spec) { try { hostSend({ type: 'discard', jobId: j.id, outputDir: j.spec.outputDir }); } catch {} }
}

async function pauseJob(jobId) {
  const j = (await getJobs())[jobId];
  if (j?.state !== 'running' || j.kind === 'record') return;
  if (j.engine === 'browser') await browserEngine.pause(jobId);
  else hostSend({ type: 'pause', jobId });
}

async function resumeJob(jobId) {
  const j = (await getJobs())[jobId];
  if (j?.state !== 'paused') return;
  await updateJob(jobId, { state: 'running', stage: tx('stageQueued') });
  if (j.engine === 'browser') {
    await browserEngine.prepare();
    await browserEngine.start(jobId, { ...j.spec, strings: engineStrings() });
  } else hostSend({ type: 'resume', jobId });
}

/**
 * Retry a failed (or cancelled) job, continuing from the data already downloaded. Links of streams often
 * carry short-lived tokens: the track URLs are refreshed first, from a newer detection of the same page
 * (after "Detect") or by analysing the original playlist again.
 */
async function retryJob(jobId) {
  const j = (await getJobs())[jobId];
  if (!j?.spec || !['error', 'cancelled'].includes(j.state)) return;
  const spec = await refreshSpec(j).catch(() => j.spec);
  await mutateJobs((jobs) => {
    const x = jobs[jobId];
    if (x) Object.assign(x, { state: 'running', stage: tx('stageQueued'), error: undefined, finishedAt: undefined, retries: (x.retries || 0) + 1, spec, headers: x.engine === 'browser' ? spec.headers : undefined });
  });
  if (j.engine === 'browser') {
    await browserEngine.prepare();
    await browserEngine.start(jobId, { ...spec, strings: engineStrings() });
  } else hostSend({ type: 'download', jobId, spec });
}

async function refreshSpec(j) {
  const spec = j.spec;
  if (!['hls', 'dash', 'page'].includes(spec.streamKind)) return spec;
  let fresh = null;
  const all = await chrome.storage.session.get(null);
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith('tab:')) continue;
    for (const s of v.streams || []) {
      if (s.probe?.status === 'ok' && s.probe.data.master && s.kind === spec.streamKind && s.pageUrl && s.pageUrl === spec.pageUrl
        && s.detectedAt > j.startedAt && (!fresh || s.detectedAt > fresh.s.detectedAt)) fresh = { s, d: s.probe.data };
    }
  }
  if (!fresh) {
    const s = { id: `retry-${j.id}`, url: spec.url, kind: spec.streamKind, headers: spec.headers };
    fresh = { s, d: await analyse(s) };
  }
  const d = fresh.d;
  const same = (a, b, keys) => keys.every((k) => (a[k] ?? null) === (b[k] ?? null));
  const find = (list, old, tries) => {
    for (const keys of tries) { const hit = list.find((x) => same(x, old, keys)); if (hit) return hit; }
    return null;
  };
  let video = null;
  if (spec.video) {
    video = find(d.video, spec.video, [['formatId'], ['height', 'codec', 'bandwidth'], ['height', 'codec'], ['height']].filter((k) => k.every((x) => spec.video[x] != null)));
    if (!video) return spec;
  }
  const audio = [];
  for (const a of spec.audio || []) {
    const hit = find(d.audio, a, [['formatId'], ['lang', 'name', 'codec', 'channels'], ['lang', 'codec'], ['lang', 'name']].filter((k) => k.every((x) => a[x] != null)));
    if (!hit) return spec;
    audio.push(hit);
  }
  const subs = [];
  for (const x of spec.subs || []) {
    const hit = find(d.subs, x, [['ytLang'], ['lang', 'name', 'forced'], ['lang', 'forced']].filter((k) => k.every((y) => x[y] != null)));
    if (!hit) return spec;
    subs.push(hit);
  }
  return { ...spec, url: fresh.s.url, headers: fresh.s.headers || spec.headers, video, audio, subs };
}

/**
 * Rename while downloading: the name is only used when the file is saved (browser engine: at the end of the
 * job; local app: when the merge finishes), so updating it is enough. Too late once the file is being saved.
 */
async function renameJob(jobId, filename) {
  const name = safeName(filename);
  const j = (await getJobs())[jobId];
  if (!name || !j || !['running', 'paused', 'error', 'cancelled'].includes(j.state)) return;
  await mutateJobs((jobs) => {
    const x = jobs[jobId];
    if (!x) return;
    x.filename = name;
    if (x.spec) x.spec = { ...x.spec, filename: name, title: name };
  });
  if (j.engine !== 'browser' && ['running', 'paused'].includes(j.state)) {
    try { hostSend({ type: 'rename', jobId, filename: name }); } catch {}
  }
}

/** The downloads page: focus it if already open. */
async function openManager() {
  const url = chrome.runtime.getURL('downloads.html');
  const [tab] = await chrome.tabs.query({ url });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  } else await chrome.tabs.create({ url });
}

async function reveal(jobId) {
  const j = (await getJobs())[jobId];
  if (!j) return;
  if (j.engine === 'browser') { if (j.mainDownloadId != null) chrome.downloads.show(j.mainDownloadId); }
  else hostSend({ type: 'reveal', path: j.output });
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target === 'offscreen') return false;   // for the offscreen document
  (async () => {
    switch (msg.type) {
      case 'engineEvent': await onEngineEvent(msg.jobId, msg.fields); return {};
      case 'engineHosts': await ensureJobHosts(msg.jobId, msg.urls); return {};
      case 'hostCheck': await checkHost(); return {};
      case 'installer': return await downloadInstaller();
      case 'probe': await probeStream(msg.tabId, msg.streamId); return {};
      case 'probePage': return { streamId: await probePage(msg.tabId) };
      case 'scan': return await scanTab(msg.tabId);
      case 'download': return { jobId: await startDownload(msg) };
      case 'cancel': await cancelJob(msg.jobId); return {};
      case 'reveal': await reveal(msg.jobId); return {};
      case 'removeJob':
        await mutateJobs((jobs) => { if (jobs[msg.jobId]) discardJobData(jobs[msg.jobId]); delete jobs[msg.jobId]; });
        return {};
      case 'clearFinished':
        await mutateJobs((jobs) => {
          for (const [k, j] of Object.entries(jobs)) {
            if (['done', 'error', 'cancelled'].includes(j.state)) { discardJobData(j); delete jobs[k]; }
          }
        });
        return {};
      case 'pause': await pauseJob(msg.jobId); return {};
      case 'resume': await resumeJob(msg.jobId); return {};
      case 'retry': await retryJob(msg.jobId); return {};
      case 'renameJob': await renameJob(msg.jobId, msg.filename); return {};
      case 'openManager': await openManager(); return {};
      case 'clearTab': await clearTab(msg.tabId); return {};
      case 'arm': await armTab(msg.tabId); return {};
      case 'disarm': await setArmed(msg.tabId, false); return {};
      default: return { error: 'unknown' };
    }
  })().then((r) => reply(r), (e) => reply({ error: e.message }));
  return true;
});
