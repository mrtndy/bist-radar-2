/**
 * Shared pipeline tests (src/engine/evaluate.ts + src/engine/quality.ts): closed-bar signal
 * with live price, and the data-quality gates that move a symbol to the excluded list.
 *
 * What it does when run: builds a synthetic daily series ending on an in-progress bar, plus
 * hand-written quality reports (stale symbol, missing symbol, jumps inside and outside the
 * 70-bar lookback, a daily jump seen from the weekly scan), and checks each verdict.
 *
 * How to run it and see output:
 *   node --test tests/evaluate.test.ts
 *   # -> "# fail 0"
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateBars } from "../src/engine/evaluate.ts";
import { indicators } from "../src/engine/indicators.ts";
import type { QualityContext, QualityJump, QualityReport } from "../src/engine/quality.ts";
import { scoreOf } from "../src/engine/scoring.ts";
import type { Bar } from "../src/engine/types.ts";

const DAY = 86_400_000;
/** Istanbul midnight of 2026-10-07 (Yahoo's daily stamp) and the same day at 11:00. */
const TODAY = Date.UTC(2026, 9, 6, 21);
const MID_SESSION = TODAY + 11 * 3_600_000;
const EVENING = TODAY + 19 * 3_600_000;

/** 200 consecutive-day bars ending TODAY, gently trending, deterministic. */
function series(): Bar[] {
  const n = 200;
  return Array.from({ length: n }, (_, i) => {
    const c = 20 + Math.sin(i / 7) * 2 + i * 0.02;
    return { t: TODAY - (n - 1 - i) * DAY, o: c * 0.995, h: c * 1.01, l: c * 0.99, c, v: 1e5 + (i % 9) * 1e4 };
  });
}

/** Quality report with only the given sections filled. */
function report(over: Partial<QualityReport>): QualityReport {
  return { timeframe: "G", generatedAt: 0, newestBarAt: TODAY, newestSession: "2026-10-07", missing: [], stale: {}, jumps: {}, ...over };
}

const jump = (t: number, pct: number): QualityJump => ({ t, date: new Date(t + 3 * 3_600_000).toISOString().slice(0, 10), prevClose: 10, close: 10 * (1 + pct / 100), pct, kind: "sicrama" });

test("mid-session: signal from the previous closed bar, price and change from the live bar", () => {
  const bars = series();
  const ev = evaluateBars("TEST", bars, "G", MID_SESSION);
  assert.ok(ev.ok);
  assert.equal(ev.lastBarClosed, false);
  assert.equal(ev.signalAsOf, bars[bars.length - 2].t);
  assert.equal(ev.priceAsOf, bars[bars.length - 1].t);
  assert.equal(ev.price, bars[bars.length - 1].c);
  assert.ok(Math.abs(ev.chg - (bars[199].c / bars[198].c - 1) * 100) < 1e-12);
  // The score is exactly the score of the series without the live bar.
  assert.equal(ev.score, scoreOf(indicators(bars.slice(0, -1), "G"), "G").score);
});

test("after the close: the newest bar is the signal bar", () => {
  const bars = series();
  const ev = evaluateBars("TEST", bars, "G", EVENING);
  assert.ok(ev.ok);
  assert.equal(ev.lastBarClosed, true);
  assert.equal(ev.signalAsOf, ev.priceAsOf);
  assert.equal(ev.score, scoreOf(indicators(bars, "G"), "G").score);
});

test("dropping the live bar can push a short history below the warm-up: az-bar with the closed count", () => {
  const bars = series().slice(-120);
  const ev = evaluateBars("TEST", bars, "G", MID_SESSION);
  assert.equal(ev.ok, false);
  assert.ok(!ev.ok && ev.reason === "az-bar" && ev.bars === 119);
});

test("stale symbol from the report goes to the excluded list with a Turkish note", () => {
  const ctx: QualityContext = { own: report({ stale: { TEST: { lastBarAt: TODAY, lastSession: "2026-09-30", sessionsBehind: 5 } } }), daily: null };
  const ev = evaluateBars("TEST", series(), "G", EVENING, ctx);
  assert.ok(!ev.ok && ev.reason === "bayat-veri");
  assert.match(!ev.ok ? (ev.note ?? "") : "", /30\.09\.2026.*5 seans geride/);
});

test("symbol missing from this run (left-over file) is treated as stale", () => {
  const ev = evaluateBars("TEST", series(), "G", EVENING, { own: report({ missing: ["TEST"] }), daily: null });
  assert.ok(!ev.ok && ev.reason === "bayat-veri");
});

test("jump inside the 70-bar lookback excludes; an older jump does not", () => {
  const bars = series();
  const inside = { own: report({ jumps: { TEST: [jump(bars[180].t, -48.2)] } }), daily: null };
  const ev = evaluateBars("TEST", bars, "G", EVENING, inside);
  assert.ok(!ev.ok && ev.reason === "fiyat-sicramasi");
  assert.match(!ev.ok ? (ev.note ?? "") : "", /%-48,2/);
  const older = { own: report({ jumps: { TEST: [jump(bars[100].t, -48.2)] } }), daily: null };
  assert.equal(evaluateBars("TEST", bars, "G", EVENING, older).ok, true);
  const otherSymbol = { own: report({ jumps: { OTHER: [jump(bars[180].t, -48.2)] } }), daily: null };
  assert.equal(evaluateBars("TEST", bars, "G", EVENING, otherSymbol).ok, true);
});

test("jump on the live (in-progress) bar still excludes: the row would show the broken price", () => {
  const bars = series();
  const ctx = { own: report({ jumps: { TEST: [jump(bars[199].t, -72.3)] } }), daily: null };
  const ev = evaluateBars("TEST", bars, "G", MID_SESSION, ctx);
  assert.ok(!ev.ok && ev.reason === "fiyat-sicramasi");
});

test("weekly scan honours a daily-report jump inside its window", () => {
  const WEEK = 7 * DAY;
  const monday = Date.UTC(2026, 9, 4, 21); // 2026-10-05 00:00 Istanbul
  const weekly: Bar[] = Array.from({ length: 150 }, (_, i) => {
    const c = 30 + Math.cos(i / 5) * 3;
    return { t: monday - (149 - i) * WEEK, o: c, h: c * 1.03, l: c * 0.97, c, v: 1e6 };
  });
  // Daily jump on a Wednesday 10 weeks ago: inside the 70-week window.
  const wed = weekly[140].t + 2 * DAY;
  const ctx: QualityContext = { own: report({ timeframe: "H" }), daily: report({ jumps: { TEST: [jump(wed, -50)] } }) };
  const ev = evaluateBars("TEST", weekly, "H", monday + 6 * DAY, ctx);
  assert.ok(!ev.ok && ev.reason === "fiyat-sicramasi");
  assert.match(!ev.ok ? (ev.note ?? "") : "", /günlük veride/);
});

test("non-array or empty input is az-bar with zero bars", () => {
  for (const bad of [null, {}, []]) {
    const ev = evaluateBars("TEST", bad, "G", EVENING);
    assert.ok(!ev.ok && ev.reason === "az-bar" && ev.bars === 0 && ev.firstBarAt === null);
  }
});
