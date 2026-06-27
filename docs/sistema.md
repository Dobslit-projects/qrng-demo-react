# Documentação do Sistema — QRNG Demo

Documentação completa do portal de demonstração do QRNG Dobslit/UFPE/FPGA.

---

## 1. Visão geral

O sistema expõe bytes aleatórios produzidos por um dispositivo FPGA (Dobslit/UFPE) via uma API REST autenticada por token. Um portal React permite que desenvolvedores criem conta, gerem token e testem a API interativamente.

```
Usuário → Nginx → Docker (React SPA) → /qrng/
Usuário → Nginx → Node.js API (port 3010) → /qrng/v1/
Node.js API → FPGA upstream (port 18001)
```

**URL de produção:** `https://bongo.vps-uni5.net/qrng/`

---

## 2. Arquitetura

### Componentes

| Componente | Tecnologia | Localização |
|---|---|---|
| Frontend SPA | React 19 + Vite 7 | Docker container `web` |
| API backend | Express.js (Node.js) | systemd `qrng-client-api` |
| Banco de dados | SQLite 3 (WAL mode) | `/root/projects/qrng-demo-react/qrng-client-api/qrng-tokens.db` |
| Upstream FPGA | HTTP (protocolo proprietário) | `http://127.0.0.1:18001` |
| Proxy reverso | Nginx | `/etc/nginx/sites-enabled/` |

### Servidor

- **Host:** `root@189.126.105.45`
- **Projeto:** `/root/projects/qrng-demo-react/`
- **Branch de produção:** `main`
- **Branch de desenvolvimento:** `master` (GitHub)

### Fluxo de deploy

```bash
# 1. Desenvolver e commitar em master
git push origin master

# 2. No servidor: cherry-pick para main
ssh root@189.126.105.45
cd /root/projects/qrng-demo-react
git fetch origin master
git cherry-pick origin/master

# 3. Reiniciar API
systemctl restart qrng-client-api

# 4. Rebuildar frontend
docker compose build web && docker compose up -d web
```

---

## 3. Banco de dados

Arquivo: `qrng-client-api/qrng-tokens.db`

### Tabelas

#### `users`
| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | INTEGER PK | Auto-incremento |
| `email` | TEXT UNIQUE | Email do usuário (lowercase) |
| `password_hash` | TEXT | bcrypt, 12 rounds |
| `role` | TEXT | `'user'` ou `'admin'` |
| `created_at` | TEXT | ISO 8601 UTC |

#### `api_tokens`
| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | INTEGER PK | |
| `user_id` | INTEGER | FK → `users.id` |
| `token_prefix` | TEXT | Primeiros 28 chars do token |
| `token_hash` | TEXT UNIQUE | SHA-256 do token completo |
| `name` | TEXT | Nome do token (padrão: "Token principal") |
| `status` | TEXT | `'active'` ou `'revoked'` |
| `quota_daily` | INTEGER | Cota diária em requests (por token) |
| `created_at` | TEXT | |
| `last_used_at` | TEXT | |
| `revoked_at` | TEXT | |

#### `api_usage_logs`
| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | INTEGER PK | |
| `request_id` | TEXT | Identificador único `req_<16 hex chars>` |
| `token_id` | INTEGER | FK → `api_tokens.id` |
| `endpoint` | TEXT | Ex: `/v1/random` |
| `bytes_requested` | INTEGER | Bytes pedidos na chamada |
| `format` | TEXT | `hex`, `base64` ou `uint8` |
| `status_code` | INTEGER | HTTP status retornado |
| `ip_address` | TEXT | IP do cliente |
| `user_agent` | TEXT | User-Agent do cliente |
| `duration_ms` | INTEGER | Tempo total da requisição |
| `created_at` | TEXT | |

#### `daily_usage`
| Coluna | Tipo | Descrição |
|---|---|---|
| `token_id` | INTEGER | FK → `api_tokens.id` |
| `date` | TEXT | `YYYY-MM-DD` UTC |
| `requests_count` | INTEGER | Total de requests no dia |
| `bytes_count` | INTEGER | Total de bytes no dia |
| `errors_count` | INTEGER | Total de erros (status >= 400) no dia |

