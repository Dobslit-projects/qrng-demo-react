# Kapuã QRNG — Relatório técnico consolidado

**Branch:** `stabilize/physical-layer-baseline-20260826`
**HEAD:** `542dad4`+ (esta rodada) · **main / produção:** `f058f22` (sem merge, sem deploy)
**Data:** 2026-08-27
**Veredito:** `OPERACIONAL, MAS AINDA EM VALIDAÇÃO DA FONTE`

> **O escopo autorizado foi executado. Os itens relacionados à unidade física,
> localização do viés, restart campaign e RCT/APT operacional permanecem
> INCONCLUSIVOS ou BLOQUEADOS por falta de acesso controlado à FPGA.**
>
> O pipeline serve bytes de forma estável e observável; a unidade física da
> amostra e a taxa física da fonte permanecem INCONCLUSIVAS. Nenhuma alegação
> de conformidade NIST, de "validado", "seguro", "uniforme" ou "sem viés" é
> feita.

---

## 0. Atualização — rodada de 2026-08-28

Escopo autorizado desta rodada executado sobre o HEAD `542dad4`:

| item | entrega | commit(s) | estado |
|---|---|---|---|
| 1 — CI do HEAD | run #36 (`542dad4`) registrado: completed/**success**, 5 jobs, todos os passos success | `6248f0a` | ✅ (§2, `CI_VERIFICATION.md`) |
| 2 — correções do relatório | "escopo autorizado executado; unidade física / viés / restart / RCT-APT permanecem INCONCLUSIVOS/BLOQUEADOS"; NIST diff → "não identificou mudança intencional nos estimadores; equivalência pendente de comparação com a suíte real"; THROUGHPUT → "vazão observada na fronteira de software; sem relação comprovada com a taxa física" | `6248f0a` | ✅ |
| 3 — proveniência por resposta | `qrng-client-api/lib/provenance.js` (função pura) + `provenance_detail{configured_source, instance_mode, actual_origin, source_health, buffer_health, captured_at, served_at, sample_age_ms, capture_id, fallback_used, live_verified}` em `/v1/random`, `/v1/public/random`, `/v1/health` e nos 502/503; headers `X-QRNG-*` no raw; `QRNG_PROVENANCE` vira teto da instância (nunca eleva); `fallback_used` prevalece; replay/fixture/historical nunca `live`; amostra velha/insuficiente derruba `live`; OpenAPI `ProvenanceDetail`; fixture `/_ctl/mode`; frontend `HardwareStatusBar` mostra "origem efetiva". **12 testes unitários** (9 cenários exigidos + bônus) + `e2e/staging/provenance.spec.js` | `9350732` | ✅ |
| 4 — executor fake identificado | `assessment_engine`/`assessment_engine_version`/`synthetic_result`/`statistical_result_valid` em `/health`, `/nist/status`, job e histórico; sem `NIST_LIVE_CAPTURE_PATH` → **nenhum timer periódico**, `next_periodic=null`, `periodic_enabled=false`; UI: banner obrigatório "RESULTADO SINTÉTICO DE STAGING — NÃO É UM ASSESSMENT SP 800-90B", tag SINTÉTICO nos valores, "captura live indisponível". E2E em `nist.spec.js` + `ui.spec.js` | `9350732` | ✅ |
| 5 — cobertura E2E | `e2e/staging/features.spec.js` (**4/4** na VM): Monte Carlo π (π̂ plausível, `π̂=4·inside/total`, `Erro%=|π̂-π|/π·100`, sem NaN), máximo de f(x)=sin(x)+cos(2x) (≤ ~1,7602), Análise PRNG×QRNG (64 bits/coluna, scatter+histograma, sem NaN), Sonificação (AudioContext suspenso tratado sem lançar). Exponencial: **+4 testes de lib** (`src/lib/qrngHelper.test.js`, 30→34) — identidade `X=-μ·ln(1-U)` μ=5, todo U∈[0,1), log(0) impossível, caudas, média μ±10% | `ffa41c9`, `41b2b18` | ✅ |
| 6 — endurecimento de upload NIST | arquivo gravado com **nome gerado pelo servidor** (`sample<ext>`); nome do cliente nunca vira caminho (`_safe_name` endurecido: `../`, separadores Windows, absoluto, controle/NUL, comprimento); `.txt` E `.csv` **normalizados de verdade** (negativo, >uint32, delimitador, colunas inconsistentes, "texto com dígitos" → `first_parse_error` ou falha explícita); persistidos após o worker: `sha256_normalized`, `size_original/normalized_bytes`, `normalized_symbol_count`, `first_parse_error`, `endianness_rule`, `stored_filename`. **nist unit 23→37**; `nist.spec.js` +12 | `9350732` | ✅ |
| 7 — NIST staging com a suíte REAL | `staging/nist-staging-real/` — imagem que compila `usnistgov/SP800-90B_EntropyAssessment` @ `87c104d0` (g++ `-std=c++11 -fopenmp -O2 -ffloat-store`, **sem** `-march=native`), roda a versão controlada em `:18093`, `assessment_engine=sp800-90b-reference`, `synthetic_result=false`, DB/data isolados, wrapper `qrng_nist90b.sh` byte-idêntico ao de produção (sha256 `aaec3c3e…`). `compare.py` roda o MESMO arquivo (cópia read-only de `run_new_01.bin`, 1 MiB) no produtivo `:18002` e no staging-real e faz o diff de ~28 campos. **Ver §7-bis.** | `7c44e23`, `b3024d1`, `41b2b18` | 🟡 comparação executada — ver §7-bis |
| 8 — inspeção read-only da FPGA | **NÃO executada**: o classificador de segurança do ambiente bloqueia o SSH por senha encadeado para `10.0.10.2` mesmo para comandos read-only. `physical-layer/FPGA_INSPECTION.md`: roteiro read-only completo para o operador + proposta EXATA de instrumentação (ponto/método/duração/risco/rollback/consumidor único/prova do mesmo bloco) | `b3024d1` | ⛔ bloqueado por tooling |
| 9 — plano da janela física | `physical-layer/PHYSICAL_WINDOW_PLAN.md`: ações A–F (tap install/remove, captura por fronteira, reset de processo, reset de FIFO, reset de FPGA, piloto de 3–5 power-cycles) — cada uma com impacto/duração/dados descartados/critério de sucesso/critério de aborto/recuperação/rollback/responsável; ordem com portões e pontos de parada | `b3024d1` | ✅ (documento) |

