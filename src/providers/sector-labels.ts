/**
 * KAP sektör adı -> arayüzde gösterilen kısa Türkçe etiket.
 *
 * NEDEN sabit tablo: KAP'ın alt sektör adları uzun ("METAL EŞYA MAKİNE ELEKTRİKLİ CİHAZLAR VE
 * ULAŞIM ARAÇLARI") ve 57 tane; tablo sütununa ve sektör filtresine sığmaz. Eşleme sahibinin
 * kararı (2026-10-09): birbirine yakın alt sektörler aynı etikette toplanır (ör. üç turizm alt
 * sektörü -> "Turizm"), toplam etiket sayısı 32'yi geçmez (testte korunur).
 *
 * EŞLEŞME KURALI: adlar KAP'ın yazdığı gibi, BİREBİR karşılaştırılır (Türkçe büyük harf: İ, Ş,
 * Ğ, Ü, Ö, Ç). Büyük/küçük harf dönüşümü kasıtlı olarak YAPILMAZ: `toUpperCase()` "i"yi "I"ya
 * çevirir (Türkçe "İ" değil) ve sessizce eşleşmeyen anahtarlar üretir. Yalnızca baş/son ve
 * çoklu boşluk normalleştirilir — KAP'ın HTML'i arada bir fazladan boşluk taşıyabiliyor.
 *
 * YENİ KAP SEKTÖRÜ ÇIKARSA: `sectorLabel` `mapped: false` döner, scripts/build-universe.ts
 * CI günlüğüne `::warning::Eşlenmemiş KAP sektörü: <ad> (<n> hisse)` basar. Bu durumda hisse
 * yine ana sektörün etiketini (o da yoksa "Diğer") alır; adı aşağıdaki tabloya eklemek yeter.
 */
import { normalizeSectorName, type KapSector } from "./kap.ts";

/**
 * KAP ALT sektör adı -> etiket (48 ad). KAP'ta 57 alt sektör var; burada olmayan 9'u
 * (ör. "VETERİNERLİK HİZMETLERİ", "DİĞER MALİ KURULUŞLAR") 2026-10-09'da hiç hisse kodu
 * taşımıyordu (boş liste) — kod kazanırlarsa ana sektör etiketine düşer ve uyarı üretir.
 */
export const SUB_SECTOR_LABELS: Readonly<Record<string, string>> = Object.freeze({
  // Mali kuruluşlar
  "BANKALAR": "Bankacılık",
  "HOLDİNGLER VE YATIRIM ŞİRKETLERİ": "Holding",
  "GAYRİMENKUL YATIRIM ORTAKLIKLARI": "GYO",
  "GAYRİMENKUL FAALİYETLERİ": "Gayrimenkul",
  "MENKUL KIYMET YATIRIM ORTAKLIKLARI": "Yatırım Ortaklığı",
  "GİRİŞİM SERMAYESİ YATIRIM ORTAKLIKLARI": "Yatırım Ortaklığı",
  "ARACI KURUMLAR": "Aracı Kurum",
  "FİNANSAL KİRALAMA VE FAKTORİNG ŞİRKETLERİ": "Finansman",
  "FİNANSMAN ŞİRKETLERİ": "Finansman",
  "VARLIK YÖNETİM ŞİRKETLERİ": "Finansman",
  "SİGORTA ŞİRKETLERİ": "Sigorta",
  // İmalat
  "KİMYA İLAÇ PETROL LASTİK VE PLASTİK ÜRÜNLER": "Kimya-Petrol",
  "GIDA, İÇECEK VE TÜTÜN": "Gıda-İçecek",
  "METAL EŞYA MAKİNE ELEKTRİKLİ CİHAZLAR VE ULAŞIM ARAÇLARI": "Metal Eşya-Makine",
  "ANA METAL SANAYİ": "Demir-Çelik",
  "TAŞ VE TOPRAĞA DAYALI": "Taş-Toprak",
  "TEKSTİL, GİYİM EŞYASI VE DERİ": "Tekstil",
  "KAĞIT VE KAĞIT ÜRÜNLERİ BASIM": "Kağıt-Basım",
  "ORMAN ÜRÜNLERİ VE MOBİLYA": "Orman-Mobilya",
  "DİĞER İMALAT SANAYİİ": "Diğer",
  // Enerji (petrol/gaz çıkarımı KAP'ta madencilik altında; yatırımcı gözüyle enerji)
  "ELEKTRİK GAZ VE BUHAR": "Enerji",
  "HAM PETROL VE DOĞAL GAZ ÇIKARTILMASI": "Enerji",
  // Teknoloji, bilgi ve iletişim
  "BİLİŞİM": "Bilişim",
  "BİLGİ HİZMET FAALİYETLERİ": "Bilişim",
  "TELEKOMÜNİKASYON": "Telekom",
  "YAYIMCILIK": "Medya",
  "REKLAMCILIK VE PAZAR ARAŞTIRMASI": "Medya",
  "SAVUNMA": "Savunma",
  // Ticaret ve inşaat
  "PERAKENDE TİCARET": "Perakende",
  "TOPTAN TİCARET": "Toptan Ticaret",
  "İNŞAAT VE BAYINDIRLIK İŞLERİ": "İnşaat",
  // Mesleki, idari ve destek hizmetleri
  "MİMARLIK VE MÜHENDİSLİK FAALİYETLERİ; TEKNİK MUAYENE VE ANALİZ": "Hizmetler",
  "BÜRO YÖNETİMİ, BÜRO DESTEĞİ VE DİĞER ŞİRKET DESTEK FAALİYETLERİ": "Hizmetler",
  "HUKUK VE MUHASEBE FAALİYETLERİ": "Hizmetler",
  "KİRALAMA VE LEASING FAALİYETLERİ": "Hizmetler",
  // Ulaştırma, turizm
  "ULAŞTIRMA VE DEPOLAMA": "Ulaştırma",
  "KONAKLAMA": "Turizm",
  "YİYECEK VE İÇECEK HİZMETLERİ": "Turizm",
  "SEYAHAT ACENTESİ, TUR OPERATÖRÜ VE DİĞER REZERVASYON HİZMETLERİ İLE İLGİLİ FAALİYETLER": "Turizm",
  // Sağlık, spor, eğlence
  "İNSAN SAĞLIĞI VE SOSYAL HİZMETLER": "Sağlık",
  "SPOR FAALİYETLERİ EĞLENCE VE OYUN FAALİYETLERİ": "Spor-Eğlence",
  "YARATICI SANATLAR GÖSTERİ SANATLARI VE EĞLENCE FAALİYETLERİ": "Spor-Eğlence",
  "SPOR EĞLENCE BOŞ ZAMANLARI DEĞERLENDİRME HİZMETLERİ": "Spor-Eğlence",
  // Tarım ve madencilik
  "TARIM VE HAYVANCILIK AVCILIK VE İLGİLİ HİZMET FAALİYETLERİ": "Tarım",
  "BALIKÇILIK VE SU ÜRÜNLERİ": "Tarım",
  "METAL CEVHERİ MADENCİLİĞİ": "Madencilik",
  "KÖMÜR VE LİNYİT MADENCİLİĞİ": "Madencilik",
  "DİĞER MADENCİLİK VE TAŞ OCAKÇILIĞI": "Madencilik",
});

