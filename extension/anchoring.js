// Greenwich anchoring: locating a stored passage in a live DOM.
//
// Pure DOM logic with no extension APIs, so it can be unit tested outside the
// browser. Loaded as a content script before contentScript.js, which consumes
// it through globalThis.GreenwichAnchoring.

(() => {
  'use strict';

  const MARKER_CLASS = 'greenwich-marker';
  const PANEL_CLASS = 'greenwich-panel';

  // Text inside these elements is code, metadata, or user-editable. Inserting a
  // marker into any of them corrupts the page or the user's input.
  const SKIPPED_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'SELECT', 'OPTION', 'OPTGROUP',
    'TITLE', 'HEAD', 'IFRAME', 'OBJECT', 'EMBED', 'CANVAS', 'SVG', 'MATH',
    'INPUT', 'BUTTON', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
  ]);

  const WHITESPACE = /\s/;

  // Collapses whitespace runs without trimming. The space immediately before or
  // after a quoted passage is part of what distinguishes one occurrence from
  // another, so context must keep its edges.
  const collapse = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ');

  const normalizeQuery = (value) => collapse(value).trim();

  function isSkipped(node) {
    for (let el = node.parentElement; el; el = el.parentElement) {
      if (SKIPPED_TAGS.has(el.tagName)) return true;
      if (el.classList && (el.classList.contains(MARKER_CLASS) || el.classList.contains(PANEL_CLASS))) {
        return true;
      }
      // isContentEditable is the live answer; the attribute check keeps this
      // correct in environments that do not compute it.
      const editable = el.getAttribute && el.getAttribute('contenteditable');
      if (el.isContentEditable || (editable != null && editable !== 'false')) return true;
      if (el.hasAttribute && el.hasAttribute('hidden')) return true;
      if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
    }
    return false;
  }

  /**
   * Builds a whitespace-normalized string of the page's visible text plus a map
   * from each character back to its (text node, offset).
   *
   * Normalizing matters for two reasons: HTML indentation makes DOM text differ
   * from what the user selected, and a selected phrase routinely spans several
   * text nodes ("the <b>Greenwich</b> meridian"). Matching node by node, as the
   * previous version did, missed both cases.
   */
  function buildTextIndex(root) {
    const chars = [];
    const nodes = [];
    const offsets = [];
    let pendingSpace = false;

    const doc = root.ownerDocument || root;
    const walker = doc.createTreeWalker(root, 0x4 /* SHOW_TEXT */, {
      acceptNode(node) {
        if (!node.nodeValue) return 2; // FILTER_REJECT
        return isSkipped(node) ? 2 : 1; // FILTER_ACCEPT
      },
    });

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.nodeValue;
      for (let i = 0; i < value.length; i += 1) {
        const ch = value[i];
        if (WHITESPACE.test(ch)) {
          // Collapse runs of whitespace, and never start the index with one.
          pendingSpace = chars.length > 0;
          continue;
        }
        if (pendingSpace) {
          chars.push(' ');
          nodes.push(node);
          offsets.push(i);
          pendingSpace = false;
        }
        chars.push(ch);
        nodes.push(node);
        offsets.push(i);
      }
    }

    return { text: chars.join(''), nodes, offsets };
  }

  function commonPrefixLength(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
    return i;
  }

  function commonSuffixLength(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
    return i;
  }

  /**
   * Finds the occurrence of `exact` whose surroundings best match the stored
   * prefix/suffix. Without that context a repeated phrase would always anchor
   * to the first copy on the page, which is frequently the wrong one.
   *
   * Returns the character index into index.text, or -1.
   */
  function findBestOccurrence(index, exact, prefix, suffix) {
    const needle = normalizeQuery(exact);
    if (!needle) return -1;

    const wantPrefix = collapse(prefix);
    const wantSuffix = collapse(suffix);

    let best = -1;
    let bestScore = -1;

    for (let from = 0; from <= index.text.length; ) {
      const at = index.text.indexOf(needle, from);
      if (at === -1) break;

      let score = 0;
      if (wantPrefix) {
        const before = index.text.slice(Math.max(0, at - wantPrefix.length), at);
        score += commonSuffixLength(before, wantPrefix);
      }
      if (wantSuffix) {
        const after = index.text.slice(at + needle.length, at + needle.length + wantSuffix.length);
        score += commonPrefixLength(after, wantSuffix);
      }

      if (score > bestScore) {
        bestScore = score;
        best = at;
      }
      // With no context to disambiguate, the first occurrence is as good as any.
      if (!wantPrefix && !wantSuffix) break;
      from = at + 1;
    }

    return best;
  }

  /**
   * Resolves a stored suggestion to the DOM position just after its passage.
   * Returns { node, offset } suitable for Range.setStart, or null if the
   * passage is not currently on the page.
   */
  function findAnchorPoint(root, postIt) {
    const index = buildTextIndex(root);
    if (!index.text) return null;

    const at = findBestOccurrence(index, postIt.highlighted_text, postIt.prefix, postIt.suffix);
    if (at === -1) return null;

    const length = normalizeQuery(postIt.highlighted_text).length;
    const endChar = at + length - 1;
    if (endChar < 0 || endChar >= index.nodes.length) return null;

    const node = index.nodes[endChar];
    if (!node || !node.parentNode) return null;

    const offset = Math.min(index.offsets[endChar] + 1, node.nodeValue.length);
    return { node, offset };
  }

  const CONTEXT_CHARS = 200;

  /**
   * Captures the text surrounding a selected passage, for storage alongside it.
   *
   * `startNode` is where the selection begins. We climb from there to the
   * nearest ancestor that contains the whole passage: the immediate parent is
   * not enough, since a selection starting inside <b>Greenwich</b> would see
   * only that one word and yield no usable context.
   */
  function captureContext(exact, startNode, root) {
    const needle = normalizeQuery(exact);
    if (!needle) return { prefix: '', suffix: '' };

    let block =
      startNode && startNode.nodeType === 1 /* ELEMENT_NODE */
        ? startNode
        : (startNode && startNode.parentElement) || null;

    for (let i = 0; block && i < 8; i += 1) {
      if (normalizeQuery(block.textContent || '').includes(needle)) break;
      block = block.parentElement;
    }
    if (!block) block = root || null;
    if (!block) return { prefix: '', suffix: '' };

    const context = normalizeQuery(block.textContent || '');
    const at = context.indexOf(needle);
    if (at === -1) return { prefix: '', suffix: '' };

    return {
      prefix: context.slice(Math.max(0, at - CONTEXT_CHARS), at),
      suffix: context.slice(at + needle.length, at + needle.length + CONTEXT_CHARS),
    };
  }

  globalThis.GreenwichAnchoring = {
    MARKER_CLASS,
    PANEL_CLASS,
    SKIPPED_TAGS,
    collapse,
    normalizeQuery,
    buildTextIndex,
    findBestOccurrence,
    findAnchorPoint,
    captureContext,
  };
})();
