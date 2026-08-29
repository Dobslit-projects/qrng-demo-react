# Aceitação curta e não destrutiva da produção — 2026-08-29

Alvo: `https://bongo.dobslit.com` · API base `https://bongo.dobslit.com/qrng/v1` · NIST base `https://bongo.dobslit.com/qrng/nist`
Versões: frontend `qrng-web:9e36a90` · API `qrng-client-api:4137bfe` (confirmadas via `docker ps` na Bongo).
Nenhuma carga significativa. Nenhuma escrita. Nenhuma alteração de FPGA/FIFO/NIST/produção.

| Item | URL | Método | Status | Content-Type | Qtd. solicitada | Qtd. retornada | Request ID | Proveniência | Resultado |
|---|---|---|---|---|---|---|---|---|---|
| Portal | `/` | GET | 302 → SPA | text/html | — | `<title>Kapuã</title>` | — | — | Conforme |
| Liveness | `/qrng/v1/health/self` | GET | 200 | application/json | — | `{status:"ok",service:"qrng-client-api"}` | — | — | Conforme |
| Saúde (com token) | `/qrng/v1/health` | GET | — | — | — | — | — | — | **Não executado** (sem credencial de teste autorizada) |
| Aleatório JSON hex (público) | `/qrng/v1/public/random?bytes=8` | GET | 200 | application/json | 8 | `bytes:8`, `random` 16 hex | `req_faec73ff0a38199e` | `unknown` / `live_verified:false` / `captured_at:null` | Conforme |
| Aleatório base64 (público) | `/qrng/v1/public/random?bytes=12&format=base64` | GET | 200 | application/json | 12 | `random` "kewR4Bk+wtlMrqr/" (16 b64) | `req_7e6587da45ede4eb` | `unknown` | Conforme |
| Aleatório uint8 (público) | `/qrng/v1/public/random?bytes=12&format=uint8` | GET | 200 | application/json | 12 | array de 12 ints 0–255 | `req_393ba5a55b4a4fb8` | `unknown` | Conforme |
| Raw binário (público) | `/qrng/v1/public/raw?bytes=16` | GET | 200 | application/octet-stream | 16 | `Content-Length: 16` (16 B, sem BOM) | `req_535d14017069e2d8` | headers `X-QRNG-*` (`unknown`, `Conditioned:false`) | Conforme |
| Erro 422 (bytes inválido) | `/qrng/v1/public/random?bytes=abc` | GET | 422 | application/json | — | `{error:"INVALID_BYTES"}` | `req_03aff02f3f18f8b3` | — | Conforme |
| Erro 422 (format inválido) | `/qrng/v1/public/random?bytes=8&format=xml` | GET | 422 | application/json | — | `{error:"INVALID_FORMAT"}` | `req_49067db217f6f868` | — | Conforme |
| Erro 413 (acima do limite público) | `/qrng/v1/public/random?bytes=99999999` | GET | 413 | application/json | — | `{error:"REQUEST_TOO_LARGE", max_bytes_per_request:65536}` | `req_c3e166906c26f47a` | — | Conforme |
| Erro 404 | `/qrng/v1/nope` | GET | 404 | application/json | — | `{error:"NOT_FOUND"}` | `req_5b6f2e1ea98638ba` | — | Conforme |
| Erro 401 (sem token) | `/qrng/v1/random?bytes=8` | GET | 401 | application/json | — | `{error:"MISSING_TOKEN"}` | `req_dbff9012e9e8464e` | — | Conforme |
| Erro 403 (token inválido) | `/qrng/v1/random?bytes=8` + header ruim | GET | 403 | application/json | — | `{error:"INVALID_TOKEN"}` | `req_4f26d850dbd56802` | — | Conforme |
| Erro 400 | — | — | — | — | — | — | — | — | **Não observado** (a API usa 422 para parâmetros inválidos; 400 reservado a corpo malformado, não aplicável a estes GET) |
| Erro 429 | `/qrng/v1/public/random` (flood 25×) | GET | 200×25 | — | — | — | — | — | **Não reproduzido** com flood curto; `RateLimit-Policy: 20;w=60` e `RateLimit-Limit/Remaining` observados. Diretiva proíbe carga significativa. |
| Erro 503 | — | — | — | — | — | — | — | — | **Não reproduzível** sem derrubar o upstream (fora de escopo) |
| Rate-limit headers (público) | `/qrng/v1/public/random?bytes=8` | GET | 200 | — | — | — | — | `RateLimit-Policy: 20;w=60`, `RateLimit-Limit: 20`, `RateLimit-Remaining: 19` | Conforme |
| Determinismo (3 chamadas indep.) | `/qrng/v1/public/random?bytes=8` ×3 | GET | 200 | — | 8 | `random` = `86155da2c3667559`, `af608bd6f52885d5`, `a82d03b0c017916d` (todas diferentes) | — | `unknown` | Conforme (não comparar amostras live entre si) |
| Swagger UI | `/qrng/v1/docs/` | GET | 200 | text/html | — | — | — | — | Conforme |
| ReDoc | `/qrng/v1/redoc` | GET | 200 | text/html | — | — | — | — | Conforme |
| OpenAPI JSON | `/qrng/v1/openapi.json` | GET | 200 | application/json | — | `openapi 3.0.3`, `title "Kapuã QRNG — API Pública"`, `version 1.0.0` | — | — | Conforme |
| Cripto — `/v1/entropy` | `/qrng/v1/entropy?bytes=8` | GET | 404 | — | — | — | — | — | Conforme (indisponível) |
| Cripto — `/v1/random/cryptographic` | `/qrng/v1/random/cryptographic?bytes=8` | GET | 404 | — | — | — | — | — | Conforme (indisponível) |
| Cripto — `/v1/keys` | `/qrng/v1/keys?bytes=8` | GET | 404 | — | — | — | — | — | Conforme (indisponível) |
| Cripto — `/v1/seed` | `/qrng/v1/seed?bytes=8` | GET | 404 | — | — | — | — | — | Conforme (indisponível) |
| Cripto — `/v1/nonce` | `/qrng/v1/nonce?bytes=8` | GET | 404 | — | — | — | — | — | Conforme (indisponível) |
| Bulk (não implementado) | `POST /qrng/v1/bulk-random-jobs` | POST | 401 | application/json | — | `{error:"MISSING_TOKEN"}` (501 fica atrás da auth) | — | — | Conforme (stub) |
| NIST health | `/qrng/nist/health` | GET | 200 | application/json | — | `enabled:true`, `assessment_engine:"sp800-90b-reference"`, `synthetic_result:false`, `live_capture_configured:false`, upload ≤128 MiB (`.bin/.csv/.txt`) | — | — | Conforme |
| Login / criação de token (conta de teste) | `/qrng/v1/auth/*`, `/qrng/v1/tokens` | POST | — | — | — | — | — | — | **Não executado** (sem conta de teste autorizada; a diretiva veda obter credenciais) |
| Formatos hex/base64/uint8/raw equivalentes | — (fixture determinística) | — | — | — | 64 B / 128 B | SHA-256 idêntico | — | — | Conforme — `format_equivalence_check.mjs` 14/14 + notebook célula 6 |

