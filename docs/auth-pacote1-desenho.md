# Desenho — autorização, identidade, e-mail, recuperação de senha e auditoria (pacote 1, doc 155)

Data: 2026-10-18. Base: doc 153; código `bongosite` `aa22bfb` e `qrng-demo-react` `6a8d5bc` (= main; produção do QRNG em `bcb5052`).
Branches: `feature/auth-identity-email-20261018` nos dois repositórios. Nada vai para produção nesta etapa.

## 0. Registro de decisões (exigido antes de editar)

| Tema | Decisão |
|---|---|
| Identificador estável | `users.id` do Bongo (UUID TEXT, imutável, gerado por `randomUUID()`). Nunca o e-mail. Na client-api: coluna nova `users.bongo_user_id TEXT UNIQUE` (NULL = conta legada não vinculada). |
| Como a client-api valida a identidade | **Introspecção** no Bongo: a SPA envia o JWT do portal no cabeçalho explícito `X-Portal-Session` (nunca por cookie → sem CSRF); a client-api chama `POST http://127.0.0.1:3101/api/internal/v1/introspect` com `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` e corpo `{token}`. O Bongo verifica assinatura, revogação (`token_version`/`password_changed_at`), existência e conta habilitada, e devolve identidade + autorização por serviço. A client-api **não** recebe a chave de assinatura do Bongo. Resultado em cache por no máximo `PORTAL_INTROSPECTION_CACHE_MS` (padrão 30 s; 0 em testes), indexado pelo SHA-256 do token (o token não é guardado). |
| Indisponibilidade do Bongo | Falha **fechada** para quem usa identidade do portal: 503 `IDENTITY_UNAVAILABLE`. Chaves de API e login legado continuam funcionando (não dependem do Bongo). Nenhum acesso é concedido por cache vencido. |
| Revogação | Bongo: `users.token_version` (novo) entra no JWT (`tv`); troca/redefinição de senha, desabilitação e "sair de todas as sessões" incrementam a versão → tokens antigos inválidos imediatamente no Bongo e em até `PORTAL_INTROSPECTION_CACHE_MS` na client-api. Tokens antigos sem `tv` valem só enquanto `token_version = 0` (regra de `password_changed_at`); depois do primeiro incremento são recusados. client-api legada: coluna `password_changed_at` (nova) revoga JWTs legados emitidos antes da redefinição. |
| Contas legadas | Continuam com login por e-mail e senha da client-api, IDs, chaves, cotas e histórico intactos. Ganham recuperação de senha por link (via fila de e-mail central) e podem ser vinculadas. Nenhum login legado é desativado neste pacote. |
| Vinculação segura | Explícita, com prova de controle das **duas** contas: (1) sessão válida do portal + **reautenticação recente** no Bongo (senha do portal → `reauth_token` de uso único, 5 min, finalidade `link_qrng_developer`), e (2) e-mail + senha da conta legada. Nunca por igualdade de e-mail. Conflitos explícitos (409). Desvinculação só por script administrativo. |
| Autorização ≠ autenticação | Autenticação = sessão válida. Autorização QRNG = conta habilitada **e** (`role = admin` **ou** (`role = user` **e** `"qrng" ∈ services`)). `pending` nunca autoriza. Verificação de e-mail **não** faz parte da autorização neste pacote. |
| Onde mora o e-mail | Serviço central no Bongo (autoridade de identidade): fila `mail_outbox` no SQLite do Bongo + worker + adaptador Resend + transporte simulado. A client-api enfileira por API interna autenticada (`POST /api/internal/v1/mail`) e expõe ao worker um verificador de validade do token legado. Uma credencial do provedor, um worker, uma trilha. |

## 1. Autorização do QRNG (gate do nginx)

### 1.1 Bongo — `GET /api/auth/authorize/:service`
- `:service` ∈ lista fechada `KNOWN_SERVICES = ["qrng","quantum-edu"]` (outros → 404).
- Usa o mesmo `requireAuth` (Bearer). Respostas **sem corpo sensível**:
  - 204 + cabeçalhos `X-Bongo-User-Id: <uuid>` e `X-Bongo-Role: <role>` → autorizado.
  - 401 → sem sessão, token inválido/expirado/revogado, usuário inexistente.
  - 403 → conta desabilitada, `pending`, ou serviço não concedido.
