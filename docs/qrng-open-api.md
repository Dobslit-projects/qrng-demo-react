# QRNG Open API no Kuapoã — avaliação, implementação e uso

Interface compatível com o contrato **QRNG Open API** (Palo Alto Networks e parceiros), adicionada à `qrng-client-api`
**ao lado** das rotas atuais. As rotas existentes (`/v1/random`, `/v1/raw`, `/v1/public/*`, `/v1/health` etc.) não
mudam de formato nem de comportamento.

## 1. Contrato consultado

| Item | Valor |
|---|---|
| Repositório | https://github.com/PaloAltoNetworks/QRNG-OPENAPI |
| Revisão | `812e2055dd89362d81ace049ec92df4425f8e699` (2025-01-22, "Delete README.md"; 28 commits) |
| Conteúdo | um único arquivo Markdown (`GitHub Repository for QRNG Open API.md`) + `LICENSE` |
| Licença | **GNU AGPL-3.0** |
| Data da consulta | 2026-10-18 |

**QRNG Open API não é a OpenAPI (Swagger).** O nome coincide, mas são coisas diferentes:

- *QRNG Open API* é um contrato de interoperabilidade para obter entropia por REST: três operações
  (`GET /v1/capabilities`, `POST /v1/entropy`, `GET /v1/healthtest`) descritas em prosa e exemplos.
  O repositório **não** traz um documento OpenAPI/JSON Schema formal.
- *OpenAPI* (antiga Swagger) é o formato de descrição de APIs que este serviço já publica em `/v1/openapi.json`.
  As novas rotas foram descritas nesse formato (seção 4) como documentação própria do Kuapoã.

**Licença.** Por ser AGPL-3.0, nenhum código, texto ou arquivo do repositório foi copiado para o Kuapoã. A
implementação é própria e segue apenas o contrato (nomes de rotas, campos e códigos de erro). Se no futuro alguém
quiser incorporar arquivos daquele repositório, isso precisa de análise jurídica antes, porque a AGPL alcança
serviços acessados pela rede.

### 1.1 O que o contrato diz

| Operação | Campo | Obrigatoriedade no contrato | Tipo |
|---|---|---|---|
| `GET /v1/capabilities` → `entropy` | `min_block_size` | opcional, padrão 1 | inteiro (bytes) |
| | `max_block_size` | **obrigatório** | inteiro (bytes) |
| | `min_block_count` | opcional, padrão 1 | inteiro |
| | `max_block_count` | **obrigatório** | inteiro |
| | `entropy_types` | opcional | lista de strings |
| | `extensions` | opcional | lista de objetos JSON |
| `GET /v1/capabilities` → `healthtest` (opcional) | `test_threshold[]` → `test_type` | obrigatório | string |
| | `test_threshold[]` → `time_stamp` | obrigatório | data/hora |
| | `test_threshold[]` → `report_link` | opcional | URL |
| | `source_count` | sem indicação | inteiro |
| | `extensions` | opcional | lista de objetos JSON |
| `POST /v1/entropy` (corpo) | `block_size` | **obrigatório** | inteiro (bytes) |
| | `block_count` | opcional, padrão 1 | inteiro |
| | `entropy_type` | opcional, padrão = 1º de `entropy_types` | string |
| `POST /v1/entropy` (resposta) | `entropy` | **obrigatório** | lista de strings Base64 |
| | `extensions` | opcional | lista de objetos JSON |
| `GET /v1/healthtest` (opcional) | `test_result[]` → `test_type`, `test_result`, `time_stamp` | obrigatórios | — |
| | `test_result[]` → `report_link` | opcional | URL |
| | `extensions` | opcional | lista de objetos JSON |
| Erros (as três rotas) | `422` parâmetro inválido; `503` fonte indisponível | — | sem formato de corpo definido |
| Autenticação | `Authorization: Bearer <token>` ou `X-API-KEY`; mTLS opcional | opcional | — |

### 1.2 Ambiguidades e interpretação adotada

