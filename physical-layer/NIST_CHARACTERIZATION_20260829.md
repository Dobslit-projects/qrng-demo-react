# Caracterização NIST SP 800-90B do TRANSPORT STREAM (item 10)

**Isto é CARACTERIZAÇÃO do fluxo de transporte (bytes que chegam ao
`server_api.py`), NÃO validação da noise source física.** A unidade da amostra
física é indeterminada (`RTL_INSPECTION_20260829.md`); "símbolo de 8 bits" = o
que foi passado ao `ea_iid`/`ea_non_iid` (`bits_per_symbol=8`), não a amostra
física.

- Ferramenta: `ea_iid` / `ea_non_iid` de `usnistgov/SP800-90B_EntropyAssessment`
  compilados na imagem `kapua-staging-nist-real:local` (Bongo VM, x86-64).
- Amostras: `characterization_2026/run_new_01..05.bin` (transferidas read-only da
  dobslit; SHA-256 conferido). Byte-lanes L0..L3 = `buf[k::4]` (transporte é `uint32`).
- Cap `timeout 2400s` no `ea_iid`; `7200s` no `ea_non_iid`.
- Campanha concluída 2026-08-29 05:26 UTC (`/root/nist_full/results/`).

## Classificação por resultado

Rótulos: **NORMATIVO** (≥ 1 000 000 símbolos) · **EXPLORATÓRIO** (< 1 000 000) ·
**INCONCLUSIVO** (timeout) · **FALHA DA FERRAMENTA**.

| arquivo | SHA-256 (12) | recorte | símbolos 8-bit | tamanho | IID | não-IID `h_min` | estimador limitante | `ea_iid` dur | classe |
|---|---|---|---|---|---|---|---|---|---|
| run_new_01 | 3021cbf19701 | intercalado | 1 048 576 | 1 MiB | **FAIL** | 6.951334 | Compression (bitstring) | ~110 s | NORMATIVO |
| run_new_01 | | L0 | 262 144 | 256 KiB | PASS | 6.825924 | Compression (bitstring) | 2 s | **EXPLORATÓRIO** |
| run_new_01 | | L1 | 262 144 | | PASS | 6.650033 | Compression (bitstring) | 3 s | EXPLORATÓRIO |
| run_new_01 | | L2 | 262 144 | | PASS | 6.899834 | Compression (bitstring) | 2 s | EXPLORATÓRIO |
| run_new_01 | | L3 | 262 144 | | PASS | 6.694475 | Compression (bitstring) | 2 s | EXPLORATÓRIO |
| run_new_02 | a75d0752d45b | intercalado | 1 048 576 | 1 MiB | **FAIL** | **6.878090** | Compression (bitstring) | ~105 s | NORMATIVO |
| run_new_02 | | L0 | 262 144 | | PASS | 6.865767 | Compression (bitstring) | 12 s | EXPLORATÓRIO |
| run_new_02 | | L1 | 262 144 | | PASS | 6.734915 | Compression (bitstring) | 2 s | EXPLORATÓRIO |
| run_new_02 | | L2 | 262 144 | | PASS | **6.491161** | Compression (bitstring) | 3 s | **EXPLORATÓRIO** (menor de todos) |
| run_new_02 | | L3 | 262 144 | | PASS | 6.829235 | Compression (bitstring) | 1 s | EXPLORATÓRIO |
| run_new_03 | 5d30cfabbf00 | intercalado | 10 485 760 | 10 MiB | **FAIL** | 7.121482 | Compression (bitstring) | 2171 s | NORMATIVO |
| run_new_03 | | L0 | 2 621 440 | 2,5 MiB | PASS | 6.986780 | predição (original track) | 4 s | NORMATIVO |
| run_new_03 | | L1 | 2 621 440 | | PASS | 6.986771 | predição (original track) | 28 s | NORMATIVO |
| run_new_03 | | L2 | 2 621 440 | | PASS | **6.915310** | Compression (bitstring) | 17 s | NORMATIVO |
| run_new_03 | | L3 | 2 621 440 | | PASS | 7.005597 | Compression (bitstring) | 20 s | NORMATIVO |
| run_new_04 | 5f99d109c6dc | intercalado | 10 485 760 | 10 MiB | **FAIL** | 7.062351 | Compression (bitstring) | 1992 s | NORMATIVO |
| run_new_04 | | L0 | 2 621 440 | | PASS | 6.947587 | Compression (bitstring) | 22 s | NORMATIVO |
| run_new_04 | | L1 | 2 621 440 | | PASS | 6.965981 | Compression (bitstring) | 30 s | NORMATIVO |
| run_new_04 | | L2 | 2 621 440 | | PASS | **6.855328** | Compression (bitstring) | 17 s | NORMATIVO (menor por lane, tamanho normativo) |
| run_new_04 | | L3 | 2 621 440 | | PASS | 6.985365 | Compression (bitstring) | 44 s | NORMATIVO |
| run_new_05 | 968b9465db62 | intercalado | 52 428 800 | 50 MiB | **INCONCLUSIVO** (`ea_iid` rc=124, timeout 2400 s) | 7.126602 (`ea_non_iid` rc=0, 635 s) | Compression (bitstring) | ≥2400 s | NORMATIVO (não-IID) / INCONCLUSIVO (IID) |
| run_new_05 | | L0 | 13 107 200 | 12,5 MiB | PASS | 7.090301 | Compression (bitstring) | 300 s | NORMATIVO |
| run_new_05 | | L1 | 13 107 200 | | PASS | 7.075453 | Compression (bitstring) | 184 s | NORMATIVO |
| run_new_05 | | L2 | 13 107 200 | | PASS | 7.018418 | Compression (bitstring) | 102 s | NORMATIVO |
| run_new_05 | | L3 | 13 107 200 | | PASS | 7.065006 | Compression (bitstring) | 59 s | NORMATIVO |

