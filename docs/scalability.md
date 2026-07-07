# Escalabilidade da QRNG Client API

Documentação dos limites configuráveis, política de uso, como rodar os testes de carga e o roadmap para suporte a grandes volumes.

---

## Limites configuráveis

Todos os limites são definidos via variáveis de ambiente. Em produção, configure-as no arquivo systemd (`/etc/systemd/system/qrng-client-api.service`). Para desenvolvimento local, crie um arquivo `.env` baseado em `.env.example`.

| Variável | Padrão | Descrição |
|---|---|---|
| `MAX_BYTES_PER_REQUEST` | `1048576` (1 MiB) | Máximo de bytes por requisição síncrona |
| `RATE_LIMIT_PER_IP_PER_MINUTE` | `120` | Requisições por minuto por IP (global) |
| `RATE_LIMIT_PER_TOKEN_PER_MINUTE` | `60` | Requisições por minuto por token de API |
| `DAILY_QUOTA_REQUESTS` | `10000` | Cota diária de requests (padrão para novos tokens) |
| `DAILY_QUOTA_BYTES` | `104857600` (100 MiB) | Cota diária de bytes por token |
| `QRNG_REQUEST_TIMEOUT_MS` | `10000` (10s) | Timeout para chamadas ao upstream FPGA |

### Ajuste por token (admin)

A cota de requests (`quota_daily`) pode ser ajustada individualmente por token via:

```http
PATCH /v1/admin/tokens/:id/quota
Authorization: Bearer <jwt_admin>
Content-Type: application/json

{ "quota_daily": 50000 }
```

---

## Códigos de erro relacionados a limites

| HTTP | `error` | Causa |
|---|---|---|
| `413` | `REQUEST_TOO_LARGE` | `bytes` acima de `MAX_BYTES_PER_REQUEST` |
| `422` | `INVALID_BYTES` | `bytes` não é inteiro positivo |
| `422` | `INVALID_FORMAT` | `format` não é `hex`, `base64` ou `uint8` |
| `429` | `RATE_LIMIT_EXCEEDED` | Limite por token/min atingido |
| `429` | `QUOTA_EXCEEDED` | Cota diária de requests esgotada |
| `429` | `QUOTA_BYTES_EXCEEDED` | Cota diária de bytes esgotada |
| `501` | `BULK_JOBS_NOT_IMPLEMENTED` | Endpoint de jobs assíncronos ainda não disponível |
| `503` | `QRNG_UNAVAILABLE` | Upstream FPGA indisponível ou timeout |

Todos os erros retornam JSON com os campos `error` e `message`. Respostas de sucesso (`200`) incluem `request_id`.

---

## Como configurar o ambiente

### Produção (systemd)

```ini
# /etc/systemd/system/qrng-client-api.service
[Service]
Environment=PORT=3010
Environment=QRNG_UPSTREAM=http://127.0.0.1:18001
Environment=JWT_SECRET=<gerado com openssl rand -hex 32>
Environment=ADMIN_EMAIL=admin@seudominio.com
Environment=MAX_BYTES_PER_REQUEST=1048576
Environment=RATE_LIMIT_PER_IP_PER_MINUTE=120
Environment=RATE_LIMIT_PER_TOKEN_PER_MINUTE=60
Environment=DAILY_QUOTA_REQUESTS=10000
Environment=DAILY_QUOTA_BYTES=104857600
Environment=QRNG_REQUEST_TIMEOUT_MS=10000
```

Após editar:
```bash
systemctl daemon-reload
systemctl restart qrng-client-api
```

### Desenvolvimento local

```bash
cp qrng-client-api/.env.example qrng-client-api/.env
# edite os valores no .env
cd qrng-client-api && node server.js
```

---

## Rodando os testes k6

### Pré-requisitos

```bash
# Instalar k6 (Linux)
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# macOS
brew install k6

# Windows
winget install k6
```

### Variáveis necessárias

```bash
export API_TOKEN="dobslit_qrng_live_seu_token_aqui"
export BASE_URL="https://bongo.vps-uni5.net/qrng/v1"
```

### Teste de boundary (limites)

Valida que valores inválidos são rejeitados corretamente e que a API não trava.

```bash
k6 run load-tests/qrng-boundary-test.js \
  -e API_TOKEN=$API_TOKEN \
  -e BASE_URL=$BASE_URL
```

**O que valida:**
- `bytes=0`, `-1`, `abc`, `1.5` → 422
- `bytes=1048577`, `1000000000` → 413
- `bytes=1`, `32`, `1048576` → 200 (ou 503 se upstream down)
- `format=base58` → 422
- Presença de `request_id` em respostas 200
- Presença de `max_bytes_per_request` em respostas 413

**Critério de aprovação:** todos os checks passam, nenhuma falha de rede.

---

### Teste de carga (usuários simultâneos)

Simula 10 → 50 → 100 → 200 VUs fazendo requisições contínuas.

```bash
k6 run load-tests/qrng-load-test.js \
  -e API_TOKEN=$API_TOKEN \
  -e BASE_URL=$BASE_URL
```

