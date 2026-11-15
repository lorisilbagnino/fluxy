// Fluxy — page side of the video recorder, injected in the page's MAIN world
// (Firefox content scripts can't hand the page's MediaStreams to MediaRecorder).
// Lets the user pick a <video>, records it and passes the chunks to bridge.js.
// No innerHTML and no <style>/style attributes: pages with Trusted Types or a
// strict CSP (Google Meet, Teams...) would block them.

(() => {
  const KEY = Symbol.for('fluxy-recorder');
  if (window[KEY]) return;

  const TAG = 'fluxy-rec';
  // Localised strings, set by the background just before injecting this script (English fallback).
  const L = (key, fallback, ...subs) => {
    let s = window[Symbol.for('fluxy-recorder-strings')]?.[key] || fallback;
    subs.forEach((v, i) => { s = s.split(`$${i + 1}`).join(String(v)); });
    return s;
  };
  const MIMES_VIDEO = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const MIMES_AUDIO = ['audio/webm;codecs=opus', 'audio/webm'];
  // MP4 target: H.264 straight from MediaRecorder (Chromium) leaves only a remux to do
  const MIMES_VIDEO_MP4 = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,opus'];
  const MIMES_AUDIO_MP4 = ['audio/mp4;codecs=mp4a.40.2'];
  const CSS = /*css*/ `
:host { all: initial; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.layer { pointer-events: none; position: fixed; inset: 0; }
.box { background: rgba(255, 176, 32, .14); transition: background-color .12s; border: 2px solid #ffb020; pointer-events: auto; border-radius: 6px; position: absolute; cursor: pointer; }
.box:hover { background: rgba(255, 176, 32, .3); }
.box.off { background: rgba(20, 22, 28, .35); border: 2px dashed #8b95a7; cursor: not-allowed; }
.box .label { font: 600 12px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #ffb020; border-radius: 4px; position: absolute; padding: 3px 7px; color: #1a1200; left: 6px; top: 6px; }
.box.off .label { background: #2e3644; color: #e8ebf1; }
.ring { border: 2px solid #ffb020; pointer-events: none; border-radius: 6px; position: absolute; }
.ring.rec { box-shadow: 0 0 0 1px rgba(242, 85, 90, .5); border-color: #f2555a; }
.banner { font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: 0 6px 24px rgba(0, 0, 0, .35); transform: translateX(-50%); padding: 8px 10px 8px 14px; border: 1px solid #2e3644; pointer-events: auto; border-radius: 10px; align-items: center; background: #12151c; position: fixed; color: #e8ebf1; display: flex; left: 50%; gap: 12px; top: 12px; }
.stack { flex-direction: column; position: fixed; display: flex; width: 300px; right: 16px; top: 16px; gap: 8px; }
.panel { font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: 0 8px 28px rgba(0, 0, 0, .4); border: 1px solid #2e3644; pointer-events: auto; border-radius: 10px; background: #12151c; padding: 10px 12px; color: #e8ebf1; display: grid; gap: 8px; }
.head { align-items: center; display: flex; gap: 8px; }
.title { font-weight: 600; flex: 1; }
.muted { font-size: 12px; color: #8b95a7; }
.err { word-break: break-word; font-size: 12px; color: #f2555a; }
.check { align-items: flex-start; font-size: 12px; cursor: pointer; display: flex; gap: 8px; }
.check input { accent-color: #ffb020; margin: 2px 0 0; }
.row { align-items: center; display: flex; gap: 8px; }
.row .grow { flex: 1; }
button { cursor: pointer; font: inherit; }
.primary { background: #ffb020; border-radius: 8px; padding: 6px 12px; font-weight: 600; color: #1a1200; border: 0; }
.stop { background: #f2555a; border-radius: 8px; padding: 6px 12px; font-weight: 600; color: #fff; border: 0; }
.ghost { border: 1px solid #2e3644; background: #232a35; border-radius: 8px; padding: 5px 10px; color: #e8ebf1; }
.link { text-underline-offset: 2px; text-decoration: underline; background: none; font-size: 12px; color: #8b95a7; padding: 0; border: 0; }
.x { background: none; font-size: 16px; padding: 0 2px; color: #8b95a7; border: 0; }
.dot { animation: pulse 1.4s ease-in-out infinite; background: #f2555a; border-radius: 50%; height: 9px; width: 9px; }
.clock { font-variant-numeric: tabular-nums; font-weight: 600; }
@keyframes pulse { 50% { opacity: .25; } }
`;

  let ui = null;
  let picking = null;      // {boxes: Map<video, box>, scan, banner}
  let raf = 0;
  let ridSeq = 0;
  const recs = new Map();  // rid -> recording

  const post = (msg, transfer = []) => window.postMessage({ [TAG]: 'out', ...msg }, '*', transfer);

  // Builds a DOM node: h('div', {class, onclick, ...}, ...children)
  function h(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k in e) e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
    return e;
  }

  // Creates the overlay host (closed shadow root) on first use.
  function ensureUI() {
    if (ui) return ui;
    const host = document.createElement('fluxy-ui');
    for (const [k, v] of [['position', 'fixed'], ['inset', '0'], ['z-index', '2147483647'], ['pointer-events', 'none'], ['display', 'block']]) {
      host.style.setProperty(k, v, 'important');
    }
    const root = host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      root.append(h('style', {}, CSS));
    }
    const layer = h('div', { class: 'layer' });
    const stack = h('div', { class: 'stack' });
    root.append(layer, stack);
    ui = { host, root, layer, stack };
    mountHost();
    document.addEventListener('fullscreenchange', mountHost);
    return ui;
  }

  // Keeps the overlay visible in fullscreen (the top layer hides everything else).
  function mountHost() {
    const parent = document.fullscreenElement || document.documentElement;
    if (ui && ui.host.parentNode !== parent) parent.append(ui.host);
  }

  function maybeDisposeUI() {
    if (!ui || picking || recs.size) return;
    document.removeEventListener('fullscreenchange', mountHost);
    ui.host.remove();
    ui = null;
  }

  function allMedia(selector, root = document, out = []) {
    for (const e of root.querySelectorAll(selector)) out.push(e);
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) allMedia(selector, e.shadowRoot, out);
    return out;
  }

  const live = (t) => t.readyState === 'live';

  function sourceKind(v) {
    const so = v.srcObject;
    if (so instanceof MediaStream) return so.getTracks().some(live) ? 'stream' : null;
    if (typeof v.captureStream === 'function' && v.readyState >= 2) return 'capture';
    return null;
  }

  function place(el, v) {
    if (!v.isConnected) { el.hidden = true; return; }
    const r = v.getBoundingClientRect();
    el.hidden = r.width < 2 || r.height < 2;
    el.style.left = `${r.left}px`;
    el.style.top = `${r.top}px`;
    el.style.width = `${r.width}px`;
    el.style.height = `${r.height}px`;
  }

  function loop() {
    if (picking) for (const [v, box] of picking.boxes) place(box, v);
    for (const r of recs.values()) place(r.ring, r.video);
    raf = picking || recs.size ? requestAnimationFrame(loop) : 0;
  }

  const startLoop = () => { if (!raf) raf = requestAnimationFrame(loop); };

  // ------------------------------------------------------------ picking ---
  function scan() {
    const seen = new Set();
    for (const v of allMedia('video')) {
      const r = v.getBoundingClientRect();
      if (r.width < 40 || r.height < 30) continue;
      seen.add(v);
      const kind = sourceKind(v);
      let box = picking.boxes.get(v);
      if (box && box.dataset.kind === String(kind)) continue;
      box?.remove();
      box = h('div', {
        class: kind ? 'box' : 'box off',
        title: kind ? '' : L('rec_notReady', "The video hasn't started yet or doesn't expose its stream"),
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); if (kind) choose(v); },
      }, h('span', { class: 'label' }, kind === 'stream' ? L('rec_recordThis', '● Record this video') : kind ? L('rec_recordCapture', '● Record (capture from the player)') : L('rec_notRecordable', "Can't be recorded")));
      box.dataset.kind = String(kind);
      ui.layer.append(box);
      picking.boxes.set(v, box);
    }
    for (const [v, box] of picking.boxes) if (!seen.has(v)) { box.remove(); picking.boxes.delete(v); }
    return [...picking.boxes.values()];
  }

  function onPickKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    post({ type: 'cancelPick' });
    endPick();
  }

  function pick() {
    endPick();
    ensureUI();
    picking = { boxes: new Map() };
    const boxes = scan();
    const usable = boxes.filter((b) => b.dataset.kind !== 'null').length;
    if (usable) {
      picking.banner = h('div', { class: 'banner' },
        h('span', {}, L('rec_pickBanner', 'Fluxy: click the video to record')),
        h('button', { class: 'ghost', onclick: () => { post({ type: 'cancelPick' }); endPick(); } }, L('rec_cancelPick', 'Cancel')));
      ui.root.append(picking.banner);
    }
    picking.scan = setInterval(scan, 1000);
    window.addEventListener('keydown', onPickKey, true);
    startLoop();
    return { usable, total: boxes.length };
  }

  function endPick() {
    if (!picking) return;
    clearInterval(picking.scan);
    for (const box of picking.boxes.values()) box.remove();
    picking.banner?.remove();
    picking = null;
    window.removeEventListener('keydown', onPickKey, true);
    maybeDisposeUI();
  }

  function choose(video) {
    post({ type: 'chosen' });
    endPick();
    openPanel(video);
  }

  // ------------------------------------------------------------ stream ----
  function otherAudio(video) {
    return allMedia('audio, video').filter((m) => m !== video && m.srcObject instanceof MediaStream && m.srcObject.getAudioTracks().some(live));
  }

  function buildStream(video, withOthers) {
    const src = video.srcObject instanceof MediaStream ? video.srcObject : video.captureStream();
    const vt = src.getVideoTracks().find(live) || null;
    const audio = src.getAudioTracks().filter(live);
    if (withOthers) {
      const seen = new Set(audio.map((t) => t.id));
      for (const m of otherAudio(video)) {
        for (const t of m.srcObject.getAudioTracks()) if (live(t) && !seen.has(t.id)) { seen.add(t.id); audio.push(t); }
      }
    }
    // MediaRecorder records a single audio track: several are mixed down.
    let ctx = null;
    let at = audio[0] || null;
    if (audio.length > 1) {
      ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      for (const t of audio) ctx.createMediaStreamSource(new MediaStream([t])).connect(dest);
      at = dest.stream.getAudioTracks()[0];
    }
    const tracks = [vt, at].filter(Boolean);
    if (!tracks.length) throw new Error(L('rec_noTracks', 'The video has no active tracks'));
    return { stream: new MediaStream(tracks), vt, audioCount: audio.length, cleanup: () => ctx?.close().catch(() => {}) };
  }

  function pickMime(stream, target) {
    const video = stream.getVideoTracks().length;
    const list = target === 'mp4'
      ? [...(video ? MIMES_VIDEO_MP4 : MIMES_AUDIO_MP4), ...(video ? MIMES_VIDEO : MIMES_AUDIO)]
      : video ? MIMES_VIDEO : MIMES_AUDIO;
    return list.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  }

  const bitrate = (v) => (v.videoHeight >= 1000 ? 8e6 : v.videoHeight >= 700 ? 5e6 : 2.5e6);

  const fmtClock = (sec) => {
    sec = Math.floor(sec);
    const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = String(sec % 60).padStart(2, '0');
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  };

  const fmtSize = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GB` : `${(b / 1048576).toFixed(1)} MB`).replace('.', ',');

  function fileTitle() {
    let t = '';
    try { t = window.top.document.title; } catch { t = document.title; }
    t = (t || location.hostname || L('recDefaultName', 'recording')).replace(/\s+[-|–·]\s+[^-|–·]{2,40}$/, '').trim();
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${t} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
  }

  // ------------------------------------------------------------- panel ----
  function openPanel(video) {
    ensureUI();
    const rec = {
      rid: `${Date.now().toString(36)}-${++ridSeq}`, video, state: 'ready', jobId: null, mr: null, built: null,
      bytes: 0, t0: 0, chain: Promise.resolve(), discard: false, error: '',
      withOthers: false, ring: h('div', { class: 'ring' }), panel: h('div', { class: 'panel' }),
    };
    const src = video.srcObject instanceof MediaStream ? video.srcObject : null;
    rec.others = otherAudio(video).length;
    rec.withOthers = rec.others > 0 && !(src && src.getAudioTracks().some(live));
    recs.set(rec.rid, rec);
    ui.layer.append(rec.ring);
    ui.stack.append(rec.panel);
    render(rec);
    startLoop();
  }

  function closePanel(rec) {
    clearInterval(rec.timer);
    rec.ring.remove();
    rec.panel.remove();
    recs.delete(rec.rid);
    maybeDisposeUI();
  }

  function render(rec) {
    const v = rec.video;
    const close = h('button', { class: 'x', title: 'Chiudi', onclick: () => closePanel(rec) }, '×');
    const head = h('div', { class: 'head' }, h('span', { class: 'title' }, 'Fluxy'));
    const body = [];
    rec.ring.classList.toggle('rec', rec.state === 'rec');

    if (rec.state === 'ready' || rec.state === 'starting') {
      if (rec.state === 'ready') head.append(close);
      const src = v.srcObject instanceof MediaStream ? v.srcObject : null;
      const hasAudio = src ? src.getAudioTracks().some(live) : true;
      body.push(h('div', { class: 'muted' }, [
        v.videoWidth ? `${L('video', 'Video')} ${v.videoWidth}×${v.videoHeight}` : L('video', 'Video'),
        src ? (hasAudio ? L('rec_withAudio', 'with audio') : L('rec_noAudio', 'without audio')) : L('rec_capture', 'capture from the player'),
      ].join(' · ')));
      if (rec.others) {
        body.push(h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: rec.withOthers, onchange: (e) => { rec.withOthers = e.target.checked; } }),
          h('span', {}, L('rec_addOthers', "Add the audio of the page's other elements ($1)", rec.others))));
      }
      body.push(h('div', { class: 'row' },
        h('span', { class: 'grow muted' }, L('rec_saveHint', 'When you stop, choose where to save the file.')),
        h('button', { class: 'primary', disabled: rec.state === 'starting', onclick: () => start(rec) }, rec.state === 'starting' ? L('rec_starting', 'Starting…') : L('rec_record', '● Record'))));
    } else if (rec.state === 'rec') {
      body.push(h('div', { class: 'row' },
        h('span', { class: 'dot' }),
        h('span', { class: 'clock' }, fmtClock((performance.now() - rec.t0) / 1000)),
        h('span', { class: 'grow muted' }, fmtSize(rec.bytes)),
        h('button', { class: 'link', onclick: () => discard(rec) }, L('rec_cancel', 'cancel')),
        h('button', { class: 'stop', onclick: () => stop(rec) }, L('rec_stop', '■ Stop'))));
    } else {
      head.append(close);
      const text = {
        stopping: L('rec_stopping', 'Closing the recording…'),
        stopped: L('rec_stopped', 'Recording finished: choose where to save the file.'),
        aborted: L('rec_aborted', 'Recording cancelled.'),
        error: rec.error || L('error', 'Error'),
      }[rec.state];
      body.push(h('div', { class: rec.state === 'error' ? 'err' : 'muted' }, text));
    }
    rec.panel.replaceChildren(head, ...body);
  }

  function setState(rec, state, extra = {}) {
    Object.assign(rec, { state }, extra);
    if (state !== 'rec') clearInterval(rec.timer);
    render(rec);
    if (state === 'stopped' || state === 'aborted') setTimeout(() => closePanel(rec), 6000);
  }

  function start(rec) {
    try {
      rec.built = buildStream(rec.video, rec.withOthers);
    } catch (e) {
      setState(rec, 'error', { error: L('rec_cantRecord', "Can't record this video: $1", e.message) });
      return;
    }
    setState(rec, 'starting');
    const v = rec.video;
    post({
      type: 'start', rid: rec.rid, title: fileTitle(),
      describe: [v.videoWidth ? `${v.videoHeight}p` : null, rec.built.audioCount ? `${rec.built.audioCount} audio` : L('rec_noAudio', 'without audio')].filter(Boolean).join(' · '),
    });
  }

  // The job exists: record in the codec that suits the chosen container.
  function begin(rec, target) {
    const mimeType = pickMime(rec.built.stream, target);
    rec.mr = new MediaRecorder(rec.built.stream, { mimeType, videoBitsPerSecond: bitrate(rec.video), audioBitsPerSecond: 160000 });
    rec.mr.ondataavailable = (e) => {
      if (!e.data.size || rec.discard) return;
      rec.bytes += e.data.size;
      rec.chain = rec.chain.then(async () => {
        const buf = await e.data.arrayBuffer();
        post({ type: 'chunk', rid: rec.rid, buf }, [buf]);
      });
    };
    rec.mr.onstop = () => {
      rec.built.cleanup();
      rec.chain.then(() => {
        if (rec.discard) return;
        post({ type: 'stop', rid: rec.rid });
        setState(rec, 'stopped');
      });
    };
    rec.mr.onerror = (e) => { rec.error = e.error?.message || L('rec_recorderError', 'recorder error'); stop(rec); };
    rec.built.vt?.addEventListener('ended', () => stop(rec));
    rec.mr.start(1000);
  }

  function stop(rec) {
    if (rec.mr?.state === 'recording') {
      rec.mr.stop();
      setState(rec, 'stopping');
    }
  }

  function discard(rec) {
    rec.discard = true;
    post({ type: 'discard', rid: rec.rid });
    if (rec.mr?.state === 'recording') rec.mr.stop();
    setState(rec, 'aborted');
  }

  // ------------------------------------------------------------ bridge ----
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.[TAG] !== 'in') return;
    const m = e.data;
    if (m.type === 'pickEnd') { endPick(); return; }
    const rec = recs.get(m.rid);
    if (!rec) return;
    switch (m.type) {
      case 'started':
        rec.jobId = m.jobId;
        try { begin(rec, m.target); } catch (err) {
          rec.discard = true;
          post({ type: 'discard', rid: rec.rid });
          rec.built.cleanup();
          setState(rec, 'error', { error: L('rec_cantStart', "Can't start the recording: $1", err.message) });
          break;
        }
        rec.t0 = performance.now();
        setState(rec, 'rec');
        rec.timer = setInterval(() => render(rec), 500);
        break;
      case 'failed':
        rec.built?.cleanup();
        setState(rec, 'error', { error: m.error });
        break;
      case 'stopReq':
        stop(rec);
        break;
      case 'aborted':
        rec.discard = true;
        if (rec.mr?.state === 'recording') rec.mr.stop();
        setState(rec, m.error ? 'error' : 'aborted', { error: m.error || '' });
        break;
    }
  });

  window[KEY] = { pick };
})();
