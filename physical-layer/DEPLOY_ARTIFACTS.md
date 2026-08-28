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

## Comandos de deploy (SÓ sob autorização — nada aqui roda deploy)

```sh
SHA=<sha do HEAD autorizado>
# 1. reconstruir e reconferir CONTENT_MATCH (run-artifacts.sh)
# 2. preservar os containers atuais pelo nome:
docker rename qrng-client-api qrng-client-api-prev
docker rename qrng-web-1     qrng-web-1-prev
# 3. subir a partir da TAG IMUTÁVEL (nunca :latest, nunca rsync parcial):
docker run -d --name qrng-client-api --network host \
  --env-file /root/deploy/qrng/qrng-client-api.env \
  -e LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE=1 \
  -v qrng-client-api-data:/data  qrng-client-api:$SHA
docker run -d --name qrng-web-1 -p 127.0.0.1:3001:80 -e PORT=80  qrng-web:$SHA
```

## Rollback

```sh
docker rm -f qrng-client-api qrng-web-1
docker rename qrng-client-api-prev qrng-client-api ; docker start qrng-client-api
docker rename qrng-web-1-prev     qrng-web-1       ; docker start qrng-web-1
# alvos: qrng-web sha256:6a87c467… / qrng-demo-react-qrng-api sha256:10087183…
```

## Health checks pós-deploy (todos devem passar)

- `GET /qrng/v1/health/self` → `200 {status:"ok"}`
- `GET /qrng/` → `200 text/html`
- `GET /qrng/v1/openapi.json` → `200`, `openapi` 3.x, schema `ProvenanceDetail` presente
- `GET /qrng/api/random?bytes=8&format=hex` → `200`, `provenance_detail.actual_origin ∈ {live, unknown}`, **nunca** `replay`/`fixture`/`historical` em produção
- `GET /qrng/v1/docs/` e `GET /qrng/v1/redoc` → `200`
- `qrng-client-api` sobe sem erro (confirma que `lib/` está na imagem — o
  `CONTENT_MATCH` já garante)

---

### Manifesto bruto do build

Salvo em `/root/deploy_artifacts_a2c3947c3279/manifest.txt` no Bongo VM
(cópia em `MANIFEST.raw.txt` ao lado deste arquivo, se commitado).
