// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 lorisilbagnino — Fluxy, https://github.com/lorisilbagnino/fluxy (see ADDITIONAL-TERMS.md)
// Runs browser-engine jobs: download -> mux -> hand a blob URL back for saving.
// Lives in the offscreen document (Chromium) or in the background page (Firefox).
// `bridge` is how it talks to the background: emit(jobId, fields), ensureHosts(jobId, urls).

import { downloadTrack, downloadFile, downloadSubtitles, mux, vttToSrt, lang3 } from './engine.js';
import { setMaxConnections, CancelledError } from './net.js';
import { m, setStrings } from './i18n.js';

const JOB_PREFIX = 'flux-job-';
// jobId -> {ctrl, dir, urls, saved, running, pausing}. Kept after a pause or an error, so that resume and
// retry continue from the data already on disk; removed by cleanupJob (cancel, remove, saved).
const jobs = new Map();

async function opfsRoot() { return navigator.storage.getDirectory(); }

/** Removes staging folders left by jobs that are no longer running (crash, browser closed...). */
export async function cleanupOrphans() {
  const root = await opfsRoot();
  for await (const [name] of root.entries()) {
    if (name.startsWith(JOB_PREFIX) && !jobs.has(name.slice(JOB_PREFIX.length))) {
      await root.removeEntry(name, { recursive: true }).catch(() => {});
    }
  }
}

function gb(bytes) { return (bytes / 1073741824).toLocaleString(undefined, { maximumFractionDigits: 1 }); }

/** Starts a job, or resumes/retries it (same jobId) from what an earlier run left on disk. */
export async function startJob(jobId, spec, bridge) {
  let job = jobs.get(jobId);
  if (job?.running) return;
  if (!job) { job = { dir: null, urls: [], saved: { tracks: [], file: {} } }; jobs.set(jobId, job); }
  job.ctrl = new AbortController();
  job.running = true;
  job.pausing = false;
  const emit = (f) => bridge.emit(jobId, f);
  setStrings(spec.strings);
  try {
    const res = await ({ file: runFile, subs: runSubs }[spec.kind] || run)(jobId, spec, job, emit, bridge);
    job.running = false;
    emit({ state: 'saving', progress: 0.99, stage: m('eng_stageSaving'), speed: null, eta: null, files: res });
  } catch (e) {
    job.running = false;
    const aborted = e instanceof CancelledError || job.ctrl.signal.aborted;
    if (aborted && job.pausing) {
      emit({ state: 'paused', stage: m('eng_stagePaused'), speed: null, eta: null });
    } else if (aborted) {
      emit({ state: 'cancelled', stage: m('stageCancelled') });
      await cleanupJob(jobId);
    } else {
      console.error('[flux] job failed', e);
      // the staged data stays: "retry" continues from it
      emit({ state: 'error', stage: m('stageError'), error: e.message || String(e), speed: null, eta: null });
    }
  }
}

/** Pause: stop fetching, keep everything written so far. */
export function pauseJob(jobId) {
  const job = jobs.get(jobId);
  if (!job?.running) return;
  job.pausing = true;
  job.ctrl.abort();
}

/** Cancel: a running job stops and cleans up; a paused or failed one is just cleaned up. */
export async function cancelJob(jobId, bridge) {
  const job = jobs.get(jobId);
  if (job?.running) { job.pausing = false; job.ctrl.abort(); return; }
  await cleanupJob(jobId);
  bridge?.emit(jobId, { state: 'cancelled', stage: m('stageCancelled') });
}

export async function cleanupJob(jobId) {
  const job = jobs.get(jobId);
  jobs.delete(jobId);
  for (const u of job?.urls || []) URL.revokeObjectURL(u);
  const root = await opfsRoot();
  await root.removeEntry(JOB_PREFIX + jobId, { recursive: true }).catch(() => {});
}

