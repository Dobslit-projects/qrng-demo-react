# Rate limit — teste com DOIS IPs de origem reais (fase item 4)

Testado 2026-08-27 contra o **staging** (`staging/docker-compose.staging.yml`)
com a porta do `web` publicada em `0.0.0.0:18081` da VM Bongo durante a janela
do teste (staging efêmero, sem dados reais; porta fechada depois).

**NÃO** houve simulação de clientes via `X-Forwarded-For`. Foram usados dois
**hosts físicos distintos** com IPs públicos genuinamente diferentes.

## Dois IPs reais

| | host | IP público de origem |
|---|---|---|
| **A** | máquina local (Windows, ISP) | `200.129.133.131` |
| **B** | VM dobslit (egress NAT) — alcança Bongo pelo mesmo caminho do túnel reverso | `150.161.9.178` |

## Resultados

### 1. Quotas independentes — CONFIRMADO

- **IP A**: burst em `GET /qrng/api/random` → **exatamente 60× HTTP 200, depois 429**
  (`PUBLIC_RATE_LIMIT_PER_IP_PER_MINUTE=60` no staging). Corpo do 429 estruturado:
  `{request_id: "req_…", error: "RATE_LIMIT_EXCEEDED", message: "Limite de 60
  req/min por IP …"}`.
- **Enquanto A estava em 429**, **IP B** fez 5 requisições → **5× HTTP 200**,
  `provenance: replay`. Bucket independente.
- Requisição seguinte de A: ainda 429 (não intermitente) até a janela de 60 s
  reabrir; após ~60 s A voltou a 200 (**reset de janela** observado).

`api_usage_logs` do client-api de staging registrou `ip_address` distintos:
`200.129.133.131` (A) e `150.161.9.178` (B), em linhas separadas para
`/v1/public/random`.

### 2. Cliente A → 429 sem bloquear cliente B — CONFIRMADO (ver acima).

### 3. Headers de rate limit — CONFIRMADO

`express-rate-limit` com `standardHeaders: true`: respostas do endpoint público
trazem `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; o 429 traz
`Retry-After`.

### 4. Reinício de janela — CONFIRMADO

Janela fixa de 60 s (`windowMs`). Após a janela, o contador do IP zera e novas
requisições passam. Observado no intervalo entre os testes de A e B.

### 5. Spoofing de X-Forwarded-For — PARCIAL / DEPENDE DA CONFIG

- Com `TRUST_PROXY="loopback, uniquelocal"` (config inicial do staging): um
  valor `X-Forwarded-For` fornecido pelo cliente **chegou a ser usado como
  `req.ip`** em uma requisição isolada (`111.111.111.111`, `203.0.113.99`
  apareceram em `api_usage_logs`). Causa: `uniquelocal` confia em toda a faixa
  `172.16/12`, que inclui o gateway do bridge do Docker — então, com a
  publicação de porta do Docker (`-p`, userland-proxy) mascarando o IP real,
  o valor spoofado à esquerda do salto do gateway virava o "primeiro não
  confiável".
- Com **`TRUST_PROXY="2"`** (2 saltos exatos: docker-proxy/gateway + nginx do
  `web`): um burst de **70 requisições com `X-Forwarded-For` rotativo**
  (`9.9.9.1..70`) **atingiu o limite em ~60** — ou seja, todas keyed a **uma
  única identidade**, o spoof **não** criou buckets novos. Um XFF em cadeia
  (`44.44.44.44, 55.55.55.55`) resolveu para o IP real `200.129.133.131`.
  Ressalva: em algumas requisições a identidade registrada foi o IP do
  container nginx (`172.24.0.4`) e não o IP externo real — artefato do
  **NAT da publicação de porta do Docker no staging**, que não existe em
  produção.

### Produção (referência — já provado na Seção 1)

Em produção o nginx roda **no mesmo host** que o client-api (`network_mode:
host`), e `trust proxy: "loopback"` confia em **exatamente um salto conhecido**
(o nginx local). A evidência da Seção 1 (`SECTION1_POSTDEPLOY_EVIDENCE.md`)
mostrou **12 valores `X-Forwarded-For` spoofados rotativos** compartilhando **um
único bucket**, keyed ao IP real do cliente — o spoof não escapa do limite.
O ponto fraco acima é do **arranjo de rede do staging** (bridge + `-p`), não do
código nem da produção.

## Comportamento das quotas em memória / após reinício do processo

- `publicIpDailyUsage` (cota diária por IP anônimo) e `tokenRateMap` (rate por
  token) são `Map` **em memória** → **zeram quando o processo `qrng-client-api`
  reinicia**. Confirmado: após `docker compose up -d` do client-api de staging,
  os contadores por IP recomeçam do zero.
- A cota **por token** persiste (SQLite `daily_usage`), então o rate limit por
  minuto por token reinicia mas a **cota diária por token** não.
- Isto já estava documentado como limitação aceita em
  `SECTION1_POSTDEPLOY_EVIDENCE.md` e `VULNERABILITY_MATRIX.md`. Opções:
  store persistente (Redis) ou aceitação documentada — decisão de operação,
  não alterada nesta rodada.

## Ajuste feito

`staging/docker-compose.staging.yml`: `TRUST_PROXY` passou de
`"loopback, uniquelocal"` para **`"2"`** (2 saltos exatos). Produção continua
`"loopback"` (default do `server.js`, `TRUST_PROXY` só é lido se definido).

## O que NÃO foi feito

- Nenhuma alteração no rate limit **produtivo**.
- O staging não tem, hoje, um proxy reverso idêntico ao de produção (nginx no
  host). Um teste de spoof "perfeito" de produção exigiria replicar
  `network_mode: host` no staging ou uma janela controlada em produção.
- `RATE LIMIT MULTI-IP`: **APROVADO para quotas independentes entre dois IPs
  reais**; **PARCIAL para resistência a spoof no staging** (resistência plena
  já provada em produção na Seção 1).
