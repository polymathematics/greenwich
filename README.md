# Greenwich

Suggest related links for any webpage and view existing suggestions from other
users. Select a passage, right-click, suggest a link; a 🚇 marker appears after
that passage for everyone who visits the page, and clicking it shows the
suggestion. We call this collective contextualization.

```
extension/   the Chrome extension (MV3) — load this directory unpacked
worker/      the API: a Cloudflare Worker backed by D1 (SQLite)
test/        extension tests (jsdom)
```

## Running it

### 1. Deploy the backend

The previous backend (`greenwich-for-chrome.replit.app`) is gone — it now
returns a 404 HTML page, which is why no suggestions appeared. This replaces it.

```bash
cd worker
npm install

npx wrangler login
npx wrangler d1 create greenwich     # prints a database_id
```

Paste that `database_id` into [worker/wrangler.toml](worker/wrangler.toml), then
create the tables and deploy:

```bash
npm run db:init:remote               # applies schema.sql to the live database
npm run deploy                       # prints https://greenwich.<you>.workers.dev
```

### 2. Point the extension at it

Put the deployed URL in `DEFAULT_API_BASE` at the top of
[extension/background.js](extension/background.js#L9). Until that is set, the
extension stays quiet and reports "Greenwich is not configured with a server URL
yet" rather than failing silently.

### 3. Load the extension

`chrome://extensions` → enable Developer mode → **Load unpacked** →
select the `extension/` directory (not the repository root).

## Local development

```bash
cd worker
npm run db:init:local                # one time
npm run dev                          # http://localhost:8787
```

Point the extension at the local server without editing any code — the API base
can be overridden at runtime from the extension's service worker console
(`chrome://extensions` → Greenwich → "service worker"):

```js
chrome.storage.local.set({ apiBase: 'http://localhost:8787' })
```

Remove the override with `chrome.storage.local.remove('apiBase')`.

Server-side logs from the deployed Worker: `npm run tail`.

## Tests

```bash
npm test               # both suites
npm run test:extension # anchoring, under jsdom
npm run test:worker    # URL normalization and payload validation
```

The two suites cover the parts that fail quietly in a browser: `test/` checks
that a stored passage anchors to the right place in a real DOM (including across
inline markup, and never inside `<script>` or a textarea), and `worker/test/`
checks that every URL and field is validated before it can reach a page.

## API

Base URL: your deployed Worker.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness check. |
| `GET` | `/postits?url=<page url>` | Visible suggestions for a page. Always 200; an unsupported URL returns `{"postIts":[]}`. |
| `POST` | `/postits` | Create a suggestion. `201`, or `400` invalid, `409` duplicate, `429` rate limited. |
| `POST` | `/postits/:id/report` | Flag a suggestion. Three reports hide it. |

`GET /getPostIts?sourceUrl=` and `POST /addPostIt` are kept as aliases so copies
of extension v1.1 that are still installed keep working.

Create payload:

```json
{
  "source_url": "https://en.wikipedia.org/wiki/Greenwich",
  "highlighted_text": "the Greenwich meridian",
  "prefix": "about ",
  "suffix": " and time",
  "suggested_link": "https://www.rmg.co.uk/prime-meridian",
  "description": "How the prime meridian was chosen."
}
```

`prefix` and `suffix` are the text immediately around the passage. They are
optional, and they are what lets a repeated phrase anchor to the right
occurrence, so the extension always sends them.

## How it fits together

The service worker is the only component that touches the network. The content
script and the popup ask it for data over `chrome.runtime` messages:

```
content script ──"getPostIts"──▶ service worker ──▶ Worker API ──▶ D1
     │                                 │
     │◀────── suggestions ─────────────┘
     └─ anchors each passage, inserts a 🚇 marker

popup ──"createPostIt"──▶ service worker ──▶ POST /postits
                               └──"postItAdded"──▶ content script (renders it)
```

Earlier versions passed data between these parts through shared
`chrome.storage.local` keys, which raced against a fixed 1.5-second delay and
leaked one tab's suggestions into another. Request/response messaging removes
both failure modes.

## Anchoring

A suggestion is stored as the quoted text plus its surrounding context, not as a
DOM path, so it survives a page being re-rendered or restyled.
[extension/anchoring.js](extension/anchoring.js) builds a whitespace-normalized
index of the page's visible text, each character mapped back to its text node,
then picks the occurrence whose neighbours best match the stored prefix/suffix.

That index is what lets a passage spanning inline markup —
`the <b>Greenwich</b> meridian` — match at all, and it excludes `<script>`,
`<style>`, `<textarea>`, `<pre>`, editable regions and hidden subtrees so a
marker can never be injected into code or into something the user is typing.

Content that loads after the first pass is handled by a bounded
`MutationObserver` (8 retries, then it stops) rather than a fixed delay.

## Privacy and abuse

- A page URL is sent to the server only for `http`/`https` pages. `localhost`,
  `*.local`, and RFC1918 / link-local addresses are filtered out in
  [extension/background.js](extension/background.js) before any request is made,
  so intranet URLs stay internal.
- URL fragments and common tracking parameters (`utm_*`, `fbclid`, …) are
  stripped before storage, so suggestions attach to the page rather than to one
  referral path.
- Responses are cached for 60 seconds per page, so revisiting a page does not
  re-query the server.
- Writes are anonymous but validated and rate limited to 10 per IP per hour.
  Links are restricted to `http`/`https`, which is what stops a `javascript:`
  URL from being stored and then rendered into someone's page.
- The extension renders every server-supplied value with `textContent` and
  validates link protocols again at render time. The server's validation is the
  first line, not the only one.

Anyone can still post anything within those limits. If this goes beyond a small
group, the next step is accounts, or moderation before a suggestion becomes
visible to others.

## Known limits

- A passage that no longer appears on the page (edited article, paywalled
  content) will not anchor, and its suggestion is silently not shown.
- Only the main frame is annotated; content inside iframes is skipped.
- At most 200 suggestions are served per page, and 50 are anchored per pass.
- `chrome.action.openPopup()` needs Chrome 127+. On older versions, or when no
  window is focused, the toolbar icon shows a badge and clicking it opens the
  same form.
