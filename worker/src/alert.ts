/**
 * Pure alert decision logic: state transitions, confirmation, and dedup.
 *
 * State machine per (store, part) key — values stored in D1 inventory_state:
 *   0 = unavailable
 *   2 = pending confirmation (seen available once; the NEXT cron run confirms)
 *   1 = available & confirmed (alert already handled or suppressed)
 *
 * Confirmation without extra requests: a newly-available item is only marked
 * "pending"; the next scheduled run (60s later) is itself the confirmation —
 * the alert fires only if the item is STILL available on that fresh check.
 * An item that vanishes before confirmation is a near miss: no alert, state 0.
 *
 * Duplicate prevention: an alert is sent only on a pending → still-available
 * transition, and never twice for the same key within the cooldown window
 * (alert history persisted in D1, so it survives forever).
 */

import { stateKey, type PickupRecord } from "./availability";

export type AvailabilityState = 0 | 1 | 2;

export interface AlertDecision {
  /** Records to send a Telegram alert for right now (pending & confirmed & outside cooldown). */
  readonly alerts: PickupRecord[];
  /** Desired state changes (only keys whose value actually changed). */
  readonly stateUpdates: Map<string, AvailabilityState>;
}

export function computeAlertActions(
  records: readonly PickupRecord[],
  previousStates: ReadonlyMap<string, AvailabilityState>,
  lastAlertTimes: ReadonlyMap<string, number>,
  nowMs: number,
  cooldownMinutes: number,
): AlertDecision {
  const alerts: PickupRecord[] = [];
  const stateUpdates = new Map<string, AvailabilityState>();
  const cooldownMs = cooldownMinutes * 60_000;

  for (const record of records) {
    const key = stateKey(record.storeNumber, record.partNumber);
    const previous = previousStates.get(key);

    if (!record.available) {
      if (previous !== 0) {
        // Initial baseline write (previous undefined) or reset from pending/available.
        stateUpdates.set(key, 0);
      }
      continue;
    }

    if (previous === 1) {
      continue; // already known available; nothing to do
    }

    if (previous === 2) {
      // Pending and still available on the confirmation run.
      const lastAlert = lastAlertTimes.get(key);
      if (lastAlert !== undefined && nowMs - lastAlert < cooldownMs) {
        stateUpdates.set(key, 1); // duplicate alert suppressed by cooldown
      } else {
        alerts.push(record); // caller marks state 1 on successful send
        stateUpdates.set(key, 1);
      }
      continue;
    }

    // Fresh unavailable→available transition: mark pending, confirm next run.
    stateUpdates.set(key, 2);
  }

  return { alerts, stateUpdates };
}

/** Build the Telegram alert text: store, configuration, pickup details, link. */
export function buildAlertMessage(items: readonly PickupRecord[], buyUrl: string): string {
  const lines: string[] = ["🚨 iPhone Duo pickup available!", ""];
  for (const item of items) {
    lines.push(`📍 ${item.storeName}`);
    lines.push(`📱 ${item.productTitle || item.partNumber}`);
    if (item.pickupQuote) {
      lines.push(`🕒 ${item.pickupQuote}`);
    }
    lines.push("");
  }
  lines.push(`🔗 ${buyUrl}`);
  lines.push("Go reserve/order it yourself — this bot only alerts.");
  return lines.join("\n");
}
