import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';

const anchoringSource = readFileSync(new URL('../extension/anchoring.js', import.meta.url), 'utf8');

/** Loads anchoring.js into a fresh jsdom document and returns its exports. */
function load(html) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, {
    runScripts: 'outside-only',
  });
  const { window } = dom;
  // anchoring.js assigns to globalThis; run it with the jsdom window as global.
  vm.runInContext(anchoringSource, dom.getInternalVMContext());
  return { dom, window, api: window.GreenwichAnchoring };
}

/** Anchors a passage and returns the resulting body HTML with a marker inserted. */
function anchorInto(html, postIt) {
  const { window, api } = load(html);
  const point = api.findAnchorPoint(window.document.body, postIt);
  if (!point) return null;
  const marker = window.document.createElement('sup');
  marker.className = 'greenwich-marker';
  marker.textContent = 'M';
  const range = window.document.createRange();
  range.setStart(point.node, point.offset);
  range.collapse(true);
  range.insertNode(marker);
  return window.document.body.innerHTML;
}

test('anchors a passage inside a single text node', () => {
  const html = anchorInto('<p>The Greenwich meridian is the reference.</p>', {
    highlighted_text: 'Greenwich meridian',
  });
  assert.match(html, /Greenwich meridian<sup class="greenwich-marker">M<\/sup>/);
});

test('anchors a passage that spans inline elements', () => {
  // The old node-by-node indexOf could never match this, which was the single
  // most common reason a suggestion silently failed to appear.
  const html = anchorInto('<p>the <b>Greenwich</b> meridian is here</p>', {
    highlighted_text: 'the Greenwich meridian',
  });
  assert.ok(html, 'should anchor across element boundaries');
  assert.match(html, /meridian<sup class="greenwich-marker">/);
});

test('anchors across a deeper mix of inline markup', () => {
  const html = anchorInto(
    '<p>See <em>the <b>Royal</b> <i>Observatory</i></em> at night</p>',
    { highlighted_text: 'the Royal Observatory' }
  );
  assert.ok(html, 'should anchor across nested inline elements');
  assert.match(html, /Observatory<sup class="greenwich-marker">/);
});

test('tolerates HTML indentation and collapsed whitespace', () => {
  const html = anchorInto(
    `<p>
        the   Greenwich
        meridian
     </p>`,
    { highlighted_text: 'the Greenwich meridian' }
  );
  assert.ok(html, 'normalized whitespace should still match');
});

test('matches a selection whose whitespace was collapsed by Chrome', () => {
  const html = anchorInto('<p>the\nGreenwich\tmeridian here</p>', {
    highlighted_text: 'the Greenwich meridian',
  });
  assert.ok(html, 'should match despite differing whitespace characters');
});

test('never inserts into script, style, or textarea content', () => {
  for (const html of [
    '<script>var x = "Greenwich meridian";</script>',
    '<style>/* Greenwich meridian */</style>',
    '<textarea>Greenwich meridian</textarea>',
    '<noscript>Greenwich meridian</noscript>',
  ]) {
    const result = anchorInto(html, { highlighted_text: 'Greenwich meridian' });
    assert.equal(result, null, `should refuse to anchor inside: ${html}`);
  }
});

test('never inserts into editable content', () => {
  const result = anchorInto('<div contenteditable="true">Greenwich meridian</div>', {
    highlighted_text: 'Greenwich meridian',
  });
  assert.equal(result, null);
});

test('skips hidden and aria-hidden subtrees', () => {
  assert.equal(
    anchorInto('<p hidden>Greenwich meridian</p>', { highlighted_text: 'Greenwich meridian' }),
    null
  );
  assert.equal(
    anchorInto('<p aria-hidden="true">Greenwich meridian</p>', {
      highlighted_text: 'Greenwich meridian',
    }),
    null
  );
});

test('prefers the occurrence matching the stored suffix', () => {
  const { window, api } = load(
    '<p>London is first. London is second.</p>'
  );
  const index = api.buildTextIndex(window.document.body);
  const at = api.findBestOccurrence(index, 'London', '', ' is second');
  const firstAt = index.text.indexOf('London');
  const secondAt = index.text.indexOf('London', firstAt + 1);
  assert.equal(at, secondAt, 'suffix context should select the second occurrence');
});

test('prefers the occurrence matching the stored prefix', () => {
  const { window, api } = load('<p>alpha target omega target</p>');
  const index = api.buildTextIndex(window.document.body);
  const at = api.findBestOccurrence(index, 'target', 'omega ', '');
  assert.equal(at, index.text.lastIndexOf('target'));
});

test('falls back to the first occurrence when no context is stored', () => {
  const { window, api } = load('<p>target and target</p>');
  const index = api.buildTextIndex(window.document.body);
  assert.equal(api.findBestOccurrence(index, 'target', '', ''), index.text.indexOf('target'));
});

test('returns -1 for a passage that is not on the page', () => {
  const { window, api } = load('<p>Nothing relevant here.</p>');
  const index = api.buildTextIndex(window.document.body);
  assert.equal(api.findBestOccurrence(index, 'Greenwich meridian', '', ''), -1);
});

test('returns -1 for an empty passage', () => {
  const { window, api } = load('<p>Some text</p>');
  const index = api.buildTextIndex(window.document.body);
  assert.equal(api.findBestOccurrence(index, '', '', ''), -1);
  assert.equal(api.findBestOccurrence(index, '   ', '', ''), -1);
});

test('findAnchorPoint returns null rather than throwing on a missing passage', () => {
  const { window, api } = load('<p>Some text</p>');
  assert.equal(api.findAnchorPoint(window.document.body, { highlighted_text: 'absent' }), null);
  assert.equal(api.findAnchorPoint(window.document.body, { highlighted_text: '' }), null);
});

