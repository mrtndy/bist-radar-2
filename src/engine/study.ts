/**
 * Forward-return study core: pure functions that score every historical bar of a symbol and
 * summarise what happened next. The command-line wrapper with file input/output is
 * `scripts/study.ts`; this file holds the logic so tests can check it without touching disk.
 *
 * The question it answers: does a high score at the close of day t predict a better return
 * over the next 5 and 20 sessions than a low score? It reports by score decile and by signal
 * bucket (AL = buy, NÖTR = neutral, SAT = sell).
 *
 * No look-ahead, and why it holds: every indicator series in src/engine/indicators.ts is
 * causal (the value at index i reads bars 0..i only: running sums, recursive averages and
 * backward-looking windows). So computing the series ONCE over all bars and reading index t
 * gives exactly the value a scan run at the close of bar t would have shown.
 * tests/study.test.ts proves both halves: (1) `scoreHistory(bars)[t]` equals a fresh
 * `indicators(bars.slice(0, t + 1))` score, and (2) changing any bar after t never changes the
 * score at t.
 *
 * What it does when run: nothing on its own; library module.
 *
 * How to see it work:
 *   node --test tests/study.test.ts
 *   node scripts/study.ts --tf G          # prints the decile and signal tables
 */
import { indicatorSeries, MIN_BARS, snapshotAt } from "./indicators.ts";
import { scoreOf, signalOf } from "./scoring.ts";
import type { Bar, Signal, Timeframe } from "./types.ts";

/** Score of one historical bar. */
export interface ScoredBar {
  /** Index into the bar array. */
  i: number;
  /** Bar start time, epoch ms. */
  t: number;
  score: number;
  signal: Signal;
}

/**
 * Score every bar from the first one with a full warm-up (index MIN_BARS - 1) to the end.
 * Uses the same `scoreOf(…, tf)` as the live scan, so the study measures the shipped score.
 */
export function scoreHistory(bars: Bar[], tf: Timeframe): ScoredBar[] {
  if (bars.length < MIN_BARS) return [];
  const series = indicatorSeries(bars);
  const out: ScoredBar[] = [];
  for (let i = MIN_BARS - 1; i < bars.length; i++) {
    const { score } = scoreOf(snapshotAt(series, i), tf);
    if (!Number.isFinite(score)) continue;
    out.push({ i, t: bars[i].t, score, signal: signalOf(score) });
  }
  return out;
}

/** Close-to-close return from bar i to bar i + h, or null when i + h is past the end. */
export function forwardReturn(bars: Bar[], i: number, h: number): number | null {
  const j = i + h;
  if (j >= bars.length || !(bars[i].c > 0)) return null;
  return bars[j].c / bars[i].c - 1;
}

/** True when any timestamp in `sortedTimes` lies in [from, to). Binary search, O(log n). */
export function anyTimeIn(sortedTimes: readonly number[], from: number, to: number): boolean {
  let lo = 0;
  let hi = sortedTimes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedTimes[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < sortedTimes.length && sortedTimes[lo] < to;
}

/** Summary statistics of one bucket of returns. */
export interface BucketStats {
  count: number;
  /** Mean forward return, percent. */
  mean: number | null;
  /** Median forward return, percent. */
  median: number | null;
  /** Share of observations with a positive forward return, percent. */
  hitRate: number | null;
  /** Mean of (forward return minus the same-day equal-weight average), percent. */
  meanExcess: number | null;
}

/** Statistics over raw returns `r` and excess returns `x` (same length, fractions). */
export function bucketStats(r: readonly number[], x: readonly number[]): BucketStats {
  const n = r.length;
  if (n === 0) return { count: 0, mean: null, median: null, hitRate: null, meanExcess: null };
  const sorted = [...r].sort((a, b) => a - b);
  const med = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const mean = r.reduce((s, v) => s + v, 0) / n;
  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const hits = r.filter((v) => v > 0).length;
  return { count: n, mean: mean * 100, median: med * 100, hitRate: (hits / n) * 100, meanExcess: meanX * 100 };
}

/**
 * Cross-sectional deciles for one day: 0 = lowest scores ... 9 = highest. Ties share a decile
 * (mid-rank), so many equal integer scores never get split arbitrarily by symbol name.
 * Returns -1 for every element when there are fewer than 10 observations that day.
 */
export function decilesOf(scores: readonly number[]): number[] {
  const n = scores.length;
  if (n < 10) return scores.map(() => -1);
  const order = scores.map((s, k) => [s, k] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(n);
  let a = 0;
  while (a < n) {
    let b = a;
    while (b + 1 < n && order[b + 1][0] === order[a][0]) b++;
    const midRank = (a + b) / 2; // 0-based mid-rank of the tie group
    const dec = Math.min(9, Math.floor(((midRank + 0.5) / n) * 10));
    for (let k = a; k <= b; k++) out[order[k][1]] = dec;
    a = b + 1;
  }
  return out;
}
