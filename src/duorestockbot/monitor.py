"""Polling monitor: fetch availability, detect transitions, dedupe, and alert.

Guarantees:
- One HTTP request per poll (covers all stores and all parts).
- A failed check is never interpreted as out-of-stock; persistent failures
  trigger exponential backoff (configurable, capped).
- On a hit: wait ``recheck_delay_seconds`` and re-check with a fresh request
  before alerting, to filter out momentary glitches.
- Duplicate prevention: alert only on an unavailable→available transition, and
  never twice for the same (store, part) within the cooldown window.
- Alert only — never purchases, reserves, or adds anything to a bag.
"""

from __future__ import annotations

import logging
import signal
import time
from datetime import datetime, timedelta
from typing import Callable, Iterable, Mapping

from .apple_client import ApplePickupClient, ApplePickupError
from .db import StateDB, utc_now
from .inventory import PickupAvailability, parse_pickup_response
from .telegram import TelegramClient, TelegramError

logger = logging.getLogger(__name__)

SleepFn = Callable[[float], None]
ClockFn = Callable[[], datetime]


def select_alert_candidates(
    available_now: Iterable[PickupAvailability],
    previous_states: Mapping[tuple[str, str], bool],
    last_alerts: Mapping[tuple[str, str], datetime | None],
    now: datetime,
    cooldown_minutes: int,
) -> list[PickupAvailability]:
    """Pick hits that are fresh unavailable→available transitions outside cooldown."""
    cooldown = timedelta(minutes=cooldown_minutes)
    candidates: list[PickupAvailability] = []
    for item in available_now:
        if previous_states.get(item.key) is True:
            continue  # already known available; no new transition
        last_alert = last_alerts.get(item.key)
        if last_alert is not None and (now - last_alert) < cooldown:
            continue  # duplicate alert suppressed within cooldown window
        candidates.append(item)
    return candidates


def build_alert_message(items: list[PickupAvailability], buy_url: str) -> str:
    """Build the Telegram alert: store, configuration, pickup details, product link."""
    lines = ["🚨 iPhone Duo pickup available!", ""]
    for item in items:
        lines.append(f"📍 {item.store_name}")
        lines.append(f"📱 {item.product_title or item.part_number}")
        if item.pickup_quote:
            lines.append(f"🕒 {item.pickup_quote}")
        lines.append("")
    lines.append(f"🔗 {buy_url}")
    lines.append("Go reserve/order it yourself — this bot only alerts.")
    return "\n".join(lines)


class RestockMonitor:
    """Continuous polling monitor with transition detection and dedup alerts."""

    def __init__(
        self,
        config,
        apple_client: ApplePickupClient,
        telegram: TelegramClient,
        db: StateDB,
        sleep: SleepFn = time.sleep,
        clock: ClockFn = utc_now,
    ) -> None:
        self._config = config
        self._apple = apple_client
        self._telegram = telegram
        self._db = db
        self._sleep = sleep
        self._clock = clock
        self._stop = False

    # ------------------------------------------------------------------ helpers

    def request_stop(self, signum=None, frame=None) -> None:  # noqa: ARG002 (signal signature)
        logger.info("stop requested%s", f" (signal {signum})" if signum else "")
        self._stop = True

    def _interruptible_sleep(self, seconds: float) -> None:
        """Sleep in small increments so shutdown is not blocked by a long backoff."""
        remaining = float(seconds)
        while remaining > 0 and not self._stop:
            self._sleep(min(remaining, 1.0))
            remaining -= 1.0

    def _install_signal_handlers(self) -> None:
        try:
            signal.signal(signal.SIGINT, self.request_stop)
            signal.signal(signal.SIGTERM, self.request_stop)
        except ValueError:  # not in main thread (e.g. tests)
            pass

    def _fetch_records(self) -> list[PickupAvailability]:
        body = self._apple.fetch()
        return parse_pickup_response(body, self._config.store_numbers)

    def _recheck(self, candidates: list[PickupAvailability]) -> list[PickupAvailability]:
        """Re-check with a fresh request before alerting; keep still-available items.

        If the recheck request itself fails, keep all candidates (a failed check
        is never treated as out-of-stock) but note it in the log.
        """
        self._interruptible_sleep(self._config.monitor.recheck_delay_seconds)
        if self._stop:
            return []
        try:
            records = self._fetch_records()
        except ApplePickupError as exc:
            logger.warning("confirmation recheck failed (%s); alerting on unconfirmed hit", exc)
            return candidates
        still_available = {item.key for item in records if item.available}
        confirmed = [item for item in candidates if item.key in still_available]
        for item in candidates:
            if item.key not in still_available:
                logger.info(
                    "near miss: %s at %s vanished before confirmation", item.part_number, item.store_name
                )
        return confirmed

    def _send_alert(self, items: list[PickupAvailability]) -> bool:
        message = build_alert_message(items, self._config.apple.buy_url)
        try:
            self._telegram.send_message(message)
        except TelegramError:
            logger.exception("failed to send Telegram alert; will retry on next poll")
            return False
        for item in items:
            self._db.record_alert(item.store_number, item.part_number)
        logger.info("alert sent for %d item(s)", len(items))
        return True

    # ------------------------------------------------------------------- loop

    def run(self) -> None:
        self._install_signal_handlers()
        monitor_cfg = self._config.monitor
        logger.info(
            "monitoring %d store(s) for %d iPhone Duo configuration(s) every %ds",
            len(self._config.stores),
            len(self._config.parts),
            monitor_cfg.poll_interval_seconds,
        )
        backoff_seconds: float | None = None

        while not self._stop:
            try:
                records = self._fetch_records()
            except ApplePickupError as exc:
                if backoff_seconds is None:
                    backoff_seconds = float(monitor_cfg.backoff_initial_seconds)
                else:
                    backoff_seconds = min(backoff_seconds * 2, float(monitor_cfg.backoff_max_seconds))
                logger.warning(
                    "availability check failed (%s); backing off %.0fs — NOT treating as out-of-stock",
                    exc,
                    backoff_seconds,
                )
                self._interruptible_sleep(backoff_seconds)
                continue
            backoff_seconds = None  # successful check resets backoff

            if not records:
                logger.warning("pickup response contained no records for the monitored stores")

            now = self._clock()
            available = [record for record in records if record.available]
            previous_states = self._db.get_states()
            last_alerts = {item.key: self._db.last_alert(*item.key) for item in available}
            candidates = select_alert_candidates(
                available, previous_states, last_alerts, now, monitor_cfg.cooldown_minutes
            )

            alert_failed_keys: set[tuple[str, str]] = set()
            if candidates:
                logger.info(
                    "potential restock: %d new (store, configuration) pair(s); re-checking to confirm",
                    len(candidates),
                )
                confirmed = self._recheck(candidates)
                if confirmed and not self._send_alert(confirmed):
                    alert_failed_keys = {item.key for item in confirmed}

            # Persist states. Keys whose alert failed keep their previous state so
            # the transition re-triggers and the alert is retried next poll.
            state_records = [
                (
                    record.store_number,
                    record.part_number,
                    record.available if record.key not in alert_failed_keys else bool(previous_states.get(record.key)),
                )
                for record in records
            ]
            self._db.update_states(state_records, now)

            if available:
                logger.info("%d of %d monitored pair(s) currently available", len(available), len(records))
            else:
                logger.info("checked %d pair(s): all unavailable", len(records))

            self._interruptible_sleep(monitor_cfg.poll_interval_seconds)

        logger.info("monitor stopped cleanly")

