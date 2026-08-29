# Rodada 2026-08-29 — integridade do transporte, saúde em 3 eixos, caracterização NIST

**Branch = `main` = `origin/main` = `6cdb043`.** Código em produção: imagens
`qrng-client-api:9e36a90` / `qrng-web:9e36a90` (deploy 2026-08-28) —
**inalteradas nesta rodada.** Tudo aqui é staging / referência / documentação /
caracterização.

Escopo autorizado: (1) confirmar CI + auditar o diff de `main`; (2) alinhamento
do connector em staging; (3) offset + realinhamento + descontinuidade no ring
buffer em staging; (4) `Captured-At` → `Received-At`; (5) separar saúde em
transporte / buffer / entropia; (6) testar com desconexões determinísticas;
(7) obter o RTL/Vivado e documentar a unidade da amostra; (8) campanha NIST
completa **apenas como caracterização do transport stream**.

---

## 1. CI e auditoria do diff de `main`

- **CI #62 (`a1958b8`), #64 (`ba98d30`): success, 5/5 jobs.** #65 (`6cdb043`):
  *(a confirmar na API do GitHub)*. Reexecução do fluxo CI de staging na VM em
  `6cdb043`: **101 passed** (97 + 4 casos novos itens 4/5/6 em `provenance.spec.js`)
  + `test_transport_align` 11/11 + `provenance.test.js` 32/32.
- Auditoria completa: **`physical-layer/MAIN_DIFF_AUDIT.md`**. Resumo:
  - **Em produção (imagens `9e36a90`, range `f058f22..9e36a90`):** per-response
    provenance no `server.js` + `provenance.js` (item 3); `readUint32LE` (LE) no
    frontend; fix `bytes[i] || rand` em galaxy/mandala; banners NIST sintético;
    `HardwareStatusBar` "origem efetiva". `LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE`
    **não setado** → `actual_origin=unknown`. Rotas `/v1/_test/*` **ausentes**
    (`ENABLE_TEST_ROUTES` não no env de prod → 404).
  - **Em `main`, NÃO implantado (`9e36a90..6cdb043`):** envelope v1 (item 9),
    itens 4/5/2/3/6 desta rodada, `staging/fixture-upstream`, docs. Client-api
    **não reconstruído** desde `9e36a90`.
  - **NIST produtivo (`:18002`, dobslit): NÃO tocado.** `prod = 503 linhas
    (sha e396675f…)`; `main = 1233 linhas (sha c3e4c99f…)`.

## 2. Alinhamento do connector (staging — NÃO implantado)

`physical-layer/qrng-connector.staging.py`. O que roda na dobslit continua sendo
`qrng-connector.py` (baseline). A versão de staging, **sem mudar o payload de
bytes**:

- `total_forwarded` monótono (bytes de palavra completa repassados);
- **sideband JSONL** (`QRNG_CONNECTOR_EVENTS`, fora do stream) com
  `{"event":"connect|reconnect|disconnect","forwarded_offset":N,"ts":...,
  "backoff_s":B,"prev_conn_bytes":M}`;
- segura a cauda de palavra incompleta (0–3 bytes) **dentro** de uma conexão →
  o leitor a jusante nunca vê uma palavra torturada no meio de um `read()`.

Reconexão continua **não recuperando** bytes perdidos na rede (impossível sem
número de sequência da FPGA — `fifo.c` não emite) — mas a perda é **registrada**
e o grid é **re-encaixado** a jusante (item 3).

## 3. Offset + realinhamento + descontinuidade (staging — NÃO implantado)

`physical-layer/transport_align.py` (`WordAligner`) + `test_transport_align.py`
(**11 testes, no CI**). Contrato:

| capacidade | detalhe |
|---|---|
| `stream_offset` monótono | bytes de palavra completa entregues; sobrevive ao drop-oldest |
| só palavras completas | segura 0–3 bytes de cauda; nunca entrega palavra parcial |
| realinhamento | numa reconexão em `forwarded_offset` com resto ≠ 0, descarta `(4 − resto) % 4` bytes do próximo dado → re-encaixa o grid uint32. Custa 0–3 bytes; **não recupera** o que se perdeu na rede |
| descontinuidade | `Discontinuity{kind: reconnect \| realign \| drop_oldest, at_offset, bytes_dropped, ts}` num anel — exposta nos headers, **nunca** no stream |
| sem mutação / sem framing | a saída é sempre um subconjunto contíguo dos bytes da fonte; nenhum byte inventado; nenhum delimitador/prefixo |

