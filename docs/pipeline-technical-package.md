# Pacote técnico do pipeline Kapuã QRNG (rodada de estabilização, 2026-08-26)

Este documento é insumo técnico para a futura revisão do Guia do Usuário e da
documentação científica -- **não é, ele mesmo, o Guia do Usuário**, e o Guia
não foi alterado nesta rodada. Todo valor numérico aqui vem de medição
registrada nesta auditoria (script, comando, hash do arquivo avaliado) — não
há estimativa não rastreável.

## 1. Diagrama da arquitetura (estado real, não aspiracional)

```
FPGA Red Pitaya (fifo.c, mmap AXI FIFO 0x43C00000)
  │  htole32(uint32) por amostra, sem whitening/condicionamento
  ▼
qrng-connector.py  (dobslit VM, /home/dobslit/qrng-connector.py)
  │  [NÃO VERSIONADO -- nenhum repositório git rastreia este arquivo]
  ▼
server_api.py "QRNG Broker API" v1.1 (dobslit VM, uvicorn :8001)
  │  [NÃO VERSIONADO -- idem]
  │  expõe /v1/raw, /v1/uint32, /health (STREAM_FORMAT=uint32-le,
  │  SAMPLE_WIDTH_BYTES=4, CONDITIONED=false)
  ▼
qrng-client-api (Bongo VM, Docker, Express, GIT-VERSIONADO)
  │  /v1/random (autenticado)  /v1/public/random (anônimo, cota reduzida)
  │  interpretUpstreamResponse() -- contrato por Content-Type, sem sniffing
  ▼
nginx (host Bongo, /etc/nginx/sites-available/bongo.dobslit.com,
  │     NÃO VERSIONADO NESTE REPOSITÓRIO)
  │  /qrng/v1/random, /qrng/v1/public/random, /qrng/api/random (redireciona
  │  para /v1/public/random desde 2026-08-25), /qrng/v1/docs, /qrng/v1/redoc
  ▼
Frontend React (Bongo VM, Docker nginx, GIT-VERSIONADO)
  │  qrngHelper.js -- adaptador canônico único (hex/base64/uint8 → Uint8Array)
  ├─ Downloads (DataExport.jsx, DataSection.jsx)
  ├─ Visualizações (Análise Estatística, Monte Carlo, Kapuã landing)
  ├─ Aplicações (KeyCard/AISeedCard -- geração operacional DESABILITADA
  │              nesta rodada, ver seção 7)
  └─ Fallback local finito (qrngFallbackData.js, 10.000 bytes, sem
                             wraparound, proveniência "unknown")

Serviço NIST SP 800-90B:
  nist_service.py RODANDO em produção (dobslit VM, PID descoberto nesta
  rodada, NÃO VERSIONADO) -- versão anterior a TODAS as correções desta
  auditoria (item 2, commit 65fb43b, nunca implantada nesse host).
  nist_service.py em qrng-demo-react/qrng-nist-api/ (Bongo VM,
  GIT-VERSIONADO, commit 65fb43b) -- código corrigido, mas NÃO é o que
  está rodando na prática. Ver matriz de confirmação.
```

**Achado crítico desta rodada**: `qrng-connector.py`, `server_api.py` e o
`nist_service.py` que está de fato em execução não vivem em nenhum
repositório git. `server.js.bak.*` commitados por engano (removidos nesta
rodada) sugerem que o hábito de versionamento nesse projeto já teve lacunas
antes. O nome do commit "rodando" em cada componente:

| Componente | Commit rodando |
|---|---|
| qrng-client-api (Bongo, Docker) | `5c6d07a` (branch `main`, antes desta rodada; após o deploy de items 6-8 anteriores) |
| Frontend (Bongo, Docker) | `5c6d07a` (idem) |
| server_api.py (dobslit VM) | **nenhum -- não versionado** |
| qrng-connector.py (dobslit VM) | **nenhum -- não versionado** |
| nist_service.py EM EXECUÇÃO (dobslit VM) | **nenhum -- não versionado, e mais antigo que o commit `94e7dbd` desta mesma auditoria (nunca recebeu nenhuma das correções do item 2)** |
| nginx do host Bongo | **nenhum -- arquivo fora deste repositório git**, editado diretamente nesta e na rodada anterior, com backup manual (`bongo.dobslit.com.bak-20260825-item6-8`) |

