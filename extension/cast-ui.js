// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 lorisilbagnino — Fluxy, https://github.com/lorisilbagnino/fluxy (see ADDITIONAL-TERMS.md)
// Casting UI shared by the popup and the Fluxy page: the stream manager (what is playing on the TV, with its
// controls and tracks) and the TV picker. The session itself lives in storage.session "cast" (see background.js).

import { t, el, send, langLabel, nameIsJustLang } from './ui.js';

/** A cast that is still worth showing (playing, paused, loading… or just failed). */
export const castShown = (c) => !!c && c.state !== 'stopped';
const ENDED = ['error', 'ended', 'idle'];

export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function trackLabel(kind, x) {
  if (!x) return '—';
  if (kind === 'video') return x.height ? `${x.height}p` : (x.label || t('video'));
  const name = x.name && !nameIsJustLang(x.name, x.lang) ? ` — ${x.name}` : '';
  return `${langLabel(x.lang)}${name}${x.forced ? ` (${t('forced')})` : ''}`;
}

export const deviceLabel = (d) => `${d.name}${d.audioOnly ? ` (${t('castAudioOnly')})` : ''} · ${d.kind === 'chromecast' ? 'Chromecast' : 'DLNA'}${d.stale ? ` (${t('castStale')})` : ''}`;

const ctl = (c, action, value) => send({ type: 'castControl', sessionId: c.id, action, value });
const pick = (c, kind, trackId) => send({ type: 'castSelect', sessionId: c.id, kind, trackId });

/** Where the position slider is being dragged: don't move it under the user's finger. */
let dragging = false;

/** The stream manager. `full` = the Fluxy page (bigger, with the source page link). */
export function renderCastManager(c, { full = false } = {}) {
  const ended = ENDED.includes(c.state);
  const busy = ['connecting', 'loading', 'buffering'].includes(c.state);
  const playing = c.state === 'playing' || c.state === 'buffering';
  const dur = c.duration || 0;
  const caps = c.caps || {};

  const seek = el('input', {
    type: 'range', class: 'cast-seek', min: 0, max: Math.max(1, Math.floor(dur)), step: 1, value: Math.floor(c.position || 0),
    disabled: !dur || ended || caps.seek === false, 'aria-label': t('castSeek'),
    oninput: (e) => { dragging = true; e.target.closest('.cast').querySelector('.cast-pos').textContent = fmtTime(e.target.value); },
    onchange: (e) => { dragging = false; ctl(c, 'seek', Number(e.target.value)); },
  });
  const button = (label, title, onclick, cls = '') => el('button', { class: `ghost cast-btn ${cls}`, title, 'aria-label': title, disabled: ended, onclick }, label);

  const volume = el('input', {
    type: 'range', class: 'cast-vol', min: 0, max: 100, step: 1, value: Math.round((c.volume ?? 0.5) * 100),
    disabled: ended || c.volume == null || caps.volume === false,
    title: caps.volume === false ? t('castVolumeFixed') : t('castVolume'), 'aria-label': t('castVolume'),
    onchange: (e) => ctl(c, 'volume', Number(e.target.value) / 100),
  });

  const tracks = c.tracks || { video: [], audio: [], subs: [] };
  const select = (kind, list, current, enabled, none, disabledTitle) => {
    if (!list.length) return null;
    const opts = list.map((x) => el('option', { value: x.id, selected: x.id === current }, trackLabel(kind, x)));
    if (none) opts.unshift(el('option', { value: '', selected: !current }, t('castSubsOff')));
    return el('label', { class: 'cast-track' },
      el('span', {}, t(kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'subtitles')),
      el('select', {
        disabled: ended || !enabled, title: enabled ? '' : disabledTitle,
        onchange: (e) => pick(c, kind === 'subs' ? 'sub' : kind, e.target.value || null),
      }, opts));
  };
  const sel = c.sel || {};

  return el('div', { class: `cast${full ? ' full' : ''} ${c.state}` },
    el('div', { class: 'cast-head' },
      el('span', { class: 'cast-tv', 'aria-hidden': 'true' }, '📺'),
      el('div', { class: 'cast-what' },
        el('div', { class: 'cast-title', title: c.title || '' }, c.title || '—'),
        el('div', { class: 'cast-dev muted' }, [c.device?.name, c.route === 'direct' ? t('castRouteDirect') : t('castRouteRelay')].filter(Boolean).join(' · '))),
      el('span', { class: `cast-state ${c.state}` }, busy ? el('span', { class: 'spinner' }) : null, t(`castState_${c.state}`) || c.state)),
    c.note && !c.error ? el('div', { class: 'muted cast-note' }, c.note) : null,
    c.error ? el('div', { class: 'err' }, c.error, c.route === 'direct' ? el('span', { class: 'hint' }, ` ${t('castDirectHint')}`) : null) : null,
    el('div', { class: 'cast-time' }, el('span', { class: 'cast-pos' }, fmtTime(c.position)), seek, el('span', { class: 'muted' }, dur ? fmtTime(dur) : '–:––')),
    el('div', { class: 'cast-controls' },
      button('⏪', t('castBack'), () => ctl(c, 'seekBy', -10)),
      button(playing ? '⏸' : '▶', playing ? t('castPause') : t('castPlay'), () => ctl(c, playing ? 'pause' : 'play'), 'accent'),
      button('⏩', t('castForward'), () => ctl(c, 'seekBy', 30)),
      button('⏹', t('castStop'), () => send({ type: 'castStop' })),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'link cast-mute', disabled: ended || c.muted == null, title: c.muted ? t('castUnmute') : t('castMute'),
        onclick: () => ctl(c, 'mute', !c.muted),
      }, c.muted ? '🔇' : '🔊'),
      volume),
    el('div', { class: 'cast-tracks' },
      select('video', tracks.video, sel.videoId, caps.video, false, t('castVideoAuto')),
      select('audio', tracks.audio, sel.audioId, caps.audio !== false, false, ''),
      select('subs', tracks.subs, sel.subId, caps.subs !== false, true, '')),
    ended ? el('div', { class: 'actions cast-end' },
      el('button', { class: 'ghost', onclick: () => send({ type: 'castRetry' }) }, t('castRetry')),
      el('button', { class: 'link', onclick: () => send({ type: 'castDismiss' }) }, t('castClose'))) : null,
    full && c.pageUrl ? el('div', { class: 'muted cast-source' }, t('dSource'), ': ',
      el('a', { href: c.pageUrl, target: '_blank', rel: 'noopener' }, c.pageTitle || c.pageUrl)) : null);
}

