// Localised strings for the engine. Uses chrome.i18n where available (background,
// popup); the Chromium offscreen document only has chrome.runtime, so it gets a
// table of these strings from the background with each job (setStrings).

export const ENGINE_KEYS = [
  'eng_cancelled', 'eng_http', 'eng_httpDenied', 'eng_unsupportedEnc', 'eng_notHls', 'eng_emptyPlaylist',
  'eng_unknownSegments', 'eng_noTrack', 'eng_nothingToMux', 'eng_noSpace', 'eng_stageDownload1',
  'eng_stageDownloadN', 'eng_stageSubs', 'eng_stageMux', 'eng_stageSaving', 'stageCancelled', 'stageError',
  'eng_stageRecording', 'eng_stagePreparing', 'eng_stageConverting', 'eng_convertImpossible', 'eng_writeFailed',
  'eng_noData', 'eng_convertFailed', 'stageChooseWhere',
];

let table = null;
export function setStrings(t) { if (t) table = t; }

export function m(key, ...subs) {
  const api = globalThis.chrome?.i18n;
  if (!table && api?.getMessage) {
    const s = api.getMessage(key, subs.map(String));
    if (s) return s;
  }
  let s = table?.[key] ?? key;
  subs.forEach((v, i) => { s = s.split(`$${i + 1}`).join(String(v)); });
  return s;
}

/** The engine strings with literal $1, $2… (for setStrings in another context). */
export function engineStrings() {
  return Object.fromEntries(ENGINE_KEYS.map((k) => [k, chrome.i18n.getMessage(k, ['$1', '$2', '$3'])]));
}
