# Verificação do GitHub Actions real (item 1)

O repositório `Dobslit-projects/qrng-demo-react` é **público** — a API do GitHub
responde sem autenticação, então a execução do CI pôde ser verificada de fato
(não apenas localmente).

## Execução correspondente ao commit `0403e61`

| campo | valor |
|---|---|
| workflow | **CI** (run #24) |
| URL | https://github.com/Dobslit-projects/qrng-demo-react/actions/runs/33090130893 |
| `head_sha` | **`0403e617102acd8e0d0817e6b00a9f09f136aa9a`** (== HEAD da branch) |
| `head_branch` | `stabilize/physical-layer-baseline-20260826` |
| `event` | `push` |
| `run_attempt` | 1 |
| `status` / `conclusion` | `completed` / **`success`** |
| criado / atualizado | 2026-08-27T15:51:36Z / 2026-08-27T15:52:02Z |

## Jobs executados (4/4 `success`)

### 1. `Frontend (build + testes)` — success
| # | passo | conclusão |
|---|---|---|
| 4 | Instalar dependências (`npm ci`) | success |
| 5 | **Lint** (`npm run lint`) | **success** |
| 6 | Testes (`npm test` → vitest) | success |
| 7 | Build (`npm run build`) | success |

O passo **Lint** já **não tem** `continue-on-error` (removido em `db555d5`) — é um
passo bloqueante normal e concluiu `success`.

### 2. `qrng-client-api (testes + OpenAPI)` — success
| # | passo | conclusão |
|---|---|---|
| 4 | Instalar dependências (`npm ci`) | success |
| 5 | Testes (unitários + integração + contrato OpenAPI) | success |
| 6 | Regenerar OpenAPI (pública + admin) e **checar drift** | success |

### 3. `qrng-nist-api (testes Python)` — success
| # | passo | conclusão |
|---|---|---|
| 4 | Testes (`python3 test/test_nist_service.py`) | success |

### 4. `physical-layer (RCT/APT health tests)` — success  ← **confirmado executado**
| # | passo | conclusão |
|---|---|---|
| 4 | Testes RCT/APT + máquina de estados de saúde (módulo isolado) | success |

## Confirmação de que os passos são bloqueantes

O único passo que já teve `continue-on-error` era o **Lint** do job frontend;
`db555d5` o removeu. Todos os demais (testes, build, drift do OpenAPI, health
tests) nunca tiveram `continue-on-error` — uma falha em qualquer um marca o job
como `failure` e a run como `failure`.

**Corroboração pelo histórico de runs da mesma branch:**

| run | commit | conclusão | passo que falhou |
|---|---|---|---|
| #19 | `09b8289` | **failure** | Frontend → Testes (vitest coletava o spec Playwright) |
| #20 | `65ea893` | **failure** | idem |
| #21 | `600a9c7` | **failure** | Frontend → passo 6 "Testes" |
| #22 | `42d5b7e` | success | — (inclui o fix `b549cfd` do vitest exclude) |
| #23 | `db555d5` | success | — |
| **#24** | **`0403e61`** | **success** | — |

Ou seja: o pipeline **de fato reprova** (3 runs vermelhas nesta branch, mais a
#6 em `fix/qrng-pipeline-audit-20260824`), e ficou verde só depois das correções.

## Limitação registrada

O endpoint de **logs brutos** por job (`GET /actions/jobs/{id}/logs`) exige
autenticação mesmo em repositório público; sem `gh`/PAT nesta sessão não foi
possível baixar o texto do log (ex.: a linha "0 errors, 2 warnings" do ESLint).
A evidência disponível é o **status por passo** via API pública, que é
autoritativo: um passo com `continue-on-error` que falhasse apareceria com
`conclusion: failure` no nível do passo — aqui **todos os passos estão
`success`**.
