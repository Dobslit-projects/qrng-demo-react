# RCT/APT — recomendação de arquitetura (fase item 11)

> **RCT/APT permanecem FORA do caminho live. Nenhum threshold selecionado.**
> Este documento só usa os resultados desta rodada (piloto NIST L0 + telemetria
> não invasiva 2026-08-28) para avançar a decisão arquitetural. Complementa
> `RCT_APT_REVIEW.md` §12/§12bis (que continua válido).

## Novos dados desta rodada

| dado | valor | fonte |
|---|---|---|
| IID por byte-lane (cap3, 2 621 440 símbolos/lane) | **4/4 PASSAM** (chi-square + LRS + permutação) | piloto L0 |
| IID do stream **intercalado** (cap1/cap2 1 MiB) | **FALHA** (permutação); cap3 10 MiB **inconclusivo** (timeout) | piloto L0 |
| não-IID `h_min` por byte-lane | 6,915 – 7,006 bits / símbolo de 8 bits | `ea_non_iid` @ `87c104d0` |
| não-IID `h_min` intercalado | 6,88 – 7,12 bits / símbolo de 8 bits | idem |
| vazão de transporte (2026-08-28, 30,4 s) | **699 220 B/s ≈ 174 805 uint32/s** | `/health` `total_pushed` |
| consumo real | ~0 B/s (`total_popped` parado) | idem |
| descarte drop-oldest acumulado | **99,48 %** de tudo que a FPGA já produziu | `total_pushed − total_popped − size` |

## O que esses dados MUDAM na decisão

1. **Não rodar RCT/APT sobre o stream de bytes intercalado cru.** O L0 mostra
   que o stream intercalado **falha IID por estrutura** (posições de byte com
   distribuições marginais distintas — hipótese compatível com o transporte
   `uint32-le`). Um health test rodando sobre `/tmp/fifo_qrng` byte a byte
   **dispararia falso alarme numa fonte saudável**. Portanto: o health test tem
   de operar **de-intercalado** (por byte-lane) OU **sobre a palavra uint32
   inteira** — nunca sobre a sequência de bytes bruta.

2. **RCT/APT por byte-lane é defensável como ESCOLHA DE ANÁLISE** (cada lane
   passa IID no L0), mas continua herdando um recorte de **transporte**, não de
   física. Se o RTL revelar que 1 uint32 = 1 amostra física de 32 bits, o teste
   deve ser reparametrizado sobre a palavra (símbolo de 32 bits, 1 stream).

3. **Independência entre lanes: ainda INCONCLUSIVA.** Cada lane passar IID
   isoladamente **não** prova que as 4 são mutuamente independentes. A falha do
   intercalado é *compatível com* diferenças entre lanes, não prova de
   dependência. ⇒ o **union bound** dos 8 testes continua o teto conservador;
   **k-de-n continua hipótese** até as capturas de-intercaladas longas da fonte.

4. **Buffer: o health test tem de ler o stream do PRODUTOR, não o de cada
   cliente.** Hoje o RingBuffer está cheio e o drop-oldest descarta 99,48 % —
   um teste que amostrasse o que um cliente `pop`a veria uma fração esparsa e
   dependente do consumo. ⇒ instrumentar num **tap único no produtor** (o
   harness do item 8, `stream_tap.py`, read-once/forward-once) para o health
   test ver a fonte completa.

## Recomendação de arquitetura (a decidir na janela autorizada)

