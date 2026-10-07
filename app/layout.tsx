import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Inter yazı tipi artık depodaki dosyalardan gelir (next/font/local), Google Fonts'tan DEĞİL:
// 2026-10-06'da CI derlemesi Google Fonts'a erişemediği için çöktü. Dosyalar
// @fontsource-variable/inter 5.3.0 paketinden alındı; lisans: app/fonts/Inter-OFL-LICENSE.txt.
//
// Değişken (variable) font: tek dosya 100-900 arası TÜM ağırlıkları içerir; eski 400/500/600
// ağırlıkları aynen çalışır. Türkçe için iki alt küme gerekir: `latin` (Ç Ö Ü ı ve ASCII) ve
// `latin-ext` (Ğ ğ İ Ş ş). Tarayıcı `unicode-range` sayesinde yalnızca sayfada gerçekten
// kullanılan alt kümeyi indirir.
// DİKKAT: next/font seçenekleri derleme zamanında statik okunur; aralıklar bu yüzden sabit değişkene
// konmadan doğrudan yazıldı (değişken kullanılırsa derleme "must be a literal" hatası verir).
const interLatin = localFont({
  src: "./fonts/inter-latin-wght-normal.woff2",
  weight: "100 900", // değişken ağırlık aralığı
  style: "normal",
  display: "swap", // font inene kadar sistem fontu görünür, metin hiç gizlenmez
  declarations: [{ prop: "unicode-range", value: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" }],
  variable: "--font-inter-latin", // CSS değişkeni adı (aşağıda --font-inter olarak birleştirilir)
});

const interLatinExt = localFont({
  src: "./fonts/inter-latin-ext-wght-normal.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  declarations: [{ prop: "unicode-range", value: "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF" }],
  adjustFontFallback: false, // yedek-font ölçü ayarı zaten `interLatin` için üretildi
  variable: "--font-inter-ext",
});

export const metadata: Metadata = {
  title: "BIST Radar",
  description: "Borsa İstanbul teknik tarama platformu — 600+ hisse, gerçek zamana yakın gösterge ve skor.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="tr"
      className={`${interLatin.variable} ${interLatinExt.variable}`}
      // globals.css `var(--font-inter)` bekler (eski adı koruduk, stiller değişmedi). İki alt kümeyi
      // tek yığında birleştiriyoruz; tarayıcı karakter başına doğru dosyayı seçer. SIRA ÖNEMLİ:
      // `ext` önce gelir, çünkü `latin` değişkeni Arial'li bir yedek font da içerir ve o yedeğin
      // unicode-range'i yoktur (her karakteri karşılar); `ext` ondan sonra gelseydi Ğ/Ş/İ'ye hiç ulaşılmazdı.
      style={{ "--font-inter": "var(--font-inter-ext), var(--font-inter-latin)" } as React.CSSProperties}
    >
      <body>{children}</body>
    </html>
  );
}