## Arquivos de evidência neste diretório

- `body_health_self.out`, `b_pub_*`, `b_err_*`, `portal.html`, `body_portal_root.out`, `openapi.json` — capturas HTTP.
- `format_equivalence_check.mjs` + `format_equivalence_result.txt` — verificação determinística de equivalência dos formatos.
- `python_example_run.txt` — execução de `docs/examples/kapua_api_example.py` (caminho público).
- `notebook_cells_run.txt` — execução das células de código de `docs/examples/kapua_jupyter_example.ipynb` (caminho público).
- `PRIOR_Guia_Usuario_Kuapoa_QRNG.docx` + `PRIOR_GUIDE.sha256` — guia anterior preservado como referência.

## Observações

1. **Verificações que exigiam credencial autorizada** (`/v1/health` com token, `/v1/me/*`, login, criação/uso de token pessoal por conta de teste, cota diária, `/me/requests`): **não executadas** — nenhuma credencial de teste está disponível de forma autorizada e a diretiva veda obtê-la. O contrato desses endpoints está documentado a partir do OpenAPI e do código.
2. **429 e 503**: não reproduzidos sem violar "não provocar carga significativa / esgotamento real". Contrato documentado via OpenAPI; há testes de contrato de erro no CI (`error-contract.test.js`).
3. **Proveniência**: em 100% das respostas observadas, `provenance="unknown"`, `live_verified=false`, `captured_at=null` — comportamento intencional enquanto a origem física não for comprovada.
4. **Screenshots (Figuras 1–25 do guia)**: capturadas em 2026-08-29 do **bundle de produção** (`qrng-web:9e36a90`, `index-GEJGDRrN.js` idêntico ao servido) renderizado localmente (`docs/_build/serve_local.mjs` + `docs/_build/screenshots.mjs`, Playwright/Chromium) sobre os **endpoints QRNG reais da produção**. O SPA hospedado (`bongo.dobslit.com/qrng/`) está atrás de gate de sessão do host (302 sem `bongo_session`); render local do mesmo bundle + mesmos dados = imagem fiel, sem credencial. Nenhuma figura contém token/senha/cookie/cabeçalho de auth. Provenância detalhada em `docs/images/README.md`.
