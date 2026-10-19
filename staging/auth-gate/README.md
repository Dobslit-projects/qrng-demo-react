# Ambiente de teste do gate de autorização do QRNG (doc 155 §1.3)

Projeto Docker Compose **`kapua-authgate`**, isolado. Ele testa, **através do nginx com a
configuração de produção já corrigida**, o gate por serviço (`/_bongo_authz_qrng`), a
identidade integrada (sessão do portal na client-api), o vínculo de contas legadas, a
recuperação de senha (estado da fila de e-mail) e o comportamento com o Bongo fora do ar.

Nada de produção é usado: segredos só de teste (gerados por `up.sh` em `.env`), bancos em
volumes próprios, `MAIL_TRANSPORT=simulated`, e backends numa rede `internal: true` (sem
saída para a internet). Só o nginx publica porta, em `127.0.0.1:18180`.

## Composição

| serviço | origem | papel |
|---|---|---|
| `nginx` | `nginx:1.24` (mesma série da VM) | `nginx/rendered/default.conf` = **produção + `apply_nginx_authz.py`**, adaptada por `render-nginx.py` (só HTTP :80, nomes de serviço no lugar de `127.0.0.1:PORTA`, logs em stdout). Zonas: `kuapoa-limits` com a de jobs do NIST relaxada (2r/m → 6000r/m) porque `limit_req` roda antes do `auth_request`. |
| `bongosite-auth` | build de `${BONGO_AUTH_DIR:-../../../Bongo/bongosite-wt-auth/back/auth-api}` | Bongo real (branch `feature/auth-identity-email-20261018`). Admin semeado `admin@dobslit.com` com `ADMIN_SEED_PASSWORD` do `.env`. |
| `qrng-client-api` | build de `../../qrng-client-api` | client-api real. `BONGO_INTERNAL_URL=http://bongosite-auth:3002`, `PORTAL_INTROSPECTION_CACHE_MS=0`. |
| `fixture-upstream` | build de `../fixture-upstream` | broker de replay determinístico (`/stream`). |
| `stubs` | `node:20-alpine` + `stubs/stubs.mjs` | SPA do QRNG (:3001), NIST (:18002: `/health`, `POST /nist/{run,upload}`), front do portal (:8081) e demais apps (:8099). `stubs/edu/` é o `/var/www/edu/`. |

O caminho padrão do Bongo é relativo a este diretório:
`staging/auth-gate` → `../../..` = `PROJETOS DE DESENVOLVIMENTO` → `Bongo/bongosite-wt-auth/back/auth-api`
(conferido por `check-config.sh`). Para outro checkout: `export BONGO_AUTH_DIR=/caminho/back/auth-api`.

## Comandos

O Docker desta máquina roda **dentro do WSL**; o Node (run-matrix) roda no Windows. A porta
publicada no WSL (`127.0.0.1:18180`) é acessível pelo Windows.

```bash
# Git Bash, a partir de qualquer diretório
AG="/mnt/c/Users/diego/Desktop/PROJETOS DE DESENVOLVIMENTO/qrng-wt-auth/staging/auth-gate"

# 0) verificações offline: render --check, nginx -t da config renderizada, compose config
MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash "$AG/check-config.sh"

# 1) subir (gera .env com segredos de teste, renderiza o nginx, build, up --wait)
MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash "$AG/up.sh"

# 2) matriz (Node 20+, sem dependências) — sai com código ≠ 0 em qualquer FAIL
cd "/c/Users/diego/Desktop/PROJETOS DE DESENVOLVIMENTO/qrng-wt-auth/staging/auth-gate"
AUTHGATE_DOCKER="wsl -d Ubuntu -- docker" node run-matrix.mjs

# 3) derrubar (remove volumes e o .env)
MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash "$AG/down.sh"
```

Num Linux com Docker local: `bash up.sh && node run-matrix.mjs && bash down.sh`.

Opções do run-matrix: `--skip-bongo-down` (não para o `bongosite-auth`). Variáveis:
`AUTHGATE_PORT` (padrão 18180), `AUTHGATE_DOCKER` (prefixo do CLI do Docker).

Reexecutar na mesma stack funciona (e-mails únicos por execução), mas os limitadores em
memória do Bongo (cadastro 20/h por IP, recuperação 10/15 min por IP) cabem ~3 execuções por
hora; para zerar: `down.sh` + `up.sh`.

## O que a matriz verifica

Identidades: sem sessão, cookie vazio, cookie lixo, assinatura falsa, JWT expirado (assinado
com o segredo de teste), `pending`, usuário sem `qrng`, usuário com `qrng`, admin, conta
desabilitada (JWT antigo revogado; novo login → 403 `ACCOUNT_DISABLED`).

