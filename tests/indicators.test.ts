/**
 * Indicator engine tests: Relative Strength Index (RSI), Average True Range (ATR), Moving
 * Average Convergence Divergence (MACD) and stochastic oscillator against values computed by
 * hand, plus the edge cases that motivated the 2026-10-07 changes (flat 14-bar range, relVol
 * excluding the current bar) and the flat-price RSI behaviour that is pinned, not changed.
 *
 * What it does when run: builds tiny synthetic bar series whose indicator values can be
 * worked out on paper, and asserts the engine produces exactly those numbers.
 *
 * How to run it and see output:
 *   node --test tests/indicators.test.ts
 *   # -> "# pass 11" (or similar) and "# fail 0"
 *
 * Extension point: to cover a new indicator, add a `test(...)` that builds the smallest
 * series where the expected value is obvious, write the hand calculation in a comment, and
 * compare with `close(...)`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { indicators, indicatorSeries, MIN_BARS, snapshotAt } from "../src/engine/indicators.ts";
import { scoreOf } from "../src/engine/scoring.ts";
import type { Bar } from "../src/engine/types.ts";

/** Floating-point comparison with a relative tolerance (the engine accumulates sums). */
function close(actual: number | null | undefined, expected: number, tol = 1e-9): void {
  assert.ok(actual != null, `expected ${expected}, got ${actual}`);
  assert.ok(
    Math.abs((actual as number) - expected) <= tol * Math.max(1, Math.abs(expected)),
    `expected ${expected}, got ${actual}`,
  );
}

/** Bars from closes only: open = close, high/low = close +/- `half`, volume `v`. */
function barsFromCloses(closes: number[], half = 1, v = 1000): Bar[] {
  return closes.map((c, i) => ({ t: Date.UTC(2026, 0, 1) + i * 86_400_000, o: c, h: c + half, l: c - half, c, v }));
}

/** Deterministic pseudo-random generator (mulberry32) so the random-walk tests are repeatable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random-walk series long enough for `indicators()` (MIN_BARS = 120). */
function randomWalk(n: number, seed = 7): Bar[] {
  const r = rng(seed);
  let p = 50;
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const c = p * (1 + (r() - 0.5) * 0.04);
    const o = p;
    out.push({ t: Date.UTC(2025, 0, 1) + i * 86_400_000, o, h: Math.max(o, c) * (1 + r() * 0.01), l: Math.min(o, c) * (1 - r() * 0.01), c, v: 1e5 * (0.5 + r()) });
    p = c;
  }
  return out;
}

test("RSI: Wilder seed and first recursive step match the hand calculation", () => {
  // 14 changes alternating +1 / -0.5: seven gains of 1, seven losses of 0.5.
  // avgGain = 7/14 = 0.5, avgLoss = 3.5/14 = 0.25, RS = 2, RSI = 100 - 100/3 = 66.666...
  const closes = [10];
  for (let i = 0; i < 14; i++) closes.push(closes[closes.length - 1] + (i % 2 === 0 ? 1 : -0.5));
  // Step 15: +1. avgGain = (0.5*13 + 1)/14 = 7.5/14, avgLoss = 0.25*13/14 = 3.25/14,
  // RS = 30/13, RSI = 100 * 30/43 = 69.767441860...
  closes.push(closes[closes.length - 1] + 1);
  const s = indicatorSeries(barsFromCloses(closes));
  assert.equal(s.rsi[13], null, "no RSI before 14 changes");
  close(s.rsi[14], 200 / 3);
  close(s.rsi[15], 3000 / 43);
});

test("ATR: Wilder average of true ranges, gap counted from previous close", () => {
  // 14 bars with high - low = 2 and constant close 10: every true range is 2, ATR[13] = 2.
  // Bar 14 gaps up: close 20, high 21, low 19. TR = max(2, |21-10|, |19-10|) = 11.
  // ATR[14] = (2*13 + 11)/14 = 37/14.
  const bars = barsFromCloses([...Array(14).fill(10), 20]);
  const s = indicatorSeries(bars);
  assert.equal(s.atr[12], null);
  close(s.atr[13], 2);
  close(s.atr[14], 37 / 14);
});

