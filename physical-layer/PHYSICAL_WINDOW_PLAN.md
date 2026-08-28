# Plano da janela de instrumentação física (fase item 9)

Plano para uma **janela de manutenção controlada** após a inspeção read-only
da FPGA (item 8). **PARE e solicite autorização antes de executar qualquer
ação B–F que altere ou interrompa o caminho produtivo.** As ações A e a leitura
read-only do item 8 podem ocorrer com o operador presente; B–F exigem
autorização explícita por ação.

Pré-condições para abrir a janela:
- inspeção read-only do item 8 concluída e revisada;
- unidade física da amostra e evento de "restart real" (item 6) ao menos
  parcialmente determinados;
- operador da UFPE/Dobslit presente com acesso físico à Red Pitaya e ao PDU;
- `server_api.py` com `RingBuffer` saudável (`total_pushed` subindo) no início;
- cópia salva do `ExecStart` de cada unit systemd afetado (rollback).

---

## A. Instalação e remoção dos taps

| campo | valor |
|---|---|
| **Ação** | `mkfifo /tmp/fifo_qrng.tap`; substituir o `ExecStart` de `qrng-fifo.service` por um wrapper `qrng-connector.py \| tee >(coletor) > /tmp/fifo_qrng`; `systemctl daemon-reload && systemctl restart qrng-fifo.service`. Remoção: restaurar `ExecStart`, `daemon-reload`, `restart`, `rm /tmp/fifo_qrng.tap`. |
| **Impacto** | stream interrompido ~2–5 s por (re)instalação. Nenhuma escrita na FPGA. |
| **Duração** | instalação < 60 s; remoção < 60 s. |
| **Dados descartados** | os ~2–5 s de bytes durante cada restart do serviço (o `RingBuffer` cobre; nenhum cliente deve ver 503). |
| **Critério de sucesso** | após a instalação, `total_pushed` volta a subir no `/health` em < 10 s; `/tmp/fifo_qrng.tap` recebe bytes; `GET /v1/raw` continua respondendo 200. |
| **Critério de aborto** | `total_pushed` não sobe em 30 s, OU clientes recebem 503, OU o `tee` bloqueia (o coletor não drena). |
| **Recuperação** | watchdog mata o `tee`/wrapper e restaura o `ExecStart` original automaticamente no aborto. |
| **Rollback** | restaurar `ExecStart`; `rm /tmp/fifo_qrng.tap*`; `systemctl restart qrng-fifo qrng-api`; confirmar `/health`. |
| **Responsável** | operador com sudo em `dobslit` (192.168.0.42). |

## B. Captura do mesmo bloco por fronteira

| campo | valor |
|---|---|
| **Ação** | coletar N lotes (N=5–10) de M bytes (M≈1 MiB) de `/tmp/fifo_qrng.tap` com `capture_id` estável; para cada lote, buscar **imediatamente** o mesmo intervalo em `server_api.py` via `GET /v1/raw` (offset por `total_popped`); alimentar `physical-layer/instrumentation/harness.py::BoundaryCapture` nas fronteiras acessíveis (`connector_out`, `server_api_in`, `ring_buffer`). |
| **Impacto** | leitura extra no `server_api.py` (some poucos MiB à carga). Nenhuma escrita. |
| **Duração** | ~3–5 min por lote; 20–40 min no total. |
| **Dados descartados** | os primeiros 64 KiB de cada lote (estabilização do tap). |
| **Critério de sucesso** | `BoundaryCapture.hash_table()` produz um SHA-256 por fronteira; para um pipeline sem viés de transporte, todos coincidem. |
| **Critério de aborto** | divergência de tamanho entre o tap e o `/v1/raw` (o offset não está alinhado) — reabordar o alinhamento antes de continuar. |
| **Recuperação** | descartar o lote; realinhar por `total_popped`; repetir. |
| **Rollback** | nada a reverter (só leitura); ver A para remover o tap. |
| **Responsável** | operador + análise (item 8 da diretriz: hash/média/lanes/bits/qui-quadrado/runs/autocorrelação/SP 800-90B por fronteira). |

## C. Teste de reset do PROCESSO

| campo | valor |
|---|---|
| **Ação** | `systemctl restart qrng-fifo.service qrng-api.service`; medir o tempo até `source_status: online` e `total_pushed` subir; descartar os primeiros 1.024 símbolos pós-restart; coletar 1.000 e hashear (harness da restart campaign). |
| **Impacto** | ~2–5 s de indisponibilidade de entrada; o `RingBuffer` cobre. **Não** reinicia a fonte física — o connector reconecta ao `:12345` e retoma o MESMO stream. |
| **Duração** | < 30 s por ciclo; 3–5 ciclos = < 5 min. |
| **Dados descartados** | 1.024 símbolos de startup por ciclo. |
| **Critério de sucesso** | distribuição das amostras pós-restart estatisticamente indistinguível da pré-restart (esperado: é o mesmo stream físico). |
| **Critério de aborto** | `qrng-api.service` não volta a `active` em 60 s. |
| **Recuperação** | `journalctl -u qrng-api -n 100`; `systemctl start`; se persistir, rollback total. |
| **Rollback** | `systemctl start qrng-fifo qrng-api`; confirmar `/health`. |
| **Responsável** | operador `dobslit`. |