| # | Ambiguidade no contrato | Interpretação adotada no Kuapoã |
|---|---|---|
| A1 | Não há schema formal; os blocos são pseudo-JSON com aspas tipográficas. | Os nomes de campos e a estrutura foram lidos dos blocos; exemplos informais não foram tratados como schema. |
| A2 | `test_threshold` é descrito como "array de strings", mas lista campos de objeto. | Lista de **objetos** `{test_type, time_stamp, report_link?}`. |
| A3 | Não fica claro se `source_count` e o segundo `extensions` pertencem a `healthtest` ou à raiz. | Dentro de `healthtest` (indentação do texto). `source_count = 1`. |
| A4 | O carimbo de exemplo `2023-09-13T08:34:4502` não é ISO 8601 válido. | RFC 3339 / ISO 8601 em UTC, ex.: `2026-10-18T09:41:02Z`. |
| A5 | `test_result` tem exemplo numérico (`0.94`) sem semântica definida. | **Texto** com o estado observado (`passing`, `alarm`, `unavailable`, `not_assessed`, `online`…). Nenhum número é inventado para representar aprovação. |
| A6 | Formato do objeto de extensão não é definido. | `{ "name": "kuapoa.<tema>", "version": 1, "data": { … } }`. |
| A7 | Corpo de erro não é definido; só os códigos 422 e 503. | Mesmo corpo de erro das rotas atuais: `{ request_id, error, message, … }`. Códigos adicionais documentados (seção 5.4). |
| A8 | `entropy_type` padrão = "1º do array"; o array é opcional. | `entropy_types` sempre publicado com o único tipo disponível. |
| A9 | Não há limite de total por chamada, só máximos por campo. | Limite total anunciado por extensão (`kuapoa.limits.max_total_bytes`) e aplicado antes de consumir entropia. |
| A10 | Inteiros: o contrato não diz como tratar `"32"`, `true` ou `32.5`. | Só números JSON com valor inteiro seguro e positivo. Strings, booleanos, nulos e frações → 422. (`32.0` e `1e3` são o mesmo valor que `32` e `1000` depois do parse JSON e são aceitos.) |
| A11 | Campos desconhecidos no corpo do POST. | Ignorados (compatibilidade futura). |
| A12 | `/healthtest` mistura "saúde" com relatórios de teste. | `test_result` traz **só observações atuais**. Resultados históricos ficam numa extensão rotulada como histórica (seção 5.3). |

## 2. Implementação atual inspecionada (antes da mudança)

Verificado no código do repositório (`qrng-client-api/server.js`, `lib/provenance.js`, `openapi/`), no broker
(`server_api.py` 89E, sha `e39087e8`, cópia versionada em `qrng-sp80090b-tooling/etapa89e_api_health_20261014/`) e,
somente em leitura, nas rotas públicas de produção em 2026-10-18 (sem consumir entropia).

