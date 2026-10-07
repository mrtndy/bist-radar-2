/**
 * Gösterge motoru — `design_handoff_bist_radar/bist-data.js` içindeki `indicators()`
 * fonksiyonunun birebir portu. Matematik KASITLI olarak değiştirilmemiştir: prototipin
 * ürettiği skorlarla üretimin ürettiği skorlar aynı kalmalı (bkz. handoff README "birebir portla").
 *
 * Orijinalden sapmalar (hepsi kasıtlı, `scripts/parity.ts` her birini ayrı doğrular):
 * - Demo tarih üreteci `dateLabels()` yerine barların gerçek zaman damgaları etiketlenir.
 * - `relVol` (2026-10-07): 20 barlık hacim ortalaması artık MEVCUT barı İÇERMEZ — mevcut bar,
 *   kendisinden önceki 20 barın ortalamasıyla kıyaslanır. Eskisi patlayan hacmi kendi
 *   ortalamasına katarak oranı sistematik olarak küçültüyordu (ör. 20 sakin barın ardından
 *   10 katlık bar 10 değil 6,9 görünüyordu).
 * - Düz aralık stokastiği (2026-10-07): 14 barın en yükseği en düşüğüne eşitse (fiyat hiç
 *   oynamamış) ham %K artık 0 değil 50 (nötr). Eskisi 0 verip "aşırı satım" puanlıyordu.
 *
 * Yapı (2026-10-07): hesap iki adıma bölündü — `indicatorSeries()` tüm seriyi BİR KEZ
 * hesaplar, `snapshotAt()` herhangi bir `i` indeksindeki skalerleri okur. Her seri
 * nedenseldir (i'deki değer yalnızca 0..i barlarına bakar), bu yüzden `snapshotAt(seri, i)`,
 * `indicators(bars.slice(0, i + 1))` ile birebir aynıdır — `scripts/study.ts` bunu her gün
 * için yeniden hesaplamadan kullanır, `tests/study.test.ts` eşitliği ve ileriye bakmazlığı
 * doğrular. `indicators()` dışarıdan aynı imzayla çalışmaya devam eder.
 */
import type { Bar, ChartSeries, IndicatorSnapshot, Indicators, Timeframe } from "./types.ts";

/** Grafikte ve 70-bar aralığı hesabında kullanılan pencere. */
export const CHART_WINDOW = 70;

/** Göstergelerin ısınması + 70 barlık grafik için gereken asgari bar sayısı. */
export const MIN_BARS = 120;

const AY = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];

function sma(a: number[], n: number): (number | null)[] {
  const o: (number | null)[] = new Array(a.length).fill(null);
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i];
    if (i >= n) s -= a[i - n];
    if (i >= n - 1) o[i] = s / n;
  }
  return o;
}

function ema(a: number[], n: number): number[] {
  const o: number[] = new Array(a.length).fill(0);
  const k = 2 / (n + 1);
  let e = a[0];
  for (let i = 0; i < a.length; i++) {
    e = i === 0 ? a[0] : a[i] * k + e * (1 - k);
    o[i] = e;
  }
  return o;
}

