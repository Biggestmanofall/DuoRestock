"""Tests for the Apple pickup availability client (no network)."""

from __future__ import annotations

import pytest
import requests

from duorestockbot import apple_client as apple_module
from duorestockbot.apple_client import ApplePickupClient, ApplePickupError


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
        self.get_calls: list[str] = []
        self.headers: dict = {}

    def get(self, url, timeout=None):
        self.get_calls.append(url)
        if not self.results:
            raise AssertionError("FakeSession ran out of scripted responses")
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(apple_module.time, "sleep", lambda _seconds: None)


def make_client(session, parts=("MK1E4LL/A", "MK1H4LL/A")):
    return ApplePickupClient(
        endpoint="https://example.com/pickup-message",
        location="Nashville, TN",
        part_numbers=parts,
        user_agent="TestAgent/1.0",
        session=session,
    )


def test_build_url_contains_all_params_in_one_request():
    client = make_client(FakeSession([]))
    url = client.build_url()
    assert "pl=true" in url
    assert "mts.0=regular" in url
    assert "location=Nashville%2C+TN" in url
    assert "parts.0=MK1E4LL%2FA" in url  # parts are sorted
    assert "parts.1=MK1H4LL%2FA" in url


def test_fetch_returns_body_on_success():
    body = {"stores": [{"storeNumber": "R513"}]}
    session = FakeSession([FakeResponse(payload={"body": body})])
    assert make_client(session).fetch() == body
    assert len(session.get_calls) == 1


def test_fetch_raises_on_error_message_body():
    payload = {"body": {"errorMessage": "Unavailable for pickup searches"}}
    session = FakeSession([FakeResponse(payload=payload)] * 3)
    with pytest.raises(ApplePickupError, match="errorMessage|unexpected response"):
        make_client(session).fetch()
    assert len(session.get_calls) == 3


def test_fetch_raises_on_http_error_after_retries():
    session = FakeSession([FakeResponse(status_code=503)] * 3)
    with pytest.raises(ApplePickupError, match="HTTP 503"):
        make_client(session).fetch()
    assert len(session.get_calls) == 3


def test_fetch_raises_on_network_error():
    session = FakeSession([requests.Timeout("timed out")] * 3)
    with pytest.raises(ApplePickupError, match="Timeout"):
        make_client(session).fetch()


def test_fetch_raises_on_invalid_json():
    session = FakeSession([FakeResponse(payload=None)] * 3)
    with pytest.raises(ApplePickupError, match="invalid JSON"):
        make_client(session).fetch()


def test_empty_part_numbers_rejected():
    with pytest.raises(ValueError, match="part_numbers"):
        ApplePickupClient(
            endpoint="https://e/",
            location="Nashville, TN",
            part_numbers=[],
            user_agent="TestAgent/1.0",
        )