- Corpo JSON mínimo `{error, code}` (`UNAUTHENTICATED`, `ACCOUNT_DISABLED`, `ACCOUNT_PENDING`, `SERVICE_NOT_GRANTED`) para depuração; o nginx não repassa o corpo ao cliente.
- Negações de usuários autenticados viram evento `authz.denied` (com deduplicação em memória: 1 por usuário+serviço+motivo a cada 10 min), porque o `auth_request` roda para cada arquivo da SPA.

### 1.2 Conta desabilitada (novo)
- `users.disabled_at TEXT NULL` (+ `disabled_reason TEXT NULL`). Admin: `PUT /api/admin/users/:id` aceita `{disabled: true|false, disabledReason?}`; desabilitar incrementa `token_version` (derruba sessões).
- `requireAuth` rejeita conta desabilitada com 401 `ACCOUNT_DISABLED`; login de conta desabilitada → 403 `ACCOUNT_DISABLED` somente após senha correta (senha errada → o mesmo 401 genérico).
- Admin não pode desabilitar a si mesmo nem o último admin habilitado.

### 1.3 nginx (arquivo de produção preparado, não aplicado)
- Nova location interna `= /_bongo_authz_qrng` → `http://127.0.0.1:3101/api/auth/authorize/qrng` com `Authorization: Bearer $cookie_bongo_session`, sem corpo.
- `/qrng/` (página): `auth_request /_bongo_authz_qrng`; 401 → `302 /?redirect=/qrng/` (login); 403 → `302 /cards?acesso=qrng`; 500 (Bongo fora) → página 503 estática JSON-free (`@authz_unavailable_page`).
- APIs `= /qrng/api{,-fpga}/stream`, `/qrng/nist/` e o regex de upload/run: mesmo `auth_request`; 401 → JSON `@qrng_unauth`; 403 → JSON `@qrng_forbidden` (novo); 500 → JSON 503 `@qrng_identity_unavailable` (novo). Nunca redirecionar API para HTML.
- `/edu/` continua em `/_bongo_auth` (só sessão) — mudar para `quantum-edu` é decisão separada (documentada).
- `location ^~ /api/internal/ { return 404; }` (as rotas internas do Bongo nunca saem pela borda) e `location ^~ /qrng/v1/internal/ { return 404; }` — exceto o que já é público hoje (`/qrng/v1/internal/admin-openapi.json` e `/qrng/v1/internal/docs` são rotas **da client-api** com autenticação própria; a regra de borda passa a cobrir só `/qrng/v1/internal/v1/`).
- Endpoints explicitamente públicos inalterados: `/qrng/api/random`, `/qrng/api-fpga/random`, `/qrng/api{,-fpga}/health`, `/qrng/v1/*` (chave de API, `/public/*`, docs).

## 2. Identidade integrada (client-api)

### 2.1 Bongo — introspecção interna
`POST /api/internal/v1/introspect` (somente com `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`, comparação em tempo constante; sem o token → 404 como se não existisse). Corpo `{token, reauthToken?, reauthPurpose?}`.
Resposta 200:
```json
{ "active": true, "user": {"id": "<uuid>", "email": "...", "name": "...", "role": "user", "services": ["qrng"]},
  "authorization": {"qrng": true}, "token_version": 3, "disabled": false,
  "reauth": {"verified": true, "purpose": "link_qrng_developer"} }
```
`active:false` (com `reason`) para token inválido/revogado/usuário inexistente/desabilitado. `reauth` só aparece quando `reauthToken` foi enviado: é **consumido atomicamente** (uso único) e precisa pertencer ao mesmo usuário e finalidade.

### 2.2 Bongo — reautenticação (step-up)
`POST /api/auth/reauth` (requireAuth) com `{currentPassword, purpose}` (`purpose` ∈ `["link_qrng_developer"]`) → `{reauthToken, expiresAt}`; 32 bytes aleatórios do SO, só o hash SHA-256 em `auth_challenges(id, user_id, purpose, token_hash UNIQUE, expires_at, used_at, created_at)`, TTL 5 min, limitador por usuário (10/15 min, só falhas contam como no `PUT /me`).

