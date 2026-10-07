/**
 * Arayüz katmanının veri sözleşmesi. Motorun (`src/engine`) kendi tiplerini
 * (`Signal`, `Timeframe`, `ChartSeries`, `ScoreComponent`) yeniden dışa aktarır;
 * matematik tipi değil, sadece isimlendirme paylaşımı içindir.
 */
import type { ChartSeries, ScoreComponent, Signal, Timeframe } from "../src/engine/types.ts";
import type { ExclusionReason } from "../src/engine/evaluate.ts";
import type { Importance } from "./news-importance";

export type { ChartSeries, ScoreComponent, Signal, Timeframe };

/** Tarama tablosundaki tek satır — API rotasının döndürdüğü, motor çıktısından türetilmiş alanlar. */
export interface RowData {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  /** Yüzde değişim. */
  chg: number;
  score: number;
  signal: Signal;
  /** Stokastik %K. */
  k: number;
  /** Stokastik %D. */
  d: number;
  rsi: number;
  atrPct: number;
  relVol: number;
  pctB: number;
  /** MACD histogram (ham). */
  hist: number;
  /** MACD histogramının fiyata oranı (%) — tablo ve sıralama bunu kullanır. */
  histPct: number;
  /** TL cinsinden bar hacmi (fiyat * lot). */
  volTL: number;
  /**
   * En güçlü (|p| en büyük) skor bileşeninin motor gerekçesi — mobil kart listesinde
   * gösterilir (bkz. tasks/04-mobil-gorunum.md §B "Kimin kullanacağı"). Ayrı bir metin
   * DEĞİLDİR: `scoreOf()` çıktısındaki `breakdown[].n` alanından türetilir
   * (bkz. `lib/scan-data.ts`).
   */
  topReason: string;
  /**
   * Son 7 gündeki KAP bildirim sayısı ("gizli" sınıf hariç, KAPSIZ — bkz.
   * tasks/05-kap-haberler.md §C "HABER kolonu"). `scripts/build-news.ts`'in yazdığı
   * `public/data/news/_counts.json` dosyasından `lib/scan-data.ts` içinde okunur; o
   * dosya henüz üretilmemişse (ör. `build:news` hiç çalışmadıysa) 0 varsayılır —
   * bildirim script'i tarama script'inden önce/sonra çalışsa da derleme bozulmaz.
   */
  newsCount: number;
  /**
   * Sinyalin (skor, gösterge alanları, `topReason`) hesaplandığı KAPANMIŞ barın açılış zamanı
   * (epoch ms). Son bar seans içindeyken (bkz. `src/engine/bars.ts`) bir önceki bardır.
   */
  signalAsOf: number;
  /** En yeni bar veri çekildiği anda kapanmış mıydı? `false` = sinyal bir önceki bardan,
   * `price`/`chg` ise henüz kapanmamış (15 dk gecikmeli) en yeni bardan. */
  lastBarClosed: boolean;
  /** `price`/`chg`nin geldiği en yeni barın açılış zamanı (epoch ms). */
  priceAsOf: number;
}

export interface ScanResult {
  rows: RowData[];
  /** Bu zaman diliminde başarıyla hesaplanan hisse sayısı (filtre öncesi). */
  total: number;
  /** İlgili zaman dilimi barlarının en son çekildiği zaman (epoch ms) — ingest meta'sından. */
  fetchedAt: number | null;
  /** Tüm evrendeki sektörlerin tr-locale sıralı listesi ("Tümü" hariç). */
  sectors: string[];
  /** Satırların çoğunluğunun (en sık) `signalAsOf` değeri (epoch ms) — satır yoksa `null`. */
  signalAsOf: number | null;
  /** Satırların çoğunluğunda en yeni bar kapanmış mıydı? (`false` = seans içi koşu, sinyaller
   * bir önceki kapanmış bardan.) Satır yoksa `null`. */
  lastBarClosed: boolean | null;
  /** Kapanmış bar kararında kullanılan referans an (ingest başlangıcı, epoch ms). */
  evaluatedAt: number;
  /** Veri kalitesi raporu (`data/bars/{tf}.quality.json`) bulunup uygulandı mı? */
  qualityChecked: boolean;
}

