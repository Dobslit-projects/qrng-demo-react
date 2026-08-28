# Rodada 2026-08-28 — FPGA/FIFO→server_api, harness de captura, proveniência do upstream

**Branch:** `stabilize/physical-layer-baseline-20260826` = **`main`** = `origin/main` =
`7af9c5c` · **CI #60 (main) verde, 5/5 jobs** · **código em produção:** imagens
`qrng-client-api:9e36a90` / `qrng-web:9e36a90` (deploy 2026-08-28).
Terminologia mantida (Trilha IID / Trilha não-IID / Restart tests / Health tests;
"símbolo de 8 bits" = unidade passada ao `ea_iid`/`ea_non_iid`).

---

## 1. Branch e commits

`main` avançou de `f058f22` para `7af9c5c` (fast-forward). Commits desta rodada:

| commit | conteúdo | implantado? |
|---|---|---|
| `9e36a90` | (deploy 2026-08-28) endianness LE no frontend + provenance headers em JSON + rota `/_test/reset-rate-limit` (staging) | **SIM** (imagens `c0ebed0b`/`35e30be7`) |
| `6cae6ea` | registro do deploy em `DEPLOY_ARTIFACTS.md` | doc |
| `7e54aac` | **item 8** `stream_tap.py`+testes; **item 9** `UPSTREAM_PROVENANCE.md`, envelope v1 no fixture-upstream de staging, `provenance.js` consome versão+sha, `server_api.provenance_patch.py` (ref, não aplicado) | **NÃO** (staging + refs) |
| `7af9c5c` | **item 11** `RCT_APT_ARCHITECTURE.md` | doc |

## 2. Estado pós-deploy

Containers `qrng-client-api` (`sha256:c0ebed0b…`) e `qrng-web-1` (`sha256:35e30be7…`),
`Up`, `RestartCount=0`, `--restart unless-stopped`. `main`=`7af9c5c`. Serviço NIST
(`:18002`), broker (`:18001`), `server_api.py`/FPGA, nginx do host: **inalterados**.
`LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE` **não setado** → produção reporta
`actual_origin=unknown` / `live_verified=false`.

## 3. Smoke autenticado de produção (2026-08-28 19:24 UTC)

`register` (prod) → JWT → token pessoal (`dobslit_qrng_live_32d0e82add…`) →
`GET https://bongo.dobslit.com/qrng/v1/random?bytes=64&format=hex` → **HTTP 200**,
64 bytes, `X-Request-Id: req_38f0bb8a…`, `X-QRNG-Provenance: unknown`,
`X-QRNG-Live-Verified: false`, `X-QRNG-Fallback-Used: false`,
`X-QRNG-Source-Health: healthy`, `X-QRNG-Buffer-Health: healthy`;
`/v1/auth/me` → e-mail correto.

## 4. Confirmação da remoção do token/conta temporários

Após o smoke: token pessoal + conta `item12-smoke-…@deploy.test` **removidos** do
DB de produção. `GET /v1/random` com o token removido → **HTTP 403**. Row counts
**de volta a `users=1` (`contact@primusquantum.com`, real), `api_tokens=0`** —
idênticos ao backup pré-deploy `pre-deploy-9e36a90.bak` (sha `2876f3bb…`).

## 5. Unidade física da amostra — BLOQUEADA

```
NOISE SOURCE SAMPLE        = INCONCLUSIVO
PHYSICAL SAMPLE RATE       = INCONCLUSIVO
ASSESSMENT SYMBOL (físico) = INCONCLUSIVO
HEALTH TEST SYMBOL         = INCONCLUSIVO
TRANSPORT WORD             = uint32 little-endian, 4 bytes  (CONFIRMADO no software)
TRANSPORT THROUGHPUT       = 699 220 B/s ≈ 174 805 uint32/s  (MEDIDO 2026-08-28, 30,4 s, via /health)
CONDITIONING (software)    = nenhum (passthrough verbatim)
CONDITIONING (FPGA)        = INCONCLUSIVO (RTL não inspecionado)
```