### 2.3 client-api — modelo de dados (migração versionada)
`users` reconstruída (preserva `id`, `email`, `password_hash`, `role`, `created_at` e a sequência AUTOINCREMENT):
`id INTEGER PK AUTOINCREMENT, email TEXT UNIQUE NULL, password_hash TEXT NULL, role TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL, bongo_user_id TEXT UNIQUE NULL, auth_source TEXT NOT NULL DEFAULT 'legacy' CHECK (auth_source IN ('legacy','portal')), linked_at TEXT NULL, portal_email TEXT NULL, password_changed_at TEXT NULL, last_login_at TEXT NULL`.
- Conta **legada**: `auth_source='legacy'`, email/senha preenchidos; após vínculo, `bongo_user_id` + `linked_at` preenchidos e login legado continua.
- Conta **criada pelo portal**: `auth_source='portal'`, `email` e `password_hash` NULL (não colide com contas legadas de mesmo e-mail), `portal_email` = cópia de exibição atualizada a cada uso (não é usada para autenticar).
- O código antigo (`bcb5052`/`6a8d5bc`) continua funcionando sobre o esquema novo (colunas extras são ignoradas; login por e-mail não encontra linhas com e-mail NULL).

### 2.4 client-api — autenticação
- `requireAuth` e `resolveUser` aceitam, nesta ordem: `X-Portal-Session` (introspecção) → `Authorization: Bearer <JWT legado>` → (só `resolveUser`) chave de API. `X-Portal-Session` e `Authorization` juntos e divergentes de usuário → 400 `AMBIGUOUS_CREDENTIALS`.
- Portal: introspecção ativa **e** `authorization.qrng === true`, senão 401 `PORTAL_SESSION_INVALID` / 403 `QRNG_ACCESS_DENIED`; Bongo indisponível → 503 `IDENTITY_UNAVAILABLE`. Usuário do portal sem conta de desenvolvedor → 404 `DEVELOPER_ACCOUNT_NOT_PROVISIONED` (exceto em `/v1/identity/*`).
- JWT legado: rejeitado se `iat < password_changed_at` (segundos) ou se a linha for `auth_source='portal'` (conta de portal não tem JWT legado).
- Cabeçalhos de identidade vindos do cliente (`X-Bongo-User-Id`, `X-Bongo-Role`, `X-Portal-User`) são **ignorados e removidos** (`delete req.headers[...]`) logo no início; a client-api nunca confia em identidade por cabeçalho.

### 2.5 client-api — rotas novas (todas com `@openapi`)
| Rota | Autenticação | Efeito |
|---|---|---|
| `GET /v1/identity/status` | `X-Portal-Session` | `{portal:{id,email,name}, developer_account: null | {id, auth_source, linked_at, has_token}, can_provision, can_link}` |
| `POST /v1/identity/provision` | `X-Portal-Session` | cria conta `auth_source='portal'` vinculada; 409 `PORTAL_ALREADY_LINKED` se já existe |
| `POST /v1/identity/link` | `X-Portal-Session` + corpo `{reauthToken, legacyEmail, legacyPassword, lang?}` | valida reauth (introspecção com `reauthToken`) e credenciais legadas (bcrypt, contra hash fictício se não existir); 403 `INVALID_LEGACY_CREDENTIALS`, 403 `REAUTH_REQUIRED`, 409 `PORTAL_ALREADY_LINKED`, 409 `ACCOUNT_ALREADY_LINKED`; sucesso mantém id/chaves/cotas/histórico e enfileira o aviso `qrng_legacy_account_linked` (sem link) para o e-mail da conta ANTIGA |
| `POST /v1/auth/password-reset/request` | anônimo | conta legada: resposta genérica 202 sempre; limites por IP e por e-mail; enfileira e-mail via Bongo |
| `POST /v1/auth/password-reset/check` | anônimo | `{token}` → `{valid}` sem consumir |
| `POST /v1/auth/password-reset/confirm` | anônimo | `{token, password}` → consumo atômico, nova senha, `password_changed_at`, **desfaz o vínculo com o portal** (quem soube a senha antiga podia ter vinculado a conta a si), cancela na fila do Bongo as mensagens dos tokens mortos, aviso por e-mail |
| `GET /v1/internal/v1/password-reset/:id/status` | `INTERNAL_SERVICE_TOKEN` | `{valid}`; usado pelo worker do Bongo **só** se `QRNG_CLIENT_API_INTERNAL_URL` estiver definido (opcional; em produção o contêiner do Bongo não alcança `127.0.0.1:3010`) |
| `GET /v1/admin/audit` | admin | eventos de auditoria da client-api |

