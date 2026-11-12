// Offline check of desktop/quiet.js against a fake of the app's module loader
// and ad services. No Spotify and no browser needed: node test/desktop.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'quiet.js'), 'utf8');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---- a fake native core: three slots, one of them holding an ad
const calls = [];
const core = {
  slots: {
    'home-promo': { ads: 1, enabled: true },
    'stream': { ads: 0, enabled: true }
  },
  settingsOnly: ['podcast-midroll-1'],
  listeners: new Map(),
  overrides: {},
  clock: 0
};
const transport = { call() {}, callSingle() {} };
// The script runs in its own context; copy what it sends into this one so it can be compared.
const record = (service, method, request) => calls.push({ service, method, request: structuredClone(request) });

class Slots {
  static SERVICE_ID = 'spotify.ads.esperanto.proto.Slots';
  constructor(t) { this.transport = t; }
  async getSlots() {
    return { adSlots: Object.entries(core.slots).map(([slotId, slot]) => ({ slotId, hasAvailableAds: slot.ads > 0, hasActiveAd: false, availableAds: Array(slot.ads).fill({}) })) };
  }
  async clearAllAds(request) { record('slots', 'clearAllAds', request); core.slots[request.slotId].ads = 0; return {}; }
  subSlot(request, callback) { record('slots', 'subSlot', request); core.listeners.set(request.slotId, callback); }
}
class Settings {
  static SERVICE_ID = 'spotify.ads.esperanto.proto.Settings';
  constructor(t) { this.transport = t; }
  async getAllSlotSettings() { return { slotSettings: [...Object.keys(core.slots), ...core.settingsOnly].map(id => ({ id, enabled: true })) }; }
  async updateAdServerEndpoint(request) { record('settings', 'updateAdServerEndpoint', request); return { status: 0 }; }
  async updateStreamTimeInterval(request) { record('settings', 'updateStreamTimeInterval', request); return { status: 0 }; }
  async updateDisplayTimeInterval(request) { record('settings', 'updateDisplayTimeInterval', request); return { status: 0 }; }
  async updateSlotEnabled(request) {
    record('settings', 'updateSlotEnabled', request);
    if (request.slotId === 'stream') throw new Error('core refused');
    return { status: 0 };
  }
}
class Testing {
  static SERVICE_ID = 'spotify.ads.esperanto.proto.Testing';
  constructor(t) { this.transport = t; }
  async addPlaytime(request) { record('testing', 'addPlaytime', request); core.clock += request.seconds; return {}; }
}
class AdState {
  static SERVICE_ID = 'spotify.ads.esperanto.proto.State';
  constructor(t) { this.transport = t; }
  async getState() { return { state: { ad_enabled: { value: 'true' }, current_track: { value: 'spotify:track:SECRET' } } }; }
}
class ProductState {
  static SERVICE_ID = 'spotify.product_state.esperanto.proto.ProductState';
  constructor(t) { this.transport = t; }
  async putOverridesValues(request) { record('productState', 'putOverridesValues', request); Object.assign(core.overrides, request.pairs); return {}; }
  async getValues() { return { pairs: { type: 'free', ads: core.overrides.ads ?? '1', name: 'SECRET-NAME' } }; }
}

// ---- a fake module loader shaped like the app's
const exportsById = {
  // the services module
  101: { a: Slots, b: Settings, c: Testing, d: AdState, e: ProductState, f: 'not a class' },
  // the small connector module: exposes ready-made clients that carry the transport
  102: { adsCoreConnector: {}, l: { transport, options: {} } },
  // an unrelated module that must never be opened
  103: null
};
let opened = [];
const factories = {
  101: function () { /* SERVICE_ID "spotify.ads.esperanto.proto.Slots" "spotify.product_state.esperanto.proto.ProductState" */ },
  102: function () { /* adsCoreConnector updateAdServerEndpoint */ },
  103: function () { /* nothing of interest here */ }
};
function fakeRequire(id) {
  opened.push(String(id));
  if (exportsById[id] === null) throw new Error('unrelated module was opened');
  return exportsById[id];
}
fakeRequire.m = factories;

