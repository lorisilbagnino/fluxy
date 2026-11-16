// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 lorisilbagnino — Fluxy, https://github.com/lorisilbagnino/fluxy (see ADDITIONAL-TERMS.md)
// Downloads page: every job with its full details and actions (pause, resume, retry, cancel, show, remove).

import { t, UI_LANG, translate, $, send, renderJob, sortJobs } from './ui.js';

function render(jobs) {
  const list = sortJobs(jobs);
  $('#empty').hidden = list.length > 0;
  const active = list.filter((j) => ['running', 'saving'].includes(j.state)).length;
  $('#counts').textContent = list.length ? t('managerCounts', active, list.length) : '';
  $('#btn-clear').hidden = !list.some((j) => ['done', 'error', 'cancelled'].includes(j.state));
  $('#list').replaceChildren(...list.map((j) => renderJob(j, { full: true })));
}

document.documentElement.lang = UI_LANG;
translate();
document.title = t('managerTitle');
$('#credits').textContent = t('credits', `v${chrome.runtime.getManifest().version}`);
$('#credits').title = 'Based on Fluxy by lorisilbagnino — https://github.com/lorisilbagnino/fluxy';
$('#btn-clear').addEventListener('click', () => send({ type: 'clearFinished' }));

chrome.storage.session.get('jobs').then(({ jobs }) => render(jobs));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.jobs) render(changes.jobs.newValue);
});