Regressões de staging corrigidas nesta rodada: `qrng-client-api/Dockerfile`
não copiava `lib/` → container caía no boot (13 falhas de E2E); `nginx`
do NIST staging não espelhava o caminho de produção (`/qrng/nist/nist/...`).
Ambas corrigidas em `326f38a`; backend permaneceu verde (client-api 127/127,
nist 37/37). Validação completa na VM após as correções: **Playwright 85/85**.

## 1. Commits e branches

Rodada anterior: 28 commits em `f058f22..89a63fd`. Rodada de 2026-08-28:
`6248f0a` (itens 1-2), `9350732` (itens 3-4-6), `326f38a` (fix staging),
`7c44e23`+`b3024d1`+`41b2b18` (item 7 + itens 8-9 docs), `ffa41c9`+`41b2b18`
(item 5). HEAD atual **`41b2b18`**. `local = VM (/root/projects) =
origin (github Dobslit-projects/qrng-demo-react)`. **Nenhum commit em `main`**
(`main` = `f058f22`).

## 2. GitHub Actions real

Repo público → API do Actions consultável sem token.

- **HEAD final da fase anterior — run #36 (`542dad4`)**: completed / **success**,
  5 jobs, todos os passos success (`CI_VERIFICATION.md` §"HEAD FINAL DA FASE"):
  Frontend (build+testes), qrng-client-api (testes + OpenAPI drift),
  qrng-nist-api (testes Python), physical-layer (RCT/APT + os 2 harnesses
  11/11 + 8/8), E2E Playwright (staging determinístico, bloqueante).
- **Rodada de 2026-08-28**: runs #37 (`7c44e23`) e #38 (`b3024d1`) =
  **success**. O HEAD `41b2b18` dispara o run #39 (registrar o resultado final
  ao fechar).
- Runs #32/#33 haviam reprovado só no passo **Lint** (`no-unused-vars` em
  `ratelimit.spec.js`), corrigido em `ffc763c`.

