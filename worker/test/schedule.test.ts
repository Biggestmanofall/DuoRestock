import { describe, expect, it } from "vitest";
import { isWithinMonitoringWindow, localMinuteOfDay } from "../src/schedule";

/**
 * All UTC epochs below are cross-checked with sanity assertions on
 * localMinuteOfDay, so any mistake in the comments/offsets fails loudly.
 *  - Oct 29, 2026: America/Chicago is CDT (UTC-5).
 *  - Mar 7, 2026: CST (UTC-6). Mar 8, 2026: spring-forward at 2 AM -> CDT (UTC-5).
 *  - Oct 31, 2026: CDT (UTC-5). Nov 1, 2026: fall-back at 2 AM -> CST (UTC-6).
 */

describe("isWithinMonitoringWindow — daily boundaries (regular CDT day)", () => {
  it("06:59:59 is OUT, 07:00:00 is IN", () => {
    const before = Date.UTC(2026, 9, 29, 11, 59, 59); // 06:59:59 CDT
    const start = Date.UTC(2026, 9, 29, 12, 0, 0); // 07:00:00 CDT
    expect(localMinuteOfDay(before)).toBe(6 * 60 + 59); // sanity
    expect(localMinuteOfDay(start)).toBe(7 * 60); // sanity
    expect(isWithinMonitoringWindow(before)).toBe(false);
    expect(isWithinMonitoringWindow(start)).toBe(true);
  });

  it("17:59:59 is IN, 18:00:00 is OUT (stops at 6 PM sharp)", () => {
    const lastSecond = Date.UTC(2026, 9, 29, 22, 59, 59); // 17:59:59 CDT
    const sixPm = Date.UTC(2026, 9, 29, 23, 0, 0); // 18:00:00 CDT
    expect(localMinuteOfDay(lastSecond)).toBe(17 * 60 + 59); // sanity
    expect(localMinuteOfDay(sixPm)).toBe(18 * 60); // sanity
    expect(isWithinMonitoringWindow(lastSecond)).toBe(true);
    expect(isWithinMonitoringWindow(sixPm)).toBe(false);
    expect(isWithinMonitoringWindow(sixPm + 59_999)).toBe(false); // 18:00:59.999
  });

  it("covers exactly 11 hours (660 minutes) of a full local day", () => {
    // CT midnight on Oct 29, 2026 is 05:00 UTC (CDT).
    const midnightCt = Date.UTC(2026, 9, 29, 5, 0, 0);
    expect(localMinuteOfDay(midnightCt)).toBe(0); // sanity
    let inWindow = 0;
    let firstIn: number | null = null;
    let lastIn: number | null = null;
    for (let minute = 0; minute < 1440; minute += 1) {
      const epoch = midnightCt + minute * 60_000;
      if (isWithinMonitoringWindow(epoch)) {
        inWindow += 1;
        if (firstIn === null) firstIn = minute;
        lastIn = minute;
      }
    }
    expect(inWindow).toBe(660);
    expect(firstIn).toBe(420); // 07:00 local
    expect(lastIn).toBe(1079); // 17:59 local
  });
});

describe("isWithinMonitoringWindow — daylight-saving transitions", () => {
  it("spring-forward: 7 AM local is 13:00Z the day BEFORE and 12:00Z the day AFTER", () => {
    // Sat Mar 7, 2026 (CST, UTC-6): 07:00 local == 13:00Z.
    expect(localMinuteOfDay(Date.UTC(2026, 2, 7, 13, 0, 0))).toBe(420); // sanity
    expect(isWithinMonitoringWindow(Date.UTC(2026, 2, 7, 12, 59, 59))).toBe(false); // 06:59:59 CST
    expect(isWithinMonitoringWindow(Date.UTC(2026, 2, 7, 13, 0, 0))).toBe(true); // 07:00:00 CST

    // Sun Mar 8, 2026 (spring-forward at 2 AM -> CDT, UTC-5): 07:00 local == 12:00Z.
    expect(localMinuteOfDay(Date.UTC(2026, 2, 8, 12, 0, 0))).toBe(420); // sanity
    expect(isWithinMonitoringWindow(Date.UTC(2026, 2, 8, 11, 59, 59))).toBe(false); // 06:59:59 CDT
    expect(isWithinMonitoringWindow(Date.UTC(2026, 2, 8, 12, 0, 0))).toBe(true); // 07:00:00 CDT
  });

  it("fall-back: 7 AM local is 12:00Z the day BEFORE and 13:00Z the day AFTER", () => {
    // Sat Oct 31, 2026 (CDT, UTC-5): 07:00 local == 12:00Z.
    expect(localMinuteOfDay(Date.UTC(2026, 9, 31, 12, 0, 0))).toBe(420); // sanity
    expect(isWithinMonitoringWindow(Date.UTC(2026, 9, 31, 11, 59, 59))).toBe(false);
    expect(isWithinMonitoringWindow(Date.UTC(2026, 9, 31, 12, 0, 0))).toBe(true);

    // Sun Nov 1, 2026 (fall-back at 2 AM -> CST, UTC-6): 07:00 local == 13:00Z.
    expect(localMinuteOfDay(Date.UTC(2026, 10, 1, 13, 0, 0))).toBe(420); // sanity
    expect(isWithinMonitoringWindow(Date.UTC(2026, 10, 1, 12, 59, 59))).toBe(false); // 06:59:59 CST
    expect(isWithinMonitoringWindow(Date.UTC(2026, 10, 1, 13, 0, 0))).toBe(true); // 07:00:00 CST
  });
});
