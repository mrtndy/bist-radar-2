# BIST Radar 2

Bu depo **v2**'dir. Canlı **v1** şu adreste çalışmaya devam ediyor: <https://mrtndy.github.io/bist-radar> (kaynağı `mrtndy/bist-radar`, dokunulmadı). v2 ayrı bir depoda (`mrtndy/bist-radar-2`) ve ayrı bir sitede yayınlanır: <https://mrtndy.github.io/bist-radar-2>.

- **Zamanlama:** v2, terfi edene kadar yalnızca **akşam koşusuyla** (hafta içi 16:00 UTC = 19:00 TSİ) ve elle tetiklemeyle çalışır. Seans içi 15 dakikalık cron `.github/workflows/deploy.yml` içinde yorum satırıdır; böylece v1 ve v2 birlikte çalışırken Yahoo'ya giden istek ikiye katlanmaz.
- **v2'yi v1'in yerine geçirmek (terfi):**
  1. `.github/workflows/deploy.yml` içinde `# - cron: "*/15 7-15 * * 1-5"` satırının başındaki `# ` işaretini kaldır, commit'le ve push'la.
  2. v1 deposunda (`mrtndy/bist-radar`) Actions sekmesinden "Veriyi tazele ve yayınla" workflow'unu **Disable workflow** ile kapat (Yahoo trafiği tek kaynaktan gitsin).
  3. Kullanıcıya yeni adresi ver (`.../bist-radar-2`). v1 sitesi kapatılana kadar eski adreste kalır.

## Yerelde ingest çalıştırmak (Windows + antivirüs HTTPS taraması)

Norton gibi antivirüsler HTTPS trafiğini kendi sertifikasıyla araya girip tarar; `curl_cffi` bu sertifikayı tanımadığı için Yahoo isteklerinde TLS hatası alırsın. Çözüm: Windows'un güvenilen kök sertifikalarını bir PEM dosyasına dışa aktarıp `CURL_CA_BUNDLE` ile göstermek. Bir kerelik, 6 satır:

```python
import ssl
certs = []
for store in ("ROOT", "CA"):
    for der, enc, trust in ssl.enum_certificates(store):
        if enc == "x509_asn": certs.append(ssl.DER_cert_to_PEM_cert(der))
open("windows-roots.pem", "w").write("".join(certs))  # -> windows-roots.pem
```

Sonra ingest'i çalıştırmadan önce (PowerShell):

```powershell
$env:CURL_CA_BUNDLE = "$PWD\windows-roots.pem"
python ingest/ingest.py --timeframe G   # -> data/bars/G/*.json
```

`windows-roots.pem` yalnızca senin makinene aittir; depoya commit'leme. GitHub Actions'ta buna gerek yoktur.

# BIST Radar — veri katmanı

`../design_handoff_bist_radar/` altındaki tasarım paketinin üretim uygulaması.
Bu dizin şu an **veri katmanı + hesaplama motorunu** içerir; arayüz henüz yok.

Durum: veri hattı uçtan uca çalışıyor ve gerçek BIST verisiyle doğrulandı (2026-07-27).

## Neden bu mimari

| Katman | Dil | Gerekçe |
|---|---|---|
| `ingest/` | Python | **Tek Python bileşeni.** Yahoo Finance, Node/undici ve düz curl'ün TLS parmak izini HTTP 429 ile reddediyor; yfinance'in altındaki `curl_cffi` Chrome'un TLS el sıkışmasını taklit ederek geçiyor. Ölçülerek doğrulandı, varsayım değil. |
| `src/engine/` | TypeScript | Gösterge + skor matematiği. Prototipteki `bist-data.js` zaten JavaScript olduğu için **birebir** portlanabildi; ikinci bir dile bölmek sapma riski yaratırdı. |
| `src/providers/` | TypeScript | KAP (evren + bildirimler), İş Yatırım (çapraz doğrulama). İkisi de Node'dan sorunsuz erişilebiliyor. |

