# Limites explícitos de corpo de requisição (item 3)

## qrng-client-api (Node/Express, produção)

### Limite escolhido: **8 KiB** (`JSON_BODY_LIMIT`, env `MAX_JSON_BODY_BYTES`)

### Derivação (não é arbitrário)

Todo endpoint que lê `req.body` neste serviço recebe **JSON pequeno**:

| endpoint | corpo | tamanho realista |
|---|---|---|
| `POST /v1/auth/register` | `{ email, password }` | e-mail ≤ 254 chars (RFC 5321) + senha (bcrypt só usa os primeiros 72 bytes; teto generoso de 256 chars) + overhead JSON ≈ **~0,6 KiB** |
| `POST /v1/auth/login` | `{ email, password }` | idem |
| `PATCH /v1/admin/tokens/:id/quota` | `{ quota_daily: <int> }` | ~30 B |
| `POST /v1/tokens`, `/v1/me/token/{rotate,revoke}` | vazio | 0 |

Maior request legítimo ≈ **0,6 KiB**. Limite = **8 KiB ≈ 13×** esse pior caso —
folga confortável para qualquer endpoint JSON pequeno futuro, e ainda pequeno o
bastante para limitar abuso de corpo. Configurável por env, com este documento
como justificativa.

### Parsers montados

| parser | montado? | limite | motivo |
|---|---|---|---|
| `express.json()` | **sim** | **8 KiB** | única forma de corpo que alguma rota lê |
| `express.urlencoded()` | **não** | — | nenhuma rota consome form-urlencoded. Não montar um parser que não se usa = menos superfície. Um corpo form/multipart não é parseado (`req.body` vazio) e a rota devolve seu 400 normal |
| `express.raw()` / `express.text()` | **não** | — | idem |
| multipart / `multer` | **não** | — | não há upload neste serviço |
| `body-parser` (pacote) | usado **transitivamente** por `express.json` | herda 8 KiB | atualizado para 1.20.6 no item 4 |

### Resposta de erro (estruturada, sem HTML/stack)

Handler de erro global no fim da cadeia (`server.js`, antes de `app.listen`):

| condição | status | corpo |
|---|---|---|
| corpo > 8 KiB (`err.type === "entity.too.large"`) | **413** | `{ request_id, error: "REQUEST_BODY_TOO_LARGE", message, limit: "8kb" }` |
| JSON inválido (`entity.parse.failed` / `SyntaxError`) | **400** | `{ request_id, error: "INVALID_JSON", message }` |
| tamanho/codificação inválidos | **400** | `{ request_id, error: "INVALID_REQUEST_BODY", message }` |
| qualquer outro erro não tratado | **500** | `{ request_id, error: "INTERNAL_ERROR", message }` — stack só no log, **nunca no corpo** |

Antes desta mudança, o default do Express em modo dev devolvia HTML com stack
trace (`PayloadTooLargeError: request entity too large` + frames) — corrigido.

### Testes (`qrng-client-api/test/body-limit.test.js`)

- corpo abaixo do limite → rota processa normal (não 413)
- corpo **exatamente** em 8192 bytes → aceito (não 413, não INVALID_JSON)
- corpo em 8193 bytes → **413** estruturado com `request_id` e `limit`
- corpo de 1 MiB → **413** (não bufferiza o corpo inteiro)
- JSON inválido → **400 INVALID_JSON**
- resposta 413 **sem** `<html>`, `<pre>`, stack trace (`at fn (file:line:col)`), nem `PayloadTooLargeError`
- `Content-Length` menor que o enviado → 400/413 (nunca 200 com corpo completo)
- `Transfer-Encoding: chunked` acima do limite → **413** (o limite vale para chunked)
- `POST /v1/nist/upload` → **404** (não existe rota de upload aqui)

## Upload NIST — política SEPARADA (serviço FastAPI, `:18002`)

O upload de arquivos de amostras para a suíte NIST SP 800-90B **não passa** pelo
qrng-client-api. O frontend (`nistUpload` em `src/qrngApi.js`) envia `multipart/
form-data` para `/qrng/nist/` → nginx → **FastAPI em `:18002`**
(`nist_service.py`).

Requisitos do limite de upload NIST (a implementar no **serviço NIST de
staging**, item 6 — **não** tocar o NIST produtivo agora):

| item | valor proposto | justificativa |
|---|---|---|
| tamanho máximo do upload | **128 MiB** | uma avaliação SP 800-90B non-IID típica usa ≥ 1.000.000 de amostras; em `.bin` uint32 isso são ~4 MiB, mas arquivos históricos de captura contínua (ex.: `numbers_qrng_*.txt`) chegam a dezenas de MiB. 128 MiB cobre com folga e ainda é um teto. |
| tipos aceitos | `.bin`, `.txt`, `.csv` (allowlist explícita) | evita processar formatos não suportados |
| streaming para disco | sim — nunca carregar o upload inteiro em memória (FastAPI `UploadFile` já faz spooled temp file) | um limite de 128 MiB em memória por request seria um vetor de OOM |
| resposta ao exceder | **413** JSON estruturado (`{ error, message, limit_bytes }`), mesmo padrão do client-api | consistência |
| quota / rate limit | por IP, separado do client-api | o upload é caro (roda o assessment) |

Isto fica **documentado como requisito**; a implementação e os testes
(`.bin`/`.txt`/`.csv`, no limite / acima / tipo inválido, metadados de
proveniência) entram na seção do serviço NIST de staging.
