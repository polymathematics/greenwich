// Greenwich content script.
//
// Responsibilities:
//   1. Report the current selection (with surrounding context) to the worker.
//   2. Anchor suggestions to their passage and render a marker.
//   3. Show a panel when a marker is clicked.
//
// It performs no network requests of its own; the service worker owns those.

(() => {
  'use strict';

  // Guard against double injection (manual re-injection, or an extension reload
  // while the page is open).
  if (window.__greenwichLoaded) return;
  window.__greenwichLoaded = true;

  const {
    MARKER_CLASS,
    PANEL_CLASS,
    findAnchorPoint,
    captureContext,
  } = globalThis.GreenwichAnchoring;

  const MAX_ANCHORS_PER_PASS = 50;
  const RETRY_LIMIT = 8;
  const RETRY_DEBOUNCE_MS = 400;

  /** Post-it ids already rendered, so a refresh never double-inserts. */
  const rendered = new Set();
  /** Post-its fetched but not yet anchored, retried as the page fills in. */
  let unanchored = [];
  let retriesLeft = RETRY_LIMIT;
  let retryTimer = null;
  let observer = null;
  let currentUrl = location.href;
  let openPanel = null;

  // ---------------------------------------------------------------- rendering

  function isSafeHttpUrl(value) {
    try {
      const u = new URL(value);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function createMarker(postIt) {
    const marker = document.createElement('sup');
    marker.className = MARKER_CLASS;
    marker.textContent = '\u{1F687}';
    marker.setAttribute('role', 'button');
    marker.setAttribute('tabindex', '0');
    marker.setAttribute('aria-label', 'Greenwich: view suggested link');
    marker.dataset.greenwichId = postIt.id || '';

    const open = (event) => {
      event.preventDefault();
      event.stopPropagation();
      showPanel(postIt, marker);
    };
    marker.addEventListener('click', open);
    marker.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') open(event);
    });
    return marker;
  }

  function closePanel() {
    if (!openPanel) return;
    openPanel.element.remove();
    document.removeEventListener('mousedown', openPanel.onOutside, true);
    document.removeEventListener('keydown', openPanel.onKeydown, true);
    window.removeEventListener('scroll', openPanel.onReflow, true);
    window.removeEventListener('resize', openPanel.onReflow);
    openPanel = null;
  }

  /**
   * Builds the panel with DOM APIs and textContent only.
   *
   * The previous version interpolated the server-supplied description and URL
   * into innerHTML, which let any stored suggestion run script in the context
   * of whatever page the user was reading.
   */
  function showPanel(postIt, marker) {
    closePanel();

    const panel = document.createElement('div');
    panel.className = PANEL_CLASS;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Suggested link');

    const header = document.createElement('div');
    header.className = 'greenwich-panel-header';
    header.textContent = 'Suggested link';
    panel.appendChild(header);

    const description = document.createElement('p');
    description.className = 'greenwich-panel-description';
    description.textContent = postIt.description || '';
    panel.appendChild(description);

    if (isSafeHttpUrl(postIt.suggested_link)) {
      const link = document.createElement('a');
      link.className = 'greenwich-panel-link';
      link.href = postIt.suggested_link;
      link.textContent = postIt.suggested_link;
      link.target = '_blank';
      link.rel = 'noopener noreferrer nofollow';
      panel.appendChild(link);
    } else {
      const blocked = document.createElement('p');
      blocked.className = 'greenwich-panel-blocked';
      blocked.textContent = 'This suggestion was hidden because its link is not a valid web address.';
      panel.appendChild(blocked);
    }

    const footer = document.createElement('div');
    footer.className = 'greenwich-panel-footer';

    const report = document.createElement('button');
    report.type = 'button';
    report.className = 'greenwich-panel-report';
    report.textContent = 'Report';
    report.addEventListener('click', () => {
      report.disabled = true;
      report.textContent = 'Reporting...';
      chrome.runtime.sendMessage({ type: 'greenwich:reportPostIt', id: postIt.id }, (response) => {
        if (chrome.runtime.lastError || !response || !response.ok) {
          report.textContent = 'Report failed';
          return;
        }
        report.textContent = 'Reported';
      });
    });
    footer.appendChild(report);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'greenwich-panel-close';
    close.textContent = 'Close';
    close.addEventListener('click', closePanel);
    footer.appendChild(close);

    panel.appendChild(footer);
    document.body.appendChild(panel);
    position(panel, marker);

    const onOutside = (event) => {
      if (!panel.contains(event.target) && event.target !== marker) closePanel();
    };
    const onKeydown = (event) => {
      if (event.key === 'Escape') closePanel();
    };
    const onReflow = () => position(panel, marker);

    // Registered on the next frame so the click that opened the panel does not
    // immediately close it.
    requestAnimationFrame(() => {
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('keydown', onKeydown, true);
      window.addEventListener('scroll', onReflow, true);
      window.addEventListener('resize', onReflow);
    });

    openPanel = { element: panel, onOutside, onKeydown, onReflow };
  }

  /** Keeps the panel on screen even for a marker near a page edge. */
  function position(panel, marker) {
    const rect = marker.getBoundingClientRect();
    const width = panel.offsetWidth || 300;
    const height = panel.offsetHeight || 140;

    let left = rect.left + window.scrollX;
    let top = rect.bottom + window.scrollY + 4;

    const maxLeft = window.scrollX + document.documentElement.clientWidth - width - 8;
    if (left > maxLeft) left = Math.max(window.scrollX + 8, maxLeft);

    // Flip above the marker when there is no room below.
    if (rect.bottom + height + 12 > window.innerHeight && rect.top - height - 4 > 0) {
      top = rect.top + window.scrollY - height - 4;
    }

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  // ----------------------------------------------------------------- anchoring

  /** Returns true when the marker was placed. */
  function anchor(postIt) {
    const point = findAnchorPoint(document.body, postIt);
    if (!point) return false;

    try {
      const range = document.createRange();
      range.setStart(point.node, point.offset);
      range.collapse(true);
      range.insertNode(createMarker(postIt));
      return true;
    } catch {
      // A live DOM can move out from under us between indexing and insertion.
      return false;
    }
  }

  function stopObserver() {
    clearTimeout(retryTimer);
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function renderPostIts(postIts) {
    // Inserting a marker is itself a DOM mutation. Without this the observer
    // below would wake on our own writes and spend the retry budget on them.
    stopObserver();

    const pending = [];
    let placed = 0;

    for (const postIt of postIts.slice(0, MAX_ANCHORS_PER_PASS)) {
      if (!postIt || !postIt.id || rendered.has(postIt.id)) continue;
      if (anchor(postIt)) {
        rendered.add(postIt.id);
        placed += 1;
      } else {
        pending.push(postIt);
      }
    }

    unanchored = pending;
    if (placed > 0) {
      chrome.runtime.sendMessage({ type: 'greenwich:markerCount', count: rendered.size }, () => {
        // Response ignored; swallow lastError if the worker is asleep.
        void chrome.runtime.lastError;
      });
    }
    scheduleRetry();
  }

  /**
   * Content that arrives after the first pass (lazy loading, hydration) is why
   * the previous version used a blind 1.5s delay. A bounded observer handles it
   * without guessing, and stops once there is nothing left to place.
   */
  function scheduleRetry() {
    if (unanchored.length === 0 || retriesLeft <= 0) {
      stopObserver();
      return;
    }
    if (observer) return;

    observer = new MutationObserver(() => {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retriesLeft -= 1;
        const queue = unanchored;
        unanchored = [];
        renderPostIts(queue);
      }, RETRY_DEBOUNCE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function clearMarkers() {
    closePanel();
    document.querySelectorAll(`.${MARKER_CLASS}`).forEach((el) => el.remove());
    rendered.clear();
    unanchored = [];
    retriesLeft = RETRY_LIMIT;
    stopObserver();
  }

  function load({ force = false } = {}) {
    chrome.runtime.sendMessage(
      { type: 'greenwich:getPostIts', url: location.href, force },
      (response) => {
        if (chrome.runtime.lastError) return; // worker restarting; next event retries
        if (!response || !response.ok) return;
        if (Array.isArray(response.postIts) && response.postIts.length > 0) {
          renderPostIts(response.postIts);
        }
      }
    );
  }

  // ------------------------------------------------------------------- selection

  /** Captures the selection plus surrounding text for later re-anchoring. */
  function readAnchor() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return { exact: '', prefix: '', suffix: '' };

    const exact = selection.toString().trim();
    if (!exact) return { exact: '', prefix: '', suffix: '' };

    let context = { prefix: '', suffix: '' };
    try {
      const range = selection.getRangeAt(0);
      context = captureContext(exact, range.startContainer, document.body);
    } catch {
      // Context is optional; an empty prefix/suffix just means weaker anchoring.
    }

    return { exact, prefix: context.prefix, suffix: context.suffix };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return undefined;

    switch (message.type) {
      case 'greenwich:getAnchor':
        sendResponse(readAnchor());
        return undefined;

      case 'greenwich:postItAdded':
        if (message.postIt) renderPostIts([message.postIt]);
        return undefined;

      case 'greenwich:urlChanged':
        // Same-document navigation in a single-page app.
        if (message.url && message.url !== currentUrl) {
          currentUrl = message.url;
          clearMarkers();
          load({ force: true });
        }
        return undefined;

      default:
        return undefined;
    }
  });

  // --------------------------------------------------------------------- start

  // addEventListener, not window.onload: assigning that property clobbers the
  // host page's own load handler.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => load(), { once: true });
  } else {
    load();
  }
})();
