# DuoRestockBot

Monitors Apple Store in-store pickup availability for the **iPhone Duo** at three
Nashville-area Apple Stores and sends push notifications via Telegram.

## Monitored stores

| Store number | Store |
|---|---|
| R513 | Apple CoolSprings Galleria (Franklin, TN) |
| R123 | Apple Green Hills (Nashville, TN) |
| R133 | Apple Downtown Nashville (Nashville, TN) |

All **8 iPhone Duo configurations** are monitored (Star White / Night Sky ×
256GB / 512GB / 1TB / 2TB) — every configuration is equally acceptable.

## How it works

Apple's online store exposes a public, unauthenticated endpoint — the same one
its own "Check availability" pickup UI uses:

```
GET https://www.apple.com/shop/retail/pickup-message?pl=true&mts.0=regular&location=<loc>&parts.0=<P0>&parts.1=<P1>...
```

One request returns the ~12 nearest stores to `location` (configured as
`Nashville, TN`, which covers all three monitored stores) with availability for
every requested part. A configuration is available for **in-store pickup** at a
store only when **both**:

- `partsAvailability[part].pickupDisplay != "unavailable"`, and
- `partsAvailability[part].messageTypes.regular.storeSelectionEnabled is True`

Either field alone produces false alarms. A failed request (HTTP error, parse
failure, `errorMessage` body) is **never** treated as out-of-stock; the monitor
backs off exponentially and retries.

On a hit, the bot waits 5 seconds, re-checks with a fresh request, then sends a
single Telegram alert listing each store + configuration with Apple's own pickup
quote and the official product link. Duplicate alerts for the same store +
configuration are suppressed for a cooldown window (persisted in SQLite, so it
survives restarts). The bot **alerts only** — it never orders, reserves, or adds
anything to a bag.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt pytest

cp .env.example .env   # then fill in TELEGRAM_BOT_TOKEN
.venv/bin/python scripts/test_telegram.py   # discovers & saves chat id, sends a test message
```

Secrets live in `.env` (gitignored): `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID`. The token is never printed or logged.

## Usage

```bash
PYTHONPATH=src .venv/bin/python -m duorestockbot    # start live monitoring
.venv/bin/python scripts/discover_parts.py          # re-verify part numbers (maintenance)
.venv/bin/python -m pytest                          # run the test suite
```

Tunables (poll interval, cooldown, backoff, stores, parts) live in
`config.toml` — no secrets there.

## Project layout

```
src/duorestockbot/
  config.py       # config.toml + .env loading and validation
  apple_client.py # pickup-availability HTTP client (retries, backoff)
  inventory.py    # response parser + the two-field availability rule
  telegram.py     # Telegram Bot API client (token never leaks into errors)
  db.py           # SQLite: inventory states + alert dedup
  monitor.py      # polling loop, transitions, confirmation, alerts
  __main__.py     # entry point
scripts/
  test_telegram.py  # standalone Telegram delivery test
  discover_parts.py # re-discover part numbers from Apple's buy page
tests/             # pytest suite (no network)
```