Tokens de recuperação legados: tabela nova `password_reset_tokens(id INTEGER PK, user_id INTEGER NOT NULL, token_hash TEXT UNIQUE NOT NULL, expires_at, used_at, invalidated_at, created_at, requested_ip_prefix, sent_to_hash)`.

### 2.6 Script de relatório
`node scripts/identity-report.js` → contagens agregadas (total, legadas não vinculadas, legadas vinculadas, criadas pelo portal, com chave ativa, admins legados), **sem** e-mails nem IDs.
`node scripts/identity-unlink.js <client-api-user-id>` → desvincula (uso administrativo excepcional, registra auditoria).

## 3. E-mail transacional (Bongo `lib/mail/`)

- Interface `transport.send(message) → {providerMessageId}`; erros `MailError {code, retryable}`.
- `resend`: `POST https://api.resend.com/emails` (fetch nativo do Node 20), `Authorization: Bearer RESEND_API_KEY`, `Idempotency-Key: <outbox.idempotency_key>`, timeout `MAIL_SEND_TIMEOUT_MS` (10 s). 429/5xx/timeout/rede → retentável; 400/401/403/422 → definitivo. Texto de erro do provedor é sanitizado (sem URLs) antes de ser gravado.
- `simulated`: memória do processo + falhas programáveis (testes); opcionalmente grava em arquivo **sem** o conteúdo do link.
- `disabled` (padrão em produção até o DNS estar pronto): mensagens ficam `pending` e não são enviadas.
- Configuração: `MAIL_TRANSPORT`, `MAIL_FROM` (padrão proposto `Kuapoã / Dobslit <notificacoes@notify.dobslit.com>`), `MAIL_REPLY_TO`, `PUBLIC_BASE_URL` (padrão `https://bongo.dobslit.com`; **nunca** derivado de Host/X-Forwarded-*), `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `MAIL_OUTBOX_KEY` (32 bytes base64, separado do banco), `MAIL_MAX_ATTEMPTS` (5), `MAIL_WORKER_INTERVAL_MS` (5000), `MAIL_WORKER_ENABLED`, `MAIL_OUTBOX_RETENTION_DAYS` (90), `MAIL_ADDRESS_RETENTION_DAYS` (30).
- Fila `mail_outbox`: `id TEXT PK, created_at, updated_at, template, locale, to_address NULL, to_hash, status CHECK IN ('pending','sending','accepted','delivered','bounced','complained','failed','cancelled','expired'), attempts, max_attempts, next_attempt_at, lease_until, last_error_code, last_error_at, provider, provider_message_id, idempotency_key UNIQUE, validity_kind CHECK IN ('none','bongo_password_reset','qrng_legacy_password_reset'), validity_ref, secret_ciphertext NULL, secret_expires_at NULL, accepted_at, delivered_at, purged_at`.
- Segredos na fila: o token/link vai só em `secret_ciphertext` (AES-256-GCM, IV aleatório, AAD = id da mensagem, chave `MAIL_OUTBOX_KEY`). Apagado (NULL) assim que a mensagem é aceita, falha definitivamente, é cancelada ou expira. O link nunca vai para log, histórico, relatório ou tela administrativa (a tela mostra destinatário mascarado e estado).
- Worker: reivindica com `UPDATE … SET status='sending', lease_until=now+60s WHERE id=? AND status='pending' AND next_attempt_at<=now` (atômico); antes de enviar, confere validade (token não usado/não invalidado/não vencido; para legado, o prazo do segredo e, se `QRNG_CLIENT_API_INTERNAL_URL` estiver definido, a client-api) → senão `cancelled`/`expired` e apaga o segredo; envia com `Idempotency-Key`; 2xx → `accepted` (não "entregue"); falha retentável → `pending` com atraso exponencial (30 s, 2 min, 10 min, 30 min, 2 h, com jitter) até `max_attempts` → `failed`. No início do processo, linhas `sending` com lease vencido voltam a `pending` (mesmo `Idempotency-Key` → o provedor deduplica).
- Webhook `POST /api/mail/webhooks/resend` (corpo cru; verificação Svix: `svix-id`, `svix-timestamp` ±5 min, `svix-signature` HMAC-SHA256 com o segredo `whsec_…`): `email.delivered` → `delivered`; `email.bounced` → `bounced`; `email.complained` → `complained`. Sem segredo configurado → 404.
- API interna para a client-api: `POST /api/internal/v1/mail` (`INTERNAL_SERVICE_TOKEN`) `{template, to, locale, secret, secretExpiresAt, idempotencyKey, validity:{kind, ref}}` → 202 `{id}`; idempotente pelo `idempotencyKey`.
- **Cancelamento ativo** (topologia de produção: Bongo em contêiner bridge, client-api na rede do host): `POST /api/internal/v1/mail/cancel` (`INTERNAL_SERVICE_TOKEN`) `{validity:{kind:'qrng_legacy_password_reset', refs:[…≤50]}}` → 200 `{cancelled:n}`; mensagens `pending`/`sending` desses tokens viram `cancelled` e o segredo é apagado. A client-api chama ao invalidar tokens (pedido novo) e ao usar um token (confirmação), em segundo plano e como melhor-esforço: se falhar, o link já está morto na client-api e o segredo expira no prazo. Corrida inerente: uma mensagem já em `sending` pode sair (com link morto).
- Templates pt/en: `password_reset`, `password_changed`, `qrng_legacy_password_reset`, `qrng_legacy_password_changed`, `qrng_legacy_account_linked`. Texto puro + HTML simples, sem imagens/rastreadores remotos.
- Admin: `GET /api/admin/mail/outbox?status=` (mascarado), `POST /api/admin/mail/outbox/:id/retry` (só `failed`, e só se o segredo ainda existir — caso contrário orienta nova solicitação).

## 4. Recuperação de senha (Bongo)

- `POST /api/auth/forgot-password {email, lang?}` → sempre 200 `{message}` genérico. Conta existente e habilitada: transação que invalida tokens `password_reset` anteriores não usados (`invalidated_at`), cria token novo (32 bytes `crypto.randomBytes`, base64url; só SHA-256 em `auth_tokens`), `expires_at = now + RESET_TOKEN_TTL_MINUTES` (30), `sent_to_hash` = HMAC do e-mail no momento do envio, e enfileira `password_reset` (link `PUBLIC_BASE_URL/redefinir-senha#token=<token>`). Limites: os atuais (IP 10/15 min; e-mail 1/min e 5/dia, em memória) + teto persistente por conta (`RESET_MAX_PER_ACCOUNT_PER_DAY`, 5, contado no banco). Não cria mais notificação para o administrador.
- Link com **fragmento** (`#token=`): o navegador não envia o fragmento ao servidor → fora de logs de acesso, de proxies e de Referer. O GET da página não consome nada.
- `POST /api/auth/reset-password/check {token}` → `{valid}` (não consome).
- `POST /api/auth/reset-password {token, password}` → valida a regra de senha **antes**; em uma transação: `UPDATE auth_tokens SET used_at=? WHERE token_hash=? AND purpose='password_reset' AND used_at IS NULL AND invalidated_at IS NULL AND expires_at>?` (consumo atômico; só um de dois pedidos concorrentes muda 1 linha), aplica a senha (`password_changed_at`, `token_version+1` → todas as sessões revogadas), invalida os outros tokens de reset do usuário, marca `email_verified_at` **somente** se o e-mail atual corresponder a `sent_to_hash` (prova de controle do endereço), enfileira `password_changed`. Resposta 200 com orientação para entrar de novo (sem login automático). Token inválido/vencido/usado → 400 `INVALID_OR_EXPIRED_TOKEN` (mesma resposta para os três).
- Limites: `check` e `reset-password` por IP (30/15 min).
- Front: páginas públicas `/redefinir-senha` (portal) e `/redefinir-senha-api` (conta legada da API; chama `/qrng/v1/auth/password-reset/{check,confirm}`), ambas sob `location /` — **fora** do gate de `/qrng/`, que mandaria o anônimo para o login e perderia o `#token=`. Padrões: `QRNG_PASSWORD_RESET_URL=https://bongo.dobslit.com/redefinir-senha-api` (client-api) e `QRNG_LEGACY_RESET_PATH=/redefinir-senha-api` (Bongo). O `main.tsx` lê `location.hash`, remove o fragmento com `history.replaceState` antes de qualquer outra requisição, guarda o token só em memória, `<meta name="referrer" content="no-referrer">`; sem recursos de terceiros adicionais; mensagem final manda entrar de novo e limpa a sessão local.
- Administração: `POST /api/admin/users/:id/send-password-reset` dispara o mesmo fluxo (o admin nunca vê a senha). A definição manual de senha continua existindo no backend e na tela de admin, rotulada como uso excepcional.

