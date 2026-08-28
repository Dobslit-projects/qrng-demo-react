# Rodada 2026-08-28 — FPGA/FIFO→server_api, harness de captura, proveniência do upstream

**Branch:** `stabilize/physical-layer-baseline-20260826` = **`main`** = `origin/main` =
`7af9c5c` · **CI #60 (main) verde, 5/5 jobs** · **código em produção:** imagens
`qrng-client-api:9e36a90` / `qrng-web:9e36a90` (deploy 2026-08-28).
Terminologia mantida (Trilha IID / Trilha não-IID / Restart tests / Health tests;
"símbolo de 8 bits" = unidade passada ao `ea_iid`/`ea_non_iid`).

---

## 1. Branch e commits

`main` avançou de `f058f22` para `7af9c5c` (fast-forward). Commits desta rodada:

| commit | conteúdo | implantado? |
|---|---|---|
| `9e36a90` | (deploy 2026-08-28) endianness LE no frontend + provenance headers em JSON + rota `/_test/reset-rate-limit` (staging) | **SIM** (imagens `c0ebed0b`/`35e30be7`) |
| `6cae6ea` | registro do deploy em `DEPLOY_ARTIFACTS.md` | doc |
| `7e54aac` | **item 8** `stream_tap.py`+testes; **item 9** `UPSTREAM_PROVENANCE.md`, envelope v1 no fixture-upstream de staging, `provenance.js` consome versão+sha, `server_api.provenance_patch.py` (ref, não aplicado) | **NÃO** (staging + refs) |
| `7af9c5c` | **item 11** `RCT_APT_ARCHITECTURE.md` | doc |

## 2. Estado pós-deploy

Containers `qrng-client-api` (`sha256:c0ebed0b…`) e `qrng-web-1` (`sha256:35e30be7…`),
`Up`, `RestartCount=0`, `--restart unless-stopped`. `main`=`7af9c5c`. Serviço NIST
(`:18002`), broker (`:18001`), `server_api.py`/FPGA, nginx do host: **inalterados**.
`LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE` **não setado** → produção reporta
`actual_origin=unknown` / `live_verified=false`.

## 3. Smoke autenticado de produção (2026-08-28 19:24 UTC)

`register` (prod) → JWT → token pessoal (`dobslit_qrng_live_32d0e82add…`) →
`GET https://bongo.dobslit.com/qrng/v1/random?bytes=64&format=hex` → **HTTP 200**,
64 bytes, `X-Request-Id: req_38f0bb8a…`, `X-QRNG-Provenance: unknown`,
`X-QRNG-Live-Verified: false`, `X-QRNG-Fallback-Used: false`,
`X-QRNG-Source-Health: healthy`, `X-QRNG-Buffer-Health: healthy`;
`/v1/auth/me` → e-mail correto.

## 4. Confirmação da remoção do token/conta temporários

Após o smoke: token pessoal + conta `item12-smoke-…@deploy.test` **removidos** do
DB de produção. `GET /v1/random` com o token removido → **HTTP 403**. Row counts
**de volta a `users=1` (`contact@primusquantum.com`, real), `api_tokens=0`** —
idênticos ao backup pré-deploy `pre-deploy-9e36a90.bak` (sha `2876f3bb…`).

## 5. Unidade física da amostra — PARCIALMENTE RESOLVIDA (FPGA inspecionada)

Inspeção READ-ONLY da FPGA feita 2026-08-28 sob autorização
(`FPGA_INSPECTION_RESULT.md`). O que mudou:

```
TRANSPORT WORD        = uint32 little-endian, 4 bytes.
                        CONFIRMADO NA ORIGEM: /root/fifo.c faz
                        `num = *(axi_fifo + 0x11000/4)` (1 read de RDFD = 1
                        palavra de 32 bits do AXI4-Stream FIFO @ 0x43C00000),
                        `le = htole32(num)`, `write_all(&le, 4)`. Sem framing.
NOISE SOURCE SAMPLE   = a palavra de 32 bits é 1 read de RDFD. Se o RTL empacota
                        N sub-amostras do ADC por palavra (ou decima), a AMOSTRA
                        FÍSICA ≠ palavra de 32 bits. O RTL de stream_app.bit.bin
                        NÃO está na placa (sem projeto Vivado) -> AINDA
                        INCONCLUSIVO se 1 uint32 = 1 amostra física.
PHYSICAL SAMPLE RATE  = INCONCLUSIVO. O ADC de RF da Red Pitaya é 125 MS/s/14 bit;
                        o RTL quase certamente decima. Fator de decimação e taxa
                        efetiva NÃO expostos (dmesg só mostrou o XADC de
                        housekeeping). Vazão de transporte: 699 220 B/s ≈
                        174 805 uint32/s (MEDIDO via /health).
CONDITIONING (fifo.c) = NENHUM. Confirmado lendo o código: RDFD cru -> write(4).
CONDITIONING (RTL)    = INCONCLUSIVO. Não observável sem o projeto do bitstream.
                        Estatística anterior (0 bits constantes, sem contador,
                        min-entropia 6,9–7,1) é CONSISTENTE com ausência de
                        whitening pesado, mas não prova.
ASSESSMENT / HEALTH SYMBOL = INCONCLUSIVO (herdam a dúvida sobre a amostra física).
FENÔMENO FÍSICO       = shot noise óptico (laser + fotodetector) — forte
                        evidência circunstancial (numbers_laser_on.txt,
                        numbers_shotnoise.txt, adc_counts_laser_on.txt,
                        parameters.txt ch1/ch4). NÃO confirmado por datasheet.
RESTART DA NOISE SOURCE = DEFINIDO: `systemctl restart qrng-stream` (embute
                        `fpgautil -b stream_app.bit.bin` no ExecStartPre) ou
                        power-cycle. Restart de fifo/connector/server_api ≠
                        restart da noise source.
```

