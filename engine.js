// Spotify Quiet engine for the web player. Runs in the page's own JavaScript
// world at document_start.
//
// The web player streams music through fetch() into a decoder, but it plays
// ads as plain media files. rules.json swaps those files for one second of
// silence, so an ad break still "happens" but lasts a second and makes no
// sound. This script covers what the rules cannot:
//
//   1. It watches the player's own ad flag, and if an ad's audio got past the
//      rules it mutes it and runs it at top speed.
//   2. It keeps a diagnostics log (hosts, durations and UI markers only, no
//      tokens or account data) that the popup can copy out.
(() => {
  'use strict';
  if (window.__spQuiet) return;

  const state = { version: '0.1.0', ads: 0, sped: 0 };
  Object.defineProperty(window, '__spQuiet', { value: state });

  const native = {
    stringify: JSON.stringify,
    setTimeout: window.setTimeout.bind(window),
    URL,
    now: () => Math.round(performance.now())
  };

  function report(kind) {
    state[kind]++;
    try {
      document.dispatchEvent(new CustomEvent('sq-count', { detail: `${kind}:1` }));
    } catch { /* counting is best effort */ }
  }

  // ------------------------------------------------------------ diagnostics

  const diag = { events: [], media: [], testids: new Map(), adTypes: [] };

  function note(type, data) {
    if (diag.events.length >= 200) return;
    diag.events.push({ t: native.now(), type, ...data });
  }

  // Where a media file came from, without the file name or its token.
  function describeSource(raw) {
    if (!raw) return 'none';
    if (raw.startsWith('blob:')) return 'blob';
    if (raw.startsWith('data:')) return 'data';
    try {
      const url = new native.URL(raw);
      const folder = url.pathname.split('/')[1] || '';
      return `${url.host}/${/^[A-Za-z0-9_-]{1,24}$/.test(folder) ? folder : '…'}`;
    } catch {
      return 'unknown';
    }
  }

  // -------------------------------------------------------- the ad flag

  // The now-playing bar carries data-testadtype="ad-type-ad" during an ad.
  const adMarker = () => document.querySelector('[data-testadtype]')?.getAttribute('data-testadtype') || null;
  const adPlaying = () => adMarker() === 'ad-type-ad';

  // ---------------------------------------------------- media elements

  // The player creates its <video> and <audio> elements off-page, so they
  // cannot be found with a selector. Remember each one as it is made.
  const players = new Set();
  const SILENT_CLIP_SECONDS = 1.5;
  const AD_RATE = 16;
  const ad = { active: false, startedAt: 0, restore: new Map() };

  function track(element) {
    if (players.has(element)) return;
    players.add(element);
    element.addEventListener('loadedmetadata', () => {
      const entry = {
        t: native.now(),
        tag: element.localName,
        from: describeSource(element.currentSrc),
        seconds: Number.isFinite(element.duration) ? Math.round(element.duration * 10) / 10 : null,
        ad: adMarker()
      };
      diag.media.push(entry);
      if (diag.media.length > 80) diag.media.shift();
    });
    element.addEventListener('error', () => {
      note('media-error', { from: describeSource(element.currentSrc), code: element.error?.code ?? null, ad: adMarker() });
    });
  }

  Document.prototype.createElement = new Proxy(Document.prototype.createElement, {
    apply(target, self, args) {
      const element = Reflect.apply(target, self, args);
      try { if (element instanceof HTMLMediaElement) track(element); } catch { /* not a media element */ }
      return element;
    }
  });
  window.Audio = new Proxy(window.Audio, {
    construct(target, args, newTarget) {
      const element = Reflect.construct(target, args, newTarget);
      try { track(element); } catch { /* keep the element usable */ }
      return element;
    }
  });

  // An ad whose file was not swapped: real, audible, and longer than the clip.
  const isLiveAd = element =>
    !element.paused && !element.ended && Boolean(element.currentSrc) && !element.currentSrc.startsWith('blob:') &&
    Number.isFinite(element.duration) && element.duration > SILENT_CLIP_SECONDS;

  function watchAds() {
    if (adPlaying()) {
      if (!ad.active) {
        ad.active = true;
        ad.startedAt = native.now();
        report('ads');
        note('ad-start', {});
      }
      for (const element of players) {
        if (!isLiveAd(element) && !ad.restore.has(element)) continue;
        if (!ad.restore.has(element)) {
          ad.restore.set(element, { rate: element.playbackRate, muted: element.muted });
          report('sped');
          note('ad-sped', { from: describeSource(element.currentSrc), seconds: Math.round(element.duration) });
        }
        if (!isLiveAd(element)) continue;
        if (!element.muted) element.muted = true;
        if (element.playbackRate !== AD_RATE) {
          try { element.playbackRate = AD_RATE; } catch { /* keep it muted at least */ }
        }
      }
      return;
    }

    if (ad.active) {
      ad.active = false;
      note('ad-end', { ms: native.now() - ad.startedAt });
      for (const [element, before] of ad.restore) {
        try {
          element.playbackRate = before.rate || 1;
          element.muted = before.muted;
        } catch { /* the element is gone */ }
      }
      ad.restore.clear();
    }
  }

  // Remember the player's UI markers that look ad-related, with when each
  // first appeared, so a report shows what Spotify calls its ad slots.
  let lastScan = -Infinity;
  let lastAdType = null;
  function observe() {
    const now = native.now();
    const type = adMarker();
    if (type !== lastAdType) {
      lastAdType = type;
      if (diag.adTypes.length < 80) diag.adTypes.push({ t: now, type });
    }
    if (now - lastScan < 1000) return;
    lastScan = now;
    for (const node of document.querySelectorAll('[data-testid]')) {
      const name = node.getAttribute('data-testid');
      if (diag.testids.size < 500 && !diag.testids.has(name)) diag.testids.set(name, now);
    }
  }

  function pass() {
    try { watchAds(); } catch { /* keep the watchdog alive */ }
    try { observe(); } catch { /* keep the watchdog alive */ }
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    native.setTimeout(() => {
      scheduled = false;
      pass();
    }, 50);
  }

  function startWatchdog() {
    new MutationObserver(schedule).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-testadtype']
    });
    setInterval(pass, 250);
  }
  if (document.documentElement) startWatchdog();
  else document.addEventListener('readystatechange', startWatchdog, { once: true });

  // ---------------------------------------------------- report for the popup

  const AD_WORDS = /(^|[-_])ads?([-_]|$)|advert|billboard|leaderboard|hpto|sponsor|takeover|upsell|promo/i;

  function buildReport() {
    const testids = Object.fromEntries(diag.testids);
    return native.stringify({
      spotifyQuietReport: 1,
      version: state.version,
      where: 'web',
      uptimeMs: native.now(),
      counts: { ads: state.ads, sped: state.sped },
      adNow: adPlaying(),
      adTypes: diag.adTypes,
      events: diag.events,
      media: diag.media,
      players: [...players].map(element => ({
        tag: element.localName,
        from: describeSource(element.currentSrc),
        seconds: Number.isFinite(element.duration) ? Math.round(element.duration * 10) / 10 : null,
        t: Math.round(element.currentTime * 10) / 10,
        rate: element.playbackRate,
        muted: element.muted,
        paused: element.paused
      })).slice(0, 12),
      testidsWithAd: Object.keys(testids).filter(name => AD_WORDS.test(name)).map(name => [name, testids[name]]),
      testidCount: diag.testids.size
    });
  }

  document.addEventListener('sq-report-request', () => {
    let text;
    try { text = buildReport(); } catch (error) { text = native.stringify({ spotifyQuietReport: 1, error: String(error) }); }
    document.dispatchEvent(new CustomEvent('sq-report', { detail: text }));
  });
})();
