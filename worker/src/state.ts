/**
 * D1 persistence: last-known availability states, alert history, and the
 * consecutive-failure backoff gate. All timestamps are epoch milliseconds.
 *
 * The SQL here is exercised against real D1 (miniflare) during local
 * development and after deployment; unit tests use an in-memory contract mock.
 */

import type { D1Database } from "@cloudflare/workers-types";
import type { AvailabilityState } from "./alert";

export interface FailureState {
  readonly consecutiveFailures: number;
  readonly nextAttemptAt: number;
}

export interface StateRow {
  store_number: string;
  part_number: string;
  available: number;
}

export interface AlertRow {
  store_number: string;
  part_number: string;
  alerted_at: number;
}

export function rowToAvailabilityState(value: number): AvailabilityState {
  if (value === 1) return 1;
  if (value === 2) return 2;
  return 0;
}

export async function getStates(db: D1Database): Promise<Map<string, AvailabilityState>> {
  const result = await db
    .prepare("SELECT store_number, part_number, available FROM inventory_state")
    .all<StateRow>();
  const states = new Map<string, AvailabilityState>();
  for (const row of result.results ?? []) {
    states.set(`${row.store_number}:${row.part_number}`, rowToAvailabilityState(row.available));
  }
  return states;
}

export interface StateUpdateEntry {
  readonly storeNumber: string;
  readonly partNumber: string;
  readonly available: AvailabilityState;
}

export async function upsertStates(
  db: D1Database,
  entries: readonly StateUpdateEntry[],
  updatedAtMs: number,
): Promise<void> {
  if (entries.length === 0) return;
  const statements = entries.map((entry) =>
    db
      .prepare(
        `INSERT INTO inventory_state (store_number, part_number, available, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(store_number, part_number) DO UPDATE SET
           available = excluded.available,
           updated_at = excluded.updated_at`,
      )
      .bind(entry.storeNumber, entry.partNumber, entry.available, updatedAtMs),
  );
  await db.batch(statements);
}

export async function getLastAlertTimes(db: D1Database): Promise<Map<string, number>> {
  const result = await db
    .prepare("SELECT store_number, part_number, alerted_at FROM alerts")
    .all<AlertRow>();
  const alerts = new Map<string, number>();
  for (const row of result.results ?? []) {
    alerts.set(`${row.store_number}:${row.part_number}`, row.alerted_at);
  }
  return alerts;
}

export async function recordAlerts(
  db: D1Database,
  keys: readonly (readonly [string, string])[],
  alertedAtMs: number,
): Promise<void> {
  if (keys.length === 0) return;
  const statements = keys.map(([storeNumber, partNumber]) =>
    db
      .prepare(
        `INSERT INTO alerts (store_number, part_number, alerted_at)
         VALUES (?, ?, ?)
         ON CONFLICT(store_number, part_number) DO UPDATE SET
           alerted_at = excluded.alerted_at`,
      )
      .bind(storeNumber, partNumber, alertedAtMs),
  );
  await db.batch(statements);
}

export async function getFailureState(db: D1Database): Promise<FailureState | null> {
  interface FailureRow {
    consecutive_failures: number;
    next_attempt_at: number;
  }
  const row = await db
    .prepare("SELECT consecutive_failures, next_attempt_at FROM failures WHERE id = 1")
    .first<FailureRow>();
  if (!row) return null;
  return { consecutiveFailures: row.consecutive_failures, nextAttemptAt: row.next_attempt_at };
}

export async function recordFailure(
  db: D1Database,
  consecutiveFailures: number,
  nextAttemptAtMs: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO failures (id, consecutive_failures, next_attempt_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         consecutive_failures = excluded.consecutive_failures,
         next_attempt_at = excluded.next_attempt_at`,
    )
    .bind(consecutiveFailures, nextAttemptAtMs)
    .run();
}

export async function clearFailure(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM failures WHERE id = 1").run();
}

// --------------------------------------------------------------- monitor lease

/**
 * Atomic lease acquisition: returns true if this invocation now EXCLUSIVELY
 * holds the monitor lease until nowMs + holdForMs.
 *
 * Implemented as a single conditional upsert — D1 serializes writes, so when
 * two overlapping invocations race, exactly one gets changes > 0. A lease
 * that has expired (held_until <= nowMs) is always acquirable, which is also
 * the crash-recovery path: a dead invocation's lease self-expires.
 */
export async function acquireMonitorLease(
  db: D1Database,
  nowMs: number,
  holdForMs: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO monitor_lease (id, held_until)
       VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET held_until = excluded.held_until
       WHERE monitor_lease.held_until <= ?`,
    )
    .bind(nowMs + holdForMs, nowMs)
    .run();
  // meta.changes is verified present against the real D1 binding (workerd);
  // rows_written is a defensive fallback with identical semantics here (a
  // denied upsert writes nothing, an acquired one writes exactly one row).
  const meta = (result.meta ?? {}) as { changes?: number; rows_written?: number };
  const changes = meta.changes ?? meta.rows_written ?? 0;
  return changes > 0;
}

/** Release the lease immediately after a check completes (expiry is the backstop). */
export async function releaseMonitorLease(db: D1Database): Promise<void> {
  await db
    .prepare("UPDATE monitor_lease SET held_until = 0 WHERE id = 1")
    .run();
}

// ------------------------------------------------------------------- metadata

/** Freshness metadata persisted by runCheck; read by the /status endpoint. */
export interface MetaRow {
  readonly lastAttemptAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly lastError: string | null;
  readonly lastErrorAt: number | null;
}

interface MetaDbRow {
  last_attempt_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
}

export async function getMeta(db: D1Database): Promise<MetaRow | null> {
  const row = await db
    .prepare(
      "SELECT last_attempt_at, last_success_at, last_error, last_error_at FROM meta WHERE id = 1",
    )
    .first<MetaDbRow>();
  if (!row) return null;
  return {
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
  };
}

/** Record that a check is actually being attempted (not a gated/backing-off run). */
export async function markAttempt(db: D1Database, atMs: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meta (id, last_attempt_at)
       VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at`,
    )
    .bind(atMs)
    .run();
}

/** Record a successful (parsed and validated) check. */
export async function markSuccess(db: D1Database, atMs: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meta (id, last_success_at)
       VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET last_success_at = excluded.last_success_at`,
    )
    .bind(atMs)
    .run();
}

/** Record a failed check with its error message (never "unavailable"). */
export async function markError(db: D1Database, message: string, atMs: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meta (id, last_error, last_error_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_error = excluded.last_error,
         last_error_at = excluded.last_error_at`,
    )
    .bind(message, atMs)
    .run();
}

// ------------------------------------------------------------ full state rows

export interface StateRowWithTimestamp {
  readonly available: AvailabilityState;
  readonly updatedAt: number;
}

/**
 * Full inventory rows including updated_at (last time THAT pair's state
 * changed), used by the /status endpoint. NOTE: updated_at is the last
 * CHANGE, not the last check — global freshness comes from getMeta().
 */
export async function getStateRows(
  db: D1Database,
): Promise<Map<string, StateRowWithTimestamp>> {
  const result = await db
    .prepare("SELECT store_number, part_number, available, updated_at FROM inventory_state")
    .all<StateRow & { updated_at: number }>();
  const rows = new Map<string, StateRowWithTimestamp>();
  for (const row of result.results ?? []) {
    rows.set(`${row.store_number}:${row.part_number}`, {
      available: rowToAvailabilityState(row.available),
      updatedAt: row.updated_at,
    });
  }
  return rows;
}