**O que segue bloqueado:** o **conteúdo do RTL** de `stream_app.bit.bin`
(condicionamento em HW, decimação, taxa) — o `.bit.bin` está na placa mas o
projeto-fonte (Vivado/RTL) **não**. E MMIO — **não executado de propósito**:
mesmo um `devmem` read-only de `0x43C00000`/`0x1C` é um **segundo acessador do
periférico AXI FIFO ao vivo** (o `fifo.c` escreve ISR a cada iteração) e o
`0x11000` (RDFD) é leitura **destrutiva**. O `fifo.c` + a Xilinx PG080 já dão a
semântica dos registradores (`0x00`=ISR, `0x18`=RDFR reset, `0x1C`=RDFO
ocupação, `0x11000`=RDFD data/pop).

## 6. Inventário de amostras (piloto NIST L0, reproduzido)

| amostra | caminho | tamanho | SHA-256 | tipo |
|---|---|---|---|---|
| cap1 | `characterization_2026/run_new_01.bin` | 1 048 576 | `3021cbf1970170949e6a4f93d13c091ddd33d05841ecb86677cfb9fcca9c60c5` | histórica (origem live não verificada) |
| cap2 | `characterization_2026/run_new_02.bin` | 1 048 576 | `a75d0752d45b30d0929b567d754e46883605e29140a5ccc4c8836537c7406c59` | histórica (captura independente) |
| cap2-txt | `characterization_2026/run_new_02_u32.txt` | 2 824 182 | `0761151bce5f5fb2bf96648e5294ee705e7aaad6a76fdbf75edd257c58ccf5a2` | idem, decimal (normalização byte-idêntica a cap2 provada) |
| cap3 | `characterization_2026/run_new_03.bin` | 10 485 760 | `5d30cfabbf0e034da440c662ee2e104888b7ddfc041b9d37a6cd04cb3d215c64` | histórica |

Nenhuma renomeada como "live". `ea_iid`/`ea_non_iid` compilados de
`usnistgov/SP800-90B_EntropyAssessment` @ `87c104d0`, `bits_per_symbol=8`.

## 7. Elegibilidade por quantidade de símbolos

SP 800-90B exige ≥ 1 000 000 símbolos. cap1/cap2 = 1 048 576 símbolos de 8 bits
(elegíveis). cap3 intercalado = 10 485 760 (elegível). Cada byte-lane de cap3 =
2 621 440 símbolos (elegível, `undersize_warning=false` nas 4). cap2-txt
normalizado = cap2. `characterization_2026` completo: 64 arquivos, 57 elegíveis
(≥ 1 MiB), 7 pequenos (`NIST_FULLSET_COMPARE.md`).

## 8. IID por captura e por lane

| recorte | chi-square | LRS | permutação | **Trilha IID** |
|---|---|---|---|---|
| cap1 (intercalado, 1 MiB) | Passou | Passou | **FALHOU** | **FAIL** |
| cap2 (intercalado, 1 MiB) | Passou | Passou | **FALHOU** | **FAIL** |
| cap2-txt (== cap2) | Passou | Passou | **FALHOU** | **FAIL** |
| cap3 **intercalado** (10 MiB) | — | — | não concluído | **INCONCLUSIVO** (`ea_iid` timeout 1200 s, `exit=124`) |
| cap3 **byte-lane 0** | Passou | Passou | **Passou** | **PASS** |
| cap3 **byte-lane 1** | Passou | Passou | **Passou** | **PASS** |
| cap3 **byte-lane 2** | Passou | Passou | **Passou** | **PASS** |
| cap3 **byte-lane 3** | Passou | Passou | **Passou** | **PASS** |

## 9. Não-IID por captura e por lane

| recorte | `h_original` /8 bit | limitante original | `h_bitstring` /1 bit | limitante bitstring | **`h_min`** (min(h_orig, 8·h_bit)) | trilha |
|---|---|---|---|---|---|---|
| cap1 | 7.210061 | T-Tuple | 0.868917 | **Compression** | **6.951334** | bitstring |
| cap2 | 7.179165 | T-Tuple | 0.859761 | **Compression** | **6.878090** | bitstring |
| cap3 intercalado | 7.428630 | T-Tuple | 0.890185 | **Compression** | **7.121482** | bitstring |
| cap3 lane 0 | 6.986780 | **Lag Prediction** | 0.887097 | Compression | **6.986780** | original |
| cap3 lane 1 | 6.986771 | **MultiMCW Prediction** | 0.875745 | Compression | **6.986771** | original |
| cap3 lane 2 | 7.282199 | T-Tuple | 0.864414 | **Compression** | **6.915310** | bitstring |
| cap3 lane 3 | 7.296068 | T-Tuple | 0.875700 | **Compression** | **7.005597** | bitstring |

**Menor estimativa não-IID válida em todo o L0 = `6.878090` bits/símbolo de 8
bits** (cap2, intercalado). Por byte-lane, mínimo `6.915310` (lane 2).

