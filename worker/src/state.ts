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
