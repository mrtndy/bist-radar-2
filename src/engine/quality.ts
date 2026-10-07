/**
 * Data-quality gate: turns the ingest's per-timeframe quality report
 * (`data/bars/<TF>.quality.json`, written by `ingest/ingest.py`) into a per-symbol verdict:
 * either "fine, score it" or "exclude it, with this Turkish reason".
 *
 * Why this exists: a stale symbol (no new bars for several sessions) or a bar series with an
 * unadjusted corporate action (bonus issue, split, rights issue; Yahoo misses some of these)
 * produces indicator values that look like real moves. A 2:1 split that Yahoo did not adjust
 * reads as a -50% crash: RSI collapses, the Bollinger band breaks, and the score says AL or
 * SAT for a reason that does not exist. Such symbols go to the existing "elenen hisseler"
 * (excluded symbols) list instead of receiving a signal; the AL/SAT labels themselves are
 * unchanged (Mert's ruling).
 *
 * What it does when run: nothing on its own; pure functions, no file access (the loader lives
 * in `src/engine/data-files.ts`). Used by `src/engine/evaluate.ts` and `scripts/study.ts`.
 *
 * How to see it work:
 *   node --test tests/quality.test.ts
 *   ./.venv/Scripts/python ingest/ingest.py --timeframe G   # writes data/bars/G.quality.json
 *   node scripts/scan.ts --tf G                             # prints the exclusion counts
 */
import { CHART_WINDOW } from "./indicators.ts";
import { istanbulDate } from "./bars.ts";
import type { Bar, Timeframe } from "./types.ts";

/** One suspected jump as the ingest writes it (see `find_jumps` in ingest/ingest.py). */
export interface QualityJump {
  /** Bar start of the bar whose close jumped, epoch milliseconds. */
  t: number;
  /** Istanbul date "YYYY-MM-DD" of that bar. */
  date: string;
  /** Reference close (previous bar, or for hourly the previous session's last close). */
  prevClose: number;
  close: number;
  /** Percent move from `prevClose` to `close`; null when the reference was not positive. */
  pct: number | null;
  /** Sessions spanned by the move (the bound is (1 + 11%)^sessions). Optional for old reports. */
  sessions?: number;
  /** "sicrama" (jump outside the price-limit bound) or "gecersiz-fiyat" (zero/negative close). */
  kind: string;
  /** Yahoo's own split ratio when Yahoo lists a split within 3 days, else null. */
  yahooSplit?: number | null;
}

/** One stale symbol as the ingest writes it. */
export interface QualityStale {
  lastBarAt: number;
  lastSession: string;
  /** Calendar sessions (weeks for H) after the symbol's last bar. */
  sessionsBehind: number;
}

/** The subset of `data/bars/<TF>.quality.json` this gate reads; extra fields are ignored. */
export interface QualityReport {
  timeframe: Timeframe;
  generatedAt: number;
  newestBarAt: number | null;
  newestSession: string | null;
  /** Symbols requested but not returned by Yahoo in this run. */
  missing: string[];
  stale: Record<string, QualityStale>;
  jumps: Record<string, QualityJump[]>;
}

/**
 * Reports that apply to one timeframe's scan. `daily` is the G report: weekly and hourly bars
 * also honour daily jumps, because the weekly rule is loose (a 50% bonus issue can stay inside
 * five sessions of price limits) and an hourly lookback can contain a daily-detected event.
 */
export interface QualityContext {
  own: QualityReport | null;
  daily: QualityReport | null;
}

/** No report at all: the gate lets everything through (old data, or a run without ingest). */
export const NO_QUALITY: QualityContext = { own: null, daily: null };

/**
 * How many of the newest closed bars count as the "indicator lookback" for the jump check.
 * 70 = the chart window. The longest memories in the score (the 26-bar exponential moving
 * average (EMA) inside the Moving Average Convergence Divergence (MACD), and Wilder's 14-bar
 * RSI and ATR smoothing) keep under 0.5% of an event's weight after 70 bars ((25/27)^70 is
 * about 0.005), so an older jump no longer moves the score in a meaningful way.
 */
export const JUMP_LOOKBACK_BARS = CHART_WINDOW;

/** Nominal length of one bar, used to decide whether a timestamp falls inside the newest bar. */
const BAR_SPAN_MS: Record<Timeframe, number> = {
  G: 24 * 60 * 60 * 1000,
  H: 7 * 24 * 60 * 60 * 1000,
  S: 60 * 60 * 1000,
};

/** Exclusion reasons produced here (a subset of `ExclusionReason` in evaluate.ts). */
export type QualityReason = "bayat-veri" | "fiyat-sicramasi";