## Doğrulanmış veri kaynakları (2026-07-27 ölçümleri)

| Kaynak | Ne veriyor | Gecikme | Ücret | Ölçüm |
|---|---|---|---|---|
| Yahoo Finance (yfinance + curl_cffi) | OHLCV — günlük/haftalık/saatlik, tam OHLC | ~15 dk | 0 | 619/639 sembol, günlük 54 sn · haftalık 51 sn · saatlik 222 sn |
| KAP `/api/company/items/IGS/A` | Hisse evreni | — | 0 | 743 üye → 615 işlem gören → 639 kod |
| KAP `/api/disclosure/members/byCriteria` | Şirket bildirimleri, saniye hassasiyetli, `stockCodes` hazır | saniyeler | 0 | 568 bildirim / 286 ms; 283'ü evrenle eşleşti |
| İş Yatırım `HisseTekil` | EOD OHLC (açılış YOK) — çapraz doğrulama | gün sonu | 0 | 10 sembolde kapanışlar yfinance ile **%0,000** sapma |

Sonuç: **taramanın tamamı ücretsiz veriyle çalışıyor.** Gerçek zamanlı (0 gecikmeli) veri BIST'te
lisanslıdır; gerekirse `DataProvider` arayüzüne bir aracı kurum API'si takılır — çekirdek değişmez.

## Kurulum

```bash
npm --version   # Node >= 24 gerekli (TypeScript'i doğrudan çalıştırır, build adımı yok)
python3 -m venv .venv && ./.venv/bin/pip install -r ingest/requirements.txt
```

Testler ve tip denetimi:

```bash
npm test          # Node'un yerleşik test koşucusu: tests/**/*.test.ts  (-> "pass 10, fail 0")
npx tsc --noEmit  # tip denetimi, bayraksız geçmeli (-> çıktı yok, çıkış kodu 0)
```

