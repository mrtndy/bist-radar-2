/**
 * Hisse evrenini KAP'tan çeker, her hisseye KAP "Sektörler" sayfasından sektör etiketi verir
 * ve `data/universe.json` olarak yazar.
 *
 * SEKTÖR KAYNAĞI (2026-10-09): KAP'ın https://www.kap.org.tr/tr/Sektorler sayfası, TEK istekte
 * (~1 MB) tüm ana/alt sektör ağacını taşıyor; 2026-10-09 canlı koşusunda evrenin 651 kodundan
 * 650'sini kapsadı (eksik: KTEST -> "Diğer"). KAP'ın uzun alt sektör adı `src/providers/sector-labels.ts`'teki
 * sabit tabloyla kısa etikete çevrilir (ör. "BANKALAR" -> "Bankacılık"). Önceki çözüm olan
 * prototipin 158 hisselik elle hazırlanmış listesi SEKTÖR için bırakıldı: 485 hisse "Diğer"
 * kalıyordu.
 *
 * ADLAR: aynı liste yalnızca AD için kullanılmaya devam eder. Prototipin elle yazdığı kısa adlar
 * ("Türk Hava Yolları") KAP unvanından (`shortName`: "TÜRK HAVA YOLLARI A.O.") daha okunaklı;
 * listede olmayan hisseler KAP unvanını alır (2026-10-09'a kadarki davranışın aynısı).
 *
 * HATA DAVRANIŞI: sektör sayfası okunamazsa (ağ, WAF, sayfa yapısı değişmiş) script DÜŞMEZ —
 * evren yine güncellenir, her sembol `data/universe.json`'daki ÖNCEKİ sektörünü korur (yeni
 * semboller "Diğer"), CI günlüğüne `::warning::` basılır. Neden: sektör yalnızca filtre/etiket;
 * bir günlük KAP arızası yüzünden evren güncellemesini (yeni halka arzlar) kaçırmak daha kötü.
 * Evrenin kendisi (`getUniverse`) çekilemezse ise script hata ile çıkar — yazacak veri yok.
 *
 * YENİ KAP SEKTÖRÜ: tablolarda olmayan her KAP adı için
 * `::warning::Eşlenmemiş KAP sektörü: <ad> (<n> hisse)` basılır (GitHub Actions bunu sarı uyarı
 * olarak gösterir); adı sector-labels.ts'e eklemek yeter.
 *
 * Çalıştır:  node scripts/build-universe.ts
 *            (bu dizüstünde Norton HTTPS'i araya girip imzaladığı için:
 *             node --use-system-ca scripts/build-universe.ts)
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSectors, getUniverse, type KapSector } from "../src/providers/kap.ts";
import { FALLBACK_LABEL, sectorLabel } from "../src/providers/sector-labels.ts";
import type { UniverseEntry } from "../src/engine/types.ts";
import { importPrototype } from "./prototype-source.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(ROOT, "data/universe.json");

/** Mevcut dosyadaki sembol -> sektör (yedek yol için). Dosya yoksa ya da bozuksa boş harita. */
async function previousSectors(): Promise<Map<string, string>> {
  try {
    const prev = JSON.parse(await readFile(OUT, "utf8")) as UniverseEntry[];
    return new Map(prev.map((u) => [u.symbol, u.sector]));
  } catch {
    return new Map();
  }
}

/** Prototipteki `TICKERS` dizisinden sembol -> elle yazılmış kısa ad (sektör alanı artık okunmaz). */
async function prototypeNames(): Promise<Map<string, string>> {
  const mod = await importPrototype<{ _TICKERS: [string, string, string, number][] }>(
    "export { TICKERS as _TICKERS };",
  );
  return new Map(mod._TICKERS.map(([sym, name]) => [sym, name]));
}

const names = await prototypeNames();
const universe = (await getUniverse()).map((u) => ({ ...u, name: names.get(u.symbol) ?? u.name }));

// Sektör kaynağı ayrı try içinde: başarısızlığı evreni durdurmasın (bkz. dosya başı).
let kap: Map<string, KapSector> | null = null;
try {
  kap = await getSectors();
} catch (e) {
  console.log(`::warning::KAP sektör sayfası okunamadı, önceki sektörler korunuyor: ${(e as Error).message}`);
}

/** Tabloda karşılığı olmayan KAP adı -> o adı taşıyan hisse sayısı. */
const unmapped = new Map<string, number>();
let fromKap = 0;
let merged: UniverseEntry[];

if (kap) {
  merged = universe.map((u) => {
    const s = kap.get(u.symbol);
    if (s) fromKap++;
    const { label, mapped } = sectorLabel(s);
    if (s && !mapped) {
      // Uyarıda gösterilecek ad: tanınmayan alt sektör varsa o, yoksa ana sektör.
      const name = s.sub ?? s.main;
      unmapped.set(name, (unmapped.get(name) ?? 0) + 1);
    }
    return { ...u, sector: label };
  });
} else {
  const prev = await previousSectors();
  merged = universe.map((u) => ({ ...u, sector: prev.get(u.symbol) ?? FALLBACK_LABEL }));
}

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(merged, null, 0), "utf8");

const other = merged.filter((m) => m.sector === FALLBACK_LABEL).map((m) => m.symbol);
const labels = new Set(merged.map((m) => m.sector));
console.log(`evren: ${merged.length} hisse (KAP, işlem gören)`);
if (kap) {
  console.log(`KAP sektörü: ${fromKap} hisse eşleşti (KAP sayfasında ${kap.size} kod)`);
} else {
  console.log(`KAP sektörü: 0 (yedek yol: önceki data/universe.json sektörleri)`);
}
console.log(
  `"${FALLBACK_LABEL}": ${other.length} hisse` + (other.length > 0 && other.length <= 10 ? ` (${other.join(", ")})` : ""),
);
console.log(`farklı etiket: ${labels.size}`);
for (const [name, n] of [...unmapped].sort((a, b) => b[1] - a[1])) {
  console.log(`::warning::Eşlenmemiş KAP sektörü: ${name} (${n} hisse)`);
}
console.log(`-> data/universe.json`);
