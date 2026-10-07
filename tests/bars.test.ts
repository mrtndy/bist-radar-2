/**
 * Closed-bar helper tests (src/engine/bars.ts): when does the last daily, weekly or hourly
 * bar count as closed, across session times, weekends and the fixed Istanbul offset.
 *
 * What it does when run: feeds bar start times (stamped the way Yahoo stamps BIST bars) and
 * "now" instants to the helper and checks the closed/open verdict on both sides of every
 * cutoff.
 *
 * How to run it and see output:
 *   node --test tests/bars.test.ts
 *   # -> "# fail 0"
 *
 * Time notation: `ist(y, m, d, hh, mm)` builds an instant from Istanbul wall-clock time
 * (UTC+3, no daylight saving time since 2016), month 1-based for readability.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  barClosesAt,
  closedBars,
  istanbulDate,
  istanbulWeekday,
  isBarClosed,
} from "../src/engine/bars.ts";
import type { Bar } from "../src/engine/types.ts";

/** Istanbul wall-clock time -> epoch ms (UTC+3). */
const ist = (y: number, m: number, d: number, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh - 3, mm);

/** A bar with only the start time mattering. */
const bar = (t: number): Bar => ({ t, o: 1, h: 1, l: 1, c: 1, v: 1 });

test("Istanbul is UTC+3 all year: helper dates agree with the IANA time zone database", () => {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" });
  // Instants around midnight in winter and summer: a DST rule would shift one of them.
  for (const t of [Date.UTC(2026, 0, 15, 20, 59), Date.UTC(2026, 0, 15, 21, 0), Date.UTC(2026, 6, 15, 20, 59), Date.UTC(2026, 6, 15, 21, 0)]) {
    assert.equal(istanbulDate(t), fmt.format(t), new Date(t).toISOString());
  }
  assert.equal(istanbulWeekday(ist(2026, 10, 5)), 0, "2026-10-05 is a Monday");
  assert.equal(istanbulWeekday(ist(2026, 10, 11, 23, 59)), 6, "2026-10-11 is a Sunday");
});

test("Daily: today's bar is open during the session and closes at 18:30 Istanbul", () => {
  const t = ist(2026, 10, 7); // Yahoo daily stamp: 00:00 Istanbul
  assert.equal(isBarClosed(t, "G", ist(2026, 10, 7, 11, 0)), false, "mid-session");
  assert.equal(isBarClosed(t, "G", ist(2026, 10, 7, 18, 10)), false, "closing auction just ended, feed still delayed");
  assert.equal(isBarClosed(t, "G", ist(2026, 10, 7, 18, 29)), false);
  assert.equal(isBarClosed(t, "G", ist(2026, 10, 7, 18, 30)), true, "cutoff is inclusive");
  assert.equal(isBarClosed(t, "G", ist(2026, 10, 8, 9, 0)), true, "next morning, before the open");
});

test("Daily: the old 00:00 UTC stamp (03:00 Istanbul) gives the same verdict", () => {
  // Data written before the 2026-10-07 time zone fix stamped daily bars at 00:00 UTC.
  const legacy = Date.UTC(2026, 9, 7);
  assert.equal(barClosesAt(legacy, "G"), barClosesAt(ist(2026, 10, 7), "G"));
});

test("Daily: a Friday bar seen on Saturday or Monday morning is closed", () => {
  const fri = ist(2026, 10, 9);
  assert.equal(isBarClosed(fri, "G", ist(2026, 10, 10, 12, 0)), true);
  assert.equal(isBarClosed(fri, "G", ist(2026, 10, 12, 9, 59)), true);
});

test("Weekly: open until Friday 18:30 of the bar's week, whatever weekday it is stamped on", () => {
  const mon = ist(2026, 10, 5); // Yahoo weekly stamp: Monday 00:00 Istanbul
  assert.equal(isBarClosed(mon, "H", ist(2026, 10, 7, 12, 0)), false, "Wednesday");
  assert.equal(isBarClosed(mon, "H", ist(2026, 10, 9, 18, 29)), false, "Friday before cutoff");
  assert.equal(isBarClosed(mon, "H", ist(2026, 10, 9, 18, 30)), true, "Friday cutoff");
  assert.equal(isBarClosed(mon, "H", ist(2026, 10, 10, 10, 0)), true, "Saturday");
  // A listing week stamped on Wednesday still ends on that week's Friday.
  assert.equal(barClosesAt(ist(2026, 10, 7), "H"), barClosesAt(mon, "H"));
});

test("Hourly: half-hour stamped bars close one hour later plus the 15-minute feed delay", () => {
  const b1030 = ist(2026, 10, 7, 10, 30);
  assert.equal(isBarClosed(b1030, "S", ist(2026, 10, 7, 11, 30)), false, "nominal end, feed still 15 min behind");
  assert.equal(isBarClosed(b1030, "S", ist(2026, 10, 7, 11, 44)), false);
  assert.equal(isBarClosed(b1030, "S", ist(2026, 10, 7, 11, 45)), true);
  // The opening 09:30 bar (auction + 10:00-10:30).
  assert.equal(barClosesAt(ist(2026, 10, 7, 9, 30), "S"), ist(2026, 10, 7, 10, 45));
});

test("Hourly: the 17:30 bar ends with the closing auction (18:10), so it closes at 18:25", () => {
  const b1730 = ist(2026, 10, 7, 17, 30);
  assert.equal(barClosesAt(b1730, "S"), ist(2026, 10, 7, 18, 25));
  assert.equal(isBarClosed(b1730, "S", ist(2026, 10, 7, 18, 24)), false);
  assert.equal(isBarClosed(b1730, "S", ist(2026, 10, 10, 9, 0)), true, "seen on Saturday");
});

test("closedBars drops only an open last bar and never mutates the input", () => {
  const bars = [bar(ist(2026, 10, 5)), bar(ist(2026, 10, 6)), bar(ist(2026, 10, 7))];
  const midSession = closedBars(bars, "G", ist(2026, 10, 7, 11, 0));
  assert.equal(midSession.lastBarClosed, false);
  assert.deepEqual(midSession.closed.map((b) => b.t), [bars[0].t, bars[1].t]);
  assert.equal(bars.length, 3, "input untouched");
  const evening = closedBars(bars, "G", ist(2026, 10, 7, 19, 0));
  assert.equal(evening.lastBarClosed, true);
  assert.equal(evening.closed, bars, "nothing dropped: same array returned");
  assert.deepEqual(closedBars([], "G", 0), { closed: [], lastBarClosed: true });
});
