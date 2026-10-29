/**
 * Static configuration for DuoRestockBot. No secrets live here.
 *
 * Store numbers and part numbers were verified against Apple's live pickup
 * availability endpoint on 2026-10-29 (see legacy Python implementation docs).
 */

export interface StoreConfig {
  readonly number: string;
  readonly name: string;
}

export interface PartConfig {
  readonly number: string;
  readonly description: string;
  readonly color: string;
  readonly storage: string;
}

export const STORES: readonly StoreConfig[] = [
  { number: "R513", name: "Apple CoolSprings Galleria" },
  { number: "R123", name: "Apple Green Hills" },
  { number: "R133", name: "Apple Downtown Nashville" },
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
