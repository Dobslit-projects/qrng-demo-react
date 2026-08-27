# -*- coding: utf-8 -*-
"""Analise de falso alarme de RCT/APT -- Kapua QRNG.

  ================================  PROVISORIO  ================================
  - A taxa usada (~170 mil/s por lane) e a VAZAO OBSERVADA NO TRANSPORTE
    (total_pushed do buffer / tempo), NAO uma taxa fisica de amostras
    comprovada. Se o uint32 empacota N sub-amostras, a taxa fisica por
    "amostra de noise source" muda por um fator N.
  - NOISE SOURCE SAMPLE = byte por lane continua PROVISORIO (pendente
    RTL/AXI/FIFO). Toda a parametrizacao aqui herda essa provisoriedade.
  - Os numeros dependem de hipoteses de IID e estacionariedade. As capturas
    reais mostram viés pequeno mas sistematico e nao foram testadas para
    independencia serial suficiente -> use como ORDEM DE GRANDEZA.
  - MTBF calculado != garantia operacional. E o inverso de uma taxa media
    sob o modelo; nao cobre nao-estacionariedade, rajadas, nem falha fisica.
  - NENHUM alpha foi selecionado para producao. Ver
    RCT_APT_REVIEW.md secao "Nao selecionar thresholds ainda".
  ============================================================================

Quatro blocos de resultado, mantidos SEPARADOS (nao misturar):
  (A) BOUND POR OPORTUNIDADE  -- limite superior analitico, worst-case p=2^-H
  (B) MODELO IID UNIFORME     -- analitico, p=1/256 (fonte hipotetica perfeita)
  (C) SIMULACAO EMPIRICA      -- Monte Carlo com seed fixa, em regime tratavel,
                                validando as formulas de (A)/(B)
  (D) DADOS OBSERVADOS         -- o que as capturas de 2026-08-25/26 mediram

Uso:  python3 false_alarm_analysis.py
"""
import math
import random

SEED = 20260827  # seed fixa e registrada -- resultados de (C) sao reproduziveis

# ---------------------------------------------------------------------------
# Binomial exato (lgamma). Independente do modulo de health tests.
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
# (D) DADOS OBSERVADOS
# Vazao medida 2026-08-27 via GET http://127.0.0.1:18001/health:
#   total_pushed avancou 40_837_572 bytes em 60 s.
OBSERVED_BYTES_PER_S = 40_837_572 / 60.0
OBSERVED_WORDS_PER_S = OBSERVED_BYTES_PER_S / 4.0         # uint32-LE transport words
OBSERVED_SYM_PER_S_PER_LANE = OBSERVED_WORDS_PER_S        # 1 byte / word / lane (PROVISORIO)
W = 512
# Min-entropia nao-IID conservadora por lane (SP 800-90B, captura B 2026-08-25):
LANES = {0: 6.978486, 1: 7.312323, 2: 7.331528, 3: 7.182924}
# Media U observada (viés): captura A 0.496639 (-11.64 sigma), captura B 0.498259.


# ---------------------------------------------------------------------------
# (A)/(B) modelos analiticos -- LIMITES SUPERIORES no estilo da propria
# SP 800-90B (a norma deriva o cutoff exigindo que estas quantidades <= alpha).
def rct_trigger_per_position(p, C):
    """LIMITE SUPERIOR da prob de o RCT disparar numa dada posicao: a norma
    usa P(C-1 repeticoes consecutivas) <= p_max^(C-1), valido para qualquer
    valor que esteja repetindo (P(proximo = X | atual = X) <= max_x P(x) =
    p_max). Nao e a taxa exata -- e um bound (a taxa real de uma fonte iid e
    menor, ver a razao medida na simulacao C1)."""
    return p ** (C - 1)


def apt_trigger_per_window(p, C, W=512):
    """Janela NAO sobreposta (como o APTState implementado): falha se
    B >= C, B = 1 + X, X ~ Binomial(W-1, p) matches nas W-1 amostras apos a
    referencia. Logo P(falha) = P(X >= C-1)."""
    return _binom_sf_ge(W - 1, C - 1, p)


def aggregate_analytic(alpha, sym_per_s_per_lane, uniform=False):
    rct = {L: rct_cutoff(H, alpha) for L, H in LANES.items()}
    apt = {L: apt_cutoff(H, W, alpha) for L, H in LANES.items()}
    win_per_s = sym_per_s_per_lane / W
    r_rct = 0.0
    r_apt = 0.0
    for L, H in LANES.items():
        p = (1.0 / 256) if uniform else 2.0 ** (-H)
        r_rct += sym_per_s_per_lane * rct_trigger_per_position(p, rct[L])
        r_apt += win_per_s * apt_trigger_per_window(p, apt[L], W)
    return rct, apt, r_rct, r_apt, r_rct + r_apt