| Peça | O que existe |
|---|---|
| Proxy (nginx do Bongo) | `location /qrng/v1/` → `127.0.0.1:3010/v1/` por prefixo, sem gate de sessão. Confirmado em produção: `GET /qrng/v1/capabilities` hoje devolve o 404 JSON da própria client-api. **Nenhuma mudança de nginx é necessária.** |
| CORS | Na própria client-api: `Allow-Origin *`, `Allow-Headers: Authorization, Content-Type`, `Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS` (confirmado no preflight de produção). |
| Autenticação | Token pessoal `dobslit_qrng_live_<hex>` em `Authorization: Bearer`, guardado como SHA-256 em `api_tokens` (`requireToken`). Sessão JWT só para conta/tokens. |
| Limites | `MAX_BYTES_PER_REQUEST` 1 MiB; 60 req/min por token (memória); 120 req/min por IP (global); cota diária por token: 10 000 requisições e 100 MiB (SQLite `daily_usage`). |
| Contabilização | `logRequest()` grava `api_usage_logs` e soma em `daily_usage`. Falhas de upstream (502/503) **contam** requisição e bytes pedidos; erros de validação e recusas de cota/limite **não** contam. |
| Caminho dos bytes | `/v1/random` → um único `GET /random?bytes=N` ao broker (fator de sobre-provisão 1). Content-Length e Content-Type conferidos; menos que N → 503 `INSUFFICIENT_ENTROPY`; nunca há preenchimento. |
| Broker | Ring buffer de 256 MiB; `pop` sob trava, **tudo ou nada**: entrega exatamente N bytes ou 503 após o timeout. Retirada destrutiva: duas requisições nunca recebem a mesma região. |
| Bloqueio | `refuseIfSourceOffline`: 503 `SOURCE_OFFLINE` quando o poller (60 s) vê a fonte parada há > 60 s. Alarme dos health tests do hardware é **informado** (`X-QRNG-Entropy-Health`), não bloqueia nesta camada (decisão de produto em aberto desde a Etapa 89E). |
| Proveniência | `resolveProvenance()` por resposta; cabeçalhos `X-QRNG-*`; `X-QRNG-Conditioned=true` só com `verified_active_bitstream`. |
| Saúde | `/v1/public/health` (anônimo, só rótulos, cache 3 s); `/v1/health` (token, JSON completo do broker, inclui `entropy_health_detail`). O broker considera a sonda do hardware vencida após 180 s. |
| Testes | 199 testes `node:test` (todos passando na linha de base, Node 20). O script `npm test` (`node --test test/`) não funciona no Node 22 do Windows; a suíte roda com `node --test test/*.test.js`. |

## 3. Análise

**Reaproveitável sem mudança:** autenticação por token, limites por token e IP, cota diária, `logRequest`,
`refuseIfSourceOffline`, `interpretUpstreamResponse`, `resolveProvenance`, cabeçalhos de proveniência e qualificação,
o roteamento do nginx e o broker inteiro.

**Precisa ser implementado:** validação estrita do corpo JSON do POST; cálculo protegido do total; divisão em blocos e
Base64; respostas no formato do contrato; mapeamento dos estados de saúde; documentação; exemplos; testes.

**Refatoração mínima:** a aquisição de bytes do broker (busca, validação de transporte, checagem de quantidade) estava
copiada em `/v1/random` e `/v1/public/random`. Ela vira uma função comum (`acquireUpstreamBytes`) usada pelas duas
rotas atuais e pela nova. As respostas e a contabilização de cada rota continuam nos próprios handlers.

**Riscos de regressão:** (1) a refatoração da aquisição — coberta pelos testes de contrato existentes, que
precisam continuar passando sem alteração; (2) o CORS passa a aceitar o cabeçalho `X-API-Key` — mudança só aditiva.

**Desempenho e consumo de entropia:** `/v1/entropy` retira do broker **exatamente** `block_size × block_count`
bytes, como `/v1/random`. O custo extra é só a codificação Base64 (+33 % no tamanho da resposta). `/capabilities` e
`/healthtest` leem o `/health` do broker (cache de 3 s) e **não consomem entropia**. Nenhuma taxa de produção é
anunciada: a taxa do FPGA não é uma garantia de entrega ao cliente.

**Recomendação:** adotar, como camada fina dentro da `client-api`, com o mesmo token, as mesmas cotas e o mesmo
caminho de bytes. Escopo: as três rotas; `/healthtest` limitado ao que há evidência (estado observado dos health tests
do hardware, prontidão da fonte e qualificação do bitstream, com carimbo de observação e validade).

```
Rotas atuais ──────────┐
                       ├─ acquireUpstreamBytes ─ broker (ring buffer, pop atômico) ─ FPGA
Rotas QRNG Open API ───┘
     └─ mesmos: token, limite por token/IP, cota diária, logRequest, bloqueio de fonte parada, proveniência
```

## 4. Endereços

| Rota do contrato | Endereço público (produção, via nginx) | Na client-api |
|---|---|---|
| `GET /v1/capabilities` | `https://bongo.dobslit.com/qrng/v1/capabilities` | `GET /v1/capabilities` |
| `POST /v1/entropy` | `https://bongo.dobslit.com/qrng/v1/entropy` | `POST /v1/entropy` |
| `GET /v1/healthtest` | `https://bongo.dobslit.com/qrng/v1/healthtest` | `GET /v1/healthtest` |

