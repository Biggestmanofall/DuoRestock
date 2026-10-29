import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { MockD1 } from "./helpers/mock-d1";
import { runCheck } from "../src/run";

const TELEGRAM = { token: "test-token", chatId: "42" };

function appleBody(available: boolean): Record<string, unknown> {
  return {
    stores: [
      {
        storeNumber: "R513",
        storeName: "Apple CoolSprings Galleria",
        partsAvailability: {
          "MK1H4LL/A": available
            ? {
                pickupDisplay: "available",
                messageTypes: {
                  regular: {
                    storeSelectionEnabled: true,
                    storePickupProductTitle: "iPhone Duo 512GB Night Sky",
                    storePickupQuote: "Tomorrow",
                  },
                },
              }
            : {
                pickupDisplay: "unavailable",
                messageTypes: {
                  regular: {
                    storeSelectionEnabled: false,
                    storePickupProductTitle: "iPhone Duo 512GB Night Sky",
                    storePickupQuote: "Currently unavailable",
                  },
                },
              },
        },
      },
    ],
  };
}

type AppleScript = Record<string, unknown> | Response;

function makeHarness(appleScript: AppleScript[]) {
  const mock = new MockD1();
  let now = 1_000_000_000_000;
  const queue: AppleScript[] = [...appleScript];
  const telegram = { ok: true, messages: [] as string[] };

  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    if (target.startsWith("https://www.apple.com/")) {
      const next = queue.shift();
      if (next === undefined) throw new Error("script ran out of Apple responses");
      if (next instanceof Response) return next;
      // The real endpoint wraps its payload in a top-level {"body": {...}} envelope.
      return Response.json({ body: next });
    }
    if (target.startsWith("https://api.telegram.org/")) {
      if (!telegram.ok) return new Response("nope", { status: 500 });
      const body = JSON.parse(String(init?.body)) as { text: string };
      telegram.messages.push(body.text);
      return Response.json({ ok: true, result: { message_id: telegram.messages.length } });
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  const run = () =>
    runCheck({
      db: mock as unknown as D1Database,
      telegram: TELEGRAM,
      nowMs: () => now,
      fetchImpl,
    });

  return {
    mock,
    telegram,
    queue,
    run,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("runCheck (end-to-end orchestration with fakes)", () => {
  it("steady unavailable: records baseline state, never alerts", async () => {
    const h = makeHarness([appleBody(false)]);
    const outcome = await h.run();
    expect(outcome).toEqual({ status: "ok", checked: 1, availableNow: 0, alertsSent: 0, suppressed: 0 });
    expect(h.mock.stateValue("R513", "MK1H4LL/A")).toBe(0);
    expect(h.telegram.messages).toEqual([]);
  });

  it("full transition flow: pending -> confirmation -> one alert -> quiet", async () => {
    const h = makeHarness([appleBody(false), appleBody(true), appleBody(true), appleBody(true)]);

    await h.run(); // baseline
    await h.advance(60_000);
    const second = await h.run(); // first sight: pending only, NO alert yet
    expect(second.status).toBe("ok");
    if (second.status === "ok") expect(second.alertsSent).toBe(0);
    expect(h.mock.stateValue("R513", "MK1H4LL/A")).toBe(2);
    expect(h.telegram.messages).toEqual([]);

    await h.advance(60_000);
    const third = await h.run(); // confirmation run: alert fires
    if (third.status === "ok") expect(third.alertsSent).toBe(1);
    expect(h.telegram.messages).toHaveLength(1);
    expect(h.telegram.messages[0]).toContain("Apple CoolSprings Galleria");
    expect(h.telegram.messages[0]).toContain("iPhone Duo 512GB Night Sky");
    expect(h.mock.stateValue("R513", "MK1H4LL/A")).toBe(1);
    expect(h.mock.lastAlertAt("R513", "MK1H4LL/A")).toBeDefined();

    await h.advance(60_000);
    const fourth = await h.run(); // still available: no duplicate alert
    if (fourth.status === "ok") expect(fourth.alertsSent).toBe(0);
    expect(h.telegram.messages).toHaveLength(1);
  });

  it("near miss: availability vanishes before confirmation -> no alert, state reset", async () => {
    const h = makeHarness([appleBody(false), appleBody(true), appleBody(false)]);
    await h.run();
    await h.run(); // pending
    await h.run(); // gone again
    expect(h.telegram.messages).toEqual([]);
    expect(h.mock.stateValue("R513", "MK1H4LL/A")).toBe(0);
  });

  it("failed check: backoff ledger set, NO state writes, gated retry consumes no request", async () => {
    const h = makeHarness([new Response("nope", { status: 503 }), appleBody(true)]);

    const first = await h.run();
    expect(first).toEqual({ status: "error", message: "HTTP 503", backoffSeconds: 60 });
    expect(h.mock.failure).toEqual({ consecutive: 1, nextAttemptAt: 1_000_000_000_000 + 60_000 });
    expect(h.mock.states.size).toBe(0); // failure never written as "unavailable"

    h.advance(30_000);
    const gated = await h.run(); // not due yet: skips without touching Apple
    expect(gated).toEqual({ status: "backing-off", nextAttemptAt: 1_000_000_000_000 + 60_000 });
    expect(h.queue).toHaveLength(1); // no request consumed

    h.advance(31_000);
    const retry = await h.run(); // due now: succeeds, backoff cleared
    expect(retry.status).toBe("ok");
    expect(h.mock.failure).toBeNull();
    expect(h.mock.stateValue("R513", "MK1H4LL/A")).toBe(2);
  });

  it("response without monitored stores is ambiguous: error + backoff, never 'all unavailable'", async () => {
    const h = makeHarness([
      { stores: [{ storeNumber: "R591", storeName: "Elsewhere", partsAvailability: {} }] },
    ]);
    const outcome = await h.run();
    expect(outcome.status).toBe("error");
    if (outcome.status === "error") expect(outcome.message).toContain("no records");
    expect(h.mock.states.size).toBe(0);
    expect(h.mock.failure).not.toBeNull();
  });

  it("telegram send failure: stays pending, alert retried next run, no double alert", async () => {
    const h = makeHarness([appleBody(false), appleBody(true), appleBody(true), appleBody(true)]);

    await h.run();
    await h.run(); // pending

    h.telegram.ok = false;
    const failed = await h.run(); // confirmation run, but Telegram fails
    if (failed.status === "ok") expect(failed.alertsSent).toBe(0);
    expect(h.mock.stateValue("R513", "MK1H4LL/A")).toBe(2); // stays pending
    expect(h.mock.lastAlertAt("R513", "MK1H4LL/A")).toBeUndefined();

    h.telegram.ok = true;
    const retried = await h.run(); // alert eventually delivered exactly once
    if (retried.status === "ok") expect(retried.alertsSent).toBe(1);
    expect(h.telegram.messages).toHaveLength(1);
    expect(h.mock.stateValue("R513", "MK1H4LL/A")).toBe(1);
  });

  it("cooldown suppresses re-alert on a quick availability flap", async () => {
    const h = makeHarness([
      appleBody(false), // r1 baseline
      appleBody(true), // r2 pending
      appleBody(true), // r3 alert!
      appleBody(false), // r4 gone
      appleBody(true), // r5 pending again
      appleBody(true), // r6 still available, but within cooldown
    ]);

    await h.run();
    h.advance(60_000);
    await h.run();
    h.advance(60_000);
    const alerted = await h.run();
    if (alerted.status === "ok") expect(alerted.alertsSent).toBe(1);

    h.advance(60_000);
    await h.run(); // gone
    h.advance(60_000);
    await h.run(); // pending again
    h.advance(60_000); // only 3 min since the alert: still inside the 5-min cooldown
    const suppressed = await h.run();
    if (suppressed.status === "ok") expect(suppressed.suppressed).toBe(1);
    expect(h.telegram.messages).toHaveLength(1); // no duplicate alert
    expect(h.mock.stateValue("R513", "MK1H4LL/A")).toBe(1);
  });
});
