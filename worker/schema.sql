-- Greenwich D1 schema.
-- Apply with:
--   npx wrangler d1 execute greenwich --local --file=./schema.sql    (local dev)
--   npx wrangler d1 execute greenwich --remote --file=./schema.sql   (production)

CREATE TABLE IF NOT EXISTS postits (
  id               TEXT    PRIMARY KEY,
  source_url       TEXT    NOT NULL,          -- normalized page URL
  highlighted_text TEXT    NOT NULL,          -- the quoted passage
  prefix           TEXT    NOT NULL DEFAULT '', -- text immediately before the quote
  suffix           TEXT    NOT NULL DEFAULT '', -- text immediately after the quote
  suggested_link   TEXT    NOT NULL,
  description      TEXT    NOT NULL,
  created_at       INTEGER NOT NULL,          -- epoch ms
  client_id        TEXT    NOT NULL DEFAULT '', -- anonymous per-install id
  reports          INTEGER NOT NULL DEFAULT 0,
  hidden           INTEGER NOT NULL DEFAULT 0 -- soft delete; hidden rows are never served
);

-- The only read path: "give me the visible suggestions for this page".
CREATE INDEX IF NOT EXISTS idx_postits_lookup
  ON postits (source_url, hidden, created_at);

-- Lets a repeat submission of the same suggestion be rejected cheaply.
CREATE UNIQUE INDEX IF NOT EXISTS idx_postits_dedupe
  ON postits (source_url, highlighted_text, suggested_link);

-- Fixed-window rate limiting. One row per (ip, window); old rows are pruned
-- opportunistically on write.
CREATE TABLE IF NOT EXISTS rate_limit (
  bucket       TEXT    PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_window
  ON rate_limit (window_start);