Para clientes que montam a URL como `<URI>/capabilities`, use `URI = https://bongo.dobslit.com/qrng/v1`.
As três rotas exigem o token pessoal (o mesmo de `/v1/random`) em `Authorization: Bearer` ou `X-API-Key`.
A especificação OpenAPI pública (`/qrng/v1/openapi.json`, Swagger em `/qrng/v1/docs/`) traz as três rotas na tag
"QRNG Open API".

## 5. O que foi implementado

### 5.1 Arquivos

| Arquivo | Mudança |
|---|---|
| `qrng-client-api/lib/qrng-open-api.js` | **novo** — lógica pura do contrato: limites, validação estrita do pedido, divisão em blocos Base64, capacidades, mapeamento de saúde |
| `qrng-client-api/server.js` | `acquireUpstreamBytes()` (aquisição comum, extraída de `/v1/random` e `/v1/public/random` sem mudar respostas nem contabilização); `sourceQualificationFrom()`; `lookupActiveToken()` + `requireApiCredential` (Bearer ou X-API-Key, mesmo token); rotas `/v1/capabilities`, `/v1/entropy`, `/v1/healthtest` + 405; CORS aceita `X-API-Key`; métricas `qrng_openapi_entropy_*` |
| `qrng-client-api/openapi/spec.js` | tag "QRNG Open API", esquema `apiKeyHeader`, schemas `Qoa*` |
| `qrng-client-api/openapi/qrng-public-v1.yaml`, `qrng-internal-admin-v1.yaml` | regenerados (`npm run openapi:generate`) |
| `qrng-client-api/test/qrng-open-api.test.js` | **novo** — 29 testes |
| `qrng-client-api/test/qrng-open-api-quota.test.js` | **novo** — 6 testes (cotas e limites compartilhados) |
| `docs/qrng-open-api.md` | **novo** — este documento |
| `docs/examples/qrng-open-api/` | **novo** — exemplos Python e curl |

Nada mudou em hardware, bitstream, FPGA, Toeplitz, FIFO, broker, health tests, nginx ou portal.

### 5.2 Comportamento de `POST /v1/entropy`

1. Cadeia: request_id → `Cache-Control: no-store` → token (Bearer ou X-API-Key) → limite por token/min →
   validação do corpo → cota diária → bloqueio de fonte parada → aquisição.
2. A validação acontece **antes** de qualquer consumo: corpo JSON objeto; `block_size` inteiro positivo seguro;
   `block_count` idem (padrão 1); `entropy_type` entre os anunciados (padrão = o primeiro); total
   `block_size × block_count ≤ max_total_bytes`, comparado por divisão (sem risco de overflow).
3. Uma única retirada no broker de exatamente o total. Menos bytes, erro de transporte, timeout ou broker sem dados
   → erro, **sem** campo `entropy`. Nunca há preenchimento, repetição ou outra fonte.
4. Os bytes são divididos em `block_count` blocos de `block_size` bytes, na ordem, e cada bloco vira uma string Base64.
5. Contabilização: 1 requisição e `block_size × block_count` bytes na cota diária do token (a mesma de `/v1/random` e
   `/v1/raw`). Falhas do upstream contam como nas rotas atuais; 422 e recusas por limite/cota não contam.
   `/capabilities` e `/healthtest` contam 1 requisição com 0 bytes, como `GET /v1/health`.
6. Resposta: `{"entropy": [...], "extensions": [{"name": "kuapoa.response", ...}]}` com request_id, tipo, tamanhos,
   `conditioned`, `qualification_status`, `entropy_health` e proveniência; os mesmos cabeçalhos `X-QRNG-*` de `/v1/random`.

### 5.3 Saúde (`/v1/healthtest`)

