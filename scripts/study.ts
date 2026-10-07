/**
 * Forward-return study: does the BIST Radar score predict what the stock does next?
 *
 * What it does when run: reads every symbol's bars from data/bars/<TF>/, scores each closed
 * historical bar exactly as the live scan would have at that bar's close (see the no-look-
 * ahead argument in src/engine/study.ts), measures the close-to-close return over the next
 * h bars, and reports the results by score decile (cross-sectional, per day) and by signal
 * bucket (AL buy, NÖTR neutral, SAT sell): count, mean, median, hit rate (share of positive
 * returns) and mean excess return versus the equal-weight average of all scored symbols on
 * the same day. Prints tables; with --out also writes the full result as JSON.
 *
 * How to run it and see output:
 *   node scripts/study.ts --tf G                                  # daily, horizons 5 and 20
 *   node scripts/study.ts --tf G --out public/data/study.json     # same, plus JSON (CI uses this)
 *   node scripts/study.ts --tf H --horizons 1,4                   # weekly (1 and 4 weeks)
 *   # -> "Skor ondalık dilimleri, 5 bar ileri getiri" table, then the signal table, then the
 *   #    top-minus-bottom decile spread and the caveats
 *
 * Data rules (same as the live scan):
 *   - Closed bars only: an in-progress last bar is dropped (src/engine/bars.ts).
 *   - A score whose 70-bar lookback contains a suspected unadjusted corporate action, and a
 *     forward window that crosses one, are both skipped (src/engine/quality.ts). Without this
 *     a missed 2:1 split would count as a -50% "return".
 *
 * Settings: see the `arg(...)` lines below. To add a statistic, extend `bucketStats` in
 * src/engine/study.ts; to add a grouping (for example by sector), add a map next to `bySignal`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closedBars, istanbulDate, istanbulDayNumber, istanbulWeekday } from "../src/engine/bars.ts";
import { listBarFiles, loadQualityContext, readRunTimes, referenceNow } from "../src/engine/data-files.ts";
import { MIN_BARS } from "../src/engine/indicators.ts";
import { applicableJumps, JUMP_LOOKBACK_BARS } from "../src/engine/quality.ts";
import { SIGNAL_THRESHOLDS } from "../src/engine/scoring.ts";
import {
  anyTimeIn,
  bucketStats,
  decilesOf,
  forwardReturn,
  scoreHistory,
  type BucketStats,
} from "../src/engine/study.ts";
import type { Bar, Signal, Timeframe } from "../src/engine/types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DATA_DIR = path.join(ROOT, "data");

// ---- Settings (command-line flags) -------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
/** Timeframe to study: G (daily, default) or H (weekly). Hourly is left out on purpose: six
 * months of hourly bars with nine bars a day gives too few independent days to judge. */
const tf = arg("--tf", "G") as Timeframe;
if (tf !== "G" && tf !== "H") {
  console.error(`--tf G veya H olmalı (verilen: ${tf})`);
  process.exit(2);
}
/** Forward horizons in bars. Daily 5 and 20 sessions; weekly 1 and 4 weeks (same calendar span). */
const horizons = arg("--horizons", tf === "G" ? "5,20" : "1,4")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);
/** Optional JSON output path, relative to the repository root. Empty = print only. */
const outPath = arg("--out", "");

/** Nominal bar length, used to turn bar indexes into time windows for the jump checks. */
const SPAN_MS = tf === "G" ? 86_400_000 : 7 * 86_400_000;

// ---- Load data ---------------------------------------------------------------------------
const now = referenceNow(await readRunTimes(DATA_DIR, tf));
const quality = await loadQualityContext(DATA_DIR, tf);
const files = await listBarFiles(DATA_DIR, tf);

/** Calendar key of a bar: Istanbul day number (daily) or the Monday's day number (weekly). */
const dayKey = (t: number) => (tf === "G" ? istanbulDayNumber(t) : istanbulDayNumber(t) - istanbulWeekday(t));

