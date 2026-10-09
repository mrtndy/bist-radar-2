/**
 * KAP sektör kaynağı testleri: `parseSectorsPage` (src/providers/kap.ts) ve etiket tablosu
 * (src/providers/sector-labels.ts).
 *
 * Neyi korur:
 *  - Ayrıştırıcı, Next.js'in sayfaya gömdüğü `self.__next_f.push([1,"..."])` parçalarını
 *    birleştirip `bistSectorsTable` dizisini doğru okuyor mu — JSON iki parçaya bölünmüşken,
 *    unvanda kaçışlı tırnak ve köşeli parantez varken, çoklu kodlu satırda ve yalnızca ana
 *    listede geçen kodda.
 *  - Yapı bozuksa sessizce boş harita yerine açık hata fırlatıyor mu.
 *  - KAP'ın 2026-10-09'daki 48 alt + 16 ana sektör adının HEPSİ tabloda mı (harf harf; Türkçe
 *    büyük harfler İ, Ş, Ğ dahil) ve etiket sayısı 32'yi aşmıyor mu.
 *
 * Çalıştır:
 *   node --test tests/sectors.test.ts
 *   # -> "# fail 0" (gerçek sayfa testi ortam değişkeni yoksa "skip" görünür)
 *
 * Gerçek kaydedilmiş sayfayla da denemek için (1 MB dosya depoya girmez):
 *   KAP_SEKTORLER_HTML=/yol/sektorler.html node --test tests/sectors.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseSectorsPage, type KapSector } from "../src/providers/kap.ts";
import { MAIN_SECTOR_LABELS, SUB_SECTOR_LABELS, sectorLabel } from "../src/providers/sector-labels.ts";

// ─── Fikstür ────────────────────────────────────────────────────────────────

/**
 * Sayfadaki mantıksal veri (gerçek sayfanın küçültülmüş hâli). Bilerek konan zorluklar:
 *  - ACME unvanında `"` (JSON'da `\"`) ve `[ ]` var: köşeli parantez eşleyici tırnak içini atlamalı.
 *  - "KRDMA, KRDMB, KRDMD" çoklu kod; "X1, -" içinde "-" atılmalı; "  bimas " kırpılıp büyütülmeli.
 *  - SOLO yalnızca ana listede geçiyor -> sub: null.
 *  - "DİĞER" ana düğümü çocuksuz ve `content: null`.
 */
const TABLE = [
  {
    title: "MALİ KURULUŞLAR",
    content: [
      { mainSectorName: "MALİ KURULUŞLAR", stockCode: "AKBNK", title: "AKBANK T.A.Ş.", kapTypes: ["IGS"] },
      { mainSectorName: "MALİ KURULUŞLAR", stockCode: "SOLO", title: "YALNIZ ANA LİSTEDE A.Ş.", kapTypes: ["IGS"] },
    ],
    children: {
      oid1: {
        title: "BANKALAR",
        children: null,
        content: [{ sectorName: "BANKALAR", stockCode: "AKBNK", title: "AKBANK T.A.Ş." }],
      },
    },
  },
  {
    title: "İMALAT",
    content: [
      { mainSectorName: "İMALAT", stockCode: "KRDMA, KRDMB, KRDMD", title: "KARDEMİR A.Ş.", kapTypes: ["IGS"] },
      { mainSectorName: "İMALAT", stockCode: "ACME", title: 'ACME "TIRNAKLI" [KÖŞELİ] A.Ş.', kapTypes: ["IGS"] },
    ],
    children: {
      oid2: {
        title: "ANA METAL SANAYİ",
        children: null,
        content: [{ sectorName: "ANA METAL SANAYİ", stockCode: "KRDMA, KRDMB, KRDMD", title: "KARDEMİR A.Ş." }],
      },
      oid3: {
        title: "KİMYA İLAÇ PETROL LASTİK VE PLASTİK ÜRÜNLER",
        children: null,
        content: [
          { sectorName: "KİMYA İLAÇ PETROL LASTİK VE PLASTİK ÜRÜNLER", stockCode: "ACME", title: 'ACME "TIRNAKLI" [KÖŞELİ] A.Ş.' },
          { sectorName: "KİMYA İLAÇ PETROL LASTİK VE PLASTİK ÜRÜNLER", stockCode: "X1, -", title: "X BİR A.Ş." },
        ],
      },
    },
  },
  {
    title: "TOPTAN VE PERAKENDE TİCARET",
    content: [{ mainSectorName: "TOPTAN VE PERAKENDE TİCARET", stockCode: "  bimas ", title: "BİM A.Ş.", kapTypes: ["IGS"] }],
    children: {
      oid4: {
        title: "PERAKENDE TİCARET",
        children: null,
        content: [{ sectorName: "PERAKENDE TİCARET", stockCode: "  bimas ", title: "BİM A.Ş." }],
      },
    },
  },
  { title: "DİĞER", content: null, children: null },
];

