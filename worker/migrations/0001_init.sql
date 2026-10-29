-- DuoRestockBot D1 schema.
-- available column values in inventory_state:
--   0 = unavailable for pickup
--   1 = available (confirmed; alert already handled)
--   2 = newly seen available, pending confirmation on the next cron run
-- Timestamps are epoch milliseconds (INTEGER).

CREATE TABLE IF NOT EXISTS inventory_state (
  store_number TEXT NOT NULL,
  part_number TEXT NOT NULL,
  available INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (store_number, part_number)
);

CREATE TABLE IF NOT EXISTS alerts (
  store_number TEXT NOT NULL,
  part_number TEXT NOT NULL,
  alerted_at INTEGER NOT NULL,
  PRIMARY KEY (store_number, part_number)
);

-- Single-row table (id = 1) tracking consecutive check failures and the
-- earliest time the next attempt should happen (exponential backoff gate).
CREATE TABLE IF NOT EXISTS failures (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  consecutive_failures INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL
);
