# Definição formal da noise source e da unidade de amostra (item 3)

**Escopo do que foi possível verificar nesta rodada**: `fifo.c` (driver C,
lido em rodada anterior — conteúdo não re-hasheável nesta sessão por
inacessibilidade do host FPGA, ver `BASELINE.md`), `server_api.py` (baseline
capturado nesta rodada), e evidência estatística de duas capturas de
1.000.000 palavras cada. **RTL e documentação de hardware do ADC/fotodetector
não foram encontrados nem acessados em nenhuma sessão desta auditoria** —
qualquer afirmação abaixo sobre o nível físico além do que `fifo.c` prova
diretamente é rotulada como não confirmada.

## O que `fifo.c` prova diretamente

- Lê, via `mmap` sobre `/dev/mem`, um registrador AXI FIFO mapeado em
  `0x43C00000 + 0x11000` na Red Pitaya (Zynq).
- Cada leitura do registrador retorna um valor de 32 bits, imediatamente
  escrito como `htole32(num)` (4 bytes little-endian) na saída, sem
  nenhuma transformação, filtro, contador ou padding adicionado no driver.
- `fifo.c.old` (versão histórica) confirma que a ÚNICA mudança ao longo do
  tempo foi de formato de serialização (ASCII decimal → binário fixo) —
  não do conteúdo do registrador em si.

**O que `fifo.c` NÃO prova**: se o valor de 32 bits dentro do registrador
representa uma única amostra física do fotodetector/ADC, ou se é um
container que empacota múltiplas leituras menores (ex.: 4× 8 bits de um
ADC mais estreito, ou 2× 16 bits). O driver é opaco a essa distinção — ele
relata fielmente o que está no registrador, sem saber o que o RTL colocou
lá.

## Evidência estatística (a favor de uma decisão, não uma prova de RTL)

Da bateria estatística da rodada anterior (`docs/stat_battery_20260826_output.txt`)
e da avaliação SP 800-90B por lane:

| Lane | min-entropia (não-IID, conservadora) | Correlação com as outras 3 lanes |
|---|---|---|
| 0 | 6,978486 bits/byte | ~0,0002 a 0,0012 (desprezível) |
| 1 | 7,312323 bits/byte | idem |
| 2 | 7,331528 bits/byte | idem |
| 3 | 7,182924 bits/byte | idem |

As 4 lanes são **estatisticamente distintas entre si** (diferença de até
0,35 bits/byte entre a mais fraca e a mais forte — grande demais para ser
ruído de amostragem em 1.000.000 de observações) e **quase-independentes**
(correlação cruzada ~0,001, nenhuma na faixa que indicaria "são a mesma
fonte replicada" nem "são vazamento de uma para a outra"). Isso é mais
consistente com "4 leituras relativamente independentes de uma fonte
analógica, empacotadas na mesma palavra" do que com "1 amostra física
única de 32 bits de um ADC de resolução total" — ADCs reais de alta
resolução normalmente mostram estrutura de correlação entre bits
adjacentes (ruído térmico/LSB correlacionado), que não foi observada aqui
entre as *lanes* (não testamos correlação bit-a-bit dentro de uma lane
nesta rodada).

## Decisão formal (provisória, sujeita a confirmação por RTL/documentação)

```text
NOISE SOURCE SAMPLE = byte (8 bits) por lane -- decisão PROVISÓRIA baseada
  em evidência estatística (lanes distintas entre si, quase-independentes),
  NÃO CONFIRMADA por RTL ou documentação do ADC/fotodetector (inacessíveis
  nesta auditoria). Se o RTL revelar que o uint32 é de fato uma única
  amostra física de 32 bits, esta decisão precisa ser revisada.
TRANSPORT WORD = uint32 little-endian (CONFIRMADO, fifo.c)
ASSESSMENT SYMBOL = byte (8 bits), avaliado separadamente por lane
  (prática já adotada desde o item 6 da rodada anterior; esta rodada
  adiciona a justificativa estatística formal para NÃO somar as 4 lanes
  em um único símbolo/stream sem evidência de homogeneidade)
HEALTH TEST SYMBOL = byte (8 bits), por lane -- RCT/APT devem rodar
  INDEPENDENTEMENTE por lane (ver seção RCT/APT), nunca sobre um stream
  intercalado de 32 bits, dado que as lanes têm min-entropias mensuravelmente
  diferentes -- aplicar um único threshold ao stream combinado esconderia
  a lane mais fraca (lane 0, H=6,98) atrás da média das outras 3.
```

## Respostas às perguntas específicas (evidência disponível)

| Pergunta | Resposta | Base |
|---|---|---|
| O uint32 corresponde a uma amostra física única? | **Provavelmente não** (ver decisão acima) | estatística de lanes, não RTL |
| Contém múltiplas amostras menores? | **Provável, não confirmado** | idem |
| Os 4 bytes representam partes equivalentes? | **Não** — min-entropias diferem 6,98–7,33 | SP 800-90B por lane |
| Há contador, timestamp, padding, bits fixos? | **Não** — 0 bits constantes em 32 posições, sem padrão de diferença-consecutiva de contador (rodada anterior) | análise bit-a-bit |
| Largura efetiva da noise source (ADC/fotodetector)? | **Desconhecida** | RTL/datasheet não acessados |
| Ponto de digitização? | **Antes do FIFO** (fifo.c só lê um registrador já digital) — ponto exato no RTL desconhecido | fifo.c |
| Condicionamento em FPGA? | **Nenhum encontrado no driver C**; RTL não inspecionado | fifo.c |
| Evento que representa restart real da noise source? | **Não determinado com confiança** — hipótese não verificada: power-cycle físico da placa, não apenas restart do processo Linux | inferência, não evidência direta |
| Reset do FIFO reinicia a fonte ou só o transporte? | **Hipótese: só o transporte** (FIFO é buffer digital) — não confirmado | inferência |
| Reiniciar `qrng-connector.py`/`server_api.py` equivale a reiniciar a fonte? | **Não** — são processos Linux consumindo o FIFO; não tocam o hardware analógico | topologia confirmada (BASELINE.md) |
| É necessário reset de FPGA ou power cycle para um restart real? | **Hipótese, não confirmada**: provavelmente sim | inferência |

**Consequência prática**: a "restart campaign" do item 8 não pode ser
projetada com confiança até esta última pergunta ser respondida por quem
tem acesso à documentação de hardware ou pode testar um power-cycle
controlado — sem isso, "reiniciar" pode estar reiniciando apenas o
transporte (FIFO/processo), não a fonte física, invalidando a campanha
antes mesmo de começar.
