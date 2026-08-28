# Playwright / staging — categorização por camada (fase item 9)

Todo `e2e/staging/*.spec.js` roda contra o **compose de staging**
(`staging/docker-compose.staging.yml`): container `web` (build de PRODUÇÃO do
frontend + nginx espelhando os caminhos de prod) + container `qrng-client-api`
**real** + container `nist-staging` **real** (executor FAKE) + `fixture-upstream`
(replay determinístico, seed `20260827`). **Nenhum spec do staging usa mock.**

## Categorias

| categoria | onde | o que prova |
|---|---|---|
| **mock** | só nos testes unitários node:test do `qrng-client-api` (`raw-contract.test.js`, `serialization.test.js`, `error-contract.test.js`, `provenance.test.js`, `upstream-contract.test.js`, `api.test.js`, `body-limit.test.js` — `http.createServer` como upstream) | contrato/serialização da API isolada |
| **fixture (replay determinístico)** | `fixture-upstream` no compose de staging — TODOS os `e2e/staging/*.spec.js` que tocam `/qrng/api\|api-fpga\|v1/random` | comportamento ponta a ponta com bytes reprodutíveis; **provenance = `replay`, NUNCA `live`** |
| **API real de staging** | container `qrng-client-api` real (mesma imagem que iria a produção) — todos os specs de `random`/`raw`/`health`/`auth`/`tokens`/`rate limit` | a API real serve, autentica, aplica cota, estrutura erros |
| **serviço NIST de staging real** | container `nist-staging` (versão controlada de `nist_service.py`, executor **FAKE**) — `nist.spec.js` | fila/persistência/histórico/lifecycle/política de upload; **`synthetic_result=true`, banner "RESULTADO SINTÉTICO"** |
| **upstream real (`server_api.py`)** | **NÃO** está na suíte Playwright — é o script de VM `run-prov-real.sh` (replay de UMA resposta real capturada, sem 2º consumidor). Ver `PROVENANCE_REAL_UPSTREAM.md` | o contrato de proveniência contra o que o `server_api.py` real fornece (que é: nada de `X-QRNG-Captured-At`) |
| **proveniência** | `provenance.spec.js` (9) + `viz-provenance.spec.js` (4) + os asserts `provenance != live` espalhados em `api.spec.js`/`features.spec.js`/`nist.spec.js` | `actual_origin` nunca `live` sem evidência; JSON == headers; `fallback_used` prevalece; transições `online/degraded/stale/exhausted/offline` |

## Specs

| spec | # testes | camada | upstream |
|---|---|---|---|
| `api.spec.js` | 25 | API real de staging + frontend (Swagger/ReDoc/OpenAPI em navegador) | fixture replay |
| `downloads.spec.js` | 6 | frontend + API real; lê cada arquivo baixado e valida MIME/tamanho/SHA-256/BOM/precisão | fixture replay |
| `features.spec.js` | 10 | frontend (π Monte Carlo, máx f(x), Análise PRNG×QRNG, Sonificação) + erros 500/404/timeout estruturados | fixture replay + `/_ctl/mode=hang` |
| `nist.spec.js` | 33 | serviço NIST de staging (executor FAKE — `synthetic_result`) + política de upload endurecida + lifecycle | n/a |
| `provenance.spec.js` | 9 | contrato de proveniência por resposta | fixture replay + `/_ctl/mode` (online/degraded/stale/exhausted/offline) |
| `ratelimit.spec.js` | 2 | rate limit por IP (429 estruturado, headers `RateLimit-*`, `Retry-After`) | fixture replay |
| `ui.spec.js` | 10 | frontend real: navegação, Swagger/ReDoc renderizam em navegador, geração de chave DESABILITADA, banner NIST sintético, fallback offline | fixture replay + `/_ctl/offline` |
| `viz-provenance.spec.js` | 4 | instrumenta `window.fetch` + `Math.random`; cada viz → endpoint/formato/request_id/actual_origin/live_verified; toda chamada `/random` = `replay`, nunca `live` | fixture replay |

**Testes de "dois IPs reais + spoofing de X-Forwarded-For":** NÃO estão na
suíte Playwright (exigem duas origens IP genuínas). Estão documentados e
executados em `RATE_LIMIT_MULTI_IP.md` (rodada anterior) contra o staging real
e devem ser repetidos no canário no deploy (item 7, passo 9).

## Downloads cobertos (item 8 / `downloads.spec.js` + `features.spec.js`)

Raw `.bin`, Hexadecimal `.txt`, Base64, Decimal/uint8, Monte Carlo — cada um:
lido no teste, valida Content-Type, sem BOM, `length % 4` (raw), decodifica,
SHA-256, e (para os JSON) contagem de valores. Equivalência
Hex↔Base64↔uint8 → mesmo binário + SHA-256 (com `/_ctl/reset` no fixture).

## Não executar

- smoke test destrutivo em produção — **proibido**;
- Playwright contra `bongo.dobslit.com` — só contra o compose/canário isolado.
