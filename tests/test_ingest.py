"""
Ingest tests (ingest/ingest.py): time zone normalisation and the data-quality checks.

What it does when run: builds small pandas DataFrames and bar lists by hand (no network, no
Yahoo call; yfinance is imported lazily by the ingest and never loaded here) and checks:
  - naive and time-zone-aware indexes both end up as real Istanbul instants,
  - the jump rule for daily, weekly and hourly bars, including the session-gap allowance,
  - stale detection, missing symbols, per-symbol gaps and calendar holes.

How to run it and see output:
    ./.venv/Scripts/python -m unittest discover -s tests -p "test_*.py"
    # -> "Ran 12 tests ... OK"

Extension point: for a new quality rule in ingest.py, add a test method that builds the
smallest bar list that trips the rule and one that sits just inside it.
"""

from __future__ import annotations

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

# The ingest is a script, not a package: put its folder on the import path.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ingest"))
import ingest  # noqa: E402

IST = timezone(timedelta(hours=3))  # Istanbul: fixed UTC+3, no daylight saving time since 2016


def ist_ms(y: int, m: int, d: int, hh: int = 0, mm: int = 0) -> int:
    """Istanbul wall-clock time -> epoch milliseconds."""
    return int(datetime(y, m, d, hh, mm, tzinfo=IST).timestamp() * 1000)


def daily(dates_closes: list[tuple[str, float]]) -> list[dict]:
    """Daily bars from ("YYYY-MM-DD", close) pairs, stamped 00:00 Istanbul like Yahoo."""
    out = []
    for d, c in dates_closes:
        y, m, dd = map(int, d.split("-"))
        out.append({"t": ist_ms(y, m, dd), "o": c, "h": c, "l": c, "c": c, "v": 1.0})
    return out


def frame(index) -> pd.DataFrame:
    """Minimal OHLCV frame with the given index."""
    n = len(index)
    return pd.DataFrame(
        {"Open": [1.0] * n, "High": [1.0] * n, "Low": [1.0] * n, "Close": [1.0] * n, "Volume": [5.0] * n},
        index=index,
    )


class TimezoneTests(unittest.TestCase):
    def test_naive_daily_index_is_istanbul_midnight(self):
        # What yfinance returns for 1d with ignore_tz=True: naive local wall time 00:00.
        naive = pd.DatetimeIndex(["2026-10-07"])
        # The old code: pandas treats naive as UTC -> 00:00 UTC = 03:00 Istanbul (wrong instant).
        self.assertEqual(int(naive[0].timestamp() * 1000), ist_ms(2026, 10, 7, 3))
        bars = ingest.frame_to_bars(frame(naive))
        self.assertEqual(bars[0]["t"], ist_ms(2026, 10, 7))  # = 2026-10-06 21:00 UTC
        self.assertEqual(ingest.ist_date(bars[0]["t"]), "2026-10-07")

    def test_aware_index_is_converted_not_relabelled(self):
        utc = pd.DatetimeIndex(["2026-10-07 07:30"], tz="UTC")  # 10:30 Istanbul hourly bar
        bars = ingest.frame_to_bars(frame(utc))
        self.assertEqual(bars[0]["t"], ist_ms(2026, 10, 7, 10, 30))
        local = ingest.to_istanbul_index(utc)
        self.assertEqual(local[0].hour, 10)
        self.assertEqual(str(local.tz), "Europe/Istanbul")

    def test_nan_rows_are_dropped(self):
        f = frame(pd.DatetimeIndex(["2026-10-06", "2026-10-07"]))
        f.loc[f.index[0], "Close"] = float("nan")
        self.assertEqual(len(ingest.frame_to_bars(f)), 1)