**Constraint:** `UNIQUE(token_id, date)` — upsert atômico por dia.

#### `upstream_health_log`
| Coluna | Tipo | Descrição |
|---|---|---|
| `status` | TEXT | `'up'` ou `'down'` |
| `response_ms` | INTEGER | Latência da verificação |
| `detail` | TEXT | Mensagem de erro (se down) |
| `checked_at` | TEXT | |

Registra apenas **transições** de estado (não cada verificação). Limite: 500 eventos mais recentes.

---

## 4. API REST

Base URL de produção: `https://bongo.vps-uni5.net/qrng/v1`

### Autenticação

Todos os endpoints (exceto `/auth/register` e `/auth/login`) requerem autenticação via header:

```
Authorization: Bearer <token>
```

Dois tipos de token são aceitos conforme o endpoint:

| Tipo | Formato | Usado em |
|---|---|---|
| **JWT** | `eyJ...` (30 dias de validade) | `/v1/auth/me`, `/v1/me/*`, `/v1/admin/*`, `/v1/tokens` |
| **API token** | `dobslit_qrng_live_<40 hex>` | `/v1/random`, `/v1/health` |
| **Dual auth** | Qualquer dos dois | `/v1/me/*`, `/v1/upstream/status` |

O API token é armazenado apenas como SHA-256 no banco. O valor completo é exibido somente no momento da criação.

---

### Códigos de erro

Todos os erros retornam JSON com os campos `request_id`, `error` (SCREAMING_SNAKE_CASE) e `message`.

| HTTP | `error` | Causa |
|---|---|---|
| 400 | `MISSING_FIELDS` | Campos obrigatórios ausentes no body |
| 400 | `WEAK_PASSWORD` | Senha com menos de 8 caracteres |
| 400 | `INVALID_QUOTA` | Valor de cota inválido |
| 401 | `MISSING_TOKEN` | Header `Authorization` ausente |
| 401 | `SESSION_EXPIRED` | JWT expirado ou inválido |
| 401 | `INVALID_CREDENTIALS` | Email ou senha incorretos |
| 401 | `UNAUTHORIZED` | Token ou sessão inválidos |
| 403 | `FORBIDDEN` | Ação restrita a administradores |
| 403 | `INVALID_TOKEN` | API token inválido ou revogado |
| 404 | `USER_NOT_FOUND` | Usuário não encontrado |
| 404 | `NOT_FOUND` | Recurso não encontrado |
| 404 | `NO_TOKEN` | Nenhum token ativo para revogar/rotacionar |
| 409 | `EMAIL_TAKEN` | E-mail já cadastrado |
| 409 | `TOKEN_EXISTS` | Token ativo já existe para este usuário |
| 413 | `REQUEST_TOO_LARGE` | `bytes` excede `MAX_BYTES_PER_REQUEST` |
| 422 | `INVALID_BYTES` | `bytes` não é inteiro positivo |
| 422 | `INVALID_FORMAT` | `format` não é `hex`, `base64` ou `uint8` |
| 429 | `RATE_LIMIT_EXCEEDED` | Limite por token/min atingido |
| 429 | `QUOTA_EXCEEDED` | Cota diária de requests esgotada |
| 429 | `QUOTA_BYTES_EXCEEDED` | Cota diária de bytes esgotada |
| 501 | `BULK_JOBS_NOT_IMPLEMENTED` | Endpoint de jobs em lote ainda não disponível |
| 502 | `UPSTREAM_ERROR` | Upstream retornou status de erro |
| 503 | `QRNG_UNAVAILABLE` | Upstream FPGA indisponível ou timeout |
| 503 | `INSUFFICIENT_ENTROPY` | Upstream retornou bytes insuficientes |

**Nota:** `request_id` está presente em **todas** as respostas de `/v1/random` e `/v1/health`, incluindo erros de auth (401, 403) e de middleware (413, 422, 429). Isso é garantido pelo middleware `attachRequestId` que executa como **primeiro middleware da rota**, antes inclusive de `requireToken`.

---

### Endpoints de autenticação

#### `POST /v1/auth/register`