**Motivo do bloqueio:** o acesso à Red Pitaya `10.0.10.2` é SSH por senha
encadeado (Bongo → dobslit → FPGA); o classificador de segurança do ambiente
bloqueia esse padrão mesmo para leitura (3ª rodada). Bongo **não tem**
`sshpass`/`paramiko`. `fifo.c` **não está** no repo nem na Bongo VM. A seção MMIO
do `fpga_readonly_inspect.sh` **não foi executada** — ela lê registradores AXI
(`devmem 0x43C00000..+0x1C`) e **não há confirmação** de que esses offsets são
read-only sem efeito colateral (o mapa de registradores/RTL é desconhecido; ex.:
offset `0x18` pode ser um registrador de reset do FIFO de recepção). Ver
`FPGA_INSPECTION.md`. **Handoff ao operador** permanece a via.

## 6. Inventário de amostras (piloto NIST L0, reproduzido)

| amostra | caminho | tamanho | SHA-256 | tipo |
|---|---|---|---|---|
| cap1 | `characterization_2026/run_new_01.bin` | 1 048 576 | `3021cbf1970170949e6a4f93d13c091ddd33d05841ecb86677cfb9fcca9c60c5` | histórica (origem live não verificada) |
| cap2 | `characterization_2026/run_new_02.bin` | 1 048 576 | `a75d0752d45b30d0929b567d754e46883605e29140a5ccc4c8836537c7406c59` | histórica (captura independente) |
| cap2-txt | `characterization_2026/run_new_02_u32.txt` | 2 824 182 | `0761151bce5f5fb2bf96648e5294ee705e7aaad6a76fdbf75edd257c58ccf5a2` | idem, decimal (normalização byte-idêntica a cap2 provada) |
| cap3 | `characterization_2026/run_new_03.bin` | 10 485 760 | `5d30cfabbf0e034da440c662ee2e104888b7ddfc041b9d37a6cd04cb3d215c64` | histórica |

Nenhuma renomeada como "live". `ea_iid`/`ea_non_iid` compilados de
`usnistgov/SP800-90B_EntropyAssessment` @ `87c104d0`, `bits_per_symbol=8`.

## 7. Elegibilidade por quantidade de símbolos

SP 800-90B exige ≥ 1 000 000 símbolos. cap1/cap2 = 1 048 576 símbolos de 8 bits
(elegíveis). cap3 intercalado = 10 485 760 (elegível). Cada byte-lane de cap3 =
2 621 440 símbolos (elegível, `undersize_warning=false` nas 4). cap2-txt
normalizado = cap2. `characterization_2026` completo: 64 arquivos, 57 elegíveis
(≥ 1 MiB), 7 pequenos (`NIST_FULLSET_COMPARE.md`).

## 8. IID por captura e por lane

| recorte | chi-square | LRS | permutação | **Trilha IID** |
|---|---|---|---|---|
| cap1 (intercalado, 1 MiB) | Passou | Passou | **FALHOU** | **FAIL** |
| cap2 (intercalado, 1 MiB) | Passou | Passou | **FALHOU** | **FAIL** |
| cap2-txt (== cap2) | Passou | Passou | **FALHOU** | **FAIL** |
| cap3 **intercalado** (10 MiB) | — | — | não concluído | **INCONCLUSIVO** (`ea_iid` timeout 1200 s, `exit=124`) |
| cap3 **byte-lane 0** | Passou | Passou | **Passou** | **PASS** |
| cap3 **byte-lane 1** | Passou | Passou | **Passou** | **PASS** |
| cap3 **byte-lane 2** | Passou | Passou | **Passou** | **PASS** |
| cap3 **byte-lane 3** | Passou | Passou | **Passou** | **PASS** |

## 9. Não-IID por captura e por lane

| recorte | `h_original` /8 bit | limitante original | `h_bitstring` /1 bit | limitante bitstring | **`h_min`** (min(h_orig, 8·h_bit)) | trilha |
|---|---|---|---|---|---|---|
| cap1 | 7.210061 | T-Tuple | 0.868917 | **Compression** | **6.951334** | bitstring |
| cap2 | 7.179165 | T-Tuple | 0.859761 | **Compression** | **6.878090** | bitstring |
| cap3 intercalado | 7.428630 | T-Tuple | 0.890185 | **Compression** | **7.121482** | bitstring |
| cap3 lane 0 | 6.986780 | **Lag Prediction** | 0.887097 | Compression | **6.986780** | original |
| cap3 lane 1 | 6.986771 | **MultiMCW Prediction** | 0.875745 | Compression | **6.986771** | original |
| cap3 lane 2 | 7.282199 | T-Tuple | 0.864414 | **Compression** | **6.915310** | bitstring |
| cap3 lane 3 | 7.296068 | T-Tuple | 0.875700 | **Compression** | **7.005597** | bitstring |

