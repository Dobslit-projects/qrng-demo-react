# Rodada 2026-08-29 — proveniência live + prontidão criptográfica

Base normativa: **SP 800-90B (final + errata)**, **SP 800-90A Rev. 1 (final)**,
**SP 800-90C (final, set/2025)**. 90A Rev. 2 **não** tratada como norma final.

**Branch:** `fix/live-provenance-crypto-readiness-20260829` (a partir de `main`
= `51c1a2d`). **Nenhum commit em `main`.** Único ajuste em produção autorizado e
feito: remover `LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE` (item 2). **Sem** teste real
de rollback (backups preservados).

---

## 1. Estado inicial e final (congelado)

### Inicial (main = `51c1a2d`, CI verde)

| componente | host | versão | hash |
|---|---|---|---|
| `server_api.py` | dobslit `:8001` | v1.2 | `7565affa25379c7219001f92aeb3902c8a6997054c7581d777981467db15c226` |
| `transport_align.py` | dobslit `qrng-api/` | (v1) | `85d4e67a5d59f285a118d7ba660ac2c16216d99ef1068ec297687d794f6b98f5` |
| `qrng-connector.py` | dobslit `qrng-fifo.service` | patched | `0ee2638f0ca055fe823683e18c283ad8183e55d0851276c5d428f69376119290` |
| `nist_service.py` | dobslit `:8002` | 1233 linhas (real) | `c3e4c99f33e09754ee31aa2fa0a1470b01f65f6d99dd859b395b7365d0d2fc9c` |
| imagem `qrng-client-api` | Bongo `:3010` | `:4137bfe` | `sha256:9d4ac9a3a6d6cc323713265f0250d49b861d8f3ca4bc949d370ed6ca4c642821` |
| imagem frontend | Bongo `:3001` | `qrng-web:9e36a90` | `sha256:35e30be7b97fb89012585c8d0de8153fca260c20b4fb943746ee80381c63a697` |

Processos: `qrng-fifo`, `qrng-api`, `qrng-nist-api` (dobslit, `Restart=always`,
User=dobslit); containers `qrng-client-api` + `qrng-web-1` (Bongo,
`--restart unless-stopped`). Portas Bongo: `127.0.0.1:{3001,3010,18001,18002,22222}`.
Volumes: `qrng-demo-react_qrng-tokens-db`, `qrng_qrng-tokens-db` (órfão).
Tokens DB: **users=1** (`contact@primusquantum.com`), **api_tokens=0**.
NIST DB: **3917 jobs** (preservados na migração). Campanha NIST: **concluída**.

### Final (após item 2)

Só muda: container `qrng-client-api` recriado da **mesma imagem `:4137bfe`**, **sem**
`LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE`. `RestartCount=0`. Tudo o mais idêntico.
Geração de chaves/seeds/nonces/tokens criptográficos: **DESABILITADA** (frontend
`blockedOperational=true`; backend sem rota anônima). RCT/APT: **fora do caminho
live** (não implementados). FPGA/RTL: **não alterados**.

## 2. Commits e branches

- `main` = `51c1a2d` (inalterado nesta rodada).
- Branch `fix/live-provenance-crypto-readiness-20260829`:
  - `06acade` — itens 3–8 (word-integrity buffer + connector por geração +
    modelo formal de proveniência); 27 testes `provenance.test.js` + 32
    `test_word_integrity.py` + 12 `test_transport_align.py` verdes.
  - (este relatório + docs — próximo commit).
- CI: a confirmar no push da branch (não bloqueia `main`).

## 3. Correção de `actual_origin` (item 2)

**Feito em produção.** Removida a variável `LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE`
do container `qrng-client-api` (recriado da mesma imagem `:4137bfe`, mesmo banco,
mesmos volumes; nada mais alterado).

Resultado em `https://bongo.dobslit.com/qrng/api/random` (2026-08-29):

```json
{ "actual_origin": "unknown", "live_verified": false, "captured_at": null,
  "transport_health": "healthy", "buffer_health": "discontinuous",
  "entropy_health": "not_assessed" }
```

