// Greenwich service worker.
//
// This is the only part of the extension that talks to the network. The content
// script and popup ask it for data over chrome.runtime messages, which keeps the
// API base URL in one place and removes the storage-key races that the previous
// version used as a transport.

const DEFAULT_API_BASE = 'https://greenwich.YOUR-SUBDOMAIN.workers.dev';

const CACHE_TTL_MS = 60 * 1000;
const PENDING_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

// url -> { postIts, fetchedAt }. Cleared whenever the worker restarts, which is
// fine: it only exists to stop repeat navigations from re-querying the server.
const pageCache = new Map();

// ---------------------------------------------------------------- configuration

async function getApiBase() {
  const { apiBase } = await chrome.storage.local.get('apiBase');
  const base = (apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
  return base;
}

function isConfigured(base) {
  return !base.includes('YOUR-SUBDOMAIN');
}

/**
 * Pages we are willing to look up. Everything else is skipped before any
 * request leaves the browser, so private hosts never reach the server.
 */
function isSupportedPageUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return false;
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;

  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host === '127.0.0.1' || host === '::1' || host === '[::1]') return false;
  // RFC1918 and link-local ranges: intranet URLs stay on the intranet.
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  return true;
}

// -------------------------------------------------------------------- transport

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function friendlyError(err) {
  const message = String(err && err.message ? err.message : err);
  if (/abort|timeout|timed out/i.test(message)) {
    return 'The Greenwich server did not respond in time.';
  }
  if (/Failed to fetch|NetworkError|network/i.test(message)) {
    return 'Could not reach the Greenwich server. Check your connection.';
  }
  return message;
}

/**
 * Performs an API request and always resolves to a tagged result, so callers
 * never have to deal with a rejected promise.
 *
 * Retries transient failures (network error, timeout, 5xx) once; never retries
 * a 4xx, because the request itself is the problem.
 */
async function apiRequest(path, init = {}, { retries = 1 } = {}) {
  const base = await getApiBase();
  if (!isConfigured(base)) {
    return { ok: false, status: 0, error: 'Greenwich is not configured with a server URL yet.' };
  }

  let lastError = new Error('Request failed.');

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(`${base}${path}`, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      // Read as text first: a dead host or a proxy error page returns HTML, and
      // calling response.json() on that throws a parse error that hides the
      // real status. This is exactly how the previous version failed silently.
      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }

      if (!response.ok) {
        const message =
          (data && data.error) ||
          (response.status === 404
            ? 'The Greenwich server endpoint was not found. It may not be deployed.'
            : `The Greenwich server returned ${response.status}.`);
        if (response.status >= 400 && response.status < 500) {
          return { ok: false, status: response.status, error: message };
        }
        throw new Error(message);
      }

      if (data === null) {
        throw new Error('The Greenwich server returned an unexpected response.');
      }
      return { ok: true, status: response.status, data };
    } catch (err) {
      lastError = err;
      if (attempt < retries) await delay(400 * 2 ** attempt);
    }
  }

  return { ok: false, status: 0, error: friendlyError(lastError) };
}

// ------------------------------------------------------------------- read path

async function getPostIts(pageUrl, { force = false } = {}) {
  if (!isSupportedPageUrl(pageUrl)) return { ok: true, postIts: [] };

  const cached = pageCache.get(pageUrl);
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { ok: true, postIts: cached.postIts, cached: true };
  }

  const result = await apiRequest(`/postits?url=${encodeURIComponent(pageUrl)}`);
  if (!result.ok) {
    // Serve stale data rather than nothing when the server is unreachable.
    if (cached) return { ok: true, postIts: cached.postIts, stale: true };
    return { ok: false, postIts: [], error: result.error };
  }

  const postIts = Array.isArray(result.data.postIts) ? result.data.postIts : [];
  pageCache.set(pageUrl, { postIts, fetchedAt: Date.now() });
  // Bound the cache so a long browsing session cannot grow it without limit.
  if (pageCache.size > 200) {
    pageCache.delete(pageCache.keys().next().value);
  }
  return { ok: true, postIts };
}

// ------------------------------------------------------------------ write path

async function getClientId() {
  const { clientId } = await chrome.storage.local.get('clientId');
  if (clientId) return clientId;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ clientId: fresh });
  return fresh;
}

async function createPostIt(payload) {
  const clientId = await getClientId();
  const result = await apiRequest('/postits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, client_id: clientId }),
  });

  if (!result.ok) return { ok: false, error: result.error };

  // The page's cached list is now out of date.
  pageCache.delete(payload.source_url);
  return { ok: true, postIt: result.data.postIt };
}

