"""
BIST Radar — OHLCV ingest.

Bu, projedeki TEK Python bileşenidir ve kasıtlı olarak incedir: tek işi Yahoo Finance'ten
ham barları çekip diske yazmak. Node/TypeScript bu işi yapamıyor çünkü Yahoo, curl/undici
TLS parmak izlerini HTTP 429 ile reddediyor; yfinance'in altındaki curl_cffi Chrome'un TLS
el sıkışmasını taklit ederek geçiyor (2026-07-27'de ölçülerek doğrulandı).

Gösterge ve skor matematiği burada YOKTUR — o mantık TypeScript tarafında tek kopya hâlinde
durur (src/engine/), böylece prototiple birebir kalır.

Ek olarak (2026-10-07) her koşu bir VERİ KALİTESİ RAPORU yazar:
    data/bars/<TF>.quality.json
İçinde: inmeyen semboller, bayat semboller (son barı koşudaki en yeni seansın 3 seans
gerisinde), şüpheli düzeltilmemiş kurumsal işlem sıçramaları (bedelsiz/bölünme/bedelli ya da
veri hatası) ve seans boşlukları. Tarama (src/engine/evaluate.ts) bu raporu okuyup bayat ve
sıçramalı sembolleri AL/SAT vermek yerine "elenen hisseler" listesine taşır.

Rapor bilerek bar dizininin (data/bars/<TF>/) DIŞINDA durur: o dizindeki her *.json bir
sembol sayılıyor (tarama, scripts/atr-calibration.ts, CI'daki sembol sayacı).

Kullanım:
    python ingest/ingest.py --timeframe G --out data/bars
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

# (yfinance interval, period) — MIN_BARS=120 ısınma payını rahatça karşılar.
#
# Saatlikte "2y" değil "6mo": ölçüldü (2026-07-27, 119 hisse), 3962 bardan 450 bara
# inince göstergelerdeki en büyük göreli fark %0,0000 ve tek bir skor bile değişmiyor —
# EMA(26) o noktada çoktan yakınsamış oluyor. "6mo" ~880 bar verir, yani hâlâ bol paylı.
# Kazanç büyük: bar indirme iş akışı süresinin %83'ünü yiyordu ve saatlik onun en ağır
# parçasıydı. Bu kısaltma gün içi tazelemeyi mümkün kılıyor.
TIMEFRAMES = {
    "G": ("1d", "2y"),
    "H": ("1wk", "10y"),
    "S": ("1h", "6mo"),
}

BATCH_SIZE = 60
RETRIES = 3

# Toplu indirmeler arası bekleme (sn) — Yahoo'ya yükü yaymak için (~11 toplu istek/zaman dilimi).
BATCH_SLEEP_S = 1.0
# Toplu istekte inmeyen sembolleri TEK TEK yeniden denerken her istek arası bekleme (sn).
SINGLE_RETRY_SLEEP_S = 0.5

# BIST saati. 2016'dan beri yaz saati yok, sabit UTC+3; yine de sabit ofset yerine IANA adı
# kullanılır ki kural bir gün değişirse pandas/tzdata güncellemesiyle kendiliğinden düzelsin.
TZ = "Europe/Istanbul"

# --- Kalite kuralları --------------------------------------------------------------------
# BIST pay piyasası günlük fiyat marjı ±%10 (baz fiyat = önceki kapanış). Kapanıştan kapanışa
# %11'i aşan hareket marj içinde neredeyse imkânsız -> bedelsiz/bölünme/bedelli ya da veri hatası.
# %1 pay: Yahoo kapanışı ile resmî kapanış arasındaki küçük fark + fiyat adımı yuvarlaması.
JUMP_LIMIT = 0.11
# Saatlikte baz fiyat olarak önceki seansın SON SAATLİK kapanışı kullanılır; bu, resmî kapanışla
# (kapanış seansı fiyatı) aynı değil — 2026-10-07 ölçümü: AHGAZ 28,50 / 28,86, ANELE 99,00 / 96,10
# (%1-3 fark). %11 ile 154 sembolde 268 olay çıkıyordu ve günlük sıçramalarla yalnızca 2'si
# örtüşüyordu (sahte alarm); %15 ile 6 olay kalıyor ve 4'ü günlük veride görülen bölünmelerle
# aynı hisseler. Bu yüzden saatlik sınır %15.
JUMP_LIMIT_BY_TF = {"G": JUMP_LIMIT, "H": JUMP_LIMIT, "S": 0.15}
# Bir sembol, koşudaki en yeni seansın bu kadar seansından DAHA geride kalırsa "bayat" sayılır.
STALE_SESSIONS = 3
# Bir seansın "takvimde" sayılması için o tarihte aktif sembollerin en az bu oranında bar olmalı
# (tek bir sembolün tuhaf bir tarihi takvimi bozmasın).
CALENDAR_COVERAGE = 0.5
# Boşluk raporunda sembol başına listelenen en yeni eksik seans sayısı (dosya boyutu sınırı).
GAP_RECENT_LIST = 10


# ------------------------------------------------------------------------------------------
# Saf yardımcılar (ağ yok — tests/test_ingest.py bunları doğrudan test eder)
# ------------------------------------------------------------------------------------------


def to_istanbul_index(index):
    """Zaman damgası dizinini AÇIKÇA Europe/Istanbul'a çevirir.

    yfinance `download()` gün ve üstü aralıklarda varsayılan `ignore_tz=True` ile saat dilimini
    SİLER: dizin "naive" olur ve borsanın YEREL duvar saatini taşır (günlük bar = yerel 00:00).
    pandas naive bir `Timestamp.timestamp()`'i UTC kabul eder, yani eski kod günlük barı
    00:00 UTC = 03:00 İstanbul olarak yazıyordu (tarih doğru ama an yanlış; UTC tarihine bakan
    herhangi bir kod için bu tesadüfen çalışıyordu). Burada:
      - naive dizin  -> İstanbul yerel saati olarak etiketlenir (tz_localize),
      - tz'li dizin  -> İstanbul'a çevrilir (tz_convert).
    Sonuç: günlük/haftalık bar = İstanbul 00:00 (= önceki gün 21:00 UTC), saatlik bar = gerçek
    açılış anı.
    """
    if getattr(index, "tz", None) is None:
        return index.tz_localize(TZ)
    return index.tz_convert(TZ)


def frame_to_bars(sub) -> list[dict]:
    """Tek sembolün OHLCV DataFrame'ini bar sözlüklerine çevirir (t = epoch ms, gerçek an)."""
    sub = sub.dropna(subset=["Close"])
    if sub.empty:
        return []
    idx = to_istanbul_index(sub.index)
    bars: list[dict] = []
    for ts, (_, r) in zip(idx, sub.iterrows()):
        if not (r.Open == r.Open and r.Volume == r.Volume):  # NaN ele
            continue
        bars.append(
            {
                # tz'li Timestamp.timestamp() gerçek epoch saniyesidir (naive'in aksine).
                "t": int(round(ts.timestamp() * 1000)),
                "o": round(float(r.Open), 6),
                "h": round(float(r.High), 6),
                "l": round(float(r.Low), 6),
                "c": round(float(r.Close), 6),
                "v": float(r.Volume),
            }
        )
    return bars


