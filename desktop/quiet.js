// Spotify Quiet for the desktop app. The launcher (the Mac app, or launch.mjs)
// loads this into the app's own UI page; nothing inside Spotify.app is changed.
//
// The desktop app plays ads from its native core, which the UI steers through
// a set of internal services: ad slots (stream, podcast, home page promo and so
// on), per-slot settings, and the account's ad flag. This script uses those
// same services to switch every slot off:
//
//   1. each slot is disabled, pointed at an address that serves nothing, and
//      emptied, and it is emptied again whenever the core refills it;
//   2. the listening clock that decides when an ad break is due is wound back;
//   3. the account's local "ads" flag is set to off.
//
// Services are found by their published service names, not by build-specific
// module numbers, so this keeps working across app updates as long as Spotify
// keeps the services themselves.
(() => {
  'use strict';
  if (window.__spQuiet) return;

  const state = {
    version: '0.1.1',
    where: 'desktop',
    ready: false,
    passes: 0,
    slotsSeen: 0,
    emptied: 0,
    errors: []
  };
  Object.defineProperty(window, '__spQuiet', { value: state });

  const SERVICE = {
    slots: 'spotify.ads.esperanto.proto.Slots',
    settings: 'spotify.ads.esperanto.proto.Settings',
    testing: 'spotify.ads.esperanto.proto.Testing',
    adState: 'spotify.ads.esperanto.proto.State',
    productState: 'spotify.product_state.esperanto.proto.ProductState'
  };
  // Nothing listens on the discard port, so ad requests fail at once.
  const NOWHERE = 'http://localhost:9/spotify-quiet';
  const REWIND_SECONDS = -100000000000;
  const REAPPLY_MS = 60000;

  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

  function fail(step, error) {
    if (state.errors.length >= 20) return;
    state.errors.push({ t: Math.round(performance.now()), step, message: String(error?.message || error).slice(0, 160) });
  }

  // ------------------------------------------------------------ discovery

  // The app's code is split into modules behind a loader. Asking the loader's
  // queue for a chunk with no modules hands back the loader's own require().
  function getRequire() {
    const queue = window.rspackChunk || window.webpackChunkclient_web || window.rspackChunkclient_web;
    if (!Array.isArray(queue)) return null;
    let require = null;
    try { queue.push([[Symbol('spotify-quiet')], {}, loader => { require = loader; }]); } catch { return null; }
    return require && require.m ? require : null;
  }

  // Finds the service classes and the connection they talk over. Only modules
  // whose source mentions what we need are opened, and by this point the app
  // has already loaded them, so nothing new is executed.
  function discover() {
    const require = getRequire();
    if (!require) return null;
    const source = id => {
      try { return Function.prototype.toString.call(require.m[id]); } catch { return ''; }
    };
    const classes = {};
    let transport = null;
    for (const id of Object.keys(require.m)) {
      const text = source(id);
      const hasServices = text.includes('SERVICE_ID') && (text.includes('spotify.ads.esperanto') || text.includes('spotify.product_state.esperanto'));
      const hasConnector = text.length < 20000 && text.includes('adsCoreConnector') && text.includes('updateAdServerEndpoint');
      if (!hasServices && !hasConnector) continue;
      let exported;
      try { exported = require(id); } catch { continue; }
      for (const value of Object.values(exported || {})) {
        if (typeof value === 'function' && typeof value.SERVICE_ID === 'string') classes[value.SERVICE_ID] = value;
        if (!transport && value && typeof value === 'object' && value.transport && typeof value.transport.call === 'function') transport = value.transport;
      }
    }
    if (!transport || !classes[SERVICE.slots] || !classes[SERVICE.settings]) return null;
    const make = name => (classes[name] ? new classes[name](transport) : null);
    return {
      slots: make(SERVICE.slots),
      settings: make(SERVICE.settings),
      testing: make(SERVICE.testing),
      adState: make(SERVICE.adState),
      productState: make(SERVICE.productState),
      found: Object.keys(SERVICE).filter(key => classes[SERVICE[key]])
    };
  }

  // ------------------------------------------------------------- the work

  let services = null;
  const switchedOff = new Set();
  const watched = new Set();

  const step = async (name, action) => {
    try { return await action(); } catch (error) { fail(name, error); return undefined; }
  };

  // Switch a slot off. The core then refuses to fetch ads for it ("slot is
  // disabled"); the address change is a second barrier should the core switch
  // the slot back on.
  async function switchOff(slotId) {
    const { settings } = services;
    await step(`endpoint ${slotId}`, () => settings.updateAdServerEndpoint({ slotIds: [slotId], url: NOWHERE }));
    await step(`stream-interval ${slotId}`, () => settings.updateStreamTimeInterval({ slotId, timeInterval: 0n }));
    await step(`disable ${slotId}`, () => settings.updateSlotEnabled({ slotId, enabled: false }));
    await step(`display-interval ${slotId}`, () => settings.updateDisplayTimeInterval({ slotId, timeInterval: 0n }));
    switchedOff.add(slotId);
  }

  // The core announces changes to a slot; look again shortly after one.
  let soonTimer = null;
  function lookAgainSoon() {
    if (soonTimer !== null) return;
    soonTimer = setTimeout(() => {
      soonTimer = null;
      apply(false);
    }, 300);
  }
  function watchSlot(slotId) {
    if (watched.has(slotId)) return;
    watched.add(slotId);
    try { services.slots.subSlot({ slotId }, lookAgainSoon); } catch (error) { fail(`watch ${slotId}`, error); }
  }

  async function pass(full) {
    const waiting = new Set();
    const slotIds = [];
    const listed = await step('list slots', () => services.slots.getSlots({}));
    for (const slot of listed?.adSlots || []) {
      const id = slot.slotId || slot.slot_id;
      if (!id) continue;
      slotIds.push(id);
      if (slot.hasAvailableAds || slot.hasActiveAd || (slot.availableAds || []).length > 0) waiting.add(id);
    }
    // Slots that have settings but are not open yet (they open on demand).
    const configured = await step('list settings', () => services.settings.getAllSlotSettings({}));
    for (const entry of configured?.slotSettings || []) {
      if (entry.id && !slotIds.includes(entry.id)) slotIds.push(entry.id);
    }
    state.slotsSeen = slotIds.length;

    // Settings are applied to every new slot, to any slot that filled up
    // anyway, and to all of them again every few minutes.
    const refresh = full && state.passes % 5 === 0;
    for (const id of slotIds) {
      if (refresh || waiting.has(id) || !switchedOff.has(id)) await switchOff(id);
      if (waiting.has(id)) {
        await step(`empty ${id}`, async () => {
          await services.slots.clearAllAds({ slotId: id });
          state.emptied++;
        });
      }
      watchSlot(id);
    }

    if (!full) return;
    if (services.testing) await step('rewind clock', () => services.testing.addPlaytime({ seconds: REWIND_SECONDS }));
    if (services.productState) await step('ads flag', () => services.productState.putOverridesValues({ pairs: { ads: '0' } }));
    state.passes++;
  }

  // One pass at a time; a request that arrives mid-pass runs right after it.
  let running = false;
  let queued = null;
  async function apply(full) {
    if (!services) services = discover();
    if (!services) return false;
    state.ready = true;
    state.found = services.found;
    if (running) {
      queued = queued || full;
      return true;
    }
    running = true;
    try {
      await pass(full);
      while (queued !== null) {
        const next = queued;
        queued = null;
        await pass(next);
      }
    } catch (error) {
      fail('pass', error);
    } finally {
      running = false;
    }
    return true;
  }

  // Sponsored cards the UI may already have drawn before the slots were emptied.
  function hidePromos() {
    if (document.getElementById('spotify-quiet-style')) return;
    const style = document.createElement('style');
    style.id = 'spotify-quiet-style';
    style.textContent = `
      [data-testid="home-ads-container"], [data-testid="home-ad-card"],
      [data-testid*="hpto"], [data-testid="billboard-minimized"], [data-testid="billboard-image-link"],
      .main-leaderboardComponent-container, #leaderboard-ad-element, #view-billboard-ad, .sponsor-container {
        display: none !important;
      }`;
    (document.head || document.documentElement).appendChild(style);
  }

  async function run() {
    // The services appear once the app has finished starting; keep trying.
    for (let attempt = 0; attempt < 120; attempt++) {
      try { hidePromos(); } catch { /* no document yet */ }
      if (await apply(true)) break;
      await pause(500);
    }
    if (!state.ready) {
      fail('discover', 'ad services not found in this version of the app');
      return;
    }
    // The app keeps configuring itself for a few seconds after start, and
    // slots are created on demand (a podcast opens its own), so look again.
    setTimeout(() => apply(true), 5000);
    setInterval(() => apply(true), REAPPLY_MS);
  }

  // What happened, for troubleshooting: slot names and switches only.
  state.report = async () => {
    const out = {
      spotifyQuietReport: 1,
      version: state.version,
      where: state.where,
      ready: state.ready,
      found: state.found || [],
      passes: state.passes,
      slotsSeen: state.slotsSeen,
      emptied: state.emptied,
      errors: state.errors
    };
    if (!services) return JSON.stringify(out);
    try {
      const listed = await services.slots.getSlots({});
      out.slots = (listed?.adSlots || []).map(slot => ({
        id: slot.slotId,
        hasAds: Boolean(slot.hasAvailableAds),
        active: Boolean(slot.hasActiveAd),
        waiting: (slot.availableAds || []).length
      }));
    } catch (error) { out.slotsError = String(error).slice(0, 120); }
    try {
      const configured = await services.settings.getAllSlotSettings({});
      out.settings = (configured?.slotSettings || []).map(entry => ({ id: entry.id, enabled: Boolean(entry.enabled) }));
    } catch (error) { out.settingsError = String(error).slice(0, 120); }
    try {
      const pairs = (await services.productState.getValues({}))?.pairs || {};
      out.account = { type: pairs.type ?? null, ads: pairs.ads ?? null };
    } catch (error) { out.accountError = String(error).slice(0, 120); }
    try {
      const adState = (await services.adState.getState({}))?.state || {};
      out.adEnabled = adState.ad_enabled?.value ?? null;
    } catch (error) { out.adStateError = String(error).slice(0, 120); }
    out.promoCardsInPage = document.querySelectorAll('[data-testid="home-ad-card"]').length;
    return JSON.stringify(out);
  };

  run();
})();
