"""Time-of-day profile: satellites and lock folded onto a 24-hour clock.

An antenna with a partly blocked sky does not fail at random. It loses satellites
when the constellation sits behind the obstruction, and that happens at roughly the
same time every day. A timeline makes that hard to see; folding every day of the
window onto one 24-hour axis makes it obvious.

Slots are wall-clock time in the display timezone, because "it drops out around
16:00" is how an operator thinks about it. DST is honoured per sample, so a slot
means the same local time on both sides of a change.

Two caveats travel with the result rather than being left for the viewer to guess:

* **Raw samples only.** The mode is text and the hourly rollups keep only numeric
  aggregates, and an hourly bucket cannot be split into half hours anyway. So the
  profile reaches back as far as raw retention and no further, and says how far it
  actually got.
* **The GPS sky repeats a sidereal day (23 h 56 m) apart,** so a given satellite
  rises about four minutes earlier each day. Over two weeks that is nearly an hour,
  and a pass smears across two or three adjacent slots.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime, tzinfo
from typing import Any

#: Lock categories, in stacking order. Matched case-insensitively against the
#: SmartClock mode text, which carries detail after a colon ("Locked to GPS:
#: stabilizing frequency"), so a prefix match on the leading word is what's wanted.
CATEGORIES: tuple[str, ...] = ("locked", "recovery", "holdover", "power-up", "other")


def classify(mode: str) -> str:
    t = mode.strip().lower()
    for cat in CATEGORIES[:-1]:
        if t.startswith(cat):
            return cat
    return "other"


class _SlotClock:
    """Maps a unix timestamp to its local slot index and local date.

    The UTC offset only changes at DST transitions, so it is cached per UTC hour
    rather than resolved through zoneinfo for every one of ~100k samples.
    """

    def __init__(self, tz: tzinfo, slot_seconds: int) -> None:
        self.tz = tz
        self.slot_seconds = slot_seconds
        self._offsets: dict[int, int] = {}

    def offset(self, ts: int) -> int:
        hour = ts // 3600
        off = self._offsets.get(hour)
        if off is None:
            delta = datetime.fromtimestamp(hour * 3600, UTC).astimezone(self.tz).utcoffset()
            off = int(delta.total_seconds()) if delta else 0
            self._offsets[hour] = off
        return off

    def locate(self, ts: int) -> tuple[int, int]:
        """(slot index, local day number) for a timestamp."""
        local = ts + self.offset(ts)
        return (local % 86400) // self.slot_seconds, local // 86400


def build_profile(
    *,
    modes: Iterable[tuple[int, str]],
    tracked: Iterable[tuple[int, float]],
    visible: Iterable[tuple[int, float]],
    sats: Iterable[tuple[int, int, int]],
    tz: tzinfo,
    slot_minutes: int = 30,
) -> dict[str, Any]:
    """Fold samples onto a 24-hour clock.

    ``modes`` are (ts, mode text) from status screens. They double as the count of
    screens taken, which is the right denominator for how often a PRN was tracked: a
    screen that reported no satellites at all writes no satellite rows, so counting
    satellite timestamps instead would quietly drop exactly the bad moments.

    ``sats`` are (ts, prn, tracked) satellite observations.
    """
    slot_seconds = slot_minutes * 60
    n_slots = 86400 // slot_seconds
    clock = _SlotClock(tz, slot_seconds)

    screens = [0] * n_slots
    cat_counts = [dict.fromkeys(CATEGORIES, 0) for _ in range(n_slots)]
    days_seen: list[set[int]] = [set() for _ in range(n_slots)]
    days_locked: list[set[int]] = [set() for _ in range(n_slots)]
    days_unlocked: list[set[int]] = [set() for _ in range(n_slots)]
    totals = dict.fromkeys(CATEGORIES, 0)
    first_ts: int | None = None
    last_ts: int | None = None

    for ts, text in modes:
        slot, day = clock.locate(ts)
        cat = classify(text)
        screens[slot] += 1
        cat_counts[slot][cat] += 1
        totals[cat] += 1
        days_seen[slot].add(day)
        (days_locked if cat == "locked" else days_unlocked)[slot].add(day)
        first_ts = ts if first_ts is None else min(first_ts, ts)
        last_ts = ts if last_ts is None else max(last_ts, ts)

    def mean_by_slot(rows: Iterable[tuple[int, float]]) -> tuple[list[Any], float | None]:
        sums = [0.0] * n_slots
        counts = [0] * n_slots
        mins: list[float | None] = [None] * n_slots
        maxs: list[float | None] = [None] * n_slots
        for ts, v in rows:
            slot, _ = clock.locate(ts)
            sums[slot] += v
            counts[slot] += 1
            mins[slot] = v if mins[slot] is None else min(mins[slot], v)  # type: ignore[type-var]
            maxs[slot] = v if maxs[slot] is None else max(maxs[slot], v)  # type: ignore[type-var]
        per = [
            {"avg": sums[i] / counts[i], "min": mins[i], "max": maxs[i], "n": counts[i]}
            if counts[i]
            else None
            for i in range(n_slots)
        ]
        n = sum(counts)
        return per, (sum(sums) / n if n else None)

    tracked_slots, tracked_avg = mean_by_slot(tracked)
    visible_slots, visible_avg = mean_by_slot(visible)

    prn_tracked: dict[int, list[int]] = {}
    for ts, prn, is_tracked in sats:
        if not is_tracked:
            continue
        slot, _ = clock.locate(ts)
        prn_tracked.setdefault(prn, [0] * n_slots)[slot] += 1

    total_screens = sum(screens)
    # Overall share per PRN, which also orders the rows of the satellite heatmap:
    # the satellites doing the most work come first.
    prn_share = {
        prn: (sum(counts) / total_screens if total_screens else 0.0)
        for prn, counts in prn_tracked.items()
    }
    prn_order = sorted(prn_share, key=lambda p: (-prn_share[p], p))

    slots: list[dict[str, Any]] = []
    for i in range(n_slots):
        n = screens[i]
        start = i * slot_seconds
        shares = (
            {prn: round(prn_tracked[prn][i] / n, 4) for prn in prn_order if prn_tracked[prn][i]}
            if n
            else {}
        )
        slots.append(
            {
                "start": f"{start // 3600:02d}:{start % 3600 // 60:02d}",
                "screens": n,
                "days": len(days_seen[i]),
                # Fraction of observed time in each state. Screens arrive on a fixed
                # cadence, so a share of samples is a share of time.
                "states": {c: (cat_counts[i][c] / n if n else None) for c in CATEGORIES},
                # Per-day view of the same thing: on how many of the observed days was
                # the unit locked at some point in this slot, and on how many did it
                # spend the whole slot locked.
                "days_any_lock": len(days_locked[i]),
                "days_all_lock": len(days_locked[i] - days_unlocked[i]),
                "tracked": tracked_slots[i],
                "visible": visible_slots[i],
                "prn_share": {str(p): s for p, s in shares.items()},
            }
        )

    return {
        "slot_minutes": slot_minutes,
        "slots": slots,
        "prns": [{"prn": p, "share": round(prn_share[p], 4)} for p in prn_order],
        "summary": {
            "screens": total_screens,
            "states": {
                c: (totals[c] / total_screens if total_screens else None) for c in CATEGORIES
            },
            "tracked_avg": tracked_avg,
            "visible_avg": visible_avg,
            "first_ts": first_ts,
            "last_ts": last_ts,
            "days": len(set().union(*days_seen)) if total_screens else 0,
        },
    }
