#!/usr/bin/env node
// Spotify Quiet for the desktop app, for Windows and Linux (macOS has its own
// app, built from desktop/mac).
//
// Opens Spotify with a local DevTools port and loads quiet.js into its UI.
// Nothing inside Spotify.app is changed: quit Spotify and open it the normal
// way and it is stock again. Needs Node 22 or newer.
//
//   node desktop/launch.mjs            open Spotify (or attach to it) and keep it quiet
//   node desktop/launch.mjs --report   print what the script did inside the app
//
// SPOTIFY_QUIET_PORT changes the port (default 19888). The port only listens on
// this computer, but any program running here can reach it while Spotify is open.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.SPOTIFY_QUIET_PORT || 19888);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = fs.readFileSync(path.join(HERE, 'quiet.js'), 'utf8');
const UI_PAGE = /^https:\/\/xpui\.app\.spotify\.com\//;
const BASE = `http://127.0.0.1:${PORT}`;

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = message => console.log(`${new Date().toTimeString().slice(0, 8)}  ${message}`);

if (typeof WebSocket !== 'function' || typeof fetch !== 'function') {
  console.error('Spotify Quiet needs Node 22 or newer.');
  process.exit(1);
}

// ------------------------------------------------------- the Spotify app

const platform = {
  darwin: {
    app: process.env.SPOTIFY_APP || '/Applications/Spotify.app',
    // Exact name, so helper processes and anything that merely mentions Spotify do not count.
    running: () => quiet(() => execFileSync('pgrep', ['-x', 'Spotify'])),
    quit: () => {
      if (!quiet(() => execFileSync('osascript', ['-e', 'tell application "Spotify" to quit'], { stdio: 'ignore', timeout: 8000 }))) {
        quiet(() => execFileSync('pkill', ['-x', 'Spotify']));
      }
    },
    start(app) { spawn('open', ['-a', app, '--args', `--remote-debugging-port=${PORT}`], { stdio: 'ignore', detached: true }).unref(); }
  },
  win32: {
    app: process.env.SPOTIFY_APP || path.join(process.env.APPDATA || '', 'Spotify', 'Spotify.exe'),
    running: () => quiet(() => /Spotify\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq Spotify.exe'], { encoding: 'utf8' }))),
    quit: () => quiet(() => execFileSync('taskkill', ['/IM', 'Spotify.exe'], { stdio: 'ignore' })),
    start(app) { spawn(app, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', detached: true }).unref(); }
  },
  linux: {
    app: process.env.SPOTIFY_APP || 'spotify',
    running: () => quiet(() => execFileSync('pgrep', ['-x', 'spotify'])),
    quit: () => quiet(() => execFileSync('pkill', ['-x', 'spotify'])),
    start(app) { spawn(app, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', detached: true }).unref(); }
  }
}[os.platform()];

function quiet(action) {
  try { return action() !== false; } catch { return false; }
}

async function devtools(route) {
  const response = await fetch(`${BASE}${route}`, { signal: AbortSignal.timeout(3000) });
  return response.json();
}

// Is something answering on the port, and is it Spotify?
async function portState() {
  try {
    const version = await devtools('/json/version');
    return /Spotify\//.test(version['User-Agent'] || '') ? 'spotify' : 'other';
  } catch {
    return 'closed';
  }
}

async function openSpotify() {
  const state = await portState();
  if (state === 'spotify') {
    log('Spotify is already open with the port. Attaching.');
    return;
  }
  if (state === 'other') throw new Error(`Port ${PORT} is in use by another program. Set SPOTIFY_QUIET_PORT to a free one.`);
  if (!platform) throw new Error(`Unsupported system: ${os.platform()}`);
  if (os.platform() !== 'linux' && !fs.existsSync(platform.app)) throw new Error(`Spotify not found at ${platform.app}. Set SPOTIFY_APP to its location.`);

  if (platform.running()) {
    log('Spotify is open without the port. Closing it to reopen it.');
    platform.quit();
    for (let i = 0; i < 40 && platform.running(); i++) await pause(250);
    if (platform.running()) throw new Error('Spotify did not close. Quit it and run this again.');
  }
  log('Opening Spotify.');
  platform.start(platform.app);
  for (let i = 0; i < 120; i++) {
    if ((await portState()) === 'spotify') return;
    await pause(250);
  }
  throw new Error('Spotify opened but its port did not answer. This version of Spotify may no longer allow it.');
}

// ------------------------------------------------------------ DevTools

class Page {
  constructor(target) {
    this.id = target.id;
    this.next = 0;
    this.pending = new Map();
    this.closed = false;
    this.socket = new WebSocket(target.webSocketDebuggerUrl);
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    this.socket.addEventListener('close', () => {
      this.closed = true;
      for (const waiter of this.pending.values()) waiter.reject(new Error('page closed'));
      this.pending.clear();
    });
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('could not connect to the page')), { once: true });
    });
  }

  send(method, params = {}) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 20000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }

  close() { this.socket.close(); }
}

async function uiTargets() {
  const targets = await devtools('/json/list');
  return targets.filter(target => target.type === 'page' && UI_PAGE.test(target.url || ''));
}

// Load the script into the page now, and again whenever the page reloads for
// as long as this connection stays open.
async function quieten(target) {
  const page = new Page(target);
  await page.ready;
  await page.send('Page.enable');
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SCRIPT });
  await page.evaluate(SCRIPT);
  return page;
}

// --------------------------------------------------------------- modes

async function report() {
  if ((await portState()) !== 'spotify') throw new Error('Spotify is not open with the port. Start it with: node desktop/launch.mjs');
  const [target] = await uiTargets();
  if (!target) throw new Error('Spotify is open but its main window is not ready.');
  const page = new Page(target);
  await page.ready;
  const text = await page.evaluate(`window.__spQuiet ? window.__spQuiet.report() : JSON.stringify({ spotifyQuietReport: 1, where: 'desktop', loaded: false })`);
  page.close();
  console.log(text);
}

async function keepQuiet() {
  await openSpotify();
  const pages = new Map();
  let misses = 0;
  let announced = false;
  for (;;) {
    let targets = null;
    try { targets = await uiTargets(); } catch { /* the port did not answer */ }
    if (targets === null) {
      // No answer: finished if Spotify is gone, otherwise allow a few misses.
      if (!platform.running() || ++misses >= 3) break;
    } else {
      misses = 0;
      for (const [id, page] of pages) if (page.closed) pages.delete(id);
      for (const target of targets) {
        if (pages.has(target.id)) continue;
        try {
          pages.set(target.id, await quieten(target));
          log('Loaded into the Spotify window.');
        } catch (error) {
          log(`Could not load into the window yet (${error.message}). Trying again.`);
        }
      }
      if (!announced && pages.size > 0) {
        announced = true;
        // Give the script a moment to find the app's ad services, then say how it went.
        setTimeout(async () => {
          try {
            const [page] = pages.values();
            const state = JSON.parse(await page.evaluate('window.__spQuiet.report()'));
            if (state.ready) log(`Ads off: ${state.slotsSeen} ad slots switched off. Leave this running; it stops when Spotify closes.`);
            else log('The app has not exposed its ad services yet. Still trying.');
          } catch { /* the window went away; the loop handles it */ }
        }, 4000);
      }
    }
    await pause(2000);
  }
  log('Spotify closed. Done.');
}

const mode = process.argv.includes('--report') ? report : keepQuiet;
mode().then(() => process.exit(0), error => {
  console.error(`Spotify Quiet: ${error.message}`);
  process.exit(1);
});
