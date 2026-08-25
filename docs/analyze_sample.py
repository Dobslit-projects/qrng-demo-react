# -*- coding: utf-8 -*-
"""
Item 3 da auditoria: definir cientificamente a unidade de amostra.
Analisa uma captura real de 1.000.000 de amostras uint32-LE (4.000.000
bytes) do stream ao vivo, obtida via /v1/raw em 2026-08-25T14:04:59Z,
SHA-256 9c7ec2803b1b9507407cb105de85f2174d739f2da48f6f292ae8883d20b92495.

Pergunta: os 32 bits sao todos saida aleatoria, ou um container para um
ADC de menor resolucao (com padding/flags/bits constantes)?
Metodo: decompor cada uint32-LE em 4 bytes-lane (posicoes 0-3 dentro da
palavra de 4 bytes, na ordem em que chegam no wire) e medir, por lane:
entropia de Shannon, valores distintos observados, se algum bit fica
constante (sempre 0 ou sempre 1) em toda a amostra, e correlacao serial
simples (deteccao de contador monotonico).
"""
import math
from collections import Counter

with open("fresh_sample.bin", "rb") as f:
    data = f.read()

assert len(data) % 4 == 0
n_samples = len(data) // 4
print(f"Amostra: {len(data)} bytes = {n_samples} uint32")

# ---- Reconstrói os uint32 respeitando little-endian (byte0=LSB..byte3=MSB) ----
u32 = []
for i in range(0, len(data), 4):
    b0, b1, b2, b3 = data[i], data[i+1], data[i+2], data[i+3]
    n = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)
    u32.append(n)

# ---- 1) Entropia de Shannon por byte-lane (posicao dentro da palavra) ----
print("\n=== Entropia de Shannon por byte-lane (max teorico = 8.0 bits) ===")
lane_bytes = [bytearray() for _ in range(4)]
for i in range(0, len(data), 4):
    for lane in range(4):
        lane_bytes[lane].append(data[i + lane])

lane_names = ["lane0 (LSB, byte0 no wire)", "lane1", "lane2", "lane3 (MSB, byte3 no wire)"]
for lane in range(4):
    counts = Counter(lane_bytes[lane])
    total = len(lane_bytes[lane])
    entropy = 0.0
    for c in counts.values():
        p = c / total
        entropy -= p * math.log2(p)
    distinct = len(counts)
    print(f"  {lane_names[lane]}: entropia={entropy:.4f} bits, valores distintos={distinct}/256")

# ---- 2) Entropia por posicao de BIT (0..31) dentro da palavra uint32 ----
print("\n=== Por posição de bit (0=LSB .. 31=MSB): fração de 1s, se é constante ===")
bit_ones = [0] * 32
for n in u32:
    for bit in range(32):
        if (n >> bit) & 1:
            bit_ones[bit] += 1

constant_bits_zero = []
constant_bits_one = []
for bit in range(32):
    frac = bit_ones[bit] / n_samples
    flag = ""
    if bit_ones[bit] == 0:
        flag = " <-- CONSTANTE EM 0 (nunca observado em 1)"
        constant_bits_zero.append(bit)
    elif bit_ones[bit] == n_samples:
        flag = " <-- CONSTANTE EM 1 (sempre observado em 1)"
        constant_bits_one.append(bit)
    print(f"  bit {bit:2d}: fração de 1s = {frac:.4f}{flag}")

print(f"\nBits constantes em 0: {constant_bits_zero}")
print(f"Bits constantes em 1: {constant_bits_one}")
print(f"Total de bits com significado (não-constantes): {32 - len(constant_bits_zero) - len(constant_bits_one)} de 32")

# ---- 3) Detecção de contador monotônico simples (correlação com índice) ----
print("\n=== Verificação de padrão de contador (correlação com o índice sequencial) ===")
diffs = [(u32[i+1] - u32[i]) & 0xFFFFFFFF for i in range(min(10000, n_samples - 1))]
diff_counts = Counter(diffs)
most_common_diff, most_common_count = diff_counts.most_common(1)[0]
print(f"  Diferença mais comum entre amostras consecutivas: {most_common_diff} (ocorre em {most_common_count}/{len(diffs)} = {100*most_common_count/len(diffs):.2f}% dos casos)")
print(f"  (Se fosse um contador incrementando, a diferença '1' dominaria quase 100% das vezes)")

# ---- 4) Estatísticas gerais do valor de 32 bits completo ----
print("\n=== Estatísticas do uint32 completo ===")
print(f"  min={min(u32)}, max={max(u32)}")
print(f"  média={sum(u32)/len(u32):.1f} (esperado para uniforme em [0, 2^32): {2**32/2:.1f})")