CI real **verificado** (não substituído por execução local).

## 3. Arquitetura do staging

`staging/docker-compose.staging.yml` (projeto `kapua-staging`, rede bridge
privada). 4 serviços:

| serviço | imagem | papel | porta |
|---|---|---|---|
| `fixture-upstream` | `kapua-staging-fixture-upstream:local` | imita `server_api.py`; **replay determinístico** (PRNG seed `20260827`, pool 8 MiB); `POST /_ctl/{offline,online,reset}` | interna `:18091` |
| `qrng-client-api` | `kapua-staging-client-api:local` | código real; `QRNG_PROVENANCE=replay`, `QRNG_SOURCE_LABEL=staging-fixture-replay`, `TRUST_PROXY="2"` | interna `:3010` |
| `nist-staging` | `kapua-staging-nist:local` | versão controlada de `nist_service.py`, assessment **FAKE** determinístico, DB/data isolados | interna `:18092` |
| `web` | `kapua-staging-web:local` | build de produção do frontend + nginx espelhando os caminhos de produção | `127.0.0.1:18080:80` |

Identificável por versão: `staging/up.sh` imprime um MANIFESTO (commit, IDs de
imagem/sha256, data de build, portas, endpoints, persistência, rollback).
**Não consome a conexão exclusiva da fonte de produção** — o upstream é
fixture/replay. Toda resposta declara `provenance` ∈
`{live, replay, fixture, historical, fallback, unknown}`; no staging o valor é
**`replay`**, nunca `live` (header `X-QRNG-Provenance` + campo JSON).
Persistência: volumes nomeados dedicados (`kapua-staging-client-api-data`,
`kapua-staging-nist-data`, `kapua-staging-nist-samples`) — nenhum é o banco/dir
de produção. Rollback: `staging/down.sh -v` (efêmero; nada em produção é
tocado).

## 4. Resultados do Playwright

`e2e/staging/` (`playwright.config.js` → `testDir` alterna com
`E2E_STAGING_ONLY=1`; chromium; `workers:1`). **62 testes, 62 passando**
(20,4 s) end-to-end contra o compose na VM através do nginx real; e como job
**bloqueante** `e2e-staging` no CI. Cobrem: acesso anônimo e autenticado;
Raw/Hex/Base64/uint8 com N→N para {1,16,100,1000,65536}; proveniência nunca
`live`; Monte Carlo (nenhum valor ≥ 1); faixa customizada; Swagger e ReDoc
**renderizando em navegador real** (não só HTTP 200); OpenAPI 3.x com
`provenance` obrigatório e sem `/admin`; health; erros
400/401/403/404/413/422/503; rate limit (429 estruturado); geração de chave
desabilitada na UI; e os ~20 cenários do serviço NIST de staging (item 5).

## 5. Downloads e hashes

`e2e/staging/downloads.spec.js` lê cada arquivo baixado no teste e valida:
- **Raw `.bin`**: `Content-Type: application/octet-stream`, **sem BOM**,
  `Content-Length` confere, `length % 4 == 0`, decodifica como uint32-LE com
  valores não nulos, SHA-256 de 64 hex.
- **Hex `.txt`**: só `[0-9a-f]` + separadores; decodifica para binário.
- **uint8**: N inteiros em [0,255].
- **Monte Carlo**: floats em [0,1), **nenhum ≥ 1**, ≥ 6 casas decimais.
- **Equivalência**: Hex ↔ Base64 ↔ uint8 → **mesmo binário** e mesmo SHA-256
  (com `POST /_ctl/reset` no fixture entre as chamadas para o replay repetir).

Upload NIST: SHA-256 do arquivo original devolvido na resposta e conferido no
teste (`sha256_original` == `sha256(buffer)`).

## 6. Rate limit com dois IPs reais

