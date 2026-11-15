import { DEFAULT_SETTINGS, childSet, isChild, isBlockedUrl, isPageSite } from './shared.js';
import { DONATE_URL } from './build-flags.js';

const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;
const UI_LANG = chrome.i18n.getUILanguage();

/** Fills data-i18n / data-i18n-title / data-i18n-aria attributes under root. */
function translate(root = document) {
  for (const n of root.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  for (const n of root.querySelectorAll('[data-i18n-title]')) n.title = t(n.dataset.i18nTitle);
  for (const n of root.querySelectorAll('[data-i18n-aria]')) n.setAttribute('aria-label', t(n.dataset.i18nAria));
}


const $ = (sel, root = document) => root.querySelector(sel);
const send = (msg) => chrome.runtime.sendMessage(msg);

let tabId = null;
let tabTitle = '';
let tabUrl = '';
let settings = { ...DEFAULT_SETTINGS };
const selection = {};          // streamId -> {videoId, audioIds:Set, subIds:Set, container, filename}
let lastStreamsSig = '';
let armedTabs = [];
let lastStreams = [];

// ------------------------------------------------------------ formatting ---
const langNames = (() => {
  try { return new Intl.DisplayNames([UI_LANG], { type: 'language' }); } catch { return null; }
})();

const langNamesEn = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }); } catch { return null; }
})();

/** true when a track NAME just repeats its language ("English", "Italiano", "ita"...). */
function nameIsJustLang(name, code) {
  if (!name) return true;
  const n = name.trim().toLowerCase();
  if (code && n === code.toLowerCase()) return true;
  const cands = [];
  try { cands.push(langNames?.of(code), langNamesEn?.of(code)); } catch {}
  try { cands.push(new Intl.DisplayNames([code], { type: 'language' }).of(code)); } catch {}
  return cands.filter(Boolean).some((c) => c.toLowerCase() === n);
}

function langLabel(code) {
  if (!code) return t('langUnknown');
  try {
    const n = langNames?.of(code);
    if (n && n.toLowerCase() !== code.toLowerCase()) return n.charAt(0).toUpperCase() + n.slice(1);
  } catch {}
  return code;
}

function prettyCodec(c) {
  if (!c) return '';
  const lc = c.toLowerCase();
  const table = [
    ['avc', 'H.264'], ['h264', 'H.264'], ['hvc1', 'HEVC'], ['hev1', 'HEVC'], ['hevc', 'HEVC'], ['dvh', 'Dolby Vision'],
    ['av01', 'AV1'], ['av1', 'AV1'], ['vp09', 'VP9'], ['vp9', 'VP9'],
    ['mp4a.40.5', 'HE-AAC'], ['mp4a.40.29', 'HE-AACv2'], ['mp4a', 'AAC'], ['aac', 'AAC'],
    ['ac-3', 'AC3'], ['ac3', 'AC3'], ['ec-3', 'E-AC3'], ['eac3', 'E-AC3'], ['opus', 'Opus'], ['flac', 'FLAC'], ['mp3', 'MP3'],
  ];
  for (const [p, n] of table) if (lc.startsWith(p)) return n;
  return c;
}

const listFmt = (items) => {
  try { return new Intl.ListFormat(UI_LANG, { type: 'conjunction' }).format(items); } catch { return items.join(', '); }
};

function channelsLabel(ch) {
  const n = parseInt(ch, 10);
  return { 1: 'mono', 2: '2.0', 6: '5.1', 8: '7.1' }[n] || (n ? `${n} ch` : '');
}

function fmtBitrate(bps) {
  if (!bps) return '';
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1e3)} kbps`;
}

function fmtDuration(sec) {
  if (!sec) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s).padStart(2, '0')}s`;
}

function fmtSpeed(bps) {
  if (!bps) return '';
  return bps > 1048576 ? `${(bps / 1048576).toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`;
}

function fmtEta(s) {
  if (s == null || !isFinite(s)) return '';
  s = Math.round(s);
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
  return e;
}

