// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 lorisilbagnino — Fluxy, https://github.com/lorisilbagnino/fluxy (see ADDITIONAL-TERMS.md)
// The Fluxy page: download history (persistent), stream manager (casting), settings (same form as the popup), about.

import { t, UI_LANG, translate, $, send, el, renderJob, sortJobs, setRerender, restoreEditFocus, renderOverall, speedLimitControl } from './ui.js';
import { mountSettings } from './settings.js';
import { DONATE_URL } from './build-flags.js';
import { castShown, castDragging, renderCastManager, deviceLabel, routePicker } from './cast-ui.js';

// ---- tabs (URL hash) ----------------------------------------------------------------
const TABS = ['downloads', 'cast', 'settings', 'about'];
function showTab() {
  const tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'downloads';
  for (const name of TABS) {
    $(`#tab-${name}`).hidden = name !== tab;
    const link = $(`nav [data-tab="${name}"]`);
    link.setAttribute('aria-selected', String(name === tab));
    link.classList.toggle('on', name === tab);
  }
  if (tab === 'settings' || tab === 'cast') send({ type: 'hostCheck' });
  if (tab === 'cast' && !castDevices?.at && !castDevices?.searching) send({ type: 'castDiscover' });
}
window.addEventListener('hashchange', showTab);

// ---- downloads ------------------------------------------------------------------------
let lastJobs = {};
let confirmClear = false;
function render(jobs) {
  lastJobs = jobs || {};
  const list = sortJobs(jobs);
  $('#empty').hidden = list.length > 0;
  const active = list.filter((j) => ['running', 'saving', 'queued', 'paused'].includes(j.state)).length;
  $('#counts').textContent = list.length ? t('managerCounts', active, list.length) : '';
  $('#btn-clear').hidden = !list.some((j) => ['done', 'error', 'cancelled'].includes(j.state));
  const overall = renderOverall(jobs);
  $('#overall').replaceChildren(...(overall ? [overall] : []));
  $('#list').replaceChildren(...list.map((j) => renderJob(j, { full: true })));
  restoreEditFocus($('#list'));
}
setRerender(() => render(lastJobs));

// "Clear history" asks once more on the button itself (no dialogs).
$('#btn-clear').addEventListener('click', async () => {
  if (!confirmClear) {
    confirmClear = true;
    $('#btn-clear').textContent = t('clearHistoryConfirm');
    $('#btn-clear').classList.add('danger');
    setTimeout(() => { confirmClear = false; $('#btn-clear').textContent = t('clearHistory'); $('#btn-clear').classList.remove('danger'); }, 4000);
    return;
  }
  confirmClear = false;
  $('#btn-clear').textContent = t('clearHistory');
  $('#btn-clear').classList.remove('danger');
  await send({ type: 'clearFinished' });
});

// ---- cast: stream manager + TVs ----------------------------------------------------------
let castState = null;
let castDevices = null;
let castPrefs = null;
let hostState = null;
function renderCastTab() {
  const shown = castShown(castState);
  $('#cast-empty').hidden = shown;
  if (!shown) $('#cast-now').replaceChildren();
  else if (!castDragging()) $('#cast-now').replaceChildren(renderCastManager(castState, { full: true }));
  const noApp = hostState?.status && hostState.status !== 'ok';
  $('#cast-noapp').hidden = !noApp;
  $('#cast-noapp').textContent = noApp ? t('castNeedsApp') : '';
  const list = castDevices?.devices || [];
  const save = (patch) => chrome.storage.local.set({ castPrefs: { route: 'relay', ...castPrefs, ...patch } });
  $('#btn-cast-search').disabled = !!castDevices?.searching || noApp;
  $('#btn-cast-search').textContent = castDevices?.searching ? t('castSearching') : t('castSearch');
  $('#cast-devices').replaceChildren(...[
    ...list.map((d) => el('label', { class: `cast-device-row${d.id === castPrefs?.deviceId ? ' on' : ''}` },
      el('input', { type: 'radio', name: 'cast-dev', checked: d.id === castPrefs?.deviceId, onchange: () => save({ deviceId: d.id }) }),
      el('span', { class: 'main' }, deviceLabel(d)),
      el('span', { class: 'muted' }, [d.model, d.host, d.manual ? t('castManual') : null].filter(Boolean).join(' · ')))),
    !list.length ? el('p', { class: 'muted' }, castDevices?.searching ? t('castSearching') : castDevices?.at ? t('castNoneFound') : t('castNoDevices')) : null,
    castDevices?.error ? el('p', { class: 'err' }, castDevices.error) : null,
    el('div', { class: 'cast-route-row' }, el('span', {}, t('castRouteLabel')), routePicker(castPrefs, { onChange: save }),
      el('small', { class: 'muted' }, (castPrefs?.route || 'relay') === 'direct' ? t('castRouteDirectHelp') : t('castRouteRelayHelp'))),
  ].filter(Boolean));
}
$('#cast-address').placeholder = t('castAddPlaceholder');
$('#btn-cast-search').addEventListener('click', () => send({ type: 'castDiscover' }));
$('#cast-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const address = $('#cast-address').value.trim();
  if (!address) return;
  const r = await send({ type: 'castAddDevice', address });
  $('#cast-add-error').hidden = !r?.error;
  $('#cast-add-error').textContent = r?.error || '';
  if (!r?.error) $('#cast-address').value = '';
});

// ---- init -------------------------------------------------------------------------------
document.documentElement.lang = UI_LANG;
translate();
document.title = 'Fluxy';
if (DONATE_URL) {
  $('#donate').href = DONATE_URL; $('#donate').hidden = false;
  $('#about-donate').hidden = false;
  $('#about-donate').append(' ', Object.assign(document.createElement('a'), { href: DONATE_URL, target: '_blank', rel: 'noopener', textContent: DONATE_URL.replace(/^https?:\/\//, '') }));
}
$('#credits').textContent = t('credits', `v${chrome.runtime.getManifest().version}`);
$('#credits').title = 'Based on Fluxy by lorisilbagnino — https://github.com/lorisilbagnino/fluxy';
showTab();
$('#speed-limit').replaceWith(speedLimitControl());
await mountSettings($('#settings-body'));
render((await chrome.storage.local.get('jobs')).jobs);
({ cast: castState, castDevices, host: hostState } = await chrome.storage.session.get(['cast', 'castDevices', 'host']));
castPrefs = (await chrome.storage.local.get('castPrefs')).castPrefs || null;
renderCastTab();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.jobs) render(changes.jobs.newValue);
  if (area === 'local' && changes.castPrefs) { castPrefs = changes.castPrefs.newValue; renderCastTab(); }
  if (area !== 'session') return;
  if (changes.cast) castState = changes.cast.newValue || null;
  if (changes.castDevices) castDevices = changes.castDevices.newValue || null;
  if (changes.host) hostState = changes.host.newValue || null;
  if (changes.cast || changes.castDevices || changes.host) renderCastTab();
});
