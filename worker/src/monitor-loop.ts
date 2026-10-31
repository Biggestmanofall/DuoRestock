/**
 * One cron invocation of the 20-second monitoring loop (Option A).
 *
 * Behavior contract:
 * - Checks run at slots 0/20/40s past the minute, STRICTLY sequentially.
 * - INVOCATION DEADLINE: no new work starts after invocationDeadlineMs
 *   (55s). A check may start only if safeCheckBudgetMs still fits before the
 *   deadline; otherwise the REMAINING checks are skipped ("skipped" count).
 *   Two safe checks per minute are preferable to overrunning the 60s cron
 *   interval — Cloudflare does NOT guarantee non-overlapping scheduled
 *   invocations (verified against the scheduled-handler docs).
 * - MONITOR LEASE: before every check the loop atomically acquires a D1
 *   lease. If another (overlapping) invocation holds it, this slot is skipped
 *   and retried at the next slot. The lease guarantees that two Apple checks
 *   from this monitor NEVER run concurrently, even in pathological cases —
 *   which also makes double Telegram alerts from concurrent checks
 *   impossible. A crashed invocation's lease self-expires (leaseHoldMs).
 * - The window is re-checked BEFORE EVERY individual check; if closed, exit.
 * - A check that crashes is recorded as an error and never blocks later
 *   checks; the intentional backoff gate lives inside runCheck.
 * - All monitoring semantics (two-success confirmation, dedup, alerts,
 *   backoff, D1 persistence) are inside runCheck, untouched by this loop.
 */

import { SCHEDULE } from "./config";
import type { RunOutcome } from "./run";
import { isWithinMonitoringWindow } from "./schedule";

export type CheckFn = () => Promise<RunOutcome>;
export type WaitFn = (ms: number) => Promise<void>;
export type NowFn = () => number;
export type WindowFn = (epochMs: number) => boolean;
export type AcquireLeaseFn = () => Promise<boolean>;
export type ReleaseLeaseFn = () => Promise<void>;

export interface LoopDeps {
  readonly runCheckFn: CheckFn;
  readonly wait: WaitFn;
  readonly now: NowFn;
  readonly isWithinWindow?: WindowFn;
  readonly acquireLease?: AcquireLeaseFn;
  readonly releaseLease?: ReleaseLeaseFn;
}

export interface LoopOutcome {
  /** "outside-window": the invocation did nothing (no requests). */
  readonly status: "outside-window" | "completed";
  readonly checksRun: number;
  /** Slots skipped due to the invocation deadline or a lease held elsewhere. */
  readonly skipped: number;
  readonly outcomes: RunOutcome[];
}

const INTERVAL_MS = SCHEDULE.checkIntervalSeconds * 1000;

export async function runMonitoringInvocation(deps: LoopDeps): Promise<LoopOutcome> {
  const withinWindow = deps.isWithinWindow ?? isWithinMonitoringWindow;

  // Gate the whole invocation first: zero Apple requests outside the window.
  const invocationStart = deps.now();
  if (!withinWindow(invocationStart)) {
    return { status: "outside-window", checksRun: 0, skipped: 0, outcomes: [] };
  }
  const deadline = invocationStart + SCHEDULE.invocationDeadlineMs;

  const outcomes: RunOutcome[] = [];
  let skipped = 0;

  for (let slot = 0; slot < SCHEDULE.checksPerInvocation; slot += 1) {
    if (slot > 0) {
      // Window re-check #1 (before waiting): exit if it closed.
      if (!withinWindow(deps.now())) break;
      // Slot-aligned wait: sleep only until this slot's target time.
      const delay = invocationStart + slot * INTERVAL_MS - deps.now();
      if (delay > 0) {
        if (deps.now() + delay >= deadline) {
          skipped += SCHEDULE.checksPerInvocation - slot;
          break; // even the wait would end past the deadline
        }
        await deps.wait(delay);
      }
    }
    // Window re-check #2 (before every individual check, incl. after the wait).
    if (!withinWindow(deps.now())) break;

    // Deadline guard: skip ALL remaining checks if a full safe check no
    // longer fits before the deadline (safety over completeness).
    if (deps.now() + SCHEDULE.safeCheckBudgetMs > deadline) {
      skipped += SCHEDULE.checksPerInvocation - slot;
      break;
    }

    // Lease guard: if an overlapping invocation is mid-check, skip THIS slot
    // only — the next slot may find the lease free. A D1 ERROR during
    // acquisition is treated the same way (fail closed: no check runs), but
    // is logged and does NOT kill the remaining slots.
    let leaseAcquired = false;
    if (deps.acquireLease) {
      try {
        leaseAcquired = await deps.acquireLease();
      } catch (error) {
        console.warn(
          `lease acquisition failed, skipping slot (fail closed): ${error instanceof Error ? error.message : String(error)}`,
        );
        leaseAcquired = false;
      }
      if (!leaseAcquired) {
        skipped += 1;
        continue;
      }
    }

    try {
      outcomes.push(await deps.runCheckFn());
    } catch (error) {
      // A crashed check is an error — never confirmed unavailability — and
      // must not prevent later scheduled checks.
      outcomes.push({
        status: "error",
        message: `runCheck crashed: ${error instanceof Error ? error.message : String(error)}`,
        backoffSeconds: 0,
      });
    } finally {
      // Release immediately so our own next slot never blocks. A failed
      // release is logged and left to the lease's expiry (recovery backstop);
      // it must never crash the invocation.
      if (leaseAcquired && deps.releaseLease) {
        try {
          await deps.releaseLease();
        } catch (error) {
          console.warn(
            `lease release failed (expiry will recover): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  return { status: "completed", checksRun: outcomes.length, skipped, outcomes };
}