| rota (pelo nginx) | sem sessão / inválido / expirado | desabilitado | pending / sem qrng | com qrng / admin |
|---|---|---|---|---|
| `/qrng/`, `/qrng/assets/…` | 302 `/?redirect=…` | 302 `/cards?acesso=qrng` | 302 `/cards?acesso=qrng` | 200 (SPA) |
| `/qrng/api{,-fpga}/stream` | 401 JSON `UNAUTHORIZED` | 403 JSON `FORBIDDEN` | 403 JSON `FORBIDDEN` | 200 bytes |
| `/qrng/nist/health`, `POST /qrng/nist/nist/run` | 401 JSON | 403 JSON | 403 JSON | 200 JSON |
| `/redefinir-senha`, `/redefinir-senha-api` (páginas públicas) | 200 (front do portal) | 200 | 200 | 200 |
| `/edu/` (inalterado: só sessão) | 302 `/?redirect=/edu/` | 302 `/?redirect=/edu/` | 200 | 200 |

Conta desabilitada está **fixada** no comportamento de §1.1: o `authorize` responde 403
`ACCOUNT_DISABLED` (o Bongo devolve `disabled` antes da revogação e o mapeia para 403),
então página → `/cards?acesso=qrng` e APIs → 403 JSON `FORBIDDEN`. Só `/edu/`, que usa o
`requireAuth` (§1.2: 401 `ACCOUNT_DISABLED`), vai para o login. Se a decisão de desenho
mudar, a expectativa muda explicitamente na matriz (não se aceita "um ou outro"). O nginx emite o 302 com
`Location` absoluto (`absolute_redirect on`); a matriz compara o caminho e exige o mesmo host.

APIs nunca respondem HTML nem redirecionam. Além disso:

- **públicos inalterados**: `/qrng/api{,-fpga}/random`, `/qrng/api{,-fpga}/health`,
  `/qrng/v1/public/health`, `/qrng/v1/openapi.json`, catch-all 404 de `/qrng/api/`, `/`, `/cards`, `/dobflight/`,
  e as páginas de redefinição `/redefinir-senha` e `/redefinir-senha-api` (o patch do nginx recusa
  alterar `location /` e o smoke pós-reload exige 200 nelas);
- **limites**: rajada em `/qrng/nist/nist/run` → 429 JSON `RATE_LIMIT_EXCEEDED`;
- **bordas internas**: `/api/internal/v1/{introspect,mail,mail/cancel}` e `/qrng/v1/internal/v1/…` → 404 **do
  nginx** (mensagem `Rota nao exposta.`) mesmo com o `INTERNAL_SERVICE_TOKEN` verdadeiro, com
  variação de caixa e com `%69`; `/qrng/v1/internal/{docs,admin-openapi.json}` continuam na
  client-api (401); controle positivo: na rede privada as rotas internas respondem 200
  (client-api → Bongo `introspect` e `mail/cancel`; Bongo → client-api `password-reset/:id/status`,
  que existe mas que o Bongo deste ambiente NÃO usa, como em produção);
- **conta legada**: cadastro, chave de API, `/qrng/v1/random` com `Authorization: Bearer <chave>`;
- **identidade forjada**: `X-Bongo-User-Id`, `X-Bongo-Role`, `X-Portal-User` não autenticam nem elevam;
- **identidade do portal**: `identity/status` (200 / 403 `QRNG_ACCESS_DENIED` / 401
  `PORTAL_SESSION_INVALID`), `AMBIGUOUS_CREDENTIALS`, `DEVELOPER_ACCOUNT_NOT_PROVISIONED`,
  `provision` (201, depois 409), chave emitida com a sessão do portal;
- **vínculo**: reauth (senha errada recusada), link com reauth inválido (403
  `REAUTH_REQUIRED`), senha legada errada (403 `INVALID_LEGACY_CREDENTIALS`), sucesso mantendo
  id/chave/login legado, reuso do reauth recusado; o aviso de vínculo
  (`qrng_legacy_account_linked`, para o e-mail da conta antiga) chega a `accepted`;