## 5. Auditoria

- Tabelas `audit_events` nos dois bancos: `id INTEGER PK AUTOINCREMENT, occurred_at TEXT (UTC ISO), event_type TEXT, outcome TEXT CHECK IN ('success','failure','denied'), actor_user_id, target_user_id, request_id, ip_prefix (IPv4 /24, IPv6 /48), subject_hash NULL, metadata TEXT (JSON com chaves permitidas)`.
- `subject_hash` = HMAC-SHA256(`AUDIT_PSEUDONYM_KEY`, e-mail normalizado), 32 hex, só em eventos de falha/anônimos para correlacionar tentativas sem gravar o endereço; sem a chave, o campo fica NULL.
- Nunca entram: senha, JWT, token de recuperação/reauth, link, chave de API completa, e-mail completo em eventos de falha.
- Eventos Bongo: `auth.login` (success/failure: `bad_credentials`, `rate_limited`, `account_disabled`), `auth.password_reset.requested` (outcome success; metadata `{delivered_to_queue: bool}` não é exposto ao público), `auth.password_reset.completed` (success/failure `invalid_or_expired`), `auth.password.changed`, `auth.email.changed`, `auth.reauth` (success/failure), `admin.user.updated` (metadata: nomes dos campos alterados, papel/serviços antes→depois), `admin.user.disabled`/`enabled`, `admin.user.deleted`, `admin.password_reset.sent`, `admin.password.set_manually`, `authz.denied` (deduplicado), `identity.introspect.denied` (deduplicado).
- Eventos client-api: `auth.login` (legado), `auth.password_reset.requested`/`completed`, `identity.provisioned`, `identity.linked` (success/failure + motivo), `identity.unlinked` (script), `identity.denied` (deduplicado), `admin.token.revoked`, `admin.token.quota_changed`, `admin.user.deleted`.
- `last_login_at` (Bongo e client-api) atualizado em login bem-sucedido; na client-api também no primeiro uso de sessão do portal a cada hora (sem escrita por requisição).
- Request ID: Bongo ganha `X-Request-Id` (aceita o recebido se `^[A-Za-z0-9_-]{8,64}$`, senão gera) e o grava nos eventos.
- Consulta: `GET /api/admin/audit?type=&outcome=&before=&limit=` (Bongo) e `GET /v1/admin/audit` (client-api), só admin.
- Retenção: `AUDIT_RETENTION_DAYS` (365) com expurgo na inicialização e a cada 24 h.
- Métricas: nenhum rótulo com ID, e-mail ou IP.