## 2. Contrato binário e unidade de amostra

- **Formato de transporte**: `uint32`, **little-endian**, 4 bytes por
  palavra. Confirmado em `fifo.c` (`htole32`) e nos headers HTTP de
  `server_api.py` (`x-qrng-format: uint32-le`, `x-qrng-sample-width: 4`,
  `x-qrng-conditioned: false`).
- **Sem condicionamento**: nenhum whitening, XOR, Von Neumann ou DRBG em
  nenhuma camada auditada (server_api.py declara `CONDITIONED=false`;
  nenhum código de condicionamento foi encontrado ou introduzido).
- **Unidade de amostra para avaliação estatística**: byte (8 bits), por
  decomposição little-endian da palavra uint32 -- `assessment_symbol_width=8`.
  Esta é uma decisão sobre *como avaliar*, não uma alegação de que os 4
  byte-lanes são estatisticamente idênticos entre si (ver seção 4 -- eles
  são semelhantes mas não idênticos, com min-entropia variando de 6,98 a
  7,33 bits/byte entre lanes na mesma captura).

## 3. Formatos de resposta e fórmulas

| Formato | Regra | Round-trip verificado nesta rodada |
|---|---|---|
| `application/octet-stream` | bytes brutos, pass-through estrito | Sim -- `interpretUpstreamResponse()` replay controlado, hash idêntico |
| `hex` | `buf.toString("hex")` / decodificação por par de caracteres | Sim -- hash idêntico após roundtrip |
| `base64` | `buf.toString("base64")` | Sim -- hash idêntico após roundtrip |
| `uint8` | `Array.from(buf)` → JSON | Sim (amostra de 20.000 bytes) |
| Monte Carlo uniforme | `U = uint32 / 2^32`, `0 ≤ U < 1` | Sim -- 0 valores fora de [0,1) em 2.000.000 amostras reais |
| Exponencial | `X = -mean · ln(1 - U)` | Sim -- 0 valores não-finitos ou negativos |

## 4. Live vs. fallback

- **Live**: `isLiveData` no frontend só é `true` após uma checagem de rede
  real confirmar sucesso (ver `AppContext.jsx`). `isOnline` é um flag de UI
  ("seguro habilitar botões"), não uma alegação de dado ao vivo -- a
  confusão entre os dois já causou alegações falsas de "conectado ao
  hardware" corrigidas na rodada anterior (item 5).
- **Fallback**: buffer estático de 10.000 bytes, cursor sem wraparound
  desde a rodada anterior (item 4), esgota com erro explícito, proveniência
  declarada `"unknown"` (não inferida). Nunca alimenta geração de
  chave/seed (bloqueado desde a rodada anterior, e agora a geração
  operacional está bloqueada em QUALQUER fonte -- ver seção 7).

## 5. Estados de saúde

Três conceitos distintos, expostos separadamente desde a rodada anterior
(`AppContext.jsx`, item 5):

- `apiReachable`: o processo respondeu à última tentativa de poll (sem
  hysteresis).
- `freshDataAvailable`: o payload de `/health` reportou buffer com bytes
  disponíveis agora.
- `sourceConnected`: proxy = `apiReachable && freshDataAvailable`, na
  ausência de um campo dedicado no `/health` do broker que confirme
  diretamente "o pipeline físico está entregando" -- documentado como
  lacuna real, não escondida.

RCT/APT (health tests contínuos do SP 800-90B) **não estão implementados**
em nenhuma camada -- thresholds calculados nesta rodada (seção 6) para uma
implementação futura, não implementados agora (mudança em código não
versionado, fora do escopo seguro desta rodada).

## 6. Escopo exato do assessment NIST realizado nesta rodada

