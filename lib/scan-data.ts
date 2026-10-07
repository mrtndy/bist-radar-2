/**
 * Sunucu tarafı veri katmanı — SADECE Server Component / Route Handler / plain
 * Node script içinden içe aktarılmalı ("use client" bileşenlerinden DEĞİL):
 * `node:fs` kullanır. Kullananlar: `app/page.tsx` (ilk G verisini gömmek için)
 * ve `scripts/build-static.ts` (statik `public/data/scan-*.json` üretimi için).
 *
 * `scripts/scan.ts` ile aynı mantık (barları oku -> motoru çağır -> satır üret),
 * farkı: süreç içi önbellek + zaman dilimi başına barların mtime imzasıyla
 * geçersizleştirme (bkz. tasks/01-nextjs-ui.md "Kapsam" §2). Motor dosyalarına
 * (`src/engine/**`) dokunulmaz, yalnızca içe aktarılır.
 *
 * 2026-10-07: sembol başına mantık (kapanmış bar kuralı + veri kalitesi kapısı + motor)
 * artık `src/engine/evaluate.ts` `evaluateBars` içinde TEK kopya — `lib/detail.ts` ve
 * `scripts/scan.ts` de aynısını çağırır. Sinyal/skor/göstergeler kapanmış barlardan,
 * `price`/`chg` en yeni (seans içi olabilir) bardan gelir.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { listBarFiles, loadQualityContext, readRunTimes, referenceNow } from "../src/engine/data-files.ts";
import { evaluateBars } from "../src/engine/evaluate.ts";
import { MIN_BARS } from "../src/engine/indicators.ts";
import type { ScoreComponent, Timeframe, UniverseEntry } from "../src/engine/types.ts";
import type { ExcludedEntry, RowData, ScanResult } from "./types";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const NEWS_COUNTS_PATH = path.join(ROOT, "public", "data", "news", "_counts.json");

/** Sırayla TÜM zaman dilimleri — `getExcludedRows`teki çapraz-dilim "başka nerede mevcut" kontrolü için. */
const ALL_TFS: readonly Timeframe[] = ["G", "H", "S"];

/** `ExcludedEntry`nin `availableIn` alanı HARİÇ geri kalanı — bu, tek bir `tf` için ucuzca
 * hesaplanabilir/önbelleklenebilir; `availableIn` ise DİĞER dilimlerin taranmış satırlarına
 * bakmayı gerektirir, bu yüzden yalnızca `getExcludedRows` çağrıldığında (istek üzerine)
 * sonradan eklenir (bkz. aşağısı) — sayfaya gömülmeyen, istek üzerine indirilen tek şey bu
 * değil elbette (tasks/09 "Sert kısıtlar"), ama iç önbellek bu ayrımı yine de yapıyor ki
 * `computeScan` tek bir dilimin dosyalarını okuyarak çalışmaya devam etsin. */
type ExcludedEntryBase = Omit<ExcludedEntry, "availableIn">;

interface CacheEntry {
  fingerprint: string;
  rows: RowData[];
  excluded: ExcludedEntryBase[];
  fetchedAt: number | null;
  /** Kapanmış bar kararının referans anı (ingest başlangıcı). */
  evaluatedAt: number;
  /** Kalite raporu bulundu mu (yoksa kapı devre dışı). */
  qualityChecked: boolean;
}

const scanCache = new Map<Timeframe, CacheEntry>();
let universePromise: Promise<UniverseEntry[]> | null = null;
let sectorsPromise: Promise<string[]> | null = null;
let newsCountsPromise: Promise<Record<string, number>> | null = null;

function getUniverse(): Promise<UniverseEntry[]> {
  if (!universePromise) {
    universePromise = readFile(path.join(DATA_DIR, "universe.json"), "utf8").then(
      (raw) => JSON.parse(raw) as UniverseEntry[],
    );
  }
  return universePromise;
}

function getSectorList(): Promise<string[]> {
  if (!sectorsPromise) {
    sectorsPromise = getUniverse().then((universe) => {
      const set = new Set(universe.map((u) => u.sector));
      return [...set].sort((a, b) => a.localeCompare(b, "tr"));
    });
  }
  return sectorsPromise;
}

/**
 * HABER kolonu için sembol -> son 7 gündeki KAP bildirim sayısı (bkz.
 * tasks/05-kap-haberler.md §C). `scripts/build-news.ts` üretir
 * (`public/data/news/_counts.json`); o script henüz hiç çalışmadıysa (ör. yerel
 * geliştirmede `build:news` atlanmışsa) dosya yoktur ve burada BOŞ MAP'e düşülür —
 * derleme bu yüzden hiçbir zaman bozulmaz, kolon yalnızca 0 gösterir. İki üretim
 * script'i (`build:news`, `build:data`) arasında sıra bağımlılığı YOKTUR: hangisi
 * önce çalışırsa çalışsın derleme başarılı olur, yalnızca `build:news` HENÜZ
 * çalışmamışsa sayaçlar bir sonraki derlemeye kadar 0 kalır.
 */
