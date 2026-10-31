import { describe, expect, it } from "vitest";
import { runMonitoringInvocation, type LoopOutcome } from "../src/monitor-loop";
import type { RunOutcome } from "../src/run";

const OK: RunOutcome = { status: "ok", checked: 24, availableNow: 0, alertsSent: 0, suppressed: 0 };
const BACKING_OFF: RunOutcome = { status: "backing-off", nextAttemptAt: 60_000 };

interface Harness {
  readonly run: () => Promise<LoopOutcome>;
  readonly checkTimes: number[];
  readonly waits: number[];
  readonly releaseCount: () => number;
  readonly releaseAttempts: () => number;
  readonly setCheckDuration: (ms: number) => void;
  readonly setFirstCheckDuration: (ms: number) => void;
  readonly setOutcome: (outcome: RunOutcome) => void;
  readonly failOnCall: (callNumber: number) => void;
  readonly setWindow: (fn: (epochMs: number) => boolean) => void;
  readonly denyLeaseAtSlots: (slots: number[]) => void;
}

interface HarnessOptions {
  /** Lease acquisition THROWS (D1 error) for these attempt indices. */
  readonly failAcquireAtSlots?: number[];
  /** Lease release THROWS on this 1-based attempt number. */
  readonly failReleaseOnCall?: number;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  let now = 0;
  let checkDuration = 0;
  let firstCheckDuration: number | null = null;
  let outcome: RunOutcome = OK;
  let failCall = -1;
  let windowFn: (epochMs: number) => boolean = () => true;
  let deniedSlots = new Set<number>();
  let releaseCount = 0;
  let releaseAttempts = 0;
  let firstCheckDone = false;
  let leaseAttempts = 0;

  const checkTimes: number[] = [];
  const waits: number[] = [];
  let callCount = 0;

  const runCheckFn = async (): Promise<RunOutcome> => {
    callCount += 1;
    checkTimes.push(now);
    const duration = !firstCheckDone && firstCheckDuration !== null ? firstCheckDuration : checkDuration;
    firstCheckDone = true;
    now += duration; // simulate the check taking time
    if (callCount === failCall) throw new Error("simulated crash inside runCheck");
    return outcome;
  };

  return {
    run: () =>
      runMonitoringInvocation({
        runCheckFn,
        wait: async (ms: number) => {
          waits.push(ms);
          now += ms;
        },
        now: () => now,
        isWithinWindow: (epochMs: number) => windowFn(epochMs),
        acquireLease: async () => {
          // Deny based on a dedicated attempt counter (a denied slot does not
          // advance checkTimes, so length would be wrong after skips).
          const slotIndex = leaseAttempts;
          leaseAttempts += 1;
          if ((options.failAcquireAtSlots ?? []).includes(slotIndex)) {
            throw new Error("simulated D1 error acquiring lease");
          }
          return !deniedSlots.has(slotIndex);
        },
        releaseLease: async () => {
          releaseAttempts += 1;
          if (options.failReleaseOnCall === releaseAttempts) {
            throw new Error("simulated D1 error releasing lease");
          }
          releaseCount += 1;
        },
      }),
    checkTimes,
    waits,
    releaseCount: () => releaseCount,
    releaseAttempts: () => releaseAttempts,
    setCheckDuration: (ms: number) => {
      checkDuration = ms;
    },
    setFirstCheckDuration: (ms: number) => {
      firstCheckDuration = ms;
    },
    setOutcome: (value: RunOutcome) => {
      outcome = value;
    },
    failOnCall: (callNumber: number) => {
      failCall = callNumber;
    },
    setWindow: (fn: (epochMs: number) => boolean) => {
      windowFn = fn;
    },
    denyLeaseAtSlots: (slots: number[]) => {
      deniedSlots = new Set(slots);
    },
  };
}

