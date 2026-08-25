# Caracterização da unidade de amostra física (item 3 da auditoria)

Este documento define, com evidência direta de hardware e de dados, o que
uma amostra `uint32` do stream QRNG realmente representa antes de qualquer
alegação sobre origem quântica ou entropia. Ele não substitui uma
certificação formal — documenta o que foi verificado nesta auditoria e onde
a verificação ainda depende de metodologia/proveniência não confirmada.

## 1. O que o registro AXI de 32 bits contém (evidência de RTL/driver)

Fonte: `fifo.c` no host da FPGA (Red Pitaya / Zynq), que lê o FIFO via
`mmap` sobre `/dev/mem` no offset `0x43C00000 + 0x11000` e escreve
`htole32(num)` — 4 bytes little-endian, um `read()` de registro por amostra,
sem nenhum pós-processamento (sem XOR, sem whitening, sem descarte de bits,
sem condicionamento). O arquivo `fifo.c.old` (versão anterior, ainda no
histórico) confirma que a única mudança ao longo do tempo foi de formato de
serialização (ASCII decimal → binário little-endian fixo), não de conteúdo:
o valor de 32 bits lido do registro é repassado integralmente em ambas as
versões.

Isso estabelece o contrato de transporte: **o que sai do FIFO é exatamente
o conteúdo do registro AXI de 32 bits, sem edição**. A pergunta que resta é
quantos desses 32 bits carregam informação com variação estatística real —
isto é respondido empiricamente na seção 2, não inferido do RTL (que não
foi lido a nível de fonte HDL nesta auditoria; a fonte de verdade aqui é o
comportamento observado do driver C e dos dados que ele produz).

## 2. Evidência estatística: os 32 bits carregam entropia, não são um
   container com padding

Amostra usada: **1.000.000 palavras uint32 (4.000.000 bytes)**, capturadas
ao vivo via `GET /v1/raw?bytes=4000000` (o endpoint HTTP de produção, sem
interromper o pipeline em execução — não uma leitura direta e concorrente
do socket do FIFO).

- Capturado em: `2026-08-25T14:04:59Z`
- SHA-256: `9c7ec2803b1b9507407cb105de85f2174d739f2da48f6f292ae8883d20b92495`
- Script de análise: `analyze_sample.py` (incluído junto a este documento)

Resultados:

| Verificação | Resultado |
|---|---|
| Entropia de Shannon por byte-lane (4 lanes, máx. teórico 8.0 bits) | ~7.9996 bits em **todas as 4 lanes**, 256/256 valores distintos observados em cada uma |
| Bits constantes (sempre 0 ou sempre 1) entre as 32 posições | **0 de 32** — nenhum bit é constante, incluindo os bits mais significativos |
| Fração de "1"s por posição de bit (32 posições) | Entre 0.496 e 0.499 em todas as posições — sem viés estrutural detectável neste tamanho de amostra |
| Padrão de contador (diferença mais comum entre 10.000 amostras consecutivas) | A diferença mais frequente ocorre em apenas **0.01%** dos casos — descarta um contador monotônico disfarçado |
| min / max do uint32 completo | min=26152, max=4294966864 — cobre quase toda a faixa de 32 bits |
| Média observada vs. esperada para uniforme | 2.133.050.245,1 observado vs. 2.147.483.648,0 esperado — desvio real e mensurável (~0,67%), registrado aqui como um sinal a acompanhar, **não** interpretado como defeito ou como prova de não-uniformidade sem uma amostra maior e um teste estatístico formal (ex.: chi-quadrado com N maior, ou os testes IID/non-IID do NIST SP 800-90B já integrados ao pipeline) |

**Conclusão suportada pelos dados**: os 32 bits da palavra transportada
carregam variação estatística real e independente por posição de bit,
sem evidência de bits de padding, flags ou contador. Isto sustenta tratar
a palavra completa como a unidade estatística relevante — que é exatamente
o que o commit `65fb43b` (item 2) formaliza como
`assessment_symbol_width=8` sobre a decomposição byte a byte little-endian,
e não como uma inferência separada sobre "quantos bits têm significado
físico".

**O que isto NÃO prova**: variação estatística nos dados de saída não é,
por si só, prova de origem quântica do ruído, nem substitui uma avaliação
formal NIST SP 800-90B sobre uma amostra proveniente de captura controlada
e documentada. Ausência de padrão óbvio é necessária mas não suficiente.

## 3. Sobre nomes de arquivo como `laser_on` / `laser_off` / `shotnoise`

Nenhum arquivo com esses nomes exatos foi encontrado nos hosts acessados
nesta auditoria (Bongo VM, dobslit VM). O que existe é uma série de
capturas recorrentes nomeadas `numbers_newlaser_evoa_dual_run1*`,
reexecutadas a cada poucas horas desde pelo menos 2026-06-30, cada uma
com um diretório de resultado NIST associado
(`results_numbers_newlaser_evoa_dual_run1_<timestamp>/`).

Por instrução explícita desta auditoria (item 3): **nomes de arquivo não
são evidência de metodologia de captura, configuração experimental ou
origem quântica confirmada.** Um nome como `newlaser` ou (hipotético)
`laser_on`/`laser_off`/`shotnoise` indica apenas a intenção declarada de
quem gerou o arquivo — não confirma que o laser estava de fato ligado ou
desligado no momento da captura, nem que a configuração óptica correspondia
à alegada, nem que a caracterização segue uma metodologia documentada e
repetível.

**Tratamento recomendado até que a proveniência seja verificada**: qualquer
arquivo cujo nome sugira uma condição experimental específica (laser
ligado/desligado, shot noise, etc.) deve ser rotulado no sistema como
`sample_origin` apropriado ao mecanismo real de submissão (`user_upload`,
`historical_assessment` — ver item 2 / commit `65fb43b`), e qualquer
alegação sobre a condição experimental representada pelo nome do arquivo
deve ser tratada como **não verificada** na UI e na documentação pública,
até que exista um registro de proveniência explícito (quem capturou, com
qual configuração, quando, com qual metodologia) — não apenas o nome do
arquivo. Isto é consistente com a mudança do item 2: `captured_at` agora é
persistido a partir do momento da submissão real, nunca inferido do nome
ou do diretório.

## 4. Resumo para os itens 7/9 (linguagem correta em docs públicas)

- Não afirmar "origem quântica comprovada" apenas por existir hardware ou
  arquivos de caracterização com nomes sugestivos.
- Distinguir claramente, em qualquer documento público: (a) o que foi
  medido estatisticamente sobre a saída (entropia por lane, ausência de
  bits constantes, ausência de padrão de contador — fatos, com amostra e
  hash citados), de (b) alegações sobre o mecanismo físico gerador
  (requer proveniência documentada, não incluída neste documento).
- `assessment_symbol_width=8` é uma decisão sobre como o NIST SP 800-90B
  avalia os bytes transportados, não uma alegação sobre "quantos bits são
  quânticos". As duas coisas são independentes e não devem ser confundidas
  na documentação pública (item 7).