Notlar (v2'de değişenler):

- **`tsconfig.json`:** `baseUrl` kaldırıldı (TypeScript 6'da kullanımdan kalktı, TS5101 hatası verirdi). `"@/*": ["./*"]` yolu artık `baseUrl` olmadan, doğrudan `tsconfig.json`'un bulunduğu dizine göre çözülür; davranış aynıdır. (JSON yorum kabul etmediği için açıklama burada.)
- **Yazı tipi:** Inter artık `app/fonts/` altındaki woff2 dosyalarından yüklenir (`next/font/local`); Google Fonts'a derleme sırasında erişilemediği için 2026-10-06'da CI çökmüştü. Lisans: `app/fonts/Inter-OFL-LICENSE.txt` (SIL Open Font License 1.1). Dosyalar `@fontsource-variable/inter` 5.3.0 paketinden alındı, çalışma zamanı bağımlılığı değildir.
- **Python bağımlılıkları** `ingest/requirements.txt` içinde tam sürüme sabit (`yfinance==1.7.0`, `curl_cffi==0.16.3`).

## Kullanım

```bash
node scripts/build-universe.ts              # KAP'tan evren -> data/universe.json
./.venv/bin/python ingest/ingest.py --timeframe G   # barlar -> data/bars/G/*.json
node scripts/scan.ts --tf G --top 20        # tarama tablosu
node scripts/news.ts --days 3               # KAP bildirim akışı
node scripts/parity.ts                      # motor prototiple aynı mı?
```

## Parity garantisi

`scripts/parity.ts`, TypeScript motorunu prototipin orijinal `bist-data.js`'iyle aynı barlarda
karşılaştırır: **144 vaka (12 sembol × 4 tier × 3 zaman dilimi) + 4 düz aralık vakası.**
Motor dosyalarına dokunan her değişiklikten sonra çalıştır. Kasıtlı farklar: `chart.labels`
(gerçek zaman damgası), `chart.bars[].t` (orijinalde yok), ATR ölçeklemesi (H/S), ve v2'de
(2026-10-07) üç düzeltme: `relVol` önceki 20 barın ortalamasına bölünür, düz aralıkta
stokastik %K = 50, hiç oynamayan fiyatta RSI = 50 (prototip ikisinde de 0 = "aşırı satım"
veriyordu). Parity bunların dışındaki her alanın birebir kaldığını ayrıca doğrular.

## Bilinen konular

**1. ~~ATR skorlaması yalnızca günlük dilimde ayırt edici.~~ ÇÖZÜLDÜ 2026-07-27.**
Prototipin ATR bandı (%2–6 ideal) günlük barlara göre kalibreydi; sentetik demo verisi bunu
gizlemişti. Gerçek veriyle haftalıkta 448/548 hisse sabit −5, saatlikte 545/611 hisse sabit −2
alıyordu — bileşen ayırt etmeyi bırakmıştı. `ATR_TIMEFRAME_SCALE` ile eşikler dilime göre
ölçekleniyor (katsayılar ölçülen medyan oranları: H 2,442 · S 0,262):

| Dilim | Önce | Sonra |
|---|---|---|
| Günlük | %83 ideal | %83 ideal — **değişmedi** |
| Haftalık | %82 sabit "aşırı volatil" | %87 ideal / %8 yüksek / %4 aşırı |
| Saatlik | %89 sabit "düşük volatilite" | %72 ideal / %15 yüksek / %9 aşırı |

`G: 1` kasıtlı — günlük tarama prototiple birebir kalır. `scripts/parity.ts` üç şeyi birden
doğrular: günlük skorlama birebir, **ATR dışı bileşenler her dilimde birebir** (ölçekleme sızıntı
yapmıyor), ve ölçekleme H/S'de fiilen etkin. Katsayıları yeniden türetmek için
`node scripts/atr-calibration.ts`.

**2. ~~Sektör bilgisi eksik.~~ ÇÖZÜLDÜ 2026-10-09.** Eskiden sektör prototipin küratörlü 158
hisselik listesinden tohumlanıyordu (155 eşleşme, 484 hisse "Diğer"). Artık kaynak KAP'ın
**Sektörler sayfası** (`https://www.kap.org.tr/tr/Sektorler`): sunucuda çizilen Next.js sayfası
tüm ana/alt sektör ağacını gömülü JSON olarak taşıyor, **tek istek** (~1 MB) yetiyor
(`src/providers/kap.ts` `getSectors` / `parseSectorsPage`). İlk canlı koşu: **651 hisseden 650'si
KAP sektörü aldı**, yalnızca KTEST sayfada yok; "Diğer" kalan 2 hisse (ADEL KAP'ta zaten "Diğer
İmalat", KTEST), toplam 32 etiket. KAP'ın uzun alt sektör adı (ör. "METAL EŞYA MAKİNE ELEKTRİKLİ
CİHAZLAR VE ULAŞIM ARAÇLARI") `src/providers/sector-labels.ts`'teki sabit tabloyla kısa etikete
çevriliyor (48 alt + 16 ana sektör adı; alt sektör tabloda yoksa ana sektörün etiketi, o da yoksa
"Diğer"). Sayfa okunamazsa `scripts/build-universe.ts` düşmez: her hisse `data/universe.json`'daki
önceki sektörünü korur, yeni hisseler "Diğer" olur ve CI'da `::warning::` basılır. KAP yeni bir
sektör adı çıkarırsa CI günlüğünde `::warning::Eşlenmemiş KAP sektörü: <ad> (<n> hisse)` görünür;
adı tabloya eklemek yeter. Prototip listesi artık yalnızca **ad** için okunuyor: 155 hissede elle
yazılmış kısa ad ("Türk Hava Yolları"), diğerlerinde KAP unvanı (`shortName`).

**3. Kapsam.** 639 koddan 619'u veri döndürüyor; 20'si Yahoo'da yok (borsa kotundan çıkmış veya
eski kodlar: `$TGB`, `$TIB`, `$YKB`…). Ayrıca yeni halka arzlar 120 barlık ısınmayı doldurmadığı
için taramada atlanıyor (günlük 21, haftalık 71, saatlik 8).

**4. KAP uçları resmî API değil.** Kimlik doğrulama istemiyorlar ama belgelenmiş de değiller;
habersiz değişebilirler. `robots.txt` standart dışı HTTP 666 döndürüyor — WAF agresif, istekleri
seyrek tut (~2 istek/sn üstüne çıkma).

**5. Sinyaller yalnızca kapanmış barlardan. ÇÖZÜLDÜ 2026-10-07.** Seans içi koşularda (CI her 15
dakikada bir çalışabiliyor) son bar henüz kapanmamışken skorlanıyordu; sinyal gün içinde gidip
gelebiliyordu. Artık `src/engine/bars.ts` son barın veri çekildiği anda (ingest başlangıcı,
`data/bars/{tf}.meta.json` `startedAt`) kapanıp kapanmadığına karar verir ve kapanmamışsa
**sinyal, skor ve tüm gösterge alanları bir önceki kapanmış bardan** hesaplanır; **fiyat ve
değişim en yeni bardan** (15 dk gecikmeli) gelir. Kurallar: günlük bar İstanbul 18:30'da kapanır
(kapanış seansı ~18:10 + 15 dk gecikme payı); haftalık bar haftanın Cuma 18:30'unda; saatlik bar
başlangıç + 60 dk (17:30 barı için 18:10) + 15 dk gecikme. Yahoo saatlik BIST barlarını yarım
saatte damgalıyor (09:30, 10:30 … 17:30, günde 9 bar — 618 hissede ölçüldü). Her satırda ve dosya
meta'sında `signalAsOf`, `lastBarClosed` (satırda ayrıca `priceAsOf`) alanları var. Bu kural tek
kopyadır: `lib/scan-data.ts`, `lib/detail.ts`, `scripts/scan.ts` ve `scripts/study.ts` hepsi
`src/engine/evaluate.ts` `evaluateBars`i çağırır. Aynı veride (2026-10-07 11:23 koşusu) günlük
tablonun 603 hissesinden 167'sinin sinyali eski davranışa göre değişti (eski: AL 101 · SAT 10,
yeni: AL 169 · SAT 4) — farkın büyük kısmı, 1,5 saatlik yarım barın düşük hacminin artık
skorlanmamasından.

**6. Kasıtlı sapma: `relVol` paydası. 2026-10-07.** Prototip 20 barlık hacim ortalamasına mevcut
barı da katıyordu; patlayan hacim kendi ortalamasını şişirip oranı küçültüyordu (20 sakin barın
ardından 10 katlık bar 10 değil 6,9 görünüyordu). Artık mevcut bar **önceki 20 barın**
ortalamasına bölünür. Grafikteki hacim ortalaması çizgisi (`volSMA`) klasik SMA20 olarak kaldı.
`scripts/parity.ts` relVol'ü prototip karşılaştırmasından çıkarır; yerine (a) port değerini
bağımsız yazılmış formülle birebir karşılaştırır, (b) 144 vakanın hepsinde prototipten farklı
olduğunu (değişiklik etkin) doğrular, (c) skor FONKSİYONUNUN değişmediğini, prototipin
`scoreOf`unu portun göstergeleriyle besleyip aynı sonucu alarak kanıtlar. Uçtan uca günlük skor
144 demo vakasının 12'sinde değişiyor (beklenen).

**7. Kasıtlı sapma: düz aralık stokastiği. 2026-10-07.** 14 barın en yükseği en düşüğüne eşitse
(fiyat hiç oynamamış, tipik olarak işlem görmeyen hisse) prototip ham %K'yı 0 veriyor ve "aşırı
satım" puanlıyordu. Artık ham %K = 50 (nötr). Demo serilerinde düz aralık hiç oluşmadığı için
parity'de %K/%D prototiple birebir kalır; ayrıca son 20 barı düzleştirilmiş 4 sentetik vakada
prototipin 0, portun 50 verdiği ve diğer tüm alanların birebir kaldığı doğrulanır.

**8. Veri kalitesi raporu ve eleme. 2026-10-07.** Ingest her dilim için
`data/bars/{tf}.quality.json` yazar (bar dizininin dışında, çünkü o dizindeki her dosya sembol
sayılıyor): inmeyen semboller (toplu istekte inmeyenler tek tek yeniden denenir, koşu başına ~20
eski/kottan çıkmış kod), bayat semboller (son barı koşunun en yeni seansından 3 seanstan fazla
geride), seans boşlukları, takvim delikleri ve şüpheli düzeltilmemiş kurumsal işlemler. Sıçrama
kuralı BIST ±%10 fiyat marjına dayanır: iki kapanış arasında k seans varsa oran (1 ± %11)^k
dışındaysa şüpheli (k = aradaki hafta içi gün; haftalıkta 5). Saatlikte baz, önceki seansın son
saatlik kapanışıdır ve resmî kapanıştan %1–3 sapabildiği için sınır %15 (%11 ile 268 sahte olay
çıkıyordu). Tarama, **bayat** ya da **göstergelerin son 70 barında (veya henüz kapanmamış son
barda) sıçrama** olan hisseye AL/SAT vermez, "elenen hisseler" listesine `bayat-veri` /
`fiyat-sicramasi` sebebiyle ve tarihli Türkçe açıklamayla koyar. Haftalık ve saatlik tarama
günlük raporun sıçramalarını da dikkate alır (haftalık sınır gevşek: günlükte görülen 29 olayın
21'i haftalıkta %25'ten büyük hareket olarak görünüyor). 2026-10-07 verisinde elenen: günlük 4,
haftalık 43, saatlik 2 hisse. Rapor yeniden üretmek için (ağa çıkmadan):
`python ingest/ingest.py --timeframe G --quality-only`.

Gözlemler (2026-10-07 koşusu):
- **Saat dilimi.** `yf.download` gün ve üstü aralıkta varsayılan olarak saat dilimini siliyor
  (naive yerel saat); pandas naive zaman damgasını UTC sayınca günlük bar 00:00 UTC = 03:00 TSİ
  olarak yazılıyordu (tarih doğru, an yanlış). Ingest artık `ignore_tz=False` ile çekip dizini
  açıkça `Europe/Istanbul`a çevirir: günlük/haftalık bar = TSİ 00:00. Kapanmış bar kuralı iki
  damgayla da aynı sonucu verir (test edildi), eski veri de doğru işlenir.
- **Yahoo 2026-10-06 günlük satırını düşürmüş:** 620 hissenin yalnızca 3'ünde var (saatlikte
  var). Rapor bunu `calendarHoles` altında gösterir; göstergeler 5 Ekim -> 7 Ekim'i ardışık bar
  sayar. Sıçrama kuralı aradaki hafta içi günü sayarak bunu sahte alarm saymaz (saymasaydı 60
  hisse elenirdi).
