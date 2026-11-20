// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 lorisilbagnino — Fluxy, https://github.com/lorisilbagnino/fluxy (see ADDITIONAL-TERMS.md)
import { DEFAULT_SETTINGS, childSet, isChild, isBlockedUrl, isPageSite } from './shared.js';
import { DONATE_URL } from './build-flags.js';
import { mountSettings } from './settings.js';
import {
  t, UI_LANG, translate, $, send, el, langLabel, nameIsJustLang, prettyCodec, listFmt, channelsLabel,
  fmtBitrate, fmtDuration, fmtSize, renderJob, sortJobs, setRerender, restoreEditFocus, renderOverall, speedLimitControl,
} from './ui.js';
import { castShown, mountCastManager, devicePicker, routePicker } from './cast-ui.js';

let tabId = null;
let tabTitle = '';
let tabUrl = '';
let settings = { ...DEFAULT_SETTINGS };
const selection = {};          // streamId -> {videoId, audioIds:Set, subIds:Set, container, filename}
let lastStreamsSig = '';
let armedTabs = [];
let lastStreams = [];
let lastScan = null;       // {blobVideos, drmVideos} from the page scan
let castState = null;      // storage.session "cast": the session shown by the stream manager
let castDevices = null;    // storage.session "castDevices": {devices, searching, error}
let castPrefs = null;      // storage.local "castPrefs": {deviceId, route}

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
    mode: 'download',                                  // or 'cast': same choices, sent to a TV
    castAudioId: [...audioIds][0] || null,             // a TV plays one audio track and one subtitle track
    castSubId: null,
    filename: cleanTitle((stream.from === 'scan' && stream.title) || tabTitle || stream.title),
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
  warn.hidden = true;
  warn.classList.remove('soft');

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

let settingsForm = null;   // settings.js

function openSettings(install = false) {
  $('#settings').hidden = false;
  send({ type: 'hostCheck' });
  if (install) settingsForm?.focusInstall();
}

function useEngine(engine) { settingsForm?.set({ engine }); }

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
  // streams (analysed masters first), then page videos (visible, big, long first), then embedded players
  const rank = (s) => (s.kind === 'hls' || s.kind === 'dash' ? (s.probe?.data?.master ? 5 : 4) : s.kind === 'file' ? 3 : s.kind === 'page' && !s.embed ? 4 : 1);
  const weight = (s) => (s.media?.visible ? 1e12 : 0) + (s.media?.area || 0) * 1e3 + (s.media?.duration || s.probe?.data?.duration || 0);
  visible.sort((a, b) => (rank(b) - rank(a)) || (weight(b) - weight(a)) || (b.detectedAt - a.detectedAt));
  const main = visible.filter((s) => !isDecorative(s));
  const noise = visible.filter(isDecorative);

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
  const wasOpen = box.querySelector('details.noise')?.open;
  box.replaceChildren(...main.map(renderStream),
    ...(noise.length ? [el('details', { class: 'noise', open: !!wasOpen || !main.length },
      el('summary', {}, t('otherVideos', noise.length)), ...noise.map(renderStream))] : []));
  if (focused) box.querySelector(`[data-focus-key="${focused}"]`)?.focus();
  renderHint(visible);
}

/** Background loops, muted autoplay previews, tiny or very short clips: listed, but folded away. */
function isDecorative(s) {
  const m = s.media;
  if (s.kind !== 'file' || !m || m.via) return false;
  if (m.muted && (m.loop || m.autoplay) && !m.controls) return true;
  if (m.duration != null && m.duration > 0 && m.duration < 12) return true;
  if (m.tag === 'video' && (!m.visible || (m.area && m.area < 200 * 112))) return true;
  return false;
}

function renderHint(visible) {
  const hasStream = visible.some((s) => s.kind === 'hls' || s.kind === 'dash');
  const parts = [];
  if (lastScan?.blobVideos && !hasStream) parts.push(t('hintAdaptive', lastScan.blobVideos));
  if (lastScan?.drmVideos) parts.push(t('hintDrm', lastScan.drmVideos));
  $('#scan-hint').hidden = !parts.length;
  $('#scan-hint').textContent = parts.join(' ');
}

