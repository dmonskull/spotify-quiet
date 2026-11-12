const toggle = document.getElementById('toggle');
const status = document.getElementById('status');
const detail = document.getElementById('detail');
const notice = document.getElementById('notice');
const reload = document.getElementById('reload');
const report = document.getElementById('report');
const reset = document.getElementById('reset');
const SPOTIFY_TAB = /^https:\/\/open\.spotify\.com\//;
let enabled = false;
let spotifyTab = null;

function paint(result) {
  enabled = result.enabled;
  toggle.setAttribute('aria-checked', String(enabled));
  status.textContent = enabled ? 'Filtering enabled' : 'Filtering paused';
  detail.textContent = enabled ? 'Ads filtered on new page loads' : 'Normal playback on new page loads';
  document.getElementById('ads').textContent = result.stats.ads.toLocaleString();
  document.getElementById('sped').textContent = result.stats.sped.toLocaleString();
}

async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result || result.error) throw new Error(result?.error || 'Extension did not respond');
  return result;
}

toggle.addEventListener('click', async () => {
  toggle.disabled = true;
  try {
    paint(await send({ type: 'set-enabled', enabled: !enabled }));
    notice.textContent = 'Setting saved. Reload every open Spotify tab to apply it.';
  } catch (error) {
    notice.textContent = `Could not save: ${error.message}`;
  } finally {
    toggle.disabled = false;
  }
});

reload.addEventListener('click', async () => {
  if (spotifyTab === null) return;
  reload.disabled = true;
  try {
    await chrome.tabs.reload(spotifyTab);
    notice.textContent = 'Spotify is reloading with your current setting.';
  } catch (error) {
    notice.textContent = `Could not reload: ${error.message}`;
  } finally {
    reload.disabled = false;
  }
});

// Diagnostics from the page: what the player was sent and what happened.
report.addEventListener('click', async () => {
  if (spotifyTab === null) return;
  try {
    const answer = await chrome.tabs.sendMessage(spotifyTab, { type: 'report' });
    if (!answer?.report) throw new Error('The page did not answer. Reload Spotify and try again.');
    await navigator.clipboard.writeText(answer.report);
    notice.textContent = `Report copied (${answer.report.length.toLocaleString()} characters).`;
  } catch (error) {
    notice.textContent = `Could not copy: ${error.message}`;
  }
});

reset.addEventListener('click', async () => {
  try {
    paint(await send({ type: 'reset-stats' }));
  } catch (error) {
    notice.textContent = `Could not reset: ${error.message}`;
  }
});

(async () => {
  document.getElementById('version').textContent = `EXPERIMENTAL · v${chrome.runtime.getManifest().version}`;
  try {
    paint(await send({ type: 'status' }));
    toggle.disabled = false;
  } catch (error) {
    status.textContent = 'Setup needs attention';
    detail.textContent = 'Reload the extension in your browser';
    notice.textContent = error.message;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined && tab.url && SPOTIFY_TAB.test(tab.url)) {
      spotifyTab = tab.id;
      reload.disabled = false;
      report.disabled = false;
    } else {
      notice.textContent = 'Open a Spotify tab to reload it or copy a report.';
    }
  } catch {
    notice.textContent = 'Reload Spotify in your browser.';
  }
})();
