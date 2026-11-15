// Network helpers shared by the probe (background) and the download engine.

// One connection budget shared by every track of every job: servers tend to
// reset connections when a client opens dozens at once.
let maxConn = 8;
let slots = 8;
const queue = [];

export function setMaxConnections(n) {
  n = Math.max(1, Math.min(32, n | 0 || 8));
  slots += n - maxConn;
  maxConn = n;
  pump();
}

function pump() { while (slots > 0 && queue.length) { slots--; queue.shift()(); } }

async function withSlot(fn) {
  await new Promise((r) => { queue.push(r); pump(); });
  try { return await fn(); } finally { slots++; pump(); }
}

export class CancelledError extends Error {
  constructor() { super('Annullato'); this.name = 'CancelledError'; }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new CancelledError()); }, { once: true });
});

/** fetch + read body, retried as a whole (connections may drop mid-body). */
export async function fetchBytes(url, opts = {}, tries = 6) {
  for (let i = 0; ; i++) {
    if (opts.signal?.aborted) throw new CancelledError();
    try {
      return await withSlot(async () => {
        if (opts.signal?.aborted) throw new CancelledError();
        const r = await fetch(url, { credentials: 'include', ...opts });
        if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
        return new Uint8Array(await r.arrayBuffer());
      });
    } catch (e) {
      if (opts.signal?.aborted || e.name === 'AbortError' || e instanceof CancelledError) throw new CancelledError();
      const fatal = e.status && e.status < 500 && e.status !== 429 && e.status !== 408;
      if (fatal || i >= tries) {
        const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
        const hint = e.status === 403 || e.status === 401 ? ' — il server rifiuta la richiesta: riapri la pagina e premi Rileva per aggiornare i permessi' : '';
        throw new Error(`${e.message} da ${host}${hint}`);
      }
      console.warn('[flux] retry', i + 1, url, e.message);
      await sleep(400 * 2 ** i, opts.signal);
    }
  }
}

export async function fetchText(url, opts) {
  return new TextDecoder().decode(await fetchBytes(url, opts));
}