Cria nova conta. O e-mail configurado em `ADMIN_EMAIL` recebe automaticamente `role=admin`.

```json
// Body
{ "email": "user@example.com", "password": "minimo8chars" }

// Response 200
{ "token": "<jwt>", "email": "user@example.com", "role": "user" }
```

#### `POST /v1/auth/login`

```json
// Body
{ "email": "user@example.com", "password": "..." }

// Response 200
{ "token": "<jwt>", "email": "user@example.com", "role": "user" }
```

#### `GET /v1/auth/me`

Requer JWT. Retorna dados do usuário logado.

```json
{ "id": 1, "email": "user@example.com", "role": "user", "created_at": "..." }
```

---

### Endpoints de token

#### `POST /v1/tokens`

Requer JWT. Cria o API token do usuário. Cada conta pode ter no máximo um token ativo.

```json
// Response 200
{
  "message": "Token criado. Guarde-o agora — não será exibido novamente.",
  "token": "dobslit_qrng_live_<40 hex chars>",
  "prefix": "dobslit_qrng_live_<12>",
  "created_at": "..."
}
```

#### `GET /v1/me/token`

Dual auth. Retorna informações do token ativo (sem o valor completo).

```json
{
  "has_token": true,
  "token_prefix": "dobslit_qrng_live_f9a9...",
  "name": "Token principal",
  "status": "active",
  "quota_daily": 1000,
  "requests_today": 42,
  "bytes_today": 131072,
  "created_at": "...",
  "last_used_at": "..."
}
```

#### `POST /v1/me/token/rotate`

Dual auth. Revoga o token atual e cria um novo (mesma cota).

```json
// Response 200
{
  "message": "Token regenerado. Guarde-o agora — não será exibido novamente.",
  "token": "dobslit_qrng_live_<novo>",
  "prefix": "...",
  "created_at": "..."
}
```

#### `POST /v1/me/token/revoke`

Dual auth. Revoga o token permanentemente.

```json
{ "message": "Token revogado com sucesso.", "revoked_at": "..." }
```

---

### Endpoints de uso e logs

#### `GET /v1/me/usage`

Dual auth. Retorna estatísticas completas do token com cotas e campos `remaining_*`.

```json
{
  "has_token": true,
  "token_name": "Token principal",
  "status": "active",
  "quota_daily_requests": 1000,
  "quota_daily_bytes": 104857600,
  "max_bytes_per_request": 1048576,
  "requests_today": 42,
  "bytes_today": 131072,
  "remaining_requests_today": 958,
  "remaining_bytes_today": 104726528,
  "requests_7d": 310,
  "bytes_7d": 983040,
  "requests_30d": 1200,
  "bytes_30d": 3932160,
  "last_used_at": "...",
  "daily_history": [
    { "date": "2026-06-27", "requests_count": 42, "bytes_count": 131072, "errors_count": 0 }
  ]
}
```

#### `GET /v1/me/requests?limit=20`

Dual auth. Retorna log de chamadas recentes. Máximo: 10 000 por requisição.

```json
{
  "requests": [
    {
      "request_id": "req_a1b2c3d4e5f6g7h8",
      "endpoint": "/v1/random",
      "bytes_requested": 32,
      "format": "hex",
      "status_code": 200,
      "ip_address": "...",
      "duration_ms": 847,
      "created_at": "..."
    }
  ]
}
```

---

### Endpoint principal — bytes aleatórios

#### `GET /v1/random`

Requer API token. Retorna bytes quânticos aleatórios do FPGA.

**Parâmetros:**

| Parâmetro | Tipo | Padrão | Descrição |
|---|---|---|---|
| `bytes` | integer | `32` | Quantidade de bytes (1 – `MAX_BYTES_PER_REQUEST`) |
| `format` | string | `hex` | Formato de saída: `hex`, `base64` ou `uint8` |

**Cadeia de middlewares:**

```
attachRequestId → requireToken → checkTokenRate → parseBytes → checkQuota → handler
```

`attachRequestId` é o **primeiro** middleware: gera `req.requestId = "req_<16 hex>"` antes de qualquer validação. Todos os erros subsequentes — incluindo 401 (token ausente), 403 (token inválido), 429, 422, 413 e 503 — incluem o campo `request_id`.

