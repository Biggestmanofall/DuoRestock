import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { MockD1 } from "./helpers/mock-d1";
import {
  clearFailure,
  getFailureState,
  getLastAlertTimes,
  getStates,
  recordAlerts,
  recordFailure,
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
