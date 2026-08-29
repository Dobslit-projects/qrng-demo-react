# Kapuã — Matriz de evidências do Guia do Usuário

**Data:** 2026-08-29 · **Branch:** `docs/guia-usuario-kapua-20260829` (base `main` = `51c1a2d`)
**Produção documentada:** frontend `qrng-web:9e36a90` · API `qrng-client-api:4137bfe` · portal `https://bongo.dobslit.com`
**Guia anterior preservado:** `docs/_acceptance/PRIOR_Guia_Usuario_Kuapoa_QRNG.docx`
SHA-256 `1cc904c9c3eef07d1f66fb1bc38509659967cf90fd2d413779f7c5aae2dcfd07` (grafia antiga "Kuapoa" no nome do arquivo — mantida só como referência; o conteúdo incorreto não foi reaproveitado).

Cada afirmação técnica relevante do guia tem uma origem verificável abaixo.

| # | Afirmação do guia | Código/endpoint | Teste / verificação | Evidência | Estado |
|---|---|---|---|---|---|
| 1 | O portal fica em `https://bongo.dobslit.com`; SPA React servida por nginx | `docs/_acceptance/portal.html`, `body_portal_root.out` | aceitação: `GET /` → 302 → SPA `<title>Kapuã</title>` | `docs/_acceptance/portal.html` | CONFIRMADO |
| 2 | Frontend em produção = imagem `qrng-web:9e36a90` | `docker ps` na Bongo | `docker ps --format` | `qrng-web-1  qrng-web:9e36a90  Up 20 hours` | CONFIRMADO |
| 3 | API em produção = imagem `qrng-client-api:4137bfe` (envelope de proveniência v1) | `docker ps` na Bongo; corpo de `/random` traz `provenance_version:"1"` | `docker inspect`, aceitação | `qrng-client-api  qrng-client-api:4137bfe  Up 2 hours` | CONFIRMADO |
| 4 | `main` real = `51c1a2d` (o `6cae6ea` citado no pedido está 2 commits atrás) | `git ls-remote origin` na Bongo | — | `51c1a2d… refs/heads/... ` | CONFIRMADO |
| 5 | A API entrega **bytes**; `TRANSPORT UNIT = byte` | `qrng-client-api/server.js`; OpenAPI `/random` | aceitação raw: `Content-Length = N` | `docs/_acceptance/` (public/raw 16 B) | CONFIRMADO |
| 6 | 4 formatos: `raw`, `hex`, `base64`, `uint8` — mesmos bytes | `src/lib/qrngHelper.js`; OpenAPI `RandomResponse` | `docs/_acceptance/format_equivalence_check.mjs` (14/14) + notebook célula 6 | `format_equivalence_result.txt`, `notebook_cells_run.txt` | CONFIRMADO |
| 7 | `N` bytes solicitados = `N` bytes entregues | idem | check 1/9; notebook `assert len(raw)==N`; `assert len(arr)==N` | `format_equivalence_result.txt` | CONFIRMADO |
| 8 | `uint32` é lido em **little-endian**; `= DataView.getUint32(i,true)` | `src/lib/qrngHelper.js:244`; `qrngHelper.test.js` (regressão R1) | `npm test` (80/80); `format_equivalence_check.mjs` (LE≠BE, LE==DataView) | vitest saída; `format_equivalence_result.txt` | CONFIRMADO |
| 9 | Buffer não múltiplo de 4 → bytes finais descartados do array de uint32 | `bytesToUint32Array` (`i+3 < len`); `qrngHelper.test.js` "ignora resto não múltiplo de 4" | `npm test` | vitest | CONFIRMADO |
| 10 | Raw = `application/octet-stream`, sem BOM, sem prefixo | `server.js` rota raw; `src/lib/qrngHelper.js` (`decodeRawResponse`) | aceitação: header `Content-Type: application/octet-stream`; notebook `assert not raw[:3]==BOM` | `docs/_acceptance/` (public/raw) | CONFIRMADO |
| 11 | Hex = 2 chars/byte, `[0-9a-f]` | `fmtHex`, `decodeQrngJsonResponse` | `format_equivalence_check.mjs`; notebook célula 3 | `format_equivalence_result.txt` | CONFIRMADO |
| 12 | uint8 = array JSON de inteiros 0–255 de tamanho N | `server.js`; OpenAPI | aceitação `format=uint8`; notebook célula 5 | `docs/_acceptance/b_pub_uint8`, `notebook_cells_run.txt` | CONFIRMADO |
| 13 | base64 decodifica para os mesmos N bytes | `server.js`; `Buffer.from(...,"base64")` | `format_equivalence_check.mjs`; notebook célula 4 | `format_equivalence_result.txt` | CONFIRMADO |
| 14 | SHA-256 idêntico entre os 4 formatos para a mesma amostra | `format_equivalence_check.mjs` (fixture) + notebook célula 6 (amostra live única) | execução | `format_equivalence_result.txt` (`sha256=33efd4a8…`), `notebook_cells_run.txt` (`9af0a544…`) | CONFIRMADO |
| 15 | Chamadas live independentes retornam sequências diferentes (não comparar) | aceitação: 3 chamadas → `seq` e `random` distintos | execução | `86155da2…`, `af608bd6…`, `a82d03b0…` | CONFIRMADO |
| 16 | Monte Carlo (Dados) e π (Aplicações): `u = x/2³²`, `x,y ∈ [0,1)` | `data/DataSection.jsx:74`; `applications/ApplicationsSection.jsx:297-306` | leitura de código; `qrngHelper.test.js` (`uint32ToFloat < 1` para `0xFFFFFFFF`) | vitest | CONFIRMADO |
| 17 | π: `π̂ = 4·inside/nPoints`; 8 bytes/ponto; canvas/contador/valor do mesmo laço | `applications/ApplicationsSection.jsx` `MonteCarloCard` | leitura de código | `VISUALIZATION_DATA_FLOW.md` §3.4 | CONFIRMADO |
| 18 | Nenhum zero é substituído por PRNG | `galaxySpiral.js:8-12`, `mandala.js:78-81` (`?? 0`; `Math.random` só se `bytes.length===0`) | leitura de código | `VISUALIZATION_DATA_FLOW.md` §1, tabela §2 | CONFIRMADO |
| 19 | Faixa personalizada usa rejection sampling (sem modulo bias) | `pickInt`, `uniformIntFromBytes`, `uniformIntsFromBytes` | `qrngHelper.test.js` ("substitui 'byte % range'", `range=100`) | vitest | CONFIRMADO |
| 20 | Distribuição exponencial: `X = −μ·ln(1−u)`, parâmetro = média `μ`, `u=0`→0, `u<1` sempre | `src/lib/qrngHelper.js:262` (`exponentialFromUniform`) | `qrngHelper.test.js` | vitest | CONFIRMADO — **mas sem tela dedicada em produção** (função só na biblioteca) |
| 21 | Testes de badge (monobit/runs/Chi²/Shannon) são heurística de navegador, não SP 800-90B, não min-entropia | `games/statsTests.js` | leitura de código | `VISUALIZATION_DATA_FLOW.md` §4 | CONFIRMADO |
| 22 | Comparação PRNG × QRNG: LCG `(s·1103515245+12345) mod 2³²`, quantizado a 8 níveis nas viz | `src/prng.js`, `games/QuantumVisualizer.jsx:34-45` | leitura de código | — | CONFIRMADO |
| 23 | Fallback `Math.random()` nas viz interativas é rotulado na UI | `games/QuantumVisualizer.jsx:126-135` | leitura de código | rótulo "QRNG · Math.random() — erro de rede / pré-coletado esgotado" | CONFIRMADO (ressalva: rótulo discreto — recomendação R1) |
| 24 | Fonte "Pré-coletado" = 10 000 bytes estáticos, proveniência `unknown`, sem wraparound, não é medida ao vivo | `src/qrngFallbackData.js`, `src/lib/qrngHelper.js:35-114`, `layout/FallbackBanner.jsx` | `AppContext.test.jsx`; `qrngHelper.test.js` | vitest (22 + 58) | CONFIRMADO |
| 25 | Token = `Authorization: Bearer <token>`; formato `dobslit_qrng_live_<hex>`; não expira; rotacionável/revogável | OpenAPI `securitySchemes.bearerAuthToken`; `TokenIssued`; `src/components/developer/*` | leitura de OpenAPI + código | `docs/_acceptance/openapi.json` | CONFIRMADO |
| 26 | Token autentica e mede cota; **não** altera/condiciona/melhora os bytes | `server.js` (repassa do upstream); `X-QRNG-Conditioned: false` | aceitação raw header; leitura | `docs/_acceptance/` | CONFIRMADO |
| 27 | Sem token: `/v1/public/random` (≤64 KiB, ~20 req/60 s/IP); com token: `/v1/random` (≤1 MiB) | OpenAPI; headers `RateLimit-Policy: 20;w=60` | aceitação: 413 público em `bytes=99999999`; header de rate limit | `docs/_acceptance/b_err_413`, run de aceitação | CONFIRMADO (limites); 429 **não** reproduzido (ver #34) |
| 28 | Erros estruturados: `{request_id, error, message}` | OpenAPI `ErrorResponse`; `server.js` | aceitação: 401/403/404/413/422 | `docs/_acceptance/b_err_*` | CONFIRMADO |
| 29 | 401 `MISSING_TOKEN` (sem header) vs 403 `INVALID_TOKEN` (token ruim) | `server.js` middleware de auth | aceitação + notebook célula 10 | `notebook_cells_run.txt` | CONFIRMADO |
| 30 | Proveniência por resposta: `provenance` / `provenance_detail` no JSON e `X-QRNG-*` no raw | `qrng-client-api/lib/provenance.js`; `server.js` `setProvenanceHeaders` | aceitação: headers `X-QRNG-Provenance`, `-Live-Verified`, etc. em JSON e raw | run de aceitação (seções 2 e 3) | CONFIRMADO |
| 31 | Produção reporta hoje, de propósito: `provenance="unknown"`, `live_verified=false`, `captured_at=null` | `lib/provenance.js` (default `allowLiveWithoutCaptureEvidence=false`) | aceitação: todas as respostas | `b_pub_*`, run de aceitação, `python_example_run.txt`, `notebook_cells_run.txt` | CONFIRMADO |
| 32 | `unknown` nunca é representado como `live` (frontend e exemplos) | `HardwareStatusBar.jsx:35-45`; `lib/provenance.js` (regras duras); `docs/examples/*` (`show_provenance`) | leitura + execução dos exemplos | `python_example_run.txt` ("NÃO é uma captura live verificada") | CONFIRMADO |
| 33 | Geração criptográfica indisponível (`/v1/entropy`, `/v1/random/cryptographic`, `/keys`, `/seed`, `/nonce`) | rotas ausentes | aceitação: todas → 404 | run de aceitação (seção crypto) | CONFIRMADO |
| 34 | Erro 429 (cota/rate limit) | OpenAPI documenta 429; `error-contract.test.js` (CI) | aceitação: **não reproduzido** com flood curto (25 req/~15 s todas 200); a diretiva proíbe carga significativa | headers `RateLimit-*` observados | NÃO EXECUTADO (registrado) |
| 35 | Erro 503 (`INSUFFICIENT_ENTROPY` / upstream indisponível) | OpenAPI; `server.js` `interpretUpstreamResponse` | não reproduzível sem derrubar o upstream (fora de escopo) | OpenAPI | NÃO EXECUTADO (registrado) |
| 36 | Swagger em `/qrng/v1/docs/`, ReDoc em `/qrng/v1/redoc`, OpenAPI JSON em `/qrng/v1/openapi.json` | `server.js` | aceitação: `docs/`→200, `redoc`→200, `openapi.json`→200 | run de aceitação | CONFIRMADO |
| 37 | Página NIST: motor real `sp800-90b-reference`, `synthetic_result=false`, `live_capture_configured=false`, upload ≤128 MiB (`.bin/.csv/.txt`) | `GET /qrng/nist/health` | aceitação | run de aceitação (nist health) | CONFIRMADO |
| 38 | NIST: IID e não-IID são trilhas; resultado pertence à amostra; `h_min_non_iid = min(H_original, 8·H_bitstring)` | `src/components/nist/NISTSection.jsx` | leitura de código | — | CONFIRMADO |
| 39 | 3 eixos de saúde: `transport_health`, `buffer_health`, `entropy_health` (default `not_assessed`) | `lib/provenance.js`; headers | aceitação: `X-QRNG-Transport/Buffer/Entropy-Health` | run de aceitação | CONFIRMADO |
| 40 | `buffer_health="discontinuous"` / `X-QRNG-Discontinuities=256` em produção hoje | `server_api.py` v1.2 conta todo `drop_oldest` | aceitação | `b_pub_*` (`discontinuities:256`) | CONFIRMADO (limitação conhecida — ver guia §29) |
| 41 | Testes do frontend passam (80) | `npm test` | execução local | vitest: `2 passed (2)`, `80 passed (80)` | CONFIRMADO |
| 42 | Testes da API (`qrng-client-api`) | `node --test` | **não executável localmente** (`better-sqlite3` nativo não compilado p/ Node 22.17/Windows); CI Node 20 é a referência | erro `MODULE_NOT_FOUND`/binding | NÃO EXECUTADO localmente (registrado) |
| 43 | Exemplo Python roda contra a produção (caminho público) | `docs/examples/kapua_api_example.py` | execução | `docs/_acceptance/python_example_run.txt` | CONFIRMADO |
| 44 | Notebook Jupyter roda célula a célula (caminho público, sem token real) | `docs/examples/kapua_jupyter_example.ipynb` | células extraídas e executadas | `docs/_acceptance/notebook_cells_run.txt` | CONFIRMADO |

## Bugs / achados

| ID | Severidade | Descrição | Arquivo | Reprodução | Correção | Estado |
|---|---|---|---|---|---|---|
| B1 | textual | Nomes de arquivo de download da aba Dados usam a grafia **`kuapua_qrng_*`** em vez de `kapua_qrng_*` | `src/components/data/DataSection.jsx:327,330,335,343,348` | gerar qualquer download na aba Dados | trocar prefixo para `kapua_qrng_` + teste de regressão | **NÃO CORRIGIDO nesta etapa** (mudança de frontend; ver recomendação) |
| B2 | cosmético | `DataExport.jsx` gera `qrng_<n>.bin` (sem o nome do produto) — inconsistente com a aba Dados | `src/components/download/DataExport.jsx:427` | download em massa | padronizar `kapua_qrng_<n>.bin` | NÃO CORRIGIDO |
| B3 | cosmético/UX | Cards "Chave Quântica" e "Seed para IA" exibem badge **"Funcional"** apesar de a geração estar desabilitada (`blockedOperational=true`) | `src/components/applications/ApplicationsSection.jsx:165,226` | abrir aba Aplicações | trocar badge para "Indisponível" enquanto bloqueado | NÃO CORRIGIDO |
| B4 | UX / clareza | Fallback `Math.random()` nas Visualizações Interativas fica só no rótulo "QRNG · Math.random() — …"; o título da coluna continua "QRNG" | `src/components/games/QuantumVisualizer.jsx:126-135,470` | desconectar a rede e abrir Visualizações Interativas | banner explícito de fallback (como o `FallbackBanner` global) | NÃO CORRIGIDO |
| B5 | doc/observação | `bytesToDiscreteFloats` divide por **255** (não 256) → a Análise Estatística pode produzir `1.0` inclusive; o Histograma trata (clamp no último bin), Scatter/bits toleram | `src/lib/qrngHelper.js:277`; `qrngHelper.test.js:133` (comportamento **testado**, intencional) | — | nenhuma (documentar); se quiser `[0,1)` estrito, dividir por 256 | INTENCIONAL — documentado |
| B6 | ambiente | Suíte de testes do `qrng-client-api` não roda localmente (`better-sqlite3` binding ausente para Node 22.17/Windows) | `qrng-client-api/test/` | `npm test` em `qrng-client-api/` | rodar em Node 20 / CI; ou `npm rebuild better-sqlite3` | ambiente local; CI é a referência |

Nenhum bug **funcional** que invalide o contrato de bytes, a interpretação `uint32-LE`, o Monte Carlo `[0,1)`, o cálculo de π, o rejection sampling ou a proveniência foi encontrado. Os achados são textuais/cosméticos/UX/ambiente.

## Seções do guia bloqueadas por divergência funcional

Nenhuma. As correções B1–B4 são recomendações; enquanto não forem implantadas, o guia **descreve o comportamento atual** (com os nomes de arquivo `kuapua_*` / `qrng_*.bin` como estão em produção) e registra a recomendação numa nota.
