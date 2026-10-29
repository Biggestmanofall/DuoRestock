"""Parse Apple pickup availability responses into per-store, per-part records.

The availability rule (verified empirically — checking either field alone
produces false alarms): a part is available for in-store pickup at a store
ONLY when BOTH hold:

1. ``partsAvailability[part].pickupDisplay != "unavailable"``, and
2. ``partsAvailability[part].messageTypes.regular.storeSelectionEnabled is True``

This is in-store pickup availability, not shipping availability — the
endpoint is exclusively about retail store pickup.
"""

from __future__ import annotations

from dataclasses import dataclass


class InventoryParseError(RuntimeError):
    """Raised when the response cannot be parsed. A failed parse is a failed check."""


@dataclass(frozen=True)
class PickupAvailability:
    """Availability of one product configuration at one store."""

    store_number: str
    store_name: str
    part_number: str
    product_title: str
    pickup_quote: str
    available: bool

    @property
    def key(self) -> tuple[str, str]:
        """Unique identifier used for state tracking and alert dedup."""
        return (self.store_number, self.part_number)


def is_available(part_data: dict) -> bool:
    """Apply the two-field pickup availability rule to one partsAvailability entry."""
    if not isinstance(part_data, dict):
        return False
    if part_data.get("pickupDisplay") == "unavailable":
        return False
    message_types = part_data.get("messageTypes")
    if not isinstance(message_types, dict):
        return False
    regular = message_types.get("regular")
    if not isinstance(regular, dict):
        return False
    return regular.get("storeSelectionEnabled") is True


def _regular_info(part_data: dict) -> tuple[str, str]:
    """Extract Apple's own product title and pickup quote, if present."""
    message_types = part_data.get("messageTypes")
    if not isinstance(message_types, dict):
        return "", ""
    regular = message_types.get("regular")
    if not isinstance(regular, dict):
        return "", ""
    return str(regular.get("storePickupProductTitle") or ""), str(regular.get("storePickupQuote") or "")


def parse_pickup_response(body: dict, store_numbers: frozenset[str]) -> list[PickupAvailability]:
    """Parse a pickup-message ``body`` into records for the monitored stores only.

    Raises :class:`InventoryParseError` if the response shape is unusable —
    callers must treat that as a failed check, never as "everything unavailable".
    """
    stores = body.get("stores") if isinstance(body, dict) else None
    if not isinstance(stores, list):
        raise InventoryParseError("response body has no 'stores' list")

    records: list[PickupAvailability] = []
    for store in stores:
        if not isinstance(store, dict):
            continue
        store_number = str(store.get("storeNumber") or "").strip()
        if store_number not in store_numbers:
            continue
        store_name = str(store.get("storeName") or "").strip()
        parts_availability = store.get("partsAvailability")
        if not isinstance(parts_availability, dict):
            continue
        for part_number, part_data in parts_availability.items():
            product_title, pickup_quote = _regular_info(part_data)
            records.append(
                PickupAvailability(
                    store_number=store_number,
                    store_name=store_name,
                    part_number=str(part_number),
                    product_title=product_title,
                    pickup_quote=pickup_quote,
                    available=is_available(part_data),
                )
            )
    return records
