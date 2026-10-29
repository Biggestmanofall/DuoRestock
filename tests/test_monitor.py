"""Tests for monitor logic: candidate selection, message building, and the run loop."""

from __future__ import annotations

from datetime import timedelta

from duorestockbot.apple_client import ApplePickupError
from duorestockbot.config import AppleSettings, AppConfig, MonitorSettings, Part, Store
from duorestockbot.db import StateDB, utc_now
from duorestockbot.inventory import PickupAvailability
from duorestockbot.monitor import RestockMonitor, build_alert_message, select_alert_candidates


def make_item(available=True, store="R513", part="MK1H4LL/A"):
    return PickupAvailability(
        store_number=store,
        store_name="Apple CoolSprings Galleria",
        part_number=part,
        product_title="iPhone Duo 512GB Night Sky",
        pickup_quote="Tomorrow at Apple CoolSprings Galleria",
        available=available,
    )


def test_candidates_include_fresh_transitions():
    now = utc_now()
    candidates = select_alert_candidates([make_item()], {}, {}, now, cooldown_minutes=5)
    assert len(candidates) == 1


def test_candidates_skip_already_known_available():
    now = utc_now()
    item = make_item()
    candidates = select_alert_candidates([item], {item.key: True}, {}, now, cooldown_minutes=5)
    assert candidates == []


def test_candidates_suppressed_within_cooldown():
    now = utc_now()
    item = make_item()
    recent = now - timedelta(minutes=1)
    candidates = select_alert_candidates([item], {item.key: False}, {item.key: recent}, now, 5)
    assert candidates == []


def test_candidates_allowed_after_cooldown_expires():
    now = utc_now()
    item = make_item()
    old = now - timedelta(minutes=10)
    candidates = select_alert_candidates([item], {item.key: False}, {item.key: old}, now, 5)
    assert len(candidates) == 1


def test_build_alert_message_contents():
    message = build_alert_message([make_item()], "https://www.apple.com/shop/buy-iphone/iphone-duo")
    assert "Apple CoolSprings Galleria" in message
    assert "iPhone Duo 512GB Night Sky" in message
    assert "Tomorrow at Apple CoolSprings Galleria" in message
    assert "https://www.apple.com/shop/buy-iphone/iphone-duo" in message


# ------------------------------------------------------------------ run loop


def make_config(poll_interval=5):
    return AppConfig(
        stores=(Store("R513", "Apple CoolSprings Galleria"),),
        parts=(Part("MK1H4LL/A", "iPhone Duo 512GB Night Sky", "Night Sky", "512GB"),),
        monitor=MonitorSettings(
            poll_interval_seconds=poll_interval,
            recheck_delay_seconds=0,
            cooldown_minutes=5,
            backoff_initial_seconds=60,
            backoff_max_seconds=900,
        ),
        apple=AppleSettings(
            pickup_endpoint="https://example.com/pickup-message",
            location="Nashville, TN",
            user_agent="TestAgent/1.0",
            buy_url="https://www.apple.com/shop/buy-iphone/iphone-duo",
        ),
        telegram_bot_token="test-token",
        telegram_chat_id="42",
    )


def make_store_body(part_data):
    return {
        "stores": [
            {
                "storeNumber": "R513",
                "storeName": "Apple CoolSprings Galleria",
                "partsAvailability": part_data,
            }
        ]
    }


def part_entry(pickup_display, enabled, title="iPhone Duo 512GB Night Sky"):
    return {
        "pickupDisplay": pickup_display,
        "messageTypes": {
            "regular": {
                "storeSelectionEnabled": enabled,
                "storePickupProductTitle": title,
                "storePickupQuote": "Tomorrow",
            }
        },
    }


class FakeApple:
    def __init__(self, bodies):
        self.bodies = list(bodies)

    def fetch(self):
        return self.bodies.pop(0)


class FailingApple:
    def fetch(self):
        raise ApplePickupError("HTTP 503")


class FakeTelegram:
    def __init__(self):
        self.sent: list[str] = []

    def send_message(self, text, chat_id=None):
        self.sent.append(text)
        return {"message_id": len(self.sent)}


def test_run_loop_alerts_once_on_transition():
    unavailable = make_store_body({"MK1H4LL/A": part_entry("unavailable", False)})
    available = make_store_body({"MK1H4LL/A": part_entry("available", True)})

    # poll 1: out of stock; poll 2: available (initial + confirmation recheck); poll 3: still available.
    apple = FakeApple([unavailable, available, available, available])
    telegram = FakeTelegram()
    db = StateDB(":memory:")
    config = make_config(poll_interval=5)

    sleep_calls = {"count": 0}

    def fake_sleep(_seconds):
        sleep_calls["count"] += 1
        if sleep_calls["count"] >= 11:  # end after poll 2's post-poll sleep
            monitor.request_stop()

    monitor = RestockMonitor(config, apple, telegram, db, sleep=fake_sleep)
    monitor.run()

    # Exactly one alert despite availability persisting across polls 2 and 3.
    assert len(telegram.sent) == 1
    assert "Apple CoolSprings Galleria" in telegram.sent[0]
    assert "iPhone Duo 512GB Night Sky" in telegram.sent[0]
    # Final persisted state reflects availability, and the alert was recorded.
    assert db.get_states() == {("R513", "MK1H4LL/A"): True}
    assert db.last_alert("R513", "MK1H4LL/A") is not None
    db.close()


def test_run_loop_backs_off_on_failure_and_never_alerts():
    telegram = FakeTelegram()
    db = StateDB(":memory:")
    config = make_config(poll_interval=5)

    sleep_calls = {"count": 0}

    def fake_sleep(_seconds):
        sleep_calls["count"] += 1
        if sleep_calls["count"] >= 10:
            monitor.request_stop()

    monitor = RestockMonitor(config, FailingApple(), telegram, db, sleep=fake_sleep)
    monitor.run()

    # Failed checks never send alerts and never record any inventory state.
    assert telegram.sent == []
    assert db.get_states() == {}
    db.close()