## 10. Estimadores limitantes

**Compression Test Estimate (trilha bitstring)** em cap1, cap2, cap3-intercalado,
lane 2 e lane 3 (`8·h_bitstring < h_original`). Nas lanes 0 e 1 (que passam IID),
o limitante fica na trilha original (estimadores de predição — Lag / MultiMCW).
Baseline reproduzido: cap1 = `6.951334`, limitante Compression.

## 11. Diferenças entre lanes

Cada byte-lane de cap3 **passa IID isoladamente**; o stream intercalado
**falha/inconclusivo**. Leitura: **hipótese compatível com diferenças entre as
lanes** (posições de byte com distribuições marginais distintas — coerente com o
transporte `uint32-le`). **NÃO é prova** de comportamento não-IID intrínseco da
fonte, nem prova de que as 4 lanes são mutuamente independentes. Correlação linear
≈ 0 entre lanes **não** é independência. ⇒ union bound continua o teto
conservador; k-de-n continua hipótese (ver item 17 / `RCT_APT_ARCHITECTURE.md`).

## 12. Campanha completa — estado do gate

**NÃO EXECUTADA** (instrução explícita: "não execute o teste nist de 18horas").
Comando e estimativa preparados (`NIST_FULLSET_COMPARE.md`: ~18 h wall, ~1,4 GB,
lotes L0–L3). **Gate:** aguarda autorização.

**Restart campaign — evento de restart AGORA DEFINIDO** (inspeção da FPGA, item
13.0): `qrng-stream.service` tem `ExecStartPre=/opt/redpitaya/bin/fpgautil -b
/root/stream_app.bit.bin` — **todo `systemctl restart qrng-stream` reCARREGA o
bitstream** e então sobe `fifo | nc`. ⇒ **um restart real da noise source =
`systemctl restart qrng-stream` (que embute o reload do bitstream) ou
power-cycle da placa.** Um restart do `qrng-connector.py`/`server_api.py` da
dobslit, ou um `SIGKILL`+respawn do `/root/fifo`, **NÃO** é restart da noise
source (só reseta o AXI FIFO digital via `RDFR=0xA5`). Harness pronto
(`restart-campaign/`). Campanha em si: aguarda autorização.

## 13. Matriz FPGA/FIFO → server_api.py

> **Inspeção READ-ONLY da FPGA executada 2026-08-28 sob autorização explícita**
> (SSH aninhado: local → Bongo → dobslit → `10.0.10.2` root). Sem escrita, sem
> restart, sem reload de bitstream, **sem MMIO**, sem segundo consumidor.
> Detalhe completo: `physical-layer/FPGA_INSPECTION_RESULT.md`.

### 13.0 O que a inspeção revelou

- **`:12345` = `nc`**, não um binário próprio: `qrng-stream.service` roda
  `/bin/bash -c '/root/fifo | nc -k -l 0.0.0.0 12345'` (após
  `fpgautil -b stream_app.bit.bin`). `nc` = openbsd (`sha256 e7c80430…`), relay
  de bytes puro, sem framing.
- **`/root/fifo.c`** lido na íntegra (fonte `sha256 8c738fbf…`, binário em
  execução `sha256 97384027…`): `mmap` de `/dev/mem` em `0x43C00000` (janela
  `0x20000`), laço `num = *(axi+0x11000/4)` (**POP de RDFD, 32 bits**);
  `*(axi) = 0xFFFFFFFF` (limpa ISR); `le = htole32(num)`; `write_all(&le, 4)`.
  `write_all` reencaminha write parcial, `continue` em EINTR, `break` em EPIPE
  (`SIGPIPE` ignorado). **`stderr` de diagnóstico NUNCA no stdout binário.**
- **`fifo.c.old`** (versão anterior, substituída): usava
  `fprintf(stdout, "%u", num)` — **decimal ASCII SEM SEPARADOR** (defeito de
  serialização textual real). **Removido**: o `fifo.c` atual usa
  `htole32 + write(4)` binário.
- **Sem condicionamento no `fifo.c`** — RDFD cru → `write(4)`. Condicionamento
  **no RTL** (a montante do FIFO): **não observável** (bitstream
  `stream_app.bit.bin` sem projeto Vivado/RTL na placa).
- **Fenômeno físico:** shot noise óptico (laser + fotodetector) — forte
  evidência circunstancial (`numbers_laser_on.txt`, `numbers_shotnoise.txt`,
  `adc_counts_laser_on.txt`, `parameters.txt` `ch1`/`ch4`). Não confirmado por
  datasheet/esquemático.
- **Taxa física do ADC / decimação do RTL:** não expostas (`dmesg` só mostrou o
  XADC de housekeeping). INCONCLUSIVO.
- **Protótipos mortos na FPGA:** `/root/server_api.py`, `/root/server.py`,
  `/root/testelocal/server_api.py` — todos com `SOURCE_FILE="/dev/urandom"`,
  **NÃO em execução, fora da cadeia** (a cadeia é `fifo → nc :12345`).
  Recomendação de higiene: remover.

### 13.1 Matriz

Estados: **COMPROVADO** / **INCONSISTENTE** / **NÃO OBSERVADO** / **BLOQUEADO POR RISCO OPERACIONAL**.

