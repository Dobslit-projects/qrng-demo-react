# -*- coding: utf-8 -*-
"""
Bateria estatistica formal (secao 4 do pedido). Protocolo definido ANTES da
analise, aplicado identicamente a cada captura independente.

HIPOTESE (H0): cada byte-lane e cada posicao de bit do stream uint32-LE
capturado e IID Uniforme no seu alfabeto (0-255 para lane, {0,1} para bit),
sem autocorrelacao serial e estacionario entre janelas temporais.

NIVEL DE SIGNIFICANCIA: alpha = 0.01 por teste individual.

CORRECAO PARA MULTIPLOS TESTES: Bonferroni sobre a familia de testes desta
bateria (4 lanes x [chi2, runs, autocorrelacao-5-lags] + 32 bits x
proporcao-de-uns = ~44 testes por captura) -> alpha_corrigido =
0.01 / N_testes. Um p-valor abaixo de alpha_corrigido e motivo de
investigacao; entre alpha_corrigido e 0.01 e um sinal fraco, nao uma
reprovacao isolada (o numero de testes torna alguns falsos positivos
esperados so pelo acaso).

CRITERIO DE APROVACAO (por captura): nenhum p-valor de lane/bit abaixo de
alpha_corrigido, E o desvio da media Monte Carlo (U) explicado por erro-
padrao teorico dentro de 3 desvios-padrao daquele erro-padrao.
CRITERIO DE INVESTIGACAO: qualquer violacao do acima -- nao e reprovacao
automatica de "a fonte e ruim", e sim gatilho para localizar em qual
fronteira o desvio aparece (secao 5).

LIMITACOES DECLARADAS:
 - Amostra unica de 1.000.000 palavras por captura: poder estatistico
   finito: um desvio pequeno e real pode nao ser detectado; um desvio
   encontrado pode ser um falso positivo dentre ~44 testes (mitigado por
   Bonferroni, nao eliminado).
 - "Nao rejeitar H0" NUNCA e tratado como prova de IID -- e apenas
   ausência de evidência de não-IID nesta bateria específica.
 - autocorrelacao e teste de estacionariedade aqui sao formas
   simplificadas (nao substituem os estimadores formais da suite SP
   800-90B, que sao executados separadamente na secao 6).
 - runs test aplicado ao bit menos significativo de cada lane (forma mais
   comum do teste); nao e o unico runs test possivel.
"""
import sys, math, hashlib
from collections import Counter

ALPHA = 0.01

def load_capture(path):
    with open(path, "rb") as f:
        data = f.read()
    assert len(data) % 4 == 0, "tamanho nao multiplo de 4"
    n = len(data) // 4
    u32 = [0] * n
    for i in range(n):
        b0, b1, b2, b3 = data[4*i], data[4*i+1], data[4*i+2], data[4*i+3]
        u32[i] = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)
    sha = hashlib.sha256(data).hexdigest()
    return data, u32, sha

def chi_square_uniform_256(values):
    """Chi-quadrado contra uniforme discreta em 256 categorias. Retorna (estatistica, gl, p aproximado via normal para gl grande)."""
    counts = Counter(values)
    n = len(values)
    expected = n / 256.0
    stat = sum(((counts.get(k, 0) - expected) ** 2) / expected for k in range(256))
    df = 255
    # Aproximacao normal de Wilson-Hilferty para p-valor de chi2 com gl grande
    # (evita dependencia de scipy). Suficientemente precisa para gl=255.
    z = (( (stat/df) ** (1/3) ) - (1 - 2/(9*df))) / math.sqrt(2/(9*df))
    p = 0.5 * math.erfc(z / math.sqrt(2))
    return stat, df, p

def runs_test(bits):
    """Runs test (Wald-Wolfowitz) sobre uma sequencia de bits 0/1. Retorna (Z, p)."""
    n = len(bits)
    n1 = sum(bits)
    n0 = n - n1
    if n0 == 0 or n1 == 0:
        return None, None
    runs = 1
    for i in range(1, n):
        if bits[i] != bits[i-1]:
            runs += 1
    mean_r = (2 * n0 * n1) / n + 1
    var_r = (2 * n0 * n1 * (2 * n0 * n1 - n)) / (n * n * (n - 1))
    if var_r <= 0:
        return None, None
    z = (runs - mean_r) / math.sqrt(var_r)
    p = math.erfc(abs(z) / math.sqrt(2))
    return z, p

