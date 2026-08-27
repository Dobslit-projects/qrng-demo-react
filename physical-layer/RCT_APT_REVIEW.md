# Revisão RCT/APT contra NIST SP 800-90B §4.4 (item 3)

Módulo revisado: `physical-layer/qrng-api/qrng_health_tests.py` (recuperado no commit
`07fb2af`, ajustado neste). Testes: `test_qrng_health_tests.py` — **23/23**.
**Não conectado a `server_api.py` nem a nenhum caminho live.**

## 1. Fórmula do RCT — CONFIRMADA

SP 800-90B §4.4.1: `C = 1 + ⌈ −log₂(α) / H ⌉`.
Código (`rct_cutoff`): `1 + math.ceil(-math.log2(alpha) / H)`. Idêntico.
Com α = 2⁻²⁰, H_lane0 = 6.978486 → `1 + ceil(20/6.978486)` = `1 + ceil(2.866)` = **4**. Confere
com o valor preliminar do pedido.

## 2. Fórmula do APT — CONFIRMADA (cutoff), 1 correção no contador

SP 800-90B §4.4.2: janela `W`; `C` = menor valor tal que
`P(X ≥ C) ≤ α`, com `X ~ Binomial(W−1, p)`, `p = 2^(−H)`.
Código (`apt_cutoff`): calcula exatamente `P(X ≥ c)` por soma da PMF binomial em
`n = W−1` tentativas e devolve o menor `c` com cauda ≤ α. Idêntico à definição
(equivale a `1 + CRITBINOM(W−1, p, 1−α)`).
lane0: H = 6.978486, p ≈ 0.007930, W = 512 → cutoff = **18**. Confere.

**Discrepância encontrada e corrigida neste commit:** o `APTState.push()` inicializava
o contador em **0** ao fixar a amostra de referência. SP 800-90B §4.4.2 inicializa
`B = 1` — a própria amostra de referência conta como uma ocorrência. Efeito do bug:
o APT disparava com `cutoff` matches *após* a referência, quando a spec dispara com
`cutoff − 1` — ou seja, **~1 ocorrência menos sensível que a norma**, na direção
não-conservadora. Corrigido para `self.count = 1` na referência; 2 testes de
fronteira ajustados (`test_apt_abaixo_do_limite_nao_falha`,
`test_apt_acima_do_limite_falha_no_primeiro_ponto_de_corte`). RCT não foi afetado.

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
- **APT** (pós-correção): `B = 1` na referência; após `k` matches `B = 1+k`; dispara no
  primeiro `k` com `B ≥ C`, i.e. `k = C−1`. Idêntico à spec.

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
RCT/APT (são testes cujo α já embute a raridade), mas ver §11 sobre o efeito de rodar
8 testes em paralelo.

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

## 12. Falso positivo com 4 lanes × {RCT, APT} simultâneos

Cada lane roda RCT + APT independentes, **cada teste com α = 2⁻²⁰ como alvo de projeto
individual**. Rodando **8 testes** em paralelo:

- As lanes são estatisticamente quase-independentes (correlação cruzada ≈ 0,001, ver
  `NOISE_SOURCE_DEFINITION.md`), então as 4 lanes contribuem de forma aproximadamente
  aditiva. RCT e APT na *mesma* lane são positivamente correlacionados (ambos olham
  repetição do mesmo valor), então a união é um limite superior conservador.
- Limite de união: `P(algum dos 8 disparar | fonte saudável) ≤ 8 · 2⁻²⁰ ≈ 2⁻¹⁷ ≈ 7,6·10⁻⁶`
  por "oportunidade" (por janela para APT; por posição de C símbolos para RCT).
- Consequência prática: a taxa agregada de falso `FAILED` é ~8× a de um único teste.
  Se a fonte produz, digamos, 10⁵ símbolos/s por lane, o APT avalia ~4·(10⁵/512) ≈ 780
  janelas/s no total; a 2⁻¹⁷ por janela isso é ~1 falso alarme a cada ~22 min de
  operação contínua **só por acaso** — inaceitável para um estado que interrompe a
  entrega live.

**Recomendações antes da integração live (nenhuma aplicada agora — item fora do escopo
desta etapa):**
1. **Orçar α por família de testes**: usar α_por_teste = 2⁻²⁰ / 8 = 2⁻²³ para que a
   taxa agregada volte a ~2⁻²⁰. Recalcular os cutoffs (RCT sobe para ~5; APT sobe
   ~1–2). Simples, conservador, alinhado à prática de Bonferroni.
2. **Exigir k-de-n lanes**: só transicionar para `FAILED` se **≥ 2 lanes** falharem
   dentro de uma janela curta. Uma falha real da noise source degrada TODAS as lanes
   ao mesmo tempo; um falso alarme atinge 1 lane isolada. Transforma a taxa de
   `8α` (união) em `~C(4,2)·(2α)² ≈ 2,3·10⁻¹¹` (conjunta), preservando a detecção de
   falha física real. Requer definir a janela de coincidência.
3. Manter `qrng_rct_failures_total` / `qrng_apt_failures_total` **por lane** (hoje são
   agregados) para permitir a regra k-de-n e diagnóstico.

A escolha entre (1) e (2) — ou ambas — é uma decisão de projeto a tomar junto com a
revalidação dos cutoffs pós-restart-campaign.

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
