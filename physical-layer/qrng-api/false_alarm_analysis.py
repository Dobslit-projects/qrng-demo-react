# -*- coding: utf-8 -*-
"""Analise de falso alarme de RCT/APT na vazao REAL do pipeline Kapua QRNG.

Standalone (stdlib apenas). Reproduz a secao 12 de RCT_APT_REVIEW.md.
NAO altera o modulo de health tests -- so calcula.

Uso:  python3 false_alarm_analysis.py
"""
import math

# ---------------------------------------------------------------------------
# Binomial exato (lgamma) -- independente do modulo de health tests.
def _log_binom_pmf(n, k, p):
    if k < 0 or k > n:
        return -math.inf
    return (math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1)
            + k * math.log(p) + (n - k) * math.log1p(-p))


def _binom_cdf(n, c, p):
    return min(sum(math.exp(_log_binom_pmf(n, k, p)) for k in range(0, c + 1)), 1.0)


def _binom_sf_ge(n, c, p):
    """P(X >= c) para X ~ Binomial(n, p)."""
    if c <= 0:
        return 1.0
    return max(0.0, 1.0 - _binom_cdf(n, c - 1, p))


def _critbinom(n, p, q):
    lo, hi = 0, n
    while lo < hi:
        mid = (lo + hi) // 2
        if _binom_cdf(n, mid, p) >= q:
            hi = mid
        else:
            lo = mid + 1
    return lo


def apt_cutoff(H, W=512, alpha=2 ** -20):
    return 1 + _critbinom(W, 2.0 ** (-H), 1.0 - alpha)


def rct_cutoff(H, alpha=2 ** -20):
    return 1 + math.ceil(-math.log2(alpha) / H)


# ---------------------------------------------------------------------------
# Vazao real, medida em 2026-08-27 via GET http://127.0.0.1:18001/health
# (upstream server_api.py). total_pushed avancou 40_837_572 bytes em 60 s.
BYTES_PER_S = 40_837_572 / 60.0
WORDS_PER_S = BYTES_PER_S / 4.0            # uint32-LE transport words
SYM_PER_S_PER_LANE = WORDS_PER_S           # 1 byte / word / lane
W = 512
LANES = {0: 6.978486, 1: 7.312323, 2: 7.331528, 3: 7.182924}


def rct_trigger_per_position(H, C, uniform=False):
    p = 1.0 / 256 if uniform else 2.0 ** (-H)
    return (1.0 - p) * p ** (C - 1)


def apt_trigger_per_window(H, C, uniform=False):
    p = 1.0 / 256 if uniform else 2.0 ** (-H)
    return _binom_sf_ge(W - 1, C - 1, p)   # matches (sem a referencia) >= C-1


def aggregate_rate(alpha, uniform=False):
    rct = {L: rct_cutoff(H, alpha) for L, H in LANES.items()}
    apt = {L: apt_cutoff(H, W, alpha) for L, H in LANES.items()}
    win_per_s = SYM_PER_S_PER_LANE / W
    r_rct = sum(SYM_PER_S_PER_LANE * rct_trigger_per_position(LANES[L], rct[L], uniform) for L in LANES)
    r_apt = sum(win_per_s * apt_trigger_per_window(LANES[L], apt[L], uniform) for L in LANES)
    return rct, apt, r_rct, r_apt, r_rct + r_apt


def human(seconds):
    if seconds <= 0 or seconds == math.inf:
        return "nunca"
    for unit, size in (("s", 1), ("min", 60), ("h", 3600), ("dia", 86400), ("ano", 86400 * 365)):
        if seconds < 60 * size or unit == "ano":
            return f"{seconds / size:.2f} {unit}"
    return f"{seconds:.0f} s"


if __name__ == "__main__":
    print(f"taxa da fonte: {BYTES_PER_S:.0f} B/s -> {WORDS_PER_S:.0f} words/s "
          f"-> {SYM_PER_S_PER_LANE:.0f} simbolos/s/lane (x4 = {4*SYM_PER_S_PER_LANE:.0f}/s)")
    print("\nalpha   RCT/lane  APT/lane           agg worst-case      agg iid-uniforme")
    for ae in (20, 24, 28, 30, 34, 38, 40):
        a = 2.0 ** (-ae)
        rct, apt, _, _, agg_wc = aggregate_rate(a, uniform=False)
        _, _, _, _, agg_un = aggregate_rate(a, uniform=True)
        print(f"2^-{ae:<3} {list(rct.values())}  {list(apt.values())}  "
              f"1 a cada {human(1/agg_wc):>10}   1 a cada {human(1/agg_un):>10}")

    print("\nalpha necessario para o objetivo (modelo worst-case):")
    for label, target_s in (("1/dia", 86400), ("1/mes", 86400 * 30), ("1/ano", 86400 * 365)):
        chosen = None
        ae10 = 200
        while ae10 <= 600:
            a = 2.0 ** (-(ae10 / 10.0))
            _, _, _, _, agg = aggregate_rate(a)
            if agg > 0 and 1.0 / agg >= target_s:
                chosen = (ae10 / 10.0, aggregate_rate(a))
                break
            ae10 += 1
        if chosen:
            ae, (rct, apt, _, _, agg) = chosen
            print(f"  {label:6}: alpha <= 2^-{ae:.1f}  RCT/lane={list(rct.values())}  "
                  f"APT/lane={list(apt.values())}  (1 a cada {human(1/agg)})")
        else:
            print(f"  {label:6}: nenhum alpha na faixa mantem o APT utilizavel (W=512)")
