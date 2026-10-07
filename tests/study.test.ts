/**
 * Forward-return study tests (src/engine/study.ts): the no-look-ahead guarantee and the
 * small statistics helpers.
 *
 * What it does when run:
 *   1. Checks that the score the study assigns to bar t equals the score a fresh scan of
 *      bars 0..t gives (so computing the indicator series once is legitimate).
 *   2. Rewrites every bar after t with different random data and checks that no score at or
 *      before t moves (the formal "no look-ahead" property).
 *   3. Checks the decile, bucket-statistics and time-window helpers on hand-made inputs.
 *
 * How to run it and see output:
 *   node --test tests/study.test.ts
 *   # -> "# fail 0"
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { indicators, MIN_BARS } from "../src/engine/indicators.ts";
import { scoreOf } from "../src/engine/scoring.ts";
import { anyTimeIn, bucketStats, decilesOf, forwardReturn, scoreHistory } from "../src/engine/study.ts";
import type { Bar } from "../src/engine/types.ts";

/** Deterministic pseudo-random generator (mulberry32). */
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

/** Random-walk bars starting at index `from` of `base` (or fresh when base is empty). */
function walk(n: number, seed: number, base: Bar[] = []): Bar[] {
  const r = rng(seed);
  const out = base.slice();
  let p = out.length ? out[out.length - 1].c : 40;
  while (out.length < n) {
    const i = out.length;
    const c = p * (1 + (r() - 0.5) * 0.05);
    out.push({ t: Date.UTC(2025, 0, 1) + i * 86_400_000, o: p, h: Math.max(p, c) * (1 + r() * 0.01), l: Math.min(p, c) * (1 - r() * 0.01), c, v: 1e5 * (0.3 + r() * 2) });
    p = c;
  }
  return out;
}

test("scoreHistory starts at the first fully warmed-up bar", () => {
  const h = scoreHistory(walk(MIN_BARS + 3, 1), "G");
  assert.equal(h.length, 4);
  assert.equal(h[0].i, MIN_BARS - 1);
  assert.deepEqual(scoreHistory(walk(MIN_BARS - 1, 1), "G"), []);
});

test("score at t from the one-pass series equals a fresh scan of bars 0..t", () => {
  const bars = walk(320, 2);
  const hist = scoreHistory(bars, "G");
  for (const sb of hist.filter((_, k) => k % 17 === 0)) {
    const fresh = scoreOf(indicators(bars.slice(0, sb.i + 1), "G"), "G").score;
    assert.equal(sb.score, fresh, `bar ${sb.i}`);
  }
});

test("no look-ahead: rewriting every bar after t never changes any score at or before t", () => {
  const bars = walk(300, 3);
  const before = scoreHistory(bars, "G");
  for (const cut of [MIN_BARS - 1, 160, 230, 298]) {
    // Keep bars 0..cut, replace everything after with an unrelated walk (seeded by cut).
    const altered = walk(300, 1000 + cut, bars.slice(0, cut + 1));
    // Make the future wildly different on purpose: a crash and a volume spike.
    for (let i = cut + 1; i < altered.length; i++) altered[i] = { ...altered[i], c: altered[i].c * 0.3, v: altered[i].v * 50 };
    const after = scoreHistory(altered, "G");
    for (let k = 0; k < before.length && before[k].i <= cut; k++) {
      assert.equal(after[k].score, before[k].score, `cut ${cut}, bar ${before[k].i}`);
      assert.equal(after[k].signal, before[k].signal);
    }
    // Sanity: the future really did change something (otherwise the test proves nothing).
    if (cut < 290) assert.ok(after.some((s, k) => s.i > cut && s.score !== before[k].score), `cut ${cut}`);
  }
});

test("forwardReturn: close-to-close over h bars, null past the end", () => {
  const bars = [10, 11, 12.1].map((c, i) => ({ t: i, o: c, h: c, l: c, c, v: 1 }));
  assert.ok(Math.abs((forwardReturn(bars, 0, 2) as number) - 0.21) < 1e-12);
  assert.equal(forwardReturn(bars, 1, 2), null);
});

test("decilesOf: ties share a decile, order 0 (lowest) to 9 (highest), fewer than 10 -> -1", () => {
  assert.deepEqual(decilesOf([1, 2, 3]), [-1, -1, -1]);
  assert.deepEqual(decilesOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // 20 values, 10 tied at 50 in the middle: the tie group sits in one decile.
  const d = decilesOf([...Array.from({ length: 5 }, (_, i) => i), ...Array(10).fill(50), ...Array.from({ length: 5 }, (_, i) => 90 + i)]);
  assert.equal(new Set(d.slice(5, 15)).size, 1);
  assert.equal(d[0], 0);
  assert.equal(d[19], 9);
});

test("bucketStats: mean, median, hit rate and excess in percent", () => {
  const s = bucketStats([0.1, -0.02, 0.04, 0], [0.05, -0.05, 0, 0]);
  assert.equal(s.count, 4);
  assert.ok(Math.abs((s.mean as number) - 3) < 1e-9);
  assert.ok(Math.abs((s.median as number) - 2) < 1e-9);
  assert.equal(s.hitRate, 50);
  assert.ok(Math.abs(s.meanExcess as number) < 1e-12);
  assert.equal(bucketStats([], []).mean, null);
});

test("anyTimeIn: half-open window [from, to)", () => {
  const times = [10, 20, 30];
  assert.equal(anyTimeIn(times, 11, 20), false);
  assert.equal(anyTimeIn(times, 11, 21), true);
  assert.equal(anyTimeIn(times, 30, 31), true);
  assert.equal(anyTimeIn(times, 31, 99), false);
  assert.equal(anyTimeIn([], 0, 99), false);
});