/** A direct file: download (parallel ranges when possible) and hand it over as is. */
async function runFile(jobId, spec, job, emit, bridge) {
  const signal = job.ctrl.signal;
  const fetchOpts = { signal, credentials: 'include' };
  setMaxConnections(spec.parallel || 8);
  if (spec.size && navigator.storage.estimate) {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    if (quota && quota - usage < spec.size * 1.05) throw new Error(m('eng_noSpace', gb(spec.size), gb(quota - usage)));
  }
  await cleanupOrphans().catch(() => {});
  job.dir = await (await opfsRoot()).getDirectoryHandle(JOB_PREFIX + jobId, { create: true });
  let lastEmit = 0, lastBytes = 0, lastT = performance.now(), speed = null;
  const report = (p, force) => {
    const now = performance.now();
    if (!force && now - lastEmit < 500) return;
    if (now - lastT > 1000) {
      const inst = (p.bytes - lastBytes) / ((now - lastT) / 1000);
      speed = speed == null ? inst : speed * 0.7 + inst * 0.3;
      lastBytes = p.bytes; lastT = now;
    }
    lastEmit = now;
    emit({
      state: 'running', stage: m('eng_stageDownload1'), progress: p.total ? 0.98 * Math.min(1, p.bytes / p.total) : 0,
      speed, eta: speed > 0 && p.total ? Math.max(0, (p.total - p.bytes) / speed) : null,
    });
  };
  report({ bytes: job.saved.file.bytes || 0, total: spec.size || 0 }, true);
  const file = await downloadFile(spec.url, {
    dir: job.dir, name: `file.${spec.ext || 'bin'}`, fetchOpts, parallel: Math.min(6, spec.parallel || 6),
    size: spec.size, ranges: spec.ranges, onProgress: (p) => report(p), state: job.saved.file,
    ensureHosts: (urls) => bridge.ensureHosts(jobId, urls),
  });
  const url = URL.createObjectURL(file);
  job.urls = [url];
  return [{ url, ext: spec.ext || 'bin', size: file.size, main: true }];
}

/** Subtitles as .srt files ("Film.it.srt", "Film.it.forced.srt", "Film.en.srt"…). */
function srtFiles(subs) {
  const seen = new Set(), files = [];
  for (const s of subs) {
    if (!s.text) continue;
    let ext = lang3(s.lang) === 'und' ? 'srt' : `${(s.lang || '').toLowerCase()}.srt`;
    if (s.forced) ext = ext.replace(/srt$/, 'forced.srt');
    let k = 2;
    while (seen.has(ext)) ext = ext.replace(/(\.\d+)?\.srt$/, `.${k++}.srt`);
    seen.add(ext);
    const blob = new Blob([vttToSrt(s.text)], { type: 'application/x-subrip' });
    files.push({ url: URL.createObjectURL(blob), ext, size: blob.size });
  }
  return files;
}

/** Only subtitles: each track becomes its own .srt file, no video or audio downloaded. */
async function runSubs(jobId, spec, job, emit, bridge) {
  const fetchOpts = { signal: job.ctrl.signal, credentials: 'include' };
  const ensureHosts = (urls) => bridge.ensureHosts(jobId, urls);
  const subs = spec.subs.map((s) => ({ ...s }));
  for (let i = 0; i < subs.length; i++) {
    emit({ state: 'running', stage: m('eng_stageSubs'), progress: 0.98 * i / subs.length, speed: null, eta: null });
    subs[i].text = await downloadSubtitles(subs[i].url, { fetchOpts, base: 'auto', ensureHosts });
  }
  const files = srtFiles(subs);
  if (!files.length) throw new Error(m('eng_emptyPlaylist'));
  files[0].main = true;
  job.urls = files.map((f) => f.url);
  return files;
}