- **Bedelsiz/bölünme düzeltmesi (`auto_adjust=False` değiştirilmedi).** Yahoo'nun kendi kayıtlı
  bölünme/bedelsiz olaylarından 2 yıllık günlük pencereye düşen 180 olayın **172'sinde kapanış
  serisi süreklidir**, yani Yahoo `Close` zaten bölünmeye göre düzeltilmiş. Örnek: A1CAP için
  Yahoo 2025-02-18'de 5:1 olay kaydediyor; kapanışlar 17.02 4,812 -> 18.02 4,64 (-%3,6), sıçrama
  yok. `auto_adjust=True` yalnızca temettü düzeltmesi ekler, bölünme tarafını değiştirmez. Ama
  Yahoo **her olayı bilmiyor ve bazılarını hatalı uyguluyor**: 8 olayda Yahoo olayı kaydetmiş
  ama seride yine de sıçrama var (6'sı aynı gün, 2'si olaydan 1-3 gün önce; ör. EUREN); 43 düşüş
  (> %25) için Yahoo'da hiç kayıt yok (ör. BFREN 2025-04-28 -%74,9, 1'e 3 bedelsizle uyumlu). Saatlik seri çoğu zaman hiç düzeltilmemiş
  ham fiyat: KRTEK'te günlük seri 27.07'de, saatlik seri 03.08'de sıçrıyor. Bu yüzden kalite
  kapısı şart.

