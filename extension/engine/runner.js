// Runs browser-engine jobs: download -> mux -> hand a blob URL back for saving.
// Lives in the offscreen document (Chromium) or in the background page (Firefox).
// `bridge` is how it talks to the background: emit(jobId, fields), ensureHosts(jobId, urls).

import { downloadTrack, mux, vttToSrt, lang3 } from './engine.js';
import { setMaxConnections, CancelledError } from './net.js';

const JOB_PREFIX = 'flux-job-';
const jobs = new Map();   // jobId -> {ctrl, dir, urls: []}

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

function gb(bytes) { return (bytes / 1073741824).toFixed(1).replace('.', ','); }

export async function startJob(jobId, spec, bridge) {
  const ctrl = new AbortController();
  const job = { ctrl, dir: null, urls: [] };
  jobs.set(jobId, job);
  const emit = (f) => bridge.emit(jobId, f);
  try {
    const res = await run(jobId, spec, job, emit, bridge);
    emit({ state: 'saving', progress: 0.99, stage: 'Salvataggio', speed: null, eta: null, files: res });
  } catch (e) {
    const cancelled = e instanceof CancelledError || ctrl.signal.aborted;
    if (!cancelled) console.error('[flux] job failed', e);
    emit(cancelled ? { state: 'cancelled', stage: 'Annullato' } : { state: 'error', stage: 'Errore', error: e.message || String(e) });
    await cleanupJob(jobId);
  }
}

export function cancelJob(jobId) { jobs.get(jobId)?.ctrl.abort(); }

export async function cleanupJob(jobId) {
  const job = jobs.get(jobId);
  jobs.delete(jobId);
  for (const u of job?.urls || []) URL.revokeObjectURL(u);
  const root = await opfsRoot();
  await root.removeEntry(JOB_PREFIX + jobId, { recursive: true }).catch(() => {});
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
      throw new Error(`Spazio insufficiente: servono circa ${gb(est * 2)} GB liberi, il browser ne concede ${gb(quota - usage)}`);
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
      state: 'running', progress: 0.9 * frac, stage: `Download (${wanted.length} ${wanted.length === 1 ? 'traccia' : 'tracce'})`,
      speed, eta: speed > 0 ? Math.max(0, (expected - bytes) / speed) : null,
    });
  };
  report(true);
  const dls = await Promise.all(wanted.map((w, i) => downloadTrack(w.url, {
    dir: job.dir, name: `t${i}`, fetchOpts, parallel: spec.parallel || 8, ensureHosts,
    onProgress: (p) => { Object.assign(state[i], p); report(); },
  })));

  // ---- mux ---------------------------------------------------------------
  const duration = Math.max(...dls.map((d) => d.duration)) || spec.duration;
  const container = spec.container === 'mp4' ? 'mp4' : 'mkv';
  const out = await job.dir.getFileHandle(`out.${container}`, { create: true });
  const subs = (spec.subs || []).map((s) => ({ ...s }));
  let stage = 'Unione in un unico file';
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
  if (container === 'mp4') {
    // Subtitles as .srt next to the video: players pick them up automatically.
    const seen = new Set();
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
  }
  job.urls = files.map((f) => f.url);
  return files;
}