async function run(jobId, spec, job, emit, bridge) {
  const signal = job.ctrl.signal;
  const fetchOpts = { signal, credentials: 'include' };
  const ensureHosts = (urls) => bridge.ensureHosts(jobId, urls);
  setMaxConnections(spec.parallel || 8);

  // Disk space: staged tracks + final file ≈ 2× the film.
  const est = ((spec.video?.bandwidth || 0) + (spec.audio || []).reduce((a, t) => a + (t.bandwidth || 128000), 0)) * (spec.duration || 0) / 8;
  if (est && navigator.storage.estimate) {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    if (quota && quota - usage < est * 2.05) {
      throw new Error(m('eng_noSpace', gb(est * 2), gb(quota - usage)));
    }
  }

  await cleanupOrphans().catch(() => {});
  const root = await opfsRoot();
  job.dir = await root.getDirectoryHandle(JOB_PREFIX + jobId, { create: true });

  const wanted = [];
  if (spec.video) wanted.push({ type: 'video', ...spec.video });
  for (const a of spec.audio || []) wanted.push({ type: 'audio', ...a });

  // ---- download (90% of the bar) -----------------------------------------
  const state = wanted.map((w) => ({ bytes: 0, done: 0, total: 0, guess: (w.bandwidth || (w.type === 'video' ? 3e6 : 128e3)) * (spec.duration || 600) / 8 }));
  let lastEmit = 0, lastBytes = 0, lastT = performance.now(), speed = null;
  const report = (force) => {
    const now = performance.now();
    if (!force && now - lastEmit < 500) return;
    const bytes = state.reduce((a, s) => a + s.bytes, 0);
    const expected = state.reduce((a, s) => a + (s.done ? s.bytes / s.done * s.total : s.guess), 0);
    if (now - lastT > 1000) {
      const inst = (bytes - lastBytes) / ((now - lastT) / 1000);
      speed = speed == null ? inst : speed * 0.7 + inst * 0.3;
      lastBytes = bytes; lastT = now;
    }
    lastEmit = now;
    const frac = expected ? Math.min(1, bytes / expected) : 0;
    emit({
      state: 'running', progress: 0.9 * frac, stage: wanted.length === 1 ? m('eng_stageDownload1') : m('eng_stageDownloadN', wanted.length),
      speed, eta: speed > 0 ? Math.max(0, (expected - bytes) / speed) : null,
    });
  };
  report(true);
  const dls = await Promise.all(wanted.map((w, i) => {
    const key = [w.type, w.height || '', w.lang || '', w.name || '', w.codec || ''].join('|');
    if (job.saved.tracks[i]?.key !== key) job.saved.tracks[i] = { key };
    return downloadTrack(w.url, {
      dir: job.dir, name: `t${i}`, fetchOpts, parallel: spec.parallel || 8, ensureHosts, state: job.saved.tracks[i],
      onProgress: (p) => { Object.assign(state[i], p); report(); },
    });
  }));

  // ---- mux ---------------------------------------------------------------
  const duration = Math.max(...dls.map((d) => d.duration)) || spec.duration;
  const container = spec.container === 'mp4' ? 'mp4' : 'mkv';
  const out = await job.dir.getFileHandle(`out.${container}`, { create: true });
  const subs = (spec.subs || []).map((s) => ({ ...s }));
  let stage = m('eng_stageMux');
  // A lone media playlist may turn out to be audio only: then the video track is optional.
  const tracks = wanted.map((w, i) => ({ dl: dls[i], type: w.type, lang: w.lang, name: w.name, optional: w.type === 'video' && !!w.maybeAudio }));
  // audio muxed inside the video rendition, when no separate audio was chosen
  if (spec.video && !(spec.audio || []).length) tracks.push({ dl: dls[0], type: 'audio', lang: spec.video.audioLang, optional: true });
  emit({ state: 'running', progress: 0.9, stage, speed: null, eta: null });
  const file = await mux({
    tracks, subs, container, outHandle: out, duration, fetchOpts, ensureHosts,
    onStage: (s) => { stage = s; emit({ state: 'running', stage: s }); },
    onProgress: (f) => emit({ state: 'running', progress: 0.9 + 0.09 * f, stage }),
  });

  // Free the staged tracks before the browser copies the result to Downloads.
  for (let i = 0; i < dls.length; i++) await job.dir.removeEntry(`t${i}`).catch(() => {});

  const files = [{ url: URL.createObjectURL(file), ext: container, size: file.size, main: true }];
  // MP4: subtitles as .srt next to the video, players pick them up automatically
  if (container === 'mp4') files.push(...srtFiles(subs));
  job.urls = files.map((f) => f.url);
  return files;
}
