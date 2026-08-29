# Prontidão criptográfica — arquitetura SP 800-90 (itens 11–16)

Base normativa: **SP 800-90B (final + errata)**, **SP 800-90A Rev. 1 (final)**,
**SP 800-90C (final, set/2025)**. **NÃO** se usa 90A Rev. 2 (em revisão).

**Nada aqui é implantado. Nada ativa geração criptográfica.** Documento de
arquitetura + planos que aguardam autorização por item.

---

## 11. Restart campaign — evento correto, plano, SEM execução

### 11.1 Taxonomia dos "restarts" (o que reinicia o quê)

| evento | o que reinicia | reinicia a NOISE SOURCE FÍSICA? |
|---|---|---|
| `kill`/restart do `qrng-connector.py` | só a conexão TCP `:12345`; retoma o stream | **NÃO** |
| `kill`/restart do `server_api.py` | só o `RingBuffer` + a leitura do pipe | **NÃO** |
| `mkfifo` / recriar `/tmp/fifo_qrng` | só o pipe nomeado | **NÃO** |
| reset do AXI FIFO (`fifo.c`: `*(base+0x18)=0xA5`) | esvazia o FIFO RX de 32 bits (buffer digital) | **NÃO** (buffer digital) |
| reload do bitstream (`fpgautil -b stream_app.bit.bin`) | toda a lógica PL: contadores, PLLs, blocos DSP, packing, **e o bloco de digitização/decimação** | **PARCIAL** — reinicia a DIGITIZAÇÃO e o processamento; o **front-end analógico** (laser, fotodetector, bias) **continua ligado** |
| `systemctl restart qrng-stream` (embute `fpgautil -b …` no `ExecStartPre`) | == reload do bitstream + `fifo\|nc` | **PARCIAL** (idem) |
| restart da AQUISIÇÃO digital sem reload (se o RTL expuser um bit de `acq_reset`) | contadores/estado do bloco de aquisição | **PARCIAL** — depende do RTL (indeterminado) |
| **power-cycle da placa** | tudo, incl. front-end analógico do RP, PLLs de clock, e possivelmente o laser se alimentado pela placa | **SIM** (o mais próximo de um restart físico completo) |
| **power-cycle do laser / do módulo óptico** | a própria fonte de ruído | **SIM** (restart da noise source no sentido estrito) |

> **"Recarregar o bitstream" NÃO é, por si só, um restart físico da noise
> source.** É um restart da digitização + do transporte. Um restart físico
> exige power-cycle do front-end óptico (ou da placa, se o laser for alimentado
> por ela). **Isso não foi confirmado** — depende de como o laser é alimentado
> (evidência ausente: esquemático / documento do responsável pelo hardware).

### 11.2 Evidência necessária (ANTES de escolher o evento)

- Esquema de alimentação do laser e do fotodetector (placa? fonte externa?).
- Se o RTL tem `acq_reset` / sequência de inicialização do bloco de ruído.
- Comportamento do ADC/PLL de RF no reload do bitstream (relock? offset?).
- Tempo de estabilização do front-end óptico após energizar (warm-up do laser).
- Se `parameters.txt` (`ch1=0xBD0`, `ch4=0xC53`) são reaplicados no restart e por
  quem (bootstrap? `init_demo.sh`? nada?).

### 11.3 Recomendação de evento

| objetivo do teste | evento recomendado | por quê |
|---|---|---|
| **Restart da noise source (SP 800-90B §3.1.4)** — o que a norma pede | **power-cycle do módulo óptico** (laser+fotodetector), com o RP ligado, seguido de re-aquisição | é o único que reinicia o processo físico de ruído; o resto reinicia só digital/transporte |
| Se o óptico não puder ser ciclado isoladamente | **power-cycle da placa inteira** | reinicia front-end analógico + PLLs + PL; aceitável como aproximação, documentando que o laser pode não ter reiniciado |
| **NÃO usar** | reload de bitstream / restart de connector / server_api como "restart da fonte" | reinicia só transporte/digitização; usar SP 800-90B restart tests sobre isso seria enganoso |

