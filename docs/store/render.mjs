#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 lorisilbagnino — Fluxy, https://github.com/lorisilbagnino/fluxy (see ADDITIONAL-TERMS.md)
// Renders docs/store/src/*.html to docs/store/images/<lang>/*.png (en, it) with a headless Chromium browser
// (DevTools protocol). Size comes from the file name (…-WxH.html), default 1280×800.
// Usage: node docs/store/render.mjs [name-filter]      Texts: src/strings.js
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const which = (c) => { try { return execSync(`command -v ${c}`, { shell: '/bin/sh' }).toString().trim(); } catch { return null; } };
const browser = process.env.BROWSER || ['brave-origin', 'brave', 'chromium', 'google-chrome'].map(which).find(Boolean);
if (!browser) throw new Error('Chromium-based browser not found (set BROWSER)');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxy-render-'));
const port = 9400 + Math.floor(Math.random() * 400);
const proc = spawn(browser, ['--headless=new', '--no-first-run', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ver;
for (let i = 0; i < 50 && !ver; i++) { await sleep(200); ver = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null); }
const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
let id = 0; const wait = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
const call = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; wait.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

try {
  const files = fs.readdirSync(path.join(here, 'src')).filter((f) => f.endsWith('.html') && f.includes(process.argv[2] || ''));
  for (const lang of ['en', 'it']) for (const f of files.sort()) {
    fs.mkdirSync(path.join(here, 'images', lang), { recursive: true });
    const name = f.replace(/\.html$/, '');
    const m = name.match(/-(\d+)x(\d+)$/);
    const [width, height] = m ? [+m[1], +m[2]] : [1280, 800];
    const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
    const sid = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sid);
    await call('Page.enable', {}, sid);
    await call('Page.navigate', { url: `file://${path.join(here, 'src', f)}?lang=${lang}` }, sid);
    await call('Runtime.evaluate', { expression: 'new Promise(r => (document.readyState === "complete" ? r() : addEventListener("load", r))).then(() => document.fonts.ready).then(() => new Promise(r => setTimeout(r, 300)))', awaitPromise: true }, sid);
    const shot = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } }, sid);
    fs.writeFileSync(path.join(here, 'images', lang, `${name}.png`), Buffer.from(shot.data, 'base64'));
    await call('Target.closeTarget', { targetId });
    console.log(`✓ images/${lang}/${name}.png (${width}×${height})`);
  }
} finally {
  ws.close(); proc.kill(); await sleep(300); fs.rmSync(profile, { recursive: true, force: true });
}