Integração (patch de referência `server_api.provenance_patch.py`, **não
aplicado**): o produtor do `server_api.py` drena o sideband do connector e chama
`aligner.note_reconnect(N)` / `note_drop_oldest(D)`; o `pop_with_prov` devolve
`(data, seq_before, discont_count, realign_bytes)`.

## 4. `Captured-At` → `Received-At`

`X-QRNG-Captured-At` era `last_push_time` do ring buffer — **instante em que o
broker RECEBEU os bytes**, não a detecção física. Renomeado para
**`X-QRNG-Received-At`**. `X-QRNG-Captured-At` só será emitido quando a FPGA
carimbar de fato (exige RTL — bloqueado). No `provenance.js`:
`sample_age_ms` = idade por `captured_at || received_at`; **`live_verified=true`
só com `captured_at` (carimbo físico) presente e fresco** — `received_at`
sozinho dá frescor mas não "verificado".

Alterado: `staging/fixture-upstream/app.py` (emite `X-QRNG-Received-At`,
`captured_at=null`), `qrng-client-api/lib/provenance.js` (+ campo `received_at`),
`server.js` `setProvenanceHeaders` (+ `X-QRNG-Received-At`),
`server_api.provenance_patch.py` (ref). **Não implantado.**

## 5. Saúde em 3 eixos ortogonais

`resolveProvenance` passa a retornar **três eixos independentes**:

| eixo | fonte | valores | bloqueia `live`? |
|---|---|---|---|
| `transport_health` | `X-QRNG-Source-Status` + poller | `healthy`/`degraded`/`failed`/`unknown` | `failed` sim |
| `buffer_health` | `X-QRNG-Discontinuities`, insufficient, sha-mismatch | `healthy`/`discontinuous`/`degraded`/`unknown` | ≠ `healthy` sim |
| `entropy_health` | `X-QRNG-Entropy-Health` (default **`not_assessed`**) | `not_assessed`/`healthy`/`degraded`/`failed` | só `failed` sim |

**Invariante testada:** `transport_health=healthy` + `buffer_health=healthy`
**NÃO** implica `entropy_health` — este NUNCA é inferido dos outros dois. RCT/APT
não rodam no caminho live → `entropy_health="not_assessed"` sempre, hoje. Um
`entropy_health="failed"` derruba `actual_origin` de `live`; `not_assessed` e
`degraded` **não** (live = proveniência, não é validação de entropia).
`source_health` mantido como **alias deprecado** de `transport_health`.
`provenance.test.js`: **23 → 32** (9 casos itens 4/5).

## 6. Desconexões determinísticas — testes

`test_transport_align.py` (unit, no CI) + `e2e/staging/provenance.spec.js`
(staging, 5 casos novos):

| vetor | verificação |
|---|---|
| corte em N, `N % 4 = 0`, perda 8 B (2 palavras exatas) | grid mantém alinhamento; `reconnect` registrado, **sem** `realign` |
| corte em N, `N % 4 = 2`, retoma do byte N | descarta 2 B; `as_u32(out)[0]` volta a bater com a palavra lógica; `realign` registrado |
| `N % 4 ∈ {1,3}` | descarta 3 / 1 B; grid re-encaixa |
| realinhamento atravessa múltiplos `feed()` | `pending_realign_bytes` decresce corretamente |
| drop-oldest | vira `Discontinuity(kind=drop_oldest)` |
| sideband JSONL do connector | `reconnect` no JSONL dispara `note_reconnect` no aligner |
| e2e: `_ctl/entropy_health=failed` | `provenance_detail.entropy_health=failed`, nunca `live` |
| e2e: `_ctl/discontinuity?inc=2` | `X-QRNG-Discontinuities>0`, `buffer_health=discontinuous`, nunca `live` |
| e2e: stale | `sample_age_ms` grande via `received_at`; `captured_at=null` |

Suíte Playwright de staging após as mudanças: **101 passed** (VM, fluxo CI, `6cdb043`).

## 7. RTL / Vivado — NÃO OBTIDO

Busca em `10.0.10.2` (FPGA), `192.168.0.42` (dobslit) e `2.24.117.58` (Bongo):
**nenhum `.xpr`/`.bd`/`.v`/`.vhd`/`.tcl` de `stream_app`** em qualquer host
acessível. `stream_app.bit.bin` está só como binário na FPGA
(`/root/stream_app.bit.bin`, 2 083 744 B). O projeto-fonte está com o **dono do
design** (repositório privado / máquina de desenvolvimento não mapeada).