class JumpTests(unittest.TestCase):
    def test_daily_limit_eleven_percent(self):
        ok = daily([("2026-10-05", 10.0), ("2026-10-06", 10.99)])  # +9.9%, inside the limit
        bad = daily([("2026-10-05", 10.0), ("2026-10-06", 11.2)])  # +12%
        self.assertEqual(ingest.find_jumps(ok, "G"), [])
        js = ingest.find_jumps(bad, "G")
        self.assertEqual(len(js), 1)
        self.assertEqual(js[0]["date"], "2026-10-06")
        self.assertAlmostEqual(js[0]["pct"], 12.0)

    def test_missing_session_allows_two_sessions_of_movement(self):
        # 2026-10-06 missing (the Yahoo gap seen on 2026-10-07): +20% over two sessions is legal.
        two = daily([("2026-10-05", 10.0), ("2026-10-07", 12.0)])
        self.assertEqual(ingest.find_jumps(two, "G"), [])
        # Friday -> Monday is ONE session: +20% is a jump.
        weekend = daily([("2026-10-02", 10.0), ("2026-10-05", 12.0)])
        self.assertEqual(len(ingest.find_jumps(weekend, "G")), 1)

    def test_split_halving_is_flagged(self):
        js = ingest.find_jumps(daily([("2026-10-05", 100.0), ("2026-10-06", 50.0)]), "G")
        self.assertEqual(js[0]["pct"], -50.0)

    def test_weekly_bound_compounds_five_sessions(self):
        weeks = [("2026-09-28", 10.0), ("2026-10-05", 16.0)]  # +60% < 1.11^5 - 1 = 68.5%
        self.assertEqual(ingest.find_jumps(daily(weeks), "H"), [])
        halved = [("2026-09-28", 10.0), ("2026-10-05", 5.0)]  # -50% < 0.89^5 - 1 = -44.2%
        self.assertEqual(len(ingest.find_jumps(daily(halved), "H")), 1)

    def test_hourly_compares_with_previous_session_base(self):
        def hb(d, hh, c):
            return {"t": ist_ms(2026, 10, d, hh, 30), "o": c, "h": c, "l": c, "c": c, "v": 1.0}

        # Base (last close of 10-05) = 10. Intraday swing 9.1 -> 10.9 (+20% bar to bar) is
        # legal: both stay within 10% of the base.
        swing = [hb(5, 17, 10.0), hb(6, 10, 9.1), hb(6, 11, 10.9)]
        self.assertEqual(ingest.find_jumps(swing, "S"), [])
        # 14% above base: inside the 15% hourly tolerance (last hourly close != official close).
        self.assertEqual(ingest.find_jumps([hb(5, 17, 10.0), hb(6, 10, 11.4)], "S"), [])
        # 40% below base: flagged once for the day even if several bars stay there.
        crash = [hb(5, 17, 10.0), hb(6, 10, 6.0), hb(6, 11, 6.1)]
        js = ingest.find_jumps(crash, "S")
        self.assertEqual(len(js), 1)
        self.assertEqual(js[0]["date"], "2026-10-06")

    def test_nonpositive_close_is_a_data_error(self):
        js = ingest.find_jumps(daily([("2026-10-05", 10.0), ("2026-10-06", 0.0)]), "G")
        self.assertEqual(js[0]["kind"], "gecersiz-fiyat")


class ReportTests(unittest.TestCase):
    def setUp(self):
        sessions = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-07"]
        self.full = daily([(d, 10.0) for d in sessions])
        # Three sessions behind (last 2026-10-01): not stale. Four behind: stale.
        self.three = daily([(d, 10.0) for d in sessions[:4]])
        self.four = daily([(d, 10.0) for d in sessions[:3]])
        # One gap at 2026-10-02 inside its own range.
        self.gappy = daily([(d, 10.0) for d in sessions if d != "2026-10-02"])

    def report(self):
        bars = {"A": self.full, "B": self.full, "C": self.full, "THREE": self.three, "FOUR": self.four, "GAP": self.gappy}
        return ingest.quality_report("G", bars, sorted(bars) + ["NOPE"], now_ms=0)

    def test_stale_threshold(self):
        r = self.report()
        self.assertIn("FOUR", r["stale"])
        self.assertEqual(r["stale"]["FOUR"]["sessionsBehind"], 4)
        self.assertNotIn("THREE", r["stale"])
        self.assertEqual(r["newestSession"], "2026-10-07")

    def test_missing_gaps_and_calendar_holes(self):
        r = self.report()
        self.assertEqual(r["missing"], ["NOPE"])
        self.assertEqual(r["gaps"]["GAP"]["recent"], ["2026-10-02"])
        self.assertNotIn("A", r["gaps"])
        # 2026-10-06 is missing for everyone: not a per-symbol gap, but a calendar hole.
        self.assertEqual(r["calendarHoles"], ["2026-10-06"])

    def test_weekday_helpers(self):
        self.assertEqual(ingest.weekdays_between("2026-10-02", "2026-10-05"), 1)  # Fri -> Mon
        self.assertEqual(ingest.weekdays_between("2026-10-05", "2026-10-07"), 2)
        self.assertEqual(ingest.week_end("2026-10-07"), "2026-10-09")


if __name__ == "__main__":
    unittest.main()
