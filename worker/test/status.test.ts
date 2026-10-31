import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { MockD1 } from "./helpers/mock-d1";
import worker from "../src/index";
import { buildStatus, isAuthorized, timingSafeEqualStrings, type StatusPayload } from "../src/status";
import { markAttempt, markError, markSuccess, recordFailure, upsertStates } from "../src/state";

const STATUS_TOKEN = "status-bearer-token-secret";
const NOW = 1_000_000_000_000;

function makeEnv(d1: D1Database, token: string | undefined = STATUS_TOKEN) {
  return {
    DB: d1,
    TELEGRAM_BOT_TOKEN: "telegram-token",
    TELEGRAM_CHAT_ID: "42",
    ...(token !== undefined ? { DASHBOARD_STATUS_TOKEN: token } : {}),
  };
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://duorestockbot.example${path}`, init);
}

describe("timingSafeEqualStrings", () => {
  it("matches identical strings and rejects everything else", () => {
    expect(timingSafeEqualStrings("abc123", "abc123")).toBe(true);
    expect(timingSafeEqualStrings("abc123", "abc124")).toBe(false);
    expect(timingSafeEqualStrings("abc123", "abc1234")).toBe(false);
    expect(timingSafeEqualStrings("abc123", "")).toBe(false);
    expect(timingSafeEqualStrings("", "")).toBe(true);
  });
});

describe("isAuthorized (bearer-token gate, fails closed)", () => {
  it("accepts only the exact bearer token", () => {
    const withToken = (token: string) => request("/status", { headers: { Authorization: `Bearer ${token}` } });
    expect(isAuthorized(withToken(STATUS_TOKEN), STATUS_TOKEN)).toBe(true);
    expect(isAuthorized(withToken("wrong-token"), STATUS_TOKEN)).toBe(false);
    // Surrounding whitespace in the header value is tolerated (trimmed).
    expect(isAuthorized(withToken(` ${STATUS_TOKEN}`), STATUS_TOKEN)).toBe(true);
  });

  it("rejects missing or malformed authorization headers", () => {
    expect(isAuthorized(request("/status"), STATUS_TOKEN)).toBe(false); // no header
    expect(
      isAuthorized(request("/status", { headers: { Authorization: STATUS_TOKEN } }), STATUS_TOKEN),
    ).toBe(false); // no Bearer scheme
    expect(
      isAuthorized(request("/status", { headers: { Authorization: "Basic dXNlcjpwYXNz" } }), STATUS_TOKEN),
    ).toBe(false); // wrong scheme
    expect(
      isAuthorized(request("/status", { headers: { Authorization: "Bearer" } }), STATUS_TOKEN),
    ).toBe(false); // malformed
  });

  it("fails closed when no token is configured (endpoint disabled)", () => {
    const withToken = request("/status", { headers: { Authorization: `Bearer ${STATUS_TOKEN}` } });
    expect(isAuthorized(withToken, undefined)).toBe(false);
    expect(isAuthorized(request("/status"), undefined)).toBe(false);
  });
});

