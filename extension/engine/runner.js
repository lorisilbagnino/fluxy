// Runs browser-engine jobs: download -> mux -> hand a blob URL back for saving.
// Lives in the offscreen document (Chromium) or in the background page (Firefox).
// `bridge` is how it talks to the background: emit(jobId, fields), ensureHosts(jobId, urls).

import { downloadTrack, mux, vttToSrt, lang3, convertRecording } from './engine.js';
import { setMaxConnections, CancelledError } from './net.js';
import { m, setStrings } from './i18n.js';

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

function gb(bytes) { return (bytes / 1073741824).toLocaleString(undefined, { maximumFractionDigits: 1 }); }

export async function startJob(jobId, spec, bridge) {
  const ctrl = new AbortController();
  const job = { ctrl, dir: null, urls: [] };
  jobs.set(jobId, job);
  const emit = (f) => bridge.emit(jobId, f);
  setStrings(spec.strings);
  try {
    const res = await run(jobId, spec, job, emit, bridge);
    emit({ state: 'saving', progress: 0.99, stage: m('eng_stageSaving'), speed: null, eta: null, files: res });
  } catch (e) {
    const cancelled = e instanceof CancelledError || ctrl.signal.aborted;
    if (!cancelled) console.error('[flux] job failed', e);
    emit(cancelled ? { state: 'cancelled', stage: m('stageCancelled') } : { state: 'error', stage: m('stageError'), error: e.message || String(e) });
    await cleanupJob(jobId);
  }
}

export function cancelJob(jobId) { jobs.get(jobId)?.ctrl.abort(); }

export async function cleanupJob(jobId) {
  const job = jobs.get(jobId);
  jobs.delete(jobId);
  try { job?.port?.disconnect(); } catch {}
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
  const dls = await Promise.all(wanted.map((w, i) => downloadTrack(w.url, {
    dir: job.dir, name: `t${i}`, fetchOpts, parallel: spec.parallel || 8, ensureHosts,
    onProgress: (p) => { Object.assign(state[i], p); report(); },
  })));

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

// ------------------------------------------------------------ recording ---
const REC_PORT = 'fluxy-rec:';

export const isRecordingPort = (port) => port.name.startsWith(REC_PORT);

function fromB64(s) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(s);
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/** Container of a MediaRecorder file: WebM or (Chromium, H.264) fragmented MP4. */
async function sniffExt(file) {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  return String.fromCharCode(...b.subarray(4, 8)) === 'ftyp' ? 'mp4' : 'webm';
}

/**
 * A <video> recording from recorder/page.js. Port name: fluxy-rec:<jobId>:<container>.
 * MediaRecorder chunks arrive on the port (base64) and are appended to OPFS; at the
 * end the file is rewritten into the chosen container (MediaRecorder leaves out
 * duration and cues, so players can't seek) — or saved as recorded if that fails.
 * If the tab goes away mid-recording, what was received so far is still saved.
 */
export function acceptRecording(port, bridge) {
  const [jobId, target = 'webm'] = port.name.slice(REC_PORT.length).split(':');
  const ctrl = new AbortController();
  const signal = ctrl.signal;
  const job = { ctrl, dir: null, urls: [], port };
  jobs.set(jobId, job);
  const emit = (f) => bridge.emit(jobId, f);
  const t0 = Date.now();
  let bytes = 0, lastEmit = 0, ended = false, writable = null;

  let chain = (async () => {
    await cleanupOrphans().catch(() => {});
    job.dir = await (await opfsRoot()).getDirectoryHandle(JOB_PREFIX + jobId, { create: true });
    writable = await (await job.dir.getFileHandle('rec.raw', { create: true })).createWritable();
  })();

  const fail = async (e) => {
    if (signal.aborted) return;
    console.error('[flux] recording failed', e);
    try { port.postMessage({ type: 'error', error: e.message || String(e) }); } catch {}
    emit({ state: 'error', stage: m('stageError'), error: e.message || String(e), recording: false });
    await writable?.abort?.().catch(() => {});
    await cleanupJob(jobId);
  };

  port.onMessage.addListener((m) => {
    if (ended) return;
    if (m?.type === 'chunk') {
      chain = chain.then(async () => {
        const data = fromB64(m.data);
        await writable.write(data);
        bytes += data.length;
        const now = Date.now();
        if (now - lastEmit >= 1000) {
          lastEmit = now;
          emit({ state: 'running', stage: m('eng_stageRecording'), recording: true, size: bytes, elapsed: (now - t0) / 1000 });
        }
      }).catch((e) => { if (!ended) { ended = true; fail(new Error(m('eng_writeFailed', e.message))); } throw e; });
    } else if (m?.type === 'end') finish();
  });
  port.onDisconnect.addListener(() => {
    job.port = null;
    if (!ended && !signal.aborted) finish();
  });
  signal.addEventListener('abort', () => {
    ended = true;
    try { port.disconnect(); } catch {}
    chain.catch(() => {}).then(async () => {
      await writable?.abort?.().catch(() => {});
      emit({ state: 'cancelled', stage: m('stageCancelled'), recording: false });
      await cleanupJob(jobId);
    });
  });

  function finish() {
    ended = true;
    const elapsed = (Date.now() - t0) / 1000;
    chain.then(async () => {
      await writable.close();
      if (!bytes) throw new Error(m('eng_noData'));
      emit({ state: 'running', progress: 0, stage: m('eng_stagePreparing'), recording: false, size: bytes, elapsed });
      const raw = await (await job.dir.getFileHandle('rec.raw')).getFile();
      let file = raw;
      let ext = target;
      let note;
      try {
        const out = await job.dir.getFileHandle(`out.${target}`, { create: true });
        file = await convertRecording({
          file: raw, container: target, outHandle: out, signal,
          onStage: (stage) => emit({ state: 'running', stage }),
          onProgress: (f) => emit({ state: 'running', progress: 0.98 * f }),
        });
        await job.dir.removeEntry('rec.raw').catch(() => {});
      } catch (e) {
        if (signal.aborted) throw e;
        console.warn('[flux] recording conversion failed, saving it as recorded', e);
        file = raw;
        ext = await sniffExt(raw);
        note = m('eng_convertFailed', ext.toUpperCase(), e.message);
        await job.dir.removeEntry(`out.${target}`).catch(() => {});
      }
      const url = URL.createObjectURL(file);
      job.urls = [url];
      try { port.disconnect(); } catch {}
      emit({
        state: 'saving', progress: 0.99, stage: m('stageChooseWhere'), size: file.size, container: ext, note,
        files: [{ url, ext, size: file.size, main: true }],
      });
    }).catch((e) => fail(e));
  }
}