| Categoria pedida | Onde aparece | Fonte |
|---|---|---|
| Disponibilidade do serviço | HTTP 200 (503 se o broker não responde); `kuapoa.health_summary.service` | leitura do `/health` do broker (cache ≤ 3 s) |
| Prontidão da fonte | `test_result` `kuapoa_source_liveness` (online/degraded/offline) + `source_readiness` | `source_status` do broker |
| Testes contínuos observados | `test_result` `kuapoa_hw_continuous_rct_apt` (passing/alarm/unavailable/not_assessed/unknown), `time_stamp` = instante da leitura da sonda | registradores do wrapper no FPGA, lidos pela sonda do dobslit |
| Qualificação do bitstream | `test_result` `kuapoa_bitstream_qualification` | `qualification_status` do broker |
| Resultados históricos | **só** na extensão `kuapoa.historical_assessment` (`not_real_time_health: true`), e só com o bitstream qualificado verificado | arquivo de qualificação do broker |

Observação vencida (mais de 180 s, regra do broker) aparece como `unavailable` com `reason: stale_probe`. Estado
desconhecido vira `unknown`. Sem sonda, `not_assessed`, e o carimbo é marcado como leitura de status
(`time_stamp_source: status_read_no_observation`). Nenhum número é publicado como resultado de aprovação.

**Política de entrega preservada:** um alarme dos health tests do hardware é informado (aqui e em `X-QRNG-Entropy-Health`),
mas não bloqueia a entrega nesta camada, exatamente como em `/v1/random`. O FPGA para a saída num alarme e a API recusa
quando a fonte fica parada por mais de 60 s. Mudar isso é uma decisão de produto pendente (seção 8) e precisaria valer
para todas as rotas.

### 5.4 Códigos de resposta

| Código | Quando | No contrato? |
|---|---|---|
| 200 | sucesso | sim |
| 400 | `AMBIGUOUS_CREDENTIALS`; `INVALID_JSON` (corpo malformado) | não (adicional) |
| 401 | `MISSING_TOKEN` | não (adicional) |
| 403 | `INVALID_TOKEN` (token inválido ou revogado) | não (adicional) |
| 405 | método errado (`Allow` no cabeçalho) | não (adicional) |
| 413 | corpo JSON acima de 8 KiB | não (adicional) |
| 415 | corpo sem `Content-Type: application/json` | não (adicional) |
| 422 | parâmetro inválido (`MISSING_BLOCK_SIZE`, `INVALID_BLOCK_SIZE`, `BLOCK_SIZE_OUT_OF_RANGE`, `INVALID_BLOCK_COUNT`, `BLOCK_COUNT_OUT_OF_RANGE`, `UNSUPPORTED_ENTROPY_TYPE`, `TOTAL_TOO_LARGE`, `INVALID_REQUEST_BODY`) | **sim** |
| 429 | `RATE_LIMIT_EXCEEDED` (com `Retry-After`), `QUOTA_EXCEEDED`, `QUOTA_BYTES_EXCEEDED` | não (adicional) |
| 502 | upstream com erro ou fora do contrato de transporte | não (adicional) |
| 503 | `QRNG_UNAVAILABLE`, `INSUFFICIENT_ENTROPY`, `SOURCE_OFFLINE`, `HEALTH_TEST_SOURCE_UNAVAILABLE` | **sim** |

Diferença em relação a `/v1/random`: quando o broker responde 503/504 (sem os bytes no prazo), `/v1/entropy`
devolve 503 (contrato) com `upstream_status`; `/v1/random` continua com o 502 `UPSTREAM_ERROR` de sempre.

### 5.5 Configuração (todas opcionais; os padrões reproduzem a produção)

| Variável | Padrão | Efeito |
|---|---|---|
| `MAX_BYTES_PER_REQUEST` | 1048576 | limite total por chamada, **o mesmo** de `/v1/random` (`max_total_bytes`) |
| `QRNG_OPENAPI_MAX_BLOCK_SIZE` | = `MAX_BYTES_PER_REQUEST` | `max_block_size` (nunca acima do total) |
| `QRNG_OPENAPI_MAX_BLOCK_COUNT` | 1024 | `max_block_count` |
| `QRNG_OPENAPI_ENTROPY_TYPE` | `kuapoa_qrng` | o único tipo anunciado |
| `QRNG_OPENAPI_STATUS_TTL_MS` | 3000 | cache da leitura de status do broker (nunca usado para liberar bytes) |
| `QRNG_PUBLIC_BASE_URL` | `https://bongo.dobslit.com/qrng/v1` | base dos `report_link` |

