# Instrumentação do pipeline físico (fase item 7)

`harness.py` + `test_harness.py` (**11/11**). **Só fixtures/replay.** Nada aqui
toca a FPGA, o FIFO, o `qrng-connector.py` ou a conexão de produção. O pipeline
tem **consumidor único** — o harness **não abre um segundo consumidor**.

## Fronteiras a comparar (o MESMO bloco em cada uma)

```
registrador/FIFO  →  fifo.c out  →  socket TCP  →  qrng-connector.py in
   →  connector out  →  server_api.py in  →  ring buffer
```

No harness: `register_fifo_out`, `fifo_c_out`, `tcp_socket`, `connector_in`,
`connector_out`, `server_api_in`, `ring_buffer`.

## O que o harness registra por fronteira (`BoundaryRecord`)

| campo | |
|---|---|
| `capture_id` | identifica a captura (o mesmo bloco em todas as fronteiras) |
| `sequence` | ordem da fronteira |
| `offset_start` / `offset_end` | posição do bloco no stream |
| `n_bytes` | tamanho |
| `sha256` | hash do bloco naquela fronteira |
| `ts_monotonic` / `ts_civil` | timestamp monotônico (relativo) e civil (UTC) |
| `hexdumps` | `head` (offset 0), `mid` (meio), `tail` (fim) — 16 bytes cada |
| `first_divergent_vs_prev` | 1º offset onde difere da fronteira anterior (`-1` = idêntico) |
| `expected_bytes_at_divergence` / `observed_bytes_at_divergence` | hexdump ±4 bytes em torno da divergência |

`hash_table()` → tabela de hashes por fronteira. `preserved()` → todas as
fronteiras têm o mesmo SHA-256. `first_boundary_with_divergence()` → a primeira
fronteira que diverge + o offset.

## Restrições (verificadas por teste)

`SingleReadTap`:
- `feed()` **2×** → `RuntimeError` — o bloco é **lido uma única vez** por fronteira;
- `forward()` devolve o bloco **inalterado** — sem reordenar, sem framing, sem
  descartar/duplicar, sem interpretar como texto;
- `evidence()` devolve **cópia byte-idêntica** ao `forward()` (bytes crus, não
  representação textual);
- `read_timeout_s` → o tap **não bloqueia o produtor indefinidamente**.

`run_replay()` alimenta **cada fronteira explicitamente** com seu próprio tap —
nenhum tap relê a fonte → **sem segundo consumidor concorrente**.

## Modelos das fronteiras (para o replay)

- `identity_boundary` — connector, FIFO e `/v1/raw` do `server_api.py`:
  passthrough verbatim (confirmado lendo o código executado 2026-08-27, ver
  `NOISE_SOURCE_UNIT.md`).
- `ring_buffer_boundary(block, drop_prefix)` — o `RingBuffer` do `server_api.py`
  copia verbatim mas, em overflow, **descarta os bytes mais antigos**. Com
  `drop_prefix>0` o replay demonstra uma **descontinuidade** localizada na
  fronteira `ring_buffer` (o consumidor recebe um bloco não contíguo em relação
  à saída do connector). O harness localiza isso como
  `first_boundary_with_divergence() → {boundary: "ring_buffer", first_divergent_vs_prev: 0, expected/observed bytes}`.

## Validação com fixtures (demo em `python harness.py`)

- **replay idêntico**: 7 fronteiras, 1 único SHA-256, `preserved: True`,
  nenhuma divergência.
- **replay com drop de 4 bytes no ring buffer**: `preserved: False`, primeira
  divergência = `ring_buffer` @ offset 0, com os bytes esperado/observado.

## PARADA — janela controlada necessária antes de instrumentação real

Antes de qualquer captura na **FPGA/FIFO** ou na **conexão produtiva**, é
preciso **autorização explícita + janela controlada**, porque:

1. O consumidor é único: instrumentar `/tmp/fifo_qrng` ou o socket `:12345` sem
   cuidado rouba bytes do `server_api.py` (o único leitor legítimo).
2. A fronteira mais próxima da FPGA hoje acessível seria a **saída do
   `server_api.py`** (`/v1/raw`) — as fronteiras `register_fifo_out`,
   `fifo_c_out` e `tcp_socket` exigem acesso à FPGA (bloqueado nesta sessão —
   ver `NOISE_SOURCE_UNIT.md` "Bloqueio de acesso").
3. Um `tee` no named pipe (`/tmp/fifo_qrng`) intercepta sem consumir uma 2ª
   sequência, mas muda o timing e precisa ser montado/desmontado numa janela.

**Plano para a janela** (a executar sob autorização):
- montar um `tee`/`splice` de leitura-única no ponto mais a montante permitido;
- capturar N blocos com `capture_id` estável, alimentar o `BoundaryCapture`
  em cada fronteira acessível;
- comparar (item 8) e devolver a tabela de hashes + 1º offset divergente;
- desmontar o tap; confirmar que `server_api.py` não perdeu bytes
  (`total_pushed`/`total_popped` contínuos).
