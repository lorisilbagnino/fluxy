// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 lorisilbagnino — Fluxy, https://github.com/lorisilbagnino/fluxy (see ADDITIONAL-TERMS.md)
// UI helpers shared by the popup and the downloads page: strings, formatting, the download list.

export const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;
export const UI_LANG = chrome.i18n.getUILanguage();

/** Fills data-i18n / data-i18n-title / data-i18n-aria attributes under root. */
export function translate(root = document) {
  for (const n of root.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  for (const n of root.querySelectorAll('[data-i18n-title]')) n.title = t(n.dataset.i18nTitle);
  for (const n of root.querySelectorAll('[data-i18n-aria]')) n.setAttribute('aria-label', t(n.dataset.i18nAria));
}


export const $ = (sel, root = document) => root.querySelector(sel);
export const send = (msg) => chrome.runtime.sendMessage(msg);

// ------------------------------------------------------------ formatting ---
const langNames = (() => {
  try { return new Intl.DisplayNames([UI_LANG], { type: 'language' }); } catch { return null; }
})();

const langNamesEn = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }); } catch { return null; }
})();

/** true when a track NAME just repeats its language ("English", "Italiano", "ita"...). */
export function nameIsJustLang(name, code) {
  if (!name) return true;
  const n = name.trim().toLowerCase();
  if (code && n === code.toLowerCase()) return true;
  const cands = [];
  try { cands.push(langNames?.of(code), langNamesEn?.of(code)); } catch {}
  try { cands.push(new Intl.DisplayNames([code], { type: 'language' }).of(code)); } catch {}
  return cands.filter(Boolean).some((c) => c.toLowerCase() === n);
}

export function langLabel(code) {
  if (!code) return t('langUnknown');
  try {
    const n = langNames?.of(code);
    if (n && n.toLowerCase() !== code.toLowerCase()) return n.charAt(0).toUpperCase() + n.slice(1);
  } catch {}
  return code;
}

export function prettyCodec(c) {
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

export const listFmt = (items) => {
  try { return new Intl.ListFormat(UI_LANG, { type: 'conjunction' }).format(items); } catch { return items.join(', '); }
};

export function channelsLabel(ch) {
  const n = parseInt(ch, 10);
  return { 1: 'mono', 2: '2.0', 6: '5.1', 8: '7.1' }[n] || (n ? `${n} ch` : '');
}

export function fmtBitrate(bps) {
  if (!bps) return '';
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1e3)} kbps`;
}

export function fmtDuration(sec) {
  if (!sec) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s).padStart(2, '0')}s`;
}

export function fmtSpeed(bps) {
  if (!bps) return '';
  return bps > 1048576 ? `${(bps / 1048576).toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`;
}