/**
 * KAP ANA sektör adı -> etiket. Yalnızca yedek: hisse alt sektörsüz geldiğinde (`sub` null;
 * 2026-10-09'da böyle kod yoktu) ya da alt sektörü tabloda olmadığında kullanılır. "İMALAT" bilerek
 * "Diğer": imalat tek etikete sığmayacak kadar geniş; alt sektörü olmayan imalatçıyı "İmalat"
 * diye ayrı bir kümeye koymak filtrede yanıltıcı olurdu.
 */
export const MAIN_SECTOR_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "TARIM, ORMANCILIK VE BALIKÇILIK": "Tarım",
  "MADENCİLİK VE TAŞ OCAKÇILIĞI": "Madencilik",
  "İMALAT": "Diğer",
  "ELEKTRİK GAZ VE SU": "Enerji",
  "İNŞAAT VE BAYINDIRLIK": "İnşaat",
  "TOPTAN VE PERAKENDE TİCARET": "Perakende",
  "ULAŞTIRMA VE DEPOLAMA": "Ulaştırma",
  "MALİ KURULUŞLAR": "Finansman",
  "EĞİTİM SAĞLIK SPOR VE EĞLENCE HİZMETLERİ": "Hizmetler",
  "TEKNOLOJİ": "Bilişim",
  "MESLEKİ, BİLİMSEL VE TEKNİK FAALİYETLER": "Hizmetler",
  "İDARİ VE DESTEK HİZMET FAALİYETLERİ": "Hizmetler",
  "GAYRİMENKUL FAALİYETLERİ": "Gayrimenkul",
  "OTELLER VE LOKANTALAR": "Turizm",
  "BİLGİ VE İLETİŞİM": "Bilişim",
  "DİĞER": "Diğer",
});

/** Etiket bulunamadığında ve KAP'ta hiç olmayan hissede kullanılan etiket. */
export const FALLBACK_LABEL = "Diğer";

/**
 * KAP sektörünü etikete çevirir. Öncelik: alt sektör tablosu -> ana sektör tablosu -> "Diğer".
 *
 * `mapped` bayrağı "KAP'ın verdiği ad tablolarımızda TAM karşılık buldu mu" sorusunun cevabı;
 * build-universe.ts uyarıyı buna bakarak basar:
 *  - alt sektör tabloda                         -> alt etiketi,  mapped: true
 *  - alt sektör yok (null), ana tabloda         -> ana etiketi,  mapped: true
 *  - alt sektör VAR ama tabloda yok, ana tabloda -> ana etiketi,  mapped: false (etiket makul,
 *    ama yeni bir KAP alt sektörü çıkmış demek: CI'da görünmeli)
 *  - ikisi de tabloda yok                       -> "Diğer",      mapped: false
 *  - `undefined` (hisse KAP sayfasında yok)      -> "Diğer",      mapped: true — bu "tanımadığımız
 *    bir KAP adı" değil, verinin yokluğu; uyarı listesini kirletmemeli.
 */
export function sectorLabel(s: KapSector | undefined): { label: string; mapped: boolean } {
  if (s === undefined) return { label: FALLBACK_LABEL, mapped: true };
  const sub = s.sub === null ? null : normalizeSectorName(s.sub);
  const main = normalizeSectorName(s.main);

  if (sub !== null && Object.hasOwn(SUB_SECTOR_LABELS, sub)) {
    return { label: SUB_SECTOR_LABELS[sub], mapped: true };
  }
  if (Object.hasOwn(MAIN_SECTOR_LABELS, main)) {
    // Alt sektör hiç yoksa ana etiket tam karşılıktır; varsa ama tanımıyorsak değildir.
    return { label: MAIN_SECTOR_LABELS[main], mapped: sub === null };
  }
  return { label: FALLBACK_LABEL, mapped: false };
}