`buffer_health` reporta **`discontinuous`** (não `healthy` como o alvo do item 2)
porque o `server_api.py` v1.2 em produção conta **todo** evento `drop_oldest`
(backpressure normal — buffer cheio + consumo ≈ 0) como descontinuidade. Isso é
o **bug de semântica** que os itens 5–7 corrigem (só `realign`/gap real deveria
marcar `discontinuous`). A correção está **implementada e testada** na branch
(`word_ring_buffer.py`) mas **não implantada** (o item 2 proíbe empacotar outras
mudanças). O importante do item 2 está cumprido: **`actual_origin=unknown`,
`live_verified=false`, sem bypass por env var.**

Smoke não destrutivo: API 200; register/login/token OK (users/tokens
preservados); Raw/Hex/Base64/uint8 200; Swagger `/qrng/v1/docs/` 200; OpenAPI
`/qrng/v1/openapi.json` 200; NIST `/qrng/nist/health` 200 (engine real,
`synthetic=false`); nenhum fallback classificado como live. **Sem teste real de
rollback.**

## 4. Resultado dos testes de alinhamento (item 3)

`physical-layer/test_word_integrity.py` — **32 testes, verdes**. Cada cenário
verifica os **valores uint32 EXATOS** (não só contiguidade). NENHUMA asserção
foi enfraquecida.

| cenário | verificação de valor exato | resultado |
|---|---|---|
| desconexão em fronteira de palavra (o "esperado 6 / obtido 458752") | `u32[5] == 5` (a 6ª palavra entregue É a palavra física 5, não um frankenword) | ✅ |
| cauda de 1 B na queda | grid re-encaixa; `u32[5] == 6`; palavra 5 **perdida** (registrada, não remendada) | ✅ |
| cauda de 2 B | idem, descarta 2 B no realign; `u32[5] == 6` | ✅ |
| cauda de 3 B | idem, descarta 1 B; `u32[5] == 6` | ✅ |
| perda de UMA palavra inteira | `u32[10] == 11` (pula a 10) | ✅ |
| perda de MÚLTIPLAS palavras | `u32[8] == 20`; subsequência ordenada de fifo.c | ✅ |
| reconexões consecutivas | `u32[:3] == [0,1,2]`; `connection_generation ≥ 2`; todas palavras reais | ✅ |
| partial reads (1 B por vez) | `u32 == range(50)` | ✅ |
| partial writes (pedaços 1/2/3/5/7/11/13 B) | `u32 == range(60)` | ✅ |
| EOF | 7 palavras + 2 B de cauda → só 7 palavras entregues; 8ª → timeout | ✅ |
| timeout (buffer vazio) | `pop_bytes` → `None` | ✅ |
| restart do connector | nova `connection_generation`; valores intactos | ✅ |
| restart do produtor | nova `source_session_id`; `discontinuity_before="session_change"` | ✅ |

**Propriedade comprovada:** toda palavra entregue via `/v1/uint32` (no pipeline
`fifo.c → WordAligner → WordRingBuffer → pop_bytes`) corresponde EXATAMENTE a uma
palavra completa do `fifo.c`; nenhuma mistura bytes de duas palavras físicas ou
de duas conexões.

**Limitação registrada:** o número de bytes **perdidos na rede TCP** (entre o
`nc` da FPGA e o connector) **não é descoberto** — só a cauda local (0–3 B) é
quantificada. Onde a perda é não-múltipla de 4, o realinhamento **descarta** 0–3
B para re-encaixar o grid, e a(s) palavra(s) atravessada(s) pela queda são
**perdidas** (não remendadas). Marcado `unknown_gap=true`, sem `gap_bytes`.

## 5. Prova com valores uint32 exatos

Ver a tabela do item 4. Exemplo canônico (`test_desconexao_em_fronteira_de_palavra`):
fonte = palavras 0..399; connector repassou 20 B (5 palavras) e caiu numa
fronteira; a nova conexão retoma da palavra 5. Resultado entregue:
`[0,1,2,3,4,5,6,7,8,9]` — a 6ª palavra é **5** (a palavra física 5), **não**
`0x00070000 = 458752` (que seria um frankenword misturando o fim da palavra 4 com
o início da 6). Asserção `assert u32[5] == 5` — presente e verde.

## 6. Arquitetura do ring buffer (itens 5)

`physical-layer/word_ring_buffer.py` — **Opção A** (buffer baseado em palavras):

- armazena internamente **unidades de 4 bytes** (uma palavra por slot);
- `head`/`tail`/`size`/`drop_oldest` avançam sempre em **múltiplos de 4**;
- `pop_bytes(N)` consome `ceil(N/4)` palavras, devolve **exatamente N bytes**,
  **descarta explicitamente** os `0–3` bytes finais (`alignment_discarded_bytes`),
  e o **próximo** pedido começa em **nova fronteira de palavra**;