**Menor estimativa não-IID válida em todo o L0 = `6.878090` bits/símbolo de 8
bits** (cap2, intercalado). Por byte-lane, mínimo `6.915310` (lane 2).

## 10. Estimadores limitantes

**Compression Test Estimate (trilha bitstring)** em cap1, cap2, cap3-intercalado,
lane 2 e lane 3 (`8·h_bitstring < h_original`). Nas lanes 0 e 1 (que passam IID),
o limitante fica na trilha original (estimadores de predição — Lag / MultiMCW).
Baseline reproduzido: cap1 = `6.951334`, limitante Compression.

## 11. Diferenças entre lanes

Cada byte-lane de cap3 **passa IID isoladamente**; o stream intercalado
**falha/inconclusivo**. Leitura: **hipótese compatível com diferenças entre as
lanes** (posições de byte com distribuições marginais distintas — coerente com o
transporte `uint32-le`). **NÃO é prova** de comportamento não-IID intrínseco da
fonte, nem prova de que as 4 lanes são mutuamente independentes. Correlação linear
≈ 0 entre lanes **não** é independência. ⇒ union bound continua o teto
conservador; k-de-n continua hipótese (ver item 17 / `RCT_APT_ARCHITECTURE.md`).

## 12. Campanha completa — estado do gate

**NÃO EXECUTADA** (instrução explícita: "não execute o teste nist de 18horas").
Comando e estimativa preparados (`NIST_FULLSET_COMPARE.md`: ~18 h wall, ~1,4 GB,
lotes L0–L3). **Gate:** aguarda (a) autorização e (b) — para a *restart campaign* —
a definição do que constitui um restart real da noise source, que depende da
inspeção do RTL (bloqueada).

## 13. Matriz FPGA/FIFO → server_api.py

Estados: **COMPROVADO** / **INCONSISTENTE** / **NÃO OBSERVADO** / **BLOQUEADO POR RISCO OPERACIONAL**.

| Fronteira | Formato esperado | Formato observado | Evidência | Estado |
|---|---|---|---|---|
| **FPGA → FIFO** | amostra digital do bloco de ruído escrita no AXI FIFO; largura/semântica no RTL; `htole32` por palavra | — | RTL/bitstream não acessados; SSH à `10.0.10.2` bloqueado (3 rodadas); MMIO **não lido** (sem confirmação read-only dos registradores) | **BLOQUEADO POR RISCO OPERACIONAL** |
| **FIFO → fifo.c** | `fifo.c` faz `mmap` do AXI FIFO (~`0x43C00000`), lê a palavra, `htole32` por leitura, sem condicionamento no driver C (leitura de rodada anterior) | — | `fifo.c` **não está** no repo nem na Bongo VM; roda só na Red Pitaya | **NÃO OBSERVADO** (código) / **BLOQUEADO** (host) |
| **fifo.c → TCP** | `write()`/`send()` da palavra LE crua no socket `:12345`; sem framing/delimitador | `:12345` responde (rodada anterior); binário/fonte não inspecionados | — | **NÃO OBSERVADO** |
| **TCP → connector** | `recv()` de bytes crus, passthrough | `qrng-connector.py` (baseline "realmente executado", sha `4ed0b591…`): `s.recv(65536)` → `sys.stdout.buffer.write(data)` → **nenhuma** transformação/parsing/framing/contador; partial reads OK; EOF → reconexão backoff 2–30 s **sem resync/sequência**; sem duplicação | leitura do código-fonte | **COMPROVADO** (passthrough) + **INCONSISTENTE** (reconexão pode perder cauda sub-4 B de forma silenciosa → desalinhamento uint32 permanente e indetectável) |
| **connector → pipe** | `python3 connector.py > /tmp/fifo_qrng`; `stdout.buffer.write` + `flush` por chunk; pipe cheio → escritor bloqueia (backpressure) | igual ao esperado; `BufferedWriter.write` completa ou lança; `Restart=always` → janela de perda = 1 chunk ≤ 64 KiB **só** se o processo morrer entre `recv` e `write` | código + `qrng-fifo.service` | **COMPROVADO** (sem perda/dup em operação normal + backpressure) |
| **pipe → server_api.py** | `open(...,buffering=0)`; `read(n)` partial OK; EOF → reopen; `RingBuffer` 256 MiB **drop-oldest**; `/v1/raw` e `/random` binário = verbatim; `/v1/uint32` = `struct.unpack("<I")` (LE, só p/ JSON) | igual; `server_api.py` sha `892a4cb4…`; telemetria 2026-08-28: buffer **CHEIO**, `total_pushed` 54,5 GB, `total_popped` 15,4 MB → **99,48 % descartado** por drop-oldest; `total_pushed−total_popped−size` quantifica o gap | leitura do código + `/health` (não é 2º consumidor de dados) | **COMPROVADO** (bytes servidos verbatim) + **descontinuidade quantificável** (blocos `/v1/raw` consecutivos **não** contíguos; gap de GB agora) |