**9. ÇÖZÜLDÜ 2026-10-07: düz fiyatta RSI.** Fiyat 14 bar boyunca hiç değişmezse RSI
tanımsızdır; prototip 0 hesaplayıp "aşırı satım — tepki potansiyeli" (+3) puanlıyordu. Artık
nötr 50 (düz aralık stokastiğiyle aynı ilke; `tests/indicators.test.ts` sabitler). Not: aşağıdaki
çalışma rakamları bu düzeltmeden önce üretildi; işlem görmeyen hisseler en alt skor diliminde
birikiyordu (1. dilimin medyanı %0,00).

## İleri getiri çalışması

`scripts/study.ts` skorun sonraki getiriyi öngörüp öngörmediğini ölçer. Her hisse ve her kapanmış
gün t için skoru yalnızca t'ye kadarki barlarla hesaplar (göstergeler nedensel: seri bir kez
hesaplanıp t indeksinden okunur; `tests/study.test.ts` bunun taze bir taramayla birebir aynı
olduğunu ve t sonrası barları değiştirmenin t'deki skoru hiç değiştirmediğini kanıtlar), sonra 5
ve 20 seanslık ileri getiriyi ölçer. Sonuçlar gün içi kesitsel skor ondalık dilimine (eşit skorlar
aynı dilimde) ve sinyale (AL/NÖTR/SAT) göre: adet, ortalama, medyan, isabet oranı ve aynı gün
skorlanan tüm hisselerin eşit ağırlıklı ortalamasına göre fazla getiri. Göstergelerin 70 barlık
penceresinde ya da ileri pencerede şüpheli sıçrama olan gözlemler atlanır.

