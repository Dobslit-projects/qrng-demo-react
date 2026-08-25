# -*- coding: utf-8 -*-
"""
Item 8 da auditoria: Monte Carlo com dados reais -- registra min/max/cobertura
dos floats gerados a partir de uma amostra QRNG genuina (a mesma captura de
4.000.000 bytes usada no item 3, docs/entropy-source-characterization.md),
usando exatamente o mesmo contrato do frontend: U = uint32 / 2^32 (ver
uint32ToFloat em src/lib/qrngHelper.js) e a transformada exponencial
X = -mean * ln(1 - U) (ver exponentialFromUniform).

Isto é uma checagem de regressao empirica, NAO um substituto para os testes
deterministicos ja existentes em qrngHelper.test.js (fixtures fixas para
0x00000000 -> 0 e 0xFFFFFFFF -> ~0.99999999976...). Serve para confirmar que,
sobre uma amostra real de tamanho grande, a distribuicao nao esta
visivelmente quebrada (nao concentrada numa faixa estreita, cobertura
razoavel do intervalo [0,1)).
"""
import math
from collections import Counter

with open("fresh_sample.bin", "rb") as f:
    data = f.read()

assert len(data) % 4 == 0
n = len(data) // 4
u32 = []
for i in range(0, len(data), 4):
    b0, b1, b2, b3 = data[i], data[i+1], data[i+2], data[i+3]
    u32.append(b0 | (b1 << 8) | (b2 << 16) | (b3 << 24))

print(f"Amostra: {n} valores uint32 (4.000.000 bytes, mesma captura do item 3)")

# ---- U = uint32 / 2^32 (uint32ToFloat) ----
floats = [x / 4294967296 for x in u32]
fmin, fmax = min(floats), max(floats)
fmean = sum(floats) / n
print("\n=== Monte Carlo uniforme U = uint32 / 2^32 ===")
print(f"  min={fmin:.10f}  max={fmax:.10f}  mean={fmean:.6f} (esperado ~0.5)")

# Cobertura: divide [0,1) em 20 buckets, conta quantos tem pelo menos 1 amostra
# e o desvio percentual de cada bucket em relacao ao esperado (uniforme).
NBUCKETS = 20
buckets = [0] * NBUCKETS
for v in floats:
    idx = min(int(v * NBUCKETS), NBUCKETS - 1)
    buckets[idx] += 1
covered = sum(1 for b in buckets if b > 0)
expected_per_bucket = n / NBUCKETS
max_dev_pct = max(abs(b - expected_per_bucket) / expected_per_bucket for b in buckets) * 100
print(f"  cobertura: {covered}/{NBUCKETS} buckets de [0,1) tem pelo menos 1 amostra")
print(f"  maior desvio percentual de um bucket vs. esperado uniforme: {max_dev_pct:.2f}%")

# ---- Transformada exponencial X = -mean * ln(1 - U) ----
MEAN = 10.0  # media alvo arbitraria, mesma ideia de uso no frontend (DataSection/ApplicationsSection)
exp_samples = [-MEAN * math.log(1 - v) for v in floats]
xmin, xmax = min(exp_samples), max(exp_samples)
xmean = sum(exp_samples) / n
print(f"\n=== Transformada exponencial X = -{MEAN} * ln(1 - U) ===")
print(f"  min={xmin:.6f}  max={xmax:.6f}  mean={xmean:.4f} (esperado ~{MEAN})")
print(f"  desvio da media empirica vs. teorica: {abs(xmean - MEAN) / MEAN * 100:.2f}%")

# ---- Nunca None/NaN/Infinity ----
bad = sum(1 for v in floats if not (0.0 <= v < 1.0))
bad_exp = sum(1 for v in exp_samples if not math.isfinite(v) or v < 0)
print(f"\n=== Sanidade ===")
print(f"  floats fora de [0,1): {bad} (esperado 0)")
print(f"  amostras exponenciais nao-finitas ou negativas: {bad_exp} (esperado 0)")