function getNewsCounts(): Promise<Record<string, number>> {
  if (!newsCountsPromise) {
    newsCountsPromise = readFile(NEWS_COUNTS_PATH, "utf8")
      .then((raw) => JSON.parse(raw) as Record<string, number>)
      .catch(() => ({}));
  }
  return newsCountsPromise;
}

/**
 * Mobil kart listesindeki tek satırlık gerekçe (bkz. tasks/04-mobil-gorunum.md §B,
 * `RowData.topReason`) — en güçlü (|p| en büyük) skor bileşeninin motor metni.
 * Skor burada YENİDEN HESAPLANMAZ; `scoreOf()`'un zaten ürettiği `breakdown`
 * dizisinden en etkili bileşen seçilir (eşitlikte dizideki ilk bileşen kazanır).
 */
function topReasonOf(breakdown: ScoreComponent[]): string {
  if (breakdown.length === 0) return "";
  let top = breakdown[0];
  for (const c of breakdown) {
    if (Math.abs(c.p) > Math.abs(top.p)) top = c;
  }
  return top.n;
}

/** Bar dizinindeki her dosyanın mtime'ını okuyup tekil bir imza üretir — içerik değişmediyse önbellek geçerli kalır. */
async function fingerprintDir(dir: string, files: string[]): Promise<string> {
  const stats = await Promise.all(
    files.map(async (f) => {
      const st = await stat(path.join(dir, f));
      return `${f}:${st.mtimeMs}:${st.size}`;
    }),
  );
  stats.sort();
  return stats.join("|");
}

/**
 * Bar dosyalarını okuyup hem satırları HEM de elenen sembolleri üretir (bkz.
 * tasks/09-eleme-gorunurlugu.md §A — `computeRows` eskiden bunları sessizce `continue`
 * ile atlıyordu). Kapı sırası: parse -> (evaluateBars:) kapanmış bar sayısı -> veri kalitesi
 * (bayat / fiyat sıçraması) -> motor. Her elemede NEDEN kaydedilir. MIN_BARS burada
 * DEĞİŞTİRİLMEZ, yalnızca motordan içe aktarılan sabit karşılaştırma için kullanılır.
 * `now` = kapanmış bar kararının referans anı (bkz. `referenceNow`).
 */
async function computeScan(
  tf: Timeframe,
  barDir: string,
  files: string[],
  now: number,
): Promise<{ rows: RowData[]; excluded: ExcludedEntryBase[]; qualityChecked: boolean }> {
  const universe = await getUniverse();
  const meta = new Map(universe.map((u) => [u.symbol, u]));
  const newsCounts = await getNewsCounts();
  const quality = await loadQualityContext(DATA_DIR, tf);
  const rows: RowData[] = [];
  const excluded: ExcludedEntryBase[] = [];
  const seen = new Set<string>();

  for (const f of files) {
    const symbol = f.replace(/\.json$/, "");
    seen.add(symbol);
    const u = meta.get(symbol);
    const name = u?.name ?? symbol;

    let bars: unknown;
    try {
      bars = JSON.parse(await readFile(path.join(barDir, f), "utf8"));
    } catch {
      // Dosya var ama okunamadı/bozuk JSON — en yakın sebep kodu "veri-yok".
      excluded.push({ symbol, name, bars: 0, minBars: MIN_BARS, reason: "veri-yok", firstBarAt: null });
      continue;
    }

    const ev = evaluateBars(symbol, bars, tf, now, quality);
    if (!ev.ok) {
      excluded.push({
        symbol,
        name,
        bars: ev.bars,
        minBars: MIN_BARS,
        reason: ev.reason,
        firstBarAt: ev.firstBarAt,
        ...(ev.note ? { note: ev.note } : {}),
      });
      continue;
    }
    const { ind, score, breakdown, signal } = ev;
    rows.push({
      symbol,
      name,
      sector: u?.sector ?? "Diğer",
      price: ev.price,
      chg: ev.chg,
      score,
      signal,
      k: ind.k,
      d: ind.d,
      rsi: ind.rsi,
      atrPct: ind.atrPct,
      relVol: ind.relVol,
      pctB: ind.pctB,
      hist: ind.hist,
      // Sinyal barının kendi fiyatına oran (canlı fiyata değil) — gösterge ile aynı bar.
      histPct: (ind.hist / ind.price) * 100,
      volTL: ind.volTL,
      topReason: topReasonOf(breakdown),
      newsCount: newsCounts[symbol] ?? 0,
      signalAsOf: ev.signalAsOf,
      lastBarClosed: ev.lastBarClosed,
      priceAsOf: ev.priceAsOf,
    });
  }

  // Evrende olup bu dilim için hiç bar dosyası olmayan semboller de "veri-yok" (görev §A
  // son cümlesi) — yukarıdaki döngü yalnızca VAR OLAN dosyaları görür, bu yüzden ayrı geçiş.
  for (const u of universe) {
    if (seen.has(u.symbol)) continue;
    excluded.push({ symbol: u.symbol, name: u.name, bars: 0, minBars: MIN_BARS, reason: "veri-yok", firstBarAt: null });
  }

  rows.sort((a, b) => a.symbol.localeCompare(b.symbol, "tr"));
  excluded.sort((a, b) => a.symbol.localeCompare(b.symbol, "tr"));
  return { rows, excluded, qualityChecked: quality.own !== null };
}