### 11.4 Plano da campanha (aguarda autorização específica)

| parâmetro | valor proposto | nota |
|---|---|---|
| matriz | **1000 restarts × 1000 amostras** por restart (matriz padrão SP 800-90B §3.1.4.1) | cada linha = 1 restart; cada coluna = a n-ésima amostra pós-restart |
| unidade da amostra | **a definir no item 9** (indeterminada hoje) — provisoriamente palavra uint32 OU byte-lane | a campanha herda a indefinição |
| amostras de startup a descartar | **≥ N** onde N cobre o warm-up do laser + relock de PLL (medir na etapa 11.2; chute conservador: 10⁶ palavras ≈ 6 s) | descartar ANTES da linha da matriz |
| intervalo entre restarts | ≥ (warm-up medido) + margem; provisoriamente **60 s** | evitar contaminar linha n+1 com transiente de n |
| duração estimada | 1000 × (60 s ciclo + coleta de 1000 amostras) ≈ **~17–20 h** de janela contínua | requer supervisão / automação com watchdog |
| automação | script na dobslit que: aciona o power-cycle (relé/PDU — **hardware não confirmado**), aguarda `source_status=online` + N amostras de startup, coleta 1000 amostras via um **tap read-once** (harness item 8, sem 2º consumidor), grava linha, repete | |
| logs | por linha: `restart_index`, `restart_method`, `t_powercycle`, `t_online`, `startup_discarded`, `sha256` da linha, `stall_seconds` | JSONL |
| análise | `ea_restart` (parte do pacote SP 800-90B) sobre a matriz → sanity check de startup + `H_r` (restart-entropy) | |
| **impacto operacional** | a fonte fica **indisponível** durante toda a janela (power-cycles repetidos); o `RingBuffer` NÃO cobre isso (gaps de minutos). `/v1/random` deve responder **503 estruturado** durante a campanha, e o frontend deve exibir "fonte em manutenção" | |
| rollback operacional (NÃO executar) | restaurar `init_demo.sh` / `qrng-stream.service` originais; religar a fonte; confirmar `total_pushed` subindo; **teste real de rollback NÃO nesta rodada** | |
| janela necessária | **~24 h** com acesso físico à PDU/relé do módulo óptico + supervisão | |

**A campanha NÃO foi executada e só será executada após autorização específica.**

---

## 12. RCT e APT — projeto (staging), state machine, SEM ativar em produção

### 12.1 Sobre qual unidade

RCT/APT operam sobre a **saída bruta da noise source** definida no item 9 —
**NÃO** necessariamente sobre bytes só porque o transporte usa bytes. Como a
unidade física está indeterminada, o projeto abaixo é parametrizável e a escolha
`{byte-lane 8 bits × 4 | palavra uint32 32 bits × 1 | sub-amostra do RTL}` fica
**pendente**.

> A falha do stream **intercalado** no teste IID **NÃO** implica que ele seja
> inadequado para RCT/APT. RCT/APT não pressupõem IID; testam repetição
> (RCT) e proporção adaptativa (APT). A escolha da unidade depende da noise
> source, não do resultado IID do recorte de transporte.

### 12.2 Parâmetros a fixar (todos pendentes de itens 9/10/11)

| parâmetro | depende de |
|---|---|
| unidade física da amostra | item 9 (RTL) |
| `H` (min-entropia conservadora por amostra) | item 10 + restart campaign; **NÃO** usar 6,49 (exploratório) nem "8 bits/byte" |
| taxa de símbolos | item 9 (taxa física) — hoje só a de transporte (~174 805 uint32/s) |
| nº de testes simultâneos | 1 (palavra) ou 8 (4 lanes × {RCT,APT}) conforme a unidade |
| `α` (prob. de falso alarme) | decisão arquitetural + MTBF operacional alvo |
| `W` (janela APT) | 512 (bytes) ou 1024 (bits) — a rever com a unidade |
| cutoffs `C` (RCT) e `C` (APT) | derivados de `(H, α, W)` pelas fórmulas da SP 800-90B §4.4 |
| política de falha | 1 falha → `FAILED` (sem histerese) **a revisar** — à taxa de produção qualquer `α` utilizável dá MTBF de falso bloqueio curto |
| política de recuperação | re-rodar startup tests sobre M janelas novas; nº máx. de tentativas antes de escalar |
| custo de um falso positivo | **não quantificado** — quanto custa um `FAILED` falso na entrega? |

