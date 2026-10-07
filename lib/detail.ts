/**
 * Sunucu tarafı hisse detay veri katmanı — SADECE Server Component / Route Handler /
 * plain Node script içinden içe aktarılmalı ("use client" bileşenlerinden DEĞİL):
 * `node:fs` kullanır. Kullanan: `scripts/build-static.ts` (statik
 * `public/data/detail/{SEMBOL}-{tf}.json` üretimi için).
 *
 * `lib/scan-data.ts`teki `computeRows` ile AYNI başarı/atlama kuralları kasıtlı olarak
 * burada da uygulanır (bar sayısı < MIN_BARS, indicators()/scoreOf() hata verirse,
 * fiyat/skor sonlu değilse -> atla): bir sembol tarama tablosunda bir satır olarak
 * görünüyorsa (yani tıklanabilirse) bu modül de aynı zaman dilimi için bir detay
 * dosyası üretebilmelidir — aksi hâlde tabloda tıklanan bir satırın karşılığında
 * detay JSON'ı bulunamaz. 2026-10-07: bu "aynı kural" artık kopya değil — iki modül de
 * `src/engine/evaluate.ts` `evaluateBars`i AYNI referans an ve AYNI kalite raporlarıyla
 * çağırır (kapanmış bar kuralı + bayat/sıçrama kapısı dahil). Göstergeler, skor ve grafik
 * kapanmış barlardan; `price`/`chg` en yeni bardan gelir.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { listBarFiles, loadQualityContext, readRunTimes, referenceNow } from "../src/engine/data-files.ts";
import { evaluateBars } from "../src/engine/evaluate.ts";
import type { QualityContext } from "../src/engine/quality.ts";
import type { Timeframe, UniverseEntry } from "../src/engine/types.ts";
import type { DetailData } from "./types";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");

let universeMapPromise: Promise<Map<string, UniverseEntry>> | null = null;

function getUniverseMap(): Promise<Map<string, UniverseEntry>> {
  if (!universeMapPromise) {
    universeMapPromise = readFile(path.join(DATA_DIR, "universe.json"), "utf8").then((raw) => {
      const entries = JSON.parse(raw) as UniverseEntry[];
      return new Map(entries.map((e) => [e.symbol, e]));
    });
  }
  return universeMapPromise;
}

/** tf -> {referans an, kalite raporları} — her sembol için dosyaları yeniden okumamak için
 * süreç ömrü boyunca önbellek (build-static tek koşuluk bir süreç, invalidation gerekmez). */
const contextCache = new Map<Timeframe, Promise<{ now: number; quality: QualityContext }>>();

function getEvalContext(tf: Timeframe): Promise<{ now: number; quality: QualityContext }> {
  let p = contextCache.get(tf);
  if (!p) {
    p = Promise.all([readRunTimes(DATA_DIR, tf), loadQualityContext(DATA_DIR, tf)]).then(([times, quality]) => ({
      now: referenceNow(times),
      quality,
    }));
    contextCache.set(tf, p);
  }
  return p;
}

/** `data/bars/{tf}` dizinindeki sembol listesi (uzantısız dosya adları, sırasız). */
export async function listSymbols(tf: Timeframe): Promise<string[]> {
  return (await listBarFiles(DATA_DIR, tf)).map((f) => f.replace(/\.json$/, ""));
}

/**
 * Bir sembol + zaman dilimi için detay panel verisini üretir.
 * Barlar eksik/kısa/dejenere ya da kalite kapısında elenmişse (`evaluateBars` — tarama
 * tablosuyla aynı kural) `null`.
 */
export async function getDetailData(symbol: string, tf: Timeframe): Promise<DetailData | null> {
  const barPath = path.join(DATA_DIR, "bars", tf, `${symbol}.json`);
  let bars: unknown;
  try {
    bars = JSON.parse(await readFile(barPath, "utf8"));
  } catch {
    return null;
  }
  const { now, quality } = await getEvalContext(tf);
  const ev = evaluateBars(symbol, bars, tf, now, quality);
  if (!ev.ok) return null;
  const { ind, score, breakdown, signal } = ev;

  const universe = await getUniverseMap();
  const u = universe.get(symbol);

  const detail: DetailData = {
    symbol,
    name: u?.name ?? symbol,
    sector: u?.sector ?? "Diğer",
    price: ev.price,
    chg: ev.chg,
    k: ind.k,
    d: ind.d,
    rsi: ind.rsi,
    atrPct: ind.atrPct,
    relVol: ind.relVol,
    pctB: ind.pctB,
    macd: ind.macd,
    msig: ind.msig,
    hist: ind.hist,
    crossDir: ind.crossDir,
    crossBars: ind.crossBars,
    volTL: ind.volTL,
    hi70: ind.hi70,
    lo70: ind.lo70,
    score,
    signal,
    breakdown,
    chart: ind.chart,
    signalAsOf: ev.signalAsOf,
    lastBarClosed: ev.lastBarClosed,
    priceAsOf: ev.priceAsOf,
  };
  return detail;
}
