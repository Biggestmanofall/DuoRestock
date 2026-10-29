"""Tests for the Telegram client (no network; the token must never leak)."""

from __future__ import annotations

import pytest
import requests

from duorestockbot import telegram as telegram_module
from duorestockbot.telegram import TelegramClient, TelegramError

TOKEN = "super-secret-token-do-not-leak"


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        if self._payload is None:
            raise ValueError("not json")
        return self._payload


class FakeSession:
    def __init__(self, results):
        self.results = list(results)
        self.calls: list[tuple[str, dict]] = []

    def post(self, url, json=None, timeout=None):
        self.calls.append((url, json))
        if not self.results:
            raise AssertionError("FakeSession ran out of scripted responses")
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(telegram_module.time, "sleep", lambda _seconds: None)


def test_send_message_success():
    session = FakeSession([FakeResponse(payload={"ok": True, "result": {"message_id": 7}})])
    client = TelegramClient(TOKEN, chat_id="12345", session=session)
    result = client.send_message("hello")
    assert result == {"message_id": 7}
    url, payload = session.calls[0]
    assert TOKEN in url  # token is used on the wire...
    assert payload == {
        "chat_id": "12345",
        "text": "hello",
        "disable_web_page_preview": True,
    }


def test_send_message_requires_chat_id():
    client = TelegramClient(TOKEN, session=FakeSession([]))
    with pytest.raises(TelegramError, match="no chat id"):
        client.send_message("hello")


def test_api_error_description_surfaced_without_token():
    session = FakeSession([FakeResponse(payload={"ok": False, "description": "Bad Request: chat not found"})] * 3)
    client = TelegramClient(TOKEN, chat_id="1", session=session)
    with pytest.raises(TelegramError) as exc_info:
        client.send_message("hello")
    assert "chat not found" in str(exc_info.value)
    assert TOKEN not in str(exc_info.value)


def test_http_error_does_not_leak_token():
    session = FakeSession([FakeResponse(status_code=401)] * 3)
    client = TelegramClient(TOKEN, chat_id="1", session=session)
    with pytest.raises(TelegramError) as exc_info:
        client.send_message("hello")
    assert "HTTP 401" in str(exc_info.value)
    assert TOKEN not in str(exc_info.value)
    assert len(session.calls) == 3  # retried with backoff


def test_network_error_retries_then_raises_without_token():
    session = FakeSession(
        [requests.ConnectionError(f"boom at https://api.telegram.org/bot{TOKEN}/sendMessage")] * 2
    )
    client = TelegramClient(TOKEN, chat_id="1", session=session, max_retries=2)
    with pytest.raises(TelegramError) as exc_info:
        client.send_message("hello")
    assert "ConnectionError" in str(exc_info.value)
    assert TOKEN not in str(exc_info.value)
    assert len(session.calls) == 2


def test_discover_chat_id_picks_most_recent():
    result = [
        {"message": {"chat": {"id": 111, "type": "private"}}},
        {"message": {"chat": {"id": 222, "type": "private"}}},
    ]
    session = FakeSession([FakeResponse(payload={"ok": True, "result": result})])
    client = TelegramClient(TOKEN, session=session)
    assert client.discover_chat_id() == "222"


def test_discover_chat_id_none_when_no_updates():
    session = FakeSession([FakeResponse(payload={"ok": True, "result": []})])
    client = TelegramClient(TOKEN, session=session)
    assert client.discover_chat_id() is None
