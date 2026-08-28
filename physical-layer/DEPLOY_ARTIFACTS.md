# Artefatos imutáveis de deploy (fase item 8)

**Nenhum deploy foi feito.** Este documento registra as imagens imutáveis
construídas no Bongo VM, a verificação de conteúdo, os smoke tests e os
comandos de deploy/rollback — para execução **somente sob autorização** e
**fora desta rodada** (condição de parada).

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

### Manifesto bruto do build

Salvo em `/root/deploy_artifacts_a2c3947c3279/manifest.txt` no Bongo VM
(cópia em `MANIFEST.raw.txt` ao lado deste arquivo, se commitado).