`.txt` u32: `run_new_01/02_u32.txt` normalizados (`struct.pack('<I', v)` por token)
→ SHA-256 byte-idêntico ao `.bin` correspondente (verificado). Não geraram
assessment próprio (redundantes).

Nenhuma **FALHA DA FERRAMENTA** (`rc=0` em todos, exceto o `rc=124`=timeout de
`run_new_05.full` `ea_iid`, classificado como INCONCLUSIVO).

## Determinações separadas (exigidas pelo item 10)

| grandeza | valor | base |
|---|---|---|
| **Menor estimativa válida do STREAM INTERCALADO** | **`6.878090` bits / símbolo de 8 bits** (run_new_02, intercalado) | IID FALHOU nos 4 intercalados de tamanho normativo (run_new_05 IID INCONCLUSIVO); crédito vem da trilha não-IID; limitante = Compression (bitstring) |
| **Menor estimativa válida POR LANE (tamanho NORMATIVO ≥ 1M)** | **`6.855328` bits / símbolo de 8 bits** (run_new_04.L2) | 20 byte-lanes de tamanho normativo (run_new_03/04/05), todas PASS IID; menor `h_min` não-IID |
| **Menor resultado EXPLORATÓRIO (< 1M símbolos)** | **`6.491161`** (run_new_02.L2, ~262 144 símbolos) | **NÃO é crédito operacional** — abaixo do mínimo normativo da SP 800-90B |
| **Estimador limitante (geral)** | **Compression Test Estimate (trilha bit string)** | `8 × H_bitstring < H_original` em 23 dos 25 recortes. Exceção: `run_new_03.L0`/`L1` — trilha original (estimador de predição), pois `H_original < 8·H_bitstring` |

## Diferenças entre lanes / independência

- Cada byte-lane PASSA IID isoladamente (24/24, incluindo as exploratórias).
- Todo stream **intercalado** de tamanho normativo FALHA IID (run_new_05 timeout).
- Leitura: **hipótese compatível com diferenças entre as lanes** (posições de byte
  com distribuições marginais distintas — coerente com `uint32-le` e com o RTL
  custom desconhecido). **NÃO** é prova de comportamento não-IID intrínseco da
  fonte, **NEM** prova de (in)dependência entre lanes.
- **NÃO somar entropia entre lanes.** Sem demonstração de independência serial e
  cruzada (capturas longas de-intercaladas), o crédito por palavra de 32 bits
  **não** é `4 × h_lane`. O crédito conservador disponível hoje é o de **UMA**
  lane / de UM símbolo de 8 bits do stream intercalado — e mesmo esse é
  **caracterização de transporte**, não crédito da noise source (unidade física
  indeterminada — item 9).

## Restart tests (SP 800-90B §3.1.4)

**NÃO EXECUTADOS.** Dependem de reinicializações reais da noise source física
(item 11). A campanha acima é sobre capturas de um único regime, sem restart.