**Sobre o tamanho do payload de resposta:**

`MAX_BYTES_PER_REQUEST` limita **bytes de entropia**, não o payload HTTP final. O tamanho da resposta JSON varia conforme o formato:

| Formato | Bytes de entropia | Payload aproximado |
|---|---|---|
| `hex` | N bytes | ~2× N (1 byte → 2 chars hex) + JSON overhead |
| `base64` | N bytes | ~1,33× N + JSON overhead |
| `uint8` | N bytes | ~3-4× N (array de inteiros em texto JSON) |

Para `bytes=1048576` (1 MiB) com `format=hex`, o corpo da resposta será **~2,1 MiB**. Para `format=base64`, **~1,4 MiB**. Planeje `MAX_RESPONSE_PAYLOAD_BYTES` separado se houver restrição de payload no proxy.

**Response 200:**

```json
{
  "request_id": "req_a1b2c3d4e5f6g7h8",
  "source": "dobslit-qrng-ufpe-fpga",
  "bytes": 32,
  "format": "hex",
  "random": "e3f1a2b4...",
  "timestamp": "2026-06-27T14:00:00.000Z"
}
```

**Response 413 (bytes muito grandes):**

```json
{
  "request_id": "req_...",
  "error": "REQUEST_TOO_LARGE",
  "message": "Maximum allowed size is 1048576 bytes per request.",
  "max_bytes_per_request": 1048576
}
```

**Response 429 (cota esgotada):**

```json
{
  "request_id": "req_...",
  "error": "QUOTA_BYTES_EXCEEDED",
  "message": "Cota diária de 104857600 bytes atingida. Resetará à meia-noite UTC.",
  "quota_daily_bytes": 104857600,
  "bytes_today": 104857568,
  "bytes_requested": 32
}
```

---

#### `GET /v1/health`

Requer API token. Verifica status do upstream FPGA.

```json
{
  "request_id": "req_...",
  "status": "ok",
  "api": "dobslit-qrng-client-api",
  "source": "ufpe-fpga",
  "upstream": { ... }
}
```

#### `GET /v1/upstream/status`

Dual auth. Retorna histórico de saúde do upstream.

```json
{
  "current": { "status": "up", "checkedAt": "...", "responseMs": 120 },
  "uptime_24h_pct": 98.7,
  "recent_events": [...]
}
```

---

### Endpoints administrativos

Requerem JWT com `role=admin`.

#### `GET /v1/admin/tokens`

Lista todos os tokens com uso do dia.

#### `POST /v1/admin/tokens/:id/revoke`

Revoga qualquer token.

#### `PATCH /v1/admin/tokens/:id/quota`

Ajusta cota diária de requests de um token específico.

```json
// Body
{ "quota_daily": 50000 }
```

#### `GET /v1/admin/users`

Lista todos os usuários cadastrados.

---

### Bulk jobs (stubs)

Os endpoints abaixo existem mas retornam `501 BULK_JOBS_NOT_IMPLEMENTED`. Foram criados como contrato da API para implementação futura.

```
POST /v1/bulk-random-jobs
GET  /v1/bulk-random-jobs/:job_id
GET  /v1/bulk-random-jobs/:job_id/download
```

---

## 5. Variáveis de ambiente

Configuradas no systemd `/etc/systemd/system/qrng-client-api.service` em produção. Para desenvolvimento local, usar `.env` baseado em `qrng-client-api/.env.example`.

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3010` | Porta do servidor Express |
| `QRNG_UPSTREAM` | `http://127.0.0.1:18001` | URL do upstream FPGA |
| `DB_PATH` | `./qrng-tokens.db` | Caminho do banco SQLite |
| `JWT_SECRET` | `(aleatório)` | Chave para assinar JWTs — **deve ser fixo em produção** |
| `ADMIN_EMAIL` | `""` | E-mail que recebe `role=admin` no registro |
| `MAX_BYTES_PER_REQUEST` | `1048576` | Limite por requisição (1 MiB) |
| `RATE_LIMIT_PER_IP_PER_MINUTE` | `120` | Req/min por IP (global) |
| `RATE_LIMIT_PER_TOKEN_PER_MINUTE` | `60` | Req/min por token (in-memory) |
| `DAILY_QUOTA_REQUESTS` | `10000` | Cota diária padrão para novos tokens |
| `DAILY_QUOTA_BYTES` | `104857600` | Cota diária em bytes (100 MiB, global) |
| `QRNG_REQUEST_TIMEOUT_MS` | `10000` | Timeout para chamada ao upstream FPGA |