- **recuperação de senha — páginas de destino**: os links dos e-mails são
  `PUBLIC_BASE_URL/redefinir-senha#token=…` (portal) e `QRNG_PASSWORD_RESET_URL#token=…`
  (contas legadas da client-api; fallback do Bongo: `PUBLIC_BASE_URL` +
  `QRNG_LEGACY_RESET_PATH`). Ambos precisam abrir a página **pública** do front do portal
  (`/redefinir-senha`, `/redefinir-senha-api`, sob `location /`, fora do gate): sob `/qrng/` o
  gate manda o anônimo para o login e a conta sem `qrng` para `/cards`, e o `#token=` se perde.
  A matriz lê as duas variáveis dos containers (exige a borda deste ambiente e caminho fora de
  `/qrng/`) e abre os caminhos sem sessão, com cookie lixo, expirado, `pending`, sem `qrng`,
  desabilitado e com `qrng` → 200 do front, sem redirecionamento; também com o Bongo parado.
  Controle: `/qrng/redefinir-senha` sem sessão → 302 login. `check-config.sh` recusa offline
  um compose com esses valores sob `/qrng/`. Os padrões do código já são as páginas públicas
  (`https://bongo.dobslit.com/redefinir-senha-api` na client-api e `/redefinir-senha-api` no
  Bongo); aqui a URL da client-api é definida só porque a borda deste ambiente é outra;
- **e-mail**: `forgot-password` e `password-reset/request` com resposta idêntica para e-mail
  inexistente; as mensagens novas chegam a `accepted` no transporte simulado — lido em
  `GET /api/admin/mail/outbox` (só estado; a listagem não pode conter link, token nem e-mail completo);
- **auditoria**: `/api/admin/audit` e `/qrng/v1/admin/audit` sem segredos; eventos de falha sem e-mail completo;
- **Bongo parado** (`docker stop kapua-authgate-bongosite-auth`): `/qrng/` → 503 HTML `no-store`
  em < 8 s; stream/NIST/`identity/status` → 503 JSON `IDENTITY_UNAVAILABLE`; chave de API,
  login legado e públicos continuam; `/edu/` → 500 (comportamento atual, fora do escopo);
  depois `docker start` + `nginx -s reload` e o acesso volta;
- **logs** de `bongosite-auth`, `qrng-client-api` e `nginx`: nenhuma senha, JWT, token de
  reauth, chave de API, segredo do `.env`, link de redefinição ou e-mail completo dos usuários de teste.

A saída é uma tabela PASS/FAIL com status HTTP, tipo de conteúdo e código de erro — nunca
corpos, tokens ou links.

## Arquivos

| arquivo | |
|---|---|
| `nginx/bongo.dobslit.com.prod.conf`, `nginx/kuapoa-limits.prod.conf` | cópias da produção (entradas, só leitura; a cópia das zonas trouxe uma linha `nginx version: …` da captura, descartada pelo render) |
| `nginx/apply_nginx_authz.py` | **o mesmo** script que vai para a VM (cópia idêntica do pacote de entrega). Saída ≠ 0 se o reload falhar (3) ou o smoke pós-reload divergir (4); a linha de rollback é impressa antes do reload |
| `render-nginx.py` | produção → `patch()` → `nginx/rendered/` (`--check` falha se desatualizado) |
| `check-config.sh` | verificações offline |
| `up.sh` / `down.sh` | sobe (gera `.env`) / derruba com `-v` e apaga `.env` |
| `run-matrix.mjs` | a matriz |
| `stubs/` | stubs sem dependências |

## Dois modos de e-mail

- **Com e-mail simulado** (padrão do teste): `bash up.sh`. Recuperação self-service ligada nos dois
  serviços; as mensagens chegam a `accepted` no transporte simulado.
- **Sem e-mail** (como a produção nesta fase): `AUTHGATE_MAIL_TRANSPORT=disabled AUTHGATE_RESET_ENABLED=0 bash up.sh`.
  A matriz detecta o modo e confere: status `selfService=false` nos dois serviços, 503
  `PASSWORD_RESET_UNAVAILABLE` igual para qualquer e-mail, admin sem "enviar link" (409), nenhuma
  mensagem de redefinição na fila e o aviso de vínculo parado em `pending`.

Os dois modos também cobrem, pela borda: QRNG Open API (`/capabilities`, `/entropy`, `/healthtest`
com Bearer e `X-API-Key`, erros 400/401/403/422, contabilização na cota do token, fonte parada → 503
sem bytes e volta), download rápido (`/public/sample`, entrega pelo pool ou direta, conta na cota do IP,
413 acima do máximo), cota visível (`/public/quota`, `/me/usage`), rota pública `/qrng/api/random` e a
chave de conta criada pelo portal (403 `PORTAL_ACCESS_REVOKED` com a conta desabilitada, volta ao reabilitar).

## Rollback × roll-forward (`../rollback-compat/`)

`BONGO_REPO=<checkout do bongosite> bash staging/rollback-compat/run.sh` sobe, sobre os MESMOS bancos:
produção (`bcb5052` / `aa22bfb`) → candidata (migração com cópia prévia) → produção de novo (rollback) →
candidata de novo. Confere login, JWT, chaves, contas criadas em cada fase, cópia única e o efeito
conhecido do rollback do Bongo (conta desabilitada volta a entrar enquanto a versão anterior estiver no ar).