def human(seconds):
    if seconds <= 0 or seconds == math.inf:
        return "nunca"
    for unit, size in (("s", 1), ("min", 60), ("h", 3600), ("dia", 86400), ("ano", 86400 * 365)):
        if seconds < 60 * size or unit == "ano":
            return f"{seconds / size:.2f} {unit}"
    return f"{seconds:.0f} s"


# ---------------------------------------------------------------------------
# (C) SIMULACAO EMPIRICA -- Monte Carlo com seed fixa.
#
# NAO se tenta observar eventos raros (anuais) diretamente -- isso seria
# inviavel. A simulacao roda num REGIME TRATAVEL (cutoffs pequenos, p alto)
# onde os eventos sao frequentes, e serve para VALIDAR que as formulas
# analiticas de (A)/(B) batem com a contagem empirica. Confiando nas
# formulas nesse regime, extrapola-se analiticamente para o regime real.

class _RCT:
    __slots__ = ("C", "last", "n")
    def __init__(self, C):
        self.C = C
        self.last = None
        self.n = 0
    def push(self, v):
        if v == self.last:
            self.n += 1
            if self.n >= self.C:
                self.last = None
                self.n = 0
                return True
        else:
            self.last = v
            self.n = 1
        return False


class _APT:
    """Janela NAO sobreposta (igual ao APTState do modulo): B comeca em 1."""
    __slots__ = ("C", "W", "ref", "B", "seen")
    def __init__(self, C, W):
        self.C = C
        self.W = W
        self.ref = None
        self.B = 0
        self.seen = 0
    def push(self, v):
        if self.ref is None:
            self.ref = v
            self.B = 1
            self.seen = 0
            return False
        self.seen += 1
        fail = False
        if v == self.ref:
            self.B += 1
            if self.B >= self.C:
                fail = True
        if fail or self.seen >= self.W - 1:
            self.ref = None
            self.B = 0
            self.seen = 0
        return fail


class _APTsliding:
    """Janela SOBREPOSTA (sliding): a cada amostra, olha as ultimas W e conta
    ocorrencias do valor mais recente-referencia. Implementacao simples com
    deque para comparar a taxa de falso alarme com a janela nao sobreposta."""
    __slots__ = ("C", "W", "buf")
    def __init__(self, C, W):
        self.C = C
        self.W = W
        self.buf = []
    def push(self, v):
        self.buf.append(v)
        if len(self.buf) > self.W:
            self.buf.pop(0)
        if len(self.buf) < self.W:
            return False
        ref = self.buf[0]
        cnt = sum(1 for x in self.buf if x == ref)
        if cnt >= self.C:
            self.buf = []  # reset apos disparo
            return True
        return False


def _spike_symbol(rng, p_max):
    """Distribuicao 'spike': simbolo 0 com prob p_max, 1..255 uniformes no
    resto. Conservador p/ RCT (concentra a prob de repeticao)."""
    if rng.random() < p_max:
        return 0
    return rng.randint(1, 255)


def _wilson_ci(k, n, z=1.96):
    """IC de Wilson para uma proporcao k/n (95% com z=1.96)."""
    if n == 0:
        return (0.0, 0.0)
    phat = k / n
    d = 1 + z * z / n
    centre = (phat + z * z / (2 * n)) / d
    half = (z * math.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n))) / d
    return (max(0.0, centre - half), min(1.0, centre + half))


def simulate_rct(n_symbols, C, p_max, seed):
    rng = random.Random(seed)
    st = _RCT(C)
    fails = 0
    for _ in range(n_symbols):
        if st.push(_spike_symbol(rng, p_max)):
            fails += 1
    lo, hi = _wilson_ci(fails, n_symbols)
    return fails, fails / n_symbols, (lo, hi)


def simulate_apt(n_symbols, C, W, p_max, seed, sliding=False):
    rng = random.Random(seed)
    st = _APTsliding(C, W) if sliding else _APT(C, W)
    n_windows = n_symbols / W if not sliding else n_symbols
    fails = 0
    for _ in range(n_symbols):
        if st.push(_spike_symbol(rng, p_max)):
            fails += 1
    lo, hi = _wilson_ci(fails, int(n_windows) if n_windows >= 1 else 1)
    per_opp = fails / n_windows if n_windows else 0.0
    return fails, per_opp, (lo, hi)


