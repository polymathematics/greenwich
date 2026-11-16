// Greenwich API — Cloudflare Worker + D1.
//
// Routes:
//   GET  /health
//   GET  /postits?url=<page url>        -> { postIts: [...] }
//   POST /postits                      -> { postIt: {...} }
//   POST /postits/:id/report           -> { ok: true }
//
// Legacy aliases kept so older installed copies of the extension keep working:
//   GET  /getPostIts?sourceUrl=<url>
//   POST /addPostIt

import { validateSuggestion, normalizeUrl } from './validate.js';

const WRITES_PER_HOUR = 10;
const REPORTS_TO_HIDE = 3;
const MAX_BODY_BYTES = 16 * 1024;
const WINDOW_MS = 60 * 60 * 1000;

const CORS = {
  // The extension's origin is chrome-extension://<id>, which varies per install
  // and per developer. No credentials are ever sent, so "*" is safe here.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS,
      ...extraHeaders,
    },
  });
}

function fail(status, error) {
  return json({ error }, status);
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

/**
 * Fixed-window counter in D1. Returns { allowed, retryAfterSeconds }.
 * Fails open: if the limiter itself errors we would rather serve the write
 * than hand every user a 500.
 */
async function checkRateLimit(env, ip, now) {
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const bucket = `${ip}:${windowStart}`;
  try {
    await env.DB.prepare(
      `INSERT INTO rate_limit (bucket, count, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT(bucket) DO UPDATE SET count = count + 1`
    )
      .bind(bucket, windowStart)
      .run();

    const row = await env.DB.prepare('SELECT count FROM rate_limit WHERE bucket = ?1')
      .bind(bucket)
      .first();

    const count = row ? Number(row.count) : 1;
    if (count > WRITES_PER_HOUR) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((windowStart + WINDOW_MS - now) / 1000)),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  } catch (err) {
    console.error('rate limit check failed', err);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

async function pruneRateLimit(env, now) {
  try {
    await env.DB.prepare('DELETE FROM rate_limit WHERE window_start < ?1')
      .bind(now - 2 * WINDOW_MS)
      .run();
  } catch (err) {
    console.error('rate limit prune failed', err);
  }
}

async function readJsonBody(request) {
  const length = Number(request.headers.get('Content-Length') || '0');
  if (length > MAX_BODY_BYTES) return { ok: false, error: 'Request body too large.' };

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, error: 'Request body too large.' };
  if (!text) return { ok: false, error: 'Request body is empty.' };

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: 'Request body is not valid JSON.' };
  }
}

async function listPostIts(env, rawUrl) {
  const sourceUrl = normalizeUrl(rawUrl);
  // An unsupported page (chrome://, file://, a malformed URL) simply has no
  // suggestions. That is a normal empty result, not a client error.
  if (!sourceUrl) return json({ postIts: [] });

  const { results } = await env.DB.prepare(
    `SELECT id, source_url, highlighted_text, prefix, suffix, suggested_link, description, created_at
       FROM postits
      WHERE source_url = ?1 AND hidden = 0
      ORDER BY created_at ASC
      LIMIT 200`
  )
    .bind(sourceUrl)
    .all();

  return json({ postIts: results ?? [] });
}

async function createPostIt(env, request, now) {
  const body = await readJsonBody(request);
  if (!body.ok) return fail(400, body.error);

  const validated = validateSuggestion(body.value);
  if (!validated.ok) return fail(400, validated.error);

  const ip = clientIp(request);
  const limit = await checkRateLimit(env, ip, now);
  if (!limit.allowed) {
    return json(
      { error: `Rate limit reached (${WRITES_PER_HOUR} suggestions per hour). Try again later.` },
      429,
      { 'Retry-After': String(limit.retryAfterSeconds) }
    );
  }

  const row = {
    id: crypto.randomUUID(),
    ...validated.value,
    created_at: now,
    client_id: typeof body.value.client_id === 'string' ? body.value.client_id.slice(0, 64) : '',
  };

  try {
    await env.DB.prepare(
      `INSERT INTO postits
         (id, source_url, highlighted_text, prefix, suffix, suggested_link, description, created_at, client_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    )
      .bind(
        row.id,
        row.source_url,
        row.highlighted_text,
        row.prefix,
        row.suffix,
        row.suggested_link,
        row.description,
        row.created_at,
        row.client_id
      )
      .run();
  } catch (err) {
    // Hits the unique dedupe index when the same suggestion already exists.
    if (String(err).includes('UNIQUE')) {
      return fail(409, 'That link has already been suggested for this passage.');
    }
    throw err;
  }

  await pruneRateLimit(env, now);
  return json({ postIt: row }, 201);
}

async function reportPostIt(env, id) {
  const result = await env.DB.prepare(
    `UPDATE postits
        SET reports = reports + 1,
            hidden  = CASE WHEN reports + 1 >= ?2 THEN 1 ELSE hidden END
      WHERE id = ?1`
  )
    .bind(id, REPORTS_TO_HIDE)
    .run();

  if (!result.meta || result.meta.changes === 0) return fail(404, 'No such suggestion.');
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const now = Date.now();

    try {
      if (!env.DB) return fail(503, 'Database is not configured on this deployment.');

      if (request.method === 'GET' && (path === '/health' || path === '/')) {
        return json({ ok: true, service: 'greenwich', time: new Date(now).toISOString() });
      }

      if (request.method === 'GET' && path === '/postits') {
        return await listPostIts(env, url.searchParams.get('url'));
      }

      // Legacy read path used by extension versions <= 1.1.
      if (request.method === 'GET' && path === '/getPostIts') {
        return await listPostIts(env, url.searchParams.get('sourceUrl'));
      }

      if (request.method === 'POST' && (path === '/postits' || path === '/addPostIt')) {
        return await createPostIt(env, request, now);
      }

      const report = path.match(/^\/postits\/([A-Za-z0-9-]{1,64})\/report$/);
      if (request.method === 'POST' && report) {
        return await reportPostIt(env, report[1]);
      }

      return fail(404, 'Not found.');
    } catch (err) {
      // Never leak internals to the client, but make it findable in `wrangler tail`.
      console.error('unhandled error', request.method, path, err);
      return fail(500, 'Internal error.');
    }
  },
};
