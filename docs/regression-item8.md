# Regressão completa (item 8 da auditoria)

Executada com o branch `fix/qrng-pipeline-audit-20260824` no HEAD `959c108`
(depois dos itens 2-7), sem nenhuma alteração em produção. Resultados abaixo,
seguidos das duas descobertas concretas feitas durante esta passagem.

## Resultado por suíte

| Suíte | Comando | Resultado |
|---|---|---|
| Backend (qrng-client-api) | `npm test` (node:20-alpine) | **93/93 passando** (api.test.js + openapi.test.js + upstream-contract.test.js) |
| Frontend — build | `npm run build` (node:22-alpine, vite) | OK, 70 módulos, sem erros |
| Frontend — testes | `npm test` (vitest) | **46/46 passando** (AppContext.test.jsx + qrngHelper.test.js) |
| Frontend — lint | `npm run lint` | 196 problemas, **todos pré-existentes** (ver nota abaixo) -- exceto 1 corrigido nesta passagem |
| NIST (qrng-nist-api) | `python3 test/test_nist_service.py` (python:3.12-slim) | **13/13 passando** |
| OpenAPI drift | `npm run openapi:generate` + diff | Sem divergência após regenerar; `qrng-public-v1.yaml` e `qrng-internal-admin-v1.yaml` batem com o commitado |

**Lint**: dos 196 problemas, a esmagadora maioria é `no-undef` para `require`/`module`/`__dirname` (arquivos CommonJS do backend/config sendo lintados com um preset de browser/ESM que não reconhece o ambiente Node) e para `__ENV` em `load-tests/*.js` (variável global do k6, não reconhecida pelo preset também) -- débito de configuração do ESLint pré-existente, já isento no CI (`continue-on-error: true`, comentário "não relacionado a esta auditoria"). Confirmado via `git blame`/histórico que nenhum desses arquivos foi criado por este trabalho. Corrigido durante esta passagem: um `import { getApiPrefix }` não utilizado em `Footer.jsx`, já obsoleto antes do commit do item 5 (achado ao revisar o próprio arquivo que este item tocou, não um problema novo).

## Monte Carlo com dados reais (não substitui os testes determinísticos)

Reaproveitando a mesma captura ao vivo de 4.000.000 bytes do item 3
(sha256 `9c7ec2803b1b9507407cb105de85f2174d739f2da48f6f292ae8883d20b92495`),
aplicando exatamente o contrato do frontend (`uint32ToFloat` = uint32/2^32,
`exponentialFromUniform` = -mean·ln(1-U)):

| Métrica | Valor observado | Esperado |
|---|---|---|
| U mínimo | 0.0000060890 | ≥ 0 |
| U máximo | 0.9999998994 | < 1 |
| U média | 0.496639 | ~0.5 |
| Cobertura de [0,1) em 20 buckets | 20/20 com ≥1 amostra | 20/20 |
| Maior desvio de um bucket vs. uniforme | 4.18% | pequeno, sem concentração |
| Exponencial (mean=10) mínimo | 0.000061 | ≥ 0 |
| Exponencial (mean=10) máximo | 161.12 | finito |
| Exponencial (mean=10) média | 9.8737 | ~10.0 (desvio 1.26%) |
| Floats fora de [0,1) | 0 | 0 |
| Amostras exponenciais não-finitas/negativas | 0 | 0 |

Isto é uma checagem empírica de regressão sobre dados reais, complementar
aos testes determinísticos fixos já existentes em `qrngHelper.test.js`
(fixtures `0x00000000 -> 0`, `0xFFFFFFFF -> ~0.99999999976...`) -- não os
substitui.

## Duas descobertas concretas desta passagem

### 1. Bug real: redirect de `/qrng/v1/docs` (sem barra final) perde o prefixo

Testado num ambiente isolado (instância throwaway de qrng-client-api +
`nginx:alpine` throwaway replicando exatamente o `location /qrng/v1/ {
proxy_pass http://127.0.0.1:3010/v1/; }` do nginx real do host, nunca
tocando os processos de produção -- mesmo padrão de teste do item 6).

`GET /qrng/v1/docs` (sem a barra final) retorna `301` com
`Location: /v1/docs/` -- **sem o prefixo `/qrng`**. Isso acontece porque o
Express (dentro de `swagger-ui-express`) gera o redirect de barra-final
relativo à própria aplicação, sem saber que está atrás de um proxy com
prefixo. Um usuário real que acesse
`https://bongo.dobslit.com/qrng/v1/docs` (falta comum -- sem a barra) cairia
em `https://bongo.dobslit.com/v1/docs/`, que não bate com nenhuma location
do nginx real (só existem `/qrng/api/`, `/qrng/api-fpga/`, `/qrng/v1/`,
`/qrng/nist/`, `/qrng/`, `/dobflight/`, `/qml/`, e o catch-all `/` que serve
uma aplicação completamente diferente na porta 8081) -- ou vai parar na
aplicação errada, ou em 404.

**Fix testado e confirmado nesta passagem** (nginx, não requer mudança de
código): adicionar ao `location /qrng/v1/` do nginx do host (não deste
repositório -- é o nginx de sistema do Bongo VM, fora do controle de
versão deste projeto):

```nginx
proxy_redirect /v1/docs/ /qrng/v1/docs/;
proxy_redirect /v1/internal/docs/ /qrng/v1/internal/docs/;
```

Testado no mesmo ambiente isolado: sem o `proxy_redirect`, o `Location`
vem `/v1/docs/`; com ele, vem corretamente
`http://<host>/qrng/v1/docs/`. **Não aplicado ao nginx real** -- é infra
de host fora deste repositório git, e alterá-la é uma mudança de produção
que requer autorização explícita separada (ver item 9). Registrado aqui
como achado concreto, não corrigido silenciosamente.

### 2. Confirmado: produção não está rodando o branch da auditoria

Smoke test somente-leitura contra a produção real:
`GET https://bongo.dobslit.com/qrng/v1/health/self` → `200` (serviço vivo,
saudável). `GET https://bongo.dobslit.com/qrng/v1/openapi.json` → `404`
(rota que só existe a partir do trabalho desta auditoria, incluindo commits
anteriores a esta sessão) -- confirma que a instância de produção
(`node server.js`, PID visto antes e depois de toda esta sessão) nunca foi
reiniciada com o código deste branch, consistente com a instrução de não
implantar em produção sem autorização.

## Não coberto nesta passagem (limitações conhecidas, não escondidas)

- **E2E de navegador real**: não existe framework de E2E (Playwright/
  Cypress) neste repositório -- só `vitest` + `@testing-library/react`
  (testes de componente/integração que renderizam e interagem com
  componentes reais via DOM simulado, não um navegador real). Os testes
  existentes de `AppContext.test.jsx`/`qrngHelper.test.js` cobrem o
  equivalente mais próximo disponível hoje.
- **Cota de bytes pública por IP (item 6)**: testada por inspeção de
  código (mesma lógica já testada da cota por token) e pelo teste de
  rate-limit dedicado; não há um teste automatizado específico para o
  teto de bytes/dia por IP isoladamente (rate limit por minuto já cobre a
  família de erro 429 de ponta a ponta).