describe("runMonitoringInvocation — core behavior", () => {
  it("does nothing (no checks, no waits) when the invocation starts outside the window", async () => {
    const h = makeHarness();
    h.setWindow(() => false);
    const result = await h.run();
    expect(result).toEqual({ status: "outside-window", checksRun: 0, skipped: 0, outcomes: [] });
    expect(h.checkTimes).toEqual([]);
    expect(h.waits).toEqual([]);
  });

  it("runs exactly three checks at slots 0s/20s/40s, strictly sequential, nothing skipped", async () => {
    const h = makeHarness();
    const result = await h.run();
    expect(result.status).toBe("completed");
    expect(result.checksRun).toBe(3);
    expect(result.skipped).toBe(0);
    expect(h.checkTimes).toEqual([0, 20_000, 40_000]);
    expect(h.waits).toEqual([20_000, 20_000]);
    for (let i = 1; i < h.checkTimes.length; i += 1) {
      expect(h.checkTimes[i]!).toBeGreaterThan(h.checkTimes[i - 1]!);
    }
  });

  it("exits immediately when the window closes during the wait before the last check", async () => {
    const h = makeHarness();
    h.setWindow((t) => t < 30_000);
    const result = await h.run();
    expect(result.status).toBe("completed");
    expect(result.checksRun).toBe(2);
    expect(h.checkTimes).toEqual([0, 20_000]);
  });

  it("exits before waiting at all when the window closes right after the first check", async () => {
    const h = makeHarness();
    h.setCheckDuration(15_000); // first check ends at t=15s
    h.setWindow((t) => t < 10_000); // window closed by then
    const result = await h.run();
    expect(result.checksRun).toBe(1);
    expect(h.checkTimes).toEqual([0]);
    expect(h.waits).toEqual([]);
  });

  it("a crashed check is recorded as an error and later checks still run", async () => {
    const h = makeHarness();
    h.failOnCall(2);
    const result = await h.run();
    expect(result.checksRun).toBe(3);
    expect(h.checkTimes).toEqual([0, 20_000, 40_000]);
    expect(result.outcomes[1]!.status).toBe("error");
    if (result.outcomes[1]!.status === "error") {
      expect(result.outcomes[1]!.message).toContain("runCheck crashed");
    }
    expect(result.outcomes[0]!.status).toBe("ok");
    expect(result.outcomes[2]!.status).toBe("ok");
  });

  it("backoff-gated checks still occupy their slots (the gate lives inside runCheck)", async () => {
    const h = makeHarness();
    h.setOutcome(BACKING_OFF);
    const result = await h.run();
    expect(result.checksRun).toBe(3);
    expect(result.outcomes.every((outcome) => outcome.status === "backing-off")).toBe(true);
  });

  it("all three checks failing (HTTP errors) still run all three slots", async () => {
    const h = makeHarness();
    h.setOutcome({ status: "error", message: "HTTP 541", backoffSeconds: 60 });
    const result = await h.run();
    expect(result.checksRun).toBe(3);
    expect(result.outcomes.every((outcome) => outcome.status === "error")).toBe(true);
  });
});

describe("runMonitoringInvocation — invocation deadline (60s cron interval safety)", () => {
  it("a check taking 25s: only two checks run; invocation finishes at 50s, under the 60s interval", async () => {
    const h = makeHarness();
    h.setCheckDuration(25_000);
    const result = await h.run();
    // Check 1: 0 -> 25. Check 2 starts immediately (slot 20 already passed,
    // 25+12s budget fits before the 55s deadline): 25 -> 50. Third check at
    // t=50 would need until 62s -> past deadline -> SKIPPED for safety.
    expect(result.checksRun).toBe(2);
    expect(result.skipped).toBe(1);
    expect(h.checkTimes).toEqual([0, 25_000]);
    expect(h.waits).toEqual([]); // no waits: every slot target was already past
    expect(h.checkTimes[h.checkTimes.length - 1]! + 25_000).toBeLessThan(60_000);
  });

  it("a single 25s check followed by fast checks still completes all three slots", async () => {
    const h = makeHarness();
    h.setFirstCheckDuration(25_000); // only the first check is slow
    const result = await h.run();
    // 0 -> 25 (slow), then immediate at 25 (fast), then aligned wait to 40.
    expect(result.checksRun).toBe(3);
    expect(result.skipped).toBe(0);
    expect(h.checkTimes).toEqual([0, 25_000, 40_000]);
    expect(h.waits).toEqual([15_000]);
  });

  it("checks taking close to 20s (19s each): all three run, finishing at 59s — just before the next minute", async () => {
    const h = makeHarness();
    h.setCheckDuration(19_000);
    const result = await h.run();
    expect(result.checksRun).toBe(3);
    expect(result.skipped).toBe(0);
    expect(h.checkTimes).toEqual([0, 20_000, 40_000]);
    expect(h.waits).toEqual([1_000, 1_000]);
    // Final check ends at 40+19 = 59s: under the 60s cron interval.
    expect(h.checkTimes[2]! + 19_000).toBe(59_000);
  });

  it("checks taking longer than 30s (32s each): second check still fits the budget, third is skipped", async () => {
    const h = makeHarness();
    h.setCheckDuration(32_000);
    const result = await h.run();
    // Check 1: 0 -> 32 (slot 20 missed; the loop cannot abort in-flight work).
    // Check 2 starts at 32 (32+12s fits the 55s deadline) -> 64.
    // Slot 3: now=64 is past the deadline -> skipped. NOTE: a 32s check is
    // beyond the design bound (fetches are timeout-capped at 10s each, so a
    // realistic check is <= ~22s); the lease guarantees no overlap regardless.
    expect(result.checksRun).toBe(2);
    expect(result.skipped).toBe(1);
    expect(h.checkTimes).toEqual([0, 32_000]);
  });

  it("three checks whose combined duration would exceed 60s: the deadline caps the invocation", async () => {
    const h = makeHarness();
    h.setCheckDuration(23_000); // 3 x 23s = 69s > 60s if all ran
    const result = await h.run();
    // Check 1: 0 -> 23; check 2 at 23 (23+12 fits) -> 46; third at 46 would
    // need until 69s -> skipped. Invocation ends at 46s, under the interval.
    expect(result.checksRun).toBe(2);
    expect(result.skipped).toBe(1);
    expect(h.checkTimes).toEqual([0, 23_000]);
    expect(h.checkTimes[h.checkTimes.length - 1]! + 23_000).toBeLessThan(60_000);
  });

  it("moderately slow checks (12s each) still complete all three slots, aligned", async () => {
    const h = makeHarness();
    h.setCheckDuration(12_000);
    const result = await h.run();
    expect(result.checksRun).toBe(3);
    expect(result.skipped).toBe(0);
    expect(h.checkTimes).toEqual([0, 20_000, 40_000]);
    expect(h.waits).toEqual([8_000, 8_000]);
  });
});