/** One scored day of one symbol: forward returns per horizon (fractions; null = unavailable). */
interface Obs {
  day: number;
  score: number;
  signal: Signal;
  fwd: (number | null)[];
}

const observations: Obs[] = [];
/** Counters for what was left out, reported so the reader can judge the filter's weight. */
let symbolsUsed = 0;
let skippedLookbackJump = 0;
const skippedForwardJump = horizons.map(() => 0);

for (const f of files) {
  const symbol = f.replace(/\.json$/, "");
  let raw: Bar[];
  try {
    raw = JSON.parse(await readFile(path.join(DATA_DIR, "bars", tf, f), "utf8")) as Bar[];
  } catch {
    continue;
  }
  if (!Array.isArray(raw)) continue;
  const bars = closedBars(raw, tf, now).closed;
  if (bars.length < MIN_BARS) continue;
  symbolsUsed++;

  // Suspected-jump timestamps for this symbol, sorted for binary search.
  const jumps = applicableJumps(symbol, tf, quality)
    .map((j) => j.t)
    .sort((a, b) => a - b);

  for (const sb of scoreHistory(bars, tf)) {
    const lookStart = bars[Math.max(0, sb.i - (JUMP_LOOKBACK_BARS - 1))].t;
    if (anyTimeIn(jumps, lookStart, bars[sb.i].t + SPAN_MS)) {
      skippedLookbackJump++;
      continue;
    }
    const fwd = horizons.map((h, k) => {
      const r = forwardReturn(bars, sb.i, h);
      if (r === null) return null;
      // Forward window = bars i+1 .. i+h; skip it when a suspected jump lies inside.
      if (anyTimeIn(jumps, bars[sb.i].t + SPAN_MS, bars[sb.i + h].t + SPAN_MS)) {
        skippedForwardJump[k]++;
        return null;
      }
      return r;
    });
    observations.push({ day: dayKey(sb.t), score: sb.score, signal: sb.signal, fwd });
  }
}

// ---- Aggregate per horizon ---------------------------------------------------------------
interface DecileRow extends BucketStats {
  decile: number;
  scoreMin: number;
  scoreMax: number;
  scoreMean: number;
}
interface HorizonResult {
  horizon: number;
  days: number;
  observations: number;
  byDecile: DecileRow[];
  bySignal: Record<Signal, BucketStats>;
  spread: {
    /** Mean over days of (top-decile mean excess minus bottom-decile mean excess), percent. */
    meanDailySpread: number | null;
    /** Share of days where the top decile beat the bottom decile, percent. */
    daysPositivePct: number | null;
    days: number;
    /** Same mean over every h-th day only, so the forward windows do not overlap. */
    nonOverlapping: { meanDailySpread: number | null; days: number };
  };
}

const SIGNALS: Signal[] = ["AL", "NÖTR", "SAT"];

