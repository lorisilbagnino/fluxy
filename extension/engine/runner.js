// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 lorisilbagnino — Fluxy, https://github.com/lorisilbagnino/fluxy (see ADDITIONAL-TERMS.md)
// Runs browser-engine jobs: download -> mux -> hand a blob URL back for saving.
// Lives in the offscreen document (Chromium) or in the background page (Firefox).
// `bridge` is how it talks to the background: emit(jobId, fields), ensureHosts(jobId, urls).

import { downloadTrack, downloadFile, downloadSubtitles, mux, vttToSrt, lang3 } from './engine.js';
import { createPool, setSpeedLimit, CancelledError } from './net.js';
export { setSpeedLimit };
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
  if (!job) { job = { dir: null, urls: [], saved: { byKey: {}, file: {} }, skip: new Set() }; jobs.set(jobId, job); }
  // tracks dropped by the user (index in video, audio…, subtitles order), also before this run
  [spec.video, ...(spec.audio || []), ...(spec.subs || [])].filter((x) => x !== null && x !== undefined)
    .forEach((x, i) => { if (x.skip) job.skip.add(i); });
  job.ctrl = new AbortController();
  job.pool = createPool(spec.parallel || 8);   // "connections per download"
  if (spec.speedLimit != null) setSpeedLimit(spec.speedLimit);
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

/** Skip one track (index in video, audio…, subtitles order): stop it and leave it out of the file. */
export function skipTrack(jobId, index) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.skip.add(index);
  job.trackCtrls?.[index]?.abort();
}

