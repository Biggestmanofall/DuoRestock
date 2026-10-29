"""SQLite persistence: last-seen inventory states and alert deduplication.

Two tables:

- ``inventory_state``: the last observed availability for every
  (store, part) pair — used for unavailable→available transition detection
  and to survive restarts.
- ``alerts``: the last time an alert was sent for a (store, part) pair —
  used to suppress duplicate alerts within the configured cooldown window.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS inventory_state (
    store_number TEXT NOT NULL,
    part_number TEXT NOT NULL,
    available INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (store_number, part_number)
);
CREATE TABLE IF NOT EXISTS alerts (
    store_number TEXT NOT NULL,
    part_number TEXT NOT NULL,
    alerted_at TEXT NOT NULL,
    PRIMARY KEY (store_number, part_number)
);
"""


def utc_now() -> datetime:
    """Timezone-aware current UTC time (single source of truth for the codebase)."""
    return datetime.now(timezone.utc)


class StateDB:
    """Small SQLite wrapper for inventory states and alert history."""

    def __init__(self, path: str | Path) -> None:
        path_str = str(path)
        if path_str != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path_str)
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    def get_states(self) -> dict[tuple[str, str], bool]:
        """Return {(store_number, part_number): available} for all known pairs."""
        rows = self._conn.execute(
            "SELECT store_number, part_number, available FROM inventory_state"
        ).fetchall()
        return {(store, part): bool(available) for store, part, available in rows}

    def update_states(
        self,
        records: list[tuple[str, str, bool]],
        now: datetime | None = None,
    ) -> None:
        """Upsert availability for (store, part) pairs; records is [(store, part, available)]."""
        timestamp = (now or utc_now()).isoformat()
        self._conn.executemany(
            """
            INSERT INTO inventory_state (store_number, part_number, available, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(store_number, part_number) DO UPDATE SET
                available = excluded.available,
                updated_at = excluded.updated_at
            """,
            [(store, part, 1 if available else 0, timestamp) for store, part, available in records],
        )
        self._conn.commit()

    def last_alert(self, store_number: str, part_number: str) -> datetime | None:
        """Return the time of the last alert for a (store, part) pair, if any."""
        row = self._conn.execute(
            "SELECT alerted_at FROM alerts WHERE store_number = ? AND part_number = ?",
            (store_number, part_number),
        ).fetchone()
        if row is None or row[0] is None:
            return None
        return datetime.fromisoformat(row[0])

    def record_alert(
        self,
        store_number: str,
        part_number: str,
        now: datetime | None = None,
    ) -> None:
        """Record (upsert) that an alert was sent for a (store, part) pair."""
        timestamp = (now or utc_now()).isoformat()
        self._conn.execute(
            """
            INSERT INTO alerts (store_number, part_number, alerted_at)
            VALUES (?, ?, ?)
            ON CONFLICT(store_number, part_number) DO UPDATE SET
                alerted_at = excluded.alerted_at
            """,
            (store_number, part_number, timestamp),
        )
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()
