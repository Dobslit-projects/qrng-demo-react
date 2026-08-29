# Proveniência do bitstream `stream_app.bit.bin`

**Data:** 2026-08-29 · **Branch:** `investigate/fpga-vivado-artifacts-20260829`
**Método:** parsing somente leitura do próprio arquivo + comparação de hash contra toda a árvore FPGA stock presente na placa + varredura de artefatos em FPGA/dobslit/Bongo/repo (ver `FPGA_ARTIFACT_SEARCH.md`).

---

## 1. Resumo executivo

| Pergunta | Resposta baseada em evidência |
|---|---|
| De onde veio o bitstream? | Compilado **fora da placa** (Zynq-7010 não roda Vivado) e copiado para `/root/stream_app.bit.bin`. O host de build **não está** entre os hosts autorizados desta etapa. `birth` do inode: 2025-10-31 *(relógio da placa)*; `mtime`: 2026-02-11. |
| Qual projeto Vivado o gerou? | **Não recuperável.** Nenhum `.xpr`/RTL/`.bd`/`.xdc`/`.dcp`/`.xsa` em nenhum host autorizado nem no histórico do repo. O `.bit.bin` é headerless (sem cabeçalho ASCII `.bit`) → **sem nome de design, sem versão de ferramenta, sem data de build embutidos**. |
| Qual versão do Vivado? | **Desconhecida.** Não há string de versão no bitstream nem `vivado.log`/`.jou`. Inferência fraca (não confirmada): o ecossistema Red Pitaya 2.00 / FPGA `Release-2024.3` presente na placa é construído com Vivado **2020.1** pela convenção da Red Pitaya para o ramo 2024.x — *se* o projeto for um fork do `redpitaya-fpga` desse período, seria Vivado 2020.1. Sem o projeto isso permanece hipótese. |
| Qual bloco recebe os dados do ADC / como são transformados antes do FIFO? | **Não observável sem o RTL.** O que é fato: o datapath entrega no FIFO uma **palavra de 32 bits** e o `fifo.c` a repassa **verbatim** (`RDFD → htole32 → write(4)`), sem condicionamento em software. A palavra de 32 bits comprovadamente **pode carregar dois campos de 16 bits com sinal** (captura `adc_counts_laser_on.txt`). Existência de XOR/mistura/whitening/decimação **no fabric** não é determinável nesta etapa. Ver `FPGA_SAMPLE_UNIT_DECISION.md`. |
| O projeto é reproduzível a partir do que foi encontrado? | **Não.** Só o binário compilado existe. Reprodução bit-exata é impossível sem as fontes (e, mesmo com elas, sensível a versão de ferramenta). Ver `FPGA_RECOVERY_PLAN.md`. |

**Veredito:** `SOMENTE BITSTREAM DISPONÍVEL`.

---

## 2. O que o próprio bitstream revela (parsing dos pacotes de configuração)

Lido de `/root/stream_app.bit.bin` com `python3` (leitura de arquivo; **sem** acesso a `/dev/mem`). Palavras de 32 bits des-invertidas (byte-swap) para casar com o formato canônico `.bit`; sync `0xAA995566` no offset de byte 48.

| Registrador | Valor | Interpretação |
|---|---|---|
| `IDCODE` | `0x03722093` | **`xc7z010`** — Zynq-7010 (o SoC do STEMlab 125-14 / "z10"). |
| `CTL0` | `0x00000501` | bit 6 (`ENC`) = **0** → **não criptografado**; sem AES/HMAC. |
| `COR0` | `0x02003fe5` | opções de configuração (padrão). |
| `CMD` seq. | `NULL … WCFG(0x1)` | sequência padrão de **configuração completa**. |
| `FDRI` | 520 352 palavras (~2 081 408 B) | payload de frames; **full config**, não parcial. |

