# Auditoria do diff `main` — `f058f22` → `ba98d30`

**CI:** #62 (`a1958b8`) e #64 (`ba98d30`) = **success, 5/5 jobs**. Total do range:
122 arquivos, +16 957 / −536.

O que **está rodando em produção** vs o que só **está em `main`**:

| container em produção | imagem | construída de |
|---|---|---|
| `qrng-client-api` (`:3010`) | `qrng-client-api:9e36a90` (`sha256:c0ebed0b…`) | `main @ 9e36a90` |
| `qrng-web-1` (`:3001`) | `qrng-web:9e36a90` (`sha256:35e30be7…`) | `main @ 9e36a90` |
| **NIST** (`:18002`, dobslit) | processo `nist_service.py` na dobslit — **NÃO containerizado, NÃO tocado** | versão antiga (503 linhas, `sha256 e396675f…`) |

⇒ commits **após `9e36a90`** (`6cae6ea`, `7e54aac`, `7af9c5c`, `a1958b8`,
`ba98d30`) **NÃO estão em produção**. E o `qrng-nist-api/nist_service.py` de
`main` (1233 linhas, `sha256 c3e4c99f…`) **NÃO** roda — o `:18002` produtivo é a
versão de 503 linhas.

---

## A. IMPLANTADO — `f058f22 → 9e36a90` (nas imagens `9e36a90`)

### `qrng-client-api` (backend `:3010`)