/**
 * Mantıksal metni RSC akışına benzer şekilde sarar, İKİ parçaya böler ve her parçayı
 * Next.js'in yaptığı gibi JSON.stringify ile JS dize sabitine çevirir. Bölme noktası bir
 * şirket unvanının ORTASINDA — ayrıştırıcı birleştirmeden önce aramaya kalksa başarısız olurdu.
 * Başa konan `"data":[1,2]` tuzağı: işaretten ÖNCEKİ "data" dizisi alınmamalı.
 */
function fixtureHtml(): string {
  const logical =
    `0:{"data":[1,2]}\n` +
    `5:["$","div",null,{"bistSectorsTable":true,"props":{"data":${JSON.stringify(TABLE)},"total":4}}]\n`;
  const cut = logical.indexOf("KARDEMİR") + 4; // "KARD" | "EMİR A.Ş."
  const parts = [logical.slice(0, cut), logical.slice(cut)];
  const pushes = parts.map((p) => `<script>self.__next_f.push([1,${JSON.stringify(p)}])</script>`);
  return [
    "<!DOCTYPE html><html><head><title>Sektörler</title></head><body>",
    "<script>(self.__next_f=self.__next_f||[]).push([0])</script>",
    pushes[0],
    '<script>self.__next_f.push([2,null])</script>', // veri olmayan kayıt: yok sayılmalı
    pushes[1],
    "</body></html>",
  ].join("\n");
}

// ─── (a) Ayrıştırıcı ────────────────────────────────────────────────────────

