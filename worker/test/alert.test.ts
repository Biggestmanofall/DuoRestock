import { describe, expect, it } from "vitest";
import { buildAlertMessage, computeAlertActions, type AvailabilityState } from "../src/alert";
import type { PickupRecord } from "../src/availability";

const NOW = 1_000_000_000_000;
const COOLDOWN_MINUTES = 5;
const COOLDOWN_MS = COOLDOWN_MINUTES * 60_000;

function makeItem(available = true, store = "R513", part = "MK1H4LL/A"): PickupRecord {
  return {
    storeNumber: store,
    storeName: "Apple CoolSprings Galleria",
    partNumber: part,
    productTitle: "iPhone Duo 512GB Night Sky",
    pickupQuote: "Tomorrow at Apple CoolSprings Galleria",
    available,
  };
}

const KEY = "R513:MK1H4LL/A";

describe("computeAlertActions (transitions, confirmation, dedup)", () => {
  it("fresh available transition is only marked pending (confirmation next run)", () => {
    const decision = computeAlertActions([makeItem()], new Map(), new Map(), NOW, COOLDOWN_MINUTES);
    expect(decision.alerts).toEqual([]);
    expect(decision.stateUpdates.get(KEY)).toBe(2);
  });

  it("pending + still available + no recent alert -> alert and mark available", () => {
    const states = new Map<string, AvailabilityState>([[KEY, 2]]);
    const decision = computeAlertActions([makeItem()], states, new Map(), NOW, COOLDOWN_MINUTES);
    expect(decision.alerts).toHaveLength(1);
    expect(decision.stateUpdates.get(KEY)).toBe(1);
  });

  it("pending + still available + alert within cooldown -> suppressed, no alert", () => {
    const states = new Map<string, AvailabilityState>([[KEY, 2]]);
    const alerts = new Map<string, number>([[KEY, NOW - 60_000]]); // 1 min ago
    const decision = computeAlertActions([makeItem()], states, alerts, NOW, COOLDOWN_MINUTES);
    expect(decision.alerts).toEqual([]);
    expect(decision.stateUpdates.get(KEY)).toBe(1);
  });

  it("pending + still available + cooldown expired -> alert again", () => {
    const states = new Map<string, AvailabilityState>([[KEY, 2]]);
    const alerts = new Map<string, number>([[KEY, NOW - 10 * 60_000]]); // 10 min ago
    const decision = computeAlertActions([makeItem()], states, alerts, NOW, COOLDOWN_MINUTES);
    expect(decision.alerts).toHaveLength(1);
    expect(decision.stateUpdates.get(KEY)).toBe(1);
  });

  it("already known available -> no changes at all", () => {
    const states = new Map<string, AvailabilityState>([[KEY, 1]]);
    const decision = computeAlertActions([makeItem()], states, new Map(), NOW, COOLDOWN_MINUTES);
    expect(decision.alerts).toEqual([]);
    expect(decision.stateUpdates.size).toBe(0);
  });

  it("pending then unavailable (near miss) -> back to 0, no alert", () => {
    const states = new Map<string, AvailabilityState>([[KEY, 2]]);
    const decision = computeAlertActions([makeItem(false)], states, new Map(), NOW, COOLDOWN_MINUTES);
    expect(decision.alerts).toEqual([]);
    expect(decision.stateUpdates.get(KEY)).toBe(0);
  });

  it("known available then unavailable -> state reset to 0", () => {
    const states = new Map<string, AvailabilityState>([[KEY, 1]]);
    const decision = computeAlertActions([makeItem(false)], states, new Map(), NOW, COOLDOWN_MINUTES);
    expect(decision.alerts).toEqual([]);
    expect(decision.stateUpdates.get(KEY)).toBe(0);
  });

  it("steady unavailable with no prior state -> writes the initial baseline", () => {
    const decision = computeAlertActions([makeItem(false)], new Map(), new Map(), NOW, COOLDOWN_MINUTES);
    expect(decision.alerts).toEqual([]);
    expect(decision.stateUpdates.get(KEY)).toBe(0);
  });

  it("steady unavailable already recorded -> no writes", () => {
    const states = new Map<string, AvailabilityState>([[KEY, 0]]);
    const decision = computeAlertActions([makeItem(false)], states, new Map(), NOW, COOLDOWN_MINUTES);
    expect(decision.alerts).toEqual([]);
    expect(decision.stateUpdates.size).toBe(0);
  });

  it("handles multiple stores/parts independently", () => {
    const a = makeItem(true, "R513", "MK1H4LL/A");
    const b = makeItem(true, "R123", "MK1G4LL/A");
    const states = new Map<string, AvailabilityState>([["R513:MK1H4LL/A", 2]]);
    const decision = computeAlertActions([a, b], states, new Map(), NOW, COOLDOWN_MINUTES);
    expect(decision.alerts).toEqual([a]); // only R513 was pending
    expect(decision.stateUpdates.get("R123:MK1G4LL/A")).toBe(2); // R123 newly pending
    expect(decision.stateUpdates.get("R513:MK1H4LL/A")).toBe(1);
  });
});

describe("buildAlertMessage", () => {
  it("includes store, configuration, pickup details and the official link", () => {
    const message = buildAlertMessage([makeItem()], "https://www.apple.com/shop/buy-iphone/iphone-duo");
    expect(message).toContain("Apple CoolSprings Galleria");
    expect(message).toContain("iPhone Duo 512GB Night Sky");
    expect(message).toContain("Tomorrow at Apple CoolSprings Galleria");
    expect(message).toContain("https://www.apple.com/shop/buy-iphone/iphone-duo");
  });
});
