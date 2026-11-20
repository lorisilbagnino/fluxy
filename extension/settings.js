// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 lorisilbagnino — Fluxy, https://github.com/lorisilbagnino/fluxy (see ADDITIONAL-TERMS.md)
// Settings form shared by the popup and the Fluxy page: one markup, one behaviour, so the two can't drift.

import { DEFAULT_SETTINGS } from './shared.js';
import { t, translate, send, el, listFmt } from './ui.js';

const HTML = `
  <div class="field">
    <span class="field-title" data-i18n="engine"></span>
    <label class="choice">
      <input type="radio" name="engine" value="browser">
      <span><span data-i18n="engineBrowser"></span>
        <small data-i18n="engineBrowserHelp"></small></span>
    </label>
    <label class="choice">
      <input type="radio" name="engine" value="native">
      <span><span data-i18n="engineNative"></span>
        <small data-i18n="engineNativeHelp"></small></span>
    </label>
  </div>
  <div class="subpanel">
    <div class="native-status">
      <span data-s="native-text" class="muted">…</span>
      <button data-s="verify" class="link" data-i18n="verify"></button>
      <button data-s="install" class="ghost" data-i18n="installLocalApp"></button>
    </div>
    <div data-s="install-help" class="install-help" hidden></div>
    <label data-s="dir-field"><span data-i18n="outputDir"></span>
      <input data-s="dir" type="text" spellcheck="false">
    </label>
  </div>
  <div class="row three">
    <label><span data-i18n="defaultFormat"></span>
      <select data-s="container"><option value="mkv">MKV</option><option value="mp4">MP4</option></select>
    </label>
    <label><span data-i18n="maxJobs"></span>
      <input data-s="maxJobs" type="number" min="1" max="10">
    </label>
    <label><span data-i18n="parallel"></span>
      <input data-s="fragments" type="number" min="1" max="32">
    </label>
  </div>
  <p data-s="load-warn" class="load-warn" hidden></p>
  <label><span data-i18n="speedLimit"></span>
    <input data-s="speedLimit" type="number" min="0" step="0.5">
    <small class="help" data-i18n="speedLimitHelp"></small>
  </label>
  <label class="check">
    <input data-s="auto" type="checkbox">
    <span><span data-i18n="autoDetect"></span>
      <small data-i18n="autoDetectHelp"></small></span>
  </label>
  <label><span data-i18n="prefLangs"></span>
    <input data-s="langs" type="text" placeholder="en, it" spellcheck="false">
  </label>`;

/**
 * Builds the settings form inside `root` and keeps it in sync with chrome.storage (changes made in
 * the popup show up in the page and vice versa). onChange(settings) runs after every change.
 */
