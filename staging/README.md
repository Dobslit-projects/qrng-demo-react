# Staging E2E reproduzível — Kapuã QRNG (fase item 2)

Ambiente **isolado, reproduzível e identificável por versão** para os testes
Playwright (item 3) e a validação de rate limit (item 4). **Não substitui
produção. Não consome a conexão exclusiva da fonte de produção** — o upstream
é um *fixture de replay determinístico*.

## Subir / derrubar

```
# da RAIZ do repositório:
bash staging/up.sh          # build + up + imprime o MANIFESTO
bash staging/down.sh -v     # down + remove o volume de dados
```

`up.sh` imprime, a cada execução, o **manifesto de versão**: commit, data de
build, imagens + IDs (sha256), portas, endpoints, persistência.

## Composição

| serviço | imagem | papel | rede | porta |
|---|---|---|---|---|
| `fixture-upstream` | `kapua-staging-fixture-upstream:local` | imita o contrato de `server_api.py` (`/health`, `/random`, `/v1/raw`, `/v1/uint32`, `/stream`) servindo **replay determinístico** (PRNG seed `20260827`, pool 8 MiB). `POST /_ctl/{offline,online,reset}` para dirigir testes. | `kapua-staging` (bridge privada) | interna `:18091` |
| `qrng-client-api` | `kapua-staging-client-api:local` | build de `qrng-client-api/` (código real). `QRNG_UPSTREAM=http://fixture-upstream:18091`, `QRNG_SOURCE_LABEL=staging-fixture-replay`, `QRNG_PROVENANCE=replay`. Cotas pequenas p/ testes. | `kapua-staging` | interna `:3010` |
| `web` | `kapua-staging-web:local` | build de produção do frontend (`npm run build`, `base=/qrng`) + nginx com `staging/nginx.staging-e2e.conf` espelhando os caminhos de produção. | `kapua-staging` | **publicada** `127.0.0.1:${STAGING_WEB_PORT:-18080}:80` |

## Variáveis (não sensíveis)

`FIXTURE_SEED=20260827`, `FIXTURE_POOL_BYTES=8388608`, `FIXTURE_PROVENANCE=replay`,
`QRNG_SOURCE_LABEL=staging-fixture-replay`, `QRNG_PROVENANCE=replay`,
`MAX_JSON_BODY_BYTES=8kb`, `RATE_LIMIT_PER_TOKEN_PER_MINUTE=20`,
`PUBLIC_RATE_LIMIT_PER_IP_PER_MINUTE=15`, `PUBLIC_DAILY_QUOTA_REQUESTS_PER_IP=300`,
`DAILY_QUOTA_REQUESTS=500`. `JWT_SECRET`/`METRICS_TOKEN` são valores fixos de
staging, sem valor de segurança (documentados como tal no compose).

## Endpoints (mesmos caminhos de produção)

```
GET  /qrng/                       portal (SPA)
GET  /qrng/v1/openapi.json        OpenAPI público
GET  /qrng/v1/docs/               Swagger UI
GET  /qrng/v1/redoc              ReDoc
GET  /qrng/v1/health/self         liveness (sem token)
GET  /qrng/v1/health             saúde + upstream (token)
GET  /qrng/api/random             endpoint público anônimo -> /v1/public/random
GET  /qrng/api/health            -> fixture-upstream /health
POST /qrng/v1/auth/register|login, /v1/tokens, /v1/random?format=..., /v1/raw ...
GET  /qrng/nist/*                 503 NIST_STAGING_NOT_UP (serviço NIST de staging: fase seguinte)
```

## Proveniência

Toda resposta de dados declara **`provenance`** (campo JSON e header
`X-QRNG-Provenance`). Neste staging o valor é **`replay`** — nunca `live`.
`/qrng/v1/health` repassa `provenance` do `QRNG_PROVENANCE`. O `fixture-upstream`
adiciona `X-QRNG-Provenance: replay` e `X-QRNG-Environment: staging` a **toda**
resposta. Valores possíveis do contrato: `live | replay | fixture | historical
| fallback | unknown`.

## Persistência

SQLite em volume nomeado `kapua-staging-client-api-data` → `/data/staging.db`.
**Separado do banco de produção** (`/data/qrng-tokens.db` no container de prod).
`down.sh -v` zera.

## Health checks

- `fixture-upstream`: healthcheck do compose (`/health` 200).
- `qrng-client-api`: `GET /qrng/v1/health/self` → `{status:"ok"}`.
- `web`: nginx serve `/qrng/` (200).

## Rollback

Efêmero por design: `bash staging/down.sh -v` remove containers, rede e volume.
Nada em produção é tocado. Para "voltar uma versão", fazer `git checkout <sha>`
e `bash staging/up.sh` de novo — o manifesto registra o commit em uso.

## CI

Só o **subconjunto determinístico** dos testes Playwright entra no CI (não
depende da fonte produtiva — usa o fixture). Ver `.github/workflows/ci.yml`
job `e2e-staging` e `playwright.config.js` (`E2E_BASE_URL`).