### 12.3 State machine (a implementar SÓ em staging)

```
INITIALIZING     -> abre a fonte; nenhuma amostra entregue
STARTUP_TESTING  -> descarta `startup_samples`; roda RCT+APT sobre M janelas;
                    NENHUMA amostra entra no serviço de entropia até passar
HEALTHY          -> RCT+APT contínuos; amostras liberadas para /v1/entropy
DEGRADED         -> sinal de alerta (ex.: APT perto do cutoff) — ainda entrega,
                    mas marca X-QRNG-Entropy-Health=degraded
FAILED           -> RCT ou APT falhou: PARA a entrada no serviço de entropia;
                    INVALIDA o buffer anterior à falha; /v1/entropy -> 503
RECOVERING       -> procedimento controlado: re-INITIALIZING + STARTUP_TESTING;
                    só volta a HEALTHY com M janelas novas passando
```

Requisitos:
- `startup_samples` descartadas **antes** de qualquer teste contar;
- **nenhuma entrega** antes do startup test passar;
- falha **interrompe** a entrada no serviço de entropia (não só marca header);
- **buffer anterior à falha invalidado** (não se serve entropia "represada");
- recuperação **controlada** (não automática silenciosa);
- métricas: `qrng_rct_failures_total{lane}`, `qrng_apt_failures_total{lane}`,
  `qrng_health_state`, `qrng_startup_discards_total`, `qrng_entropy_invalidated_bytes_total`;
- log por transição: `{state_from, state_to, reason, test, counter, ts, lane}`.

**NÃO ativar no caminho produtivo nesta rodada.** Protótipo em
`staging/` sobre o fixture, alimentado por um tap read-once.

---

## 13. Arquitetura para uso criptográfico

### 13.0 Três produtos SEPARADOS

| endpoint | conteúdo | consumidor |
|---|---|---|
| `/v1/noise/raw` | bytes brutos da noise source, **não condicionados** | ciência / assessment SP 800-90B / auditoria |
| `/v1/entropy` | saída de uma **entropy source avaliada** (SP 800-90B): condicionada, com **crédito de entropia conservador declarado**, health tests ativos | quem precisa de entropia com garantia |
| `/v1/random/cryptographic` | saída de uma **construção RBG/DRBG** (SP 800-90A/C) | material pseudoaleatório para uso geral |

**NUNCA** entregar bytes brutos diretamente como chave / seed final / nonce
operacional / token / material pronto. Os atuais `/v1/random`, `/v1/raw`,
`/qrng/api/random` permanecem como **`/v1/noise/raw`** (renomear/alias) — dados de
transporte, `actual_origin` conforme item 8, **sem** crédito criptográfico.

### 13.1 Entropy source — SP 800-90B

| campo | valor / decisão pendente |
|---|---|
| noise source | shot noise óptico (**a confirmar** — item 9); digitização no ADC RF 125 MS/s/14 bit + RTL custom (decimação/packing indeterminados) |
| unidade de amostra | **PENDENTE (item 9)** |
| min-entropia por amostra | **PENDENTE** — usar o **menor `h_min` NORMATIVO** aplicável à unidade escolhida, com margem; hoje o piso caracterizado é `6.855` bits/símbolo de 8 bits (run_new_04.L2) — **mas isso é transporte, não a noise source**, e SEM restart tests |
| health tests | RCT + APT (item 12) — **não implementados no caminho live** |
| condicionador | **decisão arquitetural pendente** (13.1.1) |
| quantidade de entrada / saída | definido pelo condicionador escolhido |
| crédito de entropia | **`min(n_out, h_in)`** onde `h_in` = (min-entropia por amostra) × (amostras de entrada) e `n_out` = bits de saída do condicionador; **nunca creditar mais que a entrada conservadora** |
| política de falha | health test `FAILED` → entropy source para; buffer pré-falha invalidado |
| startup / restart / recovery | item 12 (state machine) + item 11 (restart campaign) |

