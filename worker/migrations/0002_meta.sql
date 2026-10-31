-- Single-row metadata table for freshness tracking (dashboard support).
-- Written by runCheck only; read by the read-only /status endpoint.
CREATE TABLE IF NOT EXISTS meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  last_error_at INTEGER
);
