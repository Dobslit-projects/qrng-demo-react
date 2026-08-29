# Plano de recuperação / reconstrução do projeto FPGA

**Data:** 2026-08-29 · **Branch:** `investigate/fpga-vivado-artifacts-20260829`
**Situação:** `SOMENTE BITSTREAM DISPONÍVEL`. Existe o binário compilado (`/root/stream_app.bit.bin`, `xc7z010`, não criptografado, sem metadados) e a árvore FPGA **stock** da Red Pitaya (`Release-2024.3`). Não existe projeto Vivado, RTL, `.bd`, `.xdc`, `.dcp`, `.xsa` em nenhum host autorizado nem no histórico do repositório.

Este plano tem duas trilhas independentes: **(A) recuperar as fontes originais** (preferível) e **(B) reconstruir um projeto equivalente** (fallback, nunca bit-exato). Nenhuma das duas foi executada — dependem de itens fora do escopo desta etapa (acesso a workstation de build / autorização para JTAG).

---

## A. Recuperar as fontes originais — pedido formal aos autores

### A.1 Artefatos a solicitar (lista exata)

**Projeto Vivado / fontes:**
1. `*.xpr` do projeto **ou** o(s) script(s) Tcl de criação (`create_project` / `make` do fluxo Red Pitaya — tipicamente `red_pitaya_top.tcl`, `project.tcl`, `ports.tcl`).
2. Todo o RTL: `*.v` / `*.sv` / `*.vhd` do datapath de aquisição e do bloco que alimenta o **AXI4-Stream FIFO em `0x43C00000`**.
3. Block Design: `*.bd` (+ `*.bd.tcl` exportado) — em especial a instância do **AXI4-Stream FIFO / AXI DMA** e como o ADC chega nele.
4. Constraints: `*.xdc` (pinout dos ADCs, clocks, `create_clock`, falsos caminhos).
5. IP customizado: diretórios `*.xci` / `component.xml` de qualquer IP empacotado (condicionador, packer de canais, FIFO wrapper).
6. `*.xsa` / `*.hwh` (hand-off de hardware) — se o fluxo gerou.
7. Checkpoint pós-rota `*.dcp` — permite readback e comparação sem re-síntese.

**Metadados de build:**
8. Versão **exata** do Vivado (ex.: `2020.1`, `2020.2.2`) e do Vitis/XSCT, se usados.
9. Commit-base: se o projeto é fork de `redpitaya-fpga`, o **hash do commit** e o `git remote`. (Baseline stock na placa: `Release-2024.3`, commit `b6023edeba7ea396da19346909c4aafeef7bf1f0`.)
10. Parte-alvo confirmada: **`xc7z010`** (o IDCODE do bitstream diz isso) vs `xc7z020` (documentação) — e qual placa física está no rack. Ver `FPGA_PROVENANCE.md` §4.
11. `vivado.log` / `vivado.jou` da última síntese/implementação, se existirem.
12. Relatório de utilização (`*_utilization_placed.rpt`) e de timing (`*_timing_summary_routed.rpt`).

**Especificação funcional (mesmo que o RTL venha, para validar a leitura):**
13. Bits por amostra do ADC que entram no FIFO; nº de amostras do ADC por palavra de 32 bits e **layout de bits**.
14. Decimação / gating entre o ADC (125 MS/s, 14 bits) e o FIFO — taxa efetiva.
15. Se há XOR/mistura/whitening/LFSR entre canais ou amostras; se o modo "qrng" difere do modo "adc_counts" (ver `FPGA_SAMPLE_UNIT_DECISION.md` §2.3).
16. O que exatamente reinicia a fonte de ruído: hoje o único gatilho observado é `fpgautil -b /root/stream_app.bit.bin` (recarrega **todo** o fabric) — via `qrng-stream.service` `ExecStartPre` ou power-cycle. Confirmar se há reset de sub-bloco (registrador AXI) que reinicie **só** o noise source sem recarregar o fabric.
17. `dac_test.bit.bin`: confirmar que é o **mesmo** `.xpr` com outro top/modo (a hipótese do diff de 63 379 B contíguos).

### A.2 Se as fontes forem recebidas e forem versionáveis legalmente

- Organizar em **`fpga/original-recovered/`** com:
  - `README.md` — origem (quem entregou, quando, sob que licença), parte-alvo, versão do Vivado, e **passos de build** (`source /opt/Xilinx/Vivado/<versão>/settings64.sh; vivado -mode batch -source make_project.tcl; …`).
  - `HASH_MANIFEST.sha256` — SHA-256 de cada arquivo recebido.
  - `LICENSE` / nota de licença (Red Pitaya FPGA é majoritariamente **GPL-2.0 / dual**; confirmar a do fork).
  - `PROVENANCE.md` — cadeia de custódia do artefato.