#### 13.1.1 Condicionador — vetted vs non-vetted (SP 800-90B §3.1.5.1)

**Não adicionar condicionamento só para melhorar testes estatísticos.** É decisão
de arquitetura.

| opção | tipo | prós | contras | recomendação |
|---|---|---|---|---|
| **Nenhum** (usar a noise source direto como entropy source) | — | mais simples; assessment direto | exige que a saída bruta já passe non-IID com folga e health tests; hoje `h_min` ~6,85/8 → ~85,7% → precisaria de muita expansão de entrada | só se a min-entropia por amostra final for alta e estável pós-restart |
| **SHA-256** (vetted, §3.1.5.1.1) | vetted | crédito de entropia = `min(output_len, 0.999·h_in, output_entropy)` sem penalidade extra da tabela de non-vetted; amplamente revisado; já disponível (Node `crypto`) | reduz throughput (hash por bloco); precisa de `n_in` bem dimensionado | **RECOMENDADO** — vetted, revisável, sem dependência nova |
| **HMAC-SHA-256** (vetted) | vetted | idem SHA-256; chave fixa pública aceitável para condicionamento | overhead ligeiramente maior | alternativa a SHA-256 |
| **AES-CBC-MAC / CMAC** (vetted) | vetted | rápido em HW com AES-NI (irrelevante no ARM da FPGA; relevante no x86 do broker) | mais peças | se throughput no x86 for gargalo |
| **XOR / von Neumann / LFSR caseiro** | non-vetted | — | penalidade da SP 800-90B (§3.1.5.2): crédito reduzido por fator `0.85`/`0.5`; exige justificativa e re-assessment da SAÍDA condicionada | **NÃO** — sem ganho e com penalidade |

**Recomendação: condicionador vetted = SHA-256**, aplicado no **broker** (x86,
`server_api.py`/um serviço dedicado), **NÃO** na FPGA. `n_in` dimensionado para
`h_in ≥ output_len / 0.999` com margem (ex.: para 256 bits de saída com
`h_min = 6.0` bits/símbolo de 8 bits conservador → `⌈256 / 6.0⌉ = 43` símbolos =
344 bits de entrada; usar ≥ 64 símbolos = 512 bits para folga).

Para cada saída condicionada, expor:

```
input_samples   input_bytes   credited_entropy_bits   conditioner
output_bits     security_strength
```

### 13.2 DRBG — SP 800-90A Rev. 1 (final)

| mecanismo | dependências | segurança | revisão | veredito |
|---|---|---|---|---|
| **Hash_DRBG** (SHA-256) | só uma hash aprovada | até 256 bits | simples; `df` só no instantiate | **candidato** |
| **HMAC_DRBG** (SHA-256) | HMAC | até 256 bits | o mais analisado formalmente; resistente a mau uso | **RECOMENDADO** |
| **CTR_DRBG** (AES-256, `df`) | AES + block-cipher `df` | até 256 bits | rápido; mais estado; `df` adiciona superfície | candidato se throughput crítico |

**Recomendação: HMAC_DRBG-SHA-256** — melhor relação segurança/simplicidade de
revisão, sem dependência de AES, comportamento bem estudado sob entrada
imperfeita.

Comparação operacional (a preencher na implementação em staging):

