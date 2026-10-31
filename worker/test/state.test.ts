import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { MockD1 } from "./helpers/mock-d1";
import {
  acquireMonitorLease,
  clearFailure,
  getFailureState,
  getLastAlertTimes,
  getMeta,
  getStateRows,
  getStates,
  markAttempt,
  markError,
  markSuccess,
  recordAlerts,
  recordFailure,
  releaseMonitorLease,
  upsertStates,
} from "../src/state";

const db = (): { mock: MockD1; d1: D1Database } => {
  const mock = new MockD1();
  return { mock, d1: mock as unknown as D1Database };
};

describe("inventory states", () => {
  it("starts empty and round-trips upserts", async () => {
    const { mock, d1 } = db();
    expect(await getStates(d1)).toEqual(new Map());

    await upsertStates(
      d1,
      [
        { storeNumber: "R513", partNumber: "MK1H4LL/A", available: 0 },
        { storeNumber: "R123", partNumber: "MK1G4LL/A", available: 0 },
      ],
      123,
    );
    expect(await getStates(d1)).toEqual(
      new Map([
        ["R513:MK1H4LL/A", 0],
        ["R123:MK1G4LL/A", 0],
      ]),
    );

    // Restock transition upserts only the changed pair.
    await upsertStates(d1, [{ storeNumber: "R513", partNumber: "MK1H4LL/A", available: 2 }], 456);
    expect(mock.stateValue("R513", "MK1H4LL/A")).toBe(2);
    expect(mock.stateValue("R123", "MK1G4LL/A")).toBe(0); // untouched
  });

  it("writes nothing for an empty entry list", async () => {
    const { mock, d1 } = db();
    await upsertStates(d1, [], 1);
    expect(mock.states.size).toBe(0);
    expect(mock.executedSql).toEqual([]);
  });
});

describe("alert history", () => {
  it("records alerts and upserts on re-alert", async () => {
    const { mock, d1 } = db();
    expect(await getLastAlertTimes(d1)).toEqual(new Map());

    await recordAlerts(d1, [["R513", "MK1H4LL/A"]], 1000);
    expect(await getLastAlertTimes(d1)).toEqual(new Map([["R513:MK1H4LL/A", 1000]]));

    await recordAlerts(d1, [["R513", "MK1H4LL/A"]], 2000);
    expect(mock.lastAlertAt("R513", "MK1H4LL/A")).toBe(2000);
  });
});

describe("failure backoff ledger", () => {
  it("starts null, records failures, and clears on success", async () => {
    const { mock, d1 } = db();
    expect(await getFailureState(d1)).toBeNull();

    await recordFailure(d1, 1, 60_000);
    expect(await getFailureState(d1)).toEqual({ consecutiveFailures: 1, nextAttemptAt: 60_000 });

    await recordFailure(d1, 3, 240_000); // upsert overwrites
    expect(mock.failure).toEqual({ consecutive: 3, nextAttemptAt: 240_000 });

    await clearFailure(d1);
    expect(await getFailureState(d1)).toBeNull();
  });
});

describe("freshness metadata (dashboard support)", () => {
  it("starts null and accumulates marks incrementally without clobbering", async () => {
    const { mock, d1 } = db();
    expect(await getMeta(d1)).toBeNull();

    await markAttempt(d1, 1000);
    expect(mock.meta).toEqual({ lastAttemptAt: 1000, lastSuccessAt: null, lastError: null, lastErrorAt: null });

    await markSuccess(d1, 2000); // does not clobber lastAttemptAt
    expect(mock.meta).toEqual({ lastAttemptAt: 1000, lastSuccessAt: 2000, lastError: null, lastErrorAt: null });

    await markError(d1, "HTTP 541", 3000); // does not clobber success
    expect(mock.meta).toEqual({ lastAttemptAt: 1000, lastSuccessAt: 2000, lastError: "HTTP 541", lastErrorAt: 3000 });

    const meta = await getMeta(d1);
    expect(meta).toEqual({
      lastAttemptAt: 1000,
      lastSuccessAt: 2000,
      lastError: "HTTP 541",
      lastErrorAt: 3000,
    });
  });

  it("getStateRows returns availability with last-change timestamps", async () => {
    const { d1 } = db();
    await upsertStates(
      d1,
      [
        { storeNumber: "R513", partNumber: "MK1H4LL/A", available: 0 },
        { storeNumber: "R123", partNumber: "MK1G4LL/A", available: 1 },
      ],
      777,
    );
    const rows = await getStateRows(d1);
    expect(rows.get("R513:MK1H4LL/A")).toEqual({ available: 0, updatedAt: 777 });
    expect(rows.get("R123:MK1G4LL/A")).toEqual({ available: 1, updatedAt: 777 });
    expect(rows.has("R133:MK1E4LL/A")).toBe(false); // never observed -> absent
  });
});

describe("monitor lease (mutual exclusion across invocations)", () => {
  it("acquires when free, denies while held, and re-acquires after release", async () => {
    const { mock, d1 } = db();
    // Free (never used): acquires.
    expect(await acquireMonitorLease(d1, 1_000, 30_000)).toBe(true);
    expect(mock.lease).toBe(31_000);
    // Another invocation at t=1,500 while held until 31,000: denied.
    expect(await acquireMonitorLease(d1, 1_500, 30_000)).toBe(false);
    expect(mock.lease).toBe(31_000); // unchanged
    // Release (the original invocation finished its check).
    await releaseMonitorLease(d1);
    expect(mock.lease).toBe(0);
    // Now acquirable again.
    expect(await acquireMonitorLease(d1, 2_000, 30_000)).toBe(true);
    expect(mock.lease).toBe(32_000);
  });

  it("an expired lease is acquirable (crash recovery without manual release)", async () => {
    const { mock, d1 } = db();
    expect(await acquireMonitorLease(d1, 1_000, 30_000)).toBe(true); // held until 31,000
    // A crashed invocation never released; time has moved past the expiry.
    expect(await acquireMonitorLease(d1, 31_500, 30_000)).toBe(true);
    expect(mock.lease).toBe(61_500);
  });

  it("the boundary is inclusive: acquisition at exactly held_until succeeds", async () => {
    const { d1 } = db();
    expect(await acquireMonitorLease(d1, 1_000, 30_000)).toBe(true); // until 31,000
    expect(await acquireMonitorLease(d1, 31_000, 5_000)).toBe(true); // held_until <= now
  });
});