- um pedido **Raw de 1 byte NÃO desalinha** pedidos `/v1/uint32` posteriores
  (teste `test_raw1_uint32_raw3_uint32_hex5_montecarlo`: sequência
  Raw1→uint32→Raw3→uint32→Hex5→MonteCarlo, os uint32 continuam batendo com
  palavras completas da fixture).

Testes de buffer (subset): buffer vazio, buffer cheio, wrap-around, drop-oldest
em palavras, request concorrente produtor/consumidor, pedidos de 1/2/3/4/5/4097
bytes (cada um: `(N + alignment_discarded) % 4 == 0` e a próxima palavra na
fronteira), capacidade insuficiente → timeout, SHA-256 sobre os bytes retornados.

## 7. Offset absoluto e geração (item 6)

`source_session_id` (muda a cada reload de bitstream / restart do produtor /
`new_session()`), `connection_generation` (+1 por reconexão do connector),
`source_offset_bytes` (**tudo que entrou**: entregues + descartados por
alinhamento + drop-oldest + fim de conexão), `buffer_tail_source_offset`,
`response_start_offset` / `response_end_offset` (offsets absolutos em bytes da
resposta). Bytes perdidos **antes** do connector → `unknown_gap=true`, **nunca**
uma quantidade. Cada reload/restart/perda de continuidade cria **nova**
`source_session_id`. Testado (`test_offset_contabiliza_tudo`,
`test_unknown_gap_nao_e_quantidade`, `test_restart_produtor_nova_sessao`).

## 8. Metadata por bloco (item 7)

`Segment` grava por push: `received_first_at`, `received_last_at`,
`source_session_id`, `connection_generation`, `discontinuity_before`
(`none`|`drop_oldest`|`realign`|`unknown_gap`|`session_change`). `ResponseMeta`
expõe headers:

```
X-QRNG-Received-First-At   X-QRNG-Received-Last-At
X-QRNG-Source-Session-Id   X-QRNG-Connection-Generation
X-QRNG-Response-Start-Offset  X-QRNG-Response-End-Offset
X-QRNG-Unknown-Gap-Before  X-QRNG-Alignment-Discarded-Bytes
X-QRNG-Discontinuity-Before
```

`X-QRNG-Captured-At` **permanece ausente** até existir timestamp produzido no
ponto de aquisição (RTL — item 9). SHA-256 calculado sobre os **bytes efetivamente
retornados** (`ResponseMeta.sha256_hex`, testado).

## 9. Definição de live (item 8) — modelo formal

`qrng-client-api/lib/provenance.js` `resolveProvenance` retorna, separados:

```
delivery_mode            = streaming | replay | fallback | none
transport_origin         = fpga_tcp | replay | fixture | historical | fallback | none
actual_origin            = live | live_unverified | unknown | replay | fixture | historical | fallback
physical_capture_verified = bool
live_verified            = bool
```

Enquanto não houver evidência de aquisição física, o estado honesto é:

```json
{ "delivery_mode": "streaming", "transport_origin": "fpga_tcp",
  "actual_origin": "unknown", "physical_capture_verified": false,
  "live_verified": false }
```

— comunica "a API está recebendo um stream em tempo real do caminho FPGA" **sem**
afirmar captura física verificada.

### 10. Critérios para `actual_origin=live` (8.1) — TODOS obrigatórios

| # | critério | sinal | estado hoje |
|---|---|---|---|
| 1 | `source_session_id` criado no produtor | header `X-QRNG-Source-Session-Id` | ❌ (server_api v1.2 não emite; `word_ring_buffer.py` tem, não implantado) |
| 2 | sequência monotônica no produtor | `X-QRNG-Sequence` + caller `sequenceMonotonic` | ⚠️ (sequence emitido; monotonicidade não checada pelo consumidor) |
| 3 | timestamp na aquisição ou fronteira mais próxima | `captured_at` \|\| `received_at` | ✅ (received_at) / ❌ (captured_at) |
| 4 | hash do MESMO bloco na origem e no consumidor | `captureSha256Verified === true` | ❌ (server.js não re-hasheia o corpo hoje) |
| 5 | identidade do produtor + versão | `source_instance` + `provenance_version` conhecido | ✅ |
| 6 | sem replay / arquivo histórico | `instance_mode === "live"` e `!fallback` | ✅ |
| 7 | sem descontinuidade desconhecida no bloco | `X-QRNG-Unknown-Gap-Before !== "true"` | ⚠️ (não emitido pelo v1.2; buffer_health=discontinuous hoje) |
| 8 | source status operacional | `transport_health === "healthy"` | ✅ |
| 9 | resposta pertence à sessão atual | `source_session_id === currentSessionId` | ❌ (sem conceito de sessão implantado) |
| 10 | política de frescor documentada | `sample_age ≤ maxSampleAgeMs` | ✅ (janela 300 s) |