function aggregate(k: number): HorizonResult {
  const h = horizons[k];
  // Group observations that have this horizon's return by day.
  const byDay = new Map<number, Obs[]>();
  for (const o of observations) {
    if (o.fwd[k] === null) continue;
    let list = byDay.get(o.day);
    if (!list) byDay.set(o.day, (list = []));
    list.push(o);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);

  const decR: number[][] = Array.from({ length: 10 }, () => []);
  const decX: number[][] = Array.from({ length: 10 }, () => []);
  const decS: number[][] = Array.from({ length: 10 }, () => []);
  const sigR: Record<Signal, number[]> = { AL: [], NÖTR: [], SAT: [] };
  const sigX: Record<Signal, number[]> = { AL: [], NÖTR: [], SAT: [] };
  /** Per-day top-minus-bottom spread, keyed by position in `days`. */
  const spreads: { idx: number; v: number }[] = [];
  let nObs = 0;

  days.forEach((day, idx) => {
    const list = byDay.get(day) as Obs[];
    // Equal-weight benchmark: mean forward return of every scored symbol that day.
    const bench = list.reduce((s, o) => s + (o.fwd[k] as number), 0) / list.length;
    const dec = decilesOf(list.map((o) => o.score));
    const top: number[] = [];
    const bottom: number[] = [];
    list.forEach((o, j) => {
      const r = o.fwd[k] as number;
      const x = r - bench;
      nObs++;
      sigR[o.signal].push(r);
      sigX[o.signal].push(x);
      if (dec[j] >= 0) {
        decR[dec[j]].push(r);
        decX[dec[j]].push(x);
        decS[dec[j]].push(o.score);
        if (dec[j] === 9) top.push(x);
        if (dec[j] === 0) bottom.push(x);
      }
    });
    if (top.length && bottom.length) {
      const m = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
      spreads.push({ idx, v: m(top) - m(bottom) });
    }
  });

  const mean = (a: number[]) => (a.length ? (a.reduce((s, v) => s + v, 0) / a.length) * 100 : null);
  const nonOverlap = spreads.filter((s) => s.idx % h === 0);
  return {
    horizon: h,
    days: days.length,
    observations: nObs,
    byDecile: decR.map((r, d) => ({
      decile: d + 1,
      scoreMin: decS[d].length ? Math.min(...decS[d]) : NaN,
      scoreMax: decS[d].length ? Math.max(...decS[d]) : NaN,
      scoreMean: decS[d].length ? decS[d].reduce((s, v) => s + v, 0) / decS[d].length : NaN,
      ...bucketStats(r, decX[d]),
    })),
    bySignal: Object.fromEntries(SIGNALS.map((s) => [s, bucketStats(sigR[s], sigX[s])])) as Record<Signal, BucketStats>,
    spread: {
      meanDailySpread: mean(spreads.map((s) => s.v)),
      daysPositivePct: spreads.length ? (spreads.filter((s) => s.v > 0).length / spreads.length) * 100 : null,
      days: spreads.length,
      nonOverlapping: { meanDailySpread: mean(nonOverlap.map((s) => s.v)), days: nonOverlap.length },
    },
  };
}

const results = horizons.map((_, k) => aggregate(k));
const allDays = [...new Set(observations.map((o) => o.day))].sort((a, b) => a - b);
const dayToDate = (d: number) => istanbulDate(d * 86_400_000);

/** Caveats printed and written with every result (Turkish, the site's language). */
const caveats = [
  "Hayatta kalma yanlılığı: yalnızca BUGÜN işlem gören hisseler var; dönem içinde kottan çıkan/batan hisseler veride yok, getiriler iyimser olabilir.",
  `Örtüşen pencereler: her gün yeni bir ${horizons.join("/")} barlık pencere başlar, ardışık gözlemler bağımsız değildir; standart istatistik testleri geçersizdir. "Örtüşmesiz" satırı yalnızca her h. günü kullanır.`,
  tf === "G"
    ? "Kısa geçmiş: yaklaşık 2 yıllık günlük veri (120 bar ısınmadan sonra ~1,5 yıl skorlanabilir gün), tek bir piyasa rejimi."
    : "Haftalık veri ~10 yıl ama evren bugünkü listeler; eski yıllarda hisse sayısı az.",
  "İşlem maliyeti, kayma ve kapanıştan işlem varsayımı: sinyal t günü kapanışında bilinir ve kapanış fiyatından işlem yapıldığı varsayılır; komisyon/vergi yok.",
  "Kıyas: aynı gün skorlanan tüm hisselerin eşit ağırlıklı ortalaması (endeks değil).",
  "Yahoo verisi: şüpheli düzeltilmemiş kurumsal işlemler kalite raporuyla elendi, ama rapor her hatayı yakalamaz.",
];

