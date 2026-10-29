"""Entry point: ``python -m duorestockbot`` (requires PYTHONPATH=src or an install)."""

from __future__ import annotations

import logging
from pathlib import Path

from .apple_client import ApplePickupClient
from .config import PROJECT_ROOT, ConfigError, load_config
from .db import StateDB
from .monitor import RestockMonitor
from .telegram import TelegramClient

logger = logging.getLogger("duorestockbot")


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    )
    try:
        config = load_config()
    except ConfigError as exc:
        logger.error("configuration error: %s", exc)
        return 2

    if not config.telegram_chat_id:
        logger.error(
            "TELEGRAM_CHAT_ID is not set. Run scripts/test_telegram.py first "
            "to discover it and save it to .env."
        )
        return 2

    db_path = PROJECT_ROOT / "data" / "duorestockbot.sqlite"
    db = StateDB(db_path)
    apple = ApplePickupClient(
        endpoint=config.apple.pickup_endpoint,
        location=config.apple.location,
        part_numbers=config.part_numbers,
        user_agent=config.apple.user_agent,
    )
    telegram = TelegramClient(config.telegram_bot_token, chat_id=config.telegram_chat_id)
    monitor = RestockMonitor(config, apple, telegram, db)

    logger.info("starting DuoRestockBot (state db: %s)", db_path)
    try:
        monitor.run()
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