// ------------------------------------------------------------- defaults ---
function preferredLangs() {
  return (settings.langs || '').split(/[\s,;]+/).map((l) => l.trim().toLowerCase()).filter(Boolean);
}

function langMatches(code, pref) {
  if (!code) return false;
  const c = code.toLowerCase().split(/[-_]/)[0];
  const p = pref.split(/[-_]/)[0];
  if (c === p) return true;
  // tolerate 2 vs 3 letter codes (it/ita, en/eng, ...)
  return c.length !== p.length && (c.startsWith(p) || p.startsWith(c));
}

function cleanTitle(t) {
  return (t || '').replace(/\s+[-|–·]\s+[^-|–·]{2,40}$/, '').trim() || 'video';
}

function initSelection(stream) {
  if (selection[stream.id]) return selection[stream.id];
  const d = stream.probe.data;
  const prefs = preferredLangs();
  const audioIds = new Set();
  for (const p of prefs) {
    const matches = d.audio.filter((a) => langMatches(a.lang, p));
    // one track per language: prefer the default one, then the one with most channels
    matches.sort((a, b) => (b.default - a.default) || (parseInt(b.channels || 0) - parseInt(a.channels || 0)));
    if (matches[0]) audioIds.add(matches[0].id);
  }
  if (!audioIds.size && d.audio.length) {
    audioIds.add((d.audio.find((a) => a.default) || d.audio[0]).id);
  }
  const subIds = new Set(d.subs.filter((s) => prefs.some((p) => langMatches(s.lang, p))).map((s) => s.id));
  selection[stream.id] = {
    videoId: d.video[0]?.id || null,
    audioIds, subIds,
    container: settings.container || 'mkv',
    filename: cleanTitle(tabTitle || stream.title),
  };
  return selection[stream.id];
}

// ---------------------------------------------------------------- render ---
let hostState = null;

function renderHost(host = hostState) {
  hostState = host;
  const native = settings.engine === 'native';
  const pill = $('#host-status');
  const warn = $('#host-warning');
  const txt = $('#native-text');
  warn.hidden = true;
  warn.classList.remove('soft');

  // settings panel: status of the local app, whichever engine is selected
  txt.className = '';
  if (!host) txt.textContent = t('appNotChecked');
  else if (host.status === 'ok') {
    const missing = [!host.ffmpeg && 'ffmpeg', !host.ytdlp && 'yt-dlp'].filter(Boolean);
    txt.textContent = missing.length ? t('appMissingTools', listFmt(missing)) : t('appReady', host.version);
    txt.className = missing.length ? 'bad' : 'ok';
  } else {
    txt.textContent = host.status === 'missing' ? t('appNotInstalled') : t('appCommError');
    txt.className = 'bad';
  }
  txt.title = host?.status === 'ok' ? `${host.ffmpeg || `ffmpeg ${t('missing')}`}\nyt-dlp ${host.ytdlp || t('missing')}` : (host?.error || '');
  $('#btn-install').hidden = host?.status === 'ok' && host.ffmpeg && host.ytdlp;

  if (!native) {
    pill.textContent = t('pillBrowser');
    pill.className = 'pill ok';
    pill.title = t('pillBrowserTitle');
    return;
  }
  if (!host) { pill.textContent = `${t('pillNative')} …`; pill.className = 'pill'; return; }
  if (host.status === 'ok') {
    pill.textContent = t('pillNative');
    pill.className = 'pill ok';
    pill.title = `Host ${host.version}\n${host.ffmpeg || `ffmpeg ${t('missing')}`}\nyt-dlp ${host.ytdlp || t('missing')}`;
    if (!host.ffmpeg || !host.ytdlp) {
      warn.hidden = false;
      warn.replaceChildren(t('toolsMissing', listFmt([!host.ffmpeg && 'ffmpeg', !host.ytdlp && 'yt-dlp'].filter(Boolean))), el('code', {}, host.hints?.tools || 'ffmpeg, yt-dlp'));
    } else if (host.cryptodome === false) {
      warn.hidden = false;
      warn.classList.add('soft');
      warn.replaceChildren(t('cryptoMissing'), el('code', {}, host.hints?.cryptodome || 'pycryptodomex'));
    }
    return;
  }
  pill.textContent = host.status === 'missing' ? t('pillNativeMissing') : t('pillNativeError');
  pill.className = 'pill bad';
  warn.hidden = false;
  warn.replaceChildren(
    ...(host.status === 'missing'
      ? [t('nativeChosenMissing')]
      : [t('nativeCommError'), el('span', { class: 'err' }, host.error || '')]),
    el('div', { class: 'actions-inline' },
      el('button', { class: 'ghost', onclick: () => openSettings(true) }, t('installLocalApp')),
      el('button', { class: 'link', onclick: () => useEngine('browser') }, t('useBrowserEngine'))),
  );
}