**Stages:**
| Fase | Duração | VUs |
|---|---|---|
| Rampa inicial | 30s | 0 → 10 |
| Sustentação | 60s | 10 |
| Rampa | 30s | 10 → 50 |
| Sustentação | 60s | 50 |
| Rampa | 30s | 50 → 100 |
| Sustentação | 60s | 100 |
| Rampa | 30s | 100 → 200 |
| Sustentação | 60s | 200 |
| Descida | 30s | 200 → 0 |

**Métricas separadas por categoria:**

| Métrica k6 | O que mede |
|---|---|
| `api_ok_rate` | Taxa de 200 + 429 — Node.js saudável |
| `upstream_down_rate` | Taxa de 503 — FPGA saturado (não é falha do Node) |
| `server_error_rate` | Taxa de 500/502 — erros reais de servidor |
| `req_duration_ok` | Latência apenas das respostas 200 |

503 **não** é contado como falha da API — é o upstream FPGA que está indisponível.

**Thresholds:**
- `http_req_failed < 1%` — erros de rede TCP
- `api_ok_rate > 98%` — 200 + 429 ≥ 98%
- `server_error_rate < 0.5%` — 500/502 quase zero
- `p(95) < 3000ms` e `p(99) < 8000ms` — latência das respostas OK

---

### Teste de stress (ponto de ruptura)

Sobe até 1000 VUs para identificar degradação de performance.

```bash
k6 run load-tests/qrng-stress-test.js \
  -e API_TOKEN=$API_TOKEN \
  -e BASE_URL=$BASE_URL
```

**Stages:**
| Fase | Duração | VUs |
|---|---|---|
| Aquecimento | 30s + 30s | 0 → 100 |
| Nível 1 | 120s | 100 |
| Nível 2 | 30s + 120s | 100 → 300 |
| Nível 3 | 30s + 120s | 300 → 600 |
| Nível 4 (pico) | 30s + 60s | 600 → 1000 |
| Descida | 60s | 1000 → 0 |

**Métricas separadas por categoria** (mesma filosofia do load test):

| Métrica | O que mede |
|---|---|
| `stress_api_ok_rate` | 200 + 429 — Node.js saudável |
| `stress_upstream_down` | 503 — FPGA saturado |
| `stress_server_error` | 500/502 — erro real |

**Como interpretar:**

| Resultado | Significado |
|---|---|
| `429` aumenta | Rate limit funcionando corretamente |
| `503` aumenta | Upstream FPGA saturado (não é falha do Node.js) |
| `api_ok_rate` cai | Node.js começou a rejeitar conexões |
| `p95 > 8000ms` | Node.js enfileirando requests |
| Erros TCP > 5% | Limite de conexões do sistema atingido |
| `500` / `502` | Bug real — investigar imediatamente |

---

### Teste de throughput de bytes

Mede bytes de entropia por segundo para diferentes tamanhos de payload e formatos.

```bash
k6 run load-tests/qrng-throughput-test.js \
  -e API_TOKEN=$API_TOKEN \
  -e BASE_URL=$BASE_URL
```

**Matriz de cenários (execução sequencial ~12 min):**

| Cenário | bytes | format | VUs | Mede |
|---|---|---|---|---|
| `32b_hex_200vus` | 32 | hex | 200 | RPS máximo / latência baseline |
| `1kb_hex_200vus` | 1 024 | hex | 200 | Impacto do payload no throughput |
| `64kb_base64_100vus` | 65 536 | base64 | 100 | Throughput médio |
| `1mib_base64_10vus` | 1 048 576 | base64 | 10 | Saturação do upstream |
| `1mib_hex_10vus` | 1 048 576 | hex | 10 | hex vs base64 (resposta 2× maior) |

**Nota crítica — bytes de entropia ≠ payload HTTP:**

`MAX_BYTES_PER_REQUEST` limita **bytes de entropia**, não o tamanho da resposta JSON:

| Format | Bytes solicitados | Payload da resposta |
|---|---|---|
| `hex` | N | ~2× N (cada byte → 2 chars) |
| `base64` | N | ~1,33× N |
| `uint8` | N | ~3-4× N (array JSON de inteiros) |

Para 1 MiB com `format=hex`: corpo JSON ≈ **2,1 MiB**.
Configure `client_max_body_size` no Nginx se necessário.

---

## Política para grandes volumes de dados

### Requisições síncronas (atual)

Adequado para até `MAX_BYTES_PER_REQUEST` bytes por chamada (padrão: 1 MiB).  
Retorna JSON em tempo real com o campo `random`.

```
GET /v1/random?bytes=1048576&format=hex
Authorization: Bearer <token>
```

Tempo típico: 100ms – 2s dependendo do upstream.

### Streaming (futuro — não implementado)

Para janelas de bytes entre 1 MiB e ~100 MiB, o endpoint retornaria um stream HTTP chunked:

```
GET /v1/random/stream?bytes=50000000&format=hex
```

O cliente consumiria os chunks progressivamente, sem precisar aguardar a resposta completa.

### Jobs assíncronos (futuro — não implementado)