**Unidade da amostra — o que dá para afirmar hoje** (`fifo.c` + PG080):

```
PALAVRA DE TRANSPORTE = 1 read de RDFD (0x11000) do AXI4-Stream FIFO
                        = 1 uint32 little-endian = 4 bytes, FIXO.
                        (fifo.c: num=*(axi+0x11000/4); le=htole32(num); write(&le,4))
AMOSTRA FÍSICA        = INCONCLUSIVA. Se o RTL empacota N sub-amostras do ADC
                        por palavra, ou decima por um fator D, a amostra física
                        ≠ palavra de 32 bits. ADC de RF: 125 MS/s / 14 bit;
                        decimação: desconhecida.
CONDICIONAMENTO       = nenhum no fifo.c (RDFD cru -> write). No RTL:
                        INCONCLUSIVO (não descartável sem o design).
TAXA FÍSICA           = INCONCLUSIVA. Vazão de transporte medida: 699 kB/s ≈
                        174 805 uint32/s.
```

**Necessário:** o repositório do design FPGA (`.xpr` + RTL + constraints) OU um
relatório do dono do design com: fenômeno físico e fotodetector; taxa do ADC;
fator de decimação; existência/ausência de whitening/XOR/LFSR no RTL; como uma
palavra de 32 bits é montada (1 amostra de 32 bit? 2×16? 4×8? amostras
sucessivas?). Ver `FPGA_INSPECTION_RESULT.md`.

## 8. Campanha NIST — CARACTERIZAÇÃO DO TRANSPORT STREAM

> **Isto NÃO é validação da fonte.** É a caracterização estatística SP 800-90B
> dos **bytes do transporte** (o que chega ao `server_api.py`), no stream
> intercalado e nas 4 byte-lanes, para cada captura real
> (`characterization_2026/run_new_01..05.bin`). A **unidade de símbolo é o byte
> de 8 bits do transporte**, não a amostra física (item 7). Restart tests e
> health tests continuam **separados e não executados**. **SP 800-90B completo:
> NÃO.**

- Ferramenta: `ea_iid`/`ea_non_iid` @ `87c104d0`, imagem
  `kapua-staging-nist-real:local`, `bits_per_symbol=8`. Uma passada por arquivo.
- Amostras (SHA-256 verificado dobslit→Bongo):
  `run_new_01.bin` `3021cbf1…` (1 MiB), `run_new_02.bin` `a75d0752…` (1 MiB),
  `run_new_03.bin` `5d30cfab…` (10 MiB), `run_new_04.bin` `5f99d109…` (10 MiB),
  `run_new_05.bin` `968b9465…` (50 MiB).
- Rodando como `nistfull.service` (`/root/nist_full/`). `ea_iid` em arquivos
  ≥ 10 MiB deve estourar o `timeout 2400 s` → registrado como **INCONCLUSIVO
  (timeout)**, coerente com o piloto L0.

**Resultado PARCIAL (2026-08-29 ~03:00 UTC — run_new_01 e run_new_02 concluídos;
run_new_03/04/05 em andamento).** Atualização final em
`/root/nist_full/results/_summary.json` na VM.

| captura / recorte | tamanho | Trilha IID | `h_min` não-IID (bits/símbolo de 8 bits) | `H_original` | `8·H_bitstring` |
|---|---|---|---|---|---|
| **run_new_01.full** (intercalado) | 1 MiB | **FAIL** (permutação) | **6.951334** | 7.210061 | 6.951334 |
| run_new_01.L0 | 256 KiB | **PASS** | 6.825924 | 7.381050 | 6.825924 |
| run_new_01.L1 | 256 KiB | **PASS** | 6.650033 | 7.381050 | 6.650033 |
| run_new_01.L2 | 256 KiB | **PASS** | 6.899834 | 7.377264 | 6.899834 |
| run_new_01.L3 | 256 KiB | **PASS** | 6.694475 | 7.371603 | 6.694475 |
| **run_new_02.full** (intercalado) | 1 MiB | **FAIL** (permutação) | **6.878090** | 7.179165 | 6.878090 |
| run_new_02.L0 | 256 KiB | **PASS** | 6.865767 | 6.920430 | 6.865767 |
| run_new_02.L1 | 256 KiB | **PASS** | 6.734915 | 7.396298 | 6.734915 |
| run_new_02.L2 | 256 KiB | **PASS** | **6.491161** ← menor até agora | 7.375374 | 6.491161 |
| run_new_02.L3 | 256 KiB | **PASS** | 6.829235 | 7.371603 | 6.829235 |