---

## 6. Frontend (React SPA)

### Estrutura de rotas

O frontend não usa React Router. A navegação entre seções é controlada por `AppContext` com uma chave `activeTab`.

```
/ → App.jsx
  ├── HomeSection        (tab: 'home') — apresentação pública
  ├── LiveStreamSection  (tab: 'live') — stream ao vivo de bits
  ├── DemoSection        (tab: 'demo') — demonstrações interativas
  └── DeveloperPage      (tab: 'developer') — área autenticada
        ├── AuthPage         — login / cadastro (sem JWT)
        ├── TokenCard        — criação, rotação e revogação de token
        ├── UsageCard        — cotas e estatísticas (barras de progresso)
        ├── RequestLogsTable — log de chamadas com duration_ms
        ├── NotebookPage     — testes interativos (área do desenvolvedor)
        └── AdminPage        — gestão de tokens e usuários (role=admin)
```

### Autenticação no frontend

O JWT é armazenado em `localStorage` com a chave `qrng_auth_jwt`.

1. `DeveloperPage` monta → chama `authMe()` com o JWT armazenado
2. Se JWT inválido/ausente → exibe `AuthPage` (login/cadastro)
3. Após login/cadastro → JWT salvo → `DeveloperPage` carrega dados
4. Tab "Admin" visível apenas se `user.role === 'admin'`
5. Logout: apaga `qrng_auth_jwt` e `qrng_api_token` do localStorage

### Funções de API (`src/qrngApi.js`)

```javascript
// Auth
authRegister(email, password) → POST /v1/auth/register
authLogin(email, password)    → POST /v1/auth/login
authMe()                      → GET  /v1/auth/me

// Token management (usa JWT via devFetch)
devCreateToken()  → POST /v1/tokens
devGetToken()     → GET  /v1/me/token
devRotateToken()  → POST /v1/me/token/rotate
devRevokeToken()  → POST /v1/me/token/revoke

// Usage and logs
devGetUsage()           → GET /v1/me/usage
devGetRequests(limit)   → GET /v1/me/requests
devGetUpstreamStatus()  → GET /v1/upstream/status

// Admin
adminGetTokens()             → GET   /v1/admin/tokens
adminRevokeToken(id)         → POST  /v1/admin/tokens/:id/revoke
adminSetQuota(id, quota)     → PATCH /v1/admin/tokens/:id/quota
adminGetUsers()              → GET   /v1/admin/users
```

---

## 7. Testes

### Testes de integração

```bash
# Roda no servidor Linux (better-sqlite3 requer binário nativo)
cd qrng-client-api
node --test test/api.test.js
```

O arquivo `test/api.test.js` usa `node:test` + `supertest`. Cria um banco SQLite temporário isolado a cada execução.

**Cobertura:**
- Auth: registro, login, email duplicado, senha fraca, JWT inválido
- Tokens: criação, duplicata, dual auth (JWT e API token)
- Cotas: `QUOTA_EXCEEDED` e `QUOTA_BYTES_EXCEEDED` com `request_id`
- Bytes: 422 para 0/-1/abc/1.5, 413 para valores acima de 1 MiB
- `request_id` presente em 200, 422, 413, 503 e 429
- Bulk stubs: 501 com `BULK_JOBS_NOT_IMPLEMENTED`
- Admin: 403 para usuário comum, 200 para admin
- Rotação e revogação de tokens

### Testes de carga (k6)