/** Bar zaman damgalarını prototipteki etiket biçimine çevirir (Europe/Istanbul). */
function labelsFor(bars: Bar[], tfk: Timeframe): string[] {
  return bars.map((b) => {
    const d = new Date(b.t);
    const parts = new Intl.DateTimeFormat("tr-TR", {
      timeZone: "Europe/Istanbul",
      day: "numeric",
      month: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const day = get("day");
    const mon = AY[Number(get("month")) - 1] ?? "";
    return tfk === "S" ? `${day} ${mon} ${get("hour")}:${get("minute")}` : `${day} ${mon}`;
  });
}

/** Tüm barlar için bir kez hesaplanan gösterge serileri — her eleman yalnızca o indekse
 * kadarki barlara bakar (nedensel). `snapshotAt` ve grafik bu serilerden okur. */
export interface IndicatorSeries {
  C: number[];
  H: number[];
  L: number[];
  V: number[];
  macd: number[];
  sig: number[];
  hist: number[];
  rsi: (number | null)[];
  K: (number | null)[];
  D: (number | null)[];
  atr: (number | null)[];
  mid: (number | null)[];
  bbU: (number | null)[];
  bbL: (number | null)[];
  vs: (number | null)[];
}

export function indicatorSeries(bars: Bar[]): IndicatorSeries {
  const C = bars.map((b) => b.c);
  const H = bars.map((b) => b.h);
  const L = bars.map((b) => b.l);
  const V = bars.map((b) => b.v);
  const n = bars.length;

  const e12 = ema(C, 12);
  const e26 = ema(C, 26);
  const macd = C.map((_, i) => e12[i] - e26[i]);
  const sig = ema(macd, 9);
  const hist = macd.map((m, i) => m - sig[i]);

  const rsi: (number | null)[] = new Array(n).fill(null);
  let ag = 0;
  let al = 0;
  // Ne kazanç ne kayıp (fiyat hiç oynamamış): RSI tanımsız. Prototip bunu 0 ("aşırı satım",
  // +3 puan) sayıyordu; 2026-10-07'den beri nötr 50 — düz aralık stokastiğiyle aynı ilke.
  const rsiOf = (gain: number, loss: number) =>
    gain === 0 && loss === 0 ? 50 : 100 - 100 / (1 + gain / (loss || 1e-9));
  for (let i = 1; i < n; i++) {
    const ch = C[i] - C[i - 1];
    const g = Math.max(ch, 0);
    const ls = Math.max(-ch, 0);
    if (i <= 14) {
      ag += g / 14;
      al += ls / 14;
      if (i === 14) rsi[i] = rsiOf(ag, al);
    } else {
      ag = (ag * 13 + g) / 14;
      al = (al * 13 + ls) / 14;
      rsi[i] = rsiOf(ag, al);
    }
  }

  const Kraw: (number | null)[] = new Array(n).fill(null);
  for (let i = 13; i < n; i++) {
    let hh = -1e18;
    let ll = 1e18;
    for (let j = i - 13; j <= i; j++) {
      hh = Math.max(hh, H[j]);
      ll = Math.min(ll, L[j]);
    }
    // Düz aralık (hh === ll): fiyat 14 bar boyunca hiç oynamamış -> konum tanımsız, nötr 50
    // (prototip burada 0 verip "aşırı satım" puanlıyordu; bkz. dosya başı ve README).
    Kraw[i] = hh === ll ? 50 : (100 * (C[i] - ll)) / (hh - ll || 1e-9);
  }
  const smooth = (a: (number | null)[], m: number): (number | null)[] =>
    a.map((_, i) => {
      if (i < 13 + m - 1 || a[i] == null) return null;
      let s = 0;
      for (let j = 0; j < m; j++) s += a[i - j] as number;
      return s / m;
    });
  const K = smooth(Kraw, 3);
  const D = smooth(
    K.map((v) => (v == null ? 0 : v)),
    3,
  );

  const tr: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    tr[i] =
      i === 0
        ? H[0] - L[0]
        : Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
  }
  const atr: (number | null)[] = new Array(n).fill(null);
  let a14 = 0;
  for (let i = 0; i < n; i++) {
    if (i < 14) {
      a14 += tr[i] / 14;
      if (i === 13) atr[i] = a14;
    } else {
      a14 = (a14 * 13 + tr[i]) / 14;
      atr[i] = a14;
    }
  }

  const mid = sma(C, 20);
  const bbU: (number | null)[] = new Array(n).fill(null);
  const bbL: (number | null)[] = new Array(n).fill(null);
  for (let i = 19; i < n; i++) {
    let s = 0;
    for (let j = i - 19; j <= i; j++) s += (C[j] - (mid[i] as number)) ** 2;
    const sd = Math.sqrt(s / 20);
    bbU[i] = (mid[i] as number) + 2 * sd;
    bbL[i] = (mid[i] as number) - 2 * sd;
  }

  const vs = sma(V, 20);
  return { C, H, L, V, macd, sig, hist, rsi, K, D, atr, mid, bbU, bbL, vs };
}

/**
 * `i` indeksindeki (o barın kapanışındaki) gösterge skalerleri — yalnızca 0..i barlarına bakar.
 * `i >= MIN_BARS - 1` olmalı (ısınma); `indicators()` ve `scripts/study.ts` bunu garanti eder.
 */
export function snapshotAt(s: IndicatorSeries, i: number): IndicatorSnapshot {
  const { C, H, L, V, macd, sig, hist, rsi, K, D, atr, bbU, bbL, vs } = s;

  let crossDir = 0;
  let crossBars = 99;
  for (let j = i; j > 0; j--) {
    const s1 = Math.sign(macd[j] - sig[j]);
    const s0 = Math.sign(macd[j - 1] - sig[j - 1]);
    if (s1 !== s0 && s1 !== 0) {
      crossDir = s1;
      crossBars = i - j;
      break;
    }
  }

  // 70 barlık aralık penceresinin başı (i dahil son CHART_WINDOW bar).
  const w0 = i + 1 - CHART_WINDOW;
  return {
    price: C[i],
    chg: (C[i] / C[i - 1] - 1) * 100,
    k: K[i] as number,
    d: D[i] as number,
    rsi: rsi[i] as number,
    atrPct: ((atr[i] as number) / C[i]) * 100,
    // Önceki 20 barın ortalaması: vs[i - 1] = SMA20(V[i-20..i-1]); mevcut bar paydaya girmez
    // (prototipte vs[i] idi, bkz. dosya başı). Sıfır ortalamada prototipin geri düşüşü korunur.
    relVol: V[i] / ((vs[i - 1] as number) || V[i]),
    pctB: (C[i] - (bbL[i] as number)) / ((bbU[i] as number) - (bbL[i] as number) || 1e-9),
    macd: macd[i],
    msig: sig[i],
    hist: hist[i],
    histRising: hist[i] > hist[i - 1],
    kRising: (K[i] as number) > (K[i - 1] as number),
    crossDir,
    crossBars,
    volTL: V[i] * C[i],
    hi70: Math.max(...H.slice(w0, i + 1)),
    lo70: Math.min(...L.slice(w0, i + 1)),
  };
}

export function indicators(bars: Bar[], tfk: Timeframe): Indicators {
  if (bars.length < MIN_BARS) {
    throw new Error(`indicators(): en az ${MIN_BARS} bar gerekli, ${bars.length} geldi`);
  }
  const series = indicatorSeries(bars);
  const { K, D, macd, sig, hist, bbU, mid, bbL, vs } = series;
  const s0 = bars.length - CHART_WINDOW;
  const chart: ChartSeries = {
    bars: bars.slice(s0),
    K: K.slice(s0),
    D: D.slice(s0),
    macd: macd.slice(s0),
    sig: sig.slice(s0),
    hist: hist.slice(s0),
    bbU: bbU.slice(s0),
    bbM: mid.slice(s0),
    bbL: bbL.slice(s0),
    // Grafik çizgisi klasik SMA20'dir (mevcut bar dahil) — relVol paydasından bilerek farklı.
    volSMA: vs.slice(s0),
    labels: labelsFor(bars.slice(s0), tfk),
  };
  return { ...snapshotAt(series, bars.length - 1), chart };
}
