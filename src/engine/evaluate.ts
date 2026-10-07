/**
 * One symbol, one timeframe: bars in, either a scored row or an exclusion reason out.
 *
 * Why this exists: the same "bars -> gate checks -> indicators -> score -> signal" sequence
 * used to be written out three times (lib/scan-data.ts, lib/detail.ts, scripts/scan.ts), and
 * any rule added to one copy could silently miss the others. All three, plus
 * scripts/study.ts, now call `evaluateBars`, so the closed-bar rule (src/engine/bars.ts) and
 * the data-quality gate (src/engine/quality.ts) apply identically everywhere.
 *
 * What it guarantees:
 *   - Every indicator, score and signal is computed on CLOSED bars only (the in-progress last
 *     bar is dropped when it had not closed at `now`).
 *   - `price`, `chg` and `priceAsOf` come from the NEWEST bar, closed or not (live but about
 *     15 minutes delayed), so the table still shows today's price during the session.
 *   - `signalAsOf` is the start time of the bar the signal was computed on, and
 *     `lastBarClosed` says whether the newest bar was closed (true: signal bar = newest bar).
 *
 * What it does when run: nothing on its own; pure function, no file or clock access.
 *
 * How to see it work:
 *   node scripts/scan.ts --tf G --top 10     # header shows signalAsOf and lastBarClosed
 *   node --test tests/                        # tests/evaluate.test.ts covers the gates
 */
import { closedBars } from "./bars.ts";
import { indicators, MIN_BARS } from "./indicators.ts";
import { NO_QUALITY, qualityVerdict, type QualityContext } from "./quality.ts";
import { scoreOf, signalOf } from "./scoring.ts";
import type { Bar, Indicators, ScoreComponent, Signal, Timeframe } from "./types.ts";

/**
 * Why a symbol is not scored (Turkish codes, shown through lib/excluded.ts):
 *   "az-bar"          fewer than MIN_BARS closed bars (warm-up not met)
 *   "veri-yok"        no bar file, or the file could not be parsed (set by the caller)
 *   "hesap-hatasi"    the engine threw, or price/score was not a finite number
 *   "bayat-veri"      stale: the last bar is several sessions behind the run, or Yahoo did
 *                     not return the symbol in this run and the file is left over
 *   "fiyat-sicramasi" a suspected unadjusted corporate action or data error inside the
 *                     indicator lookback
 * To add a reason: add it here, give it a label and a sentence in lib/excluded.ts.
 */
export type ExclusionReason = "az-bar" | "veri-yok" | "hesap-hatasi" | "bayat-veri" | "fiyat-sicramasi";

/** A scored symbol. */
export interface Evaluated {
  ok: true;
  /** Indicators on the closed series (chart included, built from closed bars). */
  ind: Indicators;
  score: number;
  breakdown: ScoreComponent[];
  signal: Signal;
  /** Close of the NEWEST bar (may be in progress). */
  price: number;
  /** Percent change of the newest close versus the bar before it. */
  chg: number;
  /** Start time (epoch ms) of the newest bar, where `price` comes from. */
  priceAsOf: number;
  /** Start time (epoch ms) of the closed bar the signal is computed on. */
  signalAsOf: number;
  /** True when the newest bar had closed at `now`, so signal bar = price bar. */
  lastBarClosed: boolean;
}

/** A symbol that is not scored, with what the excluded list needs. */
export interface Rejected {
  ok: false;
  reason: ExclusionReason;
  /** Closed bars available (0 when there is no data). */
  bars: number;
  /** Start time of the oldest bar, or null when there is no data. */
  firstBarAt: number | null;
  /** Optional Turkish detail sentence (quality gates fill this). */
  note?: string;
}

export type Evaluation = Evaluated | Rejected;

/**
 * Evaluate one symbol.
 * @param symbol  ticker without the ".IS" suffix (used to look up the quality report)
 * @param bars    bars oldest first, as written by ingest/ingest.py
 * @param tf      timeframe code
 * @param now     reference instant for the closed-bar rule; pipelines pass the ingest start
 *                time (`startedAt`, else `fetchedAt`) because that is when the bars were frozen
 * @param quality data-quality reports; omit to skip the gate (no report available)
 */
export function evaluateBars(
  symbol: string,
  bars: unknown,
  tf: Timeframe,
  now: number,
  quality: QualityContext = NO_QUALITY,
): Evaluation {
  if (!Array.isArray(bars) || bars.length === 0) {
    return { ok: false, reason: "az-bar", bars: 0, firstBarAt: null };
  }
  const all = bars as Bar[];
  const { closed, lastBarClosed } = closedBars(all, tf, now);
  const firstBarAt = all[0].t;
  if (closed.length < MIN_BARS) {
    return { ok: false, reason: "az-bar", bars: closed.length, firstBarAt };
  }

  const verdict = qualityVerdict(symbol, closed, tf, quality, all[all.length - 1].t);
  if (verdict) {
    return { ok: false, reason: verdict.reason, bars: closed.length, firstBarAt, note: verdict.note };
  }

  try {
    const ind = indicators(closed, tf);
    const { score, breakdown } = scoreOf(ind, tf);
    const last = all[all.length - 1];
    const prev = all[all.length - 2];
    const price = last.c;
    const chg = (last.c / prev.c - 1) * 100;
    if (!Number.isFinite(ind.price) || !Number.isFinite(score) || !Number.isFinite(price)) {
      return { ok: false, reason: "hesap-hatasi", bars: closed.length, firstBarAt };
    }
    return {
      ok: true,
      ind,
      score,
      breakdown,
      signal: signalOf(score),
      price,
      chg,
      priceAsOf: last.t,
      signalAsOf: closed[closed.length - 1].t,
      lastBarClosed,
    };
  } catch {
    // Engine error (for example a degenerate series): skip this symbol only.
    return { ok: false, reason: "hesap-hatasi", bars: closed.length, firstBarAt };
  }
}
