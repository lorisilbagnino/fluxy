// Chromium: the service worker can be stopped at any time, so browser-engine
// jobs run in this offscreen document. It only has chrome.runtime: progress
// goes to the worker as messages.

import { startJob, cancelJob, cleanupJob, cleanupOrphans, acceptRecording, isRecordingPort } from './engine/runner.js';
import { setStrings } from './engine/i18n.js';

const bridge = {
  emit: (jobId, fields) => chrome.runtime.sendMessage({ type: 'engineEvent', jobId, fields }).catch(() => {}),
  ensureHosts: (jobId, urls) => chrome.runtime.sendMessage({ type: 'engineHosts', jobId, urls }),
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== 'offscreen') return;   // messages for the worker
  switch (msg.type) {
    case 'start': startJob(msg.jobId, msg.spec, bridge); break;
    case 'cancel': cancelJob(msg.jobId); break;
    case 'cleanup': cleanupJob(msg.jobId); break;
    case 'ping': break;
  }
  reply({ ok: true });
});

// <video> recordings: the content script streams the chunks straight here.
chrome.runtime.onConnect.addListener((port) => {
  if (isRecordingPort(port)) acceptRecording(port, bridge);
});

// No chrome.i18n here: the localised engine strings come from the worker (recordings need them before any job spec).
chrome.runtime.sendMessage({ type: 'engineStrings' }).then(setStrings).catch(() => {});

cleanupOrphans().catch(() => {});