```bash
node scripts/study.ts --tf G --out public/data/study.json   # günlük, 5 ve 20 seans
node scripts/study.ts --tf H                                # haftalık, 1 ve 4 hafta
```

İlk sonuç (2026-10-07 verisi, 607 hisse, 2025-03-25 .. 2026-10-06, ~221 bin gözlem):
**skor öngörü gücü göstermiyor.**

| | 5 seans | 20 seans |
|---|---|---|
| En üst dilim (skor ort. 80) fazla getiri | +%0,02 | -%0,28 |
| En alt dilim (skor ort. 40) fazla getiri | %0,00 | +%0,69 |
| Üst - alt fark (günlük ort.) | +0,02 puan | **-0,98 puan** (günlerin %39'unda pozitif) |
| AL / NÖTR / SAT fazla getiri | +0,03 / -0,02 / +0,13 | -0,05 / -0,01 / **+0,87** |

Haftalık (2019-2026, 560 hisse) da aynı tablo: 1 ve 4 haftada üst - alt fark -0,06 / +0,07 puan.
Uyarılar (çıktıda da yazılı): hayatta kalma yanlılığı (yalnızca bugün işlem gören hisseler),
örtüşen pencereler (ardışık gözlemler bağımsız değil, "örtüşmesiz" satırı her h. günü kullanır),
yaklaşık 2 yıllık günlük veri ve tek piyasa rejimi, işlem maliyeti yok, kapanıştan işlem varsayımı.

## Sırada

- Next.js arayüzü — prototipin birebir yeniden inşası (bkz. `tasks/01-nextjs-ui.md`)
- KAP poller (seans içi 15–30 sn) + haber → hisse eşlemesi kalıcılaştırma
- Genel piyasa haber akışı: AA/Dünya/Ekonomim/Investing RSS (doğrulandı, çalışıyor)
