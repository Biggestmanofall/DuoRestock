/**
 * Static configuration for DuoRestockBot. No secrets live here.
 *
 * Store numbers and part numbers were verified against Apple's live pickup
 * availability endpoint on 2026-10-29 (see legacy Python implementation docs).
 */

export interface StoreConfig {
  readonly number: string;
  readonly name: string;
  readonly city: string;
}

export interface PartConfig {
  readonly number: string;
  readonly description: string;
  readonly color: string;
  readonly storage: string;
}

export const STORES: readonly StoreConfig[] = [
  { number: "R513", name: "Apple CoolSprings Galleria", city: "Franklin, Tennessee" },
  { number: "R123", name: "Apple Green Hills", city: "Nashville, Tennessee" },
  { number: "R133", name: "Apple Downtown Nashville", city: "Nashville, Tennessee" },
];

export const PARTS: readonly PartConfig[] = [
  { number: "MK1E4LL/A", description: "iPhone Duo 256GB Star White", color: "Star White", storage: "256GB" },
  { number: "MK1F4LL/A", description: "iPhone Duo 256GB Night Sky", color: "Night Sky", storage: "256GB" },
  { number: "MK1G4LL/A", description: "iPhone Duo 512GB Star White", color: "Star White", storage: "512GB" },
  { number: "MK1H4LL/A", description: "iPhone Duo 512GB Night Sky", color: "Night Sky", storage: "512GB" },
  { number: "MK1J4LL/A", description: "iPhone Duo 1TB Star White", color: "Star White", storage: "1TB" },
  { number: "MK1L4LL/A", description: "iPhone Duo 1TB Night Sky", color: "Night Sky", storage: "1TB" },
  { number: "MK1Q4LL/A", description: "iPhone Duo 2TB Star White", color: "Star White", storage: "2TB" },
  { number: "MK1R4LL/A", description: "iPhone Duo 2TB Night Sky", color: "Night Sky", storage: "2TB" },
];

export const MONITORED_STORE_NUMBERS: ReadonlySet<string> = new Set(
  STORES.map((store) => store.number),
);

export const APPLE = {
  /** Public endpoint used by Apple's own "Check availability" pickup UI. */
  pickupEndpoint: "https://www.apple.com/shop/retail/pickup-message",
  /** One request returns the ~12 nearest stores; this location covers all three. */
  location: "Nashville, TN",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  buyUrl: "https://www.apple.com/shop/buy-iphone/iphone-duo",
} as const;

export const MONITOR = {
  /** Suppress repeat alerts for the same (store, part) within this window. */
  cooldownMinutes: 5,
  /** Exponential backoff for failing checks: initial * 2^(n-1), capped. */
  backoffInitialSeconds: 60,
  backoffMaxSeconds: 900,
} as const;

/**
 * 20-second monitoring schedule (Option A: in-invocation fan-out).
 * The * * * * * cron fires each minute; each invocation performs up to
 * checksPerInvocation checks spaced checkIntervalSeconds apart, aligned to
 * slots 0/20/40s past the minute, ONLY within the local-time window.
 */
export const SCHEDULE = {
  /** IANA timezone for the monitoring window (handles DST automatically). */
  timezone: "America/Chicago",
  /** Window is [windowStartMinute, windowEndMinute) local time, minutes since midnight. */
  windowStartMinute: 7 * 60, // 07:00:00 inclusive
  windowEndMinute: 18 * 60, // 18:00:00 exclusive (last check 17:59:40)
  /** Seconds between checks within an invocation (slots at 0/20/40). */
  checkIntervalSeconds: 20,
  /** Maximum checks per one-minute invocation. */
  checksPerInvocation: 3,
  /**
   * Hard deadline for the whole invocation, measured from its start. The cron
   * fires every 60s; this leaves a 5s margin so the invocation finishes (all
   * checks AND their D1 writes) before the next fire. No new work starts
   * after this point. Cloudflare does NOT guarantee non-overlapping scheduled
   * invocations, so this deadline must be conservative.
   */
  invocationDeadlineMs: 55_000,
  /**
   * A check may START only if this budget still fits before the deadline.
   * Covers the realistic worst case: Apple fetch timeout (10s) + D1 + overhead.
   * The rarer slow-success+Telegram-alert case (~21s) is additionally guarded
   * by the monitor lease, which guarantees no concurrent Apple checks even if
   * a check overruns the deadline slightly.
   */
  safeCheckBudgetMs: 12_000,
  /**
   * How long the monitor lease is held from the START of a check.
   *
   * Normal operation is unaffected by this value: the lease is RELEASED
   * immediately after each check completes, so our own next slot never
   * waits. The hold length only matters when release cannot happen:
   * - a crashed invocation: the lease self-expires, and since the next cron
   *   invocation starts ~60s after the crashed one began, recovery costs at
   *   most the tail of one minute;
   * - a check that overruns: a realistic check is bounded at ~22s (10s Apple
   *   fetch timeout + 10s alert timeout + D1/overhead), so a 60s hold covers
   *   it with large margin.
   *
   * HONEST LIMIT: this is NOT an absolute no-overlap guarantee. A check
   * running longer than 60s (only possible if a D1 call hangs, since fetches
   * are timeout-capped) could still overlap the next invocation after the
   * lease expires. Renewal was considered and rejected: it needs lease-owner
   * identity to avoid extending someone else's lease, and it cannot abort
   * the in-flight request anyway.
   */
  leaseHoldMs: 60_000,
} as const;

/** Build the single pickup-availability URL covering all parts in one request. */
export function buildPickupUrl(): string {
  const params = new URLSearchParams();
  params.set("pl", "true");
  params.set("mts.0", "regular");
  params.set("location", APPLE.location);
  PARTS.forEach((part, index) => {
    params.set(`parts.${index}`, part.number);
  });
  return `${APPLE.pickupEndpoint}?${params.toString()}`;
}
