# GitHub Pages'e kurulum

Bu belge **BIST Radar 2** (`mrtndy/bist-radar-2`) içindir; canlı v1 (`mrtndy/bist-radar`) ayrı kalır.

Site sunucusuz çalışır: GitHub Actions her akşam veriyi çeker, hesabı yapar ve statik siteyi
yayınlar. Senin bilgisayarının açık olmasına gerek yoktur.

## Neden bu iş görüyor

Hesaplanmış çıktının tamamı **2,8 MB** (üç zaman diliminin tarama sonuçları + 619 hissenin detay
serileri, gzip'li). GitHub Pages sınırı 1 GB — yani limitin binde 3'ü. Ağır olan ham barlar
(259 MB) hiçbir zaman yayınlanmaz; yalnızca Actions sunucusunda geçici olarak durur.

## Bir kerelik kurulum

**1. Depoyu oluştur ve gönder.** Depo **public olmalı** — GitHub Pages ücretsiz planda yalnızca
public depodan yayın yapar (private depo için GitHub Pro gerekir). Projede parola/anahtar yok,
veriler zaten kamuya açık piyasa verisi.

```bash
cd "<bu deponun yolu>/bist-radar-2"
git remote add origin https://github.com/<kullanıcı-adın>/bist-radar-2.git
git push -u origin main
```

**2. Pages'i aç.** Depo → Settings → Pages → *Build and deployment* → Source: **GitHub Actions**.
(Klasik "Deploy from a branch" seçeneğini SEÇME — workflow Actions üzerinden yayınlıyor.)

**3. İlk yayını elle tetikle.** Actions sekmesi → "Veriyi tazele ve yayınla" → *Run workflow*.
İlk koşu ~8-10 dakika sürer (barların indirilmesi dahil).

Site adresi: `https://<kullanıcı-adın>.github.io/bist-radar-2/` (basePath, workflow içinde depo adından otomatik türetilir)

## Zamanlama

Şu an tek aktif zamanlama: hafta içi her gün **16:00 UTC = 19:00 TSİ**, yani BIST kapanışından ~50 dakika sonra (`cron: "0 16 * * 1-5"`). Seans içi 15 dakikalık cron (`*/15 7-15 * * 1-5`) `deploy.yml` içinde **yorum satırıdır**: v1 hâlâ canlı ve o cron'u çalıştırıyor; ikisi birlikte çalışırsa Yahoo trafiği ikiye katlanır. v2, v1'in yerine geçtiğinde o satırın `# ` işareti kaldırılır ve v1'in workflow'u kapatılır (adımlar için `README.md` başındaki "BIST Radar 2" bölümü).
GitHub'ın zamanlanmış işleri yoğunlukta 5-30 dakika gecikebilir; gün sonu verisi için önemsiz.
İstediğin an Actions sekmesinden elle de tetikleyebilirsin.

## Seans içinde elle tetiklersen

Zamanlanmış koşu kapanıştan sonra çalıştığı için günlük barlar tamamlanmış olur. Seans
sırasında tetiklenen bir koşuda o günün barı henüz kapanmamıştır. v2'de (2026-10-07) bu bar
**sinyale katılmaz**: göstergeler ve AL/SAT bir önceki kapanmış bardan hesaplanır, yalnızca
fiyat ve günlük değişim en yeni bardan gelir. Üst çubukta "(sinyal: … barı)" notu bunu
gösterir. v1'de göstergeler yarım bar üzerinden hesaplanıyor ve sinyal gün içinde dönebiliyordu.

Ayrıca veri her hâlükârda **15 dakika gecikmelidir** (2026-07-27 seans içinde ölçüldü: saat 15:51
iken Yahoo'nun son 1 dakikalık barı 15:36). Emir vermeden önce canlı fiyata aracı kurum
uygulamandan bak.

## İlk koşuda dikkat edilecek şey

**Yahoo Finance'in GitHub sunucularına izin verip vermediği bilinmiyor.** Yahoo, bulut IP'lerini
(Actions sunucuları Azure'da) yerel bilgisayarlara göre daha sert sınırlayabiliyor. Bu ancak
gerçek bir koşuyla anlaşılır.

Workflow bunu sessizce geçmez: her zaman dilimi için en az **400 sembol** inmediyse yayını
durdurur ve hata verir. Yani en kötü ihtimalle site eski hâliyle kalır, boş/eksik veriyle
güncellenmez. Actions kayıtlarında şuna benzer bir satır görürsen sorun budur:

```
G için yalnızca 12 sembol indi (asgari 400). Yahoo bu sunucuyu sınırlıyor olabilir…
```

Bu durumda seçenekler:
- Veri kaynağını İş Yatırım'a çevirmek (düz curl ile çalışıyor, engellenme ihtimali düşük) —
  ama açılış fiyatı vermiyor ve saatlik verisi yok, yani saatlik dilim kaybedilir.
- Veriyi kendi bilgisayarında üretip yalnızca sonucu (2,8 MB) push'lamak; Actions sadece yayınlar.
- Cloudflare Workers gibi başka bir zamanlayıcıya taşımak.

## Workflow güvenliği

- **İzinler iş bazında:** üst düzey `contents: read`; `build` yalnızca okur, `deploy` yalnızca `pages: write` + `id-token: write`, `keepalive` yalnızca `contents: write` alır.
- **Eylemler SHA'ya sabit:** her `uses:` tam commit SHA'sıdır, sürüm satır sonu yorumunda. Güncellemek için `gh api repos/<sahip>/<eylem>/git/ref/tags/<etiket>` ile yeni SHA'yı bul.
- **Testler:** bağımlılıklardan sonra `npm test` ve `python -m unittest discover -s tests -p "test_*.py"` çalışır; biri kırılırsa Yahoo'ya hiç gidilmez.
- **Python sürümleri sabit:** `ingest/requirements.txt` içinde `yfinance==1.7.0`, `curl_cffi==0.16.3`.

## Bilinen GitHub sınırları

| | Sınır | Bizim durumumuz |
|---|---|---|
| Pages site boyutu | 1 GB | 2,8 MB |
| Pages bant genişliği | 100 GB/ay (yumuşak) | tek kullanıcı |
| Pages derleme | saatte 10 (yumuşak) | günde 1 (15 dk'lık cron açılırsa günde ~36 + akşam) |
| Actions dakikası | public depoda ücretsiz | koşu başına ~8-10 dk |
| Zamanlanmış iş | **60 gün commit gelmezse kapanır** | `keepalive` işi ayda bir boş commit atıyor |

`keepalive` işini ilk 60 günden sonra bir kez kontrol et — GitHub'ın bot commit'lerini "aktivite"
sayıp saymadığı belgelerde net değil, bu yüzden ölçerek doğrulanmalı.

## Gün içi tazeleme istenirse

Şu anki kurulum günde bir kez çalışır (seans içi cron terfiye kadar kapalı; bkz. Zamanlama). Gün içinde de tazelemek teknik olarak mümkün ama GitHub
bunun için uygun değil: Pages'in saatte 10 derleme sınırı ve cron'un 5-30 dakikalık gecikmesi
"15 dakikada bir" gibi bir hedefi güvenilmez kılıyor. Gerçekten gerekiyorsa Cloudflare Pages +
Workers Cron daha uygun; orada kaynak private de kalabilir.

Not: veri her hâlükârda ~15 dakika gecikmeli (bkz. `README.md`). Gün içi tazeleme fiyatı
canlı yapmaz, yalnızca gün boyu hareket etmesini sağlar.