const EMBED_NAMES = { 'youtube.com': 'YouTube', 'youtube-nocookie.com': 'YouTube', 'vimeo.com': 'Vimeo', 'dailymotion.com': 'Dailymotion',
  'twitch.tv': 'Twitch', 'streamable.com': 'Streamable', 'rumble.com': 'Rumble', 'facebook.com': 'Facebook', 'bilibili.com': 'Bilibili',
  'wistia.net': 'Wistia', 'wistia.com': 'Wistia', 'loom.com': 'Loom', 'soundcloud.com': 'SoundCloud' };
const embedName = (u) => {
  try { const h = new URL(u).hostname; return Object.entries(EMBED_NAMES).find(([d]) => h === d || h.endsWith(`.${d}`))?.[1] || h; } catch { return 'embed'; }
};

/** Card body of a direct file: choice of the available qualities, saved as is. */
function renderFileBody(s, d, body) {
  const sel = initSelection(s);
  if (s.title) body.append(el('div', { class: 'file-title', title: s.title }, s.title));
  body.append(modeSwitch(sel));
  body.append(el('div', {}, el('div', { class: 'group-title' }, d.audioOnly ? t('audio') : t('video')),
    el('div', { class: 'opts' }, d.video.map((v) => el('label', { class: 'opt' },
      el('input', { type: 'radio', name: `v-${s.id}`, checked: sel.videoId === v.id, onchange: () => { sel.videoId = v.id; } }),
      el('span', { class: 'main' }, v.height ? `${v.height}p` : (v.label || v.ext.toUpperCase())),
      el('span', { class: 'tag' }, [v.label && v.height ? v.label : null, v.ext.toUpperCase(), v.size ? fmtSize(v.size) : null].filter(Boolean).join(' · ')),
    )))));
  const dlError = el('div', { class: 'err', hidden: true });
  const download = el('button', {
    class: 'primary',
    onclick: async () => {
      download.disabled = true;
      const r = await send({ type: 'download', tabId, streamId: s.id, videoId: sel.videoId, audioIds: [], subIds: [], filename: sel.filename.trim() || 'video' });
      dlError.textContent = r?.error || '';
      dlError.hidden = !r?.error;
      download.disabled = false;
    },
  }, t('download'));
  const ext = () => (d.video.find((v) => v.id === sel.videoId) || d.video[0])?.ext || '';
  if (sel.mode === 'cast') { body.append(...castActions(s, sel).filter(Boolean)); return; }
  body.append(dlError, el('div', { class: 'actions' },
    el('input', { type: 'text', value: sel.filename, title: t('fileName'), 'data-focus-key': `fn-${s.id}`, oninput: (e) => { sel.filename = e.target.value; } }),
    el('span', { class: 'file-ext', title: t('fileOriginal') }, `.${ext()}`),
    download));
}

// ------------------------------------------------------------------ cast ---
/** "Download | Cast" switch at the top of a stream card. */
function modeSwitch(sel) {
  const set = (mode) => {
    sel.mode = mode;
    if (mode === 'cast') {
      send({ type: 'hostCheck' });
      if (!castDevices?.devices?.length && !castDevices?.searching) send({ type: 'castDiscover' });
    }
    renderStreams(lastStreams, true);
  };
  return el('div', { class: 'seg mode-switch' },
    el('button', { class: sel.mode !== 'cast' ? 'on' : '', onclick: () => set('download') }, `⬇ ${t('download')}`),
    el('button', { class: sel.mode === 'cast' ? 'on' : '', onclick: () => set('cast') }, `📺 ${t('castTo')}`));
}

const saveCastPrefs = (patch) => chrome.storage.local.set({ castPrefs: { route: 'relay', ...castPrefs, ...patch } });