def simulate_four_lanes(n_words, C_rct, seed):
    """4 lanes iid uniformes independentes; mede a taxa de palavras em que
    ALGUMA lane dispara o RCT, para comparar com 4x a taxa single-lane."""
    rngs = [random.Random(seed + 100 + i) for i in range(4)]
    sts = [_RCT(C_rct) for _ in range(4)]
    any_fail = 0
    for _ in range(n_words):
        hit = False
        for i in range(4):
            if sts[i].push(rngs[i].randint(0, 255)):
                hit = True
        if hit:
            any_fail += 1
    return any_fail, any_fail / n_words


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print(__doc__.split("Uso:")[0].rstrip())
    print("=" * 76)

    # ---- (D) DADOS OBSERVADOS ----
    print("\n(D) DADOS OBSERVADOS (captura/telemetria reais)")
    print(f"  vazao de transporte medida : {OBSERVED_BYTES_PER_S:,.0f} B/s")
    print(f"  -> transport words (uint32) : {OBSERVED_WORDS_PER_S:,.0f} /s")
    print(f"  -> simbolos/s por lane      : {OBSERVED_SYM_PER_S_PER_LANE:,.0f}  [PROVISORIO: byte/lane]")
    print(f"  oportunidades APT/s por lane: {OBSERVED_SYM_PER_S_PER_LANE / W:,.1f}  (rate / W, W={W})")
    print("  min-entropia nao-IID por lane:", {L: round(h, 3) for L, h in LANES.items()})
    print("  media U observada           : captura A 0.496639 (-11.64 sigma), captura B 0.498259")

    # ---- (A) BOUND POR OPORTUNIDADE (worst-case p = 2^-H) ----
    print("\n(A) BOUND POR OPORTUNIDADE  (analitico, worst-case p = 2^-H)")
    print(f"    taxa = {OBSERVED_SYM_PER_S_PER_LANE:,.0f} simbolos/s/lane (x4 lanes)")
    print("    alpha  RCT/lane        APT/lane           1 falso bloqueio a cada")
    for ae in (20, 24, 28, 30, 34, 38, 40):
        a = 2.0 ** (-ae)
        rct, apt, _, _, agg = aggregate_analytic(a, OBSERVED_SYM_PER_S_PER_LANE, uniform=False)
        print(f"    2^-{ae:<3} {list(rct.values())}  {str(list(apt.values())):20} {human(1/agg) if agg>0 else 'nunca'}")

    # ---- (B) MODELO IID UNIFORME (p = 1/256) ----
    print("\n(B) MODELO IID UNIFORME  (analitico, p = 1/256; fonte hipotetica perfeita)")
    for ae in (20, 24, 28, 30, 34, 38, 40):
        a = 2.0 ** (-ae)
        rct, apt, _, _, agg = aggregate_analytic(a, OBSERVED_SYM_PER_S_PER_LANE, uniform=True)
        print(f"    2^-{ae:<3} {list(rct.values())}  {str(list(apt.values())):20} {human(1/agg) if agg>0 else 'nunca'}")

    # ---- (C) SIMULACAO EMPIRICA (seed fixa) ----
    print(f"\n(C) SIMULACAO EMPIRICA  (Monte Carlo, seed={SEED}, regime TRATAVEL)")
    print("    Objetivo: validar as formulas de (A)/(B). Nao se observa evento raro direto.")

    N = 2_000_000
    ok_all = True
    print(f"\n    C1. RCT: simulacao <= bound p_max^(C-1) ?  [N={N:,} simbolos/caso]")
    print("        p_max     C   sim_rate(/pos)     IC95%               bound p^(C-1)   sim/bound  <=bound?")
    for p_max, C in [(1/8, 3), (1/8, 4), (1/16, 3), (1/12, 4), (1/6, 4)]:
        k, rate, (lo, hi) = simulate_rct(N, C, p_max, SEED)
        bound = rct_trigger_per_position(p_max, C)
        frac = (rate / bound) if bound > 0 else float('nan')
        ok = hi <= bound * 1.05
        ok_all = ok_all and ok
        print(f"        {p_max:7.4f}  {C}   {rate:.3e} ({k:5d})  [{lo:.2e},{hi:.2e}]  {bound:.3e}   {frac:.3f}      {'sim' if ok else 'NAO'}")

    print(f"\n    C2. APT (janela NAO sobreposta): simulacao <= bound P(Binom(W-1,p_max)>=C-1) ?")
    print("        p_max     C   W    sim_rate(/janela)  IC95%               bound          sim/bound  <=bound?")
    for p_max, C, Wsim in [(1/8, 6, 32), (1/8, 8, 32), (1/6, 8, 32), (1/8, 10, 64), (1/6, 12, 64)]:
        k, rate, (lo, hi) = simulate_apt(N, C, Wsim, p_max, SEED)
        bound = apt_trigger_per_window(p_max, C, Wsim)
        frac = (rate / bound) if bound > 0 else float('nan')
        ok = hi <= bound * 1.05
        ok_all = ok_all and ok
        print(f"        {p_max:7.4f}  {C:2d}  {Wsim:3d}  {rate:.3e} ({k:5d})  [{lo:.2e},{hi:.2e}]  {bound:.3e}   {frac:.3f}      {'sim' if ok else 'NAO'}")
    print(f"\n    -> C1/C2: a simulacao NUNCA excede o bound analitico"
          f"  [{'CONFIRMADO' if ok_all else 'FALHOU -- rever'}]. O bound e conservador"
          f" (sim ~ 0.1-0.2x dele numa fonte iid) -- e o lado seguro para dimensionar alpha.")

    print(f"\n    C3. APT janela SOBREPOSTA vs NAO sobreposta (mesma p, C, W)")
    print("        A janela nao sobreposta reseta a referencia a cada W; a sobreposta")
    print("        reavalia a cada amostra -> mais oportunidades correlacionadas.")
    for p_max, C, Wsim in [(1/8, 8, 32), (1/6, 10, 32)]:
        _, r_ns, _ = simulate_apt(N, C, Wsim, p_max, SEED, sliding=False)
        _, r_sl, _ = simulate_apt(N // 2, C, Wsim, p_max, SEED, sliding=True)
        print(f"        p_max={p_max:.4f} C={C} W={Wsim}: nao-sobreposta {r_ns:.3e}/janela   sobreposta {r_sl:.3e}/amostra")

    print(f"\n    C4. Interacao entre 4 lanes (RCT, iid uniforme, C=3)")
    Nw = 3_000_000
    # single-lane uniforme, C=3: gerador uniforme direto
    rng = random.Random(SEED + 7); st = _RCT(3); s1 = 0
    for _ in range(Nw):
        if st.push(rng.randint(0, 255)):
            s1 += 1
    single = s1 / Nw
    kany, rany = simulate_four_lanes(Nw, 3, SEED)
    print(f"        single-lane (C=3, uniforme): {single:.3e}/palavra  ({s1} em {Nw:,})")
    print(f"        alguma-das-4-lanes         : {rany:.3e}/palavra  ({kany} em {Nw:,})")
    print(f"        4x single (uniao)          : {4*single:.3e}  -> razao medida/uniao = {rany/(4*single) if single else float('nan'):.3f}")
    print("        (razao ~1 confirma quase-aditividade; lanes ~independentes)")

    print(f"\n    C5. Sensibilidade a taxa de simbolos (linear -- so um multiplicador)")
    a = 2.0 ** (-30)
    for mult, label in [(0.1, "0.1x"), (1.0, "1x (medido)"), (10.0, "10x"), (100.0, "100x")]:
        _, _, _, _, agg = aggregate_analytic(a, OBSERVED_SYM_PER_S_PER_LANE * mult)
        print(f"        {label:12} taxa={OBSERVED_SYM_PER_S_PER_LANE*mult:,.0f}/s/lane  -> alpha=2^-30: 1 a cada {human(1/agg)}")

    print(f"\n    C6. Sensibilidade a pequenas mudancas de p_max (lane0, alpha=2^-30)")
    for dpm in (-0.001, -0.0005, 0.0, 0.0005, 0.001):
        H0 = LANES[0]
        p0 = 2.0 ** (-H0) + dpm
        Heff = -math.log2(p0)
        Crct = rct_cutoff(Heff, a); Capt = apt_cutoff(Heff, W, a)
        win_s = OBSERVED_SYM_PER_S_PER_LANE / W
        r = OBSERVED_SYM_PER_S_PER_LANE * rct_trigger_per_position(p0, Crct) + win_s * apt_trigger_per_window(p0, Capt, W)
        print(f"        p_max={p0:.5f} (H_eff={Heff:.3f})  RCT={Crct} APT={Capt}  -> 1 a cada {human(1/r)}")

    print("\n" + "=" * 76)
    print("LIMITACOES (recapitulacao):")
    print("  - regime real (eventos raros) NAO simulado -- valores de (A)/(B) sao")
    print("    analiticos, validados por (C) apenas no regime tratavel.")
    print("  - taxa = transporte, nao amostra fisica confirmada.")
    print("  - modelo iid/estacionario; captura real tem viés sistematico pequeno.")
    print("  - MTBF != garantia. Nenhum alpha selecionado. RCT/APT fora do live.")