export interface QualityVerdict {
  reason: QualityReason;
  /** Turkish one-sentence explanation shown in the excluded list (see lib/excluded.ts). */
  note: string;
}

/** Turkish decimal formatting with one decimal place: 48.25 -> "48,3". */
const tr1 = (x: number): string => x.toFixed(1).replace(".", ",");

/** "2026-10-07" -> "07.10.2026" (the date style used elsewhere in the UI). */
function trDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${d}.${m}.${y}`;
}

/**
 * Jumps that fall inside the window [first lookback bar start, newest closed bar end).
 * Exported for the study, which asks the same question for every historical day.
 */
export function jumpsInWindow(
  jumps: readonly QualityJump[],
  windowStart: number,
  windowEndExclusive: number,
): QualityJump[] {
  return jumps.filter((j) => j.t >= windowStart && j.t < windowEndExclusive);
}

/** All jump events that apply to `symbol` on timeframe `tf`, own report first, then daily. */
export function applicableJumps(symbol: string, tf: Timeframe, ctx: QualityContext): QualityJump[] {
  const own = ctx.own?.jumps[symbol] ?? [];
  if (tf === "G" || !ctx.daily) return own;
  return [...own, ...(ctx.daily.jumps[symbol] ?? [])];
}

/**
 * Decide whether `symbol` may be scored on `closed` (the closed bars, oldest first).
 * `newestBarT` is the start of the newest bar INCLUDING an in-progress one: a jump inside the
 * live bar does not touch the closed-bar signal, but the row would still show its broken price
 * and change (for example -72% on a bonus-issue day), so the window runs up to that bar.
 * Returns null when it may; otherwise the exclusion reason and a Turkish note.
 * Order: stale first (a stale series cannot say anything current), then jumps.
 * To add a new gate (for example "too many gaps"), add a reason to `QualityReason`, a branch
 * here, a label in lib/excluded.ts `REASON_LABEL`, and a sentence in `excludedReasonText`.
 */
export function qualityVerdict(
  symbol: string,
  closed: readonly Bar[],
  tf: Timeframe,
  ctx: QualityContext,
  newestBarT?: number,
): QualityVerdict | null {
  const own = ctx.own;
  if (own) {
    if (own.missing.includes(symbol)) {
      return {
        reason: "bayat-veri",
        note: "Bu koşuda Yahoo'dan veri inmedi; diskteki barlar önceki bir koşudan kalma.",
      };
    }
    const st = own.stale[symbol];
    if (st) {
      const unit = tf === "H" ? "hafta" : "seans";
      return {
        reason: "bayat-veri",
        note:
          `Son bar ${trDate(st.lastSession)}; bu koşudaki en yeni ${unit} ` +
          `${own.newestSession ? trDate(own.newestSession) : "?"} — ${st.sessionsBehind} ${unit} geride. ` +
          `Hisse işlem görmüyor (durdurma, kottan çıkma) ya da Yahoo verisi eksik olabilir.`,
      };
    }
  }

  if (closed.length === 0) return null;
  const startIdx = Math.max(0, closed.length - JUMP_LOOKBACK_BARS);
  const windowStart = closed[startIdx].t;
  const windowEnd = Math.max(closed[closed.length - 1].t, newestBarT ?? -Infinity) + BAR_SPAN_MS[tf];
  const hits = jumpsInWindow(applicableJumps(symbol, tf, ctx), windowStart, windowEnd);
  if (hits.length === 0) return null;

  // Report the most recent event; mention how many there are when more than one.
  const j = hits.reduce((a, b) => (b.t > a.t ? b : a));
  const move = j.pct == null ? "geçersiz (sıfır/negatif) kapanış" : `kapanıştan kapanışa %${tr1(j.pct)} hareket`;
  const more = hits.length > 1 ? ` (bu pencerede toplam ${hits.length} olay)` : "";
  const fromDaily = tf !== "G" && (ctx.own?.jumps[symbol] ?? []).indexOf(j) < 0 ? " günlük veride" : "";
  return {
    reason: "fiyat-sicramasi",
    note:
      `${trDate(j.date || istanbulDate(j.t))} tarihinde${fromDaily} ${move}${more}: BIST ±%10 fiyat marjının ` +
      `dışında — düzeltilmemiş bedelsiz/bölünme/bedelli ya da veri hatası olabilir. Bu bar ` +
      `göstergelerin son ${JUMP_LOOKBACK_BARS} barlık penceresinden çıkana kadar sinyal verilmez.`,
  };
}
