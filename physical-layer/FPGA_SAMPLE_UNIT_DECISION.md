# Unidade da amostra física — decisão baseada em evidência

**Data:** 2026-08-29 · **Branch:** `investigate/fpga-vivado-artifacts-20260829`

Esta decisão usa **apenas** o que foi comprovado por leitura: o código `fifo.c`, os pacotes de configuração do bitstream, e os datasets `/root/*.txt` capturados na própria placa. Onde não há evidência, o campo é marcado **`DESCONHECIDO`** — não é inferido.

---

## 1. Contrato do transporte (formalização do `fifo.c`)

| Campo | Valor | Como foi comprovado |
|---|---|---|
| **FPGA REGISTER WIDTH** | 32 bits | AXI4-Lite/AXI4-Stream FIFO Xilinx PG080; `fifo.c` faz `volatile uint32_t *axi_fifo` e lê palavra alinhada em `+0x11000` (RDFD). |
| **FIFO WORD WIDTH** | 32 bits | `RDFD` (Receive Data FIFO Data) do PG080 é de 32 bits; cada leitura **remove** uma palavra de 32 bits. `fifo.c` lê exatamente uma por iteração. |
| **SOFTWARE READ WIDTH** | 32 bits (`uint32_t`) | `num = *(axi_fifo + (0x11000/0x4));` — uma leitura de 4 bytes. |
| **TRANSPORT WORD** | 4 bytes = 1 palavra RDFD | `le = htole32(num); write_all(&le, sizeof(le));` — `sizeof(uint32_t)` = 4. Sem framing, sem cabeçalho, sem delimitador. |
| **TRANSPORT ENDIANNESS** | little-endian explícito | `htole32()`. Em ARM Zynq (little-endian) é no-op, mas o contrato é explícito: o consumidor deve ler **uint32 LE**. |
| **PHYSICAL SAMPLE WIDTH** | **DESCONHECIDO** (não determinável sem o RTL) | ver §3. Há evidência circunstancial de **2 campos de 14 bits com extensão de sinal para 16** empacotados na palavra de 32 bits, mas a relação "1 palavra de 32 bits ↔ N amostras do ADC" e a existência de decimação/mistura no fabric **não são observáveis** sem o projeto Vivado. |

**Condicionamento em software:** **NENHUM.** `fifo.c` (sha256 `8c738fbf…`) faz, verbatim, por palavra: `read RDFD → *ISR = 0xFFFFFFFF → htole32 → write(4)`. Sem XOR, sem hash, sem seleção de bits, sem decimação, sem truncamento. (A versão `fifo.c.old`, sha256 `8a338ad7…`, escrevia `fprintf("%u", num)` — decimal sem delimitador; é a origem dos arquivos `numbers*.txt`.)

---

## 2. Evidência dos datasets capturados na placa

Todos em `/root`, um valor por linha. Lidos somente com `head`/`awk` (formato e faixa; sem dump extenso).

| Arquivo | Formato | n | Faixa observada | Leitura |
|---|---|---|---|---|
| `adc_counts_laser_on.txt` | hex `0x%08x` | 6 244 | ver §2.1 | **par de campos de 16 bits com sinal** |
| `numbers_shotnoise.txt` | hex | 10 000 | 32 bits cheios, alta entropia | palavra de 32 bits sob ruído de disparo forte |
| `numbers_laser_on.txt` | hex | 10 000 | 32 bits cheios | idem, laser ligado |
| `numbers_sine_1k.txt` | hex | 10 000 | 32 bits cheios | idem, entrada senoidal 1 kHz |
| `numbers_noise_gen.txt` / `_200mv_15M` / `_200mv_30M` / `_400mv_30M` | hex | 1 000 / 10 000 | **esparso, estruturado** (`0x03000001`, `0x80040000`, `0x00410000`, `0xc03ffff0`…) | **entrada fraca → a "palavra aleatória" degenera** |
| `numbers_lab_noise.txt` | hex | 10 000 | esparso, estruturado | idem — só ruído de laboratório, sem fonte |
| `numbers_qrng.txt` | decimal | 1 000 000 | min 29 403 · max 4 294 952 392 · média 2,152 e9 (≈2³¹) | captura "de produção", ~uniforme em 32 bits |
| `numbers.txt` | decimal | 1 000 000 | min 47 826 · max 4 294 911 589 · média 2,148 e9 (≈2³¹) | idem |