function openSettings(install = false) {
  $('#settings').hidden = false;
  send({ type: 'hostCheck' });
  if (install) $('#btn-install').focus();
}

function useEngine(engine) {
  settings.engine = engine;
  for (const r of document.querySelectorAll('input[name=engine]')) r.checked = r.value === engine;
  saveSettings();
}

async function installLocalApp() {
  const help = $('#install-help');
  const btn = $('#btn-install');
  btn.disabled = true;
  help.hidden = false;
  help.replaceChildren(t('preparingInstaller'));
  const r = await send({ type: 'installer' });
  btn.disabled = false;
  if (r?.error) { help.replaceChildren(el('span', { class: 'err' }, r.error)); return; }
  const cmd = `bash '${r.path.replace(/'/g, `'\\''`)}'`;
  const copy = el('button', { class: 'link', onclick: async () => { await navigator.clipboard.writeText(cmd); copy.textContent = t('copied'); } }, t('copyCommand'));
  help.replaceChildren(
    el('span', {}, t('installerSaved')),
    el('code', {}, cmd),
    el('span', { class: 'muted' }, t('installerExplain')),
    el('div', { class: 'row-actions' }, copy, el('button', { class: 'link', onclick: () => send({ type: 'hostCheck' }) }, t('doneVerify'))),
  );
}

function renderDetect() {
  const isArmed = armedTabs.includes(tabId);
  const box = $('#detect');
  box.hidden = isBlockedUrl(tabUrl) || (settings.autoDetect && !isArmed);
  box.classList.toggle('on', isArmed);
  $('#detect-text').textContent = isArmed
    ? t('detectActive')
    : t('detectManual');
  $('#btn-stop').hidden = !isArmed;
  $('#btn-detect').textContent = isArmed ? t('reload') : t('detect');
}

/** Sites without detectable playlists (YouTube): offer to analyse the page with yt-dlp (GitHub build only). */
function renderPageCard() {
  const show = isPageSite(tabUrl) && !isBlockedUrl(tabUrl) && !lastStreams.some((x) => x.kind === 'page' && x.url === tabUrl);
  $('#page-card').hidden = !show;
}

function renderStreams(streams, force = false) {
  lastStreams = streams;
  const sig = JSON.stringify(streams);
  if (force) lastStreamsSig = '';
  if (sig === lastStreamsSig) return;
  lastStreamsSig = sig;

  const kids = childSet(streams);
  const visible = streams.filter((s) => !isChild(s, kids));
  // master playlists first, then newest
  visible.sort((a, b) => ((b.probe?.data?.master ? 1 : 0) - (a.probe?.data?.master ? 1 : 0)) || (b.detectedAt - a.detectedAt));

  $('#empty').hidden = visible.length > 0;
  $('#empty').textContent = isBlockedUrl(tabUrl)
    ? t('youtubeUnsupported')
    : settings.autoDetect || armedTabs.includes(tabId)
    ? t('noStreamsYet')
    : t('autoOff');
  $('#btn-clear-tab').hidden = visible.length === 0;
  renderPageCard();
  const box = $('#streams');
  // keep focus on filename input across re-renders
  const focused = document.activeElement?.dataset?.focusKey;
  box.replaceChildren(...visible.map(renderStream));
  if (focused) box.querySelector(`[data-focus-key="${focused}"]`)?.focus();
}

function renderStream(s) {
  const card = $('#tpl-stream').content.firstElementChild.cloneNode(true);
  translate(card);
  $('.kind', card).textContent = s.kind === 'page' ? (s.probe?.data?.extractor || 'yt-dlp').toUpperCase() : s.kind.toUpperCase();
  let host = '';
  try { host = new URL(s.url).hostname; } catch {}
  const d = s.probe?.data;
  $('.meta', card).textContent = [d?.duration ? fmtDuration(d.duration) : null, host].filter(Boolean).join(' · ');
  $('.meta', card).title = s.url;
  $('.copy-url', card).addEventListener('click', async (e) => {
    await navigator.clipboard.writeText(s.url);
    e.target.textContent = t('copied');
  });
  const body = $('.body', card);

  if (!s.probe || s.probe.status === 'loading') {
    body.append(el('div', { class: 'loading' }, el('span', { class: 'spinner' }), t('analysing')));
    if (!s.probe) send({ type: 'probe', tabId, streamId: s.id });
    return card;
  }
  if (s.probe.status === 'error') {
    body.append(
      el('div', { class: 'err' }, s.probe.error || t('unknownError')),
      el('div', { class: 'actions' },
        el('button', { class: 'ghost', onclick: () => send({ type: 'probe', tabId, streamId: s.id }) }, t('retry')),
        s.probe.needsHost ? el('button', { class: 'link', onclick: () => openSettings(true) }, t('installLocalAppLink')) : null),
    );
    return card;
  }
  if (d.drm) {
    body.append(el('div', { class: 'drm' }, t('drmProtected', d.drm)));
    return card;
  }

  const sel = initSelection(s);
  const update = () => { download.disabled = !sel.videoId && sel.audioIds.size === 0; };

  if (d.live) body.append(el('div', { class: 'err' }, t('liveStream')));
  if (d.encryption) body.append(el('div', { class: 'muted' }, t('encryptionOk', d.encryption)));

  // Video
  if (d.video.length) {
    const opts = d.video.map((v) => el('label', { class: 'opt' },
      el('input', {
        type: 'radio', name: `v-${s.id}`, checked: sel.videoId === v.id,
        onchange: () => { sel.videoId = v.id; update(); },
      }),
      el('span', { class: 'main' },
        v.height ? `${v.height}p` : t('video'),
        v.hasAudio ? el('span', { class: 'badge' }, t('audioIncluded')) : null,
        v.range && v.range !== 'SDR' ? el('span', { class: 'badge' }, v.range) : null),
      el('span', { class: 'tag' }, [
        v.width && v.height ? `${v.width}×${v.height}` : null,
        v.fps && v.fps > 31 ? `${Math.round(v.fps)} fps` : null,
        prettyCodec(v.codec), fmtBitrate(v.bandwidth),
      ].filter(Boolean).join(' · ')),
    ));
    if (d.audio.length || !d.video.every((v) => v.hasAudio)) {
      opts.push(el('label', { class: 'opt' },
        el('input', { type: 'radio', name: `v-${s.id}`, checked: sel.videoId === null, onchange: () => { sel.videoId = null; update(); } }),
        el('span', { class: 'main muted' }, t('noVideo'))));
    }
    body.append(el('div', {}, el('div', { class: 'group-title' }, t('video')), el('div', { class: 'opts' }, opts)));
  }

  // Audio
  if (d.audio.length) {
    body.append(el('div', {},
      el('div', { class: 'group-title' }, t('audio')),
      el('div', { class: 'opts' }, d.audio.map((a) => el('label', { class: 'opt' },
        el('input', {
          type: 'checkbox', checked: sel.audioIds.has(a.id),
          onchange: (e) => { e.target.checked ? sel.audioIds.add(a.id) : sel.audioIds.delete(a.id); update(); },
        }),
        el('span', { class: 'main' }, langLabel(a.lang),
          !nameIsJustLang(a.name, a.lang) ? el('span', { class: 'muted' }, ` — ${a.name}`) : null),
        el('span', { class: 'tag' }, [prettyCodec(a.codec), channelsLabel(a.channels), fmtBitrate(a.bandwidth)].filter(Boolean).join(' · ')),
      ))),
    ));
  }

  // Subtitles
  if (d.subs.length) {
    body.append(el('div', {},
      el('div', { class: 'group-title' }, t('subtitles')),
      el('div', { class: 'opts' }, d.subs.map((tr) => el('label', { class: 'opt' },
        el('input', {
          type: 'checkbox', checked: sel.subIds.has(tr.id),
          onchange: (e) => { e.target.checked ? sel.subIds.add(tr.id) : sel.subIds.delete(tr.id); },
        }),
        el('span', { class: 'main' }, langLabel(tr.lang),
          !nameIsJustLang(tr.name, tr.lang) ? el('span', { class: 'muted' }, ` — ${tr.name}`) : null,
          tr.forced ? el('span', { class: 'badge' }, t('forced')) : null),
      ))),
    ));
  }

  // Actions
  const segBtns = ['mkv', 'mp4'].map((c) => el('button', {
    class: sel.container === c ? 'on' : '',
    onclick: (e) => {
      sel.container = c;
      for (const b of e.target.parentElement.children) b.classList.toggle('on', b === e.target);
    },
  }, c.toUpperCase()));
  const download = el('button', {
    class: 'primary',
    onclick: async () => {
      download.disabled = true;
      const r = await send({
        type: 'download', tabId, streamId: s.id, videoId: sel.videoId,
        audioIds: [...sel.audioIds], subIds: [...sel.subIds],
        container: sel.container, filename: sel.filename.trim() || 'video',
      });
      dlError.textContent = r?.error || '';
      dlError.hidden = !r?.error;
      download.disabled = false;
    },
  }, t('download'));
  // (no alert(): popups can't show it in Firefox)
  const dlError = el('div', { class: 'err', hidden: true });
  body.append(dlError,
    el('div', { class: 'actions' },
      el('input', {
        type: 'text', value: sel.filename, title: t('fileName'), 'data-focus-key': `fn-${s.id}`,
        oninput: (e) => { sel.filename = e.target.value; },
      }),
      el('div', { class: 'seg' }, segBtns),
      download,
    ),
  );
  update();
  return card;
}

function renderJobs(jobs) {
  const list = Object.values(jobs || {}).sort((a, b) => b.startedAt - a.startedAt);
  $('#jobs-head').hidden = list.length === 0;
  $('#btn-clear-jobs').hidden = !list.some((j) => j.state !== 'running' && j.state !== 'saving');
  $('#jobs').replaceChildren(...list.map((j) => {
    const pct = Math.round((j.progress || 0) * 100);
    const active = j.state === 'running' || j.state === 'saving';
    const right = active
      ? [fmtSpeed(j.speed), j.eta != null ? `ETA ${fmtEta(j.eta)}` : null, `${pct}%`].filter(Boolean).join(' · ')
      : '';
    const buttons = [];
    if (active) buttons.push(el('button', { class: 'link', onclick: () => send({ type: 'cancel', jobId: j.id }) }, t('cancel')));
    if (j.state === 'done') buttons.push(el('button', { class: 'link', onclick: () => send({ type: 'reveal', jobId: j.id }) }, j.engine === 'browser' ? t('showFile') : t('openFolder')));
    if (!active) buttons.push(el('button', { class: 'link', onclick: () => send({ type: 'removeJob', jobId: j.id }) }, t('remove')));
    return el('div', { class: `job ${j.state}` },
      el('div', { class: 'job-top' },
        el('span', { class: 'job-name', title: j.output || '' }, `${j.filename}.${j.container}`),
        ...buttons),
      el('div', { class: 'bar' }, el('i', { style: `width:${j.state === 'done' ? 100 : pct}%` })),
      el('div', { class: 'job-info' },
        el('span', {}, j.state === 'error' ? el('span', { class: 'err' }, j.error || t('error')) : `${j.stage || ''}${j.describe ? ' — ' + j.describe : ''}`),
        el('span', {}, right)),
    );
  }));
}

// -------------------------------------------------------------- settings ---
function saveSettings() {
  settings = {
    engine: document.querySelector('input[name=engine]:checked')?.value || 'browser',
    outputDir: $('#set-dir').value.trim() || DEFAULT_SETTINGS.outputDir,
    container: $('#set-container').value,
    fragments: Math.min(32, Math.max(1, parseInt($('#set-fragments').value, 10) || 8)),
    langs: $('#set-langs').value,
    autoDetect: $('#set-auto').checked,
  };
  chrome.storage.local.set({ settings });
  $('#dir-field').hidden = settings.engine !== 'native';
  if (settings.engine === 'native') send({ type: 'hostCheck' });
  renderHost();
  renderDetect();
  renderStreams(lastStreams, true);
}

function bindSettings() {
  for (const r of document.querySelectorAll('input[name=engine]')) {
    r.checked = r.value === settings.engine;
    r.addEventListener('change', saveSettings);
  }
  $('#dir-field').hidden = settings.engine !== 'native';
  $('#set-dir').value = settings.outputDir;
  $('#set-container').value = settings.container;
  $('#set-fragments').value = settings.fragments;
  $('#set-langs').value = settings.langs;
  $('#set-auto').checked = !!settings.autoDetect;
  for (const id of ['#set-dir', '#set-container', '#set-fragments', '#set-langs', '#set-auto']) $(id).addEventListener('change', saveSettings);
  $('#btn-settings').addEventListener('click', () => {
    if ($('#settings').hidden) openSettings(); else $('#settings').hidden = true;
  });
  $('#btn-install').addEventListener('click', installLocalApp);
  $('#btn-verify').addEventListener('click', () => send({ type: 'hostCheck' }));
}

// ------------------------------------------------------------------ init ---
async function init() {
  // ?tab=<id> lets the popup be opened as a normal page for debugging
  const forced = parseInt(new URLSearchParams(location.search).get('tab'), 10);
  const [tab] = Number.isInteger(forced)
    ? [await chrome.tabs.get(forced)]
    : await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? -1;
  tabTitle = tab?.title || '';
  tabUrl = tab?.url || '';
  settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get('settings')).settings };
  document.documentElement.lang = UI_LANG;
  translate();
  if (DONATE_URL) { $('#donate').href = DONATE_URL; $('#donate').hidden = false; }
  bindSettings();

  const key = `tab:${tabId}`;
  const data = await chrome.storage.session.get([key, 'jobs', 'host', 'armed']);
  armedTabs = data.armed || [];
  renderDetect();
  renderHost(data.host);
  renderStreams(data[key]?.streams || []);
  renderJobs(data.jobs);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    if (changes[key]) renderStreams(changes[key].newValue?.streams || []);
    if (changes.jobs) renderJobs(changes.jobs.newValue);
    if (changes.host) renderHost(changes.host.newValue);
    if (changes.armed) {
      armedTabs = changes.armed.newValue || [];
      renderDetect();
      renderStreams(lastStreams, true);
    }
  });

  $('#btn-clear-tab').addEventListener('click', () => send({ type: 'clearTab', tabId }));
  $('#btn-detect').addEventListener('click', () => send({ type: 'arm', tabId }));
  $('#btn-page').addEventListener('click', async (e) => {
    e.target.disabled = true;
    const r = await send({ type: 'probePage', tabId });
    e.target.disabled = false;
    if (r?.error) $('#empty').textContent = r.error;
  });
  $('#btn-stop').addEventListener('click', () => send({ type: 'disarm', tabId }));
  $('#btn-clear-jobs').addEventListener('click', () => send({ type: 'clearFinished' }));
  // The local app is only started when it is the chosen engine (or the settings are opened).
  if (settings.engine === 'native') send({ type: 'hostCheck' });
}

init();