test("MACD: EMA(12) - EMA(26) seeded with the first close, signal = EMA(9) of MACD", () => {
  // Step from 10 to 20 at index 1.
  // EMA12[1] = 20*2/13 + 10*11/13 = 150/13; EMA26[1] = 20*2/27 + 10*25/27 = 290/27.
  // MACD[1] = 150/13 - 290/27; signal[1] = MACD[1]*2/10 + 0*8/10; hist = MACD - signal.
  const s = indicatorSeries(barsFromCloses([10, 20, 20]));
  const macd1 = 150 / 13 - 290 / 27;
  close(s.macd[0], 0);
  close(s.macd[1], macd1);
  close(s.sig[1], macd1 * 0.2);
  close(s.hist[1], macd1 * 0.8);
});

test("Stochastic: %K = 3-bar mean of raw %K over a 14-bar high/low window", () => {
  // Close i, high i+1, low i-1. At bar i the 14-bar window is i-13..i:
  // highest high = i+1, lowest low = i-14, raw %K = 100*(i-(i-14))/((i+1)-(i-14)) = 1400/15.
  const closes = Array.from({ length: 20 }, (_, i) => i + 10);
  const s = indicatorSeries(barsFromCloses(closes));
  assert.equal(s.K[14], null, "first smoothed %K needs three raw values (index 15)");
  close(s.K[15], 1400 / 15);
  // %D at 17 averages %K 15..17, all equal.
  close(s.D[17], 1400 / 15);
});

test("Flat 14-bar range: raw %K is neutral 50, not 0 (2026-10-07 change)", () => {
  // 20 identical bars (open = high = low = close): highest high == lowest low.
  const bars: Bar[] = Array.from({ length: 20 }, (_, i) => ({ t: i, o: 5, h: 5, l: 5, c: 5, v: 100 }));
  const s = indicatorSeries(bars);
  close(s.K[15], 50);
  close(s.K[19], 50);
  close(s.D[19], 50);
});

test("Flat 14-bar range inside a full series is scored neutral, not oversold", () => {
  const bars = randomWalk(MIN_BARS + 10);
  const px = bars[bars.length - 21].c;
  for (let i = bars.length - 20; i < bars.length; i++) bars[i] = { ...bars[i], o: px, h: px, l: px, c: px };
  const ind = indicators(bars, "G");
  assert.equal(ind.k, 50);
  const stoch = scoreOf(ind, "G").breakdown.find((b) => b.k === "Stokastik");
  assert.ok(stoch && !stoch.n.startsWith("Aşırı satım"), `stochastic text: ${stoch?.n}`);
});

test("Flat prices: RSI is neutral 50 (2026-10-07 change; the prototype gave 0)", () => {
  // No gains and no losses: RSI is mathematically undefined. The prototype's formula gave
  // 100 - 100/(1 + 0/1e-9) = 0 and scored it "Aşırı satım" (+3). Since 2026-10-07 the
  // engine returns 50, the same neutral rule as the flat-range stochastic.
  const s = indicatorSeries(barsFromCloses(Array(20).fill(7)));
  assert.equal(s.rsi[19], 50);
});

test("relVol: current volume over the mean of the PREVIOUS 20 bars (2026-10-07 change)", () => {
  // 20 calm bars of 100 then a 1000 bar: relVol = 1000 / 100 = 10.
  // The prototype included the current bar: 1000 / ((19*100 + 1000)/20) = 6.896...
  const bars = randomWalk(MIN_BARS + 5).map((b) => ({ ...b, v: 100 }));
  bars[bars.length - 1] = { ...bars[bars.length - 1], v: 1000 };
  close(indicators(bars, "G").relVol, 10);
});

test("relVol: zero previous average falls back to 1 (prototype fallback kept)", () => {
  const bars = randomWalk(MIN_BARS + 5).map((b) => ({ ...b, v: 0 }));
  bars[bars.length - 1] = { ...bars[bars.length - 1], v: 50 };
  close(indicators(bars, "G").relVol, 1);
});

test("snapshotAt(series, i) equals indicators(bars.slice(0, i + 1)) without the chart", () => {
  const bars = randomWalk(260, 11);
  const s = indicatorSeries(bars);
  for (const i of [MIN_BARS - 1, 150, 200, 259]) {
    const { chart: _chart, ...full } = indicators(bars.slice(0, i + 1), "G");
    assert.deepEqual(snapshotAt(s, i), full, `index ${i}`);
  }
});

test("indicators() rejects series shorter than MIN_BARS", () => {
  assert.throws(() => indicators(randomWalk(MIN_BARS - 1), "G"), /en az 120 bar/);
});
