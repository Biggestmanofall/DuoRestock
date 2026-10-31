/**
 * One availability check — the full orchestration, fully injectable for tests.
 *
 * Guarantees (mirroring the verified Python implementation):
 * - One HTTP request per invocation (all stores × all parts in one call).
 * - The backoff gate skips invocations entirely after failures — failures
 *   REDUCE request volume; they never masquerade as "unavailable".
 * - Ambiguous or failed responses throw / count as failures; no state is
 *   written and no alert is sent for them.
 * - An empty record set (valid response but no monitored stores) is treated as
 *   ambiguous and counts as a failure, never as "all unavailable".
 * - Confirmation: new availability is only marked pending; the alert fires on
 *   the NEXT run if still available (zero extra requests).
 * - Alert-only: the only outbound calls are Apple GET and Telegram sendMessage.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { fetchPickupBody } from "./apple";
import { buildAlertMessage, computeAlertActions, type AlertDecision } from "./alert";
import { APPLE, MONITOR, MONITORED_STORE_NUMBERS, buildPickupUrl } from "./config";
import { parsePickupResponse, stateKey, type PickupRecord } from "./availability";
import {
  clearFailure,
  getFailureState,
  getLastAlertTimes,
  getStates,
  markAttempt,
  markError,
  markSuccess,
  recordAlerts,
  recordFailure,
  upsertStates,
  type StateUpdateEntry,
} from "./state";
import { sendTelegramMessage, type TelegramConfig } from "./telegram";

export type FetchLike = typeof fetch;

export interface RunDeps {
  readonly db: D1Database;
  readonly telegram: TelegramConfig;
  readonly nowMs: () => number;
  readonly fetchImpl: FetchLike;
}

export type RunOutcome =
  | { status: "ok"; checked: number; availableNow: number; alertsSent: number; suppressed: number }
  | { status: "backing-off"; nextAttemptAt: number }
  | { status: "error"; message: string; backoffSeconds: number };

function backoffSecondsFor(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(MONITOR.backoffInitialSeconds * 2 ** exponent, MONITOR.backoffMaxSeconds);
}

export async function runCheck(deps: RunDeps): Promise<RunOutcome> {
  const now = deps.nowMs();

  // 1. Backoff gate: skip this invocation entirely if we are not due yet.
  const failure = await getFailureState(deps.db);
  if (failure && failure.nextAttemptAt > now) {
    return { status: "backing-off", nextAttemptAt: failure.nextAttemptAt };
  }

  // 1.5 This invocation will actually hit Apple (not gated): record the attempt
  //     timestamp for the dashboard's freshness display.
  await markAttempt(deps.db, now);

  // 2. Fetch + parse. ANY failure here counts as a failed check (never "unavailable").
  let records: PickupRecord[];
  try {
    const body = await fetchPickupBody(buildPickupUrl(), APPLE.userAgent, deps.fetchImpl);
    records = parsePickupResponse(body, MONITORED_STORE_NUMBERS);
    if (records.length === 0) {
      throw new Error("valid response contained no records for the monitored stores");
    }
  } catch (error) {
    const consecutive = (failure?.consecutiveFailures ?? 0) + 1;
    const backoff = backoffSecondsFor(consecutive);
    const message = error instanceof Error ? error.message : "unknown error";
    await recordFailure(deps.db, consecutive, now + backoff * 1000);
    await markError(deps.db, message, now);
    return { status: "error", message, backoffSeconds: backoff };
  }

  // 3. Successful check: reset the backoff gate and record freshness.
  await clearFailure(deps.db);
  await markSuccess(deps.db, now);

  // 4. Diff against persisted state and decide alerts.
  const states = await getStates(deps.db);
  const lastAlerts = await getLastAlertTimes(deps.db);
  const decision: AlertDecision = computeAlertActions(
    records,
    states,
    lastAlerts,
    now,
    MONITOR.cooldownMinutes,
  );
  const attemptedAlertKeys = new Set(
    decision.alerts.map((item) => stateKey(item.storeNumber, item.partNumber)),
  );

  // 5. Send the alert (if any). On Telegram failure the keys stay "pending" (2)
  //    so the transition re-triggers and the alert is retried next run.
  const succeededAlertKeys = new Set<string>();
  if (decision.alerts.length > 0) {
    const message = buildAlertMessage(decision.alerts, APPLE.buyUrl);
    try {
      await sendTelegramMessage(deps.telegram, message, deps.fetchImpl);
      await recordAlerts(
        deps.db,
        decision.alerts.map((item) => [item.storeNumber, item.partNumber] as const),
        now,
      );
      for (const key of attemptedAlertKeys) succeededAlertKeys.add(key);
    } catch {
      // Deliberately swallowed: keys remain pending, retried next run.
    }
  }

  // 6. Persist state changes (writes only for keys whose value actually changed).
  const entries: StateUpdateEntry[] = [];
  for (const [key, desired] of decision.stateUpdates) {
    let finalValue: 0 | 1 | 2 = desired;
    if (desired === 1 && attemptedAlertKeys.has(key) && !succeededAlertKeys.has(key)) {
      finalValue = 2; // alert send failed: keep pending so it retries next run
    }
    const [storeNumber, partNumber] = key.split(":");
    if (storeNumber === undefined || partNumber === undefined) continue;
    entries.push({ storeNumber, partNumber, available: finalValue });
  }
  await upsertStates(deps.db, entries, now);

  const availableNow = records.filter((record) => record.available).length;
  const alertsSent = succeededAlertKeys.size;
  const suppressed = countCooldownSuppressed(decision, succeededAlertKeys);
  return { status: "ok", checked: records.length, availableNow, alertsSent, suppressed };
}

/** Count pending→available transitions that did NOT result in an alert. */
function countCooldownSuppressed(
  decision: AlertDecision,
  succeededAlertKeys: ReadonlySet<string>,
): number {
  let suppressed = 0;
  for (const [key, desired] of decision.stateUpdates) {
    if (desired === 1 && !succeededAlertKeys.has(key)) {
      // Either cooldown-suppressed or the send failed; both are "no alert sent".
      suppressed += 1;
    }
  }
  return suppressed;
}

