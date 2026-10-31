/**
 * Worker entry point.
 *
 * - scheduled(): the one-minute Cron Trigger — one availability check per run.
 * - fetch(): 404 for everything, EXCEPT a strictly development-only
 *   /test-telegram route that requires DEV_TEST_ROUTE=enabled. That value
 *   exists ONLY in the local .dev.vars file; it is never set in production,
 *   so the production Worker can never send messages via fetch.
 *
 * This bot alerts only — it never buys, reserves, adds to a bag, or checks out.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { APPLE, SCHEDULE, buildPickupUrl } from "./config";
import { runMonitoringInvocation } from "./monitor-loop";
import { runCheck } from "./run";
import { buildStatus, isAuthorized } from "./status";
import { acquireMonitorLease, releaseMonitorLease } from "./state";
import { sendTelegramMessage } from "./telegram";

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  /**
   * Bearer token required by GET /status (read-only dashboard data).
   * When unset, /status always returns 404 — the endpoint is disabled.
   * Set via `npx wrangler secret put DASHBOARD_STATUS_TOKEN`.
   */
  DASHBOARD_STATUS_TOKEN?: string;
  /** Local-development-only flag; must never be set in production. */
  DEV_TEST_ROUTE?: string;
}

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // 20-second monitoring loop (Option A): the * * * * * cron fires each
    // minute; this invocation performs checks at slots 0/20/40s, only within
    // the 7:00–18:00 America/Chicago window, strictly sequentially.
    ctx.waitUntil(
      runMonitoringInvocation({
        runCheckFn: () =>
          runCheck({
            db: env.DB,
            telegram: { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID },
            nowMs: () => Date.now(),
            fetchImpl: fetch,
          }),
        wait: (ms: number) => scheduler.wait(ms),
        now: () => Date.now(),
        acquireLease: () => acquireMonitorLease(env.DB, Date.now(), SCHEDULE.leaseHoldMs),
        releaseLease: () => releaseMonitorLease(env.DB),
      })
        .then((outcome) => {
          // Structured outcome log for observability (Workers Logs / wrangler tail).
          console.log(`monitor invocation: ${JSON.stringify(outcome)}`);
        })
        .catch((error: unknown) => {
          console.error(
            `monitor invocation crashed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/status") {
      // Read-only dashboard data. GET only, bearer-token gated; anything
      // wrong (wrong method, missing/malformed/wrong token, or the secret
      // not being configured at all) returns an indistinguishable 404 so
      // the endpoint is not advertised. Never executes request-driven SQL,
      // never exposes secrets, never triggers an Apple request.
      if (request.method !== "GET" || !isAuthorized(request, env.DASHBOARD_STATUS_TOKEN)) {
        return new Response("Not Found", { status: 404 });
      }
      const payload = await buildStatus(env.DB, Date.now());
      return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/test-telegram" && request.method === "GET") {
      if (env.DEV_TEST_ROUTE !== "enabled") {
        // Production (and any misconfigured deploy): never send anything.
        return new Response("Not Found", { status: 404 });
      }
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        return Response.json({ ok: false, error: "missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID" }, { status: 500 });
      }
      try {
        const result = await sendTelegramMessage(
          { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID },
          "✅ DuoRestockBot Worker here — Telegram delivery test successful. iPhone Duo restock alerts are coming to this chat!",
          fetch,
        );
        return Response.json({ ok: true, messageId: result.messageId });
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }

    if (url.pathname === "/debug-apple" && request.method === "GET") {
      // Dev-only diagnostic: shows exactly how Apple responds to the Worker's
      // own fetch (status, headers, body snippet). Read-only; no state changes.
      if (env.DEV_TEST_ROUTE !== "enabled") {
        return new Response("Not Found", { status: 404 });
      }
      const variant = url.searchParams.get("variant") ?? "plain";
      const headers: Record<string, string> = { "User-Agent": APPLE.userAgent };
      if (variant === "browser") {
        headers["Accept"] = "application/json";
        headers["Accept-Language"] = "en-US,en;q=0.9";
      }
      const response = await fetch(buildPickupUrl(), { headers });
      const body = await response.text();
      return Response.json({
        variant,
        status: response.status,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        bodySnippet: body.slice(0, 300),
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