**Observações (caracterização do transporte, não validação):**
- O stream **intercalado** falha IID em ambas as capturas (consistente com o L0
  e com "hipótese compatível com diferenças entre lanes").
- As **byte-lanes** passam IID isoladamente, mas dão `h_min` não-IID **menores**
  que o intercalado — algumas byte-lanes chegam a **≈ 6,49 bits/símbolo de 8
  bits** (`run_new_02.L2`). Em todas, o **estimador limitante é a trilha
  bitstring** (`8·H_bitstring < H_original`). Ou seja: caracterizar por lane é
  **mais conservador** que caracterizar o intercalado.
- `ea_iid` em `run_new_03/04` (10 MiB) e `run_new_05` (50 MiB): deve estourar o
  `timeout 2400 s` → **INCONCLUSIVO (timeout)** para o IID desses; o `ea_non_iid`
  e as lanes (≤ 13 MiB) devem concluir.

Normalização `_u32.txt → .bin`: verificada byte-idêntica ao `.bin`
correspondente (o parser de texto do transporte não altera os dados) — checagem
no fim do script.

---

## Tabela de respostas

| Pergunta | Resposta | Evidência | Limitação |
|---|---|---|---|
| O diff de `main` foi auditado? | **SIM** | `MAIN_DIFF_AUDIT.md`; CI #62/#64 verde | #65 (`6cdb043`) a confirmar |
| O connector garante alinhamento após reconexão? | **Parcial** — só entrega palavras completas + registra a reconexão no sideband; o **realinhamento** é feito a jusante (item 3). Não recupera bytes perdidos na rede | `qrng-connector.staging.py` + `transport_align.py` + 11 testes | não implantado; sem sync da FPGA a perda não é quantificável |
| O ring buffer expõe offset, realinhamento e descontinuidade? | **SIM (staging)** — `X-QRNG-Sequence` (offset monótono), `X-QRNG-Realign-Bytes`, `X-QRNG-Discontinuities` + anel de `Discontinuity` | `transport_align.py`; `server_api.provenance_patch.py` (ref) | não implantado |
| `Captured-At` foi corrigido? | **SIM** — → `X-QRNG-Received-At` (recepção no broker). `captured_at` = null até a FPGA carimbar | `provenance.js`, fixture, patch | carimbo físico exige RTL |
| Saúde separada em transporte/buffer/entropia? | **SIM** — 3 eixos ortogonais; `entropy_health` nunca inferido dos outros | `provenance.js`; `provenance.test.js` 32 | não implantado |
| Desconexões determinísticas testadas? | **SIM** — `N % 4 ∈ {0,1,2,3}`, perda 0–8 B, + drop-oldest + sideband | `test_transport_align.py` 11 + `provenance.spec.js` +5 | staging/replay |
| RTL/Vivado obtido? | **NÃO** — não está em nenhum host acessível | busca em FPGA/dobslit/Bongo | com o dono do design |
| Unidade da amostra documentada? | **Palavra de transporte = 1 uint32-le = 1 read de RDFD (fixo).** Amostra física: **INCONCLUSIVA** (decimação/empacotamento no RTL) | `fifo.c` + PG080 | precisa do design FPGA |
| Campanha NIST executada? | **Em andamento como CARACTERIZAÇÃO DO TRANSPORT STREAM.** Parcial: run_new_01/02 (intercalado FAIL IID; lanes PASS IID; **menor h_min não-IID ≈ 6,49 bits/byte** em `run_new_02.L2`) | `nistfull.service`; `/root/nist_full/results/` | símbolo = byte de 8 bits do transporte, **não** amostra física; restart/health separados; SP 800-90B completo: **NÃO** |
| Fonte aprovada para criptografia? | **NÃO** | unidade física, RTL, restart/health, independência entre lanes pendentes | — |

## Veredito

```
OPERACIONAL, MAS AINDA EM VALIDAÇÃO DA FONTE
```

## Commits

`6cdb043` (itens 1–6 + kickoff da campanha). Fast-forward em `main`.

## Pare — aguardar autorização antes de

implantar `qrng-connector.staging.py` / o patch do `server_api.py` (envelope v1
+ realinhamento + Received-At + entropy-health) na dobslit; reconstruir/implantar
o `qrng-client-api` com os itens 4/5/9; trocar o NIST produtivo; setar
`LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE=1`; ativar RCT/APT; executar a restart
campaign (`systemctl restart qrng-stream` ×1000); alterar FPGA/RTL.
