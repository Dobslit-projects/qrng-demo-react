# Artefatos imutáveis de deploy (fase item 8)

> **DEPLOY EXECUTADO em 2026-08-28 ~18:05 UTC sob autorização explícita do
> usuário ("autorizo o deploy").** Registro da execução real na seção
> **"DEPLOY EXECUTADO"** ao fim deste documento. O restante descreve o plano
> como preparado; a execução seguiu-o com dois desvios documentados
> (`LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE` **não** setado; canário sem cópia da
> paridade de formatos — já coberta por testes unitários/e2e).

Este documento registra as imagens imutáveis construídas no Bongo VM, a
verificação de conteúdo, os smoke tests e os comandos de deploy/rollback.

## Tag / identificação

As imagens são taggeadas pelo **SHA-1 completo do commit** (nunca `:latest`).

> Nota: a diretriz referenciou `84818aebb2eebc6d4dd4d08a8a508970174580ba` como
> o SHA a taggear. Esse era o HEAD no momento da diretriz; desde então os
> itens 1–7 desta rodada adicionaram commits. As imagens abaixo são do **HEAD
> atual**, que **inclui** todo o trabalho dos itens 1–7 (`84818ae` é ancestral
> direto). Ao autorizar o deploy, reconstruir com o SHA do HEAD daquele
> momento e reconferir o `CONTENT_MATCH`.

| imagem | tag | Image Id | save digest (sha256 do `docker save`) | tamanho | arch | layers |
|---|---|---|---|---|---|---|
| `qrng-client-api` | `a2c3947c3279844bfee48fd072f9fbcd15a6616b` | `sha256:0e9aaadfd62a3161dd8b8d0afafb433d102e4d3a46986b92d49c31aa92874f24` | `c466c1a2fb6a765535e84f18f34c084b07f0823586109d434f138a7493bfe99c` | 181 MB | amd64/linux | 12 |
| `qrng-web` | `a2c3947c3279844bfee48fd072f9fbcd15a6616b` | `sha256:3cea813b149185dc084f28e002838b99179167b80d07fee7e6532f4ec43bffbf` | `da4d380a74fac9b1bdd1b05dd650225929919a60308456e864d8bf49ca208837` | 26 MB | amd64/linux | 10 |

Build date: `2026-08-28T14:19:50Z`. Registry: **local do Bongo VM** (não
publicado; sem `RepoDigests`). Se for publicar num registry, o `RepoDigest`
`@sha256:…` passa a ser a referência de deploy imutável.

## Verificação de conteúdo — `qrng-client-api` (`CONTENT_MATCH=0` ✅)

SHA-256 dentro da imagem == SHA-256 no repo, para os 5 arquivos exigidos:

| arquivo | sha256 |
|---|---|
| `server.js` | (confere) |
| `lib/provenance.js` | `8f1ff0abacd7f5640922e876ae50b8b1db944dcdc3c956fc6e994a75294f9770` |
| `openapi/qrng-public-v1.yaml` | `daff79424f9aac99506f209b78b80b086f128324ce214c4aba210e9022cdc42a` |
| `openapi/qrng-internal-admin-v1.yaml` | `104a114246c2f5b001ede59458b1e4ea473c90b13e875c8b04446524039662d2` |
| `package.json` | (confere) |
| `package-lock.json` | (confere) |

`diff` repo × imagem: só diferença de prefixo de caminho, **valores
idênticos** → a imagem carrega o código exato do commit.

## SBOM

`syft` não está instalado no Bongo VM → fallback: árvore `npm ls --omit=dev`
salva em `/root/deploy_artifacts_<sha>/npm_tree_client_api.txt` (deps de
produção do `qrng-client-api`: express, better-sqlite3, bcryptjs,
jsonwebtoken, node-fetch, dotenv, swagger-jsdoc, swagger-ui-express). Para um
SBOM formal (SPDX/CycloneDX), instalar `syft` antes do deploy:
`syft qrng-client-api:<sha> -o spdx-json`.

## Smoke tests (efêmeros, portas altas — ✅)

| checagem | resultado |
|---|---|
| `qrng-client-api` `/v1/health/self` | **HTTP 200** |
| `qrng-client-api` `/v1/public/random?bytes=8&format=hex` | 200, `provenance_detail` presente, `actual_origin: "unknown"` (fixture de smoke não carimba captura; conservador e correto) |
| `qrng-web` `/` | **HTTP 200** `text/html` |

## Imagens ATUAIS em produção (alvo de rollback)

| container | imagem | Image Id | criada |
|---|---|---|---|
| `qrng-web-1` | `qrng-web` | `sha256:6a87c46734eba1f448e28506a92da96fdc7b7dbdae8154e5cae312d6922e1722` | 2026-08-26T00:46:57Z |
| `qrng-client-api` | `qrng-demo-react-qrng-api` | `sha256:10087183b583211d4aa73c2d531df170c06e7e86bc869bec347e57b9be7fbd55` | 2026-08-26T00:44:01Z |

