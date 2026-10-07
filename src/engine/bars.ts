/**
 * Closed-bar helper: decides whether the LAST bar of a series had finished when the data was
 * fetched, so that every signal, score and indicator value is computed on completed bars only.
 *
 * Why this exists: the deploy workflow refreshes the data every 15 minutes during the Borsa
 * Istanbul (BIST) session. Before this helper, the in-progress bar (for example today's daily
 * bar at 11:00) was scored as if it had closed, so a signal could flip back and forth during
 * the day. Now the scan computes the signal on the last CLOSED bar and only the displayed
 * price and change come from the newest (possibly in-progress, 15-minute delayed) bar.
 *
 * What it does when run: nothing on its own; it is a pure library (no input/output, no clock
 * access; the caller passes "now"). Used by `src/engine/evaluate.ts`, which every pipeline copy
 * (`lib/scan-data.ts`, `lib/detail.ts`, `scripts/scan.ts`, `scripts/study.ts`) goes through.
 *
 * How to see it work:
 *   node --test tests/bars.test.ts
 *   node -e "import('./src/engine/bars.ts').then(m => console.log(m.barClosesAt(Date.UTC(2026,9,6,21), 'G')))"
 *   # -> 1791387000000  (2026-10-07 18:30 Istanbul = 15:30 UTC)
 *
 * Session facts this relies on (BIST equity market, verified against the bars Yahoo returns,
 * see README "Bilinen konular"):
 *   - Continuous trading 10:00-18:00 Europe/Istanbul, closing auction until about 18:10.
 *   - Istanbul has used fixed UTC+3 with no daylight saving time (DST) since 2016, so a fixed
 *     offset is exact and keeps this file free of time zone database lookups.
 *   - Yahoo stamps daily bars at 00:00 Istanbul of the session date and weekly bars at 00:00
 *     Istanbul on the Monday of the week (a few listing/holiday weeks start on another
 *     weekday, handled by snapping to Monday).
 *   - Yahoo stamps hourly BIST bars at their START on the half hour: 09:30, 10:30, ... 17:30,
 *     nine bars a day (measured 2026-10-07 over 618 symbols). The 09:30 bar holds the opening
 *     auction plus 10:00-10:30; the 17:30 bar holds 17:30-18:00 plus the closing auction, so it
 *     really ends at about 18:10, not 18:30.
 *   - Yahoo data for BIST is about 15 minutes delayed.
 */
import type { Bar, Timeframe } from "./types.ts";

/** Istanbul offset from Coordinated Universal Time (UTC): fixed +3 hours, no DST since 2016. */
export const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;

/** One minute, one hour and one day in milliseconds (epoch arithmetic helpers). */
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Minute of the Istanbul day from which a DAILY (and weekly) bar counts as closed: 18:30.
 * The closing auction ends about 18:10 and the feed lags about 15 minutes, so 18:30 leaves a
 * small safety margin. To move the cutoff (for example a half-day session), change this.
 */
export const DAILY_CLOSE_MINUTE = 18 * 60 + 30;

/** Length of one hourly bar. */
export const HOURLY_BAR_MS = HOUR_MS;

/** Minute of the Istanbul day when the session (closing auction) ends: about 18:10. An hourly
 * bar never runs past this, so the 17:30 bar ends here instead of at 18:30. */
export const SESSION_END_MINUTE = 18 * 60 + 10;

/**
 * Extra wait after an hourly bar's nominal end before it counts as closed: the Yahoo feed is
 * about 15 minutes delayed, so at 11:00 the 10:00 bar only holds trades up to about 10:45.
 * Set to 0 to use the bare "start + 60 minutes" rule.
 */
export const HOURLY_FEED_DELAY_MS = 15 * MINUTE_MS;

/**
 * Last session of the trading week, counted from Monday (0 = Monday ... 4 = Friday). Holidays
 * are not modelled: when Friday is a holiday the weekly bar is treated as closed only from
 * Friday 18:30, which is a few hours late but never early (conservative by design).
 */
export const WEEK_LAST_SESSION_OFFSET_DAYS = 4;

/** Days since the Unix epoch of the Istanbul calendar date that contains instant `t`. */
export function istanbulDayNumber(t: number): number {
  return Math.floor((t + ISTANBUL_OFFSET_MS) / DAY_MS);
}

/** Epoch ms of 00:00 Istanbul on Istanbul day number `day`. */
function istanbulMidnight(day: number): number {
  return day * DAY_MS - ISTANBUL_OFFSET_MS;
}

/** Istanbul weekday of instant `t`: 0 = Monday ... 6 = Sunday (ISO order). */
export function istanbulWeekday(t: number): number {
  // Day 0 of the epoch (1970-01-01) was a Thursday, which is ISO index 3.
  return (istanbulDayNumber(t) + 3) % 7;
}

/** "YYYY-MM-DD" Istanbul calendar date of instant `t` (used for reports and tests). */
export function istanbulDate(t: number): string {
  return new Date(istanbulMidnight(istanbulDayNumber(t)) + ISTANBUL_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The instant from which a bar that STARTS at `t` counts as closed.
 *   G (daily):  18:30 Istanbul on the bar's session date.
 *   H (weekly): 18:30 Istanbul on the Friday of the bar's week.
 *   S (hourly): min(bar start + 60 minutes, 18:10 session end that day) + feed delay.
 * To add a timeframe, add a case here and a matching test in tests/bars.test.ts.
 */
export function barClosesAt(t: number, tf: Timeframe): number {
  switch (tf) {
    case "G":
      return istanbulMidnight(istanbulDayNumber(t)) + DAILY_CLOSE_MINUTE * MINUTE_MS;
    case "H": {
      // Monday of the bar's week, whatever weekday Yahoo used for the stamp.
      const monday = istanbulDayNumber(t) - istanbulWeekday(t);
      return istanbulMidnight(monday + WEEK_LAST_SESSION_OFFSET_DAYS) + DAILY_CLOSE_MINUTE * MINUTE_MS;
    }
    case "S": {
      const sessionEnd = istanbulMidnight(istanbulDayNumber(t)) + SESSION_END_MINUTE * MINUTE_MS;
      // Math.max guards an odd stamp after the session end (never seen): it then needs a full hour.
      const end = Math.min(t + HOURLY_BAR_MS, Math.max(sessionEnd, t + MINUTE_MS));
      return end + HOURLY_FEED_DELAY_MS;
    }
    default: {
      // Exhaustiveness guard: a new Timeframe value must get its own rule above.
      const never: never = tf;
      throw new Error(`barClosesAt: unknown timeframe ${String(never)}`);
    }
  }
}

/** True when the bar that starts at `t` had closed at instant `now`. */
export function isBarClosed(t: number, tf: Timeframe, now: number): boolean {
  return now >= barClosesAt(t, tf);
}

/** Result of `closedBars`: the series to compute signals on, plus what was decided. */
export interface ClosedSplit {
  /** Bars to compute signals on: all bars, or all but the in-progress last bar. */
  closed: Bar[];
  /** True when the newest bar had closed at `now` (nothing was dropped). */
  lastBarClosed: boolean;
}

/**
 * Drops the last bar when it was still in progress at `now`. Only the last bar can be open:
 * any earlier bar has a later bar after it, so it necessarily finished. Never mutates `bars`.
 */
export function closedBars(bars: Bar[], tf: Timeframe, now: number): ClosedSplit {
  if (bars.length === 0) return { closed: bars, lastBarClosed: true };
  const lastBarClosed = isBarClosed(bars[bars.length - 1].t, tf, now);
  return { closed: lastBarClosed ? bars : bars.slice(0, -1), lastBarClosed };
}