| arquivo | Δ | o que foi para produção |
|---|---|---|
| `lib/provenance.js` | **NOVO** (+116) | `resolveProvenance()` — contrato de proveniência por resposta (item 3). Envelope-versão + block-sha (item 9) e os três eixos de saúde (itens 4/5) **NÃO** estavam em `9e36a90** (vieram depois — seção B). |
| `server.js` | +440 | `resolveProvenance` ligado a `/v1/random` e `/v1/public/random`; `setProvenanceHeaders` em **raw e JSON**; `attachRequestId` (ecoa `X-Request-Id` seguro); 404 catch-all JSON; 413/400 estruturados; handler 500 sem HTML/stack; `LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE` (**NÃO setado em prod** ⇒ `actual_origin=unknown`); `POST /v1/_test/reset-rate-limit` e `/v1/_test/boom` **guardados por `ENABLE_TEST_ROUTES` — não setado em prod ⇒ 404** (confirmado no canário e no smoke). |
| `openapi/*` | +486 | schema `ProvenanceDetail`; `PayloadTooLarge`; 413 em register/login/quota; docs de `X-Request-Id`. |
| `eslint.config.js` | **NOVO** | lint próprio do client-api (CI). |
| `Dockerfile` | +1 | `COPY lib ./lib` (a imagem carrega `lib/provenance.js`). |
| `package.json` / `package-lock.json` | | `eslint` como devDep (pinado). Sem novas deps de runtime. |

### `src/` (frontend — imagem `qrng-web:9e36a90`)

| arquivo | Δ | o que foi para produção |
|---|---|---|
| `lib/qrngHelper.js` | +80 | **`readUint32LE`** (correção de endianness) usado em `bytesToUint32Array`, `uniformIntFromBytes`, `uniformIntsFromBytes`, `fetchQrngRandIntViaToken`. Os bytes **nunca** foram alterados — só a interpretação. |
| `components/data/DataSection.jsx` | +17 | `pickInt` / `genMonteCarlo` passam a usar `readUint32LE`. |
| `components/kapua/KapuaSection.jsx` | +6 | idem (exibição de 1 uint32). |
| `games/visualizations/galaxySpiral.js` / `mandala.js` | +7 / +8 | **`bytes.length ? bytes[i] : rand`** — não troca mais o valor de byte 0 por `Math.random()`. |
| `components/layout/HardwareStatusBar.jsx` | +31 | mostra "origem efetiva" (proveniência). |
| `components/nist/NISTSection.jsx` | +165 | banner "RESULTADO SINTÉTICO", `assessment_execution_valid`, `synthetic_result` na UI. |
| `components/applications/ApplicationsSection.jsx` | +37 | π / máx f(x) — mensagens; geração de chave desabilitada. |
| `contexts/AppContext.jsx` | +9 | proveniência no estado global. |
| `games/statsTests.js`, `download/DataExport.jsx`, `analysis/*`, `developer/*`, `settings/*` | pequenos | ajustes de texto / rótulo; nada funcional crítico. |

**Nada em A** reativa geração de chave/seed/nonce/token (segue **DESABILITADA**),
muda o caminho FPGA, ativa RCT/APT, ou troca o serviço NIST.

## B. EM `main`, NÃO IMPLANTADO — `9e36a90 → ba98d30`

| arquivo | Δ | por que não está em prod |
|---|---|---|
| `lib/provenance.js` | +30 (`7e54aac`) | item 9: consome `X-QRNG-Provenance-Version` + `X-QRNG-Block-SHA256` (regras 6/7). O client-api **não foi reconstruído** desde `9e36a90`. |
| `test/provenance.test.js` | +90 | testes item 9 (15→23). |
| `staging/fixture-upstream/app.py` | +69 | envelope v1 no **fixture de staging** — não é produção. |
| `.github/workflows/ci.yml` | +step | roda `test_stream_tap` no job `physical-layer`. |
| `physical-layer/**` (≈54 arquivos `.md` + scripts) | +14k | documentação, `stream_tap.py` (harness item 8, só replay), `server_api.provenance_patch.py` (referência), `RCT_APT_ARCHITECTURE.md`, resultados da inspeção FPGA, este arquivo. **Zero efeito em runtime.** |
| `qrng-nist-api/nist_service.py` | +680 (rodadas anteriores, já em `f058f22..`? ) | ver nota abaixo. |
| `qrng-nist-api/test/test_nist_service.py` | +382 | idem. |

### Nota sobre `nist_service.py`

A maior parte das +680 linhas do `nist_service.py` entrou entre `f058f22` e
`9e36a90` (rodada `1ca463a` etc.: `_parse_output` de duas trilhas, `_claim_job`
atômico, `assessment_execution_valid`). **Mas o serviço NIST produtivo (`:18002`)
roda na dobslit como processo Python, fora de qualquer deploy de container** — e
**não foi atualizado**. `prod = 503 linhas (sha e396675f…)`, `main = 1233 linhas
(sha c3e4c99f…)`. Substituir o NIST produtivo continua sendo um ponto de
autorização à parte (`NIST_MIGRATION_PLAN.md`).

## C. Staging (compose) — reflete `main`, não produção

`docker compose -f staging/docker-compose.staging.yml` reconstrói `web` +
`qrng-client-api` + `nist-staging` do repo a cada `up --build`. Logo o **staging
já roda `ba98d30`** (incl. envelope v1). É onde os itens 8/9 e agora 2–6 são
exercitados. `e2e/staging/*.spec.js`: **97 testes** (CI #62/#64).

## D. Riscos do que ESTÁ em produção

| risco | avaliação |
|---|---|
| `LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE` não setado | ✅ correto — produção reporta `actual_origin=unknown` / `live_verified=false` (honesto) |
| rotas `/v1/_test/*` | ✅ ausentes — `ENABLE_TEST_ROUTES` não está no env-file de prod (canário + smoke confirmaram 404) |
| endianness LE no frontend | ✅ correção — os `uint32` da UI agora batem com `/v1/uint32`; Monte Carlo permanece válido |
| `provenance_detail` novo no corpo de `/random` | mudança visível de contrato — **aditiva** (campo novo), documentada no OpenAPI implantado |
| geração de chave/seed | ✅ DESABILITADA (`blockedOperational=true` no frontend; sem rota anônima no backend) |
| 18 alertas dependabot no `main` | pré-existentes, deps de build/dev, não embarcadas — `VULNERABILITY_MATRIX.md` |
