// Pure helpers for URL normalization and payload validation.
// No Workers-specific APIs in here so it can be unit tested under plain node.

export const LIMITS = {
  sourceUrl: 2048,
  suggestedLink: 2048,
  highlightedText: 1000,
  description: 1000,
  context: 200,
};

// Query params that identify a campaign, not a page. Stripping them keeps
// suggestions attached to the page itself rather than to one referral path.
const TRACKING_PARAMS = [
  /^utm_/i,
  /^(fbclid|gclid|dclid|gbraid|wbraid|msclkid|igshid|mc_eid|mc_cid|yclid|twclid|ttclid)$/i,
  /^ref(_src|_url)?$/i,
  /^(si|share_id)$/i,
];

function isTracking(name) {
  return TRACKING_PARAMS.some((re) => re.test(name));
}

/**
 * Canonical key for a page. Suggestions anchor to the page, so two URLs that
 * render the same page must produce the same key.
 * Returns null for anything we refuse to store.
 */
export function normalizeUrl(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > LIMITS.sourceUrl) return null;

  let u;
  try {
    u = new URL(input);
  } catch {
    return null;
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // Embedded credentials are a phishing vector and never part of page identity.
  if (u.username || u.password) return null;
  if (!u.hostname) return null;

  u.hash = '';
  u.hostname = u.hostname.toLowerCase();

  // new URL() already drops the port when it matches the protocol default.
  for (const name of [...u.searchParams.keys()]) {
    if (isTracking(name)) u.searchParams.delete(name);
  }
  u.searchParams.sort();

  let out = u.toString();
  // "https://x.com/" and "https://x.com" are the same page.
  if (u.pathname === '/' && !u.search) out = out.replace(/\/$/, '');
  return out;
}

/** A link we are willing to render as a clickable anchor inside a page. */
export function normalizeLink(input) {
  if (typeof input !== 'string') return null;
  let candidate = input.trim();
  if (!candidate || candidate.length > LIMITS.suggestedLink) return null;

  // Accept "example.com/page" the way a browser address bar would.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) candidate = `https://${candidate}`;

  let u;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  // Blocks javascript:, data:, blob:, file: and friends.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || !u.hostname.includes('.')) return null;
  if (u.username || u.password) return null;
  return u.toString();
}

// Strips characters that would corrupt rendering or smuggle markup intent.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = collapse(value).trim();
  if (!text || text.length > max) return null;
  return text;
}

function collapse(value) {
  return value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ');
}

/**
 * Anchor context, collapsed but NOT trimmed and never rejected.
 *
 * The whitespace immediately adjacent to the quoted passage is what lets the
 * client tell two occurrences of the same phrase apart, so trimming it here
 * would silently degrade anchoring accuracy.
 */
function cleanContext(value, max, keep) {
  if (typeof value !== 'string') return '';
  const text = collapse(value);
  return keep === 'end' ? text.slice(-max) : text.slice(0, max);
}

/**
 * Validates a suggestion submission.
 * Returns { ok: true, value } or { ok: false, error } with a user-showable message.
 */
export function validateSuggestion(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Expected a JSON object.' };

  const sourceUrl = normalizeUrl(body.source_url);
  if (!sourceUrl) return { ok: false, error: 'source_url must be an http(s) page URL.' };

  const suggestedLink = normalizeLink(body.suggested_link);
  if (!suggestedLink) return { ok: false, error: 'suggested_link must be an http(s) URL.' };

  const highlightedText = cleanText(body.highlighted_text, LIMITS.highlightedText);
  if (!highlightedText) {
    return { ok: false, error: `highlighted_text is required (max ${LIMITS.highlightedText} characters).` };
  }

  const description = cleanText(body.description, LIMITS.description);
  if (!description) {
    return { ok: false, error: `description is required (max ${LIMITS.description} characters).` };
  }

  // Context is optional; it only improves anchoring accuracy.
  const prefix = cleanContext(body.prefix, LIMITS.context, 'end');
  const suffix = cleanContext(body.suffix, LIMITS.context, 'start');

  return {
    ok: true,
    value: {
      source_url: sourceUrl,
      suggested_link: suggestedLink,
      highlighted_text: highlightedText,
      description,
      prefix,
      suffix,
    },
  };
}