export async function mountSettings(root, { onChange } = {}) {
  root.insertAdjacentHTML('afterbegin', HTML);
  translate(root);
  const q = (k) => root.querySelector(`[data-s="${k}"]`);
  const radios = [...root.querySelectorAll('input[name=engine]')];
  let settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get('settings')).settings };
  let host = (await chrome.storage.session.get('host')).host || null;

  const fill = () => {
    const focused = root.ownerDocument.activeElement;
    for (const r of radios) r.checked = r.value === settings.engine;
    const set = (k, prop, v) => { if (q(k) !== focused) q(k)[prop] = v; };
    set('dir', 'value', settings.outputDir);
    set('container', 'value', settings.container);
    set('fragments', 'value', settings.fragments);
    set('maxJobs', 'value', settings.maxJobs);
    set('speedLimit', 'value', settings.speedLimit || 0);
    set('langs', 'value', settings.langs);
    set('auto', 'checked', !!settings.autoDetect);
    q('dir-field').hidden = settings.engine !== 'native';
    loadWarn();
  };

  // Many downloads × many connections hit the same site at once: some providers ban the IP for it.
  const loadWarn = () => {
    const jobs = Math.max(1, parseInt(q('maxJobs').value, 10) || 1);
    const conns = Math.max(1, parseInt(q('fragments').value, 10) || 1);
    const total = jobs * conns;
    const box = q('load-warn');
    box.hidden = !(total > 16 || jobs > 3 || conns > 12);
    if (!box.hidden) box.textContent = t('loadWarn', String(total));
  };
  for (const k of ['maxJobs', 'fragments']) q(k).addEventListener('input', loadWarn);

  const save = (partial) => {
    settings = {
      ...settings,   // keeps keys this form doesn't show
      engine: root.querySelector('input[name=engine]:checked')?.value || 'browser',
      outputDir: q('dir').value.trim() || DEFAULT_SETTINGS.outputDir,
      container: q('container').value,
      fragments: Math.min(32, Math.max(1, parseInt(q('fragments').value, 10) || 8)),
      maxJobs: Math.min(10, Math.max(1, parseInt(q('maxJobs').value, 10) || DEFAULT_SETTINGS.maxJobs)),
      speedLimit: Math.max(0, Math.round((parseFloat(String(q('speedLimit').value).replace(',', '.')) || 0) * 10) / 10),
      langs: q('langs').value,
      autoDetect: q('auto').checked,
      ...partial,
    };
    chrome.storage.local.set({ settings });
    fill();
    if (settings.engine === 'native') send({ type: 'hostCheck' });
    onChange?.(settings);
  };

  const renderNative = () => {
    const txt = q('native-text');
    txt.className = '';
    if (!host) txt.textContent = t('appNotChecked');
    else if (host.status === 'ok') {
      const missing = [!host.ffmpeg && 'ffmpeg', !host.ytdlp && 'yt-dlp'].filter(Boolean);
      txt.textContent = missing.length ? t('appMissingTools', listFmt(missing)) : t('appReady', host.version);
      txt.className = missing.length ? 'bad' : 'ok';
    } else {
      txt.textContent = host.status === 'missing' ? t('appNotInstalled') : t('appCommError');
      txt.className = 'bad';
    }
    txt.title = host?.status === 'ok' ? `${host.ffmpeg || `ffmpeg ${t('missing')}`}\nyt-dlp ${host.ytdlp || t('missing')}` : (host?.error || '');
    q('install').hidden = host?.status === 'ok' && host.ffmpeg && host.ytdlp;
  };

  const install = async () => {
    const help = q('install-help');
    q('install').disabled = true;
    help.hidden = false;
    help.replaceChildren(t('preparingInstaller'));
    const r = await send({ type: 'installer' });
    q('install').disabled = false;
    if (r?.error) { help.replaceChildren(el('span', { class: 'err' }, r.error)); return; }
    const cmd = `bash '${r.path.replace(/'/g, `'\\''`)}'`;
    const copy = el('button', { class: 'link', onclick: async () => { await navigator.clipboard.writeText(cmd); copy.textContent = t('copied'); } }, t('copyCommand'));
    help.replaceChildren(
      el('span', {}, t('installerSaved')),
      el('code', {}, cmd),
      el('span', { class: 'muted' }, t('installerExplain')),
      el('div', { class: 'row-actions' }, copy, el('button', { class: 'link', onclick: () => send({ type: 'hostCheck' }) }, t('doneVerify'))),
    );
  };

  fill();
  renderNative();
  for (const r of radios) r.addEventListener('change', () => save());
  for (const k of ['dir', 'container', 'maxJobs', 'fragments', 'speedLimit', 'langs', 'auto']) q(k).addEventListener('change', () => save());
  q('install').addEventListener('click', install);
  q('verify').addEventListener('click', () => send({ type: 'hostCheck' }));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
      fill();
      onChange?.(settings);
    }
    if (area === 'session' && changes.host) { host = changes.host.newValue || null; renderNative(); }
  });

  return {
    get: () => settings,
    set: (partial) => { for (const r of radios) r.checked = r.value === (partial.engine ?? settings.engine); save(partial); },
    focusInstall: () => q('install').focus(),
  };
}
