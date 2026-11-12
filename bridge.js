// Runs in the extension's isolated world. The engine cannot reach extension
// APIs from the page, so it talks through DOM events and this script relays:
// counts go to the background, and the popup can ask for a diagnostics report.
(() => {
  const KINDS = new Set(['ads', 'sped']);
  let pending = {};
  let timer = null;

  function flush() {
    timer = null;
    const counts = pending;
    pending = {};
    try {
      chrome.runtime.sendMessage({ type: 'count', counts }).catch(() => {});
    } catch { /* extension was reloaded; this page needs a refresh */ }
  }

  document.addEventListener('sq-count', event => {
    const [kind, amount] = String(event.detail).split(':');
    const count = Number(amount);
    if (!KINDS.has(kind) || !Number.isInteger(count) || count < 1 || count > 50) return;
    pending[kind] = (pending[kind] || 0) + count;
    if (timer === null) timer = setTimeout(flush, 1000);
  });

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'report' || window !== window.top) return;
    const done = text => {
      document.removeEventListener('sq-report', onReport);
      clearTimeout(timeout);
      respond({ report: text });
    };
    const onReport = event => done(String(event.detail));
    const timeout = setTimeout(() => done(null), 1500);
    document.addEventListener('sq-report', onReport);
    document.dispatchEvent(new CustomEvent('sq-report-request'));
    return true;
  });
})();