async function reportPostIt(id) {
  const result = await apiRequest(`/postits/${encodeURIComponent(id)}/report`, { method: 'POST' });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

// ------------------------------------------------- pending suggestion handoff

// Keyed by tab so two windows composing suggestions at once cannot overwrite
// each other, which the old single `currentSelectedText` key allowed.
const pendingKey = (tabId) => `pending:${tabId}`;

async function setPending(tabId, pending) {
  await chrome.storage.session.set({
    [pendingKey(tabId)]: { ...pending, createdAt: Date.now() },
  });
}

async function takePending(tabId) {
  const key = pendingKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const pending = stored[key];
  if (!pending) return null;
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    await chrome.storage.session.remove(key);
    return null;
  }
  return pending;
}

async function clearPending(tabId) {
  await chrome.storage.session.remove(pendingKey(tabId));
}

/**
 * Asks the content script for the live selection plus its surrounding text.
 * info.selectionText is a fallback only: Chrome collapses its whitespace and
 * truncates it, which breaks exact-text anchoring.
 */
async function resolveSelection(tabId, info) {
  try {
    const anchor = await chrome.tabs.sendMessage(tabId, { type: 'greenwich:getAnchor' });
    if (anchor && anchor.exact) return anchor;
  } catch {
    // No content script in this tab (for example it was loaded before install).
  }
  return { exact: (info.selectionText || '').trim(), prefix: '', suffix: '' };
}

async function setBadge(tabId, text) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#41ad38' });
  } catch {
    // Tab closed between the navigation and here; nothing to do.
  }
}

// --------------------------------------------------------------------- wiring

chrome.runtime.onInstalled.addListener(() => {
  // Must be registered here, not at the top level. The service worker restarts
  // constantly, and contextMenus.create throws on a duplicate id every time.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'suggestLink',
      title: 'Suggest a hyperlink for this passage',
      contexts: ['selection'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'suggestLink' || !tab || tab.id === undefined) return;

  if (!isSupportedPageUrl(tab.url)) {
    await setBadge(tab.id, '!');
    return;
  }

  const anchor = await resolveSelection(tab.id, info);
  if (!anchor.exact) return;

  await setPending(tab.id, {
    tabId: tab.id,
    sourceUrl: tab.url,
    exact: anchor.exact,
    prefix: anchor.prefix || '',
    suffix: anchor.suffix || '',
  });

  try {
    await chrome.action.openPopup();
  } catch {
    // openPopup needs a focused window and is not available in every context.
    // Badge the toolbar icon so the user can open the same form by clicking it.
    await setBadge(tab.id, '1');
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined;

  switch (message.type) {
    case 'greenwich:getPostIts': {
      // Trust the sender's own URL for content scripts; the popup passes one.
      const pageUrl = sender.tab ? sender.tab.url || message.url : message.url;
      getPostIts(pageUrl, { force: Boolean(message.force) }).then(sendResponse);
      return true;
    }

    case 'greenwich:getPending': {
      (async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || tab.id === undefined) {
          sendResponse({ ok: false, error: 'No active tab.' });
          return;
        }
        await setBadge(tab.id, '');
        const pending = await takePending(tab.id);
        sendResponse({ ok: true, pending, tabUrl: tab.url });
      })();
      return true;
    }

    case 'greenwich:createPostIt': {
      (async () => {
        const response = await createPostIt(message.payload);
        if (response.ok && typeof message.tabId === 'number') {
          await clearPending(message.tabId);
          // Render the new marker immediately instead of waiting for a reload.
          try {
            await chrome.tabs.sendMessage(message.tabId, {
              type: 'greenwich:postItAdded',
              postIt: response.postIt,
            });
          } catch {
            // Tab navigated away or has no content script; the marker will
            // appear on the next load.
          }
        }
        sendResponse(response);
      })();
      return true;
    }

    case 'greenwich:reportPostIt': {
      reportPostIt(message.id).then(sendResponse);
      return true;
    }

    case 'greenwich:markerCount': {
      if (sender.tab && sender.tab.id !== undefined) {
        setBadge(sender.tab.id, message.count > 0 ? String(message.count) : '');
      }
      return undefined;
    }

    default:
      return undefined;
  }
});

// Single-page apps change the URL without a document load, so the content
// script would otherwise keep showing the first page's suggestions forever.
chrome.webNavigation.onHistoryStateUpdated.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    chrome.tabs
      .sendMessage(details.tabId, { type: 'greenwich:urlChanged', url: details.url })
      .catch(() => {
        // Content script not present in this tab; nothing to refresh.
      });
  },
  { url: [{ schemes: ['http', 'https'] }] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(pendingKey(tabId)).catch(() => {});
});