| Fronteira | Formato esperado | Formato observado | Evidência | Estado |
|---|---|---|---|---|
| **FPGA → FIFO** (ADC → RTL → AXI4-Stream FIFO) | amostra digitalizada do bloco de ruído entra no AXI FIFO; largura/decimação/condicionamento definidos no RTL | AXI4-Stream FIFO Xilinx em `0x43C00000` (do `fifo.c` + PG080). RTL de `stream_app.bit.bin` **não está** na placa (sem projeto Vivado) → decimação, taxa e **existência de whitening no RTL não observáveis** | `fifo.c`; `qrng-stream.service` (`fpgautil -b stream_app.bit.bin`); ausência de RTL no filesystem | **NÃO OBSERVADO** (conteúdo do RTL) |
| **FIFO → fifo.c** | 1 read de RDFD = 1 palavra de 32 bits, sem condicionamento no driver | **`num = *(axi_fifo + 0x11000/4)`** — POP de RDFD, `uint32_t`. `*(axi)=0xFFFFFFFF` limpa ISR. Sem XOR/whitening/hash no `fifo.c`. RDFR reset (`0x18=0xA5`) só no startup | `/root/fifo.c` (sha `8c738fbf…`), binário `97384027…` | **COMPROVADO** |
| **fifo.c → TCP** | palavra LE de 4 bytes fixos → stdout → pipe → socket; sem framing/textual | **`le = htole32(num); write_all(&le, 4)`** num laço. `write_all` trata write parcial + EINTR; EPIPE → sai. `fifo` stdout → `pipe:[4202]` → `nc -k -l :12345` (relay puro). stderr **não** mistura | `/root/fifo.c`; `ps`/`/proc/*/fd` (fifo fd1 e nc fd0 = mesmo pipe 4202) | **COMPROVADO** (`fifo.c.old` com `%u` decimal: **substituído**) |
| **TCP → connector** | `recv()` de bytes crus, passthrough | `qrng-connector.py` (`sha256 4ed0b591…`): `s.recv(65536)` → `sys.stdout.buffer.write(data)` → **nenhuma** transformação/parsing/framing/contador; partial reads OK; EOF → reconexão backoff 2–30 s **sem resync/sequência**; sem duplicação | leitura do código | **COMPROVADO** (passthrough) + **INCONSISTENTE** (reconexão pode perder cauda sub-4 B **silenciosamente** → desalinhamento uint32 permanente e indetectável) |
| **connector → pipe** | `python3 connector.py > /tmp/fifo_qrng`; `stdout.buffer.write`+`flush` por chunk; pipe cheio → escritor bloqueia | igual; `BufferedWriter.write` completa ou lança; janela de perda = 1 chunk ≤ 64 KiB **só** se o processo morrer entre `recv` e `write` | código + `qrng-fifo.service` (dobslit) | **COMPROVADO** |
| **pipe → server_api.py** | `read(n)` partial OK; EOF → reopen; `RingBuffer` 256 MiB **drop-oldest**; `/v1/raw` e `/random` binário = verbatim; `/v1/uint32` = `struct.unpack("<I")` | igual; `server_api.py` (dobslit) sha `892a4cb4…`; telemetria 2026-08-28: buffer **CHEIO**, `total_pushed` 54,5→59,7 GB, `total_popped` ~15–16 MB → **~99,5 % descartado** por drop-oldest; `total_pushed−total_popped−size` quantifica o gap | leitura do código + `/health` (não é 2º consumidor de dados) | **COMPROVADO** (verbatim) + **descontinuidade quantificável** (`/v1/raw` consecutivos **não** contíguos) |

**Resultado global:** a cadeia **FIFO → fifo.c → TCP → connector → pipe →
server_api.py** está **COMPROVADA como passthrough verbatim** — sem serialização
textual (a `%u` do `fifo.c.old` foi removida), sem framing/delimitador, sem
condicionamento no software, alinhamento de 4 bytes **garantido na origem**
(`write(4)` fixo). Ressalvas: **(a) INCONSISTENTE** na reconexão do connector
(perda sub-4 B silenciosa possível, sem resync); **(b) descontinuidade
quantificável** no drop-oldest do RingBuffer. **Não observável:** o **conteúdo
do RTL** (`stream_app.bit.bin`) — não dá para descartar whitening no hardware, a
taxa física, nem o fator de decimação.

### 13.2 Verificações específicas do checklist