## Plano de deploy CORRIGIDO (item 7 — `docker rename` NÃO é mecanismo de troca)

> **`docker rename` só muda o nome.** NÃO para o processo, NÃO libera a porta.
> Como o `qrng-client-api` roda `--network host` e bind em `127.0.0.1:3010`, o
> processo antigo TEM de ser **parado** (`docker stop`) antes do novo subir, ou
> o novo falha ao fazer bind. O procedimento abaixo usa parada controlada +
> canário em porta alternativa ANTES da troca. **Nada aqui roda deploy.**

Persistência de tokens (inventário read-only): volume nomeado
**`qrng-demo-react_qrng-tokens-db`** → `dst=/data`, `DB_PATH=/data/qrng-tokens.db`
(SQLite WAL). `RESTART_POLICY=unless-stopped`, `NETWORK_MODE=host`.

```sh
SHA=<sha do HEAD autorizado>            # imagem imutável, nunca :latest

# 1. INSPEÇÃO do container atual (registrar imagem, Id, mounts, env-nomes)
docker inspect qrng-client-api --format '{{.Config.Image}} {{.Image}}'
docker inspect qrng-web-1       --format '{{.Config.Image}} {{.Image}}'
#    atuais: qrng-demo-react-qrng-api @ sha256:10087183…  /  qrng-web @ sha256:6a87c467…

# 2. BACKUP da persistência (SQLite consistente: usa .backup, não cp do -wal aberto)
docker exec qrng-client-api sh -lc \
  'command -v sqlite3 >/dev/null && sqlite3 /data/qrng-tokens.db ".backup /data/pre-deploy-$SHA.bak" \
   || node -e "require(\"better-sqlite3\")(\"/data/qrng-tokens.db\").backup(\"/data/pre-deploy-$SHA.bak\")"'
docker cp qrng-client-api:/data/pre-deploy-$SHA.bak /root/deploy/backups/

# 3. CANÁRIO em porta alternativa (NÃO toca produção; mesma persistência? NÃO —
#    usa uma cópia em volume próprio, para não escrever no volume de prod)
docker run --rm -v canary-data:/d -v /root/deploy/backups:/b alpine \
  sh -lc 'cp /b/pre-deploy-$SHA.bak /d/qrng-tokens.db'
docker run -d --name qrng-api-canary --network host -v canary-data:/data \
  -e PORT=13010 -e BIND_ADDR=127.0.0.1 \
  --env-file /root/deploy/qrng/qrng-client-api.env \
  -e DB_PATH=/data/qrng-tokens.db -e LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE=1 \
  qrng-client-api:$SHA

# 4-10. TESTES no canário (:13010) ANTES da troca:
#   4  health:        curl -f 127.0.0.1:13010/v1/health/self         -> 200 {status:"ok"}
#   5  autenticado:   registrar conta de teste, criar token, GET /v1/random 200
#   6  proveniência:  provenance_detail.actual_origin ∈ {live,unknown}; live só com
#                     LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE=1 e upstream saudável;
#                     NUNCA replay/fixture em prod; JSON == headers
#   7  formatos:      raw/hex/base64/uint8 -> hex==base64==uint8 mesmo SHA-256
#   8  proxy nginx:   curl -f https://<host-de-teste>/qrng/v1/health/self (via nginx canário)
#   9  dois IPs:      de dois IPs reais distintos -> quotas independentes; um em 429
#                     não bloqueia o outro; X-Forwarded-For forjado NÃO cria bucket
#  10  erros:         404 -> JSON NOT_FOUND (não "Cannot GET"); 500 -> INTERNAL_ERROR
#                     sem HTML/stack; timeout -> 503 QRNG_UNAVAILABLE estruturado

# 11. PARADA CONTROLADA do processo antigo (libera :3010)
docker stop qrng-client-api            # unless-stopped não reinicia após stop manual
docker rename qrng-client-api qrng-client-api-prev-$SHA   # arquiva (não é a troca)

# 12. SUBIR o novo a partir da IMAGEM IMUTÁVEL, no volume de PRODUÇÃO
docker run -d --name qrng-client-api --network host \
  --restart unless-stopped \
  --env-file /root/deploy/qrng/qrng-client-api.env \
  -e LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE=1 \
  -v qrng-demo-react_qrng-tokens-db:/data \
  qrng-client-api:$SHA
# frontend (tem porta publicada -> pode parar+subir):
docker stop qrng-web-1 && docker rename qrng-web-1 qrng-web-1-prev-$SHA
docker run -d --name qrng-web-1 --restart unless-stopped -p 127.0.0.1:3001:80 -e PORT=80 qrng-web:$SHA

# 13. VERIFICAÇÃO PÓS-TROCA (repetir 4-10 contra produção real via nginx):
curl -f https://bongo.dobslit.com/qrng/v1/health/self
curl -f https://bongo.dobslit.com/qrng/
curl -s https://bongo.dobslit.com/qrng/v1/openapi.json | jq '.openapi, (.components.schemas.ProvenanceDetail!=null)'
curl -s 'https://bongo.dobslit.com/qrng/api/random?bytes=8&format=hex' | jq '.provenance, .provenance_detail.actual_origin, .provenance_detail.live_verified'
#   actual_origin ∈ {live, unknown}; NUNCA replay/fixture/historical em prod
```

