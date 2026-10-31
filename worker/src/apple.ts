/**
 * Apple pickup availability fetch + response validation.
 *
 * Deliberately ONE request per invocation with no in-invocation retries:
 * persistent failures are handled by the cron-level exponential backoff gate
 * (see state.ts / run.ts), which keeps total request volume conservative.
 *
 * A failed request always throws — never interpreted as "out of stock".
 */

import { AppleResponseError } from "./availability";

export type FetchLike = typeof fetch;

export interface FetchPickupOptions {
  readonly timeoutMs?: number;
}

/** Fetch and validate the pickup availability response; returns the `body` object. */
export async function fetchPickupBody(
  url: string,
  userAgent: string,
  fetchImpl: FetchLike,
  options: FetchPickupOptions = {},
): Promise<unknown> {
  // 10-second timeout (approved): the 20-second check cadence cannot afford a
  // 20-second hung request. A timeout is ALWAYS an error (TimeoutError) —
  // never confirmed unavailability. If legitimate Apple responses ever need
  // longer than 10s, that gets reported and re-approved, not silently raised.
  const timeoutMs = options.timeoutMs ?? 10_000;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { "User-Agent": userAgent },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.name : "unknown";
    throw new AppleResponseError(`network error (${reason})`);
  }

  if (!response.ok) {
    throw new AppleResponseError(`HTTP ${response.status}`);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new AppleResponseError("invalid JSON response");
  }

  if (typeof data !== "object" || data === null) {
    throw new AppleResponseError("unexpected response shape: response is not an object");
  }
  const body = (data as Record<string, unknown>)["body"];
  if (typeof body !== "object" || body === null) {
    throw new AppleResponseError("unexpected response shape: no body object");
  }
  const stores = (body as Record<string, unknown>)["stores"];
  if (!Array.isArray(stores)) {
    const errorMessage = (body as Record<string, unknown>)["errorMessage"];
    const detail =
      typeof errorMessage === "string" && errorMessage ? errorMessage : "no stores in reply";
    throw new AppleResponseError(`unexpected response shape: ${detail}`);
  }
  return body;
}
