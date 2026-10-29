import { describe, expect, it } from "vitest";
import { fetchPickupBody } from "../src/apple";
import { buildPickupUrl } from "../src/config";
import { AppleResponseError } from "../src/availability";

const UA = "TestAgent/1.0";

describe("buildPickupUrl (one request covering all parts)", () => {
  it("builds the exact endpoint URL with all 8 parts", () => {
    const url = buildPickupUrl();
    expect(url).toBe(
      "https://www.apple.com/shop/retail/pickup-message" +
        "?pl=true&mts.0=regular&location=Nashville%2C+TN" +
        "&parts.0=MK1E4LL%2FA&parts.1=MK1F4LL%2FA&parts.2=MK1G4LL%2FA&parts.3=MK1H4LL%2FA" +
        "&parts.4=MK1J4LL%2FA&parts.5=MK1L4LL%2FA&parts.6=MK1Q4LL%2FA&parts.7=MK1R4LL%2FA",
    );
  });
});

describe("fetchPickupBody (failures are errors, never 'unavailable')", () => {
  it("returns the body object on success", async () => {
    const body = { stores: [{ storeNumber: "R513" }] };
    const fetchImpl = (async () => Response.json({ body })) as typeof fetch;
    await expect(fetchPickupBody("https://example.com/", UA, fetchImpl)).resolves.toEqual(body);
  });

  it("sends the configured User-Agent header", async () => {
    let seenHeaders: Headers | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      return Response.json({ body: { stores: [] } });
    }) as typeof fetch;
    await fetchPickupBody("https://example.com/", UA, fetchImpl);
    expect(seenHeaders?.get("User-Agent")).toBe(UA);
  });

  it("throws on HTTP error status", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    await expect(fetchPickupBody("https://example.com/", UA, fetchImpl)).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it("throws on invalid JSON", async () => {
    const fetchImpl = (async () => new Response("not json at all")) as typeof fetch;
    await expect(fetchPickupBody("https://example.com/", UA, fetchImpl)).rejects.toThrow(
      /invalid JSON/,
    );
  });

  it("throws on an errorMessage body (e.g. throttling) — never treats it as out-of-stock", async () => {
    const fetchImpl = (async () =>
      Response.json({ body: { errorMessage: "Unavailable for pickup searches" } })) as typeof fetch;
    await expect(fetchPickupBody("https://example.com/", UA, fetchImpl)).rejects.toThrow(
      /Unavailable for pickup searches/,
    );
  });

  it("throws when the body has no stores list", async () => {
    const fetchImpl = (async () => Response.json({ body: {} })) as typeof fetch;
    await expect(fetchPickupBody("https://example.com/", UA, fetchImpl)).rejects.toThrow(
      AppleResponseError,
    );
  });

  it("throws on network errors with the error class name only", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("boom at https://example.com/");
    }) as typeof fetch;
    await expect(fetchPickupBody("https://example.com/", UA, fetchImpl)).rejects.toThrow(
      /network error \(TypeError\)/,
    );
  });
});