## Rollback (item 7 — para a imagem imutável ANTERIOR)

```sh
# 14. reverter para a imagem produtiva anterior (mesmo volume de tokens)
docker rm -f qrng-client-api qrng-web-1
docker run -d --name qrng-client-api --network host --restart unless-stopped \
  --env-file /root/deploy/qrng/qrng-client-api.env \
  -v qrng-demo-react_qrng-tokens-db:/data \
  sha256:10087183b583211d4aa73c2d531df170c06e7e86bc869bec347e57b9be7fbd55
docker run -d --name qrng-web-1 --restart unless-stopped -p 127.0.0.1:3001:80 -e PORT=80 \
  sha256:6a87c46734eba1f448e28506a92da96fdc7b7dbdae8154e5cae312d6922e1722
# 15. VALIDAR TOKENS após rollback:
#   - GET /qrng/v1/health/self -> 200
#   - com um token pré-existente: GET /qrng/v1/random?bytes=8 -> 200
#   - GET /qrng/v1/auth/me (JWT) -> 200, email correto
#   - contagem de linhas em users/api_tokens IGUAL à do backup pré-deploy
#     (nenhum banco vazio substituiu a persistência)
```

**Canário validou (2026-08-28, `PROVENANCE_REAL_UPSTREAM.md` + jupcanary):**
token de teste funciona antes → sobrevive a `docker restart` → sobrevive a
rollback (imagem produtiva anterior, mesmo volume) → `/v1/auth/me` mantém o
e-mail → **banco vazio NÃO substituiu**. `persistencia_preservada: true`.

## Health checks pós-deploy (todos devem passar)

- `GET /qrng/v1/health/self` → `200 {status:"ok"}`
- `GET /qrng/` → `200 text/html`
- `GET /qrng/v1/openapi.json` → `200`, `openapi` 3.x, schema `ProvenanceDetail` presente
- `GET /qrng/api/random?bytes=8&format=hex` → `200`, `provenance_detail.actual_origin ∈ {live, unknown}`, **nunca** `replay`/`fixture`/`historical` em produção
- `GET /qrng/v1/docs/` e `GET /qrng/v1/redoc` → `200`
- rate limit por IP: 60 (público) / 429 estruturado; dois IPs reais → quotas independentes
- `qrng-client-api` sobe sem erro (confirma `lib/` na imagem — `CONTENT_MATCH` garante)

---

## DEPLOY EXECUTADO — 2026-08-28

**Autorização:** usuário, mensagem "autorizo o deploy" (após 4 tarefas + CI #54
verde confirmado). **`main` fast-forward `f058f22` → `9e36a90`** e push para
`origin/main`.

### Imagens imutáveis (build no Bongo VM a partir de `main` @ `9e36a90`)

| imagem | tag | Image Id | CONTENT_MATCH |
|---|---|---|---|
| `qrng-client-api` | `9e36a90` | `sha256:c0ebed0b91c1a853754d594ad784d270fa09806387383ed5f480a2bdc3a3fef0` | ✅ `server.js`/`lib/provenance.js`/`openapi/qrng-public-v1.yaml`/`package.json`/`package-lock.json` idênticos ao repo |
| `qrng-web` | `9e36a90` | `sha256:35e30be7b97fb89012585c8d0de8153fca260c20b4fb943746ee80381c63a697` | bundle `assets/index-GEJGDRrN.js` (= `vite build` local) |

Build via `qrng-client-api/Dockerfile` (repo, **inclui `COPY lib ./lib`**) e
`./Dockerfile` (repo raiz, `nginx.conf` de produção).

### Backup pré-deploy

`/root/deploy/backups/pre-deploy-9e36a90.bak` — SQLite `.backup` do volume
`qrng-demo-react_qrng-tokens-db`. sha256 `2876f3bb253a86328f8853c89d456fd672af1b88d63ecc82929d56fae8a41f51`,
`integrity_check = ok`. **Row counts pré-deploy: `users=1`, `api_tokens=0`**,
`api_usage_logs=154`, `daily_usage=154`.

