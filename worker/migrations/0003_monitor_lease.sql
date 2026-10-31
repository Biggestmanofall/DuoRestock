-- Single-row lease (id = 1) guaranteeing that only ONE monitoring check runs
-- across ALL Worker invocations at any time. Cloudflare does not guarantee
-- non-overlapping scheduled invocations, so the loop acquires this lease
-- before every Apple check and releases it (or lets it expire) afterwards.
-- held_until is epoch milliseconds; 0 means free.
CREATE TABLE IF NOT EXISTS monitor_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  held_until INTEGER NOT NULL
);