def frame_to_splits(sub) -> list[dict]:
    """`actions=True` ile gelen 'Stock Splits' sütunundan Yahoo'nun bildiği bölünme/bedelsiz olayları."""
    if "Stock Splits" not in sub.columns:
        return []
    s = sub["Stock Splits"].dropna()
    s = s[s != 0]
    if s.empty:
        return []
    idx = to_istanbul_index(s.index)
    return [
        {"t": int(round(ts.timestamp() * 1000)), "date": ts.strftime("%Y-%m-%d"), "ratio": float(v)}
        for ts, v in zip(idx, s.values)
    ]


def ist_date(t_ms: int) -> str:
    """Epoch ms -> İstanbul takvim tarihi 'YYYY-MM-DD' (sabit UTC+3; 2016'dan beri yaz saati yok)."""
    return (datetime.fromtimestamp(t_ms / 1000, tz=timezone.utc) + timedelta(hours=3)).strftime("%Y-%m-%d")


def session_key(t_ms: int, tf: str) -> str:
    """Bayatlık ölçüsünün birimi: G ve S için işlem günü (İstanbul tarihi), H için haftanın tarihi."""
    return ist_date(t_ms)


def slot_key(t_ms: int, tf: str) -> str:
    """Boşluk kontrolünün birimi: G/H için tarih, S için tam bar anı (saat dilimi)."""
    if tf == "S":
        return str(t_ms)
    return ist_date(t_ms)


