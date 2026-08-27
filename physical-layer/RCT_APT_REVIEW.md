# Revisão RCT/APT contra NIST SP 800-90B §4.4 (item 3)

Módulo revisado: `physical-layer/qrng-api/qrng_health_tests.py` (recuperado no commit
`07fb2af`, ajustado em `42d5b7e` e neste). Testes: `test_qrng_health_tests.py` — **27/27**.
**Não conectado a `server_api.py` nem a nenhum caminho live.**

## 1. Fórmula do RCT — CONFIRMADA

SP 800-90B §4.4.1: `C = 1 + ⌈ −log₂(α) / H ⌉`.
Código (`rct_cutoff`): `1 + math.ceil(-math.log2(alpha) / H)`. Idêntico.
Com α = 2⁻²⁰, H_lane0 = 6.978486 → `1 + ceil(20/6.978486)` = `1 + ceil(2.866)` = **4**. Confere
com o valor preliminar do pedido.

## 2. Fórmula do APT — REESCRITA para a fórmula publicada da SP 800-90B

### 2.1 O que estava ambíguo antes

A versão anterior deste documento (e o `apt_cutoff` do commit `42d5b7e`) misturava
duas variáveis diferentes:

- `P(Binomial(W−1, p) ≥ C) ≤ α` — aqui `C` é comparado com `X` = nº de matches
  entre as `W−1` amostras **após** a referência;
- `B = 1 + X`, falha quando `B ≥ C` — aqui `C` é comparado com `B` (que inclui a
  referência).

São inconsistentes: `B ≥ C  ⟺  X ≥ C−1`, não `X ≥ C`. O `apt_cutoff` de `42d5b7e`
usava `n = W−1` e devolvia `menor c : P(X ≥ c) ≤ α`, o que dava H=1→310 em vez do
**311** da Tabela 2 da SP 800-90B (as 4 lanes, todas com H≈7, davam o mesmo número
por acaso).

### 2.2 Fórmula agora implementada (SP 800-90B §4.4.2, texto publicado)

```
C = 1 + CRITBINOM(W, 2^(−H), 1 − α)
```

| variável | definição (idêntica à SP 800-90B) |
|---|---|
| `W` | tamanho da janela do APT = **512** (dados não-binários). A 1ª amostra da janela é a referência `A`. |
| `H` | min-entropia por símbolo (bits) da lane. |
| `p` | `2^(−H)` — limite superior da probabilidade de a referência se repetir. |
| `α` | falso positivo alvo **por janela** = `2⁻²⁰` (valor com que as Tabelas 1 e 2 do documento foram calculadas). |
| `CRITBINOM(W, p, 1−α)` | menor inteiro `k` com `P(Binomial(W, p) ≤ k) ≥ 1−α` (função do Excel; = `scipy.stats.binom.ppf`). |
| `B` | contador do teste. Começa em **1** (a referência conta). Incrementa 1 por match nas `W−1` amostras seguintes. |
| falha | quando `B ≥ C`. Como `B = 1 + X`, isto é `X ≥ C−1`. |

`apt_cutoff` implementa `1 + _critbinom(W, p, 1−α)` com `_critbinom` = busca binária
sobre a CDF binomial (`lgamma`). O `APTState` não mudou: já contava `B` a partir de
1 (correção de `42d5b7e`) e falhava em `count >= cutoff`.

### 2.3 Verificação independente (não usa `apt_cutoff` para gerar o esperado)

`test_qrng_health_tests.py::TestAPTCutoffAgainstSP80090BTable2`:

1. **Valores literais da Tabela 2 da SP 800-90B (W=512, α=2⁻²⁰):**
   `{H=8 → 13, H=4 → 62, H=2 → 177, H=1 → 311, H=0.5 → 410}` — `apt_cutoff` reproduz
   os 5 exatamente.
2. **2ª implementação de referência independente** (`_ref_apt_cutoff`): usa
   `math.comb` (binômio exato em inteiros) + soma da cauda superior por varredura
   linear — nenhuma linha em comum com `apt_cutoff`/`_critbinom`/`_binom_cdf`.
   Bate com `apt_cutoff` nos 5 pontos da tabela **e** nas 4 lanes.
3. **Propriedade que define o cutoff:** em `C−1` a cauda `P(X ≥ C) ≤ α`; em `C−2`
   ela ainda `> α` (recalculada com `math.comb`, não com o código do módulo).

