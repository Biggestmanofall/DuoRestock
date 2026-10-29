"""Tests for SQLite state persistence and alert dedup bookkeeping."""

from __future__ import annotations

from datetime import timedelta

from duorestockbot.db import StateDB, utc_now


def test_state_roundtrip_and_upsert(tmp_path):
    db = StateDB(tmp_path / "state.sqlite")
    assert db.get_states() == {}

    db.update_states([("R513", "MK1H4LL/A", False), ("R123", "MK1G4LL/A", False)])
    states = db.get_states()
    assert states == {("R513", "MK1H4LL/A"): False, ("R123", "MK1G4LL/A"): False}

    db.update_states([("R513", "MK1H4LL/A", True)])  # restock transition
    assert db.get_states()[("R513", "MK1H4LL/A")] is True
    assert db.get_states()[("R123", "MK1G4LL/A")] is False  # untouched
    db.close()


def test_states_survive_reopen(tmp_path):
    path = tmp_path / "state.sqlite"
    db = StateDB(path)
    db.update_states([("R513", "MK1H4LL/A", True)])
    db.close()

    reopened = StateDB(path)
    assert reopened.get_states() == {("R513", "MK1H4LL/A"): True}
    reopened.close()


def test_last_alert_lifecycle(tmp_path):
    db = StateDB(tmp_path / "state.sqlite")
    assert db.last_alert("R513", "MK1H4LL/A") is None

    first_alert_time = utc_now()
    db.record_alert("R513", "MK1H4LL/A", now=first_alert_time)
    assert db.last_alert("R513", "MK1H4LL/A") == first_alert_time

    later = first_alert_time + timedelta(minutes=10)
    db.record_alert("R513", "MK1H4LL/A", now=later)  # upsert overwrites
    assert db.last_alert("R513", "MK1H4LL/A") == later

    assert db.last_alert("R123", "MK1H4LL/A") is None  # other keys untouched
    db.close()