def build_calendar(keys_by_symbol: dict[str, list[str]], coverage: float = CALENDAR_COVERAGE) -> list[str]:
    """Koşunun ortak takvimi: o anahtarda AKTİF (ilk-son barı arasında) sembollerin en az
    `coverage` oranında bar olan anahtarlar, sıralı.

    "Aktif" paydası önemli: 10 yıllık haftalıkta 2020 sonrası halka arzlar eski haftaları
    kapsamaz; tüm sembollere bölseydik eski haftalar takvimden düşerdi.
    """
    all_keys = sorted({k for ks in keys_by_symbol.values() for k in ks})
    if not all_keys:
        return []
    pos = {k: i for i, k in enumerate(all_keys)}
    have = [0] * len(all_keys)
    active_diff = [0] * (len(all_keys) + 1)  # fark dizisi: aktif sembol sayısı
    for ks in keys_by_symbol.values():
        if not ks:
            continue
        uniq = sorted(set(ks))
        for k in uniq:
            have[pos[k]] += 1
        active_diff[pos[uniq[0]]] += 1
        active_diff[pos[uniq[-1]] + 1] -= 1
    out: list[str] = []
    active = 0
    for i, k in enumerate(all_keys):
        active += active_diff[i]
        if active > 0 and have[i] / active >= coverage:
            out.append(k)
    return out


def weekday_holes(calendar: list[str]) -> list[str]:
    """Takvimin ilk ve son günü arasında takvimde olmayan hafta içi (Pzt-Cum) tarihler, sıralı."""
    if not calendar:
        return []
    have = set(calendar)
    d = datetime.strptime(calendar[0], "%Y-%m-%d")
    end = datetime.strptime(calendar[-1], "%Y-%m-%d")
    out: list[str] = []
    while d <= end:
        k = d.strftime("%Y-%m-%d")
        if d.weekday() < 5 and k not in have:
            out.append(k)
        d += timedelta(days=1)
    return out


def weekdays_between(d0: str, d1: str) -> int:
    """(d0, d1] aralığındaki hafta içi gün sayısı ('YYYY-MM-DD'). Tatilleri de sayar (bilerek:
    sınırı yalnızca GEVŞETİR, sahte alarm üretmez)."""
    a = datetime.strptime(d0, "%Y-%m-%d")
    b = datetime.strptime(d1, "%Y-%m-%d")
    n = 0
    while a < b:
        a += timedelta(days=1)
        if a.weekday() < 5:
            n += 1
    return n


def week_end(d: str) -> str:
    """Bir tarihin haftasının Cuma'sı ('YYYY-MM-DD') — haftalık barın son seansı."""
    x = datetime.strptime(d, "%Y-%m-%d")
    return (x + timedelta(days=4 - x.weekday())).strftime("%Y-%m-%d")