`live_criteria` é retornado no `provenance_detail` mostrando exatamente quais
itens faltam. **Hoje: 4 dos 10 não atendidos → `actual_origin=unknown`.**

### 10bis. Critérios para `live_verified=true` (8.2)

Além dos 10 acima: carimbo de captura **físico** (`captured_at`), metadata
vinculada ao bloco, mecanismo **anti-replay** verificado, identidade do produtor
**validada** (assinatura/cadeia), hash == corpo, timestamp na janela, sessão +
sequência válidas, **nunca** por variável de ambiente. `live_verified_criteria`
no `provenance_detail`. **Hoje: impossível** (sem `captured_at`, sem anti-replay,
sem validação de identidade do produtor).

**A flag `allowLiveWithoutCaptureEvidence` ficou INERTE** — não produz `live`
nem `live_verified`. `actual_origin=live_unverified` só quando o contrato opta
explicitamente (`emitLiveUnverified`), **nunca** por env var. Testado
(`8: live_verified NUNCA por variável de ambiente`).

## 11. Resultado da inspeção RTL (item 9)

`RTL_INSPECTION_20260829.md`. **Placa = z20_125_4ch** (Zynq-7020, 125 MS/s, 14
bit, 4 canais). **Bitstream carregado = custom** (`/root/stream_app.bit.bin`,
2 083 744 B ≠ stream_app stock 2 124 032 B). **Projeto Vivado/RTL do bitstream
carregado: NÃO DISPONÍVEL** (não está na placa/dobslit/Bongo/repo; não é
público). `stream_app` stock de referência: `redpitaya-fpga` `Release-2024.3` @
`b6023edeba7ea396da19346909c4aafeef7bf1f0`. **BLOQUEIO** para `live_verified` e
prontidão criptográfica.

## 12. Unidade da amostra

```
NOISE SOURCE SAMPLE   = INDETERMINADO (RTL custom não disponível)
DIGITIZED SAMPLE      = 14 bits/canal @ 125 MS/s (placa); packing/decimação = RTL, INDETERMINADO
TRANSPORT WORD        = uint32-LE, 4 bytes (CONFIRMADO na origem — fifo.c)
ASSESSMENT SYMBOL     = 8 bits (escolha de análise), NÃO a amostra física
HEALTH TEST SYMBOL    = a definir com a unidade física
CONDITIONED           = software: NÃO; hardware/RTL: INDETERMINADO
CONDITIONING FUNCTION = nenhuma identificada
PHYSICAL SAMPLE RATE  = INDETERMINADO
TRANSPORT WORD RATE   = ~174 805 palavras uint32/s (MEDIDO)
```

## 13. Resultado final da campanha NIST (item 10)

`NIST_CHARACTERIZATION_20260829.md`. **Caracterização do TRANSPORT STREAM**, não
validação da noise source. 25 assessments (`run_new_01..05` × {intercalado + 4
byte-lanes}).

- **Stream intercalado (tamanho normativo):** IID **FALHOU** em `run_new_01..04`;
  `run_new_05` **INCONCLUSIVO** (`ea_iid` timeout 2400 s). Não-IID `h_min` de
  6,878 a 7,127.
- **Byte-lanes:** **24/24 PASS IID** (incl. exploratórias). Não-IID `h_min` de
  6,491 (exploratório) a 7,090 (normativo).
- **Estimador limitante:** **Compression Test Estimate (trilha bit string)** em
  23/25 (exceção `run_new_03.L0/L1` — trilha original / predição).

## 14. Resultados elegíveis e exploratórios (item 10)

