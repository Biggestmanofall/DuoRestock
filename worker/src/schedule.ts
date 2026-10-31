/**
 * Pure monitoring-window logic: is a given instant within the 7:00 AM –
 * 6:00 PM America/Chicago window (DST-safe via the IANA timezone database)?
 *
 * Window semantics: [07:00:00, 18:00:00) local time — monitoring runs through
 * 5:59:59.999 PM and stops at 6:00:00 PM sharp. No Apple requests are made
 * at or after 18:00:00 or before 07:00:00.
 */

import { SCHEDULE } from "./config";

const wallClockFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: SCHEDULE.timezone,
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
});

/** Local minutes-since-midnight in the monitoring timezone (minute precision). */
export function localMinuteOfDay(epochMs: number): number {
  const parts = wallClockFormatter.formatToParts(new Date(epochMs));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/**
 * True when the instant falls inside [07:00, 18:00) America/Chicago.
 * Minute-granularity: 06:59:59.x is OUT, 07:00:00 is IN, 17:59:59.x is IN,
 * 18:00:00 is OUT. DST transitions (2–3 AM local) fall entirely outside the
 * window, and the IANA zone handles both spring-forward and fall-back.
 */
export function isWithinMonitoringWindow(epochMs: number): boolean {
  const minuteOfDay = localMinuteOfDay(epochMs);
  return minuteOfDay >= SCHEDULE.windowStartMinute && minuteOfDay < SCHEDULE.windowEndMinute;
}