function makeWindow({ ready }) {
  const styles = [];
  const queue = [];
  queue.push = entry => { if (ready() && typeof entry[2] === 'function') entry[2](fakeRequire); return 0; };
  const window = {
    rspackChunk: queue,
    performance,
    setTimeout,
    setInterval: (fn, ms) => { const timer = setInterval(fn, ms); timer.unref(); return timer; },
    console,
    document: {
      head: { appendChild: node => styles.push(node) },
      documentElement: { appendChild: node => styles.push(node) },
      getElementById: id => styles.find(node => node.id === id) || null,
      createElement: () => ({}),
      querySelectorAll: () => []
    }
  };
  window.window = window;
  return { window, styles };
}

// ---- run it: the services only become available a moment after start
let available = false;
const { window, styles } = makeWindow({ ready: () => available });
vm.runInNewContext(source, window);
const state = window.__spQuiet;
assert.equal(state.version, '0.1.1');
assert.equal(state.ready, false);
await pause(700);
assert.equal(state.ready, false, 'must wait while the app has not loaded its services');
available = true;
await pause(900);

assert.equal(state.ready, true);
assert.deepEqual([...state.found].sort(), ['adState', 'productState', 'settings', 'slots', 'testing']);
assert.deepEqual([...new Set(opened)].sort(), ['101', '102'], 'only the two relevant modules are opened');
assert.equal(state.slotsSeen, 3, 'two open slots plus one that only has settings');
assert.equal(styles.length, 1, 'one style element for sponsored cards');
assert.match(styles[0].textContent, /home-ad-card/);

const of = (service, method) => calls.filter(call => call.service === service && call.method === method).map(call => call.request);
const allSlots = ['home-promo', 'stream', 'podcast-midroll-1'];
assert.deepEqual(of('settings', 'updateSlotEnabled'), allSlots.map(slotId => ({ slotId, enabled: false })));
assert.deepEqual(of('settings', 'updateAdServerEndpoint').map(r => r.slotIds[0]), allSlots);
assert(of('settings', 'updateAdServerEndpoint').every(r => r.url.startsWith('http://localhost:9/')));
assert.deepEqual(of('settings', 'updateStreamTimeInterval'), allSlots.map(slotId => ({ slotId, timeInterval: 0n })));
assert.deepEqual(of('settings', 'updateDisplayTimeInterval'), allSlots.map(slotId => ({ slotId, timeInterval: 0n })));
assert.deepEqual(of('slots', 'clearAllAds'), [{ slotId: 'home-promo' }], 'only the slot holding an ad is emptied');
assert.deepEqual(of('slots', 'subSlot').map(r => r.slotId), allSlots);
assert.deepEqual(of('testing', 'addPlaytime'), [{ seconds: -100000000000 }]);
assert.deepEqual(of('productState', 'putOverridesValues'), [{ pairs: { ads: '0' } }], 'only the ads flag is overridden');
assert.equal(state.emptied, 1);
assert.equal(state.passes, 1);
// A refused step is recorded and does not stop the rest.
assert.deepEqual(structuredClone(state.errors).map(error => [error.step, error.message]), [['disable stream', 'core refused']]);

// ---- the core refills a slot and announces it: it is switched off and emptied again
calls.length = 0;
core.slots['home-promo'].ads = 2;
core.listeners.get('home-promo')({ adSlotEvent: { slotId: 'home-promo' } });
await pause(700);
assert.deepEqual(of('slots', 'clearAllAds'), [{ slotId: 'home-promo' }]);
assert.deepEqual(of('settings', 'updateSlotEnabled'), [{ slotId: 'home-promo', enabled: false }]);
assert.deepEqual(of('testing', 'addPlaytime'), [], 'an event-driven look does not touch the clock');
assert.equal(state.emptied, 2);

// ---- the report names slots and switches, never tracks or account details
const text = await state.report();
const report = JSON.parse(text);
assert.equal(report.spotifyQuietReport, 1);
assert.equal(report.where, 'desktop');
assert.deepEqual(report.slots, [{ id: 'home-promo', hasAds: false, active: false, waiting: 0 }, { id: 'stream', hasAds: false, active: false, waiting: 0 }]);
assert.deepEqual(report.account, { type: 'free', ads: '0' });
assert.equal(report.adEnabled, 'true');
assert(!text.includes('SECRET'), 'report leaked a track or a name');

// ---- loading the script a second time does nothing
calls.length = 0;
vm.runInContext(source, vm.createContext(window));
await pause(300);
assert.equal(calls.length, 0);

console.log('desktop: all checks passed');
process.exit(0);
