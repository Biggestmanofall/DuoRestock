"""Tests for configuration loading and validation."""

from __future__ import annotations

from pathlib import Path

import pytest

from duorestockbot.config import ConfigError, load_config

CONFIG_TOML = """
[monitor]
poll_interval_seconds = 60
recheck_delay_seconds = 5
cooldown_minutes = 5
backoff_initial_seconds = 60
backoff_max_seconds = 900

[apple]
pickup_endpoint = "https://www.apple.com/shop/retail/pickup-message"
location = "Nashville, TN"
user_agent = "TestAgent/1.0"
buy_url = "https://www.apple.com/shop/buy-iphone/iphone-duo"

[[stores]]
number = "R513"
name = "Apple CoolSprings Galleria"

[[stores]]
number = "R123"
name = "Apple Green Hills"

[[parts]]
number = "MK1G4LL/A"
description = "iPhone Duo 512GB Star White"
color = "Star White"
storage = "512GB"

[[parts]]
number = "MK1H4LL/A"
description = "iPhone Duo 512GB Night Sky"
color = "Night Sky"
storage = "512GB"
"""


def write_files(tmp_path: Path, toml: str, env: str) -> tuple[Path, Path]:
    config_path = tmp_path / "config.toml"
    env_path = tmp_path / ".env"
    config_path.write_text(toml)
    env_path.write_text(env)
    return config_path, env_path


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)


def test_load_config_success(tmp_path):
    config_path, env_path = write_files(
        tmp_path, CONFIG_TOML, "TELEGRAM_BOT_TOKEN=test-token-123\nTELEGRAM_CHAT_ID=42\n"
    )
    config = load_config(config_path=config_path, env_path=env_path)

    assert config.telegram_bot_token == "test-token-123"
    assert config.telegram_chat_id == "42"
    assert config.store_numbers == frozenset({"R513", "R123"})
    assert config.part_numbers == frozenset({"MK1G4LL/A", "MK1H4LL/A"})
    assert config.monitor.poll_interval_seconds == 60
    assert config.apple.location == "Nashville, TN"
    assert config.stores[0].name == "Apple CoolSprings Galleria"


def test_missing_token_raises(tmp_path):
    config_path, env_path = write_files(tmp_path, CONFIG_TOML, "TELEGRAM_CHAT_ID=42\n")
    with pytest.raises(ConfigError, match="TELEGRAM_BOT_TOKEN"):
        load_config(config_path=config_path, env_path=env_path)


def test_empty_chat_id_becomes_none(tmp_path):
    config_path, env_path = write_files(tmp_path, CONFIG_TOML, "TELEGRAM_BOT_TOKEN=t\nTELEGRAM_CHAT_ID=\n")
    config = load_config(config_path=config_path, env_path=env_path)
    assert config.telegram_chat_id is None


def test_duplicate_store_number_raises(tmp_path):
    toml = CONFIG_TOML.replace('number = "R123"', 'number = "R513"')
    config_path, env_path = write_files(tmp_path, toml, "TELEGRAM_BOT_TOKEN=t\n")
    with pytest.raises(ConfigError, match="duplicate store number"):
        load_config(config_path=config_path, env_path=env_path)


def test_invalid_poll_interval_raises(tmp_path):
    toml = CONFIG_TOML.replace("poll_interval_seconds = 60", "poll_interval_seconds = 1")
    config_path, env_path = write_files(tmp_path, toml, "TELEGRAM_BOT_TOKEN=t\n")
    with pytest.raises(ConfigError, match="poll_interval_seconds"):
        load_config(config_path=config_path, env_path=env_path)


def test_missing_file_raises(tmp_path):
    with pytest.raises(ConfigError, match="not found"):
        load_config(
            config_path=tmp_path / "nope.toml",
            env_path=tmp_path / "also-nope.env",
        )


def test_missing_apple_section_raises(tmp_path):
    toml = CONFIG_TOML.split("[apple]")[0]
    config_path, env_path = write_files(tmp_path, toml, "TELEGRAM_BOT_TOKEN=t\n")
    with pytest.raises(ConfigError, match=r"\[apple\]"):
        load_config(config_path=config_path, env_path=env_path)