| dimensão | recomendação | depende de |
|---|---|---|
| **Unidade da amostra física** | INCONCLUSIVA — decidir (a) byte-lane 8 bits × 4 lanes **ou** (b) palavra uint32 de 32 bits × 1 stream a partir do **RTL / registradores AXI / construção da palavra**. Até lá, qualquer protótipo de health test roda **de-intercalado**. | inspeção FPGA (bloqueada — `FPGA_INSPECTION.md`) |
| **Unidade do health test** | igual à unidade física escolhida. **Proibido** rodar sobre a sequência de bytes intercalada. | idem |
| **Taxa física de símbolos** | DESCONHECIDA. Só a vazão de transporte (~174 805 uint32/s). A relação "1 uint32 = N amostras físicas" define as oportunidades/s e, portanto, todo o cálculo de cutoff. | taxa do ADC / clock do bloco de ruído no RTL |
| **Nº de testes simultâneos** | 8 sob (a) (4 lanes × {RCT, APT}); 2 sob (b). Union bound = teto. **Expor `qrng_rct_failures_total{lane}` / `qrng_apt_failures_total{lane}` por lane ANTES de qualquer regra k-de-n.** | decisão (a)/(b) |
| **Lanes independentes?** | Assumir **NÃO** (union bound conservador). k-de-n só depois de medir dependência serial e cruzada em capturas longas de-intercaladas. | restart campaign + capturas da fonte |
| **Custo de um falso positivo** | NÃO QUANTIFICADO. Definir: um `FAILED` **bloqueia** `/v1/random` por inteiro ou **degrada** (serve com aviso)? Qual o SLA de entrega? Qual o orçamento de MTBF de falso bloqueio aceito pela operação? | operação |
| **Política de falha** | Revisar o "1 janela falha → `FAILED`, sem histerese". Em taxa de produção, qualquer α utilizável leva a um trip quase certo ao longo do tempo (§12.2 do review). Opções a decidir **junto com α**: (i) k janelas consecutivas; (ii) trip por taxa (X falhas em Y s); (iii) histerese DEGRADED→FAILED. | decisão de α + custo do falso positivo |
| **Política de recuperação** | Definir: "recuperação = re-rodar startup tests sobre M janelas novas, todas passam" + nº máx. de tentativas antes de escalar para humano + **duração operacional alvo** (hoje indefinida). | operação |
| **Comportamento do buffer** | Health test lê do **tap do produtor** (item 8), não do stream de um cliente. Definir o que acontece com o buffer/servidor quando o health test está `FAILED` (continua enchendo? para de servir? serve com header de aviso?). | decisão de política de falha |

## Thresholds — o gate (dados ainda necessários)

Nenhum (W, α, cutoffs, k-de-n) pode ser selecionado antes de **todos**:

1. **RTL / registradores AXI / FIFO** → unidade da amostra física; existência de
   condicionamento em hardware. *(bloqueado — `FPGA_INSPECTION.md`)*
2. **Taxa de amostragem do ADC / clock do bloco de ruído** → taxa física de
   símbolos → oportunidades/s. *(bloqueado — mesma inspeção)*
3. **Restart campaign** (1000 reinicializações reais da noise source) → restart
   tests da SP 800-90B + não-IID sob reinício. *(harness pronto,
   `restart-campaign/`; campanha NÃO executada — aguarda autorização e a
   definição do evento de restart real)*
4. **Dependência entre lanes** medida em capturas **longas de-intercaladas** da
   fonte (não do transporte) → union bound vs k-de-n.
5. **SLA operacional**: custo de um `FAILED` falso na entrega, MTBF de falso
   bloqueio aceitável, orçamento de tempo de recuperação.

Com (1)–(5) resolvidos: escolher a unidade → recalcular min-entropia do
símbolo dessa unidade → derivar oportunidades/s → escolher MTBF alvo →
resolver (W, α, cutoffs) → decidir k-de-n com base na dependência medida →
definir histerese/política de trip → só então ativar em **shadow mode**
(observa, não bloqueia) por um período antes de qualquer bloqueio real.

## Não feito (por instrução)

- Nada aplicado ao módulo `qrng_health_tests.py` — α continua 2⁻²⁰, cutoffs
  4 / 18-16-16-16, **não operacionais**.
- Nenhum threshold selecionado. Nenhum RCT/APT no caminho live. Nenhuma regra
  k-de-n. Restart campaign não executada.