### Verificações específicas do checklist

| item | resultado |
|---|---|
| `fprintf` / `%u` / serialização textual | **NÃO** no caminho bruto. `server_api.py` usa `.hex()` / `struct.unpack` (JSON reversível exato) — **não** `%u`/decimal-concat/`fprintf`. connector + pipe = 100 % binário |
| delimitadores | **NENHUM** em qualquer fronteira observável — stream é sequência de bytes pura |
| `write()` parcial | `BufferedWriter.write` completa ou lança; `stream_tap.write_all` reencaminha o restante (item 8, testado) |
| `send()` parcial (FPGA→socket) | **NÃO OBSERVADO** (lado FPGA) |
| `recv()` parcial | `qrng-connector.py` é byte-oriented → tolera; `server_api` `read(n)` idem |
| alinhamento em 4 bytes | **NÃO** garantido por chunk. `/v1/raw` arredonda p/ baixo a múltiplo de 4 no server_api; `/random` (usado pela API pública) **não** alinha. Perda de 1–3 B numa reconexão do connector desloca o agrupamento uint32 **permanentemente** (sem resync) |
| bytes residuais entre chamadas | **SIM** — drop-oldest do RingBuffer torna `/v1/raw` consecutivos **não** contíguos. `X-QRNG-Sequence` (envelope v1, item 9) exporia |
| endianness | `uint32-le` declarado e aplicado consistentemente no software; `htole32` na FPGA (não re-verificado); frontend agora também LE (deploy) |
| signed/unsigned | `struct.unpack("<I")` = unsigned 32; `.hex()`/bytes = unsigned; **nenhuma** interpretação signed em ponto observável |
| descartes durante reconexão | connector: **SIM, possível** (cauda em trânsito no TCP quando o FPGA fecha), não quantificável sem sequência; reopen do pipe no server_api: buffer do kernel (64 KiB) ou escritor bloqueia — sem perda além disso |
| duplicação | **NÃO** em nenhuma fronteira (TCP confiável na conexão; reconexão começa do zero; RingBuffer não re-serve) |
| perda de bytes | possível em (a) reconexão do connector (**silenciosa**), (b) RingBuffer drop-oldest (**quantificável** via `total_pushed/popped`) |
| múltiplos consumidores | `server_api.py` é o **único** leitor de `/tmp/fifo_qrng`; `qrng-connector.py` é o **único** cliente de `:12345`. **Nenhum 2º consumidor aberto nesta rodada** (telemetria via `/health`) |

## 14. Resultado do harness em replay (item 8)

