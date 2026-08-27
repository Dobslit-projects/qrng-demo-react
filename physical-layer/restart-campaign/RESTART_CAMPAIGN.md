# Restart campaign (fase item 9)

## Veredito

```text
RESTART CAMPAIGN: BLOQUEADA
MOTIVO: o evento que constitui "restart real da noise source" ainda é
        INCONCLUSIVO. O lado FPGA (fifo.c, RTL/bitstream, servidor TCP :12345,
        registradores AXI) não pôde ser inspecionado nesta sessão (acesso
        automatizado à FPGA bloqueado pelo classificador de segurança -- ver
        NOISE_SOURCE_UNIT.md "Bloqueio de acesso"). Sem saber se um dado
        comando reinicia a fonte física ou apenas o transporte, cada "linha"
        da campanha não pode ser garantida como uma reinicialização física
        válida -- e a instrução é explícita: "Cada linha deve vir de uma
        reinicialização física válida, nunca de recortes de stream contínuo".
EVIDÊNCIA / JANELA NECESSÁRIA:
  (a) inspeção da FPGA (RTL / bitstream / servidor :12345) para identificar o
      mecanismo de init do bloco de ruído; OU
  (b) uma janela de manutenção controlada para testar um power-cycle da placa
      e medir se a distribuição das amostras muda de forma consistente com uma
      re-seed da fonte; E
  (c) autorização para executar a campanha (mil reinicializações físicas =
      infraestrutura + tempo, ver "Estimativa").
```

**A campanha NÃO foi simulada.** O que existe: o **harness pronto** e um
**piloto pequeno com fixture** (3 linhas, claramente marcadas `simulated: true`).

## Alternativas de restart e o que cada uma reinicia

(`RESTART_KINDS` em `harness.py`; testado)

| tipo | ação | reinicia a **fonte física**? | reinicia o **transporte**? |
|---|---|---|---|
| `process_restart` | `systemctl restart qrng-fifo qrng-api` | **Não** — processos Linux; o connector reconecta ao `:12345` e retoma o mesmo stream | Sim |
| `fifo_reset` | recriar `/tmp/fifo_qrng` | **Não** (hipótese: FIFO é buffer digital) | Sim |
| `qrng_core_reset` | reset do bloco QRNG via registrador AXI | **INCONCLUSIVO** — depende do RTL (pode reiniciar a digitização sem re-seedar a fonte analógica) | Sim |
| `fpga_reset` | recarregar bitstream / reset da PL | **Provável, não confirmado** | Sim |
| `power_cycle` | power-cycle físico da placa | **Sim** (hipótese mais forte) — não verificado empiricamente | Sim |

Apenas `power_cycle` (e talvez `fpga_reset`) é candidato a "restart real da
noise source". `process_restart`/`fifo_reset` reiniciam só o transporte —
usá-los como linha da campanha produziria 1.000 recortes do **mesmo** estado
físico, exatamente o que a instrução proíbe.

## Harness (`harness.py`, `test_harness.py` — 8/8)

`RestartCampaignHarness.run_restart(...)` grava, por reinicialização, uma
`RestartRow` com:
- `restart_index`, `restart_kind`, `command`
- `started_at` (UTC), `stabilization_seconds`
- `source_state_confirmed` (do `confirm_source_state()` passado pelo chamador)
- `startup_discarded_samples` (**as amostras de startup NÃO entram na linha** —
  testado: `line_sha256` cobre só as 1.000 coletadas)
- `collected_samples`, `line_sha256` (hash das 1.000 amostras)
- `failures` (exceções viram entradas, não crash — testado)
- `operational_conditions`, `hw_version`, `sw_version`
- `simulated` (**`true`** até um restart físico real ser executado)

`to_jsonl()` → uma linha JSON por reinicialização (formato da campanha).
`summary()` → nº de restarts, `all_simulated`, `any_failures`,
`distinct_line_hashes`, `kinds`.

## Piloto seguro (fixture)

`python harness.py` → `fixture_pilot(3)`: 3 "reinicializações" (re-seed de uma
PRNG determinística = proxy de restart), 1.024 amostras descartadas + 1.000
coletadas por linha, 3 hashes distintos. **`all_simulated: true`.** O piloto é
limitado a ≤ 10 linhas (testado — `test_piloto_pequeno_nunca_executa_mil`);
**não** roda mil reinicializações e **não** toca equipamento.

## Estimativa (para a janela, sob autorização)

- 1.000 reinicializações × (power-cycle ~15–40 s + estabilização + descarte de
  1.024 amostras + coleta de 1.000) ≈ **1.000 × ~60–120 s** ≈ **17–33 h** de
  operação contínua com automação de power-cycle (PDU comandável ou relé), mais
  a validação row-wise/column-wise da suíte SP 800-90B oficial (`restart_main`
  em `SP800-90B_EntropyAssessment/cpp`).
- **Impacto**: a fonte fica indisponível para produção durante a janela.
- **Procedimento de interrupção**: parar o laço do harness; a última linha
  parcial é descartada; `systemctl start` dos serviços.
- **Recuperação**: religar a placa, aguardar `source_status: online` no
  `/health` do `server_api.py`, retomar produção.
- **Rollback**: nada em produção muda (a campanha não altera código nem
  config); apenas restaurar a alimentação e os serviços.

## Próximo ponto de autorização

Desbloquear item 6 (unidade física + evento de restart real) → então executar
um **piloto físico de 3–5 power-cycles reais** numa janela curta para validar o
harness contra hardware → então apresentar janela + risco para a campanha
completa. **Nada disso sem autorização explícita.**