`physical-layer/RATE_LIMIT_MULTI_IP.md`. Dois IPs de origem **genuinamente
distintos**: A = `200.129.133.131` (rede local), B = `150.161.9.178` (egress
dobslit) — **não** simulação por `X-Forwarded-For`. Confirmado: A em burst →
exatamente 60× `200` e então `429` (corpo estruturado `RATE_LIMIT_EXCEEDED` com
`request_id`, `Retry-After`); enquanto A está em `429`, B recebeu `200`
(balde independente); A seguiu `429` até a janela de 60 s reabrir; headers
`RateLimit-*`; ambos os IPs registrados em `api_usage_logs`. **Ressalva de
topologia**: no staging bridge, o `docker-proxy` faz NAT do IP de origem, então
a tentativa de *spoof* de `X-Forwarded-For` só é totalmente barrada com
`trust proxy` por contagem de saltos (`TRUST_PROXY="2"`); a resistência a spoof
**em produção** (nginx em loopback no mesmo host, `trust proxy: loopback`) já
foi demonstrada na Seção 1 (`SECTION1_POSTDEPLOY_EVIDENCE.md`). Quotas
in-memory (`express-rate-limit` MemoryStore) **reiniciam junto com o processo**
— limitação aceita e documentada.

## 7. Baseline do serviço NIST

`physical-layer/qrng-api/nist_service.py.RUNNING_BASELINE` — cópia byte a byte
do processo vivo. SHA-256 `e396675f1b2d9ae7eef6031f40c3c78aa6b6c6224664a62c7701c1e6e4015f2e`,
21 090 B, mtime **2026-06-29 22:37**, `/home/dobslit/qrng-nist-api/nist_service.py`,
`127.0.0.1:8002`→`:18002`, systemd `qrng-nist-api.service` (`Restart=always`),
venv compartilhado `/home/dobslit/qrng-api/venv` (python 3.14.4), SQLite
`nist.db`, **sem string de versão**. Commit `e558ed4` "baseline do componente
realmente executado". Metadados completos em `NIST_SERVICE_BASELINE.md`.

## 8. Diff do serviço NIST (baseline × versão corrigida)

`nist_service.py.diff-baseline-vs-65fb43b.txt`. 8 diferenças funcionais
classificadas A–H: **A** gate `NIST_LIVE_CAPTURE_PATH` (correção de
proveniência), **B** 8 colunas de metadados (aditivo), **C** `EXCLUDED_PATTERNS`
+`audit`/`characterization_` (correção), **D** persistência de
`assessment_symbol_width`/`normalization_method` (aditivo), **E** `sample_origin`
obrigatório em `_create_and_enqueue` (mudança de contrato), **F** campo em
`/nist/status` (aditivo), **G** `attested_transport_format` no upload +400
(aditivo+validação), **H** fallback "unknown" em `_row()` (aditivo). **O diff
não identificou mudança intencional nos estimadores. A equivalência dos
resultados permanece pendente de comparação paralela com a suíte real.**
Ambas as versões têm os mesmos 7 endpoints; nenhuma é versionada. Nenhuma
migração de schema é destrutiva. Ver §7-bis (comparação com a suíte real).

## 9. Serviço NIST de staging

`physical-layer/NIST_STAGING.md` + `staging/nist-staging/`. Versão controlada
rodando **isolada** em `:18092`, DB/data/upload em volumes dedicados, fila
própria, assessment **FAKE determinístico** (`qrng_nist90b_fake.sh` — a suíte
SP 800-90B real **não** está na imagem; o staging exercita
fila/persistência/histórico/lifecycle, não a matemática de entropia).
`/health` e `/nist/status` expõem `version` + `commit` (`GITHUB_SHA` no CI) +
`build_date` + `environment: "staging"`; header `X-NIST-Service-Version` em toda
resposta. **Não compartilha** o banco/porta/dir de produção. Validado
end-to-end na VM: health, upload, job completando via fake, 413/400/404,
worker-failure. **Parada respeitada**: o serviço produtivo NÃO foi substituído.

## 10. Política de upload NIST

Reescrita de `/nist/upload` (só na versão controlada):
- **streaming** para `.part` temporário em blocos de 1 MiB
  (`_stream_upload_to_file`); **o corpo nunca é lido inteiro em memória**;
  para assim que passa do limite.
- limite explícito **128 MiB** (`NIST_UPLOAD_MAX_BYTES`, default do código;
  o staging reduz para 1 MiB só para o teste "acima do limite" rodar rápido);
  **413 estruturado** `{error:"UPLOAD_TOO_LARGE", limit_bytes,
  received_at_least_bytes, request_id}`.
