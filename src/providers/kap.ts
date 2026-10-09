/**
 * KAP (Kamuyu Aydınlatma Platformu) sağlayıcısı — hisse evreni, şirket bildirimleri ve sektörler.
 *
 * Bunlar KAP arayüzünün kendi çağırdığı, kimlik doğrulaması istemeyen JSON uçlarıdır;
 * resmî olarak belgelenmiş bir kamu API'si DEĞİLDİR. Uçlar habersiz değişebilir, bu yüzden
 * çağrılar dar tutulur ve şema hataları yukarı taşınır. Ölçüm (2026-07-27): bildirimler
 * saniye hassasiyetli `publishDate` ile geliyor ve `stockCodes` alanı hisse eşlemesini
 * hazır veriyor.
 *
 * Sektörler JSON uçtan değil, sunucuda çizilen "Sektörler" SAYFASINDAN okunur (2026-10-09):
 * ayrı bir sektör ucu bulunamadı, sayfa ise tüm ağacı gömülü JSON olarak taşıyor
 * (bkz. `parseSectorsPage`). KAP adını kısa etikete çeviren tablo `sector-labels.ts`'te.
 */
import type { UniverseEntry } from "../engine/types.ts";

const BASE = "https://www.kap.org.tr/tr/api";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function kapFetch(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Referer: "https://www.kap.org.tr/tr/bildirim-sorgu",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) throw new Error(`KAP ${path} -> HTTP ${res.status}`);
  return res.json();
}

/**
 * `kapFetch`in HTML kardeşi: JSON uç yerine sunucuda çizilmiş bir SAYFA çeker ve gövdeyi düz
 * metin döndürür. Ayrı fonksiyon, çünkü (a) adres `/tr/api` altında değil sitenin kökünde,
 * (b) `Accept` başlığı farklı ve (c) `res.json()` yerine `res.text()` gerekiyor — `kapFetch`in
 * davranışını değiştirmeden bu üç farkı tek yerde toplar. Başlıklar aynı tarayıcı kimliğini
 * taşır; KAP'ın WAF'ı çıplak Node isteğini engelleyebiliyor (bkz. README "Bilinen konular" 4).
 */
async function kapFetchText(pagePath: string): Promise<string> {
  const res = await fetch(`https://www.kap.org.tr${pagePath}`, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html",
      Referer: "https://www.kap.org.tr/tr/",
    },
  });
  if (!res.ok) throw new Error(`KAP ${pagePath} -> HTTP ${res.status}`);
  return res.text();
}

interface KapCompany {
  stockCode: string | null;
  kapMemberTitle: string | null;
  kapMemberState: string | null;
  payIslemDurumu: string | null;
  cityName: string | null;
}

/** Şirket unvanını tabloda gösterilebilir kısa ada indirger. */
export function shortName(title: string): string {
  return title
    .replace(/\s+/g, " ")
    .trim()
    .replace(
      /\s+(A\.Ş\.?|ANONİM ŞİRKETİ|T\.A\.Ş\.?|HOLDİNG A\.Ş\.?)$/i,
      "",
    )
    .replace(/\s+(SANAYİ VE TİCARET|SANAYİ VE TİC\.|TİCARET VE SANAYİ|SAN\. VE TİC\.)$/i, "")
    .trim();
}

/**
 * İşlem gören BIST hisselerinin listesi.
 * `payIslemDurumu === "1"` = payları işlem görüyor (2026-07-27 ölçümü: 743 üyeden 615'i).
 */
export async function getUniverse(): Promise<UniverseEntry[]> {
  const raw = (await kapFetch("/company/items/IGS/A")) as KapCompany[];
  if (!Array.isArray(raw)) throw new Error("KAP evren yanıtı dizi değil");

  const out: UniverseEntry[] = [];
  for (const c of raw) {
    if (c.kapMemberState !== "A" || c.payIslemDurumu !== "1") continue;
    if (!c.stockCode || c.stockCode === "-") continue;
    // Bazı kayıtlar çoklu kod taşır: "A1CAP, ACP" — her kodu ayrı hisse olarak aç.
    for (const code of c.stockCode.split(",").map((s) => s.trim().toUpperCase())) {
      if (!code || code === "-") continue;
      out.push({
        symbol: code,
        name: shortName(c.kapMemberTitle ?? code),
        sector: "Diğer", // sektör ayrı kaynaktan zenginleştirilir (bkz. scripts/build-universe.ts)
      });
    }
  }
  out.sort((a, b) => a.symbol.localeCompare(b.symbol, "tr"));
  return out;
}

/** "A1CAP, ACP" gibi çoklu kod alanını tek tek koda açar (`getUniverse` ile aynı kural). */
function splitCodes(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s !== "" && s !== "-");
}

