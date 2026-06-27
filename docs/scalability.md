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

**Thresholds:**
- `http_req_failed < 1%` — erros de rede
- `p(95) < 3000ms` — latência de respostas bem-sucedidas
- `p(99) < 8000ms`
- `expected_status_rate > 98%` — 200/429/503 são aceitos

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

**Como interpretar:**

| Resultado | Significado |
|---|---|
| `429` aumenta | Rate limit funcionando corretamente |
| `503` aumenta | Upstream FPGA sobrecarregado (não é falha da API Node) |
| `p95 > 8000ms` | Node.js começou a enfileirar requests |
| Erros de rede > 5% | Limite de conexões TCP do sistema atingido |
| `500` / `502` | Bug ou falha de infra — investigar imediatamente |

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

## Limitações conhecidas (next steps)

1. **Rate limit por token é in-memory** — reiniciar o processo zera os contadores. Para multi-instância, migrar para Redis.
2. **Cota de bytes é global** (via env var), não configurável por token individualmente via admin.
3. **Sem streaming** — volumes acima de 1 MiB requerem múltiplas chamadas.
4. **Bulk jobs não implementados** — stubs retornam 501.
5. **SQLite com WAL** — adequado para dezenas de req/s; para centenas, avaliar migração para PostgreSQL.
6. **Sem health check próprio** — adicionar `GET /v1/health/self` (sem auth) para balanceadores.