| item | resultado |
|---|---|
| `fprintf` / `%u` / serialização textual | **Existia no `fifo.c.old`** (`fprintf(stdout,"%u",num)`, sem separador) — **REMOVIDO**. O `fifo.c` atual: `htole32 + write(4)`. A jusante: `server_api.py` `.hex()` / `struct.unpack` (JSON reversível exato), connector + pipe = 100 % binário |
| delimitadores | **NENHUM** em nenhuma fronteira — stream é sequência de bytes pura |
| `write()` parcial | `fifo.c` `write_all()` (laço + EINTR); `BufferedWriter.write` completa ou lança; `stream_tap.write_all` (item 8) idem |
| `send()` parcial | `nc` é relay do kernel; `fifo.c` já garantiu 4 bytes por palavra antes do pipe |
| `recv()` parcial | `qrng-connector.py` byte-oriented → tolera; `server_api` `read(n)` idem |
| alinhamento em 4 bytes | **garantido na ORIGEM** — `fifo.c` faz `write(&le, 4)` fixo por palavra. Só quebra a jusante se uma reconexão do connector perder 1–3 bytes (sem resync) |
| bytes residuais entre chamadas | **SIM** — drop-oldest do RingBuffer torna `/v1/raw` consecutivos **não** contíguos. `X-QRNG-Sequence` (envelope v1, item 9) exporia |
| endianness | `htole32` explícito no `fifo.c` (LE, 4 bytes fixos); `uint32-le` declarado e aplicado no `server_api.py` / `/v1/uint32`; frontend agora também LE (deploy) |
| signed/unsigned | `uint32_t` no `fifo.c`; `struct.unpack("<I")` = unsigned 32; `.hex()`/bytes = unsigned. **Nenhuma** interpretação signed em nenhum ponto |
| descartes durante reconexão | connector: **SIM, possível** (cauda em trânsito no TCP quando o `nc`/FPGA fecha), não quantificável sem sequência; reopen do pipe no server_api: buffer do kernel (64 KiB) ou escritor bloqueia — sem perda além disso; `fifo.c` restart → `RDFR=0xA5` esvazia o AXI FIFO (≤ KB) |
| duplicação | **NÃO** em nenhuma fronteira (TCP confiável na conexão; reconexão começa do zero; RingBuffer não re-serve; `nc -k` = 1 cliente por vez) |
| perda de bytes | possível em (a) reconexão do connector (**silenciosa**), (b) RingBuffer drop-oldest (**quantificável**), (c) reset do AXI FIFO num restart do `fifo` (≤ KB, no reinício do serviço) |
| múltiplos consumidores | `fifo` é o **único** leitor de RDFD; `nc -k` serve **1 cliente por vez**; `qrng-connector.py` é o **único** cliente de `:12345`; `server_api.py` (dobslit) é o **único** leitor de `/tmp/fifo_qrng`. **Nenhum 2º consumidor aberto** — inspeção via SSH + `/proc` + `/health`, **sem** conectar em `:12345` nem mapear `/dev/mem` |

## 14. Resultado do harness em replay (item 8)

