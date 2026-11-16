// Greenwich popup: the suggestion composer.
//
// It performs no network requests. Submitting hands the payload to the service
// worker, which validates, posts, and tells the originating tab to render the
// new marker.

(() => {
  'use strict';

  const form = document.getElementById('suggest-form');
  const linkInput = document.getElementById('link-url');
  const descriptionInput = document.getElementById('description');
  const submitButton = document.getElementById('submit-btn');
  const statusEl = document.getElementById('status');
  const selectionBlock = document.getElementById('selection-block');
  const selectedTextEl = document.getElementById('selected-text');
  const noSelectionEl = document.getElementById('no-selection');
  const fieldsEl = document.getElementById('fields');

  /** The selection captured when the context menu was clicked. */
  let pending = null;
  let submitting = false;

  function setStatus(message, kind) {
    if (!message) {
      statusEl.hidden = true;
      statusEl.textContent = '';
      statusEl.removeAttribute('data-kind');
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = message;
    statusEl.dataset.kind = kind || 'info';
  }

  function setInvalid(input, invalid) {
    if (invalid) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  /** Accepts "example.com/page" the way the address bar does. */
  function normalizeLink(raw) {
    let candidate = String(raw || '').trim();
    if (!candidate) return null;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) candidate = `https://${candidate}`;

    let u;
    try {
      u = new URL(candidate);
    } catch {
      return null;
    }
    // Rejects javascript:, data: and anything else that is not a web page.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname || !u.hostname.includes('.')) return null;
    return u.toString();
  }

  function showNoSelection(message) {
    selectionBlock.hidden = true;
    noSelectionEl.hidden = false;
    if (message) noSelectionEl.textContent = message;
    fieldsEl.hidden = true;
    submitButton.disabled = true;
  }

  function showSelection(text) {
    selectedTextEl.textContent = text;
    selectionBlock.hidden = false;
    noSelectionEl.hidden = true;
    fieldsEl.hidden = false;
    submitButton.disabled = false;
  }

  // ------------------------------------------------------------------- startup

  chrome.runtime.sendMessage({ type: 'greenwich:getPending' }, (response) => {
    if (chrome.runtime.lastError) {
      showNoSelection('Greenwich could not start. Try reloading the extension.');
      return;
    }
    if (!response || !response.ok || !response.pending || !response.pending.exact) {
      showNoSelection();
      return;
    }
    pending = response.pending;
    showSelection(pending.exact);
    linkInput.focus();
  });

  // ---------------------------------------------------------------- submission

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (submitting || !pending) return;

    const link = normalizeLink(linkInput.value);
    const description = descriptionInput.value.trim();

    setInvalid(linkInput, !link);
    setInvalid(descriptionInput, !description);

    if (!link) {
      setStatus('Enter a valid web address, for example example.com/article.', 'error');
      linkInput.focus();
      return;
    }
    if (!description) {
      setStatus('Add a short description of how the link is related.', 'error');
      descriptionInput.focus();
      return;
    }

    // Guard against a second submit while the first is in flight, which the
    // previous version allowed and which created duplicate suggestions.
    submitting = true;
    submitButton.disabled = true;
    submitButton.textContent = 'saving...';
    setStatus('Saving your suggestion...', 'info');

    chrome.runtime.sendMessage(
      {
        type: 'greenwich:createPostIt',
        tabId: pending.tabId,
        payload: {
          source_url: pending.sourceUrl,
          highlighted_text: pending.exact,
          prefix: pending.prefix || '',
          suffix: pending.suffix || '',
          suggested_link: link,
          description,
        },
      },
      (response) => {
        submitting = false;
        submitButton.disabled = false;
        submitButton.textContent = 'submit';

        if (chrome.runtime.lastError) {
          setStatus('Greenwich stopped responding. Please try again.', 'error');
          return;
        }
        if (!response || !response.ok) {
          setStatus((response && response.error) || 'Could not save the suggestion.', 'error');
          return;
        }

        setStatus('Saved.', 'success');
        // Brief pause so the confirmation is actually readable before closing.
        setTimeout(() => window.close(), 700);
      }
    );
  });

  linkInput.addEventListener('input', () => {
    setInvalid(linkInput, false);
    setStatus('');
  });
  descriptionInput.addEventListener('input', () => {
    setInvalid(descriptionInput, false);
  });

  // Ctrl/Cmd+Enter submits from inside the textarea.
  descriptionInput.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      form.requestSubmit();
    }
  });
})();