test('ignores text inside already-placed Greenwich markers and panels', () => {
  const { window, api } = load(
    '<p>real text</p><div class="greenwich-panel"><p>real text</p></div>'
  );
  const index = api.buildTextIndex(window.document.body);
  // "real text" must appear exactly once: the panel copy is excluded.
  assert.equal(index.text.split('real text').length - 1, 1);
});

test('the built index maps every character back to a live text node', () => {
  const { window, api } = load('<p>the <b>Greenwich</b> meridian</p>');
  const index = api.buildTextIndex(window.document.body);
  assert.equal(index.text, 'the Greenwich meridian');
  assert.equal(index.nodes.length, index.text.length);
  assert.equal(index.offsets.length, index.text.length);
  for (let i = 0; i < index.text.length; i += 1) {
    const node = index.nodes[i];
    assert.ok(node && node.nodeValue, `character ${i} should map to a text node`);
    // Space characters are synthesized at a boundary, so only assert on others.
    if (index.text[i] !== ' ') {
      assert.equal(node.nodeValue[index.offsets[i]], index.text[i], `mismatch at ${i}`);
    }
  }
});

test('normalizeQuery collapses whitespace and trims', () => {
  const { api } = load('');
  assert.equal(api.normalizeQuery('  a\n\tb   c  '), 'a b c');
  assert.equal(api.normalizeQuery(''), '');
  assert.equal(api.normalizeQuery(null), '');
  assert.equal(api.normalizeQuery(undefined), '');
});

test('anchors the last of many repeated passages when suffix disambiguates', () => {
  const html = anchorInto(
    '<p>tide tide tide end</p>',
    { highlighted_text: 'tide', prefix: 'tide tide ', suffix: ' end' }
  );
  assert.ok(html);
  // The marker should land on the third "tide", immediately before " end".
  assert.match(html, /tide tide tide<sup class="greenwich-marker">M<\/sup> end/);
});

// --- captureContext, and the full capture -> store -> re-anchor round trip ---

test('captureContext climbs past inline markup to find real context', () => {
  const { window, api } = load(
    '<p>Writing about the <b>Greenwich</b> meridian and time zones.</p>'
  );
  const bold = window.document.querySelector('b');
  // Selection starts inside <b>, whose own text is just "Greenwich".
  const ctx = api.captureContext('the Greenwich meridian', bold.firstChild, window.document.body);
  assert.equal(ctx.prefix, 'Writing about ');
  assert.equal(ctx.suffix, ' and time zones.');
});

test('captureContext returns empty context rather than throwing on bad input', () => {
  const { window, api } = load('<p>text</p>');
  // Compared field by field: objects built inside the jsdom realm do not share
  // this realm's Object.prototype, so a strict deep-equal would reject them.
  for (const args of [
    ['', null],
    ['absent phrase', null],
    [null, null],
  ]) {
    const ctx = api.captureContext(args[0], args[1], window.document.body);
    assert.equal(ctx.prefix, '');
    assert.equal(ctx.suffix, '');
  }
});

test('captureContext caps context length', () => {
  const filler = 'word '.repeat(100);
  const { window, api } = load(`<p>${filler}TARGET ${filler}</p>`);
  const ctx = api.captureContext('TARGET', window.document.querySelector('p').firstChild, window.document.body);
  assert.ok(ctx.prefix.length <= 200, `prefix was ${ctx.prefix.length}`);
  assert.ok(ctx.suffix.length <= 200, `suffix was ${ctx.suffix.length}`);
});

test('round trip: captured context re-anchors to the same occurrence', () => {
  // Three identical passages; only the stored context distinguishes them.
  const html =
    '<p id="a">In London the <b>meridian</b> line is first.</p>' +
    '<p id="b">In Paris the <b>meridian</b> line is second.</p>' +
    '<p id="c">In Berlin the <b>meridian</b> line is third.</p>';

  const { window, api } = load(html);
  const target = window.document.querySelector('#b b');

  // 1. Capture, as the content script does when the user right-clicks.
  const exact = 'the meridian line';
  const ctx = api.captureContext(exact, target.firstChild, window.document.body);
  assert.ok(ctx.prefix || ctx.suffix, 'should capture some context');

  // 2. Re-anchor from the stored values, as a later page load does.
  const point = api.findAnchorPoint(window.document.body, {
    highlighted_text: exact,
    prefix: ctx.prefix,
    suffix: ctx.suffix,
  });
  assert.ok(point, 'should re-anchor');

  const marker = window.document.createElement('sup');
  marker.className = 'greenwich-marker';
  const range = window.document.createRange();
  range.setStart(point.node, point.offset);
  range.collapse(true);
  range.insertNode(marker);

  // 3. The marker must land in the Paris paragraph, not the first one.
  assert.equal(marker.closest('p').id, 'b', 'marker landed in the wrong paragraph');
});

test('round trip picks the first occurrence for genuinely identical context', () => {
  const html = '<p id="a">the meridian line</p><p id="b">the meridian line</p>';
  const { window, api } = load(html);
  const point = api.findAnchorPoint(window.document.body, {
    highlighted_text: 'the meridian line',
    prefix: '',
    suffix: '',
  });
  assert.ok(point);
  const marker = window.document.createElement('sup');
  marker.className = 'greenwich-marker';
  const range = window.document.createRange();
  range.setStart(point.node, point.offset);
  range.collapse(true);
  range.insertNode(marker);
  assert.equal(marker.closest('p').id, 'a');
});