def find_jumps(bars: list[dict], tf: str, limit: float | None = None) -> list[dict]:
    """Şüpheli düzeltilmemiş kurumsal işlem / veri hatası sıçramaları.

    Temel kural: iki kapanış arasında k seans varsa, ±%10 marj içinde oran en fazla (1+%11)^k,
    en az (1-%11)^k olabilir. k, aradaki hafta içi gün sayısıdır — böylece Yahoo'nun bir günü
    düşürmesi (2026-10-06'da TÜM semboller için oldu) ya da hissenin birkaç gün işlem görmemesi
    iki seanslık meşru hareketi sahte sıçrama gibi göstermez.
      G: kapanış / önceki kapanış; k = aradaki hafta içi gün (normalde 1).
      H: kapanış / önceki haftalık kapanış; k = iki haftanın Cuma'ları arasındaki hafta içi gün
         (ardışık haftalarda 5). Gevşek bir sınırdır (%50 bedelsizi kaçırabilir); tarama
         haftalık/saatlik için günlük raporun sıçramalarını da ayrıca dikkate alır (evaluate.ts).
      S: kapanış / ÖNCEKİ SEANSIN son saatlik kapanışı (= baz fiyat). Gün içi iki saatlik bar
         arasında -%10'dan +%10'a gidiş (%22) marj içinde mümkündür, ama baz fiyattan sapma k
         seansı aşamaz; bu yüzden saatlikte karşılaştırma baz fiyata yapılır, gün başına bir olay.
    Ayrıca sıfır/negatif kapanış her dilimde veri hatası sayılır.
    """
    out: list[dict] = []
    if limit is None:
        limit = JUMP_LIMIT_BY_TF.get(tf, JUMP_LIMIT)

    def bounds(k: int) -> tuple[float, float]:
        k = max(1, k)
        return (1 + limit) ** k, (1 - limit) ** k

    def rec(b: dict, ref: float, kind: str, k: int) -> dict:
        return {
            "t": b["t"],
            "date": ist_date(b["t"]),
            "prevClose": ref,
            "close": b["c"],
            "pct": round((b["c"] / ref - 1) * 100, 2) if ref > 0 else None,
            "sessions": k,
            "kind": kind,
        }

    if tf == "S":
        base: float | None = None  # önceki seansın son kapanışı
        base_day: str | None = None  # baz fiyatın seans tarihi
        cur_day: str | None = None
        last_close: float | None = None
        flagged_day: str | None = None
        for b in bars:
            d = ist_date(b["t"])
            if d != cur_day:
                base, base_day = last_close, cur_day
                cur_day = d
            if b["c"] <= 0:
                out.append(rec(b, base or 0.0, "gecersiz-fiyat", 1))
            elif base and base > 0 and base_day and flagged_day != d:
                k = weekdays_between(base_day, d)
                up, down = bounds(k)
                r = b["c"] / base
                if r > up or r < down:
                    out.append(rec(b, base, "sicrama", k))
                    flagged_day = d
            last_close = b["c"]
        return out

    for prev, b in zip(bars, bars[1:]):
        if b["c"] <= 0 or prev["c"] <= 0:
            out.append(rec(b, prev["c"], "gecersiz-fiyat", 1))
            continue
        d0, d1 = ist_date(prev["t"]), ist_date(b["t"])
        k = weekdays_between(week_end(d0), week_end(d1)) if tf == "H" else weekdays_between(d0, d1)
        up, down = bounds(k)
        r = b["c"] / prev["c"]
        if r > up or r < down:
            out.append(rec(b, prev["c"], "sicrama", k))
    return out


