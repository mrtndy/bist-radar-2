/**
 * Parity testi: TypeScript motoru (src/engine) ile handoff prototipindeki orijinal
 * `bist-data.js` motorunun AYNI barlar için AYNI çıktıyı ürettiğini doğrular.
 *
 * Orijinaldeki `indicators`/`scoreOf`/`genSeries` dışa aktarılmadığı için dosyanın
 * kaynağına export satırı eklenip data: URL modülü olarak yüklenir — referans
 * uygulamaya dokunmadan ona erişmenin yolu budur.
 *
 * Kasıtlı sapmalar (README "Bilinen konular") ve her birinin doğrulaması:
 *   1. ATR eşik ölçeklemesi (H/S) — skor fonksiyonu G'de birebir, ATR dışı bileşenler her
 *      dilimde birebir, ölçekleme H/S'de fiilen etkin.
 *   2. relVol (2026-10-07) — payda artık önceki 20 barın ortalaması. relVol karşılaştırmadan
 *      çıkarıldı; yerine port değeri bağımsız elle hesaplanan formülle birebir karşılaştırılır
 *      ve prototipten en az bir vakada farklı olduğu (değişikliğin etkin olduğu) doğrulanır.
 *      Skor FONKSİYONU yine birebir: prototipin `scoreOf`u portun göstergeleriyle beslenince
 *      portun `scoreOf`uyla aynı sonucu vermelidir — yani skor farkları yalnızca girdiden gelir.
 *   3. Düz aralık stokastiği (2026-10-07) — 14 bar boyunca fiyatı hiç oynamayan sentetik seride
 *      prototip %K = 0 ("aşırı satım"), port %K = 50 (nötr) vermeli; diğer TÜM alanlar birebir.
 *      Demo serilerinde düz aralık hiç oluşmaz, o yüzden ana döngüde K/D birebir kalmalı.
 *
 * Çalıştır:  node scripts/parity.ts
 */
import { indicators } from "../src/engine/indicators.ts";
import { scoreOf } from "../src/engine/scoring.ts";
import type { Bar, Indicators, Timeframe } from "../src/engine/types.ts";
import { importPrototype } from "./prototype-source.ts";

/**
 * Kasıtlı farklar:
 * - `chart.labels` — orijinal demo tarihleri üretir, port gerçek zaman damgalarını biçimler.
 * - `chart.bars[*].t` — orijinal barlarda zaman damgası yok, testte biz ekliyoruz.
 * - `relVol` — kasıtlı değişiklik 2 (yukarıda); ayrıca elle doğrulanır.
 */
const IGNORED = [/^chart\.labels/, /^chart\.bars\[\d+\]\.t$/, /^relVol$/];
const isIgnored = (p: string, extra: RegExp[] = []) => [...IGNORED, ...extra].some((re) => re.test(p));

type AnyRec = Record<string, unknown>;

const loadOriginal = () =>
  importPrototype<{
    _indicators: (bars: unknown[], tf: string) => AnyRec;
    _scoreOf: (d: AnyRec) => AnyRec;
    _genSeries: (sym: string, tf: string, tier: number, arch: number) => AnyRec[];
    _hash: (s: string) => number;
  }>(
    "export { indicators as _indicators, scoreOf as _scoreOf, genSeries as _genSeries, hash as _hash };",
  );

const diffs: string[] = [];
interface Comp { k: string; p: number; n: string }
/** ATR ölçeklemesinin fiilen etkin olduğunu doğrulamak için sayaçlar. */
const atrChecked: Record<string, number> = {};
const atrChanged: Record<string, number> = {};
/** relVol değişikliğinin etkin olduğunu ve uçtan uca etkisini saymak için. */
let relVolChanged = 0;
let endToEndScoreChanged = 0;

