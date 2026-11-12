// Offline check of the web extension against a fake Spotify web player page.
// Start a browser with test/launch.sh first, then: node test/fixture.mjs
import assert from 'node:assert/strict';
import { CDP, PORT, extensionId } from './cdp.mjs';

const VERSION = '0.1.1';
const SECRET = 'SECRET-TOKEN-abcdef0123456789';

// A silent WAV of the given length, to stand in for real audio files.
function wav(seconds) {
  const rate = 8000;
  const data = Buffer.alloc(seconds * rate, 0x80);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// Every kind of address the player loads ad audio from.
const AD_URLS = [
  `https://audio-fa.scdn.co/audio/ad-1?token=${SECRET}`,
  'https://audio-ak-spotify-com.akamaized.net/audio/ad-2',
  'https://heads-fa.scdn.co/mp3-ad/ad-3',
  'https://p.scdn.co/mp3/ad-4',
  'https://audio4-ak.spotifycdn.com/audio/ad-5',
  'https://adstudio-assets.scdn.co/ad-6.mp3',
  'https://spclient.wg.spotify.com/ad-logic/ad-7',
  'https://cdn.amillionads.com/ad-8.mp3',
  'https://s0.2mdn.net/ad-9.mp4',
  'https://cdn.adxcel.com/ad-10.mp4'
];

const PAGE = `<!doctype html><title>Spotify Quiet fixture</title>
<body>
<aside data-testadtype="ad-type-none" data-testid="now-playing-bar">now playing</aside>
<div id="leaderboard-ad-element" data-testid="leaderboard-ad-slot">banner</div>
<div id="content" data-testid="track-list">tracks</div>
<script>
const out = window.fixture = { engine: window.__spQuiet?.version || null };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const load = (url, viaAudio) => new Promise(resolve => {
  const element = viaAudio ? new Audio() : document.createElement('video');
  element.addEventListener('loadedmetadata', () => resolve({ element, seconds: Math.round(element.duration * 10) / 10 }));
  element.addEventListener('error', () => resolve({ element, error: element.error?.code ?? 'error' }));
  setTimeout(() => resolve({ element, error: 'timeout' }), 8000);
  element.src = url;
});
(async () => {
  try {
    const bar = document.querySelector('aside');

    // Ad audio, however it is requested, comes back as the one-second clip.
    out.adSeconds = [];
    for (const [index, url] of ${JSON.stringify(AD_URLS)}.entries()) {
      const loaded = await load(url, index === 1);
      out.adSeconds.push(loaded.seconds ?? loaded.error);
    }
    const clip = (await load(${JSON.stringify(AD_URLS[0])})).element;
    clip.play();
    out.clipEnded = await new Promise(resolve => {
      clip.addEventListener('ended', () => resolve(true));
      setTimeout(() => resolve(false), 4000);
    });

    // A podcast file from another host and a music download are left alone.
    out.podcastSeconds = (await load('https://podcasts.example.com/episode.mp3')).seconds;
    out.musicFetch = await (await fetch('https://audio-fa.scdn.co/audio/track-1')).text();

    // An ad whose audio was not swapped is muted and run at top speed, then
    // the element is put back the way it was.
    const live = (await load('https://ads.example.com/long-ad.wav')).element;
    live.muted = false;
    live.playbackRate = 1;
    bar.setAttribute('data-testadtype', 'ad-type-ad');
    live.play();
    const quiet = (await load(${JSON.stringify(AD_URLS[4])})).element;
    quiet.play();
    await sleep(350);
    out.liveAd = { rate: live.playbackRate, muted: live.muted };
    out.swappedDuringAd = { rate: quiet.playbackRate, muted: quiet.muted };
    bar.setAttribute('data-testadtype', 'ad-type-none');
    await sleep(500);
    out.afterAd = { rate: live.playbackRate, muted: live.muted };

    out.bannerDisplay = getComputedStyle(document.getElementById('leaderboard-ad-element')).display;
    out.contentDisplay = getComputedStyle(document.getElementById('content')).display;
    await sleep(1100);
    out.counts = window.__spQuiet ? { ...window.__spQuiet } : null;
    out.nativeLooking = [document.createElement, Audio].every(fn => Function.prototype.toString.call(fn).includes('[native code]'));
  } catch (error) {
    out.error = String(error && error.stack || error);
  }
  out.done = true;
})();
</script>
</body>`;

const cdp = await CDP.connect(PORT);
try {
  const id = await extensionId(cdp);
  const popup = await cdp.open(`chrome-extension://${id}/popup.html`);
  await cdp.poll(`document.querySelector('#toggle')?.disabled === false`, popup.sessionId);
  const setEnabled = async wanted => {
    if ((await cdp.eval(`document.querySelector('#toggle').getAttribute('aria-checked')`, popup.sessionId)) !== String(wanted)) {
      await cdp.eval(`document.querySelector('#toggle').click()`, popup.sessionId);
    }
    await cdp.poll(`!document.querySelector('#toggle').disabled && document.querySelector('#toggle').getAttribute('aria-checked') === '${wanted}'`, popup.sessionId);
  };
  await setEnabled(true);
  await cdp.eval(`document.querySelector('#reset').click()`, popup.sessionId);

  const page = await cdp.open();
  const pageErrors = [];
  const reachedNetwork = [];
  cdp.on('Runtime.exceptionThrown', (params, sessionId) => {
    if (sessionId === page.sessionId) pageErrors.push(params.exceptionDetails.exception?.description || params.exceptionDetails.text);
  });
  cdp.on('Fetch.requestPaused', async (params, sessionId) => {
    if (sessionId !== page.sessionId) return;
    const url = new URL(params.request.url);
    let type = 'audio/wav';
    let body;
    if (url.pathname.startsWith('/__quiet_fixture')) { type = 'text/html'; body = Buffer.from(PAGE); }
    else if (url.host === 'podcasts.example.com') body = wav(2);
    else if (url.host === 'ads.example.com') body = wav(8);
    else if (url.pathname === '/audio/track-1') { type = 'application/octet-stream'; body = Buffer.from('TRACK'); }
    else {
      // An ad file that was not swapped by the extension: it got this far.
      reachedNetwork.push(`${params.resourceType} ${url.host}${url.pathname}`);
      body = wav(2);
    }
    await cdp.send('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Access-Control-Allow-Origin', value: '*' }],
      body: body.toString('base64')
    }, sessionId).catch(() => {});
  });
  await cdp.send('Network.enable', {}, page.sessionId);
  await cdp.send('Network.setBypassServiceWorker', { bypass: true }, page.sessionId);
  await cdp.send('Fetch.enable', { patterns: [
    { urlPattern: 'https://open.spotify.com/__quiet_fixture*' },
    { urlPattern: 'https://podcasts.example.com/*' },
    { urlPattern: 'https://ads.example.com/*' },
    ...[...new Set(AD_URLS.map(url => new URL(url).host))].map(host => ({ urlPattern: `https://${host}/*` }))
  ] }, page.sessionId);

  const load = async url => {
    await cdp.send('Page.navigate', { url }, page.sessionId);
    await cdp.poll(`window.fixture?.done && location.href === ${JSON.stringify(url)}`, page.sessionId, 60000).catch(async error => {
      console.log('page state:', JSON.stringify(await cdp.eval('({ fixture: window.fixture, title: document.title })', page.sessionId)), pageErrors);
      throw error;
    });
    return cdp.eval('window.fixture', page.sessionId);
  };

  // ---- filtering on
  const on = await load('https://open.spotify.com/__quiet_fixture');
  console.log('ON ', JSON.stringify(on));
  assert.equal(on.error, undefined);
  assert.equal(on.engine, VERSION);
  assert.deepEqual(on.adSeconds, AD_URLS.map(() => 1), 'every ad file must come back as the one-second clip');
  assert.deepEqual(reachedNetwork, [], 'an ad file got past the rules');
  assert.equal(on.clipEnded, true);
  assert.equal(on.podcastSeconds, 2, 'a podcast file must not be swapped');
  assert.equal(on.musicFetch, 'TRACK', 'a music download must not be touched');
  assert.deepEqual(on.liveAd, { rate: 16, muted: true });
  assert.deepEqual(on.swappedDuringAd, { rate: 1, muted: false }, 'the silent clip itself is left alone');
  assert.deepEqual(on.afterAd, { rate: 1, muted: false });
  assert.equal(on.bannerDisplay, 'none');
  assert.notEqual(on.contentDisplay, 'none');
  assert.equal(on.nativeLooking, true);
  assert.deepEqual(on.counts, { version: VERSION, ads: 1, sped: 1 });

  // The report reaches the popup, describes what happened, and holds no tokens.
  const text = await cdp.eval(`chrome.tabs.query({ url: 'https://open.spotify.com/*' }).then(tabs => chrome.tabs.sendMessage(tabs[0].id, { type: 'report' })).then(answer => answer.report)`, popup.sessionId);
  const report = JSON.parse(text);
  console.log('REPORT', text.length, 'chars;', JSON.stringify(report.media.slice(0, 3)), JSON.stringify(report.events));
  assert.equal(report.spotifyQuietReport, 1);
  assert.equal(report.where, 'web');
  assert.deepEqual(report.media[0], { t: report.media[0].t, tag: 'video', from: 'audio-fa.scdn.co/audio', seconds: 1, ad: 'ad-type-none' });
  assert.equal(report.media[1].tag, 'audio');
  assert(report.media.some(entry => entry.from === 'podcasts.example.com/…' && entry.seconds === 2));
  assert.deepEqual(report.adTypes.map(entry => entry.type), ['ad-type-none', 'ad-type-ad', 'ad-type-none']);
  assert.deepEqual(report.events.map(event => event.type), ['ad-start', 'ad-sped', 'ad-end']);
  assert.deepEqual(report.testidsWithAd.map(entry => entry[0]), ['leaderboard-ad-slot']);
  assert(!text.includes('SECRET-TOKEN'), 'report leaked a token');

  // Counts reach the popup.
  await cdp.send('Page.reload', {}, popup.sessionId);
  await cdp.poll(`document.querySelector('#toggle')?.disabled === false`, popup.sessionId);
  const shown = await cdp.eval(`[document.querySelector('#ads').textContent, document.querySelector('#sped').textContent]`, popup.sessionId);
  assert.deepEqual(shown, ['1', '1'], `popup shows ${shown}`);

  // ---- filtering off: ad files load normally and nothing is watched
  await setEnabled(false);
  const off = await load('https://open.spotify.com/__quiet_fixture?off');
  console.log('OFF', JSON.stringify(off));
  assert.equal(off.engine, null);
  assert.deepEqual(off.adSeconds, AD_URLS.map(() => 2));
  assert.equal(reachedNetwork.length, AD_URLS.length + 2);
  assert.deepEqual(off.liveAd, { rate: 1, muted: false });
  assert.notEqual(off.bannerDisplay, 'none');

  await setEnabled(true);
  await cdp.send('Target.closeTarget', { targetId: page.targetId });
  await cdp.send('Target.closeTarget', { targetId: popup.targetId });
  console.log('\nfixture: all checks passed');
} finally {
  cdp.close();
}