def autocorrelation(values, max_lag=5):
    n = len(values)
    mean = sum(values) / n
    var = sum((v - mean) ** 2 for v in values) / n
    if var == 0:
        return [None] * max_lag
    out = []
    for lag in range(1, max_lag + 1):
        cov = sum((values[i] - mean) * (values[i + lag] - mean) for i in range(n - lag)) / (n - lag)
        out.append(cov / var)
    return out

def shannon_entropy(values, alphabet_size):
    n = len(values)
    counts = Counter(values)
    h = 0.0
    for c in counts.values():
        p = c / n
        h -= p * math.log2(p)
    return h

def min_entropy_empirical(values, alphabet_size):
    """Estimador de min-entropia 'mais provavel' (simplificado, nao o
    estimador formal do SP 800-90B -- ver secao 6 para esse)."""
    n = len(values)
    counts = Counter(values)
    p_max = max(counts.values()) / n
    return -math.log2(p_max)

def analyze_capture(path, label):
    print(f"\n{'='*70}\nCAPTURA: {label} ({path})\n{'='*70}")
    data, u32, sha = load_capture(path)
    n = len(u32)
    print(f"bytes={len(data)} palavras_uint32={n} sha256={sha}")

    # ---- 1-5: byte lanes ----
    lanes = [bytearray(n) for _ in range(4)]
    for i in range(n):
        for lane in range(4):
            lanes[lane][i] = data[4*i + lane]

    n_tests = 0
    flagged = []

    print("\n-- Byte lanes (posicoes 0=LSB..3=MSB dentro da palavra) --")
    for lane in range(4):
        vals = list(lanes[lane])
        mean = sum(vals) / n
        var = sum((v - mean)**2 for v in vals) / n
        h_shannon = shannon_entropy(vals, 256)
        h_min = min_entropy_empirical(vals, 256)
        stat, df, p = chi_square_uniform_256(vals)
        n_tests += 1
        flag = " <-- INVESTIGAR" if p < ALPHA else ""
        if p < ALPHA: flagged.append((f"lane{lane} chi2", p))
        print(f"lane{lane}: mean={mean:.3f}(esp 127.5) var={var:.2f}(esp 5461.25) "
              f"H_shannon={h_shannon:.4f}/8 H_min_empirico={h_min:.4f}/8 "
              f"chi2={stat:.1f} df={df} p={p:.4f}{flag}")

        # runs test sobre o LSB de cada lane
        lsb_bits = [v & 1 for v in vals]
        z, p_runs = runs_test(lsb_bits)
        n_tests += 1
        if p_runs is not None and p_runs < ALPHA: flagged.append((f"lane{lane} runs(LSB)", p_runs))
        print(f"        runs(LSB): Z={z:.3f} p={p_runs:.4f}" if z is not None else "        runs(LSB): degenerado")

        # autocorrelacao 5 lags
        ac = autocorrelation(vals, 5)
        n_tests += 1
        max_ac = max(abs(a) for a in ac if a is not None)
        # limiar aproximado 2/sqrt(n) para "ruido branco" a 95%; usamos 3/sqrt(n) mais conservador para alpha=0.01-ish
        thresh = 3 / math.sqrt(n)
        if max_ac > thresh: flagged.append((f"lane{lane} autocorr", max_ac))
        print(f"        autocorr lags1-5: {[round(a,4) for a in ac]} (limiar~{thresh:.4f})")

    # ---- correlacao entre lanes (Pearson) ----
    print("\n-- Correlacao entre byte lanes (Pearson) --")
    def pearson(a, b):
        na = len(a)
        ma, mb = sum(a)/na, sum(b)/na
        cov = sum((a[i]-ma)*(b[i]-mb) for i in range(na)) / na
        va = sum((x-ma)**2 for x in a) / na
        vb = sum((x-mb)**2 for x in b) / na
        if va == 0 or vb == 0: return 0.0
        return cov / math.sqrt(va*vb)
    for i in range(4):
        for j in range(i+1, 4):
            r = pearson(list(lanes[i]), list(lanes[j]))
            flag = " <-- INVESTIGAR" if abs(r) > 0.01 else ""
            print(f"lane{i} x lane{j}: r={r:.5f}{flag}")

    # ---- 6: 32 posicoes de bit ----
    print("\n-- 32 posicoes de bit: proporcao de 1s, teste binomial --")
    bit_ones = [0]*32
    for v in u32:
        for b in range(32):
            if (v >> b) & 1: bit_ones[b] += 1
    for b in range(32):
        p1 = bit_ones[b] / n
        # teste binomial aproximado por normal: H0 p=0.5
        se = math.sqrt(0.25 / n)
        z = (p1 - 0.5) / se
        p_val = math.erfc(abs(z) / math.sqrt(2))
        n_tests += 1
        flag = " <-- INVESTIGAR" if p_val < ALPHA else ""
        if p_val < ALPHA: flagged.append((f"bit{b} proporcao", p_val))
        const_flag = " <-- CONSTANTE" if bit_ones[b] in (0, n) else ""
        print(f"bit{b:2d}: p(1)={p1:.5f} Z={z:.3f} p_valor={p_val:.4f}{flag}{const_flag}")

    # ---- distribuicao uint32, duplicatas ----
    print("\n-- Distribuicao uint32 --")
    print(f"min={min(u32)} max={max(u32)} media={sum(u32)/n:.1f} (esperado {2**32/2:.1f})")
    c32 = Counter(u32)
    dups = sum(1 for v,c in c32.items() if c > 1)
    print(f"valores duplicados: {dups} (de {n} amostras; esperado poucos dado o espaco 2^32)")

    # ---- Monte Carlo U ----
    print("\n-- Monte Carlo U = uint32/2^32 --")
    floats = [v / 4294967296 for v in u32]
    fmean = sum(floats)/n
    fmin, fmax = min(floats), max(floats)
    se_theoretical = math.sqrt(1/(12*n))
    n_se = (fmean - 0.5) / se_theoretical
    print(f"min={fmin:.10f} max={fmax:.10f} media={fmean:.6f} esperado=0.5")
    print(f"erro-padrao teorico={se_theoretical:.7f}  desvio observado em unidades de erro-padrao: {n_se:.2f}")
    MEAN=10.0
    exp_samples = [-MEAN*math.log(1-u) for u in floats]
    print(f"exponencial(mean=10): media={sum(exp_samples)/n:.4f} min={min(exp_samples):.4f} max={max(exp_samples):.4f}")

    # ---- janelas temporais consecutivas: estacionariedade simplificada ----
    print("\n-- Janelas temporais (10 janelas): media de U por janela --")
    win = n // 10
    win_means = []
    for w in range(10):
        seg = floats[w*win:(w+1)*win]
        win_means.append(sum(seg)/len(seg))
    print("medias por janela:", [round(m,5) for m in win_means])
    overall_var_of_means = sum((m-fmean)**2 for m in win_means)/10
    expected_var_of_means = (1/12)/win  # var(U)/win_size
    ratio = overall_var_of_means / expected_var_of_means
    print(f"variancia entre janelas / variancia esperada sob H0: {ratio:.3f} (proximo de 1 = consistente com estacionario)")

    n_bonf = 44  # numero de testes por captura definido a priori
    alpha_corr = ALPHA / n_bonf
    print(f"\n-- Resumo Bonferroni: alpha_corrigido={alpha_corr:.6f} (n_testes={n_bonf}) --")
    below_corr = [f for f in flagged if isinstance(f[1], float) and f[1] < alpha_corr]
    print(f"testes com p < alpha (bruto, {ALPHA}): {len(flagged)}")
    print(f"testes com p < alpha_corrigido (Bonferroni): {len(below_corr)}")
    for f in below_corr:
        print("  ", f)

    return {"sha256": sha, "n": n, "fmean": fmean, "se_theoretical": se_theoretical,
            "n_se": n_se, "flagged": flagged, "below_bonferroni": below_corr}

if __name__ == "__main__":
    results = {}
    for path, label in [("fresh_sample.bin", "Captura A (2026-08-25T14:04:59Z)"),
                          ("ref_capture.bin", "Captura B (2026-08-25T21:08:28Z)")]:
        results[label] = analyze_capture(path, label)

    print(f"\n{'='*70}\nCOMPARACAO ENTRE CAPTURAS\n{'='*70}")
    for label, r in results.items():
        print(f"{label}: media U={r['fmean']:.6f} desvio_em_erros_padrao={r['n_se']:.2f} "
              f"testes_abaixo_bonferroni={len(r['below_bonferroni'])}")