export function fmtEta(s) {
  if (s == null || !isFinite(s)) return '';
  s = Math.round(s);
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function el(tag, attrs = {}, ...children) {
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

export function fmtSize(b) {
  const fmt = (n, dg) => n.toLocaleString(UI_LANG, { minimumFractionDigits: dg, maximumFractionDigits: dg });
  return b >= 1073741824 ? `${fmt(b / 1073741824, 2)} GB` : `${fmt(Math.max(0.1, b / 1048576), 1)} MB`;
}


// ------------------------------------------------------------ downloads ---
// Renaming a job in place. The lists are redrawn at every progress update, so the draft (and the
// caret) live here and are restored after each redraw (restoreEditFocus).
const edits = new Map();   // jobId -> {value, caret}
let rerender = () => {};
export function setRerender(fn) { rerender = fn; }
const RENAMABLE = ['running', 'paused', 'error', 'cancelled'];

export function restoreEditFocus(root) {
  const input = root.querySelector('input[data-edit]');
  if (!input) return;
  const e = edits.get(input.dataset.edit);
  input.focus();
  const c = e?.caret ?? input.value.length;
  input.setSelectionRange(c, c);
}

function nameEditor(j, full) {
  const draft = edits.get(j.id);
  const commit = async () => {
    const name = draft.value.trim();
    edits.delete(j.id);
    if (name && name !== j.filename) await send({ type: 'renameJob', jobId: j.id, filename: name });
    rerender();
  };
  const cancel = () => { edits.delete(j.id); rerender(); };
  const input = el('input', {
    type: 'text', value: draft.value, 'data-edit': j.id, spellcheck: 'false',
    oninput: (e) => { draft.value = e.target.value; draft.caret = e.target.selectionStart; },
    onkeyup: (e) => { draft.caret = e.target.selectionStart; },
    onclick: (e) => { draft.caret = e.target.selectionStart; },
    onkeydown: (e) => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') cancel(); },
  });
  return el('span', { class: 'job-name-edit' }, input,
    el('span', { class: 'file-ext' }, `.${j.container}`),
    el('button', { class: full ? 'ghost accent' : 'link accent', title: t('renameSave'), onclick: commit }, '✓'),
    el('button', { class: full ? 'ghost' : 'link', title: t('renameCancel'), onclick: cancel }, '✕'));
}

const ACTIVE = ['running', 'saving'];
const langCodes = (list) => list.map((x) => `${(x.lang || '?').split(/[-_]/)[0].toUpperCase()}${x.forced ? ` (${t('forced')})` : ''}`).join(', ');

/** "1080p · audio IT, EN · sub IT, IT (forced)" */
export function jobSummary(j) {
  const d = j.detail;
  if (!d) return j.describe || '';
  return [
    d.video ? (d.video.height ? `${d.video.height}p` : d.video.label || (d.video.ext || '').toUpperCase() || t('video')) : null,
    d.audio.length ? `${t('audioShort')} ${langCodes(d.audio)}` : null,
    d.subs.length ? `${t('subShort')} ${langCodes(d.subs)}` : null,
  ].filter(Boolean).join(' · ');
}

const expiredHint = (j) => j.state === 'error' && /\b40[13]\b|forbidden|unauthori[sz]ed|access denied/i.test(j.error || '');

function jobButtons(j, full) {
  const b = (label, msg, cls = '') => el('button', { class: full ? `ghost ${cls}` : `link ${cls}`, onclick: () => send({ ...msg, jobId: j.id }) }, label);
  const out = [];
  if (j.state === 'running') out.push(b(t('pause'), { type: 'pause' }));
  if (j.state === 'paused') out.push(b(t('resume'), { type: 'resume' }, 'accent'));
  if (j.state === 'error' || (j.state === 'cancelled' && j.spec)) out.push(b(t('retryJob'), { type: 'retry' }, 'accent'));
  if ([...ACTIVE, 'paused'].includes(j.state)) out.push(b(t('cancel'), { type: 'cancel' }));
  if (j.state === 'done') out.push(b(j.engine === 'browser' ? t('showFile') : t('openFolder'), { type: 'reveal' }));
  if (![...ACTIVE, 'paused'].includes(j.state)) out.push(b(t('remove'), { type: 'removeJob' }));
  return out;
}

function detailRows(j) {
  const d = j.detail || {};
  const rows = [];
  const v = d.video;
  if (v) rows.push([t('dVideo'), [v.width && v.height ? `${v.width}×${v.height}` : v.height ? `${v.height}p` : v.label, v.codec ? prettyCodec(v.codec) : null,
    v.fps && v.fps > 31 ? `${Math.round(v.fps)} fps` : null, fmtBitrate(v.bandwidth), v.size ? fmtSize(v.size) : null, v.ext ? v.ext.toUpperCase() : null].filter(Boolean).join(' · ')]);
  if (d.audio?.length) rows.push([t('dAudio'), d.audio.map((a) => [langLabel(a.lang) + (a.name && !nameIsJustLang(a.name, a.lang) ? ` — ${a.name}` : ''),
    prettyCodec(a.codec), channelsLabel(a.channels)].filter(Boolean).join(' · ')).join('\n')]);
  if (d.subs?.length) rows.push([t('dSubs'), d.subs.map((x) => langLabel(x.lang) + (x.name && !nameIsJustLang(x.name, x.lang) ? ` — ${x.name}` : '')
    + (x.forced ? ` (${t('forced')})` : '')).join('\n')]);
  rows.push([t('dEngine'), `${j.engine === 'browser' ? t('pillBrowser') : t('pillNative')} · ${(j.container || '').toUpperCase()}`]);
  if (d.pageUrl || d.host) rows.push([t('dSource'), d.pageUrl ? el('a', { href: d.pageUrl, target: '_blank', rel: 'noopener', title: d.pageUrl }, d.title || d.pageUrl) : d.host]);
  if (j.output) rows.push([t('dSavedTo'), j.output]);
  rows.push([t('dStarted'), new Date(j.startedAt).toLocaleString(UI_LANG) + (j.retries ? ` · ${j.retries === 1 ? t('dRetries1') : t('dRetries', j.retries)}` : '')]);
  return rows;
}

/** One download: compact (popup) or with every detail (downloads page). */
export function renderJob(j, { full = false } = {}) {
  const pct = Math.round((j.progress || 0) * 100);
  const recording = j.kind === 'record' && j.state === 'running' && !!j.recording;
  const right = ACTIVE.includes(j.state)
    ? [fmtSpeed(j.speed), j.eta != null ? `ETA ${fmtEta(j.eta)}` : null, `${pct}%`].filter(Boolean).join(' · ')
    : j.state === 'paused' ? `${pct}%` : '';
  const summary = jobSummary(j);
  const info = j.state === 'error'
    ? el('span', { class: 'err', title: j.error || '' }, j.error || t('error'), expiredHint(j) ? el('span', { class: 'hint' }, ` ${t('hint403')}`) : null)
    : `${j.stage || ''}${summary && !full ? ` — ${summary}` : ''}`;
  return el('div', { class: `job ${j.state}${recording ? ' recording' : ''}${full ? ' full' : ''}` },
    edits.has(j.id) && RENAMABLE.includes(j.state)
      ? el('div', { class: 'job-top' }, nameEditor(j, full))
      : el('div', { class: 'job-top' },
        el('span', { class: 'job-name', title: summary ? `${j.filename}.${j.container}\n${summary}` : j.output || '' }, `${j.filename}.${j.container}`),
        RENAMABLE.includes(j.state) && j.kind !== 'record'
          ? el('button', { class: full ? 'ghost' : 'link rename', title: t('rename'), onclick: () => { edits.set(j.id, { value: j.filename, caret: null }); rerender(); } }, '✎')
          : null,
        ...jobButtons(j, full)),
    full && summary ? el('div', { class: 'job-summary' }, summary) : null,
    el('div', { class: 'bar' }, el('i', { style: `width:${j.state === 'done' ? 100 : pct}%` })),
    el('div', { class: 'job-info' }, el('span', {}, info), el('span', {}, right)),
    j.note ? el('div', { class: 'muted job-note' }, j.note) : null,
    full ? el('dl', { class: 'job-detail' }, ...detailRows(j).flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])) : null,
  );
}

export function sortJobs(jobs) {
  return Object.values(jobs || {}).sort((a, b) => b.startedAt - a.startedAt);
}
