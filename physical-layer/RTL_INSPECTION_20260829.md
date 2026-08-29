# Inspeção RTL / Vivado — `stream_app.bit.bin` (item 9)

**Inspeção somente-leitura na FPGA (`10.0.10.2`), 2026-08-29, sob autorização.
Nenhuma alteração de RTL/bitstream.**

## O que foi determinado

| item | valor | fonte |
|---|---|---|
| **Placa** | Red Pitaya **z20_125_4ch** — SoC **Xilinx Zynq-7020** (`XC7Z020`), ADC **125 MS/s / 14 bits**, **4 canais** | `hostname rp-f0d1e2`; `/opt/redpitaya/fpga/z20_125_4ch/`; `parameters.txt` com `ch1`/`ch4`; RP OS "2.00-a0457d3aa build 37" |
| **Bitstream carregado** | `/root/stream_app.bit.bin` — **2 083 744 bytes** | `init_demo.sh`: `fpgautil -b /root/stream_app.bit.bin` |
| **É o `stream_app` de fábrica?** | **NÃO.** O `stream_app` stock do RP (z20_125_4ch) é `/opt/redpitaya/fpga/z20_125_4ch/stream_app/fpga.bit.bin` = **2 124 032 bytes** (tamanho diferente). O `/root/stream_app.bit.bin` tem o **mesmo tamanho** que `/root/dac_test.bit.bin` (2 083 744) → ambos são **builds customizados** do mesmo projeto Vivado. | `ls -la` comparativo |
| **Projeto Vivado / RTL do bitstream carregado** | **NÃO DISPONÍVEL** — não está na placa, não está na dobslit, não está na Bongo, não está no repo do produto, não é público. | 3 buscas (`*.xpr`/`*.bd`/`*.v`/`*.vhd`/`*.tcl`/`*.xdc`) na FPGA, dobslit e Bongo — nada |
| **`stream_app` stock de referência** | Repo `redpitaya-3.0/redpitaya-fpga` (git.redpitaya.com), **tag `Release-2024.3`**, commit **`b6023edeba7ea396da19346909c4aafeef7bf1f0`** ("Adding independent acquisition mode for each channel"). É RTL aberto — serve de **referência**, mas **não descreve o bitstream carregado**. | `/opt/redpitaya/fpga/z20_125_4ch/stream_app/git_info.txt` |
| **Interface lida pelo `fifo.c`** | **AXI4-Stream FIFO** (Xilinx PG080) mapeado em `/dev/mem` na base **`0x43C0_0000`**, janela `0x20000`. `fifo.c`: reset RDFR (`0x18`←`0xA5`), loop `num = *(base + 0x11000/4)` (1 read de RDFD = 1 pop de 32 bits), `*base = 0xFFFFFFFF` (limpa ISR), `le = htole32(num)`, `write_all(&le, 4)`. **Sem framing, sem condicionamento no driver C.** | `cat /root/fifo.c` (sha `8c738fbf…`) |
| **`fifo.c` build** | `gcc -O3 -g fifo.c -o fifo` (bash_history) — nativo armv7l | `/root/.bash_history` |

## Respostas (formato do item 9)

```
NOISE SOURCE SAMPLE   = INDETERMINADO. O RTL de stream_app.bit.bin (custom, não
                        disponível) é quem define quantas sub-amostras físicas o
                        ADC entrega por palavra de 32 bits do AXI-Stream FIFO, se
                        há decimação, filtro, empacotamento (packing) de 2×14
                        bits, e se há bits de status. Sem o projeto Vivado NÃO se
                        determina.
DIGITIZED SAMPLE      = 14 bits por canal do ADC de 125 MS/s (característica da
                        placa z20_125_4ch — datasheet RP). Como esses 14 bits
                        chegam ao FIFO (par de canais em 32 bits? um canal
                        decimado? contador de status nos bits altos?) = RTL
                        custom, INDETERMINADO.
TRANSPORT WORD        = uint32 little-endian, 4 bytes. CONFIRMADO na origem
                        (fifo.c: 1 read de RDFD → htole32 → write(4)).
ASSESSMENT SYMBOL     = símbolo de 8 bits (byte) foi a ESCOLHA de análise do
                        ea_iid/ea_non_iid. NÃO é consequência da física enquanto
                        NOISE SOURCE SAMPLE for indeterminado.
HEALTH TEST SYMBOL    = idem — a definir junto com a unidade da noise source.
CONDITIONED           = software: NÃO (connector, FIFO tail, server_api = verbatim;
                        fifo.c sem XOR/hash/whitening/LFSR). HARDWARE/RTL:
                        INDETERMINADO — não observável sem o projeto. A estatística
                        (min-entropia ~6,5–7,1 bits/byte, 0 bits constantes, sem
                        padrão de contador) é COMPATÍVEL com ausência de whitening
                        pesado, mas não é prova.
CONDITIONING FUNCTION = n/a (nenhuma identificada); se existir, está no RTL custom.
PHYSICAL SAMPLE RATE  = INDETERMINADO. O ADC é 125 MS/s/canal; quase certamente há
                        decimação no RTL (fator não exposto — dmesg só mostrou o
                        XADC de housekeeping, não o RF ADC). Vazão de TRANSPORTE
                        medida: 699 220 B/s ≈ 174 805 palavras uint32/s.
TRANSPORT WORD RATE   = ~174 805 palavras/s (MEDIDO via /health total_pushed).
```

## Reprodução de build

Não foi possível reproduzir o build do bitstream carregado (sem projeto Vivado,
sem Vivado na placa, sem toolchain). O `stream_app` stock (Release-2024.3,
`b6023ed`) **pode** ser reproduzido a partir do `redpitaya-fpga` público — mas
produziria o `fpga.bit.bin` de 2 124 032 bytes, **não** o `/root/stream_app.bit.bin`
de 2 083 744 bytes que está em produção.

## Impacto — BLOQUEIO

O conteúdo do RTL de `/root/stream_app.bit.bin` (decimação, packing, presença de
condicionamento em HW, taxa física de símbolos, semântica dos 4 canais /
`ch1`=`0xBD0` / `ch4`=`0xC53` do `parameters.txt`) é **pré-requisito** para:

- `live_verified=true` (item 8.2 — cadeia de confiança até a aquisição);
- **prontidão criptográfica** (SP 800-90B exige noise source e unidade de amostra
  definidas — item 16).

**Desbloqueio:** obter o projeto Vivado/RTL de `stream_app.bit.bin` do
desenvolvedor que gerou o bitstream, OU uma descrição assinada da cadeia física
(fenômeno → fotodetector → ADC → decimação → packing → FIFO) pelo responsável
pelo hardware.

## Evidência circunstancial do fenômeno físico

`numbers_laser_on.txt`, `numbers_shotnoise.txt`, `adc_counts_laser_on.txt`,
`numbers_lab_noise.txt` em `/root` da FPGA + `parameters.txt` (`ch1`/`ch4`) →
**shot noise óptico (laser + fotodetector em 2 canais do ADC de 4)**. Forte, mas
**não confirmado por datasheet nem por documento assinado**.
