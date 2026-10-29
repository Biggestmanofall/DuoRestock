#!/usr/bin/env python3
"""Standalone Telegram delivery test (run before anything else).

Usage:
    python scripts/test_telegram.py                  # auto-discover chat id via getUpdates
    python scripts/test_telegram.py --chat-id 12345  # use a specific chat id

The bot token is loaded from .env / the environment and is NEVER printed.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from duorestockbot.config import DEFAULT_ENV_PATH, ConfigError, load_config  # noqa: E402
from duorestockbot.telegram import TelegramClient, TelegramError  # noqa: E402

TEST_MESSAGE = "✅ DuoRestockBot here — Telegram delivery test successful. iPhone Duo restock alerts are coming to this chat!"


def main() -> int:
    parser = argparse.ArgumentParser(description="Test Telegram bot delivery")
    parser.add_argument(
        "--chat-id",
        help="Chat id to send to; otherwise discovered via getUpdates or read from .env",
    )
    args = parser.parse_args()

    try:
        config = load_config(env_path=DEFAULT_ENV_PATH)
    except ConfigError as exc:
        print(f"Configuration error: {exc}")
        return 2

    client = TelegramClient(config.telegram_bot_token)

    chat_id = args.chat_id or config.telegram_chat_id
    if not chat_id:
        print("No chat id configured — checking the bot's recent messages...")
        print("(If this is the first run, open Telegram and send /start to your bot first.)")
        try:
            chat_id = client.discover_chat_id()
        except TelegramError as exc:
            print(f"Could not fetch updates: {exc}")
            return 3
    if not chat_id:
        print("No chats found. Send any message to your bot in Telegram, then run this again.")
        return 4

    print(f"Using chat id: {chat_id}")
    try:
        result = client.send_message(TEST_MESSAGE, chat_id=chat_id)
    except TelegramError as exc:
        print(f"Send failed: {exc}")
        return 5

    print(f"Delivered (message_id={result.get('message_id')}). Check your Telegram app!")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