## 6. Migrações

- Tabela `schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)` nos dois bancos. O `migrate()` atual vira a "linha de base" (continua idempotente); migrações novas numeradas, cada uma em transação, registradas ao final; reaplicar é no-op.
- Bongo v1: `users.token_version INTEGER NOT NULL DEFAULT 0`, `users.disabled_at`, `users.disabled_reason`, `users.last_login_at`; `auth_tokens.invalidated_at`, `auth_tokens.sent_to_hash`; tabelas `auth_challenges`, `mail_outbox`, `audit_events`, `schema_migrations`. Tudo aditivo (o código antigo funciona sobre o esquema novo).
- client-api v1: reconstrução de `users` (ver 2.3) preservando IDs e `sqlite_sequence` (o maior de `seq` antigo e `max(id)`); tabelas `password_reset_tokens`, `audit_events`, `schema_migrations`. Verificação pós-migração: mesma contagem de usuários, mesmos `(id,email,password_hash,role,created_at)`, chaves e uso intocados.
- Nenhuma migração marca e-mail como verificado. Rollback de código não exige reverter banco; reverter banco só por restauração de backup, nunca automática.

## 7. Decisões da revisão final (2026-10-18)

- **Recuperação do portal responde antes do trabalho**: `POST /api/auth/forgot-password` responde o 200 genérico e só depois procura a conta, gera o token e enfileira (`lib/background.js`). Nem o corpo nem o tempo de resposta distinguem conta existente. A busca de idempotência na fila usa faixa indexada em vez de `substr()`.
- **Chaves de API de contas criadas pelo portal** (`auth_source='portal'`) dependem da conta do portal: a client-api consulta `POST /api/internal/v1/accounts/status {ids}` → `{exists, active, qrng}` com cache de `PORTAL_ACCOUNT_STATUS_CACHE_MS` (60 s). Desabilitada, sem `qrng` ou excluída → 403 `PORTAL_ACCESS_REVOKED`. Bongo fora do ar: vale o último estado conhecido; sem nenhum, a chave continua valendo (a disponibilidade da API não passa a depender do Bongo). Contas legadas, vinculadas ou não, não consultam.
- **Exclusão de conta legada** cancela na fila do Bongo os e-mails de redefinição dos tokens apagados.
- **JWT legado** grava `iat_ms`; a redefinição revoga também um JWT emitido no mesmo segundo, antes dela.
- **Troca de e-mail** no Bongo apaga o endereço antigo da fila (pendentes cancelados, segredo apagado).
- **Prazo de envio** (`MAIL_SEND_TIMEOUT_MS`) cobre também a leitura do corpo da resposta do provedor.
- **Troca de senha no perfil**: o front guarda o token novo devolvido (localStorage e cookie `bongo_session`); as outras sessões caem.
- **Cópia antes de migrar**: as duas migrações gravam `<banco>.pre-migration-v<N>-<data>.bak` com `VACUUM INTO` antes de aplicar qualquer versão pendente; se a cópia falha, nada é migrado e o processo não sobe. `MIGRATION_BACKUP=off` desliga.
- **Compose de produção do Bongo** repassa todas as variáveis novas (antes só `JWT_SECRET`, `ADMIN_SEED_PASSWORD`, `CORS_ORIGINS`, `TRUST_PROXY`).
- **Retenção da auditoria na client-api** aceita só 1–3650 dias; outro valor volta para 365.