| aspecto | HMAC_DRBG |
|---|---|
| instantiate | `entropy_input` (≥ security_strength bits, da entropy source) + `nonce` + `personalization_string` |
| reseed | por contador de requisições (`reseed_interval ≤ 2^48`, mas usar **muito** menor — ex. 2^20 gerações OU a cada janela) e por `prediction_resistance` quando pedido |
| generate | `additional_input` opcional; `max_bytes_per_request` (2^19 bits = 64 KiB) |
| prediction resistance | reseed forçado antes do generate |
| personalization / additional input | usar `source_session_id` + `sequence` como personalization; timestamp como additional_input |
| limite de requisições | `reseed_interval` conservador + bloqueio em `FAILED` da entropy source |
| fork/persistência | **estado NUNCA persistido em disco**; fork ⇒ novo instantiate (nunca herdar estado); um processo, um DRBG, `zeroization` no shutdown |
| zeroization | `V`, `Key`, `entropy_input` zerados no `uninstantiate` e no exit (best-effort em Node: `buf.fill(0)`) |
| concorrência | um `generate` por vez sob lock; ou um DRBG por worker, cada um com seu instantiate |

**Vetores oficiais:** implementar os *CAVP DRBG test vectors* (NIST) para
HMAC_DRBG-SHA-256 (instantiate/generate/reseed, com e sem `prediction_resistance`,
com e sem `additional_input`) como testes **bloqueantes** no CI.

### 13.3 Construção — SP 800-90C (final, set/2025)

| classe | descrição (90C) | usa live entropy source? | aplicável ao Kapuã? |
|---|---|---|---|
| **RBG1** | DRBG semeado UMA vez de uma fonte externa aprovada (RBG2/RBG3), sem acesso próprio a entropy source; sem reseed com entropia fresca | não (semente única externa) | possível como *fallback degradado* de curta duração; **não** é o produto principal |
| **RBG2** | DRBG com acesso a uma entropy source **non-live** (ou live) via um sub-DRBG; reseed sob demanda a partir dessa fonte | opcional | possível se a entropy source não for classificável como "live" |
| **RBG3** | DRBG continuamente alimentado por uma **live entropy source** validada; a saída tem *full entropy* ou security strength do DRBG, com reseed frequente | **SIM, obrigatório** | **alvo** SE e SÓ SE a live entropy source for comprovada (itens 8/9/12) |
| **RBGC** | construção componível (90C §): permite combinar RBGs e definir pontos de reseed numa cadeia | — | relevante para descrever `noise/raw → entropy source → DRBG` como cadeia auditável |

**Não selecionar a classe antes de saber:**

- existe **live entropy source** comprovada? (hoje **não** — itens 8/9/12 pendentes)
- disponibilidade / latência / taxa da fonte (transporte ~175k uint32/s; física ?)
- política de reseed (por tempo? por contagem? por evento de health?)
- necessidade de recuperação (o que fazer quando a fonte cai por minutos/horas)
- dependência de fonte externa (há? não deveria haver para RBG3)
- nível de segurança pretendido (128 / 192 / 256 bits)

**Recomendação preliminar (condicional):**

- **Se** a live entropy source for comprovada (RTL + unidade + restart + health):
  **RBG3** com HMAC_DRBG-SHA-256, reseed a cada janela de health test que passa,
  `prediction_resistance` disponível sob demanda.
- **Enquanto não for comprovada:** **NÃO** oferecer `/v1/random/cryptographic`.
  No máximo, `/v1/entropy` marcado `assessment=incomplete` para uso científico —
  **não** para chaves.

**Não chamar o sistema de "conforme SP 800-90C" só por combinar QRNG + DRBG.**

---

## 14. Falha da fonte — comportamento seguro (fail-safe)

`/v1/entropy` e `/v1/random/cryptographic` devem **falhar fechado**:

| condição | `/v1/entropy` | `/v1/random/cryptographic` |
|---|---|---|
| FPGA offline / `source_status=offline` | 503 `SOURCE_OFFLINE` | 503 (se sem estado DRBG válido) / ver 14.1 |
| connector desconectado (gap) | 503 `TRANSPORT_GAP` | idem |
| sequência quebrada / `unknown_gap` no bloco | 503 `SEQUENCE_BROKEN` | idem |
| replay detectado | 503 `REPLAY_DETECTED` | idem |
| hash do bloco divergente (origin≠consumer) | 503 `INTEGRITY_FAIL` | idem |
| `received_at` fora da janela de frescor | 503 `STALE` | idem |
| RCT fail | 503 `RCT_FAIL` — entropy source para | idem |
| APT fail | 503 `APT_FAIL` — entropy source para | idem |
| startup test fail | 503 `STARTUP_FAIL` — nunca entregou | idem |
| buffer de entropia esgotado | 503 `INSUFFICIENT_ENTROPY` | ver 14.1 |
| DRBG sem reseed possível (fonte caída) além do `reseed_interval` | n/a | 503 `DRBG_RESEED_REQUIRED` |
| condicionador indisponível | 503 `CONDITIONER_DOWN` | idem |

