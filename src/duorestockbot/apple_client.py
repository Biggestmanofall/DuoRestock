"""Client for Apple's public in-store pickup availability endpoint.

Endpoint behavior (verified live on 2026-10-29):

- GET {endpoint}?pl=true&mts.0=regular&location=<city/state or ZIP>&parts.0=<P0>&parts.1=<P1>...
- One request returns the ~12 nearest stores to ``location`` together with
  availability for every requested part at each store — no per-store/per-part loops.
- Unauthenticated, public, JSON response shaped ``{"body": {"stores": [...]}}``.
- Apple may also reply 200 with ``body.errorMessage`` (e.g. throttling); that is
  a FAILED check, not "out of stock".

A failed request always raises :class:`ApplePickupError` — it must never be
interpreted as an out-of-stock result, or real restocks would be missed.
"""

from __future__ import annotations

import time
from typing import Any, Iterable
from urllib.parse import urlencode

import requests


class ApplePickupError(RuntimeError):
    """Raised when the pickup availability request fails or returns an unusable reply."""


class ApplePickupClient:
    """Fetch in-store pickup availability for all configured parts in one request."""

    def __init__(
        self,
        endpoint: str,
        location: str,
        part_numbers: Iterable[str],
        user_agent: str,
        timeout: float = 20.0,
        max_retries: int = 3,
        retry_backoff_seconds: float = 2.0,
        session: requests.Session | None = None,
    ) -> None:
        parts = tuple(part_numbers)
        if not parts:
            raise ValueError("part_numbers must not be empty")
        self._endpoint = endpoint
        self._location = location
        self._part_numbers = tuple(sorted(set(parts)))
        self._timeout = timeout
        self._max_retries = max_retries
        self._retry_backoff_seconds = retry_backoff_seconds
        self._session = session or requests.Session()
        self._session.headers["User-Agent"] = user_agent

    def build_url(self) -> str:
        """Build the pickup availability URL covering every part in one request."""
        params: list[tuple[str, str]] = [
            ("pl", "true"),
            ("mts.0", "regular"),
            ("location", self._location),
        ]
        params.extend((f"parts.{index}", part) for index, part in enumerate(self._part_numbers))
        return f"{self._endpoint}?{urlencode(params)}"

    def fetch(self) -> dict[str, Any]:
        """Fetch and return the parsed ``body`` object.

        Retries transient failures with exponential backoff, then raises
        :class:`ApplePickupError`. Never returns a substitute "empty" result.
        """
        url = self.build_url()
        last_error = "unknown error"
        for attempt in range(self._max_retries):
            try:
                response = self._session.get(url, timeout=self._timeout)
            except requests.RequestException as exc:
                last_error = f"network error ({type(exc).__name__})"
            else:
                if 200 <= response.status_code < 300:
                    try:
                        data = response.json()
                    except ValueError:
                        last_error = "invalid JSON response"
                    else:
                        body = data.get("body") if isinstance(data, dict) else None
                        if isinstance(body, dict) and isinstance(body.get("stores"), list):
                            return body
                        error_message = body.get("errorMessage") if isinstance(body, dict) else None
                        last_error = f"unexpected response shape: {error_message or 'no stores in reply'}"
                else:
                    last_error = f"HTTP {response.status_code}"
            if attempt < self._max_retries - 1:
                time.sleep(self._retry_backoff_seconds * (2**attempt))
        raise ApplePickupError(
            f"Apple pickup availability request failed after {self._max_retries} attempts: {last_error}"
        )