**Ausências que importam:** sem cabeçalho `.bit` (`a` / `b` / `c` / `d` fields) → sem `Design name`, sem `Vivado vX.Y`, sem `Date`, sem `UserID`. `strings -n 8` só devolve lixo de frame. **Zero metadados de build.**

---

## 3. Comparação com os projetos oficiais Red Pitaya presentes na placa

Árvore stock: `Release-2024.3`, `redpitaya-fpga` commit `b6023edeba7ea396da19346909c4aafeef7bf1f0` ("Adding independent acquisition mode for each channel", MR `redpitaya-3.0/redpitaya-fpga!19`), autor Nikolay Danilyuk. `git_info.txt` idêntico nas 4 variantes de `z20_125_4ch`.

### 3.1 Hash / tamanho — `z20_125_4ch`

| Variante stock | `fpga.bit.bin` tamanho | SHA-256 | Bate com o alvo? |
|---|---|---|---|
| `logic` | 2 237 088 | `e5469843…272c8dbd` | não |
| `barebones` | 372 224 | `6007e657…6da3f484` | não |
| `v0.94` | 2 044 992 | `b0797765…904fdc655` | não |
| `stream_app` | 2 124 032 | `c5129b37…d42577ce` | não |
| **alvo `/root/stream_app.bit.bin`** | **2 083 744** | **`392a51e6…aa8f4e3e`** | — |
| **alvo `/root/dac_test.bit.bin`** | 2 083 744 | `de763e62…f31bc57f` | não |

Também verificado: **nenhum** dos ~40 `fpga.bit`/`fpga.bit.bin` stock de **todas** as placas (`z10_125`, `z20_122`, `z20_125`, `z20_125_4ch`, `z20_250*`) bate com `392a51e6…`. O alvo **não é um arquivo stock renomeado**.

> Tamanho **não** discrimina device nem design aqui: as variantes stock do **mesmo** device vão de 372 KB (`barebones`, fabric quase vazio) a 2.4 MB (`logic`) → a compressão de bitstream do fluxo Red Pitaya está ativa. Por isso a comparação é feita por **hash** e por **IDCODE**, não por tamanho.

### 3.2 Mapa de endereços — stock `stream_app` vs. o que o `fifo.c` usa

`/opt/redpitaya/fpga/z20_125_4ch/stream_app/dts/{pl.dtsi,fpga.dtso,pl_patch.dtsi}` (stock) declara **apenas**:

| Nó | Base | Janela |
|---|---|---|
| `rp_oscilloscope` | `0x40000000` | `0x100000` (+ buffer `0x1000000`/`0x80000`) |
| `rp_gpio` | `0x40200000` | `0x100000` (+ buffer `0x1100000`/`0x80000`) |

**Nada em `0x43C00000`.** O `fifo.c` de produção faz `mmap(/dev/mem, 0x20000, …, 0x43C00000)` e lê `RDFD` em `+0x11000` — endereço e semântica de um **AXI4-Stream FIFO (Xilinx PG080)** que **não existe** no `stream_app` stock. `0x43C00000` é a base default do Vivado para o primeiro periférico AXI no range `GP0` (`0x43C00000–0x7FFFFFFF`).

**Conclusão:** o bitstream em produção contém um bloco AXI4-Stream FIFO customizado, ausente dos projetos stock. É um **projeto derivado/customizado**, não o `stream_app` oficial. O `.bif` stock (`all:{ build/fpga/z20_125_4ch/stream_app_4ch/fpga.bit }`) indica que o projeto stock 4-canais mora em `redpitaya-fpga` sob `projects/stream_app_4ch` — ponto de partida natural para diff/reconstrução.

---

## 4. Discrepância de device — a resolver com os autores

| Fonte | Device indicado |
|---|---|
| Documentação do projeto / diretiva | Zynq-**7020** (`xc7z020`), placa `z20_125_4ch` |
| `IDCODE` no bitstream em produção | **`xc7z010`** (`0x03722093`) |
| `monitor -f` na placa | `z10_125` |
| Overlay stock carregado no boot (`/tmp/loaded_fpga.inf`) | `v0.94` (variante genérica z10/z20 125) |