// ---- Print -------------------------------------------------------------------------------
/** Calendar unit of one cross-section: a session (daily) or a week (weekly). */
const unit = tf === "G" ? "gün" : "hafta";
const pct = (v: number | null, w = 7) => (v == null ? "-" : (v >= 0 ? "+" : "") + v.toFixed(2)).padStart(w);
const num = (v: number, w = 7) => String(v).padStart(w);

console.log(
  `\nBIST Radar ileri getiri çalışması — ${tf === "G" ? "Günlük" : "Haftalık"}  |  ${symbolsUsed} hisse  |  ` +
    `${observations.length} skorlu gün-hisse  |  ${allDays.length ? `${dayToDate(allDays[0])} .. ${dayToDate(allDays[allDays.length - 1])}` : "-"}`,
);
console.log(
  `elenen: ${skippedLookbackJump} gözlem (pencerede şüpheli sıçrama)` +
    horizons.map((h, k) => `, ${skippedForwardJump[k]} adet ${h}-bar ileri pencere (sıçrama içeriyor)`).join(""),
);
for (const r of results) {
  console.log(`\nSkor ondalık dilimleri (${unit} içi kesit), ${r.horizon} bar ileri getiri — ${r.observations} gözlem, ${r.days} ${unit}`);
  console.log(" dilim   skor aralığı    adet   ort.%   medyan%  isabet%  fazla%");
  for (const d of r.byDecile) {
    console.log(
      `   ${String(d.decile).padStart(2)}   ${String(d.scoreMin).padStart(3)}-${String(d.scoreMax).padEnd(3)} (${d.scoreMean.toFixed(0).padStart(2)})` +
        `${num(d.count, 8)} ${pct(d.mean)} ${pct(d.median, 9)} ${(d.hitRate ?? 0).toFixed(1).padStart(8)} ${pct(d.meanExcess)}`,
    );
  }
  console.log(`  sinyal (AL >= ${SIGNAL_THRESHOLDS.buy}, SAT <= ${SIGNAL_THRESHOLDS.sell})`);
  for (const s of SIGNALS) {
    const b = r.bySignal[s];
    console.log(
      `   ${s.padEnd(5)}${" ".repeat(13)}${num(b.count, 8)} ${pct(b.mean)} ${pct(b.median, 9)} ${(b.hitRate ?? 0).toFixed(1).padStart(8)} ${pct(b.meanExcess)}`,
    );
  }
  console.log(
    `  en üst - en alt dilim fazla getiri farkı: ort. ${pct(r.spread.meanDailySpread, 0)} yüzde puan ` +
      `(${r.spread.days} ${unit}, %${(r.spread.daysPositivePct ?? 0).toFixed(1)}'inde pozitif); ` +
      `örtüşmesiz (her ${r.horizon}. ${unit}): ${pct(r.spread.nonOverlapping.meanDailySpread, 0)} (${r.spread.nonOverlapping.days} ${unit})`,
  );
}
console.log("\nUyarılar:");
for (const c of caveats) console.log("  - " + c);

// ---- Write JSON --------------------------------------------------------------------------
if (outPath) {
  const abs = path.resolve(ROOT, outPath);
  await mkdir(path.dirname(abs), { recursive: true });
  const body = {
    tf,
    generatedAt: Date.now(),
    evaluatedAt: now,
    horizons,
    thresholds: SIGNAL_THRESHOLDS,
    symbols: symbolsUsed,
    observations: observations.length,
    firstDay: allDays.length ? dayToDate(allDays[0]) : null,
    lastDay: allDays.length ? dayToDate(allDays[allDays.length - 1]) : null,
    skipped: {
      lookbackJump: skippedLookbackJump,
      forwardJump: Object.fromEntries(horizons.map((h, k) => [String(h), skippedForwardJump[k]])),
    },
    results,
    caveats,
  };
  await writeFile(abs, JSON.stringify(body, null, 1), "utf8");
  console.log(`\nJSON -> ${path.relative(ROOT, abs)}`);
}