/** Bar dizini fingerprint'ine göre önbellekli hesaplama — `getScanRows`/`getExcludedRows`
 * ORTAK bu fonksiyonu kullanır, dosyalar tek seferde okunur/hesaplanır. */
async function ensureComputed(tf: Timeframe): Promise<CacheEntry> {
  const barDir = path.join(DATA_DIR, "bars", tf);
  const files = await listBarFiles(DATA_DIR, tf);
  const fingerprint = await fingerprintDir(barDir, files);

  const cached = scanCache.get(tf);
  if (cached && cached.fingerprint === fingerprint) return cached;

  const times = await readRunTimes(DATA_DIR, tf);
  const evaluatedAt = referenceNow(times);
  const { rows, excluded, qualityChecked } = await computeScan(tf, barDir, files, evaluatedAt);
  const entry: CacheEntry = { fingerprint, rows, excluded, fetchedAt: times.fetchedAt, evaluatedAt, qualityChecked };
  scanCache.set(tf, entry);
  return entry;
}

/** Bir zaman dilimi için tarama satırlarını döner; bar dosyaları değişmediyse önbellekten. */
export async function getScanRows(tf: Timeframe): Promise<ScanResult> {
  const { rows, fetchedAt, evaluatedAt, qualityChecked } = await ensureComputed(tf);
  const sectors = await getSectorList();
  // Dosya düzeyi özet: satırların ÇOĞUNLUĞUNUN sinyal barı (en sık `signalAsOf`) ve o
  // çoğunluğun son barının kapanmış olup olmadığı. En büyük değer değil en sık değer: birkaç
  // hissenin barı farklı olabilir (ör. Yahoo 2026-10-06 günlük satırını çoğu hissede düşürdü).
  const freq = new Map<number, number>();
  for (const r of rows) freq.set(r.signalAsOf, (freq.get(r.signalAsOf) ?? 0) + 1);
  let signalAsOf: number | null = null;
  for (const [t, c] of freq) if (signalAsOf === null || c > (freq.get(signalAsOf) ?? 0)) signalAsOf = t;
  const openCount = rows.filter((r) => !r.lastBarClosed).length;
  return {
    rows,
    total: rows.length,
    fetchedAt,
    sectors,
    signalAsOf,
    lastBarClosed: rows.length ? openCount * 2 <= rows.length : null,
    evaluatedAt,
    qualityChecked,
  };
}

/**
 * Bir zaman diliminde elenen (taranamayan) sembolleri döner — `public/data/
 * excluded-{tf}.json` içeriği (bkz. `scripts/build-static.ts`). Her girdiye, sembolün
 * BAŞARIYLA tarandığı DİĞER dilimler (`availableIn`) de eklenir — bunun için diğer iki
 * dilimin `getScanRows`u çağrılır (zaten önbellekli; `scripts/build-static.ts` bu
 * fonksiyonu çağırmadan ÖNCE üç dilimi de bir kez hesapladığı için ekstra dosya okuması
 * OLMAZ) — tasks/09-eleme-gorunurlugu.md §B'deki "başka dilime geç" düğmesi bunu kullanır.
 */
export async function getExcludedRows(tf: Timeframe): Promise<ExcludedEntry[]> {
  const { excluded } = await ensureComputed(tf);
  if (excluded.length === 0) return [];

  const otherTfs = ALL_TFS.filter((t) => t !== tf);
  const otherResults = await Promise.all(otherTfs.map((t) => getScanRows(t)));
  const availableSets = otherTfs.map((t, i) => ({
    tf: t,
    symbols: new Set(otherResults[i].rows.map((r) => r.symbol)),
  }));

  return excluded.map((e) => ({
    ...e,
    availableIn: availableSets.filter(({ symbols }) => symbols.has(e.symbol)).map(({ tf: otf }) => otf),
  }));
}