`physical-layer/instrumentation/stream_tap.py` — "read once → copy for evidence →
forward once" sobre `os.pipe()` real. `test_stream_tap.py`: **16/16 PASS**
(CI #60 verde). Cada bloco registra `capture_id`, `sequence`, `offset_start/end`,
`n_bytes`, `sha256`, `ts_monotonic`+`ts_civil`, `hexdump_head/tail`,
`forward_first_divergent_offset` (**−1 sempre** ⇒ forward byte-a-byte == entrada).

| vetor | verificado |
|---|---|
| sequência incremental | `fwd == source`, `evidence_sha256 == sha256(source)`, offsets contíguos |
| zeros | bytes 0 **permanecem 0** no forward e na evidência |
| `0xff` | preservados |
| tamanho não múltiplo de 4 (4099 B, fatias 1/2/3/5/7) | `total_forwarded % 4 == 3` (o tap **não** "arruma" alinhamento) |
| partial reads (1 byte/`os.read`) | 1 bloco por byte, `sha256` da evidência == fonte |
| partial writes (`os.write` curto de ≤ 3 B) | `write_all` reencaminha o restante; nada perdido/duplicado |
| reconexão sem gap | `Discontinuity` registrada **no sidecar**, `at_offset` correto, `gap_bytes=None` (o tap não inventa o tamanho), **nenhum** byte de metadata no fluxo |
| reconexão **com gap real** (40 B perdidos) | **não mascarada**: `fwd` tem 40 B a menos que a fonte lógica; `first_divergent_offset` = exatamente 1200 |
| stream longo (~1 MiB) | preservado |
| captura real reproduzida (`random.Random(20260827)`, mesma seed do fixture) | `fwd == payload`, `forwarded_equals_input=true`, determinístico entre execuções |

Restrições verificadas: sem 2º consumidor (um único `drain` do pipe de saída),
sem mutação, sem framing/delimitador/prefixo, sem metadata no fluxo, sem
descarte, sem duplicação (offsets contíguos), evidência primária = byte cru +
SHA-256 (hexdump ≤ 16 B, secundário). **Não implantado no caminho live.**

## 15. Proposta de proveniência do upstream (item 9)

`physical-layer/UPSTREAM_PROVENANCE.md`. **Opção escolhida:** envelope versionado
em **headers HTTP** emitido pelo `server_api.py` (corpo byte-idêntico) +
`GET /v1/capture/{id}` (consulta sem bytes) + log JSONL correlacionado.
Rejeitados: metadata dentro do stream, sidecar. Complementares: endpoint de
consulta, log.

**Envelope v1** (headers em `/random`, `/v1/raw`, `/v1/uint32`):
`X-QRNG-Provenance-Version: 1`, `X-QRNG-Source-Instance`, `X-QRNG-Source-Status`,
`X-QRNG-Captured-At` (= `last_push_time` do RingBuffer — instante em que os bytes
mais recentes entraram no broker; **não** é a detecção física; documentado como
tal), `X-QRNG-Capture-Id` (`cap_<seq>_<sha12>`), `X-QRNG-Sequence` (= `total_popped`
antes do pop), `X-QRNG-Block-SHA256` (SHA-256 do corpo exato — o consumidor
re-hasheia), `X-QRNG-Byte-Count`, `X-QRNG-Transport-Format`,
`X-QRNG-Buffer-Discontinuous`.

**Feito nesta rodada (staging + refs, NÃO implantado):**
- `staging/fixture-upstream/app.py`: envelope v1 + `GET /v1/capture/{id}`. Suíte
  Playwright de staging: **97 passed** (não quebrou).
- `qrng-client-api/lib/provenance.js`: consome `X-QRNG-Provenance-Version` e
  `X-QRNG-Block-SHA256`; **regra 6** (SHA divergente ⇒ nunca `live`,
  `buffer_health=discontinuous`); **regra 7** (versão desconhecida ⇒ evidência
  ignorada, degrada p/ `unknown`); novos campos em `provenance_detail`
  (`provenance_version`, `source_instance`, `sequence`, `capture_sha256`,
  `capture_sha256_verified`). `provenance.test.js`: **15 → 23** (CI #60 verde).
- `physical-layer/server_api.provenance_patch.py`: patch de referência do
  `server_api.py` real — **NÃO aplicado**.

**Impede má-classificação:** `instance_mode ∈ {replay, fixture, historical}` e
`fallback_used=true` continuam **teto** — nunca `live` mesmo com todos os headers
(testado: `item 9: envelope v1 mas instância REPLAY -> replay, NUNCA live`).

## 16. Resultado das visualizações em produção (item 10)

Smoke **não destrutivo** contra `https://bongo.dobslit.com` (Playwright na Bongo
VM, cookie `bongo_session` p/ passar o gate do nginx do host): **4/4 PASS**.
Resposta de rede efetivamente consumida (`/qrng/api/random?bytes=64&format=hex`,
2026-08-28 19:21 UTC): `X-Request-Id: req_a7ac5024…`, `X-QRNG-Provenance: unknown`,
`X-QRNG-Live-Verified: false`, `X-QRNG-Fallback-Used: false`,
`X-QRNG-Source-Health: healthy`, `X-QRNG-Buffer-Health: healthy`; corpo
`provenance=unknown`, `provenance_detail.actual_origin=unknown`,
`live_verified=false`, `provenance_version=null` (envelope não implantado).

| visualização | endpoint | formato | origem observada | transformação | verificação |
|---|---|---|---|---|---|
| Raw (Dados) | `/qrng/api/random` | raw | **API** — octet-stream N bytes, `Content-Length=N`, `X-QRNG-*` | nenhuma | `actual_origin=unknown`, nunca `live` |
| Hex / Base64 / uint8 (Dados) | `/qrng/api/random` | hex/base64/uint8 | **API** | decode reversível | idem; paridade em `serialization.test.js` |
| Monte Carlo (Dados) | `/qrng/api/random` | hex | **API** | `uint32-le / 2^32` | **max U = 0.9221 < 1**, nenhum `≥ 1`, bytes 0 preservados |
| π Monte Carlo (Aplicações) | `/qrng/api/random` | hex | **API** | `bytesToUint32Array` (**LE**, deploy) → `/2^32` | resultado plausível, **sem NaN** |
| Máx f(x) (Aplicações) | `/qrng/api/random` | hex | **API** | idem endianness LE | (coberto por `features.spec.js`) |
| Histograma / Scatter / Bits (Análise) | `/qrng/api/random` (coluna QRNG) | — | **API** (QRNG) | — | coluna PRNG = `generatePRNGSequence` (LCG) — **PRNG DE COMPARAÇÃO IDENTIFICADA** |
| PRNG × QRNG | `/qrng/api/random` (QRNG) | — | QRNG = **API**; PRNG = LCG **identificado** | — | — |
| Sonificação | `/qrng/api/random` | — | **API** (`fetchQrngBytes`) | `byte → nota` | sem `Math.random` no mapeamento |
| Faixa personalizada | `/qrng/api/random` + `uniformIntsFromBytes` | uint8 | **API** | rejection sampling (LE, sem viés de módulo) | — |
| galaxySpiral / mandala | `/qrng/api/random` | — | **API** | `bytes.length ? bytes[i] : rand` (fix `9e36a90`) | byte 0 **não** vira `Math.random` |
| QuantumVisualizer (fallback) | — | — | `Math.random()` **rotulado** "pré-coletado esgotado" | — | **FALLBACK EXPLÍCITO** — não exibido como `live` |
| Distribuição exponencial | — | — | **NÃO IMPLEMENTADA NA UI** (só `exponentialFromUniform` em lib + teste) | — | — |

Confirmado: `uint32` little-endian; `/2^32`; **nenhum valor ≥ 1**; bytes zero
permanecem zero; `Math.random()` só em fallback rotulado / PRNG de comparação
identificada / decoração (shimmer, tick de áudio, partículas) — **nunca** num
dado de visualização. **Nenhuma** viz classificada como `live` (todas
`live_verified=false`).

## 17. RCT/APT — recomendação de arquitetura (item 11)

`physical-layer/RCT_APT_ARCHITECTURE.md`. **RCT/APT NÃO ativados. Nenhum threshold
selecionado.** O que os dados do L0 mudam:

1. **Não rodar RCT/APT sobre o stream de bytes intercalado cru** — ele falha IID
   por estrutura (interleaving); um health test ali dispararia falso alarme numa
   fonte saudável. Rodar **de-intercalado** (por byte-lane) ou **sobre a palavra
   uint32** — decisão que depende do RTL.
2. RCT/APT **por byte-lane** é defensável como escolha de análise (cada lane
   passa IID), mas herda um recorte de **transporte**, não de física.
3. **Independência entre lanes: inconclusiva** → union bound = teto; k-de-n =
   hipótese.
4. **Health test lê o tap do PRODUTOR** (item 8), não o stream de cada cliente
   (drop-oldest de 99,48 % torna a amostra por cliente esparsa).

Dimensões a decidir na janela autorizada: unidade da amostra física; unidade do
health test; taxa física de símbolos; nº de testes simultâneos (8 vs 2);
dependência entre lanes; custo de um falso positivo (**não quantificado**);
política de falha (revisar "1 janela → FAILED"); política de recuperação
(duração indefinida); comportamento do buffer sob `FAILED`.

**Gate para thresholds — dados ainda necessários:** (1) RTL/AXI/FIFO; (2) taxa do
ADC/clock do bloco de ruído; (3) restart campaign; (4) dependência entre lanes em
capturas longas de-intercaladas; (5) SLA operacional (custo do falso FAILED, MTBF
alvo, orçamento de recuperação).

## 18. Riscos e limitações

| # | risco / limitação | severidade |
|---|---|---|
| R1 | **Reconexão do `qrng-connector.py` pode perder cauda sub-4 B silenciosamente** → desalinhamento uint32 permanente e indetectável (sem sequência/resync). O `fifo.c` garante `write(4)` alinhado na origem; a quebra só surge se a reconexão perder 1–3 bytes. Mitigação: marcador de resync no connector + `X-QRNG-Sequence` no envelope v1 (ambos mexem no caminho produtivo). | média — não corrompe entropia; quebra alinhamento posicional |
| R2 | **RingBuffer drop-oldest descarta ~99,5 %** hoje (consumo ≈ 0). Blocos `/v1/raw` consecutivos **não** são contíguos. Comportamento documentado e mensurável (`total_pushed/popped`), não corrupção. | baixa (demo) / média sob carga |
| R3 | **RTL de `stream_app.bit.bin` NÃO OBSERVADO** — o `.bit.bin` está na placa, o projeto Vivado/RTL **não**. Não dá para descartar whitening/condicionamento no HW, nem confirmar a taxa física / decimação. (A cadeia `fifo.c→…→server_api` já está **COMPROVADA verbatim** — item 13.) | bloqueio parcial — impede fechar a unidade física e a taxa; não afeta a integridade do transporte |
| R4 | **Protótipos `/dev/urandom` na FPGA** (`/root/server_api.py`, `/root/server.py`, `/root/testelocal/server_api.py`) — **não em execução, fora da cadeia**, mas se o connector fosse reapontado para eles serviria PRNG do kernel rotulado como QRNG. Recomendação: remover. | baixa — nenhum está ativo; a cadeia usa `nc :12345` = FIFO real |
| R5 | **Envelope de proveniência v1 preparado mas NÃO implantado** no `server_api.py` real → produção segue `actual_origin=unknown` / `live_verified=false`. | baixa — é o estado honesto; exige janela de manutenção do upstream |
| R6 | **Restart tests e health tests não concluídos** → `SP 800-90B completo = NÃO`. Campanha completa não executada (instrução). Evento de restart agora DEFINIDO. | bloqueio para "conforme SP 800-90B" |
| R7 | 18 alertas dependabot no `main` (pré-existentes, fora de escopo — `VULNERABILITY_MATRIX.md`). Volume órfão `qrng_qrng-tokens-db`. | baixa / trivial |

## 19. Commits produzidos

`7e54aac` (item 8/9), `7af9c5c` (item 11). Ambos em `main` (fast-forward). CI #60
(main) e #59 (branch): **success, 5/5 jobs**.

## 20. Arquivos alterados

**Novos:**
- `physical-layer/instrumentation/stream_tap.py`
- `physical-layer/instrumentation/test_stream_tap.py`
- `physical-layer/UPSTREAM_PROVENANCE.md`
- `physical-layer/server_api.provenance_patch.py` (ref, não aplicado)
- `physical-layer/RCT_APT_ARCHITECTURE.md`
- `physical-layer/ROUND_2026-08-28_FPGA_HARNESS_PROVENANCE.md` (este)

**Modificados:**
- `.github/workflows/ci.yml` (+ step `test_stream_tap` no job `physical-layer-health`)
- `staging/fixture-upstream/app.py` (envelope v1 + `/v1/capture/{id}`) — **staging**
- `qrng-client-api/lib/provenance.js` (consome versão + block-sha; regras 6/7) — **não implantado**
- `qrng-client-api/test/provenance.test.js` (15 → 23)

**Novos (inspeção FPGA):**
- `physical-layer/FPGA_INSPECTION_RESULT.md`

**Não modificado:** `qrng-client-api/server.js` de produção, `server_api.py`
real, **FPGA/FIFO (só leitura — nenhuma escrita/restart/reload)**,
`nist_service.py`, nginx do host, containers em execução.

## 21. Próxima autorização necessária

1. **Projeto RTL / Vivado de `stream_app.bit.bin`** — do repositório do design
   físico (não está na placa). Fecha: condicionamento no HW, taxa física de
   amostragem, fator de decimação → itens 5 e 17-gate(1)(2). Alternativa mais
   fraca: uma janela de manutenção para `fpgautil -o` + análise do bitstream, ou
   instrumentar o RTL (mexe na FPGA — janela dedicada).
2. **Janela de manutenção do `server_api.py`** (dobslit) para aplicar
   `server_api.provenance_patch.py` (envelope v1) — mexe no upstream de produção.
3. **Marcador de resync/sequência no `qrng-connector.py`** (para tornar
   detectável/quantificável a perda numa reconexão — item 13, ressalva R1) —
   mexe no caminho produtivo, janela dedicada.
4. **Campanha NIST completa** (L1–L3, ~18 h) + **restart campaign** (1000×
   `systemctl restart qrng-stream`) — ambas aguardam autorização. (Evento de
   restart agora DEFINIDO — item 12.)
5. **`LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE=1`** em produção — só se/quando o
   envelope v1 estiver no `server_api.py` (senão continua sendo alegar `live`
   sem prova).
6. **Higiene na FPGA:** remover `/root/server_api.py`, `/root/server.py`,
   `/root/testelocal/server_api.py` (protótipos `/dev/urandom`, fora da cadeia).

---

## Tabela de respostas

| Pergunta | Resposta | Evidência | Limitação |
|---|---|---|---|
| O stream intercalado é IID? | **NÃO** (cap1/cap2 FAIL permutação; cap3 10 MiB INCONCLUSIVO/timeout) | piloto L0, `ea_iid` @ `87c104d0` | 2 capturas de 1 MiB + cap3; falha compatível com diferenças entre lanes |
| Cada lane é IID? | **SIM** — 4/4 byte-lanes de cap3 passam (chi-square + LRS + permutação) | `ea_iid` por lane, 2 621 440 símbolos/lane, `undersize_warning=false` | só cap3; lanes = recorte de transporte, não de física |
| Qual a menor estimativa não-IID? | **`6.878090` bits / símbolo de 8 bits** (cap2, intercalado); por lane, mín. `6.915310` (lane 2) | `ea_non_iid` @ `87c104d0`; limitante Compression (trilha bitstring) | símbolo = byte, **não** amostra física |
| Qual é a unidade física da amostra? | **PARCIAL.** A palavra de transporte = **1 read de RDFD = 32 bits** (`fifo.c` confirmado). Se 1 uint32 = 1 amostra física OU um agrupamento/decimação do ADC: **INCONCLUSIVO** (RTL de `stream_app.bit.bin` não está na placa) | `/root/fifo.c` (sha `8c738fbf…`); `FPGA_INSPECTION_RESULT.md` | falta o projeto RTL/Vivado; taxa do ADC e decimação não expostas |
| FPGA→server_api preserva os bytes? | **CADEIA fifo.c→TCP→connector→pipe→server_api: COMPROVADA verbatim** (`fifo.c` `htole32+write(4)` fixo, sem framing, sem `%u` — a `%u` do `fifo.c.old` foi removida; connector/pipe/server_api passthrough). **Ressalvas:** INCONSISTENTE na reconexão do connector (perda sub-4 B silenciosa possível, sem resync) + descontinuidade quantificável no drop-oldest. **RTL→FIFO: NÃO OBSERVADO** (bitstream sem projeto-fonte) | matriz item 13; `fifo.c`; `qrng-connector.py`/`server_api.py`; `/health` | condicionamento no RTL não descartável; perda na reconexão não quantificável sem sequência |
| server_api→cliente preserva os bytes? | **SIM** | `serialization.test.js` + `api.spec.js` (raw==hex==base64==uint8, mesmo SHA-256, round-trip); smoke de produção 2026-08-28 | região FPGA→server_api não coberta |
| Token funciona em produção? | **SIM** | smoke autenticado 2026-08-28: register→JWT→token→`GET /v1/random` 200; token temporário **removido**, `users` de volta a 1 | — |
| Visualizações usam os bytes da API? | **SIM** | smoke de produção 4/4; `viz-provenance.spec.js` (CI #60); auditoria estática de `Math.random` | `Math.random` só em fallback rotulado / PRNG de comparação / decoração |
| Origem live está comprovada? | **NÃO** | `server_api.py` real sem envelope de captura → `actual_origin=unknown`, `live_verified=false` em toda resposta de produção | envelope v1 preparado, **não implantado** |
| Fonte está aprovada para criptografia? | **NÃO** | Restart/health/arquitetura pendentes | — |

---

## Veredito

```
OPERACIONAL, MAS AINDA EM VALIDAÇÃO DA FONTE
```

Não há "passou no NIST", "NIST validado", "IID comprovado", "sem viés",
"seguro", "live" nem "aprovado para criptografia" sem a delimitação de evidência
acima. O deploy de 2026-08-28 tornou o pipeline de software (API + frontend)
operacional e **honesto sobre a proveniência** (`unknown`/`live_verified=false`).
A inspeção READ-ONLY da FPGA (2026-08-28) **COMPROVOU** a cadeia
`fifo.c → TCP → connector → pipe → server_api.py` como passthrough verbatim (a
serialização textual `%u` do `fifo.c.old` foi removida) e **definiu o evento de
restart** da noise source. Permanece **em validação**: o **conteúdo do RTL**
(condicionamento em HW, taxa física, decimação), a campanha NIST completa, os
restart/health tests, a independência entre lanes.

## Pare — aguardar autorização antes de

aplicar o envelope v1 ao `server_api.py` de produção; adicionar marcador de
resync ao `qrng-connector.py`; executar a campanha NIST completa ou a restart
campaign (`systemctl restart qrng-stream` ×1000); ativar RCT/APT ou selecionar
thresholds; setar
`LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE=1`; abrir um segundo consumidor da fonte;
trocar o serviço NIST produtivo; alterar FPGA/FIFO em produção.