`physical-layer/instrumentation/stream_tap.py` — "read once → copy for evidence →
forward once" sobre `os.pipe()` real. `test_stream_tap.py`: **16/16 PASS**
(CI #60 verde). Cada bloco registra `capture_id`, `sequence`, `offset_start/end`,
`n_bytes`, `sha256`, `ts_monotonic`+`ts_civil`, `hexdump_head/tail`,
`forward_first_divergent_offset` (**−1 sempre** ⇒ forward byte-a-byte == entrada).

| vetor | verificado |
|---|---|
| sequência incremental | `fwd == source`, `evidence_sha256 == sha256(source)`, offsets contíguos |
| zeros | bytes 0 **permanecem 0** no forward e na evidência |
| `0xff` | preservados |
| tamanho não múltiplo de 4 (4099 B, fatias 1/2/3/5/7) | `total_forwarded % 4 == 3` (o tap **não** "arruma" alinhamento) |
| partial reads (1 byte/`os.read`) | 1 bloco por byte, `sha256` da evidência == fonte |
| partial writes (`os.write` curto de ≤ 3 B) | `write_all` reencaminha o restante; nada perdido/duplicado |
| reconexão sem gap | `Discontinuity` registrada **no sidecar**, `at_offset` correto, `gap_bytes=None` (o tap não inventa o tamanho), **nenhum** byte de metadata no fluxo |
| reconexão **com gap real** (40 B perdidos) | **não mascarada**: `fwd` tem 40 B a menos que a fonte lógica; `first_divergent_offset` = exatamente 1200 |
| stream longo (~1 MiB) | preservado |
| captura real reproduzida (`random.Random(20260827)`, mesma seed do fixture) | `fwd == payload`, `forwarded_equals_input=true`, determinístico entre execuções |

Restrições verificadas: sem 2º consumidor (um único `drain` do pipe de saída),
sem mutação, sem framing/delimitador/prefixo, sem metadata no fluxo, sem
descarte, sem duplicação (offsets contíguos), evidência primária = byte cru +
SHA-256 (hexdump ≤ 16 B, secundário). **Não implantado no caminho live.**

## 15. Proposta de proveniência do upstream (item 9)

`physical-layer/UPSTREAM_PROVENANCE.md`. **Opção escolhida:** envelope versionado
em **headers HTTP** emitido pelo `server_api.py` (corpo byte-idêntico) +
`GET /v1/capture/{id}` (consulta sem bytes) + log JSONL correlacionado.
Rejeitados: metadata dentro do stream, sidecar. Complementares: endpoint de
consulta, log.

**Envelope v1** (headers em `/random`, `/v1/raw`, `/v1/uint32`):
`X-QRNG-Provenance-Version: 1`, `X-QRNG-Source-Instance`, `X-QRNG-Source-Status`,
`X-QRNG-Captured-At` (= `last_push_time` do RingBuffer — instante em que os bytes
mais recentes entraram no broker; **não** é a detecção física; documentado como
tal), `X-QRNG-Capture-Id` (`cap_<seq>_<sha12>`), `X-QRNG-Sequence` (= `total_popped`
antes do pop), `X-QRNG-Block-SHA256` (SHA-256 do corpo exato — o consumidor
re-hasheia), `X-QRNG-Byte-Count`, `X-QRNG-Transport-Format`,
`X-QRNG-Buffer-Discontinuous`.

**Feito nesta rodada (staging + refs, NÃO implantado):**
- `staging/fixture-upstream/app.py`: envelope v1 + `GET /v1/capture/{id}`. Suíte
  Playwright de staging: **97 passed** (não quebrou).
- `qrng-client-api/lib/provenance.js`: consome `X-QRNG-Provenance-Version` e
  `X-QRNG-Block-SHA256`; **regra 6** (SHA divergente ⇒ nunca `live`,
  `buffer_health=discontinuous`); **regra 7** (versão desconhecida ⇒ evidência
  ignorada, degrada p/ `unknown`); novos campos em `provenance_detail`
  (`provenance_version`, `source_instance`, `sequence`, `capture_sha256`,
  `capture_sha256_verified`). `provenance.test.js`: **15 → 23** (CI #60 verde).
- `physical-layer/server_api.provenance_patch.py`: patch de referência do
  `server_api.py` real — **NÃO aplicado**.

**Impede má-classificação:** `instance_mode ∈ {replay, fixture, historical}` e
`fallback_used=true` continuam **teto** — nunca `live` mesmo com todos os headers
(testado: `item 9: envelope v1 mas instância REPLAY -> replay, NUNCA live`).

## 16. Resultado das visualizações em produção (item 10)

Smoke **não destrutivo** contra `https://bongo.dobslit.com` (Playwright na Bongo
VM, cookie `bongo_session` p/ passar o gate do nginx do host): **4/4 PASS**.
Resposta de rede efetivamente consumida (`/qrng/api/random?bytes=64&format=hex`,
2026-08-28 19:21 UTC): `X-Request-Id: req_a7ac5024…`, `X-QRNG-Provenance: unknown`,
`X-QRNG-Live-Verified: false`, `X-QRNG-Fallback-Used: false`,
`X-QRNG-Source-Health: healthy`, `X-QRNG-Buffer-Health: healthy`; corpo
`provenance=unknown`, `provenance_detail.actual_origin=unknown`,
`live_verified=false`, `provenance_version=null` (envelope não implantado).

| visualização | endpoint | formato | origem observada | transformação | verificação |
|---|---|---|---|---|---|
| Raw (Dados) | `/qrng/api/random` | raw | **API** — octet-stream N bytes, `Content-Length=N`, `X-QRNG-*` | nenhuma | `actual_origin=unknown`, nunca `live` |
| Hex / Base64 / uint8 (Dados) | `/qrng/api/random` | hex/base64/uint8 | **API** | decode reversível | idem; paridade em `serialization.test.js` |
| Monte Carlo (Dados) | `/qrng/api/random` | hex | **API** | `uint32-le / 2^32` | **max U = 0.9221 < 1**, nenhum `≥ 1`, bytes 0 preservados |
| π Monte Carlo (Aplicações) | `/qrng/api/random` | hex | **API** | `bytesToUint32Array` (**LE**, deploy) → `/2^32` | resultado plausível, **sem NaN** |
| Máx f(x) (Aplicações) | `/qrng/api/random` | hex | **API** | idem endianness LE | (coberto por `features.spec.js`) |
| Histograma / Scatter / Bits (Análise) | `/qrng/api/random` (coluna QRNG) | — | **API** (QRNG) | — | coluna PRNG = `generatePRNGSequence` (LCG) — **PRNG DE COMPARAÇÃO IDENTIFICADA** |
| PRNG × QRNG | `/qrng/api/random` (QRNG) | — | QRNG = **API**; PRNG = LCG **identificado** | — | — |
| Sonificação | `/qrng/api/random` | — | **API** (`fetchQrngBytes`) | `byte → nota` | sem `Math.random` no mapeamento |
| Faixa personalizada | `/qrng/api/random` + `uniformIntsFromBytes` | uint8 | **API** | rejection sampling (LE, sem viés de módulo) | — |
| galaxySpiral / mandala | `/qrng/api/random` | — | **API** | `bytes.length ? bytes[i] : rand` (fix `9e36a90`) | byte 0 **não** vira `Math.random` |
| QuantumVisualizer (fallback) | — | — | `Math.random()` **rotulado** "pré-coletado esgotado" | — | **FALLBACK EXPLÍCITO** — não exibido como `live` |
| Distribuição exponencial | — | — | **NÃO IMPLEMENTADA NA UI** (só `exponentialFromUniform` em lib + teste) | — | — |

Confirmado: `uint32` little-endian; `/2^32`; **nenhum valor ≥ 1**; bytes zero
permanecem zero; `Math.random()` só em fallback rotulado / PRNG de comparação
identificada / decoração (shimmer, tick de áudio, partículas) — **nunca** num
dado de visualização. **Nenhuma** viz classificada como `live` (todas
`live_verified=false`).

## 17. RCT/APT — recomendação de arquitetura (item 11)

`physical-layer/RCT_APT_ARCHITECTURE.md`. **RCT/APT NÃO ativados. Nenhum threshold
selecionado.** O que os dados do L0 mudam:

1. **Não rodar RCT/APT sobre o stream de bytes intercalado cru** — ele falha IID
   por estrutura (interleaving); um health test ali dispararia falso alarme numa
   fonte saudável. Rodar **de-intercalado** (por byte-lane) ou **sobre a palavra
   uint32** — decisão que depende do RTL.
2. RCT/APT **por byte-lane** é defensável como escolha de análise (cada lane
   passa IID), mas herda um recorte de **transporte**, não de física.
3. **Independência entre lanes: inconclusiva** → union bound = teto; k-de-n =
   hipótese.
4. **Health test lê o tap do PRODUTOR** (item 8), não o stream de cada cliente
   (drop-oldest de 99,48 % torna a amostra por cliente esparsa).

Dimensões a decidir na janela autorizada: unidade da amostra física; unidade do
health test; taxa física de símbolos; nº de testes simultâneos (8 vs 2);
dependência entre lanes; custo de um falso positivo (**não quantificado**);
política de falha (revisar "1 janela → FAILED"); política de recuperação
(duração indefinida); comportamento do buffer sob `FAILED`.

**Gate para thresholds — dados ainda necessários:** (1) RTL/AXI/FIFO; (2) taxa do
ADC/clock do bloco de ruído; (3) restart campaign; (4) dependência entre lanes em
capturas longas de-intercaladas; (5) SLA operacional (custo do falso FAILED, MTBF
alvo, orçamento de recuperação).

## 18. Riscos e limitações

| # | risco / limitação | severidade |
|---|---|---|
| R1 | **Reconexão do `qrng-connector.py` pode perder cauda sub-4 B silenciosamente** → desalinhamento uint32 permanente e indetectável (sem sequência/resync). Mitigação futura: `X-QRNG-Sequence` no envelope v1 + um marcador de resync no connector (mexe no caminho produtivo). | média — não corrompe entropia; quebra alinhamento posicional |
| R2 | **RingBuffer drop-oldest descarta 99,48 %** hoje (consumo ≈ 0). Blocos `/v1/raw` consecutivos **não** são contíguos. É comportamento documentado e mensurável (`total_pushed/popped`), não corrupção. | baixa (demo) / média sob carga |
| R3 | **FPGA/FIFO → server_api.py NÃO COMPROVADA** — 3 fronteiras a montante NÃO OBSERVADAS / BLOQUEADAS (RTL, `fifo.c`, servidor `:12345`). Inspeção read-only bloqueada pelo classificador; MMIO não executado por falta de confirmação read-only. Handoff ao operador em `FPGA_INSPECTION.md`. | bloqueio — impede fechar a unidade física e a taxa |
| R4 | **Envelope de proveniência v1 preparado mas NÃO implantado** no `server_api.py` real → produção segue `actual_origin=unknown` / `live_verified=false`. | baixa — é o estado honesto; exige janela de manutenção do upstream |
| R5 | **Restart tests e health tests não concluídos** → `SP 800-90B completo = NÃO`. Campanha completa não executada (instrução). | bloqueio para "conforme SP 800-90B" |
| R6 | 18 alertas dependabot no `main` (pré-existentes, fora de escopo — `VULNERABILITY_MATRIX.md`). Volume órfão `qrng_qrng-tokens-db`. | baixa / trivial |

## 19. Commits produzidos

`7e54aac` (item 8/9), `7af9c5c` (item 11). Ambos em `main` (fast-forward). CI #60
(main) e #59 (branch): **success, 5/5 jobs**.

## 20. Arquivos alterados

**Novos:**
- `physical-layer/instrumentation/stream_tap.py`
- `physical-layer/instrumentation/test_stream_tap.py`
- `physical-layer/UPSTREAM_PROVENANCE.md`
- `physical-layer/server_api.provenance_patch.py` (ref, não aplicado)
- `physical-layer/RCT_APT_ARCHITECTURE.md`
- `physical-layer/ROUND_2026-08-28_FPGA_HARNESS_PROVENANCE.md` (este)

**Modificados:**
- `.github/workflows/ci.yml` (+ step `test_stream_tap` no job `physical-layer-health`)
- `staging/fixture-upstream/app.py` (envelope v1 + `/v1/capture/{id}`) — **staging**
- `qrng-client-api/lib/provenance.js` (consome versão + block-sha; regras 6/7) — **não implantado**
- `qrng-client-api/test/provenance.test.js` (15 → 23)

**Não modificado:** `qrng-client-api/server.js` de produção, `server_api.py`
real, FPGA/FIFO, `nist_service.py`, nginx do host, containers em execução.

## 21. Próxima autorização necessária

1. **Janela para a FPGA `10.0.10.2`** — ou (a) regra de permissão de Bash para
   SSH read-only pela cadeia Bongo→dobslit→FPGA, ou (b) o operador roda
   `fpga_readonly_inspect.sh` (**sem** a seção MMIO até confirmar os registradores)
   e devolve stdout/stderr. Fecha itens 5, 13 (montante), 17-gate(1)(2).
2. **Janela de manutenção do `server_api.py`** para aplicar
   `server_api.provenance_patch.py` (envelope v1) — mexe no upstream de produção.
3. **Campanha NIST completa** (L1–L3, ~18 h) + **restart campaign** (1000×) —
   ambas aguardam autorização; a restart campaign também aguarda a definição do
   evento de restart real (depende de 1).
4. **`LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE=1`** em produção — só se/quando o
   envelope v1 estiver no `server_api.py` (senão continua sendo alegar `live`
   sem prova).

---

## Tabela de respostas

| Pergunta | Resposta | Evidência | Limitação |
|---|---|---|---|
| O stream intercalado é IID? | **NÃO** (cap1/cap2 FAIL permutação; cap3 10 MiB INCONCLUSIVO/timeout) | piloto L0, `ea_iid` @ `87c104d0` | 2 capturas de 1 MiB + cap3; falha compatível com diferenças entre lanes |
| Cada lane é IID? | **SIM** — 4/4 byte-lanes de cap3 passam (chi-square + LRS + permutação) | `ea_iid` por lane, 2 621 440 símbolos/lane, `undersize_warning=false` | só cap3; lanes = recorte de transporte, não de física |
| Qual a menor estimativa não-IID? | **`6.878090` bits / símbolo de 8 bits** (cap2, intercalado); por lane, mín. `6.915310` (lane 2) | `ea_non_iid` @ `87c104d0`; limitante Compression (trilha bitstring) | símbolo = byte, **não** amostra física |
| Qual é a unidade física da amostra? | **INCONCLUSIVA** | `NOISE_SOURCE_UNIT.md`; RTL/`fifo.c`/servidor `:12345` não inspecionados | acesso à FPGA bloqueado (3 rodadas); MMIO não executado |
| FPGA→server_api preserva os bytes? | **NÃO COMPROVADO.** 3 fronteiras a montante NÃO OBSERVADAS/BLOQUEADAS; TCP→connector→pipe→server_api = passthrough verbatim COMPROVADO no código, com **INCONSISTENTE** na reconexão do connector (perda sub-4 B silenciosa possível) e descontinuidade quantificável no drop-oldest | matriz do item 13; leitura de `qrng-connector.py`/`server_api.py`; telemetria `/health` | sem sequência/resync não dá para provar ausência de perda na reconexão |
| server_api→cliente preserva os bytes? | **SIM** | `serialization.test.js` + `api.spec.js` (raw==hex==base64==uint8, mesmo SHA-256, round-trip); smoke de produção 2026-08-28 | região FPGA→server_api não coberta |
| Token funciona em produção? | **SIM** | smoke autenticado 2026-08-28: register→JWT→token→`GET /v1/random` 200; token temporário **removido**, `users` de volta a 1 | — |
| Visualizações usam os bytes da API? | **SIM** | smoke de produção 4/4; `viz-provenance.spec.js` (CI #60); auditoria estática de `Math.random` | `Math.random` só em fallback rotulado / PRNG de comparação / decoração |
| Origem live está comprovada? | **NÃO** | `server_api.py` real sem envelope de captura → `actual_origin=unknown`, `live_verified=false` em toda resposta de produção | envelope v1 preparado, **não implantado** |
| Fonte está aprovada para criptografia? | **NÃO** | Restart/health/arquitetura pendentes | — |

---

## Veredito

```
OPERACIONAL, MAS AINDA EM VALIDAÇÃO DA FONTE
```

Não há "passou no NIST", "NIST validado", "IID comprovado", "sem viés",
"seguro", "live" nem "aprovado para criptografia" sem a delimitação de evidência
acima. O deploy de 2026-08-28 tornou o pipeline de software (API + frontend)
operacional e **honesto sobre a proveniência** (`unknown`/`live_verified=false`);
a **fonte física** permanece em validação (unidade física, taxa, restart/health,
independência entre lanes, integridade FPGA→server_api — todas pendentes de uma
janela na FPGA).

## Pare — aguardar autorização antes de

janela de acesso à FPGA `10.0.10.2` (mesmo read-only, pela cadeia bloqueada);
aplicar o envelope v1 ao `server_api.py` de produção; executar a campanha NIST
completa ou a restart campaign; ativar RCT/APT ou selecionar thresholds; setar
`LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE=1`; abrir um segundo consumidor da fonte;
trocar o serviço NIST produtivo; alterar FPGA/FIFO em produção.