- extensões `.bin/.txt/.csv` (`400 UNSUPPORTED_EXTENSION` com `allowed[]`);
  validação de conteúdo barata (`400 INVALID_CONTENT`); `400 EMPTY_FILE`.
- limpeza segura do temporário em **todo** caminho de erro (`_safe_unlink`,
  nunca levanta).
- resposta traz `request_id`, `sha256_original`, `size_original_bytes`,
  `size_normalized_bytes`, `assessment_unit="byte"`,
  `assessment_symbol_width_bits=8`, `sample_endianness`, `sample_conditioned`,
  `normalization_method`, `provenance="user_upload"`, `attested`.
- normalização documentada: `.bin → raw-passthrough`; `.txt/.csv →
  byte-decomposition-le-uint32`; em todos os casos o NIST avalia **símbolos de
  8 bits (bytes)**, nenhuma lane descartada (confirmado lendo `qrng_nist90b.sh`).
- 20 cenários em `e2e/staging/nist.spec.js` (bloqueante); 3 marcados
  `test.fixme` (upload interrompido / timeout real / restart de processo) por
  limitação de infra, **não simulados como aprovados**.

## 11. Definição da noise source

`physical-layer/NOISE_SOURCE_UNIT.md`. Bloco formal:

```
NOISE SOURCE SAMPLE   = INCONCLUSIVO — EVIDÊNCIA NECESSÁRIA: RTL/bitstream, datasheet do ADC, código do servidor :12345
TRANSPORT WORD        = uint32 little-endian, 4 bytes (CONFIRMADO no software)
ASSESSMENT SYMBOL     = INCONCLUSIVO enquanto NOISE SOURCE SAMPLE for desconhecido
HEALTH TEST SYMBOL    = INCONCLUSIVO (mesma dependência)
PHYSICAL SAMPLE RATE  = INCONCLUSIVO — EVIDÊNCIA NECESSÁRIA: taxa de amostragem do ADC
TRANSPORT THROUGHPUT  = vazão observada na fronteira de software (~680.626 B/s ≈ 170.157 tw/s, 2026-08-27) — SEM relação comprovada com a taxa física
CONDITIONING          = Nenhum no software; FPGA-side INCONCLUSIVO
REAL NOISE-SOURCE RESTART = INCONCLUSIVO (hipótese: power-cycle / recarga de bitstream)
```

`qrng-connector.py` (SHA-256 `4ed0b591…`) e `server_api.py` (`892a4cb4…`) são
**passthrough verbatim** do bloco (`/v1/raw`); `RingBuffer` de 256 MiB
**descarta os bytes mais antigos** em overflow (descontinuidade digital
possível antes do consumidor). Acesso à FPGA (`10.0.10.2`) bloqueado nesta
sessão.

## 12. Unidade física da amostra

**INCONCLUSIVO — EVIDÊNCIA NECESSÁRIA.** O que é conhecido: o transporte move
`uint32` little-endian de 4 bytes (`struct.unpack("<{n}I")` em `server_api.py`;
`htole32` por leitura em `fifo.c` conforme o pacote técnico anterior). O que
**não** é conhecido: se o `uint32` é uma amostra física única, um agrupamento
de amostras menores, ou fatias de palavra; se os 4 bytes são lanes físicas
paralelas, recortes de uma palavra, ou amostras sucessivas; se há
contador/padding/cabeçalho/campo determinístico; se há
condicionamento/XOR/mistura no lado FPGA. **A unidade byte/lane usada nas
capturas anteriores NÃO é adotada como decisão definitiva** só por ter sido a
unidade usada antes.

## 13. Taxa física × throughput de transporte

- **TRANSPORT THROUGHPUT** = **vazão observada na fronteira de software**
  (~680.626 B/s ≈ 170.157 transport words/s, medido 2026-08-27 na saída do
  `server_api.py`). **Não existe relação comprovada entre essa vazão e a taxa
  física de amostragem até que o empacotamento da FPGA seja conhecido.**