test("fikstür gerçekten iki parçalı ve kaçışlı tırnak taşıyor (testin kendi ön koşulu)", () => {
  const html = fixtureHtml();
  assert.equal(html.match(/self\.__next_f\.push\(\[1,/g)?.length, 2);
  // Unvandaki `"` sayfada iki kat kaçışlı durur: JSON'da \" , JS dizesinde \\\"
  assert.ok(html.includes('ACME \\\\\\"TIRNAKLI\\\\\\"'));
});

test("parseSectorsPage: bölünmüş JSON, çoklu kod, yalnız ana liste", () => {
  const got = parseSectorsPage(fixtureHtml());
  const want = new Map<string, KapSector>([
    ["AKBNK", { main: "MALİ KURULUŞLAR", sub: "BANKALAR" }],
    ["SOLO", { main: "MALİ KURULUŞLAR", sub: null }],
    ["KRDMA", { main: "İMALAT", sub: "ANA METAL SANAYİ" }],
    ["KRDMB", { main: "İMALAT", sub: "ANA METAL SANAYİ" }],
    ["KRDMD", { main: "İMALAT", sub: "ANA METAL SANAYİ" }],
    ["ACME", { main: "İMALAT", sub: "KİMYA İLAÇ PETROL LASTİK VE PLASTİK ÜRÜNLER" }],
    ["X1", { main: "İMALAT", sub: "KİMYA İLAÇ PETROL LASTİK VE PLASTİK ÜRÜNLER" }],
    ["BIMAS", { main: "TOPTAN VE PERAKENDE TİCARET", sub: "PERAKENDE TİCARET" }],
  ]);
  // Map'i sıralı diziye çevirip karşılaştır: sıra değil içerik önemli.
  const sorted = (m: Map<string, KapSector>) => [...m].sort(([a], [b]) => a.localeCompare(b));
  assert.deepEqual(sorted(got), sorted(want));
  assert.ok(!got.has("-"), '"-" kod sayılmamalı');
});

// ─── (b) Bozuk yapı ─────────────────────────────────────────────────────────

test("parseSectorsPage: işaret yoksa açık hata", () => {
  const html = `<script>self.__next_f.push([1,${JSON.stringify('5:{"data":[{"title":"X"}]}')}])</script>`;
  assert.throws(() => parseSectorsPage(html), /bistSectorsTable/);
});

test("parseSectorsPage: push parçası yoksa ve dizi kapanmıyorsa açık hata", () => {
  assert.throws(() => parseSectorsPage("<html><body>bakımda</body></html>"), /veri parçası bulunamadı/);
  const cutOff = `<script>self.__next_f.push([1,${JSON.stringify('{"bistSectorsTable":1,"data":[{"title":"X"')}])</script>`;
  assert.throws(() => parseSectorsPage(cutOff), /kapanmıyor/);
  const empty = `<script>self.__next_f.push([1,${JSON.stringify('{"bistSectorsTable":1,"data":[]}')}])</script>`;
  assert.throws(() => parseSectorsPage(empty), /hiçbir hisse kodu/);
});

// ─── (c) Tablo KAP'ın adlarını kapsıyor ─────────────────────────────────────

/** KAP'ın 2026-10-09'da hisse taşıyan 48 alt sektörü, sayfadaki yazımıyla. */
const KAP_SUBS = [
  "BANKALAR", "HOLDİNGLER VE YATIRIM ŞİRKETLERİ", "GAYRİMENKUL YATIRIM ORTAKLIKLARI",
  "GAYRİMENKUL FAALİYETLERİ", "MENKUL KIYMET YATIRIM ORTAKLIKLARI",
  "GİRİŞİM SERMAYESİ YATIRIM ORTAKLIKLARI", "ARACI KURUMLAR", "FİNANSAL KİRALAMA VE FAKTORİNG ŞİRKETLERİ",
  "FİNANSMAN ŞİRKETLERİ", "VARLIK YÖNETİM ŞİRKETLERİ", "SİGORTA ŞİRKETLERİ",
  "KİMYA İLAÇ PETROL LASTİK VE PLASTİK ÜRÜNLER", "GIDA, İÇECEK VE TÜTÜN",
  "METAL EŞYA MAKİNE ELEKTRİKLİ CİHAZLAR VE ULAŞIM ARAÇLARI", "ANA METAL SANAYİ",
  "ELEKTRİK GAZ VE BUHAR", "HAM PETROL VE DOĞAL GAZ ÇIKARTILMASI", "BİLİŞİM",
  "BİLGİ HİZMET FAALİYETLERİ", "TELEKOMÜNİKASYON", "YAYIMCILIK", "REKLAMCILIK VE PAZAR ARAŞTIRMASI",
  "SAVUNMA", "TAŞ VE TOPRAĞA DAYALI", "TEKSTİL, GİYİM EŞYASI VE DERİ", "KAĞIT VE KAĞIT ÜRÜNLERİ BASIM",
  "ORMAN ÜRÜNLERİ VE MOBİLYA", "DİĞER İMALAT SANAYİİ", "PERAKENDE TİCARET", "TOPTAN TİCARET",
  "İNŞAAT VE BAYINDIRLIK İŞLERİ", "MİMARLIK VE MÜHENDİSLİK FAALİYETLERİ; TEKNİK MUAYENE VE ANALİZ",
  "BÜRO YÖNETİMİ, BÜRO DESTEĞİ VE DİĞER ŞİRKET DESTEK FAALİYETLERİ", "HUKUK VE MUHASEBE FAALİYETLERİ",
  "KİRALAMA VE LEASING FAALİYETLERİ", "ULAŞTIRMA VE DEPOLAMA", "KONAKLAMA", "YİYECEK VE İÇECEK HİZMETLERİ",
  "SEYAHAT ACENTESİ, TUR OPERATÖRÜ VE DİĞER REZERVASYON HİZMETLERİ İLE İLGİLİ FAALİYETLER",
  "İNSAN SAĞLIĞI VE SOSYAL HİZMETLER", "SPOR FAALİYETLERİ EĞLENCE VE OYUN FAALİYETLERİ",
  "YARATICI SANATLAR GÖSTERİ SANATLARI VE EĞLENCE FAALİYETLERİ",
  "SPOR EĞLENCE BOŞ ZAMANLARI DEĞERLENDİRME HİZMETLERİ",
  "TARIM VE HAYVANCILIK AVCILIK VE İLGİLİ HİZMET FAALİYETLERİ", "BALIKÇILIK VE SU ÜRÜNLERİ",
  "METAL CEVHERİ MADENCİLİĞİ", "KÖMÜR VE LİNYİT MADENCİLİĞİ", "DİĞER MADENCİLİK VE TAŞ OCAKÇILIĞI",
];

/** KAP'ın 16 ana sektörü ("DİĞER" dahil). */
const KAP_MAINS = [
  "TARIM, ORMANCILIK VE BALIKÇILIK", "MADENCİLİK VE TAŞ OCAKÇILIĞI", "İMALAT", "ELEKTRİK GAZ VE SU",
  "İNŞAAT VE BAYINDIRLIK", "TOPTAN VE PERAKENDE TİCARET", "ULAŞTIRMA VE DEPOLAMA", "MALİ KURULUŞLAR",
  "EĞİTİM SAĞLIK SPOR VE EĞLENCE HİZMETLERİ", "TEKNOLOJİ", "MESLEKİ, BİLİMSEL VE TEKNİK FAALİYETLER",
  "İDARİ VE DESTEK HİZMET FAALİYETLERİ", "GAYRİMENKUL FAALİYETLERİ", "OTELLER VE LOKANTALAR",
  "BİLGİ VE İLETİŞİM", "DİĞER",
];

test("48 KAP alt sektörünün hepsi SUB_SECTOR_LABELS'ta (ve fazlası yok)", () => {
  assert.equal(KAP_SUBS.length, 48);
  for (const name of KAP_SUBS) assert.ok(Object.hasOwn(SUB_SECTOR_LABELS, name), `eksik alt sektör: ${name}`);
  assert.equal(Object.keys(SUB_SECTOR_LABELS).length, 48);
});

test("16 KAP ana sektörünün hepsi MAIN_SECTOR_LABELS'ta", () => {
  assert.equal(KAP_MAINS.length, 16);
  for (const name of KAP_MAINS) assert.ok(Object.hasOwn(MAIN_SECTOR_LABELS, name), `eksik ana sektör: ${name}`);
});

// ─── (d) Yedek kuralları ────────────────────────────────────────────────────

test("sectorLabel: alt -> ana -> Diğer önceliği ve mapped bayrağı", () => {
  assert.deepEqual(sectorLabel({ main: "MALİ KURULUŞLAR", sub: "BANKALAR" }), { label: "Bankacılık", mapped: true });
  // Boşluk normalleştirmesi: KAP fazladan boşluk koysa da eşleşir.
  assert.deepEqual(sectorLabel({ main: " MALİ  KURULUŞLAR ", sub: "  BANKALAR " }), { label: "Bankacılık", mapped: true });
  // Alt sektörsüz kod: ana etiket, tam eşleşme sayılır.
  assert.deepEqual(sectorLabel({ main: "MALİ KURULUŞLAR", sub: null }), { label: "Finansman", mapped: true });
  // Tanımadığımız (yeni) alt sektör: ana etikete düşer ama CI uyarısı için mapped: false.
  assert.deepEqual(sectorLabel({ main: "TEKNOLOJİ", sub: "YAPAY ZEKA" }), { label: "Bilişim", mapped: false });
  // İkisi de bilinmiyor.
  assert.deepEqual(sectorLabel({ main: "UZAY", sub: "ROKET" }), { label: "Diğer", mapped: false });
  assert.deepEqual(sectorLabel({ main: "UZAY", sub: null }), { label: "Diğer", mapped: false });
  // KAP'ta hiç olmayan hisse: veri yokluğu, bilinmeyen ad değil.
  assert.deepEqual(sectorLabel(undefined), { label: "Diğer", mapped: true });
  // Harf dönüşümü yapılmaz: ASCII "I" ile yazılmış ad Türkçe "İ"li anahtarla eşleşmez.
  assert.equal(sectorLabel({ main: "UZAY", sub: "BILISIM" }).mapped, false);
});

// ─── (e) Etiket sayısı ──────────────────────────────────────────────────────

test("farklı etiket sayısı en fazla 32", () => {
  const labels = new Set([...Object.values(SUB_SECTOR_LABELS), ...Object.values(MAIN_SECTOR_LABELS), "Diğer"]);
  assert.ok(labels.size <= 32, `etiket sayısı ${labels.size}`);
});

// ─── (f) İsteğe bağlı: gerçek kaydedilmiş sayfa ─────────────────────────────

const REAL = process.env.KAP_SEKTORLER_HTML;

test("gerçek KAP sayfası: kodların hepsi tabloyla eşleniyor", { skip: !REAL && "KAP_SEKTORLER_HTML tanımlı değil" }, () => {
  const map = parseSectorsPage(readFileSync(REAL!, "utf8"));
  assert.ok(map.size > 600, `yalnızca ${map.size} kod`);
  for (const [code, s] of map) assert.ok(sectorLabel(s).mapped, `${code}: eşlenmemiş ${s.sub ?? s.main}`);
  assert.equal(sectorLabel(map.get("AKBNK")).label, "Bankacılık");
  assert.equal(sectorLabel(map.get("ASELS")).label, "Savunma");
});