- **Critério de aceitação (equivalência):** rebuild produz um `fpga.bit.bin` cujo **IDCODE, `CTL0`, contagem de frames FDRI e mapa de endereços AXI** batem com o baseline (`FPGA_BASELINE_MANIFEST.json`). Hash bit-exato provavelmente **não** vai bater (sensível a versão de ferramenta, seed de PAR, timestamp) — e isso é aceitável desde que a equivalência estrutural + funcional (mesmo `0x43C00000`, mesma semântica RDFD, mesmo formato de palavra) seja demonstrada com os datasets de referência.
- Só então o veredito pode subir para `PROJETO PARCIALMENTE RECUPERADO` ou `PROJETO VIVADO RECUPERADO E REPRODUZÍVEL`.

---

## B. Reconstrução de um projeto equivalente (fallback)

**Não** produz bit-exato. Produz um projeto que replica o **contrato observável** (palavra de 32 bits no FIFO em `0x43C00000`, semântica PG080, formato `{ch_a[15:0], ch_b[15:0]}` ou o que os autores confirmarem).

### B.1 Ponto de partida
- Clonar `redpitaya-fpga` no commit-base `b6023edeba7…` (`Release-2024.3`), projeto `stream_app_4ch` (o `.bif` stock aponta para `build/fpga/z20_125_4ch/stream_app_4ch/fpga.bit`).
- Diff conceitual contra o stock: o stock expõe `rp_oscilloscope@0x40000000` + `rp_gpio@0x40200000` e **nada** em `0x43C00000`. A customização adiciona um caminho ADC → (packer/condicionador?) → **AXI4-Stream FIFO** (Xilinx `axi_fifo_mm_s`, PG080) mapeado em `0x43C00000`, janela `0x20000`.

### B.2 Esqueleto mínimo a criar em `fpga/reconstructed-candidate/` (SEPARADO de qualquer coisa recuperada)
```
fpga/reconstructed-candidate/
  README.md                  # deixa EXPLÍCITO: reconstrução, não é o original, não bit-exato
  src/
    rp_qrng_top.v            # top: instancia PS7, ADC ring do RP, e o bloco abaixo
    adc_to_axis.v            # 2x ADC 14b -> sign-extend 16b -> {hi,lo} -> AXI4-Stream 32b
    (opcional) noise_src_reset.v  # registrador AXI-Lite para reset do sub-bloco
  bd/
    system.bd.tcl            # PS7 + axi_fifo_mm_s @ 0x43C00000 + interconnect
  constraints/
    ports.xdc               # pinout ADC/clock do z10_125 / z20_125_4ch
  make_project.tcl           # cria projeto, roda synth+impl, gera fpga.bit + .bit.bin (byte-swap)
  HASH_MANIFEST.sha256
```
- **Não** commitar `.bit`/`.bit.bin` reconstruídos junto do baseline de produção; se gerados, ficam sob `fpga/reconstructed-candidate/build/` e nunca substituem `/root/stream_app.bit.bin`.
- Validar contra os datasets de referência da placa (`adc_counts_laser_on.txt` etc.): o reconstruído deve produzir o mesmo layout `{HI16,LO16}` sob os mesmos estímulos.

### B.3 Limites da reconstrução
- Se os autores **não** confirmarem a unidade física (§13–15 de A.1), a reconstrução fica com a hipótese "2×14→16 bits, sem whitening" — que **contradiz** a aparência uniforme de `numbers_qrng.txt` (ver `FPGA_SAMPLE_UNIT_DECISION.md` §2.3). Nesse caso a reconstrução é **especulativa** e não deve lastrear nenhuma afirmação de entropia.
- Reconstrução **não** eleva o veredito acima de `SOMENTE BITSTREAM DISPONÍVEL` para efeito de proveniência do artefato em produção.

---

## C. Opção C — readback / engenharia reversa do fabric (requer autorização separada)

Fora do escopo desta etapa (a diretiva proíbe JTAG / Vivado Hardware Manager / readback / reset sem autorização à parte). Se autorizado no futuro:
- `xc7z010` **não criptografado** → readback de configuração via JTAG é tecnicamente possível.
- Ferramentas de netlist-recovery (ex.: projeto `prjxray` / `bit2ncd`-like) dão uma netlist de baixo nível, **não** RTL legível — utilidade limitada para manutenção.
- Risco operacional: qualquer conexão JTAG / reset perturba a fonte em produção. **Só com janela de manutenção acordada.**

---

## D. Recomendação

1. **Executar a trilha A** (pedir as fontes). É a única que fecha proveniência e reprodutibilidade.
2. Em paralelo, **confirmar a parte-alvo** (`xc7z010` vs `xc7z020`) — barato e destrava o resto.
3. Só iniciar a trilha B se A falhar (autores não têm mais as fontes). Manter B rigorosamente sob `fpga/reconstructed-candidate/`, marcada como não-original.
4. **Não** habilitar geração criptográfica enquanto a unidade física permanecer `DESCONHECIDO`.