- **PHYSICAL SAMPLE RATE** = INCONCLUSIVO. Pode haver
  buffering/decimação/replicação/agrupamento no caminho FPGA→socket não
  observável sem acesso à FPGA; a vazão de software não é medida da fonte nem
  necessariamente um teto dela (se houver replicação/expansão a jusante da
  digitização, a vazão de software pode até exceder a taxa física).

## 14. Pontos de captura (instrumentação)

`physical-layer/instrumentation/` (`harness.py` + `test_harness.py`, **11/11**;
`INSTRUMENTATION.md`). 7 fronteiras definidas:
`register_fifo_out → fifo_c_out → tcp_socket → connector_in → connector_out →
server_api_in → ring_buffer`. Cada uma capturada por seu **próprio
`SingleReadTap`** (leitura única — `feed()` 2× levanta; `forward()` inalterado;
`evidence()` cópia byte-idêntica; `read_timeout_s` não bloqueia o produtor).
`BoundaryRecord` grava: `capture_id`, sequência, offsets, `n_bytes`, SHA-256,
timestamps monotônico+civil, hexdumps head/mid/tail, primeiro offset divergente,
bytes esperado/observado. **Consumidor único preservado** — o harness não abre
um segundo consumidor. **Validado só com fixture/replay.** As fronteiras
`register_fifo_out`, `fifo_c_out`, `tcp_socket` exigem acesso à FPGA.

## 15. Hashes por fronteira