/** Cast mode: TV, route and the "Cast" button (instead of file name, format and "Download"). */
function castActions(s, sel) {
  if (hostState?.status !== 'ok') {
    return [el('div', { class: 'notice soft cast-need' },
      hostState?.status ? t('castNeedsApp') : t('castCheckingApp'), ' ',
      hostState?.status ? el('button', { class: 'link', onclick: () => openSettings(true) }, t('installLocalAppLink')) : null)];
  }
  const err = el('div', { class: 'err', hidden: true });
  const go = el('button', {
    class: 'primary', disabled: !castDevices?.devices?.some((d) => d.id === castPrefs?.deviceId),
    onclick: async () => {
      go.disabled = true;
      const r = await send({ type: 'castStart', tabId, streamId: s.id, videoId: sel.videoId, audioId: sel.castAudioId, subId: sel.castSubId, title: sel.filename });
      err.textContent = r?.error || ''; err.hidden = !r?.error;
      go.disabled = false;
    },
  }, t('castStartBtn'));
  return [err,
    el('div', { class: 'actions cast-actions' }, devicePicker(castDevices, castPrefs, { onChange: saveCastPrefs }), go),
    el('div', { class: 'cast-route-row' }, routePicker(castPrefs, { onChange: saveCastPrefs }),
      el('small', { class: 'muted' }, (castPrefs?.route || 'relay') === 'direct' ? t('castRouteDirectHelp') : t('castRouteRelayHelp'))),
    castDevices?.error ? el('div', { class: 'err' }, castDevices.error) : null,
    !castDevices?.searching && castDevices?.at && !castDevices?.devices?.length ? el('div', { class: 'muted hint' }, t('castNoneFound')) : null];
}

function renderCast(c = castState) {
  castState = c;
  const shown = castShown(c);
  $('#cast-head').hidden = !shown;
  if (!shown) $('#cast').replaceChildren();
  else mountCastManager($('#cast'), c);
  renderJobs(lastJobs);     // the stream manager takes the place of the downloads
}