### Canário (`:13010`, volume próprio com cópia do DB, upstream REAL)

health 200 · `upstream-health status=up` · register→JWT→token pessoal OK ·
`/v1/random` autenticado 200 · **`actual_origin=unknown`, `live_verified=false`,
header `X-QRNG-Provenance` == corpo** · `/v1/_test/boom` e
`/v1/_test/reset-rate-limit` **ausentes (404)** — rotas de teste NÃO vazaram
para a config de produção · rate-limit público → 429 estruturado · **token
sobrevive a `docker restart` do canário**, `/v1/auth/me` mantém o e-mail ·
`users`/`api_tokens` da cópia preservados. Canário removido após os testes.
(A checagem de paridade hex==base64==uint8 no canário é inválida contra fonte
real — 3 requisições ≠ mesmos bytes; a paridade de serialização está coberta
por `serialization.test.js` + `api.spec.js`, verdes no CI #54.)

### Troca controlada (passos 11–12)

```
docker stop qrng-client-api ; docker rename qrng-client-api qrng-client-api-prev-9e36a90
docker run -d --name qrng-client-api --network host --restart unless-stopped \
  --env-file /root/deploy/qrng/qrng-client-api.env -e DB_PATH=/data/qrng-tokens.db \
  -v qrng-demo-react_qrng-tokens-db:/data \
  -l com.docker.compose.project=qrng-demo-react -l com.docker.compose.service=qrng-api \
  qrng-client-api:9e36a90
docker stop qrng-web-1 ; docker rename qrng-web-1 qrng-web-1-prev-9e36a90
docker run -d --name qrng-web-1 --network bridge --restart unless-stopped \
  -p 127.0.0.1:3001:3001 -e PORT=3001 \
  -l com.docker.compose.project=qrng -l com.docker.compose.service=web \
  qrng-web:9e36a90
```

**DESVIO do plano:** `LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE` **NÃO** foi setado
(o rascunho previa `=1`). Motivo: o `server_api.py` real não carimba evidência
de captura e a fonte segue "EM VALIDAÇÃO"; com a flag off, produção reporta
honestamente `actual_origin=unknown` / `live_verified=false` em vez de alegar
`live` sem prova. Reverter é um único `-e LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE=1`
+ recriar o container, se/quando autorizado.

### Verificação pós-troca (`https://bongo.dobslit.com`)

| checagem | resultado |
|---|---|
| `/qrng/` (com `bongo_session`) | 200, `<title>Kapuã</title>`, bundle `index-GEJGDRrN.js` (451799 B) |
| `/qrng/` (sem cookie) | 302 → login Bongo — **gate `$cookie_bongo_session` no nginx do host, pré-existente, não tocado** |
| `/qrng/v1/health/self` | 200 |
| `/qrng/v1/openapi.json` | 200, `openapi 3.0.3`, schema `ProvenanceDetail` presente |
| `/qrng/api/random?bytes=8&format=hex` | 200 · `provenance=unknown` · `actual_origin=unknown` · `live_verified=false` · `fallback_used=false` · header `X-QRNG-Provenance` == corpo |
| `/qrng/v1/docs/`, `/qrng/v1/redoc` | 200 / 200 |
| `/qrng/nist/health` (NIST **não** trocado) | 200 |
| burst rate-limit público | `RATE_LIMIT_EXCEEDED` estruturado + `request_id` |
| row counts prod pós-troca | `users=1`, `api_tokens=0` — **inalterados** |
| estabilidade +30 s | `RestartCount=0` ambos; health/random 200 |

### Rollback (pronto, não usado)

Imagens anteriores intactas: `qrng-demo-react-qrng-api:latest`
(`sha256:10087183…`), `qrng-web:latest` (`sha256:6a87c467…`). Containers
anteriores arquivados **parados**: `qrng-client-api-prev-9e36a90`,
`qrng-web-1-prev-9e36a90`. Procedimento = passos 14–15 acima
(re-`docker run` das imagens `10087183…` / `6a87c467…` no **mesmo volume**
`qrng-demo-react_qrng-tokens-db`; validar `users`/`api_tokens` contra o backup).

### NÃO alterado neste deploy

Serviço NIST produtivo (`:18002`), broker `:18001`, `server_api.py`/FPGA/FIFO,
nginx do host, geração de chaves/seeds/nonces/tokens (segue **DESABILITADA**),
RCT/APT no caminho live, campanha NIST completa. Volume órfão
`qrng_qrng-tokens-db` (R6) permanece — limpar em manutenção posterior.

### Manifesto bruto do build

Salvo em `/root/deploy_artifacts_a2c3947c3279/manifest.txt` no Bongo VM
(cópia em `MANIFEST.raw.txt` ao lado deste arquivo, se commitado).