### 2.1 `adc_counts_laser_on.txt` — a palavra de 32 bits como `{HI16, LO16}`

Decompondo cada `uint32` em `HI = w>>16` e `LO = w & 0xFFFF`, interpretados como inteiros de 16 bits **com sinal**:

| Campo | mín | máx | média | desvio-padrão |
|---|---|---|---|---|
| `HI16` (s16) | −130 | −86 | −109.6 | **5.9** |
| `LO16` (s16) | −889 | +756 | −109.0 | **177.5** |

Amostras: `HI` = `0xff96 0xff8d 0xff8f 0xff9a …` (≈ −107 constante); `LO` = `0x012e 0x0137 0x00cc 0x0119 …` (varia).

Leitura:
- Dois campos de 16 bits, **ambos centrados no mesmo offset ≈ −109** → mesma cadeia de front-end analógico (offset de ADC comum) em dois canais.
- `HI16` quase constante (σ≈6) → **canal quase-DC / ocioso**; `LO16` com σ≈178 e faixa ±900 → **canal com sinal** ("laser on").
- Valores muito dentro de ±8192 → amplitude baixa; consistente com ADC de **14 bits** com **extensão de sinal para 16**.
- `parameters.txt` da placa contém `ch1: 0xBD0` / `ch4: 0xC53` → o projeto lida explicitamente com **dois canais** (1 e 4 do z20_125_4ch), coerente com o empacotamento `{ch_a[15:0], ch_b[15:0]}`.

**Portanto:** sob o modo de captura "adc_counts", a palavra de 32 bits **é** um par `[16 bits com sinal | 16 bits com sinal]` de contagens de ADC (cada uma extensão de um valor de 14 bits).

### 2.2 Ausência de whitening em hardware

Nos datasets `numbers_lab_noise.txt` e `numbers_noise_gen_200mv_15M.txt` (fonte física fraca), a palavra de 32 bits **colapsa para valores esparsos e estruturados** (muitos nibbles zero, potências de dois, `0xc0…`). Uma saída whitened por hash/AES/LFSR permaneceria de entropia plena mesmo com entrada fraca. Logo: **não há condicionamento criptográfico entre o ADC e o FIFO**. No máximo há empacotamento de bits (e talvez os 14 bits úteis de cada canal ocupem os bits baixos de cada metade de 16 — o que colocaria os bits 14–15 e 30–31 da palavra "aleatória" como bits de sinal, um viés **estrutural** do `uint32` cru que só some quando a entrada analógica satura).

### 2.3 Contradição não resolvida: `numbers_qrng.txt` / `numbers.txt`

Essas duas capturas de 1 M amostras têm média ≈ 2³¹ e cobrem toda a faixa `[~3e4, ~4.29e9]` → parecem **uniformes em 32 bits**, o que é **incompatível** com "dois campos de 14 bits com extensão de sinal" (que ficariam agrupados perto de zero). Possibilidades, **nenhuma confirmável** sem o RTL:
1. sob a fonte de ruído real (não a dos experimentos acima), a entrada excita todos os 14 bits **e** os bits de sinal alternam de fato;
2. o modo "qrng" do RTL aplica uma transformação que o modo "adc_counts" não aplica (p.ex. XOR das duas metades, ou concatenação de LSBs de várias amostras);
3. `numbers*.txt` foram gerados por um bitstream / versão de `fifo.c` diferente.

Como `fifo.c` comprovadamente **não** transforma nada, qualquer diferença está **no fabric** — e o fabric não é inspecionável nesta etapa.

---

## 3. Decisão