| grandeza | valor | classe |
|---|---|---|
| menor estimativa válida do **stream intercalado** | **6,878090** bits/símbolo 8 bits (`run_new_02.full`) | NORMATIVO |
| menor estimativa válida **por lane** (≥ 1M símbolos) | **6,855328** (`run_new_04.L2`) | NORMATIVO |
| menor **resultado exploratório** (< 1M símbolos) | **6,491161** (`run_new_02.L2`, ~262 144 símbolos) | **EXPLORATÓRIO — não é crédito operacional** |
| estimador limitante | Compression (bit string) | — |

**Não somar entropia entre lanes** — independência entre lanes não demonstrada.

## 15. Plano de restart campaign (item 11)

`CRYPTO_READINESS_ARCHITECTURE.md §11`. Taxonomia dos "restarts";
**"reload de bitstream ≠ restart físico da noise source"**; evento recomendado =
**power-cycle do módulo óptico** (ou da placa, documentando a limitação); matriz
`1000 × 1000`; startup samples a descartar = warm-up do laser + relock de PLL (a
medir); intervalo ≥ warm-up (provisório 60 s); duração ~17–20 h; automação com
watchdog + tap read-once; logs por linha; `ea_restart` na análise; impacto =
fonte indisponível durante a janela; rollback operacional documentado **sem
executar**; janela necessária ~24 h com acesso à PDU/relé do óptico.
**NÃO EXECUTADA.**

## 16. Projeto RCT/APT (item 12)

`CRYPTO_READINESS_ARCHITECTURE.md §12`. Sobre a **unidade da noise source** (item
9), **não** sobre bytes por serem bytes. State machine
`INITIALIZING/STARTUP_TESTING/HEALTHY/DEGRADED/FAILED/RECOVERING` com: descarte de
startup, nenhuma entrega antes do startup test, falha **interrompe** a entrada no
serviço de entropia, buffer pré-falha **invalidado**, recuperação controlada,
métricas por lane, logs por transição. Thresholds `(H, α, W, C)` **pendentes** de
itens 9/10/11. **Não ativar em produção nesta rodada** — protótipo só em staging.

## 17. Arquitetura SP 800-90B (item 13.1)

`CRYPTO_READINESS_ARCHITECTURE.md §13.1`. Entropy source: noise source
(indeterminada — item 9) → health tests (item 12) → **condicionador vetted
SHA-256** no broker (x86), `n_in` dimensionado para `h_in ≥ output_len/0.999`
com folga → crédito `min(n_out, h_in)`, **nunca** mais que a entrada conservadora.
Startup/restart/recovery = itens 11/12. Para cada saída: `input_samples`,
`input_bytes`, `credited_entropy_bits`, `conditioner`, `output_bits`,
`security_strength`.

## 18. Comparação de condicionadores (item 13.1)

| opção | tipo | veredito |
|---|---|---|
| nenhum | — | só se `h_min` final da noise source for alto e estável pós-restart |
| **SHA-256** | **vetted** | **RECOMENDADO** — vetted, revisável, sem dependência nova, no broker x86 |
| HMAC-SHA-256 | vetted | alternativa |
| AES-CMAC | vetted | se throughput no x86 for gargalo |
| XOR / von Neumann / LFSR | non-vetted | **NÃO** — penalidade da SP 800-90B, sem ganho |

**Não condicionar só para melhorar teste estatístico.**

## 19. Comparação de DRBGs (item 13.2)

| mecanismo | veredito |
|---|---|
| Hash_DRBG-SHA-256 | candidato |
| **HMAC_DRBG-SHA-256** | **RECOMENDADO** — mais analisado, resistente a mau uso, sem AES |
| CTR_DRBG-AES-256 | candidato se throughput crítico |

Instantiate/reseed/generate/prediction-resistance/personalization/additional-input/
`reseed_interval` conservador/sem persistência em disco/`zeroization`/um `generate`
por vez — detalhado em `§13.2`. **Vetores CAVP oficiais** como testes bloqueantes
(a implementar).

## 20. Matriz RBG1/RBG2/RBG3/RBGC (item 13.3)

| classe | usa live entropy source? | aplicável ao Kapuã |
|---|---|---|
| RBG1 | não (semente única externa) | só fallback degradado curto |
| RBG2 | opcional | possível se a entropy source não for "live" classificável |
| **RBG3** | **SIM (obrigatório)** | **alvo SE a live entropy source for comprovada** |
| RBGC | — | para descrever a cadeia `noise/raw → entropy → DRBG` auditável |

## 21. Arquitetura criptográfica recomendada

