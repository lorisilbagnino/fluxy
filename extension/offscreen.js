// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 lorisilbagnino — Fluxy, https://github.com/lorisilbagnino/fluxy (see ADDITIONAL-TERMS.md)
// Chromium: the service worker can be stopped at any time, so browser-engine
// jobs run in this offscreen document. It only has chrome.runtime: progress
// goes to the worker as messages.

import { startJob, cancelJob, pauseJob, cleanupJob, cleanupOrphans, setSpeedLimit } from './engine/runner.js';

const bridge = {
  emit: (jobId, fields) => chrome.runtime.sendMessage({ type: 'engineEvent', jobId, fields }).catch(() => {}),
  ensureHosts: (jobId, urls) => chrome.runtime.sendMessage({ type: 'engineHosts', jobId, urls }),
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== 'offscreen') return;   // messages for the worker
  switch (msg.type) {
    case 'start': startJob(msg.jobId, msg.spec, bridge); break;
    case 'cancel': cancelJob(msg.jobId, bridge); break;
    case 'pause': pauseJob(msg.jobId); break;
    case 'speedLimit': setSpeedLimit(msg.bytesPerSecond); break;
    case 'cleanup': cleanupJob(msg.jobId); break;
    case 'ping': break;
  }
  reply({ ok: true });
});

cleanupOrphans().catch(() => {});
