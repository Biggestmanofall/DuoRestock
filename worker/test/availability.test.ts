import { describe, expect, it } from "vitest";
import {
  AppleResponseError,
  parsePickupResponse,
  partIsAvailable,
  stateKey,
} from "../src/availability";

const MONITORED = new Set(["R513"]);

function makePart(
  pickupDisplay: string,
  storeSelectionEnabled: boolean,
  title = "iPhone Duo 512GB Night Sky",
  quote = "Tomorrow",
): Record<string, unknown> {
  return {
    pickupDisplay,
    messageTypes: {
      regular: {
        storeSelectionEnabled,
        storePickupProductTitle: title,
        storePickupQuote: quote,
      },
    },
  };
}

function makeBody(): Record<string, unknown> {
  return {
    stores: [
      {
        storeNumber: "R513",
        storeName: "Apple CoolSprings Galleria",
        partsAvailability: {
          "MK1H4LL/A": makePart("available", true), // genuinely available
          "MK1G4LL/A": makePart("unavailable", false), // plain unavailable
          "MK1E4LL/A": makePart("available", false), // FALSE ALARM: display ok, selection off
          "MK1F4LL/A": { pickupDisplay: "unavailable" }, // missing messageTypes
        },
      },
      {
        // Not a monitored store — must be filtered out.
        storeNumber: "R591",
        storeName: "Apple Cumberland Mall",
        partsAvailability: { "MK1H4LL/A": makePart("available", true) },
      },
    ],
  };
}

describe("partIsAvailable (two-field rule)", () => {
  it("is available only when BOTH fields qualify", () => {
    expect(partIsAvailable(makePart("available", true))).toBe(true);
    expect(partIsAvailable(makePart("unavailable", false))).toBe(false);
    // Either field alone must NOT count as available (prevents false alarms).
    expect(partIsAvailable(makePart("available", false))).toBe(false);
    expect(partIsAvailable(makePart("unavailable", true))).toBe(false);
  });

  it("handles missing or malformed fields as unavailable", () => {
    expect(partIsAvailable({ pickupDisplay: "unavailable" })).toBe(false);
    expect(partIsAvailable({})).toBe(false);
    expect(partIsAvailable(null)).toBe(false);
    expect(partIsAvailable("nonsense")).toBe(false);
    expect(partIsAvailable({ pickupDisplay: "available", messageTypes: {} })).toBe(false);
  });
});

describe("parsePickupResponse", () => {
  it("filters to monitored stores and flags availability", () => {
    const records = parsePickupResponse(makeBody(), MONITORED);
    expect(records).toHaveLength(4);
    expect(records.every((record) => record.storeNumber === "R513")).toBe(true);
    const byPart = new Map(records.map((record) => [record.partNumber, record]));
    expect(byPart.get("MK1H4LL/A")?.available).toBe(true);
    expect(byPart.get("MK1G4LL/A")?.available).toBe(false);
    expect(byPart.get("MK1E4LL/A")?.available).toBe(false); // false-alarm case
    expect(byPart.get("MK1F4LL/A")?.available).toBe(false);
  });

  it("preserves Apple's own titles and quotes", () => {
    const records = parsePickupResponse(makeBody(), MONITORED);
    const hit = records.find((record) => record.available);
    expect(hit?.storeName).toBe("Apple CoolSprings Galleria");
    expect(hit?.productTitle).toBe("iPhone Duo 512GB Night Sky");
    expect(hit?.pickupQuote).toBe("Tomorrow");
    expect(hit && stateKey(hit.storeNumber, hit.partNumber)).toBe("R513:MK1H4LL/A");
  });

  it("throws on unusable response shapes (failed check, never 'unavailable')", () => {
    expect(() => parsePickupResponse({ body: { errorMessage: "throttled" } }, MONITORED)).toThrow(
      AppleResponseError,
    );
    expect(() => parsePickupResponse({}, MONITORED)).toThrow(AppleResponseError);
    expect(() => parsePickupResponse(null, MONITORED)).toThrow(AppleResponseError);
    expect(() => parsePickupResponse({ stores: "nope" }, MONITORED)).toThrow(AppleResponseError);
  });

  it("returns empty when no monitored stores appear", () => {
    const records = parsePickupResponse(makeBody(), new Set(["R000"]));
    expect(records).toEqual([]);
  });
});
