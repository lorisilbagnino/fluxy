// Flux Capacitor — background service worker
// Detects HLS/DASH manifests, talks to the native host, keeps per-tab state.

import { DEFAULT_SETTINGS, childSet, isChild } from './shared.js';

const HOST = 'com.fluxcapacitor.host';
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
  withTab(tabId, async (t) => {
    const existing = t.streams.find((s) => s.url === info.url);
    if (existing) {
      existing.headers = { ...existing.headers, ...info.headers };
      return;
    }
    let title = '';
    let pageUrl = '';
    try { const tab = await chrome.tabs.get(tabId); title = tab.title || ''; pageUrl = tab.url || ''; } catch {}
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
  if (!s || s.probe) return;
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
    const res = await hostRequest({ type: 'probe', url: target.url, headers: target.headers }, 120_000);
    probe = res.ok ? { status: 'ok', data: res.data } : { status: 'error', error: res.error };
  } catch (e) {
    probe = { status: 'error', error: e.message };
  }
  await withTab(tabId, (t) => {
    const s = t.streams.find((x) => x.id === streamId);
    if (s) s.probe = { ...probe, at: Date.now() };
  });
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
    const err = p?.error?.message || chrome.runtime.lastError?.message || 'Programma locale disconnesso';
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
    if (pending.size || Object.values(jobs).some((j) => j.state === 'running')) return touchPort();
    port?.disconnect();
    port = null;
  }, PORT_IDLE_MS);
}

function hostRequest(msg, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error('Timeout dal programma locale'));
    }, timeout);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try { getPort().postMessage({ ...msg, id }); touchPort(); }
    catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
  });
}

function hostSend(msg) {
  getPort().postMessage(msg);
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
    if (msg.state && msg.state !== 'running') j.finishedAt = Date.now();
  });
}

function failRunningJobs(err) {
  return mutateJobs((jobs) => {
    for (const j of Object.values(jobs)) {
      if (j.state === 'running') { j.state = 'error'; j.error = err; j.stage = 'Errore'; }
    }
  });
}

async function startDownload({ tabId, streamId, videoId, audioIds, subIds, container, filename }) {
  const t = await loadTab(tabId);
  const s = t.streams.find((x) => x.id === streamId);
  if (!s || s.probe?.status !== 'ok') throw new Error('Stream non analizzato');
  const d = s.probe.data;
  const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get('settings')).settings };
  const pick = (list, ids) => list.filter((x) => ids.includes(x.id));
  const video = d.video.find((v) => v.id === videoId) || null;
  const audio = pick(d.audio, audioIds || []);
  const subs = pick(d.subs, subIds || []);
  if (!video && !audio.length) throw new Error('Seleziona almeno un flusso video o audio');

  const jobId = crypto.randomUUID().slice(0, 12);
  const spec = {
    url: s.url, headers: s.headers, container: container || settings.container,
    outputDir: settings.outputDir, fragments: Number(settings.fragments) || 8,
    title: filename || s.title, filename: filename || s.title, duration: d.duration,
    video, audio, subs,
  };
  const describe = [
    video ? `${video.height ? video.height + 'p' : 'video'}` : null,
    audio.length ? `${audio.length} audio` : null,
    subs.length ? `${subs.length} sub` : null,
  ].filter(Boolean).join(' · ');
  await mutateJobs((jobs) => {
    jobs[jobId] = {
      id: jobId, filename: spec.filename, container: spec.container, describe,
      state: 'running', progress: 0, stage: 'In coda', startedAt: Date.now(),
    };
  });
  hostSend({ type: 'download', jobId, spec });
  return jobId;
}

// ------------------------------------------------------ popup messages ---
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    switch (msg.type) {
      case 'hostCheck': await checkHost(); return {};
      case 'probe': await probeStream(msg.tabId, msg.streamId); return {};
      case 'download': return { jobId: await startDownload(msg) };
      case 'cancel': hostSend({ type: 'cancel', jobId: msg.jobId }); return {};
      case 'reveal': hostSend({ type: 'reveal', path: msg.path }); return {};
      case 'removeJob':
        await mutateJobs((jobs) => { delete jobs[msg.jobId]; });
        return {};
      case 'clearFinished':
        await mutateJobs((jobs) => { for (const [k, j] of Object.entries(jobs)) if (j.state !== 'running') delete jobs[k]; });
        return {};
      case 'clearTab': await clearTab(msg.tabId); return {};
      case 'arm': await armTab(msg.tabId); return {};
      case 'disarm': await setArmed(msg.tabId, false); return {};
      default: return { error: 'unknown' };
    }
  })().then((r) => reply(r), (e) => reply({ error: e.message }));
  return true;
});