function renderStream(s) {
  const card = $('#tpl-stream').content.firstElementChild.cloneNode(true);
  translate(card);
  const d0 = s.probe?.data;
  $('.kind', card).textContent = s.kind === 'page' ? (d0?.extractor || (s.embed ? embedName(s.url) : 'yt-dlp')).toUpperCase()
    : s.kind === 'file' ? (d0?.audioOnly ? 'AUDIO' : (d0?.video?.[0]?.ext || 'file').toUpperCase())
    : s.kind.toUpperCase();
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

  if (s.manual && !s.probe) {
    body.append(el('div', { class: 'muted' }, t('embedText')),
      el('div', {}, el('button', { class: 'ghost', onclick: () => send({ type: 'probe', tabId, streamId: s.id }) }, t('pageCardButton'))));
    return card;
  }
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
  if (d.kind === 'file') { renderFileBody(s, d, body); return card; }

  const sel = initSelection(s);
  const casting = sel.mode === 'cast';
  const update = () => { if (!casting) download.disabled = !sel.videoId && sel.audioIds.size === 0 && sel.subIds.size === 0; };
  body.append(modeSwitch(sel));

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
    if (!casting && (d.audio.length || !d.video.every((v) => v.hasAudio))) {
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
        casting
          ? el('input', { type: 'radio', name: `ca-${s.id}`, checked: sel.castAudioId === a.id, onchange: () => { sel.castAudioId = a.id; } })
          : el('input', {
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
      el('div', { class: 'opts' },
        casting ? el('label', { class: 'opt' },
          el('input', { type: 'radio', name: `cs-${s.id}`, checked: !sel.castSubId, onchange: () => { sel.castSubId = null; } }),
          el('span', { class: 'main muted' }, t('castSubsOff'))) : null,
        d.subs.map((tr) => el('label', { class: 'opt' },
        casting
          ? el('input', { type: 'radio', name: `cs-${s.id}`, checked: sel.castSubId === tr.id, onchange: () => { sel.castSubId = tr.id; } })
          : el('input', {
            type: 'checkbox', checked: sel.subIds.has(tr.id),
            onchange: (e) => { e.target.checked ? sel.subIds.add(tr.id) : sel.subIds.delete(tr.id); update(); },
          }),
        el('span', { class: 'main' }, langLabel(tr.lang),
          !nameIsJustLang(tr.name, tr.lang) ? el('span', { class: 'muted' }, ` — ${tr.name}`) : null,
          tr.forced ? el('span', { class: 'badge' }, t('forced')) : null),
        casting ? null : el('button', {
          class: 'link srt', title: t('srtTitle'),
          onclick: async (e) => {
            e.preventDefault();   // inside the <label>: don't toggle the checkbox
            const r = await send({ type: 'download', tabId, streamId: s.id, videoId: null, audioIds: [], subIds: [tr.id], filename: sel.filename.trim() || 'video' });
            dlError.textContent = r?.error || ''; dlError.hidden = !r?.error;
          },
        }, '.srt'),
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
  if (casting) { body.append(...castActions(s, sel).filter(Boolean)); return card; }
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

let lastJobs = {};
function renderJobs(jobs) {
  lastJobs = jobs || {};
  const list = sortJobs(jobs);
  const casting = castShown(castState);
  for (const id of ['#jobs-overall', '#jobs']) $(id).hidden = casting;
  $('#btn-cast-downloads').hidden = !casting || !list.length;
  $('#btn-cast-downloads').textContent = t('castDownloadsLink', list.filter((j) => ['running', 'saving', 'queued', 'paused'].includes(j.state)).length);
  $('#jobs-head').hidden = list.length === 0 || casting;
  $('#btn-clear-jobs').hidden = !list.some((j) => ['done', 'error', 'cancelled'].includes(j.state));
  // the popup keeps it short: active, paused and failed downloads plus the latest finished ones
  const shown = list.filter((j, i) => !['done', 'cancelled'].includes(j.state) || i < 3).slice(0, 8);
  $('#btn-manager').hidden = shown.length === list.length;
  $('#btn-manager').textContent = t('showAll', list.length);
  const overall = renderOverall(jobs);
  $('#jobs-overall').replaceChildren(...(overall && list.length > 1 ? [overall] : []));
  $('#jobs').replaceChildren(...shown.map((j) => renderJob(j)));
  restoreEditFocus($('#jobs'));
}
setRerender(() => renderJobs(lastJobs));

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
  $('#credits').textContent = t('credits', `v${chrome.runtime.getManifest().version}`);
  $('#credits').title = 'Based on Fluxy by lorisilbagnino — https://github.com/lorisilbagnino/fluxy';
  settingsForm = await mountSettings($('#settings-body'), {
    onChange: (next) => { settings = next; renderHost(); renderDetect(); renderStreams(lastStreams, true); },
  });
  $('#btn-settings').addEventListener('click', () => {
    if ($('#settings').hidden) openSettings(); else $('#settings').hidden = true;
  });
  $('#btn-open-page').addEventListener('click', async () => { await send({ type: 'openPage', page: 'downloads' }); window.close(); });

  const key = `tab:${tabId}`;
  const data = await chrome.storage.session.get([key, 'host', 'armed', 'cast', 'castDevices']);
  castDevices = data.castDevices || null;
  castPrefs = (await chrome.storage.local.get('castPrefs')).castPrefs || null;
  castState = data.cast || null;
  const { jobs } = await chrome.storage.local.get('jobs');
  armedTabs = data.armed || [];
  renderDetect();
  renderHost(data.host);
  lastScan = data[key]?.scan || null;
  renderStreams(data[key]?.streams || []);
  renderJobs(jobs);
  renderCast();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.jobs) renderJobs(changes.jobs.newValue);
    if (area === 'local' && changes.castPrefs) { castPrefs = changes.castPrefs.newValue; renderStreams(lastStreams, true); }
    if (area === 'session' && changes.cast) renderCast(changes.cast.newValue || null);
    if (area === 'session' && changes.castDevices) { castDevices = changes.castDevices.newValue; renderStreams(lastStreams, true); }
    if (area !== 'session') return;
    if (changes[key]) { lastScan = changes[key].newValue?.scan || null; renderStreams(changes[key].newValue?.streams || []); }
    if (changes.host) { renderHost(changes.host.newValue); renderStreams(lastStreams, true); }
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
  $('#speed-limit').replaceWith(speedLimitControl());
  $('#btn-clear-jobs').addEventListener('click', () => send({ type: 'clearFinished' }));
  $('#btn-manager').addEventListener('click', async () => { await send({ type: 'openPage', page: 'downloads' }); window.close(); });
  $('#btn-cast-page').addEventListener('click', async () => { await send({ type: 'openPage', page: 'cast' }); window.close(); });
  $('#btn-cast-downloads').addEventListener('click', async () => { await send({ type: 'openPage', page: 'downloads' }); window.close(); });
  // Videos in the page itself (no playback needed): scanned every time the popup opens.
  send({ type: 'scan', tabId });
  // The local app is only started when it is the chosen engine (or the settings are opened).
  if (settings.engine === 'native') send({ type: 'hostCheck' });
}

init();