### 2.4 Cutoffs das 4 lanes (recalculados com a fórmula publicada)

| lane | H | RCT (`1+⌈20/H⌉`) | APT (`1+CRITBINOM(512, 2⁻ᴴ, 1−2⁻²⁰)`) |
|---|---|---|---|
| 0 | 6.978486 | 4 | 18 |
| 1 | 7.312323 | 4 | 16 |
| 2 | 7.331528 | 4 | 16 |
| 3 | 7.182924 | 4 | 16 |

Numericamente **iguais aos anteriores** — mas a fórmula, a documentação e os testes
de referência foram corrigidos assim mesmo (as lanes só coincidiam por terem H
parecido; a fórmula errada divergia da tabela em H=1).

## 3. Janela — CONFIRMADA

`APT_WINDOW = 512` (SP 800-90B: 512 para dados não-binários; 1024 seria só para
stream binário). A unidade avaliada é o **byte por lane** (256 símbolos), não-binária
→ 512 correto. `seen_in_window` reinicia a referência após `W−1` amostras
subsequentes (1 referência + W−1 = W por janela). Confere.

## 4. Cutoff por lane — CONFIRMADO

| lane | H (não-IID, conservadora) | RCT cutoff | APT cutoff (W=512) |
|---|---|---|---|
| 0 | 6.978486 | 4 | 18 |
| 1 | 7.312323 | 4 | 16 |
| 2 | 7.331528 | 4 | 16 |
| 3 | 7.182924 | 4 | 16 |

lane0 (menor H) recebe o maior cutoff de APT — correto: menor entropia ⇒ maior
probabilidade de repetição natural ⇒ cutoff precisa ser mais frouxo para manter α.
**PRELIMINAR**: derivado de UMA captura de referência (2026-08-25/26), não de uma
estimativa pós-restart-campaign. Deve ser revalidado (item 8, bloqueado).

## 5. Comportamento exatamente no cutoff — CONFIRMADO (pós-correção)

- **RCT**: `C` amostras idênticas consecutivas ⇒ contador chega a `C` ⇒ `count >= cutoff`
  ⇒ `HealthTestFailure`. `C−1` repetições passam. (`test_sequencia_exatamente_no_cutoff_falha`,
  `test_sequencia_acima_do_cutoff_falha_no_primeiro_ponto_de_corte`.)
- **APT**: `B = 1` na referência; após `k` matches `B = 1+k`; dispara no primeiro `k`
  com `B ≥ C`, i.e. `k = C−1` matches. Em termos de `X` (matches, sem contar a
  referência): falha ⟺ `X ≥ C−1`. `test_apt_no_limite_falha` (dispara),
  `test_apt_abaixo_do_limite_nao_falha` (`B = C−1`, passa),
  `test_apt_acima_do_limite_falha_no_primeiro_ponto_de_corte` (`X = C−2` iterações
  completam antes do raise).

## 6. Startup test sobre ≥ 1024 amostras consecutivas — CONFIRMADO

`STARTUP_TEST_MIN_SAMPLES = 1024`. `push_word()` em `STARTUP_TESTING` acumula até
`startup_min_samples` sem falha antes de transicionar para `HEALTHY`. SP 800-90B
recomenda ≥ 1024 amostras consecutivas aprovadas no startup. Confere.

## 7. Descarte das amostras de startup — CONFIRMADO

Durante `STARTUP_TESTING`, `push_word()` incrementa `qrng_discarded_samples_total`,
guarda em `_startup_buffer` (interno) e **retorna `None`** — nunca devolve a amostra
ao chamador. `complete_recovery()` volta a `STARTUP_TESTING` via `_reset_internal`,
que zera `_startup_buffer`. Não há caminho por onde uma amostra de startup chegue a
`get_sample`/consumo. Confere.

## 8. Interrupção da entrega após falha persistente — CONFIRMADO

