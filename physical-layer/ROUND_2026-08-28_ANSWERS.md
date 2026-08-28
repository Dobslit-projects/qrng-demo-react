# Rodada 2026-08-28 — respostas verificáveis às 4 perguntas

**Branch:** `stabilize/physical-layer-baseline-20260826` · **HEAD:** `1b54c24`
(**CI #54 verde, 5/5 jobs**) · **main:** `f058f22` (inalterado) ·
`local = VM = origin`
**Terminologia (obrigatória):** *Trilha IID* = testes de hipótese IID +
min-entropia aplicável. *Trilha não-IID* = estimativas não-IID e a menor
válida. *Restart tests* = avaliação separada, dependente de reinicializações
reais da noise source. *Health tests* = RCT/APT, separados do entropy
assessment. **"símbolo de 8 bits"** = a unidade efetivamente passada ao
`ea_iid`/`ea_non_iid` (`bits_per_symbol=8`), **não** a amostra física da noise
source (essa permanece INCONCLUSIVA).

---

## 1. Branch e commits avaliados

Rodada anterior fechou em `2733968`. Esta rodada: `33de069` (item 4.1
serialização), `b8e93c1` (item 8 + fix galaxy/mandala), `1f054ef` (itens 7/9
docs), `2fc9ffc`/`94c1c36` (item 8/9 — `viz-provenance.spec.js` enxuto após
CI #46/#47), `5ccdc2a`/`540feac`/`a5fd8d8` (L0 completo incl. byte-lanes),
`cdff682` (**f1** endianness `uint32-le` no frontend + 14 vetores de regressão;
`X-QRNG-*` em respostas JSON), `5fd9b9d`/`1b54c24` (**f2** rota
`/_test/reset-rate-limit` + `beforeEach`/`afterAll` nos specs de rate-limit —
resolve CI #48–#53; **CI #54 verde**). Nenhum commit em `main`.

## 2. CI real do HEAD

- **run #45** (`273396878d114aa76f48fa8d1c3e49afe0d77867`) —
  https://github.com/Dobslit-projects/qrng-demo-react/actions/runs/33180151062 —
  **completed / success**. 5 jobs, **todos os steps `success`** (só
  "Logs do staging em caso de falha" = `skipped`, esperado). **Sem
  `continue-on-error`** em nenhum workflow.
- **`c80f043` (código) × `2733968` (documental):** o diff entre eles é
  **só `STABILIZATION_REPORT.md`** (10+/9−). O `c80f043` foi o último commit
  de código; o `2733968` só editou o relatório. Logo o suite completo rodou
  sobre o mesmo código em #44 (`c80f043`) e #45 (`2733968`), ambos verdes.
- **CI real desta rodada — verificado pela API do GitHub Actions**
  (branch `stabilize/physical-layer-baseline-20260826`):

  | run | commit | conclusão | observação |
  |---|---|---|---|
  | #48–#51 | `94c1c36`…`a5fd8d8` | **failure** | só o step Playwright (staging); outros 4 jobs verdes |
  | #52 | `cdff682` | **failure** | idem (f1 endianness + 1ª tentativa de fix) |
  | #53 | `5fd9b9d` | **failure** | idem (2ª tentativa — `beforeEach` do fixture) |
  | **#54** | **`1b54c24`** | **success** | **5/5 jobs verdes, Playwright `97 passed`** |

  https://github.com/Dobslit-projects/qrng-demo-react/actions/runs/33193277945
- **Causa-raiz (bissecção na VM com fluxo idêntico ao CI** — checkout limpo,
  `docker compose staging`, imagem `mcr.microsoft.com/playwright:v1.62.1`,
  `E2E_STAGING_ONLY=1`): **1 teste** —
  `viz-provenance.spec.js "Aplicações (π)"` — estourava 30 s esperando
  `Erro: %`. O snapshot da página mostrava **`RATE_LIMIT_EXCEEDED`** ao lado do
  botão de π: `viz-provenance` roda **depois** de `ratelimit.spec.js`, cujo
  burst esgota `PUBLIC_RATE_LIMIT_PER_IP_PER_MINUTE` (60/min, bucket único
  atrás do nginx); a janela ainda não tinha rolado, então o `fetch` de π
  recebia **HTTP 429** e a viz nunca renderizava. π isolado, e π depois do
  teste "Dados" com fixture fresco, ambos passam — confirma o diagnóstico.
- **Correção (`1b54c24`):**
  1. `server.js`: rota **`POST /v1/_test/reset-rate-limit`** guardada por
     `ENABLE_TEST_ROUTES` (só staging/CI) — zera o `publicIpRateLimiter` do IP
     chamador + limpa o mapa de cota diária.
  2. `viz-provenance.spec.js` `beforeEach` e `ratelimit.spec.js` `afterAll`
     chamam essa rota → specs sensíveis a rate-limit ficam herméticos.
  3. (junto) `server.js`: `setProvenanceHeaders` também nas respostas **JSON**
     de `/v1/random` e `/v1/public/random` (antes só `raw`) → `X-QRNG-*` em
     todos os formatos, paridade header↔corpo (ganho real p/ Jupyter);
     `viz-provenance` `INSTRUMENT` lê proveniência **só dos headers** (sem
     `res.clone()` do corpo).
- Contagens de teste unitário (CI #54, verde): `qrng-client-api` **145**
  node:test, `qrng-nist-api` **44** python, frontend `qrngHelper.test.js`
  **58** vitest (44 + 14 vetores de endianness `readUint32LE`) + `AppContext`
  22. **Sem `continue-on-error` em nenhum workflow.**

## 3. Inventário e hashes das amostras L0

| amostra | caminho lógico | tamanho | SHA-256 | proveniência | tipo |
|---|---|---|---|---|---|
| cap1 | `characterization_2026/run_new_01.bin` | 1 048 576 | `3021cbf1970170949e6a4f93d13c091ddd33d05841ecb86677cfb9fcca9c60c5` | captura de caracterização (2026); **origem física live não verificada** | histórica |
| cap2 | `characterization_2026/run_new_02.bin` | 1 048 576 | `a75d0752d45b30d0929b567d754e46883605e29140a5ccc4c8836537c7406c59` | idem (**captura independente** de cap1) | histórica |
| cap2-txt | `characterization_2026/run_new_02_u32.txt` | 2 824 182 | `0761151bce5f5fb2bf96648e5294ee705e7aaad6a76fdbf75edd257c58ccf5a2` | serialização decimal de cap2 | histórica (texto) |
| cap3 | `characterization_2026/run_new_03.bin` | 10 485 760 | `5d30cfabbf0e034da440c662ee2e104888b7ddfc041b9d37a6cd04cb3d215c64` | idem | histórica |

- **Nenhuma foi renomeada como "live".** Todas são capturas de caracterização
  de 2026 — origem física em tempo real **não verificada** (o `server_api.py`
  não carimba `captured_at`; ver item 15).
- **Normalização do `.txt` demonstrada:** `run_new_02_u32.txt` normalizado
  (`struct.pack('<I', v)` por token) →
  `sha256 == a75d0752…` = **byte-idêntico a `run_new_02.bin`**. Logo o `.txt`
  é admissível e produz o MESMO assessment que o `.bin` (item 5/6 abaixo).
- Arquivos originais **preservados** (SFTP `get`, nunca `put`).

## 4. Comandos NIST executados

Ferramenta: **`ea_iid` / `ea_non_iid`** compilados de
`usnistgov/SP800-90B_EntropyAssessment` **commit
`87c104d0ed4cbc96103e7b8b38d6f2c7e0a6b289`** (o mesmo checkout de produção),
`g++ -std=c++11 -fopenmp -O2 -ffloat-store` (sem `-march=native`, imagem
`kapua-staging-nist-real:local`). Commit do runner:
`273396878d114aa76f48fa8d1c3e49afe0d77867`.

```
./ea_iid     -v /s/<arquivo> 8      # bits_per_symbol = 8
./ea_non_iid -v /s/<arquivo> 8
```

executados por: `L0.cap1.full` (`run_new_01.bin`), `L0.cap2.full`
(`run_new_02.bin`), `L0.cap2.txtnorm` (`run_new_02_u32.txt` normalizado),
`L0.cap3.full` (`run_new_03.bin`) e as **4 byte-lanes** de `cap3` (lane k =
bytes k, k+4, k+8, … — o transporte é `uint32`). `stdout`/`stderr`/`exit`/
`duração` salvos em `/root/nist_L0/results/` na VM.

## 5. Resultado IID por captura (Trilha IID)

| captura | chi-square | LRS | permutação | **Trilha IID** | min-entropia IID (`min(H_orig, 8·H_bit)`) |
|---|---|---|---|---|---|
| cap1 (`run_new_01.bin`, 1 MiB) | Passou | Passou | **FALHOU** | **FAIL** | 7.456189 — **não usar como crédito de entropia** |
| cap2 (`run_new_02.bin`, 1 MiB) | Passou | Passou | **FALHOU** | **FAIL** | 7.459140 — não usar |
| cap2-txt (== cap2) | Passou | Passou | **FALHOU** | **FAIL** | idêntico a cap2 |
| cap3 **stream intercalado** (`run_new_03.bin`, 10 MiB) | — | — | **não concluído** | **INCONCLUSIVO** | `ea_iid` atingiu `timeout 1200 s` (`exit=124`), sem veredito de permutação — só a linha parcial `min(H_orig, 8·H_bit)=7.509149` |
| cap3 **byte-lane 0** (bytes 0,4,8,…; 2 621 440 símbolos) | Passou | Passou | **Passou** | **PASS** | 7.481760 (não é crédito — ver não-IID) |
| cap3 **byte-lane 1** | Passou | Passou | **Passou** | **PASS** | — |
| cap3 **byte-lane 2** | Passou | Passou | **Passou** | **PASS** | — |
| cap3 **byte-lane 3** | Passou | Passou | **Passou** | **PASS** | 7.481760 |

`exit=0`, `dur ≈ 113–120 s` (ea_iid, 1 MiB); `dur ≈ 43 s` por byte-lane.
**A hipótese IID falhou nas duas capturas independentes de 1 MiB (stream
intercalado)**; em cap3, o stream intercalado de 10 MiB **não concluiu**
(timeout) mas as **4 byte-lanes isoladas PASSARAM na Trilha IID**. Uma leitura
possível: a falha IID do stream intercalado é uma **hipótese compatível com
diferenças entre as lanes** — o transporte é `uint32-le` e cada posição de byte
pode ter distribuição marginal distinta, de modo que a concatenação das 4 lanes
introduz estrutura detectável que não aparece lane a lane. Não é prova de
comportamento não-IID intrínseco da fonte, nem o contrário. De todo modo o
crédito de entropia vem da **Trilha não-IID** (item 6).

## 6. Estimativa não-IID por captura (Trilha não-IID)

| captura | `h_original` (trilha literal, /8 bit) | limitante original | `h_bitstring` (trilha bitstring, /1 bit) | limitante bitstring | `h_min_non_iid` = min(h_orig, 8·h_bit) | trilha que limita |
|---|---|---|---|---|---|---|
| cap1 | 7.210061 | T-Tuple Test Estimate | 0.868917 | **Compression Test Estimate (bit string)** | **6.951334** | **bitstring** |
| cap2 | 7.179165 | T-Tuple Test Estimate | 0.859761 | **Compression Test Estimate (bit string)** | **6.878090** | **bitstring** |
| cap2-txt | 7.179165 | T-Tuple | 0.859761 | Compression (bit string) | **6.878090** | bitstring |
| cap3 stream intercalado (10 MiB) | 7.428630 | T-Tuple | 0.890185 | **Compression Test Estimate (bit string)** | **7.121482** | **bitstring** |
| cap3 byte-lane 0 | 6.986780 | **Lag Prediction Test Estimate** | 0.887097 | Compression (bit string) | **6.986780** | **original** |
| cap3 byte-lane 1 | 6.986771 | **MultiMCW Prediction Test Estimate** | 0.875745 | Compression (bit string) | **6.986771** | **original** |
| cap3 byte-lane 2 | 7.282199 | T-Tuple | 0.864414 | **Compression Test Estimate (bit string)** | **6.915310** | **bitstring** |
| cap3 byte-lane 3 | 7.296068 | T-Tuple | 0.875700 | **Compression Test Estimate (bit string)** | **7.005597** | **bitstring** |

Nenhuma lane teve `undersize_warning` (2 621 440 símbolos > 1 000 000 mínimo).

**Baseline reproduzido:** cap1 = `6.951334` bits/símbolo de 8 bits,
limitante = **Compression** (trilha bitstring), exatamente como o esperado.
cap2 (captura independente) confirma o padrão com número um pouco menor
(`6.878090`). **Menor estimativa não-IID válida encontrada em todo o L0 =
`6.878090`** (cap2, stream intercalado); por byte-lane o mínimo é `6.915310`
(cap3 lane 2). Estimador limitante = **Compression** (trilha bitstring) em
cap1/cap2/cap3-intercalado e nas lanes 2 e 3; nas lanes 0 e 1 (que passam IID)
o limitante fica na trilha original (estimadores de predição).

## 7. Estimador limitante

Para todas as capturas L0 de 1 MiB: **`Compression Test Estimate (bit string)`**
(trilha bitstring). `8 × H_bitstring < H_original` → o resultado final vem da
trilha bitstring. O `limiting_estimator` do serviço agora **corresponde** a
`h_min_non_iid` via `limiting_path` (`bitstring`), com os dois valores das
trilhas expostos separadamente (`h_original_non_iid`/`original_limiting_estimator`
e `h_bitstring_non_iid`/`bitstring_limiting_estimator`).

## 8. Definição do símbolo avaliado

```
SÍMBOLO DE ASSESSMENT = 8 bits (byte). É o que foi passado a ea_iid/ea_non_iid
                        (bits_per_symbol=8). Para .txt u32, o wrapper serializa
                        cada uint32 em 4 bytes little-endian ANTES da avaliação
                        -> ainda símbolos de 8 bits, nenhuma lane descartada.
AMOSTRA FÍSICA DA NOISE SOURCE = INCONCLUSIVA (lado FPGA não inspecionado —
                        FPGA_INSPECTION.md). NÃO confundir com o símbolo acima.
AVALIAÇÃO POR BYTE-LANE (transporte uint32) = lane k = bytes k,k+4,... cada lane
                        avaliada como símbolos de 8 bits. As 4 lanes de cap3
                        PASSARAM na Trilha IID; não-IID entre 6.915 e 7.006
                        bits/símbolo de 8 bits. Detalhe: itens 6 e 11.
STREAM INTERCALADO = a avaliação do arquivo inteiro (itens 5-7) é do stream
                     intercalado das 4 lanes; serve como ANÁLISE ADICIONAL, não
                     substitui as lanes. Nele a Trilha IID FALHA (cap1/cap2) ou
                     fica INCONCLUSIVA (cap3, timeout) — hipótese compatível com
                     diferenças entre as lanes (não é prova de não-IID da fonte).
```

## 9. Estado dos restart tests

```
RESTART TESTS: NÃO EXECUTADOS
```

Dependem de reinicializações REAIS da noise source, que dependem de: (a) definir
o evento que constitui um restart real da fonte (INCONCLUSIVO — lado FPGA),
(b) uma janela controlada. Ver `RESTART_CAMPAIGN.md` e `PHYSICAL_WINDOW_PLAN.md`.
Harness pronto (`physical-layer/restart-campaign/`, só fixture).

## 10. Matriz de integridade por fronteira

```
REGIÃO 1 — server_api.py -> API pública -> formatos -> frontend : COMPROVADA
REGIÃO 2 — FPGA/FIFO -> fifo.c -> TCP -> connector -> server_api.py : NÃO COMPROVADA
```

| fronteira | evidência | resultado |
|---|---|---|
| `server_api.py` (`/random`, octet-stream) → `qrng-client-api` | contrato de Content-Type explícito, `interpretUpstreamResponse` passthrough estrito | preserva bytes (verbatim) |
| `qrng-client-api` `/v1/random?format=raw` | `serialization.test.js`: payload conhecido (`capture_id=sha256`) → corpo == payload, `Content-Length` exato, sem BOM | **SHA-256 idêntico** |
| `format=hex` | decodifica no teste → mesmo SHA-256; hex ≠ bytes-ASCII-do-hex | **idêntico** |
| `format=base64` | decodifica 1×; não é base64 duplo | **idêntico** |
| `format=uint8` | array de N inteiros [0,255] → Buffer | **idêntico** |
| 4 caminhos entre si | raw == hex == base64 == uint8 | **mesmo SHA-256** |
| frontend `bytesToHex` / round-trip | `qrngHelper.test.js`: binário→Hex→binário e →uint8→binário | **SHA-256 preservado** |
| frontend `bytesToUint32Array` | `readUint32LE` + 14 vetores de regressão vs `DataView.getUint32(i,true)` | **LITTLE-ENDIAN** — corrigido nesta rodada (item 12) |
| FPGA→`fifo.c`→TCP→connector→`server_api.py` | não instrumentado (janela controlada pendente; nenhum 2º consumidor aberto) | **NÃO COMPROVADO** |

Casos de fronteira testados (região 1): 1, 3, 4, 7, 64, 256, 1000 bytes; não
múltiplo de 4; zeros; `0xff`; incremental; payload "que parece ASCII decimal".
Verificados: ASCII decimal concatenado (mantido como bytes), hex-como-bytes,
base64 duplo, BOM, newline final, truncamento, padding, troca de endianness,
signed/unsigned, Monte Carlo `uint32/2^32` ∈ [0,1) **nunca == 1**.

## 11. Tabela de hashes Raw/Hex/Base64/uint8 + primeiro offset divergente

Para todos os payloads L0 e de fronteira: **`sha256(raw) == sha256(fromHex) ==
sha256(fromBase64) == sha256(fromUint8)`**, `length` idêntico. **Primeiro offset
divergente: NENHUM** (`serialization.test.js` — a comparação `deepEqual` /
`sha256` passa em todos os vetores).

**Byte-lanes de `cap3`** (transporte `uint32`, lane k = bytes k,k+4,k+8,…,
extraídas de `run_new_03.bin` na VM, cada uma 2 621 440 bytes):

| lane | SHA-256 | Trilha IID | `h_min_non_iid` | trilha limitante | estimador limitante |
|---|---|---|---|---|---|
| lane 0 | `run_new_03.lane0.bin` (resultados em `/root/nist_L0/results/L0.cap3.lane0.*`) | **PASS** | 6.986780 | original | Lag Prediction |
| lane 1 | `…lane1.bin` / `L0.cap3.lane1.*` | **PASS** | 6.986771 | original | MultiMCW Prediction |
| lane 2 | `…lane2.bin` / `L0.cap3.lane2.*` | **PASS** | 6.915310 | bitstring | Compression |
| lane 3 | `…lane3.bin` / `L0.cap3.lane3.*` | **PASS** | 7.005597 | bitstring | Compression |
| intercalado (arquivo inteiro) | `5d30cfab…` (item 3) | **INCONCLUSIVO** (`ea_iid` timeout) | 7.121482 | bitstring | Compression |

As lanes **não alteram bytes** — são um recorte do mesmo binário; a extração é
`open(src,'rb'); buf[k::4]`. A soma dos 4 comprimentos de lane = 10 485 760 =
tamanho de `run_new_03.bin`.

## 12. Primeiro offset divergente (serialização) e endianness — ACHADO CORRIGIDO

- **Serialização raw/hex/base64/uint8:** nenhuma divergência — os bytes são
  preservados byte a byte em todos os formatos e no round-trip.
- **ACHADO (frontend) — era BIG-ENDIAN, agora CORRIGIDO nesta rodada:**
  `bytesToUint32Array` decodificava `(b0<<24)|(b1<<16)|(b2<<8)|b3` (big-endian),
  inconsistente com o transporte declarado `uint32-le` (`server_api.py`
  `struct.unpack("<I")`, `/v1/uint32`, `stream_format: "uint32-le"`). Os bytes
  nunca foram alterados (round-trip provado) — era uma inconsistência de
  interpretação, não de dados.
- **Correção aplicada (`f1` — commit desta rodada):** novo helper
  `readUint32LE(bytes, i)` = `(b0 | b1<<8 | b2<<16 | b3<<24) >>> 0`, equivalente
  a `DataView.getUint32(i, true)`. Passou a ser usado em **todos** os pontos que
  montavam uint32 no frontend:
  - `src/lib/qrngHelper.js`: `bytesToUint32Array`, `uniformIntFromBytes`,
    `uniformIntsFromBytes`, `fetchQrngRandIntViaToken`;
  - `src/components/data/DataSection.jsx`: `pickInt`, `genMonteCarlo`
    (faixa personalizada + prévia Monte Carlo);
  - `src/components/kapua/KapuaSection.jsx`: exibição de 1 uint32.
  `mtClone.js` (jogo preditor de MT19937) **não** foi tocado — extrai o byte
  alto do seu próprio estado MT, não decodifica o transporte.
- **Vetores de regressão adicionados** (`src/lib/qrngHelper.test.js`, +14
  testes; suíte 44 → 58): `describe("endianness uint32-le — vetores de
  regressão (R1)")` com 9 vetores `[bytes LE] → uint32` (incl. `01 00 00 00`→1,
  `00 00 00 01`→`0x01000000`, `78 56 34 12`→`0x12345678`, `ef be ad de`→
  `0xdeadbeef`), cada um checado contra `readUint32LE`, contra
  `bytesToUint32Array` e contra `DataView.getUint32(i, true)`; offset não-zero;
  stream multi-palavra `[1,256,65536,16777216]`; round-trip `pack('<I')` →
  `readUint32LE` para 11 valores de borda; `uniformIntFromBytes`/
  `uniformIntsFromBytes` também consomem `uint32-le`. Fixtures Monte Carlo
  ajustadas (`00 00 00 80` → 0.5).
- **Impacto:** muda o pixel-output das viz de π / otimizador `f(x)` / Monte
  Carlo (permanecem estatisticamente válidas — permutação fixa de bytes
  uniformes → palavra uniforme) e alinha o frontend a `/v1/uint32`. Frontend
  reconstruído: `vitest` 80/80, `eslint` limpo, `vite build` OK.

## 13. Teste equivalente ao notebook Jupyter

`requests.get(API, headers={"Authorization": Bearer TOKEN}, params={format, size})`
contra CANÁRIO isolado (`:13010`/`:13011`, imagem = HEAD, upstream = fixture que
**reproduz o `server_api.py` real: sem `X-QRNG-Captured-At`**),
`LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE=false`. Conta de teste isolada (token não
impresso).

| checagem | resultado |
|---|---|
| autenticação (JWT → token) | **OK** |
| `format=raw&size=4096` → `bytes=4096` | **HTTP 200**, `Content-Type: application/octet-stream`, `len == 4096` |
| `X-Request-Id` na resposta | **presente** |
| `X-QRNG-Provenance` (raw) | `unknown` — igual ao campo JSON `provenance` |
| `X-QRNG-Live-Verified` | `false` |
| `X-QRNG-Source-Health` | `healthy` |
| `X-QRNG-Captured-At` | **ausente** (correto) |
| hex / base64 / uint8 → binário | **mesmo SHA-256** (mesmo cursor) |
| `actual_origin` (todos os formatos) | **`unknown`** |
| 401 (sem token) | `MISSING_TOKEN` estruturado |
| 403 (token inválido) | `INVALID_TOKEN` estruturado |
| 429 (burst público, limite 5/min) | `[200×5, 429×5]` — **429 estruturado** |
| 503 (upstream offline) | `502 UPSTREAM_ERROR` estruturado, JSON |
| timeout do upstream | `503 QRNG_UNAVAILABLE` estruturado, JSON, sem HTML/stack |
| download raw + SHA-256 | 200, `len == N`, SHA-256 registrado |

## 14. Autenticação e persistência de tokens

Inventário read-only do container produtivo `qrng-client-api`:
- imagem `qrng-demo-react-qrng-api` (`sha256:10087183…`), `--network host`,
  `--restart unless-stopped`, sem portas publicadas;
- **persistência: volume nomeado `qrng-demo-react_qrng-tokens-db`** → `/data`,
  `DB_PATH=/data/qrng-tokens.db` (SQLite WAL — `.db` + `-shm` + `-wal`);
- variáveis por env-file `/root/deploy/qrng/qrng-client-api.env` (nomes apenas,
  valores não lidos).

**Canário de token (2026-08-28):** token de teste funciona **antes** → sobrevive
a `docker restart` → sobrevive a **rollback** (imagem produtiva anterior, mesmo
volume) → `/v1/auth/me` mantém o e-mail. `persistencia_preservada: true`,
`banco_vazio_nao_substituiu: true`.

## 15. Proveniência real das respostas

Contra o `server_api.py` REAL (replay de UMA resposta capturada, sem 2º
consumidor — `PROVENANCE_REAL_UPSTREAM.md`): o upstream **não emite**
`X-QRNG-Captured-At` / `-Capture-Id` / `-Source-Status`. Com o default
(`LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE=false`):

| estado upstream | HTTP | `actual_origin` | `live_verified` | `source_health` | `buffer_health` | `fallback_used` |
|---|---|---|---|---|---|---|
| online | 200 | **unknown** | false | healthy | healthy | false |
| degradado | 200 | **unknown** | false | degraded | healthy | false |
| buffer esgotado | 503 `INSUFFICIENT_ENTROPY` | **unknown** | false | healthy | **degraded** | false |
| offline | 502 `UPSTREAM_ERROR` | **unknown** | false | failed | unknown | false |
| timeout | 503 `QRNG_UNAVAILABLE` | **unknown** | false | healthy | unknown | false |
| `/health` (status) | 200 | **unknown** | false | healthy | unknown | false |

Regras confirmadas: não inventa `captured_at`; `served_at` ≠ `captured_at`;
sem evidência ⇒ `live_verified=false` e `actual_origin=unknown`; config `live`
não prova origem `live`; **JSON == headers** — a partir de `cdff682` os
`X-QRNG-Provenance` / `-Live-Verified` / `-Fallback-Used` são emitidos também
nas respostas JSON de `/v1/random` e `/v1/public/random` (antes só em `raw`),
idênticos aos campos do corpo.
**Origem live comprovada por resposta: NÃO** (nesta configuração / com este
upstream).

## 16. Resultado de cada visualização (item 8)

| visualização | endpoint | formato | origem dos dados |
|---|---|---|---|
| Raw (Dados) | `/qrng/api/random` | raw | **USA DADOS DA API** — corpo == N bytes, `X-QRNG-*` |
| Hex (Dados) | `/qrng/api/random` | hex | **USA DADOS DA API** |
| Base64 (Dados) | `/qrng/api/random` | base64 | **USA DADOS DA API** |
| Decimal/uint8 (Dados) | `/qrng/api/random` | uint8 | **USA DADOS DA API** |
| Monte Carlo (Dados) | `/qrng/api/random` | raw/hex | **USA DADOS DA API** — floats [0,1), nenhum ≥ 1 |
| Histograma (Análise) | `/qrng/api/random` (coluna QRNG) | — | **USA DADOS DA API**; a coluna PRNG é `generatePRNGSequence` (LCG) — **PRNG PARA COMPARAÇÃO IDENTIFICADA** |
| Scatter (Análise) | idem | — | idem |
| Visualização de bits (Análise) | idem | — | idem |
| π Monte Carlo (Aplicações) | `/qrng/api/random` | — | **USA DADOS DA API** (`bytesToUint32Array` agora LE — item 12) |
| Máx f(x) (Aplicações) | `/qrng/api/random` | — | **USA DADOS DA API** (uint32-le, item 12) |
| PRNG × QRNG (Aplicações/Análise) | `/qrng/api/random` p/ QRNG | — | QRNG = API; PRNG = LCG **identificado** |
| Sonificação (Interativas) | `/qrng/api/random` (`fetchQrngBytes`) | — | **USA DADOS DA API** — `byte → nota`; sem `Math.random` no mapeamento |
| Faixa personalizada (Dados) | `/qrng/api/random` + `uniformIntsFromBytes` | uint8 | **USA DADOS DA API** (rejection sampling, sem viés de módulo) |
| Distribuição exponencial | — | — | **NÃO IMPLEMENTADA NA UI** (só `exponentialFromUniform` em lib; teste unitário) |
| galaxySpiral / mandala (Interativas — arte) | `/qrng/api/random` | — | **corrigido** nesta rodada: `bytes[i] || rand` trocava byte 0 por `Math.random()`; agora `bytes.length ? bytes[i] : rand` |
| QuantumVisualizer fallback | — | — | `Math.random()` **explicitamente rotulado** "Math.random() — pré-coletado esgotado" — **FALLBACK EXPLÍCITO** |

`Math.random()` no frontend que **não** é dado: shimmer de loading
(sobrescrito), som de "tick" de 3 ms (`audioEngine`), partículas de fundo
(`KapuaSection`). Nenhuma alimenta uma visualização de dados.

## 17. Classificação de origem por visualização (item 8.2)

- **USA DADOS DA API:** Raw, Hex, Base64, uint8, Monte Carlo, Histograma (QRNG),
  Scatter (QRNG), Bits (QRNG), π, Máx f(x), Sonificação, Faixa personalizada,
  galaxySpiral/mandala (após o fix).
- **USA PRNG PARA COMPARAÇÃO IDENTIFICADA:** coluna PRNG de Histograma/Scatter/
  Bits e o card PRNG × QRNG (`generatePRNGSequence` / LCG — rotulado).
- **USA FALLBACK EXPLÍCITO:** `QuantumVisualizer` quando o buffer pré-coletado
  esgota (rótulo "Math.random() — pré-coletado esgotado").
- **USA FIXTURE SOMENTE EM TESTE:** o `fixture-upstream` do compose de staging
  (não existe em produção).
- **USA FONTE LOCAL INDEVIDA:** *era* galaxySpiral/mandala (byte 0 → `Math.random`)
  — **corrigido** em `b8e93c1`. Nenhuma outra.
- **NÃO IMPLEMENTADA:** distribuição exponencial (UI).

**"QRNG live"** só pode ser afirmado para uma resposta com evidência
verificável de origem live — **nenhuma** resposta observada tem (item 15).
Em staging, `actual_origin = replay`.

## 18. Playwright — mocks vs staging real (item 9)

`PLAYWRIGHT_CATEGORIES.md`. Todos os `e2e/staging/*.spec.js` rodam contra o
**compose de staging** (web real + `qrng-client-api` real + `nist-staging` real
+ `fixture-upstream` replay). **Zero mocks na suíte de staging** — mocks só
nos testes unitários node:test do `qrng-client-api`. Upstream real
(`server_api.py`) só no script de VM `run-prov-real.sh`.

**Suíte Playwright de staging: 97 testes** — `api.spec` 27 + `downloads` 6 +
`features` 10 + `nist` 34 + `provenance` 9 + `ratelimit` 2 + `ui` 10 +
`viz-provenance` 4 (`--list`). **CI #54 (`1b54c24`): `97 passed`.**

**Histórico de CI desta rodada (verificado na API do GitHub Actions):**
- #46/#47 — falha só no Playwright por asserção frágil na 1ª `viz-provenance`
  (`request_id || content_length`); reescrita em `94c1c36`.
- #48–#53 (`94c1c36`…`5fd9b9d`) — **ainda falha só no Playwright**: 1 teste,
  `viz-provenance.spec.js "Aplicações (π)"`, timeout de 30 s. A execução ad-hoc
  na VM ("97 passed") **não reproduzia o CI** (não rodava a suíte inteira em
  ordem, então não sofria o rate-limit acumulado).
- **Causa-raiz** (item 2): π como último spec pegava **HTTP 429** porque
  `ratelimit.spec.js` já tinha esgotado o rate-limit público do IP.
- **Correção (`1b54c24`):** rota só-staging `/v1/_test/reset-rate-limit` +
  `beforeEach`/`afterAll` nos specs → hermético. **CI #54: 5/5 jobs verdes,
  `97 passed`** (52,8 s) — reproduzido na VM com o fluxo idêntico ao CI.
- Testes unitários (CI #54, verde): `qrng-client-api` **145** node:test,
  `qrng-nist-api` **44** python, frontend `qrngHelper.test.js` **58** vitest
  (44 + 14 vetores de endianness `readUint32LE`) + `AppContext` 22.
  **Sem falhas.**

## 19. Plano corrigido de deploy

`DEPLOY_ARTIFACTS.md` (reescrito): **`docker rename` NÃO é mecanismo de troca**
(não para o processo nem libera `:3010`). Procedimento de 15 passos: inspeção
→ backup SQLite via `.backup` (não `cp` do `-wal` aberto) → canário em porta
alternativa com CÓPIA do db → 7 classes de teste no canário ANTES da troca
(health / autenticado / proveniência / formatos / proxy nginx / dois IPs +
spoof XFF / erros estruturados) → `docker stop` (parada controlada) → subir a
**imagem imutável** no volume de produção → verificação pós-troca → rollback.
Imagens: `qrng-client-api:<sha>` (Id `sha256:0e9aaadf…`), `qrng-web:<sha>`
(Id `sha256:3cea813b…`). `LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE=1` no deploy.

## 20. Plano de rollback

Reverter para a imagem produtiva ANTERIOR por Id:
`sha256:10087183b583211d4aa73c2d531df170c06e7e86bc869bec347e57b9be7fbd55`
(client-api) e `sha256:6a87c46734eba1f448e28506a92da96fdc7b7dbdae8154e5cae312d6922e1722`
(web), no **mesmo volume `qrng-demo-react_qrng-tokens-db`**. Passo 15:
validar tokens (health, `/v1/random` com token pré-existente, `/v1/auth/me`,
contagem de linhas `users`/`api_tokens` == backup pré-deploy). Canário
demonstrou: token sobrevive a restart e a rollback; banco vazio não substitui.

## 21. Riscos e bloqueios

| # | risco / bloqueio | severidade |
|---|---|---|
| R1 | **`bytesToUint32Array` big-endian vs transporte `uint32-le`** — **CORRIGIDO nesta rodada** (`readUint32LE` em qrngHelper.js + DataSection.jsx + KapuaSection.jsx; 14 vetores de regressão; 80/80 vitest, lint, build OK). Bytes nunca foram alterados. Pendência residual: rebuild do frontend precisa ir no deploy para a UI passar a exibir os mesmos `uint32` de `/v1/uint32`. | resolvido — resta o deploy do frontend reconstruído |
| R2 | Região **FPGA/FIFO → server_api.py NÃO COMPROVADA** — inspeção read-only da FPGA bloqueada pelo classificador (2 rodadas). Handoff ao operador em `FPGA_INSPECTION.md` (script `fpga_readonly_inspect.sh`, sha256 `cc7a8008…`). | bloqueio — impede itens 6/13 físicos |
| R3 | **Restart tests e health tests não concluídos** → `SP 800-90B completo = NÃO`. A campanha completa (`NIST_FULLSET_COMPARE.md`) são ~18 h — aguarda autorização. | bloqueio para "conforme SP 800-90B" |
| R4 | `LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE=1` no deploy → `actual_origin="live"` com `live_verified=false` (sem prova de captura fresca). O honesto seria o `server_api.py` carimbar `captured_at` (mexe no caminho FPGA). | baixa — documentado; alternativa é `unknown` |
| R5 | 18 dependabot alerts no default branch (fora de escopo — `VULNERABILITY_MATRIX.md`). | baixa |
| R6 | Volume órfão `qrng_qrng-tokens-db` (projeto antigo) — não montado; limpar antes do deploy. | trivial |

**Fora de escopo desta rodada (não alterado):** exposição/rotação de
credenciais, merge, deploy, troca do NIST produtivo, FPGA/FIFO, leitura MMIO,
RCT/APT no caminho live, thresholds, restart campaign completa, chaves/seeds/
nonces/tokens criptográficos, condicionamento, alegação de conformidade SP
800-90B integral.

## 22. Respostas diretas às 4 perguntas

1. **Os dados passam na Trilha IID?** **Depende do recorte.** No **stream
   intercalado** (arquivo `uint32` inteiro): **NÃO** — a permutação falha em
   cap1 e cap2 (1 MiB); em cap3 (10 MiB) o teste **não concluiu** (timeout,
   `exit=124`) → INCONCLUSIVO. **Por byte-lane** (transporte é `uint32`, a
   avaliação primária): as **4 lanes de cap3 PASSARAM** na Trilha IID — a falha
   do stream intercalado é uma **hipótese compatível com diferenças entre as
   lanes**, não uma prova de não-IID da fonte. Em qualquer recorte, o crédito
   vem da **Trilha
   não-IID**: menor estimativa válida `6,878090` bits/símbolo de 8 bits (cap2,
   intercalado); por lane, mínimo `6,915310`; estimador limitante =
   **Compression** (trilha bitstring), exceto lanes 0/1 (trilha original,
   estimadores de predição). **Restart tests: NÃO EXECUTADOS. SP 800-90B
   completo: NÃO.**
2. **Erro de serialização / conversão / framing / endianness / truncamento?**
   Os **bytes são preservados** integralmente na região `server_api.py → API →
   formatos → frontend` (raw = hex = base64 = uint8, mesmo SHA-256, round-trip
   provado). **Havia um ACHADO de endianness** — o frontend `bytesToUint32Array`
   decodificava big-endian, inconsistente com o transporte `uint32-le` (nunca
   alterou os bytes nem invalidou o Monte Carlo) — **corrigido nesta rodada**
   (`readUint32LE` em todos os pontos do frontend + 14 vetores de regressão;
   80/80 vitest, lint, build OK). Resta apenas o rebuild do frontend ir no
   deploy. A região FPGA/FIFO → `server_api.py` permanece **NÃO COMPROVADA**.
3. **A API entrega ao notebook Jupyter os mesmos bytes da origem declarada?**
   A API é **funcional e autenticada**; os **bytes são preservados** entre
   raw/hex/base64/uint8 (mesmo SHA-256). Mas a **origem live NÃO está
   comprovada por resposta** (`actual_origin = unknown`, `live_verified = false`)
   — o `server_api.py` real não fornece evidência de captura.
4. **As visualizações usam esses dados, sem substituição por PRNG/fixture/
   fallback não identificado?** **SIM** para todas as visualizações de dados
   centrais (usam a API). PRNG aparece **apenas** como comparação identificada;
   fallback do `QuantumVisualizer` é **rotulado**; fixture só em staging. **Uma
   substituição silenciosa foi encontrada e corrigida** nesta rodada
   (galaxySpiral/mandala trocavam o byte 0 por `Math.random()`).

| Pergunta | Resposta | Evidência | Limitação |
|---|---|---|---|
| Dados passam na trilha IID? | **Stream intercalado: NÃO** (cap1/cap2 FAIL; cap3 INCONCLUSIVO/timeout). **Byte-lanes: SIM** (4/4 de cap3) | L0: permutação falha em cap1/cap2; `ea_iid` das 4 lanes de cap3 passa chi-square + LRS + permutação | 2 capturas de 1 MiB + cap3 10 MiB; falha do intercalado = hipótese compatível com diferenças entre lanes |
| Qual a estimativa não-IID? | **mín. `6,878090` bits / símbolo de 8 bits** (cap2 intercalado; por lane, mín. `6,915310`); limitante **Compression** (trilha bitstring) | `ea_non_iid` @ `87c104d0`; baseline `6.951334` reproduzido em cap1 | símbolo = byte, **não** amostra física da noise source |
| Existe alteração por serialização? | **Bytes: NÃO.** Endianness do `uint32` no frontend: **era BE, corrigido para LE** nesta rodada | `serialization.test.js` + `qrngHelper.test.js` (58, incl. 14 vetores de regressão de endianness) | R1 resolvido; falta o deploy do frontend reconstruído |
| A API funciona com token em Jupyter? | **SIM** | canário: register→token→`GET /v1/random` 200; 401/403/429/503 estruturados | teste contra canário, não produção |
| Os bytes recebidos são preservados? | **SIM** | raw==hex==base64==uint8, mesmo SHA-256; round-trip | região FPGA→server_api.py não coberta |
| A origem live está comprovada? | **NÃO** | `server_api.py` real sem `X-QRNG-Captured-At` → `actual_origin=unknown`, `live_verified=false` | precisa de carimbo de captura no upstream |
| As visualizações usam os bytes da API? | **SIM** | `viz-provenance.spec.js` (instrumenta fetch); auditoria estática de `Math.random` | galaxy/mandala tinham troca silenciosa — **corrigida** |
| A fonte está aprovada para criptografia? | **NÃO** | Restart/health/arquitetura pendentes | — |

---

## Veredito

```
OPERACIONAL, MAS AINDA EM VALIDAÇÃO DA FONTE
```

Não há "passou no NIST", "validado", "conforme", "sem viés", "seguro", "live"
nem "qualidade comprovada" sem a delimitação de evidência acima.

## Pare — aguardar autorização antes de

executar a campanha NIST completa (`NIST_FULLSET_COMPARE.md`); merge; deploy;
alterar o caminho live; acessar registradores com possíveis efeitos colaterais;
ativar health tests; trocar o serviço NIST produtivo.