describe("buildStatus (read-only payload from D1)", () => {
  it("returns 3 stores x 8 parts with static metadata, nulls on an empty database", async () => {
    const mock = new MockD1();
    const payload = await buildStatus(mock as unknown as D1Database, NOW);

    expect(payload.generatedAt).toBe(NOW);
    expect(payload.meta).toEqual({
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      lastErrorAt: null,
    });
    expect(payload.backoff).toBeNull();
    expect(payload.stores).toHaveLength(3);
    expect(payload.stores.map((store) => store.number)).toEqual(["R513", "R123", "R133"]);

    const coolSprings = payload.stores[0]!;
    expect(coolSprings.name).toBe("Apple CoolSprings Galleria");
    expect(coolSprings.city).toBe("Franklin, Tennessee");
    expect(coolSprings.parts).toHaveLength(8);
    expect(coolSprings.parts[0]).toEqual({
      part: "MK1E4LL/A",
      storage: "256GB",
      color: "Star White",
      state: null, // never observed
      updatedAt: null,
      alertedAt: null,
    });
  });

  it("surfaces per-part states, timestamps, alerts, backoff, and meta", async () => {
    const mock = new MockD1();
    const d1 = mock as unknown as D1Database;
    await upsertStates(
      d1,
      [
        { storeNumber: "R513", partNumber: "MK1H4LL/A", available: 1 }, // confirmed available
        { storeNumber: "R513", partNumber: "MK1G4LL/A", available: 0 }, // confirmed unavailable
        { storeNumber: "R123", partNumber: "MK1J4LL/A", available: 2 }, // pending confirmation
      ],
      555,
    );
    await markAttempt(d1, 990);
    await markSuccess(d1, 995);
    await markError(d1, "HTTP 541", 998);
    await recordFailure(d1, 2, 1234);

    const payload: StatusPayload = await buildStatus(d1, NOW);
    const part = (store: string, partNumber: string) =>
      payload.stores.find((s) => s.number === store)!.parts.find((p) => p.part === partNumber)!;

    expect(part("R513", "MK1H4LL/A")!.state).toBe(1);
    expect(part("R513", "MK1H4LL/A")!.updatedAt).toBe(555);
    expect(part("R513", "MK1G4LL/A")!.state).toBe(0);
    expect(part("R123", "MK1J4LL/A")!.state).toBe(2); // pending -> dashboard shows "Checking"
    expect(part("R133", "MK1E4LL/A")!.state).toBeNull(); // never observed -> "Unknown"

    expect(payload.meta).toEqual({
      lastAttemptAt: 990,
      lastSuccessAt: 995,
      lastError: "HTTP 541",
      lastErrorAt: 998,
    });
    expect(payload.backoff).toEqual({ consecutiveFailures: 2, nextAttemptAt: 1234 });
  });
});

describe("GET /status route (via the Worker fetch handler)", () => {
  it("returns 404 for unauthorized, malformed, and wrong-method requests", async () => {
    const env = makeEnv(new MockD1() as unknown as D1Database);
    const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

    const noHeader = await worker.fetch(request("/status"), env);
    expect(noHeader.status).toBe(404);

    const wrongToken = await worker.fetch(request("/status", bearer("wrong")), env);
    expect(wrongToken.status).toBe(404);

    const wrongScheme = await worker.fetch(
      request("/status", { headers: { Authorization: `Basic ${STATUS_TOKEN}` } }),
      env,
    );
    expect(wrongScheme.status).toBe(404);

    const wrongMethod = await worker.fetch(request("/status", { method: "POST", ...bearer(STATUS_TOKEN) }), env);
    expect(wrongMethod.status).toBe(404);
  });

  it("fails closed (404) when DASHBOARD_STATUS_TOKEN is not configured", async () => {
    // Build the env manually: the key must be truly ABSENT (passing undefined
    // to makeEnv would trigger its default parameter).
    const mock = new MockD1();
    const env = {
      DB: mock as unknown as D1Database,
      TELEGRAM_BOT_TOKEN: "telegram-token",
      TELEGRAM_CHAT_ID: "42",
    };
    const response = await worker.fetch(
      request("/status", { headers: { Authorization: `Bearer ${STATUS_TOKEN}` } }),
      env,
    );
    expect(response.status).toBe(404);
  });

  it("returns the full status payload for an authorized GET", async () => {
    const mock = new MockD1();
    await upsertStates(mock as unknown as D1Database, [
      { storeNumber: "R513", partNumber: "MK1H4LL/A", available: 1 },
    ], 555);
    const env = makeEnv(mock as unknown as D1Database);

    const response = await worker.fetch(
      request("/status", { headers: { Authorization: `Bearer ${STATUS_TOKEN}` } }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const payload = (await response.json()) as StatusPayload;
    expect(payload.stores).toHaveLength(3);
    expect(payload.stores[0]!.parts).toHaveLength(8);
    expect(payload.stores[0]!.parts.find((p) => p.part === "MK1H4LL/A")!.state).toBe(1);
  });

  it("other routes remain 404 in production-like env (no DEV_TEST_ROUTE)", async () => {
    const env = makeEnv(new MockD1() as unknown as D1Database);
    expect((await worker.fetch(request("/"), env)).status).toBe(404);
    expect((await worker.fetch(request("/test-telegram"), env)).status).toBe(404);
    expect((await worker.fetch(request("/debug-apple"), env)).status).toBe(404);
  });
});

