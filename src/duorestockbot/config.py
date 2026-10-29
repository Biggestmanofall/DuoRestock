"""Configuration loading: config.toml for tunables, .env for secrets.

The Telegram bot token is loaded from the environment / .env and is never logged.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config.toml"
DEFAULT_ENV_PATH = PROJECT_ROOT / ".env"


class ConfigError(RuntimeError):
    """Raised when configuration is missing or invalid."""


@dataclass(frozen=True)
class Store:
    number: str
    name: str


@dataclass(frozen=True)
class Part:
    number: str
    description: str
    color: str
    storage: str


@dataclass(frozen=True)
class MonitorSettings:
    poll_interval_seconds: int
    recheck_delay_seconds: int
    cooldown_minutes: int
    backoff_initial_seconds: int
    backoff_max_seconds: int


@dataclass(frozen=True)
class AppleSettings:
    pickup_endpoint: str
    location: str
    user_agent: str
    buy_url: str


@dataclass(frozen=True)
class AppConfig:
    stores: tuple[Store, ...]
    parts: tuple[Part, ...]
    monitor: MonitorSettings
    apple: AppleSettings
    telegram_bot_token: str
    telegram_chat_id: str | None

    @property
    def store_numbers(self) -> frozenset[str]:
        return frozenset(store.number for store in self.stores)

    @property
    def part_numbers(self) -> frozenset[str]:
        return frozenset(part.number for part in self.parts)


def _require_int(section: dict, key: str, minimum: int, source: str) -> int:
    value = section.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise ConfigError(f"{source}: '{key}' must be an integer >= {minimum}")
    return value


def _load_toml(config_path: Path) -> dict:
    try:
        with open(config_path, "rb") as fh:
            return tomllib.load(fh)
    except FileNotFoundError as exc:
        raise ConfigError(f"config file not found: {config_path}") from exc
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"invalid TOML in {config_path}: {exc}") from exc


def _parse_stores(raw: object) -> tuple[Store, ...]:
    if not isinstance(raw, list) or not raw:
        raise ConfigError("[[stores]] must be a non-empty list in config.toml")
    stores = []
    seen: set[str] = set()
    for entry in raw:
        if not isinstance(entry, dict):
            raise ConfigError("each [[stores]] entry must be a table")
        number = str(entry.get("number", "")).strip()
        name = str(entry.get("name", "")).strip()
        if not number or not name:
            raise ConfigError("each [[stores]] entry needs non-empty 'number' and 'name'")
        if number in seen:
            raise ConfigError(f"duplicate store number: {number}")
        seen.add(number)
        stores.append(Store(number=number, name=name))
    return tuple(stores)


def _parse_parts(raw: object) -> tuple[Part, ...]:
    if not isinstance(raw, list) or not raw:
        raise ConfigError("[[parts]] must be a non-empty list in config.toml")
    parts = []
    seen: set[str] = set()
    for entry in raw:
        if not isinstance(entry, dict):
            raise ConfigError("each [[parts]] entry must be a table")
        number = str(entry.get("number", "")).strip()
        description = str(entry.get("description", "")).strip()
        color = str(entry.get("color", "")).strip()
        storage = str(entry.get("storage", "")).strip()
        if not number or not description or not color or not storage:
            raise ConfigError("each [[parts]] entry needs 'number', 'description', 'color', 'storage'")
        if number in seen:
            raise ConfigError(f"duplicate part number: {number}")
        seen.add(number)
        parts.append(Part(number=number, description=description, color=color, storage=storage))
    return tuple(parts)


def load_config(
    config_path: Path = DEFAULT_CONFIG_PATH,
    env_path: Path | None = DEFAULT_ENV_PATH,
) -> AppConfig:
    """Load and validate all configuration.

    Secrets come from the environment (or .env via python-dotenv, which never
    overrides already-set environment variables).
    """
    if env_path is not None:
        load_dotenv(env_path, override=False)

    data = _load_toml(config_path)

    monitor_raw = data.get("monitor")
    if not isinstance(monitor_raw, dict):
        raise ConfigError("missing [monitor] section in config.toml")
    monitor = MonitorSettings(
        poll_interval_seconds=_require_int(monitor_raw, "poll_interval_seconds", 5, "[monitor]"),
        recheck_delay_seconds=_require_int(monitor_raw, "recheck_delay_seconds", 0, "[monitor]"),
        cooldown_minutes=_require_int(monitor_raw, "cooldown_minutes", 1, "[monitor]"),
        backoff_initial_seconds=_require_int(monitor_raw, "backoff_initial_seconds", 1, "[monitor]"),
        backoff_max_seconds=_require_int(monitor_raw, "backoff_max_seconds", 1, "[monitor]"),
    )
    if monitor.backoff_max_seconds < monitor.backoff_initial_seconds:
        raise ConfigError("[monitor]: backoff_max_seconds must be >= backoff_initial_seconds")

    apple_raw = data.get("apple")
    if not isinstance(apple_raw, dict):
        raise ConfigError("missing [apple] section in config.toml")
    apple = AppleSettings(
        pickup_endpoint=str(apple_raw.get("pickup_endpoint", "")).strip(),
        location=str(apple_raw.get("location", "")).strip(),
        user_agent=str(apple_raw.get("user_agent", "")).strip(),
        buy_url=str(apple_raw.get("buy_url", "")).strip(),
    )
    if not apple.pickup_endpoint or not apple.location or not apple.user_agent or not apple.buy_url:
        raise ConfigError("[apple] needs pickup_endpoint, location, user_agent and buy_url")

    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if not bot_token:
        raise ConfigError(
            "TELEGRAM_BOT_TOKEN is not set. Put it in .env (see .env.example) "
            "or export it as an environment variable."
        )
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip() or None

    return AppConfig(
        stores=_parse_stores(data.get("stores")),
        parts=_parse_parts(data.get("parts")),
        monitor=monitor,
        apple=apple,
        telegram_bot_token=bot_token,
        telegram_chat_id=chat_id,
    )