def quality_report(
    tf: str,
    bars_by_symbol: dict[str, list[dict]],
    requested: list[str],
    splits_by_symbol: dict[str, list[dict]] | None = None,
    retried_ok: list[str] | None = None,
    index_tz: str | None = None,
    now_ms: int | None = None,
) -> dict:
    """Bir zaman diliminin kalite raporunu üretir (saf fonksiyon; dosyaya yazmaz)."""
    splits_by_symbol = splits_by_symbol or {}
    missing = sorted(s for s in requested if s not in bars_by_symbol)

    # Bayatlık: ortak seans takvimine göre sembolün son seansından SONRA kaç seans var.
    sess = {s: [session_key(b["t"], tf) for b in bars] for s, bars in bars_by_symbol.items()}
    sess_cal = build_calendar(sess)
    stale: dict[str, dict] = {}
    newest_session = sess_cal[-1] if sess_cal else None
    newest_bar_at = max((bars[-1]["t"] for bars in bars_by_symbol.values() if bars), default=None)
    if sess_cal:
        import bisect

        for s, bars in bars_by_symbol.items():
            last = session_key(bars[-1]["t"], tf)
            behind = len(sess_cal) - bisect.bisect_right(sess_cal, last)
            if behind > STALE_SESSIONS:
                stale[s] = {"lastBarAt": bars[-1]["t"], "lastSession": last, "sessionsBehind": behind}

    # Boşluk: sembolün ilk ve son barı arasında, ortak takvimde olup sembolde olmayan anahtarlar.
    slots = {s: [slot_key(b["t"], tf) for b in bars] for s, bars in bars_by_symbol.items()}
    slot_cal = build_calendar(slots)
    gaps: dict[str, dict] = {}
    for s, ks in slots.items():
        if not ks:
            continue
        have = set(ks)
        lo, hi = ks[0], ks[-1]
        # Anahtarlar sözlük sırasıyla karşılaştırılır: tarih "YYYY-MM-DD" ve 13 haneli epoch ms
        # dizgeleri için sözlük sırası = zaman sırası.
        miss = [k for k in slot_cal if lo <= k <= hi and k not in have]
        if miss:
            recent = miss[-GAP_RECENT_LIST:]
            if tf == "S":
                recent = [datetime.fromtimestamp(int(k) / 1000, tz=timezone.utc).astimezone(
                    timezone(timedelta(hours=3))).strftime("%Y-%m-%d %H:%M") for k in recent]
            gaps[s] = {"count": len(miss), "recent": recent}

    # Takvim delikleri: ortak takvimde OLMAYAN hafta içi günler (G/S). Ya resmî tatildir ya da
    # Yahoo o günü TÜM semboller için düşürmüştür (2026-10-07'de görüldü: 5 günlük indirmede
    # THYAO.IS için 2026-10-06 satırı yoktu). Yukarıdaki kapsama oranlı boşluk kontrolü bunu
    # yakalayamaz (herkeste eksik olan gün takvime hiç girmez), o yüzden ayrı listelenir.
    calendar_holes = weekday_holes(sess_cal)[-GAP_RECENT_LIST * 2 :] if tf != "H" else []

    jumps: dict[str, list[dict]] = {}
    for s, bars in bars_by_symbol.items():
        js = find_jumps(bars, tf)
        if js:
            # Yahoo'nun bildiği bir bölünme/bedelsiz olayı ±3 gün içindeyse not düş: o zaman sıçrama
            # "Yahoo olayı biliyor ama fiyatı düzeltmemiş" demektir.
            sp = splits_by_symbol.get(s, [])
            for j in js:
                near = [x for x in sp if abs(x["t"] - j["t"]) <= 3 * 86_400_000]
                j["yahooSplit"] = near[0]["ratio"] if near else None
            jumps[s] = js

    return {
        "timeframe": tf,
        "generatedAt": now_ms if now_ms is not None else int(time.time() * 1000),
        "indexTz": index_tz,
        "rules": {
            "jumpLimitPct": JUMP_LIMIT_BY_TF.get(tf, JUMP_LIMIT) * 100,
            "jumpRule": "k seans arası oran > (1+limit)^k veya < (1-limit)^k; k = aradaki hafta içi gün",
            "staleSessions": STALE_SESSIONS,
            "calendarCoverage": CALENDAR_COVERAGE,
            "staleUnit": "hafta" if tf == "H" else "işlem günü",
        },
        "requested": len(requested),
        "written": len(bars_by_symbol),
        "newestBarAt": newest_bar_at,
        "newestSession": newest_session,
        "calendarSessions": len(sess_cal),
        "calendarHoles": calendar_holes,
        "missing": missing,
        "retriedOk": sorted(retried_ok or []),
        "stale": dict(sorted(stale.items())),
        "jumps": dict(sorted(jumps.items())),
        "gaps": dict(sorted(gaps.items())),
        "splits": dict(sorted((s, v) for s, v in splits_by_symbol.items() if v)),
    }


# ------------------------------------------------------------------------------------------
# Ağ katmanı
# ------------------------------------------------------------------------------------------


def load_universe(path: Path) -> list[str]:
    codes = json.loads(path.read_text(encoding="utf-8"))
    out: list[str] = []
    for entry in codes:
        sym = entry["symbol"] if isinstance(entry, dict) else entry
        # KAP bazı kayıtlarda çoklu kod veriyor: "A1CAP, ACP" -> ilkini al.
        out.append(sym.split(",")[0].strip().upper())
    return sorted(set(c for c in out if c and c != "-"))