const nameFor = (key) => {   // stable temp file name for a track (survives skipped neighbours and retries)
  let h = 5381;
  for (const c of key) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return `t-${h.toString(36)}`;
};

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
  const fetchOpts = { signal, credentials: 'include', pool: job.pool };
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
      bytes: p.bytes, total: p.total || null, approx: false, conns: { active: job.pool.active, max: job.pool.max },
    });
  };
  const base = job.saved.file.bytes || 0;   // already on disk from an earlier run
  const live = () => ({ bytes: Math.min(spec.size || Infinity, Math.max(job.saved.file.bytes || 0, base + job.pool.received)), total: spec.size || 0 });
  report(live(), true);
  const ticker = setInterval(() => report(live()), 700);
  const file = await downloadFile(spec.url, {
    dir: job.dir, name: `file.${spec.ext || 'bin'}`, fetchOpts, parallel: Math.min(6, spec.parallel || 6),
    size: spec.size, ranges: spec.ranges, onProgress: () => report(live()), state: job.saved.file,
    ensureHosts: (urls) => bridge.ensureHosts(jobId, urls),
  }).finally(() => clearInterval(ticker));
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
  const fetchOpts = { signal: job.ctrl.signal, credentials: 'include', pool: job.pool };
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
  const fetchOpts = { signal, credentials: 'include', pool: job.pool };
  const ensureHosts = (urls) => bridge.ensureHosts(jobId, urls);

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

  // per-track progress shown under the job's bar (subtitles are fetched while merging)
  const trackView = (subsDone = false) => [
    ...wanted.map((w, i) => ({ k: w.type, l: w.type === 'video' ? (w.height ? `${w.height}p` : '') : (w.lang || ''), f: +(state[i].total ? state[i].done / state[i].total : 0).toFixed(3), ...(job.skip.has(i) ? { s: true } : {}) })),
    ...(spec.subs || []).map((x, j) => ({ k: 'sub', l: (x.lang || '') + (x.forced ? ' forced' : ''), f: subsDone ? 1 : 0, ...(job.skip.has(wanted.length + j) ? { s: true } : {}) })),
  ];

  // ---- download (90% of the bar) -----------------------------------------
  const state = wanted.map((w) => ({ bytes: 0, done: 0, total: 0, guess: (w.bandwidth || (w.type === 'video' ? 3e6 : 128e3)) * (spec.duration || 600) / 8 }));
  let lastEmit = 0, lastBytes = 0, lastT = performance.now(), speed = null;
  const base = Object.values(job.saved.byKey).reduce((a, t) => a + (t?.bytes || 0), 0);   // already on disk from an earlier run
  const report = (force) => {
    const now = performance.now();
    if (!force && now - lastEmit < 500) return;
    const live = state.filter((_, i) => !job.skip.has(i));
    const bytes = Math.max(live.reduce((a, s) => a + s.bytes, 0), base + job.pool.received);
    const expected = live.reduce((a, s) => a + (s.done ? s.bytes / s.done * s.total : s.guess), 0);
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
      tracks: trackView(),
      // the total of a stream is estimated from the average segment size until every track is complete
      bytes, total: Math.round(expected), approx: !live.every((s) => s.total && s.done >= s.total),
      conns: { active: job.pool.active, max: job.pool.max },
    });
  };
  report(true);
  const ticker = setInterval(() => report(), 700);
  job.trackCtrls = [...wanted, ...(spec.subs || [])].map(() => new AbortController());
  const names = [];
  const dls = await Promise.all(wanted.map(async (w, i) => {
    const key = [w.type, w.height || '', w.lang || '', w.name || '', w.codec || ''].join('|');
    const saved = (job.saved.byKey[key] ||= { key });
    names[i] = nameFor(key);
    if (job.skip.has(i)) return null;
    try {
      return await downloadTrack(w.url, {
        dir: job.dir, name: names[i], ensureHosts, state: saved, parallel: spec.parallel || 8,
        fetchOpts: { ...fetchOpts, signal: AbortSignal.any([signal, job.trackCtrls[i].signal]) },
        onProgress: (p) => { Object.assign(state[i], p); report(); },
      });
    } catch (e) {
      if (job.skip.has(i) && !signal.aborted) return null;   // dropped by the user
      for (const c of job.trackCtrls) c.abort();               // a real failure stops the other tracks too
      throw e;
    }
  })).finally(() => clearInterval(ticker));
  job.trackCtrls = null;

  // ---- mux ---------------------------------------------------------------
  const got = dls.filter(Boolean);   // skipped tracks are null
  const duration = Math.max(...got.map((d) => d.duration)) || spec.duration;
  const container = spec.container === 'mp4' ? 'mp4' : 'mkv';
  const out = await job.dir.getFileHandle(`out.${container}`, { create: true });
  const subs = (spec.subs || []).map((s) => ({ ...s })).filter((_, j) => !job.skip.has(wanted.length + j));
  let stage = m('eng_stageMux');
  // A lone media playlist may turn out to be audio only: then the video track is optional.
  const tracks = wanted.map((w, i) => ({ dl: dls[i], type: w.type, lang: w.lang, name: w.name, optional: w.type === 'video' && !!w.maybeAudio }))
    .filter((x) => x.dl);
  if (!tracks.length) throw new Error(m('eng_nothingToMux'));
  // audio muxed inside the video rendition, when no separate audio was chosen
  if (spec.video && dls[0] && !tracks.some((x) => x.type === 'audio')) tracks.push({ dl: dls[0], type: 'audio', lang: spec.video.audioLang, optional: true });
  emit({ state: 'running', progress: 0.9, stage, speed: null, eta: null, conns: null, approx: false,
    total: got.reduce((a, d) => a + d.file.size, 0), bytes: got.reduce((a, d) => a + d.file.size, 0) });
  const file = await mux({
    tracks, subs, container, outHandle: out, duration, fetchOpts, ensureHosts,
    onStage: (s) => { stage = s; emit({ state: 'running', stage: s, tracks: trackView(s !== m('eng_stageSubs')) }); },
    onProgress: (f) => emit({ state: 'running', progress: 0.9 + 0.09 * f, stage }),
  });

  // Free the staged tracks before the browser copies the result to Downloads.
  for (const n of names) await job.dir.removeEntry(n).catch(() => {});

  const files = [{ url: URL.createObjectURL(file), ext: container, size: file.size, main: true }];
  // MP4: subtitles as .srt next to the video, players pick them up automatically
  if (container === 'mp4') files.push(...srtFiles(subs));
  job.urls = files.map((f) => f.url);
  return files;
}