| Item | Decisão | Base |
|---|---|---|
| Largura da palavra de transporte | **32 bits, uint32 little-endian** | CONFIRMADA (`fifo.c` + PG080) |
| Condicionamento em software | **Nenhum** | CONFIRMADA (`fifo.c` verbatim) |
| A palavra de 32 bits pode carregar 2 amostras de ADC de 14→16 bits com sinal | **PROVÁVEL** | `adc_counts_laser_on.txt` (§2.1) + `parameters.txt` (2 canais) |
| Whitening / hash / LFSR em hardware antes do FIFO | **PROVÁVEL QUE NÃO EXISTA** | degeneração sob entrada fraca (§2.2) — evidência forte mas indireta |
| **Unidade da amostra física** (bits por amostra do ADC; nº de amostras por palavra de 32 bits; taxa efetiva após decimação) | **`DESCONHECIDO`** | requer o RTL. `adc_counts` sugere 14 bits/amostra e 2 amostras/palavra; o modo "qrng" pode diferir (§2.3). Taxa/decimação: sem evidência. |
| Existência de XOR/mistura/truncamento/decimação/seleção de bits no modo "qrng" | **`DESCONHECIDO`** | contradição §2.3 não resolvível sem fontes |
| Taxa de amostragem física efetiva na fonte de ruído | **`DESCONHECIDO`** | ADC RF do Red Pitaya é 125 MS/s / 14 bits, mas a taxa que chega ao FIFO depende de decimação/gating no RTL — não observável |

---

## 4. Ponto correto para os testes de saúde (RCT/APT — SP 800-90B §4.4)

- Os testes de saúde de SP 800-90B devem rodar sobre a **saída do noise source**, **antes** de qualquer condicionamento.
- Aqui **não há condicionamento** entre o FIFO e o consumidor (`fifo.c` verbatim), então o **ponto de amostragem para RCT/APT é a palavra de 32 bits lida do RDFD** — equivalentemente, o primeiro ponto em que o broker (`server_api.py`) recebe bytes contíguos e alinhados a palavra.
- **Ressalva:** se o modo "qrng" do RTL **empacota 2 amostras de 14 bits por palavra** (hipótese §2.1), o RCT/APT deveria idealmente rodar por **lane** (as duas metades de 16 bits separadas), não sobre o `uint32` inteiro — que teria estrutura de 2 canais. Isso ecoa a caracterização NIST já feita (o stream intercalado **falha** IID; as *byte-lanes* individuais **passam** IID). Enquanto a unidade física for `DESCONHECIDO`, o RCT/APT deve ser aplicado **conservadoramente por lane de 8 bits** e o `entropy_health` reportado como `not_assessed` para o `uint32` agregado.

## 5. Impacto em NIST / uso criptográfico

1. **Estimativa de entropia (SP 800-90B):** já caracterizado em `NIST_CHARACTERIZATION_20260829.md` — o stream `uint32` intercalado **não é IID**; o estimador limitante é o *Compression Test Estimate* (trilha bitstring); H_min normativa (≥1 M símbolos) ≈ **6.855 bits/byte** numa lane. Sem a unidade física confirmada, **não se pode somar entropia entre lanes** nem afirmar uma taxa de entropia por amostra do ADC.
2. **Bloqueio para `live_verified` / cripto:** a unidade física `DESCONHECIDO` e a possível estrutura de 2 canais / bits de sinal no `uint32` cru são bloqueadores B1. Um condicionador vetado por SP 800-90B (§3.1.5) **downstream** (no broker, não no FPGA) pode absorver a estrutura conhecida, mas o **cálculo de entrada** (`h_in` por bit de saída do noise source) exige a unidade física.
3. **Nenhuma geração criptográfica** (`/v1/entropy`, `/v1/random/cryptographic`, chaves/seeds/nonces/tokens) deve ser habilitada enquanto `PHYSICAL SAMPLE WIDTH = DESCONHECIDO`.

---

## 6. O que pediria aos autores para fechar a unidade física

- O RTL do datapath de aquisição (ver `FPGA_RECOVERY_PLAN.md`).
- Ou, na ausência do RTL: especificação escrita de (a) bits por amostra do ADC que entram no FIFO; (b) nº de amostras do ADC por palavra de 32 bits e o layout de bits; (c) decimação/gating entre o ADC (125 MS/s) e o FIFO; (d) se o modo "qrng" difere do modo "adc_counts" e como; (e) se há XOR entre canais/amostras.