Para volumes acima de 100 MiB ou quando o cliente não pode manter uma conexão aberta:

```http
# 1. Solicitar job
POST /v1/bulk-random-jobs
{ "bytes": 500000000, "format": "hex" }
→ { "job_id": "job_abc123", "status": "queued", "estimated_seconds": 120 }

# 2. Verificar status
GET /v1/bulk-random-jobs/job_abc123
→ { "status": "ready", "size_bytes": 500000000, "download_url": "..." }

# 3. Baixar resultado
GET /v1/bulk-random-jobs/job_abc123/download
→ arquivo binário ou hex com os bytes
```

Esses endpoints retornam `501 BULK_JOBS_NOT_IMPLEMENTED` até que a feature seja implementada.

---

## Monitoramento de saúde do upstream

```http
GET /v1/upstream/status
Authorization: Bearer <token>
```

Retorna:
- `current.status`: `"up"` | `"down"` | `"unknown"`
- `current.responseMs`: latência da última verificação
- `uptime_24h_pct`: porcentagem de uptime nas últimas 24h
- `recent_events`: últimas 50 transições de estado

O monitor verifica o upstream a cada 60 segundos e registra apenas transições de estado (não cada verificação individual).

---

## Banco de dados e auditoria

Todos os requests autenticados geram um registro em `api_usage_logs`:

| Campo | Tipo | Descrição |
|---|---|---|
| `request_id` | TEXT | Identificador único (`req_*`) |
| `token_id` | INTEGER | FK para `api_tokens` |
| `endpoint` | TEXT | Ex: `/v1/random` |
| `bytes_requested` | INTEGER | Bytes pedidos nesta chamada |
| `format` | TEXT | `hex`, `base64` ou `uint8` |
| `status_code` | INTEGER | HTTP status da resposta |
| `ip_address` | TEXT | IP do cliente |
| `duration_ms` | INTEGER | Tempo total da requisição |
| `created_at` | TEXT | Timestamp ISO 8601 UTC |

Consultável via `GET /v1/me/requests?limit=100` (máx. 10.000 registros).

---

## Números oficiais do piloto

| Parâmetro | Valor padrão | Nota |
|---|---|---|
| `MAX_BYTES_PER_REQUEST` | **1 MiB** (1 048 576 B) | Limite por chamada síncrona |
| `DAILY_QUOTA_BYTES` | **100 MiB/dia** por token | Ajustável via admin |
| `DAILY_QUOTA_REQUESTS` | **10 000 req/dia** por token | Ajustável via admin |
| `RATE_LIMIT_PER_TOKEN_PER_MINUTE` | **60 req/min** por token | In-memory, reseta no restart |
| `RATE_LIMIT_PER_IP_PER_MINUTE` | **120 req/min** por IP | Global, via express-rate-limit |

**Recomendações de tamanho por caso de uso:**

| Uso | bytes recomendados | Motivo |
|---|---|---|
| Demo / geração pontual | 256 B | Exibe resultado imediatamente na UI |
| Integração em API | 64 KiB | Bom equilíbrio latência × volume |
| Experimentos científicos | 1 MiB | Máximo por chamada — use em loop se precisar de mais |
| Volumes > 1 MiB | bulk jobs (501) | Ainda não implementado — use múltiplas chamadas |

---

## Observabilidade

### Liveness check (sem autenticação)

```bash
curl https://bongo.vps-uni5.net/qrng/v1/health/self
# {"status":"ok","service":"qrng-client-api","uptime_seconds":3600,...}
```

Use para Nginx `health_check`, Docker `HEALTHCHECK` e balanceadores.

### Métricas Prometheus

```bash
# Se METRICS_TOKEN não estiver configurado, sem autenticação:
curl http://localhost:3010/metrics

# Com METRICS_TOKEN configurado:
curl -H "Authorization: Bearer <METRICS_TOKEN>" http://localhost:3010/metrics
```

Métricas disponíveis:
- `qrng_requests_total{status}` — histórico completo por status HTTP
- `qrng_random_bytes_total` — bytes de entropia entregues (status=200)
- `qrng_errors_total` — erros em /v1/random
- `qrng_rate_limited_total` — rate limits desde o último restart
- `qrng_quota_exceeded_total{type}` — cotas esgotadas (`requests` ou `bytes`)
- `qrng_upstream_status` — 1=up, 0=down, -1=unknown
- `qrng_upstream_latency_ms` — latência da última verificação do upstream
- `qrng_active_tokens` — tokens ativos no banco
- `qrng_registered_users` — usuários registrados
- `qrng_process_uptime_seconds` — uptime do processo Node.js

---

## Limitações conhecidas (next steps)

1. **Rate limit por token é in-memory** — reiniciar o processo zera os contadores. Para multi-instância, migrar para Redis.
2. **Cota de bytes é global** (via env var), não configurável por token individualmente via admin.
3. **Sem streaming** — volumes acima de 1 MiB requerem múltiplas chamadas.
4. **Bulk jobs não implementados** — stubs retornam 501.
5. **SQLite com WAL** — adequado para dezenas de req/s; para centenas, avaliar migração para PostgreSQL.
