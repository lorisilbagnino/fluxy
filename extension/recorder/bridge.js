// Fluxy — content-script side of the video recorder (isolated world).
// Relays between page.js (window messages) and the extension: job creation via
// the background, recorded chunks over a port to the engine (offscreen document
// on Chromium, background page on Firefox), stop/cancel requests from the popup.

(() => {
  if (globalThis.__fluxRecBridge) return;

  const TAG = 'fluxy-rec';
  const PORT_PREFIX = 'fluxy-rec:';
  let armed = false;    // the popup started a video pick in this tab
  let allowed = 0;      // videos the user picked in this frame: one recording each
  const recs = new Map();   // rid -> {jobId, port, ended}

  const toPage = (msg) => window.postMessage({ [TAG]: 'in', ...msg }, '*');

  // Port messages are JSON on Chromium: chunks travel as base64.
  function toB64(buf) {
    const u = new Uint8Array(buf);
    if (u.toBase64) return u.toBase64();
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }

  async function start(m) {
    if (allowed <= 0) {
      toPage({ type: 'failed', rid: m.rid, error: chrome.i18n.getMessage('rec_pickAgain') });
      return;
    }
    allowed--;
    let r;
    try { r = await chrome.runtime.sendMessage({ type: 'recStart', title: m.title, describe: m.describe }); }
    catch (e) { r = { error: e.message }; }
    if (!r || r.error) {
      toPage({ type: 'failed', rid: m.rid, error: r?.error || chrome.i18n.getMessage('rec_noAnswer') });
      return;
    }
    const port = chrome.runtime.connect({ name: `${PORT_PREFIX}${r.jobId}:${r.target}` });
    const rec = { jobId: r.jobId, port, ended: false };
    recs.set(m.rid, rec);
    port.onMessage.addListener((msg) => {
      if (msg?.type === 'error') { rec.ended = true; toPage({ type: 'aborted', rid: m.rid, error: msg.error }); }
    });
    port.onDisconnect.addListener(() => {
      recs.delete(m.rid);
      if (!rec.ended) toPage({ type: 'aborted', rid: m.rid });
    });
    toPage({ type: 'started', rid: m.rid, jobId: r.jobId, target: r.target });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.[TAG] !== 'out') return;
    const m = e.data;
    const rec = recs.get(m.rid);
    switch (m.type) {
      case 'chosen':
        if (!armed) return;
        armed = false;
        allowed++;
        chrome.runtime.sendMessage({ type: 'recPickDone' }).catch(() => {});
        break;
      case 'cancelPick':
        armed = false;
        chrome.runtime.sendMessage({ type: 'recPickDone' }).catch(() => {});
        break;
      case 'start': start(m); break;
      case 'chunk': if (rec && !rec.ended && m.buf) rec.port.postMessage({ type: 'chunk', data: toB64(m.buf) }); break;
      case 'stop':
        if (rec && !rec.ended) { rec.ended = true; rec.port.postMessage({ type: 'end' }); }
        break;
      case 'discard':
        if (rec) { rec.ended = true; chrome.runtime.sendMessage({ type: 'cancel', jobId: rec.jobId }).catch(() => {}); }
        break;
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!msg?.fluxRec) return;
    reply({ ok: true });
    if (msg.fluxRec === 'pickEnd') {
      armed = false;
      toPage({ type: 'pickEnd' });
    } else if (msg.fluxRec === 'stop') {
      for (const [rid, r] of recs) if (r.jobId === msg.jobId) toPage({ type: 'stopReq', rid });
    }
  });

  globalThis.__fluxRecBridge = { arm() { armed = true; } };
})();
