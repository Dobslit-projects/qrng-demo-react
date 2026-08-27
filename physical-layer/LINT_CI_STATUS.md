# Lint e CI — investigação e estado (item 3)

## O "241 problemas / 239 erros / 2 warnings"

### Causa raiz

`eslint.config.js` usava `files: ['**/*.{js,jsx}']` com `globals.browser`, então
`eslint .` (= `npm run lint`) estava lintando, com um config só-browser:

- `qrng-client-api/` — pacote Node/Express separado, com seu próprio gate
  (`node --test` + verificação de drift do OpenAPI);
- `load-tests/` — scripts **k6** (global `__ENV`, `import ... from "k6/http"`);
- `e2e/` — specs **Playwright** (Node: `Buffer`, `process`).

**179 dos 239 erros eram `no-undef`** para `require` / `module` / `process` /
`Buffer` / `describe` / `__ENV` — puro escopo errado, não problema de código.

### Compatibilidade / versões

| item | resultado |
|---|---|
| ESLint × eslint-plugin-react-hooks | **compatíveis**. eslint `9.39.3`, plugin `7.0.1`, `eslint-plugin-react-refresh` `0.4.26`, `@eslint/js` `9.39.3`. |
| `package.json` × `package-lock.json` | **coerentes** (ranges `^` batem com o lock; `npm ls` sem conflito/dedupe quebrado). |
| CI × local | **iguais**. CI frontend usa Node 22 + `npm ci`; a verificação local foi feita em `node:22` (container) + `npm ci`. CI client-api usa Node 20 + `npm ci`; verificado em `node:20-alpine` + `npm ci`. |
| `eslint-plugin-react-hooks@^7` | está no `package.json` **desde o commit inicial** (`f2b19a8`) — o débito de lint **precede toda a estabilização**. O plugin v7 traz as regras "React Compiler" (`react-hooks/purity`, `react-hooks/static-components`, `react-hooks/set-state-in-effect`), bem mais estritas que v5. |
| `continue-on-error: true` no passo Lint | adicionado em `1ce0e23` (rodada anterior). **Removido neste trabalho** — o lint volta a ser bloqueante. |

## Correção

### `eslint.config.js`
- `globalIgnores` passa a incluir `qrng-client-api/**` e `load-tests/**` (não são
  código do frontend). Se um dia ganharem lint próprio, será aqui / no pacote.
- Bloco Node para `*.config.{js,mjs}` + `e2e/**` (globais `Buffer`/`process`/`__dirname`).
- `react-refresh/only-export-components` → `off` **só para `src/contexts/**`**. É uma
  regra de ergonomia de HMR (Fast Refresh), sem efeito em build/correção; co-locar
  `createContext()` com o Provider é o padrão idiomático do React. **Permanece ATIVA
  em todo `src/components/**`.** Nenhuma outra regra foi desativada.

Após o escopo: **45 erros reais em `src/`, 0 em arquivos que esta branch alterou.**

### 45 erros de `src/` corrigidos
- **17 `no-unused-vars`** — imports/params/vars mortos removidos (inclusive a
  fiação morta `onGoLogin`/`goLogin` em `ApplicationsSection`).
- **16 `react-hooks/static-components`** — o componente `H` (linha rótulo/valor)
  estava definido **dentro** de `JobModal`; hoisted para o escopo do módulo (só
  fecha sobre `theme` + `mono`).
- **6 `no-empty`** — `catch {}` → `catch { /* motivo */ }`.
- **1 `no-undef`** — `NISTSection` chamava `sampleOriginLabel()` **inexistente**
  (`ReferenceError` quando `status.last_job` existisse). Helper adicionado
  (taxonomia `live | historical | unknown | periodic_live | upload`).
- **3 `eslint-disable` pontuais, com justificativa escrita** (não global, não em
  massa): 2× `react-hooks/purity` (`Date.now()` para um cronômetro/idade — um
  tick de estado forçaria re-render periódico do app inteiro), 1×
  `react-hooks/set-state-in-effect` (fetch-on-mount canônico, `useCallback`
  estável, `setState` só depois do `await`).
- **2 `react-hooks/exhaustive-deps` permanecem como WARNINGS** (não quebram o
  lint): `AnalysisSection.jsx:53` (dep `generate`), `StreamPanel.jsx:105` (dep
  `canStream`). Mexer em deps de efeito tem risco de comportamento; ficam para
  uma passada dedicada. **`eslint .` sai com código 0** (warnings não falham).

### `.github/workflows/ci.yml`
- Removido `continue-on-error: true` do passo **Lint** do job `frontend` — lint
  volta a ser bloqueante.
- Novo job `physical-layer-health`: roda os 27 testes RCT/APT +
  máquina de estados (`python -m unittest test_qrng_health_tests`).

## Execução na combinação Node/deps do GitHub Actions

Feito em containers com as versões exatas do `ci.yml`, `npm ci` (lockfile), a
partir do commit produzido:

| passo | comando | resultado |
|---|---|---|
| client-api deps | `node:20-alpine` + `npm ci` | OK |
| client-api testes | `node --test test/` | **106/106**, 0 falhas |
| OpenAPI regen + drift | `node openapi/generate.js` + `git diff` | **sem drift** |
| frontend deps | `node:22` + `npm ci` | OK |
| **lint (bloqueante)** | `npm run lint` | **PASS** (0 erros, 2 warnings) |
| frontend testes | `npx vitest run` | **52/52** |
| frontend build | `npm run build` | OK |
| health tests | `python:3.12` + `python -m unittest test_qrng_health_tests` | **27/27** |
| Playwright existente (`e2e/public-api.spec.js`) | — | **não roda em CI**: exige o ambiente ao vivo (sem staging). Vira etapa bloqueante do CI na seção Playwright/staging (item 5), com fixtures/containers. |

## GitHub Actions — verificação pendente do lado do usuário

Não há `gh` CLI nem token da API do GitHub disponível nesta sessão (repositório
privado; a deploy key da VM só serve para git, não para `api.github.com`). Portanto
**não declaro "CI verde" com base apenas nas execuções locais/containers acima.**

Para confirmar: abrir **Actions → commit `db555d5`** (branch
`stabilize/physical-layer-baseline-20260826`) em
`github.com/Dobslit-projects/qrng-demo-react`, ou rodar `gh run list --branch
stabilize/physical-layer-baseline-20260826` numa sessão autenticada. Observação: se
o repositório tiver o GitHub Actions **desabilitado** (comum em repo privado para
poupar minutos), não haverá run — o `ci.yml` fica como referência executável, e a
verificação de container acima é a evidência disponível.