As três fontes on-board (IDCODE, `monitor -f`, overlay) concordam em **z10 / xc7z010**. A documentação do projeto diz z20/xc7z020. Isso **não foi reconciliado** nesta etapa e é material para qualquer reconstrução (parte-alvo, orçamento de LUT/BRAM/DSP, pinout). Hipóteses, sem confirmação:
- a placa física em uso é uma STEMlab 125-**14** (z10, 2 canais) e a designação "z20_125_4ch" no projeto está incorreta ou herdada; **ou**
- é uma placa 4-canais cujo EEPROM de HW-ID não está provisionado e o `monitor` cai no default z10 — mas o `IDCODE` do bitstream é definido em *build time*, então um bitstream `xc7z010` **foi compilado deliberadamente para xc7z010**.

**Ação:** confirmar com quem fez o build qual é a parte-alvo real (`xc7z010` vs `xc7z020`) e qual placa física está no rack.

---

## 5. `stream_app.bit.bin` vs `dac_test.bit.bin`

- Mesmo tamanho exato (2 083 744 B), mesmo device (`xc7z010`), ambos não criptografados.
- Diferem em **63 379 bytes** (~3% do payload) numa **única região contígua** do FDRI (bytes 249 301–2 081 652 do arquivo).
- Um delta localizado nos frames, com todo o resto idêntico (infraestrutura PS7, clocks, IO ring, base do design), é a assinatura de **dois builds do mesmo projeto Vivado** trocando apenas um sub-bloco do datapath — coerente com "build de streaming" vs "build de teste de DAC".
- Confiança: **PROVÁVEL** (não CONFIRMADA — sem as fontes não dá para provar que é o mesmo `.xpr`).

---

## 6. Linha do tempo reconstruível (parcial, relógio da placa)

| Quando *(relógio da placa)* | Evento | Evidência |
|---|---|---|
| 2025-10-31 17:13 | `birth` do inode de `/root/stream_app.bit.bin` | `stat` |
| 2026-02-11 18:41 | `mtime` de `stream_app.bit.bin` (última escrita) | `stat`, `ls` |
| 2026-02-11 22:06 | `mtime` de `dac_test.bit.bin` | `ls` |
| 2026-02-27 | criação de `/root/testelocal/` (servidor FastAPI local antigo) | `ls` |
| 2026-03-28 06:46:52 | boot atual; `qrng-stream.service` sobe, `fpgautil` carrega o `.bit.bin` em 39 ms; `fifo`+`nc` ativos desde então | `journalctl -b`, `systemctl show`, `ps etimes` |
| 2026-03-20 / 2026-06-10 | `mtime` de `numbers_qrng.txt` / `numbers.txt` (capturas de 1 M amostras) | `ls` |

O `birth`/`mtime` do bitstream são anteriores a todo o resto → o binário foi trazido para a placa **pronto**, e nunca reconstruído nela.

---

## 7. Conclusão de proveniência

1. O bitstream de produção é um **derivado customizado** de um projeto FPGA Red Pitaya (contém um AXI4-Stream FIFO em `0x43C00000` ausente do stock), compilado para **`xc7z010`**, **não criptografado**, **sem metadados de build**.
2. **O projeto Vivado / RTL que o gerou não existe em nenhum host autorizado nem no histórico do repositório.** Só os dois binários (`stream_app.bit.bin`, `dac_test.bit.bin`) e a árvore FPGA stock da Red Pitaya estão disponíveis.
3. **Não é reproduzível** a partir dos artefatos encontrados.
4. Pendências para os autores: (a) parte-alvo real (`xc7z010`/`xc7z020`) e placa física; (b) fontes do projeto (`.xpr` ou scripts Tcl + RTL + `.xdc` + `.bd`); (c) versão do Vivado; (d) commit-base do fork do `redpitaya-fpga`.
