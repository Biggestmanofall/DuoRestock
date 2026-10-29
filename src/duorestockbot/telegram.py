"""Minimal Telegram Bot API client.

The bot token is never included in exception messages or logs. Error text is
built manually from method names and HTTP status codes only, because the API
URL embeds the token and libraries like requests embed the URL in their errors.
"""

from __future__ import annotations

import time
from typing import Any

import requests

TELEGRAM_API_BASE = "https://api.telegram.org"


class TelegramError(RuntimeError):
    """Raised when a Telegram API call fails. Guaranteed not to contain the token."""


class TelegramClient:
    """Small wrapper over the Telegram Bot API with retry + exponential backoff."""

    def __init__(
        self,
        bot_token: str,
        chat_id: str | None = None,
        timeout: float = 15.0,
        max_retries: int = 3,
        retry_backoff_seconds: float = 2.0,
        session: requests.Session | None = None,
    ) -> None:
        if not bot_token:
            raise TelegramError("bot token must not be empty")
        self._bot_token = bot_token
        self.chat_id = chat_id
        self._timeout = timeout
        self._max_retries = max_retries
        self._retry_backoff_seconds = retry_backoff_seconds
        self._session = session or requests.Session()

    def _call(self, method: str, payload: dict[str, Any]) -> Any:
        url = f"{TELEGRAM_API_BASE}/bot{self._bot_token}/{method}"
        last_error = "unknown error"
        for attempt in range(self._max_retries):
            try:
                response = self._session.post(url, json=payload, timeout=self._timeout)
            except requests.RequestException as exc:
                # Only use the exception class name: the message can contain the URL
                # (and therefore the token).
                last_error = f"network error ({type(exc).__name__})"
            else:
                if 200 <= response.status_code < 300:
                    try:
                        data = response.json()
                    except ValueError:
                        last_error = "invalid JSON response"
                    else:
                        if data.get("ok"):
                            return data.get("result")
                        last_error = f"API returned ok=false: {data.get('description', 'no description')}"
                else:
                    last_error = f"HTTP {response.status_code}"
            if attempt < self._max_retries - 1:
                time.sleep(self._retry_backoff_seconds * (2**attempt))
        raise TelegramError(
            f"Telegram {method} failed after {self._max_retries} attempts: {last_error}"
        )

    def get_updates(self) -> list[dict[str, Any]]:
        """Fetch pending updates (used for chat-id discovery)."""
        return self._call("getUpdates", {"timeout": 0})

    def send_message(
        self,
        text: str,
        chat_id: str | None = None,
        disable_web_page_preview: bool = True,
    ) -> dict[str, Any]:
        """Send a text message; returns the Message object on success."""
        target = chat_id or self.chat_id
        if not target:
            raise TelegramError("no chat id available: set TELEGRAM_CHAT_ID or pass chat_id")
        return self._call(
            "sendMessage",
            {
                "chat_id": target,
                "text": text,
                "disable_web_page_preview": disable_web_page_preview,
            },
        )

    def discover_chat_id(self) -> str | None:
        """Return the chat id of the most recent chat that messaged the bot.

        The bot only sees chats after the user sends it a message (e.g. /start).
        """
        chat_id: str | None = None
        try:
            updates = self.get_updates()
        except TelegramError:
            return None
        for update in updates:
            if not isinstance(update, dict):
                continue
            message = (
                update.get("message")
                or update.get("edited_message")
                or update.get("channel_post")
            )
            if isinstance(message, dict) and isinstance(message.get("chat"), dict):
                chat_id_value = message["chat"].get("id")
                if chat_id_value is not None:
                    chat_id = str(chat_id_value)
        return chat_id
