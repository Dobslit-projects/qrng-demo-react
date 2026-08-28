# Comparação do conjunto NIST completo — inventário e plano (fase item 7)

**A campanha completa NÃO foi executada.** Este documento traz o inventário, a
estimativa e a estratégia de lotes, e **aguarda autorização** antes da campanha
longa (condição de parada da diretriz).

## Regra: nada em massa contra o serviço NIST produtivo

A comparação NÃO faz upload em massa para o `:8002` produtivo durante operação
normal. Ela usa um **baseline isolado**:

- cópia dos binários produtivos **compilados de fonte** (`ea_iid`/`ea_non_iid`
  do commit `87c104d0`); OU, para fidelidade de hash, a cópia real de
  `dobslit:/home/dobslit/SP800-90B_EntropyAssessment/cpp/ea_*`
  (`111838a1…` / `2a77cc70…`, compilada COM `-march=native`);
- **wrapper `qrng_nist90b.sh` byte-idêntico** (`aaec3c3e…`);
- mesmo host/arquitetura (x86-64 Debian) — o Bongo VM;
- banco e diretórios **temporários** (`/data`, `/staging-data` em volume
  descartável);
- **cópias somente-leitura** das amostras (SFTP `get`, nunca `put`; os
  arquivos originais em `/home/dobslit/qrng_data_nist` **não são modificados**).

Compara **baseline isolado × staging-real** sobre cada arquivo elegível.

## Inventário (`/home/dobslit/qrng_data_nist`, lido read-only 2026-08-28)

| | |
|---|---|
| Arquivos `.bin`/`.txt`/`.csv` | **64** (`.bin` 49, `.txt` 15, `.csv` 0) |
| Bytes totais | **475.374.098** (~475 MB) |
| Elegíveis (≥ 1 MiB = `NIST_MIN_BYTES`) | **57** |
| Pequenos demais (< 1 MiB — caso "inválido esperado") | **7** |

**Maiores arquivos:**

| caminho relativo | tamanho | ext |
|---|---|---|
| `characterization_2026/run_new_05_u32.txt` | 141.213.762 | txt |
| `characterization_2026/run_new_05.bin` | 52.428.800 | bin |
| `uploads/2026-08-08/job_88211b99/run_new_05.bin` | 52.428.800 | bin |
| `characterization_2026/run_new_04_u32.txt` | 28.243.341 | txt |
| `characterization_2026/run_new_03_u32.txt` | 28.242.444 | txt |
| `uploads/2026-07-10/job_a90340e9/baseline_100M_20260710.bin` | 12.582.912 | bin |
| `audit52/B03_last_1M.txt` | 10.773.891 | txt |
| `audit52/B02_middle_1M.txt` | 10.773.566 | txt |

Formatos:
- `.bin` → `raw` (passthrough, símbolos de 8 bits);
- `.txt` `*_u32.txt` → `u32txt` (cada uint32 vira 4 bytes little-endian →
  ainda símbolos de 8 bits). **Estes exercitam o parser `.txt` — ainda não
  validados contra a suíte real.**

## Estimativa

- Base observada: **~68 s / MiB** para `both` (IID + non-IID) numa amostra de 1
  MiB no Bongo VM (`-march=native`). Não escala linearmente para arquivos
  grandes (o `ea_non_iid` tem termos ~O(n log n)), então **68 s/MiB é um piso**.
- 2 execuções por arquivo (baseline isolado + staging-real).
- **Estimativa grosseira: ~18 h de wall time** para os 57 elegíveis, `both`,
  ×2. Os 3 arquivos de 28–141 MB dominam (`run_new_05_u32.txt` sozinho pode
  passar de 3–4 h por execução).
- **Espaço em disco:** ~1,4 GB (original + normalizado + diretórios de
  resultado `results_*` com folga). O `_u32.txt` de 141 MB gera um `.bin`
  normalizado grande + outputs verbosos (`-v` produziu ~925 KB para 1 MiB).

## Estratégia de lotes (proposta — aguardando autorização)

| lote | seleção | nº | tempo estimado | quando |
|---|---|---|---|---|
| **L0 — piloto** | `.bin` 1 MiB (`run_new_01.bin`, `run_new_02.bin`) + 1 `.txt` u32 pequeno + 1 arquivo < 1 MiB (inválido esperado) | ~4 | < 15 min | pode rodar já (baixo impacto) |
| **L1 — `.txt`/u32** | todos os `*_u32.txt` ≤ 30 MiB (exercita o parser de texto) | ~8–10 | ~2–3 h | janela combinada |
| **L2 — `.bin` médios** | `.bin` de 1–13 MiB | ~30 | ~6–8 h | janela combinada, à noite |
| **L3 — gigantes** | `run_new_05.bin` (52 MB), `run_new_05_u32.txt` (141 MB), `run_new_04/03_u32.txt` (28 MB) | ~5 | ~8–12 h | janela dedicada, um por vez |

Impacto: **zero em produção** (baseline isolado + read-only), mas consome CPU
do Bongo VM (`-fopenmp` usa todos os cores) — L2/L3 devem rodar fora do
horário de pico. `nice`/`cpulimit` opcional.

Para cada arquivo, a comparação registra (contrato do item 7):
`caminho relativo · sha256_original · sha256_normalized · tamanho · símbolos ·
formato detectado · normalização · IID · non-IID · estimadores ·
limiting_path · limiting_estimator · duração · exit code · equivalência`.

## Estado

```text
NIST FULLSET COMPARE: NÃO EXECUTADA
MOTIVO: ~18 h de wall time + ~1,4 GB de disco -> "campanha longa" que a
        diretriz exige apresentar e aguardar autorização.
PRONTO: staging/nist-staging-real/compare.py (roda 1 arquivo por vez);
        harness de varredura do conjunto a partir do inventário acima.
PRÓXIMO: autorizar L0 (piloto, < 15 min, baixo impacto) e depois L1–L3 em
        janelas combinadas. Só após L1–L3 verdes: migração do banco real +
        troca do ExecStart (§21 do relatório).
```