## D. Teste de reset do FIFO

| campo | valor |
|---|---|
| **Ação** | recriar o named pipe (`rm /tmp/fifo_qrng; mkfifo /tmp/fifo_qrng`) e reiniciar só `qrng-fifo.service`; medir como em C. |
| **Impacto** | igual a C. Hipótese: reinicia só o transporte (FIFO é buffer digital). |
| **Duração** | < 30 s por ciclo. |
| **Dados descartados** | 1.024 símbolos de startup. |
| **Critério de sucesso** | idem C (mesmo stream físico esperado). |
| **Critério de aborto** | `server_api.py` não reabre o pipe (fica em `source_status: offline`). |
| **Recuperação / Rollback** | `systemctl restart qrng-fifo qrng-api`. |
| **Responsável** | operador `dobslit`. |

## E. Reset da FPGA

| campo | valor |
|---|---|
| **Ação** | recarregar o bitstream / reset da PL da Red Pitaya pelo mecanismo documentado (a definir na inspeção do item 8 — `fpgautil`, `/dev/xdevcfg`, ou `overlay`). Parar `qrng-fifo`/`qrng-api` antes; religar depois. |
| **Impacto** | **interrompe o caminho produtivo** (~30–90 s). É um candidato a "restart real da noise source" (provável, não confirmado). |
| **Duração** | 1–3 min por ciclo; **apenas 1–2 ciclos** nesta janela (validação). |
| **Dados descartados** | todo o startup até `source_status: online` + 1.024 símbolos. |
| **Critério de sucesso** | após o reload, a fonte volta a produzir; a distribuição das amostras muda de forma consistente com uma re-inicialização (ou não — resultado informativo em qualquer caso). |
| **Critério de aborto** | a fonte não volta a `online` em 5 min após o reload. |
| **Recuperação** | recarregar o bitstream conhecido-bom (cópia hasheada na inspeção); `systemctl restart`. |
| **Rollback** | bitstream conhecido-bom + restart dos serviços; se falhar, F (power-cycle). |
| **Responsável** | operador com acesso físico + autorização específica para E. |

## F. Pequeno piloto de 3–5 power-cycles

| campo | valor |
|---|---|
| **Ação** | power-cycle físico da Red Pitaya (PDU comandável ou manual): desligar 10 s, religar, aguardar boot + `source_status: online`, descartar startup + 1.024 símbolos, coletar 1.000, hashear. Repetir 3–5×. Uma linha por ciclo no formato de `physical-layer/restart-campaign/harness.py` (`simulated=false`). |
| **Impacto** | **interrompe o caminho produtivo** por ~40–120 s por ciclo. É a hipótese mais forte de "restart real da noise source". |
| **Duração** | ~10–15 min no total (3–5 ciclos). |
| **Dados descartados** | todo o boot + 1.024 símbolos por ciclo. |
| **Critério de sucesso** | o harness grava 3–5 linhas válidas, cada uma de uma reinicialização física confirmada (não recorte de stream); hashes distintos; nenhuma falha. |
| **Critério de aborto** | a placa não completa o boot, OU `source_status` não volta a `online` em 5 min após religar. |
| **Recuperação** | novo power-cycle; se a placa não voltar em 2 tentativas, escalar para hardware. |
| **Rollback** | religar a placa; `systemctl restart qrng-fifo qrng-api`; confirmar `/health`; retomar produção. Nada em código/config muda. |
| **Responsável** | operador com acesso físico ao PDU + autorização específica para F. |

---

## Ordem e portões

1. **A** + roteiro read-only do item 8 — operador presente, sem autorização extra.
2. **PARE.** Revisar a saída do item 8. Solicitar autorização para B.
3. **B** — captura por fronteira (só leitura).
4. **PARE.** Revisar a tabela de hashes por fronteira (item 8 da diretriz).
5. **C**, depois **D** — resets de transporte (baixo impacto). Autorização para C/D.
6. **PARE.** Confirmar que C/D não reiniciam a fonte física.
7. **E** (1–2×) — reset da FPGA. **Autorização específica.**
8. **PARE.** Avaliar se E muda a distribuição (candidato a restart real).
9. **F** (3–5×) — piloto de power-cycle. **Autorização específica.**
10. **PARE.** Com A–F concluídos, apresentar: duração real, impacto medido,
    janela necessária para a campanha de 1.000 reinicializações, risco
    operacional, procedimento de interrupção, recuperação, rollback.
    **A campanha completa de mil reinicializações continua exigindo
    autorização à parte.**

## O que NUNCA acontece nesta janela

- escrita em registrador da FPGA (só leitura de status, uma vez);
- segundo consumidor do `:12345` ou de `/tmp/fifo_qrng`;
- RCT/APT no caminho live;
- a campanha completa de 1.000 reinicializações;
- qualquer alteração que permaneça após a janela (tudo é revertido em A).