describe("runMonitoringInvocation — monitor lease (no concurrent Apple checks)", () => {
  it("a lease held by an overlapping invocation skips only that slot; later slots retry", async () => {
    const h = makeHarness();
    h.denyLeaseAtSlots([1]); // the middle slot finds the lease held elsewhere
    const result = await h.run();
    expect(result.checksRun).toBe(2);
    expect(result.skipped).toBe(1);
    expect(h.checkTimes).toEqual([0, 40_000]); // slot 20 skipped, slot 40 ran
    expect(h.waits).toEqual([20_000, 20_000]);
  });

  it("a lease held for the whole minute: only the first check runs", async () => {
    const h = makeHarness();
    h.denyLeaseAtSlots([1, 2]);
    const result = await h.run();
    expect(result.checksRun).toBe(1);
    expect(result.skipped).toBe(2);
    expect(h.checkTimes).toEqual([0]);
  });

  it("the lease is released after every acquired check (never blocks our own next slot)", async () => {
    const h = makeHarness();
    const result = await h.run();
    expect(result.checksRun).toBe(3);
    expect(h.releaseCount()).toBe(3);
  });

  it("the lease is released even when a check crashes", async () => {
    const h = makeHarness();
    h.failOnCall(1);
    const result = await h.run();
    expect(result.checksRun).toBe(3);
    expect(result.outcomes[0]!.status).toBe("error");
    expect(h.releaseCount()).toBe(3); // released after every attempt
  });
});

describe("runMonitoringInvocation — D1 errors during lease operations", () => {
  it("a lease ACQUISITION error fails closed: that check never runs, later slots still do", async () => {
    const h = makeHarness({ failAcquireAtSlots: [1] });
    const result = await h.run();
    // Slot 20's acquire threw (D1 error) -> treated as NOT acquired -> skipped,
    // invocation continues; slots 0 and 40 ran their checks normally.
    expect(result.checksRun).toBe(2);
    expect(result.skipped).toBe(1);
    expect(h.checkTimes).toEqual([0, 40_000]);
    // No release is attempted for a slot whose acquisition failed.
    expect(h.releaseCount()).toBe(2);
  });

  it("a lease RELEASE error is survivable: the check still counts, later slots still run", async () => {
    const h = makeHarness({ failReleaseOnCall: 1 });
    const result = await h.run();
    expect(result.checksRun).toBe(3);
    expect(result.outcomes.every((outcome) => outcome.status === "ok")).toBe(true);
    expect(h.checkTimes).toEqual([0, 20_000, 40_000]);
    // Release was ATTEMPTED for all three (the first threw; expiry recovers).
    expect(h.releaseAttempts()).toBe(3);
  });
});