export interface ScanApiResponse extends ScanResult {
  tf: Timeframe;
}

/**
 * Elenen (taranamayan) sembol sebep kodları — bkz. tasks/09-eleme-gorunurlugu.md §A.
 * "az-bar" = KAPANMIŞ bar sayısı `minBars`in altında, "veri-yok" = bu dilim için bar dosyası
 * hiç yok (ya da okunamadı/bozuk), "hesap-hatasi" = motor (`indicators`/`scoreOf`) istisna
 * attı veya fiyat/skor sonlu değil. 2026-10-07 eklendi (veri kalitesi raporundan, bkz.
 * `src/engine/quality.ts`): "bayat-veri" = son bar koşunun 3 seansından fazla gerisinde ya
 * da bu koşuda Yahoo'dan inmedi; "fiyat-sicramasi" = göstergelerin son 70 barında şüpheli
 * düzeltilmemiş bedelsiz/bölünme ya da veri hatası. Tek kaynak motordaki `ExclusionReason`.
 */
export type ExcludedReason = ExclusionReason;

/**
 * Bir zaman diliminde taranamayan (MIN_BARS eşiğini geçemeyen / verisi olmayan / motor
 * hatası veren) sembol — `public/data/excluded-{tf}.json` içeriği (bkz. `lib/scan-data.ts`
 * `getExcludedRows`, `scripts/build-static.ts`). EŞİK BURADA DEĞİŞMEZ — yalnızca elemeyi
 * KAYDEDER (tasks/09 "Eşik DEĞİŞMEYECEK").
 */
export interface ExcludedEntry {
  symbol: string;
  name: string;
  /** Bulunan bar sayısı ("veri-yok" için 0). */
  bars: number;
  /** Motorun istediği asgari bar sayısı — `src/engine/indicators.ts` `MIN_BARS`den taşınır, elle YAZILMAZ. */
  minBars: number;
  reason: ExcludedReason;
  /** Bu dilimdeki en eski barın zamanı (epoch ms) — "ilk işlem" için yaklaşık değer; veri hiç yoksa `null`. */
  firstBarAt: number | null;
  /** Bu sembolün BAŞARIYLA tarandığı diğer zaman dilimleri (bu tf hariç) — "başka dilime geç" düğmesi için. */
  availableIn: Timeframe[];
  /** Kalite kapısının Türkçe ayrıntı cümlesi ("bayat-veri"/"fiyat-sicramasi" için dolu). */
  note?: string;
}

/**
 * Hisse detay paneli için tek sembol × zaman dilimi verisi — `public/data/detail/
 * {SEMBOL}-{tf}.json` içeriği (bkz. tasks/03-detail-drawer.md §A, `lib/detail.ts`).
 * Motorun `Indicators` + `Score` çıktısının, panelin ihtiyaç duyduğu alt kümesidir
 * (ısınma amaçlı ara alanlar — `histRising`, `kRising` — dışarıda bırakılmıştır).
 */
export interface DetailData {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  /** Yüzde değişim. */
  chg: number;
  /** Stokastik %K / %D (son bar). */
  k: number;
  d: number;
  rsi: number;
  atrPct: number;
  relVol: number;
  pctB: number;
  macd: number;
  msig: number;
  hist: number;
  crossDir: number;
  crossBars: number;
  /** TL cinsinden bar hacmi (fiyat * lot). */
  volTL: number;
  hi70: number;
  lo70: number;
  score: number;
  signal: Signal;
  /** `scoreOf(ind, tf)` çıktısı — gerekçe metinleri (`n`) motordan birebir gelir. */
  breakdown: ScoreComponent[];
  /** Kapanmış barlardan çizilir (son bar seans içindeyse grafikte yer almaz). */
  chart: ChartSeries;
  /** `RowData` ile aynı anlam — bkz. orada. */
  signalAsOf: number;
  lastBarClosed: boolean;
  priceAsOf: number;
}