/** Keeps the slider still while it is being dragged (the manager re-renders every second). */
export const castDragging = () => dragging;

/** Everything shown by the manager except the position, which changes every second. */
const castKey = (c) => { const { position, at, ...rest } = c; return JSON.stringify(rest); };

/**
 * Shows the manager in `box`. While playing only the time and the slider move: the rest is rebuilt when
 * something else changes, and never while a menu or slider in it is in use (it would close under the user).
 */
export function mountCastManager(box, c, opts) {
  const prev = box.querySelector(':scope > .cast');
  const focus = document.activeElement;
  const inUse = dragging || (prev && prev.contains(focus) && ['SELECT', 'INPUT'].includes(focus.tagName));
  if (prev && (inUse || prev.dataset.key === castKey(c))) {
    prev.querySelector('.cast-pos').textContent = fmtTime(c.position);
    const seek = prev.querySelector('.cast-seek');
    if (!dragging && seek) seek.value = Math.floor(c.position || 0);
    return;
  }
  const node = renderCastManager(c, opts);
  node.dataset.key = castKey(c);
  box.replaceChildren(node);
}

/**
 * TV picker: discovered devices + "search again". `state` = {devices, at, searching, error} from
 * storage.session "castDevices"; `prefs` = {deviceId, route} from storage.local "castPrefs".
 */
export function devicePicker(state, prefs, { onChange } = {}) {
  const devices = state?.devices || [];
  const select = el('select', {
    class: 'cast-device', 'aria-label': t('castDevice'),
    onchange: (e) => onChange?.({ deviceId: e.target.value }),
  }, devices.length
    ? devices.map((d) => el('option', { value: d.id, selected: d.id === prefs?.deviceId }, deviceLabel(d)))
    : [el('option', { value: '' }, state?.searching ? t('castSearching') : t('castNoDevices'))]);
  return el('div', { class: 'cast-picker' },
    select,
    el('button', {
      class: 'ghost', title: t('castSearchTitle'), disabled: !!state?.searching,
      onclick: () => send({ type: 'castDiscover' }),
    }, state?.searching ? el('span', { class: 'spinner' }) : '⟳'));
}

export function routePicker(prefs, { onChange } = {}) {
  const route = prefs?.route || 'relay';
  return el('div', { class: 'seg cast-route', title: t('castRouteHelp') },
    ...[['relay', t('castRouteRelay')], ['direct', t('castRouteDirect')]].map(([v, label]) => el('button', {
      class: route === v ? 'on' : '', onclick: () => onChange?.({ route: v }),
    }, label)));
}
