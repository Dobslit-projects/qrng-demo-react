# NIST staging com a suíte SP 800-90B REAL — comparação paralela (fase item 7)

Execução **paralela e isolada** do serviço NIST de staging rodando a **suíte
SP 800-90B real** (não o executor fake), comparado lado a lado com o serviço
**produtivo** (`:8002` / `:18002`). **O processo produtivo NÃO foi
substituído.**

## 1. A imagem `nist-staging-real`

`staging/nist-staging-real/Dockerfile` — estágio único sobre `python:3.12-slim`:

| item | valor |
|---|---|
| Repo da suíte | `https://github.com/usnistgov/SP800-90B_EntropyAssessment` |
| Commit | `87c104d0ed4cbc96103e7b8b38d6f2c7e0a6b289` (2026-05-26, merge PR #248 "proportionRounding") — **o mesmo checkout que roda em produção** (`git rev-parse HEAD` em `/home/dobslit/SP800-90B_EntropyAssessment` confere) |
| Compilador | `g++ (Debian 14.x)` |
| Flags | `-std=c++11 -fopenmp -O2 -ffloat-store -I/usr/include/jsoncpp` — **`-march=native` removido** (reprodutibilidade entre hosts) |
| Libs | `-lbz2 -lpthread -ldivsufsort -ldivsufsort64 -ljsoncpp -lcrypto` |
| SHA-256 `ea_iid` (container, sem `-march=native`) | `e4d6132c3cd83773e4be539b6dc25f8c7d51496b7618a89e1bc8693dc84a4590` |
| SHA-256 `ea_non_iid` (container) | `6ae29eb1d73c6ba81d9c34737ff9a2c0f7ee0d91f5f4638b8566a146c7ed14cc` |
| SHA-256 `ea_iid` (dobslit, **com** `-march=native`) | `111838a107a6f77af49b91ded0980cc9a28b566df91abd9c0be5e927057450c1` |
| SHA-256 `ea_non_iid` (dobslit) | `2a77cc7042dbd7f6023fb85b7d205698cfa98b628fc89019f81bba4dec1cff37` |
| Wrapper | `qrng_nist90b.sh` — **byte-idêntico** ao de produção, SHA-256 `aaec3c3e8e8faa3e8169c77711c972b124bdecb0541ff283a5894b3ea60fc498` (NÃO é do repo upstream — é local da Dobslit; commitado em `staging/nist-staging-real/`) |
| Serviço | versão CONTROLADA de `nist_service.py`, porta `18093`, `NIST_ASSESSMENT_ENGINE=sp800-90b-reference`, `synthetic_result=false`, `statistical_result_valid=true`, DB/data/upload isolados |

### Reprodutibilidade

Os binários do container e os de `dobslit` têm **hashes diferentes por
design**: `dobslit` compila com `-march=native` (código específico da CPU do
host) e provavelmente g++/libs de outra versão. O container remove
`-march=native` justamente para ser reproduzível. **Isso não afeta os
resultados** — ver §2: os números de entropia batem exatamente.

## 2. Comparação PRODUTIVO (`:18002`) × STAGING-REAL (`:18093`)

`staging/nist-staging-real/compare.py`. Arquivo: **cópia somente-leitura** de
`/home/dobslit/qrng_data_nist/characterization_2026/run_new_01.bin`
(1.048.576 bytes, SHA-256 do binário usado `3021cbf1970170949e6a4f93d13c091ddd33d05841ecb86677cfb9fcca9c60c5`).
Modo `both` (IID + non-IID). **Os arquivos produtivos originais não foram
modificados** — o compare fez upload de uma cópia.

| campo | PRODUTIVO | STAGING-REAL | igual? |
|---|---|---|---|
| `status` | completed | completed | ✅ |
| `sha256_used` | `3021cbf1…c60c5` | `3021cbf1…c60c5` | ✅ (mesmo binário avaliado) |
| `format_detected` | raw | raw | ✅ |
| `iid_passed` | **False** | **False** | ✅ |
| `chi_square_passed` | True | True | ✅ |
| `lrs_passed` | True | True | ✅ |
| `permutation_passed` | **False** | **False** | ✅ |
| `h_min_iid` | 7.456189 | 7.456189 | ✅ (exato) — **mas NÃO é crédito de entropia: `iid_passed=false`** |
| `h_min_non_iid` | **6.951334** | **6.951334** | ✅ (exato) — bits por símbolo de 8 bits |
| `limiting_estimator` | `T-Tuple Test Estimate = 7.210061` (registrado assim no job) | idem | ✅ (idêntico entre os dois serviços) — **ver §2-bis: essa string era ambígua e foi corrigida** |
| `duration_seconds` | 67.6 s | 125.5 s | ➖ (compilação sem `-march=native` é mais lenta; **não afeta o resultado**) |
| `sha256_normalized`, `size_original/normalized_bytes`, `normalized_symbol_count`, `assessment_symbol_width`, `normalization_method`, `sample_endianness` | `None` | preenchidos | ➖ **a versão corrigida persiste esses metadados; o baseline não** (diferenças A–D do diff — ver `NIST_SERVICE_BASELINE.md`) |
| `assessment_engine`, `synthetic_result` | `None` | `sp800-90b-reference`, `false` | ➖ **só a versão corrigida tem** (item 4) |

### Escopo do resultado (não generalizar)

**A versão corrigida reproduziu exatamente o serviço produtivo para uma amostra
`.bin` raw de 1 MiB, com o mesmo SHA-256.** A equivalência de `.txt`, `.csv` e
do conjunto histórico completo **permanece pendente** (item 7 completo — ver
`NIST_FULLSET_COMPARE.md`).

Resultado da amostra a preservar:

```
iid_passed          = false
permutation_passed  = false
h_min_non_iid       = 6.951334 bits por símbolo de 8 bits   (crédito de entropia)
h_min_iid           = 7.456189                              (NÃO usar — hipótese IID falhou)
```

### Classificação de cada diferença observada nesta amostra

| diferença | causa | é discrepância de resultado nesta amostra? |
|---|---|---|
| `duration_seconds` | flags de compilação (`-march=native` só no prod) | **não** — parâmetro de execução |
| `sha256_normalized` / `size_*` / `normalized_symbol_count` / `assessment_symbol_width` / `normalization_method` / `sample_endianness` | **versão**: colunas de metadados adicionadas na versão corrigida (aditivas, migração idempotente) | **não** — o baseline apenas não grava esses campos |
| `assessment_engine` / `synthetic_result` | **versão**: identificação do motor (item 4) | **não** |

Para **este arquivo** (1 MiB raw): não houve diferença de parser, de unidade de
símbolo, de arquivo efetivamente usado, nem bug. **Nada disso é afirmado para
`.txt`/`.csv`/o conjunto completo** enquanto o item 7 não estiver concluído.

## 2-bis. Correção da semântica do `limiting_estimator` (item 2)

O job registrava `limiting_estimator = "T-Tuple Test Estimate = 7.210061"`,
mas `h_min_non_iid = 6.951334`. Os dois **não correspondiam**: `7.210061` é o
menor estimador da **trilha original** (por símbolo de 8 bits); `6.951334` vem
da **trilha bitstring** — `8 × H_bitstring = 8 × 0.868917`. O `ea_non_iid`
imprime as duas trilhas:

```
Compression Test Estimate (bit string) = 0.868917 / 1 bit(s)   ← menor da trilha bitstring
T-Tuple Test Estimate                  = 7.210061 / 8 bit(s)   ← menor da trilha original
H_original: 7.210061
H_bitstring: 0.868917
min(H_original, 8 X H_bitstring): 6.951334                     ← 8 × 0.868917 ⇒ trilha bitstring limita
```

O parser foi reescrito. Campos NÃO ambíguos agora persistidos e expostos
(API, histórico, frontend):

```json
{
  "h_original_non_iid": 7.210061,
  "original_limiting_estimator": "T-Tuple Test Estimate",
  "h_bitstring_non_iid": 0.868917,
  "bitstring_limiting_estimator": "Compression Test Estimate",
  "bitstring_to_symbol_conversion": "min(8, bits_per_symbol) x H_bitstring = 8 x H_bitstring",
  "h_min_non_iid": 6.951334,
  "limiting_path": "bitstring",
  "limiting_estimator": "Compression Test Estimate"
}
```

`limiting_estimator` agora **corresponde sempre** a `h_min_non_iid` (via
`limiting_path`). Fixtures cobrindo: trilha original limita; trilha bitstring
limita; empate; uma trilha ausente; saída incompleta (`parse_incomplete`).
Testes: `TestParseOutputLimitingEstimator` (6 casos).

`statistical_result_valid` → **renomeado** para `assessment_execution_valid`
(alias legado por 1 versão): significa "o assessment RODOU e foi INTERPRETADO
corretamente", **não** que a fonte foi validada ou passou. `False` se: executor
sintético, status ≠ completed, ou `parse_incomplete`.

## 3. Determinismo (staging-real, mesmo arquivo 2×)

`h_min_iid`, `h_min_non_iid`, `iid_passed`, `limiting_estimator`,
`assessment_engine`, `synthetic_result`, `statistical_result_valid` —
**idênticos entre as duas execuções** (ver `/root/nist-real.log` §6 na VM). A
suíte é determinística para o mesmo binário de entrada.

## 4. Timeout real / restart de container / fila

| cenário | resultado |
|---|---|
| **Timeout real** | serviço com `NIST_TEST_TIMEOUT_SECONDS=5`; job de 1 MiB (assessment leva ~2 min) → `status: failed`, `error_message` do `subprocess.TimeoutExpired`. O `subprocess.run(timeout=)` já é o código de produção. |
| **Restart de container no meio de um job** | `docker restart` durante um job `running` → **observado**: após o restart o job fica **preso em `running`** no DB (`has_active_job=true`, `queue_depth=0`) — o processo do worker morreu mas nunca atualizou a linha. É um **job abandonado** (nem completa nem falha). Jobs `completed`/`failed` anteriores permanecem íntegros. |
| **Job `queued` durante restart** | descartado — a fila in-memory (`queue.Queue`) não sobrevive ao restart. |
| **Recuperação controlada** | **implementada** — `_recover_orphan_jobs()` roda no boot: todo job `status='running'` órfão vira `failed` com motivo explícito ("job abandonado: o serviço reiniciou…"); jobs `status='queued'` são re-enfileirados a partir do DB. Teste unitário `test_recupera_jobs_orfaos_no_boot`. (A observação da tabela acima — job preso em `running` após restart — foi feita ANTES desta correção.) |

## 5. O que falta antes de substituir o NIST produtivo (PARADA)

Inalterado de `NIST_MIGRATION_PLAN.md` + confirmado aqui:
1. rodar a comparação acima sobre **todos** os arquivos reais de
   `/home/dobslit/qrng_data_nist` (não só `run_new_01.bin`), incluindo
   `.txt`/`.csv` (parsers), e classificar qualquer diferença;
2. migrar o banco real (`ALTER TABLE ADD COLUMN` idempotentes) sem apagar
   histórico;
3. ~~sweep de recuperação de jobs órfãos no boot~~ — **feito**
   (`_recover_orphan_jobs`);
4. janela de manutenção para trocar o `ExecStart` do `qrng-nist-api.service`.

**Próximo ponto de autorização deste item:** executar o passo 1 (comparação
sobre o conjunto completo). Só depois, migração + troca do processo.