- **3 produtos separados:** `/v1/noise/raw` (bruto, científico — o atual
  `/v1/random` vira isto), `/v1/entropy` (entropy source avaliada + condicionada),
  `/v1/random/cryptographic` (RBG/DRBG).
- **Condicionador:** SHA-256 (vetted) no broker.
- **DRBG:** HMAC_DRBG-SHA-256, reseed por janela de health + `prediction_resistance`
  sob demanda, estado nunca persistido.
- **Construção:** **RBG3** — **condicional** à comprovação da live entropy source
  (itens 8/9/12). Enquanto não comprovada: **não** oferecer
  `/v1/random/cryptographic`; `/v1/entropy` no máximo `assessment=incomplete`
  para ciência, **não** para chaves.
- **Não** declarar "conforme SP 800-90C" só por combinar QRNG + DRBG.

## 22. Política de falha (item 14)

`CRYPTO_READINESS_ARCHITECTURE.md §14`. `/v1/entropy` e
`/v1/random/cryptographic` **falham fechado** (503 estruturado) em: FPGA offline,
connector desconectado, sequência quebrada, replay, hash divergente, timestamp
antigo, RCT/APT/startup fail, buffer esgotado, DRBG sem reseed, condicionador
indisponível. **Fallback histórico / arquivo / `Math.random` / fixture / PRNG
demonstrativo NUNCA** alimenta esses endpoints (ausência de código, não flag).
Continuidade temporária via estado do DRBG (90C) só com classe + limites +
security_strength + `max_requests_sem_reseed` + condição de bloqueio + momento
obrigatório de reseed **documentados** — senão a resposta é 503.

## 23. Validação do NIST produtivo (item 15)

`https://bongo.dobslit.com/qrng/nist` (2026-08-29):

| checagem | resultado |
|---|---|
| engine | **`sp800-90b-reference`** (real), `synthetic_result=false`, `assessment_execution_valid=true` |
| periódico / captura live | `periodic_enabled=false`, `live_capture_configured=false` |
| jobs históricos | **3917** preservados (verificado via SQLite na migração; `PRAGMA table_info` com colunas novas) |
| queue / estados | `queue_depth=0`, `has_active_job=false`, `min_bytes=1000000` |
| upload `.bin` (1 MiB) | job `queued → running → completed` em ~20 s; **binário SP 800-90B real rodou**: `iid_passed=true`, `h_min_non_iid=7.255737`, `sample_origin=user_upload` (**não** "live") |
| upload `.txt` (u32 decimal) | job `queued` (worker normaliza) |
| extensão inválida `.md` | **HTTP 400** rejeitado |
| dados históricos classificados como live? | **NÃO** (`sample_origin` ∈ {unknown, user_upload}) |
| teste real de rollback | **NÃO executado** (backups preservados: `/home/dobslit/deploy_backup/{nist_service.py,nist.db}.20260829T033603Z`) |

## 24. Lista de bloqueios

| # | bloqueio | impacto |
|---|---|---|
| B1 | **Projeto RTL/Vivado de `stream_app.bit.bin` não disponível** | unidade da amostra, taxa física, condicionamento em HW → indeterminados. Bloqueia `live_verified` e prontidão criptográfica (gates 1–4). |
| B2 | **`server_api.py` v1.2 não emite `X-QRNG-Source-Session-Id` / `-Unknown-Gap-Before`** e não integra `word_ring_buffer.py` | itens 5–8 não observáveis em produção; `buffer_health` reporta `discontinuous` por contar drop-oldest. Correção testada na branch, **não implantada**. |
| B3 | **`server.js` não re-hasheia o corpo** contra `X-QRNG-Block-SHA256` | critério 8.1#4 nunca satisfeito → `actual_origin` nunca `live`. |
| B4 | **Restart campaign não executada** (evento físico correto não confirmado — alimentação do laser) | sem restart tests SP 800-90B → sem min-entropia com crédito de restart. |
| B5 | **RCT/APT não implementados** no ponto correto | sem health tests contínuos → gates 11–13. |
| B6 | **Condicionador / DRBG / construção 90C não implementados** | gates 15–20. |
| B7 | **Sem revisão independente** e sem CI/E2E bloqueante para o caminho cripto | gates 22–23. |
| B8 | 18 alertas dependabot em `main` (pré-existentes, deps de build) | fora do escopo; `VULNERABILITY_MATRIX.md`. |