## 8. Implantação sem e-mail (fase atual) e atendimento do suporte

- **Recuperação self-service só com envio real.** Bongo: liga com `PASSWORD_RESET_ENABLED=1` **e** transporte ≠ `disabled`, `MAIL_OUTBOX_KEY` e `MAIL_WORKER_ENABLED=1`; client-api: `QRNG_PASSWORD_RESET_ENABLED=1`. Padrão: desligada.
- **Desligada:** `GET /api/auth/password-reset/status` → `{selfService:false, supportContact}` e `GET /qrng/v1/auth/password-reset/status` → `{self_service:false}`; os pedidos respondem 503 `PASSWORD_RESET_UNAVAILABLE`, iguais para qualquer e-mail, antes de qualquer trabalho; nenhum token é gerado; admin "enviar link" → 409. A tela "Esqueci minha senha" mostra a orientação de suporte (sem formulário, sem prometer envio); status inacessível conta como indisponível.
- **Suporte, conta do portal:** o admin define uma senha temporária (uso excepcional, já existente) depois de confirmar a identidade por outro canal; a pessoa troca a senha no perfil.
- **Suporte, conta antiga da API:** `docker exec -it qrng-client-api node scripts/issue-legacy-reset-link.js <e-mail>` gera um link de uso único (mesmas regras do e-mail; auditado como `admin.password_reset.manual_link`, sem o link) para entrega por canal verificado. A confirmação na página pública troca a senha, revoga os JWTs e desfaz um vínculo.
- **Redefinição não revoga chaves de API** (preserva integrações). Suspeita de comprometimento: ação explícita — o dono gira a chave (`/v1/me/token/rotate`) ou o admin a revoga.
- **Sessões legadas abertas antes da atualização** (JWT sem a dica de modo, que não existia) são retomadas uma vez; depois de qualquer escolha explícita, um JWT que sobrou nunca sai em modo portal.
- **Ativar o e-mail** é outra janela: domínio verificado, `MAIL_TRANSPORT=resend`, chaves, webhook, `MAIL_WORKER_ENABLED=1`, teste de entrega com endereço da equipe e só então os dois flags de recuperação.
