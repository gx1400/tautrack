"""Time-of-day profile: slotting, lock shares, per-PRN shares and the API window."""

from __future__ import annotations

import time
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from tautrack.config import Settings
from tautrack.device.screen import Satellite
from tautrack.store.db import Store
from tautrack.store.profile import build_profile, classify
from tautrack.web.app import create_app

CHICAGO = ZoneInfo("America/Chicago")


def _ts(*args: int, tz=CHICAGO) -> int:
    return int(datetime(*args, tzinfo=tz).timestamp())


@pytest.mark.parametrize(
    ("text", "cat"),
    [
        ("Locked to GPS", "locked"),
        ("Locked to GPS: stabilizing frequency", "locked"),
        ("Recovery: fine freq adj", "recovery"),
        ("Holdover: GPS 1PPS CLK invalid", "holdover"),
        ("Power-up: GPS acquisition", "power-up"),
        ("Something new", "other"),
    ],
)
def test_classify_uses_the_leading_word(text: str, cat: str) -> None:
    assert classify(text) == cat


def test_slots_are_local_wall_clock_across_dst() -> None:
    """09:10 local lands in the 09:00 slot on both sides of the November change."""
    before = _ts(2026, 10, 31, 9, 10)  # CDT, UTC-5
    after = _ts(2026, 11, 2, 9, 10)  # CST, UTC-6
    p = build_profile(
        modes=[(before, "Locked to GPS"), (after, "Holdover: GPS 1PPS CLK invalid")],
        tracked=[],
        visible=[],
        sats=[],
        tz=CHICAGO,
    )
    slot = p["slots"][18]
    assert slot["start"] == "09:00"
    assert slot["screens"] == 2
    assert slot["days"] == 2
    assert slot["states"]["locked"] == pytest.approx(0.5)
    assert slot["states"]["holdover"] == pytest.approx(0.5)
    assert sum(s["screens"] for s in p["slots"]) == 2


def test_lock_shares_and_day_counts() -> None:
    day1 = _ts(2026, 11, 10, 14, 0)
    day2 = _ts(2026, 11, 11, 14, 0)
    modes = [
        # Day 1: locked through the 14:00 slot.
        (day1 + 60, "Locked to GPS"),
        (day1 + 120, "Locked to GPS"),
        # Day 2: drops into holdover partway through.
        (day2 + 60, "Locked to GPS"),
        (day2 + 120, "Holdover: GPS 1PPS CLK invalid"),
    ]
    p = build_profile(modes=modes, tracked=[], visible=[], sats=[], tz=CHICAGO)
    s = p["slots"][28]
    assert s["start"] == "14:00"
    assert s["states"]["locked"] == pytest.approx(0.75)
    assert s["days"] == 2
    assert s["days_any_lock"] == 2
    assert s["days_all_lock"] == 1
    assert p["summary"]["states"]["locked"] == pytest.approx(0.75)
    # Unobserved slots say so rather than reporting zero.
    assert p["slots"][0]["screens"] == 0
    assert p["slots"][0]["states"]["locked"] is None


def test_prn_share_counts_screens_with_no_satellites_against_it() -> None:
    """A screen reporting nothing writes no satellite rows but still counts."""
    t0 = _ts(2026, 11, 10, 3, 0)
    modes = [(t0 + i * 60, "Locked to GPS") for i in range(4)]
    sats = [
        (t0, 12, 1),
        (t0 + 60, 12, 1),
        (t0 + 60, 25, 0),  # visible but not tracked: does not count
        # t0+120 and t0+180: nothing reported at all
    ]
    p = build_profile(modes=modes, tracked=[], visible=[], sats=sats, tz=CHICAGO)
    s = p["slots"][6]
    assert s["prn_share"] == {"12": 0.5}
    assert [x["prn"] for x in p["prns"]] == [12]


def test_satellite_averages_per_slot_and_overall() -> None:
    t0 = _ts(2026, 11, 10, 0, 0)
    tracked = [(t0, 2.0), (t0 + 15, 4.0), (t0 + 1800, 6.0)]
    p = build_profile(
        modes=[(t0, "Locked to GPS")], tracked=tracked, visible=[(t0, 8.0)], sats=[], tz=CHICAGO
    )
    assert p["slots"][0]["tracked"] == {"avg": 3.0, "min": 2.0, "max": 4.0, "n": 2}
    assert p["slots"][1]["tracked"]["avg"] == 6.0
    assert p["summary"]["tracked_avg"] == pytest.approx(4.0)
    assert p["summary"]["visible_avg"] == 8.0


def test_non_hour_offset_zone() -> None:
    """A half-hour zone shifts slots by exactly one."""
    t = int(datetime(2026, 11, 10, 0, 10, tzinfo=UTC).timestamp())
    p = build_profile(
        modes=[(t, "Locked to GPS")], tracked=[], visible=[], sats=[], tz=ZoneInfo("Asia/Kolkata")
    )
    # 00:10 UTC is 05:40 IST.
    assert p["slots"][11]["screens"] == 1


@pytest.fixture
def client(tmp_path):
    settings = Settings(
        database=tmp_path / "t.db",
        display={"timezone": "America/Chicago"},
        retention={"raw_days": 14},
    )
    store = Store(settings.database)
    device = store.upsert_device({"model": "Z3801A", "serial": "S1"})
    now = int(time.time())
    for i in range(20):
        ts = now - i * 60
        store.write_samples(
            device,
            ts,
            {"satellites_tracked": 3.0, "satellites_visible": 7.0},
            {"mode": "Locked to GPS"},
        )
        store.write_satellites(
            device, ts, [Satellite(prn=7, elevation=50, azimuth=90, signal=90, tracked=True)]
        )
    # Outside a 1h window but inside 24h.
    store.write_samples(device, now - 5 * 3600, {}, {"mode": "Holdover: GPS 1PPS CLK invalid"})
    with TestClient(create_app(settings, store, poller=None)) as c:
        yield c
    store.close()


def test_api_windows_to_the_selected_span(client) -> None:
    short = client.get("/api/time-of-day?span=1h").json()
    assert short["summary"]["screens"] == 20
    assert short["summary"]["states"]["locked"] == 1.0
    assert short["summary"]["tracked_avg"] == 3.0
    assert short["prns"] == [{"prn": 7, "share": 1.0}]
    assert short["window"]["limited_by_retention"] is False

    day = client.get("/api/time-of-day?span=24h").json()
    assert day["summary"]["screens"] == 21
    assert day["summary"]["states"]["holdover"] == pytest.approx(1 / 21)


def test_api_says_when_retention_caps_the_window(client) -> None:
    d = client.get("/api/time-of-day?span=1y").json()
    w = d["window"]
    assert w["limited_by_retention"] is True
    assert w["seconds"] == 14 * 86400
    assert w["requested_seconds"] == 31536000
    assert len(d["slots"]) == 48


def test_api_rejects_unknown_span(client) -> None:
    assert client.get("/api/time-of-day?span=2h").status_code == 400