export type SignalFilter = "ALL" | "AL" | "SAT" | "NOTR";

export interface FilterState {
  sig: SignalFilter;
  sector: string;
  minScore: number;
  minRelVol: number;
  /** Serbest metin girişleri — boş string = sınır yok. Virgül/nokta ondalık kabul edilir. */
  atrMin: string;
  atrMax: string;
  pMin: string;
  pMax: string;
  minVolM: string;
  q: string;
  /**
   * Mobil "Yükselenler" / "Düşenler" hazır filtre setleri için (bkz.
   * tasks/04-mobil-gorunum.md §D). Masaüstü `FilterPanel` bu alanı hiç göstermez ya
   * da değiştirmez — varsayılan "ALL" kalır, yani bu alan eklenmeden önceki masaüstü
   * filtreleme davranışı birebir korunur.
   */
  chgDir: "ALL" | "UP" | "DOWN";
}

export type SortKey =
  | "symbol"
  | "price"
  | "chg"
  | "score"
  | "k"
  | "hist"
  | "rsi"
  | "atrPct"
  | "relVol"
  | "pctB"
  | "newsCount";

export type SortDir = 1 | -1;

/**
 * Türkçe alan adları — masaüstü alt başlığı ("sıralama: skor (azalan)", bkz.
 * ScanScreen.tsx `sortLabel`) VE mobil sıralama menüsü (bkz. components/SortMenu.tsx,
 * tasks/08-panel-gizleme-yatay-siralama.md §C) AYNI kaynaktan okur — iki yerde
 * birbirinden bağımsız Türkçe metin tutulmasın diye burada, `SortKey`in yanında.
 */
export const SORT_NAMES: Record<SortKey, string> = {
  symbol: "sembol",
  price: "fiyat",
  chg: "değişim",
  score: "skor",
  k: "stokastik",
  hist: "MACD",
  rsi: "RSI",
  atrPct: "ATR",
  relVol: "relatif hacim",
  pctB: "%B",
  newsCount: "haber",
};

/**
 * "Güncelle" düğmesinin durumu.
 * `updated` = sunucudan daha yeni veri geldi · `current` = zaten en günceldi.
 * İkisini ayırmak önemli: kullanıcı basıp hiçbir şey olmadığını sanmasın.
 */
export type RefreshState = "idle" | "loading" | "updated" | "current" | "error";

/**
 * Tek bir KAP bildirimi, arayüz için hazırlanmış hâli — bkz. tasks/05-kap-haberler.md
 * §A. `public/data/news-feed.json` (piyasa akışı) ve `public/data/news/{SEMBOL}.json`
 * (hisse başına) dosyalarının öğe şekli; `scripts/build-news.ts` üretir,
 * `src/providers/kap.ts`teki `Disclosure`den türetilir (motor tipi değil, yalnızca
 * KAP sağlayıcısının çıktısı) + `importance` alanı `lib/news-importance.ts`teki
 * `classifyImportance()`in sonucu. Metinler (`title`/`subject`/`summary`) KAP'ın kendi
 * ifadesiyle birebir aktarılır — LLM ile özetlenmez/yorumlanmaz (bkz. görev "Kapsam
 * dışı").
 */
export interface NewsItem {
  /** KAP'ın tekil bildirim kimliği (bkz. `Disclosure.index`). */
  index: number;
  /** Epoch ms (Europe/Istanbul saatinden çevrilmiş). */
  publishedAt: number;
  title: string;
  subject: string;
  summary: string | null;
  /** İlgili hisse kodları (boş dizi olabilir — o zaman haber chip'siz gösterilir). */
  symbols: string[];
  importance: Importance;
}
