/**
 * Read-only status payload for the private dashboard, plus bearer-token
 * authorization for the /status endpoint.
 *
 * Security properties:
 * - The endpoint exposes ONLY monitoring state: per-store/per-part pickup
 *   states, alert times, backoff ledger, and freshness metadata. No secrets,
 *   no Telegram credentials, no store IDs beyond the public retail numbers.
 * - The browser never talks to this endpoint directly; only the dashboard's
 *   server-side proxy holds the token.
 * - Authorization is a constant-time bearer-token comparison; anything wrong
 *   (missing/malformed header, wrong token, token not configured) yields a
 *   plain 404 so the endpoint's existence is not advertised.
 * - No SQL is executed on behalf of the request: fixed SELECTs only.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { PARTS, STORES } from "./config";
import { stateKey } from "./availability";
import {
  getFailureState,
  getLastAlertTimes,
  getMeta,
  getStateRows,
  type MetaRow,
} from "./state";

// ------------------------------------------------------------------ auth

const encoder = new TextEncoder();

/** Constant-time string equality (length differences do not short-circuit). */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const length = Math.max(aBytes.length, bBytes.length);
  let diff = 0;
  for (let i = 0; i < length; i += 1) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0 && aBytes.length === bBytes.length;
}

/**
 * True only for a GET-style request bearing `Authorization: Bearer <token>`
 * where the token matches exactly. Fails closed when no token is configured.
 */
export function isAuthorized(request: Request, configuredToken: string | undefined): boolean {
  if (!configuredToken) return false; // endpoint disabled until the secret exists
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return false;
  return timingSafeEqualStrings(header.slice("Bearer ".length).trim(), configuredToken);
}

// --------------------------------------------------------------- payload

export interface StatusPart {
  readonly part: string;
  readonly storage: string;
  readonly color: string;
  /** 0 = confirmed unavailable, 1 = confirmed available, 2 = pending confirmation, null = never observed. */
  readonly state: 0 | 1 | 2 | null;
  readonly updatedAt: number | null;
  readonly alertedAt: number | null;
}

export interface StatusStore {
  readonly number: string;
  readonly name: string;
  readonly city: string;
  readonly parts: StatusPart[];
}

export interface StatusPayload {
  readonly generatedAt: number;
  readonly meta: {
    readonly lastAttemptAt: number | null;
    readonly lastSuccessAt: number | null;
    readonly lastError: string | null;
    readonly lastErrorAt: number | null;
  };
  readonly backoff: { readonly consecutiveFailures: number; readonly nextAttemptAt: number } | null;
  readonly stores: StatusStore[];
}

export async function buildStatus(db: D1Database, nowMs: number): Promise<StatusPayload> {
  const [stateRows, alertTimes, failure, meta] = await Promise.all([
    getStateRows(db),
    getLastAlertTimes(db),
    getFailureState(db),
    getMeta(db),
  ]);

  const metaRow: MetaRow | null = meta;
  const stores: StatusStore[] = STORES.map((store) => ({
    number: store.number,
    name: store.name,
    city: store.city,
    parts: PARTS.map((part) => {
      const key = stateKey(store.number, part.number);
      const row = stateRows.get(key);
      return {
        part: part.number,
        storage: part.storage,
        color: part.color,
        state: row ? row.available : null,
        updatedAt: row ? row.updatedAt : null,
        alertedAt: alertTimes.get(key) ?? null,
      };
    }),
  }));

  return {
    generatedAt: nowMs,
    meta: {
      lastAttemptAt: metaRow ? metaRow.lastAttemptAt : null,
      lastSuccessAt: metaRow ? metaRow.lastSuccessAt : null,
      lastError: metaRow ? metaRow.lastError : null,
      lastErrorAt: metaRow ? metaRow.lastErrorAt : null,
    },
    backoff: failure
      ? { consecutiveFailures: failure.consecutiveFailures, nextAttemptAt: failure.nextAttemptAt }
      : null,
    stores,
  };
}