Falha de RCT/APT em operação (`HEALTHY`/`DEGRADED`) ⇒ `state = FAILED`, exceção
propagada. `push_word()` em `FAILED` levanta `RuntimeError` ("amostras pós-falha não
podem entrar no buffer"). Não há retorno de bytes em `FAILED`. `test_falha_durante_
operacao_normal_interrompe_a_entrega_live`, `test_dados_posteriores_a_falha_nao_entram_
no_buffer`.

Observação (não bug): não há histerese / contador de "falhas persistentes" — **uma**
falha de RCT/APT já vai direto para `FAILED`. Isso é o comportamento correto para
RCT/APT (são testes cujo α já embute a raridade), mas ver §12 sobre o efeito de rodar
8 testes em paralelo na vazão real.

## 9. Recuperação só por procedimento explícito — CONFIRMADO

`FAILED → RECOVERING` só por `begin_recovery()` (levanta se chamado fora de `FAILED`);
`RECOVERING → STARTUP_TESTING` só por `complete_recovery()`. Nunca automático. De
`STARTUP_TESTING` a fonte tem de provar saúde de novo sobre 1024 amostras. `DEGRADED`
(sinalizado externamente, não por RCT/APT) volta a `HEALTHY` só por
`recover_to_healthy_from_degraded()`. `test_recuperacao_exige_procedimento_explicito_
nao_automatico`.

## 10. Métricas — CONFIRMADAS

`HealthTestMetrics` expõe exatamente os nomes pedidos: `qrng_rct_failures_total`,
`qrng_apt_failures_total`, `qrng_startup_test_failures_total`, `qrng_health_state`,
`qrng_last_health_failure_timestamp`, `qrng_discarded_samples_total`. In-process,
não persistidas — a exposição real via `/metrics` fica para a (futura, autorizada)
integração.

## 11. Health payload e erro estruturado — CONFIRMADOS

`health_payload()` devolve `{state, lanes, metrics{...}}` — estruturado, nunca um
booleano `ok`. `HealthTestFailure(test_name, lane, detail)` carrega qual teste, qual
lane e o detalhe — suficiente para a API traduzir em erro estruturado 503 para o
consumidor. `test_health_payload_estruturado_reflete_falha`,
`test_health_payload_reflete_falha` (via `as_dict`).

## 12. Falso alarme — análise (PROVISÓRIA)

A estimativa anterior de "~1 falso alarme a cada 22 min" está **removida** (usava um
exemplo arbitrário de 10⁵ símbolos/s, tratava o limite de união como taxa, e ignorava
que o **RCT** domina).

Script: `physical-layer/qrng-api/false_alarm_analysis.py` — standalone, stdlib,
**seed fixa `20260827`**, reprodutível (~80 s; não está no CI, é análise).

### 12.0 Provisoriedade (explícita)

- A taxa usada é a **vazão observada no TRANSPORTE** (`total_pushed`/tempo), **não**
  uma taxa física de amostras comprovada. Se o `uint32` empacota N sub-amostras, a
  taxa física por amostra muda por N.
- `NOISE SOURCE SAMPLE = byte por lane` continua **PROVISÓRIO** (pendente RTL/AXI/FIFO).
  Toda a parametrização herda isso.
- Resultados dependem de hipóteses de **IID e estacionariedade**. A captura real tem
  viés pequeno mas sistemático e não foi testada para independência serial suficiente
  → tratar como **ordem de grandeza**.
- **MTBF ≠ garantia operacional** — é o inverso de uma taxa média sob o modelo; não
  cobre não-estacionariedade, rajadas nem falha física.
- **Nenhum α foi selecionado para produção** (ver §12bis).

### 12.1 Quatro blocos de resultado, mantidos SEPARADOS

**(D) Dados observados** — `GET :18001/health` T0/T30/T60, 2026-08-27:
`total_pushed` +40.837.572 B / 60 s ⇒ **680.626 B/s** ⇒ **170.157 transport words/s**
⇒ **170.157 símbolos/s por lane** *(provisório: byte/lane)* ⇒ ≈ 332 janelas APT/s/lane.
`total_popped` quase parado → consumo real hoje ≈ 0 (demo); os números usam a taxa da
**fonte** como cota superior (o que os testes veriam a consumo pleno).

**(A) Bound por oportunidade** — analítico, `p = 2⁻ᴴ` (a hipótese que a própria
SP 800-90B usa). RCT por posição ≤ `p^(C−1)`; APT por janela ≤ `P(Binom(W−1,p) ≥ C−1)`.
São **limites superiores**, não a taxa exata.

**(B) Modelo IID uniforme** — analítico, `p = 1/256` (fonte hipotética perfeita).

**(C) Simulação empírica** — Monte Carlo seeded, em **regime tratável** (cutoffs
pequenos, `p` alto, onde os eventos são frequentes). **Não** se observa evento raro
direto. Serve para verificar se as fórmulas de (A)/(B) se comportam como cotas
superiores nas configurações testadas — não é evidência sobre a fonte física:

| teste | resultado |
|---|---|
| C1 RCT vs `p_max^(C−1)` | O valor observado na simulação foi **consistente com o limite analítico** nas 5 configurações avaliadas (`sim/bound` ≈ 0,07–0,17; o bound é conservador). |
| C2 APT (janela não sobreposta) vs `P(Binom(W−1,p_max) ≥ C−1)` | O valor observado na simulação foi **consistente com o limite analítico** nas 5 configurações avaliadas (`sim/bound` ≈ 0,12–0,17). |
| C3 janela **sobreposta × não sobreposta** | a não sobreposta (implementada) reseta a referência a cada W; a sobreposta reavalia a cada amostra e tem taxa por-amostra menor mas oportunidades correlacionadas — comparação registrada, sem mudança de implementação |
| C4 **interação 4 lanes** (RCT, C=3) | **Cenário sintético**: 4 streams i.i.d. uniformes gerados conforme o modelo do script. Nesse cenário, `qualquer-das-4` ≈ **0,79 × (4 × single)** → subaditividade **válida apenas para esse cenário sintético**. A razão 0,79 **não demonstra independência das lanes físicas**; o union bound permanece um **teto conservador**. A dependência real entre lanes deve ser avaliada nas **capturas da fonte** (ver §8 do plano). |
| C5 **sensibilidade à taxa** | linear (só um multiplicador): 0,1×/1×/10×/100× a taxa → MTBF ÷ 10 a cada ×10 |
| C6 **sensibilidade a p_max** | ±0,001 em torno de 0,00793 move o MTBF ~2× e pode ±1 no cutoff do APT |
| IC 95% (Wilson) | reportado por linha em C1/C2 |

### 12.2 Taxa agregada de falso bloqueio (limite de união dos 8 testes)

O limite de união (soma das taxas dos 8 testes) é um **teto conservador**: no cenário
sintético de C4 as 4 lanes contribuem de forma aproximadamente aditiva, e RCT+APT na
mesma lane são positivamente correlacionados (a soma superestima). Isto **não** é uma
afirmação sobre a dependência entre as lanes físicas.

| α | RCT/lane | APT/lane | **(A)** worst-case (1 a cada) | **(B)** iid-uniforme (1 a cada) |
|---|---|---|---|---|
| **2⁻²⁰** (atual) | 4 | 18/16/16/16 | **~4,5 s** | ~25 s |
| 2⁻²⁴ | 5 | 19/17/17/18 | ~9 min | ~1,8 h |
| 2⁻²⁸ | 6/5/5/5 | 21/19/19/20 | ~18 min | ~2,3 h |
| 2⁻³⁰ | 6 | 22/20/20/21 | ~21,5 h | ~18,7 dias |
| 2⁻³⁴ | 6 | 23/21/21/22 | ~24,2 h | ~18,7 dias |
| 2⁻³⁸ | 7 | 25/23/22/24 | ~0,34 ano | ~13 anos |
| 2⁻⁴⁰ | 7 | 26/23/23/24 | ~0,37 ano | ~13 anos |

O RCT domina em (A): cutoff 4 a 170 mil posições/s/lane × 4 lanes ≈ 1,4 M
oportunidades/s — α = 2⁻²⁰ (≈ 1 em 1 M) esgota-se em segundos.

### 12.3 α e cutoffs para objetivos operacionais (modelo (A), o conservador)

Para os alvos abaixo — **eventos raros, não simulados**: valores por cálculo analítico
sobre o bound (A), validado por (C) só no regime tratável.

| objetivo | α necessário | RCT/lane | APT/lane |
|---|---|---|---|
| ≤ 1 falso bloqueio por **dia** | ≤ 2⁻³²·⁶ | 6 | 23/21/21/22 |
| ≤ 1 falso bloqueio por **mês** | ≤ 2⁻³⁶·⁷ | 7 | 25/22/22/23 |
| ≤ 1 falso bloqueio por **ano** | ≤ 2⁻⁴³·¹ | 8/7/7/8 | **W=512 quebra** — cutoff → **513** (= W+1): o APT nunca falharia (§12bis) |

### 12.4 O que NÃO foi feito (por instrução)

- **Nada aplicado ao módulo** — α continua 2⁻²⁰, cutoffs 4 / 18-16-16-16.
- **Sem Bonferroni, sem k-de-n, sem regra de coincidência entre lanes.**
- **k-de-n permanece só HIPÓTESE** — não foi demonstrado que toda falha física atinge
  as 4 lanes ao mesmo tempo. Se as lanes forem 4 leituras temporais de um mesmo ADC,
  uma falha pode aparecer primeiro em 1 lane. Depende do RTL/AXI e da restart campaign.
- Pré-requisito para qualquer regra assim: expor `qrng_rct_failures_total` /
  `qrng_apt_failures_total` **por lane** (hoje agregados).

## 12bis. Não selecionar thresholds operacionais ainda (item 5)

**RCT/APT permanecem FORA do caminho live.** Nenhum α final antes de confirmar:

| pré-requisito | estado |
|---|---|
| unidade física da noise source | **pendente** (RTL/AXI/FIFO) — hoje `byte/lane` é provisório |
| taxa física de símbolos | **pendente** — hoje só a vazão de transporte é conhecida |
| nº de testes simultâneos | 8 hoje (4 lanes × {RCT, APT}); pode mudar se a unidade mudar |
| política de falha | definida no módulo (1 falha → `FAILED`, sem histerese) — **a revisar** à luz de §12 |
| duração da recuperação | procedimento explícito existe; **duração operacional não definida** |
| efeito operacional de um falso positivo | **não quantificado** (quanto custa um `FAILED` falso na entrega?) |
| comportamento entre lanes | union bound = teto conservador (superestima); a dependência real entre lanes físicas é **inconclusiva** — pendente das capturas da fonte. k-de-n continua hipótese. |
| janela e semântica do APT | W=512, janela **não sobreposta**, `B` conta a referência (§2, §5) — a manter ou revisar junto com a decisão de α |

**Registrado explicitamente:**

1. **α = 2⁻²⁰ NÃO é operacionalmente aceitável** na taxa atualmente assumida
   (~170 mil símbolos/s/lane): agregado ~1 falso bloqueio a cada poucos segundos (§12.2).
2. **Aumentar só a severidade de α tem um teto**: para W = 512, α ≲ 2⁻⁴³ leva o cutoff
   do APT a **513 (= W+1)** — matematicamente "nunca falha", ou seja o APT deixa de
   detectar qualquer evento relevante. Já em α ~ 2⁻⁴⁰ o APT fica quase inerte.
3. **Isso NÃO deve ser resolvido** simplesmente aumentando W nem mexendo na fórmula.
   É uma **decisão arquitetural** a documentar, envolvendo: unidade de amostra física,
   se RCT e APT devem rodar por lane ou sobre a palavra, se há condicionamento antes
   do teste, qual a taxa real, e qual o objetivo de MTBF aceito pela operação.
   Só depois disso se escolhe (W, α, cutoffs, política k-de-n).

## 13. `NOISE SOURCE SAMPLE = byte por lane` — permanece PROVISÓRIO

Reafirmado: a unidade de amostra é **explicitamente provisória** até inspeção de RTL,
registradores AXI, FIFO e da construção física da palavra de 32 bits (ver
`NOISE_SOURCE_DEFINITION.md` §"Decisão formal"). Toda a parametrização de RCT/APT
acima (unidade = byte, 4 lanes, per-lane) herda essa provisoriedade: se o RTL revelar
que o `uint32` é uma única amostra física de 32 bits, RCT/APT precisam ser
reparametrizados sobre a palavra inteira e os cutoffs recalculados a partir de uma
min-entropia de símbolo de 32 bits.

## 14. Escopo dos 23 testes unitários

Os 23 testes provam **apenas o módulo isolado**: as fórmulas de cutoff, o
comportamento de fronteira de RCT/APT, a máquina de estados
(`INITIALIZING/STARTUP_TESTING/HEALTHY/DEGRADED/FAILED/RECOVERING`), o descarte de
startup, a interrupção pós-falha e a recuperação explícita. **Não** provam integração
com dados reais da FPGA, nem timing sob carga, nem o comportamento das 8 instâncias
em paralelo sobre um stream real (§12) — isso exige o harness da camada física
(item 7) e uma janela de integração autorizada.