- Suíte oficial `SP800-90B_EntropyAssessment` (dobslit VM,
  `/home/dobslit/SP800-90B_EntropyAssessment/cpp/ea_iid` e `ea_non_iid`).
- Executada sobre **cada byte-lane separadamente** (não sobre o stream
  combinado, que não foi julgado justificável sem antes confirmar
  compatibilidade entre lanes -- ver seção "unidade de amostra" no
  relatório final).
- IID: todas as 4 lanes passaram (chi-square, comprimento da maior
  substring repetida, testes de permutação IID). H_original entre 7,872 e
  7,883 bits/byte.
- Não-IID (estimativa conservadora): H_original=7,354–7,872,
  H_bitstring=0,872–0,993, `min(H_original, 8×H_bitstring)` **entre 6,978
  e 7,332 bits/byte** -- este é o número que deve ser citado como
  min-entropia estimada da fonte, não o H_original do track IID.
- **NÃO executado nesta rodada**: restart campaign (1.000×1.000, exigiria
  reinicializações controladas da FPGA -- registrado como bloqueio, não
  simulado). Stream combinado de 32 bits (não justificado sem antes provar
  independência entre lanes de forma mais completa).

## 7. Restrição de aplicações criptográficas (item 8)

Geração operacional de chave e seed (`KeyCard`, `AISeedCard` em
`ApplicationsSection.jsx`) **desabilitada incondicionalmente** nesta
rodada -- não apenas na fonte de fallback como antes. Reversão exige, no
mínimo: restart campaign concluída, RCT/APT implementados e operacionais,
e uma nova avaliação de min-entropia sobre uma captura pós-implementação.

## 8. Limitações conhecidas (não escondidas)

1. `qrng-connector.py`, `server_api.py` e o `nist_service.py` em execução
   real não são versionados -- nenhuma correção de código feita em
   `qrng-demo-react` (incluindo o item 2 da auditoria anterior) chega a
   esses processos sem um passo de deploy manual que não foi executado.
2. Restart campaign SP 800-90B não realizada (bloqueio de infraestrutura).
3. RCT/APT não implementados (thresholds calculados, não implementados).
4. `sourceConnected` é um proxy, não um sinal direto do broker.
5. Nenhum teste E2E de navegador real (Playwright/Cypress) existe neste
   repositório -- só testes de componente (`vitest` + `@testing-library/react`).
6. Config nginx do host não é versionada neste repositório git (editada
   diretamente, com backup manual).
7. Desvio estatístico real (não catastrófico) confirmado em 2 capturas
   independentes -- ver relatório final para os números completos e para
   a distinção entre "desvio real" e "fonte inutilizável".

## 9. URLs (staging = produção real neste projeto; não há staging separado)

- Portal: `https://bongo.dobslit.com/qrng/` (requer cookie de sessão)
- Swagger: `https://bongo.dobslit.com/qrng/v1/docs/`
- ReDoc: `https://bongo.dobslit.com/qrng/v1/redoc`
- OpenAPI JSON (público): `https://bongo.dobslit.com/qrng/v1/openapi.json`
- OpenAPI JSON (admin, requer JWT admin): `https://bongo.dobslit.com/qrng/v1/internal/admin-openapi.json`

## 10. Alegações permitidas vs. proibidas (aplicado nesta rodada)

**Permitido, com evidência**: "bytes brutos uint32-LE, sem condicionamento
(confirmado no código-fonte)"; "min-entropia estimada entre 6,98 e 7,33
bits/byte por byte-lane (SP 800-90B, faixa não-IID, captura de
2026-08-25)"; "testes de permutação IID não rejeitados nas 4 lanes
avaliadas" (com a ressalva explícita de que isso não é prova de
independência).

**Proibido, e corrigido nesta rodada onde encontrado**: "8 bits de
entropia por byte" (falso -- ver seção 6); "pronto para uso em aplicações
criptográficas" (falso enquanto a validação estiver incompleta); "100%
aleatório"; "certificado pelo NIST"; "IID comprovado"; "origem quântica
comprovada por histograma"; "fonte live" quando o dado for histórico ou
fallback.
