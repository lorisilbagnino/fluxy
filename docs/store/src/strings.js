// Texts of the store images. Each page shows ?lang=en|it (default en):
// [data-t] gets the string as HTML, [data-img] gets "{lang}" replaced in its src.
const STRINGS = {
  // screenshot 1 — popup over a (made-up) video page
  s1_h1: ['Pick video, audio and <em>subtitles</em>.', 'Scegli video, audio e <em>sottotitoli</em>.'],
  s1_lead: ['Fluxy finds the page\'s streams and shows you every track: quality, languages, formats. You choose, it saves everything into one file.',
    'Fluxy trova gli stream della pagina e ti mostra ogni traccia: qualità, lingue, formati. Tu scegli, lui salva tutto in un solo file.'],
  s1_c1: ['Up to 1080p and beyond', 'Fino a 1080p e oltre'],
  s1_c2: ['Several audio languages', 'Più lingue audio'],
  s1_c3: ['Subtitles, forced too', 'Sottotitoli e forced'],
  s1_url: ['example.tv/documentaries/dolomites', 'esempio.tv/documentari/dolomiti'],
  film: ['Dolomites, the light of sunset', 'Dolomiti, la luce del tramonto'],
  s1_sub: ['Documentary · 1 h 52 min', 'Documentario · 1 h 52 min'],
  // screenshot 2 — three streams, one file
  s2_h1: ['Three streams, <em>one file</em>.', 'Tre flussi, <em>un file</em>.'],
  s2_lead: ['Adaptive streams arrive in pieces: the picture, each audio language and each subtitle separately, in hundreds of segments. Fluxy puts them back together.',
    'Gli stream adattivi arrivano a pezzi: video, ogni lingua audio e ogni sottotitolo separati, in centinaia di segmenti. Fluxy li ricompone.'],
  video: ['Video', 'Video'],
  audio: ['Audio', 'Audio'],
  subtitles: ['Subtitles', 'Sottotitoli'],
  s2_audio: ['Italian · English 5.1', 'Italiano · English 5.1'],
  s2_subs: ['Italian · forced', 'Italiano · forced'],
  s2_file: ['Dolomites.mkv', 'Dolomiti.mkv'],
  s2_i2: ['Audio Italian (default)', 'Audio Italiano (predefinito)'],
  s2_i4: ['Subtitles Italian', 'Sottotitoli Italiano'],
  s2_i5: ['Subtitles Italian (forced)', 'Sottotitoli Italiano (forced)'],
  s2_note: ['<b>No re-encoding:</b> data is copied as is. Original quality, merged in seconds.',
    '<b>Nessuna ricodifica:</b> i dati vengono copiati così come sono. Qualità originale, unione in pochi secondi.'],
  // screenshot 3 — how it works
  s3_h1: ['Three steps, <em>nothing to install</em>.', 'Tre passi, <em>niente da installare</em>.'],
  s3_lead: ['Fluxy only works when you ask, on the tab you choose.', 'Fluxy lavora solo quando glielo chiedi, sulla scheda che scegli.'],
  s3_t1: ['Detect', 'Rileva'],
  s3_p1: ['Open the video page and press <b>Detect</b>: the page reloads and Fluxy catches the player\'s streams.',
    'Apri la pagina del video e premi <b>Rileva</b>: la pagina si ricarica e Fluxy intercetta gli stream del player.'],
  s3_live: ['Detection active', 'Rilevamento attivo'],
  s3_btn1: ['⟳ Detect', '⟳ Rileva'],
  s3_t2: ['Choose', 'Scegli'],
  s3_p2: ['Video quality, audio languages, subtitles. Your preferred languages are already selected.',
    'Qualità del video, lingue dell\'audio, sottotitoli. Le tue lingue preferite sono già selezionate.'],
  s3_r2: ['English · AAC 2.0', 'Italiano · AAC 2.0'],
  s3_t3: ['Download', 'Scarica'],
  s3_p3: ['Parallel segments, merging without re-encoding, final file in your Downloads folder.',
    'Segmenti in parallelo, unione senza ricodifica, file finale nella cartella Download.'],
  s3_name: ['Dolomites', 'Dolomiti'],
  s3_btn3: ['Download', 'Scarica'],
  // screenshot 4 — engines
  s4_h1: ['All in the browser.<br><em>Or with the local app.</em>', 'Tutto nel browser.<br><em>O con l\'app locale.</em>'],
  s4_lead: ['By default Fluxy downloads and merges everything inside the extension. Need more? One click prepares the install of ffmpeg and yt-dlp.',
    'Di base Fluxy scarica e unisce tutto dentro l\'estensione. Se ti serve di più, un clic prepara l\'installazione di ffmpeg e yt-dlp.'],
  s4_tag1: ['default', 'predefinito'],
  s4_h1a: ['In the browser', 'Nel browser'],
  s4_l1: ['<li>Nothing to install</li><li>HLS, AES-128 encrypted too</li><li>MKV or MP4 in Downloads</li><li>No data sent to external servers</li>',
    '<li>Niente da installare</li><li>HLS, anche cifrato AES-128</li><li>MKV o MP4 in Download</li><li>Nessun dato inviato a server esterni</li>'],
  s4_tag2: ['optional', 'facoltativa'],
  s4_h1b: ['Local app', 'App locale'],
  s4_l2: ['<li>DASH too</li><li>Any destination folder</li><li>Merging with ffmpeg</li><li>One-click Linux installer</li>',
    '<li>Anche DASH</li><li>Cartella di destinazione a scelta</li><li>Unione con ffmpeg</li><li>Installer per Linux in un clic</li>'],
  // screenshot 5 — speed
  s5_h1: ['Fast, <em>no quality loss</em>.', 'Veloce, <em>senza perdere qualità</em>.'],
  s5_f1: ['<b>Parallel segments</b>, with automatic retries if the connection drops.',
    '<b>Segmenti in parallelo</b>, con nuovi tentativi automatici se la connessione cade.'],
  s5_f2: ['<b>Copy, not re-encode</b>: merging a film takes seconds and the file stays identical to the original.',
    '<b>Copia, non ricodifica</b>: l\'unione di un film richiede secondi e il file resta identico all\'originale.'],
  s5_f3: ['<b>Languages and default tracks already set</b>: the file opens ready in any player.',
    '<b>Lingue e tracce predefinite già impostate</b>: il file si apre pronto in qualsiasi player.'],
  s5_f4: ['<b>No tracking</b>: no account, no analytics, no Fluxy servers.',
    '<b>Nessun tracciamento</b>: niente account, niente statistiche, nessun server di Fluxy.'],
  // promo tiles
  tagline: ['Three streams, <b>one file</b>.', 'Tre flussi, <b>un file</b>.'],
  m_lead: ['Save HLS and DASH streams as one <b style="color:var(--text)">MKV or MP4</b>, with the languages and subtitles you pick. <em style="font-style:normal;color:var(--accent)">No re-encoding.</em>',
    'Salva gli stream HLS e DASH in un unico <b style="color:var(--text)">MKV o MP4</b>, con le lingue e i sottotitoli che scegli. <em style="font-style:normal;color:var(--accent)">Senza ricodifica.</em>'],
  m_subs: ['subtitles', 'sottotitoli'],
  sp_open: ['Free', 'Gratuito'],
};

(() => {
  const lang = new URLSearchParams(location.search).get('lang') === 'it' ? 'it' : 'en';
  const i = lang === 'it' ? 1 : 0;
  document.documentElement.lang = lang;
  for (const n of document.querySelectorAll('[data-t]')) n.innerHTML = STRINGS[n.dataset.t]?.[i] ?? `?${n.dataset.t}?`;
  for (const n of document.querySelectorAll('[data-img]')) n.src = n.dataset.img.replace('{lang}', lang);
})();