/** Sektör adlarında baş/son ve çoklu boşluğu teke indirir; harflere DOKUNMAZ (bkz. sector-labels.ts). */
export function normalizeSectorName(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ─── Sektörler ──────────────────────────────────────────────────────────────

/**
 * Bir hissenin KAP sektörü. `main` = ana sektör (ör. "MALİ KURULUŞLAR"), `sub` = alt sektör
 * (ör. "BANKALAR"). Şirket sayfada normalde İKİ kez geçer: bir kez ana sektörün kendi
 * listesinde, bir kez bir alt sektörün listesinde. Bir kod YALNIZCA ana listede geçerse `sub` =
 * null olur ve etiket ana sektörden türetilir. Ölçüm (2026-10-09, kaydedilmiş sayfa): 650 kodun
 * hepsi bir alt sektörde de vardı, yani bu yol şimdilik boşta — ama KAP bir şirketi alt
 * sektörsüz eklerse etiket yine çıkar.
 */
export interface KapSector {
  main: string;
  sub: string | null;
}

/** Sayfadaki ağacın düğümü: 16 ana düğüm, `children` altında (oid anahtarlı) alt sektörler. */
interface KapSectorNode {
  title?: string | null;
  children?: Record<string, KapSectorNode> | null;
  content?: KapSectorRow[] | null;
}

/** Bir düğümün listesindeki şirket satırı (ana düğümde `mainSectorName`, altta `sectorName`). */
interface KapSectorRow {
  stockCode?: string | null;
  title?: string | null;
  sectorName?: string | null;
  mainSectorName?: string | null;
}

/**
 * Next.js'in sayfaya gömdüğü veri parçaları: `self.__next_f.push([1,"..."])`. Tırnak içi bir
 * JS dize sabitidir (kaçışlı: `\"`, `\\`, `\n`, `ç` …). Desen dizenin içini kaçışlara
 * saygı göstererek yakalar: `[^"\\]` sıradan karakter, `\\.` bir kaçış çifti — böylece içerideki
 * `\"` dizeyi erken bitirmez. `[1,` öneki önemli: `[0]` ve `[2,…]` kayıtları veri değil.
 */
const NEXT_PUSH_RE = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;

/**
 * `text[start]` bir `[` ya da `{` iken onu kapatan parantezin indeksini döndürür; kapanmıyorsa -1.
 * Neden düz `indexOf("]")` değil: dizi iç içe nesneler taşıyor ve şirket unvanlarında parantez
 * olabilir ("… (TÜRKİYE) A.Ş."). Bu yüzden derinlik sayılır ve TIRNAK İÇİ atlanır; tırnak içinde
 * `\` bir sonraki karakteri kaçırır (`\"` dizeyi bitirmez). `[` ile `{` aynı sayaçta tutulur:
 * geçerli JSON'da sıralama zaten doğrudur, ayrıştırmayı sonunda `JSON.parse` doğrular.
 */
function matchingBracket(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * KAP "Sektörler" sayfasının HTML'inden sembol -> {ana, alt} sektör haritası çıkarır. Saf
 * fonksiyon (ağ yok) — testler kaydedilmiş/elle yazılmış HTML ile çağırır.
 *
 * Adımlar ve NEDENLERİ:
 *  1. Sayfa Next.js ile sunucuda çiziliyor; tablo verisi HTML etiketlerinde değil, `push`
 *     parçalarında JSON olarak duruyor. Etiketleri kazımak yerine bu JSON'u okumak çok daha
 *     sağlam (görsel düzen değişse de veri şekli genelde kalır).
 *  2. Parçalar ayrı ayrı JSON-dize çözülüp BİRLEŞTİRİLİR: tek bir mantıksal JSON iki parçaya
 *     bölünebiliyor (ölçüm: sayfada 3 parça). Önce birleştirip sonra aramak bölünmeyi yok sayar.
 *  3. Birleşik metinde `"bistSectorsTable"` işareti, ondan sonraki ilk `"data":[` bulunur ve
 *     dizi eşleşen `]`e kadar kesilip `JSON.parse` edilir (metnin geri kalanı JSON değil —
 *     React Server Components akışı — o yüzden tamamını parse etmek mümkün değil).
 *  4. Ağaç gezilir: ana düğümün listesindeki kod `sub: null` alır, alt düğümdeki kod alt
 *     sektörü alır. Sıra bağımsız: alt sektör bilgisi bir kez geldiyse ana liste onu silmez.
 *
 * Yapı beklenenden farklıysa SESSİZCE boş harita dönmek yerine açık hata fırlatır — çağıran
 * (scripts/build-universe.ts) bunu yakalayıp önceki sektörleri korur ve CI'da uyarı basar.
 */
export function parseSectorsPage(html: string): Map<string, KapSector> {
  const where = "KAP Sektörler sayfası";

  let text = "";
  let chunks = 0;
  for (const m of html.matchAll(NEXT_PUSH_RE)) {
    // Parça bir JS dize sabiti; Next.js onu JSON.stringify ile ürettiği için kaçışları JSON
    // ile uyumlu — tırnaklarla sarıp JSON.parse etmek doğru çözümü verir.
    try {
      text += JSON.parse(`"${m[1]}"`) as string;
    } catch {
      throw new Error(`${where}: ${chunks + 1}. veri parçası çözülemedi (kaçış biçimi değişmiş olabilir)`);
    }
    chunks++;
  }
  if (chunks === 0) {
    throw new Error(`${where}: self.__next_f.push veri parçası bulunamadı (sayfa yapısı değişmiş olabilir)`);
  }

  const marker = text.indexOf('"bistSectorsTable"');
  if (marker < 0) throw new Error(`${where}: "bistSectorsTable" işareti bulunamadı`);
  const dataKey = text.indexOf('"data":[', marker);
  if (dataKey < 0) throw new Error(`${where}: "bistSectorsTable" sonrasında "data":[ dizisi bulunamadı`);
  const open = dataKey + '"data":'.length; // `[` karakterinin indeksi
  const close = matchingBracket(text, open);
  if (close < 0) throw new Error(`${where}: "data" dizisi kapanmıyor (eksik ya da kesik veri)`);

  let tops: unknown;
  try {
    tops = JSON.parse(text.slice(open, close + 1));
  } catch (e) {
    throw new Error(`${where}: "data" dizisi JSON olarak ayrıştırılamadı (${(e as Error).message})`);
  }
  if (!Array.isArray(tops)) throw new Error(`${where}: "data" bir dizi değil`);

  const out = new Map<string, KapSector>();

  /** Kodları haritaya yazar; `sub` null ise var olan alt sektör bilgisini EZMEZ. */
  const put = (rows: KapSectorRow[] | null | undefined, main: string, sub: string | null) => {
    for (const row of rows ?? []) {
      for (const code of splitCodes(row.stockCode)) {
        const prev = out.get(code);
        // İlk gelen alt sektör kazanır (ölçüm: hiçbir kod iki alt sektörde yok; olursa sonuç
        // yine sayfa sırasına göre belirlenimci kalsın diye).
        if (prev && (prev.sub !== null || sub === null)) continue;
        out.set(code, { main, sub });
      }
    }
  };

  /** Alt düğümleri gezer. Ölçülen derinlik 1, ama daha derin gelirse en içteki başlık alt sektör olur. */
  const walkChildren = (node: KapSectorNode, main: string) => {
    for (const child of Object.values(node.children ?? {})) {
      const sub = normalizeSectorName(child.title ?? "");
      put(child.content, main, sub === "" ? null : sub);
      walkChildren(child, main);
    }
  };

  for (const top of tops as KapSectorNode[]) {
    const main = normalizeSectorName(top?.title ?? "");
    if (main === "") continue;
    put(top.content, main, null);
    walkChildren(top, main);
  }

  if (out.size === 0) throw new Error(`${where}: hiçbir hisse kodu çıkarılamadı`);
  return out;
}

/**
 * KAP sektör haritası: TEK istek (~1 MB HTML), 2026-10-09 canlı koşusunda evrenin 651 kodundan
 * 650'sini kapsadı (eksik: KTEST). Ağ ya da yapı hatası yukarı fırlatılır.
 */
export async function getSectors(): Promise<Map<string, KapSector>> {
  return parseSectorsPage(await kapFetchText("/tr/Sektorler"));
}

export interface Disclosure {
  /** KAP'ın tekil bildirim kimliği — tekilleştirme anahtarı. */
  index: number;
  /** Epoch ms (Europe/Istanbul saatinden çevrilmiş). */
  publishedAt: number;
  /** Ham `dd.MM.yyyy HH:mm:ss` metni. */
  publishedRaw: string;
  title: string;
  subject: string;
  summary: string | null;
  /** İlgili hisse kodları. */
  symbols: string[];
}

interface KapDisclosure {
  disclosureIndex: number;
  publishDate: string;
  kapTitle: string | null;
  subject: string | null;
  summary: string | null;
  stockCodes: string | null;
}

/** "26.07.2026 16:59:25" (Europe/Istanbul) -> epoch ms. */
function parseKapDate(s: string): number {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return Number.NaN;
  const [, d, mo, y, h, mi, sec] = m;
  // TSİ sabit UTC+3 (Türkiye 2016'dan beri yaz saati uygulamıyor).
  return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec}+03:00`);
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Verilen tarih aralığındaki bildirimler (varsayılan: bugün), en yeniden eskiye.
 * Seans içi 15-30 sn'de bir çağrılıp `index` ile tekilleştirilmek üzere tasarlandı.
 */
export async function getDisclosures(opts: { from?: number; to?: number } = {}): Promise<Disclosure[]> {
  const to = opts.to ?? Date.now();
  const from = opts.from ?? to;
  const raw = (await kapFetch("/disclosure/members/byCriteria", {
    method: "POST",
    body: JSON.stringify({
      fromDate: iso(from),
      toDate: iso(to),
      mkkMemberOidList: [],
      subjectList: [],
    }),
  })) as KapDisclosure[];
  if (!Array.isArray(raw)) throw new Error("KAP bildirim yanıtı dizi değil");

  return raw
    .map((d) => ({
      index: d.disclosureIndex,
      publishedAt: parseKapDate(d.publishDate ?? ""),
      publishedRaw: d.publishDate ?? "",
      title: d.kapTitle ?? "",
      subject: d.subject ?? "",
      summary: d.summary,
      symbols: (d.stockCodes ?? "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    }))
    .filter((d) => Number.isFinite(d.publishedAt))
    .sort((a, b) => b.publishedAt - a.publishedAt);
}