function compare(a: unknown, b: unknown, trail: string, extra: RegExp[] = []): void {
  if (isIgnored(trail, extra)) return;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return void diffs.push(`${trail}: dizi/tip uyuşmazlığı`);
    if (a.length !== b.length) return void diffs.push(`${trail}: uzunluk ${a.length} != ${b.length}`);
    a.forEach((x, i) => compare(x, b[i], `${trail}[${i}]`, extra));
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a as AnyRec), ...Object.keys(b as AnyRec)]);
    for (const k of keys) compare((a as AnyRec)[k], (b as AnyRec)[k], trail ? `${trail}.${k}` : k, extra);
    return;
  }
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return;
    // Aynı işlem sırası -> bit düzeyinde aynı olmalı; kayan nokta payı yine de bırakıldı.
    if (Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))) {
      diffs.push(`${trail}: ${a} != ${b}`);
    }
    return;
  }
  if (a !== b) diffs.push(`${trail}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}

/** relVol'ün yeni tanımı, motordan BAĞIMSIZ yazılmış hâli: V[son] / ortalama(V[son-20..son-1]). */
function expectedRelVol(bars: Bar[]): number {
  const n = bars.length;
  let s = 0;
  for (let j = n - 21; j <= n - 2; j++) s += bars[j].v;
  const avg = s / 20;
  return bars[n - 1].v / (avg || bars[n - 1].v);
}

const orig = await loadOriginal();
const toBars = (raw: AnyRec[]): Bar[] =>
  // Orijinal barlarda zaman damgası yok; port `t` bekliyor (yalnızca etiketleme için kullanılır).
  raw.map((b, i) => ({
    t: Date.UTC(2026, 0, 1) + i * 86_400_000,
    o: b.o as number,
    h: b.h as number,
    l: b.l as number,
    c: b.c as number,
    v: b.v as number,
  }));

// Prototipteki gerçek evrenden örnek semboller + her zaman dilimi + her "arketip".
const SYMBOLS = ["AKBNK", "THYAO", "ASELS", "TCELL", "SASA", "KOZAL", "BIMAS", "EREGL", "PGSUS", "SISE", "TUPRS", "MGROS"];
const TFS: Timeframe[] = ["G", "H", "S"];

let cases = 0;
for (const sym of SYMBOLS) {
  const h = orig._hash(sym);
  const arch = h % 5;
  for (const tier of [0, 1, 2, 3]) {
    for (const tf of TFS) {
      const raw = orig._genSeries(sym, tf, tier, arch);
      const bars = toBars(raw);

      // Göstergeler: relVol dışındaki TÜM alanlar prototiple birebir (K/D dahil — demo
      // serilerinde düz aralık yok).
      const expectedInd = orig._indicators(raw, tf);
      const actualInd = indicators(bars, tf);
      compare(expectedInd, actualInd as unknown as AnyRec, "");

      // relVol: yeni formülle birebir, prototipten farkı sayılır (değişiklik etkin mi?).
      compare(expectedRelVol(bars), actualInd.relVol, `relVol(yeni formül, ${sym}/${tf}/${tier})`);
      if (actualInd.relVol !== expectedInd.relVol) relVolChanged++;

      // (a) Skor FONKSİYONU prototiple birebir: aynı göstergeyle beslenince aynı puan/metin.
      //     Hem portun göstergeleriyle hem prototipin göstergeleriyle denenir.
      const protoOnPort = orig._scoreOf(actualInd as unknown as AnyRec) as { score: number; breakdown: Comp[] };
      compare(protoOnPort, scoreOf(actualInd, "G") as unknown as AnyRec, "score");
      compare(
        orig._scoreOf(expectedInd),
        scoreOf(expectedInd as unknown as Indicators, "G") as unknown as AnyRec,
        "score(prototip göstergeleri)",
      );
      // Bilgi: uçtan uca günlük skor (prototip zinciri vs port zinciri) relVol yüzünden değişti mi?
      const protoEndToEnd = orig._scoreOf(expectedInd) as { score: number };
      if (protoEndToEnd.score !== scoreOf(actualInd, "G").score) endToEndScoreChanged++;

      // (b) Haftalık/saatlik yalnızca ATR bileşeninde ayrışabilir (ATR_TIMEFRAME_SCALE).
      //     Diğer beş bileşen prototiple aynı kalmalı — ölçekleme sızıntı yapmamalı.
      const scaled = scoreOf(actualInd, tf);
      const expNonAtr = protoOnPort.breakdown.filter((b) => b.k !== "ATR");
      const actNonAtr = scaled.breakdown.filter((b) => b.k !== "ATR");
      compare(expNonAtr, actNonAtr as unknown as AnyRec, `score.breakdown[!ATR](${tf})`);
      if (tf !== "G" && protoOnPort.breakdown.length !== scaled.breakdown.length) {
        diffs.push(`score.breakdown(${tf}): bileşen sayısı değişti`);
      }
      // Ölçeklemenin gerçekten etkin olduğunu say (aşağıda sıfırsa katsayı ölü demektir).
      if (tf !== "G") {
        const a = protoOnPort.breakdown.find((b) => b.k === "ATR");
        const b = scaled.breakdown.find((b) => b.k === "ATR");
        atrChecked[tf] = (atrChecked[tf] ?? 0) + 1;
        if (a && b && (a.p !== b.p || a.n !== b.n)) atrChanged[tf] = (atrChanged[tf] ?? 0) + 1;
      }
      cases++;
    }
  }
}

// (c) Düz aralık stokastiği: son 20 barı tamamen düz (o = h = l = c) yapılmış sentetik seri.
//     20 bar: %D'nin son 3 değeri 3 %K'ya, her %K 3 ham %K'ya, her ham %K 14 bara bakar -> 18.
const FLAT_EXTRA = [/^k$/, /^d$/, /^kRising$/, /^chart\.K\[/, /^chart\.D\[/];
let flatCases = 0;
for (const sym of SYMBOLS.slice(0, 4)) {
  const raw = orig._genSeries(sym, "G", 1, orig._hash(sym) % 5);
  const n = raw.length;
  const px = raw[n - 21].c as number;
  for (let i = n - 20; i < n; i++) raw[i] = { o: px, h: px, l: px, c: px, v: raw[i].v };
  const bars = toBars(raw);
  const expectedInd = orig._indicators(raw, "G") as { k: number; d: number };
  const actualInd = indicators(bars, "G");
  // Kök yolu "" (alan adları ana döngüdekiyle aynı biçimde); K/D türevleri bilerek hariç.
  const before = diffs.length;
  compare(expectedInd, actualInd as unknown as AnyRec, "", FLAT_EXTRA);
  for (let i = before; i < diffs.length; i++) diffs[i] = `flat(${sym}): ${diffs[i]}`;
  if (!(Math.abs(expectedInd.k) < 1e-6)) diffs.push(`flat(${sym}): prototip %K ${expectedInd.k}, 0 bekleniyordu (test kurgusu bozuk)`);
  if (actualInd.k !== 50 || actualInd.d !== 50) diffs.push(`flat(${sym}): port %K/%D ${actualInd.k}/${actualInd.d}, 50/50 bekleniyordu`);
  const stoch = scoreOf(actualInd, "G").breakdown.find((b) => b.k === "Stokastik");
  if (!stoch || stoch.n.startsWith("Aşırı satım")) diffs.push(`flat(${sym}): stokastik hâlâ aşırı satım puanlıyor`);
  flatCases++;
}

const uniq = [...new Set(diffs)];
if (uniq.length) {
  console.error(`PARITY FAIL — ${cases} vaka, ${uniq.length} farklı alan:`);
  for (const d of uniq.slice(0, 25)) console.error("  " + d);
  if (uniq.length > 25) console.error(`  … +${uniq.length - 25} daha`);
  process.exit(1);
}
// Ölçekleme hiç devreye girmiyorsa katsayı ölüdür — testin sessizce geçmesine izin verme.
for (const tf of ["H", "S"]) {
  if (!atrChanged[tf]) {
    console.error(
      `PARITY FAIL — ${tf} diliminde ATR ölçeklemesi hiçbir vakada etkili olmadı ` +
        `(${atrChecked[tf] ?? 0} vaka). ATR_TIMEFRAME_SCALE bağlanmamış olabilir.`,
    );
    process.exit(1);
  }
}
// relVol değişikliği hiçbir vakada fark yaratmıyorsa değişiklik bağlanmamıştır.
if (relVolChanged === 0) {
  console.error("PARITY FAIL — relVol hiçbir vakada prototipten farklı değil; yeni payda bağlanmamış olabilir.");
  process.exit(1);
}

console.log(`PARITY OK — ${cases} vaka (${SYMBOLS.length} sembol x 4 tier x 3 zaman dilimi) + ${flatCases} düz aralık vakası.`);
console.log(`  göstergeler relVol dışında birebir; skor fonksiyonu prototiple birebir; ATR dışı bileşenler her dilimde birebir.`);
console.log(
  `  ATR ölçeklemesi etkin: H ${atrChanged.H ?? 0}/${atrChecked.H ?? 0} vakada, ` +
    `S ${atrChanged.S ?? 0}/${atrChecked.S ?? 0} vakada farklılaştı (beklenen).`,
);
console.log(
  `  relVol (önceki 20 barın ortalaması) yeni formülle birebir; ${relVolChanged}/${cases} vakada prototipten farklı ` +
    `(beklenen), uçtan uca skor ${endToEndScoreChanged}/${cases} vakada değişti.`,
);
console.log(`  düz aralık stokastiği: prototip %K 0 (aşırı satım), port %K 50 (nötr); diğer alanlar birebir.`);
