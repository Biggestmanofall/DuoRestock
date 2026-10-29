/**
 * Pure parsing of Apple pickup availability responses.
 *
 * The availability rule (verified empirically — either field alone produces
 * false alarms): a part is available for IN-STORE PICKUP at a store only when
 * BOTH hold:
 *   1. partsAvailability[part].pickupDisplay !== "unavailable", and
 *   2. partsAvailability[part].messageTypes.regular.storeSelectionEnabled === true
 *
 * This is pickup availability, not shipping availability — the endpoint is
 * exclusively about retail store pickup.
 */

export class AppleResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleResponseError";
  }
}

export interface PickupRecord {
  readonly storeNumber: string;
  readonly storeName: string;
  readonly partNumber: string;
  readonly productTitle: string;
  readonly pickupQuote: string;
  readonly available: boolean;
}

/** Stable key for a (store, part) pair, used for state tracking and dedup. */
export function stateKey(storeNumber: string, partNumber: string): string {
  return `${storeNumber}:${partNumber}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Apply the two-field pickup availability rule to one partsAvailability entry. */
export function partIsAvailable(partData: unknown): boolean {
  if (!isRecord(partData)) return false;
  if (partData["pickupDisplay"] === "unavailable") return false;
  const messageTypes = partData["messageTypes"];
  if (!isRecord(messageTypes)) return false;
  const regular = messageTypes["regular"];
  if (!isRecord(regular)) return false;
  return regular["storeSelectionEnabled"] === true;
}

/** Extract Apple's own product title and pickup quote, if present. */
function regularInfo(partData: unknown): { productTitle: string; pickupQuote: string } {
  if (!isRecord(partData)) return { productTitle: "", pickupQuote: "" };
  const messageTypes = partData["messageTypes"];
  if (!isRecord(messageTypes)) return { productTitle: "", pickupQuote: "" };
  const regular = messageTypes["regular"];
  if (!isRecord(regular)) return { productTitle: "", pickupQuote: "" };
  return {
    productTitle: typeof regular["storePickupProductTitle"] === "string" ? regular["storePickupProductTitle"] : "",
    pickupQuote: typeof regular["storePickupQuote"] === "string" ? regular["storePickupQuote"] : "",
  };
}

/**
 * Parse a pickup-message `body` into records for the monitored stores only.
 *
 * Throws AppleResponseError if the response shape is unusable — callers must
 * treat that as a FAILED check, never as "everything unavailable".
 */
export function parsePickupResponse(body: unknown, monitoredStores: ReadonlySet<string>): PickupRecord[] {
  if (!isRecord(body)) {
    throw new AppleResponseError("response body is not an object");
  }
  const stores = body["stores"];
  if (!Array.isArray(stores)) {
    throw new AppleResponseError("response body has no 'stores' list");
  }

  const records: PickupRecord[] = [];
  for (const store of stores) {
    if (!isRecord(store)) continue;
    const storeNumber = typeof store["storeNumber"] === "string" ? store["storeNumber"] : "";
    if (!monitoredStores.has(storeNumber)) continue;
    const storeName = typeof store["storeName"] === "string" ? store["storeName"] : "";
    const partsAvailability = store["partsAvailability"];
    if (!isRecord(partsAvailability)) continue;
    for (const [partNumber, partData] of Object.entries(partsAvailability)) {
      const { productTitle, pickupQuote } = regularInfo(partData);
      records.push({
        storeNumber,
        storeName,
        partNumber,
        productTitle,
        pickupQuote,
        available: partIsAvailable(partData),
      });
    }
  }
  return records;
}