```bash
export API_TOKEN="dobslit_qrng_live_..."
export BASE_URL="https://bongo.vps-uni5.net/qrng/v1"

# Boundary: valida 422/413/200 para todos os edge cases
k6 run load-tests/qrng-boundary-test.js -e API_TOKEN=$API_TOKEN -e BASE_URL=$BASE_URL

# Load: 10 → 50 → 100 → 200 VUs simultâneos (~7 min)
k6 run load-tests/qrng-load-test.js -e API_TOKEN=$API_TOKEN -e BASE_URL=$BASE_URL

# Stress: 100 → 300 → 600 → 1000 VUs (~15 min)
k6 run load-tests/qrng-stress-test.js -e API_TOKEN=$API_TOKEN -e BASE_URL=$BASE_URL
```

Para instalar k6, ver `docs/scalability.md`.

---

## 8. Infraestrutura de produção

### Systemd — API Node.js

```
/etc/systemd/system/qrng-client-api.service
```

```bash
systemctl status qrng-client-api
systemctl restart qrng-client-api
journalctl -u qrng-client-api -f   # logs em tempo real
```

### Docker — Frontend React

```bash
cd /root/projects/qrng-demo-react
docker compose ps                        # status
docker compose logs web -f               # logs
docker compose build web && docker compose up -d web  # rebuild
```

### Nginx

Configuração em `/etc/nginx/sites-enabled/`. Roteia:
- `/qrng/` → Docker container (React SPA)
- `/qrng/v1/` → `localhost:3010` (API Node.js)

```bash
nginx -t               # testa configuração
systemctl reload nginx # aplica sem downtime
```

---

## 9. Limitações conhecidas e roadmap

| Limitação | Impacto | Solução futura |
|---|---|---|
| Rate limit por token é in-memory | Zera ao reiniciar; **não escala horizontalmente** (múltiplas instâncias contam separado) | Redis com `INCR`/`EXPIRE` — primeiro passo antes de escalar |
| Cota de bytes é global (env var) | Não configurável por token individualmente | Coluna `quota_daily_bytes` em `api_tokens` |
| Sem streaming HTTP chunked | Volumes > 1 MiB requerem múltiplas chamadas | `GET /v1/random/stream` |
| Bulk jobs não implementados | 501 para POST/GET em `/v1/bulk-random-jobs` | Implementar fila de jobs assíncronos |
| SQLite (WAL mode) | Adequado para ~50 req/s sustentados; **cada request gera log + upsert em `daily_usage`** — gargalo pode aparecer antes dos 200 VUs | PostgreSQL para persistência; Redis para cotas/rate-limit em memória; fila assíncrona para logs |
| `MAX_BYTES_PER_REQUEST` limita entropia, não payload | Para `format=hex`, a resposta HTTP pode ser 2× maior que o limite (ex.: 1 MiB → ~2,1 MiB) | Adicionar `MAX_RESPONSE_PAYLOAD_BYTES`; ou limitar `bytes` dinamicamente por formato |
| Sem health check próprio | Balanceadores não conseguem verificar liveness da API sem um token válido | `GET /v1/health/self` sem auth |
| Sem renovação automática de JWT | JWT de 30 dias; usuário precisa logar novamente ao expirar | Refresh token com expiração curta |

---

## 10. Segurança

- **Senhas:** bcrypt com 12 rounds
- **JWTs:** HS256, expiração de 30 dias, secret configurável via `JWT_SECRET`
- **API tokens:** armazenados apenas como SHA-256; valor em texto claro exibido apenas uma vez
- **Rate limiting:** por IP (global, via express-rate-limit) e por token (in-memory)
- **CORS:** `Access-Control-Allow-Origin: *` — adequado para API pública de demonstração
- **SQLite WAL:** leituras e escritas simultâneas sem locks extensos
- **SQL injection:** impossível — uso exclusivo de prepared statements (`better-sqlite3`)
- **Validação de entrada:** middleware `parseBytes` rejeita com 422/413 antes de alocar qualquer buffer

---

## 11. Histórico de versões

| Data | Funcionalidade |
|---|---|
| 2026-06 (Meta 3) | Área do desenvolvedor: gestão de tokens QRNG |
| 2026-06 | Sistema de autenticação JWT (login/cadastro por e-mail) |
| 2026-06 | Melhorias de escalabilidade: validação 413/422, cotas por bytes, `request_id` universal, `duration_ms`, timeout configurável, barras de cota no frontend, testes k6 |
