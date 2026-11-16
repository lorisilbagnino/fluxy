// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 lorisilbagnino — Fluxy, https://github.com/lorisilbagnino/fluxy (see ADDITIONAL-TERMS.md)
// The Fluxy page: download history (persistent), settings (same form as the popup), about.

import { t, UI_LANG, translate, $, send, renderJob, sortJobs, setRerender, restoreEditFocus, renderOverall } from './ui.js';
import { mountSettings } from './settings.js';
import { DONATE_URL } from './build-flags.js';

// ---- tabs (URL hash) ----------------------------------------------------------------
const TABS = ['downloads', 'settings', 'about'];
function showTab() {
  const tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'downloads';
  for (const name of TABS) {
    $(`#tab-${name}`).hidden = name !== tab;
    const link = $(`nav [data-tab="${name}"]`);
    link.setAttribute('aria-selected', String(name === tab));
    link.classList.toggle('on', name === tab);
  }
  if (tab === 'settings') send({ type: 'hostCheck' });
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
await mountSettings($('#settings-body'));
render((await chrome.storage.local.get('jobs')).jobs);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.jobs) render(changes.jobs.newValue);
});