**PROIBIDO** em `/v1/entropy` e `/v1/random/cryptographic`: fallback histórico,
arquivo, `Math.random`, fixture, PRNG demonstrativo, buffer pré-coletado. Esses
caminhos **não existem** nesses endpoints (não é "desabilitado por env" — é
ausência de código).

### 14.1 Continuidade temporária via estado interno do DRBG (90C)

Se a construção 90C escolhida permitir servir a partir do estado interno do DRBG
por um intervalo limitado enquanto a fonte está caída, documentar **exatamente**:

```
classe 90C                 = ...
DRBG mechanism             = HMAC_DRBG-SHA-256
security_strength          = 256 bits
max_requests_sem_reseed    = ... (MUITO menor que 2^48; ex. 4096)
max_wall_time_sem_reseed   = ... (ex. 60 s)
condição de bloqueio       = atingir qualquer limite acima OU health FAILED
momento obrigatório de reseed = na volta da fonte, ANTES do próximo generate;
                             com prediction_resistance se solicitado
```

Sem essa documentação, a resposta correta a "fonte caída" é **503**, não
continuar gerando.

---

## 16. Gates para `CRYPTOGRAPHIC_SOURCE_READY=true`

Só quando **TODOS** forem verdadeiros:

| # | gate | estado 2026-08-29 |
|---|---|---|
| 1 | RTL e cadeia física documentados | ❌ (RTL custom não disponível — item 9) |
| 2 | unidade da noise source definida | ❌ (herda #1) |
| 3 | taxa física definida | ❌ (só a de transporte) |
| 4 | ausência/presença de condicionamento em HW conhecida | ❌ (herda #1) |
| 5 | alinhamento de palavra comprovado | ⚠️ **implementado + testado** (`word_ring_buffer.py`, 32 testes) — **não implantado** |
| 6 | sequência e gaps rastreáveis (offset absoluto + sessão + `unknown_gap`) | ⚠️ **implementado + testado** — não implantado |
| 7 | origem live comprovada (8.1) | ❌ (falta session_id no upstream, verificação de hash no consumidor, anti-replay) |
| 8 | campanha IID/não-IID concluída | ✅ **transporte** (`NIST_CHARACTERIZATION_20260829.md`); ❌ da noise source (unidade indefinida) |
| 9 | restart campaign concluída | ❌ (não executada — item 11) |
| 10 | min-entropia conservadora definida | ❌ (só caracterização de transporte; sem restart) |
| 11 | RCT/APT implementados no ponto correto | ❌ (só design — item 12) |
| 12 | startup tests operacionais | ❌ |
| 13 | continuous tests operacionais | ❌ |
| 14 | falha bloqueia a entropy source | ❌ (design — item 14) |
| 15 | condicionador selecionado e testado | ❌ (recomendação: SHA-256 vetted — não implementado) |
| 16 | crédito de entropia calculado | ❌ |
| 17 | construção 90C escolhida | ❌ (recomendação condicional: RBG3/HMAC_DRBG) |
| 18 | DRBG aprovado implementado | ❌ |
| 19 | vetores oficiais (CAVP) aprovados | ❌ |
| 20 | reseed e failure policy testados | ❌ |
| 21 | fallback proibido no caminho criptográfico | ⚠️ (design; endpoints não existem ainda) |
| 22 | CI e E2E bloqueantes para o caminho cripto | ❌ |
| 23 | revisão independente concluída | ❌ |

**`CRYPTOGRAPHIC_SOURCE_READY = false`** — 21 dos 23 gates pendentes; os 2
parcialmente atendidos (#5, #6) estão testados mas não implantados.
