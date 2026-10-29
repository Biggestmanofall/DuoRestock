#!/usr/bin/env python3
"""Re-discover iPhone Duo part numbers from Apple's official buy page.

Maintenance utility: run this if Apple rotates part numbers (e.g. new color or
capacity). Prints each part number with Apple's own product title (fetched via
the pickup availability endpoint) and a ready-to-paste TOML block for
config.toml.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import urlencode

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from duorestockbot.config import DEFAULT_CONFIG_PATH, load_config  # noqa: E402

PART_NUMBER_PATTERN = re.compile(r"M[A-Z0-9]{3,4}LL/A")


def main() -> int:
    config = load_config(config_path=DEFAULT_CONFIG_PATH)

    print(f"Fetching buy page: {config.apple.buy_url}")
    response = requests.get(
        config.apple.buy_url,
        headers={"User-Agent": config.apple.user_agent},
        timeout=30,
    )
    response.raise_for_status()
    part_numbers = sorted(set(PART_NUMBER_PATTERN.findall(response.text)))
    if not part_numbers:
        print("No part numbers found — Apple's buy page layout may have changed.")
        return 1
    print(f"Found {len(part_numbers)} part numbers; resolving titles via pickup API...")

    params = [("pl", "true"), ("mts.0", "regular"), ("location", config.apple.location)]
    params.extend((f"parts.{i}", p) for i, p in enumerate(part_numbers))
    url = f"{config.apple.pickup_endpoint}?{urlencode(params)}"
    api_response = requests.get(url, headers={"User-Agent": config.apple.user_agent}, timeout=30)
    api_response.raise_for_status()
    stores = api_response.json()["body"]["stores"]
    # Titles are identical across stores; use the first store.
    parts_availability = stores[0]["partsAvailability"]

    print("\nPart number -> configuration (per Apple's own titles):")
    toml_lines = []
    for part_number in part_numbers:
        info = parts_availability[part_number]["messageTypes"]["regular"]
        title = info.get("storePickupProductTitle", "?")
        print(f"  {part_number} -> {title}")
        # Title format observed: "iPhone Duo 256GB Star White"
        match = re.match(r"iPhone Duo (\S+) (.+)$", title)
        storage, color = (match.groups() if match else ("?", "?"))
        toml_lines += [
            "",
            "[[parts]]",
            f'number = "{part_number}"',
            f'description = "{title}"',
            f'color = "{color}"',
            f'storage = "{storage}"',
        ]
    print("\nconfig.toml [[parts]] block:")
    print("\n".join(toml_lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