def _download(tickers: list[str], interval: str, period: str):
    import yfinance as yf  # tembel içe aktarma: saf yardımcılar yfinance olmadan test edilebilsin

    last_err: Exception | None = None
    for attempt in range(RETRIES):
        try:
            return yf.download(
                tickers,
                period=period,
                interval=interval,
                group_by="ticker",
                # DEĞİŞTİRME: Yahoo'nun "Close"u zaten bölünme/bedelsize göre düzeltilmiş
                # (2026-10-07 ölçümü, README "Bilinen konular"); auto_adjust=True ayrıca
                # temettü düzeltmesi yapar ve prototiple kalibre edilen ölçeği kaydırır.
                auto_adjust=False,
                # Bölünme/bedelsiz olaylarını da getir (ek istek yok) — kalite raporu için.
                actions=True,
                # Saat dilimini SİLME — normalleştirmeyi to_istanbul_index açıkça yapar.
                ignore_tz=False,
                progress=False,
                threads=True,
            )
        except Exception as exc:  # ağ/oran sınırı — üstel geri çekilme
            last_err = exc
            time.sleep(2**attempt)
    raise RuntimeError(f"batch failed after {RETRIES} tries: {last_err}")


def _split_frame(df, tic: str, single: bool):
    """Toplu DataFrame'den tek sembolün alt tablosu (yoksa None)."""
    if df is None or df.empty:
        return None
    cols = df.columns
    if getattr(cols, "nlevels", 1) > 1:
        if tic not in cols.get_level_values(0):
            return None
        return df[tic]
    return df if single else None


def fetch_batch(
    symbols: list[str], interval: str, period: str
) -> tuple[dict[str, list[dict]], dict[str, list[dict]], list[str], str | None]:
    """Bir grup sembolü indirir; toplu istekte inmeyenleri tek tek yeniden dener.

    Dönüş: (barlar, bölünmeler, tekli denemede kurtarılanlar, ham dizin saat dilimi).
    """
    tickers = [f"{s}.IS" for s in symbols]
    df = _download(tickers, interval, period)
    index_tz = None if df is None or df.empty else str(getattr(df.index, "tz", None))

    out: dict[str, list[dict]] = {}
    splits: dict[str, list[dict]] = {}
    for sym, tic in zip(symbols, tickers):
        sub = _split_frame(df, tic, single=len(symbols) == 1)
        if sub is None:
            continue
        bars = frame_to_bars(sub)
        if bars:
            out[sym] = bars
            splits[sym] = frame_to_splits(sub)

    missing = [s for s in symbols if s not in out]
    recovered: list[str] = []
    if missing:
        print(f"    toplu istekte inmeyen {len(missing)}: {' '.join(missing)}", file=sys.stderr, flush=True)
        for sym in missing:
            time.sleep(SINGLE_RETRY_SLEEP_S)
            try:
                d1 = _download([f"{sym}.IS"], interval, period)
            except RuntimeError as exc:
                print(f"    {sym}: tekli deneme başarısız ({exc})", file=sys.stderr, flush=True)
                continue
            sub = _split_frame(d1, f"{sym}.IS", single=True)
            bars = frame_to_bars(sub) if sub is not None else []
            if bars:
                out[sym] = bars
                splits[sym] = frame_to_splits(sub)
                recovered.append(sym)
        still = [s for s in missing if s not in out]
        print(
            f"    tekli denemede kurtarılan {len(recovered)}, hâlâ yok {len(still)}"
            + (f": {' '.join(still)}" if still else ""),
            file=sys.stderr,
            flush=True,
        )
    return out, splits, recovered, index_tz