## 6. Matriz de aderência ao contrato (revisão 812e2055)

| Requisito | Situação | Nota |
|---|---|---|
| `GET /v1/capabilities` | atendido | |
| `entropy.max_block_size`, `entropy.max_block_count` (obrigatórios) | atendido | 1048576 e 1024 |
| `min_block_size`, `min_block_count`, `entropy_types`, `extensions` (opcionais) | atendido | `extensions` traz o limite total (A9) |
| `healthtest.test_threshold`, `source_count`, `extensions` | atendido com interpretação | A2, A3 |
| `POST /v1/entropy` com `block_size` obrigatório | atendido | |
| `block_count` padrão 1; `entropy_type` padrão = 1º tipo | atendido | |
| Resposta `entropy` = lista Base64 | atendido | um item por bloco |
| `Content-Type: application/json` | atendido | 415 se ausente |
| `GET /v1/healthtest` (opcional) | atendido com mapeamento conservador | `test_result` em texto (A5) |
| Erros 422 e 503 | atendido | códigos adicionais documentados (5.4) |
| `Authorization: Bearer` | atendido | mesmo token das rotas atuais |
| `X-API-KEY` | atendido | cabeçalho `X-API-Key` (HTTP não diferencia maiúsculas) |
| mTLS | não oferecido | TLS termina no nginx; mTLS exigiria mudança de infraestrutura |
| Extensões de fornecedor | atendido | formato `{name, version, data}` (A6) |
| Carimbo de tempo | ISO 8601 UTC | o exemplo do contrato não é um formato válido (A4) |

Compatibilidade com produtos de terceiros que consomem o contrato **não foi testada**: a matriz compara a
implementação com o texto do contrato, não com um cliente real.

## 7. Validação executada

| Verificação | Resultado |
|---|---|
| Suíte da client-api (`npm test`, Node 20.20.2, mesmo comando do CI) | **234/234** (199 existentes, sem alteração, + 35 novos) |
| Lint, lint-gate e checagem de drift da OpenAPI (passos do CI) | OK, sem drift |
| Teste de mutação: 8 defeitos propositais (deslocamento de bloco, sem no-store, aceitar string, aceitar resposta curta, estado desconhecido → passing, contabilização errada, sem cota, reuso de bloco) | **8/8 detectados** |
| Validação integrada local: client-api real + código real do broker 89E servindo replay da captura OPS-A (16 MB), sondas simuladas | **23/23** |
| Exemplos Python (Bearer e X-API-Key) e curl contra o ambiente integrado local | executados sem erro |
| Produção, somente leitura (sem consumir entropia): roteamento `/qrng/v1/*`, preflight CORS, `/public/health` | confirmado |

Os testes cobrem: padrões; parâmetros válidos e inválidos (strings, booleanos, nulos, frações, zero, negativos,
valores acima de 2⁵³); limites individuais e total; tipos aceitos e rejeitados; quantidade e tamanho dos blocos;
preservação dos bytes no Base64 (fluxo determinístico e captura real); autenticação; cotas, limite por minuto e
contabilização compartilhados; resposta curta, timeout, broker 503/500, Content-Type errado; fonte parada,
qualificação vencida, sonda vencida, alarme, ausência de sonda; concorrência entre `/v1/entropy` e `/v1/random`
(nenhuma região entregue duas vezes, verificado por posição no fluxo e não por ausência de repetição); `no-store`
em sucesso e erro; ausência de entropia no console e na tabela de uso; regressão das rotas atuais.

## 8. Pendências reais

