"""Tests for the pickup availability parser, including the false-alarm cases."""

from __future__ import annotations

import pytest

from duorestockbot.inventory import (
    InventoryParseError,
    PickupAvailability,
    is_available,
    parse_pickup_response,
)


def make_part(pickup_display, store_selection_enabled, title="iPhone Duo 512GB Night Sky", quote="Tomorrow"):
    return {
        "pickupDisplay": pickup_display,
        "messageTypes": {
            "regular": {
                "storeSelectionEnabled": store_selection_enabled,
                "storePickupProductTitle": title,
                "storePickupQuote": quote,
            }
        },
    }


def make_body():
    return {
        "stores": [
            {
                "storeNumber": "R513",
                "storeName": "Apple CoolSprings Galleria",
                "partsAvailability": {
                    "MK1H4LL/A": make_part("available", True),  # genuinely available
                    "MK1G4LL/A": make_part("unavailable", False),  # plain unavailable
                    "MK1E4LL/A": make_part("available", False),  # FALSE ALARM: display ok, selection off
                    "MK1F4LL/A": {"pickupDisplay": "unavailable"},  # missing messageTypes
                },
            },
            {  # not a monitored store — must be filtered out
                "storeNumber": "R591",
                "storeName": "Apple Cumberland Mall",
                "partsAvailability": {"MK1H4LL/A": make_part("available", True)},
            },
        ]
    }


def test_is_available_requires_both_fields():
    assert is_available(make_part("available", True)) is True
    assert is_available(make_part("unavailable", False)) is False
    # Either field alone must NOT count as available (prevents false alarms).
    assert is_available(make_part("available", False)) is False
    assert is_available(make_part("unavailable", True)) is False


def test_parse_filters_to_monitored_stores_and_flags_availability():
    records = parse_pickup_response(make_body(), frozenset({"R513"}))
    assert len(records) == 4
    assert all(record.store_number == "R513" for record in records)
    by_part = {record.part_number: record for record in records}
    assert by_part["MK1H4LL/A"].available is True
    assert by_part["MK1G4LL/A"].available is False
    assert by_part["MK1E4LL/A"].available is False  # false-alarm case
    assert by_part["MK1F4LL/A"].available is False


def test_parse_preserves_titles_and_quotes():
    records = parse_pickup_response(make_body(), frozenset({"R513"}))
    hit = next(record for record in records if record.available)
    assert hit.store_name == "Apple CoolSprings Galleria"
    assert hit.product_title == "iPhone Duo 512GB Night Sky"
    assert hit.pickup_quote == "Tomorrow"
    assert hit.key == ("R513", "MK1H4LL/A")


def test_parse_raises_when_stores_missing():
    with pytest.raises(InventoryParseError, match="stores"):
        parse_pickup_response({"body": {"errorMessage": "throttled"}}, frozenset({"R513"}))
    with pytest.raises(InventoryParseError):
        parse_pickup_response({}, frozenset({"R513"}))


def test_parse_returns_empty_for_non_monitor_store_only():
    records = parse_pickup_response(make_body(), frozenset({"R000"}))
    assert records == []


def test_pickup_availability_key_is_stable():
    record = PickupAvailability("R513", "Name", "MK1H4LL/A", "T", "Q", True)
    assert record.key == ("R513", "MK1H4LL/A")
