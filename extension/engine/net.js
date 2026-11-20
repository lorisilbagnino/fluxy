// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 lorisilbagnino — Fluxy, https://github.com/lorisilbagnino/fluxy (see ADDITIONAL-TERMS.md)
// Network helpers shared by the probe (background) and the download engine.

import { m } from './i18n.js';

// ---- connections -------------------------------------------------------------------------
// Each job has its own pool ("connections per download" setting, shown as active/max in the UI);
// a global cap keeps several jobs together from opening dozens of sockets to the same CDN.
const GLOBAL_MAX = 32;

export function createPool(max) {
  // received: bytes read from the network by this pool (live progress, also while a piece is still arriving)
  return { max: Math.max(1, Math.min(32, max | 0 || 8)), active: 0, queue: [], received: 0 };
}

const globalPool = createPool(GLOBAL_MAX);
const sharedPool = createPool(8);   // requests without a job pool (stream analysis in the background)

async function acquire(pool) {
  while (pool.active >= pool.max) await new Promise((r) => pool.queue.push(r));
  pool.active++;
}

function release(pool) {
  pool.active--;
  if (pool.active < pool.max) pool.queue.shift()?.();
}

/**
 * The server says "too many requests" (429) or is overloaded (503): halve the job's connections and wait
 * longer (Retry-After if given). Some sites ban the IP if a client keeps hammering them.
 */
function slowDown(pool, e, i) {
  // a burst of 429s arrives together: halve once per burst, not once per refused request
  if (pool !== sharedPool && pool.max > 1 && Date.now() - (pool.slowedAt || 0) > 5000) {
    pool.slowedAt = Date.now();
    pool.max = Math.max(1, Math.ceil(pool.max / 2));
    console.warn('[flux] server asks to slow down: connections ->', pool.max);
  }
  const after = Number(e.retryAfter);
  return Math.min(120000, after > 0 ? after * 1000 : 3000 * 2 ** i);
}

async function withSlot(pool, fn) {
  await acquire(pool);
  await acquire(globalPool);
  try { return await fn(); } finally { release(globalPool); release(pool); }
}

// ---- speed limit -------------------------------------------------------------------------
// One token bucket for every download of the engine (bytes per second, 0 = unlimited). It is applied
// while response bodies are read, so a change takes effect immediately, also on running downloads.
let rate = 0;
let tokens = 0;
let last = 0;

export function setSpeedLimit(bytesPerSecond) {
  rate = Math.max(0, Number(bytesPerSecond) || 0);
  tokens = Math.min(tokens, rate);
  last = performance.now();
}

async function take(n, signal) {
  if (!rate) return;
  const now = performance.now();
  tokens = Math.min(rate, tokens + ((now - last) / 1000) * rate);   // at most one second of burst
  last = now;
  tokens -= n;
  if (tokens < 0) await sleep((-tokens / rate) * 1000, signal);
}

export class CancelledError extends Error {
  constructor() { super(m('eng_cancelled')); this.name = 'CancelledError'; }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new CancelledError()); }, { once: true });
});

/** Reads a response body chunk by chunk: speed limit and live byte count (pool.received). */
export async function readBody(r, signal, pool) {
  const reader = r.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await take(value.length, signal);
    if (pool) pool.received += value.length;
    chunks.push(value);
    size += value.length;
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** Throttle for callers that stream a body themselves (direct files without ranges). */
export const throttle = take;

/**
 * fetch + read body, retried as a whole (connections may drop mid-body).
 * opts.pool: the job's connection pool (createPool); the rest goes to fetch().
 */
export async function fetchBytes(url, opts = {}, tries = 6) {
  const { pool = sharedPool, ...init } = opts;
  for (let i = 0; ; i++) {
    if (init.signal?.aborted) throw new CancelledError();
    try {
      return await withSlot(pool, async () => {
        if (init.signal?.aborted) throw new CancelledError();
        const r = await fetch(url, { credentials: 'include', ...init });
        if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status, retryAfter: r.headers.get('retry-after') });
        return readBody(r, init.signal, pool);
      });
    } catch (e) {
      if (init.signal?.aborted || e.name === 'AbortError' || e instanceof CancelledError) throw new CancelledError();
      const fatal = e.status && e.status < 500 && e.status !== 429 && e.status !== 408;
      if (fatal || i >= tries) {
        const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
        const hint = e.status === 403 || e.status === 401 ? m('eng_httpDenied') : '';
        throw new Error(m('eng_http', e.message, host) + hint);
      }
      console.warn('[flux] retry', i + 1, url, e.message);
      await sleep(e.status === 429 || e.status === 503 ? slowDown(pool, e, i) : 400 * 2 ** i, init.signal);
    }
  }
}

export async function fetchText(url, opts) {
  return new TextDecoder().decode(await fetchBytes(url, opts));
}