1. **Implantação** (revisão, merge e deploy): fora desta tarefa; procedimento na seção 9.
2. **Teste de fumaça em produção** depois da implantação, com volume pequeno (seção 9).
3. **Decisão de produto** (aberta desde a Etapa 89E): recusar entrega durante `hw_health_alarm` em todas as rotas.
4. **Interoperabilidade com clientes de terceiros** não testada (exige um cliente real do contrato).
5. **mTLS** não oferecido.
6. **Texto desatualizado na OpenAPI existente**: a descrição geral e a de `/v1/random` ainda dizem "sem conditioning";
   o bitstream em produção tem o extrator Toeplitz. Fora do escopo desta mudança.
7. **Limitação preexistente das cotas**: a cota diária é verificada antes da chamada e somada depois; requisições
   simultâneas do mesmo token podem passar um pouco do limite. Vale igualmente para `/v1/random`.
8. **`npm test` no Windows com Node 22**: o script `node --test test/` não acha os testes; o CI (Node 20) roda
   normalmente. Localmente, use `node --test test/*.test.js`.

## 9. Implantação e rollback

Nenhuma variável de ambiente nova é necessária e o nginx não muda. A implantação segue o pipeline existente
(`WEB correções/deploy/deploy_qrng.sh`: imagem etiquetada pelo SHA, canário, troca encadeada, contêiner anterior
guardado como `qrng-client-api-prev-<sha anterior>`).

1. Revisar e integrar o branch `feature/qrng-open-api-20261018` em `main`.
2. Atualizar `SHA_EXPECTED` em `deploy_qrng.sh` para o SHA de `main` resultante e executar o script na VM.
3. Teste de fumaça, com o token de uma conta de teste em `QRNG_API_TOKEN` (consome 32 + 256 bytes):

```bash
B=https://bongo.dobslit.com/qrng/v1
curl -sS -o /dev/null -w "capabilities %{http_code}\n" -H "Authorization: Bearer $QRNG_API_TOKEN" "$B/capabilities"
curl -sS -X POST -H "Authorization: Bearer $QRNG_API_TOKEN" -H "Content-Type: application/json" -d '{"block_size":32}' "$B/entropy" | python3 -c 'import sys,json,base64; e=json.load(sys.stdin)["entropy"]; print("entropy", len(e), "bloco(s) de", len(base64.b64decode(e[0])), "bytes")'
curl -sS -X POST -H "X-API-Key: $QRNG_API_TOKEN" -H "Content-Type: application/json" -d '{"block_size":64,"block_count":4}' "$B/entropy" | python3 -c 'import sys,json,base64; print("entropy", [len(base64.b64decode(x)) for x in json.load(sys.stdin)["entropy"]])'
curl -sS -H "Authorization: Bearer $QRNG_API_TOKEN" "$B/healthtest" | python3 -c 'import sys,json; [print(t["test_type"], t["test_result"], t["time_stamp"]) for t in json.load(sys.stdin)["test_result"]]'
curl -sS -o /dev/null -w "random (rota atual) %{http_code}\n" -H "Authorization: Bearer $QRNG_API_TOKEN" "$B/random?bytes=32"
curl -sS -o /dev/null -w "openapi.json %{http_code}\n" "$B/openapi.json"
```

Esperado: `capabilities 200`; `entropy 1 bloco(s) de 32 bytes`; `entropy [64, 64, 64, 64]`; três linhas de
healthtest com carimbo; `random (rota atual) 200`; `openapi.json 200`.

**Rollback** (na VM, como root; volta ao contêiner que estava em produção antes da troca):

```bash
PREV=$(docker ps -a --filter "name=^/qrng-client-api-prev-" --format '{{.Names}}' | head -1)
echo "voltando para $PREV"
docker stop qrng-client-api && docker rm qrng-client-api && docker rename "$PREV" qrng-client-api && docker start qrng-client-api
curl -s -o /dev/null -w "capabilities depois do rollback: %{http_code} (esperado 404)\n" http://127.0.0.1:3010/v1/capabilities
```

O rollback não toca o banco de dados (volume `/data`): tokens, contas e cotas continuam. Como as rotas novas só
acrescentam comportamento, nenhum dado precisa ser revertido. O script de implantação também troca o contêiner do
portal (`qrng-web-1`), mas esta mudança não altera o frontend (`src/` intocado); ele não precisa voltar.