def recheck_quality(tf: str, out_root: Path) -> int:
    """Ağa ÇIKMADAN kalite raporunu diskteki barlardan yeniden üretir (kurallar değişince).

    Önceki raporun ağdan gelen kısımları (inmeyenler, Yahoo bölünme olayları, ham dizin tz)
    korunur; geri kalan her şey yeniden hesaplanır. Kullanım:
        python ingest/ingest.py --timeframe G --quality-only
    """
    bar_dir = out_root / tf
    prev_path = out_root / f"{tf}.quality.json"
    prev = json.loads(prev_path.read_text(encoding="utf-8")) if prev_path.exists() else {}
    meta_path = out_root / f"{tf}.meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    bars = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in sorted(bar_dir.glob("*.json"))}
    requested = sorted(set(bars) | set(prev.get("missing", [])))
    report = quality_report(
        tf,
        bars,
        requested,
        splits_by_symbol=prev.get("splits", {}),
        retried_ok=prev.get("retriedOk", []),
        index_tz=prev.get("indexTz"),
        now_ms=meta.get("fetchedAt"),
    )
    prev_path.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(
        f"{tf} (yeniden): eksik {len(report['missing'])} · bayat {len(report['stale'])} · "
        f"sıçrama {len(report['jumps'])} sembol · boşluklu {len(report['gaps'])} sembol",
        file=sys.stderr,
    )
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeframe", choices=sorted(TIMEFRAMES), default="G")
    ap.add_argument("--universe", type=Path, default=Path("data/universe.json"))
    ap.add_argument("--out", type=Path, default=Path("data/bars"))
    ap.add_argument("--limit", type=int, default=0, help="ilk N sembol (deneme için)")
    ap.add_argument(
        "--quality-only",
        action="store_true",
        help="indirme yapma; kalite raporunu diskteki barlardan yeniden üret",
    )
    args = ap.parse_args()
    if args.quality_only:
        return recheck_quality(args.timeframe, args.out)

    import yfinance as yf

    interval, period = TIMEFRAMES[args.timeframe]
    symbols = load_universe(args.universe)
    if args.limit:
        symbols = symbols[: args.limit]

    out_dir = args.out / args.timeframe
    out_dir.mkdir(parents=True, exist_ok=True)

    all_bars: dict[str, list[dict]] = {}
    all_splits: dict[str, list[dict]] = {}
    recovered: list[str] = []
    index_tzs: set[str] = set()
    t0 = time.time()
    # Koşunun BAŞLANGIÇ anı: kapanmış bar kararının referansı (bkz. src/engine/bars.ts). Bitiş
    # anı (fetchedAt) 2-4 dk sonra olur; o arada kapanan bir bar ilk toplu istekte henüz açıktı.
    started_at = int(t0 * 1000)
    for i in range(0, len(symbols), BATCH_SIZE):
        if i:
            time.sleep(BATCH_SLEEP_S)
        chunk = symbols[i : i + BATCH_SIZE]
        got, splits, rec, tz = fetch_batch(chunk, interval, period)
        if tz is not None:
            index_tzs.add(tz)
        for sym, bars in got.items():
            (out_dir / f"{sym}.json").write_text(json.dumps(bars), encoding="utf-8")
        all_bars.update(got)
        all_splits.update(splits)
        recovered.extend(rec)
        print(
            f"  {i + len(chunk):4d}/{len(symbols)}  yazılan={len(all_bars)}",
            file=sys.stderr,
            flush=True,
        )

    elapsed = time.time() - t0
    total = len(all_bars)
    fetched_at = int(time.time() * 1000)
    meta = {
        "timeframe": args.timeframe,
        "interval": interval,
        "period": period,
        "requested": len(symbols),
        "written": total,
        "fetchedAt": fetched_at,
        "startedAt": started_at,
        "source": "yahoo-finance (yfinance %s)" % yf.__version__,
    }
    (args.out / f"{args.timeframe}.meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    report = quality_report(
        args.timeframe,
        all_bars,
        symbols,
        splits_by_symbol=all_splits,
        retried_ok=recovered,
        index_tz=",".join(sorted(index_tzs)) or None,
        now_ms=fetched_at,
    )
    (args.out / f"{args.timeframe}.quality.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(
        f"{args.timeframe}: {total}/{len(symbols)} sembol, {elapsed:.1f}s  |  kalite: "
        f"eksik {len(report['missing'])} · bayat {len(report['stale'])} · "
        f"sıçrama {len(report['jumps'])} sembol · boşluklu {len(report['gaps'])} sembol · "
        f"Yahoo bölünme olayı {len(report['splits'])} sembol · ham dizin tz={report['indexTz']}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