## 25. Próxima autorização necessária

1. **Obter o projeto RTL/Vivado** de `stream_app.bit.bin` (ou descrição assinada
   da cadeia física) — desbloqueia B1.
2. **Janela de manutenção do `server_api.py`** para integrar `word_ring_buffer.py`
   + emitir `X-QRNG-Source-Session-Id`/`-Unknown-Gap-Before`/offsets absolutos
   (itens 5–7) — desbloqueia B2. **Não** empacotar com nada mais.
3. **`server.js`**: re-hashear o corpo contra `X-QRNG-Block-SHA256` (rebuild +
   canário + swap, procedimento de 2026-08-28) — desbloqueia B3.
4. **Confirmar o evento de restart físico** (alimentação do laser / acesso à
   PDU) e **autorizar a restart campaign** (~24 h) — B4.
5. **Autorizar o protótipo RCT/APT em staging** (só staging) — B5.
6. **Autorizar a implementação do caminho criptográfico** (`/v1/noise/raw` alias +
   `/v1/entropy` + `/v1/random/cryptographic`, condicionador SHA-256, HMAC_DRBG,
   vetores CAVP, RBG3) **em staging**, com revisão independente antes de qualquer
   deploy — B6/B7.

---

## Critérios

| Critério | Estado | Evidência | Bloqueio |
|---|---|---|---|
| Transporte live | **SIM** | `delivery_mode=streaming`, `transport_origin=fpga_tcp`; `total_pushed` sobe; `fifo.c` lê a FPGA ao vivo | — |
| Captura física live | **NÃO** | `captured_at=null`; sem timestamp no ponto de aquisição | B1, B3 |
| `live_verified` | **NÃO (false)** | 8.2 impossível hoje (sem carimbo físico, sem anti-replay, sem validação de identidade do produtor) | B1, B2, B3 |
| Alinhamento uint32 | **COMPROVADO (staging)** | `test_word_integrity.py` 32/32 — valores uint32 exatos em todos os cenários | não implantado (B2) |
| Unidade da amostra | **INDETERMINADA** | `RTL_INSPECTION_20260829.md` | B1 |
| Min-entropia válida | **só transporte** | `NIST_CHARACTERIZATION`: intercalado `6,878`; lane normativa `6,855`; sem restart tests | B1, B4 |
| Restart campaign | **NÃO EXECUTADA** | plano em `CRYPTO_READINESS_ARCHITECTURE §11` | B4 |
| RCT/APT | **só projeto** | `§12` (state machine, parâmetros pendentes) | B5 |
| Condicionador | **recomendado, não implementado** | `§13.1.1` — SHA-256 vetted | B6 |
| DRBG | **recomendado, não implementado** | `§13.2` — HMAC_DRBG-SHA-256 | B6 |
| Construção 90C | **recomendada (condicional), não implementada** | `§13.3` — RBG3 se live entropy source comprovada | B1, B6 |
| Uso criptográfico | **NÃO** | 21/23 gates pendentes (`§16`) | B1–B7 |

---

```
DELIVERY_MODE              = streaming
ACTUAL_ORIGIN              = unknown
LIVE_VERIFIED              = false
ENTROPY_SOURCE_HEALTH      = not_assessed
SP800_90B_ASSESSMENT       = caracterização do transport stream concluída
                             (intercalado FALHA IID; lanes PASS IID; menor h_min
                             não-IID normativo 6,855 bits/símbolo de 8 bits);
                             restart tests NÃO EXECUTADOS; assessment da noise
                             source NÃO INICIADO (unidade física indeterminada)
CRYPTOGRAPHIC_SOURCE_READY = false
CRYPTOGRAPHIC_OUTPUT_ENABLED = false
```

## Veredito

```
OPERACIONAL, MAS AINDA EM VALIDAÇÃO DA FONTE
```

Sem "certificado NIST", "fonte aprovada pelo NIST", "live verificado", "seguro
para criptografia", "conforme SP 800-90B/90C" ou "8 bits de entropia por byte" —
nenhuma dessas condições foi atendida.

## Pare — aguardar autorização antes de

implantar a nova arquitetura criptográfica; ativar `/v1/entropy`; ativar
`/v1/random/cryptographic`; habilitar geração de chaves/seeds/nonces/tokens;
executar a restart campaign; ativar RCT/APT em produção; alterar RTL; declarar
`live_verified=true`.