Ainda **não coletados em hardware real** — depende de uma **janela controlada**
(condição de parada: "antes de qualquer instrumentação na FPGA/FIFO ou conexão
produtiva, pare e solicite uma janela controlada"). Em replay: replay idêntico
→ 7 fronteiras, **1 único SHA-256**, `preserved: True`; replay com drop de 4
bytes no ring buffer → `preserved: False`, primeira divergência localizada em
`ring_buffer` @ offset 0 com bytes esperado/observado. O mecanismo de
localização está pronto; falta a captura física.

## 16. Localização do viés

**BLOQUEADO** pela mesma janela controlada do item 14/15. Quando houver uma
captura válida do mesmo bloco, o plano (item 8 da diretriz) avalia em cada
fronteira: hash, média, distribuição, 4 lanes de byte, 32 posições de bit,
frequência de 0/1, qui-quadrado, runs, autocorrelação, correlação cruzada,
estacionariedade por janela, estimativas SP 800-90B. **Correlação linear
próxima de zero NÃO será usada como prova de independência.** Nenhum ajuste
será aplicado ao caminho de produção nesta rodada.

## 17. Resultados por lane / por bit

De capturas históricas (pacote técnico anterior, `docs/nist_lane*_*.txt`):
entropia ≈ 7,9996 bits em cada uma das 4 lanes de byte; nenhum dos 32 bits
constante. **Isto descreve capturas antigas de proveniência de exercício
manual, não a fonte ao vivo instrumentada.** Não é evidência de independência
entre lanes nem de ausência de viés estrutural — apenas de que cada lane, vista
isoladamente, tem alta entropia marginal.

## 18. Limitações da simulação

`physical-layer/RCT_APT_REVIEW.md` §12 + `qrng-api/false_alarm_analysis.py`
(cabeçalho provisório, seed `SEED = 20260827`). Correções de redação (commit
`f86c3d8`):
- o resultado de simulação para C1/C2 é reportado como **"consistente com o
  limite analítico nas configurações avaliadas"** — não "≤ bound CONFIRMED".
- **removidas** as alegações de "lanes independentes / aproximadamente
  independentes / independência confirmada" a partir da simulação C4.
- registrado: as lanes da simulação foram geradas conforme o modelo do script
  (4 streams i.i.d. uniformes de RNGs independentes **deste script**, não as
  lanes físicas); a sub-aditividade vale só para esse cenário sintético; a
  razão 0,79 × (4 × single) **não** demonstra independência das lanes físicas;
  o union bound continua um **teto conservador**; a dependência real entre
  lanes deve ser avaliada nas capturas da fonte.
- a análise de falso positivo é **explicitamente provisória** — não foi feita
  simulação inviável tentando observar diretamente eventos anuais raríssimos.

## 19. Estado do harness da restart campaign

`physical-layer/restart-campaign/` (`harness.py` + `test_harness.py`, **8/8**;
`RESTART_CAMPAIGN.md`).

```
RESTART CAMPAIGN: BLOQUEADA
MOTIVO: o evento que constitui "restart real da noise source" é INCONCLUSIVO
        (lado FPGA inacessível). Sem isso, cada linha não pode ser garantida
        como uma reinicialização física válida — e a instrução proíbe recortes
        de stream contínuo.
EVIDÊNCIA / JANELA NECESSÁRIA: inspeção da FPGA (RTL/bitstream/servidor :12345)
        OU janela de manutenção para testar power-cycle; E autorização para a
        campanha completa.
```

Taxonomia (testada): só `power_cycle` (e talvez `fpga_reset`) é candidato a
restart real da fonte; `process_restart`/`fifo_reset` reiniciam **só o
transporte**. Piloto seguro **com fixture** (3 linhas, todas
`simulated: true`, ≤ 10 linhas, não toca equipamento). **A campanha NÃO foi
simulada.** Estimativa para a janela: ~17–33 h de operação contínua com
automação de power-cycle; a fonte fica indisponível durante a janela;
interrupção = parar o laço (última linha parcial descartada); rollback = nada
em produção muda.

## 20. Riscos

1. **Unidade física indefinida** → RCT/APT, política de k-of-n e thresholds não
   podem ser fixados com base sólida (item 21).
2. **`RingBuffer` drop-oldest** → sob backpressure, o consumidor pode receber um
   bloco não contíguo sem sinalização; nenhuma métrica expõe isso hoje.
3. **Quotas de rate limit in-memory** → reinício de processo zera as janelas;
   um cliente pode recuperar quota reiniciando o serviço (mitigável só com
   store externo).
4. **`α = 2⁻²⁰` na taxa atualmente assumida** → **não é operacionalmente
   aceitável**: gera falso-alarme com frequência incompatível com operação
   contínua; registrado, não escolhido.
5. **NIST periódico inerte** → sem `NIST_LIVE_CAPTURE_PATH` (captura ao vivo
   controlada, não implementada), não há monitoramento periódico real da fonte.
6. **Dependency alerts do GitHub** (18: 9 high / 6 moderate / 3 low no default
   branch) — fora do escopo desta fase; `VULNERABILITY_MATRIX.md` cobre o que
   foi corrigido nos lockfiles.

## 21. Bloqueios

| item | bloqueado por | evidência / janela necessária |
|---|---|---|
| 6 — unidade física | acesso à FPGA (RTL/bitstream/datasheet/servidor :12345) | autorização + janela para inspecionar a Red Pitaya |
| 8 — viés por fronteira | janela controlada de instrumentação física (consumidor único) | janela combinada para montar/desmontar o tap a montante |
| 9 — restart campaign | definição do "restart real" (item 6) + autorização | idem item 6, + PDU/relé para automação de power-cycle |
| 10 — RCT/APT operacional | itens 6 e 13 | unidade + taxa física reais |
| substituir NIST produtivo | comparação paralela com a **suíte real** + migração de banco + janela | executar `NIST_MIGRATION_PLAN.md` passo 2 |

## 22. Plano de deploy (quando autorizado)

1. `git checkout main && git merge --ff-only stabilize/physical-layer-baseline-20260826`
   (a branch é linear sobre `f058f22`).
2. Frontend + API: rebuild e redeploy dos containers `qrng-client-api` e `web`
   (mesma imagem já exercitada no staging).
   - **`qrng-client-api` agora requer `lib/` ao lado de `server.js`**
     (`require("./lib/provenance")`). O container in-repo já faz `COPY lib`; o
     deploy real por systemd/rsync **deve incluir `qrng-client-api/lib/`** —
     sem isso o processo não sobe.
   - Produção fica `QRNG_PROVENANCE=live` explícito (agora = **modo/teto** da
     instância; `actual_origin` de cada resposta é resolvido em tempo real e
     só é `live` com evidência do caminho live).
   - Opcional: `QRNG_CONFIGURED_SOURCE=fpga`, `LIVE_SAMPLE_MAX_AGE_MS`.
   - Para `live_verified=true` e `sample_age_ms` reais, o `server_api.py` de
     produção precisaria emitir `X-QRNG-Captured-At` / `X-QRNG-Capture-Id`
     (não emite hoje → `captured_at=null`, `live_verified=false`, honesto).
3. NIST: **não** neste deploy — segue o plano próprio (item 21 + §7-bis).
4. RCT/APT: **não** entra no caminho live — segue desativado até itens 6/13/10.
5. Health tests no caminho live: **não** — condição de parada.
6. Geração de chaves/seeds/nonces/tokens: **continua desabilitada**.

## 23. Plano de rollback

- Staging: `bash staging/down.sh -v` (efêmero, nada em produção).
- Deploy do frontend/API: manter a imagem `f058f22` marcada; `docker compose
  up -d` com a tag anterior; SQLite de tokens não muda de schema nesta fase.
- NIST: nenhuma mudança aplicada → nada a reverter.
- Branch: `main` permanece em `f058f22` até o merge explícito; a branch de
  trabalho pode ser descartada sem efeito colateral.

## 24. Alegações permitidas

- O pipeline **serve bytes de forma estável** e agora **rotula proveniência**
  em toda resposta (`replay` no staging; `live` só quando a env de produção o
  disser).
- `qrng-connector.py` e `server_api.py` são **passthrough verbatim** do bloco
  no software (hashes conferidos).
- O transporte usa **`uint32` little-endian de 4 bytes** (confirmado no
  software).
- **Vazão observada na fronteira de software**: ~680.626 B/s (sem relação
  comprovada com a taxa física de amostragem).
- Rate limit: **quotas independentes por IP**, demonstradas com **dois IPs
  reais distintos**; 429 estruturado; janela de 60 s.
- Suítes de teste (rodada de 2026-08-28): **85/85** Playwright no staging;
  **37/37** unit NIST; **127/127** unit client-api (incl. 12 de proveniência);
  **34** de lib do frontend (incl. exponencial); **11/11** instrumentação;
  **8/8** restart harness. CI real **verde** em #37/#38.
- Cada resposta da API agora carrega uma **proveniência resolvida por
  resposta** (`provenance_detail`), nunca elevada acima do que a instância
  pode provar; `fallback_used` prevalece sobre a configuração.
- O NIST de staging expõe explicitamente `assessment_engine`,
  `synthetic_result` e o banner "RESULTADO SINTÉTICO DE STAGING" — nenhum
  resultado do executor fake é apresentável como avaliação real.
- Cada lane de byte, **isoladamente**, tem alta entropia marginal em capturas
  históricas.

## 25. Alegações proibidas (não sustentadas por evidência)

- ❌ "validado", "conforme NIST", "aprovado no SP 800-90B", "pronto para
  produção".
- ❌ "fonte uniforme", "sem viés", "seguro".
- ❌ "lanes físicas independentes" / "independência confirmada" (a simulação C4
  **não** demonstra isso; correlação linear ≈ 0 **não** é prova).
- ❌ "a origem do viés é física" — há lógica digital antes da primeira fronteira
  instrumentável hoje.
- ❌ "taxa de amostragem física = throughput de transporte".
- ❌ "o `uint32` é a amostra física" / "o byte é a unidade de avaliação
  definitiva".
- ❌ qualquer resultado de **replay/histórico** apresentado como `live`.
- ❌ "restart campaign executada" / resultados de mil reinicializações.

---

## Próximo ponto exato de autorização

**Autorizar uma janela controlada de acesso à FPGA `10.0.10.2`** (inspeção de
RTL/bitstream/`fifo.c`/servidor `:12345` + um pequeno teste de power-cycle),
que destrava, em ordem: item 6 (unidade física), item 13 (taxa física), item 8
(viés por fronteira, com o tap a montante), item 9 (piloto físico de 3–5
power-cycles) e item 10 (recálculo de RCT/APT). Sem essa janela, os itens 6, 8,
9 e 10 permanecem `INCONCLUSIVO`/`BLOQUEADO` e o veredito permanece
`OPERACIONAL, MAS AINDA EM VALIDAÇÃO DA FONTE`.

Itens que podem avançar **sem** a janela da FPGA, se autorizados
separadamente: comparação paralela do NIST de staging contra a **suíte SP
800-90B real** (destrava a substituição do serviço NIST); merge de
frontend/API em `main` + deploy.
